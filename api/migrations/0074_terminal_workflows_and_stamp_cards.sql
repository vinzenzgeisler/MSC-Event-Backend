alter table "event"
  add column if not exists "stamp_card_accent_color" text not null default '#0F6B65';

update "event"
set "stamp_card_accent_color" = case extract(year from "starts_at")::int
  when 2025 then '#365F91'
  when 2026 then '#0F6B65'
  when 2027 then '#8B1E3F'
  when 2028 then '#2F6B3C'
  when 2029 then '#6B4E9B'
  else '#244A78'
end;

alter table "event"
  drop constraint if exists "event_stamp_card_accent_color_check";
alter table "event"
  add constraint "event_stamp_card_accent_color_check"
  check ("stamp_card_accent_color" ~ '^#[0-9A-Fa-f]{6}$');

alter table "signing_session"
  add column if not exists "workflow_type" text not null default 'waiver_signature',
  add column if not exists "workflow_stage" text not null default 'ready_to_sign',
  add column if not exists "draft_payload" jsonb,
  add column if not exists "result_payload" jsonb,
  add column if not exists "submitted_at" timestamptz,
  add column if not exists "approved_at" timestamptz;

alter table "signing_session"
  drop constraint if exists "signing_session_workflow_type_check";
alter table "signing_session"
  add constraint "signing_session_workflow_type_check"
  check ("workflow_type" in ('waiver_signature', 'regular_codriver_registration', 'charity_codriver_registration'));

alter table "signing_session"
  drop constraint if exists "signing_session_workflow_stage_check";
alter table "signing_session"
  add constraint "signing_session_workflow_stage_check"
  check ("workflow_stage" in ('collecting_data', 'awaiting_operator_approval', 'ready_to_sign', 'completed', 'cancelled', 'failed'));

create table if not exists "entry_charity_codriver" (
  "id" uuid primary key default gen_random_uuid(),
  "event_id" uuid not null references "event"("id") on delete cascade,
  "entry_id" uuid not null references "entry"("id") on delete cascade,
  "person_id" uuid not null references "person"("id"),
  "terminal_session_id" uuid references "signing_session"("id") on delete set null,
  "status" text not null default 'active',
  "created_by" text,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  constraint "entry_charity_codriver_status_check" check ("status" in ('active', 'revoked'))
);

create unique index if not exists "entry_charity_codriver_active_unique"
  on "entry_charity_codriver" ("event_id", "entry_id", "person_id")
  where "status" = 'active';
create index if not exists "entry_charity_codriver_entry_idx"
  on "entry_charity_codriver" ("entry_id", "status", "created_at");

create table if not exists "codriver_invitation" (
  "id" uuid primary key default gen_random_uuid(),
  "event_id" uuid not null references "event"("id") on delete cascade,
  "source_entry_id" uuid not null references "entry"("id") on delete cascade,
  "entry_ids" uuid[] not null,
  "token_hash" text not null,
  "recipient_name" text,
  "recipient_email_norm" text,
  "expires_at" timestamptz not null,
  "revoked_at" timestamptz,
  "revoked_by" text,
  "consumed_at" timestamptz,
  "codriver_person_id" uuid references "person"("id") on delete set null,
  "created_by" text,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  constraint "codriver_invitation_entry_ids_not_empty_check" check (cardinality("entry_ids") > 0)
);
create unique index if not exists "codriver_invitation_token_hash_unique" on "codriver_invitation" ("token_hash");
create index if not exists "codriver_invitation_source_entry_idx" on "codriver_invitation" ("source_entry_id", "created_at");

alter table "consent_evidence"
  add column if not exists "person_id" uuid references "person"("id") on delete set null,
  add column if not exists "participant_role" text,
  add column if not exists "terminal_session_id" uuid references "signing_session"("id") on delete set null,
  add column if not exists "guardian_relationship" text;

update "consent_evidence" ce
set "person_id" = e."driver_person_id",
    "participant_role" = coalesce(ce."participant_role", 'driver')
from "entry" e
where ce."entry_id" = e."id"
  and (ce."person_id" is null or ce."participant_role" is null);

alter table "consent_evidence"
  drop constraint if exists "consent_evidence_participant_role_check";
alter table "consent_evidence"
  add constraint "consent_evidence_participant_role_check"
  check ("participant_role" is null or "participant_role" in ('driver', 'codriver', 'charity_codriver'));

create index if not exists "consent_evidence_person_event_idx"
  on "consent_evidence" ("person_id", "captured_at");
