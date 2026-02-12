import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
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
  const parsed = JSON.parse(secretString) as DbSecret;
  return parsed;
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

const buildPool = (secret: DbSecret): Pool => {
  const database = secret.dbname ?? secret.database ?? process.env.DB_NAME;
  if (!secret.host || !secret.username || !secret.password || !database) {
    throw new Error('DB secret is missing required fields');
  }

  const port =
    typeof secret.port === 'string' ? Number.parseInt(secret.port, 10) : secret.port ?? 5432;

  const sslEnabled = process.env.DB_SSL === 'true';
  const rejectUnauthorized = process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false';

  return new Pool({
    host: secret.host,
    port,
    user: secret.username,
    password: secret.password,
    database,
    ssl: sslEnabled ? { rejectUnauthorized } : undefined
  });
};

export const getDb = async () => {
  if (cachedDb) {
    return cachedDb;
  }

  const secret = await loadDbSecret();
  cachedPool = buildPool(secret);
  cachedDb = drizzle(cachedPool, { schema });
  return cachedDb;
};

export const getPool = async () => {
  if (cachedPool) {
    return cachedPool;
  }

  const secret = await loadDbSecret();
  cachedPool = buildPool(secret);
  return cachedPool;
};
