const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  assertBackupClassCompatible,
  assertUniqueEffectiveRunGroups,
  effectiveRunGroupId,
  reservedStartNumberClassIds
} = require('../dist/domain/runGroups');
const eventId = '10000000-0000-4000-8000-000000000000';
const classes = new Map([
  ['a', { id: 'a', eventId, runGroupId: 'group-1', registrationClosed: false, vehicleType: 'auto' }],
  ['b', { id: 'b', eventId, runGroupId: 'group-1', registrationClosed: false, vehicleType: 'auto' }],
  ['c', { id: 'c', eventId, runGroupId: null, registrationClosed: false, vehicleType: 'moto' }],
  ['d', { id: 'd', eventId, runGroupId: null, registrationClosed: true, vehicleType: 'auto' }]
]);

assert.equal(effectiveRunGroupId(classes.get('a')), 'group-1');
assert.equal(effectiveRunGroupId(classes.get('c')), 'c');
assert.doesNotThrow(() => assertUniqueEffectiveRunGroups([
  { id: '1', driverPersonId: 'driver', classId: 'a', backupClassId: 'b', isBackupVehicle: false },
  { id: '2', driverPersonId: 'driver', classId: 'c', backupClassId: null, isBackupVehicle: false }
], classes));
assert.doesNotThrow(() => assertUniqueEffectiveRunGroups([
  { id: '1', driverPersonId: 'driver', classId: 'c', backupClassId: null, isBackupVehicle: false },
  { id: '2', driverPersonId: 'driver', classId: 'd', backupClassId: null, isBackupVehicle: false }
], classes), 'classes without run groups keep their previous independent behavior');
assert.throws(() => assertUniqueEffectiveRunGroups([
  { id: '1', driverPersonId: 'driver', classId: 'c', backupClassId: null, isBackupVehicle: false },
  { id: '2', driverPersonId: 'driver', classId: 'c', backupClassId: null, isBackupVehicle: false }
], classes), /RUN_GROUP_CONFLICT/);
assert.throws(() => assertUniqueEffectiveRunGroups([
  { id: '1', driverPersonId: 'driver', classId: 'a', backupClassId: null, isBackupVehicle: false },
  { id: '2', driverPersonId: 'driver', classId: 'b', backupClassId: null, isBackupVehicle: false }
], classes), /RUN_GROUP_CONFLICT/);
assert.doesNotThrow(() => assertUniqueEffectiveRunGroups([
  { id: '1', driverPersonId: 'driver', classId: 'a', backupClassId: null, isBackupVehicle: false },
  { id: '2', driverPersonId: 'driver', classId: 'b', backupClassId: null, isBackupVehicle: true }
], classes));
assert.doesNotThrow(() => assertBackupClassCompatible(classes.get('a'), classes.get('a'), { requireOpen: true, backupVehicleType: 'auto' }));
assert.doesNotThrow(() => assertBackupClassCompatible(classes.get('a'), classes.get('b'), { requireOpen: true, backupVehicleType: 'auto' }));
assert.throws(() => assertBackupClassCompatible(classes.get('a'), classes.get('c')), /BACKUP_CLASS_INVALID/);
assert.throws(() => assertBackupClassCompatible(classes.get('d'), classes.get('d'), { requireOpen: true }), /BACKUP_CLASS_CLOSED/);
assert.throws(() => assertBackupClassCompatible(classes.get('a'), classes.get('b'), { backupVehicleType: 'moto' }), /BACKUP_CLASS_VEHICLE_TYPE_MISMATCH/);
assert.deepEqual(reservedStartNumberClassIds('a', 'b'), ['a', 'b'], 'primary and backup class both reserve the entry start number');
assert.deepEqual(reservedStartNumberClassIds('a', 'a'), ['a']);

const reassignedClasses = new Map(classes);
reassignedClasses.set('b', { ...classes.get('b'), runGroupId: null });
assert.throws(() => assertUniqueEffectiveRunGroups([
  { id: '1', driverPersonId: 'driver', classId: 'a', backupClassId: 'b', isBackupVehicle: false }
], reassignedClasses), /BACKUP_CLASS_INVALID/, 'group reassignment is rejected when an active backup becomes incompatible');

const migration = fs.readFileSync(path.join(__dirname, '..', 'migrations', '0068_run_groups.sql'), 'utf8');
assert.match(migration, /backup_class_id[\s\S]*class_id/);
assert.match(migration, /set "backup_class_id" = "class_id"/);
assert.match(migration, /entry_backup_vehicle_class_consistency_check/);
assert.match(migration, /class_run_group_event_trigger/);
assert.match(migration, /entry_start_number_reservation_class_number_unique/);
assert.match(migration, /entry_run_group_reservation_driver_group_unique/);
assert.match(migration, /acceptance_status.*withdrawn/);

const openapi = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'openapi.json'), 'utf8'));
assert.ok(openapi.paths['/admin/events/{eventId}/run-groups']);
assert.ok(openapi.paths['/admin/run-groups/{id}']);
assert.ok(openapi.paths['/admin/entries/{id}/backup-class']);
assert.ok(openapi.components.schemas.PublicCreateEntryRequest.properties.backupClassId);
assert.ok(openapi.components.schemas.PublicEventClass.properties.selectionGroupKey);
assert.equal(openapi.components.schemas.PublicEventClass.properties.runGroupId, undefined);
assert.equal(JSON.stringify(openapi).includes('runGroupName'), false);

const publicSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'publicRegistration.ts'), 'utf8');
const adminSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'adminEntries.ts'), 'utf8');
const groupSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'adminRunGroups.ts'), 'utf8');
const handlerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'handler.ts'), 'utf8');
for (const source of [publicSource, adminSource, groupSource]) {
  assert.match(source, /assertUniqueEffectiveRunGroups|assertActiveDriverEntryRules/);
}
assert.match(publicSource, /entryStartNumberReservation/);
assert.match(adminSource, /assertStartNumberReservationsAvailable/);
assert.match(adminSource, /export const restoreEntry[\s\S]*assertActiveDriverEntryRules/);
assert.match(adminSource, /deletedAt.*is null[\s\S]*acceptanceStatus.*withdrawn/, 'soft-deleted and withdrawn entries do not occupy a group');
assert.match(handlerSource, /CLASS_COMBINATION_NOT_AVAILABLE/);
assert.doesNotMatch(
  JSON.stringify(openapi.components.schemas.PublicEventClass),
  /runGroup|Laufgruppe/,
  'public response contract does not expose the internal model'
);

console.log('run-groups tests passed');
