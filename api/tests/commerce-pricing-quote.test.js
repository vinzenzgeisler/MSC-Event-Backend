const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

// --- Migration 0114 -------------------------------------------------------------------------------------
const migration = read('api/migrations/0114_commerce_settings.sql');
assert.match(migration, /"sale_tax_rate_bp" integer,/, 'Verkaufssteuersatz ist nullable (noch nicht entschieden)');
assert.doesNotMatch(migration, /"sale_tax_rate_bp" integer(?: not null)? default/, 'kein Standard-Steuersatz');
assert.match(migration, /"seller_share_basis" text not null default 'NET'/);
assert.match(migration, /commerce_settings_version_immutable_trg/);
assert.match(migration, /before update or delete/);
assert.match(migration, /select 1, null, 2000, 'NET'/, 'Startversion ohne Steuersatz');
assert.match(migration, /add column if not exists "seller_share_basis" text/);

const pricing = require('../dist/commerce/pricing.js');
const settings = (overrides = {}) => ({ saleTaxRateBp: 1900, commissionBp: 2000, sellerShareBasis: 'NET', sellerVatRateBp: null, artistSocialLevyBp: 0, ...overrides });

// --- Rundung ---------------------------------------------------------------------------------------------
assert.equal(pricing.roundDiv(7, 2), 4);
assert.equal(pricing.roundDiv(5, 2), 3);
assert.equal(pricing.roundDiv(4, 3), 1);
assert.equal(pricing.roundDiv(0, 5), 0);

// --- Verkauf: Beispielrechnung aus der Steuerdiskussion (10,00 EUR brutto) ---------------------------------
const at19 = pricing.priceSale(1000, settings());
assert.deepEqual(
  { gross: at19.grossCents, net: at19.netCents, tax: at19.taxCents, seller: at19.sellerShareCents, msc: at19.commissionCents },
  { gross: 1000, net: 840, tax: 160, seller: 672, msc: 168 }
);
const at7 = pricing.priceSale(1000, settings({ saleTaxRateBp: 700 }));
assert.deepEqual([at7.netCents, at7.taxCents, at7.sellerShareCents, at7.commissionCents], [935, 65, 748, 187]);
const gross = pricing.priceSale(1000, settings({ sellerShareBasis: 'GROSS' }));
assert.deepEqual([gross.sellerShareCents, gross.commissionCents, gross.sellerShareBasis], [800, 200, 'GROSS']);
assert.equal(pricing.priceSale(1000, settings({ commissionBp: 0 })).commissionCents, 0);
assert.equal(pricing.priceSale(1000, settings({ saleTaxRateBp: 0 })).taxCents, 0);
// Cent-Rest geht an den MSC.
const remainder = pricing.priceSale(841 + 160 - 160, settings({ saleTaxRateBp: 0 }));
assert.equal(remainder.sellerShareCents, 672);
assert.equal(remainder.commissionCents, 169);
// Angebotsspezifischer Satz hat Vorrang.
assert.equal(pricing.priceSale(1000, settings(), 700).taxCents, 65);
// Ohne Steuersatz wird nichts berechnet.
assert.throws(() => pricing.priceSale(1000, settings({ saleTaxRateBp: null })), (e) => e.code === 'TAX_NOT_CONFIGURED');
assert.equal(pricing.priceSale(1000, settings({ saleTaxRateBp: null }), 700).taxCents, 65, 'ein Angebotssatz genuegt');
for (const bad of [0, -5, 10.5, NaN]) assert.throws(() => pricing.priceSale(bad, settings()), (e) => e.code === 'INVALID_AMOUNT');
for (const bad of [{ commissionBp: 10001 }, { commissionBp: -1 }, { saleTaxRateBp: 3001 }, { sellerShareBasis: 'X' }, { artistSocialLevyBp: 1001 }, { sellerVatRateBp: 4000 }]) {
  assert.throws(() => pricing.priceSale(1000, settings(bad)), (e) => e.code === 'INVALID_SETTINGS', JSON.stringify(bad));
}

