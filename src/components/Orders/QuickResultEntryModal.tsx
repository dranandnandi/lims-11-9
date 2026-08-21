// QuickResultEntryModal.tsx
// Fast keyboard-first manual result entry modal.
// No nested popups. Tab/Enter navigates between value cells.
// Reuses same DB schema (results + result_values) as OrderDetailsModal.

import React, { useState, useEffect, useRef, useCallback } from "react";
import ReactDOM from "react-dom";
import { X, Save, CheckCircle, ChevronDown, ChevronRight, Loader2, RefreshCw, EyeOff, Link2, Building2, ShieldCheck, Undo2, AlertTriangle } from "lucide-react";
import { supabase, database } from "../../utils/supabase";
import { useAuth } from "../../contexts/AuthContext";
import { calculateFlagsForResults, resolveFlag, detectFlagConflict, getFlagDescription, normalizeFlagCode, type ResolvedFlag } from "../../utils/flagCalculation";
import { selectPreferredCalculatedDependencies } from "../../utils/calculatedDependencies";
import { evaluateTextCalculation, normalizeCalculationResultType } from "../../utils/calculationRules";
import SectionEditor, { SectionEditorRef } from "../Results/SectionEditor";
import InlineDependencyEditor from "../Results/InlineDependencyEditor";
import OutsourcedReportUpload from "../Results/OutsourcedReportUpload";
import {
  applyAnalyteInterfaceConversion,
  getAnalyteInterfaceConfig,
  isAnalyteInterfaceConversionEnabled,
  type AnalyteInterfaceConversionConfig,
} from "../../utils/analyteInterfaceConversion";
import { normalizeResultFlagForSave } from "../../utils/referenceRangeService";
import {
  contextForGroup,
  fetchPatientRangeInfo,
  fetchRangeRules,
  rangeAuditColumns,
  resolveForAnalyte,
  type AnalyteRangeInput,
  type PatientRangeInfo,
  type RangeRuleMap,
} from "../../utils/referenceRangeLoader";
import {
  FALLBACK_DECIMAL_PLACES,
  normalizeDecimalPlaces,
  roundHalfUp,
} from "../../utils/resultValueFormat";

// ─── Types ───────────────────────────────────────────────────────────────────

// 'manual'  — picked by hand from the flag dropdown
// 'rule'    — derived from expected_value_flag_map for a qualitative selection
// undefined — computed from value + reference range
type FlagOrigin = "manual" | "rule";

interface AnalyteRow {
  test_group_id: string;
  analyte_id: string;
  lab_analyte_id?: string | null;
  parameter: string;
  value: string;
  unit: string;
  reference: string;
  flag: string;
  // Where the flag on this row came from. Only 'manual' — a human picking from
  // the flag dropdown — survives recalculation; everything else is recomputed
  // from the current value so a corrected entry cannot keep a stale flag.
  flag_origin?: FlagOrigin;
  is_calculated: boolean;
  is_existing: boolean;
  expected_normal_values: string[];
  expected_value_flag_map: Record<string, string>;
  value_type?: string;
  expected_value_codes?: Record<string, string>;
  default_value?: string;
  is_default?: boolean;
  formula?: string | null;
  formula_variables?: string[] | string | null;
  calculation_result_type?: string | null;
  // Report/calculation precision resolved from lab_analytes → analytes.
  decimal_places?: number | null;
  verify_note?: string;
  is_rerun?: boolean;
  is_hidden_from_report?: boolean;
  hidden_reason?: string;
  interface_config?: AnalyteInterfaceConversionConfig | null;
  interface_conversion_pending?: boolean;
  // Present only for analytes already persisted to result_values. Needed so a
  // saved row can be approved / unapproved without leaving the modal.
  result_value_id?: string | null;
  verify_status?: string | null;
  // How `reference` was decided. Recorded on save so the verification desk can
  // see why a patient got the range they did.
  range_rule_id?: string | null;
  range_source?: string | null;
  applied_range_rule?: string | null;
  // Set once the user types in the reference cell. A hand-edited range is never
  // overwritten by a re-resolve (e.g. when the sample condition changes).
  reference_edited?: boolean;
  // The analyte's legacy range columns, carried on the row so changing the
  // sample condition can re-resolve without re-querying lab_analytes.
  range_fallback?: AnalyteRangeInput;
  // Criticals carried by a matched rule. Only populated when the range came
  // from a rule, so labs without rules keep exactly the flagging they had.
  rule_low_critical?: number | null;
  rule_high_critical?: number | null;
}

interface TestGroup {
  test_group_id: string;
  test_group_name: string;
  order_test_group_id: string | null;
  order_test_id: string | null;
  is_section_only?: boolean;
  ref_range_ai_config?: { enabled?: boolean; consider_age?: boolean } | null;
  // Collection/sample condition configured on the test group (e.g. Fasting Blood
  // Serum, Random Blood Serum) plus the value already chosen for this order.
  sample_condition_options?: string[];
  default_sample_condition?: string | null;
  sample_condition?: string | null;
  // Lab-level default remark configured on the test group master.
  default_report_remark?: string | null;
	  analytes: {
	    id: string;
	    lab_analyte_id?: string | null;
	    name: string;
	    code?: string;
	    units?: string;
	    reference_range?: string;
	    lab_specific_reference_range?: string | null;
	    is_calculated?: boolean;
	    formula?: string | null;
	    formula_variables?: string[] | string | null;
	    calculation_result_type?: string | null;
	    decimal_places?: number | null;
	    expected_normal_values?: string[];
	    expected_value_flag_map?: Record<string, string>;
	    value_type?: string;
	    expected_value_codes?: Record<string, string>;
	    default_value?: string | null;
      interface_config?: AnalyteInterfaceConversionConfig | null;
	    existing_result?: {
      id?: string;
      value: string;
      unit?: string;
      reference_range?: string;
      flag?: string;
	      verify_note?: string;
	      verify_status?: string;
	      is_hidden_from_report?: boolean;
	      hidden_reason?: string;
	      analyte_name?: string;
      parameter?: string;
    } | null;
  }[];
}

// Outsourced tests have no analytes to key in — the external lab sends back a
// PDF. They are kept out of `testGroups` (and therefore out of the save path)
// and rendered as attach-only panels instead.
interface OutsourcedGroup {
  test_group_id: string;
  test_group_name: string;
  order_test_id: string;
  outsourced_lab_name: string | null;
}

