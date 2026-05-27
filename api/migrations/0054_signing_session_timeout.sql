alter table "signing_session"
  add column if not exists "expires_at" timestamptz;

update "signing_session"
  set "expires_at" = coalesce("expires_at", "created_at" + interval '5 minutes')
  where "expires_at" is null;

alter table "signing_session"
  alter column "expires_at" set not null;

create index if not exists "signing_session_status_expires_idx"
  on "signing_session" ("status", "expires_at");
