# RacePic – Stripe-Checkout- und Marketplace-Umsetzungsplan

> **Stand:** 2026-09-25 · **Status:** fachlich und architektonisch geplant, noch nicht implementiert oder freigeschaltet
> Diese Datei wird identisch in `msc-website`, `MSC-Event-Backend` und `MSC-Event-Frontend` geführt.

## 1. Zielbild und verbindliche Entscheidungen

- Der MSC ist gegenüber Käufern **Merchant of Record**. Der Käufer erhält Rechnung und Vertrag vom MSC; Fotografen erhalten eine Abrechnung/Gutschrift für ihren Anteil.
- Ein Warenkorb darf Bilder mehrerer Fotografen enthalten. Stripe verarbeitet eine Zahlung auf dem Plattformkonto; sellerbezogene Auszahlungen erfolgen anschließend über **Separate Charges and Transfers**.
- Checkout läuft über **Stripe Hosted Checkout** mit Karten und Wallets. Im Browser wird kein Stripe-SDK benötigt; im Backend wird nur das offizielle `stripe`-Paket ergänzt.
- Startmarkt ist Deutschland, Sprache Deutsch, Währung EUR. Preise sind brutto und auf 5, 10, 15 oder 20 Euro begrenzt. Coupons und freie Preise sind nicht Teil von V1.
- Fotografen erhalten 80 % des Nettoerlöses. Der MSC behält 20 % und trägt die Stripe-Gebühren. Auszahlungen bleiben grundsätzlich 14 Tage zurückgestellt.
- Käufer dürfen als Gast bestellen oder ein optionales, von Staff- und Fotografenkonten getrenntes Käuferkonto verwenden.
- Käuferkonten verwenden einen eigenen Cognito-Pool mit passwortlosem E-Mail-OTP über Cognito Managed Login. Ein Passkey kann später im Konto ergänzt werden, ist aber keine Voraussetzung.
- Nach bestätigter E-Mail übernimmt ein Käuferkonto automatisch und idempotent alle Gastbestellungen mit exakt derselben normalisierten Adresse. Normalisierung bedeutet Trim und Lowercase, keine providerabhängige Gmail-/Aliaslogik.
- Bereits veröffentlichte FREE-Bilder können in PAID-Angebote umgewandelt werden. Der Fotograf stellt den Antrag mit einer normalen aktiven Sitzung; die Umstellung wird erst durch Adminfreigabe wirksam.
- `strong` bleibt für Connect-Onboarding, Auszahlungszugriff sowie E-Mail-/Identitätsänderungen verpflichtend. Für FREE→PAID ersetzt die getrennte Adminfreigabe den Step-up.
- Refunds sind nur für die komplette Bestellung oder vollständige einzelne Bildpositionen erlaubt. Eine freie Teilrefundsumme ohne Positionsbezug ist in V1 ausgeschlossen.
- Ein Kauf gewährt ein dauerhaftes persönliches Nutzungsrecht gemäß gekauftem Lizenzsnapshot. Download-URLs bleiben kurzlebig und rate-limitiert.
- Ausgeliefert wird ein bereinigtes Vollauflösungs-JPEG `licensed_full`: GPS und unerwünschte Upload-Metadaten entfernt, Copyright eingebettet. Das unveränderte Upload-Original wird nicht verkauft.

## 2. Rechtliche und betriebliche Gates

Vor Aktivierung des ersten PAID-Angebots müssen schriftlich abgenommen sein:

1. Checkout-, AGB-, Lizenz-, Datenschutz- und Widerrufstexte einschließlich ausdrücklicher Zustimmung zur sofortigen Ausführung digitaler Inhalte und Kenntnis vom Erlöschen des Widerrufsrechts.
2. Gestaltung und Bezeichnung des zahlungspflichtigen Buttons sowie Vertragsbestätigung nach §§ 312f, 312j und 356 BGB.
3. Bewertung, wann und wie die elektronische Widerrufsfunktion nach § 356a BGB angeboten werden muss.
4. Umsatzsteuer-, Rechnungs- und Aufbewahrungslogik des MSC sowie steuerliche Behandlung und Gutschriften für private, kleinunternehmerische und regelbesteuerte Fotografen.
5. Stripe-Vertrags-/Kontokonfiguration für den MSC als Merchant of Record und Freigabe des Reserve-, Refund- und Negative-Balance-Verfahrens.

