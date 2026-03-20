const assert = require('node:assert/strict');

const { getEntryLineTotalCents } = require('../dist/domain/pricingSnapshot.js');
const { buildPricingSnapshot } = require('../dist/routes/adminFinance.js');

{
  const snapshot = {
    lines: [
      {
        entryId: 'entry-a',
        lineTotalCents: 15000
      },
      {
        entryId: 'entry-b',
        lineTotalCents: 7000
      }
    ]
  };

  assert.equal(getEntryLineTotalCents(snapshot, 'entry-a'), 15000);
  assert.equal(getEntryLineTotalCents(snapshot, 'entry-b'), 7000);
  assert.equal(getEntryLineTotalCents(snapshot, 'entry-c'), null);
}

{
  assert.equal(getEntryLineTotalCents(null, 'entry-a'), null);
  assert.equal(getEntryLineTotalCents({ lines: [{}] }, 'entry-a'), null);
}

{
  const pricing = buildPricingSnapshot(
    [
      {
        entryId: 'entry-a',
        eventId: 'event-1',
        driverPersonId: 'driver-1',
        classId: 'class-a',
        acceptanceStatus: 'accepted',
        createdAt: new Date('2026-01-10T10:00:00.000Z')
      },
      {
        entryId: 'entry-b',
        eventId: 'event-1',
        driverPersonId: 'driver-1',
        classId: 'class-b',
        acceptanceStatus: 'pending',
        createdAt: new Date('2026-01-10T10:01:00.000Z')
      }
    ],
    new Map([
      ['class-a', 15000],
      ['class-b', 15000]
    ]),
    new Date('2026-02-01T00:00:00.000Z'),
    0,
    7000
  );

  assert.equal(pricing.length, 1);
  assert.equal(pricing[0].totalCents, 15000);
  assert.equal(pricing[0].snapshot.lines.length, 1);
  assert.equal(pricing[0].snapshot.lines[0].entryId, 'entry-a');
  assert.equal(pricing[0].snapshot.lines[0].lineTotalCents, 15000);
}

{
  const pricing = buildPricingSnapshot(
    [
      {
        entryId: 'entry-a',
        eventId: 'event-1',
        driverPersonId: 'driver-1',
        classId: 'class-a',
        acceptanceStatus: 'accepted',
        createdAt: new Date('2026-01-10T10:00:00.000Z')
      },
      {
        entryId: 'entry-b',
        eventId: 'event-1',
        driverPersonId: 'driver-1',
        classId: 'class-b',
        acceptanceStatus: 'accepted',
        createdAt: new Date('2026-01-10T10:01:00.000Z')
      }
    ],
    new Map([
      ['class-a', 15000],
      ['class-b', 15000]
    ]),
    new Date('2026-02-01T00:00:00.000Z'),
    0,
    7000
  );

  assert.equal(pricing.length, 1);
  assert.equal(pricing[0].totalCents, 23000);
  assert.equal(pricing[0].snapshot.lines.length, 2);
  assert.equal(pricing[0].snapshot.lines[0].entryId, 'entry-a');
  assert.equal(pricing[0].snapshot.lines[0].lineTotalCents, 15000);
  assert.equal(pricing[0].snapshot.lines[1].entryId, 'entry-b');
  assert.equal(pricing[0].snapshot.lines[1].lineTotalCents, 8000);
}

console.log('pricing-snapshot.test.js: ok');
