const assert = require('node:assert/strict');
const { participantWorkflowContextOptions, validateCreateParticipantTerminalSession, validateParticipantDraft, validateParticipantApproval } = require('../dist/routes/terminalWorkflows');

const deviceSessionId = '11111111-1111-4111-8111-111111111111';
const entryId = '22222222-2222-4222-8222-222222222222';
assert.equal(validateCreateParticipantTerminalSession({ workflowType: 'charity_codriver_registration', deviceSessionId, entryIds: [entryId] }).workflowType, 'charity_codriver_registration');
assert.equal(validateCreateParticipantTerminalSession({ workflowType: 'regular_codriver_registration', deviceSessionId, entryIds: [entryId] }).operation, 'create');
assert.equal(validateCreateParticipantTerminalSession({ workflowType: 'regular_codriver_registration', operation: 'edit', participantPersonId: deviceSessionId, deviceSessionId, entryIds: [entryId] }).operation, 'edit');
assert.throws(() => validateCreateParticipantTerminalSession({ workflowType: 'regular_codriver_registration', operation: 'edit', deviceSessionId, entryIds: [entryId] }));
assert.throws(() => validateCreateParticipantTerminalSession({ workflowType: 'charity_codriver_registration', operation: 'edit', participantPersonId: deviceSessionId, deviceSessionId, entryIds: [entryId] }));
assert.deepEqual(participantWorkflowContextOptions('charity_codriver_registration'), { allowAfterTechnicalInspection: true, allowWithoutEntryEligibility: true });
assert.deepEqual(participantWorkflowContextOptions('regular_codriver_registration'), { allowAfterTechnicalInspection: false, allowWithoutEntryEligibility: false });

const draft = validateParticipantDraft({
  locale: 'pl-PL', firstName: 'Anna', lastName: 'Nowak', birthdate: '1990-02-03', country: 'PL',
  street: 'Rynek 1', zip: '50-101', city: 'Wrocław', email: 'ANNA@EXAMPLE.COM', phone: '+48 123 456 789',
  emergencyContactFirstName: 'Jan', emergencyContactLastName: 'Nowak', emergencyContactPhone: '+48 987 654 321', motorsportHistory: null
});
assert.equal(draft.email, 'anna@example.com');
assert.equal(draft.phone, '48123456789');
assert.throws(() => validateParticipantDraft({ ...draft, phone: '12' }));

const charityAdult = validateParticipantDraft({
  locale: 'de-DE', firstName: 'Erika', lastName: 'Muster', birthdate: '1990-02-03', country: 'DE',
  street: 'Hauptstraße 1', zip: '02763', city: 'Zittau'
}, 'charity_codriver_registration', '2026-09-12');
assert.equal(charityAdult.email, null);
assert.equal(charityAdult.guardianFullName, null);
assert.doesNotThrow(() => validateCreateParticipantTerminalSession({ workflowType: 'charity_codriver_registration', deviceSessionId, entryIds: [entryId], participantDraft: charityAdult }));
assert.throws(() => validateCreateParticipantTerminalSession({ workflowType: 'regular_codriver_registration', deviceSessionId, entryIds: [entryId], participantDraft: charityAdult }));

const charityMinorWithEmail = validateParticipantDraft({
  ...charityAdult, firstName: 'Mia', birthdate: '2010-02-03', guardianFullName: 'Erika Muster',
  guardianRelationship: 'Mutter', guardianEmail: 'ERIKA@EXAMPLE.COM'
}, 'charity_codriver_registration', '2026-09-12');
assert.equal(charityMinorWithEmail.guardianEmail, 'erika@example.com');
assert.equal(charityMinorWithEmail.guardianPhone, null);
assert.doesNotThrow(() => validateParticipantDraft({
  ...charityMinorWithEmail, guardianEmail: null, guardianPhone: '+49 171 1234567'
}, 'charity_codriver_registration', '2026-09-12'));
assert.throws(() => validateParticipantDraft({
  ...charityMinorWithEmail, guardianEmail: null, guardianPhone: null
}, 'charity_codriver_registration', '2026-09-12'), /GUARDIAN_CONTACT_REQUIRED/);
assert.throws(() => validateParticipantDraft(charityAdult, 'regular_codriver_registration', '2026-09-12'));
assert.doesNotThrow(() => validateParticipantApproval({ identityCheckedAt: new Date().toISOString(), signerPresentAt: new Date().toISOString() }));
console.log('terminal-workflow contract tests passed');
