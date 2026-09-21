-- RacePic Paket 1 (Fundament): Kern-Domänenmodell.
-- Siehe docs/memory-bank/racepic-architecture.md Abschnitt C fuer das vollstaendige Domain-Modell.
-- Referenziert bestehende Tabellen (event, entry, vehicle) statt sie zu duplizieren.

create extension if not exists vector;

-- Aktiviert RacePic pro bestehendem Event, ohne Eventdaten zu duplizieren.
create table if not exists "racepic_event" (
  "event_id" uuid primary key references "event"("id") on delete cascade,
  "slug" text not null,
  "title" text not null,
  "enabled" boolean not null default false,
  "upload_opens_at" timestamptz,
  "upload_closes_at" timestamptz,
  "published" boolean not null default false,
  "default_license_id" uuid,
  "matching_config_id" uuid,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  constraint "racepic_event_slug_unique" unique ("slug")
);

create table if not exists "racepic_photographer" (
  "id" uuid primary key default gen_random_uuid(),
  "cognito_sub" text,
  "email" text not null,
  "email_norm" text not null,
  "display_name" text not null,
  "legal_name" text,
  "copyright_line" text,
  "website" text,
  "social" jsonb not null default '{}'::jsonb,
  "avatar_key" text,
  "default_license_id" uuid,
  "status" text not null default 'INVITED',
  "terms_accepted_version" text,
  "terms_accepted_at" timestamptz,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  "deleted_at" timestamptz,
  constraint "racepic_photographer_status_check" check (
    "status" in (
      'INVITED', 'ACTIVE_FREE', 'PAYMENT_ONBOARDING_REQUIRED', 'PAYMENT_ONBOARDING_PENDING',
      'PAYMENT_ENABLED', 'PAYMENT_RESTRICTED', 'PAYMENT_DISABLED', 'DISABLED'
    )
  )
);
create unique index if not exists "racepic_photographer_cognito_sub_unique"
  on "racepic_photographer" ("cognito_sub") where "cognito_sub" is not null;
create unique index if not exists "racepic_photographer_email_norm_unique"
  on "racepic_photographer" ("email_norm") where "deleted_at" is null;

create table if not exists "racepic_photographer_event" (
  "id" uuid primary key default gen_random_uuid(),
  "photographer_id" uuid not null references "racepic_photographer"("id") on delete cascade,
  "event_id" uuid not null references "event"("id") on delete cascade,
  "upload_opens_at" timestamptz,
  "upload_closes_at" timestamptz,
  "quota_images" integer,
  "created_at" timestamptz not null default now(),
  constraint "racepic_photographer_event_unique" unique ("photographer_id", "event_id")
);

create table if not exists "racepic_invitation" (
  "id" uuid primary key default gen_random_uuid(),
  "photographer_id" uuid not null references "racepic_photographer"("id") on delete cascade,
  "token_hash" text not null,
  "email" text not null,
  "expires_at" timestamptz not null,
  "consumed_at" timestamptz,
  "created_by" text not null,
  "created_at" timestamptz not null default now(),
  constraint "racepic_invitation_token_hash_unique" unique ("token_hash")
);
create index if not exists "racepic_invitation_photographer_idx" on "racepic_invitation" ("photographer_id");

-- Lizenzen sind unveraendlich und versioniert (siehe docs/racepic/licenses.md). Eine Textaenderung
-- erzeugt eine neue Zeile mit hoeherer "version", bereits vergebene Bilder behalten ihre Version.
create table if not exists "racepic_license" (
  "id" uuid primary key default gen_random_uuid(),
  "code" text not null,
  "version" integer not null default 1,
  "title" jsonb not null,
  "summary" jsonb not null,
  "terms" jsonb not null,
  "private_use" boolean not null default false,
  "social_media" boolean not null default false,
  "editorial" boolean not null default false,
  "commercial" boolean not null default false,
  "attribution_required" boolean not null default false,
  "attribution_template" text,
  "pricing_kind" text not null default 'FREE',
  "active" boolean not null default true,
  "created_at" timestamptz not null default now(),
  constraint "racepic_license_pricing_kind_check" check ("pricing_kind" in ('FREE', 'PAID')),
  constraint "racepic_license_code_version_unique" unique ("code", "version")
);

