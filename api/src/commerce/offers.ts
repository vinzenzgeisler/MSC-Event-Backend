import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

/**
 * Angebotsversionen (AP07): immutable FREE/PAID-Angebote pro Produkt.
 *
 * Preis, Lizenz, Steuerklasse und Seller einer Version aendern sich nie (DB-Trigger
 * `commerce_offer_version_immutable`); nur Status und Gueltigkeitsende. Jede Aenderung erzeugt eine neue
 * Version. Pro Produkt ist hoechstens eine Version ACTIVE (partieller Unique-Index). Der Wechsel
 * ACTIVE -> RETIRED und die Aktivierung der neuen Version passieren immer in derselben Transaktion.
 */

export const PRICE_TIERS_CENTS = [500, 1000, 1500, 2000] as const;
export type PriceTierCents = (typeof PRICE_TIERS_CENTS)[number];

export type OfferMode = 'FREE' | 'PAID';
export type OfferStatus = 'DRAFT' | 'PENDING_REVIEW' | 'ACTIVE' | 'REJECTED' | 'RETIRED';

export type OfferVersionRow = {
  id: string;
  product_id: string;
  version: number;
  mode: OfferMode;
  price_cents: number;
  currency: string;
  license_id: string;
  tax_class: string | null;
  tax_rate_bp: number | null;
  seller_id: string;
  status: OfferStatus;
  conversion_id: string | null;
  artifact_prefix: string | null;
  valid_from: Date | null;
  valid_to: Date | null;
  created_by: string | null;
};

export type Queryable = {
  query: <R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) => Promise<QueryResult<R>>;
};

export class OfferError extends Error {
  constructor(
    public readonly code:
      | 'INVALID_PRICE_TIER'
      | 'PRODUCT_NOT_FOUND'
      | 'OFFER_NOT_FOUND'
      | 'OFFER_NOT_PENDING'
      | 'FREE_OFFER_HAS_PRICE',
    message: string
  ) {
    super(message);
    this.name = 'OfferError';
  }
}

export const isValidPriceTier = (priceCents: number): priceCents is PriceTierCents =>
  (PRICE_TIERS_CENTS as readonly number[]).includes(priceCents);

export const withTransaction = async <T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
};

export type NewOfferInput = {
  productId: string;
  mode: OfferMode;
  priceCents: number;
  licenseId: string;
  sellerId: string;
  createdBy: string;
  conversionId?: string | null;
  artifactPrefix?: string | null;
  taxClass?: string | null;
  taxRateBp?: number | null;
};

const validateInput = (input: NewOfferInput) => {
  if (input.mode === 'FREE' && input.priceCents !== 0) {
    throw new OfferError('FREE_OFFER_HAS_PRICE', 'Ein FREE-Angebot muss den Preis 0 haben.');
  }
  if (input.mode === 'PAID' && !isValidPriceTier(input.priceCents)) {
    throw new OfferError('INVALID_PRICE_TIER', `Preis ${input.priceCents} ist keine erlaubte Preisstufe.`);
  }
};

/** Sperrt die Produktzeile; serialisiert alle Angebotswechsel eines Produkts. Muss in einer Transaktion laufen. */
const lockProduct = async (tx: Queryable, productId: string) => {
  const result = await tx.query('select id from commerce_product where id = $1 for update', [productId]);
  if (result.rowCount === 0) {
    throw new OfferError('PRODUCT_NOT_FOUND', 'Produkt nicht gefunden.');
  }
};

const nextVersion = async (tx: Queryable, productId: string): Promise<number> => {
  const result = await tx.query<{ next: number }>(
    'select coalesce(max(version), 0) + 1 as next from commerce_offer_version where product_id = $1',
    [productId]
  );
  return Number(result.rows[0].next);
};

const retireActive = async (tx: Queryable, productId: string) => {
  await tx.query(
    `update commerce_offer_version
        set status = 'RETIRED', valid_to = now(), updated_at = now()
      where product_id = $1 and status = 'ACTIVE'`,
    [productId]
  );
};

