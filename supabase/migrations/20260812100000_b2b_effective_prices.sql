-- Contracted pricing for the B2B partner portal booking screen.
-- account_prices / price_master_items / account_package_prices are all behind RLS keyed on
-- public.users, so a portal user (auth-only, no users row) reads nothing from them and the
-- booking modal falls back to test_groups.price (MRP). This function returns only the rows
-- that override MRP for the calling account, using the same priority Account Master shows:
--   account_prices (direct override) -> price_master_items (inherited plan) -> base price.
CREATE OR REPLACE FUNCTION public.get_b2b_effective_prices()
RETURNS TABLE (
  item_type text,
  item_id uuid,
  price numeric
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
  WITH plan AS (
    SELECT pmi.test_group_id, pmi.price
    FROM public.price_master_items pmi
    JOIN public.accounts a ON a.price_master_id = pmi.price_master_id
    WHERE a.id = v_account_id
  ),
  direct AS (
    -- Several dated rows can exist per test; keep the latest one already in effect
    SELECT DISTINCT ON (ap.test_group_id) ap.test_group_id, ap.price
    FROM public.account_prices ap
    WHERE ap.account_id = v_account_id
      AND ap.is_active
      AND (ap.effective_from IS NULL OR ap.effective_from <= CURRENT_DATE)
    ORDER BY ap.test_group_id, ap.effective_from DESC NULLS LAST
  )
  SELECT
    'test'::text,
    COALESCE(d.test_group_id, p.test_group_id),
    COALESCE(d.price, p.price)
  FROM direct d
  FULL OUTER JOIN plan p ON p.test_group_id = d.test_group_id

  UNION ALL

  SELECT 'package'::text, pkg.package_id, pkg.price
  FROM (
    SELECT DISTINCT ON (app.package_id) app.package_id, app.price
    FROM public.account_package_prices app
    WHERE app.account_id = v_account_id
      AND app.is_active
      AND (app.effective_from IS NULL OR app.effective_from <= CURRENT_DATE)
    ORDER BY app.package_id, app.effective_from DESC NULLS LAST
  ) pkg;
END;
$$;

REVOKE ALL ON FUNCTION public.get_b2b_effective_prices() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_b2b_effective_prices() TO authenticated;