Feature Flags bleiben bis zur dokumentierten Freigabe standardmäßig aus. Es gibt kein lokales Deployment; Backend- und Infrastrukturänderungen laufen ausschließlich über die vorhandene CI/CD-Pipeline.

Referenzen:

- Stripe Separate Charges and Transfers: https://docs.stripe.com/connect/separate-charges-and-transfers
- Stripe Webhooks: https://docs.stripe.com/webhooks
- Cognito Passwordless/Choice-based Authentication: https://docs.aws.amazon.com/cognito/latest/developerguide/authentication-flows-selection-managedlogin.html
- § 312f BGB: https://www.gesetze-im-internet.de/bgb/__312f.html
- § 312j BGB: https://www.gesetze-im-internet.de/bgb/__312j.html
- § 356 BGB: https://www.gesetze-im-internet.de/bgb/__356.html
- § 356a BGB: https://www.gesetze-im-internet.de/bgb/__356a.html

## 3. Architektur und Verantwortlichkeiten

### 3.1 Repository-Zuordnung

- `msc-website`: Shopkatalog, Warenkorb, serverautorisierte Quote, Checkout-Übergabe, Gastzugriff, Käuferlogin und Käuferportal sowie FREE→PAID-Antrag im Fotografenstudio.
- `MSC-Event-Backend`: Commerce-Domäne, Postgres-Ledger, Stripe-Adapter, Checkout Sessions, Webhooks, Buyer-Authorizer, Rechnungen, Entitlements, Downloads, Connect, Settlement, Refunds, Disputes und Reconciliation.
- `MSC-Event-Frontend`: Adminfreigabe FREE→PAID, Bestellungen, Refunds, Takedowns, Disputes, Transfers, Reconciliation und Ausnahmewarteschlangen.

### 3.2 Modulgrenzen und Datenfluss

- Commerce bleibt ein eigenes Backendmodul unter `api/src/commerce/*`. RacePic wird über einen `ProductTypeHandler` für `RACEPIC_IMAGE_LICENSE` angebunden.
- Der Browser übermittelt nur Produkt-/Angebots-IDs. Preis, Steuer, Seller, Kaufbarkeit und Lizenz werden bei jeder Quote serverseitig aufgelöst.
- Quotes sind 15 Minuten gültig; Checkout Sessions 30 Minuten. Geänderte oder abgelaufene Angebote verlangen eine neue Käuferbestätigung.
- Die Checkout-Erfolgseite erfüllt keine Bestellung. Nur verifizierte Stripe-Ereignisse dürfen `PAID` setzen und Entitlements erzeugen.
- Stripe-Webhooks besitzen getrennte Raw-Body-Endpunkte für Plattform und Connect. Nach Signaturprüfung: persistente Inbox, Deduplizierung über Provider/Event-ID, schnelle 2xx-Antwort, SQS/DLQ-Verarbeitung und zustandsbasierte Idempotenz.
- Ein täglicher Reconciliation-Job gleicht Order, Payment, Refund, Transfer, Reversal und Dispute mit Stripe ab. Abweichungen werden nicht automatisch verworfen, sondern als Admin-Ausnahme angelegt.

### 3.3 Kernmodell

