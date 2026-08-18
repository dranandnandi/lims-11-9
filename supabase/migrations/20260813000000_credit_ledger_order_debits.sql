-- ============================================================================
-- Credit ledger: build the missing debit side
-- ============================================================================
--
-- Until now the ledger only ever recorded CREDITs (PAYMENT_CREDIT,
-- MANUAL_CREDIT). ORDER_DEBIT was declared in the entry_type CHECK but no code
-- path ever wrote one, so recalculate_account_credit_used() always summed to a
-- negative number and GREATEST(0, ...) pinned accounts.credit_used at 0 for any
-- account that had ever paid. The column carried no information, which is why
-- the app recomputed usage from live tables instead.
--
-- That live-table formula floored usage at 0, so a payment could only ever
-- cancel debt - it could never bank. A partner who topped up with nothing
-- outstanding saw the money vanish. The floor could not simply be removed,
-- because gateway payments were never retired when the invoice they paid was
-- settled: drop the floor without a debit side and every historical payment
-- comes back as spendable credit.
--
-- This migration records consumption, which makes the floor unnecessary:
--
--   order placed  -> ORDER_DEBIT   40      net  40
--   partner pays  -> PAYMENT_CREDIT 40     net   0
--   invoice paid  -> (no entry, it is only a grouping of already-debited orders)
--
-- Net returns to 0 on its own, so settled work stops counting without needing a
-- clamp, and a top-up with nothing outstanding legitimately goes negative =
-- advance balance.
--
-- Consolidated invoices are deliberately NOT debited: they group orders that
-- have already been debited. Debiting both would double-count.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. One ORDER_DEBIT row per order
-- ----------------------------------------------------------------------------
-- A "current state" ledger row rather than an append-only pair of entries: the
-- amount on an order can change (tests added, discounts applied) and a single
-- upserted row keeps the ledger self-healing and idempotent. Cancellation flips
-- is_reversed, which recalculate_account_credit_used() already excludes.

CREATE UNIQUE INDEX IF NOT EXISTS idx_b2b_credit_ledger_order_debit
  ON public.b2b_credit_ledger(reference_id)
  WHERE reference_type = 'order' AND entry_type = 'ORDER_DEBIT';

CREATE OR REPLACE FUNCTION public.sync_order_credit_debit(p_order_id uuid)
RETURNS void AS $$
DECLARE
  v_order      record;
  v_amount     numeric;
  v_cancelled  boolean;
  v_balance    numeric;
