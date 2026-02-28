const assert = require('node:assert/strict');
const { ZodError } = require('zod');
const {
  CognitoIdentityProviderClient,
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminListGroupsForUserCommand
} = require('@aws-sdk/client-cognito-identity-provider');

const { createIamUser, validateCreateIamUserInput } = require('../dist/routes/adminIam.js');

const originalSend = CognitoIdentityProviderClient.prototype.send;

const withMockedSend = async (mock, run) => {
  CognitoIdentityProviderClient.prototype.send = mock;
  try {
    await run();
  } finally {
    CognitoIdentityProviderClient.prototype.send = originalSend;
  }
};

const createNamedError = (name) => {
  const error = new Error(name);
  error.name = name;
  return error;
};

process.env.COGNITO_USER_POOL_ID = process.env.COGNITO_USER_POOL_ID || 'eu-central-1_testpool';

const run = async () => {
  // sendInvitation=false must require temporaryPassword.
  try {
    validateCreateIamUserInput({
      email: 'user@example.org',
      roles: ['viewer'],
      sendInvitation: false
    });
    assert.fail('expected validateCreateIamUserInput to throw');
  } catch (error) {
    assert.ok(error instanceof ZodError);
    const hasPasswordIssue = error.issues.some(
      (issue) => issue.path.join('.') === 'temporaryPassword' && issue.message.includes('required')
    );
    assert.equal(hasPasswordIssue, true);
  }

  // InvalidPasswordException must map to IAM_INVALID_TEMP_PASSWORD.
  await withMockedSend(async (command) => {
    if (command instanceof AdminCreateUserCommand) {
      throw createNamedError('InvalidPasswordException');
    }
    return {};
  }, async () => {
    await assert.rejects(
      () =>
        createIamUser({
          email: 'user@example.org',
          roles: ['viewer'],
          sendInvitation: true,
          temporaryPassword: 'short'
        }),
      (error) => error instanceof Error && error.message === 'IAM_INVALID_TEMP_PASSWORD'
    );
  });

  // CodeDeliveryFailureException must map to IAM_INVITATION_SEND_FAILED.
  await withMockedSend(async (command) => {
    if (command instanceof AdminCreateUserCommand) {
      throw createNamedError('CodeDeliveryFailureException');
    }
    return {};
  }, async () => {
    await assert.rejects(
      () =>
        createIamUser({
          email: 'user@example.org',
          roles: ['viewer'],
          sendInvitation: true
        }),
      (error) => error instanceof Error && error.message === 'IAM_INVITATION_SEND_FAILED'
    );
  });

  // Happy path: verify Cognito create payload for sendInvitation=false + returned DTO.
  const assignedGroups = [];
  await withMockedSend(async (command) => {
    if (command instanceof AdminCreateUserCommand) {
      assert.equal(command.input.MessageAction, 'SUPPRESS');
      assert.equal(command.input.DesiredDeliveryMediums, undefined);
      assert.equal(command.input.Username, 'new-admin@example.org');
      const emailVerifiedAttr = (command.input.UserAttributes || []).find((attr) => attr.Name === 'email_verified');
      assert.equal(emailVerifiedAttr?.Value, 'false');
      return {};
    }
    if (command instanceof AdminAddUserToGroupCommand) {
      assignedGroups.push(command.input.GroupName);
      return {};
    }
    if (command instanceof AdminGetUserCommand) {
      return {
        Username: command.input.Username,
        Enabled: true,
        UserStatus: 'FORCE_CHANGE_PASSWORD',
        UserCreateDate: new Date('2026-02-28T00:00:00.000Z'),
        UserLastModifiedDate: new Date('2026-02-28T00:00:00.000Z'),
        UserAttributes: [
          { Name: 'email', Value: 'new-admin@example.org' },
          { Name: 'email_verified', Value: 'false' }
        ]
      };
    }
    if (command instanceof AdminListGroupsForUserCommand) {
      return {
        Groups: assignedGroups.map((groupName) => ({ GroupName: groupName }))
      };
    }
    return {};
  }, async () => {
    const result = await createIamUser({
      email: 'NEW-ADMIN@EXAMPLE.ORG',
      roles: ['viewer', 'admin'],
      sendInvitation: false,
      temporaryPassword: 'TempPass123!'
    });
    assert.equal(result?.user?.email, 'new-admin@example.org');
    assert.equal(result?.user?.emailVerified, false);
    assert.deepEqual(result?.user?.roles.sort(), ['admin', 'viewer']);
  });

  console.log('admin-iam.test.js: ok');
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
