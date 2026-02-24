# Dreiecksrennen Infrastruktur (CDK v2)

Dieses Verzeichnis enthält die AWS CDK App für Auth, Storage, API, Datenbank und Migration Runner.

## Voraussetzungen

- Node.js 20+
- npm 10+
- AWS CLI mit konfigurierten Credentials
- AWS CDK v2 (`npx cdk`)

## Installation

```bash
cd infra
npm install
```

## Deploy

```bash
cd infra
npx cdk deploy --all -c stage=dev
```

## Cognito Hosted UI (OAuth) und Verify-Link

Die Werte werden ueber Stage-Konfigurationsdateien gepflegt:

- `infra/lib/config/dev.ts`
- `infra/lib/config/prod.ts`

Relevante Felder:

- `cognitoCallbackUrls`
- `cognitoLogoutUrls`
- `cognitoDomainPrefix`
- `publicVerifyBaseUrl`
- `sesFromEmail`
- `assetsCorsAllowedOrigins`

Verwendete Cognito-Gruppen (RBAC): `admin`, `editor`, `viewer`.

Für Dev gibt es zwei Profile:

- `idle` (Default): keine API/DB, minimale Kosten
- `test`: API+RDS aktiv für Smoke-/Integrationstests

Beispiele:

```bash
# Dev idle (default, fast keine laufenden Kosten)
npx cdk deploy --all -c stage=dev -c devProfile=idle

# Dev test (API + DB aktiv)
npx cdk deploy --all -c stage=dev -c devProfile=test
```

## Stage-Konfiguration

Die zentralen Einstellungen liegen in:

- `infra/lib/config/types.ts`
- `infra/lib/config/dev.ts`
- `infra/lib/config/prod.ts`

Wichtige Schalter:

- `enableNatGateway`
- `enableRds`
- `enableApi`
- `enableMigrationRunner`
- `apiInVpc`
- `dbConnectivityMode` (`private` | `public_budget`)
- `dbUseIamAuth`
- `dbRequireTls`
- `devCleanupEnabled`

## Dev (kostenarm Default)

`dev` ist standardmäßig auf minimale laufende Kosten gesetzt:

- NAT aus
- RDS aus
- API aus
- Migration Runner aus

Zusätzlich gibt es einen Dev-Cleanup-Job (alle 6 Stunden), der markierte RDS-Instanzen stoppt und verwaiste EIPs freigibt.

## Dev Test-Profil

`devProfile=test` ist für funktionale Tests gedacht:

- `enableApi: true`
- `enableRds: true`
- `apiInVpc: false`
- `dbConnectivityMode: public_budget`
- `dbUseIamAuth: false` (damit Tests ohne IAM-DB-Grant laufen)

Nach dem Test wieder auf `devProfile=idle` deployen, damit die laufenden Kosten zurück auf Minimum gehen.

## Prod Budget-Modus

Das aktuelle Prod-Profil ist auf niedrige Monatskosten optimiert:

- `enableNatGateway: false`
- `apiInVpc: false` (Lambda ohne VPC)
- `dbConnectivityMode: public_budget`
- `dbPublicAccess: true`
- `dbUseIamAuth: true`
- `dbRequireTls: true`

Konsequenz:

- Keine NAT-Gateway-Stunden
- Keine EIP-Kosten durch NAT
- Keine Interface-Endpoint-Dauerkosten
- RDS bleibt als Hauptkostenblock

## Sicherheitsprofil im Budget-Modus

Im `public_budget`-Modus ist die DB öffentlich erreichbar (`5432`).

Pflichtmaßnahmen:

- IAM DB Auth ist aktiv
- TLS wird per Parameter Group erzwungen (`rds.force_ssl=1`)
- API nutzt IAM-Token statt statischem DB-Passwort

Einmalige DB-Voraussetzung:

- Der App-User muss in PostgreSQL die Rolle `rds_iam` erhalten (z. B. `GRANT rds_iam TO eventadmin;`).
- Ohne diese Rolle schlägt IAM-Login trotz korrekter AWS-IAM-Rechte fehl.

Hinweis: Das ist ein bewusster Tradeoff zugunsten niedriger Kosten. Ein privates DB-Netzwerkmodell ist sicherer, verursacht aber in dieser Architektur typischerweise höhere monatliche Fixkosten.

## Migration Runner

Der Migration Runner ist ein eigener Stack und bleibt standardmäßig deaktiviert. Für Migrationen temporär aktivieren und danach wieder deaktivieren.
