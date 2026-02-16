with upsert as (
  insert into "email_template" ("id", "template_key", "description", "is_active")
  values
    (gen_random_uuid(), 'registration_received', 'Eingang nach Anmeldung', true),
    (gen_random_uuid(), 'preselection', 'Vorauswahl', true),
    (gen_random_uuid(), 'accepted_open_payment', 'Nennung angenommen, Zahlung offen', true),
    (gen_random_uuid(), 'accepted_paid_completed', 'Zahlung bestätigt, Nennung abgeschlossen', true),
    (gen_random_uuid(), 'rejected', 'Absage', true),
    (gen_random_uuid(), 'waitlist', 'Warteliste', true),
    (gen_random_uuid(), 'payment_reminder', 'Zahlungserinnerung', true)
  on conflict ("template_key") do update
    set "description" = excluded."description",
        "is_active" = excluded."is_active",
        "updated_at" = now()
  returning "id", "template_key"
)
insert into "email_template_version" (
  "id",
  "template_id",
  "version",
  "subject_template",
  "body_template",
  "created_by"
)
select
  gen_random_uuid(),
  upsert.id,
  1,
  case upsert.template_key
    when 'registration_received' then 'Eingang bestätigt - {{eventName}}'
    when 'preselection' then 'Vorauswahl - {{eventName}}'
    when 'accepted_open_payment' then 'Nennung angenommen - Zahlung offen'
    when 'accepted_paid_completed' then 'Nennung abgeschlossen - {{eventName}}'
    when 'rejected' then 'Absage - {{eventName}}'
    when 'waitlist' then 'Warteliste - {{eventName}}'
    when 'payment_reminder' then 'Zahlungserinnerung - {{eventName}}'
    else upsert.template_key
  end,
  case upsert.template_key
    when 'registration_received' then 'Hallo {{driverName}}, wir haben deine Anmeldung für {{eventName}} erhalten.'
    when 'preselection' then 'Hallo {{driverName}}, deine Nennung ist aktuell in der Vorauswahl für {{eventName}}.'
    when 'accepted_open_payment' then 'Hallo {{driverName}}, deine Nennung wurde angenommen. Bitte bezahle {{amountOpenCents}} Cent.'
    when 'accepted_paid_completed' then 'Hallo {{driverName}}, deine Zahlung ist bestätigt. Deine Nennung ist abgeschlossen.'
    when 'rejected' then 'Hallo {{driverName}}, deine Nennung konnte leider nicht angenommen werden.'
    when 'waitlist' then 'Hallo {{driverName}}, deine Nennung befindet sich aktuell auf der Warteliste.'
    when 'payment_reminder' then 'Hallo {{driverName}}, bitte begleiche die offene Zahlung für {{eventName}}.'
    else 'Template {{templateKey}}'
  end,
  'system'
from upsert
where not exists (
  select 1
  from "email_template_version" v
  where v."template_id" = upsert.id
    and v."version" = 1
);
