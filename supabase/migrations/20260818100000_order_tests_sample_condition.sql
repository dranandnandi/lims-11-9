-- Sample condition for tests that live only on order_tests.
--
-- Orders created through the current order form insert into order_tests, not
-- order_test_groups, so the per-order sample condition added in
-- 20260619090000_sample_conditions.sql had nowhere to be stored for them and
-- result entry could only show it read-only. Mirror the column here so the
-- selection can be saved from whichever row the order actually has.

ALTER TABLE public.order_tests
  ADD COLUMN IF NOT EXISTS sample_condition text;

COMMENT ON COLUMN public.order_tests.sample_condition IS
'Condition selected for this test on this order (mirrors order_test_groups.sample_condition for orders that only have order_tests rows). Stored historically for report headings.';

CREATE INDEX IF NOT EXISTS idx_order_tests_sample_condition
ON public.order_tests(order_id, test_group_id, sample_condition)
WHERE sample_condition IS NOT NULL;

-- Same defaulting rule as order_test_groups: an unset condition falls back to
-- the test group master default.
CREATE OR REPLACE FUNCTION public.set_default_order_test_sample_condition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.test_group_id IS NOT NULL
     AND NULLIF(btrim(COALESCE(NEW.sample_condition, '')), '') IS NULL THEN
    SELECT NULLIF(btrim(default_sample_condition), '')
    INTO NEW.sample_condition
    FROM public.test_groups
    WHERE id = NEW.test_group_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_set_default_order_test_sample_condition ON public.order_tests;
CREATE TRIGGER trg_set_default_order_test_sample_condition
BEFORE INSERT OR UPDATE OF test_group_id, sample_condition ON public.order_tests
FOR EACH ROW
EXECUTE FUNCTION public.set_default_order_test_sample_condition();
