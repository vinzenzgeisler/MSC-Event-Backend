import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { getDb } from '../db/client';
import { document, documentGenerationJob, entry, event, eventClass, person, vehicle } from '../db/schema';
import { writeAuditLog } from '../audit/log';
import { renderBatchDocumentPdf, renderTechCheckPdf, renderWaiverPdf } from '../docs/pdf';
import { uploadPdf, getPresignedDownloadUrl } from '../docs/storage';
import { assertEventStatusAllowed } from '../domain/eventStatus';
import { getOrCreateEntryConfirmationAttachment } from '../docs/entryConfirmation';

const documentRequestSchema = z.object({
  eventId: z.string().uuid(),
  entryId: z.string().uuid()
});

const batchDocumentRequestSchema = z.object({
  eventId: z.string().uuid(),
  entryIds: z.array(z.string().uuid()).min(1).max(250)
});

type DocumentRequest = z.infer<typeof documentRequestSchema>;
type BatchDocumentRequest = z.infer<typeof batchDocumentRequestSchema>;
type TechCheckVariant = 'auto' | 'moto';

const buildPayload = async (input: DocumentRequest) => {
  const db = await getDb();
  const rows = await db
    .select({
      eventName: event.name,
      eventStartsAt: event.startsAt,
      eventEndsAt: event.endsAt,
      className: eventClass.name,
      driverPersonId: entry.driverPersonId,
      driverFirstName: person.firstName,
      driverLastName: person.lastName,
      driverBirthdate: person.birthdate,
      driverStreet: person.street,
      driverZip: person.zip,
      driverCity: person.city,
      driverPhone: person.phone,
      codriverFirstName: person.firstName,
      codriverLastName: person.lastName,
      codriverBirthdate: person.birthdate,
      codriverStreet: person.street,
      codriverZip: person.zip,
      codriverCity: person.city,
      codriverPhone: person.phone,
      vehicleType: vehicle.vehicleType,
      vehicleMake: vehicle.make,
      vehicleModel: vehicle.model,
      vehicleYear: vehicle.year,
      vehicleStartNumber: vehicle.startNumberRaw
    })
    .from(entry)
    .innerJoin(event, eq(entry.eventId, event.id))
    .innerJoin(eventClass, eq(entry.classId, eventClass.id))
    .innerJoin(person, eq(entry.driverPersonId, person.id))
    .innerJoin(vehicle, eq(entry.vehicleId, vehicle.id))
    .where(and(eq(entry.id, input.entryId), eq(entry.eventId, input.eventId)));

  if (rows.length === 0) {
    return null;
  }

  const row = rows[0];

  const driverAddress = [row.driverStreet, row.driverZip, row.driverCity].filter(Boolean).join(' ');

  return {
    event: {
      name: row.eventName,
      startsAt: row.eventStartsAt?.toString() ?? '-',
      endsAt: row.eventEndsAt?.toString() ?? '-',
      className: row.className
    },
    driver: {
      fullName: `${row.driverFirstName} ${row.driverLastName}`,
      birthdate: row.driverBirthdate?.toString() ?? null,
      address: driverAddress || null,
      phone: row.driverPhone ?? null
    },
    codriver: null,
    vehicle: {
      vehicleType: row.vehicleType,
      make: row.vehicleMake ?? null,
      model: row.vehicleModel ?? null,
      year: row.vehicleYear ?? null,
      startNumber: row.vehicleStartNumber ?? null
    },
    driverPersonId: row.driverPersonId
  };
};

