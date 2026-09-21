<!-- Nur die Architektur (racepic-architecture.md) wird 1:1 in allen 3 Repos synchron gehalten. Diese Fortschrittsdatei ist repo-spezifisch und listet nur die Arbeitspakete, die in MSC-Event-Backend passieren. -->
# RacePic – Fortschritt (MSC-Event-Backend)

**Stand:** 2026-09-21 · Architektur: [racepic-architecture.md](./racepic-architecture.md) · Lizenzen: [../racepic/licenses.md](../racepic/licenses.md) · Rechtstexte: [../privacy/racepic-legal-texts-v1.md](../privacy/racepic-legal-texts-v1.md) · Retention: [../privacy/racepic-retention-addendum.md](../privacy/racepic-retention-addendum.md)

Alle Arbeit läuft im Branch `feature/racepic-planning` (noch nicht nach `main` gemergt).

## Arbeitspakete in diesem Repo

| # | Paket | Status | Notiz |
|---|---|---|---|
| 0 | Entscheidungen (Datenschutztexte, Lizenztexte, Bedrock-Region) | **erledigt (Entwurf)** | Texte liegen in `docs/racepic/licenses.md` und `docs/privacy/racepic-*.md`; Freigabe durch Datenschutzbeauftragten/Rechtsberatung steht noch aus |
| 1 | Fundament: Migrationen `racepic_*`, `RacePicStack` (Bucket, CloudFront, SQS, Photographer-Pool), `RacePicApiHandler`, Permissions | **erledigt (ungedeployed)** | siehe „Paket 1 – Ergebnis“ unten |
| 2a | Identität (Backend-Teil): Photographer-Pool, Einladung/Claim-API, Profil-API, `requireStepUp` | offen | Website-Teil (Studio-UI) siehe msc-website |
| 3a | Upload (Backend-Teil): Batch- und Multipart-Endpoints, Reconciler | offen | Website-Teil (Uppy-UI) siehe msc-website |
| 4 | Ingest- und Publish-Worker: Varianten, EXIF, Manifeste | offen | |
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

## Entscheidungen aus diesem Repo

- 2026-09-21: Bedrock-Region-Check abgeschlossen. Titan/Nova Multimodal Embeddings sind nur in us-east-1/us-west-2 verfügbar. Gewählt: **Cohere Embed v4 (multimodal) über Bedrock in eu-west-1 (Irland)**, Cross-Region-Aufruf aus der eu-central-1-Lambda, damit Fahrzeugbilder innerhalb der EU bleiben.
- 2026-09-21: Lizenzkatalog (5 kostenlose Lizenzen) als Entwurf festgelegt, Default für neue Fotografenprofile: `FREE_EDITORIAL`.
- 2026-09-21: Bestehende Lücke in `privacyRetentionWorker.ts` (Fahrzeugbild wird aus DB entkoppelt, aber nie aus S3 gelöscht) wird in Paket 9 behoben.

## Offene Punkte

- Freigabe der Rechtstexte (Datenschutzhinweis, Fotografen-Bedingungen) durch Datenschutzbeauftragten/Vorstand.
- Namenssuche nach 365 Tagen: aktueller Stand (Name verschwindet, Bildzuordnung über Startnummer/Klasse/Fahrzeug bleibt) ist technisch umgesetzt vorgesehen; dauerhafte Namenssuche erfordert eine zusätzliche Rechtsgrundlage – Entscheidung bei Vorstand/Datenschutz.
- Rechtliches Seller-Modell (A/B) vor Marketplace-Implementierung klären.
