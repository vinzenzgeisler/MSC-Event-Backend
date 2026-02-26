alter table "entry"
  add column if not exists "backup_vehicle_id" uuid references "vehicle"("id") on delete set null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'entry_backup_vehicle_not_primary_check'
  ) then
    alter table "entry"
      add constraint "entry_backup_vehicle_not_primary_check"
      check ("backup_vehicle_id" is null or "backup_vehicle_id" != "vehicle_id");
  end if;
end $$;

create index if not exists "entry_backup_vehicle_idx" on "entry" ("backup_vehicle_id");
