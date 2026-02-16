alter table "entry"
  add column if not exists "checkin_id_verified" boolean not null default false;

alter table "entry"
  add column if not exists "checkin_id_verified_at" timestamptz;

alter table "entry"
  add column if not exists "checkin_id_verified_by" text;
