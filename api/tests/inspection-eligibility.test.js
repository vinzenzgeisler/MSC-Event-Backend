const assert = require('node:assert/strict');

const {
  evaluateInspectionEligibility,
  buildParticipantInspectionSummary
} = require('../dist/domain/inspectionReadiness');
const {
  validateInspectionAccessInput,
  validateInspectionOverviewInput
} = require('../dist/routes/technicalInspection');

void (async () => {
  // Eligibility rule: paid or not_required + current waiver, checkinIdVerified/codriver waiver play no role.
  assert.deepEqual(evaluateInspectionEligibility('paid', true), {
    ready: true,
    paymentStatus: 'paid',
    waiverSigned: true,
    missingRequirements: []
  });
  assert.deepEqual(evaluateInspectionEligibility('not_required', true), {
    ready: true,
    paymentStatus: 'not_required',
    waiverSigned: true,
    missingRequirements: []
  });
  assert.deepEqual(evaluateInspectionEligibility('due', true).missingRequirements, ['payment']);
  assert.deepEqual(evaluateInspectionEligibility('paid', false).missingRequirements, ['waiver']);
  assert.deepEqual(evaluateInspectionEligibility('due', false).missingRequirements, ['payment', 'waiver']);
  assert.deepEqual(evaluateInspectionEligibility(undefined, false).paymentStatus, 'unknown');
  assert.equal(evaluateInspectionEligibility(undefined, false).ready, false);

  // Doppelstarter: main + backup vehicles of every accepted entry count as separate targets.
  const eligibleReady = evaluateInspectionEligibility('paid', true);
  const singleStarterEntries = [
    {
      id: 'entry-1',
      startNumber: '101',
      className: 'Klasse 1',
      vehicleMake: 'BMW',
      vehicleModel: '2002',
      techStatus: 'passed',
      backupVehicleId: null,
      backupTechStatus: 'pending'
    }
  ];
  const singleSummary = buildParticipantInspectionSummary(singleStarterEntries, eligibleReady);
  assert.equal(singleSummary.totalTargets, 1);
  assert.equal(singleSummary.passedTargets, 1);
  assert.equal(singleSummary.stampReady, true);

  const doubleStarterEntries = [
    {
      id: 'entry-1',
      startNumber: '101',
      className: 'Klasse 1',
      vehicleMake: 'BMW',
      vehicleModel: '2002',
      techStatus: 'passed',
      backupVehicleId: 'vehicle-backup-1',
      backupVehicleMake: 'BMW',
      backupVehicleModel: '2002 tii',
      backupTechStatus: 'pending'
    },
    {
      id: 'entry-2',
      startNumber: '102',
      className: 'Klasse 4',
      vehicleMake: 'Porsche',
      vehicleModel: '911',
      techStatus: 'passed',
      backupVehicleId: null,
      backupTechStatus: 'pending'
    }
  ];
  const doubleSummary = buildParticipantInspectionSummary(doubleStarterEntries, eligibleReady);
  // 2 primary + 1 backup = 3 targets; TA-stamp release requires ALL of them, not just primaries.
  assert.equal(doubleSummary.totalTargets, 3);
  assert.equal(doubleSummary.passedTargets, 2);
  assert.equal(doubleSummary.pendingTargets, 1);
  assert.equal(doubleSummary.stampReady, false, 'stamp must stay locked while the backup vehicle is still pending');

  const allPassedEntries = doubleStarterEntries.map((item) => ({ ...item, backupTechStatus: 'passed' }));
  const allPassedSummary = buildParticipantInspectionSummary(allPassedEntries, eligibleReady);
  assert.equal(allPassedSummary.stampReady, true);

  // Eligibility gate wins over target completion: a driver with open payment never gets stampReady, even if all vehicles passed.
  const notEligible = evaluateInspectionEligibility('due', true);
  const blockedByPayment = buildParticipantInspectionSummary(allPassedEntries, notEligible);
  assert.equal(blockedByPayment.stampReady, false);

  // A rejected vehicle also revokes readiness even if the rest passed.
  const oneFailedEntries = allPassedEntries.map((item, index) => (index === 0 ? { ...item, techStatus: 'failed' } : item));
  const failedSummary = buildParticipantInspectionSummary(oneFailedEntries, eligibleReady);
  assert.equal(failedSummary.failedTargets, 1);
  assert.equal(failedSummary.stampReady, false);

  // Access-check input validation covers entry, participant and every allowed source.
  assert.deepEqual(
    validateInspectionAccessInput({ type: 'entry', entryId: '62a51216-d4b2-4aca-bc9a-5bc93cbef204', source: 'qr' }),
    { type: 'entry', entryId: '62a51216-d4b2-4aca-bc9a-5bc93cbef204', source: 'qr' }
  );
  assert.deepEqual(
    validateInspectionAccessInput({
      type: 'participant',
      eventId: '62a51216-d4b2-4aca-bc9a-5bc93cbef204',
      personId: '62a51216-d4b2-4aca-bc9a-5bc93cbef204',
      source: 'search'
    }),
    {
      type: 'participant',
      eventId: '62a51216-d4b2-4aca-bc9a-5bc93cbef204',
      personId: '62a51216-d4b2-4aca-bc9a-5bc93cbef204',
      source: 'search'
    }
  );
  assert.throws(() => validateInspectionAccessInput({ type: 'entry', entryId: 'not-a-uuid', source: 'qr' }));
  assert.throws(() =>
    validateInspectionAccessInput({ type: 'entry', entryId: '62a51216-d4b2-4aca-bc9a-5bc93cbef204', source: 'unknown-source' })
  );

  // Overview input defaults the page size and accepts an optional eventId filter.
  assert.deepEqual(validateInspectionOverviewInput({}), { eventId: undefined, limit: 40 });
  assert.deepEqual(validateInspectionOverviewInput({ eventId: '62a51216-d4b2-4aca-bc9a-5bc93cbef204', limit: '10' }), {
    eventId: '62a51216-d4b2-4aca-bc9a-5bc93cbef204',
    limit: 10
  });

  console.log('inspection-eligibility.test.js: ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
