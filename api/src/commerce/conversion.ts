import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { getPool } from '../db/client';
import { logOperationalEvent } from '../observability/logger';
import {
  LicensedFullValidationError,
  renderLicensedFull,
  renderWatermarkedPreview,
  validateLicensedFull
} from '../racepic/imageProcessing';
import { sendConversionMessage } from '../racepic/queues';
import { deleteObject, getObject, presignGetObject, putObject } from '../racepic/s3';
import { invalidateCloudFront, publishPublicObjectsForImage, regenerateManifestsForEvent, regeneratePhotographerManifest } from '../racepic/publish';
import { conversionArtifactKeys, freePublicKey } from './objectKeys';
import {
  activateNewOfferVersion,
  activatePendingOfferVersion,
  createInactiveOfferVersion,
  isValidPriceTier,
  withTransaction,
  type Queryable
} from './offers';

/**
 * FREE->PAID-Antrag fuer bereits veroeffentlichte Bilder (AP08/AP09), siehe
 * docs/memory-bank/racepic-marketplace-checkout-plan.md Abschnitt 5.
 *
 * Der Antrag aendert die oeffentliche Ausgabe zunaechst nicht. Erst die Adminfreigabe aktiviert transaktional
 * die PAID-Version, beendet die FREE-Version und spiegelt das Ergebnis in `racepic_image` (offer_mode,
 * price_cents, license_id), worauf Downloads, Eligibility und Manifeste aufsetzen.
 */

export const CONVERSION_RIGHTS_VERSION = '2026-09-28.1';
export const MAX_CONVERSION_IMAGES = 50;
const MAX_ARTIFACT_ATTEMPTS = 3;
const ARTIFACT_LEASE_SECONDS = 300;
const PREVIEW_URL_TTL_SECONDS = 300;

export type ConversionErrorCode =
  | 'CONVERSION_INVALID_PRICE'
  | 'CONVERSION_INVALID_LICENSE'
  | 'CONVERSION_RIGHTS_NOT_CONFIRMED'
  | 'CONVERSION_PHOTOGRAPHER_NOT_ELIGIBLE'
  | 'CONVERSION_IMAGE_NOT_ELIGIBLE'
  | 'CONVERSION_IMAGE_ALREADY_PENDING'
  | 'CONVERSION_IDEMPOTENCY_KEY_REUSED'
  | 'CONVERSION_NOT_FOUND'
  | 'CONVERSION_NOT_REVIEWABLE'
  | 'CONVERSION_STALE'
  | 'CONVERSION_NOT_APPROVED'
  | 'CONVERSION_QUEUE_UNAVAILABLE';

export class ConversionError extends Error {
  constructor(public readonly code: ConversionErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'ConversionError';
  }
}

export type RequestConversionInput = {
  idempotencyKey: string;
  imageIds: string[];
  priceCents: number;
  licenseId: string;
  rightsConfirmed: boolean;
};

type ConversionRow = {
  id: string;
  photographer_id: string;
  idempotency_key: string;
  status: string;
  target_price_cents: number;
  target_license_id: string;
  rights_confirmed_at: Date;
  rights_confirmation_version: string;
  reviewer: string | null;
  review_note: string | null;
  decided_at: Date | null;
  failure_reason: string | null;
  finalized_at: Date | null;
  request_fingerprint: string | null;
  created_at: Date;
  updated_at: Date;
};

type ItemRow = {
  id: string;
  conversion_id: string;
  image_id: string;
  source_offer_version_id: string | null;
  target_offer_version_id: string | null;
  artifact_status: 'PENDING' | 'RUNNING' | 'READY' | 'FAILED';
  artifact_error: string | null;
  is_open: boolean;
  attempt_count: number;
  licensed_full_key: string | null;
  watermarked_thumb_key: string | null;
  watermarked_preview_key: string | null;
};

