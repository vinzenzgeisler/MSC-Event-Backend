import { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { z, ZodError } from 'zod';
import { errorJson, json } from '../http/response';
import { getAuthContext, hasPermission } from '../http/auth';
import { parseJsonBody } from '../http/parse';
import { writeAuditLog } from '../audit/log';
import { getDb } from '../db/client';
import { errorCodeOf, logOperationalEvent } from '../observability/logger';
import { getPhotographerAuthContext, satisfiesStepUp } from './auth';
import { ensurePhotographerCognitoUser, setPhotographerPassword } from './cognito';
import { queuePhotographerInvitationMail } from './mail';
import {
  claimInvitation,
  createPhotographerInvitation,
  deletePhotographer,
  getConsumableInvitationByToken,
  getInvitationPreviewByToken,
  getPhotographerByCognitoSub,
  hashToken,
  listActiveLicenses,
  listMyEventAccess,
  listPhotographers,
  RacePicError,
  RACEPIC_PHOTOGRAPHER_TERMS_VERSION,
  registerPhotographer,
  reviewPhotographerRegistration,
  updatePhotographerProfile
} from './repository';
import {
  abortUpload,
  completeUpload,
  createBatch,
  createUpload,
  getBatchForPhotographer,
  getUploadForPhotographer,
  hideOwnImage,
  listMyImages,
  listPartsForResume,
  presignRemainingParts,
  removeOwnImage,
  updateOwnImageDetails
} from './uploads';
import { sendAnalyzeMessage, sendIngestMessage, sendMatchMessage } from './queues';
import {
  getImageEventId,
  getImagePhotographerId,
  hardDeleteImage,
  hideImage,
  publishImage,
  regenerateManifestsForEvent,
  regeneratePhotographerManifest,
  removeImage,
  setEventPublicObjectAvailability,
  unpublishEventManifests
} from './publish';
import { getEventStats, getImagePipelineStatus, listEventsWithRacepicConfig, listImagesForEvent, listPhotographersWithEventAccess, upsertRacepicEventConfig } from './adminEvents';
import { warmEventVehicleReferences } from './vehicleReference';
import { createMatchingConfig, listMatchingConfigs } from './matchingConfig';
import { computeMatchQualityReport } from './matchQuality';
import {
  addAssignment,
  confirmAssignment,
  correctAssignment,
  dismissDetection,
  hideParticipant,
  listAssignmentsForImage,
  listImagesForEntry,
  listReviewQueue,
  rejectAssignment,
  searchEntriesByEvent
} from './reviewQueue';
import { requestImageDownload } from './download';
import { racepicAssignment, racepicAssignmentEvent, racepicDetection, racepicEvent, racepicImage, racepicProcessingStep } from '../db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { buildPublicRateLimitKey, enforcePublicRateLimit } from '../http/publicRateLimit';

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

const enforceRacePicPublicRateLimit = async (
  event: APIGatewayProxyEventV2,
  scope: string,
  limit: number,
  windowSeconds: number,
  resourceKey: string
) => {
  const forwardedFor = event.headers['x-forwarded-for'] ?? event.headers['X-Forwarded-For'];
  const clientIp = forwardedFor?.split(',')[0]?.trim() || event.requestContext.http.sourceIp?.trim() || 'unknown';
  const result = await enforcePublicRateLimit({
    scope,
    key: buildPublicRateLimitKey([clientIp, resourceKey]),
    limit,
    windowSeconds
  });
  return result.allowed ? null : errorJson(429, 'Too many requests', { scope, limit: result.limit }, 'RATE_LIMITED', undefined, {
    'retry-after': String(result.retryAfterSeconds)
  });
};

const racePicErrorStatus = (error: RacePicError): { status: number; message: string } => {
  switch (error.code) {
    case 'RACEPIC_INVITATION_ALREADY_CONSUMED':
      return { status: 409, message: 'Invitation already consumed' };
    case 'RACEPIC_INVITATION_EXPIRED':
      return { status: 410, message: 'Invitation expired' };
    case 'RACEPIC_PHOTOGRAPHER_ALREADY_CLAIMED':
      return { status: 409, message: 'Photographer profile already claimed' };
    case 'RACEPIC_PHOTOGRAPHER_ALREADY_EXISTS':
      return { status: 409, message: 'A photographer profile already exists for this email' };
    case 'RACEPIC_REGISTRATION_NOT_PENDING':
      return { status: 409, message: 'Registration is not pending' };
    case 'RACEPIC_TERMS_VERSION_REQUIRED':
      return { status: 409, message: `Terms version ${RACEPIC_PHOTOGRAPHER_TERMS_VERSION} is required` };
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
      return { status: 415, message: 'Only JPEG/PNG uploads are supported in the MVP' };
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
    case 'RACEPIC_UPLOAD_PARTS_INVALID':
      return { status: 409, message: 'Uploaded multipart parts do not match the declared file' };
    case 'RACEPIC_UPLOAD_OBJECT_MISSING':
      return { status: 409, message: 'The uploaded object could not be found in storage' };
    case 'RACEPIC_UPLOAD_ALREADY_COMPLETED':
      return { status: 409, message: 'This upload was already completed and cannot be aborted' };
    case 'RACEPIC_IMAGE_NOT_FOUND':
      return { status: 404, message: 'Image not found' };
    case 'RACEPIC_IMAGE_NOT_READY_TO_PUBLISH':
      return { status: 409, message: 'Image has not finished processing yet' };
    case 'RACEPIC_IMAGE_NOT_PUBLICLY_ELIGIBLE':
      return { status: 409, message: 'Image is blocked by participant privacy or eligibility rules' };
    case 'RACEPIC_PAID_OFFER_NOT_PUBLIC':
      return { status: 409, message: 'Paid offers remain private until checkout is available' };
    case 'RACEPIC_IMAGE_ALREADY_REMOVED':
      return { status: 409, message: 'Image was already removed' };
    case 'RACEPIC_IMAGE_NOT_REMOVED':
      return { status: 409, message: 'Image must be removed before it can be permanently deleted' };
    case 'RACEPIC_IMAGE_NOT_DELETABLE':
      return { status: 409, message: 'Image can only be deleted while still a draft (not yet published)' };
    case 'RACEPIC_IMAGE_LICENSE_LOCKED':
      return { status: 409, message: 'License and offer can only be changed while the image is a draft' };
    case 'RACEPIC_IMAGE_LICENSE_INVALID':
      return { status: 400, message: 'License does not match the offer mode' };
    case 'RACEPIC_IMAGE_PRICE_INVALID':
      return { status: 400, message: 'Price does not match the offer mode' };
    case 'RACEPIC_IMAGE_NOT_READY_TO_PRICE':
      return { status: 409, message: 'Image preview has not finished processing' };
    case 'RACEPIC_ASSIGNMENT_NOT_FOUND':
      return { status: 404, message: 'Assignment not found' };
    case 'RACEPIC_ASSIGNMENT_ALREADY_EXISTS':
      return { status: 409, message: 'This entry is already assigned to this image' };
    case 'RACEPIC_ASSIGNMENT_TARGET_INVALID':
      return { status: 409, message: 'The selected entry is not eligible for this image' };
    case 'RACEPIC_MATCHING_CONFIG_THRESHOLDS_INVALID':
      return { status: 400, message: 'reviewThreshold must not exceed autoThreshold' };
    case 'RACEPIC_IMAGE_NOT_PUBLISHED':
      return { status: 404, message: 'Image not found' };
    case 'RACEPIC_IMAGE_NOT_FREE':
      return { status: 402, message: 'This image is not available for free download' };
    case 'RACEPIC_DOWNLOAD_VARIANT_UNAVAILABLE':
      return { status: 404, message: 'Requested variant is not available for this image' };
    case 'RACEPIC_ENTRY_NOT_FOUND':
      return { status: 404, message: 'Entry not found' };
    case 'RACEPIC_PHOTOGRAPHER_NOT_FOUND':
      return { status: 404, message: 'Photographer not found' };
    case 'RACEPIC_DETECTION_NOT_FOUND':
      return { status: 404, message: 'Detection not found' };
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
  type: z.enum(['image/jpeg', 'image/png']),
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

// Paket 15: Fotografen duerfen ihr eigenes Bild nur verbergen, nicht veroeffentlichen/entfernen
// (siehe hideOwnImage in uploads.ts) - daher ein eigenes, engeres Schema statt des obigen.
const patchOwnImageVisibilitySchema = z.object({
  visibility: z.literal('HIDDEN')
});

const registerPhotographerSchema = z.object({
  displayName: z.string().trim().min(2).max(200),
  termsVersion: z.string().trim().min(1).max(50)
});
const reviewRegistrationSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  eventIds: z.array(z.string().uuid()).max(20).default([])
});
const setPhotographerPasswordSchema = z.object({ password: z.string().min(12).max(128) });

const patchOwnImageDetailsSchema = z.object({
  title: z.string().trim().max(160).nullable().optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(15).optional(),
  licenseId: z.string().uuid().optional(),
  offerMode: z.enum(['FREE', 'PAID']).optional(),
  priceCents: z.number().int().min(1).max(10000000).nullable().optional()
}).strict();

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

// --- Paket 7: Review-Queue -----------------------------------------------------------------------

const correctAssignmentSchema = z.object({ entryId: z.string().uuid() });
const addAssignmentSchema = z.object({ entryId: z.string().uuid(), detectionId: z.string().uuid().nullable().optional() });

// --- Paket 8: Oeffentlicher Download -------------------------------------------------------------

const requestDownloadSchema = z.object({ variant: z.enum(['small', 'medium', 'large', 'original']) });

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
  thumbUrl?: string | null;
  previewUrl?: string | null;
  title?: string | null;
  description?: string | null;
  tags?: unknown;
  licenseId?: string;
  offerMode?: string;
  priceCents?: number | null;
}) => ({
  id: image.id,
  eventId: image.eventId,
  processingStatus: image.processingStatus,
  visibility: image.visibility,
  bytes: image.bytes,
  createdAt: image.createdAt,
  thumbUrl: image.thumbUrl ?? null,
  previewUrl: image.previewUrl ?? null,
  title: image.title ?? null,
  description: image.description ?? null,
  tags: image.tags ?? [],
  licenseId: image.licenseId ?? null,
  offerMode: image.offerMode ?? 'FREE',
  priceCents: image.priceCents ?? null
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
  if (photographer.status === 'DISABLED' || photographer.status === 'PENDING_APPROVAL') {
    return { ok: false, error: errorJson(403, photographer.status === 'PENDING_APPROVAL' ? 'Registration is waiting for approval' : 'Photographer account disabled') };
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
    const adminAuth = path.startsWith('/admin/') ? getAuthContext(event) : null;
    const isAdminMutation = path.startsWith('/admin/') && !['GET', 'OPTIONS'].includes(method);
    if (adminAuth && !adminAuth.sub) return errorJson(401, 'Unauthorized');
    if (process.env.REQUIRE_ADMIN_MFA === 'true' && adminAuth?.sub && isAdminMutation && !adminAuth.mfaAuthenticated) {
      return errorJson(403, 'MFA required', undefined, 'MFA_REQUIRED');
    }

    if (method === 'OPTIONS') {
      return json(200, { ok: true });
    }

    if (method === 'GET' && path === '/public/racepic/config') {
      return json(200, { ok: true, enabled: true, photographerTermsVersion: RACEPIC_PHOTOGRAPHER_TERMS_VERSION });
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

        const db = await getDb();
        const [previous] = await db
          .select({ slug: racepicEvent.slug, published: racepicEvent.published, enabled: racepicEvent.enabled })
          .from(racepicEvent)
          .where(eq(racepicEvent.eventId, eventId))
          .limit(1);

        const config = await upsertRacepicEventConfig(eventId, {
          slug: input.slug,
          title: input.title,
          enabled: input.enabled,
          uploadOpensAt: input.uploadOpensAt ? new Date(input.uploadOpensAt) : null,
          uploadClosesAt: input.uploadClosesAt ? new Date(input.uploadClosesAt) : null,
          published: input.published,
          defaultLicenseId: input.defaultLicenseId ?? null
        });

        // Manifeste synchron halten (Luecke, behoben 2026-09-22, siehe publish.ts): war das Event
        // vorher veroeffentlicht und ist es das jetzt nicht mehr, oder hat sich der Slug eines
        // veroeffentlichten Events geaendert, muessen die (dann verwaisten) alten Manifeste unter
        // dem alten Slug zurueckgezogen werden. Ansonsten (weiterhin veroeffentlicht, gleicher
        // Slug, oder neu veroeffentlicht) reicht die normale Regenerierung.
        const wasPublic = Boolean(previous?.published && previous.enabled);
        const nowPublic = input.published && input.enabled;
        if (wasPublic && !nowPublic) await setEventPublicObjectAvailability(eventId, false);
        if (nowPublic && !wasPublic) await setEventPublicObjectAvailability(eventId, true);
        if (wasPublic && (!nowPublic || previous?.slug !== input.slug)) {
          await unpublishEventManifests(previous.slug, eventId);
        }
        if (nowPublic) {
          await regenerateManifestsForEvent(eventId);
        }

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

    // Paket 11: allgemeine Bildliste je Event (Bestandsaufnahme 2026-09-22), siehe adminEvents.ts.
    const eventImagesMatch = path.match(/^\/admin\/racepic\/events\/([^/]+)\/images$/);
    if (method === 'GET' && eventImagesMatch) {
      const auth = getAuthContext(event);
      if (!auth.sub) return errorJson(401, 'Unauthorized');
      if (!hasPermission(auth, 'racepic.review')) return errorJson(403, 'Forbidden');
      const query = event.queryStringParameters ?? {};
      const limit = Math.min(Math.max(Number(query.limit ?? '20') || 20, 1), 100);
      const offset = Math.max(Number(query.offset ?? '0') || 0, 0);
      const result = await listImagesForEvent(
        decodeURIComponent(eventImagesMatch[1]),
        { visibility: query.visibility, processingStatus: query.processingStatus },
        offset,
        limit
      );
      return json(200, { ok: true, ...result });
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

    const registrationReviewMatch = path.match(/^\/admin\/racepic\/photographers\/([^/]+)\/review$/);
    if (method === 'POST' && registrationReviewMatch) {
      const auth = getAuthContext(event);
      if (!auth.sub) return errorJson(401, 'Unauthorized');
      if (!hasPermission(auth, 'racepic.manage')) return errorJson(403, 'Forbidden');
      try {
        const input = reviewRegistrationSchema.parse(parseJsonBody(event));
        const photographer = await reviewPhotographerRegistration({ photographerId: decodeURIComponent(registrationReviewMatch[1]), ...input });
        const db = await getDb();
        await writeAuditLog(db, { actorUserId: auth.sub, action: 'racepic_photographer_registration_reviewed', entityType: 'racepic_photographer', entityId: photographer.id, payload: { decision: input.decision, eventIds: input.eventIds } });
        return json(200, { ok: true, photographer: photographerDto(photographer) });
      } catch (error) {
        if (error instanceof ZodError) return errorJson(400, 'Validation failed', { issues: error.issues });
        if (isInvalidJson(error)) return errorJson(400, 'Invalid JSON body');
        if (error instanceof RacePicError) { const { status, message } = racePicErrorStatus(error); return errorJson(status, message, undefined, error.code); }
        throw error;
      }
    }

    // Admin-Loeschung eines Fotografen (Feedback 2026-09-22: "Fotografen will ich auch löschen
    // können"). Soft-Delete (status=DISABLED + deletedAt), siehe Begruendung in repository.ts -
    // ihre Bilder bleiben unangetastet.
    const photographerDeleteMatch = path.match(/^\/admin\/racepic\/photographers\/([^/]+)$/);
    if (method === 'DELETE' && photographerDeleteMatch) {
      const auth = getAuthContext(event);
      if (!auth.sub) return errorJson(401, 'Unauthorized');
      if (!hasPermission(auth, 'racepic.manage')) return errorJson(403, 'Forbidden');
      const photographerId = decodeURIComponent(photographerDeleteMatch[1]);
      try {
        await deletePhotographer(photographerId);
        const db = await getDb();
        await writeAuditLog(db, { actorUserId: auth.sub, action: 'racepic_photographer_deleted', entityType: 'racepic_photographer', entityId: photographerId, payload: {} });
        return json(200, { ok: true });
      } catch (error) {
        if (error instanceof RacePicError) { const { status, message } = racePicErrorStatus(error); return errorJson(status, message, undefined, error.code); }
        throw error;
      }
    }

    const imageStatusMatch = path.match(/^\/admin\/racepic\/images\/([^/]+)\/status$/);
    if (method === 'GET' && imageStatusMatch) {
      const auth = getAuthContext(event);
      if (!auth.sub) return errorJson(401, 'Unauthorized');
      if (!hasPermission(auth, 'racepic.read')) return errorJson(403, 'Forbidden');
      try { return json(200, { ok: true, status: await getImagePipelineStatus(decodeURIComponent(imageStatusMatch[1])) }); }
      catch (error) { if (error instanceof RacePicError) { const { status, message } = racePicErrorStatus(error); return errorJson(status, message, undefined, error.code); } throw error; }
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
      const rateLimited = await enforceRacePicPublicRateLimit(event, 'racepic_invitation_preview', 60, 300, hashToken(token));
      if (rateLimited) return rateLimited;
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
      const rateLimited = await enforceRacePicPublicRateLimit(event, 'racepic_invitation_start', 6, 3600, hashToken(token));
      if (rateLimited) return rateLimited;
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

    // --- Oeffentlich: Download (Paket 8) --------------------------------------------------------
    const publicDownloadMatch = path.match(/^\/public\/racepic\/images\/([^/]+)\/download$/);
    if (method === 'POST' && publicDownloadMatch) {
      try {
        const imageId = decodeURIComponent(publicDownloadMatch[1]);
        const rateLimited = await enforceRacePicPublicRateLimit(event, 'racepic_image_download', 30, 600, imageId);
        if (rateLimited) return rateLimited;
        const input = requestDownloadSchema.parse(parseJsonBody(event));
        const result = await requestImageDownload(imageId, input.variant);
        return json(200, { ok: true, ...result });
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

    // --- Fotograf: Claiming und Profil ---------------------------------------------------------
    if (method === 'POST' && path === '/photographer/register') {
      const auth = getPhotographerAuthContext(event);
      if (!auth.sub || !auth.email || !auth.emailVerified) return errorJson(403, 'Verified email required');
      try {
        const input = registerPhotographerSchema.parse(parseJsonBody(event));
        const photographer = await registerPhotographer({ cognitoSub: auth.sub, email: auth.email, ...input });
        return json(201, { ok: true, photographer: photographerDto(photographer) });
      } catch (error) {
        if (error instanceof ZodError) return errorJson(400, 'Validation failed', { issues: error.issues });
        if (isInvalidJson(error)) return errorJson(400, 'Invalid JSON body');
        if (error instanceof RacePicError) { const { status, message } = racePicErrorStatus(error); return errorJson(status, message, undefined, error.code); }
        throw error;
      }
    }
    if (method === 'POST' && path === '/photographer/password') {
      const auth = getPhotographerAuthContext(event);
      if (!satisfiesStepUp(auth, 'recent')) return errorJson(403, 'Recent sign-in required');
      const photographer = await getPhotographerByCognitoSub(auth.sub!);
      if (!photographer || photographer.status === 'DISABLED') return errorJson(403, 'Photographer account unavailable');
      try {
        const input = setPhotographerPasswordSchema.parse(parseJsonBody(event));
        await setPhotographerPassword(photographer.email, input.password);
        return json(200, { ok: true });
      } catch (error) {
        if (error instanceof ZodError) return errorJson(400, 'Validation failed', { issues: error.issues });
        if (isInvalidJson(error)) return errorJson(400, 'Invalid JSON body');
        throw error;
      }
    }

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
      if (photographer.status === 'DISABLED') return errorJson(403, 'Photographer account disabled');
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
      if (photographer.status === 'DISABLED') return errorJson(403, 'Photographer account disabled');
      try {
        const input = patchPhotographerProfileSchema.parse(parseJsonBody(event));
        const updated = await updatePhotographerProfile(photographer.id, input);
        if (!updated) return errorJson(404, 'Photographer profile not found');
        // Oeffentliches Profil (Paket 12) synchron halten - No-Op ohne Slug/veroeffentlichte Bilder.
        await regeneratePhotographerManifest(photographer.id);
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
          attributionRequired: license.attributionRequired,
          pricingKind: license.pricingKind
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
        const { upload, uploadUrl, resumed, completed } = await createUpload({
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
          resumed,
          completed,
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
        if (image) await sendIngestMessage(image.id);
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

    // Read-only Einsicht in die (auch automatischen) Zuordnungen des eigenen Bildes (Feedback
    // 2026-09-22: "als Fotograf will ich auch die automatischen Zuordnungen sehen können" - bisher
    // gab es diese Info nur im Admin-Bereich). Kein racepic.review noetig, Ownership-Check statt
    // Berechtigungspruefung; abgelehnte Zuordnungen werden ausgeblendet, die interessieren als
    // Fotograf nicht mehr.
    const ownImageAssignmentsMatch = path.match(/^\/photographer\/images\/([^/]+)\/assignments$/);
    if (method === 'GET' && ownImageAssignmentsMatch) {
      const result = await requireActivePhotographer(event);
      if (!result.ok) return result.error;
      const imageId = decodeURIComponent(ownImageAssignmentsMatch[1]);
      const photographerId = await getImagePhotographerId(imageId);
      if (!photographerId || photographerId !== result.photographer.id) return errorJson(404, 'Image not found');
      const assignments = (await listAssignmentsForImage(imageId)).filter((assignment) => assignment.status !== 'REJECTED');
      return json(200, { ok: true, assignments });
    }

    // Fotograf-Selbstverwaltung (Paket 15), siehe uploads.ts hideOwnImage/deleteOwnDraftImage fuer
    // die Begruendung der Einschraenkungen (nur verbergen, nur vor Veroeffentlichung loeschen).
    const ownImageMatch = path.match(/^\/photographer\/images\/([^/]+)$/);
    const ownImageDetailsMatch = path.match(/^\/photographer\/images\/([^/]+)\/details$/);
    if (method === 'PATCH' && ownImageDetailsMatch) {
      const result = await requireActivePhotographer(event);
      if (!result.ok) return result.error;
      try {
        const imageId = decodeURIComponent(ownImageDetailsMatch[1]);
        const input = patchOwnImageDetailsSchema.parse(parseJsonBody(event));
        const image = await updateOwnImageDetails(result.photographer.id, imageId, input);
        if (image.visibility === 'PUBLISHED') await regenerateManifestsForEvent(image.eventId);
        return json(200, { ok: true, image: imageDto(image) });
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
    if (method === 'PATCH' && ownImageMatch) {
      const result = await requireActivePhotographer(event);
      if (!result.ok) return result.error;
      try {
        const input = patchOwnImageVisibilitySchema.parse(parseJsonBody(event));
        const imageId = decodeURIComponent(ownImageMatch[1]);
        await hideOwnImage(result.photographer.id, imageId);
        const db = await getDb();
        await writeAuditLog(db, {
          actorUserId: result.photographer.cognitoSub,
          action: 'racepic_image_visibility_changed',
          entityType: 'racepic_image',
          entityId: imageId,
          payload: { visibility: input.visibility }
        });
        return json(200, { ok: true, visibility: input.visibility });
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
    if (method === 'DELETE' && ownImageMatch) {
      const result = await requireActivePhotographer(event);
      if (!result.ok) return result.error;
      try {
        const imageId = decodeURIComponent(ownImageMatch[1]);
        // Nimmt ein eigenes Bild komplett raus, egal ob DRAFT (Hart-Loeschung) oder bereits
        // veroeffentlicht/verborgen (Soft-Remove wie beim Admin-Weg) - siehe removeOwnImage in
        // uploads.ts (Feedback 2026-09-22: "auch als Fotograf will ich mal Fotos rausnehmen können").
        const { eventId } = await removeOwnImage(result.photographer.id, imageId);
        await regeneratePhotographerManifest(result.photographer.id);
        await regenerateManifestsForEvent(eventId);
        const db = await getDb();
        await writeAuditLog(db, {
          actorUserId: result.photographer.cognitoSub,
          action: 'racepic_own_image_deleted',
          entityType: 'racepic_image',
          entityId: imageId,
          payload: {}
        });
        return json(200, { ok: true });
      } catch (error) {
        if (error instanceof RacePicError) {
          const { status, message } = racePicErrorStatus(error);
          return errorJson(status, message, undefined, error.code);
        }
        throw error;
      }
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

        const photographerId = await getImagePhotographerId(imageId);

        if (input.visibility === 'PUBLISHED') await publishImage(imageId);
        else if (input.visibility === 'HIDDEN') await hideImage(imageId);
        else await removeImage(imageId);

        if (photographerId) {
          await regeneratePhotographerManifest(photographerId);
        }

        const eventId = await getImageEventId(imageId);
        if (eventId) {
          await regenerateManifestsForEvent(eventId);
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

    // Loescht ein bereits entferntes (visibility='REMOVED') Bild endgueltig aus der Datenbank
    // (Feedback 2026-09-22: "ich will es komplett entfernen können mit der Prämisse dass
    // natürlich kein Kauf dahinter hängt" - im MVP ohne echten Checkout immer erfuellt). Bewusst
    // ein eigener Endpunkt statt eines dritten PATCH-visibility-Werts, weil die Aktion irreversibel
    // ist und racepic.manage-Rechte auch fuer das simple "Entfernen" ausreichen wuerden.
    const imageHardDeleteMatch = path.match(/^\/admin\/racepic\/images\/([^/]+)\/permanent$/);
    if (method === 'DELETE' && imageHardDeleteMatch) {
      const auth = getAuthContext(event);
      if (!auth.sub) return errorJson(401, 'Unauthorized');
      if (!hasPermission(auth, 'racepic.manage')) return errorJson(403, 'Forbidden');
      const imageId = decodeURIComponent(imageHardDeleteMatch[1]);
      try {
        await hardDeleteImage(imageId);
        const db = await getDb();
        await writeAuditLog(db, {
          actorUserId: auth.sub,
          action: 'racepic_image_hard_deleted',
          entityType: 'racepic_image',
          entityId: imageId,
          payload: {}
        });
        return json(200, { ok: true });
      } catch (error) {
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

    // Nutzerwunsch 2026-09-23: alle Fahrzeugreferenzen eines Events kontrolliert vorab
    // berechnen/aktualisieren, statt sie nur beilaeufig (verteilt auf mehrere Bilder, dadurch
    // unvorhersehbar) waehrend eines Match-Laufs zu bekommen - siehe warmEventVehicleReferences
    // (vehicleReference.ts). Sequentiell mit Zeitbudget statt fester Batchgroesse (Lambda-Timeout
    // 29s) - das Frontend ruft einfach erneut auf, bis `done: true`.
    const warmReferencesMatch = path.match(/^\/admin\/racepic\/events\/([^/]+)\/warm-vehicle-references$/);
    if (method === 'POST' && warmReferencesMatch) {
      const auth = getAuthContext(event);
      if (!auth.sub) return errorJson(401, 'Unauthorized');
      if (!hasPermission(auth, 'racepic.manage')) return errorJson(403, 'Forbidden');
      const result = await warmEventVehicleReferences(decodeURIComponent(warmReferencesMatch[1]));
      return json(200, { ok: true, ...result });
    }

    const reanalyzeImageMatch = path.match(/^\/admin\/racepic\/images\/([^/]+)\/reanalyze$/);
    if (method === 'POST' && reanalyzeImageMatch) {
      const auth = getAuthContext(event);
      if (!auth.sub) return errorJson(401, 'Unauthorized');
      if (!hasPermission(auth, 'racepic.manage')) return errorJson(403, 'Forbidden');
      const imageId = decodeURIComponent(reanalyzeImageMatch[1]);
      const db = await getDb();
      const [imageToReanalyze] = await db.select({ eventId: racepicImage.eventId, photographerId: racepicImage.photographerId, processingStatus: racepicImage.processingStatus }).from(racepicImage).where(eq(racepicImage.id, imageId)).limit(1);
      if (!imageToReanalyze) return errorJson(404, 'Image not found');
      if (!['DERIVED', 'ANALYZED', 'MATCHED'].includes(imageToReanalyze.processingStatus)) return errorJson(409, 'Image is not ready for reanalysis');
      // Bug gefunden 2026-09-22 (Nutzer-Feedback "wie schaffen wir es, dass die Erkennung besser
      // wird?"): ein simples `sendAnalyzeMessage` allein war hier bislang wirkungslos, sobald ein
      // Bild schon einmal analysiert wurde - analyzeWorker.ts prueft `racepic_processing_step`
      // (step='analyze', gleiche PIPELINE_VERSION) auf status=DONE und beendet sich dann sofort
      // (Idempotenz), und akzeptiert ausserdem nur processingStatus DERIVED/ANALYZED, nicht
      // MATCHED. Ein echter Re-Analyze (z.B. nach einer Rekognition-Pipeline-Verbesserung) muss
      // daher explizit den bisherigen Analyse-/Match-Fortschritt zuruecksetzen: alte Detections
      // loeschen (cascadiert auf racepic_text_detection/racepic_match_candidate; bestehende
      // racepic_assignment-Zeilen bleiben erhalten, verlieren nur ihren detection_id-Verweis -
      // ON DELETE SET NULL), alte processing_step-Zeilen fuer 'analyze'/'match' entfernen und
      // processingStatus auf DERIVED zuruecksetzen.
      await db.transaction(async (tx) => {
        const oldAutomatic = await tx.select({ id: racepicAssignment.id, status: racepicAssignment.status }).from(racepicAssignment).where(and(eq(racepicAssignment.imageId, imageId), eq(racepicAssignment.source, 'AI'), inArray(racepicAssignment.status, ['AUTO_MATCHED', 'REVIEW_REQUIRED'])));
        for (const assignment of oldAutomatic) {
          await tx.update(racepicAssignment).set({ status: 'REJECTED', decidedAt: new Date() }).where(eq(racepicAssignment.id, assignment.id));
          await tx.insert(racepicAssignmentEvent).values({ assignmentId: assignment.id, fromStatus: assignment.status, toStatus: 'REJECTED', actorType: 'admin', actorId: auth.sub, reason: 'reanalyze_reset' });
        }
        await tx.delete(racepicDetection).where(eq(racepicDetection.imageId, imageId));
        await tx.delete(racepicProcessingStep).where(and(eq(racepicProcessingStep.imageId, imageId), inArray(racepicProcessingStep.step, ['analyze', 'match'])));
        await tx.update(racepicImage).set({ processingStatus: 'DERIVED', updatedAt: new Date() }).where(eq(racepicImage.id, imageId));
      });
      await regenerateManifestsForEvent(imageToReanalyze.eventId);
      await regeneratePhotographerManifest(imageToReanalyze.photographerId);
      await sendAnalyzeMessage(imageId);
      await writeAuditLog(db, {
        actorUserId: auth.sub,
        action: 'racepic_reanalyze_triggered',
        entityType: 'racepic_image',
        entityId: imageId,
        payload: {}
      });
      return json(200, { ok: true });
    }

    // Qualitaetsreport (Paket 10), siehe matchQuality.ts fuer die Methodik/Einschraenkungen.
    const matchQualityMatch = path.match(/^\/admin\/racepic\/events\/([^/]+)\/matching-quality-report$/);
    if (method === 'GET' && matchQualityMatch) {
      const auth = getAuthContext(event);
      if (!auth.sub) return errorJson(401, 'Unauthorized');
      if (!hasPermission(auth, 'racepic.read')) return errorJson(403, 'Forbidden');
      const report = await computeMatchQualityReport(decodeURIComponent(matchQualityMatch[1]));
      return json(200, { ok: true, report });
    }

    // --- Admin: Review-Queue (Paket 7) ---------------------------------------------------------
    const reviewQueueMatch = path.match(/^\/admin\/racepic\/events\/([^/]+)\/review-queue$/);
    if (method === 'GET' && reviewQueueMatch) {
      const auth = getAuthContext(event);
      if (!auth.sub) return errorJson(401, 'Unauthorized');
      if (!hasPermission(auth, 'racepic.review')) return errorJson(403, 'Forbidden');
      const query = event.queryStringParameters ?? {};
      const limit = Math.min(Math.max(Number(query.limit ?? '20') || 20, 1), 100);
      const offset = Math.max(Number(query.offset ?? '0') || 0, 0);
      const result = await listReviewQueue(decodeURIComponent(reviewQueueMatch[1]), offset, limit);
      return json(200, { ok: true, ...result });
    }

    const entrySearchMatch = path.match(/^\/admin\/racepic\/events\/([^/]+)\/entries\/search$/);
    if (method === 'GET' && entrySearchMatch) {
      const auth = getAuthContext(event);
      if (!auth.sub) return errorJson(401, 'Unauthorized');
      if (!hasPermission(auth, 'racepic.review')) return errorJson(403, 'Forbidden');
      const results = await searchEntriesByEvent(decodeURIComponent(entrySearchMatch[1]), event.queryStringParameters?.q ?? '');
      return json(200, { ok: true, entries: results });
    }

    const confirmAssignmentMatch = path.match(/^\/admin\/racepic\/assignments\/([^/]+)\/confirm$/);
    if (method === 'POST' && confirmAssignmentMatch) {
      const auth = getAuthContext(event);
      if (!auth.sub) return errorJson(401, 'Unauthorized');
      if (!hasPermission(auth, 'racepic.review')) return errorJson(403, 'Forbidden');
      try {
        const assignment = await confirmAssignment(decodeURIComponent(confirmAssignmentMatch[1]), auth.sub);
        const db = await getDb();
        await writeAuditLog(db, {
          actorUserId: auth.sub,
          action: 'racepic_assignment_reviewed',
          entityType: 'racepic_assignment',
          entityId: assignment.id,
          payload: { decision: 'confirmed' }
        });
        return json(200, { ok: true });
      } catch (error) {
        if (error instanceof RacePicError) {
          const { status, message } = racePicErrorStatus(error);
          return errorJson(status, message, undefined, error.code);
        }
        throw error;
      }
    }

    const rejectAssignmentMatch = path.match(/^\/admin\/racepic\/assignments\/([^/]+)\/reject$/);
    if (method === 'POST' && rejectAssignmentMatch) {
      const auth = getAuthContext(event);
      if (!auth.sub) return errorJson(401, 'Unauthorized');
      if (!hasPermission(auth, 'racepic.review')) return errorJson(403, 'Forbidden');
      try {
        const assignment = await rejectAssignment(decodeURIComponent(rejectAssignmentMatch[1]), auth.sub);
        const db = await getDb();
        await writeAuditLog(db, {
          actorUserId: auth.sub,
          action: 'racepic_assignment_reviewed',
          entityType: 'racepic_assignment',
          entityId: assignment.id,
          payload: { decision: 'rejected' }
        });
        return json(200, { ok: true });
      } catch (error) {
        if (error instanceof RacePicError) {
          const { status, message } = racePicErrorStatus(error);
          return errorJson(status, message, undefined, error.code);
        }
        throw error;
      }
    }

    const correctAssignmentMatch = path.match(/^\/admin\/racepic\/assignments\/([^/]+)\/correct$/);
    if (method === 'POST' && correctAssignmentMatch) {
      const auth = getAuthContext(event);
      if (!auth.sub) return errorJson(401, 'Unauthorized');
      if (!hasPermission(auth, 'racepic.review')) return errorJson(403, 'Forbidden');
      try {
        const input = correctAssignmentSchema.parse(parseJsonBody(event));
        const assignmentId = await correctAssignment(decodeURIComponent(correctAssignmentMatch[1]), input.entryId, auth.sub);
        const db = await getDb();
        await writeAuditLog(db, {
          actorUserId: auth.sub,
          action: 'racepic_assignment_reviewed',
          entityType: 'racepic_assignment',
          entityId: assignmentId,
          payload: { decision: 'corrected' }
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

    const addAssignmentMatch = path.match(/^\/admin\/racepic\/images\/([^/]+)\/assignments$/);
    if (method === 'POST' && addAssignmentMatch) {
      const auth = getAuthContext(event);
      if (!auth.sub) return errorJson(401, 'Unauthorized');
      if (!hasPermission(auth, 'racepic.review')) return errorJson(403, 'Forbidden');
      try {
        const input = addAssignmentSchema.parse(parseJsonBody(event));
        const created = await addAssignment(decodeURIComponent(addAssignmentMatch[1]), input.entryId, input.detectionId ?? null, auth.sub);
        const db = await getDb();
        await writeAuditLog(db, {
          actorUserId: auth.sub,
          action: 'racepic_assignment_reviewed',
          entityType: 'racepic_assignment',
          entityId: created.id,
          payload: { decision: 'added' }
        });
        return json(201, { ok: true });
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

    // "Wegklicken" einer Detection ohne Zuordnung (Nutzerwunsch 2026-09-23: manche Fahrzeuge sind
    // auch fuer einen Menschen nicht identifizierbar - das Bild soll trotzdem regulaer verfuegbar
    // bleiben, siehe reviewQueue.ts dismissDetection).
    const dismissDetectionMatch = path.match(/^\/admin\/racepic\/detections\/([^/]+)\/dismiss$/);
    if (method === 'POST' && dismissDetectionMatch) {
      const auth = getAuthContext(event);
      if (!auth.sub) return errorJson(401, 'Unauthorized');
      if (!hasPermission(auth, 'racepic.review')) return errorJson(403, 'Forbidden');
      try {
        await dismissDetection(decodeURIComponent(dismissDetectionMatch[1]), auth.sub);
        return json(200, { ok: true });
      } catch (error) {
        if (error instanceof RacePicError) {
          const { status, message } = racePicErrorStatus(error);
          return errorJson(status, message, undefined, error.code);
        }
        throw error;
      }
    }

    const entryImagesMatch = path.match(/^\/admin\/racepic\/participants\/([^/]+)\/images$/);
    if (method === 'GET' && entryImagesMatch) {
      const auth = getAuthContext(event);
      if (!auth.sub) return errorJson(401, 'Unauthorized');
      if (!hasPermission(auth, 'racepic.read')) return errorJson(403, 'Forbidden');
      const images = await listImagesForEntry(decodeURIComponent(entryImagesMatch[1]));
      return json(200, { ok: true, images });
    }

    // Paket 16 (Admin-Redesign): Gegenstueck zu obigem Endpunkt, nach imageId statt entryId.
    const imageAssignmentsMatch = path.match(/^\/admin\/racepic\/images\/([^/]+)\/assignments$/);
    if (method === 'GET' && imageAssignmentsMatch) {
      const auth = getAuthContext(event);
      if (!auth.sub) return errorJson(401, 'Unauthorized');
      if (!hasPermission(auth, 'racepic.read')) return errorJson(403, 'Forbidden');
      const assignments = await listAssignmentsForImage(decodeURIComponent(imageAssignmentsMatch[1]));
      return json(200, { ok: true, assignments });
    }

    // --- Admin: Teilnehmer ausblenden (Paket 9: Datenschutz) -----------------------------------
    const hideParticipantMatch = path.match(/^\/admin\/racepic\/participants\/([^/]+)\/hide$/);
    if (method === 'POST' && hideParticipantMatch) {
      const auth = getAuthContext(event);
      if (!auth.sub) return errorJson(401, 'Unauthorized');
      if (!hasPermission(auth, 'racepic.manage')) return errorJson(403, 'Forbidden');
      try {
        const entryId = decodeURIComponent(hideParticipantMatch[1]);
        const result = await hideParticipant(entryId, auth.sub);
        const db = await getDb();
        await writeAuditLog(db, {
          actorUserId: auth.sub,
          action: 'racepic_participant_hidden',
          entityType: 'entry',
          entityId: entryId,
          payload: { rejectedCount: result.rejectedCount }
        });
        return json(200, { ok: true, rejectedCount: result.rejectedCount });
      } catch (error) {
        if (error instanceof RacePicError) {
          const { status, message } = racePicErrorStatus(error);
          return errorJson(status, message, undefined, error.code);
        }
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
