create table if not exists registration_invitation (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references event(id) on delete cascade,
  token_hash text not null,
  recipient_name text,
  recipient_email_norm text,
  allowed_class_ids uuid[] not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_by text,
  consumed_at timestamptz,
  consumed_registration_group_id uuid references registration_group(id) on delete set null,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint registration_invitation_allowed_classes_not_empty_check check (cardinality(allowed_class_ids) > 0)
);

create unique index if not exists registration_invitation_token_hash_unique
  on registration_invitation(token_hash);

create index if not exists registration_invitation_event_idx
  on registration_invitation(event_id, created_at);

create index if not exists registration_invitation_expiry_idx
  on registration_invitation(expires_at);
