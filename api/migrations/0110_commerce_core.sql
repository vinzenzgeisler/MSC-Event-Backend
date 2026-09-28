-- RacePic Commerce (AP02): Ledger-Grundlage fuer Marketplace/Stripe-Checkout.
-- Plan: docs/memory-bank/racepic-marketplace-checkout-plan.md (Abschnitt 3.3/3.4).
-- Geld ausschliesslich als Integer-Cents. Commerce-Referenzen sperren Hard Deletes (ON DELETE RESTRICT).
-- Steuerklasse und -satz sind bewusst konfigurierbar und ohne festen Default: Das Steuermodell ist offen
-- (siehe Abschnitt "Offene Steuerentscheidungen" in den Umsetzungsnotizen).

create table if not exists "commerce_seller" (
  "id" uuid primary key default gen_random_uuid(),
  "kind" text not null,
  "photographer_id" uuid references "racepic_photographer"("id") on delete restrict,
  "display_name" text not null,
  "status" text not null default 'ACTIVE',
  "tax_status" text not null default 'UNCLEARED',
  "payouts_blocked" boolean not null default true,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  constraint "commerce_seller_kind_check" check ("kind" in ('MSC', 'PHOTOGRAPHER')),
  constraint "commerce_seller_status_check" check ("status" in ('ACTIVE', 'SUSPENDED')),
  constraint "commerce_seller_tax_status_check" check (
    "tax_status" in ('UNCLEARED', 'PRIVATE', 'SMALL_BUSINESS', 'REGULAR')
  ),
  constraint "commerce_seller_kind_photographer_check" check (
    ("kind" = 'PHOTOGRAPHER' and "photographer_id" is not null)
    or ("kind" = 'MSC' and "photographer_id" is null)
  )
);
create unique index if not exists "commerce_seller_photographer_unique"
  on "commerce_seller" ("photographer_id") where "photographer_id" is not null;
create unique index if not exists "commerce_seller_msc_unique"
  on "commerce_seller" ("kind") where "kind" = 'MSC';

create table if not exists "commerce_payment_account" (
  "id" uuid primary key default gen_random_uuid(),
  "seller_id" uuid not null references "commerce_seller"("id") on delete restrict,
  "provider" text not null default 'STRIPE',
  "provider_account_id" text not null,
  "charges_enabled" boolean not null default false,
  "payouts_enabled" boolean not null default false,
  "details_submitted" boolean not null default false,
  "requirements" jsonb not null default '{}'::jsonb,
  "status" text not null default 'PENDING',
  "synced_at" timestamptz,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  constraint "commerce_payment_account_provider_check" check ("provider" in ('STRIPE')),
  constraint "commerce_payment_account_status_check" check ("status" in ('PENDING', 'ENABLED', 'RESTRICTED', 'DISABLED')),
  constraint "commerce_payment_account_seller_unique" unique ("seller_id"),
  constraint "commerce_payment_account_provider_account_unique" unique ("provider", "provider_account_id")
);

create table if not exists "commerce_buyer_account" (
  "id" uuid primary key default gen_random_uuid(),
  "cognito_sub" text not null,
  "email_norm" text not null,
  "status" text not null default 'ACTIVE',
  "deleted_at" timestamptz,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  constraint "commerce_buyer_account_status_check" check ("status" in ('ACTIVE', 'DISABLED', 'DELETED')),
  constraint "commerce_buyer_account_cognito_sub_unique" unique ("cognito_sub")
);
create index if not exists "commerce_buyer_account_email_idx" on "commerce_buyer_account" ("email_norm");

create table if not exists "commerce_customer" (
  "id" uuid primary key default gen_random_uuid(),
  "buyer_account_id" uuid references "commerce_buyer_account"("id") on delete restrict,
  "email_norm" text not null,
  "provider_customer_id" text,
  "created_at" timestamptz not null default now(),
  constraint "commerce_customer_provider_customer_unique" unique ("provider_customer_id")
);
create index if not exists "commerce_customer_email_idx" on "commerce_customer" ("email_norm");

create table if not exists "commerce_product" (
  "id" uuid primary key default gen_random_uuid(),
  "product_type" text not null,
  "racepic_image_id" uuid references "racepic_image"("id") on delete restrict,
  "seller_id" uuid not null references "commerce_seller"("id") on delete restrict,
  "created_at" timestamptz not null default now(),
  constraint "commerce_product_type_check" check ("product_type" in ('RACEPIC_IMAGE_LICENSE')),
  constraint "commerce_product_racepic_ref_check" check (
    "product_type" <> 'RACEPIC_IMAGE_LICENSE' or "racepic_image_id" is not null
  )
);
create unique index if not exists "commerce_product_racepic_image_unique"
  on "commerce_product" ("racepic_image_id") where "racepic_image_id" is not null;
