-- Bug gefunden 2026-09-23 (Nutzer-Feedback: Kandidat mit falscher Fahrzeugfarbe hoeher bewertet
-- als der farblich passende): rekognition.ts nimmt jetzt einen nach Flaechenanteil gewichteten
-- Mittelwert ueber alle von Rekognition gelieferten Instanzfarben statt der einzelnen, oft vom
-- Fahrer/Helm dominierten Rang-1-Farbe. Bereits gecachte Referenzfarben stammen noch aus dem
-- alten Verfahren. Anders als bei frueheren Cache-Resets (0104, 0107) hier bewusst NUR die Farbe
-- leeren, nicht die ganze Zeile: das teure Bedrock-Embedding ist von diesem Fix unberuehrt und
-- bleibt erhalten (vehicleReference.ts nutzt es weiter, berechnet nur die Farbe neu) - vermeidet
-- unnoetigen erneuten Bedrock-Kontingentverbrauch.

update "racepic_vehicle_reference" set "dominant_colors" = null;
