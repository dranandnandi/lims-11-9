-- Patient portal: multi-lab login + recoverable PINs
--
-- Problem 1 — one phone, many labs. resolve_patient_virtual_email() ended with
-- `ORDER BY created_at ASC LIMIT 1`, so a mobile number registered at several labs
-- (or duplicated inside one lab) always resolved to the OLDEST patient row. The PIN
-- the patient was given belongs to a different row, so auth returned
-- invalid_credentials. Fix: resolve ALL portal-enabled patients for the number and
-- pick the one whose stored bcrypt password actually matches the entered PIN.
--
-- Problem 2 — the PIN vanished. Supabase Auth only keeps the hash, and nothing wrote
-- patient PINs to portal_credentials, so a lab could never see a PIN again after the
-- one-time reveal at generation. Fix: edge functions now record patient PINs in
-- portal_credentials (credential_type = 'patient_portal'), and this migration adds a
-- lab-scoped view so the patient page can display the current PIN.

-- ---------------------------------------------------------------------------
-- 1. Track patient-chosen PINs so the lab-visible PIN is never shown when stale
-- ---------------------------------------------------------------------------
ALTER TABLE public.patients
  ADD COLUMN IF NOT EXISTS portal_pin_self_set_at timestamptz;

COMMENT ON COLUMN public.patients.portal_pin_self_set_at IS
  'Set when the patient changed their own portal PIN. The lab-recorded PIN is deleted at that point, so the patient page shows "patient set their own PIN" instead of a stale value.';

-- ---------------------------------------------------------------------------
-- 2. Step 1 of login: does this mobile number have portal access anywhere?
--    Returns only a count — never names or lab names — so typing a stranger's
--    number reveals nothing about where they get tested.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.patient_portal_phone_access_count(p_phone text)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT count(*)::integer
  FROM public.patients p
  WHERE p.portal_access_enabled = true
    AND p.is_active = true
    AND p.patient_auth_id IS NOT NULL
    AND RIGHT(REGEXP_REPLACE(p.phone, '\D', '', 'g'), 10)
        = RIGHT(REGEXP_REPLACE(p_phone, '\D', '', 'g'), 10)
    AND length(REGEXP_REPLACE(p_phone, '\D', '', 'g')) >= 10;
$$;

