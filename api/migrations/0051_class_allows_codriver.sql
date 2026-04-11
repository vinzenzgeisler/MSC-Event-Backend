alter table "class"
add column if not exists "allows_codriver" boolean not null default false;
