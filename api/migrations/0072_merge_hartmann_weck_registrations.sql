-- Merge only the two confirmed registration identities covered by this data
-- migration. Other duplicate candidates remain untouched.

do $$
declare
  migration_actor constant text := 'migration:0072_merge_hartmann_weck_registrations';
  migration_key constant text := 'hartmann-class8-class6';
  target_event_id constant uuid := 'e5dc0ac8-3a6f-4ee3-9a1c-45e2057d2a28';
  canonical_person_id constant uuid := 'caf242c0-b1b9-46fa-8ffa-0ba9f406b387';
  secondary_person_id constant uuid := '446599a0-cce7-4d14-8de4-67d0f2144d5a';
  canonical_group_id constant uuid := '52f78845-f9a0-47e1-a927-4a8254c4cc80';
  secondary_group_id constant uuid := 'fcf58734-6e1e-4e25-8b09-86dd7b53b5eb';
  canonical_entry_id constant uuid := '8fa49d32-8c44-4846-a0ba-35f0211730b3';
  secondary_entry_id constant uuid := 'c6c5f8b1-5776-4693-887e-36d0e6eda9e8';
  canonical_invoice_id constant uuid := '9ab602b4-0f40-4260-8fa2-d410facc6981';
  secondary_invoice_id constant uuid := 'db57830f-a551-4a57-987b-3cf33dbeda99';
  canonical_email text;
  secondary_email text;
  canonical_orga_code text;
  event_name text;
  canonical_summary text;
  secondary_summary text;
  template_version integer;
  merged_overrides jsonb;
  merged_snapshot jsonb;
  affected_count integer;
