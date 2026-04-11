import { createHash } from 'node:crypto';
import { getPool } from '../db/client';

export type PublicRateLimitInput = {
  scope: string;
  key: string;
  limit: number;
  windowSeconds: number;
};

export type PublicRateLimitResult = {
  allowed: boolean;
  retryAfterSeconds: number;
  currentCount: number;
  limit: number;
};

const floorWindowStart = (now: Date, windowSeconds: number): Date => {
  const bucketMs = Math.max(1, windowSeconds) * 1000;
  return new Date(Math.floor(now.getTime() / bucketMs) * bucketMs);
};

const hashKey = (key: string): string => createHash('sha256').update(key).digest('hex');

export const buildPublicRateLimitKey = (parts: Array<string | null | undefined>): string =>
  parts
    .map((part) => (part ?? '').trim())
    .filter((part) => part.length > 0)
    .join('|');

export const enforcePublicRateLimit = async (input: PublicRateLimitInput): Promise<PublicRateLimitResult> => {
  const pool = await getPool();
  const now = new Date();
  const windowStart = floorWindowStart(now, input.windowSeconds);
  const result = await pool.query<{ hit_count: number }>(
    `
      insert into public_rate_limit (scope, key_hash, window_start, hit_count, created_at, updated_at)
      values ($1, $2, $3, 1, now(), now())
      on conflict (scope, key_hash, window_start)
      do update set
        hit_count = public_rate_limit.hit_count + 1,
        updated_at = now()
      returning hit_count
    `,
    [input.scope, hashKey(input.key), windowStart.toISOString()]
  );
  const currentCount = result.rows[0]?.hit_count ?? 0;
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((windowStart.getTime() + input.windowSeconds * 1000 - now.getTime()) / 1000)
  );
  return {
    allowed: currentCount <= input.limit,
    retryAfterSeconds,
    currentCount,
    limit: input.limit
  };
};
