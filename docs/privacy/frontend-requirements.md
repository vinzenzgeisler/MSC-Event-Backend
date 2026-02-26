# Verbindliche Anforderungen an Frontend-Agent

Stand: 2026-02-26

## Ziel
Das Frontend muss Datenschutz- und Nachweisanforderungen technisch durchsetzbar umsetzen und darf keine nicht freigegebene Datenerhebung einfuehren.

## Consent-Checkboxen
- Pflicht-Consents (Submit blockierend):
  - Teilnahmebedingungen/AGB akzeptiert.
  - Datenschutzerklaerung akzeptiert.
- Optionale Consents:
  - Medien-/Fotoeinwilligung getrennt und nicht vorausgewaehlt.
- Widerrufbarkeit:
  - optionale Einwilligungen jederzeit widerrufbar.
  - Pflicht-Consents nur mit Folgenhinweis (ohne Mindestconsent keine Teilnahmeabwicklung moeglich).

## Nachweis-Speicherung (pro Consent-Ereignis)
- Erforderliche Felder:
  - `timestamp` (ISO 8601, UTC),
  - `userId` oder `email` (bei oeffentlicher Anmeldung mindestens E-Mail),
  - `textVersionHash` (SHA-256 der angezeigten Rechtstextfassung),
  - `locale` (z. B. `de-DE`),
  - `consentType` und `granted` (true/false bei optionalen Consents),
  - `source` (`public_form`, `admin_ui`).
- IP-Adresse:
  - nur speichern, wenn technisch erforderlich und begruendet.
  - ohne dokumentierte Notwendigkeit keine IP-Persistenz.

## Platzierung und Informationspflicht
- Im Formular unmittelbar vor finalem Submit:
  - Link zu AGB.
  - Link zur Datenschutzerklaerung.
  - Kurz-Informationspflicht (Zwecke, Rechtsgrundlagen, Speicherfristen in Kurzform).
- Rechtstexte muessen in neuer Registerkarte oeffnen und versioniert referenzierbar sein.

## Cookie- und Tracking-Regeln
- Default: kein Tracking, keine Marketing-Cookies.
- Erlaubt ohne Consent:
  - technisch notwendige Session-/Sicherheitsmechanismen.
- Nicht erlaubt ohne explizite Einwilligung:
  - Analytics, Fingerprinting, Third-Party Tracker.
- Bei Einfuehrung von Tracking:
  - Consent-Banner mit granularer Auswahl,
  - Nachweis je Entscheidung,
  - jederzeitige Aenderbarkeit in den Einstellungen.

## UI fuer Betroffenenrechte
- Sichtbarer Bereich "Datenschutz / Rechte" im oeffentlichen und Admin-nahen Kontext.
- Funktionen:
  - Anfrage auf Auskunft/Berichtigung/Loeschung/Einschraenkung/Widerspruch/Datenuebertragbarkeit.
  - Statusanzeige eingereichter Anfragen (mind. Referenz-ID + Eingangsdatum).
- Keine sensiblen Details ohne Authentisierung anzeigen.

## Accessibility-Anforderungen
- WCAG 2.1 AA mindestens:
  - Tastaturbedienbarkeit fuer alle Consent-Elemente,
  - klare Fokus-Indikatoren,
  - korrekte Label-Zuordnung,
  - Screenreader-kompatible Fehlermeldungen.
- Sprache/Locale muss explizit gesetzt sein und in Consent-Nachweis einfliessen.

## Logging-Anforderungen (Client)
- Keine unnoetige PII in Client-Logs, Analytics-Events oder Error-Tracking.
- Verboten im Client-Log:
  - vollstaendige Namen, Adresse, Geburtsdatum, Notizen, Verifikations-Token.
- Erlaubt:
  - technische Event-IDs, Fehlercodes, UI-Schritt, Zeitstempel.
- Redaction:
  - Formulardaten vor Logging maskieren oder komplett ausschliessen.

## Verbindliche API-Vertragsanforderungen ans Backend
- Consent-Payload muss mindestens enthalten:
  - `termsAccepted`, `privacyAccepted`, `mediaAccepted`,
  - `consentVersion`,
  - `consentCapturedAt`.
- Erweiterungspflicht (P0):
  - `consentTextHash`,
  - `locale`,
  - `consentSource`,
  - optional `ipAddress` nur bei begruendeter Erforderlichkeit.

## Risiken
- P0: Ohne `textVersionHash` und `locale` ist Consent-Nachweis nicht hinreichend belastbar.
- P0: Jede implizite Tracking-Integration ohne Consent waere ein schwerer Compliance-Verstoss.
- P1: Fehlende Accessibility bei Consent-Elementen kann Wirksamkeit der Einwilligung beeintraechtigen.
- P1: Client-Error-Logs mit PII fuehren zu unkontrollierter Datenweitergabe.
- P2: Fehlende Betroffenenrechte-UI erhoeht manuelle Aufwaende und Frist-Risiken.
