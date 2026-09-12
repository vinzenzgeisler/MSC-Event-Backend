# Finaltest: Anmeldung & technische Abnahme (v1)

Testanleitung für den kompletten Ablauf von der Org-Büro-Anmeldung bis zur technischen Abnahme,
nach Einführung der serverseitigen Anmeldesperre (Zahlung + aktueller Fahrer-Haftverzicht) und der
Doppelstarter-/TA-Freigabe-Logik.

Voraussetzung: Testfahrer mit mindestens einer angenommenen Nennung; für Schritt 12 zusätzlich ein
Fahrer mit zwei angenommenen Starts (Doppelstarter), davon einer mit Ersatzfahrzeug.

## 1. Zulassung und Zahlungsprüfung im Org-Büro
- Nennung im Org-Büro-Tool öffnen, Zulassung/Prüfung durchführen.
- Prüfen: Nenngeld-Status wird korrekt angezeigt (offen/bezahlt/nicht erforderlich).

## 2. Direkte Restzahlung im HV-Dialog
- HV-Dialog für einen Fahrer mit offenem Nenngeld öffnen.
- Prüfen: offener Betrag wird angezeigt, Button „Offenen Betrag als bezahlt verbuchen" erscheint.
- Button klicken → Bestätigungsschritt bestätigen. Dialog bleibt geöffnet, Zahlungsstatus aktualisiert
  sich, Warnhinweis verschwindet.
- Zwei Browsertabs/Operatoren gleichzeitig verbuchen lassen (Doppelklick simulieren): es darf nur
  einmal der offene Betrag gebucht werden, keine doppelte Zahlung im Ledger.
- Fahrer mit unbekanntem/fehlendem Nenngeldbetrag: Button darf keine Buchung auslösen, stattdessen
  erscheint „Nenngeldbetrag unbekannt. Bitte Zahlungsdaten prüfen."

## 3. Fahrer-HV, Terminalunterschrift, Dokumentablage und Fahrer-E-Mail
- Solange Nenngeld offen ist: „Haftverzicht am Gerät starten" ist deaktiviert, Hinweistext sichtbar.
- Direkter API-Test (z. B. curl) auf `POST /admin/signing/sessions` für denselben Fahrer bei offener
  Zahlung → 409 `SIGNING_PAYMENT_REQUIRED` (bestätigt, dass die Sperre nicht nur clientseitig ist).
- Nach Zahlungsbuchung: Button aktiv, Unterschrift am Terminal normal durchführen, PDF/Mail prüfen.

## 4. Ausgabe des persönlichen Fahrerausweises
- Unverändert: Karte erst nach Zahlung + Fahrer-HV ausgeben.

## 5. Regulären Beifahrer neu hinzufügen
- Unverändert testen (Regressionstest, keine fachliche Änderung).

## 6. Bestehenden Beifahrer bearbeiten und erneut unterschreiben lassen
- Beifahrer-HV ist NICHT Teil der technischen Prüfsperre — sicherstellen, dass ein offener
  Beifahrer-HV die technische Abnahme nicht blockiert (siehe Schritt 10).

## 7. Charity-Beifahrer bei erlaubter Klasse
- Charity-Fahrt sowohl mit „Person gibt Daten am Tablet ein“ als auch mit „Daten hier erfassen“ starten.
- Pflichtdaten: Vorname, Nachname, Geburtsdatum, Land, Straße, PLZ und Ort; E-Mail ist optional.
- Ohne E-Mail vollständig unterschreiben: PDF und Auditnachweis werden gespeichert, ohne dass ein
  fehlender Mailversand den Vorgang als Fehler markiert.
- Mit E-Mail unterschreiben und den automatischen PDF-Versand prüfen.
- Je eine Nennung mit offenem/bestandenem/abgelehntem TA-Status sowie nicht zugelassener Nennung
  testen. Charity muss unabhängig von diesen Status möglich sein.
- Gelöschte Nennungen und Klassen ohne Beifahrerfreigabe bleiben gesperrt.

## 8. Negativtest: Charity-/Beifahrerklasse nicht erlaubt
- Unverändert testen.

## 9. Minderjährigenfall mit Sorgeberechtigten
- Charity-U18 jeweils mit Vertreter-E-Mail ohne Telefon und mit Vertreter-Telefon ohne E-Mail
  abschließen. Name und Verhältnis der gesetzlichen Vertretung bleiben Pflicht.
