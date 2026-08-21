-- Hardening + portal access for report_links.
--
-- Two problems with 20260818160000:
--
-- 1. ensure_report_link() is SECURITY DEFINER and RETURNS the token, but it was
--    granted to `authenticated` with no authorisation check. Any logged-in lab
--    user could pass another lab's order id and get back a working bearer token
--    for that lab's report -- RLS on the table never came into it, because the
--    function hands the token straight back. Now a non-service caller must
--    belong to the order's lab.
--
-- 2. The patient portal and B2B portal read reports through their own JWT
--    policies, so they could see reports.pdf_url but not the token for the same
--    order. Without the policies below they cannot use the stable link at all.

CREATE OR REPLACE FUNCTION public.ensure_report_link(
  p_order_id uuid,
  p_variant text DEFAULT 'final'
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_token text;
  v_lab_id uuid;
BEGIN
  SELECT lab_id INTO v_lab_id FROM orders WHERE id = p_order_id;
  IF v_lab_id IS NULL THEN
    RAISE EXCEPTION 'order % not found', p_order_id;
  END IF;

  -- auth.uid() is NULL for service-role callers (the edge functions). Any real
  -- end user must be staff of the order's own lab. Checked BEFORE the existing
  -- token is returned, otherwise the leak just moves to the fast path.
  IF auth.uid() IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM users
       WHERE id = auth.uid() AND lab_id = v_lab_id
    ) THEN
      RAISE EXCEPTION 'not authorised for order %', p_order_id
        USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT token INTO v_token
    FROM report_links
   WHERE order_id = p_order_id AND variant = p_variant;
  IF v_token IS NOT NULL THEN
    RETURN v_token;
  END IF;

  INSERT INTO report_links (token, order_id, lab_id, variant)
  VALUES (gen_report_link_token(), p_order_id, v_lab_id, p_variant)
  ON CONFLICT (order_id, variant) DO NOTHING
  RETURNING token INTO v_token;

  IF v_token IS NULL THEN
    SELECT token INTO v_token
      FROM report_links
     WHERE order_id = p_order_id AND variant = p_variant;
  END IF;

  RETURN v_token;
END;
$fn$;

REVOKE ALL ON FUNCTION public.ensure_report_link(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.ensure_report_link(uuid, text) TO authenticated, service_role;

-- Patients may read the token for their own orders, mirroring
-- patient_portal_own_reports. Read-only: tokens are minted server-side.
DROP POLICY IF EXISTS "report_links_patient_portal_own" ON public.report_links;
CREATE POLICY "report_links_patient_portal_own" ON public.report_links
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (
    ((auth.jwt() -> 'user_metadata') ->> 'role') = 'patient'
    AND order_id IN (
      SELECT orders.id FROM public.orders
       WHERE orders.patient_id =
         (((auth.jwt() -> 'user_metadata') ->> 'patient_id'))::uuid
    )
  );

-- Same for B2B account portals, mirroring b2b_users_view_own_reports.
DROP POLICY IF EXISTS "report_links_b2b_own" ON public.report_links;
CREATE POLICY "report_links_b2b_own" ON public.report_links
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (
    ((auth.jwt() -> 'user_metadata') ->> 'role') = 'b2b_account'
    AND order_id IN (
      SELECT orders.id FROM public.orders
       WHERE orders.account_id =
         (((auth.jwt() -> 'user_metadata') ->> 'account_id'))::uuid
    )
  );

-- No extra write guard is needed for the portals: the only policy granting
-- INSERT/UPDATE is report_links_lab_access, whose predicate is
-- "lab_id IN (SELECT lab_id FROM users WHERE id = auth.uid())". Portal patients
-- and B2B accounts have no row in `users`, so that subquery is empty and they
-- get read-only access from the two SELECT policies above. Adding a RESTRICTIVE
-- policy here would AND against those and break patient reads instead.
