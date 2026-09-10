-- Durable internal notifications and indexes used by operational investigations.

insert into email_template (id, template_key, description, is_active)
values
  (gen_random_uuid(), 'technical_inspection_decision', 'Technical inspection decision notification', true),
  (gen_random_uuid(), 'orga_registration_received', 'Internal notification for a new registration', true)
on conflict (template_key) do update
set description = excluded.description,
    is_active = true;

with templates as (
  select id, template_key
  from email_template
  where template_key in ('technical_inspection_decision', 'orga_registration_received')
)
insert into email_template_version (
  id, template_id, version, subject_template, body_template,
  body_text_template, body_html_template, status, created_by, updated_by, updated_at
)
select
  gen_random_uuid(),
  templates.id,
  1,
  case templates.template_key
    when 'technical_inspection_decision' then '[Technische Abnahme] Status aktualisiert'
    else '[Nennungstool] Neue Nennung eingegangen'
  end,
  'Systembenachrichtigung',
  'Systembenachrichtigung',
  null,
  'published',
  'system',
  'system',
  now()
from templates
where not exists (
  select 1 from email_template_version version
  where version.template_id = templates.id and version.version = 1
);

create index if not exists audit_log_event_created_idx
  on audit_log (event_id, created_at desc);

create index if not exists audit_log_entity_created_idx
  on audit_log (entity_type, entity_id, created_at desc);

create index if not exists audit_log_action_created_idx
  on audit_log (action, created_at desc);

create index if not exists email_delivery_ses_message_idx
  on email_delivery (ses_message_id)
  where ses_message_id is not null;
