import type { Queryable } from './offers';
import { PricingError, priceSale, sumSales, type PricingSettings, type SalePricing } from './pricing';
import { loadCurrentSettings } from './settings';

/**
 * Serverautorisierte Quote (Commerce AP12), siehe docs/memory-bank/racepic-marketplace-checkout-plan.md
 * Abschnitt 3.2: Der Browser schickt nur Bild-IDs. Preis, Steuer, Verkaeufer, Kaufbarkeit und Lizenz werden bei
 * jeder Quote serverseitig aus der aktiven Angebotsversion aufgeloest. Eine Quote gilt 15 Minuten und haelt die
 * Einstellungsversion fest. Die Aufteilung auf MSC und Fotograf wird gespeichert, aber nie an Kaeufer ausgeliefert.
 */

export const QUOTE_TTL_SECONDS = 15 * 60;
export const MAX_QUOTE_ITEMS = 50;

export type QuoteErrorCode = 'QUOTE_EMPTY' | 'QUOTE_TOO_LARGE' | 'QUOTE_NOTHING_AVAILABLE' | 'QUOTE_TAX_NOT_CONFIGURED';

export class QuoteError extends Error {
  constructor(public readonly code: QuoteErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'QuoteError';
  }
}

export type QuoteItemSnapshot = SalePricing & {
  imageId: string;
  productId: string;
  offerVersionId: string;
  offerVersion: number;
  sellerId: string;
  license: { code: string; version: number };
};

export type QuoteResult = {
  quoteId: string;
  expiresAt: string;
  currency: 'EUR';
  items: { imageId: string; priceCents: number; license: { code: string } }[];
  /** taxRateBp ist null, wenn die Positionen unterschiedliche Saetze haben. */
  totals: { grossCents: number; netCents: number; taxCents: number; taxRateBp: number | null };
  /** Bilder, die nicht (mehr) kaeuflich sind; der Grund ist bewusst allgemein (kein Rueckschluss auf fremde Bilder). */
  unavailable: { imageId: string; reason: 'NOT_AVAILABLE' }[];
};

type OfferRow = {
  image_id: string;
  product_id: string;
  seller_id: string;
  offer_id: string;
  offer_version: number;
  price_cents: number;
  tax_rate_bp: number | null;
  license_code: string;
  license_version: number;
};

export type QuoteDeps = {
  /** Oeffentliche Eligibility eines Bildes (Veroeffentlichung, Event, Datenschutz); im Betrieb `isImagePubliclyEligible`. */
  isImageEligible: (imageId: string) => Promise<boolean>;
  now?: () => Date;
};

/** Aktive PAID-Angebote kaeuflicher Bilder; Bilder ohne Treffer liefern keine Zeile. */
const loadPurchasableOffers = async (tx: Queryable, imageIds: string[]): Promise<Map<string, OfferRow>> => {
  const result = await tx.query<OfferRow>(
    `select i.id as image_id, p.id as product_id, p.seller_id, o.id as offer_id, o.version as offer_version,
            o.price_cents, o.tax_rate_bp, l.code as license_code, l.version as license_version
       from racepic_image i
       join racepic_event re on re.event_id = i.event_id
       join commerce_product p on p.racepic_image_id = i.id
       join commerce_seller s on s.id = p.seller_id and s.status = 'ACTIVE'
       join commerce_offer_version o on o.product_id = p.id and o.status = 'ACTIVE' and o.mode = 'PAID'
       join racepic_license l on l.id = o.license_id
      where i.id = any($1::uuid[])
        and i.visibility = 'PUBLISHED' and i.offer_mode = 'PAID'
        and re.enabled = true and re.published = true`,
    [imageIds]
  );
  return new Map(result.rows.map((row) => [row.image_id, row]));
};

export const createQuote = async (
  tx: Queryable,
  requestedImageIds: string[],
  deps: QuoteDeps,
  settingsOverride?: PricingSettings & { id: string }
): Promise<QuoteResult> => {
  const imageIds = Array.from(new Set(requestedImageIds));
  if (imageIds.length === 0) throw new QuoteError('QUOTE_EMPTY');
  if (imageIds.length > MAX_QUOTE_ITEMS) throw new QuoteError('QUOTE_TOO_LARGE');

  const settings = settingsOverride ?? (await loadCurrentSettings(tx));
  const offers = await loadPurchasableOffers(tx, imageIds);

  const items: QuoteItemSnapshot[] = [];
  const unavailable: QuoteResult['unavailable'] = [];
  for (const imageId of imageIds) {
    const offer = offers.get(imageId);
    if (!offer || !(await deps.isImageEligible(imageId))) {
      unavailable.push({ imageId, reason: 'NOT_AVAILABLE' });
      continue;
    }
    let pricing: SalePricing;
    try {
      pricing = priceSale(Number(offer.price_cents), settings, offer.tax_rate_bp);
    } catch (error) {
      // Ohne entschiedenen Steuersatz gibt es keinen Preis: der Verkauf bleibt gesperrt, statt zu raten.
      if (error instanceof PricingError && error.code === 'TAX_NOT_CONFIGURED') throw new QuoteError('QUOTE_TAX_NOT_CONFIGURED');
      throw error;
    }
    items.push({
      ...pricing,
      imageId,
      productId: offer.product_id,
      offerVersionId: offer.offer_id,
      offerVersion: Number(offer.offer_version),
      sellerId: offer.seller_id,
      license: { code: offer.license_code, version: Number(offer.license_version) }
    });
  }
  if (items.length === 0) throw new QuoteError('QUOTE_NOTHING_AVAILABLE');

  const totals = sumSales(items);
  const inserted = await tx.query<{ id: string; expires_at: Date }>(
    `insert into commerce_quote (items, gross_cents, net_cents, tax_cents, expires_at, settings_version_id)
     values ($1::jsonb, $2, $3, $4, ($5::timestamptz + ($6 * interval '1 second')), $7)
     returning id, expires_at`,
    [JSON.stringify(items), totals.grossCents, totals.netCents, totals.taxCents, (deps.now?.() ?? new Date()).toISOString(), QUOTE_TTL_SECONDS, settings.id]
  );
  return {
    quoteId: inserted.rows[0].id,
    expiresAt: inserted.rows[0].expires_at.toISOString(),
    currency: 'EUR',
    items: items.map((item) => ({ imageId: item.imageId, priceCents: item.grossCents, license: { code: item.license.code } })),
    totals: { ...totals, taxRateBp: items.every((item) => item.taxRateBp === items[0].taxRateBp) ? items[0].taxRateBp : null },
    unavailable
  };
};
