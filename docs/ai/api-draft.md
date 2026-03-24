# AI Communication Hub API Draft

Stand: 2026-03-24

## Read Endpoints

### `GET /admin/ai/messages`

Listet importierte Inbox-Nachrichten fuer den Anfrage-Assistenten.

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
      "source": "imap",
      "mailboxKey": "dreiecksrennen-dev-imap",
      "fromEmail": "fahrer@example.org",
      "fromName": "Max Mustermann",
      "toEmail": "nennung@example.org",
      "subject": "Rueckfrage zur Nennung",
      "receivedAt": "2026-03-24T11:00:00.000Z",
      "eventId": "uuid",
      "entryId": "uuid",
      "status": "processed",
      "aiSummary": "Rueckfrage zum Status der Nennung.",
      "aiCategory": "nennung",
      "textContent": "Volltext...",
      "createdAt": "2026-03-24T11:00:02.000Z",
      "preview": "Volltext..."
    }
  ]
}
```

### `GET /admin/ai/messages/{id}`

Laedt die Detailansicht fuer den Anfrage-Assistenten.

Response:

```json
{
  "ok": true,
  "message": {
    "id": "uuid",
    "source": "imap",
    "mailboxKey": "dreiecksrennen-dev-imap",
    "fromEmail": "fahrer@example.org",
    "fromName": "Max Mustermann",
    "toEmail": "nennung@example.org",
    "subject": "Rueckfrage zur Nennung",
    "receivedAt": "2026-03-24T11:00:00.000Z",
    "eventId": "uuid",
    "entryId": "uuid",
    "status": "processed",
    "aiCategory": "nennung",
    "aiSummary": "Rueckfrage zum Status der Nennung.",
    "aiLastProcessedAt": "2026-03-24T11:05:00.000Z",
    "textContent": "Volltext...",
    "createdAt": "2026-03-24T11:00:02.000Z"
  },
  "basis": {
    "event": {
      "id": "uuid",
      "name": "Dreiecksrennen 2026",
      "contactEmail": "info@example.org"
    },
    "entry": {
      "id": "uuid",
      "registrationStatus": "submitted_verified",
      "acceptanceStatus": "accepted",
      "paymentStatus": "due",
      "orgaCode": "MSC-2026-123"
    }
  }
}
```

### `GET /admin/ai/drafts`

Listet gespeicherte AI-Drafts fuer Dashboard und Historie.

Query:

- `taskType?` = `reply_suggestion | event_report | speaker_text`
- `eventId?`
- `limit?`

## Generate Endpoints

### `POST /admin/ai/messages/{id}/suggest-reply`

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
  "task": "reply_suggestion",
  "result": {
    "summary": "Rueckfrage zum Status der Nennung und zu moeglichen noch fehlenden Unterlagen.",
    "category": "unterlagen",
    "replyDraft": "Hallo ..., vielen Dank fuer deine Nachricht ...",
    "analysis": {
      "intent": "unterlagen",
      "language": "de"
    }
  },
  "basis": {
    "message": {
      "id": "uuid",
      "subject": "Rueckfrage zur Nennung"
    },
    "event": {
      "id": "uuid",
      "name": "Dreiecksrennen 2026",
      "contactEmail": "info@example.org"
    },
    "entry": {
      "id": "uuid",
      "registrationStatus": "submitted_verified",
      "acceptanceStatus": "accepted",
      "paymentStatus": "due",
      "amountOpenCents": 8000,
      "paymentReference": "Nennung MSC-2026-123 Mustermann"
    },
    "usedKnowledge": {
      "faqCount": 2,
      "logisticsNotesCount": 1,
      "previousOutgoingCount": 1
    }
  },
  "warnings": [
    {
      "code": "MISSING_DOCUMENT_DETAILS",
      "severity": "medium",
      "message": "Es gibt keinen strukturierten Datensatz, welche Unterlagen konkret fehlen."
    }
  ],
  "review": {
    "required": true,
    "status": "draft",
    "confidence": "medium"
  },
  "meta": {
    "modelId": "eu.amazon.nova-micro-v1:0",
    "promptVersion": "v1",
    "generatedAt": "2026-03-24T12:00:00.000Z"
  }
}
```

