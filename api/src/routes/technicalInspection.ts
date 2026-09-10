import { and, asc, desc, eq, gte, ilike, inArray, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { writeAuditLog } from '../audit/log';
import { buildGiroCodeMatrix, buildQrCodeMatrix, renderGiroCodePng } from '../docs/girocode';
import { getDb } from '../db/client';
import {
  entry,
  entryCharityCodriver,
  event,
  eventClass,
  person,
  technicalInspectionDecision,
  technicalInspectorAssignment,
  vehicle
} from '../db/schema';
import { doesAssetObjectExist, getPresignedAssetsDownloadUrl } from '../docs/storage';
import type { AuthContext } from '../http/auth';
import { queueOperationalMails } from '../mail/operationalOutbox';
import { getOrgaNotificationRecipients } from '../observability/recipients';
import { logOperationalEvent } from '../observability/logger';
import { resolveIamUserDisplayNames } from './adminIam';
import { replaceProtectedLegalNamesInValue, standardPersonIdentity, type PersonIdentitySource } from '../domain/personIdentity';

// Standalone build keeps Lambda PDF rendering independent from host font files.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const PDFDocument = require('pdfkit/js/pdfkit.standalone');

const inspectionSearchSchema = z.object({
  eventId: z.string().uuid().optional(),
  q: z.string().trim().min(1).max(120),
  limit: z.number().int().min(1).max(50).default(25)
});

const inspectionDecisionSchema = z
  .object({
    techStatus: z.enum(['pending', 'passed', 'failed']),
    target: z.enum(['primary', 'backup']).default('primary'),
    note: z.string().trim().max(2000).nullable().optional()
  })
  .superRefine((value, ctx) => {
    if (value.techStatus === 'failed' && !value.note?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['note'],
        message: 'A note is required when the inspection is rejected'
      });
    }
  });

const inspectionNoteSchema = z.object({
  target: z.enum(['primary', 'backup']).default('primary'),
  note: z.string().trim().max(2000).nullable()
});

const inspectorAssignmentSchema = z
  .object({
    eventId: z.string().uuid(),
    validFrom: z.string().datetime(),
    validUntil: z.string().datetime()
  })
  .refine((value) => new Date(value.validUntil).getTime() > new Date(value.validFrom).getTime(), {
    path: ['validUntil'],
    message: 'validUntil must be after validFrom'
  });

const qrExportSchema = z.object({
  entryIds: z.array(z.string().uuid()).min(1).max(250)
});

type InspectionSearchInput = z.infer<typeof inspectionSearchSchema>;
type InspectionDecisionInput = z.infer<typeof inspectionDecisionSchema>;
type InspectionNoteInput = z.infer<typeof inspectionNoteSchema>;
type InspectorAssignmentInput = z.infer<typeof inspectorAssignmentSchema>;

const loadProtectedInspectionPeople = async (db: any, entryId: string): Promise<PersonIdentitySource[]> => db
  .select({ firstName: person.firstName, lastName: person.lastName, publicationName: person.publicationName })
  .from(person)
  .where(and(
    sql`${person.publicationName} is not null`,
    sql`${person.id} in (
      select e."driver_person_id" from "entry" e where e."id" = ${entryId}::uuid
      union
      select e."codriver_person_id" from "entry" e where e."id" = ${entryId}::uuid and e."codriver_person_id" is not null
      union
      select ecc."person_id" from ${entryCharityCodriver} ecc where ecc."entry_id" = ${entryId}::uuid
    )`
  ));

type InspectionDecisionEmailInput = {
  techStatus: 'pending' | 'passed' | 'failed';
  target: 'primary' | 'backup';
  note: string | null;
  driverEmail: string | null;
  driverDisplayName: string;
  vehicleMake: string | null;
  vehicleModel: string | null;
  startNumber: string | null;
  eventName: string | null;
};

