create table if not exists "run_group" (
  "id" uuid primary key default gen_random_uuid(),
  "event_id" uuid not null references "event"("id") on delete cascade,
  "name" text not null,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now()
);

create unique index if not exists "run_group_event_name_unique"
  on "run_group" ("event_id", "name");
alter table "run_group" drop constraint if exists "run_group_name_not_blank_check";
alter table "run_group" add constraint "run_group_name_not_blank_check" check (btrim("name") <> '');

alter table "class" add column if not exists "run_group_id" uuid;
alter table "class" drop constraint if exists "class_run_group_id_run_group_id_fk";
alter table "class" add constraint "class_run_group_id_run_group_id_fk"
  foreign key ("run_group_id") references "run_group"("id") on delete set null;
create index if not exists "class_run_group_idx" on "class" ("run_group_id");

create or replace function enforce_class_run_group_event() returns trigger as $$
begin
  if new."run_group_id" is not null and not exists (
    select 1 from "run_group" rg
    where rg."id" = new."run_group_id" and rg."event_id" = new."event_id"
  ) then
    raise exception 'class and run group must belong to the same event' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists "class_run_group_event_trigger" on "class";
create trigger "class_run_group_event_trigger"
before insert or update of "event_id", "run_group_id"
on "class" for each row execute function enforce_class_run_group_event();

alter table "entry" add column if not exists "backup_class_id" uuid;
update "entry" set "backup_class_id" = "class_id"
where "backup_vehicle_id" is not null and "backup_class_id" is null;
alter table "entry" drop constraint if exists "entry_backup_class_id_class_id_fk";
alter table "entry" add constraint "entry_backup_class_id_class_id_fk"
  foreign key ("backup_class_id") references "class"("id");
alter table "entry" drop constraint if exists "entry_backup_vehicle_class_consistency_check";
alter table "entry" add constraint "entry_backup_vehicle_class_consistency_check"
  check (("backup_vehicle_id" is null) = ("backup_class_id" is null));
create index if not exists "entry_backup_class_idx" on "entry" ("backup_class_id");

create table if not exists "entry_start_number_reservation" (
  "entry_id" uuid not null references "entry"("id") on delete cascade,
  "event_id" uuid not null references "event"("id") on delete cascade,
  "class_id" uuid not null references "class"("id") on delete cascade,
  "start_number_norm" text not null
);
create unique index if not exists "entry_start_number_reservation_entry_class_unique"
  on "entry_start_number_reservation" ("entry_id", "class_id");
create unique index if not exists "entry_start_number_reservation_class_number_unique"
  on "entry_start_number_reservation" ("event_id", "class_id", "start_number_norm");

create table if not exists "entry_run_group_reservation" (
  "entry_id" uuid primary key references "entry"("id") on delete cascade,
  "event_id" uuid not null references "event"("id") on delete cascade,
  "driver_person_id" uuid not null references "person"("id"),
  "effective_group_id" uuid not null
);
create unique index if not exists "entry_run_group_reservation_driver_group_unique"
  on "entry_run_group_reservation" ("event_id", "driver_person_id", "effective_group_id");

create or replace function sync_entry_run_group_reservations() returns trigger as $$
declare
  effective_group uuid;
begin
  delete from "entry_start_number_reservation" where "entry_id" = new."id";
  delete from "entry_run_group_reservation" where "entry_id" = new."id";

  if (new."backup_vehicle_id" is null) <> (new."backup_class_id" is null) then
    raise exception 'backup vehicle and class must be provided together' using errcode = '23514';
  end if;
  if new."backup_class_id" is not null and not exists (
    select 1
    from "class" primary_class join "class" backup_class on backup_class."id" = new."backup_class_id"
    where primary_class."id" = new."class_id"
      and primary_class."event_id" = backup_class."event_id"
      and coalesce(primary_class."run_group_id", primary_class."id") = coalesce(backup_class."run_group_id", backup_class."id")
  ) then
    raise exception 'backup class must belong to the same effective group' using errcode = '23514';
  end if;

  if new."deleted_at" is null and new."acceptance_status" <> 'withdrawn' then
    if new."start_number_norm" is not null then
      insert into "entry_start_number_reservation" ("entry_id", "event_id", "class_id", "start_number_norm")
      values (new."id", new."event_id", new."class_id", new."start_number_norm");
      if new."backup_class_id" is not null and new."backup_class_id" <> new."class_id" then
        insert into "entry_start_number_reservation" ("entry_id", "event_id", "class_id", "start_number_norm")
        values (new."id", new."event_id", new."backup_class_id", new."start_number_norm");
      end if;
    end if;

    if not new."is_backup_vehicle" then
      select coalesce(c."run_group_id", c."id") into effective_group
      from "class" c where c."id" = new."class_id";
      insert into "entry_run_group_reservation" ("entry_id", "event_id", "driver_person_id", "effective_group_id")
      values (new."id", new."event_id", new."driver_person_id", effective_group);
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists "entry_run_group_reservations_trigger" on "entry";
create trigger "entry_run_group_reservations_trigger"
after insert or update of "event_id", "class_id", "backup_class_id", "driver_person_id", "start_number_norm", "deleted_at", "acceptance_status", "is_backup_vehicle"
on "entry" for each row execute function sync_entry_run_group_reservations();

insert into "entry_start_number_reservation" ("entry_id", "event_id", "class_id", "start_number_norm")
select e."id", e."event_id", reserved."class_id", e."start_number_norm"
from "entry" e
cross join lateral (
  select e."class_id" union select e."backup_class_id" where e."backup_class_id" is not null
) reserved
where e."deleted_at" is null and e."acceptance_status" <> 'withdrawn' and e."start_number_norm" is not null
on conflict do nothing;

insert into "entry_run_group_reservation" ("entry_id", "event_id", "driver_person_id", "effective_group_id")
select e."id", e."event_id", e."driver_person_id", coalesce(c."run_group_id", c."id")
from "entry" e join "class" c on c."id" = e."class_id"
where e."deleted_at" is null and e."acceptance_status" <> 'withdrawn' and not e."is_backup_vehicle"
on conflict do nothing;
