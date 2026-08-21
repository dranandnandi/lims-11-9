-- Deterministic, non-AI reference range rules.
--
-- Why: until now a lab analyte carried a single reference_range string (plus two
-- legacy gender columns that only the analyzer and flag passes ever read). Age,
-- sample condition (fasting / post-prandial / random) and pregnancy had no
-- representation at all outside the AI resolver, which in practice short-circuits
-- to the saved lab range whenever one exists.
--
-- This table lets a lab express those rules structurally. Resolution is pure
-- specificity scoring in application code (see referenceRangeResolver) -- no LLM,
-- no network call. When no rule matches, the legacy columns remain the fallback,
-- so labs that never configure a rule keep today's behaviour exactly.

CREATE TABLE IF NOT EXISTS public.lab_analyte_reference_ranges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lab_id uuid NOT NULL REFERENCES public.labs(id) ON DELETE CASCADE,
  lab_analyte_id uuid NOT NULL REFERENCES public.lab_analytes(id) ON DELETE CASCADE,

  -- Predicates. NULL always means "matches anything" for that dimension.
  gender text,
  age_min_days integer,
  age_max_days integer,
  sample_condition text,
  pregnancy boolean,

  -- What the rule yields.
  range_text text NOT NULL,
  range_low numeric,
  range_high numeric,
  range_operator text,
  low_critical numeric,
  high_critical numeric,

  priority integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  notes text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT lab_analyte_ref_range_gender_check
    CHECK (gender IS NULL OR gender IN ('male', 'female', 'other')),
  CONSTRAINT lab_analyte_ref_range_operator_check
    CHECK (range_operator IS NULL OR range_operator IN ('range', 'less_than', 'greater_than', 'single')),
  CONSTRAINT lab_analyte_ref_range_age_bounds_check
    CHECK (age_min_days IS NULL OR age_max_days IS NULL OR age_min_days <= age_max_days),
  CONSTRAINT lab_analyte_ref_range_age_nonneg_check
    CHECK ((age_min_days IS NULL OR age_min_days >= 0) AND (age_max_days IS NULL OR age_max_days >= 0)),
  CONSTRAINT lab_analyte_ref_range_text_check
    CHECK (btrim(range_text) <> '')
);

COMMENT ON TABLE public.lab_analyte_reference_ranges IS
'Structured reference range rules per lab analyte. Predicate columns are NULL-means-any; the resolver picks the highest specificity score (sample_condition 8, gender 4, age 2, pregnancy 1), tie-broken by priority desc, then narrowest age band, then created_at.';

COMMENT ON COLUMN public.lab_analyte_reference_ranges.gender IS
'Normalized to male/female/other. NULL matches any gender.';
COMMENT ON COLUMN public.lab_analyte_reference_ranges.age_min_days IS
'Inclusive lower bound of the age band in DAYS. Days is the storage unit so year/month/day-aged patients normalize to one scale. NULL = unbounded below.';
COMMENT ON COLUMN public.lab_analyte_reference_ranges.age_max_days IS
'Inclusive upper bound of the age band in DAYS. NULL = unbounded above.';
COMMENT ON COLUMN public.lab_analyte_reference_ranges.sample_condition IS
'Matched case-insensitively against order_test_groups.sample_condition / order_tests.sample_condition. Values should come from the test group sample_condition_options. NULL matches any condition.';
COMMENT ON COLUMN public.lab_analyte_reference_ranges.pregnancy IS
'TRUE = pregnant only, FALSE = non-pregnant only, NULL = any.';
COMMENT ON COLUMN public.lab_analyte_reference_ranges.range_text IS
'Report-facing text, e.g. "70 - 100" or "< 140". This is what lands in result_values.reference_range.';
COMMENT ON COLUMN public.lab_analyte_reference_ranges.range_low IS
'Optional precomputed numeric bound so flagging does not depend on re-parsing range_text. When NULL the resolver falls back to parsing range_text.';
COMMENT ON COLUMN public.lab_analyte_reference_ranges.priority IS
'Manual tie-break between rules of equal specificity. Higher wins.';

CREATE INDEX IF NOT EXISTS idx_lab_analyte_ref_ranges_analyte
  ON public.lab_analyte_reference_ranges (lab_analyte_id)
  WHERE is_active;

CREATE INDEX IF NOT EXISTS idx_lab_analyte_ref_ranges_lab
  ON public.lab_analyte_reference_ranges (lab_id, lab_analyte_id);

