const assert = require('node:assert/strict');

const { renderMailContract } = require('../dist/mail/rendering.js');
const { resolveMailLocale } = require('../dist/mail/i18n.js');

const buildBasePayload = () => ({
  eventName: '12. Oberlausitzer Dreieck',
  driverName: 'Max Musterfahrer',
  className: 'Klasse 1: Supermoto',
  startNumber: '42',
  amountOpen: '120,00 EUR',
  vehicleLabel: 'KTM EXC',
  eventDateText: '01.05.2026 - 02.05.2026',
  contactEmail: 'orga@example.org',
  nennungstoolUrl: 'https://event.msc-oberlausitzer-dreilaendereck.de'
});

// Deterministic parity: same payload -> same output (Preview/Send pipeline parity).
{
  const payload = {
    ...buildBasePayload(),
    locale: 'de',
    introText: 'Kurzes Update',
    detailsText: 'Zeitplan aktualisiert.',
    closingText: 'Wir freuen uns auf dich.',
    heroImageUrl: 'https://event.msc-oberlausitzer-dreilaendereck.de/assets/hero.jpg',
    ctaText: 'Zum Update',
    ctaUrl: 'https://event.msc-oberlausitzer-dreilaendereck.de/news'
  };
  const input = {
    templateKey: 'newsletter',
    subjectTemplate: 'Newsletter - {{eventName}}',
    bodyTextTemplate: 'Hallo {{driverName}}',
    bodyHtmlTemplate: null,
    data: payload
  };
  const first = renderMailContract(input);
  const second = renderMailContract(input);
  assert.equal(first.htmlDocument, second.htmlDocument);
  assert.equal(first.subjectRendered, second.subjectRendered);
}

// Locale fallback: unsupported locale must fall back to en.
{
  const rendered = renderMailContract({
    templateKey: 'registration_received',
    subjectTemplate: 'Registration received - {{eventName}}',
    bodyTextTemplate: 'Hello {{driverName}}',
    bodyHtmlTemplate: null,
    data: {
      ...buildBasePayload(),
      locale: 'es',
      verificationUrl: 'https://event.example.org/verify?token=abc'
    }
  });
  assert.match(rendered.htmlDocument, /<html lang="en">/);
  assert.match(rendered.bodyTextRendered, /Kind regards/);
}

// Nationality fallback: unmapped countries must fall back to en.
{
  assert.equal(resolveMailLocale({ nationality: 'FR' }), 'en');
}

// Campaign default: badge hidden; entry context visible only when enabled.
{
  const baseInput = {
    templateKey: 'newsletter',
    subjectTemplate: 'Newsletter - {{eventName}}',
    bodyTextTemplate: 'Hallo {{driverName}}',
    bodyHtmlTemplate: null,
    data: {
      ...buildBasePayload(),
      locale: 'de',
      heroImageUrl: 'https://event.msc-oberlausitzer-dreilaendereck.de/assets/hero.jpg'
    }
  };
  const withDefault = renderMailContract(baseInput);
  assert.equal(withDefault.htmlDocument.includes('mail-badge-wrap" align="right"'), false);
  assert.match(withDefault.htmlDocument, /Deine Anmeldung/);

  const withoutContext = renderMailContract({
    ...baseInput,
    renderOptions: { includeEntryContext: false }
  });
  assert.equal(withoutContext.htmlDocument.includes('Deine Anmeldung'), false);
}

// Verification reminder must render clickable verification link.
{
  const verificationUrl = 'https://event.example.org/verify?token=abc123';
  const rendered = renderMailContract({
    templateKey: 'email_confirmation_reminder',
    subjectTemplate: 'Erinnerung - {{eventName}}',
    bodyTextTemplate: 'Bitte bestätige: {{verificationUrl}}',
    bodyHtmlTemplate: null,
    data: {
      ...buildBasePayload(),
      locale: 'de',
      verificationUrl
    }
  });
  assert.equal(rendered.warnings.length, 0);
  assert.match(rendered.bodyTextRendered, /https:\/\/event\.example\.org\/verify\?token=abc123/);
  assert.match(rendered.htmlDocument, /href="https:\/\/event\.example\.org\/verify\?token=abc123"/);
}

// Process/codriver templates enforce canonical outer layout and ignore stored full HTML.
{
  const rendered = renderMailContract({
    templateKey: 'codriver_info',
    subjectTemplate: 'Info - {{eventName}}',
    bodyTextTemplate: 'Hallo {{driverName}}',
    bodyHtmlTemplate: '<!doctype html><html><body><div style="background:red">legacy</div></body></html>',
    data: {
      ...buildBasePayload(),
      locale: 'de'
    }
  });
  assert.equal(rendered.warnings.some((item) => item.includes('Template-HTML wird für dieses Template ignoriert')), true);
  assert.equal(rendered.htmlDocument.includes('background:red'), false);
  assert.match(rendered.htmlDocument, /mail-card/);
}

