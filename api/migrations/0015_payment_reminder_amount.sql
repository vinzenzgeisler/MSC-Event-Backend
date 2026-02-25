with reminder_template as (
  select "id"
  from "email_template"
  where "template_key" = 'payment_reminder'
  limit 1
),
latest_version as (
  select
    rt.id as template_id,
    coalesce(max(tv."version"), 0) as current_version
  from reminder_template rt
  left join "email_template_version" tv on tv."template_id" = rt.id
  group by rt.id
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
  'Zahlungserinnerung - {{eventName}}',
  'Hallo {{driverName}}, bitte begleiche die offene Zahlung für {{eventName}}. Offener Betrag: {{amountOpenEur}} EUR ({{amountOpenCents}} Cent).',
  'system'
from latest_version lv
where not exists (
  select 1
  from "email_template_version" tv
  where tv."template_id" = lv.template_id
    and tv."version" = lv.current_version + 1
);
