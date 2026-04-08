# AI Communication Hub Module

Dieser Ordner enthaelt einen kompakten, aufbereiteten Ausschnitt des KI-Moduls aus dem MSC-Event-Backend.

Ziel:

- die fachliche KI-Logik in wenigen Dateien nachvollziehbar machen
- den technischen Cloud-Flow fuer den Nachbau zeigen
- irrelevanten Projektkontext ausblenden

## Enthaltene Teile

- `src/bedrock.ts`
  - AWS-Bedrock-Anbindung fuer strukturierte JSON-Antworten
- `src/shared.ts`
  - gemeinsame Typen und Envelope-Logik fuer KI-Antworten
- `src/mailAssistant.ts`
  - Mail-Assistent mit defensiver Antwortgenerierung
- `src/reportAssistant.ts`
  - Berichtsgenerator mit Varianten und transparenter Quellenbasis
- `src/knowledge.ts`
  - Wissensvorschlaege und freigegebene Wissensbausteine
- `src/mailInboxPoller.ts`
  - Lambda-/Job-Logik fuer IMAP-Mailimport
- `sql/ai-module-schema.sql`
  - minimales Persistenzschema fuer Nachrichten, Drafts und Wissen
- `infra/cdk-bedrock-snippet.ts`
  - AWS-CDK-Snippet fuer Lambda, Bedrock-Rechte und IMAP-Poller

## Was bewusst nicht enthalten ist

- kompletter API-Handler
- kompletter Datenbankzugriff des Gesamtprojekts
- komplette Authentifizierung
- nicht-KI-spezifische Admin-Logik

## Architektur in Kurzform

1. API Gateway ruft eine Lambda-Funktion auf.
2. Die Lambda laedt fachliche Daten aus dem Event-System.
3. Daraus wird serverseitig ein kontrollierter KI-Kontext gebaut.
4. AWS Bedrock erzeugt eine strukturierte Antwort.
5. Das Backend validiert die Antwort und gibt einen pruefbaren Entwurf zurueck.
6. Eingehende Mails koennen ueber einen separaten Poller importiert werden.
7. Drafts und reviewtes Wissen werden in Postgres gespeichert.

## Wie man den Ausschnitt nachbauen kann

1. Postgres-Tabellen aus `sql/ai-module-schema.sql` anlegen
2. `src/bedrock.ts` in ein Node.js-/Lambda-Projekt uebernehmen
3. die fachlichen Funktionen aus `src/mailAssistant.ts` und `src/reportAssistant.ts` als Service-Schicht verwenden
4. die Interfaces an die eigene Datenquelle anpassen
5. das CDK-Snippet aus `infra/cdk-bedrock-snippet.ts` als Vorlage fuer Lambda-Deployment und Berechtigungen verwenden

## Zentrale Designprinzipien

- KI nur serverseitig
- keine direkte Modellnutzung im Frontend
- nur strukturierte Outputs
- nur auf bereitgestellten Fakten basieren
- Unsicherheiten explizit ausweisen
- Ergebnisse bleiben review-pflichtige Entwuerfe
