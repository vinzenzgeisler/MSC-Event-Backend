alter table "vehicle"
  add column if not exists "owner_name" text,
  add column if not exists "vehicle_history" text;

alter table "entry"
  add column if not exists "backup_of_entry_id" uuid references "entry"("id") on delete set null,
  add column if not exists "special_notes" text,
  add column if not exists "consent_terms_accepted" boolean not null default false,
  add column if not exists "consent_privacy_accepted" boolean not null default false,
  add column if not exists "consent_media_accepted" boolean not null default false,
  add column if not exists "consent_version" text,
  add column if not exists "consent_captured_at" timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'entry_backup_not_self_check'
  ) then
    alter table "entry"
      add constraint "entry_backup_not_self_check"
      check ("backup_of_entry_id" is null or "backup_of_entry_id" != "id");
  end if;
end $$;

create index if not exists "entry_backup_of_entry_idx"
  on "entry" ("backup_of_entry_id");
