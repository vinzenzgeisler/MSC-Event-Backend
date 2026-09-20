const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  getNewsletterConfig,
  hashNewsletterToken,
  normalizeNewsletterLocale,
  validateNewsletterSignup,
  validateNewsletterToken
} = require('../dist/routes/newsletter');

assert.equal(normalizeNewsletterLocale('cz'), 'cs');
assert.equal(normalizeNewsletterLocale('xx'), 'de');
assert.equal(hashNewsletterToken('secret'), hashNewsletterToken('secret'));
assert.notEqual(hashNewsletterToken('secret'), 'secret');

const config = getNewsletterConfig('cs');
assert.equal(config.locale, 'cs');
assert.equal(config.consentVersion, '2026-09-20-v1');
assert.match(config.consentText, /newsletter/i);

assert.equal(validateNewsletterSignup({
  email: ' Person@Example.org ', locale: 'de', consentVersion: config.consentVersion,
  consentAccepted: true, website: ''
}).email, 'Person@Example.org');
assert.throws(() => validateNewsletterSignup({ email: 'invalid', consentAccepted: true, consentVersion: config.consentVersion }));
assert.throws(() => validateNewsletterSignup({ email: 'a@example.org', consentAccepted: false, consentVersion: config.consentVersion }));
assert.throws(() => validateNewsletterToken({ token: 'short' }));

const routeSource = fs.readFileSync(path.join(__dirname, '../src/routes/newsletter.ts'), 'utf8');
assert.match(routeSource, /on conflict do nothing/);
assert.doesNotMatch(routeSource, /on conflict \(idempotency_key\) do nothing/);

console.log('newsletter contract tests passed');
