const assert = require('node:assert/strict');

const {
  resolvePublicLegalLocale,
  validatePublicLegalCurrentQuery
} = require('../dist/routes/publicLegal.js');

assert.equal(resolvePublicLegalLocale('de'), 'de-DE');
assert.equal(resolvePublicLegalLocale('de-DE'), 'de-DE');
assert.equal(resolvePublicLegalLocale('en'), 'en-GB');
assert.equal(resolvePublicLegalLocale('cs'), 'cs-CZ');
assert.equal(resolvePublicLegalLocale('cz'), 'cs-CZ');
assert.equal(resolvePublicLegalLocale('pl'), 'pl-PL');
assert.equal(resolvePublicLegalLocale('unknown-locale'), 'de-DE');

assert.deepEqual(validatePublicLegalCurrentQuery({ locale: 'de-DE' }), { locale: 'de-DE' });
assert.deepEqual(validatePublicLegalCurrentQuery({}), {});

console.log('public-legal-contract.test.js: ok');
