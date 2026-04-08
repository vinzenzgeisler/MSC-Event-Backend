# API Lambda Service (Phase 2)

Minimaler TypeScript-Lambda-Handler mit Datenbankzugriff (Postgres via Drizzle):

- `GET /health` → `{ "ok": true, "stage": "dev" }`
- `GET /admin/ping` → `{ "ok": true, "sub": "...", "groups": ["admin|editor|viewer"] }`
- `GET /admin/db/ping` → `{ "ok": true, "database": "...", "now": "..." }`
- `GET /admin/db/schema` → `{ "ok": true, "tables": ["..."] }`
- `POST /admin/mail/queue` → Outbox-Einträge für Sammelmails
- `GET /admin/events` / `POST /admin/events` → Event-Liste + Event anlegen
- `PATCH /admin/events/:id` → Event-Metadaten anpassen (solange offen)
- `GET /admin/events/:id|current` → beliebiges oder aktuelles Event lesen
- `POST /admin/events/:id/activate|close|archive` → Event-Lifecycle steuern
- `GET|POST /admin/events/:id/classes` + `PATCH|DELETE /admin/classes/:id` → Klassenverwaltung
- `POST /admin/mail/lifecycle/queue` → Statusbasierte Mail pro Nennung/Fahrer
- `POST /admin/mail/broadcast/queue` → Broadcast-Mail mit Filtern
- `POST /admin/payment/reminders/queue` → Outbox-Einträge für Zahlungserinnerungen
- `PUT /admin/events/:id/pricing-rules` → Preisregeln setzen
- `POST /admin/events/:id/invoices/recalculate` → Rechnungen neu berechnen (Snapshot)
- `GET /admin/invoices` → Rechnungen listen
- `POST|GET /admin/invoices/:id/payments` → Zahlungen erfassen/listen
- `POST /admin/documents/waiver` → PDF Haftverzicht generieren
- `POST /admin/documents/tech-check` → PDF Technische Abnahme generieren
- `POST /admin/documents/waiver/batch` → Batch-Haftverzicht generieren
- `POST /admin/documents/tech-check/batch` → Batch-Technische-Abnahme generieren
- `GET /admin/documents/:id/download` → presigned Download-URL
- `GET /admin/documents/entry/:entryId/download?eventId=...&type=waiver|tech_check` → Dokument on-demand + Download
- `POST /admin/exports/entries` → CSV-Export erstellen
- `GET /admin/exports?eventId=...` → Export-Historie je Event
- `GET /admin/exports/:id` → Export-Status lesen
- `GET /admin/exports/:id/download` → presigned Export-Download
- `GET /admin/entries` → Entry-Liste mit Filtern
- `GET /admin/entries/:id` → Entry-Detail inkl. Audit-/History-Feldern
- `PATCH /admin/entries/:id/status` → Annahmestatus ändern (+ optional Lifecycle-Mail)
- `PATCH /admin/entries/:id/tech-status` → Technische-Abnahme-Status setzen
- `GET /admin/checkin/entries` → Check-in-Liste/Suche
- `PATCH /admin/entries/:id/checkin/id-verify` → ID-Verifikation am Check-in setzen
- `GET /admin/mail/outbox` → Outbox-Statusliste (queued/sent/failed)
- `POST /admin/mail/outbox/:id/retry` → fehlgeschlagene Outbox-Mail erneut einplanen

Öffentliche Registrierung:

- `POST /public/events/:id/entries` → Nennung anlegen (unverified)
- `POST /public/entries/:id/verify-email` → E-Mail-Verifikation abschließen
- `GET /public/events/current` → aktuelles Event + Klassen für Anmeldeformular
- `POST /public/events/:id/start-number/validate` → Startnummer-Prüfung vor Submit
- `POST /public/uploads/vehicle-image/init|finalize` → Presigned Upload-Flow für Fahrzeugbilder

## Voraussetzungen

- Node.js 20+
- npm 10+

## Installation

```bash
npm install
```

## Lokaler Build-Test (ohne AWS)

```bash
npm run build
node -e "const {handler}=require('./dist/handler'); handler({requestContext:{http:{method:'GET',path:'/health'}}}).then(console.log)"
```

## Drizzle Migrations

Für lokale Migrationen wird `DATABASE_URL` benötigt:

```bash
set DATABASE_URL=postgres://user:pass@localhost:5432/dbname
npm run db:migrate
```

Hinweis: `db:migrate` verwendet einen SQL-Runner (`api/migrations/*.sql`) und benoetigt kein `drizzle-kit` Meta-Journal.
Falls du explizit den Drizzle-Migrator nutzen willst: `npm run db:migrate:drizzle`.

## Hinweis

Die Lambda holt DB-Verbindungsdaten aus Secrets Manager (`DB_SECRET_ARN`) und nutzt die RDS-Postgres Instanz aus Phase 1.

## Auth-Vertrag

Die API erwartet ein externes JWT Bearer Token (Cognito Authorizer).  
Login/Refresh/Hosted-UI sind nicht Teil dieser API und erfolgen außerhalb.

Unterstützte Rollen (aus `cognito:groups`): `admin`, `editor`, `viewer`.

Admin-Haertung:

- Rollenpruefung erfolgt weiterhin ueber `cognito:groups`.
- Aktuell ist keine serverseitige MFA-Pflicht aktiv.

Unterstützte Modi:

- Passwort-Auth (klassisch)
- IAM DB Auth (`DB_IAM_AUTH=true`) mit kurzlebigem Token pro Verbindungsaufbau

Relevante Runtime-Variablen:

- `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_REGION`
- `DB_IAM_AUTH`
- `DB_SSL`, `DB_SSL_REJECT_UNAUTHORIZED`, optional `DB_SSL_CA_PATH`

## Mail (SES Sandbox)

Für den Versand werden benötigt:

- `SES_FROM_EMAIL` (verifizierte Absenderadresse)

Der Versand läuft über Outbox + Worker (`emailWorker`) und einen Scheduler (`paymentReminderScheduler`).
