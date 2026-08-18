-- Default report remarks per test group, plus a per-order toggle.
--
-- Labs repeat the same remark ("Sample received haemolysed", "Kindly correlate
-- clinically") on the same panel for every order. Storing it once on the test
-- group lets result entry prefill it, while the toggle on the result row lets
-- the technician drop it for a specific order without retyping it next time.

ALTER TABLE public.test_groups
  ADD COLUMN IF NOT EXISTS default_report_remark text;

-- Existing rows keep the current behaviour: a remark that was typed before this
-- migration stays printed, a blank one still prints nothing.
ALTER TABLE public.results
  ADD COLUMN IF NOT EXISTS report_remark_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.test_groups.default_report_remark IS
  'Lab-level default text prefilled into the Report Remarks box during result entry.';

COMMENT ON COLUMN public.results.report_remark_enabled IS
  'When false, results.notes is not rendered on the final report even if it has text.';