REVOKE ALL ON FUNCTION public.patient_portal_phone_access_count(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.patient_portal_phone_access_count(text) TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Step 2 of login: of every portal account on this number, which one does the
--    entered PIN belong to? Verifies the bcrypt hash directly so a patient
--    registered at 20 labs costs ONE auth call instead of 20 failed ones.
--
--    Deliberately NOT granted to anon/authenticated: an unauthenticated caller
--    could otherwise use it as an unthrottled brute-force oracle on 6-digit PINs.
--    Only the service role (the patient-portal-login edge function, which
--    throttles by number) may call it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.patient_portal_match_login(p_phone text, p_pin text)
RETURNS TABLE (
  email         text,
  patient_id    uuid,
  patient_name  text,
  lab_id        uuid,
  lab_name      text,
  last_order_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, auth, pg_temp
AS $$
  SELECT
    u.email::text        AS email,
    p.id                 AS patient_id,
    p.name               AS patient_name,
    p.lab_id             AS lab_id,
    l.name               AS lab_name,
    (SELECT max(o.order_date)::timestamptz FROM public.orders o WHERE o.patient_id = p.id) AS last_order_at
  FROM public.patients p
  JOIN auth.users u ON u.id = p.patient_auth_id
  LEFT JOIN public.labs l ON l.id = p.lab_id
  WHERE p.portal_access_enabled = true
    AND p.is_active = true
    AND length(REGEXP_REPLACE(p_phone, '\D', '', 'g')) >= 10
    AND RIGHT(REGEXP_REPLACE(p.phone, '\D', '', 'g'), 10)
        = RIGHT(REGEXP_REPLACE(p_phone, '\D', '', 'g'), 10)
    AND u.encrypted_password IS NOT NULL
    AND u.encrypted_password <> ''
    AND u.encrypted_password = extensions.crypt(p_pin, u.encrypted_password)
  ORDER BY last_order_at DESC NULLS LAST, p.created_at DESC;
$$;

REVOKE ALL ON FUNCTION public.patient_portal_match_login(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.patient_portal_match_login(text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.patient_portal_match_login(text, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 4. Brute-force throttle for the login edge function. Service-role only:
--    no RLS policies are defined, so PostgREST clients can never read or write it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.patient_portal_login_attempts (
  phone_last10   text PRIMARY KEY,
  failed_count   integer NOT NULL DEFAULT 0,
  window_started timestamptz NOT NULL DEFAULT now(),
  last_attempt   timestamptz NOT NULL DEFAULT now(),
  locked_until   timestamptz
);

ALTER TABLE public.patient_portal_login_attempts ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.patient_portal_login_attempts IS
  'Failed patient-portal PIN attempts per mobile number. Written only by the patient-portal-login edge function (service role); RLS with no policies blocks all client access.';

-- ---------------------------------------------------------------------------
-- 5. Patient self-service PIN change: drop the lab-recorded PIN so the patient
--    page never shows a value the patient has already replaced.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.patient_portal_forget_recorded_pin()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  DELETE FROM public.portal_credentials
  WHERE credential_type = 'patient_portal'
    AND auth_user_id = v_uid;

  UPDATE public.patients
  SET portal_pin_self_set_at = now()
  WHERE patient_auth_id = v_uid;
END;
$$;

REVOKE ALL ON FUNCTION public.patient_portal_forget_recorded_pin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.patient_portal_forget_recorded_pin() TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Lab-scoped view for the patient page.
--
--    security_invoker = true means the caller's own RLS applies to both base
--    tables, so portal_credentials' admin-only policy is what gates the PIN
--    column — the view grants no privilege of its own.
--
--    The lab_id filter in the WHERE clause is not redundant: public.patients has
--    a `USING (true)` SELECT policy for authenticated users (this app scopes
--    patients by lab_id in its queries, not in RLS), so without it a user at one
--    lab could read another lab's patient rows through this view. The PIN itself
--    would still be hidden, but the row should not appear at all.
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS public.patient_portal_credentials;

CREATE VIEW public.patient_portal_credentials
WITH (security_invoker = true) AS
SELECT
  p.id                          AS patient_id,
  p.lab_id                      AS lab_id,
  p.name                        AS patient_name,
  p.phone                       AS phone,
  p.display_id                  AS display_id,
  p.patient_auth_id             AS auth_user_id,
  p.portal_access_enabled       AS portal_access_enabled,
  p.portal_access_sent_at       AS portal_access_sent_at,
  p.portal_pin_reset_at         AS portal_pin_reset_at,
  p.portal_pin_self_set_at      AS portal_pin_self_set_at,
  pc.email                      AS portal_email,
  pc.password_text              AS portal_pin,
  pc.updated_at                 AS pin_recorded_at,
  -- Whether this caller's role is allowed to see PINs at all, so the UI can say
  -- "you don't have permission" instead of "no PIN was recorded".
  EXISTS (
    SELECT 1
    FROM public.users u
    LEFT JOIN public.user_roles r ON r.id = u.role_id
    WHERE (u.id = auth.uid() OR u.auth_user_id = auth.uid())
      AND u.lab_id = p.lab_id
      AND r.role_code IN ('admin', 'owner', 'lab_manager')
  )                             AS can_view_pin,
  CASE
    WHEN pc.password_text IS NOT NULL           THEN 'available'
    WHEN p.portal_pin_self_set_at IS NOT NULL   THEN 'patient_changed'
    WHEN p.patient_auth_id IS NOT NULL          THEN 'not_recorded'
    ELSE 'no_access'
  END                           AS pin_status
FROM public.patients p
LEFT JOIN public.portal_credentials pc
  ON pc.credential_type = 'patient_portal'
 AND pc.auth_user_id = p.patient_auth_id
 AND pc.lab_id = p.lab_id
WHERE p.lab_id IN (
  SELECT u.lab_id
  FROM public.users u
  WHERE u.id = auth.uid() OR u.auth_user_id = auth.uid()
);

COMMENT ON VIEW public.patient_portal_credentials IS
  'Per-patient portal login for the lab admin patient page: virtual email plus the last PIN the lab issued. Rows are restricted to the caller''s own lab; the PIN column is additionally gated by portal_credentials RLS (admin/owner/lab_manager). pin_status distinguishes available / patient_changed / not_recorded / no_access, and can_view_pin says whether the caller is permitted to see PINs.';

GRANT SELECT ON public.patient_portal_credentials TO authenticated;

-- Speeds up the phone-suffix lookups both login RPCs perform.
CREATE INDEX IF NOT EXISTS idx_patients_phone_last10_portal
  ON public.patients (RIGHT(REGEXP_REPLACE(phone, '\D', '', 'g'), 10))
  WHERE portal_access_enabled = true AND is_active = true;
