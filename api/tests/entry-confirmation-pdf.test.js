const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

const { renderEntryConfirmationPdf } = require('../dist/docs/pdf.js');
const { buildEntryConfirmationRevisionHash } = require('../dist/docs/entryConfirmation.js');
const { buildGiroCodeMatrix, buildGiroCodePayload } = require('../dist/docs/girocode.js');

const buildPayload = () => ({
  organizer: {
    name: 'MSC Oberlausitzer Dreiländereck e.V.',
    addressLine: 'Am Weiher 4 · 02791 Oderwitz',
    websiteUrl: 'https://www.msc-oberlausitzer-dreilaendereck.eu',
    contactEmail: 'nennung@msc-oberlausitzer-dreilaendereck.eu',
    logoImage: null
  },
  event: {
    title: 'Nennbestätigung',
    name: '12. Oberlausitzer Dreieck',
    dateText: '01.05.2026 - 02.05.2026',
    issueDateText: '16.03.2026',
    gateHeadline: 'Bitte bei der Einfahrt in das Fahrerlager bereithalten.',
    locale: 'de'
  },
  recipient: {
    lines: ['Max Musterfahrer', 'Musterstraße 1', '02763 Zittau']
  },
  intro: {
    greeting: 'Guten Tag Max Musterfahrer,',
    paragraphs: [
      'hiermit bestätigen wir Ihre Zulassung zur Veranstaltung 12. Oberlausitzer Dreieck.',
      'Diese Bestätigung und der ausgewiesene Betrag beziehen sich ausschließlich auf die unten genannte Nennung. Weitere Nennungen auf Ihren Namen werden gesondert entschieden und berechnet.',
      'Das Nenngeld ist derzeit noch offen. Bitte überweisen Sie den Betrag fristgerecht.',
      'Bei gemeinsamer Überweisung Ihrer bereits zugelassenen Nennungen beträgt der aktuelle Gesamtbetrag 150,00 EUR.',
      'Bitte bringen Sie diese Nennbestätigung digital oder ausgedruckt zur Veranstaltung mit.'
    ]
  },
  sections: {
    entryDetails: 'Nennungsdaten',
    additionalEntries: 'Weitere zugelassene Nennungen',
    pendingEntries: 'Weitere gemeldete Nennungen',
    payment: 'Zahlung',
    eventInfo: 'Veranstaltungsinfos',
    schedule: 'Termine',
    importantNotes: 'Wichtige Hinweise',
    closing: 'Abschluss'
  },
  focusedEntrySummary: 'Klasse 1: Supermoto · Startnummer 42 · KTM EXC (Baujahr 2020, 450 ccm)',
  additionalEntries: ['Klasse 3: Open · Startnummer 77 · Kawasaki KX (Baujahr 2018, 250 ccm)'],
  pendingEntries: ['Klasse 4: Classic · Startnummer 91 · DKW RT 125 (Baujahr 1951, 125 ccm)'],
  translation: {
    primaryLocale: 'de',
    secondaryLocale: null,
    authorityHint: null
  },
  translatedPage: null,
  entryData: [
    { label: 'Klasse', value: 'Klasse 1: Supermoto' },
    { label: 'Startnummer', value: '42' },
    { label: 'Fahrzeug', value: 'KTM EXC (Baujahr 2020, 450 ccm)' },
    { label: 'Ersatzfahrzeug', value: 'Kawasaki KX (Baujahr 2018, 250 ccm)' },
    { label: 'Beifahrer', value: 'Anna Beispiel' }
  ],
  payment: {
    intro: 'Die Zahlungsdaten sind nachfolgend aufgeführt.',
    details: [
      { label: 'Status', value: 'offen' },
      { label: 'Nenngeld', value: '150,00 EUR' },
      { label: 'Frist', value: '15.04.2026' },
      { label: 'Empfänger', value: 'MSC Oberlausitzer Dreiländereck e.V.' },
      { label: 'IBAN', value: 'DE00123456789012345678' },
      { label: 'BIC', value: 'WELADED1GRL' },
      { label: 'Verwendungszweck', value: 'Nennung 11OLD-7K4P9 Max Musterfahrer' }
    ],
    qrCode: null,
    qrCaption: null
  },
  eventInfo: [
    { label: 'Fahrerlager', value: 'Geöffnet ab Freitag, 18:00 Uhr.' },
    { label: 'Adresse', value: 'Jägerwaldchen 2\n02763 Bertsdorf-Hörnitz' }
  ],
  schedule: ['Anmeldung: 01.05.2026, 08:00', 'Technische Abnahme: 01.05.2026, 09:00'],
  importantNotes: ['Keine Anreise über die Ortsmitte.', 'Bitte Umweltmatten verwenden.'],
  footer: {
    legalHint: 'Bei Rückfragen unterstützt Sie das Veranstaltungsteam gern.',
    lines: ['MSC Oberlausitzer Dreiländereck e.V.', 'nennung@msc-oberlausitzer-dreilaendereck.eu', 'https://www.msc-oberlausitzer-dreilaendereck.eu']
  }
});

