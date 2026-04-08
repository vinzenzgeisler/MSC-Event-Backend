create table if not exists ai_message_source (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  mailbox_key text not null,
  external_message_id text not null,
  event_id uuid null,
  entry_id uuid null,
  from_email text not null,
  subject text null,
  text_content text not null,
  ai_summary text null,
  ai_category text null,
  status text not null default 'imported',
  received_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source, mailbox_key, external_message_id)
);

create table if not exists ai_draft (
  id uuid primary key default gen_random_uuid(),
  task_type text not null,
  status text not null default 'draft',
  event_id uuid null,
  entry_id uuid null,
  message_id uuid null,
  title text null,
  prompt_version text not null default 'v1',
  model_id text null,
  input_snapshot jsonb not null default '{}'::jsonb,
  output_payload jsonb not null default '{}'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  created_by text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists ai_knowledge_suggestion (
  id uuid primary key default gen_random_uuid(),
  event_id uuid null,
  message_id uuid null,
  topic text not null,
  title text not null,
  content text not null,
  rationale text null,
  status text not null default 'suggested',
  source_type text not null default 'ai_suggested',
  created_by text null,
  reviewed_by text null,
  reviewed_at timestamptz null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists ai_knowledge_item (
  id uuid primary key default gen_random_uuid(),
  event_id uuid null,
  message_id uuid null,
  suggestion_id uuid null,
  topic text not null,
  title text not null,
  content text not null,
  status text not null default 'approved',
  source_type text not null default 'manual',
  created_by text null,
  approved_by text null,
  approved_at timestamptz null,
  updated_by text null,
  archived_by text null,
  archived_at timestamptz null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
