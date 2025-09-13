// src/pages/Orders.tsx
import React, { useEffect, useMemo, useState } from "react";
import {
  Plus, Search, Filter, Clock as ClockIcon, CheckCircle, AlertTriangle,
  Eye, User, Calendar, TestTube, ChevronDown, ChevronUp, TrendingUp
} from "lucide-react";
import { useAuth } from "../contexts/AuthContext";
import { supabase } from "../utils/supabase";
import OrderForm from "../components/Orders/OrderForm";
import OrderDetailsModal from "../components/Orders/OrderDetailsModal";

/* ===========================
   Types
=========================== */

type OrderStatus =
  | "Order Created"
  | "Sample Collection"
  | "In Progress"
  | "Pending Approval"
  | "Completed"
  | "Delivered";

type Priority = "Normal" | "Urgent" | "STAT";

type ProgressRow = {
  order_id: string;
  test_group_id: string | null;
  test_group_name: string | null;
  expected_analytes: number;
  entered_analytes: number;
  total_values: number;
  has_results: boolean;
  is_verified: boolean;
  panel_status: "Not started" | "In progress" | "Partial" | "Complete" | "Verified";
};

type OrderRow = {
  id: string;
  patient_id: string;
  patient_name: string;
  status: OrderStatus;
  priority: Priority;
  order_date: string;
  expected_date: string;
  total_amount: number;
  doctor: string | null;

  // sample/meta needed by modal
  sample_id: string | null;
  color_code: string | null;
  color_name: string | null;
  sample_collected_at: string | null;
  sample_collected_by: string | null;

  // relations
  patients: { name?: string | null; age?: string | null; gender?: string | null } | null;
  order_tests: { id: string; test_group_id: string | null; test_name: string }[] | null;

  // daily sequence for sorting
  order_number?: number | null;
};

type Panel = {
  name: string;
  expected: number;
  entered: number;     // from view (clamped later)
  verified: boolean;
  status: ProgressRow["panel_status"];
};

type CardOrder = {
  id: string;
  patient_name: string;
  patient_id: string;
  status: OrderStatus;
  priority: Priority;
  order_date: string;
  expected_date: string;
  total_amount: number;
  doctor: string | null;

  order_number?: number | null;

  sample_id: string | null;
  color_code: string | null;
  color_name: string | null;
  sample_collected_at: string | null;
  sample_collected_by: string | null;

  patient?: { name?: string | null; age?: string | null; gender?: string | null } | null;
  tests: string[];

  // derived
  panels: Panel[];
  expectedTotal: number;
  enteredTotal: number;

  // 3-bucket model
  pendingAnalytes: number;       // not started OR partial/in-progress
  forApprovalAnalytes: number;   // complete but not verified
  approvedAnalytes: number;      // verified
};

/* ===========================
   Component
=========================== */

