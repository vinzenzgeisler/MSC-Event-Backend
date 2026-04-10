const assert = require('node:assert/strict');

const { buildPublicRateLimitKey } = require('../dist/http/publicRateLimit.js');

assert.equal(buildPublicRateLimitKey(['1.2.3.4', 'entry-1']), '1.2.3.4|entry-1');
assert.equal(buildPublicRateLimitKey(['1.2.3.4', '', 'entry-1']), '1.2.3.4|entry-1');
assert.equal(buildPublicRateLimitKey([' 1.2.3.4 ', null, ' verify ']), '1.2.3.4|verify');
assert.equal(buildPublicRateLimitKey([undefined, '']), '');

console.log('public-rate-limit.test.js: ok');
