// Server-side evaluation of formula (calculated) analytes for analyzer results.
//
// Until now formulas were only ever evaluated in the browser:
//   - src/utils/calculationEngine.ts        (result entry screen)
//   - ResultVerificationConsole.recalculatePanel (only recomputes rows that
//     ALREADY exist in result_values)
// That meant an order filled entirely by the analyzer interface never produced
// rows for its calculated analytes, so they stayed "missing" on the order and
// never reached the verification console.
//
// This module ports the same semantics (mathjs evaluation, lab-specific formula
// override, dependency preference, topological ordering) so process-analyzer-result
// can materialise those rows itself. Kept behaviourally in step with
// src/utils/calculationEngine.ts, src/utils/calculationRules.ts and
// src/utils/calculatedDependencies.ts — change them together.

import { evaluate, round } from 'npm:mathjs@15'

/**
 * Decimals to store for a calculated value. Mirrors normalizeDecimalPlaces in
 * src/utils/resultValueFormat.ts: 0 means integer and must stay distinct from
 * null ("inherit"), which keeps the historical 2 dp.
 */
function resolveStoredDecimalPlaces(configured: unknown): number {
  if (configured === null || configured === undefined || configured === '') return 2
  const parsed = typeof configured === 'number' ? configured : Number(configured)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 6) return 2
  return parsed
}

// ─────────────────────────────────────────────────────────────────────────────
// Text calculations — ported from src/utils/calculationRules.ts
// ─────────────────────────────────────────────────────────────────────────────

type CalculationResultType = 'numeric' | 'text'

export function normalizeCalculationResultType(value: unknown): CalculationResultType {
  const normalized = String(value || '').trim().toLowerCase()
  return normalized === 'text' || normalized === 'rule_based_text' ? 'text' : 'numeric'
}

function coerceRules(formula: string): { rules: Array<{ when?: string; value?: string; result?: string }>; defaultValue: string } | null {
  const trimmed = formula.trim()
  if (!trimmed) return null

  try {
    const parsed = JSON.parse(trimmed)
    if (Array.isArray(parsed)) return { rules: parsed, defaultValue: '' }
    if (parsed && typeof parsed === 'object') {
      const rules = Array.isArray(parsed.rules) ? parsed.rules : []
      const defaultValue =
        typeof parsed.default === 'string'
          ? parsed.default
          : typeof parsed.defaultValue === 'string'
            ? parsed.defaultValue
            : ''
      return { rules, defaultValue }
    }
  } catch {
    // JSON is preferred; the "condition => value" line format is accepted below.
  }

  const rules = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [when, ...valueParts] = line.split(/\s*=>\s*/)
      return { when, value: valueParts.join('=>') }
    })
    .filter((rule) => rule.when && rule.value)

  return rules.length > 0 ? { rules, defaultValue: '' } : null
}

function resolveCondition(condition: string, scope: Record<string, number>): string | null {
  let resolved = condition
    .replace(/\bAND\b/gi, '&&')
    .replace(/\bOR\b/gi, '||')
    .replace(/\bNOT\b/gi, '!')

  const tokens = resolved.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) || []
  for (const token of tokens) {
    const value = scope[token] ?? scope[token.toUpperCase()] ?? scope[token.toLowerCase()]
    if (value === undefined || !Number.isFinite(value)) return null
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    resolved = resolved.replace(new RegExp(`\\b${escaped}\\b`, 'g'), String(value))
  }

  if (!/^[0-9+\-*/().\s<>=!&|]+$/.test(resolved)) return null
  return resolved
}

function evaluateCondition(condition: string, scope: Record<string, number>): boolean | null {
  const resolved = resolveCondition(condition, scope)
  if (!resolved) return null
  try {
    return Boolean(Function(`"use strict"; return (${resolved});`)())
  } catch {
    return null
  }
}