create index if not exists "commerce_product_seller_idx" on "commerce_product" ("seller_id");

create table if not exists "racepic_offer_conversion" (
  "id" uuid primary key default gen_random_uuid(),
  "photographer_id" uuid not null references "racepic_photographer"("id") on delete restrict,
  "idempotency_key" text not null,
  "status" text not null default 'REQUESTED',
  "target_price_cents" integer not null,
  "target_license_id" uuid not null references "racepic_license"("id"),
  "rights_confirmed_at" timestamptz not null,
  "rights_confirmation_version" text not null,
  "reviewer" text,
  "review_note" text,
  "decided_at" timestamptz,
  "failure_reason" text,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  constraint "racepic_offer_conversion_status_check" check (
    "status" in ('REQUESTED', 'PREPARING_ASSETS', 'READY_FOR_REVIEW', 'APPROVED', 'REJECTED', 'FAILED')
  ),
  constraint "racepic_offer_conversion_price_check" check ("target_price_cents" in (500, 1000, 1500, 2000)),
  constraint "racepic_offer_conversion_idempotency_unique" unique ("photographer_id", "idempotency_key")
);
create index if not exists "racepic_offer_conversion_status_idx"
  on "racepic_offer_conversion" ("status", "created_at");

create table if not exists "commerce_offer_version" (
  "id" uuid primary key default gen_random_uuid(),
  "product_id" uuid not null references "commerce_product"("id") on delete restrict,
  "version" integer not null,
  "mode" text not null,
  "price_cents" integer not null default 0,
  "currency" text not null default 'EUR',
  "license_id" uuid not null references "racepic_license"("id"),
  "tax_class" text,
  "tax_rate_bp" integer,
  "seller_id" uuid not null references "commerce_seller"("id") on delete restrict,
  "status" text not null default 'DRAFT',
  "conversion_id" uuid references "racepic_offer_conversion"("id") on delete restrict,
  "artifact_prefix" text,
  "valid_from" timestamptz,
  "valid_to" timestamptz,
  "created_by" text,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  constraint "commerce_offer_version_mode_check" check ("mode" in ('FREE', 'PAID')),
  constraint "commerce_offer_version_status_check" check (
    "status" in ('DRAFT', 'PENDING_REVIEW', 'ACTIVE', 'REJECTED', 'RETIRED')
  ),
  constraint "commerce_offer_version_currency_check" check ("currency" = 'EUR'),
  constraint "commerce_offer_version_price_check" check (
    ("mode" = 'FREE' and "price_cents" = 0)
    or ("mode" = 'PAID' and "price_cents" in (500, 1000, 1500, 2000))
  ),
  constraint "commerce_offer_version_tax_rate_check" check ("tax_rate_bp" is null or "tax_rate_bp" between 0 and 10000),
  constraint "commerce_offer_version_product_version_unique" unique ("product_id", "version")
);
create unique index if not exists "commerce_offer_version_active_unique"
  on "commerce_offer_version" ("product_id") where "status" = 'ACTIVE';
create index if not exists "commerce_offer_version_conversion_idx"
  on "commerce_offer_version" ("conversion_id") where "conversion_id" is not null;

-- Angebotsversionen sind immutable: nur Statuswechsel und Gueltigkeitsende duerfen sich aendern.
create or replace function "commerce_offer_version_immutable"() returns trigger as $$
begin
  if (new."product_id", new."version", new."mode", new."price_cents", new."currency", new."license_id",
      new."tax_class", new."tax_rate_bp", new."seller_id", new."conversion_id", new."artifact_prefix", new."created_by")
     is distinct from
     (old."product_id", old."version", old."mode", old."price_cents", old."currency", old."license_id",
      old."tax_class", old."tax_rate_bp", old."seller_id", old."conversion_id", old."artifact_prefix", old."created_by") then
    raise exception 'commerce_offer_version ist immutable (nur status/valid_from/valid_to aenderbar)';
  end if;
  return new;
end;
$$ language plpgsql;
drop trigger if exists "commerce_offer_version_immutable_trg" on "commerce_offer_version";
create trigger "commerce_offer_version_immutable_trg"
  before update on "commerce_offer_version"
  for each row execute function "commerce_offer_version_immutable"();

