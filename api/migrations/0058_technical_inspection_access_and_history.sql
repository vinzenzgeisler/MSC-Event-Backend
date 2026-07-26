create table if not exists "technical_inspector_assignment" (
  "id" uuid primary key default gen_random_uuid(),
  "event_id" uuid not null references "event"("id") on delete cascade,
  "user_email_norm" text not null,
  "valid_from" timestamptz not null,
  "valid_until" timestamptz not null,
  "created_by" text,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  constraint "technical_inspector_assignment_validity_check" check ("valid_until" > "valid_from")
);

create unique index if not exists "technical_inspector_assignment_user_event_unique"
  on "technical_inspector_assignment" ("user_email_norm", "event_id");

create index if not exists "technical_inspector_assignment_event_validity_idx"
  on "technical_inspector_assignment" ("event_id", "valid_from", "valid_until");

create table if not exists "technical_inspection_decision" (
  "id" uuid primary key default gen_random_uuid(),
  "event_id" uuid not null references "event"("id") on delete cascade,
  "entry_id" uuid not null references "entry"("id") on delete cascade,
  "status" text not null,
  "note" text,
  "inspector_user_id" text not null,
  "inspector_email" text,
  "created_at" timestamptz not null default now(),
  constraint "technical_inspection_decision_status_check" check ("status" in ('pending', 'passed', 'failed')),
  constraint "technical_inspection_decision_failed_note_check"
    check ("status" != 'failed' or length(trim(coalesce("note", ''))) > 0)
);

create index if not exists "technical_inspection_decision_entry_created_idx"
  on "technical_inspection_decision" ("entry_id", "created_at");
