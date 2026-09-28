import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';

/** SQS-Zugriff auf die Verarbeitungs-Queues aus infra/lib/stacks/racepic-stack.ts. */
const client = new SQSClient({});

const getQueueUrl = (envVar: string): string => {
  const url = process.env[envVar];
  if (!url) {
    throw new Error(`${envVar} is not set`);
  }
  return url;
};

const sendMessage = async (envVar: string, body: Record<string, unknown>): Promise<void> => {
  await client.send(new SendMessageCommand({ QueueUrl: getQueueUrl(envVar), MessageBody: JSON.stringify(body) }));
};

/** Stoesst die Ingest-Stufe (Paket 4) fuer ein frisch hochgeladenes Bild an. */
export const sendIngestMessage = (imageId: string) => sendMessage('RACEPIC_INGEST_QUEUE_URL', { imageId });

/** Stoesst die Analyse-Stufe (Paket 6: KI-Pipeline) an. */
export const sendAnalyzeMessage = (imageId: string) => sendMessage('RACEPIC_ANALYZE_QUEUE_URL', { imageId });

/** Stoesst die Matching-Stufe (Paket 6: KI-Pipeline) an. */
export const sendMatchMessage = (imageId: string) => sendMessage('RACEPIC_MATCH_QUEUE_URL', { imageId });

/**
 * Stoesst die Artefakt-Erzeugung eines FREE->PAID-Conversion-Items an (Commerce AP08). Nutzt bewusst die
 * Ingest-Queue und den vorhandenen Worker (gleiche Bildverarbeitung, gleiche Rechte, gleiche DLQ); die
 * Nachricht unterscheidet sich durch `conversionItemId` statt `imageId`.
 */
export const sendConversionMessage = (conversionItemId: string) => sendMessage('RACEPIC_INGEST_QUEUE_URL', { conversionItemId });

/** Stoesst die Verarbeitung eines Stripe-Webhook-Inbox-Eintrags an (Commerce AP16). */
export const sendCommerceWebhookMessage = (inboxId: string) => sendMessage('COMMERCE_WEBHOOK_QUEUE_URL', { inboxId });
