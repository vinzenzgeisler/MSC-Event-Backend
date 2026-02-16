alter table "document"
  add column if not exists "template_variant" text;

alter table "document"
  drop constraint if exists "document_template_variant_check";

alter table "document"
  add constraint "document_template_variant_check"
  check ("type" != 'tech_check' or "template_variant" in ('auto', 'moto'));

create index if not exists "document_entry_type_variant_idx"
  on "document" ("entry_id", "type", "template_variant", "created_at");
