alter table "document"
  add column if not exists "signing_session_id" uuid;

alter table "document"
  drop constraint if exists "document_signing_session_id_fkey";
alter table "document"
  add constraint "document_signing_session_id_fkey"
  foreign key ("signing_session_id") references "signing_session"("id") on delete set null;

update "document" target
set "signing_session_id" = session_row."id"
from "signing_session" session_row
join "document" anchor on anchor."id" = session_row."document_id"
where target."signing_session_id" is null
  and target."type" = 'waiver_signed'
  and target."event_id" is not distinct from anchor."event_id"
  and target."s3_key" = anchor."s3_key";

create index if not exists "document_signing_session_idx"
  on "document" ("signing_session_id", "created_at");

alter table "entry_charity_codriver"
  add column if not exists "revoked_at" timestamptz,
  add column if not exists "revoked_by" text,
  add column if not exists "revocation_reason" text;

alter table "entry_charity_codriver"
  drop constraint if exists "entry_charity_codriver_revocation_reason_check";
alter table "entry_charity_codriver"
  add constraint "entry_charity_codriver_revocation_reason_check"
  check (
    "status" <> 'revoked'
    or length(trim(coalesce("revocation_reason", ''))) between 1 and 500
  );
