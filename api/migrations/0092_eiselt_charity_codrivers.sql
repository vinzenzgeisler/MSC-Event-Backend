-- Move Kai Eiselt from the regular co-driver slot to charity co-driver and add
-- Selina and Alina Eiselt for Sebastian Thiele's accepted class-10 entry.
--
-- This migration deliberately creates no consent evidence. Existing signed
-- evidence for Kai is retained; the newly added minors still require their own
-- guardian-backed waiver evidence through the normal terminal workflow.

do $$
declare
  migration_actor constant text := 'migration:0092_eiselt_charity_codrivers';
  migration_key constant text := 'eiselt-charity-codrivers-sebastian-thiele';
  target_event_id constant uuid := 'e5dc0ac8-3a6f-4ee3-9a1c-45e2057d2a28';
  target_entry_id constant uuid := 'b13e4c30-62c9-4ec3-adb6-9ee24f30de3c';
  driver_person_id constant uuid := '6ae5e057-4544-4c9a-88d4-c971f8e4f920';
  kai_person_id constant uuid := '98cd818a-dc93-4f4b-b122-84e80af734b3';
  selina_person_id constant uuid := '51f386c0-2eef-46aa-b2e2-3d70c06fbf79';
  alina_person_id constant uuid := 'e66fc370-1648-4b83-9eb7-285bc695906a';
  kai_registration_id constant uuid := 'fb7b0510-fd49-4dbc-afd5-81aed6fccb1e';
  selina_registration_id constant uuid := '151e484c-ca77-4b33-8dec-de2cd5d65540';
  alina_registration_id constant uuid := 'd0fc3221-c85e-4cf5-9870-bba19359572b';
  affected_count integer;
begin
  if not exists (select 1 from "event" where "id" = target_event_id) then
    return;
  end if;

  if exists (
    select 1 from "audit_log"
    where "event_id" = target_event_id
      and "action" = 'charity_codrivers_corrected'
      and "payload"->>'migrationKey' = migration_key
  ) then
    return;
  end if;

  perform "id" from "entry" where "id" = target_entry_id for update;
  perform "id" from "person" where "id" in (driver_person_id, kai_person_id) order by "id" for update;

  select count(*) into affected_count
  from "entry" e
  join "person" driver on driver."id" = e."driver_person_id"
  join "person" codriver on codriver."id" = e."codriver_person_id"
  join "class" c on c."id" = e."class_id"
  where e."id" = target_entry_id
    and e."event_id" = target_event_id
    and e."driver_person_id" = driver_person_id
    and e."codriver_person_id" = kai_person_id
    and e."start_number_norm" = '76'
    and e."registration_status" = 'submitted_verified'
    and e."acceptance_status" = 'accepted'
    and e."deleted_at" is null
    and c."name" = 'Klasse 10 Tourenwagen geschlossen bis Bj. 1995'
    and c."allows_codriver" = true
    and lower(trim(driver."first_name" || ' ' || driver."last_name")) = 'sebastian thiele'
    and driver."birthdate" = date '1982-07-08'
    and lower(trim(codriver."first_name" || ' ' || codriver."last_name")) = 'kai eiselt'
    and codriver."birthdate" = date '2011-06-07'
    and replace(codriver."zip", ' ', '') = '02779'
    and lower(trim(codriver."city")) = lower('Großschönau');
  if affected_count <> 1 then
    raise exception '0092 entry/person fingerprint mismatch';
  end if;

  if exists (
    select 1 from "person"
    where (lower(trim("first_name" || ' ' || "last_name")) = 'selina eiselt' and "birthdate" = date '2009-10-27')
       or (lower(trim("first_name" || ' ' || "last_name")) = 'alina eiselt' and "birthdate" = date '2013-06-07')
  ) then
    raise exception '0092 Selina or Alina Eiselt already exists';
  end if;

  if exists (
    select 1 from "entry_charity_codriver"
    where "event_id" = target_event_id
      and "entry_id" = target_entry_id
      and "person_id" = kai_person_id
      and "status" = 'active'
  ) then
    raise exception '0092 Kai Eiselt already has an active charity registration';
  end if;

  insert into "person" (
    "id", "email", "first_name", "last_name", "birthdate", "nationality", "country",
    "street", "zip", "city", "phone", "emergency_contact_name",
    "emergency_contact_first_name", "emergency_contact_last_name", "emergency_contact_phone",
    "motorsport_history", "processing_restricted", "objection_flag", "created_at", "updated_at"
  )
  select
    new_person."id", null, new_person."first_name", 'Eiselt', new_person."birthdate",
    kai."nationality", kai."country", kai."street", kai."zip", kai."city", kai."phone",
    kai."emergency_contact_name", kai."emergency_contact_first_name",
    kai."emergency_contact_last_name", kai."emergency_contact_phone", null,
    kai."processing_restricted", kai."objection_flag", now(), now()
  from "person" kai
  cross join (values
    (selina_person_id, 'Selina'::text, date '2009-10-27'),
    (alina_person_id, 'Alina'::text, date '2013-06-07')
  ) as new_person("id", "first_name", "birthdate")
  where kai."id" = kai_person_id;

  update "entry"
  set "codriver_person_id" = null,
      "updated_at" = now()
  where "id" = target_entry_id
    and "codriver_person_id" = kai_person_id;
  get diagnostics affected_count = row_count;
  if affected_count <> 1 then
    raise exception '0092 regular co-driver update failed';
  end if;

  insert into "entry_charity_codriver" (
    "id", "event_id", "entry_id", "person_id", "terminal_session_id", "status",
    "created_by", "created_at", "updated_at"
  ) values
    (kai_registration_id, target_event_id, target_entry_id, kai_person_id, null, 'active', migration_actor, now(), now()),
    (selina_registration_id, target_event_id, target_entry_id, selina_person_id, null, 'active', migration_actor, now(), now()),
    (alina_registration_id, target_event_id, target_entry_id, alina_person_id, null, 'active', migration_actor, now(), now());

  insert into "audit_log" (
    "event_id", "actor_user_id", "action", "entity_type", "entity_id", "payload", "created_at"
  ) values (
    target_event_id,
    migration_actor,
    'regular_codriver_removed',
    'entry',
    target_entry_id,
    jsonb_build_object(
      'entryId', target_entry_id,
      'personId', kai_person_id,
      'reason', 'Korrektur: Umstellung auf Charity-Beifahrer'
    ),
    now()
  );

  insert into "audit_log" (
    "event_id", "actor_user_id", "action", "entity_type", "entity_id", "payload", "created_at"
  ) values (
    target_event_id,
    migration_actor,
    'charity_codrivers_corrected',
    'entry',
    target_entry_id,
    jsonb_build_object(
      'migrationKey', migration_key,
      'entryId', target_entry_id,
      'driverPersonId', driver_person_id,
      'charityCodrivers', jsonb_build_array(
        jsonb_build_object('registrationId', kai_registration_id, 'personId', kai_person_id, 'name', 'Kai Eiselt'),
        jsonb_build_object('registrationId', selina_registration_id, 'personId', selina_person_id, 'name', 'Selina Eiselt'),
        jsonb_build_object('registrationId', alina_registration_id, 'personId', alina_person_id, 'name', 'Alina Eiselt')
      ),
      'waiverEvidenceCreated', false
    ),
    now()
  );
end $$;
