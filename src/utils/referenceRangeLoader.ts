/**
 * Data loading for the deterministic reference range route.
 *
 * The picking logic lives in referenceRangeResolver (pure, testable). This file
 * is the thin I/O layer around it so the four result-entry surfaces don't each
 * grow their own copy of the same two queries.
 */

import { supabase } from './supabase';
import {
  buildRangeContext,
  resolveReferenceRange,
  type PatientContextLike,
  type PatientLike,
  type RangeResolutionContext,
  type ReferenceRangeRule,
  type ResolvedRange,
} from './referenceRangeResolver';

export type RangeRuleMap = Map<string, ReferenceRangeRule[]>;

const RULE_COLUMNS =
  'id, lab_analyte_id, gender, age_min_days, age_max_days, sample_condition, pregnancy, ' +
  'range_text, range_low, range_high, range_operator, low_critical, high_critical, ' +
  'priority, is_active, notes, created_at';

/**
 * Rules for a set of lab analytes, keyed by lab_analyte_id.
 *
 * Returns an empty map rather than throwing when the table is missing, so a lab
 * that has not run the migration yet keeps working on the legacy columns.
 */
export async function fetchRangeRules(
  labAnalyteIds: Array<string | null | undefined>,
): Promise<RangeRuleMap> {
  const ids = Array.from(new Set(labAnalyteIds.filter(Boolean))) as string[];
  const map: RangeRuleMap = new Map();
  if (ids.length === 0) return map;

  try {
    const { data, error } = await supabase
      .from('lab_analyte_reference_ranges')
      .select(RULE_COLUMNS)
      .in('lab_analyte_id', ids)
      .eq('is_active', true);

    if (error) throw error;

    for (const rule of (data || []) as ReferenceRangeRule[]) {
      const key = rule.lab_analyte_id;
      if (!key) continue;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(rule);
    }
  } catch (err) {
    console.warn('[ref-range] rule lookup failed, falling back to legacy columns:', err);
  }

  return map;
}

export interface PatientRangeInfo {
  patient: PatientLike | null;
  patientContext: PatientContextLike | null;
}

/**
 * The patient facts the resolver needs: gender, age (DOB preferred) and
 * pregnancy. `orders.patient_context` is the richer source when the order was
 * booked through the order form, so prefer it and fall back to the patient row.
 */
export async function fetchPatientRangeInfo(
  orderId: string,
  patientId?: string | null,
): Promise<PatientRangeInfo> {
  const result: PatientRangeInfo = { patient: null, patientContext: null };

  try {
    const { data: order } = await supabase
      .from('orders')
      .select('patient_id, patient_context')
      .eq('id', orderId)
      .maybeSingle();

    result.patientContext = (order?.patient_context as PatientContextLike) || null;

    const targetPatientId = patientId || order?.patient_id;
    if (targetPatientId) {
      const { data: patient } = await supabase
        .from('patients')
        .select('id, gender, dob, date_of_birth, age, age_unit')
        .eq('id', targetPatientId)
        .maybeSingle();
      result.patient = patient || null;
    }
  } catch (err) {
    console.warn('[ref-range] patient context lookup failed:', err);
  }

  return result;
}

/**
 * Context for one test group. Sample condition is per-group, everything else is
 * per-order, which is why this takes the condition separately.
 */
export function contextForGroup(
  info: PatientRangeInfo | null | undefined,
  sampleCondition: string | null | undefined,
): RangeResolutionContext {
  return buildRangeContext({
    patient: info?.patient,
    patientContext: info?.patientContext,
    sampleCondition,
  });
}

export interface AnalyteRangeInput {
  lab_analyte_id?: string | null;
  lab_specific_reference_range?: string | null;
  reference_range?: string | null;
  reference_range_male?: string | null;
  reference_range_female?: string | null;
  low_critical?: string | number | null;
  high_critical?: string | number | null;
}

/** Resolve one analyte against the loaded rules. */
export function resolveForAnalyte(
  rules: RangeRuleMap | null | undefined,
  analyte: AnalyteRangeInput,
  ctx: RangeResolutionContext,
): ResolvedRange {
  const analyteRules = analyte.lab_analyte_id ? rules?.get(analyte.lab_analyte_id) : undefined;
  return resolveReferenceRange(analyteRules, ctx, analyte);
}

/**
 * Audit columns for result_values. Kept in one place so every save path writes
 * the same shape; a range the user typed over is recorded as 'manual'.
 */
export function rangeAuditColumns(resolved: {
  rule_id?: string | null;
  applied_rule?: string | null;
  source?: string | null;
} | null | undefined, opts: { edited?: boolean } = {}) {
  if (opts.edited) {
    return { range_rule_id: null, range_source: 'manual', applied_range_rule: null };
  }
  if (!resolved || !resolved.source || resolved.source === 'none') {
    return { range_rule_id: null, range_source: null, applied_range_rule: null };
  }
  return {
    range_rule_id: resolved.rule_id || null,
    range_source: resolved.source,
    applied_range_rule: resolved.applied_rule || null,
  };
}
