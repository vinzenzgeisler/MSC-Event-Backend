alter table "email_outbox"
  add column if not exists "batch_id" uuid;

create index if not exists "email_outbox_event_batch_idx"
  on "email_outbox" ("event_id", "batch_id");

