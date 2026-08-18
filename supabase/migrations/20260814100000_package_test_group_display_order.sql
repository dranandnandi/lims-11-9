-- Package-level ordering for the test groups inside a health package.
-- Test groups already carry a lab-wide report priority; this column lets each
-- package decide the sequence of its own contents independently of that.
-- Idempotent: safe to re-run (the backfill only touches rows still NULL).

ALTER TABLE public.package_test_groups
  ADD COLUMN IF NOT EXISTS display_order integer;

-- Backfill with the order users see today (alphabetical by test group name),
-- so existing packages look unchanged until someone reorders them.
WITH ranked AS (
  SELECT ptg.id,
         (ROW_NUMBER() OVER (
            PARTITION BY ptg.package_id
            ORDER BY tg.name NULLS LAST, ptg.created_at, ptg.id
          ))::int - 1 AS seq
  FROM public.package_test_groups ptg
  LEFT JOIN public.test_groups tg ON tg.id = ptg.test_group_id
  WHERE ptg.display_order IS NULL
)
UPDATE public.package_test_groups p
SET display_order = ranked.seq
FROM ranked
WHERE p.id = ranked.id;

ALTER TABLE public.package_test_groups
  ALTER COLUMN display_order SET DEFAULT 0;

ALTER TABLE public.package_test_groups
  ALTER COLUMN display_order SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_package_test_groups_package_order
  ON public.package_test_groups (package_id, display_order);

COMMENT ON COLUMN public.package_test_groups.display_order IS
  'Zero-based position of this test group within the package (set in the package editor).';
