import type Stripe from 'stripe';
import { logOperationalEvent } from '../observability/logger';
import { withTransaction, type Queryable } from './offers';
import type { QuoteItemSnapshot } from './quote';
import { LEGAL_DOCUMENT_VERSIONS, isLegalDocumentsApproved } from './legal';

/**
 * Checkout-Session (Commerce AP15): fuehrt eine gueltige Quote in eine unveraenderliche Bestellung ueber und
 * erzeugt eine Stripe Hosted Checkout Session auf dem Plattformkonto (Separate Charges and Transfers: keine
 * verbundenen Konten in der Zahlung selbst, Ausschuettung folgt erst beim taeglichen Settlement, AP19).
 *
 * Eine Quote wird atomar genau einmal verbraucht (`commerce_quote.consumed_at`). Bestellung, Positionen und
 * Rechtsnachweis werden in einer Transaktion angelegt und erst danach die Stripe-Session erzeugt; schlaegt der
 * Stripe-Aufruf fehl, bleibt die Bestellung als abgebrochene PENDING-Zeile stehen (kein Datenverlust, aber auch
 * kein automatischer Retry - eine neue Quote/neuer Checkout-Versuch ist der vorgesehene Weg).
 */

export type LegalAcceptance = { terms: true; license: true; privacy: true; withdrawal: true; digitalContentWaiver: true };

export type CheckoutErrorCode =
  | 'QUOTE_NOT_FOUND'
  | 'QUOTE_EXPIRED_OR_USED'
  | 'CHECKOUT_URLS_MISSING'
  | 'STRIPE_UNAVAILABLE'
  | 'ORDER_NOT_FOUND'
  | 'ORDER_ACCESS_DENIED';

export class CheckoutError extends Error {
  constructor(public readonly code: CheckoutErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'CheckoutError';
  }
}

export type StripeCheckoutApi = Pick<Stripe, 'checkout'>;

type QuoteRow = { id: string; email_norm: string | null; items: QuoteItemSnapshot[]; gross_cents: number; net_cents: number; tax_cents: number };

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

export type CreateCheckoutSessionInput = {
  quoteId: string;
  email: string;
  legalAcceptance: LegalAcceptance;
  /** Basis-URL der Website, ohne Pfad/Slash am Ende (z. B. `https://www.msc-oberlausitz.de`). */
  websiteBaseUrl: string;
};

const createOrderFromQuote = async (
  tx: Queryable,
  input: CreateCheckoutSessionInput
): Promise<{ orderId: string; grossCents: number; items: QuoteItemSnapshot[] }> => {
  const claimed = await tx.query<QuoteRow>(
    `update commerce_quote set consumed_at = now()
      where id = $1 and consumed_at is null and expires_at > now()
      returning id, email_norm, items, gross_cents, net_cents, tax_cents`,
    [input.quoteId]
  );
  if (!claimed.rows[0]) throw new CheckoutError('QUOTE_NOT_FOUND');
  const quote = claimed.rows[0];
  const emailNorm = normalizeEmail(input.email);

  const order = await tx.query<{ id: string }>(
    `insert into commerce_order (quote_id, email_norm, status, currency, gross_cents, net_cents, tax_cents, legal_snapshot)
     values ($1, $2, 'PENDING', 'EUR', $3, $4, $5, $6::jsonb) returning id`,
    [quote.id, emailNorm, quote.gross_cents, quote.net_cents, quote.tax_cents, JSON.stringify(LEGAL_DOCUMENT_VERSIONS)]
  );
  const orderId = order.rows[0].id;

  for (const item of quote.items) {
    await tx.query(
      `insert into commerce_order_item
         (order_id, product_id, offer_version_id, seller_id, gross_cents, net_cents, tax_cents, commission_cents,
          seller_share_cents, license_snapshot, seller_share_basis, tax_rate_bp)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12)`,
      [
        orderId, item.productId, item.offerVersionId, item.sellerId, item.grossCents, item.netCents, item.taxCents,
        item.commissionCents, item.sellerShareCents, JSON.stringify(item.license), item.sellerShareBasis, item.taxRateBp
      ]
    );
  }

  await tx.query(
    `insert into commerce_legal_acceptance (order_id, email_norm, document_versions)
     values ($1, $2, $3::jsonb)`,
    [orderId, emailNorm, JSON.stringify(input.legalAcceptance)]
  );

  return { orderId, grossCents: quote.gross_cents, items: quote.items };
};

