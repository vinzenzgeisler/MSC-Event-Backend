alter table "entry"
  add column if not exists "deleted_by_display" text;

update "entry"
set "deleted_by_display" = "deleted_by"
where "deleted_by_display" is null
  and "deleted_by" is not null
  and position('@' in "deleted_by") > 0;