export const requestFingerprint = (input: Pick<RequestConversionInput, 'imageIds' | 'priceCents' | 'licenseId'>): string =>
  createHash('sha256')
    .update(JSON.stringify({ imageIds: [...input.imageIds].sort(), priceCents: input.priceCents, licenseId: input.licenseId }))
    .digest('hex');

const ELIGIBLE_PHOTOGRAPHER_STATUSES = new Set([
  'ACTIVE_FREE',
  'PAYMENT_ONBOARDING_REQUIRED',
  'PAYMENT_ONBOARDING_PENDING',
  'PAYMENT_ENABLED',
  'PAYMENT_RESTRICTED'
]);
const CONVERTIBLE_PROCESSING_STATUSES = new Set(['DERIVED', 'ANALYZED', 'MATCHED']);

const uniqueViolation = (error: unknown): boolean => (error as { code?: string } | null)?.code === '23505';

const ensureSeller = async (tx: Queryable, photographerId: string): Promise<string> => {
  await tx.query(
    `insert into commerce_seller (kind, photographer_id, display_name)
     select 'PHOTOGRAPHER', p.id, p.display_name from racepic_photographer p where p.id = $1
     on conflict (photographer_id) where photographer_id is not null do nothing`,
    [photographerId]
  );
  const seller = await tx.query<{ id: string }>('select id from commerce_seller where photographer_id = $1', [photographerId]);
  return seller.rows[0].id;
};

const ensureProduct = async (tx: Queryable, imageId: string, sellerId: string): Promise<string> => {
  await tx.query(
    `insert into commerce_product (product_type, racepic_image_id, seller_id)
     values ('RACEPIC_IMAGE_LICENSE', $1, $2)
     on conflict (racepic_image_id) where racepic_image_id is not null do nothing`,
    [imageId, sellerId]
  );
  const product = await tx.query<{ id: string }>('select id from commerce_product where racepic_image_id = $1', [imageId]);
  return product.rows[0].id;
};

const toView = (conversion: ConversionRow, items: ItemRow[], options: { includeReviewNote: boolean }) => ({
  id: conversion.id,
  status: conversion.status,
  priceCents: conversion.target_price_cents,
  licenseId: conversion.target_license_id,
  createdAt: conversion.created_at.toISOString(),
  decidedAt: conversion.decided_at ? conversion.decided_at.toISOString() : null,
  finalized: conversion.finalized_at !== null,
  failureReason: conversion.status === 'FAILED' ? conversion.failure_reason : null,
  reviewNote: options.includeReviewNote && conversion.status === 'REJECTED' ? conversion.review_note : null,
  items: items.map((item) => ({ imageId: item.image_id, artifactStatus: item.artifact_status, artifactError: item.artifact_status === 'FAILED' ? item.artifact_error : null }))
});

export type ConversionView = ReturnType<typeof toView>;

const loadItems = async (tx: Queryable, conversionId: string): Promise<ItemRow[]> =>
  (await tx.query<ItemRow>('select * from racepic_offer_conversion_item where conversion_id = $1 order by created_at, id', [conversionId])).rows;

const enqueueItems = async (items: ItemRow[]) => {
  try {
    for (const item of items) {
      if (item.artifact_status === 'PENDING' || item.artifact_status === 'FAILED') await sendConversionMessage(item.id);
    }
  } catch (error) {
    logOperationalEvent('error', 'racepic_conversion.enqueue_failed', {});
    throw new ConversionError('CONVERSION_QUEUE_UNAVAILABLE');
  }
};

