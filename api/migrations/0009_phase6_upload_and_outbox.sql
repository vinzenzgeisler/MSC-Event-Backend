create table if not exists "vehicle_image_upload" (
  "id" uuid primary key default gen_random_uuid(),
  "event_id" uuid not null references "event"("id") on delete cascade,
  "s3_key" text not null,
  "content_type" text not null,
  "file_name" text,
  "file_size_bytes" integer not null,
  "status" text not null default 'initiated',
  "expires_at" timestamptz not null,
  "finalized_at" timestamptz,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  constraint "vehicle_image_upload_status_check" check ("status" in ('initiated', 'finalized', 'expired'))
);

create index if not exists "vehicle_image_upload_status_expires_idx"
  on "vehicle_image_upload" ("status", "expires_at");

