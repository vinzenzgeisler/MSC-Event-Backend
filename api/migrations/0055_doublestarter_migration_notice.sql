with template_upsert as (
  insert into "email_template" ("id", "template_key", "description", "is_active")
  values (
    gen_random_uuid(),
    'doublestarter_migration_notice',
    'Information zur Zusammenführung getrennter Doppelstarter-Nennungen',
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
  'Information zu deinen Nennungen - {{eventName}}',
  'Hallo {{driverName}},

uns ist aufgefallen, dass du dich für {{eventName}} mit zwei unterschiedlichen E-Mail-Adressen angemeldet hast.

Die in dieser E-Mail aufgeführten Nennungen führen wir technisch zu einem Doppelstarter-Datensatz zusammen. Deine Fahrzeuge, Klassen und Startnummern bleiben unverändert. Als Hauptadresse verwenden wir die E-Mail-Adresse deiner zuerst eingegangenen Anmeldung.

Du musst nichts weiter tun. Falls die beiden Nennungen wider Erwarten nicht zu derselben Person gehören, antworte bitte kurzfristig auf diese E-Mail.',
  'Hallo {{driverName}},

uns ist aufgefallen, dass du dich für {{eventName}} mit zwei unterschiedlichen E-Mail-Adressen angemeldet hast.

Die in dieser E-Mail aufgeführten Nennungen führen wir technisch zu einem Doppelstarter-Datensatz zusammen. Deine Fahrzeuge, Klassen und Startnummern bleiben unverändert. Als Hauptadresse verwenden wir die E-Mail-Adresse deiner zuerst eingegangenen Anmeldung.

Du musst nichts weiter tun. Falls die beiden Nennungen wider Erwarten nicht zu derselben Person gehören, antworte bitte kurzfristig auf diese E-Mail.',
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
