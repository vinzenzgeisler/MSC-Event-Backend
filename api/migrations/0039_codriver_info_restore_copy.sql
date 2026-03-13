with target_template as (
  select
    t.id as template_id,
    coalesce(max(v.version), 0) as current_version
  from email_template t
  left join email_template_version v on v.template_id = t.id
  where t.template_key = 'codriver_info'
  group by t.id
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
  '{{className}}' || E'\n' ||
  'Startnummer: {{startNumber}}' || E'\n\n' ||
  'Dies ist nur eine Information. Du musst diese E-Mail nicht bestätigen.',
  'Hallo {{codriverName}},' || E'\n\n' ||
  '{{driverName}} hat dich als Beifahrer für {{eventName}} eingetragen.' || E'\n' ||
  '{{className}}' || E'\n' ||
  'Startnummer: {{startNumber}}' || E'\n\n' ||
  'Dies ist nur eine Information. Du musst diese E-Mail nicht bestätigen.',
  '<p>Hallo {{codriverName}},</p><p>{{driverName}} hat dich als Beifahrer für {{eventName}} eingetragen.</p><p>{{className}}<br />Startnummer: {{startNumber}}</p><p>Dies ist nur eine Information. Du musst diese E-Mail nicht bestätigen.</p>',
  'published',
  'system',
  'system',
  now()
from target_template tt;
