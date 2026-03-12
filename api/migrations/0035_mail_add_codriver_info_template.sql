insert into email_template (id, template_key, description, is_active)
values
  (gen_random_uuid(), 'codriver_info', 'Beifahrer-Information', true)
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
  where t.template_key = 'codriver_info'
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
  'Info: Du wurdest als Beifahrer eingetragen - {{eventName}}',
  'Hallo {{codriverName}},' || E'\n\n' ||
  '{{driverName}} hat dich als Beifahrer für {{eventName}} eingetragen.' || E'\n' ||
  'Klasse: {{className}}' || E'\n' ||
  'Startnummer: {{startNumber}}' || E'\n\n' ||
  'Dies ist nur eine Information. Du musst diese E-Mail nicht bestätigen.' || E'\n' ||
  'Bei Rückfragen melde dich bitte unter {{contactEmail}}.',
  'Hallo {{codriverName}},' || E'\n\n' ||
  '{{driverName}} hat dich als Beifahrer für {{eventName}} eingetragen.' || E'\n' ||
  'Klasse: {{className}}' || E'\n' ||
  'Startnummer: {{startNumber}}' || E'\n\n' ||
  'Dies ist nur eine Information. Du musst diese E-Mail nicht bestätigen.' || E'\n' ||
  'Bei Rückfragen melde dich bitte unter {{contactEmail}}.',
  '<p>Hallo {{codriverName}},</p><p>{{driverName}} hat dich als Beifahrer für {{eventName}} eingetragen.</p><p>Klasse: {{className}}<br />Startnummer: {{startNumber}}</p><p>Dies ist nur eine Information. Du musst diese E-Mail nicht bestätigen.</p><p>Bei Rückfragen: {{contactEmail}}</p>',
  'published',
  'system',
  'system',
  now()
from target_templates tt;
