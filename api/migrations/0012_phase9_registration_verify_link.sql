with registration_template as (
  select id
  from "email_template"
  where "template_key" = 'registration_received'
  limit 1
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
  registration_template.id,
  2,
  'Eingang bestätigt - {{eventName}}',
  E'Hallo {{driverName}},\n\nwir haben deine Anmeldung für {{eventName}} erhalten.\n\nBitte bestätige deine E-Mail über diesen Link:\n{{verificationUrl}}\n\nFalls der Link nicht klickbar ist, verwende bitte diesen Token:\n{{verificationToken}}',
  'system'
from registration_template
where not exists (
  select 1
  from "email_template_version" v
  where v."template_id" = registration_template.id
    and v."version" = 2
);
