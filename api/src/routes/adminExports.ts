import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, sql, SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import { writeAuditLog } from '../audit/log';
import { getDb } from '../db/client';
import { entry, event as eventTable, eventClass, exportJob, invoice, person, vehicle } from '../db/schema';
import { getPresignedDownloadUrl, uploadFile } from '../docs/storage';
import {
  getClassHeaders,
  getClassRowValues,
  getOverallRowValues,
  isClassSeven,
  OVERALL_HEADERS,
  ProgrammheftRow
} from '../domain/programmheftExport';
import { parseListQuery, paginateAndSortRows } from '../http/pagination';

const createExportSchema = z.object({
  eventId: z.string().uuid(),
  type: z.enum(['entries_csv', 'startlist_csv', 'participants_csv', 'payments_open_csv', 'checkin_status_csv', 'programmheft_xlsx']).default('participants_csv'),
  classId: z.string().uuid().optional(),
  acceptanceStatus: z.enum(['pending', 'shortlist', 'accepted', 'rejected', 'withdrawn']).optional(),
  paymentOpenOnly: z.boolean().optional(),
  checkinIdVerified: z.boolean().optional(),
  format: z.enum(['csv', 'xlsx']).default('csv')
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
    const conditions: SQL<unknown>[] = [
      eq(entry.eventId, input.eventId),
      sql`${entry.deletedAt} is null`,
      eq(person.processingRestricted, false),
      eq(person.objectionFlag, false)
    ];
    if (input.classId) {
      conditions.push(eq(entry.classId, input.classId));
    }
    if (input.acceptanceStatus) {
      conditions.push(eq(entry.acceptanceStatus, input.acceptanceStatus));
    } else if (input.type !== 'entries_csv') {
      conditions.push(eq(entry.acceptanceStatus, 'accepted'));
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

// ---------------------------------------------------------------------------
// Programmheft XLSX Export
// ---------------------------------------------------------------------------

const TITLE_BG = 'FF1F4E79';
const TITLE_FONT = 'FFFFFFFF';
const HEADER_BG = 'FFD9E1F2';
const ZEBRA_BG  = 'FFF2F2F2';

const buildClassSheet = (
  ws: ExcelJS.Worksheet,
  eventName: string,
  className: string,
  classRows: ProgrammheftRow[]
) => {
  const withCodriver = isClassSeven(className);
  const cols = getClassHeaders(className);
  const colWidths = withCodriver
    ? [10, 14, 16, 14, 16, 10, 22, 16, 18, 10, 10, 8]
    : [10, 14, 16, 10, 22, 16, 18, 10, 10, 8];
  const n = cols.length;

  // Row 1: Event title
  ws.mergeCells(1, 1, 1, n);
  const titleCell = ws.getCell(1, 1);
  titleCell.value = eventName;
  titleCell.font = { bold: true, size: 14, color: { argb: TITLE_FONT } };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TITLE_BG } };
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(1).height = 22;

  // Row 2: Class name
  ws.mergeCells(2, 1, 2, n);
  const classCell = ws.getCell(2, 1);
  classCell.value = className;
  classCell.font = { bold: true, size: 12 };
  classCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_BG } };
  classCell.alignment = { horizontal: 'left', vertical: 'middle' };
  ws.getRow(2).height = 18;

  // Row 3: Column headers
  const headerRow = ws.getRow(3);
  cols.forEach((h, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = h;
    cell.font = { bold: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_BG } };
    cell.border = { bottom: { style: 'thin' } };
  });
  headerRow.height = 16;

  // Data rows
  classRows.forEach((r, idx) => {
    const dataRow = ws.getRow(4 + idx);
    const values = getClassRowValues(r);
    values.forEach((v, i) => {
      dataRow.getCell(i + 1).value = v;
      if (idx % 2 === 1) {
        dataRow.getCell(i + 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ZEBRA_BG } };
      }
    });
    dataRow.getCell(withCodriver ? 6 : 4).numFmt = '@';
  });

  // Footer: starter count
  const countRowNum = 4 + classRows.length;
  ws.getCell(countRowNum, 1).value = classRows.length;
  ws.getCell(countRowNum, 2).value = 'Starter';
  ws.getCell(countRowNum, 1).font = { bold: true };
  ws.getCell(countRowNum, 2).font = { bold: true };

  // Column widths
  colWidths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
};

