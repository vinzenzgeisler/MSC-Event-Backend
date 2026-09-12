import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client';
import { getPresignedAssetsDownloadUrl, getPresignedAssetsUploadUrl } from '../docs/storage';

export type AuctionStatus = 'draft' | 'open' | 'closed';

const translationsSchema = z.record(z.enum(['de', 'en', 'cz', 'pl']), z.string().trim().max(5000)).optional();
const auctionPatchSchema = z.object({
  status: z.enum(['draft', 'open', 'closed']).optional(),
  titleI18n: translationsSchema,
  descriptionI18n: translationsSchema,
  termsI18n: translationsSchema,
  imageUrl: z.string().url().max(2000).nullable().optional(),
  videoUrl: z.string().url().max(2000).nullable().optional(),
  imageS3Key: z.string().max(1000).nullable().optional(),
  videoS3Key: z.string().max(1000).nullable().optional(),
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

export const validateAuctionBidInput = (payload: unknown) => bidSchema.parse(payload);

export const requiredAuctionBidCents = (
  startingBidCents: number,
  minIncrementCents: number,
  currentHighestCents: number | null
) => currentHighestCents === null ? startingBidCents : currentHighestCents + minIncrementCents;

const termsVersionFor = (eventId: string, terms: unknown) => {
  const digest = createHash('sha256').update(JSON.stringify(terms ?? {})).digest('hex').slice(0, 12);
  return `auction-${eventId}-${digest}`;
};

const bidAdminPatchSchema = z.object({
  status: z.enum(['valid', 'invalid']).optional(),
  adminNote: z.string().trim().max(2000).nullable().optional()
}).refine((value) => Object.keys(value).length > 0, 'Provide at least one field');

const mediaUploadSchema = z.object({
  kind: z.enum(['image', 'video']),
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm']),
  fileSizeBytes: z.number().int().positive().max(100 * 1024 * 1024)
}).superRefine((value, context) => {
  if (value.kind === 'image' && (!value.contentType.startsWith('image/') || value.fileSizeBytes > 15 * 1024 * 1024)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['contentType'], message: 'Invalid auction image' });
  }
  if (value.kind === 'video' && !value.contentType.startsWith('video/')) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['contentType'], message: 'Invalid auction video' });
  }
});

