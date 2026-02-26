drop index if exists "entry_event_driver_email_active_unique";

create table if not exists "registration_group" (
  "id" uuid primary key default gen_random_uuid(),
  "event_id" uuid not null references "event"("id") on delete cascade,
  "driver_person_id" uuid not null references "person"("id"),
  "driver_email_norm" text not null,
  "deleted_at" timestamptz,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now()
);

create unique index if not exists "registration_group_event_driver_email_active_unique"
  on "registration_group" ("event_id", "driver_email_norm")
  where "deleted_at" is null;

create index if not exists "registration_group_event_idx"
  on "registration_group" ("event_id");

create table if not exists "registration_group_email_verification" (
  "id" uuid primary key default gen_random_uuid(),
  "registration_group_id" uuid not null references "registration_group"("id") on delete cascade,
  "token" text not null,
  "expires_at" timestamptz not null,
  "verified_at" timestamptz,
  "created_at" timestamptz not null default now()
);

create unique index if not exists "registration_group_email_verification_group_unique"
  on "registration_group_email_verification" ("registration_group_id");

create unique index if not exists "registration_group_email_verification_token_unique"
  on "registration_group_email_verification" ("token");

create table if not exists "public_entry_submission" (
  "id" uuid primary key default gen_random_uuid(),
  "event_id" uuid not null references "event"("id") on delete cascade,
  "client_submission_key" text not null,
  "payload_hash" text not null,
  "response_payload" jsonb not null default '{}'::jsonb,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now()
);

create unique index if not exists "public_entry_submission_event_key_unique"
  on "public_entry_submission" ("event_id", "client_submission_key");

create index if not exists "public_entry_submission_event_idx"
  on "public_entry_submission" ("event_id");

alter table "entry"
  add column if not exists "registration_group_id" uuid;

do $$
begin
  if not exists (
    select 1
    from information_schema.table_constraints
    where constraint_name = 'entry_registration_group_id_registration_group_id_fk'
      and table_name = 'entry'
  ) then
    alter table "entry"
      add constraint "entry_registration_group_id_registration_group_id_fk"
      foreign key ("registration_group_id") references "registration_group"("id") on delete set null;
  end if;
end $$;

create index if not exists "entry_registration_group_idx"
  on "entry" ("registration_group_id");

with grouped as (
  select
    e."event_id",
    coalesce(e."driver_email_norm", lower(trim(p."email"))) as email_norm,
    (array_agg(e."driver_person_id" order by e."created_at" asc, e."id" asc))[1] as driver_person_id
  from "entry" e
  inner join "person" p on p."id" = e."driver_person_id"
  where e."deleted_at" is null
    and coalesce(e."driver_email_norm", lower(trim(p."email"))) is not null
  group by e."event_id", coalesce(e."driver_email_norm", lower(trim(p."email")))
)
insert into "registration_group" ("event_id", "driver_person_id", "driver_email_norm", "created_at", "updated_at")
select g."event_id", g."driver_person_id", g."email_norm", now(), now()
from grouped g
on conflict ("event_id", "driver_email_norm") where "deleted_at" is null do nothing;

update "entry" e
set "registration_group_id" = (
  select rg."id"
  from "registration_group" rg
  where rg."event_id" = e."event_id"
    and rg."driver_email_norm" = coalesce(e."driver_email_norm", lower(trim(p."email")))
  limit 1
)
from "person" p
where p."id" = e."driver_person_id"
  and e."deleted_at" is null
  and e."registration_group_id" is null;
