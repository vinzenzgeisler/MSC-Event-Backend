with upsert as (
  insert into email_template (id, template_key, description, is_active)
  values (gen_random_uuid(), 'email_confirmation_reminder', 'Erinnerung: E-Mail-Bestaetigung', true)
  on conflict (template_key) do update
    set description = excluded.description,
        is_active = excluded.is_active,
        updated_at = now()
  returning id, template_key
),
target as (
  select
    upsert.id as template_id,
    coalesce(max(v.version), 0) as current_version
  from upsert
  left join email_template_version v on v.template_id = upsert.id
  group by upsert.id
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
  target.template_id,
  target.current_version + 1,
  'Erinnerung: E-Mail bestaetigen - {{eventName}}',
  $$Hallo {{driverName}},

deine Nennung fuer {{eventName}} ist noch nicht bestaetigt.
Bitte bestaetige jetzt deine E-Mail-Adresse ueber den Bestaetigungslink:
{{verificationUrl}}

Ohne Bestaetigung koennen wir deine Nennung nicht abschliessend bearbeiten.$$,
  $$Hallo {{driverName}},

deine Nennung fuer {{eventName}} ist noch nicht bestaetigt.
Bitte bestaetige jetzt deine E-Mail-Adresse ueber den Bestaetigungslink:
{{verificationUrl}}

Ohne Bestaetigung koennen wir deine Nennung nicht abschliessend bearbeiten.$$,
  null,
  'published',
  'system',
  'system',
  now()
from target
where not exists (
  select 1
  from email_template_version existing
  where existing.template_id = target.template_id
);
