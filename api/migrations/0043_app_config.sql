create table if not exists "app_config" (
  "id" uuid primary key default gen_random_uuid(),
  "config_key" text not null,
  "payload" jsonb not null default '{}'::jsonb,
  "updated_at" timestamptz not null default now(),
  "updated_by" text
);

create unique index if not exists "app_config_key_unique"
  on "app_config" ("config_key");

insert into "app_config" ("config_key", "payload")
select
  'entry_confirmation_defaults',
  '{
    "organizerName": "MSC Oberlausitzer Dreiländereck e.V.",
    "organizerAddressLine": "Am Weiher 4 · 02791 Oderwitz",
    "websiteUrl": "https://www.msc-oberlausitzer-dreilaendereck.eu",
    "gateHeadline": "Bitte bei der Einfahrt in das Fahrerlager bereithalten.",
    "venueStreet": "Jägerwäldchen 2",
    "venueZip": "02763",
    "venueCity": "Bertsdorf-Hörnitz",
    "paddockInfo": "Das Fahrerlager ist am Veranstaltungstag ab 08:00 Uhr geöffnet. Für Anreisende aus der Ferne ist die Zufahrt bereits am Vortag ab 16:00 Uhr möglich.",
    "arrivalNotes": "GPS-Daten: 50.72738; 14.684114",
    "importantNotes": [
      "Bitte sichern Sie Ölablassschrauben und Ölfilter gemäß Reglement.",
      "Die Abreise aus dem Fahrerlager ist erst nach Ende der Veranstaltung möglich."
    ],
    "paymentRecipient": "MSC Oberlausitzer Dreiländereck e.V.",
    "paymentIban": "DE38 8505 0100 0232 0498 07",
    "paymentBic": "WELADED1GRL",
    "paymentBankName": "Sparkasse Oberlausitz Niederschlesien"
  }'::jsonb
where not exists (
  select 1
  from "app_config"
  where "config_key" = 'entry_confirmation_defaults'
);
