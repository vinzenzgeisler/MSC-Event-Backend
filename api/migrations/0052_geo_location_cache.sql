create table if not exists "geo_location_cache" (
  "location_key" text primary key,
  "country" text,
  "zip" text,
  "city" text,
  "lat" text not null,
  "lng" text not null,
  "source" text not null default 'manual',
  "status" text not null default 'resolved',
  "updated_at" timestamptz not null default now(),
  constraint "geo_location_cache_status_check" check ("status" in ('resolved', 'disabled'))
);

create index if not exists "geo_location_cache_country_city_idx"
  on "geo_location_cache" ("country", "city");
