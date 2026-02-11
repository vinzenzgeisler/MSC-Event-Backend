create table if not exists "email_outbox" (
  "id" uuid primary key default gen_random_uuid(),
  "event_id" uuid references "event"("id") on delete set null,
  "to_email" text not null,
  "subject" text not null,
  "template_id" text not null,
  "template_data" jsonb,
  "status" text not null default 'queued',
  "attempt_count" integer not null default 0,
  "last_error" text,
  "send_after" timestamptz not null default now(),
  "idempotency_key" text,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  constraint "email_outbox_status_check" check ("status" in ('queued', 'sending', 'sent', 'failed'))
);

create index if not exists "email_outbox_status_send_after_idx"
  on "email_outbox" ("status", "send_after");

create unique index if not exists "email_outbox_idempotency_unique"
  on "email_outbox" ("idempotency_key")
  where "idempotency_key" is not null;

create table if not exists "email_delivery" (
  "id" uuid primary key default gen_random_uuid(),
  "outbox_id" uuid not null references "email_outbox"("id") on delete cascade,
  "ses_message_id" text,
  "status" text not null default 'sent',
  "sent_at" timestamptz,
  "provider_response" jsonb,
  constraint "email_delivery_status_check" check ("status" in ('sent', 'failed'))
);

create table if not exists "document" (
  "id" uuid primary key default gen_random_uuid(),
  "event_id" uuid references "event"("id") on delete set null,
  "entry_id" uuid references "entry"("id") on delete set null,
  "driver_person_id" uuid references "person"("id") on delete set null,
  "type" text not null,
  "template_version" text not null,
  "sha256" text not null,
  "s3_key" text not null,
  "status" text not null default 'generated',
  "created_at" timestamptz not null default now(),
  "created_by" text,
  constraint "document_type_check" check ("type" in ('waiver', 'tech_check')),
  constraint "document_status_check" check ("status" in ('generated', 'failed'))
);

create index if not exists "document_event_type_idx"
  on "document" ("event_id", "type");

create table if not exists "document_generation_job" (
  "id" uuid primary key default gen_random_uuid(),
  "document_id" uuid not null references "document"("id") on delete cascade,
  "status" text not null default 'queued',
  "attempt_count" integer not null default 0,
  "last_error" text,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  constraint "document_generation_job_status_check" check ("status" in ('queued', 'processing', 'succeeded', 'failed'))
);

create index if not exists "document_generation_job_status_idx"
  on "document_generation_job" ("status");