- Ohne E-Mail und Telefon muss die Eingabe verständlich abgewiesen werden.
- Anwesenheit und Vertretungsberechtigung müssen vor der Tablet-Unterschrift weiterhin durch die
  Orga bestätigt werden.

## 10. Technischen Zugriff bei offener Zahlung bzw. fehlendem HV blockieren
- Fahrer mit offenem Nenngeld ODER ohne aktuellen Fahrer-HV in der technischen Abnahme (Suche, QR,
  Direktlink) öffnen.
- Prüfen: Meldung „Noch nicht vollständig im Org-Büro angemeldet. Bitte zuerst dort melden.“ mit
  konkreten Gründen (Nenngeld offen / aktueller Fahrer-Haftverzicht fehlt); Abnahme-Buttons, Notizfeld
  und Statuswechsel sind gesperrt.
- Suche: nicht angemeldete Nennungen zeigen „Org-Büro offen“-Badge auf der Ergebniskarte.
- Prüfen: der blockierte Zugriffsversuch erscheint im Verlauf der Nennung (Prüfer, Zeitpunkt, Quelle,
  Grund).
- Beifahrer-HV-Status oder das alte Feld „ID geprüft“ dürfen die Sperre NICHT auslösen — mit einem
  Fahrer testen, der nur einen offenen Beifahrer-HV hat: technische Abnahme muss möglich sein.

## 11. Einzelstarter vollständig abnehmen
- Fahrzeug auf „bestanden“ setzen. Prüfen: grüne Meldung „Alle Fahrzeuge bestanden – TA-Stempel darf
  vergeben werden“ erscheint sofort.

## 12. Doppel-/Dreifachstarter inkl. Ersatzfahrzeuge abnehmen
- Detailansicht eines Starts öffnen: Abschnitt „Alle Starts von …“ zeigt alle angenommenen Starts
  inkl. Haupt- und Ersatzfahrzeug mit jeweiligem Status; Wechsel per Klick funktioniert direkt.
- „Zurück zu allen Starts“ verwenden — auch nach Seiten-Reload und nach Einstieg über Suche/QR eines
  einzelnen Starts prüfen, dass der Link zur vollständigen Fahrerübersicht führt.
- Alle Haupt- und Ersatzfahrzeuge auf „bestanden“ setzen: TA-Stempel-Freigabe erscheint erst, wenn
  wirklich jedes Ziel (inkl. aller Ersatzfahrzeuge) bestanden ist — mit einem noch offenen
  Ersatzfahrzeug testen, dass die Freigabe ausbleibt.

## 13. Ablehnung mit Pflichtnotiz, spätere Korrektur, Ergänzung einer Notiz
- Ablehnen ohne Notiz → Pflichtfeld-Hinweis. Mit Notiz ablehnen, später auf „offen“ zurücksetzen:
  bei einem zuvor TA-Stempel-bereiten Fahrer erscheint vorher ein Warnhinweis auf einen ggf. bereits
  vergebenen physischen Stempel.

## 14. Prüferübersicht und rückwirkendes Öffnen
- „Übersicht“-Button neben „Abmelden“ öffnen: Zähler für „noch nicht prüfbar“, „prüfbar & offen“,
  „bestanden“, „abgelehnt“, „TA-Stempel frei“ sowie die eigene letzte Historie.
- Zähler im Header aktualisiert sich nach Statusänderungen automatisch.
- Einen Eintrag aus der Historie erneut öffnen — führt korrekt zur Detailansicht.

## 15. Automatische TA-Stempelfreigabe erst nach allen bestandenen Fahrzeugen
- Kombiniert aus 11/12: Freigabe erscheint nur, wenn Eligibility (Zahlung + Fahrer-HV) UND alle
  Ziele bestanden sind — mit offener Zahlung UND allen Fahrzeugen „bestanden“ testen, dass KEINE
  Freigabe erscheint.

## 16. Zwei Operatoren/Prüfer parallel testen
- Zwei Tabs/Geräte gleichzeitig auf denselben Eintrag: Statusänderung in Tab A, dann (ohne Reload)
  Statusänderung in Tab B mit veralteten Daten versuchen → 409 `INSPECTION_STATE_CONFLICT`, Tab B
  lädt neu und zeigt einen verständlichen Konflikthinweis statt zu überschreiben.
- Gleiches für die Restzahlungsbuchung aus Schritt 2 mit zwei Operatoren wiederholen.