const rowToAuction = async (row: any) => row ? ({
  eventId: row.event_id,
  status: row.status as AuctionStatus,
  titleI18n: row.title_i18n ?? {},
  descriptionI18n: row.description_i18n ?? {},
  termsI18n: row.terms_i18n ?? {},
  imageUrl: row.image_s3_key ? await getPresignedAssetsDownloadUrl(row.image_s3_key, 3600) : row.image_url,
  videoUrl: row.video_s3_key ? await getPresignedAssetsDownloadUrl(row.video_s3_key, 3600) : row.video_url,
  imageS3Key: row.image_s3_key ?? null,
  videoS3Key: row.video_s3_key ?? null,
  startingBidCents: row.starting_bid_cents,
  minIncrementCents: row.min_increment_cents,
  closedAt: row.closed_at,
  winnerBidId: row.winner_bid_id,
  currentHighestCents: row.current_highest_cents === null ? null : Number(row.current_highest_cents),
  nextMinimumCents: requiredAuctionBidCents(
    Number(row.starting_bid_cents),
    Number(row.min_increment_cents),
    row.current_highest_cents === null ? null : Number(row.current_highest_cents)
  ),
  termsVersion: termsVersionFor(row.event_id, row.terms_i18n)
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
  const auction = await rowToAuction(result.rows[0]);
  if (!auction || auction.status === 'draft') return null;
  return auction;
};

export const getAdminAuction = async (eventId: string) => {
  const db = await getDb();
  const result = await db.execute(auctionSelect(eventId));
  return await rowToAuction(result.rows[0]) ?? {
    eventId, status: 'draft' as const, titleI18n: {}, descriptionI18n: {}, termsI18n: {},
    imageUrl: null, videoUrl: null, imageS3Key: null, videoS3Key: null, startingBidCents: 0, minIncrementCents: 1000,
    closedAt: null, winnerBidId: null, currentHighestCents: null, nextMinimumCents: 0,
    termsVersion: termsVersionFor(eventId, {})
  };
};

export class AuctionConfigError extends Error {
  constructor(public missingFields: string[]) { super('AUCTION_CONFIG_INCOMPLETE'); }
}

export const getMissingAuctionFields = (auction: {
  imageUrl: string | null; videoUrl: string | null; minIncrementCents: number;
  imageS3Key?: string | null; videoS3Key?: string | null;
  titleI18n: Record<string, string>; descriptionI18n: Record<string, string>; termsI18n: Record<string, string>;
}) => {
  const requiredLocales = ['de', 'en', 'cz', 'pl'];
  return [
    ...(!auction.imageUrl && !auction.imageS3Key ? ['imageUrl'] : []),
    ...(!auction.videoUrl && !auction.videoS3Key ? ['videoUrl'] : []),
    ...(auction.minIncrementCents <= 0 ? ['minIncrementCents'] : []),
    ...requiredLocales.filter((locale) => !auction.titleI18n[locale]?.trim()).map((locale) => `titleI18n.${locale}`),
    ...requiredLocales.filter((locale) => !auction.descriptionI18n[locale]?.trim()).map((locale) => `descriptionI18n.${locale}`),
    ...requiredLocales.filter((locale) => !auction.termsI18n[locale]?.trim()).map((locale) => `termsI18n.${locale}`)
  ];
};

export const initAuctionMediaUpload = async (eventId: string, payload: unknown) => {
  const input = mediaUploadSchema.parse(payload);
  const extensionByType: Record<string, string> = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/webm': 'webm'
  };
  const key = `public/event-auctions/${eventId}/${input.kind}-${randomUUID()}.${extensionByType[input.contentType]}`;
  const upload = await getPresignedAssetsUploadUrl(key, input.contentType, 900);
  return { key, uploadUrl: upload.url, requiredHeaders: upload.requiredHeaders };
};