/** Legt den Antrag idempotent an (gleicher Key + gleicher Inhalt = gleiche Antwort; gleicher Key + anderer Inhalt = Fehler). */
export const requestConversion = async (
  photographerId: string,
  input: RequestConversionInput
): Promise<{ conversion: ConversionView; created: boolean }> => {
  if (!input.rightsConfirmed) throw new ConversionError('CONVERSION_RIGHTS_NOT_CONFIRMED');
  if (!isValidPriceTier(input.priceCents)) throw new ConversionError('CONVERSION_INVALID_PRICE');
  const imageIds = Array.from(new Set(input.imageIds));
  if (imageIds.length === 0 || imageIds.length > MAX_CONVERSION_IMAGES) throw new ConversionError('CONVERSION_IMAGE_NOT_ELIGIBLE');
  const fingerprint = requestFingerprint({ imageIds, priceCents: input.priceCents, licenseId: input.licenseId });

  const pool = await getPool();
  let outcome: { conversion: ConversionRow; items: ItemRow[]; created: boolean };
  try {
    outcome = await withTransaction(pool, async (tx) => {
      const existing = await tx.query<ConversionRow>(
        'select * from racepic_offer_conversion where photographer_id = $1 and idempotency_key = $2',
        [photographerId, input.idempotencyKey]
      );
      if (existing.rows[0]) {
        if (existing.rows[0].request_fingerprint !== fingerprint) throw new ConversionError('CONVERSION_IDEMPOTENCY_KEY_REUSED');
        return { conversion: existing.rows[0], items: await loadItems(tx, existing.rows[0].id), created: false };
      }

      const photographer = await tx.query<{ status: string }>('select status from racepic_photographer where id = $1 and deleted_at is null', [photographerId]);
      if (!photographer.rows[0] || !ELIGIBLE_PHOTOGRAPHER_STATUSES.has(photographer.rows[0].status)) {
        throw new ConversionError('CONVERSION_PHOTOGRAPHER_NOT_ELIGIBLE');
      }
      const license = await tx.query<{ id: string }>(
        `select id from racepic_license where id = $1 and active = true and pricing_kind = 'PAID'`,
        [input.licenseId]
      );
      if (!license.rows[0]) throw new ConversionError('CONVERSION_INVALID_LICENSE');

      const images = await tx.query<{
        id: string; photographer_id: string; visibility: string; offer_mode: string; processing_status: string;
        original_key: string | null; width: number | null; height: number | null; license_id: string;
      }>(
        `select id, photographer_id, visibility, offer_mode, processing_status, original_key, width, height, license_id
           from racepic_image where id = any($1::uuid[]) for update`,
        [imageIds]
      );
      // Fremde oder unbekannte Bilder liefern denselben Fehler (kein Rueckschluss auf fremde Bild-IDs).
      const eligible = images.rows.length === imageIds.length && images.rows.every((image) =>
        image.photographer_id === photographerId &&
        image.visibility === 'PUBLISHED' &&
        image.offer_mode === 'FREE' &&
        CONVERTIBLE_PROCESSING_STATUSES.has(image.processing_status) &&
        image.original_key !== null && image.width !== null && image.height !== null);
      if (!eligible) throw new ConversionError('CONVERSION_IMAGE_NOT_ELIGIBLE');

      const open = await tx.query('select 1 from racepic_offer_conversion_item where image_id = any($1::uuid[]) and is_open limit 1', [imageIds]);
      if (open.rowCount) throw new ConversionError('CONVERSION_IMAGE_ALREADY_PENDING');

      const sellerId = await ensureSeller(tx, photographerId);
      const created = await tx.query<ConversionRow>(
        `insert into racepic_offer_conversion
           (photographer_id, idempotency_key, target_price_cents, target_license_id, rights_confirmed_at, rights_confirmation_version, request_fingerprint)
         values ($1, $2, $3, $4, now(), $5, $6) returning *`,
        [photographerId, input.idempotencyKey, input.priceCents, input.licenseId, CONVERSION_RIGHTS_VERSION, fingerprint]
      );
      const conversion = created.rows[0];

      for (const image of images.rows) {
        const productId = await ensureProduct(tx, image.id, sellerId);
        let source = (await tx.query<{ id: string }>(`select id from commerce_offer_version where product_id = $1 and status = 'ACTIVE'`, [productId])).rows[0];
        if (!source) {
          // Bestandsbild ohne Angebotsversion (Backfill nicht gelaufen): kostenlose Basisversion nachziehen.
          const baseline = await activateNewOfferVersion(tx, {
            productId, mode: 'FREE', priceCents: 0, licenseId: image.license_id, sellerId, createdBy: 'system:conversion-request'
          });
          source = { id: baseline.id };
        }
        const target = await createInactiveOfferVersion(tx, {
          productId, mode: 'PAID', priceCents: input.priceCents, licenseId: input.licenseId, sellerId,
          conversionId: conversion.id, createdBy: `photographer:${photographerId}`
        }, 'DRAFT');
        await tx.query(
          `insert into racepic_offer_conversion_item (conversion_id, image_id, source_offer_version_id, target_offer_version_id)
           values ($1, $2, $3, $4)`,
          [conversion.id, image.id, source.id, target.id]
        );
      }
      return { conversion, items: await loadItems(tx, conversion.id), created: true };
    });
  } catch (error) {
    if (uniqueViolation(error)) throw new ConversionError('CONVERSION_IMAGE_ALREADY_PENDING');
    throw error;
  }

  // Ausserhalb der Transaktion: bei Queue-Ausfall bleibt der Antrag bestehen; ein Wiederholungsaufruf mit
  // demselben Idempotency-Key stoesst die noch offenen Artefakte erneut an.
  await enqueueItems(outcome.items);
  return { conversion: toView(outcome.conversion, outcome.items, { includeReviewNote: true }), created: outcome.created };
};

