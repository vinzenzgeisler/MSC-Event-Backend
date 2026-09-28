# RacePic: Rechtstexte für den Verkauf (Entwurf v0)

> **Status: ENTWURF, nicht rechtlich geprüft.** Version `2026-09-28-entwurf.1` (siehe `api/src/commerce/legal.ts`).
> Diese Texte sind eine erste Arbeitsgrundlage und ersetzen keine Rechtsberatung. Vor dem ersten echten Verkauf müssen
> sie von einer Juristin oder einem Juristen geprüft und freigegeben werden (Gate AP00). Stellen in `<…>` sind
> Platzhalter. Erst danach setzt man den Status auf `APPROVED` und ändert die Versionsnummern.

Anbieter in allen Texten: **MSC Oberlausitzer Dreiländereck e.V.**, Am Weiher 4, 02791 Oderwitz.

Inhalt: 1 Checkout-Bestätigungen und Button · 2 AGB für Käufer · 3 Lizenzbedingungen · 4 Widerruf · 5 Datenschutzhinweis
zur Kaufabwicklung · 6 Zusatzbedingungen für Fotograf:innen · 7 Offene Rechtsfragen

---

## 1. Checkout: Bestätigungen und Button

**Bestellübersicht (vor dem Button, gut sichtbar):**
- je Bild: Titel bzw. „Foto <Nummer>“, Fotograf:in, Lizenz „Private Nutzung“, Preis
- **Gesamtpreis** einschließlich der gesetzlichen Umsatzsteuer, soweit sie anfällt `<Formulierung nach Steuerklärung>`
- Zahlungsart: Kartenzahlung oder Wallet über den Zahlungsdienst Stripe
- Lieferung: sofortiger Download der Bilddatei in voller Auflösung nach erfolgreicher Zahlung

**Pflicht-Bestätigungen (zwei getrennte Kästchen, beide müssen aktiv gesetzt werden, nicht vorausgewählt):**

1. „Ich habe die [Allgemeinen Geschäftsbedingungen], die [Lizenzbedingungen] und die [Datenschutzhinweise] gelesen und
   akzeptiere sie.“
2. „Ich stimme ausdrücklich zu, dass der MSC vor Ablauf der Widerrufsfrist mit der Ausführung des Vertrags beginnt
   und mir die Bilddatei sofort zum Download bereitstellt. Mir ist bekannt, dass ich mein Widerrufsrecht verliere,
   sobald der MSC mit der Ausführung des Vertrags begonnen hat.“

Diese zweite Erklärung entspricht den Anforderungen an digitale Inhalte (§ 356 Abs. 5 BGB); der Nachweis wird
gespeichert (Zeitpunkt, Textversion `digitalContentWaiver`).

**Button:** **„Zahlungspflichtig bestellen“** (§ 312j Abs. 3 BGB verlangt eine eindeutige Beschriftung; diese Wortwahl ist
die gesetzlich beispielhaft genannte).

**Bestätigungs-E-Mail nach der Zahlung** (auf einem dauerhaften Datenträger, § 312f Abs. 3 BGB): Bestellübersicht,
Rechnung als PDF, Lizenzbedingungen, Widerrufsbelehrung, Bestätigung der Zustimmung zur sofortigen Ausführung und des
Erlöschens des Widerrufsrechts, Link zum Download.

---

## 2. Allgemeine Geschäftsbedingungen für Käufer (Entwurf)

**§ 1 Geltungsbereich und Anbieter.** Diese Bedingungen gelten für Käufe von Bilddateien mit Lizenz über RacePic
(<Website-Adresse>). Vertragspartner ist der MSC Oberlausitzer Dreiländereck e.V., Am Weiher 4, 02791 Oderwitz, vertreten
durch <Vorstand nach § 26 BGB>, <Vereinsregister/Nummer>, <E-Mail>, <Telefon>. Die Bilder stammen von Fotografinnen und
Fotografen, die dem MSC die Vermarktung übertragen haben; der MSC verkauft im eigenen Namen.

