create or replace function to_base36(input_value bigint)
returns text
language plpgsql
immutable
as $$
declare
  alphabet text := '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  value bigint := input_value;
  output text := '';
begin
  if value = 0 then
    return '0';
  end if;

  while value > 0 loop
    output := substr(alphabet, (value % 36)::int + 1, 1) || output;
    value := value / 36;
  end loop;

  return output;
end;
$$;

with recalculated as (
  select
    e.id,
    case
      when coalesce(nullif(trim(ev.entry_confirmation_config->>'orgaCodePrefix'), ''), '') <> ''
        then trim(ev.entry_confirmation_config->>'orgaCodePrefix') || '-' ||
          lpad(
            to_base36((('x' || substr(md5(e.event_id::text || ':' || e.driver_person_id::text), 1, 10))::bit(40)::bigint % 60466176)),
            5,
            '0'
          )
      else
        lpad(
          to_base36((('x' || substr(md5(e.event_id::text || ':' || e.driver_person_id::text), 1, 10))::bit(40)::bigint % 60466176)),
          5,
          '0'
        )
    end as generated_code
  from "entry" e
  join "event" ev on ev.id = e.event_id
)
update "entry" e
set orga_code = recalculated.generated_code
from recalculated
where e.id = recalculated.id
  and coalesce(e.orga_code, '') <> recalculated.generated_code;

drop function if exists to_base36(bigint);
