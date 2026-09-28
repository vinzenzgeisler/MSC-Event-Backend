-- RacePic Commerce (AP03): Bestandsmigration. Idempotent (mehrfach ausfuehrbar).
-- Jeder Fotograf erhaelt einen Seller, jedes nicht entfernte Bild ein Produkt, jedes FREE-Bild eine aktive
-- kostenlose Angebotsversion. racepic_image.price_cents bleibt bestehen, ist aber nicht mehr die
-- kaufrechtliche Quelle (siehe Plan Abschnitt 3.3).

insert into "commerce_seller" ("kind", "display_name", "status", "tax_status", "payouts_blocked")
select 'MSC', 'MSC Oberlausitzer Dreiländereck e.V.', 'ACTIVE', 'UNCLEARED', true
where not exists (select 1 from "commerce_seller" where "kind" = 'MSC');

insert into "commerce_seller" ("kind", "photographer_id", "display_name", "status", "tax_status", "payouts_blocked")
select 'PHOTOGRAPHER', p."id", p."display_name", 'ACTIVE', 'UNCLEARED', true
from "racepic_photographer" p
where p."deleted_at" is null
  and not exists (select 1 from "commerce_seller" s where s."photographer_id" = p."id");

insert into "commerce_product" ("product_type", "racepic_image_id", "seller_id")
select 'RACEPIC_IMAGE_LICENSE', i."id", s."id"
from "racepic_image" i
join "commerce_seller" s on s."photographer_id" = i."photographer_id"
where i."visibility" <> 'REMOVED'
  and not exists (select 1 from "commerce_product" p where p."racepic_image_id" = i."id");

insert into "commerce_offer_version"
  ("product_id", "version", "mode", "price_cents", "currency", "license_id", "seller_id", "status", "valid_from", "created_by")
select p."id", 1, 'FREE', 0, 'EUR', i."license_id", p."seller_id", 'ACTIVE', now(), 'migration:0111'
from "commerce_product" p
join "racepic_image" i on i."id" = p."racepic_image_id"
where i."offer_mode" = 'FREE'
  and not exists (select 1 from "commerce_offer_version" o where o."product_id" = p."id");

-- Konfliktreport: alles, was manuell geprueft werden muss. Abfrage: select * from commerce_backfill_conflicts;
create or replace view "commerce_backfill_conflicts" as
select i."id" as "image_id", i."photographer_id", 'PAID_IMAGE_WITHOUT_OFFER'::text as "conflict",
       i."price_cents"::text as "detail"
from "racepic_image" i
where i."offer_mode" = 'PAID' and i."visibility" <> 'REMOVED'
union all
select i."id", i."photographer_id", 'PHOTOGRAPHER_WITHOUT_SELLER', null
from "racepic_image" i
where i."visibility" <> 'REMOVED'
  and not exists (select 1 from "commerce_seller" s where s."photographer_id" = i."photographer_id")
union all
select i."id", i."photographer_id", 'FREE_IMAGE_WITH_PAID_LICENSE', l."code"
from "racepic_image" i
join "racepic_license" l on l."id" = i."license_id"
where i."offer_mode" = 'FREE' and i."visibility" <> 'REMOVED' and l."pricing_kind" = 'PAID';
