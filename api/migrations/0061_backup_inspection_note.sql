alter table entry
  add column if not exists backup_inspection_note text;

update entry e
set backup_inspection_note = (
  select d.note
  from technical_inspection_decision d
  where d.entry_id = e.id
    and d.target = 'backup'
  order by d.created_at desc
  limit 1
)
where exists (
  select 1
  from technical_inspection_decision d
  where d.entry_id = e.id
    and d.target = 'backup'
);

update entry e
set inspection_note = (
  select d.note
  from technical_inspection_decision d
  where d.entry_id = e.id
    and d.target = 'primary'
  order by d.created_at desc
  limit 1
)
where exists (
  select 1
  from technical_inspection_decision d
  where d.entry_id = e.id
    and d.target = 'primary'
);
