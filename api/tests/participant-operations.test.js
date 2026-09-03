'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const migration = read('migrations/0076_charity_revocation_and_signing_document_link.sql');
assert.match(migration, /add column if not exists "signing_session_id" uuid/);
assert.match(migration, /foreign key \("signing_session_id"\) references "signing_session"/);
assert.match(migration, /add column if not exists "revocation_reason" text/);
assert.match(migration, /"status" <> 'revoked'[\s\S]*revocation_reason/);

const entriesSource = read('src/routes/adminEntries.ts');
assert.match(entriesSource, /export const revokeCharityCodriver/);
assert.match(entriesSource, /eq\(entryCharityCodriver\.status, 'active'\)/);
assert.match(entriesSource, /action: 'charity_codriver_revoked'/);
assert.match(entriesSource, /waiverSigners:/);

const signingSource = read('src/routes/adminSigning.ts');
assert.match(signingSource, /export const resendSignedWaiverMail/);
assert.match(signingSource, /documentS3Key: row\.documentS3Key/);
assert.match(signingSource, /waiver_signed:manual:\$\{row\.sessionId\}:\$\{randomUUID\(\)\}/);
assert.match(signingSource, /action: 'waiver_signed_mail_resent'/);

const terminalSource = read('src/routes/terminalWorkflows.ts');
assert.match(terminalSource, /CHARITY_CODRIVER_ALREADY_ACTIVE/);
assert.match(terminalSource, /terminalSigner\.type === 'guardian'[\s\S]*draft\.guardianEmail/);

const exportSource = read('src/routes/adminExports.ts');
assert.match(exportSource, /participantRole: 'driver'/);
assert.match(exportSource, /participantRole: 'codriver'/);
assert.match(exportSource, /participantRole: 'charity_codriver'/);
assert.match(exportSource, /eq\(entryCharityCodriver\.status, 'active'\)/);

const apiStack = read('../infra/lib/stacks/api-stack.ts');
assert.match(apiStack, /path: '\/admin\/entries\/\{id\}\/charity-codrivers\/\{registrationId\}\/revoke'/);
assert.match(apiStack, /path: '\/admin\/documents\/\{id\}\/resend-waiver-mail'/);

const openapi = JSON.parse(read('openapi.json'));
assert.ok(openapi.paths['/admin/entries/{id}/charity-codrivers/{registrationId}/revoke']);
assert.ok(openapi.paths['/admin/documents/{id}/resend-waiver-mail']);

console.log('participant operations tests passed');
