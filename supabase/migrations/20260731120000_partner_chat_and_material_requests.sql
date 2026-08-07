-- ============================================================================
-- Partner (franchise / B2B account) two-way chat + material requests
-- ----------------------------------------------------------------------------
-- Lab side  : Masters > Account Master > Partner Desk (chat + material requests)
-- Client side: B2B portal collapsed sections below reports/billing
--
-- JWT user_metadata for portal users contains: role='b2b_account', lab_id, account_id
-- Lab staff are resolved through public.users.lab_id (same as inventory policies).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Partner-orderable flag on inventory items (the material request catalog)
-- ----------------------------------------------------------------------------

ALTER TABLE public.inventory_items
  ADD COLUMN IF NOT EXISTS is_partner_orderable boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.inventory_items.is_partner_orderable IS
  'When true the item appears in the partner/franchise material request catalog in the B2B portal.';

CREATE INDEX IF NOT EXISTS idx_inventory_items_partner_orderable
  ON public.inventory_items(lab_id)
  WHERE is_partner_orderable = true AND is_active = true;

-- v_inventory_with_tests was created with "i.*", which freezes the column list,
-- so it has to be rebuilt for the new flag to reach the inventory list/edit form.
DROP VIEW IF EXISTS public.v_inventory_with_tests;

CREATE VIEW public.v_inventory_with_tests AS
SELECT
  i.*,
  CASE
    WHEN i.pack_contains IS NOT NULL AND i.consumption_per_use > 0
    THEN FLOOR((i.current_stock * i.pack_contains) / i.consumption_per_use)
    WHEN i.consumption_per_use > 0
    THEN FLOOR(i.current_stock / i.consumption_per_use)
    ELSE i.current_stock
  END AS tests_remaining,
  CASE
    WHEN i.current_stock <= 0 THEN 'out_of_stock'
    WHEN i.min_stock > 0 AND i.current_stock <= i.min_stock THEN 'low_stock'
    ELSE 'normal'
  END AS stock_status
FROM public.inventory_items i
WHERE i.is_active = true;

-- B2B portal users may read only the curated catalog for their own lab.
DROP POLICY IF EXISTS "b2b_users_view_partner_catalog" ON public.inventory_items;
CREATE POLICY "b2b_users_view_partner_catalog" ON public.inventory_items
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (
    (auth.jwt() -> 'user_metadata' ->> 'role') = 'b2b_account'
    AND lab_id = ((auth.jwt() -> 'user_metadata' ->> 'lab_id')::uuid)
    AND is_active = true
    AND is_partner_orderable = true
  );

-- ----------------------------------------------------------------------------
-- 2. account_messages - one thread per account, two-way
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.account_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lab_id uuid NOT NULL REFERENCES public.labs(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,

  -- Who wrote it. 'lab' = LIMS staff, 'account' = franchise/B2B portal user
  sender_type text NOT NULL CHECK (sender_type IN ('lab', 'account')),
  sender_user_id uuid,                    -- auth.uid() of the writer (no FK: portal users are auth-only)
  sender_name text,                       -- denormalised display name

  body text,

  -- [{ "path": "accounts/<uuid>/...", "name": "history.pdf", "size": 12345, "mime": "application/pdf" }]
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb,

  read_by_lab_at timestamptz,
  read_by_account_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT account_messages_has_content CHECK (
    COALESCE(btrim(body), '') <> '' OR jsonb_array_length(attachments) > 0
  )
);

COMMENT ON TABLE public.account_messages IS
  'Two-way chat thread between the lab and a franchise/B2B account. Attachments (e.g. clinical history) live in the private partner-chat storage bucket.';

CREATE INDEX IF NOT EXISTS idx_account_messages_thread
  ON public.account_messages(account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_account_messages_lab_unread
  ON public.account_messages(lab_id, created_at DESC)
  WHERE sender_type = 'account' AND read_by_lab_at IS NULL;

ALTER TABLE public.account_messages ENABLE ROW LEVEL SECURITY;

-- Lab staff: full access to threads of their own lab
DROP POLICY IF EXISTS "account_messages_lab_access" ON public.account_messages;
CREATE POLICY "account_messages_lab_access" ON public.account_messages
  AS PERMISSIVE
  FOR ALL
  TO authenticated
  USING (lab_id IN (SELECT lab_id FROM public.users WHERE id = auth.uid()))
  WITH CHECK (lab_id IN (SELECT lab_id FROM public.users WHERE id = auth.uid()));

-- Portal users: read their own thread
DROP POLICY IF EXISTS "account_messages_b2b_select" ON public.account_messages;
CREATE POLICY "account_messages_b2b_select" ON public.account_messages
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (
    (auth.jwt() -> 'user_metadata' ->> 'role') = 'b2b_account'
    AND account_id = ((auth.jwt() -> 'user_metadata' ->> 'account_id')::uuid)
  );

-- Portal users: post into their own thread, always as the account side
DROP POLICY IF EXISTS "account_messages_b2b_insert" ON public.account_messages;
CREATE POLICY "account_messages_b2b_insert" ON public.account_messages
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (auth.jwt() -> 'user_metadata' ->> 'role') = 'b2b_account'
    AND account_id = ((auth.jwt() -> 'user_metadata' ->> 'account_id')::uuid)
    AND lab_id = ((auth.jwt() -> 'user_metadata' ->> 'lab_id')::uuid)
    AND sender_type = 'account'
    AND read_by_lab_at IS NULL
  );

