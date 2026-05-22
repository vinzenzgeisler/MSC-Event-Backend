alter table "document"
  drop constraint if exists "document_type_check";

alter table "document"
  add constraint "document_type_check"
  check ("type" in ('waiver', 'tech_check', 'waiver_batch', 'tech_check_batch', 'entry_confirmation', 'waiver_signed'));

create table if not exists "signing_device_session" (
  "id" uuid primary key default gen_random_uuid(),
  "pairing_code" text not null,
  "device_name" text,
  "token_hash" text,
  "status" text not null default 'pairing',
  "paired_by" text,
  "paired_at" timestamptz,
  "expires_at" timestamptz not null,
  "last_seen_at" timestamptz,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  constraint "signing_device_session_status_check" check ("status" in ('pairing', 'connected', 'revoked', 'expired'))
);

create index if not exists "signing_device_session_pairing_code_idx"
  on "signing_device_session" ("pairing_code");

create unique index if not exists "signing_device_session_token_hash_unique"
  on "signing_device_session" ("token_hash")
  where "token_hash" is not null;

create table if not exists "signing_session" (
  "id" uuid primary key default gen_random_uuid(),
  "device_session_id" uuid not null references "signing_device_session"("id") on delete cascade,
  "event_id" uuid not null references "event"("id") on delete cascade,
  "driver_person_id" uuid not null references "person"("id"),
  "source_entry_id" uuid references "entry"("id") on delete set null,
  "status" text not null default 'pending',
  "session_payload" jsonb not null,
  "precheck_payload" jsonb not null,
  "signer_payload" jsonb not null,
  "operator_user_id" text,
  "operator_display" text,
  "displayed_at" timestamptz,
  "signed_at" timestamptz,
  "document_id" uuid references "document"("id") on delete set null,
  "evidence_audit_s3_key" text,
  "error_last" text,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  constraint "signing_session_status_check" check ("status" in ('pending', 'displayed', 'completed', 'cancelled', 'failed'))
);

create index if not exists "signing_session_device_status_idx"
  on "signing_session" ("device_session_id", "status", "created_at");

create index if not exists "signing_session_driver_idx"
  on "signing_session" ("event_id", "driver_person_id", "created_at");