create table if not exists "racepic_offer_conversion_item" (
  "id" uuid primary key default gen_random_uuid(),
  "conversion_id" uuid not null references "racepic_offer_conversion"("id") on delete restrict,
  "image_id" uuid not null references "racepic_image"("id") on delete restrict,
  "source_offer_version_id" uuid references "commerce_offer_version"("id") on delete restrict,
  "target_offer_version_id" uuid references "commerce_offer_version"("id") on delete restrict,
  "artifact_status" text not null default 'PENDING',
  "artifact_error" text,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  constraint "racepic_offer_conversion_item_artifact_check" check (
    "artifact_status" in ('PENDING', 'RUNNING', 'READY', 'FAILED')
  ),
  constraint "racepic_offer_conversion_item_unique" unique ("conversion_id", "image_id")
);
-- Pro Bild darf nur ein offener Antrag existieren; Abgrenzung ueber Join auf den Antragsstatus im Service.
create index if not exists "racepic_offer_conversion_item_image_idx"
  on "racepic_offer_conversion_item" ("image_id");

create table if not exists "commerce_quote" (
  "id" uuid primary key default gen_random_uuid(),
  "buyer_account_id" uuid references "commerce_buyer_account"("id") on delete restrict,
  "email_norm" text,
  "items" jsonb not null,
  "gross_cents" integer not null,
  "net_cents" integer not null,
  "tax_cents" integer not null,
  "currency" text not null default 'EUR',
  "expires_at" timestamptz not null,
  "created_at" timestamptz not null default now()
);

create table if not exists "commerce_order" (
  "id" uuid primary key default gen_random_uuid(),
  "quote_id" uuid references "commerce_quote"("id") on delete restrict,
  "buyer_account_id" uuid references "commerce_buyer_account"("id") on delete restrict,
  "email_norm" text not null,
  "status" text not null default 'PENDING',
  "currency" text not null default 'EUR',
  "gross_cents" integer not null,
  "net_cents" integer not null,
  "tax_cents" integer not null,
  "legal_snapshot" jsonb not null default '{}'::jsonb,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  constraint "commerce_order_status_check" check (
    "status" in ('PENDING', 'PAID', 'PARTIALLY_REFUNDED', 'REFUNDED', 'DISPUTED', 'CANCELLED')
  )
);
create index if not exists "commerce_order_email_idx" on "commerce_order" ("email_norm");
create index if not exists "commerce_order_buyer_idx" on "commerce_order" ("buyer_account_id");

create table if not exists "commerce_order_item" (
  "id" uuid primary key default gen_random_uuid(),
  "order_id" uuid not null references "commerce_order"("id") on delete restrict,
  "product_id" uuid not null references "commerce_product"("id") on delete restrict,
  "offer_version_id" uuid not null references "commerce_offer_version"("id") on delete restrict,
  "seller_id" uuid not null references "commerce_seller"("id") on delete restrict,
  "gross_cents" integer not null,
  "net_cents" integer not null,
  "tax_cents" integer not null,
  "commission_cents" integer not null,
  "seller_share_cents" integer not null,
  "license_snapshot" jsonb not null,
  "created_at" timestamptz not null default now()
);
create index if not exists "commerce_order_item_order_idx" on "commerce_order_item" ("order_id");
create index if not exists "commerce_order_item_seller_idx" on "commerce_order_item" ("seller_id");

create table if not exists "commerce_payment" (
  "id" uuid primary key default gen_random_uuid(),
  "order_id" uuid not null references "commerce_order"("id") on delete restrict,
  "provider" text not null default 'STRIPE',
  "provider_checkout_session_id" text,
  "provider_payment_intent_id" text,
  "status" text not null default 'PENDING',
  "amount_cents" integer not null,
  "paid_at" timestamptz,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  constraint "commerce_payment_status_check" check ("status" in ('PENDING', 'PAID', 'FAILED', 'EXPIRED', 'REFUNDED')),
  constraint "commerce_payment_order_unique" unique ("order_id"),
  constraint "commerce_payment_intent_unique" unique ("provider_payment_intent_id")
);

create table if not exists "commerce_refund" (
  "id" uuid primary key default gen_random_uuid(),
  "payment_id" uuid not null references "commerce_payment"("id") on delete restrict,
  "provider_refund_id" text,
  "status" text not null default 'PENDING',
  "amount_cents" integer not null,
  "reason" text,
  "actor" text,
  "idempotency_key" text not null,
  "created_at" timestamptz not null default now(),
  constraint "commerce_refund_status_check" check ("status" in ('PENDING', 'SUCCEEDED', 'FAILED')),
  constraint "commerce_refund_idempotency_unique" unique ("idempotency_key"),
  constraint "commerce_refund_provider_unique" unique ("provider_refund_id")
);

create table if not exists "commerce_refund_item" (
  "id" uuid primary key default gen_random_uuid(),
  "refund_id" uuid not null references "commerce_refund"("id") on delete restrict,
  "order_item_id" uuid not null references "commerce_order_item"("id") on delete restrict,
  "amount_cents" integer not null,
  constraint "commerce_refund_item_unique" unique ("order_item_id")
);

