const assert = require('node:assert/strict');
const { validateCompleteCodriverInvitation, validateCreateCodriverInvitation } = require('../dist/routes/codriverInvitations');

const entryId = '22222222-2222-4222-8222-222222222222';
const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60_000).toISOString();
assert.deepEqual(validateCreateCodriverInvitation({ entryIds: [entryId], recipientEmail: 'codriver@example.com', expiresAt }), {
  entryIds: [entryId], recipientEmail: 'codriver@example.com', expiresAt
});
assert.throws(() => validateCreateCodriverInvitation({ entryIds: [entryId, entryId], expiresAt }));

const participant = {
  locale: 'de-DE', firstName: 'Eva', lastName: 'Beispiel', birthdate: '1990-02-03', country: 'DE',
  street: 'Hauptstraße 1', zip: '12345', city: 'Beispielstadt', email: 'EVA@EXAMPLE.COM', phone: '+49 123 456789',
  emergencyContactFirstName: 'Max', emergencyContactLastName: 'Beispiel', emergencyContactPhone: '+49 987 654321'
};
const completed = validateCompleteCodriverInvitation({ participant, privacyAccepted: true });
assert.equal(completed.participant.email, 'eva@example.com');
assert.equal(completed.privacyAccepted, true);
assert.throws(() => validateCompleteCodriverInvitation({ participant, privacyAccepted: false }));
console.log('codriver-invitation contract tests passed');
