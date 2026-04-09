# GitHub Actions CI/CD

## Branching
- `dev` deployt automatisch nach Dev.
- `main` deployt automatisch nach Prod.
- Feature-Branches gehen per PR nach `dev`.
- Freigegebene Änderungen gehen per Merge von `dev` nach `main`.

## GitHub Setup
1. Repository -> `Settings` -> `Environments`
2. Environments `dev` und `prod` anlegen
3. Im Environment `prod` unter `Required reviewers` mindestens einen Freigeber eintragen
4. Secrets und Variables jeweils im passenden Environment speichern, nicht als globale Repository-Werte

Die Workflow-Datei verwendet bereits `environment: dev` und `environment: prod`. Sobald `prod` einen Required Reviewer hat, hält GitHub den Prod-Deploy nach einem Push auf `main` automatisch an, bis die Freigabe erteilt wurde.

## Backend Repo Secrets / Variables
### Environment `dev`
- Secret: `AWS_DEPLOY_ROLE_ARN`
- Variable: `AWS_ACCOUNT_ID`
- Variable: `AWS_REGION`
- Variable: `DEV_PUBLIC_BASE_URL`

### Environment `prod`
- Secret: `AWS_DEPLOY_ROLE_ARN`
- Variable: `AWS_ACCOUNT_ID`
- Variable: `AWS_REGION`
- Variable: `PROD_PUBLIC_BASE_URL`

## Woher kommen die Werte?
- `AWS_DEPLOY_ROLE_ARN`
  - Aus AWS IAM. Das ist die Role, die GitHub Actions per OIDC annehmen darf.
  - Format: `arn:aws:iam::<account-id>:role/<role-name>`
  - Falls sie noch nicht existiert, muss sie in AWS angelegt und für GitHub OIDC freigegeben werden.
- `AWS_ACCOUNT_ID`
  - Aus dem AWS-Konto, in das deployt wird.
  - In AWS rechts oben über den Account oder per `aws sts get-caller-identity`.
- `AWS_REGION`
  - Eure Zielregion, aktuell typischerweise `eu-central-1`.
- `DEV_PUBLIC_BASE_URL`
  - Öffentliche Basis-URL des Dev-Frontends, zum Beispiel `https://dev.example.tld`.
  - Daraus werden Dev-Verify-Links, Callback-URLs und Redirect-Basen abgeleitet.
- `PROD_PUBLIC_BASE_URL`
  - Öffentliche Basis-URL des Prod-Frontends, zum Beispiel `https://event.example.tld`.
  - Daraus werden Prod-Verify-Links, Callback-URLs und Redirect-Basen abgeleitet.

## Verhalten
- PRs gegen `dev` oder `main` laufen nur Validierung.
- Push auf `dev` deployt `stage=dev` mit `devProfile=test`.
- Push auf `main` deployt `stage=prod`.

## AWS-Vorbereitung
- Für Dev und Prod sollte dieselbe GitHub-Deploy-Role nur dann verwendet werden, wenn sie beide Stages bewusst verwalten darf.
- Sauberer ist je Stage eine eigene Role. Dann wird der Workflow auf zwei Secrets erweitert, zum Beispiel `AWS_DEPLOY_ROLE_ARN_DEV` und `AWS_DEPLOY_ROLE_ARN_PROD`.
- Die Role braucht mindestens Rechte für CDK/CloudFormation, Lambda, API Gateway, IAM-PassRole, SSM/Secrets-Zugriffe und die betroffenen Infrastruktur-Ressourcen.

## Empfehlung
- `prod` immer mit Required Reviewer absichern.
- Branch Protection für `main` aktivieren: kein Direkt-Push, nur Merge via PR.
- Optional nach dem CDK-Deploy noch einen Dev-/Prod-Smoke-Test ergänzen.
