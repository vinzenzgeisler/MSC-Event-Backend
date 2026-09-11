import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import archiver from 'archiver';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { writeAuditLog } from '../audit/log';
import { getDb } from '../db/client';
import { consentEvidence, entry, event, eventClass, exportJob, person, vehicle } from '../db/schema';
import { renderPaperWaiverPdf } from '../docs/pdf';
import { deleteDocumentObject, getPresignedDownloadUrl, uploadFile } from '../docs/storage';
import { buildPaperWaiverContract, PAPER_WAIVER_VERSION } from '../legal/paperWaiverContract';
import type { WaiverLocale } from '../legal/waiverContract';
import { loadWaiverPdfFonts, loadWaiverPdfLogo } from './adminSigning';

const exportSchema = z.object({
  eventId: z.string().uuid()
});

export type WaiverPaperExportInput = z.infer<typeof exportSchema>;

export const validateWaiverPaperExportInput = (payload: unknown) => exportSchema.parse(payload);

const ageAt = (birthdate: string | null, date: Date): number | null => {
  if (!birthdate) return null;
  const match = birthdate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  let age = date.getUTCFullYear() - year;
  const currentMonth = date.getUTCMonth() + 1;
  const currentDay = date.getUTCDate();
  if (currentMonth < month || (currentMonth === month && currentDay < day)) {
    age -= 1;
  }
  return age;
};

const normalizeConsentLocale = (value: string | null | undefined): WaiverLocale => {
  if (value === 'en-GB' || value === 'en' || value === 'en-US') return 'en-GB';
  if (value === 'cs-CZ' || value === 'cs' || value === 'cz') return 'cs-CZ';
  if (value === 'pl-PL' || value === 'pl') return 'pl-PL';
  return 'de-DE';
};

const naturalCompare = (a: string, b: string) => a.localeCompare(b, 'de', { numeric: true, sensitivity: 'base' });

const sanitizeFilenamePart = (value: string): string =>
  value.normalize('NFKD').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'fahrer';

