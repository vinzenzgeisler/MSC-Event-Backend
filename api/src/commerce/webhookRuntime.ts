import { sendCommerceWebhookMessage } from '../racepic/queues';
import { getObject, putObject } from '../racepic/s3';
import type { StripeConnectApi } from './paymentAccount';
import { getStripe, verifyStripeWebhook } from './stripe/client';
import type { WebhookDeps } from './webhooks';

/** Betriebs-Abhaengigkeiten der Webhook-Verarbeitung (S3, SQS, Stripe); in Tests durch Fakes ersetzt. */
export const createRuntimeWebhookDeps = (): WebhookDeps => ({
  store: {
    putPayload: (key, body) => putObject(key, Buffer.from(body, 'utf8'), 'application/json'),
    getPayload: async (key) => {
      const buffer = await getObject(key);
      return buffer ? buffer.toString('utf8') : null;
    }
  },
  queue: { send: sendCommerceWebhookMessage },
  verify: verifyStripeWebhook,
  stripe: () => getStripe() as Promise<StripeConnectApi>
});
