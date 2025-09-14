import React, { useEffect, useMemo, useState } from "react";
import {
  CalendarRange, Search, Filter, CheckCircle2, ClipboardCheck, Clock,
  AlertTriangle, Eye, ChevronDown, ChevronUp, User, TestTube, TrendingUp,
  FlaskConical, ShieldCheck, FileText, FileCheck, Send, Paperclip, Brain, IndianRupee
} from "lucide-react";
import { supabase } from "../utils/supabase";
import OrderDetailsModal from "../components/Orders/OrderDetailsModal";

/* =========================================================
   Types
========================================================= */

type OrderStatus =
  | "Order Created"
  | "Sample Collection"
  | "In Progress"
  | "Pending Approval"
  | "Completed"
  | "Delivered";

type Priority = "Normal" | "Urgent" | "STAT";

type OrderRow = {
  id: string;
  patient_id: string;
  patient_name: string;
  status: OrderStatus;
  priority: Priority;
  order_date: string;       // date
  expected_date: string;    // date
  total_amount: number;
  doctor: string | null;

  // sorting / sample bits
  order_number: number | null;
  sample_id: string | null;
  color_code: string | null;
  color_name: string | null;

  // for detail modal header
  sample_collected_at: string | null;
  sample_collected_by: string | null;

  // relations
  patients?: { name?: string | null; age?: string | null; gender?: string | null } | null;
  order_tests?: { id: string; test_group_id: string | null; test_name: string }[] | null;
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

  // progress quick facts (best-effort via view)
  expectedTotal: number;
  enteredTotal: number;
  verifiedAnalytes: number;
  
  // For compatibility with Orders page structure
  panels?: { name: string; expected: number; entered: number; verified: boolean; status: string }[];
};

/* =========================================================
   Small local components (KPI + Modal)
========================================================= */

