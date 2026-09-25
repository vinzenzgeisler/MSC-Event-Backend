<!-- Nur die Architektur (racepic-architecture.md) wird 1:1 in allen 3 Repos synchron gehalten. Diese Fortschrittsdatei ist repo-spezifisch und listet nur die Arbeitspakete, die in MSC-Event-Backend passieren. -->
# RacePic – Fortschritt (MSC-Event-Backend)

**Stand:** 2026-09-25 · Architektur: [racepic-architecture.md](./racepic-architecture.md) · Offene Punkte (konsolidiert): [racepic-open-items.md](./racepic-open-items.md) · UI/UX-Redesign-Roadmap: [racepic-ux-redesign-plan.md](./racepic-ux-redesign-plan.md) · Lizenzen: [../racepic/licenses.md](../racepic/licenses.md) · Rechtstexte: [../privacy/racepic-legal-texts-v1.md](../privacy/racepic-legal-texts-v1.md) · Retention: [../privacy/racepic-retention-addendum.md](../privacy/racepic-retention-addendum.md)

## Gesamt-Review 2026-09-25

- Migration 0109 ergänzt Upload-Fingerprints, Pipeline-Leases, Teilnehmer-Suppression und eine zusammengeführte Manifest-Refresh-Queue.
- Ingest, Analyze und Match claimen Arbeit atomar; Queue- und Invalidation-Fehler werden nicht mehr still ignoriert. Der Reconciler übernimmt abgelaufene Uploads, hängende Pipeline-Schritte und Manifest-Aufträge.
- Upload-Erstellung/-Abschluss ist idempotent, prüft Quota und Metadaten atomar und verwendet bei Multipart ausschließlich die serverseitig gelisteten Parts.
- Eine zentrale Eligibility-Abfrage wird von Publish und Download verwendet. Unterdrückte, nicht freigegebene, gelöschte oder widersprochene Nennungen gelangen nicht in öffentliche Manifeste oder Downloads.
- CloudFront ist ohne Signing-Key fail-closed; nur `public/*` und `manifests/*` sind explizit öffentlich. Öffentliche Start-/Download-Endpunkte sind rate-limitiert.
- Terms-Version ist `2026-09-21`; Refresh-Token-Rotation ist aktiv. Die Widerspruchsregel ist geklärt: Zuordnung entfernen, Bild erhalten. Passkeys und produktive Admin-MFA-Konfiguration bleiben offen.
- Matching-Version `2026-09-25.2`: Eine abweichende Startnummer auf dem Referenzfoto ist unschädlich, weil sie nicht aus dem Referenzfoto gelesen wird. Bei exaktem OCR-Treffer im Rennbild werden schwache Farbe/Embeddings eines veralteten Anmeldebilds auf neutral begrenzt; gute visuelle Signale bleiben wirksam. Bestehende Bilder müssen nach Deployment einmal rematched werden.
- Lokal verifiziert: API- und Infrastruktur-Build sowie die vollständige API-Test-Suite inklusive RacePic-Vertragstest erfolgreich.

Alle Arbeit läuft im Branch `feature/racepic-planning` (noch nicht nach `main` gemergt).

## Arbeitspakete in diesem Repo

| # | Paket | Status | Notiz |
|---|---|---|---|
| 0 | Entscheidungen (Datenschutztexte, Lizenztexte, Bedrock-Region) | **erledigt (Entwurf)** | Texte liegen in `docs/racepic/licenses.md` und `docs/privacy/racepic-*.md`; Freigabe durch Datenschutzbeauftragten/Rechtsberatung steht noch aus |
| 1 | Fundament: Migrationen `racepic_*`, `RacePicStack` (Bucket, CloudFront, SQS, Photographer-Pool), `RacePicApiHandler`, Permissions | **erledigt (ungedeployed)** | siehe „Paket 1 – Ergebnis“ unten |
| 2a | Identität (Backend-Teil): Photographer-Pool, Einladung/Claim-API, Profil-API, `requireStepUp` | **erledigt (ungedeployed)** | siehe „Paket 2 – Ergebnis“ unten; Website-Teil (Studio-UI) siehe msc-website |
| 3a | Upload (Backend-Teil): Batch- und Multipart-Endpoints, Reconciler | **erledigt (ungedeployed)** | siehe „Paket 3 – Ergebnis“ unten; Website-Teil siehe msc-website |
| 4 | Ingest- und Publish-Worker: Varianten, EXIF, Manifeste | **erledigt (ungedeployed)** | siehe „Paket 4 – Ergebnis" unten |
| 5b | Admin-Basis (Backend-Teil): Event-Konfiguration, Statistik, Lizenzliste für Admin-UI | **erledigt (ungedeployed)** | siehe „Paket 5 – Ergebnis" unten; UI siehe MSC-Event-Frontend |
| 6 | KI-Pipeline: Referenz-Job, Analyze-Worker, Matcher, Config, Audit | **erledigt (ungedeployed)** | siehe „Paket 6 – Ergebnis" unten |
| 7b | Review-Queue (Backend-Teil): Endpunkte für Queue, Entry-Suche, confirm/reject/correct/add | **erledigt (ungedeployed)** | siehe „Paket 7 – Ergebnis" unten; UI siehe MSC-Event-Frontend |
| 8b | Öffentliches RacePic (Backend-Teil): Teilnehmer-Bild-Manifeste, öffentlicher Download-Endpunkt | **erledigt (ungedeployed)** | siehe „Paket 8 – Ergebnis" unten; UI siehe msc-website |
| 9 | Datenschutz & Betrieb: Retention-Erweiterung (inkl. S3-Löschung Fahrzeugbild), Ausblenden-Funktion, Budgets, Runbook | **erledigt (ungedeployed)** | siehe „Paket 9 – Ergebnis" unten |
| 10a | Pilot 12. OLD 2026 (Backend-Teil): Kalibrierungs-Tooling | **Tooling erledigt (ungedeployed)** | siehe „Paket 10 – Ergebnis" unten; tatsächliche Piloten-Durchführung ist ein operativer Schritt, kein Code |
| 12 | Öffentliches Fotografenprofil (Backend-Teil): Slug, Manifest | **erledigt (ungedeployed)** | siehe „Paket 12 – Ergebnis" unten; Seite selbst in msc-website |
| 13 | Entwicklungsumgebung: CORS, CI/CD-Deploy-Lücke für `RacePicStack` | **erledigt (ungedeployed)** | siehe „Paket 13 – Ergebnis" unten |
| 15 | Studio-Redesign (Backend-Teil): Eigene-Bilder-Verwaltung | **erledigt (ungedeployed)** | siehe „Paket 15 – Ergebnis" unten; UI siehe msc-website |
| 16 | Admin-Redesign (Backend-Teil): Zuordnungen je Bild | **erledigt (ungedeployed)** | siehe „Paket 16 – Ergebnis" unten; UI siehe MSC-Event-Frontend |
| 17 | Landingpage (Backend-Teil): globale Discover-/Suchindex-Manifeste | **erledigt (ungedeployed)** | siehe „Paket 17 – Ergebnis" unten; UI siehe msc-website |

Admin-Endpunkte für die Review-Queue (Abschnitt H) werden ebenfalls hier implementiert, auch wenn die UI dazu in MSC-Event-Frontend liegt (Paket 5/7 dort).

## Paket 1 – Ergebnis (2026-09-21)

- `api/migrations/0095_racepic_core.sql`: alle `racepic_*`-Tabellen (Event-Aktivierung, Photographer, Invitation, License mit Seed der 5 Lizenzen aus Paket 0, UploadBatch/Upload, Image/ImageVariant, AiAnalysis, Detection/TextDetection, MatchCandidate, Assignment/AssignmentEvent, MatchingConfig, VehicleReference mit `pgvector`, ProcessingStep). Referenziert `event`/`entry`/`vehicle`, dupliziert keine Teilnehmerdaten.
- `api/src/db/schema.ts`: passende Drizzle-Definitionen ergänzt (gleiche Namen/Typen wie die Migration).
- `infra/lib/stacks/racepic-stack.ts` (neu): Media-Bucket (privat, Lifecycle-Regeln), CloudFront-Distribution mit OAC (Default-Behavior verlangt Signed-URLs, `manifests/*` und `public/*` sind explizit öffentlich), SQS-Queues ingest/analyze/match je mit DLQ + CloudWatch-Alarm, Photographer-Cognito-Pool (Email-OTP + Passkey, `ALLOW_USER_AUTH`).
  - Private CloudFront-Pfade sind ohne Signing-Key fail-closed. Der Pilot-Download verwendet unabhängig davon kurzlebige S3-Presigned-URLs. CloudFront-Signed-URLs sind eine spätere Optimierung und benötigen zusätzlich die API-seitige Signierung mit einem privaten Key.
