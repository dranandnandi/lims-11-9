-- Turn stable report links on everywhere, and make them the default for new labs.
--
-- The per-lab gate existed so the feature could be proven on one lab before it
-- touched anyone else. That is done: RADHE and Accucell both generate tokens,
-- publish PDF.co temp URLs early, and stamp storage URLs on completion.
--
-- Patient-facing blast radius was measured before flipping this, because the
-- only path where a token reaches a patient is a WhatsApp template containing
-- [ReportUrl] on a lab with auto-send enabled:
--   80 labs total, 6 with auto-send on, 1 with a [ReportUrl] template,
--   and ZERO labs where both are true.
-- Everywhere else the token is staff-facing only (the Download/Print buttons and
-- the report row), and the WhatsApp attachment keeps using the direct storage
-- URL regardless, because providers fetch it server-side and may not follow a 302.
--
-- Reverting one lab is a single UPDATE; there is no schema dependency on this
-- being true.

ALTER TABLE public.labs
  ALTER COLUMN report_link_enabled SET DEFAULT true;

UPDATE public.labs
   SET report_link_enabled = true
 WHERE report_link_enabled IS DISTINCT FROM true;

COMMENT ON COLUMN public.labs.report_link_enabled IS
'When true, generate-pdf-letterhead mints report_links tokens and publishes PDF.co temp URLs into them, so a report is shareable before the storage upload finishes. Defaults true since 2026-08-19; set false per lab to opt out.';
