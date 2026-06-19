const assert = require('node:assert/strict');

const {
  classifyCandidates,
  fingerprintCandidate,
  toManifestCandidate
} = require('../dist/tools/doublestarterMigration.js');
const fs = require('node:fs');

const row = (overrides) => ({
  event_id: 'e5dc0ac8-3a6f-4ee3-9a1c-45e2057d2a28',
  event_name: '12. Oberlausitzer Dreieck',
  entry_id: '00000000-0000-4000-8000-000000000001',
  class_id: '00000000-0000-4000-8000-000000000011',
  class_name: 'Klasse 1',
  vehicle_id: '00000000-0000-4000-8000-000000000021',
  vehicle_make: 'KTM',
  vehicle_model: 'EXC',
  backup_vehicle_id: null,
  start_number_norm: '42',
  driver_person_id: '00000000-0000-4000-8000-000000000031',
  registration_group_id: '00000000-0000-4000-8000-000000000041',
  driver_email_norm: 'first@example.org',
  person_email: 'first@example.org',
  first_name: 'Max',
  last_name: 'Mustermann',
  birthdate: '1980-01-01',
  registration_status: 'submitted_verified',
  acceptance_status: 'pending',
  orga_code: '12OLD-ABC',
  entry_created_at: new Date('2026-05-01T10:00:00Z'),
  group_created_at: new Date('2026-05-01T10:00:00Z'),
  invoice_id: '00000000-0000-4000-8000-000000000051',
  invoice_total_cents: 0,
  invoice_paid_amount_cents: 0,
  invoice_payment_status: 'due',
  invoice_pricing_snapshot: {},
  invoice_payment_count: 0,
  ...overrides
});

const second = row({
  entry_id: '00000000-0000-4000-8000-000000000002',
  class_id: '00000000-0000-4000-8000-000000000012',
  class_name: 'Klasse 2',
  vehicle_id: '00000000-0000-4000-8000-000000000022',
  vehicle_make: 'Husqvarna',
  vehicle_model: 'WR',
  start_number_norm: '43',
  driver_person_id: '00000000-0000-4000-8000-000000000032',
  registration_group_id: '00000000-0000-4000-8000-000000000042',
  driver_email_norm: 'second@example.org',
  person_email: 'second@example.org',
  entry_created_at: new Date('2026-05-02T10:00:00Z'),
  group_created_at: new Date('2026-05-02T10:00:00Z'),
  invoice_id: '00000000-0000-4000-8000-000000000052',
  orga_code: '12OLD-DEF'
});

{
  const result = classifyCandidates([second, row({})]);
  assert.equal(result.automatic.length, 1);
  assert.equal(result.manualSameClass.length, 0);
  const manifest = toManifestCandidate(result.automatic[0]);
  assert.equal(manifest.canonicalEntryId, '00000000-0000-4000-8000-000000000001');
  assert.equal(manifest.secondaryEntryId, '00000000-0000-4000-8000-000000000002');
  assert.equal(manifest.fingerprint, fingerprintCandidate(result.automatic[0]));
}

{
  const sameClass = classifyCandidates([row({}), { ...second, class_id: row({}).class_id }]);
  assert.equal(sameClass.automatic.length, 0);
  assert.equal(sameClass.manualSameClass.length, 1);
}

{
  const paid = classifyCandidates([row({}), { ...second, invoice_payment_count: 1 }]);
  assert.equal(paid.automatic.length, 0);
}

{
  const first = classifyCandidates([row({}), second]).automatic[0];
  const changed = classifyCandidates([row({}), { ...second, acceptance_status: 'accepted' }]).automatic[0];
  assert.ok(first);
  assert.equal(changed, undefined);
}

{
  const source = fs.readFileSync(require.resolve('../dist/tools/doublestarterMigration.js'), 'utf8');
  assert.match(source, /inner join "class" ec on ec\.id = e\.class_id/);
  assert.equal(source.includes('inner join event_class ec'), false);
}