-- Deliberately no UPDATE/DELETE policy for portal users: read receipts go through
-- mark_account_thread_read() so a partner cannot rewrite or delete lab messages.

GRANT SELECT, INSERT ON public.account_messages TO authenticated;
GRANT UPDATE, DELETE ON public.account_messages TO authenticated;

-- ----------------------------------------------------------------------------
-- 3. Read receipts - only ever touches the timestamp columns
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.mark_account_thread_read(p_account_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text := auth.jwt() -> 'user_metadata' ->> 'role';
  v_jwt_account uuid;
  v_updated integer := 0;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF v_role = 'b2b_account' THEN
    v_jwt_account := ((auth.jwt() -> 'user_metadata' ->> 'account_id')::uuid);
    IF v_jwt_account IS DISTINCT FROM p_account_id THEN
      RAISE EXCEPTION 'Not allowed to read this thread';
    END IF;

    UPDATE public.account_messages
       SET read_by_account_at = now()
     WHERE account_id = p_account_id
       AND sender_type = 'lab'
       AND read_by_account_at IS NULL;

    GET DIAGNOSTICS v_updated = ROW_COUNT;
    RETURN v_updated;
  END IF;

  -- Lab staff side
  IF NOT EXISTS (
    SELECT 1
      FROM public.account_messages m
      JOIN public.users u ON u.id = auth.uid() AND u.lab_id = m.lab_id
     WHERE m.account_id = p_account_id
     LIMIT 1
  ) THEN
    RETURN 0;
  END IF;

  UPDATE public.account_messages m
     SET read_by_lab_at = now()
   WHERE m.account_id = p_account_id
     AND m.sender_type = 'account'
     AND m.read_by_lab_at IS NULL
     AND m.lab_id IN (SELECT lab_id FROM public.users WHERE id = auth.uid());

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$;

COMMENT ON FUNCTION public.mark_account_thread_read(uuid) IS
  'Marks the other sides messages in an account thread as read for the calling user. Portal users can only mark their own thread.';

GRANT EXECUTE ON FUNCTION public.mark_account_thread_read(uuid) TO authenticated;

-- ----------------------------------------------------------------------------
-- 4. account_material_requests
-- ----------------------------------------------------------------------------

CREATE SEQUENCE IF NOT EXISTS public.account_material_request_seq;

CREATE TABLE IF NOT EXISTS public.account_material_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lab_id uuid NOT NULL REFERENCES public.labs(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,

  request_number text UNIQUE,

  status text NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'approved', 'dispatched', 'delivered', 'rejected', 'cancelled')),

  -- [{ "item_id": uuid|null, "name": "EDTA Vacutainer", "quantity": 5, "unit": "box", "notes": "" }]
  items jsonb NOT NULL DEFAULT '[]'::jsonb,

  notes text,
  needed_by date,

  requested_by_name text,
  requested_by_user_id uuid,

  lab_remarks text,
  handled_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  handled_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT account_material_requests_has_items CHECK (jsonb_array_length(items) > 0)
);

COMMENT ON TABLE public.account_material_requests IS
  'Material/consumable requests raised by a franchise/B2B account against its lab.';

CREATE INDEX IF NOT EXISTS idx_account_material_requests_account
  ON public.account_material_requests(account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_account_material_requests_lab_open
  ON public.account_material_requests(lab_id, created_at DESC)
  WHERE status IN ('requested', 'approved', 'dispatched');

CREATE OR REPLACE FUNCTION public.set_account_material_request_defaults()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND (NEW.request_number IS NULL OR btrim(NEW.request_number) = '') THEN
    NEW.request_number := 'MR-' || to_char(now(), 'YYMMDD') || '-'
      || lpad((nextval('public.account_material_request_seq') % 100000)::text, 4, '0');
  END IF;

  NEW.updated_at := now();

  IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.handled_at := now();
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_account_material_request_defaults ON public.account_material_requests;
CREATE TRIGGER trg_account_material_request_defaults
  BEFORE INSERT OR UPDATE ON public.account_material_requests
  FOR EACH ROW EXECUTE FUNCTION public.set_account_material_request_defaults();

ALTER TABLE public.account_material_requests ENABLE ROW LEVEL SECURITY;

-- Lab staff: full access within their lab
DROP POLICY IF EXISTS "account_material_requests_lab_access" ON public.account_material_requests;
CREATE POLICY "account_material_requests_lab_access" ON public.account_material_requests
  AS PERMISSIVE
  FOR ALL
  TO authenticated
  USING (lab_id IN (SELECT lab_id FROM public.users WHERE id = auth.uid()))
  WITH CHECK (lab_id IN (SELECT lab_id FROM public.users WHERE id = auth.uid()));

-- Portal users: read their own requests
DROP POLICY IF EXISTS "account_material_requests_b2b_select" ON public.account_material_requests;
CREATE POLICY "account_material_requests_b2b_select" ON public.account_material_requests
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (
    (auth.jwt() -> 'user_metadata' ->> 'role') = 'b2b_account'
    AND account_id = ((auth.jwt() -> 'user_metadata' ->> 'account_id')::uuid)
  );

-- Portal users: raise a request (always lands as 'requested')
DROP POLICY IF EXISTS "account_material_requests_b2b_insert" ON public.account_material_requests;
CREATE POLICY "account_material_requests_b2b_insert" ON public.account_material_requests
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (auth.jwt() -> 'user_metadata' ->> 'role') = 'b2b_account'
    AND account_id = ((auth.jwt() -> 'user_metadata' ->> 'account_id')::uuid)
    AND lab_id = ((auth.jwt() -> 'user_metadata' ->> 'lab_id')::uuid)
    AND status = 'requested'
  );

