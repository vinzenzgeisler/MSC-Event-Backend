import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
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