function buildInspectionDecisionMail(input: InspectionDecisionEmailInput) {
  if (input.techStatus === 'pending') return null;
  const vehicleName =
    [input.vehicleMake, input.vehicleModel].filter(Boolean).join(' ') || 'Ihr Fahrzeug';
  const vehicleLabel =
    input.target === 'backup' ? `${vehicleName} (Ersatzfahrzeug)` : vehicleName;
  const driverName = input.driverDisplayName;
  const startInfo = input.startNumber ? ` · Startnummer #${input.startNumber}` : '';
  const eventInfo = input.eventName ?? 'MSC Oberlausitzer Dreiländereck';

  if (input.techStatus === 'passed') {
    const subject = `Technische Abnahme bestätigt – ${eventInfo}`;
    const bodyText = [
      `Hallo ${driverName},`,
      '',
      `Ihr Fahrzeug ${vehicleLabel} wurde bei der technischen Abnahme zugelassen.${startInfo}`,
      '',
      ...(input.note ? [`Hinweis des Prüfers: ${input.note}`, ''] : []),
      'Wir freuen uns auf Sie bei der Veranstaltung.',
      '',
      'Mit freundlichen Grüßen',
      'Ihr Organisationsteam',
      'MSC Oberlausitzer Dreiländereck e.V.'
    ].join('\n');
    return { subject, bodyText };
  } else {
    const subject = `Technische Abnahme: Fahrzeug nicht zugelassen – ${eventInfo}`;
    const bodyText = [
      `Hallo ${driverName},`,
      '',
      `Ihr Fahrzeug ${vehicleLabel} wurde bei der technischen Abnahme leider nicht zugelassen.${startInfo}`,
      '',
      ...(input.note ? [`Ablehnungsgrund: ${input.note}`, ''] : []),
      'Bitte wenden Sie sich bei Fragen an das Organisationsteam.',
      '',
      'Mit freundlichen Grüßen',
      'Ihr Organisationsteam',
      'MSC Oberlausitzer Dreiländereck e.V.'
    ].join('\n');
    return { subject, bodyText };
  }
}

const buildInspectionOrgaMail = (input: InspectionDecisionEmailInput & { inspector: string | null }) => {
  const statusLabel = input.techStatus === 'passed' ? 'BESTANDEN' : 'ABGELEHNT';
  const vehicleName = [input.vehicleMake, input.vehicleModel].filter(Boolean).join(' ') || 'Unbekanntes Fahrzeug';
  const bodyText = [
    'Eine technische Abnahme wurde abgeschlossen.',
    '',
    `Veranstaltung: ${input.eventName ?? 'Unbekannte Veranstaltung'}`,
    `Status: ${statusLabel}`,
    `Fahrer: ${input.driverDisplayName}`,
    `Startnummer: ${input.startNumber ?? '-'}`,
    `Fahrzeug: ${vehicleName}`,
    `Ziel: ${input.target === 'backup' ? 'Ersatzfahrzeug' : 'Hauptfahrzeug'}`,
    `Prüfer: ${input.inspector ?? '-'}`,
    ...(input.note ? ['', input.techStatus === 'failed' ? `Ablehnungsgrund: ${input.note}` : `Hinweis: ${input.note}`] : [])
  ].join('\n');
  return {
    subject: `[Technische Abnahme][${statusLabel}] #${input.startNumber ?? '-'} – ${input.driverDisplayName}`,
    bodyText
  };
};

const normalizeEmail = (value: string): string => value.trim().toLowerCase();

const getVehicleImageUrl = async (s3Key: string | null): Promise<string | null> => {
  if (!s3Key) {
    return null;
  }
  const candidates = [s3Key, `${s3Key}.jpg`, `${s3Key}.jpeg`, `${s3Key}.png`, `${s3Key}.webp`];
  for (const candidate of candidates) {
    if (await doesAssetObjectExist(candidate)) {
      return getPresignedAssetsDownloadUrl(candidate, 900);
    }
  }
  return null;
};

