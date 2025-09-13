// components/Orders/ResultIntake.tsx
// ───────────────────────────────────────────────────────────────────────────────
// BLOCK 0: Imports
// Keep paths as-is for your repo structure.
import React, { useEffect, useMemo, useState } from 'react'
import { supabase } from '../../utils/supabase'
import { useAuth } from '../../contexts/AuthContext'
import { calculateFlagsForResults } from '../../utils/flagCalculation'
import { CheckCircle, AlertTriangle } from 'lucide-react'

// ───────────────────────────────────────────────────────────────────────────────
// BLOCK 1: Types

type FlagCode = '' | 'H' | 'L' | 'C'

interface Analyte {
  id: string
  name: string
  code?: string
  units?: string
  unit?: string
  reference_range?: string
  existing_result?: {
    id: string
    value: string | null
    unit?: string | null
    reference_range?: string | null
    flag?: string | null
  } | null
}

interface TestGroup {
  test_group_id: string
  test_group_name: string
  order_test_group_id: string | null
  order_test_id: string | null
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
}

type Entry = {
  analyte_id: string
  analyte_name: string
  value: string
  unit: string
  reference: string
  flag: FlagCode
  // relationships
  test_group_id: string
  order_test_group_id: string | null
  order_test_id: string | null
}

// ───────────────────────────────────────────────────────────────────────────────
// BLOCK 2: Helpers (pure)

const isCompleted = (a: Analyte) =>
  !!a.existing_result && a.existing_result.value !== null && `${a.existing_result.value}`.trim() !== ''

const flagOptions: { value: FlagCode; label: string }[] = [
  { value: '', label: 'Normal' },
  { value: 'H', label: 'High' },
  { value: 'L', label: 'Low' },
  { value: 'C', label: 'Critical' },
]

// ───────────────────────────────────────────────────────────────────────────────
// BLOCK 3: Component

