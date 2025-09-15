import React, { useEffect, useMemo, useState } from "react";
import {
  Search,
  Filter,
  Calendar,
  ChevronDown,
  ChevronUp,
  User,
  TestTube,
  ShieldCheck,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  CheckSquare,
  Square,
  RefreshCcw,
  AlertCircle,
} from "lucide-react";
import { supabase } from "../utils/supabase";

/* =========================================
   Types
========================================= */

type PanelRow = {
  order_id: string;
  result_id: string;
  test_group_id: string | null;
  test_group_name: string | null;
  expected_analytes: number;
  entered_analytes: number;
  approved_analytes: number;
  panel_ready: boolean;
  patient_id: string;
  patient_name: string;
  order_date: string; // ISO date
};

type Analyte = {
  id: string; // result_values.id
  result_id: string;
  parameter: string;
  value: string | null;
  unit: string;
  reference_range: string;
  flag: string | null;
  verify_status: "pending" | "approved" | "rejected" | null; // null treated as pending
  verify_note: string | null;
  verified_by: string | null;
  verified_at: string | null;
};

type StateFilter = "all" | "pending" | "partial" | "ready";

/* =========================================
   Helpers
========================================= */

const todayISO = () => new Date().toISOString().slice(0, 10);
const fromYesterdayISO = () => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
};

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-IN", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

/* =========================================
   Page
========================================= */

