ALTER TABLE racepic_image ADD COLUMN IF NOT EXISTS title text;
ALTER TABLE racepic_image ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE racepic_image ADD COLUMN IF NOT EXISTS tags jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE racepic_image ADD COLUMN IF NOT EXISTS price_cents integer;
ALTER TABLE racepic_image ADD CONSTRAINT racepic_image_price_check CHECK (
  (offer_mode = 'FREE' AND price_cents IS NULL) OR
  (offer_mode = 'PAID' AND price_cents IS NOT NULL AND price_cents > 0)
);

INSERT INTO racepic_license
  (code, version, title, summary, terms, private_use, social_media, editorial, commercial, attribution_required, pricing_kind)
VALUES (
  'PAID_PRIVATE', 1,
  '{"de":"Private Nutzung – Entwurf","en":"Private use – draft","cz":"Soukromé použití – návrh","pl":"Użytek prywatny – projekt"}'::jsonb,
  '{"de":"Kostenpflichtige private Nutzung; noch nicht käuflich.","en":"Paid private use; purchasing is not available yet.","cz":"Placené soukromé použití; nákup zatím není dostupný.","pl":"Płatny użytek prywatny; zakup nie jest jeszcze dostępny."}'::jsonb,
  '{"de":"Entwurf für interne Tests. Vor einem Verkauf rechtlich freizugeben.","en":"Draft for internal testing. Legal approval is required before sales.","cz":"Návrh pro interní testování. Před prodejem je nutné právní schválení.","pl":"Projekt do testów wewnętrznych. Przed sprzedażą wymagana jest akceptacja prawna."}'::jsonb,
  true, false, false, false, false, 'PAID'
) ON CONFLICT (code, version) DO NOTHING;

ALTER TABLE racepic_photographer DROP CONSTRAINT IF EXISTS racepic_photographer_status_check;
ALTER TABLE racepic_photographer ADD CONSTRAINT racepic_photographer_status_check CHECK (
  status IN ('INVITED','PENDING_APPROVAL','ACTIVE_FREE','PAYMENT_ONBOARDING_REQUIRED','PAYMENT_ONBOARDING_PENDING','PAYMENT_ENABLED','PAYMENT_RESTRICTED','PAYMENT_DISABLED','DISABLED')
);
