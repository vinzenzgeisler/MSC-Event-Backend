import { getPool } from '../db/client';
import { sendEmail } from '../mail/ses';
import { getTemplateVersion } from '../mail/templateStore';
import { renderMailContract } from '../mail/rendering';
import { getAssetObjectBuffer, getDocumentObjectBuffer } from '../docs/storage';
import { DuplicateRequestError, queueLifecycleMail } from '../routes/adminMail';

type OutboxRow = {
  id: string;
  to_email: string;
  subject: string;
  template_id: string;
  template_version: number;
  template_data: Record<string, unknown> | null;
  attempt_count: number;
  max_attempts: number;
};

type OutboxAttachmentRow = {
  outbox_id: string;
  file_name: string;
  content_type: string;
  s3_key: string;
  source: 'upload' | 'system' | 'document';
};

type LifecycleCandidateRow = {
  event_id: string;
  entry_id: string;
};

const parsePositiveInt = (value: string | undefined, fallbackValue: number): number => {
  if (!value) {
    return fallbackValue;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackValue;
};

const claimOutbox = async (batchSize: number): Promise<OutboxRow[]> => {
  const pool = await getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const result = await client.query(
      `
      update email_outbox
      set status = 'sending',
          attempt_count = attempt_count + 1,
          updated_at = now()
      where id in (
        select id from email_outbox
        where status = 'queued' and send_after <= now()
        order by created_at
        for update skip locked
        limit $1
      )
      returning id, to_email, subject, template_id, template_version, template_data, attempt_count, max_attempts
    `,
      [batchSize]
    );
    await client.query('COMMIT');
    return result.rows as OutboxRow[];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

const listOutboxAttachments = async (outboxIds: string[]): Promise<Map<string, OutboxAttachmentRow[]>> => {
  if (outboxIds.length === 0) {
    return new Map();
  }
  const pool = await getPool();
  const result = await pool.query(
    `
      select outbox_id, file_name, content_type, s3_key
           , source
      from email_outbox_attachment
      where outbox_id = any($1::uuid[])
      order by created_at asc
    `,
    [outboxIds]
  );
  const map = new Map<string, OutboxAttachmentRow[]>();
  (result.rows as OutboxAttachmentRow[]).forEach((row) => {
    const list = map.get(row.outbox_id);
    if (list) {
      list.push(row);
      return;
    }
    map.set(row.outbox_id, [row]);
  });
  return map;
};

const markSent = async (id: string, messageId: string | null, providerResponse: unknown) => {
  const pool = await getPool();
  await pool.query(
    `
    update email_outbox
    set status = 'sent', updated_at = now(), error_last = null
    where id = $1
  `,
    [id]
  );
  await pool.query(
    `
    insert into email_delivery (id, outbox_id, ses_message_id, status, sent_at, provider_response)
    values (gen_random_uuid(), $1, $2, 'sent', now(), $3)
  `,
    [id, messageId, providerResponse ? JSON.stringify(providerResponse) : null]
  );
};

const retryDelayMinutes = (attemptCount: number): number => {
  if (attemptCount <= 1) return 1;
  if (attemptCount === 2) return 5;
  if (attemptCount === 3) return 15;
  if (attemptCount === 4) return 60;
  return 360;
};

const markFailed = async (id: string, attemptCount: number, maxAttempts: number, error: unknown) => {
  const pool = await getPool();
  const message = error instanceof Error ? error.message : 'Unknown error';
  const shouldRetry = attemptCount < maxAttempts;
  const delayMinutes = retryDelayMinutes(attemptCount);

  await pool.query(
    `
    update email_outbox
    set status = case when $3 then 'queued' else 'failed' end,
        updated_at = now(),
        error_last = $2,
        send_after = case when $3 then now() + (($4 || ' minutes')::interval) else send_after end
    where id = $1
  `,
    [id, message, shouldRetry, delayMinutes]
  );
  await pool.query(
    `
    insert into email_delivery (id, outbox_id, status, sent_at, provider_response)
    values (gen_random_uuid(), $1, 'failed', now(), $2)
  `,
    [id, JSON.stringify({ error: message, retried: shouldRetry })]
  );
};

const queueEmailConfirmationReminders = async (limit: number, reminderDelayDays: number): Promise<number> => {
  const pool = await getPool();
  const result = await pool.query(
    `
      select e.event_id, e.id as entry_id
      from entry e
      inner join event ev on ev.id = e.event_id
      where e.deleted_at is null
        and e.registration_status = 'submitted_unverified'
        and e.confirmation_mail_verified_at is null
        and e.confirmation_mail_sent_at is not null
        and e.confirmation_mail_sent_at <= now() - (($1 || ' days')::interval)
        and ev.status in ('open', 'closed')
        and not exists (
          select 1
          from email_outbox q
          where q.event_id = e.event_id
            and q.template_id = 'email_confirmation_reminder'
            and q.template_data->>'entryId' = e.id::text
            and q.status in ('queued', 'sending')
        )
        and not exists (
          select 1
          from email_outbox h
          where h.event_id = e.event_id
            and h.template_id = 'email_confirmation_reminder'
            and h.template_data->>'entryId' = e.id::text
            and h.created_at >= now() - (($1 || ' days')::interval)
        )
      order by e.confirmation_mail_sent_at asc
      limit $2
    `,
    [String(reminderDelayDays), limit]
  );

  let queued = 0;
  for (const row of result.rows as LifecycleCandidateRow[]) {
    try {
      await queueLifecycleMail(
        {
          eventId: row.event_id,
          entryId: row.entry_id,
          eventType: 'email_confirmation_reminder',
          includeDriverNote: false,
          allowDuplicate: true
        },
        null
      );
      queued += 1;
    } catch (error) {
      if (error instanceof DuplicateRequestError) {
        continue;
      }
    }
  }
  return queued;
};

const queueAcceptedPaidCompletedMails = async (limit: number): Promise<number> => {
  const pool = await getPool();
  const result = await pool.query(
    `
      select e.event_id, e.id as entry_id
      from entry e
      inner join event ev on ev.id = e.event_id
      inner join invoice i
        on i.event_id = e.event_id
       and i.driver_person_id = e.driver_person_id
      where e.deleted_at is null
        and e.acceptance_status = 'accepted'
        and i.payment_status = 'paid'
        and ev.status in ('open', 'closed')
        and not exists (
          select 1
          from email_outbox q
          where q.event_id = e.event_id
            and q.template_id = 'accepted_paid_completed'
            and q.template_data->>'entryId' = e.id::text
        )
      order by e.updated_at asc
      limit $1
    `,
    [limit]
  );

  let queued = 0;
  for (const row of result.rows as LifecycleCandidateRow[]) {
    try {
      await queueLifecycleMail(
        {
          eventId: row.event_id,
          entryId: row.entry_id,
          eventType: 'accepted_paid_completed',
          includeDriverNote: false,
          allowDuplicate: false
        },
        null
      );
      queued += 1;
    } catch (error) {
      if (error instanceof DuplicateRequestError) {
        continue;
      }
    }
  }
  return queued;
};

export const handler = async () => {
  const batchSize = Number.parseInt(process.env.EMAIL_WORKER_BATCH_SIZE ?? '20', 10);
  const automationBatchSize = parsePositiveInt(process.env.EMAIL_WORKER_AUTOMATION_BATCH_SIZE, 50);
  const reminderDelayDays = parsePositiveInt(process.env.EMAIL_CONFIRMATION_REMINDER_DAYS, 3);

  const reminderQueued = await queueEmailConfirmationReminders(automationBatchSize, reminderDelayDays);
  const acceptedPaidQueued = await queueAcceptedPaidCompletedMails(automationBatchSize);

  const rows = await claimOutbox(batchSize);
  const attachmentsByOutbox = await listOutboxAttachments(rows.map((row) => row.id));
  const attachmentObjectCache = new Map<string, Buffer>();

  for (const row of rows) {
    try {
      const template = await getTemplateVersion(row.template_id, row.template_version);
      if (!template) {
        throw new Error(`Template not found: ${row.template_id}@${row.template_version}`);
      }

      const bodyTextOverride = typeof row.template_data?.bodyTextOverride === 'string' ? row.template_data.bodyTextOverride : null;
      const bodyHtmlOverride = typeof row.template_data?.bodyHtmlOverride === 'string' ? row.template_data.bodyHtmlOverride : null;
      const renderOptions =
        row.template_data?.renderOptions && typeof row.template_data.renderOptions === 'object'
          ? (row.template_data.renderOptions as { showBadge?: boolean; mailLabel?: string | null; includeEntryContext?: boolean })
          : undefined;
      const hasContentOverride = Boolean(bodyTextOverride || bodyHtmlOverride);
      const rendered = renderMailContract({
        templateKey: row.template_id,
        subjectTemplate: row.subject,
        bodyTextTemplate: bodyTextOverride ?? template.bodyTextTemplate,
        bodyHtmlTemplate: bodyHtmlOverride ?? template.bodyHtmlTemplate,
        data: row.template_data ?? {},
        renderOptions,
        hasContentOverride
      });
      if (rendered.missingPlaceholders.length > 0) {
        throw new Error(`TEMPLATE_RENDER_FAILED:missing_placeholders:${rendered.missingPlaceholders.join(',')}`);
      }
      if (
        (row.template_id === 'registration_received' ||
          row.template_id === 'email_confirmation' ||
          row.template_id === 'email_confirmation_reminder') &&
        rendered.warnings.some((item) => item.includes('verificationUrl'))
      ) {
        throw new Error('MISSING_VERIFICATION_URL');
      }

      const attachmentRefs = attachmentsByOutbox.get(row.id) ?? [];
      const attachments: Array<{ fileName: string; contentType: string; content: Buffer }> = [];
      for (const ref of attachmentRefs) {
        if (ref.content_type !== 'application/pdf') {
          throw new Error(`ATTACHMENT_INVALID_CONTENT_TYPE:${ref.content_type}`);
        }
        let content = attachmentObjectCache.get(ref.s3_key);
        if (!content) {
          const loaded =
            ref.source === 'document'
              ? await getDocumentObjectBuffer(ref.s3_key)
              : await getAssetObjectBuffer(ref.s3_key);
          if (!loaded) {
            throw new Error(`ATTACHMENT_OBJECT_MISSING:${ref.s3_key}`);
          }
          content = loaded;
          attachmentObjectCache.set(ref.s3_key, loaded);
        }
        attachments.push({
          fileName: ref.file_name,
          contentType: ref.content_type,
          content
        });
      }

      const response = await sendEmail(
        row.to_email,
        rendered.subjectRendered,
        rendered.bodyTextRendered,
        rendered.htmlDocument,
        attachments
      );
      await markSent(row.id, response.MessageId ?? null, response);
    } catch (error) {
      await markFailed(row.id, row.attempt_count, row.max_attempts, error);
    }
  }

  return {
    processed: rows.length,
    automation: {
      emailConfirmationReminderQueued: reminderQueued,
      acceptedPaidCompletedQueued: acceptedPaidQueued
    }
  };
};
