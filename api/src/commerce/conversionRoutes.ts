import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { z, ZodError } from 'zod';
import { getDb } from '../db/client';
import { writeAuditLog } from '../audit/log';
import { getAuthContext, hasPermission } from '../http/auth';
import { errorJson, json } from '../http/response';
import { parseJsonBody } from '../http/parse';
import { getCommerceFlags } from './flags';
import {
  approveConversion,
  ConversionError,
  finalizeConversion,
  getConversionForReview,
  getOwnConversion,
  listConversionsForReview,
  listOwnConversions,
  rejectConversion,
  requestConversion,
  type ConversionErrorCode
} from './conversion';

/**
 * HTTP-Schicht der FREE->PAID-Conversion (AP08/AP09). Alle Routen liegen hinter dem Flag
 * `commerceFreeToPaidConversion` (Default aus) und antworten dann mit 404.
 *
 * Photographer: POST/GET /photographer/offer-conversions[/{id}]
 * Admin (racepic.manage): GET /admin/racepic/offer-conversions[/{id}],
 *   POST /admin/racepic/offer-conversions/{id}/(approve|reject|finalize)
 * Schreibende Aufrufe verlangen den Header `Idempotency-Key`. Die Wirkung ist zustandsbasiert idempotent:
 * ein wiederholter Approve/Reject liefert dasselbe Ergebnis, ohne etwas zweimal anzuwenden.
 */

export type ConversionRouteDeps = {
  requireActivePhotographer: (
    event: APIGatewayProxyEventV2
  ) => Promise<{ ok: false; error: APIGatewayProxyStructuredResultV2 } | { ok: true; photographer: { id: string } }>;
};

const conversionErrorStatus = (code: ConversionErrorCode): { status: number; message: string } => {
  switch (code) {
    case 'CONVERSION_INVALID_PRICE':
      return { status: 400, message: 'Price must be one of the allowed price tiers' };
    case 'CONVERSION_INVALID_LICENSE':
      return { status: 400, message: 'License not found, inactive or not a paid license' };
    case 'CONVERSION_RIGHTS_NOT_CONFIRMED':
      return { status: 400, message: 'Rights and future payment obligation must be confirmed' };
    case 'CONVERSION_PHOTOGRAPHER_NOT_ELIGIBLE':
      return { status: 403, message: 'Photographer account is not eligible for paid offers' };
    case 'CONVERSION_IMAGE_NOT_ELIGIBLE':
      return { status: 409, message: 'One or more images cannot be converted' };
    case 'CONVERSION_IMAGE_ALREADY_PENDING':
      return { status: 409, message: 'One or more images already have an open conversion request' };
    case 'CONVERSION_IDEMPOTENCY_KEY_REUSED':
      return { status: 409, message: 'Idempotency-Key was already used with a different request' };
    case 'CONVERSION_NOT_FOUND':
      return { status: 404, message: 'Conversion request not found' };
    case 'CONVERSION_NOT_REVIEWABLE':
      return { status: 409, message: 'Conversion request is not in a reviewable state' };
    case 'CONVERSION_STALE':
      return { status: 409, message: 'Images or offers changed since the request; reject and request again' };
    case 'CONVERSION_NOT_APPROVED':
      return { status: 409, message: 'Conversion request is not approved' };
    case 'CONVERSION_QUEUE_UNAVAILABLE':
      return { status: 503, message: 'Asset preparation is temporarily unavailable; retry with the same Idempotency-Key' };
  }
};

const idempotencyKeySchema = z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);