const resolveAssignedEvent = async (auth: AuthContext, requestedEventId?: string) => {
  const db = await getDb();
  if (auth.groups.includes('admin')) {
    const conditions = requestedEventId
      ? and(eq(event.id, requestedEventId), inArray(event.status, ['open', 'closed']))
      : and(eq(event.isCurrent, true), inArray(event.status, ['open', 'closed']));
    const rows = await db
      .select({ id: event.id, name: event.name, startsAt: event.startsAt, endsAt: event.endsAt })
      .from(event)
      .where(conditions)
      .limit(1);
    return rows[0] ?? null;
  }

  if (!auth.email || !auth.groups.includes('technical_inspector')) {
    return null;
  }

  const now = new Date();
  const conditions = [
    eq(technicalInspectorAssignment.userEmailNorm, normalizeEmail(auth.email)),
    lte(technicalInspectorAssignment.validFrom, now),
    gte(technicalInspectorAssignment.validUntil, now)
  ];
  if (requestedEventId) {
    conditions.push(eq(technicalInspectorAssignment.eventId, requestedEventId));
  }

  const rows = await db
    .select({ id: event.id, name: event.name, startsAt: event.startsAt, endsAt: event.endsAt })
    .from(technicalInspectorAssignment)
    .innerJoin(event, eq(technicalInspectorAssignment.eventId, event.id))
    .where(and(...conditions, inArray(event.status, ['open', 'closed'])))
    .orderBy(desc(technicalInspectorAssignment.validUntil))
    .limit(1);
  return rows[0] ?? null;
};

export const getInspectionContext = async (auth: AuthContext, requestedEventId?: string) => {
  const assignedEvent = await resolveAssignedEvent(auth, requestedEventId);
  if (!assignedEvent) {
    throw new Error('INSPECTION_ASSIGNMENT_REQUIRED');
  }
  return { event: assignedEvent };
};

export const searchInspectionEntries = async (auth: AuthContext, input: InspectionSearchInput) => {
  const assignedEvent = await resolveAssignedEvent(auth, input.eventId);
  if (!assignedEvent) {
    throw new Error('INSPECTION_ASSIGNMENT_REQUIRED');
  }
  const db = await getDb();
  const pattern = `%${input.q}%`;
  const rows = await db
    .select({
      id: entry.id,
      startNumber: entry.startNumberNorm,
      driverFirstName: person.firstName,
      driverLastName: person.lastName,
      driverPublicationName: person.publicationName,
      className: eventClass.name,
      vehicleMake: vehicle.make,
      vehicleModel: vehicle.model,
      techStatus: entry.techStatus,
      backupVehicleId: entry.backupVehicleId,
      backupTechStatus: entry.backupTechStatus,
      techCheckedAt: entry.techCheckedAt
    })
    .from(entry)
    .innerJoin(person, eq(entry.driverPersonId, person.id))
    .innerJoin(vehicle, eq(entry.vehicleId, vehicle.id))
    .innerJoin(eventClass, eq(entry.classId, eventClass.id))
    .where(
      and(
        eq(entry.eventId, assignedEvent.id),
        eq(entry.acceptanceStatus, 'accepted'),
        sql`${entry.deletedAt} is null`,
        or(
          ilike(entry.startNumberNorm, pattern),
          ilike(entry.orgaCode, pattern),
          and(sql`${person.publicationName} is null`, ilike(person.firstName, pattern)),
          and(sql`${person.publicationName} is null`, ilike(person.lastName, pattern)),
          ilike(person.publicationName, pattern),
          sql`lower(case when ${person.publicationName} is not null then ${person.publicationName} else trim(coalesce(${person.firstName}, '') || ' ' || coalesce(${person.lastName}, '')) end) like lower(${pattern})`
        )
      )
    )
    .limit(input.limit);
  return rows.map((row) => {
    const identity = standardPersonIdentity({ firstName: row.driverFirstName, lastName: row.driverLastName, publicationName: row.driverPublicationName });
    return { ...row, driverDisplayName: identity.displayName, identityProtected: identity.identityProtected, driverFirstName: identity.firstName, driverLastName: identity.lastName, driverPublicationName: undefined };
  });
};

