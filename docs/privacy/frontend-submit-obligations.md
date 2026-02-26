# Frontend-Pflichtinformationen vor Datenversand

Stand: 2026-02-26

## Ziel
Der Nutzer muss vor Absenden der Anmeldung transparent verstehen, welche Daten verarbeitet werden, warum das passiert, wie lange gespeichert wird und welche Rechte bestehen.

## Muss direkt vor dem Senden sichtbar sein
1. Kurz-Informationspflicht in Klartext (keine reine Link-Lösung).
2. Link auf Datenschutzerklärung.
3. Link auf Teilnahmebedingungen/AGB.
4. Hinweis: Minderjaehrige nur mit Zustimmung eines Sorgeberechtigten.
5. Pflicht-Checkboxen:
1. `Ich akzeptiere die Teilnahmebedingungen.`
2. `Ich habe die Datenschutzhinweise gelesen und akzeptiere die Datenverarbeitung zur Veranstaltungsabwicklung.`
6. Optionale Checkbox:
1. `Ich willige in die Nutzung von Foto-/Videomaterial für Veranstaltungsbericht, Vereinswebsite und Vereins-Social-Media-Kanäle ein.`

## Muss technisch an Backend gesendet werden (Consent-Nachweis)
1. `termsAccepted` (true).
2. `privacyAccepted` (true).
3. `mediaAccepted` (boolean, optional, default false).
4. `consentVersion` (z. B. `privacy-v1.0+terms-v1.0+media-v1.0`).
5. `consentTextHash` (SHA-256 der genau angezeigten Textfassung).
6. `locale` (z. B. `de-DE`).
7. `consentSource` (`public_form`).
8. `consentCapturedAt` (ISO-8601 UTC).

## Kurz-Informationspflicht (UI-Textbaustein V1)
Mit Absenden der Anmeldung verarbeiten wir Ihre angegebenen personenbezogenen Daten zur Durchfuehrung und Abwicklung der Veranstaltung (Anmeldung, Teilnehmerverwaltung, Kommunikation, Dokumentenerstellung, Abrechnung). Rechtsgrundlage ist Art. 6 Abs. 1 lit. b DSGVO; soweit gesetzliche Aufbewahrungspflichten bestehen, erfolgt die Verarbeitung zusaetzlich nach Art. 6 Abs. 1 lit. c DSGVO. Optionale Medienverarbeitung erfolgt nur auf Basis Ihrer Einwilligung nach Art. 6 Abs. 1 lit. a DSGVO. Empfaenger sind nur intern zustaendige Stellen sowie technische Auftragsverarbeiter innerhalb von AWS in der Region eu-central-1. Ihre Rechte auf Auskunft, Berichtigung, Loeschung, Einschraenkung, Widerspruch und Datenuebertragbarkeit bleiben unberuehrt.

## Validierungsregeln (Frontend)
1. Submit ohne beide Pflichtcheckboxen blockieren.
2. `mediaAccepted` darf nicht vorausgewaehlt sein.
3. Wenn Fahrer unter 18 ist, Pflichtfelder fuer Sorgeberechtigte anzeigen und erzwingen:
1. `guardianFullName`
2. `guardianEmail`
3. `guardianPhone`
4. `guardianConsentAccepted=true`
4. Rechtstextlinks muessen vor Submit erreichbar sein.
5. Ohne gueltigen `consentTextHash` kein Request.
6. Bei fehlendem `locale` kein Request.

## Logging-Regeln im Client
1. Keine PII in Browser-Konsole oder Telemetrieevents.
2. Keine Speicherung von Geburtsdatum, Adresse, Notfallkontakt, Token in Frontend-Logs.
3. Nur technische Fehlercodes und Request-ID loggen.