export const listOwnConversions = async (photographerId: string): Promise<ConversionView[]> => {
  const pool = await getPool();
  const rows = await pool.query<ConversionRow>(
    'select * from racepic_offer_conversion where photographer_id = $1 order by created_at desc limit 50',
    [photographerId]
  );
  const result: ConversionView[] = [];
  for (const row of rows.rows) result.push(toView(row, await loadItems(pool, row.id), { includeReviewNote: true }));
  return result;
};

export const getOwnConversion = async (photographerId: string, conversionId: string): Promise<ConversionView> => {
  const pool = await getPool();
  const row = await pool.query<ConversionRow>('select * from racepic_offer_conversion where id = $1 and photographer_id = $2', [conversionId, photographerId]);
  if (!row.rows[0]) throw new ConversionError('CONVERSION_NOT_FOUND');
  return toView(row.rows[0], await loadItems(pool, conversionId), { includeReviewNote: true });
};

// --- Artefakt-Worker (AP04) ---------------------------------------------------------------------------

const failConversion = async (tx: Queryable, conversionId: string, reason: string) => {
  await tx.query(
    `update racepic_offer_conversion set status = 'FAILED', failure_reason = $2, updated_at = now()
      where id = $1 and status in ('REQUESTED', 'PREPARING_ASSETS')`,
    [conversionId, reason.slice(0, 500)]
  );
  await tx.query(
    `update commerce_offer_version set status = 'REJECTED', updated_at = now()
      where conversion_id = $1 and status in ('DRAFT', 'PENDING_REVIEW')`,
    [conversionId]
  );
  await tx.query('update racepic_offer_conversion_item set is_open = false, updated_at = now() where conversion_id = $1', [conversionId]);
};