interface QuickResultEntryModalProps {
  order: {
    id: string;
    lab_id: string;
    patient_name: string;
    patient_id: string;
    patient?: { age?: string | null; gender?: string | null } | null;
    tests: string[];
    sample_id?: string | null;
  };
  onClose: () => void;
  onSubmitted: () => void;
  showAutoVerifyOption?: boolean;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_FLAG_OPTIONS = [
  { value: "", label: "Normal" },
  { value: "H", label: "High" },
  { value: "L", label: "Low" },
  { value: "critical_h", label: "Crit. High" },
  { value: "critical_l", label: "Crit. Low" },
  { value: "A", label: "Abnormal" },
];

const hasMeaningfulTextValue = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

// ─── Helpers ─────────────────────────────────────────────────────────────────

// A decided verdict replaces whatever the row was carrying, so correcting a
// mistyped value clears the flag it produced. Only an explicit human pick is
// kept; an undecidable verdict leaves the existing flag alone.
const applyAutoFlag = (
  row: { flag: string; flag_origin?: FlagOrigin },
  resolved: ResolvedFlag | null,
): string =>
  row.flag_origin === "manual" || !resolved?.determined ? row.flag : resolved.flag;

const toNumber = (raw: string | number | null | undefined): number | null => {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(String(raw).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
};

const formatIndianNumber = (value: string): string => {
  const cleaned = value.replace(/,/g, '').trim();
  const num = parseFloat(cleaned);
  if (!Number.isFinite(num) || Math.abs(num) < 1000) return cleaned || value.trim();
  return new Intl.NumberFormat('en-IN').format(num);
};

const parseFormulaVars = (fv: string[] | string | null | undefined): string[] => {
  if (!fv) return [];
  if (Array.isArray(fv)) return fv.filter(Boolean);
  try { return JSON.parse(fv).filter(Boolean); } catch { return []; }
};

// Math function names that appear in formulas after normalization — skip during Phase 2 token scan.
const FORMULA_MATH_BUILTINS = new Set(['math', 'pow', 'abs', 'sqrt', 'min', 'max', 'ceil', 'floor', 'round', 'log', 'exp']);

// Derives a short variable slug from an analyte name (mirrors SimpleAnalyteEditor logic).
// Used as a fallback lookup key so formulas still resolve even if the dependency
// was linked to a different analyte UUID with the same name.
const toVariableSlug = (name: string): string => {
  const abbrevMap: Record<string, string> = {
    'total cholesterol': 'TC', 'hdl cholesterol': 'HDL', 'ldl cholesterol': 'LDL',
    'triglycerides': 'TG', 'hemoglobin': 'HGB', 'hematocrit': 'HCT',
    'red blood cell': 'RBC', 'white blood cell': 'WBC', 'platelet': 'PLT',
    'mean corpuscular volume': 'MCV', 'mean corpuscular hemoglobin': 'MCH',
    'albumin': 'ALB', 'globulin': 'GLOB', 'total protein': 'TP',
    'creatinine': 'CREAT', 'blood urea nitrogen': 'BUN', 'urea': 'UREA',
    'glucose': 'GLU', 'calcium': 'CA', 'sodium': 'NA', 'potassium': 'K',
  };
  const lower = name.toLowerCase();
  for (const [full, abbrev] of Object.entries(abbrevMap)) {
    if (lower.includes(full)) return abbrev.toLowerCase();
  }
  const words = name.replace(/[^a-zA-Z0-9\s]/g, '').split(/\s+/);
  if (words.length === 1) return words[0].substring(0, 4).toLowerCase();
  return words.map(w => w.substring(0, 3)).join('').toLowerCase().substring(0, 6);
};

  function evalFormula(
  formula: string,
  vars: string[],
  valueLookup: Map<string, number>,
  deps: { calculated_analyte_id: string; calculated_lab_analyte_id?: string | null; source_analyte_id: string; source_lab_analyte_id?: string | null; variable_name: string }[],
  analyteId: string,
  labAnalyteId?: string | null,
  calculationResultType?: string | null,
  decimalPlaces?: number | null,
): string {
  const scope: Record<string, number> = {};
  // Normalize math syntax first so 'pow'/'Math' tokens are handled before Phase 2 scanning.
  let resolved = formula.trim()
    .replace(/\bpow\s*\(/g, 'Math.pow(')
    .replace(/\^/g, '**');

  const analyteSliceDeps = selectPreferredCalculatedDependencies(
    deps,
    analyteId,
    labAnalyteId,
    new Set(valueLookup.keys()),
  );

  // Temporary diagnostics for calculated-parameter setup issues.
  const calcDebug = (stage: string, extra: Record<string, unknown>) =>
    console.info('[QuickEntry calc]', stage, {
      analyteId,
      labAnalyteId,
      formula,
      formula_variables: vars,
      calculation_result_type_raw: calculationResultType,
      calculation_result_type_normalized: normalizeCalculationResultType(calculationResultType),
      dependencies: analyteSliceDeps.map(d => ({
        variable: d.variable_name,
        source_analyte_id: d.source_analyte_id,
        source_lab_analyte_id: d.source_lab_analyte_id,
      })),
      ...extra,
    });

  // Phase 1: replace variables listed in formula_variables.
  // Does NOT return early on a missing var — formula text may use different token names (e.g. analyte codes)
  // that are resolved in Phase 2 below.
  for (const variable of vars) {
    const key = variable.toLowerCase();
    const dep = analyteSliceDeps.find(d => d.variable_name.toLowerCase() === key);
    let val: number | undefined = dep?.source_lab_analyte_id ? valueLookup.get(dep.source_lab_analyte_id) : undefined;
    if (val === undefined) val = dep ? valueLookup.get(dep.source_analyte_id) : undefined;
    if (val === undefined) val = valueLookup.get(key);
    if (val !== undefined) {
      scope[variable] = val;
      scope[variable.toUpperCase()] = val;
      scope[variable.toLowerCase()] = val;
      resolved = resolved.replace(new RegExp(`\\b${variable}\\b`, "g"), String(val));
    }
  }

  if (normalizeCalculationResultType(calculationResultType) === 'text') {
    const outcome = evaluateTextCalculation(formula, scope);
    calcDebug('text-rules', { scope, outcome });
    return outcome.value;
  }

  // Phase 2: resolve any remaining alphabetic tokens in the formula.
  // Handles mismatches where formula text uses analyte codes (e.g. SERCRE) that differ
  // from the formula_variables/dep variable names (e.g. CREAT1).
  const remainingTokens = resolved.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) || [];
  for (const token of remainingTokens) {
    if (FORMULA_MATH_BUILTINS.has(token.toLowerCase())) continue;
    const tokenKey = token.toLowerCase();
    const dep = analyteSliceDeps.find(d => d.variable_name.toLowerCase() === tokenKey);
    let val: number | undefined = dep?.source_lab_analyte_id ? valueLookup.get(dep.source_lab_analyte_id) : undefined;
    if (val === undefined && dep) val = valueLookup.get(dep.source_analyte_id);
    if (val === undefined) val = valueLookup.get(tokenKey);
    if (val === undefined) {
      calcDebug('numeric-unresolved-token', {
        token,
        resolvedSoFar: resolved,
        availableLookupKeys: Array.from(valueLookup.keys()),
        hint: 'If this formula is a JSON text rule, calculation_result_type is still "numeric" in lab_analytes.',
      });
      return "";
    }
    scope[token] = val;
    scope[token.toUpperCase()] = val;
    scope[token.toLowerCase()] = val;
    resolved = resolved.replace(new RegExp(`\\b${token}\\b`, "g"), String(val));
  }

  try {
    // eslint-disable-next-line no-new-func
    const result = new Function(`return (${resolved})`)();
    // Store at the analyte's configured precision so this modal, calculationEngine
    // and the PDF all agree. Unconfigured stays at 2 dp, as it always was.
    const decimals = normalizeDecimalPlaces(decimalPlaces) ?? FALLBACK_DECIMAL_PLACES;
    return typeof result === "number" && Number.isFinite(result)
      ? String(roundHalfUp(result, decimals))
      : "";
  } catch { return ""; }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const safeUuid = (v: string | null | undefined) => (v && UUID_RE.test(v) ? v : null);
const uuidProp = (key: string, value: string | null | undefined) => {
  const id = safeUuid(value);
  return id ? { [key]: id } : {};
};

// A row is keyed in fresh when it has no saved value yet, or when verification
// sent it back for a re-run. Everything else is shown in the saved panel.
const isEditableRow = (r: AnalyteRow) => !r.is_existing || !!r.is_rerun;

// test_groups.sample_condition_options is a free-form JSONB array — keep only
// non-empty strings so a stray null never renders as a blank dropdown entry.
const normalizeConditionOptions = (raw: unknown): string[] =>
  Array.isArray(raw)
    ? raw.map((v) => String(v ?? "").trim()).filter(Boolean)
    : [];

const getGroupKey = (tg: Pick<TestGroup, "test_group_id" | "order_test_group_id" | "order_test_id">) => {
  const orderTestGroupId = safeUuid(tg.order_test_group_id);
  const orderTestId = safeUuid(tg.order_test_id);
  if (orderTestGroupId) return `otg:${orderTestGroupId}`;
  if (orderTestId) return `ot:${orderTestId}`;
  return `tg:${tg.test_group_id}`;
};

// ─── Component ───────────────────────────────────────────────────────────────

const QuickResultEntryModal: React.FC<QuickResultEntryModalProps> = ({ order, onClose, onSubmitted, showAutoVerifyOption = true }) => {
  const { user } = useAuth();
  const [autoVerifyOnSubmit, setAutoVerifyOnSubmit] = useState(false);

    type DepRow = { calculated_analyte_id: string; calculated_lab_analyte_id?: string | null; source_analyte_id: string; source_lab_analyte_id?: string | null; variable_name: string };

  const [loading, setLoading] = useState(true);
  const [testGroups, setTestGroups] = useState<TestGroup[]>([]);
  const [outsourcedGroups, setOutsourcedGroups] = useState<OutsourcedGroup[]>([]);
  const [rows, setRows] = useState<AnalyteRow[]>([]);
  const [calcDeps, setCalcDeps] = useState<DepRow[]>([]);
  const [flagOptions, setFlagOptions] = useState(DEFAULT_FLAG_OPTIONS);
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: "success" | "error" } | null>(null);
  const [groupRemarks, setGroupRemarks] = useState<Record<string, string>>({});
  const [initialGroupRemarks, setInitialGroupRemarks] = useState<Record<string, string>>({});
  // Whether the remark above is printed on the report, keyed by test_group_id.
  // Unticking keeps the text on screen but leaves it off the PDF.
  const [remarkEnabled, setRemarkEnabled] = useState<Record<string, boolean>>({});
  const [initialRemarkEnabled, setInitialRemarkEnabled] = useState<Record<string, boolean>>({});
  // Sample condition chosen per test group (keyed by test_group_id). Mirrors the
  // selection made during sample collection so it can still be set/corrected here.
  const [sampleConditions, setSampleConditions] = useState<Record<string, string>>({});
  // Deterministic (non-AI) reference range rules, keyed by lab_analyte_id, plus
  // the patient facts they are matched against.
  const [rangeRules, setRangeRules] = useState<RangeRuleMap>(new Map());
  const [patientRangeInfo, setPatientRangeInfo] = useState<PatientRangeInfo | null>(null);
  const [initialSampleConditions, setInitialSampleConditions] = useState<Record<string, string>>({});
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  // Saved analytes render collapsed by default — a group is only expanded once
  // the user explicitly opens it to review or edit.
  const [expandedSavedGroups, setExpandedSavedGroups] = useState<Set<string>>(new Set());
  const [approvingKey, setApprovingKey] = useState<string | null>(null);
  const [showApproveAllButton, setShowApproveAllButton] = useState(false);
  // result row IDs per test_group_id — needed to render SectionEditor
  const [resultIds, setResultIds] = useState<Map<string, string>>(new Map());
  // Inline dependency editor state
  const [editingDependency, setEditingDependency] = useState<{
    row: AnalyteRow;
    missingVariables: string[];
  } | null>(null);

  // Flat refs for every value input/select in render order (for keyboard nav)
  const valueRefs = useRef<(HTMLInputElement | HTMLSelectElement | null)[]>([]);
  // Refs to SectionEditor instances keyed by test_group_id — used to save on Done
  const sectionEditorRefs = useRef<Map<string, React.RefObject<SectionEditorRef>>>(new Map());
  const getSectionEditorRef = (testGroupId: string) => {
    if (!sectionEditorRefs.current.has(testGroupId)) {
      sectionEditorRefs.current.set(testGroupId, React.createRef<SectionEditorRef>());
    }
    return sectionEditorRefs.current.get(testGroupId)!;
  };

  // ── Data loading ────────────────────────────────────────────────────────────

  useEffect(() => {
    loadData();
    loadFlagOptions();
    loadApproveAllSetting();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order.id]);

  useEffect(() => {
    if (
      activeGroupId &&
      !testGroups.some((tg) => tg.test_group_id === activeGroupId) &&
      !outsourcedGroups.some((og) => og.test_group_id === activeGroupId)
    ) {
      setActiveGroupId(null);
    }
  }, [activeGroupId, testGroups, outsourcedGroups]);

  const loadFlagOptions = async () => {
    try {
      const { data } = await supabase.from("labs").select("flag_options").eq("id", order.lab_id).single();
      if (data?.flag_options?.length) setFlagOptions(data.flag_options);
    } catch { /* keep defaults */ }
  };

  // Kept as its own query so a lab that has not run the migration yet still gets
  // its flag options — the button simply stays hidden.
  const loadApproveAllSetting = async () => {
    try {
      const { data, error } = await supabase
        .from("labs")
        .select("show_approve_all_in_result_entry")
        .eq("id", order.lab_id)
        .single();
      if (error) throw error;
      setShowApproveAllButton(!!(data as any)?.show_approve_all_in_result_entry);
    } catch { setShowApproveAllButton(false); }
  };

  const loadData = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("orders")
        .select(`
          id, lab_id, patient_id, patient_name,
          order_test_groups(
            id, test_group_id, test_name, sample_condition,
            test_groups(
              id, name, is_section_only, ref_range_ai_config, sample_condition_options, default_sample_condition, default_report_remark,
              test_group_analytes(
                analyte_id, lab_analyte_id, sort_order, display_order,
                analytes(id, name, code, unit, reference_range, is_calculated, formula, formula_variables, calculation_result_type, decimal_places, expected_normal_values, expected_value_flag_map, value_type, expected_value_codes),
                lab_analytes(id, name, unit, reference_range, lab_specific_reference_range, is_calculated, formula, formula_variables, calculation_result_type, decimal_places, expected_normal_values, expected_value_flag_map, value_type, expected_value_codes, default_value, lab_analyte_interface_config(multiply_by, add_offset, decimal_places, lims_unit, apply_to_quick_result_entry))
              )
            )
          ),
          order_tests(
            id, test_name, test_group_id, is_canceled, outsourced_lab_id, sample_condition,
            outsourced_labs(name),
            test_groups(
              id, name, is_section_only, ref_range_ai_config, sample_condition_options, default_sample_condition, default_report_remark,
              test_group_analytes(
                analyte_id, lab_analyte_id, sort_order, display_order,
                analytes(id, name, code, unit, reference_range, is_calculated, formula, formula_variables, calculation_result_type, decimal_places, expected_normal_values, expected_value_flag_map, value_type, expected_value_codes),
                lab_analytes(id, name, unit, reference_range, lab_specific_reference_range, is_calculated, formula, formula_variables, calculation_result_type, decimal_places, expected_normal_values, expected_value_flag_map, value_type, expected_value_codes, default_value, lab_analyte_interface_config(multiply_by, add_offset, decimal_places, lims_unit, apply_to_quick_result_entry))
              )
            )
          ),
          results(
            id, order_test_group_id, order_test_id, test_group_id, notes, report_remark_enabled,
		            result_values(id, analyte_id, lab_analyte_id, analyte_name, parameter, value, unit, reference_range, flag, verify_note, verify_status, is_hidden_from_report, hidden_reason)
          )
        `)
        .eq("id", order.id)
        .single();

      if (error) throw error;

      const mapAnalytes = (tgaList: any[], results: any[], otgId: string | null, otId: string | null) =>
        [...(tgaList || [])].sort((a, b) => {
          const ao = a.sort_order ?? a.display_order ?? 0;
          const bo = b.sort_order ?? b.display_order ?? 0;
          return ao - bo;
        }).map((tga: any) => {
          const a = tga.analytes;
          // Prefer lab_analytes config when lab_analyte_id is set (no join ambiguity)
          // la fields override global analyte fields for is_calculated, formula, reference_range, etc.
          const la = tga.lab_analyte_id ? tga.lab_analytes : null;
          const resultRow = results?.find((r: any) =>
            (otgId && r.order_test_group_id === otgId) ||
            (otId && r.order_test_id === otId) ||
            (!otgId && !otId && r.test_group_id === a?.test_group_id)
          );
	          let existing = resultRow?.result_values?.find((rv: any) =>
		            (tga.lab_analyte_id && rv.lab_analyte_id === tga.lab_analyte_id) ||
		            rv.analyte_id === a?.id ||
	            (!rv.analyte_id && (rv.analyte_name === a?.name || rv.parameter === a?.name))
	          ) || null;
          // Merge: spread global analyte fields first, then override with lab_analytes fields
          const merged = la ? {
            ...a,
            lab_analyte_id: tga.lab_analyte_id || la.id || null,
            name: la.name || a?.name,
            unit: la.unit || a?.unit,
            reference_range: la.lab_specific_reference_range ?? la.reference_range ?? a?.reference_range,
            is_calculated: la.is_calculated ?? a?.is_calculated,
            formula: la.formula ?? a?.formula,
            formula_variables: la.formula_variables ?? a?.formula_variables,
            calculation_result_type: la.calculation_result_type ?? a?.calculation_result_type ?? 'numeric',
            decimal_places: la.decimal_places ?? a?.decimal_places ?? null,
            expected_normal_values: la.expected_normal_values ?? a?.expected_normal_values,
            expected_value_flag_map: la.expected_value_flag_map ?? a?.expected_value_flag_map,
            value_type: la.value_type ?? a?.value_type,
            expected_value_codes: la.expected_value_codes ?? a?.expected_value_codes,
            default_value: la.default_value ?? null,
            interface_config: getAnalyteInterfaceConfig(la.lab_analyte_interface_config),
          } : a;
          return { ...merged, units: merged?.unit, existing_result: existing };
        }).filter(Boolean);

      const tgFromOTG: TestGroup[] = (data.order_test_groups || [])
        .filter((otg: any) => otg.test_groups)
        .map((otg: any) => ({
          test_group_id: otg.test_groups.id,
          test_group_name: otg.test_groups.name,
          order_test_group_id: otg.id,
          order_test_id: null,
          is_section_only: !!otg.test_groups.is_section_only,
          ref_range_ai_config: otg.test_groups.ref_range_ai_config || null,
          sample_condition_options: normalizeConditionOptions(otg.test_groups.sample_condition_options),
          default_sample_condition: otg.test_groups.default_sample_condition || null,
          default_report_remark: otg.test_groups.default_report_remark || null,
          sample_condition: otg.sample_condition || null,
          analytes: mapAnalytes(otg.test_groups.test_group_analytes, data.results, otg.id, null),
        }));

      const tgFromOT: TestGroup[] = (data.order_tests || [])
        .filter((ot: any) => ot.test_groups && ot.test_group_id && !ot.is_canceled && !ot.outsourced_lab_id)
        .map((ot: any) => ({
          test_group_id: ot.test_groups.id,
          test_group_name: ot.test_groups.name,
          order_test_group_id: null,
          order_test_id: ot.id,
          is_section_only: !!ot.test_groups.is_section_only,
          ref_range_ai_config: ot.test_groups.ref_range_ai_config || null,
          sample_condition_options: normalizeConditionOptions(ot.test_groups.sample_condition_options),
          default_sample_condition: ot.test_groups.default_sample_condition || null,
          default_report_remark: ot.test_groups.default_report_remark || null,
          sample_condition: ot.sample_condition || null,
          analytes: mapAnalytes(ot.test_groups.test_group_analytes, data.results, null, ot.id),
        }));

      // Outsourced tests are excluded from analyte entry above, but the lab still
      // has to attach the report the external lab sends back. Collect them
      // separately so the save path stays untouched.
      const outsourced: OutsourcedGroup[] = (data.order_tests || [])
        .filter((ot: any) => ot.test_groups && ot.test_group_id && !ot.is_canceled && ot.outsourced_lab_id)
        .map((ot: any) => {
          const labInfo = Array.isArray(ot.outsourced_labs) ? ot.outsourced_labs[0] : ot.outsourced_labs;
          return {
            test_group_id: ot.test_groups.id,
            test_group_name: ot.test_groups.name,
            order_test_id: ot.id,
            outsourced_lab_name: labInfo?.name || null,
          };
        })
        .reduce<OutsourcedGroup[]>((acc, cur) => {
          if (!acc.some((g) => g.test_group_id === cur.test_group_id)) acc.push(cur);
          return acc;
        }, []);

      // Merge groups by test_group_id
      const merged = [...tgFromOTG, ...tgFromOT].reduce<TestGroup[]>((acc, cur) => {
        const idx = acc.findIndex(t => t.test_group_id === cur.test_group_id);
        if (idx === -1) { acc.push(cur); } else {
          const m = acc[idx];
          const merged2 = [...m.analytes];
          cur.analytes.forEach(a => { if (!merged2.find(x => x.id === a.id)) merged2.push(a); });
          acc[idx] = {
            ...m,
            analytes: merged2,
            order_test_group_id: m.order_test_group_id || cur.order_test_group_id,
            order_test_id: m.order_test_id || cur.order_test_id,
            is_section_only: m.is_section_only || cur.is_section_only,
            sample_condition_options: m.sample_condition_options?.length
              ? m.sample_condition_options
              : cur.sample_condition_options,
            default_sample_condition: m.default_sample_condition || cur.default_sample_condition,
            default_report_remark: m.default_report_remark || cur.default_report_remark,
            sample_condition: m.sample_condition || cur.sample_condition,
          };
        }
        return acc;
      }, []);

	      // Fetch any missing lab_analytes overrides by exact lab_analyte_id.
	      // Do not fall back by analyte_id: the same analyte can appear in different
	      // test groups (for example Urine Color and Stool Color) with different defaults.
	      const allLabAnalyteIds = Array.from(new Set(
	        merged.flatMap(tg => tg.analytes.map(a => a.lab_analyte_id).filter(Boolean))
	      ));
	      let labAnalytesMap = new Map<string, any>();
	      if (allLabAnalyteIds.length > 0 && data.lab_id) {
	        const { data: la } = await supabase
	          .from("lab_analytes")
	          .select("id, analyte_id, decimal_places, expected_normal_values, expected_value_flag_map, value_type, expected_value_codes, default_value, reference_range, lab_specific_reference_range, reference_range_male, reference_range_female, low_critical, high_critical, is_calculated, formula, formula_variables, calculation_result_type, lab_analyte_interface_config(multiply_by, add_offset, decimal_places, lims_unit, apply_to_quick_result_entry)")
	          .eq("lab_id", data.lab_id)
	          .in("id", allLabAnalyteIds);
	        if (la) {
	          for (const x of la as any[]) {
	            if (x.id) labAnalytesMap.set(x.id, x);
	          }
	        }
	      }

	      // Deterministic range rules + the patient facts they match on. Both are
	      // best-effort: without them the legacy columns still resolve a range.
	      const [loadedRules, loadedPatientInfo] = await Promise.all([
	        fetchRangeRules(allLabAnalyteIds as string[]),
	        fetchPatientRangeInfo(order.id, order.patient_id),
	      ]);
	      setRangeRules(loadedRules);
	      setPatientRangeInfo(loadedPatientInfo);

      setTestGroups(merged);
      // A group that also arrives via order_test_groups already has an entry
      // panel — don't give it a second, attach-only one.
      setOutsourcedGroups(outsourced.filter((og) => !merged.some((tg) => tg.test_group_id === og.test_group_id)));
      const findResultRow = (tg: TestGroup) => (data.results || []).find((r: any) =>
        (tg.order_test_group_id && r.order_test_group_id === tg.order_test_group_id) ||
        (tg.order_test_id && r.order_test_id === tg.order_test_id) ||
        r.test_group_id === tg.test_group_id
      );
      // The test group's default remark wins whenever one is configured, so a
      // change to the master text reaches orders that were entered earlier.
      // Groups without a default keep whatever was typed for this order.
      const storedRemarks = Object.fromEntries(
        merged.map((tg) => [tg.test_group_id, findResultRow(tg)?.notes || ""])
      );
      const loadedRemarks = Object.fromEntries(
        merged.map((tg) => [
          tg.test_group_id,
          (tg.default_report_remark || "").trim() || storedRemarks[tg.test_group_id],
        ])
      );
      setGroupRemarks(loadedRemarks);
      // Compare against what is actually stored, so a group whose default differs
      // from its saved note is treated as dirty and gets rewritten on submit.
      setInitialGroupRemarks(storedRemarks);

      // A saved row carries its own toggle; an untouched group starts ticked so a
      // remark prints unless the technician says otherwise.
      const loadedRemarkEnabled = Object.fromEntries(
        merged.map((tg) => {
          const resultRow = findResultRow(tg);
          return [tg.test_group_id, resultRow ? resultRow.report_remark_enabled !== false : true];
        })
      );
      setRemarkEnabled(loadedRemarkEnabled);
      setInitialRemarkEnabled(loadedRemarkEnabled);

      // Prefill from the value stored at collection; fall back to the group default
      // when it is still one of the configured options. Never invent a value.
      const loadedConditions = Object.fromEntries(
        merged
          .filter((tg) => (tg.sample_condition_options?.length || 0) > 0)
          .map((tg) => {
            const options = tg.sample_condition_options || [];
            const stored = (tg.sample_condition || "").trim();
            const fallback = (tg.default_sample_condition || "").trim();
            const selected = stored || (options.includes(fallback) ? fallback : "");
            return [tg.test_group_id, selected];
          })
      );
      setSampleConditions(loadedConditions);
      setInitialSampleConditions(loadedConditions);

      // Build result ID map from existing result rows
      const resultIdMap = new Map<string, string>();
      for (const r of (data.results || [])) {
        if (r.test_group_id) resultIdMap.set(r.test_group_id, r.id);
      }
      // Find test groups that have technician-editable sections
      const groupIds = merged.map(tg => tg.test_group_id).filter(Boolean);
      if (groupIds.length > 0) {
        const { data: techSections } = await supabase
          .from("lab_template_sections")
          .select("test_group_id")
          .eq("allow_technician_entry", true)
          .in("test_group_id", groupIds);

        const techGroupIds = new Set((techSections || []).map((s: any) => s.test_group_id));

        // Also include section-only groups so they always get a result stub
        const sectionOnlyIds = new Set(
          merged.filter(tg => tg.is_section_only).map(tg => tg.test_group_id)
        );
        const needsStubIds = new Set([...techGroupIds, ...sectionOnlyIds]);

        if (needsStubIds.size > 0) {
          // Pre-create stub result rows for groups that have technician sections or are section-only
	          const [{ data: { user: currentUser } }, userLabId] = await Promise.all([
	            supabase.auth.getUser(),
	            database.getCurrentUserLabId(),
	          ]);
	          const currentLabId = safeUuid(userLabId);
	          if (!currentLabId) throw new Error("No valid lab ID found for current user");
	          for (const tg of merged) {
            if (!needsStubIds.has(tg.test_group_id)) continue;
            if (resultIdMap.has(tg.test_group_id)) continue;
            const { data: stub } = await supabase
              .from("results")
              .upsert({
                order_id: order.id,
                patient_id: safeUuid(order.patient_id),
                patient_name: order.patient_name,
                test_name: tg.test_group_name,
                status: "pending_verification",
                entered_by: currentUser?.email || "Unknown",
                entered_date: new Date().toISOString().split("T")[0],
                test_group_id: tg.test_group_id,
	                lab_id: currentLabId,
                ...uuidProp("order_test_group_id", tg.order_test_group_id),
                ...uuidProp("order_test_id", tg.order_test_id),
              }, { onConflict: "order_id,test_name", ignoreDuplicates: false })
              .select()
              .single();
            if (stub?.id) resultIdMap.set(tg.test_group_id, stub.id);
          }
        }
      }

      setResultIds(resultIdMap);


	      // Build flat rows
	      const flat: AnalyteRow[] = merged.flatMap(tg => {
	        // One context per group — sample condition is per-group, the patient
	        // facts are per-order.
	        const rangeCtx = contextForGroup(loadedPatientInfo, loadedConditions[tg.test_group_id]);
	        return tg.analytes.map(a => {
	          const la = a.lab_analyte_id ? (labAnalytesMap.get(a.lab_analyte_id) || a) : a;
	          const rangeFallback: AnalyteRangeInput = {
	            lab_analyte_id: a.lab_analyte_id,
	            lab_specific_reference_range: la?.lab_specific_reference_range,
	            reference_range: la?.reference_range ?? a.reference_range,
	            reference_range_male: la?.reference_range_male,
	            reference_range_female: la?.reference_range_female,
	            low_critical: la?.low_critical,
	            high_critical: la?.high_critical,
	          };
	          const resolvedRange = resolveForAnalyte(loadedRules, rangeFallback, rangeCtx);
	          let envValues: string[] = a.expected_normal_values || [];
	          let envMap: Record<string, string> = a.expected_value_flag_map || {};
          if (la?.expected_normal_values) {
            try { const p = typeof la.expected_normal_values === "string" ? JSON.parse(la.expected_normal_values) : la.expected_normal_values; if (p?.length) envValues = p; } catch { /* */ }
          }
          if (la?.expected_value_flag_map) {
            try { const p = typeof la.expected_value_flag_map === "string" ? JSON.parse(la.expected_value_flag_map) : la.expected_value_flag_map; if (Object.keys(p).length) envMap = p; } catch { /* */ }
          }
          // value_type and expected_value_codes: lab override wins if set
          let envValueType: string | undefined = a.value_type;
          let envCodes: Record<string, string> = a.expected_value_codes || {};
          if (la?.value_type) {
            envValueType = la.value_type;
          }
          if (la?.expected_value_codes) {
            try {
              const p = typeof la.expected_value_codes === "string" ? JSON.parse(la.expected_value_codes) : la.expected_value_codes;
              if (p && Object.keys(p).length) envCodes = p;
            } catch { /* */ }
          }
          const envDefaultValue: string = la?.default_value || "";
          const defaultFlag = envDefaultValue ? (envMap[envDefaultValue] ?? "") : "";
          const isRerun = !!(a.existing_result?.verify_note && String(a.existing_result.verify_note).toUpperCase().includes("RE-RUN"));
	          const isHiddenExisting = !!a.existing_result?.is_hidden_from_report;
	          const hasExisting = (hasMeaningfulTextValue(a.existing_result?.value) || isHiddenExisting) && !isRerun;
          // Pre-fill default only for new (unsaved) results
          const prefillValue = hasExisting
            ? a.existing_result!.value
            : (isRerun ? (a.existing_result?.value || "") : (envDefaultValue || ""));
          return {
	            test_group_id: tg.test_group_id,
	            analyte_id: a.id,
	            lab_analyte_id: a.lab_analyte_id || null,
            parameter: a.name,
            value: prefillValue,
            unit: a.existing_result?.unit || a.units || "",
            // A range already saved on the result wins: it is the range the
            // patient was actually reported against. Only a fresh row picks up
            // the currently resolved one.
            reference: a.existing_result?.reference_range ?? resolvedRange.range_text ?? "",
            range_rule_id: resolvedRange.rule_id,
            range_source: resolvedRange.source,
            applied_range_rule: resolvedRange.applied_rule,
            reference_edited: false,
            range_fallback: rangeFallback,
            rule_low_critical: resolvedRange.source === 'rule' ? resolvedRange.low_critical : null,
            rule_high_critical: resolvedRange.source === 'rule' ? resolvedRange.high_critical : null,
            flag: a.existing_result?.flag || defaultFlag,
            // A flag already in the database is not treated as a human override:
            // rows saved before flag_source was tracked honestly all read
            // 'manual', so re-entering a value is allowed to correct them. A
            // deliberate override is re-applied from the flag dropdown.
            flag_origin: (!a.existing_result?.flag && defaultFlag ? "rule" : undefined) as FlagOrigin | undefined,
            // lab_analytes overrides win for calculated-param fields
            is_calculated: la?.is_calculated != null ? !!la.is_calculated : !!a.is_calculated,
            is_existing: hasExisting,
            expected_normal_values: envValues,
            expected_value_flag_map: envMap,
            value_type: envValueType,
            expected_value_codes: envCodes,
            default_value: envDefaultValue,
            interface_config: getAnalyteInterfaceConfig(
              la?.lab_analyte_interface_config || a.interface_config,
            ),
            interface_conversion_pending: false,
            // Mark as default-prefilled so the UI can style it differently
            is_default: !hasExisting && !isRerun && !!envDefaultValue,
	            formula: la?.formula ?? a.formula ?? null,
	            formula_variables: la?.formula_variables ?? a.formula_variables ?? null,
	            calculation_result_type: la?.calculation_result_type ?? a.calculation_result_type ?? 'numeric',
	            decimal_places: la?.decimal_places ?? a.decimal_places ?? null,
	            verify_note: isRerun ? a.existing_result?.verify_note || "" : "",
	            is_rerun: isRerun,
	            result_value_id: hasExisting ? a.existing_result?.id || null : null,
	            verify_status: hasExisting ? a.existing_result?.verify_status || "pending" : null,
	            is_hidden_from_report: isHiddenExisting,
	            hidden_reason: a.existing_result?.hidden_reason || "",
	          };
        });
      });

      // Load analyte_dependencies for live formula evaluation
      // Prefer lab-specific rows; fall back to global (lab_id IS NULL) when no lab override exists
      // Use flat (which has lab_analytes overrides applied) so lab-level is_calculated=true is respected
      const calcIds = flat.filter(r => r.is_calculated).map(r => r.analyte_id).filter(Boolean) as string[];
      let loadedDeps: DepRow[] = [];
      if (calcIds.length > 0) {
        const { data: depsData } = await supabase
          .from("analyte_dependencies")
          .select("calculated_analyte_id, calculated_lab_analyte_id, source_analyte_id, source_lab_analyte_id, variable_name, lab_id")
          .in("calculated_analyte_id", calcIds)
          .or(`lab_id.eq.${data.lab_id},lab_id.is.null`);
        loadedDeps = (depsData || []) as DepRow[];
        setCalcDeps(loadedDeps);
      }

      // Auto-evaluate formulas on load using existing_result values (locked/saved analytes)
      // so calculated params (e.g. MCHC, Bilirubin Indirect) show correct values immediately
      const patientAgeLoad = order.patient?.age ? Number(order.patient.age) : null;
      const patientGenderLoad = order.patient?.gender;
      const lookup = new Map<string, number>();
      if (patientAgeLoad !== null && Number.isFinite(patientAgeLoad)) lookup.set('age', patientAgeLoad);
      if (patientGenderLoad) {
        lookup.set('gender_male', patientGenderLoad === 'Male' ? 1 : 0);
        lookup.set('gender_female', patientGenderLoad === 'Female' ? 1 : 0);
        lookup.set('gender', patientGenderLoad === 'Male' ? 1 : 0);
      }
      for (const r of flat) {
        if (r.is_calculated) continue;
        const num = toNumber(r.value);
        if (num !== null) {
          if (r.analyte_id) lookup.set(r.analyte_id, num);
          if (r.lab_analyte_id) lookup.set(r.lab_analyte_id, num);
          lookup.set(r.parameter.toLowerCase(), num);
          lookup.set(toVariableSlug(r.parameter), num);
        }
      }
      // Also seed by analyte code so formula variables using codes (e.g. SERCRE, CREAT1) resolve correctly.
      for (const tg of merged) {
        for (const a of tg.analytes) {
          if (a.is_calculated) continue;
          if (!(a as any).code) continue;
          const existingVal = a.existing_result?.value;
          const num = toNumber(existingVal ?? "");
          if (num !== null) lookup.set(String((a as any).code).toLowerCase(), num);
        }
      }
      // Temporary diagnostics: what the DB actually returned for each calculated row.
      console.info('[QuickEntry calc] rows loaded', flat
        .filter(r => r.is_calculated)
        .map(r => ({
          parameter: r.parameter,
          analyte_id: r.analyte_id,
          lab_analyte_id: r.lab_analyte_id,
          calculation_result_type: r.calculation_result_type,
          formula: r.formula,
          formula_variables: r.formula_variables,
          is_existing: r.is_existing,
        })));

      const flatWithCalc = flat.map(r => {
        if (!r.is_calculated || !r.formula || r.is_existing) return r;
        const vars = parseFormulaVars(r.formula_variables);
        const calcVal = evalFormula(r.formula, vars, lookup, loadedDeps, r.analyte_id, r.lab_analyte_id, r.calculation_result_type, r.decimal_places);
        if (!calcVal) return r;
        const resolved = normalizeCalculationResultType(r.calculation_result_type) === 'text'
          ? null
          : resolveFlag(calcVal, r.reference, undefined, undefined, undefined, undefined, undefined, undefined, r.value_type);
        return { ...r, value: formatIndianNumber(calcVal), flag: applyAutoFlag(r, resolved) };
      });
      setRows(flatWithCalc);
    } catch (err) {
      console.error("QuickResultEntry load error:", err);
      setMessage({
        text: `Could not load analytes: ${err instanceof Error ? err.message : (err as any)?.message || "Unknown error"}`,
        type: "error",
      });
    } finally {
      setLoading(false);
    }
  };

