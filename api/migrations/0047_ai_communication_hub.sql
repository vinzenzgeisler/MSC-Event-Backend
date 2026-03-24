create table if not exists "ai_message_source" (
  "id" uuid primary key default gen_random_uuid(),
  "source" text not null default 'imap',
  "mailbox_key" text not null,
  "external_message_id" text not null,
  "imap_uid" integer,
  "from_email" text,
  "from_name" text,
  "to_email" text,
  "subject" text,
  "received_at" timestamptz,
  "event_id" uuid references "event" ("id") on delete set null,
  "entry_id" uuid references "entry" ("id") on delete set null,
  "raw_s3_key" text,
  "text_content" text not null,
  "normalized_content" text,
  "status" text not null default 'imported',
  "ai_summary" text,
  "ai_category" text,
  "ai_last_processed_at" timestamptz,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now()
);

alter table "ai_message_source"
  drop constraint if exists "ai_message_source_source_check";
alter table "ai_message_source"
  add constraint "ai_message_source_source_check"
  check ("source" in ('imap', 'manual'));

alter table "ai_message_source"
  drop constraint if exists "ai_message_source_status_check";
alter table "ai_message_source"
  add constraint "ai_message_source_status_check"
  check ("status" in ('imported', 'processed', 'archived'));

create unique index if not exists "ai_message_source_unique_source_message"
  on "ai_message_source" ("source", "mailbox_key", "external_message_id");
create index if not exists "ai_message_source_mailbox_received_idx"
  on "ai_message_source" ("mailbox_key", "received_at");
create index if not exists "ai_message_source_event_idx"
  on "ai_message_source" ("event_id", "created_at");
create index if not exists "ai_message_source_entry_idx"
  on "ai_message_source" ("entry_id", "created_at");

create table if not exists "ai_draft" (
  "id" uuid primary key default gen_random_uuid(),
  "task_type" text not null,
  "status" text not null default 'draft',
  "event_id" uuid references "event" ("id") on delete set null,
  "entry_id" uuid references "entry" ("id") on delete set null,
  "message_id" uuid references "ai_message_source" ("id") on delete set null,
  "title" text,
  "prompt_version" text not null default 'v1',
  "model_id" text,
  "input_snapshot" jsonb not null default '{}'::jsonb,
  "output_payload" jsonb not null default '{}'::jsonb,
  "warnings" jsonb not null default '[]'::jsonb,
  "created_by" text,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now()
);

alter table "ai_draft"
  drop constraint if exists "ai_draft_task_type_check";
alter table "ai_draft"
  add constraint "ai_draft_task_type_check"
  check ("task_type" in ('reply_suggestion', 'event_report', 'speaker_text'));

alter table "ai_draft"
  drop constraint if exists "ai_draft_status_check";
alter table "ai_draft"
  add constraint "ai_draft_status_check"
  check ("status" in ('draft', 'reviewed', 'archived'));

create index if not exists "ai_draft_task_created_idx"
  on "ai_draft" ("task_type", "created_at");
create index if not exists "ai_draft_event_idx"
  on "ai_draft" ("event_id", "created_at");