**§ 2 Vertragsgegenstand.** Verkauft wird die Bereitstellung einer digitalen Bilddatei (JPEG in voller Auflösung, ohne
Wasserzeichen, mit eingebettetem Urhebervermerk) und das Recht zur Nutzung nach den Lizenzbedingungen. Das Bild bleibt
urheberrechtlich beim Fotografen; es wird kein Eigentum an Urheberrechten übertragen. Vorschaubilder auf der Website
tragen ein Wasserzeichen und sind nicht Vertragsgegenstand.

**§ 3 Vertragsschluss.** Die Darstellung der Bilder ist kein bindendes Angebot. Mit Klick auf „Zahlungspflichtig
bestellen“ gibst du ein verbindliches Angebot ab. Der Vertrag kommt zustande, sobald die Zahlung bestätigt ist und wir dir
die Bestätigung per E-Mail senden. Ein Warenkorb kann Bilder mehrerer Fotografinnen und Fotografen enthalten; der Vertrag
besteht dennoch mit dem MSC.

**§ 4 Preise und Zahlung.** Es gelten die zum Zeitpunkt der Bestellung angezeigten Preise in Euro <einschließlich der
gesetzlichen Umsatzsteuer, soweit sie anfällt>. Die Zahlung erfolgt über den Zahlungsdienst Stripe per Karte oder Wallet.
Der Preis wird bei Bestellung serverseitig festgelegt; die Bestellung ist nur gültig, solange die angezeigte Übersicht
(höchstens 15 Minuten) und die Zahlungsseite (höchstens 30 Minuten) nicht abgelaufen sind. Hat sich ein Preis oder
Angebot dazwischen geändert, musst du die Bestellung neu bestätigen.

**§ 5 Bereitstellung.** Nach bestätigter Zahlung stellen wir die Datei zum Download bereit. Der Zugang erfolgt über einen
persönlichen Link, den wir an deine E-Mail-Adresse senden, oder über dein Käuferkonto, falls du eines angelegt hast.
Download-Links sind kurz gültig; du kannst dir über die Bestellung jederzeit einen neuen erzeugen lassen. Bitte sichere
die Datei nach dem Download selbst.

**§ 6 Nutzungsrechte.** Es gelten die Lizenzbedingungen (Abschnitt 3).

**§ 7 Widerruf.** Du hast bei Verbraucherverträgen ein gesetzliches Widerrufsrecht. Es erlischt bei digitalen Inhalten
unter den Voraussetzungen des § 356 Abs. 5 BGB (Abschnitt 4).

**§ 8 Mängel.** Es gelten die gesetzlichen Rechte bei Mängeln digitaler Produkte (§§ 327 ff. BGB). Wenn eine Datei nicht
abrufbar oder beschädigt ist, melde dich bitte unter <E-Mail>; wir stellen sie erneut bereit oder erstatten den Preis.

**§ 9 Rechtsverletzungen und Sperrung.** Wird uns eine Rechtsverletzung glaubhaft gemeldet (z. B. Urheber- oder
Persönlichkeitsrechte), dürfen wir neue Downloads des Bildes sperren. Bereits heruntergeladene Dateien können wir nicht
zurückrufen. Ist die Lizenz dadurch nicht mehr nutzbar, erstatten wir den Kaufpreis für das betroffene Bild.

**§ 10 Haftung.** <Standardklausel nach anwaltlicher Vorgabe; Haftung für Vorsatz, grobe Fahrlässigkeit, Verletzung von
Leben, Körper, Gesundheit und wesentlichen Vertragspflichten bleibt unberührt.>

**§ 11 Datenschutz.** Siehe Abschnitt 5.

**§ 12 Streitbeilegung.** <Hinweis nach § 36 VSBG: Bereitschaft oder Nichtbereitschaft zur Teilnahme an einem
Verbraucherschlichtungsverfahren, Angabe der zuständigen Stelle bzw. Verweis auf die Plattform der EU-Kommission, soweit
zutreffend.>

