# API Lambda Service (Phase 2)

Minimaler TypeScript-Lambda-Handler mit Datenbankzugriff (Postgres via Drizzle):

- `GET /health` → `{ "ok": true, "stage": "dev" }`
- `GET /admin/ping` → `{ "ok": true, "sub": "...", "groups": ["admin"] }`
- `GET /admin/db/ping` → `{ "ok": true, "database": "...", "now": "..." }`
- `GET /admin/db/schema` → `{ "ok": true, "tables": ["..."] }`

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

## Hinweis

Die Lambda holt DB-Credentials aus Secrets Manager (`DB_SECRET_ARN`) und nutzt die RDS-Postgres Instanz aus Phase 1.
