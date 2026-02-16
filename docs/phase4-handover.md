# Phase 4 Handover

Diese Datei dokumentiert den aktuellen Stand nach dem Budget-Umbau und dient als sauberer Übergang für Phase 4.

## Architekturstand

- Runtime: AWS Lambda + API Gateway
- Auth: Cognito
- Storage: S3 (`assets`, `documents`)
- DB: RDS PostgreSQL
- Region: `eu-central-1`

### Budget-relevante Änderungen

- Kein NAT-Gateway als Default
- Kein dauerhaftes EIP in Dev
- Dev-Profile eingeführt:
  - `idle` (minimal laufende Kosten)
  - `test` (API + DB aktiv für Tests)
- Prod-Budget-Modus:
  - `apiInVpc: false`
  - `dbConnectivityMode: public_budget`
  - `dbUseIamAuth: true`
  - `dbRequireTls: true`

### TLS/DB-Connectivity

- API lädt bei Bedarf automatisch das RDS CA Bundle in Lambda (`/tmp/rds-global-bundle.pem`).
- DB-Client nutzt TLS strikt mit Zertifikatsprüfung bei aktivem TLS-Modus.

## Wichtige Konfigurationsdateien

- `infra/lib/config/types.ts`
- `infra/lib/config/dev.ts`
- `infra/lib/config/prod.ts`
- `infra/bin/app.ts`
- `infra/lib/stacks/data-stack.ts`
- `infra/lib/stacks/api-stack.ts`
- `api/src/db/client.ts`

## Deploy-Matrix

### Dev idle (kostenarm)

```bash
cd infra
npx cdk deploy --all -c stage=dev -c devProfile=idle
```

### Dev test (Smoke-/Integrationstests)

```bash
cd infra
npx cdk deploy --all -c stage=dev -c devProfile=test
```

### Prod budget

```bash
cd infra
npx cdk deploy --all -c stage=prod
```

## Smoke-Test

- Script: `scripts/phase3-smoke-test.ps1`
- Erwartung: alle Schritte `health`, `admin ping`, `db ping`, `schema`, `mail queue`, `reminder queue`, `document generation`, `download URL` erfolgreich.

## Seed-/Migrations-Hinweise

- Migrationen: `api/migrations/*.sql` via `npm run db:migrate`
- Für lokale/CLI Migrationen muss `DATABASE_URL` gesetzt sein.
- Testdaten müssen für Smoke-IDs vorhanden sein (`eventId`, `entryId`).

## Bekannte Tradeoffs

- `public_budget` bedeutet öffentlich erreichbare DB (`5432`), abgesichert durch TLS/IAM-Strategie.
- Sicherer wäre `private` DB-Connectivity, ist aber in der Regel teurer.

## Phase 4 Start-Checklist

1. Dev auf `idle` zurückstellen, wenn kein Test läuft.
2. Offene Kosten-Alarme prüfen (Budget + CloudWatch).
3. Phase-4 Scope auf bestehender API/DB-Schema-Basis planen.
4. Smoke-Test vor jedem größeren Infrastruktur-Change erneut ausführen.

## Phase 4 Erweiterungen (implementiert)

- Technische Abnahme PDF unterscheidet jetzt AUTO/MOTO über `document.template_variant`.
- Mail-Templates sind DB-versioniert (`email_template`, `email_template_version`).
- Outbox wurde für Retry/Idempotenz erweitert (`template_version`, `max_attempts`, `error_last`, dedupe required).
- Neue Admin-Endpunkte:
  - `POST /admin/mail/lifecycle/queue`
  - `POST /admin/mail/broadcast/queue`
  - `PATCH /admin/entries/{id}/checkin/id-verify`
- Payment Reminder läuft in Phase 4 nur manuell per API (kein geplanter Timer).

## Zukunftshook (nicht umgesetzt)

- Scrutineering-Bestätigung im Tool ist vorbereitet als zukünftiger Endpoint/Statusmodell, aber in Phase 4 bewusst nicht persistiert.
- Signatur-Flow bleibt außerhalb von Phase 4; später sinnvoll über separate Tabelle (z. B. `document_signature`) und Referenz auf `document.id`.
