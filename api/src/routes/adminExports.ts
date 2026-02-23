import { randomUUID } from 'node:crypto';
import { and, asc, eq, SQL } from 'drizzle-orm';
import { z } from 'zod';
import { writeAuditLog } from '../audit/log';
import { getDb } from '../db/client';
import { entry, eventClass, exportJob, invoice, person } from '../db/schema';
import { getPresignedDownloadUrl, uploadFile } from '../docs/storage';
import { parseListQuery, paginateAndSortRows } from '../http/pagination';

const createExportSchema = z.object({
  eventId: z.string().uuid(),
  type: z.enum(['entries_csv', 'startlist_csv', 'participants_csv', 'payments_open_csv', 'checkin_status_csv']).default('participants_csv'),
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
      type: input.type,
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
        techStatus: entry.techStatus,
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

    const mappedRowsBase = rows.map((row) => ({
      entryId: row.entryId,
      className: row.className,
      registrationStatus: row.registrationStatus,
      acceptanceStatus: row.acceptanceStatus,
      paymentStatus: row.paymentStatus ?? 'none',
      checkinIdVerified: row.checkinIdVerified ? 'true' : 'false',
      techStatus: row.techStatus,
      startNumber: row.startNumberNorm ?? '',
      driverName: redactSensitiveFields ? '' : `${row.driverFirstName} ${row.driverLastName}`,
      driverEmail: redactSensitiveFields ? '' : (row.driverEmail ?? '')
    }));

    const typedRows =
      input.type === 'startlist_csv'
        ? mappedRowsBase.map((row) => ({
            className: row.className,
            startNumber: row.startNumber,
            driverName: row.driverName
          }))
        : input.type === 'payments_open_csv'
          ? mappedRowsBase
              .filter((row) => row.paymentStatus === 'due')
              .map((row) => ({
                entryId: row.entryId,
                className: row.className,
                driverName: row.driverName,
                driverEmail: row.driverEmail,
                paymentStatus: row.paymentStatus
              }))
          : input.type === 'checkin_status_csv'
            ? mappedRowsBase.map((row) => ({
                entryId: row.entryId,
                className: row.className,
                driverName: row.driverName,
                checkinIdVerified: row.checkinIdVerified,
                techStatus: row.techStatus,
                acceptanceStatus: row.acceptanceStatus
              }))
            : mappedRowsBase;

    const headers = Object.keys(typedRows[0] ?? { entryId: '', className: '', driverName: '' });
    const csv = toCsv(headers, typedRows);
    const key = `exports/${input.eventId}/${input.type}/${randomUUID()}.csv`;
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
        type: input.type,
        rowCount: typedRows.length,
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

export const listExportJobs = async (
  eventId: string,
  query?: { cursor?: string; limit?: number; sortBy?: string; sortDir?: 'asc' | 'desc' }
) => {
  const db = await getDb();
  const rows = await db
    .select()
    .from(exportJob)
    .where(eq(exportJob.eventId, eventId))
    .orderBy(asc(exportJob.createdAt));
  const paginationQuery = parseListQuery(
    {
      cursor: query?.cursor,
      limit: query?.limit?.toString(),
      sortBy: query?.sortBy,
      sortDir: query?.sortDir
    },
    ['createdAt', 'completedAt', 'status', 'type'],
    'createdAt',
    'asc'
  );
  return paginateAndSortRows(rows, paginationQuery);
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
