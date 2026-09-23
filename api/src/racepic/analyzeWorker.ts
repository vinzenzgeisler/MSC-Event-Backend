import { randomUUID } from 'node:crypto';
import { SQSEvent, SQSBatchResponse } from 'aws-lambda';
import sharp from 'sharp';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { racepicAiAnalysis, racepicDetection, racepicImage, racepicProcessingStep, racepicTextDetection } from '../db/schema';
import { logOperationalEvent, errorCodeOf } from '../observability/logger';
import { detectText, detectVehicles, isTextInsideVehicle, nearestContainingVehicleIndex, type TextDetectionResult } from './rekognition';
import { embedImage } from './bedrock';
import { getObject, putObject } from './s3';
import { sendMatchMessage } from './queues';

/**
 * RacePicAnalyzeWorker (Paket 6: KI-Pipeline), konsumiert die Analyze-Queue. Siehe
 * docs/memory-bank/racepic-architecture.md Abschnitt F. Idempotent ueber `racepic_processing_step`
 * (step='analyze'), analog zum Ingest-Worker (Paket 4).
 */
export const PIPELINE_VERSION = '2026-09-22.2';

const derivedKey = (imageId: string, kind: string): string => `derived/${imageId}/${kind}.jpg`;

const toPixelBox = (bbox: { left: number; top: number; width: number; height: number }, imgWidth: number, imgHeight: number) => {
  const left = Math.min(imgWidth - 1, Math.max(0, Math.round(bbox.left * imgWidth)));
  const top = Math.min(imgHeight - 1, Math.max(0, Math.round(bbox.top * imgHeight)));
  const width = Math.max(1, Math.min(imgWidth - left, Math.round(bbox.width * imgWidth)));
  const height = Math.max(1, Math.min(imgHeight - top, Math.round(bbox.height * imgHeight)));
  return { left, top, width, height };
};

