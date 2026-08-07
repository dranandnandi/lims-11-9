-- Unifies the two "receive payment" paths for B2B accounts.
--
-- Before this, money collected from a partner could be entered in two places
-- that knew nothing about each other:
--   * Billing > B2B Account Dashboard > Receive Payment  -> credit_transactions
--     (+ invoice status), but never freed any credit.
--   * Account Master > Credit & Payments                 -> b2b_credit_ledger
--     (freed credit), but was invisible to billing.
-- Entering the same cash in both double-counted it.
--
-- Both screens now call record_account_payment_receipt(), which writes ONE
-- credit_transactions row (so billing sees the money) and ONE ledger entry
-- (so credit frees up), in a single transaction.
--
-- Ledger reference_type encodes how long the credit stays applicable:
--   'manual'  = general advance, not tied to a bill. Always frees credit.
--   'invoice' = paid against a consolidated invoice. Frees credit only while
--               that invoice is still outstanding.
-- That second rule is what stops the double count: an unpaid or partial invoice
-- contributes its FULL total to credit used, so the part-payment must be netted
-- off; once the invoice flips to paid it leaves the outstanding total entirely,
-- and its payments must stop being netted off or they would be counted twice.

-- ============================================
-- 1. The single receipt entry point
-- ============================================

CREATE OR REPLACE FUNCTION public.record_account_payment_receipt(
  p_account_id uuid,
  p_amount numeric,
  p_payment_mode text DEFAULT 'cash',
  p_reference_no text DEFAULT NULL,
  p_received_on date DEFAULT NULL,
  p_remarks text DEFAULT NULL,
  p_consolidated_invoice_id uuid DEFAULT NULL
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
  v_txn_id uuid;
  v_amount numeric;
  v_mode text;
  v_ledger_ref_type text;
  v_invoice_account uuid;
  v_invoice_lab uuid;
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

  -- Both dropdowns feed this: Account Master offers 'bank_transfer', Billing
  -- has long stored 'neft'. Accept both and store verbatim so existing billing
  -- views keep rendering historical rows the same way.
  v_mode := lower(COALESCE(NULLIF(btrim(p_payment_mode), ''), 'cash'));
  IF v_mode NOT IN ('cash', 'cheque', 'bank_transfer', 'neft', 'rtgs', 'upi', 'card', 'other') THEN
    RAISE EXCEPTION 'Unsupported payment mode: %', v_mode;
  END IF;

  IF p_consolidated_invoice_id IS NOT NULL THEN
    SELECT account_id, lab_id INTO v_invoice_account, v_invoice_lab
      FROM public.consolidated_invoices WHERE id = p_consolidated_invoice_id;

    IF v_invoice_lab IS NULL THEN
      RAISE EXCEPTION 'Invoice not found';
    END IF;
    IF v_invoice_lab <> v_user_lab THEN
      RAISE EXCEPTION 'Invoice does not belong to your lab';
    END IF;
    IF v_invoice_account IS DISTINCT FROM p_account_id THEN
      RAISE EXCEPTION 'Invoice belongs to a different account';
    END IF;
  END IF;

  v_ledger_ref_type := CASE WHEN p_consolidated_invoice_id IS NULL THEN 'manual' ELSE 'invoice' END;
  v_created_by := auth.uid();

  -- 1) Billing record. Mirrors exactly what ReceivePaymentModal used to insert
  --    directly, so existing billing views keep working unchanged.
  INSERT INTO public.credit_transactions (
    account_id, lab_id, amount, transaction_type, payment_method,
    reference_number, reference_type, reference_id,
    transaction_date, notes, description, created_by
  ) VALUES (
    p_account_id, v_account_lab, v_amount, 'payment', v_mode,
    NULLIF(btrim(p_reference_no), ''),
    CASE WHEN p_consolidated_invoice_id IS NULL THEN 'account' ELSE 'consolidated_invoice' END,
    COALESCE(p_consolidated_invoice_id, p_account_id),
    COALESCE(p_received_on, CURRENT_DATE),
    NULLIF(btrim(p_remarks), ''),
    'Payment received via ' || upper(v_mode),
    v_created_by
  ) RETURNING id INTO v_txn_id;

  -- 2) Credit ledger entry, which is what actually frees headroom.
  v_entry_id := public.add_credit_ledger_entry(
    v_account_lab,
    p_account_id,
    'PAYMENT_CREDIT',
    v_amount,
    v_ledger_ref_type,
    p_consolidated_invoice_id,
    NULLIF(btrim(p_remarks), ''),
    v_created_by,
    jsonb_build_object(
      'source', CASE WHEN p_consolidated_invoice_id IS NULL THEN 'account_master' ELSE 'billing' END,
      'payment_mode', v_mode,
      'reference_no', NULLIF(btrim(p_reference_no), ''),
      'received_on', COALESCE(p_received_on, CURRENT_DATE),
      'credit_transaction_id', v_txn_id,
      'consolidated_invoice_id', p_consolidated_invoice_id
    )
  );

  SELECT COALESCE(credit_limit, 0), COALESCE(credit_used, 0)
    INTO v_limit, v_used FROM public.accounts WHERE id = p_account_id;

  RETURN jsonb_build_object(
    'entry_id', v_entry_id,
    'credit_transaction_id', v_txn_id,
    'amount', v_amount,
    'credit_limit', v_limit,
    'credit_used', v_used,
    'available_credit', v_limit - v_used
  );
