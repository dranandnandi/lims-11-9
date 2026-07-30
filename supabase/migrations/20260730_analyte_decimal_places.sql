-- Per-analyte report display precision (decimal places, including integer).
--
-- Resolution order, most specific wins:
--   result_values.decimal_places  (per-result override, rare)
--   -> lab_analytes.decimal_places  (lab-level, set in the analyte editor)
--   -> analytes.decimal_places      (global master default)
--   -> labs.pdf_layout_settings.printOptions.defaultDecimalPlaces (lab-wide)
--   -> print the value exactly as entered
--
-- NULL means "inherit" and 0 means "round to integer", so these columns must
-- stay nullable with NO default -- a DEFAULT 2 on lab_analytes would mask the
-- global master value and make inheritance unreachable.
--
-- Related but distinct: lab_analyte_interface_config.decimal_places pins the
-- precision of the value that gets STORED (analyzer ingest and result entry).
-- These columns only affect how a stored value PRINTS. Same 0..6 range and the
-- same NULL/0 semantics so the two settings read consistently.

ALTER TABLE public.analytes
  ADD COLUMN IF NOT EXISTS decimal_places smallint;
ALTER TABLE public.lab_analytes
  ADD COLUMN IF NOT EXISTS decimal_places smallint;
ALTER TABLE public.result_values
  ADD COLUMN IF NOT EXISTS decimal_places smallint;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'analytes_decimal_places_range') THEN
    ALTER TABLE public.analytes ADD CONSTRAINT analytes_decimal_places_range
      CHECK (decimal_places IS NULL OR (decimal_places >= 0 AND decimal_places <= 6));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lab_analytes_decimal_places_range') THEN
    ALTER TABLE public.lab_analytes ADD CONSTRAINT lab_analytes_decimal_places_range
      CHECK (decimal_places IS NULL OR (decimal_places >= 0 AND decimal_places <= 6));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'result_values_decimal_places_range') THEN
    ALTER TABLE public.result_values ADD CONSTRAINT result_values_decimal_places_range
      CHECK (decimal_places IS NULL OR (decimal_places >= 0 AND decimal_places <= 6));
  END IF;
END $$;

COMMENT ON COLUMN public.analytes.decimal_places IS
  'Report display precision, global default for this analyte. NULL = inherit lab print options. 0 = round to integer.';
COMMENT ON COLUMN public.lab_analytes.decimal_places IS
  'Report display precision, lab override. NULL = inherit analytes.decimal_places then lab print options. 0 = round to integer.';
COMMENT ON COLUMN public.result_values.decimal_places IS
  'Report display precision, per-result override. NULL = inherit lab_analytes/analytes. 0 = round to integer.';

