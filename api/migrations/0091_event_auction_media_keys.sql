alter table event_auction
  add column if not exists image_s3_key text,
  add column if not exists video_s3_key text;