  // ── Row mutations ───────────────────────────────────────────────────────────

  const toggleHiddenFromReport = useCallback((idx: number) => {
    setRows(prev => prev.map((r, i) => {
      if (i !== idx) return r;
      const nextHidden = !r.is_hidden_from_report;
      return {
        ...r,
        is_hidden_from_report: nextHidden,
        hidden_reason: nextHidden ? (r.hidden_reason || "Hidden from report") : "",
      };
    }));
  }, []);

  const handleValueBlur = useCallback((idx: number, value: string) => {
    setRows(prev => {
      // 1. Update the edited row
      const next = prev.map((r, i) => {
        if (i !== idx) return r;
        const rawValue = value.replace(/,/g, '');
        const convertedValue = r.interface_conversion_pending
          ? applyAnalyteInterfaceConversion(rawValue, r.interface_config, "quick")
          : rawValue;
        const displayValue = formatIndianNumber(convertedValue);
        const resolved = resolveFlag(convertedValue, r.reference, undefined, undefined, undefined, undefined, undefined, undefined, r.value_type);
        return {
          ...r,
          value: displayValue,
          unit: r.interface_config &&
            isAnalyteInterfaceConversionEnabled(r.interface_config, "quick")
            ? r.interface_config.lims_unit || r.unit
            : r.unit,
          flag: applyAutoFlag(r, resolved),
          interface_conversion_pending: false,
        };
      });

      // 2. Rebuild value lookup from all non-calculated rows
      const lookup = new Map<string, number>();
      // Inject patient context so formulas like eGFR can use AGE / GENDER_MALE
      const patientAge = order.patient?.age ? Number(order.patient.age) : null;
      const patientGender = order.patient?.gender;
      if (patientAge !== null && Number.isFinite(patientAge)) {
        lookup.set('age', patientAge);
      }
      if (patientGender) {
        lookup.set('gender_male', patientGender === 'Male' ? 1 : 0);
        lookup.set('gender_female', patientGender === 'Female' ? 1 : 0);
        lookup.set('gender', patientGender === 'Male' ? 1 : 0);
      }
      // Seed lookup with already-saved analyte values (existing_result) so formulas
      // that depend on previously entered analytes (e.g. MCHC = HGB / HCT * 100)
      // still evaluate correctly when those dependencies are already in is_existing state.
      for (const tg of testGroups) {
        for (const a of tg.analytes) {
          if (a.is_calculated) continue;
          const savedVal = a.existing_result?.value;
          const num = toNumber(savedVal);
          if (num !== null) {
            if (a.id) lookup.set(a.id, num);
            if ((a as any).lab_analyte_id) lookup.set((a as any).lab_analyte_id, num);
            lookup.set(a.name.toLowerCase(), num);
            lookup.set(toVariableSlug(a.name), num);
            if ((a as any).code) lookup.set(String((a as any).code).toLowerCase(), num);
          }
        }
      }
      for (const r of next) {
        if (r.is_calculated) continue;
        const num = toNumber(r.value);
        if (num !== null) {
          if (r.analyte_id) lookup.set(r.analyte_id, num);
          if (r.lab_analyte_id) lookup.set(r.lab_analyte_id, num);
          lookup.set(r.parameter.toLowerCase(), num);
          // Slug-based key (e.g. "Total Cholesterol" → "tc") so formula
          // variables still resolve even when the dependency UUID points to
          // a different copy of an analyte with the same name.
          lookup.set(toVariableSlug(r.parameter), num);
        }
      }

      // 3. Recompute calculated rows
      return next.map(r => {
        if (!r.is_calculated || !r.formula) return r;
        const vars = parseFormulaVars(r.formula_variables);
        const calcVal = evalFormula(r.formula, vars, lookup, calcDeps, r.analyte_id, r.lab_analyte_id, r.calculation_result_type, r.decimal_places);
        if (!calcVal) return r;
        const resolved = normalizeCalculationResultType(r.calculation_result_type) === 'text'
          ? null
          : resolveFlag(calcVal, r.reference, undefined, undefined, undefined, undefined, undefined, undefined, r.value_type);
        return { ...r, value: formatIndianNumber(calcVal), flag: applyAutoFlag(r, resolved) };
      });
    });
  }, [calcDeps, testGroups]);

