alter table "entry"
  add column if not exists "orga_code" text;

create index if not exists "entry_orga_code_idx" on "entry" ("orga_code");

with existing_codes as (
  select
    e.id,
    case
      when coalesce(nullif(trim(ev.entry_confirmation_config->>'orgaCodePrefix'), ''), '') <> ''
        then trim(ev.entry_confirmation_config->>'orgaCodePrefix') || '-' || upper(substr(md5(e.event_id::text || ':' || e.driver_person_id::text), 1, 6))
      else upper(substr(md5(e.event_id::text || ':' || e.driver_person_id::text), 1, 6))
    end as generated_code
  from "entry" e
  join "event" ev on ev.id = e.event_id
  where e.orga_code is null
)
update "entry" e
set orga_code = existing_codes.generated_code
from existing_codes
where e.id = existing_codes.id;