alter table "racepic_event"
  add constraint "racepic_event_default_license_fk" foreign key ("default_license_id") references "racepic_license"("id");
alter table "racepic_photographer"
  add constraint "racepic_photographer_default_license_fk" foreign key ("default_license_id") references "racepic_license"("id");

create table if not exists "racepic_matching_config" (
  "id" uuid primary key default gen_random_uuid(),
  "event_id" uuid references "event"("id") on delete cascade,
  "version" integer not null default 1,
  "weights" jsonb not null,
  "auto_threshold" numeric(5, 4) not null,
  "review_threshold" numeric(5, 4) not null,
  "min_margin" numeric(5, 4) not null default 0,
  "feature_flags" jsonb not null default '{}'::jsonb,
  "active" boolean not null default true,
  "created_at" timestamptz not null default now(),
  constraint "racepic_matching_config_thresholds_check" check ("review_threshold" <= "auto_threshold")
);
create index if not exists "racepic_matching_config_event_idx" on "racepic_matching_config" ("event_id");

alter table "racepic_event"
  add constraint "racepic_event_matching_config_fk" foreign key ("matching_config_id") references "racepic_matching_config"("id");

create table if not exists "racepic_upload_batch" (
  "id" uuid primary key default gen_random_uuid(),
  "photographer_id" uuid not null references "racepic_photographer"("id") on delete cascade,
  "event_id" uuid not null references "event"("id") on delete cascade,
  "license_id" uuid not null references "racepic_license"("id"),
  "file_count" integer not null default 0,
  "completed_count" integer not null default 0,
  "failed_count" integer not null default 0,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now()
);
create index if not exists "racepic_upload_batch_photographer_event_idx"
  on "racepic_upload_batch" ("photographer_id", "event_id");

create table if not exists "racepic_upload" (
  "id" uuid primary key default gen_random_uuid(),
  "batch_id" uuid not null references "racepic_upload_batch"("id") on delete cascade,
  "s3_key" text not null,
  "s3_upload_id" text,
  "file_name" text,
  "content_type" text not null,
  "declared_size_bytes" bigint not null,
  "client_fingerprint" text,
  "status" text not null default 'INITIATED',
  "expires_at" timestamptz not null,
  "completed_at" timestamptz,
  "created_at" timestamptz not null default now(),
  constraint "racepic_upload_status_check" check (
    "status" in ('INITIATED', 'MULTIPART_OPEN', 'COMPLETED', 'FAILED', 'ABORTED', 'EXPIRED')
  ),
  constraint "racepic_upload_content_type_check" check ("content_type" in ('image/jpeg'))
);
create unique index if not exists "racepic_upload_s3_key_unique" on "racepic_upload" ("s3_key");
create index if not exists "racepic_upload_batch_fingerprint_idx"
  on "racepic_upload" ("batch_id", "client_fingerprint") where "client_fingerprint" is not null;

create table if not exists "racepic_image" (
  "id" uuid primary key default gen_random_uuid(),
  "event_id" uuid not null references "event"("id") on delete cascade,
  "photographer_id" uuid not null references "racepic_photographer"("id") on delete cascade,
  "batch_id" uuid references "racepic_upload_batch"("id") on delete set null,
  "upload_id" uuid references "racepic_upload"("id") on delete set null,
  "license_id" uuid not null references "racepic_license"("id"),
  "original_key" text,
  "sha256" text not null,
  "bytes" bigint,
  "width" integer,
  "height" integer,
  "captured_at" timestamptz,
  "camera" jsonb,
  "processing_status" text not null default 'UPLOADED',
  "processing_error" text,
  "visibility" text not null default 'DRAFT',
  "offer_mode" text not null default 'FREE',
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  constraint "racepic_image_processing_status_check" check (
    "processing_status" in ('UPLOADED', 'VALIDATED', 'DERIVED', 'ANALYZED', 'MATCHED', 'FAILED', 'DUPLICATE')
  ),
  constraint "racepic_image_visibility_check" check ("visibility" in ('DRAFT', 'PUBLISHED', 'HIDDEN', 'REMOVED')),
  constraint "racepic_image_offer_mode_check" check ("offer_mode" in ('FREE', 'PAID'))
);
create unique index if not exists "racepic_image_event_sha256_unique"
  on "racepic_image" ("event_id", "sha256") where "processing_status" <> 'DUPLICATE';
