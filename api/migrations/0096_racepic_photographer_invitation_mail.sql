-- RacePic Paket 2: Systemmail fuer die Fotografen-Einladung. Gleiches Muster wie
-- 0055_doublestarter_migration_notice.sql (System-Transaktionsmail ohne Admin-Compose-UI).

with template_upsert as (
  insert into "email_template" ("id", "template_key", "description", "is_active")
  values (
    gen_random_uuid(),
    'racepic_photographer_invitation',
    'Einladung eines Fotografen zu RacePic (Claim-Link)',
    true
  )
  on conflict ("template_key") do update
    set "description" = excluded."description",
        "is_active" = true,
        "updated_at" = now()
  returning "id"
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
  template_upsert.id,
  1,
  'Einladung zu RacePic - {{eventNames}}',
  'Hallo {{photographerName}},

der MSC Oberlausitzer Dreilaendereck e.V. laedt dich ein, deine Fotos von {{eventNames}} auf RacePic zu veroeffentlichen.

Um dein Fotografenprofil zu aktivieren, oeffne bitte den folgenden Link und bestaetige deine E-Mail-Adresse:

{{invitationUrl}}

Der Link ist einmalig gueltig und dient ausschliesslich der Aktivierung deines Profils. Nach der Aktivierung meldest du dich kuenftig direkt unter racepic/studio an.

Falls du diese Einladung nicht erwartet hast, kannst du diese E-Mail ignorieren.',
  'Hallo {{photographerName}},

der MSC Oberlausitzer Dreilaendereck e.V. laedt dich ein, deine Fotos von {{eventNames}} auf RacePic zu veroeffentlichen.

Um dein Fotografenprofil zu aktivieren, oeffne bitte den folgenden Link und bestaetige deine E-Mail-Adresse:

{{invitationUrl}}

Der Link ist einmalig gueltig und dient ausschliesslich der Aktivierung deines Profils. Nach der Aktivierung meldest du dich kuenftig direkt unter racepic/studio an.

Falls du diese Einladung nicht erwartet hast, kannst du diese E-Mail ignorieren.',
  null,
  'published',
  'system',
  'system',
  now()
from template_upsert
where not exists (
  select 1
  from "email_template_version" version
  where version."template_id" = template_upsert.id
    and version."version" = 1
);
