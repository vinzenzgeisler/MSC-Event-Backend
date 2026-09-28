import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { getPool } from '../db/client';
import { errorCodeOf, logOperationalEvent } from '../observability/logger';
import { createRuntimeWebhookDeps } from './webhookRuntime';
import { processInboxEntry } from './webhooks';

/**
 * Worker der Commerce-Webhook-Queue (AP16): verarbeitet pro Nachricht genau einen Inbox-Eintrag. Fehler werden als
 * Batch-Item-Failure gemeldet; SQS wiederholt und verschiebt nach 5 Versuchen in die DLQ (Alarm in racepic-stack.ts).
 */
export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const batchItemFailures: { itemIdentifier: string }[] = [];
  const deps = createRuntimeWebhookDeps();
  for (const record of event.Records) {
    try {
      const body = JSON.parse(record.body) as { inboxId?: string };
      if (!body.inboxId) throw new Error('COMMERCE_WEBHOOK_MISSING_INBOX_ID');
      await processInboxEntry(await getPool(), deps, body.inboxId);
    } catch (error) {
      logOperationalEvent('error', 'racepic_webhook.worker_failed', { errorCode: errorCodeOf(error) });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
};