- `commerce_seller`: MSC oder Fotograf; Eligibility-, Steuer- und Sperrstatus.
- `commerce_payment_account`: Stripe-Account-ID und synchronisierte Capability-/Requirement-Zustände; keine Bank- oder KYC-Rohdaten.
- `commerce_buyer_account`: Cognito-Sub, verifizierte normalisierte E-Mail, Status und Löschzeitpunkt.
- `commerce_customer`: Stripe-Customer-Zuordnung für Gast oder Konto; keine Zahlungsdaten in der MSC-Datenbank.
- `commerce_product`: Produktadapter, RacePic-Bildreferenz und Seller. Commerce-Referenzen sperren Hard Deletes per `ON DELETE RESTRICT`.
- `commerce_offer_version`: immutable Version mit FREE/PAID, Preis, Währung, Lizenzversion, Steuerklasse, Seller und Gültigkeit.
- `commerce_quote`: kurzlebiger serverseitiger Snapshot des Warenkorbs.
- `commerce_order` und `commerce_order_item`: unveränderliche Brutto-/Netto-/Steuer-, Lizenz-, Seller-, Provisions- und Rechtstext-Snapshots.
- `commerce_payment`, `commerce_refund`, `commerce_refund_item`, `commerce_dispute`: Providerreferenzen und Zustandsautomat.
- `commerce_entitlement`: Käufer/Gast, OrderItem, Produkt, Lizenz, Status und Download-Audit.
- `commerce_transfer`, `commerce_transfer_reversal`, `commerce_seller_balance`: 14-Tage-Hold, Auszahlung und negativer Saldo.
- `commerce_invoice`, `commerce_seller_statement`, `commerce_legal_acceptance`: versionierte Dokumente und Nachweise.
- `commerce_webhook_inbox`: Raw-Payload-Referenz, Event-ID, Typ, Verarbeitungsstatus, Versuche und Fehler.
- `racepic_offer_conversion`: Antrag, Zielangebot, Artefaktstatus, Reviewer, Entscheidung und Audit.

Geld wird ausschließlich als Integer-Cents gespeichert. Ein bestehendes `racepic_image.price_cents` ist nach Migration nicht mehr die kaufrechtliche Quelle; bestehende FREE-Bilder erhalten eine aktive kostenlose Angebotsversion.

### 3.4 Zustände

- `OfferVersion`: `DRAFT | PENDING_REVIEW | ACTIVE | REJECTED | RETIRED`
- `ConversionRequest`: `REQUESTED | PREPARING_ASSETS | READY_FOR_REVIEW | APPROVED | REJECTED | FAILED`
- `Order`: `PENDING | PAID | PARTIALLY_REFUNDED | REFUNDED | DISPUTED | CANCELLED`
- `Entitlement`: `ACTIVE | BLOCKED | REVOKED`
- `Transfer`: `HELD | READY | SUBMITTED | PAID | REVERSAL_PENDING | REVERSED | FAILED`

## 4. Käuferkonto und Gastzugriff

- Gastkauf bleibt der Standard. Vor Checkout werden E-Mail, Rechtstextversionen und Zustimmung serverseitig gespeichert.
- Gastzugriff erfolgt über gehashte, einmal verwendbare, kurzlebige Magic Links. Der Request-Endpunkt antwortet immer neutral, um Account-/Order-Enumeration zu verhindern.
- Nach Buyer-Login ruft die Website `POST /buyer/account/activate` auf. Das Backend legt das Konto idempotent an und verknüpft alle noch nicht beanspruchten Orders derselben verifizierten normalisierten E-Mail.
- Bereits einem anderen Buyer-Account zugeordnete Orders werden nie automatisch verschoben. Accountzusammenführungen sind kein V1-Self-Service und landen beim Support.
- Nach Verknüpfung gehört die Order dauerhaft zur `buyer_account_id`; eine spätere E-Mail-Änderung entzieht alte Bestellungen nicht.
- E-Mail-Änderungen verlangen erneute Verifikation. Existiert die neue Adresse bereits, wird nicht automatisch zusammengeführt.
- Kontolöschung deaktiviert Authentisierung und entfernt/pseudonymisiert entbehrliche Profildaten. Rechnungs-, Zahlungs- und Auditdaten bleiben entsprechend der festgelegten Aufbewahrung gesperrt erhalten.

## 5. FREE→PAID für bereits veröffentlichte Bilder

