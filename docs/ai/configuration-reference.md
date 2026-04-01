# AI Communication Hub Configuration Reference

Stand: 2026-04-02

## Ziel

Dieses Dokument listet die fuer den `AI Communication Hub` benoetigten Konfigurationen und Secrets auf, ohne produktive Zugangsdaten im Repository zu speichern.

## 1. Bedrock-Konfiguration

Empfohlener MVP-Wert:

- `AI_BEDROCK_MODEL_ID=eu.amazon.nova-micro-v1:0`

Zweck:

- wird vom Backend fuer strukturierte Textgenerierung genutzt
- betrifft Mail-Assistent, Berichtsgenerator und Sprecherassistenz

## 2. IMAP-Secret fuer den Mail-Assistenten

Empfohlener Secret-Name:

- `dreiecksrennen/dev/ai/inbox-imap`

Beispielinhalt:

```json
{
  "host": "imap.example.org",
  "port": 993,
  "username": "nennung@example.org",
  "password": "REPLACE_ME",
  "mailbox": "INBOX"
}
```

Beispielhafte Verwendung:

- Secret ARN wird in der Stage-Konfiguration referenziert
- der Poller liest daraus die Zugangsdaten

## 3. Stage-spezifische Konfiguration

Relevante Dateien:

- `infra/lib/config/dev.ts`
- `infra/lib/config/prod.ts`

Zu dokumentierende bzw. zu pflegende Werte:

- `aiBedrockModelId`
- `aiInboxImapSecretArn`
- CORS-/Web-Origin
- weitere stage-spezifische URLs

## 4. Datenbank

Fuer Migrationen wird benoetigt:

- `DATABASE_URL`
- ggf. `DB_SSL_CA_PATH`

Die Zugangsdaten sollen nicht ins Repo.

## 5. Erforderliche AWS-Berechtigungen

Mindestens fuer Deploy und Betrieb:

- Bedrock Runtime Invoke
- Secrets Manager Read
- Lambda Execute / Deploy
- EventBridge Scheduler
- S3 Read / Write
- CloudFormation / CDK
- RDS / DB-Zugriff fuer Migrationen

## 6. Keine Secrets im Repository

Nicht ablegen:

- IMAP-Passwoerter
- produktive AWS Zugangsdaten
- echte Tokens
- personenbezogene Demo-Zugangsdaten

Stattdessen abgeben:

- Secret-Namen
- ARN-Beispiele oder erwartetes Format
- JSON-Beispielinhalte
- eindeutige Setup-Anleitung

## 7. Fuer den Nachbau wichtig

Eine andere Person muss aus diesem Repo erkennen koennen:

- welche Secrets sie selbst anlegen muss
- wie diese strukturiert sein muessen
- in welcher Stage-Datei sie referenziert werden
- welches Bedrock-Modell fuer den MVP vorgesehen ist
