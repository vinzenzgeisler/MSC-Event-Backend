# AI Communication Hub Setup And Deploy

Stand: 2026-04-02

## Ziel

Dieses Dokument beschreibt, wie eine andere Person den `AI Communication Hub` technisch nachbauen und deployen kann.

## Enthaltene Cloud-Bausteine

- AWS API Gateway
- AWS Lambda
- AWS Bedrock Runtime
- AWS Secrets Manager
- AWS EventBridge Scheduler
- AWS S3
- AWS RDS / Postgres

## Voraussetzungen

- AWS Account mit Zugriff auf die Ziel-Region
- Node.js 20+
- npm 10+
- AWS CLI
- Berechtigung fuer:
  - CloudFormation / CDK Deploy
  - Secrets Manager
  - Bedrock Runtime
  - Lambda
  - EventBridge
  - S3
  - RDS-Zugriff fuer Migrationen

## 1. Repository vorbereiten

```bash
npm install
npm run api:build
npm run infra:build
```

## 2. Stage-Konfiguration pruefen

Relevante Dateien:

- `infra/lib/config/dev.ts`
- `infra/lib/config/prod.ts`

Zu pruefen sind insbesondere:

- Web-App-Origin / CORS
- Bedrock-Modell-ID
- optional IMAP-Secret-ARN

## 3. Secrets anlegen

Die benoetigten Secrets sind in `docs/ai/configuration-reference.md` dokumentiert.

Fuer den Mail-Assistenten wird mindestens ein IMAP-Secret in AWS Secrets Manager benoetigt.

## 4. Bedrock vorbereiten

Empfohlener MVP-Standard:

- `eu.amazon.nova-micro-v1:0`

Vor dem Deploy pruefen:

- Modell bzw. Inference Profile ist in der Ziel-Region verfuegbar
- Account hat Zugriff auf Bedrock Runtime

## 5. Infrastruktur deployen

Beispiel fuer `dev`:

```bash
cd infra
npx cdk deploy --all -c stage=dev -c devProfile=test --require-approval never
```

Hinweis:

- Falls lokale Proxy-Variablen gesetzt sind und CDK-Deploys stoeren, muessen `HTTP_PROXY`, `HTTPS_PROXY` und `ALL_PROXY` vor dem Deploy entfernt oder neutralisiert werden.

## 6. Datenbank migrieren

Nach dem Infrastruktur-Deploy die Migrationen auf die Ziel-Datenbank anwenden.

Beispiel ueber den vorhandenen Workspace-Befehl:

```bash
npm run api:db:migrate
```

Wichtig:

- die DB-Verbindung und das CA-Bundle muessen zur Zielumgebung passen
- alle AI-Migrationen muessen enthalten sein

## 7. Backend deployen

Wenn die Infrastruktur ueber CDK den API-Handler bereits bundelt, reicht der reguläre CDK-Deploy.

Danach pruefen:

- `/health`
- AI-Endpunkte
- Poller / Scheduler

## 8. Technischer Funktionscheck

Mindestens pruefen:

1. `GET /health`
2. `GET /admin/ai/messages`
3. `POST /admin/ai/messages/{id}/suggest-reply`
4. `POST /admin/ai/reports/generate`
5. `POST /admin/ai/speaker/generate`

Optional fuer die volle Demo:

6. `POST /admin/ai/messages/{id}/chat`
7. `POST /admin/ai/messages/{id}/knowledge-suggestions`
8. `POST /admin/ai/reports/{draftId}/regenerate-variant`
9. `POST /admin/ai/reports/{draftId}/knowledge-suggestions`

## 9. Wichtige Dateien fuer den Nachbau

- Einstieg: `README.md`
- Architektur: `docs/ai/architecture.md`
- Scope: `docs/ai/mvp-scope.md`
- Risiken: `docs/ai/open-questions-risks.md`
- API-Contract: `docs/ai/api-draft.md`
- Konfiguration: `docs/ai/configuration-reference.md`
- Demo: `docs/ai/demo-runbook.md`

## 10. Minimaler Nachbau fuer die Abgabe

Wenn nur das KI-Feature vorfuehrbar nachgebaut werden soll, reicht funktional:

1. `dev`-Stage konfigurieren
2. Bedrock aktivieren
3. IMAP-Secret anlegen
4. Deploy
5. Migration
6. Testmail importieren
7. Reply-Assistent und Berichtsgenerator demonstrieren
