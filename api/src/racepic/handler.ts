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
  listActiveLicenses,
  listMyEventAccess,
  listPhotographers,
  RacePicError,
  updatePhotographerProfile
} from './repository';
import {
  abortUpload,
  completeUpload,
  createBatch,
  createUpload,
  getBatchForPhotographer,
  getUploadForPhotographer,
  listMyImages,
  listPartsForResume,
  presignRemainingParts
} from './uploads';
import { sendAnalyzeMessage, sendIngestMessage, sendMatchMessage } from './queues';
import { getImageEventId, hideImage, publishImage, regenerateManifestsForEvent, removeImage } from './publish';
import { getEventStats, listEventsWithRacepicConfig, listPhotographersWithEventAccess, upsertRacepicEventConfig } from './adminEvents';
import { createMatchingConfig, listMatchingConfigs } from './matchingConfig';
import { racepicImage } from '../db/schema';
import { and, eq, inArray } from 'drizzle-orm';

/**
 * RacePicApiHandler (Paket 1: Fundament, Paket 2: Identitaet, Paket 3: Upload). Eigenstaendiger
 * Lambda-Handler fuer den `/photographer/*`-, `/public/racepic/*`- und `/admin/racepic/*`-
 * Namespace, registriert auf derselben HttpApi wie der bestehende ApiHandler (siehe
 * infra/lib/stacks/api-stack.ts und docs/memory-bank/racepic-architecture.md Abschnitt B/D/E/H).
 *
 * Struktur und Response-Helfer folgen ../handler.ts. Review/KI (Paket 6/7) folgen.
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

const racePicErrorStatus = (error: RacePicError): { status: number; message: string } => {
  switch (error.code) {
    case 'RACEPIC_INVITATION_ALREADY_CONSUMED':
      return { status: 409, message: 'Invitation already consumed' };
    case 'RACEPIC_INVITATION_EXPIRED':
      return { status: 410, message: 'Invitation expired' };
    case 'RACEPIC_PHOTOGRAPHER_ALREADY_CLAIMED':
      return { status: 409, message: 'Photographer profile already claimed' };
    case 'RACEPIC_EVENT_NOT_FOUND':
      return { status: 400, message: 'One or more eventIds do not exist' };
    case 'RACEPIC_EVENT_ACCESS_DENIED':
      return { status: 403, message: 'No upload access granted for this event' };
    case 'RACEPIC_UPLOAD_WINDOW_NOT_OPEN':
      return { status: 403, message: 'Upload window is not open yet' };
    case 'RACEPIC_UPLOAD_WINDOW_CLOSED':
      return { status: 403, message: 'Upload window is closed' };
    case 'RACEPIC_LICENSE_NOT_FOUND':
      return { status: 400, message: 'License not found or inactive' };
    case 'RACEPIC_UPLOAD_CONTENT_TYPE_UNSUPPORTED':
      return { status: 415, message: 'Only JPEG uploads are supported in the MVP' };
    case 'RACEPIC_UPLOAD_SIZE_INVALID':
      return { status: 413, message: 'File size is invalid or exceeds the maximum' };
    case 'RACEPIC_UPLOAD_DUPLICATE_IN_BATCH':
      return { status: 409, message: 'A file with the same fingerprint is already queued in this batch' };
    case 'RACEPIC_UPLOAD_QUOTA_EXCEEDED':
      return { status: 403, message: 'Upload quota for this event has been reached' };
    case 'RACEPIC_UPLOAD_NOT_MULTIPART':
      return { status: 400, message: 'This upload is not a multipart upload' };
    case 'RACEPIC_UPLOAD_NOT_COMPLETABLE':
      return { status: 409, message: 'This upload is not in a completable state' };
    case 'RACEPIC_UPLOAD_PARTS_REQUIRED':
      return { status: 400, message: 'parts is required to complete a multipart upload' };
    case 'RACEPIC_UPLOAD_OBJECT_MISSING':
      return { status: 409, message: 'The uploaded object could not be found in storage' };
    case 'RACEPIC_UPLOAD_ALREADY_COMPLETED':
      return { status: 409, message: 'This upload was already completed and cannot be aborted' };
    case 'RACEPIC_IMAGE_NOT_FOUND':
      return { status: 404, message: 'Image not found' };
    case 'RACEPIC_IMAGE_NOT_READY_TO_PUBLISH':
      return { status: 409, message: 'Image has not finished processing yet' };
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

// --- Paket 3: Upload --------------------------------------------------------------------------

const createBatchSchema = z.object({
  licenseId: z.string().uuid()
});

const createUploadSchema = z.object({
  name: z.string().trim().min(1).max(500),
  type: z.literal('image/jpeg'),
  size: z.number().int().positive(),
  fingerprint: z.string().trim().max(200).optional()
});

const presignPartsSchema = z.object({
  partNumbers: z.array(z.number().int().min(1).max(10_000)).min(1).max(50)
});

const completeUploadSchema = z.object({
  parts: z
    .array(z.object({ partNumber: z.number().int().min(1).max(10_000), eTag: z.string().trim().min(1).max(200) }))
    .max(10_000)
    .optional()
});

// --- Paket 4: Publish -------------------------------------------------------------------------

const patchImageVisibilitySchema = z.object({
  visibility: z.enum(['PUBLISHED', 'HIDDEN', 'REMOVED'])
});

// --- Paket 5: Admin-Basis ----------------------------------------------------------------------

const slugPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const putRacepicEventConfigSchema = z.object({
  slug: z.string().trim().min(1).max(100).regex(slugPattern, 'slug must be lowercase kebab-case'),
  title: z.string().trim().min(1).max(200),
  enabled: z.boolean(),
  published: z.boolean(),
  uploadOpensAt: z.string().datetime().nullable().optional(),
  uploadClosesAt: z.string().datetime().nullable().optional(),
  defaultLicenseId: z.string().uuid().nullable().optional()
});

// --- Paket 6: KI-Pipeline ------------------------------------------------------------------------

const matchingWeightsSchema = z.object({
  ocrExact: z.number().min(0).max(1),
  ocrConfidence: z.number().min(0).max(1),
  vehicleTypeMatch: z.number().min(0).max(1),
  embeddingSimilarity: z.number().min(0).max(1),
  colorSimilarity: z.number().min(0).max(1),
  ambiguityPenalty: z.number().min(0).max(1)
});

const createMatchingConfigSchema = z.object({
  eventId: z.string().uuid().nullable(),
  weights: matchingWeightsSchema,
  autoThreshold: z.number().min(0).max(1),
  reviewThreshold: z.number().min(0).max(1),
  minMargin: z.number().min(0).max(1)
});

const uploadDto = (upload: { id: string; status: string; fileName: string | null; declaredSizeBytes: number; expiresAt: Date }) => ({
  id: upload.id,
  status: upload.status,
  fileName: upload.fileName,
  declaredSizeBytes: upload.declaredSizeBytes,
  expiresAt: upload.expiresAt
});

const batchDto = (batch: {
  id: string;
  eventId: string;
  licenseId: string;
  fileCount: number;
  completedCount: number;
  failedCount: number;
}) => ({
  id: batch.id,
  eventId: batch.eventId,
  licenseId: batch.licenseId,
  fileCount: batch.fileCount,
  completedCount: batch.completedCount,
  failedCount: batch.failedCount
});

const imageDto = (image: {
  id: string;
  eventId: string;
  processingStatus: string;
  visibility: string;
  bytes: number | null;
  createdAt: Date;
}) => ({
  id: image.id,
  eventId: image.eventId,
  processingStatus: image.processingStatus,
  visibility: image.visibility,
  bytes: image.bytes,
  createdAt: image.createdAt
});

/** Ladet das Fotografenprofil zum JWT und lehnt ab, wenn es noch nicht (fertig) geclaimt ist. */
type ActivePhotographerResult =
  | { ok: false; error: APIGatewayProxyStructuredResultV2 }
  | { ok: true; photographer: Awaited<ReturnType<typeof getPhotographerByCognitoSub>> & object };

