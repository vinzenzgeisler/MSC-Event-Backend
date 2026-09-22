-- Einmaliger Daten-Wipe auf Nutzerwunsch (2026-09-22): alle RacePic-Bilder aller Events werden
-- entfernt (Pilotdaten vor dem eigentlichen Rollout). Loescht nur `racepic_image` - alle davon
-- abhaengigen Zeilen (racepic_image_variant, racepic_detection, racepic_text_detection,
-- racepic_match_candidate, racepic_assignment, racepic_assignment_event, racepic_processing_step,
-- racepic_ai_analysis) kaskadieren per FK automatisch mit weg. `racepic_upload`/
-- `racepic_upload_batch` bleiben bewusst stehen (reine Zaehl-/Accounting-Zeilen ohne Bilddaten,
-- kein S3-Bezug mehr nach Abschluss des Uploads). Die zugehoerigen S3-Objekte
-- (originals/derived/public/analysis/manifests) werden separat per S3-CLI geloescht, nicht hier.

do $$
declare
  deleted_count integer;
begin
  delete from "racepic_image";
  get diagnostics deleted_count = row_count;
  raise notice 'racepic_image rows deleted: %', deleted_count;
end $$;