// Header must always include legal suffix e.V.
{
  const rendered = renderMailContract({
    templateKey: 'registration_received',
    subjectTemplate: 'Anmeldung eingegangen - {{eventName}}',
    bodyTextTemplate: 'Hallo {{driverName}}',
    bodyHtmlTemplate: null,
    data: {
      ...buildBasePayload(),
      locale: 'de',
      verificationUrl: 'https://event.example.org/verify?token=abc123'
    }
  });
  assert.match(rendered.htmlDocument, /MSC Oberlausitzer Dreiländereck e\.V\./);
}

// Registration confirmation must show all entries for multi-entry registrations.
{
  const rendered = renderMailContract({
    templateKey: 'registration_received',
    subjectTemplate: 'Anmeldung eingegangen - {{eventName}}',
    bodyTextTemplate: 'Hallo {{driverName}}',
    bodyHtmlTemplate: null,
    data: {
      ...buildBasePayload(),
      locale: 'de',
      verificationUrl: 'https://event.example.org/verify?token=abc123',
      registrationNextStepText:
        'Sobald du deine E-Mail-Adresse bestätigt hast, prüfen wir deine Nennungen und melden uns mit dem nächsten Stand. Zahlungsinformationen erhältst du erst mit einer Zulassung.',
      entrySummaries: [
        'Klasse 1: Supermoto · Startnummer 42 · KTM EXC',
        'Klasse 2: Classic · Startnummer 43 · Husqvarna WR'
      ]
    }
  });
  assert.match(rendered.htmlDocument, /Nennungen/);
  assert.match(rendered.htmlDocument, /Husqvarna WR/);
  assert.equal(rendered.htmlDocument.includes('Startnummer</td><td'), false);
  assert.match(rendered.bodyTextRendered, /deine Nennungen/);
  assert.match(rendered.bodyTextRendered, /Zahlungsinformationen erhältst du erst mit einer Zulassung/);
  assert.equal(/Verwendungszweck: Nennung/.test(rendered.bodyTextRendered), false);
}

// Acceptance mail for multiple entries stays focused on the current entry and uses professional payment copy.
{
  const rendered = renderMailContract({
    templateKey: 'accepted_open_payment',
    subjectTemplate: 'Zulassung bestätigt - {{eventName}}',
    bodyTextTemplate: 'Hallo {{driverName}}',
    bodyHtmlTemplate: null,
    data: {
      ...buildBasePayload(),
      locale: 'de',
      amountOpen: '70,00 EUR',
      paymentDueDate: '15.04.2026',
      paymentRecipient: 'MSC Oberlausitzer Dreiländereck e.V.',
      paymentIban: 'DE38 8505 0100 0232 0498 07',
      acceptedEntrySummaryText: 'Klasse 1: Supermoto · Startnummer 42 · KTM EXC',
      entryScopeHint:
        'Diese Zulassung und der ausgewiesene Betrag beziehen sich ausschließlich auf die in dieser E-Mail genannte Nennung.',
      paymentInstructionText:
        'Bitte überweise das Nenngeld bis 15.04.2026 auf folgendes Konto:\n- Betrag: 70,00 EUR\n- Empfänger: MSC Oberlausitzer Dreiländereck e.V.\n- IBAN: DE38 8505 0100 0232 0498 07\n- Verwendungszweck: Nennung 11OLD-7K4P9 Max Musterfahrer',
      combinedTransferHint:
        'Bei gemeinsamer Überweisung deiner bereits zugelassenen Nennungen beträgt der aktuelle Gesamtbetrag 150,00 EUR.',
      entrySummaries: [
        'Klasse 1: Supermoto · Startnummer 42 · KTM EXC',
        'Klasse 2: Classic · Startnummer 43 · Husqvarna WR'
      ]
    }
  });
  assert.match(rendered.bodyTextRendered, /Folgende Nennung wurde für das 12\. Oberlausitzer Dreieck zugelassen:/);
  assert.equal(/deine Nennungen/.test(rendered.bodyTextRendered), false);
  assert.match(rendered.bodyTextRendered, /Klasse 1: Supermoto · Startnummer 42 · KTM EXC/);
  assert.match(rendered.bodyTextRendered, /Bitte überweise das Nenngeld bis 15\.04\.2026 auf folgendes Konto/);
  assert.match(rendered.bodyTextRendered, /Verwendungszweck: Nennung/);
  assert.match(rendered.bodyTextRendered, /aktuelle Gesamtbetrag 150,00 EUR/);
  assert.equal(/Zahlungsinfos in Kurzform/.test(rendered.bodyTextRendered), false);
  assert.equal(rendered.htmlDocument.includes('Empfänger</td>'), false);
  assert.equal(rendered.htmlDocument.includes('IBAN</td>'), false);
}