export const getInspectionEntry = async (auth: AuthContext, entryId: string) => {
  const db = await getDb();
  const rows = await db
    .select({
      id: entry.id,
      eventId: entry.eventId,
      startNumber: entry.startNumberNorm,
      orgaCode: entry.orgaCode,
      acceptanceStatus: entry.acceptanceStatus,
      driverFirstName: person.firstName,
      driverLastName: person.lastName,
      driverPublicationName: person.publicationName,
      driverEmail: person.email,
      driverPhone: person.phone,
      eventName: event.name,
      codriverPersonId: entry.codriverPersonId,
      backupVehicleId: entry.backupVehicleId,
      className: eventClass.name,
      vehicleType: vehicle.vehicleType,
      vehicleMake: vehicle.make,
      vehicleModel: vehicle.model,
      vehicleYear: vehicle.year,
      displacementCcm: vehicle.displacementCcm,
      engineType: vehicle.engineType,
      cylinders: vehicle.cylinders,
      brakes: vehicle.brakes,
      vehicleHistory: vehicle.vehicleHistory,
      vehicleImageS3Key: vehicle.imageS3Key,
      inspectionNote: entry.inspectionNote,
      backupInspectionNote: entry.backupInspectionNote,
      techStatus: entry.techStatus,
      techCheckedAt: entry.techCheckedAt,
      techCheckedBy: entry.techCheckedBy,
      backupTechStatus: entry.backupTechStatus,
      backupTechCheckedAt: entry.backupTechCheckedAt,
      backupTechCheckedBy: entry.backupTechCheckedBy
    })
    .from(entry)
    .innerJoin(person, eq(entry.driverPersonId, person.id))
    .innerJoin(vehicle, eq(entry.vehicleId, vehicle.id))
    .innerJoin(eventClass, eq(entry.classId, eventClass.id))
    .innerJoin(event, eq(entry.eventId, event.id))
    .where(
      and(
        eq(entry.id, entryId),
        eq(entry.acceptanceStatus, 'accepted'),
        sql`${entry.deletedAt} is null`
      )
    )
    .limit(1);
  const result = rows[0];
  if (!result) {
    return null;
  }
  const assignedEvent = await resolveAssignedEvent(auth, result.eventId);
  if (!assignedEvent) {
    throw new Error('INSPECTION_ASSIGNMENT_REQUIRED');
  }
  const [codriverRows, backupVehicleRows] = await Promise.all([
    result.codriverPersonId
      ? db
          .select({
            firstName: person.firstName,
            lastName: person.lastName,
            publicationName: person.publicationName,
            birthdate: person.birthdate,
            country: person.country
          })
          .from(person)
          .where(eq(person.id, result.codriverPersonId))
          .limit(1)
      : Promise.resolve([]),
    result.backupVehicleId
      ? db
          .select({
            vehicleType: vehicle.vehicleType,
            make: vehicle.make,
            model: vehicle.model,
            year: vehicle.year,
            displacementCcm: vehicle.displacementCcm,
            engineType: vehicle.engineType,
            cylinders: vehicle.cylinders,
            vehicleHistory: vehicle.vehicleHistory,
            imageS3Key: vehicle.imageS3Key
          })
          .from(vehicle)
          .where(eq(vehicle.id, result.backupVehicleId))
          .limit(1)
      : Promise.resolve([])
  ]);
  const backupVehicle = backupVehicleRows[0] ?? null;
  const [vehicleImageUrl, backupVehicleImageUrl] = await Promise.all([
    getVehicleImageUrl(result.vehicleImageS3Key),
    getVehicleImageUrl(backupVehicle?.imageS3Key ?? null)
  ]);
  const identity = standardPersonIdentity({ firstName: result.driverFirstName, lastName: result.driverLastName, publicationName: result.driverPublicationName });
  const { vehicleImageS3Key: _vehicleImageS3Key, driverPublicationName: _driverPublicationName, ...entryResult } = result;
  const backupVehicleResult = backupVehicle
    ? (({ imageS3Key: _imageS3Key, ...vehicleResult }) => vehicleResult)(backupVehicle)
    : null;
  const response = {
    ...entryResult,
    driverDisplayName: identity.displayName,
    identityProtected: identity.identityProtected,
    driverFirstName: identity.firstName,
    driverLastName: identity.lastName,
    driverEmail: identity.identityProtected ? null : entryResult.driverEmail,
    driverPhone: identity.identityProtected ? null : entryResult.driverPhone,
    vehicleHistory: identity.identityProtected ? null : entryResult.vehicleHistory,
    vehicleImageUrl,
    codriver: codriverRows[0]
      ? (() => {
          const codriverIdentity = standardPersonIdentity(codriverRows[0]);
          return {
            displayName: codriverIdentity.displayName,
            identityProtected: codriverIdentity.identityProtected,
            firstName: codriverIdentity.firstName,
            lastName: codriverIdentity.lastName,
            birthdate: codriverIdentity.identityProtected ? null : codriverRows[0].birthdate,
            country: codriverIdentity.identityProtected ? null : codriverRows[0].country
          };
        })()
      : null,
    backupVehicle: backupVehicleResult
      ? {
          ...backupVehicleResult,
          imageUrl: backupVehicleImageUrl
        }
      : null
  };
  const protectedPeople: PersonIdentitySource[] = [
    { firstName: result.driverFirstName, lastName: result.driverLastName, publicationName: result.driverPublicationName },
    ...codriverRows.filter((item) => item.publicationName)
  ].filter((item) => Boolean(item.publicationName));
  return replaceProtectedLegalNamesInValue(response, protectedPeople) as typeof response;
};