/** Verarbeitet ein Conversion-Item (SQS-Nachricht). Wirft nur bei wiederholbaren Fehlern (dann liefert SQS erneut zu). */
export const processConversionItem = async (itemId: string): Promise<'processed' | 'skipped' | 'failed'> => {
  const pool = await getPool();
  const claimed = await pool.query<ItemRow>(
    `update racepic_offer_conversion_item
        set artifact_status = 'RUNNING', attempt_count = attempt_count + 1,
            lease_expires_at = now() + ($2 * interval '1 second'), updated_at = now()
      where id = $1 and is_open
        and (artifact_status in ('PENDING', 'FAILED')
             or (artifact_status = 'RUNNING' and lease_expires_at < now()))
      returning *`,
    [itemId, ARTIFACT_LEASE_SECONDS]
  );
  const item = claimed.rows[0];
  if (!item) return 'skipped';

  await pool.query(
    `update racepic_offer_conversion set status = 'PREPARING_ASSETS', updated_at = now() where id = $1 and status = 'REQUESTED'`,
    [item.conversion_id]
  );

  try {
    const image = (await pool.query<{
      id: string; photographer_id: string; original_key: string | null; width: number | null; height: number | null;
    }>('select id, photographer_id, original_key, width, height from racepic_image where id = $1', [item.image_id])).rows[0];
    const photographer = image
      ? (await pool.query<{ copyright_line: string | null; display_name: string }>('select copyright_line, display_name from racepic_photographer where id = $1', [image.photographer_id])).rows[0]
      : undefined;
    if (!image || !image.original_key || !image.width || !image.height || !photographer) {
      throw new LicensedFullValidationError('NOT_JPEG'); // deterministisch: keine Wiederholung sinnvoll
    }
    const copyrightLine = photographer.copyright_line || `© ${photographer.display_name}`;

    const [original, thumbSource, previewSource] = await Promise.all([
      getObject(image.original_key),
      getObject(`derived/${image.id}/thumb.webp`),
      getObject(`derived/${image.id}/preview.webp`)
    ]);
    if (!original || !thumbSource || !previewSource) throw new Error('RACEPIC_CONVERSION_SOURCE_MISSING');

    const licensed = await renderLicensedFull(original, copyrightLine);
    await validateLicensedFull(licensed.buffer, { width: image.width, height: image.height }, copyrightLine);
    const [watermarkedThumb, watermarkedPreview] = await Promise.all([
      renderWatermarkedPreview(thumbSource),
      renderWatermarkedPreview(previewSource)
    ]);

    const keys = conversionArtifactKeys(image.id, item.target_offer_version_id as string);
    await putObject(keys.licensedFull, licensed.buffer, 'image/jpeg', `attachment; filename="racepic-${image.id}.jpg"`);
    await putObject(keys.watermarkedThumb, watermarkedThumb, 'image/webp');
    await putObject(keys.watermarkedPreview, watermarkedPreview, 'image/webp');

    await withTransaction(pool, async (tx) => {
      await tx.query(
        `update racepic_offer_conversion_item
            set artifact_status = 'READY', artifact_error = null, lease_expires_at = null,
                licensed_full_key = $2, watermarked_thumb_key = $3, watermarked_preview_key = $4,
                licensed_width = $5, licensed_height = $6, licensed_bytes = $7, updated_at = now()
          where id = $1`,
        [item.id, keys.licensedFull, keys.watermarkedThumb, keys.watermarkedPreview, licensed.width, licensed.height, licensed.buffer.length]
      );
      // Sperre auf den Antrag: genau ein Item-Abschluss schaltet den Antrag auf READY_FOR_REVIEW.
      await tx.query('select id from racepic_offer_conversion where id = $1 for update', [item.conversion_id]);
      const pending = await tx.query(
        `select 1 from racepic_offer_conversion_item where conversion_id = $1 and artifact_status <> 'READY' limit 1`,
        [item.conversion_id]
      );
      if (pending.rowCount === 0) {
        const moved = await tx.query(
          `update racepic_offer_conversion set status = 'READY_FOR_REVIEW', updated_at = now()
            where id = $1 and status = 'PREPARING_ASSETS'`,
          [item.conversion_id]
        );
        if (moved.rowCount) {
          await tx.query(
            `update commerce_offer_version set status = 'PENDING_REVIEW', updated_at = now()
              where conversion_id = $1 and status = 'DRAFT'`,
            [item.conversion_id]
          );
        }
      }
    });
    return 'processed';
  } catch (error) {
    const deterministic = error instanceof LicensedFullValidationError;
    const message = error instanceof Error ? error.message : String(error);
    const exhausted = item.attempt_count >= MAX_ARTIFACT_ATTEMPTS;
    await withTransaction(pool, async (tx) => {
      await tx.query(
        `update racepic_offer_conversion_item set artifact_status = 'FAILED', artifact_error = $2, lease_expires_at = null, updated_at = now() where id = $1`,
        [item.id, message.slice(0, 500)]
      );
      if (deterministic || exhausted) await failConversion(tx, item.conversion_id, message);
    });
    logOperationalEvent('error', 'racepic_conversion.artifact_failed', { errorCode: deterministic ? (error as LicensedFullValidationError).code : 'RETRYABLE' });
    if (deterministic || exhausted) return 'failed';
    throw error;
  }
};

