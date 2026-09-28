import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { z, ZodError } from 'zod';
import { getPool } from '../db/client';
import { buildPublicRateLimitKey, enforcePublicRateLimit } from '../http/publicRateLimit';
import { errorJson, json } from '../http/response';
import { getStripe } from './stripe/client';
import { getCommerceFlags } from './flags';
import { presignGetObject } from '../racepic/s3';
import { conversionArtifactKeys } from './objectKeys';
import { createCheckoutSession, getOrderConfirmation, CheckoutError, type CheckoutErrorCode, type StripeCheckoutApi } from './checkout';

/**
 * Checkout-Session und Kaeuferbestaetigung (Commerce AP15).
 *
 *   POST /public/commerce/checkout-sessions   Quote -> Bestellung + Stripe Hosted Checkout URL
 *   GET  /public/commerce/orders/{orderId}    Status nach der Rueckkehr von Stripe (Nachweis: sessionId)
 *
 * Beide hinter dem Flag `commerceCheckout` (sonst 404). Die Erfuellung (PAID setzen, Entitlements anlegen)
 * passiert ausschliesslich im Webhook (`webhooks.ts`), nie hier.
 */

export type CheckoutRouteDeps = { stripe?: () => Promise<StripeCheckoutApi>; websiteBaseUrl?: string };

const checkoutErrorStatus = (code: CheckoutErrorCode): { status: number; message: string } => {
  switch (code) {
    case 'QUOTE_NOT_FOUND':
      return { status: 404, message: 'Quote not found' };
    case 'QUOTE_EXPIRED_OR_USED':
      return { status: 410, message: 'Quote has expired or was already used' };
    case 'CHECKOUT_URLS_MISSING':
      return { status: 503, message: 'Checkout is not configured yet' };
    case 'STRIPE_UNAVAILABLE':
      return { status: 502, message: 'Payment provider is temporarily unavailable' };
    case 'ORDER_NOT_FOUND':
      return { status: 404, message: 'Order not found' };
    case 'ORDER_ACCESS_DENIED':
      return { status: 403, message: 'Session id does not match this order' };
  }
};

const legalSchema = z.object({
  terms: z.literal(true),
  license: z.literal(true),
  privacy: z.literal(true),
  withdrawal: z.literal(true),
  digitalContentWaiver: z.literal(true)
});
const checkoutSchema = z.object({ quoteId: z.string().uuid(), email: z.string().trim().email().max(320), legalAcceptance: legalSchema });

const websiteBase = (override?: string): string => (override ?? process.env.RACEPIC_WEBSITE_BASE_URL ?? '').replace(/\/$/, '');

export const handleCheckoutRoutes = async (
  event: APIGatewayProxyEventV2,
  deps: CheckoutRouteDeps = {}
): Promise<APIGatewayProxyStructuredResultV2 | null> => {
  const method = event.requestContext.http.method;
  const path = event.requestContext.http.path;
  const orderMatch = path.match(/^\/public\/commerce\/orders\/([0-9a-fA-F-]{36})$/);
  const isCheckoutCreate = path === '/public/commerce/checkout-sessions';
  if (!isCheckoutCreate && !orderMatch) return null;
  if (!getCommerceFlags().commerceCheckout) return errorJson(404, 'Not Found', undefined, 'COMMERCE_DISABLED');

  const forwardedFor = event.headers['x-forwarded-for'] ?? event.headers['X-Forwarded-For'];
  const clientIp = forwardedFor?.split(',')[0]?.trim() || event.requestContext.http.sourceIp?.trim() || 'unknown';

  try {
    if (isCheckoutCreate) {
      if (method !== 'POST') return errorJson(405, 'Method Not Allowed');
      const limited = await enforcePublicRateLimit({ scope: 'commerce-checkout', key: buildPublicRateLimitKey([clientIp]), limit: 10, windowSeconds: 60 });
      if (!limited.allowed) {
        return errorJson(429, 'Too many requests', { scope: 'commerce-checkout' }, 'RATE_LIMITED', undefined, { 'retry-after': String(limited.retryAfterSeconds) });
      }
      const input = checkoutSchema.parse(JSON.parse(event.body || '{}'));
      const base = websiteBase(deps.websiteBaseUrl);
      if (!base) return errorJson(503, 'Checkout is not configured yet', undefined, 'CHECKOUT_URLS_MISSING');
      const stripe = deps.stripe ? await deps.stripe() : ((await getStripe()) as unknown as StripeCheckoutApi);
      const result = await createCheckoutSession(await getPool(), stripe, {
        quoteId: input.quoteId,
        email: input.email,
        legalAcceptance: input.legalAcceptance,
        websiteBaseUrl: base
      });
      return json(201, { ok: true, orderId: result.orderId, url: result.url });
    }

    // GET /public/commerce/orders/{orderId}?sessionId=...
    if (method !== 'GET') return errorJson(405, 'Method Not Allowed');
    const limited = await enforcePublicRateLimit({ scope: 'commerce-order-status', key: buildPublicRateLimitKey([clientIp, orderMatch![1]]), limit: 30, windowSeconds: 60 });
    if (!limited.allowed) {
      return errorJson(429, 'Too many requests', { scope: 'commerce-order-status' }, 'RATE_LIMITED', undefined, { 'retry-after': String(limited.retryAfterSeconds) });
    }
    const sessionId = event.queryStringParameters?.sessionId ?? '';
    if (!sessionId) return errorJson(400, 'sessionId is required');
    const confirmation = await getOrderConfirmation(await getPool(), orderMatch![1], sessionId, {
      presignLicensedFull: async (imageId, offerVersionId) => presignGetObject(conversionArtifactKeys(imageId, offerVersionId).licensedFull, 300)
    });
    return json(200, { ok: true, order: confirmation });
  } catch (error) {
    if (error instanceof ZodError) return errorJson(400, 'Validation failed', { issues: error.issues });
    if (error instanceof SyntaxError) return errorJson(400, 'Invalid JSON body');
    if (error instanceof CheckoutError) {
      const { status, message } = checkoutErrorStatus(error.code);
      return errorJson(status, message, undefined, error.code);
    }
    throw error;
  }
};
