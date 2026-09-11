alter table event_hub_candidate_override
  add column if not exists featured boolean not null default false;

create table if not exists event_auction (
  event_id uuid primary key references event(id) on delete cascade,
  status text not null default 'draft',
  title_i18n jsonb not null default '{}',
  description_i18n jsonb not null default '{}',
  terms_i18n jsonb not null default '{}',
  image_url text,
  video_url text,
  starting_bid_cents integer not null default 0,
  min_increment_cents integer not null default 1000,
  closed_at timestamptz,
  winner_bid_id uuid,
  updated_at timestamptz not null default now(),
  updated_by text,
  constraint event_auction_status_check check (status in ('draft', 'open', 'closed')),
  constraint event_auction_amounts_check check (starting_bid_cents >= 0 and min_increment_cents > 0)
);

create table if not exists event_auction_bid (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references event(id) on delete cascade,
  bidder_name text not null,
  contact_type text not null,
  contact_value text not null,
  amount_cents integer not null,
  status text not null default 'valid',
  terms_version text not null,
  accepted_terms_at timestamptz not null,
  client_submission_key uuid not null unique,
  admin_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_auction_bid_contact_check check (contact_type in ('email', 'phone')),
  constraint event_auction_bid_status_check check (status in ('valid', 'invalid')),
  constraint event_auction_bid_amount_check check (amount_cents > 0)
);

create index if not exists event_auction_bid_ranking_idx
  on event_auction_bid(event_id, status, amount_cents desc, created_at asc);

alter table event_auction
  add constraint event_auction_winner_bid_fk
  foreign key (winner_bid_id) references event_auction_bid(id) on delete set null;
