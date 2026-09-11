alter table "document"
  drop constraint if exists "document_status_check";

alter table "document"
  add constraint "document_status_check"
  check ("status" in ('generated', 'failed', 'superseded'));