const ResultVerificationConsole: React.FC = () => {
  // filters
  const [from, setFrom] = useState(fromYesterdayISO());
  const [to, setTo] = useState(todayISO());
  const [q, setQ] = useState("");
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");

  // data
  const [panels, setPanels] = useState<PanelRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // analytes cache by result_id
  const [rowsByResult, setRowsByResult] = useState<Record<string, Analyte[]>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({}); // result_id -> bool
  const [busy, setBusy] = useState<Record<string, boolean>>({});  // small per-row spinner

  /* ----------------- Load panels ----------------- */
  const loadPanels = async () => {
    setLoading(true);
    setErr(null);
    const { data, error } = await supabase
      .from("v_result_panel_status")
      .select("*")
      .gte("order_date", from)
      .lte("order_date", to)
      .order("order_date", { ascending: false });

    if (error) {
      setErr(error.message);
      setPanels([]);
    } else {
      setPanels((data || []) as PanelRow[]);
    }
    setLoading(false);
  };

  useEffect(() => {
    loadPanels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to]);

  /* ----------------- Filter panels ----------------- */
  const filteredPanels = useMemo(() => {
    const k = q.trim().toLowerCase();

    let list = panels;
    if (k) {
      list = list.filter(
        (r) =>
          (r.patient_name || "").toLowerCase().includes(k) ||
          (r.test_group_name || "").toLowerCase().includes(k) ||
          (r.order_id || "").toLowerCase().includes(k)
      );
    }

    if (stateFilter === "ready") {
      list = list.filter((r) => r.panel_ready);
    } else if (stateFilter === "pending") {
      list = list.filter((r) => !r.panel_ready && (r.approved_analytes || 0) === 0);
    } else if (stateFilter === "partial") {
      list = list.filter(
        (r) => !r.panel_ready && r.approved_analytes > 0 && r.approved_analytes < r.expected_analytes
      );
    }

    return list;
  }, [panels, q, stateFilter]);

  /* ----------------- Load analytes for panel ----------------- */
  const ensureAnalytesLoaded = async (result_id: string) => {
    if (rowsByResult[result_id]) return;

    const { data, error } = await supabase
      .from("result_values")
      .select(
        [
          "id",
          "result_id",
          "parameter",
          "value",
          "unit",
          "reference_range",
          "flag",
          "verify_status",
          "verify_note",
          "verified_by",
          "verified_at",
        ].join(",")
      )
      .eq("result_id", result_id)
      .order("parameter", { ascending: true });

    if (!error) {
      setRowsByResult((s) => ({ ...s, [result_id]: (data || []) as Analyte[] }));
    } else {
      // Fallback if verify_* columns do not exist (treat as pending)
      if (String(error.message || "").includes("column") && String(error.message).includes("verify_status")) {
        const { data: data2, error: e2 } = await supabase
          .from("result_values")
          .select("id,result_id,parameter,value,unit,reference_range,flag")
          .eq("result_id", result_id)
          .order("parameter", { ascending: true });

        if (!e2) {
          const mapped = (data2 || []).map((r: any) => ({
            id: r.id,
            result_id: r.result_id,
            parameter: r.parameter,
            value: r.value,
            unit: r.unit,
            reference_range: r.reference_range,
            flag: r.flag,
            verify_status: "pending",
            verify_note: null,
            verified_by: null,
            verified_at: null,
          })) as Analyte[];
          setRowsByResult((s) => ({ ...s, [result_id]: mapped }));
        }
      }
    }
  };

  const toggleOpen = async (row: PanelRow) => {
    const k = row.result_id;
    setOpen((s) => ({ ...s, [k]: !s[k] }));
    if (!rowsByResult[k]) await ensureAnalytesLoaded(k);
  };

  /* ----------------- Mutations ----------------- */

  const setBusyFor = (key: string, v: boolean) => setBusy((s) => ({ ...s, [key]: v }));

  const approveAnalyte = async (rv_id: string) => {
    setBusyFor(rv_id, true);
    const { error } = await supabase
      .from("result_values")
      .update({ verify_status: "approved", verified_at: new Date().toISOString() })
      .eq("id", rv_id);
    setBusyFor(rv_id, false);

    if (!error) {
      // update client cache
      setRowsByResult((s) => {
        const next = { ...s };
        for (const rid in next) {
          next[rid] = next[rid].map((a) => (a.id === rv_id ? { ...a, verify_status: "approved" } : a));
        }
        return next;
      });
      await loadPanels();
    }
  };

  const rejectAnalyte = async (rv_id: string) => {
    const note = prompt("Add a note (optional)", "") ?? null;
    setBusyFor(rv_id, true);
    const { error } = await supabase
      .from("result_values")
      .update({
        verify_status: "rejected",
        verify_note: note && note.length ? note : null,
        verified_at: new Date().toISOString(),
      })
      .eq("id", rv_id);
    setBusyFor(rv_id, false);

    if (!error) {
      setRowsByResult((s) => {
        const next = { ...s };
        for (const rid in next) {
          next[rid] = next[rid].map((a) => (a.id === rv_id ? { ...a, verify_status: "rejected", verify_note: note } : a));
        }
        return next;
      });
      await loadPanels();
    }
  };

  const approveAllInPanel = async (row: PanelRow) => {
    const list = rowsByResult[row.result_id] || [];
    if (!list.length) return;
    const ids = list.map((a) => a.id);
    setBusyFor(row.result_id, true);
    const { error } = await supabase
      .from("result_values")
      .update({ verify_status: "approved", verified_at: new Date().toISOString() })
      .in("id", ids);

    if (!error) {
      setRowsByResult((s) => ({
        ...s,
        [row.result_id]: (s[row.result_id] || []).map((a) => ({ ...a, verify_status: "approved" })),
      }));
      
      // Finalize the panel
      await supabase.rpc('finalize_panel', { p_result_id: row.result_id });
      await loadPanels();
    }
    setBusyFor(row.result_id, false);
  };

  /* ----------------- UI subcomponents ----------------- */

  const StateBadge: React.FC<{ row: PanelRow }> = ({ row }) => {
    if (row.panel_ready) {
      return (
        <span className="ml-2 inline-flex items-center text-xs bg-green-50 text-green-700 border border-green-200 px-2 py-0.5 rounded-full">
          <ShieldCheck className="h-3 w-3 mr-1" />
          Ready
        </span>
      );
    }
    if (row.approved_analytes > 0) {
      return (
        <span className="ml-2 inline-flex items-center text-xs bg-amber-50 text-amber-800 border border-amber-200 px-2 py-0.5 rounded-full">
          <AlertTriangle className="h-3 w-3 mr-1" />
          Partial
        </span>
      );
    }
    return (
      <span className="ml-2 inline-flex items-center text-xs bg-gray-100 text-gray-700 border border-gray-200 px-2 py-0.5 rounded-full">
        <AlertCircle className="h-3 w-3 mr-1" />
        Pending
      </span>
    );
  };

  const AnalyteRowView: React.FC<{ a: Analyte }> = ({ a }) => {
    const status = a.verify_status || "pending";
    const isBusy = !!busy[a.id];

    return (
      <tr className="hover:bg-gray-50">
        <td className="px-3 py-2 font-medium">{a.parameter}</td>
        <td className="px-3 py-2 font-semibold">{a.value ?? "—"}</td>
        <td className="px-3 py-2">{a.unit}</td>
        <td className="px-3 py-2">{a.reference_range}</td>
        <td className="px-3 py-2">
          {a.flag && (
            <span
              className={`px-2 py-0.5 rounded text-xs ${
                a.flag === "H" || a.flag === "L" || a.flag === "C"
                  ? "bg-red-100 text-red-700"
                  : "bg-gray-100 text-gray-700"
              }`}
            >
              {a.flag}
            </span>
          )}
        </td>
        <td className="px-3 py-2">
          {status === "approved" ? (
            <span className="inline-flex items-center text-xs px-2 py-1 rounded bg-green-600 text-white">
              <CheckSquare className="h-4 w-4 mr-1" /> Approved
            </span>
          ) : (
            <div className="flex items-center gap-2">
              <button
                disabled={isBusy}
                onClick={() => approveAnalyte(a.id)}
                className="inline-flex items-center text-xs px-2 py-1 rounded bg-green-50 text-green-700 hover:bg-green-100"
                title="Approve"
              >
                <CheckCircle2 className="h-4 w-4 mr-1" />
                Approve
              </button>

              <button
                disabled={isBusy}
                onClick={() => rejectAnalyte(a.id)}
                className={`inline-flex items-center text-xs px-2 py-1 rounded ${
                  status === "rejected" ? "bg-rose-600 text-white" : "bg-rose-50 text-rose-700 hover:bg-rose-100"
                }`}
                title="Reject"
              >
                <XCircle className="h-4 w-4 mr-1" />
                Reject
              </button>
            </div>
          )}

          {a.verify_note && (
            <div className="text-[11px] text-gray-500 mt-1">Note: {a.verify_note}</div>
          )}
        </td>
      </tr>
    );
  };

  const PanelCard: React.FC<{ row: PanelRow }> = ({ row }) => {
    const isOpen = !!open[row.result_id];
    const analytes = rowsByResult[row.result_id] || [];
    const pct =
      row.expected_analytes > 0
        ? Math.round((row.approved_analytes / row.expected_analytes) * 100)
        : 0;

    return (
      <div className="border rounded-xl bg-white p-4">
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <User className="h-4 w-4 text-blue-600" />
              <span className="font-semibold text-gray-900">
                {row.patient_name}
              </span>
              <span className="text-xs text-gray-500">
                • {new Date(row.order_date).toLocaleDateString()}
              </span>
            </div>

            <div className="mt-1 flex items-center gap-2">
              <TestTube className="h-4 w-4 text-gray-500" />
              <span className="text-sm text-gray-700">
                {row.test_group_name}
              </span>
              <StateBadge row={row} />
            </div>
          </div>

          <div className="text-right">
            <div className="text-sm text-gray-600">
              {row.approved_analytes}/{row.expected_analytes} approved
            </div>
            <div className="w-44 bg-gray-200 h-2 rounded-full overflow-hidden mt-1">
              <div
                className="h-2"
                style={{
                  width: `${pct}%`,
                  background: pct >= 100 ? "#16a34a" : "#f59e0b",
                }}
              />
            </div>
          </div>

          <button
            onClick={() => toggleOpen(row)}
            className="p-1 rounded hover:bg-gray-100"
            aria-label="Toggle panel"
          >
            {isOpen ? (
              <ChevronUp className="h-5 w-5" />
            ) : (
              <ChevronDown className="h-5 w-5" />
            )}
          </button>
        </div>

        {/* Expanded content */}
        {isOpen && (
          <div className="mt-4">
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm text-gray-600">
                Entered: {row.entered_analytes} • Approved: {row.approved_analytes}
              </div>
              <button
                disabled={busy[row.result_id]}
                onClick={() => approveAllInPanel(row)}
                className="inline-flex items-center text-xs px-3 py-1.5 bg-green-600 text-white rounded hover:bg-green-700"
              >
                <CheckCircle2 className="h-3 w-3 mr-1" />
                Approve all
              </button>
            </div>

            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-3 py-2 text-left">Analyte</th>
                    <th className="px-3 py-2 text-left">Value</th>
                    <th className="px-3 py-2 text-left">Unit</th>
                    <th className="px-3 py-2 text-left">Reference</th>
                    <th className="px-3 py-2 text-left">Flag</th>
                    <th className="px-3 py-2 text-left">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {analytes.map((a) => (
                    <AnalyteRowView key={a.id} a={a} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    );
  };

  /* ----------------- Stats ----------------- */
  const stats = useMemo(() => {
    const total = panels.length;
    const ready = panels.filter((p) => p.panel_ready).length;
    const pending = panels.filter(
      (p) => !p.panel_ready && p.approved_analytes === 0
    ).length;
    const partial = total - ready - pending;
    return { total, ready, partial, pending };
  }, [panels]);

  /* ----------------- Render ----------------- */

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">
            Result Verification (Analyte-wise)
          </h1>
          <p className="text-sm text-gray-600">
            Approve/reject per analyte • Bulk approve per test-group • Live
            progress
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={loadPanels}
            className="inline-flex items-center px-3 py-2 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
            title="Refresh"
          >
            <RefreshCcw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {/* Filters row */}
      <div className="bg-white border rounded-lg p-3 flex flex-col gap-3 md:flex-row md:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search patient / order / test…"
            className="w-full pl-9 pr-3 py-2 border rounded"
          />
        </div>

        <div className="flex items-center gap-2">
          <Calendar className="h-4 w-4 text-gray-500" />
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="border rounded px-2 py-1"
          />
          <span className="text-gray-500">to</span>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="border rounded px-2 py-1"
          />
        </div>

        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-gray-500" />
          <select
            value={stateFilter}
            onChange={(e) => setStateFilter(e.target.value as StateFilter)}
            className="border rounded px-2 py-1"
          >
            <option value="all">All</option>
            <option value="pending">Pending</option>
            <option value="partial">Partial</option>
            <option value="ready">Ready</option>
          </select>
        </div>
      </div>

      {/* Quick stats */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
        <div className="rounded-lg border bg-white p-4">
          <div className="text-2xl font-bold text-gray-900">{stats.total}</div>
          <div className="text-sm text-gray-600">Total panels</div>
        </div>
        <div className="rounded-lg border bg-green-50 border-green-200 p-4">
          <div className="text-2xl font-bold text-green-900">{stats.ready}</div>
          <div className="text-sm text-green-700">Ready</div>
        </div>
        <div className="rounded-lg border bg-amber-50 border-amber-200 p-4">
          <div className="text-2xl font-bold text-amber-900">{stats.partial}</div>
          <div className="text-sm text-amber-700">Partial</div>
        </div>
        <div className="rounded-lg border bg-gray-50 border-gray-200 p-4">
          <div className="text-2xl font-bold text-gray-900">{stats.pending}</div>
          <div className="text-sm text-gray-700">Pending</div>
        </div>
      </div>

      {/* Body */}
      {err && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 text-rose-800 p-3">
          {err}
        </div>
      )}

      {loading && (
        <div className="rounded-lg border bg-white p-6 text-gray-600">
          Loading…
        </div>
      )}

      {!loading && filteredPanels.length === 0 && (
        <div className="rounded-lg border bg-white p-10 text-center text-gray-500">
          No results found for selected range.
        </div>
      )}

      <div className="grid grid-cols-1 gap-4">
        {filteredPanels.map((row) => (
          <PanelCard key={row.result_id} row={row} />
        ))}
      </div>
    </div>
  );
};

export default ResultVerificationConsole;
