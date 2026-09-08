alter table "person"
  add column if not exists "publication_name" text,
  add column if not exists "publication_name_version" integer not null default 0,
  add column if not exists "publication_name_updated_at" timestamptz,
  add column if not exists "publication_name_updated_by" text;

alter table "person"
  drop constraint if exists "person_publication_name_valid_check";
alter table "person"
  add constraint "person_publication_name_valid_check"
  check (
    "publication_name" is null
    or (
      length(btrim("publication_name")) between 1 and 100
      and "publication_name" !~ '[[:cntrl:]]'
      and lower(regexp_replace(btrim("publication_name"), '[[:space:]]+', ' ', 'g'))
        <> lower(regexp_replace(btrim("first_name") || ' ' || btrim("last_name"), '[[:space:]]+', ' ', 'g'))
    )
  );

alter table "export_job" drop constraint if exists "export_job_type_check";
alter table "export_job" add constraint "export_job_type_check"
  check ("type" in (
    'entries_csv',
    'startlist_csv',
    'participants_csv',
    'payments_open_csv',
    'checkin_status_csv',
    'programmheft_xlsx',
    'stamp_cards_pdf'
  ));

alter table "export_job" drop constraint if exists "export_job_status_check";
alter table "export_job" add constraint "export_job_status_check"
  check ("status" in ('queued', 'processing', 'succeeded', 'failed', 'invalidated'));

create table if not exists "export_job_person" (
  "export_job_id" uuid not null references "export_job"("id") on delete cascade,
  "person_id" uuid not null references "person"("id") on delete cascade,
  "publication_name_version" integer not null,
  constraint "export_job_person_unique" unique ("export_job_id", "person_id")
);

create index if not exists "export_job_person_person_idx"
  on "export_job_person" ("person_id", "export_job_id");

-- Legacy jobs did not record their exact subject set. Associate every participant
-- in the event so that a later protection change invalidates conservatively.
insert into "export_job_person" ("export_job_id", "person_id", "publication_name_version")
select distinct j."id", participant."person_id", p."publication_name_version"
from "export_job" j
join lateral (
  select e."driver_person_id" as "person_id"
  from "entry" e
  where e."event_id" = j."event_id"
  union
  select e."codriver_person_id"
  from "entry" e
  where e."event_id" = j."event_id" and e."codriver_person_id" is not null
  union
  select ecc."person_id"
  from "entry_charity_codriver" ecc
  where ecc."event_id" = j."event_id"
) participant on true
join "person" p on p."id" = participant."person_id"
on conflict ("export_job_id", "person_id") do nothing;
