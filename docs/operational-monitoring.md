# Betrieb nach der Veranstaltung

Die Anmeldung ist geschlossen. Der Adminbereich, die Datenbank und die Mail-Outbox bleiben für die Nachbereitung verfügbar. Der Mail-Worker läuft alle 15 Minuten und verarbeitet wartende, manuell ausgelöste sowie durch fachliche Aktionen erzeugte Mails. Automatische Zahlungs- und E-Mail-Bestätigungserinnerungen sind über `AUTOMATIC_REMINDERS_ENABLED=false` pausiert. Die Mail nach einem abgeschlossenen Zahlungsvorgang bleibt aktiv.

## Logging und Mail-Feedback

API und Worker protokollieren technische Ereignisse strukturiert in CloudWatch. Lambda-Logs werden 90 Tage, API-Access-Logs 30 Tage aufbewahrt. Die gespeicherten Logs-Insights-Abfragen `<prefix>/operational-errors` und `<prefix>/api-requests` stehen für die manuelle Fehlersuche bereit. Die Anwendungslogger verwenden eine Feld-Whitelist; Namen, E-Mail-Adressen, Notizen, Request-Bodies und Signaturen werden nicht in Betriebslogs geschrieben.

Das SES-Feedback verarbeitet Delivery, Bounce, Complaint, Reject, Delivery Delay und Rendering Failure weiter. Zustellstatus werden in der Datenbank aktualisiert; nicht verarbeitbare Nachrichten landen für 14 Tage in der Dead-Letter-Queue. Die CloudWatch-Alarmierung, das Operations-Dashboard, der minütliche Prüfjob und detaillierte API-Routenmetriken sind deaktiviert. Damit werden Störungen nicht mehr automatisch per Alarm-E-Mail gemeldet.

`ORGA_NOTIFICATION_RECIPIENTS` bleibt in den GitHub Environments `dev` und `prod` erforderlich. Die Adressen erhalten fachliche Orga-Mails direkt aus der Outbox; eine SNS-Bestätigung ist dafür nicht nötig.

## Manuelle Prüfung

- Bei Mailproblemen die Outbox-Zustände und die gespeicherten Logs-Insights-Abfragen prüfen. Ein Eintrag im Zustand `sending`, der älter als fünf Minuten ist, wird beim nächsten Worker-Lauf erneut freigegeben; danach gelten gestaffelte Retries.
- Bei Bounce oder Complaint die Empfängeradresse fachlich prüfen und erst danach eine manuelle Neuversendung auslösen.
- Nach einem CI/CD-Deployment Adminzugriff, eine manuell ausgelöste Mail und SES-Zustellfeedback prüfen. Der Mailversand kann bis zu 15 Minuten warten.

Deployments erfolgen ausschließlich über die bestehende GitHub-Actions-Pipeline.
