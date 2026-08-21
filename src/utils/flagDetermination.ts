/**
 * Flag Determination Service
 *
 * Comprehensive system for determining result flags (normal, high, low, critical)
 * Handles numeric, qualitative, and semi-quantitative values
 * Supports gender/age-specific reference ranges
 * Provides confidence scoring and audit trail
 */

// ============================================
// TYPES
// ============================================

export type FlagValue =
  | "normal"
  | "high"
  | "low"
  | "critical_high"
  | "critical_low"
  | "abnormal"
  | null;
export type FlagSource =
  | "auto_numeric"
  | "auto_text"
  | "auto_rule"
  | "ai"
  | "manual"
  | "inherited";
export type ValueType =
  | "numeric"
  | "qualitative"
  | "semi_quantitative"
  | "descriptive";

export interface FlagResult {
  flag: FlagValue;
  source: FlagSource;
  confidence: number; // 0-1
  needsReview: boolean;
  auditNotes?: string;
  interpretation?: string;
}

export interface AnalyteConfig {
  id?: string;
  name?: string;
  reference_range?: string;
  reference_range_male?: string;
  reference_range_female?: string;
  low_critical?: string | number | null;
  high_critical?: string | number | null;
  value_type?: ValueType;
  expected_normal_values?: string[];
  flag_rules?: any;
}

export interface PatientContext {
  age?: number;
  gender?: "Male" | "Female" | "Other" | string;
  conditions?: string[]; // ['pregnant', 'diabetic']
}

export interface ParsedRange {
  low: number | null;
  high: number | null;
  type: "range" | "less_than" | "greater_than" | "single" | "none";
}

// ============================================
// KNOWN VALUE PATTERNS
// ============================================

const NORMAL_TEXT_PATTERNS = [
  /^negative$/i,
  /^non[\s-]?reactive$/i,
  /^normal$/i,
  /^nil$/i,
  /^absent$/i,
  /^not[\s-]?detected$/i,
  /^nd$/i,
  /^none[\s-]?seen$/i,
  /^within[\s-]?normal[\s-]?limits$/i,
  /^wnl$/i,
  /^unremarkable$/i,
  /^clear$/i,
  /^no[\s-]?growth$/i,
  /^sterile$/i,
  /^no[\s-]?abnormality$/i,
  /^satisfactory$/i,
  /^adequate$/i,
];

const ABNORMAL_TEXT_PATTERNS = [
  /^positive$/i,
  /^reactive$/i,
  /^detected$/i,
  /^present$/i,
  /^abnormal$/i,
  /^growth$/i,
  /^unsatisfactory$/i,
  /^inadequate$/i,
];

const SEMI_QUANT_NORMAL = ["nil", "negative", "trace", "±", "+-", "neg"];
const SEMI_QUANT_ABNORMAL_ORDER = [
  "1+",
  "+",
  "2+",
  "++",
  "3+",
  "+++",
  "4+",
  "++++",
];

// ============================================
// CORE PARSING FUNCTIONS
// ============================================

/**
 * Parse a reference range string into numeric bounds
 * Handles various formats:
 * - "70-110" or "70 - 110"
 * - "< 100" or "<100"
 * - "> 40" or ">40"
 * - "70-110 mg/dL"
 * - "< 100 (Optimal)"
 */
/**
 * Local copy of the gender normalizer in referenceRangeResolver.
 *
 * Kept local rather than imported because the resolver imports
 * parseReferenceRange from this file, and a cycle between the two is not worth
 * five lines of reuse.
 */
function normalizeGenderValue(value: unknown): "male" | "female" | "other" | null {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return null;
  if (raw === "m" || raw.startsWith("male") || raw === "man" || raw === "boy") return "male";
  if (raw === "f" || raw.startsWith("female") || raw === "woman" || raw === "girl") return "female";
  return "other";
}

