'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderSignedWaiverEvidencePdf } = require('../dist/docs/pdf');
const { buildWaiverContract } = require('../dist/legal/waiverContract');

const signatureDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const fonts = {
  regular: fs.readFileSync(path.join(__dirname, '..', '..', 'infra', 'assets', 'mail-fonts', 'arial.ttf')),
  bold: fs.readFileSync(path.join(__dirname, '..', '..', 'infra', 'assets', 'mail-fonts', 'arialbd.ttf'))
};
const pageCount = (pdf) => (pdf.toString('latin1').match(/\/Type \/Page(?!s)/g) ?? []).length;

(async () => {
  for (const locale of ['de-DE', 'en-GB', 'cs-CZ', 'pl-PL']) {
    const pdf = await renderSignedWaiverEvidencePdf({
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
      payload: {
        event: { name: '12. Oberlausitzer Dreieck', startsAt: '2026-09-12', endsAt: '2026-09-13', location: 'Oberlausitz' },
        driver: { firstName: 'Erika', lastName: 'Muster', birthdate: '1990-01-01' },
        signer: { role: 'driver', firstName: 'Erika', lastName: 'Muster', birthdate: '1990-01-01', label: 'Fahrer' },
        isMinor: false,
        requiresMedicalCertificate: false,
        contract: buildWaiverContract(locale),
        entries: [{ className: 'Klasse 1', orgaCode: 'ABC', startNumber: '12', codriver: null, vehicles: [] }]
      },
      signer: { type: 'driver', guardianName: null, guardianEmail: null, guardianRelationship: null, representationMode: null },
      precheckTimestamps: { identityCheckedAt: '2026-09-12T08:00:00.000Z', signerPresentAt: '2026-09-12T08:00:00.000Z' },
      operatorDisplay: 'operator@example.org',
      displayedAt: '2026-09-12T08:00:00.000Z',
      waiverAcceptedAt: '2026-09-12T08:01:00.000Z',
      signedAt: '2026-09-12T08:02:00.000Z',
      signatureDataUrl,
      fonts
    });
    assert.equal(pdf.subarray(0, 4).toString('ascii'), '%PDF');
    assert.ok(pdf.length > 10_000, `${locale} PDF should contain the full contract`);
    assert.equal(pageCount(pdf), locale === 'de-DE' ? 2 : 3, `${locale} evidence PDF must use one audit page, one German legal page and at most one translation page`);
  }
  console.log('waiver PDF tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
