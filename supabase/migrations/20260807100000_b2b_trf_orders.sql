-- Test Requisition Form (TRF) data for the B2B partner portal.
-- order_tests and the test_groups collection requirements stay behind RLS;
-- this function returns them only for orders owned by the calling B2B account,
-- mirroring get_b2b_result_analysis.
CREATE OR REPLACE FUNCTION public.get_b2b_trf_orders(p_order_ids uuid[] DEFAULT NULL)
RETURNS TABLE (
  order_id uuid,
  order_display text,
  patient_name text,
  order_date date,
  priority text,
  doctor text,
  notes text,
  status text,
  sample_id text,
  tests jsonb,
  samples jsonb
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
    o.id,
    -- Orders booked without a display number fall back to the sample id, then a
    -- short id: a raw uuid is unusable as a reference on a printed handover sheet
    COALESCE(
      NULLIF(BTRIM(o.order_display), ''),
      NULLIF(BTRIM(COALESCE(o.sample_id, '')), ''),
      '#' || UPPER(LEFT(o.id::text, 8))
    )::text,
    o.patient_name::text,
    o.order_date,
    o.priority::text,
    NULLIF(BTRIM(COALESCE(o.doctor, '')), '')::text,
    NULLIF(BTRIM(COALESCE(o.notes, '')), '')::text,
    o.status::text,
    NULLIF(BTRIM(COALESCE(o.sample_id, '')), '')::text,
    COALESCE((
      SELECT jsonb_agg(entry ORDER BY entry ->> 'sample_type', entry ->> 'name')
      FROM (
        SELECT jsonb_build_object(
          'name', COALESCE(tg.name, ot.test_name)::text,
          'sample_type', COALESCE(NULLIF(BTRIM(tg.sample_type::text), ''), 'Not specified'),
          'sample_color', NULLIF(BTRIM(COALESCE(tg.sample_color, '')), ''),
          'requires_fasting', COALESCE(tg.requires_fasting, false),
          'guidelines', NULLIF(BTRIM(COALESCE(tg.pre_collection_guidelines, '')), '')
        ) AS entry
        FROM public.order_tests ot
        LEFT JOIN public.test_groups tg ON tg.id = ot.test_group_id
        WHERE ot.order_id = o.id
          AND COALESCE(ot.is_canceled, false) = false
      ) test_rows
    ), '[]'::jsonb),
    COALESCE((
      SELECT jsonb_agg(entry ORDER BY entry ->> 'sample_type', entry ->> 'barcode')
      FROM (
        SELECT jsonb_build_object(
          'id', s.id,
          'barcode', NULLIF(BTRIM(COALESCE(s.barcode, '')), ''),
          'sample_type', NULLIF(BTRIM(COALESCE(s.sample_type, '')), ''),
          'container_type', NULLIF(BTRIM(COALESCE(s.container_type, '')), ''),
          'status', s.status::text,
          'collected_at', s.collected_at
        ) AS entry
        FROM public.samples s
        WHERE s.order_id = o.id
      ) sample_rows
    ), '[]'::jsonb)
  FROM public.orders o
  WHERE o.account_id = v_account_id
    AND (p_order_ids IS NULL OR o.id = ANY(p_order_ids))
  ORDER BY o.order_date DESC, o.order_display NULLS LAST;
END;
$$;

REVOKE ALL ON FUNCTION public.get_b2b_trf_orders(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_b2b_trf_orders(uuid[]) TO authenticated;
