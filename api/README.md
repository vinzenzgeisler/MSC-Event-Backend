# API Lambda Service (Phase 2)

Minimaler TypeScript-Lambda-Handler mit Datenbankzugriff (Postgres via Drizzle):

- `GET /health` → `{ "ok": true, "stage": "dev" }`
- `GET /admin/ping` → `{ "ok": true, "sub": "...", "groups": ["admin"] }`
- `GET /admin/db/ping` → `{ "ok": true, "database": "...", "now": "..." }`
- `GET /admin/db/schema` → `{ "ok": true, "tables": ["..."] }`
- `POST /admin/mail/queue` → Outbox-Einträge für Sammelmails
- `POST /admin/payment/reminders/queue` → Outbox-Einträge für Zahlungserinnerungen
- `POST /admin/documents/waiver` → PDF Haftverzicht generieren
- `POST /admin/documents/tech-check` → PDF Technische Abnahme generieren
- `GET /admin/documents/:id/download` → presigned Download-URL

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

Die Lambda holt DB-Credentials aus Secrets Manager (`DB_SECRET_ARN`) und nutzt die RDS-Postgres Instanz aus Phase 1.

## Mail (SES Sandbox)

Für den Versand werden benötigt:

- `SES_FROM_EMAIL` (verifizierte Absenderadresse)

Der Versand läuft über Outbox + Worker (`emailWorker`) und einen Scheduler (`paymentReminderScheduler`).
