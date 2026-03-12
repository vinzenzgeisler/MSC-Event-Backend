const assert = require('node:assert/strict');

const { renderMailContract } = require('../dist/mail/rendering.js');

const buildBasePayload = () => ({
  eventName: '12. Oberlausitzer Dreieck',
  driverName: 'Max Musterfahrer',
  className: 'Klasse 1: Supermoto',
  startNumber: '42',
  amountOpen: '120,00 EUR',
  vehicleLabel: 'moto · KTM EXC',
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

console.log('mail-rendering-contract.test.js: ok');
