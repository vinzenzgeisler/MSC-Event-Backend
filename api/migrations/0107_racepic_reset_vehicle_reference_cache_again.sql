-- Nutzerfrage 2026-09-23 ("aber ich dachte bereits gecacht heißt, dass sie noch im alten
-- Verfahren gecached sind?") - zu Recht: Migration 0104 leerte den Cache zusammen mit dem
-- Farbextraktions-Fix (~08:38 Uhr), der zweite Fix (Referenzfoto vor Rekognition/Bedrock auf
-- sichere Groesse/Format normalisieren) ging wegen der kaputten TRUNCATE-Migration 0106 erst
-- ca. 09:57 Uhr wirklich live. Alles, was in diesem Zwischenfenster automatisch neu berechnet
-- wurde (z. B. durch "Neu analysieren"), hatte die bessere Farbextraktion, aber noch nicht die
-- Normalisierung - bei zu grossen/falsch formatierten Referenzfotos fiel die Rekognition-
-- Farberkennung dann trotzdem auf die alte, grobe Ganzbild-Mittelung zurueck und wurde als
-- "gueltig" gecacht. Einmalig erneut leeren, damit ab jetzt alle Fahrzeuge einheitlich unter dem
-- vollstaendigen, aktuellen Stand neu berechnet werden - reine Cache-Tabelle, keine FK-Referenzen
-- von anderen Tabellen darauf (anders als racepic_match_candidate in 0106).

delete from "racepic_vehicle_reference";