// --- Gutschriftszeile zum Abrechnungszeitpunkt -------------------------------------------------------------
const line = (input) => pricing.sellerLine({ basis: 'NET', shareCents: 672, sellerTaxStatus: 'REGULAR', saleTaxRateBp: 1900, sellerVatRateBp: null, ...input });
assert.deepEqual(line({}), { netCents: 672, vatCents: 128, payableCents: 800, vatRateBp: 1900 });
assert.deepEqual(line({ sellerTaxStatus: 'SMALL_BUSINESS' }), { netCents: 672, vatCents: 0, payableCents: 672, vatRateBp: 0 });
assert.deepEqual(line({ sellerTaxStatus: 'PRIVATE' }), { netCents: 672, vatCents: 0, payableCents: 672, vatRateBp: 0 });
assert.deepEqual(line({ sellerVatRateBp: 700 }), { netCents: 672, vatCents: 47, payableCents: 719, vatRateBp: 700 });
assert.throws(() => line({ sellerTaxStatus: 'UNCLEARED' }), (e) => e.code === 'SELLER_TAX_UNCLEARED');
const grossRegular = line({ basis: 'GROSS', shareCents: 800 });
assert.deepEqual(grossRegular, { netCents: 672, vatCents: 128, payableCents: 800, vatRateBp: 1900 });
assert.deepEqual(line({ basis: 'GROSS', shareCents: 800, sellerTaxStatus: 'SMALL_BUSINESS' }), { netCents: 800, vatCents: 0, payableCents: 800, vatRateBp: 0 });
assert.equal(pricing.artistSocialLevyCents(672, 490), 33);
assert.equal(pricing.artistSocialLevyCents(672, 0), 0);

// Kern der Modellwahl: Bezogen auf Netto ist der MSC-Ertrag unabhaengig vom Steuerstatus des Fotografen,
// bezogen auf Brutto nicht (dort kann er bei Kleinunternehmern auf 0 fallen).
const mscMargin = (sale, seller) => sale.grossCents - seller.payableCents - (sale.taxCents - seller.vatCents);
for (const price of [500, 1000, 1500, 2000]) {
  for (const rate of [0, 700, 1900]) {
    const sale = pricing.priceSale(price, settings({ saleTaxRateBp: rate }));
    const regular = pricing.sellerLine({ basis: 'NET', shareCents: sale.sellerShareCents, sellerTaxStatus: 'REGULAR', saleTaxRateBp: rate, sellerVatRateBp: null });
    const small = pricing.sellerLine({ basis: 'NET', shareCents: sale.sellerShareCents, sellerTaxStatus: 'SMALL_BUSINESS', saleTaxRateBp: rate, sellerVatRateBp: null });
    assert.equal(mscMargin(sale, regular), sale.commissionCents, `NET regular ${price}/${rate}`);
    assert.equal(mscMargin(sale, small), sale.commissionCents, `NET small ${price}/${rate}`);
    assert.equal(sale.commissionCents + sale.sellerShareCents, sale.netCents);
    assert.equal(sale.netCents + sale.taxCents, sale.grossCents);
  }
}
const grossSale = pricing.priceSale(1000, settings({ sellerShareBasis: 'GROSS' }));
const grossSmall = pricing.sellerLine({ basis: 'GROSS', shareCents: grossSale.sellerShareCents, sellerTaxStatus: 'SMALL_BUSINESS', saleTaxRateBp: 1900, sellerVatRateBp: null });
assert.equal(mscMargin(grossSale, grossSmall), 40, 'bei Bezug auf Brutto bleiben nur 0,40 EUR (Bezugsgroessen-Effekt), vor Zahlungsgebuehr');
assert.equal(pricing.sumSales([at19, at7]).grossCents, 2000);

