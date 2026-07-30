-- Leading-zero width for fixed-width legacy report formats.
--
-- Minimum digits BEFORE the decimal point, e.g. width 2 prints 3 as "03".
-- Complements decimal_places, which controls digits AFTER the point.
--
-- Display only: unlike decimal_places this is never pushed into the calculation
-- engines and never written to result_values.value. A stored "03" would read as
-- a formatting bug in the entry console, trend graphs, delta checks and
-- analyzer exports. Because it is applied at render time it also affects
-- results already in the database, with no recalculation needed.
--
-- NULL = inherit, 0 = off. Nullable with NO default, same as decimal_places.

ALTER TABLE public.analytes
  ADD COLUMN IF NOT EXISTS min_integer_digits smallint;
ALTER TABLE public.lab_analytes
  ADD COLUMN IF NOT EXISTS min_integer_digits smallint;
ALTER TABLE public.result_values
  ADD COLUMN IF NOT EXISTS min_integer_digits smallint;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'analytes_min_integer_digits_range') THEN
    ALTER TABLE public.analytes ADD CONSTRAINT analytes_min_integer_digits_range
      CHECK (min_integer_digits IS NULL OR (min_integer_digits >= 0 AND min_integer_digits <= 4));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lab_analytes_min_integer_digits_range') THEN
    ALTER TABLE public.lab_analytes ADD CONSTRAINT lab_analytes_min_integer_digits_range
      CHECK (min_integer_digits IS NULL OR (min_integer_digits >= 0 AND min_integer_digits <= 4));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'result_values_min_integer_digits_range') THEN
    ALTER TABLE public.result_values ADD CONSTRAINT result_values_min_integer_digits_range
      CHECK (min_integer_digits IS NULL OR (min_integer_digits >= 0 AND min_integer_digits <= 4));
  END IF;
END $$;

COMMENT ON COLUMN public.analytes.min_integer_digits IS
  'Leading-zero width for fixed-width report formats, global default. NULL = inherit lab print options, 0 = off, 2 prints 3 as "03". Display only.';
COMMENT ON COLUMN public.lab_analytes.min_integer_digits IS
  'Leading-zero width for fixed-width report formats, lab override. NULL = inherit analytes.min_integer_digits then lab print options. Display only.';
COMMENT ON COLUMN public.result_values.min_integer_digits IS
  'Leading-zero width for fixed-width report formats, per-result override. NULL = inherit. Display only.';

-- Expose the resolved width alongside decimal_places on each analyte in the
-- report context. Body is the live definition with one added key; column list,
-- order and GROUP BY unchanged (required by CREATE OR REPLACE VIEW).
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
        'min_integer_digits', COALESCE(rv.min_integer_digits, la.min_integer_digits, a.min_integer_digits),
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
