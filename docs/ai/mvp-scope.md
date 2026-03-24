# AI Communication Hub MVP Scope

Stand: 2026-03-24

## Enthalten

### Anfrage-/Mail-Assistent

- IMAP-basierter Import externer Mails in das Backend
- Liste importierter Nachrichten im Admin-Kontext
- KI-gestützte Erzeugung von:
  - Kurz-Zusammenfassung
  - grober Kategorie
  - Antwortentwurf
  - Warnhinweisen

### Event-Bericht-Generator

- Generierung eines Kommunikationsentwurfs aus:
  - Event-Stammdaten
  - Klassen-/Teilnehmerzahlen
  - manuellen Highlights
- Formate:
  - `website`
  - `social`
  - `summary`

### Sprecherassistenz

- Generierung kurzer sprechfertiger Texte aus:
  - Fahrer-/Fahrzeug-/Klasseninfos
  - optionalen manuellen Highlights
- Modi:
  - `short_intro`
  - `driver_intro`
  - `class_overview`

### Speicherung

- optionale Speicherung generierter Entwürfe als `ai_draft`

## Nicht im MVP

- offener Chatbot
- autonomer Mailversand aus KI-Ergebnissen
- automatische Entscheidungen über Nennungen oder Zahlungen
- echtes Result-/Ranking-basiertes Storytelling
- Live-Kommentierung oder laufende Sprecher-Automation
- tiefe Mail-Thread-Analyse
- Provider-spezifische Mailbox-APIs
- Vektor-Datenbank oder komplexes RAG

## Demo-Stärke des MVP

Der MVP ist vorzeigbar, weil er:

- ein reales Postfach an AWS anbinden kann
- bestehende Event-/Nennungsdaten direkt wiederverwendet
- sichtbaren Nutzen für Orga und Kommunikation liefert
- fachlich kontrollierte, review-pflichtige KI-Ergebnisse erzeugt

## Bewusste fachliche Grenzen

- Ergebnisse basieren nur auf bereitgestellten Daten
- fehlende Daten werden über Warnungen sichtbar gemacht
- bei Berichten und Sprechertexten werden keine Rennresultate erfunden
- Mails bleiben Hilfsmittel für Mitarbeitende, nicht autonome Kommunikation
