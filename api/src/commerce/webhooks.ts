import type Stripe from 'stripe';
import { logOperationalEvent } from '../observability/logger';
import type { Queryable } from './offers';
import { syncPaymentAccountByProviderId, type StripeConnectApi } from './paymentAccount';
import type { WebhookEndpoint } from './stripe/client';

/**
 * Stripe-Webhook-Grundlage (Commerce AP16), siehe docs/memory-bank/racepic-marketplace-checkout-plan.md 3.2.
 *
 * Annahme: Signatur pruefen -> Rohnachricht in S3 -> Inbox-Zeile (Deduplizierung ueber Provider + Event-ID) ->
 * Queue -> schnelle 2xx-Antwort. Verarbeitung: Worker claimt die Zeile mit Lease, fuehrt den Handler aus und
 * markiert das Ergebnis. Handler sind zustandsbasiert idempotent; sie holen den aktuellen Stand bei Stripe,
 * statt der Nachricht zu trauen, damit doppelte, verzoegerte und vertauschte Ereignisse unschaedlich sind.
 * Fehlgeschlagene Eintraege werden von SQS wiederholt und landen nach 5 Versuchen in der DLQ (Alarm).
 * Bezahl- und Erstattungsereignisse folgen mit AP15/AP21; bis dahin werden unbekannte Typen als IGNORED verbucht.
 */

export type WebhookStore = {
  putPayload: (key: string, body: string) => Promise<void>;
  getPayload: (key: string) => Promise<string | null>;
};

export type WebhookQueue = { send: (inboxId: string) => Promise<void> };

export type WebhookDeps = {
  store: WebhookStore;
  queue: WebhookQueue;
  verify: (endpoint: WebhookEndpoint, rawBody: string, signature: string | undefined) => Promise<Stripe.Event>;
  stripe: () => Promise<StripeConnectApi>;
};

export const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;
const LEASE_SECONDS = 300;
const EVENT_ID_PATTERN = /^evt_[A-Za-z0-9_]{1,200}$/;

export const payloadKey = (endpoint: WebhookEndpoint, eventId: string): string => `commerce/webhooks/stripe/${endpoint}/${eventId}.json`;

export type ReceiveResult = { inboxId: string; duplicate: boolean };

export const receiveWebhook = async (
  tx: Queryable,
  deps: WebhookDeps,
  input: { endpoint: WebhookEndpoint; rawBody: string; signature: string | undefined }
): Promise<ReceiveResult> => {
  const event = await deps.verify(input.endpoint, input.rawBody, input.signature);
  // Die Event-ID wird Teil eines Speicherschluessels: nur das erwartete Format zulassen.
  if (!EVENT_ID_PATTERN.test(event.id)) throw new Error('STRIPE_WEBHOOK_EVENT_ID_INVALID');
  const key = payloadKey(input.endpoint, event.id);
  await deps.store.putPayload(key, input.rawBody);

  const inserted = await tx.query<{ id: string }>(
    `insert into commerce_webhook_inbox (provider, endpoint, event_id, event_type, payload_ref)
     values ('STRIPE', $1, $2, $3, $4)
     on conflict (provider, event_id) do nothing
     returning id`,
    [input.endpoint, event.id, event.type, key]
  );
  if (inserted.rows[0]) {
    await deps.queue.send(inserted.rows[0].id);
    return { inboxId: inserted.rows[0].id, duplicate: false };
  }
  const existing = (await tx.query<{ id: string; status: string }>(
    `select id, status from commerce_webhook_inbox where provider = 'STRIPE' and event_id = $1`,
    [event.id]
  )).rows[0];
  // Ein frueherer Versuch kann nach dem Speichern, aber vor dem Einreihen gescheitert sein (Stripe wiederholt dann):
  // offene Eintraege werden erneut eingereiht, abgeschlossene nicht.
  if (existing && (existing.status === 'RECEIVED' || existing.status === 'FAILED')) await deps.queue.send(existing.id);
  return { inboxId: existing?.id ?? '', duplicate: true };
};

