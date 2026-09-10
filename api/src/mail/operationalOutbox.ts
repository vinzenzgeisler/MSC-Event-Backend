import { createHash, randomUUID } from 'node:crypto';
import { emailOutbox } from '../db/schema';

type OperationalMail = {
  toEmail: string;
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  audience: 'driver' | 'orga';
  templateData?: Record<string, unknown>;
};

const recipientFingerprint = (email: string): string =>
  createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 20);

export const queueOperationalMails = async (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  input: {
    eventId: string;
    templateId: string;
    idempotencyPrefix: string;
    commonTemplateData?: Record<string, unknown>;
    mails: OperationalMail[];
  }
) => {
  if (input.mails.length === 0) return [];
  const batchId = randomUUID();
  return db
    .insert(emailOutbox)
    .values(
      input.mails.map((mail) => ({
        eventId: input.eventId,
        batchId,
        toEmail: mail.toEmail.trim().toLowerCase(),
        subject: mail.subject,
        templateId: input.templateId,
        templateVersion: 1,
        templateData: {
          ...(input.commonTemplateData ?? {}),
          ...(mail.templateData ?? {}),
          audience: mail.audience,
          bodyTextOverride: mail.bodyText,
          ...(mail.bodyHtml ? { bodyHtmlOverride: mail.bodyHtml } : {})
        },
        status: 'queued',
        sendAfter: new Date(),
        idempotencyKey: `${input.idempotencyPrefix}:${mail.audience}:${recipientFingerprint(mail.toEmail)}`,
        maxAttempts: 5
      }))
    )
    .onConflictDoNothing({ target: emailOutbox.idempotencyKey })
    .returning({ id: emailOutbox.id });
};