export const getInspectionParticipant = async (auth: AuthContext, eventId: string, personId: string) => {
  const assignedEvent = await resolveAssignedEvent(auth, eventId);
  if (!assignedEvent) throw new Error('INSPECTION_ASSIGNMENT_REQUIRED');
  const db = await getDb();
  const rows = await db
    .select({ id: entry.id })
    .from(entry)
    .where(and(
      eq(entry.eventId, eventId),
      eq(entry.driverPersonId, personId),
      eq(entry.acceptanceStatus, 'accepted'),
      sql`${entry.deletedAt} is null`
    ))
    .orderBy(asc(entry.startNumberNorm));
  const entries = (await Promise.all(rows.map((row) => getInspectionEntry(auth, row.id))))
    .filter((item): item is NonNullable<Awaited<ReturnType<typeof getInspectionEntry>>> => item !== null);
  if (entries.length === 0) return null;
  return {
    event: assignedEvent,
    driver: {
      personId,
      displayName: entries[0].driverDisplayName,
      identityProtected: entries[0].identityProtected,
      firstName: entries[0].driverFirstName,
      lastName: entries[0].driverLastName
    },
    entries
  };
};

export const updateInspectionDecision = async (
  auth: AuthContext,
  entryId: string,
  input: InspectionDecisionInput
) => {
  if (!auth.sub) {
    throw new Error('INSPECTION_IDENTITY_REQUIRED');
  }
  const actorUserId = auth.sub;
  const existing = await getInspectionEntry(auth, entryId);
  if (!existing) {
    return null;
  }
  const db = await getDb();
  const note = input.note?.trim() || null;
  if (input.target === 'backup' && !existing.backupVehicleId) {
    throw new Error('INSPECTION_BACKUP_VEHICLE_REQUIRED');
  }
  const now = new Date();
  const [delivery] = await db
    .select({ email: person.email })
    .from(entry)
    .innerJoin(person, eq(entry.driverPersonId, person.id))
    .where(eq(entry.id, entryId))
    .limit(1);
  const protectedPeople = await loadProtectedInspectionPeople(db, entryId);
  const safeNote = replaceProtectedLegalNamesInValue(note, protectedPeople) as string | null;
  const result = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(entry)
      .set(
        input.target === 'backup'
          ? {
              backupTechStatus: input.techStatus,
              backupTechCheckedAt: input.techStatus === 'pending' ? null : now,
              backupTechCheckedBy: input.techStatus === 'pending' ? null : actorUserId,
              backupInspectionNote: note,
              updatedAt: now
            }
          : {
              techStatus: input.techStatus,
              techCheckedAt: input.techStatus === 'pending' ? null : now,
              techCheckedBy: input.techStatus === 'pending' ? null : actorUserId,
              inspectionNote: note,
              updatedAt: now
            }
      )
      .where(eq(entry.id, entryId))
      .returning({
        id: entry.id,
        techStatus: entry.techStatus,
        techCheckedAt: entry.techCheckedAt,
        techCheckedBy: entry.techCheckedBy
      });

    const [decision] = await tx
      .insert(technicalInspectionDecision)
      .values({
        eventId: existing.eventId,
        entryId,
        status: input.techStatus,
        target: input.target,
        note,
        inspectorUserId: actorUserId,
        inspectorEmail: auth.email
      })
      .returning();

    await writeAuditLog(tx as never, {
      eventId: existing.eventId,
      actorUserId,
      action: 'entry_tech_status_updated',
      entityType: 'entry',
      entityId: entryId,
      payload: { techStatus: input.techStatus, target: input.target }
    });
    if (input.techStatus !== 'pending') {
      const baseMailInput: InspectionDecisionEmailInput = {
        techStatus: input.techStatus,
        target: input.target,
        note: safeNote,
        driverEmail: delivery?.email ?? null,
        driverDisplayName: existing.driverDisplayName,
        vehicleMake: input.target === 'backup' ? (existing.backupVehicle?.make ?? null) : existing.vehicleMake,
        vehicleModel: input.target === 'backup' ? (existing.backupVehicle?.model ?? null) : existing.vehicleModel,
        startNumber: existing.startNumber,
        eventName: existing.eventName ?? null
      };
      const driverMail = buildInspectionDecisionMail(baseMailInput);
      const orgaMail = buildInspectionOrgaMail({ ...baseMailInput, inspector: auth.email ?? actorUserId });
      const mails = [
        ...(delivery?.email && driverMail
          ? [{ audience: 'driver' as const, toEmail: delivery.email, ...driverMail }]
          : []),
        ...getOrgaNotificationRecipients().map((toEmail) => ({ audience: 'orga' as const, toEmail, ...orgaMail }))
      ];
      await queueOperationalMails(tx, {
        eventId: existing.eventId,
        templateId: 'technical_inspection_decision',
        idempotencyPrefix: `inspection:${decision.id}`,
        commonTemplateData: {
          decisionId: decision.id,
          entryId,
          status: input.techStatus,
          target: input.target
        },
        mails
      });
    }
    return { entry: updated, decision };
  });

  logOperationalEvent('info', 'inspection.decision_recorded', {
    eventId: existing.eventId,
    entryId,
    decisionId: result.decision.id,
    status: input.techStatus,
    target: input.target,
    recipientCount: input.techStatus === 'pending'
      ? 0
      : getOrgaNotificationRecipients().length + (delivery?.email ? 1 : 0)
  });

  return replaceProtectedLegalNamesInValue(result, protectedPeople) as typeof result;
};

