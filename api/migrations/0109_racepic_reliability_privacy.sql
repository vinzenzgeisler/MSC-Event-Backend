-- RacePic publication safety, durable manifest refreshes and retry-safe processing.

create table if not exists "racepic_participant_suppression" (
  "entry_id" uuid primary key references "entry"("id") on delete cascade,
  "reason" text not null,
  "created_by" text not null,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now()
);

create table if not exists "racepic_manifest_refresh" (
  "scope" text not null,
  "scope_id" text not null,
  "requested_at" timestamptz not null default now(),
  "completed_at" timestamptz,
  "attempt_count" integer not null default 0,
  "lease_expires_at" timestamptz,
  "last_error" text,
  primary key ("scope", "scope_id"),
  constraint "racepic_manifest_refresh_scope_check"
    check ("scope" in ('event', 'photographer'))
);

alter table "racepic_processing_step"
  add column if not exists "attempt_count" integer not null default 0,
  add column if not exists "lease_expires_at" timestamptz;

alter table "racepic_upload"
  add column if not exists "updated_at" timestamptz not null default now();

alter table "racepic_upload" drop constraint if exists "racepic_upload_status_check";
alter table "racepic_upload" add constraint "racepic_upload_status_check"
  check ("status" in ('INITIALIZING','INITIATED','MULTIPART_OPEN','COMPLETED','FAILED','ABORTED','EXPIRED'));

create unique index if not exists "racepic_upload_active_fingerprint_unique"
  on "racepic_upload" ("batch_id", "client_fingerprint")
  where "client_fingerprint" is not null
    and "status" in ('INITIALIZING','INITIATED','MULTIPART_OPEN','COMPLETED');

create index if not exists "racepic_manifest_refresh_pending_idx"
  on "racepic_manifest_refresh" ("requested_at")
  where "completed_at" is null or "completed_at" < "requested_at";

create index if not exists "racepic_processing_step_lease_idx"
  on "racepic_processing_step" ("status", "lease_expires_at");
