-- Per-lab cutoff for the TAT alert floater.
-- Orders breached longer ago than this are stale/abandoned and are dropped from
-- the alert panel so they do not crowd out breaches the team can still act on.
-- Previously hardcoded to 72 in src/components/Orders/TATFloater.tsx.

ALTER TABLE public.labs
  ADD COLUMN IF NOT EXISTS tat_alert_max_overdue_hours integer NOT NULL DEFAULT 72;

ALTER TABLE public.labs
  DROP CONSTRAINT IF EXISTS labs_tat_alert_max_overdue_hours_check;

ALTER TABLE public.labs
  ADD CONSTRAINT labs_tat_alert_max_overdue_hours_check
  CHECK (tat_alert_max_overdue_hours > 0 AND tat_alert_max_overdue_hours <= 720);

COMMENT ON COLUMN public.labs.tat_alert_max_overdue_hours IS
  'TAT alert floater: hide orders overdue by more than this many hours. Default 72 (3 days).';
