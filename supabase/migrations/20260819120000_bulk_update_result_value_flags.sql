-- Applies a batch of flag / interpretation / range writes to result_values in
-- one round trip.
--
-- The client used to issue one PATCH per analyte after every result save. At
-- ~600ms each that cost ~14s for a 23 analyte order, and each write fired the
-- per-row order rollup, so the orders realtime channel emitted an update per
-- analyte and every subscribed screen refetched its whole list that many times.
--
-- This function writes the whole batch inside a single transaction, suppresses
-- the per-row rollup with the same app.bulk_result_entry contract that
-- save_result_entry_bulk uses, and recalculates each affected order once at the
-- end.
--
-- Payload shape: [{ "id": "<result_value_id>", "<column>": <value>, ... }, ...]
-- Only keys actually present are written; absent keys keep the stored value.
-- Only the columns whitelisted in the UPDATE below can be set, so an unexpected
-- key in the payload (verify_status, verified_by, ...) is ignored rather than
-- letting the caller write through this function.

CREATE OR REPLACE FUNCTION public.bulk_update_result_value_flags(p_updates JSONB)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_entry     JSONB;
  v_id        UUID;
  v_current   public.result_values%ROWTYPE;
  v_merged    public.result_values%ROWTYPE;
  v_updated   INTEGER := 0;
  v_order_ids UUID[] := ARRAY[]::UUID[];
  v_order_id  UUID;
BEGIN
  IF p_updates IS NULL OR jsonb_typeof(p_updates) <> 'array' THEN
    RAISE EXCEPTION 'p_updates must be a JSON array';
  END IF;

  IF jsonb_array_length(p_updates) = 0 THEN
    RETURN 0;
  END IF;

  PERFORM set_config('app.bulk_result_entry', 'on', true);

  FOR v_entry IN SELECT value FROM jsonb_array_elements(p_updates)
  LOOP
    v_id := NULLIF(v_entry->>'id', '')::UUID;
    IF v_id IS NULL THEN
      CONTINUE;
    END IF;

    -- Rows hidden by RLS, or deleted between analysis and save, are skipped
    -- rather than failing the batch.
    SELECT * INTO v_current FROM public.result_values WHERE id = v_id;
    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    -- Each row gets its own subtransaction, covering both the coercion of the
    -- payload and the write. prevent_verified_result_edit rejects a flag change
    -- on a verified or locked result, and a bad value in one entry fails its
    -- own coercion — either must skip that row the way the old per-row loop
    -- did, not discard the batch.
    BEGIN
      -- Fields missing from the payload are taken from the stored row, so an
      -- omitted key means "leave alone" and an explicit null means "clear".
      v_merged := jsonb_populate_record(v_current, v_entry - 'id');

      UPDATE public.result_values SET
        flag                   = v_merged.flag,
        flag_source            = v_merged.flag_source,
        flag_confidence        = v_merged.flag_confidence,
        ai_interpretation      = v_merged.ai_interpretation,
        ai_audit_status        = v_merged.ai_audit_status,
        -- reference_range is NOT NULL: a null in the payload keeps the stored
        -- range instead of failing the row on the constraint.
        reference_range        = COALESCE(v_merged.reference_range, v_current.reference_range),
        normal_range_min       = v_merged.normal_range_min,
        normal_range_max       = v_merged.normal_range_max,
        low_critical           = v_merged.low_critical,
        high_critical          = v_merged.high_critical,
        reference_range_male   = v_merged.reference_range_male,
        reference_range_female = v_merged.reference_range_female,
        method                 = v_merged.method,
        value_type             = v_merged.value_type,
        updated_at             = now()
      WHERE id = v_id;

      IF FOUND THEN
        v_updated := v_updated + 1;

        v_order_id := COALESCE(
          v_current.order_id,
          (SELECT r.order_id FROM public.results r WHERE r.id = v_current.result_id)
        );
        IF v_order_id IS NOT NULL AND NOT (v_order_id = ANY (v_order_ids)) THEN
          v_order_ids := array_append(v_order_ids, v_order_id);
        END IF;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'bulk_update_result_value_flags skipped % : %', v_id, SQLERRM;
    END;
  END LOOP;

  PERFORM set_config('app.bulk_result_entry', 'off', true);

  FOREACH v_order_id IN ARRAY v_order_ids
  LOOP
    PERFORM public.check_and_update_order_status(v_order_id);
  END LOOP;

  RETURN v_updated;
END;
$$;

REVOKE ALL ON FUNCTION public.bulk_update_result_value_flags(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bulk_update_result_value_flags(JSONB) TO authenticated;

COMMENT ON FUNCTION public.bulk_update_result_value_flags(JSONB) IS
  'Applies a batch of flag/interpretation/reference-range updates to result_values in one transaction, suppressing the per-row order rollup and recalculating each affected order once.';
