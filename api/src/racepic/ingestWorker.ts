import { SQSEvent, SQSBatchResponse } from 'aws-lambda';
import { and, eq, isNotNull, ne } from 'drizzle-orm';
import { getDb } from '../db/client';
import { racepicImage, racepicImageVariant, racepicPhotographer, racepicProcessingStep, racepicUpload } from '../db/schema';
import { logOperationalEvent, errorCodeOf } from '../observability/logger';
import { computeSha256, decodeImage, detectSupportedImageFormat, extractExif, renderVariants } from './imageProcessing';
import { deleteObject, getObject, putObject } from './s3';
import { sendAnalyzeMessage } from './queues';

/**
 * RacePicIngestWorker (Paket 4), konsumiert die Ingest-Queue aus infra/lib/stacks/racepic-stack.ts.
 * Siehe docs/memory-bank/racepic-architecture.md Abschnitt F ("Ingest") und G ("Storage").
 *
 * Idempotent ueber racepic_processing_step (image_id, step='ingest', pipeline_version) - ein
 * erneut zugestelltes SQS-Event (at-least-once) fuehrt zu keiner doppelten Verarbeitung.
 */
export const PIPELINE_VERSION = '2026-09-21.1';

const buildOriginalKey = (eventId: string, imageId: string, extension: string): string => `originals/${eventId}/${imageId}.${extension}`;
const buildDerivedKey = (imageId: string, kind: string, extension: string): string => `derived/${imageId}/${kind}.${extension}`;

const markImageFailed = async (imageId: string, message: string) => {
  const db = await getDb();
  await db.update(racepicImage).set({ processingStatus: 'FAILED', processingError: message.slice(0, 500), updatedAt: new Date() }).where(eq(racepicImage.id, imageId));
};

