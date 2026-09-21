<!-- Synchron gehalten in: MSC-Event-Backend, msc-website (docs/racepic/licenses.md). Bei Änderungen beide Kopien aktualisieren. -->
# RacePic-Lizenzen V1 (kostenlos)

Stand: 2026-09-21
Quelle für die Seed-Daten der Tabelle `racepic_license` (siehe `docs/memory-bank/racepic-architecture.md`, Abschnitt C). Jede Lizenz ist unveränderlich und versioniert: Textänderungen erzeugen eine neue `version`, bereits vergebene Bilder behalten ihre Version.

Alle fünf Lizenzen sind für den MVP **kostenlos** (`pricing_kind = FREE`). Gemeinsame Pflichtangaben beim Download (Abschnitt H/I des Architekturplans): Fotograf, Copyright, Lizenzname, ggf. Namensnennungspflicht, Link zum vollständigen Lizenztext.

Copyright-Zeile (Vorschlag, pro Bild automatisch eingeblendet): „© {Anzeigename Fotograf} / RacePic – MSC Oberlausitzer Dreilaendereck e.V.“

---

## 1. `FREE_UNRESTRICTED` – „Kostenlos nutzbar“

**Flags:** `private_use=true`, `social_media=true`, `editorial=true`, `commercial=false`, `attribution_required=false` (empfohlen, nicht Pflicht)

**Kurzbeschreibung (UI):** Frei nutzbar für private Zwecke, Social Media und redaktionelle Berichterstattung. Namensnennung des Fotografen ist erwünscht, aber nicht Pflicht. Keine kommerzielle Weiterverwertung (z. B. Verkauf, Merchandising, Werbung Dritter).

**Volltext:**
> Der Fotograf räumt jedem Nutzer ein einfaches, unentgeltliches, räumlich und zeitlich unbeschränktes Nutzungsrecht an diesem Bild ein für: private Nutzung, Teilen in sozialen Medien und redaktionelle Berichterstattung (Presse, Vereinsmedien, Motorsportportale). Eine kommerzielle Nutzung im Sinne von Verkauf, Merchandising, Werbung oder sonstiger geschäftlicher Verwertung durch Dritte ist ausgeschlossen. Eine Nennung des Fotografen („© {Anzeigename}“) wird erbeten, ist aber nicht Bedingung der Nutzung. Das Bild darf nicht verändert werden in einer Weise, die die abgebildete Person oder ihr Fahrzeug in einem verfälschenden oder herabwürdigenden Kontext zeigt.

---

## 2. `FREE_PRIVATE_ONLY` – „Kostenlos für private Nutzung“

**Flags:** `private_use=true`, `social_media=false`, `editorial=false`, `commercial=false`, `attribution_required=false`

**Kurzbeschreibung (UI):** Nur für den privaten Gebrauch (eigener Bildschirm, Ausdruck, private Weitergabe an Familie und Freunde). Keine Veröffentlichung im Internet oder in sozialen Medien.

**Volltext:**
> Der Fotograf räumt dem Nutzer ein einfaches, unentgeltliches Recht ein, dieses Bild ausschließlich für den privaten, nicht-öffentlichen Gebrauch zu nutzen (z. B. eigener Bildschirmhintergrund, Ausdruck, private Weitergabe an einen begrenzten Personenkreis). Eine Veröffentlichung im Internet, in sozialen Medien, in der Presse oder eine kommerzielle Nutzung ist nicht gestattet.

---

## 3. `FREE_SOCIAL_ATTRIBUTION` – „Social Media erlaubt mit Namensnennung“

**Flags:** `private_use=true`, `social_media=true`, `editorial=false`, `commercial=false`, `attribution_required=true`, `attribution_template = "Foto: {photographerName} / RacePic"`

**Kurzbeschreibung (UI):** Private Nutzung und Teilen in sozialen Medien erlaubt – mit Pflicht zur Namensnennung des Fotografen (Tag/Verlinkung, sofern die Plattform das zulässt).

