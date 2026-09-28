-- RacePic Commerce (AP16): Webhook-Inbox um Lease und Status IGNORED erweitern.
-- Ablauf (Marketplace-Plan Abschnitt 3.2): Signatur pruefen -> Rohnachricht in S3 ablegen -> Inbox-Zeile
-- (Deduplizierung ueber Provider + Event-ID) -> SQS -> Worker verarbeitet zustandsbasiert idempotent.

alter table "commerce_webhook_inbox"
  add column if not exists "lease_expires_at" timestamptz;

alter table "commerce_webhook_inbox" drop constraint if exists "commerce_webhook_inbox_status_check";
alter table "commerce_webhook_inbox" add constraint "commerce_webhook_inbox_status_check"
  check ("status" in ('RECEIVED', 'PROCESSING', 'PROCESSED', 'IGNORED', 'FAILED'));

create index if not exists "commerce_webhook_inbox_lease_idx"
  on "commerce_webhook_inbox" ("status", "lease_expires_at") where "status" = 'PROCESSING';
