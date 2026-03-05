insert into email_template (id, template_key, description, is_active)
values
  (gen_random_uuid(), 'payment_reminder_followup', 'Erneute Zahlungsaufforderung', true),
  (gen_random_uuid(), 'email_confirmation', 'E-Mail-Bestaetigung', true)
on conflict (template_key) do update
set
  description = excluded.description,
  is_active = true;

with target_templates as (
  select
    t.id as template_id,
    t.template_key,
    coalesce(max(v.version), 0) as current_version
  from email_template t
  left join email_template_version v on v.template_id = t.id
  where t.template_key in ('payment_reminder_followup', 'email_confirmation')
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
    when 'payment_reminder_followup' then 'Erneute Zahlungsaufforderung - {{eventName}}'
    when 'email_confirmation' then 'Bitte E-Mail bestaetigen - {{eventName}}'
    else tt.template_key
  end,
  case tt.template_key
    when 'payment_reminder_followup' then
      'Hallo {{driverName}},' || E'\n\n' ||
      '{{introText}}' || E'\n\n' ||
      'Aktuell ist fuer deine Nennung noch folgender Betrag offen: {{amountOpen}}.' || E'\n' ||
      'Bitte ueberweise den Betrag bis spaetestens {{paymentDeadline}}.' || E'\n\n' ||
      '{{detailsText}}' || E'\n\n' ||
      '{{closingText}}'
    when 'email_confirmation' then
      'Hallo {{driverName}},' || E'\n\n' ||
      '{{introText}}' || E'\n\n' ||
      'Bitte bestaetige deine E-Mail-Adresse ueber folgenden Link: {{verificationUrl}}' || E'\n\n' ||
      '{{detailsText}}' || E'\n\n' ||
      '{{closingText}}'
    else 'Mitteilung zu {{eventName}}'
  end,
  case tt.template_key
    when 'payment_reminder_followup' then
      'Hallo {{driverName}},' || E'\n\n' ||
      '{{introText}}' || E'\n\n' ||
      'Aktuell ist fuer deine Nennung noch folgender Betrag offen: {{amountOpen}}.' || E'\n' ||
      'Bitte ueberweise den Betrag bis spaetestens {{paymentDeadline}}.' || E'\n\n' ||
      '{{detailsText}}' || E'\n\n' ||
      '{{closingText}}'
    when 'email_confirmation' then
      'Hallo {{driverName}},' || E'\n\n' ||
      '{{introText}}' || E'\n\n' ||
      'Bitte bestaetige deine E-Mail-Adresse ueber folgenden Link: {{verificationUrl}}' || E'\n\n' ||
      '{{detailsText}}' || E'\n\n' ||
      '{{closingText}}'
    else 'Mitteilung zu {{eventName}}'
  end,
  '<p>Hallo {{driverName}},</p><p>{{introText}}</p><p>{{detailsText}}</p><p>{{closingText}}</p>',
  'published',
  'system',
  'system',
  now()
from target_templates tt;
