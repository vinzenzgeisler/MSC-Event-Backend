create table if not exists "email_template" (
  "id" uuid primary key default gen_random_uuid(),
  "template_key" text not null,
  "description" text,
  "is_active" boolean not null default true,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now()
);

create unique index if not exists "email_template_key_unique"
  on "email_template" ("template_key");

create table if not exists "email_template_version" (
  "id" uuid primary key default gen_random_uuid(),
  "template_id" uuid not null references "email_template"("id") on delete cascade,
  "version" integer not null,
  "subject_template" text not null,
  "body_template" text not null,
  "created_by" text,
  "created_at" timestamptz not null default now()
);

create unique index if not exists "email_template_version_unique"
  on "email_template_version" ("template_id", "version");
