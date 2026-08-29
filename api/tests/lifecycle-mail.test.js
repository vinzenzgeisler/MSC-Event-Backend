const assert = require('node:assert/strict');

const {
  LifecycleMailError,
  hasRequiredRegistrationReceivedVariables,
  resolveLocalizedMailContent,
  resolveQueueMailLocale,
  toLifecycleApiError,
  validateCommunicationSendInput
} = require('../dist/routes/adminMail.js');

const successCase = hasRequiredRegistrationReceivedVariables({
  eventName: 'MSC Event 2026',
  driverName: 'Max Mustermann',
  verificationUrl: 'https://example.org/verify?entryId=e&token=t'
});
assert.equal(successCase, true);

const missingVerificationUrl = hasRequiredRegistrationReceivedVariables({
  eventName: 'MSC Event 2026',
  driverName: 'Max Mustermann',
  verificationUrl: null
});
assert.equal(missingVerificationUrl, false);

assert.equal(resolveQueueMailLocale({}), 'de');
assert.equal(resolveQueueMailLocale({ defaultLocale: 'cs' }), 'cs');
assert.equal(resolveQueueMailLocale({ preferredLocale: 'pl', defaultLocale: 'cs' }), 'pl');
assert.equal(resolveQueueMailLocale({ explicitLocale: 'en', preferredLocale: 'pl', defaultLocale: 'cs' }), 'en');

const localizedContent = {
  localizedContent: {
    de: { subject: 'Informationen', bodyText: 'Deutscher Text', bodyHtml: '<p>Deutscher Text</p>' },
    pl: {
      subject: 'Informacje',
      bodyText: 'Polski tekst',
      bodyHtml: '<p>Polski tekst</p>',
      preheader: 'Ważne informacje',
      heroSubtitle: 'Informacje dotyczące udziału.',
      eventDateText: '12–13 września 2026'
    }
  }
};
assert.deepEqual(resolveLocalizedMailContent(localizedContent, 'pl'), localizedContent.localizedContent.pl);
assert.deepEqual(resolveLocalizedMailContent(localizedContent, 'cs'), localizedContent.localizedContent.de);
assert.equal(resolveLocalizedMailContent({}, 'de'), null);

const campaignSendInput = validateCommunicationSendInput({
  eventId: 'e5dc0ac8-3a6f-4ee3-9a1c-45e2057d2a28',
  templateKey: 'event_update',
  filters: { acceptanceStatus: 'accepted' },
  bccEmails: ['nennung@msc-oberlausitzer-dreilaendereck.eu']
});
assert.deepEqual(campaignSendInput.bccEmails, ['nennung@msc-oberlausitzer-dreilaendereck.eu']);

const cases = [
  ['NO_RECIPIENT', 409, 'No recipient email available'],
  ['NOT_ALLOWED', 409, 'Lifecycle mail not allowed for this entry'],
  ['TEMPLATE_RENDER_FAILED', 400, 'Lifecycle template render failed'],
  ['OUTBOX_INSERT_FAILED', 409, 'Lifecycle outbox insert failed'],
  ['TEMPLATE_NOT_FOUND', 404, 'Template not found'],
  ['ENTRY_NOT_FOUND', 404, 'Entry not found'],
  ['ENTRY_CONFIRMATION_PDF_GENERATION_FAILED', 500, 'Entry confirmation PDF generation failed']
];

for (const [code, expectedStatusCode, expectedMessage] of cases) {
  const mapped = toLifecycleApiError(new LifecycleMailError(code, 'test_reason'));
  assert.equal(mapped.statusCode, expectedStatusCode);
  assert.equal(mapped.message, expectedMessage);
  assert.equal(mapped.code, code);
  assert.deepEqual(mapped.details, { reason: 'test_reason' });
}

console.log('lifecycle-mail.test.js: ok');
