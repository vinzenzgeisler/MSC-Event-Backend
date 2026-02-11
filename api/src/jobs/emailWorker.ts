import { getPool } from '../db/client';
import { renderTemplate } from '../mail/templates';
import { sendEmail } from '../mail/ses';

type OutboxRow = {
  id: string;
  to_email: string;
  subject: string;
  template_id: string;
  template_data: Record<string, unknown> | null;
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
      returning id, to_email, subject, template_id, template_data
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
    set status = 'sent', updated_at = now(), last_error = null
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

const markFailed = async (id: string, error: unknown) => {
  const pool = await getPool();
  const message = error instanceof Error ? error.message : 'Unknown error';
  await pool.query(
    `
    update email_outbox
    set status = 'failed', updated_at = now(), last_error = $2
    where id = $1
  `,
    [id, message]
  );
  await pool.query(
    `
    insert into email_delivery (id, outbox_id, status, sent_at, provider_response)
    values (gen_random_uuid(), $1, 'failed', now(), $2)
  `,
    [id, JSON.stringify({ error: message })]
  );
};

export const handler = async () => {
  const batchSize = Number.parseInt(process.env.EMAIL_WORKER_BATCH_SIZE ?? '20', 10);
  const rows = await claimOutbox(batchSize);

  for (const row of rows) {
    try {
      const body = renderTemplate(row.template_id, row.template_data);
      const response = await sendEmail(row.to_email, row.subject, body);
      await markSent(row.id, response.MessageId ?? null, response);
    } catch (error) {
      await markFailed(row.id, error);
    }
  }

  return { processed: rows.length };
};
