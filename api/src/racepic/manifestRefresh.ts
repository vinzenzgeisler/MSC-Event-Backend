import { and, eq, lt, or, sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import { racepicManifestRefresh } from '../db/schema';
import { regenerateManifestsForEvent, regeneratePhotographerManifest } from './publish';

export type ManifestRefreshScope = 'event' | 'photographer';

export const requestManifestRefresh = async (scope: ManifestRefreshScope, scopeId: string): Promise<void> => {
  const db = await getDb();
  await db
    .insert(racepicManifestRefresh)
    .values({ scope, scopeId, requestedAt: new Date(), completedAt: null, lastError: null })
    .onConflictDoUpdate({
      target: [racepicManifestRefresh.scope, racepicManifestRefresh.scopeId],
      set: { requestedAt: new Date(), completedAt: null, lastError: null }
    });
};

const claimRefresh = async () => {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(racepicManifestRefresh)
      .where(
        and(
          or(
            sql`${racepicManifestRefresh.completedAt} is null`,
            lt(racepicManifestRefresh.completedAt, racepicManifestRefresh.requestedAt)
          ),
          or(
            sql`${racepicManifestRefresh.leaseExpiresAt} is null`,
            lt(racepicManifestRefresh.leaseExpiresAt, new Date())
          )
        )
      )
      .orderBy(racepicManifestRefresh.requestedAt)
      .limit(1)
      .for('update', { skipLocked: true });
    if (!row) return null;
    await tx
      .update(racepicManifestRefresh)
      .set({
        attemptCount: sql`${racepicManifestRefresh.attemptCount} + 1`,
        leaseExpiresAt: new Date(Date.now() + 5 * 60 * 1000),
        lastError: null
      })
      .where(and(eq(racepicManifestRefresh.scope, row.scope), eq(racepicManifestRefresh.scopeId, row.scopeId)));
    return row;
  });
};

export const processManifestRefreshes = async (limit = 20): Promise<{ processed: number; failed: number }> => {
  const db = await getDb();
  let processed = 0;
  let failed = 0;
  for (let index = 0; index < limit; index += 1) {
    const row = await claimRefresh();
    if (!row) break;
    const key = and(eq(racepicManifestRefresh.scope, row.scope), eq(racepicManifestRefresh.scopeId, row.scopeId));
    try {
      if (row.scope === 'event') await regenerateManifestsForEvent(row.scopeId);
      else await regeneratePhotographerManifest(row.scopeId);
      await db
        .update(racepicManifestRefresh)
        .set({ completedAt: new Date(), leaseExpiresAt: null, lastError: null })
        .where(key);
      processed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await db
        .update(racepicManifestRefresh)
        .set({ leaseExpiresAt: null, lastError: message.slice(0, 500) })
        .where(key);
      failed += 1;
    }
  }
  return { processed, failed };
};
