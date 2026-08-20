const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const {
  assertAcceptanceTransitionAllowed,
  validateEntryStatusPatchInput
} = require('../dist/routes/adminEntries.js');

const statuses = ['pending', 'shortlist', 'accepted', 'rejected'];
for (const status of statuses) {
  assert.doesNotThrow(() => assertAcceptanceTransitionAllowed(status, 'withdrawn'));
  assert.doesNotThrow(() => assertAcceptanceTransitionAllowed('withdrawn', status));
}
assert.doesNotThrow(() => assertAcceptanceTransitionAllowed('rejected', 'accepted'));
assert.throws(() => assertAcceptanceTransitionAllowed('withdrawn', 'withdrawn'), /INVALID_STATUS_TRANSITION/);

assert.throws(
  () => validateEntryStatusPatchInput({ acceptanceStatus: 'withdrawn' }),
  /withdrawalReason is required/
);
assert.deepEqual(
  validateEntryStatusPatchInput({ acceptanceStatus: 'withdrawn', withdrawalReason: '  Fahrerabsage  ' }),
  {
    acceptanceStatus: 'withdrawn',
    withdrawalReason: 'Fahrerabsage',
    sendLifecycleMail: false,
    includeDriverNoteInLifecycleMail: false
  }
);

const migration = readFileSync(
  join(__dirname, '..', 'migrations', '0066_entry_withdrawn_status.sql'),
  'utf8'
);
assert.match(migration, /8c9ac8ec-a500-4e74-a296-f3fa540cc40b/);
assert.match(migration, /'absage'/);
assert.match(migration, /'fahrzeug wurde vom fahrer verkauft'/);
assert.match(migration, /withdrawn_reason = candidate\.delete_reason/);
assert.match(migration, /withdrawn_at = candidate\.deleted_at/);
assert.match(migration, /withdrawn_by = candidate\.deleted_by/);
assert.match(migration, /deleted_at = null/);
assert.match(migration, /acceptance_status.*<> 'withdrawn'/s);
assert.doesNotMatch(migration, /delete from "entry"/i);

const handlerSource = readFileSync(join(__dirname, '..', 'src', 'handler.ts'), 'utf8');
assert.match(handlerSource, /START_NUMBER_CONFLICT/);
assert.match(handlerSource, /historical start number has been reassigned/);

const financeSource = readFileSync(join(__dirname, '..', 'src', 'routes', 'adminFinance.ts'), 'utf8');
assert.match(financeSource, /acceptanceStatus !== 'withdrawn'/);

const adminMailSource = readFileSync(join(__dirname, '..', 'src', 'routes', 'adminMail.ts'), 'utf8');
assert.match(adminMailSource, /ne\(entry\.acceptanceStatus, 'withdrawn'\)/);
assert.match(adminMailSource, /entry_withdrawn/);

const emailWorkerSource = readFileSync(join(__dirname, '..', 'src', 'jobs', 'emailWorker.ts'), 'utf8');
assert.match(emailWorkerSource, /SUPPRESSED_ENTRY_WITHDRAWN/);
assert.match(emailWorkerSource, /acceptance_status <> 'withdrawn'/);
assert.match(emailWorkerSource, /await markSuppressed\(row\.id, suppressionReason\)/);

const adminEntriesSource = readFileSync(join(__dirname, '..', 'src', 'routes', 'adminEntries.ts'), 'utf8');
assert.match(adminEntriesSource, /SUPPRESSED_ENTRY_WITHDRAWN/);
assert.match(adminEntriesSource, /template_data->>'entryId'/);

console.log('entry-withdrawn-status.test.js: ok');
