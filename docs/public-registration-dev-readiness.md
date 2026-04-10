# Public Registration Dev Readiness

Diese Runbook-Datei dient der Dev-Abnahme des öffentlichen Anmeldeprozesses bis zur bestätigten Fahrer-Mail.

## Ziel

Vor Go-Live muss Dev nachweisen:

- Fahrer-, Fahrzeug-, Beifahrer- und Guardian-Daten werden vollständig und korrekt erfasst.
- Die öffentliche Anmeldung funktioniert vom Formular bis zur bestätigten E-Mail.
- Die Fahrerkommunikation ist fachlich klar, vollständig und statusgerecht.
- Dev-/Prod-Verwechslungen bei API, Redirects und Verify-Links sind ausgeschlossen.

## Voraussetzungen

- Dev läuft im `test`-Profil.
- Es gibt ein aktuelles offenes Event mit mindestens einer `auto`- und einer `moto`-Klasse.
- Pricing Rules, Zeitfenster und Mail-Templates sind gepflegt.
- Dev-Frontend und Dev-Backend zeigen aufeinander.
- Die vier Testmails werden beim Script-Aufruf als Parameter übergeben.

## Automatisierter Kernlauf

Script:

```powershell
pwsh ./scripts/public-registration-dev-readiness.ps1 `
  -AdminUsername "<admin-login>" `
  -AdminPassword "<admin-passwort>" `
  -EmailDe "de@example.org" `
  -EmailEn "en@example.org" `
  -EmailCs "cs@example.org" `
  -EmailPl "pl@example.org"
```

Der Lauf erledigt:

- Admin-Login gegen Dev-Cognito
- Laden des aktuellen Public-Events
- Laden der veröffentlichten Consent-Metadaten über `GET /public/legal/current`
- Bereinigung alter Dev-Nennungen für die Testmails
- öffentliche Registrierung für diese Szenarien:
  - `de-happy-moto`
  - `en-doublestarter-auto`
  - `cs-minor-moto`
  - `pl-codriver-backup-auto`
- Preview der Mails `registration_received` und je nach Szenario `email_confirmation_reminder`
- automatische Verifikation für ausgewählte Szenarien über den zurückgegebenen Verify-Token
- Status- und Detailprüfung über Admin-Endpunkte
- Abgleich, dass gespeicherte Consent-Version und Consent-Hash mit der veröffentlichten Fassung übereinstimmen
- Ablage von JSON-, Text- und HTML-Artefakten unter `artifacts/public-registration-dev-readiness/<timestamp>/`

Wichtige Artefakte:

- `summary.json`
- `summary.md`
- pro Szenario:
  - `public-legal-current.json`
  - `request.json`
  - `create-response.json`
  - `*.detail.json`
  - `registration_received.*`
  - `email_confirmation_reminder.*`

## Manuelle Inbox- und Kommunikationsabnahme

Der automatisierte Lauf ersetzt nicht die echte Fahrerperspektive. Diese Punkte müssen manuell geprüft und im Testprotokoll als `Pass/Fail` markiert werden.

### Inbox

- Die Mail kommt im richtigen Postfach an.
- Absender, Betreff und Preheader passen.
- Die Mail landet nicht offensichtlich im Spam.
- Der CTA ist sichtbar und eindeutig.
- Der Verify-Link funktioniert im echten Mailclient.

### registration_received

- Es ist klar, dass die Anmeldung eingegangen ist.
- Es ist klar, dass die E-Mail noch bestätigt werden muss.
- Es wirkt nicht wie eine Zulassung oder Startfreigabe.
- Der Fahrer weiß, was er jetzt konkret tun muss.
- Der Fahrer versteht, dass ohne Verifikation der Prozess nicht vollständig ist.

### email_confirmation_reminder

- Der Reminder passt fachlich zum offenen Verifikationsstatus.
- Der Reminder ist verständlich und nicht zu technisch.
- Der Reminder erklärt denselben Schritt konsistent wie die Erstmail.
- Der CTA und die Formulierung sind nicht missverständlich oder aggressiv.

### Verify-Zielseite

- Erfolg ist sofort erkennbar.
- Abgelaufene oder ungültige Links sind verständlich erklärt.
- Die Seite nutzt die richtige Dev-Domain.
- Die Seite wirkt nicht wie ein technischer Fehlerzustand.

## Kritische Go-/No-Go-Fälle

Diese Fälle müssen grün sein:

- Happy Path `moto`
- Happy Path `auto`
- Doppelstarter
- Beifahrer
- Minderjähriger Fahrer
- Verifikation per echter Mail
- Reminder-/Resend-Pfad
- Statuswechsel auf `submitted_verified`
- Consent-/Nachvollziehbarkeit
- Datenvollständigkeit in der Admin-Detailansicht
- alle vier Mailsprachen `de`, `en`, `cs`, `pl`

## Vollständige Dev-Checkliste

### A. Environment und Setup