export const patchAdminAuction = async (eventId: string, payload: unknown, actor: string | null) => {
  const input = auctionPatchSchema.parse(payload);
  const db = await getDb();
  if (input.status === 'open') {
    const currentResult = await db.execute(auctionSelect(eventId));
    const current = await rowToAuction(currentResult.rows[0]) ?? await getAdminAuction(eventId);
    const candidate = {
      imageUrl: input.imageUrl === undefined ? current.imageUrl : input.imageUrl,
      videoUrl: input.videoUrl === undefined ? current.videoUrl : input.videoUrl,
      imageS3Key: input.imageS3Key === undefined ? current.imageS3Key : input.imageS3Key,
      videoS3Key: input.videoS3Key === undefined ? current.videoS3Key : input.videoS3Key,
      minIncrementCents: input.minIncrementCents ?? current.minIncrementCents,
      titleI18n: input.titleI18n ?? current.titleI18n,
      descriptionI18n: input.descriptionI18n ?? current.descriptionI18n,
      termsI18n: input.termsI18n ?? current.termsI18n
    };
    const missingFields = getMissingAuctionFields(candidate);
    if (missingFields.length > 0) throw new AuctionConfigError(missingFields);
  }
  await db.execute(sql`
    insert into event_auction(event_id, status, title_i18n, description_i18n, terms_i18n, image_url, video_url, image_s3_key, video_s3_key, starting_bid_cents, min_increment_cents, updated_by)
    values (${eventId}, ${input.status ?? 'draft'}, ${JSON.stringify(input.titleI18n ?? {})}::jsonb,
      ${JSON.stringify(input.descriptionI18n ?? {})}::jsonb, ${JSON.stringify(input.termsI18n ?? {})}::jsonb,
      ${input.imageUrl ?? null}, ${input.videoUrl ?? null}, ${input.imageS3Key ?? null}, ${input.videoS3Key ?? null}, ${input.startingBidCents ?? 0}, ${input.minIncrementCents ?? 1000}, ${actor})
    on conflict(event_id) do update set
      status = coalesce(${input.status ?? null}, event_auction.status),
      title_i18n = coalesce(${input.titleI18n ? JSON.stringify(input.titleI18n) : null}::jsonb, event_auction.title_i18n),
      description_i18n = coalesce(${input.descriptionI18n ? JSON.stringify(input.descriptionI18n) : null}::jsonb, event_auction.description_i18n),
      terms_i18n = coalesce(${input.termsI18n ? JSON.stringify(input.termsI18n) : null}::jsonb, event_auction.terms_i18n),
      image_url = case when ${input.imageUrl !== undefined} then ${input.imageUrl ?? null} else event_auction.image_url end,
      video_url = case when ${input.videoUrl !== undefined} then ${input.videoUrl ?? null} else event_auction.video_url end,
      image_s3_key = case when ${input.imageS3Key !== undefined} then ${input.imageS3Key ?? null} else event_auction.image_s3_key end,
      video_s3_key = case when ${input.videoS3Key !== undefined} then ${input.videoS3Key ?? null} else event_auction.video_s3_key end,
      starting_bid_cents = coalesce(${input.startingBidCents ?? null}, event_auction.starting_bid_cents),
      min_increment_cents = coalesce(${input.minIncrementCents ?? null}, event_auction.min_increment_cents),
      closed_at = case when ${input.status ?? null} = 'closed' then now() when ${input.status ?? null} = 'open' then null else event_auction.closed_at end,
      updated_at = now(), updated_by = ${actor}
  `);
  if (input.status === 'closed') {
    await db.execute(sql`update event_auction set winner_bid_id = (
      select id from event_auction_bid where event_id = ${eventId} and status = 'valid' order by amount_cents desc, created_at asc limit 1
    ) where event_id = ${eventId}`);
  } else if (input.status === 'open' || input.status === 'draft') {
    await db.execute(sql`update event_auction set winner_bid_id = null, closed_at = null where event_id = ${eventId}`);
  }
  return getAdminAuction(eventId);
};

export class AuctionBidError extends Error {
  constructor(public code: 'AUCTION_NOT_OPEN' | 'BID_TOO_LOW' | 'AUCTION_TERMS_CHANGED', public nextMinimumCents?: number) { super(code); }
}

export const submitAuctionBid = async (eventId: string, payload: unknown) => {
  const input = validateAuctionBidInput(payload);
  const db = await getDb();
  return db.transaction(async (tx) => {
    const existing = await tx.execute(sql`select id, amount_cents from event_auction_bid where client_submission_key = ${input.clientSubmissionKey} limit 1`);
    if (existing.rows[0]) return { bidId: (existing.rows[0] as any).id, amountCents: Number((existing.rows[0] as any).amount_cents), alreadySubmitted: true };
    const locked = await tx.execute(sql`select * from event_auction where event_id = ${eventId} for update`);
    const auction = locked.rows[0] as any;
    if (!auction || auction.status !== 'open') throw new AuctionBidError('AUCTION_NOT_OPEN');
    if (input.termsVersion !== termsVersionFor(eventId, auction.terms_i18n)) {
      throw new AuctionBidError('AUCTION_TERMS_CHANGED');
    }
    const highestResult = await tx.execute(sql`select max(amount_cents) as amount from event_auction_bid where event_id = ${eventId} and status = 'valid'`);
    const highest = (highestResult.rows[0] as any)?.amount;
    const minimum = requiredAuctionBidCents(
      Number(auction.starting_bid_cents),
      Number(auction.min_increment_cents),
      highest === null || highest === undefined ? null : Number(highest)
    );
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
  await db.execute(sql`update event_auction set winner_bid_id = case when status = 'closed' then (
    select id from event_auction_bid where event_id = ${eventId} and status = 'valid' order by amount_cents desc, created_at asc limit 1
  ) else winner_bid_id end where event_id = ${eventId}`);
  return listAdminAuctionBids(eventId);
};
