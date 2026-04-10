create table if not exists "mail_attachment_upload" (
  "id" uuid primary key default gen_random_uuid(),
  "event_id" uuid not null references "event"("id") on delete cascade,
  "s3_key" text not null,
  "content_type" text not null,
  "file_name" text not null,
  "file_size_bytes" integer not null,
  "uploaded_by" text,
  "status" text not null default 'initiated',
  "expires_at" timestamptz not null,
  "finalized_at" timestamptz,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  constraint "mail_attachment_upload_status_check" check ("status" in ('initiated', 'finalized', 'expired'))
);

create index if not exists "mail_attachment_upload_status_expires_idx"
  on "mail_attachment_upload" ("status", "expires_at");

create index if not exists "mail_attachment_upload_event_idx"
  on "mail_attachment_upload" ("event_id", "created_at");

create table if not exists "email_outbox_attachment" (
  "id" uuid primary key default gen_random_uuid(),
  "outbox_id" uuid not null references "email_outbox"("id") on delete cascade,
  "file_name" text not null,
  "content_type" text not null,
  "s3_key" text not null,
  "file_size_bytes" integer,
  "source" text not null default 'upload',
  "created_at" timestamptz not null default now(),
  constraint "email_outbox_attachment_source_check" check ("source" in ('upload', 'system', 'document'))
);

create index if not exists "email_outbox_attachment_outbox_idx"
  on "email_outbox_attachment" ("outbox_id");

alter table "document"
  drop constraint if exists "document_type_check";

alter table "document"
  add constraint "document_type_check"
  check ("type" in ('waiver', 'tech_check', 'waiver_batch', 'tech_check_batch', 'entry_confirmation'));

alter table "email_outbox_attachment"
  drop constraint if exists "email_outbox_attachment_source_check";

alter table "email_outbox_attachment"
  add constraint "email_outbox_attachment_source_check"
  check ("source" in ('upload', 'system', 'document'));

create index if not exists "document_entry_confirmation_revision_idx"
  on "document" ("entry_id", "template_variant", "created_at")
  where "type" = 'entry_confirmation';
