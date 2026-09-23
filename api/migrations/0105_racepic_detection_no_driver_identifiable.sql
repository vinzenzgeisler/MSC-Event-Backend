-- Nutzerwunsch 2026-09-23: manche Fahrzeuge lassen sich auch von Menschen nicht identifizieren.
-- Solche Detections sollen sich aus der Zuordnungs-Queue "wegklicken" lassen, statt fuer immer
-- als offener Fall liegen zu bleiben - das Bild bleibt trotzdem regulaer oeffentlich/downloadbar
-- (visibility/processingStatus bleiben unberuehrt, siehe download.ts: der Download-Endpunkt
-- braucht ohnehin keine Zuordnung).

alter table "racepic_detection" add column "reviewed_no_match" boolean not null default false;
