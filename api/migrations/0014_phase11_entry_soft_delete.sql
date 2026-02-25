alter table entry
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by text,
  add column if not exists delete_reason text;

drop index if exists entry_start_number_unique;
create unique index if not exists entry_start_number_unique
  on entry (event_id, class_id, start_number_norm)
  where start_number_norm is not null and deleted_at is null;
