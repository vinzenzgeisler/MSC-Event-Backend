const assert = require('node:assert/strict');
const { validateCreateParticipantTerminalSession, validateParticipantDraft, validateParticipantApproval } = require('../dist/routes/terminalWorkflows');

const deviceSessionId = '11111111-1111-4111-8111-111111111111';
const entryId = '22222222-2222-4222-8222-222222222222';
assert.equal(validateCreateParticipantTerminalSession({ workflowType: 'charity_codriver_registration', deviceSessionId, entryIds: [entryId] }).workflowType, 'charity_codriver_registration');

const draft = validateParticipantDraft({
  locale: 'pl-PL', firstName: 'Anna', lastName: 'Nowak', birthdate: '1990-02-03', country: 'PL',
  street: 'Rynek 1', zip: '50-101', city: 'Wrocław', email: 'ANNA@EXAMPLE.COM', phone: '+48 123 456 789',
  emergencyContactFirstName: 'Jan', emergencyContactLastName: 'Nowak', emergencyContactPhone: '+48 987 654 321', motorsportHistory: null
});
assert.equal(draft.email, 'anna@example.com');
assert.equal(draft.phone, '48123456789');
assert.throws(() => validateParticipantDraft({ ...draft, phone: '12' }));
assert.doesNotThrow(() => validateParticipantApproval({ identityCheckedAt: new Date().toISOString(), signerPresentAt: new Date().toISOString() }));
console.log('terminal-workflow contract tests passed');
