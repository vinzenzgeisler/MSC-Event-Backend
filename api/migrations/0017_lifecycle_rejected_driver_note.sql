with lifecycle_template as (
  select "id"
  from "email_template"
  where "template_key" = 'rejected'
  limit 1
),
latest_version as (
  select
    lt.id as template_id,
    coalesce(max(tv."version"), 0) as current_version
  from lifecycle_template lt
  left join "email_template_version" tv on tv."template_id" = lt.id
  group by lt.id
)
insert into "email_template_version" (
  "id",
  "template_id",
  "version",
  "subject_template",
  "body_template",
  "created_by"
)
select
  gen_random_uuid(),
  lv.template_id,
  lv.current_version + 1,
  'Absage - {{eventName}}',
  'Hallo {{driverName}}, deine Nennung konnte leider nicht angenommen werden.{{driverNoteBlock}}',
  'system'
from latest_version lv
where not exists (
  select 1
  from "email_template_version" tv
  where tv."template_id" = lv.template_id
    and tv."version" = lv.current_version + 1
);
