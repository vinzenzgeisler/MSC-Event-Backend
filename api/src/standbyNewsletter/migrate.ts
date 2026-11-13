import { DeleteCommand, GetCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { isDeepStrictEqual } from 'util';
import { getPool } from '../db/client';
import { client, subscriberKey } from './store';
import type { Subscriber } from './store';

type LegacySubscriber = Record<string, unknown>;
type LegacyConsent = Record<string, unknown>;
const iso = (value: unknown): string | undefined =>
  value == null ? undefined : new Date(value as string | number | Date).toISOString();
const string = (value: unknown) => value == null ? undefined : String(value);
const table = () => {
  const name = process.env.NEWSLETTER_TABLE_NAME;
  if (!name) throw new Error('NEWSLETTER_TABLE_NAME is required');
  return name;
};
const putVerified = async <T extends { pk: string; sk: string }>(item: T) => {
  await client.send(new PutCommand({ TableName: table(), Item: item }));
  const result = await client.send(new GetCommand({ TableName: table(),
    Key: { pk: item.pk, sk: item.sk }, ConsistentRead: true }));
  const expected = JSON.parse(JSON.stringify(item));
  if (!isDeepStrictEqual(result.Item, expected)) throw new Error('Newsletter record reconciliation failed');
};
const mapSubscriber = (row: LegacySubscriber): Subscriber => ({
  pk: subscriberKey(String(row.email_norm)), sk: 'PROFILE', kind: 'subscriber',
  id: String(row.id), email: String(row.email), emailNorm: String(row.email_norm),
  locale: row.locale as Subscriber['locale'], status: row.status as Subscriber['status'],
  consentVersion: String(row.consent_version), consentTextHash: String(row.consent_text_hash),
  verificationTokenHash: string(row.verification_token_hash),
  verificationExpiresAt: iso(row.verification_expires_at),
  verificationSentAt: iso(row.verification_sent_at),
  verificationWindowStartedAt: iso(row.verification_window_started_at),
  verificationSendCount: Number(row.verification_send_count),
  unsubscribeTokenHash: string(row.unsubscribe_token_hash),
  confirmedAt: iso(row.confirmed_at), unsubscribedAt: iso(row.unsubscribed_at),
  bouncedAt: iso(row.bounced_at), complainedAt: iso(row.complained_at),
  createdAt: iso(row.created_at)!, updatedAt: iso(row.updated_at)!, version: 1
});

const scanTarget = async () => {
  const items: Record<string, unknown>[] = [];
  let cursor: Record<string, unknown> | undefined;
  do {
    const result = await client.send(new ScanCommand({ TableName: table(),
      ProjectionExpression: 'pk, sk, #kind', ExpressionAttributeNames: { '#kind': 'kind' },
      ExclusiveStartKey: cursor, ConsistentRead: true }));
    items.push(...(result.Items ?? []));
    cursor = result.LastEvaluatedKey;
  } while (cursor);
  return items;
};
const countKinds = async () => {
  const counts: Record<string, number> = {};
  for (const item of await scanTarget()) counts[String(item.kind)] = (counts[String(item.kind)] ?? 0) + 1;
  return counts;
};

export const migrate = async (mode: 'audit' | 'copy' | 'final') => {
  const pool = await getPool();
  const connection = await pool.connect();
  try {
    await connection.query('begin isolation level repeatable read read only');
    const [subscribers, consent, pending] = await Promise.all([
      connection.query('select * from newsletter_subscriber order by id'),
      connection.query('select * from newsletter_consent_event order by id'),
      connection.query(`select count(*)::int as count from email_outbox
        where template_data->>'senderProfile' = 'newsletter'
          and status not in ('sent','failed','cancelled')`)
    ]);
    await connection.query('commit');
    const source = { subscribers: subscribers.rowCount ?? 0,
      consentEvents: consent.rowCount ?? 0, pendingNewsletterMail: Number(pending.rows[0]?.count ?? 0) };
    if (mode === 'audit') return { source, target: await countKinds() };
    const marker = await client.send(new GetCommand({ TableName: table(),
      Key: { pk: 'META#cutover', sk: 'STATE' }, ConsistentRead: true }));
    if (marker.Item) throw new Error('Migration is closed after newsletter cutover');
    const finalImport = await client.send(new GetCommand({ TableName: table(),
      Key: { pk: 'META#final-import', sk: 'STATE' }, ConsistentRead: true }));
    if (mode === 'copy' && finalImport.Item) throw new Error('Initial copy is closed after final reconciliation');
    if (mode === 'final' && source.pendingNewsletterMail > 0) throw new Error('Legacy newsletter outbox is not drained');
    if (mode === 'final') {
      const target = await scanTarget();
      if (target.some((item) => !['subscriber', 'id', 'token', 'consent', 'finalImport'].includes(String(item.kind)))) {
        throw new Error('Target contains non-migration records; refusing final refresh');
      }
      // Source writes are frozen. Rebuild the read-only copy so records removed
      // by source retention between the initial and final copies do not survive.
      for (const item of target) await client.send(new DeleteCommand({ TableName: table(),
        Key: { pk: item.pk, sk: item.sk } }));
    }
    for (const row of subscribers.rows as LegacySubscriber[]) {
      const item = mapSubscriber(row);
      await putVerified(item);
      await putVerified({
        pk: `ID#${item.id}`, sk: 'REF', kind: 'id', subscriberPk: item.pk
      });
      for (const [hash, expiry] of [
        [item.verificationTokenHash, item.verificationExpiresAt ? Math.floor(Date.parse(item.verificationExpiresAt) / 1000) : 0],
        [item.unsubscribeTokenHash, Math.floor(Date.now() / 1000) + 48 * 3600]
      ] as const) {
        if (!hash) continue;
        await putVerified({
          pk: `TOKEN#${hash}`, sk: 'REF', kind: 'token', subscriberPk: item.pk,
          expiresAt: expiry
        });
      }
    }
    for (const row of consent.rows as LegacyConsent[]) {
      await putVerified({
        pk: `CONSENT#${row.subscriber_id}`, sk: `${iso(row.created_at)}#${row.id}`,
        kind: 'consent', subscriberId: string(row.subscriber_id),
        action: string(row.action), consentVersion: string(row.consent_version),
        consentTextHash: string(row.consent_text_hash), locale: string(row.locale),
        source: string(row.source), createdAt: iso(row.created_at)
      });
    }
    const target = await countKinds();
    if (target.subscriber !== source.subscribers || target.consent !== source.consentEvents) {
      throw new Error(`Newsletter reconciliation failed: subscriber ${target.subscriber ?? 0}/${source.subscribers}, consent ${target.consent ?? 0}/${source.consentEvents}`);
    }
    if (mode === 'final') await client.send(new PutCommand({ TableName: table(), Item: {
      pk: 'META#final-import', sk: 'STATE', kind: 'finalImport',
      completedAt: new Date().toISOString(),
      subscribers: source.subscribers, consentEvents: source.consentEvents,
      pendingNewsletterMail: source.pendingNewsletterMail
    } }));
    return { source, target };
  } catch (error) {
    await connection.query('rollback').catch(() => undefined);
    throw error;
  } finally { connection.release(); await pool.end(); }
};

if (require.main === module) {
  const mode = process.argv[2];
  if (mode !== 'audit' && mode !== 'copy' && mode !== 'final') throw new Error('Expected audit, copy or final');
  migrate(mode).then((result) => console.log(JSON.stringify(result)))
    .catch((error) => { console.error(error instanceof Error ? error.message : 'Migration failed'); process.exitCode = 1; });
}
