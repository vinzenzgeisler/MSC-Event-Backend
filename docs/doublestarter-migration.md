# Doppelstarter-Migration

Das Werkzeug führt ausschließlich zuvor erkannte und in einem Manifest eingefrorene Kandidaten zusammen. Es arbeitet in vier getrennten Phasen und gibt keine personenbezogenen Daten auf der Konsole aus.

## Voraussetzungen

- API bauen und Migration `0055_doublestarter_migration_notice.sql` anwenden.
- Datenbankzugriff über `DATABASE_URL` oder `DB_SECRET_ARN`.
- Für TLS `DB_SSL_CA_PATH` auf das RDS-CA-Bundle setzen.
- Manifest außerhalb des Repositories und mit eingeschränktem Zugriff ablegen.

## Ablauf

```powershell
npm --workspace api run build

npm --workspace api run migration:doublestarter -- `
  --mode detect `
  --event-id e5dc0ac8-3a6f-4ee3-9a1c-45e2057d2a28 `
  --expected-count 5 `
  --manifest C:\tmp\doublestarter-manifest.json

npm --workspace api run migration:doublestarter -- `
  --mode notify `
  --manifest C:\tmp\doublestarter-manifest.json

npm --workspace api run migration:doublestarter -- `
  --mode migrate `
  --manifest C:\tmp\doublestarter-manifest.json `
  --actor admin@example.org

npm --workspace api run migration:doublestarter -- `
  --mode verify `
  --manifest C:\tmp\doublestarter-manifest.json
```

`detect` bricht ab, wenn nicht exakt fünf automatische Kandidaten gefunden werden. `migrate` prüft vor jedem Fall erneut den Manifest-Fingerprint, beide Mail-Outbox-Einträge und das Fehlen von Zahlungen. Jeder Fall läuft in einer eigenen Transaktion und ist über den Audit-Eintrag wiederholbar.
