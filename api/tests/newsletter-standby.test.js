const assert = require('node:assert/strict');
const { client, requestSignup, confirm, requestUnsubscribe, unsubscribe, listConsentEvents } = require('../dist/standbyNewsletter/store');
const { renderActionMail } = require('../dist/standbyNewsletter/mail');
const { handler } = require('../dist/standbyNewsletter/handler');
const { retentionHandler } = require('../dist/standbyNewsletter/retention');

process.env.NEWSLETTER_TABLE_NAME = 'test-newsletter';
process.env.NEWSLETTER_PUBLIC_BASE_URL = 'https://www.msc-oberlausitz.de/newsletter';
process.env.NEWSLETTER_WRITE_ENABLED = 'false';
const items = new Map();
const key = (item) => `${item.pk}|${item.sk}`;
const conditionalFailure = () => Object.assign(new Error('condition failed'), { name: 'TransactionCanceledException' });

client.send = async (command) => {
  const input = command.input;
  switch (command.constructor.name) {
    case 'GetCommand': return { Item: items.get(key(input.Key)) };
    case 'QueryCommand': return { Items: [...items.values()].filter((item) => item.pk === input.ExpressionAttributeValues[':pk']) };
    case 'ScanCommand': return { Items: [...items.values()].filter((item) => item.kind === input.ExpressionAttributeValues[':kind']) };
    case 'DeleteCommand': items.delete(key(input.Key)); return {};
    case 'TransactWriteCommand': {
      for (const operation of input.TransactItems) {
        if (operation.Put?.ConditionExpression) {
          const previous = items.get(key(operation.Put.Item));
          if (operation.Put.ConditionExpression.includes('attribute_not_exists') && previous) throw conditionalFailure();
          if (operation.Put.ConditionExpression.includes('#version') && previous?.version !== operation.Put.ExpressionAttributeValues[':previous']) throw conditionalFailure();
        }
        if (operation.Delete?.ConditionExpression) {
          const previous = items.get(key(operation.Delete.Key));
          if (previous?.version !== operation.Delete.ExpressionAttributeValues[':version'] ||
              previous?.status !== operation.Delete.ExpressionAttributeValues[':status']) throw conditionalFailure();
        }
      }
      for (const operation of input.TransactItems) {
        if (operation.Put) items.set(key(operation.Put.Item), structuredClone(operation.Put.Item));
        if (operation.Delete) items.delete(key(operation.Delete.Key));
      }
      return {};
    }
    default: throw new Error(`Unexpected command ${command.constructor.name}`);
  }
};

const event = (method, path, body) => ({
  rawPath: path, body: body && JSON.stringify(body), headers: { origin: 'https://www.msc-oberlausitz.de' },
  requestContext: { http: { method, path, sourceIp: '192.0.2.1' } }
});

(async () => {
  const blocked = await handler(event('POST', '/public/newsletter/subscriptions', {}));
  assert.equal(blocked.statusCode, 503, 'standby API must not accept writes before cutover');
  const readOnlyConfig = await handler(event('GET', '/public/newsletter/config'));
  assert.equal(JSON.parse(readOnlyConfig.body).enabled, false, 'standby config must not advertise signups');
  assert.equal(items.size, 0);

  await requestSignup(' Person@example.org ', 'cz');
  const subscriber = [...items.values()].find((item) => item.kind === 'subscriber');
  const mail = [...items.values()].find((item) => item.kind === 'mail');
  assert.equal(subscriber.emailNorm, 'person@example.org');
  assert.equal(subscriber.locale, 'cs');
  assert.equal(subscriber.status, 'pending');
  assert.equal((await listConsentEvents(subscriber.id)).length, 1);
  assert.match(renderActionMail(mail).text, /newsletter\/confirm\?lang=cz#token=/);
  assert.equal((await confirm(mail.token)).status, 'confirmed');
  assert.equal((await confirm(mail.token)).status, 'already_confirmed');
  assert.equal((await listConsentEvents(subscriber.id)).length, 2);
  await requestSignup('Person@example.org', 'de');
  assert.equal([...items.values()].filter((item) => item.kind === 'mail').length, 1, 'active subscriber must not be mailed again');

  await requestUnsubscribe('Person@example.org');
  const unsubscribeMail = [...items.values()].find((item) => item.kind === 'mail' && item.action === 'unsubscribe');
  assert.ok(unsubscribeMail);
  assert.match(renderActionMail(unsubscribeMail).text, /newsletter\/unsubscribe\?lang=cz#token=/);
  assert.equal((await unsubscribe(unsubscribeMail.token)).status, 'unsubscribed');
  assert.equal((await listConsentEvents(subscriber.id)).length, 3);
  assert.equal((await unsubscribe('not-a-valid-token')).status, 'invalid');

  await requestSignup('stale@example.org', 'de');
  const stale = [...items.values()].find((item) => item.kind === 'subscriber' && item.emailNorm === 'stale@example.org');
  stale.createdAt = new Date(Date.now() - 15 * 24 * 3600_000).toISOString();
  await retentionHandler();
  assert.equal(items.has(`${stale.pk}|PROFILE`), false, 'expired pending subscriber must be removed');
  assert.equal(items.has(`ID#${stale.id}|REF`), false, 'subscriber lookup alias must be removed');
  assert.equal((await listConsentEvents(stale.id)).length, 0, 'consent events must follow retention');
  assert.equal([...items.values()].some((item) => item.kind === 'mail' && item.subscriberId === stale.id), false);
  console.log('standalone newsletter lifecycle tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
