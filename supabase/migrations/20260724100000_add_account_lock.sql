-- Account-level lock for B2B accounts.
--
-- Locking an account blocks new order creation against it (bill-to), for ALL
-- users. Only admins may lock or open an account (enforced in the app UI).
--
-- Two kinds of "open":
--   * Permanent open  -> is_locked = false (clears any override).
--   * Temporary open  -> is_locked stays true, but lock_override_until is set to
--                        a future timestamp. While now() < lock_override_until the
--                        account behaves as unlocked; after it passes, the account
--                        is locked again automatically (no re-lock action needed).
--
-- "Effectively locked" = is_locked = true AND (lock_override_until IS NULL OR
--                        lock_override_until <= now()).

ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS is_locked boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS locked_reason text,
  ADD COLUMN IF NOT EXISTS locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS locked_by uuid,
  ADD COLUMN IF NOT EXISTS lock_override_until timestamptz;

COMMENT ON COLUMN public.accounts.is_locked IS 'When true, account is on hold: new orders blocked (unless a future lock_override_until grants a temporary open window).';
COMMENT ON COLUMN public.accounts.locked_reason IS 'Optional reason captured when the account was locked.';
COMMENT ON COLUMN public.accounts.locked_at IS 'When the account was last locked.';
COMMENT ON COLUMN public.accounts.locked_by IS 'Auth user id of the admin who last locked the account.';
COMMENT ON COLUMN public.accounts.lock_override_until IS 'Temporary open window: while is_locked is true and now() < this timestamp, the account is treated as open. Null = no temporary window.';