const insertVersion = async (
  tx: Queryable,
  input: NewOfferInput,
  status: OfferStatus,
  version: number
): Promise<OfferVersionRow> => {
  const result = await tx.query<OfferVersionRow>(
    `insert into commerce_offer_version
       (product_id, version, mode, price_cents, license_id, seller_id, status, conversion_id,
        artifact_prefix, tax_class, tax_rate_bp, valid_from, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, case when $7 = 'ACTIVE' then now() else null end, $12)
     returning *`,
    [
      input.productId,
      version,
      input.mode,
      input.priceCents,
      input.licenseId,
      input.sellerId,
      status,
      input.conversionId ?? null,
      input.artifactPrefix ?? null,
      input.taxClass ?? null,
      input.taxRateBp ?? null,
      input.createdBy
    ]
  );
  return result.rows[0];
};

/**
 * Legt eine neue Version an und macht sie aktiv; die bisher aktive Version wird beendet.
 * `tx` muss eine offene Transaktion sein (siehe `withTransaction`).
 */
export const activateNewOfferVersion = async (tx: Queryable, input: NewOfferInput): Promise<OfferVersionRow> => {
  validateInput(input);
  await lockProduct(tx, input.productId);
  const version = await nextVersion(tx, input.productId);
  await retireActive(tx, input.productId);
  return insertVersion(tx, input, 'ACTIVE', version);
};

/** Legt eine noch nicht wirksame Version an (z. B. PENDING_REVIEW bei FREE->PAID-Antrag). */
export const createInactiveOfferVersion = async (
  tx: Queryable,
  input: NewOfferInput,
  status: Exclude<OfferStatus, 'ACTIVE' | 'RETIRED'>
): Promise<OfferVersionRow> => {
  validateInput(input);
  await lockProduct(tx, input.productId);
  const version = await nextVersion(tx, input.productId);
  return insertVersion(tx, input, status, version);
};

/** Aktiviert eine PENDING_REVIEW-Version atomar und beendet die bis dahin aktive Version desselben Produkts. */
export const activatePendingOfferVersion = async (tx: Queryable, offerVersionId: string): Promise<OfferVersionRow> => {
  const found = await tx.query<OfferVersionRow>('select * from commerce_offer_version where id = $1', [offerVersionId]);
  if (found.rowCount === 0) {
    throw new OfferError('OFFER_NOT_FOUND', 'Angebotsversion nicht gefunden.');
  }
  const productId = found.rows[0].product_id;
  await lockProduct(tx, productId);
  // Nach dem Lock erneut lesen: ein paralleler Freigabeversuch darf die Version nicht doppelt aktivieren.
  const current = await tx.query<OfferVersionRow>('select * from commerce_offer_version where id = $1', [offerVersionId]);
  if (current.rows[0].status !== 'PENDING_REVIEW') {
    throw new OfferError('OFFER_NOT_PENDING', 'Angebotsversion wartet nicht auf Freigabe.');
  }
  await retireActive(tx, productId);
  const updated = await tx.query<OfferVersionRow>(
    `update commerce_offer_version set status = 'ACTIVE', valid_from = now(), updated_at = now()
      where id = $1 returning *`,
    [offerVersionId]
  );
  return updated.rows[0];
};

export const rejectPendingOfferVersion = async (tx: Queryable, offerVersionId: string): Promise<OfferVersionRow> => {
  const updated = await tx.query<OfferVersionRow>(
    `update commerce_offer_version set status = 'REJECTED', updated_at = now()
      where id = $1 and status = 'PENDING_REVIEW' returning *`,
    [offerVersionId]
  );
  if (updated.rowCount === 0) {
    throw new OfferError('OFFER_NOT_PENDING', 'Angebotsversion wartet nicht auf Freigabe.');
  }
  return updated.rows[0];
};

export const getActiveOfferVersion = async (tx: Queryable, productId: string): Promise<OfferVersionRow | null> => {
  const result = await tx.query<OfferVersionRow>(
    `select * from commerce_offer_version where product_id = $1 and status = 'ACTIVE'`,
    [productId]
  );
  return result.rows[0] ?? null;
};
