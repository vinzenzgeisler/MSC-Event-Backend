alter table if exists "person"
  add column if not exists "processing_restricted" boolean not null default false;

alter table if exists "person"
  add column if not exists "objection_flag" boolean not null default false;
