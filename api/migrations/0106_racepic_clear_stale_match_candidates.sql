-- Bug gefunden 2026-09-23: matchWorker.ts fuegte bei jedem Lauf neue racepic_match_candidate-
-- Zeilen ein, ohne vorherige fuer dieselbe Detection zu loeschen. Bei mehreren Laeufen (Re-Match,
-- wiederholtes "Neu analysieren") sammelten sich so Kandidaten aus verschiedenen Config-/
-- Pipeline-Versionen an - die Review-Queue zeigte dadurch teils veraltete, nicht mehr gueltige
-- Scores als "aktuellen" Top-Kandidaten an. Reine, aus der aktuellen Zuordnung ableitbare
-- Cache-Tabelle (die eigentliche Historie ist racepic_assignment_event) - einfach leeren statt zu
-- migrieren, matchWorker.ts erzeugt sie beim naechsten Lauf pro Detection sauber neu.
--
-- Korrektur (2026-09-23, per CI-Fehler gefunden): TRUNCATE schlug fehl, weil
-- racepic_assignment.candidate_id per FK auf diese Tabelle verweist ("cannot truncate a table
-- referenced in a foreign key constraint"). TRUNCATE ... CASCADE waere KEIN Fix gewesen - das
-- haette racepic_assignment (echte, vom Menschen getroffene Entscheidungen inkl. Audit) gleich
-- mitgeleert, nicht nur den candidate_id-Verweis genullt. Ein normales DELETE respektiert dagegen
-- die hinterlegte ON DELETE SET NULL-Regel (siehe schema.ts) und loescht nur diese Cache-Tabelle.

delete from "racepic_match_candidate";
