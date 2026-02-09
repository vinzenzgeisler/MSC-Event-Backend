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

## Stage-Konfiguration

- `lib/config/dev.ts`
- `lib/config/prod.ts`

Die CDK App liest die Stage über `-c stage=<dev|prod>` oder über die Umgebungsvariable `STAGE`.
