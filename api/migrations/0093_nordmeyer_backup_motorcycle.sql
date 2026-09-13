-- Add Michael Nordmeyer's replacement motorcycle to his accepted class-8 entry.
-- The already passed primary motorcycle remains untouched. The replacement is
-- deliberately left pending so it must receive its own technical inspection.

do $$
declare
  migration_actor constant text := 'migration:0093_nordmeyer_backup_motorcycle';
  migration_key constant text := 'michael-nordmeyer-class-8-honda-v4';
  target_event_id constant uuid := 'e5dc0ac8-3a6f-4ee3-9a1c-45e2057d2a28';
  target_entry_id constant uuid := '207c3af2-5c1d-4f93-a43f-b0642c891c03';
  target_driver_person_id constant uuid := 'f74a4444-f31e-45f6-8ca8-5849177d27f1';
  target_class_id constant uuid := 'ef54e210-7fd0-40a0-9f06-28415794c3af';
  backup_vehicle_id constant uuid := 'fa6931cb-4992-4703-86bd-688ca0acc0de';
  affected_count integer;
begin
  if not exists (select 1 from "event" where "id" = target_event_id) then
    return;
  end if;

  if exists (
    select 1 from "audit_log"
    where "event_id" = target_event_id
      and "action" = 'entry_backup_vehicle_added'
      and "payload"->>'migrationKey' = migration_key
  ) then
    return;
  end if;

  perform "id" from "entry" where "id" = target_entry_id for update;

  select count(*) into affected_count
  from "entry" e
  join "person" p on p."id" = e."driver_person_id"
  join "class" c on c."id" = e."class_id"
  join "vehicle" v on v."id" = e."vehicle_id"
  where e."id" = target_entry_id
    and e."event_id" = target_event_id
    and e."driver_person_id" = target_driver_person_id
    and e."class_id" = target_class_id
    and upper(e."orga_code") = '4T9DC'
    and e."start_number_norm" = '117'
    and e."registration_status" = 'submitted_verified'
    and e."acceptance_status" = 'accepted'
    and e."tech_status" = 'passed'
    and e."deleted_at" is null
    and e."backup_vehicle_id" is null
    and e."backup_class_id" is null
    and e."backup_tech_status" = 'pending'
    and lower(trim(p."first_name" || ' ' || p."last_name")) = 'michael nordmeyer'
    and p."birthdate" = date '1957-03-20'
    and c."name" = 'Klasse 8 Rennmotorräder offen für Aktive und ehemalige'
    and c."vehicle_type" = 'moto'
    and v."vehicle_type" = 'moto'
    and lower(trim(coalesce(v."make", ''))) = 'ducati'
    and trim(coalesce(v."model", '')) = '748';
  if affected_count <> 1 then
    raise exception '0093 Nordmeyer entry fingerprint mismatch';
  end if;

  if exists (select 1 from "vehicle" where "id" = backup_vehicle_id) then
    raise exception '0093 backup vehicle id already exists';
  end if;

  insert into "vehicle" (
    "id", "owner_person_id", "vehicle_type", "make", "model", "year",
    "displacement_ccm", "engine_type", "cylinders", "start_number_raw",
    "created_at", "updated_at"
  ) values (
    backup_vehicle_id, target_driver_person_id, 'moto', 'Honda', null, 1987,
    750, 'V4', 4, '117', now(), now()
  );

  update "entry"
  set "backup_vehicle_id" = backup_vehicle_id,
      "backup_class_id" = target_class_id,
      "backup_tech_status" = 'pending',
      "backup_tech_checked_at" = null,
      "backup_tech_checked_by" = null,
      "backup_inspection_note" = null,
      "updated_at" = now()
  where "id" = target_entry_id
    and "backup_vehicle_id" is null
    and "backup_class_id" is null;
  get diagnostics affected_count = row_count;
  if affected_count <> 1 then
    raise exception '0093 backup vehicle assignment failed';
  end if;

  insert into "audit_log" (
    "event_id", "actor_user_id", "action", "entity_type", "entity_id", "payload", "created_at"
  ) values (
    target_event_id,
    migration_actor,
    'entry_backup_vehicle_added',
    'entry',
    target_entry_id,
    jsonb_build_object(
      'migrationKey', migration_key,
      'orgaCode', '4T9DC',
      'driverPersonId', target_driver_person_id,
      'backupVehicleId', backup_vehicle_id,
      'backupClassId', target_class_id,
      'startNumber', '117',
      'make', 'Honda',
      'model', null,
      'year', 1987,
      'displacementCcm', 750,
      'engineType', 'V4',
      'cylinders', 4,
      'backupTechStatus', 'pending',
      'primaryTechStatusChanged', false
    ),
    now()
  );
end
$$;
