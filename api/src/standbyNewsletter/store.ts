import { createHash, randomUUID } from 'crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient, GetCommand, QueryCommand, ScanCommand,
  TransactWriteCommand, UpdateCommand
} from '@aws-sdk/lib-dynamodb';
import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import {
  CONSENT_VERSION, consentHash, hashNewsletterToken, newToken,
  normalizeEmail, normalizeNewsletterLocale
} from '../routes/newsletterContract';
import type { NewsletterLocale } from '../routes/newsletterContract';

export type SubscriberStatus = 'pending' | 'active' | 'unsubscribed' | 'bounced' | 'complained';
export type Subscriber = {
  pk: string; sk: 'PROFILE'; kind: 'subscriber'; id: string; email: string;
  emailNorm: string; locale: NewsletterLocale; status: SubscriberStatus;
  consentVersion: string; consentTextHash: string; verificationTokenHash?: string;
  verificationExpiresAt?: string; verificationSentAt?: string;
  verificationWindowStartedAt?: string; verificationSendCount: number;
  unsubscribeTokenHash?: string; confirmedAt?: string; unsubscribedAt?: string;
  bouncedAt?: string; complainedAt?: string; createdAt: string; updatedAt: string;
  version: number;
};
type TokenReference = { pk: string; sk: 'REF'; kind: 'token'; subscriberPk: string; expiresAt: number };
type IdReference = { pk: string; sk: 'REF'; kind: 'id'; subscriberPk: string };
export type MailOutbox = {
  pk: string; sk: 'MAIL'; kind: 'mail'; id: string; subscriberPk: string; subscriberId: string;
  email: string; locale: NewsletterLocale; action: 'confirm' | 'unsubscribe';
  token: string; status: 'pending' | 'sent'; createdAt: string; sesMessageId?: string;
  expiresAt?: number;
};

const tableName = () => {
  const name = process.env.NEWSLETTER_TABLE_NAME;
  if (!name) throw new Error('NEWSLETTER_TABLE_NAME is required');
  return name;
};
export const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true }
});
export const subscriberKey = (emailNorm: string) =>
  `SUB#${createHash('sha256').update(emailNorm).digest('hex')}`;
const tokenKey = (tokenHash: string) => `TOKEN#${tokenHash}`;
const idKey = (id: string) => `ID#${id}`;
const now = () => new Date().toISOString();
const isConditionalFailure = (error: unknown) =>
  error instanceof Error && (error.name === 'TransactionCanceledException' || error.name === 'ConditionalCheckFailedException');

export const getSubscriber = async (emailNorm: string): Promise<Subscriber | null> => {
  const result = await client.send(new GetCommand({ TableName: tableName(), Key: { pk: subscriberKey(emailNorm), sk: 'PROFILE' }, ConsistentRead: true }));
  return (result.Item as Subscriber | undefined) ?? null;
};
export const getSubscriberByPk = async (pk: string): Promise<Subscriber | null> => {
  const result = await client.send(new GetCommand({ TableName: tableName(), Key: { pk, sk: 'PROFILE' }, ConsistentRead: true }));
  return (result.Item as Subscriber | undefined) ?? null;
};
export const getSubscriberById = async (id: string): Promise<Subscriber | null> => {
  const ref = await client.send(new GetCommand({ TableName: tableName(), Key: { pk: idKey(id), sk: 'REF' }, ConsistentRead: true }));
  return ref.Item ? getSubscriberByPk((ref.Item as IdReference).subscriberPk) : null;
};
const getSubscriberByToken = async (token: string): Promise<{ subscriber: Subscriber | null; expired: boolean }> => {
  const hash = hashNewsletterToken(token);
  const ref = await client.send(new GetCommand({ TableName: tableName(), Key: { pk: tokenKey(hash), sk: 'REF' }, ConsistentRead: true }));
  if (!ref.Item) return { subscriber: null, expired: false };
  return { subscriber: await getSubscriberByPk((ref.Item as TokenReference).subscriberPk),
    expired: (ref.Item as TokenReference).expiresAt < Date.now() / 1000 };
};

