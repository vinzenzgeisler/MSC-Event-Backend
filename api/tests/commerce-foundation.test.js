const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

// --- Migration 0110 (Schema) -------------------------------------------------------------------
const schema = read('api/migrations/0110_commerce_core.sql');
for (const table of [
  'commerce_seller',
  'commerce_payment_account',
  'commerce_buyer_account',
  'commerce_customer',
  'commerce_product',
  'commerce_offer_version',
  'commerce_quote',
  'commerce_order',
  'commerce_order_item',
  'commerce_payment',
  'commerce_refund',
  'commerce_refund_item',
  'commerce_dispute',
  'commerce_entitlement',
  'commerce_transfer',
  'commerce_transfer_reversal',
  'commerce_seller_balance',
  'commerce_invoice',
  'commerce_seller_statement',
  'commerce_legal_acceptance',
  'commerce_webhook_inbox',
  'racepic_offer_conversion',
  'racepic_offer_conversion_item'
]) {
  assert.match(schema, new RegExp(`create table if not exists "${table}"`), `Tabelle ${table} fehlt`);
}
// Hard Deletes auf Bilder/Fotografen sperren: keine CASCADE-Referenzen in der Commerce-Migration.
assert.doesNotMatch(schema, /on delete cascade/i);
assert.match(schema, /references "racepic_image"\("id"\) on delete restrict/);
assert.match(schema, /references "racepic_photographer"\("id"\) on delete restrict/);
// Steuerstatus startet ungeklaert und blockiert Auszahlungen; kein fest verdrahteter Steuersatz.
assert.match(schema, /"tax_status" text not null default 'UNCLEARED'/);
assert.match(schema, /"payouts_blocked" boolean not null default true/);
assert.doesNotMatch(schema, /"tax_rate_bp" integer(?: not null)? default/);
// Preisstufen und Immutability.
assert.match(schema, /"price_cents" in \(500, 1000, 1500, 2000\)/);
assert.match(schema, /commerce_offer_version_active_unique/);
assert.match(schema, /commerce_offer_version_immutable_trg/);
assert.match(schema, /"currency" = 'EUR'/);

// --- Migration 0111 (Backfill) ------------------------------------------------------------------
const backfill = read('api/migrations/0111_commerce_backfill.sql');
assert.match(backfill, /not exists/);
assert.match(backfill, /'FREE', 0, 'EUR'/);
assert.match(backfill, /commerce_backfill_conflicts/);
assert.match(backfill, /PAID_IMAGE_WITHOUT_OFFER/);
assert.doesNotMatch(backfill, /delete from|drop table|update "racepic_image"/i);

// --- Feature-Flags ------------------------------------------------------------------------------
const { getCommerceFlags } = require('../dist/commerce/flags.js');
assert.deepEqual(getCommerceFlags({}), {
  commerceBuyerAccounts: false,
  commercePaidOffers: false,
  commerceCheckout: false,
  commerceSettlement: false,
  commerceFreeToPaidConversion: false
});
assert.equal(getCommerceFlags({ COMMERCE_CHECKOUT: '' }).commerceCheckout, false);
assert.equal(getCommerceFlags({ COMMERCE_CHECKOUT: '1' }).commerceCheckout, false);
assert.equal(getCommerceFlags({ COMMERCE_CHECKOUT: ' TRUE ' }).commerceCheckout, true);
assert.equal(getCommerceFlags({ COMMERCE_CHECKOUT: 'true' }).commercePaidOffers, false);

const infraFlags = read('infra/lib/config/commerce-flags.ts');
assert.match(infraFlags, /=== 'true'/);
assert.match(read('infra/lib/config/dev.ts'), /commerceFlags: readCommerceFlags\('DEV'\)/);
assert.match(read('infra/lib/config/prod.ts'), /commerceFlags: readCommerceFlags\('PROD'\)/);
assert.match(read('api/src/racepic/handler.ts'), /commerce: getCommerceFlags\(\)/);

// --- Stripe-Adapter -----------------------------------------------------------------------------
const { parseStripeSecrets, StripeConfigError } = require('../dist/commerce/stripe/client.js');
assert.deepEqual(
  parseStripeSecrets(JSON.stringify({ secretKey: ' sk_test_x ', platformWebhookSecret: 'whsec_a', connectWebhookSecret: 'whsec_b' })),
  { secretKey: 'sk_test_x', platformWebhookSecret: 'whsec_a', connectWebhookSecret: 'whsec_b' }
);
assert.throws(() => parseStripeSecrets('kein json'), StripeConfigError);
assert.throws(() => parseStripeSecrets(JSON.stringify({ secretKey: 'sk_test_x' })), StripeConfigError);
assert.doesNotMatch(read('api/src/commerce/stripe/client.ts'), /console\./);
assert.match(read('api/package.json'), /"stripe": "22\.6\.2"/);
assert.match(read('infra/lib/stacks/api-stack.ts'), /stripeSecret\.grantRead\(racePicApiHandler\)/);

