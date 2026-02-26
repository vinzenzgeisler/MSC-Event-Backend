import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client';
import { emailOutbox, entry, event, eventClass, exportJob, invoice, person } from '../db/schema';

const dashboardSummaryQuerySchema = z.object({
  eventId: z.string().uuid()
});

const RECENT_ENTRIES_LIMIT = 10;

const toAgeYears = (birthdate: Date | string | null, referenceDate: Date): number | null => {
  if (!birthdate) {
    return null;
  }
  const date = birthdate instanceof Date ? birthdate : new Date(birthdate);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  let age = referenceDate.getUTCFullYear() - date.getUTCFullYear();
  const m = referenceDate.getUTCMonth() - date.getUTCMonth();
  if (m < 0 || (m === 0 && referenceDate.getUTCDate() < date.getUTCDate())) {
    age -= 1;
  }
  return age >= 0 ? age : null;
};

export const getDashboardSummary = async (eventId: string) => {
  const db = await getDb();

  const eventRows = await db.select({ id: event.id }).from(event).where(eq(event.id, eventId)).limit(1);
  if (eventRows.length === 0) {
    throw new Error('EVENT_NOT_FOUND');
  }

  const [
    entriesTotalRows,
    paymentsDueTotalRows,
    checkinPendingTotalRows,
    mailFailedTotalRows,
    mailQueuedTotalRows,
    exportsQueuedTotalRows,
    exportsProcessingTotalRows,
    classDistribution,
    recentEntryRows,
    driverAgeRows
  ] = await Promise.all([
    db
      .select({ value: sql<number>`count(*)::int` })
      .from(entry)
      .where(eq(entry.eventId, eventId)),
    db
      .select({ value: sql<number>`count(*)::int` })
      .from(invoice)
      .where(and(eq(invoice.eventId, eventId), eq(invoice.paymentStatus, 'due'))),
    db
      .select({ value: sql<number>`count(*)::int` })
      .from(entry)
      .where(and(eq(entry.eventId, eventId), eq(entry.checkinIdVerified, false))),
    db
      .select({ value: sql<number>`count(*)::int` })
      .from(emailOutbox)
      .where(and(eq(emailOutbox.eventId, eventId), eq(emailOutbox.status, 'failed'))),
    db
      .select({ value: sql<number>`count(*)::int` })
      .from(emailOutbox)
      .where(and(eq(emailOutbox.eventId, eventId), eq(emailOutbox.status, 'queued'))),
    db
      .select({ value: sql<number>`count(*)::int` })
      .from(exportJob)
      .where(and(eq(exportJob.eventId, eventId), eq(exportJob.status, 'queued'))),
    db
      .select({ value: sql<number>`count(*)::int` })
      .from(exportJob)
      .where(and(eq(exportJob.eventId, eventId), eq(exportJob.status, 'processing'))),
    db
      .select({
        classId: eventClass.id,
        className: eventClass.name,
        count: sql<number>`count(${entry.id})::int`
      })
      .from(eventClass)
      .leftJoin(entry, and(eq(entry.classId, eventClass.id), eq(entry.eventId, eventId)))
      .where(eq(eventClass.eventId, eventId))
      .groupBy(eventClass.id, eventClass.name)
      .orderBy(asc(eventClass.name)),
    db
      .select({
        entryId: entry.id,
        driverFirstName: person.firstName,
        driverLastName: person.lastName,
        className: eventClass.name,
        createdAt: entry.createdAt
      })
      .from(entry)
      .innerJoin(person, eq(entry.driverPersonId, person.id))
      .innerJoin(eventClass, eq(entry.classId, eventClass.id))
      .where(eq(entry.eventId, eventId))
      .orderBy(desc(entry.createdAt))
      .limit(RECENT_ENTRIES_LIMIT),
    db
      .select({
        driverFirstName: person.firstName,
        driverLastName: person.lastName,
        className: eventClass.name,
        birthdate: person.birthdate
      })
      .from(entry)
      .innerJoin(person, eq(entry.driverPersonId, person.id))
      .innerJoin(eventClass, eq(entry.classId, eventClass.id))
      .where(eq(entry.eventId, eventId))
  ]);

  const now = new Date();
  const ageRows = driverAgeRows
    .map((row) => ({
      age: toAgeYears(row.birthdate, now),
      driverLabel: `${row.driverFirstName} ${row.driverLastName}`.trim(),
      className: row.className
    }))
    .filter((row): row is { age: number; driverLabel: string; className: string } => row.age !== null);

  const sortedAgeRows = [...ageRows].sort((a, b) => a.age - b.age);
  const youngestDriverAge = sortedAgeRows.length > 0 ? sortedAgeRows[0].age : null;
  const oldestRow = sortedAgeRows.length > 0 ? sortedAgeRows[sortedAgeRows.length - 1] : null;
  const oldestDriverAge = oldestRow ? oldestRow.age : null;
  const oldestDriverLabel = oldestRow ? `${oldestRow.driverLabel} (${oldestRow.className})` : null;

  let medianDriverAge: number | null = null;
  if (sortedAgeRows.length > 0) {
    const mid = Math.floor(sortedAgeRows.length / 2);
    if (sortedAgeRows.length % 2 === 1) {
      medianDriverAge = sortedAgeRows[mid].age;
    } else {
      medianDriverAge = (sortedAgeRows[mid - 1].age + sortedAgeRows[mid].age) / 2;
    }
  }

  return {
    summary: {
      entriesTotal: entriesTotalRows[0]?.value ?? 0,
      paymentsDueTotal: paymentsDueTotalRows[0]?.value ?? 0,
      checkinPendingTotal: checkinPendingTotalRows[0]?.value ?? 0,
      mailFailedTotal: mailFailedTotalRows[0]?.value ?? 0,
      mailQueuedTotal: mailQueuedTotalRows[0]?.value ?? 0,
      exportsQueuedTotal: exportsQueuedTotalRows[0]?.value ?? 0,
      exportsProcessingTotal: exportsProcessingTotalRows[0]?.value ?? 0
    },
    driverAgeStats: {
      oldestDriverAge,
      oldestDriverLabel,
      youngestDriverAge,
      medianDriverAge
    },
    classDistribution,
    recentEntries: recentEntryRows.map((row) => ({
      entryId: row.entryId,
      driverName: `${row.driverFirstName} ${row.driverLastName}`.trim(),
      className: row.className,
      createdAt: row.createdAt
    }))
  };
};

export const validateDashboardSummaryQuery = (query: Record<string, string | undefined>) =>
  dashboardSummaryQuerySchema.parse({
    eventId: query.eventId
  });