// Payment reminder should include richer payment details in the info card.
{
  const rendered = renderMailContract({
    templateKey: 'payment_reminder',
    subjectTemplate: 'Zahlungserinnerung - {{eventName}}',
    bodyTextTemplate: 'Hallo {{driverName}}',
    bodyHtmlTemplate: null,
    data: {
      ...buildBasePayload(),
      locale: 'de',
      paymentDueDate: '15.04.2026',
      paymentRecipient: 'MSC Oberlausitzer Dreiländereck e.V.',
      paymentIban: 'DE38 8505 0100 0232 0498 07',
      paymentBic: 'WELADED1GRL',
      paymentInstructionText:
        'Diese Erinnerung bezieht sich auf folgende zugelassene Nennung:\nKlasse 1: Supermoto · Startnummer 42 · KTM EXC\n\nBitte überweise das offene Nenngeld auf folgendes Konto:\n- Betrag: 120,00 EUR\n- Frist: 15.04.2026\n- Empfänger: MSC Oberlausitzer Dreiländereck e.V.\n- IBAN: DE38 8505 0100 0232 0498 07\n- Verwendungszweck: Nennung 11OLD-7K4P9 Max Musterfahrer\n\nBei gemeinsamer Überweisung deiner bereits zugelassenen Nennungen beträgt der aktuelle Gesamtbetrag 150,00 EUR.',
      entrySummaries: [
        'Klasse 1: Supermoto · Startnummer 42 · KTM EXC',
        'Klasse 2: Classic · Startnummer 43 · Husqvarna WR'
      ]
    }
  });
  assert.match(rendered.bodyTextRendered, /Diese Erinnerung bezieht sich auf folgende zugelassene Nennung/);
  assert.match(rendered.bodyTextRendered, /Verwendungszweck: Nennung 11OLD-7K4P9 Max Musterfahrer/);
  assert.match(rendered.bodyTextRendered, /aktuelle Gesamtbetrag 150,00 EUR/);
  assert.equal(/deine Nennungen/.test(rendered.bodyTextRendered), false);
  assert.equal(rendered.htmlDocument.includes('Empfänger</td>'), false);
  assert.equal(rendered.htmlDocument.includes('IBAN</td>'), false);
  assert.match(rendered.htmlDocument, /Husqvarna WR/);
}

// Rejection mail for multiple entries must clearly identify the rejected entry and scope.
{
  const rendered = renderMailContract({
    templateKey: 'rejected',
    subjectTemplate: 'Status deiner Nennung - {{eventName}}',
    bodyTextTemplate: 'Hallo {{driverName}}',
    bodyHtmlTemplate: null,
    data: {
      ...buildBasePayload(),
      locale: 'de',
      rejectedEntrySummaryText: 'Klasse 1: Supermoto · Startnummer 42 · KTM EXC',
      rejectionScopeHint:
        'Diese Entscheidung bezieht sich ausschließlich auf die in dieser E-Mail genannte Nennung. Weitere Nennungen auf Ihren Namen bleiben davon unberührt und werden gesondert entschieden.',
      entrySummaries: [
        'Klasse 1: Supermoto · Startnummer 42 · KTM EXC',
        'Klasse 2: Classic · Startnummer 43 · Husqvarna WR'
      ]
    }
  });
  assert.match(rendered.bodyTextRendered, /Folgende Nennung können wir für das 12\. Oberlausitzer Dreieck aktuell leider nicht berücksichtigen:/);
  assert.match(rendered.bodyTextRendered, /Klasse 1: Supermoto · Startnummer 42 · KTM EXC/);
  assert.match(rendered.bodyTextRendered, /Weitere Nennungen auf Ihren Namen bleiben davon unberührt/);
}

// Codriver mail must not contain dedicated "Bei Rückfragen melde dich bitte unter ..." sentence in body.
{
  const rendered = renderMailContract({
    templateKey: 'codriver_info',
    subjectTemplate: 'Info - {{eventName}}',
    bodyTextTemplate: 'Hallo {{driverName}}\n\nBei Rückfragen melde dich bitte unter {{contactEmail}}.',
    bodyHtmlTemplate: '<p>Hallo {{driverName}}</p><p>Bei Rückfragen melde dich bitte unter {{contactEmail}}.</p>',
    data: {
      ...buildBasePayload(),
      locale: 'de'
    }
  });
  assert.equal(/bei rückfragen melde dich bitte unter/i.test(rendered.bodyTextRendered), false);
  assert.equal(/bei rückfragen melde dich bitte unter/i.test(rendered.bodyHtmlRendered), false);
}

console.log('mail-rendering-contract.test.js: ok');