**§ 13 Schlussbestimmungen.** Es gilt deutsches Recht; zwingende Verbraucherschutzvorschriften deines Aufenthaltsstaates
bleiben unberührt. <Salvatorische Klausel.>

---

## 3. Lizenzbedingungen „Private Nutzung“ (Entwurf)

Diese Bedingungen entsprechen der hinterlegten Lizenz `PAID_PRIVATE` (privat: ja, soziale Medien: nein, redaktionell:
nein, kommerziell: nein, Namensnennung: nicht erforderlich). Sollen soziale Medien mit erlaubt sein, muss die Lizenz
inhaltlich und in den Daten (neue Lizenzversion) geändert werden.

**1. Umfang.** Mit dem Kauf erhältst du ein persönliches, nicht ausschließliches, nicht übertragbares und zeitlich
unbegrenztes Recht, das gekaufte Bild für **private, nicht kommerzielle** Zwecke zu nutzen: speichern, für dich
ausdrucken, im privaten Umfeld zeigen, für den privaten Gebrauch zuschneiden und farblich anpassen.

**2. Nicht erlaubt.** Weiterverkauf, Weitergabe der Datei an Dritte außerhalb des privaten Umfelds, Nutzung für Werbung,
Produkte oder andere kommerzielle Zwecke, Veröffentlichung auf Websites oder in sozialen Netzwerken, redaktionelle
Nutzung sowie das Entfernen des eingebetteten Urhebervermerks.

**3. Rechte an Bild und Motiv.** Die Urheberrechte bleiben bei der Fotografin bzw. dem Fotografen. Mit dem Kauf erwirbst
du keine Rechte an den abgebildeten Personen, Fahrzeugen oder Marken. Beachte bei jeder Nutzung deren
Persönlichkeitsrechte.

**4. Dauer und Beendigung.** Das Recht gilt dauerhaft. Bei einem schwerwiegenden Verstoß gegen diese Bedingungen darf der
MSC die Lizenz aus wichtigem Grund beenden; dann darfst du das Bild nicht weiter nutzen.

**5. Nachweis.** Wir speichern mit deiner Bestellung den Wortlaut der Lizenz in der zum Kaufzeitpunkt geltenden Fassung.
Spätere Änderungen gelten nur für neue Käufe.

---

## 4. Widerruf (Entwurf)

Der Wortlaut der **Widerrufsbelehrung** muss dem amtlichen Muster entsprechen (Anlage 1 zu Art. 246a § 1 Abs. 2 Satz 2
EGBGB, Variante für **digitale Inhalte, die nicht auf einem körperlichen Datenträger geliefert werden**). Bitte diesen
Wortlaut von der Juristin bzw. dem Juristen einsetzen lassen und hier nicht frei formulieren. Inhaltlich muss sie enthalten:

- Widerrufsfrist 14 Tage ab Vertragsschluss, Empfänger (MSC Oberlausitzer Dreiländereck e.V., Am Weiher 4, 02791 Oderwitz,
  <E-Mail>, <Telefon>) und Hinweis auf das Muster-Widerrufsformular bzw. die elektronische Widerrufsfunktion.
- Folgen des Widerrufs (Erstattung binnen 14 Tagen über dasselbe Zahlungsmittel).
- **Erlöschen des Widerrufsrechts** bei digitalen Inhalten, wenn der MSC mit der Ausführung begonnen hat, nachdem du
  ausdrücklich zugestimmt und deine Kenntnis vom Verlust des Widerrufsrechts bestätigt hast (§ 356 Abs. 5 BGB), und der
  MSC dir die Bestätigung nach § 312f Abs. 3 BGB zur Verfügung gestellt hat.

