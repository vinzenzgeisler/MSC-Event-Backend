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
      input.mails.map((mail) => {
        const mergedTemplateData = {
          ...(input.commonTemplateData ?? {}),
          ...(mail.templateData ?? {})
        };
        const mailRenderOptions = mergedTemplateData.renderOptions && typeof mergedTemplateData.renderOptions === 'object'
          ? mergedTemplateData.renderOptions as Record<string, unknown>
          : {};
        return {
          eventId: input.eventId,
          batchId,
          toEmail: mail.toEmail.trim().toLowerCase(),
          subject: mail.subject,
          templateId: input.templateId,
          templateVersion: 1,
          templateData: {
            ...mergedTemplateData,
            audience: mail.audience,
            ...(mail.audience === 'orga' ? {
              headerTitle: mergedTemplateData.headerTitle ?? 'INTERNE PROZESSMELDUNG',
              renderOptions: {
                showBadge: true,
                mailLabel: 'Interne Prozessmeldung',
                includeEntryContext: false,
                ...mailRenderOptions
              }
            } : {}),
            bodyTextOverride: mail.bodyText,
            ...(mail.bodyHtml ? { bodyHtmlOverride: mail.bodyHtml } : {})
          },
          status: 'queued',
          sendAfter: new Date(),
          idempotencyKey: `${input.idempotencyPrefix}:${mail.audience}:${recipientFingerprint(mail.toEmail)}`,
          maxAttempts: 5
        };
      })
    )
    // Compatible with the historical partial idempotency index as well as a
    // future non-partial unique index. A targeted ON CONFLICT would need to
    // repeat the partial-index predicate and currently fails in production.
    .onConflictDoNothing()
    .returning({ id: emailOutbox.id });
};
