import { and, eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { emailOutbox, invoice, person } from '../db/schema';
import { writeAuditLog } from '../audit/log';

const getTemplateId = () => {
  const templateId = process.env.PAYMENT_REMINDER_TEMPLATE_ID;
  if (!templateId) {
    throw new Error('PAYMENT_REMINDER_TEMPLATE_ID is not set');
  }
  return templateId;
};

const getSubject = () => {
  const subject = process.env.PAYMENT_REMINDER_SUBJECT;
  if (!subject) {
    throw new Error('PAYMENT_REMINDER_SUBJECT is not set');
  }
  return subject;
};

export const handler = async () => {
  const db = await getDb();
  const templateId = getTemplateId();
  const subject = getSubject();

  const rows = await db
    .select({ email: person.email, eventId: invoice.eventId })
    .from(invoice)
    .innerJoin(person, eq(invoice.driverPersonId, person.id))
    .where(and(eq(invoice.paymentStatus, 'due')));

  const targets = rows.filter((row) => row.email);
  if (targets.length === 0) {
    return { queued: 0 };
  }

  await db.insert(emailOutbox).values(
    targets.map((target) => ({
      eventId: target.eventId,
      toEmail: target.email as string,
      subject,
      templateId,
      templateData: null,
      status: 'queued',
      sendAfter: new Date()
    }))
  );

  await writeAuditLog(db as never, {
    eventId: null,
    actorUserId: 'system',
    action: 'payment_reminders_queued',
    entityType: 'email_outbox_batch',
    payload: {
      queued: targets.length
    }
  });

  return { queued: targets.length };
};