**Elektronische Widerrufsfunktion (§ 356a BGB, seit dem 19. Juni 2026):** Wenn ein Widerrufsrecht besteht, muss auf der
Website eine gut sichtbare Schaltfläche, z. B. **„Vertrag widerrufen“**, in zwei Schritten (Widerruf starten, dann
„Widerruf bestätigen“) mit anschließender Eingangsbestätigung auf einem dauerhaften Datenträger zur Verfügung stehen.
Ob und wie lange sie für RacePic-Käufe bereitgestellt werden muss, hängt davon ab, ab wann das Widerrufsrecht durch den
Download erlischt (siehe Abschnitt 7).

---

## 5. Datenschutzhinweis zur Kaufabwicklung (Entwurf, Ergänzung zur Datenschutzerklärung)

- **Verantwortlicher:** MSC Oberlausitzer Dreiländereck e.V., Am Weiher 4, 02791 Oderwitz, <Kontakt Datenschutz>.
- **Daten und Zwecke:** E-Mail-Adresse, Bestell- und Rechnungsdaten, Zahlungsstatus, Download-Zeitpunkte und -Anzahl
  (Vertragserfüllung, Rechnungsstellung, Missbrauchsschutz, Nachweis der Zustimmungen). Rechtsgrundlagen: Art. 6 Abs. 1
  lit. b DSGVO (Vertrag), lit. c (gesetzliche Aufbewahrung), lit. f (Sicherheit, Nachweise).
- **Zahlungsdienstleister:** Stripe (Stripe Payments Europe Ltd., Irland) verarbeitet die Zahlungsdaten. Kartendaten
  gelangen nicht zum MSC. <Hinweis auf Datenübermittlung in Drittländer und Stripe-Datenschutzerklärung.>
- **Fotograf:innen** erhalten keine personenbezogenen Daten von Käufern, nur Verkaufs- und Erlösangaben. *(Entwurfsannahme
  im Datenmodell: Käufer werden in den Gutschriften nicht genannt.)*
- **Hosting:** AWS in der EU (Frankfurt).
- **Speicherdauer:** Rechnungen und Buchungsbelege werden nach den gesetzlichen Fristen aufbewahrt (derzeit 8 Jahre,
  <von Steuerberatung bestätigen>); Download-Protokolle <Dauer festlegen>.
- **Rechte:** Auskunft, Berichtigung, Löschung (soweit keine Aufbewahrungspflicht entgegensteht), Einschränkung,
  Widerspruch, Beschwerde bei der Aufsichtsbehörde <Sächsische Datenschutz- und Transparenzbeauftragte>.
- **Käuferkonto (optional):** Anmeldung per E-Mail-Code; bei Löschung des Kontos werden Profildaten entfernt, Rechnungs-
  und Zahlungsdaten bleiben im gesetzlichen Umfang gesperrt erhalten.

---

## 6. Zusatzbedingungen für Fotograf:innen: Verkauf über RacePic (Entwurf)

Ergänzung zu den bestehenden Fotografen-Bedingungen.

**1. Rechteeinräumung.** Für Bilder, die du zum Verkauf freigibst, räumst du dem MSC das nicht ausschließliche Recht ein,
Lizenzen nach den Käufer-Lizenzbedingungen (privat, nicht kommerziell) im eigenen Namen zu verkaufen. Du behältst alle
Urheberrechte. Du sicherst zu, alle erforderlichen Rechte an den Bildern zu besitzen und dass sie keine Rechte Dritter
verletzen; den MSC stellst du von Ansprüchen Dritter frei, die auf einer Verletzung dieser Zusicherung beruhen.

**2. Umstellung bestehender Bilder.** Du kannst veröffentlichte kostenlose Bilder zum Verkauf beantragen. Der MSC prüft
den Antrag. Die Umstellung wirkt nur für künftige Zugriffe: Bereits heruntergeladene kostenlose Dateien kann der MSC
nicht zurückrufen.

**3. Preise und Erlösanteil.** Du wählst aus den Preisstufen 5, 10, 15 oder 20 € (Endpreis für Käufer). Du erhältst
<80 %> des Nettoerlöses, der MSC <20 %>; der MSC trägt die Zahlungsgebühren. *(Anteil und Bezugsgröße sind im System
konfigurierbar; hier den beschlossenen Wert einsetzen.)* Erlöse werden 14 Tage zurückgehalten und danach über Stripe an
dein verbundenes Konto überwiesen.

