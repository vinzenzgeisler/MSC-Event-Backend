-- Refresh waiver_signed copy for driver delivery after digital signature.

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
  'Ihr unterschriebener Haftverzicht - {{eventName}}',
  'Hallo {{driverName}},' || E'\n\n' ||
  'der Haftverzicht fuer {{eventName}} wurde erfolgreich digital unterschrieben.' || E'\n\n' ||
  'Unterzeichner: {{signerName}} ({{signerRole}})' || E'\n' ||
  'Veranstaltung: {{eventDates}}' || E'\n' ||
  'Unterschrieben am: {{signedAt}}' || E'\n\n' ||
  'Das unterschriebene PDF ist dieser E-Mail angehaengt.' || E'\n\n' ||
  'Mit freundlichen Gruessen' || E'\n' ||
  'MSC Oberlausitzer Dreilaendereck e.V.',
  'Hallo {{driverName}},' || E'\n\n' ||
  'der Haftverzicht fuer {{eventName}} wurde erfolgreich digital unterschrieben.' || E'\n\n' ||
  'Unterzeichner: {{signerName}} ({{signerRole}})' || E'\n' ||
  'Veranstaltung: {{eventDates}}' || E'\n' ||
  'Unterschrieben am: {{signedAt}}' || E'\n\n' ||
  'Das unterschriebene PDF ist dieser E-Mail angehaengt.' || E'\n\n' ||
  'Mit freundlichen Gruessen' || E'\n' ||
  'MSC Oberlausitzer Dreilaendereck e.V.',
  '<p>Hallo {{driverName}},</p>' ||
  '<p>der Haftverzicht fuer <strong>{{eventName}}</strong> wurde erfolgreich digital unterschrieben.</p>' ||
  '<p>Unterzeichner: {{signerName}} ({{signerRole}})<br />' ||
  'Veranstaltung: {{eventDates}}<br />' ||
  'Unterschrieben am: {{signedAt}}</p>' ||
  '<p>Das unterschriebene PDF ist dieser E-Mail angehaengt.</p>' ||
  '<p>Mit freundlichen Gruessen<br />MSC Oberlausitzer Dreilaendereck e.V.</p>',
  'published',
  'system',
  'system',
  now()
from tt
where not exists (
  select 1
  from email_template_version v
  where v.template_id = tt.template_id
    and v.subject_template = 'Ihr unterschriebener Haftverzicht - {{eventName}}'
);