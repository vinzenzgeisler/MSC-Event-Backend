-- RacePic Commerce (AP12): konfigurierbare Steuer-/Provisionsparameter als unveraenderliche Versionen.
-- Das Steuermodell ist bewusst offen (siehe docs/memory-bank/racepic-open-items.md "Offene Steuerentscheidungen"):
-- Steuersatz, Bezugsgroesse der Fotografen-Provision, Steuersatz der Fotografen und Kuenstlersozialabgabe sind
-- Einstellungen, keine Konstanten. Ohne Verkaufssteuersatz (NULL) lehnt der Quote-Dienst jeden Preis ab.
-- Jede Aenderung erzeugt eine neue Version; Quotes und Bestellungen halten ihre Version fest.

create table if not exists "commerce_settings_version" (
  "id" uuid primary key default gen_random_uuid(),
  "version" integer not null,
  -- Umsatzsteuersatz des MSC auf den Verkauf in Basispunkten (1900 = 19 %); NULL = noch nicht entschieden.
  "sale_tax_rate_bp" integer,
  -- MSC-Provision in Basispunkten (2000 = 20 %); der Fotograf erhaelt den Rest.
  "commission_bp" integer not null default 2000,
  -- Bezugsgroesse des Fotografenanteils: NET (80 % vom Netto, Umsatzsteuer des Fotografen kommt hinzu) oder
  -- GROSS (80 % vom Brutto, Umsatzsteuer des Fotografen ist enthalten).
  "seller_share_basis" text not null default 'NET',
  -- Umsatzsteuersatz eines regelbesteuerten Fotografen in der Gutschrift; NULL = wie beim Verkauf.
  "seller_vat_rate_bp" integer,
  -- Kuenstlersozialabgabe auf den Fotografenanteil in Basispunkten (490 = 4,9 %); reine Kostenposition des MSC.
  "artist_social_levy_bp" integer not null default 0,
  "note" text,
  "created_by" text not null,
  "created_at" timestamptz not null default now(),
  constraint "commerce_settings_version_unique" unique ("version"),
  constraint "commerce_settings_sale_tax_check" check ("sale_tax_rate_bp" is null or "sale_tax_rate_bp" between 0 and 3000),
  constraint "commerce_settings_commission_check" check ("commission_bp" between 0 and 10000),
  constraint "commerce_settings_basis_check" check ("seller_share_basis" in ('NET', 'GROSS')),
  constraint "commerce_settings_seller_vat_check" check ("seller_vat_rate_bp" is null or "seller_vat_rate_bp" between 0 and 3000),
  constraint "commerce_settings_levy_check" check ("artist_social_levy_bp" between 0 and 1000)
);

create or replace function "commerce_settings_version_immutable"() returns trigger as $$
begin
  raise exception 'commerce_settings_version ist unveraenderlich; neue Version anlegen';
end;
$$ language plpgsql;
drop trigger if exists "commerce_settings_version_immutable_trg" on "commerce_settings_version";
create trigger "commerce_settings_version_immutable_trg"
  before update or delete on "commerce_settings_version"
  for each row execute function "commerce_settings_version_immutable"();

-- Startversion: 20 % Provision, Bezug auf Netto, Steuersatz offen.
insert into "commerce_settings_version" ("version", "sale_tax_rate_bp", "commission_bp", "seller_share_basis", "created_by", "note")
select 1, null, 2000, 'NET', 'migration:0114', 'Startwerte; Steuersatz noch nicht entschieden'
where not exists (select 1 from "commerce_settings_version");

alter table "commerce_quote"
  add column if not exists "settings_version_id" uuid references "commerce_settings_version"("id") on delete restrict;

-- Bezugsgroesse des gespeicherten Fotografenanteils je Position (NET oder GROSS), damit spaetere Gutschriften nachvollziehbar sind.
alter table "commerce_order_item"
  add column if not exists "seller_share_basis" text,
  add column if not exists "settings_version_id" uuid references "commerce_settings_version"("id") on delete restrict,
  add column if not exists "tax_rate_bp" integer;
