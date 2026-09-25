# RacePic – Betriebs-Runbook

Stand: 2026-09-25. Bezieht sich auf den aktuellen, noch nicht deployten Code-Stand,
**noch nicht deployed**. Ergänzt `docs/memory-bank/racepic-architecture.md` (Konzept) und
`docs/memory-bank/racepic-progress.md` (Umsetzungsstand) um konkrete Betriebs-Handgriffe.

## RacePic für ein Event aktivieren

1. Admin-Oberfläche im Nennungstool öffnen: `/admin/racepic`.
2. Event in der Tabelle aufklappen ("Konfigurieren"), Slug (lesbar, kleingeschrieben,
   Bindestriche), Titel, Upload-Fenster setzen. `Aktiviert` einschalten.
3. Fotograf:innen unten auf derselben Seite einladen (E-Mail, Anzeigename, Event-Zugriff
   auswählen) – sie erhalten einen Einladungslink zu `/racepic/studio/einladung/{token}` auf
   der Website.
4. Nach dem Upload/Ingest/Analyze/Match-Durchlauf: Review-Queue unter
   `/admin/racepic/review/{eventId}` abarbeiten.
5. Wenn genug Zuordnungen bestätigt sind: `Veröffentlicht` im Event-Formular einschalten und
   speichern – das löst sofort `regenerateManifestsForEvent` aus (Manifeste + CloudFront-
   Invalidation).

## Ein einzelnes Bild veröffentlichen/verbergen/entfernen

`PATCH /admin/racepic/images/{imageId}` mit `{"visibility": "PUBLISHED" | "HIDDEN" | "REMOVED"}`.
`HIDDEN` braucht nur `racepic.review`, `PUBLISHED`/`REMOVED` brauchen `racepic.manage`. Löst
automatisch eine Manifest-Regenerierung für das zugehörige Event aus.

## Widerspruch eines Teilnehmers gegen die RacePic-Zuordnung

`POST /admin/racepic/participants/{entryId}/hide` (braucht `racepic.manage`). Lehnt alle aktiven
Zuordnungen dieser Nennung ab (`REJECTED`), unterdrückt künftige Zuordnungen und stellt einen
Manifest-Refresh ein. Das Bild selbst bleibt unabhängig von weiteren Zuordnungen sichtbar und
herunterladbar.

## Matching neu laufen lassen

- **Ein Bild neu analysieren** (z. B. nach einem Rekognition-Fehler): `POST
  /admin/racepic/images/{imageId}/reanalyze`.
- **Ein ganzes Event neu zuordnen** (z. B. nach Anpassung der Matching-Config): `POST
  /admin/racepic/events/{eventId}/rematch`. Nutzt die bereits vorhandenen KI-Rohantworten
  (`analysis/{imageId}/*.json`), **kein** erneuter Rekognition-/Bedrock-Aufruf.
- Matching-Config ansehen/anlegen: `GET`/`POST /admin/racepic/matching-configs`. Eine neue
  Version deaktiviert die alte im selben Scope (Event-spezifisch oder global), alte Zeilen
  bleiben für die Nachvollziehbarkeit erhalten.

## Datenschutz-Anfrage (Auskunft/Löschung) zu einem Teilnehmer

1. Nennung im Nennungstool suchen (Startnummer/Name).
2. Für die Entfernung der Teilnehmerzuordnung: `POST
   /admin/racepic/participants/{entryId}/hide` (siehe oben).
3. Nur wenn ein konkretes Foto aus einem separaten rechtlichen oder redaktionellen Grund entfernt
   werden soll: `PATCH
   /admin/racepic/images/{imageId}` mit `visibility: REMOVED` – löscht S3-Objekte und
   `racepic_image_variant`-Zeilen, das Audit (`racepic_assignment_event`) bleibt ohne
   Bilddaten erhalten (Architekturplan Abschnitt G "Löschung").
4. Die reguläre Anonymisierung nach 365 Tagen (Name verschwindet, Startnummer/Klasse/Fahrzeug
   bleiben) läuft automatisch über den bestehenden `PrivacyRetentionWorker` (täglich) – siehe
   `docs/privacy/racepic-retention-addendum.md`.

## Fahrzeugbild-Löschung prüfen (Paket 9 – behobene Lücke)

Der `PrivacyRetentionWorker` löscht seit Paket 9 zusätzlich zum Nullen von
`vehicle.image_s3_key` auch die S3-Objekte im Assets-Bucket und die zugehörige
`racepic_vehicle_reference`-Zeile. Prüfen über CloudWatch Logs Insights
(`{prefix}/operational-errors`) oder den `privacy_retention_run`-Audit-Log-Eintrag
(`deletedRows.vehicle_image_s3_deleted`).

## Kostenüberwachung

