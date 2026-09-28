import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse
} from '@simplewebauthn/server';
import type { Queryable } from '../commerce/offers';

/**
 * Step-up `strong` (Commerce AP05), siehe docs/memory-bank/racepic-architecture.md "Step-up-Authentication".
 *
 * Cognito-Tokens verraten nicht, mit welchem Faktor angemeldet wurde. Darum registriert das Backend Passkeys
 * selbst (WebAuthn, oeffentlicher Schluessel in `racepic_passkey_credential`) und stellt nach einer gueltigen
 * Assertion einen Grant aus: 5 Minuten gueltig, einmal verwendbar, gebunden an Fotograf, Aktion und Sitzung.
 * Challenges sind einmal verwendbar und werden vor der Pruefung verbraucht (kein Replay, kein Orakel).
 */

export type StepUpAction = 'PAYMENT_ACCOUNT' | 'IDENTITY_CHANGE';
export const STEP_UP_ACTIONS: readonly StepUpAction[] = ['PAYMENT_ACCOUNT', 'IDENTITY_CHANGE'];

export const STEP_UP_GRANT_TTL_SECONDS = 5 * 60;
export const WEBAUTHN_CHALLENGE_TTL_SECONDS = 5 * 60;

export type StepUpErrorCode =
  | 'PASSKEY_REQUIRED'
  | 'CHALLENGE_INVALID'
  | 'VERIFICATION_FAILED'
  | 'CREDENTIAL_UNKNOWN'
  | 'PASSKEY_NOT_FOUND'
  | 'PASSKEY_CONFIG_MISSING'
  | 'SESSION_UNKNOWN';

export class StepUpError extends Error {
  constructor(public readonly code: StepUpErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'StepUpError';
  }
}

export type PasskeyConfig = { rpID: string; rpName: string; origins: string[] };