END;
$$;

-- Keep the original name working — it is now just the un-linked (advance) case.
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
BEGIN
  RETURN public.record_account_payment_receipt(
    p_account_id, p_amount, p_payment_mode, p_reference_no, p_received_on, p_remarks, NULL
  );
END;
$$;

-- ============================================
-- 2. Voiding
-- ============================================
-- Also clears the paired credit_transactions row so billing does not keep
-- showing money that was withdrawn. Still restricted to un-linked advances;
-- an invoice payment must be corrected in Billing, where the invoice status
-- lives, so the two cannot drift apart.

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
  v_txn_id uuid;
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
  IF v_entry.reference_type IS DISTINCT FROM 'manual' THEN
    RAISE EXCEPTION 'Only un-linked account receipts can be voided here. Correct invoice payments from Billing.';
  END IF;
  IF v_entry.is_reversed THEN
    RAISE EXCEPTION 'Receipt is already voided';
  END IF;

  UPDATE public.b2b_credit_ledger
     SET is_reversed = true,
         reversal_reason = NULLIF(btrim(p_reason), '')
   WHERE id = p_entry_id;

  v_txn_id := NULLIF(v_entry.metadata ->> 'credit_transaction_id', '')::uuid;
  IF v_txn_id IS NOT NULL THEN
    DELETE FROM public.credit_transactions WHERE id = v_txn_id;
  END IF;

  PERFORM public.recalculate_account_credit_used(v_entry.account_id);

  SELECT COALESCE(credit_limit, 0), COALESCE(credit_used, 0)
    INTO v_limit, v_used FROM public.accounts WHERE id = v_entry.account_id;

  RETURN jsonb_build_object(
    'entry_id', p_entry_id,
    'credit_transaction_id', v_txn_id,
    'credit_limit', v_limit,
    'credit_used', v_used,
    'available_credit', v_limit - v_used
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_account_payment_receipt(uuid, numeric, text, text, date, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_account_cash_receipt(uuid, numeric, text, text, date, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reverse_account_cash_receipt(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.record_account_payment_receipt(uuid, numeric, text, text, date, text, uuid) IS
  'Single entry point for money received from a B2B account. Writes the billing record (credit_transactions) and the credit ledger entry together. Pass a consolidated invoice id to tie the payment to a bill.';

-- Widen the manual-credit index to cover invoice-linked receipts too.
DROP INDEX IF EXISTS public.idx_b2b_credit_ledger_manual_credits;
CREATE INDEX IF NOT EXISTS idx_b2b_credit_ledger_receipt_credits
  ON public.b2b_credit_ledger(account_id)
  WHERE reference_type IN ('manual', 'invoice') AND is_reversed = false;

NOTIFY pgrst, 'reload schema';
