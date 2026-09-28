-- RacePic Commerce (AP15): eine Quote darf nur einmal in eine Bestellung ueberfuehrt werden.
-- Das Claimen passiert atomar (update ... where consumed_at is null and expires_at > now()), damit ein
-- doppelt gesendeter Checkout-Aufruf niemals zwei Bestellungen aus derselben Quote erzeugt.

alter table "commerce_quote"
  add column if not exists "consumed_at" timestamptz;

create index if not exists "commerce_payment_checkout_session_idx"
  on "commerce_payment" ("provider_checkout_session_id") where "provider_checkout_session_id" is not null;
