-- Public, no-login booking links.
--
-- Gives every lab a shareable URL (https://app.limsapp.in/book/<slug>) that a
-- patient can open from Google Business Profile, the lab's own website, a QR
-- code or a WhatsApp broadcast, pick tests, and request an appointment —
-- without ever creating an account.
--
-- Security model mirrors payment_links (20260801000000): the public page never
-- touches these tables directly. Everything goes through the `public-booking`
-- edge function (verify_jwt = false) using the service role, with the slug as
-- the only public identifier. There are deliberately NO anon RLS policies here.
--
-- 1. labs.public_booking_slug / _enabled / _config
-- 2. bookings.booking_source gains 'public_web'
-- 3. bookings.public_reference (the code shown to the patient) + source_meta
-- 4. public_booking_slug_available() so the settings screen can check a slug
--    without being able to read other labs' rows

-- ---------------------------------------------------------------- 1. labs --

ALTER TABLE labs
    ADD COLUMN IF NOT EXISTS public_booking_enabled boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS public_booking_slug text,
    ADD COLUMN IF NOT EXISTS public_booking_config jsonb NOT NULL DEFAULT '{
        "headline": "Book a lab test",
        "intro": "",
        "show_prices": true,
        "catalog_mode": "all",
        "selected_test_group_ids": [],
        "selected_package_ids": [],
        "allow_home_collection": true,
        "allow_walk_in": true,
        "home_collection_charge": 0,
        "require_email": false,
        "require_age_gender": true,
        "slot_days_ahead": 7,
        "slot_start_hour": 7,
        "slot_end_hour": 20,
        "slot_minutes": 30,
        "terms": "",
        "max_per_phone_per_day": 5
    }'::jsonb;

-- Slug lives in a URL path segment: lowercase, digits, single hyphens, 3-50 chars.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'labs_public_booking_slug_format'
    ) THEN
        ALTER TABLE labs ADD CONSTRAINT labs_public_booking_slug_format
            CHECK (
                public_booking_slug IS NULL
                OR public_booking_slug ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$'
            );
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS labs_public_booking_slug_key
    ON labs (public_booking_slug)
    WHERE public_booking_slug IS NOT NULL;

-- ------------------------------------------------------------ 2. bookings --

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_booking_source_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_booking_source_check
    CHECK (booking_source IN ('b2b_portal', 'front_desk', 'patient_app', 'phone_call', 'public_web'));

ALTER TABLE bookings
    -- Short human-quotable code ("BK-7K3M9Q") the patient sees on the confirmation
    -- screen and reads out on the phone. Only set for public_web bookings.
    ADD COLUMN IF NOT EXISTS public_reference text,
    -- Provenance of an anonymous submission: referrer, user agent, coarse IP hash.
    -- Used for abuse triage; never shown to the patient.
    ADD COLUMN IF NOT EXISTS source_meta jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS bookings_public_reference_key
    ON bookings (public_reference)
    WHERE public_reference IS NOT NULL;

-- Rate-limit lookups scan (lab, recency) for public submissions only.
CREATE INDEX IF NOT EXISTS idx_bookings_public_web_recent
    ON bookings (lab_id, created_at DESC)
    WHERE booking_source = 'public_web';

COMMENT ON COLUMN bookings.public_reference IS
    'Short code shown to a patient who booked through the public /book/<slug> link';

-- --------------------------------------------------------- 3. slug helper --

-- The settings screen must answer "is this slug free?" without being able to
-- SELECT other labs' rows, so this returns a bare boolean and nothing else.
CREATE OR REPLACE FUNCTION public.public_booking_slug_available(p_slug text, p_lab_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT NOT EXISTS (
        SELECT 1 FROM labs
        WHERE public_booking_slug = lower(trim(p_slug))
          AND id IS DISTINCT FROM p_lab_id
    );
$$;

REVOKE ALL ON FUNCTION public.public_booking_slug_available(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_booking_slug_available(text, uuid) TO authenticated;
