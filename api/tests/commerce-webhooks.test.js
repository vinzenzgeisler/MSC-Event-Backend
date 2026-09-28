const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Stripe = require('stripe');

const root = path.resolve(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

// --- Migration und Infrastruktur ------------------------------------------------------------------------
const migration = read('api/migrations/0115_commerce_webhook_inbox_lease.sql');
assert.match(migration, /add column if not exists "lease_expires_at" timestamptz/);
assert.match(migration, /'RECEIVED', 'PROCESSING', 'PROCESSED', 'IGNORED', 'FAILED'/);
const stack = read('infra/lib/stacks/api-stack.ts');
assert.ok(stack.includes("path: '/webhooks/stripe/platform'"));
assert.ok(stack.includes("path: '/webhooks/stripe/connect'"));
assert.match(stack, /COMMERCE_WEBHOOK_QUEUE_URL: racePicStack\.commerceWebhookQueue\.queueUrl/);
assert.match(stack, /commerceWebhookQueue\.grantSendMessages\(racePicApiHandler\)/);
assert.match(stack, /api\/src\/commerce\/webhookWorker\.ts/);
assert.match(stack, /maxConcurrency: 2/);
assert.match(stack, /resources: \[`\$\{racePicStack\.mediaBucket\.bucketArn\}\/commerce\/webhooks\/\*`\]/, 'Worker liest nur das Webhook-Praefix');
const racepicStack = read('infra/lib/stacks/racepic-stack.ts');
assert.match(racepicStack, /makeStage\('CommerceWebhook'\)/);
assert.match(racepicStack, /maxReceiveCount: 5/);
assert.doesNotMatch(read('api/src/commerce/webhooks.ts'), /console\./);

const secrets = { platform: 'whsec_platform_test', connect: 'whsec_connect_test' };
const sign = (endpoint, payload, secretOverride) => Stripe.webhooks.generateTestHeaderString({ payload, secret: secretOverride ?? secrets[endpoint] });
const eventPayload = (overrides = {}) =>
  JSON.stringify({ id: 'evt_test_1', object: 'event', type: 'account.updated', account: 'acct_1', data: { object: { object: 'account', id: 'acct_1' } }, ...overrides });

(async () => {
  const stripeClient = require('../dist/commerce/stripe/client.js');
  const webhooks = require('../dist/commerce/webhooks.js');

  // Echte Signaturpruefung der Stripe-Bibliothek mit den Secrets je Endpunkt.
  const verify = async (endpoint, raw, signature) => {
    if (!signature) throw new stripeClient.StripeWebhookError('SIGNATURE_MISSING');
    try {
      return Stripe.webhooks.constructEvent(raw, signature, secrets[endpoint]);
    } catch {
      throw new stripeClient.StripeWebhookError('SIGNATURE_INVALID');
    }
  };
  await assert.rejects(() => stripeClient.verifyStripeWebhook('platform', '{}', undefined), (e) => e.code === 'SIGNATURE_MISSING', 'ohne Header wird nicht einmal ein Secret geladen');

  const makeTx = (handlers) => {
    const log = [];
    return {
      log,
      query: async (text, values) => {
        const normalized = text.replace(/\s+/g, ' ').trim();
        log.push({ text: normalized, values });
        for (const [needle, respond] of handlers) if (normalized.includes(needle)) return respond(values, normalized);
        return { rows: [], rowCount: 0 };
      }
    };
  };
  const makeDeps = (overrides = {}) => {
    const puts = [];
    const sent = [];
    const files = new Map();
    return {
      puts,
      sent,
      files,
      deps: {
        store: { putPayload: async (key, body) => { puts.push({ key, body }); files.set(key, body); }, getPayload: async (key) => files.get(key) ?? null },
        queue: { send: async (id) => { sent.push(id); } },
        verify,
        stripe: async () => { throw new Error('Stripe wurde nicht erwartet'); },
        ...overrides
      }
    };
  };

  // --- Annahme -------------------------------------------------------------------------------------------
  const raw = eventPayload();
  const fresh = makeTx([['insert into commerce_webhook_inbox', () => ({ rows: [{ id: 'inbox-1' }], rowCount: 1 })]]);
  const freshDeps = makeDeps();
  const received = await webhooks.receiveWebhook(fresh, freshDeps.deps, { endpoint: 'connect', rawBody: raw, signature: sign('connect', raw) });
  assert.deepEqual(received, { inboxId: 'inbox-1', duplicate: false });
  assert.deepEqual(freshDeps.puts, [{ key: 'commerce/webhooks/stripe/connect/evt_test_1.json', body: raw }], 'exakter Rohbody wird abgelegt');
  assert.deepEqual(freshDeps.sent, ['inbox-1']);
  assert.deepEqual(fresh.log[0].values, ['connect', 'evt_test_1', 'account.updated', 'commerce/webhooks/stripe/connect/evt_test_1.json']);

  // Doppelte Zustellung: abgeschlossene Eintraege werden nicht erneut eingereiht, offene schon.
  for (const [status, expectSent] of [['PROCESSED', 0], ['IGNORED', 0], ['PROCESSING', 0], ['RECEIVED', 1], ['FAILED', 1]]) {
    const tx = makeTx([['select id, status from commerce_webhook_inbox', () => ({ rows: [{ id: 'inbox-1', status }], rowCount: 1 })]]);
    const d = makeDeps();
    const result = await webhooks.receiveWebhook(tx, d.deps, { endpoint: 'connect', rawBody: raw, signature: sign('connect', raw) });
    assert.equal(result.duplicate, true, status);
    assert.equal(d.sent.length, expectSent, `Status ${status}`);
  }

  // Ungueltige, manipulierte oder falsch adressierte Nachrichten hinterlassen nichts.
  const untouched = async (input, expectedCode) => {
    const tx = makeTx([]);
    const d = makeDeps();
    await assert.rejects(() => webhooks.receiveWebhook(tx, d.deps, input), (e) => e.code === expectedCode);
    assert.equal(tx.log.length + d.puts.length + d.sent.length, 0, 'nichts gespeichert, eingetragen oder eingereiht');
  };
  await untouched({ endpoint: 'connect', rawBody: raw, signature: undefined }, 'SIGNATURE_MISSING');
  await untouched({ endpoint: 'connect', rawBody: raw + ' ', signature: sign('connect', raw) }, 'SIGNATURE_INVALID');
  await untouched({ endpoint: 'connect', rawBody: raw, signature: sign('connect', raw, 'whsec_falsch') }, 'SIGNATURE_INVALID');
  await untouched({ endpoint: 'platform', rawBody: raw, signature: sign('connect', raw) }, 'SIGNATURE_INVALID'); // Secrets sind je Endpunkt getrennt
  const badId = eventPayload({ id: 'evt_../../geheim' });
  const badIdTx = makeTx([]);
  const badIdDeps = makeDeps();
  await assert.rejects(() => webhooks.receiveWebhook(badIdTx, badIdDeps.deps, { endpoint: 'connect', rawBody: badId, signature: sign('connect', badId) }), /EVENT_ID_INVALID/);
  assert.equal(badIdDeps.puts.length, 0, 'Event-ID wird nie Teil eines Speicherschluessels, wenn das Format nicht passt');

  // Queue-Ausfall: Fehler nach aussen (Stripe wiederholt); die Wiederholung reiht dann erneut ein.
  const queueDown = makeDeps({ queue: { send: async () => { throw new Error('sqs down'); } } });
  await assert.rejects(() => webhooks.receiveWebhook(fresh, queueDown.deps, { endpoint: 'connect', rawBody: raw, signature: sign('connect', raw) }), /sqs down/);

  // --- Verarbeitung ----------------------------------------------------------------------------------------
  const claimRow = (overrides = {}) => ({ id: 'inbox-1', endpoint: 'connect', event_id: 'evt_test_1', event_type: 'account.updated', payload_ref: 'commerce/webhooks/stripe/connect/evt_test_1.json', attempt_count: 1, ...overrides });
  const claimHandler = (row) => ['update commerce_webhook_inbox set status = \'PROCESSING\'', () => (row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 })];
  const statusUpdate = (tx) =>
    tx.log.find((entry) => entry.text.startsWith('update commerce_webhook_inbox set status = $2') || entry.text.startsWith("update commerce_webhook_inbox set status = 'FAILED'"));

  const active = { charges_enabled: false, payouts_enabled: true, details_submitted: true, capabilities: { transfers: 'active' }, requirements: { currently_due: [], past_due: [] } };
  const stripeFake = () => {
    const retrieved = [];
    return { retrieved, api: { accounts: { retrieve: async (id) => { retrieved.push(id); return active; } }, accountLinks: {} } };
  };
  const accountRow = ['from commerce_payment_account a join commerce_seller s', () => ({ rows: [{ seller_id: 's1', photographer_id: 'p1' }], rowCount: 1 })];

  // Bereits erledigt oder in Arbeit: ueberspringen.
  assert.equal(await webhooks.processInboxEntry(makeTx([claimHandler(null)]), makeDeps().deps, 'inbox-1'), 'skipped');

  // account.updated: aktueller Stand wird bei Stripe geholt (nicht aus der Nachricht) und angewendet.
  const stripe1 = stripeFake();
  const okDeps = makeDeps({ stripe: async () => stripe1.api });
  okDeps.files.set(claimRow().payload_ref, raw);
  const okTx = makeTx([claimHandler(claimRow()), accountRow]);
  assert.equal(await webhooks.processInboxEntry(okTx, okDeps.deps, 'inbox-1'), 'processed');
  assert.deepEqual(stripe1.retrieved, ['acct_1']);
  assert.ok(okTx.log.some((e) => e.text.startsWith('update commerce_payment_account')));
  assert.equal(okTx.log.find((e) => e.text.startsWith('update racepic_photographer set status')).values[1], 'PAYMENT_ENABLED');
  assert.equal(statusUpdate(okTx).values[1], 'PROCESSED');

  // Unbekanntes Konto, unbekannter Typ und Ereignisse des falschen Endpunkts werden verbucht, aber nicht behandelt.
  const unknownAccountDeps = makeDeps({ stripe: async () => stripe1.api });
  unknownAccountDeps.files.set(claimRow().payload_ref, raw);
  const unknownAccountTx = makeTx([claimHandler(claimRow())]);
  assert.equal(await webhooks.processInboxEntry(unknownAccountTx, unknownAccountDeps.deps, 'inbox-1'), 'ignored');
  assert.equal(statusUpdate(unknownAccountTx).values[1], 'IGNORED');
  const otherType = eventPayload({ type: 'charge.refunded' });
  const otherDeps = makeDeps();
  otherDeps.files.set(claimRow().payload_ref, otherType);
  assert.equal(await webhooks.processInboxEntry(makeTx([claimHandler(claimRow({ event_type: 'charge.refunded' }))]), otherDeps.deps, 'inbox-1'), 'ignored');
  const platformDeps = makeDeps({ stripe: async () => { throw new Error('darf nicht aufgerufen werden'); } });
  platformDeps.files.set(claimRow().payload_ref, raw);
  assert.equal(await webhooks.processInboxEntry(makeTx([claimHandler(claimRow({ endpoint: 'platform' })), accountRow]), platformDeps.deps, 'inbox-1'), 'ignored');

  // Fehler: FAILED mit kurzem Code (nie der Payload), Fehler wird weitergereicht (SQS wiederholt).
  const failCases = [
    ['payload fehlt', makeDeps(), claimRow(), /PAYLOAD_MISSING/],
    ['keine payload_ref', makeDeps(), claimRow({ payload_ref: null }), /PAYLOAD_REF_MISSING/],
    ['event-id passt nicht', (() => { const d = makeDeps(); d.files.set(claimRow().payload_ref, eventPayload({ id: 'evt_anders' })); return d; })(), claimRow(), /PAYLOAD_MISMATCH/],
    ['stripe nicht erreichbar', (() => { const d = makeDeps({ stripe: async () => ({ accounts: { retrieve: async () => { throw new Error('geheimes Detail acct_1 foto@example.org'); } } }) }); d.files.set(claimRow().payload_ref, raw); return d; })(), claimRow(), /STRIPE_UNAVAILABLE/]
  ];
  for (const [label, d, row, pattern] of failCases) {
    const tx = makeTx([claimHandler(row), accountRow]);
    await assert.rejects(() => webhooks.processInboxEntry(tx, d.deps, 'inbox-1'), pattern, label);
    const failed = tx.log.find((e) => e.text.includes("set status = 'FAILED'"));
    assert.ok(failed, `${label}: als FAILED verbucht`);
    assert.equal(String(failed.values[1]).includes('foto@example.org'), false, `${label}: keine Personendaten im Fehlerfeld`);
  }

  // Claim-Abfrage: nur offene Eintraege oder abgelaufene Leases.
  const claimSql = okTx.log[0].text;
  for (const part of ["status in ('RECEIVED', 'FAILED')", "status = 'PROCESSING' and lease_expires_at < now()", 'attempt_count = attempt_count + 1']) {
    assert.ok(claimSql.includes(part), `Claim prueft nicht: ${part}`);
  }

  // --- HTTP-Schicht ------------------------------------------------------------------------------------------
  const dbClient = require('../dist/db/client.js');
  const { handleWebhookRoutes } = require('../dist/commerce/webhookRoutes.js');
  const event = (method, routePath, body, headers = {}, isBase64Encoded = false) => ({
    requestContext: { http: { method, path: routePath, sourceIp: '198.51.100.7' } },
    headers,
    body,
    isBase64Encoded,
    queryStringParameters: {}
  });
  const previous = { checkout: process.env.COMMERCE_CHECKOUT, settlement: process.env.COMMERCE_SETTLEMENT };
  const originalGetPool = dbClient.getPool;
  try {
    assert.equal(await handleWebhookRoutes(event('POST', '/photographer/images', null)), null);
    delete process.env.COMMERCE_CHECKOUT;
    delete process.env.COMMERCE_SETTLEMENT;
    assert.equal((await handleWebhookRoutes(event('POST', '/webhooks/stripe/connect', raw, { 'stripe-signature': sign('connect', raw) }))).statusCode, 404, 'ohne Flags nicht erreichbar');

    process.env.COMMERCE_SETTLEMENT = 'true';
    dbClient.getPool = async () => makeTx([['insert into commerce_webhook_inbox', () => ({ rows: [{ id: 'inbox-9' }], rowCount: 1 })]]);
    const d = makeDeps();
    const routeDeps = { webhookDeps: d.deps };
    assert.equal((await handleWebhookRoutes(event('GET', '/webhooks/stripe/connect', null), routeDeps)).statusCode, 405);
    assert.equal((await handleWebhookRoutes(event('POST', '/webhooks/stripe/connect', raw, {}), routeDeps)).statusCode, 400, 'ohne Signatur');
    assert.equal((await handleWebhookRoutes(event('POST', '/webhooks/stripe/connect', raw, { 'stripe-signature': 't=1,v1=abc' }), routeDeps)).statusCode, 400, 'falsche Signatur');
    assert.equal((await handleWebhookRoutes(event('POST', '/webhooks/stripe/platform', raw, { 'stripe-signature': sign('connect', raw) }), routeDeps)).statusCode, 400, 'Secret des anderen Endpunkts');
    assert.equal(d.puts.length + d.sent.length, 0, 'abgelehnte Nachrichten hinterlassen nichts');

    const ok = await handleWebhookRoutes(event('POST', '/webhooks/stripe/connect', raw, { 'stripe-signature': sign('connect', raw) }), routeDeps);
    assert.equal(ok.statusCode, 200);
    assert.deepEqual(JSON.parse(ok.body), { received: true, duplicate: false });
    assert.deepEqual(d.sent, ['inbox-9']);

    // Base64-kodierter Body (API Gateway): dieselben Bytes, gleiche Signatur.
    const d2 = makeDeps();
    const b64 = await handleWebhookRoutes(event('POST', '/webhooks/stripe/connect', Buffer.from(raw, 'utf8').toString('base64'), { 'Stripe-Signature': sign('connect', raw) }, true), { webhookDeps: d2.deps });
    assert.equal(b64.statusCode, 200);
    assert.equal(d2.puts[0].body, raw, 'Rohbody unveraendert abgelegt');

    // Zu grosse Nachricht.
    assert.equal((await handleWebhookRoutes(event('POST', '/webhooks/stripe/connect', 'x'.repeat(1024 * 1024 + 1), { 'stripe-signature': 'x' }), routeDeps)).statusCode, 413);

    // Interne Fehler: 500 (Exception), damit Stripe wiederholt.
    await assert.rejects(
      () => handleWebhookRoutes(event('POST', '/webhooks/stripe/connect', raw, { 'stripe-signature': sign('connect', raw) }), { webhookDeps: makeDeps({ queue: { send: async () => { throw new Error('sqs down'); } } }).deps }),
      /sqs down/
    );

    // Checkout-Flag genuegt ebenfalls.
    delete process.env.COMMERCE_SETTLEMENT;
    process.env.COMMERCE_CHECKOUT = 'true';
    assert.equal((await handleWebhookRoutes(event('POST', '/webhooks/stripe/connect', raw, { 'stripe-signature': sign('connect', raw) }), routeDeps)).statusCode, 200);
  } finally {
    dbClient.getPool = originalGetPool;
    for (const [name, value] of [['COMMERCE_CHECKOUT', previous.checkout], ['COMMERCE_SETTLEMENT', previous.settlement]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  // --- Worker ------------------------------------------------------------------------------------------------
  const worker = require('../dist/commerce/webhookWorker.js');
  const workerResult = await worker.handler({
    Records: [
      { messageId: 'm1', body: '{kaputt' },
      { messageId: 'm2', body: JSON.stringify({}) }
    ]
  });
  assert.deepEqual(workerResult.batchItemFailures.map((item) => item.itemIdentifier), ['m1', 'm2'], 'ungueltige Nachrichten werden fuer die DLQ-Logik gemeldet');

  console.log('commerce-webhooks.test.js ok');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