create index if not exists "racepic_image_event_status_idx" on "racepic_image" ("event_id", "processing_status");
create index if not exists "racepic_image_photographer_idx" on "racepic_image" ("photographer_id");
create index if not exists "racepic_image_visibility_idx" on "racepic_image" ("event_id", "visibility");

create table if not exists "racepic_image_variant" (
  "id" uuid primary key default gen_random_uuid(),
  "image_id" uuid not null references "racepic_image"("id") on delete cascade,
  "kind" text not null,
  "s3_key" text not null,
  "width" integer,
  "height" integer,
  "bytes" bigint,
  "access" text not null default 'signed',
  "created_at" timestamptz not null default now(),
  constraint "racepic_image_variant_kind_check" check (
    "kind" in ('thumb', 'preview', 'medium', 'large', 'original', 'watermarked_preview')
  ),
  constraint "racepic_image_variant_access_check" check ("access" in ('public', 'signed')),
  constraint "racepic_image_variant_unique" unique ("image_id", "kind")
);

create table if not exists "racepic_vehicle_reference" (
  "id" uuid primary key default gen_random_uuid(),
  "vehicle_id" uuid not null references "vehicle"("id") on delete cascade,
  "source_key_hash" text not null,
  -- Dimension 1024: Bedrock Cohere Embed v4 (eu-west-1), siehe racepic-architecture.md Abschnitt F.
  "embedding" vector(1024),
  "dominant_colors" jsonb,
  "vehicle_type" text,
  "computed_at" timestamptz not null default now(),
  constraint "racepic_vehicle_reference_vehicle_unique" unique ("vehicle_id")
);

create table if not exists "racepic_ai_analysis" (
  "id" uuid primary key default gen_random_uuid(),
  "image_id" uuid not null references "racepic_image"("id") on delete cascade,
  "service" text not null,
  "operation" text not null,
  "model_version" text,
  "pipeline_version" text not null,
  "started_at" timestamptz not null default now(),
  "finished_at" timestamptz,
  "raw_result_key" text,
  "summary" jsonb,
  "error" text,
  constraint "racepic_ai_analysis_service_check" check ("service" in ('rekognition', 'bedrock'))
);
create index if not exists "racepic_ai_analysis_image_idx" on "racepic_ai_analysis" ("image_id");

create table if not exists "racepic_detection" (
  "id" uuid primary key default gen_random_uuid(),
  "image_id" uuid not null references "racepic_image"("id") on delete cascade,
  "analysis_id" uuid references "racepic_ai_analysis"("id") on delete set null,
  "label" text not null,
  "bbox" jsonb not null,
  "confidence" numeric(5, 4),
  "dominant_colors" jsonb,
  "embedding" vector(1024),
  "created_at" timestamptz not null default now(),
  constraint "racepic_detection_label_check" check ("label" in ('Car', 'Motorcycle'))
);
create index if not exists "racepic_detection_image_idx" on "racepic_detection" ("image_id");

create table if not exists "racepic_text_detection" (
  "id" uuid primary key default gen_random_uuid(),
  "detection_id" uuid references "racepic_detection"("id") on delete cascade,
  "image_id" uuid not null references "racepic_image"("id") on delete cascade,
  "text" text not null,
  "normalized" text not null,
  "confidence" numeric(5, 4),
  "bbox" jsonb not null,
  "created_at" timestamptz not null default now()
);
create index if not exists "racepic_text_detection_image_idx" on "racepic_text_detection" ("image_id");
create index if not exists "racepic_text_detection_normalized_idx" on "racepic_text_detection" ("normalized");

