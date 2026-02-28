with latest_entry_tokens as (
  select distinct on (e."registration_group_id")
    e."registration_group_id" as registration_group_id,
    ev."token" as token,
    ev."expires_at" as expires_at,
    ev."verified_at" as verified_at,
    ev."created_at" as created_at
  from "entry_email_verification" ev
  inner join "entry" e on e."id" = ev."entry_id"
  where e."registration_group_id" is not null
  order by e."registration_group_id", ev."created_at" desc
)
insert into "registration_group_email_verification" (
  "id",
  "registration_group_id",
  "token",
  "expires_at",
  "verified_at",
  "created_at"
)
select
  gen_random_uuid(),
  t.registration_group_id,
  t.token,
  t.expires_at,
  t.verified_at,
  t.created_at
from latest_entry_tokens t
on conflict ("registration_group_id") do update
set
  "token" = excluded."token",
  "expires_at" = excluded."expires_at",
  "verified_at" = coalesce("registration_group_email_verification"."verified_at", excluded."verified_at"),
  "created_at" = greatest("registration_group_email_verification"."created_at", excluded."created_at");
