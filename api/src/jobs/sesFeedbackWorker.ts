import type { SNSEvent } from 'aws-lambda';
import { getPool } from '../db/client';
import { logOperationalEvent } from '../observability/logger';

type SesFeedback = {
  eventType?: string;
  notificationType?: string;
  mail?: { messageId?: string; timestamp?: string };
  bounce?: { bounceType?: string; bounceSubType?: string };
  complaint?: { complaintFeedbackType?: string };
};

export const statusFor = (eventType: string): 'sent' | 'failed' | 'bounced' | 'complaint' | null => {
  if (eventType === 'Delivery') return 'sent';
  if (eventType === 'Bounce') return 'bounced';
  if (eventType === 'Complaint') return 'complaint';
  if (eventType === 'Reject' || eventType === 'Rendering Failure') return 'failed';
  return null;
};

export const processSesFeedback = async (feedback: SesFeedback) => {
  const eventType = feedback.eventType ?? feedback.notificationType ?? 'Unknown';
  const messageId = feedback.mail?.messageId;
  const status = statusFor(eventType);
  const isDeliveryDelay = eventType === 'DeliveryDelay' || eventType === 'Delivery Delay';
  if (messageId && isDeliveryDelay) {
    logOperationalEvent('warn', 'mail.feedback_delivery_delay', { status: 'delayed' });
    return;
  }
  if (!messageId || !status) {
    logOperationalEvent('info', 'mail.feedback_ignored', { status: eventType });
    return;
  }

  const pool = await getPool();
  const result = await pool.query(
    `
      update email_delivery
      set status = $2,
          provider_response = coalesce(provider_response, '{}'::jsonb) || $3::jsonb
      where ses_message_id = $1
      returning outbox_id
    `,
    [
      messageId,
      status,
      JSON.stringify({
        eventType,
        eventAt: feedback.mail?.timestamp ?? null,
        bounceType: feedback.bounce?.bounceType ?? null,
        bounceSubType: feedback.bounce?.bounceSubType ?? null,
        complaintType: feedback.complaint?.complaintFeedbackType ?? null
      })
    ]
  );
  if (result.rowCount === 0) {
    throw new Error('SES_DELIVERY_NOT_FOUND');
  }
  if (status === 'bounced' || status === 'complaint') {
    await pool.query(
      `update newsletter_subscriber n
       set status = $2,
           bounced_at = case when $2 = 'bounced' then now() else bounced_at end,
           complained_at = case when $2 = 'complained' then now() else complained_at end,
           updated_at = now()
       from email_outbox o
       where o.id = $1
         and o.template_data->>'newsletterSubscriberId' = n.id::text`,
      [result.rows[0].outbox_id, status === 'complaint' ? 'complained' : 'bounced']
    );
  }
  logOperationalEvent(status === 'sent' ? 'info' : 'error', `mail.feedback_${eventType.toLowerCase().replace(/\s+/g, '_')}`, {
    outboxId: result.rows[0].outbox_id,
    status
  });
};

export const handler = async (event: SNSEvent) => {
  for (const record of event.Records) {
    const feedback = JSON.parse(record.Sns.Message) as SesFeedback;
    await processSesFeedback(feedback);
  }
};
