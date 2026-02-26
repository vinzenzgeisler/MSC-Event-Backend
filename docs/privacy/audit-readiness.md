# Pruefungsvorbereitung (Audit Readiness)

Stand: 2026-02-26

## Zielbild
Jede datenschutzrelevante Verarbeitung muss mit Dokument + technischem Nachweis + Versionsstand belegt werden koennen.

## Vorzeigbare Dokumente
- Dateninventar und Datenfluss (`data-inventory.md`).
- Verzeichnis von Verarbeitungstaetigkeiten (`processing-activities.md`).
- Speicher- und Loeschkonzept (`retention-policy.md`).
- TOM-Dokument (`technical-measures.md`).
- Betroffenenrechte-Umsetzung (`data-subject-rights.md`).
- Frontend-Anforderungen (`frontend-requirements.md`).
- Architektur-/Handover-Dokumente aus `docs/phase4-handover.md`, `docs/phase5-handover.md`, `docs/phase6-handover.md`.

## Logs und technische Nachweise
- Datenbank-Audit:
  - `audit_log` Eintraege fuer Statuswechsel, Loeschung, Dokument-/Export-/Mail-Aktionen.
- Kommunikationsnachweise:
  - `email_outbox`, `email_delivery` inkl. Zustellstatus.
- Dokumentintegritaet:
  - `document.sha256` + S3-Objektreferenz.
- Betriebsnachweise:
  - CloudWatch Logs (API/Worker),
  - IaC-Konfiguration (CDK) fuer Verschluesselung/Backup.
- Restore-/Backup-Nachweis:
  - RDS Backup-Retention-Konfiguration,
  - dokumentierte Restore-Tests (noch als Pflicht einzufuehren).

## Consent-Nachweis-Strategie
- Ist:
  - `entry`: `consentTermsAccepted`, `consentPrivacyAccepted`, `consentMediaAccepted`, `consentVersion`, `consentCapturedAt`.
- Ziel fuer Pruefungstauglichkeit:
  - Consent-Ereignis als eigene, append-only Nachweistabelle.
  - Mindestfelder:
    - Zeitstempel,
    - Betroffenenreferenz (`entryId`, `email`),
    - Rechtstext-Version und Hash,
    - Locale,
    - Erhebungsquelle (public form/admin override),
    - optional IP nur bei nachweisbarer technischer Erforderlichkeit.

## Versionierung von Rechtstexten
- Verbindlich:
  - jede Aenderung an Datenschutzhinweis/AGB als versioniertes Artefakt.
- Implementierung:
  - Tabelle `legal_text_version` (neu) mit:
    - `id`, `type` (`privacy`, `terms`, `media`),
    - `version`,
    - `sha256`,
    - `effectiveFrom`,
    - `contentLocation` (immutable storage),
    - `createdAt`, `createdBy`.
- Consent verweist auf konkrete Version+Hash.

## AV-Vertraege (Liste externer Dienstleister)
- Amazon Web Services (AWS):
  - RDS (Datenbank),
  - S3 (Dateispeicher),
  - SES (E-Mail-Versand),
  - Cognito (Admin-Authentisierung),
  - CloudWatch (Logging),
  - Lambda / EventBridge / API Gateway / Secrets Manager (Betriebsplattform).
- Fuer jeden Dienst:
  - AVV/DPA hinterlegt,
  - Datenkategorien,
  - Speicherort/Region,
  - TOMs und Subunternehmerreferenzen.

## Evidenz-Checkliste je Audit
- Aktuelle Fassungen aller Datenschutzdokumente.
- Export aus `audit_log` (Stichprobe kritischer Aktionen).
- Stichprobe Consent-Nachweise inkl. Textversion.
- Nachweis von Loeschlaeufen (Purge-Reports) und S3-Lifecycle.
- Nachweis Backup-Retention + letzter Restore-Test.
- Rollenreview (wer hat `admin` Rechte, wann geprueft).
- Incident- und DSAR-Fallprotokolle der letzten 12 Monate.

## Risiken
- P0: Consent-Nachweis ohne Text-Hash/Locale/Versionierung ist nur bedingt gerichtsfest.
- P0: Fehlende standardisierte Purge-Reports erschweren Nachweis der Speicherbegrenzung.
- P1: Ohne dokumentierte Restore-Uebungen bleibt Verfuegbarkeitsnachweis schwach.
- P1: AV-Vertragsregister muss zentral gepflegt werden; sonst Pruefungsluecke.
- P2: Uneinheitliche Ablageorte von Evidenzen erhoehen Audit-Aufwand.
