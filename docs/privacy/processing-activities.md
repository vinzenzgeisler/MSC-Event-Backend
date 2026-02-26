# Verzeichnis von Verarbeitungstaetigkeiten (Art. 30 DSGVO)

Stand: 2026-02-26

## ANNAHMEN
- ANNAHME: Verantwortlicher ist der Betreiber der Verwaltungssoftware (Vereins-/Eventorganisation).
- ANNAHME: Keine gesonderte Verarbeitung fuer Marketing-Tracking (Default: kein Tracking).

## VVT-Tabelle

| Verarbeitungstaetigkeit | Zweck | Betroffene Personen | Datenkategorien | Rechtsgrundlage (Art. 6 DSGVO) | Empfaenger / Dritte | Speicherfrist | Loeschtrigger | Technische Schutzmassnahmen |
|---|---|---|---|---|---|---|---|---|
| Event- und Klassenverwaltung | Planung und Durchfuehrung von Veranstaltungen | Organisatoren, Teilnehmer indirekt | Event-/Klassenmetadaten, Kontakt-E-Mail Event | Art. 6 Abs. 1 lit. b, lit. f | Interne Admin-Nutzer | 6 Jahre nach Eventende | Event archiviert + Frist abgelaufen | RBAC, Audit-Log, TLS, DB-Zugriff nur App |
| Oeffentliche Anmeldung | Entgegennahme von Nennungen | Fahrer, Beifahrer, Notfallkontakte | Identitaets-, Kontakt-, Fahrzeug-, Notiz-, Consent-Daten | Art. 6 Abs. 1 lit. b; fuer optionale Mediennutzung lit. a | Interne Admin-Nutzer, IT-Provider | 3 Jahre nach Eventende (operative Daten) | Frist erreicht oder gueltiger Loeschantrag | Input-Validierung, Soft Delete, Audit, DB-Constraints |
| E-Mail-Verifikation | Sicherstellung gueltiger Kontaktadresse | Fahrer | E-Mail, Verifikations-Token, Zeitstempel | Art. 6 Abs. 1 lit. b, lit. f | AWS SES (Transport), AWS Infrastruktur | Token: 30 Tage, Verifikationsmetadaten: 12 Monate | `verifiedAt` gesetzt + Frist oder `expiresAt` + Frist | Token-Rotation, kurze Token-Laufzeit, Audit |
| Kommunikationsversand (Lifecycle/Broadcast/Reminder) | Teilnehmerkommunikation zum Verfahrensstatus | Fahrer (teilw. Beifahrer indirekt) | E-Mail-Adresse, Template-Daten, Versandstatus, Providerantwort | Art. 6 Abs. 1 lit. b, lit. f | AWS SES | Outbox/Delivery: 12 Monate | Versand abgeschlossen + Frist | Outbox-Pattern, Retry mit Limit, Audit, TLS |
| Abrechnung und Zahlungserfassung | Gebuehrenberechnung und Zahlungsstatus | Fahrer | Rechnungs- und Zahlungsdaten, Bearbeiterkennung | Art. 6 Abs. 1 lit. b, lit. c | Steuer-/Pruefstellen (fallbezogen), Zahlungsdienst im Offline-Prozess | 10 Jahre | Ablauf gesetzlicher Aufbewahrung | Audit, Rollenrechte (nur Admin), Integritaetspruefungen |
| Dokumenterzeugung (Waiver/Tech Check) | Bereitstellung unterschrifts-/pruefrelevanter Unterlagen | Fahrer, Beifahrer | Dokumentmetadaten, PDF-Inhalte, Hash, S3-Key | Art. 6 Abs. 1 lit. b, lit. f | Interne Nutzer, AWS S3 | 6 Jahre (oder laenger bei Anspruchsabwehr) | Frist erreicht, kein laufendes Verfahren | Hash-Speicherung, presigned URL, Bucket Encryption |
| Exporte (CSV) | Operative Verarbeitung/Pruefung | Fahrer, Beifahrer | Exportfilter, Exportdatei, Jobstatus | Art. 6 Abs. 1 lit. f | Interne Rollen (viewer/admin), AWS S3 | 90 Tage | Export abgeschlossen + 90 Tage | Rollenpruefung, kurzlebige Download-URLs, Audit |
| Check-in und technische Abnahme | Veranstaltungsdurchfuehrung und Sicherheit | Fahrer, Beifahrer | Verifikationsstatus, Tech-Status, Bearbeiterkennung | Art. 6 Abs. 1 lit. b, lit. f | Interne Check-in/Technikrollen | 3 Jahre | Eventende + Frist | RBAC, Audit-Log, Datenminimierung in Views |
| IAM-Nutzerverwaltung | Zugriffsteuerung Admin-Bereich | Admin-User | Benutzerkennung, Rollen, Status, MFA-Status | Art. 6 Abs. 1 lit. f, lit. c | AWS Cognito | Solange Benutzerkonto aktiv + 12 Monate Audit | Deprovisionierung + Frist | Cognito JWT, Gruppenrollen, least privilege |
| Audit-Logging | Nachweisbarkeit und Missbrauchserkennung | Admin-User, indirekt Teilnehmer bei Entity-Bezug | Actor-ID, Action, Entity-Referenz, Payload, Zeitstempel | Art. 6 Abs. 1 lit. c, lit. f | Interne Revision, ggf. Behoerden | 24 Monate | Frist erreicht, keine Sperrgruende | Schreibender Audit-Trail, Zugriffsbeschraenkung |
| Betriebs-/Fehlerlogging | Betriebssicherheit und Stoerungsanalyse | Admin-User/Teilnehmer indirekt | Technische Logdaten, Fehlerkontext, Request-ID | Art. 6 Abs. 1 lit. f | AWS CloudWatch, Ops-Team | 30 Tage (Anwendung), 90 Tage (Security-relevant) | Frist erreicht | Log-Scrubbing, keine Body-Dumps, Zugriff nur Ops |
| Backup und Wiederherstellung | Verfuegbarkeit/Resilienz | Alle in DB gespeicherten Betroffenen | Vollstaendiger DB-Stand in Backup-Sets | Art. 6 Abs. 1 lit. c, lit. f | AWS RDS Backup-Speicher | Dev: 1 Tag, Prod: 7 Tage (Ist), Ziel: 30 Tage Prod | Automatische Ablaufzeit | Verschluesselung at rest, Restore-Testprozess |

## Risiken
- P0: Backup-Aufbewahrung in Prod (7 Tage) kann fuer Nachweis-/Wiederherstellungsanforderungen zu kurz sein.
- P0: Fehlende dokumentierte automatisierte Loeschjobs fuer mehrere Verarbeitungen.
- P1: Audit-`payload` ist JSON-frei; ohne Whitelisting droht PII-Uebererfassung.
- P2: Rechtsgrundlage fuer optionale Medienverarbeitung muss im Frontend klar getrennt von Pflicht-Consents sein.
