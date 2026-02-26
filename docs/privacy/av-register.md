# AV-Register (Externe Dienstleister)

Stand: 2026-02-26

| Dienstleister | Dienst | Zweck | Datenkategorien | Region | Rechtsrolle |
|---|---|---|---|---|---|
| AWS | RDS PostgreSQL | Transaktionale Datenspeicherung | Personen-, Prozess-, Abrechnungs-, Auditdaten | eu-central-1 | Auftragsverarbeiter |
| AWS | S3 | Dokumente, Upload-Artefakte | Dokumentinhalte, Dateimetadaten | eu-central-1 | Auftragsverarbeiter |
| AWS | SES | E-Mail-Zustellung | E-Mail-Adresse, Template-Inhalte, Zustellstatus | eu-central-1 | Auftragsverarbeiter |
| AWS | Cognito | Admin-Authentisierung/Autorisierung | Benutzer-ID, E-Mail, Rollen | eu-central-1 | Auftragsverarbeiter |
| AWS | CloudWatch | Betriebs-/Sicherheitslogging | Technische Logdaten, Fehlerkontext | eu-central-1 | Auftragsverarbeiter |
| AWS | Lambda/EventBridge/API Gateway/Secrets Manager | Ausfuehrungsplattform | Technische Betriebsdaten, Secret-Zugriff | eu-central-1 | Auftragsverarbeiter |

## Vertragsstatus
1. AVV/DPA mit AWS erforderlich und zu dokumentieren.
2. Verantwortlicher prueft regelmaessig Subprozessor-Liste und TOM-Aenderungen.