const readIdempotencyKey = (event: APIGatewayProxyEventV2): string | null => {
  const raw = event.headers['idempotency-key'] ?? event.headers['Idempotency-Key'];
  const parsed = idempotencyKeySchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

const requestSchema = z.object({
  imageIds: z.array(z.string().uuid()).min(1).max(50),
  priceCents: z.number().int(),
  licenseId: z.string().uuid(),
  rightsConfirmed: z.literal(true)
});

const reviewSchema = z.object({ note: z.string().trim().min(1).max(1000) });

const UUID = '[0-9a-fA-F-]{36}';

export const handleConversionRoutes = async (
  event: APIGatewayProxyEventV2,
  deps: ConversionRouteDeps
): Promise<APIGatewayProxyStructuredResultV2 | null> => {
  const method = event.requestContext.http.method;
  const path = event.requestContext.http.path;

  const photographerRoute = path.match(new RegExp(`^/photographer/offer-conversions(?:/(${UUID}))?$`));
  const adminRoute = path.match(new RegExp(`^/admin/racepic/offer-conversions(?:/(${UUID})(?:/(approve|reject|finalize))?)?$`));
  if (!photographerRoute && !adminRoute) return null;

  if (!getCommerceFlags().commerceFreeToPaidConversion) return errorJson(404, 'Not Found', undefined, 'COMMERCE_DISABLED');

  try {
    if (photographerRoute) {
      const result = await deps.requireActivePhotographer(event);
      if (!result.ok) return result.error;
      const conversionId = photographerRoute[1];

      if (method === 'POST' && !conversionId) {
        const key = readIdempotencyKey(event);
        if (!key) return errorJson(400, 'Idempotency-Key header is required', undefined, 'IDEMPOTENCY_KEY_REQUIRED');
        const input = requestSchema.parse(parseJsonBody(event));
        const { conversion, created } = await requestConversion(result.photographer.id, {
          idempotencyKey: key,
          imageIds: input.imageIds,
          priceCents: input.priceCents,
          licenseId: input.licenseId,
          rightsConfirmed: input.rightsConfirmed
        });
        if (created) {
          await writeAuditLog(await getDb(), {
            actorUserId: `photographer:${result.photographer.id}`,
            action: 'racepic_offer_conversion_requested',
            entityType: 'racepic_offer_conversion',
            entityId: conversion.id,
            payload: { conversionId: conversion.id, imageCount: conversion.items.length, priceCents: conversion.priceCents }
          });
        }
        return json(created ? 201 : 200, { ok: true, conversion, created });
      }
      if (method === 'GET' && !conversionId) {
        return json(200, { ok: true, conversions: await listOwnConversions(result.photographer.id) });
      }
      if (method === 'GET' && conversionId) {
        return json(200, { ok: true, conversion: await getOwnConversion(result.photographer.id, conversionId) });
      }
      return errorJson(405, 'Method Not Allowed');
    }

    // Admin-Routen: Authentifizierung/MFA prueft handler.ts bereits fuer alle /admin/-Pfade.
    const auth = getAuthContext(event);
    if (!auth.sub) return errorJson(401, 'Unauthorized');
    if (!hasPermission(auth, 'racepic.manage')) return errorJson(403, 'Forbidden');
    const conversionId = adminRoute![1];
    const action = adminRoute![2];

    if (method === 'GET' && !conversionId) {
      const query = event.queryStringParameters ?? {};
      const status = query.status && /^[A-Z_]+$/.test(query.status) ? query.status : undefined;
      const limit = Math.min(Math.max(Number.parseInt(query.limit ?? '50', 10) || 50, 1), 100);
      const offset = Math.max(Number.parseInt(query.offset ?? '0', 10) || 0, 0);
      return json(200, { ok: true, conversions: await listConversionsForReview({ status, limit, offset }) });
    }
    if (method === 'GET' && conversionId && !action) {
      return json(200, { ok: true, conversion: await getConversionForReview(conversionId) });
    }
    if (method === 'POST' && conversionId && action) {
      if (!readIdempotencyKey(event)) return errorJson(400, 'Idempotency-Key header is required', undefined, 'IDEMPOTENCY_KEY_REQUIRED');
      if (action === 'finalize') {
        const result = await finalizeConversion(conversionId);
        return json(200, { ok: true, ...result });
      }
      const input = reviewSchema.parse(parseJsonBody(event));
      const review = { actor: auth.sub, note: input.note };
      if (action === 'approve') {
        const result = await approveConversion(conversionId, review);
        if (!result.alreadyApproved) {
          await writeAuditLog(await getDb(), {
            actorUserId: auth.sub, action: 'racepic_offer_conversion_approved', entityType: 'racepic_offer_conversion', entityId: conversionId,
            payload: { conversionId, imageCount: result.imageIds.length }
          });
        }
        return json(200, { ok: true, status: result.status, alreadyApproved: result.alreadyApproved });
      }
      const result = await rejectConversion(conversionId, review);
      if (!result.alreadyRejected) {
        await writeAuditLog(await getDb(), {
          actorUserId: auth.sub, action: 'racepic_offer_conversion_rejected', entityType: 'racepic_offer_conversion', entityId: conversionId,
          payload: { conversionId, imageCount: result.imageIds.length }
        });
      }
      return json(200, { ok: true, status: result.status, alreadyRejected: result.alreadyRejected });
    }
    return errorJson(405, 'Method Not Allowed');
  } catch (error) {
    if (error instanceof ZodError) return errorJson(400, 'Validation failed', { issues: error.issues });
    if (error instanceof Error && error.message === 'Invalid JSON body') return errorJson(400, 'Invalid JSON body');
    if (error instanceof ConversionError) {
      const { status, message } = conversionErrorStatus(error.code);
      return errorJson(status, message, undefined, error.code);
    }
    throw error;
  }
};
