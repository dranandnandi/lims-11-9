-- Fix: whatsapp_user_id was being written in two different UUID spaces.
--
-- The WhatsApp backend registers each sender under the LIMS users.id — see
-- supabase/functions/sync-user-to-whatsapp/index.ts, which posts
-- `{ id: user.id, ... }` to /api/external/users/sync. So users.id is the only
-- value the backend will recognise as a session key.
--
-- But db/migrations/20260131_sync_auth_user_id_by_email.sql set
-- users.whatsapp_user_id := users.auth_user_id, a completely different UUID.
-- Every send path that reads users.whatsapp_user_id (the letterhead PDF
-- function's location routing, SendReportModal's first-priority lookup) was
-- therefore handing the backend an id it had never seen, and silently falling
-- through to the lab-level account or failing outright.
--
-- This migration makes users.whatsapp_user_id mean what the backend means:
-- "the users.id registered with the WhatsApp backend".

-- 1. Repair rows the old trigger mis-stamped with the auth UUID.
UPDATE public.users
SET whatsapp_user_id = id
WHERE whatsapp_user_id IS NOT NULL
  AND auth_user_id IS NOT NULL
  AND whatsapp_user_id = auth_user_id
  AND whatsapp_user_id <> id;

-- 2. Repair labs pointing at an auth UUID instead of a users.id.
UPDATE public.labs l
SET whatsapp_user_id = u.id
FROM public.users u
WHERE l.whatsapp_user_id IS NOT NULL
  AND u.auth_user_id = l.whatsapp_user_id
  AND u.id <> l.whatsapp_user_id;

-- 3. Stop the trigger from re-introducing the wrong id. auth_user_id linkage by
--    email is still correct and still wanted; only the whatsapp_user_id
--    assignment changes, from NEW.auth_user_id to NEW.id.
CREATE OR REPLACE FUNCTION sync_auth_user_id_by_email()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.auth_user_id IS NULL AND NEW.email IS NOT NULL THEN
        SELECT id INTO NEW.auth_user_id
        FROM auth.users
        WHERE email = NEW.email
        LIMIT 1;
    END IF;

    -- The WhatsApp backend keys sessions by users.id, never by the auth UUID.
    IF NEW.whatsapp_user_id IS NOT NULL AND NEW.whatsapp_user_id = NEW.auth_user_id
       AND NEW.whatsapp_user_id <> NEW.id THEN
        NEW.whatsapp_user_id := NEW.id;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. Same correction on the auth.users side.
CREATE OR REPLACE FUNCTION sync_public_user_on_auth_create()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE users
    SET auth_user_id = NEW.id
    WHERE email = NEW.email
      AND auth_user_id IS NULL;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 5. Guard the lab-level column the same way locations.whatsapp_user_id is
--    guarded. Added NOT VALID so a lab still holding an unrecognised id cannot
--    block the migration; new writes are checked from here on.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'labs_whatsapp_user_id_fkey'
  ) THEN
    ALTER TABLE public.labs
      ADD CONSTRAINT labs_whatsapp_user_id_fkey
      FOREIGN KEY (whatsapp_user_id) REFERENCES public.users(id) ON DELETE SET NULL
      NOT VALID;
  END IF;
END $$;

COMMENT ON COLUMN public.users.whatsapp_user_id IS
  'Equals users.id once the user is registered with the WhatsApp backend; NULL when not synced. Never the auth UUID.';
