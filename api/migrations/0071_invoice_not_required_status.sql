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

-- Preserve the issued amount when a fully paid entry was withdrawn later.
-- The ledger remains authoritative and is not changed by this repair.
with settled_withdrawals as (
  select
    i."id",
    max(p."paid_at") as "last_paid_at"
  from "invoice" i
  join "invoice_payment" p on p."invoice_id" = i."id"
  where i."total_cents" = 0
    and coalesce(i."paid_amount_cents", 0) > 0
    and i."payment_status" = 'due'
    and exists (
      select 1
      from "entry" e
      where e."event_id" = i."event_id"
        and e."driver_person_id" = i."driver_person_id"
        and e."deleted_at" is null
        and e."acceptance_status" = 'withdrawn'
    )
    and not exists (
      select 1
      from "entry" e
      where e."event_id" = i."event_id"
        and e."driver_person_id" = i."driver_person_id"
        and e."deleted_at" is null
        and e."acceptance_status" not in ('withdrawn', 'rejected')
    )
  group by i."id"
  having sum(p."amount_cents") = max(i."paid_amount_cents")
)
update "invoice" i
set
  "total_cents" = i."paid_amount_cents",
  "payment_status" = 'paid',
  "paid_at" = coalesce(i."paid_at", settled."last_paid_at"),
  "pricing_snapshot" = coalesce(i."pricing_snapshot", '{}'::jsonb) || jsonb_build_object(
    'computedTotalCents', 0,
    'totalCents', i."paid_amount_cents",
    'settlementPreserved', jsonb_build_object(
      'reason', 'withdrawn_after_payment',
      'paidAmountCents', i."paid_amount_cents"
    )
  ),
  "updated_at" = now()
from settled_withdrawals settled
where i."id" = settled."id";
