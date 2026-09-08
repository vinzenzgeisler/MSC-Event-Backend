const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  containsLegalName,
  replaceLegalNameInText,
  replaceProtectedLegalNamesInValue,
  sanitizeProtectedStructuredData,
  standardPersonIdentity
} = require('../dist/domain/personIdentity.js');
const { validatePublicationNamePatchInput } = require('../dist/routes/adminPersonIdentity.js');

const protectedPerson = { firstName: 'Max', lastName: 'Mustermann', publicationName: 'Der Blitz' };

assert.deepEqual(standardPersonIdentity(protectedPerson), {
  displayName: 'Der Blitz',
  identityProtected: true,
  firstName: null,
  lastName: null
});
assert.deepEqual(standardPersonIdentity({ firstName: 'Max', lastName: 'Mustermann', publicationName: null }), {
  displayName: 'Max Mustermann',
  identityProtected: false,
  firstName: 'Max',
  lastName: 'Mustermann'
});
assert.equal(containsLegalName('Start für MAX   MUSTERMANN', protectedPerson), true);
assert.equal(replaceLegalNameInText('Hallo Mustermann Max und Max   Mustermann', protectedPerson), 'Hallo Der Blitz und Der Blitz');
assert.deepEqual(
  sanitizeProtectedStructuredData({ driverName: 'Max Mustermann', firstName: 'Max', email: 'max@example.test', nested: 'Mustermann Max' }, protectedPerson),
  { driverName: 'Der Blitz', firstName: null, email: null, nested: 'Der Blitz' }
);
assert.deepEqual(
  replaceProtectedLegalNamesInValue({ note: 'Max Mustermann kommt später', nested: ['Mustermann Max'] }, [protectedPerson]),
  { note: 'Der Blitz kommt später', nested: ['Der Blitz'] }
);

assert.deepEqual(validatePublicationNamePatchInput({ publicationName: '  Der   Blitz  ' }), { publicationName: '  Der   Blitz  ' });
assert.throws(() => validatePublicationNamePatchInput({ publicationName: null }));
assert.throws(() => validatePublicationNamePatchInput({ publicationName: null, confirmLegalNameExposure: true, reason: 'kurz' }));
assert.deepEqual(
  validatePublicationNamePatchInput({ publicationName: null, confirmLegalNameExposure: true, reason: 'Auf Wunsch entfernt' }),
  { publicationName: null, confirmLegalNameExposure: true, reason: 'Auf Wunsch entfernt' }
);

const root = path.resolve(__dirname, '..');
const openApi = JSON.parse(fs.readFileSync(path.join(root, 'openapi.json'), 'utf8'));
assert.ok(openApi.paths['/admin/persons/{id}/publication-name'].patch);
assert.ok(openApi.components.schemas.AdminEntry.properties.displayName);
assert.ok(openApi.components.schemas.AdminEntry.properties.identityProtected);

const authSource = fs.readFileSync(path.join(root, 'src/http/auth.ts'), 'utf8');
assert.equal((authSource.match(/entries\.publication_name\.write/g) || []).length, 2, 'permission must be declared and assigned only once');

const migration = fs.readFileSync(path.join(root, 'migrations/0081_person_publication_name.sql'), 'utf8');
assert.match(migration, /publication_name/);
assert.match(migration, /export_job_person/);
assert.match(migration, /stamp_cards_pdf/);
assert.match(migration, /invalidated/);

console.log('person identity tests passed');
