# Speicher- und Loeschkonzept

Stand: 2026-02-26

## Grundsaetze
- Datenminimierung: Nur zwecknoetige Felder speichern.
- Zweckbindung: Loesch-/Anonymisierungsfristen pro Verarbeitung.
- Nachweisbarkeit: Loeschaktionen als Audit-Eintrag protokollieren.
- Trennung operativ vs. revisionsrelevant: Operative Daten frueher minimieren, Nachweisdaten kontrolliert laenger halten.

## ANNAHMEN
- ANNAHME: Keine aktuell aktive zentrale Purge-Pipeline fuer alle Tabellen.
- ANNAHME: Event-Ende (`event.endsAt`) ist primarer Fristenanker.

## Fristen je Datenkategorie

| Datenkategorie / Tabellen | Frist | Begruendung | Loesch-/Pseudonymisierungsmodus |
|---|---|---|---|
| Teilnehmer-Stammdaten (`person`) in Bezug auf aktive/archivierte Entries | 3 Jahre nach Eventende | Operative Rueckfragen, Reklamationen | Nach Frist pseudonymisieren, bei fehlenden Referenzen hard delete |
| Nennungsdaten (`entry`, `registration_group`) | 3 Jahre nach Eventende | Veranstaltungsdurchfuehrung + moderate Nachlaufzeit | Zunaechst Soft Delete, danach hard delete |
| Notizen (`specialNotes`, `internalNote`, `driverNote`) | 12 Monate nach Eventende | Erhoehte Sensitivitaet, kein Dauerbedarf | Fruehzeitige Feldanonymisierung/Leeren |
| Verifikationsdaten (`*_email_verification`) | 30 Tage nach `expiresAt` oder `verifiedAt` | Sicherheitszweck nur kurzzeitig | Hard delete |
| Idempotenzspeicher (`public_entry_submission`) | 30 Tage | Duplicate-Schutz kurzfristig ausreichend | Hard delete |
| Fahrzeugbild-Upload-Metadaten (`vehicle_image_upload`) | 30 Tage nach Abschluss/Verfall | Nur Upload-Prozesssteuerung | Hard delete |
| Fahrzeugbilder in S3 (`assets`) | 3 Jahre nach Eventende, dann Anonymisierungspruefung | Dokumentation Teilnahmefahrzeug | Loeschung Objekt + Entfernen DB-Referenz |
| Dokumentmetadaten/PDF (`document`, `documents` Bucket) | 6 Jahre | Nachweis- und Organisationsinteresse | Hard delete nach Frist, ggf. Sperrvermerk-Verlaengerung |
| Rechnung/Zahlung (`invoice`, `invoice_payment`) | 10 Jahre | Steuer-/Abgabenrechtliche Aufbewahrung | Keine fruehzeitige Loeschung; nach Frist hard delete/anonymisieren |
| E-Mail-Outbox/Delivery (`email_outbox`, `email_delivery`) | 12 Monate | Kommunikationsnachweis und Zustellanalyse | Hard delete, Fehlertexte frueher minimieren (90 Tage) |
| Exporte (`export_job` + exportierte CSV in S3) | 90 Tage | Operative Auswertung, geringe Dauer notwendig | Hard delete Objekt + Jobdaten |
| Audit-Log (`audit_log`) | 24 Monate | Accountability, Missbrauchsaufklaerung | Hard delete oder irreversible Pseudonymisierung von Payload |
| CloudWatch Application Logs | 30 Tage (Standard), 90 Tage Security-relevant | Betriebsfaehigkeit/Sicherheitsanalyse | Automatische Log-Retention |
| API Access Logs (falls aktiviert) | 14-30 Tage | Netz-/Security-Analyse | Automatische Log-Retention, IP minimiert |
| DB Backups (RDS) | Prod Ziel: 30 Tage; Dev: 1 Tag | Wiederherstellung / BCM | Automatischer Ablauf durch Backup-Retention |

## Soft Delete vs. Hard Delete
- Soft Delete ist fachlich fuer `entry` und `registration_group` vorgesehen (`deletedAt`, `deletedBy`, `deleteReason`).
- Hard Delete muss nach Frist automatisiert erfolgen fuer:
  - `entry`, `registration_group` (inkl. Aufraeumen verwaister Referenzen),
  - Verifikations-/Outbox-/Job-Tabellen,
  - Export-/Upload-Metadaten.
- Finanzdaten bleiben bis Fristende erhalten, danach kontrolliertes Hard Delete oder Finanz-Archiv mit starker Zugriffsbeschraenkung.

## Anonymisierungskonzept
- Pseudonymisierung fuer langfristige Statistik:
  - `person.email` -> gehashter Wert (salted, nicht rueckrechenbar),
  - Namen/Adresse/Telefon/Notfallkontakt -> Nullung,
  - `motorsportHistory`/Notizfelder -> Nullung.
- Beibehaltung nur aggregationsrelevanter Daten:
  - Event, Klasse, Zahlungsstatus (ohne direkte Personenidentifikatoren), technische Statusdaten.
- Audit-`payload`: nur Whitelist-Felder, keine Volltexte mit PII.

## Log-Retention (konkret in Tagen)
- CloudWatch App-Logs: 30 Tage.
- Security-relevante Logs (Auth-/Admin-Fehler, Incident-Faelle): 90 Tage.
- API Access Logs (falls aktiviert): 14 bis 30 Tage.
- Audit-Log (DB): 730 Tage (24 Monate).

## Backup-Retention
- Ist-Zustand laut Infra:
  - Dev: 1 Tag.
  - Prod: 7 Tage.
- Zielzustand:
  - Prod auf 30 Tage anheben.
  - Monatlicher Restore-Test in isolierter Umgebung.
  - Restore-Protokoll revisionssicher ablegen.

## Technische Umsetzung
- Geplanter taeglicher Purge-Job (EventBridge + Lambda) mit konfigurierbaren Retention-Parametern.
- SQL-gestuetzte Purge-Sequenz:
  - zuerst abhaengige Tabellen (`*_verification`, `email_delivery`, `invoice_payment` wo zulaessig),
  - danach Haupttabellen.
- DB-Schutz:
  - FK-Constraints beibehalten, Purge in transaktionalen Schritten,
  - Index auf Fristfelder (`createdAt`, `expiresAt`, `deletedAt`) fuer performante Loeschlaeufe.
- S3-Lifecycle-Regeln:
  - automatische Loeschung fuer Exportartefakte nach 90 Tagen,
  - Lifecycle fuer Upload-Reste und alte Dokumentversionen.
- Audit fuer Loeschlaeufe:
  - je Lauf Anzahl geloeschter Datensaetze je Tabelle,
  - Fehler-/Abbruchgrunde.

## Risiken
- P0: Ohne automatisierte Purge-Jobs liegt ein klarer DSGVO-Compliance-Gap vor (Speicherbegrenzung).
- P0: Prod-Backup-Retention 7 Tage ist fuer robuste Wiederherstellung und Nachweislage knapp.
- P1: Fehlende Feld-Whitelists in Audit-Payload koennen Datenminimierung unterlaufen.
- P2: Ohne S3-Lifecycle-Regeln drohen unkontrolliert lange Objektaufbewahrungen.
