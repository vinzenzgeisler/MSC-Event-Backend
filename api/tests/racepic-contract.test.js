const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const migration = read('api/migrations/0109_racepic_reliability_privacy.sql');
assert.match(migration, /racepic_participant_suppression/);
assert.match(migration, /racepic_manifest_refresh/);
assert.match(migration, /lease_expires_at/);
assert.match(migration, /racepic_upload_active_fingerprint_unique/);

const eligibility = read('api/src/racepic/eligibility.ts');
assert.match(eligibility, /i\.visibility = 'PUBLISHED'/);
assert.doesNotMatch(eligibility, /racepic_participant_suppression/);
assert.doesNotMatch(eligibility, /objection_flag/);

const publish = read('api/src/racepic/publish.ts');
assert.match(publish, /consentMediaAccepted/);
assert.match(publish, /processingRestricted/);
assert.match(publish, /objectionFlag/);

const upload = read('api/src/racepic/uploads.ts');
assert.match(upload, /objectInfo\.sizeBytes !== upload\.declaredSizeBytes/);
assert.match(upload, /objectInfo\.contentType !== upload\.contentType/);
assert.match(upload, /status: 'INITIALIZING'/);
assert.match(upload, /resumed: true/);

const stack = read('infra/lib/stacks/racepic-stack.ts');
assert.match(stack, /DenyUnsignedPrivatePaths/);
assert.match(stack, /refreshTokenRotation/);
assert.doesNotMatch(stack, /ALLOW_REFRESH_TOKEN_AUTH/);

const handler = read('api/src/racepic/handler.ts');
assert.match(handler, /RACEPIC_TERMS_VERSION_REQUIRED/);
assert.doesNotMatch(handler, /hiddenImageCount/);
assert.doesNotMatch(handler, /\/racepic\/health/);

const { scoreCandidate } = require('../dist/racepic/matching.js');
const weights = { ocrExact: 0.45, ocrConfidence: 0.05, vehicleTypeMatch: 0.1, embeddingSimilarity: 0.25, colorSimilarity: 0.15, ambiguityPenalty: 0.15 };
const exactWithOutdatedReference = scoreCandidate({ ocrExact: true, ocrConfidence: 0.95, vehicleTypeMatch: true, embeddingSimilarity: 0.1, colorSimilarity: 0.05, ambiguityCount: 1 }, weights);
const exactWithNeutralReference = scoreCandidate({ ocrExact: true, ocrConfidence: 0.95, vehicleTypeMatch: true, embeddingSimilarity: 0.5, colorSimilarity: 0.5, ambiguityCount: 1 }, weights);
assert.equal(exactWithOutdatedReference, exactWithNeutralReference, 'outdated reference appearance must not penalize an exact race-number match');

console.log('RacePic cross-repository contract checks passed');
