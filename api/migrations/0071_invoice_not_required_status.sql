alter table "invoice"
  drop constraint if exists "invoice_payment_status_check";

alter table "invoice"
  add constraint "invoice_payment_status_check"
  check ("payment_status" in ('due', 'paid', 'not_required'));

-- A zero-value invoice without any recorded payment does not require payment.
-- Amounts, paid timestamps and ledger rows are deliberately left untouched.
update "invoice" i
set
  "payment_status" = 'not_required',
  "updated_at" = now()
where i."total_cents" = 0
  and coalesce(i."paid_amount_cents", 0) = 0
  and i."payment_status" = 'due'
  and exists (
    select 1
    from "entry" e
    where e."event_id" = i."event_id"
      and e."driver_person_id" = i."driver_person_id"
      and e."deleted_at" is null
      and e."acceptance_status" = 'accepted'
  )
  and not exists (
    select 1
    from "invoice_payment" p
    where p."invoice_id" = i."id"
  );
