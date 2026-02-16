alter table "event"
  add column if not exists "registration_open_at" timestamptz;

alter table "event"
  add column if not exists "registration_close_at" timestamptz;

alter table "vehicle"
  add column if not exists "image_s3_key" text;

alter table "entry"
  add column if not exists "tech_status" text not null default 'pending';

alter table "entry"
  add column if not exists "tech_checked_at" timestamptz;

alter table "entry"
  add column if not exists "tech_checked_by" text;

alter table "entry"
  drop constraint if exists "entry_tech_status_check";

alter table "entry"
  add constraint "entry_tech_status_check"
  check ("tech_status" in ('pending', 'passed', 'failed'));

create table if not exists "entry_email_verification" (
  "id" uuid primary key default gen_random_uuid(),
  "entry_id" uuid not null references "entry"("id") on delete cascade,
  "token" text not null,
  "expires_at" timestamptz not null,
  "verified_at" timestamptz,
  "created_at" timestamptz not null default now(),
  constraint "entry_email_verification_entry_unique" unique ("entry_id"),
  constraint "entry_email_verification_token_unique" unique ("token")
);

alter table "export_job"
  drop constraint if exists "export_job_type_check";

alter table "export_job"
  add constraint "export_job_type_check"
  check ("type" in ('entries_csv', 'startlist_csv', 'participants_csv', 'payments_open_csv', 'checkin_status_csv'));