const putSubscriber = (next: Subscriber, previous: Subscriber | null) => ({
  Put: {
    TableName: tableName(), Item: next,
    ConditionExpression: previous ? '#version = :previous' : 'attribute_not_exists(pk)',
    ...(previous ? { ExpressionAttributeNames: { '#version': 'version' }, ExpressionAttributeValues: { ':previous': previous.version } } : {})
  }
});
const consentEvent = (subscriber: Subscriber, action: string, source = 'website', actor?: string) => ({
  Put: {
    TableName: tableName(),
    Item: {
      pk: `CONSENT#${subscriber.id}`, sk: `${now()}#${randomUUID()}`, kind: 'consent',
      subscriberId: subscriber.id, action, consentVersion: subscriber.consentVersion,
      consentTextHash: subscriber.consentTextHash, locale: subscriber.locale, source,
      createdAt: now(),
      ...(actor ? { actorUserId: actor } : {})
    }
  }
});
const tokenReference = (subscriber: Subscriber, token: string, expiresAt: number) => ({
  Put: { TableName: tableName(), Item: {
    pk: tokenKey(hashNewsletterToken(token)), sk: 'REF', kind: 'token',
    subscriberPk: subscriber.pk, expiresAt
  } satisfies TokenReference }
});
const mailItem = (subscriber: Subscriber, token: string, action: MailOutbox['action']) => ({
  Put: { TableName: tableName(), Item: {
    pk: `MAIL#${randomUUID()}`, sk: 'MAIL', kind: 'mail', id: randomUUID(),
    subscriberPk: subscriber.pk, subscriberId: subscriber.id, email: subscriber.email, locale: subscriber.locale,
    action, token, status: 'pending', createdAt: now(),
    expiresAt: Math.floor(Date.now() / 1000) + 30 * 24 * 3600
  } satisfies MailOutbox }
});
const write = async (items: NonNullable<TransactWriteCommandInput['TransactItems']>) => {
  await client.send(new TransactWriteCommand({ TransactItems: items }));
};

export const requestSignup = async (rawEmail: string, rawLocale: unknown): Promise<void> => {
  const emailNorm = normalizeEmail(rawEmail);
  const locale = normalizeNewsletterLocale(rawLocale);
  for (let attempt = 0; attempt < 3; attempt++) {
    const previous = await getSubscriber(emailNorm);
    if (previous?.status === 'active' || previous?.status === 'bounced' || previous?.status === 'complained') return;
    const timestamp = now();
    const sentAt = previous?.verificationSentAt ? Date.parse(previous.verificationSentAt) : 0;
    if (previous?.status === 'pending' && Date.now() - sentAt < 15 * 60_000) return;
    const windowStart = previous?.verificationWindowStartedAt ? Date.parse(previous.verificationWindowStartedAt) : 0;
    const freshWindow = !windowStart || Date.now() - windowStart > 24 * 60 * 60_000;
    const count = freshWindow ? 1 : (previous?.verificationSendCount ?? 0) + 1;
    if (count > 3) return;
    const token = newToken();
    const expiresAt = Math.floor(Date.now() / 1000) + 48 * 3600;
    const subscriber: Subscriber = {
      pk: subscriberKey(emailNorm), sk: 'PROFILE', kind: 'subscriber',
      id: previous?.id ?? randomUUID(), email: rawEmail.trim(), emailNorm,
      locale, status: 'pending', consentVersion: CONSENT_VERSION,
      consentTextHash: consentHash(locale), verificationTokenHash: hashNewsletterToken(token),
      verificationExpiresAt: new Date(expiresAt * 1000).toISOString(),
      verificationSentAt: timestamp,
      verificationWindowStartedAt: freshWindow ? timestamp : previous!.verificationWindowStartedAt,
      verificationSendCount: count, createdAt: previous?.createdAt ?? timestamp,
      updatedAt: timestamp, version: (previous?.version ?? 0) + 1
    };
    const items: NonNullable<TransactWriteCommandInput['TransactItems']> = [
      putSubscriber(subscriber, previous), tokenReference(subscriber, token, expiresAt),
      consentEvent(subscriber, 'requested'), mailItem(subscriber, token, 'confirm')
    ];
    if (!previous) items.push({ Put: { TableName: tableName(), Item: {
      pk: idKey(subscriber.id), sk: 'REF', kind: 'id', subscriberPk: subscriber.pk
    } satisfies IdReference, ConditionExpression: 'attribute_not_exists(pk)' } });
    try { await write(items); return; }
    catch (error) { if (!isConditionalFailure(error) || attempt === 2) throw error; }
  }
};

export const confirm = async (token: string) => {
  const { subscriber, expired } = await getSubscriberByToken(token);
  if (!subscriber || subscriber.verificationTokenHash !== hashNewsletterToken(token)) return { status: 'invalid' as const };
  if (subscriber.status === 'active') return { status: 'already_confirmed' as const };
  if (expired || !subscriber.verificationExpiresAt || Date.parse(subscriber.verificationExpiresAt) < Date.now()) return { status: 'expired' as const };
  const next: Subscriber = { ...subscriber, status: 'active', confirmedAt: now(), updatedAt: now(), version: subscriber.version + 1 };
  try {
    await write([putSubscriber(next, subscriber), consentEvent(next, 'confirmed')]);
    return { status: 'confirmed' as const };
  } catch (error) { if (isConditionalFailure(error)) return { status: 'invalid' as const }; throw error; }
};

