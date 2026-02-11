import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../db/client';
import { emailOutbox, entry, invoice, person } from '../db/schema';
import { isPgUniqueViolation } from '../http/dbErrors';
import { writeAuditLog } from '../audit/log';

const queueMailSchema = z
  .object({
    eventId: z.string().uuid(),
    templateId: z.string().min(1),
    subject: z.string().min(1),
    templateData: z.record(z.unknown()).optional(),
    sendAfter: z.string().datetime().optional(),
    recipientEmails: z.array(z.string().email()).optional(),
    driverPersonIds: z.array(z.string().uuid()).optional(),
    entryIds: z.array(z.string().uuid()).optional(),
    filters: z
      .object({
        acceptanceStatus: z.enum(['pending', 'shortlist', 'accepted', 'rejected']).optional(),
        registrationStatus: z.enum(['submitted_unverified', 'submitted_verified']).optional(),
        paymentStatus: z.enum(['due', 'paid']).optional(),
        classId: z.string().uuid().optional()
      })
      .optional()
  })
  .refine(
    (value) =>
      (value.recipientEmails && value.recipientEmails.length > 0) ||
      (value.driverPersonIds && value.driverPersonIds.length > 0) ||
      (value.entryIds && value.entryIds.length > 0) ||
      value.filters,
    { message: 'Provide recipientEmails, driverPersonIds, entryIds, or filters.' }
  );

const reminderSchema = z.object({
  eventId: z.string().uuid(),
  templateId: z.string().min(1),
  subject: z.string().min(1),
  templateData: z.record(z.unknown()).optional(),
  sendAfter: z.string().datetime().optional()
});

type QueueMailInput = z.infer<typeof queueMailSchema>;
type ReminderInput = z.infer<typeof reminderSchema>;

const dedupeEmails = (emails: (string | null | undefined)[]): string[] => {
  const set = new Set<string>();
  emails.forEach((email) => {
    if (!email) {
      return;
    }
    const trimmed = email.trim();
    if (!trimmed) {
      return;
    }
    set.add(trimmed);
  });
  return Array.from(set);
};

const resolveEmails = async (input: QueueMailInput): Promise<string[]> => {
  const db = await getDb();

  if (input.recipientEmails) {
    return dedupeEmails(input.recipientEmails);
  }

  if (input.driverPersonIds) {
    const rows = await db
      .select({ email: person.email })
      .from(person)
      .where(inArray(person.id, input.driverPersonIds));
    return dedupeEmails(rows.map((row) => row.email));
  }

  if (input.entryIds) {
    const rows = await db
      .select({ email: person.email })
      .from(entry)
      .innerJoin(person, eq(entry.driverPersonId, person.id))
      .where(inArray(entry.id, input.entryIds));
    return dedupeEmails(rows.map((row) => row.email));
  }

  if (input.filters) {
    const conditions = [eq(entry.eventId, input.eventId)];
    if (input.filters.acceptanceStatus) {
      conditions.push(eq(entry.acceptanceStatus, input.filters.acceptanceStatus));
    }
    if (input.filters.registrationStatus) {
      conditions.push(eq(entry.registrationStatus, input.filters.registrationStatus));
    }
    if (input.filters.classId) {
      conditions.push(eq(entry.classId, input.filters.classId));
    }

    if (input.filters.paymentStatus) {
      const rows = await db
        .select({ email: person.email })
        .from(entry)
        .innerJoin(person, eq(entry.driverPersonId, person.id))
        .innerJoin(
          invoice,
          and(eq(invoice.eventId, entry.eventId), eq(invoice.driverPersonId, entry.driverPersonId))
        )
        .where(and(...conditions, eq(invoice.paymentStatus, input.filters.paymentStatus)));
      return dedupeEmails(rows.map((row) => row.email));
    }

    const rows = await db
      .select({ email: person.email })
      .from(entry)
      .innerJoin(person, eq(entry.driverPersonId, person.id))
      .where(and(...conditions));
    return dedupeEmails(rows.map((row) => row.email));
  }

  return [];
};

export const queueMail = async (input: QueueMailInput, actorUserId: string | null) => {
  const db = await getDb();
  const emails = await resolveEmails(input);

  if (emails.length === 0) {
    return { queued: 0 };
  }

  const sendAfter = input.sendAfter ? new Date(input.sendAfter) : new Date();

  try {
    await db.insert(emailOutbox).values(
      emails.map((email) => ({
        eventId: input.eventId,
        toEmail: email,
        subject: input.subject,
        templateId: input.templateId,
        templateData: input.templateData ?? null,
        status: 'queued',
        sendAfter
      }))
    );
  } catch (error) {
    if (isPgUniqueViolation(error)) {
      throw new Error('UNIQUE_VIOLATION');
    }
    throw error;
  }

  await writeAuditLog(db as never, {
    eventId: input.eventId,
    actorUserId,
    action: 'email_outbox_queued',
    entityType: 'email_outbox_batch',
    payload: {
      queued: emails.length,
      templateId: input.templateId
    }
  });

  return { queued: emails.length };
};

export const queuePaymentReminders = async (input: ReminderInput, actorUserId: string | null) => {
  const db = await getDb();

  const rows = await db
    .select({ email: person.email })
    .from(invoice)
    .innerJoin(person, eq(invoice.driverPersonId, person.id))
    .where(and(eq(invoice.eventId, input.eventId), eq(invoice.paymentStatus, 'due')));

  const emails = dedupeEmails(rows.map((row) => row.email));
  if (emails.length === 0) {
    return { queued: 0 };
  }

  const sendAfter = input.sendAfter ? new Date(input.sendAfter) : new Date();

  try {
    await db.insert(emailOutbox).values(
      emails.map((email) => ({
        eventId: input.eventId,
        toEmail: email,
        subject: input.subject,
        templateId: input.templateId,
        templateData: input.templateData ?? null,
        status: 'queued',
        sendAfter
      }))
    );
  } catch (error) {
    if (isPgUniqueViolation(error)) {
      throw new Error('UNIQUE_VIOLATION');
    }
    throw error;
  }

  await writeAuditLog(db as never, {
    eventId: input.eventId,
    actorUserId,
    action: 'payment_reminders_queued',
    entityType: 'email_outbox_batch',
    payload: {
      queued: emails.length,
      templateId: input.templateId
    }
  });

  return { queued: emails.length };
};

export const validateQueueMailInput = (payload: unknown) => queueMailSchema.parse(payload);
export const validateReminderInput = (payload: unknown) => reminderSchema.parse(payload);