const processOneImage = async (imageId: string): Promise<void> => {
  const db = await getDb();

  // Idempotenz: ein bereits abgeschlossener Lauf fuer dieselbe Pipeline-Version wird uebersprungen.
  const [existingStep] = await db
    .select()
    .from(racepicProcessingStep)
    .where(and(eq(racepicProcessingStep.imageId, imageId), eq(racepicProcessingStep.step, 'ingest'), eq(racepicProcessingStep.pipelineVersion, PIPELINE_VERSION)))
    .limit(1);
  if (existingStep?.status === 'DONE') {
    return;
  }
  if (!existingStep) {
    await db.insert(racepicProcessingStep).values({ imageId, step: 'ingest', pipelineVersion: PIPELINE_VERSION, status: 'IN_PROGRESS' }).onConflictDoNothing();
  }

  const [image] = await db.select().from(racepicImage).where(eq(racepicImage.id, imageId)).limit(1);
  if (!image) {
    // Bild wurde zwischenzeitlich geloescht (z. B. Fotograf hat den Upload abgebrochen) - kein Fehler.
    return;
  }
  if (!image.uploadId) {
    throw new Error('RACEPIC_INGEST_MISSING_UPLOAD_REFERENCE');
  }
  const [upload] = await db.select().from(racepicUpload).where(eq(racepicUpload.id, image.uploadId)).limit(1);
  if (!upload) {
    throw new Error('RACEPIC_INGEST_UPLOAD_ROW_MISSING');
  }

  const originalBuffer = await getObject(upload.s3Key);
  if (!originalBuffer) {
    throw new Error('RACEPIC_INGEST_OBJECT_MISSING');
  }
  const imageFormat = detectSupportedImageFormat(originalBuffer);
  if (!imageFormat) {
    await markImageFailed(imageId, 'Not a valid JPEG/PNG (magic bytes check failed)');
    await deleteObject(upload.s3Key);
    return;
  }

  const sha256 = computeSha256(originalBuffer);

  // Dedup innerhalb desselben Events (Abschnitt Image: eventSha256Unique-Index). REMOVED-Bilder
  // zaehlen bewusst nicht mit (Bug gefunden 2026-09-22: sonst blockiert ein entferntes Bild den
  // Re-Upload derselben Datei fuer immer, siehe migrations/0101_racepic_removed_images_free_sha256.sql).
  const [existingWithSameHash] = await db
    .select({ id: racepicImage.id })
    .from(racepicImage)
    .where(and(
      eq(racepicImage.eventId, image.eventId),
      eq(racepicImage.sha256, sha256),
      ne(racepicImage.id, imageId),
      isNotNull(racepicImage.sha256),
      ne(racepicImage.visibility, 'REMOVED')
    ))
    .limit(1);
  if (existingWithSameHash) {
    await db
      .update(racepicImage)
      .set({ processingStatus: 'DUPLICATE', sha256, bytes: originalBuffer.length, updatedAt: new Date() })
      .where(eq(racepicImage.id, imageId));
    await deleteObject(upload.s3Key);
    await db
      .update(racepicProcessingStep)
      .set({ status: 'DONE', finishedAt: new Date() })
      .where(and(eq(racepicProcessingStep.imageId, imageId), eq(racepicProcessingStep.step, 'ingest'), eq(racepicProcessingStep.pipelineVersion, PIPELINE_VERSION)));
    return;
  }

  let decoded;
  try {
    decoded = await decodeImage(originalBuffer);
  } catch {
    await markImageFailed(imageId, 'Image could not be decoded');
    await deleteObject(upload.s3Key);
    return;
  }

  const exif = await extractExif(originalBuffer);

  const [photographer] = await db.select().from(racepicPhotographer).where(eq(racepicPhotographer.id, image.photographerId)).limit(1);
  const copyrightLine = photographer?.copyrightLine || `© ${photographer?.displayName ?? 'RacePic'}`;
  const variants = await renderVariants(originalBuffer, copyrightLine);

  const originalKey = buildOriginalKey(image.eventId, imageId, imageFormat === 'png' ? 'png' : 'jpg');
  await putObject(originalKey, originalBuffer, imageFormat === 'png' ? 'image/png' : 'image/jpeg');
  await deleteObject(upload.s3Key);

  for (const variant of variants) {
    const extension = variant.contentType === 'image/webp' ? 'webp' : 'jpg';
    const key = buildDerivedKey(imageId, variant.kind, extension);
    const contentDisposition =
      variant.kind === 'medium' || variant.kind === 'large' ? `attachment; filename="racepic-${imageId}-${variant.kind}.${extension}"` : undefined;
    await putObject(key, variant.buffer, variant.contentType, contentDisposition);
    await db
      .insert(racepicImageVariant)
      .values({
        imageId,
        kind: variant.kind,
        s3Key: key,
        width: variant.width,
        height: variant.height,
        bytes: variant.buffer.length,
        access: 'signed'
      })
      .onConflictDoNothing();
  }

  await db
    .update(racepicImage)
    .set({
      originalKey,
      sha256,
      bytes: originalBuffer.length,
      width: decoded.width,
      height: decoded.height,
      capturedAt: exif.capturedAt,
      camera: exif.camera,
      processingStatus: 'DERIVED',
      processingError: null,
      updatedAt: new Date()
    })
    .where(eq(racepicImage.id, imageId));

  await db
    .update(racepicProcessingStep)
    .set({ status: 'DONE', finishedAt: new Date() })
    .where(and(eq(racepicProcessingStep.imageId, imageId), eq(racepicProcessingStep.step, 'ingest'), eq(racepicProcessingStep.pipelineVersion, PIPELINE_VERSION)));

  // Naechste Pipeline-Stufe (Paket 6: KI-Analyse). Bis Paket 6 existiert, bleibt die Nachricht
  // einfach in der Analyze-Queue liegen (Retention 4 Tage) - kein Fehlerfall.
  await sendAnalyzeMessage(imageId).catch((error) =>
    logOperationalEvent('error', 'racepic_ingest.analyze_enqueue_failed', { errorCode: errorCodeOf(error) })
  );
};

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    try {
      const body = JSON.parse(record.body) as { imageId?: string };
      if (!body.imageId) {
        throw new Error('RACEPIC_INGEST_MISSING_IMAGE_ID');
      }
      await processOneImage(body.imageId);
    } catch (error) {
      logOperationalEvent('error', 'racepic_ingest.failed', { errorCode: errorCodeOf(error) });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};
