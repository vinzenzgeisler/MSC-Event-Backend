# AI Communication Hub Architecture

Stand: 2026-03-24

## Zielbild

Der AI Communication Hub erweitert das bestehende Lambda-Monolith-Backend um drei klar abgegrenzte, review-pflichtige KI-Use-Cases:

- Anfrage-/Mail-Assistent
- Event-Bericht-Generator
- Sprecherassistenz

Die Implementierung folgt bewusst der vorhandenen Architektur:

- HTTP API in `api/src/handler.ts`
- route-spezifische Module in `api/src/routes`
- fachliche Services in `api/src/ai`
- Postgres via Drizzle
- AWS-Integration über CDK in `infra`

Es gibt keinen offenen Chatbot und keine autonome Entscheidungskomponente.

## Bausteine

### 1. Admin API

Neue Admin-Endpunkte:

- `GET /admin/ai/messages`
- `POST /admin/ai/messages/{id}/suggest-reply`
- `POST /admin/ai/reports/generate`
- `POST /admin/ai/speaker/generate`
- `POST /admin/ai/drafts`

Zugriff nur für `admin` und `editor`.

### 2. AI Service Layer

Die Service-Schicht in `api/src/ai/service.ts` kapselt:

- serverseitigen Kontextaufbau
- Prompt-Erzeugung
- Bedrock-Modellaufrufe
- Zod-validierte, strukturierte Outputs
- Audit-Events

Die drei Use-Cases bleiben fachlich getrennt, teilen sich aber dieselbe LLM-Adapter-Schicht.

### 3. AWS Bedrock Adapter

`api/src/ai/bedrock.ts` nutzt die Bedrock Runtime per Converse API.

Designentscheidungen:

- Modell über Env konfigurierbar
- Standard für den MVP: `eu.amazon.nova-micro-v1:0`
- strukturierte JSON-Antworten
- niedrige Temperatur
- Fehler bei fehlender Modellkonfiguration explizit

### 4. Inbox Intake

Für den Mail-Assistenten wurde eine externe Mailbox-Integration per IMAP-Polling ergänzt:

- Poller-Job: `api/src/jobs/mailInboxPoller.ts`
- einfacher IMAP/TLS-Client: `api/src/ai/imap.ts`
- Persistenz importierter Nachrichten: `ai_message_source`

Importfluss:

1. EventBridge startet den Poller.
2. Poller liest ungelesene IMAP-Nachrichten.
3. Mail wird geparst, in S3 als `.eml` optional abgelegt und in Postgres gespeichert.
4. Nachricht wird heuristisch einem `event` oder `entry` zugeordnet.
5. Admin erzeugt daraus manuell einen Antwortvorschlag.

## Persistenz

### `ai_message_source`

Speichert:

- Nachrichtenherkunft
- Mailbox-Key und externe Message-ID
- Meta-Felder wie From/To/Subject/ReceivedAt
- optionalen Event-/Entry-Bezug
- Textinhalt
- optionale AI-Zusammenfassung und Kategorie

### `ai_draft`

Speichert auf expliziten User-Wunsch:

- Task-Typ
- Referenzen auf Event, Entry oder Message
- minimales Input-Snapshot
- Output-JSON
- Warnungen
- Modell-ID

Es werden keine kompletten Prompt- oder Rohantwort-Logs persistiert.

## Sicherheitsprinzipien

- Review first: KI-Ausgaben bleiben Entwürfe
- keine automatische Antwortauslösung
- nur serverseitig aufgebaute Kontexte
- keine Halluzinationsförderung durch offene Freitextprompts
- Audit nur mit Whitelist-Feldern
- IMAP-Zugang über Secrets Manager
- Bedrock-Zugriff per IAM

## Erweiterungspfad

Sinnvolle nächste Ausbaustufen:

- bessere Inbox-Zuordnung über Orgacode/Startnummer/Eventnamen
- regel-/FAQ-Kontext aus `app_config`
- Draft-Liste und Review-Status im Admin-Frontend
- produktive Aufbereitung echter Ergebnisdaten für den Bericht-Generator
- stärkere Logging-Redaction und Aufbewahrungsfristen für AI-Inhalte