export type WebhookHandlerResult = 'HANDLED' | 'IGNORED';
export type WebhookHandlerContext = { tx: Queryable; deps: WebhookDeps; endpoint: WebhookEndpoint };
export type WebhookHandler = (ctx: WebhookHandlerContext, event: Stripe.Event) => Promise<WebhookHandlerResult>;

const connectedAccountId = (event: Stripe.Event): string | null => {
  if (event.account) return event.account;
  const object = event.data.object as { object?: string; id?: string; account?: string };
  if (object.object === 'account') return object.id ?? null;
  return object.account ?? null;
};

const accountChanged: WebhookHandler = async ({ tx, deps }, event) => {
  const accountId = connectedAccountId(event);
  if (!accountId) return 'IGNORED';
  return (await syncPaymentAccountByProviderId(tx, await deps.stripe(), accountId)) ? 'HANDLED' : 'IGNORED';
};

/** Registrierung je Endpunkt und Ereignistyp; weitere Handler (Zahlung, Erstattung, Dispute ...) kommen mit ihren Arbeitspaketen. */
export const webhookHandlers: Record<string, WebhookHandler> = {
  'connect:account.updated': accountChanged,
  'connect:capability.updated': accountChanged
};

type InboxRow = { id: string; endpoint: WebhookEndpoint; event_id: string; event_type: string; payload_ref: string | null; attempt_count: number };

export type ProcessResult = 'processed' | 'ignored' | 'skipped';

/** Verarbeitet einen Inbox-Eintrag (SQS-Nachricht). Wirft bei Fehlern, damit SQS wiederholt; `skipped` = schon erledigt oder in Arbeit. */
export const processInboxEntry = async (tx: Queryable, deps: WebhookDeps, inboxId: string): Promise<ProcessResult> => {
  const claimed = (await tx.query<InboxRow>(
    `update commerce_webhook_inbox
        set status = 'PROCESSING', attempt_count = attempt_count + 1,
            lease_expires_at = now() + ($2 * interval '1 second'), last_error = null
      where id = $1
        and (status in ('RECEIVED', 'FAILED') or (status = 'PROCESSING' and lease_expires_at < now()))
      returning id, endpoint, event_id, event_type, payload_ref, attempt_count`,
    [inboxId, LEASE_SECONDS]
  )).rows[0];
  if (!claimed) return 'skipped';

  try {
    if (!claimed.payload_ref) throw new Error('WEBHOOK_PAYLOAD_REF_MISSING');
    const raw = await deps.store.getPayload(claimed.payload_ref);
    if (!raw) throw new Error('WEBHOOK_PAYLOAD_MISSING');
    const event = JSON.parse(raw) as Stripe.Event;
    if (event.id !== claimed.event_id) throw new Error('WEBHOOK_PAYLOAD_MISMATCH');
    const handler = webhookHandlers[`${claimed.endpoint}:${event.type}`];
    const result: WebhookHandlerResult = handler ? await handler({ tx, deps, endpoint: claimed.endpoint }, event) : 'IGNORED';
    await tx.query(
      `update commerce_webhook_inbox set status = $2, processed_at = now(), lease_expires_at = null, last_error = null where id = $1`,
      [claimed.id, result === 'HANDLED' ? 'PROCESSED' : 'IGNORED']
    );
    return result === 'HANDLED' ? 'processed' : 'ignored';
  } catch (error) {
    // Nur ein kurzer Fehlercode, nie die Nachricht selbst (kann personenbezogene Daten enthalten).
    const code = (error instanceof Error ? error.message : 'UNKNOWN').slice(0, 120);
    await tx.query(
      `update commerce_webhook_inbox set status = 'FAILED', lease_expires_at = null, last_error = $2 where id = $1`,
      [claimed.id, code]
    );
    logOperationalEvent('error', 'racepic_webhook.processing_failed', { errorCode: code.slice(0, 60) });
    throw error;
  }
};
