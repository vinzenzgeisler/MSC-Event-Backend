# Feature-Branch Dev-Umgebung

Feature-Branches nutzen bewusst keine eigenen AWS-Stacks. Es gibt eine gemeinsame Dev-Infrastruktur mit dem Stack-Prefix `dreiecksrennen-dev`.

## Backend

Automatisch:

- Push auf `dev`: validiert und deployt `stage=dev`, `devProfile=test`.
- Scheduler: stoppt taeglich nur die Dev-RDS-Instanz. API Gateway und Lambda bleiben stehen, damit die Dev-API-URL stabil bleibt.
- Push auf `feature/**`, `fix/**`, `chore/**`: validiert und deployt `stage=dev`, `devProfile=test` auf dieselbe gemeinsame Dev-Infrastruktur.

Damit ueberschreibt der zuletzt gepushte Backend-Branch die gemeinsame Dev-API. Es werden keine branch-spezifischen Stacks angelegt.

Wichtig: Die Dev-API ist dadurch bewusst eine geteilte Testumgebung. Parallele Feature-Branch-Pushes werden im Workflow serialisiert; der spaeter gestartete Deploy laeuft nach dem vorherigen Deploy.

Beim naechsten `test`-Deploy startet die Pipeline die Dev-RDS-Instanz wieder, wartet auf `available`, fuehrt Migrationen aus und seeded den aktuellen Dev-Event inklusive 10 Signing-Testnennungen. Daten bleiben beim Stop/Start erhalten; der Seed ist idempotent und ergaenzt nur fehlende Testnennungen.

## Frontend lokal

Das Frontend soll fuer Feature-Arbeit lokal laufen und gegen die gemeinsame Dev-API zeigen. Empfohlen ist:

```bash
npm run dev
```

mit einer lokalen `.env.local`, die `VITE_API_BASE_URL=/api` und `VITE_API_PROXY_TARGET=<Dev API URL>` setzt. Dadurch laeuft die Browser-App auf `localhost`, die API-Calls gehen aber ueber den Vite-Proxy an die gemeinsame Dev-API.

## Erwartete GitHub Environment Variablen

Backend `dev`:

- `AWS_ACCOUNT_ID`
- `AWS_REGION`
- `DEV_PUBLIC_BASE_URL`
- Secret `AWS_DEPLOY_ROLE_ARN_DEV`

Frontend `dev`:

- `VITE_API_BASE_URL_DEV`
- `VITE_COGNITO_DOMAIN_DEV`
- `VITE_COGNITO_CLIENT_ID_DEV`
- `VITE_COGNITO_REDIRECT_URI_DEV`
- `VITE_COGNITO_LOGOUT_URI_DEV`
- optional `VITE_COGNITO_SCOPES_DEV`
