const assert = require('node:assert/strict');
const {
  canReadEventClassOptions,
  getAuthContext,
  hasAutomationPermission,
  hasPermission,
  hasPermissionOrAutomation,
  hasSupportRegistrationRead,
  hasSupportEntryDelete,
  automationScopeForPermission,
  permissionFromAutomationScope,
  getAutomationApprovalContext,
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
assert.equal(hasAutomationPermission(machine, 'entries.read'), false);

const automation = getAuthContext(eventWithClaims({
  client_id: 'automation-client',
  scope: [
    automationScopeForPermission('entries.read'),
    automationScopeForPermission('entries.payment.write')
  ].join(' ')
}));

assert.equal(hasPermission(automation, 'entries.read'), false);
assert.equal(hasAutomationPermission(automation, 'entries.read'), true);
assert.equal(hasAutomationPermission(automation, 'entries.payment.write'), true);
assert.equal(hasAutomationPermission(automation, 'iam.write'), false);
assert.equal(hasPermissionOrAutomation(automation, 'entries.read'), true);
assert.equal(hasPermissionOrAutomation(automation, 'entries.payment.read'), false);
assert.equal(hasPermissionOrAutomation(automation, 'entries.payment.write'), false);

const approvedEvent = eventWithClaims({
  client_id: 'automation-client',
  scope: automationScopeForPermission('entries.payment.write')
});
const approvedAt = new Date().toISOString();
approvedEvent.headers = {
  'x-msc-approval-action-id': '10000000-0000-4000-8000-000000000001',
  'x-msc-approval-payload-sha256': 'a'.repeat(64),
  'x-msc-approval-approved-at': approvedAt,
  'idempotency-key': '10000000-0000-4000-8000-000000000001'
};
const approvedAutomation = getAuthContext(approvedEvent);
assert.deepEqual(
  getAutomationApprovalContext(approvedEvent),
  {
    actionId: '10000000-0000-4000-8000-000000000001',
    payloadHash: 'a'.repeat(64),
    approvedAt
  }
);
assert.equal(
  hasPermission(approvedAutomation, 'entries.payment.write'),
  true
);
assert.equal(
  hasPermission(approvedAutomation, 'entries.read'),
  false,
  'write approval cannot upgrade a read permission'
);
assert.equal(
  approvedAutomation.sub,
  'automation:10000000-0000-4000-8000-000000000001',
  'audit identity is bound to the approved action rather than a machine client'
);
const staleEvent = structuredClone(approvedEvent);
staleEvent.headers['x-msc-approval-approved-at'] =
  new Date(Date.now() - 21 * 60_000).toISOString();
assert.equal(getAutomationApprovalContext(staleEvent), null);
assert.equal(
  hasPermission(getAuthContext(staleEvent), 'entries.payment.write'),
  false
);
const mismatchedIdempotencyEvent = structuredClone(approvedEvent);
mismatchedIdempotencyEvent.headers['idempotency-key'] =
  '10000000-0000-4000-8000-000000000002';
assert.equal(getAutomationApprovalContext(mismatchedIdempotencyEvent), null);
assert.equal(
  hasPermission(
    getAuthContext(mismatchedIdempotencyEvent),
    'entries.payment.write'
  ),
  false
);
assert.equal(permissionFromAutomationScope('msc-automation/entries.read'), 'entries.read');
assert.equal(permissionFromAutomationScope('msc-automation/not-a-permission'), null);
assert.equal(permissionFromAutomationScope('openid'), null);

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

// Event class options are settings metadata used by the entries class filter.
const editor = getAuthContext(eventWithClaims({
  sub: 'editor-id',
  'cognito:groups': '["editor"]'
}));
assert.equal(canReadEventClassOptions(editor), true, 'editor can populate the entries class filter');
assert.equal(hasPermission(editor, 'settings.read'), false, 'editor gains no settings permission');
assert.equal(canReadEventClassOptions(admin), true, 'settings reader remains authorized');

const classFilterViewer = getAuthContext(eventWithClaims({
  sub: 'class-filter-viewer-id',
  'cognito:groups': '["viewer"]'
}));
assert.equal(canReadEventClassOptions(classFilterViewer), true, 'viewer can populate the entries class filter');
assert.equal(hasPermission(classFilterViewer, 'settings.read'), false, 'viewer gains no settings permission');
assert.equal(hasPermission(classFilterViewer, 'settings.write'), false, 'viewer gains no settings write permission');

const settingsReader = getAuthContext(eventWithClaims({
  client_id: 'settings-reader',
  scope: `${MSC_SUPPORT_SCOPE_PREFIX}settings.read`
}));
assert.equal(canReadEventClassOptions(settingsReader), true, 'settings-only reader remains authorized');
assert.equal(hasPermission(settingsReader, 'entries.read'), false);

const unrelatedRole = getAuthContext(eventWithClaims({
  sub: 'inspector-id',
  'cognito:groups': '["technical_inspector"]'
}));
assert.equal(canReadEventClassOptions(unrelatedRole), false, 'unrelated role remains denied');
assert.equal(
  canReadEventClassOptions(getAuthContext(eventWithClaims({}))),
  false,
  'anonymous caller remains denied'
);

const classOptionsAutomation = getAuthContext(eventWithClaims({
  client_id: 'automation-client',
  scope: automationScopeForPermission('settings.read')
}));
assert.equal(canReadEventClassOptions(classOptionsAutomation), true, 'existing read automation remains authorized');

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
