alter table "event"
  add column if not exists "payment_due_at" timestamptz;
