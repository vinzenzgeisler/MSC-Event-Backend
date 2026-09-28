import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import Stripe from 'stripe';

/**
 * Gekapselter Stripe-Adapter (AP01). Einziger Ort, der das `stripe`-Paket importiert.
 *
 * - Die API-Version ist an die exakt gepinnte Paketversion gekoppelt (`api/package.json`); ein
 *   Versionssprung ist ein bewusster Schritt mit Review.
 * - Secrets liegen in AWS Secrets Manager (`STRIPE_SECRET_ARN`, JSON mit `secretKey`,
 *   `platformWebhookSecret`, `connectWebhookSecret`), nie in Umgebungsvariablen oder Logs.
 * - Der Adapter wird erst von spaeteren Arbeitspaketen (Connect, Checkout, Webhooks) benutzt und ist
 *   ohne gesetztes `STRIPE_SECRET_ARN` nicht nutzbar (wirft), statt still zu scheitern.
 */
export type StripeSecrets = {
  secretKey: string;
  platformWebhookSecret: string;
  connectWebhookSecret: string;
};

let cachedSecrets: StripeSecrets | null = null;
let cachedClient: Stripe | null = null;

export class StripeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StripeConfigError';
  }
}

export const parseStripeSecrets = (raw: string): StripeSecrets => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new StripeConfigError('Stripe-Secret ist kein gueltiges JSON.');
  }
  const value = parsed as Partial<Record<keyof StripeSecrets, unknown>>;
  const secretKey = typeof value.secretKey === 'string' ? value.secretKey.trim() : '';
  const platformWebhookSecret = typeof value.platformWebhookSecret === 'string' ? value.platformWebhookSecret.trim() : '';
  const connectWebhookSecret = typeof value.connectWebhookSecret === 'string' ? value.connectWebhookSecret.trim() : '';
  if (!secretKey || !platformWebhookSecret || !connectWebhookSecret) {
    throw new StripeConfigError('Stripe-Secret unvollstaendig (secretKey, platformWebhookSecret, connectWebhookSecret).');
  }
  return { secretKey, platformWebhookSecret, connectWebhookSecret };
};

export const loadStripeSecrets = async (): Promise<StripeSecrets> => {
  if (cachedSecrets) {
    return cachedSecrets;
  }
  const arn = (process.env.STRIPE_SECRET_ARN ?? '').trim();
  if (!arn) {
    throw new StripeConfigError('STRIPE_SECRET_ARN ist nicht gesetzt.');
  }
  const response = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: arn }));
  if (!response.SecretString) {
    throw new StripeConfigError('Stripe-Secret ist leer.');
  }
  cachedSecrets = parseStripeSecrets(response.SecretString);
  return cachedSecrets;
};

export const getStripe = async (): Promise<Stripe> => {
  if (cachedClient) {
    return cachedClient;
  }
  const secrets = await loadStripeSecrets();
  cachedClient = new Stripe(secrets.secretKey, {
    // Keine explizite apiVersion: das Paket nutzt seine gepinnte Version, siehe Kommentar oben.
    maxNetworkRetries: 2,
    timeout: 20_000,
    appInfo: { name: 'msc-event-backend-racepic-commerce' }
  });
  return cachedClient;
};

/** Nur fuer Tests. */
export const resetStripeCacheForTests = () => {
  cachedSecrets = null;
  cachedClient = null;
};

export type WebhookEndpoint = 'platform' | 'connect';

export class StripeWebhookError extends Error {
  constructor(public readonly code: 'SIGNATURE_MISSING' | 'SIGNATURE_INVALID') {
    super(`STRIPE_WEBHOOK_${code}`);
    this.name = 'StripeWebhookError';
  }
}

/**
 * Prueft Signatur und Zeitstempel einer Stripe-Webhook-Nachricht gegen den Secret des jeweiligen Endpunkts
 * (Plattform und Connect haben getrennte Secrets). `rawBody` muss exakt der empfangene Body sein - ein
 * geparster und neu serialisierter Body wuerde die Signatur brechen. Wirft `StripeWebhookError` ohne Details.
 */
export const verifyStripeWebhook = async (endpoint: WebhookEndpoint, rawBody: string, signature: string | undefined): Promise<Stripe.Event> => {
  if (!signature) throw new StripeWebhookError('SIGNATURE_MISSING');
  const secrets = await loadStripeSecrets();
  const secret = endpoint === 'platform' ? secrets.platformWebhookSecret : secrets.connectWebhookSecret;
  try {
    return Stripe.webhooks.constructEvent(rawBody, signature, secret);
  } catch {
    throw new StripeWebhookError('SIGNATURE_INVALID');
  }
};
