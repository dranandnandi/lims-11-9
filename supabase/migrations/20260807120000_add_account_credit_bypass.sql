-- Per-account bypass for the credit-limit check.
--
-- When bypass_credit_check is true, every credit gate in the app treats the
-- account as always having credit available:
--   * Order form: no "credit limit exceeded" validation error, bill-to allowed.
--   * B2B portal: bookings and report downloads stay enabled even when the
--     account is over its limit.
--   * check-b2b-credit edge function: can_proceed = true, no shortfall, no
--     forced top-up payment before a booking.
--
-- The credit position itself is still calculated and displayed - only the
-- blocking behaviour is switched off. This is independent of is_locked: a
-- locked account stays blocked regardless of this flag.

ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS bypass_credit_check boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS credit_bypass_reason text,
  ADD COLUMN IF NOT EXISTS credit_bypass_set_at timestamptz,
  ADD COLUMN IF NOT EXISTS credit_bypass_set_by uuid;

COMMENT ON COLUMN public.accounts.bypass_credit_check IS 'When true, credit-limit checks never block this account (orders, B2B bookings, report downloads). Credit figures are still calculated and shown. Does not override is_locked.';
COMMENT ON COLUMN public.accounts.credit_bypass_reason IS 'Optional reason captured when the credit-check bypass was enabled.';
COMMENT ON COLUMN public.accounts.credit_bypass_set_at IS 'When the credit-check bypass was last switched on or off.';
COMMENT ON COLUMN public.accounts.credit_bypass_set_by IS 'Auth user id who last changed the credit-check bypass.';