const Orders: React.FC = () => {
  const { user } = useAuth();

  const [orders, setOrders] = useState<CardOrder[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"All" | OrderStatus>("All");
  const [showOrderForm, setShowOrderForm] = useState(false);
  const [selectedOrder, setSelectedOrder] = useState<CardOrder | null>(null);

  // dashboard counters
  const [summary, setSummary] = useState({ allDone: 0, mostlyDone: 0, pending: 0, awaitingApproval: 0 });

  useEffect(() => {
    fetchOrders();
  }, []);

  // Read daily sequence (prefer order_number; fallback to tail of sample_id)
  const getDailySeq = (o: CardOrder) => {
    if (typeof o.order_number === "number" && !Number.isNaN(o.order_number)) return o.order_number;
    const tail = String(o.sample_id || "").split("-").pop() || "";
    const n = parseInt(tail, 10);
    return Number.isFinite(n) ? n : 0;
  };

  const fetchOrders = async () => {
    // 1) base orders
    const { data: rows, error } = await supabase
      .from("orders")
      .select(`
        id, patient_id, patient_name, status, priority, order_date, expected_date, total_amount, doctor,
        order_number, sample_id, color_code, color_name, sample_collected_at, sample_collected_by,
        patients(name, age, gender),
        order_tests(id, test_group_id, test_name)
      `)
      .order("order_date", { ascending: false });

    if (error) {
      console.error("orders load error", error);
      return;
    }

    const orderRows = (rows || []) as OrderRow[];
    const orderIds = orderRows.map((o) => o.id);
    if (orderIds.length === 0) {
      setOrders([]);
      return;
    }

    // 2) view-based progress
    const { data: prog, error: pErr } = await supabase
      .from("v_order_test_progress")
      .select("*")
      .in("order_id", orderIds);

    if (pErr) console.error("progress view error", pErr);

    const byOrder = new Map<string, ProgressRow[]>();
    (prog || []).forEach((r) => {
      const arr = byOrder.get(r.order_id) || [];
      arr.push(r as ProgressRow);
      byOrder.set(r.order_id, arr);
    });

    // 3) shape cards with new buckets
    const cards: CardOrder[] = orderRows.map((o) => {
      const rows = byOrder.get(o.id) || [];
      const panels: Panel[] = rows.map((r) => ({
        name: r.test_group_name || "Test",
        expected: r.expected_analytes || 0,
        entered: r.entered_analytes || 0,
        verified: !!r.is_verified,
        status: r.panel_status,
      }));

      // clamp per panel
      const perPanel = panels.map((p) => ({
        expected: p.expected,
        enteredClamped: Math.min(p.entered, p.expected),
        // approved = whole panel verified (view only tells us "any_verified")
        verifiedWhole: (p.verified || p.status === "Verified") ? p.expected : 0,
      }));

      const expectedTotal = perPanel.reduce((s, x) => s + x.expected, 0);
      const enteredTotal  = perPanel.reduce((s, x) => s + x.enteredClamped, 0);

      // approved from verified panels
      const approvedAnalytes = perPanel.reduce((s, x) => s + x.verifiedWhole, 0);

      // analyte-level buckets
      const pendingAnalytes     = Math.max(expectedTotal - enteredTotal, 0);      // not entered
      const forApprovalAnalytes = Math.max(enteredTotal  - approvedAnalytes, 0);  // entered but not verified

      return {
        id: o.id,
        patient_name: o.patient_name,
        patient_id: o.patient_id,
        status: o.status,
        priority: o.priority,
        order_date: o.order_date,
        expected_date: o.expected_date,
        total_amount: o.total_amount,
        doctor: o.doctor,

        order_number: o.order_number ?? null,
        sample_id: o.sample_id,
        color_code: o.color_code,
        color_name: o.color_name,
        sample_collected_at: o.sample_collected_at,
        sample_collected_by: o.sample_collected_by,

        patient: o.patients,
        tests: (o.order_tests || []).map((t) => t.test_name),

        panels,
        expectedTotal,
        enteredTotal,
        pendingAnalytes,
        forApprovalAnalytes,
        approvedAnalytes,
      };
    });

    // sort: date DESC, then daily seq DESC (002 above 001)
    const sorted = cards.sort((a, b) => {
      const dA = new Date(a.order_date).setHours(0,0,0,0);
      const dB = new Date(b.order_date).setHours(0,0,0,0);
      if (dA !== dB) return dB - dA;
      const nA = getDailySeq(a);
      const nB = getDailySeq(b);
      return nB - nA;
    });

    // dashboard summary (kept)
    const s = sorted.reduce(
      (acc, o) => {
        if (o.status === "Completed" || o.status === "Delivered") acc.allDone++;
        else if (o.status === "Pending Approval") acc.awaitingApproval++;
        else if (o.enteredTotal > 0 && o.enteredTotal >= o.expectedTotal * 0.75) acc.mostlyDone++;
        else acc.pending++;
        return acc;
      },
      { allDone: 0, mostlyDone: 0, pending: 0, awaitingApproval: 0 }
    );

    setOrders(sorted);
    setSummary(s);
  };

  /* ------------- filtering + grouping ------------- */
  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return orders.filter((o) => {
      const matchesQ =
        o.patient_name.toLowerCase().includes(q) ||
        (o.patient_id || "").toLowerCase().includes(q) ||
        (o.id || "").toLowerCase().includes(q);
      const matchesStatus = statusFilter === "All" || o.status === statusFilter;
      return matchesQ && matchesStatus;
    });
  }, [orders, search, statusFilter]);

  type Group = { key: string; label: string; orders: CardOrder[] };
  const groups: Group[] = useMemo(() => {
    const map = new Map<string, { date: Date; orders: CardOrder[] }>();
    filtered.forEach((o) => {
      const d = new Date(o.order_date);
      d.setHours(0, 0, 0, 0);
      const k = d.toISOString().slice(0, 10);
      map.set(k, map.get(k) || { date: d, orders: [] });
      map.get(k)!.orders.push(o);
    });

    return Array.from(map.entries())
      .sort((a, b) => b[1].date.getTime() - a[1].date.getTime())
      .map(([key, v]) => ({
        key,
        label: v.date.toLocaleDateString("en-IN", {
          weekday: "long",
          day: "numeric",
          month: "long",
          year: "numeric",
        }),
        orders: v.orders.sort((a, b) => {
          const nA = getDailySeq(a);
          const nB = getDailySeq(b);
          if (nA !== nB) return nB - nA;
          return new Date(b.order_date).getTime() - new Date(a.order_date).getTime();
        }),
      }));
  }, [filtered]);

  const getPriorityBadge = (p: Priority) =>
    ({
      Normal: "bg-gray-100 text-gray-800",
      Urgent: "bg-orange-100 text-orange-800",
      STAT: "bg-red-100 text-red-800",
    }[p] || "bg-gray-100 text-gray-800");

  const openDetails = (o: CardOrder) => setSelectedOrder(o);

  /* ===========================
     UI
  =========================== */

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Test Orders</h1>
        <button
          onClick={() => setShowOrderForm(true)}
          className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
        >
          <Plus className="h-5 w-5 mr-2" />
          Create Order
        </button>
      </div>

      {/* Overview cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-green-50 border border-green-200 rounded-lg p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-2xl font-bold text-green-900">{summary.allDone}</div>
              <div className="text-sm text-green-700">All Done</div>
            </div>
            <div className="bg-green-500 p-2 rounded-lg">
              <CheckCircle className="h-5 w-5 text-white" />
            </div>
          </div>
        </div>
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-2xl font-bold text-blue-900">{summary.mostlyDone}</div>
              <div className="text-sm text-blue-700">Mostly Done</div>
            </div>
            <div className="bg-blue-500 p-2 rounded-lg">
              <TrendingUp className="h-5 w-5 text-white" />
            </div>
          </div>
        </div>
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-2xl font-bold text-yellow-900">{summary.pending}</div>
              <div className="text-sm text-yellow-700">Pending</div>
            </div>
            <div className="bg-yellow-500 p-2 rounded-lg">
              <ClockIcon className="h-5 w-5 text-white" />
            </div>
          </div>
        </div>
        <div className="bg-orange-50 border border-orange-200 rounded-lg p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-2xl font-bold text-orange-900">{summary.awaitingApproval}</div>
              <div className="text-sm text-orange-700">Awaiting Approval</div>
            </div>
            <div className="bg-orange-500 p-2 rounded-lg">
              <AlertTriangle className="h-5 w-5 text-white" />
            </div>
          </div>
        </div>
      </div>

      {/* Search / Filters */}
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by patient, order ID, or patient ID…"
              className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as any)}
            className="px-3 py-2 border border-gray-300 rounded-md"
          >
            {["All", "Order Created", "Sample Collection", "In Progress", "Pending Approval", "Completed", "Delivered"].map(
              (s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              )
            )}
          </select>
          <button className="inline-flex items-center px-3 py-2 border border-gray-300 rounded-md">
            <Filter className="h-4 w-4 mr-2" />
            More Filters
          </button>
        </div>
      </div>

      {/* Groups + Cards */}
      <div className="bg-white rounded-lg border border-gray-200">
        <div className="px-6 py-4 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900">Test Orders ({filtered.length})</h3>
        </div>

        {groups.length === 0 ? (
          <div className="text-center py-12">
            <TestTube className="h-12 w-12 text-gray-300 mx-auto mb-3" />
            <p className="text-gray-600">No Orders Found</p>
          </div>
        ) : (
          <div className="space-y-8">
            {groups.map((g) => (
              <div key={g.key} className="px-6">
                <div className="flex items-center justify-between py-4 border-b-2 mb-6 border-gray-200">
                  <h4 className="text-lg font-semibold text-gray-700">{g.label}</h4>
                  <div className="text-sm text-gray-500">{g.orders.length} order{g.orders.length !== 1 ? "s" : ""}</div>
                </div>

                <div className="space-y-4">
                  {g.orders.map((o) => {
                    const pct = o.expectedTotal > 0 ? Math.round((o.enteredTotal / o.expectedTotal) * 100) : 0;
                    return (
                      <div
                        key={o.id}
                        role="button"
                        onClick={() => openDetails(o)}
                        className="w-full p-4 border-2 rounded-lg hover:shadow-md transition-all cursor-pointer border-gray-200 bg-white"
                      >
                        {/* Top row */}
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex items-center gap-3">
                            <div className="flex items-center justify-center w-8 h-8 bg-blue-100 text-blue-700 rounded-full font-bold text-sm border-2 border-blue-200">
                              {String(getDailySeq(o)).padStart(3, "0")}
                            </div>
                            <div className="flex items-center gap-3">
                              <User className="h-6 w-6 text-blue-600 shrink-0" />
                              <div>
                                <div className="text-xl sm:text-2xl font-bold text-gray-900">
                                  {o.patient?.name || o.patient_name}
                                </div>
                                <div className="text-sm sm:text-base text-gray-700">
                                  {(o.patient?.age || "N/A") + "y"} • {o.patient?.gender || "N/A"} • ID: {o.patient_id}
                                </div>
                              </div>
                            </div>
                          </div>

                          <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                            <span className="inline-flex items-center px-3 py-1.5 rounded-lg text-sm font-bold border-2 bg-blue-100 text-blue-800 border-blue-200">
                              ● {o.status === "In Progress" ? "In Process" : o.status}
                            </span>
                            <button
                              className="p-2 text-gray-600 hover:bg-gray-100 rounded-lg"
                              onClick={() => setExpanded((prev) => ({ ...prev, [o.id]: !prev[o.id] }))}
                            >
                              {expanded[o.id] ? <ChevronUp className="h-5 w-5" /> : <ChevronDown className="h-5 w-5" />}
                            </button>
                          </div>
                        </div>

                        {/* Middle: sample + tests */}
                        <div className="mt-3 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3 bg-gray-50 rounded-lg p-3">
                          <div className="flex flex-col sm:flex-row sm:items-center gap-6">
                            <div className="min-w-[110px]">
                              <div className="text-xs text-gray-600">Order</div>
                              <div className="font-bold text-gray-900">#{(o.id || "").slice(-6)}</div>
                            </div>

                            {o.sample_id && (
                              <div className="flex items-center gap-2">
                                <div
                                  className="w-8 h-8 rounded-full border-2 border-white shadow-md flex items-center justify-center text-white font-bold text-xs"
                                  style={{ backgroundColor: o.color_code || "#8B5CF6" }}
                                  title={`Sample Tube: ${o.color_name || "Tube"}`}
                                >
                                  {(o.color_name || "Tube").charAt(0)}
                                </div>
                                <div>
                                  <div className="text-xs text-gray-600">Sample</div>
                                  <div className="font-mono font-bold text-gray-900 text-sm">
                                    {String(o.sample_id).split("-").pop()}
                                  </div>
                                </div>
                              </div>
                            )}

                            <div className="flex-1">
                              <div className="text-sm text-gray-600 mb-1">Tests ({o.tests.length})</div>
                              <div className="flex flex-wrap gap-2">
                                {o.panels.length > 0
                                  ? o.panels.map((p, i) => {
                                      const color =
                                        p.verified
                                          ? "border-green-300 bg-green-50 text-green-800"
                                          : p.status === "Complete"
                                          ? "border-amber-300 bg-amber-50 text-amber-800"
                                          : p.entered > 0
                                          ? "border-blue-300 bg-blue-50 text-blue-800"
                                          : "border-slate-300 bg-slate-50 text-slate-800";
                                      return (
                                        <span
                                          key={`${p.name}-${i}`}
                                          className={`inline-flex items-center rounded-full border px-3 py-1 text-sm ${color}`}
                                        >
                                          {p.name}
                                          <span className="ml-2 text-xs opacity-80">
                                            {p.entered}/{p.expected} • {p.verified ? "Verified" : p.status}
                                          </span>
                                        </span>
                                      );
                                    })
                                  : o.tests.map((t, i) => (
                                      <span key={i} className="px-2 py-1 rounded text-sm bg-blue-100 text-blue-800">
                                        {t}
                                      </span>
                                    ))}
                              </div>
                            </div>
                          </div>

                          <div className="text-right">
                            <div className="text-xl sm:text-2xl font-bold text-green-600">
                              ₹{Number(o.total_amount || 0).toLocaleString()}
                            </div>
                            <div className="text-sm text-gray-600">
                              <div>Ordered: {new Date(o.order_date).toLocaleDateString()}</div>
                              <div className={`${new Date(o.expected_date) < new Date() ? "text-red-600 font-bold" : ""}`}>
                                Expected: {new Date(o.expected_date).toLocaleDateString()}
                                {new Date(o.expected_date) < new Date() && " ⚠️ OVERDUE"}
                              </div>
                            </div>

                            {/* View button opens modal only */}
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                openDetails(o);
                              }}
                              className="mt-3 inline-flex items-center px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                            >
                              <Eye className="h-4 w-4 mr-1" />
                              View Full Details
                            </button>
                          </div>
                        </div>

                        {/* Progress + legend */}
                        <div className="mt-3 bg-blue-50 rounded-lg p-2">
                          <div className="flex items-center justify-between text-sm mb-1">
                            <span className="text-blue-700 font-medium">Progress</span>
                            <span className="text-blue-700">{pct}% Complete</span>
                          </div>
                          <div className="w-full bg-blue-200 rounded-full h-3">
                            <div className="bg-blue-600 h-3 rounded-full" style={{ width: `${pct}%` }} />
                          </div>
                          <div className="flex flex-wrap items-center gap-4 mt-2 text-sm">
                            <span className="inline-flex items-center">
                              <span className="inline-block w-3 h-3 bg-slate-400 rounded-sm mr-2" /> Pending: {o.pendingAnalytes}
                            </span>
                            <span className="inline-flex items-center">
                              <span className="inline-block w-3 h-3 bg-amber-400 rounded-sm mr-2" /> For approval: {o.forApprovalAnalytes}
                            </span>
                            <span className="inline-flex items-center">
                              <span className="inline-block w-3 h-3 bg-green-500 rounded-sm mr-2" /> Approved: {o.approvedAnalytes}
                            </span>
                            <span className="ml-auto text-gray-500">Total expected: {o.expectedTotal}</span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer stats */}
      <div className="bg-gradient-to-r from-blue-50 to-purple-50 rounded-lg p-4 border border-blue-200">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-sm">
          <div className="flex items-center gap-6">
            <div className="flex items-center">
              <Calendar className="h-4 w-4 text-blue-600 mr-1" />
              <span className="text-blue-900 font-medium">Total Orders: {orders.length}</span>
            </div>
            <div className="flex items-center">
              <AlertTriangle className="h-4 w-4 text-red-600 mr-1" />
              <span className="text-red-900 font-medium">
                Overdue: {orders.filter((o) => new Date(o.expected_date) < new Date()).length}
              </span>
            </div>
          </div>
          <div className="flex items-center">
            <TrendingUp className="h-4 w-4 text-purple-600 mr-1" />
            <span className="text-purple-900 font-medium">
              Avg TAT:{" "}
              {orders.length
                ? Math.round(
                    orders.reduce((sum, o) => {
                      const diffHrs = (Date.now() - new Date(o.order_date).getTime()) / 36e5;
                      return sum + diffHrs;
                    }, 0) / orders.length
                  )
                : 0}
              h
            </span>
          </div>
        </div>
      </div>

      {/* Modals */}
      {showOrderForm && (
        <OrderForm onClose={() => setShowOrderForm(false)} onSubmit={() => setShowOrderForm(false)} />
      )}

      {selectedOrder && (
        <OrderDetailsModal
          order={selectedOrder}
          onClose={() => setSelectedOrder(null)}
          onUpdateStatus={async () => {
            await fetchOrders();
            setSelectedOrder(null);
          }}
          onAfterSubmit={async () => {
            await fetchOrders();
            setSelectedOrder(null);
          }}
          onAfterSaveDraft={async () => {
            await fetchOrders();
          }}
        />
      )}
    </div>
  );
};

export default Orders;
