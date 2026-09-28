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
