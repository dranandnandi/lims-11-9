/**
 * Calculation Engine for LIMS v2
 * 
 * Handles formula-based calculated parameters for analytes.
 * Uses mathjs for safe formula evaluation (no eval).
 * 
 * Features:
 * - Safe mathematical expression evaluation
 * - Dependency tracking for recalculation triggers
 * - Circular dependency prevention (validated at DB level)
 * - Patient data injection (age, gender) for eGFR-like formulas
 */

import { evaluate, round } from 'mathjs';
import { FALLBACK_DECIMAL_PLACES, normalizeDecimalPlaces } from './resultValueFormat';
import { supabase } from './supabase';
import { selectPreferredCalculatedDependencies } from './calculatedDependencies';
import { evaluateTextCalculation, normalizeCalculationResultType } from './calculationRules';

// ============================================
// TYPES
// ============================================

export interface CalculatedAnalyte {
  id: string;
  name: string;
  formula: string;
  formula_variables: string[];
  formula_description?: string;
  calculation_result_type?: 'numeric' | 'text';
  value_type?: string;
  /** Report precision for this analyte: null = inherit (2 dp), 0 = round to integer. */
  decimal_places?: number | null;
  unit?: string;
  reference_range?: string;
  category?: string;
}

export interface AnalyteDependency {
  source_analyte_id: string;
  source_lab_analyte_id?: string | null;
  source_name: string;
  variable_name: string;
}

export interface ResultValue {
  id?: string;
  analyte_id?: string;
  lab_analyte_id?: string | null;
  parameter: string;
  value: string;
  unit?: string;
  reference_range?: string;
  flag?: string;
  is_auto_calculated?: boolean;
  calculation_inputs?: Record<string, number>;
  calculated_at?: string;
}

export interface PatientData {
  age: number;
  gender: 'Male' | 'Female' | 'Other';
  weight_kg?: number;
  height_cm?: number;
  ethnicity?: string;
}

export interface CalculationResult {
  analyte_id: string;
  lab_analyte_id?: string | null;
  parameter: string;
  value: string;
  unit?: string;
  reference_range?: string;
  is_auto_calculated: true;
  calculation_inputs: Record<string, number>;
  calculated_at: string;
  formula_used: string;
  success: boolean;
  error?: string;
}

// ============================================
// CALCULATION ENGINE
// ============================================

