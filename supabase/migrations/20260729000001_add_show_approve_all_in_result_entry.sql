-- ============================================================================
-- Lab-level toggle for the "Approve Whole Order" button in the result entry
-- modal. Labs where the technician entering results is also the approver want
-- to finish an order in one place; labs with a separate verification desk do
-- not, so the button stays hidden unless it is switched on.
-- ============================================================================

ALTER TABLE public.labs
  ADD COLUMN IF NOT EXISTS show_approve_all_in_result_entry boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.labs.show_approve_all_in_result_entry IS
'When true, the quick result entry modal shows an "Approve Whole Order" button that verifies every analyte on the order.';