const buildBatchPayload = async (input: BatchDocumentRequest) => {
  const db = await getDb();
  const rows = await db
    .select({
      entryId: entry.id,
      className: eventClass.name,
      driverFirstName: person.firstName,
      driverLastName: person.lastName,
      vehicleType: vehicle.vehicleType,
      vehicleMake: vehicle.make,
      vehicleModel: vehicle.model,
      vehicleStartNumber: vehicle.startNumberRaw
    })
    .from(entry)
    .innerJoin(eventClass, eq(entry.classId, eventClass.id))
    .innerJoin(person, eq(entry.driverPersonId, person.id))
    .innerJoin(vehicle, eq(entry.vehicleId, vehicle.id))
    .where(and(eq(entry.eventId, input.eventId)));

  const allowedIds = new Set(input.entryIds);
  return rows.filter((row) => allowedIds.has(row.entryId));
};

const storeDocument = async (
  eventId: string,
  entryId: string,
  driverPersonId: string,
  type: 'waiver' | 'tech_check',
  templateVariant: TechCheckVariant | null,
  templateVersion: string,
  pdfBuffer: Buffer,
  actorUserId: string | null
) => {
  const db = await getDb();
  const hash = createHash('sha256').update(pdfBuffer).digest('hex');
  const key = `documents/${eventId}/${entryId}/${type}/${templateVariant ?? 'none'}/${templateVersion}/${randomUUID()}.pdf`;

  await uploadPdf(key, pdfBuffer);

  const [docRow] = await db
    .insert(document)
    .values({
      eventId,
      entryId,
      driverPersonId,
      type,
      templateVariant,
      templateVersion,
      sha256: hash,
      s3Key: key,
      status: 'generated',
      createdBy: actorUserId
    })
    .returning();

  if (docRow) {
    await db.insert(documentGenerationJob).values({
      documentId: docRow.id,
      status: 'succeeded'
    });
  }

  await writeAuditLog(db as never, {
    eventId,
    actorUserId,
    action: 'document_generated',
    entityType: 'document',
    entityId: docRow?.id ?? null,
    payload: {
      type,
      entryId,
      templateVariant,
      templateVersion,
      sha256: hash,
      s3Key: key
    }
  });

  return docRow ? { ...docRow, templateVariant, templateVersion, sha256: hash } : null;
};

export const createWaiverDocument = async (input: DocumentRequest, actorUserId: string | null) => {
  await assertEventStatusAllowed(input.eventId, ['open', 'closed', 'archived']);
  const payload = await buildPayload(input);
  if (!payload) {
    return null;
  }

  const pdfBuffer = await renderWaiverPdf({
    event: payload.event,
    driver: payload.driver,
    codriver: payload.codriver,
    vehicle: payload.vehicle
  });

  return storeDocument(input.eventId, input.entryId, payload.driverPersonId, 'waiver', null, 'v1', pdfBuffer, actorUserId);
};

export const createTechCheckDocument = async (input: DocumentRequest, actorUserId: string | null) => {
  await assertEventStatusAllowed(input.eventId, ['open', 'closed', 'archived']);
  const payload = await buildPayload(input);
  if (!payload) {
    return null;
  }

  if (payload.vehicle.vehicleType !== 'auto' && payload.vehicle.vehicleType !== 'moto') {
    throw new Error('INVALID_VEHICLE_TYPE');
  }
  const templateVariant: TechCheckVariant = payload.vehicle.vehicleType;
  const pdfBuffer = await renderTechCheckPdf({
    event: payload.event,
    driver: payload.driver,
    vehicle: payload.vehicle,
    templateVariant
  });

  return storeDocument(
    input.eventId,
    input.entryId,
    payload.driverPersonId,
    'tech_check',
    templateVariant,
    'v1',
    pdfBuffer,
    actorUserId
  );
};

