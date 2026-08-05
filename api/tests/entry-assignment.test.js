const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const {
  buildAssignmentMailBody,
  buildEntryAssignmentIdempotencyKey,
  validateEntryAssignmentPatchInput
} = require('../dist/routes/adminEntries.js');
const { handler } = require('../dist/handler.js');

const classId = '10000000-0000-4000-8000-000000000001';
const entryId = '20000000-0000-4000-8000-000000000002';

const normalized = validateEntryAssignmentPatchInput({
  classId,
  startNumber: 'a7',
  sendSystemMail: true
});
assert.deepEqual(normalized, {
  classId,
  startNumber: 'A7',
  applyToBackupVehicle: false,
  allowVehicleTypeChange: true,
  sendSystemMail: true,
  requestCodriverData: false
});
assert.throws(() => validateEntryAssignmentPatchInput({ classId, startNumber: 'A-7', sendSystemMail: true }));
assert.throws(() => validateEntryAssignmentPatchInput({ classId, startNumber: '1234567', sendSystemMail: true }));
assert.throws(() => validateEntryAssignmentPatchInput({ classId, startNumber: '7', sendSystemMail: false }));

const standardMail = buildAssignmentMailBody(false);
assert.match(standardMail.text, /Neue Klasse: \{\{className\}\}/);
assert.match(standardMail.text, /Neue Startnummer: \{\{startNumber\}\}/);
assert.doesNotMatch(standardMail.text, /Geburtsdatum/);

const codriverMail = buildAssignmentMailBody(true);
for (const field of [
  'Vorname', 'Nachname', 'Geburtsdatum', 'Land', 'Straße', 'PLZ', 'Ort', 'E-Mail-Adresse', 'Telefonnummer'
]) {
  assert.match(codriverMail.text, new RegExp(field), `co-driver mail must request ${field}`);
  assert.match(codriverMail.html, new RegExp(field), `HTML co-driver mail must request ${field}`);
}

const firstKey = buildEntryAssignmentIdempotencyKey(entryId, classId, 'A7', true);
assert.equal(firstKey, buildEntryAssignmentIdempotencyKey(entryId, classId, 'A7', true));
assert.notEqual(firstKey, buildEntryAssignmentIdempotencyKey(entryId, classId, 'A7', false));
assert.notEqual(firstKey, buildEntryAssignmentIdempotencyKey(entryId, classId, 'A7', true, true));
assert.notEqual(firstKey, buildEntryAssignmentIdempotencyKey(entryId, classId, 'A7', true, false, false));

const source = readFileSync(join(__dirname, '..', 'src', 'routes', 'adminEntries.ts'), 'utf8');
assert.match(source, /return db\.transaction\(async \(tx\) => \{/);
assert.match(source, /classId: input\.classId,\s*startNumberNorm: sql`case/);
assert.match(source, /action: 'entry_assignment_updated'/);
assert.match(source, /previousClassId: existing\.classId/);
assert.match(source, /previousStartNumber: existing\.startNumberNorm/);
assert.match(source, /toEmail: existing\.driverEmail/);
assert.match(source, /\.insert\(emailOutbox\)/);
assert.match(source, /if \(duplicateRows\[0\]\)/);
assert.match(source, /throw new Error\('START_NUMBER_CONFLICT'\)/);
assert.match(source, /throw new Error\('CODRIVER_NOT_ALLOWED'\)/);
assert.match(source, /throw new Error\('CODRIVER_ALREADY_ASSIGNED'\)/);
assert.match(source, /recalculateInvoicesInTransaction\(tx/);

const openapi = JSON.parse(readFileSync(join(__dirname, '..', 'openapi.json'), 'utf8'));
assert.ok(openapi.paths['/admin/entries/{id}/assignment']?.patch);
assert.equal(openapi.components.schemas.EntryAssignmentPatchRequest.properties.sendSystemMail.const, true);

const forbiddenEvent = (scope) => ({
  version: '2.0',
  routeKey: 'PATCH /admin/entries/{id}/assignment',
  rawPath: `/admin/entries/${entryId}/assignment`,
  rawQueryString: '',
  headers: {},
  requestContext: {
    authorizer: { jwt: { claims: { sub: 'test-user', scope } } },
    http: { method: 'PATCH', path: `/admin/entries/${entryId}/assignment` }
  },
  body: JSON.stringify({ classId, startNumber: 'A7', sendSystemMail: true }),
  isBase64Encoded: false
});

(async () => {
  for (const scope of ['msc-support/entries.status.write', 'msc-support/communication.write', '']) {
    const response = await handler(forbiddenEvent(scope));
    assert.equal(response.statusCode, 403, `both permissions are required for scope '${scope}'`);
    assert.equal(JSON.parse(response.body).code, 'FORBIDDEN');
  }
  console.log('entry-assignment.test.js: ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