1. Fotograf wählt ein oder mehrere eigene veröffentlichte FREE-Bilder, Preisstufe und PAID-Lizenz und bestätigt Rechte sowie zukünftige Kostenpflicht.
2. Das Backend legt einen idempotenten Conversion-Antrag an. Das aktive FREE-Angebot und die öffentliche Ausgabe bleiben zunächst unverändert.
3. `licensed_full` und wasserzeichenbehaftete PAID-Vorschau werden unter versionierten Objekt-Keys erzeugt und vollständig validiert.
4. Admin prüft Eigentum, Rechtebestätigung, Preis, Lizenz und Vorschau. Ablehnung ändert die Veröffentlichung nicht.
5. Freigabe aktiviert transaktional die neue immutable PAID-Angebotsversion, beendet die FREE-Version und sperrt die Ausgabe neuer kostenloser Vollbild-URLs.
6. Manifeste referenzieren nur content-/offer-versionierte Vorschau-URLs. Alte öffentliche FREE-Objekte werden entfernt und CloudFront invalidiert; ein Mischzustand darf nicht sichtbar werden.
7. Bereits früher heruntergeladene oder lokal gecachte FREE-Dateien können technisch und rechtlich nicht zurückgerufen werden. Die Umstellung wirkt ausschließlich für zukünftige Zugriffe.
8. Bestehende Warenkorbpositionen werden bei Quote-Erstellung neu bewertet. Eine alte FREE-/Preisannahme darf nie in den Checkout gelangen.

PAID→FREE oder Preisänderungen erzeugen ebenfalls eine neue Angebotsversion; frühere Käufe und Lizenzsnapshots bleiben unverändert.

## 6. Checkout, Fulfillment und Settlement

- Hosted Checkout erhält ausschließlich eine serverseitig erzeugte Order-/Quote-Referenz. Keine Client-Metadaten bestimmen Geldbeträge oder Seller.
- Eine Bestellung kann mehrere Seller enthalten, hat aber genau ein Payment. Jede OrderItem-Zeile besitzt ihren eigenen Seller-/Provisionssnapshot.
- Nach bestätigter Zahlung werden Rechnung, Entitlements, E-Mail und Downloadzugriff idempotent erzeugt. Eine teilweise fehlgeschlagene Nachbearbeitung wird wiederholt, nicht durch eine zweite Zahlung ersetzt.
- Settlement läuft täglich. Transferfähig sind nur seit mindestens 14 Tagen bezahlte, nicht erstattete, nicht gesperrte und nicht umstrittene Positionen eines vollständig auszahlungsfähigen Connect-Kontos.
- Stripe-hosted Onboarding und Express Dashboard werden über kurzlebige serverseitige Links geöffnet. Links/Secrets werden weder gespeichert noch gemailt.
- Seller-Gutschriften werden monatlich aus dem internen Ledger erzeugt. Ungeklärter Steuerstatus blockiert Auszahlungen.

## 7. Refunds, Takedowns und Disputes

- Admin kann alle noch nicht erstatteten Positionen oder ausgewählte Bildpositionen vollständig erstatten. Der Betrag stammt aus dem OrderItem-Snapshot; eine freie Betragseingabe existiert nicht.
- Vor Transfer reduziert der Refund den Hold. Nach Transfer wird der Seller-Anteil per Transfer-Reversal zurückgeholt.
- Reicht das Stripe-Guthaben des Fotografen nicht aus, erhält der Käufer den Refund trotzdem sofort durch den MSC. Der offene Seller-Anteil wird als negativer Saldo verbucht und mit späteren Auszahlungen verrechnet; weitere Auszahlungen können gesperrt werden.
- Refund widerruft zukünftige Downloads des betroffenen Entitlements. Bereits heruntergeladene Dateien werden nicht technisch zurückgerufen.
- Takedown blockiert neue Downloads sofort, hält Transfers an und erzeugt eine Adminentscheidung. Ein Teilnehmer-Widerspruch gegen eine Zuordnung ist weiterhin von einem Bild-/Lizenz-Takedown getrennt.
- Disputes sind Plattformrisiko. Stripe-Zustand, Belege, Hold, Reversal und finale Auswirkung werden im Ledger nachvollziehbar gespeichert.

## 8. Öffentliche Schnittstellen

### Käufer und Checkout

- `POST /public/commerce/quotes`
- `POST /public/commerce/checkout-sessions`
- `POST /public/commerce/access-links`
- `POST /public/commerce/access/exchange`
- `POST /buyer/account/activate`
- `GET /buyer/orders`
- `GET /buyer/orders/{id}`
- `POST /buyer/entitlements/{id}/download`
- `DELETE /buyer/account`

