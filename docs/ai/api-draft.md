# AI Communication Hub API Draft

Stand: 2026-03-31

## Read Endpoints

### `GET /admin/ai/messages`

Inbox-Liste fuer den Mail-Assistenten.

Query:

- `eventId?`
- `status? = imported | processed | archived`
- `limit?`

### `GET /admin/ai/messages/{id}`

Mail-Detail inklusive Plaintext-Body, erkannter Systembasis und freigegebener Wissens-Treffer.

Response:

```json
{
  "ok": true,
  "message": {
    "id": "uuid",
    "subject": "Rueckfrage zur Nennung",
    "fromEmail": "fahrer@example.org",
    "receivedAt": "2026-03-31T10:00:00.000Z",
    "bodyText": "Hallo MSC-Team,\n\n...",
    "bodyHtml": null,
    "bodyFormat": "text",
    "snippet": "Hallo MSC-Team, ...",
    "status": "processed",
    "aiCategory": "nennung",
    "aiSummary": "Rueckfrage zu Nennung und Interview."
  },
  "basis": {
    "event": {
      "id": "uuid",
      "name": "12. Oberlausitzer Dreieck",
      "contactEmail": "info@example.org"
    },
    "entry": {
      "id": "uuid",
      "registrationStatus": "submitted_verified",
      "registrationStatusLabel": "E-Mail bestaetigt, Nennung eingegangen",
      "acceptanceStatus": "accepted",
      "acceptanceStatusLabel": "Zugelassen",
      "paymentStatus": "due",
      "paymentStatusLabel": "Offen",
      "orgaCode": "MSC-2026-123",
      "amountOpenCents": 23000,
      "driverName": "Vinzenz Geisler",
      "className": "Historische Tourenwagen",
      "vehicleLabel": "BMW 2002",
      "detailPath": "/admin/entries/uuid"
    }
  },
  "assistantContext": {
    "knowledgeHits": [
      {
        "id": "uuid",
        "topic": "interview",
        "title": "Interview-Anfragen",
        "content": "Interview-Anfragen muessen vor Ort mit der Rennleitung abgestimmt werden."
      }
    ]
  }
}
```

### `GET /admin/ai/drafts`

Draft-Historie fuer gespeicherte Reply-, Report- und Speaker-Entwuerfe.

### `GET /admin/ai/drafts/{id}`

Laedt einen einzelnen gespeicherten Draft inklusive `outputPayload` und `warnings`.

### `GET /admin/ai/knowledge-suggestions`

Listet reviewpflichtige Wissensvorschlaege.

Query:

- `eventId?`
- `messageId?`
- `topic? = documents | payment | interview | logistics | contact | general`
- `status? = suggested | approved | rejected | archived`
- `limit?`

### `GET /admin/ai/knowledge-items`

Listet freigegebene oder archivierte Wissenseintraege.

Query:

- `eventId?`
- `topic?`
- `status? = suggested | approved | archived`
- `limit?`

### `GET /admin/ai/knowledge-items/{id}`

Laedt einen einzelnen Wissenseintrag inklusive Edit-/Archiv-Metadaten.

## Generate Endpoints

### `POST /admin/ai/messages/{id}/suggest-reply`

Request:

```json
{
  "tone": "friendly",
  "includeWarnings": true,
  "additionalContext": "Interviewanfragen koennen nach Ruecksprache moeglich sein.",
  "mustMention": ["Antwort bitte sachlich halten"],
  "mustAvoid": ["keine verbindliche Zusage"]
}
```

Response:

```json
{
  "ok": true,
  "messageId": "uuid",
  "task": "reply_suggestion",
  "result": {
    "summary": "Rueckfrage zum Status der Nennung und zu einem moeglichen Kurzinterview.",
    "category": "rueckfrage",
    "replySubject": "Re: Rueckfrage zur Nennung",
    "answerFacts": [
      "Die Nennung ist im System eingegangen und die E-Mail-Adresse ist bestaetigt.",
      "Die Nennung ist zugelassen."
    ],
    "unknowns": [
      "Welche konkreten Unterlagen oder Angaben noch fehlen, ist im System aktuell nicht strukturiert hinterlegt."
    ],
    "replyDraft": "Hallo ..., vielen Dank fuer Ihre Nachricht ...",
    "analysis": {
      "intent": "rueckfrage",
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
      "name": "12. Oberlausitzer Dreieck",
      "contactEmail": "info@example.org"
    },
    "entry": {
      "id": "uuid",
      "registrationStatus": "submitted_verified",
      "registrationStatusLabel": "Die Nennung ist im System eingegangen und die E-Mail-Adresse ist bestaetigt.",
      "acceptanceStatus": "accepted",
      "acceptanceStatusLabel": "Die Nennung ist zugelassen.",
      "paymentStatus": "due",
      "paymentStatusLabel": "Es ist noch ein offener Betrag von 230,00 EUR vermerkt.",
      "amountOpenCents": 23000,
      "paymentReference": "Nennung MSC-2026-123 Mustermann"
    },
    "knowledgeHits": [
      {
        "id": "uuid",
        "topic": "interview",
        "title": "Interview-Anfragen",
        "content": "Interview-Anfragen muessen vor Ort mit der Rennleitung abgestimmt werden."
      }
    ],
    "operatorInput": {
      "additionalContext": "Interviewanfragen koennen nach Ruecksprache moeglich sein.",
      "mustMention": ["Antwort bitte sachlich halten"],
      "mustAvoid": ["keine verbindliche Zusage"]
    },
    "usedKnowledge": {
      "faqCount": 0,
      "logisticsNotesCount": 0,
      "approvedKnowledgeCount": 1,
      "previousOutgoingCount": 5,
      "basedOnPreviousCorrespondence": true
    }
  },
  "warnings": [
    {
      "code": "UNKNOWN_CONTEXT",
      "severity": "medium",
      "message": "Welche konkreten Unterlagen oder Angaben noch fehlen, ist im System aktuell nicht strukturiert hinterlegt.",
      "displayMessage": "Welche konkreten Unterlagen oder Angaben noch fehlen, ist im System aktuell nicht strukturiert hinterlegt.",
      "recommendation": "Bitte die offene Stelle vor dem Uebernehmen oder Versenden kurz manuell pruefen."
    }
  ],
  "review": {
    "required": true,
    "status": "draft",
    "confidence": "medium",
    "reason": "Die Ausgabe enthaelt Hinweise zu fehlendem oder unsicherem Kontext und muss geprueft werden.",
    "recommendedChecks": [
      "Faktenlage und Tonalitaet kurz manuell pruefen.",
      "Warnhinweise vor der Uebernahme inhaltlich pruefen."
    ],
    "blockingIssues": []
  },
  "meta": {
    "modelId": "eu.amazon.nova-micro-v1:0",
    "promptVersion": "v1",
    "generatedAt": "2026-03-31T12:00:00.000Z"
  }
}
```

