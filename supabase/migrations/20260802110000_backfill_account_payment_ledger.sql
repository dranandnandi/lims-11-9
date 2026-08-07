-- One-off maintenance helper: give historic billing payments the credit ledger
-- entry they never got.
--
-- Payments recorded in Billing before 20260802100000 wrote only a
-- credit_transactions row, so they never freed any of the account's credit.
-- This backfills the missing b2b_credit_ledger entries.
--
-- WHY THIS IS NOT AUTOMATIC, AND WHY IT DEFAULTS TO A DRY RUN
-- ----------------------------------------------------------
-- Backfilling blindly recreates the exact double count the unification removed.
-- A payment against an invoice that has since been marked paid has ALREADY had
-- its effect: the invoice left the outstanding total. Adding a ledger credit for
-- it as well would hand the same money back a second time. So:
--
--   * invoice-linked payment, invoice still outstanding -> safe, backfilled
--   * invoice-linked payment, invoice paid/cancelled    -> SKIPPED, always
--   * payment with no invoice link                      -> ambiguous. Could be a
--     genuine advance, or could be an invoice settled by hand. Only backfilled
--     when the caller explicitly passes p_include_unlinked => true.
--
-- Not granted to `authenticated` on purpose. Run it as postgres via the
-- Management API, never from the app.
--
-- Usage:
--   SELECT public.backfill_account_payment_ledger('<lab_uuid>');                        -- dry run
--   SELECT public.backfill_account_payment_ledger('<lab_uuid>', false, false);          -- apply, linked only
--   SELECT public.backfill_account_payment_ledger('<lab_uuid>', true,  false);          -- apply, incl. advances

CREATE OR REPLACE FUNCTION public.backfill_account_payment_ledger(
  p_lab_id uuid,
  p_include_unlinked boolean DEFAULT false,
  p_dry_run boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row              record;
  v_ref_type         text;
  v_ref_id           uuid;
  v_created_by       uuid;
  v_linked_count     integer := 0;
  v_linked_amount    numeric := 0;
  v_advance_count    integer := 0;
  v_advance_amount   numeric := 0;
  v_skipped_count    integer := 0;
  v_skipped_amount   numeric := 0;
BEGIN
  IF p_lab_id IS NULL THEN
    RAISE EXCEPTION 'p_lab_id is required';
  END IF;

  FOR v_row IN
    SELECT ct.id,
           ct.account_id,
           ct.amount,
           ct.payment_method,
           ct.reference_number,
           ct.reference_type,
           ct.reference_id,
           ct.transaction_date,
           ct.notes,
           ct.created_by,
           ci.status AS invoice_status
      FROM public.credit_transactions ct
      LEFT JOIN public.consolidated_invoices ci
             ON ct.reference_type = 'consolidated_invoice'
            AND ci.id = ct.reference_id
     WHERE ct.transaction_type = 'payment'
       AND ct.account_id IS NOT NULL
       AND ct.lab_id = p_lab_id
       AND COALESCE(ct.amount, 0) > 0
       -- Idempotent: never touch a payment that already has its ledger entry.
       AND NOT EXISTS (
             SELECT 1 FROM public.b2b_credit_ledger l
              WHERE (l.metadata ->> 'credit_transaction_id')::uuid = ct.id
           )
     ORDER BY ct.created_at
  LOOP
    IF v_row.reference_type = 'consolidated_invoice' AND v_row.reference_id IS NOT NULL THEN
      IF v_row.invoice_status IS NULL
         OR lower(v_row.invoice_status) IN ('paid', 'cancelled') THEN
        -- Already reflected by the invoice leaving the outstanding total.
        v_skipped_count  := v_skipped_count + 1;
        v_skipped_amount := v_skipped_amount + v_row.amount;
        CONTINUE;
      END IF;

      v_ref_type := 'invoice';
      v_ref_id   := v_row.reference_id;
      v_linked_count  := v_linked_count + 1;
      v_linked_amount := v_linked_amount + v_row.amount;
    ELSE
      IF NOT p_include_unlinked THEN
        v_skipped_count  := v_skipped_count + 1;
        v_skipped_amount := v_skipped_amount + v_row.amount;
        CONTINUE;
      END IF;

      v_ref_type := 'manual';
      v_ref_id   := NULL;
      v_advance_count  := v_advance_count + 1;
      v_advance_amount := v_advance_amount + v_row.amount;
    END IF;

    CONTINUE WHEN p_dry_run;

    -- created_by is FK-constrained; drop it if the original user is gone.
    SELECT u.id INTO v_created_by FROM public.users u WHERE u.id = v_row.created_by;

    PERFORM public.add_credit_ledger_entry(
      p_lab_id,
      v_row.account_id,
      'PAYMENT_CREDIT',
      round(v_row.amount::numeric, 2),
      v_ref_type,
      v_ref_id,
      COALESCE(NULLIF(btrim(v_row.notes), ''), 'Backfilled from billing payment'),
      v_created_by,
      jsonb_build_object(
        'source', 'backfill',
        'payment_mode', lower(COALESCE(NULLIF(btrim(v_row.payment_method), ''), 'other')),
        'reference_no', NULLIF(btrim(v_row.reference_number), ''),
        'received_on', v_row.transaction_date,
        'credit_transaction_id', v_row.id,
        'consolidated_invoice_id', v_ref_id
      )
    );
  END LOOP;

  RETURN jsonb_build_object(
    'dry_run', p_dry_run,
    'include_unlinked', p_include_unlinked,
    'invoice_linked_backfilled', jsonb_build_object('count', v_linked_count, 'amount', v_linked_amount),
    'advances_backfilled', jsonb_build_object('count', v_advance_count, 'amount', v_advance_amount),
    'skipped', jsonb_build_object('count', v_skipped_count, 'amount', v_skipped_amount)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.backfill_account_payment_ledger(uuid, boolean, boolean) FROM PUBLIC;

COMMENT ON FUNCTION public.backfill_account_payment_ledger(uuid, boolean, boolean) IS
  'One-off: creates missing b2b_credit_ledger entries for pre-unification billing payments. Dry run by default. Skips payments on already-settled invoices, since crediting those would double count.';