// --- Angebotsversionen (AP07) -------------------------------------------------------------------
const offers = require('../dist/commerce/offers.js');
assert.deepEqual([...offers.PRICE_TIERS_CENTS], [500, 1000, 1500, 2000]);
assert.equal(offers.isValidPriceTier(1000), true);
assert.equal(offers.isValidPriceTier(999), false);
assert.equal(offers.isValidPriceTier(0), false);

/** Skriptbarer Fake: protokolliert SQL in Reihenfolge und liefert Ergebnisse anhand des SQL-Textes. */
const makeTx = (handlers) => {
  const calls = [];
  return {
    calls,
    query: async (text, values) => {
      calls.push({ text: text.replace(/\s+/g, ' ').trim(), values });
      for (const [needle, respond] of handlers) {
        if (text.includes(needle)) return respond(values);
      }
      return { rows: [], rowCount: 0 };
    }
  };
};

const baseInput = {
  productId: 'p1',
  mode: 'PAID',
  priceCents: 1000,
  licenseId: 'l1',
  sellerId: 's1',
  createdBy: 'admin@example.org'
};

(async () => {
  // Ungueltige Eingaben erreichen die Datenbank nie.
  for (const bad of [
    { ...baseInput, priceCents: 750 },
    { ...baseInput, mode: 'FREE', priceCents: 500 }
  ]) {
    const tx = makeTx([]);
    await assert.rejects(() => offers.activateNewOfferVersion(tx, bad), offers.OfferError);
    assert.equal(tx.calls.length, 0);
  }

  // Aktivierung: Lock -> naechste Version -> alte Version beenden -> neue einfuegen (in dieser Reihenfolge).
  const tx = makeTx([
    ['for update', () => ({ rows: [{ id: 'p1' }], rowCount: 1 })],
    ['max(version)', () => ({ rows: [{ next: 3 }], rowCount: 1 })],
    ['insert into commerce_offer_version', (values) => ({ rows: [{ id: 'o3', version: values[1], status: values[6] }], rowCount: 1 })]
  ]);
  const created = await offers.activateNewOfferVersion(tx, baseInput);
  assert.equal(created.version, 3);
  assert.equal(created.status, 'ACTIVE');
  const order = tx.calls.map((c) => c.text.split(' ').slice(0, 3).join(' '));
  assert.deepEqual(order, ['select id from', 'select coalesce(max(version), 0)', "update commerce_offer_version set", 'insert into commerce_offer_version']);
  assert.match(tx.calls[2].text, /status = 'RETIRED'/);

  // Unbekanntes Produkt.
  await assert.rejects(
    () => offers.activateNewOfferVersion(makeTx([]), baseInput),
    (error) => error instanceof offers.OfferError && error.code === 'PRODUCT_NOT_FOUND'
  );

  // Paralleles zweites Freigeben derselben Version scheitert nach dem Lock am Status.
  const staleTx = makeTx([
    ['select * from commerce_offer_version where id', () => ({ rows: [{ id: 'o9', product_id: 'p1', status: 'ACTIVE' }], rowCount: 1 })],
    ['for update', () => ({ rows: [{ id: 'p1' }], rowCount: 1 })]
  ]);
  await assert.rejects(
    () => offers.activatePendingOfferVersion(staleTx, 'o9'),
    (error) => error instanceof offers.OfferError && error.code === 'OFFER_NOT_PENDING'
  );
  assert.equal(staleTx.calls.some((c) => c.text.includes("status = 'RETIRED'")), false);

  // Ablehnen nur aus PENDING_REVIEW.
  await assert.rejects(
    () => offers.rejectPendingOfferVersion(makeTx([]), 'o9'),
    (error) => error instanceof offers.OfferError && error.code === 'OFFER_NOT_PENDING'
  );

  // Transaktionshelfer: Rollback bei Fehler, Connection wird immer freigegeben.
  const log = [];
  const pool = {
    connect: async () => ({
      query: async (text) => {
        log.push(text);
        return { rows: [], rowCount: 0 };
      },
      release: () => log.push('release')
    })
  };
  await assert.rejects(() => offers.withTransaction(pool, async () => { throw new Error('boom'); }), /boom/);
  assert.deepEqual(log, ['begin', 'rollback', 'release']);
  log.length = 0;
  assert.equal(await offers.withTransaction(pool, async () => 42), 42);
  assert.deepEqual(log, ['begin', 'commit', 'release']);

  // Produktadapter.
  const { getProductTypeHandler } = require('../dist/commerce/productTypes.js');
  assert.equal(getProductTypeHandler('RACEPIC_IMAGE_LICENSE').productType, 'RACEPIC_IMAGE_LICENSE');
  assert.throws(() => getProductTypeHandler('MERCH'), /Unbekannter Produkttyp/);

  console.log('commerce-foundation.test.js ok');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
