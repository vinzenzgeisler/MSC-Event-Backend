-- Dedicated system template for atomic class/start-number assignment notifications.

insert into email_template (id, template_key, description, is_active)
values (gen_random_uuid(), 'entry_assignment_changed', 'Neue Klasseneinteilung und Startnummer', true)
on conflict (template_key) do update
set description = excluded.description, is_active = true;

with template as (
  select id as template_id
  from email_template
  where template_key = 'entry_assignment_changed'
)
insert into email_template_version (
  id, template_id, version,
  subject_template, body_template, body_text_template, body_html_template,
  status, created_by, updated_by, updated_at
)
select
  gen_random_uuid(),
  template.template_id,
  1,
  'Neue Klasseneinteilung und Startnummer – {{eventName}}',
  'Hallo {{driverName}},' || E'\n\n' ||
    'Ihre Nennung für {{eventName}} wurde neu zugeordnet.' || E'\n\n' ||
    'Neue Klasse: {{className}}' || E'\n' ||
    'Neue Startnummer: {{startNumber}}',
  'Hallo {{driverName}},' || E'\n\n' ||
    'Ihre Nennung für {{eventName}} wurde neu zugeordnet.' || E'\n\n' ||
    'Neue Klasse: {{className}}' || E'\n' ||
    'Neue Startnummer: {{startNumber}}',
  '<p>Hallo {{driverName}},</p>' ||
    '<p>Ihre Nennung für <strong>{{eventName}}</strong> wurde neu zugeordnet.</p>' ||
    '<p><strong>Neue Klasse:</strong> {{className}}<br>' ||
    '<strong>Neue Startnummer:</strong> {{startNumber}}</p>',
  'published',
  'system',
  'system',
  now()
from template
on conflict (template_id, version) do nothing;