  // Recalculate all formula-based analytes using saved (existing_result) + pending row values.
  // Called manually via the "↻" button when auto-calc didn't fire (e.g. all deps already saved).
  const handleRecalculate = useCallback(() => {
    setRows(prev => {
      const lookup = new Map<string, number>();
      const patientAge = order.patient?.age ? Number(order.patient.age) : null;
      const patientGender = order.patient?.gender;
      if (patientAge !== null && Number.isFinite(patientAge)) lookup.set('age', patientAge);
      if (patientGender) {
        lookup.set('gender_male', patientGender === 'Male' ? 1 : 0);
        lookup.set('gender_female', patientGender === 'Female' ? 1 : 0);
        lookup.set('gender', patientGender === 'Male' ? 1 : 0);
      }
      // Seed from already-saved analyte values
      for (const tg of testGroups) {
        for (const a of tg.analytes) {
          if (a.is_calculated) continue;
          const num = toNumber(a.existing_result?.value);
          if (num !== null) {
            if (a.id) lookup.set(a.id, num);
            if ((a as any).lab_analyte_id) lookup.set((a as any).lab_analyte_id, num);
            lookup.set(a.name.toLowerCase(), num);
            lookup.set(toVariableSlug(a.name), num);
            if ((a as any).code) lookup.set(String((a as any).code).toLowerCase(), num);
          }
        }
      }
      // Seed from current pending row values
      for (const r of prev) {
        if (r.is_calculated) continue;
        const num = toNumber(r.value);
        if (num !== null) {
          if (r.analyte_id) lookup.set(r.analyte_id, num);
          if (r.lab_analyte_id) lookup.set(r.lab_analyte_id, num);
          lookup.set(r.parameter.toLowerCase(), num);
          lookup.set(toVariableSlug(r.parameter), num);
        }
      }
      return prev.map(r => {
        if (!r.is_calculated || !r.formula) return r;
        const vars = parseFormulaVars(r.formula_variables);
        const calcVal = evalFormula(r.formula, vars, lookup, calcDeps, r.analyte_id, r.lab_analyte_id, r.calculation_result_type, r.decimal_places);
        if (!calcVal) return r;
        const resolved = normalizeCalculationResultType(r.calculation_result_type) === 'text'
          ? null
          : resolveFlag(calcVal, r.reference, undefined, undefined, undefined, undefined, undefined, undefined, r.value_type);
        return { ...r, value: formatIndianNumber(calcVal), flag: applyAutoFlag(r, resolved) };
      });
    });
  }, [calcDeps, testGroups, order.patient]);

  const getCalculatedDebugInfo = useCallback((row: AnalyteRow) => {
    if (!row.is_calculated || !row.formula) return null;

    const lookup = new Map<string, number>();
    for (const tg of testGroups) {
      for (const a of tg.analytes) {
        if (a.is_calculated) continue;
        const num = toNumber(a.existing_result?.value);
        if (num !== null) {
          if (a.id) lookup.set(a.id, num);
          if ((a as any).lab_analyte_id) lookup.set((a as any).lab_analyte_id, num);
          if (a.name) {
            lookup.set(a.name.toLowerCase(), num);
            const slug = toVariableSlug(a.name);
            if (slug) lookup.set(slug, num);
          }
          if (a.code) lookup.set(String(a.code).toLowerCase(), num);
        }
      }
    }
    for (const currentRow of rows) {
      if (currentRow.is_calculated) continue;
      const num = toNumber(currentRow.value);
      if (num !== null) {
        if (currentRow.analyte_id) lookup.set(currentRow.analyte_id, num);
        if (currentRow.lab_analyte_id) lookup.set(currentRow.lab_analyte_id, num);
        lookup.set(currentRow.parameter.toLowerCase(), num);
        const slug = toVariableSlug(currentRow.parameter);
        if (slug) lookup.set(slug, num);
      }
    }

    const deps = selectPreferredCalculatedDependencies(
      calcDeps,
      row.analyte_id,
      row.lab_analyte_id,
      new Set(lookup.keys()),
    );
    const allAnalytes = testGroups.flatMap(tg => tg.analytes);

    if (deps.length > 0) {
      const dependencies = deps.map(dep => {
        const sourceAnalyte = allAnalytes.find((a: any) =>
          (dep.source_lab_analyte_id && (a as any).lab_analyte_id === dep.source_lab_analyte_id) ||
          a.id === dep.source_analyte_id
        );
        let value =
          (dep.source_lab_analyte_id ? lookup.get(dep.source_lab_analyte_id) : undefined) ??
          lookup.get(dep.source_analyte_id) ??
          lookup.get(dep.variable_name.toLowerCase());
        if (value === undefined && sourceAnalyte?.name) {
          value = lookup.get(sourceAnalyte.name.toLowerCase());
          if (value === undefined) {
            const slug = toVariableSlug(sourceAnalyte.name);
            if (slug) value = lookup.get(slug);
          }
        }
        return {
          variable: dep.variable_name,
          sourceName: sourceAnalyte?.name || dep.source_analyte_id?.slice(0, 8) || dep.variable_name,
          value,
        };
      });
      return {
        formula: row.formula,
        dependencies,
        missing: dependencies.filter(dep => dep.value === undefined).map(dep => dep.variable),
        hasDependencies: true,
      };
    }

    const vars = parseFormulaVars(row.formula_variables);
    const dependencies = vars.map(variable => ({
      variable,
      sourceName: variable,
      value: lookup.get(variable.toLowerCase()) ?? lookup.get(variable) ?? lookup.get(toVariableSlug(variable)),
    }));
    return {
      formula: row.formula,
      dependencies,
      missing: dependencies.filter(dep => dep.value === undefined).map(dep => dep.variable),
      hasDependencies: false,
    };
  }, [calcDeps, rows, testGroups]);

  // ── Keyboard navigation ─────────────────────────────────────────────────────

