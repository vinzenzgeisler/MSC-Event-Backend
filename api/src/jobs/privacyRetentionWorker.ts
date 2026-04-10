import { getDb, getPool } from '../db/client';
import { writeAuditLog } from '../audit/log';

type RetentionSettings = {
  verificationDays: number;
  idempotencyDays: number;
  uploadDays: number;
  rateLimitDays: number;
  exportDays: number;
  outboxDays: number;
  emailDeliveryDays: number;
  auditDays: number;
  eventOperationalDays: number;
  documentDays: number;
  invoiceDays: number;
  dryRun: boolean;
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
  rateLimitDays: parseRetention('RETENTION_RATE_LIMIT_DAYS', 7),
  exportDays: parseRetention('RETENTION_EXPORT_DAYS', 90),
  outboxDays: parseRetention('RETENTION_OUTBOX_DAYS', 365),
  emailDeliveryDays: parseRetention('RETENTION_EMAIL_DELIVERY_DAYS', 365),
  auditDays: parseRetention('RETENTION_AUDIT_DAYS', 730),
  eventOperationalDays: parseRetention('RETENTION_EVENT_OPERATIONAL_DAYS', 365),
  documentDays: parseRetention('RETENTION_DOCUMENT_DAYS', 365 * 6),
  invoiceDays: parseRetention('RETENTION_INVOICE_DAYS', 365 * 10),
  dryRun: process.env.RETENTION_DRY_RUN === 'true'
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
      if (settings.dryRun) {
        const dryRunQuery = `with affected as (${query} returning 1) select count(*)::int as count from affected`;
        const result = await pool.query<{ count: number }>(dryRunQuery, values);
        increment(deletedRows, label, result.rows[0]?.count ?? 0);
        return;
      }

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
    'public_rate_limit',
    `delete from "public_rate_limit"
     where "updated_at" < now() - ($1 * interval '1 day')`,
    [settings.rateLimitDays]
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
    'email_delivery',
    `delete from "email_delivery" d
     using "email_outbox" o
     where d."outbox_id" = o."id"
       and coalesce(d."sent_at", o."updated_at") < now() - ($1 * interval '1 day')`,
    [settings.emailDeliveryDays]
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
     from "event"
     where "entry"."event_id" = "event"."id"
       and "event"."ends_at" < current_date - ($1 * interval '1 day')
       and ("special_notes" is not null or "internal_note" is not null or "driver_note" is not null)`,
    [settings.eventOperationalDays]
  );

  await execute(
    'consent_evidence_guardian_anonymized',
    `update "consent_evidence"
     set "guardian_full_name" = null,
         "guardian_email" = null,
         "guardian_phone" = null
     from "entry", "event"
     where "consent_evidence"."entry_id" = "entry"."id"
       and "entry"."event_id" = "event"."id"
       and "event"."ends_at" < current_date - ($1 * interval '1 day')
       and (
         "consent_evidence"."guardian_full_name" is not null
         or "consent_evidence"."guardian_email" is not null
         or "consent_evidence"."guardian_phone" is not null
       )`,
    [settings.eventOperationalDays]
  );

  await execute(
    'person_operational_anonymized',
    `update "person"
     set "email" = null,
         "first_name" = 'Anonymisiert',
         "last_name" = 'Teilnehmer',
         "birthdate" = null,
         "nationality" = null,
         "street" = null,
         "zip" = null,
         "city" = null,
         "phone" = null,
         "emergency_contact_name" = null,
         "emergency_contact_first_name" = null,
         "emergency_contact_last_name" = null,
         "emergency_contact_phone" = null,
         "motorsport_history" = null,
         "processing_restricted" = true,
         "updated_at" = now()
     where exists (
       select 1
       from "entry"
       inner join "event" on "entry"."event_id" = "event"."id"
       where ("entry"."driver_person_id" = "person"."id" or "entry"."codriver_person_id" = "person"."id")
         and "event"."ends_at" < current_date - ($1 * interval '1 day')
     )
       and not exists (
         select 1
         from "entry"
         inner join "event" on "entry"."event_id" = "event"."id"
         where ("entry"."driver_person_id" = "person"."id" or "entry"."codriver_person_id" = "person"."id")
           and "event"."ends_at" >= current_date - ($1 * interval '1 day')
     )
       and (
         "email" is not null
         or "birthdate" is not null
         or "nationality" is not null
         or "street" is not null
         or "zip" is not null
         or "city" is not null
         or "phone" is not null
         or "emergency_contact_name" is not null
         or "emergency_contact_first_name" is not null
         or "emergency_contact_last_name" is not null
         or "emergency_contact_phone" is not null
         or "motorsport_history" is not null
         or "processing_restricted" = false
       )`,
    [settings.eventOperationalDays]
  );

  await execute(
    'vehicle_operational_anonymized',
    `update "vehicle"
     set "description" = null,
         "owner_name" = null,
         "vehicle_history" = null,
         "start_number_raw" = null,
         "image_s3_key" = null,
         "updated_at" = now()
     where exists (
       select 1
       from "entry"
       inner join "event" on "entry"."event_id" = "event"."id"
       where ("entry"."vehicle_id" = "vehicle"."id" or "entry"."backup_vehicle_id" = "vehicle"."id")
         and "event"."ends_at" < current_date - ($1 * interval '1 day')
     )
       and not exists (
         select 1
         from "entry"
         inner join "event" on "entry"."event_id" = "event"."id"
         where ("entry"."vehicle_id" = "vehicle"."id" or "entry"."backup_vehicle_id" = "vehicle"."id")
           and "event"."ends_at" >= current_date - ($1 * interval '1 day')
     )
       and (
         "description" is not null
         or "owner_name" is not null
         or "vehicle_history" is not null
         or "start_number_raw" is not null
         or "image_s3_key" is not null
       )`,
    [settings.eventOperationalDays]
  );

  await execute(
    'document_generation_job',
    `delete from "document_generation_job"
     using "document", "event"
     where "document_generation_job"."document_id" = "document"."id"
       and "document"."event_id" = "event"."id"
       and "event"."ends_at" < current_date - ($1 * interval '1 day')`,
    [settings.documentDays]
  );

  await execute(
    'document',
    `delete from "document"
     using "event"
     where "document"."event_id" = "event"."id"
       and "event"."ends_at" < current_date - ($1 * interval '1 day')`,
    [settings.documentDays]
  );

  await execute(
    'invoice',
    `delete from "invoice"
     using "event"
     where "invoice"."event_id" = "event"."id"
       and "event"."ends_at" < current_date - ($1 * interval '1 day')`,
    [settings.invoiceDays]
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
      dryRun: settings.dryRun,
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