export const createWaiverPaperExport = async (input: WaiverPaperExportInput, actorUserId: string | null) => {
  const db = await getDb();
  const [eventRow] = await db
    .select({ id: event.id, name: event.name, startsAt: event.startsAt, endsAt: event.endsAt })
    .from(event)
    .where(eq(event.id, input.eventId))
    .limit(1);
  if (!eventRow) throw new Error('EVENT_NOT_FOUND');

  const backupVehicle = alias(vehicle, 'waiver_paper_backup_vehicle');
  const entryRows = await db
    .select({
      entryId: entry.id,
      driverPersonId: entry.driverPersonId,
      driverFirstName: person.firstName,
      driverLastName: person.lastName,
      driverBirthdate: person.birthdate,
      className: eventClass.name,
      startNumber: entry.startNumberNorm,
      orgaCode: entry.orgaCode,
      vehicleMake: vehicle.make,
      vehicleModel: vehicle.model,
      vehicleYear: vehicle.year,
      backupVehicleId: entry.backupVehicleId,
      backupVehicleMake: backupVehicle.make,
      backupVehicleModel: backupVehicle.model,
      backupVehicleYear: backupVehicle.year
    })
    .from(entry)
    .innerJoin(person, eq(entry.driverPersonId, person.id))
    .innerJoin(eventClass, eq(entry.classId, eventClass.id))
    .innerJoin(vehicle, eq(entry.vehicleId, vehicle.id))
    .leftJoin(backupVehicle, eq(entry.backupVehicleId, backupVehicle.id))
    .where(and(eq(entry.eventId, input.eventId), eq(entry.acceptanceStatus, 'accepted'), sql`${entry.deletedAt} is null`))
    .orderBy(asc(eventClass.name), asc(entry.startNumberNorm));

  if (entryRows.length === 0) throw new Error('WAIVER_PAPER_EXPORT_NO_ENTRIES');

  const entryIds = entryRows.map((row) => row.entryId);
  const consentRows = entryIds.length > 0
    ? await db
        .select({ entryId: consentEvidence.entryId, locale: consentEvidence.locale, capturedAt: consentEvidence.capturedAt })
        .from(consentEvidence)
        .where(inArray(consentEvidence.entryId, entryIds))
        .orderBy(asc(consentEvidence.capturedAt))
    : [];
  const localeByEntryId = new Map<string, string | null>();
  for (const row of consentRows) {
    localeByEntryId.set(row.entryId, row.locale);
  }

  type DriverGroup = {
    driverPersonId: string;
    firstName: string;
    lastName: string;
    birthdate: string | null;
    locale: string | null;
    entries: Array<{
      className: string;
      orgaCode: string | null;
      startNumber: string | null;
      vehicles: Array<{ role: 'primary' | 'backup'; make: string; model: string; year: number | null; startNumber: string | null }>;
    }>;
  };

  const drivers = new Map<string, DriverGroup>();
  for (const row of entryRows) {
    const driver = drivers.get(row.driverPersonId) ?? {
      driverPersonId: row.driverPersonId,
      firstName: row.driverFirstName,
      lastName: row.driverLastName,
      birthdate: row.driverBirthdate?.toString() ?? null,
      locale: null,
      entries: []
    };
    driver.locale = driver.locale ?? localeByEntryId.get(row.entryId) ?? null;
    const vehicles: DriverGroup['entries'][number]['vehicles'] = [
      { role: 'primary', make: row.vehicleMake ?? '-', model: row.vehicleModel ?? '-', year: row.vehicleYear, startNumber: row.startNumber }
    ];
    if (row.backupVehicleId) {
      vehicles.push({ role: 'backup', make: row.backupVehicleMake ?? '-', model: row.backupVehicleModel ?? '-', year: row.backupVehicleYear, startNumber: row.startNumber });
    }
    driver.entries.push({ className: row.className, orgaCode: row.orgaCode, startNumber: row.startNumber, vehicles });
    drivers.set(row.driverPersonId, driver);
  }

  const eventStart = new Date(`${eventRow.startsAt}T12:00:00.000Z`);
  const sortedDrivers = Array.from(drivers.values()).sort((a, b) =>
    naturalCompare(`${a.lastName} ${a.firstName}`, `${b.lastName} ${b.firstName}`)
  );

  const [job] = await db.insert(exportJob).values({
    eventId: input.eventId,
    type: 'waiver_paper_zip',
    filters: input,
    status: 'processing',
    createdBy: actorUserId,
    createdAt: new Date()
  }).returning();
  if (!job) throw new Error('EXPORT_JOB_CREATE_FAILED');

  let unfinalizedS3Key: string | null = null;
  try {
    const [fonts, logoImage] = await Promise.all([
      loadWaiverPdfFonts().catch(() => null),
      loadWaiverPdfLogo().catch(() => null)
    ]);
    const archive = archiver('zip', { zlib: { level: 9 } });
    const zipChunks: Buffer[] = [];
    const zipDone = new Promise<Buffer>((resolve, reject) => {
      archive.on('data', (chunk: Buffer) => zipChunks.push(chunk));
      archive.on('end', () => resolve(Buffer.concat(zipChunks)));
      archive.on('error', reject);
    });

    const usedNames = new Set<string>();
    for (const driver of sortedDrivers) {
      const locale = normalizeConsentLocale(driver.locale);
      const age = ageAt(driver.birthdate, eventStart);
      const pdfBuffer = await renderPaperWaiverPdf({
        event: { name: eventRow.name, startsAt: eventRow.startsAt?.toString() ?? '', endsAt: eventRow.endsAt?.toString() ?? '', location: 'MSC Oberlausitzer Dreiländereck' },
        driver: { firstName: driver.firstName, lastName: driver.lastName, birthdate: driver.birthdate },
        isMinor: age !== null && age < 18,
        requiresMedicalCertificate: age !== null && age >= 70,
        contract: buildPaperWaiverContract(locale),
        entries: driver.entries.map((item) => ({ className: item.className, orgaCode: item.orgaCode, startNumber: item.startNumber, codriver: null, vehicles: item.vehicles })),
        fonts: fonts ?? undefined,
        logoImage
      });

      const baseName = sanitizeFilenamePart(`${driver.lastName}_${driver.firstName}`);
      let filename = `${baseName}.pdf`;
      let suffix = 2;
      while (usedNames.has(filename)) {
        filename = `${baseName}_${suffix}.pdf`;
        suffix += 1;
      }
      usedNames.add(filename);
      archive.append(pdfBuffer, { name: filename });
    }

    void archive.finalize();
    const zipBuffer = await zipDone;

    const filename = `haftverzicht-papierfallback-${eventRow.startsAt?.toString().slice(0, 4) ?? 'event'}.zip`;
    const s3Key = `exports/${input.eventId}/waiver-paper/${randomUUID()}.zip`;
    await uploadFile(s3Key, zipBuffer, 'application/zip');
    unfinalizedS3Key = s3Key;

    await db.update(exportJob).set({ status: 'succeeded', s3Key, completedAt: new Date() }).where(eq(exportJob.id, job.id));
    unfinalizedS3Key = null;

    const downloadUrl = await getPresignedDownloadUrl(s3Key, 300, filename);
    await writeAuditLog(db as never, {
      eventId: input.eventId,
      actorUserId,
      action: 'waiver_paper_export_created',
      entityType: 'event',
      entityId: input.eventId,
      payload: { driverCount: sortedDrivers.length, version: PAPER_WAIVER_VERSION }
    });
    return { downloadUrl, filename, driverCount: sortedDrivers.length };
  } catch (error) {
    if (unfinalizedS3Key) {
      await deleteDocumentObject(unfinalizedS3Key).catch(() => undefined);
    }
    const message = error instanceof Error ? error.message : 'Waiver paper export failed';
    await db.update(exportJob).set({ status: 'failed', errorLast: message, completedAt: new Date() }).where(and(eq(exportJob.id, job.id), eq(exportJob.status, 'processing')));
    throw error;
  }
};
