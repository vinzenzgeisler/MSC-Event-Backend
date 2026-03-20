alter table "event"
  add column if not exists "entry_confirmation_config" jsonb not null default '{}'::jsonb;
