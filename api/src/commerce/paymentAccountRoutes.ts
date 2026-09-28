import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { getDb, getPool } from '../db/client';
import { writeAuditLog } from '../audit/log';
import { errorJson, json } from '../http/response';
import { getPhotographerAuthContext } from '../racepic/auth';
import { consumeStepUpGrant } from '../racepic/stepUp';
import { getCommerceFlags } from './flags';
import {
  createDashboardLink,
  createOnboardingLink,
  getPaymentAccountView,
  PaymentAccountError,
  refreshPaymentAccount,
  type PaymentAccountErrorCode,
  type StripeConnectApi
} from './paymentAccount';
import { getStripe } from './stripe/client';

/**
 * Zahlungskonto der Fotograf:innen (Commerce AP06).
 *
 *   GET  /photographer/payment-account[?refresh=true]     Status (mit refresh: Abgleich mit Stripe)
 *   POST /photographer/payment-account/onboarding-link    Stufe `strong` (Aktion PAYMENT_ACCOUNT)
 *   POST /photographer/payment-account/dashboard-link     Stufe `strong` (Aktion PAYMENT_ACCOUNT)
 *
 * Hinter dem Flag `commerceSettlement` (Default aus, sonst 404). Der `strong`-Grant wird atomar verbraucht,
 * bevor Stripe aufgerufen wird: ein Nachweis gilt fuer genau einen Link.
 */

export type PaymentAccountRouteDeps = {
  requireActivePhotographer: (
    event: APIGatewayProxyEventV2
  ) => Promise<{ ok: false; error: APIGatewayProxyStructuredResultV2 } | { ok: true; photographer: { id: string } }>;
  stripe?: () => Promise<StripeConnectApi>;
};

const paymentAccountErrorStatus = (code: PaymentAccountErrorCode): { status: number; message: string } => {
  switch (code) {
    case 'PHOTOGRAPHER_NOT_ELIGIBLE':
      return { status: 403, message: 'Photographer account is not eligible for payouts' };
    case 'SELLER_SUSPENDED':
      return { status: 403, message: 'Seller account is suspended' };
    case 'NO_ACCOUNT':
      return { status: 404, message: 'No payment account yet; start onboarding first' };
    case 'ONBOARDING_INCOMPLETE':
      return { status: 409, message: 'Finish the Stripe onboarding first' };
    case 'STRIPE_UNAVAILABLE':
      return { status: 502, message: 'Payment provider is temporarily unavailable' };
    case 'ONBOARDING_URLS_MISSING':
      return { status: 503, message: 'Onboarding return URLs are not configured' };
  }
};

const onboardingUrls = () => {
  const base = (process.env.RACEPIC_WEBSITE_BASE_URL ?? '').replace(/\/$/, '');
  if (!base) return { returnUrl: '', refreshUrl: '' };
  return {
    returnUrl: `${base}/racepic/studio?tab=payouts&onboarding=return`,
    refreshUrl: `${base}/racepic/studio?tab=payouts&onboarding=refresh`
  };
};

export const handlePaymentAccountRoutes = async (
  event: APIGatewayProxyEventV2,
  deps: PaymentAccountRouteDeps
): Promise<APIGatewayProxyStructuredResultV2 | null> => {
  const method = event.requestContext.http.method;
  const path = event.requestContext.http.path;
  if (!/^\/photographer\/payment-account(\/(onboarding|dashboard)-link)?$/.test(path)) return null;
  if (!getCommerceFlags().commerceSettlement) return errorJson(404, 'Not Found', undefined, 'COMMERCE_DISABLED');

  try {
    const result = await deps.requireActivePhotographer(event);
    if (!result.ok) return result.error;
    const photographerId = result.photographer.id;
    const pool = await getPool();
    const stripe = () => (deps.stripe ? deps.stripe() : (getStripe() as Promise<StripeConnectApi>));

    if (method === 'GET' && path === '/photographer/payment-account') {
      const refresh = event.queryStringParameters?.refresh === 'true';
      const view = refresh ? await refreshPaymentAccount(pool, await stripe(), photographerId) : await getPaymentAccountView(pool, photographerId);
      return json(200, { ok: true, paymentAccount: view });
    }

    if (method === 'POST' && (path.endsWith('/onboarding-link') || path.endsWith('/dashboard-link'))) {
      const auth = getPhotographerAuthContext(event);
      if (!(await consumeStepUpGrant(pool, photographerId, 'PAYMENT_ACCOUNT', auth.sessionRef))) {
        return errorJson(403, 'Passkey confirmation required', { level: 'strong', action: 'PAYMENT_ACCOUNT' }, 'STEP_UP_REQUIRED');
      }
      if (path.endsWith('/onboarding-link')) {
        const link = await createOnboardingLink(pool, await stripe(), photographerId, onboardingUrls());
        await writeAuditLog(await getDb(), {
          actorUserId: `photographer:${photographerId}`, action: 'racepic_payment_account_onboarding_started', entityType: 'racepic_photographer', entityId: photographerId, payload: {}
        });
        return json(200, { ok: true, url: link.url, expiresAt: link.expiresAt });
      }
      const link = await createDashboardLink(pool, await stripe(), photographerId);
      await writeAuditLog(await getDb(), {
        actorUserId: `photographer:${photographerId}`, action: 'racepic_payment_account_dashboard_opened', entityType: 'racepic_photographer', entityId: photographerId, payload: {}
      });
      return json(200, { ok: true, url: link.url });
    }

    return errorJson(405, 'Method Not Allowed');
  } catch (error) {
    if (error instanceof PaymentAccountError) {
      const { status, message } = paymentAccountErrorStatus(error.code);
      return errorJson(status, message, undefined, error.code);
    }
    throw error;
  }
};
