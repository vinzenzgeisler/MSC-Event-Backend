alter table "document"
  drop constraint if exists "document_type_check";

alter table "document"
  add constraint "document_type_check"
  check ("type" in ('waiver', 'tech_check', 'waiver_batch', 'tech_check_batch', 'entry_confirmation'));

alter table "email_outbox_attachment"
  drop constraint if exists "email_outbox_attachment_source_check";

alter table "email_outbox_attachment"
  add constraint "email_outbox_attachment_source_check"
  check ("source" in ('upload', 'system', 'document'));

create index if not exists "document_entry_confirmation_revision_idx"
  on "document" ("entry_id", "template_variant", "created_at")
  where "type" = 'entry_confirmation';
