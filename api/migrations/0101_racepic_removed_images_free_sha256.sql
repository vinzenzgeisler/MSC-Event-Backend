-- Bug gefunden 2026-09-22 (Nutzer-Feedback: ein erneuter Upload derselben Datei nach dem
-- Entfernen eines Bildes wird faelschlich als Duplikat erkannt): removeImage() (publish.ts)
-- loescht die S3-Objekte und setzt visibility='REMOVED', laesst sha256 auf der Zeile aber
-- unveraendert stehen (Absicht: das Audit bleibt ohne Bilddaten erhalten, siehe
-- racepic-architecture.md Abschnitt G "Loeschung"). Der Dedup-Unique-Index reservierte den Hash
-- dadurch dauerhaft fuer das Event, auch nachdem das Bild vollstaendig entfernt wurde - ein
-- Re-Upload derselben Datei blieb fuer immer als Duplikat blockiert. Ein entferntes Bild muss den
-- Hash wieder freigeben (siehe passender App-seitiger Fix in ingestWorker.ts).

drop index if exists "racepic_image_event_sha256_unique";
create unique index if not exists "racepic_image_event_sha256_unique"
  on "racepic_image" ("event_id", "sha256")
  where "sha256" is not null and "processing_status" <> 'DUPLICATE' and "visibility" <> 'REMOVED';
