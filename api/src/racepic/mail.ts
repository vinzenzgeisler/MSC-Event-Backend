import { createHash } from 'node:crypto';
import { emailOutbox } from '../db/schema';

/**
 * Queued die RacePic-Fotografen-Einladungsmail ueber den bestehenden email_outbox/EmailWorker-Pfad
 * (api/src/jobs/emailWorker.ts). Der Template-Key wird in api/migrations/0096_racepic_photographer_invitation_mail.sql
 * angelegt (gleiches Muster wie 0055_doublestarter_migration_notice.sql).
 *
 * Bewusst kein Umweg ueber die Admin-Compose-Route/TemplateContracts (api/src/routes/adminMail.ts):
 * das ist eine reine System-Transaktionsmail ohne freie Fotografen-Formatierung.
 */
export const RACEPIC_INVITATION_TEMPLATE_ID = 'racepic_photographer_invitation';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const queuePhotographerInvitationMail = async (
  db: any,
  input: {
    toEmail: string;
    photographerDisplayName: string;
    eventNames: string[];
    invitationUrl: string;
    invitationId: string;
    locale?: string;
  }
) => {
  const [row] = await db
    .insert(emailOutbox)
    .values({
      eventId: null,
      toEmail: input.toEmail.trim().toLowerCase(),
      subject: 'Einladung zu RacePic',
      templateId: RACEPIC_INVITATION_TEMPLATE_ID,
      templateVersion: 1,
      templateData: {
        locale: input.locale ?? 'de',
        photographerName: input.photographerDisplayName,
        eventNames: input.eventNames.join(', '),
        invitationUrl: input.invitationUrl
      },
      status: 'queued',
      sendAfter: new Date(),
      idempotencyKey: `racepic_invitation:${createHash('sha256').update(input.invitationId).digest('hex').slice(0, 32)}`,
      maxAttempts: 5
    })
    .onConflictDoNothing()
    .returning({ id: emailOutbox.id });
  return row?.id ?? null;
};
