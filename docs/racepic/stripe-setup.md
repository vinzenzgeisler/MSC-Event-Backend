# RacePic: Stripe einrichten (Testumgebung)

## Stand (2026-09-28)

- **Stripe-Sandbox verbunden:** „MSC Oberlausitzer Dreiländereck e.V. Sandbox" (`acct_1UKiLPHyPy56TkTk`), Land
  Deutschland. Angemeldet über `stripe login` (Geräte-Autorisierung); der Schlüssel liegt nur lokal in der
  Stripe-CLI-Konfiguration, nicht im Repository.
- **Connect-Marktplatzmodell gewählt:** „Sie ziehen Zahlungen ein und leiten diese an die Empfänger/innen weiter"
  (Kunde → Sie → Empfänger) im Connect-Einrichtungsassistenten des Dashboards — das entspricht „Separate Zahlungen
  und Überweisungen" (Schritt 2).
- **Kontoerstellung auf Accounts v2 umgestellt** (siehe Abschnitt „Hinweis zum Kontotyp" unten) und gegen die
  Sandbox verifiziert.
- **Noch offen:** Schritt 3 (Plattformprofil und Haftungsbestätigung im Dashboard), Dev-Deploy, Schritte 7–9
  (Webhook-Endpunkte, AWS-Secret, GitHub-Variablen).


Ziel: Ein Stripe-Testkonto des Vereins, das Zahlungen annimmt und Fotograf:innen als Verkäufer einbindet
(Stripe Connect). Alles hier passiert zuerst nur im **Testmodus**. Es fließt kein echtes Geld, und für den Testmodus
ist keine Kontoaktivierung nötig. Live-Betrieb kommt erst nach der rechtlichen und steuerlichen Freigabe (AP00).

**Regel:** Schlüssel (`sk_…`) und Signing-Secrets (`whsec_…`) nie in Chats, Tickets, E-Mails oder das Repository
schreiben. Sie gehören ausschließlich in den AWS Secrets Manager (Schritt 8).

## Wer macht was

| Schritt | Wer | Zeitaufwand |
|---|---|---|
| 1–7 Stripe-Dashboard | Person mit Zugang zum Vereins-Stripe-Konto (idealerweise Vorstand oder Kassenwart) | ca. 30–45 Minuten |
| 8 Secret in AWS eintragen | Person mit Zugriff auf den Dev-AWS-Account | 5 Minuten |
| 9 GitHub-Variablen und Deploy | Repository-Admin | 10 Minuten |

## Teil A: Testumgebung

### 1. Konto öffnen
Auf [dashboard.stripe.com](https://dashboard.stripe.com) mit dem Vereinskonto anmelden (oder eines anlegen: Name
„MSC Oberlausitzer Dreiländereck e.V.“, Land Deutschland). Oben in den **Testmodus** bzw. eine **Sandbox** wechseln
und dort bleiben.

### 2. Connect aktivieren
Im Dashboard **Connect** öffnen und die Einrichtung für Plattformen durchlaufen. Passende Antworten:
- Wir sind ein **Marktplatz/eine Plattform**: Fotograf:innen verkaufen über RacePic, der MSC nimmt die Zahlung ein.
- Der MSC zieht die Zahlung selbst ein und überweist den Anteil später an die Fotograf:innen
  („Separate Zahlungen und Überweisungen“).
- Onboarding der Fotograf:innen: **von Stripe gehostet**. Dashboard für sie: **Express-Dashboard**.

### 3. Plattformprofil und Verantwortung bestätigen (wichtig)
- **Plattformprofil** vervollständigen: [Connect-Registrierung](https://dashboard.stripe.com/connect/registration).
- **Verantwortung bestätigen:** [Plattformprofil in den Connect-Einstellungen](https://dashboard.stripe.com/settings/connect/platform_profile).
  RacePic legt Fotografenkonten so an, dass **der MSC für negative Salden haftet und die Stripe-Gebühren trägt**
  (so ist es im Plan festgelegt). Stripe verlangt dafür, dass die Plattform ihre Verantwortlichkeiten einmal im
  Dashboard bestätigt. Ohne diese Bestätigung schlägt das Anlegen von Konten fehl.

### 4. Erscheinungsbild und Länder
- [Connect-Einstellungen](https://dashboard.stripe.com/account/applications/settings): Name **MSC RacePic**, Icon und
  Farbe für das Onboarding-Formular.
- [Express-Einstellungen](https://dashboard.stripe.com/account/applications/settings/express): Land **Deutschland**;
  nur die Fähigkeit **Überweisungen (transfers)**. Karten-Zahlungen für Verkäufer werden nicht gebraucht.

### 5. Zahlungsmethoden
Unter **Einstellungen → Zahlungsmethoden**: **Karten** aktiv lassen (Apple Pay und Google Pay laufen im gehosteten
Checkout automatisch mit). Verzögerte Methoden (z. B. SEPA-Lastschrift) sind in V1 bewusst ausgeschlossen; RacePic
fordert später ausdrücklich nur Karten an.

### 6. API-Schlüssel (Test)
**Entwickler → API-Schlüssel**: den **Geheimschlüssel** im Testmodus (`sk_test_…`) kopieren. Bitte nicht weitergeben
oder speichern, außer in Schritt 8.

### 7. Webhook-Endpunkte (Test)
Voraussetzung: Die Dev-Umgebung ist einmal deployt. Ihre Basis-URL steht in der Ausgabe `ApiUrl` des Stacks
`dreiecksrennen-dev-api-stack` (CloudFormation-Ausgaben bzw. CI-Log).

**Entwickler → Webhooks → Endpunkt hinzufügen** (zwei Stück):

| Endpunkt | URL | Einstellung | Ereignisse (jetzt) |
|---|---|---|---|
| Plattform | `<ApiUrl>/webhooks/stripe/platform` | Ereignisse **des eigenen Kontos** | noch keine nötig (später Zahlung, Erstattung, Streitfall) |
| Connect | `<ApiUrl>/webhooks/stripe/connect` | „Ereignisse **von verbundenen Konten** überwachen“ aktivieren | `account.updated`, `capability.updated` |

Beide Endpunkte jetzt anlegen, auch wenn der Plattform-Endpunkt noch nichts auslöst: Jeder hat ein **eigenes
Signing-Secret** (`whsec_…`), und beide werden in Schritt 8 gebraucht.

### 8. Zugangsdaten im AWS Secrets Manager
Das Secret `dreiecksrennen-dev/racepic/stripe` legt der Deploy an (zufälliger Platzhalterinhalt). Der Inhalt muss
durch dieses JSON ersetzt werden, in der Region `eu-central-1`:

```json
{
  "secretKey": "sk_test_...",
  "platformWebhookSecret": "whsec_...",
  "connectWebhookSecret": "whsec_..."
}
```

Per Konsole (Secrets Manager → Secret → „Geheimniswert abrufen“ → Bearbeiten → Klartext) oder per CLI:

```bash
aws secretsmanager put-secret-value --region eu-central-1 \
  --secret-id dreiecksrennen-dev/racepic/stripe --secret-string file://stripe.json
```

Die Datei `stripe.json` danach sofort löschen.

### 9. Flags in GitHub setzen und deployen
Repository **MSC-Event-Backend → Settings → Secrets and variables → Actions → Variables**:

| Variable | Wert | Wofür |
|---|---|---|
| `DEV_ENABLE_RACEPIC` | `true` | (besteht bereits) |
| `DEV_COMMERCE_FREE_TO_PAID_CONVERSION` | `true` | Preisumstellungs-Anträge |
| `DEV_COMMERCE_SETTLEMENT` | `true` | Passkey, Zahlungskonto, Webhooks |
| `DEV_COMMERCE_PAID_OFFERS` | `true` | freigegebene PAID-Bilder öffentlich sichtbar |
| `DEV_COMMERCE_CHECKOUT` | `true` | Quote und (später) Checkout |

Nicht gesetzte Variablen bedeuten „aus“. Danach die Dev-Umgebung über den bekannten Weg deployen (Tag
`deploy-dev/<name>`, siehe `docs/github-actions-cicd.md`). Schritt 8 (Secret füllen) und Schritt 7 (Webhooks) hängen am
ersten Deploy, weil vorher weder das Secret noch die URL existiert; die Reihenfolge ist also: erst deployen, dann
Schritte 7 und 8, dann Flags prüfen.

### 10. Ausprobieren
1. Im Studio (Website, Dev) anmelden → Tab **Auszahlungen** → **Passkey hinzufügen**.
2. **Einrichtung starten**: Das Stripe-Onboarding öffnet sich. Im Testmodus mit den Testdaten aus der
   [Stripe-Connect-Testdokumentation](https://docs.stripe.com/connect/testing) ausfüllen (keine echten Personendaten
   und keine echte Bankverbindung eingeben).
3. Nach der Rückkehr sollte der Status auf **Bereit** wechseln (per Webhook, sonst über „Status aktualisieren“).
4. Prüfen: Im Stripe-Dashboard unter **Connect → Verbundene Konten** erscheint das Testkonto. Bei den Endpunkten
   unter **Webhooks** stehen erfolgreiche Zustellungen (Antwort 200).

## Was ich danach von Ihnen brauche
Nur die Rückmeldung „Testumgebung steht“ und die `ApiUrl` der Dev-Umgebung. **Keine Schlüssel.**

## Teil B: Live (erst nach Freigabe, AP00)
1. Stripe-Konto **aktivieren** (Verein): Vertretungsberechtigte Person, Ausweis, Vereinsregisterangaben, IBAN,
   Steuernummer/USt-IdNr., Website und Produktbeschreibung. Stripe prüft das; das kann einige Tage dauern.
2. Öffentliche Angaben pflegen (Support-Kontakt, Abrechnungstext auf dem Kontoauszug, z. B. „MSC RACEPIC“).
3. Connect-Plattformprofil für Live bestätigen (wie Schritt 3) und Live-Schlüssel sowie Live-Webhooks anlegen.
4. Secret `dreiecksrennen-prod/racepic/stripe` füllen, `PROD_COMMERCE_*`-Variablen setzen, Umsatzsteuer- und
   Rechtsfreigabe (AP00) dokumentieren.
5. Erst mit einem echten Kleinbetragskauf im Pilot prüfen, dann öffentlich freischalten.

## Kosten und Risiko (bitte vor Live prüfen)
- Der MSC trägt die Stripe-Gebühren und haftet als Plattform für negative Salden (Rückbuchungen, Erstattungen nach
  Auszahlung). Aktuelle Gebühren für Kartenzahlungen und Connect (aktive Konten, Auszahlungen) stehen auf der
  Stripe-Preisseite und in den Connect-Einstellungen; sie hängen vom Vertrag des Vereins ab.
- Deshalb hält RacePic Erlöse 14 Tage zurück, bevor sie an Fotograf:innen überwiesen werden.

## Hinweis zum Kontotyp: Accounts v2
Diese Stripe-Sandbox lässt die klassischen Kontotypen (Standard, Express, Custom; `type: 'express'`) und auch die
Accounts-v1-Kontoerstellung mit Controller-Eigenschaften **standardmäßig nicht mehr zu** — neue Sandboxes/Konten
werden auf die **Accounts v2 API** verwiesen (bestätigt am 2026-09-28 per Testaufruf: `invalid_request_error`,
„Stripe no longer recommends Accounts v1 for new Connect integrations"). RacePic legt Fotografenkonten deshalb mit
`stripe.v2.core.accounts.create(...)` an: `dashboard: 'express'`, Konfiguration `recipient` mit der Fähigkeit
`stripe_balance.stripe_transfers`, `defaults.responsibilities.fees_collector`/`losses_collector: 'application'`
(der MSC trägt die Gebühren und haftet für negative Salden, wie geplant). Bestätigt per Testkonto in der Sandbox
(`acct_1UKk12HyPyc81wWW`, seitdem geschlossen/verwaist als Testdatensatz ohne Personendaten): Kontoerstellung,
Anforderungen und Verantwortlichkeiten entsprechen genau der Konfiguration.

**Wichtig für den Rest der Integration:** Account-Link (Hosted Onboarding) und Login-Link (Express-Dashboard) sowie
der Abgleich per `GET /v1/accounts/{id}` laufen **unverändert über die v1-API** — Stripe erlaubt ausdrücklich, eine
v2-Konto-ID an v1-Endpunkte zu übergeben; die Antwort kommt dann im gewohnten v1-Format
(docs.stripe.com/connect/accounts-v2, Abschnitt „Bestehende Connect-Plattformen, die Accounts v1 ... verwenden").
Nur die Kontoerstellung selbst ist v2.

**Vorschaufeature beachten:** Die Kombination „Express-Dashboard + Stripe haftet für negative Salden"
(`losses_collector: 'stripe'`) ist laut Doku nur mit der Vorschau-API-Version `2026-08-26.preview` verfügbar. RacePic
nutzt diese Kombination **nicht** (der MSC haftet selbst, `losses_collector: 'application'`), braucht also keine
Vorschauversion.
