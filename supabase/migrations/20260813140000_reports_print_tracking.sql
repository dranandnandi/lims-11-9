-- Track when a report's print copy was actually opened/printed so the Reports
-- page can show a "Printed" status instead of leaving staff guessing whether a
-- hard copy was already taken out.

ALTER TABLE public.reports
  ADD COLUMN IF NOT EXISTS printed_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS printed_by uuid,
  ADD COLUMN IF NOT EXISTS print_count integer NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'reports_printed_by_fkey'
  ) THEN
    ALTER TABLE public.reports
      ADD CONSTRAINT reports_printed_by_fkey
      FOREIGN KEY (printed_by) REFERENCES public.users(id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_reports_printed_at
  ON public.reports (printed_at DESC)
  WHERE printed_at IS NOT NULL;

COMMENT ON COLUMN public.reports.printed_at IS 'Last time a print copy of this report was opened for printing from the app';
COMMENT ON COLUMN public.reports.printed_by IS 'User who last printed this report';
COMMENT ON COLUMN public.reports.print_count IS 'How many times the print copy has been opened for printing';
