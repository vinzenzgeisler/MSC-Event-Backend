import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import { racepicImage, racepicUpload, racepicUploadBatch } from '../db/schema';
import { logOperationalEvent } from '../observability/logger';
import { listExpiredOpenUploads } from './uploads';
import { abortMultipartUpload, deleteObject } from './s3';
import { processManifestRefreshes } from './manifestRefresh';
import { sendAnalyzeMessage, sendIngestMessage, sendMatchMessage } from './queues';

/**
 * RacePicUploadReconciler (Paket 3), per EventBridge-Schedule (siehe infra/lib/stacks/api-stack.ts).
 * Behandelt haengengebliebene Uploads (Presign-Fenster abgelaufen, ohne `complete`-Aufruf), siehe
 * docs/memory-bank/racepic-architecture.md Abschnitt D "Ein Reconciler ... behandelt UPLOADED
 * laenger als 15 Minuten ohne Fortschritt". Wird spaeter Teil des Publish-Workers (Paket 4);
 * bis dahin ein eigenstaendiger Job, weil die Upload-Lebenszyklus-Aufraeumung nicht auf Paket 4
 * warten soll.
 */
const BATCH_LIMIT = 200;

export const handler = async (): Promise<void> => {
  const expired = await listExpiredOpenUploads(BATCH_LIMIT);
  const db = await getDb();
  let cleaned = 0;
  let failed = 0;

  for (const { upload, batch } of expired) {
    try {
      if (upload.s3UploadId) {
        await abortMultipartUpload(upload.s3Key, upload.s3UploadId);
      } else {
        await deleteObject(upload.s3Key);
      }
      await db.update(racepicUpload).set({ status: 'EXPIRED' }).where(eq(racepicUpload.id, upload.id));
      await db.update(racepicUploadBatch)
        .set({ failedCount: sql`${racepicUploadBatch.failedCount} + 1`, updatedAt: new Date() })
        .where(eq(racepicUploadBatch.id, batch.id));
      cleaned += 1;
    } catch {
      failed += 1;
    }
  }

  const staleImages = await db.select({ id: racepicImage.id, status: racepicImage.processingStatus }).from(racepicImage)
    .where(and(
      inArray(racepicImage.processingStatus, ['UPLOADED', 'DERIVED', 'ANALYZED']),
      lt(racepicImage.updatedAt, new Date(Date.now() - 15 * 60 * 1000))
    )).limit(BATCH_LIMIT);
  let pipelineRequeued = 0;
  let pipelineRequeueErrors = 0;
  for (const image of staleImages) {
    try {
      if (image.status === 'UPLOADED') await sendIngestMessage(image.id);
      else if (image.status === 'DERIVED') await sendAnalyzeMessage(image.id);
      else await sendMatchMessage(image.id);
      pipelineRequeued += 1;
    } catch {
      pipelineRequeueErrors += 1;
    }
  }

  const manifests = await processManifestRefreshes();
  logOperationalEvent('info', 'racepic_upload_reconciler.run', {
    count: expired.length,
    processed: cleaned,
    racepicUploadReconcilerErrors: failed,
    manifestRefreshProcessed: manifests.processed,
    manifestRefreshErrors: manifests.failed,
    pipelineRequeued,
    pipelineRequeueErrors
  });
};
