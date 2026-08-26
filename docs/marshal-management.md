# Streckenpostenverwaltung

Das Admin-Modul verwaltet Helferstammdaten unabhängig von Nennungs-Personen sowie veranstaltungsbezogene Zusagen, Tageszuweisungen, Abschnitte, Posten, Schulungen, Einweisungen und DMSB-Qualifikationen.

## Berechtigungen

- Rolle `marshal_manager`
- `marshals.read`: Arbeitsbereich lesen
- `marshals.write`: Stammdaten, Einsätze, Konfiguration, Termine und Excel-Import bearbeiten
- `marshals.export`: Anwesenheits-, Abschnitts-, Bereichs- und Teilnehmerlisten erzeugen
- Administratoren besitzen alle drei Rechte.

## Struktur

Ein Event wird beim ersten Zugriff idempotent mit Samstag und Sonntag, den vier Abschnitten `1` bis `4`, den Abschnittsleitern `AL1` bis `AL4` sowie den Posten aus dem 2025er Postenplan angelegt. Die historischen Codes `5/1` bis `5/3` bleiben sichtbar, sind organisatorisch aber Abschnitt 4 zugeordnet.

Jeder Posten besitzt zwei Planungsziele: `targetStaff` ist die reguläre Sollstärke, `emergencyTargetStaff` die positive Notbesetzung, die höchstens der regulären Sollstärke entsprechen darf. `mapX` und `mapY` positionieren den Posten optional auf der Planungskarte. Beide Koordinaten werden gemeinsam als ganze, auf `0` bis `1000` normalisierte Werte gespeichert oder sind gemeinsam `null`.

Der im Frontend ausgewählte Plan (regulär oder Notbesetzung) bestimmt ausschließlich, welches Soll für die Besetzungsanzeige und Unterdeckungsberechnung verwendet wird. Die Auswahl erzeugt keine zweite Zuweisungsmenge und verändert weder Personen noch Tageszuweisungen. Sie wird nicht als Teil der Postenkonfiguration persistiert.

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

`GET /admin/marshals/workspace` liefert für jeden Posten `emergencyTargetStaff`, `mapX` und `mapY`. Beim Konfigurations-Update sind diese Felder für die Kompatibilität mit älteren Clients optional. Für einen neuen Posten fällt ein fehlendes `emergencyTargetStaff` auf `targetStaff` zurück. Bei einem bestehenden Posten bleibt ein nicht übermitteltes `emergencyTargetStaff` unverändert, solange es die neue reguläre Sollstärke nicht überschreitet. Senkt ein älterer Client `targetStaff` unter die gespeicherte Notbesetzung, wird diese auf die neue reguläre Sollstärke begrenzt. Nicht übermittelte Kartenkoordinaten bleiben unverändert; ein explizites Koordinatenpaar `null`/`null` entfernt die Kartenposition.

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

`GET /admin/marshals/print` unterstützt neben `attendance`, `section` und `training` auch `type=area`. Dafür ist `areaId` erforderlich; `shiftId` grenzt eine Aufbau-Liste optional auf eine konfigurierte Schicht ein. Bereich, Schicht und Veranstaltung werden serverseitig gemeinsam validiert. Bereichslisten enthalten Helfernummer, Name, Zusagestatus, Einsatzbemerkung und ein Anwesenheitsfeld, jedoch keine Telefon-, E-Mail- oder Geburtsdaten.

PDFKit erzeugt A4-Querformat ohne Telefonnummern, E-Mail-Adressen oder Geburtsdaten:

- Anwesenheitsliste: Vorname, Nachname, PLZ, Wohnort, Shirt, Posten und leere Unterschriftsspalte
- Abschnittsliste: Vorname, Nachname, Posten/Funktion und leere Änderungsspalte
- Schulungs-/Einweisungsliste: Vorname, Nachname, PLZ, Wohnort, Status und leere Unterschriftsspalte