export const createCheckoutSession = async (
  pool: import('pg').Pool,
  stripe: StripeCheckoutApi,
  input: CreateCheckoutSessionInput
): Promise<{ orderId: string; url: string }> => {
  if (!input.websiteBaseUrl) throw new CheckoutError('CHECKOUT_URLS_MISSING');
  if (!isLegalDocumentsApproved()) {
    // AP00 ist noch nicht freigegeben: Checkout laeuft weiter (Testmodus, Stripe-Sandbox), aber jede Bestellung
    // wird sichtbar markiert, damit ein spaeterer echter Verkauf nie mit einem Entwurfstext verwechselt wird.
    logOperationalEvent('warn', 'racepic_checkout.legal_documents_not_approved', {});
  }
  const { orderId, grossCents, items } = await withTransaction(pool, (tx) => createOrderFromQuote(tx, input));

  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.create(
      {
        mode: 'payment',
        customer_email: normalizeEmail(input.email),
        client_reference_id: orderId,
        // Die Order-ID ist erst nach dem DB-Insert oben bekannt, deshalb wird die success_url hier gebaut statt
        // vom Aufrufer fertig uebergeben zu werden. Der Platzhalter wird von Stripe selbst ersetzt.
        success_url: `${input.websiteBaseUrl}/racepic/kauf/erfolg?order=${orderId}&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${input.websiteBaseUrl}/racepic/kauf/abgebrochen?order=${orderId}`,
        metadata: { commerce_order_id: orderId },
        payment_intent_data: { metadata: { commerce_order_id: orderId } },
        line_items: items.map((item) => ({
          quantity: 1,
          price_data: {
            currency: 'eur',
            unit_amount: item.grossCents,
            product_data: { name: `RacePic Bildlizenz (${item.license.code})`, metadata: { racepic_image_id: item.imageId } }
          }
        }))
      },
      { idempotencyKey: `racepic-checkout-${orderId}` }
    );
  } catch (error) {
    // Nie die Original-Fehlermeldung nach aussen reichen: sie kann Stripe-interne Details oder Secrets enthalten.
    logOperationalEvent('error', 'racepic_checkout.session_create_failed', {});
    throw new CheckoutError('STRIPE_UNAVAILABLE');
  }

  await pool.query(
    `insert into commerce_payment (order_id, provider_checkout_session_id, status, amount_cents)
     values ($1, $2, 'PENDING', $3)`,
    [orderId, session.id, grossCents]
  );

  if (!session.url) throw new CheckoutError('STRIPE_UNAVAILABLE', 'Stripe returned no session url');
  return { orderId, url: session.url };
};

// --- Kaeuferbestaetigung nach der Rueckkehr von Stripe ---------------------------------------------------------

export type OrderConfirmationItem = {
  imageId: string;
  title: string | null;
  priceCents: number;
  downloadUrl: string;
  attribution: { photographerName: string; copyrightLine: string | null; licenseCode: string; licenseTitle: unknown; attributionRequired: boolean; attributionTemplate: string | null };
};

export type OrderConfirmation = { status: 'PENDING' | 'PAID' | 'FAILED'; items: OrderConfirmationItem[] };

type OrderItemRow = {
  order_item_id: string;
  offer_version_id: string;
  racepic_image_id: string;
  image_title: string | null;
  gross_cents: number;
  photographer_name: string;
  copyright_line: string | null;
  license_code: string;
  license_title: unknown;
  attribution_required: boolean;
  attribution_template: string | null;
};

export type ConfirmationDeps = { presignLicensedFull: (imageId: string, offerVersionId: string) => Promise<string> };

/**
 * Liest den Bestellstatus fuer die Erfolgsseite. `checkoutSessionId` ist der Nachweis: nur wer den genauen,
 * von Stripe selbst zurueckgegebenen Sitzungs-Identifikator kennt, sieht die Bestellung (kein Login noetig, siehe
 * Marketplace-Plan Abschnitt 4 "Gastkauf bleibt der Standard").
 */
export const getOrderConfirmation = async (
  tx: Queryable,
  orderId: string,
  checkoutSessionId: string,
  deps: ConfirmationDeps
): Promise<OrderConfirmation> => {
  const payment = (await tx.query<{ status: string; provider_checkout_session_id: string | null }>(
    'select status, provider_checkout_session_id from commerce_payment where order_id = $1',
    [orderId]
  )).rows[0];
  if (!payment) throw new CheckoutError('ORDER_NOT_FOUND');
  if (payment.provider_checkout_session_id !== checkoutSessionId) throw new CheckoutError('ORDER_ACCESS_DENIED');
  if (payment.status !== 'PAID') return { status: payment.status === 'FAILED' || payment.status === 'EXPIRED' ? 'FAILED' : 'PENDING', items: [] };

  const rows = (await tx.query<OrderItemRow>(
    `select oi.id as order_item_id, oi.offer_version_id, oi.gross_cents, p.racepic_image_id, img.title as image_title,
            ph.display_name as photographer_name, ph.copyright_line,
            l.code as license_code, l.title as license_title, l.attribution_required, l.attribution_template
       from commerce_order_item oi
       join commerce_product p on p.id = oi.product_id
       join racepic_image img on img.id = p.racepic_image_id
       join racepic_photographer ph on ph.id = img.photographer_id
       join commerce_offer_version ov on ov.id = oi.offer_version_id
       join racepic_license l on l.id = ov.license_id
      where oi.order_id = $1
      order by oi.created_at`,
    [orderId]
  )).rows;

  const items: OrderConfirmationItem[] = [];
  for (const row of rows) {
    items.push({
      imageId: row.racepic_image_id,
      title: row.image_title,
      priceCents: Number(row.gross_cents),
      downloadUrl: await deps.presignLicensedFull(row.racepic_image_id, row.offer_version_id),
      attribution: {
        photographerName: row.photographer_name,
        copyrightLine: row.copyright_line,
        licenseCode: row.license_code,
        licenseTitle: row.license_title,
        attributionRequired: row.attribution_required,
        attributionTemplate: row.attribution_template
      }
    });
  }
  return { status: 'PAID', items };
};
