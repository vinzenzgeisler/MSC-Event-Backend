# Privacy Risk Report

Stand: 2026-03-05

## P0
- P0-1: Potenzielles PII-Leak durch ungefiltertes Error-Logging (`console.error(..., error)`).
- P0-2: Aufbewahrungsluecke bei `email_delivery` (kein klarer Purge).

## P1
- P1-1: `email_delivery.provider_response` kann unnoetige Metadaten enthalten.
- P1-2: Debug-Endpunkte `/admin/db/ping` und `/admin/db/schema` sollten in prod nicht verfuegbar sein.
- P1-3: Kein serverseitig erzwungenes MFA-Gate fuer kritische Admin-Aktionen.
- P1-4: Rate Limits fuer missbrauchsrelevante Endpunkte fehlen.
- P1-5: Freitextfelder koennen sensible Inhalte enthalten (Notizen/Historie/TemplateData).

## P2
- P2-1: Mandantentrennung nur event-basiert, keine harte tenant-isolation.

## Action Plan
1. P0 sofort: Logging-Redaction + `email_delivery` retention.
2. P1 kurzfristig: prod hardening fuer debug-endpoints + MFA gate + rate limits.
3. P1 mittel: Freitext-Minimierung + Datenklassifikation fuer TemplateData.

## ANNAHMEN
- ANNAHME: Rechtliche Aufbewahrungsfristen werden durch Fachseite final bestaetigt.
