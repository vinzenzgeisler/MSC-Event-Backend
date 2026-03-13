import { S3Client, GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const getDocumentsBucket = (): string => {
  const bucket = process.env.DOCUMENTS_BUCKET;
  if (!bucket) {
    throw new Error('DOCUMENTS_BUCKET is not set');
  }
  return bucket;
};

const getAssetsBucket = (): string => {
  const bucket = process.env.ASSETS_BUCKET;
  if (!bucket) {
    throw new Error('ASSETS_BUCKET is not set');
  }
  return bucket;
};

const getS3Client = () => new S3Client({});

export const uploadPdf = async (key: string, body: Buffer) => {
  await uploadFile(key, body, 'application/pdf');
};

export const uploadFile = async (key: string, body: Buffer, contentType: string) => {
  const client = getS3Client();
  const bucket = getDocumentsBucket();
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType
    })
  );
};

export const getPresignedDownloadUrl = async (key: string, expiresInSeconds = 300) => {
  const client = getS3Client();
  const bucket = getDocumentsBucket();
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key
  });
  return getSignedUrl(client, command, { expiresIn: expiresInSeconds });
};

export const getPresignedAssetsDownloadUrl = async (key: string, expiresInSeconds = 300) => {
  const client = getS3Client();
  const bucket = getAssetsBucket();
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key
  });
  return getSignedUrl(client, command, { expiresIn: expiresInSeconds });
};

export const getPresignedAssetsUploadUrl = async (
  key: string,
  contentType: string,
  expiresInSeconds = 900
) => {
  const client = getS3Client();
  const bucket = getAssetsBucket();
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType
  });
  const url = await getSignedUrl(client, command, { expiresIn: expiresInSeconds });
  return {
    url,
    requiredHeaders: {
      'content-type': contentType
    }
  };
};

export const doesAssetObjectExist = async (key: string): Promise<boolean> => {
  const client = getS3Client();
  const bucket = getAssetsBucket();
  try {
    await client.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: key
      })
    );
    return true;
  } catch {
    return false;
  }
};

export const getAssetObjectMetadata = async (key: string): Promise<{ contentType: string | null; contentLength: number | null } | null> => {
  const client = getS3Client();
  const bucket = getAssetsBucket();
  try {
    const response = await client.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: key
      })
    );
    return {
      contentType: response.ContentType ?? null,
      contentLength: typeof response.ContentLength === 'number' ? response.ContentLength : null
    };
  } catch {
    return null;
  }
};

export const getAssetObjectBuffer = async (key: string): Promise<Buffer | null> => {
  const client = getS3Client();
  const bucket = getAssetsBucket();
  try {
    const response = await client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key
      })
    );
    if (!response.Body) {
      return null;
    }
    const bytes = await response.Body.transformToByteArray();
    return Buffer.from(bytes);
  } catch {
    return null;
  }
};

export const getDocumentObjectBuffer = async (key: string): Promise<Buffer | null> => {
  const client = getS3Client();
  const bucket = getDocumentsBucket();
  try {
    const response = await client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key
      })
    );
    if (!response.Body) {
      return null;
    }
    const bytes = await response.Body.transformToByteArray();
    return Buffer.from(bytes);
  } catch {
    return null;
  }
};