create table if not exists "racepic_match_candidate" (
  "id" uuid primary key default gen_random_uuid(),
  "image_id" uuid not null references "racepic_image"("id") on delete cascade,
  "detection_id" uuid references "racepic_detection"("id") on delete cascade,
  "entry_id" uuid not null references "entry"("id") on delete cascade,
  "features" jsonb not null,
  "score" numeric(6, 5) not null,
  "rank" integer not null,
  "matcher_version" text not null,
  "config_version" integer not null,
  "created_at" timestamptz not null default now()
);
create index if not exists "racepic_match_candidate_image_idx" on "racepic_match_candidate" ("image_id");
create index if not exists "racepic_match_candidate_entry_idx" on "racepic_match_candidate" ("entry_id");

create table if not exists "racepic_assignment" (
  "id" uuid primary key default gen_random_uuid(),
  "image_id" uuid not null references "racepic_image"("id") on delete cascade,
  "entry_id" uuid not null references "entry"("id") on delete cascade,
  "detection_id" uuid references "racepic_detection"("id") on delete set null,
  "candidate_id" uuid references "racepic_match_candidate"("id") on delete set null,
  "status" text not null,
  "source" text not null,
  "confidence" numeric(6, 5),
  "decided_by_type" text,
  "decided_by_id" text,
  "decided_at" timestamptz not null default now(),
  "created_at" timestamptz not null default now(),
  constraint "racepic_assignment_status_check" check (
    "status" in ('AUTO_MATCHED', 'REVIEW_REQUIRED', 'MANUALLY_CONFIRMED', 'MANUALLY_CORRECTED', 'REJECTED')
  ),
  constraint "racepic_assignment_source_check" check ("source" in ('AI', 'MANUAL')),
  constraint "racepic_assignment_decided_by_type_check" check (
    "decided_by_type" is null or "decided_by_type" in ('system', 'admin', 'photographer')
  ),
  constraint "racepic_assignment_image_entry_unique" unique ("image_id", "entry_id")
);
create index if not exists "racepic_assignment_entry_idx" on "racepic_assignment" ("entry_id");
create index if not exists "racepic_assignment_status_idx" on "racepic_assignment" ("image_id", "status");

-- Append-only Audit-Trail, siehe racepic-architecture.md Abschnitt I9.
create table if not exists "racepic_assignment_event" (
  "id" uuid primary key default gen_random_uuid(),
  "assignment_id" uuid not null references "racepic_assignment"("id") on delete cascade,
  "from_status" text,
  "to_status" text not null,
  "actor_type" text not null,
  "actor_id" text,
  "reason" text,
  "created_at" timestamptz not null default now(),
  constraint "racepic_assignment_event_actor_type_check" check ("actor_type" in ('system', 'admin', 'photographer'))
);
create index if not exists "racepic_assignment_event_assignment_idx" on "racepic_assignment_event" ("assignment_id");

-- Idempotenz-Tracking je Pipeline-Stufe (siehe Abschnitt F: "Pipeline-Mechanik").
create table if not exists "racepic_processing_step" (
  "id" uuid primary key default gen_random_uuid(),
  "image_id" uuid not null references "racepic_image"("id") on delete cascade,
  "step" text not null,
  "pipeline_version" text not null,
  "status" text not null default 'DONE',
  "started_at" timestamptz not null default now(),
  "finished_at" timestamptz,
  "error" text,
  constraint "racepic_processing_step_step_check" check ("step" in ('ingest', 'analyze', 'match', 'publish')),
  constraint "racepic_processing_step_unique" unique ("image_id", "step", "pipeline_version")
);

-- Seed: die 5 kostenlosen Lizenzen aus docs/racepic/licenses.md (Version 1, Entwurf Paket 0).
-- Rechtsprüfung durch Datenschutzbeauftragten/Rechtsberatung steht noch aus (siehe dortige Datei).
insert into "racepic_license"
  ("code", "version", "title", "summary", "terms", "private_use", "social_media", "editorial", "commercial", "attribution_required", "attribution_template", "pricing_kind")
