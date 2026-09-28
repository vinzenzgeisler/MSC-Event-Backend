import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { z, ZodError } from 'zod';
import { writeAuditLog } from '../audit/log';
import { getDb, getPool } from '../db/client';
import { getAuthContext, hasPermission } from '../http/auth';
import { parseJsonBody } from '../http/parse';
import { buildPublicRateLimitKey, enforcePublicRateLimit } from '../http/publicRateLimit';
import { errorJson, json } from '../http/response';
import { isImagePubliclyEligible } from '../racepic/eligibility';
import { getCommerceFlags } from './flags';
import { PricingError } from './pricing';
import { createQuote, MAX_QUOTE_ITEMS, QuoteError, type QuoteDeps, type QuoteErrorCode } from './quote';
import { createSettingsVersion, listSettingsVersions, loadCurrentSettings, SettingsError } from './settings';

/**
 * HTTP-Schicht fuer Quote und Steuer-/Provisionseinstellungen (Commerce AP12).
 *
 *   POST /public/commerce/quotes                Bild-IDs -> serverseitig berechnete Quote (Flag commerceCheckout)
 *   GET  /admin/racepic/commerce-settings       aktuelle Einstellungen + Verlauf (racepic.manage)
 *   POST /admin/racepic/commerce-settings       neue Einstellungsversion mit expectedVersion (racepic.manage)
 *
 * Ohne Flag antworten die Routen mit 404. Ohne entschiedenen Steuersatz lehnt die Quote mit 503 ab.
 */

export type QuoteRouteDeps = { quoteDeps?: QuoteDeps };

const quoteErrorStatus = (code: QuoteErrorCode): { status: number; message: string } => {
  switch (code) {
    case 'QUOTE_EMPTY':
      return { status: 400, message: 'At least one image is required' };
    case 'QUOTE_TOO_LARGE':
      return { status: 400, message: `At most ${MAX_QUOTE_ITEMS} images per quote` };
    case 'QUOTE_NOTHING_AVAILABLE':
      return { status: 409, message: 'None of the requested images is available for purchase' };
    case 'QUOTE_TAX_NOT_CONFIGURED':
      return { status: 503, message: 'Purchasing is not available yet' };
  }
};

const quoteSchema = z.object({ imageIds: z.array(z.string().uuid()).min(1).max(MAX_QUOTE_ITEMS) });
const bp = (max: number) => z.number().int().min(0).max(max);
const settingsSchema = z.object({
  expectedVersion: z.number().int().min(1),
  saleTaxRateBp: bp(3000).nullable(),
  commissionBp: bp(10000),
  sellerShareBasis: z.enum(['NET', 'GROSS']),
  sellerVatRateBp: bp(3000).nullable(),
  artistSocialLevyBp: bp(1000),
  note: z.string().trim().min(1).max(500)
});

export const handleQuoteRoutes = async (
  event: APIGatewayProxyEventV2,
  deps: QuoteRouteDeps = {}
): Promise<APIGatewayProxyStructuredResultV2 | null> => {
  const method = event.requestContext.http.method;
  const path = event.requestContext.http.path;
  const isQuote = path === '/public/commerce/quotes';
  const isSettings = path === '/admin/racepic/commerce-settings';
  if (!isQuote && !isSettings) return null;

  try {
    if (isQuote) {
      if (!getCommerceFlags().commerceCheckout) return errorJson(404, 'Not Found', undefined, 'COMMERCE_DISABLED');
      if (method !== 'POST') return errorJson(405, 'Method Not Allowed');
      const forwardedFor = event.headers['x-forwarded-for'] ?? event.headers['X-Forwarded-For'];
      const clientIp = forwardedFor?.split(',')[0]?.trim() || event.requestContext.http.sourceIp?.trim() || 'unknown';
      const limited = await enforcePublicRateLimit({ scope: 'commerce-quote', key: buildPublicRateLimitKey([clientIp]), limit: 30, windowSeconds: 60 });
      if (!limited.allowed) {
        return errorJson(429, 'Too many requests', { scope: 'commerce-quote', limit: limited.limit }, 'RATE_LIMITED', undefined, {
          'retry-after': String(limited.retryAfterSeconds)
        });
      }
      const input = quoteSchema.parse(parseJsonBody(event));
      const quote = await createQuote(await getPool(), input.imageIds, deps.quoteDeps ?? { isImageEligible: (id) => isImagePubliclyEligible(id) });
      return json(201, { ok: true, quote });
    }

    // Einstellungen: Anmeldung und MFA prueft handler.ts fuer alle /admin/-Pfade.
    const auth = getAuthContext(event);
    if (!auth.sub) return errorJson(401, 'Unauthorized');
    if (!hasPermission(auth, 'racepic.manage')) return errorJson(403, 'Forbidden');
    const pool = await getPool();
    if (method === 'GET') {
      return json(200, { ok: true, current: await loadCurrentSettings(pool), history: await listSettingsVersions(pool) });
    }
    if (method === 'POST') {
      const input = settingsSchema.parse(parseJsonBody(event));
      const created = await createSettingsVersion(pool, { ...input, actor: auth.sub });
      await writeAuditLog(await getDb(), {
        actorUserId: auth.sub,
        action: 'commerce_settings_changed',
        entityType: 'commerce_settings_version',
        entityId: created.id,
        payload: {
          version: created.version,
          saleTaxRateBp: created.saleTaxRateBp,
          commissionBp: created.commissionBp,
          sellerShareBasis: created.sellerShareBasis,
          sellerVatRateBp: created.sellerVatRateBp,
          artistSocialLevyBp: created.artistSocialLevyBp
        }
      });
      return json(201, { ok: true, current: created });
    }
    return errorJson(405, 'Method Not Allowed');
  } catch (error) {
    if (error instanceof ZodError) return errorJson(400, 'Validation failed', { issues: error.issues });
    if (error instanceof Error && error.message === 'Invalid JSON body') return errorJson(400, 'Invalid JSON body');
    if (error instanceof QuoteError) {
      const { status, message } = quoteErrorStatus(error.code);
      return errorJson(status, message, undefined, error.code);
    }
    if (error instanceof SettingsError) {
      return error.code === 'SETTINGS_VERSION_CONFLICT'
        ? errorJson(409, 'Settings changed in the meantime; reload and try again', undefined, error.code)
        : errorJson(503, 'Commerce settings are missing', undefined, error.code);
    }
    if (error instanceof PricingError) return errorJson(400, 'Invalid settings', undefined, error.code);
    throw error;
  }
};
