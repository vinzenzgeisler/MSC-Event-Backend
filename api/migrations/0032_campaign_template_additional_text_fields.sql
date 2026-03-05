with target_templates as (
  select
    t.id as template_id,
    t.template_key,
    coalesce(max(v.version), 0) as current_version
  from email_template t
  left join email_template_version v on v.template_id = t.id
  where t.template_key in ('newsletter', 'event_update', 'free_form')
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
    when 'newsletter' then 'Newsletter - {{eventName}}'
    when 'event_update' then 'Update zu {{eventName}}'
    when 'free_form' then 'Mitteilung vom Orga-Team - {{eventName}}'
    else tt.template_key
  end,
  case tt.template_key
    when 'newsletter' then
      'Hallo {{driverName}},' || E'\n\n' ||
      '{{introText}}' || E'\n\n' ||
      '{{detailsText}}' || E'\n\n' ||
      '{{closingText}}'
    when 'event_update' then
      'Hallo {{driverName}},' || E'\n\n' ||
      '{{introText}}' || E'\n\n' ||
      '{{detailsText}}' || E'\n\n' ||
      '{{closingText}}'
    when 'free_form' then
      'Hallo {{driverName}},' || E'\n\n' ||
      '{{introText}}' || E'\n\n' ||
      '{{detailsText}}' || E'\n\n' ||
      '{{closingText}}'
    else 'Mitteilung zu {{eventName}}'
  end,
  case tt.template_key
    when 'newsletter' then
      'Hallo {{driverName}},' || E'\n\n' ||
      '{{introText}}' || E'\n\n' ||
      '{{detailsText}}' || E'\n\n' ||
      '{{closingText}}'
    when 'event_update' then
      'Hallo {{driverName}},' || E'\n\n' ||
      '{{introText}}' || E'\n\n' ||
      '{{detailsText}}' || E'\n\n' ||
      '{{closingText}}'
    when 'free_form' then
      'Hallo {{driverName}},' || E'\n\n' ||
      '{{introText}}' || E'\n\n' ||
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
