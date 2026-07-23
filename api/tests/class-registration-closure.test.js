const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { assertClassRegistrationOpen } = require('../dist/domain/classRegistration');
const { validateClassInput, validateClassUpdateInput } = require('../dist/routes/adminClasses');

assert.doesNotThrow(() => assertClassRegistrationOpen(false));
assert.throws(() => assertClassRegistrationOpen(true), /CLASS_REGISTRATION_CLOSED/);

assert.equal(
  validateClassInput({ name: 'Klasse 1', vehicleType: 'moto' }).registrationClosed,
  false
);
assert.equal(validateClassUpdateInput({ registrationClosed: true }).registrationClosed, true);

const migration = fs.readFileSync(
  path.resolve(__dirname, '../migrations/0057_class_registration_closed.sql'),
  'utf8'
);
assert.match(migration, /registration_closed/);
assert.match(migration, /not null default false/);

const publicRegistrationSource = fs.readFileSync(
  path.resolve(__dirname, '../src/routes/publicRegistration.ts'),
  'utf8'
);
assert.match(publicRegistrationSource, /assertClassRegistrationOpen\(clazz\.registrationClosed\)/);
assert.match(publicRegistrationSource, /registrationClosed: eventClass\.registrationClosed/);

console.log('class registration closure tests passed');
