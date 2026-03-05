# Backend Implementation Plan

Stand: 2026-03-05

## Summary
- Ziel ist eine robuste, sichere Backend-Architektur fuer Kommunikation, Dokumente, Event-Lifecycle und Datenschutz-Readiness.
- Implementierung erfolgt in kleinen, logisch getrennten Commits mit idempotenten Migrationen und API-Vertragsaenderungen.
- Prioritaet: Kommunikationsmenue + Dokumentpipeline + Konsistenz bei Entry-Aenderungen + Datenschutz-Hardening.

## Epics, Tickets, Reihenfolge

### Epic 1: Kommunikationsmenue Backend
1. Mail-Template-Engine auf HTML+Text erweitern (DB + Worker + SES).
2. Template APIs einfuehren:
- `GET /admin/mail/templates`
- `POST /admin/mail/templates`
- `PATCH /admin/mail/templates/{key}`
- `POST /admin/mail/templates/{key}/versions`
- `POST /admin/mail/templates/{key}/preview`
3. Unified Send API einfuehren:
- `POST /admin/mail/send` mit Filtern + `additionalEmails`.
4. Audit und Outbox beibehalten, Legacy-Queue-Endpunkte kompatibel halten.

### Epic 2: Dokumentpipeline Haftverzicht/Technische Abnahme
1. Referenzlayouts (Auto/Moto) als sanitized Vorlage im Repo versionieren.
2. HTML->PDF Rendering-Pipeline fuer referenznahes Layout implementieren.
3. Variantensteuerung ueber Klasse/Fahrzeugtyp konsolidieren.
4. Download-/Storage-/Audit-Flow stabil halten.

### Epic 3: Entry Detail Konsistenz
1. `PATCH /admin/entries/{id}/class` implementieren (admin/editor).
2. Validierung: Eventzuordnung, Fahrzeugtyp, Backup-Link, Ersatzfahrzeug.
3. Audit-Event fuer Klassenwechsel schreiben.

### Epic 4: Event Re-Activation Vertrag
1. `POST /admin/events/{id}/activate` Vertrag und Transitionen absichern.
2. Regressionstests fuer `draft|closed -> open`, `archived -> forbidden`.

### Epic 5: Datenschutz und Aufbewahrung
1. Code-derived Dateninventur und Log-Analyse aktualisieren.
2. Retention-Gaps technisch schliessen (DB + S3 + Worker).
3. P0/P1 Risiken priorisiert beheben (PII in Logs, Debug-Endpunkte, MFA-Gate, Rate Limits).

## Risiken
- P0: PII-Leak in Logs/Fehlerpfaden oder unkontrollierten Audit-Payloads.
- P0: Referenznahe PDF-Erzeugung in Lambda (Runtime/Coldstart/Binary-Groesse).
- P1: Legacy-Endpoint-Verhalten bei Mail-Refactor.
- P1: Datenaufbewahrung DB/S3 nicht synchron.

## API Contracts (target)
- `POST /admin/mail/send`
- `POST /admin/mail/templates/{key}/preview`
- `PATCH /admin/entries/{id}/class`
- Fehlercodes konsistent: `TEMPLATE_NOT_FOUND`, `CLASS_VEHICLE_TYPE_MISMATCH`, `BACKUP_ENTRY_INVALID_LINK`, `EVENT_STATUS_FORBIDDEN`, `DUPLICATE_REQUEST`.

## Frontend Requests
- Template Editor:
- Felder: `name`, `subject`, `html`, `text`, Platzhalter-Hinweise.
- Versionierung: neue Version aus aktuellem Stand erzeugen.
- Preview UX:
- Testdaten-JSON eingeben, gerendertes HTML/Text sehen, Validierungsfehler pro Platzhalter anzeigen.
- Kommunikationsmenue Send:
- Zielgruppenfilter (`classId`, `acceptanceStatus`, `registrationStatus`, `paymentStatus`) + `additionalEmails`.
- Ergebnisanzeige: queued count, conflicts/errors.
- Entry Detail:
- Klassenwechsel-Flow mit Validierungsfeedback fuer Backup-/Ersatzfahrzeug.
- Eventverwaltung:
- Aktivieren-Action fuer archivierte/geschlossene Events mit Fehlerdarstellung.

## Acceptance Criteria
- Template APIs liefern versionierte, renderbare Inhalte (HTML+Text).
- Send Endpoint reiht Outbox-Jobs deterministisch ein und bleibt retry-faehig.
- Klassenwechsel aktualisiert Entry konsistent und schreibt Audit.
- Datenschutzdokumente sind code-derived, enthalten ANNAHME-Markierungen und P0/P1-Risiken.