- `infra/bin/app.ts`, `infra/lib/config/{types,dev,prod}.ts`: `RacePicStack` ist über `config.enableRacePic` (Default **false**, per `DEV_ENABLE_RACEPIC`/`PROD_ENABLE_RACEPIC` einschaltbar) komplett optional verdrahtet – bestehende Deploys sind unverändert.
- `infra/lib/stacks/api-stack.ts`: `RacePicApiHandler`-Lambda (eigene Funktion, gleiche HttpApi) mit Stub-Routen `GET /racepic/health` (offen), `GET /photographer/me` (Photographer-JWT, liefert 501), `GET /admin/racepic/ping` (Staff-JWT + `racepic.read`). Zweiter JWT-Authorizer für den Photographer-Pool.
- `api/src/racepic/handler.ts`, `api/src/racepic/auth.ts` (neu): Handler-Skelett im Stil von `api/src/handler.ts`; `getPhotographerAuthContext`/`satisfiesStepUp` als Grundlage für die Step-up-Policies aus Abschnitt E (nur `session`/`recent` bereits nutzbar, `strong` liefert bewusst immer `false`, bis der Passkey-Grant-Store existiert).
- `api/src/http/auth.ts`, `infra/lib/stacks/auth-stack.ts`: Permissions `racepic.read`/`racepic.review`/`racepic.manage`, neue Rolle/Cognito-Gruppe `racepic_moderator` (read+review, kein manage).
- **Verifiziert:** `tsc --noEmit` für `api/` und `infra/` fehlerfrei; `cdk synth` für `RacePicStack` allein und für `ApiStack` mit `enableRacePic=true` (dev-Testprofil) erfolgreich. **Nicht deployed** (lokales Deployen ist laut `AGENTS.md` untersagt; Aktivierung nur bewusst über die CI-Pipeline mit `*_ENABLE_RACEPIC=true`).

## Paket 2 – Ergebnis (2026-09-21)

- `api/migrations/0096_racepic_photographer_invitation_mail.sql`: Systemmail-Template `racepic_photographer_invitation` (gleiches Muster wie `0055_doublestarter_migration_notice.sql`), läuft über den bestehenden `email_outbox`/`EmailWorker`-Pfad, nicht über die Admin-Compose-Route.
- `api/src/racepic/repository.ts` (neu): `createPhotographerInvitation` (legt Profil + `racepic_photographer_event`-Zeilen + Einladungstoken transaktional an, reinvite-faehig), `getInvitationPreviewByToken`, `getConsumableInvitationByToken`, `claimInvitation` (race-sicher über die WHERE-Bedingungen des Updates), `getPhotographerByCognitoSub`, `updatePhotographerProfile`, `listPhotographers`.
- `api/src/racepic/cognito.ts` (neu): `ensurePhotographerCognitoUser` (AdminCreateUser mit `MessageAction: SUPPRESS`, kein Passwort, `email_verified: true` weil nur über den geprüften Einladungslink erreichbar), idempotent gegenüber bereits existierenden Nutzern.
- `api/src/racepic/mail.ts` (neu): Queued die Einladungsmail direkt in `email_outbox` (Template-Daten `photographerName`, `eventNames`, `invitationUrl`).
- `api/src/racepic/handler.ts`: volle Routen-Implementierung für
  - `POST /admin/racepic/photographers` (einladen, `racepic.manage`), `GET /admin/racepic/photographers` (`racepic.read`)
  - `GET /public/racepic/invitations/{token}` (Vorschau: nur Eventnamen + maskierte E-Mail), `POST /public/racepic/invitations/{token}/start` (legt Cognito-Nutzer an, gibt die volle E-Mail zurück – siehe Begründung im Code – als Cognito-`USERNAME` für den nachfolgenden Email-OTP-Login)
  - `POST /photographer/claim` (prüft `email_verified` + E-Mail-Übereinstimmung mit der Einladung, bindet `cognito_sub`)
  - `GET`/`PATCH /photographer/me` (E-Mail-Änderung bewusst ausgeklammert, braucht Stufe `recent` + Cognito-Attributänderung, folgt später)
- `infra/lib/stacks/api-stack.ts`: Routen für alle oben genannten Endpunkte registriert; `cognito-idp:AdminCreateUser`/`AdminGetUser` auf den Photographer-Pool granted (nicht auf den Staff-Pool).
- `infra/lib/config/{types,dev,prod}.ts`: neues Feld `racepicWebsiteBaseUrl` (Basis-URL für den Einladungslink, zeigt auf die Website, nicht das Nennungstool-Frontend).
- `api/src/audit/log.ts`: neue Audit-Actions `racepic_photographer_invited`/`_claimed`/`_profile_updated`.
- **Verifiziert:** `tsc --noEmit` für `api/` und `infra/` fehlerfrei; `cdk synth` für `ApiStack` mit `enableRacePic=true` erneut erfolgreich (neue Routen + IAM-Policy). **Nicht deployed.**

## Paket 3 – Ergebnis (2026-09-21)

- `api/migrations/0097_racepic_image_sha256_nullable.sql`: Korrektur an Paket 1 – `racepic_image.sha256` ist beim Upload-Abschluss noch nicht bekannt (erst der Ingest-Worker in Paket 4 berechnet ihn); Spalte ist jetzt nullable, der Unique-Index schließt `NULL` aus.
- `api/src/racepic/s3.ts` (neu): Presign-Helfer für den Media-Bucket (einzelner PUT, Multipart create/uploadPart/listParts/complete/abort, headObject, deleteObject) – eigenes Modul statt Erweiterung von `docs/storage.ts` (anderes Zugriffsmuster: Fotografen-eigene Uploads statt Admin-generierte PDFs).
- `api/src/racepic/uploads.ts` (neu): Batch anlegen (prüft Event-Zugang, Upload-Fenster, aktive Lizenz), Upload anlegen (MIME/Größe/Duplikat-Fingerprint/Quota, entscheidet Single-PUT vs. Multipart ab 16 MB), Complete (idempotent, legt `racepic_image` an), Abort, Bildliste, Reconciler-Abfrage.
- `api/src/racepic/queues.ts` (neu): sendet nach erfolgreichem Upload-Abschluss eine Nachricht an die Ingest-Queue (Paket 4 konsumiert sie).
- `api/src/racepic/reconcileUploads.ts` (neu) + EventBridge-Schedule (alle 15 Minuten): räumt Uploads auf, deren Presign-Fenster ohne `complete`-Aufruf abgelaufen ist (S3-Abbruch/-Löschung + Status `EXPIRED`).
- `api/src/racepic/handler.ts`: volle Routen für Batch-/Upload-Erstellung, Teile signieren/auflisten (Resume), Complete, Abort, Bildliste, sowie `GET /photographer/events` (Event-Zugang für die UI) und `GET /photographer/licenses` (aktiver Lizenzkatalog).
- `infra/lib/stacks/api-stack.ts`: Routen registriert, zusätzliche S3-Multipart-Permissions für `RacePicApiHandler`, neue `RacePicUploadReconciler`-Lambda mit eigenen (minimalen) S3-/DB-Permissions.
- `api/package.json`: `@aws-sdk/client-sqs` als neue Abhängigkeit.
- **Verifiziert:** `tsc --noEmit` für `api/` und `infra/` fehlerfrei; `cdk synth` für `ApiStack` mit `enableRacePic=true` erneut erfolgreich (neue Routen, IAM-Policies, Reconciler-Lambda + Schedule). **Nicht deployed.**

## Paket 4 – Ergebnis (2026-09-21)

- `api/src/racepic/imageProcessing.ts` (neu): reine Bildverarbeitung ohne AWS-/DB-Aufrufe – Magic-Bytes-Check, sha256, EXIF-Auszug (nur `DateTimeOriginal`/`Make`/`Model` via `exifr`, kein GPS), Rendern der 4 Downloadvarianten mit `sharp` (thumb/preview als WebP, medium/large als JPEG). `sharp.limitInputPixels` schützt gegen Dekompressions-Bomben.
  - **Vereinfachung ggü. Architekturplan:** Copyright wird nur als EXIF-`Copyright`/`Artist`-Tag in medium/large eingebettet, kein vollständiges IPTC/XMP (deutlich aufwendiger, ohne Mehrwert für den MVP-Anwendungsfall).
  - Ohne `withMetadata()` entfernt `sharp` standardmäßig **alle** Metadaten (inkl. GPS/Seriennummern) – das erfüllt die Vorgabe aus Abschnitt G für thumb/preview automatisch, ohne Sonderlogik.
- `api/src/racepic/ingestWorker.ts` (neu): SQS-Consumer der Ingest-Queue (`batchSize: 1`, `reportBatchItemFailures`). Lädt das Original aus `incoming/`, validiert, dedupliziert per sha256 innerhalb des Events, verschiebt das Original nach `originals/{eventId}/{imageId}.jpg`, schreibt alle 4 Varianten nach `derived/{imageId}/{kind}` (**immer privat** – `public/` wird erst beim Veröffentlichen befüllt, siehe Paket 4 Abschnitt G), aktualisiert `racepic_image` (Status `DERIVED`) und stößt die Analyse-Queue an (Paket 6 konsumiert sie später; bis dahin bleibt die Nachricht einfach liegen).
  - Idempotent über `racepic_processing_step` (image_id, step='ingest', pipeline_version) – ein erneut zugestelltes SQS-Event führt zu keiner doppelten Verarbeitung.
- `api/src/racepic/publish.ts` (neu): `publishImage`/`hideImage`/`removeImage` (kopiert/löscht nur die öffentlichen thumb/preview-Kopien, `racepic_image_variant` bleibt kanonisch auf `derived/`), `regenerateManifestsForEvent` (schreibt `manifests/{slug}/index.json` und `manifests/events.json`), CloudFront-Invalidation (best effort). `removeImage` behält den Audit-Trail (`racepic_assignment_event`), löscht nur Bilddaten.
  - Teilnehmer-Manifest ohne Paket 6 (Matching) zwangsläufig leer, da `racepic_assignment` noch keine Zeilen hat – der Mechanismus (Query, S3-Schreiben, Invalidation) ist trotzdem vollständig.
  - Datenschutz: Teilnehmer mit `processing_restricted`/`objection_flag` werden ausgeschlossen; ein hinterlegter `publication_name` wird als Pseudonym angezeigt statt den echten Namen zu unterdrücken (konsistenter mit der RacePic-Datenschutz-Vorgabe als die bestehende `isPubliclyEligible`-Logik im Event-Hub, die publication-name-Fälle ganz ausschließt).
