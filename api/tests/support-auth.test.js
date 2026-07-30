const assert = require('node:assert/strict');
const {
  getAuthContext,
  hasAutomationPermission,
  hasPermission,
  hasPermissionOrAutomation,
  hasSupportRegistrationRead,
  automationScopeForPermission,
  permissionFromAutomationScope,
  getAutomationApprovalContext,
  MSC_SUPPORT_READ_SCOPE
} = require('../dist/http/auth');

const eventWithClaims = (claims) => ({
  requestContext: {
    authorizer: {
      jwt: { claims }
    }
  }
});

const machine = getAuthContext(eventWithClaims({
  client_id: 'machine-client',
  scope: `aws.cognito.signin.user.admin ${MSC_SUPPORT_READ_SCOPE}`
}));

assert.deepEqual(machine.groups, []);
assert.equal(hasSupportRegistrationRead(machine), true);
assert.equal(hasPermission(machine, 'entries.read'), false);
assert.equal(hasPermission(machine, 'entries.payment.write'), false);
assert.equal(hasPermission(machine, 'exports.read'), false);
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

const viewer = getAuthContext(eventWithClaims({
  sub: 'user-id',
  'cognito:groups': '["viewer"]'
}));

assert.equal(hasSupportRegistrationRead(viewer), true);
assert.equal(hasPermission(viewer, 'entries.read'), true);

const unrelated = getAuthContext(eventWithClaims({ scope: 'openid profile' }));
assert.equal(hasSupportRegistrationRead(unrelated), false);

console.log('support auth tests passed');
