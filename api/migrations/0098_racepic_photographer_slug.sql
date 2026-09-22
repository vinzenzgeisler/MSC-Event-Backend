-- RacePic Paket 12: oeffentliches Fotografenprofil (/racepic/fotografen/:slug in msc-website),
-- siehe docs/memory-bank/racepic-architecture.md Abschnitt H ("GET /m/photographers/{slug}.json")
-- und J (MVP-Scope). Nullable, weil bereits existierende (eingeladene) Fotografen noch keinen
-- Slug haben - `repository.ts` vergibt ihn ab jetzt bei der Einladung; ein einmaliger Backfill
-- fuer Bestandsdaten ist hier nicht noetig, da in keiner Umgebung dieser Sandbox bereits
-- RacePic-Fotografen existieren (siehe racepic-progress.md: "nicht deployed").

alter table "racepic_photographer" add column if not exists "slug" text;

create unique index if not exists "racepic_photographer_slug_unique"
  on "racepic_photographer" ("slug")
  where "slug" is not null;