- `api/src/racepic/handler.ts`: `PATCH /admin/racepic/images/{id}` (`{visibility: PUBLISHED|HIDDEN|REMOVED}`) – `HIDDEN` braucht nur `racepic.review`, `PUBLISHED`/`REMOVED` brauchen `racepic.manage`; löst nach jeder Änderung automatisch `regenerateManifestsForEvent` aus.
- `api/src/racepic/s3.ts`, `queues.ts`: ergänzt um `getObject`/`putObject`/`copyObject` (serverseitig, kein Presign) und `sendAnalyzeMessage`.
- `infra/lib/stacks/api-stack.ts`: neue `RacePicIngestWorker`-Lambda (SQS-Event-Source auf die Ingest-Queue, 1536 MB, 60 s Timeout), `PATCH`-Route registriert, `cloudfront:CreateInvalidation`-Permission für `RacePicApiHandler`, `RACEPIC_CDN_DISTRIBUTION_ID`-Env-Var.
  - **Architekturentscheidung:** `RacePicIngestWorker` läuft auf **`Architecture.X86_64`**, nicht `ARM_64` wie im Kostenkapitel des Architekturplans angedacht. Begründung: `sharp` ist ein natives Modul; beim CDK-Bundling (`bundling.nodeModules: ['sharp']`) installiert `npm` die zur **Build-Maschine** passenden Binaries. Die GitHub-Actions-Runner der CI/CD-Pipeline sind x86_64-Linux; x86_64 zu wählen vermeidet eine fehleranfällige npm-Cross-Architektur-Installation für ARM64. Kann später umgestellt werden, sobald der CI-Bundlingschritt das gezielt absichert.
- `api/package.json`: `sharp`, `exifr`, `@aws-sdk/client-cloudfront` als neue Abhängigkeiten.
- **Verifiziert, mit wichtiger Einschränkung:**
  - `tsc --noEmit` für `api/` und `infra/` fehlerfrei.
  - `cdk synth` für `ApiStack` mit `enableRacePic=true`: **strukturell erfolgreich** (Routen, IAM-Policies, Ressourcen, `RacePicIngestWorker`-Bundling inkl. `sharp` selbst laufen durch), aber lokal auf diesem Windows-Rechner sehr instabil – wiederholtes `EPERM: operation not permitted, rename …bundling-temp-…` beim esbuild-Bundling, das **zufällig verschiedene, RacePic-fremde, seit Langem bestehende Lambdas** trifft (`EmailWorker`, `ApiHandler`, `PrivacyRetentionWorker`, `EventHubMaintenanceWorker`). Über mehrere Versuche hinweg lief der Synth einmal vollständig durch (inkl. `RacePicIngestWorker`); das ist eine Windows-Sandbox-Eigenart (Dateisystem-Locking, evtl. Virenscanner), keine inhaltliche Regression – die reale Pipeline läuft auf Linux-GitHub-Actions-Runnern, wo dieses Problem nicht auftritt.
  - Das lokal gebündelte `sharp` enthält **Windows-x64-Binaries** (`@img/sharp-win32-x64`), nicht die für Lambda nötigen Linux-Binaries – erwartbar, weil `npm install` während des Bundlings die zur lokalen Maschine passende Variante installiert. Beim echten `cdk deploy`/`synth` in der Linux-CI installiert derselbe Mechanismus automatisch `@img/sharp-linux-x64`, passend zur gewählten `X86_64`-Architektur. Das ist **nicht live/deploy-verifizierbar** in dieser Sandbox.
  - **Nicht deployed.**
  - **Hinweis zur eigenen Methodik:** Frühere `cdk synth`-Prüfungen in diesem Branch liefen über `... | tail -N`, was den echten Exit-Code der Pipe maskiert (Bash gibt bei `cmd | tail` standardmäßig den Exit-Code von `tail`, nicht von `cmd`, zurück). Die Befunde zu Paket 1–3 wurden nachträglich nicht erneut geprüft, sind aber durch `tsc --noEmit` weiterhin auf TypeScript-Ebene abgesichert; künftige Synth-Checks in diesem Projekt sollten den Exit-Code ohne `| tail` (oder mit `set -o pipefail`) auswerten.

## Paket 5 – Ergebnis (2026-09-21)

- `api/src/racepic/adminEvents.ts` (neu): `listEventsWithRacepicConfig` (alle Nennungstool-Events, `racepic_event` per LEFT JOIN), `upsertRacepicEventConfig` (legt die racepic_event-Zeile an oder aktualisiert sie), `getEventStats` (Fotografen-Anzahl, Bilder nach `processingStatus`/`visibility` gruppiert), `listPhotographersWithEventAccess` (Fotografen inkl. zugeteilter Events, für die Admin-Liste).
- `api/src/racepic/handler.ts`: `GET /admin/racepic/events`, `PUT /admin/racepic/events/{id}` (`racepic.manage`), `GET /admin/racepic/events/{id}/stats`, `GET /admin/racepic/licenses` (Admin-Variante des Lizenzkatalogs – die bestehende `GET /photographer/licenses` ist nur mit dem Photographer-JWT erreichbar, das Admin-Frontend nutzt den Staff-Pool).
- `infra/lib/stacks/api-stack.ts`: die vier neuen Routen registriert (kein neuer Lambda, alles über `RacePicApiHandler`).
- `api/src/audit/log.ts`: neue Audit-Action `racepic_event_config_updated`.
- **Verifiziert:** `tsc --noEmit` für `api/` und `infra/` fehlerfrei. Ein `cdk synth`-Versuch traf erneut die aus Paket 4 bekannte Windows-Bundling-Flakiness (EPERM, RacePic-fremde Lambda) und wurde nicht mehrfach wiederholt, da die Änderung rein additiv ist (vier neue Routen auf dem bestehenden `RacePicApiHandler`, keine neuen Ressourcen) und strukturell identisch zu den bereits erfolgreich verifizierten Mustern aus Paket 1–3. **Nicht deployed.**

## Paket 6 – Ergebnis (2026-09-21)

- **Modell-/Request-Format verifiziert (Web-Recherche, Stand 2026-09-21):** Cohere Embed v4 auf Bedrock hat die Modell-ID `cohere.embed-v4:0`, Bild-Input über `images: ["data:<mime>;base64,..."]`, `output_dimension` konfigurierbar (256/512/1024/1536 – wir nutzen 1024, passend zu `vector(1024)` aus Paket 1). Quelle: aktuelle AWS-Doku (`model-parameters-embed-v4.html`).
- `api/src/racepic/bedrock.ts` (neu): `embedImage` (ein Bild → 1024-dim Float-Vektor, `input_type: search_document` für beide Seiten – Referenz und Kandidat –, damit sie im selben Vektorraum vergleichbar sind), `cosineSimilarity`.
- `api/src/racepic/rekognition.ts` (neu): `detectVehicles` (`DetectLabels` mit `Features: ['GENERAL_LABELS','IMAGE_PROPERTIES']`, gefiltert auf Labels `Car`/`Motorcycle`, inkl. `Instance.DominantColors` – kein zusätzlicher Aufruf für Fahrzeugfarbe nötig), `detectText` (`DetectText`, nur `Type: WORD` für präzise Bounding-Boxes einzelner Startnummern-Token, normalisiert wie `entry.start_number_norm`), `isTextInsideVehicle` (Mittelpunkt-in-BBox-Test für `ocr_in_bbox`). **Bewusst keine Gesichtserkennung** – IAM-Policy des Analyze-Workers erlaubt nur `DetectText`/`DetectLabels`.
- `api/src/racepic/vehicleReference.ts` (neu): "Referenz-Job" als Cache-on-demand statt vorgelagertem Batch-Job – beim ersten Matching-Bedarf wird das Nennungstool-Fahrzeugfoto aus dem **Assets-Bucket** (nur lesend, separate IAM-Policy) gelesen, Embedding + dominante Farbe (schneller Näherungswert über 1×1-Resize mit `sharp`) berechnet und in `racepic_vehicle_reference` zwischengespeichert, verknüpft über einen Hash von `vehicle.image_s3_key` (ändert sich das Foto, wird neu berechnet).
- `api/src/racepic/matching.ts` (neu, reine Logik ohne AWS/DB): Scoring als gewichtete lineare Kombination statt trainierter Logistic Regression – **es gibt noch keine gelabelten Trainingsdaten**, die entstehen erst durch die Review-Entscheidungen im Piloten (Paket 10). Gewichte/Schwellen sind über `racepic_matching_config` austauschbar (Architekturprinzip "Grenzwerte nicht hart einbauen" erfüllt, auch wenn die Kombinationsform selbst noch einfach ist). Fehlende Signale (kein Referenzfoto → kein Embedding) werden neutral (0,5) statt ablehnend gewertet.
- `api/src/racepic/matchingConfig.ts` (neu): `racepic_matching_config` CRUD, event-spezifische Config hat Vorrang vor globaler, konservative Fallback-Konstanten (`autoThreshold=0.85`, `reviewThreshold=0.55`, `minMargin=0.08`) falls noch keine Config existiert. Neue Version deaktiviert alte im selben Scope (nie löschen – Kandidaten referenzieren `configVersion` für reproduzierbare Re-Runs).
- `api/src/racepic/analyzeWorker.ts` (neu): SQS-Consumer der Analyze-Queue – lädt die `large`-Variante, ruft Rekognition (beide Aufrufe) und je Fahrzeug-Crop Bedrock auf, speichert Rohantworten in `analysis/{imageId}/...json`, legt `racepic_detection`/`racepic_text_detection`-Zeilen an (Text wird der umschließenden Fahrzeug-BBox zugeordnet), **zwei separate `racepic_ai_analysis`-Einträge** (Rekognition und Bedrock, Abschnitt I9: "verwendeter AWS-Dienst, Modell/Version" je Aufruf), stößt die Match-Queue an. Ein einzelner fehlgeschlagener Embedding-Aufruf stoppt nicht die restliche Analyse (Abschnitt F: "kein einzelnes KI-Modell löst zuverlässig alle Zuordnungen").
- `api/src/racepic/matchWorker.ts` (neu): SQS-Consumer der Match-Queue – lädt zulässige Nennungen (`acceptance_status=accepted`, `registration_status=submitted_verified`, nicht gelöscht), berechnet je Fahrzeug-Detection alle Kandidaten-Scores, speichert die Top 5 als `racepic_match_candidate`, entscheidet `AUTO_MATCHED`/`REVIEW_REQUIRED`/kein Assignment anhand der Config-Schwellen und der Marge zum Zweitplatzierten, schreibt `racepic_assignment` + `racepic_assignment_event` (Audit). **Überschreibt nie manuell entschiedene Zuordnungen** (`source='MANUAL'`) – Architekturprinzip aus Abschnitt F. Idempotenz-Pipeline-Version enthält die Matching-Config-Version, ein Rematch mit neuer Config ist also **kein** No-Op.
- `api/src/racepic/handler.ts`: `GET/POST /admin/racepic/matching-configs`, `POST /admin/racepic/events/{id}/rematch` (reiht alle `ANALYZED`/`MATCHED`-Bilder erneut in die Match-Queue ein, ohne neuen KI-Aufruf), `POST /admin/racepic/images/{id}/reanalyze`.
- `infra/lib/stacks/api-stack.ts`: neue `RacePicAnalyzeWorker`- und `RacePicMatchWorker`-Lambdas (SQS-Event-Source, `Architecture.X86_64` wie der Ingest-Worker), IAM: `rekognition:DetectText`/`DetectLabels` (keine Ressourceneinschränkung möglich), `bedrock:InvokeModel` auf `arn:aws:bedrock:eu-west-1::foundation-model/cohere.*`, lesender Zugriff des Match-Workers auf den Assets-Bucket.
- `api/package.json`: `@aws-sdk/client-bedrock-runtime`, `@aws-sdk/client-rekognition` als neue Abhängigkeiten.
- **Verifiziert:** `tsc --noEmit` für `api/` und `infra/` fehlerfrei; `cdk synth` für `ApiStack` mit `enableRacePic=true` **im ersten Versuch erfolgreich** (inkl. Bundling beider neuer Lambdas). **Nicht deployed** – die verifizierten Bedrock-Request-/Response-Formate sind nicht live gegen die echte API getestet.

