-- Migration: Per-location / per-account letterhead mode + location role flags
-- Date: 2026-08-18
-- Purpose:
--   1. Let each location (and B2B account) choose between a FULL-PAGE letterhead
--      background and SEPARATE header/footer strips, independently of the lab-wide
--      `labs.pdf_letterhead_mode`. NULL = inherit / auto-detect.
--   2. Make sure the location role flags used by the transit + processing-centre
--      code paths actually exist (they were only ever added in db/migrations/,
--      which is not part of the supabase migration history).

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Per-entity letterhead mode
-- ---------------------------------------------------------------------------

ALTER TABLE public.locations
  ADD COLUMN IF NOT EXISTS pdf_letterhead_mode TEXT;

ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS pdf_letterhead_mode TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'locations_pdf_letterhead_mode_check'
  ) THEN
    ALTER TABLE public.locations
      ADD CONSTRAINT locations_pdf_letterhead_mode_check
      CHECK (pdf_letterhead_mode IS NULL OR pdf_letterhead_mode IN ('background', 'header_footer'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'accounts_pdf_letterhead_mode_check'
  ) THEN
    ALTER TABLE public.accounts
      ADD CONSTRAINT accounts_pdf_letterhead_mode_check
      CHECK (pdf_letterhead_mode IS NULL OR pdf_letterhead_mode IN ('background', 'header_footer'));
  END IF;
END $$;

COMMENT ON COLUMN public.locations.pdf_letterhead_mode IS
'Report branding mode for this location. NULL = auto (footer uploaded -> header_footer, otherwise full-page background). background = the uploaded header image is rendered as a full A4 letterhead background. header_footer = header/footer images render as strips at the top/bottom of every page.';

COMMENT ON COLUMN public.accounts.pdf_letterhead_mode IS
'Report branding mode for this B2B account. Same semantics as locations.pdf_letterhead_mode.';

-- ---------------------------------------------------------------------------
-- 2. Location role flags (idempotent - may already exist from db/migrations)
-- ---------------------------------------------------------------------------

ALTER TABLE public.locations
  ADD COLUMN IF NOT EXISTS is_collection_center boolean NOT NULL DEFAULT true;

ALTER TABLE public.locations
  ADD COLUMN IF NOT EXISTS is_processing_center boolean NOT NULL DEFAULT false;

ALTER TABLE public.locations
  ADD COLUMN IF NOT EXISTS can_receive_samples boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.locations.is_collection_center IS 'Location collects samples from patients';
COMMENT ON COLUMN public.locations.is_processing_center IS 'Location processes samples and enters results in-house';
COMMENT ON COLUMN public.locations.can_receive_samples IS 'Location may be selected as a sample transit destination';

COMMIT;
