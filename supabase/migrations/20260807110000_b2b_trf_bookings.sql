-- TRF data for B2B bookings that the lab has not converted into orders yet.
-- Bookings carry only {id, name, price, type} per selected catalog item, so the
-- collection requirement (sample type, tube, fasting) is resolved here against
-- test_groups / package_test_groups, which a B2B session cannot join itself.
CREATE OR REPLACE FUNCTION public.get_b2b_trf_bookings(p_booking_ids uuid[] DEFAULT NULL)
RETURNS TABLE (
  booking_id uuid,
  booking_ref text,
  patient_name text,
  patient_meta text,
  scheduled_at timestamptz,
  created_at timestamptz,
  collection_type text,
  status text,
  tests jsonb
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
  WITH booking_rows AS (
    SELECT b.*
    FROM public.bookings b
    WHERE b.account_id = v_account_id
      AND (p_booking_ids IS NULL OR b.id = ANY(p_booking_ids))
  ),
  items AS (
    SELECT
      br.id AS booking_id,
      COALESCE(NULLIF(BTRIM(item ->> 'name'), ''), 'Test') AS item_name,
      LOWER(COALESCE(NULLIF(BTRIM(item ->> 'type'), ''), 'test')) AS item_type,
      -- Catalog ids are uuids, but never trust stored json blindly
      CASE
        WHEN (item ->> 'id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN (item ->> 'id')::uuid
      END AS item_id
    FROM booking_rows br
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(br.test_details) = 'array' THEN br.test_details ELSE '[]'::jsonb END
    ) AS item
  ),
  resolved AS (
    -- Single tests
    SELECT
      i.booking_id,
      COALESCE(tg.name, i.item_name)::text AS name,
      COALESCE(NULLIF(BTRIM(tg.sample_type::text), ''), 'Not specified') AS sample_type,
      NULLIF(BTRIM(COALESCE(tg.sample_color, '')), '') AS sample_color,
      COALESCE(tg.requires_fasting, false) AS requires_fasting,
      NULLIF(BTRIM(COALESCE(tg.pre_collection_guidelines, '')), '') AS guidelines
    FROM items i
    LEFT JOIN public.test_groups tg ON tg.id = i.item_id
    WHERE i.item_type <> 'package'

    UNION ALL

    -- Packages expand into their member tests; an unresolvable package still
    -- prints as one line so nothing silently disappears from the sheet
    SELECT
      i.booking_id,
      COALESCE(tg.name, i.item_name || ' (package)')::text,
      COALESCE(NULLIF(BTRIM(tg.sample_type::text), ''), 'Not specified'),
      NULLIF(BTRIM(COALESCE(tg.sample_color, '')), ''),
      COALESCE(tg.requires_fasting, false),
      NULLIF(BTRIM(COALESCE(tg.pre_collection_guidelines, '')), '')
    FROM items i
    LEFT JOIN public.package_test_groups ptg ON ptg.package_id = i.item_id
    LEFT JOIN public.test_groups tg ON tg.id = ptg.test_group_id
    WHERE i.item_type = 'package'
  )
  SELECT
    br.id,
    ('BKG-' || UPPER(LEFT(br.id::text, 8)))::text,
    COALESCE(NULLIF(BTRIM(br.patient_info ->> 'name'), ''), 'Patient')::text,
    NULLIF(
      ARRAY_TO_STRING(
        ARRAY_REMOVE(
          ARRAY[
            NULLIF(BTRIM(COALESCE(br.patient_info ->> 'age', '')), ''),
            NULLIF(BTRIM(COALESCE(br.patient_info ->> 'gender', '')), ''),
            NULLIF(BTRIM(COALESCE(br.patient_info ->> 'phone', '')), '')
          ],
          NULL
        ),
        ' / '
      ),
      ''
    )::text,
    br.scheduled_at,
    br.created_at,
    br.collection_type::text,
    br.status::text,
    COALESCE((
      SELECT jsonb_agg(entry ORDER BY entry ->> 'sample_type', entry ->> 'name')
      FROM (
        SELECT DISTINCT jsonb_build_object(
          'name', r.name,
          'sample_type', r.sample_type,
          'sample_color', r.sample_color,
          'requires_fasting', r.requires_fasting,
          'guidelines', r.guidelines
        ) AS entry
        FROM resolved r
        WHERE r.booking_id = br.id
      ) test_rows
    ), '[]'::jsonb)
  FROM booking_rows br
  ORDER BY br.created_at DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.get_b2b_trf_bookings(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_b2b_trf_bookings(uuid[]) TO authenticated;
