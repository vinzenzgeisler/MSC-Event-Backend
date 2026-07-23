# GitHub Actions CI/CD

## Branching

- Normale Commits und Pull Requests starten keine GitHub Actions.
- `dev` oder ein Feature-Branch kann bei Bedarf über einen `deploy-dev/**`-Git-Tag oder manuell nach Dev deployt werden.
- `main` deployt automatisch nach Prod.
- Feature-Branches gehen per PR nach `dev`.
- Freigegebene Änderungen gehen per Merge von `dev` nach `main`.

## GitHub Setup

1. Repository -> `Settings` -> `Environments`
2. Environments `dev` und `prod` anlegen
3. Im Environment `prod` unter `Required reviewers` mindestens einen Freigeber eintragen
4. Secrets und Variables jeweils im passenden Environment speichern, nicht als globale Repository-Werte

Die Workflow-Datei verwendet `environment: dev` ausschließlich bei einem manuell gestarteten Dev-Lauf und `environment: prod` beim Prod-Deploy. Sobald `prod` einen Required Reviewer hat, hält GitHub den Prod-Deploy nach einem Push auf `main` automatisch an.

## Backend Repo Secrets / Variables

### Environment `dev`

- Secret: `AWS_DEPLOY_ROLE_ARN_DEV`
- Variable: `AWS_ACCOUNT_ID`
- Variable: `AWS_REGION`
- Variable: `DEV_PUBLIC_BASE_URL`
- Optional Variable: `DEV_COGNITO_DOMAIN_PREFIX`

### Environment `prod`

- Secret: `AWS_DEPLOY_ROLE_ARN_PROD`
- Variable: `AWS_ACCOUNT_ID`
- Variable: `AWS_REGION`
- Variable: `PROD_PUBLIC_BASE_URL`
- Optional Variable: `PROD_COGNITO_DOMAIN_PREFIX`

## Woher kommen die Werte?

- `AWS_DEPLOY_ROLE_ARN_DEV`
  - Aus AWS IAM. Das ist die Dev-Role, die GitHub Actions per OIDC annehmen darf.
  - Format: `arn:aws:iam::<account-id>:role/<role-name>`
- `AWS_DEPLOY_ROLE_ARN_PROD`
  - Aus AWS IAM. Das ist die Prod-Role, die GitHub Actions per OIDC annehmen darf.
  - Format: `arn:aws:iam::<account-id>:role/<role-name>`
  - Falls die Roles noch nicht existieren, müssen sie in AWS angelegt und für GitHub OIDC freigegeben werden.
- `AWS_ACCOUNT_ID`
  - Aus dem AWS-Konto, in das deployt wird.
  - In AWS rechts oben über den Account oder per `aws sts get-caller-identity`.
- `AWS_REGION`
  - Eure Zielregion, aktuell typischerweise `eu-central-1`.
- `DEV_PUBLIC_BASE_URL`
  - Öffentliche Basis-URL des Dev-Frontends, zum Beispiel `https://dev.example.tld`.
  - Daraus werden Dev-Verify-Links, Callback-URLs und Redirect-Basen abgeleitet.
- `DEV_COGNITO_DOMAIN_PREFIX`
  - Optionaler expliziter Cognito Hosted-UI-Domain-Präfix für Dev.
  - Standard ist automatisch `dreiecksrennen-dev-auth-<accountsuffix>`, damit neue AWS-Konten keine Kollision mit bereits belegten Präfixen erzeugen.
- `PROD_PUBLIC_BASE_URL`
  - Öffentliche Basis-URL des Prod-Frontends, zum Beispiel `https://event.example.tld`.
  - Daraus werden Prod-Verify-Links, Callback-URLs und Redirect-Basen abgeleitet.
- `PROD_COGNITO_DOMAIN_PREFIX`
  - Optionaler expliziter Cognito Hosted-UI-Domain-Präfix für Prod.
  - Standard ist automatisch `dreiecksrennen-prod-auth-<accountsuffix>`, damit auch Prod im neuen AWS-Konto nicht mit bereits belegten Präfixen kollidiert.

## Verhalten

- Feature-/Dev-Commits und Pull Requests lösen keine Pipeline aus.
- Ein Git-Tag mit Präfix `deploy-dev/` deployt den markierten Commit als `stage=dev` mit `devProfile=test`.
- Ein manueller `workflow_dispatch` kann den ausgewählten Branch als `stage=dev` mit `devProfile=test` oder `idle` deployen oder alle Dev-Stacks vollständig löschen.
- Push auf `main` führt nach der allgemeinen Validierung genau einen geschützten Prod-Job aus. Dieser synthetisiert und deployt `stage=prod`.

## Deploy-Reihenfolge

- `dev` mit `test`:
  - Auth/Data/Storage deploy
  - SQL-Migrationen automatisch gegen die Dev-Datenbank
  - danach API-Stack deploy
- `dev` mit `idle`:
  - keine Migrationen
  - kein API-Deploy
- `prod`:
  - Auth/Data/Storage deploy
  - SQL-Migrationen automatisch gegen die Prod-Datenbank
  - danach API-Stack deploy

Die Pipeline geht davon aus, dass DB-Änderungen als vorwärtskompatible Migrationen ins Repo eingecheckt werden.

## AWS-Vorbereitung

- Für Dev und Prod werden getrennte GitHub-Deploy-Roles erwartet: `AWS_DEPLOY_ROLE_ARN_DEV` und `AWS_DEPLOY_ROLE_ARN_PROD`.
- Beide Roles brauchen OIDC-Trust für GitHub Actions auf dieses Repository.
- Die Roles brauchen mindestens Rechte für CDK/CloudFormation, Lambda, API Gateway, IAM-PassRole, Cognito, S3, SES, SQS/EventBridge, RDS/Secrets Manager/SSM und die betroffenen Infrastruktur-Ressourcen.

## Neuer AWS-Account: zusätzliche Pflichtpunkte

- SES / Mail:
  - Absenderadresse `nennung@msc-oberlausitzer-dreilaendereck.eu` oder die gewünschte Vereinsadresse in AWS SES verifizieren.
  - Wenn möglich direkt Domain-Identität statt nur Einzeladresse verifizieren.
  - Falls der Account noch in der SES Sandbox ist, Ausstieg aus der Sandbox beantragen, sonst gehen Mails nur an verifizierte Empfänger.
- DNS / Domain:
  - Für SES-Domain-Verifikation und DKIM die nötigen DNS-Records beim Mail-/DNS-Provider eintragen.
- Cognito:
  - Callback-/Logout-URLs werden aus `DEV_PUBLIC_BASE_URL` und `PROD_PUBLIC_BASE_URL` abgeleitet.
  - Deshalb müssen die Frontend-Domains vor dem Deploy feststehen.
- Dev-Kosten:
  - Normale Commits und Pull Requests deployen keine Dev-Ressourcen.
  - Dev kann über einen `deploy-dev/**`-Tag oder manuell mit `dev_profile=idle` oder `test` deployt werden.
  - Die manuelle Aktion `destroy` löscht API-, Storage-, Data- und Auth-Stack einschließlich des sonst beibehaltenen Dev-Cognito-User-Pools.

## Empfehlung

- `prod` immer mit Required Reviewer absichern.
- Branch Protection für `main` aktivieren: kein Direkt-Push, nur Merge via PR.
- Optional nach dem CDK-Deploy noch einen Dev-/Prod-Smoke-Test ergänzen.
