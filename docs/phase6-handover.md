# Phase 6 Handover

## Scope umgesetzt

- Einheitlicher Fehlervertrag erweitert: `ok=false`, `code`, optional `fieldErrors[]`, `details`.
- Public Read für Anmeldung: `GET /public/events/current`.
- Public Startnummer-Validation: `POST /public/events/:id/start-number/validate`.
- Public Fahrzeugbild-Upload: `POST /public/uploads/vehicle-image/init|finalize`.
- Public Submit liefert Feldfehler bei Startnummer-Konflikt.
- Entry Detail für UI/Audit: `GET /admin/entries/:id` inkl. `history[]`.
- Mail-Outbox Admin APIs:
  - `GET /admin/mail/outbox`
  - `POST /admin/mail/outbox/:id/retry`
- Listenverträge auf Cursor-Pagination + Meta (`page`, `pageSize`, `total`, `hasMore`, `nextCursor`) erweitert für:
  - events
  - classes by event
  - entries
  - checkin entries
  - invoices
  - invoice payments
  - exports
  - outbox
- OpenAPI (`openapi.json`) erweitert: neue Endpunkte + `operationId` pro Operation + `ListMeta` + Fehlervertrag.

## Entry Detail: Audit/History-Felder

`GET /admin/entries/:id` liefert:

- Entry-Statusfelder:
  - `registrationStatus`
  - `acceptanceStatus`
  - `checkinIdVerified`
  - `techStatus`
- Zeit-/Actor-Felder:
  - `checkinIdVerifiedAt`
  - `checkinIdVerifiedBy`
  - `techCheckedAt`
  - `techCheckedBy`
  - `createdAt`
  - `updatedAt`
- `history[]` aus `audit_log` (entry-bezogen):
  - `action`
  - `actorUserId`
  - `createdAt`
  - `payload`

Viewer-Redaction bleibt aktiv für personenbezogene Driver-Felder.

## Auth-Vertrag

- API nutzt Bearer JWT via Cognito Authorizer.
- Rollen: `admin`, `checkin`, `viewer`.
- Kein Login-/Refresh-/Hosted-UI-Flow in dieser API.

## Migration

Neue SQL-Migration:

- `api/migrations/0009_phase6_upload_and_outbox.sql`
  - Tabelle `vehicle_image_upload`
  - Status-/Expiry-Index
