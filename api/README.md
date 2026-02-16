# API Lambda Service (Phase 2)

Minimaler TypeScript-Lambda-Handler mit Datenbankzugriff (Postgres via Drizzle):

- `GET /health` → `{ "ok": true, "stage": "dev" }`
- `GET /admin/ping` → `{ "ok": true, "sub": "...", "groups": ["admin"] }`
- `GET /admin/db/ping` → `{ "ok": true, "database": "...", "now": "..." }`
- `GET /admin/db/schema` → `{ "ok": true, "tables": ["..."] }`
- `POST /admin/mail/queue` → Outbox-Einträge für Sammelmails
- `POST /admin/mail/lifecycle/queue` → Statusbasierte Mail pro Nennung/Fahrer
- `POST /admin/mail/broadcast/queue` → Broadcast-Mail mit Filtern
- `POST /admin/payment/reminders/queue` → Outbox-Einträge für Zahlungserinnerungen
- `POST /admin/documents/waiver` → PDF Haftverzicht generieren
- `POST /admin/documents/tech-check` → PDF Technische Abnahme generieren
- `GET /admin/documents/:id/download` → presigned Download-URL
- `PATCH /admin/entries/:id/checkin/id-verify` → ID-Verifikation am Check-in setzen

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
