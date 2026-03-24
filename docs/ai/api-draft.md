# AI Communication Hub API Draft

Stand: 2026-03-24

## `GET /admin/ai/messages`

Listet importierte Inbox-Nachrichten.

Query:

- `eventId?`
- `status?` = `imported | processed | archived`
- `limit?`

Response:

```json
{
  "ok": true,
  "messages": [
    {
      "id": "uuid",
      "fromEmail": "fahrer@example.org",
      "subject": "Frage zur Zahlung",
      "status": "processed",
      "aiCategory": "zahlung",
      "preview": "Kurzvorschau ..."
    }
  ]
}
```

## `POST /admin/ai/messages/{id}/suggest-reply`

Request:

```json
{
  "tone": "friendly",
  "includeWarnings": true
}
```

Response:

```json
{
  "ok": true,
  "messageId": "uuid",
  "modelId": "eu.amazon.nova-micro-v1:0",
  "summary": "Die Nachricht fragt nach dem offenen Nenngeld.",
  "category": "zahlung",
  "replyDraft": "Hallo ..., vielen Dank fuer deine Nachricht ...",
  "warnings": [],
  "confidence": "medium"
}
```

## `POST /admin/ai/reports/generate`

Request:

```json
{
  "eventId": "uuid",
  "format": "website",
  "tone": "neutral",
  "length": "medium",
  "highlights": [
    "starke internationale Beteiligung",
    "gute Resonanz im Fahrerlager"
  ]
}
```

## `POST /admin/ai/speaker/generate`

Request:

```json
{
  "eventId": "uuid",
  "entryId": "uuid",
  "mode": "driver_intro",
  "highlights": [
    "kommt mit historischer BMW",
    "erstmals in dieser Klasse"
  ]
}
```

## `POST /admin/ai/drafts`

Speichert einen explizit freigegebenen Entwurf.

Request:

```json
{
  "taskType": "reply_suggestion",
  "messageId": "uuid",
  "eventId": "uuid",
  "title": "Antwort auf Zahlungsfrage",
  "modelId": "eu.amazon.nova-micro-v1:0",
  "inputSnapshot": {
    "tone": "friendly"
  },
  "outputPayload": {
    "summary": "Kurzfassung",
    "replyDraft": "Antworttext"
  },
  "warnings": []
}
```
