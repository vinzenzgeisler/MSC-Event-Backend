import { and, asc, desc, eq, gte, ilike, inArray, lte, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { writeAuditLog } from '../audit/log';
import { buildGiroCodeMatrix, buildQrCodeMatrix, renderGiroCodePng } from '../docs/girocode';
import { getDb } from '../db/client';
import {
  auditLog,
  document,
  entry,
  entryCharityCodriver,
  event,
  eventClass,
  invoice,
  person,
  technicalInspectionDecision,
  technicalInspectorAssignment,
  vehicle
} from '../db/schema';
import {
  buildParticipantInspectionSummary,
  evaluateInspectionEligibility,
  type InspectionEligibility,
  type InspectionProgressEntry,
  type InspectionRequirement,
  type ParticipantInspectionSummary
} from '../domain/inspectionReadiness';
import { resolveVehicleThumbUrl } from '../docs/storage';
import type { AuthContext } from '../http/auth';
import { WAIVER_VERSION } from '../legal/waiverContract';
import { queueOperationalMails } from '../mail/operationalOutbox';
import { operationalPresentationData } from '../mail/operationalPresentation';
import { getOrgaNotificationRecipients } from '../observability/recipients';
import { logOperationalEvent } from '../observability/logger';
import { resolveIamUserDisplayNames, resolveIamUserEmail } from './adminIam';
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
    note: z.string().trim().max(2000).nullable().optional(),
    expected: z.object({
      techStatus: z.enum(['pending', 'passed', 'failed']),
      checkedAt: z.string().datetime().nullable(),
      note: z.string().max(2000).nullable()
    }).optional()
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
  note: z.string().trim().max(2000).nullable(),
  expectedNote: z.string().max(2000).nullable().optional()
});

const inspectionAccessSourceSchema = z.enum(['qr', 'search', 'participant', 'history', 'direct']);
const inspectionAccessSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('entry'),
    entryId: z.string().uuid(),
    source: inspectionAccessSourceSchema
  }),
  z.object({
    type: z.literal('participant'),
    eventId: z.string().uuid(),
    personId: z.string().uuid(),
    source: inspectionAccessSourceSchema
  })
]);