export function parseReferenceRange(
  refRange: string | null | undefined,
): ParsedRange {
  if (!refRange || typeof refRange !== "string") {
    return { low: null, high: null, type: "none" };
  }

  const cleaned = refRange
    .replace(/\([^)]*\)/g, "") // Remove parenthetical notes like "(Optimal)"
    .replace(/[a-zA-Z%\/]+/g, " ") // Remove units like mg/dL, U/L
    .replace(/,/g, "") // Remove commas in numbers
    .trim();

  // Pattern: "< X" or "≤ X" or "Less than X"
  const lessThanMatch = cleaned.match(/[<≤]\s*([\d.]+)/);
  if (lessThanMatch) {
    return { low: null, high: parseFloat(lessThanMatch[1]), type: "less_than" };
  }

  // Pattern: "> X" or "≥ X" or "Greater than X"
  const greaterThanMatch = cleaned.match(/[>≥]\s*([\d.]+)/);
  if (greaterThanMatch) {
    return {
      low: parseFloat(greaterThanMatch[1]),
      high: null,
      type: "greater_than",
    };
  }

  // Pattern: "X - Y" or "X – Y" or "X to Y" or "X~Y"
  const rangeMatch = cleaned.match(/([\d.]+)\s*[-–—~to]+\s*([\d.]+)/i);
  if (rangeMatch) {
    const low = parseFloat(rangeMatch[1]);
    const high = parseFloat(rangeMatch[2]);
    // Ensure low < high
    return {
      low: Math.min(low, high),
      high: Math.max(low, high),
      type: "range",
    };
  }

  // Single number (assume upper limit)
  const singleMatch = cleaned.match(/^([\d.]+)$/);
  if (singleMatch) {
    return { low: null, high: parseFloat(singleMatch[1]), type: "single" };
  }

  return { low: null, high: null, type: "none" };
}

/**
 * Extract numeric value from a string that may contain units
 */
export function extractNumericValue(
  value: string | number | null | undefined,
): number | null {
  if (value === null || value === undefined || value === "") return null;

  if (typeof value === "number") return value;

  // Remove common units and extract number
  const cleaned = String(value)
    .replace(/[,]/g, "") // Remove commas
    .replace(/[<>≤≥]/g, "") // Remove comparison operators
    .trim();

  const match = cleaned.match(/^-?([\d.]+)/);
  if (match) {
    const num = parseFloat(match[0]);
    return isNaN(num) ? null : num;
  }

  return null;
}

// ============================================
// FLAG DETERMINATION
// ============================================

/**
 * Main flag determination function
 * Routes to appropriate handler based on value type
 */
export function determineFlag(
  value: string | number | null | undefined,
  config: AnalyteConfig,
  patient?: PatientContext,
): FlagResult {
  // No value - no flag
  if (value === null || value === undefined || value === "") {
    return {
      flag: null,
      source: "auto_numeric",
      confidence: 1,
      needsReview: false,
    };
  }

  const strValue = String(value).trim();
  const valueType = config.value_type || detectValueType(strValue);

  // Route to appropriate handler based on value type
  switch (valueType) {
    case "numeric":
      return determineNumericFlag(strValue, config, patient);
    case "qualitative":
      return determineQualitativeFlag(strValue, config);
    case "semi_quantitative":
      return determineSemiQuantFlag(strValue, config);
    case "descriptive":
      return {
        flag: null,
        source: "auto_text",
        confidence: 1,
        needsReview: false,
        auditNotes: "Descriptive value - no flag applicable",
      };
    default:
      return determineNumericFlag(strValue, config, patient);
  }
}

/**
 * Auto-detect the type of value
 */
function detectValueType(value: string): ValueType {
  const num = extractNumericValue(value);
  if (num !== null) return "numeric";

  const lower = value.toLowerCase().trim();

  // Semi-quantitative patterns
  if (/^[+-]+$/.test(value) || /^[1-4]\+$/.test(value) || lower === "trace") {
    return "semi_quantitative";
  }

  // Qualitative patterns
  if (
    NORMAL_TEXT_PATTERNS.some((p) => p.test(lower)) ||
    ABNORMAL_TEXT_PATTERNS.some((p) => p.test(lower))
  ) {
    return "qualitative";
  }

  // If contains multiple words, likely descriptive
  if (value.split(/\s+/).length > 3) {
    return "descriptive";
  }

  return "qualitative"; // Default to qualitative for unknown text
}