// --- Admin-Review (AP09) ------------------------------------------------------------------------------

export type AdminConversionSummary = ConversionView & { photographer: { id: string; displayName: string }; imageCount: number };

export const listConversionsForReview = async (filter: { status?: string; limit: number; offset: number }): Promise<AdminConversionSummary[]> => {
  const pool = await getPool();
  const rows = await pool.query<ConversionRow & { display_name: string; image_count: string }>(
    `select c.*, p.display_name,
            (select count(*) from racepic_offer_conversion_item i where i.conversion_id = c.id) as image_count
       from racepic_offer_conversion c
       join racepic_photographer p on p.id = c.photographer_id
      where ($1::text is null or c.status = $1)
      order by c.created_at desc
      limit $2 offset $3`,
    [filter.status ?? null, filter.limit, filter.offset]
  );
  return rows.rows.map((row) => ({
    ...toView(row, [], { includeReviewNote: true }),
    photographer: { id: row.photographer_id, displayName: row.display_name },
    imageCount: Number(row.image_count)
  }));
};

/** Detailansicht fuer die Pruefung: Eigentuemer, Rechtebestaetigung, Preis, Lizenz und wasserzeichenbehaftete Vorschau. */
export const getConversionForReview = async (conversionId: string) => {
  const pool = await getPool();
  const conversion = (await pool.query<ConversionRow & { display_name: string; email: string; license_code: string; license_version: number }>(
    `select c.*, p.display_name, p.email, l.code as license_code, l.version as license_version
       from racepic_offer_conversion c
       join racepic_photographer p on p.id = c.photographer_id
       join racepic_license l on l.id = c.target_license_id
      where c.id = $1`,
    [conversionId]
  )).rows[0];
  if (!conversion) throw new ConversionError('CONVERSION_NOT_FOUND');
  const items = await pool.query<ItemRow & { title: string | null; event_id: string; owner_id: string; visibility: string; offer_mode: string; source_price: number | null }>(
    `select i.*, img.title, img.event_id, img.photographer_id as owner_id, img.visibility, img.offer_mode
       from racepic_offer_conversion_item i
       join racepic_image img on img.id = i.image_id
      where i.conversion_id = $1 order by i.created_at, i.id`,
    [conversionId]
  );
  const itemViews = [];
  for (const item of items.rows) {
    const previewUrl = item.watermarked_preview_key && item.artifact_status === 'READY'
      ? await presignGetObject(item.watermarked_preview_key, PREVIEW_URL_TTL_SECONDS).catch(() => null)
      : null;
    itemViews.push({
      imageId: item.image_id,
      title: item.title,
      eventId: item.event_id,
      ownedByRequester: item.owner_id === conversion.photographer_id,
      visibility: item.visibility,
      offerMode: item.offer_mode,
      artifactStatus: item.artifact_status,
      artifactError: item.artifact_error,
      previewUrl
    });
  }
  return {
    ...toView(conversion, items.rows, { includeReviewNote: true }),
    photographer: { id: conversion.photographer_id, displayName: conversion.display_name, email: conversion.email },
    license: { id: conversion.target_license_id, code: conversion.license_code, version: conversion.license_version },
    rightsConfirmedAt: conversion.rights_confirmed_at.toISOString(),
    rightsConfirmationVersion: conversion.rights_confirmation_version,
    reviewer: conversion.reviewer,
    items: itemViews
  };
};

