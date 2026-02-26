alter table "entry"
  add column if not exists "driver_email_norm" text;

update "entry" e
set "driver_email_norm" = lower(trim(p."email"))
from "person" p
where e."driver_person_id" = p."id"
  and p."email" is not null
  and e."driver_email_norm" is null;

with ranked as (
  select
    e."id",
    row_number() over (
      partition by e."event_id", e."driver_email_norm"
      order by e."created_at" asc, e."id" asc
    ) as rn
  from "entry" e
  where e."deleted_at" is null
    and e."driver_email_norm" is not null
)
update "entry" e
set "driver_email_norm" = null
from ranked r
where e."id" = r."id"
  and r.rn > 1;

create unique index if not exists "entry_event_driver_email_active_unique"
  on "entry" ("event_id", "driver_email_norm")
  where "driver_email_norm" is not null and "deleted_at" is null;
