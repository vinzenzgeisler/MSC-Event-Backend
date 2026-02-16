alter table "event"
  add column if not exists "is_current" boolean not null default false;

alter table "event"
  add column if not exists "opened_at" timestamptz;

alter table "event"
  add column if not exists "closed_at" timestamptz;

alter table "event"
  add column if not exists "archived_at" timestamptz;

update "event"
set "status" = 'open'
where "status" = 'active';

alter table "event"
  drop constraint if exists "event_status_check";

alter table "event"
  add constraint "event_status_check"
  check ("status" in ('draft', 'open', 'closed', 'archived'));

drop index if exists "event_single_current_unique";
create unique index if not exists "event_single_current_unique"
  on "event" ("is_current")
  where "is_current" = true;

with latest_open as (
  select id
  from "event"
  where "status" = 'open'
  order by "starts_at" desc
  limit 1
)
update "event"
set "is_current" = true
where id in (select id from latest_open);

create table if not exists "event_pricing_rule" (
  "id" uuid primary key default gen_random_uuid(),
  "event_id" uuid not null references "event"("id") on delete cascade,
  "early_deadline" timestamptz not null,
  "late_fee_cents" integer not null default 0,
  "second_vehicle_discount_cents" integer not null default 8000,
  "currency" text not null default 'EUR',
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  constraint "event_pricing_rule_currency_check" check ("currency" in ('EUR')),
  constraint "event_pricing_rule_event_unique" unique ("event_id")
);

create table if not exists "class_pricing_rule" (
  "id" uuid primary key default gen_random_uuid(),
  "event_id" uuid not null references "event"("id") on delete cascade,
  "class_id" uuid not null references "class"("id") on delete cascade,
  "base_fee_cents" integer not null default 0,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  constraint "class_pricing_rule_event_class_unique" unique ("event_id", "class_id")
);

alter table "invoice"
  add column if not exists "pricing_snapshot" jsonb not null default '{}'::jsonb;

create table if not exists "invoice_payment" (
  "id" uuid primary key default gen_random_uuid(),
  "invoice_id" uuid not null references "invoice"("id") on delete cascade,
  "amount_cents" integer not null,
  "paid_at" timestamptz not null,
  "method" text not null,
  "recorded_by" text,
  "note" text,
  "created_at" timestamptz not null default now(),
  constraint "invoice_payment_method_check" check ("method" in ('bank_transfer', 'cash', 'card', 'other')),
  constraint "invoice_payment_amount_check" check ("amount_cents" > 0)
);

create index if not exists "invoice_payment_invoice_idx"
  on "invoice_payment" ("invoice_id", "paid_at");

create table if not exists "export_job" (
  "id" uuid primary key default gen_random_uuid(),
  "event_id" uuid not null references "event"("id") on delete cascade,
  "type" text not null,
  "filters" jsonb not null default '{}'::jsonb,
  "status" text not null default 'queued',
  "s3_key" text,
  "error_last" text,
  "created_by" text,
  "created_at" timestamptz not null default now(),
  "completed_at" timestamptz,
  constraint "export_job_type_check" check ("type" in ('entries_csv')),
  constraint "export_job_status_check" check ("status" in ('queued', 'processing', 'succeeded', 'failed'))
);

create index if not exists "export_job_status_idx"
  on "export_job" ("status", "created_at");

create index if not exists "export_job_event_type_idx"
  on "export_job" ("event_id", "type");

alter table "document"
  drop constraint if exists "document_type_check";

alter table "document"
  add constraint "document_type_check"
  check ("type" in ('waiver', 'tech_check', 'waiver_batch', 'tech_check_batch'));
