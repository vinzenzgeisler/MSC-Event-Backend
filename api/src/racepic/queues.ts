import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';

/** SQS-Zugriff auf die Verarbeitungs-Queues aus infra/lib/stacks/racepic-stack.ts. */
const client = new SQSClient({});

export const getIngestQueueUrl = (): string => {
  const url = process.env.RACEPIC_INGEST_QUEUE_URL;
  if (!url) {
    throw new Error('RACEPIC_INGEST_QUEUE_URL is not set');
  }
  return url;
};

/** Stoesst die Ingest-Stufe (Paket 4) fuer ein frisch hochgeladenes Bild an. */
export const sendIngestMessage = async (imageId: string): Promise<void> => {
  await client.send(
    new SendMessageCommand({
      QueueUrl: getIngestQueueUrl(),
      MessageBody: JSON.stringify({ imageId })
    })
  );
};
