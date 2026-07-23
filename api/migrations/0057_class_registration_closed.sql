alter table "class"
add column if not exists "registration_closed" boolean not null default false;
