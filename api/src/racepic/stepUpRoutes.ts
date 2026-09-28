import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { z, ZodError } from 'zod';
import { getCommerceFlags } from '../commerce/flags';
import { writeAuditLog } from '../audit/log';
import { getDb, getPool } from '../db/client';
import { errorJson, json } from '../http/response';
import { parseJsonBody } from '../http/parse';
import { getPhotographerAuthContext, satisfiesStepUp } from './auth';
import {
  beginPasskeyRegistration,
  beginStepUp,
  finishPasskeyRegistration,
  finishStepUp,
  getPasskeyConfig,
  listPasskeys,
  revokePasskey,
  STEP_UP_ACTIONS,
  StepUpError,
  type StepUpErrorCode,
  type WebAuthnDeps,
  defaultWebAuthnDeps
} from './stepUp';

/**
 * Passkey-Verwaltung und Step-up `strong` fuer Fotograf:innen (Commerce AP05).
 *
 *   GET    /photographer/passkeys
 *   POST   /photographer/passkeys/registration-options   (Stufe `recent`)
 *   POST   /photographer/passkeys/registration-verify    (Stufe `recent`)
 *   DELETE /photographer/passkeys/{id}                   (Stufe `recent`)
 *   POST   /photographer/step-up/challenge               { action }
 *   POST   /photographer/step-up/verify                  { action, response }
 *
 * Alle Routen liegen hinter dem Flag `commerceSettlement` (Default aus, sonst 404): Passkeys werden nur fuer
 * Auszahlungsaktionen gebraucht.
 */

export type StepUpRouteDeps = {
  requireActivePhotographer: (
    event: APIGatewayProxyEventV2
  ) => Promise<
    | { ok: false; error: APIGatewayProxyStructuredResultV2 }
    | { ok: true; photographer: { id: string; email: string; displayName: string } }
  >;
  webAuthn?: WebAuthnDeps;
};

const stepUpErrorStatus = (code: StepUpErrorCode): { status: number; message: string } => {
  switch (code) {
    case 'PASSKEY_REQUIRED':
      return { status: 409, message: 'Register a passkey first' };
    case 'CHALLENGE_INVALID':
      return { status: 400, message: 'Challenge is missing, expired or already used; request a new one' };
    case 'VERIFICATION_FAILED':
      return { status: 401, message: 'Passkey verification failed' };
    case 'CREDENTIAL_UNKNOWN':
      return { status: 400, message: 'Unknown passkey' };
    case 'PASSKEY_NOT_FOUND':
      return { status: 404, message: 'Passkey not found' };
    case 'PASSKEY_CONFIG_MISSING':
      return { status: 503, message: 'Passkeys are not configured' };
    case 'SESSION_UNKNOWN':
      return { status: 401, message: 'Session cannot be identified; sign in again' };
  }
};

const actionSchema = z.enum(STEP_UP_ACTIONS as [string, ...string[]]);
// Die WebAuthn-Antwort wird von @simplewebauthn/server im Detail geprueft; hier nur die Grundform.
const webauthnResponseSchema = z.object({ id: z.string().min(1), rawId: z.string().min(1), type: z.literal('public-key'), response: z.object({}).passthrough() }).passthrough();
const registrationVerifySchema = z.object({ response: webauthnResponseSchema, label: z.string().trim().max(80).optional() });
const challengeSchema = z.object({ action: actionSchema });
const verifySchema = z.object({ action: actionSchema, response: webauthnResponseSchema });

