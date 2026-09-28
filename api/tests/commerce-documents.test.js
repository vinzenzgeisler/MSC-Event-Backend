const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const migration = read('api/migrations/0116_commerce_document_sequence.sql');
assert.match(migration, /primary key \("kind", "year"\)/);
assert.match(migration, /'INVOICE', 'CREDIT_NOTE', 'CORRECTION'/);

const documents = require('../dist/commerce/documents.js');

// Format je Belegart.
assert.equal(documents.formatDocumentNumber('INVOICE', 2026, 1), 'RP-2026-000001');
assert.equal(documents.formatDocumentNumber('CREDIT_NOTE', 2026, 42), 'RPG-2026-000042');
assert.equal(documents.formatDocumentNumber('CORRECTION', 2027, 999999), 'RPK-2027-999999');
for (const [year, sequence] of [[1999, 1], [2026, 0], [2026, 1000000], [2026, 1.5], [2026, -1]]) {
  assert.throws(() => documents.formatDocumentNumber('INVOICE', year, sequence), /DOCUMENT_/, `${year}/${sequence}`);
}

// Kalenderjahr in Europe/Berlin.
assert.equal(documents.documentYear(new Date('2026-06-15T12:00:00Z')), 2026);
assert.equal(documents.documentYear(new Date('2026-12-31T22:59:59Z')), 2026);
assert.equal(documents.documentYear(new Date('2026-12-31T23:00:00Z')), 2027, 'Mitternacht in Berlin');
assert.equal(documents.documentYear(new Date('2027-01-01T00:30:00Z')), 2027);

(async () => {
  // Vergabe: Upsert je (Belegart, Jahr); die Nummer stammt aus der Datenbank.
  const log = [];
  const tx = {
    query: async (text, values) => {
      log.push({ text: text.replace(/\s+/g, ' ').trim(), values });
      return { rows: [{ last_number: values[0] === 'INVOICE' ? 7 : 1 }], rowCount: 1 };
    }
  };
  assert.equal(await documents.allocateDocumentNumber(tx, 'INVOICE', new Date('2026-09-28T10:00:00Z')), 'RP-2026-000007');
  assert.equal(await documents.allocateDocumentNumber(tx, 'CREDIT_NOTE', new Date('2026-12-31T23:30:00Z')), 'RPG-2027-000001', 'Silvester nach Mitternacht Berlin zaehlt zum neuen Jahr');
  assert.deepEqual(log[0].values, ['INVOICE', 2026]);
  assert.match(log[0].text, /on conflict \(kind, year\) do update set last_number = commerce_document_sequence\.last_number \+ 1/);
  // Keine eigene Zaehlung im Code: die Datenbank vergibt, damit parallele Vergaben serialisiert werden.
  assert.doesNotMatch(read('api/src/commerce/documents.ts'), /Math\.random|Date\.now\(\)\s*\)/);

  // Absender und Steuerangaben.
  assert.deepEqual(documents.DOCUMENT_ISSUER, {
    name: 'MSC Oberlausitzer Dreiländereck e.V.',
    street: 'Am Weiher 4',
    postalCode: '02791',
    city: 'Oderwitz',
    country: 'Deutschland'
  });
  assert.deepEqual(documents.getIssuerTaxIdentity({}), { vatId: null, taxNumber: null });
  assert.equal(documents.hasIssuerTaxIdentity(documents.getIssuerTaxIdentity({})), false, 'ohne Steuerangabe kein Beleg');
  assert.equal(documents.hasIssuerTaxIdentity(documents.getIssuerTaxIdentity({ COMMERCE_ISSUER_VAT_ID: ' DE123456789 ' })), true);
  assert.equal(documents.getIssuerTaxIdentity({ COMMERCE_ISSUER_VAT_ID: ' DE123456789 ' }).vatId, 'DE123456789');
  assert.equal(documents.hasIssuerTaxIdentity(documents.getIssuerTaxIdentity({ COMMERCE_ISSUER_TAX_NUMBER: '123/456/78901' })), true);

  // Rechtstexte: Versionen sind gesetzt, der Status ist bis zur juristischen Freigabe DRAFT.
  const legal = require('../dist/commerce/legal.js');
  assert.equal(legal.LEGAL_DOCUMENTS_STATUS, 'DRAFT');
  assert.equal(legal.isLegalDocumentsApproved(), false);
  assert.deepEqual(Object.keys(legal.LEGAL_DOCUMENT_VERSIONS).sort(), ['digitalContentWaiver', 'license', 'privacy', 'terms', 'withdrawal']);
  for (const version of Object.values(legal.LEGAL_DOCUMENT_VERSIONS)) assert.match(version, /entwurf/);
  assert.equal(legal.ORDER_BUTTON_LABEL, 'Zahlungspflichtig bestellen');

  console.log('commerce-documents.test.js ok');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
