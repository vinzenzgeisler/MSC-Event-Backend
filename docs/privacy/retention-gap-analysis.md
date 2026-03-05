# Retention Gap Analysis

Stand: 2026-03-05

## Current Technical Retention
- Job: `privacyRetentionWorker` loescht/anonimisiert u. a.:
- `registration_group_email_verification`
- `public_entry_submission`
- `vehicle_image_upload`
- `export_job` (completed)
- `email_outbox` (sent/failed)
- `audit_log`
- Entry-Notizen (nullen)

## Gaps
- P0: Kein expliziter Purge fuer `email_delivery` -> Zustellmetadaten koennen unnoetig lange verbleiben.
- P1: `document` Metadaten-Retention und S3-Lifecycle nicht explizit aufeinander abgestimmt.
- P1: Keine technische Aufbewahrungsstaffel pro Datenkategorie dokumentiert im Code (nur ENV-Werte).
- P1: Kein Dry-Run/Report-Mode fuer Retention-Job vor produktiver Loeschung.

## Proposed Technical Measures
1. Neue Retention-Policy-Matrix im Repo (DB+S3) mit owner + SLA.
2. Retention-Worker erweitern um `email_delivery` Purge (fristbasiert).
3. S3 Lifecycle Rules fuer Dokumenttypen und Exporte explizit an DB-Fristen koppeln.
4. Dry-Run Modus + strukturierter Bericht je Lauf.

## ANNAHMEN
- ANNAHME: Fachlich benoetigte Mindestaufbewahrung fuer Audit liegt >= 24 Monate.
