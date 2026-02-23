alter table "entry"
  add column if not exists "internal_note" text,
  add column if not exists "driver_note" text,
  add column if not exists "confirmation_mail_sent_at" timestamptz,
  add column if not exists "confirmation_mail_verified_at" timestamptz;

update "entry" e
set "confirmation_mail_verified_at" = v."verified_at"
from "entry_email_verification" v
where v."entry_id" = e."id"
  and v."verified_at" is not null
  and e."confirmation_mail_verified_at" is null;
