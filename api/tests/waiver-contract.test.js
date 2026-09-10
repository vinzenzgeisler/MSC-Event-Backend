'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { WAIVER_VERSION, WAIVER_TEXT_HASHES, buildWaiverContract, flattenWaiverDocument, getWaiverDocument } = require('../dist/legal/waiverContract');

assert.equal(WAIVER_VERSION, 'OLD2026-HAFTVERZICHT-1.0.0');
assert.deepEqual(WAIVER_TEXT_HASHES, {
  'de-DE': 'fd78daa4a0d0d60613da300d818ba1386ae10e9160c2ca1f5d53c48c2131014b',
  'en-GB': '31a5a0ee43490cc24028344d604200b417a92474d09d89ad0c88996a8efdaa1e',
  'cs-CZ': 'cc7b99765fb5fd5ca74057243f09ed9905b93c17cf4e5baf4cbf811cc3a6d71b',
  'pl-PL': '5629bf24eb1c14ddd838daf7dfda61be9ceb11c7e37c6644d18d5164a4e0c548'
});

const germanText = flattenWaiverDocument(getWaiverDocument('de-DE'));
assert.match(germanText, /^Vertrags- und Verzichtserklärung/);
assert.match(germanText, /12\. Oberlausitzer Dreiecks am 12\. und 13\. September 2026/);
assert.match(germanText, /Sind mehrere gesetzliche Vertreter nur gemeinschaftlich zur Vertretung berechtigt/);
assert.match(germanText, /Die Unterzeichnung wird zusammen mit der verwendeten Dokumentversion/);

for (const locale of ['en-GB', 'cs-CZ', 'pl-PL']) {
  const contract = buildWaiverContract(locale);
  assert.equal(contract.version, WAIVER_VERSION);
  assert.equal(contract.authoritativeLocale, 'de-DE');
  assert.equal(contract.authoritativeFullText, germanText);
  assert.equal(contract.textHash, WAIVER_TEXT_HASHES['de-DE']);
  assert.equal(contract.translation?.locale, locale);
  assert.equal(contract.translation?.binding, false);
  assert.ok(contract.translation?.fullText.length > 2000);
}

const germanContract = buildWaiverContract('de-DE');
assert.equal(germanContract.translation, null);
assert.equal(germanContract.fullText, germanText);

const retentionWorkerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'jobs', 'privacyRetentionWorker.ts'), 'utf8');
const waiverRetentionExclusions = retentionWorkerSource.match(/"document"\."type" <> 'waiver_signed'/g) ?? [];
assert.equal(waiverRetentionExclusions.length, 2, 'signed waiver documents and their generation jobs must not be deleted by automatic retention');

const waiverMigrationSource = fs.readFileSync(path.join(__dirname, '..', 'migrations', '0084_waiver_contract_v1.sql'), 'utf8');
assert.match(waiverMigrationSource, /create unique index if not exists "signing_session_event_driver_active_unique"/);
assert.match(waiverMigrationSource, /create unique index if not exists "signing_session_device_active_unique"/);
assert.match(waiverMigrationSource, /where "status" in \('pending', 'displayed'\)/);

console.log('waiver contract tests passed');
