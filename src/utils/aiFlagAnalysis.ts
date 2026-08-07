/**
 * AI Flag Analysis Utility
 * 
 * This module provides AI-powered flag determination and interpretation for lab results.
 * It runs after result values are saved to:
 * 1. Determine flags based on rules (numeric comparison, qualitative matching)
 * 2. Generate AI interpretations for abnormal values (via Netlify function - secure)
 * 3. Override manual flags if AI confidence is high
 * 4. Create audit trail for flag decisions
 * 
 * SECURITY NOTE:
 * - Rule-based flag determination runs client-side (no API keys)
 * - AI interpretation calls Netlify function (API keys stored server-side)
 */

import { database, supabase } from './supabase';
import { determineFlag, FlagResult, ValueType, AnalyteConfig, PatientContext as FlagPatientContext } from './flagDetermination';
import { findResolvedReferenceRange, isPlaceholderReferenceRange, resolveReferenceRanges } from './referenceRangeService';

// Netlify function URL for AI interpretation (keeps API key secure)
const AI_FLAG_FUNCTION_URL = '/.netlify/functions/ai-flag-interpretation';

// A blank reference range is a deliberate lab choice ("this analyte prints no
// range"), so AI must never fill it in. Only a non-blank dynamic placeholder
// such as "Age-specific" asks to be resolved; otherwise the test group's
// "Enable AI Reference Range Determination" toggle is the only trigger.
const isDynamicPlaceholderRange = (range?: string | null): boolean => {
  const trimmed = String(range || '').trim();
  return trimmed !== '' && isPlaceholderReferenceRange(trimmed);
};

// ============================================================================
// Types
// ============================================================================

export interface ResultValueContext {
  id: string;
  value: string;
  unit?: string;
  reference_range?: string;
  reference_range_male?: string;
  reference_range_female?: string;
  low_critical?: string;
  high_critical?: string;
  parameter?: string;
  flag?: string;
  analyte_id?: string;
  result_id?: string;
  order_id?: string;
  lab_id?: string;
  test_group_id?: string;
}

export interface AnalyteContext {
  id: string;
  name: string;
  unit?: string;
  reference_range?: string;
  reference_range_male?: string;
  reference_range_female?: string;
  low_critical?: string;
  high_critical?: string;
  value_type?: ValueType;
  expected_normal_values?: string[];
  flag_rules?: any;
  interpretation_low?: string;
  interpretation_normal?: string;
  interpretation_high?: string;
}

export interface PatientContext {
  gender?: string;
  age?: number;
  dob?: string;
}

/** Snapshot of analyte/lab_analyte fields to persist on result_values for PDF templates */
export interface EnrichedAnalyteSnapshot {
  normal_range_min?: number | null;
  normal_range_max?: number | null;
  low_critical?: string | null;
  high_critical?: string | null;
  reference_range_male?: string | null;
  reference_range_female?: string | null;
  method?: string | null;
  value_type?: string | null;
}

export interface AIFlagAnalysisResult {
  resultValueId: string;
  originalFlag?: string;
  newFlag: string;
  flagSource: 'auto_numeric' | 'auto_text' | 'auto_rule' | 'ai' | 'manual' | 'inherited';
  flagConfidence: number;
  interpretation?: string;
  auditStatus: 'pending' | 'confirmed' | 'overridden' | 'needs_review' | 'none' | 'approved' | 'rejected'; // Matches DB constraint
  auditNotes?: string;
  changed: boolean;
  valueType?: string;
  /** The gender-resolved reference range used for flag determination */
  resolvedReferenceRange?: string;
  /** Enriched analyte fields to snapshot onto result_values for PDF template use */
  enrichedSnapshot?: EnrichedAnalyteSnapshot;
}

export interface BatchAnalysisResult {
  results: AIFlagAnalysisResult[];
  totalProcessed: number;
  flagsChanged: number;
  errors: Array<{ resultValueId: string; error: string }>;
}

// ============================================================================
// AI Service Functions (calls Netlify function - secure)
// ============================================================================

interface LabFlagOption {
  value: string;
  label: string;
}

/**
 * Call AI service for enhanced flag interpretation
 * This calls the Netlify function which keeps the API key server-side
 */
