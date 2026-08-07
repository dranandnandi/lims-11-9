-- Patient Online Payment: shareable pay links, live QR, gateway settlement
-- Extends the existing B2B payment gateway system (20260525_payment_gateway_system.sql)
-- so the same CCAvenue/Razorpay plumbing can collect money from patients.
-- Date: 2026-08-01

-- ============================================
-- 1. WIDEN b2b_payment_attempts TO CARRY PATIENT PAYMENTS
-- One reconciliation surface, one webhook handler.
-- ============================================

-- account_id was NOT NULL because only B2B accounts could pay.
ALTER TABLE public.b2b_payment_attempts
  ALTER COLUMN account_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'b2b_payment_attempts' AND column_name = 'payer_type'
  ) THEN
    ALTER TABLE public.b2b_payment_attempts
      ADD COLUMN payer_type text NOT NULL DEFAULT 'b2b_account'
        CHECK (payer_type IN ('b2b_account', 'patient'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'b2b_payment_attempts' AND column_name = 'invoice_id'
  ) THEN
    ALTER TABLE public.b2b_payment_attempts
      ADD COLUMN invoice_id uuid REFERENCES public.invoices(id) ON DELETE SET NULL,
      ADD COLUMN order_id   uuid REFERENCES public.orders(id)   ON DELETE SET NULL,
      ADD COLUMN patient_id uuid REFERENCES public.patients(id) ON DELETE SET NULL,
      ADD COLUMN payer_name  text,
      ADD COLUMN payer_phone text,
      ADD COLUMN payer_email text;
  END IF;
END $$;

-- Allow the new purpose alongside the existing B2B ones.
ALTER TABLE public.b2b_payment_attempts
  DROP CONSTRAINT IF EXISTS b2b_payment_attempts_payment_purpose_check;

ALTER TABLE public.b2b_payment_attempts
  ADD CONSTRAINT b2b_payment_attempts_payment_purpose_check
  CHECK (payment_purpose IN (
    'credit_topup',
    'order_payment',
    'shortfall_payment',
    'advance_payment',
    'patient_invoice'
  ));

-- A B2B attempt still needs an account; a patient attempt needs something to settle against.
ALTER TABLE public.b2b_payment_attempts
  DROP CONSTRAINT IF EXISTS b2b_payment_attempts_payer_target_check;

ALTER TABLE public.b2b_payment_attempts
  ADD CONSTRAINT b2b_payment_attempts_payer_target_check
  CHECK (
    (payer_type = 'b2b_account' AND account_id IS NOT NULL)
    OR
    (payer_type = 'patient' AND (invoice_id IS NOT NULL OR order_id IS NOT NULL))
  );

CREATE INDEX IF NOT EXISTS idx_b2b_payment_attempts_invoice
  ON public.b2b_payment_attempts(invoice_id)
  WHERE invoice_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_b2b_payment_attempts_payer_type
  ON public.b2b_payment_attempts(payer_type, status);

-- ============================================
-- 2. PAYMENT LINKS
-- A short-lived, tokenised URL. This is what the QR encodes and what
-- WhatsApp carries. CCAvenue's own integration is an encrypted form-POST
-- and produces no shareable URL of its own.
-- ============================================

CREATE TABLE IF NOT EXISTS public.payment_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lab_id uuid NOT NULL REFERENCES public.labs(id) ON DELETE CASCADE,

  -- Opaque bearer token; the only thing the public page needs.
  token text NOT NULL UNIQUE,

  -- What is being paid for (at least one of invoice/order).
  invoice_id uuid REFERENCES public.invoices(id) ON DELETE CASCADE,
  order_id   uuid REFERENCES public.orders(id)   ON DELETE CASCADE,
  patient_id uuid REFERENCES public.patients(id) ON DELETE SET NULL,

  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  currency text NOT NULL DEFAULT 'INR',

  -- Prefill + WhatsApp target
  payer_name  text,
  payer_phone text,
  payer_email text,

  -- Set on first "Pay Now" click
  payment_attempt_id uuid REFERENCES public.b2b_payment_attempts(id) ON DELETE SET NULL,

  status text NOT NULL DEFAULT 'active' CHECK (status IN (
    'active',     -- issued, not yet paid
    'paid',       -- settled, payments row written
    'failed',     -- last attempt failed; still re-openable until expiry
    'expired',
    'cancelled'
  )),

  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),

  -- Engagement tracking
  opened_at timestamptz,
  open_count integer NOT NULL DEFAULT 0,

  -- Delivery tracking (mirrors invoices.whatsapp_sent_*)
  whatsapp_sent_at timestamptz,
  whatsapp_sent_to text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES public.users(id),

  CONSTRAINT payment_links_target_check CHECK (invoice_id IS NOT NULL OR order_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_payment_links_token   ON public.payment_links(token);
CREATE INDEX IF NOT EXISTS idx_payment_links_invoice ON public.payment_links(invoice_id);
CREATE INDEX IF NOT EXISTS idx_payment_links_lab     ON public.payment_links(lab_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_links_sweep   ON public.payment_links(status, expires_at);

-- Reuse the timestamp trigger from the gateway migration.
DROP TRIGGER IF EXISTS trg_payment_links_updated ON public.payment_links;
CREATE TRIGGER trg_payment_links_updated
  BEFORE UPDATE ON public.payment_links
  FOR EACH ROW EXECUTE FUNCTION public.update_payment_gateway_timestamp();

-- ============================================
-- 3. DOUBLE-SETTLEMENT GUARD ON payments
-- The redirect callback and the server-to-server webhook can both fire
-- for the same transaction. The unique index makes settlement idempotent.
-- ============================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'payments' AND column_name = 'payment_attempt_id'
  ) THEN
    ALTER TABLE public.payments
      ADD COLUMN payment_attempt_id uuid REFERENCES public.b2b_payment_attempts(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_attempt_unique
  ON public.payments(payment_attempt_id)
  WHERE payment_attempt_id IS NOT NULL;

-- ============================================
-- 4. GATEWAY SETTINGS FOR PATIENT PAYMENTS
-- ============================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'lab_payment_gateways' AND column_name = 'allow_patient_payments'
  ) THEN
    ALTER TABLE public.lab_payment_gateways
      ADD COLUMN allow_patient_payments boolean NOT NULL DEFAULT false,
      ADD COLUMN payment_link_expiry_minutes integer NOT NULL DEFAULT 1440
        CHECK (payment_link_expiry_minutes BETWEEN 5 AND 43200);
  END IF;
END $$;

-- ============================================
-- 5. SETTLEMENT
-- Writes the real payments row and re-derives invoice status.
-- Mirrors the client-side logic in src/utils/supabase.ts (database.payments.create)
-- so both paths agree on Paid / Partial / Unpaid.
-- ============================================

CREATE OR REPLACE FUNCTION public.settle_patient_payment(p_attempt_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_attempt        public.b2b_payment_attempts%ROWTYPE;
  v_invoice_id     uuid;
  v_location_id    uuid;
  v_invoice_total  numeric;
  v_payment_id     uuid;
  v_method         text;
  v_reference      text;
  v_total_paid     numeric;
  v_new_status     text;
BEGIN
  SELECT * INTO v_attempt
  FROM public.b2b_payment_attempts
  WHERE id = p_attempt_id;

  IF NOT FOUND THEN
    RAISE WARNING '[settle_patient_payment] attempt % not found', p_attempt_id;
    RETURN NULL;
  END IF;

  IF v_attempt.payer_type <> 'patient' OR v_attempt.status <> 'success' THEN
    -- B2B attempts settle through add_credit_ledger_entry instead.
    RETURN NULL;
  END IF;

  -- Resolve the invoice: explicit link first, else the order's invoice with a balance.
  v_invoice_id := v_attempt.invoice_id;

  IF v_invoice_id IS NULL AND v_attempt.order_id IS NOT NULL THEN
    SELECT i.id INTO v_invoice_id
    FROM public.invoices i
    WHERE i.order_id = v_attempt.order_id
    ORDER BY i.created_at DESC
    LIMIT 1;
  END IF;

  IF v_invoice_id IS NULL THEN
    RAISE WARNING '[settle_patient_payment] no invoice for attempt %', p_attempt_id;
    RETURN NULL;
  END IF;

  SELECT COALESCE(NULLIF(i.total_after_discount, 0), i.total), i.location_id
    INTO v_invoice_total, v_location_id
  FROM public.invoices i
  WHERE i.id = v_invoice_id;

  -- Map the gateway's payment mode onto the app's payment_method vocabulary
  -- (cash / card / upi / bank are what PaymentCapture and the reports use).
  v_method := lower(COALESCE(v_attempt.payment_method, ''));
  v_method := CASE
    WHEN v_method LIKE '%upi%'                                     THEN 'upi'
    WHEN v_method LIKE '%card%'                                    THEN 'card'
    WHEN v_method LIKE '%net%' OR v_method LIKE '%bank%'            THEN 'bank'
    WHEN v_method LIKE '%wallet%'                                  THEN 'online'
    ELSE 'online'
  END;

  v_reference := COALESCE(
    v_attempt.gateway_tracking_id,
    v_attempt.gateway_payment_id,
    v_attempt.bank_ref_number,
    v_attempt.gateway_order_id
  );

  -- Idempotent: the partial unique index absorbs a duplicate callback/webhook.
  INSERT INTO public.payments (
    invoice_id, amount, payment_method, payment_reference,
    payment_date, lab_id, location_id, payment_attempt_id, notes
  )
  VALUES (
    v_invoice_id,
    v_attempt.amount,
    v_method,
    v_reference,
    COALESCE(v_attempt.completed_at, now())::date,
    v_attempt.lab_id,
    v_location_id,
    v_attempt.id,
    'Online payment via ' || COALESCE(v_attempt.provider, 'gateway')
  )
  ON CONFLICT (payment_attempt_id) WHERE payment_attempt_id IS NOT NULL
  DO NOTHING
  RETURNING id INTO v_payment_id;

  -- Recompute from the ledger of payments rather than incrementing, so a
  -- duplicate call converges on the same answer.
  SELECT COALESCE(SUM(p.amount), 0) INTO v_total_paid
  FROM public.payments p
  WHERE p.invoice_id = v_invoice_id;

  v_new_status := CASE
    WHEN v_total_paid >= COALESCE(v_invoice_total, 0) THEN 'Paid'
    WHEN v_total_paid > 0                             THEN 'Partial'
    ELSE 'Unpaid'
  END;

  UPDATE public.invoices
  SET status         = v_new_status::invoice_status,
      amount_paid    = v_total_paid,
      payment_method = v_method,
      payment_date   = COALESCE(v_attempt.completed_at, now())::date,
      updated_at     = now()
  WHERE id = v_invoice_id;

  -- Close out the link that produced this attempt.
  UPDATE public.payment_links
  SET status = 'paid'
  WHERE payment_attempt_id = p_attempt_id
    AND status <> 'paid';

  RETURN v_payment_id;
END;
$$;

COMMENT ON FUNCTION public.settle_patient_payment(uuid) IS
  'Writes the payments row for a successful patient gateway payment and re-derives invoice status. Idempotent.';

-- Patient portal self-service: the caller's own unpaid invoices with a live
-- balance. SECURITY DEFINER so the portal never needs read access to the
-- invoices/payments tables themselves. Identity comes from the JWT, not a
-- parameter, so a portal user cannot ask about anyone else.
CREATE OR REPLACE FUNCTION public.patient_portal_outstanding_invoices()
RETURNS TABLE (
  invoice_id     uuid,
  invoice_number text,
  invoice_date   date,
  lab_id         uuid,
  order_id       uuid,
  total          numeric,
  paid           numeric,
  balance        numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_patient_id uuid;
BEGIN
  IF (auth.jwt() -> 'user_metadata' ->> 'role') IS DISTINCT FROM 'patient' THEN
    RETURN;
  END IF;

  v_patient_id := NULLIF(auth.jwt() -> 'user_metadata' ->> 'patient_id', '')::uuid;
  IF v_patient_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    i.id,
    i.invoice_number::text,
    i.invoice_date,
    i.lab_id,
    i.order_id,
    COALESCE(NULLIF(i.total_after_discount, 0), i.total)                       AS total,
    COALESCE(pay.total_paid, 0)                                                AS paid,
    COALESCE(NULLIF(i.total_after_discount, 0), i.total) - COALESCE(pay.total_paid, 0) AS balance
  FROM public.invoices i
  LEFT JOIN LATERAL (
    SELECT SUM(p.amount) AS total_paid
    FROM public.payments p
    WHERE p.invoice_id = i.id
  ) pay ON true
  WHERE i.patient_id = v_patient_id
    AND i.invoice_type = 'patient'
    AND COALESCE(NULLIF(i.total_after_discount, 0), i.total) - COALESCE(pay.total_paid, 0) > 0.01
  ORDER BY i.invoice_date DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.patient_portal_outstanding_invoices() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.patient_portal_outstanding_invoices() TO authenticated;

-- Sweep links past their expiry. Safe to call repeatedly.
CREATE OR REPLACE FUNCTION public.expire_stale_payment_links()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE public.payment_links
  SET status = 'expired'
  WHERE status IN ('active', 'failed')
    AND expires_at < now();

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- ============================================
-- 6. RLS
-- The public /pay page never reads these tables directly — it goes through
-- the pay-link edge function using the service role, with the token as bearer.
-- ============================================

ALTER TABLE public.payment_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Lab users can view payment links" ON public.payment_links;
CREATE POLICY "Lab users can view payment links"
  ON public.payment_links FOR SELECT
  TO authenticated
  USING (lab_id IN (SELECT lab_id FROM public.users WHERE id = auth.uid()));

DROP POLICY IF EXISTS "Lab users can manage payment links" ON public.payment_links;
CREATE POLICY "Lab users can manage payment links"
  ON public.payment_links FOR ALL
  TO authenticated
  USING (lab_id IN (SELECT lab_id FROM public.users WHERE id = auth.uid()))
  WITH CHECK (lab_id IN (SELECT lab_id FROM public.users WHERE id = auth.uid()));

-- Patient portal users see only their own links.
DROP POLICY IF EXISTS "Patients can view own payment links" ON public.payment_links;
CREATE POLICY "Patients can view own payment links"
  ON public.payment_links FOR SELECT
  TO authenticated
  USING (
    (auth.jwt() -> 'user_metadata' ->> 'role') = 'patient'
    AND patient_id = ((auth.jwt() -> 'user_metadata' ->> 'patient_id')::text)::uuid
  );

-- Patient portal users see only their own payment attempts.
DROP POLICY IF EXISTS "Patients can view own payment attempts" ON public.b2b_payment_attempts;
CREATE POLICY "Patients can view own payment attempts"
  ON public.b2b_payment_attempts FOR SELECT
  TO authenticated
  USING (
    (auth.jwt() -> 'user_metadata' ->> 'role') = 'patient'
    AND patient_id = ((auth.jwt() -> 'user_metadata' ->> 'patient_id')::text)::uuid
  );

GRANT SELECT, INSERT, UPDATE ON public.payment_links TO authenticated;
