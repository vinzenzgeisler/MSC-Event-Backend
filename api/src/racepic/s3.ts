import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * S3-Zugriff auf den RacePic-Media-Bucket (infra/lib/stacks/racepic-stack.ts). Eigenes Modul statt
 * Erweiterung von api/src/docs/storage.ts (Assets-/Documents-Bucket des Nennungstools) - andere
 * Zugriffsmuster (Multipart, Fotografen-eigene Uploads statt Admin-generierte PDFs).
 */

const getMediaBucket = (): string => {
  const bucket = process.env.RACEPIC_MEDIA_BUCKET;
  if (!bucket) {
    throw new Error('RACEPIC_MEDIA_BUCKET is not set');
  }
  return bucket;
};

const getS3Client = () => new S3Client({});

/** Server vergibt den Key - siehe Architekturplan Abschnitt D: "der Key ist nie vom Client waehlbar". */
export const buildIncomingKey = (eventId: string, photographerId: string, uploadId: string): string =>
  `incoming/${eventId}/${photographerId}/${uploadId}`;

export const presignPutObject = async (key: string, contentType: string, expiresInSeconds = 900): Promise<string> => {
  const client = getS3Client();
  const command = new PutObjectCommand({ Bucket: getMediaBucket(), Key: key, ContentType: contentType });
  return getSignedUrl(client, command, { expiresIn: expiresInSeconds });
};

/**
 * Presigned GET fuer private Objekte (Review-Vorschau in Paket 7, Downloads in Paket 8).
 * Interimsloesung bis das CloudFront-Signing-Keypair existiert (siehe offener Punkt aus Paket 1):
 * S3-Presign statt CloudFront Signed URL - funktional gleichwertig geschuetzt, aber ohne CDN-Cache.
 * Sobald `racepicSigningPublicKeyPem` gesetzt ist, sollte Abschnitt G's CloudFront-Signing genutzt
 * werden statt dieser Funktion fuer oeffentliche Downloads.
 */
export const presignGetObject = async (key: string, expiresInSeconds = 300): Promise<string> => {
  const client = getS3Client();
  const command = new GetObjectCommand({ Bucket: getMediaBucket(), Key: key });
  return getSignedUrl(client, command, { expiresIn: expiresInSeconds });
};

export const createMultipartUpload = async (key: string, contentType: string): Promise<string> => {
  const client = getS3Client();
  const result = await client.send(new CreateMultipartUploadCommand({ Bucket: getMediaBucket(), Key: key, ContentType: contentType }));
  if (!result.UploadId) {
    throw new Error('RACEPIC_MULTIPART_CREATE_FAILED');
  }
  return result.UploadId;
};

export const presignUploadParts = async (
  key: string,
  s3UploadId: string,
  partNumbers: number[],
  expiresInSeconds = 900
): Promise<{ partNumber: number; url: string }[]> => {
  const client = getS3Client();
  return Promise.all(
    partNumbers.map(async (partNumber) => ({
      partNumber,
      url: await getSignedUrl(
        client,
        new UploadPartCommand({ Bucket: getMediaBucket(), Key: key, UploadId: s3UploadId, PartNumber: partNumber }),
        { expiresIn: expiresInSeconds }
      )
    }))
  );
};

export const listUploadedParts = async (key: string, s3UploadId: string): Promise<{ partNumber: number; eTag: string; size: number }[]> => {
  const client = getS3Client();
  const result = await client.send(new ListPartsCommand({ Bucket: getMediaBucket(), Key: key, UploadId: s3UploadId }));
  return (result.Parts ?? [])
    .filter((part) => part.PartNumber !== undefined && part.ETag)
    .map((part) => ({ partNumber: part.PartNumber!, eTag: part.ETag!, size: part.Size ?? 0 }));
};

