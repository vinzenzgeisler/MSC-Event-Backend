'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { PAPER_WAIVER_VERSION, buildPaperWaiverContract, buildPaperWaiverDocument } = require('../dist/legal/paperWaiverContract');
const { flattenWaiverDocument } = require('../dist/legal/waiverContract');
const { renderBlankWaiverPdf, renderPaperWaiverPdf } = require('../dist/docs/pdf');

const fonts = {
  regular: fs.readFileSync(path.join(__dirname, '..', '..', 'infra', 'assets', 'mail-fonts', 'arial.ttf')),
  bold: fs.readFileSync(path.join(__dirname, '..', '..', 'infra', 'assets', 'mail-fonts', 'arialbd.ttf'))
};
const logoImage = fs.readFileSync(path.join(__dirname, '..', '..', 'infra', 'assets', 'mail-logo', 'msc-logo.png'));
const pageCount = (pdf) => (pdf.toString('latin1').match(/\/Type \/Page(?!s)/g) ?? []).length;

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
    ],
    fonts,
    logoImage
  });
  assert.ok(Buffer.isBuffer(pdfBuffer));
  assert.equal(pdfBuffer.subarray(0, 5).toString('utf8'), '%PDF-');
  assert.equal(pageCount(pdfBuffer), 2, 'localized paper fallback must use one German form page plus one translation page');

  const germanPaperPdf = await renderPaperWaiverPdf({
    event: { name: '12. Oberlausitzer Dreieck', startsAt: '2026-09-12', endsAt: '2026-09-13', location: 'MSC Oberlausitzer Dreiländereck' },
    driver: { firstName: 'Max', lastName: 'Mustermann', birthdate: '1990-01-01' },
    isMinor: false,
    requiresMedicalCertificate: false,
    contract: germanPaperContract,
    entries: [{ className: 'Klasse 9', orgaCode: 'A123', startNumber: '42', codriver: null, vehicles: [{ role: 'primary', make: 'Trabant', model: '601', year: 1985, startNumber: '42' }] }],
    fonts,
    logoImage
  });
  assert.equal(pageCount(germanPaperPdf), 1, 'German personalized paper fallback must fit on one page');

  const germanBlankPdf = await renderBlankWaiverPdf('de-DE', fonts, logoImage);
  const polishBlankPdf = await renderBlankWaiverPdf('pl-PL', fonts, logoImage);
  assert.equal(pageCount(germanBlankPdf), 1, 'German blank waiver must fit on one page');
  assert.equal(pageCount(polishBlankPdf), 2, 'localized blank waiver must add exactly one translation page');

  console.log('waiver paper export tests passed');
})();
