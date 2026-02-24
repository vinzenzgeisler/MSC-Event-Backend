alter table event
  add column if not exists contact_email text,
  add column if not exists website_url text;

alter table person
  add column if not exists emergency_contact_first_name text,
  add column if not exists emergency_contact_last_name text;

update person
set
  emergency_contact_first_name = split_part(trim(emergency_contact_name), ' ', 1),
  emergency_contact_last_name = nullif(
    trim(substr(trim(emergency_contact_name), length(split_part(trim(emergency_contact_name), ' ', 1)) + 1)),
    ''
  )
where
  emergency_contact_name is not null
  and trim(emergency_contact_name) <> ''
  and (emergency_contact_first_name is null or emergency_contact_last_name is null);
