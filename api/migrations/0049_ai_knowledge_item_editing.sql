alter table "ai_knowledge_item"
  add column if not exists "updated_by" text;

alter table "ai_knowledge_item"
  add column if not exists "archived_by" text;

alter table "ai_knowledge_item"
  add column if not exists "archived_at" timestamptz;
