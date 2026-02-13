import * as fs from 'fs';
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

const resolveSslConfig = () => {
  if (process.env.DB_SSL !== 'true') {
    return undefined;
  }

  const rejectUnauthorized = process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false';
  const caPath = process.env.DB_SSL_CA_PATH;
  const ca = caPath ? fs.readFileSync(caPath, 'utf8') : undefined;

  return {
    rejectUnauthorized,
    ca
  };
};

const buildPool = async (secret: DbSecret): Promise<Pool> => {
  const settings = resolveConnectionSettings(secret);
  const ssl = resolveSslConfig();
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
