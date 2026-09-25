import { getPool } from '../db/client';

const eligibilitySql = (requirePublished: boolean, restrictEvent: boolean) => `
  select i.id
    from racepic_image i
    join racepic_event re on re.event_id = i.event_id
   where i.offer_mode = 'FREE'
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