/**
 * Determine flag for numeric values
 */
function determineNumericFlag(
  value: string,
  config: AnalyteConfig,
  patient?: PatientContext,
): FlagResult {
  const numValue = extractNumericValue(value);

  if (numValue === null) {
    // Value looks numeric but couldn't parse - needs review
    return {
      flag: null,
      source: "auto_numeric",
      confidence: 0,
      needsReview: true,
      auditNotes: `Could not parse numeric value from "${value}"`,
    };
  }

  // Get appropriate reference range based on gender.
  // Compared case-insensitively: labs configure their own gender_options, so an
  // exact "Male" match silently dropped the gender range for any lab using M/F
  // or lowercase values.
  let refRange = config.reference_range;
  const normalizedGender = normalizeGenderValue(patient?.gender);
  if (normalizedGender === "male" && config.reference_range_male) {
    refRange = config.reference_range_male;
  } else if (normalizedGender === "female" && config.reference_range_female) {
    refRange = config.reference_range_female;
  }

  const { low, high, type } = parseReferenceRange(refRange);
  const lowCritical = extractNumericValue(config.low_critical);
  const highCritical = extractNumericValue(config.high_critical);

  // Critical checks first (highest priority)
  if (highCritical !== null && numValue >= highCritical) {
    return {
      flag: "critical_high",
      source: "auto_numeric",
      confidence: 1,
      needsReview: false,
      interpretation:
        `Value ${numValue} exceeds critical high threshold of ${highCritical}`,
    };
  }

  if (lowCritical !== null && numValue < lowCritical) {
    return {
      flag: "critical_low",
      source: "auto_numeric",
      confidence: 1,
      needsReview: false,
      interpretation:
        `Value ${numValue} below critical low threshold of ${lowCritical}`,
    };
  }

  // Range-based checks
  if (type === "range" && low !== null && high !== null) {
    if (numValue < low) {
      return {
        flag: "low",
        source: "auto_numeric",
        confidence: 1,
        needsReview: false,
        interpretation:
          `Value ${numValue} below reference range ${low}-${high}`,
      };
    }
    if (numValue > high) {
      return {
        flag: "high",
        source: "auto_numeric",
        confidence: 1,
        needsReview: false,
        interpretation:
          `Value ${numValue} above reference range ${low}-${high}`,
      };
    }
    return {
      flag: "normal",
      source: "auto_numeric",
      confidence: 1,
      needsReview: false,
    };
  }

  // Less-than check (e.g., "< 100")
  if (type === "less_than" && high !== null) {
    if (numValue > high) {
      return {
        flag: "high",
        source: "auto_numeric",
        confidence: 1,
        needsReview: false,
        interpretation: `Value ${numValue} exceeds upper limit of ${high}`,
      };
    }
    return {
      flag: "normal",
      source: "auto_numeric",
      confidence: 1,
      needsReview: false,
    };
  }

  // Greater-than check (e.g., "> 40")
  if (type === "greater_than" && low !== null) {
    if (numValue < low) {
      return {
        flag: "low",
        source: "auto_numeric",
        confidence: 1,
        needsReview: false,
        interpretation: `Value ${numValue} below lower limit of ${low}`,
      };
    }
    return {
      flag: "normal",
      source: "auto_numeric",
      confidence: 1,
      needsReview: false,
    };
  }

  // No parseable range - needs review
  return {
    flag: null,
    source: "auto_numeric",
    confidence: 0,
    needsReview: true,
    auditNotes:
      `Could not parse reference range "${refRange}" for value ${numValue}`,
  };
}

/**
 * Determine flag for qualitative values (Positive/Negative, etc.)
 *
 * Priority order:
 * 1. expected_normal_values (exact match only)
 * 2. reference_range comparison (for qualitative refs like "Non-Reactive")
 * 3. Pattern matching (NORMAL/ABNORMAL text patterns)
 */
