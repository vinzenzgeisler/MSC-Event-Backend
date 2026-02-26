# Evidence Runbook (Audit-Nachweise)

Stand: 2026-02-26

## Ziel
Standardisierte, wiederholbare Nachweise fuer Datenschutzpruefungen erzeugen.

## Nachweis 1: Consent
1. Stichprobe `entry` + `consent_evidence` fuer Zeitraum ziehen.
2. Pruefen:
1. `consent_version`,
2. `consent_text_hash`,
3. `locale`,
4. `consent_source`,
5. `captured_at`.

## Nachweis 2: Retention/Purge
1. `audit_log` auf `action='privacy_retention_run'` filtern.
2. Je Lauf pruefen:
1. `deletedRows` je Tabelle,
2. `errors` leer.

## Nachweis 3: Kommunikation
1. Outbox/Delivery-Stichprobe je Event.
2. Zustellstatus + Retry-Verlauf dokumentieren.

## Nachweis 4: Rollen und Zugriff
1. Cognito Gruppenbelegung exportieren (`admin`, `editor`, `viewer`).
2. Quartalsreview dokumentieren.

## Nachweis 5: Infrastruktur
1. RDS Backup-Retention in Prod.
2. S3 Lifecycle-Regeln (`uploads/`, `exports/`).
3. Log-Retention in CloudWatch LogGroups.