const requireActivePhotographer = async (event: APIGatewayProxyEventV2): Promise<ActivePhotographerResult> => {
  const auth = getPhotographerAuthContext(event);
  if (!auth.sub) return { ok: false, error: errorJson(401, 'Unauthorized') };
  const photographer = await getPhotographerByCognitoSub(auth.sub);
  if (!photographer) {
    return { ok: false, error: errorJson(404, 'Photographer profile not found - claim an invitation first', undefined, 'PROFILE_NOT_CLAIMED') };
  }
  if (photographer.status === 'DISABLED') {
    return { ok: false, error: errorJson(403, 'Photographer account disabled') };
  }
  return { ok: true, photographer };
};

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
      const photographers = await listPhotographersWithEventAccess();
      return json(200, {
        ok: true,
        photographers: photographers.map((photographer) => ({ ...photographerDto(photographer), events: photographer.events }))
      });
    }

    // --- Admin: Event-Konfiguration und Statistik (Paket 5: Admin-Basis) ----------------------
    if (method === 'GET' && path === '/admin/racepic/events') {
      const auth = getAuthContext(event);
      if (!auth.sub) return errorJson(401, 'Unauthorized');
      if (!hasPermission(auth, 'racepic.read')) return errorJson(403, 'Forbidden');
      const events = await listEventsWithRacepicConfig();
      return json(200, { ok: true, events });
    }

    const putEventConfigMatch = path.match(/^\/admin\/racepic\/events\/([^/]+)$/);
    if (method === 'PUT' && putEventConfigMatch) {
      const auth = getAuthContext(event);
      if (!auth.sub) return errorJson(401, 'Unauthorized');
      if (!hasPermission(auth, 'racepic.manage')) return errorJson(403, 'Forbidden');
      try {
        const input = putRacepicEventConfigSchema.parse(parseJsonBody(event));
        const eventId = decodeURIComponent(putEventConfigMatch[1]);
        const config = await upsertRacepicEventConfig(eventId, {
          slug: input.slug,
          title: input.title,
          enabled: input.enabled,
          uploadOpensAt: input.uploadOpensAt ? new Date(input.uploadOpensAt) : null,
          uploadClosesAt: input.uploadClosesAt ? new Date(input.uploadClosesAt) : null,
          published: input.published,
          defaultLicenseId: input.defaultLicenseId ?? null
        });
        const db = await getDb();
        await writeAuditLog(db, {
          eventId,
          actorUserId: auth.sub,
          action: 'racepic_event_config_updated',
          entityType: 'racepic_event',
          entityId: eventId,
          payload: { slug: input.slug, enabled: input.enabled, published: input.published }
        });
        return json(200, { ok: true, config });
      } catch (error) {
        if (error instanceof ZodError) return errorJson(400, 'Validation failed', { issues: error.issues });
        if (isInvalidJson(error)) return errorJson(400, 'Invalid JSON body');
        if (error instanceof RacePicError) {
          const { status, message } = racePicErrorStatus(error);
          return errorJson(status, message, undefined, error.code);
        }
        throw error;
      }
    }

    const eventStatsMatch = path.match(/^\/admin\/racepic\/events\/([^/]+)\/stats$/);
    if (method === 'GET' && eventStatsMatch) {
      const auth = getAuthContext(event);
      if (!auth.sub) return errorJson(401, 'Unauthorized');
      if (!hasPermission(auth, 'racepic.read')) return errorJson(403, 'Forbidden');
      const stats = await getEventStats(decodeURIComponent(eventStatsMatch[1]));
      return json(200, { ok: true, stats });
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
          const { status, message } = racePicErrorStatus(error);
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
          const { status, message } = racePicErrorStatus(error);
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
          const { status, message } = racePicErrorStatus(error);
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

    if (method === 'GET' && path === '/photographer/events') {
      const result = await requireActivePhotographer(event);
      if (!result.ok) return result.error;
      const events = await listMyEventAccess(result.photographer.id);
      return json(200, { ok: true, events });
    }

    if (method === 'GET' && path === '/admin/racepic/licenses') {
      const auth = getAuthContext(event);
      if (!auth.sub) return errorJson(401, 'Unauthorized');
      if (!hasPermission(auth, 'racepic.read')) return errorJson(403, 'Forbidden');
      const licenses = await listActiveLicenses();
      return json(200, { ok: true, licenses: licenses.map((license) => ({ id: license.id, code: license.code, title: license.title })) });
    }

    if (method === 'GET' && path === '/photographer/licenses') {
      const result = await requireActivePhotographer(event);
      if (!result.ok) return result.error;
      const licenses = await listActiveLicenses();
      return json(200, {
        ok: true,
        licenses: licenses.map((license) => ({
          id: license.id,
          code: license.code,
          title: license.title,
          summary: license.summary,
          attributionRequired: license.attributionRequired
        }))
      });
    }

    // --- Fotograf: Upload (Paket 3) ------------------------------------------------------------
    const createBatchMatch = path.match(/^\/photographer\/events\/([^/]+)\/batches$/);
    if (method === 'POST' && createBatchMatch) {
      const result = await requireActivePhotographer(event);
      if (!result.ok) return result.error;
      try {
        const input = createBatchSchema.parse(parseJsonBody(event));
        const batch = await createBatch({ photographerId: result.photographer.id, eventId: decodeURIComponent(createBatchMatch[1]), licenseId: input.licenseId });
        return json(201, { ok: true, batch: batchDto(batch) });
      } catch (error) {
        if (error instanceof ZodError) return errorJson(400, 'Validation failed', { issues: error.issues });
        if (isInvalidJson(error)) return errorJson(400, 'Invalid JSON body');
        if (error instanceof RacePicError) {
          const { status, message } = racePicErrorStatus(error);
          return errorJson(status, message, undefined, error.code);
        }
        throw error;
      }
    }

    const createUploadMatch = path.match(/^\/photographer\/batches\/([^/]+)\/uploads$/);
    if (method === 'POST' && createUploadMatch) {
      const result = await requireActivePhotographer(event);
      if (!result.ok) return result.error;
      try {
        const batch = await getBatchForPhotographer(decodeURIComponent(createUploadMatch[1]), result.photographer.id);
        if (!batch) return errorJson(404, 'Batch not found');
        const input = createUploadSchema.parse(parseJsonBody(event));
        const { upload, uploadUrl } = await createUpload({
          batch,
          fileName: input.name,
          contentType: input.type,
          declaredSizeBytes: input.size,
          clientFingerprint: input.fingerprint ?? null
        });
        return json(201, {
          ok: true,
          upload: uploadDto(upload),
          uploadUrl,
          s3UploadId: upload.s3UploadId,
          requiredHeaders: { 'content-type': input.type }
        });
      } catch (error) {
        if (error instanceof ZodError) return errorJson(400, 'Validation failed', { issues: error.issues });
        if (isInvalidJson(error)) return errorJson(400, 'Invalid JSON body');
        if (error instanceof RacePicError) {
          const { status, message } = racePicErrorStatus(error);
          return errorJson(status, message, undefined, error.code);
        }
        throw error;
      }
    }

    const uploadPartsMatch = path.match(/^\/photographer\/uploads\/([^/]+)\/parts$/);
    if (uploadPartsMatch) {
      const result = await requireActivePhotographer(event);
      if (!result.ok) return result.error;
      const found = await getUploadForPhotographer(decodeURIComponent(uploadPartsMatch[1]), result.photographer.id);
      if (!found) return errorJson(404, 'Upload not found');
      try {
        if (method === 'GET') {
          const parts = await listPartsForResume(found.upload);
          return json(200, { ok: true, parts });
        }
        if (method === 'POST') {
          const input = presignPartsSchema.parse(parseJsonBody(event));
          const parts = await presignRemainingParts(found.upload, input.partNumbers);
          return json(200, { ok: true, parts });
        }
      } catch (error) {
        if (error instanceof ZodError) return errorJson(400, 'Validation failed', { issues: error.issues });
        if (isInvalidJson(error)) return errorJson(400, 'Invalid JSON body');
        if (error instanceof RacePicError) {
          const { status, message } = racePicErrorStatus(error);
          return errorJson(status, message, undefined, error.code);
        }
        throw error;
      }
    }

    const uploadCompleteMatch = path.match(/^\/photographer\/uploads\/([^/]+)\/complete$/);
    if (method === 'POST' && uploadCompleteMatch) {
      const result = await requireActivePhotographer(event);
      if (!result.ok) return result.error;
      const found = await getUploadForPhotographer(decodeURIComponent(uploadCompleteMatch[1]), result.photographer.id);
      if (!found) return errorJson(404, 'Upload not found');
      try {
        const input = completeUploadSchema.parse(parseJsonBody(event));
        const { image, alreadyCompleted } = await completeUpload(found.upload, found.batch, input.parts);
        if (image && !alreadyCompleted) {
          await sendIngestMessage(image.id).catch((error) =>
            logOperationalEvent('error', 'racepic_upload.ingest_enqueue_failed', { errorCode: errorCodeOf(error) })
          );
        }
        return json(200, { ok: true, image: image ? imageDto(image) : null, alreadyCompleted });
      } catch (error) {
        if (error instanceof ZodError) return errorJson(400, 'Validation failed', { issues: error.issues });
        if (isInvalidJson(error)) return errorJson(400, 'Invalid JSON body');
        if (error instanceof RacePicError) {
          const { status, message } = racePicErrorStatus(error);
          return errorJson(status, message, undefined, error.code);
        }
        throw error;
      }
    }

    const uploadDeleteMatch = path.match(/^\/photographer\/uploads\/([^/]+)$/);
    if (method === 'DELETE' && uploadDeleteMatch) {
      const result = await requireActivePhotographer(event);
      if (!result.ok) return result.error;
      const found = await getUploadForPhotographer(decodeURIComponent(uploadDeleteMatch[1]), result.photographer.id);
      if (!found) return errorJson(404, 'Upload not found');
      try {
        await abortUpload(found.upload, found.batch);
        return json(200, { ok: true });
      } catch (error) {
        if (error instanceof RacePicError) {
          const { status, message } = racePicErrorStatus(error);
          return errorJson(status, message, undefined, error.code);
        }
        throw error;
      }
    }

    if (method === 'GET' && path === '/photographer/images') {
      const result = await requireActivePhotographer(event);
      if (!result.ok) return result.error;
      const query = event.queryStringParameters ?? {};
      const limitRaw = Number(query.limit ?? '50');
      const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 200) : 50;
      const images = await listMyImages({ photographerId: result.photographer.id, eventId: query.eventId, status: query.status, limit });
      return json(200, { ok: true, images: images.map(imageDto) });
    }

    // --- Admin: Veroeffentlichen/Verbergen/Entfernen (Paket 4: Publish-Worker) -----------------
    const imageVisibilityMatch = path.match(/^\/admin\/racepic\/images\/([^/]+)$/);
    if (method === 'PATCH' && imageVisibilityMatch) {
      const auth = getAuthContext(event);
      if (!auth.sub) return errorJson(401, 'Unauthorized');
      const imageId = decodeURIComponent(imageVisibilityMatch[1]);
      try {
        const input = patchImageVisibilitySchema.parse(parseJsonBody(event));
        // Verbergen darf ein Moderator (racepic.review); Veroeffentlichen/Entfernen bleibt
        // Admins mit racepic.manage vorbehalten (Abschnitt H: Moderation).
        const requiredPermission = input.visibility === 'HIDDEN' ? 'racepic.review' : 'racepic.manage';
        if (!hasPermission(auth, requiredPermission)) return errorJson(403, 'Forbidden');

        if (input.visibility === 'PUBLISHED') await publishImage(imageId);
        else if (input.visibility === 'HIDDEN') await hideImage(imageId);
        else await removeImage(imageId);

        const eventId = await getImageEventId(imageId);
        if (eventId) {
          await regenerateManifestsForEvent(eventId).catch((error) =>
            logOperationalEvent('error', 'racepic_publish.manifest_regen_failed', { errorCode: errorCodeOf(error) })
          );
        }

        const db = await getDb();
        await writeAuditLog(db, {
          eventId,
          actorUserId: auth.sub,
          action: 'racepic_image_visibility_changed',
          entityType: 'racepic_image',
          entityId: imageId,
          payload: { visibility: input.visibility }
        });

        return json(200, { ok: true });
      } catch (error) {
        if (error instanceof ZodError) return errorJson(400, 'Validation failed', { issues: error.issues });
        if (isInvalidJson(error)) return errorJson(400, 'Invalid JSON body');
        if (error instanceof RacePicError) {
          const { status, message } = racePicErrorStatus(error);
          return errorJson(status, message, undefined, error.code);
        }
        throw error;
      }
    }

    // --- Admin: Matching-Config und Re-Runs (Paket 6) ------------------------------------------
    if (method === 'GET' && path === '/admin/racepic/matching-configs') {
      const auth = getAuthContext(event);
      if (!auth.sub) return errorJson(401, 'Unauthorized');
      if (!hasPermission(auth, 'racepic.read')) return errorJson(403, 'Forbidden');
      const configs = await listMatchingConfigs(event.queryStringParameters?.eventId);
      return json(200, { ok: true, configs });
    }

    if (method === 'POST' && path === '/admin/racepic/matching-configs') {
      const auth = getAuthContext(event);
      if (!auth.sub) return errorJson(401, 'Unauthorized');
      if (!hasPermission(auth, 'racepic.manage')) return errorJson(403, 'Forbidden');
      try {
        const input = createMatchingConfigSchema.parse(parseJsonBody(event));
        const config = await createMatchingConfig(input);
        const db = await getDb();
        await writeAuditLog(db, {
          eventId: input.eventId,
          actorUserId: auth.sub,
          action: 'racepic_matching_config_created',
          entityType: 'racepic_matching_config',
          entityId: config?.id ?? null,
          payload: { version: config?.version }
        });
        return json(201, { ok: true, config });
      } catch (error) {
        if (error instanceof ZodError) return errorJson(400, 'Validation failed', { issues: error.issues });
        if (isInvalidJson(error)) return errorJson(400, 'Invalid JSON body');
        if (error instanceof RacePicError) {
          const { status, message } = racePicErrorStatus(error);
          return errorJson(status, message, undefined, error.code);
        }
        throw error;
      }
    }

    // Re-Match nur ab MATCHED/ANALYZED (Abschnitt F: "Ein Re-Match mit neuer Config braucht keinen
    // neuen KI-Aufruf") - setzt processingStatus zurueck auf ANALYZED und reiht erneut in die
    // Match-Queue ein; die KI-Rohantworten in S3 bleiben unangetastet.
    const rematchEventMatch = path.match(/^\/admin\/racepic\/events\/([^/]+)\/rematch$/);
    if (method === 'POST' && rematchEventMatch) {
      const auth = getAuthContext(event);
      if (!auth.sub) return errorJson(401, 'Unauthorized');
      if (!hasPermission(auth, 'racepic.manage')) return errorJson(403, 'Forbidden');
      const eventId = decodeURIComponent(rematchEventMatch[1]);
      const db = await getDb();
      const images = await db
        .select({ id: racepicImage.id })
        .from(racepicImage)
        .where(and(eq(racepicImage.eventId, eventId), inArray(racepicImage.processingStatus, ['ANALYZED', 'MATCHED'])));
      let queued = 0;
      for (const image of images) {
        await sendMatchMessage(image.id).catch(() => undefined);
        queued += 1;
      }
      await writeAuditLog(db, {
        eventId,
        actorUserId: auth.sub,
        action: 'racepic_rematch_triggered',
        entityType: 'racepic_event',
        entityId: eventId,
        payload: { queued }
      });
      return json(200, { ok: true, queued });
    }

    const reanalyzeImageMatch = path.match(/^\/admin\/racepic\/images\/([^/]+)\/reanalyze$/);
    if (method === 'POST' && reanalyzeImageMatch) {
      const auth = getAuthContext(event);
      if (!auth.sub) return errorJson(401, 'Unauthorized');
      if (!hasPermission(auth, 'racepic.manage')) return errorJson(403, 'Forbidden');
      const imageId = decodeURIComponent(reanalyzeImageMatch[1]);
      await sendAnalyzeMessage(imageId);
      const db = await getDb();
      await writeAuditLog(db, {
        actorUserId: auth.sub,
        action: 'racepic_reanalyze_triggered',
        entityType: 'racepic_image',
        entityId: imageId,
        payload: {}
      });
      return json(200, { ok: true });
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
