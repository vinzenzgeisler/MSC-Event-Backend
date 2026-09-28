import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { getPool } from '../db/client';
import { errorJson, json } from '../http/response';
import { logOperationalEvent } from '../observability/logger';
import { getCommerceFlags } from './flags';
import { StripeWebhookError, type WebhookEndpoint } from './stripe/client';
import { createRuntimeWebhookDeps } from './webhookRuntime';
import { MAX_WEBHOOK_BODY_BYTES, receiveWebhook, type WebhookDeps } from './webhooks';

/**
 * Stripe-Webhook-Endpunkte (Commerce AP16): `POST /webhooks/stripe/platform` und `/webhooks/stripe/connect`.
 * Getrennte Endpunkte mit getrennten Signatur-Secrets. Es gibt keine Anmeldung; die Signatur ist die
 * Authentifizierung. Ungueltige oder fehlende Signatur -> 400 ohne Details. Alles andere Angenommene -> 200.
 * Sind weder `commerceCheckout` noch `commerceSettlement` an, antworten die Routen mit 404.
 */

export type WebhookRouteDeps = { webhookDeps?: WebhookDeps };

const rawBodyOf = (event: APIGatewayProxyEventV2): string => {
  if (!event.body) return '';
  // Signatur wird ueber die exakten Bytes berechnet: Base64-Bodies (API Gateway bei Binaerinhalt) zurueckwandeln, nie neu serialisieren.
  return event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
};

export const handleWebhookRoutes = async (
  event: APIGatewayProxyEventV2,
  deps: WebhookRouteDeps = {}
): Promise<APIGatewayProxyStructuredResultV2 | null> => {
  const match = event.requestContext.http.path.match(/^\/webhooks\/stripe\/(platform|connect)$/);
  if (!match) return null;
  const flags = getCommerceFlags();
  if (!flags.commerceCheckout && !flags.commerceSettlement) return errorJson(404, 'Not Found', undefined, 'COMMERCE_DISABLED');
  if (event.requestContext.http.method !== 'POST') return errorJson(405, 'Method Not Allowed');

  const endpoint = match[1] as WebhookEndpoint;
  const rawBody = rawBodyOf(event);
  if (Buffer.byteLength(rawBody, 'utf8') > MAX_WEBHOOK_BODY_BYTES) return errorJson(413, 'Payload too large');
  const signature = event.headers['stripe-signature'] ?? event.headers['Stripe-Signature'];

  try {
    const result = await receiveWebhook(await getPool(), deps.webhookDeps ?? createRuntimeWebhookDeps(), { endpoint, rawBody, signature });
    return json(200, { received: true, duplicate: result.duplicate });
  } catch (error) {
    if (error instanceof StripeWebhookError) {
      logOperationalEvent('warn', 'racepic_webhook.signature_failed', { route: `stripe/${endpoint}`, errorCode: error.code });
      return errorJson(400, 'Invalid signature', undefined, 'WEBHOOK_SIGNATURE_INVALID');
    }
    // Sonstige Fehler (S3, Queue, Datenbank): 500, damit Stripe die Zustellung wiederholt.
    logOperationalEvent('error', 'racepic_webhook.receive_failed', { route: `stripe/${endpoint}` });
    throw error;
  }
};
