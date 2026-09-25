# RacePic – Rechtstexte V1 (Datenschutz + Fotografen-Bedingungen)

Stand: 2026-09-21
Geltungsbereich: Deutschland/EU, öffentliche RacePic-Galerie (`/racepic`) und Fotografen-Studio (`/racepic/studio`).
Entwurf im Rahmen von Paket 0 des RacePic-Architekturplans (`docs/memory-bank/racepic-architecture.md`). **Vor Live-Schaltung durch den Datenschutzbeauftragten und ggf. eine Rechtsberatung freizugeben.**

---

## 1. Datenschutzhinweis RacePic (öffentliche Galerie)

### 1.1 Verantwortlicher
MSC Oberlausitzer Dreilaendereck e.V.
Am Weiher 4
02791 Oderwitz
Vertreten durch den 1. Vorsitzenden Herrn Peter Liersch
E-Mail: info@msc-oberlausitzer-dreilaendereck.eu
Registergericht: Dresden, VR 5907
USt-IdNr.: DE289954270

### 1.2 Datenschutzbeauftragter
Beauftragter für Datenschutz: Stephan Jakab
Kontakt: info@msc-oberlausitzer-dreilaendereck.eu

### 1.3 Zweck und Rechtsgrundlagen
RacePic zeigt Eventfotos, die von Fotografen zur Verfügung gestellt und mittels automatisierter Bilderkennung (Startnummer, Fahrzeugmerkmale) den Teilnehmern der jeweiligen Veranstaltung zugeordnet werden.

Rechtsgrundlagen:
1. Art. 6 Abs. 1 lit. f DSGVO (berechtigtes Interesse des Vereins und der Teilnehmer an einer zentralen, auffindbaren Bildergalerie zur Veranstaltung),
2. Art. 6 Abs. 1 lit. a DSGVO für die im Anmeldeformular erteilte Medieneinwilligung (`consent_media_accepted`), soweit ein Bild einem Teilnehmer öffentlich mit Namen zugeordnet wird,
3. Art. 6 Abs. 1 lit. f DSGVO für die automatisierte Bildzuordnung als technisches Mittel zur Umsetzung der Medieneinwilligung (keine Profilbildung, kein Scoring von Personen; die Erkennung bezieht sich auf Startnummern und Fahrzeugmerkmale, nicht auf Gesichter).

### 1.4 Keine Gesichtserkennung
RacePic verwendet ausschließlich Bilderkennung zur Erkennung von Startnummern und Fahrzeugmerkmalen (Fahrzeugtyp, Farbe, visuelle Ähnlichkeit zum bei der Anmeldung hochgeladenen Fahrzeugfoto). Eine Gesichtserkennung oder biometrische Identifizierung von Personen findet nicht statt und ist nicht Bestandteil der Zuordnungslogik.

### 1.5 Angezeigte Teilnehmerdaten
In der öffentlichen Galerie werden je zugeordnetem Bild angezeigt: Startnummer, Anzeigename des Fahrers (bzw. hinterlegter Veröffentlichungsname), Fahrzeughersteller/-modell und Klasse. Diese Felder entsprechen den bereits heute auf der Vereinswebsite im Rahmen des Event-Hubs veröffentlichten Angaben.

Teilnehmer, die der Veröffentlichung widersprochen haben, ein eingeschränktes Verarbeitungsrecht (`processing_restricted`) geltend gemacht haben oder für die ein Veröffentlichungsname (Pseudonym) hinterlegt ist, erscheinen in der Namenssuche nicht bzw. nur mit dem Pseudonym. Bilder ohne Medieneinwilligung werden nicht öffentlich mit einem Teilnehmer verknüpft.

### 1.6 Widerspruchsrecht gegen die Bildzuordnung
Jeder Teilnehmer kann jederzeit der Zuordnung von Bildern zu seiner Person widersprechen, auch nachträglich für bereits automatisiert zugeordnete Bilder. Der Widerspruch entfernt die Zuordnung, den Teilnehmerbezug und die Auffindbarkeit über Teilnehmerdaten. Das Veranstaltungsbild selbst bleibt ohne diesen Bezug in der Galerie. Eine begründete Anfrage zur Entfernung eines konkreten Bildes wird separat geprüft. Kontakt: info@msc-oberlausitzer-dreilaendereck.eu.

