# Dreiecksrennen Monorepo

Dieses Repo ist als npm-Workspace organisiert:

- `api/` enthält den Lambda/API-Code (Phase 2, Drizzle + Postgres).
- `infra/` enthält die AWS CDK App.

## KI-Feature fuer die Abgabe

Das Cloud-/KI-Feature fuer die Abgabe ist der `AI Communication Hub`.

Es erweitert das MSC-Event-System um drei review-pflichtige KI-Assistenzfunktionen:

- Mail-Assistent fuer eingehende Anfragen
- Event-Bericht-Generator
- Sprecherassistenz

Technisch wird dabei ein typischer Cloud-Flow umgesetzt:

- API Gateway ruft Lambda auf
- Lambda baut serverseitig den fachlichen Kontext
- Lambda nutzt AWS Bedrock als KI-Service
- Ergebnisse werden als pruefbare Entwuerfe zurueckgegeben

Der Fokus liegt bewusst nicht auf einem offenen Chatbot, sondern auf klaren, plausiblen Use Cases fuer den Praxispartner.

## Voraussetzungen

- Node.js 20+
- npm 10+

## Installation

```bash
npm install
```

## Konfigurationsmodell (wichtig)

- Stage-spezifische Deploy-Konfiguration liegt in `infra/lib/config/dev.ts` und `infra/lib/config/prod.ts`.
- OAuth-URLs, Verify-URL, SES-Absender und Assets-CORS werden dort gepflegt.
- `.env.example` enthält nur noch AWS-Credential-Variablen fuer die CLI.

## Wichtige Befehle

- `npm run api:build`
- `npm run api:start`
- `npm run api:db:generate`
- `npm run api:db:migrate`
- `npm run infra:build`
- `npm run synth`
- `npm run deploy`

## Doku fuer Nachbau und Abgabe

- API: `api/README.md`
- Infra: `infra/README.md`
- AI Architektur: `docs/ai/architecture.md`
- AI MVP Scope: `docs/ai/mvp-scope.md`
- AI Risiken / offene Fragen: `docs/ai/open-questions-risks.md`
- AI API Contract: `docs/ai/api-draft.md`
- AI Setup und Deploy: `docs/ai/setup-and-deploy.md`
- AI Konfigurationsreferenz: `docs/ai/configuration-reference.md`
- AI Demo-Runbook: `docs/ai/demo-runbook.md`
- AI Submission Summary: `docs/ai/submission-summary.md`
- Handover Phase 4: `docs/phase4-handover.md`
- Handover Phase 5: `docs/phase5-handover.md`
- Handover Phase 6: `docs/phase6-handover.md`
- Smoke Test (PowerShell): `scripts/phase3-smoke-test.ps1`

## Ablauf (Kurz)

1. Installieren: `npm install`
2. Dev kostenarm deployen: `cd infra && npx cdk deploy --all -c stage=dev -c devProfile=idle`
3. Für funktionale Tests: `cd infra && npx cdk deploy --all -c stage=dev -c devProfile=test`
4. Smoke-Test ausführen: `pwsh ./scripts/phase3-smoke-test.ps1`

## Empfohlener Nachbau fuer die KI-Abgabe

1. `npm install`
2. AWS Stage-Konfiguration und Secrets gemäss `docs/ai/configuration-reference.md` anlegen
3. Infrastruktur deployen gemäss `docs/ai/setup-and-deploy.md`
4. Datenbank migrieren
5. Backend deployen
6. Demo-Schritte gemäss `docs/ai/demo-runbook.md` durchgehen
