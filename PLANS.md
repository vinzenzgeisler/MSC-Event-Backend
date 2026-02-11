# Phase Plan (3–7)

## Phase 3: Mail Outbox + SES + Reminder + PDF + Presigned
**Goals**
- Outbox pattern for emails with worker + scheduler.
- PDF generation (waiver + tech check) stored in S3, download via presigned URL.
- Admin APIs with Zod validation and audit logs.

**Tasks**
1. DB migrations:
   - `email_outbox`, `email_delivery`, `document`, optional `document_generation_job`.
   - Indexes for outbox polling and uniqueness.
2. API:
   - `POST /admin/mail/queue`
   - `POST /admin/payment/reminders/queue`
   - `POST /admin/documents/waiver`
   - `POST /admin/documents/tech-check`
   - `GET /admin/documents/:id/download`
3. Jobs:
   - `email-worker` (poll outbox, send via SES).
   - `payment-reminder-scheduler` (queue reminders).
4. Infra:
   - SES permissions for mail lambda.
   - Scheduler for reminder job.
5. Libraries:
   - Zod, PDFKit, SES/S3 SDK clients.

**Smoke Tests**
- Queue mail creates outbox rows + audit log.
- Worker sends queued emails and marks sent/failed.
- Reminder job queues due invoices.
- PDF endpoints generate S3 object and return presigned URL.
- Validation errors return 400, auth 401/403, unique conflicts 409.

**Risks/Decisions**
- PDF engine: PDFKit for Lambda stability.
- SES sandbox: only verified senders/recipients.

**Non-Goals**
- No UI.
- No digital signature.

---

## Phase 4: Signature Preparation
**Tasks**
- Tables: `sign_session`, `sign_audit`.
- Endpoints for creating sessions and polling status.
- Optional S3 Object Lock prep (not enabled).

**Smoke Tests**
- Sign session creation and audit append-only behavior.

**Non-Goals**
- No actual signing UX or crypto signature.

---

## Phase 5: Pricing Rules + Event Settings
**Tasks**
- `event_settings` with deadlines, price tiers, discounts.
- Admin endpoints for settings and pricing recalculation.

**Smoke Tests**
- Deterministic pricing for entries.
- Archived events are read-only.

---

## Phase 6: Exports + Print Lists
**Tasks**
- CSV/Excel exports for entries/payments.
- PDF print lists for badges/check-in.

**Smoke Tests**
- Export endpoints return correct data and filters.

---

## Phase 7: Hardening/Operations
**Tasks**
- CloudWatch alarms, RDS backups, API rate limits.
- RBAC refinement and security review.

**Smoke Tests**
- Alarms trigger on forced failures.
- Backup policy verified.
