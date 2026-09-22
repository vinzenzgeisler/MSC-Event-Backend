<!-- Dieses Dokument wird 1:1 in allen 3 Repos synchron gehalten (wie racepic-architecture.md und
     racepic-open-items.md). Es ist die genehmigte Roadmap für Pakete 14+ (UI/UX-Redesign),
     Umsetzungsstand siehe die jeweils repo-spezifische racepic-progress.md. -->

# RacePic – UI/UX-Redesign-Roadmap (Pakete 14+)

**Stand:** 2026-09-22, genehmigt.

## Context

Der funktionale MVP (Pakete 0–13) läuft produktiv gegen prod (Backend + Nennungstool-Frontend
deployed, RacePic aktiviert; msc-website bewusst nur lokal). Beim ersten echten End-to-End-Test
(Login, Upload, Analyse, Matching) hat der Verein die UI aus drei Blickwinkeln bewertet und
explizit "eine bessere und produktivere UI/UX" für alle drei Oberflächen angefragt, mit dem Ziel
eines **eigenständigen, aber gut integrierten Sub-Produkts** ("wie AirBnB, aber gut in die
Website integriert") – bis hin zu einem späteren Stripe-Checkout. Das ist bewusst zu groß für ein
einzelnes Paket; dieses Dokument bricht es in eine Reihenfolge von Paketen (14–18) herunter, jedes
für sich lauffähig, verifizierbar und wie gewohnt in `docs/memory-bank/racepic-progress.md`
dokumentiert. Bezahlung/Stripe selbst (Marketplace-Pakete M1–M5) bleibt explizit außen vor – hier
geht es nur um die UI-*Vorbereitung* dafür, die eigentliche Zahlungsanbindung startet erst nach
der schon dokumentierten rechtlich/steuerlichen Prüfung (siehe `racepic-open-items.md` Abschnitt D).

**Vorhandene Bausteine, die wiederverwendet werden (kein Neubau nötig):**
- `msc-website/src/integrations/racepic/client.ts`: `listMyImages`, `updateMyProfile`,
  `fetchMyEventAccess`, `fetchLicenses` sind bereits fertige, funktionierende API-Client-Funktionen
  – bisher nur nirgends in einer UI verwendet.
- `msc-website/src/components/ui/tabs.tsx` existiert bereits (volles shadcn-Kit dort).
- Design-Tokens (`tailwind.config.ts`, `src/index.css`): `--primary` (Racing-Blau
  `hsl(220 70% 35%)`), `--accent` (Gelb `hsl(48 100% 50%)`), `--radius: 0` (kantig), Schriften
  `font-sans` = Barlow, `font-heading`/`display` = Oswald (fett, kondensiert, uppercase) – das ist
  bereits eine klare, sportliche Bildsprache, auf der eine RacePic-Submarke aufbauen kann, statt
  eine neue zu erfinden.
- `MSC-Event-Frontend`: **kein** `tabs.tsx` im UI-Kit (nur button/input/label/card/badge/select) –
  wurde für Paket 14 aus msc-website portiert (plus `@radix-ui/react-tabs`-Dependency, analog zum
  bereits vorhandenen `@radix-ui/react-select`).

## Paket-Roadmap

| # | Paket | Repo(s) | Kernidee |
|---|---|---|---|
| 14 | Design-Grundlage | msc-website, MSC-Event-Frontend | RacePic-Wortmarke-Komponente, Tabs-Komponente nach MSC-Event-Frontend portieren |
| 15 | Studio-Redesign | msc-website (+ Backend-Ergänzung) | Header mit Logout/Event-Switcher, "Meine Bilder"-Verwaltung, Profil-Formular inkl. Zahlungs-Platzhalter, Lizenz-Infoseite |
| 16 | Admin-Redesign mit Tabs | MSC-Event-Frontend | `/admin/racepic` in Tabs (Übersicht/Fotograf:innen/Bilder/Zuordnung/KI-Konfiguration), Bilder als Grid mit Bulk-Aktionen, direkter Sprung Bild→Zuordnung |
| 17 | Öffentliche Landingpage | msc-website (+ Backend-Ergänzung) | Airbnb-große Suchleiste mit event-übergreifender Autocomplete, Unsplash-artiges Masonry-Grid mit "mehr laden" darunter |
| 18 | Warenkorb/Konto-UI (Vorbereitung, kein Checkout) | msc-website | Client-seitiger Warenkorb (Mehrfachauswahl + Sammel-Download), Konto-Icon-Platzhalter im RacePic-Header |

Reihenfolge: **14 → 15 → 16 → 17 → 18**, weil 14 die Grundlage für alle anderen ist und die
konkret gemeldeten Schmerzpunkte (Studio-UX, Admin-Übersicht bei vielen Bildern) vor der reinen
Landingpage-Optik kommen sollten.

---

## Paket 14 – Design-Grundlage

- **`msc-website/src/components/racepic/RacePicWordmark.tsx`**: reine CSS/Tailwind-Komponente
  (kein SVG/Bild nötig, bleibt crisp bei jeder Größe, theme-aware wie der Rest der Seite) –
  "Race" in `font-heading`/Oswald fett uppercase in der Vordergrundfarbe, "Pic" in `text-accent`
  (Gelb), leichte Skew-Neigung für den Racing-Charakter, Größe über eine `size`-Prop steuerbar
  (klein für die Nav, groß für den Hero). Ersetzt den reinen Textlink `t.nav.racePic` in
  `Header.tsx` und wird auf der Landingpage (Paket 17) als Hero-Lockup verwendet.
- **`MSC-Event-Frontend/src/components/ui/tabs.tsx`** (portiert aus msc-website): identisches
  shadcn-Tabs-Muster, `@radix-ui/react-tabs` als neue Dependency.
- **Verifikation:** `tsc --noEmit` + `npm run build` in beiden Repos.

## Paket 15 – Studio-Redesign (Fotograf:in)

**Backend-Ergänzung (MSC-Event-Backend, klein):**
- `GET /photographer/images`: um eine presignte Vorschau-URL ergänzen (analog zu
  `listImagesForEvent`/Paket 11 im Admin – `presignGetObject('derived/{id}/thumb.webp', ...)`),
  damit auch unveröffentlichte (private) eigene Bilder als Thumbnail sichtbar sind.
- Neu: `PATCH /photographer/images/{id}` (nur `visibility: 'HIDDEN'` – ein Fotograf darf sein
  eigenes Bild selbst verbergen, aber nicht veröffentlichen/entfernen, das bleibt Admin-Sache) und
  `DELETE /photographer/images/{id}` (nur solange `visibility='DRAFT'`, also vor jeder
  Veröffentlichung – danach nur der Admin-Weg). Beides war in Abschnitt H des Architekturplans
  bereits vorgesehen, aber nie gebaut (derselbe Musterfund wie bei Paket 5/7/11).
- `email` und `licenses`-Detailfelder (`summary`, `terms`, Preis-/Nutzungs-Flags) liefert
  `GET /photographer/licenses` bereits vollständig (`LicenseOption` in `client.ts`) – keine
  Backend-Änderung nötig für die Lizenz-Infoseite.

**Website (msc-website):**
- Neues `StudioLayout.tsx` (umschließt alle `/racepic/studio/*`-Unterseiten nach dem Login):
  schlanke Kopfzeile mit `RacePicWordmark` (klein) + Fotografenname + Event-Switcher (Dropdown aus
  `fetchMyEventAccess()`) + "Abmelden"-Button (`clearPhotographerSession()` + Redirect zu
  `/racepic/studio/login`, bisher nirgends aufgerufen).
- `StudioPage.tsx` wird zum Dashboard mit klaren Bereichen statt einer langen Spalte:
  Kurzstatistik oben (Anzahl Bilder je Status – aus `listMyImages()` clientseitig aggregiert),
  darunter die drei Bereiche als eigene Unterseiten/Tabs: **Hochladen** (bestehendes
  `StudioUploadPanel`), **Meine Bilder** (neu, Grid mit Thumbnail/Status/Sichtbarkeit,
  Event-Filter, "Verbergen"/"Löschen"-Aktionen gegen die neuen Endpunkte oben), **Profil** (neu,
  Formular gegen `updateMyProfile()`: Anzeigename, Copyright-Zeile, Website, Social-Links,
  Standard-Lizenz – plus eine deaktivierte Karte "Zahlungen & Auszahlung – folgt mit dem
  Online-Shop", die die spätere Stripe-Connect-Einbindung ankündigt, ohne sie zu versprechen).
- Neue Lizenz-Infoseite/-Sektion (Karten je Lizenz mit `title`/`summary`/`terms` aus
  `fetchLicenses()`, in der jeweiligen Sprache) – als eigene Route `/racepic/studio/lizenzen` und
  als Link/Tooltip direkt im Lizenz-Auswahlfeld des Upload-Panels.
- **Verifikation:** `tsc --noEmit`, `npm run build`, manueller Login-Test lokal gegen die
  Prod-API (bereits eingerichtet, siehe `.env.local`).

## Paket 16 – Admin-Redesign mit Tabs (MSC-Event-Frontend)

- `racepic-page.tsx` bekommt pro Event eine Tab-Leiste (aus Paket 14) statt der aktuell linear
  gestapelten Konfiguration/Statistik/Bilder/Matching-Bereiche:
  - **Übersicht**: bestehende Statistik-Kacheln.
  - **Fotograf:innen**: die bestehende `PhotographersSection`, aber gefiltert auf Zugang zu
    diesem Event statt einer globalen Liste.
  - **Bilder**: aus der bisherigen Tabellen- in eine Grid-Ansicht (größere Thumbnails, wie ein
    Kontaktabzug), zusätzlich Mehrfachauswahl (Checkbox pro Kachel) für Bulk-Veröffentlichen/
    -Verbergen (ein `PATCH`-Aufruf pro ausgewähltem Bild, sequenziell, mit Fortschrittsanzeige –
    kein neuer Bulk-Endpunkt nötig für den ersten Wurf). Klick auf ein Bild öffnet ein Detail-
    Panel mit größerer Vorschau **und** – das schließt die vom Verein explizit genannte Lücke
    ("wie ich die Zuordnung zum Fahrer sehen/ändern kann") – den aktuellen Zuordnungen dieses
    Bildes (neuer, kleiner Endpunkt `GET /admin/racepic/images/{id}/assignments`, liest
    `racepic_assignment` nach `imageId` statt nach `entryId` wie das bestehende
    `listImagesForEntry`) mit Confirm/Reject/Correct-Aktionen direkt dort (Wiederverwendung der
    bestehenden `confirmAssignment`/`rejectAssignment`/`correctAssignment`-Endpunkte).
  - **Zuordnung**: verlinkt weiterhin auf die bestehende Review-Queue-Seite (eigene Route bleibt,
    da sie eine eigene Kartenansicht mit BBox-Overlay braucht, kein Tab-Inhalt).
  - **KI-Konfiguration**: die bestehende `MatchingSection`, umbenannt/hervorgehoben.
- **Verifikation:** `tsc --noEmit`, `npm run build`.

## Paket 17 – Öffentliche Landingpage (Unsplash/Airbnb-Stil)

**Backend-Ergänzung (MSC-Event-Backend):**
- Neue globale Manifeste, geschrieben von `regenerateManifestsForEvent`/`unpublishEventManifests`
  zusätzlich zum bisherigen `manifests/events.json` (gleiches Muster: bei jeder Änderung
  neugeschrieben, `manifests/*`-Cache-TTL 60s):
  - `manifests/discover.json`: die neuesten N (z. B. 60) veröffentlichten Bilder **über alle**
    veröffentlichten Events hinweg (imageId, thumbUrl, eventSlug, participantKey, capturedAt) –
    Grundlage für das Masonry-Grid unterhalb der Suche.
  - `manifests/search-index.json`: flache Liste aller suchbaren Teilnehmer **über alle**
    veröffentlichten Events (participantKey, eventSlug, startNumber, displayName, make, model,
    className) – Grundlage für die event-übergreifende Autocomplete-Suche, bleibt konsistent mit
    dem Architekturprinzip "öffentlicher Traffic trifft nie Lambda/DB" (weiterhin nur CDN-Fetch).
- Kostenkontrolle: beide Dateien werden nur bei tatsächlichen Publish-Events neu geschrieben (kein
  periodischer Job), Umfang ist die Summe aller bereits vorhandenen Event-Indizes.

**Website:**
- `RacePicHomePage.tsx` komplett neu: große, zentrierte Suchleiste (Autocomplete gegen
  `search-index.json`, Ergebnis führt direkt zur Teilnehmerseite oder bei Event-Treffern zur
  Event-Seite) im Airbnb-Stil, darunter ein Masonry-/Justified-Grid aus `discover.json` mit
  "Mehr laden" (kein echtes Infinite Scroll nötig bei 60 Bildern, ein Button reicht) –
  `RacePicWordmark` (groß) als Hero-Lockup.
- **Verifikation:** `tsc --noEmit`, `npm run build`, manueller Test der Suche gegen echte
  Prod-Manifeste.

## Paket 18 – Warenkorb/Konto-UI (nur Vorbereitung, kein Checkout)

- Client-seitiger Warenkorb (React Context + `localStorage`, kein Backend): Bilder lassen sich auf
  der Teilnehmerseite zum Warenkorb hinzufügen (Mehrfachauswahl statt Einzel-Download), ein
  Warenkorb-Icon im RacePic-Header öffnet eine Drawer-Ansicht mit Sammel-Download-Button (ruft für
  jedes ausgewählte Bild den bestehenden `POST /public/racepic/images/{id}/download`-Endpunkt auf
  – funktional identisch zum heutigen Einzel-Download, nur komfortabler für mehrere Bilder).
- Konto-Icon im Header als bewusst deaktivierter Platzhalter mit Tooltip "kommt mit dem
  RacePic-Shop" – keine echte Buyer-Authentifizierung, kein Stripe.
- **Explizit dokumentiert** (in `racepic-open-items.md`, Abschnitt D): das ist reine
  UI-Vorbereitung: der eigentliche Checkout/Bezahlvorgang startet erst nach der rechtlichen/
  steuerlichen Prüfung des Seller-Modells (bereits als Blocker gelistet) und den
  Marketplace-Paketen M1–M5.
- **Verifikation:** `tsc --noEmit`, `npm run build`.

---

## Dokumentation

Wie bisher: jedes Paket bekommt einen "Paket N – Ergebnis"-Abschnitt in der jeweils
repo-spezifischen `docs/memory-bank/racepic-progress.md`, plus Aktualisierung von
`racepic-open-items.md`, wo relevant. Dieses Dokument (Roadmap) bleibt 1:1 in allen drei Repos
synchron, wie `racepic-architecture.md` und `racepic-open-items.md`.
# Ergänzung Pakete 19–24 (2026-09-22)

1. **Galerie:** Ein Klick auf ein Bild öffnet überall denselben Dialog mit großer Vorschau, Fotograf, Lizenz, Kamera, Aufnahmedatum, Tags, Fahrzeugen und verwandten Bildern. Favoriten bleiben im Browser. Die öffentliche UI ist in Deutsch, Tschechisch, Englisch und Polnisch nutzbar.
2. **Shop-Vorbereitung:** Das Studio verwaltet pro unveröffentlichtem Bild Titel, Beschreibung, Tags, Lizenz und EUR-Preis. Kostenpflichtige Bilder sind mit Wasserzeichen ausschließlich privat sichtbar. Warenkorb und kostenloser Download bleiben auf FREE-Bilder beschränkt. Checkout und öffentliche PAID-Angebote folgen erst nach Rechts- und Steuerprüfung.
3. **Studio:** E-Mail-OTP und Passwort, selbstständige Registrierung mit bestätigter E-Mail und Admin-Freigabe. Die Session kann mit Refresh-Token bis zu 30 Tage bestehen. Ein geführter Passkey-Flow bleibt offen.
4. **Admin:** Direkter Event-Einstieg, eine Übersicht der Bildzustände, sichtbare Pipeline-Schritte, Fahrerzuordnung und Reanalyse im Bilddetail sowie versionierte Matching-Gewichte im Formular.
5. **KI:** Zusätzliche OCR-Crops bei fehlender Vollbild-Erkennung, räumliche Zuordnung von Text zu überlappenden Fahrzeugen, Rekognition-Fallback und wiederverwendete Referenzdaten. Vor Produktivfreigabe anhand realer, geprüfter Bilder vergleichen.
