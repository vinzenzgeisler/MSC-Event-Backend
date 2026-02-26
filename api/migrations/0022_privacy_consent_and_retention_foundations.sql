alter table "person"
  add column if not exists "processing_restricted" boolean not null default false,
  add column if not exists "objection_flag" boolean not null default false;

create table if not exists "consent_evidence" (
  "id" uuid primary key default gen_random_uuid(),
  "entry_id" uuid not null references "entry"("id") on delete cascade,
  "consent_version" text not null,
  "consent_text_hash" text not null,
  "locale" text not null,
  "consent_source" text not null,
  "terms_accepted" boolean not null default true,
  "privacy_accepted" boolean not null default true,
  "media_accepted" boolean not null default false,
  "guardian_full_name" text,
  "guardian_email" text,
  "guardian_phone" text,
  "guardian_consent_accepted" boolean not null default false,
  "captured_at" timestamptz not null,
  "is_legacy" boolean not null default false,
  "created_at" timestamptz not null default now(),
  constraint "consent_evidence_source_check" check ("consent_source" in ('public_form', 'admin_ui'))
);

alter table "consent_evidence"
  add column if not exists "guardian_full_name" text,
  add column if not exists "guardian_email" text,
  add column if not exists "guardian_phone" text,
  add column if not exists "guardian_consent_accepted" boolean not null default false;

create index if not exists "consent_evidence_entry_idx"
  on "consent_evidence" ("entry_id", "created_at");

create table if not exists "data_subject_request" (
  "id" uuid primary key default gen_random_uuid(),
  "request_type" text not null,
  "subject_email_norm" text,
  "subject_person_id" uuid references "person"("id") on delete set null,
  "status" text not null default 'open',
  "received_at" timestamptz not null default now(),
  "due_at" timestamptz,
  "closed_at" timestamptz,
  "identity_level" text not null default 'medium',
  "handled_by" text,
  "legal_basis_decision" text,
  "actions_taken" text,
  "response_channel" text,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  constraint "data_subject_request_type_check" check ("request_type" in ('access', 'rectification', 'erasure', 'restriction', 'objection', 'portability')),
  constraint "data_subject_request_status_check" check ("status" in ('open', 'in_progress', 'closed', 'rejected')),
  constraint "data_subject_request_identity_check" check ("identity_level" in ('low', 'medium', 'high'))
);

create index if not exists "data_subject_request_subject_email_idx"
  on "data_subject_request" ("subject_email_norm", "created_at");

create index if not exists "data_subject_request_status_idx"
  on "data_subject_request" ("status", "received_at");

insert into "consent_evidence" (
  "entry_id",
  "consent_version",
  "consent_text_hash",
  "locale",
  "consent_source",
  "terms_accepted",
  "privacy_accepted",
  "media_accepted",
  "captured_at",
  "is_legacy",
  "created_at"
)
select
  e."id",
  coalesce(e."consent_version", 'legacy-unknown'),
  'legacy-no-hash',
  'de-DE',
  'public_form',
  coalesce(e."consent_terms_accepted", false),
  coalesce(e."consent_privacy_accepted", false),
  coalesce(e."consent_media_accepted", false),
  coalesce(e."consent_captured_at", e."created_at", now()),
  true,
  now()
from "entry" e
where not exists (
  select 1 from "consent_evidence" ce where ce."entry_id" = e."id"
);