export const createProgrammheftExport = async (
  input: { eventId: string; classIds?: string[] },
  actorUserId: string | null
) => {
  const db = await getDb();
  const now = new Date();

  const [job] = await db
    .insert(exportJob)
    .values({
      eventId: input.eventId,
      type: 'programmheft_xlsx',
      filters: input,
      status: 'processing',
      createdBy: actorUserId,
      createdAt: now
    })
    .returning();

  if (!job) throw new Error('EXPORT_JOB_CREATE_FAILED');

  try {
    // Fetch event name
    const eventRows = await db
      .select({ name: eventTable.name })
      .from(eventTable)
      .where(eq(eventTable.id, input.eventId));
    const eventName = eventRows[0]?.name ?? 'MSC Event';

    // Aliases for driver and codriver person tables
    const driverPerson = alias(person, 'driver');
    const codriverPerson = alias(person, 'codriver');

    const rows = await db
      .select({
        startNumber: entry.startNumberNorm,
        className: eventClass.name,
        driverFirstName: driverPerson.firstName,
        driverLastName: driverPerson.lastName,
        driverZip: driverPerson.zip,
        driverCity: driverPerson.city,
        driverCountry: driverPerson.country,
        codriverFirstName: codriverPerson.firstName,
        codriverLastName: codriverPerson.lastName,
        vehicleMake: vehicle.make,
        vehicleModel: vehicle.model,
        vehicleYear: vehicle.year,
        vehicleDisplacement: vehicle.displacementCcm
      })
      .from(entry)
      .innerJoin(eventClass, eq(entry.classId, eventClass.id))
      .innerJoin(driverPerson, eq(entry.driverPersonId, driverPerson.id))
      .leftJoin(codriverPerson, eq(entry.codriverPersonId, codriverPerson.id))
      .leftJoin(vehicle, eq(entry.vehicleId, vehicle.id))
      .where(
        and(
          eq(entry.eventId, input.eventId),
          eq(entry.acceptanceStatus, 'accepted'),
          eq(driverPerson.processingRestricted, false),
          eq(driverPerson.objectionFlag, false),
          ...(input.classIds && input.classIds.length > 0 ? [inArray(entry.classId, input.classIds)] : [])
        )
      )
      .orderBy(
        asc(eventClass.name),
        sql`CASE WHEN ${entry.startNumberNorm} ~ '^[0-9]+$' THEN ${entry.startNumberNorm}::integer ELSE 999999 END`
      );

    // Group by class
    const byClass = new Map<string, { rows: typeof rows }>();
    for (const row of rows) {
      if (!byClass.has(row.className)) {
        byClass.set(row.className, { rows: [] });
      }
      byClass.get(row.className)!.rows.push(row);
    }

    // Build workbook
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'MSC Nennungstool';
    workbook.created = now;

    // Gesamtliste sheet
    const gesamtWs = workbook.addWorksheet('Gesamtliste');
    {
      const allCols = OVERALL_HEADERS;
      const n = allCols.length;

      gesamtWs.mergeCells(1, 1, 1, n);
      const tc = gesamtWs.getCell(1, 1);
      tc.value = eventName;
      tc.font = { bold: true, size: 14, color: { argb: TITLE_FONT } };
      tc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TITLE_BG } };
      tc.alignment = { horizontal: 'center', vertical: 'middle' };
      gesamtWs.getRow(1).height = 22;

      const hr = gesamtWs.getRow(2);
      allCols.forEach((h, i) => {
        const c = hr.getCell(i + 1);
        c.value = h;
        c.font = { bold: true };
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_BG } };
        c.border = { bottom: { style: 'thin' } };
      });

      rows.forEach((r, idx) => {
        const dr = gesamtWs.getRow(3 + idx);
        const vals = getOverallRowValues(r);
        vals.forEach((v, i) => {
          dr.getCell(i + 1).value = v;
          if (idx % 2 === 1) {
            dr.getCell(i + 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ZEBRA_BG } };
          }
        });
        dr.getCell(4).numFmt = '@';
      });

      [12, 14, 16, 12, 22, 16, 18, 10, 10, 18, 40].forEach((w, i) => { gesamtWs.getColumn(i + 1).width = w; });
    }

    // Per-class sheets
    for (const [className, { rows: classRows }] of byClass) {
      // Sheet names max 31 chars in Excel
      const sheetName = className.length > 31 ? className.slice(0, 31) : className;
      const ws = workbook.addWorksheet(sheetName);
      buildClassSheet(ws, eventName, className, classRows);
    }

    // Write to buffer and upload
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const key = `exports/${input.eventId}/programmheft_xlsx/${randomUUID()}.xlsx`;
    await uploadFile(
      key,
      buffer,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );

    const [updated] = await db
      .update(exportJob)
      .set({ status: 'succeeded', s3Key: key, completedAt: new Date() })
      .where(eq(exportJob.id, job.id))
      .returning();

    await writeAuditLog(db as never, {
      eventId: input.eventId,
      actorUserId,
      action: 'export_created',
      entityType: 'export_job',
      entityId: job.id,
      payload: { type: 'programmheft_xlsx', rowCount: rows.length }
    });

    return updated ?? job;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Export failed';
    await db
      .update(exportJob)
      .set({ status: 'failed', errorLast: message, completedAt: new Date() })
      .where(eq(exportJob.id, job.id));
    throw error;
  }
};