const inspectionOverviewSchema = z.object({
  eventId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(100).default(40)
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
type InspectionAccessInput = z.infer<typeof inspectionAccessSchema>;
type InspectionAccessSource = z.infer<typeof inspectionAccessSourceSchema>;
type InspectionOverviewInput = z.infer<typeof inspectionOverviewSchema>;

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
  className: string | null;
  vehicleMake: string | null;
  vehicleModel: string | null;
  startNumber: string | null;
  eventName: string | null;
  decidedAt: string;
};

const inspectionPresentationData = (status: 'passed' | 'failed', audience: 'driver' | 'orga') => {
  const statusLabel = status === 'passed' ? 'BESTANDEN' : 'NICHT BESTANDEN';
  return operationalPresentationData({
    headerTitle: audience === 'orga'
      ? `INTERNE TECHNISCHE MELDUNG · ${statusLabel}`
      : `TECHNISCHE ABNAHME · ${statusLabel}`,
    preheader: `Prüfergebnis technische Abnahme: ${statusLabel}`,
    mailLabel: 'Technische Abnahme'
  });
};

// Driver-facing mails use the same canonical customer-facing layout as every other system
// mail (entry-context card + prose), instead of the operational-notice box used for the
// internal orga notification below — the two audiences intentionally look different.
const driverInspectionPresentationData = (
  input: InspectionDecisionEmailInput,
  status: 'passed' | 'failed'
) => {
  const statusLabel = status === 'passed' ? 'BESTANDEN' : 'NICHT BESTANDEN';
  const vehicleLabel = [input.vehicleMake, input.vehicleModel].filter(Boolean).join(' ') || null;
  return {
    headerTitle: `TECHNISCHE ABNAHME · ${statusLabel}`,
    preheader: `Prüfergebnis technische Abnahme: ${statusLabel}`,
    eventName: input.eventName ?? undefined,
    startNumber: input.startNumber ?? undefined,
    vehicleLabel: vehicleLabel ?? undefined,
    renderOptions: {
      showBadge: true,
      mailLabel: 'Technische Abnahme',
      includeEntryContext: true
    }
  };
};

function buildInspectionDecisionMail(input: InspectionDecisionEmailInput) {
  if (input.techStatus === 'pending') return null;
  const vehicleName =
    [input.vehicleMake, input.vehicleModel].filter(Boolean).join(' ') || 'dein Fahrzeug';
  const vehicleLabel =
    input.target === 'backup' ? `${vehicleName} (Ersatzfahrzeug)` : vehicleName;
  const driverName = input.driverDisplayName;
  const startInfo = input.startNumber ? ` · Startnummer #${input.startNumber}` : '';
  const eventInfo = input.eventName ?? 'MSC Oberlausitzer Dreiländereck';
  // Driver-facing mails use the standard canonical layout (entry-context card + prose)
  // like every other system mail, instead of a bespoke HTML box.
  const templateData = driverInspectionPresentationData(input, input.techStatus);

  if (input.techStatus === 'passed') {
    const subject = `Technische Abnahme bestätigt – ${eventInfo}`;
    const bodyText = [
      `Hallo ${driverName},`,
      '',
      `dein Fahrzeug ${vehicleLabel} wurde bei der technischen Abnahme zugelassen.${startInfo}`,
      '',
      ...(input.note ? [`Hinweis des Prüfers: ${input.note}`, ''] : []),
      'Wir freuen uns auf dich bei der Veranstaltung.',
      '',
      'Viele Grüße',
      'Dein Organisationsteam',
      'MSC Oberlausitzer Dreiländereck e.V.'
    ].join('\n');
    return { subject, bodyText, templateData };
  } else {
    const subject = `Technische Abnahme: Fahrzeug nicht zugelassen – ${eventInfo}`;
    const bodyText = [
      `Hallo ${driverName},`,
      '',
      `dein Fahrzeug ${vehicleLabel} wurde bei der technischen Abnahme leider nicht zugelassen.${startInfo}`,
      '',
      ...(input.note ? [`Ablehnungsgrund: ${input.note}`, ''] : []),
      'Bitte wende dich bei Fragen an das Organisationsteam.',
      '',
      'Viele Grüße',
      'Dein Organisationsteam',
      'MSC Oberlausitzer Dreiländereck e.V.'
    ].join('\n');
    return { subject, bodyText, templateData };
  }
}

// Kept deliberately short and technical: a driver/class/timestamp/inspector fact sheet,
// plus the rejection note when relevant. This is an internal alert, not a customer mail.
const buildInspectionOrgaMail = (input: InspectionDecisionEmailInput & { inspector: string | null }) => {
  const completedStatus: 'passed' | 'failed' = input.techStatus === 'passed' ? 'passed' : 'failed';
  const statusLabel = input.techStatus === 'passed' ? 'BESTANDEN' : 'ABGELEHNT';
  const vehicleName = [input.vehicleMake, input.vehicleModel].filter(Boolean).join(' ') || 'Unbekanntes Fahrzeug';
  const bodyText = [
    `Technische Abnahme: ${statusLabel}`,
    '',
    `Fahrer: ${input.driverDisplayName}`,
    `Klasse: ${input.className ?? '-'}`,
    `Startnummer: ${input.startNumber ?? '-'}`,
    `Fahrzeug: ${vehicleName}${input.target === 'backup' ? ' (Ersatzfahrzeug)' : ''}`,
    `Veranstaltung: ${input.eventName ?? '-'}`,
    `Zeit: ${input.decidedAt}`,
    `Prüfer: ${input.inspector ?? '-'}`,
    ...(input.techStatus === 'failed' && input.note ? ['', `Ablehnungsgrund: ${input.note}`] : [])
  ].join('\n');
  return {
    subject: `[Technische Abnahme][${statusLabel}] #${input.startNumber ?? '-'} – ${input.driverDisplayName}`,
    bodyText,
    templateData: inspectionPresentationData(completedStatus, 'orga')
  };
};

const normalizeEmail = (value: string): string => value.trim().toLowerCase();


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

  if (!auth.groups.includes('technical_inspector')) {
    return null;
  }

  // Cognito access tokens contain the stable subject and groups, but normally no
  // email claim. Resolve the verified account email server-side so event-scoped
  // assignments also work when the API is called with an access token.
  const inspectorEmail = auth.email ?? await resolveIamUserEmail(auth.sub);
  if (!inspectorEmail) {
    return null;
  }

  const now = new Date();
  const conditions = [
    eq(technicalInspectorAssignment.userEmailNorm, normalizeEmail(inspectorEmail)),
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

const loadInspectionEligibility = async (
  db: any,
  eventId: string,
  driverPersonId: string
): Promise<InspectionEligibility> => {
  const [paymentRows, waiverRows] = await Promise.all([
    db
      .select({ paymentStatus: invoice.paymentStatus })
      .from(invoice)
      .where(and(eq(invoice.eventId, eventId), eq(invoice.driverPersonId, driverPersonId)))
      .limit(1),
    db
      .select({ id: document.id })
      .from(document)
      .where(and(
        eq(document.eventId, eventId),
        eq(document.driverPersonId, driverPersonId),
        eq(document.type, 'waiver_signed'),
        eq(document.templateVersion, WAIVER_VERSION),
        eq(document.status, 'generated')
      ))
      .limit(1)
  ]);
  return evaluateInspectionEligibility(paymentRows[0]?.paymentStatus, waiverRows.length > 0);
};

const loadParticipantProgressEntries = async (
  db: any,
  eventId: string,
  driverPersonId: string
): Promise<InspectionProgressEntry[]> => {
  const backupVehicle = alias(vehicle, 'inspection_progress_backup_vehicle');
  return db
    .select({
      id: entry.id,
      driverPersonId: entry.driverPersonId,
      startNumber: entry.startNumberNorm,
      className: eventClass.name,
      vehicleMake: vehicle.make,
      vehicleModel: vehicle.model,
      techStatus: entry.techStatus,
      backupVehicleId: entry.backupVehicleId,
      backupVehicleMake: backupVehicle.make,
      backupVehicleModel: backupVehicle.model,
      backupTechStatus: entry.backupTechStatus
    })
    .from(entry)
    .innerJoin(eventClass, eq(entry.classId, eventClass.id))
    .innerJoin(vehicle, eq(entry.vehicleId, vehicle.id))
    .leftJoin(backupVehicle, eq(entry.backupVehicleId, backupVehicle.id))
    .where(and(
      eq(entry.eventId, eventId),
      eq(entry.driverPersonId, driverPersonId),
      eq(entry.acceptanceStatus, 'accepted'),
      sql`${entry.deletedAt} is null`
    ))
    .orderBy(asc(entry.startNumberNorm), asc(entry.id));
};

const loadParticipantInspectionState = async (
  db: any,
  eventId: string,
  driverPersonId: string
): Promise<{ eligibility: InspectionEligibility; participantSummary: ParticipantInspectionSummary }> => {
  const [eligibility, progressEntries] = await Promise.all([
    loadInspectionEligibility(db, eventId, driverPersonId),
    loadParticipantProgressEntries(db, eventId, driverPersonId)
  ]);
  return {
    eligibility,
    participantSummary: buildParticipantInspectionSummary(progressEntries, eligibility)
  };
};

const recordBlockedInspectionAccess = async (
  db: any,
  auth: AuthContext,
  eventId: string,
  entryIds: string[],
  source: InspectionAccessSource,
  missingRequirements: InspectionRequirement[],
  attemptedAction: 'open' | 'decision' | 'note'
) => {
  for (const entryId of entryIds) {
    await writeAuditLog(db, {
      eventId,
      actorUserId: auth.sub,
      action: 'inspection_access_blocked',
      entityType: 'entry',
      entityId: entryId,
      payload: { source, missingRequirements, attemptedAction }
    });
  }
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
      driverPersonId: entry.driverPersonId,
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
  const eligibilityByDriver = new Map<string, InspectionEligibility>();
  await Promise.all(Array.from(new Set(rows.map((row) => row.driverPersonId))).map(async (driverPersonId) => {
    eligibilityByDriver.set(driverPersonId, await loadInspectionEligibility(db, assignedEvent.id, driverPersonId));
  }));
  return rows.map((row) => {
    const identity = standardPersonIdentity({ firstName: row.driverFirstName, lastName: row.driverLastName, publicationName: row.driverPublicationName });
    return { ...row, eligibility: eligibilityByDriver.get(row.driverPersonId), driverDisplayName: identity.displayName, identityProtected: identity.identityProtected, driverFirstName: identity.firstName, driverLastName: identity.lastName, driverPublicationName: undefined };
  });
};

export const getInspectionEntry = async (auth: AuthContext, entryId: string) => {
  const db = await getDb();
  const rows = await db
    .select({
      id: entry.id,
      eventId: entry.eventId,
      driverPersonId: entry.driverPersonId,
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
  const [codriverRows, backupVehicleRows, participantState] = await Promise.all([
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
      : Promise.resolve([]),
    loadParticipantInspectionState(db, result.eventId, result.driverPersonId)
  ]);
  const backupVehicle = backupVehicleRows[0] ?? null;
  const [vehicleImageUrl, backupVehicleImageUrl] = await Promise.all([
    resolveVehicleThumbUrl(result.vehicleImageS3Key),
    resolveVehicleThumbUrl(backupVehicle?.imageS3Key ?? null)
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
      : null,
    ...participantState
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
    entries,
    eligibility: entries[0].eligibility,
    participantSummary: entries[0].participantSummary
  };
};

export const checkInspectionAccess = async (auth: AuthContext, input: InspectionAccessInput) => {
  let eligibility: InspectionEligibility;
  let eventId: string;
  let entryIds: string[];
  let driverPersonId: string;
  let driverDisplayName: string;
  if (input.type === 'entry') {
    const result = await getInspectionEntry(auth, input.entryId);
    if (!result) return null;
    eligibility = result.eligibility;
    eventId = result.eventId;
    entryIds = [result.id];
    driverPersonId = result.driverPersonId;
    driverDisplayName = result.driverDisplayName;
  } else {
    const result = await getInspectionParticipant(auth, input.eventId, input.personId);
    if (!result) return null;
    eligibility = result.eligibility;
    eventId = result.event.id;
    entryIds = result.entries.map((item) => item.id);
    driverPersonId = result.driver.personId;
    driverDisplayName = result.driver.displayName;
  }
  if (!eligibility.ready) {
    const db = await getDb();
    await recordBlockedInspectionAccess(db, auth, eventId, entryIds, input.source, eligibility.missingRequirements, 'open');
  }
  return { allowed: eligibility.ready, eventId, entryIds, driverPersonId, driverDisplayName, eligibility };
};

const sameTimestamp = (left: Date | string | null | undefined, right: string | null) =>
  (left ? new Date(left).toISOString() : null) === right;

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
  if (!existing.eligibility.ready) {
    await recordBlockedInspectionAccess(db, auth, existing.eventId, [entryId], 'direct', existing.eligibility.missingRequirements, 'decision');
    throw new Error('INSPECTION_CHECKIN_REQUIRED');
  }
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
  // Resolved before opening the transaction below so the Cognito network call never holds
  // the row lock taken inside it.
  const inspectorDisplayNames = await resolveIamUserDisplayNames([actorUserId]);
  const inspectorDisplayName = inspectorDisplayNames.get(actorUserId);
  const inspectorLabel = inspectorDisplayName
    ? `${inspectorDisplayName} (${auth.email ?? actorUserId})`
    : (auth.email ?? actorUserId);
  const result = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select({
        eventId: entry.eventId,
        driverPersonId: entry.driverPersonId,
        techStatus: entry.techStatus,
        techCheckedAt: entry.techCheckedAt,
        inspectionNote: entry.inspectionNote,
        backupTechStatus: entry.backupTechStatus,
        backupTechCheckedAt: entry.backupTechCheckedAt,
        backupInspectionNote: entry.backupInspectionNote
      })
      .from(entry)
      .where(eq(entry.id, entryId))
      .for('update')
      .limit(1);
    if (!locked) return null;
    const eligibility = await loadInspectionEligibility(tx, locked.eventId, locked.driverPersonId);
    if (!eligibility.ready) throw new Error('INSPECTION_CHECKIN_REQUIRED');
    if (input.expected) {
      const currentStatus = input.target === 'backup' ? locked.backupTechStatus : locked.techStatus;
      const currentCheckedAt = input.target === 'backup' ? locked.backupTechCheckedAt : locked.techCheckedAt;
      const currentNote = input.target === 'backup' ? locked.backupInspectionNote : locked.inspectionNote;
      if (currentStatus !== input.expected.techStatus || !sameTimestamp(currentCheckedAt, input.expected.checkedAt) || (currentNote ?? null) !== input.expected.note) {
        throw new Error('INSPECTION_STATE_CONFLICT');
      }
    }
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
        className: existing.className ?? null,
        vehicleMake: input.target === 'backup' ? (existing.backupVehicle?.make ?? null) : existing.vehicleMake,
        vehicleModel: input.target === 'backup' ? (existing.backupVehicle?.model ?? null) : existing.vehicleModel,
        startNumber: existing.startNumber,
        eventName: existing.eventName ?? null,
        decidedAt: now.toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })
      };
      const driverMail = buildInspectionDecisionMail(baseMailInput);
      const orgaMail = buildInspectionOrgaMail({ ...baseMailInput, inspector: inspectorLabel });
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

  if (!result) return null;
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

  const db = await getDb();
  if (!existing.eligibility.ready) {
    await recordBlockedInspectionAccess(db, auth, existing.eventId, [entryId], 'direct', existing.eligibility.missingRequirements, 'note');
    throw new Error('INSPECTION_CHECKIN_REQUIRED');
  }

  const note = input.note?.trim() || null;
  const currentNote =
    input.target === 'backup' ? existing.backupInspectionNote ?? null : existing.inspectionNote ?? null;
  if (currentNote === note) {
    return { changed: false, note, target: input.target };
  }

  const now = new Date();
  const result = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select({
        eventId: entry.eventId,
        driverPersonId: entry.driverPersonId,
        inspectionNote: entry.inspectionNote,
        backupInspectionNote: entry.backupInspectionNote
      })
      .from(entry)
      .where(eq(entry.id, entryId))
      .for('update')
      .limit(1);
    if (!locked) return null;
    const eligibility = await loadInspectionEligibility(tx, locked.eventId, locked.driverPersonId);
    if (!eligibility.ready) throw new Error('INSPECTION_CHECKIN_REQUIRED');
    const lockedNote = input.target === 'backup' ? locked.backupInspectionNote : locked.inspectionNote;
    if (input.expectedNote !== undefined && (lockedNote ?? null) !== input.expectedNote) {
      throw new Error('INSPECTION_STATE_CONFLICT');
    }
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
  if (!result) return null;
  return replaceProtectedLegalNamesInValue(result, await loadProtectedInspectionPeople(db, entryId)) as typeof result;
};

export const listInspectionHistory = async (auth: AuthContext, entryId: string) => {
  const existing = await getInspectionEntry(auth, entryId);
  if (!existing) {
    return null;
  }
  const db = await getDb();
  const [rows, blockedRows] = await Promise.all([db
    .select()
    .from(technicalInspectionDecision)
    .where(eq(technicalInspectionDecision.entryId, entryId))
    .orderBy(desc(technicalInspectionDecision.createdAt))
    .limit(50),
  db.select().from(auditLog).where(and(
    eq(auditLog.entityType, 'entry'),
    eq(auditLog.entityId, entryId),
    eq(auditLog.action, 'inspection_access_blocked')
  )).orderBy(desc(auditLog.createdAt)).limit(50)]);
  const displayNames = await resolveIamUserDisplayNames(
    Array.from(new Set([...rows.map((row) => row.inspectorUserId), ...blockedRows.map((row) => row.actorUserId)].filter((id): id is string => Boolean(id))))
  );
  const result = [
    ...rows.map((row) => ({ ...row, kind: 'decision' as const, inspectorDisplay: displayNames.get(row.inspectorUserId) ?? row.inspectorEmail ?? null })),
    ...blockedRows.map((row) => ({
      id: row.id,
      kind: 'blocked_access' as const,
      entryId,
      createdAt: row.createdAt,
      inspectorUserId: row.actorUserId,
      inspectorDisplay: row.actorUserId ? displayNames.get(row.actorUserId) ?? null : null,
      source: (row.payload as Record<string, unknown> | null)?.source ?? null,
      missingRequirements: (row.payload as Record<string, unknown> | null)?.missingRequirements ?? [],
      attemptedAction: (row.payload as Record<string, unknown> | null)?.attemptedAction ?? 'open'
    }))
  ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 50);
  return replaceProtectedLegalNamesInValue(result, await loadProtectedInspectionPeople(db, entryId)) as typeof result;
};

export const getInspectionOverview = async (auth: AuthContext, input: InspectionOverviewInput) => {
  if (!auth.sub) throw new Error('INSPECTION_IDENTITY_REQUIRED');
  const assignedEvent = await resolveAssignedEvent(auth, input.eventId);
  if (!assignedEvent) throw new Error('INSPECTION_ASSIGNMENT_REQUIRED');
  const db = await getDb();
  const backupVehicle = alias(vehicle, 'inspection_overview_backup_vehicle');
  const rows = await db
    .select({
      id: entry.id,
      driverPersonId: entry.driverPersonId,
      driverFirstName: person.firstName,
      driverLastName: person.lastName,
      driverPublicationName: person.publicationName,
      startNumber: entry.startNumberNorm,
      className: eventClass.name,
      vehicleMake: vehicle.make,
      vehicleModel: vehicle.model,
      techStatus: entry.techStatus,
      backupVehicleId: entry.backupVehicleId,
      backupVehicleMake: backupVehicle.make,
      backupVehicleModel: backupVehicle.model,
      backupTechStatus: entry.backupTechStatus
    })
    .from(entry)
    .innerJoin(person, eq(entry.driverPersonId, person.id))
    .innerJoin(eventClass, eq(entry.classId, eventClass.id))
    .innerJoin(vehicle, eq(entry.vehicleId, vehicle.id))
    .leftJoin(backupVehicle, eq(entry.backupVehicleId, backupVehicle.id))
    .where(and(
      eq(entry.eventId, assignedEvent.id),
      eq(entry.acceptanceStatus, 'accepted'),
      sql`${entry.deletedAt} is null`
    ));
  const driverIds = Array.from(new Set(rows.map((row) => row.driverPersonId)));
  const [invoiceRows, waiverRows] = driverIds.length > 0 ? await Promise.all([
    db.select({ driverPersonId: invoice.driverPersonId, paymentStatus: invoice.paymentStatus })
      .from(invoice)
      .where(and(eq(invoice.eventId, assignedEvent.id), inArray(invoice.driverPersonId, driverIds))),
    db.select({ driverPersonId: document.driverPersonId })
      .from(document)
      .where(and(
        eq(document.eventId, assignedEvent.id),
        inArray(document.driverPersonId, driverIds),
        eq(document.type, 'waiver_signed'),
        eq(document.templateVersion, WAIVER_VERSION),
        eq(document.status, 'generated')
      ))
  ]) : [[], []];
  const paymentByDriver = new Map(invoiceRows.map((row) => [row.driverPersonId, row.paymentStatus]));
  const waiverDrivers = new Set(waiverRows.map((row) => row.driverPersonId).filter(Boolean));
  const grouped = new Map<string, typeof rows>();
  for (const row of rows) grouped.set(row.driverPersonId, [...(grouped.get(row.driverPersonId) ?? []), row]);
  const participants = Array.from(grouped.entries()).map(([driverPersonId, driverRows]) => {
    const eligibility = evaluateInspectionEligibility(paymentByDriver.get(driverPersonId), waiverDrivers.has(driverPersonId));
    const participantSummary = buildParticipantInspectionSummary(driverRows as unknown as InspectionProgressEntry[], eligibility);
    const identity = standardPersonIdentity({
      firstName: driverRows[0].driverFirstName,
      lastName: driverRows[0].driverLastName,
      publicationName: driverRows[0].driverPublicationName
    });
    return {
      driverPersonId,
      driverDisplayName: identity.displayName,
      identityProtected: identity.identityProtected,
      eligibility,
      participantSummary
    };
  });
  const counters = participants.reduce((sum, item) => {
    if (!item.eligibility.ready) sum.notEligibleTargets += item.participantSummary.totalTargets;
    else {
      sum.pendingTargets += item.participantSummary.pendingTargets;
      sum.passedTargets += item.participantSummary.passedTargets;
      sum.failedTargets += item.participantSummary.failedTargets;
    }
    if (item.participantSummary.stampReady) sum.stampReadyDrivers += 1;
    sum.totalTargets += item.participantSummary.totalTargets;
    return sum;
  }, { totalTargets: 0, notEligibleTargets: 0, pendingTargets: 0, passedTargets: 0, failedTargets: 0, stampReadyDrivers: 0 });

  const recentRows = await db
    .select()
    .from(technicalInspectionDecision)
    .where(and(
      eq(technicalInspectionDecision.eventId, assignedEvent.id),
      eq(technicalInspectionDecision.inspectorUserId, auth.sub)
    ))
    .orderBy(desc(technicalInspectionDecision.createdAt))
    .limit(Math.min(input.limit * 4, 400));
  const rowByEntry = new Map(rows.map((row) => [row.id, row]));
  const participantByDriver = new Map(participants.map((item) => [item.driverPersonId, item]));
  const seenEntries = new Set<string>();
  const recentEntries = recentRows.flatMap((decision) => {
    if (seenEntries.has(decision.entryId)) return [];
    const entryRow = rowByEntry.get(decision.entryId);
    if (!entryRow) return [];
    seenEntries.add(decision.entryId);
    const participant = participantByDriver.get(entryRow.driverPersonId)!;
    return [{
      entryId: decision.entryId,
      driverPersonId: entryRow.driverPersonId,
      driverDisplayName: participant.driverDisplayName,
      startNumber: entryRow.startNumber,
      className: entryRow.className,
      vehicleMake: entryRow.vehicleMake,
      vehicleModel: entryRow.vehicleModel,
      techStatus: entryRow.techStatus,
      backupTechStatus: entryRow.backupTechStatus,
      lastAction: { status: decision.status, target: decision.target, note: decision.note, createdAt: decision.createdAt },
      stampReady: participant.participantSummary.stampReady
    }];
  }).slice(0, input.limit);
  return {
    event: assignedEvent,
    counters: { ...counters, totalDrivers: participants.length },
    recentEntries
  };
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
export const validateInspectionAccessInput = (payload: unknown) => inspectionAccessSchema.parse(payload);
export const validateInspectionOverviewInput = (query: Record<string, string | undefined>) => inspectionOverviewSchema.parse({
  eventId: query.eventId,
  limit: query.limit === undefined ? undefined : Number(query.limit)
});
export const validateInspectorAssignmentInput = (payload: unknown) => inspectorAssignmentSchema.parse(payload);
export const validateQrExportInput = (payload: unknown) => qrExportSchema.parse(payload);