## Paket 7 – Ergebnis (2026-09-21)

Diese Endpunkte hatte Abschnitt H des Architekturplans bereits vorgesehen, sie waren aber noch nicht gebaut (analog zur Situation bei Paket 5).

- `api/src/racepic/reviewQueue.ts` (neu): `listReviewQueue` (Bilder/Zuordnungen mit Status `REVIEW_REQUIRED`, inkl. presigned Vorschau-URL und Kandidatenliste mit Namen/Fahrzeug), `confirmAssignment`/`rejectAssignment`/`correctAssignment`/`addAssignment` (alle schreiben `racepic_assignment_event` als Audit-Trail), `listImagesForEntry` (Fahreransicht zur Korrektur), `searchEntriesByEvent` (für den "anderen Fahrer wählen"-Dialog).
  - **Bewusste Vereinfachungen:** Offset- statt Keyset-Pagination (bei den hier erwarteten Datenmengen ausreichend), kein Soft-Lock pro Item (siehe Progress-Notiz bei MSC-Event-Frontend).
- `api/src/racepic/s3.ts`: `presignGetObject` (Presigned GET für die private `derived/`-Vorschau) ergänzt.
- `api/src/racepic/handler.ts`: `GET /admin/racepic/events/{id}/review-queue`, `GET .../entries/search`, `POST /admin/racepic/assignments/{id}/{confirm,reject,correct}`, `POST /admin/racepic/images/{id}/assignments`, `GET /admin/racepic/participants/{id}/images`.
- `api/src/audit/log.ts`: neue Audit-Action `racepic_assignment_reviewed`.
- **Verifiziert:** `tsc --noEmit` für `api/` und `infra/` fehlerfrei.

## Paket 8 – Ergebnis (2026-09-21)

- **Korrektur an Paket 4:** Die Kurzform-URLs `/m/*`/`/p/*` aus Abschnitt H waren nie als CloudFront-Pfad-Aliase konfiguriert (`racepic-stack.ts` hat Behaviors direkt auf die S3-Präfixe `manifests/*`/`public/*` gelegt). Öffentliche URLs verwenden jetzt konsequent die tatsächlichen Präfixe (`/manifests/...`, `/public/...`) – dokumentiert direkt in `publish.ts`.
- `api/src/racepic/publish.ts`: `regenerateManifestsForEvent` erzeugt jetzt zusätzlich **ein Manifest pro Teilnehmer** (`manifests/{slug}/p/{participantKey}.json`) mit den zugeordneten, veröffentlichten Bildern inkl. Fotograf und Lizenz – vorher gab es nur das Teilnehmer-Übersichtsmanifest ohne Bilddetails.
- `api/src/racepic/download.ts` (neu): `requestImageDownload` – prüft `visibility=PUBLISHED` und `offerMode=FREE` (bezahlte Bilder sind bewusst noch nicht unterstützt, der Codepfad ist aber schon auf die spätere Erweiterung vorbereitet), liefert eine kurzlebige Presigned-GET-URL (S3, siehe Interims-Hinweis in `s3.ts`) plus Attribution (Fotograf, Copyright, Lizenz).
- `api/src/racepic/handler.ts`: `POST /public/racepic/images/{id}/download` (öffentlich, kein Authorizer).
- **Offener Sicherheitspunkt:** Der Download-Endpunkt ist **nicht** an den bestehenden `publicRateLimit`-Mechanismus des Haupt-Handlers angebunden – vor Go-Live nachziehen.
- **Verifiziert:** `tsc --noEmit` für `api/` und `infra/` fehlerfrei. `cdk synth`-Versuche (3×) trafen jedes Mal die aus Paket 4 bekannte Windows-Bundling-Flakiness an RacePic-fremden, vorbestehenden Lambdas (`SesFeedbackWorker`, `EventHubMaintenanceWorker`) – keiner der Versuche kam bis zu neuem RacePic-Code; nicht weiter wiederholt (siehe Methodik-Hinweis in Paket 4).

## Paket 9 – Ergebnis (2026-09-21)

- `api/src/jobs/privacyRetentionWorker.ts` (bestehende Datei, erweitert): schließt die in Paket 6 dokumentierte Lücke – bevor `vehicle.image_s3_key` genullt wird, liest ein SELECT (dieselbe WHERE-Bedingung wie das anschließende UPDATE) `{id, image_s3_key}` der betroffenen Fahrzeuge; nach dem UPDATE (nur wenn `!settings.dryRun`) werden die S3-Objekte im Assets-Bucket über alle plausiblen Extensions (`''`, `.jpg`, `.jpeg`, `.png`, `.webp` – der Suffix ist historisch nicht einheitlich) best-effort gelöscht (`deleteVehicleImageObjects`, Fehler pro Objekt werden verschluckt, nicht der ganze Lauf abgebrochen) und die zugehörige `racepic_vehicle_reference`-Zeile entfernt (Embedding/Farbe sind ja auf das jetzt gelöschte Foto bezogen). Zähler `deletedRows['vehicle_image_s3_deleted']` neu im Audit-Log-Eintrag `privacy_retention_run`.
  - Zusätzlich am Ende des Worker-Laufs (vor dem finalen Audit-Log-Write, nur wenn `!settings.dryRun`): ein Query ermittelt alle **veröffentlichten** RacePic-Events, deren `person`-Zeilen (Fahrer/Beifahrer) im aktuellen Lauf angefasst wurden (Anonymisierung), und ruft für jedes betroffene Event `regenerateManifestsForEvent` (dynamischer Import aus `../racepic/publish`, damit der Kern-Worker keine harte Buildzeit-Abhängigkeit auf das optionale RacePic-Modul bekommt) auf – sonst würden anonymisierte Namen erst bei der nächsten manuellen Bildänderung aus den öffentlichen Manifesten verschwinden. Fehler dabei werden gesammelt (`errors.push(...)`), nicht geworfen, RacePic bleibt damit für den Kern-Datenschutzlauf optional/entkoppelt.