export function ResultIntake({ order, onResultProcessed }: Props) {
  const { user } = useAuth()

  // UI state
  const [showCompleted, setShowCompleted] = useState(false)
  const [saving, setSaving] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  // Editable entries keyed by analyte_id (only for NOT completed analytes)
  const [entries, setEntries] = useState<Record<string, Entry>>({})

  // ───────────────────────────────────────────────────────────────────────────
  // BLOCK 3A: Initialize editable entries from order (pending analytes only)

  useEffect(() => {
    const next: Record<string, Entry> = {}
    order.test_groups.forEach(tg => {
      tg.analytes.forEach(a => {
        if (!isCompleted(a)) {
          next[a.id] = {
            analyte_id: a.id,
            analyte_name: a.name,
            value: '',
            unit: a.units || a.unit || '',
            reference: a.reference_range || '',
            flag: '',
            test_group_id: tg.test_group_id,
            order_test_group_id: tg.order_test_group_id,
            order_test_id: tg.order_test_id,
          }
        }
      })
    })
    setEntries(next)
  }, [order])

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

  // ───────────────────────────────────────────────────────────────────────────
  // BLOCK 3D: Persist (Save Draft / Submit)

  const persist = async (mode: 'draft' | 'submit') => {
    const activeEntries = Object.values(entries).filter(e => `${e.value}`.trim() !== '')
    if (activeEntries.length === 0) {
      setToast('Please enter at least one result value.')
      return
    }

    mode === 'draft' ? setSaving(true) : setSubmitting(true)
    setToast(null)

    try {
      // Group entries by test group
      const byGroup = activeEntries.reduce<Record<string, Entry[]>>((acc, e) => {
        acc[e.test_group_id] = acc[e.test_group_id] || []
        acc[e.test_group_id].push(e)
        return acc
      }, {})

      let firstSavedResultId: string | undefined

      for (const tgId of Object.keys(byGroup)) {
        const list = byGroup[tgId]

        // Pull the display name of test group for results.test_name
        const tgMeta = order.test_groups.find(t => t.test_group_id === tgId)
        const testGroupName = tgMeta?.test_group_name || 'Unknown Test'

        // Prepare results row
        const resultRow = {
          order_id: order.id,
          patient_id: order.patient_id,
          patient_name: order.patient_name,
          test_name: testGroupName,
          status: mode === 'draft' ? 'entered' : 'pending_verification',
          entered_by: user?.user_metadata?.full_name || user?.email || 'Unknown User',
          entered_date: new Date().toISOString().split('T')[0],
          test_group_id: tgId,
          lab_id: order.lab_id,
          // keep links to originating order_test_group/order_test when present
          ...(tgMeta?.order_test_group_id && { order_test_group_id: tgMeta.order_test_group_id }),
          ...(tgMeta?.order_test_id && { order_test_id: tgMeta.order_test_id }),
        }

        const { data: savedResult, error: insertErr } = await supabase
          .from('results')
          .insert(resultRow)
          .select()
          .single()

        if (insertErr) throw insertErr
        if (!firstSavedResultId) firstSavedResultId = savedResult.id

        // Build values + compute flags (if user didn’t pick)
        const forFlag = list.map(v => ({
          parameter: v.analyte_name,
          value: v.value,
          unit: v.unit,
          reference_range: v.reference,
          flag: v.flag || undefined,
        }))
        const withFlags = calculateFlagsForResults(forFlag)

        const values = list.map((v, i) => ({
          result_id: savedResult.id,
          order_id: order.id,
          lab_id: order.lab_id,
          test_group_id: tgId,
          analyte_id: v.analyte_id,
          analyte_name: v.analyte_name,
          parameter: v.analyte_name,
          value: v.value,
          unit: v.unit || '',
          reference_range: v.reference || '',
          flag: (v.flag || withFlags[i]?.flag || '') || null,
          ...(v.order_test_group_id && { order_test_group_id: v.order_test_group_id }),
          ...(v.order_test_id && { order_test_id: v.order_test_id }),
        }))

        const { error: valuesErr } = await supabase.from('result_values').insert(values)
        if (valuesErr) throw valuesErr
      }

      setToast(mode === 'draft' ? 'Draft saved successfully.' : 'Results submitted successfully.')
      // Clear the entered rows we just saved (local UX), parent will reload and hide them permanently
      const submittedIds = new Set(activeEntries.map(e => e.analyte_id))
      setEntries(prev => {
        const next = { ...prev }
        submittedIds.forEach(id => delete next[id])
        return next
      })

      // Notify parent to reload (so completed analytes disappear)
      if (firstSavedResultId) onResultProcessed(firstSavedResultId)
    } catch (err) {
      console.error('Persist error:', err)
      setToast('Something went wrong. Please try again.')
    } finally {
      mode === 'draft' ? setSaving(false) : setSubmitting(false)
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
        if (!showCompleted && pending.length === 0) return null

        const rows = showCompleted ? [...pending, ...completed] : pending

        return (
          <div key={tg.test_group_id} className="border rounded-lg">
            {/* Group header */}
            <div className="px-4 py-3 border-b bg-gray-50 flex items-center justify-between">
              <div>
                <h3 className="text-base font-semibold">{tg.test_group_name}</h3>
                <p className="text-xs text-gray-500">
                  {progress.completed}/{progress.total} completed
                </p>
              </div>
              <div className="w-32 bg-gray-200 rounded-full h-2 overflow-hidden">
                <div
                  className="bg-blue-600 h-2"
                  style={{ width: `${progress.percent}%` }}
                />
              </div>
            </div>

            {/* Table (mobile-friendly) */}
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Parameter</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase w-36">Value</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase w-24">Unit</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase w-40">Reference</th>
                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase w-28">Flag</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-100">
                  {rows.map(analyte => {
                    const completedRow = isCompleted(analyte)
                    const entry = entries[analyte.id]

                    return (
                      <tr key={analyte.id} className={completedRow ? 'bg-green-50/40' : ''}>
                        {/* Parameter */}
                        <td className="px-3 py-2 align-top">
                          <div className="text-sm font-medium text-gray-900">{analyte.name}</div>
                          {analyte.code && (
                            <div className="text-xs text-gray-500">({analyte.code})</div>
                          )}
                          {completedRow && analyte.existing_result?.value != null && (
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
                              value={analyte.existing_result?.value ?? ''}
                              className="w-full px-2 py-1 bg-gray-100 border border-gray-200 rounded text-gray-600"
                            />
                          ) : (
                            <input
                              value={entry?.value || ''}
                              onChange={(e) => updateEntry(analyte.id, { value: e.target.value })}
                              placeholder="Enter value"
                              className="w-full px-2 py-1 border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
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
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )
      })}

      {/* Empty state */}
      {totalPendingAnalytes === 0 && !showCompleted && (
        <div className="p-4 rounded border border-green-200 bg-green-50 text-green-800 text-sm flex items-start">
          <CheckCircle className="h-4 w-4 mt-0.5 mr-2" />
          All analytes for this order already have results. Use the toggle above if you want to view them.
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div
          className={`p-3 rounded text-sm flex items-start ${
            toast?.toLowerCase().includes('wrong') || toast?.toLowerCase().includes('please')
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
  )
}