### Fotograf

- `GET /photographer/payment-account`
- `POST /photographer/payment-account/onboarding-link`
- `POST /photographer/payment-account/dashboard-link`
- `POST /photographer/offer-conversions`
- `GET /photographer/offer-conversions/{id}`

### Webhooks und Administration

- `POST /webhooks/stripe/platform`
- `POST /webhooks/stripe/connect`
- Adminabfragen/-aktionen für Orders, Refunds, Transfers, Reversals, Disputes, Takedowns, Reconciliation und Conversion-Reviews.
- Schreibende Adminaktionen erhalten einen Idempotency-Key, Bearbeitungsvermerk und Audit-Actor.

## 9. Einzelne Arbeitspakete

| ID | Paket | Ergebnis / Abnahme |
|---|---|---|
| AP00 | Recht und Steuer | Schriftlich freigegebene Checkout-, Lizenz-, Widerrufs-, Rechnungs- und Seller-Abrechnungsregeln; Go-live-Gate. |
| AP01 | Stripe-Grundlage | Testkonto, Secrets, stabile API-Version, Plattform-/Connect-Webhooks und gekapselter Stripe-Adapter. |
| AP02 | Commerce-Schema | Ledgertabellen, Migrationen, Audit und Integer-Cents; Vorwärts-/Rollback-Test. |
| AP03 | Bestandsmigration | Bestehende FREE-Bilder als OfferVersion, Löschschutz und Konfliktreport. |
| AP04 | Lizenzartefakte | `licensed_full`, Metadata-Stripping, Copyright und Wasserzeichen samt Qualitätsprüfung. |
| AP05 | Step-up | `strong` für Connect, Auszahlung und Identität; Negativtests für alte/gestohlene Sessions. |
| AP06 | Connect | Express-Konto, Hosted Onboarding, Dashboard-Link und Capability-Synchronisation. |
| AP07 | Angebotsversionen | Immutable FREE/PAID-Angebote mit Preis-, Lizenz-, Steuer- und Seller-Snapshot. |
| AP08 | Conversion-Antrag | Fotografen-Batchantrag mit Rechtebestätigung, Preisstufe und Artefaktvorbereitung. |
| AP09 | Conversion-Review | Adminfreigabe/-ablehnung und atomarer Angebotswechsel ohne öffentliche Mischzustände. |
| AP10 | CDN/Manifeste | Versionierte Keys, Invalidierung, Sperre kostenloser Downloads und Cache-/Rollback-Test. |
| AP11 | Shop/Warenkorb | FREE/PAID-Darstellung; Client speichert IDs, niemals autoritative Preise. |
| AP12 | Quote-Service | 15-Minuten-Quote mit Brutto/Netto/Steuer, Seller und Provision; Manipulationstest. |
| AP13 | Käuferidentität | Eigener Buyer-Cognito-Pool, E-Mail-OTP, getrennte Claims und optionales Passkey-Enrolment. |
| AP14 | Gast-Claim | Magic Links und automatische, auditierte Übernahme passender Gastorders. |
| AP15 | Checkout Session | 30-Minuten-Session, Rechtsnachweise und eindeutig zahlungspflichtiger Bestellabschluss. |
| AP16 | Webhook/Fulfillment | Raw-Body-Prüfung, Inbox, Queue, DLQ und idempotente Entitlements. |
| AP17 | Käuferportal | Orders, Rechnungen, Lizenzen und kontrollierte erneute Downloads. |
| AP18 | Dokumente/Mails | MSC-Rechnung, Kauf-, Download-, Refund- und Takedown-Kommunikation über Outbox. |
| AP19 | Settlement | Täglicher 14-Tage-Hold-Worker; keine Doppeltransfers. |
| AP20 | Seller-Abrechnung | Monatliche Gutschrift mit Verkäufen, Refunds, Steuerstatus und Transfers. |
| AP21 | Positionsrefunds | Ganze Items oder ganze Order, Entitlement-Widerruf, `PARTIALLY_REFUNDED`. |
| AP22 | Refund nach Transfer | Reversal, negativer Seller-Saldo und MSC-Sofortrefund. |
| AP23 | Takedown/Dispute | Sofortsperre, Hold, Belegworkflow und finale Adminentscheidung. |
| AP24 | Admin/Reconciliation | Übersichten, Ausnahmewarteschlange und täglicher Stripe-Abgleich. |
| AP25 | Rollout/Betrieb | Getrennte Flags, Testkauf, Pilot, Alarme, Runbooks und kontrollierte öffentliche Aktivierung. |

