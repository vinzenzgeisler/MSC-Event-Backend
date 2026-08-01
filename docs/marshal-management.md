# Streckenpostenverwaltung

Das Admin-Modul verwaltet Helferstammdaten unabhängig von Nennungs-Personen sowie veranstaltungsbezogene Zusagen, Tageszuweisungen, Abschnitte, Posten, Schulungen, Einweisungen und DMSB-Qualifikationen.

## Berechtigungen

- Rolle `marshal_manager`
- `marshals.read`: Arbeitsbereich lesen
- `marshals.write`: Stammdaten, Einsätze, Konfiguration, Termine und Excel-Import bearbeiten
- `marshals.export`: Anwesenheits-, Abschnitts- und Teilnehmerlisten erzeugen
- Administratoren besitzen alle drei Rechte.

## Struktur

Ein Event wird beim ersten Zugriff idempotent mit Samstag und Sonntag, den vier Abschnitten `1` bis `4`, den Abschnittsleitern `AL1` bis `AL4` sowie den Posten aus dem 2025er Postenplan angelegt. Die historischen Codes `5/1` bis `5/3` bleiben sichtbar, sind organisatorisch aber Abschnitt 4 zugeordnet.

## API

- `GET /admin/marshals/workspace?eventId=...`
- `POST /admin/marshals/persons`
- `PATCH /admin/marshals/persons/{id}`
- `PUT /admin/marshals/assignments/{personId}`
- `PUT /admin/marshals/config`
- `POST /admin/marshals/trainings`
- `PUT /admin/marshals/trainings/{sessionId}/participants/{personId}`
- `POST /admin/marshals/import/preview`
- `POST /admin/marshals/import/commit`
- `GET /admin/marshals/print`

Die serverseitige Autorisierung ist verbindlich; ausgeblendete UI-Elemente sind nur eine zusätzliche Bedienhilfe.

## Excel-Import

Die `.xlsx`-Datei wird als Base64-Nutzlast mit maximal 2 MB übertragen. Der Dry-run liefert SHA-256, Mengen und Prüffälle. Der bestätigte Import muss denselben SHA-256 mitsenden. Ein bereits vollständig importierter Hash wird nicht erneut verarbeitet.

Zusammenführung erfolgt über die Helfernummer. Die Arbeitsmappe vom 12. September 2025 ergibt:

- 510 eindeutige Helferstammsätze einschließlich eines nur in der 2024er Einsatzliste vorkommenden Helfers
- 305 Eventteilnahmen
- 133 historische Tageszuweisungen aus Samstag/Sonntag 2024
- 53 Teilnehmer der Lizenzschulung vom 29. März 2025
- 103 Teilnehmer der Einweisung vom 11. September 2025
- einen transparent ausgewiesenen Normalisierungsfall: Helfernummer `750.428571428571` wird entsprechend der Excel-Anzeige und der freien fortlaufenden Nummer auf `750` gerundet
- einen historischen Datensatz ohne Stammsatz: Andreas Schatz erhält die nächste freie Helfernummer `771`

Personenbezogene Importdaten werden nicht im Git-Repository gespeichert. Die Originaldatei wird nach dem Backend-Deployment über den geschützten Admin-Endpunkt eingespielt.

## Drucklisten

PDFKit erzeugt A4-Querformat ohne Telefonnummern, E-Mail-Adressen oder Geburtsdaten:

- Anwesenheitsliste: Vorname, Nachname, PLZ, Wohnort, Shirt, Posten und leere Unterschriftsspalte
- Abschnittsliste: Vorname, Nachname, Posten/Funktion und leere Änderungsspalte
- Schulungs-/Einweisungsliste: Vorname, Nachname, PLZ, Wohnort, Status und leere Unterschriftsspalte
