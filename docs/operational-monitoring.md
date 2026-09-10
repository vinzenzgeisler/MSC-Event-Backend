# Betriebsmonitoring und Alarmierung

## Zielbild

Das Backend protokolliert technische Ereignisse strukturiert in CloudWatch, prüft die kritischen Geschäftsabläufe jede Minute und meldet Störungen per E-Mail. Fachliche Benachrichtigungen für neue Nennungen und finale Entscheidungen der technischen Abnahme laufen über dieselbe dauerhafte Mail-Outbox wie die übrigen Systemmails.

Das Admin-Dashboard ist nicht Teil der Alarmkette. Seine Fahrerkarte ruft Geocoding nur noch bei einem expliziten Refresh auf und kann damit die normalen Dashboard-Abfragen nicht mehr durch einen langsamen externen Dienst blockieren.

## Empfänger einrichten

In den GitHub Environments `dev` und `prod` muss die Variable `ORGA_NOTIFICATION_RECIPIENTS` gesetzt sein. Mehrere Adressen werden mit Komma oder Semikolon getrennt. Die Pipeline bricht vor Synthese oder Deployment ab, wenn die Variable fehlt.

Beim ersten Deployment erzeugt AWS für jede Adresse ein SNS-Abonnement. Jede empfangende Person muss den Link in der AWS-Bestätigungsmail anklicken. Bis dahin steht das Abonnement auf `PendingConfirmation` und kritische Alarme werden an diese Adresse nicht zugestellt. Fachmails aus der Outbox benötigen keine SNS-Bestätigung.

## Was überwacht wird

- API: 5xx, Lambda-Fehler, Drosselungen und ein externer `/health`-Probe.
- Haftverzicht: abgeschlossene Session ohne vollständige DB-/S3-Nachweise, fehlgeschlagene Bestätigungsmail und fehlende aktuelle S3-Objekte.
- Technische Abnahme: finale Entscheidung ohne vollständige Orga-Mailmenge.
- Nennung: neue Registrierungsgruppe ohne vollständige Orga-Mailmenge.
- Mail: fehlgeschlagene, überfällige oder festhängende Outbox-Einträge sowie SES Bounce, Complaint, Reject, Delivery Delay und Rendering Failure. Nicht verarbeitbares SES-Feedback landet für 14 Tage in einer alarmierten Dead-Letter-Queue.
- Monitor: minütlicher Heartbeat; sein Ausfall wird selbst alarmiert.
- RDS: CPU, Verbindungen, freier Speicher, freier Arbeitsspeicher und CPU-Credits.

Die vier Sammelalarme `critical-availability`, `critical-workflows`, `critical-mail` und `critical-database` senden sowohl den Alarm- als auch den OK-Zustand an das SNS-Thema `<prefix>-critical-alerts`. Einzelalarme bleiben darunter sichtbar, versenden aber keine zusätzlichen E-Mails.

## CloudWatch verwenden

Das Dashboard heißt `<prefix>-operations`. Es enthält Alarmstatus, API-Verkehr und Latenz, Mailzustand, Workflow-Integrität, RDS-Metriken und die letzten API-5xx.

Gespeicherte Logs-Insights-Abfragen:

- `<prefix>/operational-errors`: sicherheits- und betriebsrelevante strukturierte Ereignisse aus API und Workern.
- `<prefix>/api-requests`: technische API-Aufrufe mit Request-ID, Route, Status und Latenzen.

Die Lambda-Logs werden 90 Tage, API-Access-Logs 30 Tage aufbewahrt. Die Anwendungslogger verwenden eine Feld-Whitelist; Namen, E-Mail-Adressen, Notizen, Request-Bodies und Signaturen werden nicht in Betriebslogs geschrieben.

## Reaktion bei Alarm

1. Im CloudWatch-Dashboard den betroffenen Sammelalarm und dessen auslösenden Einzelalarm öffnen.
2. Mit der passenden gespeicherten Logs-Insights-Abfrage nach Zeitpunkt, `requestId`, `eventId`, `entryId` oder `sessionId` filtern.
3. Bei Mailproblemen die Outbox-Zustände prüfen. Ein Eintrag im Zustand `sending`, der älter als fünf Minuten ist, wird automatisch erneut freigegeben; danach gelten gestaffelte Retries bis zum permanenten Fehler.
4. Bei fehlendem Haftverzicht-Nachweis keine Session manuell auf `completed` setzen. DB-Datensatz und beide S3-Nachweise gemeinsam prüfen.
5. Bei Bounce oder Complaint die Empfängeradresse fachlich prüfen und erst danach eine manuelle Neuversendung auslösen.

## Inbetriebnahme vor der Veranstaltung

Nach dem CI/CD-Deployment:

1. Alle SNS-Abonnements bestätigen.
2. Dashboard und vier Sammelalarme aufrufen; sie müssen nach einigen Minuten `OK` zeigen.
3. Eine Testnennung durchführen und den Orga-Mail-Eingang innerhalb von ungefähr einer Minute kontrollieren.
4. Eine Test-Abnahme auf `passed` und eine auf `failed` setzen; Fahrer- und Orga-Mail sowie Audit-Historie prüfen.
5. Einen vollständigen Test-Haftverzicht durchführen, PDF-Download und Bestätigungsmail kontrollieren.
6. Die gespeicherten Logs-Insights-Abfragen einmal ausführen und sicherstellen, dass keine personenbezogenen Inhalte erscheinen.

Deployments erfolgen ausschließlich über die bestehende GitHub-Actions-Pipeline. Lokale CDK-Deployments sind nicht vorgesehen.