Abhängigkeiten: AP00/AP01 sind Gates; AP02–AP07 bilden das Fundament; AP08–AP14 können danach parallel nach Oberfläche geschnitten werden; AP15–AP18 benötigen Quote, Buyer und Webhooks; AP19–AP24 benötigen das vollständige Ledger; AP25 schließt die Einführung ab.

## 10. Test- und Abnahmematrix

- Gastkauf, Kontoerstellung und automatische Übernahme mehrerer historischer Orders; keine Übernahme bei unbestätigter oder abweichender Adresse.
- Multi-Seller-Warenkorb mit einer Zahlung, getrennten OrderItems und späteren sellerbezogenen Transfers.
- Manipulierte Preise/Offer-IDs, abgelaufene Quote und zwischenzeitliche FREE→PAID-/Preisänderung.
- Conversion ohne Freigabe, Ablehnung, parallele Freigaben, Artefaktfehler, CDN-Cache und alte Presigned URL.
- Doppelte, verzögerte und vertauschte Stripe-Events; Worker-Retry und DLQ-Replay ohne doppelte Order, Rechnung, Entitlement oder Transfer.
- Vollrefund, Refund einzelner Positionen, Refund vor/nach Transfer, gescheitertes Reversal und negativer Seller-Saldo.
- Takedown zwischen Zahlung, Download und Transfer; Dispute vor/nach Auszahlung.
- Käuferkontolöschung, E-Mail-Wechsel, kollidierende Konten, Tokenablauf, Magic-Link-Replay und Enumeration-Schutz.
- Rechnungs-/Gutschriftwerte müssen aus Snapshots und Ledger vollständig reproduzierbar sein.
- Securitytests für Webhook-Signatur, Raw Body, JWT-Audience, Rollen-/Pooltrennung, IDOR, Downloadlimits und Objektzugriff.
- Lasttests für Quote/Checkout, Webhook-Bursts, Manifestwechsel, Downloads und Settlement.

## 11. Rollout und Monitoring

Getrennte Flags: `commerceBuyerAccounts`, `commercePaidOffers`, `commerceCheckout`, `commerceSettlement` und `commerceFreeToPaidConversion`; standardmäßig `false`.

Reihenfolge:

1. Infrastruktur und Migrationen ohne aktive PAID-Funktion.
2. Käuferkonto und Adminansichten intern.
3. Stripe-Testmodus mit MSC-internen Käufen und Refunds.
4. Pilot mit wenigen freigegebenen Fotografen und Bildern.
5. Reconciliation über mindestens einen vollständigen 14-Tage-Hold-Zyklus.
6. Rechts-/Finance-/Operations-Abnahme und kontrollierte Aktivierung.

Alarme: Webhook-Signaturfehler, Inbox-Alter, DLQ, Payment ohne Entitlement, Ledger-/Stripe-Differenz, Transferfehler, Reversalfehler, Invoicefehler, hohe Refund-/Disputequote und ungewöhnliche Downloadrate.

## 12. Bewusste Nicht-Ziele von V1

- Keine frei eingegebenen Teilrefundbeträge, Coupons, Ratenzahlung oder verzögerten Zahlungsmethoden.
- Keine gespeicherten Zahlungsdaten beim MSC und keine eigene Banking-/KYC-Oberfläche.
- Keine automatische Rücknahme bereits heruntergeladener FREE- oder Kaufdateien.
- Keine automatische Accountzusammenführung bei unterschiedlichen E-Mail-Adressen.
- Kein internationaler Verkauf, keine Fremdwährungen und kein Merch-Versand im ersten Release.

<!-- Ende des synchronisierten Marketplace-Plans. -->