-- Two identical predicate sets on one analyte are always a configuration error:
-- the resolver would have to break the tie arbitrarily. Reject them up front.
CREATE UNIQUE INDEX IF NOT EXISTS uq_lab_analyte_ref_range_predicates
  ON public.lab_analyte_reference_ranges (
    lab_analyte_id,
    COALESCE(gender, '__any__'),
    COALESCE(age_min_days, -1),
    COALESCE(age_max_days, -1),
    lower(COALESCE(NULLIF(btrim(sample_condition), ''), '__any__')),
    COALESCE(pregnancy::text, '__any__')
  );

CREATE OR REPLACE FUNCTION public.touch_lab_analyte_reference_ranges()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_touch_lab_analyte_reference_ranges ON public.lab_analyte_reference_ranges;
CREATE TRIGGER trg_touch_lab_analyte_reference_ranges
  BEFORE UPDATE ON public.lab_analyte_reference_ranges
  FOR EACH ROW EXECUTE FUNCTION public.touch_lab_analyte_reference_ranges();

-- lab_id must agree with the parent lab_analytes row; a mismatch would leak
-- ranges across labs through the RLS predicate below.
CREATE OR REPLACE FUNCTION public.enforce_lab_analyte_reference_range_lab()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_lab_id uuid;
BEGIN
  SELECT lab_id INTO v_lab_id FROM public.lab_analytes WHERE id = NEW.lab_analyte_id;
  IF v_lab_id IS NULL THEN
    RAISE EXCEPTION 'lab_analyte % not found', NEW.lab_analyte_id;
  END IF;
  IF NEW.lab_id IS DISTINCT FROM v_lab_id THEN
    NEW.lab_id := v_lab_id;
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_enforce_lab_analyte_reference_range_lab ON public.lab_analyte_reference_ranges;
CREATE TRIGGER trg_enforce_lab_analyte_reference_range_lab
  BEFORE INSERT OR UPDATE ON public.lab_analyte_reference_ranges
  FOR EACH ROW EXECUTE FUNCTION public.enforce_lab_analyte_reference_range_lab();

ALTER TABLE public.lab_analyte_reference_ranges ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "lab_analyte_reference_ranges_lab_access" ON public.lab_analyte_reference_ranges;
CREATE POLICY "lab_analyte_reference_ranges_lab_access" ON public.lab_analyte_reference_ranges
  AS PERMISSIVE
  FOR ALL
  TO authenticated
  USING (lab_id IN (SELECT lab_id FROM public.users WHERE id = auth.uid()))
  WITH CHECK (lab_id IN (SELECT lab_id FROM public.users WHERE id = auth.uid()));

-- ---------------------------------------------------------------------------
-- Audit trail on the saved result: which rule produced the printed range.
-- ---------------------------------------------------------------------------
ALTER TABLE public.result_values
  ADD COLUMN IF NOT EXISTS range_rule_id uuid REFERENCES public.lab_analyte_reference_ranges(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS range_source text,
  ADD COLUMN IF NOT EXISTS applied_range_rule text;

COMMENT ON COLUMN public.result_values.range_rule_id IS
'The lab_analyte_reference_ranges row that produced reference_range, when resolution came from a rule.';
COMMENT ON COLUMN public.result_values.range_source IS
'How reference_range was decided: rule | gender_column | lab_default | ai | analyzer | manual.';
COMMENT ON COLUMN public.result_values.applied_range_rule IS
'Human-readable description of the matched rule, e.g. "Female, 12-50y, Fasting". Shown in the verification console.';

-- ---------------------------------------------------------------------------
-- Backfill: turn the legacy gender columns into real rules.
--
-- Only for lab analytes that have no rules yet, and only where the gender range
-- actually differs from the generic one (otherwise the rule adds nothing but a
-- row to maintain). Legacy columns are left in place and keep working as the
-- fallback; they simply stop being the only way to express a gender split.
-- ---------------------------------------------------------------------------
INSERT INTO public.lab_analyte_reference_ranges
  (lab_id, lab_analyte_id, gender, range_text, priority, notes)
SELECT
  la.lab_id,
  la.id,
  g.gender,
  btrim(g.range_text),
  0,
  'Backfilled from lab_analytes.reference_range_' || g.gender
FROM public.lab_analytes la
CROSS JOIN LATERAL (
  VALUES
    ('male',   la.reference_range_male),
    ('female', la.reference_range_female)
) AS g(gender, range_text)
WHERE NULLIF(btrim(COALESCE(g.range_text, '')), '') IS NOT NULL
  AND btrim(g.range_text) IS DISTINCT FROM btrim(COALESCE(la.lab_specific_reference_range, la.reference_range, ''))
  AND NOT EXISTS (
    SELECT 1 FROM public.lab_analyte_reference_ranges r WHERE r.lab_analyte_id = la.id
  )
ON CONFLICT DO NOTHING;
