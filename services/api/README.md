# API Lambda Service (Phase 1)

Minimaler TypeScript-Lambda-Handler mit einfachem Router:

- `GET /health` → `{ "ok": true, "stage": "dev" }`
- `GET /admin/ping` → `{ "ok": true, "sub": "...", "groups": ["admin"] }`

## Voraussetzungen

- Node.js 20+
- npm 10+

## Installation

```bash
cd services/api
npm install
```

## Lokaler Build-Test (ohne AWS)

```bash
cd services/api
npm run build
node -e "const {handler}=require('./dist/handler'); handler({requestContext:{http:{method:'GET',path:'/health'}}}).then(console.log)"
```

## Hinweis

In Phase 1 wird **keine echte Datenbankverbindung** aufgebaut. Die Lambda nutzt nur Umgebungsvariablen und stellt Health/Admin-Testendpunkte bereit.
