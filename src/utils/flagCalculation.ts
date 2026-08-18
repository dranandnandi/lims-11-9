// Flag calculation utilities for lab results
// This module wraps the comprehensive flagDetermination system

import { 
  determineFlag, 
  flagToDisplayString, 
  isAbnormalFlag, 
  isCriticalFlag,
  type FlagResult,
  type AnalyteConfig 
} from './flagDetermination';

export interface ResultValue {
  parameter: string;
  value: string;
  unit: string;
  reference_range: string;
  reference_range_male?: string;
  reference_range_female?: string;
  low_critical?: string | number;
  high_critical?: string | number;
  expected_normal_values?: string[];
  value_type?: string;
  flag?: string;
}

export interface ResolvedFlag {
  /** Display flag: '' for normal, otherwise 'H' | 'L' | 'H*' | 'L*' | 'A'. */
  flag: string;
  /**
   * True when the engine reached a verdict — including a verdict of "normal".
   * Callers must branch on this rather than on `flag`, because a normal result
   * and an undecidable one both render as an empty string. Treating the two
   * alike is what lets a stale flag survive a corrected value.
   */
  determined: boolean;
  /** True when the verdict came from a parsed numeric reference range. */
  numeric: boolean;
}

/**
 * Determine a flag and report whether the engine actually decided.
 * Same inputs as calculateFlag; prefer this wherever the result overwrites an
 * existing flag.
 */
export const resolveFlag = (
  value: string,
  referenceRange: string,
  patientGender?: string,
  lowCritical?: string | number,
  highCritical?: string | number,
  referenceRangeMale?: string,
  referenceRangeFemale?: string,
  expectedNormalValues?: string[],
  valueType?: string
): ResolvedFlag => {
  const undecided: ResolvedFlag = { flag: '', determined: false, numeric: false };
  if (!value) return undecided;
  // Qualitative analytes intentionally skip auto flag calculation.
  // Flag assignment for qualitative is explicit-only (via expected_value_flag_map on selection).
  if (valueType === 'qualitative') return undecided;

  const config: AnalyteConfig = {
    reference_range: referenceRange,
    reference_range_male: referenceRangeMale,
    reference_range_female: referenceRangeFemale,
    low_critical: lowCritical,
    high_critical: highCritical,
    expected_normal_values: expectedNormalValues
  };

  const result = determineFlag(value, config, { gender: patientGender });
  if (result.flag === null || result.needsReview) return undecided;

  return {
    flag: flagToDisplayString(result.flag),
    determined: true,
    numeric: result.source === 'auto_numeric'
  };
};

/**
 * Calculate flag based on value and reference range
 * Uses comprehensive flag determination that handles:
 * - Numeric values with ranges (10-40, <200, >50)
 * - Gender-specific ranges
 * - Critical values
 * - Qualitative values (Positive/Negative)
 * - Semi-quantitative values (1+, 2+, Trace)
 *
 * Returns '' for both "normal" and "could not determine". Use resolveFlag when
 * the answer decides whether an existing flag gets replaced.
 */
export const calculateFlag = (
  value: string,
  referenceRange: string,
  patientGender?: string,
  lowCritical?: string | number,
  highCritical?: string | number,
  referenceRangeMale?: string,
  referenceRangeFemale?: string,
  expectedNormalValues?: string[],
  valueType?: string
): string => resolveFlag(
  value,
  referenceRange,
  patientGender,
  lowCritical,
  highCritical,
  referenceRangeMale,
  referenceRangeFemale,
  expectedNormalValues,
  valueType
).flag;

/**
 * Reduce any stored flag spelling to a canonical code.
 * Labs configure their own flag_options ('critical_h'), the engine emits display
 * codes ('H*'), and normalizeResultFlagForSave writes 'normal' — all three reach
 * the same column.
 */
export const normalizeFlagCode = (flag?: string | null): string => {
  const raw = String(flag ?? '').trim();
  const f = raw.toLowerCase().replace(/[\s-]+/g, '_');
  if (!f || f === 'normal' || f === 'n') return '';
  if (f === 'h' || f === 'high') return 'H';
  if (f === 'l' || f === 'low') return 'L';
  if (f === 'h*' || f === 'critical_h' || f === 'critical_high' || f === 'high_critical') return 'H*';
  if (f === 'l*' || f === 'critical_l' || f === 'critical_low' || f === 'low_critical') return 'L*';
  if (f === 'a' || f === 'abnormal') return 'A';
  if (f === 'c' || f === 'critical' || f === 'crit') return 'C';
  return raw;
};

type FlagDirection = 'normal' | 'high' | 'low' | 'abnormal' | 'unknown';

const flagDirection = (code: string): FlagDirection => {
  switch (code) {
    case '': return 'normal';
    case 'H':
    case 'H*': return 'high';
    case 'L':
    case 'L*': return 'low';
    case 'A': return 'abnormal';
    default: return 'unknown'; // generic 'C' or a lab-specific code we cannot reason about
  }
};

export interface FlagConflict {
  conflict: boolean;
  /** Canonical flag the engine derives from the value + reference range. */
  expected: string;
  /** Canonical form of the flag actually stored on the row. */
  actual: string;
  message?: string;
}

