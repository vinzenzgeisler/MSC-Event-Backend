import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client';
import { appConfig } from '../db/schema';
import { writeAuditLog } from '../audit/log';
import { entryConfirmationConfigSchema, mergeEntryConfirmationConfig, type EntryConfirmationConfig } from '../domain/entryConfirmationConfig';

const ENTRY_CONFIRMATION_DEFAULTS_KEY = 'entry_confirmation_defaults';

const patchEntryConfirmationDefaultsSchema = z.object({
  config: entryConfirmationConfigSchema
});

export const getEntryConfirmationDefaults = async (): Promise<{ config: EntryConfirmationConfig }> => {
  const db = await getDb();
  const rows = await db
    .select({
      payload: appConfig.payload
    })
    .from(appConfig)
    .where(eq(appConfig.configKey, ENTRY_CONFIRMATION_DEFAULTS_KEY))
    .limit(1);

  return {
    config: mergeEntryConfirmationConfig((rows[0]?.payload ?? {}) as EntryConfirmationConfig)
  };
};

export const patchEntryConfirmationDefaults = async (
  input: { config: EntryConfirmationConfig },
  actorUserId: string | null
): Promise<{ config: EntryConfirmationConfig }> => {
  const db = await getDb();
  const now = new Date();
  const config = entryConfirmationConfigSchema.parse(input.config ?? {});

  await db
    .insert(appConfig)
    .values({
      configKey: ENTRY_CONFIRMATION_DEFAULTS_KEY,
      payload: config,
      updatedAt: now,
      updatedBy: actorUserId
    })
    .onConflictDoUpdate({
      target: appConfig.configKey,
      set: {
        payload: config,
        updatedAt: now,
        updatedBy: actorUserId
      }
    });

  await writeAuditLog(db as never, {
    eventId: null,
    actorUserId,
    action: 'app_config_updated',
    entityType: 'app_config',
    payload: {
      configKey: ENTRY_CONFIRMATION_DEFAULTS_KEY
    }
  });

  return {
    config: mergeEntryConfirmationConfig(config)
  };
};

export const validatePatchEntryConfirmationDefaultsInput = (payload: unknown) =>
  patchEntryConfirmationDefaultsSchema.parse(payload);
