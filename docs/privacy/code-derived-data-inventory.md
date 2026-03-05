# Code-Derived Data Inventory

Stand: 2026-03-05

## Method
- Quelle: `api/src/db/schema.ts`, `api/src/routes/*`, `api/src/jobs/*`, `api/src/mail/*`, `infra/lib/stacks/*`.
- Fokus: tatsaechlich verarbeitete personenbezogene Daten (DB, S3-Objekte, Mail, Logs, Audit).

## Processed Personal Data (code-derived)
- `person`: Email, Name, Geburtsdatum, Adresse, Telefon, Notfallkontakt, Motorsport-Historie.
- `entry`: Zuordnung zu Person/Fahrzeug/Klasse, Verifikationsstatus, Notizen, Consent-Flags.
- `consent_evidence`: Consent-Version, Consent-Hash, Locale, Guardian-Daten.
- `registration_group_email_verification`: Token + Ablauf + Verified-Zeit.
- `email_outbox`/`email_delivery`: Empfaengeradresse, Betreff, Template-Daten, Zustellstatus.
- `document`: Referenzen zu Fahrer/Entry/Event + S3-Key + Hash.
- `audit_log`: Actor-ID, Aktion, Entity-Metadaten, whitelist-gefiltertes Payload.

## Storage and Transfer
- DB: PostgreSQL (RDS).
- Binary: S3 Buckets (`assets`, `documents`).
- Mail: AWS SES.
- Auth Claims: Cognito JWT (`sub`, `email`, `groups`) runtime, teilweise als `actorUserId` persistiert.

## Data Categories with Elevated Risk
- Freitext: `motorsportHistory`, `specialNotes`, `internalNote`, `driverNote`, `templateData`.
- Kontaktdaten: Email/Telefon/Adresse.
- Minderjaehrigenkontext: Guardian-Felder in `consent_evidence`.

## ANNAHMEN
- ANNAHME: API Gateway Access Logs sind nicht als primare Datensenke fuer PII aktiviert.
- ANNAHME: Keine zusaetzliche externe Telemetrie mit Request-Bodies aktiv.
