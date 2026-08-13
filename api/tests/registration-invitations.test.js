const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { validateCreateRegistrationInvitationInput } = require('../dist/routes/adminRegistrationInvitations');
const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
const classId = '10000000-0000-4000-8000-000000000001';
assert.equal(validateCreateRegistrationInvitationInput({ expiresAt: future, allowedClassIds: [classId] }).allowedClassIds[0], classId);
assert.throws(() => validateCreateRegistrationInvitationInput({
  expiresAt: new Date(Date.now() + 91 * 24 * 60 * 60 * 1000).toISOString(), allowedClassIds: [classId]
}), /90 days/);
assert.throws(() => validateCreateRegistrationInvitationInput({ expiresAt: future, allowedClassIds: [] }));
assert.throws(() => validateCreateRegistrationInvitationInput({ expiresAt: future, allowedClassIds: [classId, classId] }));

const migration = fs.readFileSync(path.join(__dirname, '..', 'migrations', '0069_registration_invitations.sql'), 'utf8');
assert.match(migration, /token_hash text not null/);
assert.doesNotMatch(migration, /\btoken\s+text\b/);
assert.match(migration, /allowed_class_ids uuid\[\] not null/);
assert.match(migration, /consumed_registration_group_id/);

const adminSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'adminRegistrationInvitations.ts'), 'utf8');
const publicSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'publicRegistration.ts'), 'utf8');
assert.match(adminSource, /randomBytes\(32\)\.toString\('base64url'\)/);
assert.match(adminSource, /tokenHash: hashToken\(token\)/);
assert.match(publicSource, /tx\.update\(registrationInvitation\)[\s\S]*consumedRegistrationGroupId/);
assert.match(publicSource, /registrationInvitation\.consumedAt} is null/);
assert.match(publicSource, /registration_invitation_consumed/);
assert.match(publicSource, /INVITATION_EMAIL_MISMATCH/);
assert.match(publicSource, /INVITATION_CLASS_NOT_ALLOWED/);
assert.match(publicSource, /requireOpen: !invitation/);

const openapi = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'openapi.json'), 'utf8'));
assert.ok(openapi.paths['/admin/events/{eventId}/registration-invitations']);
assert.ok(openapi.paths['/admin/registration-invitations/{id}/revoke']);
console.log('registration-invitations tests passed');