export const completeMultipartUpload = async (
  key: string,
  s3UploadId: string,
  parts: { partNumber: number; eTag: string }[]
): Promise<void> => {
  const client = getS3Client();
  await client.send(
    new CompleteMultipartUploadCommand({
      Bucket: getMediaBucket(),
      Key: key,
      UploadId: s3UploadId,
      MultipartUpload: { Parts: parts.map((part) => ({ PartNumber: part.partNumber, ETag: part.eTag })) }
    })
  );
};

export const abortMultipartUpload = async (key: string, s3UploadId: string): Promise<void> => {
  const client = getS3Client();
  await client.send(new AbortMultipartUploadCommand({ Bucket: getMediaBucket(), Key: key, UploadId: s3UploadId }));
};

export const headObject = async (key: string): Promise<{ sizeBytes: number; contentType: string | null } | null> => {
  const client = getS3Client();
  try {
    const result = await client.send(new HeadObjectCommand({ Bucket: getMediaBucket(), Key: key }));
    return { sizeBytes: result.ContentLength ?? 0, contentType: result.ContentType ?? null };
  } catch {
    return null;
  }
};

export const deleteObject = async (key: string): Promise<void> => {
  const client = getS3Client();
  await client.send(new DeleteObjectCommand({ Bucket: getMediaBucket(), Key: key })).catch(() => undefined);
};

/**
 * Loescht alle Objekte unter einem Prefix (z. B. `manifests/{slug}/`), inkl. Pagination und in
 * Batches von 1000 (S3-Limit fuer `DeleteObjects`). Wird fuer das Zurueckziehen von Manifesten
 * beim Unpublish eines Events gebraucht (siehe publish.ts `unpublishEventManifests`) - dort gibt
 * es keine feste Liste von Teilnehmer-Keys mehr, sobald das Event nicht mehr aktiv gepflegt wird.
 */
export const deleteObjectsByPrefix = async (prefix: string): Promise<number> => {
  const client = getS3Client();
  const bucket = getMediaBucket();
  let continuationToken: string | undefined;
  let deleted = 0;
  do {
    const listResult = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: continuationToken })
    );
    const keys = (listResult.Contents ?? []).map((object) => object.Key).filter((key): key is string => Boolean(key));
    if (keys.length > 0) {
      await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys.map((Key) => ({ Key })) } }));
      deleted += keys.length;
    }
    continuationToken = listResult.IsTruncated ? listResult.NextContinuationToken : undefined;
  } while (continuationToken);
  return deleted;
};

/** Direkter serverseitiger Download (Ingest-Worker) - kein Presign, laeuft in der Lambda selbst. */
export const getObject = async (key: string): Promise<Buffer | null> => {
  const client = getS3Client();
  try {
    const result = await client.send(new GetObjectCommand({ Bucket: getMediaBucket(), Key: key }));
    if (!result.Body) return null;
    return Buffer.from(await result.Body.transformToByteArray());
  } catch {
    return null;
  }
};

/** Direkter serverseitiger Upload (Ingest-/Publish-Worker), z. B. fuer abgeleitete Varianten. */
export const putObject = async (key: string, body: Buffer, contentType: string, contentDisposition?: string): Promise<void> => {
  const client = getS3Client();
  await client.send(
    new PutObjectCommand({
      Bucket: getMediaBucket(),
      Key: key,
      Body: body,
      ContentType: contentType,
      ...(contentDisposition ? { ContentDisposition: contentDisposition } : {})
    })
  );
};

/** Serverseitiges Kopieren innerhalb desselben Buckets (Publish-Worker: derived/ -> public/), ohne
 * Umweg ueber die Lambda (S3-interner Copy, kein Download/Upload durch den Worker). */
export const copyObject = async (sourceKey: string, destinationKey: string): Promise<void> => {
  const client = getS3Client();
  const bucket = getMediaBucket();
  await client.send(
    new CopyObjectCommand({ Bucket: bucket, Key: destinationKey, CopySource: `${bucket}/${encodeURIComponent(sourceKey)}` })
  );
};