export const getPasskeyConfig = (env: NodeJS.ProcessEnv = process.env): PasskeyConfig => {
  const rpID = (env.RACEPIC_PASSKEY_RP_ID ?? '').trim();
  const origins = (env.RACEPIC_PASSKEY_ORIGINS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  if (!rpID || origins.length === 0) throw new StepUpError('PASSKEY_CONFIG_MISSING');
  return { rpID, rpName: 'MSC RacePic', origins };
};

/** Austauschbar fuer Tests; Standard ist die WebAuthn-Bibliothek. */
export type WebAuthnDeps = {
  generateRegistrationOptions: typeof generateRegistrationOptions;
  verifyRegistrationResponse: typeof verifyRegistrationResponse;
  generateAuthenticationOptions: typeof generateAuthenticationOptions;
  verifyAuthenticationResponse: typeof verifyAuthenticationResponse;
};
export const defaultWebAuthnDeps: WebAuthnDeps = {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse
};

type CredentialRow = {
  id: string;
  photographer_id: string;
  credential_id: string;
  public_key: string;
  counter: string | number;
  transports: string[];
};

const activeCredentials = async (tx: Queryable, photographerId: string): Promise<CredentialRow[]> =>
  (await tx.query<CredentialRow>(
    'select id, photographer_id, credential_id, public_key, counter, transports from racepic_passkey_credential where photographer_id = $1 and revoked_at is null order by created_at',
    [photographerId]
  )).rows;

const storeChallenge = async (
  tx: Queryable,
  input: { photographerId: string; purpose: 'REGISTER' | 'STEP_UP'; action: StepUpAction | null; sessionRef: string; challenge: string }
) => {
  await tx.query(
    `insert into racepic_webauthn_challenge (photographer_id, purpose, action, session_ref, challenge, expires_at)
     values ($1, $2, $3, $4, $5, now() + ($6 * interval '1 second'))`,
    [input.photographerId, input.purpose, input.action, input.sessionRef, input.challenge, WEBAUTHN_CHALLENGE_TTL_SECONDS]
  );
};

/** Verbraucht die juengste offene Challenge atomar; ohne passende Challenge gibt es keine Pruefung. */
const consumeChallenge = async (
  tx: Queryable,
  input: { photographerId: string; purpose: 'REGISTER' | 'STEP_UP'; action: StepUpAction | null; sessionRef: string }
): Promise<string> => {
  const result = await tx.query<{ challenge: string }>(
    `update racepic_webauthn_challenge set consumed_at = now()
      where id = (
        select id from racepic_webauthn_challenge
         where photographer_id = $1 and purpose = $2 and session_ref = $3
           and action is not distinct from $4
           and consumed_at is null and expires_at > now()
         order by created_at desc limit 1)
        and consumed_at is null
      returning challenge`,
    [input.photographerId, input.purpose, input.sessionRef, input.action]
  );
  if (!result.rows[0]) throw new StepUpError('CHALLENGE_INVALID');
  return result.rows[0].challenge;
};

const toBase64Url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');
const fromBase64Url = (value: string): Uint8Array<ArrayBuffer> => new Uint8Array(Buffer.from(value, 'base64url'));

// --- Passkey-Registrierung ------------------------------------------------------------------------------

export const beginPasskeyRegistration = async (
  tx: Queryable,
  photographer: { id: string; email: string; displayName: string },
  sessionRef: string | null,
  config: PasskeyConfig,
  deps: WebAuthnDeps = defaultWebAuthnDeps
) => {
  if (!sessionRef) throw new StepUpError('SESSION_UNKNOWN');
  const existing = await activeCredentials(tx, photographer.id);
  const options = await deps.generateRegistrationOptions({
    rpName: config.rpName,
    rpID: config.rpID,
    userName: photographer.email,
    userDisplayName: photographer.displayName,
    userID: new TextEncoder().encode(photographer.id),
    attestationType: 'none',
    excludeCredentials: existing.map((credential) => ({ id: credential.credential_id, transports: credential.transports })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' }
  });
  await storeChallenge(tx, { photographerId: photographer.id, purpose: 'REGISTER', action: null, sessionRef, challenge: options.challenge });
  return options;
};

export const finishPasskeyRegistration = async (
  tx: Queryable,
  photographerId: string,
  sessionRef: string | null,
  response: Parameters<typeof verifyRegistrationResponse>[0]['response'],
  label: string | null,
  config: PasskeyConfig,
  deps: WebAuthnDeps = defaultWebAuthnDeps
): Promise<{ id: string }> => {
  if (!sessionRef) throw new StepUpError('SESSION_UNKNOWN');
  const challenge = await consumeChallenge(tx, { photographerId, purpose: 'REGISTER', action: null, sessionRef });
  let verification;
  try {
    verification = await deps.verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: config.origins,
      expectedRPID: config.rpID,
      requireUserVerification: true
    });
  } catch {
    throw new StepUpError('VERIFICATION_FAILED');
  }
  if (!verification.verified || !verification.registrationInfo) throw new StepUpError('VERIFICATION_FAILED');
  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  const inserted = await tx.query<{ id: string }>(
    `insert into racepic_passkey_credential
       (photographer_id, credential_id, public_key, counter, transports, device_type, backed_up, label)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (credential_id) do nothing
     returning id`,
    [photographerId, credential.id, toBase64Url(credential.publicKey), credential.counter, credential.transports ?? [], credentialDeviceType, credentialBackedUp, label]
  );
  // Dieselbe Credential-ID darf nie zwei Fotografen gehoeren (und nicht doppelt gespeichert werden).
  if (!inserted.rows[0]) throw new StepUpError('VERIFICATION_FAILED');
  return { id: inserted.rows[0].id };
};

export const listPasskeys = async (tx: Queryable, photographerId: string) =>
  (await tx.query<{ id: string; label: string | null; created_at: Date; last_used_at: Date | null; device_type: string | null; backed_up: boolean }>(
    `select id, label, created_at, last_used_at, device_type, backed_up
       from racepic_passkey_credential where photographer_id = $1 and revoked_at is null order by created_at`,
    [photographerId]
  )).rows.map((row) => ({
    id: row.id,
    label: row.label,
    createdAt: row.created_at.toISOString(),
    lastUsedAt: row.last_used_at ? row.last_used_at.toISOString() : null,
    deviceType: row.device_type,
    backedUp: row.backed_up
  }));

