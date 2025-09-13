/* =============================================================================
   ORDER PROGRESS — View-driven (no client analyte math)
   Exports (unchanged):
     - computeOrderProgress(order, rows?)      // kept for compatibility
     - <OrderProgress order={order} />         // fetches view + renders bar

   How it works:
   - We query a progress VIEW by order_id (tries a few common names).
   - We aggregate counts from each panel row into draft/pending/approved.
   - Progress % = approved_analytes / expected_analytes * 100.
   - If the view has no rows, we show a gentle warning.
   ============================================================================ */

import React, { useEffect, useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { supabase } from "../utils/supabase"; // adjust path if needed

/** Toggle verbose logging */
const DEBUG_PROGRESS = true;

/* ------------------------------- View typing ------------------------------- */
type ViewRow = {
  order_test_id: string;
  order_id: string;
  test_group_id: string | null;
  test_group_name: string | null;
  expected_analytes: number;   // total analytes expected in this panel
  entered_analytes: number;    // analytes with values entered (not empty)
  total_values: number;        // raw count of values rows
  has_results: boolean;        // any result rows exist for this panel
  is_verified: boolean;        // any result row verified for this panel
  panel_status:
    | "Not started"
    | "Partial"
    | "Complete"
    | "In progress"
    | "Verified"
    | string; // tolerant
};

export type ProgressCounts = {
  expectedTotal: number;
  counts: {
    draft: number;   // not entered at all
    pending: number; // entered but not fully verified
    approved: number; // verified
  };
  percent: number;
  byPanel: Array<{
    id: string;
    name: string;
    expected: number;
    draft: number;
    pending: number;
    approved: number;
    status: string;
  }>;
};

/* ----------------------------- View fetch helper --------------------------- */
/** We’ll try a few common view names so you don’t have to change code if yours differs. */
const VIEW_CANDIDATES = [
  "order_test_progress",
  "order_test_progress_view",
  "view_order_test_progress",
  "v_order_test_progress",
  "order_tests_progress_view",
];

async function fetchOrderProgressRows(orderId: string): Promise<{ rows: ViewRow[]; viewName?: string; error?: string }> {
  for (const name of VIEW_CANDIDATES) {
    const { data, error } = await supabase
      .from(name)
      .select("*")
      .eq("order_id", orderId);

    if (!error) {
      return { rows: (data as ViewRow[]) || [], viewName: name };
    }
    // keep trying next candidate if relation missing
    if (DEBUG_PROGRESS) {
      // eslint-disable-next-line no-console
      console.warn(`[PROGRESS] view "${name}" error:`, error?.message || error);
    }
  }
  return { rows: [], error: "No compatible progress view found. Please expose your SQL as one of the expected view names." };
}

/* ---------------------------- Core aggregation ----------------------------- */
/** Pure aggregation using ONLY view rows. */
export function computeOrderProgressFromViewRows(rows: ViewRow[]): ProgressCounts {
  let expectedTotal = 0;
  let draft = 0;
  let pending = 0;
  let approved = 0;

  const byPanel: ProgressCounts["byPanel"] = [];

  for (const r of rows) {
    const expected = r.expected_analytes || 0;
    const entered = r.entered_analytes || 0;

    expectedTotal += expected;

    let pApproved = 0;
    let pPending = 0;
    let pDraft = 0;

    // Map per-panel status to analyte buckets
    const status = (r.panel_status || "").toLowerCase();

    if (r.is_verified || status === "verified") {
      // Treat the whole panel as approved (as per your CASE expression)
      pApproved = expected;
    } else if (status === "complete") {
      // All analytes have values; awaiting verification => all pending
      pPending = expected;
    } else if (status === "partial" || status === "in progress") {
      // Some entered; some not
      pPending = Math.min(entered, expected);
      pDraft = Math.max(expected - pPending, 0);
    } else if (status === "not started" || !r.has_results) {
      // Nothing yet
      pDraft = expected;
    } else {
      // Fallback: be conservative
      pPending = Math.min(entered, expected);
      pDraft = Math.max(expected - pPending, 0);
    }

    draft += pDraft;
    pending += pPending;
    approved += pApproved;

    byPanel.push({
      id: r.order_test_id,
      name: r.test_group_name || "Panel",
      expected,
      draft: pDraft,
      pending: pPending,
      approved: pApproved,
      status: r.panel_status,
    });
  }

  const percent = expectedTotal > 0 ? Math.round((approved / expectedTotal) * 100) : 0;

  return {
    expectedTotal,
    counts: { draft, pending, approved },
    percent,
    byPanel,
  };
}

/* ------------------------ Legacy export (kept for API) --------------------- */
/**
 * DO NOT USE for new code. Kept only so imports don’t break.
 * If you pass `rows`, we aggregate from the view; otherwise returns zeros.
 */
export function computeOrderProgress(_order: any, rows?: ViewRow[]): ProgressCounts {
  if (rows) return computeOrderProgressFromViewRows(rows);
  return {
    expectedTotal: 0,
    counts: { draft: 0, pending: 0, approved: 0 },
    percent: 0,
    byPanel: [],
  };
}

/* ------------------------------- UI component ----------------------------- */
type OrderProgressProps = {
  order: { id: string; status?: string };
  /** Optional: force a specific view name if your schema differs */
  viewNameOverride?: string;
  /** Optional: show per-panel chips under the bar */
  showPanelChips?: boolean;
};

export const OrderProgress: React.FC<OrderProgressProps> = ({
  order,
  viewNameOverride,
  showPanelChips = true,
}) => {
  const [rows, setRows] = useState<ViewRow[] | null>(null);
  const [viewName, setViewName] = useState<string | undefined>();
  const [loadErr, setLoadErr] = useState<string | undefined>();
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    let isMounted = true;
    const run = async () => {
      setLoading(true);
      setLoadErr(undefined);

      if (viewNameOverride) {
        const { data, error } = await supabase
          .from(viewNameOverride)
          .select("*")
          .eq("order_id", order.id);

        if (!isMounted) return;

        if (error) {
          setRows([]);
          setLoadErr(`Progress view "${viewNameOverride}" error: ${error.message || error}`);
        } else {
          setRows((data as ViewRow[]) || []);
          setViewName(viewNameOverride);
        }
        setLoading(false);
        return;
      }

      const { rows, viewName, error } = await fetchOrderProgressRows(order.id);
      if (!isMounted) return;
      setRows(rows);
      setViewName(viewName);
      setLoadErr(error);
      setLoading(false);
    };
    run();
    return () => {
      isMounted = false;
    };
  }, [order.id, viewNameOverride]);

  const progress = useMemo(() => computeOrderProgressFromViewRows(rows || []), [rows]);
  const total = progress.expectedTotal;
  const { approved, pending, draft } = progress.counts;
  const w = (n: number) => (total > 0 ? `${(n / total) * 100}%` : "0%");

  if (DEBUG_PROGRESS) {
    // eslint-disable-next-line no-console
    console.groupCollapsed(
      `%c[PROGRESS] order ${order.id} — VIEW "${viewName || "n/a"}"`,
      "color:#2563eb;font-weight:600"
    );
    // eslint-disable-next-line no-console
    console.log("rows:", rows);
    // eslint-disable-next-line no-console
    console.log("aggregate:", progress);
    // eslint-disable-next-line no-console
    console.groupEnd();
  }

  return (
    <div className="w-full">
      <div className="flex items-center justify-between mb-1 text-sm text-gray-700">
        <span className="font-medium">Progress</span>
        <span className="tabular-nums">
          {loading ? "…" : `${progress.percent}% Complete`}
        </span>
      </div>

      {/* Segmented bar */}
      <div className="w-full h-3 rounded-full bg-gray-200 overflow-hidden border border-gray-300">
        {/* draft */}
        {draft > 0 && <div className="h-full bg-blue-300 inline-block align-top" style={{ width: w(draft) }} />}
        {/* pending */}
        {pending > 0 && <div className="h-full bg-orange-400 inline-block align-top" style={{ width: w(pending) }} />}
        {/* approved */}
        {approved > 0 && <div className="h-full bg-green-500 inline-block align-top" style={{ width: w(approved) }} />}
      </div>

      <div className="mt-1 flex items-center justify-between text-xs text-gray-600">
        <div className="flex items-center gap-3">
          <span><span className="inline-block w-3 h-3 bg-blue-300 rounded-sm mr-1" />Draft: {draft}</span>
          <span><span className="inline-block w-3 h-3 bg-orange-400 rounded-sm mr-1" />Pending: {pending}</span>
          <span><span className="inline-block w-3 h-3 bg-green-500 rounded-sm mr-1" />Approved: {approved}</span>
        </div>
        <span>Total: {total}</span>
      </div>

      {!loading && rows && rows.length === 0 && (
        <div className="mt-2 p-2 rounded bg-yellow-50 border border-yellow-200 text-yellow-800 text-xs flex items-center">
          <AlertTriangle className="h-4 w-4 mr-2" />
          No progress records found for this order. Ensure your SQL view exists and includes this order_id.
        </div>
      )}

      {!loading && loadErr && (
        <div className="mt-2 p-2 rounded bg-red-50 border border-red-200 text-red-700 text-xs">
          {loadErr}
        </div>
      )}

      {/* Optional per-panel chips */}
      {showPanelChips && rows && rows.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {progress.byPanel.map((p) => {
            const txt =
              p.status === "Verified"
                ? `✔ ${p.name} (${p.approved}/${p.expected})`
                : p.status === "Complete"
                ? `⏳ ${p.name} (${p.pending}/${p.expected})`
                : p.status === "Partial" || p.status === "In progress"
                ? `✎ ${p.name} (${p.pending}/${p.expected})`
                : `• ${p.name} (0/${p.expected})`;
            const cls =
              p.status === "Verified"
                ? "bg-green-50 text-green-700 border-green-200"
                : p.status === "Complete"
                ? "bg-orange-50 text-orange-700 border-orange-200"
                : p.status === "Partial" || p.status === "In progress"
                ? "bg-blue-50 text-blue-700 border-blue-200"
                : "bg-gray-50 text-gray-600 border-gray-200";
            return (
              <span
                key={p.id}
                className={`text-[11px] px-2 py-1 rounded-full border ${cls}`}
                title={`${p.status} — expected ${p.expected}, entered ${p.pending + p.approved}, remaining ${p.draft}`}
              >
                {txt}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default OrderProgress;
