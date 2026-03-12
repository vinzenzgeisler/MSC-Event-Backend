const fs = require('node:fs');
const { Client } = require('pg');
const { S3Client, DeleteObjectCommand, ListObjectVersionsCommand } = require('@aws-sdk/client-s3');

const args = new Set(process.argv.slice(2));
const APPLY = args.has('--apply');

const RESTORE_ITEMS = [
  { vehicleId: 'ef6ed62b-922f-46fc-9c9b-20dd39f2bf2f', key: 'uploads/15ed4cb5-44bb-4e34-926e-81e3cd206f16/vehicle-images/f043209f-20f9-4969-969b-3d4300d75dc8' },
  { vehicleId: '3631b2b4-29af-4699-9a9a-db4c05913d5d', key: 'uploads/15ed4cb5-44bb-4e34-926e-81e3cd206f16/vehicle-images/f4ab835c-324b-416b-82bb-57dd3a3ce7ef' },
  { vehicleId: 'a659336e-9055-4657-bc6c-dad20f18291c', key: 'uploads/15ed4cb5-44bb-4e34-926e-81e3cd206f16/vehicle-images/aa0364b9-c529-4605-b197-e030484ff8a4' },
  { vehicleId: '702f2138-485b-491e-aae7-758ecfb48c33', key: 'uploads/15ed4cb5-44bb-4e34-926e-81e3cd206f16/vehicle-images/87ffc67b-3e35-425b-a9d9-d7c56528a5d6' },
  { vehicleId: '37080101-e7fb-4601-b149-dc5c979edf2a', key: 'uploads/15ed4cb5-44bb-4e34-926e-81e3cd206f16/vehicle-images/87ffc67b-3e35-425b-a9d9-d7c56528a5d6' },
  { vehicleId: 'c6bbf0b5-75c0-40d5-a120-53c0bc70cd18', key: 'uploads/15ed4cb5-44bb-4e34-926e-81e3cd206f16/vehicle-images/05abcaa1-97d1-428c-a7a2-20def9ce0e1b' },
  { vehicleId: 'cecd522c-1ee6-4d3b-9ab8-7a21bf44e5ec', key: 'uploads/15ed4cb5-44bb-4e34-926e-81e3cd206f16/vehicle-images/0edcabad-8215-49f6-84c7-e229e4a438bb' },
  { vehicleId: 'b347413e-0462-42bc-9381-da35aea69c4c', key: 'uploads/15ed4cb5-44bb-4e34-926e-81e3cd206f16/vehicle-images/4a66839a-6ba3-4203-8b6d-08903bc8ab14' },
  { vehicleId: '187ae646-cc16-4cdf-8a70-2ada26f5d633', key: 'uploads/15ed4cb5-44bb-4e34-926e-81e3cd206f16/vehicle-images/b35e02ec-9509-4582-95ff-1cb702841937' },
  { vehicleId: '92f19c46-4313-4754-a47a-7a4e05e6b301', key: 'uploads/15ed4cb5-44bb-4e34-926e-81e3cd206f16/vehicle-images/57193e06-f5e2-41f6-8b9f-da66e0ac84c8' },
  { vehicleId: '97f1caa8-6ce1-4017-98e7-61fb4e6f6e53', key: 'uploads/15ed4cb5-44bb-4e34-926e-81e3cd206f16/vehicle-images/90f17804-9d79-438b-91ac-d58358a9bee5' },
  { vehicleId: 'ce743af5-8058-4db0-bfd8-c5773200f810', key: 'uploads/15ed4cb5-44bb-4e34-926e-81e3cd206f16/vehicle-images/de95985e-44f2-42d4-b841-028cac9c9e78' },
  { vehicleId: 'c2b15b82-82f1-40e6-a20f-ccc841c149d5', key: 'uploads/15ed4cb5-44bb-4e34-926e-81e3cd206f16/vehicle-images/99238ee7-c4f9-4432-a7c9-d7928f781267' },
  { vehicleId: 'aef1711f-f695-4489-8834-15b12a5ce7a8', key: 'uploads/15ed4cb5-44bb-4e34-926e-81e3cd206f16/vehicle-images/c6b90e00-b0db-4c28-87bc-d1d070394991' }
];

const getRequiredEnv = (key) => {
  const value = process.env[key];
  if (!value) {
    throw new Error(`${key} is not set`);
  }
  return value;
};

const buildSslConfig = () => {
  const caPath = process.env.DB_SSL_CA_PATH;
  if (!caPath) {
    return undefined;
  }
  return {
    rejectUnauthorized: true,
    ca: fs.readFileSync(caPath, 'utf8')
  };
};

const run = async () => {
  const databaseUrl = getRequiredEnv('DATABASE_URL');
  const bucket = getRequiredEnv('ASSETS_BUCKET');
  const db = new Client({
    connectionString: databaseUrl,
    ssl: buildSslConfig()
  });
  const s3 = new S3Client({});

  const uniqueKeys = [...new Set(RESTORE_ITEMS.map((item) => item.key))];
  const restoredKeys = [];
  const skippedKeys = [];

  for (const key of uniqueKeys) {
    const result = await s3.send(
      new ListObjectVersionsCommand({
        Bucket: bucket,
        Prefix: key
      })
    );
    const marker = (result.DeleteMarkers ?? []).find((item) => item.Key === key && item.IsLatest && item.VersionId);
    if (!marker || !marker.VersionId) {
      skippedKeys.push(key);
      continue;
    }
    restoredKeys.push(key);
    if (APPLY) {
      await s3.send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: key,
          VersionId: marker.VersionId
        })
      );
    }
  }

  let updatedRows = 0;
  await db.connect();
  try {
    if (APPLY) {
      for (const item of RESTORE_ITEMS) {
        const result = await db.query(
          `update vehicle
           set image_s3_key = $2,
               updated_at = now()
           where id = $1`,
          [item.vehicleId, item.key]
        );
        updatedRows += result.rowCount ?? 0;
      }
    }
  } finally {
    await db.end();
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: APPLY ? 'apply' : 'dry-run',
        bucket,
        totalRestoreItems: RESTORE_ITEMS.length,
        restoredKeys: restoredKeys.length,
        skippedKeys: skippedKeys.length,
        updatedRows,
        skippedKeySamples: skippedKeys.slice(0, 10)
      },
      null,
      2
    )
  );
};

run().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        code: 'RESTORE_FAILED',
        message: error instanceof Error ? error.message : String(error)
      },
      null,
      2
    )
  );
  process.exit(1);
});
