-- ============================================================================
-- Credit cutover reconciliation - READ ONLY, run BEFORE the migration
-- ============================================================================
--
-- Shows what every account's available credit is under the old (live-table,
-- floored) formula versus the new (ledger, unfloored) one, so the change can be
-- eyeballed per account before 20260813000000 is applied.
--
-- Nothing here writes. Safe to run against production.
--
-- What to look for:
--
--   delta > 0  Partner GAINS headroom. Expected wherever a top-up or an
--              overpayment was previously swallowed by the floor - this is the
--              bug being fixed. Check the advance_balance column matches money
--              you can actually account for.
--
--   delta < 0  Partner LOSES headroom. Expect this where invoice-linked
--              receipts were being netted off bills that are now carried as
--              order debits instead. A large negative delta on an active
--              account is worth investigating before cutover - it usually means
--              orders exist without matching payments, i.e. genuine unpaid work
--              the old formula was hiding.
--
--   orders_without_debit > 0 after the migration means the backfill missed
--   rows; re-run the backfill block.
-- ============================================================================

WITH ledger AS (
  SELECT
    account_id,
    SUM(CASE WHEN entry_type IN ('ORDER_DEBIT', 'MANUAL_DEBIT', 'REFUND_DEBIT', 'EXPIRED_DEBIT', 'TRANSFER_OUT') THEN amount ELSE 0 END) AS debits,
    SUM(CASE WHEN entry_type IN ('ORDER_CANCEL_CREDIT', 'PAYMENT_CREDIT', 'MANUAL_CREDIT', 'TRANSFER_IN') THEN amount ELSE 0 END) AS credits,
    SUM(CASE WHEN entry_type = 'PAYMENT_CREDIT' AND reference_type = 'payment_attempt' THEN amount ELSE 0 END) AS gateway_paid,
    SUM(CASE WHEN entry_type IN ('PAYMENT_CREDIT', 'MANUAL_CREDIT') AND reference_type IN ('manual', 'invoice') THEN amount ELSE 0 END) AS receipted
  FROM public.b2b_credit_ledger
  WHERE is_reversed = false
  GROUP BY account_id
),
-- What the ledger WILL hold once every account order carries its debit.
order_debits AS (
  SELECT
    account_id,
    SUM(CASE WHEN lower(COALESCE(status::text, '')) <> 'cancelled'
             THEN GREATEST(0, CASE WHEN COALESCE(final_amount, 0) > 0 THEN final_amount ELSE COALESCE(total_amount, 0) END) ELSE 0 END) AS order_debit_total,
    COUNT(*) FILTER (
      WHERE NOT EXISTS (
        SELECT 1 FROM public.b2b_credit_ledger l
        WHERE l.reference_type = 'order' AND l.entry_type = 'ORDER_DEBIT' AND l.reference_id = o.id
      )
    ) AS orders_without_debit
  FROM public.orders o
  WHERE account_id IS NOT NULL
  GROUP BY account_id
),
-- The old formula's terms.
open_orders AS (
  SELECT account_id, SUM(GREATEST(0, CASE WHEN COALESCE(final_amount, 0) > 0 THEN final_amount ELSE COALESCE(total_amount, 0) END)) AS amt
  FROM public.orders
  WHERE account_id IS NOT NULL
    AND lower(COALESCE(status::text, '')) <> 'cancelled'
    AND is_billed IS NOT TRUE
    AND lower(COALESCE(billing_status, '')) <> 'billed'
  GROUP BY account_id
),
open_invoices AS (
  SELECT account_id, SUM(COALESCE(total_amount, 0)) AS amt
  FROM public.consolidated_invoices
  WHERE lower(COALESCE(status, '')) NOT IN ('paid', 'cancelled')
  GROUP BY account_id
),
-- Receipts the OLD formula counted: advances always, invoice-linked only while
-- that invoice was still outstanding.
old_receipts AS (
  SELECT l.account_id, SUM(l.amount) AS amt
  FROM public.b2b_credit_ledger l
  WHERE l.is_reversed = false
    AND l.entry_type IN ('PAYMENT_CREDIT', 'MANUAL_CREDIT')
    AND (
      l.reference_type = 'manual'
      OR (l.reference_type = 'invoice' AND EXISTS (
            SELECT 1 FROM public.consolidated_invoices ci
            WHERE ci.id = l.reference_id
              AND lower(COALESCE(ci.status, '')) NOT IN ('paid', 'cancelled')
         ))
    )
  GROUP BY l.account_id
),
bookings AS (
  SELECT account_id, SUM(COALESCE(quotation_amount, 0)) AS amt
  FROM public.bookings
  WHERE account_id IS NOT NULL AND status IN ('pending', 'quoted', 'confirmed')
  GROUP BY account_id
)
SELECT
  a.name                                                          AS account,
  a.credit_limit,
  COALESCE(od.orders_without_debit, 0)                            AS orders_without_debit,

  -- OLD: limit - max(stored_used, max(0, bills + open orders + bookings - paid))
  ROUND(a.credit_limit - GREATEST(
    a.credit_used,
    GREATEST(0, COALESCE(oi.amt, 0) + COALESCE(oo.amt, 0) + COALESCE(bk.amt, 0)
                - COALESCE(lg.gateway_paid, 0) - COALESCE(orc.amt, 0))
  ), 2)                                                           AS old_available,

  -- NEW: limit - ((order debits - all credits) + bookings)
  ROUND(a.credit_limit - (
    (COALESCE(od.order_debit_total, 0) - COALESCE(lg.credits, 0)) + COALESCE(bk.amt, 0)
  ), 2)                                                           AS new_available,

  ROUND((a.credit_limit - (
    (COALESCE(od.order_debit_total, 0) - COALESCE(lg.credits, 0)) + COALESCE(bk.amt, 0)
  )) - (a.credit_limit - GREATEST(
    a.credit_used,
    GREATEST(0, COALESCE(oi.amt, 0) + COALESCE(oo.amt, 0) + COALESCE(bk.amt, 0)
                - COALESCE(lg.gateway_paid, 0) - COALESCE(orc.amt, 0))
  )), 2)                                                          AS delta,

  -- Money paid that no order consumes, under the new model.
  ROUND(GREATEST(0, COALESCE(lg.credits, 0) - COALESCE(od.order_debit_total, 0)), 2) AS advance_balance,

  ROUND(COALESCE(od.order_debit_total, 0), 2)                     AS orders_placed,
  ROUND(COALESCE(lg.gateway_paid, 0), 2)                          AS gateway_paid,
  ROUND(COALESCE(lg.receipted, 0), 2)                             AS receipted_at_lab,
  ROUND(COALESCE(bk.amt, 0), 2)                                   AS pending_bookings
FROM public.accounts a
LEFT JOIN ledger       lg  ON lg.account_id  = a.id
LEFT JOIN order_debits od  ON od.account_id  = a.id
LEFT JOIN open_orders  oo  ON oo.account_id  = a.id
LEFT JOIN open_invoices oi ON oi.account_id  = a.id
LEFT JOIN old_receipts orc ON orc.account_id = a.id
LEFT JOIN bookings     bk  ON bk.account_id  = a.id
ORDER BY ABS(
  (a.credit_limit - ((COALESCE(od.order_debit_total, 0) - COALESCE(lg.credits, 0)) + COALESCE(bk.amt, 0)))
  - (a.credit_limit - GREATEST(a.credit_used, GREATEST(0,
      COALESCE(oi.amt, 0) + COALESCE(oo.amt, 0) + COALESCE(bk.amt, 0)
      - COALESCE(lg.gateway_paid, 0) - COALESCE(orc.amt, 0))))
) DESC;
