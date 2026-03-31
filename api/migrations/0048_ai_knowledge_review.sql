create table if not exists "ai_knowledge_suggestion" (
  "id" uuid primary key default gen_random_uuid(),
  "event_id" uuid references "event" ("id") on delete set null,
  "message_id" uuid references "ai_message_source" ("id") on delete set null,
  "topic" text not null,
  "title" text not null,
  "content" text not null,
  "rationale" text,
  "status" text not null default 'suggested',
  "source_type" text not null default 'ai_suggested',
  "created_by" text,
  "reviewed_by" text,
  "reviewed_at" timestamptz,
  "metadata" jsonb not null default '{}'::jsonb,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now()
);

alter table "ai_knowledge_suggestion"
  drop constraint if exists "ai_knowledge_suggestion_topic_check";
alter table "ai_knowledge_suggestion"
  add constraint "ai_knowledge_suggestion_topic_check"
  check ("topic" in ('documents', 'payment', 'interview', 'logistics', 'contact', 'general'));

alter table "ai_knowledge_suggestion"
  drop constraint if exists "ai_knowledge_suggestion_status_check";
alter table "ai_knowledge_suggestion"
  add constraint "ai_knowledge_suggestion_status_check"
  check ("status" in ('suggested', 'approved', 'rejected', 'archived'));

alter table "ai_knowledge_suggestion"
  drop constraint if exists "ai_knowledge_suggestion_source_type_check";
alter table "ai_knowledge_suggestion"
  add constraint "ai_knowledge_suggestion_source_type_check"
  check ("source_type" in ('manual', 'ai_suggested'));

create index if not exists "ai_knowledge_suggestion_event_topic_status_idx"
  on "ai_knowledge_suggestion" ("event_id", "topic", "status", "created_at");
create index if not exists "ai_knowledge_suggestion_message_idx"
  on "ai_knowledge_suggestion" ("message_id", "created_at");

create table if not exists "ai_knowledge_item" (
  "id" uuid primary key default gen_random_uuid(),
  "event_id" uuid references "event" ("id") on delete set null,
  "message_id" uuid references "ai_message_source" ("id") on delete set null,
  "suggestion_id" uuid references "ai_knowledge_suggestion" ("id") on delete set null,
  "topic" text not null,
  "title" text not null,
  "content" text not null,
  "status" text not null default 'approved',
  "source_type" text not null default 'manual',
  "created_by" text,
  "approved_by" text,
  "approved_at" timestamptz,
  "metadata" jsonb not null default '{}'::jsonb,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now()
);

alter table "ai_knowledge_item"
  drop constraint if exists "ai_knowledge_item_topic_check";
alter table "ai_knowledge_item"
  add constraint "ai_knowledge_item_topic_check"
  check ("topic" in ('documents', 'payment', 'interview', 'logistics', 'contact', 'general'));

alter table "ai_knowledge_item"
  drop constraint if exists "ai_knowledge_item_status_check";
alter table "ai_knowledge_item"
  add constraint "ai_knowledge_item_status_check"
  check ("status" in ('suggested', 'approved', 'archived'));

alter table "ai_knowledge_item"
  drop constraint if exists "ai_knowledge_item_source_type_check";
alter table "ai_knowledge_item"
  add constraint "ai_knowledge_item_source_type_check"
  check ("source_type" in ('manual', 'ai_suggested'));

create index if not exists "ai_knowledge_item_event_topic_status_idx"
  on "ai_knowledge_item" ("event_id", "topic", "status", "created_at");
create index if not exists "ai_knowledge_item_message_idx"
  on "ai_knowledge_item" ("message_id", "created_at");