(async () => {
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
  const settingsRow = (overrides = {}) => ({
    id: 'set-1', version: 1, sale_tax_rate_bp: null, commission_bp: 2000, seller_share_basis: 'NET', seller_vat_rate_bp: null,
    artist_social_levy_bp: 0, note: null, created_by: 'x', created_at: new Date('2026-09-28T10:00:00Z'), ...overrides
  });

  // --- Einstellungen ------------------------------------------------------------------------------------
  const settingsService = require('../dist/commerce/settings.js');
  await assert.rejects(() => settingsService.loadCurrentSettings(makeTx([])), (e) => e.code === 'SETTINGS_MISSING');
  const current = await settingsService.loadCurrentSettings(makeTx([['from commerce_settings_version', () => ({ rows: [settingsRow()], rowCount: 1 })]]));
  assert.equal(current.saleTaxRateBp, null);
  assert.equal(current.commissionBp, 2000);
  const input = { ...settings({ saleTaxRateBp: 700 }), expectedVersion: 1, note: 'Steuerberatung: 7 %', actor: 'admin-1' };
  const okTx = makeTx([
    ['select * from commerce_settings_version', () => ({ rows: [settingsRow()], rowCount: 1 })],
    ['insert into commerce_settings_version', (values) => ({ rows: [settingsRow({ id: 'set-2', version: values[0], sale_tax_rate_bp: values[1] })], rowCount: 1 })]
  ]);
  const created = await settingsService.createSettingsVersion(okTx, input);
  assert.deepEqual([created.version, created.saleTaxRateBp], [2, 700]);
  await assert.rejects(() => settingsService.createSettingsVersion(okTx, { ...input, expectedVersion: 5 }), (e) => e.code === 'SETTINGS_VERSION_CONFLICT');
  const racing = makeTx([
    ['select * from commerce_settings_version', () => ({ rows: [settingsRow()], rowCount: 1 })],
    ['insert into commerce_settings_version', () => { const error = new Error('dup'); error.code = '23505'; throw error; }]
  ]);
  await assert.rejects(() => settingsService.createSettingsVersion(racing, input), (e) => e.code === 'SETTINGS_VERSION_CONFLICT');
  await assert.rejects(() => settingsService.createSettingsVersion(okTx, { ...input, commissionBp: 20000 }), (e) => e.code === 'INVALID_SETTINGS');
  assert.equal(okTx.log.filter((entry) => entry.text.startsWith('insert into commerce_settings_version')).length, 1, 'ungueltige/kollidierende Aufrufe schreiben nichts');

  // --- Quote --------------------------------------------------------------------------------------------
  const quoteService = require('../dist/commerce/quote.js');
  const img1 = '11111111-1111-4111-8111-111111111111';
  const img2 = '22222222-2222-4222-8222-222222222222';
  const img3 = '33333333-3333-4333-8333-333333333333';
  const offerRow = (imageId, price = 1000, extra = {}) => ({
    image_id: imageId, product_id: `prod-${imageId.slice(0, 2)}`, seller_id: 'seller-1', offer_id: `offer-${imageId.slice(0, 2)}`, offer_version: 2,
    price_cents: price, tax_rate_bp: null, license_code: 'PAID_PRIVATE', license_version: 1, ...extra
  });
  const withRate = { ...settings(), id: 'set-9' };
  const quoteTx = (rows) => makeTx([
    ['from racepic_image i', () => ({ rows, rowCount: rows.length })],
    ['insert into commerce_quote', () => ({ rows: [{ id: 'q1', expires_at: new Date('2026-09-28T10:15:00Z') }], rowCount: 1 })]
  ]);
  const eligibleAll = { isImageEligible: async () => true, now: () => new Date('2026-09-28T10:00:00Z') };

  const tx = quoteTx([offerRow(img1, 1000), offerRow(img2, 500)]);
  const quote = await quoteService.createQuote(tx, [img1, img2, img1, img3], eligibleAll, withRate);
  assert.equal(quote.quoteId, 'q1');
  assert.deepEqual(quote.totals, { grossCents: 1500, netCents: 1260, taxCents: 240, taxRateBp: 1900 });
  assert.deepEqual(quote.unavailable, [{ imageId: img3, reason: 'NOT_AVAILABLE' }]);
  assert.deepEqual(quote.items.map((item) => item.imageId), [img1, img2], 'doppelte IDs zaehlen einmal');
  // Kaeufer sehen weder Provision noch Fotografenanteil noch Verkaeufer.
  const publicJson = JSON.stringify(quote);
  for (const secret of ['sellerShare', 'commission', 'seller-1', 'sellerId', 'offerVersionId']) assert.equal(publicJson.includes(secret), false, `Quote verraet ${secret}`);
  // Gespeicherter Snapshot ist serverseitig berechnet und traegt die Einstellungsversion.
  const insert = tx.log.find((entry) => entry.text.startsWith('insert into commerce_quote'));
  const snapshot = JSON.parse(insert.values[0]);
  assert.deepEqual([snapshot[0].grossCents, snapshot[0].taxCents, snapshot[0].sellerShareCents, snapshot[0].commissionCents], [1000, 160, 672, 168]);
  assert.equal(snapshot[0].offerVersion, 2);
  assert.equal(insert.values[6], 'set-9');
  assert.equal(insert.values[5], 900, 'Quote gilt 15 Minuten');

  // Der Preis kommt aus der Angebotsversion, nie vom Client; ein Angebotssatz ueberstimmt die Einstellung.
  const overrideQuote = await quoteService.createQuote(quoteTx([offerRow(img1, 1000, { tax_rate_bp: 700 }), offerRow(img2, 1000)]), [img1, img2], eligibleAll, withRate);
  assert.equal(overrideQuote.totals.taxRateBp, null, 'gemischte Saetze: kein einheitlicher Satz');
  assert.equal(overrideQuote.totals.taxCents, 65 + 160);

  // Nicht kaeufliche oder nicht oeffentliche Bilder.
  const ineligible = await quoteService.createQuote(quoteTx([offerRow(img1), offerRow(img2)]), [img1, img2], { isImageEligible: async (id) => id === img1 }, withRate);
  assert.deepEqual(ineligible.unavailable.map((u) => u.imageId), [img2]);
  await assert.rejects(() => quoteService.createQuote(quoteTx([]), [img1], eligibleAll, withRate), (e) => e.code === 'QUOTE_NOTHING_AVAILABLE');
  await assert.rejects(() => quoteService.createQuote(quoteTx([offerRow(img1)]), [img1], { isImageEligible: async () => false }, withRate), (e) => e.code === 'QUOTE_NOTHING_AVAILABLE');
  await assert.rejects(() => quoteService.createQuote(quoteTx([]), [], eligibleAll, withRate), (e) => e.code === 'QUOTE_EMPTY');
  await assert.rejects(
    () => quoteService.createQuote(quoteTx([]), Array.from({ length: 51 }, (_, i) => `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`), eligibleAll, withRate),
    (e) => e.code === 'QUOTE_TOO_LARGE'
  );
  // Ohne entschiedenen Steuersatz: kein Preis, keine gespeicherte Quote.
  const noTaxTx = quoteTx([offerRow(img1)]);
  await assert.rejects(() => quoteService.createQuote(noTaxTx, [img1], eligibleAll, { ...withRate, saleTaxRateBp: null }), (e) => e.code === 'QUOTE_TAX_NOT_CONFIGURED');
  assert.equal(noTaxTx.log.some((entry) => entry.text.startsWith('insert into commerce_quote')), false);
  // Die Abfrage verlangt veroeffentlicht, PAID, aktives Angebot und aktiven Verkaeufer.
  const sql = tx.log[0].text;
  for (const part of ["i.visibility = 'PUBLISHED'", "i.offer_mode = 'PAID'", "o.status = 'ACTIVE' and o.mode = 'PAID'", "s.status = 'ACTIVE'", 're.enabled = true and re.published = true']) {
    assert.ok(sql.includes(part), `Quote-Abfrage prueft nicht: ${part}`);
  }

  // --- HTTP-Schicht ---------------------------------------------------------------------------------------
  const dbClient = require('../dist/db/client.js');
  const rateLimit = require('../dist/http/publicRateLimit.js');
  const { handleQuoteRoutes } = require('../dist/commerce/quoteRoutes.js');
  const event = (method, routePath, extra = {}) => ({
    requestContext: { http: { method, path: routePath, sourceIp: '203.0.113.5' }, ...(extra.claims ? { authorizer: { jwt: { claims: extra.claims } } } : {}) },
    headers: {},
    body: extra.body ?? null,
    queryStringParameters: {}
  });
  const previousFlag = process.env.COMMERCE_CHECKOUT;
  const originals = { getPool: dbClient.getPool, getDb: dbClient.getDb, limit: rateLimit.enforcePublicRateLimit };
  try {
    assert.equal(await handleQuoteRoutes(event('GET', '/photographer/images')), null);
    delete process.env.COMMERCE_CHECKOUT;
    assert.equal((await handleQuoteRoutes(event('POST', '/public/commerce/quotes'))).statusCode, 404, 'ohne Flag keine Quote');

    process.env.COMMERCE_CHECKOUT = 'true';
    rateLimit.enforcePublicRateLimit = async () => ({ allowed: false, limit: 30, retryAfterSeconds: 12 });
    const limited = await handleQuoteRoutes(event('POST', '/public/commerce/quotes', { body: JSON.stringify({ imageIds: [img1] }) }));
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.headers['retry-after'], '12');

    rateLimit.enforcePublicRateLimit = async () => ({ allowed: true, limit: 30, retryAfterSeconds: 0 });
    assert.equal((await handleQuoteRoutes(event('POST', '/public/commerce/quotes', { body: JSON.stringify({ imageIds: [] }) }))).statusCode, 400);
    assert.equal((await handleQuoteRoutes(event('POST', '/public/commerce/quotes', { body: JSON.stringify({ imageIds: ['kein-uuid'] }) }))).statusCode, 400);
    assert.equal((await handleQuoteRoutes(event('POST', '/public/commerce/quotes', { body: '{kaputt' }))).statusCode, 400);
    assert.equal((await handleQuoteRoutes(event('GET', '/public/commerce/quotes'))).statusCode, 405);

    // Preise aus dem Body werden ignoriert (Schema kennt nur imageIds); Steuersatz offen -> 503.
    dbClient.getPool = async () => makeTx([
      ['from commerce_settings_version', () => ({ rows: [settingsRow()], rowCount: 1 })],
      ['from racepic_image i', () => ({ rows: [offerRow(img1)], rowCount: 1 })]
    ]);
    const routeDeps = { quoteDeps: eligibleAll };
    const untaxed = await handleQuoteRoutes(event('POST', '/public/commerce/quotes', { body: JSON.stringify({ imageIds: [img1], priceCents: 1 }) }), routeDeps);
    assert.equal(untaxed.statusCode, 503);
    assert.match(untaxed.body, /QUOTE_TAX_NOT_CONFIGURED/);

    dbClient.getPool = async () => makeTx([
      ['from commerce_settings_version', () => ({ rows: [settingsRow({ sale_tax_rate_bp: 1900 })], rowCount: 1 })],
      ['from racepic_image i', () => ({ rows: [offerRow(img1)], rowCount: 1 })],
      ['insert into commerce_quote', () => ({ rows: [{ id: 'q1', expires_at: new Date('2026-09-28T10:15:00Z') }], rowCount: 1 })]
    ]);
    const ok = await handleQuoteRoutes(event('POST', '/public/commerce/quotes', { body: JSON.stringify({ imageIds: [img1], priceCents: 1 }) }), routeDeps);
    assert.equal(ok.statusCode, 201);
    assert.equal(JSON.parse(ok.body).quote.items[0].priceCents, 1000, 'der Client bestimmt den Preis nicht');

    // Einstellungen (Admin).
    const admin = { sub: 'u1', email: 'a@b.de', 'cognito:groups': 'admin' };
    assert.equal((await handleQuoteRoutes(event('GET', '/admin/racepic/commerce-settings'))).statusCode, 401);
    assert.equal((await handleQuoteRoutes(event('GET', '/admin/racepic/commerce-settings', { claims: { sub: 'u1', 'cognito:groups': 'racepic_moderator' } }))).statusCode, 403);
    dbClient.getPool = async () => makeTx([['from commerce_settings_version', () => ({ rows: [settingsRow()], rowCount: 1 })]]);
    const read = await handleQuoteRoutes(event('GET', '/admin/racepic/commerce-settings', { claims: admin }));
    assert.equal(read.statusCode, 200);
    assert.equal(JSON.parse(read.body).current.saleTaxRateBp, null);
    const valid = { expectedVersion: 1, saleTaxRateBp: 700, commissionBp: 2000, sellerShareBasis: 'NET', sellerVatRateBp: null, artistSocialLevyBp: 0, note: 'Steuerberatung' };
    for (const broken of [{ ...valid, note: '' }, { ...valid, commissionBp: 10001 }, { ...valid, sellerShareBasis: 'X' }, { ...valid, expectedVersion: 0 }]) {
      assert.equal((await handleQuoteRoutes(event('POST', '/admin/racepic/commerce-settings', { claims: admin, body: JSON.stringify(broken) }))).statusCode, 400);
    }
    dbClient.getPool = async () => makeTx([['from commerce_settings_version', () => ({ rows: [settingsRow({ version: 3 })], rowCount: 1 })]]);
    assert.equal((await handleQuoteRoutes(event('POST', '/admin/racepic/commerce-settings', { claims: admin, body: JSON.stringify(valid) }))).statusCode, 409, 'veraltete Version');
    const audit = [];
    dbClient.getDb = async () => ({ insert: () => ({ values: async (row) => { audit.push(row); } }) });
    dbClient.getPool = async () => makeTx([
      ['select * from commerce_settings_version', () => ({ rows: [settingsRow()], rowCount: 1 })],
      ['insert into commerce_settings_version', (values) => ({ rows: [settingsRow({ id: 'set-2', version: values[0], sale_tax_rate_bp: values[1] })], rowCount: 1 })]
    ]);
    const saved = await handleQuoteRoutes(event('POST', '/admin/racepic/commerce-settings', { claims: admin, body: JSON.stringify(valid) }));
    assert.equal(saved.statusCode, 201);
    assert.equal(audit[0].action, 'commerce_settings_changed');
    assert.deepEqual(audit[0].payload, { version: 2, saleTaxRateBp: 700, commissionBp: 2000, sellerShareBasis: 'NET', sellerVatRateBp: null, artistSocialLevyBp: 0 });
  } finally {
    dbClient.getPool = originals.getPool;
    dbClient.getDb = originals.getDb;
    rateLimit.enforcePublicRateLimit = originals.limit;
    if (previousFlag === undefined) delete process.env.COMMERCE_CHECKOUT;
    else process.env.COMMERCE_CHECKOUT = previousFlag;
  }

  const stack = read_stack();
  assert.ok(stack.includes("path: '/public/commerce/quotes'"));
  assert.ok(stack.includes("path: '/admin/racepic/commerce-settings'"));
  console.log('commerce-pricing-quote.test.js ok');

  function read_stack() {
    return read('infra/lib/stacks/api-stack.ts');
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
