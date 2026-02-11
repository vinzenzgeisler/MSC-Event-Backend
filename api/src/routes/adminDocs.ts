import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { getDb } from '../db/client';
import { document, documentGenerationJob, entry, event, eventClass, person, vehicle } from '../db/schema';
import { writeAuditLog } from '../audit/log';
import { renderTechCheckPdf, renderWaiverPdf } from '../docs/pdf';
import { uploadPdf, getPresignedDownloadUrl } from '../docs/storage';

const documentRequestSchema = z.object({
  eventId: z.string().uuid(),
  entryId: z.string().uuid()
});

type DocumentRequest = z.infer<typeof documentRequestSchema>;

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
      driverNationality: person.nationality,
      driverStreet: person.street,
      driverZip: person.zip,
      driverCity: person.city,
      driverPhone: person.phone,
      codriverFirstName: person.firstName,
      codriverLastName: person.lastName,
      codriverBirthdate: person.birthdate,
      codriverNationality: person.nationality,
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
      nationality: row.driverNationality ?? null,
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

const storeDocument = async (
  eventId: string,
  entryId: string,
  driverPersonId: string,
  type: 'waiver' | 'tech_check',
  pdfBuffer: Buffer,
  actorUserId: string | null
) => {
  const db = await getDb();
  const hash = createHash('sha256').update(pdfBuffer).digest('hex');
  const key = `documents/${eventId}/${type}/${randomUUID()}.pdf`;

  await uploadPdf(key, pdfBuffer);

  const [docRow] = await db
    .insert(document)
    .values({
      eventId,
      entryId,
      driverPersonId,
      type,
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
    eventId,
    actorUserId,
    action: 'document_generated',
    entityType: 'document',
    entityId: docRow?.id ?? null,
    payload: {
      type,
      entryId
    }
  });

  return docRow;
};

export const createWaiverDocument = async (input: DocumentRequest, actorUserId: string | null) => {
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

  return storeDocument(input.eventId, input.entryId, payload.driverPersonId, 'waiver', pdfBuffer, actorUserId);
};

export const createTechCheckDocument = async (input: DocumentRequest, actorUserId: string | null) => {
  const payload = await buildPayload(input);
  if (!payload) {
    return null;
  }

  const pdfBuffer = await renderTechCheckPdf({
    event: payload.event,
    driver: payload.driver,
    vehicle: payload.vehicle
  });

  return storeDocument(input.eventId, input.entryId, payload.driverPersonId, 'tech_check', pdfBuffer, actorUserId);
};

export const getDocumentDownload = async (id: string) => {
  const db = await getDb();
  const rows = await db.select().from(document).where(eq(document.id, id));
  if (rows.length === 0) {
    return null;
  }
  const doc = rows[0];
  const url = await getPresignedDownloadUrl(doc.s3Key, 300);
  return { doc, url };
};

export const validateDocumentRequest = (payload: unknown) => documentRequestSchema.parse(payload);
