const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

// --- Migration und Routen --------------------------------------------------------------------------------
const migration = read('api/migrations/0117_commerce_quote_consumption.sql');
assert.match(migration, /add column if not exists "consumed_at" timestamptz/);
const stack = read('infra/lib/stacks/api-stack.ts');
assert.ok(stack.includes("path: '/public/commerce/checkout-sessions'"));
assert.ok(stack.includes("path: '/public/commerce/orders/{orderId}'"));
assert.doesNotMatch(read('api/src/commerce/checkout.ts'), /console\./);

const img1 = '11111111-1111-4111-8111-111111111111';
const item = (overrides = {}) => ({
  grossCents: 1000, netCents: 840, taxCents: 160, taxRateBp: 1900, commissionCents: 168, sellerShareCents: 672, sellerShareBasis: 'NET',
  imageId: img1, productId: 'prod-1', offerVersionId: 'offer-1', sellerId: 'seller-1', license: { code: 'PAID_PRIVATE', version: 1 }, ...overrides
});

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

(async () => {
  const checkout = require('../dist/commerce/checkout.js');
  const webhooks = require('../dist/commerce/webhooks.js');
  const legal = require('../dist/commerce/legal.js');

  const fullAcceptance = { terms: true, license: true, privacy: true, withdrawal: true, digitalContentWaiver: true };
  const baseInput = { quoteId: 'q1', email: ' Kaeufer@Example.COM ', legalAcceptance: fullAcceptance, websiteBaseUrl: 'https://msc.example' };

  // --- Quote -> Bestellung ------------------------------------------------------------------------------
  const quoteRow = { id: 'q1', email_norm: null, items: [item()], gross_cents: 1000, net_cents: 840, tax_cents: 160 };
  const makePool = (handlers) => {
    const log = [];
    const client = { query: async (text, values) => makeTx(handlers).query(text, values), release: () => undefined };
    return {
      log,
      query: async (text, values) => {
        const normalized = text.replace(/\s+/g, ' ').trim();
        log.push({ text: normalized, values });
        for (const [needle, respond] of handlers) if (normalized.includes(needle)) return respond(values, normalized);
        return { rows: [], rowCount: 0 };
      },
      connect: async () => ({
        query: async (text, values) => {
          const normalized = text.replace(/\s+/g, ' ').trim();
          log.push({ text: normalized, values });
          for (const [needle, respond] of handlers) if (normalized.includes(needle)) return respond(values, normalized);
          return { rows: [], rowCount: 0 };
        },
        release: () => undefined
      })
    };
  };
  const makeStripe = (overrides = {}) => {
    const calls = { create: [] };
    return { calls, checkout: { sessions: { create: async (params, options) => { calls.create.push({ params, options }); return { id: 'cs_test_1', url: 'https://checkout.stripe.test/cs_test_1' }; } } }, ...overrides };
  };

  await assert.rejects(() => checkout.createCheckoutSession(makePool([]), makeStripe(), { ...baseInput, websiteBaseUrl: '' }), (e) => e.code === 'CHECKOUT_URLS_MISSING');

  // Quote nicht gefunden / abgelaufen / schon verbraucht: derselbe Fehler, keine Bestellung, kein Stripe-Aufruf.
  const noneClaimedPool = makePool([['update commerce_quote set consumed_at', () => ({ rows: [], rowCount: 0 })]]);
  const stripeUntouched = makeStripe();
  await assert.rejects(() => checkout.createCheckoutSession(noneClaimedPool, stripeUntouched, baseInput), (e) => e.code === 'QUOTE_NOT_FOUND');
  assert.equal(stripeUntouched.calls.create.length, 0);
  assert.equal(noneClaimedPool.log.some((e) => e.text.startsWith('insert into commerce_order')), false);

  // Erfolgreicher Ablauf.
  const stripe = makeStripe();
  const pool = makePool([
    ['update commerce_quote set consumed_at', () => ({ rows: [quoteRow], rowCount: 1 })],
    ['insert into commerce_order', () => ({ rows: [{ id: 'order-1' }], rowCount: 1 })]
  ]);
  const result = await checkout.createCheckoutSession(pool, stripe, baseInput);
  assert.deepEqual(result, { orderId: 'order-1', url: 'https://checkout.stripe.test/cs_test_1' });

  // E-Mail normalisiert (Trim + lowercase), Bestellung mit Snapshot-Betraegen, ein Order-Item pro Quote-Position.
  const orderInsert = pool.log.find((e) => e.text.startsWith('insert into commerce_order ('));
  assert.deepEqual(orderInsert.values.slice(1), ['kaeufer@example.com', 1000, 840, 160, JSON.stringify(legal.LEGAL_DOCUMENT_VERSIONS)]);
  const itemInsert = pool.log.find((e) => e.text.startsWith('insert into commerce_order_item'));
  assert.deepEqual(itemInsert.values, ['order-1', 'prod-1', 'offer-1', 'seller-1', 1000, 840, 160, 168, 672, JSON.stringify({ code: 'PAID_PRIVATE', version: 1 }), 'NET', 1900]);
  const legalInsert = pool.log.find((e) => e.text.startsWith('insert into commerce_legal_acceptance'));
  assert.deepEqual(legalInsert.values, ['order-1', 'kaeufer@example.com', JSON.stringify(fullAcceptance)]);

  // Stripe-Session: eine Zeile pro Position, Betrag aus dem Snapshot (nie vom Client), Order-ID in success_url/Metadaten, stabiler Idempotency-Key.
  const call = stripe.calls.create[0];
  assert.equal(call.params.mode, 'payment');
  assert.equal(call.params.customer_email, 'kaeufer@example.com');
  assert.equal(call.params.client_reference_id, 'order-1');
  assert.equal(call.params.metadata.commerce_order_id, 'order-1');
  assert.equal(call.params.payment_intent_data.metadata.commerce_order_id, 'order-1');
  assert.equal(call.params.success_url, 'https://msc.example/racepic/kauf/erfolg?order=order-1&session_id={CHECKOUT_SESSION_ID}');
  assert.equal(call.params.cancel_url, 'https://msc.example/racepic/kauf/abgebrochen?order=order-1');
  assert.equal(call.params.line_items.length, 1);
  assert.equal(call.params.line_items[0].price_data.unit_amount, 1000);
  assert.equal(call.params.line_items[0].price_data.currency, 'eur');
  assert.equal(call.options.idempotencyKey, 'racepic-checkout-order-1');

  // Zahlungszeile wird erst nach der Stripe-Session angelegt, mit deren ID.
  const paymentInsert = pool.log.find((e) => e.text.startsWith('insert into commerce_payment'));
  assert.deepEqual(paymentInsert.values, ['order-1', 'cs_test_1', 1000]);

  // Zwei Positionen gleicher Betrag summiert in der Quote, aber pro Position eigene Zeile.
  const twoItemsPool = makePool([
    ['update commerce_quote set consumed_at', () => ({ rows: [{ ...quoteRow, items: [item(), item({ imageId: '22222222-2222-4222-8222-222222222222', productId: 'prod-2', offerVersionId: 'offer-2' })], gross_cents: 2000 }], rowCount: 1 })],
    ['insert into commerce_order', () => ({ rows: [{ id: 'order-2' }], rowCount: 1 })]
  ]);
  const twoStripe = makeStripe();
  await checkout.createCheckoutSession(twoItemsPool, twoStripe, { ...baseInput, quoteId: 'q2' });
  assert.equal(twoStripe.calls.create[0].params.line_items.length, 2);

  // Stripe-Ausfall: Fehlermeldung enthaelt keine internen Details; die Bestellung existiert bereits (kein Rollback ueber Prozessgrenzen, bewusst).
  const failingStripe = makeStripe({ checkout: { sessions: { create: async () => { throw new Error('sk_test_geheim'); } } } });
  const failingPool = makePool([
    ['update commerce_quote set consumed_at', () => ({ rows: [{ ...quoteRow, items: [item()] }], rowCount: 1 })],
    ['insert into commerce_order', () => ({ rows: [{ id: 'order-3' }], rowCount: 1 })]
  ]);
  await assert.rejects(() => checkout.createCheckoutSession(failingPool, failingStripe, { ...baseInput, quoteId: 'q3' }), (e) => e.code === 'STRIPE_UNAVAILABLE' && !e.message.includes('sk_test'));
  assert.equal(failingPool.log.some((e) => e.text.startsWith('insert into commerce_payment')), false);

  // --- Kaeuferbestaetigung -------------------------------------------------------------------------------
  const orderId = 'order-1';
  const presigned = [];
  const confirmationDeps = { presignLicensedFull: async (imageId, offerVersionId) => { presigned.push([imageId, offerVersionId]); return `https://cdn.example/${imageId}/${offerVersionId}`; } };

  await assert.rejects(() => checkout.getOrderConfirmation(makeTx([]), orderId, 'cs_test_1', confirmationDeps), (e) => e.code === 'ORDER_NOT_FOUND');
  await assert.rejects(
    () => checkout.getOrderConfirmation(makeTx([['from commerce_payment where order_id', () => ({ rows: [{ status: 'PENDING', provider_checkout_session_id: 'cs_other' }], rowCount: 1 })]]), orderId, 'cs_test_1', confirmationDeps),
    (e) => e.code === 'ORDER_ACCESS_DENIED'
  );
  const pending = await checkout.getOrderConfirmation(
    makeTx([['from commerce_payment where order_id', () => ({ rows: [{ status: 'PENDING', provider_checkout_session_id: 'cs_test_1' }], rowCount: 1 })]]),
    orderId, 'cs_test_1', confirmationDeps
  );
  assert.deepEqual(pending, { status: 'PENDING', items: [] });
  assert.equal(presigned.length, 0, 'keine Downloadlinks, solange nicht bezahlt');

  const paidRow = {
    order_item_id: 'oi-1', offer_version_id: 'offer-1', gross_cents: 1000, racepic_image_id: img1, image_title: 'Kurve 3',
    photographer_name: 'Foto Fritz', copyright_line: '© Foto Fritz', license_code: 'PAID_PRIVATE', license_title: { de: 'Privat' }, attribution_required: false, attribution_template: null
  };
  const paid = await checkout.getOrderConfirmation(
    makeTx([
      ['from commerce_payment where order_id', () => ({ rows: [{ status: 'PAID', provider_checkout_session_id: 'cs_test_1' }], rowCount: 1 })],
      ['from commerce_order_item oi', () => ({ rows: [paidRow], rowCount: 1 })]
    ]),
    orderId, 'cs_test_1', confirmationDeps
  );
  assert.equal(paid.status, 'PAID');
  assert.deepEqual(paid.items[0], {
    imageId: img1, title: 'Kurve 3', priceCents: 1000, downloadUrl: `https://cdn.example/${img1}/offer-1`,
    attribution: { photographerName: 'Foto Fritz', copyrightLine: '© Foto Fritz', licenseCode: 'PAID_PRIVATE', licenseTitle: { de: 'Privat' }, attributionRequired: false, attributionTemplate: null }
  });

  // --- Webhook-Erfuellung (checkout.session.completed) --------------------------------------------------
  const makeSession = (overrides = {}) => ({ id: 'cs_test_1', object: 'checkout.session', payment_status: 'paid', payment_intent: 'pi_1', metadata: { commerce_order_id: orderId }, client_reference_id: orderId, ...overrides });
  const wrapEvent = (session) => ({ id: 'evt_1', type: 'checkout.session.completed', data: { object: session } });
  const deps = { store: {}, queue: {}, verify: async () => {}, stripe: async () => { throw new Error('nicht erwartet'); } };
  const ctx = (tx) => ({ tx, deps, endpoint: 'platform' });

  assert.equal(await webhooks.webhookHandlers['platform:checkout.session.completed'](ctx(makeTx([])), wrapEvent(makeSession({ payment_status: 'unpaid' }))), 'IGNORED');
  assert.equal(await webhooks.webhookHandlers['platform:checkout.session.completed'](ctx(makeTx([])), wrapEvent(makeSession({ metadata: {}, client_reference_id: null }))), 'IGNORED');
  assert.equal(await webhooks.webhookHandlers['platform:checkout.session.completed'](ctx(makeTx([])), wrapEvent(makeSession())), 'IGNORED', 'unbekannte Bestellung');

  const fulfillTx = makeTx([
    ['from commerce_payment where order_id', () => ({ rows: [{ id: 'pay-1', status: 'PENDING' }], rowCount: 1 })],
    ["update commerce_payment set status = 'PAID'", () => ({ rows: [], rowCount: 1 })],
    ['from commerce_order_item where order_id', () => ({ rows: [{ id: 'oi-1', seller_id: 'seller-1', seller_share_cents: 672, license_snapshot: { code: 'PAID_PRIVATE', version: 1 } }], rowCount: 1 })],
    ['from commerce_order where id', () => ({ rows: [{ email_norm: 'kaeufer@example.com' }], rowCount: 1 })]
  ]);
  assert.equal(await webhooks.webhookHandlers['platform:checkout.session.completed'](ctx(fulfillTx), wrapEvent(makeSession())), 'HANDLED');
  assert.ok(fulfillTx.log.some((e) => e.text.startsWith("update commerce_order set status = 'PAID'")));
  const entitlementInsert = fulfillTx.log.find((e) => e.text.startsWith('insert into commerce_entitlement'));
  assert.deepEqual(entitlementInsert.values, ['oi-1', 'kaeufer@example.com', JSON.stringify({ code: 'PAID_PRIVATE', version: 1 })]);
  const transferInsert = fulfillTx.log.find((e) => e.text.startsWith('insert into commerce_transfer'));
  assert.deepEqual(transferInsert.values, ['oi-1', 'seller-1', 672]);
  assert.match(transferInsert.text, /'HELD', now\(\) \+ interval '14 days'/);

  // Zustandsbasiert idempotent: bereits bezahlte Bestellung wird bei erneuter Zustellung nicht doppelt verbucht.
  const duplicateTx = makeTx([
    ['from commerce_payment where order_id', () => ({ rows: [{ id: 'pay-1', status: 'PAID' }], rowCount: 1 })],
    ['from commerce_order_item where order_id', () => ({ rows: [{ id: 'oi-1', seller_id: 'seller-1', seller_share_cents: 672, license_snapshot: {} }], rowCount: 1 })],
    ['from commerce_order where id', () => ({ rows: [{ email_norm: 'kaeufer@example.com' }], rowCount: 1 })]
  ]);
  assert.equal(await webhooks.webhookHandlers['platform:checkout.session.completed'](ctx(duplicateTx), wrapEvent(makeSession())), 'HANDLED');
  assert.equal(duplicateTx.log.some((e) => e.text.startsWith("update commerce_payment set status = 'PAID'")), false, 'kein erneutes Umschalten auf PAID');
  // Die Inserts laufen erneut, aber "on conflict do nothing" macht das ungefaehrlich (kein zweites Entitlement/Transfer in echter DB).
  assert.match(duplicateTx.log.find((e) => e.text.startsWith('insert into commerce_entitlement')).text, /on conflict \(order_item_id\) do nothing/);
  assert.match(duplicateTx.log.find((e) => e.text.startsWith('insert into commerce_transfer')).text, /on conflict \(order_item_id\) do nothing/);

  console.log('commerce-checkout.test.js ok');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
