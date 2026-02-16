import { randomUUID } from 'node:crypto';
import { and, asc, eq, SQL } from 'drizzle-orm';
import { z } from 'zod';
import { writeAuditLog } from '../audit/log';
import { getDb } from '../db/client';
import { entry, eventClass, exportJob, invoice, person } from '../db/schema';
import { getPresignedDownloadUrl, uploadFile } from '../docs/storage';

const createExportSchema = z.object({
  eventId: z.string().uuid(),
  classId: z.string().uuid().optional(),
  acceptanceStatus: z.enum(['pending', 'shortlist', 'accepted', 'rejected']).optional(),
  paymentOpenOnly: z.boolean().optional(),
  checkinIdVerified: z.boolean().optional(),
  format: z.enum(['csv']).default('csv')
});

type CreateExportInput = z.infer<typeof createExportSchema>;

const escapeCsv = (value: unknown): string => {
  const raw = value === null || value === undefined ? '' : String(value);
  if (raw.includes(',') || raw.includes('"') || raw.includes('\n')) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
};

const toCsv = (headers: string[], rows: Array<Record<string, unknown>>): string => {
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((header) => escapeCsv(row[header])).join(','));
  }
  return `${lines.join('\n')}\n`;
};

export const createEntriesExport = async (
  input: CreateExportInput,
  actorUserId: string | null,
  redactSensitiveFields: boolean
) => {
  const db = await getDb();
  const now = new Date();
  const [job] = await db
    .insert(exportJob)
    .values({
      eventId: input.eventId,
      type: 'entries_csv',
      filters: input,
      status: 'processing',
      createdBy: actorUserId,
      createdAt: now
    })
    .returning();

  if (!job) {
    throw new Error('EXPORT_JOB_CREATE_FAILED');
  }

  try {
    const conditions: SQL<unknown>[] = [eq(entry.eventId, input.eventId)];
    if (input.classId) {
      conditions.push(eq(entry.classId, input.classId));
    }
    if (input.acceptanceStatus) {
      conditions.push(eq(entry.acceptanceStatus, input.acceptanceStatus));
    }
    if (input.checkinIdVerified !== undefined) {
      conditions.push(eq(entry.checkinIdVerified, input.checkinIdVerified));
    }
    if (input.paymentOpenOnly) {
      conditions.push(eq(invoice.paymentStatus, 'due'));
    }

    const rows = await db
      .select({
        entryId: entry.id,
        className: eventClass.name,
        registrationStatus: entry.registrationStatus,
        acceptanceStatus: entry.acceptanceStatus,
        paymentStatus: invoice.paymentStatus,
        checkinIdVerified: entry.checkinIdVerified,
        startNumberNorm: entry.startNumberNorm,
        driverFirstName: person.firstName,
        driverLastName: person.lastName,
        driverEmail: person.email
      })
      .from(entry)
      .innerJoin(eventClass, eq(entry.classId, eventClass.id))
      .innerJoin(person, eq(entry.driverPersonId, person.id))
      .leftJoin(invoice, and(eq(invoice.eventId, entry.eventId), eq(invoice.driverPersonId, entry.driverPersonId)))
      .where(and(...conditions))
      .orderBy(asc(eventClass.name), asc(entry.createdAt));

    const mappedRows = rows.map((row) => ({
      entryId: row.entryId,
      className: row.className,
      registrationStatus: row.registrationStatus,
      acceptanceStatus: row.acceptanceStatus,
      paymentStatus: row.paymentStatus ?? 'none',
      checkinIdVerified: row.checkinIdVerified ? 'true' : 'false',
      startNumber: row.startNumberNorm ?? '',
      driverName: redactSensitiveFields ? '' : `${row.driverFirstName} ${row.driverLastName}`,
      driverEmail: redactSensitiveFields ? '' : (row.driverEmail ?? '')
    }));

    const headers = [
      'entryId',
      'className',
      'registrationStatus',
      'acceptanceStatus',
      'paymentStatus',
      'checkinIdVerified',
      'startNumber',
      'driverName',
      'driverEmail'
    ];
    const csv = toCsv(headers, mappedRows);
    const key = `exports/${input.eventId}/entries_csv/${randomUUID()}.csv`;
    await uploadFile(key, Buffer.from(csv, 'utf8'), 'text/csv; charset=utf-8');

    const [updated] = await db
      .update(exportJob)
      .set({
        status: 'succeeded',
        s3Key: key,
        completedAt: new Date()
      })
      .where(eq(exportJob.id, job.id))
      .returning();

    await writeAuditLog(db as never, {
      eventId: input.eventId,
      actorUserId,
      action: 'export_created',
      entityType: 'export_job',
      entityId: job.id,
      payload: {
        type: 'entries_csv',
        rowCount: mappedRows.length,
        redacted: redactSensitiveFields
      }
    });

    return updated ?? job;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Export failed';
    await db
      .update(exportJob)
      .set({
        status: 'failed',
        errorLast: message,
        completedAt: new Date()
      })
      .where(eq(exportJob.id, job.id));
    throw error;
  }
};

export const getExportJob = async (id: string) => {
  const db = await getDb();
  const rows = await db.select().from(exportJob).where(eq(exportJob.id, id));
  return rows[0] ?? null;
};

export const getExportDownload = async (id: string, actorUserId: string | null) => {
  const db = await getDb();
  const rows = await db.select().from(exportJob).where(eq(exportJob.id, id));
  if (rows.length === 0) {
    return null;
  }
  const job = rows[0];
  if (!job.s3Key || job.status !== 'succeeded') {
    throw new Error('EXPORT_NOT_READY');
  }
  const url = await getPresignedDownloadUrl(job.s3Key, 300);

  await writeAuditLog(db as never, {
    eventId: job.eventId,
    actorUserId,
    action: 'export_download_url_issued',
    entityType: 'export_job',
    entityId: job.id,
    payload: {
      expiresInSeconds: 300
    }
  });

  return { job, url };
};

export const validateCreateExportInput = (payload: unknown) => createExportSchema.parse(payload);