function determineQualitativeFlag(
  value: string,
  config: AnalyteConfig,
): FlagResult {
  const lower = value.toLowerCase().trim();

  // 1. Check against expected normal values from config (EXACT match only)
  if (
    config.expected_normal_values && config.expected_normal_values.length > 0
  ) {
    const normalValues = config.expected_normal_values.map((v) =>
      v.toLowerCase().trim()
    );
    if (normalValues.some((nv) => lower === nv)) {
      return {
        flag: "normal",
        source: "auto_text",
        confidence: 0.95,
        needsReview: false,
      };
    }
    // If we have expected values and this doesn't match, it's abnormal
    return {
      flag: "abnormal",
      source: "auto_text",
      confidence: 0.85,
      needsReview: false,
      auditNotes: `Value "${value}" not in expected normal values: ${
        config.expected_normal_values.join(", ")
      }`,
    };
  }

  // 2. Compare against reference_range for qualitative references
  //    e.g. reference_range = "Non-Reactive" and value = "Reactive" → abnormal
  if (config.reference_range) {
    const refLower = config.reference_range.toLowerCase().trim();
    const isQualitativeRef = isTextQualitative(refLower);

    if (isQualitativeRef) {
      // Exact match with reference = normal
      if (lower === refLower) {
        return {
          flag: "normal",
          source: "auto_rule",
          confidence: 0.95,
          needsReview: false,
        };
      }
      // Value doesn't match the qualitative reference → abnormal
      return {
        flag: "abnormal",
        source: "auto_rule",
        confidence: 0.95,
        needsReview: false,
        interpretation:
          `Qualitative result "${value}" does not match expected "${config.reference_range}"`,
      };
    }
  }

  // 3. Fall back to pattern matching
  if (NORMAL_TEXT_PATTERNS.some((pattern) => pattern.test(lower))) {
    return {
      flag: "normal",
      source: "auto_text",
      confidence: 0.9,
      needsReview: false,
    };
  }

  if (ABNORMAL_TEXT_PATTERNS.some((pattern) => pattern.test(lower))) {
    return {
      flag: "abnormal",
      source: "auto_text",
      confidence: 0.9,
      needsReview: false,
      interpretation:
        `Qualitative result "${value}" indicates abnormal finding`,
    };
  }

  // Unknown text value - needs review
  return {
    flag: null,
    source: "auto_text",
    confidence: 0,
    needsReview: true,
    auditNotes: `Unknown qualitative value "${value}" - needs manual review`,
  };
}

/**
 * Check if a string looks like a qualitative value (not numeric)
 */
function isTextQualitative(text: string): boolean {
  return NORMAL_TEXT_PATTERNS.some((p) => p.test(text)) ||
    ABNORMAL_TEXT_PATTERNS.some((p) => p.test(text)) ||
    /^(non[\s-]?reactive|negative|not[\s-]?detected|absent|nil|no[\s-]?growth|positive|reactive|detected|present)$/i
      .test(text);
}

/**
 * Determine flag for semi-quantitative values (1+, 2+, Trace, etc.)
 */
function determineSemiQuantFlag(
  value: string,
  _config: AnalyteConfig,
): FlagResult {
  const normalized = value.toLowerCase().trim();

  // Check if it's a "normal" semi-quant value
  if (SEMI_QUANT_NORMAL.includes(normalized)) {
    return {
      flag: "normal",
      source: "auto_text",
      confidence: 0.95,
      needsReview: false,
    };
  }

  // Check if it's an abnormal semi-quant value
  const upperValue = value.toUpperCase().trim();
  if (SEMI_QUANT_ABNORMAL_ORDER.some((v) => v === upperValue || v === value)) {
    // Determine severity by position in order
    const index = SEMI_QUANT_ABNORMAL_ORDER.findIndex((v) =>
      v === upperValue || v === value
    );
    const isHighSeverity = index >= 4; // 3+ and above

    return {
      flag: isHighSeverity ? "high" : "abnormal",
      source: "auto_text",
      confidence: 0.9,
      needsReview: false,
      interpretation: `Semi-quantitative result ${value} indicates ${
        isHighSeverity ? "significant" : "mild"
      } abnormality`,
    };
  }

  return {
    flag: null,
    source: "auto_text",
    confidence: 0,
    needsReview: true,
    auditNotes: `Unknown semi-quantitative value "${value}"`,
  };
}