const createBatchDocument = async (
  input: BatchDocumentRequest,
  type: 'waiver_batch' | 'tech_check_batch',
  actorUserId: string | null
) => {
  await assertEventStatusAllowed(input.eventId, ['open', 'closed', 'archived']);
  const rows = await buildBatchPayload(input);
  if (rows.length === 0) {
    return null;
  }

  const pdfBuffer = await renderBatchDocumentPdf(
    type === 'waiver_batch' ? 'Haftverzicht Batch' : 'Technische Abnahme Batch',
    `Event ${input.eventId} - ${rows.length} Eintraege`,
    rows.map((row) => ({
      entryId: row.entryId,
      className: row.className,
      driverName: `${row.driverFirstName} ${row.driverLastName}`,
      vehicleSummary: `${row.vehicleType} ${row.vehicleMake ?? '-'} ${row.vehicleModel ?? '-'}`.trim(),
      startNumber: row.vehicleStartNumber ?? null
    }))
  );

  const db = await getDb();
  const hash = createHash('sha256').update(pdfBuffer).digest('hex');
  const key = `documents/${input.eventId}/batch/${type}/v1/${randomUUID()}.pdf`;
  await uploadPdf(key, pdfBuffer);

  const [docRow] = await db
    .insert(document)
    .values({
      eventId: input.eventId,
      entryId: null,
      driverPersonId: null,
      type,
      templateVariant: null,
      templateVersion: 'v1',
      sha256: hash,
      s3Key: key,
      status: 'generated',
      createdBy: actorUserId
    })
    .returning();

  if (docRow) {
    await db.insert(documentGenerationJob).values({
      documentId: docRow.id,
      status: 'succeeded'
    });
  }

  await writeAuditLog(db as never, {
    eventId: input.eventId,
    actorUserId,
    action: 'batch_document_generated',
    entityType: 'document',
    entityId: docRow?.id ?? null,
    payload: {
      type,
      count: rows.length,
      entryIds: input.entryIds
    }
  });

  return docRow ?? null;
};

export const createWaiverBatchDocument = async (input: BatchDocumentRequest, actorUserId: string | null) =>
  createBatchDocument(input, 'waiver_batch', actorUserId);

export const createTechCheckBatchDocument = async (input: BatchDocumentRequest, actorUserId: string | null) =>
  createBatchDocument(input, 'tech_check_batch', actorUserId);

export const getDocumentDownload = async (id: string, actorUserId: string | null) => {
  const db = await getDb();
  const rows = await db.select().from(document).where(eq(document.id, id));
  if (rows.length === 0) {
    return null;
  }
  const doc = rows[0];
  const url = await getPresignedDownloadUrl(doc.s3Key, 300);
  await writeAuditLog(db as never, {
    eventId: doc.eventId,
    actorUserId,
    action: 'document_download_url_issued',
    entityType: 'document',
    entityId: doc.id,
    payload: {
      expiresInSeconds: 300
    }
  });
  return { doc, url };
};

export const getOrCreateEntryDocumentDownload = async (
  input: DocumentRequest & { type: 'waiver' | 'tech_check' | 'entry_confirmation' },
  actorUserId: string | null
) => {
  const db = await getDb();
  if (input.type === 'entry_confirmation') {
    const attachment = await getOrCreateEntryConfirmationAttachment(input.eventId, input.entryId, actorUserId);
    return getDocumentDownload(attachment.documentId, actorUserId);
  }

  const existingRows = await db
    .select()
    .from(document)
    .where(and(eq(document.eventId, input.eventId), eq(document.entryId, input.entryId), eq(document.type, input.type)))
    .orderBy(desc(document.createdAt))
    .limit(1);

  let docId = existingRows[0]?.id;
  if (!docId) {
    const generated =
      input.type === 'waiver'
        ? await createWaiverDocument({ eventId: input.eventId, entryId: input.entryId }, actorUserId)
        : await createTechCheckDocument({ eventId: input.eventId, entryId: input.entryId }, actorUserId);
    if (!generated) {
      return null;
    }
    docId = generated.id;
  }

  return getDocumentDownload(docId, actorUserId);
};

export const validateDocumentRequest = (payload: unknown) => documentRequestSchema.parse(payload);
export const validateBatchDocumentRequest = (payload: unknown) => batchDocumentRequestSchema.parse(payload);