begin
  -- Non-production databases do not contain this event and intentionally no-op.
  if not exists (select 1 from "event" where "id" = target_event_id) then
    return;
  end if;

  if exists (
    select 1 from "audit_log"
    where "event_id" = target_event_id
      and "action" = 'doublestarter_registration_merged'
      and "payload"->>'migrationKey' = migration_key
  ) then
    return;
  end if;

  perform "id" from "entry"
  where "id" in (canonical_entry_id, secondary_entry_id)
  order by "id"
  for update;
  perform "id" from "registration_group"
  where "id" in (canonical_group_id, secondary_group_id)
  order by "id"
  for update;
  perform "id" from "invoice"
  where "id" in (canonical_invoice_id, secondary_invoice_id)
  order by "id"
  for update;

  select count(*) into affected_count
  from "entry" e
  join "person" p on p."id" = e."driver_person_id"
  where (
    (
        e."id" = canonical_entry_id
        and e."driver_person_id" = canonical_person_id
        and e."registration_group_id" = canonical_group_id
      ) or (
        e."id" = secondary_entry_id
        and e."driver_person_id" = secondary_person_id
        and e."registration_group_id" = secondary_group_id
      )
    )
    and e."event_id" = target_event_id
    and e."deleted_at" is null
    and e."registration_status" = 'submitted_verified'
    and e."acceptance_status" = 'accepted'
    and lower(trim(p."first_name")) = 'tim'
    and lower(trim(p."last_name")) = 'hartmann'
    and p."birthdate" = date '2000-09-03';
  if affected_count <> 2 then
    raise exception '0072 Hartmann entry fingerprint mismatch';
  end if;

  if not exists (
    select 1
    from "entry" e
    join "class" c on c."id" = e."class_id"
    where e."id" = canonical_entry_id
      and c."name" = 'Klasse 8 Rennmotorräder offen für Aktive und ehemalige'
      and e."start_number_norm" = '44'
  ) or not exists (
    select 1
    from "entry" e
    join "class" c on c."id" = e."class_id"
    where e."id" = secondary_entry_id
      and c."name" = 'Klasse 6 Rennmotorräder 500-1000 cm³ bis Bj. 1995'
      and e."start_number_norm" = '44'
  ) then
    raise exception '0072 Hartmann class/start-number fingerprint mismatch';
  end if;

  if not exists (
    select 1 from "invoice"
    where "id" = canonical_invoice_id
      and "event_id" = target_event_id
      and "driver_person_id" = canonical_person_id
      and "total_cents" = 0
      and coalesce("paid_amount_cents", 0) = 0
      and "payment_status" = 'not_required'
  ) or not exists (
    select 1 from "invoice"
    where "id" = secondary_invoice_id
      and "event_id" = target_event_id
      and "driver_person_id" = secondary_person_id
      and "total_cents" = 0
      and coalesce("paid_amount_cents", 0) = 0
      and "payment_status" = 'not_required'
  ) or exists (
    select 1 from "invoice_payment"
    where "invoice_id" in (canonical_invoice_id, secondary_invoice_id)
  ) then
    raise exception '0072 Hartmann invoice fingerprint mismatch';
  end if;

  select
    coalesce(p."email", rg."driver_email_norm"),
    e."orga_code",
    ev."name",
    c."name" || ' · Startnummer ' || coalesce(e."start_number_norm", '—')
  into canonical_email, canonical_orga_code, event_name, canonical_summary
  from "entry" e
  join "person" p on p."id" = e."driver_person_id"
  join "registration_group" rg on rg."id" = e."registration_group_id"
  join "event" ev on ev."id" = e."event_id"
  join "class" c on c."id" = e."class_id"
  where e."id" = canonical_entry_id;

  select
    coalesce(p."email", rg."driver_email_norm"),
    c."name" || ' · Startnummer ' || coalesce(e."start_number_norm", '—')
  into secondary_email, secondary_summary
  from "entry" e
  join "person" p on p."id" = e."driver_person_id"
  join "registration_group" rg on rg."id" = e."registration_group_id"
  join "class" c on c."id" = e."class_id"
  where e."id" = secondary_entry_id;

  select
    coalesce(canonical."pricing_snapshot"->'manualOverrides', '{}'::jsonb)
      || coalesce(secondary."pricing_snapshot"->'manualOverrides', '{}'::jsonb)
  into merged_overrides
  from "invoice" canonical
  cross join "invoice" secondary
  where canonical."id" = canonical_invoice_id
    and secondary."id" = secondary_invoice_id;

  if coalesce((merged_overrides->>canonical_entry_id::text)::integer, -1) <> 0
    or coalesce((merged_overrides->>secondary_entry_id::text)::integer, -1) <> 0 then
    raise exception '0072 Hartmann manual override fingerprint mismatch';
  end if;

  update "vehicle" v
  set "owner_person_id" = canonical_person_id,
      "updated_at" = now()
  where v."id" in (
    select e."vehicle_id" from "entry" e where e."id" = secondary_entry_id
    union
    select e."backup_vehicle_id" from "entry" e
    where e."id" = secondary_entry_id and e."backup_vehicle_id" is not null
  );

  update "entry"
  set "driver_person_id" = canonical_person_id,
      "registration_group_id" = canonical_group_id,
      "driver_email_norm" = lower(canonical_email),
      "orga_code" = canonical_orga_code,
      "updated_at" = now()
  where "id" = secondary_entry_id;

  update "entry_run_group_reservation"
  set "driver_person_id" = canonical_person_id
  where "entry_id" = secondary_entry_id;

  update "registration_group"
  set "driver_person_id" = canonical_person_id,
      "driver_email_norm" = lower(canonical_email),
      "updated_at" = now()
  where "id" = canonical_group_id;

  update "registration_group"
  set "deleted_at" = now(),
      "updated_at" = now()
  where "id" = secondary_group_id
    and "deleted_at" is null;

  update "public_entry_submission"
  set "response_payload" = jsonb_set("response_payload", '{groupId}', to_jsonb(canonical_group_id::text), false),
      "updated_at" = now()
  where "event_id" = target_event_id
    and "response_payload"->>'groupId' = secondary_group_id::text;

  update "vehicle_image_upload"
  set "consumed_by_registration_group_id" = canonical_group_id,
      "updated_at" = now()
  where "consumed_by_registration_group_id" = secondary_group_id;

  update "registration_invitation"
  set "consumed_registration_group_id" = canonical_group_id,
      "updated_at" = now()
  where "consumed_registration_group_id" = secondary_group_id;

  update "document"
  set "driver_person_id" = canonical_person_id
  where "event_id" = target_event_id
    and ("entry_id" = secondary_entry_id or "driver_person_id" = secondary_person_id);

  delete from "invoice" where "id" = secondary_invoice_id;

  with ranked as (
    select
      e."id" as entry_id,
      e."class_id",
      e."created_at",
      e."acceptance_status",
      cpr."base_fee_cents",
      rules."early_deadline",
      rules."late_fee_cents",
      rules."second_vehicle_discount_cents",
      row_number() over (order by e."created_at", e."id") as entry_rank
    from "entry" e
    join "event_pricing_rule" rules on rules."event_id" = e."event_id"
    join "class_pricing_rule" cpr
      on cpr."event_id" = e."event_id" and cpr."class_id" = e."class_id"
    where e."event_id" = target_event_id
      and e."driver_person_id" = canonical_person_id
      and e."deleted_at" is null
      and e."acceptance_status" not in ('rejected', 'withdrawn')
  ), calculated as (
    select
      ranked.*,
      case when merged_overrides ? ranked.entry_id::text
        then (merged_overrides->>ranked.entry_id::text)::integer
        else null
      end as manual_override_cents,
      case when ranked."created_at" > ranked."early_deadline"
        then ranked."late_fee_cents" else 0
      end as applied_late_fee_cents,
      case when ranked.entry_rank >= 2
        then ranked."second_vehicle_discount_cents" else 0
      end as applied_discount_cents
    from ranked
  ), lines as (
    select
      calculated.*,
      greatest(0, coalesce(
        calculated.manual_override_cents,
        calculated."base_fee_cents"
          + calculated.applied_late_fee_cents
          - calculated.applied_discount_cents
      ))::integer as line_total_cents,
      jsonb_build_object(
        'entryId', calculated.entry_id,
        'classId', calculated."class_id",
        'baseFeeCents', calculated."base_fee_cents",
        'lateFeeCents', calculated.applied_late_fee_cents,
        'secondVehicleDiscountCents', calculated.applied_discount_cents,
        'manualOverrideCents', calculated.manual_override_cents,
        'lineTotalCents', greatest(0, coalesce(
          calculated.manual_override_cents,
          calculated."base_fee_cents"
            + calculated.applied_late_fee_cents
            - calculated.applied_discount_cents
        ))::integer,
        'submittedAt', to_char(calculated."created_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'acceptanceStatus', calculated."acceptance_status"
      ) as line
    from calculated
  )
  select jsonb_build_object(
    'ruleVersion', 2,
    'generatedAt', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'earlyDeadline', to_char(max("early_deadline") at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'lateFeeCents', max("late_fee_cents"),
    'secondVehicleDiscountCents', max("second_vehicle_discount_cents"),
    'manualOverrides', merged_overrides,
    'forecastLines', coalesce(jsonb_agg(line order by "created_at", entry_id), '[]'::jsonb),
    'forecastTotalCents', coalesce(sum(line_total_cents), 0),
    'lines', coalesce(jsonb_agg(line order by "created_at", entry_id)
      filter (where "acceptance_status" = 'accepted'), '[]'::jsonb),
    'totalCents', coalesce(sum(line_total_cents)
      filter (where "acceptance_status" = 'accepted'), 0)
  ) into merged_snapshot
  from lines;

  if coalesce((merged_snapshot->>'totalCents')::integer, -1) <> 0
    or jsonb_array_length(merged_snapshot->'lines') <> 2 then
    raise exception '0072 Hartmann merged pricing verification failed';
  end if;

  update "invoice"
  set "driver_person_id" = canonical_person_id,
      "total_cents" = 0,
      "pricing_snapshot" = merged_snapshot,
      "payment_status" = 'not_required',
      "paid_at" = null,
      "paid_amount_cents" = 0,
      "updated_at" = now()
  where "id" = canonical_invoice_id;

  insert into "audit_log" (
    "event_id", "actor_user_id", "action", "entity_type", "entity_id", "payload", "created_at"
  ) values (
    target_event_id,
    migration_actor,
    'doublestarter_registration_merged',
    'registration_group',
    canonical_group_id,
    jsonb_build_object(
      'migrationKey', migration_key,
      'canonicalGroupId', canonical_group_id,
      'secondaryGroupId', secondary_group_id,
      'canonicalPersonId', canonical_person_id,
      'secondaryPersonId', secondary_person_id,
      'entryIds', jsonb_build_array(canonical_entry_id, secondary_entry_id),
      'invoiceId', canonical_invoice_id,
      'totalCents', 0,
      'paymentStatus', 'not_required'
    ),
    now()
  );

  select v."version" into template_version
  from "email_template" t
  join "email_template_version" v on v."template_id" = t."id"
  where t."template_key" = 'doublestarter_migration_notice'
    and t."is_active" = true
    and v."status" = 'published'
  order by v."version" desc
  limit 1;
  if template_version is null then
    raise exception '0072 published doublestarter migration mail template missing';
  end if;

  insert into "email_outbox" (
    "event_id", "to_email", "subject", "template_id", "template_version", "template_data",
    "status", "send_after", "idempotency_key", "max_attempts", "created_at", "updated_at"
  )
  select
    target_event_id,
    recipient.email,
    'Information zu deinen Nennungen - {{eventName}}',
    'doublestarter_migration_notice',
    template_version,
    jsonb_build_object(
      'eventName', event_name,
      'driverName', 'Tim Hartmann',
      'driverPersonId', canonical_person_id,
      'registrationGroupId', canonical_group_id,
      'entryCount', 2,
      'entrySummaries', jsonb_build_array(canonical_summary, secondary_summary),
      'preheader', 'Information zur Zusammenführung deiner Nennungen',
      'headerTitle', 'Nennungen wurden zusammengeführt',
      'renderOptions', jsonb_build_object('showBadge', false, 'mailLabel', null, 'includeEntryContext', true),
      'migrationKey', migration_key
    ),
    'queued',
    now(),
    'data-migration:0072:hartmann:' || recipient.role,
    5,
    now(),
    now()
  from (values
    ('canonical', canonical_email),
    ('secondary', secondary_email)
  ) as recipient(role, email)
  where recipient.email is not null
  on conflict do nothing;
end
$$;

do $$
declare
  migration_actor constant text := 'migration:0072_merge_hartmann_weck_registrations';
  migration_key constant text := 'weck-class6-to-class5';
  target_event_id constant uuid := 'e5dc0ac8-3a6f-4ee3-9a1c-45e2057d2a28';
  canonical_person_id constant uuid := '40d8af9d-f377-4862-a07d-3c1560abf2d5';
  secondary_person_id constant uuid := '78bd7176-868b-4b88-b6c6-10e5fcb18743';
  canonical_group_id constant uuid := '99b7a610-7039-4f84-9cd3-0cf61fb70fc2';
  secondary_group_id constant uuid := '0b7e5c5e-f201-48a4-a77f-76880af69ceb';
  withdrawn_entry_id constant uuid := '28879202-306f-49fd-8b28-7a119f0ad46f';
  retained_entry_id constant uuid := 'c006638d-8d47-4cfe-8b33-e42f9f1c81ca';
  replacement_entry_id constant uuid := '53a914f0-983e-4698-9934-e44e88eb478c';
  canonical_invoice_id constant uuid := '5d4a123a-0209-4f32-bdce-91f650ac68bd';
  secondary_invoice_id constant uuid := '63ebe041-ec6a-41d7-94c1-2bf84d6979b0';
  canonical_email text;
  secondary_email text;
  canonical_orga_code text;
  event_name text;
  retained_summary text;
  replacement_summary text;
  template_version integer;
  merged_overrides jsonb := jsonb_build_object(replacement_entry_id::text, 8000);
  merged_snapshot jsonb;
  affected_count integer;
begin
  if not exists (select 1 from "event" where "id" = target_event_id) then
    return;
  end if;

  if exists (
    select 1 from "audit_log"
    where "event_id" = target_event_id
      and "action" = 'doublestarter_registration_merged'
      and "payload"->>'migrationKey' = migration_key
  ) then
    return;
  end if;

  perform "id" from "entry"
  where "id" in (withdrawn_entry_id, retained_entry_id, replacement_entry_id)
  order by "id"
  for update;
  perform "id" from "registration_group"
  where "id" in (canonical_group_id, secondary_group_id)
  order by "id"
  for update;
  perform "id" from "invoice"
  where "id" in (canonical_invoice_id, secondary_invoice_id)
  order by "id"
  for update;

  select count(*) into affected_count
  from "entry" e
  join "person" p on p."id" = e."driver_person_id"
  where (
    (
        e."id" in (withdrawn_entry_id, retained_entry_id)
        and e."driver_person_id" = canonical_person_id
        and e."registration_group_id" = canonical_group_id
      ) or (
        e."id" = replacement_entry_id
        and e."driver_person_id" = secondary_person_id
        and e."registration_group_id" = secondary_group_id
      )
    )
    and e."event_id" = target_event_id
    and e."deleted_at" is null
    and e."registration_status" = 'submitted_verified'
    and e."acceptance_status" = 'accepted'
    and lower(trim(p."first_name")) = 'alexander'
    and lower(trim(p."last_name")) = 'weck'
    and p."birthdate" = date '1974-03-17';
  if affected_count <> 3 then
    raise exception '0072 Weck entry fingerprint mismatch';
  end if;

  if not exists (
    select 1 from "entry" e join "class" c on c."id" = e."class_id"
    where e."id" = withdrawn_entry_id
      and c."name" = 'Klasse 6 Rennmotorräder 500-1000 cm³ bis Bj. 1995'
      and e."start_number_norm" = '76'
  ) or not exists (
    select 1 from "entry" e join "class" c on c."id" = e."class_id"
    where e."id" = retained_entry_id
      and c."name" = 'Klasse 1 Motorräder bis Bj. 1949'
      and e."start_number_norm" = '77'
  ) or not exists (
    select 1 from "entry" e join "class" c on c."id" = e."class_id"
    where e."id" = replacement_entry_id
      and c."name" = 'Klasse 5 Rennmotorräder 350-400 cm³ bis Bj. 1995'
      and e."start_number_norm" = '67'
  ) then
    raise exception '0072 Weck class/start-number fingerprint mismatch';
  end if;

  if not exists (
    select 1 from "invoice"
    where "id" = canonical_invoice_id
      and "event_id" = target_event_id
      and "driver_person_id" = canonical_person_id
      and "total_cents" = 23000
      and "paid_amount_cents" = 23000
      and "payment_status" = 'paid'
  ) or not exists (
    select 1 from "invoice"
    where "id" = secondary_invoice_id
      and "event_id" = target_event_id
      and "driver_person_id" = secondary_person_id
      and "total_cents" = 0
      and coalesce("paid_amount_cents", 0) = 0
      and "payment_status" = 'not_required'
      and coalesce(("pricing_snapshot"->'manualOverrides'->>replacement_entry_id::text)::integer, -1) = 0
  ) or (select count(*) from "invoice_payment" where "invoice_id" = canonical_invoice_id) <> 1
    or coalesce((select sum("amount_cents") from "invoice_payment" where "invoice_id" = canonical_invoice_id), 0) <> 23000
    or exists (select 1 from "invoice_payment" where "invoice_id" = secondary_invoice_id) then
    raise exception '0072 Weck invoice/payment fingerprint mismatch';
  end if;

  select
    coalesce(p."email", rg."driver_email_norm"),
    e."orga_code",
    ev."name"
  into canonical_email, canonical_orga_code, event_name
  from "entry" e
  join "person" p on p."id" = e."driver_person_id"
  join "registration_group" rg on rg."id" = e."registration_group_id"
  join "event" ev on ev."id" = e."event_id"
  where e."id" = retained_entry_id;

  select coalesce(p."email", rg."driver_email_norm")
  into secondary_email
  from "entry" e
  join "person" p on p."id" = e."driver_person_id"
  join "registration_group" rg on rg."id" = e."registration_group_id"
  where e."id" = replacement_entry_id;

  select c."name" || ' · Startnummer ' || coalesce(e."start_number_norm", '—')
  into retained_summary
  from "entry" e join "class" c on c."id" = e."class_id"
  where e."id" = retained_entry_id;

  select c."name" || ' · Startnummer ' || coalesce(e."start_number_norm", '—')
  into replacement_summary
  from "entry" e join "class" c on c."id" = e."class_id"
  where e."id" = replacement_entry_id;

  update "entry"
  set "acceptance_status" = 'withdrawn',
      "withdrawn_reason" = 'Fahrzeug der Klasse-6-Nennung nicht einsatzfähig; Wechsel auf Klasse 5 gemäß Teilnehmerwunsch.',
      "withdrawn_at" = now(),
      "withdrawn_by" = migration_actor,
      "updated_at" = now()
  where "id" = withdrawn_entry_id;

  delete from "entry_start_number_reservation" where "entry_id" = withdrawn_entry_id;
  delete from "entry_run_group_reservation" where "entry_id" = withdrawn_entry_id;

  update "vehicle" v
  set "owner_person_id" = canonical_person_id,
      "updated_at" = now()
  where v."id" in (
    select e."vehicle_id" from "entry" e where e."id" = replacement_entry_id
    union
    select e."backup_vehicle_id" from "entry" e
    where e."id" = replacement_entry_id and e."backup_vehicle_id" is not null
  );

  update "entry"
  set "driver_person_id" = canonical_person_id,
      "registration_group_id" = canonical_group_id,
      "driver_email_norm" = lower(canonical_email),
      "orga_code" = canonical_orga_code,
      "updated_at" = now()
  where "id" = replacement_entry_id;

  update "entry_run_group_reservation"
  set "driver_person_id" = canonical_person_id
  where "entry_id" = replacement_entry_id;

  update "registration_group"
  set "driver_person_id" = canonical_person_id,
      "driver_email_norm" = lower(canonical_email),
      "updated_at" = now()
  where "id" = canonical_group_id;

  update "registration_group"
  set "deleted_at" = now(),
      "updated_at" = now()
  where "id" = secondary_group_id
    and "deleted_at" is null;

  update "public_entry_submission"
  set "response_payload" = jsonb_set("response_payload", '{groupId}', to_jsonb(canonical_group_id::text), false),
      "updated_at" = now()
  where "event_id" = target_event_id
    and "response_payload"->>'groupId' = secondary_group_id::text;

  update "vehicle_image_upload"
  set "consumed_by_registration_group_id" = canonical_group_id,
      "updated_at" = now()
  where "consumed_by_registration_group_id" = secondary_group_id;

  update "registration_invitation"
  set "consumed_registration_group_id" = canonical_group_id,
      "updated_at" = now()
  where "consumed_registration_group_id" = secondary_group_id;

  update "document"
  set "driver_person_id" = canonical_person_id
  where "event_id" = target_event_id
    and ("entry_id" = replacement_entry_id or "driver_person_id" = secondary_person_id);

  delete from "invoice" where "id" = secondary_invoice_id;

  with ranked as (
    select
      e."id" as entry_id,
      e."class_id",
      e."created_at",
      e."acceptance_status",
      cpr."base_fee_cents",
      rules."early_deadline",
      rules."late_fee_cents",
      rules."second_vehicle_discount_cents",
      row_number() over (order by e."created_at", e."id") as entry_rank
    from "entry" e
    join "event_pricing_rule" rules on rules."event_id" = e."event_id"
    join "class_pricing_rule" cpr
      on cpr."event_id" = e."event_id" and cpr."class_id" = e."class_id"
    where e."event_id" = target_event_id
      and e."driver_person_id" = canonical_person_id
      and e."deleted_at" is null
      and e."acceptance_status" not in ('rejected', 'withdrawn')
  ), calculated as (
    select
      ranked.*,
      case when merged_overrides ? ranked.entry_id::text
        then (merged_overrides->>ranked.entry_id::text)::integer
        else null
      end as manual_override_cents,
      case when ranked."created_at" > ranked."early_deadline"
        then ranked."late_fee_cents" else 0
      end as applied_late_fee_cents,
      case when ranked.entry_rank >= 2
        then ranked."second_vehicle_discount_cents" else 0
      end as applied_discount_cents
    from ranked
  ), lines as (
    select
      calculated.*,
      greatest(0, coalesce(
        calculated.manual_override_cents,
        calculated."base_fee_cents"
          + calculated.applied_late_fee_cents
          - calculated.applied_discount_cents
      ))::integer as line_total_cents,
      jsonb_build_object(
        'entryId', calculated.entry_id,
        'classId', calculated."class_id",
        'baseFeeCents', calculated."base_fee_cents",
        'lateFeeCents', calculated.applied_late_fee_cents,
        'secondVehicleDiscountCents', calculated.applied_discount_cents,
        'manualOverrideCents', calculated.manual_override_cents,
        'lineTotalCents', greatest(0, coalesce(
          calculated.manual_override_cents,
          calculated."base_fee_cents"
            + calculated.applied_late_fee_cents
            - calculated.applied_discount_cents
        ))::integer,
        'submittedAt', to_char(calculated."created_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'acceptanceStatus', calculated."acceptance_status"
      ) as line
    from calculated
  )
  select jsonb_build_object(
    'ruleVersion', 2,
    'generatedAt', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'earlyDeadline', to_char(max("early_deadline") at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'lateFeeCents', max("late_fee_cents"),
    'secondVehicleDiscountCents', max("second_vehicle_discount_cents"),
    'manualOverrides', merged_overrides,
    'forecastLines', coalesce(jsonb_agg(line order by "created_at", entry_id), '[]'::jsonb),
    'forecastTotalCents', coalesce(sum(line_total_cents), 0),
    'lines', coalesce(jsonb_agg(line order by "created_at", entry_id)
      filter (where "acceptance_status" = 'accepted'), '[]'::jsonb),
    'totalCents', coalesce(sum(line_total_cents)
      filter (where "acceptance_status" = 'accepted'), 0)
  ) into merged_snapshot
  from lines;

  if coalesce((merged_snapshot->>'totalCents')::integer, -1) <> 23000
    or jsonb_array_length(merged_snapshot->'lines') <> 2
    or coalesce((merged_snapshot->'manualOverrides'->>replacement_entry_id::text)::integer, -1) <> 8000 then
    raise exception '0072 Weck merged pricing verification failed';
  end if;

  update "invoice"
  set "driver_person_id" = canonical_person_id,
      "total_cents" = 23000,
      "pricing_snapshot" = merged_snapshot,
      "payment_status" = 'paid',
      "paid_amount_cents" = 23000,
      "updated_at" = now()
  where "id" = canonical_invoice_id;

  insert into "audit_log" (
    "event_id", "actor_user_id", "action", "entity_type", "entity_id", "payload", "created_at"
  ) values
  (
    target_event_id,
    migration_actor,
    'entry_status_updated',
    'entry',
    withdrawn_entry_id,
    jsonb_build_object(
      'from', 'accepted',
      'to', 'withdrawn',
      'withdrawalReason', 'Fahrzeug der Klasse-6-Nennung nicht einsatzfähig; Wechsel auf Klasse 5 gemäß Teilnehmerwunsch.',
      'withdrawnAt', now()
    ),
    now()
  ),
  (
    target_event_id,
    migration_actor,
    'doublestarter_registration_merged',
    'registration_group',
    canonical_group_id,
    jsonb_build_object(
      'migrationKey', migration_key,
      'canonicalGroupId', canonical_group_id,
      'secondaryGroupId', secondary_group_id,
      'canonicalPersonId', canonical_person_id,
      'secondaryPersonId', secondary_person_id,
      'retainedEntryId', retained_entry_id,
      'withdrawnEntryId', withdrawn_entry_id,
      'replacementEntryId', replacement_entry_id,
      'invoiceId', canonical_invoice_id,
      'totalCents', 23000,
      'paidAmountCents', 23000,
      'replacementEntryTotalCents', 8000,
      'paymentStatus', 'paid'
    ),
    now()
  );

  select v."version" into template_version
  from "email_template" t
  join "email_template_version" v on v."template_id" = t."id"
  where t."template_key" = 'accepted_paid_completed'
    and t."is_active" = true
    and v."status" = 'published'
  order by v."version" desc
  limit 1;
  if template_version is null then
    raise exception '0072 published paid-completion mail template missing';
  end if;

  insert into "email_outbox" (
    "event_id", "to_email", "subject", "template_id", "template_version", "template_data",
    "status", "send_after", "idempotency_key", "max_attempts", "created_at", "updated_at"
  )
  select
    target_event_id,
    recipient.email,
    'Klassenwechsel und Zahlung bestätigt - {{eventName}}',
    'accepted_paid_completed',
    template_version,
    jsonb_build_object(
      'eventName', event_name,
      'driverName', 'Alexander Weck',
      'entryId', replacement_entry_id,
      'driverPersonId', canonical_person_id,
      'registrationGroupId', canonical_group_id,
      'entryCount', 2,
      'entrySummaries', jsonb_build_array(retained_summary, replacement_summary),
      'preheader', 'Klassenwechsel und Zahlungsübernahme bestätigt',
      'headerTitle', 'Klassenwechsel bestätigt',
      'bodyTextOverride', E'Hallo {{driverName}},\n\nwie vereinbart haben wir deine Nennungen für {{eventName}} aktualisiert.\n\nDie bisherige Nennung in Klasse 6 wurde zurückgezogen, da das dafür vorgesehene Fahrzeug nicht einsatzfähig ist. Deine neue Nennung in Klasse 5 haben wir mit deiner bestehenden Nennung in Klasse 1 zusammengeführt.\n\nDie bereits eingegangene Zahlung über 230,00 € wurde vollständig übernommen. Damit sind deine Nennungen in Klasse 1 (Startnummer 77) und Klasse 5 (Startnummer 67) vollständig bezahlt. Für den Fahrzeugwechsel berechnen wir keinen zusätzlichen Spätzuschlag.\n\nDu musst nichts weiter tun. Bei Rückfragen antworte einfach auf diese E-Mail.',
      'renderOptions', jsonb_build_object('showBadge', false, 'mailLabel', null, 'includeEntryContext', true),
      'migrationKey', migration_key
    ),
    'queued',
    now(),
    'data-migration:0072:weck:' || recipient.role,
    5,
    now(),
    now()
  from (values
    ('canonical', canonical_email),
    ('secondary', secondary_email)
  ) as recipient(role, email)
  where recipient.email is not null
  on conflict do nothing;
end
$$;