export const handlePasskeyRoutes = async (
  event: APIGatewayProxyEventV2,
  deps: StepUpRouteDeps
): Promise<APIGatewayProxyStructuredResultV2 | null> => {
  const method = event.requestContext.http.method;
  const path = event.requestContext.http.path;
  const isRoute = /^\/photographer\/(passkeys(\/[^/]+)?|passkeys\/registration-(options|verify)|step-up\/(challenge|verify))$/.test(path);
  if (!isRoute) return null;
  if (!getCommerceFlags().commerceSettlement) return errorJson(404, 'Not Found', undefined, 'COMMERCE_DISABLED');

  try {
    const result = await deps.requireActivePhotographer(event);
    if (!result.ok) return result.error;
    const photographer = result.photographer;
    const auth = getPhotographerAuthContext(event);
    const webAuthn = deps.webAuthn ?? defaultWebAuthnDeps;
    const requireRecent = () =>
      satisfiesStepUp(auth, 'recent') ? null : errorJson(403, 'Recent sign-in required', undefined, 'STEP_UP_REQUIRED', undefined, undefined);

    if (method === 'GET' && path === '/photographer/passkeys') {
      const pool = await getPool();
      return json(200, { ok: true, passkeys: await listPasskeys(pool, photographer.id) });
    }

    if (method === 'POST' && path === '/photographer/passkeys/registration-options') {
      const denied = requireRecent();
      if (denied) return denied;
      const pool = await getPool();
      const options = await beginPasskeyRegistration(pool, photographer, auth.sessionRef, getPasskeyConfig(), webAuthn);
      return json(200, { ok: true, options });
    }

    if (method === 'POST' && path === '/photographer/passkeys/registration-verify') {
      const denied = requireRecent();
      if (denied) return denied;
      const input = registrationVerifySchema.parse(parseJsonBody(event));
      const pool = await getPool();
      const created = await finishPasskeyRegistration(
        pool, photographer.id, auth.sessionRef, input.response as never, input.label ?? null, getPasskeyConfig(), webAuthn
      );
      await writeAuditLog(await getDb(), {
        actorUserId: `photographer:${photographer.id}`, action: 'racepic_passkey_registered', entityType: 'racepic_photographer', entityId: photographer.id, payload: {}
      });
      return json(201, { ok: true, passkey: created });
    }

    const removeMatch = path.match(/^\/photographer\/passkeys\/([0-9a-fA-F-]{36})$/);
    if (method === 'DELETE' && removeMatch) {
      const denied = requireRecent();
      if (denied) return denied;
      const pool = await getPool();
      await revokePasskey(pool, photographer.id, removeMatch[1]);
      await writeAuditLog(await getDb(), {
        actorUserId: `photographer:${photographer.id}`, action: 'racepic_passkey_revoked', entityType: 'racepic_photographer', entityId: photographer.id, payload: {}
      });
      return json(200, { ok: true });
    }

    if (method === 'POST' && path === '/photographer/step-up/challenge') {
      const input = challengeSchema.parse(parseJsonBody(event));
      const pool = await getPool();
      const options = await beginStepUp(pool, photographer.id, auth.sessionRef, input.action as never, getPasskeyConfig(), webAuthn);
      return json(200, { ok: true, options });
    }

    if (method === 'POST' && path === '/photographer/step-up/verify') {
      const input = verifySchema.parse(parseJsonBody(event));
      const pool = await getPool();
      const grant = await finishStepUp(pool, photographer.id, auth.sessionRef, input.action as never, input.response as never, getPasskeyConfig(), webAuthn);
      await writeAuditLog(await getDb(), {
        actorUserId: `photographer:${photographer.id}`, action: 'racepic_step_up_granted', entityType: 'racepic_photographer', entityId: photographer.id, payload: { action: input.action }
      });
      return json(200, { ok: true, expiresAt: grant.expiresAt });
    }

    return errorJson(405, 'Method Not Allowed');
  } catch (error) {
    if (error instanceof ZodError) return errorJson(400, 'Validation failed', { issues: error.issues });
    if (error instanceof Error && error.message === 'Invalid JSON body') return errorJson(400, 'Invalid JSON body');
    if (error instanceof StepUpError) {
      const { status, message } = stepUpErrorStatus(error.code);
      return errorJson(status, message, undefined, error.code);
    }
    throw error;
  }
};
