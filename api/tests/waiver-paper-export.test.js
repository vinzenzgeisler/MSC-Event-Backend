'use strict';
const assert = require('node:assert/strict');

const { PAPER_WAIVER_VERSION, buildPaperWaiverContract, buildPaperWaiverDocument } = require('../dist/legal/paperWaiverContract');
const { flattenWaiverDocument } = require('../dist/legal/waiverContract');
const { renderPaperWaiverPdf } = require('../dist/docs/pdf');

// Paper text must not reference the digital signing device/process, but stay otherwise
// textually identical to the live contract.
for (const locale of ['de-DE', 'en-GB', 'cs-CZ', 'pl-PL']) {
  const paperText = flattenWaiverDocument(buildPaperWaiverDocument(locale));
  assert.doesNotMatch(paperText, /digital/i, `paper waiver text for ${locale} must not mention "digital"`);
  assert.doesNotMatch(paperText, /cyfrow/i, `paper waiver text for ${locale} must not mention "cyfrowy"`);
  assert.doesNotMatch(paperText, /digitáln/i, `paper waiver text for ${locale} must not mention "digitální"`);
}

const germanPaperContract = buildPaperWaiverContract('de-DE');
assert.equal(germanPaperContract.version, PAPER_WAIVER_VERSION);
assert.equal(germanPaperContract.translation, null);
assert.match(germanPaperContract.authoritativeFullText, /9\. Abschließende Bestätigung und Unterschrift/);

const czechPaperContract = buildPaperWaiverContract('cs-CZ');
assert.equal(czechPaperContract.authoritativeLocale, 'de-DE');
assert.ok(czechPaperContract.translation);
assert.equal(czechPaperContract.translation.locale, 'cs-CZ');
assert.doesNotMatch(czechPaperContract.translation.fullText, /digitáln/i);

void (async () => {
  const pdfBuffer = await renderPaperWaiverPdf({
    event: { name: '12. Oberlausitzer Dreieck', startsAt: '2026-09-12', endsAt: '2026-09-13', location: 'MSC Oberlausitzer Dreiländereck' },
    driver: { firstName: 'Max', lastName: 'Mustermann', birthdate: '1990-01-01' },
    isMinor: false,
    requiresMedicalCertificate: false,
    contract: buildPaperWaiverContract('pl-PL'),
    entries: [
      {
        className: 'Klasse 9',
        orgaCode: 'A123',
        startNumber: '42',
        codriver: null,
        vehicles: [{ role: 'primary', make: 'Trabant', model: '601', year: 1985, startNumber: '42' }]
      }
    ]
  });
  assert.ok(Buffer.isBuffer(pdfBuffer));
  assert.equal(pdfBuffer.subarray(0, 5).toString('utf8'), '%PDF-');

  console.log('waiver paper export tests passed');
})();
