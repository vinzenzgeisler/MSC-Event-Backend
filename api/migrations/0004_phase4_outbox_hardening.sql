alter table "email_outbox"
  add column if not exists "template_version" integer not null default 1;

alter table "email_outbox"
  add column if not exists "max_attempts" integer not null default 5;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_name = 'email_outbox'
      and column_name = 'last_error'
  ) then
    alter table "email_outbox" rename column "last_error" to "error_last";
  end if;
end $$;

alter table "email_outbox"
  alter column "error_last" drop not null;

update "email_outbox"
set "idempotency_key" = gen_random_uuid()::text
where "idempotency_key" is null;

alter table "email_outbox"
  alter column "idempotency_key" set not null;

alter table "email_delivery"
  drop constraint if exists "email_delivery_status_check";

alter table "email_delivery"
  add constraint "email_delivery_status_check"
  check ("status" in ('sent', 'failed', 'bounced', 'complaint'));
