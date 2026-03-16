import { and, desc, eq, isNull } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { getDb } from '../db/client';
import { document, documentGenerationJob, entry, event, eventClass, eventPricingRule, invoice, person, vehicle } from '../db/schema';
import { renderEntryConfirmationPdf } from './pdf';
import { getAssetObjectBuffer, uploadPdf } from './storage';
import { writeAuditLog } from '../audit/log';

const ENTRY_CONFIRMATION_TEMPLATE_VERSION = 'v2';
const ENTRY_CONFIRMATION_TYPE = 'entry_confirmation';
const ENTRY_CONFIRMATION_FILE_NAME = 'Nennbestätigung.pdf';
const MAIL_LOGO_KEY = 'public/mail/msc-logo.png';

type EntryConfirmationPayload = {
  eventName: string;
  eventDateText: string;
  organizer: string;
  className: string;
  startNumber: string | null;
  driver: {
    fullName: string;
    street: string | null;
    zip: string | null;
    city: string | null;
    email: string | null;
    phone: string | null;
  };
  codriver: {
    fullName: string;
    birthdate: string | null;
  } | null;
  vehicle: {
    vehicleType: string;
    make: string | null;
    model: string | null;
    year: number | null;
    displacementCcm: number | null;
  };
  backupVehicle: {
    vehicleType: string;
    make: string | null;
    model: string | null;
    year: number | null;
    displacementCcm: number | null;
  } | null;
  payment: {
    totalFee: string;
    paidAmount: string;
    openAmount: string;
    paymentDeadline: string | null;
    paymentRecipient: string | null;
    paymentIban: string | null;
    paymentBic: string | null;
  };
  legalHint: string;
};

export type EntryConfirmationAttachmentRef = {
  documentId: string;
  fileName: string;
  contentType: 'application/pdf';
  s3Key: string;
  fileSizeBytes: number | null;
  source: 'document';
  revisionHash: string;
};

const formatCurrencyCents = (value: number | null | undefined): string => {
  const cents = Number.isFinite(value ?? NaN) ? Number(value) : 0;
  return `${(cents / 100).toFixed(2).replace('.', ',')} EUR`;
};

const formatDate = (value: string | Date | null | undefined): string | null => {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return new Intl.DateTimeFormat('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'Europe/Berlin'
  }).format(date);
};

const formatEventDateText = (startsAt: string | Date | null, endsAt: string | Date | null): string => {
  const start = formatDate(startsAt);
  const end = formatDate(endsAt);
  if (start && end) {
    return `${start} - ${end}`;
  }
  return start ?? end ?? '-';
};

