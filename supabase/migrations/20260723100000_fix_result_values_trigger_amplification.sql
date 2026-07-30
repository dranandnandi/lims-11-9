-- Fix result_values INSERT statement timeout (SQLSTATE 57014).
--
-- Production (drifted history) carried two PER-ROW triggers on result_values
-- that do not exist in any repo migration -- they were applied by hand via the
-- dashboard SQL editor:
--
--   trg_rv_recalc_status      AFTER INSERT/UPDATE/DELETE ROW
--                             -> _bump_order_status_on_result_values
--                             -> recalc_order_status(order_id)  [maintains orders.workflow_status]
--
--   trg_rv_inherit_panel_keys AFTER INSERT/UPDATE ROW
--                             -> rv_inherit_panel_keys
--                             -> UPDATE result_values SET order_test_id/test_group_id/lab_id ...
--
-- On a direct REST insert (app.bulk_result_entry is NOT set), a single
-- multi-analyte panel submit (e.g. 20-row urinalysis) amplifies badly:
--   * trg_rv_recalc_status runs recalc_order_status() once PER inserted row, and
--   * trg_rv_inherit_panel_keys issues a single-row self-UPDATE per inserted row,
--     which RE-FIRES the whole AFTER-UPDATE cascade (another recalc_order_status()
--     per row + the AFTER UPDATE statement trigger per row).
-- Net: ~40 recalc_order_status() calls (each scanning the v_order_progress
-- aggregate) + ~21 check_and_update_order_status() calls for 20 rows, exceeding
-- the authenticated role's 8s statement_timeout.
--
-- The repo already ships the intended design: a single STATEMENT-level trigger
-- (trigger_auto_update_order_status_on_result_values_insert) that recalculates
-- order status once per affected order. This migration folds the two columns the
-- per-row triggers maintained (orders.workflow_status and result_values.lab_id)
-- into statement/BEFORE-level work, then drops the redundant per-row triggers.

-- 1. lab_id was the only column rv_inherit_panel_keys filled that the existing
--    BEFORE-INSERT autofill triggers (fill_result_value_links / fn_fill_order_test_id
--    / fn_auto_fill_order_test_id) do not. Fill it BEFORE INSERT so no self-UPDATE
--    cascade is needed. (Bulk entry supplies lab_id directly; this only acts when
--    lab_id is missing.)
CREATE OR REPLACE FUNCTION public.fill_result_value_lab_id()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.lab_id IS NULL AND NEW.result_id IS NOT NULL THEN
    SELECT r.lab_id
      INTO NEW.lab_id
      FROM public.results r
     WHERE r.id = NEW.result_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_fill_result_value_lab_id ON public.result_values;
CREATE TRIGGER trg_fill_result_value_lab_id
  BEFORE INSERT ON public.result_values
  FOR EACH ROW
  EXECUTE FUNCTION public.fill_result_value_lab_id();

-- 2. Fold recalc_order_status() (orders.workflow_status) into the existing
--    statement-level INSERT/UPDATE trigger so it runs ONCE per affected order
--    per statement instead of once per row. Bulk entry is untouched: it still
--    short-circuits after the verification rollup (the bulk RPC recalcs itself).
CREATE OR REPLACE FUNCTION public.auto_update_order_status_for_result_values_statement()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  rec RECORD;
BEGIN
  -- Roll result verification up once per affected result (bulk and direct writes).
  WITH affected_results AS (
    SELECT DISTINCT nr.result_id
    FROM new_rows nr
    WHERE nr.result_id IS NOT NULL
  ),
  verification AS (
    SELECT
      rv.result_id,
      COUNT(*) AS expected,
      COUNT(*) FILTER (
        WHERE COALESCE(rv.verify_status, 'pending') = 'approved'
      ) AS approved,
      BOOL_AND(
        COALESCE(rv.verify_status, 'pending') = 'approved'
      ) AS all_ok
    FROM public.result_values rv
    JOIN affected_results ar ON ar.result_id = rv.result_id
    GROUP BY rv.result_id
  )
  UPDATE public.results r
     SET manually_verified = v.all_ok,
         verification_status = CASE
           WHEN v.expected = 0 OR v.approved = 0
             THEN 'pending_verification'
           WHEN v.approved < v.expected
             THEN 'needs_clarification'
           ELSE 'verified'
         END,
         verified_at = CASE
           WHEN v.all_ok AND r.verified_at IS NULL THEN now()
           ELSE r.verified_at
         END
    FROM verification v
   WHERE r.id = v.result_id;

  IF current_setting('app.bulk_result_entry', true) = 'on' THEN
    RETURN NULL;
  END IF;

  FOR rec IN
    SELECT DISTINCT COALESCE(nr.order_id, r.order_id) AS order_id
    FROM new_rows nr
    LEFT JOIN public.results r ON r.id = nr.result_id
    WHERE COALESCE(nr.order_id, r.order_id) IS NOT NULL
  LOOP
    -- workflow_status (previously trg_rv_recalc_status, per row) + status,
    -- both once per order per statement.
    PERFORM public.recalc_order_status(rec.order_id);
    PERFORM public.check_and_update_order_status(rec.order_id);
  END LOOP;

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.auto_update_order_status_for_result_values_statement()
IS 'Once per statement: rolls up result verification per affected result, then recalculates orders.workflow_status and orders.status once per affected order. Replaces the per-row trg_rv_recalc_status amplification.';

-- 3. Preserve workflow_status recalc on DELETE (the dropped trg_rv_recalc_status
--    also fired on DELETE). Statement-level, once per affected order.
CREATE OR REPLACE FUNCTION public.auto_update_order_status_on_result_values_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  rec RECORD;
BEGIN
  IF current_setting('app.bulk_result_entry', true) = 'on' THEN
    RETURN NULL;
  END IF;

  FOR rec IN
    SELECT DISTINCT COALESCE(orow.order_id, r.order_id) AS order_id
    FROM old_rows orow
    LEFT JOIN public.results r ON r.id = orow.result_id
    WHERE COALESCE(orow.order_id, r.order_id) IS NOT NULL
  LOOP
    PERFORM public.recalc_order_status(rec.order_id);
  END LOOP;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trigger_auto_update_order_status_on_result_values_delete ON public.result_values;
CREATE TRIGGER trigger_auto_update_order_status_on_result_values_delete
  AFTER DELETE ON public.result_values
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.auto_update_order_status_on_result_values_delete();

-- 4. Drop the redundant per-row drift triggers that caused the amplification.
--    Their work is now handled once per statement (steps 2 and 3) and the lab_id
--    fill is handled BEFORE INSERT (step 1).
DROP TRIGGER IF EXISTS trg_rv_recalc_status ON public.result_values;
DROP TRIGGER IF EXISTS trg_rv_inherit_panel_keys ON public.result_values;
