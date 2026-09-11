-- Merge Tom van Beek's newly submitted class-4 registration into his existing
-- paid registration group. The withdrawn class-3 entry remains historical.

do $$
declare
  migration_actor constant text := 'migration:0089_merge_tom_van_beek_registration';
  migration_key constant text := 'tom-van-beek-class7-class4';
  target_event_id constant uuid := 'e5dc0ac8-3a6f-4ee3-9a1c-45e2057d2a28';
  canonical_person_id constant uuid := '3eb120b7-9f54-4f4f-a941-5230ac95e3ad';
  secondary_person_id constant uuid := '02e01f4e-0265-4ce7-8af8-0c157a3313ac';
  canonical_group_id constant uuid := 'e154f55d-22c0-4fe2-b7c7-1d7998cddcdb';
  secondary_group_id constant uuid := 'de82e91d-28b4-430e-b8a5-caf6ab1e5d5e';
  canonical_entry_id constant uuid := '2f771798-91e4-40e4-8abd-db26c2007afc';
  secondary_entry_id constant uuid := 'cd8168c3-f453-4e2a-a4b2-0d7831ec10fc';
  withdrawn_entry_id constant uuid := '08a09483-df49-4acb-9ac3-635c6b158b3c';
  canonical_invoice_id constant uuid := '9aa74895-258d-4b5a-b779-f5345faf6e01';
  secondary_invoice_id constant uuid := '8201b937-fae4-4424-b338-c1f0474e7fe6';
  canonical_email text;
  secondary_email text;
  canonical_orga_code text;
  event_name text;
  template_version integer;
  merged_overrides jsonb;
  merged_snapshot jsonb;
  entry_summaries jsonb;
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
  where "id" in (canonical_entry_id, secondary_entry_id, withdrawn_entry_id)
  order by "id" for update;
  perform "id" from "registration_group"
  where "id" in (canonical_group_id, secondary_group_id)
  order by "id" for update;
  perform "id" from "invoice"
  where "id" in (canonical_invoice_id, secondary_invoice_id)
  order by "id" for update;

  select count(*) into affected_count
  from "entry" e
  join "person" p on p."id" = e."driver_person_id"
  where (
      (e."id" = canonical_entry_id and e."acceptance_status" = 'accepted'
        and e."class_id" = '68446767-12f6-4f71-9ac7-e558b87ec2f9'::uuid and e."start_number_norm" = '1')
      or
      (e."id" = withdrawn_entry_id and e."acceptance_status" = 'withdrawn'
        and e."class_id" = 'f7e5afd4-c975-4e54-8003-f21b5acc23a5'::uuid and e."start_number_norm" = '3')
    )
    and e."event_id" = target_event_id
    and e."driver_person_id" = canonical_person_id
    and e."registration_group_id" = canonical_group_id
    and e."deleted_at" is null
    and e."registration_status" = 'submitted_verified'
    and lower(trim(p."first_name" || ' ' || p."last_name")) = 'tom van beek'
    and p."birthdate" = date '2005-05-27';
  if affected_count <> 2 then
    raise exception '0089 canonical entry fingerprint mismatch';
  end if;

  select count(*) into affected_count
  from "entry" e
  join "person" p on p."id" = e."driver_person_id"
  join "person" canonical on canonical."id" = canonical_person_id
  where e."id" = secondary_entry_id
    and e."event_id" = target_event_id
    and e."driver_person_id" = secondary_person_id
    and e."registration_group_id" = secondary_group_id
    and e."class_id" = '70d7c394-fd66-47e7-99bb-1e1832ea9e5d'::uuid
    and e."start_number_norm" = '42'
    and e."deleted_at" is null
    and e."registration_status" = 'submitted_verified'
    and e."acceptance_status" = 'pending'
    and lower(trim(p."first_name" || ' ' || p."last_name")) = 'tom van beek'
    and p."birthdate" = canonical."birthdate"
    and right(regexp_replace(coalesce(p."phone", ''), '\D', '', 'g'), 9)
      = right(regexp_replace(coalesce(canonical."phone", ''), '\D', '', 'g'), 9)
    and replace(p."zip", ' ', '') = replace(canonical."zip", ' ', '');
  if affected_count <> 1 then
    raise exception '0089 secondary identity fingerprint mismatch';
  end if;

  if not exists (
    select 1 from "invoice"
    where "id" = canonical_invoice_id
      and "event_id" = target_event_id
      and "driver_person_id" = canonical_person_id
      and "total_cents" = 15000
      and "paid_amount_cents" = 15000
      and "payment_status" = 'paid'
  ) or not exists (
    select 1 from "invoice"
    where "id" = secondary_invoice_id
      and "event_id" = target_event_id
      and "driver_person_id" = secondary_person_id
      and "total_cents" = 0
      and coalesce("paid_amount_cents", 0) = 0
      and "payment_status" = 'due'
  ) or (
    select coalesce(sum("amount_cents"), 0) from "invoice_payment"
    where "invoice_id" = canonical_invoice_id
  ) <> 15000 or exists (
    select 1 from "invoice_payment" where "invoice_id" = secondary_invoice_id
  ) then
    raise exception '0089 invoice fingerprint mismatch';
  end if;

  if exists (
    select 1
    from "entry_run_group_reservation" secondary
    join "entry_run_group_reservation" canonical
      on canonical."event_id" = secondary."event_id"
     and canonical."driver_person_id" = canonical_person_id
     and canonical."effective_group_id" = secondary."effective_group_id"
    where secondary."entry_id" = secondary_entry_id
  ) then
    raise exception '0089 run-group conflict';
  end if;

  select coalesce(p."email", rg."driver_email_norm"), e."orga_code", ev."name"
  into canonical_email, canonical_orga_code, event_name
  from "entry" e
  join "person" p on p."id" = e."driver_person_id"
  join "registration_group" rg on rg."id" = e."registration_group_id"
  join "event" ev on ev."id" = e."event_id"
  where e."id" = canonical_entry_id;

  select coalesce(p."email", rg."driver_email_norm") into secondary_email
  from "entry" e
  join "person" p on p."id" = e."driver_person_id"
  join "registration_group" rg on rg."id" = e."registration_group_id"
  where e."id" = secondary_entry_id;

  select coalesce(canonical."pricing_snapshot"->'manualOverrides', '{}'::jsonb)
    || coalesce(secondary."pricing_snapshot"->'manualOverrides', '{}'::jsonb)
  into merged_overrides
  from "invoice" canonical cross join "invoice" secondary
  where canonical."id" = canonical_invoice_id and secondary."id" = secondary_invoice_id;

  if coalesce((merged_overrides->>canonical_entry_id::text)::integer, -1) <> 15000
    or coalesce((merged_overrides->>withdrawn_entry_id::text)::integer, -1) <> 8000 then
    raise exception '0089 manual override fingerprint mismatch';
  end if;

  update "vehicle" v
  set "owner_person_id" = canonical_person_id, "updated_at" = now()
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
  set "deleted_at" = now(), "updated_at" = now()
  where "id" = secondary_group_id and "deleted_at" is null;

  update "public_entry_submission"
  set "response_payload" = jsonb_set("response_payload", '{groupId}', to_jsonb(canonical_group_id::text), false),
      "updated_at" = now()
  where "event_id" = target_event_id and "response_payload"->>'groupId' = secondary_group_id::text;

  update "vehicle_image_upload"
  set "consumed_by_registration_group_id" = canonical_group_id, "updated_at" = now()
  where "consumed_by_registration_group_id" = secondary_group_id;

  update "registration_invitation"
  set "consumed_registration_group_id" = canonical_group_id, "updated_at" = now()
  where "consumed_registration_group_id" = secondary_group_id;

  update "document"
  set "driver_person_id" = canonical_person_id
  where "event_id" = target_event_id
    and ("entry_id" = secondary_entry_id or "driver_person_id" = secondary_person_id);

  delete from "invoice" where "id" = secondary_invoice_id;

  with ranked as (
    select e."id" as entry_id, e."class_id", e."created_at", e."acceptance_status",
      cpr."base_fee_cents", rules."early_deadline", rules."late_fee_cents",
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
    select ranked.*,
      case when merged_overrides ? ranked.entry_id::text
        then (merged_overrides->>ranked.entry_id::text)::integer else null end as manual_override_cents,
      case when ranked."created_at" > ranked."early_deadline"
        then ranked."late_fee_cents" else 0 end as applied_late_fee_cents,
      case when ranked.entry_rank >= 2
        then ranked."second_vehicle_discount_cents" else 0 end as applied_discount_cents
    from ranked
  ), lines as (
    select calculated.*,
      greatest(0, coalesce(manual_override_cents,
        "base_fee_cents" + applied_late_fee_cents - applied_discount_cents))::integer as line_total_cents,
      jsonb_build_object(
        'entryId', entry_id, 'classId', "class_id", 'baseFeeCents', "base_fee_cents",
        'lateFeeCents', applied_late_fee_cents,
        'secondVehicleDiscountCents', applied_discount_cents,
        'manualOverrideCents', manual_override_cents,
        'lineTotalCents', greatest(0, coalesce(manual_override_cents,
          "base_fee_cents" + applied_late_fee_cents - applied_discount_cents))::integer,
        'submittedAt', to_char("created_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'acceptanceStatus', "acceptance_status"
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

  if jsonb_array_length(merged_snapshot->'forecastLines') <> 2
    or jsonb_array_length(merged_snapshot->'lines') <> 1
    or coalesce((merged_snapshot->>'totalCents')::integer, -1) <> 15000
    or coalesce((merged_snapshot->>'forecastTotalCents')::integer, -1) <> 26000 then
    raise exception '0089 merged pricing verification failed';
  end if;

  update "invoice"
  set "driver_person_id" = canonical_person_id,
      "total_cents" = 15000,
      "pricing_snapshot" = merged_snapshot,
      "payment_status" = 'paid',
      "paid_amount_cents" = 15000,
      "updated_at" = now()
  where "id" = canonical_invoice_id;

  select coalesce(jsonb_agg(summary order by created_at, entry_id), '[]'::jsonb)
  into entry_summaries
  from (
    select e."id" as entry_id, e."created_at",
      c."name" || ' · Startnummer ' || coalesce(e."start_number_norm", '—') as summary
    from "entry" e join "class" c on c."id" = e."class_id"
    where e."event_id" = target_event_id
      and e."driver_person_id" = canonical_person_id
      and e."deleted_at" is null
      and e."acceptance_status" not in ('rejected', 'withdrawn')
  ) summaries;

  insert into "audit_log" (
    "event_id", "actor_user_id", "action", "entity_type", "entity_id", "payload", "created_at"
  ) values (
    target_event_id, migration_actor, 'doublestarter_registration_merged',
    'registration_group', canonical_group_id,
    jsonb_build_object(
      'migrationKey', migration_key,
      'canonicalGroupId', canonical_group_id,
      'secondaryGroupId', secondary_group_id,
      'canonicalPersonId', canonical_person_id,
      'secondaryPersonId', secondary_person_id,
      'retainedEntryId', canonical_entry_id,
      'withdrawnEntryId', withdrawn_entry_id,
      'mergedEntryId', secondary_entry_id,
      'invoiceId', canonical_invoice_id,
      'totalCents', 15000,
      'paidAmountCents', 15000,
      'forecastTotalCents', 26000,
      'paymentStatus', 'paid'
    ), now()
  );

  select v."version" into template_version
  from "email_template" t join "email_template_version" v on v."template_id" = t."id"
  where t."template_key" = 'doublestarter_migration_notice'
    and t."is_active" = true and v."status" = 'published'
  order by v."version" desc limit 1;
  if template_version is null then
    raise exception '0089 published doublestarter migration mail template missing';
  end if;

  insert into "email_outbox" (
    "event_id", "to_email", "subject", "template_id", "template_version", "template_data",
    "status", "send_after", "idempotency_key", "max_attempts", "created_at", "updated_at"
  )
  select target_event_id, recipient.email,
    'Information zu deinen Nennungen - {{eventName}}',
    'doublestarter_migration_notice', template_version,
    jsonb_build_object(
      'eventName', event_name,
      'driverName', 'Tom van Beek',
      'driverPersonId', canonical_person_id,
      'registrationGroupId', canonical_group_id,
      'entryCount', 2,
      'entrySummaries', entry_summaries,
      'preheader', 'Information zur Zusammenführung deiner Nennungen',
      'headerTitle', 'Nennungen wurden zusammengeführt',
      'renderOptions', jsonb_build_object('showBadge', false, 'mailLabel', null, 'includeEntryContext', true),
      'migrationKey', migration_key
    ),
    'queued', now(), 'data-migration:0089:tom-van-beek:' || recipient.role, 5, now(), now()
  from (values ('canonical', canonical_email), ('secondary', secondary_email)) as recipient(role, email)
  where recipient.email is not null
  on conflict do nothing;
end
$$;
