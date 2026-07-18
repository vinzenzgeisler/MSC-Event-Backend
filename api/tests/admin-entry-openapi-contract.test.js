const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const openapi = JSON.parse(readFileSync(join(__dirname, '..', 'openapi.json'), 'utf8'));
const properties = openapi.components?.schemas?.AdminEntry?.properties ?? {};

for (const field of [
  'id',
  'eventId',
  'classId',
  'driverPersonId',
  'className',
  'registrationStatus',
  'acceptanceStatus',
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

console.log('admin-entry-openapi-contract.test.js: ok');
