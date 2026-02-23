const fs = require('node:fs');
const https = require('node:https');
const { Client } = require('pg');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const defaultCaPath = '/tmp/rds-global-bundle.pem';
const defaultCaUrl = 'https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem';

const parseDate = (date) => date.toISOString().slice(0, 10);

const parseSecretJson = (raw) => {
  if (!raw) {
    throw new Error('SecretString is empty.');
  }
  const secret = JSON.parse(raw);
  return {
    host: secret.host,
    port: Number(secret.port ?? 5432),
    username: secret.username,
    password: secret.password,
    database: secret.dbname ?? secret.database
  };
};

const getStageEnv = (name, stage) => process.env[`${name}_${stage.toUpperCase()}`] ?? process.env[name];

const downloadFile = async (url, destination) =>
  new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destination);
    https
      .get(url, (response) => {
        if (response.statusCode !== 200) {
          file.close();
          fs.unlink(destination, () => undefined);
          reject(new Error(`Failed to download CA bundle: HTTP ${response.statusCode ?? 'unknown'}`));
          return;
        }
        response.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve();
        });
      })
      .on('error', (error) => {
        file.close();
        fs.unlink(destination, () => undefined);
        reject(error);
      });
  });

const resolveSslConfig = async () => {
  if (process.env.DB_SSL === 'false') {
    return undefined;
  }

  const explicitPath = process.env.DB_SSL_CA_PATH;
  const caPath = explicitPath && explicitPath.trim().length > 0 ? explicitPath : defaultCaPath;

  if (!fs.existsSync(caPath)) {
    const caUrl = process.env.DB_SSL_CA_BUNDLE_URL ?? defaultCaUrl;
    await downloadFile(caUrl, caPath);
  }

  return {
    rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false',
    ca: fs.readFileSync(caPath, 'utf8')
  };
};

const resolveConnection = async () => {
  if (process.env.DATABASE_URL) {
    return {
      connectionString: process.env.DATABASE_URL,
      ssl: await resolveSslConfig()
    };
  }

  const stage = process.env.STAGE ?? 'dev';
  const secretArn =
    getStageEnv('SEED_DB_SECRET_ARN', stage) ??
    process.env.DB_SECRET_ARN ??
    process.env.SEED_DB_SECRET_ARN ??
    process.env.DB_SECRET_ARN_DEV;

  if (!secretArn) {
    throw new Error(
      'DATABASE_URL or SEED_DB_SECRET_ARN/DB_SECRET_ARN is required. Example: SEED_DB_SECRET_ARN_DEV=arn:aws:secretsmanager:...'
    );
  }

  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'eu-central-1';
  const client = new SecretsManagerClient({ region });
  const response = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
  const secret = parseSecretJson(response.SecretString);
  const user = encodeURIComponent(secret.username);
  const pass = encodeURIComponent(secret.password);
  const db = encodeURIComponent(secret.database);
  const connectionString = `postgresql://${user}:${pass}@${secret.host}:${secret.port}/${db}`;

  return {
    connectionString,
    ssl: await resolveSslConfig()
  };
};

const seedCurrentEvent = async () => {
  const { connectionString, ssl } = await resolveConnection();
  const client = new Client({
    connectionString,
    ssl
  });

  await client.connect();
  try {
    await client.query('begin');

    const now = new Date();
    const startsAt = new Date(now);
    startsAt.setDate(startsAt.getDate() - 1);
    const endsAt = new Date(now);
    endsAt.setDate(endsAt.getDate() + 7);
    const registrationOpenAt = new Date(now);
    registrationOpenAt.setDate(registrationOpenAt.getDate() - 2);
    const registrationCloseAt = new Date(now);
    registrationCloseAt.setDate(registrationCloseAt.getDate() + 14);

    const currentEventRow = await client.query(
      `select id
       from "event"
       where "is_current" = true
       limit 1`
    );

    let eventId = currentEventRow.rows[0]?.id ?? null;
    if (!eventId) {
      const inserted = await client.query(
        `insert into "event" (
          "name",
          "starts_at",
          "ends_at",
          "status",
          "is_current",
          "registration_open_at",
          "registration_close_at",
          "opened_at",
          "created_at",
          "updated_at"
        ) values ($1, $2, $3, 'open', true, $4, $5, now(), now(), now())
        returning "id"`,
        [
          `Dev Event ${parseDate(now)}`,
          parseDate(startsAt),
          parseDate(endsAt),
          registrationOpenAt.toISOString(),
          registrationCloseAt.toISOString()
        ]
      );
      eventId = inserted.rows[0]?.id ?? null;
    } else {
      await client.query(
        `update "event"
         set "status" = 'open',
             "registration_open_at" = coalesce("registration_open_at", $2),
             "registration_close_at" = coalesce("registration_close_at", $3),
             "opened_at" = coalesce("opened_at", now()),
             "updated_at" = now()
         where "id" = $1`,
        [eventId, registrationOpenAt.toISOString(), registrationCloseAt.toISOString()]
      );
    }

    if (!eventId) {
      throw new Error('Failed to create or resolve current event.');
    }

    await client.query(
      `update "event"
       set "is_current" = case when "id" = $1 then true else false end,
           "updated_at" = now()
       where "is_current" = true or "id" = $1`,
      [eventId]
    );

    await client.query(
      `insert into "class" ("event_id", "name", "vehicle_type")
       values ($1, 'Moto Open', 'moto')
       on conflict ("event_id", "name") do nothing`,
      [eventId]
    );

    await client.query(
      `insert into "class" ("event_id", "name", "vehicle_type")
       values ($1, 'Auto Open', 'auto')
       on conflict ("event_id", "name") do nothing`,
      [eventId]
    );

    await client.query('commit');
    console.log(`Current event ready: ${eventId}`);
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    await client.end();
  }
};

seedCurrentEvent().catch((error) => {
  console.error(error);
  process.exit(1);
});