export const updateInspectionNote = async (
  auth: AuthContext,
  entryId: string,
  input: InspectionNoteInput
) => {
  if (!auth.sub) {
    throw new Error('INSPECTION_IDENTITY_REQUIRED');
  }
  const existing = await getInspectionEntry(auth, entryId);
  if (!existing) {
    return null;
  }
  if (input.target === 'backup' && !existing.backupVehicleId) {
    throw new Error('INSPECTION_BACKUP_VEHICLE_REQUIRED');
  }

  const note = input.note?.trim() || null;
  const currentNote =
    input.target === 'backup' ? existing.backupInspectionNote ?? null : existing.inspectionNote ?? null;
  if (currentNote === note) {
    return { changed: false, note, target: input.target };
  }

  const db = await getDb();
  const now = new Date();
  const result = await db.transaction(async (tx) => {
    await tx
      .update(entry)
      .set(
        input.target === 'backup'
          ? { backupInspectionNote: note, updatedAt: now }
          : { inspectionNote: note, updatedAt: now }
      )
      .where(eq(entry.id, entryId));

    await writeAuditLog(tx as never, {
      eventId: existing.eventId,
      actorUserId: auth.sub,
      action: 'entry_inspection_note_updated',
      entityType: 'entry',
      entityId: entryId,
      payload: { target: input.target, noteUpdated: true }
    });

    return { changed: true, note, target: input.target };
  });
  return replaceProtectedLegalNamesInValue(result, await loadProtectedInspectionPeople(db, entryId)) as typeof result;
};

