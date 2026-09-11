const assert = require('node:assert/strict');

const { distanceKm } = require('../dist/domain/geoDistance.js');
const { filterPublicCandidates, computeEventHubFacts } = require('../dist/domain/eventHubFacts.js');
const { resolveVotingStatus } = require('../dist/routes/eventHub.js');
const { requiredAuctionBidCents, validateAuctionBidInput } = require('../dist/routes/eventAuction.js');

// distanceKm: Görlitz to Dresden is roughly 90km.
const goerlitzToDresdenKm = distanceKm(51.1528, 14.9881, 51.0504, 13.7373);
assert.ok(goerlitzToDresdenKm > 80 && goerlitzToDresdenKm < 100, `expected ~90km, got ${goerlitzToDresdenKm}`);
assert.equal(Math.round(distanceKm(50, 14, 50, 14)), 0);

const baseRow = {
  entryId: 'e1',
  classId: 'c1',
  startNumberNorm: '12',
  driverFirstName: 'Max',
  driverLastName: 'Muster',
  driverPublicationName: null,
  driverProcessingRestricted: false,
  driverObjectionFlag: false,
  driverBirthdate: '1990-01-01',
  driverCountry: 'DE',
  driverZip: '02826',
  driverCity: 'Görlitz',
  consentMediaAccepted: true,
  vehicleImageS3Key: 'img.jpg',
  vehicleMake: 'Skoda',
  vehicleModel: '130',
  vehicleYear: 1988,
  displacementCcm: 1300,
  powerPs: 58,
  cylinders: 4,
  overrideState: 'auto',
  featured: false
};

// Candidate filter: protected identity is excluded entirely.
const protectedRow = { ...baseRow, entryId: 'e2', driverPublicationName: 'Geschützt' };
const objectingRow = { ...baseRow, entryId: 'e3', driverObjectionFlag: true };
const restrictedRow = { ...baseRow, entryId: 'e4', driverProcessingRestricted: true };
const hiddenRow = { ...baseRow, entryId: 'e5', overrideState: 'hidden' };
const pinnedRow = { ...baseRow, entryId: 'e6', overrideState: 'pinned' };
const noConsentRow = { ...baseRow, entryId: 'e7', consentMediaAccepted: false };

const candidates = filterPublicCandidates([
  baseRow,
  protectedRow,
  objectingRow,
  restrictedRow,
  hiddenRow,
  pinnedRow,
  noConsentRow
]);
const candidateIds = candidates.map((c) => c.entryId);
assert.ok(!candidateIds.includes('e2'), 'publicationName-protected driver must not appear');
assert.ok(!candidateIds.includes('e3'), 'objectionFlag driver must not appear');
assert.ok(!candidateIds.includes('e4'), 'processingRestricted driver must not appear');
assert.ok(!candidateIds.includes('e5'), 'hidden override must not appear');
assert.ok(candidateIds.includes('e6'), 'pinned override must appear');
assert.notEqual(candidates[0].entryId, 'e6', 'editorial pinning must not bias voting order');
assert.equal(candidates.find((candidate) => candidate.entryId === 'e6').pinned, false, 'legacy pin is not exposed as voting priority');

const noConsentCandidate = candidates.find((c) => c.entryId === 'e7');
assert.equal(noConsentCandidate.vehicleImageS3Key, null, 'vehicle image must be withheld without media consent');

// Facts: ties are reported together, missing data is skipped.
const tieRowA = { ...baseRow, entryId: 't1', vehicleYear: 1970 };
const tieRowB = { ...baseRow, entryId: 't2', vehicleYear: 1970 };
const facts = computeEventHubFacts([tieRowA, tieRowB], '2026-09-12', null, new Map());
assert.equal(facts.oldestVehicle.length, 2, 'tied oldest vehicle facts must be reported together');
assert.equal(facts.farthestTravelKm, null, 'without venue coordinates the travel fact must be omitted');

const noBirthdateFacts = computeEventHubFacts(
  [{ ...baseRow, driverBirthdate: null }],
  '2026-09-12',
  null,
  new Map()
);
assert.equal(noBirthdateFacts.youngestDriver, null, 'missing birthdate data must omit the fact instead of guessing');

// Auction: first bid uses the configured start, later bids require one full increment.
assert.equal(requiredAuctionBidCents(10_000, 500, null), 10_000);
assert.equal(requiredAuctionBidCents(10_000, 500, 12_000), 12_500);
const validBid = {
  bidderName: 'Max Muster',
  contactType: 'email',
  contactValue: 'max@example.org',
  amountCents: 12_500,
  acceptedBinding: true,
  termsVersion: 'auction-event-version',
  clientSubmissionKey: '987e6543-e21b-42d3-a456-426614174000',
  website: ''
};
assert.equal(validateAuctionBidInput(validBid).amountCents, 12_500);
assert.throws(() => validateAuctionBidInput({ ...validBid, acceptedBinding: false }), /Invalid literal value/);
assert.throws(() => validateAuctionBidInput({ ...validBid, contactValue: 'not-an-email' }), /Invalid email/);

// Voting status boundaries.
const now = new Date('2026-09-12T12:00:00Z');
assert.equal(resolveVotingStatus(null, now), 'not_open');
assert.equal(
  resolveVotingStatus({ votingMode: 'auto', votingOpensAt: '2026-09-13T00:00:00Z', votingClosesAt: null }, now),
  'not_open'
);
assert.equal(
  resolveVotingStatus({ votingMode: 'auto', votingOpensAt: '2026-09-01T00:00:00Z', votingClosesAt: '2026-09-13T00:00:00Z' }, now),
  'open'
);
assert.equal(
  resolveVotingStatus({ votingMode: 'auto', votingOpensAt: '2026-09-01T00:00:00Z', votingClosesAt: '2026-09-12T00:00:00Z' }, now),
  'closed'
);
assert.equal(
  resolveVotingStatus({ votingMode: 'forced_open', votingOpensAt: null, votingClosesAt: '2026-09-01T00:00:00Z' }, now),
  'open'
);
assert.equal(
  resolveVotingStatus({ votingMode: 'forced_closed', votingOpensAt: '2026-09-01T00:00:00Z', votingClosesAt: null }, now),
  'closed'
);

console.log('event-hub-voting.test.js: ok');
