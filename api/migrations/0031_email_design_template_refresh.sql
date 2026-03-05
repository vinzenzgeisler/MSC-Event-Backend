with target_templates as (
  select
    t.id as template_id,
    t.template_key,
    coalesce(max(v.version), 0) as current_version
  from email_template t
  left join email_template_version v on v.template_id = t.id
  where t.template_key in (
    'registration_received',
    'accepted_open_payment',
    'payment_reminder',
    'rejected',
    'newsletter',
    'event_update',
    'free_form'
  )
  group by t.id, t.template_key
)
insert into email_template_version (
  id,
  template_id,
  version,
  subject_template,
  body_template,
  body_text_template,
  body_html_template,
  status,
  created_by,
  updated_by,
  updated_at
)
select
  gen_random_uuid(),
  tt.template_id,
  tt.current_version + 1,
  case tt.template_key
    when 'registration_received' then 'Anmeldung eingegangen - {{eventName}}'
    when 'accepted_open_payment' then 'Zulassung bestaetigt - {{eventName}}'
    when 'payment_reminder' then 'Zahlungserinnerung - {{eventName}}'
    when 'rejected' then 'Status deiner Nennung - {{eventName}}'
    when 'newsletter' then 'Newsletter - {{eventName}}'
    when 'event_update' then 'Update zu {{eventName}}'
    when 'free_form' then 'Mitteilung vom Orga-Team - {{eventName}}'
    else tt.template_key
  end,
  case tt.template_key
    when 'registration_received' then
      'Hallo {{driverName}},' || E'\n\n' ||
      'deine Anmeldung fuer {{eventName}} ist eingegangen.' || E'\n' ||
      'Bitte bestaetige jetzt deine E-Mail-Adresse.' || E'\n\n' ||
      'Danach pruefen wir deine Nennung und informieren dich ueber den naechsten Schritt.'
    when 'accepted_open_payment' then
      'Hallo {{driverName}},' || E'\n\n' ||
      'deine Nennung wurde zugelassen.' || E'\n' ||
      'Klasse: {{className}}, Startnummer: {{startNumber}}.' || E'\n' ||
      'Offener Betrag: {{amountOpen}}.' || E'\n\n' ||
      'Zahlungsdetails findest du in deinem Teilnehmerbereich / in den Eventinfos.'
    when 'payment_reminder' then
      'Hallo {{driverName}},' || E'\n\n' ||
      'fuer deine Nennung ist noch ein Betrag offen: {{amountOpen}}.' || E'\n' ||
      'Bitte ueberweise den Betrag fristgerecht.' || E'\n\n' ||
      'Danke fuer deine Unterstuetzung einer reibungslosen Organisation.'
    when 'rejected' then
      'Hallo {{driverName}},' || E'\n\n' ||
      'leider koennen wir deine Nennung aktuell nicht beruecksichtigen.' || E'\n' ||
      'Bei Rueckfragen melde dich bitte unter {{contactEmail}}.'
    when 'newsletter' then
      'Hallo {{driverName}},' || E'\n\n' ||
      'hier sind Neuigkeiten rund um {{eventName}}.'
    when 'event_update' then
      'Hallo {{driverName}},' || E'\n\n' ||
      'hier ist ein wichtiges organisatorisches Update zu {{eventName}}.'
    when 'free_form' then
      'Hallo,' || E'\n\n' ||
      'Mitteilung vom Orga-Team zu {{eventName}}.'
    else 'Mitteilung zu {{eventName}}'
  end,
  case tt.template_key
    when 'registration_received' then
      'Hallo {{driverName}},' || E'\n\n' ||
      'deine Anmeldung fuer {{eventName}} ist eingegangen.' || E'\n' ||
      'Bitte bestaetige jetzt deine E-Mail-Adresse.' || E'\n\n' ||
      'Danach pruefen wir deine Nennung und informieren dich ueber den naechsten Schritt.'
    when 'accepted_open_payment' then
      'Hallo {{driverName}},' || E'\n\n' ||
      'deine Nennung wurde zugelassen.' || E'\n' ||
      'Klasse: {{className}}, Startnummer: {{startNumber}}.' || E'\n' ||
      'Offener Betrag: {{amountOpen}}.' || E'\n\n' ||
      'Zahlungsdetails findest du in deinem Teilnehmerbereich / in den Eventinfos.'
    when 'payment_reminder' then
      'Hallo {{driverName}},' || E'\n\n' ||
      'fuer deine Nennung ist noch ein Betrag offen: {{amountOpen}}.' || E'\n' ||
      'Bitte ueberweise den Betrag fristgerecht.' || E'\n\n' ||
      'Danke fuer deine Unterstuetzung einer reibungslosen Organisation.'
    when 'rejected' then
      'Hallo {{driverName}},' || E'\n\n' ||
      'leider koennen wir deine Nennung aktuell nicht beruecksichtigen.' || E'\n' ||
      'Bei Rueckfragen melde dich bitte unter {{contactEmail}}.'
    when 'newsletter' then
      'Hallo {{driverName}},' || E'\n\n' ||
      'hier sind Neuigkeiten rund um {{eventName}}.'
    when 'event_update' then
      'Hallo {{driverName}},' || E'\n\n' ||
      'hier ist ein wichtiges organisatorisches Update zu {{eventName}}.'
    when 'free_form' then
      'Hallo,' || E'\n\n' ||
      'Mitteilung vom Orga-Team zu {{eventName}}.'
    else 'Mitteilung zu {{eventName}}'
  end,
  null,
  'published',
  'system',
  'system',
  now()
from target_templates tt;
