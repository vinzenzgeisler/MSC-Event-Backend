const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const exifr = require('exifr');

const root = path.resolve(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

// --- Migration 0112 -----------------------------------------------------------------------------
const migration = read('api/migrations/0112_commerce_conversion_flow.sql');
assert.match(migration, /racepic_offer_conversion_item_open_image_unique/);
assert.match(migration, /where "is_open"/);
assert.match(migration, /"finalized_at"/);
assert.match(migration, /"request_fingerprint"/);

// --- Eligibility / Veroeffentlichung: PAID nur mit Flag UND aktiver Angebotsversion ----------------------
const eligibility = read('api/src/racepic/eligibility.ts');
assert.match(eligibility, /getCommerceFlags\(\)\.commercePaidOffers/);
assert.match(eligibility, /o\.status = 'ACTIVE' and o\.mode = 'PAID'/);
assert.match(eligibility, /`i\.offer_mode = 'FREE'`/);
const publish = read('api/src/racepic/publish.ts');
assert.match(publish, /publishPublicObjectsForImage/);
assert.match(publish, /deleteObjectsByPrefix\(`public\/\$\{imageId\}\/`\)/);
assert.doesNotMatch(publish, /eq\(racepicImage\.offerMode, 'FREE'\)/);
assert.match(read('api/src/racepic/download.ts'), /row\.offerMode !== 'FREE'/);
assert.match(read('api/src/racepic/ingestWorker.ts'), /processConversionItem\(body\.conversionItemId\)/);
const stack = read('infra/lib/stacks/api-stack.ts');
assert.match(stack, /'idempotency-key'/);
assert.match(stack, /path: '\/photographer\/offer-conversions'/);
assert.match(stack, /path: '\/admin\/racepic\/offer-conversions\/\{conversionId\}\/\{action\}'/);
assert.equal((stack.match(/COMMERCE_PAID_OFFERS:/g) ?? []).length >= 5, true, 'alle Lambdas mit Manifest-/Eligibility-Zugriff brauchen das Flag');

(async () => {
  // --- Objekt-Schluessel ------------------------------------------------------------------------
  const keys = require('../dist/commerce/objectKeys.js');
  assert.equal(keys.paidPublicKey('img', 3, 'preview'), 'public/img/o3/preview.webp');
  assert.equal(keys.publicVariantUrl('img', 'thumb', null), '/public/img/thumb.webp');
  assert.equal(keys.publicVariantUrl('img', 'thumb', { mode: 'FREE', version: 1 }), '/public/img/thumb.webp');
  assert.equal(keys.publicVariantUrl('img', 'thumb', { mode: 'PAID', version: 2 }), '/public/img/o2/thumb.webp');
  const artifacts = keys.conversionArtifactKeys('img', 'offer');
  assert.match(artifacts.licensedFull, /^licensed\//, 'Lizenzdatei liegt in einem privaten, nicht ueber CDN erreichbaren Praefix');
  assert.doesNotMatch(artifacts.licensedFull, /^public\//);

  // --- Bildverarbeitung: Metadaten und Lizenzartefakt (AP04) ------------------------------------------
  const ip = require('../dist/racepic/imageProcessing.js');
  assert.equal(ip.toExifAscii('© Müller Foto ß'), '(C) Muller Foto ss');
  const withGps = await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 200, g: 30, b: 30 } } })
    .jpeg()
    .withMetadata({
      orientation: 6,
      exif: {
        IFD0: { Make: 'TestCam', Copyright: 'orig' },
        IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '50/1 30/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '14/1 40/1 0/1' }
      }
    })
    .toBuffer();
  assert.ok((await exifr.gps(withGps)).latitude, 'Testbild muss GPS enthalten');

  // Regression: medium/large (FREE-Downloads) duerfen kein GPS und keine Kameradaten behalten.
  for (const variant of await ip.renderVariants(withGps, '© Test Foto')) {
    assert.equal(await exifr.gps(variant.buffer).catch(() => undefined), undefined, `${variant.kind} enthaelt GPS`);
    assert.equal((await exifr.parse(variant.buffer, { pick: ['Make'] }).catch(() => null))?.Make, undefined, `${variant.kind} enthaelt Kameramodell`);
  }

  const licensed = await ip.renderLicensedFull(withGps, '© Müller Foto');
  assert.equal(licensed.width, 480, 'EXIF-Ausrichtung angewendet: 640x480 mit Orientation 6 wird 480x640');
  assert.equal(licensed.height, 640);
  await ip.validateLicensedFull(licensed.buffer, { width: 640, height: 480 }, '© Müller Foto');
  assert.equal(await exifr.gps(licensed.buffer).catch(() => undefined), undefined);

  await assert.rejects(() => ip.validateLicensedFull(withGps, { width: 640, height: 480 }, '© Test Foto'), (e) => e.code === 'GPS_PRESENT');
  await assert.rejects(() => ip.validateLicensedFull(licensed.buffer, { width: 4000, height: 3000 }, '© Müller Foto'), (e) => e.code === 'DIMENSIONS_REDUCED');
  await assert.rejects(() => ip.validateLicensedFull(licensed.buffer, { width: 640, height: 480 }, 'Jemand anderes'), (e) => e.code === 'COPYRIGHT_MISSING');
  await assert.rejects(() => ip.validateLicensedFull(Buffer.from('kein jpeg'), { width: 1, height: 1 }, 'x'), (e) => e.code === 'NOT_JPEG');

  // --- Service-Regeln (Fake-DB) ---------------------------------------------------------------------
  const dbClient = require('../dist/db/client.js');
  const conversion = require('../dist/commerce/conversion.js');

  const makeScriptedPool = (handlers) => {
    const log = [];
    const query = async (text, values) => {
      const normalized = text.replace(/\s+/g, ' ').trim();
      log.push(normalized);
      for (const [needle, respond] of handlers) {
        if (normalized.includes(needle)) return respond(values, normalized);
      }
      return { rows: [], rowCount: 0 };
    };
    return { log, query, connect: async () => ({ query, release: () => undefined }) };
  };
  const useDb = (pool) => {
    dbClient.getPool = async () => pool;
  };

  // Eingabepruefungen brauchen keine Datenbank.
  await assert.rejects(
    () => conversion.requestConversion('p1', { idempotencyKey: 'k-12345678', imageIds: ['i1'], priceCents: 1000, licenseId: 'l1', rightsConfirmed: false }),
    (e) => e.code === 'CONVERSION_RIGHTS_NOT_CONFIRMED'
  );
  await assert.rejects(
    () => conversion.requestConversion('p1', { idempotencyKey: 'k-12345678', imageIds: ['i1'], priceCents: 750, licenseId: 'l1', rightsConfirmed: true }),
    (e) => e.code === 'CONVERSION_INVALID_PRICE'
  );
  await assert.rejects(
    () => conversion.requestConversion('p1', { idempotencyKey: 'k-12345678', imageIds: [], priceCents: 1000, licenseId: 'l1', rightsConfirmed: true }),
    (e) => e.code === 'CONVERSION_IMAGE_NOT_ELIGIBLE'
  );

  // Gleicher Idempotency-Key mit anderem Inhalt wird abgelehnt, ohne etwas anzulegen.
  const existingRow = { id: 'c1', photographer_id: 'p1', request_fingerprint: 'anderer-fingerabdruck', status: 'REQUESTED' };
  const reusePool = makeScriptedPool([['from racepic_offer_conversion where photographer_id', () => ({ rows: [existingRow], rowCount: 1 })]]);
  useDb(reusePool);
  await assert.rejects(
    () => conversion.requestConversion('p1', { idempotencyKey: 'k-12345678', imageIds: ['i1'], priceCents: 1000, licenseId: 'l1', rightsConfirmed: true }),
    (e) => e.code === 'CONVERSION_IDEMPOTENCY_KEY_REUSED'
  );
  assert.equal(reusePool.log.some((q) => q.startsWith('insert into racepic_offer_conversion')), false);
  assert.ok(reusePool.log.includes('rollback'));

  // Fremdes Bild: derselbe Fehler wie "nicht konvertierbar" (kein Rueckschluss auf fremde Bild-IDs).
  const foreignPool = makeScriptedPool([
    ['from racepic_photographer where id', () => ({ rows: [{ status: 'ACTIVE_FREE' }], rowCount: 1 })],
    ['from racepic_license', () => ({ rows: [{ id: 'l1' }], rowCount: 1 })],
    ['from racepic_image where id = any', () => ({
      rows: [{ id: 'i1', photographer_id: 'anderer', visibility: 'PUBLISHED', offer_mode: 'FREE', processing_status: 'DERIVED', original_key: 'k', width: 1, height: 1, license_id: 'l0' }],
      rowCount: 1
    })]
  ]);
  useDb(foreignPool);
  await assert.rejects(
    () => conversion.requestConversion('p1', { idempotencyKey: 'k-12345678', imageIds: ['i1'], priceCents: 1000, licenseId: 'l1', rightsConfirmed: true }),
    (e) => e.code === 'CONVERSION_IMAGE_NOT_ELIGIBLE'
  );
  assert.equal(foreignPool.log.some((q) => q.startsWith('insert into racepic_offer_conversion')), false);

  // Approve: nur aus READY_FOR_REVIEW.
  useDb(makeScriptedPool([['from racepic_offer_conversion where id', () => ({ rows: [{ id: 'c1', status: 'REQUESTED' }], rowCount: 1 })]]));
  await assert.rejects(() => conversion.approveConversion('c1', { actor: 'admin', note: 'ok' }), (e) => e.code === 'CONVERSION_NOT_REVIEWABLE');
  useDb(makeScriptedPool([]));
  await assert.rejects(() => conversion.approveConversion('c1', { actor: 'admin', note: 'ok' }), (e) => e.code === 'CONVERSION_NOT_FOUND');

  // Approve: veraendertes Angebot seit dem Antrag => STALE, es wird nichts umgestellt und zurueckgerollt.
  const readyRow = { id: 'c1', photographer_id: 'p1', status: 'READY_FOR_REVIEW', target_price_cents: 1000, target_license_id: 'l1' };
  const itemRow = { id: 'it1', conversion_id: 'c1', image_id: 'i1', source_offer_version_id: 'freeV1', target_offer_version_id: 'paidV2', artifact_status: 'READY' };
  const stalePool = makeScriptedPool([
    ['from racepic_offer_conversion where id = $1 for update', () => ({ rows: [readyRow], rowCount: 1 })],
    ['from racepic_offer_conversion where id = $1', () => ({ rows: [readyRow], rowCount: 1 })],
    ['from racepic_offer_conversion_item', () => ({ rows: [itemRow], rowCount: 1 })],
    ['from racepic_image where id = $1 for update', () => ({ rows: [{ id: 'i1', visibility: 'PUBLISHED', offer_mode: 'FREE', photographer_id: 'p1' }], rowCount: 1 })],
    ['join commerce_product p on p.id = o.product_id', () => ({ rows: [{ id: 'anderes-aktives-angebot' }], rowCount: 1 })]
  ]);
  useDb(stalePool);
  await assert.rejects(() => conversion.approveConversion('c1', { actor: 'admin', note: 'ok' }), (e) => e.code === 'CONVERSION_STALE');
  assert.equal(stalePool.log.some((q) => q.startsWith('update racepic_image set offer_mode')), false);
  assert.ok(stalePool.log.includes('rollback'));

  // Reject: unbekannter Antrag.
  useDb(makeScriptedPool([]));
  await assert.rejects(() => conversion.rejectConversion('c1', { actor: 'admin', note: 'nein' }), (e) => e.code === 'CONVERSION_NOT_FOUND');

  // Finalize verlangt eine freigegebene Umstellung.
  useDb(makeScriptedPool([['from racepic_offer_conversion where id', () => ({ rows: [{ id: 'c1', status: 'READY_FOR_REVIEW' }], rowCount: 1 })]]));
  await assert.rejects(() => conversion.finalizeConversion('c1'), (e) => e.code === 'CONVERSION_NOT_APPROVED');

  // --- HTTP-Schicht: Flag, Auth, Idempotency-Key ------------------------------------------------------
  const { handleConversionRoutes } = require('../dist/commerce/conversionRoutes.js');
  const makeEvent = (method, routePath, extra = {}) => ({
    requestContext: { http: { method, path: routePath }, ...(extra.requestContext ?? {}) },
    headers: extra.headers ?? {},
    body: extra.body ?? null,
    queryStringParameters: extra.query ?? {}
  });
  const deps = {
    requireActivePhotographer: async () => ({ ok: true, photographer: { id: 'p1' } })
  };
  const previous = process.env.COMMERCE_FREE_TO_PAID_CONVERSION;
  try {
    delete process.env.COMMERCE_FREE_TO_PAID_CONVERSION;
    assert.equal(await handleConversionRoutes(makeEvent('GET', '/photographer/images'), deps), null, 'fremde Pfade werden nicht beansprucht');
    for (const p of ['/photographer/offer-conversions', '/admin/racepic/offer-conversions']) {
      const response = await handleConversionRoutes(makeEvent('GET', p), deps);
      assert.equal(response.statusCode, 404, `${p} muss bei ausgeschaltetem Flag 404 liefern`);
    }

    process.env.COMMERCE_FREE_TO_PAID_CONVERSION = 'true';
    const id = '11111111-1111-4111-8111-111111111111';
    // Photographer ohne Idempotency-Key.
    let response = await handleConversionRoutes(makeEvent('POST', '/photographer/offer-conversions', { body: '{}' }), deps);
    assert.equal(response.statusCode, 400);
    assert.match(response.body, /IDEMPOTENCY_KEY_REQUIRED/);
    // Ungueltiger Body mit Key.
    response = await handleConversionRoutes(
      makeEvent('POST', '/photographer/offer-conversions', { body: JSON.stringify({ imageIds: [id], priceCents: 1000, licenseId: id, rightsConfirmed: false }), headers: { 'idempotency-key': 'key-12345678' } }),
      deps
    );
    assert.equal(response.statusCode, 400, 'rightsConfirmed muss exakt true sein');
    // Photographer-Auth wird durchgereicht.
    const denied = { ok: false, error: { statusCode: 401, body: '{}' } };
    response = await handleConversionRoutes(makeEvent('GET', '/photographer/offer-conversions'), { requireActivePhotographer: async () => denied });
    assert.equal(response.statusCode, 401);
    // Admin: ohne Anmeldung 401, ohne racepic.manage 403.
    response = await handleConversionRoutes(makeEvent('GET', '/admin/racepic/offer-conversions'), deps);
    assert.equal(response.statusCode, 401);
    const asRole = (role) => ({ requestContext: { authorizer: { jwt: { claims: { sub: 'u1', email: 'a@b.de', 'cognito:groups': role } } } } });
    response = await handleConversionRoutes(makeEvent('GET', '/admin/racepic/offer-conversions', asRole('racepic_moderator')), deps);
    assert.equal(response.statusCode, 403, 'racepic_moderator darf keine Freigaben sehen');
    response = await handleConversionRoutes(makeEvent('POST', `/admin/racepic/offer-conversions/${id}/approve`, { ...asRole('admin'), body: '{"note":"ok"}' }), deps);
    assert.equal(response.statusCode, 400, 'Admin-Schreibaktionen verlangen Idempotency-Key');
    response = await handleConversionRoutes(
      makeEvent('POST', `/admin/racepic/offer-conversions/${id}/approve`, { ...asRole('admin'), headers: { 'idempotency-key': 'key-12345678' }, body: '{}' }),
      deps
    );
    assert.equal(response.statusCode, 400, 'Admin-Schreibaktionen verlangen einen Bearbeitungsvermerk');
  } finally {
    if (previous === undefined) delete process.env.COMMERCE_FREE_TO_PAID_CONVERSION;
    else process.env.COMMERCE_FREE_TO_PAID_CONVERSION = previous;
  }

  console.log('commerce-conversion.test.js ok');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
