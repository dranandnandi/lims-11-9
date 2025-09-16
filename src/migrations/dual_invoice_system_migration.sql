-- ============================================================================
-- Migration: Dual Invoicing System (Patient vs Account + Monthly Consolidation)
-- Safe for DEV: minimal triggers; NO new RLS policies here.
-- Order of ops:
--   1) Create consolidated_invoices
--   2) Alter invoices to add invoice_type, billing_period, account_id, consolidated_invoice_id
--   3) Indexes
--   4) Lightweight updated_at trigger on consolidated_invoices
--   5) Backfill existing invoice rows (invoice_type + billing_period)
-- ============================================================================

-- 1) Create consolidated_invoices FIRST (so FK from invoices can reference it)
CREATE TABLE IF NOT EXISTS public.consolidated_invoices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lab_id          uuid NOT NULL REFERENCES public.labs(id) ON DELETE CASCADE,
  account_id      uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  account_name    text NOT NULL,
  billing_period  text NOT NULL, -- YYYY-MM
  subtotal        numeric(12,2) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  total_discount  numeric(12,2) NOT NULL DEFAULT 0 CHECK (total_discount >= 0),
  tax             numeric(12,2) NOT NULL DEFAULT 0 CHECK (tax >= 0),
  total           numeric(12,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
  status          text NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft','Sent','Paid','Overdue')),
  invoice_date    timestamptz NOT NULL DEFAULT now(),
  due_date        timestamptz NOT NULL DEFAULT (now() + interval '15 days'),
  payment_date    timestamptz,
  notes           text,
  invoice_count   integer NOT NULL DEFAULT 0 CHECK (invoice_count >= 0),
  patient_count   integer NOT NULL DEFAULT 0 CHECK (patient_count >= 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (lab_id, account_id, billing_period)
);

-- 2) Add new columns to invoices (idempotent)
DO $$
BEGIN
  -- invoice_type: 'patient' or 'account'
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'invoices' AND column_name = 'invoice_type'
  ) THEN
    ALTER TABLE public.invoices
      ADD COLUMN invoice_type text NOT NULL DEFAULT 'patient'
      CHECK (invoice_type IN ('patient','account'));
  END IF;

  -- billing_period: YYYY-MM (only for account invoices)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'invoices' AND column_name = 'billing_period'
  ) THEN
    ALTER TABLE public.invoices
      ADD COLUMN billing_period text;
  END IF;

  -- account_id: link to B2B account (if applicable)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'invoices' AND column_name = 'account_id'
  ) THEN
    ALTER TABLE public.invoices
      ADD COLUMN account_id uuid REFERENCES public.accounts(id) ON DELETE SET NULL;
  END IF;

  -- consolidated_invoice_id: link to consolidated_invoices
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'invoices' AND column_name = 'consolidated_invoice_id'
  ) THEN
    ALTER TABLE public.invoices
      ADD COLUMN consolidated_invoice_id uuid REFERENCES public.consolidated_invoices(id) ON DELETE SET NULL;
  END IF;
END $$;

-- 3) Indexes (idempotent)
CREATE INDEX IF NOT EXISTS idx_invoices_invoice_type        ON public.invoices(invoice_type);
CREATE INDEX IF NOT EXISTS idx_invoices_billing_period      ON public.invoices(billing_period);
CREATE INDEX IF NOT EXISTS idx_invoices_account_id          ON public.invoices(account_id);
CREATE INDEX IF NOT EXISTS idx_invoices_consolidated_id     ON public.invoices(consolidated_invoice_id);

CREATE INDEX IF NOT EXISTS idx_coninv_lab_period            ON public.consolidated_invoices(lab_id, billing_period);
CREATE INDEX IF NOT EXISTS idx_coninv_account_period        ON public.consolidated_invoices(account_id, billing_period);

-- 4) Minimal, useful trigger: keep updated_at current on consolidated_invoices
CREATE OR REPLACE FUNCTION public._touch_updated_at_coninv()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS trg_touch_updated_at_coninv ON public.consolidated_invoices;
CREATE TRIGGER trg_touch_updated_at_coninv
BEFORE UPDATE ON public.consolidated_invoices
FOR EACH ROW
EXECUTE FUNCTION public._touch_updated_at_coninv();

-- 5) Backfill existing invoices (safe guards)
--    a) Set invoice_type deterministically
UPDATE public.invoices
SET invoice_type = CASE
  WHEN account_id IS NOT NULL AND payment_type IN ('credit','corporate','insurance') THEN 'account'
  ELSE 'patient'
END
WHERE invoice_type IS NULL OR invoice_type NOT IN ('patient','account');

--    b) Set billing_period for account invoices
UPDATE public.invoices
SET billing_period = COALESCE(TO_CHAR(invoice_date::date, 'YYYY-MM'), TO_CHAR(now()::date, 'YYYY-MM'))
WHERE invoice_type = 'account' AND billing_period IS NULL;

-- 6) (Optional) Documentation comments
COMMENT ON COLUMN public.invoices.invoice_type            IS 'patient = direct to patient; account = billed to B2B account';
COMMENT ON COLUMN public.invoices.billing_period          IS 'YYYY-MM; used for monthly consolidation when invoice_type=account';
COMMENT ON COLUMN public.invoices.consolidated_invoice_id IS 'FK to consolidated_invoices.id for account monthly bills';
COMMENT ON TABLE  public.consolidated_invoices            IS 'Monthly consolidated invoices aggregating multiple patient invoices for a B2B account';
COMMENT ON COLUMN public.consolidated_invoices.billing_period IS 'YYYY-MM for the consolidated cycle';
COMMENT ON COLUMN public.consolidated_invoices.invoice_count  IS 'Number of individual invoices in this consolidation';
COMMENT ON COLUMN public.consolidated_invoices.patient_count  IS 'Unique patients counted across consolidated invoices';
