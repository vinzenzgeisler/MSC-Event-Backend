import type { DynamoDBStreamEvent, SNSEvent } from 'aws-lambda';
import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { mailCopy, mailGreeting } from '../routes/newsletterContract';
import type { NewsletterLocale } from '../routes/newsletterContract';
import { client, getSubscriberByPk } from './store';
import type { MailOutbox, Subscriber } from './store';

const ses = new SESClient({});
const tableName = () => {
  if (!process.env.NEWSLETTER_TABLE_NAME) throw new Error('NEWSLETTER_TABLE_NAME is required');
  return process.env.NEWSLETTER_TABLE_NAME;
};
const baseUrl = () => {
  if (!process.env.NEWSLETTER_PUBLIC_BASE_URL) throw new Error('NEWSLETTER_PUBLIC_BASE_URL is required');
  return process.env.NEWSLETTER_PUBLIC_BASE_URL.replace(/\/$/, '');
};
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (match) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[match] ?? match);

export const renderActionMail = (item: Pick<MailOutbox, 'locale' | 'action' | 'token'>) => {
  const locale: NewsletterLocale = item.locale;
  const copy = mailCopy[locale];
  const confirm = item.action === 'confirm';
  const subject = confirm ? copy.confirmSubject : copy.unsubscribeSubject;
  const message = confirm ? copy.confirmText : copy.unsubscribeText;
  const label = confirm ? copy.confirmCta : copy.unsubscribeCta;
  const link = `${baseUrl()}/${confirm ? 'confirm' : 'unsubscribe'}?lang=${locale === 'cs' ? 'cz' : locale}#token=${encodeURIComponent(item.token)}`;
  return {
    subject,
    text: `${mailGreeting[locale]}\n\n${message}\n\n${label}: ${link}\n\nMSC Oberlausitzer Dreiländereck e. V.`,
    html: `<p>${escapeHtml(mailGreeting[locale])}</p><p>${escapeHtml(message)}</p><p><a href="${escapeHtml(link)}">${escapeHtml(label)}</a></p><p>MSC Oberlausitzer Dreiländereck e. V.</p>`
  };
};

const field = (record: DynamoDBStreamEvent['Records'][number], name: string) =>
  record.dynamodb?.NewImage?.[name]?.S;

export const sendActionMail = async (item: MailOutbox) => {
  const current = await client.send(new GetCommand({ TableName: tableName(),
    Key: { pk: item.pk, sk: 'MAIL' }, ConsistentRead: true }));
  if (!current.Item || current.Item.status !== 'pending') return;
  const sender = process.env.NEWSLETTER_FROM_EMAIL;
  if (!sender) throw new Error('NEWSLETTER_FROM_EMAIL is required');
  const content = renderActionMail(item);
  const response = await ses.send(new SendEmailCommand({
    Source: sender, Destination: { ToAddresses: [item.email] },
    Message: { Subject: { Data: content.subject, Charset: 'UTF-8' }, Body: {
      Text: { Data: content.text, Charset: 'UTF-8' },
      Html: { Data: content.html, Charset: 'UTF-8' }
    } },
    ConfigurationSetName: process.env.NEWSLETTER_CONFIGURATION_SET
  }));
  if (!response.MessageId) throw new Error('SES_MESSAGE_ID_MISSING');
  await client.send(new TransactWriteCommand({ TransactItems: [
    { Update: { TableName: tableName(), Key: { pk: item.pk, sk: 'MAIL' },
      UpdateExpression: 'SET #status = :sent, sesMessageId = :messageId REMOVE #token',
      ConditionExpression: '#status = :pending',
      ExpressionAttributeNames: { '#status': 'status', '#token': 'token' },
      ExpressionAttributeValues: { ':sent': 'sent', ':pending': 'pending', ':messageId': response.MessageId } } },
    { Put: { TableName: tableName(), Item: { pk: `SES#${response.MessageId}`, sk: 'REF',
      kind: 'sesMessage', subscriberPk: item.subscriberPk, outboxPk: item.pk,
      expiresAt: Math.floor(Date.now() / 1000) + 365 * 24 * 3600 },
      ConditionExpression: 'attribute_not_exists(pk)' } }
  ] }));
};

export const mailStreamHandler = async (event: DynamoDBStreamEvent) => {
  for (const record of event.Records) {
    if (record.eventName !== 'INSERT' || field(record, 'kind') !== 'mail' || field(record, 'status') !== 'pending') continue;
    const item: MailOutbox = {
      pk: field(record, 'pk') ?? '', sk: 'MAIL', kind: 'mail',
      id: field(record, 'id') ?? '', subscriberPk: field(record, 'subscriberPk') ?? '',
      subscriberId: field(record, 'subscriberId') ?? '',
      email: field(record, 'email') ?? '', locale: field(record, 'locale') as NewsletterLocale,
      action: field(record, 'action') as MailOutbox['action'],
      token: field(record, 'token') ?? '', status: 'pending', createdAt: field(record, 'createdAt') ?? ''
    };
    if (!item.pk || !item.email || !item.token || !item.subscriberPk || !item.subscriberId) throw new Error('INVALID_MAIL_OUTBOX_RECORD');
    await sendActionMail(item);
  }
};

type Feedback = { eventType?: string; notificationType?: string; mail?: { messageId?: string } };

export const feedbackHandler = async (event: SNSEvent) => {
  for (const record of event.Records) {
    const feedback = JSON.parse(record.Sns.Message) as Feedback;
    const status = feedback.eventType ?? feedback.notificationType;
    if (status !== 'Bounce' && status !== 'Complaint') continue;
    const messageId = feedback.mail?.messageId;
    if (!messageId) throw new Error('SES_FEEDBACK_MESSAGE_ID_MISSING');
    const ref = await client.send(new GetCommand({ TableName: tableName(),
      Key: { pk: `SES#${messageId}`, sk: 'REF' }, ConsistentRead: true }));
    if (!ref.Item) throw new Error('SES_FEEDBACK_OUTBOX_NOT_FOUND');
    const subscriber = await getSubscriberByPk(String(ref.Item.subscriberPk));
    if (!subscriber || subscriber.status === 'unsubscribed') continue;
    const next: Subscriber = { ...subscriber, status: status === 'Bounce' ? 'bounced' : 'complained',
      ...(status === 'Bounce' ? { bouncedAt: new Date().toISOString() } : { complainedAt: new Date().toISOString() }),
      updatedAt: new Date().toISOString(), version: subscriber.version + 1 };
    await client.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: tableName(), Item: next,
        ConditionExpression: '#version = :version',
        ExpressionAttributeNames: { '#version': 'version' },
        ExpressionAttributeValues: { ':version': subscriber.version } } },
      { Put: { TableName: tableName(), Item: { pk: `CONSENT#${subscriber.id}`,
        sk: `${new Date().toISOString()}#${messageId}`, kind: 'consent', subscriberId: subscriber.id,
        action: status === 'Bounce' ? 'bounced' : 'complained', locale: subscriber.locale,
        source: 'ses' }, ConditionExpression: 'attribute_not_exists(pk)' } }
    ] }));
  }
};