(async () => {
  const payload = buildPayload();
  const hashA = buildEntryConfirmationRevisionHash(payload);
  const hashB = buildEntryConfirmationRevisionHash(buildPayload());
  assert.equal(hashA, hashB);

  const changedPayload = {
    ...buildPayload(),
    entryData: [{ label: 'Klasse', value: 'Klasse 2: Touring' }, ...buildPayload().entryData.slice(1)]
  };
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
    payment: null,
    eventInfo: null,
    schedule: [],
    importantNotes: []
  };
  const optionalPdf = await renderEntryConfirmationPdf(optionalPayload);
  assert.equal(optionalPdf.subarray(0, 4).toString('utf8'), '%PDF');

  const qrPayload = buildGiroCodePayload({
    recipient: 'MSC Oberlausitzer Dreiländereck e.V.',
    iban: 'DE38850501000232049807',
    bic: 'WELADED1GRL',
    amountEur: 150,
    reference: 'Nennung 11OLD-7K4P9 Max Muster'
  });
  assert.ok(qrPayload);
  const qrCode = buildGiroCodeMatrix(qrPayload);
  const qrPdf = await renderEntryConfirmationPdf({
    ...buildPayload(),
    payment: {
      ...buildPayload().payment,
      qrCode,
      qrCaption: 'GiroCode für Banking-App'
    }
  });
  assert.equal(qrPdf.subarray(0, 4).toString('utf8'), '%PDF');

  const translatedPayload = {
    ...buildPayload(),
    event: {
      ...buildPayload().event,
      locale: 'en'
    },
    translation: {
      primaryLocale: 'de',
      secondaryLocale: 'en',
      authorityHint: 'Die deutsche Fassung ist zur Vorlage bei der Veranstaltung maßgeblich.'
    },
    translatedPage: {
      title: 'Entry Confirmation',
      greeting: 'Hello Max Musterfahrer,',
      paragraphs: [
        'This letter confirms your acceptance for 12. Oberlausitzer Dreieck.',
        'This confirmation and the amount shown apply only to the entry listed below.',
        'If you pay your already accepted entries together, the current total amount is 150,00 EUR.',
        'Please bring this confirmation with you to the event.'
      ],
      sectionTitles: {
        entryDetails: 'Accepted Entry',
        additionalEntries: 'Further Accepted Entries',
        pendingEntries: 'Further Submitted Entries',
        payment: 'Payment',
        eventInfo: 'Event Information',
        schedule: 'Schedule',
        importantNotes: 'Important Notes',
        closing: 'Closing Information'
      },
      focusedEntrySummary: 'Class 1: Supermoto · Start Number 42 · KTM EXC (Baujahr 2020, 450 ccm)',
      additionalEntries: ['Class 3: Open · Start Number 77 · Kawasaki KX (Baujahr 2018, 250 ccm)'],
      pendingEntries: ['Class 4: Classic · Start Number 91 · DKW RT 125 (Baujahr 1951, 125 ccm)'],
      paymentIntro: 'The payment details are listed below.',
      paymentDetails: [
        { label: 'Status', value: 'open' },
        { label: 'Entry Fee', value: '150,00 EUR' }
      ],
      eventInfo: [{ label: 'Address', value: 'Jägerwäldchen 2\n02763 Bertsdorf-Hörnitz' }],
      schedule: ['Registration: 01.05.2026, 08:00'],
      importantNotes: ['Please use environmental mats.'],
      closingHint: 'Please note the information below.',
      authorityHint: 'The German version remains the authoritative version for presentation at the event.'
    }
  };
  const translatedPdf = await renderEntryConfirmationPdf(translatedPayload);
  const translatedPageCount = (translatedPdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length;
  assert.equal(translatedPageCount, 2);
  const firstText = firstPdf.toString('latin1');
  assert.equal(firstText.includes('undefined'), false);
  assert.equal(firstText.includes('null'), false);

  console.log('entry-confirmation-pdf.test.js: ok');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
