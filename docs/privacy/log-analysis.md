# Log Analysis (Code-Derived)

Stand: 2026-03-05

## Sources
- App-Level Logs: `api/src/handler.ts`, Worker-Jobs, `console.error` Fehlerpfade.
- Audit: `api/src/audit/log.ts` (`sanitizePayload` via whitelist).
- Infra: Lambda Log Retention in `infra/lib/stacks/api-stack.ts`.

## Findings
- Positiv:
- Audit-Payload wird ueber `allowedPayloadKeysByAction` gefiltert.
- Keine offensichtliche Persistenz kompletter Request-Bodies in DB.

- Risiken:
- P0: Fehlerlogs bei Dokument-Erzeugung loggen rohe Error-Objekte (`console.error(..., error)`), potenziell inkl. sensitiver Provider-Metadaten.
- P1: `email_delivery.provider_response` speichert rohe Provider-Responses; minimieren oder redigieren empfohlen.
- P1: Debug-Endpunkte `/admin/db/ping` und `/admin/db/schema` sollten in prod deaktiviert werden.

## Recommendations
1. P0: Zentralen sicheren Logger einfuehren mit Redaction fuer Email, Phone, Address, Token, URL-Query.
2. P0: Keine ungefilterten Error-Objekte loggen, stattdessen Error-Code + Correlation-ID.
3. P1: `provider_response` in `email_delivery` auf whitelist reduzieren.
4. P1: Prod-Feature-Flag fuer Debug-Endpunkte.
