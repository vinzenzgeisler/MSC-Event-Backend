# Betroffenenrechte - Technische Umsetzung

Stand: 2026-02-26

## ANNAHMEN
- ANNAHME: Es gibt noch kein dediziertes Ticket-/Case-Management fuer DSAR-Faelle.
- ANNAHME: Identitaetspruefung fuer externe Anfragen erfolgt ueber E-Mail-Verifikation plus manuelle Plausibilisierung.

## Prozessrahmen (fuer alle Rechte)
1. Anfrageeingang erfassen (Kanal, Zeitpunkt, Identitaetsstatus).
1. Identitaet verifizieren (kein Vollzug ohne ausreichende Verifikation).
1. Datenquellen bestimmen (DB, S3-Dokumente, Outbox, Audit-Kontext).
1. Fachliche/gesetzliche Einschraenkungen pruefen (z. B. Aufbewahrungspflichten).
1. Antwort fristgerecht bereitstellen.
1. Bearbeitung revisionssicher protokollieren.

## Auskunft (Art. 15)
- Export-Mechanismus:
  - API-gestuetzter Export je betroffene Person (driver/codriver), inkl. verknuepfter Entries, Rechnungen, Kommunikationshistorie, Dokumentmetadaten.
  - Ausgabeformat: JSON + optional CSV/PDF-Zusammenfassung.
- Mindestinhalt:
  - Stammdaten, Verfahrensdaten, Consent-Felder, Statushistorie, Empfaengerkategorien, Speicherfristen.
- Technische Anforderungen:
  - Export nur fuer autorisierte DSAR-Rolle.
  - Zeitlich begrenzte Download-URL.
  - Audit-Eintrag je Export.

## Berichtigung (Art. 16)
- Korrektur ueber vorhandene Admin-Update-Mechanismen (Personen-/Entry-Felder).
- Pflicht:
  - Alte Werte nicht in Freitext protokollieren.
  - Korrekturzeitpunkt, Bearbeiter-ID, betroffene Felder auditieren.
- Konfliktregel:
  - Bei abrechnungsrelevanten Daten Korrektur mit Nachvollziehbarkeit und ggf. Rechnungskorrekturprozess koppeln.

## Loeschung (Art. 17)
- Aktueller Stand:
  - Soft Delete fuer Entries vorhanden.
- Ergaenzung fuer DSGVO:
  - Fallunterscheidung zwischen sofortiger Loeschung und Sperrung wegen gesetzlicher Aufbewahrung.
  - Hard Delete Scheduler nach Fristen (siehe `retention-policy.md`).
- Loeschprotokoll:
  - Case-ID, Rechtsgrund, Umfang, Ausfuehrungszeitpunkt, Restdaten wegen Aufbewahrungspflicht.

## Einschraenkung der Verarbeitung (Art. 18)
- Technisch als `processing_restricted`-Markierung auf Personen-/Entry-Kontext (neu einzufuehren).
- Wirkung:
  - keine Lifecycle/Broadcast-Mails,
  - keine Exporte ausser fuer rechtliche Pflichten,
  - UI-Hinweis fuer Admin.
- Aufhebung nur mit dokumentierter Entscheidung.

## Widerspruch (Art. 21)
- Fuer Verarbeitungen auf Art. 6 Abs. 1 lit. f:
  - Kommunikations-/Analyseprozesse sofort stoppen, soweit keine zwingenden Gruende.
- Technisch:
  - `objection_flag` auf Personenkontext (neu),
  - Filter in Mail-Queues und Exportjobs beachten.

## Datenuebertragbarkeit (Art. 20)
- Bereitstellung strukturierter Daten im maschinenlesbaren Format (JSON/CSV).
- Umfang:
  - vom Betroffenen bereitgestellte Daten und abgeleitete Basisstatus.
- Sicherheit:
  - starke Zugriffskontrolle,
  - zeitlich begrenzte Bereitstellung,
  - Protokollierung des Downloads.

## Protokollierung der Bearbeitung (Accountability)
- Verbindlicher DSAR-Protokollsatz (neu, separate Tabelle `data_subject_request` empfohlen):
  - `id`, `requestType`, `receivedAt`, `requesterIdentityLevel`, `subjectReference`,
  - `status`, `dueAt`, `closedAt`, `handledBy`, `legalBasisDecision`,
  - `actionsTaken`, `responseChannel`, `attachmentsRef`.
- Jeder Statuswechsel auditpflichtig.

## Service-Level und Fristen
- Standard: Antwort innerhalb 30 Kalendertagen.
- Verlaengerung um max. 60 Tage nur mit dokumentierter Begruendung und Zwischenmitteilung.
- Automatischer Fristmonitor (taeglicher Job) fuer offene DSAR-Faelle.

## Risiken
- P0: Ohne dedizierte DSAR-Falltabelle fehlt belastbare Ende-zu-Ende-Nachweisfaehigkeit.
- P0: Fehlende technische Restriktions-/Widerspruchsflags verhindern konsistente Umsetzung von Art. 18/21.
- P1: Auskunftsexporte ohne feste Feld-Whitelist koennen ueber- oder unterliefern.
- P2: Identitaetspruefung rein manuell ist fehleranfaellig und langsam.
