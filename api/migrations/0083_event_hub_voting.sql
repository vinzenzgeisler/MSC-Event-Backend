-- Event-Hub voting, public candidate curation, and durable result snapshots.
create table if not exists "event_hub_config" (
  "event_id" uuid primary key references "event"("id") on delete cascade,
  "voting_opens_at" timestamptz,
  "voting_closes_at" timestamptz,
  "voting_mode" text not null default 'auto',
  "venue_lat" text,
  "venue_lng" text,
  "updated_at" timestamptz not null default now(),
  "updated_by" text,
  constraint "event_hub_config_voting_mode_check" check ("voting_mode" in ('auto', 'forced_open', 'forced_closed'))
);

create table if not exists "event_hub_candidate_override" (
  "event_id" uuid not null references "event"("id") on delete cascade,
  "entry_id" uuid not null references "entry"("id") on delete cascade,
  "state" text not null default 'auto',
  "updated_at" timestamptz not null default now(),
  "updated_by" text,
  primary key ("event_id", "entry_id"),
  constraint "event_hub_candidate_override_state_check" check ("state" in ('auto', 'pinned', 'hidden'))
);

create table if not exists "event_vote_challenge" (
  "id" uuid primary key default gen_random_uuid(),
  "event_id" uuid not null references "event"("id") on delete cascade,
  "nonce_hash" text not null,
  "expires_at" timestamptz not null,
  "used_at" timestamptz,
  "created_at" timestamptz not null default now()
);

create index if not exists "event_vote_challenge_expiry_idx" on "event_vote_challenge" ("expires_at");

create table if not exists "event_vote" (
  "id" uuid primary key default gen_random_uuid(),
  "event_id" uuid not null references "event"("id") on delete cascade,
  "class_id" uuid not null references "class"("id") on delete cascade,
  "entry_id" uuid not null references "entry"("id") on delete cascade,
  "voter_key_hash" text not null,
  "client_submission_key" uuid not null,
  "created_at" timestamptz not null default now(),
  constraint "event_vote_event_class_voter_unique" unique ("event_id", "class_id", "voter_key_hash"),
  constraint "event_vote_submission_unique" unique ("client_submission_key")
);

create index if not exists "event_vote_event_class_idx" on "event_vote" ("event_id", "class_id", "created_at");

create table if not exists "event_vote_result_snapshot" (
  "event_id" uuid not null references "event"("id") on delete cascade,
  "class_id" uuid not null references "class"("id") on delete cascade,
  "entry_id" uuid not null references "entry"("id") on delete cascade,
  "vote_count" integer not null,
  "captured_at" timestamptz not null default now(),
  primary key ("event_id", "class_id", "entry_id")
);

-- Current-event defaults: live opening on Saturday and automatic evaluation on
-- Sunday morning. Future events are configured from the admin UI.
insert into "event_hub_config" ("event_id", "voting_opens_at", "voting_closes_at", "venue_lat", "venue_lng")
select "id", '2026-09-12T05:00:00Z'::timestamptz, '2026-09-13T05:00:00Z'::timestamptz, '50.86', '14.68'
from "event"
where "is_current" = true and "starts_at" = '2026-09-12'
on conflict ("event_id") do nothing;
