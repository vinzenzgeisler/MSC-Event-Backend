-- Address the signed-waiver mail to the actual recipient and keep the PDF attachment explicit.

with tt as (
  select t.id as template_id, coalesce(max(v.version), 0) as current_version
  from email_template t
  left join email_template_version v on v.template_id = t.id
  where t.template_key = 'waiver_signed'
  group by t.id
)
insert into email_template_version (
  id, template_id, version,
  subject_template, body_template, body_text_template, body_html_template,
  status, created_by, updated_by, updated_at
)
select
  gen_random_uuid(),
  tt.template_id,
  tt.current_version + 1,
  'Ihre unterschriebene Haftverzichtserklärung – {{eventName}}',
  'Hallo {{signerName}},' || E'\n\n' ||
  'Ihre Haftverzichtserklärung für {{eventName}} wurde erfolgreich digital unterschrieben.' || E'\n\n' ||
  'Rolle: {{signerRole}}' || E'\n' ||
  'Veranstaltung: {{eventDates}}' || E'\n' ||
  'Unterschrieben am: {{signedAt}}' || E'\n\n' ||
  'Das unterschriebene Dokument finden Sie als PDF im Anhang dieser E-Mail.' || E'\n\n' ||
  'Mit freundlichen Grüßen' || E'\n' ||
  'MSC Oberlausitzer Dreiländereck e.V.',
  'Hallo {{signerName}},' || E'\n\n' ||
  'Ihre Haftverzichtserklärung für {{eventName}} wurde erfolgreich digital unterschrieben.' || E'\n\n' ||
  'Rolle: {{signerRole}}' || E'\n' ||
  'Veranstaltung: {{eventDates}}' || E'\n' ||
  'Unterschrieben am: {{signedAt}}' || E'\n\n' ||
  'Das unterschriebene Dokument finden Sie als PDF im Anhang dieser E-Mail.' || E'\n\n' ||
  'Mit freundlichen Grüßen' || E'\n' ||
  'MSC Oberlausitzer Dreiländereck e.V.',
  '<p>Hallo {{signerName}},</p>' ||
  '<p>Ihre Haftverzichtserklärung für <strong>{{eventName}}</strong> wurde erfolgreich digital unterschrieben.</p>' ||
  '<p>Rolle: {{signerRole}}<br />' ||
  'Veranstaltung: {{eventDates}}<br />' ||
  'Unterschrieben am: {{signedAt}}</p>' ||
  '<p>Das unterschriebene Dokument finden Sie als PDF im Anhang dieser E-Mail.</p>' ||
  '<p>Mit freundlichen Grüßen<br />MSC Oberlausitzer Dreiländereck e.V.</p>',
  'published',
  'system',
  'system',
  now()
from tt
where not exists (
  select 1
  from email_template_version v
  where v.template_id = tt.template_id
    and v.subject_template = 'Ihre unterschriebene Haftverzichtserklärung – {{eventName}}'
);