/**
 * Report whether a stored flag contradicts the value and reference range saved
 * alongside it. Deliberately conservative: only a numeric verdict is allowed to
 * contradict a flag, and a generic/unrecognised flag code is never called wrong.
 */
export const detectFlagConflict = (
  value: string,
  referenceRange: string,
  storedFlag?: string | null,
  opts?: { valueType?: string; patientGender?: string }
): FlagConflict => {
  const actual = normalizeFlagCode(storedFlag);
  const resolved = resolveFlag(
    value,
    referenceRange,
    opts?.patientGender,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    opts?.valueType
  );
  const expected = normalizeFlagCode(resolved.flag);
  const base: FlagConflict = { conflict: false, expected, actual };

  if (!resolved.determined || !resolved.numeric) return base;

  const expectedDir = flagDirection(expected);
  const actualDir = flagDirection(actual);
  if (actualDir === 'unknown' || expectedDir === actualDir) return base;
  // 'A' is a weaker claim than H/L — it only contradicts a normal verdict.
  if (actualDir === 'abnormal' && expectedDir !== 'normal') return base;

  const message = actualDir === 'normal'
    ? `${value} falls outside ${referenceRange} but carries no flag (expected ${expected})`
    : expectedDir === 'normal'
      ? `${value} is within ${referenceRange} but is flagged ${actual}`
      : `${value} reads ${expectedDir} against ${referenceRange} but is flagged ${actual}`;

  return { conflict: true, expected, actual, message };
};

/**
 * Legacy range parser for backwards compatibility
 */
const calculateFlagForRange = (value: number, range: string): string => {
  // Handle ranges like "<200"
  if (range.startsWith('<')) {
    const maxValue = parseFloat(range.substring(1));
    return value >= maxValue ? 'H' : '';
  }
  
  // Handle ranges like ">50"
  if (range.startsWith('>')) {
    const minValue = parseFloat(range.substring(1));
    return value <= minValue ? 'L' : '';
  }
  
  // Handle ranges like "10-40"
  if (range.includes('-')) {
    const parts = range.split('-');
    if (parts.length === 2) {
      const minValue = parseFloat(parts[0]);
      const maxValue = parseFloat(parts[1]);
      
      if (!isNaN(minValue) && !isNaN(maxValue)) {
        if (value < minValue) return 'L';
        if (value > maxValue) return 'H';
        return ''; // Normal range
      }
    }
  }
  
  // Handle ranges like "10 - 40" (with spaces)
  const dashMatch = range.match(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)/);
  if (dashMatch) {
    const minValue = parseFloat(dashMatch[1]);
    const maxValue = parseFloat(dashMatch[2]);
    
    if (value < minValue) return 'L';
    if (value > maxValue) return 'H';
    return ''; // Normal range
  }
  
  return ''; // Cannot determine flag
};

/**
 * Automatically calculate flags for all result values
 * Enhanced to use comprehensive flag determination
 */
export const calculateFlagsForResults = (values: ResultValue[], patientGender?: string): ResultValue[] => {
  return values.map(value => ({
    ...value,
    flag: value.flag || calculateFlag(
      value.value,
      value.reference_range,
      patientGender,
      value.low_critical,
      value.high_critical,
      value.reference_range_male,
      value.reference_range_female,
      value.expected_normal_values,
      value.value_type
    )
  }));
};

/**
 * Check if any values have abnormal flags
 */
export const hasAbnormalFlags = (values: ResultValue[]): boolean => {
  return values.some(value => {
    const flag = value.flag || calculateFlag(value.value, value.reference_range);
    return flag === 'H' || flag === 'L' || flag === 'H*' || flag === 'L*' || flag === 'A';
  });
};

/**
 * Check if any values have critical flags
 */
export const hasCriticalFlags = (values: ResultValue[]): boolean => {
  return values.some(value => {
    const flag = value.flag || calculateFlag(value.value, value.reference_range);
    return flag === 'H*' || flag === 'L*';
  });
};

/**
 * Get flag description
 */
export const getFlagDescription = (flag: string): string => {
  switch (flag) {
    case 'H': return 'High';
    case 'L': return 'Low';
    case 'H*': return 'Critical High';
    case 'L*': return 'Critical Low';
    case 'A': return 'Abnormal';
    case 'C': return 'Critical'; // Legacy
    default: return 'Normal';
  }
};

/**
 * Get flag color class for UI
 */
export const getFlagColor = (flag?: string): string => {
  switch (flag) {
    case 'H': return 'text-red-600 bg-red-100';
    case 'L': return 'text-blue-600 bg-blue-100';
    case 'H*': return 'text-red-800 bg-red-200 font-bold';
    case 'L*': return 'text-blue-800 bg-blue-200 font-bold';
    case 'A': return 'text-orange-600 bg-orange-100';
    case 'C': return 'text-yellow-600 bg-yellow-100'; // Legacy
    default: return '';
  }
};

/**
 * Get flag severity level (for sorting)
 */
export const getFlagSeverity = (flag?: string): number => {
  switch (flag) {
    case 'H*': return 4; // Critical High
    case 'L*': return 4; // Critical Low
    case 'H': return 2;  // High
    case 'L': return 2;  // Low
    case 'A': return 1;  // Abnormal
    default: return 0;   // Normal
  }
};