### `POST /admin/ai/messages/{id}/chat`

Kontextgebundener Mini-Chat zur aktuellen Mail.

Request:

```json
{
  "message": "Kann ich dazu noch eine Interview-Regel hinterlegen?",
  "history": [
    {
      "role": "user",
      "message": "Die Rennleitung muss gefragt werden."
    }
  ],
  "contextMode": "knowledge_capture"
}
```

Response:

```json
{
  "ok": true,
  "messageId": "uuid",
  "task": "message_chat",
  "result": {
    "answer": "Ja, daraus kann ein Wissensvorschlag fuer Interview-Anfragen abgeleitet werden.",
    "usedFacts": [
      "Die Nennung ist im System eingegangen und die E-Mail-Adresse ist bestaetigt."
    ],
    "unknowns": [],
    "knowledgeSuggestions": [
      {
        "topic": "interview",
        "title": "Interview-Anfragen nach dem Lauf",
        "content": "Interview-Anfragen muessen mit der Rennleitung abgestimmt werden.",
        "rationale": "Wiederverwendbare Regel fuer spaetere Rueckfragen."
      }
    ]
  },
  "basis": {
    "message": {
      "id": "uuid",
      "subject": "Rueckfrage zur Nennung"
    },
    "knowledgeHits": [],
    "historyCount": 1,
    "contextMode": "knowledge_capture"
  }
}
```

### `POST /admin/ai/messages/{id}/knowledge-suggestions`

Erzeugt und speichert reviewpflichtige Wissensvorschlaege zur Mail.

Request:

```json
{
  "additionalContext": "Interviewanfragen muessen mit der Rennleitung abgestimmt werden.",
  "history": [],
  "topicHint": "interview"
}
```

### `POST /admin/ai/reports/generate`

Unveraendert gegenueber dem bisherigen Mehrvarianten-Contract mit `formats[]`.

### `POST /admin/ai/speaker/generate`

Unveraendert gegenueber dem bisherigen Speaker-Contract.

## Persistence

### `POST /admin/ai/drafts`

Speichert einen explizit uebernommenen Entwurf.

### `PATCH /admin/ai/drafts/{id}`

Aktualisiert einen bestehenden `reply_suggestion`-Draft serverseitig.

Request:

```json
{
  "replySubject": "Re: Aktualisierte Rueckfrage zur Nennung",
  "replyDraft": "Hallo ..., vielen Dank fuer Ihre Rueckfrage ...",
  "answerFacts": [
    "Die Nennung ist im System eingegangen.",
    "Die Nennung ist zugelassen."
  ],
  "unknowns": [
    "Konkrete fehlende Unterlagen sind derzeit nicht strukturiert hinterlegt."
  ],
  "operatorEdits": {
    "source": "frontend-edit",
    "note": "Text manuell geschaerft"
  }
}
```

Verhalten:

- aktualisiert den bearbeiteten Nutzinhalt in `outputPayload`
- ergaenzt `operatorEdits.editedBy` und `operatorEdits.editedAt`
- erhaelt vorhandene `basis`, `review` und `warnings` getrennt
- erneutes `GET /admin/ai/drafts/{id}` liefert die bearbeitete Version

### `POST /admin/ai/knowledge-items`

Uebernimmt einen Wissensvorschlag in die freigegebene Wissensbasis oder legt einen manuellen Eintrag an.

Request aus Vorschlag:

```json
{
  "suggestionId": "uuid",
  "status": "approved"
}
```

Manueller Request:

```json
{
  "eventId": "uuid",
  "messageId": "uuid",
  "topic": "contact",
  "title": "Pressekontakt Event 2026",
  "content": "Presseanfragen bitte an presse@example.org senden.",
  "status": "approved"
}
```

### `PATCH /admin/ai/knowledge-items/{id}`

Aktualisiert einen bestehenden Wissenseintrag bei stabiler `id`.

Request:

```json
{
  "topic": "interview",
  "title": "Interview-Anfragen Hochschulprojekt",
  "content": "Interviewanfragen fuer Hochschulprojekte muessen mit der Rennleitung abgestimmt werden.",
  "status": "approved"
}
```

### `DELETE /admin/ai/knowledge-items/{id}`

Soft-Delete auf der freigegebenen Wissensbasis.

Verhalten:

- setzt `status = archived`
- setzt `updatedBy`, `updatedAt`, `archivedBy`, `archivedAt`
- `GET /admin/ai/knowledge-items` zeigt die Aenderung direkt
- `knowledge-items` bleiben klar getrennt von `knowledge-suggestions`
