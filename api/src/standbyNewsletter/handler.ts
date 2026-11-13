import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ZodError } from 'zod';
import { getAuthContext, hasPermission } from '../http/auth';
import {
  getNewsletterConfig, validateNewsletterEmailRequest, validateNewsletterListQuery,
  validateNewsletterSignup, validateNewsletterToken
} from '../routes/newsletterContract';
import {
  adminResend, adminUnsubscribe, confirm, consumeRateLimit,
  listSubscribers, requestSignup, requestUnsubscribe, unsubscribe
} from './store';

const respond = (event: APIGatewayProxyEventV2, statusCode: number, body: Record<string, unknown>): APIGatewayProxyStructuredResultV2 => {
  const allowed = (process.env.NEWSLETTER_ALLOWED_ORIGINS ?? 'https://www.msc-oberlausitz.de')
    .split(',').map((origin) => origin.trim());
  const origin = event.headers.origin;
  return { statusCode, headers: {
    'content-type': 'application/json', 'cache-control': 'no-store',
    vary: 'Origin',
    ...(origin && allowed.includes(origin) ? { 'access-control-allow-origin': origin } : {})
  }, body: JSON.stringify(body) };
};
const parseBody = (event: APIGatewayProxyEventV2): unknown => JSON.parse(event.body ?? '{}');
const sourceIp = (event: APIGatewayProxyEventV2) => event.requestContext.http.sourceIp || 'unknown';
const rate = async (event: APIGatewayProxyEventV2, scope: string, limit: number, windowSeconds: number, email?: string) =>
  (await consumeRateLimit(scope, sourceIp(event), limit, windowSeconds)) &&
  (!email || await consumeRateLimit(`${scope}:email`, email.trim().toLowerCase(), limit, windowSeconds));

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> => {
  const path = event.rawPath || event.requestContext.http.path;
  const method = event.requestContext.http.method;
  if (method === 'OPTIONS') return respond(event, 204, {});
  try {
    if (method === 'POST' && process.env.NEWSLETTER_WRITE_ENABLED !== 'true') {
      return respond(event, 503, { ok: false, code: 'NEWSLETTER_STANDBY_NOT_ACTIVE' });
    }
    if (method === 'GET' && path === '/public/newsletter/config') {
      const config = getNewsletterConfig(event.queryStringParameters?.locale);
      return respond(event, 200, { ...config,
        enabled: config.enabled && process.env.NEWSLETTER_WRITE_ENABLED === 'true' });
    }
    if (method === 'POST' && path === '/public/newsletter/subscriptions') {
      const input = validateNewsletterSignup(parseBody(event));
      if (!await rate(event, 'newsletter_signup', 8, 900, input.email)) return respond(event, 429, { ok: false, code: 'RATE_LIMITED' });
      if (!input.website) await requestSignup(input.email, input.locale);
      return respond(event, 202, { accepted: true });
    }
    if (method === 'POST' && path === '/public/newsletter/confirm') {
      if (!await rate(event, 'newsletter_confirm', 30, 600)) return respond(event, 429, { ok: false, code: 'RATE_LIMITED' });
      const input = validateNewsletterToken(parseBody(event));
      return respond(event, 200, await confirm(input.token));
    }
    if (method === 'POST' && path === '/public/newsletter/unsubscribe-request') {
      const input = validateNewsletterEmailRequest(parseBody(event));
      if (!await rate(event, 'newsletter_unsubscribe_request', 6, 3600, input.email)) return respond(event, 429, { ok: false, code: 'RATE_LIMITED' });
      if (!input.website) await requestUnsubscribe(input.email);
      return respond(event, 202, { accepted: true });
    }
    if (method === 'POST' && path === '/public/newsletter/unsubscribe') {
      if (!await rate(event, 'newsletter_unsubscribe', 30, 600)) return respond(event, 429, { ok: false, code: 'RATE_LIMITED' });
      const input = validateNewsletterToken(parseBody(event));
      return respond(event, 200, await unsubscribe(input.token));
    }
    if (path.startsWith('/admin/newsletter/')) {
      const auth = getAuthContext(event);
      if (!auth.sub) return respond(event, 401, { ok: false, code: 'UNAUTHORIZED' });
      const permission = method === 'GET' ? 'newsletter.read' : 'newsletter.write';
      if (!hasPermission(auth, permission)) return respond(event, 403, { ok: false, code: 'FORBIDDEN' });
      if (method === 'GET' && path === '/admin/newsletter/overview') {
        const subscribers = await listSubscribers();
        return respond(event, 200, { ok: true, overview: {
          total: subscribers.length,
          active: subscribers.filter((item) => item.status === 'active').length,
          pending: subscribers.filter((item) => item.status === 'pending').length,
          unsubscribed: subscribers.filter((item) => item.status === 'unsubscribed').length,
          suppressed: subscribers.filter((item) => item.status === 'bounced' || item.status === 'complained').length
        } });
      }
      if (method === 'GET' && path === '/admin/newsletter/subscribers') {
        const query = validateNewsletterListQuery(event.queryStringParameters ?? {});
        const items = (await listSubscribers())
          .filter((item) => (!query.status || item.status === query.status) &&
            (!query.locale || item.locale === query.locale) &&
            (!query.search || item.emailNorm.includes(query.search.toLowerCase())))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return respond(event, 200, { ok: true,
          items: items.slice((query.page - 1) * query.pageSize, query.page * query.pageSize)
            .map((item) => ({ id: item.id, email: item.email, locale: item.locale,
              status: item.status, createdAt: item.createdAt, confirmedAt: item.confirmedAt,
              unsubscribedAt: item.unsubscribedAt, verificationSentAt: item.verificationSentAt })),
          page: query.page, pageSize: query.pageSize, total: items.length });
      }
      const unsubscribeMatch = path.match(/^\/admin\/newsletter\/subscribers\/([^/]+)\/unsubscribe$/);
      if (method === 'POST' && unsubscribeMatch) {
        const changed = await adminUnsubscribe(decodeURIComponent(unsubscribeMatch[1]), auth.sub);
        return respond(event, changed ? 200 : 404, changed ? { ok: true } : { ok: false, code: 'NOT_FOUND' });
      }
      const resendMatch = path.match(/^\/admin\/newsletter\/subscribers\/([^/]+)\/resend-verification$/);
      if (method === 'POST' && resendMatch) {
        const changed = await adminResend(decodeURIComponent(resendMatch[1]), auth.sub);
        return respond(event, changed ? 200 : 404, changed ? { ok: true } : { ok: false, code: 'NOT_FOUND' });
      }
    }
    return respond(event, 404, { ok: false, code: 'NOT_FOUND' });
  } catch (error) {
    if (error instanceof ZodError || error instanceof SyntaxError) return respond(event, 400, { ok: false, code: 'VALIDATION_ERROR' });
    console.error('newsletter_request_failed', { path, method, errorName: error instanceof Error ? error.name : 'unknown' });
    return respond(event, 500, { ok: false, code: 'INTERNAL_ERROR' });
  }
};
