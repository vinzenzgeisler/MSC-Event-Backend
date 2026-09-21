import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getDb, getPool } from '../db/client';
import { writeAuditLog } from '../audit/log';

// Fahrzeugbilder werden ohne Dateiendung gespeichert (siehe api/src/docs/storage.ts), deshalb
// werden beim Loeschen dieselben Kandidaten-Endungen probiert wie beim Lesen.
const VEHICLE_IMAGE_EXTENSIONS = ['', '.jpg', '.jpeg', '.png', '.webp'];

const deleteVehicleImageObjects = async (s3Key: string): Promise<void> => {
  const bucket = process.env.ASSETS_BUCKET;
  if (!bucket) return;
  const client = new S3Client({});
  await Promise.all(
    VEHICLE_IMAGE_EXTENSIONS.map((extension) =>
      client.send(new DeleteObjectCommand({ Bucket: bucket, Key: `${s3Key}${extension}` })).catch(() => undefined)
    )
  );
};

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
  newsletterPendingDays: number;
  newsletterEvidenceDays: number;
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
  newsletterPendingDays: parseRetention('RETENTION_NEWSLETTER_PENDING_DAYS', 14),
  newsletterEvidenceDays: parseRetention('RETENTION_NEWSLETTER_EVIDENCE_DAYS', 365 * 3),
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
    'newsletter_pending',
    `delete from "newsletter_subscriber" where "status" = 'pending' and "created_at" < now() - ($1 * interval '1 day')`,
    [settings.newsletterPendingDays]
  );

  await execute(
    'newsletter_revocation_evidence',
    `delete from "newsletter_subscriber" where "status" = 'unsubscribed' and "unsubscribed_at" < now() - ($1 * interval '1 day')`,
    [settings.newsletterEvidenceDays]
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
         "inspection_note" = null,
         "updated_at" = now()
     from "event"
     where "entry"."event_id" = "event"."id"
       and "event"."ends_at" < current_date - ($1 * interval '1 day')
       and ("special_notes" is not null or "internal_note" is not null or "driver_note" is not null or "inspection_note" is not null)`,
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
         "publication_name" = null,
         "publication_name_version" = "publication_name_version" + case when "publication_name" is null then 0 else 1 end,
         "publication_name_updated_at" = null,
         "publication_name_updated_by" = null,
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
         or "publication_name" is not null
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

  // Vor dem Nullen erfassen, welche Fahrzeuge betroffen sind - danach ist der S3-Key weg (Paket 9:
  // schliesst die dokumentierte Luecke, dass das Fahrzeugbild in S3 nie geloescht wurde).
  const vehicleImageWhereClause = `
     exists (
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
       and "image_s3_key" is not null`;
  let vehiclesWithImages: { id: string; image_s3_key: string }[] = [];
  try {
    const selected = await pool.query<{ id: string; image_s3_key: string }>(
      `select "id", "image_s3_key" from "vehicle" where ${vehicleImageWhereClause}`,
      [settings.eventOperationalDays]
    );
    vehiclesWithImages = selected.rows;
  } catch (error) {
    errors.push(`vehicle_image_lookup:${error instanceof Error ? error.message : String(error)}`);
  }

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

  if (!settings.dryRun && vehiclesWithImages.length > 0) {
    for (const row of vehiclesWithImages) {
      try {
        await deleteVehicleImageObjects(row.image_s3_key);
        // RacePic (falls die Migrationen existieren, unabhaengig von config.enableRacePic): die
        // Referenz-Embeddings basieren auf genau diesem Foto und sind jetzt verwaist.
        await pool.query('delete from "racepic_vehicle_reference" where "vehicle_id" = $1', [row.id]).catch(() => undefined);
        increment(deletedRows, 'vehicle_image_s3_deleted', 1);
      } catch (error) {
        errors.push(`vehicle_image_s3_delete:${row.id}:${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  await execute(
    'document_generation_job',
    `delete from "document_generation_job"
     using "document", "event"
     where "document_generation_job"."document_id" = "document"."id"
       and "document"."event_id" = "event"."id"
       and "document"."type" <> 'waiver_signed'
       and "event"."ends_at" < current_date - ($1 * interval '1 day')`,
    [settings.documentDays]
  );

  await execute(
    'document',
    `delete from "document"
     using "event"
     where "document"."event_id" = "event"."id"
       and "document"."type" <> 'waiver_signed'
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

  // RacePic: die Person-/Fahrzeug-Anonymisierung oben aendert die im Manifest angezeigten Namen
  // ("Anonymisiert Teilnehmer"), siehe docs/memory-bank/racepic-architecture.md Abschnitt
  // "Datenschutz". Trigger fuer alle veroeffentlichten RacePic-Events, deren Personen diese
  // konkrete Laufzeit tatsaechlich anonymisiert hat (erkannt am frischen `updated_at`, statt jedes
  // alte Event bei jedem Lauf neu zu bauen). Dynamischer Import + Try/Catch, damit dieser Kern-Job
  // auch funktioniert, wenn RacePic nicht konfiguriert ist (config.enableRacePic=false).
  if (!settings.dryRun) {
    try {
      const affected = await pool.query<{ event_id: string }>(
        `select distinct re.event_id
         from racepic_event re
         inner join entry en on en.event_id = re.event_id
         inner join person p on p.id in (en.driver_person_id, en.codriver_person_id)
         where re.published = true and p.updated_at >= $1`,
        [windowStart]
      );
      if (affected.rows.length > 0) {
        const { regenerateManifestsForEvent } = await import('../racepic/publish');
        for (const row of affected.rows) {
          await regenerateManifestsForEvent(row.event_id);
          increment(deletedRows, 'racepic_manifests_regenerated', 1);
        }
      }
    } catch (error) {
      errors.push(`racepic_manifest_regeneration:${error instanceof Error ? error.message : String(error)}`);
    }
  }

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