export const calculationEngine = {
  /**
   * Fetch all calculated analytes for a test group
   */
  async getCalculatedAnalytesForTestGroup(testGroupId: string): Promise<CalculatedAnalyte[]> {
    const { data, error } = await supabase
      .from('test_group_analytes')
      .select(`
        lab_analyte_id,
        analytes!inner(
          id,
          name,
          formula,
          formula_variables,
          formula_description,
          calculation_result_type,
          value_type,
          decimal_places,
          unit,
          reference_range,
          category,
          is_calculated
        ),
        lab_analytes(
          id,
          formula,
          formula_variables,
          calculation_result_type,
          value_type,
          decimal_places,
          unit,
          reference_range,
          lab_specific_reference_range,
          is_calculated
        )
      `)
      .eq('test_group_id', testGroupId);

    if (error || !data) return [];

    return data.map((item: any) => {
      const a = item.analytes;
      const la = item.lab_analyte_id ? item.lab_analytes : null;
      return {
        id: a.id,
        lab_analyte_id: item.lab_analyte_id || la?.id || null,
        name: a.name,
        formula: la?.formula ?? a.formula,
        formula_variables: la?.formula_variables ?? a.formula_variables ?? [],
        formula_description: a.formula_description,
        calculation_result_type: normalizeCalculationResultType(la?.calculation_result_type ?? a.calculation_result_type),
        value_type: la?.value_type ?? a.value_type,
        decimal_places: la?.decimal_places ?? a.decimal_places ?? null,
        unit: la?.unit ?? a.unit,
        reference_range: la?.lab_specific_reference_range ?? la?.reference_range ?? a.reference_range,
        category: a.category
      };
    }).filter((item: any) => !!item.formula);
  },

  /**
   * Fetch dependencies for a calculated analyte
   */
  async getDependencies(
    calculatedAnalyteId: string,
    labId?: string,
    calculatedLabAnalyteId?: string | null,
  ): Promise<AnalyteDependency[]> {
    let query = supabase
      .from('analyte_dependencies')
      .select(`
        source_analyte_id,
        source_lab_analyte_id,
        variable_name,
        analytes!analyte_dependencies_source_analyte_id_fkey(name),
        source_lab_analyte:lab_analytes!analyte_dependencies_source_lab_analyte_id_fkey(name)
      `);

    if (calculatedLabAnalyteId) {
      query = query.or(
        `calculated_lab_analyte_id.eq.${calculatedLabAnalyteId},and(calculated_lab_analyte_id.is.null,calculated_analyte_id.eq.${calculatedAnalyteId})`,
      );
    } else {
      query = query.eq('calculated_analyte_id', calculatedAnalyteId);
    }

    if (labId) {
      query = query.or(`lab_id.eq.${labId},lab_id.is.null`);
    }

    const { data, error } = await query;

    if (error || !data) return [];

    return data.map((item: any) => ({
      source_analyte_id: item.source_analyte_id,
      source_lab_analyte_id: item.source_lab_analyte_id || null,
      source_name: item.source_lab_analyte?.name || item.analytes?.name || '',
      variable_name: item.variable_name
    }));
  },

  /**
   * Compute all calculated values for a set of result values
   * Called after technician saves values or when a source value changes
   */
  async computeCalculatedValues(
    resultValues: ResultValue[],
    testGroupId: string,
    patientData?: PatientData,
    labId?: string,
  ): Promise<CalculationResult[]> {
    // 1. Get calculated analytes for this test group
    const calculatedAnalytes = await this.getCalculatedAnalytesForTestGroup(testGroupId);
    if (calculatedAnalytes.length === 0) return [];

    // 2. Build value map from entered results (use parameter name as key)
    const valueMap: Record<string, number> = {};
    
    // Map by parameter name (normalized)
    resultValues.forEach(rv => {
      if (rv.value && !isNaN(parseFloat(rv.value))) {
        // Store by both full name and potential variable name
        valueMap[rv.parameter.toUpperCase()] = parseFloat(rv.value);
        valueMap[rv.parameter] = parseFloat(rv.value);
        if (rv.analyte_id) valueMap[rv.analyte_id] = parseFloat(rv.value);
        if (rv.lab_analyte_id) valueMap[rv.lab_analyte_id] = parseFloat(rv.value);
      }
    });

    // Inject patient data if available
    if (patientData) {
      valueMap['AGE'] = patientData.age;
      valueMap['GENDER'] = patientData.gender === 'Male' ? 1 : (patientData.gender === 'Female' ? 0 : 0.5);
      valueMap['GENDER_MALE'] = patientData.gender === 'Male' ? 1 : 0;
      valueMap['GENDER_FEMALE'] = patientData.gender === 'Female' ? 1 : 0;
      if (patientData.weight_kg) valueMap['WEIGHT'] = patientData.weight_kg;
      if (patientData.height_cm) valueMap['HEIGHT'] = patientData.height_cm;
    }

    // 3. Pre-fetch dependencies for all calculated analytes and build a dependency graph
    const depsMap = new Map<string, AnalyteDependency[]>();
    for (const analyte of calculatedAnalytes) {
      const loadedDeps = await this.getDependencies(analyte.id, labId, analyte.lab_analyte_id);
      const deps = selectPreferredCalculatedDependencies(
        loadedDeps.map((dependency) => ({
          ...dependency,
          calculated_analyte_id: analyte.id,
          calculated_lab_analyte_id: analyte.lab_analyte_id,
        })),
        analyte.id,
        analyte.lab_analyte_id,
        new Set(Object.keys(valueMap)),
      );
      depsMap.set(analyte.id, deps);
    }

    // 4. Topological sort: calculated params that depend on other calculated params
    //    must be evaluated AFTER their dependencies (e.g., Globulin before A/G Ratio)
    const calculatedIdSet = new Set(calculatedAnalytes.map(a => a.id));
    const sorted: typeof calculatedAnalytes = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const analyteById = new Map(calculatedAnalytes.map(a => [a.id, a]));

    const visit = (analyte: (typeof calculatedAnalytes)[0]) => {
      if (visited.has(analyte.id)) return;
      if (visiting.has(analyte.id)) return; // cycle guard
      visiting.add(analyte.id);
      const deps = depsMap.get(analyte.id) || [];
      for (const dep of deps) {
        if (calculatedIdSet.has(dep.source_analyte_id)) {
          const srcAnalyte = analyteById.get(dep.source_analyte_id);
          if (srcAnalyte) visit(srcAnalyte);
        }
      }
      visiting.delete(analyte.id);
      visited.add(analyte.id);
      sorted.push(analyte);
    };
    for (const analyte of calculatedAnalytes) visit(analyte);

    // 5. Compute each calculated analyte in dependency order
    const results: CalculationResult[] = [];

    for (const analyte of sorted) {
      const deps = depsMap.get(analyte.id) || [];
      
      // Check if all required variables are present
      const scope: Record<string, number> = {};
      let allDepsPresent = true;
      
      for (const dep of deps) {
        const varName = dep.variable_name.toUpperCase();
        const sourceName = dep.source_name.toUpperCase();
        
        // Try to find value by variable name or source analyte name
        const value =
          (dep.source_lab_analyte_id ? valueMap[dep.source_lab_analyte_id] : undefined) ??
          valueMap[dep.source_analyte_id] ??
          valueMap[varName] ??
          valueMap[sourceName] ??
          valueMap[dep.variable_name] ??
          valueMap[dep.source_name];
        
        if (value === undefined || isNaN(value)) {
          allDepsPresent = false;
          break;
        }
        scope[dep.variable_name] = value;
      }

      // Also check formula_variables for patient data
      for (const varName of (analyte.formula_variables || [])) {
        if (scope[varName] === undefined) {
          const upperVar = varName.toUpperCase();
          if (valueMap[upperVar] !== undefined) {
            scope[varName] = valueMap[upperVar];
          }
        }
      }

      if (!allDepsPresent) {
        results.push({
          analyte_id: analyte.id,
          lab_analyte_id: analyte.lab_analyte_id || null,
          parameter: analyte.name,
          value: '',
          unit: analyte.unit,
          reference_range: analyte.reference_range,
          is_auto_calculated: true,
          calculation_inputs: scope,
          calculated_at: new Date().toISOString(),
          formula_used: analyte.formula,
          success: false,
          error: 'Missing required input values'
        });
        continue;
      }

      // 6. Evaluate formula using mathjs
      try {
        if (normalizeCalculationResultType(analyte.calculation_result_type) === 'text') {
          const textResult = evaluateTextCalculation(analyte.formula, scope);
          if (!textResult.success) {
            results.push({
              analyte_id: analyte.id,
              lab_analyte_id: analyte.lab_analyte_id || null,
              parameter: analyte.name,
              value: '',
              unit: analyte.unit,
              reference_range: analyte.reference_range,
              is_auto_calculated: true,
              calculation_inputs: scope,
              calculated_at: new Date().toISOString(),
              formula_used: analyte.formula,
              success: false,
              error: textResult.error || 'Text calculation failed'
            });
            continue;
          }

          results.push({
            analyte_id: analyte.id,
            lab_analyte_id: analyte.lab_analyte_id || null,
            parameter: analyte.name,
            value: textResult.value,
            unit: analyte.unit,
            reference_range: analyte.reference_range,
            is_auto_calculated: true,
            calculation_inputs: scope,
            calculated_at: new Date().toISOString(),
            formula_used: analyte.formula,
            success: true
          });
          continue;
        }

        // Normalize formula: replace x^y with pow(x,y) to avoid
        // mathjs operator precedence issues with negative/fractional exponents.
        // e.g. (x/0.9)^(-1.2) can mis-parse as (x/0.9)^1.2 * -1
        const normalizedFormula = analyte.formula.replace(
          /\(([^()]+)\)\s*\^\s*\(([^()]+)\)/g,
          'pow($1, $2)'
        ).replace(
          /([A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?)\s*\^\s*([A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?)/g,
          'pow($1, $2)'
        );
        const result = evaluate(normalizedFormula, scope);
        // Store at the analyte's configured precision so the entry console, the
        // portal and the PDF all agree. Unconfigured stays at 2 dp as before.
        const roundedResult = round(
          result,
          normalizeDecimalPlaces(analyte.decimal_places) ?? FALLBACK_DECIMAL_PLACES,
        );

        results.push({
          analyte_id: analyte.id,
          lab_analyte_id: analyte.lab_analyte_id || null,
          parameter: analyte.name,
          value: String(roundedResult),
          unit: analyte.unit,
          reference_range: analyte.reference_range,
          is_auto_calculated: true,
          calculation_inputs: scope,
          calculated_at: new Date().toISOString(),
          formula_used: analyte.formula,
          success: true
        });

        // Feed result back into valueMap so downstream calculated params can use it
        valueMap[analyte.name.toUpperCase()] = roundedResult;
        valueMap[analyte.name] = roundedResult;
        valueMap[analyte.id] = roundedResult;
        if (analyte.lab_analyte_id) valueMap[analyte.lab_analyte_id] = roundedResult;
      } catch (err: any) {
        results.push({
          analyte_id: analyte.id,
          lab_analyte_id: analyte.lab_analyte_id || null,
          parameter: analyte.name,
          value: '',
          unit: analyte.unit,
          reference_range: analyte.reference_range,
          is_auto_calculated: true,
          calculation_inputs: scope,
          calculated_at: new Date().toISOString(),
          formula_used: analyte.formula,
          success: false,
          error: err.message || 'Formula evaluation failed'
        });
      }
    }

    return results;
  },

  /**
   * Save calculated values to result_values table
   */
  async saveCalculatedValues(
    resultId: string,
    orderId: string,
    testGroupId: string,
    labId: string,
    calculations: CalculationResult[]
  ): Promise<{ success: boolean; error?: string }> {
    const successfulCalcs = calculations.filter(c => c.success);
    if (successfulCalcs.length === 0) {
      return { success: true }; // Nothing to save
    }

    const upsertData = successfulCalcs.map(calc => ({
      result_id: resultId,
      order_id: orderId,
      test_group_id: testGroupId,
      lab_id: labId,
      analyte_id: calc.analyte_id,
      lab_analyte_id: calc.lab_analyte_id || null,
      parameter: calc.parameter,
      value: calc.value,
      unit: calc.unit || '',
      reference_range: calc.reference_range || '',
      is_auto_calculated: true,
      calculation_inputs: calc.calculation_inputs,
      calculated_at: calc.calculated_at,
      verify_status: 'pending'
    }));

    // Upsert to handle recalculations
    const { error } = await supabase
      .from('result_values')
      .upsert(upsertData, {
        onConflict: 'result_id,analyte_id',
        ignoreDuplicates: false
      });

    if (error) {
      console.error('Failed to save calculated values:', error);
      return { success: false, error: error.message };
    }

    return { success: true };
  },

  /**
   * Trigger recalculation when a source value changes
   * Called by result entry/verification components
   */
  async triggerRecalculation(
    resultId: string,
    orderId: string,
    testGroupId: string,
    labId: string,
    patientData?: PatientData
  ): Promise<CalculationResult[]> {
    // Fetch current result values
    const { data: currentValues, error } = await supabase
      .from('result_values')
      .select('*')
      .eq('result_id', resultId)
      .eq('is_auto_calculated', false); // Only get manually entered values

    if (error) {
      console.error('Failed to fetch current values for recalculation:', error);
      return [];
    }

    const resultValues: ResultValue[] = (currentValues || []).map((rv: any) => ({
      id: rv.id,
      analyte_id: rv.analyte_id,
      lab_analyte_id: rv.lab_analyte_id || null,
      parameter: rv.parameter,
      value: rv.value,
      unit: rv.unit,
      reference_range: rv.reference_range,
      flag: rv.flag
    }));

    // Compute new calculated values
    const calculations = await this.computeCalculatedValues(resultValues, testGroupId, patientData, labId);

    // Save successful calculations
    await this.saveCalculatedValues(resultId, orderId, testGroupId, labId, calculations);

    return calculations;
  },

  /**
   * Check if an analyte has dependents (other calculated analytes that use it)
   * Used to determine if recalculation is needed when a value changes
   */
  async hasDependents(analyteId: string, labId?: string): Promise<boolean> {
    let query = supabase
      .from('analyte_dependencies')
      .select('*', { count: 'exact', head: true })
      .eq('source_analyte_id', analyteId);

    if (labId) {
      query = query.or(`lab_id.eq.${labId},lab_id.is.null`);
    }

    const { count, error } = await query;

    return !error && (count || 0) > 0;
  },

  /**
   * Get all analytes that depend on a given analyte
   * Used for cascade recalculation
   */
  async getDependentAnalytes(sourceAnalyteId: string, labId?: string): Promise<string[]> {
    let query = supabase
      .from('analyte_dependencies')
      .select('calculated_analyte_id')
      .eq('source_analyte_id', sourceAnalyteId);

    if (labId) {
      query = query.or(`lab_id.eq.${labId},lab_id.is.null`);
    }

    const { data, error } = await query;

    if (error || !data) return [];
    return data.map(d => d.calculated_analyte_id);
  }
};

// ============================================
// COMMON MEDICAL FORMULAS (Reference)
// ============================================

/**
 * Example formulas that can be stored in analytes.formula:
 * 
 * LDL Cholesterol (Friedewald):
 *   formula: "TC - HDL - (TG / 5)"
 *   variables: ["TC", "HDL", "TG"]
 *   Note: Only valid when TG < 400 mg/dL
 * 
 * MCHC:
 *   formula: "(HGB / HCT) * 100"
 *   variables: ["HGB", "HCT"]
 * 
 * A/G Ratio:
 *   formula: "ALB / GLOB"
 *   variables: ["ALB", "GLOB"]
 *   Note: GLOB = Total Protein - Albumin
 * 
 * eGFR (CKD-EPI simplified for demo):
 *   formula: "142 * (CREAT / 0.9) ^ (-1.2) * 0.9938 ^ AGE * (GENDER_FEMALE == 1 ? 1.012 : 1)"
 *   variables: ["CREAT", "AGE", "GENDER_FEMALE"]
 *   Note: Actual CKD-EPI is more complex
 * 
 * Non-HDL Cholesterol:
 *   formula: "TC - HDL"
 *   variables: ["TC", "HDL"]
 * 
 * VLDL Cholesterol:
 *   formula: "TG / 5"
 *   variables: ["TG"]
 * 
 * Corrected Calcium:
 *   formula: "CA + 0.8 * (4 - ALB)"
 *   variables: ["CA", "ALB"]
 */

export default calculationEngine;
