import { z } from 'zod';

const listQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  sortDir: z.enum(['asc', 'desc']).default('asc')
});

export type ListQueryInput = z.infer<typeof listQuerySchema> & {
  sortBy?: string;
};

export type ListMeta = {
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
};

type CursorPayload = {
  offset: number;
};

export const encodeCursor = (offset: number): string =>
  Buffer.from(JSON.stringify({ offset } satisfies CursorPayload), 'utf8').toString('base64url');

export const decodeCursor = (cursor?: string): number => {
  if (!cursor) {
    return 0;
  }
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(raw) as CursorPayload;
    if (typeof parsed.offset !== 'number' || parsed.offset < 0 || !Number.isFinite(parsed.offset)) {
      throw new Error('INVALID_CURSOR');
    }
    return Math.floor(parsed.offset);
  } catch {
    throw new Error('INVALID_CURSOR');
  }
};

const compareValues = (a: unknown, b: unknown, sortDir: 'asc' | 'desc') => {
  const direction = sortDir === 'asc' ? 1 : -1;
  if (a === b) {
    return 0;
  }
  if (a === null || a === undefined) {
    return -1 * direction;
  }
  if (b === null || b === undefined) {
    return 1 * direction;
  }
  if (typeof a === 'number' && typeof b === 'number') {
    return (a - b) * direction;
  }
  if (a instanceof Date && b instanceof Date) {
    return (a.getTime() - b.getTime()) * direction;
  }
  if (typeof a === 'string' && typeof b === 'string') {
    const aTime = Date.parse(a);
    const bTime = Date.parse(b);
    if (!Number.isNaN(aTime) && !Number.isNaN(bTime)) {
      return (aTime - bTime) * direction;
    }
  }
  return String(a).localeCompare(String(b)) * direction;
};

export const parseListQuery = (
  query: Record<string, string | undefined>,
  allowedSortFields: string[],
  defaultSortBy: string,
  defaultSortDir: 'asc' | 'desc' = 'asc'
): ListQueryInput => {
  const base = listQuerySchema.parse({
    cursor: query.cursor,
    limit: query.limit,
    sortDir: query.sortDir ?? defaultSortDir
  });
  const sortBy = query.sortBy ?? defaultSortBy;
  if (!allowedSortFields.includes(sortBy)) {
    throw new Error('INVALID_SORT_FIELD');
  }
  return {
    ...base,
    sortBy
  };
};

export const paginateAndSortRows = <T extends Record<string, unknown>>(rows: T[], query: ListQueryInput) => {
  const sorted = [...rows];
  if (query.sortBy) {
    sorted.sort((left, right) => {
      const primary = compareValues(left[query.sortBy!], right[query.sortBy!], query.sortDir);
      if (primary !== 0) {
        return primary;
      }
      // Stable deterministic tiebreaker for cursor pagination (important for createdAt duplicates).
      if (typeof left.id === 'string' && typeof right.id === 'string') {
        return compareValues(left.id, right.id, query.sortDir);
      }
      return 0;
    });
  }

  const total = sorted.length;
  const offset = decodeCursor(query.cursor);
  const end = offset + query.limit;
  const items = sorted.slice(offset, end);
  const nextOffset = end < total ? end : null;
  const nextCursor = nextOffset === null ? null : encodeCursor(nextOffset);
  const page = Math.floor(offset / query.limit) + 1;

  const meta: ListMeta = {
    page,
    pageSize: query.limit,
    total,
    hasMore: nextCursor !== null,
    nextCursor
  };

  return { items, meta };
};
