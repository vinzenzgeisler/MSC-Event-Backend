alter table if exists "email_template_version"
  add column if not exists "status" text not null default 'published',
  add column if not exists "updated_at" timestamptz not null default now(),
  add column if not exists "updated_by" text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'email_template_version_status_check'
  ) then
    alter table "email_template_version"
      add constraint "email_template_version_status_check"
      check ("status" in ('draft', 'published'));
  end if;
end $$;
