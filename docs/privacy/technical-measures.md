# Technical Measures (Implementation Focus)

Stand: 2026-03-05

## Access Control
- RBAC serverseitig: `admin`, `editor`, `viewer`.
- Kritische Writes auf `admin` beschraenkt.
- Empfehlung P1: serverseitiges MFA-Gating fuer Hochrisikoaktionen (`iam`, `payments`, `mail/send`, `delete`).

## Input Validation
- Zod-Validierung in Handler/Routen fuer Request-Body und Query.
- Einheitlicher Fehlervertrag ueber `errorJson`.
- Empfehlung P1: zentrale Validator-Konvention + shared constraints fuer Mail-/Template-APIs.

## Data Minimization
- Audit-Whitelist (`sanitizePayload`) aktiv.
- Empfehlung P0: alle neuen Audit-Actions explizit whitelisten; default-deny beibehalten.
- Empfehlung P1: `templateData` in Outbox auf notwendige Felder begrenzen.

## Logging and Monitoring
- Lambda Log Retention konfiguriert.
- Empfehlung P0: sichere Logger-Abstraktion statt `console.error` mit Redaction.
- Empfehlung P1: Correlation-ID in allen responses/logs.

## Secrets and Crypto
- DB-Zugang via Secrets Manager.
- TLS fuer DB/S3/HTTPS erzwungen.
- Empfehlung P1: KMS-CMK statt nur S3 managed keys fuer feinere Auditierbarkeit.

## Rate Limits
- Empfehlung P1: Rate Limiting fuer `public entries`, `verify-email`, `uploads init/finalize`, `admin/mail/send`.
