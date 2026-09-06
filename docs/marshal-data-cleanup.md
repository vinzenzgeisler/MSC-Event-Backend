# Helferdaten prüfen und bereinigen

Die Werkzeuge in `api/scripts` arbeiten standardmäßig ausschließlich lesend. Sie geben in der Konsole nur Summen und technische Kennungen aus, keine Namen oder Kontaktdaten.

## 1. Datenbestand prüfen

```powershell
node api/scripts/audit-marshal-data.js `
  --secret-arn <DB-SECRET-ARN> `
  --region eu-central-1 `
  --workbook <PFAD-ZUR-ORIGINAL-XLSX> `
  --laufer-workbook <PFAD-ZUR-LAUFER-ODS>
```

Die Datenbanktransaktion läuft mit `REPEATABLE READ READ ONLY` und wird immer zurückgerollt. Der SHA-256-Wert der XLSX muss mit einem abgeschlossenen Eintrag in `marshal_import_run` übereinstimmen, bevor eine Reparatur möglich ist.

## 2. Spaltenversatz als Probelauf rekonstruieren

```powershell
node api/scripts/repair-marshal-import-columns.js `
  --secret-arn <DB-SECRET-ARN> `
  --region eu-central-1 `
  --workbook <PFAD-ZUR-ORIGINAL-XLSX>
```

Der Probelauf ändert nichts. Ein Feld gilt nur dann als automatisch reparierbar, wenn sein Datenbankwert noch exakt dem früheren fehlerhaften Importergebnis entspricht. Abweichende Werte werden als Konflikte gezählt und bleiben erhalten.

## 3. Freigegebene Reparatur anwenden

Zuerst muss Migration `0077_marshal_import_repair_snapshot.sql` ausgerollt sein. Danach werden der zuvor geprüfte Hash und die erwartete Anzahl betroffener Personen als Sperren mitgegeben:

```powershell
node api/scripts/repair-marshal-import-columns.js `
  --secret-arn <DB-SECRET-ARN> `
  --region eu-central-1 `
  --workbook <PFAD-ZUR-ORIGINAL-XLSX> `
  --apply `
  --expected-source-sha256 <SHA-256> `
  --expected-changed-people <ANZAHL> `
  --created-by <ADMIN-KENNUNG>
```

Vor den Updates wird pro betroffener Person ein Vorher-/Nachher-Datensatz in `marshal_import_repair_snapshot` geschrieben. Snapshot und Änderungen liegen in derselben serialisierbaren Transaktion. Bei einem Fehler oder einer abweichenden Anzahl wird alles zurückgerollt.

Die Laufer-ODS dient nur dem Abgleich. Sie wird nicht automatisch auf ein aktuelles Event übertragen, weil ihre Einsatzspalten aus 2022 stammen und Namen nicht überall eindeutig den Stammdaten zugeordnet werden können.