BEGIN
  SELECT id, lab_id, account_id, total_amount, final_amount, status
    INTO v_order
    FROM public.orders
   WHERE id = p_order_id;

  -- Order gone, or never belonged to an account: drop any debit it left behind.
  IF NOT FOUND OR v_order.account_id IS NULL THEN
    DELETE FROM public.b2b_credit_ledger
     WHERE reference_type = 'order'
       AND entry_type = 'ORDER_DEBIT'
       AND reference_id = p_order_id;
    RETURN;
  END IF;

  -- Mirrors the amount rule the app has always used: final_amount when it is
  -- set and positive, otherwise total_amount. Note this is "> 0", not "IS NOT
  -- NULL" - a zero or negative final_amount falls back rather than zeroing the
  -- debit, which is what orderAmount() in accountCredit.ts does.
  v_amount := CASE
                WHEN COALESCE(v_order.final_amount, 0) > 0 THEN v_order.final_amount
                ELSE COALESCE(v_order.total_amount, 0)
              END;
  IF v_amount < 0 THEN
    v_amount := 0;
  END IF;

  v_cancelled := lower(COALESCE(v_order.status::text, '')) = 'cancelled';

  v_balance := public.get_account_available_credit(v_order.account_id);

  INSERT INTO public.b2b_credit_ledger (
    lab_id, account_id, entry_type, amount,
    balance_before, balance_after,
    reference_type, reference_id, remarks, is_reversed, reversal_reason
  ) VALUES (
    v_order.lab_id, v_order.account_id, 'ORDER_DEBIT', v_amount,
    v_balance, v_balance - v_amount,
    'order', p_order_id, 'Order placed on account', v_cancelled,
    CASE WHEN v_cancelled THEN 'Order cancelled' END
  )
  ON CONFLICT (reference_id) WHERE reference_type = 'order' AND entry_type = 'ORDER_DEBIT'
  DO UPDATE SET
    amount          = EXCLUDED.amount,
    lab_id          = EXCLUDED.lab_id,
    account_id      = EXCLUDED.account_id,
    is_reversed     = EXCLUDED.is_reversed,
    reversal_reason = EXCLUDED.reversal_reason,
    balance_after   = b2b_credit_ledger.balance_before - EXCLUDED.amount;

  PERFORM public.recalculate_account_credit_used(v_order.account_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

COMMENT ON FUNCTION public.sync_order_credit_debit(uuid) IS
  'Upserts the single ORDER_DEBIT ledger row for an order. Idempotent - safe to re-run for backfill or repair.';

-- ----------------------------------------------------------------------------
-- 2. Keep it in sync from every order-creation path
-- ----------------------------------------------------------------------------
-- A trigger rather than application code: orders are created by OrderForm, B2B
-- bookings, public booking, bulk-create-corporate-orders, hims-order-create and
-- process-pending-orders. One trigger covers all of them and anything added later.

CREATE OR REPLACE FUNCTION public.trg_sync_order_credit_debit()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.b2b_credit_ledger
     WHERE reference_type = 'order'
       AND entry_type = 'ORDER_DEBIT'
       AND reference_id = OLD.id;

    IF OLD.account_id IS NOT NULL THEN
      PERFORM public.recalculate_account_credit_used(OLD.account_id);
    END IF;
    RETURN OLD;
  END IF;

  PERFORM public.sync_order_credit_debit(NEW.id);

  -- Moving an order between accounts has to settle the account it left.
  IF TG_OP = 'UPDATE'
     AND OLD.account_id IS NOT NULL
     AND OLD.account_id IS DISTINCT FROM NEW.account_id THEN
    PERFORM public.recalculate_account_credit_used(OLD.account_id);
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_orders_credit_debit ON public.orders;

CREATE TRIGGER trg_orders_credit_debit
  AFTER INSERT OR DELETE OR UPDATE OF total_amount, final_amount, status, account_id, lab_id
  ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_sync_order_credit_debit();

-- ----------------------------------------------------------------------------
-- 3. Let credit_used go negative
-- ----------------------------------------------------------------------------
-- The floor is what swallowed advance payments. With the debit side in place a
-- negative sum is meaningful and correct: it is money paid but not yet consumed.

CREATE OR REPLACE FUNCTION public.recalculate_account_credit_used(p_account_id uuid)
RETURNS void AS $$
DECLARE
  v_total_used numeric;
BEGIN
  SELECT COALESCE(SUM(
    CASE
      WHEN entry_type IN ('ORDER_DEBIT', 'MANUAL_DEBIT', 'REFUND_DEBIT', 'EXPIRED_DEBIT', 'TRANSFER_OUT') THEN amount
      WHEN entry_type IN ('ORDER_CANCEL_CREDIT', 'PAYMENT_CREDIT', 'MANUAL_CREDIT', 'TRANSFER_IN') THEN -amount
      ELSE 0
    END
  ), 0) INTO v_total_used
  FROM public.b2b_credit_ledger
  WHERE account_id = p_account_id
  AND is_reversed = false;

  -- No GREATEST(0, ...): negative = advance balance held by the partner.
  UPDATE public.accounts
  SET credit_used = v_total_used,
      updated_at = now()
  WHERE id = p_account_id;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION public.recalculate_account_credit_used(uuid) IS
  'Sum of ledger debits minus credits. May be negative, which represents an advance balance the partner has paid but not yet consumed.';

-- ----------------------------------------------------------------------------
-- 4. Backfill historical orders
-- ----------------------------------------------------------------------------
-- Every existing account order gets the debit it never got. Idempotent via the
-- unique index, so this block can be re-run safely.

-- Set-based on purpose: calling sync_order_credit_debit() per order would
-- re-aggregate the account's entire ledger once per row, which is O(orders x
-- ledger) on a lab with any history. Insert every debit first, settle the
-- accounts once afterwards.
--
-- balance_before / balance_after are written as 0 / -amount. They are display
-- columns only - nothing in the credit math reads them - and there is no
-- meaningful historical running balance to reconstruct for orders that predate
-- the ledger having a debit side.

INSERT INTO public.b2b_credit_ledger (
  lab_id, account_id, entry_type, amount,
  balance_before, balance_after,
  reference_type, reference_id, remarks, is_reversed, reversal_reason
)
SELECT
  o.lab_id,
  o.account_id,
  'ORDER_DEBIT',
  GREATEST(0, CASE WHEN COALESCE(o.final_amount, 0) > 0 THEN o.final_amount ELSE COALESCE(o.total_amount, 0) END),
  0,
  -GREATEST(0, CASE WHEN COALESCE(o.final_amount, 0) > 0 THEN o.final_amount ELSE COALESCE(o.total_amount, 0) END),
  'order',
  o.id,
  'Order placed on account (backfilled)',
  lower(COALESCE(o.status::text, '')) = 'cancelled',
  CASE WHEN lower(COALESCE(o.status::text, '')) = 'cancelled' THEN 'Order cancelled' END
FROM public.orders o
WHERE o.account_id IS NOT NULL
ON CONFLICT (reference_id) WHERE reference_type = 'order' AND entry_type = 'ORDER_DEBIT'
DO NOTHING;

-- Settle credit_used for every account, including those with no orders at all
-- (a pure top-up account now correctly lands on a negative figure).
DO $$
DECLARE
  v_account_id uuid;
BEGIN
  FOR v_account_id IN SELECT id FROM public.accounts LOOP
    PERFORM public.recalculate_account_credit_used(v_account_id);
  END LOOP;
END $$;