-- Portal users: may edit/cancel only while the lab has not acted on it yet
DROP POLICY IF EXISTS "account_material_requests_b2b_update" ON public.account_material_requests;
CREATE POLICY "account_material_requests_b2b_update" ON public.account_material_requests
  AS PERMISSIVE
  FOR UPDATE
  TO authenticated
  USING (
    (auth.jwt() -> 'user_metadata' ->> 'role') = 'b2b_account'
    AND account_id = ((auth.jwt() -> 'user_metadata' ->> 'account_id')::uuid)
    AND status = 'requested'
  )
  WITH CHECK (
    (auth.jwt() -> 'user_metadata' ->> 'role') = 'b2b_account'
    AND account_id = ((auth.jwt() -> 'user_metadata' ->> 'account_id')::uuid)
    AND status IN ('requested', 'cancelled')
  );

GRANT SELECT, INSERT, UPDATE ON public.account_material_requests TO authenticated;
GRANT DELETE ON public.account_material_requests TO authenticated;
GRANT USAGE ON SEQUENCE public.account_material_request_seq TO authenticated;

-- ----------------------------------------------------------------------------
-- 5. Private storage bucket for chat attachments (clinical history etc.)
-- ----------------------------------------------------------------------------

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'partner-chat',
  'partner-chat',
  false,                                  -- private: clinical history is patient data
  15728640,                               -- 15 MB
  ARRAY[
    'application/pdf',
    'image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/heic',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain', 'text/csv'
  ]
)
ON CONFLICT (id) DO UPDATE
SET public = false,
    file_size_limit = 15728640,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Paths are accounts/<account_id>/<timestamp>-<file>
DROP POLICY IF EXISTS "partner_chat_upload" ON storage.objects;
CREATE POLICY "partner_chat_upload" ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'partner-chat'
    AND (storage.foldername(name))[1] = 'accounts'
    AND (
      -- portal user: only into their own account folder
      (
        (auth.jwt() -> 'user_metadata' ->> 'role') = 'b2b_account'
        AND (storage.foldername(name))[2] = (auth.jwt() -> 'user_metadata' ->> 'account_id')
      )
      OR
      -- lab staff: any account belonging to their lab
      (
        COALESCE(auth.jwt() -> 'user_metadata' ->> 'role', '') <> 'b2b_account'
        AND EXISTS (
          SELECT 1
            FROM public.accounts a
            JOIN public.users u ON u.id = auth.uid() AND u.lab_id = a.lab_id
           WHERE a.id::text = (storage.foldername(storage.objects.name))[2]
        )
      )
    )
  );

DROP POLICY IF EXISTS "partner_chat_read" ON storage.objects;
CREATE POLICY "partner_chat_read" ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'partner-chat'
    AND (
      (
        (auth.jwt() -> 'user_metadata' ->> 'role') = 'b2b_account'
        AND (storage.foldername(name))[2] = (auth.jwt() -> 'user_metadata' ->> 'account_id')
      )
      OR
      (
        COALESCE(auth.jwt() -> 'user_metadata' ->> 'role', '') <> 'b2b_account'
        AND EXISTS (
          SELECT 1
            FROM public.accounts a
            JOIN public.users u ON u.id = auth.uid() AND u.lab_id = a.lab_id
           WHERE a.id::text = (storage.foldername(storage.objects.name))[2]
        )
      )
    )
  );

DROP POLICY IF EXISTS "partner_chat_delete" ON storage.objects;
CREATE POLICY "partner_chat_delete" ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'partner-chat'
    AND COALESCE(auth.jwt() -> 'user_metadata' ->> 'role', '') <> 'b2b_account'
    AND EXISTS (
      SELECT 1
        FROM public.accounts a
        JOIN public.users u ON u.id = auth.uid() AND u.lab_id = a.lab_id
       WHERE a.id::text = (storage.foldername(storage.objects.name))[2]
    )
  );

-- ----------------------------------------------------------------------------
-- 6. Realtime for live chat
-- ----------------------------------------------------------------------------

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.account_messages;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.account_material_requests;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;
