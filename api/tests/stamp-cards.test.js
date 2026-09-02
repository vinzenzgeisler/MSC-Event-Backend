const assert = require('node:assert/strict');
const { validateStampCardExportInput } = require('../dist/routes/stampCards');

const eventId = '11111111-1111-4111-8111-111111111111';
const personId = '22222222-2222-4222-8222-222222222222';

assert.deepEqual(validateStampCardExportInput({ eventId, selection: { type: 'accepted_regular' } }), {
  eventId,
  startSlot: 1,
  selection: { type: 'accepted_regular' }
});

assert.equal(validateStampCardExportInput({
  eventId,
  startSlot: 10,
  selection: { type: 'subjects', subjects: [{ cardType: 'driver', personId }] }
}).startSlot, 10);

assert.throws(() => validateStampCardExportInput({ eventId, startSlot: 11, selection: { type: 'accepted_regular' } }));
assert.throws(() => validateStampCardExportInput({ eventId, startSlot: 1, selection: { type: 'subjects', subjects: [] } }));

console.log('stamp-card contract tests passed');
