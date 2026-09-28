import { getPool } from '../db/client';
import { getCommerceFlags } from '../commerce/flags';

/**
 * Oeffentlich sichtbar sind FREE-Bilder. Bezahlbilder erscheinen erst, wenn `commercePaidOffers` an ist UND das
 * Bild eine aktive PAID-Angebotsversion hat (nach Adminfreigabe eines FREE->PAID-Antrags); alte PAID-Entwuerfe
 * ohne Freigabe bleiben so weiterhin privat.
 */
const offerCondition = (): string =>
  getCommerceFlags().commercePaidOffers
    ? `(i.offer_mode = 'FREE' or (i.offer_mode = 'PAID' and exists (
         select 1 from commerce_offer_version o
           join commerce_product p on p.id = o.product_id
          where p.racepic_image_id = i.id and o.status = 'ACTIVE' and o.mode = 'PAID')))`
    : `i.offer_mode = 'FREE'`;

const eligibilitySql = (requirePublished: boolean, restrictEvent: boolean) => `
  select i.id
    from racepic_image i
    join racepic_event re on re.event_id = i.event_id
   where ${offerCondition()}
     ${requirePublished ? "and i.visibility = 'PUBLISHED' and re.enabled = true and re.published = true" : ''}
     ${restrictEvent ? 'and i.event_id = $1' : 'and i.id = $1'}`;

export const isImagePubliclyEligible = async (imageId: string, requirePublished = true): Promise<boolean> => {
  const pool = await getPool();
  const result = await pool.query(eligibilitySql(requirePublished, false), [imageId]);
  return result.rowCount === 1;
};

export const listPubliclyEligibleImageIds = async (eventId: string): Promise<Set<string>> => {
  const pool = await getPool();
  const result = await pool.query<{ id: string }>(eligibilitySql(true, true), [eventId]);
  return new Set(result.rows.map((row) => row.id));
};