  // valueRefs is rebuilt on each render via the ref callback below
  const inputableIndexes = rows
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => !r.is_calculated && (!activeGroupId || r.test_group_id === activeGroupId))
    .map(({ i }) => i);

  // Saved analytes only render an input while their panel is expanded, so walk
  // past any index whose input is not currently mounted.
  const focusNext = (currentRowIdx: number) => {
    const pos = inputableIndexes.indexOf(currentRowIdx);
    if (pos === -1) return;
    for (let i = pos + 1; i < inputableIndexes.length; i++) {
      const el = valueRefs.current[inputableIndexes[i]];
      if (el) { el.focus(); return; }
    }
  };

  const focusPrev = (currentRowIdx: number) => {
    const pos = inputableIndexes.indexOf(currentRowIdx);
    if (pos <= 0) return;
    for (let i = pos - 1; i >= 0; i--) {
      const el = valueRefs.current[inputableIndexes[i]];
      if (el) { el.focus(); return; }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent, rowIdx: number) => {
    if (e.key === "Enter") {
      e.preventDefault();
      focusNext(rowIdx);
    }
    if (e.key === "Tab" && e.shiftKey) {
      e.preventDefault();
      focusPrev(rowIdx);
    }
  };

  // ── Approval ────────────────────────────────────────────────────────────────

  const toggleSavedGroup = (testGroupId: string) => {
    setExpandedSavedGroups(prev => {
      const next = new Set(prev);
      if (next.has(testGroupId)) next.delete(testGroupId); else next.add(testGroupId);
      return next;
    });
  };

  // Mirrors the approval write used by the Result Verification console so both
  // paths leave result_values in the same shape.
  const approveResultValues = async (resultValueIds: string[], busyKey: string) => {
    const ids = Array.from(new Set(resultValueIds.filter(Boolean)));
    if (!ids.length) {
      setMessage({ text: "Nothing to approve — submit the results first.", type: "error" });
      return;
    }
    setApprovingKey(busyKey);
    setMessage(null);
    try {
      const { data: { user: currentUser } } = await supabase.auth.getUser();
      const { error } = await supabase
        .from("result_values")
        .update({
          verify_status: "approved",
          verified: true,
          verified_by: safeUuid(currentUser?.id),
          verified_at: new Date().toISOString(),
        })
        .in("id", ids);
      if (error) throw error;

      setRows(prev => prev.map(r =>
        r.result_value_id && ids.includes(r.result_value_id)
          ? { ...r, verify_status: "approved" }
          : r
      ));
      setMessage({
        text: ids.length === 1 ? "Analyte approved." : `${ids.length} analytes approved.`,
        type: "success",
      });
      setTimeout(() => setMessage(null), 3000);
    } catch (err: any) {
      setMessage({ text: `Approve failed: ${err.message}`, type: "error" });
    } finally {
      setApprovingKey(null);
    }
  };

  // Sends an approved analyte back to pending and unlocks its result row so the
  // corrected value can actually be written on the next submit.
  const unapproveResultValue = async (row: AnalyteRow) => {
    if (!row.result_value_id) return;
    if (!window.confirm(`Reopen "${row.parameter}" for editing? It will go back to pending verification.`)) return;
    setApprovingKey(row.result_value_id);
    setMessage(null);
    try {
      const { error } = await supabase
        .from("result_values")
        .update({
          verify_status: "pending",
          verified: false,
          verified_by: null,
          verified_at: null,
          verify_note: "Reopened for editing during result entry",
        })
        .eq("id", row.result_value_id);
      if (error) throw error;

      // The bulk save RPC treats a panel as locked while its results row still
      // reads as verified/reviewed, and then only inserts missing analytes. Roll
      // the panel back too, otherwise the corrected value is silently dropped.
      const reopenPanel = {
        is_locked: false,
        locked_reason: null,
        locked_at: null,
        locked_by: null,
        status: "pending_verification",
        verification_status: "pending_verification",
        manually_verified: false,
        verified_at: null,
        verified_by: null,
      };
      const resultId = resultIds.get(row.test_group_id);
      if (resultId) {
        await supabase.from("results").update(reopenPanel).eq("id", resultId);
      } else {
        await supabase
          .from("results")
          .update(reopenPanel)
          .eq("order_id", order.id)
          .eq("test_group_id", row.test_group_id);
      }

      setRows(prev => prev.map(r =>
        r.result_value_id === row.result_value_id ? { ...r, verify_status: "pending" } : r
      ));
      setExpandedSavedGroups(prev => new Set(prev).add(row.test_group_id));
    } catch (err: any) {
      setMessage({ text: `Could not reopen: ${err.message}`, type: "error" });
    } finally {
      setApprovingKey(null);
    }
  };

  // ── Save Draft ──────────────────────────────────────────────────────────────

  const handleSaveDraft = async () => {
    const valid = rows.filter(r => !r.is_calculated && (r.value.trim() || r.is_hidden_from_report));
    if (!valid.length) { setMessage({ text: "Enter at least one value before saving.", type: "error" }); return; }

    setSaving(true);
    setMessage(null);
    try {
      await persistSampleConditions();
	      const resultValues = valid.map(r => ({
		        analyte_id: r.analyte_id || null,
		        lab_analyte_id: r.lab_analyte_id || null,
		        analyte_name: r.parameter,
		        parameter: r.parameter,
	        value: r.value.replace(/,/g, ''),
	        unit: r.unit,
	        reference_range: r.reference,
	        ...rangeAuditColumns(r, { edited: r.reference_edited }),
	        flag: r.flag,
	        value_type: r.value_type,
	        is_hidden_from_report: !!r.is_hidden_from_report,
	        hidden_reason: r.is_hidden_from_report ? (r.hidden_reason || "Hidden from report") : null,
	      }));
      const withFlags = calculateFlagsForResults(resultValues);

      const payload = {
        order_id: order.id,
        patient_name: order.patient_name,
        patient_id: safeUuid(order.patient_id),
        test_name: order.tests.join(", "),
        status: "Entered" as const,
        entered_by: user?.user_metadata?.full_name || user?.email || "Unknown",
        entered_date: new Date().toISOString().split("T")[0],
        values: withFlags,
	        lab_id: safeUuid(order.lab_id),
      };

      // Check for existing result row to update
      const { data: existing } = await supabase.from("results").select("id").eq("order_id", order.id).limit(1).maybeSingle();
      const resultSave = existing?.id
        ? await database.results.update(existing.id, payload)
        : await database.results.create(payload);
      if (resultSave?.error) throw resultSave.error;
      setMessage({ text: "Draft saved.", type: "success" });
      setTimeout(() => setMessage(null), 3000);
    } catch (err: any) {
      setMessage({ text: `Save failed: ${err.message}`, type: "error" });
    } finally {
      setSaving(false);
    }
  };

  // ── Sample condition ────────────────────────────────────────────────────────

  // Persists the condition on whichever order row carries this test group.
  // order_test_groups is the column sample collection writes and
  // generate-pdf-letterhead reads first; orders booked through the order form
  // only get order_tests rows, which mirror the same column.
  /**
   * Changing the sample condition changes which reference range applies, so the
   * grid has to follow — a fasting glucose range left on a post-prandial sample
   * is a wrong report, not a cosmetic mismatch.
   *
   * Two rows are deliberately left alone: one whose range the user typed over,
   * and one that is already saved (its range is what the patient was reported
   * against). Flags are recomputed only where the range actually moved.
   */
  const handleSampleConditionChange = (tgId: string, value: string) => {
    setSampleConditions(current => ({ ...current, [tgId]: value }));

    const ctx = contextForGroup(patientRangeInfo, value);
    setRows(prev => prev.map(row => {
      if (row.test_group_id !== tgId) return row;
      if (row.reference_edited || row.is_existing) return row;
      if (!row.range_fallback) return row;

      const resolved = resolveForAnalyte(rangeRules, row.range_fallback, ctx);
      if (resolved.range_text === row.reference) return row;

      // The range moved, so any verdict derived from the old one is stale.
      const recomputed = resolveFlag(
        row.value.replace(/,/g, ''),
        resolved.range_text,
        patientRangeInfo?.patient?.gender ?? undefined,
        resolved.low_critical ?? undefined,
        resolved.high_critical ?? undefined,
        undefined,
        undefined,
        undefined,
        row.value_type,
      );

      return {
        ...row,
        reference: resolved.range_text,
        range_rule_id: resolved.rule_id,
        range_source: resolved.source,
        applied_range_rule: resolved.applied_rule,
        rule_low_critical: resolved.source === 'rule' ? resolved.low_critical : null,
        rule_high_critical: resolved.source === 'rule' ? resolved.high_critical : null,
        flag: applyAutoFlag(row, recomputed),
      };
    }));
  };

  const persistSampleConditions = async () => {
    const changed = testGroups.filter((tg) =>
      (tg.order_test_group_id || tg.order_test_id) &&
      (tg.sample_condition_options?.length || 0) > 0 &&
      (sampleConditions[tg.test_group_id] || "") !== (initialSampleConditions[tg.test_group_id] || "")
    );
    if (!changed.length) return;

    const updates = changed.flatMap((tg) => {
      const value = (sampleConditions[tg.test_group_id] || "").trim() || null;
      const targets: Promise<any>[] = [];
      if (tg.order_test_group_id) {
        targets.push(supabase
          .from("order_test_groups")
          .update({ sample_condition: value })
          .eq("id", tg.order_test_group_id));
      }
      // Keep both rows in step when the order has them, so the report picks up
      // the same value whichever table it reads.
      if (tg.order_test_id) {
        targets.push(supabase
          .from("order_tests")
          .update({ sample_condition: value })
          .eq("id", tg.order_test_id));
      }
      return targets;
    });

    const responses = await Promise.all(updates);
    const failed = responses.find((r) => r?.error);
    if (failed?.error) throw failed.error;

    setInitialSampleConditions((current) => ({
      ...current,
      ...Object.fromEntries(changed.map((tg) => [tg.test_group_id, sampleConditions[tg.test_group_id] || ""])),
    }));
    setTestGroups((current) => current.map((tg) =>
      changed.some((c) => c.test_group_id === tg.test_group_id)
        ? { ...tg, sample_condition: (sampleConditions[tg.test_group_id] || "").trim() || null }
        : tg
    ));
  };

  // ── Submit ──────────────────────────────────────────────────────────────────

  // Runs the whole save pipeline and reports whether it succeeded. Kept separate
  // from handleSubmit so "Approve Whole Order" can persist first, then approve,
  // without closing the modal in between.
  const persistResults = async (): Promise<boolean> => {
    const valid = rows.filter(r => !r.is_calculated && (r.value.trim() || r.is_hidden_from_report));
    const hasSections = sectionEditorRefs.current.size > 0;
    const hasRemarks = Object.values(groupRemarks).some((remark) => remark.trim());
    const remarksChanged = testGroups.some((tg) =>
      (groupRemarks[tg.test_group_id] || "").trim() !==
      (initialGroupRemarks[tg.test_group_id] || "").trim()
    );
    const remarkTogglesChanged = testGroups.some((tg) =>
      (remarkEnabled[tg.test_group_id] !== false) !== (initialRemarkEnabled[tg.test_group_id] !== false)
    );
    const conditionsChanged = testGroups.some((tg) =>
      (sampleConditions[tg.test_group_id] || "") !== (initialSampleConditions[tg.test_group_id] || "")
    );
    if (!valid.length && !hasSections && !hasRemarks && !remarksChanged && !remarkTogglesChanged && !conditionsChanged) { setMessage({ text: "Enter at least one value or report remark before submitting.", type: "error" }); return false; }

    setSubmitting(true);
    setMessage({ text: "Saving results...", type: "success" });

    try {
	      const [{ data: { user: currentUser } }, userLabId] = await Promise.all([
	        supabase.auth.getUser(),
	        database.getCurrentUserLabId(),
	      ]);
	      const currentLabId = safeUuid(userLabId);
	      if (!currentLabId) throw new Error("No valid lab ID found for current user");

      const existingByKey = new Map<string, string>();
      const verifiedAt = new Date().toISOString();
      const bulkGroups: any[] = [];
      // Rows whose flag disagrees with their own value + reference range. These
      // are held back from auto-verification and reported to the operator.
      const flagConflicts: string[] = [];

      // Use pre-loaded analyte_dependencies (loaded at initial data fetch)
      const deps = calcDeps;

      // Report heading depends on this, so write it before the results land.
      await persistSampleConditions();

      // Work with a local mutable copy so AI ref range updates are visible to the save loop below
      let workingRows = [...rows];

      // AUTO-RESOLVE AI reference ranges for groups that have it enabled
      const groupsToResolve = testGroups.filter(tg => tg.ref_range_ai_config?.enabled === true);
      if (groupsToResolve.length > 0) {
        setMessage({ text: `Resolving AI reference ranges for ${groupsToResolve.length} group(s)...`, type: "success" });
        const { findResolvedReferenceRange, resolveReferenceRanges } = await import("../../utils/referenceRangeService");

        // Each group is an independent edge-function call, and the payloads
        // carry only values and units, so nothing a group resolves changes what
        // another group would send. Awaiting them one at a time just stacked
        // their latencies.
        const resolutions = await Promise.all(groupsToResolve.map(async tg => {
          const payload = tg.analytes.map(a => {
	            const row = workingRows.find(r =>
	              r.test_group_id === tg.test_group_id &&
	              ((a.lab_analyte_id && r.lab_analyte_id === a.lab_analyte_id) || (!a.lab_analyte_id && r.analyte_id === a.id))
	            );
            return {
              id: a.id,
              lab_analyte_id: a.lab_analyte_id || null,
              name: a.name,
              value: row?.value || "",
              unit: row?.unit || a.units || "",
            };
          });
          try {
            return await resolveReferenceRanges(order.id, tg.test_group_id, payload);
          } catch (aiErr) {
            console.warn(`AI ref range failed for group ${tg.test_group_name}:`, aiErr);
            return null;
          }
        }));

        // Applied in group order, so overlapping analytes settle exactly the
        // way the sequential version left them.
        for (const resolved of resolutions) {
          if (!resolved) continue;
          workingRows = workingRows.map(r => {
            const hit = findResolvedReferenceRange(resolved, r);
            if (!hit?.used_reference_range) return r;
            const newRef = hit.used_reference_range;
            // The range just changed, so the previous verdict is stale by
            // definition — recompute against the new one.
            const reflagged = resolveFlag(r.value.replace(/,/g, ''), newRef, order.patient?.gender ?? undefined, undefined, undefined, undefined, undefined, undefined, r.value_type);
            return { ...r, reference: newRef, flag: applyAutoFlag(r, reflagged) };
          });
        }
        // Sync resolved references back to UI state
        setRows(workingRows);
      }

      for (const tg of testGroups) {
        const groupRemark = groupRemarks[tg.test_group_id]?.trim() || "";
        const groupRemarkChanged =
          groupRemark !== (initialGroupRemarks[tg.test_group_id] || "").trim() ||
          (remarkEnabled[tg.test_group_id] !== false) !== (initialRemarkEnabled[tg.test_group_id] !== false);
        // Build value lookup map for formula evaluation
        const valueLookup = new Map<string, number>();
        for (const a of tg.analytes) {
	          const row = workingRows.find(r =>
	            r.test_group_id === tg.test_group_id &&
	            ((a.lab_analyte_id && r.lab_analyte_id === a.lab_analyte_id) || (!a.lab_analyte_id && r.analyte_id === a.id))
	          );
          const val = row?.value || a.existing_result?.value;
          const num = toNumber(val);
          if (num !== null) {
            if (a.id) valueLookup.set(a.id, num);
            if (a.name) valueLookup.set(a.name.toLowerCase(), num);
            if (a.code) valueLookup.set((a.code as string).toLowerCase(), num);
          }
        }

        // Determine rows to persist: manual entries + calculated
	        const manualForGroup = workingRows.filter(r =>
	          !r.is_calculated &&
	          (r.value.trim() || r.is_hidden_from_report) &&
		          r.test_group_id === tg.test_group_id
		        );

        const calcForGroup: AnalyteRow[] = tg.analytes
          .filter(a => !!a.is_calculated)
          .map(a => {
            const vars = parseFormulaVars(a.formula_variables);
	            const calcVal = a.formula ? evalFormula(a.formula, vars, valueLookup, deps, a.id, a.lab_analyte_id, a.calculation_result_type, a.decimal_places) : "";
	            const existingRow = workingRows.find(r =>
	              r.test_group_id === tg.test_group_id &&
	              ((a.lab_analyte_id && r.lab_analyte_id === a.lab_analyte_id) || (!a.lab_analyte_id && r.analyte_id === a.id))
	            );
		            return {
		              test_group_id: tg.test_group_id,
		              analyte_id: a.id,
	              lab_analyte_id: a.lab_analyte_id || null,
	              parameter: a.name,
	              value: existingRow?.value?.trim() ? existingRow.value : calcVal,
	              unit: existingRow?.unit || a.units || "",
	              reference: existingRow?.reference || a.reference_range || "",
	              flag: existingRow?.flag || "",
	              is_calculated: true,
	              is_hidden_from_report: !!existingRow?.is_hidden_from_report,
	              hidden_reason: existingRow?.hidden_reason || "",
	              expected_normal_values: [],
	              expected_value_flag_map: {},
	              verify_status: existingRow?.verify_status ?? null,
	            };
	          })
	          .filter(r => hasMeaningfulTextValue(r.value) || r.is_hidden_from_report);

	        // Merge: prefer manual, add calc, dedup
	        const toPersist = [...manualForGroup, ...calcForGroup].reduce<AnalyteRow[]>((acc, r) => {
	          const key = r.lab_analyte_id || r.analyte_id;
	          if (!acc.some(x => (x.lab_analyte_id || x.analyte_id) === key)) acc.push(r);
	          return acc;
	        }, []);

        if (toPersist.length === 0 && !groupRemark && !groupRemarkChanged) continue;

        // The bulk RPC preserves locked rows and inserts only missing analytes.
        const valueRows = toPersist.map(r => {
          const rawVal = r.value.replace(/,/g, '');
          const resolved = resolveFlag(
            rawVal,
            r.reference,
            order.patient?.gender ?? undefined,
            // Criticals only apply when a rule supplied them. Labs with no rules
            // configured keep the flagging behaviour they had before.
            r.rule_low_critical ?? undefined,
            r.rule_high_critical ?? undefined,
            undefined,
            undefined,
            undefined,
            r.value_type,
          );
          const finalFlag = applyAutoFlag(r, resolved);
          // flag_source records how this flag was actually decided. Labelling an
          // auto flag 'manual' would tell the downstream rule pass to leave a
          // wrong flag alone (see aiFlagAnalysis skip on manual).
          const flagSource = r.flag_origin === "manual" && finalFlag === r.flag
            ? "manual"
            : r.flag_origin === "rule" && finalFlag === r.flag
              ? "auto_rule"
              : resolved.numeric ? "auto_numeric" : "auto_rule";
          // Last line of defence: a flag that contradicts the value it is saved
          // with never auto-verifies, it goes to the verification desk instead.
          const conflict = detectFlagConflict(rawVal, r.reference, finalFlag, {
            valueType: r.value_type,
            patientGender: order.patient?.gender ?? undefined,
          });
          if (conflict.conflict) flagConflicts.push(`${r.parameter}: ${conflict.message}`);
          // A panel that is not yet locked is rewritten wholesale by the RPC, so
          // an analyte approved earlier in this modal has to carry its approval
          // into the payload or the resave would silently reset it to pending.
          const keepApproved = r.verify_status === "approved";
          const approve = keepApproved || r.is_hidden_from_report || (autoVerifyOnSubmit && !conflict.conflict);
          return {
          analyte_id: r.analyte_id || null,
          lab_analyte_id: r.lab_analyte_id || null,
          analyte_name: r.parameter,
          parameter: r.parameter,
          value: rawVal || null,
          unit: r.unit || "",
          reference_range: r.reference || "",
          ...rangeAuditColumns(r, { edited: r.reference_edited }),
	          flag: normalizeResultFlagForSave(finalFlag, rawVal),
	          flag_source: flagSource,
	          is_auto_calculated: r.is_calculated,
          verify_status: approve ? "approved" : "pending",
          verified: approve,
	          verified_by: approve ? safeUuid(currentUser?.id) : null,
          verified_at: approve ? verifiedAt : null,
          verify_note: r.is_hidden_from_report
            ? (r.hidden_reason || "Hidden from report")
            : conflict.conflict
              ? `Flag needs review — ${conflict.message}`
              : (autoVerifyOnSubmit ? "Auto-verified during result entry." : null),
          is_hidden_from_report: !!r.is_hidden_from_report,
          hidden_reason: r.is_hidden_from_report ? (r.hidden_reason || "Hidden from report") : null,
          };
        });

        bulkGroups.push({
          test_group_id: tg.test_group_id,
          order_test_group_id: safeUuid(tg.order_test_group_id),
          order_test_id: safeUuid(tg.order_test_id),
          test_name: tg.test_group_name,
          locked_mode: "insert_missing",
          extracted_by_ai: false,
          notes: groupRemark || null,
          values: valueRows,
        });
      }

      const { data: bulkSave, error: bulkSaveError } = await supabase.rpc("save_result_entry_bulk", {
        p_order_id: order.id,
        p_patient_id: safeUuid(order.patient_id),
        p_patient_name: order.patient_name,
        p_lab_id: currentLabId,
        p_entered_by: currentUser?.email || "Unknown",
        p_auto_verify: autoVerifyOnSubmit,
        p_groups: bulkGroups,
      });
      if (bulkSaveError) throw bulkSaveError;

      for (const saved of (bulkSave as any)?.result_ids || []) {
        const testGroup = testGroups.find(tg => tg.test_group_id === saved.test_group_id);
        if (!testGroup || !saved.result_id) continue;
        existingByKey.set(getGroupKey(testGroup), saved.result_id);
        if (saved.locked) continue;
        database.inventory.triggerAutoConsume({
          labId: currentLabId,
          orderId: order.id,
          resultId: saved.result_id,
          testGroupId: testGroup.test_group_id,
        }).catch(e => console.warn("Inventory auto-consume skipped:", e));
      }

      // The bulk RPC owns the remark text; the print toggle is written here so
      // the SQL function stays untouched. Two statements at most.
      const remarkOn: string[] = [];
      const remarkOff: string[] = [];
      for (const saved of (bulkSave as any)?.result_ids || []) {
        if (!saved.result_id) continue;
        (remarkEnabled[saved.test_group_id] !== false ? remarkOn : remarkOff).push(saved.result_id);
      }
      await Promise.all([
        ...(remarkOn.length ? [supabase.from("results").update({ report_remark_enabled: true }).in("id", remarkOn)] : []),
        ...(remarkOff.length ? [supabase.from("results").update({ report_remark_enabled: false }).in("id", remarkOff)] : []),
      ]);
      setInitialRemarkEnabled({ ...remarkEnabled });

      try {
        // This screen has already done the range work: rule ranges are applied
        // as the rows load and AI ranges are resolved just before the save
        // above. So the post-save pass only normalises flags, and the paid AI
        // call is made only for orders that actually use AI reference ranges.
        const usesAIRanges = testGroups.some(tg => tg.ref_range_ai_config?.enabled === true);
        setMessage({ text: "Finalizing flags and reference details...", type: "success" });
        const { runAIFlagAnalysis } = await import("../../utils/aiFlagAnalysis");
        await runAIFlagAnalysis(order.id, {
          applyToDatabase: true,
          createAudit: true,
          useAIService: usesAIRanges,
          skipRangeResolution: true,
        });
      } catch (e) {
        console.warn("AI flag analysis skipped:", e);
      }

      // Update result IDs so SectionEditors have the correct resultId
      const newResultIds = new Map(resultIds);
      for (const tg of testGroups) {
        const groupKey = getGroupKey(tg);
        const rId = existingByKey.get(groupKey);
        if (rId) newResultIds.set(tg.test_group_id, rId);
      }
      setResultIds(newResultIds);

      // Save all visible sections
      const sectionSaves = Array.from(sectionEditorRefs.current.values())
        .map(r => r.current?.save());
      await Promise.all(sectionSaves);

      if (flagConflicts.length) {
        setMessage({
          text: `Results saved. ${flagConflicts.length} flag${flagConflicts.length > 1 ? "s" : ""} left pending for verification — ${flagConflicts.join("; ")}`,
          type: "error",
        });
        return true;
      }
      setMessage({ text: autoVerifyOnSubmit ? "Results saved and auto-verified!" : "Results saved!", type: "success" });
      return true;
    } catch (err: any) {
      console.error("QuickResultEntry submit error:", err);
      setMessage({ text: `Submit failed: ${err.message}`, type: "error" });
      return false;
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = async () => {
    const saved = await persistResults();
    if (!saved) return;
    onSubmitted();
    onClose();
  };

  // Saves anything still pending, then approves every analyte on the order in
  // one pass. Section-only panels have no analytes, so they are verified on the
  // results row directly.
  const handleApproveWholeOrder = async () => {
    // Blanket approval bypasses the per-row auto-verify gate, so any flag that
    // contradicts its reference range is named in the confirmation instead.
    const conflicts = rows
      .filter(r => r.value.trim())
      .map(r => ({
        row: r,
        conflict: detectFlagConflict(r.value.replace(/,/g, ''), r.reference, r.flag, {
          valueType: r.value_type,
          patientGender: order.patient?.gender ?? undefined,
        }),
      }))
      .filter(x => x.conflict.conflict)
      .map(x => `• ${x.row.parameter}: ${x.conflict.message}`);
    const conflictWarning = conflicts.length
      ? `\n\nThese flags disagree with their reference range:\n${conflicts.join("\n")}\n`
      : "";
    if (!window.confirm(`Approve every result on this order for ${order.patient_name}? Saved values will be verified and the report becomes releasable.${conflictWarning}`)) return;

    const hasPendingEntry = rows.some(r => !r.is_calculated && isEditableRow(r) && (r.value.trim() || r.is_hidden_from_report));
    if (hasPendingEntry) {
      const saved = await persistResults();
      if (!saved) return;
    }

    setApprovingKey("order");
    setMessage({ text: "Approving order...", type: "success" });
    try {
      const { data: { user: currentUser } } = await supabase.auth.getUser();
      const verifiedBy = safeUuid(currentUser?.id);
      const verifiedAt = new Date().toISOString();

      const { data: orderResults, error: resultsError } = await supabase
        .from("results")
        .select("id")
        .eq("order_id", order.id);
      if (resultsError) throw resultsError;

      const resultIdList = (orderResults || []).map((r: any) => r.id).filter(Boolean);
      if (!resultIdList.length) {
        setMessage({ text: "Nothing to approve — no saved results on this order yet.", type: "error" });
        return;
      }

      const { error: valuesError } = await supabase
        .from("result_values")
        .update({
          verify_status: "approved",
          verified: true,
          verified_by: verifiedBy,
          verified_at: verifiedAt,
        })
        .in("result_id", resultIdList);
      if (valuesError) throw valuesError;

      // Covers section-only panels, which the result_values rollup never touches.
      const { error: rollupError } = await supabase
        .from("results")
        .update({
          verification_status: "verified",
          manually_verified: true,
          verified_at: verifiedAt,
          verified_by: verifiedBy,
        })
        .in("id", resultIdList);
      if (rollupError) throw rollupError;

      setMessage({ text: "Order approved.", type: "success" });
      onSubmitted();
      onClose();
    } catch (err: any) {
      console.error("QuickResultEntry approve-order error:", err);
      setMessage({ text: `Approve failed: ${err.message}`, type: "error" });
    } finally {
      setApprovingKey(null);
    }
  };

  // ── Render ──────────────────────────────────────────────────────────────────

	  const filledCount = rows.filter(r => !r.is_calculated && isEditableRow(r) && (r.value.trim() || r.is_hidden_from_report)).length;
	  const hiddenCount = rows.filter(r => !r.is_calculated && isEditableRow(r) && r.is_hidden_from_report).length;
  const totalInputable = rows.filter(r => !r.is_calculated && isEditableRow(r)).length;
  const existingCount = rows.filter(r => !r.is_calculated && r.is_existing && !r.is_rerun).length;

  // Group rows by test group for display. Analytes already saved are split into
  // their own list so they can be reviewed in a collapsed panel rather than
  // disappearing from the modal entirely.
  type GroupRow = { row: AnalyteRow; globalIdx: number };
  const rowsByGroup: { tg: TestGroup; rows: GroupRow[]; savedRows: GroupRow[] }[] = testGroups.map(tg => {
    const entries = tg.analytes.map(a => {
      // Scope by test group as well: the same analyte can be attached to more
      // than one group in an order and must not resolve to the other group's row.
      const globalIdx = rows.findIndex(r =>
        r.test_group_id === tg.test_group_id &&
        ((a.lab_analyte_id && r.lab_analyte_id === a.lab_analyte_id) || (!a.lab_analyte_id && r.analyte_id === a.id))
      );
      return { row: rows[globalIdx] || null, globalIdx };
    }).filter((x): x is GroupRow => x.row !== null);
    return {
      tg,
      rows: entries.filter(x => isEditableRow(x.row)),
      savedRows: entries.filter(x => !isEditableRow(x.row)),
    };
  }).filter(g => g.rows.length > 0 || g.savedRows.length > 0 || !!g.tg.is_section_only || resultIds.has(g.tg.test_group_id));

  const visibleRowsByGroup = activeGroupId
    ? rowsByGroup.filter(({ tg }) => tg.test_group_id === activeGroupId)
    : rowsByGroup;

  const focusFirstGroupInput = (testGroupId: string) => {
    const firstRowIdx = rows.findIndex((row) => row.test_group_id === testGroupId && !row.is_calculated && isEditableRow(row));
    if (firstRowIdx === -1) return;
    window.setTimeout(() => valueRefs.current[firstRowIdx]?.focus(), 0);
  };

  const selectGroup = (testGroupId: string | null) => {
    setActiveGroupId(testGroupId);
    if (testGroupId) focusFirstGroupInput(testGroupId);
  };

  // An attached report hangs off a result row. Outsourced groups never go
  // through the bulk save path, and an in-house group may not have been saved
  // yet, so the row has to be created on demand at upload time.
  const ensureResultIdForGroup = async (group: {
    test_group_id: string;
    test_group_name: string;
    order_test_id?: string | null;
    order_test_group_id?: string | null;
  }): Promise<string | null> => {
    const cached = resultIds.get(group.test_group_id);
    if (cached) return cached;

    const { data: existing } = await supabase
      .from("results")
      .select("id")
      .eq("order_id", order.id)
      .eq("test_group_id", group.test_group_id)
      .order("entered_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existing?.id) {
      setResultIds((prev) => new Map(prev).set(group.test_group_id, existing.id));
      return existing.id;
    }

    const [{ data: { user: currentUser } }, userLabId] = await Promise.all([
      supabase.auth.getUser(),
      database.getCurrentUserLabId(),
    ]);
    const currentLabId = safeUuid(userLabId);
    if (!currentLabId) throw new Error("No valid lab ID found for current user");

    const { data: stub, error } = await supabase
      .from("results")
      .upsert({
        order_id: order.id,
        patient_id: safeUuid(order.patient_id),
        patient_name: order.patient_name,
        test_name: group.test_group_name,
        status: "pending_verification",
        entered_by: currentUser?.email || "Unknown",
        entered_date: new Date().toISOString().split("T")[0],
        test_group_id: group.test_group_id,
        lab_id: currentLabId,
        ...uuidProp("order_test_group_id", group.order_test_group_id),
        ...uuidProp("order_test_id", group.order_test_id),
      }, { onConflict: "order_id,test_name", ignoreDuplicates: false })
      .select()
      .single();
    if (error) throw error;
    if (!stub?.id) return null;

    setResultIds((prev) => new Map(prev).set(group.test_group_id, stub.id));
    return stub.id;
  };

  const visibleOutsourcedGroups = activeGroupId
    ? outsourcedGroups.filter((og) => og.test_group_id === activeGroupId)
    : outsourcedGroups;

  // Re-index valueRefs array size
  valueRefs.current = valueRefs.current.slice(0, rows.length);

  // Autofocus belongs on the first row that is actually keyed in, not on the
  // first navigable row — saved analytes sit earlier in `rows` but render in a
  // collapsed panel.
  const firstEditableIdx = rows.findIndex(r =>
    !r.is_calculated && isEditableRow(r) && (!activeGroupId || r.test_group_id === activeGroupId)
  );

  const renderTableHead = (saved: boolean) => (
    <thead className="sticky top-0 bg-gray-50 border-b z-10">
      <tr>
        <th className={`px-4 py-2 text-left text-xs font-semibold text-gray-600 ${saved ? "w-[30%]" : "w-[34%]"}`}>Analyte</th>
        <th className={`px-4 py-2 text-left text-xs font-semibold text-gray-600 ${saved ? "w-[22%]" : "w-[26%]"}`}>Value</th>
        <th className="px-4 py-2 text-left text-xs font-semibold text-gray-600 w-[12%]">Unit</th>
        <th className={`px-4 py-2 text-left text-xs font-semibold text-gray-600 ${saved ? "w-[16%]" : "w-[18%]"}`}>Flag</th>
        <th className="px-4 py-2 text-left text-xs font-semibold text-gray-600 w-[8%]">Report</th>
        {saved && <th className="px-4 py-2 text-left text-xs font-semibold text-gray-600 w-[12%]">Approval</th>}
      </tr>
    </thead>
  );

  // Shared between the entry table and the saved-results panel. `saved` adds the
  // approval column; `readOnly` renders an approved analyte as plain text so it
  // cannot be edited until it is explicitly reopened.
  const renderAnalyteRow = (
    { row, globalIdx }: GroupRow,
    opts: { saved?: boolean; readOnly?: boolean } = {},
  ) => {
    const saved = !!opts.saved;
    const readOnly = !!opts.readOnly;
    const isCalc = row.is_calculated;
    const calcDebugInfo = isCalc ? getCalculatedDebugInfo(row) : null;
    const isQualitative = row.value_type === 'qualitative';
    const hasCodes = isQualitative && Object.keys(row.expected_value_codes || {}).length > 0;
    // If expected_normal_values exist, always show dropdown regardless of value_type
    const hasDropdown = row.expected_normal_values.length > 0;
    const hasDraftValue = row.value.trim() !== "";
    const isDefault = !!row.is_default;
    // The engine can decide a flag the lab never configured (typically 'A' on a
    // Positive qualitative result). Reports suppress that letter, but the entry
    // screen must still show what is actually stored — a <select> whose value is
    // missing from its options silently displays the wrong flag.
    const rowFlagOptions = row.flag && !flagOptions.some(f => f.value === row.flag)
      ? [...flagOptions, { value: row.flag, label: getFlagDescription(normalizeFlagCode(row.flag)) }]
      : flagOptions;
    const flagLabel = rowFlagOptions.find(f => f.value === row.flag);
    const flagColor = row.flag === "" ? "text-green-700" : row.flag?.includes("critical") ? "text-red-700 font-semibold" : row.flag === "H" || row.flag === "L" ? "text-orange-600 font-medium" : "text-gray-700";
    // Warn in place when the flag on screen disagrees with the value and range
    // on the same row — the operator can fix it before it ever reaches a report.
    const flagConflict = detectFlagConflict(row.value.replace(/,/g, ''), row.reference, row.flag, {
      valueType: row.value_type,
      patientGender: order.patient?.gender ?? undefined,
    });
    const isApproved = row.verify_status === "approved";
    const busy = approvingKey === row.result_value_id;
    // Row bg: default-prefilled = amber tint, manually entered = green tint, blank = plain
    const rowBg = row.is_hidden_from_report
      ? "bg-slate-50 text-slate-500"
      : readOnly ? "bg-emerald-50/40"
      : isDefault ? "bg-amber-50/50" : hasDraftValue ? "bg-green-50/40" : "hover:bg-blue-50/30";

    return (
      <tr key={`${row.test_group_id}:${row.lab_analyte_id || row.analyte_id}`} className={`border-b transition-colors ${rowBg}`}>

        {/* Analyte name + ref range hint */}
        <td className="px-4 py-2.5 overflow-hidden">
          <span className={`font-medium ${isCalc ? "text-blue-700" : "text-gray-800"}`}>{row.parameter}</span>
          {isCalc && <span className="ml-1.5 text-xs text-blue-400 italic">auto</span>}
          {isDefault && <span className="ml-1.5 text-xs text-amber-600 bg-amber-100 px-1 py-0.5 rounded">default</span>}
          {row.is_rerun && (
            <span className="ml-1.5 text-xs text-orange-700 bg-orange-100 px-1.5 py-0.5 rounded font-medium">RE-RUN</span>
          )}
          {row.is_hidden_from_report && (
            <span className="ml-1.5 text-xs text-slate-600 bg-slate-200 px-1.5 py-0.5 rounded font-medium">hidden</span>
          )}
          {row.reference && (
            <div className="text-xs text-gray-400 mt-0.5">{row.reference}</div>
          )}
          {isCalc && calcDebugInfo?.formula && (
            <div className="mt-1 text-[11px] bg-blue-50 border border-blue-100 rounded px-2 py-1 space-y-0.5 overflow-hidden">
              <div className="font-mono text-blue-700 break-all" title={calcDebugInfo.formula}>
                f: {calcDebugInfo.formula}
              </div>
              {calcDebugInfo.hasDependencies && calcDebugInfo.missing.length > 0 && (
                <button
                  type="button"
                  onClick={() => setEditingDependency({ row, missingVariables: calcDebugInfo.missing })}
                  className="text-red-700 hover:text-red-900 hover:underline flex items-center gap-1 cursor-pointer"
                >
                  <Link2 className="h-3 w-3" />
                  Missing: {calcDebugInfo.missing.join(", ")}
                </button>
              )}
              {!calcDebugInfo.hasDependencies && calcDebugInfo.missing.length > 0 && (
                <button
                  type="button"
                  onClick={() => setEditingDependency({ row, missingVariables: calcDebugInfo.missing })}
                  className="text-amber-700 hover:text-amber-900 hover:underline flex items-center gap-1 cursor-pointer"
                >
                  <Link2 className="h-3 w-3" />
                  No dependencies saved — open Dependency Manager
                </button>
              )}
            </div>
          )}
          {row.verify_note && (
            <div className="text-xs text-orange-600 mt-1">{row.verify_note}</div>
          )}
        </td>

        {/* Value input */}
        <td className="px-4 py-2">
          {readOnly ? (
            <div className="px-2 py-1.5 bg-emerald-50 border border-emerald-200 rounded text-emerald-900 text-sm font-medium min-h-[34px] flex items-center">
              {row.value || <span className="text-emerald-300 italic">no value</span>}
            </div>
          ) : isCalc ? (
            <div className="flex items-center gap-1.5">
              <div className="flex-1 px-2 py-1.5 bg-blue-50 border border-blue-200 rounded text-blue-800 text-sm font-medium min-h-[34px] flex items-center">
                {row.value || <span className="text-blue-300 italic">calculated</span>}
              </div>
              <button
                type="button"
                title="Recalculate from saved values"
                onClick={handleRecalculate}
                className="p-1.5 text-blue-500 hover:text-blue-700 hover:bg-blue-100 rounded transition-colors"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : hasDropdown ? (
            <select
              ref={el => { valueRefs.current[globalIdx] = el; }}
              value={row.value}
              onChange={e => {
                const val = e.target.value;
                const autoFlag = row.expected_value_flag_map[val] ?? "";
                setRows(prev => prev.map((r, i) => i !== globalIdx ? r : { ...r, value: val, flag: autoFlag, flag_origin: "rule", is_default: false }));
              }}
              onKeyDown={e => {
                // Quick code resolution: e.g. pressing "1" selects "Non-Reactive"
                if (hasCodes && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
                  const code = e.key.toUpperCase();
                  const resolved = (row.expected_value_codes || {})[code];
                  if (resolved) {
                    e.preventDefault();
                    const autoFlag = row.expected_value_flag_map[resolved] ?? "";
                    setRows(prev => prev.map((r, i) => i !== globalIdx ? r : { ...r, value: resolved, flag: autoFlag, flag_origin: "rule", is_default: false }));
                    focusNext(globalIdx);
                    return;
                  }
                }
                handleKeyDown(e, globalIdx);
              }}
              className={`w-full px-2 py-1.5 border rounded text-sm focus:outline-none focus:ring-2 ${
                isDefault
                  ? "border-amber-300 bg-amber-50 text-amber-800 italic focus:ring-amber-400"
                  : row.value ? "border-green-300 bg-green-50 focus:ring-green-400" : "border-gray-300 focus:ring-green-400"
              }`}
            >
              <option value="">Select...</option>
              {row.expected_normal_values.map(opt => (
                <option key={opt} value={opt}>{opt}</option>
              ))}
              {/* Show quick code hints if available */}
              {hasCodes && <option disabled>── Quick codes ──</option>}
              {hasCodes && Object.entries(row.expected_value_codes || {}).map(([code, val]) => (
                <option key={`hint-${code}`} disabled>{code} → {val}</option>
              ))}
            </select>
          ) : isQualitative ? (
            // Qualitative without dropdown values: free-text with quick-code resolution.
            // Amber border/bg when pre-filled by default; purple when manually entered.
            <div className="relative">
              <input
                ref={el => { valueRefs.current[globalIdx] = el; }}
                type="text"
                list={hasCodes ? `qcodes-${globalIdx}` : undefined}
                value={row.value}
                placeholder={hasCodes ? "type code or value..." : "value..."}
                onChange={e => {
                  const typed = e.target.value;
                  if (hasCodes && typed.trim()) {
                    const key = typed.trim().toUpperCase();
                    const resolved = row.expected_value_codes![key];
                    if (resolved) {
                      setRows(prev => prev.map((r, i) => i !== globalIdx ? r : { ...r, value: resolved, is_default: false }));
                      return;
                    }
                  }
                  setRows(prev => prev.map((r, i) => i !== globalIdx ? r : { ...r, value: typed, is_default: false }));
                }}
                onKeyDown={e => handleKeyDown(e, globalIdx)}
                className={`w-full px-2 py-1.5 border rounded text-sm focus:outline-none focus:ring-2 ${
                  isDefault
                    ? "border-amber-300 bg-amber-50 text-amber-800 italic focus:ring-amber-400"
                    : row.value
                      ? "border-purple-300 bg-purple-50 font-medium focus:ring-purple-400"
                      : "border-gray-300 focus:ring-purple-400"
                }`}
                autoFocus={!saved && globalIdx === firstEditableIdx}
              />
              {hasCodes && (
                <datalist id={`qcodes-${globalIdx}`}>
                  {Object.entries(row.expected_value_codes!).map(([code, val]) => (
                    <option key={code} value={val}>{code} → {val}</option>
                  ))}
                </datalist>
              )}
            </div>
          ) : (
            <input
              ref={el => { valueRefs.current[globalIdx] = el; }}
              type="text"
              value={row.value}
              placeholder={row.reference ? `e.g. ${row.reference.split("-")[0]?.trim()}` : "value..."}
              onChange={e => {
                const raw = e.target.value.replace(/,/g, '');
                setRows(prev => prev.map((r, i) => i !== globalIdx ? r : {
                  ...r,
                  value: raw,
                  is_default: false,
                  interface_conversion_pending: true,
                }));
              }}
              onBlur={e => handleValueBlur(globalIdx, e.target.value)}
              onKeyDown={e => handleKeyDown(e, globalIdx)}
              className={`w-full px-2 py-1.5 border rounded text-sm focus:outline-none focus:ring-2 ${
                isDefault
                  ? "border-amber-300 bg-amber-50 text-amber-800 italic focus:ring-amber-400"
                  : row.value ? "border-green-400 bg-green-50 font-medium focus:ring-green-400" : "border-gray-300 focus:ring-green-400"
              }`}
              autoFocus={!saved && globalIdx === firstEditableIdx}
            />
          )}
        </td>

        {/* Unit (read-only) */}
        <td className="px-4 py-2 text-gray-500 text-sm">{row.unit || "—"}</td>

        {/* Flag select */}
        <td className="px-4 py-2">
          {isCalc || readOnly ? (
            <span className={`text-sm ${flagColor}`}>{flagLabel?.label || "—"}</span>
          ) : (
            <select
              value={row.flag}
              onChange={e => {
                // An explicit pick is the one flag the recalculation respects.
                const picked = e.target.value;
                setRows(prev => prev.map((r, i) => i !== globalIdx ? r : { ...r, flag: picked, flag_origin: "manual" }));
              }}
              className={`w-full px-1.5 py-1.5 border border-gray-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-green-400 ${flagColor}`}
            >
              {rowFlagOptions.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          )}
          {flagConflict.conflict && (
            <div
              className="mt-1 flex items-start gap-1 text-[11px] leading-tight text-amber-700"
              title={flagConflict.message}
            >
              <AlertTriangle className="h-3 w-3 mt-px shrink-0" />
              <span>{flagConflict.expected ? `Range says ${flagConflict.expected}` : "Range says normal"} — will not auto-verify</span>
            </div>
          )}
        </td>
        <td className="px-4 py-2">
          <button
            type="button"
            onClick={() => toggleHiddenFromReport(globalIdx)}
            disabled={readOnly}
            className={`inline-flex items-center justify-center rounded border px-2 py-1 text-xs transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
              row.is_hidden_from_report
                ? "border-slate-400 bg-slate-100 text-slate-700"
                : "border-gray-200 bg-white text-gray-500 hover:bg-gray-50"
            }`}
            title={readOnly ? "Reopen the analyte to change this" : row.is_hidden_from_report ? "Show this analyte on report" : "Hide this analyte from report"}
          >
            <EyeOff className="h-3.5 w-3.5" />
          </button>
        </td>

        {saved && (
          <td className="px-4 py-2">
            {isApproved ? (
              <button
                type="button"
                onClick={() => unapproveResultValue(row)}
                disabled={busy || !row.result_value_id}
                className="inline-flex items-center gap-1 rounded border border-emerald-300 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700 transition-colors hover:bg-emerald-100 disabled:opacity-50"
                title="Reopen this analyte for editing"
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Undo2 className="h-3.5 w-3.5" />}
                Approved
              </button>
            ) : (
              <button
                type="button"
                onClick={() => approveResultValues([row.result_value_id!], row.result_value_id!)}
                disabled={busy || !row.result_value_id}
                className="inline-flex items-center gap-1 rounded bg-emerald-600 px-2 py-1 text-xs font-medium text-white transition-colors hover:bg-emerald-700 disabled:opacity-50"
                title={row.result_value_id ? "Approve this analyte" : "Submit the results before approving"}
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                Approve
              </button>
            )}
          </td>
        )}
      </tr>
    );
  };

  const modal = (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black">
      <div className="bg-white rounded-xl shadow-2xl w-[95vw] max-w-6xl max-h-[98vh] flex flex-col overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b bg-gradient-to-r from-green-600 to-emerald-600 text-white rounded-t-xl">
          <div>
            <h2 className="text-lg font-bold">{order.patient_name}</h2>
            <p className="text-sm text-green-100">
              {order.patient?.age && `${order.patient.age} · `}
              {order.patient?.gender && `${order.patient.gender} · `}
              {order.tests.join(", ")}
            </p>
          </div>
          <div className="flex items-center gap-3">
            {/* Progress pill */}
	            <span className="text-sm bg-white/20 px-3 py-1 rounded-full font-medium">
	              {filledCount}/{totalInputable} handled
	            </span>
	            {hiddenCount > 0 && (
	              <span className="text-xs bg-white/10 px-2 py-1 rounded-full text-green-100">
	                {hiddenCount} hidden
	              </span>
	            )}
            {existingCount > 0 && (
              <span className="text-xs bg-white/10 px-2 py-1 rounded-full text-green-200">
                {existingCount} saved
              </span>
            )}
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-white/20 transition-colors">
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Keyboard hint */}
        <div className="px-5 py-2 text-xs text-gray-500 bg-gray-50 border-b flex gap-4 flex-wrap">
          <span><kbd className="bg-gray-200 px-1.5 py-0.5 rounded text-gray-700 font-mono text-xs">Enter</kbd> next analyte</span>
          <span><kbd className="bg-gray-200 px-1.5 py-0.5 rounded text-gray-700 font-mono text-xs">Tab</kbd> next field</span>
          <span><kbd className="bg-gray-200 px-1.5 py-0.5 rounded text-gray-700 font-mono text-xs">Shift+Tab</kbd> previous analyte</span>
          <span><kbd className="bg-gray-200 px-1.5 py-0.5 rounded text-gray-700 font-mono text-xs">Ctrl+Enter</kbd> submit</span>
          {resultIds.size > 0 && <span><kbd className="bg-gray-200 px-1.5 py-0.5 rounded text-gray-700 font-mono text-xs">A B C…</kbd> select section options</span>}
        </div>

        {rowsByGroup.length + outsourcedGroups.length > 1 && (
          <div className="border-b bg-white px-5 py-2">
            <div className="flex gap-2 overflow-x-auto pb-1">
              <button
                type="button"
                onClick={() => selectGroup(null)}
                className={`shrink-0 rounded-md border px-3 py-1.5 text-xs font-semibold transition-colors ${
                  activeGroupId === null
                    ? "border-green-600 bg-green-50 text-green-700"
                    : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
                }`}
              >
                All Groups
              </button>
              {rowsByGroup.map(({ tg, rows: groupRows, savedRows }) => {
                const groupFilled = groupRows.filter(({ row }) => !row.is_calculated && (row.value.trim() || row.is_hidden_from_report)).length;
                const groupInputable = groupRows.filter(({ row }) => !row.is_calculated).length;
                const groupSaved = savedRows.length;
                const isActive = activeGroupId === tg.test_group_id;
                return (
                  <button
                    key={tg.test_group_id}
                    type="button"
                    onClick={() => selectGroup(tg.test_group_id)}
                    className={`shrink-0 rounded-md border px-3 py-1.5 text-left text-xs transition-colors ${
                      isActive
                        ? "border-green-600 bg-green-600 text-white shadow-sm"
                        : "border-gray-200 bg-white text-gray-700 hover:border-green-300 hover:bg-green-50"
                    }`}
                    title={`Open ${tg.test_group_name}`}
                  >
                    <span className="block max-w-48 truncate font-semibold">{tg.test_group_name}</span>
                    <span className={isActive ? "text-green-100" : "text-gray-500"}>
                      {groupInputable > 0 ? `${groupFilled}/${groupInputable} handled` : "all saved"}
                      {groupSaved > 0 && groupInputable > 0 ? ` · ${groupSaved} saved` : ""}
                    </span>
                  </button>
                );
              })}
              {outsourcedGroups.map((og) => {
                const isActive = activeGroupId === og.test_group_id;
                return (
                  <button
                    key={`outsourced:${og.test_group_id}`}
                    type="button"
                    onClick={() => selectGroup(og.test_group_id)}
                    className={`shrink-0 rounded-md border px-3 py-1.5 text-left text-xs transition-colors ${
                      isActive
                        ? "border-purple-600 bg-purple-600 text-white shadow-sm"
                        : "border-purple-200 bg-white text-purple-700 hover:border-purple-300 hover:bg-purple-50"
                    }`}
                    title={`${og.test_group_name} — outsourced${og.outsourced_lab_name ? ` to ${og.outsourced_lab_name}` : ""}. Attach the external lab report.`}
                  >
                    <span className="block max-w-48 truncate font-semibold">🏥 {og.test_group_name}</span>
                    <span className={isActive ? "text-purple-100" : "text-purple-500"}>attach report</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-y-auto" onKeyDown={e => { if (e.ctrlKey && e.key === "Enter") handleSubmit(); }}>
          {loading ? (
            <div className="flex items-center justify-center py-16 gap-3 text-gray-500">
              <Loader2 className="h-6 w-6 animate-spin" />
              <span>Loading analytes...</span>
            </div>
          ) : rowsByGroup.length === 0 && outsourcedGroups.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-gray-500">
              <CheckCircle className="h-10 w-10 text-green-500" />
              <p className="text-base font-medium text-green-700">All results already saved</p>
              <p className="text-sm text-gray-400">{existingCount} analyte{existingCount !== 1 ? "s" : ""} submitted previously</p>
            </div>
          ) : (
            <>
            {visibleRowsByGroup.map(({ tg, rows: groupRows, savedRows }) => {
              const savedApproved = savedRows.filter(({ row }) => row.verify_status === "approved").length;
              const savedPending = savedRows.length - savedApproved;
              const savedExpanded = expandedSavedGroups.has(tg.test_group_id);
              const pendingIds = savedRows
                .filter(({ row }) => row.verify_status !== "approved" && row.result_value_id)
                .map(({ row }) => row.result_value_id!);
              const groupBusy = approvingKey === `group:${tg.test_group_id}`;

              return (
              <div key={tg.test_group_id}>
                {/* Test group header (only shown if >1 group) */}
                {testGroups.length > 1 && (
                  <div className="px-5 py-2 bg-gray-100 border-b text-sm font-semibold text-gray-700 flex items-center gap-2">
                    <ChevronDown className="h-4 w-4 text-gray-400" />
                    {tg.test_group_name}
                  </div>
                )}

                {/* Sample condition — the choice made at collection, editable here
                    and printed above the group's results when the test group's
                    print options enable "Show Sample Condition". */}
                {(tg.sample_condition_options?.length || 0) > 0 && (
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-blue-100 bg-blue-50/60 px-5 py-2">
                    <label className="text-xs font-semibold uppercase tracking-wide text-blue-800">
                      Sample Condition
                    </label>
                    <select
                      value={sampleConditions[tg.test_group_id] || ""}
                      onChange={(event) => handleSampleConditionChange(tg.test_group_id, event.target.value)}
                      disabled={!tg.order_test_group_id && !tg.order_test_id}
                      className="min-w-[200px] rounded border border-blue-200 bg-white px-2 py-1 text-sm text-gray-800 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 disabled:bg-gray-100 disabled:text-gray-500"
                    >
                      <option value="">Not specified</option>
                      {(tg.sample_condition_options || []).map((option) => (
                        <option key={option} value={option}>{option}</option>
                      ))}
                    </select>
                    <span className="text-xs text-blue-700">
                      {tg.order_test_group_id || tg.order_test_id
                        ? "Saved with the results and printed above this test group."
                        : "Read-only — this test is not linked to a row on the order."}
                    </span>
                  </div>
                )}

                {groupRows.length > 0 && (
                  <table className="w-full text-sm table-fixed">
                    {renderTableHead(false)}
                    <tbody>
                      {groupRows.map(entry => renderAnalyteRow(entry))}
                    </tbody>
                  </table>
                )}

                {/* Already-saved analytes — collapsed until the user opens them */}
                {savedRows.length > 0 && (
                  <div className="border-t border-emerald-100 bg-emerald-50/30">
                    <button
                      type="button"
                      onClick={() => toggleSavedGroup(tg.test_group_id)}
                      className="flex w-full items-center gap-2 px-4 py-2.5 text-left transition-colors hover:bg-emerald-50"
                    >
                      {savedExpanded
                        ? <ChevronDown className="h-4 w-4 shrink-0 text-emerald-600" />
                        : <ChevronRight className="h-4 w-4 shrink-0 text-emerald-600" />}
                      <span className="text-sm font-semibold text-emerald-800">
                        {savedRows.length} saved result{savedRows.length !== 1 ? "s" : ""}
                      </span>
                      {savedApproved > 0 && (
                        <span className="rounded-full bg-emerald-600 px-2 py-0.5 text-xs font-medium text-white">
                          {savedApproved} approved
                        </span>
                      )}
                      {savedPending > 0 && (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                          {savedPending} awaiting approval
                        </span>
                      )}
                      <span className="ml-auto text-xs font-medium text-emerald-700">
                        {savedExpanded ? "Close" : "Open & edit"}
                      </span>
                    </button>

                    {savedExpanded && (
                      <div className="border-t border-emerald-100">
                        {savedPending > 0 && (
                          <div className="flex items-center justify-between gap-3 px-4 py-2">
                            <p className="text-xs text-emerald-800">
                              Approved analytes are read-only. Use the tick to reopen one before correcting it.
                            </p>
                            <button
                              type="button"
                              onClick={() => approveResultValues(pendingIds, `group:${tg.test_group_id}`)}
                              disabled={groupBusy || pendingIds.length === 0}
                              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-700 disabled:opacity-50"
                            >
                              {groupBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                              Approve all in {tg.test_group_name}
                            </button>
                          </div>
                        )}
                        <table className="w-full text-sm table-fixed">
                          {renderTableHead(true)}
                          <tbody>
                            {savedRows.map(entry => renderAnalyteRow(entry, {
                              saved: true,
                              readOnly: entry.row.verify_status === "approved",
                            }))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}

                <div className="border-t border-amber-100 bg-amber-50/40 px-4 py-3">
                  <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="text-xs font-semibold uppercase tracking-wide text-amber-800">
                      Report Remarks
                    </span>
                    <label className="flex cursor-pointer items-center gap-1.5 text-xs text-amber-800">
                      <input
                        type="checkbox"
                        checked={remarkEnabled[tg.test_group_id] !== false}
                        onChange={(event) => setRemarkEnabled((current) => ({
                          ...current,
                          [tg.test_group_id]: event.target.checked,
                        }))}
                        className="h-3.5 w-3.5 cursor-pointer accent-amber-600"
                      />
                      Print on report
                    </label>
                  </div>
                  <textarea
                    value={groupRemarks[tg.test_group_id] || ""}
                    onChange={(event) => setGroupRemarks((current) => ({
                      ...current,
                      [tg.test_group_id]: event.target.value,
                    }))}
                    rows={2}
                    maxLength={2000}
                    placeholder="Optional remark printed below this test group in the final report"
                    className={`w-full resize-y rounded-lg border border-amber-200 bg-white px-3 py-2 text-sm outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-100 ${
                      remarkEnabled[tg.test_group_id] === false ? "text-gray-400 line-through" : "text-gray-800"
                    }`}
                  />
                  <p className="mt-1 text-xs text-amber-700">
                    {remarkEnabled[tg.test_group_id] === false
                      ? "Kept for reference only — this remark will not appear on the report."
                      : "This is report-visible and is separate from analyte and verification notes."}
                  </p>
                </div>

                {/* In-house test that was sent out on the day — collapsed until needed */}
                <div className="border-t px-4 py-2">
                  <OutsourcedReportUpload
                    orderId={order.id}
                    testGroupId={tg.test_group_id}
                    labId={order.lab_id}
                    patientId={order.patient_id}
                    ensureResultId={() => ensureResultIdForGroup(tg)}
                    collapsible
                  />
                </div>

                {/* Report Sections (technician-editable) */}
                {resultIds.get(tg.test_group_id) && (
                  <div className="border-t border-blue-100 bg-blue-50/30 px-4 py-3">
                    <SectionEditor
                      ref={getSectionEditorRef(tg.test_group_id)}
                      resultId={resultIds.get(tg.test_group_id)!}
                      testGroupId={tg.test_group_id}
                      editorRole="technician"
                      showAIAssistant={false}
                    />
                  </div>
                )}
              </div>
              );
            })}

            {/* Outsourced tests: no analytes to key in — attach the external lab's report */}
            {visibleOutsourcedGroups.map((og) => (
              <div key={`outsourced:${og.test_group_id}`}>
                <div className="px-5 py-2 bg-purple-50 border-b text-sm font-semibold text-purple-800 flex items-center gap-2">
                  <Building2 className="h-4 w-4 text-purple-400" />
                  {og.test_group_name}
                  <span className="text-xs font-normal text-purple-600">no analytes to key in — attach the external report below</span>
                </div>
                <div className="px-4 py-3">
                  <OutsourcedReportUpload
                    orderId={order.id}
                    testGroupId={og.test_group_id}
                    labId={order.lab_id}
                    patientId={order.patient_id}
                    ensureResultId={() => ensureResultIdForGroup(og)}
                  />
                </div>
              </div>
            ))}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t bg-gray-50 flex items-center justify-between gap-3">
          <div className="flex-1">
            {message && (
              <span className={`text-sm font-medium ${message.type === "success" ? "text-green-600" : "text-red-600"}`}>
                {message.type === "success" ? <CheckCircle className="inline h-4 w-4 mr-1" /> : null}
                {message.text}
              </span>
            )}
            {showAutoVerifyOption && (
              <label className="mt-2 flex max-w-xl items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 rounded border-emerald-300"
                  checked={autoVerifyOnSubmit}
                  onChange={(e) => setAutoVerifyOnSubmit(e.target.checked)}
                  disabled={saving || submitting || loading}
                />
                <span>
                  Auto-verify after submit
                  <span className="ml-1 text-emerald-700">
                    Saved result values will be approved immediately and the order status will refresh.
                  </span>
                </span>
              </label>
            )}
          </div>
          <div className="flex gap-2">
            {showApproveAllButton && (
              <button
                onClick={handleApproveWholeOrder}
                disabled={saving || submitting || loading || approvingKey !== null}
                className="flex items-center gap-1.5 px-4 py-2 text-sm bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50 transition-colors font-medium"
                title="Save anything pending, then approve every analyte on this order"
              >
                {approvingKey === "order" ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                Approve Whole Order
              </button>
            )}
            <button
              onClick={handleSaveDraft}
              disabled={saving || submitting || loading}
              className="flex items-center gap-1.5 px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-100 text-gray-700 disabled:opacity-50 transition-colors"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save Draft
            </button>
            <button
              onClick={handleSubmit}
              disabled={saving || submitting || loading}
              className="flex items-center gap-1.5 px-5 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 transition-colors font-medium"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle className="h-4 w-4" />}
              Submit Results
            </button>
          </div>
        </div>
      </div>

      {/* Inline Dependency Editor */}
      {editingDependency && (
        <InlineDependencyEditor
          analyte={{
            id: editingDependency.row.analyte_id,
            lab_analyte_id: editingDependency.row.lab_analyte_id,
            name: editingDependency.row.parameter,
            formula: editingDependency.row.formula || '',
            formulaVariables: parseFormulaVars(editingDependency.row.formula_variables),
          }}
          missingVariables={editingDependency.missingVariables}
          availableAnalytes={testGroups.flatMap(tg =>
            tg.analytes
              .filter(a => !a.is_calculated && a.id !== editingDependency.row.analyte_id)
              .map(a => ({
                id: a.id,
                lab_analyte_id: a.lab_analyte_id,
                name: a.name,
                unit: a.units,
                code: a.code,
              }))
          )}
          onClose={() => setEditingDependency(null)}
          onSaved={() => {
            setEditingDependency(null);
            // Reload dependencies and recalculate
            loadData();
          }}
        />
      )}
    </div>
  );

  return ReactDOM.createPortal(modal, document.body);
};

export default QuickResultEntryModal;