async function callAIFlagService(
  resultValues: Array<{
    id: string;
    parameter: string;
    value: string;
    unit?: string;
    reference_range?: string;
    reference_range_male?: string;
    reference_range_female?: string;
    low_critical?: string;
    high_critical?: string;
    current_flag?: string;
  }>,
  patient?: PatientContext,
  testGroupName?: string,
  labFlagOptions?: LabFlagOption[]
): Promise<Array<{
  id: string;
  flag: string | null;
  flag_confidence: number;
  interpretation: string;
  clinical_significance?: string;
  suggested_action?: string;
}> | null> {
  try {
    const response = await fetch(AI_FLAG_FUNCTION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'analyze_flags',
        result_values: resultValues,
        patient,
        test_group_name: testGroupName,
        lab_flag_options: labFlagOptions
      })
    });

    if (!response.ok) {
      console.warn('AI flag service returned error:', response.status);
      return null;
    }

    const data = await response.json();
    if (!data.success) {
      console.warn('AI flag service failed:', data.error);
      return null;
    }

    return data.data;
  } catch (error) {
    console.warn('AI flag service unavailable, using rule-based flags:', error);
    return null;
  }
}

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Normalize flag from display format to internal format
 * Display format: 'H', 'L', 'H*', 'L*', 'A', '' (from flagToDisplayString)
 * Internal format: 'high', 'low', 'critical_high', 'critical_low', 'abnormal', 'normal', ''
 */
function normalizeFlag(flag: string): string {
  if (!flag) return '';
  // If already in internal format, return as-is
  const internalFlags = ['normal', 'high', 'low', 'critical_high', 'critical_low', 'abnormal'];
  if (internalFlags.includes(flag)) return flag;
  // Map display format → internal format
  const displayToInternal: Record<string, string> = {
    'H': 'high',
    'L': 'low',
    'H*': 'critical_high',
    'L*': 'critical_low',
    'A': 'abnormal',
    '': '',
  };
  return displayToInternal[flag] ?? flag;
}

/**
 * Calculate age from date of birth
 */
function calculateAge(dob: string): number | undefined {
  if (!dob) return undefined;
  const birthDate = new Date(dob);
  const today = new Date();
  let age = today.getFullYear() - birthDate.getFullYear();
  const monthDiff = today.getMonth() - birthDate.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
    age--;
  }
  return age;
}

/**
 * Get gender-specific reference range
 */
function getGenderSpecificRange(
  analyte: AnalyteContext,
  patient?: PatientContext
): string | undefined {
  if (patient?.gender?.toLowerCase() === 'male' && analyte.reference_range_male) {
    return analyte.reference_range_male;
  }
  if (patient?.gender?.toLowerCase() === 'female' && analyte.reference_range_female) {
    return analyte.reference_range_female;
  }
  return analyte.reference_range;
}

/**
 * Determine appropriate interpretation based on flag
 */
function getInterpretation(
  flag: string,
  analyte: AnalyteContext
): string | undefined {
  if (!flag) return analyte.interpretation_normal;
  
  const flagUpper = flag.toUpperCase();
  
  if (flagUpper.includes('H') || flagUpper.includes('HIGH') || flagUpper === 'POSITIVE') {
    return analyte.interpretation_high || 'Value is above reference range';
  }
  if (flagUpper.includes('L') || flagUpper.includes('LOW')) {
    return analyte.interpretation_low || 'Value is below reference range';
  }
  if (flagUpper === 'NORMAL' || flagUpper === 'NEGATIVE' || flagUpper === 'N') {
    return analyte.interpretation_normal || 'Value is within normal range';
  }
  
  // For semi-quantitative values (1+, 2+, etc.)
  if (/^\d+\+$/.test(flag)) {
    return analyte.interpretation_high || 'Abnormal finding detected';
  }
  
  return undefined;
}

const mergeAnalyteWithLabOverride = (baseAnalyte?: AnalyteContext, labOverride?: any): AnalyteContext | undefined => {
  if (!baseAnalyte && !labOverride) return undefined;

  const base = baseAnalyte || (labOverride?.analytes as AnalyteContext | undefined) || undefined;
  const resolvedName =
    labOverride?.lab_specific_name ||
    labOverride?.name ||
    base?.name ||
    '';

  return {
    id: base?.id || labOverride?.analyte_id,
    name: resolvedName,
    unit: labOverride?.lab_specific_unit || labOverride?.unit || base?.unit,
    reference_range: labOverride != null
      ? (labOverride.lab_specific_reference_range ?? labOverride.reference_range ?? base?.reference_range)
      : base?.reference_range,
    reference_range_male:
      labOverride?.lab_specific_reference_range_male ??
      labOverride?.reference_range_male ??
      base?.reference_range_male,
    reference_range_female:
      labOverride?.lab_specific_reference_range_female ??
      labOverride?.reference_range_female ??
      base?.reference_range_female,
    low_critical:
      labOverride?.lab_specific_low_critical ||
      labOverride?.low_critical ||
      base?.low_critical,
    high_critical:
      labOverride?.lab_specific_high_critical ||
      labOverride?.high_critical ||
      base?.high_critical,
    value_type: (labOverride?.value_type || base?.value_type) as ValueType,
    expected_normal_values: labOverride?.expected_normal_values || base?.expected_normal_values,
    flag_rules: labOverride?.flag_rules || base?.flag_rules,
    interpretation_low:
      labOverride?.lab_specific_interpretation_low ||
      labOverride?.interpretation_low ||
      base?.interpretation_low,
    interpretation_normal:
      labOverride?.lab_specific_interpretation_normal ||
      labOverride?.interpretation_normal ||
      base?.interpretation_normal,
    interpretation_high:
      labOverride?.lab_specific_interpretation_high ||
      labOverride?.interpretation_high ||
      base?.interpretation_high,
  };
};

