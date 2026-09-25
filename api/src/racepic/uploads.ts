import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { and, count, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import {
  racepicEvent,
  racepicImage,
  racepicImageVariant,
  racepicLicense,
  racepicPhotographerEvent,
  racepicUpload,
  racepicUploadBatch
} from '../db/schema';
import { RacePicError } from './repository';
import { hideImage, removeImage } from './publish';
import { renderWatermarkedPreview } from './imageProcessing';
import {
  abortMultipartUpload,
  buildIncomingKey,
  completeMultipartUpload,
  createMultipartUpload,
  deleteObject,
  getObject,
  headObject,
  listUploadedParts,
  presignGetObject,
  presignPutObject,
  putObject,
  presignUploadParts
} from './s3';

/**
 * Upload-Orchestrierung (Paket 3), siehe docs/memory-bank/racepic-architecture.md Abschnitt D.
 * Bild-/Metadatenvalidierung (Magic Bytes, EXIF, sha256) passiert erst im Ingest-Worker (Paket 4) -
 * hier wird nur serverseitig geprueft, was vor dem eigentlichen Hochladen feststeht (MIME laut
 * Client-Angabe, Groesse, Event-Berechtigung, Upload-Fenster, Quota).
 */

// Ab dieser Groesse wird ein S3-Multipart-Upload verwendet statt eines einzelnen Presigned PUT.
export const MULTIPART_THRESHOLD_BYTES = 16 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 80 * 1024 * 1024;
const PRESIGN_EXPIRES_SECONDS = 900;

export const createBatch = async (input: { photographerId: string; eventId: string; licenseId: string }) => {
  const db = await getDb();

  const [access] = await db
    .select()
    .from(racepicPhotographerEvent)
    .where(and(eq(racepicPhotographerEvent.photographerId, input.photographerId), eq(racepicPhotographerEvent.eventId, input.eventId)))
    .limit(1);
  if (!access) {
    throw new RacePicError('RACEPIC_EVENT_ACCESS_DENIED');
  }

  const [racepicEventRow] = await db.select().from(racepicEvent).where(eq(racepicEvent.eventId, input.eventId)).limit(1);
  if (!racepicEventRow?.enabled) throw new RacePicError('RACEPIC_EVENT_ACCESS_DENIED');
  const windowStart = access.uploadOpensAt ?? racepicEventRow?.uploadOpensAt ?? null;
  const windowEnd = access.uploadClosesAt ?? racepicEventRow?.uploadClosesAt ?? null;
  const now = new Date();
  if (windowStart && now < windowStart) throw new RacePicError('RACEPIC_UPLOAD_WINDOW_NOT_OPEN');
  if (windowEnd && now > windowEnd) throw new RacePicError('RACEPIC_UPLOAD_WINDOW_CLOSED');

  const [license] = await db
    .select()
    .from(racepicLicense)
    .where(and(eq(racepicLicense.id, input.licenseId), eq(racepicLicense.active, true)))
    .limit(1);
  if (!license || license.pricingKind !== 'FREE') {
    throw new RacePicError('RACEPIC_LICENSE_NOT_FOUND');
  }

  const [batch] = await db
    .insert(racepicUploadBatch)
    .values({ photographerId: input.photographerId, eventId: input.eventId, licenseId: input.licenseId })
    .returning();
  if (!batch) throw new RacePicError('RACEPIC_BATCH_CREATE_FAILED');
  return batch;
};

export const getBatchForPhotographer = async (batchId: string, photographerId: string) => {
  const db = await getDb();
  const [batch] = await db
    .select()
    .from(racepicUploadBatch)
    .where(and(eq(racepicUploadBatch.id, batchId), eq(racepicUploadBatch.photographerId, photographerId)))
    .limit(1);
  return batch ?? null;
};

export const createUpload = async (input: {
  batch: typeof racepicUploadBatch.$inferSelect;
  fileName: string;
  contentType: string;
  declaredSizeBytes: number;
  clientFingerprint: string | null;
}) => {
  if (input.contentType !== 'image/jpeg' && input.contentType !== 'image/png') {
    throw new RacePicError('RACEPIC_UPLOAD_CONTENT_TYPE_UNSUPPORTED');
  }
  if (input.declaredSizeBytes <= 0 || input.declaredSizeBytes > MAX_UPLOAD_BYTES) {
    throw new RacePicError('RACEPIC_UPLOAD_SIZE_INVALID');
  }

  const db = await getDb();

  const uploadId = randomUUID();
  const key = buildIncomingKey(input.batch.eventId, input.batch.photographerId, uploadId);
  const expiresAt = new Date(Date.now() + PRESIGN_EXPIRES_SECONDS * 1000);
  const useMultipart = input.declaredSizeBytes > MULTIPART_THRESHOLD_BYTES;

  const reservation = await db.transaction(async (tx) => {
    await tx.select({ id: racepicPhotographerEvent.id }).from(racepicPhotographerEvent)
      .where(and(eq(racepicPhotographerEvent.photographerId, input.batch.photographerId), eq(racepicPhotographerEvent.eventId, input.batch.eventId)))
      .for('update');

    if (input.clientFingerprint) {
      const [existing] = await tx.select().from(racepicUpload).where(and(
        eq(racepicUpload.batchId, input.batch.id),
        eq(racepicUpload.clientFingerprint, input.clientFingerprint),
        inArray(racepicUpload.status, ['INITIALIZING', 'INITIATED', 'MULTIPART_OPEN', 'COMPLETED'])
      )).limit(1);
      if (existing) {
        if (existing.fileName !== input.fileName || existing.contentType !== input.contentType || existing.declaredSizeBytes !== input.declaredSizeBytes) {
          throw new RacePicError('RACEPIC_UPLOAD_DUPLICATE_IN_BATCH');
        }
        return { existing } as const;
      }
    }

    const [access] = await tx.select().from(racepicPhotographerEvent)
      .where(and(eq(racepicPhotographerEvent.photographerId, input.batch.photographerId), eq(racepicPhotographerEvent.eventId, input.batch.eventId))).limit(1);
    if (!access) throw new RacePicError('RACEPIC_EVENT_ACCESS_DENIED');
    if (access.quotaImages !== null) {
      const [{ value: imageCount }] = await tx.select({ value: count() }).from(racepicImage)
        .where(and(eq(racepicImage.eventId, input.batch.eventId), eq(racepicImage.photographerId, input.batch.photographerId), ne(racepicImage.processingStatus, 'FAILED')));
      const [{ value: openUploadCount }] = await tx.select({ value: count() }).from(racepicUpload)
        .innerJoin(racepicUploadBatch, eq(racepicUploadBatch.id, racepicUpload.batchId))
        .where(and(
          eq(racepicUploadBatch.eventId, input.batch.eventId),
          eq(racepicUploadBatch.photographerId, input.batch.photographerId),
          inArray(racepicUpload.status, ['INITIALIZING', 'INITIATED', 'MULTIPART_OPEN'])
        ));
      if (imageCount + openUploadCount >= access.quotaImages) throw new RacePicError('RACEPIC_UPLOAD_QUOTA_EXCEEDED');
    }

    const [created] = await tx.insert(racepicUpload).values({
      id: uploadId,
      batchId: input.batch.id,
      s3Key: key,
      fileName: input.fileName,
      contentType: input.contentType,
      declaredSizeBytes: input.declaredSizeBytes,
      clientFingerprint: input.clientFingerprint,
      status: 'INITIALIZING',
      expiresAt
    }).returning();
    if (!created) throw new RacePicError('RACEPIC_UPLOAD_CREATE_FAILED');
    await tx.update(racepicUploadBatch).set({ fileCount: sql`${racepicUploadBatch.fileCount} + 1`, updatedAt: new Date() }).where(eq(racepicUploadBatch.id, input.batch.id));
    return { created } as const;
  });

  if ('existing' in reservation) {
    const existing = reservation.existing;
    if (!existing) throw new RacePicError('RACEPIC_UPLOAD_CREATE_FAILED');
    const uploadUrl = existing.status === 'INITIATED'
      ? await presignPutObject(existing.s3Key, existing.contentType, existing.declaredSizeBytes, PRESIGN_EXPIRES_SECONDS)
      : null;
    return { upload: existing, uploadUrl, resumed: true, completed: existing.status === 'COMPLETED' };
  }

  let s3UploadId: string | null = null;
  try {
    s3UploadId = useMultipart ? await createMultipartUpload(key, input.contentType) : null;
    const [upload] = await db.update(racepicUpload).set({
      s3UploadId,
      status: useMultipart ? 'MULTIPART_OPEN' : 'INITIATED',
      updatedAt: new Date()
    }).where(eq(racepicUpload.id, uploadId)).returning();
    if (!upload) throw new RacePicError('RACEPIC_UPLOAD_CREATE_FAILED');
    const uploadUrl = useMultipart ? null : await presignPutObject(key, input.contentType, input.declaredSizeBytes, PRESIGN_EXPIRES_SECONDS);
    return { upload, uploadUrl, resumed: false, completed: false };
  } catch (error) {
    if (s3UploadId) await abortMultipartUpload(key, s3UploadId).catch(() => undefined);
    await db.update(racepicUpload).set({ status: 'FAILED', updatedAt: new Date() }).where(eq(racepicUpload.id, uploadId));
    await db.update(racepicUploadBatch).set({ failedCount: sql`${racepicUploadBatch.failedCount} + 1`, updatedAt: new Date() }).where(eq(racepicUploadBatch.id, input.batch.id));
    throw error;
  }
};

export const getUploadForPhotographer = async (uploadId: string, photographerId: string) => {
  const db = await getDb();
  const rows = await db
    .select({ upload: racepicUpload, batch: racepicUploadBatch })
    .from(racepicUpload)
    .innerJoin(racepicUploadBatch, eq(racepicUploadBatch.id, racepicUpload.batchId))
    .where(and(eq(racepicUpload.id, uploadId), eq(racepicUploadBatch.photographerId, photographerId)))
    .limit(1);
  return rows[0] ?? null;
};

export const presignRemainingParts = async (upload: typeof racepicUpload.$inferSelect, partNumbers: number[]) => {
  if (!upload.s3UploadId) {
    throw new RacePicError('RACEPIC_UPLOAD_NOT_MULTIPART');
  }
  return presignUploadParts(upload.s3Key, upload.s3UploadId, partNumbers);
};

export const listPartsForResume = async (upload: typeof racepicUpload.$inferSelect) => {
  if (!upload.s3UploadId) {
    throw new RacePicError('RACEPIC_UPLOAD_NOT_MULTIPART');
  }
  return listUploadedParts(upload.s3Key, upload.s3UploadId);
};

/**
 * Schliesst einen Upload ab: bei Multipart wird der S3-Upload zusammengefuehrt, sonst nur die
 * Existenz/Groesse des einzeln hochgeladenen Objekts geprueft. Idempotent - ein zweiter Aufruf mit
 * bereits COMPLETED gibt einfach das bestehende Bild zurueck (siehe racepic-architecture.md
 * Abschnitt D: "Das ist idempotent ueber die upload_id").
 */
export const completeUpload = async (
  upload: typeof racepicUpload.$inferSelect,
  batch: typeof racepicUploadBatch.$inferSelect,
  multipartParts: { partNumber: number; eTag: string }[] | undefined
) => {
  const db = await getDb();

  if (upload.status === 'COMPLETED') {
    const [existingImage] = await db.select().from(racepicImage).where(eq(racepicImage.uploadId, upload.id)).limit(1);
    return { image: existingImage ?? null, alreadyCompleted: true };
  }
  if (upload.status !== 'INITIATED' && upload.status !== 'MULTIPART_OPEN') {
    throw new RacePicError('RACEPIC_UPLOAD_NOT_COMPLETABLE');
  }

  if (upload.s3UploadId) {
    if (!multipartParts || multipartParts.length === 0) {
      throw new RacePicError('RACEPIC_UPLOAD_PARTS_REQUIRED');
    }
    const storedParts = await listUploadedParts(upload.s3Key, upload.s3UploadId);
    const submitted = new Map(multipartParts.map((part) => [part.partNumber, part.eTag.replaceAll('"', '')]));
    const contiguous = storedParts.every((part, index) => part.partNumber === index + 1);
    const exactParts = storedParts.length === multipartParts.length && storedParts.every(
      (part) => submitted.get(part.partNumber) === part.eTag.replaceAll('"', '')
    );
    const exactSize = storedParts.reduce((sum, part) => sum + part.size, 0) === upload.declaredSizeBytes;
    if (!contiguous || !exactParts || !exactSize) throw new RacePicError('RACEPIC_UPLOAD_PARTS_INVALID');
    await completeMultipartUpload(upload.s3Key, upload.s3UploadId, storedParts.map((part) => ({ partNumber: part.partNumber, eTag: part.eTag })));
  }

  const objectInfo = await headObject(upload.s3Key);
  if (!objectInfo) {
    throw new RacePicError('RACEPIC_UPLOAD_OBJECT_MISSING');
  }
  if (objectInfo.sizeBytes !== upload.declaredSizeBytes || objectInfo.contentType !== upload.contentType) {
    await deleteObject(upload.s3Key);
    throw new RacePicError('RACEPIC_UPLOAD_SIZE_INVALID');
  }

  return db.transaction(async (tx) => {
    const [completedUpload] = await tx
      .update(racepicUpload)
      .set({ status: 'COMPLETED', completedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(racepicUpload.id, upload.id), inArray(racepicUpload.status, ['INITIATED', 'MULTIPART_OPEN'])))
      .returning();
    if (!completedUpload) {
      // Race: ein paralleler Complete-Aufruf war schneller.
      const [existingImage] = await tx.select().from(racepicImage).where(eq(racepicImage.uploadId, upload.id)).limit(1);
      return { image: existingImage ?? null, alreadyCompleted: true };
    }

    const [image] = await tx
      .insert(racepicImage)
      .values({
        eventId: batch.eventId,
        photographerId: batch.photographerId,
        batchId: batch.id,
        uploadId: upload.id,
        licenseId: batch.licenseId,
        bytes: objectInfo.sizeBytes,
        processingStatus: 'UPLOADED',
        visibility: 'DRAFT',
        offerMode: 'FREE'
      })
      .returning();
    if (!image) throw new RacePicError('RACEPIC_IMAGE_CREATE_FAILED');

    await tx
      .update(racepicUploadBatch)
      .set({ completedCount: sql`${racepicUploadBatch.completedCount} + 1`, updatedAt: new Date() })
      .where(eq(racepicUploadBatch.id, batch.id));

    return { image, alreadyCompleted: false };
  });
};

export const abortUpload = async (upload: typeof racepicUpload.$inferSelect, batch: typeof racepicUploadBatch.$inferSelect) => {
  if (upload.status === 'COMPLETED') {
    throw new RacePicError('RACEPIC_UPLOAD_ALREADY_COMPLETED');
  }
  if (upload.s3UploadId) {
    await abortMultipartUpload(upload.s3Key, upload.s3UploadId).catch(() => undefined);
  } else {
    await deleteObject(upload.s3Key);
  }
  const db = await getDb();
  await db.update(racepicUpload).set({ status: 'ABORTED', updatedAt: new Date() }).where(eq(racepicUpload.id, upload.id));
  await db
    .update(racepicUploadBatch)
    .set({ failedCount: sql`${racepicUploadBatch.failedCount} + 1`, updatedAt: new Date() })
    .where(eq(racepicUploadBatch.id, batch.id));
};

// Bilder, deren processing_status vor DERIVED liegt, haben noch keine `derived/{id}/thumb.webp`
// (die legt erst der Ingest-Worker an, siehe ingestWorker.ts) - fuer die gilt kein Presign-Versuch.
const HAS_THUMB_STATUSES = ['DERIVED', 'ANALYZED', 'MATCHED'];

/**
 * Fuer die "Meine Bilder"-Ansicht im Studio (Paket 15): dieselbe presignte Vorschau-URL wie in der
 * Admin-Bildliste (`adminEvents.listImagesForEvent`, Paket 11) - auch unveroeffentlichte, private
 * eigene Bilder sollen fuer den Fotografen sichtbar sein, nicht nur nach der Veroeffentlichung.
 */
export const listMyImages = async (input: { photographerId: string; eventId?: string; status?: string; limit: number }) => {
  const db = await getDb();
  const conditions = [eq(racepicImage.photographerId, input.photographerId)];
  if (input.eventId) conditions.push(eq(racepicImage.eventId, input.eventId));
  if (input.status) conditions.push(eq(racepicImage.processingStatus, input.status));
  const rows = await db
    .select()
    .from(racepicImage)
    .where(and(...conditions))
    .orderBy(desc(racepicImage.createdAt))
    .limit(input.limit);

  return Promise.all(
    rows.map(async (row) => ({
      ...row,
      thumbUrl: row.visibility !== 'REMOVED' && HAS_THUMB_STATUSES.includes(row.processingStatus)
        ? await presignGetObject(`derived/${row.id}/thumb.webp`, 300).catch(() => null)
        : null,
      previewUrl: row.visibility !== 'REMOVED' && HAS_THUMB_STATUSES.includes(row.processingStatus)
        ? await presignGetObject(`derived/${row.id}/${row.offerMode === 'PAID' ? 'watermarked_preview' : 'preview'}.webp`, 300).catch(() => null)
        : null
    }))
  );
};

export type OwnImageDetailsPatch = {
  title?: string | null;
  description?: string | null;
  tags?: string[];
  licenseId?: string;
  offerMode?: 'FREE' | 'PAID';
  priceCents?: number | null;
};

export const updateOwnImageDetails = async (photographerId: string, imageId: string, patch: OwnImageDetailsPatch) => {
  const db = await getDb();
  const [image] = await db.select().from(racepicImage).where(eq(racepicImage.id, imageId)).limit(1);
  if (!image || image.photographerId !== photographerId || image.visibility === 'REMOVED') {
    throw new RacePicError('RACEPIC_IMAGE_NOT_FOUND');
  }
  const changingOffer = patch.offerMode !== undefined || patch.priceCents !== undefined;
  if ((patch.licenseId !== undefined || changingOffer) && image.visibility !== 'DRAFT') {
    throw new RacePicError('RACEPIC_IMAGE_LICENSE_LOCKED');
  }
  const nextOfferMode = patch.offerMode ?? image.offerMode;
  const nextPriceCents = patch.priceCents !== undefined ? patch.priceCents : image.priceCents;
  if ((nextOfferMode === 'FREE' && nextPriceCents !== null) || (nextOfferMode === 'PAID' && (!nextPriceCents || nextPriceCents <= 0))) {
    throw new RacePicError('RACEPIC_IMAGE_PRICE_INVALID');
  }
  const nextLicenseId = patch.licenseId ?? image.licenseId;
  if (patch.licenseId !== undefined || changingOffer) {
    const [license] = await db.select().from(racepicLicense).where(eq(racepicLicense.id, nextLicenseId)).limit(1);
    if (!license || !license.active || license.pricingKind !== nextOfferMode) {
      throw new RacePicError('RACEPIC_IMAGE_LICENSE_INVALID');
    }
  }
  if (nextOfferMode === 'PAID' && image.offerMode !== 'PAID') {
    if (!HAS_THUMB_STATUSES.includes(image.processingStatus)) throw new RacePicError('RACEPIC_IMAGE_NOT_READY_TO_PRICE');
    const source = await getObject(`derived/${imageId}/preview.webp`);
    if (!source) throw new RacePicError('RACEPIC_IMAGE_NOT_READY_TO_PRICE');
    const buffer = await renderWatermarkedPreview(source);
    const key = `derived/${imageId}/watermarked_preview.webp`;
    await putObject(key, buffer, 'image/webp');
    const metadata = await sharp(buffer).metadata();
    await db.insert(racepicImageVariant).values({ imageId, kind: 'watermarked_preview', s3Key: key, width: metadata.width, height: metadata.height, bytes: buffer.length, access: 'signed' })
      .onConflictDoUpdate({ target: [racepicImageVariant.imageId, racepicImageVariant.kind], set: { s3Key: key, width: metadata.width, height: metadata.height, bytes: buffer.length } });
  }
  const [updated] = await db.update(racepicImage).set({
    ...patch,
    title: patch.title === undefined ? image.title : patch.title,
    description: patch.description === undefined ? image.description : patch.description,
    tags: patch.tags === undefined ? image.tags : patch.tags,
    licenseId: nextLicenseId,
    offerMode: nextOfferMode,
    priceCents: nextPriceCents,
    updatedAt: new Date()
  }).where(eq(racepicImage.id, imageId)).returning();
  return updated;
};

/** Fuer den Reconciler (Paket 3): Uploads, die ihr Presign-Fenster ueberschritten haben. */
export const listExpiredOpenUploads = async (limit: number) => {
  const db = await getDb();
  const now = new Date();
  return db
    .select({ upload: racepicUpload, batch: racepicUploadBatch })
    .from(racepicUpload)
    .innerJoin(racepicUploadBatch, eq(racepicUploadBatch.id, racepicUpload.batchId))
    .where(and(inArray(racepicUpload.status, ['INITIALIZING', 'INITIATED', 'MULTIPART_OPEN']), isNull(racepicUpload.completedAt)))
    .limit(limit)
    .then((rows) => rows.filter((row) => row.upload.expiresAt.getTime() < now.getTime()));
};

/**
 * Bild-Selbstverwaltung fuer Fotograf:innen (Paket 15), siehe Architekturplan Abschnitt H
 * ("`PATCH /photographer/images/{id}` ... verbergen, `DELETE` (Stufe recent)") - war seit Paket 3
 * vorgesehen, aber nie gebaut (derselbe Musterfund wie bei Paket 5/7/11).
 *
 * Bewusst eingeschraenkt: ein Fotograf darf sein eigenes Bild **verbergen**, aber nicht selbst
 * veroeffentlichen oder endgueltig entfernen (das bleibt Admin-Moderation, siehe `publish.ts`
 * `publishImage`/`removeImage`) - und **loeschen** nur, solange es noch nie veroeffentlicht war
 * (`visibility='DRAFT'`), danach nur ueber den Admin-Weg (Audit-Trail bleibt erhalten).
 */
export const hideOwnImage = async (photographerId: string, imageId: string): Promise<void> => {
  const db = await getDb();
  const [image] = await db.select().from(racepicImage).where(eq(racepicImage.id, imageId)).limit(1);
  if (!image || image.photographerId !== photographerId) throw new RacePicError('RACEPIC_IMAGE_NOT_FOUND');
  if (image.visibility === 'REMOVED') throw new RacePicError('RACEPIC_IMAGE_ALREADY_REMOVED');
  await hideImage(imageId);
};

export const deleteOwnDraftImage = async (photographerId: string, imageId: string): Promise<void> => {
  const db = await getDb();
  const [image] = await db.select().from(racepicImage).where(eq(racepicImage.id, imageId)).limit(1);
  if (!image || image.photographerId !== photographerId) throw new RacePicError('RACEPIC_IMAGE_NOT_FOUND');
  if (image.visibility !== 'DRAFT') throw new RacePicError('RACEPIC_IMAGE_NOT_DELETABLE');

  const variants = await db.select({ s3Key: racepicImageVariant.s3Key }).from(racepicImageVariant).where(eq(racepicImageVariant.imageId, imageId));
  await Promise.all(variants.map((variant) => deleteObject(variant.s3Key)));
  if (image.originalKey) await deleteObject(image.originalKey);

  await db.delete(racepicImageVariant).where(eq(racepicImageVariant.imageId, imageId));
  await db.delete(racepicImage).where(eq(racepicImage.id, imageId));
};

/**
 * Nimmt ein eigenes Bild komplett raus, unabhaengig vom Status (Feedback 2026-09-22: "auch als
 * Fotograf will ich mal Fotos rausnehmen können wieder" - bisher konnte ein Fotograf ein bereits
 * veroeffentlichtes eigenes Bild nur verbergen (`hideOwnImage`), nie wirklich entfernen; das blieb
 * bislang Admin-Moderation vorbehalten). Ein DRAFT-Bild (noch nie oeffentlich) wird weiterhin
 * hart geloescht wie bisher (`deleteOwnDraftImage`, kein Audit-Wert); alles andere laeuft ueber
 * denselben `removeImage` wie beim Admin-"Entfernen" (S3 aufraeumen, visibility='REMOVED', Audit
 * bleibt) - der Aufrufer (handler.ts) muss danach wie beim Admin-Pfad die Manifeste neu erzeugen.
 */
export const removeOwnImage = async (photographerId: string, imageId: string): Promise<{ eventId: string }> => {
  const db = await getDb();
  const [image] = await db.select().from(racepicImage).where(eq(racepicImage.id, imageId)).limit(1);
  if (!image || image.photographerId !== photographerId) throw new RacePicError('RACEPIC_IMAGE_NOT_FOUND');
  if (image.visibility === 'REMOVED') throw new RacePicError('RACEPIC_IMAGE_ALREADY_REMOVED');

  if (image.visibility === 'DRAFT') {
    await deleteOwnDraftImage(photographerId, imageId);
  } else {
    await removeImage(imageId);
  }
  return { eventId: image.eventId };
};