- **Budget:** `{prefix}-racepic-monthly` (nur wenn `enableRacePic=true` und
  `ORGA_NOTIFICATION_RECIPIENTS` gesetzt ist), gefiltert auf Rekognition/Bedrock/CloudFront.
  Alarmiert per E-Mail bei 80 % des tatsächlichen und 100 % des prognostizierten Betrags.
  Höhe über `DEV_RACEPIC_MONTHLY_BUDGET_USD`/`PROD_RACEPIC_MONTHLY_BUDGET_USD` konfigurierbar.
- **Keine Cost Anomaly Detection** eingerichtet (bräuchte eine SNS-Themen-Abo-Bestätigung, in
  dieser Umgebung nicht einrichtbar/verifizierbar) – offener Punkt, siehe Progress-Datei.
- CloudWatch-Alarme auf den drei DLQs (`racepic-ingest-dlq`, `racepic-analyze-dlq`,
  `racepic-match-dlq`, Paket 1) zeigen hängengebliebene Nachrichten.

## Warteschlangen / hängengebliebene Verarbeitung

- Ein Bild bleibt in `UPLOADED`/`DERIVED`/`ANALYZED`: die jeweilige DLQ prüfen
  (`{prefix}-racepic-{ingest|analyze|match}-dlq`), Nachricht ansehen, Ursache beheben, dann
  `POST /admin/racepic/images/{imageId}/reanalyze` bzw. für Uploads erneut hochladen.
- Hängengebliebene Uploads (Presign-Fenster ohne `complete`-Aufruf) räumt der
  `RacePicUploadReconciler` automatisch alle 15 Minuten auf (Paket 3).

## Schwellen kalibrieren (Paket 10)

`GET /admin/racepic/events/{eventId}/matching-quality-report` (`racepic.read`) liefert für
Schwellen von 0,05 bis 1,00 in 0,05-Schritten jeweils Precision/Recall, berechnet **nur** aus
Detections mit mindestens einer von einem Menschen getroffenen Review-Entscheidung
(`source=MANUAL`: bestätigt/korrigiert/abgelehnt über die Review-Queue). Ein reines
`AUTO_MATCHED` ohne Prüfung zählt nicht als Ground Truth. Vorgehen:

1. Für das Pilot-Event ausreichend Bilder durch die Pipeline laufen lassen und in der
   Review-Queue (`/admin/racepic/review/{eventId}`) eine repräsentative Stichprobe abarbeiten
   (bestätigen/korrigieren/ablehnen) – je mehr geprüfte Detections, desto belastbarer der Report.
2. Report abrufen, die Schwelle mit Precision ≥ 98 % als neuen `autoThreshold` wählen (Ziel aus
   dem Architekturplan, Abschnitt "Verifikation"), eine niedrigere Schwelle mit brauchbarem
   Recall als `reviewThreshold`.
3. Neue `racepic_matching_config`-Version anlegen (`POST /admin/racepic/matching-configs`) und
   per `POST /admin/racepic/events/{id}/rematch` auf die bereits analysierten Bilder anwenden
   (kein erneuter Rekognition-/Bedrock-Aufruf, siehe oben).
4. Schritte 1–3 iterieren, bis die Schwellen stabil sind, bevor das Event veröffentlicht wird.

**Einschränkung:** Der Report ignoriert die Marge zum Zweitplatzierten (`minMargin`), die der
echte Matcher zusätzlich zur Schwelle verwendet (siehe `matchQuality.ts`). Für eine Marge-
Kalibrierung müssen die Rohdaten aus `racepic_match_candidate` separat ausgewertet werden.

## Vor dem ersten echten Deploy

1. Für den ersten Piloten ist kein CloudFront-Signing-Key erforderlich: Downloads verwenden
   kurzlebige S3-Presigned-URLs, und CloudFront lehnt private Pfade ohne Key fail-closed ab. Für
   eine spätere Umstellung auf CloudFront-Signed-URLs müssen Public Key, privater Key in Secrets
   Manager und die Signierung im API-Handler gemeinsam implementiert und aktiviert werden.
2. `cdk deploy` einmal in der GitHub-Actions-CI beobachten und bestätigen, dass `sharp` dort
   mit Linux-x64-Binaries bündelt (Paket 4 – lokal auf Windows nicht abschließend
   verifizierbar).
3. Rechtstexte (`docs/privacy/racepic-legal-texts-v1.md`, `docs/racepic/licenses.md`) durch
   Datenschutzbeauftragten/Vorstand freigeben lassen (Paket 0).
4. Bedrock-Modellzugriff fuer `cohere.embed-v4:0` in **eu-central-1** (nicht mehr eu-west-1,
   siehe Bug 2026-09-23) in der Bedrock-Konsole freigeben - live gegen prod getestet, schlaegt
   aktuell mit `AccessDeniedException` fehl (IAM-Policy ist korrekt, es fehlt die separate
   Bedrock-Modellzugriffsfreigabe). Ohne das faellt Matching komplett auf OCR/Startnummer zurueck.
5. Rate-Limiting für öffentliche Einladung-, Registrierungs- und Download-Endpunkte ist umgesetzt;
   die Grenzwerte beim Pilotbetrieb über CloudWatch beobachten.
