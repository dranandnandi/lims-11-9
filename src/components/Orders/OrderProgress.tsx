// src/components/Orders/OrderProgress.tsx
import { useMemo } from 'react'

type Segment = 'draft' | 'pending' | 'approved' | 'remaining'

const statusRank: Record<Segment, number> = {
  remaining: 0,
  draft: 1,
  pending: 2,
  approved: 3,
}

const normalizeStatusToSegment = (status: string): Segment => {
  const s = (status || '').toLowerCase()
  if (['verified', 'approved', 'completed', 'complete'].includes(s)) return 'approved'
  if (['pending_verification', 'pending_approval', 'in_review'].includes(s)) return 'pending'
  if (['entered', 'draft', 'in_progress'].includes(s)) return 'draft'
  return 'draft'
}

const analyteKeyFromIdOrName = (id?: string | null, name?: string) =>
  id && `${id}` !== 'null' ? `id:${id}` : `name:${(name || '').trim().toLowerCase()}`

const expectedAnalyteKeysFromOrder = (order: any): Set<string> => {
  const keys = new Set<string>()
  ;(order.test_groups || []).forEach((tg: any) => {
    (tg.analytes || []).forEach((a: any) => {
      const k = a.id ? `id:${a.id}` : `name:${(a.name || '').trim().toLowerCase()}`
      keys.add(k)
    })
  })
  return keys
}

function computeProgress(order: any) {
  const expected = expectedAnalyteKeysFromOrder(order)
  const best: Record<string, Segment> = {}

  ;(order.results || []).forEach((r: any) => {
    const seg = normalizeStatusToSegment(r.status)
    ;(r.result_values || []).forEach((rv: any) => {
      const k = analyteKeyFromIdOrName(rv.analyte_id, rv.analyte_name)
      if (!expected.has(k)) return
      const current = best[k] ?? 'remaining'
      if (statusRank[seg] > statusRank[current]) best[k] = seg
    })
  })

  let draft = 0, pending = 0, approved = 0
  expected.forEach(k => {
    const seg = best[k] || 'remaining'
    if (seg === 'draft') draft++
    else if (seg === 'pending') pending++
    else if (seg === 'approved') approved++
  })
  const remaining = Math.max(expected.size - (draft + pending + approved), 0)
  const toPct = (n: number) => (expected.size ? Math.round((n / expected.size) * 100) : 0)

  return {
    expectedTotal: expected.size,
    counts: { draft, pending, approved, remaining },
    pct: {
      draft: toPct(draft),
      pending: toPct(pending),
      approved: toPct(approved),
      remaining: toPct(remaining),
    },
    overallApprovedPct: toPct(approved),
  }
}

const Dot = ({ className = '' }: { className?: string }) => (
  <span className={`inline-block w-2.5 h-2.5 rounded-full ${className}`} />
)

const SegmentedProgressBar = ({ pct }: { pct: { draft: number; pending: number; approved: number; remaining: number } }) => {
  const total = pct.draft + pct.pending + pct.approved + pct.remaining || 1
  const w = (v: number) => `${(v / total) * 100}%`
  return (
    <div className="w-full rounded-full h-2.5 bg-gray-200 overflow-hidden">
      <div className="h-2.5 bg-blue-400 inline-block" style={{ width: w(pct.draft) }} />
      <div className="h-2.5 bg-orange-400 inline-block" style={{ width: w(pct.pending) }} />
      <div className="h-2.5 bg-green-500 inline-block" style={{ width: w(pct.approved) }} />
      <div className="h-2.5 bg-gray-200 inline-block" style={{ width: w(pct.remaining) }} />
    </div>
  )
}

export function OrderProgress({ order }: { order: any }) {
  const progress = useMemo(() => computeProgress(order), [order])

  // no analytes? hide to avoid noise
  if (!progress.expectedTotal) return null

  return (
    <div className="mt-3">
      <SegmentedProgressBar pct={progress.pct} />
      <div className="flex flex-wrap gap-3 mt-2 text-[11px] text-gray-600">
        <span><Dot className="bg-green-500 mr-1" />Approved {progress.counts.approved}</span>
        <span><Dot className="bg-orange-400 mr-1" />Pending {progress.counts.pending}</span>
        <span><Dot className="bg-blue-400 mr-1" />Draft {progress.counts.draft}</span>
        <span><Dot className="bg-gray-300 mr-1" />Remaining {progress.counts.remaining}</span>
      </div>
    </div>
  )
}
