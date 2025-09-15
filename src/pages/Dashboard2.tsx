import React, { useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";

import { useDashboardData } from "../hooks/useDashboardData";
import type { DashboardOrderRow, DashboardState } from "../types/dashboard";

import FiltersBar from "../components/Dashboard/FiltersBar";
import KpiCards from "../components/Dashboard/KpiCards";
import QueueSection from "../components/Dashboard/QueueSection";
import OrderRowCompact from "../components/Dashboard/OrderRowCompact";
import DetailDrawer from "../components/Dashboard/DetailDrawer";
import TimelineFeed, { TimelineItem } from "../components/Dashboard/TimelineFeed";

/**
 * Modern, dense “Dashboard 2” page.
 * - Groups orders by Date (DESC) and within each group by order_number (DESC)
 * - KPI summary + filters
 * - Date grouped stream on the left, status queues + activity on the right
 * - Uses modular components so you can revert/swizzle pieces easily
 */

const Dashboard2: React.FC = () => {
  // ---- filters / state ------------------------------------------------------
  const [filters, setFilters] = useState<{ from?: string; to?: string; status?: any; q?: string; labId?: string }>({
    status: "all",
  });
  const [selected, setSelected] = useState<DashboardOrderRow | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  // Use data hook (materialized view under the hood)
  const { loading, rows, groups, kpis } = useDashboardData({ ...filters, /* bump to refetch */ q: filters.q, });

  // ---- handlers (wire your real flows here) ---------------------------------
  const onViewOrder = (id: string) => {
    const r = rows.find((x) => x.order_id === id) || null;
    setSelected(r);
  };
  const onApprove = (id: string) => {
    console.log("approve / verify flow →", id);
  };
  const onGenerate = (id: string) => {
    console.log("generate report →", id);
  };
  const onSend = (id: string) => {
    console.log("send report →", id);
  };
  const onPayments = (id: string) => {
    console.log("open payments →", id);
  };
  const onAttachments = (id: string) => {
    console.log("open attachments →", id);
  };
  const onAIConsole = (id: string) => {
    console.log("open AI console →", id);
  };

  // actions bag for row icon-strip
  const actions = {
    onView: onViewOrder,
    onApprove,
    onGenerate,
    onSend,
    onPayments,
    onAttachments,
    onAIConsole,
  };

  // status queues for the right column
  const byState = useMemo(() => {
    const pick = (s: DashboardState) => rows.filter((r) => r.dashboard_state === s);
    return {
      pending: pick("pending").slice(0, 8),
      for_approval: pick("for_approval").slice(0, 8),
      approved: pick("approved").slice(0, 8),
      report_ready: pick("report_ready").slice(0, 8),
      delivered: pick("delivered").slice(0, 8),
    };
  }, [rows]);

  // simple activity feed derived from row timestamps
  const activity: TimelineItem[] = useMemo(() => {
    const items: TimelineItem[] = [];
    rows.forEach((r) => {
      if (r.sample_collected_at)
        items.push({ ts: r.sample_collected_at, type: "sample", text: `Sample collected • ${r.patient_name}`, order_id: r.order_id });
      if (r.verified_total > 0 && r.all_verified)
        items.push({ ts: r.expected_date, type: "verified", text: `All panels verified • ${r.patient_name}`, order_id: r.order_id });
      if (r.report_pdf_ready)
        items.push({ ts: r.expected_date, type: "report", text: `Report ready • ${r.patient_name}`, order_id: r.order_id });
      if (r.delivered_at)
        items.push({ ts: r.delivered_at, type: "sent", text: `Report delivered • ${r.patient_name}`, order_id: r.order_id });
    });
    return items.sort((a, b) => (a.ts < b.ts ? 1 : -1)).slice(0, 15);
  }, [rows]);

  // date formatter
  const fmtDate = (iso: string) =>
    new Date(iso).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

  // ---- UI -------------------------------------------------------------------
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Operational Dashboard 2</h1>
          <p className="text-sm text-gray-600">Date-wise stream • Quick queues • Activity</p>
        </div>
        <button
          onClick={() => setRefreshTick((n) => n + 1)}
          className="inline-flex items-center px-3 py-2 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
          title="Refresh data"
        >
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {/* Filters + KPI */}
      <FiltersBar value={filters as any} onChange={setFilters as any} />
      <KpiCards
        kpis={kpis}
        onSelect={(key) => {
          // clicking a KPI filters the list
          const map: Record<string, any> = {
            pending: "pending",
            for_approval: "for_approval",
            approved: "approved",
            report_ready: "report_ready",
            delivered: "delivered",
            overdue: "overdue",
            balance_due: "balance_due",
          };
          setFilters((f) => ({ ...f, status: map[key] ?? "all" }));
        }}
      />

      {/* Main layout */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* LEFT: Date groups stream */}
        <div className="lg:col-span-8 space-y-8">
          {loading && (
            <div className="space-y-4">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="animate-pulse">
                  <div className="h-4 w-48 bg-gray-200 rounded mb-3" />
                  <div className="h-28 bg-white border rounded-lg" />
                </div>
              ))}
            </div>
          )}

          {!loading && groups.length === 0 && (
            <div className="text-center p-10 bg-white border rounded-lg text-gray-600">No orders for the selected filters.</div>
          )}

          {!loading &&
            groups.map((g) => (
              <section key={g.key}>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-base font-semibold text-gray-800">{fmtDate(g.key)}</h3>
                  <div className="text-xs text-gray-500">{g.orders.length} order{g.orders.length !== 1 ? "s" : ""}</div>
                </div>
                <div className="space-y-3">
                  {g.orders.map((o: DashboardOrderRow) => (
                    <OrderRowCompact key={o.order_id} row={o} onView={onViewOrder} actions={actions} />
                  ))}
                </div>
              </section>
            ))}
        </div>

        {/* RIGHT: Queues + Activity */}
        <div className="lg:col-span-4 space-y-6">
          <QueueSection
            title="Pending"
            orders={byState.pending}
            onViewOrder={onViewOrder}
            actions={actions}
            defaultOpen={true}
          />
          <QueueSection
            title="For approval"
            orders={byState.for_approval}
            onViewOrder={onViewOrder}
            actions={actions}
            defaultOpen={true}
          />
          <QueueSection
            title="Approved"
            orders={byState.approved}
            onViewOrder={onViewOrder}
            actions={actions}
            defaultOpen={false}
          />
          <QueueSection
            title="Report ready"
            orders={byState.report_ready}
            onViewOrder={onViewOrder}
            actions={actions}
            defaultOpen={false}
          />
          <TimelineFeed items={activity} onJumpToOrder={onViewOrder} />
        </div>
      </div>

      {/* Slide-over details */}
      <DetailDrawer open={!!selected} onClose={() => setSelected(null)} row={selected} />
    </div>
  );
};

export default Dashboard2;
