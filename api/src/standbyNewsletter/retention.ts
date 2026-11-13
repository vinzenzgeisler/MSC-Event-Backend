import { DeleteCommand, QueryCommand, ScanCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { client, listSubscribers } from './store';
import type { Subscriber } from './store';

type CleanupMarker = {
  pk: string; sk: 'STATE'; kind: 'cleanup'; subscriberId: string;
  subscriberPk: string; verificationTokenHash?: string; unsubscribeTokenHash?: string;
};
const table = () => {
  if (!process.env.NEWSLETTER_TABLE_NAME) throw new Error('NEWSLETTER_TABLE_NAME is required');
  return process.env.NEWSLETTER_TABLE_NAME;
};
const scanKind = async (kind: string): Promise<Record<string, unknown>[]> => {
  const all: Record<string, unknown>[] = [];
  let cursor: Record<string, unknown> | undefined;
  do {
    const result = await client.send(new ScanCommand({ TableName: table(),
      FilterExpression: '#kind = :kind', ExpressionAttributeNames: { '#kind': 'kind' },
      ExpressionAttributeValues: { ':kind': kind }, ExclusiveStartKey: cursor }));
    all.push(...(result.Items ?? []));
    cursor = result.LastEvaluatedKey;
  } while (cursor);
  return all;
};
const shouldDelete = (subscriber: Subscriber, nowMs: number): boolean =>
  (subscriber.status === 'pending' && nowMs - Date.parse(subscriber.createdAt) > 14 * 24 * 3600_000) ||
  (subscriber.status === 'unsubscribed' && Boolean(subscriber.unsubscribedAt) &&
    nowMs - Date.parse(subscriber.unsubscribedAt!) > 3 * 365 * 24 * 3600_000);

const markForCleanup = async (subscriber: Subscriber) => {
  const marker: CleanupMarker = {
    pk: `GC#${subscriber.id}`, sk: 'STATE', kind: 'cleanup',
    subscriberId: subscriber.id, subscriberPk: subscriber.pk,
    verificationTokenHash: subscriber.verificationTokenHash,
    unsubscribeTokenHash: subscriber.unsubscribeTokenHash
  };
  await client.send(new TransactWriteCommand({ TransactItems: [
    { Delete: { TableName: table(), Key: { pk: subscriber.pk, sk: 'PROFILE' },
      ConditionExpression: '#version = :version AND #status = :status',
      ExpressionAttributeNames: { '#version': 'version', '#status': 'status' },
      ExpressionAttributeValues: { ':version': subscriber.version, ':status': subscriber.status } } },
    { Put: { TableName: table(), Item: marker, ConditionExpression: 'attribute_not_exists(pk)' } }
  ] }));
};

const cleanup = async (marker: CleanupMarker) => {
  const consent: Record<string, unknown>[] = [];
  let cursor: Record<string, unknown> | undefined;
  do {
    const result = await client.send(new QueryCommand({ TableName: table(),
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': `CONSENT#${marker.subscriberId}` },
      ExclusiveStartKey: cursor, ConsistentRead: true }));
    consent.push(...(result.Items ?? []));
    cursor = result.LastEvaluatedKey;
  } while (cursor);
  const outbox = (await scanKind('mail')).filter((item) => item.subscriberId === marker.subscriberId);
  const keys = [
    { pk: `ID#${marker.subscriberId}`, sk: 'REF' },
    ...(marker.verificationTokenHash ? [{ pk: `TOKEN#${marker.verificationTokenHash}`, sk: 'REF' }] : []),
    ...(marker.unsubscribeTokenHash ? [{ pk: `TOKEN#${marker.unsubscribeTokenHash}`, sk: 'REF' }] : []),
    ...consent.map((item) => ({ pk: String(item.pk), sk: String(item.sk) })),
    ...outbox.map((item) => ({ pk: String(item.pk), sk: String(item.sk) }))
  ];
  for (const key of keys) await client.send(new DeleteCommand({ TableName: table(), Key: key }));
  await client.send(new DeleteCommand({ TableName: table(), Key: { pk: marker.pk, sk: marker.sk } }));
};

export const retentionHandler = async () => {
  const nowMs = Date.now();
  for (const subscriber of await listSubscribers()) {
    if (!shouldDelete(subscriber, nowMs)) continue;
    try { await markForCleanup(subscriber); }
    catch (error) {
      if (!(error instanceof Error) || error.name !== 'TransactionCanceledException') throw error;
    }
  }
  for (const marker of await scanKind('cleanup')) await cleanup(marker as CleanupMarker);
};
