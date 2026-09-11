-- Merge the two confirmed active duplicate registration identities. The migration
-- is deliberately fingerprinted to the current production records and no-ops in
-- environments that do not contain the target event.

do $$
declare
  migration_actor constant text := 'migration:0088_merge_schreiber_mueller_registrations';
  target_event_id constant uuid := 'e5dc0ac8-3a6f-4ee3-9a1c-45e2057d2a28';
  target record;
  canonical_email text;
  secondary_email text;
  canonical_orga_code text;
  event_name text;
  driver_name text;
  template_version integer;
  merged_overrides jsonb;
  merged_snapshot jsonb;
  entry_summaries jsonb;
  affected_count integer;
begin
  if not exists (select 1 from "event" where "id" = target_event_id) then
    return;
  end if;

  select v."version" into template_version
  from "email_template" t
  join "email_template_version" v on v."template_id" = t."id"
  where t."template_key" = 'doublestarter_migration_notice'
    and t."is_active" = true
    and v."status" = 'published'
  order by v."version" desc
  limit 1;
  if template_version is null then
    raise exception '0088 published doublestarter migration mail template missing';
  end if;

  for target in
    select *
    from (values
      (
        'christian-schreiber-class8-class6'::text,
        'Christian Schreiber'::text,
        'b47ad3ae-02fb-4b75-bc2f-5615d90992fe'::uuid,
        'f8903524-5918-410a-beb3-cb17c08cfef7'::uuid,
        '2b412037-0d26-4dd6-b965-27f47fca14b4'::uuid,
        'ca4d2a75-52d5-4a77-af65-633b363a16f9'::uuid,
        array['3713ca4a-5147-4296-9f54-9ae47be07efe'::uuid],
        '2ad36ea1-e800-4da6-8fa9-e2a5a1660771'::uuid,
        '191091de-81d0-462d-babe-c982ae69be53'::uuid,
        '8'::text,
        'submitted_verified'::text,
        'accepted'::text,
        'a1fa7414-df30-4e6d-b39f-d2954159265e'::uuid,
        '8b7afab2-abae-4692-b27c-a48c6208a07f'::uuid,
        'not_required'::text,
        2::integer,
        2::integer,
        0::integer,
        0::integer
      ),
      (
        'nico-mueller-class8-class6-class4'::text,
        'Nico Müller'::text,
        '271f8fd5-dff6-4bb2-9d4d-ba68676e3735'::uuid,
        'baea7f7c-9a22-4c40-888e-941d66c501cf'::uuid,
        '64d68f9a-6162-4928-89ca-6e5b681b6630'::uuid,
        'c02cdcc9-ba38-4220-a83b-2e8b9b875e27'::uuid,
        array[
          '41547921-cbff-4c78-a6ca-cc955a9cb441'::uuid,
          '1939dd81-d844-47f0-88f1-669db6f797fa'::uuid
        ],
        '7abda4a8-087c-419e-ab5f-9d6233048ef2'::uuid,
        '70d7c394-fd66-47e7-99bb-1e1832ea9e5d'::uuid,
        '21'::text,
        'submitted_unverified'::text,
        'pending'::text,
        '3680c9a4-735b-44a3-a92a-ab379a59702e'::uuid,
        '272481e6-5040-4ea8-90c6-cb5beb11b218'::uuid,
        'due'::text,
        3::integer,
        2::integer,
        0::integer,
        11000::integer
      )
    ) as cases(
      migration_key, driver_display_name, canonical_person_id, secondary_person_id,
      canonical_group_id, secondary_group_id, canonical_entry_ids, secondary_entry_id,
      secondary_class_id, secondary_start_number, secondary_registration_status,
      secondary_acceptance_status, canonical_invoice_id, secondary_invoice_id,
      secondary_invoice_status, expected_forecast_count, expected_accepted_count,
      expected_total_cents, expected_forecast_total_cents
    )
  loop
    if exists (
      select 1 from "audit_log"
      where "event_id" = target_event_id
        and "action" = 'doublestarter_registration_merged'
        and "payload"->>'migrationKey' = target.migration_key
    ) then
      continue;
    end if;

    perform "id" from "entry"
    where "id" = any(target.canonical_entry_ids || array[target.secondary_entry_id])
    order by "id" for update;
    perform "id" from "registration_group"
    where "id" in (target.canonical_group_id, target.secondary_group_id)
    order by "id" for update;
    perform "id" from "invoice"
    where "id" in (target.canonical_invoice_id, target.secondary_invoice_id)
    order by "id" for update;

    select count(*) into affected_count
    from "entry" e
    join "person" p on p."id" = e."driver_person_id"
    where e."id" = any(target.canonical_entry_ids)
      and e."event_id" = target_event_id
      and e."driver_person_id" = target.canonical_person_id
      and e."registration_group_id" = target.canonical_group_id
      and e."deleted_at" is null
      and e."registration_status" = 'submitted_verified'
      and e."acceptance_status" = 'accepted'
      and lower(trim(p."first_name" || ' ' || p."last_name")) = lower(target.driver_display_name);
    if affected_count <> cardinality(target.canonical_entry_ids) then
      raise exception '0088 % canonical entry fingerprint mismatch', target.migration_key;
    end if;

    select count(*) into affected_count
    from "entry" e
    join "person" p on p."id" = e."driver_person_id"
    join "person" canonical on canonical."id" = target.canonical_person_id
    where e."id" = target.secondary_entry_id
      and e."event_id" = target_event_id
      and e."driver_person_id" = target.secondary_person_id
      and e."registration_group_id" = target.secondary_group_id
      and e."class_id" = target.secondary_class_id
      and e."start_number_norm" = target.secondary_start_number
      and e."deleted_at" is null
      and e."registration_status" = target.secondary_registration_status
      and e."acceptance_status" = target.secondary_acceptance_status
      and lower(trim(p."first_name" || ' ' || p."last_name")) = lower(target.driver_display_name)
      and p."birthdate" = canonical."birthdate"
      and regexp_replace(coalesce(p."phone", ''), '\D', '', 'g')
        = regexp_replace(coalesce(canonical."phone", ''), '\D', '', 'g')
      and p."zip" = canonical."zip";
    if affected_count <> 1 then
      raise exception '0088 % secondary identity fingerprint mismatch', target.migration_key;
    end if;

    if not exists (
      select 1 from "invoice"
      where "id" = target.canonical_invoice_id
        and "event_id" = target_event_id
        and "driver_person_id" = target.canonical_person_id
        and "total_cents" = 0
        and coalesce("paid_amount_cents", 0) = 0
        and "payment_status" = 'not_required'
    ) or not exists (
      select 1 from "invoice"
      where "id" = target.secondary_invoice_id
        and "event_id" = target_event_id
        and "driver_person_id" = target.secondary_person_id
        and "total_cents" = 0
        and coalesce("paid_amount_cents", 0) = 0
        and "payment_status" = target.secondary_invoice_status
    ) or exists (
      select 1 from "invoice_payment"
      where "invoice_id" in (target.canonical_invoice_id, target.secondary_invoice_id)
    ) then
      raise exception '0088 % invoice fingerprint mismatch', target.migration_key;
    end if;

    if exists (
      select 1
      from "entry_run_group_reservation" secondary
      join "entry_run_group_reservation" canonical
        on canonical."event_id" = secondary."event_id"
       and canonical."driver_person_id" = target.canonical_person_id
       and canonical."effective_group_id" = secondary."effective_group_id"
      where secondary."entry_id" = target.secondary_entry_id
    ) then
      raise exception '0088 % run-group conflict', target.migration_key;
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
    where e."id" = target.canonical_entry_ids[1];

    select coalesce(p."email", rg."driver_email_norm") into secondary_email
    from "entry" e
    join "person" p on p."id" = e."driver_person_id"
    join "registration_group" rg on rg."id" = e."registration_group_id"
    where e."id" = target.secondary_entry_id;

    select coalesce(canonical."pricing_snapshot"->'manualOverrides', '{}'::jsonb)
      || coalesce(secondary."pricing_snapshot"->'manualOverrides', '{}'::jsonb)
    into merged_overrides
    from "invoice" canonical
    cross join "invoice" secondary
    where canonical."id" = target.canonical_invoice_id
      and secondary."id" = target.secondary_invoice_id;

    update "vehicle" v
    set "owner_person_id" = target.canonical_person_id,
        "updated_at" = now()
    where v."id" in (
      select e."vehicle_id" from "entry" e where e."id" = target.secondary_entry_id
      union
      select e."backup_vehicle_id" from "entry" e
      where e."id" = target.secondary_entry_id and e."backup_vehicle_id" is not null
    );

    update "entry"
    set "driver_person_id" = target.canonical_person_id,
        "registration_group_id" = target.canonical_group_id,
        "driver_email_norm" = lower(canonical_email),
        "orga_code" = canonical_orga_code,
        "registration_status" = 'submitted_verified',
        "confirmation_mail_verified_at" = coalesce("confirmation_mail_verified_at", now()),
        "updated_at" = now()
    where "id" = target.secondary_entry_id;

    update "entry_run_group_reservation"
    set "driver_person_id" = target.canonical_person_id
    where "entry_id" = target.secondary_entry_id;

    update "registration_group"
    set "driver_person_id" = target.canonical_person_id,
        "driver_email_norm" = lower(canonical_email),
        "updated_at" = now()
    where "id" = target.canonical_group_id;

    update "registration_group"
    set "deleted_at" = now(), "updated_at" = now()
    where "id" = target.secondary_group_id and "deleted_at" is null;

    delete from "registration_group_email_verification"
    where "registration_group_id" = target.secondary_group_id
      and "verified_at" is null;

    update "public_entry_submission"
    set "response_payload" = jsonb_set("response_payload", '{groupId}', to_jsonb(target.canonical_group_id::text), false),
        "updated_at" = now()
    where "event_id" = target_event_id
      and "response_payload"->>'groupId' = target.secondary_group_id::text;

    update "vehicle_image_upload"
    set "consumed_by_registration_group_id" = target.canonical_group_id, "updated_at" = now()
    where "consumed_by_registration_group_id" = target.secondary_group_id;

    update "registration_invitation"
    set "consumed_registration_group_id" = target.canonical_group_id, "updated_at" = now()
    where "consumed_registration_group_id" = target.secondary_group_id;

    update "document"
    set "driver_person_id" = target.canonical_person_id
    where "event_id" = target_event_id
      and ("entry_id" = target.secondary_entry_id or "driver_person_id" = target.secondary_person_id);

    delete from "invoice" where "id" = target.secondary_invoice_id;

    with ranked as (
      select
        e."id" as entry_id, e."class_id", e."created_at", e."acceptance_status",
        cpr."base_fee_cents", rules."early_deadline", rules."late_fee_cents",
        rules."second_vehicle_discount_cents",
        row_number() over (order by e."created_at", e."id") as entry_rank
      from "entry" e
      join "event_pricing_rule" rules on rules."event_id" = e."event_id"
      join "class_pricing_rule" cpr
        on cpr."event_id" = e."event_id" and cpr."class_id" = e."class_id"
      where e."event_id" = target_event_id
        and e."driver_person_id" = target.canonical_person_id
        and e."deleted_at" is null
        and e."acceptance_status" not in ('rejected', 'withdrawn')
    ), calculated as (
      select
        ranked.*,
        case when merged_overrides ? ranked.entry_id::text
          then (merged_overrides->>ranked.entry_id::text)::integer else null end as manual_override_cents,
        case when ranked."created_at" > ranked."early_deadline"
          then ranked."late_fee_cents" else 0 end as applied_late_fee_cents,
        case when ranked.entry_rank >= 2
          then ranked."second_vehicle_discount_cents" else 0 end as applied_discount_cents
      from ranked
    ), lines as (
      select
        calculated.*,
        greatest(0, coalesce(
          calculated.manual_override_cents,
          calculated."base_fee_cents" + calculated.applied_late_fee_cents - calculated.applied_discount_cents
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
            calculated."base_fee_cents" + calculated.applied_late_fee_cents - calculated.applied_discount_cents
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

    if jsonb_array_length(merged_snapshot->'forecastLines') <> target.expected_forecast_count
      or jsonb_array_length(merged_snapshot->'lines') <> target.expected_accepted_count
      or coalesce((merged_snapshot->>'totalCents')::integer, -1) <> target.expected_total_cents
      or coalesce((merged_snapshot->>'forecastTotalCents')::integer, -1) <> target.expected_forecast_total_cents then
      raise exception '0088 % merged pricing verification failed', target.migration_key;
    end if;

    update "invoice"
    set "driver_person_id" = target.canonical_person_id,
        "total_cents" = target.expected_total_cents,
        "pricing_snapshot" = merged_snapshot,
        "payment_status" = 'not_required',
        "paid_at" = null,
        "paid_amount_cents" = 0,
        "updated_at" = now()
    where "id" = target.canonical_invoice_id;

    select coalesce(jsonb_agg(summary order by created_at, entry_id), '[]'::jsonb)
    into entry_summaries
    from (
      select e."id" as entry_id, e."created_at",
        c."name" || ' · Startnummer ' || coalesce(e."start_number_norm", '—') as summary
      from "entry" e
      join "class" c on c."id" = e."class_id"
      where e."event_id" = target_event_id
        and e."driver_person_id" = target.canonical_person_id
        and e."deleted_at" is null
        and e."acceptance_status" not in ('rejected', 'withdrawn')
    ) summaries;

    insert into "audit_log" (
      "event_id", "actor_user_id", "action", "entity_type", "entity_id", "payload", "created_at"
    ) values (
      target_event_id,
      migration_actor,
      'doublestarter_registration_merged',
      'registration_group',
      target.canonical_group_id,
      jsonb_build_object(
        'migrationKey', target.migration_key,
        'canonicalGroupId', target.canonical_group_id,
        'secondaryGroupId', target.secondary_group_id,
        'canonicalPersonId', target.canonical_person_id,
        'secondaryPersonId', target.secondary_person_id,
        'entryIds', target.canonical_entry_ids || array[target.secondary_entry_id],
        'invoiceId', target.canonical_invoice_id,
        'totalCents', target.expected_total_cents,
        'forecastTotalCents', target.expected_forecast_total_cents,
        'paymentStatus', 'not_required'
      ),
      now()
    );

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
        'driverName', target.driver_display_name,
        'driverPersonId', target.canonical_person_id,
        'registrationGroupId', target.canonical_group_id,
        'entryCount', target.expected_forecast_count,
        'entrySummaries', entry_summaries,
        'preheader', 'Information zur Zusammenführung deiner Nennungen',
        'headerTitle', 'Nennungen wurden zusammengeführt',
        'renderOptions', jsonb_build_object('showBadge', false, 'mailLabel', null, 'includeEntryContext', true),
        'migrationKey', target.migration_key
      ),
      'queued',
      now(),
      'data-migration:0088:' || target.migration_key || ':' || recipient.role,
      5,
      now(),
      now()
    from (values
      ('canonical', canonical_email),
      ('secondary', secondary_email)
    ) as recipient(role, email)
    where recipient.email is not null
    on conflict do nothing;
  end loop;
end
$$;
