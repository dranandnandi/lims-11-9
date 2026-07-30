-- =============================================================================
-- Mispa Nano — outbound ORM^O01 test & specimen mappings (TEMPLATE)
-- =============================================================================
-- Connection : "mispa nano"
--   analyzer_connection_id = c016d1fa-5170-4171-ab2c-068b26986d3d
--   lab_id                 = b56db198-ad92-47dd-8a77-1aa7137280ea
--   analyzer_profile_id    = erba-xl640   (profile currently attached)
--   protocol               = HL7 / MLLP   (config.framing = "mllp")
--
-- WHY THIS FILE EXISTS
--   Without an explicit `order_service` row here, dispatch-order-to-analyzer
--   falls to its fallback branch and emits OBR-4 = "<LIMS name>^<LIMS name>^LOCAL"
--   at confidence 0.5 (exactly the "Random Blood Sugar ^..." message you saw).
--   Without a `specimen_mode` row, OBR-15 goes out blank (unresolved WHOLE_BLOOD).
--
-- HOW MATCHING WORKS (read before filling placeholders)
--   * order_service lookup filters test_mappings on:
--       lab_id, mapping_type='order_service', direction IN ('outbound','bidirectional'),
--       (analyzer_connection_id = <conn> OR analyzer_profile_id/analyzer_id = 'erba-xl640'),
--       AND lims_code IN (<codes sent>)   -- CASE-SENSITIVE exact match at the DB
--     `<codes sent>` = each test group's `code` (or its `name` when code is blank),
--     plus each lab_analyte `code`. Your log shows the *name* "Random Blood Sugar"
--     was sent, which means that test group has no short code.
--       -> Best practice: give the group a real code (e.g. RBS) and map THAT.
--       -> Quick fix: map lims_code to the exact string currently sent.
--   * OBR-4.1 (analyzer_code) MUST equal the analyzer's master test code configured
--     inside Mispa Nano — NOT the human-readable LIMS name. Trim all trailing spaces.
--   * specimen_mode lookup normalises both sides: "EDTA Blood" -> WHOLE_BLOOD.
--     hl7_field must be 'OBR-15' (or 'SPM-4'/'OBX-3') for HL7 or the row is ignored.
--
-- >>> REPLACE every <<...>> placeholder with the real value from the Mispa Nano
-- >>> LIS setting sheet or a captured accepted-order trace, then run this file.
-- =============================================================================

BEGIN;

-- Optional: clear any prior rows for this connection so re-runs are idempotent.
-- Comment out if you have hand-tuned rows you want to keep.
DELETE FROM public.test_mappings
WHERE analyzer_connection_id = 'c016d1fa-5170-4171-ab2c-068b26986d3d'
  AND mapping_type IN ('order_service', 'specimen_mode');

-- -----------------------------------------------------------------------------
-- 1) ORDER SERVICE mappings (one row per test the analyzer can run)
--    Duplicate the row block for each test. lims_code = what LIMS sends,
--    analyzer_code = Mispa Nano's master test code.
-- -----------------------------------------------------------------------------
INSERT INTO public.test_mappings (
    lab_id,
    analyzer_connection_id,
    analyzer_profile_id,
    analyzer_id,
    mapping_type,
    direction,
    lims_code,             -- exact string LIMS sends (group code, or name if no code)
    analyzer_code,         -- OBR-4.1 : Mispa Nano master test code  <-- REAL CODE
    analyzer_display,      -- OBR-4.2 : human-readable name
    analyzer_code_system,  -- OBR-4.3 : coding system (LOCAL unless vendor specifies)
    test_name,             -- NOT NULL
    supports_order_send,
    verified,
    ai_confidence
) VALUES
-- Random Blood Sugar (the test from your failing message)
(
    'b56db198-ad92-47dd-8a77-1aa7137280ea',
    'c016d1fa-5170-4171-ab2c-068b26986d3d',
    'erba-xl640',
    'erba-xl640',
    'order_service',
    'outbound',
    'Random Blood Sugar',          -- <<-- or change to your short code, e.g. 'RBS'
    '<<MISPA_RBS_CODE>>',          -- e.g. 'GLU' / 'RBS' / a numeric channel id
    'Random Blood Sugar',
    'LOCAL',
    'Random Blood Sugar',
    true,
    true,
    1.0
)
-- , (  -- add more tests by uncommenting and copying this block
--     'b56db198-ad92-47dd-8a77-1aa7137280ea',
--     'c016d1fa-5170-4171-ab2c-068b26986d3d',
--     'erba-xl640', 'erba-xl640', 'order_service', 'outbound',
--     '<<LIMS_CODE>>', '<<MISPA_CODE>>', '<<Display Name>>', 'LOCAL', '<<Test Name>>',
--     true, true, 1.0
-- )
;

-- -----------------------------------------------------------------------------
-- 2) SPECIMEN mapping (fills OBR-15). "EDTA Blood" normalises to WHOLE_BLOOD.
--    NOTE: chemistry glucose assays usually expect serum/plasma. Confirm which
--    specimen semantics Mispa Nano's assay setup wants before locking this in —
--    sending whole-blood semantics for a serum assay can cause silent rejection.
-- -----------------------------------------------------------------------------
INSERT INTO public.test_mappings (
    lab_id,
    analyzer_connection_id,
    analyzer_profile_id,
    analyzer_id,
    mapping_type,
    direction,
    lims_code,             -- normalised specimen key
    analyzer_code,         -- specimen code Mispa Nano expects  <-- REAL CODE
    analyzer_display,
    analyzer_code_system,
    hl7_field,             -- MUST be 'OBR-15' for this HL7 flow
    test_name,
    supports_order_send,
    verified,
    ai_confidence
) VALUES
(
    'b56db198-ad92-47dd-8a77-1aa7137280ea',
    'c016d1fa-5170-4171-ab2c-068b26986d3d',
    'erba-xl640',
    'erba-xl640',
    'specimen_mode',
    'outbound',
    'WHOLE_BLOOD',                 -- matches "EDTA Blood" via normaliser
    '<<MISPA_SPECIMEN_CODE>>',     -- e.g. 'WB' / 'SER' / 'PLAS' per assay setup
    '<<Specimen Display>>',        -- e.g. 'Whole Blood'
    'LOCAL',
    'OBR-15',
    'Whole Blood specimen',
    true,
    true,
    1.0
)
;

COMMIT;

-- -----------------------------------------------------------------------------
-- Verify what was inserted for this connection
-- -----------------------------------------------------------------------------
SELECT mapping_type, direction, lims_code, analyzer_code, analyzer_display,
       analyzer_code_system, hl7_field, supports_order_send
FROM public.test_mappings
WHERE analyzer_connection_id = 'c016d1fa-5170-4171-ab2c-068b26986d3d'
ORDER BY mapping_type, lims_code;
