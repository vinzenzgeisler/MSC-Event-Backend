import { getDb, getPool } from '../db/client';
import { writeAuditLog } from '../audit/log';

type RetentionSettings = {
  verificationDays: number;
  idempotencyDays: number;
  uploadDays: number;
  exportDays: number;
  outboxDays: number;
  auditDays: number;
  notesDays: number;
};

const parseRetention = (key: string, fallback: number): number => {
  const raw = process.env[key];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const loadSettings = (): RetentionSettings => ({
  verificationDays: parseRetention('RETENTION_VERIFICATION_DAYS', 30),
  idempotencyDays: parseRetention('RETENTION_IDEMPOTENCY_DAYS', 30),
  uploadDays: parseRetention('RETENTION_UPLOAD_DAYS', 30),
  exportDays: parseRetention('RETENTION_EXPORT_DAYS', 90),
  outboxDays: parseRetention('RETENTION_OUTBOX_DAYS', 365),
  auditDays: parseRetention('RETENTION_AUDIT_DAYS', 730),
  notesDays: parseRetention('RETENTION_NOTES_DAYS', 365)
});

const increment = (target: Record<string, number>, key: string, count: number | null | undefined) => {
  target[key] = (target[key] ?? 0) + Number(count ?? 0);
};

export const handler = async () => {
  const settings = loadSettings();
  const pool = await getPool();
  const deletedRows: Record<string, number> = {};
  const errors: string[] = [];
  const windowStart = new Date().toISOString();

  const execute = async (label: string, query: string, values: unknown[]) => {
    try {
      const result = await pool.query(query, values);
      increment(deletedRows, label, result.rowCount);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${label}:${message}`);
    }
  };

  await execute(
    'registration_group_email_verification',
    `delete from "registration_group_email_verification"
     where coalesce("verified_at", "expires_at", "created_at") < now() - ($1 * interval '1 day')`,
    [settings.verificationDays]
  );

  await execute(
    'entry_email_verification',
    `delete from "entry_email_verification"
     where coalesce("verified_at", "expires_at", "created_at") < now() - ($1 * interval '1 day')`,
    [settings.verificationDays]
  );

  await execute(
    'public_entry_submission',
    `delete from "public_entry_submission"
     where "created_at" < now() - ($1 * interval '1 day')`,
    [settings.idempotencyDays]
  );

  await execute(
    'vehicle_image_upload',
    `delete from "vehicle_image_upload"
     where coalesce("finalized_at", "expires_at", "created_at") < now() - ($1 * interval '1 day')`,
    [settings.uploadDays]
  );

  await execute(
    'export_job',
    `delete from "export_job"
     where "completed_at" is not null
       and "completed_at" < now() - ($1 * interval '1 day')`,
    [settings.exportDays]
  );

  await execute(
    'email_outbox',
    `delete from "email_outbox"
     where "status" in ('sent', 'failed')
       and "updated_at" < now() - ($1 * interval '1 day')`,
    [settings.outboxDays]
  );

  await execute(
    'audit_log',
    `delete from "audit_log"
     where "created_at" < now() - ($1 * interval '1 day')`,
    [settings.auditDays]
  );

  await execute(
    'entry_notes_anonymized',
    `update "entry"
     set "special_notes" = null,
         "internal_note" = null,
         "driver_note" = null,
         "updated_at" = now()
     where "created_at" < now() - ($1 * interval '1 day')
       and ("special_notes" is not null or "internal_note" is not null or "driver_note" is not null)`,
    [settings.notesDays]
  );

  const db = await getDb();
  const windowEnd = new Date().toISOString();
  await writeAuditLog(db as never, {
    eventId: null,
    actorUserId: 'system',
    action: 'privacy_retention_run',
    entityType: 'system_job',
    payload: {
      windowStart,
      windowEnd,
      deletedRows,
      errors
    }
  });

  return {
    ok: errors.length === 0,
    deletedRows,
    errors
  };
};
