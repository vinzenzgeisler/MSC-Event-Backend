<!-- Dieses Dokument wird 1:1 in allen 3 Repos synchron gehalten (wie racepic-architecture.md).
     Es fasst offene Anforderungen und Lücken aus allen repo-spezifischen racepic-progress.md
     zusammen, damit man sie nicht in drei Dateien einzeln suchen muss. Bei jeder Änderung an
     einem offenen Punkt: hier UND im jeweiligen repo-spezifischen racepic-progress.md
     aktualisieren. -->

# RacePic – Offene Punkte (konsolidiert)

**Stand:** 2026-09-22. Code-seitig sind die Pakete 0–13 abgeschlossen und verifiziert (siehe die
repo-spezifischen `racepic-progress.md`), aber noch **nicht deployed**. Dieses Dokument bündelt,
was vor bzw. nach dem ersten echten Piloten (12. OLD 2026) noch zu tun ist.

## A. Blockierend vor dem ersten echten Piloten

Diese Punkte sind entweder organisatorisch (keine Code-Änderung) oder brauchen echten
AWS-Zugriff, den diese Sandbox nicht abschließend verifizieren kann.

1. **Rechtstexte freigeben.** Datenschutzhinweis RacePic und Fotografen-Nutzungsbedingungen
   (`docs/privacy/racepic-legal-texts-v1.md`, `docs/racepic/licenses.md` im Backend-Repo, Entwurf
   seit Paket 0) müssen durch Datenschutzbeauftragten/Vorstand freigegeben werden, bevor echte
   Fotograf:innen eingeladen und echte Teilnehmerdaten veröffentlicht werden. Reine
   Organisationsaufgabe, kein Code.
2. **Namenssuche nach 365 Tagen.** Offene Grundsatzfrage (siehe racepic-architecture.md,
   Abschnitt "Datenschutz"): nach der automatischen Anonymisierung verschwindet der Name aus den
   öffentlichen Manifesten, die Bildzuordnung bleibt aber über Startnummer/Klasse/Fahrzeug
   bestehen. Soll der Name stattdessen dauerhaft suchbar bleiben, braucht es eine zusätzliche
   Rechtsgrundlage (z. B. eine eigene RacePic-Einwilligung bei der Nennung). Entscheidung bei
   Vorstand/Datenschutz, technisch ist die aktuelle Variante bereits vollständig umgesetzt.
3. **Bedrock live testen.** `cohere.embed-v4:0` in eu-west-1 – Format ist anhand der aktuellen
   AWS-Doku verifiziert (Paket 6), aber noch nie live aufgerufen. Ein erster Versuch scheiterte am
   2026-09-22 an einer AWS-Kontoverifizierung (`AccessDeniedException: Your account is currently
   being verified`) – erneut versuchen, sobald diese abgeschlossen ist.
4. **CloudFront-Deploy in der Linux-CI beobachten.** `sharp` (natives Modul im
   `RacePicIngestWorker`) wurde lokal auf Windows nur mit Windows-Binaries gebündelt; der echte
   Linux-Build in GitHub Actions muss einmal beobachtet werden, um zu bestätigen, dass er
   Linux-x64-Binaries verwendet und ein Bild tatsächlich verarbeitet werden kann.
5. **CloudFront-Signing-Keypair erzeugen.** Bis dahin laufen Downloads über S3-Presigned-URLs
   statt CloudFront Signed URLs (funktioniert, ist aber die in Paket 1/8 dokumentierte
   Interimslösung).

## B. Entwicklungsumgebung (Paket 13, 2026-09-22)

- Backend (MSC-Event-Backend) und Nennungstool-Frontend (MSC-Event-Frontend) sind für einen
  normalen Prod-Deploy vorbereitet (interne, authentifizierte Tools) – Aktivierung von RacePic
  läuft über die GitHub-Environment-Variable `PROD_ENABLE_RACEPIC=true` plus Merge nach `main`.
- Die öffentliche RacePic-Website (msc-website) bleibt bewusst **vom Live-Merge nach `main`
  ausgenommen** – die neuen `/racepic/*`-Seiten sollen vorerst nur lokal (`npm run dev`,
  `localhost:8080`) gegen das Prod-Backend getestet werden, nicht auf der echten Domain live
  gehen. Dafür wurden `http://localhost:8080` in die API- und CloudFront-CORS-Allowlists von
  `prod.ts` aufgenommen (mit Kommentar, das nach dem echten Go-Live wieder zu entfernen).
- Ein bisher unentdeckter Fund dabei: `RacePicStack` wurde von der CI/CD-Pipeline nie deployed
  (fehlender Schritt in `ci-cd.yml`) und CloudFront hatte keine CORS-Antwort-Header für die
  Manifeste – beides behoben, siehe „Paket 13 – Ergebnis" in `MSC-Event-Backend/docs/memory-bank/racepic-progress.md`.

## C. Nicht blockierend, bewusst zurückgestellt