const KpiCard: React.FC<{
  title: string;
  value: React.ReactNode;
  subtitle?: string;
  icon?: React.ReactNode;
  onClick?: () => void;
}> = ({ title, value, subtitle, icon, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className="w-full text-left group rounded-2xl border border-gray-200 bg-white/80 hover:bg-white shadow-sm hover:shadow transition-all px-4 py-4 md:px-5 md:py-5"
  >
    <div className="flex items-start justify-between">
      <div>
        <div className="text-sm font-medium text-gray-600">{title}</div>
        <div className="mt-1 text-2xl font-extrabold text-gray-900">{value}</div>
        {subtitle ? <div className="mt-1.5 text-xs text-gray-500">{subtitle}</div> : null}
      </div>
      <div className="p-2 rounded-xl bg-blue-50 text-blue-600 border border-blue-100">{icon}</div>
    </div>
    <div className="mt-3 text-xs text-blue-700 font-medium opacity-0 group-hover:opacity-100 transition">
      View details →
    </div>
  </button>
);

/** KPI kinds for the modal list */
type KpiKind = "approved" | "for_approval" | "pending" | "overdue";

/** Lightweight detail list modal used by KPI cards */
const KpiDetailModal: React.FC<{
  open: boolean;
  onClose: () => void;
  kind: KpiKind;
  title: string;
  dateFrom?: string;
  dateTo?: string;
}> = ({ open, onClose, kind, title, dateFrom, dateTo }) => {
  const [rows, setRows] = useState<OrderRow[]>([]);
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<OrderRow | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!open) return;
    let abort = false;

    (async () => {
      setLoading(true);
      const baseSel = `
        id, patient_id, patient_name, status, priority, order_date, expected_date,
        total_amount, doctor, order_number, sample_id, color_code, color_name,
        sample_collected_at, sample_collected_by,
        order_tests(id, test_group_id, test_name),
        patients(name, age, gender)
      `;

      const applyDate = (q: any) => {
        if (dateFrom) q.gte("order_date", dateFrom);
        if (dateTo) q.lte("order_date", dateTo);
        return q;
      };

      let list: OrderRow[] = [];

      if (kind === "approved") {
        const { data: rids } = await supabase
          .from("results")
          .select("order_id")
          .eq("verification_status", "verified");
        const oids = Array.from(new Set((rids || []).map((r) => r.order_id).filter(Boolean)));
        if (oids.length) {
          const { data } = await applyDate(supabase.from("orders").select(baseSel).in("id", oids));
          list = (data || []) as OrderRow[];
        }
      } else if (kind === "for_approval") {
        const { data: rids } = await supabase
          .from("results")
          .select("order_id")
          .in("verification_status", ["pending_verification", "needs_clarification"]);
        const oids = Array.from(new Set((rids || []).map((r) => r.order_id).filter(Boolean)));
        const { data } = await applyDate(supabase.from("orders").select(baseSel).in("id", oids));
        list = (data || []) as OrderRow[];
      } else if (kind === "pending") {
        const { data: rv } = await supabase.from("result_values").select("order_id");
        const hasRes = new Set((rv || []).map((x) => x.order_id));
        const { data } = await applyDate(supabase.from("orders").select(baseSel));
        list = ((data || []) as OrderRow[]).filter((o) => !hasRes.has(o.id));
      } else if (kind === "overdue") {
        const today = new Date().toISOString().slice(0, 10);
        const { data } = await supabase
          .from("orders")
          .select(baseSel)
          .lt("expected_date", today)
          .not("status", "in", '("Completed","Delivered")');
        list = (data || []) as OrderRow[];
      }

      if (!abort) setRows(list);
      setLoading(false);
    })();

    return () => {
      abort = true;
    };
  }, [open, kind, dateFrom, dateTo]);

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    if (!qq) return rows;
    return rows.filter(
      (r) =>
        r.patient_name.toLowerCase().includes(qq) ||
        (r.patient_id || "").toLowerCase().includes(qq) ||
        r.id.toLowerCase().includes(qq) ||
        (r.sample_id || "").toLowerCase().includes(qq)
    );
  }, [rows, q]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-2 md:p-6">
      <div className="w-full max-w-6xl bg-white rounded-2xl shadow-xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <div className="text-lg md:text-xl font-semibold text-gray-900">{title}</div>
          <button className="p-2 rounded-lg hover:bg-gray-100" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="px-5 py-3 border-b bg-gray-50/60">
          <div className="relative max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search patient, order ID, sample…"
              className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        <div className="px-5 py-4 max-h-[70vh] overflow-auto">
          {loading ? (
            <div className="py-16 text-center text-gray-600">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="py-16 text-center text-gray-600">No records.</div>
          ) : (
            <div className="-mx-5 overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-5 py-3 text-left text-xs font-semibold text-gray-600">Order</th>
                    <th className="px-5 py-3 text-left text-xs font-semibold text-gray-600">Patient</th>
                    <th className="px-5 py-3 text-left text-xs font-semibold text-gray-600">Status</th>
                    <th className="px-5 py-3 text-left text-xs font-semibold text-gray-600">Tests</th>
                    <th className="px-5 py-3 text-left text-xs font-semibold text-gray-600">Ordered</th>
                    <th className="px-5 py-3 text-left text-xs font-semibold text-gray-600">Expected</th>
                    <th className="px-5 py-3 text-right text-xs font-semibold text-gray-600">Action</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-100">
                  {filtered.map((r) => (
                    <tr key={r.id} className="hover:bg-gray-50">
                      <td className="px-5 py-3 font-mono text-sm text-gray-900">#{r.id.slice(-6)}</td>
                      <td className="px-5 py-3">
                        <div className="text-sm font-medium text-gray-900">{r.patient_name}</div>
                        <div className="text-xs text-gray-500">{r.patient_id}</div>
                      </td>
                      <td className="px-5 py-3">
                        <span className="inline-flex items-center rounded-full bg-blue-50 text-blue-700 border border-blue-200 px-2 py-0.5 text-xs">
                          {r.status}
                        </span>
                      </td>
                      <td className="px-5 py-3">
                        {(r.order_tests || []).length ? (
                          <div className="flex flex-wrap gap-1">
                            {(r.order_tests || []).slice(0, 3).map((t) => (
                              <span key={t.id} className="px-2 py-0.5 text-xs rounded-full bg-gray-100 text-gray-700">
                                {t.test_name}
                              </span>
                            ))}
                            {(r.order_tests || []).length > 3 && (
                              <span className="px-2 py-0.5 text-xs rounded-full bg-gray-50 text-gray-500">
                                +{(r.order_tests || []).length - 3} more
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="text-xs text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-sm text-gray-700">
                        {new Date(r.order_date).toLocaleDateString()}
                      </td>
                      <td className="px-5 py-3 text-sm">
                        <span
                          className={`${
                            new Date(r.expected_date) < new Date() ? "text-red-600 font-semibold" : "text-gray-700"
                          }`}
                        >
                          {new Date(r.expected_date).toLocaleDateString()}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-right">
                        <button
                          onClick={() => setSelected(r)}
                          className="inline-flex items-center px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 text-xs"
                        >
                          <Eye className="h-4 w-4 mr-1" />
                          View
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Open the existing OrderDetailsModal when a row is selected */}
      {selected && (
        <OrderDetailsModal
          order={{
            id: selected.id,
            patient_name: selected.patient_name,
            patient_id: selected.patient_id,
            tests: (selected.order_tests || []).map((t) => t.test_name),
            status: selected.status,
            priority: selected.priority,
            order_date: selected.order_date,
            expected_date: selected.expected_date,
            total_amount: Number(selected.total_amount || 0),
            doctor: selected.doctor || "",
            sample_id: selected.sample_id || undefined,
            color_code: selected.color_code || undefined,
            color_name: selected.color_name || undefined,
            qr_code_data: undefined,
            sample_collected_at: selected.sample_collected_at || undefined,
            sample_collected_by: selected.sample_collected_by || undefined,
          }}
          onClose={() => setSelected(null)}
          onUpdateStatus={() => setSelected(null)}
          onSubmitResults={() => setSelected(null)}
        />
      )}
    </div>
  );
};

/* =========================================================
   Main Dashboard Page
========================================================= */

const Dashboard: React.FC = () => {
  const [orders, setOrders] = useState<CardOrder[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [search, setSearch] = useState("");
  const [dateFrom, setDateFrom] = useState<string>(() => {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return d.toISOString().slice(0, 10);
  });
  const [dateTo, setDateTo] = useState<string>(() => new Date().toISOString().slice(0, 10));

  // KPI modal
  const [kpiModal, setKpiModal] = useState<{ open: boolean; kind: KpiKind; title: string } | null>(null);

  // KPI counts
  const [counts, setCounts] = useState({ approved: 0, for_approval: 0, pending: 0, overdue: 0 });

  // Inline order modal state
  const [inlineOrder, setInlineOrder] = useState<CardOrder | null>(null);

  // Actions for IconStrip (front desk appropriate actions)
  const iconActions = {
    onApprove: (id: string) => {
      // Show status or remind lab technicians
      alert(`Reminder sent to lab for Order #${id.slice(-6)}: Please verify pending results`);
    },
    onGenerate: (id: string) => {
      // Trigger report generation for billing/printing
      alert(`Report generation started for Order #${id.slice(-6)}`);
    },
    onSend: (id: string) => {
      // Send report via email/SMS to patient
      alert(`Sending report to patient for Order #${id.slice(-6)}`);
    },
    onPayments: (id: string) => {
      // Open payment/billing interface
      alert(`Opening billing interface for Order #${id.slice(-6)}`);
    },
    onAttachments: (id: string) => {
      // View/manage order attachments (prescriptions, etc.)
      alert(`Opening attachments for Order #${id.slice(-6)}`);
    },
    onAIConsole: (id: string) => {
      // AI-powered patient communication or status updates
      alert(`Opening AI assistant for Order #${id.slice(-6)}`);
    },
  };

  // daily sequence helper: prefer order_number; fallback to sample_id tail
  const getDailySeq = (o: { order_number?: number | null; sample_id?: string | null }) => {
    if (typeof o.order_number === "number" && !Number.isNaN(o.order_number)) return o.order_number;
    const tail = String(o.sample_id || "").split("-").pop() || "";
    const n = parseInt(tail, 10);
    return Number.isFinite(n) ? n : 0;
  };

  useEffect(() => {
    fetchKpis();
    fetchOrders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateFrom, dateTo]);

  const fetchKpis = async () => {
    // approved
    const { count: approved } = await supabase
      .from("results")
      .select("*", { count: "exact", head: true })
      .eq("verification_status", "verified");

    // for approval
    const { count: for_approval } = await supabase
      .from("results")
      .select("*", { count: "exact", head: true })
      .in("verification_status", ["pending_verification", "needs_clarification"]);

    // pending (orders within range that have no result_values)
    const { data: inRange } = await supabase
      .from("orders")
      .select("id")
      .gte("order_date", dateFrom)
      .lte("order_date", dateTo);

    const ids = (inRange || []).map((r) => r.id);
    let pending = 0;
    if (ids.length) {
      const { data: rv } = await supabase.from("result_values").select("order_id").in("order_id", ids);
      const hasRes = new Set((rv || []).map((x) => x.order_id));
      pending = ids.filter((id) => !hasRes.has(id)).length;
    }

    // overdue
    const today = new Date().toISOString().slice(0, 10);
    const { count: overdue } = await supabase
      .from("orders")
      .select("*", { count: "exact", head: true })
      .lt("expected_date", today)
      .not("status", "in", '("Completed","Delivered")');

    setCounts({
      approved: approved || 0,
      for_approval: for_approval || 0,
      pending,
      overdue: overdue || 0,
    });
  };

  const fetchOrders = async () => {
    // 1) Orders for the range
    const { data: rows, error } = await supabase
      .from("orders")
      .select(`
        id, patient_id, patient_name, status, priority, order_date, expected_date, total_amount, doctor,
        order_number, sample_id, color_code, color_name, sample_collected_at, sample_collected_by,
        patients(name, age, gender),
        order_tests(id, test_group_id, test_name)
      `)
      .gte("order_date", dateFrom)
      .lte("order_date", dateTo)
      .order("order_date", { ascending: false });

    if (error) {
      console.error("orders load error", error);
      setOrders([]);
      return;
    }

    const orderRows = (rows || []) as OrderRow[];
    const orderIds = orderRows.map((o) => o.id);

    // 2) Best-effort progress via view v_order_test_progress
    let byOrder = new Map<
      string,
      { expected: number; entered: number; verified: number; panels: any[] }
    >();

    try {
      if (orderIds.length) {
        const { data: prog } = await supabase
          .from("v_order_test_progress")
          .select("*")
          .in("order_id", orderIds);

        (prog || []).forEach((r: any) => {
          const cur = byOrder.get(r.order_id) || { expected: 0, entered: 0, verified: 0, panels: [] };
          cur.expected += r.expected_analytes || 0;
          cur.entered += r.entered_analytes || 0;
          cur.verified += r.is_verified ? (r.expected_analytes || 0) : 0;
          
          // Add panel information
          if (r.test_group_name) {
            cur.panels.push({
              name: r.test_group_name,
              expected: r.expected_analytes || 0,
              entered: r.entered_analytes || 0,
              verified: !!r.is_verified,
              status: r.panel_status || "Not started"
            });
          }
          
          byOrder.set(r.order_id, cur);
        });
      }
    } catch (e) {
      // view not available: keep map empty; cards still list
    }

    // 3) Compose cards
    const cards: CardOrder[] = orderRows.map((o) => {
      const agg = byOrder.get(o.id) || { expected: 0, entered: 0, verified: 0, panels: [] };
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
        order_number: o.order_number,
        sample_id: o.sample_id,
        color_code: o.color_code,
        color_name: o.color_name,
        sample_collected_at: o.sample_collected_at,
        sample_collected_by: o.sample_collected_by,
        patient: o.patients,
        tests: (o.order_tests || []).map((t) => t.test_name),
        expectedTotal: agg.expected,
        enteredTotal: agg.entered,
        verifiedAnalytes: agg.verified,
        panels: agg.panels,
      };
    });

    // 4) Sort: date DESC first (by day), then order_number DESC within day
    const sorted = cards.sort((a, b) => {
      const dA = new Date(a.order_date).setHours(0, 0, 0, 0);
      const dB = new Date(b.order_date).setHours(0, 0, 0, 0);
      if (dA !== dB) return dB - dA;
      return getDailySeq(b) - getDailySeq(a); // high → low (002 above 001)
    });

    setOrders(sorted);
  };

  /* ---------- grouping ---------- */
  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return orders.filter((o) => {
      return (
        o.patient_name.toLowerCase().includes(q) ||
        (o.patient_id || "").toLowerCase().includes(q) ||
        (o.id || "").toLowerCase().includes(q)
      );
    });
  }, [orders, search]);

  const groups = useMemo(() => {
    const map = new Map<string, { date: Date; orders: CardOrder[] }>();
    filtered.forEach((o) => {
      const d = new Date(o.order_date);
      d.setHours(0, 0, 0, 0);
      const k = d.toISOString().slice(0, 10);
      if (!map.has(k)) map.set(k, { date: d, orders: [] });
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
        // within day: order_number DESC, fallback by created time
        orders: v.orders.sort((a: CardOrder, b: CardOrder) => {
          const nA = getDailySeq(a);
          const nB = getDailySeq(b);
          if (nA !== nB) return nB - nA;
          return new Date(b.order_date).getTime() - new Date(a.order_date).getTime();
        }),
      }));
  }, [filtered]);

  /* ---------- UI helpers ---------- */
  const openKpi = (kind: KpiKind, title: string) =>
    setKpiModal({ open: true, kind, title });

  const cardBadge = (s: OrderStatus) =>
    ({
      "Order Created": "bg-gray-100 text-gray-800",
      "Sample Collection": "bg-blue-100 text-blue-800",
      "In Progress": "bg-indigo-100 text-indigo-800",
      "Pending Approval": "bg-amber-100 text-amber-800",
      Completed: "bg-green-100 text-green-800",
      Delivered: "bg-slate-100 text-slate-700",
    }[s] || "bg-gray-100 text-gray-800");

  /* =========================================================
     Render
  ========================================================= */

  return (
    <div className="space-y-6">
      {/* Header + Date range */}
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <h1 className="text-2xl md:text-3xl font-bold text-gray-900">Dashboard</h1>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2 border rounded-lg px-2 py-1.5">
            <CalendarRange className="h-4 w-4 text-gray-500" />
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="text-sm border-0 outline-none"
            />
            <span className="text-gray-400">—</span>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="text-sm border-0 outline-none"
            />
          </div>
        </div>
      </div>

      {/* KPI Row */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <KpiCard
          title="Approved"
          value={counts.approved}
          subtitle="Verified results"
          icon={<CheckCircle2 className="h-6 w-6" />}
          onClick={() => openKpi("approved", "Approved (Verified) Orders")}
        />
        <KpiCard
          title="For approval"
          value={counts.for_approval}
          subtitle="Awaiting verification"
          icon={<ClipboardCheck className="h-6 w-6" />}
          onClick={() => openKpi("for_approval", "Orders Waiting for Approval")}
        />
        <KpiCard
          title="Pending"
          value={counts.pending}
          subtitle="No results entered"
          icon={<Clock className="h-6 w-6" />}
          onClick={() => openKpi("pending", "Orders with No Results Entered")}
        />
        <KpiCard
          title="Overdue"
          value={counts.overdue}
          subtitle="Past expected date"
          icon={<AlertTriangle className="h-6 w-6" />}
          onClick={() => openKpi("overdue", "Overdue Orders")}
        />
      </div>

      {/* Search / Filters */}
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <div className="flex flex-col md:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by patient, order ID, or patient ID…"
              className="w-full pl-9 pr-4 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <button className="inline-flex items-center px-3 py-2 border border-gray-300 rounded-md">
            <Filter className="h-4 w-4 mr-2" />
            More Filters
          </button>
        </div>
      </div>

      {/* Grouped Orders */}
      <div className="bg-white rounded-lg border border-gray-200">
        <div className="px-6 py-4 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900">
            Test Orders ({filtered.length})
          </h3>
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
                  <div className="text-sm text-gray-500">
                    {g.orders.length} order{g.orders.length !== 1 ? "s" : ""}
                  </div>
                </div>

                <div className="space-y-4">
                  {g.orders.map((o: CardOrder) => {
                    const pct =
                      o.expectedTotal > 0
                        ? Math.round((o.enteredTotal / o.expectedTotal) * 100)
                        : 0;
                    const dailySeq = String(
                      typeof o.order_number === "number" ? o.order_number : getDailySeq(o)
                    ).padStart(3, "0");

                    // Convert CardOrder to DashboardOrderRow format for IconStrip
                    const dashboardRow = {
                      order_id: o.id,
                      patient_id: o.patient_id,
                      patient_name: o.patient_name,
                      order_date: o.order_date,
                      expected_date: o.expected_date,
                      total_amount: o.total_amount,
                      expected_total: o.expectedTotal,
                      entered_total: o.enteredTotal,
                      verified_total: o.verifiedAnalytes,
                      sample_collected_at: o.sample_collected_at,
                      all_verified: o.expectedTotal > 0 && o.verifiedAnalytes === o.expectedTotal,
                      report_pdf_ready: o.status === "Completed" || o.status === "Delivered",
                      attachments_count: 0, // TODO: Add attachment count if available
                      balance_due: 0, // TODO: Add balance if available
                      ai_used: false, // TODO: Add AI usage flag if available
                    };

                    return (
                      <div
                        key={o.id}
                        className="w-full p-4 border-2 rounded-lg hover:shadow-md transition-all cursor-pointer border-gray-200 bg-white"
                      >
                        {/* Top row */}
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex items-center gap-3">
                            <div className="flex items-center justify-center w-8 h-8 bg-blue-100 text-blue-700 rounded-full font-bold text-sm border-2 border-blue-200">
                              {dailySeq}
                            </div>
                            <div className="flex items-center gap-3">
                              <User className="h-6 w-6 text-blue-600 shrink-0" />
                              <div>
                                <div className="text-xl sm:text-2xl font-bold text-gray-900">
                                  {o.patient?.name || o.patient_name}
                                </div>
                                <div className="text-sm sm:text-base text-gray-700">
                                  Age: {o.patient?.age || "—"} • {o.patient?.gender || "—"} • ID: {o.patient_id}
                                </div>
                              </div>
                            </div>
                          </div>

                          <div className="flex items-center gap-2">
                            <span className={`inline-flex items-center px-3 py-1.5 rounded-lg text-sm font-bold border-2 ${cardBadge(o.status)} border-opacity-40`}>
                              ● {o.status === "In Progress" ? "In Process" : o.status}
                            </span>
                            <button
                              className="p-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                              onClick={(e) => {
                                e.stopPropagation();
                                setExpanded((prev) => ({ ...prev, [o.id]: !prev[o.id] }));
                              }}
                              title={expanded[o.id] ? "Collapse details" : "Expand to see test details"}
                            >
                              {expanded[o.id] ? <ChevronUp className="h-5 w-5" /> : <ChevronDown className="h-5 w-5" />}
                            </button>
                            
                            {/* Quick expand indicator when collapsed */}
                            {!expanded[o.id] && (
                              <div className="text-xs text-gray-500 bg-gray-100 px-2 py-1 rounded">
                                Click to expand
                              </div>
                            )}
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
                                  {String(o.sample_id || "").slice(-2).toUpperCase()}
                                </div>
                                <div>
                                  <div className="text-xs text-gray-600">Sample</div>
                                  <div className="font-medium text-gray-900">{o.sample_id}</div>
                                </div>
                              </div>
                            )}

                            <div className="flex-1">
                              <div className="text-sm text-gray-600 mb-1">Tests ({o.tests.length})</div>
                              <div className="flex flex-wrap gap-3">
                                {expanded[o.id] ? (
                                  // Expanded view: Show detailed test panels like Orders page
                                  <div className="w-full space-y-2">
                                    {o.panels && o.panels.length > 0 ? (
                                      o.panels.map((p: any, i: number) => {
                                        const panelPct = p.expected > 0 ? Math.round((Math.min(p.entered, p.expected) / p.expected) * 100) : 0;
                                        const statusColor = 
                                          p.status === "Complete" || p.verified ? "border-green-200 bg-green-50" :
                                          p.status === "Partial" || p.status === "In progress" ? "border-orange-200 bg-orange-50" :
                                          "border-gray-200 bg-gray-50";
                                        
                                        return (
                                          <div key={i} className={`p-3 rounded-lg border-2 ${statusColor}`}>
                                            <div className="flex items-center justify-between mb-2">
                                              <div className="font-medium text-gray-900">{p.name}</div>
                                              <div className="text-sm text-gray-600">{p.status}</div>
                                            </div>
                                            <div className="text-sm text-gray-600 mb-1">
                                              {Math.min(p.entered, p.expected)}/{p.expected} analytes
                                            </div>
                                            <div className="w-full bg-gray-200 rounded-full h-2">
                                              <div 
                                                className={`h-2 rounded-full transition-all duration-300 ${
                                                  p.verified ? 'bg-green-500' : 
                                                  panelPct > 0 ? 'bg-orange-500' : 'bg-gray-300'
                                                }`}
                                                style={{ width: `${panelPct}%` }}
                                              />
                                            </div>
                                          </div>
                                        );
                                      })
                                    ) : (
                                      // Fallback to simple test list if no panels
                                      o.tests.map((t: string, i: number) => (
                                        <span
                                          key={i}
                                          className="inline-flex items-center px-2 py-1 text-xs font-medium rounded-full border-2 bg-purple-50 text-purple-800 border-purple-200"
                                        >
                                          {t}
                                        </span>
                                      ))
                                    )}
                                  </div>
                                ) : (
                                  // Collapsed view: Show simple test badges
                                  o.tests.slice(0, 3).map((t: string, i: number) => (
                                    <span
                                      key={i}
                                      className="inline-flex items-center px-2 py-1 text-xs font-medium rounded-full border-2 bg-purple-50 text-purple-800 border-purple-200"
                                    >
                                      {t}
                                    </span>
                                  ))
                                )}
                                {!expanded[o.id] && o.tests.length > 3 && (
                                  <span className="inline-flex items-center px-2 py-1 text-xs font-medium rounded-full border-2 bg-gray-50 text-gray-600 border-gray-200">
                                    +{o.tests.length - 3} more
                                  </span>
                                )}
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

                            {/* IconStrip for actions (excluding view for front desk) */}
                            <div className="mt-3">
                              <div className="flex items-center gap-2 text-gray-600">
                                <button title={dashboardRow.sample_collected_at ? "Sample collected" : "Sample pending"} className="p-1 rounded hover:bg-gray-100">
                                  <TestTube className={`h-4 w-4 ${dashboardRow.sample_collected_at ? "text-green-600" : "text-gray-400"}`} />
                                </button>
                                <span title={`${dashboardRow.entered_total}/${dashboardRow.expected_total} entered`} className="inline-flex items-center p-1 rounded hover:bg-gray-100">
                                  <FlaskConical className="h-4 w-4" /> 
                                  <span className="text-[11px] ml-1 px-1.5 py-0.5 rounded bg-gray-100 border">{dashboardRow.entered_total}</span> / 
                                  <span className="text-[11px] ml-1 px-1.5 py-0.5 rounded bg-gray-100 border">{dashboardRow.expected_total}</span>
                                </span>
                                <button title={dashboardRow.all_verified ? "All verified" : "Verification pending"} onClick={() => iconActions.onApprove?.(dashboardRow.order_id)} className="p-1 rounded hover:bg-gray-100">
                                  <ShieldCheck className={`h-4 w-4 ${dashboardRow.all_verified ? "text-green-600" : "text-amber-600"}`} />
                                </button>
                                <button title={dashboardRow.report_pdf_ready ? "Report ready" : "Generate report"} onClick={() => iconActions.onGenerate?.(dashboardRow.order_id)} className="p-1 rounded hover:bg-gray-100">
                                  {dashboardRow.report_pdf_ready ? <FileCheck className="h-4 w-4 text-blue-600" /> : <FileText className="h-4 w-4" />}
                                </button>
                                <button title="Send report" onClick={() => iconActions.onSend?.(dashboardRow.order_id)} className="p-1 rounded hover:bg-gray-100">
                                  <Send className={`h-4 w-4 ${dashboardRow.report_pdf_ready ? "text-indigo-600" : "text-gray-300"}`} />
                                </button>
                                <button title="Attachments" onClick={() => iconActions.onAttachments?.(dashboardRow.order_id)} className="p-1 rounded hover:bg-gray-100">
                                  <Paperclip className="h-4 w-4" /> 
                                  <span className="text-[11px] ml-1 px-1.5 py-0.5 rounded bg-gray-100 border">{dashboardRow.attachments_count}</span>
                                </button>
                                <button title={dashboardRow.ai_used ? "AI used" : "Open AI console"} onClick={() => iconActions.onAIConsole?.(dashboardRow.order_id)} className="p-1 rounded hover:bg-gray-100">
                                  <Brain className={`h-4 w-4 ${dashboardRow.ai_used ? "text-purple-600" : ""}`} />
                                </button>
                                <button title={`Balance: ₹${dashboardRow.balance_due ?? 0}`} onClick={() => iconActions.onPayments?.(dashboardRow.order_id)} className="p-1 rounded hover:bg-gray-100">
                                  <IndianRupee className={`h-4 w-4 ${(dashboardRow.balance_due ?? 0) > 0 ? "text-red-600" : "text-green-600"}`} />
                                </button>
                                {/* View button removed for front desk dashboard */}
                              </div>
                            </div>
                          </div>
                        </div>

                        {/* Enhanced Progress + legend - Collapsible */}
                        {expanded[o.id] && (
                          <div className="mt-3 bg-gradient-to-r from-blue-50 to-indigo-50 rounded-lg p-3 border border-blue-200">
                            <div className="flex items-center justify-between text-sm mb-2">
                              <span className="text-blue-800 font-semibold flex items-center">
                                📊 Overall Progress
                              </span>
                              <span className="text-blue-800 font-bold text-base">
                                {o.enteredTotal}/{o.expectedTotal} analytes
                              </span>
                            </div>
                            
                            {/* Enhanced progress bar with dynamic colors and segments */}
                            <div className="relative w-full bg-gray-200 rounded-full h-4 mb-3 overflow-hidden border">
                              {/* Background gradient based on overall progress */}
                              <div 
                                className="absolute left-0 top-0 h-4 transition-all duration-700 rounded-full"
                                style={{ 
                                  width: `${pct}%`,
                                  background: pct === 0 ? '#ef4444' : // red
                                             pct < 25 ? `linear-gradient(90deg, #ef4444 0%, #f97316 100%)` : // red to orange
                                             pct < 50 ? `linear-gradient(90deg, #f97316 0%, #eab308 100%)` : // orange to yellow  
                                             pct < 75 ? `linear-gradient(90deg, #eab308 0%, #84cc16 100%)` : // yellow to lime
                                             pct < 100 ? `linear-gradient(90deg, #84cc16 0%, #22c55e 100%)` : // lime to green
                                             '#10b981', // emerald
                                  boxShadow: pct > 0 ? `0 0 12px ${pct < 50 ? '#ef444440' : '#22c55e40'}` : 'none'
                                }}
                              />
                              
                              {/* Approved segment overlay (darker green) */}
                              <div 
                                className="absolute left-0 top-0 h-4 bg-green-600 transition-all duration-500 rounded-full opacity-80"
                                style={{ width: `${o.expectedTotal > 0 ? (o.verifiedAnalytes / o.expectedTotal) * 100 : 0}%` }}
                              />
                              
                              {/* Progress indicator line */}
                              <div 
                                className="absolute top-0 w-0.5 h-4 bg-white shadow-lg"
                                style={{ left: `${pct}%` }}
                              />
                              
                              {/* Sparkle effect for high progress */}
                              {pct > 75 && (
                                <div className="absolute inset-0 rounded-full opacity-30">
                                  <div className="absolute top-1 left-1/4 w-1 h-1 bg-white rounded-full animate-pulse" />
                                  <div className="absolute top-2 right-1/3 w-0.5 h-0.5 bg-white rounded-full animate-pulse delay-150" />
                                  <div className="absolute bottom-1 left-2/3 w-1 h-1 bg-white rounded-full animate-pulse delay-300" />
                                </div>
                              )}
                            </div>
                            
                            {/* Enhanced legend with better spacing and icons */}
                            <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 text-sm">
                              <div className="inline-flex items-center bg-white rounded-md px-2 py-1 border border-gray-200">
                                <span className="inline-block w-3 h-3 bg-red-400 rounded-full mr-2 shadow-sm" /> 
                                <span className="text-gray-700">Pending: <strong>{Math.max(o.expectedTotal - o.enteredTotal, 0)}</strong></span>
                              </div>
                              <div className="inline-flex items-center bg-white rounded-md px-2 py-1 border border-amber-200">
                                <span className="inline-block w-3 h-3 bg-amber-500 rounded-full mr-2 shadow-sm" /> 
                                <span className="text-amber-700">For approval: <strong>{Math.max(o.enteredTotal - o.verifiedAnalytes, 0)}</strong></span>
                              </div>
                              <div className="inline-flex items-center bg-white rounded-md px-2 py-1 border border-green-200">
                                <span className="inline-block w-3 h-3 bg-green-500 rounded-full mr-2 shadow-sm" /> 
                                <span className="text-green-700">Approved: <strong>{o.verifiedAnalytes}</strong></span>
                              </div>
                              <div className="inline-flex items-center bg-white rounded-md px-2 py-1 border border-blue-200 lg:justify-end">
                                <span className={`font-bold ${pct < 25 ? 'text-red-600' : pct < 50 ? 'text-orange-600' : pct < 75 ? 'text-yellow-600' : pct < 100 ? 'text-lime-600' : 'text-green-600'}`}>
                                  {pct}% Total: {o.enteredTotal}/{o.expectedTotal}
                                </span>
                              </div>
                            </div>
                          </div>
                        )}

                        {/* Compact progress summary when collapsed */}
                        {!expanded[o.id] && (
                          <div className="mt-3 flex items-center justify-between text-sm bg-gray-50 rounded-lg p-2">
                            <div className="flex items-center gap-4">
                              <span className="text-gray-600">Progress:</span>
                              <div className="flex items-center gap-2">
                                <div className="w-16 bg-gray-200 rounded-full h-2">
                                  <div 
                                    className={`h-2 rounded-full transition-all duration-300 ${
                                      pct < 25 ? 'bg-red-500' : 
                                      pct < 50 ? 'bg-orange-500' : 
                                      pct < 75 ? 'bg-yellow-500' : 
                                      pct < 100 ? 'bg-lime-500' : 'bg-green-500'
                                    }`}
                                    style={{ width: `${pct}%` }}
                                  />
                                </div>
                                <span className={`font-medium ${pct < 50 ? 'text-red-600' : 'text-green-600'}`}>
                                  {pct}%
                                </span>
                              </div>
                            </div>
                            <div className="text-xs text-gray-500">
                              {o.enteredTotal}/{o.expectedTotal} analytes • {o.verifiedAnalytes} approved
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer quick stats */}
      <div className="bg-gradient-to-r from-blue-50 to-purple-50 rounded-lg p-4 border border-blue-200">
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-3 text-sm">
          <div className="flex items-center gap-6">
            <div className="flex items-center">
              <CalendarRange className="h-4 w-4 text-blue-600 mr-1" />
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

      {/* KPI detail modal */}
      {kpiModal?.open && (
        <KpiDetailModal
          open
          kind={kpiModal.kind}
          title={kpiModal.title}
          onClose={() => setKpiModal(null)}
          dateFrom={dateFrom}
          dateTo={dateTo}
        />
      )}

      {/* Inline OrderDetailsModal opener */}
      {inlineOrder && (
        <OrderDetailsModal
          order={{
            id: inlineOrder.id,
            patient_name: inlineOrder.patient_name,
            patient_id: inlineOrder.patient_id,
            tests: inlineOrder.tests,
            status: inlineOrder.status,
            priority: inlineOrder.priority,
            order_date: inlineOrder.order_date,
            expected_date: inlineOrder.expected_date,
            total_amount: inlineOrder.total_amount,
            doctor: inlineOrder.doctor || "",
            sample_id: inlineOrder.sample_id || undefined,
            color_code: inlineOrder.color_code || undefined,
            color_name: inlineOrder.color_name || undefined,
            qr_code_data: undefined,
            sample_collected_at: inlineOrder.sample_collected_at || undefined,
            sample_collected_by: inlineOrder.sample_collected_by || undefined,
          }}
          onClose={() => setInlineOrder(null)}
          onUpdateStatus={() => setInlineOrder(null)}
          onSubmitResults={() => setInlineOrder(null)}
        />
      )}
    </div>
  );
};

export default Dashboard;