### 1.7 Empfänger und Auftragsverarbeiter
1. AWS als Auftragsverarbeiter (S3, CloudFront, Lambda, SQS, RDS, Cognito, Secrets Manager), primär Region eu-central-1,
2. Amazon Rekognition (Texterkennung, Objekterkennung) und Amazon Bedrock/Cohere Embed v4 über das EU-Inference-Profile aus eu-central-1 (Bildähnlichkeit) – Verarbeitung ausschließlich in unterstützten EU-Regionen, kein Drittlandtransfer,
3. hochladende Fotografen als eigenständig Verantwortliche für die von ihnen erstellten Aufnahmen.

### 1.8 Speicherdauer
1. Bilder und ihre Zuordnungen: bis zur Löschung durch den Fotografen bzw. gemäß Löschkonzept (siehe `retention-policy.md`, Ergänzung RacePic),
2. KI-Analyseergebnisse (Rohantworten): solange das zugehörige Bild existiert,
3. nach Anonymisierung der Teilnehmerdaten (1 Jahr nach Eventende) bleibt die Bildzuordnung über Startnummer, Klasse und Fahrzeug bestehen; der Name wird aus der Anzeige entfernt (siehe Abschnitt „Datenschutz“ im Architekturplan).

### 1.9 Betroffenenrechte
Auskunft, Berichtigung, Löschung, Einschränkung der Verarbeitung, Widerspruch und Datenübertragbarkeit wie im allgemeinen Datenschutzhinweis der Veranstaltungsanmeldung (`legal-texts-v1.md`, Abschnitt 7). Anfragen an info@msc-oberlausitzer-dreilaendereck.eu.

### 1.10 Beschwerderecht
Sie haben das Recht, sich bei einer Datenschutzaufsichtsbehörde zu beschweren.

---

## 2. Fotografen-Nutzungsbedingungen (Upload-Bedingungen, versioniert zu akzeptieren beim Claiming)

### 2.1 Einräumung von Rechten
Mit dem Hochladen eines Bildes bestätigt der Fotograf, Inhaber der erforderlichen Nutzungs- und Urheberrechte an dem Bild zu sein, und räumt dem MSC Oberlausitzer Dreilaendereck e.V. das nicht-ausschließliche, zeitlich unbeschränkte Recht ein,
1. das Bild auf RacePic und den Vereinskanälen (Website, Social Media) zur Darstellung im Rahmen der Veranstaltung öffentlich zugänglich zu machen,
2. technisch erforderliche Bearbeitungen vorzunehmen (Größenanpassung, Formatumwandlung, Entfernung von Metadaten wie GPS-Koordinaten),
3. das Bild zur automatisierten Analyse (Startnummer- und Fahrzeugerkennung) zu verarbeiten.

Der Fotograf bleibt Inhaber der Bildrechte und wählt die dem Bild zugrunde liegende Lizenz für Dritte (Endnutzer) gemäß dem Lizenzkatalog (`docs/racepic/licenses.md`).

### 2.2 Zusicherungen des Fotografen
Der Fotograf sichert zu, dass
1. die hochgeladenen Bilder von ihm selbst erstellt wurden bzw. er über alle erforderlichen Rechte verfügt,
2. keine Bilder hochgeladen werden, die Persönlichkeitsrechte, Urheberrechte Dritter oder geltendes Recht verletzen,
3. abgebildete Personen im Rahmen einer öffentlichen Veranstaltung im öffentlichen Verkehrsraum bzw. auf dem Veranstaltungsgelände fotografiert wurden und keine unzulässigen Nahaufnahmen erkennbarer Personen ohne berechtigtes Interesse hochgeladen werden, bei denen die Person im Vordergrund und nicht das Fahrzeug/die Veranstaltung steht.

### 2.3 Entfernung von Bildern
Der MSC behält sich vor, Bilder zu verbergen oder zu entfernen, insbesondere bei
1. separater, begründeter Anfrage zur Entfernung eines konkreten Bildes,
2. Verdacht auf Rechtsverletzung,
3. Verstoß gegen diese Bedingungen.