- [ ] Dev-Frontend nutzt nur Dev-Runtime-Config
- [ ] Dev-Frontend nutzt nur Dev-API
- [ ] Dev-Cognito funktioniert mit Dev-Redirects
- [ ] Verify-Links zeigen auf Dev
- [ ] `GET /public/events/current` liefert offenes Event
- [ ] Pricing ist gepflegt
- [ ] Mail-Templates rendern ohne fehlende Variablen
- [ ] Mailversand funktioniert grundsätzlich
- [ ] Migrationen sind vollständig
- [ ] Dev bleibt nach Redeploy stabil

### B. Datenerfassung

- [ ] Happy Path `moto`
- [ ] Happy Path `auto`
- [ ] Doppelstarter
- [ ] Beifahrer
- [ ] Ersatzfahrzeug
- [ ] Minderjähriger Fahrer
- [ ] Fahrer-Pflichtfelder
- [ ] Fahrzeug-Pflichtfelder
- [ ] Start-Pflichtfelder
- [ ] ungültige E-Mail
- [ ] ungültige Startnummer
- [ ] ungültiges Geburtsdatum
- [ ] Klasse/Fahrzeugtyp-Mismatch
- [ ] Motorrad-spezifische Felder
- [ ] Auto-spezifische Felder
- [ ] Sonderzeichen/Umlaute
- [ ] Grenzwerte bei Freitexten
- [ ] manipulierte Payload ohne Pflichtfelder
- [ ] manipulierte Payload mit Zusatzwerten

### C. Preis- und Eventlogik

- [ ] vor Öffnung blockiert
- [ ] nach Schließung blockiert
- [ ] Frühphase korrekt
- [ ] Spätphase korrekt
- [ ] Zweitrabatt korrekt
- [ ] Event ohne Klassen nicht freigabefähig
- [ ] `draft` blockiert
- [ ] `open` erlaubt
- [ ] `closed` blockiert

### D. Persistenz und Vollständigkeit

- [ ] Fahrerdaten vollständig
- [ ] Fahrzeugdaten vollständig
- [ ] Beifahrerdaten vollständig
- [ ] Guardian-Daten vollständig
- [ ] Ersatzfahrzeugdaten vollständig
- [ ] Consent-Evidence vollständig
- [ ] Consent-Version entspricht `GET /public/legal/current`
- [ ] Consent-Hash entspricht `GET /public/legal/current`
- [ ] `orgaCode` gesetzt
- [ ] Zahlungsreferenz enthält `paymentReferencePrefix-orgaCode`
- [ ] keine Dublette bei identischer Submission
- [ ] sauberer Konflikt bei paralleler Startnummer
- [ ] Reload erzeugt keinen kaputten Zustand
- [ ] Admin-Detailansicht stimmt mit Formular überein
- [ ] keine fachlich später fehlende Pflichtinformation

### E. E-Mail und Verifikation

- [ ] `registration_received` in Outbox
- [ ] Worker verarbeitet Mail
- [ ] Gmail zustellbar
- [ ] GMX zustellbar
- [ ] iCloud zustellbar
- [ ] Domain-Mail zustellbar
- [ ] Verify-Link klickbar
- [ ] Verify-Link landet auf Dev
- [ ] erfolgreiche Verifikation
- [ ] `confirmation_mail_verified_at` gesetzt
- [ ] zweiter Klick sauber behandelt
- [ ] ungültiger Token sauber behandelt
- [ ] abgelaufener Token sauber behandelt
- [ ] `verification-resend` funktioniert
- [ ] Resend für bestätigte Nennung sauber behandelt
- [ ] Reminder-Mail fachlich korrekt
- [ ] Reminder-Link funktioniert
- [ ] Mailfehler führt nicht zu stillem Erfolg

### F. Kommunikation

- [ ] `registration_received` erklärt Eingang klar
- [ ] Mail erklärt Verifikationspflicht klar
- [ ] Mail wirkt nicht wie Zulassung
- [ ] CTA ist eindeutig
- [ ] nächster Schritt ist klar
- [ ] Folgen bei Nichtbestätigung sind klar
- [ ] Reminder ist sinnvoll
- [ ] Verify-Zielseite bestätigt Erfolg klar
- [ ] Fehlermeldungen für Fahrer verständlich
- [ ] Deutsch ist klar
- [ ] Englisch ist klar
- [ ] Tschechisch ist klar
- [ ] Polnisch ist klar
- [ ] fachliche Aussage ist in allen Sprachen konsistent
- [ ] keine kritischen Informationslücken

### G. UX und Robustheit

- [ ] kompletter Flow auf Smartphone
- [ ] kompletter Flow auf Desktop
- [ ] Consent-Block gut bedienbar
- [ ] Fehlermeldungen verständlich
- [ ] Browser-Back beherrschbar
- [ ] Reload beherrschbar
- [ ] langsame API erzeugt keinen Doppel-Submit
- [ ] Abbruch erzeugt keinen verwirrenden Zustand
- [ ] Accessibility-Basis passt
- [ ] finaler kompletter Regression-Happy-Path

## Ergebnisregel

Go-Live-vorbereiteter Stand liegt erst vor, wenn:

- alle kritischen Fälle grün sind,
- keine fachlich notwendige Fahrerinformation im Erstkontakt fehlt,
- die Mail- und Verifikationskette Ende-zu-Ende funktioniert,
- und die Kommunikation aus Fahrersicht verständlich und vollständig ist.