/**
 * Analyze a single result value and determine flag
 */
export async function analyzeResultValue(
  resultValue: ResultValueContext,
  analyte?: AnalyteContext,
  patient?: PatientContext
): Promise<AIFlagAnalysisResult> {
  try {
    // If no analyte provided, try to fetch it
    let analyteData = analyte;
    if (!analyteData && resultValue.analyte_id) {
      const labId = resultValue.lab_id || (await database.getCurrentUserLabId());
      if (labId) {
        const { data: labAnalyte } = await database.labAnalytes.getByLabAndAnalyte(labId, resultValue.analyte_id);
        analyteData = mergeAnalyteWithLabOverride(labAnalyte?.analytes as AnalyteContext | undefined, labAnalyte) || analyteData;
      }

      if (!analyteData) {
        const { data } = await supabase
          .from('analytes')
          .select('*')
          .eq('id', resultValue.analyte_id)
          .single();
        analyteData = data;
      }
    }

    // Prefer the concrete range already saved on result_values. AI reference
    // range resolution writes patient-specific ranges there; falling back to
    // catalog/lab config here would clobber values such as neonatal ranges.
    const savedReferenceRange = String(resultValue.reference_range || '').trim();
    const referenceRange = !isPlaceholderReferenceRange(savedReferenceRange)
      ? savedReferenceRange
      : (analyteData ? getGenderSpecificRange(analyteData, patient) : savedReferenceRange);
    const shouldPersistReferenceRange = !isPlaceholderReferenceRange(savedReferenceRange);

    // Build config for flag determination
    const config: AnalyteConfig = {
      id: analyteData?.id,
      name: analyteData?.name,
      reference_range: referenceRange,
      reference_range_male: analyteData?.reference_range_male,
      reference_range_female: analyteData?.reference_range_female,
      low_critical: analyteData?.low_critical || resultValue.low_critical,
      high_critical: analyteData?.high_critical || resultValue.high_critical,
      expected_normal_values: analyteData?.expected_normal_values,
      value_type: analyteData?.value_type as ValueType,
      flag_rules: analyteData?.flag_rules
    };

    // Build patient context for flag determination
    const flagPatient: FlagPatientContext | undefined = patient ? {
      age: patient.age,
      gender: patient.gender
    } : undefined;

    // Determine the flag
    const flagResult: FlagResult = determineFlag(
      resultValue.value,
      config,
      flagPatient
    );

    // Get interpretation
    const interpretation = analyteData 
      ? getInterpretation(flagResult.flag || '', analyteData)
      : undefined;

    // Determine if flag changed (compare normalized flag values)
    // Must normalize display-format flags ('A','H','L','H*','L*','') to internal format
    // since initial save uses display format but determineFlag returns internal format
    const normalizedNewFlag = flagResult.flag || '';
    const normalizedOldFlag = normalizeFlag(resultValue.flag || '');
    const changed = normalizedOldFlag !== normalizedNewFlag;

    // Use confidence from flag result
    const confidence = flagResult.confidence;

    return {
      resultValueId: resultValue.id,
      originalFlag: resultValue.flag,
      newFlag: normalizedNewFlag,
      flagSource: flagResult.source === 'manual' ? 'manual' : 'auto_rule',
      flagConfidence: confidence,
      resolvedReferenceRange: shouldPersistReferenceRange ? referenceRange : undefined,
      interpretation,
      auditStatus: changed ? 'pending' : 'approved',
      auditNotes: changed 
        ? `Flag changed from "${normalizedOldFlag || 'none'}" to "${normalizedNewFlag || 'none'}" (source: ${flagResult.source})`
        : undefined,
      changed,
      valueType: flagResult.source
    };
  } catch (error) {
    console.error('Error analyzing result value:', error);
    return {
      resultValueId: resultValue.id,
      originalFlag: resultValue.flag,
      newFlag: resultValue.flag || '',
      flagSource: 'manual',
      flagConfidence: 0,
      auditStatus: 'pending',
      auditNotes: `Analysis failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      changed: false
    };
  }
}

/**
 * Analyze result values for an order
 * Fetches all result values and their analytes, determines flags
 */
export async function analyzeOrderResults(
  orderId: string,
  options?: {
    overrideExisting?: boolean;
    patientContext?: PatientContext;
  }
): Promise<BatchAnalysisResult> {
  const results: AIFlagAnalysisResult[] = [];
  const errors: Array<{ resultValueId: string; error: string }> = [];

  try {
    // Fetch order with patient info
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select(`
        id,
        patient_id,
        patients:patient_id(id, gender, dob)
      `)
      .eq('id', orderId)
      .single();

    if (orderError) {
      throw new Error(`Failed to fetch order: ${orderError.message}`);
    }

    // Get patient context - handle patients relation (could be array or object depending on query)
    const patientsData = order?.patients;
    const patientData = Array.isArray(patientsData) ? patientsData[0] : patientsData;
    const patient = options?.patientContext || {
      gender: patientData?.gender,
      dob: patientData?.dob,
      age: patientData?.dob ? calculateAge(patientData.dob) : undefined
    };

    // Fetch result values with analyte data
    const { data: resultValues, error: rvError } = await database.resultValues.getForOrderWithFlags(orderId);
    
    if (rvError) {
      throw new Error(`Failed to fetch result values: ${rvError.message}`);
    }

    const analyteIds = (resultValues || [])
      .map((rv: any) => rv.analyte_id)
      .filter(Boolean) as string[];
    const labId = (resultValues || []).find((rv: any) => rv.lab_id)?.lab_id || (await database.getCurrentUserLabId());
    const labOverridesMap: Record<string, any> = {};

    if (labId && analyteIds.length > 0) {
      const { data: labOverrides } = await database.labAnalytes.getByLabAndAnalyteIds(labId, Array.from(new Set(analyteIds)));
      (labOverrides || []).forEach((la: any) => {
        labOverridesMap[la.analyte_id] = la;
      });
    }

    // Analyze each result value
    for (const rv of resultValues || []) {
      try {
        // Skip if already has a flag and we're not overriding
        if (rv.flag && rv.flag_source === 'manual' && !options?.overrideExisting) {
          results.push({
            resultValueId: rv.id,
            originalFlag: rv.flag,
            newFlag: rv.flag,
            flagSource: 'manual',
            flagConfidence: 1,
            auditStatus: 'approved',
            changed: false
          });
          continue;
        }

        // Build analyte context from joined data
        const labOverride = rv.analyte_id ? labOverridesMap[rv.analyte_id] : undefined;
        const baseAnalyte: AnalyteContext | undefined = rv.analytes ? {
          id: rv.analytes.id,
          name: rv.analytes.name,
          unit: rv.analytes.unit,
          reference_range: rv.analytes.reference_range,
          reference_range_male: rv.analytes.reference_range_male,
          reference_range_female: rv.analytes.reference_range_female,
          low_critical: rv.analytes.low_critical,
          high_critical: rv.analytes.high_critical,
          value_type: rv.analytes.value_type,
          expected_normal_values: rv.analytes.expected_normal_values,
          interpretation_low: rv.analytes.interpretation_low,
          interpretation_normal: rv.analytes.interpretation_normal,
          interpretation_high: rv.analytes.interpretation_high,
          flag_rules: rv.analytes.flag_rules
        } : undefined;
        const analyteContext = mergeAnalyteWithLabOverride(baseAnalyte, labOverride) || baseAnalyte;

        // Build enriched snapshot for PDF template persistence
        const enrichedSnapshot: EnrichedAnalyteSnapshot = {
          normal_range_min: labOverride?.normal_range_min ?? null,
          normal_range_max: labOverride?.normal_range_max ?? null,
          low_critical: analyteContext?.low_critical ?? null,
          high_critical: analyteContext?.high_critical ?? null,
          reference_range_male: analyteContext?.reference_range_male ?? null,
          reference_range_female: analyteContext?.reference_range_female ?? null,
          method: labOverride?.lab_specific_method || labOverride?.method || rv.analytes?.method || null,
          value_type: analyteContext?.value_type ?? null,
        };

        const result = await analyzeResultValue(
          {
            id: rv.id,
            value: rv.value,
            unit: rv.unit,
            reference_range: rv.reference_range,
            flag: rv.flag,
            analyte_id: rv.analyte_id
          },
          analyteContext,
          patient
        );

        // Attach enriched snapshot so applyFlagAnalysis can persist it
        result.enrichedSnapshot = enrichedSnapshot;

        results.push(result);
      } catch (error) {
        errors.push({
          resultValueId: rv.id,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }

    return {
      results,
      totalProcessed: results.length,
      flagsChanged: results.filter(r => r.changed).length,
      errors
    };
  } catch (error) {
    console.error('Error analyzing order results:', error);
    throw error;
  }
}

/**
 * Apply AI flag analysis results to database
 * Updates result_values with new flags and creates audit records
 */
export async function applyFlagAnalysis(
  analysisResults: AIFlagAnalysisResult[],
  options?: {
    onlyChanged?: boolean;
    createAudit?: boolean;
  }
): Promise<{ success: number; failed: number }> {
  const updates = analysisResults
    .filter(r => !options?.onlyChanged || r.changed || r.enrichedSnapshot)
    .map(r => ({
      id: r.resultValueId,
      flag: r.newFlag?.substring(0, 10), // Truncate to 10 chars for DB constraint
      flag_source: r.flagSource as any,
      flag_confidence: r.flagConfidence,
      ai_interpretation: r.interpretation,
      ai_audit_status: r.auditStatus as any,
      // Update reference_range to the gender-resolved range so display matches the flag
      // Use !== undefined so that an explicit empty string (lab override cleared range) also gets written
      ...(r.resolvedReferenceRange !== undefined ? { reference_range: r.resolvedReferenceRange } : {}),
      // Enriched analyte snapshot fields for PDF template
      ...(r.enrichedSnapshot ? {
        normal_range_min: r.enrichedSnapshot.normal_range_min,
        normal_range_max: r.enrichedSnapshot.normal_range_max,
        low_critical: r.enrichedSnapshot.low_critical,
        high_critical: r.enrichedSnapshot.high_critical,
        reference_range_male: r.enrichedSnapshot.reference_range_male,
        reference_range_female: r.enrichedSnapshot.reference_range_female,
        method: r.enrichedSnapshot.method,
        value_type: r.enrichedSnapshot.value_type,
      } : {})
    }));

  const result = await database.resultValues.bulkUpdateWithAIFlags(updates);

  // Create audit records if requested (BATCH OPTIMIZED)
  if (options?.createAudit) {
    const changedResults = analysisResults.filter(r => r.changed);
    
    if (changedResults.length > 0) {
      try {
        // Batch fetch all result values at once (single query)
        const resultValueIds = changedResults.map(r => r.resultValueId);
        const { data: resultValues, error: fetchError } = await supabase
          .from('result_values')
          .select('id, value, result_id, order_id, analyte_id, lab_id')
          .in('id', resultValueIds);
        
        if (fetchError) {
          console.error('Failed to fetch result values for audit:', fetchError);
        } else if (resultValues && resultValues.length > 0) {
          // Build audit records in memory
          const auditRecords = changedResults
            .map(change => {
              const rv = resultValues.find(r => r.id === change.resultValueId);
              if (!rv) return null;
              
              return {
                result_value_id: change.resultValueId,
                original_value: rv.value || '',
                auto_determined_flag: change.originalFlag || null,
                auto_flag_source: change.flagSource,
                ai_suggested_flag: change.flagSource === 'ai' ? change.newFlag : null,
                final_flag: change.newFlag || null,
                auto_confidence: change.flagConfidence,
                ai_confidence: change.flagSource === 'ai' ? change.flagConfidence : null,
                resolution_notes: change.auditNotes,
                ai_reasoning: change.interpretation,
                result_id: rv.result_id,
                order_id: rv.order_id,
                analyte_id: rv.analyte_id,
                lab_id: rv.lab_id
              };
            })
            .filter((record): record is NonNullable<typeof record> => record !== null);
          
          // Batch insert all audit records (single query)
          if (auditRecords.length > 0) {
            const { error: insertError } = await supabase
              .from('ai_flag_audits')
              .insert(auditRecords);
            
            if (insertError) {
              console.error('Failed to batch insert audit records:', insertError);
            }
          }
        }
      } catch (error) {
        console.error('Failed to create audit records:', error);
      }
    }
  }

  return result;
}

/**
 * Run full AI flag analysis for an order
 * This is the main entry point called after result values are saved
 * 
 * Flow:
 * 1. First tries rule-based flag determination (fast, no API call)
 * 2. If any results have null flag OR null interpretation, auto-calls AI service
 * 3. Updates database with flags and interpretations
 */
export async function runAIFlagAnalysis(
  orderId: string,
  options?: {
    overrideManual?: boolean;
    applyToDatabase?: boolean;
    createAudit?: boolean;
    patientContext?: PatientContext;
    useAIService?: boolean; // If true, forces AI service call; if false, skips AI; if undefined, auto-decides
    forceAI?: boolean; // Deprecated, use useAIService
  }
): Promise<BatchAnalysisResult> {
  const defaultOptions = {
    overrideManual: false,
    applyToDatabase: true,
    createAudit: true,
    useAIService: undefined as boolean | undefined, // Auto-decide by default
    ...options
  };

  // Analyze all result values using rule-based logic
  const analysisResult = await analyzeOrderResults(orderId, {
    overrideExisting: defaultOptions.overrideManual,
    patientContext: defaultOptions.patientContext
  });

  // Determine if we should call AI service
  // Auto-call AI if: flag is null/empty OR interpretation is null/empty (and useAIService is not explicitly false)
  const needsAI = defaultOptions.useAIService === true || (
    defaultOptions.useAIService !== false &&
    analysisResult.results.some(r => !r.newFlag || !r.interpretation)
  );

  // Call AI service for enhanced interpretation
  if (needsAI && analysisResult.results.length > 0) {
    try {
      console.log('[AI Flag] Auto-running AI service - found results with null flag/interpretation');
      
      // Fetch result values for AI service
      const { data: resultValues } = await database.resultValues.getForOrderWithFlags(orderId);
      
      if (resultValues && resultValues.length > 0) {
        const analyteIds = resultValues.map((rv: any) => rv.analyte_id).filter(Boolean) as string[];
        const labId = resultValues.find((rv: any) => rv.lab_id)?.lab_id || (await database.getCurrentUserLabId());
        const labOverridesMap: Record<string, any> = {};

        // Fetch lab flag options for AI context
        let labFlagOptions: LabFlagOption[] | undefined;
        if (labId) {
          const { data: labData } = await supabase.from('labs').select('flag_options').eq('id', labId).single();
          if (labData?.flag_options && Array.isArray(labData.flag_options) && labData.flag_options.length > 0) {
            labFlagOptions = labData.flag_options as LabFlagOption[];
          }
        }

        if (labId && analyteIds.length > 0) {
          const { data: labOverrides } = await database.labAnalytes.getByLabAndAnalyteIds(labId, Array.from(new Set(analyteIds)));
          (labOverrides || []).forEach((la: any) => {
            labOverridesMap[la.analyte_id] = la;
          });
        }

        // Only send results that need AI enhancement (null flag or null interpretation)
        const resultsNeedingAI = resultValues.filter(rv => {
          const ruleResult = analysisResult.results.find(r => r.resultValueId === rv.id);
          return !ruleResult?.newFlag || !ruleResult?.interpretation;
        });

        // If all have flags and interpretations already, still run AI if explicitly requested
        const toProcess = (defaultOptions.useAIService === true ? resultValues : resultsNeedingAI).map(rv => {
          const labOverride = rv.analyte_id ? labOverridesMap[rv.analyte_id] : undefined;
          if (!labOverride) return rv;

          return {
            ...rv,
            reference_range: labOverride.lab_specific_reference_range || labOverride.reference_range || rv.reference_range,
            reference_range_male:
              labOverride.lab_specific_reference_range_male || labOverride.reference_range_male || rv.reference_range_male,
            reference_range_female:
              labOverride.lab_specific_reference_range_female || labOverride.reference_range_female || rv.reference_range_female,
            low_critical: labOverride.lab_specific_low_critical || labOverride.low_critical || rv.low_critical,
            high_critical: labOverride.lab_specific_high_critical || labOverride.high_critical || rv.high_critical,
            analytes: {
              ...(rv.analytes || {}),
              reference_range: labOverride.lab_specific_reference_range || labOverride.reference_range || rv.analytes?.reference_range,
              reference_range_male:
                labOverride.lab_specific_reference_range_male || labOverride.reference_range_male || rv.analytes?.reference_range_male,
              reference_range_female:
                labOverride.lab_specific_reference_range_female || labOverride.reference_range_female || rv.analytes?.reference_range_female,
              low_critical: labOverride.lab_specific_low_critical || labOverride.low_critical || rv.analytes?.low_critical,
              high_critical: labOverride.lab_specific_high_critical || labOverride.high_critical || rv.analytes?.high_critical,
              expected_normal_values: labOverride.expected_normal_values || rv.analytes?.expected_normal_values,
              value_type: labOverride.value_type || rv.analytes?.value_type,
              flag_rules: labOverride.flag_rules || rv.analytes?.flag_rules,
              ref_range_knowledge: labOverride.ref_range_knowledge || rv.analytes?.ref_range_knowledge,
            }
          };
        });

        if (toProcess.length > 0) {
          
          // --------------- DYNAMIC RANGE RESOLUTION START ---------------
          // If we have "Age-specific" or placeholder ranges, resolve them FIRST
          // using the referenceRangeService (which consults Knowledge Base + Patient Context)
          try {
            // SAFEGUARD: Ensure test_group_id is present (some queries might omit it)
            if (toProcess.some(rv => !rv.test_group_id)) {
               console.log('[AI Flag] Some results missing test_group_id, re-fetching...');
               const { data: dbRvs } = await supabase
                  .from('result_values')
                  .select('id, test_group_id')
                  .eq('order_id', orderId);
               
               if (dbRvs) {
                  toProcess.forEach(rv => {
                     if (!rv.test_group_id) {
                        const match = dbRvs.find(d => d.id === rv.id);
                        if (match) rv.test_group_id = match.test_group_id;
                     }
                  });
               }
            }

            // Group by test group ID for batch resolution
            const rvsByGroup: Record<string, typeof toProcess> = {};
            toProcess.forEach(rv => {
              // Ensure we have a test_group_id (fetched from DB)
              // @ts-ignore - test_group_id exists on the DB record even if not in type
              const tgId = rv.test_group_id; 
              if (tgId) {
                if (!rvsByGroup[tgId]) rvsByGroup[tgId] = [];
                rvsByGroup[tgId].push(rv);
              }
            });

            // Process each group
            const aiRangeEnabledGroupIds = new Set<string>();
            const groupIds = Object.keys(rvsByGroup);
            if (groupIds.length > 0) {
              const { data: aiRangeGroups } = await supabase
                .from('test_groups')
                .select('id, ref_range_ai_config')
                .in('id', groupIds);
              for (const group of aiRangeGroups || []) {
                if (group.ref_range_ai_config?.enabled === true) aiRangeEnabledGroupIds.add(group.id);
              }
            }

            for (const [tgId, groupRvs] of Object.entries(rvsByGroup)) {
               // Resolve only when the test group has AI reference ranges enabled,
               // or when a saved range is a dynamic placeholder ("Age-specific").
               // A blank range is left blank — see isDynamicPlaceholderRange.
               const aiEnabledForGroup = aiRangeEnabledGroupIds.has(tgId);
               const needsResolution = aiEnabledForGroup || groupRvs.some(rv =>
                 isDynamicPlaceholderRange(rv.reference_range)
               );

               if (needsResolution) {
                 console.log(`[AI Flag] 🔍 Resolving dynamic ranges for Test Group ${tgId}...`);
                 
                 // Call the Edge Function
                 const analytesPayload = groupRvs.map(rv => ({
                   id: rv.analyte_id || '',
                   lab_analyte_id: rv.lab_analyte_id || null,
                   name: rv.parameter || '',
                   value: rv.value,
                   unit: rv.unit || ''
                 }));

                 const resolved = await resolveReferenceRanges(orderId, tgId, analytesPayload);
                 
                 if (resolved) {
                   let updatedCount = 0;
                   // Apply back to the resultValues arrays (IN MEMORY) so AI gets '13.5-17.5' instead of 'Age-specific'
                   resolved.forEach(res => {
                    if (res.used_reference_range) {
                      const match = groupRvs.find(rv => findResolvedReferenceRange([res], rv));
                      // With the group toggle off, only the analytes carrying a
                      // dynamic placeholder may be filled — never the blank ones.
                      if (match && !aiEnabledForGroup && !isDynamicPlaceholderRange(match.reference_range)) return;
                      if (match && match.reference_range !== res.used_reference_range) {
                        console.log(`[AI Flag] ✅ Resolved Range for ${match.parameter}: "${match.reference_range}" -> "${res.used_reference_range}"`);
                        match.reference_range = res.used_reference_range;
                        const ruleResult = analysisResult.results.find(r => r.resultValueId === match.id);
                        if (ruleResult) ruleResult.resolvedReferenceRange = res.used_reference_range;
                        
                        // Persist the resolved range to the database so it displays correctly in UI/Reports
                        supabase.from('result_values')
                          .update({ reference_range: res.used_reference_range })
                          .eq('id', match.id)
                          .then(({ error }) => {
                            if (error) console.error('[AI Flag] ❌ Failed to save resolved range to DB:', error);
                            else console.log(`[AI Flag] 💾 Saved resolved range to DB for ${match.parameter}`);
                          });
                          
                        updatedCount++;
                      }
                    }
                   });
                   console.log(`[AI Flag] Updated ${updatedCount} ranges with dynamic values.`);
                 }
               }
            }
          } catch (resErr) {
            console.warn('[AI Flag] ⚠️ Dynamic range resolution failed (continuing with generic ranges):', resErr);
          }
          // --------------- DYNAMIC RANGE RESOLUTION END ---------------

          const aiInput = toProcess.map(rv => ({
            id: rv.id,
            parameter: rv.parameter,
            value: rv.value,
            unit: rv.unit,
            reference_range: rv.reference_range,
            lab_id: rv.lab_id,
            ref_range_knowledge: rv.analytes?.ref_range_knowledge,
            reference_range_male: rv.analytes?.reference_range_male,
            reference_range_female: rv.analytes?.reference_range_female,
            low_critical: rv.analytes?.low_critical,
            high_critical: rv.analytes?.high_critical,
            current_flag: rv.flag
          }));

          const aiResults = await callAIFlagService(aiInput, defaultOptions.patientContext, undefined, labFlagOptions);

          // Merge AI results with rule-based results
          if (aiResults) {
            console.log('[AI Flag] AI service returned results:', aiResults.length);
            for (const aiResult of aiResults) {
              const ruleResult = analysisResult.results.find(r => r.resultValueId === aiResult.id);
              if (ruleResult) {
                // AI provides flag if rule-based didn't have one
                if (!ruleResult.newFlag && aiResult.flag) {
                  ruleResult.newFlag = aiResult.flag;
                  ruleResult.flagSource = 'ai';
                  ruleResult.flagConfidence = aiResult.flag_confidence;
                  ruleResult.changed = ruleResult.originalFlag !== aiResult.flag;
                }
                // AI provides interpretation if rule-based didn't have one OR AI has higher confidence
                if (aiResult.interpretation && (!ruleResult.interpretation || aiResult.flag_confidence > 0.8)) {
                  ruleResult.interpretation = aiResult.interpretation;
                  if (aiResult.flag_confidence > ruleResult.flagConfidence) {
                    ruleResult.flagSource = 'ai';
                    ruleResult.flagConfidence = aiResult.flag_confidence;
                  }
                }
              }
            }
          }
        }
      }
    } catch (aiError) {
      console.warn('[AI Flag] AI service enhancement failed, using rule-based results:', aiError);
      // Continue with rule-based results
    }
  }

  // Apply to database if requested
  if (defaultOptions.applyToDatabase && analysisResult.results.length > 0) {
    await applyFlagAnalysis(analysisResult.results, {
      onlyChanged: !defaultOptions.overrideManual,
      createAudit: defaultOptions.createAudit
    });
  }

  return analysisResult;
}

/**
 * Analyze a single result value and save to database
 * Called after individual result value save/update
 */
export async function analyzeAndSaveFlag(
  resultValueId: string,
  value: string,
  analyteId?: string,
  patientContext?: PatientContext
): Promise<AIFlagAnalysisResult> {
  // Build minimal context
  const resultValue: ResultValueContext = {
    id: resultValueId,
    value,
    analyte_id: analyteId
  };

  // Run analysis
  const result = await analyzeResultValue(resultValue, undefined, patientContext);

  // Save to database
  if (result.changed || result.newFlag) {
    await database.resultValues.updateWithAIFlag(resultValueId, {
      flag: result.newFlag,
      flag_source: result.flagSource as any, // Cast to match DB expected type if different
      flag_confidence: result.flagConfidence,
      ai_interpretation: result.interpretation,
      ai_audit_status: result.auditStatus as any, // Cast to match DB expected type
      ai_audit_notes: result.auditNotes
    });
  }

  return result;
}

// ============================================================================
// Exports
// ============================================================================

export default {
  analyzeResultValue,
  analyzeOrderResults,
  applyFlagAnalysis,
  runAIFlagAnalysis,
  analyzeAndSaveFlag
};