Der Fotograf kann eigene Bilder jederzeit selbst verbergen oder (nach erneuter Bestätigung, „Step-up: recent“) endgültig löschen.

### 2.4 Vergütung im MVP
Die Nutzung von RacePic ist für Fotografen und Endnutzer im MVP kostenlos. Eine spätere kostenpflichtige Lizenzierung einzelner Bilder ist optional und wird gesondert vereinbart (siehe Marketplace-Abschnitt K des Architekturplans); sie ändert nichts an bereits unter diesen Bedingungen kostenlos veröffentlichten Bildern.

### 2.5 Haftung
Der Fotograf stellt den MSC von Ansprüchen Dritter frei, die aus einer Verletzung der in Abschnitt 2.2 zugesicherten Rechte resultieren. Der MSC übernimmt keine Haftung für die inhaltliche Richtigkeit der automatisierten Bildzuordnung; Korrekturen können jederzeit über die Kontaktadresse gemeldet werden.

---

## 3. Ergänzung Medieneinwilligung (Hinweistext für Teilnehmer, informativ – keine neue Einwilligung im MVP)

Der bestehende Medieneinwilligungstext (`legal-texts-v1.md`, Abschnitt „Einwilligung Mediennutzung“) deckt die Verwendung von Fotos für Veranstaltungsbericht, Vereinswebsite und Social Media bereits ab. RacePic nutzt dieselbe Einwilligung (`consent_media_accepted`), erweitert die Nutzung aber um eine automatisierte, zentrale Auffindbarkeit über Startnummer und Namen. Empfehlung: beim nächsten Update des Anmeldeformulars folgenden Klarstellungssatz ergänzen:

> „Ihre Einwilligung umfasst auch die automatisierte Zuordnung von Eventfotos verschiedener Fotografen zu Ihrem Fahrzeug/Ihrer Startnummer auf der Plattform RacePic sowie deren dortige öffentliche Darstellung mit Namen, Startnummer und Fahrzeugdaten.“

Diese Ergänzung ist kein Blocker für den MVP (die bestehende Einwilligung deckt den Zweck bereits ab), sollte aber zur Klarstellung zeitnah nachgezogen werden. Betrifft **nicht** die separate, noch offene Entscheidung zur dauerhaften Namenssuche nach 365 Tagen (siehe `docs/memory-bank/racepic-progress.md`).

## 4. Nachtrag zur internen Shop-Vorbereitung (2026-09-22, Entwurf)

Fotograf:innen können sich künftig mit bestätigter E-Mail selbst registrieren. Das Konto bleibt bis zur Freigabe durch den MSC ohne Event- und Upload-Rechte. Der MSC verarbeitet dafür E-Mail-Adresse, Anzeigename, Zeitpunkt der Bestätigung und die akzeptierte Bedingungsversion. Eine ablehnende Entscheidung sperrt den Zugang; ein Lösch- und Auskunftsweg ist über die oben genannte Kontaktadresse vorzusehen.

Für noch unveröffentlichte Bilder können Titel, Beschreibung, Tags, Lizenz und ein Preis in Euro gepflegt werden. Kostenpflichtige Entwürfe werden ausschließlich im geschützten Studio mit einer wasserzeichenbehafteten Vorschau angezeigt. Die Originaldatei bleibt privat. Es findet derzeit weder ein Verkauf noch eine Weitergabe von Käuferdaten an Fotograf:innen oder Zahlungsdienstleister statt.

Für einen späteren Verkauf ist vorgesehen, dass der Fotograf Vertragspartner des Käufers wird und der MSC vermittelt. Die konkreten Rollen bei Zahlung, Rechnung, Umsatzsteuer, Widerruf und Datenschutz sind vor Aktivierung des Checkouts rechtlich und steuerlich zu prüfen. Bestehende kostenlose Veröffentlichungen bleiben kostenlos; eine nachträgliche Umstellung veröffentlichter Bilder auf kostenpflichtig ist technisch gesperrt.
