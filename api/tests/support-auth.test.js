const assert = require('node:assert/strict');
const {
  getAuthContext,
  hasPermission,
  hasSupportRegistrationRead,
  hasSupportEntryDelete,
  MSC_SUPPORT_READ_SCOPE,
  MSC_SUPPORT_DELETE_SCOPE,
  MSC_SUPPORT_SCOPE_PREFIX
} = require('../dist/http/auth');

const eventWithClaims = (claims) => ({
  requestContext: {
    authorizer: {
      jwt: { claims }
    }
  }
});

// hasPermission now also checks msc-support scopes directly

// Machine client with read scope only
const machine = getAuthContext(eventWithClaims({
  client_id: 'machine-client',
  scope: `aws.cognito.signin.user.admin ${MSC_SUPPORT_READ_SCOPE}`
}));
assert.deepEqual(machine.groups, []);
assert.equal(hasPermission(machine, 'entries.read'), true,   'machine: entries.read via scope');
assert.equal(hasPermission(machine, 'entries.delete'), false, 'machine: entries.delete denied without scope');
assert.equal(hasPermission(machine, 'exports.read'), false,  'machine: exports.read denied without scope');
assert.equal(hasSupportRegistrationRead(machine), true);
assert.equal(hasSupportEntryDelete(machine), false);

// Machine client with all scopes
const allScopes = [
  'dashboard.read','entries.read','entries.status.write','entries.checkin.write',
  'entries.payment.write','entries.notes.write','entries.delete',
  'communication.read','communication.write','exports.read','exports.write',
  'settings.read','settings.write','iam.read','iam.write',
  'inspection.read','inspection.write'
].map((p) => `${MSC_SUPPORT_SCOPE_PREFIX}${p}`).join(' ');
const machineAdmin = getAuthContext(eventWithClaims({ client_id: 'machine', scope: allScopes }));
assert.deepEqual(machineAdmin.groups, []);
assert.equal(hasPermission(machineAdmin, 'entries.read'), true);
assert.equal(hasPermission(machineAdmin, 'entries.delete'), true);
assert.equal(hasPermission(machineAdmin, 'iam.write'), true);
assert.equal(hasPermission(machineAdmin, 'inspection.write'), true);
assert.equal(hasSupportRegistrationRead(machineAdmin), true);
assert.equal(hasSupportEntryDelete(machineAdmin), true);

// Machine client with only delete scope
const machineDeleteOnly = getAuthContext(eventWithClaims({
  client_id: 'machine-client',
  scope: MSC_SUPPORT_DELETE_SCOPE
}));
assert.equal(hasPermission(machineDeleteOnly, 'entries.read'), false);
assert.equal(hasPermission(machineDeleteOnly, 'entries.delete'), true);
assert.equal(hasSupportEntryDelete(machineDeleteOnly), true);

// Admin user: all permissions via group
const admin = getAuthContext(eventWithClaims({
  sub: 'admin-id',
  'cognito:groups': '["admin"]'
}));
assert.equal(hasPermission(admin, 'entries.read'), true);
assert.equal(hasPermission(admin, 'entries.delete'), true);
assert.equal(hasPermission(admin, 'iam.write'), true);
assert.equal(hasSupportRegistrationRead(admin), true);
assert.equal(hasSupportEntryDelete(admin), true);

// Viewer: limited permissions
const viewer = getAuthContext(eventWithClaims({
  sub: 'user-id',
  'cognito:groups': '["viewer"]'
}));
assert.equal(hasPermission(viewer, 'entries.read'), true);
assert.equal(hasPermission(viewer, 'entries.delete'), false);
assert.equal(hasSupportRegistrationRead(viewer), true);
assert.equal(hasSupportEntryDelete(viewer), false);

// Unrelated token: no access
const unrelated = getAuthContext(eventWithClaims({ scope: 'openid profile' }));
assert.equal(hasPermission(unrelated, 'entries.read'), false);
assert.equal(hasPermission(unrelated, 'entries.delete'), false);
assert.equal(hasSupportRegistrationRead(unrelated), false);
assert.equal(hasSupportEntryDelete(unrelated), false);

console.log('support auth tests passed');