| Punkt | Repo | Notiz |
|---|---|---|
| Kein Rate-Limiting auf `POST /public/racepic/images/{id}/download` | Backend | Vor breiterem öffentlichem Traffic nachziehen |
| Kein Soft-Lock in der Review-Queue | Backend/Frontend | Bei kleinem Orga-Team unkritisch |
| Passkey-Login (WEB_AUTHN) im Studio fehlt; E-Mail-OTP und Passwort vorhanden | Website | Nachziehen und vor Marketplace-Step-up (`strong`) testen |
| E-Mail-Änderung im Fotografenprofil nicht möglich | Backend/Website | Braucht Stufe „recent" + Cognito-Attributänderung |
| Dynamische Sitemap-Einträge pro Event/Teilnehmer fehlen | Website | Nur der statische `/racepic`-Einstieg ist gelistet |
| Matching-Gewichte im Admin editierbar, Kalibrierung noch offen | Frontend/Backend | Versionierte Gewichte und Schwellen jetzt im Formular; echte Review-Daten für die Auswahl fehlen noch |
| Keine Cost Anomaly Detection, nur das `CfnBudget` aus Paket 9 | Backend | Bräuchte eine SNS-Themen-Abo-Bestätigung |
| Vereinfachtes Copyright-Handling (EXIF-Tag statt vollem IPTC/XMP) | Backend | Bei Bedarf nachziehen, falls Fotoportale volle IPTC-Metadaten erwarten |
| `RACEPIC_EMBEDDING_MODEL_ID`-Override nicht als CDK-Env-Var gesetzt | Backend | Nutzt aktuell immer den Default `cohere.embed-v4:0` |

## D. Für den Marketplace (deutlich später, nicht MVP)

- **Rechtliches Seller-Modell (A/B)** – verkauft der Fotograf selbst und der MSC vermittelt nur,
  oder verkauft der MSC? Braucht vor jeder Zahlungsimplementierung eine steuerliche/rechtliche
  Prüfung (siehe racepic-architecture.md Abschnitt K).
- Stripe Connect, Käufer-Entitlements und `strong`-Step-up gehören zum späteren Checkout. Die
  private Wasserzeichen-Vorschau für interne Preisentwürfe ist bereits in Paket 21 vorbereitet.
- **Warenkorb-/Konto-UI (Paket 18, msc-website) ist reine Vorbereitung, kein Checkout.** Der
  client-seitige Warenkorb (`localStorage`, `src/integrations/racepic/cart.tsx`) sammelt nur
  bereits kostenlose Bilder für einen bequemen Sammel-Download (ruft denselben bestehenden
  `POST /public/racepic/images/{id}/download`-Endpunkt mehrfach auf) – kein Konto, keine
  Zahlung, kein Backend-Zustand. Das Konto-Icon im RacePic-Header ist absichtlich deaktiviert.
  Der eigentliche Checkout/Bezahlvorgang startet erst nach der oben genannten Rechtsprüfung und
  den Marketplace-Paketen M1–M5.

## Verweise

## E. Ausbaupakete 19–24 (in Arbeit auf den Feature-Branches, 2026-09-22)

| Paket | Inhalt | Verifikation vor Freigabe |
|---|---|---|
| 19 Öffentliche Galerie | Gemeinsamer Bilddialog, Metadaten, ähnliche Bilder, Event-Filter, paginierte Entdeckung, DE/CZ/EN/PL, Layoutkorrekturen | Browserprüfung in allen vier Sprachen und auf schmalem Bildschirm |
| 20 Studio und Zugang | Passwort und E-Mail-OTP, 30-Tage-Refresh, Selbstregistrierung mit E-Mail-Bestätigung, Admin-Freigabe, Bildeditor | Echter Cognito-Flow, Wiederanmeldung nach Reload, Freigabe und Upload |
| 21 Interne Shop-Daten | EUR-Preis pro Bild, versionierte Lizenz, private Wasserzeichen-Vorschau, Sperre öffentlicher PAID-Bilder | Datenbankmigration, Preis-/Lizenzwechsel, CDN- und Download-Sperren |
| 22 Admin | Direkter Event-Einstieg, Status und Pipeline-Schritte, Zuordnungen, manuelles Matching, Gewichte, Fotografenfreigabe | Review eines echten Testbilds nach Deploy |
| 23 KI | OCR-Crops, räumliche Zuordnung bei überlappenden Fahrzeugen, Fahrzeug-Label-Fallback, gecachte Referenzen, Reanalyse | Goldsatz mit bestätigten Zuordnungen, Precision/Recall vor und nach Änderung |
| 24 Recht und Betrieb | Lizenz-/Datenschutznachtrag, öffentliche Event-Sperre, Dokumentationssync | Rechts- und Steuerprüfung vor Kauf/Go-live; CI- und Browserprüfung |

**Noch offen:** Passkey-UI, echter KI-Goldsatz und Live-Messung, AWS-/Cognito-/CDN-Integrationstest sowie der spätere Checkout mit Stripe Connect. Bezahlbilder bleiben bis dahin intern; ein öffentlicher Shop-Verkauf ist nicht freigeschaltet. Backend und Nennungstool-Admin bleiben bis zur Paketabnahme ungemergt; die Website bleibt außerhalb von main.

- Architektur: [racepic-architecture.md](./racepic-architecture.md)
- Repo-spezifischer Umsetzungsstand: `docs/memory-bank/racepic-progress.md` in jedem der drei Repos
- Betrieb: `docs/racepic/runbook.md` (MSC-Event-Backend)
