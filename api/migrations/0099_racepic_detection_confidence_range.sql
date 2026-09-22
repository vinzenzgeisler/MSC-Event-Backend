-- Bug gefunden beim ersten echten Analyze-Lauf gegen prod (2026-09-22): AWS Rekognition liefert
-- `Confidence` im Bereich 0-100 (Prozent), nicht 0-1. `racepic_detection.confidence` und
-- `racepic_text_detection.confidence` waren aber als numeric(5,4) angelegt (max. 9.9999) -
-- praktisch jeder Rekognition-Confidence-Wert (typischerweise 50-100) ueberschreitet das und
-- fuehrte zu Postgres-Fehler 22003 (numeric_value_out_of_range), was den kompletten
-- Analyze-Worker-Durchlauf fuer das Bild abbrechen liess. `matchWorker.ts` erwartet beim Lesen
-- bereits explizit die rohe 0-100-Skala (teilt durch 100), die Spaltenpraezision war also einfach
-- zu klein - kein Aenderungsbedarf an der Anwendungslogik, nur an der Spaltendefinition.
-- numeric(7,4): bis zu 3 Vorkomma- + 4 Nachkommastellen, deckt 0.0000-999.9999 ab.

alter table "racepic_detection" alter column "confidence" type numeric(7, 4);
alter table "racepic_text_detection" alter column "confidence" type numeric(7, 4);
