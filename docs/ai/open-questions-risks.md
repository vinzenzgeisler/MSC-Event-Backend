# AI Communication Hub Open Questions, Risks, Assumptions

Stand: 2026-03-24

## Annahmen

- Das externe Projekt-Postfach ist aus AWS per IMAP über TLS erreichbar.
- Für den Ziel-Account ist Bedrock mit dem konfigurierten Modell freigeschaltet.
- Der MVP kann ohne strukturierte Ergebnisdaten auskommen.
- Admin oder Editor prüft jede generierte Ausgabe vor weiterer Nutzung.

## Offene Fragen

- Welche externe Mailbox wird produktiv angebunden und wie stabil ist deren IMAP-Zugang?
- Soll zusätzlich ein manuelles Inbox-Import-API als Fallback für Demo-Situationen ergänzt werden?
- Welche FAQ-, Regel- oder Zahlungsinformationen sollen serverseitig als zusätzlicher AI-Kontext gepflegt werden?
- Welche Aufbewahrungsfrist ist für importierte Mailtexte und AI-Drafts fachlich akzeptabel?

## Risiken

### P0

- IMAP-Zugang oder Mailbox-Struktur weicht produktiv vom MVP ab.
- Bedrock ist im Ziel-Account nicht freigeschaltet oder das Modell ist nicht konfiguriert.
- Mailtexte enthalten sensible personenbezogene Inhalte und werden zu lange gespeichert.

### P1

- Heuristische Zuordnung von Mails zu Event oder Entry ist ungenau.
- IMAP-Parsing deckt nicht alle MIME-Sonderfälle sauber ab.
- Bericht-Generator wirkt inhaltlich schwach, solange keine Ergebnisdaten vorliegen.
- Sprecherassistenz ist stark von der Qualität manueller Highlights und Historienfelder abhängig.

### P2

- Ohne ergänzende Regel-/FAQ-Bausteine bleiben Antwortentwürfe bei Sonderfällen zu allgemein.
- Fehlende Frontend-Oberfläche kann den praktischen Nutzen zunächst begrenzen.

## Empfohlene nächste Risikoreduktion

- Test-Postfach mit realistischen Mails bereitstellen
- Bedrock-Config früh im Ziel-Stage verifizieren
- Retention-Regeln für `ai_message_source` und `ai_draft` definieren
- Mailbox-Zuordnung später um Orgacode, Startnummer und Eventnamen erweitern