const processOneImage = async (imageId: string): Promise<void> => {
  const db = await getDb();

  const [existingStep] = await db
    .select()
    .from(racepicProcessingStep)
    .where(and(eq(racepicProcessingStep.imageId, imageId), eq(racepicProcessingStep.step, 'analyze'), eq(racepicProcessingStep.pipelineVersion, PIPELINE_VERSION)))
    .limit(1);
  if (existingStep?.status === 'DONE') return;
  if (!existingStep) {
    await db.insert(racepicProcessingStep).values({ imageId, step: 'analyze', pipelineVersion: PIPELINE_VERSION, status: 'IN_PROGRESS' }).onConflictDoNothing();
  }

  const [image] = await db.select().from(racepicImage).where(eq(racepicImage.id, imageId)).limit(1);
  if (!image) return; // geloescht, bevor die Analyse dran war.
  if (image.processingStatus !== 'DERIVED' && image.processingStatus !== 'ANALYZED') {
    // Noch nicht durch den Ingest-Worker fertig verarbeitet (oder fehlgeschlagen) - ueberspringen,
    // die Nachricht wird nicht erneut eingereiht.
    return;
  }
  if (!image.width || !image.height) {
    throw new Error('RACEPIC_ANALYZE_MISSING_DIMENSIONS');
  }

  // Grosse Variante fuer die Analyse (bessere Trefferquote bei kleinen Startnummern als thumb/preview).
  const largeBuffer = await getObject(derivedKey(imageId, 'large'));
  if (!largeBuffer) throw new Error('RACEPIC_ANALYZE_VARIANT_MISSING');

  const [vehicles, initialTexts] = await Promise.all([detectVehicles(largeBuffer), detectText(largeBuffer)]);

  // Fahrzeug-Crops fuer die visuelle Aehnlichkeit (Abschnitt F: "Titan Multimodal Embedding je
  // Fahrzeug-Crop", hier Cohere Embed v4). Metadata.width/height aus dem großen Derivat, nicht dem
  // Original - die BBoxen von Rekognition beziehen sich auf das analysierte Bild (large).
  const largeVariantMeta = await sharp(largeBuffer).metadata();
  const largeWidth = largeVariantMeta.width ?? image.width;
  const largeHeight = largeVariantMeta.height ?? image.height;

  // Eine zweite, begrenzte OCR-Pruefung fuer Fahrzeuge ohne zugeordneten Text. Ein
  // fremdes Text-Token im Hintergrund darf den Crop nicht unterdruecken.
  const texts: TextDetectionResult[] = [...initialTexts];
  let cropOcrAttempts = 0;
  const vehiclesMissingText = vehicles.filter((vehicle) => !initialTexts.some((text) => isTextInsideVehicle(text.bbox, vehicle.bbox)));
  if (vehiclesMissingText.length > 0) {
    for (const vehicle of [...vehiclesMissingText].sort((a, b) => b.confidence - a.confidence).slice(0, 2)) {
      const box = vehicle.bbox;
      if (box.width * box.height >= 0.9) continue;
      cropOcrAttempts += 1;
      try {
        const crop = await sharp(largeBuffer).extract(toPixelBox(box, largeWidth, largeHeight)).resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
        const cropTexts = await detectText(crop);
        for (const text of cropTexts) texts.push({ ...text, bbox: {
          left: box.left + text.bbox.left * box.width,
          top: box.top + text.bbox.top * box.height,
          width: text.bbox.width * box.width,
          height: text.bbox.height * box.height
        } });
      } catch (error) {
        logOperationalEvent('error', 'racepic_analyze.crop_ocr_failed', { errorCode: errorCodeOf(error) });
      }
    }
  }

  const rawResultKey = `analysis/${imageId}/rekognition-${randomUUID()}.json`;
  await putObject(rawResultKey, Buffer.from(JSON.stringify({ vehicles, texts, cropOcrAttempts })), 'application/json');
  await db.insert(racepicAiAnalysis).values({
    imageId, service: 'rekognition', operation: 'detect_labels+detect_text', pipelineVersion: PIPELINE_VERSION,
    finishedAt: new Date(), rawResultKey, summary: { vehicleCount: vehicles.length, textCount: texts.length, cropOcrAttempts }
  });

  // Bug gefunden 2026-09-23 (Nutzer-Feedback: dieselbe Detection tauchte dreifach mit
  // unterschiedlichen Scores in der Review-Queue auf): ohne diesen Delete konnten zwei
  // ueberlappende Ausfuehrungen fuer dasselbe Bild (SQS liefert mindestens einmal, aber nicht
  // exakt einmal zu; die Idempotenz-Pruefung oben ist ein Check-then-Act ohne echten Lock)
  // unabhaengig voneinander racepic_detection-Zeilen anlegen. Vor dem Einfuegen der frischen
  // Detections erst die alten fuer dieses Bild entfernen (cascadiert auf text_detection/
  // match_candidate), damit am Ende immer nur ein Satz Detections fuer den aktuellen Lauf existiert.
  await db.delete(racepicDetection).where(eq(racepicDetection.imageId, imageId));

  const detectionIds: { id: string; bbox: { left: number; top: number; width: number; height: number } }[] = [];
  let embeddingSuccessCount = 0;
  let embeddingFailureCount = 0;

  for (const vehicleDetection of vehicles) {
    let embedding: number[] | null = null;
    try {
      const pixelBox = toPixelBox(vehicleDetection.bbox, largeWidth, largeHeight);
      const cropBuffer = await sharp(largeBuffer).extract(pixelBox).jpeg({ quality: 90 }).toBuffer();
      embedding = await embedImage(cropBuffer);
      embeddingSuccessCount += 1;
    } catch (error) {
      // Embedding ist ein Signal von mehreren (Abschnitt F: "kein einzelnes KI-Modell loest
      // zuverlaessig alle Zuordnungen") - ein Fehler hier darf die restliche Analyse nicht stoppen.
      embeddingFailureCount += 1;
      logOperationalEvent('error', 'racepic_analyze.embedding_failed', { errorCode: errorCodeOf(error) });
    }

    const [detectionRow] = await db
      .insert(racepicDetection)
      .values({
        imageId,
        label: vehicleDetection.label,
        bbox: vehicleDetection.bbox,
        confidence: vehicleDetection.confidence.toFixed(4),
        dominantColors: vehicleDetection.dominantColors,
        embedding
      })
      .returning();
    if (detectionRow) detectionIds.push({ id: detectionRow.id, bbox: vehicleDetection.bbox });
  }

  for (const text of texts) {
    const detectionIndex = nearestContainingVehicleIndex(text.bbox, detectionIds.map((detection) => detection.bbox));
    const containingDetection = detectionIndex >= 0 ? detectionIds[detectionIndex] : null;
    await db.insert(racepicTextDetection).values({
      detectionId: containingDetection?.id ?? null,
      imageId,
      text: text.text,
      normalized: text.normalized,
      confidence: text.confidence.toFixed(4),
      bbox: text.bbox
    });
  }

  // Eigener Audit-Eintrag fuer Bedrock, getrennt vom Rekognition-Eintrag oben (Abschnitt I9:
  // "verwendeter AWS-Dienst, Modell/Version" je KI-Aufruf nachvollziehbar).
  if (vehicles.length > 0) {
    await db.insert(racepicAiAnalysis).values({
      imageId,
      service: 'bedrock',
      operation: 'embed_image',
      modelVersion: process.env.RACEPIC_EMBEDDING_MODEL_ID ?? 'cohere.embed-v4:0',
      pipelineVersion: PIPELINE_VERSION,
      finishedAt: new Date(),
      summary: { attempted: vehicles.length, succeeded: embeddingSuccessCount, failed: embeddingFailureCount }
    });
  }

  await db.update(racepicImage).set({ processingStatus: 'ANALYZED', updatedAt: new Date() }).where(eq(racepicImage.id, imageId));
  await db
    .update(racepicProcessingStep)
    .set({ status: 'DONE', finishedAt: new Date() })
    .where(and(eq(racepicProcessingStep.imageId, imageId), eq(racepicProcessingStep.step, 'analyze'), eq(racepicProcessingStep.pipelineVersion, PIPELINE_VERSION)));

  await sendMatchMessage(imageId).catch((error) =>
    logOperationalEvent('error', 'racepic_analyze.match_enqueue_failed', { errorCode: errorCodeOf(error) })
  );
};

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const batchItemFailures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    try {
      const body = JSON.parse(record.body) as { imageId?: string };
      if (!body.imageId) throw new Error('RACEPIC_ANALYZE_MISSING_IMAGE_ID');
      await processOneImage(body.imageId);
    } catch (error) {
      logOperationalEvent('error', 'racepic_analyze.failed', { errorCode: errorCodeOf(error) });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
};
