create table if not exists marshal_import_repair_snapshot (
  id uuid primary key default gen_random_uuid(),
  repair_key text not null,
  source_workbook_sha256 text not null,
  person_id uuid not null references marshal_person(id) on delete cascade,
  event_id uuid references event(id) on delete set null,
  before_data jsonb not null,
  after_data jsonb not null,
  applied_fields text[] not null,
  created_by text,
  created_at timestamptz not null default now(),
  constraint marshal_import_repair_snapshot_repair_person_unique unique(repair_key, person_id),
  constraint marshal_import_repair_snapshot_hash_check check(source_workbook_sha256 ~ '^[a-f0-9]{64}$'),
  constraint marshal_import_repair_snapshot_fields_check check(cardinality(applied_fields) > 0)
);

create index if not exists marshal_import_repair_snapshot_event_idx
  on marshal_import_repair_snapshot(event_id, created_at);

comment on table marshal_import_repair_snapshot is
  'Reversible before/after snapshots for reviewed marshal import data repairs.';
