const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

const { renderEntryConfirmationPdf } = require('../dist/docs/pdf.js');
const { buildEntryConfirmationRevisionHash } = require('../dist/docs/entryConfirmation.js');

const buildPayload = () => ({
  eventName: '12. Oberlausitzer Dreieck',
  eventDateText: '01.05.2026 - 02.05.2026',
  organizer: 'MSC Oberlausitzer Dreiländereck e.V.',
  className: 'Klasse 1: Supermoto',
  startNumber: '42',
  driver: {
    fullName: 'Max Musterfahrer',
    street: 'Musterstraße 1',
    zip: '02763',
    city: 'Zittau',
    email: 'max@example.org',
    phone: '+49 1234 56'
  },
  codriver: {
    fullName: 'Anna Beispiel',
    birthdate: '10.01.2001'
  },
  vehicle: {
    vehicleType: 'moto',
    make: 'KTM',
    model: 'EXC',
    year: 2020,
    displacementCcm: 450
  },
  backupVehicle: {
    vehicleType: 'moto',
    make: 'Kawasaki',
    model: 'KX',
    year: 2018,
    displacementCcm: 250
  },
  payment: {
    totalFee: '150,00 EUR',
    paidAmount: '50,00 EUR',
    openAmount: '100,00 EUR',
    paymentDeadline: '15.04.2026',
    paymentRecipient: 'MSC Oberlausitzer Dreiländereck e.V.',
    paymentIban: 'DE001234567890',
    paymentBic: 'BICCODE'
  },
  legalHint: 'Dieses Dokument gilt als Nennbestätigung und Fahrerlager-Nachweis.'
});

(async () => {
  const payload = buildPayload();
  const hashA = buildEntryConfirmationRevisionHash(payload);
  const hashB = buildEntryConfirmationRevisionHash(buildPayload());
  assert.equal(hashA, hashB);

  const changedPayload = { ...buildPayload(), className: 'Klasse 2: Touring' };
  const hashChanged = buildEntryConfirmationRevisionHash(changedPayload);
  assert.notEqual(hashA, hashChanged);

  const firstPdf = await renderEntryConfirmationPdf(payload);
  const secondPdf = await renderEntryConfirmationPdf(payload);
  assert.equal(firstPdf.subarray(0, 4).toString('utf8'), '%PDF');
  assert.ok(firstPdf.length > 1500, `expected PDF size > 1500, got ${firstPdf.length}`);
  assert.equal(
    createHash('sha256').update(firstPdf).digest('hex'),
    createHash('sha256').update(secondPdf).digest('hex')
  );

  const optionalPayload = {
    ...buildPayload(),
    codriver: null,
    backupVehicle: null
  };
  const optionalPdf = await renderEntryConfirmationPdf(optionalPayload);
  assert.equal(optionalPdf.subarray(0, 4).toString('utf8'), '%PDF');

  console.log('entry-confirmation-pdf.test.js: ok');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

