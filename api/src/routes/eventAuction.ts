import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client';

export type AuctionStatus = 'draft' | 'open' | 'closed';

const translationsSchema = z.record(z.enum(['de', 'en', 'cz', 'pl']), z.string().trim().max(5000)).optional();
const auctionPatchSchema = z.object({
  status: z.enum(['draft', 'open', 'closed']).optional(),
  titleI18n: translationsSchema,
  descriptionI18n: translationsSchema,
  termsI18n: translationsSchema,
  imageUrl: z.string().url().max(2000).nullable().optional(),
  videoUrl: z.string().url().max(2000).nullable().optional(),
  startingBidCents: z.number().int().min(0).max(100_000_000).optional(),
  minIncrementCents: z.number().int().min(1).max(10_000_000).optional()
}).refine((value) => Object.keys(value).length > 0, 'Provide at least one field');

const bidSchema = z.object({
  bidderName: z.string().trim().min(2).max(160),
  contactType: z.enum(['email', 'phone']),
  contactValue: z.string().trim().min(6).max(254),
  amountCents: z.number().int().min(1).max(100_000_000),
  acceptedBinding: z.literal(true),
  termsVersion: z.string().trim().min(1).max(80),
  clientSubmissionKey: z.string().uuid(),
  website: z.string().max(0).optional().default('')
}).superRefine((value, context) => {
  if (value.contactType === 'email' && !z.string().email().safeParse(value.contactValue).success) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['contactValue'], message: 'Invalid email' });
  }
  if (value.contactType === 'phone' && value.contactValue.replace(/\D/g, '').length < 6) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['contactValue'], message: 'Invalid phone' });
  }
});

const bidAdminPatchSchema = z.object({
  status: z.enum(['valid', 'invalid']).optional(),
  adminNote: z.string().trim().max(2000).nullable().optional()
}).refine((value) => Object.keys(value).length > 0, 'Provide at least one field');

const rowToAuction = (row: any) => row ? ({
  eventId: row.event_id,
  status: row.status as AuctionStatus,
  titleI18n: row.title_i18n ?? {},
  descriptionI18n: row.description_i18n ?? {},
  termsI18n: row.terms_i18n ?? {},
  imageUrl: row.image_url,
  videoUrl: row.video_url,
  startingBidCents: row.starting_bid_cents,
  minIncrementCents: row.min_increment_cents,
  closedAt: row.closed_at,
  winnerBidId: row.winner_bid_id,
  currentHighestCents: row.current_highest_cents === null ? null : Number(row.current_highest_cents),
  nextMinimumCents: row.current_highest_cents === null
    ? Number(row.starting_bid_cents)
    : Number(row.current_highest_cents) + Number(row.min_increment_cents),
  termsVersion: `auction-${row.event_id}-v1`
}) : null;

const auctionSelect = (eventId: string) => sql`
  select a.*,
    (select max(b.amount_cents) from event_auction_bid b where b.event_id = a.event_id and b.status = 'valid') as current_highest_cents
  from event_auction a where a.event_id = ${eventId} limit 1
`;

export const getPublicCurrentAuction = async () => {
  const db = await getDb();
  const eventResult = await db.execute(sql`select id from event where is_current = true order by starts_at desc limit 1`);
  const eventId = (eventResult.rows[0] as any)?.id as string | undefined;
  if (!eventId) return null;
  const result = await db.execute(auctionSelect(eventId));
  const auction = rowToAuction(result.rows[0]);
  if (!auction || auction.status === 'draft') return null;
  return auction;
};

export const getAdminAuction = async (eventId: string) => {
  const db = await getDb();
  const result = await db.execute(auctionSelect(eventId));
  return rowToAuction(result.rows[0]) ?? {
    eventId, status: 'draft' as const, titleI18n: {}, descriptionI18n: {}, termsI18n: {},
    imageUrl: null, videoUrl: null, startingBidCents: 0, minIncrementCents: 1000,
    closedAt: null, winnerBidId: null, currentHighestCents: null, nextMinimumCents: 0,
    termsVersion: `auction-${eventId}-v1`
  };
};

