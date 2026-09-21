import { randomUUID } from 'node:crypto';
import { and, count, eq, inArray, isNull, ne } from 'drizzle-orm';
import { getDb } from '../db/client';
import {
  racepicEvent,
  racepicImage,
  racepicLicense,
  racepicPhotographerEvent,
  racepicUpload,
  racepicUploadBatch
} from '../db/schema';
import { RacePicError } from './repository';
import {
  abortMultipartUpload,
  buildIncomingKey,
  completeMultipartUpload,
  createMultipartUpload,
  deleteObject,
  headObject,
  listUploadedParts,
  presignPutObject,
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
  if (!license) {
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
  if (input.contentType !== 'image/jpeg') {
    throw new RacePicError('RACEPIC_UPLOAD_CONTENT_TYPE_UNSUPPORTED');
  }
  if (input.declaredSizeBytes <= 0 || input.declaredSizeBytes > MAX_UPLOAD_BYTES) {
    throw new RacePicError('RACEPIC_UPLOAD_SIZE_INVALID');
  }

  const db = await getDb();

  if (input.clientFingerprint) {
    const [existing] = await db
      .select({ id: racepicUpload.id })
      .from(racepicUpload)
      .where(
        and(
          eq(racepicUpload.batchId, input.batch.id),
          eq(racepicUpload.clientFingerprint, input.clientFingerprint),
          ne(racepicUpload.status, 'ABORTED'),
          ne(racepicUpload.status, 'EXPIRED')
        )
      )
      .limit(1);
    if (existing) {
      throw new RacePicError('RACEPIC_UPLOAD_DUPLICATE_IN_BATCH');
    }
  }

  // Quota wird pro Event-Zugang geprueft (racepic_photographer_event.quotaImages), nicht pro Batch -
  // ein Fotograf kann mehrere Batches fuer dasselbe Event anlegen.
  const [access] = await db
    .select()
    .from(racepicPhotographerEvent)
    .where(and(eq(racepicPhotographerEvent.photographerId, input.batch.photographerId), eq(racepicPhotographerEvent.eventId, input.batch.eventId)))
    .limit(1);
  if (access?.quotaImages !== null && access?.quotaImages !== undefined) {
    const [{ value: usedCount }] = await db
      .select({ value: count() })
      .from(racepicImage)
      .where(and(eq(racepicImage.eventId, input.batch.eventId), eq(racepicImage.photographerId, input.batch.photographerId), ne(racepicImage.processingStatus, 'FAILED')));
    if (usedCount >= access.quotaImages) {
      throw new RacePicError('RACEPIC_UPLOAD_QUOTA_EXCEEDED');
    }
  }

  const uploadId = randomUUID();
  const key = buildIncomingKey(input.batch.eventId, input.batch.photographerId, uploadId);
  const expiresAt = new Date(Date.now() + PRESIGN_EXPIRES_SECONDS * 1000);
  const useMultipart = input.declaredSizeBytes > MULTIPART_THRESHOLD_BYTES;

  const s3UploadId = useMultipart ? await createMultipartUpload(key, input.contentType) : null;

  const [upload] = await db
    .insert(racepicUpload)
    .values({
      id: uploadId,
      batchId: input.batch.id,
      s3Key: key,
      s3UploadId,
      fileName: input.fileName,
      contentType: input.contentType,
      declaredSizeBytes: input.declaredSizeBytes,
      clientFingerprint: input.clientFingerprint,
      status: useMultipart ? 'MULTIPART_OPEN' : 'INITIATED',
      expiresAt
    })
    .returning();
  if (!upload) throw new RacePicError('RACEPIC_UPLOAD_CREATE_FAILED');

  await db
    .update(racepicUploadBatch)
    .set({ fileCount: input.batch.fileCount + 1, updatedAt: new Date() })
    .where(eq(racepicUploadBatch.id, input.batch.id));

  if (useMultipart) {
    return { upload, uploadUrl: null as string | null };
  }
  const uploadUrl = await presignPutObject(key, input.contentType, PRESIGN_EXPIRES_SECONDS);
  return { upload, uploadUrl };
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
    await completeMultipartUpload(upload.s3Key, upload.s3UploadId, multipartParts);
  }

  const objectInfo = await headObject(upload.s3Key);
  if (!objectInfo) {
    throw new RacePicError('RACEPIC_UPLOAD_OBJECT_MISSING');
  }
  if (objectInfo.sizeBytes > MAX_UPLOAD_BYTES) {
    // Defensiv: sollte durch die Groessenpruefung in createUpload/Multipart-Teilgroessen nicht
    // vorkommen, wird aber trotzdem hart abgelehnt statt ein zu grosses Original zu behalten.
    await deleteObject(upload.s3Key);
    throw new RacePicError('RACEPIC_UPLOAD_SIZE_INVALID');
  }

  return db.transaction(async (tx) => {
    const [completedUpload] = await tx
      .update(racepicUpload)
      .set({ status: 'COMPLETED', completedAt: new Date() })
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
      .set({ completedCount: batch.completedCount + 1, updatedAt: new Date() })
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
  await db.update(racepicUpload).set({ status: 'ABORTED' }).where(eq(racepicUpload.id, upload.id));
  await db
    .update(racepicUploadBatch)
    .set({ failedCount: batch.failedCount + 1, updatedAt: new Date() })
    .where(eq(racepicUploadBatch.id, batch.id));
};

export const listMyImages = async (input: { photographerId: string; eventId?: string; status?: string; limit: number }) => {
  const db = await getDb();
  const conditions = [eq(racepicImage.photographerId, input.photographerId)];
  if (input.eventId) conditions.push(eq(racepicImage.eventId, input.eventId));
  if (input.status) conditions.push(eq(racepicImage.processingStatus, input.status));
  return db
    .select()
    .from(racepicImage)
    .where(and(...conditions))
    .orderBy(racepicImage.createdAt)
    .limit(input.limit);
};

/** Fuer den Reconciler (Paket 3): Uploads, die ihr Presign-Fenster ueberschritten haben. */
export const listExpiredOpenUploads = async (limit: number) => {
  const db = await getDb();
  const now = new Date();
  return db
    .select({ upload: racepicUpload, batch: racepicUploadBatch })
    .from(racepicUpload)
    .innerJoin(racepicUploadBatch, eq(racepicUploadBatch.id, racepicUpload.batchId))
    .where(and(inArray(racepicUpload.status, ['INITIATED', 'MULTIPART_OPEN']), isNull(racepicUpload.completedAt)))
    .limit(limit)
    .then((rows) => rows.filter((row) => row.upload.expiresAt.getTime() < now.getTime()));
};