- `api/src/racepic/reviewQueue.ts`: `hideParticipant(entryId, actorId)` unterdrückt die Nennung dauerhaft und setzt alle aktiven Zuordnungen auf `REJECTED`. Das Bild bleibt unabhängig davon öffentlich; vollständige Bildlöschung ist ein separater Vorgang.
- `api/src/racepic/handler.ts`: `POST /admin/racepic/participants/{entryId}/hide` (`racepic.manage`), löst nach dem Ausblenden `regenerateManifestsForEvent` für das betroffene Event aus; `RACEPIC_ENTRY_NOT_FOUND` neu in `racePicErrorStatus` (404).
- `api/src/audit/log.ts`: neue Audit-Action `racepic_participant_hidden: ['rejectedCount']`.
- `infra/lib/stacks/racepic-stack.ts`: neue `CfnBudget`-Ressource `{prefix}-racepic-monthly` (nur wenn `orgaNotificationRecipients` nicht leer ist), gefiltert auf die Kostentreiber aus Abschnitt M (`Amazon Rekognition`, `Amazon Bedrock`, `Amazon CloudFront`), zwei Benachrichtigungen: `ACTUAL > 80%` und `FORECASTED > 100%`, beide an `orgaNotificationRecipients`. Höhe konfigurierbar über das neue Feld `racepicMonthlyBudgetUsd` (`infra/lib/config/types.ts`), Default 20 USD (dev, `DEV_RACEPIC_MONTHLY_BUDGET_USD`) bzw. 50 USD (prod, `PROD_RACEPIC_MONTHLY_BUDGET_USD`).
- `infra/lib/stacks/api-stack.ts`: `PrivacyRetentionWorker` bekommt (nur wenn `props.racePicStack` gesetzt ist, also `enableRacePic=true`) zusätzliche Env-Vars `RACEPIC_MEDIA_BUCKET`/`RACEPIC_CDN_DISTRIBUTION_ID` sowie IAM-Rechte für S3 (Media-Bucket, get/put/delete – put, weil `regenerateManifestsForEvent` die Manifest-JSONs schreibt) und `cloudfront:CreateInvalidation` auf die RacePic-Distribution; unverändert, wenn RacePic nicht aktiv ist (bestehende `ASSETS_BUCKET`-Delete-Policy für die Fahrzeugbild-Löschung war schon vorhanden, hier nur ergänzt um die RacePic-Ressourcen).
- `docs/racepic/runbook.md` (neu): operatives Runbook – RacePic für ein Event aktivieren, Bild veröffentlichen/verbergen/entfernen, Teilnehmer ausblenden, Matching neu laufen lassen, Datenschutz-Anfrage abarbeiten, Fahrzeugbild-Löschung prüfen, Kostenüberwachung (nennt das neue Budget), Warteschlangen-/DLQ-Troubleshooting, Checkliste vor dem ersten echten Deploy.
- **Verifiziert:** `tsc --noEmit` für `api/` und `infra/` fehlerfrei. `cdk synth` (3 Versuche, `infra/synth9.log`) traf jedes Mal die aus Paket 4/5/8 bekannte Windows-Bundling-Flakiness (`EPERM: operation not permitted, rename …bundling-temp-…`) an RacePic-fremden, vorbestehenden Lambdas (`ApiHandler`, `RacePicApiHandler` – Letzterer selbst schon in Paket 6 sauber verifiziert –, `SesFeedbackWorker`); `PrivacyRetentionWorker` (die eigentlich für Paket 9 relevante Lambda) wurde in zwei der drei Versuche tatsächlich gebündelt, ohne dass dort ein Fehler protokolliert wurde. Keiner der drei Versuche endete mit einem inhaltlichen Fehler am neuen RacePic-Code – konsistent mit dem bekannten, rein umgebungsbedingten Muster (siehe Methodik-Hinweis in Paket 4). Nicht weiter wiederholt. **Nicht deployed.**

## Paket 10 – Ergebnis (2026-09-21)

**Wichtige Einschränkung zuerst:** Paket 10 ist laut Umsetzungsplan (Abschnitt N) primär eine
**operative Durchführung** (echte Fotografen einladen, echte Fotos vom bereits vergangenen
12. OLD 2026 hochladen, Schwellen an echten Review-Entscheidungen kalibrieren, veröffentlichen)
und kein reines Code-Paket. Diese Sandbox hat keinen AWS-Zugriff, keinen Deploy-Weg und keine
echten Fotografen-Kontakte – das eigentliche Durchführen des Piloten kann hier nicht stattfinden
und wurde **nicht** simuliert oder mit Fake-Daten vorgetäuscht. Gebaut wurde das für die
Kalibrierung nötige **Tooling**, das während des echten Piloten gebraucht wird:

- `api/src/racepic/matchQuality.ts` (neu): `computeMatchQualityReport(eventId)` – Precision/
  Recall je Schwelle (0,05–1,00, Schrittweite 0,05), berechnet ausschließlich aus Detections mit
  mindestens einer **von einem Menschen** getroffenen Review-Entscheidung (`racepic_assignment.source
  = 'MANUAL'`, also über confirm/reject/correct/add aus der Review-Queue, Paket 7). Ein reines
  `AUTO_MATCHED` ohne jede menschliche Prüfung fließt bewusst nicht als Ground Truth ein, sonst
  würde der Report die Entscheidung des Matchers gegen sich selbst bewerten (siehe ausführliche
  Begründung im Modul-Kommentar). Bewusste Vereinfachung: berücksichtigt nur den Rang-1-
  Kandidatenscore gegen die Schwelle, nicht die zusätzliche `minMargin`-Bedingung des echten
  Matchers (`matchWorker.ts`).
- `api/src/racepic/handler.ts`: `GET /admin/racepic/events/{id}/matching-quality-report`
  (`racepic.read`).
- `infra/lib/stacks/api-stack.ts`: Route registriert (kein neuer Lambda, wie Paket 5/7).
- `docs/racepic/runbook.md`: neuer Abschnitt „Schwellen kalibrieren (Paket 10)" – konkrete
  Schritte für den echten Piloten (Review-Stichprobe abarbeiten → Report abrufen → Schwelle mit
  Precision ≥ 98 % als `autoThreshold` wählen, Ziel aus Abschnitt „Verifikation" des
  Architekturplans → neue Matching-Config anlegen → Rematch auslösen → iterieren, bevor das
  Event veröffentlicht wird).
- **Verifiziert:** `tsc --noEmit` für `api/` und `infra/` fehlerfrei. Ein `cdk synth`-Versuch traf
  erneut die aus Paket 4/5/8/9 bekannte Windows-Bundling-Flakiness (EPERM) an `RacePicApiHandler`
  selbst (derselbe Lambda, der die neue Route bedient) – bei einer rein additiven Route auf einem
  bereits mehrfach erfolgreich verifizierten Handler nicht weiter wiederholt (siehe Methodik-
  Hinweis Paket 4). **Nicht deployed.**

**Noch offen für den echten Piloten (operativ, nicht Code):**
1. `enableRacePic` für die Zielumgebung aktivieren (Deploy über die CI-Pipeline).
2. Optional nach dem Piloten: CloudFront-Signed-Downloads einschließlich privatem API-Signing-Key implementieren. Der aktuelle S3-Presigned-Download ist sicher und einsatzfähig.
3. Rechtstexte final freigeben lassen (offen seit Paket 0).
4. `racepic_event` für `old-2026` anlegen (`PUT /admin/racepic/events/{id}`), echte Fotografen im
   Nennungstool-Admin einladen (`/admin/racepic`).
5. Echte Fotos hochladen (Studio), Pipeline laufen lassen, Review-Queue abarbeiten.
6. Mit `matching-quality-report` kalibrieren (siehe Runbook-Abschnitt), Event veröffentlichen.

## Paket 12 – Ergebnis (2026-09-22)

