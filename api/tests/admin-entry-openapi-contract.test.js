const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const openapi = JSON.parse(readFileSync(join(__dirname, '..', 'openapi.json'), 'utf8'));
const properties = openapi.components?.schemas?.AdminEntry?.properties ?? {};
const driverEmailPatch = openapi.paths?.['/admin/entries/{id}/driver-email']?.patch;
const statusPatch = openapi.paths?.['/admin/entries/{id}/status']?.patch;

for (const field of [
  'id',
  'eventId',
  'classId',
  'driverPersonId',
  'className',
  'registrationStatus',
  'acceptanceStatus',
  'withdrawnReason',
  'withdrawnAt',
  'withdrawnBy',
  'paymentStatus',
  'startNumberNorm',
  'orgaCode',
  'driverFirstName',
  'driverLastName',
  'driverEmail',
  'vehicleLabel',
  'confirmationMailSent',
  'confirmationMailVerified'
]) {
  assert.ok(field in properties, `AdminEntry.${field} must be documented`);
}

assert.ok(driverEmailPatch, 'PATCH /admin/entries/{id}/driver-email must be documented');
assert.equal(
  driverEmailPatch.requestBody.content['application/json'].schema.properties.email.format,
  'email'
);
assert.ok(driverEmailPatch.responses['409'], 'driver email conflict response must be documented');
assert.ok(statusPatch, 'PATCH /admin/entries/{id}/status must be documented');
assert.ok(
  statusPatch.requestBody.content['application/json'].schema.properties.acceptanceStatus.enum.includes('withdrawn'),
  'withdrawn must be documented as an acceptance status'
);
assert.ok(
  statusPatch.requestBody.content['application/json'].schema.properties.withdrawalReason,
  'withdrawalReason must be documented'
);

console.log('admin-entry-openapi-contract.test.js: ok');
