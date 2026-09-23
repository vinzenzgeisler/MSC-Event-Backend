-- Bug gefunden 2026-09-23: matchWorker.ts fuegte bei jedem Lauf neue racepic_match_candidate-
-- Zeilen ein, ohne vorherige fuer dieselbe Detection zu loeschen. Bei mehreren Laeufen (Re-Match,
-- wiederholtes "Neu analysieren") sammelten sich so Kandidaten aus verschiedenen Config-/
-- Pipeline-Versionen an - die Review-Queue zeigte dadurch teils veraltete, nicht mehr gueltige
-- Scores als "aktuellen" Top-Kandidaten an. Reine, aus der aktuellen Zuordnung ableitbare
-- Cache-Tabelle (die eigentliche Historie ist racepic_assignment_event) - einfach leeren statt zu
-- migrieren, matchWorker.ts erzeugt sie beim naechsten Lauf pro Detection sauber neu.

truncate table "racepic_match_candidate";
