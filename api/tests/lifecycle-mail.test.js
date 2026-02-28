const assert = require('node:assert/strict');

const {
  LifecycleMailError,
  hasRequiredRegistrationReceivedVariables,
  toLifecycleApiError
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

const cases = [
  ['NO_RECIPIENT', 409, 'No recipient email available'],
  ['NOT_ALLOWED', 409, 'Lifecycle mail not allowed for this entry'],
  ['TEMPLATE_RENDER_FAILED', 400, 'Lifecycle template render failed'],
  ['OUTBOX_INSERT_FAILED', 409, 'Lifecycle outbox insert failed'],
  ['TEMPLATE_NOT_FOUND', 404, 'Template not found'],
  ['ENTRY_NOT_FOUND', 404, 'Entry not found']
];

for (const [code, expectedStatusCode, expectedMessage] of cases) {
  const mapped = toLifecycleApiError(new LifecycleMailError(code, 'test_reason'));
  assert.equal(mapped.statusCode, expectedStatusCode);
  assert.equal(mapped.message, expectedMessage);
  assert.equal(mapped.code, code);
  assert.deepEqual(mapped.details, { reason: 'test_reason' });
}

console.log('lifecycle-mail.test.js: ok');
