alter table "vehicle_image_upload"
  add column if not exists "upload_token_hash" text,
  add column if not exists "consumed_at" timestamptz,
  add column if not exists "consumed_by_registration_group_id" uuid references "registration_group"("id") on delete set null;

update "vehicle_image_upload"
set "upload_token_hash" = coalesce("upload_token_hash", '')
where "upload_token_hash" is null;

alter table "vehicle_image_upload"
  alter column "upload_token_hash" set not null;
