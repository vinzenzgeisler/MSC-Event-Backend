# Schutz durch Veröffentlichungsnamen

## Fachliche Regel

Ein `publication_name` ist der personweit gültige **Veröffentlichungsname**. Sobald er gesetzt ist, dürfen nicht-amtliche Ausgaben ausschließlich diesen Namen als `displayName` verwenden. Vorname, Nachname und Kontaktdaten werden in API-Antworten und Exporten für diese Person nicht ausgegeben. Suche und Sortierung erfolgen ebenfalls über den Veröffentlichungsnamen, damit Klarnamen nicht über Trefferlisten ermittelbar sind.

Den Klarnamen dürfen nur die für die Veranstaltungsdurchführung erforderlichen amtlichen Dokumente enthalten:

- Haftungsverzicht, einschließlich signierter Fassung
- Nennbestätigung
- Dokument der technischen Abnahme

Bedienoberflächen für Anmeldung, Check-in, Signatur und technische Abnahme zählen nicht zu den amtlichen Dokumenten und müssen `displayName` verwenden.

## Administrativer Ablauf

Nur die Rolle `admin` besitzt `entries.publication_name.write`. Die Pflege erfolgt über:

`PATCH /admin/persons/{id}/publication-name`

Setzen oder Ändern:

```json
{ "publicationName": "Der Blitz" }
```

Entfernen des Schutzes:

```json
{
  "publicationName": null,
  "confirmLegalNameExposure": true,
  "reason": "Schriftlicher Wunsch der betroffenen Person"
}
```

Das Entfernen benötigt eine ausdrückliche Bestätigung und einen Grund. Jede tatsächliche Änderung erhöht `publication_name_version` und wird als `person_publication_name_changed` revisionssicher protokolliert. Der Veröffentlichungsname darf nicht dem normalisierten Klarnamen entsprechen.

## Ausgaben und Leckschutz

Die zentrale Projektion `standardPersonIdentity` liefert für alle nicht-amtlichen Ausgaben `displayName` und `identityProtected`. Bei aktivem Schutz sind getrennte Namensfelder `null` beziehungsweise in CSV-Dateien leer. Dies gilt insbesondere für:

- Nennungslisten und Detailansichten
- offene Einladungs- und Terminal-Payloads
- technische Abnahme und QR-Blätter
- Stempelkarten
- Programmheft-, Teilnehmer-, Start-, Zahlungs- und Check-in-Exporte
- Dashboard-Warnungen und Ortsauswertungen
- E-Mail-Inhalte, Vorschauen, Outbox-Listen und Nennungshistorie

Freitext und strukturierte E-Mail-Daten werden vor dem Versand zusätzlich von vollständigen Klarnamensvarianten bereinigt. Bereits wartende oder fehlgeschlagene Nachrichten werden beim Aktivieren des Schutzes ebenfalls bereinigt. E-Mail-Adressen und weitere Kontaktdaten bleiben intern für Zustellung und amtliche Verarbeitung erhalten, werden aber nicht über die genannten APIs oder Exporte offengelegt.

## Ungültigmachung bestehender Exporte

Jeder erzeugte Export speichert die beteiligten Personen zusammen mit deren `publication_name_version`. Ändert sich ein Veröffentlichungsname, werden betroffene laufende und fertige Exporte auf `invalidated` gesetzt und ihre privaten S3-Objekte gelöscht. Vor Abschluss und vor Ausgabe eines neuen Downloadlinks findet zusätzlich ein Versionsabgleich statt.

Stempelkarten, die vor Einführung der Versionsverfolgung erzeugt wurden, werden bei einer Namensänderung für alle betroffenen Veranstaltungen konservativ gelöscht. Neue Stempelkarten liegen unter dem versionierten Präfix `stamp-cards/v2/` und werden wie andere Exporte personengenau verfolgt.

Bereits lokal heruntergeladene Dateien und bereits zugestellte E-Mails können technisch nicht zurückgerufen werden. Vorsignierte Downloadlinks laufen spätestens nach fünf Minuten ab; das Löschen des Zielobjekts macht sie normalerweise sofort unbrauchbar. Schlägt eine Objektlöschung fehl, meldet die Änderungsantwort dies als `cleanupPendingCount`, während der API-Download gesperrt bleibt.

## Rollout

Migration `0081_person_publication_name.sql` muss durch die bestehende CI/CD-Pipeline vor beziehungsweise zusammen mit der neuen API-Version ausgeführt werden. Sie erfasst alte Exporte konservativ mit allen Personen des jeweiligen Events. Es darf kein lokales Direkt-Deployment erfolgen.

Ein konsumierendes Frontend soll ausschließlich `displayName` anzeigen, wenn `identityProtected` gesetzt ist. Die Admin-Maske zum Entfernen muss Warntext, Bestätigung und Begründung erzwingen.
