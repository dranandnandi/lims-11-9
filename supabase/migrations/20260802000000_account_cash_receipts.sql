-- Manual receipts (cash / cheque / bank transfer) collected from a B2B account
-- at the lab counter, recorded from Account Master.
--
-- A receipt is stored in b2b_credit_ledger as a PAYMENT_CREDIT entry with
-- reference_type = 'manual'. That reduces accounts.credit_used and therefore
-- raises the account's available credit. The account's credit_limit is never
-- touched by a receipt — the limit stays whatever the lab negotiated.
--
-- reference_type = 'manual' is what distinguishes these from gateway payments
-- (reference_type = 'payment_attempt'), so the two are never double counted.

-- ============================================
-- 1. Partner portal read access to the ledger
-- ============================================
-- The B2B portal subtracts manual receipts in its credit breakdown, so portal
-- users need to read their own ledger rows. Mirrors the b2b_payment_attempts
-- policy added in 20260530000000.

DROP POLICY IF EXISTS "B2B users can view own credit ledger" ON public.b2b_credit_ledger;

CREATE POLICY "B2B users can view own credit ledger"
  ON public.b2b_credit_ledger
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (
    (auth.jwt() -> 'user_metadata' ->> 'role') = 'b2b_account'
    AND account_id = ((auth.jwt() -> 'user_metadata' ->> 'account_id')::text)::uuid
  );

GRANT SELECT ON public.b2b_credit_ledger TO authenticated;

-- ============================================
-- 2. Record a receipt
-- ============================================

CREATE OR REPLACE FUNCTION public.record_account_cash_receipt(
  p_account_id uuid,
  p_amount numeric,
  p_payment_mode text DEFAULT 'cash',
  p_reference_no text DEFAULT NULL,
  p_received_on date DEFAULT NULL,
  p_remarks text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_lab uuid;
  v_account_lab uuid;
  v_created_by uuid;
  v_entry_id uuid;
  v_amount numeric;
  v_mode text;
  v_limit numeric;
  v_used numeric;
BEGIN
  v_amount := round(COALESCE(p_amount, 0)::numeric, 2);
  IF v_amount <= 0 THEN
    RAISE EXCEPTION 'Receipt amount must be greater than zero';
  END IF;

  SELECT lab_id INTO v_user_lab FROM public.users WHERE id = auth.uid();
  IF v_user_lab IS NULL THEN
    RAISE EXCEPTION 'No lab found for the current user';
  END IF;

  SELECT lab_id INTO v_account_lab FROM public.accounts WHERE id = p_account_id;
  IF v_account_lab IS NULL THEN
    RAISE EXCEPTION 'Account not found';
  END IF;

  IF v_account_lab <> v_user_lab THEN
    RAISE EXCEPTION 'Account does not belong to your lab';
  END IF;

  v_mode := lower(COALESCE(NULLIF(btrim(p_payment_mode), ''), 'cash'));
  IF v_mode NOT IN ('cash', 'cheque', 'bank_transfer', 'upi', 'card', 'other') THEN
    RAISE EXCEPTION 'Unsupported payment mode: %', v_mode;
  END IF;

  -- created_by is FK-constrained to public.users; auth.uid() is already
  -- verified to exist there by the lab lookup above.
  v_created_by := auth.uid();

  v_entry_id := public.add_credit_ledger_entry(
    v_account_lab,
    p_account_id,
    'PAYMENT_CREDIT',
    v_amount,
    'manual',
    NULL,
    NULLIF(btrim(p_remarks), ''),
    v_created_by,
    jsonb_build_object(
      'source', 'account_master',
      'payment_mode', v_mode,
      'reference_no', NULLIF(btrim(p_reference_no), ''),
      'received_on', COALESCE(p_received_on, CURRENT_DATE)
    )
  );

  SELECT COALESCE(credit_limit, 0), COALESCE(credit_used, 0)
    INTO v_limit, v_used
    FROM public.accounts
   WHERE id = p_account_id;

  RETURN jsonb_build_object(
    'entry_id', v_entry_id,
    'amount', v_amount,
    'credit_limit', v_limit,
    'credit_used', v_used,
    'available_credit', v_limit - v_used
  );
END;
$$;

-- ============================================
-- 3. Void a receipt entered by mistake
-- ============================================
-- Flags the entry as reversed. recalculate_account_credit_used() ignores
-- reversed rows, so the credit it granted is withdrawn.

CREATE OR REPLACE FUNCTION public.reverse_account_cash_receipt(
  p_entry_id uuid,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_lab uuid;
  v_entry public.b2b_credit_ledger%ROWTYPE;
  v_limit numeric;
  v_used numeric;
BEGIN
  SELECT lab_id INTO v_user_lab FROM public.users WHERE id = auth.uid();
  IF v_user_lab IS NULL THEN
    RAISE EXCEPTION 'No lab found for the current user';
  END IF;

  SELECT * INTO v_entry FROM public.b2b_credit_ledger WHERE id = p_entry_id;
  IF v_entry.id IS NULL THEN
    RAISE EXCEPTION 'Receipt not found';
  END IF;

  IF v_entry.lab_id <> v_user_lab THEN
    RAISE EXCEPTION 'Receipt does not belong to your lab';
  END IF;

  -- Only manually entered receipts can be voided here. Gateway payments must be
  -- refunded through the gateway so the two sides stay in agreement.
  IF v_entry.reference_type IS DISTINCT FROM 'manual' THEN
    RAISE EXCEPTION 'Only manually recorded receipts can be voided';
  END IF;

  IF v_entry.is_reversed THEN
    RAISE EXCEPTION 'Receipt is already voided';
  END IF;

  UPDATE public.b2b_credit_ledger
     SET is_reversed = true,
         reversal_reason = NULLIF(btrim(p_reason), '')
   WHERE id = p_entry_id;

  PERFORM public.recalculate_account_credit_used(v_entry.account_id);

  SELECT COALESCE(credit_limit, 0), COALESCE(credit_used, 0)
    INTO v_limit, v_used
    FROM public.accounts
   WHERE id = v_entry.account_id;

  RETURN jsonb_build_object(
    'entry_id', p_entry_id,
    'credit_limit', v_limit,
    'credit_used', v_used,
    'available_credit', v_limit - v_used
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_account_cash_receipt(uuid, numeric, text, text, date, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reverse_account_cash_receipt(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.record_account_cash_receipt(uuid, numeric, text, text, date, text) IS
  'Records cash/cheque/bank money collected from a B2B account as a manual PAYMENT_CREDIT ledger entry. Raises available credit; never changes credit_limit.';
COMMENT ON FUNCTION public.reverse_account_cash_receipt(uuid, text) IS
  'Voids a manually recorded account receipt and recalculates the account credit used.';

-- Speeds up the "sum of manual credits for this account" lookup that the
-- portal, order form and account master all run.
CREATE INDEX IF NOT EXISTS idx_b2b_credit_ledger_manual_credits
  ON public.b2b_credit_ledger(account_id)
  WHERE reference_type = 'manual' AND is_reversed = false;