**Volltext:**
> Der Fotograf räumt dem Nutzer ein einfaches, unentgeltliches Recht ein, dieses Bild privat zu nutzen und in sozialen Medien zu veröffentlichen, sofern der Fotograf bei jeder Veröffentlichung eindeutig genannt wird (z. B. „Foto: {Anzeigename}“ im Bildtext oder als Tag/Verlinkung des Profils, sofern die Plattform dies unterstützt). Eine redaktionelle oder kommerzielle Nutzung ist nicht gestattet.

---

## 4. `FREE_EDITORIAL` – „Redaktionelle Nutzung erlaubt“

**Flags:** `private_use=true`, `social_media=true`, `editorial=true`, `commercial=false`, `attribution_required=true`, `attribution_template = "Foto: {photographerName} / RacePic"`

**Kurzbeschreibung (UI):** Zusätzlich zur privaten Nutzung und Social Media auch redaktionelle Berichterstattung erlaubt (Vereinszeitschrift, Lokalpresse, Motorsport-Portale), immer mit Namensnennung. Keine Werbung, kein Merchandising, kein Verkauf.

**Volltext:**
> Der Fotograf räumt dem Nutzer ein einfaches, unentgeltliches Recht ein, dieses Bild privat zu nutzen, in sozialen Medien zu teilen und im Rahmen redaktioneller Berichterstattung (Presseartikel, Vereinsmedien, Motorsport-Onlineportale) zu veröffentlichen. Voraussetzung ist in jedem Fall die Nennung des Fotografen („Foto: {Anzeigename}“). Eine Nutzung zu Werbezwecken, für Merchandising oder zum Weiterverkauf ist ausgeschlossen.

---

## 5. `FREE_NC` – „Kommerzielle Nutzung nicht erlaubt“

**Flags:** `private_use=true`, `social_media=true`, `editorial=true`, `commercial=false`, `attribution_required=true`, `attribution_template = "© {photographerName}"`

**Kurzbeschreibung (UI):** Umfassend nutzbar (privat, Social Media, redaktionell) mit Namensnennungspflicht – ausdrücklich **ausgenommen** ist jede kommerzielle Nutzung (Verkauf, Lizenzierung an Dritte, Werbung, Merchandising).

**Volltext:**
> Der Fotograf räumt dem Nutzer ein einfaches, unentgeltliches Recht ein, dieses Bild privat, in sozialen Medien und im Rahmen redaktioneller Berichterstattung zu nutzen, jeweils unter eindeutiger Namensnennung des Fotografen („© {Anzeigename}“). Jede kommerzielle Nutzung – insbesondere Verkauf, entgeltliche Lizenzierung an Dritte, Verwendung in Werbung oder auf Merchandising-Artikeln – ist ausdrücklich untersagt und bedarf der vorherigen schriftlichen Zustimmung des Fotografen.

---

## Hinweise zur Umsetzung

- **Default für neue Fotografen-Profile:** `FREE_EDITORIAL` (Nr. 4) – deckt den Hauptzweck (Fahrer findet und teilt sein Bild, Presse darf berichten) ab, ohne Kommerzialisierung zuzulassen. Fotografen können den Default in ihrem Profil ändern und pro Batch überschreiben.
- **Attribution-Template-Variablen:** `{photographerName}` (Anzeigename), `{eventTitle}`, `{year}` – vom Frontend beim Rendern des Download-Dialogs ersetzt.
- **Erweiterbarkeit:** Neue Lizenzen (inkl. `PAID_*` für den späteren Marketplace) werden als zusätzliche Zeilen mit neuem `code` ergänzt, niemals durch Überschreiben bestehender Texte – siehe `racepic_license.version`.
- **Rechtsprüfung ausstehend:** Diese Texte sind ein technischer Entwurf (Paket 0) und ersetzen keine anwaltliche Prüfung. Vor Live-Schaltung durch den Datenschutzbeauftragten (Stephan Jakab) bzw. eine Rechtsberatung gegenzuprüfen, insbesondere Formulierungen zu Gewährleistung und Haftungsausschluss.