function evaluateTextCalculation(formula: string, scope: Record<string, number>): { success: boolean; value: string; error?: string } {
  const parsed = coerceRules(formula)
  if (!parsed) {
    return { success: false, value: '', error: 'Text calculation rules must be valid JSON or condition => value lines' }
  }

  for (const rule of parsed.rules) {
    const condition = String(rule.when || '').trim()
    const value = typeof rule.value === 'string' ? rule.value : rule.result
    if (!condition || typeof value !== 'string') continue

    const matched = evaluateCondition(condition, scope)
    if (matched === true) return { success: true, value }
    if (matched === null) return { success: false, value: '', error: `Could not evaluate condition: ${condition}` }
  }

  return parsed.defaultValue
    ? { success: true, value: parsed.defaultValue }
    : { success: false, value: '', error: 'No text calculation rule matched' }
}

// ─────────────────────────────────────────────────────────────────────────────
// Dependency preference — ported from src/utils/calculatedDependencies.ts
// ─────────────────────────────────────────────────────────────────────────────

interface Dependency {
  calculated_analyte_id: string
  calculated_lab_analyte_id?: string | null
  source_analyte_id: string
  source_lab_analyte_id?: string | null
  source_name?: string
  variable_name: string
  lab_id?: string | null
}

function selectPreferredDependencies(
  dependencies: Dependency[],
  calculatedAnalyteId: string,
  calculatedLabAnalyteId: string | null,
  availableSourceIds: ReadonlySet<string>,
): Dependency[] {
  const exact = calculatedLabAnalyteId
    ? dependencies.filter((d) => d.calculated_lab_analyte_id === calculatedLabAnalyteId)
    : []
  const candidates = exact.length > 0
    ? exact
    : dependencies.filter((d) => !d.calculated_lab_analyte_id && d.calculated_analyte_id === calculatedAnalyteId)

  const preferredByVariable = new Map<string, Dependency>()
  for (const dependency of candidates) {
    const key = String(dependency.variable_name ?? '').trim().toUpperCase()
    const current = preferredByVariable.get(key)
    if (!current) {
      preferredByVariable.set(key, dependency)
      continue
    }
    const score = (row: Dependency) => {
      const sourceIsAvailable =
        availableSourceIds.has(row.source_analyte_id) ||
        (!!row.source_lab_analyte_id && availableSourceIds.has(row.source_lab_analyte_id))
      return (sourceIsAvailable ? 100 : 0) + (row.source_lab_analyte_id ? 10 : 0)
    }
    if (score(dependency) > score(current)) preferredByVariable.set(key, dependency)
  }

  return Array.from(preferredByVariable.values())
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export interface SourceValue {
  analyte_id: string
  lab_analyte_id?: string | null
  parameter: string
  value: string
}

export interface CalculatedResultRow {
  analyte_id: string
  lab_analyte_id: string | null
  test_group_id: string
  parameter: string
  value: string
  unit: string
  reference_range: string | null
  calculation_inputs: Record<string, number>
  formula_used: string
  /** Metadata so the caller can compute the flag with its own saved-range logic. */
  value_type: string | null
  low_critical: string | null
  high_critical: string | null
  expected_normal_values: unknown
}

export interface CalculatedSkip {
  parameter: string
  analyte_id: string
  reason: string
}

interface CalcAnalyte {
  analyte_id: string
  lab_analyte_id: string | null
  test_group_id: string
  name: string
  formula: string
  formula_variables: string[]
  calculation_result_type: CalculationResultType
  unit: string
  reference_range: string | null
  value_type: string | null
  /** Report precision: null = inherit (2 dp), 0 = round to integer. */
  decimal_places: number | null
  low_critical: string | null
  high_critical: string | null
  expected_normal_values: unknown
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter(Boolean).map(String)
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed.filter(Boolean).map(String) : []
    } catch {
      return []
    }
  }
  return []
}

/**
 * Load every calculated analyte belonging to the given test groups, evaluate the
 * ones whose inputs are all present in `sourceValues`, and return rows ready to
 * be written to result_values. Nothing is written here — the caller owns the
 * insert so it can apply its own flag/reference-range handling.
 */
