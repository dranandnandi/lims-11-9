-- Patient directory for the B2B partner portal.
-- The patients table stays behind RLS (B2B users cannot read it directly), so this
-- function returns one row per patient the calling account has actually referred,
-- mirroring the guard used by get_b2b_trf_orders / get_b2b_result_analysis.
CREATE OR REPLACE FUNCTION public.get_b2b_patients(
  p_from date DEFAULT NULL,
  p_to date DEFAULT NULL
)
RETURNS TABLE (
  patient_id uuid,
  patient_code text,
  name text,
  age integer,
  age_unit text,
  gender text,
  phone text,
  email text,
  first_visit date,
  last_visit date,
  total_orders bigint,
  total_amount numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id uuid;
BEGIN
  IF COALESCE(auth.jwt() -> 'user_metadata' ->> 'role', '') <> 'b2b_account' THEN
    RAISE EXCEPTION 'B2B account access required';
  END IF;

  BEGIN
    v_account_id := (auth.jwt() -> 'user_metadata' ->> 'account_id')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'Invalid B2B account context';
  END;

  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'Missing B2B account context';
  END IF;

  RETURN QUERY
  SELECT
    o.patient_id,
    -- A raw uuid is useless to a partner; fall back through the human-readable ids
    COALESCE(
      NULLIF(BTRIM(p.display_id::text), ''),
      NULLIF(BTRIM(p.patient_number), ''),
      NULLIF(BTRIM(p.external_patient_id::text), ''),
      '#' || UPPER(LEFT(o.patient_id::text, 8))
    )::text,
    -- The patient row is the source of truth; orders keep a denormalised copy
    COALESCE(NULLIF(BTRIM(p.name::text), ''), MIN(o.patient_name)::text)::text,
    p.age,
    COALESCE(NULLIF(BTRIM(p.age_unit), ''), 'years')::text,
    p.gender::text,
    NULLIF(BTRIM(p.phone::text), '')::text,
    NULLIF(BTRIM(COALESCE(p.email, '')::text), '')::text,
    MIN(o.order_date),
    MAX(o.order_date),
    COUNT(o.id),
    COALESCE(SUM(o.total_amount), 0)
  FROM public.orders o
  LEFT JOIN public.patients p ON p.id = o.patient_id
  WHERE o.account_id = v_account_id
    AND (p_from IS NULL OR o.order_date >= p_from)
    AND (p_to IS NULL OR o.order_date <= p_to)
  GROUP BY
    o.patient_id,
    p.id,
    p.display_id,
    p.patient_number,
    p.external_patient_id,
    p.name,
    p.age,
    p.age_unit,
    p.gender,
    p.phone,
    p.email
  ORDER BY MAX(o.order_date) DESC, 3;
END;
$$;

REVOKE ALL ON FUNCTION public.get_b2b_patients(date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_b2b_patients(date, date) TO authenticated;