export const requestUnsubscribe = async (rawEmail: string): Promise<void> => {
  const subscriber = await getSubscriber(normalizeEmail(rawEmail));
  if (!subscriber || subscriber.status !== 'active') return;
  const token = newToken();
  const next: Subscriber = { ...subscriber, unsubscribeTokenHash: hashNewsletterToken(token), updatedAt: now(), version: subscriber.version + 1 };
  try {
    await write([putSubscriber(next, subscriber), tokenReference(next, token, Math.floor(Date.now() / 1000) + 48 * 3600), mailItem(next, token, 'unsubscribe')]);
  } catch (error) { if (!isConditionalFailure(error)) throw error; }
};

export const unsubscribe = async (token: string) => {
  const { subscriber, expired } = await getSubscriberByToken(token);
  if (!subscriber || subscriber.unsubscribeTokenHash !== hashNewsletterToken(token)) return { status: 'invalid' as const };
  if (subscriber.status === 'unsubscribed') return { status: 'already_unsubscribed' as const };
  if (expired) return { status: 'invalid' as const };
  const next: Subscriber = { ...subscriber, status: 'unsubscribed', unsubscribedAt: now(), updatedAt: now(), version: subscriber.version + 1 };
  try {
    await write([putSubscriber(next, subscriber), consentEvent(next, 'unsubscribed')]);
    return { status: 'unsubscribed' as const };
  } catch (error) { if (isConditionalFailure(error)) return { status: 'invalid' as const }; throw error; }
};

export const adminUnsubscribe = async (id: string, actor: string): Promise<boolean> => {
  const subscriber = await getSubscriberById(id);
  if (!subscriber) return false;
  if (subscriber.status === 'unsubscribed') return true;
  const next: Subscriber = { ...subscriber, status: 'unsubscribed', unsubscribedAt: now(), updatedAt: now(), version: subscriber.version + 1 };
  await write([putSubscriber(next, subscriber), consentEvent(next, 'admin_unsubscribed', 'admin', actor)]);
  return true;
};

export const adminResend = async (id: string, actor: string): Promise<boolean> => {
  const subscriber = await getSubscriberById(id);
  if (!subscriber || subscriber.status !== 'pending') return false;
  const token = newToken();
  const timestamp = now();
  const next: Subscriber = { ...subscriber, verificationTokenHash: hashNewsletterToken(token),
    verificationExpiresAt: new Date(Date.now() + 48 * 3600_000).toISOString(),
    verificationSentAt: timestamp, updatedAt: timestamp, version: subscriber.version + 1 };
  await write([putSubscriber(next, subscriber), tokenReference(next, token, Math.floor(Date.now() / 1000) + 48 * 3600),
    consentEvent(next, 'verification_resent', 'admin', actor), mailItem(next, token, 'confirm')]);
  return true;
};

export const listSubscribers = async (): Promise<Subscriber[]> => {
  const subscribers: Subscriber[] = [];
  let cursor: Record<string, unknown> | undefined;
  do {
    const result = await client.send(new ScanCommand({ TableName: tableName(),
      FilterExpression: '#kind = :kind', ExpressionAttributeNames: { '#kind': 'kind' },
      ExpressionAttributeValues: { ':kind': 'subscriber' }, ExclusiveStartKey: cursor }));
    subscribers.push(...(result.Items as Subscriber[] | undefined ?? []));
    cursor = result.LastEvaluatedKey;
  } while (cursor);
  return subscribers;
};

export const consumeRateLimit = async (scope: string, identifier: string, limit: number, windowSeconds: number): Promise<boolean> => {
  const window = Math.floor(Date.now() / 1000 / windowSeconds);
  const hash = createHash('sha256').update(`${scope}:${identifier}`).digest('hex');
  try {
    await client.send(new UpdateCommand({ TableName: tableName(), Key: { pk: `RATE#${hash}`, sk: String(window) },
      UpdateExpression: 'ADD #count :one SET expiresAt = :expiry',
      ConditionExpression: 'attribute_not_exists(#count) OR #count < :limit',
      ExpressionAttributeNames: { '#count': 'count' },
      ExpressionAttributeValues: { ':one': 1, ':limit': limit, ':expiry': (window + 2) * windowSeconds } }));
    return true;
  } catch (error) { if (isConditionalFailure(error)) return false; throw error; }
};

export const listConsentEvents = async (subscriberId: string) => {
  const events: Record<string, unknown>[] = [];
  let cursor: Record<string, unknown> | undefined;
  do {
    const result = await client.send(new QueryCommand({ TableName: tableName(),
      KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': `CONSENT#${subscriberId}` },
      ExclusiveStartKey: cursor, ConsistentRead: true }));
    events.push(...(result.Items ?? []));
    cursor = result.LastEvaluatedKey;
  } while (cursor);
  return events;
};
