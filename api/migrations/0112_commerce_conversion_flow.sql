-- RacePic Commerce (AP04/AP08/AP09): Felder fuer den FREE->PAID-Antragsfluss.

-- Pro Bild darf hoechstens ein offener Antrag existieren (partieller Unique-Index ueber is_open).
alter table "racepic_offer_conversion_item"
  add column if not exists "is_open" boolean not null default true,
  add column if not exists "attempt_count" integer not null default 0,
  add column if not exists "lease_expires_at" timestamptz,
  add column if not exists "licensed_full_key" text,
  add column if not exists "watermarked_thumb_key" text,
  add column if not exists "watermarked_preview_key" text,
  add column if not exists "licensed_width" integer,
  add column if not exists "licensed_height" integer,
  add column if not exists "licensed_bytes" bigint;

create unique index if not exists "racepic_offer_conversion_item_open_image_unique"
  on "racepic_offer_conversion_item" ("image_id") where "is_open";

-- Abschluss der oeffentlichen Objekt-Umstellung (alte FREE-Objekte entfernt, Manifeste neu, CDN invalidiert).
alter table "racepic_offer_conversion"
  add column if not exists "finalized_at" timestamptz,
  add column if not exists "request_fingerprint" text;