export async function computeCalculatedResults(
  supabase: any,
  opts: {
    labId: string
    testGroupIds: string[]
    sourceValues: SourceValue[]
    patient?: { age?: number | null; gender?: string | null }
  },
): Promise<{ results: CalculatedResultRow[]; skipped: CalculatedSkip[] }> {
  const testGroupIds = [...new Set(opts.testGroupIds.filter(Boolean))]
  if (testGroupIds.length === 0) return { results: [], skipped: [] }

  // 1. Analytes belonging to these test groups
  const { data: tgaRows, error: tgaError } = await supabase
    .from('test_group_analytes')
    .select('analyte_id, lab_analyte_id, analyte_name, test_group_id')
    .in('test_group_id', testGroupIds)
    .not('is_header', 'is', true)

  if (tgaError || !tgaRows || tgaRows.length === 0) {
    if (tgaError) console.error('[calculated] failed to load test_group_analytes', tgaError)
    return { results: [], skipped: [] }
  }

  const analyteIds = [...new Set(tgaRows.map((r: any) => r.analyte_id).filter(Boolean))] as string[]
  const labAnalyteIds = [...new Set(tgaRows.map((r: any) => r.lab_analyte_id).filter(Boolean))] as string[]

  // 2. Global + lab-specific analyte definitions (lab-specific wins)
  const [{ data: globalRows }, { data: labRows }] = await Promise.all([
    analyteIds.length > 0
      ? supabase
          .from('analytes')
          .select('id, name, unit, reference_range, formula, formula_variables, calculation_result_type, value_type, decimal_places, is_calculated')
          .in('id', analyteIds)
      : Promise.resolve({ data: [] }),
    analyteIds.length > 0
      ? supabase
          .from('lab_analytes')
          .select('id, analyte_id, name, lab_specific_name, display_name, unit, lab_specific_unit, reference_range, lab_specific_reference_range, formula, formula_variables, calculation_result_type, value_type, decimal_places, is_calculated, low_critical, high_critical, expected_normal_values')
          .eq('lab_id', opts.labId)
          .in('analyte_id', analyteIds)
      : Promise.resolve({ data: [] }),
  ])

  const globalById = new Map<string, any>()
  for (const row of globalRows ?? []) globalById.set(row.id, row)

  const labById = new Map<string, any>()
  const labByAnalyteId = new Map<string, any>()
  for (const row of labRows ?? []) {
    labById.set(row.id, row)
    if (!labByAnalyteId.has(row.analyte_id)) labByAnalyteId.set(row.analyte_id, row)
  }

  // 3. Keep only the calculated ones that actually have a formula
  const calcAnalytes: CalcAnalyte[] = []
  const seen = new Set<string>()
  for (const tga of tgaRows) {
    const global = globalById.get(tga.analyte_id)
    const lab = (tga.lab_analyte_id ? labById.get(tga.lab_analyte_id) : null) ?? labByAnalyteId.get(tga.analyte_id) ?? null
    const isCalculated = lab?.is_calculated ?? global?.is_calculated ?? false
    const formula = lab?.formula ?? global?.formula ?? null
    if (!isCalculated || !formula) continue

    const key = `${tga.analyte_id}:${tga.lab_analyte_id ?? lab?.id ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)

    calcAnalytes.push({
      analyte_id: tga.analyte_id,
      lab_analyte_id: tga.lab_analyte_id ?? lab?.id ?? null,
      test_group_id: tga.test_group_id,
      name: tga.analyte_name || lab?.lab_specific_name || lab?.display_name || lab?.name || global?.name || 'Calculated',
      formula: String(formula),
      formula_variables: asStringArray(lab?.formula_variables ?? global?.formula_variables),
      calculation_result_type: normalizeCalculationResultType(lab?.calculation_result_type ?? global?.calculation_result_type),
      unit: lab?.lab_specific_unit || lab?.unit || global?.unit || '',
      reference_range: lab?.lab_specific_reference_range || lab?.reference_range || global?.reference_range || null,
      value_type: lab?.value_type ?? global?.value_type ?? null,
      decimal_places: lab?.decimal_places ?? global?.decimal_places ?? null,
      low_critical: lab?.low_critical ?? null,
      high_critical: lab?.high_critical ?? null,
      expected_normal_values: lab?.expected_normal_values ?? null,
    })
  }

  if (calcAnalytes.length === 0) return { results: [], skipped: [] }

  // 4. Value map — same key shapes the browser engine uses so shared formulas
  //    resolve identically (id, lab_analyte_id, parameter name, upper-cased name)
  const valueMap: Record<string, number> = {}
  for (const sv of opts.sourceValues) {
    const num = parseFloat(String(sv.value ?? ''))
    if (!Number.isFinite(num)) continue
    if (sv.parameter) {
      valueMap[sv.parameter] = num
      valueMap[sv.parameter.toUpperCase()] = num
    }
    if (sv.analyte_id) valueMap[sv.analyte_id] = num
    if (sv.lab_analyte_id) valueMap[sv.lab_analyte_id] = num
  }

  const age = Number(opts.patient?.age)
  if (Number.isFinite(age)) valueMap['AGE'] = age
  const gender = String(opts.patient?.gender ?? '').toLowerCase()
  if (gender) {
    valueMap['GENDER'] = gender.startsWith('m') ? 1 : gender.startsWith('f') ? 0 : 0.5
    valueMap['GENDER_MALE'] = gender.startsWith('m') ? 1 : 0
    valueMap['GENDER_FEMALE'] = gender.startsWith('f') ? 1 : 0
  }

  // 5. Dependencies (lab-specific preferred over global)
  const calcIds = [...new Set(calcAnalytes.map((a) => a.analyte_id))]
  const { data: rawDeps } = await supabase
    .from('analyte_dependencies')
    .select('calculated_analyte_id, calculated_lab_analyte_id, source_analyte_id, source_lab_analyte_id, variable_name, lab_id')
    .in('calculated_analyte_id', calcIds)
    .or(`lab_id.eq.${opts.labId},lab_id.is.null`)

  const allDeps: Dependency[] = (rawDeps ?? []) as Dependency[]

  // Source display names, so a formula variable can also be matched by name
  const srcAnalyteIds = [...new Set(allDeps.map((d) => d.source_analyte_id).filter(Boolean))] as string[]
  const srcLabAnalyteIds = [...new Set(allDeps.map((d) => d.source_lab_analyte_id).filter(Boolean))] as string[]
  const srcNameByAnalyteId = new Map<string, string>()
  const srcNameByLabAnalyteId = new Map<string, string>()
  if (srcAnalyteIds.length > 0) {
    const { data } = await supabase.from('analytes').select('id, name').in('id', srcAnalyteIds)
    for (const row of data ?? []) srcNameByAnalyteId.set(row.id, row.name)
  }
  if (srcLabAnalyteIds.length > 0) {
    const { data } = await supabase.from('lab_analytes').select('id, name, lab_specific_name').in('id', srcLabAnalyteIds)
    for (const row of data ?? []) srcNameByLabAnalyteId.set(row.id, row.lab_specific_name || row.name)
  }

  const availableSourceIds = new Set(Object.keys(valueMap))
  const depsByAnalyte = new Map<string, Dependency[]>()
  for (const analyte of calcAnalytes) {
    const deps = selectPreferredDependencies(allDeps, analyte.analyte_id, analyte.lab_analyte_id, availableSourceIds)
    depsByAnalyte.set(analyte.analyte_id, deps)
  }

  // 6. Topological order — a calculated analyte that feeds another must run first
  const calcIdSet = new Set(calcAnalytes.map((a) => a.analyte_id))
  const analyteById = new Map(calcAnalytes.map((a) => [a.analyte_id, a]))
  const sorted: CalcAnalyte[] = []
  const visited = new Set<string>()
  const visiting = new Set<string>()
  const visit = (analyte: CalcAnalyte) => {
    if (visited.has(analyte.analyte_id)) return
    if (visiting.has(analyte.analyte_id)) return // cycle guard
    visiting.add(analyte.analyte_id)
    for (const dep of depsByAnalyte.get(analyte.analyte_id) ?? []) {
      if (calcIdSet.has(dep.source_analyte_id)) {
        const src = analyteById.get(dep.source_analyte_id)
        if (src) visit(src)
      }
    }
    visiting.delete(analyte.analyte_id)
    visited.add(analyte.analyte_id)
    sorted.push(analyte)
  }
  for (const analyte of calcAnalytes) visit(analyte)

  // 7. Evaluate
  const results: CalculatedResultRow[] = []
  const skipped: CalculatedSkip[] = []

  for (const analyte of sorted) {
    const deps = depsByAnalyte.get(analyte.analyte_id) ?? []
    const scope: Record<string, number> = {}
    let missingVariable: string | null = null

    for (const dep of deps) {
      const varName = String(dep.variable_name ?? '')
      const sourceName =
        (dep.source_lab_analyte_id ? srcNameByLabAnalyteId.get(dep.source_lab_analyte_id) : null) ||
        srcNameByAnalyteId.get(dep.source_analyte_id) ||
        ''
      const value =
        (dep.source_lab_analyte_id ? valueMap[dep.source_lab_analyte_id] : undefined) ??
        valueMap[dep.source_analyte_id] ??
        valueMap[varName.toUpperCase()] ??
        valueMap[sourceName.toUpperCase()] ??
        valueMap[varName] ??
        valueMap[sourceName]

      if (value === undefined || !Number.isFinite(value)) {
        missingVariable = varName || sourceName || dep.source_analyte_id
        break
      }
      scope[varName] = value
    }

    if (missingVariable) {
      skipped.push({
        parameter: analyte.name,
        analyte_id: analyte.analyte_id,
        reason: `missing input ${missingVariable}`,
      })
      continue
    }

    // Patient variables referenced directly by the formula
    for (const varName of analyte.formula_variables) {
      if (scope[varName] === undefined && valueMap[varName.toUpperCase()] !== undefined) {
        scope[varName] = valueMap[varName.toUpperCase()]
      }
    }

    if (deps.length === 0 && Object.keys(scope).length === 0) {
      skipped.push({ parameter: analyte.name, analyte_id: analyte.analyte_id, reason: 'no dependencies configured' })
      continue
    }

    const base = {
      analyte_id: analyte.analyte_id,
      lab_analyte_id: analyte.lab_analyte_id,
      test_group_id: analyte.test_group_id,
      parameter: analyte.name,
      unit: analyte.unit,
      reference_range: analyte.reference_range,
      calculation_inputs: scope,
      formula_used: analyte.formula,
      value_type: analyte.value_type,
      low_critical: analyte.low_critical,
      high_critical: analyte.high_critical,
      expected_normal_values: analyte.expected_normal_values,
    }

    try {
      if (analyte.calculation_result_type === 'text') {
        const textResult = evaluateTextCalculation(analyte.formula, scope)
        if (!textResult.success) {
          skipped.push({ parameter: analyte.name, analyte_id: analyte.analyte_id, reason: textResult.error || 'text calculation failed' })
          continue
        }
        results.push({ ...base, value: textResult.value })
        continue
      }

      // Same exponent normalisation as the browser engine: mathjs mis-associates
      // (x/0.9)^(-1.2) style expressions, so rewrite them as pow(a, b).
      const normalizedFormula = analyte.formula
        .replace(/\(([^()]+)\)\s*\^\s*\(([^()]+)\)/g, 'pow($1, $2)')
        .replace(/([A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?)\s*\^\s*([A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?)/g, 'pow($1, $2)')

      const evaluated = evaluate(normalizedFormula, { ...scope })
      const numeric = typeof evaluated === 'number' ? evaluated : Number(evaluated)
      if (!Number.isFinite(numeric)) {
        skipped.push({ parameter: analyte.name, analyte_id: analyte.analyte_id, reason: 'formula did not produce a finite number' })
        continue
      }
      // Store at the analyte's configured precision so the entry console, the
      // portal and the PDF all agree. Unconfigured stays at 2 dp as before.
      const rounded = round(numeric, resolveStoredDecimalPlaces(analyte.decimal_places))
      results.push({ ...base, value: String(rounded) })

      // Feed back so dependent calculated analytes can use it
      valueMap[analyte.name] = rounded
      valueMap[analyte.name.toUpperCase()] = rounded
      valueMap[analyte.analyte_id] = rounded
      if (analyte.lab_analyte_id) valueMap[analyte.lab_analyte_id] = rounded
    } catch (err: any) {
      skipped.push({
        parameter: analyte.name,
        analyte_id: analyte.analyte_id,
        reason: err?.message || 'formula evaluation failed',
      })
    }
  }

  return { results, skipped }
}
