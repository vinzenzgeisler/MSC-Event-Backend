import { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { errorJson, json } from '../http/response';
import { getAuthContext, hasPermission } from '../http/auth';
import { errorCodeOf, logOperationalEvent } from '../observability/logger';
import { getPhotographerAuthContext } from './auth';

/**
 * RacePicApiHandler (Paket 1: Fundament). Eigenstaendiger Lambda-Handler fuer den `/photographer/*`-,
 * `/public/racepic/*`- und `/admin/racepic/*`-Namespace, registriert auf derselben HttpApi wie der
 * bestehende ApiHandler (siehe infra/lib/stacks/api-stack.ts und
 * docs/memory-bank/racepic-architecture.md Abschnitt B/H).
 *
 * Enthaelt bewusst nur Stub-Routen: die Fachlogik (Einladung/Claim, Upload, Review, KI-Pipeline)
 * kommt in den Paketen 2, 3, 6 und 7 (siehe docs/memory-bank/racepic-progress.md in diesem Repo).
 * Struktur und Response-Helfer folgen ../handler.ts, damit spaetere Routen sich nahtlos einfuegen.
 */
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

    if (method === 'GET' && path === '/photographer/me') {
      const auth = getPhotographerAuthContext(event);
      if (!auth.sub) {
        return errorJson(401, 'Unauthorized');
      }
      // Paket 2: racepic_photographer per cognito_sub laden und zurueckgeben. Bis dahin bewusst
      // 501, statt einen leeren/erfundenen Profil-Body vorzutaeuschen.
      return errorJson(501, 'Photographer profile lookup not implemented yet', undefined, 'NOT_IMPLEMENTED');
    }

    if (method === 'GET' && path === '/admin/racepic/ping') {
      const auth = getAuthContext(event);
      if (!auth.sub) {
        return errorJson(401, 'Unauthorized');
      }
      if (!hasPermission(auth, 'racepic.read')) {
        return errorJson(403, 'Forbidden');
      }
      return json(200, { ok: true, service: 'racepic-admin-api' });
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
