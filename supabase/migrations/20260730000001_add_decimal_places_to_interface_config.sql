-- ============================================================================
-- Per-analyte result precision for the analyzer interface.
--
-- Counts such as Platelets or TLC are meaningless with a fractional part, but
-- analyzers routinely send them with decimals and the unit conversion can add
-- more. decimal_places pins the stored value to a fixed number of digits.
--
-- NULL = leave the value exactly as received (existing behaviour, so nothing
-- already configured changes). 0 = round to a whole number.
-- ============================================================================

ALTER TABLE public.lab_analyte_interface_config
  ADD COLUMN IF NOT EXISTS decimal_places smallint;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'lab_analyte_interface_config_decimal_places_check'
  ) THEN
    ALTER TABLE public.lab_analyte_interface_config
      ADD CONSTRAINT lab_analyte_interface_config_decimal_places_check
      CHECK (decimal_places IS NULL OR (decimal_places >= 0 AND decimal_places <= 6));
  END IF;
END $$;

COMMENT ON COLUMN public.lab_analyte_interface_config.decimal_places IS
'Digits after the decimal point for this analyte''s result. NULL = keep the value as received; 0 = whole number (integer). Applied after dilution and multiply_by/add_offset conversion.';