**4. Steuern und Gutschriften.** Du gibst deinen umsatzsteuerlichen Status an (Kleinunternehmer nach § 19 UStG oder
mit Umsatzsteuer) sowie Steuernummer bzw. USt-IdNr. und Anschrift. Du stimmst zu, dass der MSC über deine Leistungen
per **Gutschrift** abrechnet (§ 14 Abs. 2 UStG); die Gutschrift enthält den Vermerk „Gutschrift“ und ersetzt eine
Rechnung von dir. Widersprichst du einer Gutschrift nicht, gilt sie als anerkannt <Frist von Juristin prüfen lassen>. Du
bist für die richtige steuerliche Einordnung deiner Einnahmen selbst verantwortlich. Solange dein Status nicht geklärt
ist, werden keine Auszahlungen vorgenommen.

**5. Erstattungen, Rückbuchungen, Sperrungen.** Wird ein Kauf erstattet oder zurückgebucht, mindert das deinen
Erlösanteil entsprechend. Ist der Betrag schon ausgezahlt, wird er mit späteren Auszahlungen verrechnet; ein negativer
Saldo kann weitere Auszahlungen sperren. Bei einer berechtigten Rechtsverletzungsmeldung darf der MSC den Verkauf des
Bildes sperren.

**6. Zugang zum Konto.** Für die Einrichtung des Auszahlungskontos bestätigst du mit einem Passkey. Das Konto wird bei
Stripe geführt; der MSC speichert keine Bank- oder Ausweisdaten.

**7. Beendigung.** Du kannst Bilder jederzeit aus dem Verkauf nehmen (Wirkung für künftige Käufe). Bestehende
Käuferlizenzen bleiben bestehen.

**Rechtebestätigung im Antrag auf Preisumstellung (Textversion `2026-09-28.1`):** „Ich bestätige, dass ich alle
erforderlichen Rechte an den ausgewählten Bildern besitze und sie kostenpflichtig anbieten darf. Mir ist bewusst, dass
die kostenlose Ausgabe dieser Bilder nach der Freigabe endet und der MSC bereits heruntergeladene oder gespeicherte
Dateien nicht zurückrufen kann.“

---

## 7. Offene Rechtsfragen für die Prüfung

1. **Widerrufsrecht und Download:** Ab wann erlischt das Widerrufsrecht praktisch, mit Klick auf den Download oder mit
   Bereitstellung des Links? Muss die Widerrufsfunktion (§ 356a BGB) bis dahin angeboten werden, und wie lässt sich das
   im Käuferportal technisch sauber abbilden?
2. **Umsatzsteuer im Preis:** Formulierung „inklusive Umsatzsteuer“ je nach Steuerstatus des MSC und Satz (siehe
   `racepic-open-items.md`).
3. **AGB-Klauseln:** Haftung, Gerichtsstand, Verbraucherschlichtung (§ 36 VSBG), Gewährleistung bei digitalen Produkten.
4. **Gutschriftsverfahren:** Wirksamkeit der Anerkennungsklausel und Zustimmung der Fotograf:innen; Umgang mit
   Fotograf:innen ohne Gewerbe.
5. **Abgrenzung Verkäufer/Vermittler:** Stimmt die Ausgestaltung „MSC verkauft im eigenen Namen“ mit den
   Fotografen-Bedingungen und der Plattformmeldepflicht (DAC7) überein?
6. **Urheber- und Persönlichkeitsrechte** der Abgebildeten bei privater Nutzung und beim Verkauf durch einen Verein
   (Motorsportteilnehmer, Marken).
7. **Datenschutz:** Speicherdauer der Download-Protokolle, Rolle von Stripe, Drittlandübermittlung, Informationspflichten
   beim Gastkauf.
8. **Impressum/Pflichtangaben** des Vereins für den Shop.
