const assert = require('node:assert/strict');
const {
  getAuthContext,
  hasPermission,
  hasSupportRegistrationRead,
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

const viewer = getAuthContext(eventWithClaims({
  sub: 'user-id',
  'cognito:groups': '["viewer"]'
}));

assert.equal(hasSupportRegistrationRead(viewer), true);
assert.equal(hasPermission(viewer, 'entries.read'), true);

const unrelated = getAuthContext(eventWithClaims({ scope: 'openid profile' }));
assert.equal(hasSupportRegistrationRead(unrelated), false);

console.log('support auth tests passed');
