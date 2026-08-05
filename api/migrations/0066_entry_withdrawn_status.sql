alter table "entry"
  add column if not exists "withdrawn_reason" text,
  add column if not exists "withdrawn_at" timestamptz,
  add column if not exists "withdrawn_by" text;

alter table "entry" drop constraint if exists "entry_acceptance_status_check";
alter table "entry"
  add constraint "entry_acceptance_status_check"
  check ("acceptance_status" in ('pending', 'shortlist', 'accepted', 'rejected', 'withdrawn'));

drop index if exists "entry_start_number_unique";
create unique index if not exists "entry_start_number_unique"
  on "entry" ("event_id", "class_id", "start_number_norm")
  where "start_number_norm" is not null
    and "deleted_at" is null
    and "acceptance_status" <> 'withdrawn';

create temporary table if not exists withdrawn_backfill_candidates on commit drop as
select
  e.id,
  e.event_id,
  e.acceptance_status as previous_status,
  e.deleted_at,
  e.deleted_by,
  e.delete_reason
from "entry" e
inner join "event" ev on ev.id = e.event_id
where ev.is_current = true
  and e.deleted_at is not null
  and lower(regexp_replace(btrim(e.delete_reason), '[[:space:]]+', ' ', 'g')) in (
    'absage',
    'fahrzeug wurde vom fahrer verkauft'
  );

-- Reattach restored entries to the single matching registration group. Prefer an
-- already-active group; otherwise deterministically choose one deleted group.
update "entry" e
set "registration_group_id" = (
  select rg.id
  from "registration_group" rg
  inner join "person" p on p.id = e.driver_person_id
  where rg.event_id = e.event_id
    and rg.driver_email_norm = lower(btrim(p.email))
  order by (rg.deleted_at is null) desc, rg.created_at asc, rg.id asc
  limit 1
)
from withdrawn_backfill_candidates candidate
where e.id = candidate.id
  and exists (
    select 1
    from "registration_group" rg
    inner join "person" p on p.id = e.driver_person_id
    where rg.event_id = e.event_id
      and rg.driver_email_norm = lower(btrim(p.email))
  );

update "registration_group" rg
set deleted_at = null,
    updated_at = now()
where rg.deleted_at is not null
  and exists (
    select 1
    from "entry" e
    inner join withdrawn_backfill_candidates candidate on candidate.id = e.id
    where e.registration_group_id = rg.id
  )
  and not exists (
    select 1
    from "registration_group" active_rg
    where active_rg.event_id = rg.event_id
      and active_rg.driver_email_norm = rg.driver_email_norm
      and active_rg.deleted_at is null
      and active_rg.id <> rg.id
  );

insert into "audit_log" (event_id, actor_user_id, action, entity_type, entity_id, payload, created_at)
select
  candidate.event_id,
  coalesce(candidate.deleted_by, 'migration:0066_entry_withdrawn_status'),
  'entry_status_updated',
  'entry',
  candidate.id,
  jsonb_build_object(
    'from', candidate.previous_status,
    'to', 'withdrawn',
    'withdrawalReason', candidate.delete_reason,
    'withdrawnAt', candidate.deleted_at
  ),
  now()
from withdrawn_backfill_candidates candidate
where not exists (
  select 1
  from "audit_log" audit
  where audit.entity_type = 'entry'
    and audit.entity_id = candidate.id
    and audit.action = 'entry_status_updated'
    and audit.payload->>'to' = 'withdrawn'
    and audit.payload->>'withdrawalReason' = candidate.delete_reason
);

update "entry" e
set acceptance_status = 'withdrawn',
    withdrawn_reason = candidate.delete_reason,
    withdrawn_at = candidate.deleted_at,
    withdrawn_by = candidate.deleted_by,
    deleted_at = null,
    deleted_by = null,
    deleted_by_display = null,
    delete_reason = null,
    updated_at = now()
from withdrawn_backfill_candidates candidate
where e.id = candidate.id;

with olaf as (
  select id, event_id, acceptance_status
  from "entry"
  where id = '8c9ac8ec-a500-4e74-a296-f3fa540cc40b'::uuid
    and deleted_at is null
    and acceptance_status = 'rejected'
), audit_insert as (
  insert into "audit_log" (event_id, actor_user_id, action, entity_type, entity_id, payload, created_at)
  select
    event_id,
    'migration:0066_entry_withdrawn_status',
    'entry_status_updated',
    'entry',
    id,
    jsonb_build_object(
      'from', acceptance_status,
      'to', 'withdrawn',
      'withdrawalReason', 'Fahrerabsage: Olaf Rachner hat seine Teilnahme abgesagt.',
      'withdrawnAt', now()
    ),
    now()
  from olaf
  returning entity_id
)
update "entry" e
set acceptance_status = 'withdrawn',
    withdrawn_reason = 'Fahrerabsage: Olaf Rachner hat seine Teilnahme abgesagt.',
    withdrawn_at = now(),
    withdrawn_by = 'migration:0066_entry_withdrawn_status',
    updated_at = now()
where e.id in (select entity_id from audit_insert);
