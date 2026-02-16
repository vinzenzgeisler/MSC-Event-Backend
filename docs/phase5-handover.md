# Phase 5 Handover

Stand: `main` nach Phase-5-Workflow-Erweiterungen.

## Scope umgesetzt

- Event-Lifecycle: `draft/open/closed/archived`, current-event, Update im offenen Zustand.
- Klassenverwaltung pro Event (mit Zuordnung `vehicleType = moto|auto`).
- Public Fahrer-Anmeldung inkl. E-Mail-Verifikation.
- Entry-Backoffice: Liste/Suche/Filter, Statusentscheidungen, Tech-Status.
- Pricing/Invoice/Payments: Regelwerk, Snapshot-Recalc, Payment-Erfassung.
- Exporte: mehrere CSV-Typen + Export-Historie.
- Check-in: Listen-Endpoint + ID-Verify + Tech-Status.
- Dokumente: Viewer-Download on-demand pro Entry (`waiver`/`tech_check`).

Wichtig: Event hat bewusst **kein** Ort-Feld (Anforderung).

## Neue API-Flächen (Kurzliste)

- Public:
  - `POST /public/events/{id}/entries`
  - `POST /public/entries/{id}/verify-email`
- Admin:
  - `PATCH /admin/events/{id}`
  - `GET|POST /admin/events/{id}/classes`
  - `PATCH|DELETE /admin/classes/{id}`
  - `GET /admin/entries`
  - `GET /admin/checkin/entries`
  - `PATCH /admin/entries/{id}/status`
  - `PATCH /admin/entries/{id}/tech-status`
  - `GET /admin/documents/entry/{entryId}/download?eventId=...&type=waiver|tech_check`
  - `GET /admin/exports?eventId=...`

## DB-Migrationen

- Neu: `api/migrations/0008_phase5_workflow_gaps.sql`
- Enthält u. a.:
  - `event.registration_open_at`, `event.registration_close_at`
  - `vehicle.image_s3_key`
  - `entry.tech_status`, `entry.tech_checked_at`, `entry.tech_checked_by`
  - `entry_email_verification`
  - Erweiterter `export_job_type_check`

## Deploy/Migration/Test (ausgeführt)

Datum: 2026-02-16 (UTC+1 lokale Ausführung).

1. Deploy
- `cd infra && npx cdk deploy --all -c stage=dev -c devProfile=test --require-approval never`
- Ergebnis: erfolgreich.

2. DB Migration
- `npm --workspace api run db:migrate`
- Ergebnis: `0008_phase5_workflow_gaps.sql` erfolgreich angewendet.

Hinweis Betrieb:
- Dev-RDS kann durch Auto-Cleanup gestoppt sein; vor Migration ggf. starten:
  - `aws rds start-db-instance --db-instance-identifier dreiecksrennen-dev-postgres-public --region eu-central-1`
  - `aws rds wait db-instance-available --db-instance-identifier dreiecksrennen-dev-postgres-public --region eu-central-1`

3. E2E Smoke-Test (erfolgreich)
- Admin-Flow:
  - Event erstellen, Klassen anlegen, aktivieren
  - Entry-Listen, Statusentscheidung + Lifecycle-Mail
  - Pricing setzen, Invoice recalc, Payment erfassen
  - Check-in Verify + Tech-Status
  - Exporte erzeugen + Historie lesen
  - Event schließen + archivieren
- Public-Flow:
  - Anmeldung erstellen
  - E-Mail-Verifikation durchführen
  - Nach Archivierung: neue Anmeldung blockiert (409)
- Viewer-Flow:
  - Dokumentdownload on-demand pro Entry funktioniert ohne Vorab-Generierung.

## Klassenmodell für UI

Empfohlenes UI-Mapping:

- Kategorie `Motorräder` -> `vehicleType: moto`
- Kategorie `Autos` -> `vehicleType: auto`
- Klassenbezeichnung in `class.name` frei pflegbar (z. B. `1`, `2`, ..., `11`, `Sonderlauf`, `Nachwuchs`).

Damit lassen sich eure fachlichen Klassen 1-11 und Sonderläufe direkt im bestehenden Datenmodell abbilden.
