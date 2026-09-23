-- Bug gefunden 2026-09-23: die Referenzfarbe (racepic_vehicle_reference.dominant_colors) wurde
-- bisher als 1x1-Mittel des GESAMTEN Referenzfotos berechnet (Hintergrund inklusive), nicht nur
-- des Fahrzeugs - ein komplett gelbes Auto konnte dadurch faelschlich als farblich aehnlich zu
-- einem weiss/rot/schwarzen Auto gelten, wenn beide Fotos aehnliche Hintergruende (Gras/Asphalt)
-- hatten. vehicleReference.ts nutzt jetzt Rekognitions praezise Instanz-Farbe (wie beim
-- analysierten Foto schon laenger). Reine Cache-Tabelle (racepic_vehicle_reference), wird bei
-- Bedarf automatisch neu berechnet (ensureVehicleReference) - einfach leeren statt zu migrieren.

truncate table "racepic_vehicle_reference";