const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`);
  return `{${entries.join(',')}}`;
};

export const buildEntryConfirmationRevisionHash = (payload: EntryConfirmationPayload): string =>
  createHash('sha256').update(stableStringify(payload)).digest('hex');

const buildPayload = async (eventId: string, entryId: string): Promise<{ payload: EntryConfirmationPayload; driverPersonId: string } | null> => {
  const db = await getDb();
  const rows = await db
    .select({
      eventName: event.name,
      eventStartsAt: event.startsAt,
      eventEndsAt: event.endsAt,
      eventContactEmail: event.contactEmail,
      className: eventClass.name,
      startNumber: entry.startNumberNorm,
      driverPersonId: entry.driverPersonId,
      codriverPersonId: entry.codriverPersonId,
      backupVehicleId: entry.backupVehicleId,
      driverFirstName: person.firstName,
      driverLastName: person.lastName,
      driverStreet: person.street,
      driverZip: person.zip,
      driverCity: person.city,
      driverEmail: person.email,
      driverPhone: person.phone,
      vehicleType: vehicle.vehicleType,
      vehicleMake: vehicle.make,
      vehicleModel: vehicle.model,
      vehicleYear: vehicle.year,
      vehicleDisplacement: vehicle.displacementCcm,
      totalCents: invoice.totalCents,
      paidAmountCents: invoice.paidAmountCents,
      paymentStatus: invoice.paymentStatus,
      earlyDeadline: eventPricingRule.earlyDeadline
    })
    .from(entry)
    .innerJoin(event, eq(entry.eventId, event.id))
    .innerJoin(eventClass, eq(entry.classId, eventClass.id))
    .innerJoin(person, eq(entry.driverPersonId, person.id))
    .leftJoin(vehicle, eq(entry.vehicleId, vehicle.id))
    .leftJoin(invoice, and(eq(invoice.eventId, entry.eventId), eq(invoice.driverPersonId, entry.driverPersonId)))
    .leftJoin(eventPricingRule, eq(eventPricingRule.eventId, entry.eventId))
    .where(and(eq(entry.id, entryId), eq(entry.eventId, eventId), isNull(entry.deletedAt)))
    .limit(1);

  if (!rows[0]) {
    return null;
  }

  const row = rows[0];

  const codriverRow = row.codriverPersonId
    ? (
        await db
          .select({
            firstName: person.firstName,
            lastName: person.lastName,
            birthdate: person.birthdate
          })
          .from(person)
          .where(eq(person.id, row.codriverPersonId))
          .limit(1)
      )[0]
    : null;

  const backupVehicleRow = row.backupVehicleId
    ? (
        await db
          .select({
            vehicleType: vehicle.vehicleType,
            make: vehicle.make,
            model: vehicle.model,
            year: vehicle.year,
            displacementCcm: vehicle.displacementCcm
          })
          .from(vehicle)
          .where(eq(vehicle.id, row.backupVehicleId))
          .limit(1)
      )[0]
    : null;

  const totalCents = row.totalCents ?? 0;
  const paidAmountCents = row.paidAmountCents ?? (row.paymentStatus === 'paid' ? totalCents : 0);
  const openAmountCents = Math.max(0, totalCents - paidAmountCents);
  const organizer = (process.env.MAIL_BRAND_NAME ?? 'MSC Oberlausitzer Dreiländereck e.V.').trim();
  const legalHint =
    'Dieses Dokument gilt als Nennbestätigung und Fahrerlager-Nachweis. Bitte bei der Veranstaltung bereithalten.';

  return {
    driverPersonId: row.driverPersonId,
    payload: {
      eventName: row.eventName,
      eventDateText: formatEventDateText(row.eventStartsAt, row.eventEndsAt),
      organizer,
      className: row.className,
      startNumber: row.startNumber ?? null,
      driver: {
        fullName: `${row.driverFirstName} ${row.driverLastName}`.trim(),
        street: row.driverStreet ?? null,
        zip: row.driverZip ?? null,
        city: row.driverCity ?? null,
        email: row.driverEmail ?? null,
        phone: row.driverPhone ?? null
      },
      codriver: codriverRow
        ? {
            fullName: `${codriverRow.firstName} ${codriverRow.lastName}`.trim(),
            birthdate: formatDate(codriverRow.birthdate)
          }
        : null,
      vehicle: {
        vehicleType: row.vehicleType ?? '-',
        make: row.vehicleMake ?? null,
        model: row.vehicleModel ?? null,
        year: row.vehicleYear ?? null,
        displacementCcm: row.vehicleDisplacement ?? null
      },
      backupVehicle: backupVehicleRow
        ? {
            vehicleType: backupVehicleRow.vehicleType ?? '-',
            make: backupVehicleRow.make ?? null,
            model: backupVehicleRow.model ?? null,
            year: backupVehicleRow.year ?? null,
            displacementCcm: backupVehicleRow.displacementCcm ?? null
          }
        : null,
      payment: {
        totalFee: formatCurrencyCents(totalCents),
        paidAmount: formatCurrencyCents(paidAmountCents),
        openAmount: formatCurrencyCents(openAmountCents),
        paymentDeadline: formatDate(row.earlyDeadline),
        paymentRecipient: (process.env.PAYMENT_RECIPIENT ?? '').trim() || row.eventContactEmail || null,
        paymentIban: (process.env.PAYMENT_IBAN ?? '').trim() || null,
        paymentBic: (process.env.PAYMENT_BIC ?? '').trim() || null
      },
      legalHint
    }
  };
};

export const getOrCreateEntryConfirmationAttachment = async (
  eventId: string,
  entryId: string,
  actorUserId: string | null
): Promise<EntryConfirmationAttachmentRef> => {
  const built = await buildPayload(eventId, entryId);
  if (!built) {
    throw new Error('ENTRY_NOT_FOUND');
  }
  const db = await getDb();
  const revisionHash = buildEntryConfirmationRevisionHash(built.payload);

  const existing = await db
    .select({
      id: document.id,
      s3Key: document.s3Key
    })
    .from(document)
    .where(
      and(
        eq(document.eventId, eventId),
        eq(document.entryId, entryId),
        eq(document.type, ENTRY_CONFIRMATION_TYPE),
        eq(document.templateVersion, ENTRY_CONFIRMATION_TEMPLATE_VERSION),
        eq(document.templateVariant, revisionHash),
        eq(document.status, 'generated')
      )
    )
    .orderBy(desc(document.createdAt))
    .limit(1);

  if (existing[0]) {
    return {
      documentId: existing[0].id,
      fileName: ENTRY_CONFIRMATION_FILE_NAME,
      contentType: 'application/pdf',
      s3Key: existing[0].s3Key,
      fileSizeBytes: null,
      source: 'document',
      revisionHash
    };
  }

  const logoImage = await getAssetObjectBuffer(MAIL_LOGO_KEY);
  const pdfBuffer = await renderEntryConfirmationPdf({
    ...built.payload,
    logoImage
  });
  const pdfSha256 = createHash('sha256').update(pdfBuffer).digest('hex');
  const s3Key = `documents/${eventId}/${entryId}/entry_confirmation/${revisionHash}/${ENTRY_CONFIRMATION_TEMPLATE_VERSION}/${randomUUID()}.pdf`;
  await uploadPdf(s3Key, pdfBuffer);

  const inserted = await db
    .insert(document)
    .values({
      eventId,
      entryId,
      driverPersonId: built.driverPersonId,
      type: ENTRY_CONFIRMATION_TYPE,
      templateVariant: revisionHash,
      templateVersion: ENTRY_CONFIRMATION_TEMPLATE_VERSION,
      sha256: pdfSha256,
      s3Key,
      status: 'generated',
      createdBy: actorUserId
    })
    .returning({ id: document.id });

  const documentId = inserted[0]?.id;
  if (!documentId) {
    throw new Error('ENTRY_CONFIRMATION_DOCUMENT_INSERT_FAILED');
  }

  await db.insert(documentGenerationJob).values({
    documentId,
    status: 'succeeded'
  });

  await writeAuditLog(db as never, {
    eventId,
    actorUserId,
    action: 'document_generated',
    entityType: 'document',
    entityId: documentId,
    payload: {
      entryId,
      type: ENTRY_CONFIRMATION_TYPE,
      templateVersion: ENTRY_CONFIRMATION_TEMPLATE_VERSION,
      revisionHash
    }
  });

  return {
    documentId,
    fileName: ENTRY_CONFIRMATION_FILE_NAME,
    contentType: 'application/pdf',
    s3Key,
    fileSizeBytes: pdfBuffer.length,
    source: 'document',
    revisionHash
  };
};
