alter table "entry"
  add column if not exists "backup_tech_status" text not null default 'pending',
  add column if not exists "backup_tech_checked_at" timestamptz,
  add column if not exists "backup_tech_checked_by" text;

alter table "entry"
  drop constraint if exists "entry_backup_tech_status_check";

alter table "entry"
  add constraint "entry_backup_tech_status_check"
  check ("backup_tech_status" in ('pending', 'passed', 'failed'));

alter table "technical_inspection_decision"
  add column if not exists "target" text not null default 'primary';

alter table "technical_inspection_decision"
  drop constraint if exists "technical_inspection_decision_target_check";

alter table "technical_inspection_decision"
  add constraint "technical_inspection_decision_target_check"
  check ("target" in ('primary', 'backup'));

create index if not exists "technical_inspection_decision_entry_target_created_idx"
  on "technical_inspection_decision" ("entry_id", "target", "created_at");