export const listInspectionHistory = async (auth: AuthContext, entryId: string) => {
  const existing = await getInspectionEntry(auth, entryId);
  if (!existing) {
    return null;
  }
  const db = await getDb();
  const rows = await db
    .select()
    .from(technicalInspectionDecision)
    .where(eq(technicalInspectionDecision.entryId, entryId))
    .orderBy(desc(technicalInspectionDecision.createdAt))
    .limit(50);
  const displayNames = await resolveIamUserDisplayNames(
    Array.from(new Set(rows.map((row) => row.inspectorUserId).filter(Boolean)))
  );
  const result = rows.map((row) => ({
    ...row,
    inspectorDisplay: displayNames.get(row.inspectorUserId) ?? row.inspectorEmail ?? null
  }));
  return replaceProtectedLegalNamesInValue(result, await loadProtectedInspectionPeople(db, entryId)) as typeof result;
};

export const listInspectorAssignments = async (eventId?: string) => {
  const db = await getDb();
  const query = db
    .select({
      id: technicalInspectorAssignment.id,
      eventId: technicalInspectorAssignment.eventId,
      eventName: event.name,
      userEmail: technicalInspectorAssignment.userEmailNorm,
      validFrom: technicalInspectorAssignment.validFrom,
      validUntil: technicalInspectorAssignment.validUntil
    })
    .from(technicalInspectorAssignment)
    .innerJoin(event, eq(technicalInspectorAssignment.eventId, event.id));
  return eventId
    ? query.where(eq(technicalInspectorAssignment.eventId, eventId)).orderBy(technicalInspectorAssignment.userEmailNorm)
    : query.orderBy(desc(technicalInspectorAssignment.validUntil));
};

export const upsertInspectorAssignment = async (
  userEmail: string,
  input: InspectorAssignmentInput,
  actorUserId: string | null
) => {
  const db = await getDb();
  const now = new Date();
  const [result] = await db
    .insert(technicalInspectorAssignment)
    .values({
      eventId: input.eventId,
      userEmailNorm: normalizeEmail(userEmail),
      validFrom: new Date(input.validFrom),
      validUntil: new Date(input.validUntil),
      createdBy: actorUserId
    })
    .onConflictDoUpdate({
      target: [technicalInspectorAssignment.userEmailNorm, technicalInspectorAssignment.eventId],
      set: {
        validFrom: new Date(input.validFrom),
        validUntil: new Date(input.validUntil),
        updatedAt: now
      }
    })
    .returning();
  return result;
};

const inspectionUrl = (entryId: string) => {
  const baseUrl = (process.env.MAIL_PUBLIC_BASE_URL ?? '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new Error('INSPECTION_PUBLIC_URL_NOT_CONFIGURED');
  }
  return `${baseUrl}/inspection/${encodeURIComponent(entryId)}`;
};

