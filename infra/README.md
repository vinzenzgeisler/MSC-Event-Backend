# Dreiecksrennen Infrastruktur (Phase 1)

Dieses Verzeichnis enthält eine AWS CDK v2 App (TypeScript) für die Basis-Infrastruktur des Event-Verwaltungstools.

## Voraussetzungen

- Node.js 20+
- npm 10+
- AWS CLI mit konfigurierten Credentials
- AWS CDK v2 (`npx cdk` über lokale Dependencies)

## Installation

```bash
cd infra
npm install
```

## CDK Bootstrap

Vor dem ersten Deploy pro AWS Account/Region:

```bash
cd infra
npx cdk bootstrap aws://<ACCOUNT_ID>/<REGION>
```

## Deploy (dev)

```bash
cd infra
npx cdk deploy --all -c stage=dev
```

Optional per Umgebungsvariable:

```bash
cd infra
STAGE=dev npx cdk deploy --all
```

## Wichtige Outputs

- **AuthStack**
  - `UserPoolId`
  - `UserPoolClientId`
  - `UserPoolIssuerUrl`
- **DataStack**
  - `DbSecretArn`
  - `DbEndpoint`
  - `DbName`
- **StorageStack**
  - `AssetsBucketName`
  - `DocumentsBucketName`
- **ApiStack**
  - `ApiUrl`
- **MigrationRunnerStack**
  - `MigrationRunnerProjectName`
  - `MigrationRunnerProjectArn`

## Stage-Konfiguration

- `lib/config/dev.ts`
- `lib/config/prod.ts`

Die CDK App liest die Stage über `-c stage=<dev|prod>` oder über die Umgebungsvariable `STAGE`.

## Phase 3 Konfiguration (Mail/Jobs)

Setze vor `cdk deploy` folgende Umgebungsvariablen:

- `SES_FROM_EMAIL` (verifizierte Absender-Adresse für SES Sandbox)
- `PAYMENT_REMINDER_TEMPLATE_ID` (z. B. `payment-reminder`)
- `PAYMENT_REMINDER_SUBJECT` (Betreff der Zahlungserinnerung)

## Migration Runner (DB Migrations)

Der Migration Runner nutzt CodeBuild in der VPC und führt `npm run db:migrate` im API-Ordner aus.

So startest du Migrationen:

1. Stelle sicher, dass CodeBuild Zugriff auf das GitHub-Repo hat (OAuth-Token oder CodeStar-Connection im AWS Account).
2. Starte den Build über CLI:
   - `aws codebuild start-build --project-name <MigrationRunnerProjectName>`
3. Logs findest du in CloudWatch Logs unter dem CodeBuild-Projekt.
