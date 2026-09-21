<!-- Nur die Architektur (racepic-architecture.md) wird 1:1 in allen 3 Repos synchron gehalten. Diese Fortschrittsdatei ist repo-spezifisch und listet nur die Arbeitspakete, die in MSC-Event-Backend passieren. -->
# RacePic – Fortschritt (MSC-Event-Backend)

**Stand:** 2026-09-21 · Architektur: [racepic-architecture.md](./racepic-architecture.md) · Lizenzen: [../racepic/licenses.md](../racepic/licenses.md) · Rechtstexte: [../privacy/racepic-legal-texts-v1.md](../privacy/racepic-legal-texts-v1.md) · Retention: [../privacy/racepic-retention-addendum.md](../privacy/racepic-retention-addendum.md)

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
| 6 | KI-Pipeline: Referenz-Job, Analyze-Worker, Matcher, Config, Audit | offen | |
| 9 | Datenschutz & Betrieb: Retention-Erweiterung (inkl. S3-Löschung Fahrzeugbild), Ausblenden-Funktion, Budgets, Runbook | offen | Siehe `racepic-retention-addendum.md` |
| 10a | Pilot 12. OLD 2026 (Backend-Teil): Seed-Daten, Kalibrierung Matching-Schwellen | offen | |

Admin-Endpunkte für die Review-Queue (Abschnitt H) werden ebenfalls hier implementiert, auch wenn die UI dazu in MSC-Event-Frontend liegt (Paket 5/7 dort).

## Paket 1 – Ergebnis (2026-09-21)

- `api/migrations/0095_racepic_core.sql`: alle `racepic_*`-Tabellen (Event-Aktivierung, Photographer, Invitation, License mit Seed der 5 Lizenzen aus Paket 0, UploadBatch/Upload, Image/ImageVariant, AiAnalysis, Detection/TextDetection, MatchCandidate, Assignment/AssignmentEvent, MatchingConfig, VehicleReference mit `pgvector`, ProcessingStep). Referenziert `event`/`entry`/`vehicle`, dupliziert keine Teilnehmerdaten.
- `api/src/db/schema.ts`: passende Drizzle-Definitionen ergänzt (gleiche Namen/Typen wie die Migration).
- `infra/lib/stacks/racepic-stack.ts` (neu): Media-Bucket (privat, Lifecycle-Regeln), CloudFront-Distribution mit OAC (Default-Behavior verlangt Signed-URLs, `manifests/*` und `public/*` sind explizit öffentlich), SQS-Queues ingest/analyze/match je mit DLQ + CloudWatch-Alarm, Photographer-Cognito-Pool (Email-OTP + Passkey, `ALLOW_USER_AUTH`).
  - **Offen vor Go-Live:** Signing-Keypair für CloudFront (`racepicSigningPublicKeyPem`) ist noch nicht gesetzt – bis dahin sind `originals/`/`derived/` zwar privat (Bucket + OAC), aber noch nicht per Signed-URL geschützt. Kein Downloadendpunkt darf vorher live gehen (Kommentar direkt im Stack-Code).
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

## Entscheidungen aus diesem Repo

- 2026-09-21: Bedrock-Region-Check abgeschlossen. Titan/Nova Multimodal Embeddings sind nur in us-east-1/us-west-2 verfügbar. Gewählt: **Cohere Embed v4 (multimodal) über Bedrock in eu-west-1 (Irland)**, Cross-Region-Aufruf aus der eu-central-1-Lambda, damit Fahrzeugbilder innerhalb der EU bleiben.
- 2026-09-21: Lizenzkatalog (5 kostenlose Lizenzen) als Entwurf festgelegt, Default für neue Fotografenprofile: `FREE_EDITORIAL`.
- 2026-09-21: Bestehende Lücke in `privacyRetentionWorker.ts` (Fahrzeugbild wird aus DB entkoppelt, aber nie aus S3 gelöscht) wird in Paket 9 behoben.

## Offene Punkte

- **Vor dem ersten echten Deploy:** einen `cdk deploy`/`synth` in der GitHub-Actions-CI (Linux) beobachten und bestätigen, dass `sharp` dort mit Linux-x64-Binaries bündelt und der `RacePicIngestWorker` tatsächlich ein Bild verarbeiten kann – lokal auf Windows nicht abschließend verifizierbar (siehe Paket 4 – Ergebnis).
- Vereinfachtes Copyright-Handling (nur EXIF-Tag statt vollem IPTC/XMP) – bei Bedarf später nachziehen, falls Fotoportale/Marktplätze vollständige IPTC-Metadaten erwarten.
- Freigabe der Rechtstexte (Datenschutzhinweis, Fotografen-Bedingungen) durch Datenschutzbeauftragten/Vorstand.
- Namenssuche nach 365 Tagen: aktueller Stand (Name verschwindet, Bildzuordnung über Startnummer/Klasse/Fahrzeug bleibt) ist technisch umgesetzt vorgesehen; dauerhafte Namenssuche erfordert eine zusätzliche Rechtsgrundlage – Entscheidung bei Vorstand/Datenschutz.
- Rechtliches Seller-Modell (A/B) vor Marketplace-Implementierung klären.