-- Expose the resolved precision on each analyte in the report context so the PDF
-- renderer and the on-screen preview both receive it. Body below is the live
-- definition with the single new 'decimal_places' key added; column list, order
-- and GROUP BY are unchanged (required by CREATE OR REPLACE VIEW).
CREATE OR REPLACE VIEW public.v_report_template_context AS
 SELECT o.id AS order_id,
    o.order_number,
    o.order_date,
    o.report_date,
    o.status,
    o.total_amount,
    o.sample_collected_at,
    o.sample_received_at,
    o.sample_id,
    o.color_code,
    o.color_name,
    o.qr_code_data,
    o.created_at AS order_created_at,
    o.lab_id,
    o.patient_id,
    o.location_id,
    o.referring_doctor_id,
    o.approved_by,
    p.name AS patient_name,
    p.display_id AS patient_display_id,
    p.patient_number,
    p.age,
    p.gender,
    p.phone AS patient_phone,
    p.date_of_birth,
    p.registration_date,
    l.name AS location_name,
    d.name AS referring_doctor_name,
    COALESCE(u_collector.name, u_collector.email) AS sample_collected_by,
    ( SELECT s.barcode
           FROM samples s
          WHERE s.order_id = o.id AND s.barcode IS NOT NULL
          ORDER BY s.created_at
         LIMIT 1) AS sample_barcode,
    GREATEST(max(rv.verified_at), ( SELECT max(r2.verified_at) AS max
           FROM results r2
             JOIN test_groups tg2 ON r2.test_group_id = tg2.id
          WHERE r2.order_id = o.id AND tg2.is_section_only = true AND r2.verification_status::text = 'verified'::text)) AS approved_at,
    bool_and(
        CASE
            WHEN rv.id IS NULL THEN true
            WHEN COALESCE(rv.is_hidden_from_report, false) THEN true
            WHEN rv.verify_status = 'approved'::text THEN true
            ELSE false
        END) AS all_analytes_approved,
    jsonb_agg(DISTINCT jsonb_build_object(
        'result_id', rv.result_id,
        'analyte_id', rv.analyte_id,
        'parameter', COALESCE(la.display_name, la.lab_specific_name, a.name::text),
        'value', rv.value,
        'unit', COALESCE(rv.unit, la.lab_specific_unit, a.unit),
        'method', COALESCE(rv.method, la.lab_specific_method, la.method),
        'reference_range', COALESCE(rv.reference_range, la.lab_specific_reference_range, a.reference_range),
        'flag', rv.flag,
        'verify_status', rv.verify_status,
        'test_group_id', tg.id,
        'test_name', tg.name,
        'normal_range_min', COALESCE(rv.normal_range_min, la.normal_range_min),
        'normal_range_max', COALESCE(rv.normal_range_max, la.normal_range_max),
        'low_critical', COALESCE(rv.low_critical, la.low_critical::text, la.critical_low::text, a.low_critical::text),
        'high_critical', COALESCE(rv.high_critical, la.high_critical::text, la.critical_high::text, a.high_critical::text),
        'reference_range_male', COALESCE(rv.reference_range_male, la.reference_range_male, a.reference_range_male),
        'reference_range_female', COALESCE(rv.reference_range_female, la.reference_range_female, a.reference_range_female),
        'value_type', COALESCE(rv.value_type, la.value_type, a.value_type),
        'expected_normal_values', COALESCE(la.expected_normal_values, a.expected_normal_values),
        'code', a.code,
        'interpretation_low', COALESCE(la.lab_specific_interpretation_low, la.interpretation_low, a.interpretation_low),
        'interpretation_normal', COALESCE(la.lab_specific_interpretation_normal, la.interpretation_normal, a.interpretation_normal),
        'interpretation_high', COALESCE(la.lab_specific_interpretation_high, la.interpretation_high, a.interpretation_high),
        'ai_interpretation', rv.ai_interpretation,
        'ai_suggested_flag', rv.ai_suggested_flag,
        'ai_suggested_interpretation', rv.ai_suggested_interpretation,
        'is_auto_calculated', rv.is_auto_calculated,
        'is_calculated', a.is_calculated,
        'decimal_places', COALESCE(rv.decimal_places, la.decimal_places, a.decimal_places),
        'sort_order', tga.sort_order,
        'section_heading', tga.section_heading)) FILTER (WHERE rv.id IS NOT NULL AND NOT COALESCE(rv.is_hidden_from_report, false)) AS analytes,
    array_agg(DISTINCT COALESCE(la.display_name, la.lab_specific_name, a.name::text)) FILTER (WHERE a.name IS NOT NULL AND rv.id IS NOT NULL AND NOT COALESCE(rv.is_hidden_from_report, false)) AS analyte_parameters,
    array_agg(DISTINCT tg.id) FILTER (WHERE tg.id IS NOT NULL AND (tg.is_section_only OR rv.id IS NOT NULL AND NOT COALESCE(rv.is_hidden_from_report, false))) AS test_group_ids
   FROM orders o
     LEFT JOIN patients p ON o.patient_id = p.id
     LEFT JOIN locations l ON o.location_id = l.id
     LEFT JOIN doctors d ON o.referring_doctor_id = d.id
     LEFT JOIN users u_collector ON o.sample_collected_by = u_collector.email::text
     LEFT JOIN order_tests ot ON o.id = ot.order_id
     LEFT JOIN test_groups tg ON ot.test_group_id = tg.id
     LEFT JOIN test_group_analytes tga ON tg.id = tga.test_group_id
     LEFT JOIN analytes a ON tga.analyte_id = a.id
     LEFT JOIN lab_analytes la ON a.id = la.analyte_id AND o.lab_id = la.lab_id
     LEFT JOIN result_values rv ON rv.order_id = o.id AND rv.analyte_id = a.id
  GROUP BY o.id, o.order_number, o.order_date, o.report_date, o.status, o.total_amount, o.sample_collected_at, o.sample_received_at, o.sample_id, o.color_code, o.color_name, o.qr_code_data, o.created_at, o.lab_id, o.patient_id, o.location_id, o.referring_doctor_id, o.approved_by, p.name, p.display_id, p.patient_number, p.age, p.gender, p.phone, p.date_of_birth, p.registration_date, l.name, d.name, u_collector.name, u_collector.email;
