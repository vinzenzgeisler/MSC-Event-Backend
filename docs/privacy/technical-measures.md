# Technische und organisatorische Massnahmen (TOM)

Stand: 2026-02-26

## Zugriffskontrolle
- Rollenmodell (RBAC) ueber Cognito-Gruppen: `admin`, `editor`, `viewer`.
- Autorisierung serverseitig in jeder Admin-Route.
- Trennung von Rechten:
  - `admin`: schreibende kritische Aktionen (IAM, Zahlungen, Loeschung, Retry).
  - `editor`: fachliche Bearbeitung ohne Hochrisiko-Adminfunktionen.
  - `viewer`: read-only; in Teilen redigierte Felder.
- Mandantentrennung:
  - Event-basierte Datensegmentierung.
  - ANNAHME: Kein Multi-Tenant-Isolationsmodell pro Organisation implementiert.

## Verschluesselung
- In Transit:
  - HTTPS/TLS fuer API.
  - RDS TLS erzwungen (`rds.force_ssl`).
  - S3 `enforceSSL=true`.
- At Rest:
  - RDS Storage Encryption aktiviert.
  - S3 Buckets mit Server-Side Encryption (`S3_MANAGED`).
- Empfehlung:
  - P1: Wechsel auf KMS-CMK fuer feinere Schluesselkontrolle und Schluesselrotation mit Audit-Trail.

## Secret-Management
- DB-Zugang ueber AWS Secrets Manager.
- Keine statischen DB-Passwoerter im Code-Repository.
- Rollenbasierte IAM-Berechtigungen fuer `secretsmanager:GetSecretValue`.
- Empfehlung:
  - P1: Regelmaessige Secret-Rotation und Nachweis der Rotation im Audit-Ordner.

## Audit-Logging (ohne unnoetige PII)
- Aktuell: `audit_log` mit `actorUserId`, `action`, `entityType`, `entityId`, `payload`, `createdAt`.
- Positiv:
  - revisionsorientierte Ereignisprotokollierung,
  - breite Abdeckung kritischer Admin-Aktionen.
- Minimalisierungsregeln (verbindlich):
  - keine Vollstaende von `person`/`vehicle` im Payload,
  - nur Aenderungsmarker oder IDs,
  - Notiz-/Freitextinhalte nicht in Audit-Payload spiegeln.
- Empfehlung:
  - P0: Audit-Payload-Whitelist zentral erzwingen.

## Backup- und Restore-Strategie
- Ist:
  - RDS automatische Backups aktiv (Dev 1 Tag, Prod 7 Tage).
- Ziel:
  - Prod mindestens 30 Tage Aufbewahrung.
  - Monatlicher Restore-Test mit dokumentierter Wiederanlaufzeit.
  - Restore-Runbook mit Checkliste:
    - Datenintegritaet,
    - Auth/Secrets Rebind,
    - Smoke-Test API.
- S3:
  - Bucket-Versionierung aktiv; Lifecycle-Regeln fuer Langzeitobjekte ergaenzen.

## Incident-Response (Minimalprozess)
1. Erkennung
1. Alarm durch Logs/Monitoring, Meldung durch Nutzer oder Admin.
1. Triage
1. Einstufung in Sicherheitsvorfall ja/nein; Schweregrad (P0/P1/P2).
1. Eindammung
1. Token/Secrets rotieren, betroffene Jobs stoppen, kritische Endpunkte ggf. temporar einschranken.
1. Analyse
1. Scope, betroffene Datensaetze, Zeitfenster, Root Cause.
1. Meldung
1. Datenschutzbeauftragte Stelle intern informieren; bei meldepflichtigem Vorfall 72h-Regel beachten.
1. Behebung
1. Patch, Konfigurationsaenderung, Regressionstest.
1. Nachbereitung
1. Postmortem, Massnahmenplan, Evidenzablage.

## Organisatorische Mindestmassnahmen
- Rollen- und Berechtigungskonzept dokumentiert und quartalsweise reviewt.
- Vier-Augen-Prinzip fuer produktive IAM-/Retention-Aenderungen.
- Schulungspflicht fuer Admin-Nutzer (Datenschutz + sichere Bearbeitung).
- Standardisierte Freigabeprozesse fuer neue Datenfelder und neue Exporte.

## Risiken
- P0: Fehlende zentrale technische Begrenzung von Audit-Payload-Inhalten.
- P0: Prod-DB ist laut Konfiguration oeffentlich erreichbar (`public_budget`); Risiko nur mit strikten SG-Regeln vertretbar.
- P1: Kein erzwungenes MFA-Gate serverseitig fuer alle kritischen Aktionen.
- P1: Unvollstaendige S3-Lifecycle-Konfiguration kann zu Ueberaufbewahrung fuehren.
- P2: Event-basierte Segmentierung ersetzt keine echte juristische Mandantentrennung.