values
  (
    'FREE_UNRESTRICTED', 1,
    '{"de": "Kostenlos nutzbar"}'::jsonb,
    '{"de": "Frei nutzbar für private Zwecke, Social Media und redaktionelle Berichterstattung. Namensnennung erwünscht, nicht Pflicht. Keine kommerzielle Weiterverwertung."}'::jsonb,
    '{"de": "Der Fotograf räumt jedem Nutzer ein einfaches, unentgeltliches, räumlich und zeitlich unbeschränktes Nutzungsrecht an diesem Bild ein für: private Nutzung, Teilen in sozialen Medien und redaktionelle Berichterstattung. Eine kommerzielle Nutzung durch Dritte ist ausgeschlossen. Eine Nennung des Fotografen wird erbeten, ist aber nicht Bedingung der Nutzung."}'::jsonb,
    true, true, true, false, false, null, 'FREE'
  ),
  (
    'FREE_PRIVATE_ONLY', 1,
    '{"de": "Kostenlos für private Nutzung"}'::jsonb,
    '{"de": "Nur für den privaten Gebrauch. Keine Veröffentlichung im Internet oder in sozialen Medien."}'::jsonb,
    '{"de": "Der Fotograf räumt dem Nutzer ein einfaches, unentgeltliches Recht ein, dieses Bild ausschließlich für den privaten, nicht-öffentlichen Gebrauch zu nutzen. Eine Veröffentlichung im Internet, in sozialen Medien, in der Presse oder eine kommerzielle Nutzung ist nicht gestattet."}'::jsonb,
    true, false, false, false, false, null, 'FREE'
  ),
  (
    'FREE_SOCIAL_ATTRIBUTION', 1,
    '{"de": "Social Media erlaubt mit Namensnennung"}'::jsonb,
    '{"de": "Private Nutzung und Teilen in sozialen Medien erlaubt – mit Pflicht zur Namensnennung des Fotografen."}'::jsonb,
    '{"de": "Der Fotograf räumt dem Nutzer ein einfaches, unentgeltliches Recht ein, dieses Bild privat zu nutzen und in sozialen Medien zu veröffentlichen, sofern der Fotograf bei jeder Veröffentlichung eindeutig genannt wird. Eine redaktionelle oder kommerzielle Nutzung ist nicht gestattet."}'::jsonb,
    true, true, false, false, true, 'Foto: {photographerName} / RacePic', 'FREE'
  ),
  (
    'FREE_EDITORIAL', 1,
    '{"de": "Redaktionelle Nutzung erlaubt"}'::jsonb,
    '{"de": "Zusätzlich zur privaten Nutzung und Social Media auch redaktionelle Berichterstattung erlaubt, immer mit Namensnennung. Keine Werbung, kein Merchandising, kein Verkauf."}'::jsonb,
    '{"de": "Der Fotograf räumt dem Nutzer ein einfaches, unentgeltliches Recht ein, dieses Bild privat zu nutzen, in sozialen Medien zu teilen und im Rahmen redaktioneller Berichterstattung zu veröffentlichen. Voraussetzung ist die Nennung des Fotografen. Eine Nutzung zu Werbezwecken, für Merchandising oder zum Weiterverkauf ist ausgeschlossen."}'::jsonb,
    true, true, true, false, true, 'Foto: {photographerName} / RacePic', 'FREE'
  ),
  (
    'FREE_NC', 1,
    '{"de": "Kommerzielle Nutzung nicht erlaubt"}'::jsonb,
    '{"de": "Umfassend nutzbar (privat, Social Media, redaktionell) mit Namensnennungspflicht – ausgenommen ist jede kommerzielle Nutzung."}'::jsonb,
    '{"de": "Der Fotograf räumt dem Nutzer ein einfaches, unentgeltliches Recht ein, dieses Bild privat, in sozialen Medien und im Rahmen redaktioneller Berichterstattung zu nutzen, jeweils unter eindeutiger Namensnennung des Fotografen. Jede kommerzielle Nutzung ist ausdrücklich untersagt und bedarf der vorherigen schriftlichen Zustimmung des Fotografen."}'::jsonb,
    true, true, true, false, true, '© {photographerName}', 'FREE'
  )
on conflict ("code", "version") do nothing;
