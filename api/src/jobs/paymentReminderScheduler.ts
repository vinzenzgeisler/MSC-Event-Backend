import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import { entry, invoice } from '../db/schema';
import { DuplicateRequestError, queuePaymentReminders } from '../routes/adminMail';

type ReminderCandidateRow = {
  eventId: string;
  entryId: string;
};

const listReminderCandidates = async (): Promise<ReminderCandidateRow[]> => {
  const db = await getDb();
  return db
    .select({
      eventId: entry.eventId,
      entryId: entry.id
    })
    .from(entry)
    .innerJoin(invoice, and(eq(invoice.eventId, entry.eventId), eq(invoice.driverPersonId, entry.driverPersonId)))
    .where(
      and(
        sql`${entry.deletedAt} is null`,
        eq(entry.acceptanceStatus, 'accepted'),
        eq(invoice.paymentStatus, 'due')
      )
    );
};

export const handler = async () => {
  const rows = await listReminderCandidates();
  let queued = 0;
  let skipped = 0;

  for (const row of rows) {
    try {
      const result = await queuePaymentReminders(
        {
          eventId: row.eventId,
          entryId: row.entryId,
          allowDuplicate: false,
          templateId: 'payment_reminder'
        },
        null
      );
      queued += result.queued;
      skipped += result.skipped;
    } catch (error) {
      if (error instanceof DuplicateRequestError) {
        skipped += 1;
        continue;
      }
      throw error;
    }
  }

  return { queued, skipped };
};
