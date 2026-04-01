# MSC Event Backend

Dieses Repository enthaelt das Backend und die AWS-Infrastruktur fuer das MSC-Event-System.

Der fachliche Schwerpunkt des aktuellen Projektstands ist der `AI Communication Hub`: eine cloudbasierte, review-pflichtige Assistenz fuer wiederkehrende Kommunikationsaufgaben rund um das Event.

## Was das Projekt kann

Das Backend stellt klassische Admin- und Event-Funktionen bereit und erweitert diese um drei KI-Use-Cases:

- Mail-Assistent
  - importiert eingehende Anfragen
  - fasst Nachrichten zusammen
  - kategorisiert sie grob
  - erzeugt einen Antwortentwurf mit Warnhinweisen
- Event-Bericht-Generator
  - erzeugt Kommunikationsentwuerfe fuer Event oder Klasse
  - unterstuetzt mehrere Varianten wie `website` und `short_summary`
  - zeigt die verwendete Faktenbasis transparent an
- Sprecherassistenz
  - erzeugt kurze sprechfertige Texte fuer Fahrer oder Klassen

Ergaenzend gibt es:

- gespeicherte KI-Drafts
- reviewpflichtige Wissensvorschlaege
- freigegebene Knowledge-Items als wiederverwendbare Wissensbasis

## Wie die KI eingebunden ist

Die KI-Integration laeuft ueber AWS:

- API Gateway nimmt Anfragen entgegen
- Lambda verarbeitet die Fachlogik
- Lambda baut serverseitig den Kontext aus Event-, Nennungs- und Kommunikationsdaten
- AWS Bedrock erzeugt strukturierte KI-Ausgaben
- das Backend gibt pruefbare Entwuerfe mit `basis`, `warnings` und `review` zurueck

Die KI arbeitet bewusst als Assistenz. Es gibt keinen offenen Haupt-Chatbot und keine autonome Entscheidungskomponente.

## Projektstruktur

- `api/`
  - Lambda/API-Code
  - Drizzle-Schema und Migrationen
  - KI-Service-Logik
- `infra/`
  - AWS CDK App
  - API Gateway, Lambda, Scheduler, Bedrock- und Secret-Anbindung
- `docs/`
  - weiterfuehrende Architektur-, API- und Betriebsdokumentation

## Voraussetzungen

Fuer lokalen Build und Deployment:

- Node.js 20+
- npm 10+
- AWS CLI
- AWS Account bzw. Zugriff auf die Zielumgebung

## Installation

```bash
npm install
```

## Nutzung in Kurzform

### Lokal bauen

```bash
npm run api:build
npm run infra:build
```

### Infrastruktur deployen

Beispiel fuer `dev`:

```bash
cd infra
npx cdk deploy --all -c stage=dev -c devProfile=test --require-approval never
```

### Datenbank migrieren

```bash
npm run api:db:migrate
```

### Funktion pruefen

Sinnvolle erste Checks:

1. `GET /health`
2. `GET /admin/ai/messages`
3. `POST /admin/ai/messages/{id}/suggest-reply`
4. `POST /admin/ai/reports/generate`
5. `POST /admin/ai/speaker/generate`

## Konfiguration und Secrets

Wichtige Punkte:

- Stage-spezifische Konfiguration liegt in:
  - `infra/lib/config/dev.ts`
  - `infra/lib/config/prod.ts`
- produktive Secrets liegen nicht im Repository
- fuer den Mail-Assistenten wird ein IMAP-Secret in AWS Secrets Manager benoetigt
- fuer die KI wird ein Bedrock-Modell bzw. Inference Profile benoetigt

Empfohlener MVP-Standard:

- `eu.amazon.nova-micro-v1:0`

## Wie das Projekt sinnvoll genutzt wird

Der `AI Communication Hub` ist fuer reale, fachlich plausible Arbeitsablaeufe gedacht:

- eingehende Mails schneller verstehen und beantworten
- Kommunikationsentwuerfe aus vorhandenen Eventdaten erzeugen
- Wissen aus wiederkehrenden Rueckfragen strukturiert wiederverwendbar machen

Wichtig:

- KI-Ausgaben bleiben Entwuerfe
- fachliche Pruefung durch Menschen bleibt Pflicht
- fehlende Daten sollen sichtbar gemacht, nicht erfunden werden

## Weiterfuehrende Doku

Fuer technische Details:

- API: `api/README.md`
- Infrastruktur: `infra/README.md`
- AI Architektur: `docs/ai/architecture.md`
- AI Projektuebersicht: `docs/ai/project-overview.md`
- AI API Contract: `docs/ai/api-draft.md`
- Setup und Deploy: `docs/ai/setup-and-deploy.md`
- Konfigurationsreferenz: `docs/ai/configuration-reference.md`
- Demo-Ablauf: `docs/ai/demo-runbook.md`
- Risiken und offene Fragen: `docs/ai/open-questions-risks.md`
