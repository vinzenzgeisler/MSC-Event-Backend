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

/** Stoesst die Analyse-Stufe (Paket 6: KI-Pipeline) an. Bis Paket 6 existiert, bleibt die
 * Nachricht einfach in der Queue liegen (Retention 4 Tage), siehe ingestWorker.ts. */
export const sendAnalyzeMessage = (imageId: string) => sendMessage('RACEPIC_ANALYZE_QUEUE_URL', { imageId });