const svgFromMatrix = (matrix: ReturnType<typeof buildGiroCodeMatrix>) => {
  const modules: string[] = [];
  for (let row = 0; row < matrix.size; row += 1) {
    for (let column = 0; column < matrix.size; column += 1) {
      if (matrix.modules[row * matrix.size + column]) {
        modules.push(`<rect x="${column}" y="${row}" width="1" height="1"/>`);
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-4 -4 ${matrix.size + 8} ${matrix.size + 8}" shape-rendering="crispEdges"><rect x="-4" y="-4" width="${matrix.size + 8}" height="${matrix.size + 8}" fill="white"/><g fill="black">${modules.join('')}</g></svg>`;
};

export const createParticipantInspectionQrDownload = async (eventId: string, personId: string, format: 'svg' | 'png') => {
  const url = (() => {
    const baseUrl = (process.env.MAIL_PUBLIC_BASE_URL ?? '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(baseUrl)) throw new Error('INSPECTION_PUBLIC_URL_NOT_CONFIGURED');
    return `${baseUrl}/inspection/participant/${encodeURIComponent(eventId)}/${encodeURIComponent(personId)}`;
  })();
  if (format === 'png') {
    const QRCode = require('qrcode');
    const dataUrl = await QRCode.toDataURL(url, {
      errorCorrectionLevel: 'H',
      margin: 4,
      color: { dark: '#000000', light: '#FFFFFF' },
      width: 512
    });
    return { filename: `abnahme-fahrer-${personId}.png`, mimeType: 'image/png', data: Buffer.from(dataUrl.split(',', 2)[1], 'base64') };
  }
  return {
    filename: `abnahme-fahrer-${personId}.svg`,
    mimeType: 'image/svg+xml',
    data: Buffer.from(svgFromMatrix(buildQrCodeMatrix(url, 'H')), 'utf8')
  };
};

export const createInspectionQrDownload = async (entryId: string, format: 'svg' | 'png') => {
  const url = inspectionUrl(entryId);
  if (format === 'png') {
    return {
      filename: `abnahme-${entryId}.png`,
      mimeType: 'image/png',
      data: await renderGiroCodePng(url)
    };
  }
  return {
    filename: `abnahme-${entryId}.svg`,
    mimeType: 'image/svg+xml',
    data: Buffer.from(svgFromMatrix(buildGiroCodeMatrix(url)), 'utf8')
  };
};

export const createInspectionQrSheet = async (eventId: string, entryIds: string[]) => {
  const db = await getDb();
  const rows = await db
    .select({
      id: entry.id,
      startNumber: entry.startNumberNorm,
      driverFirstName: person.firstName,
      driverLastName: person.lastName,
      driverPublicationName: person.publicationName,
      className: eventClass.name
    })
    .from(entry)
    .innerJoin(person, eq(entry.driverPersonId, person.id))
    .innerJoin(eventClass, eq(entry.classId, eventClass.id))
    .where(and(eq(entry.eventId, eventId), inArray(entry.id, entryIds)));

  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 32 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const cellWidth = 265;
    const cellHeight = 175;
    rows.forEach((row, index) => {
      if (index > 0 && index % 6 === 0) doc.addPage();
      const local = index % 6;
      const x = 32 + (local % 2) * cellWidth;
      const y = 32 + Math.floor(local / 2) * cellHeight;
      const matrix = buildGiroCodeMatrix(inspectionUrl(row.id));
      const size = 112;
      const moduleSize = size / matrix.size;
      doc.save().rect(x, y, cellWidth - 8, cellHeight - 8).lineWidth(0.5).strokeColor('#CBD5E1').stroke();
      doc.fillColor('#000000');
      matrix.modules.forEach((filled, moduleIndex) => {
        if (!filled) return;
        const mx = moduleIndex % matrix.size;
        const my = Math.floor(moduleIndex / matrix.size);
        doc.rect(x + 8 + mx * moduleSize, y + 8 + my * moduleSize, moduleSize + 0.05, moduleSize + 0.05).fill();
      });
      doc.restore();
      doc.fontSize(20).text(`#${row.startNumber ?? '-'}`, x + 132, y + 15, { width: 115 });
      doc.fontSize(10).text(standardPersonIdentity({ firstName: row.driverFirstName, lastName: row.driverLastName, publicationName: row.driverPublicationName }).displayName, x + 132, y + 48, { width: 115 });
      doc.fontSize(9).text(row.className, x + 132, y + 82, { width: 115 });
    });
    doc.end();
  });
};

export const validateInspectionSearchInput = (query: Record<string, string | undefined>) =>
  inspectionSearchSchema.parse({
    eventId: query.eventId,
    q: query.q,
    limit: query.limit === undefined ? undefined : Number(query.limit)
  });
export const validateInspectionDecisionInput = (payload: unknown) => inspectionDecisionSchema.parse(payload);
export const validateInspectionNoteInput = (payload: unknown) => inspectionNoteSchema.parse(payload);
export const validateInspectorAssignmentInput = (payload: unknown) => inspectorAssignmentSchema.parse(payload);
export const validateQrExportInput = (payload: unknown) => qrExportSchema.parse(payload);
