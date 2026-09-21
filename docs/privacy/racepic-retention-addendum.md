# RacePic – Ergänzung zum Speicher- und Löschkonzept

Stand: 2026-09-21
Ergänzt `docs/privacy/retention-policy.md` um die `racepic_*`-Tabellen und den Media-Bucket. Gleiche Grundsätze (Datenminimierung, Zweckbindung, Nachweisbarkeit) gelten unverändert.

## Fristen je Datenkategorie (RacePic)

| Datenkategorie / Tabellen | Frist | Begründung | Lösch-/Anonymisierungsmodus |
|---|---|---|---|
| Rohupload (`incoming/` im Media-Bucket) | 7 Tage | Nur Verarbeitungspuffer | Hard delete (S3 Lifecycle) |
| Unvollständige Multipart-Uploads | 3 Tage | Kein Nutzen nach Abbruch | `AbortIncompleteMultipartUpload` (S3 Lifecycle) |
| `racepic_upload`, `racepic_upload_batch` (Status FAILED/EXPIRED) | 30 Tage | Nur Prozesssteuerung | Hard delete |
| Veröffentlichte Bilder (`racepic_image`, Originale/Varianten) | Bis Löschung durch Fotograf oder Widerspruch eines Teilnehmers; sonst unbegrenzt (redaktioneller Wert der Veranstaltungsdokumentation) | Zentraler Zweck von RacePic | Auf Anfrage: Objekte in S3 löschen, CloudFront invalidieren, `visibility=REMOVED`, Manifeste neu erzeugen |
| KI-Rohantworten (`analysis/*.json`, `racepic_ai_analysis`) | Solange das zugehörige Bild existiert | Nachvollziehbarkeit der Zuordnung (Abschnitt I9 des Architekturplans) | Löschung zusammen mit dem Bild |
| `racepic_match_candidate` (nicht gewählte Kandidaten) | 2 Jahre nach Erzeugung, danach nur Aggregatstatistik für die Matching-Qualität | Kalibrierung der Schwellenwerte, kein Dauerbedarf an Einzeldaten | Hard delete der Detaildaten, Aggregatmetriken bleiben |
| `racepic_assignment_event` (Audit) | 24 Monate, analog `audit_log` | Nachvollziehbarkeit von Korrekturen | Hard delete nach Frist |
| Referenz-Embeddings (`racepic_vehicle_reference`) | Bis 1 Jahr nach Eventende (gekoppelt an `vehicle.image_s3_key`) | Nur für aktives Matching benötigt | Hard delete, wenn `vehicle.image_s3_key` durch die bestehende Retention genullt wird (siehe unten) |
| `racepic_photographer` bei Profillöschung | Sofort auf Anfrage, Bilder bleiben (sofern nicht mit gelöscht) oder werden mit entfernt (Wahl des Fotografen) | Fotografenprofil ist eigenständig löschbar | `deleted_at` setzen, `cognito_sub` entkoppeln, Cognito-User löschen |
| `racepic_invitation` (verbraucht oder abgelaufen) | 90 Tage | Kein Dauerbedarf nach Aktivierung/Ablauf | Hard delete |

## Bestehende Lücke wird geschlossen: Fahrzeugbild-Löschung

`privacyRetentionWorker.ts` setzt `vehicle.image_s3_key = null`, löscht aber **nicht** das zugehörige S3-Objekt im Assets-Bucket (dokumentierte Lücke, siehe `docs/memory-bank/racepic-architecture.md`, Ist-Analyse). Im Zuge von RacePic (Paket 9) wird der Worker um eine S3-`DeleteObject`-Berechtigung und den entsprechenden Aufruf ergänzt, bevor der DB-Verweis genullt wird. Gleichzeitig wird das zugehörige `racepic_vehicle_reference` (Embedding, Referenzfarbe) gelöscht.

## Trigger „Manifeste neu erzeugen“

Jede Änderung, die die öffentliche Anzeige betrifft (Namensanonymisierung durch die bestehende Retention, Bild-Widerspruch, Profillöschung eines Fotografen), löst einen Re-Publish der betroffenen Event-Manifeste sowie eine CloudFront-Invalidation der betroffenen `/m/*`- und ggf. `/p/*`-Pfade aus. Technisch: der bestehende `privacyRetentionWorker` und die neuen RacePic-Admin-Aktionen (Bild verbergen, Fotograf sperren) rufen denselben Publish-Worker (Abschnitt B/F des Architekturplans) auf.

## Offener Punkt: Namenssuche nach 365 Tagen

Siehe `docs/memory-bank/racepic-progress.md` (Abschnitt „Offene Punkte“) und Architekturplan, Abschnitt „Datenschutz“. Diese Tabelle geht vom heutigen Stand aus (Name verschwindet, Bildzuordnung über Startnummer/Klasse/Fahrzeug bleibt). Sollte der Vorstand/Datenschutzbeauftragte eine dauerhafte Namenssuche auf Basis einer gesonderten Einwilligung beschließen, ist diese Tabelle entsprechend anzupassen (Ausnahme von der Anonymisierung für Personen mit RacePic-spezifischer Einwilligung).
