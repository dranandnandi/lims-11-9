// components/Orders/ResultIntake.tsx
// ───────────────────────────────────────────────────────────────────────────────
// BLOCK 0: Imports
// Keep paths as-is for your repo structure.
import { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import { supabase, database } from '../../utils/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { calculateFlagsForResults } from '../../utils/flagCalculation'
import { CheckCircle, AlertTriangle, Sparkles, Calculator, EyeOff } from 'lucide-react'
import { findResolvedReferenceRange, normalizeResultFlagForSave, resolveReferenceRanges } from '../../utils/referenceRangeService'
import { rangeAuditColumns } from '../../utils/referenceRangeLoader'
import { evaluate } from 'mathjs'
import SectionEditor, { type SectionEditorRef } from '../Results/SectionEditor'

// ───────────────────────────────────────────────────────────────────────────────
// BLOCK 1: Types

type FlagCode = '' | 'H' | 'L' | 'C' | 'A' | string

interface Analyte {
  id: string
  name: string
  code?: string
  units?: string
  unit?: string
  reference_range?: string
  is_calculated?: boolean
  formula?: string
  formula_variables?: string[]
  lab_analyte_id?: string | null
  existing_result?: {
    id: string
    result_id?: string | null
    value: string | null
    unit?: string | null
    reference_range?: string | null
    flag?: string | null
    verify_status?: string | null
    is_hidden_from_report?: boolean | null
    hidden_reason?: string | null
    result_status?: string | null
    result_verification_status?: string | null
  } | null
}

interface TestGroup {
  test_group_id: string
  test_group_name: string
  order_test_group_id: string | null
  order_test_id: string | null
  result_id?: string | null
  is_section_only?: boolean
  analytes: Analyte[]
}

interface IntakeOrder {
  id: string
  lab_id: string
  patient_id: string
  patient_name: string
  test_groups: TestGroup[]
  sample_id?: string
  status: string
}

interface Props {
  order: IntakeOrder
  onResultProcessed: (resultId: string) => void
  showAutoVerifyOption?: boolean
}

type Entry = {
  analyte_id: string
  lab_analyte_id?: string | null
  analyte_name: string
  value: string
  unit: string
  reference: string
  // How the range was decided, resolved upstream in OrderDetail and carried
  // through to result_values so the verification desk can explain it.
  range_rule_id?: string | null
  range_source?: string | null
  applied_range_rule?: string | null
  // The range as resolved, so a hand-edited one can be told apart on save.
  resolved_reference?: string
  flag: FlagCode
  is_hidden_from_report?: boolean
  hidden_reason?: string | null
  // relationships
  test_group_id: string
  order_test_group_id: string | null
  order_test_id: string | null
}

// ───────────────────────────────────────────────────────────────────────────────
// BLOCK 2: Helpers (pure)

const hasExistingValue = (a: Analyte) =>
  !!a.existing_result && a.existing_result.value !== null && `${a.existing_result.value}`.trim() !== ''

const isHiddenExisting = (a: Analyte) => !!a.existing_result?.is_hidden_from_report

const isCompleted = (a: Analyte) => {
  if (!hasExistingValue(a) && !isHiddenExisting(a)) return false

  const resultStatus = `${a.existing_result?.result_status || ''}`.toLowerCase()
  const verificationStatus = `${a.existing_result?.result_verification_status || ''}`.toLowerCase()
  const valueVerificationStatus = `${a.existing_result?.verify_status || ''}`.toLowerCase()

  return (
    ['approved', 'reviewed', 'reported', 'verified'].includes(resultStatus) ||
    verificationStatus === 'verified' ||
    valueVerificationStatus === 'approved'
  )
}

const DEFAULT_FLAG_OPTIONS: { value: FlagCode; label: string }[] = [
  { value: '', label: 'Normal' },
  { value: 'H', label: 'High' },
  { value: 'L', label: 'Low' },
  { value: 'A', label: 'Abnormal' },
  { value: 'C', label: 'Critical' },
]

// ───────────────────────────────────────────────────────────────────────────────
// BLOCK 3: Component

export function ResultIntake({ order, onResultProcessed, showAutoVerifyOption = false }: Props) {
  const { user } = useAuth()

  // UI state
  const [showCompleted, setShowCompleted] = useState(false)
  const [saving, setSaving] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [autoVerifyOnSubmit, setAutoVerifyOnSubmit] = useState(false)
  const [groupResultIds, setGroupResultIds] = useState<Record<string, string>>({})
  const sectionEditorRefs = useRef<Record<string, SectionEditorRef | null>>({})

  // Lab flag options - loaded from lab settings
  const [flagOptions, setFlagOptions] = useState<{ value: FlagCode; label: string }[]>(DEFAULT_FLAG_OPTIONS)

  // Editable entries keyed by analyte_id (only for NOT completed analytes)
  const [entries, setEntries] = useState<Record<string, Entry>>({})

  // Dependency map for calculated analytes: calculated_analyte_id -> [{variable_name, source_analyte_id}]
    const [depMap, setDepMap] = useState<Record<string, { variable_name: string; source_analyte_id: string; source_lab_analyte_id?: string | null }[]>>({})

  // ───────────────────────────────────────────────────────────────────────────
  // BLOCK 3A: Initialize editable entries from order (pending analytes only)

  useEffect(() => {
    const next: Record<string, Entry> = {}
    order.test_groups.forEach(tg => {
      tg.analytes.forEach(a => {
        if (!isCompleted(a)) {
          next[a.id] = {
            analyte_id: a.id,
            lab_analyte_id: a.lab_analyte_id || null,
            analyte_name: a.name,
            value: a.existing_result?.value ?? '',
            unit: a.existing_result?.unit || a.units || a.unit || '',
            reference: a.existing_result?.reference_range ?? a.reference_range ?? '',
            resolved_reference: a.reference_range ?? '',
            range_rule_id: (a as any).range_rule_id ?? null,
            range_source: (a as any).range_source ?? null,
            applied_range_rule: (a as any).applied_range_rule ?? null,
            flag: (a.existing_result?.flag as FlagCode) || '',
            is_hidden_from_report: !!a.existing_result?.is_hidden_from_report,
            hidden_reason: a.existing_result?.hidden_reason || null,
            test_group_id: tg.test_group_id,
            order_test_group_id: tg.order_test_group_id,
            order_test_id: tg.order_test_id,
          }
        }
      })
    })
    setEntries(next)
  }, [order])

  useEffect(() => {
    const next: Record<string, string> = {}
    order.test_groups.forEach(tg => {
      if (tg.result_id) next[tg.test_group_id] = tg.result_id
    })
    setGroupResultIds(next)
  }, [order])

  // Load lab flag options
  useEffect(() => {
    if (!order.lab_id) return
    const loadFlagOptions = async () => {
      try {
        const { data } = await supabase.from('labs').select('flag_options').eq('id', order.lab_id).single()
        if (data?.flag_options && Array.isArray(data.flag_options) && data.flag_options.length > 0) {
          setFlagOptions(data.flag_options as { value: FlagCode; label: string }[])
        }
      } catch { /* keep defaults */ }
    }
    loadFlagOptions()
  }, [order.lab_id])

  // Fetch analyte_dependencies for all calculated analytes in this order
  useEffect(() => {
    const calculatedIds: string[] = []
    order.test_groups.forEach(tg => {
      tg.analytes.forEach(a => {
        if (a.is_calculated && a.formula) calculatedIds.push(a.id)
      })
    })
    if (calculatedIds.length === 0) return

    const fetchDeps = async () => {
      // Fetch both lab-specific and global dependencies; prefer lab-specific when both exist
        const { data } = await supabase
          .from('analyte_dependencies')
          .select('calculated_analyte_id, calculated_lab_analyte_id, variable_name, source_analyte_id, source_lab_analyte_id, lab_id')
          .in('calculated_analyte_id', calculatedIds)
          .or(`lab_id.eq.${order.lab_id},lab_id.is.null`)
        if (!data) return
        // Build map preferring lab-specific rows (lab_id != null) over global (lab_id == null)
        const map: Record<string, { variable_name: string; source_analyte_id: string; source_lab_analyte_id?: string | null }[]> = {}
        const seen = new Set<string>() // key: `${calcKey}:${variable_name}`
        // Process lab-specific rows first
        const sorted = [...data].sort((a, b) => (a.lab_id ? -1 : 1) - (b.lab_id ? -1 : 1))
        sorted.forEach((d: { calculated_analyte_id: string; calculated_lab_analyte_id?: string | null; variable_name: string; source_analyte_id: string; source_lab_analyte_id?: string | null; lab_id: string | null }) => {
          const calcKey = d.calculated_lab_analyte_id || d.calculated_analyte_id
          const key = `${calcKey}:${d.variable_name}`
          if (seen.has(key)) return // skip global duplicate if lab-specific already added
          seen.add(key)
          if (!map[calcKey]) map[calcKey] = []
          map[calcKey].push({ variable_name: d.variable_name, source_analyte_id: d.source_analyte_id, source_lab_analyte_id: d.source_lab_analyte_id || null })
        })
        setDepMap(map)
    }
    fetchDeps()
  }, [order])

  // Auto-compute calculated analytes whenever entries change
  const runCalculations = useCallback(() => {
    const allAnalytes: Analyte[] = []
    order.test_groups.forEach(tg => tg.analytes.forEach(a => allAnalytes.push(a)))

    const calculated = allAnalytes.filter(a => a.is_calculated && a.formula)
    if (calculated.length === 0) return

    setEntries(prev => {
      const next = { ...prev }
      let changed = false

      calculated.forEach(calc => {
        if (!calc.formula || isCompleted(calc)) return
          const deps = depMap[calc.lab_analyte_id || calc.id]
          if (!deps || deps.length === 0) return

        // Build scope from source analyte values
        // Resolution: 1) exact analyte_id  2) name match (handles duplicate analytes with different IDs)
        const scope: Record<string, number> = {}
          let allPresent = true
          for (const dep of deps) {
            // 1. Exact lab_analyte_id match
            let sourceAnalyte = dep.source_lab_analyte_id
              ? allAnalytes.find(a => a.lab_analyte_id === dep.source_lab_analyte_id)
              : undefined
            let rawValue = sourceAnalyte ? (prev[sourceAnalyte.id]?.value || sourceAnalyte.existing_result?.value) : undefined

            // 2. Exact analyte_id match
            if (!rawValue || isNaN(parseFloat(rawValue))) {
              sourceAnalyte = allAnalytes.find(a => a.id === dep.source_analyte_id)
              rawValue = (prev[dep.source_analyte_id]?.value) || sourceAnalyte?.existing_result?.value
            }

            // 3. Name-based fallback — dep points to a different copy of the same analyte
            if (!rawValue || isNaN(parseFloat(rawValue))) {
            const byName = allAnalytes.find(
              a => a.id !== dep.source_analyte_id &&
                   a.name?.toLowerCase() === (sourceAnalyte?.name || dep.variable_name)?.toLowerCase()
            )
            if (byName) {
              rawValue = prev[byName.id]?.value || byName.existing_result?.value
            }
          }

          if (!rawValue || isNaN(parseFloat(rawValue))) {
            allPresent = false
            break
          }
          scope[dep.variable_name] = parseFloat(rawValue)
        }

        if (!allPresent) {
          // Clear calculated value if deps are missing
          if (next[calc.id] && next[calc.id].value !== '') {
            next[calc.id] = { ...next[calc.id], value: '' }
            changed = true
          }
          return
        }

        try {
          const result = evaluate(calc.formula, scope)
          const rounded = Math.round(result * 100) / 100
          const strVal = String(rounded)
          if (next[calc.id] && next[calc.id].value !== strVal) {
            next[calc.id] = { ...next[calc.id], value: strVal }
            changed = true
          }
        } catch {
          // formula evaluation failed, leave empty
        }
      })

      return changed ? next : prev
    })
  }, [order, depMap])

  useEffect(() => {
    runCalculations()
  }, [entries, depMap, runCalculations])

  // ───────────────────────────────────────────────────────────────────────────
  // BLOCK 3B: Derived data per test group (pending vs completed, progress)

  const groups = useMemo(() => {
    return order.test_groups.map(tg => {
      const pending = tg.analytes.filter(a => !isCompleted(a))
      const completed = tg.analytes.filter(a => isCompleted(a))
      const progress = {
        total: tg.analytes.length,
        completed: completed.length,
        pending: pending.length,
        percent: tg.analytes.length
          ? Math.round((completed.length / tg.analytes.length) * 100)
          : 0,
      }
      return { tg, pending, completed, progress }
    })
  }, [order])

  const totalPendingAnalytes = useMemo(
    () => groups.reduce((acc, g) => acc + g.progress.pending, 0),
    [groups]
  )

  // ───────────────────────────────────────────────────────────────────────────
  // BLOCK 3C: Local field updates

  const updateEntry = (analyteId: string, patch: Partial<Entry>) => {
    setEntries(prev => ({ ...prev, [analyteId]: { ...prev[analyteId], ...patch } }))
  }

  const toggleHiddenFromReport = (analyteId: string) => {
    setEntries(prev => {
      const current = prev[analyteId]
      if (!current) return prev
      const willHide = !current.is_hidden_from_report
      return {
        ...prev,
        [analyteId]: {
          ...current,
          is_hidden_from_report: willHide,
          hidden_reason: willHide ? (current.hidden_reason || 'Hidden from report') : null,
        },
      }
    })
  }

  const ensureResultForGroup = useCallback(async (
    tg: TestGroup,
    mode: 'draft' | 'submit' = 'draft',
  ) => {
    const existingResultId = groupResultIds[tg.test_group_id] || tg.analytes.find(a => a.existing_result?.result_id)?.existing_result?.result_id
    if (existingResultId) return existingResultId

    const { data: orderTest } = await supabase
      .from('order_tests')
      .select('outsourced_lab_id')
      .eq('order_id', order.id)
      .eq('test_group_id', tg.test_group_id)
      .maybeSingle()

    const resultRow = {
      order_id: order.id,
      patient_id: order.patient_id,
      patient_name: order.patient_name,
      test_name: tg.test_group_name || 'Unknown Test',
      status: mode === 'draft' ? 'Entered' : 'pending_verification',
      verification_status: mode === 'submit' ? 'pending_verification' : null,
      entered_by: user?.user_metadata?.full_name || user?.email || 'Unknown User',
      entered_date: new Date().toISOString().split('T')[0],
      test_group_id: tg.test_group_id,
      lab_id: order.lab_id,
      ...(tg.order_test_group_id && { order_test_group_id: tg.order_test_group_id }),
      ...(tg.order_test_id && { order_test_id: tg.order_test_id }),
      ...(orderTest?.outsourced_lab_id && {
        outsourced_to_lab_id: orderTest.outsourced_lab_id,
        outsourced_status: 'pending_send',
        outsourced_logistics_status: 'pending_dispatch'
      }),
    }

    const { data: insertedResult, error: insertErr } = await supabase
      .from('results')
      .insert(resultRow)
      .select('id')
      .single()

    if (insertErr) throw insertErr

    setGroupResultIds(prev => ({ ...prev, [tg.test_group_id]: insertedResult.id }))
    return insertedResult.id as string
  }, [groupResultIds, order.id, order.lab_id, order.patient_id, order.patient_name, user])

  // ───────────────────────────────────────────────────────────────────────────
  // BLOCK 3C-2: AI Handler

  const [aiLoadingGroup, setAiLoadingGroup] = useState<string | null>(null)

  useEffect(() => {
    const sectionOnlyGroups = order.test_groups.filter(tg => tg.is_section_only && !groupResultIds[tg.test_group_id])
    if (sectionOnlyGroups.length === 0) return

    let cancelled = false
    ;(async () => {
      for (const tg of sectionOnlyGroups) {
        if (cancelled) return
        try {
          await ensureResultForGroup(tg, 'draft')
        } catch (err) {
          console.error('Failed to initialize section-only result row:', err)
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [order.test_groups, groupResultIds, ensureResultForGroup])

  const handleAIResolve = async (tgId: string) => {
    // 1. Gather analytes for this group
    // We need name, value, unit. Can use entries (for typed values) or order definition (for names)
    const groupData = groups.find(g => g.tg.test_group_id === tgId);
    if (!groupData) return;

    const payload = groupData.tg.analytes.map(a => {
      // Use current entered value if exists, else empty
      const entry = entries[a.id];
      return {
        id: a.id,
        lab_analyte_id: a.lab_analyte_id || null,
        name: a.name,
        value: entry?.value || a.existing_result?.value || '', // Use entered or existing
        unit: entry?.unit || a.units || a.unit || ''
      };
    });

    // Filter out those with no value? No, AI might suggest range based on Analyte Name even without value (context only), but better with value.
    // Actually prompt says "TEST RESULTS TO EVALUATE". If value is missing, AI usually returns default range.

    setAiLoadingGroup(tgId);
    setToast('Asking AI for reference ranges...');

    try {
      const resolved = await resolveReferenceRanges(order.id, tgId, payload);

      // Update entries
      setEntries(prev => {
        const next = { ...prev };
        resolved.forEach(r => {
          const matchedEntry = Object.values(next).find(entry => findResolvedReferenceRange([r], entry));
          const entryKey = matchedEntry?.analyte_id || r.id;
          // If we have an entry for this (it's pending), update it
          // Logic: Only update if it's currently editable (in 'entries')
          if (next[entryKey]) {
            const aiReference = r.used_reference_range || (r.ref_low && r.ref_high ? `${r.ref_low} - ${r.ref_high}` : next[entryKey].reference);
            next[entryKey] = {
              ...next[entryKey],
              reference: aiReference,
              // Keep the two in step so the save path does not mistake an
              // AI-supplied range for one a technician typed.
              resolved_reference: aiReference,
              range_source: 'ai',
              range_rule_id: null,
              applied_range_rule: r.applied_rule || null,
              flag: (r.flag || '') as FlagCode
            };
          } else if (!isCompleted(groupData.tg.analytes.find(a => a.id === r.id)!)) {
            // Create entry if it didn't exist (user hasn't typed yet) but IS pending
            // Need to construct full Entry object (requires looking up metadata again)
            // Simpler: Just rely on existance in 'entries' which initiates on mount.
            // But 'entries' only has items if they are NOT completed.
            // If user hasn't typed in 'entries' yet for a pending item, 'entries[id]' might be valid?
            // Ah, useEffect block 3A initializes ALL pending items into 'entries'.
            // So next[r.id] SHOULD exist for all pending items.
          }
        });
        return next;
      });
      setToast('AI Ranges Applied!');
    } catch {
      setToast('AI Request Failed.');
    } finally {
      setAiLoadingGroup(null);
    }
  };

  // ───────────────────────────────────────────────────────────────────────────
  // BLOCK 3D: Persist (Save Draft / Submit)

  const persist = async (mode: 'draft' | 'submit') => {
    const activeEntries = Object.values(entries).filter(e => `${e.value}`.trim() !== '' || e.is_hidden_from_report)
    const groupsWithSectionEditors = order.test_groups.filter(tg => !!groupResultIds[tg.test_group_id])
    if (activeEntries.length === 0 && groupsWithSectionEditors.length === 0) {
      setToast('Please enter at least one result value.')
      return
    }

    if (mode === 'draft') setSaving(true)
    else setSubmitting(true)
    setToast(null)

    try {
      // Group entries by test group
      const byGroup = activeEntries.reduce<Record<string, Entry[]>>((acc, e) => {
        acc[e.test_group_id] = acc[e.test_group_id] || []
        acc[e.test_group_id].push(e)
        return acc
      }, {})

      let firstSavedResultId: string | undefined
      const savedResultIds: string[] = []
      const savedResultValueIds: string[] = []
      const { data: existingResults, error: existingResultsError } = await supabase
        .from('results')
        .select('id, test_group_id, order_test_group_id, order_test_id, status, verification_status')
        .eq('order_id', order.id)

      if (existingResultsError) throw existingResultsError

      for (const tg of order.test_groups) {
        if (!groupResultIds[tg.test_group_id] && tg.is_section_only) {
          const ensuredResultId = await ensureResultForGroup(tg, mode)
          if (ensuredResultId) {
            savedResultIds.push(ensuredResultId)
            if (!firstSavedResultId) firstSavedResultId = ensuredResultId
          }
        }
      }

      // Batch-fetch outsourced lab IDs for all test groups in one query (eliminates N sequential round-trips)
      const groupIds = Object.keys(byGroup)
      const outsourcedMap = new Map<string, string | null>()
      if (groupIds.length > 0) {
        const { data: outsourcedRows } = await supabase
          .from('order_tests')
          .select('test_group_id, outsourced_lab_id')
          .eq('order_id', order.id)
          .in('test_group_id', groupIds)
        for (const row of (outsourcedRows || [])) {
          outsourcedMap.set(row.test_group_id, row.outsourced_lab_id || null)
        }
      }

      for (const tgId of Object.keys(byGroup)) {
        const list = byGroup[tgId]

        // Pull the display name of test group for results.test_name
        const tgMeta = order.test_groups.find(t => t.test_group_id === tgId)
        const testGroupName = tgMeta?.test_group_name || 'Unknown Test'

        const outsourcedLabId = outsourcedMap.get(tgId) || null

        const existingResult = (existingResults || []).find((row: any) =>
          (tgMeta?.order_test_group_id && row.order_test_group_id === tgMeta.order_test_group_id) ||
          (tgMeta?.order_test_id && row.order_test_id === tgMeta.order_test_id) ||
          row.test_group_id === tgId
        )

        let savedResult: any
        if (existingResult?.id) {
          const { data: updatedResult, error: updateErr } = await supabase
            .from('results')
            .update({
              test_name: testGroupName,
              status: mode === 'draft' ? 'Entered' : 'pending_verification',
              verification_status: mode === 'submit' ? 'pending_verification' : (existingResult.verification_status || null),
              entered_by: user?.user_metadata?.full_name || user?.email || 'Unknown User',
              entered_date: new Date().toISOString().split('T')[0],
              lab_id: order.lab_id,
              ...(outsourcedLabId && {
                outsourced_to_lab_id: outsourcedLabId,
                outsourced_status: 'pending_send',
                outsourced_logistics_status: 'pending_dispatch'
              }),
            })
            .eq('id', existingResult.id)
            .select()
            .single()

          if (updateErr) throw updateErr
          savedResult = updatedResult
        } else {
          const resultRow = {
            order_id: order.id,
            patient_id: order.patient_id,
            patient_name: order.patient_name,
            test_name: testGroupName,
            status: mode === 'draft' ? 'Entered' : 'pending_verification',
            verification_status: mode === 'submit' ? 'pending_verification' : null,
            entered_by: user?.user_metadata?.full_name || user?.email || 'Unknown User',
            entered_date: new Date().toISOString().split('T')[0],
            test_group_id: tgId,
            lab_id: order.lab_id,
            ...(tgMeta?.order_test_group_id && { order_test_group_id: tgMeta.order_test_group_id }),
            ...(tgMeta?.order_test_id && { order_test_id: tgMeta.order_test_id }),
            ...(outsourcedLabId && {
              outsourced_to_lab_id: outsourcedLabId,
              outsourced_status: 'pending_send',
              outsourced_logistics_status: 'pending_dispatch'
            }),
          }

          const { data: insertedResult, error: insertErr } = await supabase
            .from('results')
            .insert(resultRow)
            .select()
            .single()

          if (insertErr) throw insertErr
          savedResult = insertedResult
        }
        if (!firstSavedResultId) firstSavedResultId = savedResult.id
        savedResultIds.push(savedResult.id)

        // Build values + compute flags (if user didn’t pick)
        const forFlag = list.map(v => ({
          parameter: v.analyte_name,
          value: v.value,
          unit: v.unit,
          reference_range: v.reference,
          flag: v.flag || undefined,
        }))
        const withFlags = calculateFlagsForResults(forFlag)

        const values = list.map((v, i) => {
          const hidden = !!v.is_hidden_from_report;
          const resolvedFlag = hidden ? null : normalizeResultFlagForSave(v.flag || withFlags[i]?.flag, v.value);
          const verifiedAt = mode === 'submit' && (autoVerifyOnSubmit || hidden) ? new Date().toISOString() : null;
          return {
            result_id: savedResult.id,
            order_id: order.id,
            lab_id: order.lab_id,
            test_group_id: tgId,
            analyte_id: v.analyte_id,
            lab_analyte_id: v.lab_analyte_id || null,
            analyte_name: v.analyte_name,
            parameter: v.analyte_name,
            value: `${v.value}`.trim() === '' ? null : v.value,
            unit: v.unit || '',
            reference_range: v.reference || '',
            ...rangeAuditColumns(
              { rule_id: v.range_rule_id, applied_rule: v.applied_range_rule, source: v.range_source },
              { edited: (v.reference || '') !== (v.resolved_reference || '') },
            ),
            flag: resolvedFlag,
            verify_status: mode === 'submit' && (autoVerifyOnSubmit || hidden) ? 'approved' : 'pending',
            verified: mode === 'submit' && (autoVerifyOnSubmit || hidden),
            verified_by: verifiedAt ? (user?.id || null) : null,
            verified_at: verifiedAt,
            verify_note: hidden ? (v.hidden_reason || 'Hidden from report') : (autoVerifyOnSubmit && mode === 'submit' ? 'Auto-verified during corporate bulk result entry.' : null),
            is_hidden_from_report: hidden,
            hidden_reason: hidden ? (v.hidden_reason || 'Hidden from report') : null,
            ...(!hidden && { flag_source: v.flag ? 'manual' : 'auto_numeric' }),
            ...(v.order_test_group_id && { order_test_group_id: v.order_test_group_id }),
            ...(v.order_test_id && { order_test_id: v.order_test_id }),
          };
        })

        const analyteIds = list.map(v => v.analyte_id).filter(Boolean)
        if (analyteIds.length > 0) {
          const { error: deleteValuesErr } = await supabase
            .from('result_values')
            .delete()
            .eq('result_id', savedResult.id)
            .in('analyte_id', analyteIds)
          if (deleteValuesErr) throw deleteValuesErr
        }

        const { data: insertedValues, error: valuesErr } = await supabase
          .from('result_values')
          .insert(values)
          .select('id')
        if (valuesErr) throw valuesErr
        savedResultValueIds.push(...(insertedValues || []).map((row: { id: string }) => row.id))

        // Auto-consume inventory for non-outsourced tests (non-blocking)
        if (!outsourcedLabId) {
          database.inventory.triggerAutoConsume({
            labId: order.lab_id,
            orderId: order.id,
            resultId: savedResult.id,
            testGroupId: tgId,
          }).catch(err => console.warn('Inventory auto-consume failed (non-blocking):', err));
        }
      }

      for (const tg of groupsWithSectionEditors) {
        const resultId = groupResultIds[tg.test_group_id]
        if (!resultId) continue
        const { error: resultStatusError } = await supabase
          .from('results')
          .update({
            status: mode === 'draft' ? 'Entered' : 'pending_verification',
            verification_status: mode === 'submit' ? 'pending_verification' : null,
            entered_by: user?.user_metadata?.full_name || user?.email || 'Unknown User',
            entered_date: new Date().toISOString().split('T')[0],
            lab_id: order.lab_id,
          })
          .eq('id', resultId)
        if (resultStatusError) throw resultStatusError

        const ref = sectionEditorRefs.current[tg.test_group_id]
        if (ref) {
          await ref.save()
        }
      }

      try {
        setToast('Finalizing flags and reference details...')
        const { runAIFlagAnalysis } = await import('../../utils/aiFlagAnalysis')
        await runAIFlagAnalysis(order.id, { applyToDatabase: true, createAudit: true, useAIService: true })
      } catch (flagErr) {
        console.warn('AI flag analysis failed:', flagErr)
      }

      let successMessage = mode === 'draft' ? 'Draft saved successfully.' : 'Results submitted successfully.'

      if (mode === 'submit' && autoVerifyOnSubmit && savedResultIds.length > 0) {
        try {
          const verifiedAt = new Date().toISOString()

          if (savedResultValueIds.length > 0) {
            // Direct update — skips getCurrentUser() round-trip + heavy join select inside bulkApprove
            const { error: verifyError } = await supabase
              .from('result_values')
              .update({
                verify_status: 'approved',
                verified: true,
                verified_by: user?.id || null,
                verified_at: verifiedAt,
                updated_at: verifiedAt,
                verify_note: 'Auto-verified during corporate bulk result entry.',
              })
              .in('id', savedResultValueIds)
            if (verifyError) throw verifyError
          }

          const { error: resultVerifyError } = await supabase
            .from('results')
            .update({
              status: 'Reviewed',
              verification_status: 'verified',
              verified_at: verifiedAt,
              verified_by: user?.id || null,
            })
            .in('id', savedResultIds)
          if (resultVerifyError) throw resultVerifyError

          await database.orders.checkAndUpdateStatus(order.id)
          successMessage = savedResultValueIds.length > 0
            ? 'Results submitted and auto-verified successfully.'
            : 'Section report submitted and auto-verified successfully.'
        } catch (autoVerifyError) {
          console.error('Auto-verify error:', autoVerifyError)
          successMessage = 'Results saved, but auto-verification could not be completed.'
        }
      } else if (mode === 'submit') {
        await database.orders.checkAndUpdateStatus(order.id)
      }

      setToast(successMessage)
      // Clear the entered rows we just saved (local UX), parent will reload and hide them permanently
      const submittedIds = new Set(activeEntries.map(e => e.analyte_id))
      setEntries(prev => {
        const next = { ...prev }
        submittedIds.forEach(id => delete next[id])
        return next
      })

      if (!firstSavedResultId) {
        firstSavedResultId = groupsWithSectionEditors
          .map(tg => groupResultIds[tg.test_group_id])
          .find(Boolean)
      }

      // Notify parent to reload (so completed analytes disappear)
      if (firstSavedResultId) onResultProcessed(firstSavedResultId)
    } catch (err) {
      console.error('Persist error:', err)
      setToast('Something went wrong. Please try again.')
    } finally {
      if (mode === 'draft') setSaving(false)
      else setSubmitting(false)
      // auto-hide toast
      setTimeout(() => setToast(null), 4000)
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // BLOCK 4: Render

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="text-sm text-gray-600">
          Pending analytes: <span className="font-semibold">{totalPendingAnalytes}</span>
        </div>
        <label className="inline-flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-gray-300"
            checked={showCompleted}
            onChange={(e) => setShowCompleted(e.target.checked)}
          />
          Show completed analytes (read-only)
        </label>
      </div>

      {/* Groups */}
      {groups.map(({ tg, pending, completed, progress }) => {
        // If a group is fully completed and user is not showing completed → skip
        // But always show section-only groups (they have 0 analytes but need SectionEditor)
        if (!showCompleted && pending.length === 0 && !tg.is_section_only) return null

        const rows = showCompleted ? [...pending, ...completed] : pending

        return (
          <div key={tg.test_group_id} className="border rounded-lg">
            {/* Group header */}
            <div className="px-4 py-3 border-b bg-gray-50 flex items-center justify-between">
              <div>
                <h3 className="text-base font-semibold flex items-center gap-2">
                  <span>{tg.test_group_name}</span>
                  {tg.is_section_only && (
                    <span className="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-medium text-blue-700">
                      Section-only
                    </span>
                  )}
                </h3>
                <p className="text-xs text-gray-500">
                  {progress.completed}/{progress.total} completed
                </p>
              </div>
              <div className="w-32 bg-gray-200 rounded-full h-2 overflow-hidden mx-4">
                <div
                  className="bg-blue-600 h-2"
                  style={{ width: `${progress.percent}%` }}
                />
              </div>

              {/* AI Button */}
              <button
                onClick={() => handleAIResolve(tg.test_group_id)}
                disabled={aiLoadingGroup === tg.test_group_id}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-purple-700 bg-purple-50 hover:bg-purple-100 border border-purple-200 rounded transition-colors disabled:opacity-50"
                title="Auto-detect Reference Ranges & Flags using AI"
              >
                {aiLoadingGroup === tg.test_group_id ? (
                  <span className="animate-pulse">Thinking...</span>
                ) : (
                  <>
                    <Sparkles className="w-3.5 h-3.5" />
                    AI Auto-Range
                  </>
                )}
              </button>
            </div>

            {/* Table (mobile-friendly) */}
            {rows.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Parameter</th>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase w-36">Value</th>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase w-24">Unit</th>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase w-40">Reference</th>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase w-28">Flag</th>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase w-24">Report</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-100">
                    {rows.map(analyte => {
                      const completedRow = isCompleted(analyte)
                      const entry = entries[analyte.id]
                      const isCalc = analyte.is_calculated && !!analyte.formula
                      const hiddenFromReport = !!entry?.is_hidden_from_report || !!analyte.existing_result?.is_hidden_from_report

                      return (
                        <tr key={analyte.id} className={hiddenFromReport ? 'bg-slate-50' : completedRow ? 'bg-green-50/40' : isCalc ? 'bg-blue-50/40' : ''}>
                        {/* Parameter */}
                        <td className="px-3 py-2 align-top">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium text-gray-900">{analyte.name}</span>
                            {hiddenFromReport && (
                              <span className="inline-flex items-center gap-1 rounded-full bg-slate-200 px-2 py-0.5 text-[11px] font-medium text-slate-700">
                                <EyeOff className="h-3 w-3" />
                                Hidden
                              </span>
                            )}
                          </div>
                          {analyte.code && (
                            <div className="text-xs text-gray-500">({analyte.code})</div>
                          )}
                          {isCalc && (
                            <div className="mt-1 inline-flex items-center text-xs text-blue-600">
                              <Calculator className="h-3.5 w-3.5 mr-1" />
                              Auto: {analyte.formula}
                            </div>
                          )}
                          {hasExistingValue(analyte) && analyte.existing_result?.value != null && (
                            <div className="mt-1 inline-flex items-center text-xs text-green-700">
                              <CheckCircle className="h-3.5 w-3.5 mr-1" />
                              Current: {analyte.existing_result.value}
                            </div>
                          )}
                        </td>

                        {/* Value */}
                        <td className="px-3 py-2">
                          {completedRow ? (
                            <input
                              disabled
                              value={hiddenFromReport && !analyte.existing_result?.value ? 'Hidden from report' : analyte.existing_result?.value ?? ''}
                              className="w-full px-2 py-1 bg-gray-100 border border-gray-200 rounded text-gray-600"
                            />
                          ) : isCalc && !hiddenFromReport ? (
                            <input
                              disabled
                              value={entry?.value || ''}
                              placeholder="Auto-calculated"
                              className="w-full px-2 py-1 bg-blue-50 border border-blue-200 rounded text-blue-800 font-medium"
                            />
                          ) : (
                            <input
                              value={entry?.value || ''}
                              onChange={(e) => updateEntry(analyte.id, { value: e.target.value })}
                              placeholder={hiddenFromReport ? 'Optional' : 'Enter value'}
                              className={`w-full px-2 py-1 border rounded focus:outline-none focus:ring-1 focus:ring-blue-500 ${
                                hiddenFromReport ? 'border-slate-300 bg-slate-50 text-slate-700' : 'border-gray-300'
                              }`}
                            />
                          )}
                        </td>

                        {/* Unit */}
                        <td className="px-3 py-2">
                          {completedRow ? (
                            <input
                              disabled
                              value={analyte.existing_result?.unit ?? (analyte.units || analyte.unit || '')}
                              className="w-full px-2 py-1 bg-gray-100 border border-gray-200 rounded text-gray-600"
                            />
                          ) : (
                            <input
                              value={entry?.unit || ''}
                              onChange={(e) => updateEntry(analyte.id, { unit: e.target.value })}
                              placeholder="Unit"
                              className="w-full px-2 py-1 border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                            />
                          )}
                        </td>

                        {/* Reference */}
                        <td className="px-3 py-2">
                          {completedRow ? (
                            <input
                              disabled
                              value={analyte.existing_result?.reference_range ?? (analyte.reference_range || '')}
                              className="w-full px-2 py-1 bg-gray-100 border border-gray-200 rounded text-gray-600"
                            />
                          ) : (
                            <input
                              value={entry?.reference || ''}
                              onChange={(e) => updateEntry(analyte.id, { reference: e.target.value })}
                              placeholder="Reference range"
                              className="w-full px-2 py-1 border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                            />
                          )}
                        </td>

                        {/* Flag */}
                        <td className="px-3 py-2">
                          {completedRow ? (
                            <input
                              disabled
                              value={analyte.existing_result?.flag ?? ''}
                              className="w-full px-2 py-1 bg-gray-100 border border-gray-200 rounded text-gray-600"
                            />
                          ) : (
                            <select
                              value={entry?.flag ?? ''}
                              onChange={(e) => updateEntry(analyte.id, { flag: e.target.value as FlagCode })}
                              className="w-full px-2 py-1 border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                            >
                              {flagOptions.map(opt => (
                                <option key={opt.value} value={opt.value}>{opt.label}</option>
                              ))}
                            </select>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {completedRow ? (
                            hiddenFromReport ? (
                              <span className="inline-flex items-center gap-1 rounded border border-slate-300 bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700">
                                <EyeOff className="h-3.5 w-3.5" />
                                Hidden
                              </span>
                            ) : (
                              <span className="text-xs text-gray-400">Shown</span>
                            )
                          ) : (
                            <button
                              type="button"
                              onClick={() => toggleHiddenFromReport(analyte.id)}
                              className={`inline-flex items-center justify-center rounded border px-2 py-1 text-xs font-medium transition-colors ${
                                hiddenFromReport
                                  ? 'border-slate-400 bg-slate-700 text-white hover:bg-slate-800'
                                  : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50'
                              }`}
                              title={hiddenFromReport ? 'Hidden from report; click to show' : 'Hide this analyte from report'}
                            >
                              <EyeOff className="h-3.5 w-3.5" />
                              <span className="ml-1">{hiddenFromReport ? 'Hidden' : 'Hide'}</span>
                            </button>
                          )}
                        </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="px-4 py-4 text-sm text-blue-800 bg-blue-50 border-t border-blue-100">
                {tg.is_section_only
                  ? 'This test group is section-only. Technicians can fill the configured report sections below.'
                  : 'No analyte rows available for this test group.'}
              </div>
            )}

            {groupResultIds[tg.test_group_id] && (
              <div className="border-t bg-white px-4 py-4">
                <SectionEditor
                  ref={(instance) => {
                    sectionEditorRefs.current[tg.test_group_id] = instance
                  }}
                  resultId={groupResultIds[tg.test_group_id]}
                  testGroupId={tg.test_group_id}
                  editorRole="technician"
                  showAIAssistant={true}
                />
              </div>
            )}
          </div>
        )
      })}

      {/* Empty state */}
      {totalPendingAnalytes === 0 && !showCompleted && !order.test_groups.some(tg => tg.is_section_only) && (
        <div className="p-4 rounded border border-green-200 bg-green-50 text-green-800 text-sm flex items-start">
          <CheckCircle className="h-4 w-4 mt-0.5 mr-2" />
          All analytes for this order already have results. Use the toggle above if you want to view them.
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div
          className={`p-3 rounded text-sm flex items-start ${toast?.toLowerCase().includes('wrong') || toast?.toLowerCase().includes('please')
            ? 'bg-red-50 border border-red-200 text-red-700'
            : 'bg-green-50 border border-green-200 text-green-700'
            }`}
        >
          {toast?.toLowerCase().includes('wrong') || toast?.toLowerCase().includes('please') ? (
            <AlertTriangle className="h-4 w-4 mt-0.5 mr-2" />
          ) : (
            <CheckCircle className="h-4 w-4 mt-0.5 mr-2" />
          )}
          {toast}
        </div>
      )}

      {/* Actions */}
      <div className="space-y-3">
        {showAutoVerifyOption && (
          <label className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 rounded border-emerald-300"
              checked={autoVerifyOnSubmit}
              onChange={(e) => setAutoVerifyOnSubmit(e.target.checked)}
              disabled={saving || submitting}
            />
            <span>
              Auto-verify after submit
              <span className="ml-1 text-emerald-700">
                New result values will be approved immediately and the order status will refresh automatically.
              </span>
            </span>
          </label>
        )}
        <div className="flex justify-end gap-3">
        <button
          onClick={() => persist('draft')}
          disabled={saving || submitting}
          className="px-4 py-2 border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-60"
        >
          {saving ? 'Saving…' : 'Save Draft'}
        </button>
        <button
          onClick={() => persist('submit')}
          disabled={submitting || saving}
          className="px-5 py-2 rounded bg-green-600 text-white hover:bg-green-700 disabled:opacity-60"
        >
          {submitting ? 'Submitting…' : 'Submit Results'}
        </button>
        </div>
      </div>
    </div>
  )
}
