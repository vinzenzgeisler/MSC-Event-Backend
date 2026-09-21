import { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { z, ZodError } from 'zod';
import { errorJson, json } from '../http/response';
import { getAuthContext, hasPermission } from '../http/auth';
import { parseJsonBody } from '../http/parse';
import { writeAuditLog } from '../audit/log';
import { getDb } from '../db/client';
import { errorCodeOf, logOperationalEvent } from '../observability/logger';
import { getPhotographerAuthContext, satisfiesStepUp } from './auth';
import { ensurePhotographerCognitoUser } from './cognito';
import { queuePhotographerInvitationMail } from './mail';
import {
  claimInvitation,
  createPhotographerInvitation,
  getConsumableInvitationByToken,
  getInvitationPreviewByToken,
  getPhotographerByCognitoSub,
  hashToken,
  listPhotographers,
  RacePicError,
  updatePhotographerProfile
} from './repository';

/**
 * RacePicApiHandler (Paket 1: Fundament, Paket 2: Identitaet). Eigenstaendiger Lambda-Handler fuer
 * den `/photographer/*`-, `/public/racepic/*`- und `/admin/racepic/*`-Namespace, registriert auf
 * derselben HttpApi wie der bestehende ApiHandler (siehe infra/lib/stacks/api-stack.ts und
 * docs/memory-bank/racepic-architecture.md Abschnitt B/E/H).
 *
 * Struktur und Response-Helfer folgen ../handler.ts. Upload (Paket 3), Review/KI (Paket 6/7) folgen.
 */

const isInvalidJson = (error: unknown): boolean => error instanceof Error && error.message === 'Invalid JSON body';

const maskEmail = (email: string): string => {
  const [local, domain] = email.split('@');
  if (!domain) {
    return '***';
  }
  const visible = local.slice(0, 1);
  return `${visible}${'*'.repeat(Math.max(local.length - 1, 1))}@${domain}`;
};

const invitationErrorStatus = (error: RacePicError): { status: number; message: string } => {
  switch (error.code) {
    case 'RACEPIC_INVITATION_ALREADY_CONSUMED':
      return { status: 409, message: 'Invitation already consumed' };
    case 'RACEPIC_INVITATION_EXPIRED':
      return { status: 410, message: 'Invitation expired' };
    case 'RACEPIC_PHOTOGRAPHER_ALREADY_CLAIMED':
      return { status: 409, message: 'Photographer profile already claimed' };
    case 'RACEPIC_EVENT_NOT_FOUND':
      return { status: 400, message: 'One or more eventIds do not exist' };
    default:
      return { status: 500, message: 'RacePic operation failed' };
  }
};

const invitePhotographerSchema = z.object({
  email: z.string().trim().email().max(320),
  displayName: z.string().trim().min(1).max(200),
  eventIds: z.array(z.string().uuid()).min(1).max(20)
});

const patchPhotographerProfileSchema = z.object({
  displayName: z.string().trim().min(1).max(200).optional(),
  legalName: z.string().trim().max(200).nullable().optional(),
  copyrightLine: z.string().trim().max(200).nullable().optional(),
  website: z.string().trim().url().max(500).nullable().optional(),
  social: z.record(z.string().trim().max(500)).optional(),
  avatarKey: z.string().trim().max(1000).nullable().optional(),
  defaultLicenseId: z.string().uuid().nullable().optional()
});

const claimInvitationSchema = z.object({
  token: z.string().trim().min(16).max(200),
  // Muss mit der beim Einladen freigegebenen Fassung der Fotografen-Nutzungsbedingungen
  // uebereinstimmen (docs/privacy/racepic-legal-texts-v1.md Abschnitt 2); die eigentliche
  // Versionspruefung folgt mit dem Onboarding-Screen (Website, Paket 2b).
  termsVersion: z.string().trim().min(1).max(50)
});

const photographerDto = (photographer: {
  id: string;
  email: string;
  displayName: string;
  legalName: string | null;
  copyrightLine: string | null;
  website: string | null;
  social: unknown;
  avatarKey: string | null;
  defaultLicenseId: string | null;
  status: string;
  termsAcceptedVersion: string | null;
}) => ({
  id: photographer.id,
  email: photographer.email,
  displayName: photographer.displayName,
  legalName: photographer.legalName,
  copyrightLine: photographer.copyrightLine,
  website: photographer.website,
  social: photographer.social,
  avatarKey: photographer.avatarKey,
  defaultLicenseId: photographer.defaultLicenseId,
  status: photographer.status,
  termsAcceptedVersion: photographer.termsAcceptedVersion
});

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> => {
  const method = event.requestContext.http.method;
  const path = event.requestContext.http.path;

  try {
    if (method === 'OPTIONS') {
      return json(200, { ok: true });
    }

    if (method === 'GET' && path === '/racepic/health') {
      return json(200, { ok: true, service: 'racepic-api', stage: process.env.STAGE ?? 'dev' });
    }

    // --- Admin: Fotografen einladen/auflisten (Abschnitt E) -----------------------------------
    if (method === 'GET' && path === '/admin/racepic/photographers') {
      const auth = getAuthContext(event);
      if (!auth.sub) return errorJson(401, 'Unauthorized');
      if (!hasPermission(auth, 'racepic.read')) return errorJson(403, 'Forbidden');
      const photographers = await listPhotographers();
      return json(200, { ok: true, photographers: photographers.map(photographerDto) });
    }

    if (method === 'POST' && path === '/admin/racepic/photographers') {
      const auth = getAuthContext(event);
      if (!auth.sub) return errorJson(401, 'Unauthorized');
      if (!hasPermission(auth, 'racepic.manage')) return errorJson(403, 'Forbidden');
      try {
        const input = invitePhotographerSchema.parse(parseJsonBody(event));
        const result = await createPhotographerInvitation({
          email: input.email,
          displayName: input.displayName,
          eventIds: input.eventIds,
          createdBy: auth.sub
        });

        await ensurePhotographerCognitoUser(input.email);

        const invitationUrl = `${process.env.RACEPIC_WEBSITE_BASE_URL ?? ''}/racepic/studio/einladung/${encodeURIComponent(result.token)}`;
        const db = await getDb();
        await queuePhotographerInvitationMail(db, {
          toEmail: input.email,
          photographerDisplayName: input.displayName,
          eventNames: result.eventNames,
          invitationUrl,
          invitationId: result.invitation.id
        });
        await writeAuditLog(db, {
          actorUserId: auth.sub,
          action: 'racepic_photographer_invited',
          entityType: 'racepic_photographer',
          entityId: result.photographer.id,
          payload: { photographerId: result.photographer.id, eventIds: input.eventIds, reinvited: result.photographer.status !== 'INVITED' }
        });

        return json(201, {
          ok: true,
          photographerId: result.photographer.id,
          invitationExpiresAt: result.invitation.expiresAt
        });
      } catch (error) {
        if (error instanceof ZodError) return errorJson(400, 'Validation failed', { issues: error.issues });
        if (isInvalidJson(error)) return errorJson(400, 'Invalid JSON body');
        if (error instanceof RacePicError) {
          const { status, message } = invitationErrorStatus(error);
          return errorJson(status, message, undefined, error.code);
        }
        throw error;
      }
    }

    if (method === 'GET' && path === '/admin/racepic/ping') {
      const auth = getAuthContext(event);
      if (!auth.sub) return errorJson(401, 'Unauthorized');
      if (!hasPermission(auth, 'racepic.read')) return errorJson(403, 'Forbidden');
      return json(200, { ok: true, service: 'racepic-admin-api' });
    }

    // --- Oeffentlich: Einladung ansehen/starten (kein Zugriff, nur E-Mail-OTP-Anstoss) ---------
    const invitationPreviewMatch = path.match(/^\/public\/racepic\/invitations\/([^/]+)$/);
    if (method === 'GET' && invitationPreviewMatch) {
      const token = decodeURIComponent(invitationPreviewMatch[1]);
      const preview = await getInvitationPreviewByToken(token);
      if (!preview) return errorJson(404, 'Invitation not found');
      return json(200, {
        ok: true,
        eventNames: preview.eventNames,
        maskedEmail: maskEmail(preview.invitation.email),
        expired: preview.invitation.expiresAt.getTime() < Date.now(),
        consumed: preview.invitation.consumedAt !== null
      });
    }

    const invitationStartMatch = path.match(/^\/public\/racepic\/invitations\/([^/]+)\/start$/);
    if (method === 'POST' && invitationStartMatch) {
      const token = decodeURIComponent(invitationStartMatch[1]);
      try {
        const invitation = await getConsumableInvitationByToken(token);
        if (!invitation) return errorJson(404, 'Invitation not found');
        await ensurePhotographerCognitoUser(invitation.email);
        // Die volle Adresse ist an dieser Stelle kein zusaetzliches Leck: Wer den unratbaren Token
        // besitzt, hat die Einladung bereits in genau diesem Postfach erhalten. Der Client braucht
        // sie als Cognito-USERNAME fuer InitiateAuth/RespondToAuthChallenge (Email-OTP), die
        // GET-Vorschau oben zeigt bewusst nur die maskierte Adresse.
        return json(200, { ok: true, email: invitation.email });
      } catch (error) {
        if (error instanceof RacePicError) {
          const { status, message } = invitationErrorStatus(error);
          return errorJson(status, message, undefined, error.code);
        }
        throw error;
      }
    }

    // --- Fotograf: Claiming und Profil ---------------------------------------------------------
    if (method === 'POST' && path === '/photographer/claim') {
      const auth = getPhotographerAuthContext(event);
      if (!auth.sub) return errorJson(401, 'Unauthorized');
      if (!satisfiesStepUp(auth, 'session')) return errorJson(401, 'Unauthorized');
      if (!auth.email || !auth.emailVerified) {
        return errorJson(403, 'Email must be verified before claiming an invitation', undefined, 'EMAIL_NOT_VERIFIED');
      }
      try {
        const input = claimInvitationSchema.parse(parseJsonBody(event));
        const preview = await getInvitationPreviewByToken(input.token);
        if (!preview) return errorJson(404, 'Invitation not found');
        if (preview.invitation.email.trim().toLowerCase() !== auth.email.trim().toLowerCase()) {
          // Verhindert, dass ein eingeloggter Fotograf die fuer eine andere Adresse ausgestellte
          // Einladung fuer sich beansprucht.
          return errorJson(403, 'Invitation email does not match the authenticated account', undefined, 'EMAIL_MISMATCH');
        }
        const photographer = await claimInvitation({ token: input.token, cognitoSub: auth.sub, termsVersion: input.termsVersion });
        const db = await getDb();
        await writeAuditLog(db, {
          actorUserId: auth.sub,
          action: 'racepic_photographer_claimed',
          entityType: 'racepic_photographer',
          entityId: photographer.id,
          payload: { photographerId: photographer.id }
        });
        return json(200, { ok: true, photographer: photographerDto(photographer) });
      } catch (error) {
        if (error instanceof ZodError) return errorJson(400, 'Validation failed', { issues: error.issues });
        if (isInvalidJson(error)) return errorJson(400, 'Invalid JSON body');
        if (error instanceof RacePicError) {
          const { status, message } = invitationErrorStatus(error);
          return errorJson(status, message, undefined, error.code);
        }
        throw error;
      }
    }

    if (method === 'GET' && path === '/photographer/me') {
      const auth = getPhotographerAuthContext(event);
      if (!auth.sub) return errorJson(401, 'Unauthorized');
      const photographer = await getPhotographerByCognitoSub(auth.sub);
      if (!photographer) {
        return errorJson(404, 'Photographer profile not found - claim an invitation first', undefined, 'PROFILE_NOT_CLAIMED');
      }
      return json(200, { ok: true, photographer: photographerDto(photographer) });
    }

    if (method === 'PATCH' && path === '/photographer/me') {
      const auth = getPhotographerAuthContext(event);
      if (!auth.sub) return errorJson(401, 'Unauthorized');
      // Alle Profilfelder hier sind unkritisch (Stufe "session"); E-Mail-Aenderung ist bewusst
      // nicht Teil dieses Endpunkts und braucht Stufe "recent" + Cognito-Attributaenderung
      // (siehe docs/memory-bank/racepic-architecture.md Abschnitt E), noch nicht implementiert.
      const photographer = await getPhotographerByCognitoSub(auth.sub);
      if (!photographer) {
        return errorJson(404, 'Photographer profile not found - claim an invitation first', undefined, 'PROFILE_NOT_CLAIMED');
      }
      try {
        const input = patchPhotographerProfileSchema.parse(parseJsonBody(event));
        const updated = await updatePhotographerProfile(photographer.id, input);
        if (!updated) return errorJson(404, 'Photographer profile not found');
        const db = await getDb();
        await writeAuditLog(db, {
          actorUserId: auth.sub,
          action: 'racepic_photographer_profile_updated',
          entityType: 'racepic_photographer',
          entityId: photographer.id,
          payload: { photographerId: photographer.id, fieldMask: Object.keys(input) }
        });
        return json(200, { ok: true, photographer: photographerDto(updated) });
      } catch (error) {
        if (error instanceof ZodError) return errorJson(400, 'Validation failed', { issues: error.issues });
        if (isInvalidJson(error)) return errorJson(400, 'Invalid JSON body');
        throw error;
      }
    }

    return errorJson(404, 'Not Found');
  } catch (error) {
    logOperationalEvent('error', 'racepic_api.unhandled_error', {
      requestId: event.requestContext.requestId,
      route: path,
      method,
      errorCode: errorCodeOf(error)
    });
    return errorJson(500, 'Unhandled RacePic API error', undefined, 'INTERNAL_ERROR');
  }
};