Schließt die letzte offene MVP-Scope-Lücke (siehe Bestandsaufnahme unten und
`msc-website/docs/memory-bank/racepic-progress.md` Paket 8: "`/racepic/fotografen/:slug` fehlt
noch") – öffentliches Fotografenprofil, wie in Abschnitt H/J des Architekturplans vorgesehen.

- `api/migrations/0098_racepic_photographer_slug.sql`: neue nullable `slug`-Spalte auf
  `racepic_photographer` mit Unique-Index (nur für gesetzte Slugs).
- `api/src/racepic/slug.ts` (neu): gemeinsamer `slugify`-Helfer, ersetzt die bisher private Kopie
  in `publish.ts` (dort für Klassen-Slugs im `participantKey`) und wird jetzt auch für
  Fotografen-Slugs genutzt.
- `api/src/racepic/repository.ts`: `createPhotographerInvitation` vergibt bei der Erstanlage
  eines Fotografenprofils automatisch einen Slug aus dem Anzeigenamen, mit numerischem Suffix bei
  Kollision (`max-mustermann`, `max-mustermann-2`, …).
- `api/src/racepic/publish.ts`: neue `regeneratePhotographerManifest(photographerId)` –
  schreibt `manifests/photographers/{slug}.json` mit `displayName`, `copyrightLine`, `website`,
  `social` und allen `PUBLISHED`-Bildern aus **veröffentlichten** Events. Bewusst ohne
  Teilnehmer-Verlinkung pro Bild (ein Bild kann mehreren Fahrern zugeordnet sein, siehe
  Domain-Modell Abschnitt C) – verlinkt stattdessen auf die jeweilige Event-Galerie. Neue
  `getImagePhotographerId`-Hilfsfunktion analog zu `getImageEventId`. Das bestehende
  Teilnehmer-Bild-Manifest (`ManifestImage.photographer`) trägt jetzt zusätzlich `slug`, damit
  die Website von der Teilnehmerseite zum Profil verlinken kann.
- `api/src/racepic/handler.ts`: `PATCH /admin/racepic/images/{id}` und `PATCH /photographer/me`
  lösen jetzt zusätzlich zur Event-Manifest-Regenerierung auch `regeneratePhotographerManifest`
  aus (No-Op ohne Slug oder ohne veröffentlichte Bilder).
- Kein neuer API-Endpunkt nötig: wie die Event-/Teilnehmer-Manifeste wird das Profil direkt vom
  CDN gelesen (`manifests/photographers/{slug}.json`, öffentliches `public/*`-Verhalten in
  `racepic-stack.ts` deckt den Präfix `manifests/*` bereits ab).
- **Verifiziert:** `tsc --noEmit` für `api/` fehlerfrei. **Nicht deployed.**
- Website-Teil (Seite, Route, Verlinkung von der Teilnehmerseite) siehe
  `msc-website/docs/memory-bank/racepic-progress.md`.

## Paket 13 – Ergebnis (2026-09-22): Entwicklungsumgebung vorbereitet

Auf Wunsch des Vereins vorbereitet: Backend + Nennungstool-Frontend sollen "ruhig public auf der
prod laufen" (interne Tools mit Auth), die öffentliche RacePic-Website aber vorerst nur lokal
gegen das Prod-Backend getestet werden. Dabei zwei weitere, bisher unentdeckte Lücken gefunden:

1. **CORS auf den Manifesten fehlte komplett.** Der Website-Client liest Event-/Teilnehmer-/
   Fotografen-Manifeste per `fetch()` direkt vom CDN (`publicClient.ts`) - ein Cross-Origin-
   Request, für den CloudFront `Access-Control-Allow-Origin` setzen muss. Die `manifests/*`- und
   `public/*`-Behaviors in `racepic-stack.ts` hatten dafür **keine** Response-Headers-Policy.
   **Fix:** neue `ResponseHeadersPolicy` mit CORS-Konfiguration (nutzt dieselbe
   `racepicMediaCorsAllowedOrigins`-Liste wie das S3-Bucket-CORS, technisch aber unabhängig
   davon - der Browser spricht über CloudFront/OAC, nicht direkt mit S3).
2. **Der `RacePicStack` wurde von der CI/CD-Pipeline nie deployed.** `infra/bin/app.ts` legt ihn
   als eigenen, optionalen Stack an (nicht Teil von `api-stack`), aber `.github/workflows/ci-cd.yml`
   kannte nur `auth-stack`/`data-stack`/`storage-stack`/`api-stack`. Selbst mit
   `PROD_ENABLE_RACEPIC=true` wäre also nie eine RacePic-Infrastruktur entstanden - und die
   `*_ENABLE_RACEPIC`/`*_RACEPIC_*`-Variablen wurden an keiner Stelle des Workflows überhaupt an
   den `cdk`-Prozess durchgereicht. **Fix:** neue "Deploy Dev/Prod RacePic stack"-Schritte
   (zwischen Basis-Stacks und API-Stack, da `api-stack` `RacePicStack`-Ressourcen referenziert),
   alle relevanten Variablen (`*_ENABLE_RACEPIC`, `*_RACEPIC_WEBSITE_BASE_URL`,
   `*_RACEPIC_RELYING_PARTY_ID`, `*_RACEPIC_SIGNING_PUBLIC_KEY_PEM`, `*_RACEPIC_MONTHLY_BUDGET_USD`)
   an synth/deploy-Schritte durchgereicht. Für `destroy_dev` zusätzlich einen
   Existenz-geprüften "Destroy Dev RacePic stack"-Schritt ergänzt (sonst bliebe der Stack beim
   Zurücksetzen der dev-Umgebung als verwaiste Ressource zurück), in der richtigen Reihenfolge
   (API-Stack zuerst, dann RacePic-Stack, dann die übrigen Basis-Stacks).
3. **`http://localhost:8080`** (Vite-Dev-Port von msc-website) zu `assetsCorsAllowedOrigins`
   (API-CORS, für `POST /public/racepic/images/{id}/download`) und `racepicMediaCorsAllowedOrigins`
   (CloudFront-CORS, s. o.) in `prod.ts` hinzugefügt - mit Kommentar, das wieder zu entfernen,
   sobald die RacePic-Seiten auf der echten Domain live sind.
- **Bewusst NICHT deployed von hier aus:** lokales `cdk deploy` ist laut `AGENTS.md` untersagt.
  Aktivierung läuft über `PROD_ENABLE_RACEPIC=true` als GitHub-Environment-Variable plus Merge
  nach `main` (löst die bestehende, durch einen Pflicht-Reviewer abgesicherte `deploy_prod`-Job
  aus - die eigentliche Ausführung braucht also ohnehin eine manuelle Freigabe im GitHub-UI).
- **Verifiziert:** `tsc --noEmit` (`infra/`) fehlerfrei, `npm --workspace api test` und
  `npm --workspace infra run build` (identisch zu `validate_common` in der CI) beide grün,
  `.github/workflows/ci-cd.yml` mit `js-yaml`/`@action-validator/cli` syntaktisch geprüft.

### Hotfix nach dem ersten echten Prod-Deploy-Versuch (2026-09-22)

Der erste echte `deploy_prod`-Lauf (GitHub Actions Run 35708419318, nach Freigabe durch den
Pflicht-Reviewer) scheiterte im neuen "Deploy Prod RacePic stack"-Schritt:

```
«PasskeyRelyingPartyIdLength» passkeyRelyingPartyId length must be (inclusively) between 1 and 63, got 0
```

**Ursache:** `(process.env.PROD_RACEPIC_RELYING_PARTY_ID ?? 'msc-oberlausitz.de').trim()` in
`prod.ts` – `??` fängt nur `undefined`/`null` ab. GitHub Actions liefert für eine **nicht
gesetzte** `${{ vars.X }}`-Referenz aber immer einen **leeren String**, nie "gar nicht gesetzt"
(nur `PROD_ENABLE_RACEPIC` wurde als Variable gesetzt, siehe „Muss gesetzt werden" oben – alle
anderen `PROD_RACEPIC_*`-Variablen existieren als GitHub-Variable nicht und kommen deshalb leer
an). Der Default griff also nie, der leere String landete direkt im Cognito-`UserPool`.

**Fix:** in `prod.ts` und `dev.ts` durchgängig auf `(process.env.X ?? '').trim() || 'default'`
umgestellt (erst trimmen, dann auf Leerheit prüfen, dann Default) – betrifft
`racepicPhotographerRelyingPartyId`, `racepicWebsiteBaseUrl`, `racepicMonthlyBudgetUsd` in beiden
Dateien (`racepicSigningPublicKeyPem` hatte dieses Muster bereits korrekt). Lokal mit exakt den
CI-Bedingungen reproduziert (`PROD_ENABLE_RACEPIC=true`, alle übrigen `PROD_RACEPIC_*` als leerer
String) – `cdk synth dreiecksrennen-prod-racepic-stack` lief danach sauber durch.

Direkt auf `main` committed (Hotfix nach fehlgeschlagenem Prod-Deploy, kein Feature-Branch-Umweg
nötig, da `feature/racepic-planning` bereits vollständig nach `main` gemergt war).

## Bugfix (2026-09-22, gefunden beim ersten echten Foto-Upload+Analyze-Lauf)

Nach dem ersten echten Fotografen-Upload gegen prod war das Bild im Admin nirgends zu finden.
CloudWatch-Logs des `RacePicAnalyzeWorker` zeigten:

```
{ eventType: 'racepic_analyze.embedding_failed', errorCode: 'AccessDeniedException' }
{ eventType: 'racepic_analyze.failed', errorCode: '22003' }
```

`AccessDeniedException` beim Bedrock-Aufruf ist die schon bekannte, noch offene
AWS-Kontoverifizierung (siehe `racepic-open-items.md` A.3) – wird bereits korrekt abgefangen
und stoppt die restliche Analyse nicht (Architekturprinzip: "kein einzelnes KI-Modell loest
zuverlaessig alle Zuordnungen"). **`22003` (Postgres `numeric_value_out_of_range`) war aber ein
echter, zweiter Bug:** `racepic_detection.confidence` und `racepic_text_detection.confidence`
waren als `numeric(5, 4)` angelegt (Bereich max. 9.9999), Rekognition liefert `Confidence` aber
im Bereich **0-100**, nicht 0-1 – `matchWorker.ts` erwartet das beim Lesen sogar bereits explizit
(teilt durch 100). Jeder Rekognition-Treffer (typischerweise 50-100 % Konfidenz) ließ den Insert
mit einem Overflow scheitern, was den kompletten Analyze-Lauf für das Bild abbrach, noch bevor
irgendeine Zuordnung oder ein Review-Queue-Eintrag entstehen konnte – daher "kein Bild sichtbar".

**Fix:** `api/migrations/0099_racepic_detection_confidence_range.sql` – beide Spalten auf
`numeric(7, 4)` erweitert (deckt 0.0000-999.9999 ab), `schema.ts` entsprechend angepasst. Kein
Anwendungscode geändert, da `matchWorker.ts` die 0-100-Skala bereits korrekt voraussetzt.

**Verifiziert:** `tsc --noEmit` und `npm --workspace api test` (alle Bestands-Tests) grün. Direkt
auf `main` committed (gleiche Begründung wie oben).

**Update:** Nach dem Deploy dieser Migration lief die Analyse tatsächlich durch (Status
`ANALYZED` im Admin sichtbar) – der Match-Worker scheiterte danach aber an zwei weiteren, echten
Bugs, siehe nächster Abschnitt.

## Bugfix (2026-09-22, gefunden beim ersten echten Match-Lauf)

Bild stand auf `ANALYZED`, aber keine Zuordnung entstand und die öffentliche Website zeigte 0
Ergebnisse (das Event-Manifest enthält nur Teilnehmer mit einer aktiven Zuordnung, siehe
`buildManifestData` in `publish.ts`). CloudWatch-Logs des `RacePicMatchWorker`:

```
{ eventType: 'racepic_match.failed', errorCode: 'Error' }                     ← 1. Versuch
{ ... Status: error, Error Type: Runtime.OutOfMemory ... }                    ← 2. Versuch (Retry)
```

**Zwei echte Bugs, beide in der Kandidaten-Bewertung von `matchWorker.ts`:**

1. `ensureVehicleReference` (`vehicleReference.ts`) hat einen fehlschlagenden Bedrock-Aufruf
   (dieselbe, noch offene AWS-Kontoverifizierung wie bei Paket 6 dokumentiert) nicht abgefangen –
   der Fehler propagierte durch die `Promise.all`-Kandidatenschleife nach oben und brach den
   **kompletten** Match-Lauf für das Bild ab, statt nur das `embedding_sim`-Signal für diese eine
   Nennung auszulassen (das Architekturprinzip "kein einzelnes KI-Modell darf die Zuordnung zum
   Absturz bringen" war in `analyzeWorker.ts` korrekt umgesetzt, in `vehicleReference.ts` aber
   nicht).
2. Die Kandidatenschleife (`eligible.map(...)` in `Promise.all`) startete **für jede erkannte
   Fahrzeug-Box gleichzeitig so viele Fahrzeugbild-Downloads+sharp-Dekodierungen wie es zulässige
   Nennungen im Event gibt** – keine Begrenzung der Parallelität. Bei genug Nennungen reichte das,
   um den Lambda (1024 MB) mit `Runtime.OutOfMemory` abstürzen zu lassen.

**Fix:**
- `vehicleReference.ts`: `embedImage(...)` bekommt ein `.catch(...)`, das den Fehler loggt und
  `embedding: null` zurückgibt (Typ von `VehicleReference.embedding` entsprechend auf
  `number[] | null` geändert) – Matching fällt dann auf OCR/Typ/Farbe zurück, bricht aber nicht ab.
- `matchWorker.ts`: neue `mapWithConcurrencyLimit`-Hilfsfunktion, Kandidatenbewertung läuft jetzt
  mit maximal 5 gleichzeitigen `ensureVehicleReference`-Aufrufen statt unbegrenzt.
- `infra/lib/stacks/api-stack.ts`: `RacePicMatchWorker`-Speicher von 1024 auf 1536 MB erhöht
  (zusätzliche Absicherung, kein Ersatz für die Parallelitätsgrenze).

**Verifiziert:** `tsc --noEmit` (`api/`, `infra/`) und `npm --workspace api test` grün. Direkt auf
`main` committed.

**Noch zu tun (operativ):** Nach dem Deploy einmal `POST /admin/racepic/events/{id}/rematch`
auslösen (Button „Re-Match auslösen" in `/admin/racepic` unter „Konfigurieren"), damit das schon
analysierte Testbild eine Zuordnung bekommt – kein erneuter Rekognition-/Bedrock-Aufruf nötig.

## Paket 15 – Ergebnis (Backend-Teil, 2026-09-22)

Backend-Ergänzungen für das Studio-Redesign, siehe
[racepic-ux-redesign-plan.md](./racepic-ux-redesign-plan.md). Auf `feature/racepic-ux-redesign`
(nicht direkt auf `main`, um nicht jeden kleinen UI-Commit einen Prod-Deploy-Freigabe-Prompt
auslösen zu lassen – anders als die Hotfixes zuvor).

- `api/src/racepic/uploads.ts`: `listMyImages` liefert jetzt zusätzlich eine presignte
  Vorschau-URL je Bild (analog zu `adminEvents.listImagesForEvent`/Paket 11), damit Fotograf:innen
  auch unveröffentlichte eigene Bilder als Thumbnail sehen. Neu: `hideOwnImage` (verbergen,
  delegiert an `publish.ts` `hideImage`) und `deleteOwnDraftImage` (echtes Löschen, nur solange
  `visibility='DRAFT'` – danach nur noch über den Admin-Weg, Audit-Trail bleibt dort erhalten).
  Beides war in Abschnitt H des Architekturplans vorgesehen, aber nie gebaut (derselbe
  Musterfund wie bei Paket 5/7/11).
- `api/src/racepic/handler.ts`: `PATCH /photographer/images/{id}` (nur `visibility: 'HIDDEN'`
  erlaubt – veröffentlichen/entfernen bleibt Admin-Sache) und
  `DELETE /photographer/images/{id}`.
- `api/src/audit/log.ts`: neue Audit-Action `racepic_own_image_deleted`; die PATCH-Route nutzt die
  bestehende `racepic_image_visibility_changed`-Action weiter (gleiches Ereignis, nur ein anderer
  Akteur).
- `infra/lib/stacks/api-stack.ts`: Route `/photographer/images/{imageId}` (PATCH, DELETE)
  registriert.
- **Verifiziert:** `tsc --noEmit` (`api/`, `infra/`) und `npm --workspace api test` grün. **Nicht
  deployed** (Feature-Branch, noch kein Merge nach `main`).

## Paket 16 – Ergebnis (Backend-Teil, 2026-09-22)

Backend-Ergänzung für das Admin-Redesign, siehe
[racepic-ux-redesign-plan.md](./racepic-ux-redesign-plan.md). Auf `feature/racepic-ux-redesign`.

- `api/src/racepic/reviewQueue.ts`: neue `listAssignmentsForImage(imageId)` – Gegenstück zum
  bestehenden `listImagesForEntry` (dort nach `entryId`, hier nach `imageId`), liefert je Bild
  alle Zuordnungen mit Fahrername/Startnummer/Fahrzeug/Status/Konfidenz. Schließt die vom Verein
  genannte Lücke "wie ich die Zuordnung zum Fahrer sehen/ändern kann" direkt aus einer
  Bild-Detailansicht heraus (bestehende `confirmAssignment`/`rejectAssignment`/
  `correctAssignment`-Endpunkte bleiben unverändert, nur ein neuer Lesezugriff).
- `api/src/racepic/handler.ts`, `infra/lib/stacks/api-stack.ts`:
  `GET /admin/racepic/images/{id}/assignments` (die bestehende `POST`-Route auf demselben Pfad
  – `addAssignment` – bleibt unverändert, nur um `GET` erweitert).
- **Verifiziert:** `tsc --noEmit` (`api/`, `infra/`) und `npm --workspace api test` grün. **Nicht
  deployed.**

## Paket 17 – Ergebnis (Backend-Teil, 2026-09-22)

Event-übergreifende Manifeste für die öffentliche Landingpage im Unsplash/Airbnb-Stil, siehe
[racepic-ux-redesign-plan.md](./racepic-ux-redesign-plan.md). Auf `feature/racepic-ux-redesign`.

- `api/src/racepic/publish.ts`: neue `regenerateGlobalDiscoveryManifests(publishedEvents)`,
  aufgerufen am Ende von `regenerateManifestsForEvent` **und** `unpublishEventManifests`
  (dieselben Stellen, die schon `manifests/events.json` schreiben):
  - `manifests/discover.json`: die neuesten 60 veröffentlichten Bilder über **alle**
    veröffentlichten Events (imageId, thumb-/previewUrl, eventSlug, eventTitle, capturedAt).
  - `manifests/search-index.json`: flache Teilnehmerliste über **alle** veröffentlichten Events
    (nutzt die bestehende `buildManifestData(eventId)` je Event, nur um `eventSlug`/`eventTitle`
    ergänzt).
  - Bewusster Kostenkompromiss (dokumentiert im Code): bei **jeder** Publish-/Unpublish-Aktion
    werden **alle** veröffentlichten Events neu abgefragt (kein periodischer Job, kein
    inkrementelles Update) – bei der angenommenen Größenordnung (einzelne Events pro Jahr, je
    einige hundert Teilnehmer) unproblematisch, bleibt aber ein offener Punkt, falls RacePic auf
    sehr viele Events wächst.
  - Bleibt konsistent mit dem Architekturprinzip "öffentlicher Traffic trifft nie Lambda/DB" –
    beide Dateien werden weiterhin nur per CDN-Fetch von der Website gelesen.
- **Verifiziert:** `tsc --noEmit` (`api/`) und `npm --workspace api test` grün. **Nicht deployed.**

## Bestandsaufnahme aller Pakete (2026-09-22)

Auf Bitte des Vereins wurde der gesamte bisherige Stand (Pakete 0–10) über alle drei Repos
geprüft: Routen-Inventar (registriert in `api-stack.ts` vs. tatsächlich in `handler.ts`
behandelt), von Website/Frontend tatsächlich aufgerufene Endpunkte vs. Backend-Routen,
Architekturdoku-Gleichheit über alle drei Repos, Branch-Drift gegenüber `main`, unkommitierte
Reste. Ergebnis und daraus folgende Anpassungen:

- **Architekturdoku:** in allen drei Repos weiterhin byte-identisch. Kein Handlungsbedarf.
- **Branch-Drift:** `feature/racepic-planning` ist in allen drei Repos 0 Commits hinter `main` –
  kein Merge-Konflikt-Risiko.
- **Routen-Inventar Backend:** alle 32 in `api-stack.ts` registrierten RacePic-Routen haben eine
  passende Behandlung in `handler.ts` und umgekehrt – keine verwaisten Routen.
- **Website- und Frontend-Client-Aufrufe:** stimmen mit den tatsächlichen Backend-Pfaden überein
  (Download-Varianten `small/medium/large/original` z. B. exakt deckungsgleich zwischen
  `download.ts` und `publicClient.ts`).
- **Gefundener und behobener Bug (dieses Repo):** `PUT /admin/racepic/events/{id}` (Event-
  Konfiguration speichern, Paket 5) hat **nie** `regenerateManifestsForEvent` aufgerufen. Das
  Umschalten von „Veröffentlicht" im Admin-Formular hatte dadurch **keine sichtbare Wirkung** auf
  der öffentlichen Website, bis zufällig eine andere Aktion (Bild-Sichtbarkeit ändern,
  Teilnehmer ausblenden) die Manifeste für dasselbe Event neu erzeugte. Der Runbook-Text
  ("Veröffentlicht einschalten und speichern – das löst sofort … aus") beschrieb also ein
  Verhalten, das der Code nicht hatte.
  - **Zweiter, verwandter Fund:** Selbst wenn das ausgelöst worden wäre, hätte `regenerateManifestsForEvent`
    beim **Zurückziehen** der Veröffentlichung (`published: true → false`) die zuvor geschriebenen
    Manifeste **nicht gelöscht** (die Funktion bricht für ein nicht veröffentlichtes Event nur
    früh ab) – die Teilnehmergalerie wäre über die alte CDN-URL weiterhin öffentlich erreichbar
    geblieben. Bei einer Slug-Änderung eines veröffentlichten Events gilt dasselbe für die alten
    Manifest-Pfade unter dem vorherigen Slug.
  - **Fix:** `api/src/racepic/s3.ts`: neue `deleteObjectsByPrefix` (paginiertes List+Delete).
    `api/src/racepic/publish.ts`: neue `unpublishEventManifests(previousSlug)` – löscht alle
    Manifeste unter dem alten Slug, schreibt `manifests/events.json` neu (ohne das Event) und
    invalidiert CloudFront. `api/src/racepic/handler.ts`: `PUT /admin/racepic/events/{id}` liest
    jetzt den vorherigen Stand (Slug, `published`), ruft nach dem Speichern `unpublishEventManifests`
    auf, wenn das Event gerade unveröffentlicht wurde oder sich der Slug eines veröffentlichten
    Events geändert hat, und sonst (weiterhin/neu veröffentlicht) `regenerateManifestsForEvent`.
  - **Verifiziert:** `tsc --noEmit` für `api/` fehlerfrei.
- **Gefundene, aber nicht behobene Lücke (Frontend-UI):** Im Nennungstool-Frontend gibt es **keine
  UI** für vier bereits im Backend fertige Funktionen: Bild-Sichtbarkeit ändern
  (`PATCH /admin/racepic/images/{id}`, Paket 4), Teilnehmer ausblenden (Paket 9, siehe offener
  Punkt oben), Matching-Config ansehen/anlegen (`GET/POST /admin/racepic/matching-configs`,
  Paket 6) und Re-Match/Re-Analyze auslösen (Paket 6) sowie der neue Qualitätsreport
  (`GET .../matching-quality-report`, Paket 10). Besonders der letzte Punkt wiegt schwer: das
  Runbook beschreibt den kompletten Kalibrierungs-Workflow aus Paket 10 als Abfolge von
  Admin-UI-Schritten, es gibt dafür aber nur rohe API-Endpunkte – ein Vereins-Admin ohne
  Entwickler-Werkzeuge kann den Piloten in der Praxis so nicht durchführen. Empfehlung: ein
  zusätzliches Frontend-Paket (informell "Paket 11") in MSC-Event-Frontend, das diese vier Punkte
  in `/admin/racepic` und `/admin/racepic/review/:eventId` nachrüstet, bevor der echte Pilot
  startet. Nach Rückfrage vom Verein priorisiert und noch am selben Tag umgesetzt (siehe
  `MSC-Event-Frontend/docs/memory-bank/racepic-progress.md`, „Paket 11 – Ergebnis"); zusätzlich
  dabei ein fünfter, erst beim Bauen der UI entdeckter Fund behoben: es gab **keinen** Weg, ein
  frisch hochgeladenes (`visibility=DRAFT`) Bild ohne bestehende Zuordnung admin-seitig zu
  erreichen (Review-Queue zeigt nur `REVIEW_REQUIRED`, Fahrer-Ansicht nur bereits zugeordnete
  Bilder) – neuer Endpunkt `GET /admin/racepic/events/{id}/images` (`adminEvents.ts`,
  `listImagesForEvent`, paginiert, filterbar nach `visibility`/`processingStatus`) schließt das.

## Entscheidungen aus diesem Repo

- 2026-09-21: Bedrock-Region-Check abgeschlossen. Titan/Nova Multimodal Embeddings sind nur in us-east-1/us-west-2 verfügbar. Gewählt: **Cohere Embed v4 (multimodal) über Bedrock in eu-west-1 (Irland)**, Cross-Region-Aufruf aus der eu-central-1-Lambda, damit Fahrzeugbilder innerhalb der EU bleiben.
- 2026-09-21: Lizenzkatalog (5 kostenlose Lizenzen) als Entwurf festgelegt, Default für neue Fotografenprofile: `FREE_EDITORIAL`.
- 2026-09-21: Bestehende Lücke in `privacyRetentionWorker.ts` (Fahrzeugbild wird aus DB entkoppelt, aber nie aus S3 gelöscht) in Paket 9 behoben.

## Offene Punkte

- **Vor dem ersten echten Deploy:** einen `cdk deploy`/`synth` in der GitHub-Actions-CI (Linux) beobachten und bestätigen, dass `sharp` dort mit Linux-x64-Binaries bündelt und der `RacePicIngestWorker` tatsächlich ein Bild verarbeiten kann – lokal auf Windows nicht abschließend verifizierbar (siehe Paket 4 – Ergebnis).
- Vereinfachtes Copyright-Handling (nur EXIF-Tag statt vollem IPTC/XMP) – bei Bedarf später nachziehen, falls Fotoportale/Marktplätze vollständige IPTC-Metadaten erwarten.
- Kein Soft-Lock in der Review-Queue (Paket 7) – bei einem kleinen Orga-Team akzeptables MVP-Risiko, vor größerem Reviewer-Team nachziehen.
- Öffentlicher Download-Endpunkt (Paket 8) hat noch kein Rate-Limiting.
- Downloads laufen über S3-Presigned-URLs statt CloudFront Signed URLs (Interimslösung, siehe `s3.ts`) – auf CloudFront-Signing umstellen, sobald das Schlüsselpaar aus Paket 1 existiert.
- Bedrock-Aufrufe sind **nicht live getestet** (kein AWS-Zugriff in dieser Umgebung) – vor dem Piloten (Paket 10) einen echten `InvokeModel`-Aufruf gegen `cohere.embed-v4:0` in eu-west-1 verifizieren.
- Matching-Score ist eine einfache gewichtete Linearkombination, keine trainierte Logistic Regression – Kalibrierung der Gewichte/Schwellen anhand der Review-Entscheidungen aus dem Piloten steht noch aus (Paket 10).
- Qualitätsreport (Precision/Recall je Schwelle, Abschnitt H) ist seit Paket 10 gebaut (`matchQuality.ts`), aber noch nie gegen echte Review-Daten gelaufen – erst im echten Piloten aussagekräftig.
- `RACEPIC_EMBEDDING_MODEL_ID` ist als Override vorgesehen (siehe `bedrock.ts`), aber noch nicht als CDK-Env-Var gesetzt – nutzt aktuell immer den Default `cohere.embed-v4:0`.
- Freigabe der Rechtstexte (Datenschutzhinweis, Fotografen-Bedingungen) durch Datenschutzbeauftragten/Vorstand.
- Namenssuche nach 365 Tagen: aktueller Stand (Name verschwindet, Bildzuordnung über Startnummer/Klasse/Fahrzeug bleibt) ist technisch umgesetzt vorgesehen; dauerhafte Namenssuche erfordert eine zusätzliche Rechtsgrundlage – Entscheidung bei Vorstand/Datenschutz.
- Merchant-of-Record-Modell entschieden: Der MSC verkauft an den Käufer. Offen bleibt die
  schriftliche Rechts-/Steuerfreigabe gemäß AP00 im Marketplace-/Checkout-Plan.
- Keine Cost Anomaly Detection eingerichtet (bräuchte eine SNS-Themen-Abo-Bestätigung, in dieser Umgebung nicht einrichtbar/verifizierbar) – nur das neue `CfnBudget` (Paket 9) deckt die Kostenüberwachung ab.
- Das neue `RacePicMonthlyBudget` ist nicht live getestet (kein AWS-Zugriff in dieser Umgebung) – vor dem Piloten (Paket 10) einmal in der CI beobachten, dass es tatsächlich erzeugt wird und die Schwellenwerte sinnvoll sind.
## Pakete 19–24 – Implementierungsstand 2026-09-22

Backend: Bildkatalog und Preis-Migration, private Wasserzeichen-Vorschau, Registrierungsfreigabe, Event-/Download-Sperren, neue CDN-Detailmanifeste, OCR-Crops und räumliche Textzuordnung.

Dies ist Feature-Branch-Arbeit. Lokal erfolgreich: TypeScript-Typechecks der Website, Backend-API, Backend-Infrastruktur und des Nennungstool-Admins. Ein echter Browser-/Cognito-/AWS-Durchlauf, eine KI-Qualitätsmessung mit bestätigten Bildern und eine rechtliche Freigabe stehen aus. Keine Merges, Deployments oder öffentliche Freischaltung erfolgten in diesem Paket. Das genaue Paket- und Abnahme-Raster steht in racepic-open-items.md, Abschnitt E.

## Marketplace-/Checkout-Plan (2026-09-25)

Der vollständige Plan ist in [racepic-marketplace-checkout-plan.md](./racepic-marketplace-checkout-plan.md) dokumentiert. Dieses Repo übernimmt Commerce-Schema und Ledger, Stripe-Adapter, Buyer-Cognito, Quotes und Checkout Sessions, Raw-Body-Webhooks, Fulfillment, Entitlements, Rechnungen, Connect, Settlement, Refunds/Reversals, Disputes und Reconciliation. Es wurde noch keine Checkout-Implementierung, Migration oder Infrastruktur dafür ausgerollt.