// ============================================
// BATCH PROCESSING
// ============================================

export interface BatchFlagInput {
  value: string | number | null;
  analyte: AnalyteConfig;
  resultValueId?: string;
}

export interface BatchFlagOutput extends FlagResult {
  resultValueId?: string;
  analyteId?: string;
}

/**
 * Process multiple values for flag determination
 */
export function determineFlagsBatch(
  inputs: BatchFlagInput[],
  patient?: PatientContext,
): BatchFlagOutput[] {
  return inputs.map((input) => ({
    ...determineFlag(input.value, input.analyte, patient),
    resultValueId: input.resultValueId,
    analyteId: input.analyte.id,
  }));
}

/**
 * Get items that need review from batch results
 */
export function getItemsNeedingReview(
  results: BatchFlagOutput[],
): BatchFlagOutput[] {
  return results.filter((r) => r.needsReview || r.confidence < 0.7);
}

// ============================================
// FLAG DISPLAY HELPERS
// ============================================

/**
 * Convert internal flag value to display string
 */
export function flagToDisplayString(flag: FlagValue): string {
  if (!flag) return "";

  const displayMap: Record<string, string> = {
    "normal": "",
    "high": "H",
    "low": "L",
    "critical_h": "H*",
    "critical_l": "L*",
    "critical_high": "H*",
    "critical_low": "L*",
    "abnormal": "A",
    // also fallback for single letter inputs
    "h": "H",
    "l": "L",
    "a": "A",
    "c": "H*", // Fallback if just C
  };

  const normalizedFlag = typeof flag === "string" ? flag.toLowerCase() : flag;
  return normalizedFlag ? (displayMap[normalizedFlag] || "") : "";
}

/**
 * Get CSS class for flag styling
 */
export function flagToCssClass(flag: FlagValue): string {
  if (!flag) return "";

  const classMap: Record<string, string> = {
    "normal": "flag-normal",
    "high": "flag-high flag-h",
    "low": "flag-low flag-l",
    "critical_high": "flag-critical flag-critical-high flag-c",
    "critical_low": "flag-critical flag-critical-low flag-c",
    "abnormal": "flag-abnormal flag-a",
  };

  return classMap[flag] || "";
}

/**
 * Check if a flag indicates an abnormal result
 */
export function isAbnormalFlag(flag: FlagValue): boolean {
  return flag !== null && flag !== "normal";
}

/**
 * Check if a flag indicates a critical result
 */
export function isCriticalFlag(flag: FlagValue): boolean {
  return flag === "critical_high" || flag === "critical_low";
}

// ============================================
// LEGACY COMPATIBILITY
// ============================================

/**
 * Simple flag determination for legacy code
 * Returns flag string compatible with existing system ('H', 'L', 'H*', 'L*', '')
 */
export function determineFlagSimple(
  value: string | number | null | undefined,
  referenceRange: string | null | undefined,
  lowCritical?: string | number | null,
  highCritical?: string | number | null,
  patientGender?: string,
): string {
  const result = determineFlag(
    value,
    {
      reference_range: referenceRange || undefined,
      low_critical: lowCritical,
      high_critical: highCritical,
    },
    patientGender ? { gender: patientGender } : undefined,
  );

  return flagToDisplayString(result.flag);
}

/**
 * Parse reference range for legacy code
 * Returns object compatible with existing parseReferenceRange usages
 */
export function parseReferenceRangeLegacy(
  refRange: string | null | undefined,
): {
  min: number | null;
  max: number | null;
} {
  const parsed = parseReferenceRange(refRange);
  return {
    min: parsed.low,
    max: parsed.high,
  };
}
