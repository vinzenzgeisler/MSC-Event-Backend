-- The first class-change notice used a process template whose localized default
-- copy overrode the supplied subject and body. Queue a corrected notice and
-- attach the canonical recipient's copy directly to the retained class-1 entry.

do $$
declare
  target_event_id constant uuid := 'e5dc0ac8-3a6f-4ee3-9a1c-45e2057d2a28';
  canonical_person_id constant uuid := '40d8af9d-f377-4862-a07d-3c1560abf2d5';
  canonical_group_id constant uuid := '99b7a610-7039-4f84-9cd3-0cf61fb70fc2';
  retained_entry_id constant uuid := 'c006638d-8d47-4cfe-8b33-e42f9f1c81ca';
  replacement_entry_id constant uuid := '53a914f0-983e-4698-9934-e44e88eb478c';
  template_version integer;
  event_name text;
begin
  if not exists (select 1 from "event" where "id" = target_event_id) then
    return;
  end if;

  if not exists (
    select 1
    from "audit_log"
    where "event_id" = target_event_id
      and "action" = 'doublestarter_registration_merged'
      and "payload"->>'migrationKey' = 'weck-class6-to-class5'
  ) then
    raise exception '0073 Weck merge audit is missing';
  end if;

  if (select count(*) from "entry"
      where "id" in (retained_entry_id, replacement_entry_id)
        and "event_id" = target_event_id
        and "driver_person_id" = canonical_person_id
        and "registration_group_id" = canonical_group_id
        and "deleted_at" is null
        and "acceptance_status" = 'accepted') <> 2
    or not exists (
      select 1 from "invoice"
      where "event_id" = target_event_id
        and "driver_person_id" = canonical_person_id
        and "total_cents" = 23000
        and "paid_amount_cents" = 23000
        and "payment_status" = 'paid'
    ) then
    raise exception '0073 Weck merged state fingerprint mismatch';
  end if;

  if (select count(*) from "email_outbox"
      where "idempotency_key" like 'data-migration:0072:weck:%'
        and "status" = 'sent') <> 2 then
    raise exception '0073 original Weck mail fingerprint mismatch';
  end if;

  select ev."name" into event_name
  from "event" ev
  where ev."id" = target_event_id;

  select v."version" into template_version
  from "email_template" t
  join "email_template_version" v on v."template_id" = t."id"
  where t."template_key" = 'free_form'
    and t."is_active" = true
    and v."status" = 'published'
  order by v."version" desc
  limit 1;
  if template_version is null then
    raise exception '0073 published free-form mail template missing';
  end if;

  insert into "email_outbox" (
    "event_id", "to_email", "subject", "template_id", "template_version", "template_data",
    "status", "send_after", "idempotency_key", "max_attempts", "created_at", "updated_at"
  )
  select
    target_event_id,
    'n.krusch@arcor.de',
    'Klassenwechsel und Zahlung bestätigt - {{eventName}}',
    'free_form',
    template_version,
    jsonb_build_object(
      'eventName', event_name,
      'driverName', 'Alexander Weck',
      'entryId', retained_entry_id,
      'driverPersonId', canonical_person_id,
      'registrationGroupId', canonical_group_id,
      'entryCount', 2,
      'entrySummaries', jsonb_build_array(
        'Klasse 1 Motorräder bis Bj. 1949 · Startnummer 77',
        'Klasse 5 Rennmotorräder 350-400 cm³ bis Bj. 1995 · Startnummer 67'
      ),
      'preheader', 'Klassenwechsel und Zahlungsübernahme bestätigt',
      'headerTitle', 'Klassenwechsel bestätigt',
      'bodyTextOverride', E'Hallo {{driverName}},\n\nwie vereinbart haben wir deine Nennungen für {{eventName}} aktualisiert.\n\nDie bisherige Nennung in Klasse 6 wurde zurückgezogen, da das dafür vorgesehene Fahrzeug nicht einsatzfähig ist. Deine neue Nennung in Klasse 5 haben wir mit deiner bestehenden Nennung in Klasse 1 zusammengeführt.\n\nDie bereits eingegangene Zahlung über 230,00 € wurde vollständig übernommen. Damit sind deine Nennungen in Klasse 1 (Startnummer 77) und Klasse 5 (Startnummer 67) vollständig bezahlt. Für den Fahrzeugwechsel berechnen wir keinen zusätzlichen Aufschlag.\n\nDu musst nichts weiter tun. Bei Rückfragen antworte einfach auf diese E-Mail.',
      'bodyHtmlOverride', '<p>Hallo {{driverName}},</p><p>wie vereinbart haben wir deine Nennungen für <strong>{{eventName}}</strong> aktualisiert.</p><p>Die bisherige Nennung in Klasse 6 wurde zurückgezogen, da das dafür vorgesehene Fahrzeug nicht einsatzfähig ist. Deine neue Nennung in Klasse 5 haben wir mit deiner bestehenden Nennung in Klasse 1 zusammengeführt.</p><p>Die bereits eingegangene Zahlung über <strong>230,00 €</strong> wurde vollständig übernommen. Damit sind deine Nennungen in Klasse 1 (Startnummer 77) und Klasse 5 (Startnummer 67) vollständig bezahlt. Für den Fahrzeugwechsel berechnen wir keinen zusätzlichen Aufschlag.</p><p>Du musst nichts weiter tun. Bei Rückfragen antworte einfach auf diese E-Mail.</p>',
      'renderOptions', jsonb_build_object('showBadge', false, 'mailLabel', null, 'includeEntryContext', true),
      'migrationKey', 'weck-class-change-notice-corrected'
    ),
    'queued',
    now(),
    'data-migration:0073:weck-corrected:class1',
    5,
    now(),
    now()
  on conflict do nothing;

  if not exists (
    select 1 from "audit_log"
    where "event_id" = target_event_id
      and "action" = 'class_change_notice_queued'
      and "payload"->>'migrationKey' = 'weck-class-change-notice-corrected'
  ) then
    insert into "audit_log" (
      "event_id", "actor_user_id", "action", "entity_type", "entity_id", "payload", "created_at"
    )
    select
      target_event_id,
      'migration:0073_resend_weck_class_change_notice',
      'class_change_notice_queued',
      'registration_group',
      canonical_group_id,
      jsonb_build_object(
        'migrationKey', 'weck-class-change-notice-corrected',
        'entryIds', jsonb_build_array(retained_entry_id, replacement_entry_id),
        'outboxIds', coalesce(jsonb_agg("id" order by "created_at"), '[]'::jsonb)
      ),
      now()
    from "email_outbox"
    where "idempotency_key" = 'data-migration:0073:weck-corrected:class1';
  end if;
end
$$;
