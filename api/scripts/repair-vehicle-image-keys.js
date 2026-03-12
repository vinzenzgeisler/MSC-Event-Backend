const fs = require('node:fs');
const { Client } = require('pg');
const { S3Client, HeadObjectCommand } = require('@aws-sdk/client-s3');

const args = new Set(process.argv.slice(2));
const APPLY = args.has('--apply');

const getRequiredEnv = (key) => {
  const value = process.env[key];
  if (!value) {
    throw new Error(`${key} is not set`);
  }
  return value;
};

const getDatabaseUrl = () => getRequiredEnv('DATABASE_URL');

const buildSslConfig = () => {
  const sslEnabled = process.env.DB_SSL === 'true' || !!process.env.DB_SSL_CA_PATH;
  if (!sslEnabled) {
    return undefined;
  }
  const caPath = process.env.DB_SSL_CA_PATH;
  if (caPath) {
    return {
      rejectUnauthorized: true,
      ca: fs.readFileSync(caPath, 'utf8')
    };
  }
  return {
    rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false'
  };
};

const stripExtension = (key) => key.replace(/\.(jpg|jpeg|png|webp)$/i, '');

const candidateKeys = (key) => {
  const base = stripExtension(key);
  const variants = [
    key,
    base,
    `${base}.jpg`,
    `${base}.jpeg`,
    `${base}.png`,
    `${base}.webp`
  ];
  return [...new Set(variants)];
};

const run = async () => {
  const bucket = getRequiredEnv('ASSETS_BUCKET');
  const db = new Client({
    connectionString: getDatabaseUrl(),
    ssl: buildSslConfig()
  });
  const s3 = new S3Client({});

  const existsCache = new Map();
  const exists = async (key) => {
    if (existsCache.has(key)) {
      return existsCache.get(key);
    }
    try {
      await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      existsCache.set(key, true);
      return true;
    } catch {
      existsCache.set(key, false);
      return false;
    }
  };

  await db.connect();
  try {
    const rows = await db.query(
      `select id, image_s3_key
       from vehicle
       where image_s3_key is not null`
    );

    let unchanged = 0;
    let fixedToVariant = 0;
    let nulled = 0;
    const updates = [];

    for (const row of rows.rows) {
      const id = row.id;
      const key = row.image_s3_key;
      const variants = candidateKeys(key);
      let resolved = null;
      for (const candidate of variants) {
        if (await exists(candidate)) {
          resolved = candidate;
          break;
        }
      }

      if (resolved === key) {
        unchanged += 1;
        continue;
      }
      if (resolved) {
        fixedToVariant += 1;
      } else {
        nulled += 1;
      }

      updates.push({
        id,
        from: key,
        to: resolved
      });

      if (APPLY) {
        await db.query(
          `update vehicle
           set image_s3_key = $2,
               updated_at = now()
           where id = $1`,
          [id, resolved]
        );
      }
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: APPLY ? 'apply' : 'dry-run',
          bucket,
          totalVehiclesWithImageKey: rows.rowCount,
          unchanged,
          fixedToVariant,
          nulled,
          sampleUpdates: updates.slice(0, 25)
        },
        null,
        2
      )
    );
  } finally {
    await db.end();
  }
};

run().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        code: 'REPAIR_FAILED',
        message: error instanceof Error ? error.message : String(error)
      },
      null,
      2
    )
  );
  process.exit(1);
});
