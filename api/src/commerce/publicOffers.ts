import { getPool } from '../db/client';

export type ActiveOfferInfo = {
  offerVersionId: string;
  version: number;
  mode: 'FREE' | 'PAID';
  priceCents: number;
};

/** Aktive Angebotsversionen je RacePic-Bild (fuer Manifeste und Veroeffentlichung). Bilder ohne aktive Version fehlen in der Map. */
export const loadActiveOffersByImage = async (imageIds: string[]): Promise<Map<string, ActiveOfferInfo>> => {
  const result = new Map<string, ActiveOfferInfo>();
  if (imageIds.length === 0) return result;
  const pool = await getPool();
  const rows = await pool.query<{ image_id: string; id: string; version: number; mode: 'FREE' | 'PAID'; price_cents: number }>(
    `select p.racepic_image_id as image_id, o.id, o.version, o.mode, o.price_cents
       from commerce_offer_version o
       join commerce_product p on p.id = o.product_id
      where o.status = 'ACTIVE' and p.racepic_image_id = any($1::uuid[])`,
    [imageIds]
  );
  for (const row of rows.rows) {
    result.set(row.image_id, {
      offerVersionId: row.id,
      version: Number(row.version),
      mode: row.mode,
      priceCents: Number(row.price_cents)
    });
  }
  return result;
};
