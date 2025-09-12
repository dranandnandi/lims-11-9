-- ============================================
-- Optimize for existing results / result_values schema
-- - Attach workflow linkage + lifecycle fields to results
-- - Keep analyte details in result_values (no new test_results table)
-- - Everything is IF NOT EXISTS / guarded for re-runs
-- ============================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1) RESULTS: workflow linkage + lifecycle metadata (add only if missing)
DO $$
BEGIN
  -- Link a result to a workflow instance
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='results' AND column_name='workflow_instance_id'
  ) THEN
    ALTER TABLE public.results
      ADD COLUMN workflow_instance_id uuid;
  END IF;

  -- Technician / reviewer
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='results' AND column_name='technician_id'
  ) THEN
    ALTER TABLE public.results ADD COLUMN technician_id uuid REFERENCES public.users(id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='results' AND column_name='reviewed_by'
  ) THEN
    ALTER TABLE public.results ADD COLUMN reviewed_by uuid REFERENCES public.users(id);
  END IF;

  -- Result date (when finalized or produced)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='results' AND column_name='result_date'
  ) THEN
    ALTER TABLE public.results ADD COLUMN result_date timestamptz DEFAULT now();
  END IF;

  -- Status lifecycle (avoid colliding with any existing enum/text)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='results' AND column_name='status'
  ) THEN
    ALTER TABLE public.results
      ADD COLUMN status text DEFAULT 'pending'
      CHECK (status IN ('pending','completed','reviewed','approved'));
  END IF;

  -- Notes (free text)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='results' AND column_name='notes'
  ) THEN
    ALTER TABLE public.results ADD COLUMN notes text;
  END IF;

  -- Updated_at for touch trigger
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='results' AND column_name='updated_at'
  ) THEN
    ALTER TABLE public.results ADD COLUMN updated_at timestamptz DEFAULT now();
  END IF;
END$$;

-- Add FK separately (guarded) if order_workflow_instances exists
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='order_workflow_instances')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_results_workflow_instance') THEN
    ALTER TABLE public.results
      ADD CONSTRAINT fk_results_workflow_instance
      FOREIGN KEY (workflow_instance_id) REFERENCES public.order_workflow_instances(id);
  END IF;
END$$;

-- 2) RESULT_VALUES: analyte helpers (add only if missing)
DO $$
BEGIN
  -- analyte_id (FK) and analyte_name (denormalized label)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='result_values' AND column_name='analyte_id'
  ) THEN
    ALTER TABLE public.result_values ADD COLUMN analyte_id uuid REFERENCES public.analytes(id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='result_values' AND column_name='analyte_name'
  ) THEN
    ALTER TABLE public.result_values ADD COLUMN analyte_name text;
  END IF;

  -- Units / reference_range if not already present
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='result_values' AND column_name='units'
  ) THEN
    ALTER TABLE public.result_values ADD COLUMN units text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='result_values' AND column_name='reference_range'
  ) THEN
    ALTER TABLE public.result_values ADD COLUMN reference_range text;
  END IF;
END$$;

-- 3) Optional: QC table (only if you don’t already track QC elsewhere)
CREATE TABLE IF NOT EXISTS public.quality_control_results (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_group_id    uuid REFERENCES public.test_groups(id),
  qc_type          text NOT NULL,     -- 'calibration','blank','control','general'
  qc_value         numeric,
  expected_value   numeric,
  tolerance_range  numeric,
  pass_fail        boolean,
  notes            text,
  technician_id    uuid REFERENCES public.users(id),
  created_at       timestamptz DEFAULT now()
);

-- 4) Indexes for common filters
CREATE INDEX IF NOT EXISTS idx_results_workflow_instance    ON public.results(workflow_instance_id);
CREATE INDEX IF NOT EXISTS idx_results_status               ON public.results(status);
CREATE INDEX IF NOT EXISTS idx_results_result_date          ON public.results(result_date);

CREATE INDEX IF NOT EXISTS idx_result_values_result_id      ON public.result_values(result_id);
CREATE INDEX IF NOT EXISTS idx_result_values_analyte_id     ON public.result_values(analyte_id);

CREATE INDEX IF NOT EXISTS idx_qc_results_test_group_id     ON public.quality_control_results(test_group_id);
CREATE INDEX IF NOT EXISTS idx_qc_results_created_at        ON public.quality_control_results(created_at);

-- 5) RLS (guarded: enable if not already; simple permissive policies you can harden later)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                 WHERE n.nspname='public' AND c.relname='results' AND c.relkind='r'
                 AND EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE oid=c.oid AND relrowsecurity)) THEN
    ALTER TABLE public.results ENABLE ROW LEVEL SECURITY;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='results' AND policyname='res_select') THEN
    CREATE POLICY res_select ON public.results
      AS PERMISSIVE FOR SELECT TO PUBLIC
      USING (auth.uid() IS NOT NULL);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='results' AND policyname='res_update') THEN
    CREATE POLICY res_update ON public.results
      AS PERMISSIVE FOR UPDATE TO PUBLIC
      USING (auth.uid() IS NOT NULL);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='results' AND policyname='res_insert') THEN
    CREATE POLICY res_insert ON public.results
      AS PERMISSIVE FOR INSERT TO PUBLIC
      WITH CHECK (auth.uid() IS NOT NULL);
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                 WHERE n.nspname='public' AND c.relname='result_values' AND c.relkind='r'
                 AND EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE oid=c.oid AND relrowsecurity)) THEN
    ALTER TABLE public.result_values ENABLE ROW LEVEL SECURITY;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='result_values' AND policyname='rv_select') THEN
    CREATE POLICY rv_select ON public.result_values
      AS PERMISSIVE FOR SELECT TO PUBLIC
      USING (auth.uid() IS NOT NULL);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='result_values' AND policyname='rv_update') THEN
    CREATE POLICY rv_update ON public.result_values
      AS PERMISSIVE FOR UPDATE TO PUBLIC
      USING (auth.uid() IS NOT NULL);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='result_values' AND policyname='rv_insert') THEN
    CREATE POLICY rv_insert ON public.result_values
      AS PERMISSIVE FOR INSERT TO PUBLIC
      WITH CHECK (auth.uid() IS NOT NULL);
  END IF;
END$$;

-- 6) Touch trigger to maintain updated_at on results
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END$$;

DROP TRIGGER IF EXISTS trg_touch_results ON public.results;
CREATE TRIGGER trg_touch_results
  BEFORE UPDATE ON public.results
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- 7) (Optional) Keep order_workflow_instances.updated_at fresh if you added that column earlier
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='order_workflow_instances' AND column_name='updated_at'
  ) THEN
    DROP TRIGGER IF EXISTS trg_touch_owi ON public.order_workflow_instances;
    CREATE TRIGGER trg_touch_owi
      BEFORE UPDATE ON public.order_workflow_instances
      FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
  END IF;
END$$;

-- 8) Comments
COMMENT ON COLUMN public.results.workflow_instance_id IS 'Links a reportable result to its workflow run (order_workflow_instances.id)';
COMMENT ON COLUMN public.result_values.analyte_id        IS 'FK to analytes for precise identity; analyte_name kept as denormalized label';