export const patchAdminAuction = async (eventId: string, payload: unknown, actor: string | null) => {
  const input = auctionPatchSchema.parse(payload);
  const db = await getDb();
  await db.execute(sql`
    insert into event_auction(event_id, status, title_i18n, description_i18n, terms_i18n, image_url, video_url, starting_bid_cents, min_increment_cents, updated_by)
    values (${eventId}, ${input.status ?? 'draft'}, ${JSON.stringify(input.titleI18n ?? {})}::jsonb,
      ${JSON.stringify(input.descriptionI18n ?? {})}::jsonb, ${JSON.stringify(input.termsI18n ?? {})}::jsonb,
      ${input.imageUrl ?? null}, ${input.videoUrl ?? null}, ${input.startingBidCents ?? 0}, ${input.minIncrementCents ?? 1000}, ${actor})
    on conflict(event_id) do update set
      status = coalesce(${input.status ?? null}, event_auction.status),
      title_i18n = coalesce(${input.titleI18n ? JSON.stringify(input.titleI18n) : null}::jsonb, event_auction.title_i18n),
      description_i18n = coalesce(${input.descriptionI18n ? JSON.stringify(input.descriptionI18n) : null}::jsonb, event_auction.description_i18n),
      terms_i18n = coalesce(${input.termsI18n ? JSON.stringify(input.termsI18n) : null}::jsonb, event_auction.terms_i18n),
      image_url = case when ${input.imageUrl !== undefined} then ${input.imageUrl ?? null} else event_auction.image_url end,
      video_url = case when ${input.videoUrl !== undefined} then ${input.videoUrl ?? null} else event_auction.video_url end,
      starting_bid_cents = coalesce(${input.startingBidCents ?? null}, event_auction.starting_bid_cents),
      min_increment_cents = coalesce(${input.minIncrementCents ?? null}, event_auction.min_increment_cents),
      closed_at = case when ${input.status ?? null} = 'closed' then now() when ${input.status ?? null} = 'open' then null else event_auction.closed_at end,
      updated_at = now(), updated_by = ${actor}
  `);
  if (input.status === 'closed') {
    await db.execute(sql`update event_auction set winner_bid_id = (
      select id from event_auction_bid where event_id = ${eventId} and status = 'valid' order by amount_cents desc, created_at asc limit 1
    ) where event_id = ${eventId}`);
  }
  return getAdminAuction(eventId);
};

export class AuctionBidError extends Error {
  constructor(public code: 'AUCTION_NOT_OPEN' | 'BID_TOO_LOW', public nextMinimumCents?: number) { super(code); }
}

export const submitAuctionBid = async (eventId: string, payload: unknown) => {
  const input = bidSchema.parse(payload);
  const db = await getDb();
  return db.transaction(async (tx) => {
    const existing = await tx.execute(sql`select id, amount_cents from event_auction_bid where client_submission_key = ${input.clientSubmissionKey} limit 1`);
    if (existing.rows[0]) return { bidId: (existing.rows[0] as any).id, amountCents: Number((existing.rows[0] as any).amount_cents), alreadySubmitted: true };
    const locked = await tx.execute(sql`select * from event_auction where event_id = ${eventId} for update`);
    const auction = locked.rows[0] as any;
    if (!auction || auction.status !== 'open') throw new AuctionBidError('AUCTION_NOT_OPEN');
    const highestResult = await tx.execute(sql`select max(amount_cents) as amount from event_auction_bid where event_id = ${eventId} and status = 'valid'`);
    const highest = (highestResult.rows[0] as any)?.amount;
    const minimum = highest === null || highest === undefined ? Number(auction.starting_bid_cents) : Number(highest) + Number(auction.min_increment_cents);
    if (input.amountCents < minimum) throw new AuctionBidError('BID_TOO_LOW', minimum);
    const bidId = randomUUID();
    await tx.execute(sql`insert into event_auction_bid
      (id, event_id, bidder_name, contact_type, contact_value, amount_cents, terms_version, accepted_terms_at, client_submission_key)
      values (${bidId}, ${eventId}, ${input.bidderName}, ${input.contactType}, ${input.contactValue}, ${input.amountCents}, ${input.termsVersion}, now(), ${input.clientSubmissionKey})`);
    return { bidId, amountCents: input.amountCents, alreadySubmitted: false };
  });
};

export const listAdminAuctionBids = async (eventId: string) => {
  const db = await getDb();
  const result = await db.execute(sql`select id, bidder_name, contact_type, contact_value, amount_cents, status, admin_note, created_at
    from event_auction_bid where event_id = ${eventId} order by amount_cents desc, created_at asc`);
  return result.rows.map((row: any) => ({ id: row.id, bidderName: row.bidder_name, contactType: row.contact_type, contactValue: row.contact_value,
    amountCents: Number(row.amount_cents), status: row.status, adminNote: row.admin_note, createdAt: row.created_at }));
};

export const patchAdminAuctionBid = async (eventId: string, bidId: string, payload: unknown) => {
  const input = bidAdminPatchSchema.parse(payload);
  const db = await getDb();
  await db.execute(sql`update event_auction_bid set
    status = coalesce(${input.status ?? null}, status),
    admin_note = case when ${input.adminNote !== undefined} then ${input.adminNote ?? null} else admin_note end,
    updated_at = now() where id = ${bidId} and event_id = ${eventId}`);
  return listAdminAuctionBids(eventId);
};
