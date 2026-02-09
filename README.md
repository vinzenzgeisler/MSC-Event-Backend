# Dreiecksrennen Monorepo

Dieses Repo ist als npm-Workspace organisiert:

- `api/` enthält den Lambda/API-Code (Phase 2, Drizzle + Postgres).
- `infra/` enthält die AWS CDK App.

## Voraussetzungen

- Node.js 20+
- npm 10+

## Installation

```bash
npm install
```

## Wichtige Befehle

- `npm run api:build`
- `npm run api:start`
- `npm run api:db:generate`
- `npm run api:db:migrate`
- `npm run infra:build`
- `npm run synth`
- `npm run deploy`

## Weitere Doku

- API: `api/README.md`
- Infra: `infra/README.md`

## Ablauf (Bootstrap + Deploy)

1. Docker-unabhängiges Bundling für Lambda aktivieren:
   - `infra/`:
     - `npm i -D esbuild`
2. Zirkuläre Stack-Abhängigkeit behoben:
   - Security Group für die API-Lambda in `DataStack` definiert.
   - `ApiStack` nutzt diese Security Group (keine Gegenabhängigkeit mehr).
3. Bootstrap in `eu-central-1`:
   - `npx cdk bootstrap aws://195275675655/eu-central-1`
4. Fehlende API-Dependencies installieren (für Bundling):
   - `api/`:
     - `npm install`
5. Deploy:
   - `infra/`:
     - `npx cdk deploy --all`
