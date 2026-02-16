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
- Handover Phase 4: `docs/phase4-handover.md`
- Handover Phase 5: `docs/phase5-handover.md`
- Smoke Test (PowerShell): `scripts/phase3-smoke-test.ps1`

## Ablauf (Kurz)

1. Installieren: `npm install`
2. Dev kostenarm deployen: `cd infra && npx cdk deploy --all -c stage=dev -c devProfile=idle`
3. Für funktionale Tests: `cd infra && npx cdk deploy --all -c stage=dev -c devProfile=test`
4. Smoke-Test ausführen: `pwsh ./scripts/phase3-smoke-test.ps1`
