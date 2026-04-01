# AI Communication Hub Demo Runbook

Stand: 2026-04-02

## Ziel

Dieses Runbook beschreibt einen klaren Vortragspfad fuer das Kolloquium.

## Demo-Kernaussage

Das MSC-Event-System nutzt AWS Bedrock sinnvoll fuer klar abgegrenzte Kommunikationsaufgaben:

- eingehende Mails verstehen und beantworten
- Event-Berichte erzeugen
- Sprechertexte vorbereiten

Die KI arbeitet dabei immer als Assistenz mit menschlicher Review-Pflicht.

## Empfohlene Demo-Reihenfolge

### 1. Architektur kurz zeigen

Sagen:

- API Gateway ruft Lambda auf
- Lambda baut den fachlichen Kontext aus Event-/Nennungsdaten
- Lambda nutzt Bedrock fuer die Generierung
- das Ergebnis wird als Entwurf mit Warnungen und Review-Hinweisen zurueckgegeben

Dateien / Folienbasis:

- `docs/ai/architecture.md`
- `docs/ai/submission-summary.md`

### 2. Mail-Assistent vorfuehren

Zeigen:

1. importierte Mail in der Admin-Oberflaeche
2. erkannten Event-/Nennungsbezug
3. generierten Antwortvorschlag
4. `answerFacts`, `unknowns`, `warnings`, `review`

Kernaussage:

- Die KI halluziniert nicht frei, sondern basiert auf Systemdaten.
- Fehlende Fakten werden als offen markiert.

### 3. Mini-Chat oder Zusatzkontext

Zeigen:

- zur selben Mail einen kontextgebundenen Rueckfrage-Flow
- oder einen Wissensvorschlag aus Zusatzinformationen

Kernaussage:

- kein allgemeiner Chatbot
- sondern kontrollierte Assistenz im konkreten Vorgang

### 4. Wissensvorschlag und Wissensbasis

Zeigen:

- aus Mail-/Operator-Kontext wird ein `knowledge-suggestion`
- nach Review wird daraus ein freigegebenes `knowledge-item`
- spaetere Antworten koennen dieses Wissen wiederverwenden

Kernaussage:

- die Loesung lernt nicht autonom, sondern nur ueber reviewte Wissenseintraege

### 5. Berichtsgenerator

Zeigen:

- Bericht fuer Event oder Klasse erzeugen
- mehrere Varianten
- transparente `basis.factBlocks`, `usedKnowledge`, `missingData`
- ggf. eine Variante gezielt regenerieren

Kernaussage:

- nicht nur Text generieren, sondern Herkunft und Unsicherheit sichtbar machen

### 6. Sprecherassistenz

Zeigen:

- kurzer sprechfertiger Text fuer Fahrer oder Klasse

Kernaussage:

- praktische Unterstuetzung fuer den Streckensprecher, keine autonome Live-Entscheidung

## Beispiel fuer Demo-Sprechtext

Kurzfassung:

1. Problem: Viele Kommunikationsaufgaben sind wiederkehrend, aber nicht trivial.
2. Loesung: Ein AI Communication Hub im Backend mit klaren Aufgaben statt Chatbot.
3. Cloud-Bezug: API Gateway -> Lambda -> Bedrock.
4. Nutzen: schnellere Orga-Kommunikation, bessere Wiederverwendbarkeit von Wissen.
5. Sicherheit: menschliche Review-Pflicht, keine autonome Entscheidung.

## Demo-Vorbereitung

Vor dem Vortrag sicherstellen:

- mindestens eine importierte Testmail vorhanden
- Bedrock erreichbar
- ein freigegebenes Knowledge-Item vorhanden
- ein Event fuer den Berichtsgenerator vorhanden
- Demo-Nutzer mit Admin-/Editor-Rechten vorhanden

## Fallback fuer den Vortrag

Falls IMAP oder externe Mail gerade nicht verfuegbar ist:

- bereits importierte Mail aus `ai_message_source` verwenden
- gespeicherte Drafts und Knowledge-Items demonstrieren
- API-Contract / gespeicherte Ergebnisse als Backup zeigen
