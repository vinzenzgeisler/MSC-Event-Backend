with upsert as (
  insert into "email_template" ("id", "template_key", "description", "is_active")
  values
    (gen_random_uuid(), 'newsletter', 'Newsletter', true),
    (gen_random_uuid(), 'event_update', 'Event Update', true),
    (gen_random_uuid(), 'free_form', 'Freies Mailing', true)
  on conflict ("template_key") do update
    set "description" = excluded."description",
        "is_active" = true,
        "updated_at" = now()
  returning "id", "template_key"
)
insert into "email_template_version" (
  "id",
  "template_id",
  "version",
  "subject_template",
  "body_template",
  "body_text_template",
  "body_html_template",
  "status",
  "created_by",
  "updated_by",
  "updated_at"
)
select
  gen_random_uuid(),
  upsert.id,
  1,
  case upsert.template_key
    when 'newsletter' then 'Newsletter - {{eventName}}'
    when 'event_update' then 'Update zu {{eventName}}'
    when 'free_form' then 'Mitteilung - {{eventName}}'
    else upsert.template_key
  end,
  case upsert.template_key
    when 'newsletter' then 'Hallo {{driverName}},\n\nhier sind die neuesten Informationen zu {{eventName}}.'
    when 'event_update' then 'Hallo {{driverName}},\n\nes gibt ein neues Update zu {{eventName}}.'
    when 'free_form' then 'Hallo,\n\n{{eventName}}'
    else 'Template {{eventName}}'
  end,
  case upsert.template_key
    when 'newsletter' then 'Hallo {{driverName}},\n\nhier sind die neuesten Informationen zu {{eventName}}.'
    when 'event_update' then 'Hallo {{driverName}},\n\nes gibt ein neues Update zu {{eventName}}.'
    when 'free_form' then 'Hallo,\n\n{{eventName}}'
    else 'Template {{eventName}}'
  end,
  null,
  'published',
  'system',
  'system',
  now()
from upsert
where not exists (
  select 1
  from "email_template_version" v
  where v."template_id" = upsert.id
    and v."version" = 1
);
