-- Stable, pre-generated report links.
--
-- Why: today a report URL only exists after generate-pdf-letterhead has finished
-- the whole chain -- PDF.co render, download, storage upload -- which in the worst
-- case is ~65s (1.5s settle + five download retries + a 15s delayed retry + three
-- more). Nothing can be handed to a patient before that completes, so WhatsApp /
-- email sends all wait on the slowest leg.
--
-- Worse, when every download attempt fails, uploadPdfToStorage returns the PDF.co
-- temp URL as publicUrl and that URL is written straight into reports.pdf_url and
-- sent out. PDF.co temp URLs die within the hour, so those reports become dead
-- links with no repair path.
--
-- This table gives each order a token that exists BEFORE generation starts. The
-- report-link edge function resolves the token at open time, so the same URL can
-- point at the PDF.co temp file early on and silently switch to permanent storage
-- once the upload lands. Nothing already sent to a patient ever has to change.
--
-- Phase 0 note: this migration is purely additive. Until report-link is deployed
-- and rows are created, no existing code path reads or writes any of it.

CREATE TABLE IF NOT EXISTS public.report_links (
  token text PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  lab_id uuid NOT NULL REFERENCES public.labs(id) ON DELETE CASCADE,

  -- Which PDF this token serves. One order can hand out several stable links.
  variant text NOT NULL DEFAULT 'final',

  -- The two resolution targets, in preference order.
  permanent_url text,
  temp_url text,
  temp_expires_at timestamptz,

  status text NOT NULL DEFAULT 'pending',

  -- Set once the token has been handed to a patient, so a later cleanup can tell
  -- "never sent, safe to drop" from "in the wild, must keep resolving forever".
  first_shared_at timestamptz,
  last_accessed_at timestamptz,
  access_count integer NOT NULL DEFAULT 0,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT report_links_variant_check
    CHECK (variant IN ('final', 'print', 'compact')),
  CONSTRAINT report_links_status_check
    CHECK (status IN ('pending', 'temp', 'permanent', 'failed')),
  CONSTRAINT report_links_token_len_check
    CHECK (length(token) >= 24)
);

COMMENT ON TABLE public.report_links IS
'Pre-generated, permanently stable report URLs. The report-link edge function resolves a token to permanent_url when present, else to temp_url while it is unexpired, else re-derives from reports.pdf_url. The token is the credential -- treat it like a bearer secret.';

COMMENT ON COLUMN public.report_links.permanent_url IS
'Supabase storage (or CUSTOM_STORAGE_DOMAIN) URL. Written only once the PDF is genuinely in the reports bucket -- never a PDF.co URL. Once set, resolution stops looking anywhere else.';
COMMENT ON COLUMN public.report_links.temp_url IS
'PDF.co temp URL, published as soon as the render returns so the link resolves ~65s earlier than storage. Always superseded by permanent_url.';
COMMENT ON COLUMN public.report_links.temp_expires_at IS
'Conservative expiry for temp_url (PDF.co is ~1h; we stamp 55m). Past this the resolver ignores temp_url even if still set.';
COMMENT ON COLUMN public.report_links.status IS
'pending = nothing resolvable yet; temp = only the PDF.co URL is live; permanent = storage URL set; failed = generation gave up.';
COMMENT ON COLUMN public.report_links.first_shared_at IS
'Stamped when the token is actually sent to a patient/doctor. A token with this set can never be recycled.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_report_links_order_variant
  ON public.report_links (order_id, variant);

CREATE INDEX IF NOT EXISTS idx_report_links_lab
  ON public.report_links (lab_id, created_at DESC);

-- Supports the sweeper that repairs links stuck on an expiring temp URL.
CREATE INDEX IF NOT EXISTS idx_report_links_unresolved
  ON public.report_links (temp_expires_at)
  WHERE permanent_url IS NULL;

CREATE OR REPLACE FUNCTION public.touch_report_links()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_touch_report_links ON public.report_links;
CREATE TRIGGER trg_touch_report_links
  BEFORE UPDATE ON public.report_links
  FOR EACH ROW EXECUTE FUNCTION public.touch_report_links();

-- 128 bits of hex. gen_random_uuid() is core in pg13+, so this needs no extension.
CREATE OR REPLACE FUNCTION public.gen_report_link_token()
RETURNS text
LANGUAGE sql
VOLATILE
AS $fn$
  SELECT replace(gen_random_uuid()::text, '-', '');
$fn$;

-- Idempotent and race-safe: concurrent callers converge on one token per
-- (order, variant). Callers only ever need the token, never the row.
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
  SELECT token INTO v_token
    FROM report_links
   WHERE order_id = p_order_id AND variant = p_variant;
  IF v_token IS NOT NULL THEN
    RETURN v_token;
  END IF;

  SELECT lab_id INTO v_lab_id FROM orders WHERE id = p_order_id;
  IF v_lab_id IS NULL THEN
    RAISE EXCEPTION 'order % not found', p_order_id;
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

ALTER TABLE public.report_links ENABLE ROW LEVEL SECURITY;

-- Lab staff can see their own labs' links. Patients never hit this table
-- directly -- the report-link function reads it with the service role, because
-- the whole point is that an anonymous bearer of the token can resolve it.
DROP POLICY IF EXISTS "report_links_lab_access" ON public.report_links;
CREATE POLICY "report_links_lab_access" ON public.report_links
  AS PERMISSIVE
  FOR ALL
  TO authenticated
  USING (lab_id IN (SELECT lab_id FROM public.users WHERE id = auth.uid()))
  WITH CHECK (lab_id IN (SELECT lab_id FROM public.users WHERE id = auth.uid()));

-- Per-lab enrolment gate. Phase 2 writes temp_url from generate-pdf-letterhead
-- only for labs flipped on here, so an un-enrolled lab is byte-identical to today.
ALTER TABLE public.labs
  ADD COLUMN IF NOT EXISTS report_link_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.labs.report_link_enabled IS
'When true, generate-pdf-letterhead publishes PDF.co temp URLs into report_links and outbound messages use the stable /r/<token> link. Default false = current behaviour exactly.';
