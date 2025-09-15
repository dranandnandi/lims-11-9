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
  Clock,
  TrendingUp,
  FileText,
  Zap,
  Activity,
  BarChart3,
  Target,
  Loader2,
  Filter as FilterIcon,
  X,
  ChevronRight
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
  order_date: string;
};

type Analyte = {
  id: string;
  result_id: string;
  parameter: string;
  value: string | null;
  unit: string;
  reference_range: string;
  flag: string | null;
  verify_status: "pending" | "approved" | "rejected" | null;
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
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });

/* =========================================
   Modern Result Verification Console
========================================= */

const ResultVerificationConsole: React.FC = () => {
  // filters
  const [from, setFrom] = useState(fromYesterdayISO());
  const [to, setTo] = useState(todayISO());
  const [q, setQ] = useState("");
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);

  // data
  const [panels, setPanels] = useState<PanelRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // analytes cache by result_id
  const [rowsByResult, setRowsByResult] = useState<Record<string, Analyte[]>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({}); // result_id -> bool
  const [busy, setBusy] = useState<Record<string, boolean>>({});  // small per-row spinner

  // bulk operations
  const [selectedPanels, setSelectedPanels] = useState<Set<string>>(new Set());
  const [bulkProcessing, setBulkProcessing] = useState(false);

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
      // Fallback if verify_* columns do not exist
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

  /* ----------------- Selection handlers ----------------- */
  const togglePanelSelection = (resultId: string) => {
    setSelectedPanels(prev => {
      const newSet = new Set(prev);
      if (newSet.has(resultId)) {
        newSet.delete(resultId);
      } else {
        newSet.add(resultId);
      }
      return newSet;
    });
  };

  const selectAllPanels = () => {
    setSelectedPanels(new Set(filteredPanels.map(p => p.result_id)));
  };

  const clearSelection = () => {
    setSelectedPanels(new Set());
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

  const bulkApproveSelected = async () => {
    if (selectedPanels.size === 0) return;
    
    setBulkProcessing(true);
    const promises = Array.from(selectedPanels).map(resultId => {
      const row = filteredPanels.find(p => p.result_id === resultId);
      return row ? approveAllInPanel(row) : Promise.resolve();
    });
    
    await Promise.all(promises);
    clearSelection();
    setBulkProcessing(false);
  };

  /* ----------------- Stats ----------------- */
  const stats = useMemo(() => {
    const total = panels.length;
    const ready = panels.filter((p) => p.panel_ready).length;
    const pending = panels.filter(
      (p) => !p.panel_ready && p.approved_analytes === 0
    ).length;
    const partial = total - ready - pending;
    const critical = panels.filter(p => 
      rowsByResult[p.result_id]?.some(a => a.flag === 'C' || a.flag === 'Critical')
    ).length;
    
    return { total, ready, partial, pending, critical };
  }, [panels, rowsByResult]);

  /* ----------------- UI Components ----------------- */
  const StatsBadge: React.FC<{ 
    icon: React.FC<any>, 
    label: string, 
    value: number, 
    color: string,
    bgColor: string,
    onClick?: () => void 
  }> = ({ icon: Icon, label, value, color, bgColor, onClick }) => (
    <div 
      className={`${bgColor} rounded-xl p-6 cursor-pointer hover:shadow-md transition-all duration-200 border-2 border-transparent hover:border-${color.split('-')[0]}-200`}
      onClick={onClick}
    >
      <div className="flex items-center justify-between">
        <div>
          <div className={`text-3xl font-bold ${color}`}>{value}</div>
          <div className={`text-sm font-medium ${color.replace('600', '700')}`}>{label}</div>
        </div>
        <div className={`${color.replace('600', '100')} p-3 rounded-full`}>
          <Icon className={`h-6 w-6 ${color}`} />
        </div>
      </div>
    </div>
  );

  const StateBadge: React.FC<{ row: PanelRow }> = ({ row }) => {
    if (row.panel_ready) {
      return (
        <span className="inline-flex items-center px-3 py-1.5 rounded-full text-sm font-semibold bg-gradient-to-r from-green-100 to-emerald-100 text-green-800 border border-green-200 shadow-sm">
          <ShieldCheck className="h-4 w-4 mr-2" />
          Verified
        </span>
      );
    }
    if (row.approved_analytes > 0) {
      return (
        <span className="inline-flex items-center px-3 py-1.5 rounded-full text-sm font-semibold bg-gradient-to-r from-amber-100 to-orange-100 text-amber-800 border border-amber-200 shadow-sm">
          <AlertTriangle className="h-4 w-4 mr-2" />
          Partial ({row.approved_analytes}/{row.expected_analytes})
        </span>
      );
    }
    return (
      <span className="inline-flex items-center px-3 py-1.5 rounded-full text-sm font-semibold bg-gradient-to-r from-red-100 to-pink-100 text-red-800 border border-red-200 shadow-sm">
        <AlertCircle className="h-4 w-4 mr-2" />
        Pending
      </span>
    );
  };

  const AnalyteRowView: React.FC<{ a: Analyte }> = ({ a }) => {
    const status = a.verify_status || "pending";
    const isBusy = !!busy[a.id];

    const getFlagBadge = (flag: string | null) => {
      if (!flag) return null;
      
      const flagConfig = {
        'H': { bg: 'bg-red-100', text: 'text-red-800', label: 'High' },
        'L': { bg: 'bg-blue-100', text: 'text-blue-800', label: 'Low' },
        'C': { bg: 'bg-orange-100', text: 'text-orange-800', label: 'Critical' },
        'Critical': { bg: 'bg-red-100', text: 'text-red-800', label: 'Critical' }
      };
      
      const config = flagConfig[flag as keyof typeof flagConfig] || 
                   { bg: 'bg-gray-100', text: 'text-gray-800', label: flag };
      
      return (
        <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-bold ${config.bg} ${config.text} border`}>
          {config.label}
        </span>
      );
    };

    return (
      <tr className="hover:bg-blue-50 transition-colors">
        <td className="px-4 py-4">
          <div className="font-semibold text-gray-900">{a.parameter}</div>
          {a.value && (
            <div className="text-sm text-gray-600 mt-1">
              Last updated: {a.verified_at ? new Date(a.verified_at).toLocaleString() : 'Never'}
            </div>
          )}
        </td>
        <td className="px-4 py-4">
          <div className="font-bold text-lg text-gray-900">{a.value ?? "—"}</div>
        </td>
        <td className="px-4 py-4">
          <span className="font-medium text-gray-700">{a.unit}</span>
        </td>
        <td className="px-4 py-4">
          <div className="text-sm text-gray-600 max-w-xs">
            {a.reference_range}
          </div>
        </td>
        <td className="px-4 py-4">
          {getFlagBadge(a.flag)}
        </td>
        <td className="px-4 py-4">
          <div className="flex items-center space-x-3">
            {status === "approved" ? (
              <span className="inline-flex items-center px-4 py-2 rounded-lg text-sm font-semibold bg-gradient-to-r from-green-600 to-emerald-600 text-white shadow-sm">
                <CheckSquare className="h-4 w-4 mr-2" /> 
                Approved
              </span>
            ) : (
              <div className="flex items-center space-x-2">
                <button
                  disabled={isBusy}
                  onClick={() => approveAnalyte(a.id)}
                  className="inline-flex items-center px-3 py-2 rounded-lg text-sm font-semibold bg-gradient-to-r from-green-500 to-emerald-500 text-white hover:from-green-600 hover:to-emerald-600 transition-all duration-200 shadow-sm disabled:opacity-50"
                >
                  {isBusy ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <CheckCircle2 className="h-4 w-4 mr-2" />
                  )}
                  Approve
                </button>

                <button
                  disabled={isBusy}
                  onClick={() => rejectAnalyte(a.id)}
                  className={`inline-flex items-center px-3 py-2 rounded-lg text-sm font-semibold transition-all duration-200 shadow-sm ${
                    status === "rejected" 
                      ? "bg-gradient-to-r from-red-600 to-rose-600 text-white" 
                      : "bg-gradient-to-r from-red-100 to-rose-100 text-red-700 hover:from-red-200 hover:to-rose-200"
                  }`}
                >
                  <XCircle className="h-4 w-4 mr-2" />
                  {status === "rejected" ? "Rejected" : "Reject"}
                </button>
              </div>
            )}
          </div>

          {a.verify_note && (
            <div className="text-xs text-gray-500 mt-2 italic bg-gray-50 p-2 rounded border">
              Note: {a.verify_note}
            </div>
          )}
        </td>
      </tr>
    );
  };

  const PanelCard: React.FC<{ row: PanelRow }> = ({ row }) => {
    const isOpen = !!open[row.result_id];
    const analytes = rowsByResult[row.result_id] || [];
    const isSelected = selectedPanels.has(row.result_id);
    const pct = row.expected_analytes > 0
      ? Math.round((row.approved_analytes / row.expected_analytes) * 100)
      : 0;

    return (
      <div className={`border-2 rounded-2xl bg-white shadow-sm hover:shadow-lg transition-all duration-300 ${
        isSelected ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:border-gray-300'
      }`}>
        {/* Header */}
        <div className="p-6 border-b border-gray-100">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-4">
              <input
                type="checkbox"
                checked={isSelected}
                onChange={() => togglePanelSelection(row.result_id)}
                className="w-5 h-5 rounded-md border-2 border-gray-300 text-blue-600 focus:ring-blue-500 focus:ring-2"
              />
              
              <div className="flex items-center space-x-4">
                <div className="bg-gradient-to-br from-blue-500 to-indigo-600 p-3 rounded-xl shadow-sm">
                  <User className="h-6 w-6 text-white" />
                </div>
                <div>
                  <h3 className="text-xl font-bold text-gray-900">
                    {row.patient_name}
                  </h3>
                  <div className="flex items-center space-x-3 text-sm text-gray-600">
                    <span className="flex items-center">
                      <Calendar className="h-4 w-4 mr-1" />
                      {fmtDate(row.order_date)}
                    </span>
                    <span className="flex items-center">
                      <FileText className="h-4 w-4 mr-1" />
                      #{row.order_id.slice(-8)}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex items-center space-x-4">
              <div className="text-right">
                <div className="text-sm text-gray-600 mb-1">Progress</div>
                <div className="flex items-center space-x-3">
                  <div className="text-lg font-bold text-gray-900">
                    {row.approved_analytes}/{row.expected_analytes}
                  </div>
                  <div className="w-24 bg-gray-200 h-3 rounded-full overflow-hidden">
                    <div
                      className={`h-3 rounded-full transition-all duration-500 ${
                        pct >= 100 ? 'bg-gradient-to-r from-green-500 to-emerald-500' : 
                        pct >= 50 ? 'bg-gradient-to-r from-amber-500 to-orange-500' :
                        'bg-gradient-to-r from-red-500 to-rose-500'
                      }`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="text-sm font-semibold text-gray-700">{pct}%</span>
                </div>
              </div>

              <StateBadge row={row} />

              <button
                onClick={() => toggleOpen(row)}
                className="p-3 rounded-xl hover:bg-gray-100 transition-colors"
                aria-label="Toggle panel details"
              >
                {isOpen ? (
                  <ChevronUp className="h-6 w-6 text-gray-600" />
                ) : (
                  <ChevronDown className="h-6 w-6 text-gray-600" />
                )}
              </button>
            </div>
          </div>

          <div className="mt-4 flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <TestTube className="h-5 w-5 text-gray-500" />
              <span className="text-lg font-semibold text-gray-900">
                {row.test_group_name}
              </span>
              <span className="text-sm text-gray-500">
                ({row.expected_analytes} analytes)
              </span>
            </div>

            {!isOpen && (
              <button
                disabled={busy[row.result_id]}
                onClick={() => approveAllInPanel(row)}
                className="inline-flex items-center px-4 py-2 bg-gradient-to-r from-green-600 to-emerald-600 text-white rounded-xl hover:from-green-700 hover:to-emerald-700 transition-all duration-200 shadow-sm font-semibold disabled:opacity-50"
              >
                {busy[row.result_id] ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <CheckCircle2 className="h-4 w-4 mr-2" />
                )}
                Approve All
              </button>
            )}
          </div>
        </div>

        {/* Expanded content */}
        {isOpen && (
          <div className="p-6 bg-gray-50">
            <div className="mb-6 flex items-center justify-between">
              <div className="text-sm text-gray-600">
                <span className="font-semibold">Entered:</span> {row.entered_analytes} • 
                <span className="font-semibold ml-2">Approved:</span> {row.approved_analytes}
              </div>
              <button
                disabled={busy[row.result_id]}
                onClick={() => approveAllInPanel(row)}
                className="inline-flex items-center px-6 py-3 bg-gradient-to-r from-green-600 to-emerald-600 text-white rounded-xl hover:from-green-700 hover:to-emerald-700 transition-all duration-200 shadow-lg font-semibold disabled:opacity-50"
              >
                {busy[row.result_id] ? (
                  <Loader2 className="h-5 w-5 mr-2 animate-spin" />
                ) : (
                  <CheckCircle2 className="h-5 w-5 mr-2" />
                )}
                Approve All Analytes
              </button>
            </div>

            <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
              <table className="min-w-full">
                <thead className="bg-gradient-to-r from-gray-50 to-gray-100">
                  <tr>
                    <th className="px-4 py-4 text-left text-sm font-bold text-gray-700 uppercase tracking-wider">
                      Analyte
                    </th>
                    <th className="px-4 py-4 text-left text-sm font-bold text-gray-700 uppercase tracking-wider">
                      Value
                    </th>
                    <th className="px-4 py-4 text-left text-sm font-bold text-gray-700 uppercase tracking-wider">
                      Unit
                    </th>
                    <th className="px-4 py-4 text-left text-sm font-bold text-gray-700 uppercase tracking-wider">
                      Reference Range
                    </th>
                    <th className="px-4 py-4 text-left text-sm font-bold text-gray-700 uppercase tracking-wider">
                      Flag
                    </th>
                    <th className="px-4 py-4 text-left text-sm font-bold text-gray-700 uppercase tracking-wider">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
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

  /* ----------------- Date Preset Functions ----------------- */
  const setDateRange = (days: number) => {
    const to = new Date();
    const from = new Date();
    from.setDate(to.getDate() - days);
    
    setTo(to.toISOString().split('T')[0]);
    setFrom(from.toISOString().split('T')[0]);
  };

  const setToday = () => {
    const today = new Date().toISOString().split('T')[0];
    setFrom(today);
    setTo(today);
  };

  /* ----------------- Render ----------------- */

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 to-blue-50">
      {/* Modern Header */}
      <div className="bg-white shadow-sm border-b">
        <div className="max-w-7xl mx-auto px-6 py-8">
          <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-6">
            <div>
              <h1 className="text-4xl font-bold text-gray-900 mb-2">
                Result Verification Console
              </h1>
              <p className="text-lg text-gray-600">
                High-performance analyte verification with intelligent workflows
              </p>
              <div className="flex items-center space-x-4 mt-3">
                <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-blue-100 text-blue-800">
                  <Activity className="h-4 w-4 mr-2" />
                  Real-time Processing
                </span>
                <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-purple-100 text-purple-800">
                  <Target className="h-4 w-4 mr-2" />
                  Batch Operations
                </span>
              </div>
            </div>

            <div className="flex items-center space-x-4">
              <button
                onClick={loadPanels}
                className="inline-flex items-center px-6 py-3 bg-white border-2 border-gray-300 rounded-xl hover:border-gray-400 hover:shadow-md transition-all duration-200 font-semibold"
                title="Refresh data"
              >
                <RefreshCcw className={`h-5 w-5 mr-2 ${loading ? "animate-spin text-blue-600" : "text-gray-600"}`} />
                Refresh
              </button>
              
              {selectedPanels.size > 0 && (
                <button
                  onClick={bulkApproveSelected}
                  disabled={bulkProcessing}
                  className="inline-flex items-center px-6 py-3 bg-gradient-to-r from-green-600 to-emerald-600 text-white rounded-xl hover:from-green-700 hover:to-emerald-700 transition-all duration-200 shadow-lg font-semibold disabled:opacity-50"
                >
                  {bulkProcessing ? (
                    <Loader2 className="h-5 w-5 mr-2 animate-spin" />
                  ) : (
                    <Zap className="h-5 w-5 mr-2" />
                  )}
                  Bulk Approve ({selectedPanels.size})
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-6 py-8 space-y-8">
        {/* Statistics Dashboard */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          <StatsBadge
            icon={BarChart3}
            label="Total Panels"
            value={stats.total}
            color="text-blue-600"
            bgColor="bg-gradient-to-br from-blue-50 to-indigo-100"
            onClick={() => setStateFilter('all')}
          />
          <StatsBadge
            icon={CheckCircle2}
            label="Verified"
            value={stats.ready}
            color="text-green-600"
            bgColor="bg-gradient-to-br from-green-50 to-emerald-100"
            onClick={() => setStateFilter('ready')}
          />
          <StatsBadge
            icon={Clock}
            label="Partial"
            value={stats.partial}
            color="text-amber-600"
            bgColor="bg-gradient-to-br from-amber-50 to-orange-100"
            onClick={() => setStateFilter('partial')}
          />
          <StatsBadge
            icon={AlertTriangle}
            label="Pending"
            value={stats.pending}
            color="text-red-600"
            bgColor="bg-gradient-to-br from-red-50 to-rose-100"
            onClick={() => setStateFilter('pending')}
          />
        </div>

        {/* Enhanced Filters */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
          <div className="p-6 border-b border-gray-100">
            <div className="flex flex-col lg:flex-row gap-4">
              {/* Search Bar */}
              <div className="flex-1 relative">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400" />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search patients, tests, or order IDs..."
                  className="w-full pl-12 pr-4 py-4 text-lg border-2 border-gray-200 rounded-xl focus:border-blue-500 focus:ring-4 focus:ring-blue-100 transition-all duration-200"
                />
                {q && (
                  <button
                    onClick={() => setQ('')}
                    className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  >
                    <X className="h-5 w-5" />
                  </button>
                )}
              </div>

              {/* Quick Filters */}
              <div className="flex items-center space-x-3">
                <select
                  value={stateFilter}
                  onChange={(e) => setStateFilter(e.target.value as StateFilter)}
                  className="px-4 py-4 border-2 border-gray-200 rounded-xl focus:border-blue-500 focus:ring-4 focus:ring-blue-100 text-lg font-medium"
                >
                  <option value="all">All Status</option>
                  <option value="pending">Pending Only</option>
                  <option value="partial">Partial Only</option>
                  <option value="ready">Verified Only</option>
                </select>

                <button
                  onClick={() => setShowAdvancedFilters(!showAdvancedFilters)}
                  className={`inline-flex items-center px-4 py-4 border-2 rounded-xl transition-all duration-200 font-semibold ${
                    showAdvancedFilters 
                      ? 'bg-blue-100 border-blue-300 text-blue-700' 
                      : 'border-gray-300 text-gray-700 hover:border-gray-400 hover:bg-gray-50'
                  }`}
                >
                  <FilterIcon className="h-5 w-5 mr-2" />
                  Advanced
                  {showAdvancedFilters ? (
                    <ChevronUp className="h-4 w-4 ml-2" />
                  ) : (
                    <ChevronDown className="h-4 w-4 ml-2" />
                  )}
                </button>
              </div>
            </div>

            {/* Advanced Filters Panel */}
            {showAdvancedFilters && (
              <div className="mt-6 pt-6 border-t border-gray-100">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  <div>
                    <label className="block text-sm font-semibold text-gray-700 mb-3">Date Range</label>
                    <div className="space-y-3">
                      <div className="flex items-center space-x-2">
                        <Calendar className="h-4 w-4 text-gray-500" />
                        <input
                          type="date"
                          value={from}
                          onChange={(e) => setFrom(e.target.value)}
                          className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                        />
                      </div>
                      <div className="text-center text-gray-500 text-sm">to</div>
                      <div className="flex items-center space-x-2">
                        <Calendar className="h-4 w-4 text-gray-500" />
                        <input
                          type="date"
                          value={to}
                          onChange={(e) => setTo(e.target.value)}
                          className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                        />
                      </div>
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-semibold text-gray-700 mb-3">Quick Presets</label>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        onClick={setToday}
                        className="px-3 py-2 text-sm bg-blue-100 text-blue-700 rounded-lg hover:bg-blue-200 transition-colors font-medium"
                      >
                        Today
                      </button>
                      <button
                        onClick={() => setDateRange(7)}
                        className="px-3 py-2 text-sm bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors font-medium"
                      >
                        7 Days
                      </button>
                      <button
                        onClick={() => setDateRange(30)}
                        className="px-3 py-2 text-sm bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors font-medium"
                      >
                        30 Days
                      </button>
                      <button
                        onClick={() => setDateRange(90)}
                        className="px-3 py-2 text-sm bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors font-medium"
                      >
                        90 Days
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-semibold text-gray-700 mb-3">Bulk Actions</label>
                    <div className="space-y-2">
                      <button
                        onClick={selectAllPanels}
                        disabled={filteredPanels.length === 0}
                        className="w-full px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium disabled:opacity-50"
                      >
                        Select All ({filteredPanels.length})
                      </button>
                      <button
                        onClick={clearSelection}
                        disabled={selectedPanels.size === 0}
                        className="w-full px-4 py-2 text-sm border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors font-medium disabled:opacity-50"
                      >
                        Clear Selection
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Selection Summary */}
        {selectedPanels.size > 0 && (
          <div className="bg-gradient-to-r from-blue-600 to-indigo-600 rounded-2xl p-6 text-white shadow-lg">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-4">
                <div className="bg-white/20 p-3 rounded-xl">
                  <CheckSquare className="h-6 w-6" />
                </div>
                <div>
                  <div className="text-xl font-bold">
                    {selectedPanels.size} panel{selectedPanels.size !== 1 ? 's' : ''} selected
                  </div>
                  <div className="text-blue-100">
                    Ready for bulk verification operations
                  </div>
                </div>
              </div>
              <div className="flex items-center space-x-3">
                <button
                  onClick={clearSelection}
                  className="px-4 py-2 bg-white/20 text-white rounded-lg hover:bg-white/30 transition-colors font-medium"
                >
                  Clear
                </button>
                <button
                  onClick={bulkApproveSelected}
                  disabled={bulkProcessing}
                  className="px-6 py-3 bg-white text-blue-600 rounded-xl hover:bg-gray-50 transition-colors font-bold shadow-sm disabled:opacity-50"
                >
                  {bulkProcessing ? (
                    <Loader2 className="h-5 w-5 mr-2 animate-spin inline" />
                  ) : (
                    <Zap className="h-5 w-5 mr-2 inline" />
                  )}
                  Approve Selected
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Error Display */}
        {err && (
          <div className="bg-red-50 border-2 border-red-200 rounded-2xl p-6">
            <div className="flex items-center">
              <AlertTriangle className="h-6 w-6 text-red-600 mr-3" />
              <div>
                <h3 className="text-lg font-semibold text-red-900">Error Loading Data</h3>
                <p className="text-red-700">{err}</p>
              </div>
            </div>
          </div>
        )}

        {/* Loading State */}
        {loading && (
          <div className="space-y-6">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="bg-white rounded-2xl border border-gray-200 p-6 animate-pulse">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center space-x-4">
                    <div className="w-12 h-12 bg-gray-200 rounded-xl"></div>
                    <div className="space-y-2">
                      <div className="h-6 bg-gray-200 rounded w-48"></div>
                      <div className="h-4 bg-gray-200 rounded w-32"></div>
                    </div>
                  </div>
                  <div className="h-8 w-24 bg-gray-200 rounded-full"></div>
                </div>
                <div className="h-4 bg-gray-200 rounded w-full"></div>
              </div>
            ))}
          </div>
        )}

        {/* Empty State */}
        {!loading && filteredPanels.length === 0 && (
          <div className="bg-white rounded-2xl border-2 border-dashed border-gray-300 p-12 text-center">
            <div className="mx-auto w-24 h-24 bg-gray-100 rounded-full flex items-center justify-center mb-6">
              <TestTube className="w-12 h-12 text-gray-400" />
            </div>
            <h3 className="text-2xl font-bold text-gray-900 mb-3">No Results Found</h3>
            <p className="text-gray-600 mb-6 max-w-md mx-auto text-lg">
              No verification results match your current filters for the selected date range.
            </p>
            <div className="flex justify-center space-x-4">
              <button
                onClick={() => {
                  setQ('');
                  setStateFilter('all');
                  setShowAdvancedFilters(false);
                }}
                className="px-6 py-3 bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition-colors font-semibold"
              >
                Clear All Filters
              </button>
              <button
                onClick={loadPanels}
                className="px-6 py-3 border-2 border-gray-300 text-gray-700 rounded-xl hover:border-gray-400 hover:bg-gray-50 transition-colors font-semibold"
              >
                Refresh Data
              </button>
            </div>
          </div>
        )}

        {/* Results Grid */}
        {!loading && filteredPanels.length > 0 && (
          <div className="space-y-6">
            {/* Results Header */}
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-2xl font-bold text-gray-900">
                  Verification Queue
                </h2>
                <p className="text-gray-600 mt-1">
                  {filteredPanels.length} panel{filteredPanels.length !== 1 ? 's' : ''} found
                </p>
              </div>
              
              {selectedPanels.size === 0 && (
                <div className="flex items-center space-x-2 text-sm text-gray-500">
                  <span>Select panels for bulk operations</span>
                  <ChevronRight className="h-4 w-4" />
                </div>
              )}
            </div>

            {/* Panel Cards */}
            <div className="space-y-6">
              {filteredPanels.map((row) => (
                <PanelCard key={row.result_id} row={row} />
              ))}
            </div>
          </div>
        )}

        {/* Modern Footer */}
        <div className="bg-gradient-to-r from-gray-900 to-gray-800 rounded-2xl p-6 text-white shadow-xl">
          <div className="flex flex-col md:flex-row items-center justify-between gap-4">
            <div className="flex items-center space-x-6">
              <div className="flex items-center">
                <TrendingUp className="h-5 w-5 mr-2 text-blue-400" />
                <span className="font-semibold">
                  Performance: {stats.ready > 0 ? Math.round((stats.ready / stats.total) * 100) : 0}% verified
                </span>
              </div>
              <div className="flex items-center">
                <Clock className="h-5 w-5 mr-2 text-green-400" />
                <span className="font-semibold">
                  Date Range: {fmtDate(from)} - {fmtDate(to)}
                </span>
              </div>
            </div>
            <div className="text-sm text-gray-300">
              Last updated: {new Date().toLocaleTimeString()}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ResultVerificationConsole;