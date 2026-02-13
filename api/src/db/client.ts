import * as fs from 'fs';
import * as https from 'https';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { Signer } from '@aws-sdk/rds-signer';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

type DbSecret = {
  host?: string;
  port?: number | string;
  username?: string;
  password?: string;
  dbname?: string;
  database?: string;
};

type DbConnectionSettings = {
  host: string;
  port: number;
  user: string;
  database: string;
  password?: string;
};

let cachedSecret: DbSecret | null = null;
let cachedPool: Pool | null = null;
let cachedDb: ReturnType<typeof drizzle> | null = null;
let cachedCaBundle: string | undefined;
let caBundleLoadPromise: Promise<string | undefined> | null = null;

const getSecretArn = (): string => {
  const arn = process.env.DB_SECRET_ARN;
  if (!arn) {
    throw new Error('DB_SECRET_ARN is not set');
  }
  return arn;
};

const parseSecret = (secretString: string): DbSecret => {
  return JSON.parse(secretString) as DbSecret;
};

const parsePort = (value?: number | string): number => {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return 5432;
};

const loadDbSecret = async (): Promise<DbSecret> => {
  if (cachedSecret) {
    return cachedSecret;
  }

  const client = new SecretsManagerClient({});
  const command = new GetSecretValueCommand({ SecretId: getSecretArn() });
  const response = await client.send(command);

  if (!response.SecretString) {
    throw new Error('DB secret is empty');
  }

  cachedSecret = parseSecret(response.SecretString);
  return cachedSecret;
};

const resolveConnectionSettings = (secret: DbSecret): DbConnectionSettings => {
  const host = process.env.DB_HOST ?? secret.host;
  const user = process.env.DB_USER ?? secret.username;
  const database = process.env.DB_NAME ?? secret.dbname ?? secret.database;
  const port = parsePort(process.env.DB_PORT ?? secret.port);
  const password = secret.password;

  if (!host || !user || !database) {
    throw new Error('DB config is missing required host/user/database fields');
  }

  return {
    host,
    port,
    user,
    database,
    password
  };
};

const downloadFile = async (url: string, destination: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destination);
    https
      .get(url, (response) => {
        if (response.statusCode !== 200) {
          file.close();
          fs.unlink(destination, () => undefined);
          reject(new Error(`Failed to download DB CA bundle: HTTP ${response.statusCode ?? 'unknown'}`));
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

const loadCaBundle = async (): Promise<string | undefined> => {
  if (cachedCaBundle !== undefined) {
    return cachedCaBundle;
  }
  if (caBundleLoadPromise) {
    return caBundleLoadPromise;
  }

  caBundleLoadPromise = (async () => {
    const explicitPath = process.env.DB_SSL_CA_PATH;
    if (explicitPath) {
      cachedCaBundle = fs.readFileSync(explicitPath, 'utf8');
      return cachedCaBundle;
    }

    if (process.env.DB_SSL_AUTO_DOWNLOAD_CA === 'false') {
      return undefined;
    }

    const bundleUrl =
      process.env.DB_SSL_CA_BUNDLE_URL ?? 'https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem';
    const localPath = '/tmp/rds-global-bundle.pem';

    if (!fs.existsSync(localPath)) {
      await downloadFile(bundleUrl, localPath);
    }

    cachedCaBundle = fs.readFileSync(localPath, 'utf8');
    return cachedCaBundle;
  })();

  try {
    return await caBundleLoadPromise;
  } finally {
    caBundleLoadPromise = null;
  }
};

const resolveSslConfig = async () => {
  if (process.env.DB_SSL !== 'true') {
    return undefined;
  }

  const rejectUnauthorized = process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false';
  const ca = rejectUnauthorized ? await loadCaBundle() : undefined;

  return {
    rejectUnauthorized,
    ca
  };
};

const buildPool = async (secret: DbSecret): Promise<Pool> => {
  const settings = resolveConnectionSettings(secret);
  const ssl = await resolveSslConfig();
  const useIamAuth = process.env.DB_IAM_AUTH === 'true';

  if (!useIamAuth) {
    if (!settings.password) {
      throw new Error('DB password is missing in secret for password auth mode');
    }

    return new Pool({
      host: settings.host,
      port: settings.port,
      user: settings.user,
      password: settings.password,
      database: settings.database,
      ssl
    });
  }

  const region = process.env.DB_REGION ?? process.env.AWS_REGION;
  if (!region) {
    throw new Error('DB_REGION (or AWS_REGION) is required for IAM auth mode');
  }

  const signer = new Signer({
    hostname: settings.host,
    port: settings.port,
    username: settings.user,
    region
  });

  return new Pool({
    host: settings.host,
    port: settings.port,
    user: settings.user,
    password: async () => signer.getAuthToken(),
    database: settings.database,
    ssl
  });
};

export const getDb = async () => {
  if (cachedDb) {
    return cachedDb;
  }

  const secret = await loadDbSecret();
  cachedPool = await buildPool(secret);
  cachedDb = drizzle(cachedPool, { schema });
  return cachedDb;
};

export const getPool = async () => {
  if (cachedPool) {
    return cachedPool;
  }

  const secret = await loadDbSecret();
  cachedPool = await buildPool(secret);
  return cachedPool;
};
