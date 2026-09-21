-- RacePic Paket 3: sha256 ist beim Upload-Abschluss (racepic_image wird hier angelegt) noch nicht
-- bekannt - der Ingest-Worker (Paket 4) laedt das Objekt herunter, prueft die Magic Bytes und
-- berechnet den Hash erst danach. Siehe api/src/racepic/uploads.ts.

alter table "racepic_image" alter column "sha256" drop not null;

drop index if exists "racepic_image_event_sha256_unique";
create unique index if not exists "racepic_image_event_sha256_unique"
  on "racepic_image" ("event_id", "sha256")
  where "sha256" is not null and "processing_status" <> 'DUPLICATE';