export const revokePasskey = async (tx: Queryable, photographerId: string, passkeyId: string): Promise<void> => {
  const result = await tx.query(
    `update racepic_passkey_credential set revoked_at = now()
      where id = $1 and photographer_id = $2 and revoked_at is null`,
    [passkeyId, photographerId]
  );
  if (!result.rowCount) throw new StepUpError('PASSKEY_NOT_FOUND');
  // Offene Grants dieses Passkeys verlieren ihre Gueltigkeit.
  await tx.query('update racepic_step_up_grant set consumed_at = now() where credential_id = $1 and consumed_at is null', [passkeyId]);
};

// --- Step-up ---------------------------------------------------------------------------------------------

export const beginStepUp = async (
  tx: Queryable,
  photographerId: string,
  sessionRef: string | null,
  action: StepUpAction,
  config: PasskeyConfig,
  deps: WebAuthnDeps = defaultWebAuthnDeps
) => {
  if (!sessionRef) throw new StepUpError('SESSION_UNKNOWN');
  const credentials = await activeCredentials(tx, photographerId);
  if (credentials.length === 0) throw new StepUpError('PASSKEY_REQUIRED');
  const options = await deps.generateAuthenticationOptions({
    rpID: config.rpID,
    userVerification: 'required',
    allowCredentials: credentials.map((credential) => ({ id: credential.credential_id, transports: credential.transports as never }))
  });
  await storeChallenge(tx, { photographerId, purpose: 'STEP_UP', action, sessionRef, challenge: options.challenge });
  return options;
};

export const finishStepUp = async (
  tx: Queryable,
  photographerId: string,
  sessionRef: string | null,
  action: StepUpAction,
  response: Parameters<typeof verifyAuthenticationResponse>[0]['response'],
  config: PasskeyConfig,
  deps: WebAuthnDeps = defaultWebAuthnDeps
): Promise<{ expiresAt: string }> => {
  if (!sessionRef) throw new StepUpError('SESSION_UNKNOWN');
  const challenge = await consumeChallenge(tx, { photographerId, purpose: 'STEP_UP', action, sessionRef });
  const credential = (await activeCredentials(tx, photographerId)).find((row) => row.credential_id === response.id);
  if (!credential) throw new StepUpError('CREDENTIAL_UNKNOWN');
  let verification;
  try {
    verification = await deps.verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: config.origins,
      expectedRPID: config.rpID,
      requireUserVerification: true,
      credential: {
        id: credential.credential_id,
        publicKey: fromBase64Url(credential.public_key),
        counter: Number(credential.counter),
        transports: credential.transports as never
      }
    });
  } catch {
    throw new StepUpError('VERIFICATION_FAILED');
  }
  if (!verification.verified) throw new StepUpError('VERIFICATION_FAILED');
  await tx.query('update racepic_passkey_credential set counter = $2, last_used_at = now() where id = $1', [
    credential.id,
    verification.authenticationInfo.newCounter
  ]);
  const grant = await tx.query<{ expires_at: Date }>(
    `insert into racepic_step_up_grant (photographer_id, action, session_ref, credential_id, expires_at)
     values ($1, $2, $3, $4, now() + ($5 * interval '1 second')) returning expires_at`,
    [photographerId, action, sessionRef, credential.id, STEP_UP_GRANT_TTL_SECONDS]
  );
  return { expiresAt: grant.rows[0].expires_at.toISOString() };
};

/**
 * Verbraucht einen gueltigen Grant fuer (Fotograf, Aktion, Sitzung). Wahr genau einmal pro Grant; wer keinen
 * frischen Passkey-Nachweis fuer diese Aktion in dieser Sitzung hat, bekommt `false`.
 */
export const consumeStepUpGrant = async (
  tx: Queryable,
  photographerId: string,
  action: StepUpAction,
  sessionRef: string | null
): Promise<boolean> => {
  if (!sessionRef) return false;
  const result = await tx.query(
    `update racepic_step_up_grant set consumed_at = now()
      where id = (
        select g.id from racepic_step_up_grant g
          join racepic_passkey_credential c on c.id = g.credential_id and c.revoked_at is null
         where g.photographer_id = $1 and g.action = $2 and g.session_ref = $3
           and g.consumed_at is null and g.expires_at > now()
         order by g.created_at desc limit 1)
        and consumed_at is null`,
    [photographerId, action, sessionRef]
  );
  return (result.rowCount ?? 0) === 1;
};