type ReviewActor = { actor: string; note: string };

export const approveConversion = async (conversionId: string, review: ReviewActor): Promise<{ status: string; alreadyApproved: boolean; imageIds: string[] }> => {
  const pool = await getPool();
  const current = (await pool.query<ConversionRow>('select * from racepic_offer_conversion where id = $1', [conversionId])).rows[0];
  if (!current) throw new ConversionError('CONVERSION_NOT_FOUND');
  if (current.status === 'APPROVED') {
    const items = await loadItems(pool, conversionId);
    return { status: 'APPROVED', alreadyApproved: true, imageIds: items.map((item) => item.image_id) };
  }
  if (current.status !== 'READY_FOR_REVIEW') throw new ConversionError('CONVERSION_NOT_REVIEWABLE');

  const imageIds = await withTransaction(pool, async (tx) => {
    const locked = (await tx.query<ConversionRow>('select * from racepic_offer_conversion where id = $1 for update', [conversionId])).rows[0];
    if (locked.status !== 'READY_FOR_REVIEW') throw new ConversionError('CONVERSION_NOT_REVIEWABLE');
    const items = await loadItems(tx, conversionId);

    for (const item of items) {
      const image = (await tx.query<{ id: string; visibility: string; offer_mode: string; photographer_id: string }>(
        'select id, visibility, offer_mode, photographer_id from racepic_image where id = $1 for update',
        [item.image_id]
      )).rows[0];
      const active = (await tx.query<{ id: string }>(
        `select o.id from commerce_offer_version o join commerce_product p on p.id = o.product_id
          where p.racepic_image_id = $1 and o.status = 'ACTIVE'`,
        [item.image_id]
      )).rows[0];
      // Zwischenzeitlich entfernt, dem Fotografen entzogen oder das Angebot hat sich geaendert: nichts anwenden.
      if (!image || image.visibility === 'REMOVED' || image.offer_mode !== 'FREE' || image.photographer_id !== locked.photographer_id ||
          !active || active.id !== item.source_offer_version_id || item.artifact_status !== 'READY') {
        throw new ConversionError('CONVERSION_STALE');
      }
      await activatePendingOfferVersion(tx, item.target_offer_version_id as string);
      await tx.query(
        `update racepic_image set offer_mode = 'PAID', price_cents = $2, license_id = $3, updated_at = now() where id = $1`,
        [item.image_id, locked.target_price_cents, locked.target_license_id]
      );
      // Studio-Vorschau (uploads.ts) liest die wasserzeichenbehaftete Variante aus racepic_image_variant.
      await tx.query(
        `insert into racepic_image_variant (image_id, kind, s3_key, access)
         values ($1, 'watermarked_preview', $2, 'signed')
         on conflict (image_id, kind) do update set s3_key = excluded.s3_key, width = null, height = null, bytes = null`,
        [item.image_id, item.watermarked_preview_key]
      );
      await tx.query('update racepic_offer_conversion_item set is_open = false, updated_at = now() where id = $1', [item.id]);
    }
    await tx.query(
      `update racepic_offer_conversion
          set status = 'APPROVED', reviewer = $2, review_note = $3, decided_at = now(), updated_at = now()
        where id = $1`,
      [conversionId, review.actor, review.note]
    );
    return items.map((item) => item.image_id);
  });

  await finalizeConversion(conversionId).catch((error) =>
    logOperationalEvent('error', 'racepic_conversion.finalize_failed', { errorCode: (error as { code?: string })?.code ?? 'UNKNOWN' })
  );
  return { status: 'APPROVED', alreadyApproved: false, imageIds };
};

