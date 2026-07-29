import { and, desc, eq, gte, ilike, inArray, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { writeAuditLog } from '../audit/log';
import { buildGiroCodeMatrix, renderGiroCodePng } from '../docs/girocode';
import { getDb } from '../db/client';
import {
  entry,
  event,
  eventClass,
  person,
  technicalInspectionDecision,
  technicalInspectorAssignment,
  vehicle
} from '../db/schema';
import { doesAssetObjectExist, getPresignedAssetsDownloadUrl } from '../docs/storage';
import type { AuthContext } from '../http/auth';
import { resolveIamUserDisplayNames } from './adminIam';

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
  return db
    .select({
      id: entry.id,
      startNumber: entry.startNumberNorm,
      driverFirstName: person.firstName,
      driverLastName: person.lastName,
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
          ilike(person.firstName, pattern),
          ilike(person.lastName, pattern),
          sql`lower(trim(coalesce(${person.firstName}, '') || ' ' || coalesce(${person.lastName}, ''))) like lower(${pattern})`
        )
      )
    )
    .limit(input.limit);
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
  const { vehicleImageS3Key: _vehicleImageS3Key, ...entryResult } = result;
  const backupVehicleResult = backupVehicle
    ? (({ imageS3Key: _imageS3Key, ...vehicleResult }) => vehicleResult)(backupVehicle)
    : null;
  return {
    ...entryResult,
    vehicleImageUrl,
    codriver: codriverRows[0] ?? null,
    backupVehicle: backupVehicleResult
      ? {
          ...backupVehicleResult,
          imageUrl: backupVehicleImageUrl
        }
      : null
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
  return db.transaction(async (tx) => {
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
    return { entry: updated, decision };
  });
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
  return db.transaction(async (tx) => {
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
  return rows.map((row) => ({
    ...row,
    inspectorDisplay: displayNames.get(row.inspectorUserId) ?? row.inspectorEmail ?? null
  }));
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
      doc.fontSize(10).text(`${row.driverFirstName} ${row.driverLastName}`, x + 132, y + 48, { width: 115 });
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