### `POST /admin/ai/reports/generate`

Request:

```json
{
  "eventId": "uuid",
  "scope": "class",
  "classId": "uuid",
  "formats": ["website", "short_summary"],
  "tone": "neutral",
  "length": "medium",
  "highlights": [
    "starke internationale Beteiligung",
    "gute Resonanz im Fahrerlager"
  ]
}
```

Response:

```json
{
  "ok": true,
  "eventId": "uuid",
  "task": "event_report",
  "result": {
    "variants": [
      {
        "format": "website",
        "title": "Starkes Feld beim Dreiecksrennen 2026",
        "teaser": "Breites Teilnehmerfeld und intensive Rennatmosphaere.",
        "text": "..."
      },
      {
        "format": "short_summary",
        "title": null,
        "teaser": null,
        "text": "..."
      }
    ]
  },
  "basis": {
    "scope": "class",
    "event": {
      "id": "uuid",
      "name": "Dreiecksrennen 2026"
    },
    "class": {
      "id": "uuid",
      "name": "Historische Tourenwagen"
    },
    "facts": {
      "entriesTotal": 24,
      "acceptedTotal": 18,
      "paidTotal": 14
    },
    "highlights": [
      "starke internationale Beteiligung",
      "gute Resonanz im Fahrerlager"
    ]
  },
  "warnings": [
    {
      "code": "NO_RESULTS_DATA",
      "severity": "medium",
      "message": "Es liegen keine strukturierten Ergebnisdaten vor; der Text basiert auf Stammdaten und manuellen Highlights."
    }
  ],
  "review": {
    "required": true,
    "status": "draft",
    "confidence": "medium"
  },
  "meta": {
    "modelId": "eu.amazon.nova-micro-v1:0",
    "promptVersion": "v1",
    "generatedAt": "2026-03-24T12:00:00.000Z"
  }
}
```

### `POST /admin/ai/speaker/generate`

Request:

```json
{
  "eventId": "uuid",
  "entryId": "uuid",
  "mode": "driver_intro",
  "highlights": [
    "erstmals in dieser Klasse",
    "historische BMW"
  ]
}
```

Response:

```json
{
  "ok": true,
  "eventId": "uuid",
  "task": "speaker_text",
  "result": {
    "text": "Am Start steht jetzt ...",
    "facts": [
      "Startnummer 42",
      "Klasse Historische Tourenwagen",
      "BMW 2002"
    ]
  },
  "basis": {
    "focusType": "entry",
    "context": {
      "eventName": "Dreiecksrennen 2026",
      "className": "Historische Tourenwagen",
      "startNumber": "42",
      "driverFirstName": "Max",
      "driverLastName": "Mustermann",
      "vehicleMake": "BMW",
      "vehicleModel": "2002"
    },
    "highlights": [
      "erstmals in dieser Klasse",
      "historische BMW"
    ]
  },
  "warnings": [],
  "review": {
    "required": true,
    "status": "draft",
    "confidence": "high"
  },
  "meta": {
    "modelId": "eu.amazon.nova-micro-v1:0",
    "promptVersion": "v1",
    "generatedAt": "2026-03-24T12:00:00.000Z"
  }
}
```

## Persistence

### `POST /admin/ai/drafts`

Speichert einen explizit freigegebenen Entwurf.

Request:

```json
{
  "taskType": "reply_suggestion",
  "messageId": "uuid",
  "eventId": "uuid",
  "title": "Antwort auf Rueckfrage zur Nennung",
  "modelId": "eu.amazon.nova-micro-v1:0",
  "inputSnapshot": {
    "tone": "friendly"
  },
  "outputPayload": {
    "summary": "Kurzfassung",
    "replyDraft": "Antworttext"
  },
  "warnings": [
    {
      "code": "REVIEW_NOTE",
      "severity": "medium",
      "message": "Bitte Interview-Anfrage intern pruefen."
    }
  ]
}
```
