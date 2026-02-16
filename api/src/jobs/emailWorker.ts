import { getPool } from '../db/client';
import { renderTemplateString } from '../mail/templates';
import { sendEmail } from '../mail/ses';
import { getTemplateVersion } from '../mail/templateStore';

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

export const handler = async () => {
  const batchSize = Number.parseInt(process.env.EMAIL_WORKER_BATCH_SIZE ?? '20', 10);
  const rows = await claimOutbox(batchSize);

  for (const row of rows) {
    try {
      const template = await getTemplateVersion(row.template_id, row.template_version);
      if (!template) {
        throw new Error(`Template not found: ${row.template_id}@${row.template_version}`);
      }

      const subject = renderTemplateString(row.subject, row.template_data);
      const body = renderTemplateString(template.bodyTemplate, row.template_data);
      const response = await sendEmail(row.to_email, subject, body);
      await markSent(row.id, response.MessageId ?? null, response);
    } catch (error) {
      await markFailed(row.id, row.attempt_count, row.max_attempts, error);
    }
  }

  return { processed: rows.length };
};
