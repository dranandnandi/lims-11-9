-- Time-limited credit-check bypass.
--
-- Mirrors the temporary-open window on the account lock (lock_override_until):
-- the flag stays on in the row, but a timestamp decides whether it still counts.
--
--   credit_bypass_until IS NULL  -> bypass runs until someone turns it off.
--   credit_bypass_until > now()  -> bypass is live, and expires by itself.
--   credit_bypass_until <= now() -> bypass is spent; every credit gate blocks
--                                   again with no action needed from an admin.
--
-- "Bypass active" = bypass_credit_check = true AND (credit_bypass_until IS NULL
--                   OR credit_bypass_until > now()).
--
-- As before this is independent of is_locked: a locked account stays blocked.

ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS credit_bypass_until timestamptz;

COMMENT ON COLUMN public.accounts.credit_bypass_until IS 'Expiry for the credit-check bypass: while bypass_credit_check is true and now() < this timestamp the bypass applies, after which credit limits block again automatically. Null = no expiry (runs until turned off).';
