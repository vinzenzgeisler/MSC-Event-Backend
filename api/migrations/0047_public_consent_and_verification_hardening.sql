alter table "consent_evidence"
  add column if not exists "waiver_accepted" boolean not null default false;

alter table "consent_evidence"
  add column if not exists "club_info_accepted" boolean not null default false;