export const rejectConversion = async (conversionId: string, review: ReviewActor): Promise<{ status: string; alreadyRejected: boolean; imageIds: string[] }> => {
  const pool = await getPool();
  const result = await withTransaction(pool, async (tx) => {
    const locked = (await tx.query<ConversionRow>('select * from racepic_offer_conversion where id = $1 for update', [conversionId])).rows[0];
    if (!locked) throw new ConversionError('CONVERSION_NOT_FOUND');
    const items = await loadItems(tx, conversionId);
    if (locked.status === 'REJECTED') return { alreadyRejected: true, items };
    if (!['REQUESTED', 'PREPARING_ASSETS', 'READY_FOR_REVIEW'].includes(locked.status)) throw new ConversionError('CONVERSION_NOT_REVIEWABLE');
    await tx.query(
      `update commerce_offer_version set status = 'REJECTED', updated_at = now()
        where conversion_id = $1 and status in ('DRAFT', 'PENDING_REVIEW')`,
      [conversionId]
    );
    await tx.query('update racepic_offer_conversion_item set is_open = false, updated_at = now() where conversion_id = $1', [conversionId]);
    await tx.query(
      `update racepic_offer_conversion
          set status = 'REJECTED', reviewer = $2, review_note = $3, decided_at = now(), updated_at = now()
        where id = $1`,
      [conversionId, review.actor, review.note]
    );
    return { alreadyRejected: false, items };
  });
  if (!result.alreadyRejected) {
    // Best effort: die Ausgabe (FREE) hat sich nie geaendert; nur die vorbereiteten Artefakte werden entfernt.
    for (const item of result.items) {
      for (const key of [item.licensed_full_key, item.watermarked_thumb_key, item.watermarked_preview_key]) {
        if (key) await deleteObject(key).catch(() => undefined);
      }
    }
  }
  return { status: 'REJECTED', alreadyRejected: result.alreadyRejected, imageIds: result.items.map((item) => item.image_id) };
};

/**
 * Schliesst die Umstellung der oeffentlichen Ausgabe ab (idempotent, wiederholbar): versionierte
 * PAID-Vorschauen veroeffentlichen, Manifeste neu erzeugen, erst danach die alten oeffentlichen FREE-Objekte
 * entfernen und das CDN invalidieren. So verweist kein Manifest je auf ein bereits geloeschtes Objekt.
 * Downloads sind unabhaengig davon bereits mit der Freigabe gesperrt (offer_mode = 'PAID').
 */
export const finalizeConversion = async (conversionId: string): Promise<{ finalized: boolean }> => {
  const pool = await getPool();
  const conversion = (await pool.query<ConversionRow>('select * from racepic_offer_conversion where id = $1', [conversionId])).rows[0];
  if (!conversion) throw new ConversionError('CONVERSION_NOT_FOUND');
  if (conversion.status !== 'APPROVED') throw new ConversionError('CONVERSION_NOT_APPROVED');

  const items = await pool.query<{ image_id: string; event_id: string; photographer_id: string }>(
    `select i.image_id, img.event_id, img.photographer_id
       from racepic_offer_conversion_item i join racepic_image img on img.id = i.image_id
      where i.conversion_id = $1`,
    [conversionId]
  );
  for (const row of items.rows) await publishPublicObjectsForImage(row.image_id);
  for (const eventId of new Set(items.rows.map((row) => row.event_id))) await regenerateManifestsForEvent(eventId);
  for (const photographerId of new Set(items.rows.map((row) => row.photographer_id))) await regeneratePhotographerManifest(photographerId);
  for (const row of items.rows) {
    await deleteObject(freePublicKey(row.image_id, 'thumb'));
    await deleteObject(freePublicKey(row.image_id, 'preview'));
  }
  await invalidateCloudFront(items.rows.flatMap((row) => [`/public/${row.image_id}/*`]));
  await pool.query('update racepic_offer_conversion set finalized_at = now(), updated_at = now() where id = $1', [conversionId]);
  return { finalized: true };
};

export type { Pool, PoolClient };