create table if not exists "commerce_dispute" (
  "id" uuid primary key default gen_random_uuid(),
  "payment_id" uuid not null references "commerce_payment"("id") on delete restrict,
  "provider_dispute_id" text not null,
  "status" text not null,
  "amount_cents" integer not null,
  "evidence" jsonb not null default '{}'::jsonb,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  constraint "commerce_dispute_provider_unique" unique ("provider_dispute_id")
);

create table if not exists "commerce_entitlement" (
  "id" uuid primary key default gen_random_uuid(),
  "order_item_id" uuid not null references "commerce_order_item"("id") on delete restrict,
  "product_id" uuid not null references "commerce_product"("id") on delete restrict,
  "buyer_account_id" uuid references "commerce_buyer_account"("id") on delete restrict,
  "email_norm" text not null,
  "license_snapshot" jsonb not null,
  "status" text not null default 'ACTIVE',
  "download_count" integer not null default 0,
  "last_download_at" timestamptz,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  constraint "commerce_entitlement_status_check" check ("status" in ('ACTIVE', 'BLOCKED', 'REVOKED')),
  constraint "commerce_entitlement_order_item_unique" unique ("order_item_id")
);

create table if not exists "commerce_transfer" (
  "id" uuid primary key default gen_random_uuid(),
  "order_item_id" uuid not null references "commerce_order_item"("id") on delete restrict,
  "seller_id" uuid not null references "commerce_seller"("id") on delete restrict,
  "amount_cents" integer not null,
  "status" text not null default 'HELD',
  "release_at" timestamptz not null,
  "provider_transfer_id" text,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  constraint "commerce_transfer_status_check" check (
    "status" in ('HELD', 'READY', 'SUBMITTED', 'PAID', 'REVERSAL_PENDING', 'REVERSED', 'FAILED')
  ),
  constraint "commerce_transfer_order_item_unique" unique ("order_item_id"),
  constraint "commerce_transfer_provider_unique" unique ("provider_transfer_id")
);

create table if not exists "commerce_transfer_reversal" (
  "id" uuid primary key default gen_random_uuid(),
  "transfer_id" uuid not null references "commerce_transfer"("id") on delete restrict,
  "amount_cents" integer not null,
  "provider_reversal_id" text,
  "status" text not null default 'PENDING',
  "created_at" timestamptz not null default now(),
  constraint "commerce_transfer_reversal_status_check" check ("status" in ('PENDING', 'SUCCEEDED', 'FAILED')),
  constraint "commerce_transfer_reversal_provider_unique" unique ("provider_reversal_id")
);

create table if not exists "commerce_seller_balance" (
  "seller_id" uuid primary key references "commerce_seller"("id") on delete restrict,
  "balance_cents" integer not null default 0,
  "updated_at" timestamptz not null default now()
);

create table if not exists "commerce_invoice" (
  "id" uuid primary key default gen_random_uuid(),
  "order_id" uuid not null references "commerce_order"("id") on delete restrict,
  "invoice_number" text not null,
  "document_key" text,
  "snapshot" jsonb not null,
  "created_at" timestamptz not null default now(),
  constraint "commerce_invoice_number_unique" unique ("invoice_number")
);

create table if not exists "commerce_seller_statement" (
  "id" uuid primary key default gen_random_uuid(),
  "seller_id" uuid not null references "commerce_seller"("id") on delete restrict,
  "period" text not null,
  "document_key" text,
  "snapshot" jsonb not null,
  "created_at" timestamptz not null default now(),
  constraint "commerce_seller_statement_unique" unique ("seller_id", "period")
);

create table if not exists "commerce_legal_acceptance" (
  "id" uuid primary key default gen_random_uuid(),
  "order_id" uuid references "commerce_order"("id") on delete restrict,
  "email_norm" text not null,
  "document_versions" jsonb not null,
  "accepted_at" timestamptz not null default now()
);

create table if not exists "commerce_webhook_inbox" (
  "id" uuid primary key default gen_random_uuid(),
  "provider" text not null default 'STRIPE',
  "endpoint" text not null,
  "event_id" text not null,
  "event_type" text not null,
  "payload_ref" text,
  "status" text not null default 'RECEIVED',
  "attempt_count" integer not null default 0,
  "last_error" text,
  "received_at" timestamptz not null default now(),
  "processed_at" timestamptz,
  constraint "commerce_webhook_inbox_endpoint_check" check ("endpoint" in ('platform', 'connect')),
  constraint "commerce_webhook_inbox_status_check" check ("status" in ('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED')),
  constraint "commerce_webhook_inbox_event_unique" unique ("provider", "event_id")
);
create index if not exists "commerce_webhook_inbox_pending_idx"
  on "commerce_webhook_inbox" ("received_at") where "status" in ('RECEIVED', 'FAILED');
