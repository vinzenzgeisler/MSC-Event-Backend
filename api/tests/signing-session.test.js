'use strict';
const assert = require('node:assert/strict');

const {
  validatePairingClaimInput,
  validateCreateSigningSessionInput,
  validateCompleteSigningSessionInput,
  extractSigningDeviceToken,
  normalizeWaiverMailRecipient,
  formatWaiverMailEventDates,
  formatWaiverMailSignedAt,
  signatureDataUrlToBuffer
} = require('../dist/routes/adminSigning');

// ── helpers ──────────────────────────────────────────────────────────────────
const uuid = () => '550e8400-e29b-41d4-a716-446655440000';
const pngDataUrl = () => `data:image/png;base64,${'A'.repeat(100)}`;
const validPngDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const throws = (fn, msgPattern) => {
  assert.throws(fn, (err) => {
    if (msgPattern && !err.message?.includes(msgPattern)) {
      throw new Error(`Expected error containing "${msgPattern}", got: ${err.message}`);
    }
    return true;
  });
};

// ── raw signature evidence validation ────────────────────────────────────────
{
  assert.equal(signatureDataUrlToBuffer(validPngDataUrl).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  throws(() => signatureDataUrlToBuffer(pngDataUrl()), 'SIGNATURE_INVALID');
  throws(() => signatureDataUrlToBuffer('data:image/jpeg;base64,AAAA'), 'SIGNATURE_INVALID');
}

// ── signed-waiver recipient hardening ────────────────────────────────────────
{
  assert.equal(normalizeWaiverMailRecipient(' Driver@Example.ORG '), 'driver@example.org');
  throws(() => normalizeWaiverMailRecipient('not-an-email'), 'WAIVER_MAIL_RECIPIENT_INVALID');
  throws(() => normalizeWaiverMailRecipient(''), 'WAIVER_MAIL_RECIPIENT_INVALID');
  assert.equal(formatWaiverMailEventDates('2026-09-07', '2026-09-08'), '07.09.2026 – 08.09.2026');
  assert.match(formatWaiverMailSignedAt('2026-09-07T14:30:00.000Z'), /^07\.09\.2026, 16:30$/);
}

// ── validatePairingClaimInput ─────────────────────────────────────────────────
{
  // valid
  assert.doesNotThrow(() => validatePairingClaimInput({ pairingCode: '123456' }));
  assert.doesNotThrow(() => validatePairingClaimInput({ pairingCode: '000000', deviceName: 'iPad' }));

  // pairingCode must be exactly 6 digits
  throws(() => validatePairingClaimInput({ pairingCode: '12345' }));   // too short
  throws(() => validatePairingClaimInput({ pairingCode: '1234567' })); // too long
  throws(() => validatePairingClaimInput({ pairingCode: 'ABCDEF' })); // non-digit
  throws(() => validatePairingClaimInput({ pairingCode: '' }));

  // deviceName max 80 chars
  assert.doesNotThrow(() =>
    validatePairingClaimInput({ pairingCode: '123456', deviceName: 'x'.repeat(80) })
  );
  throws(() =>
    validatePairingClaimInput({ pairingCode: '123456', deviceName: 'x'.repeat(81) })
  );
}

// ── validateCreateSigningSessionInput ────────────────────────────────────────
{
  const base = { deviceSessionId: uuid(), entryId: uuid() };

  // valid minimal
  assert.doesNotThrow(() => validateCreateSigningSessionInput(base));

  // valid with optional fields
  assert.doesNotThrow(() =>
    validateCreateSigningSessionInput({
      ...base,
      signerPersonId: uuid(),
      precheck: {
        identityChecked: true,
        signerPresent: true,
        medicalCertificateChecked: false,
        guardianPresent: false,
        guardianAuthorityChecked: false
      },
      precheckTimestamps: {
        identityCheckedAt: '2026-07-31T12:00:00.000Z',
        signerPresentAt: '2026-07-31T12:00:00.000Z',
        medicalCertificateCheckedAt: null,
        guardianPresentAt: null,
        guardianAuthorityCheckedAt: null
      },
      signer: { type: 'driver', guardianName: null, guardianRelationship: null }
    })
  );

  // guardian signer with data
  assert.doesNotThrow(() =>
    validateCreateSigningSessionInput({
      ...base,
      signer: { type: 'guardian', guardianName: 'Max Muster', guardianRelationship: 'Vater' }
    })
  );

  // missing required fields
  throws(() => validateCreateSigningSessionInput({ entryId: uuid() }));             // no deviceSessionId
  throws(() => validateCreateSigningSessionInput({ deviceSessionId: uuid() }));     // no entryId

  // invalid UUIDs
  throws(() => validateCreateSigningSessionInput({ ...base, deviceSessionId: 'not-a-uuid' }));
  throws(() => validateCreateSigningSessionInput({ ...base, entryId: 'not-a-uuid' }));
  throws(() => validateCreateSigningSessionInput({ ...base, signerPersonId: 'bad' }));

  // invalid signer type
  throws(() =>
    validateCreateSigningSessionInput({
      ...base,
      signer: { type: 'unknown', guardianName: null, guardianRelationship: null }
    })
  );
}

// ── validateCompleteSigningSessionInput ───────────────────────────────────────
{
  const valid = {
    displayedAt: '2026-07-31T12:00:00.000Z',
    waiverAcceptedAt: '2026-07-31T12:01:00.000Z',
    signedAt: '2026-07-31T12:02:00.000Z',
    signatureDataUrl: pngDataUrl()
  };

  assert.doesNotThrow(() => validateCompleteSigningSessionInput(valid));
  assert.equal(validateCompleteSigningSessionInput({ ...valid, guardianEmail: 'GUARDIAN@EXAMPLE.ORG' }).guardianEmail, 'guardian@example.org');
  throws(() => validateCompleteSigningSessionInput({ ...valid, guardianEmail: 'ungueltig' }));

  // missing fields
  throws(() => validateCompleteSigningSessionInput({ ...valid, displayedAt: undefined }));
  throws(() => validateCompleteSigningSessionInput({ ...valid, signedAt: undefined }));
  throws(() => validateCompleteSigningSessionInput({ ...valid, signatureDataUrl: undefined }));

  // invalid datetime
  throws(() => validateCompleteSigningSessionInput({ ...valid, displayedAt: '2026-07-31' }));

  // signatureDataUrl must start with data:image/png;base64,
  throws(() =>
    validateCompleteSigningSessionInput({
      ...valid,
      signatureDataUrl: 'data:image/jpeg;base64,/9j/abc'
    })
  );
  throws(() =>
    validateCompleteSigningSessionInput({ ...valid, signatureDataUrl: 'not-a-data-url' })
  );

  // signatureDataUrl max 2 MB (2_000_000 chars)
  throws(() =>
    validateCompleteSigningSessionInput({
      ...valid,
      signatureDataUrl: `data:image/png;base64,${'A'.repeat(2_000_001)}`
    })
  );
}

// ── extractSigningDeviceToken ─────────────────────────────────────────────────
{
  const extract = (headers) => extractSigningDeviceToken(headers);

  // present
  assert.equal(extract({ 'x-signing-device-token': 'tok123' }), 'tok123');
  // both lowercase and original-case header name are accepted
  assert.equal(extract({ 'X-Signing-Device-Token': 'tok456' }), 'tok456');
  assert.equal(extract({}), null);
  // Lambda always provides headers as object; null/undefined not a prod scenario
  assert.equal(extract({ 'other-header': 'value' }), null);
}

console.log('signing-session tests passed');
