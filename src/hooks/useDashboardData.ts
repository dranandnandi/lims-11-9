import { useEffect, useMemo, useState } from "react";
import { supabase } from "../utils/supabase";
import { DashboardOrderRow, KpiCounters } from "@/types/dashboard";

export type DashboardFilters = {
  from?: string;   // yyyy-mm-dd
  to?: string;     // yyyy-mm-dd
  status?: "all" | "pending" | "for_approval" | "approved" | "report_ready" | "delivered" | "overdue" | "balance_due";
  q?: string;
  labId?: string;
};

export function useDashboardData(filters: DashboardFilters) {
  const [rows, setRows] = useState<DashboardOrderRow[]>([]);
  const [kpis, setKpis] = useState<KpiCounters>({
    pending: 0, for_approval: 0, approved: 0, report_ready: 0, delivered: 0, overdue: 0, balance_due: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;
    (async () => {
      setLoading(true);
      setError(null);

      try {
        // Build query with proper chaining
        let query = supabase
          .from("mv_dashboard_orders")
          .select("*")
          .order("order_date", { ascending: false })
          .order("order_number", { ascending: false, nullsFirst: false });

        if (filters.from) query = query.gte("order_date", filters.from);
        if (filters.to) query = query.lte("order_date", filters.to);
        if (filters.labId) query = query.eq("lab_id", filters.labId);
        if (filters.status && filters.status !== "all") {
          if (filters.status === "overdue") query = query.eq("is_overdue", true);
          else if (filters.status === "balance_due") query = query.gt("balance_due", 0);
          else query = query.eq("dashboard_state", filters.status);
        }
        if (filters.q) {
          query = query.ilike("patient_name", `%${filters.q}%`);
        }

        const { data, error } = await query;
        if (error) throw error;

        // KPIs: small aggregate in client for now (view also exposes pre-agg if you prefer)
        const counters = {
          pending:      data?.filter(r => r.dashboard_state === "pending").length || 0,
          for_approval: data?.filter(r => r.dashboard_state === "for_approval").length || 0,
          approved:     data?.filter(r => r.dashboard_state === "approved").length || 0,
          report_ready: data?.filter(r => r.dashboard_state === "report_ready").length || 0,
          delivered:    data?.filter(r => r.dashboard_state === "delivered").length || 0,
          overdue:      data?.filter(r => r.is_overdue).length || 0,
          balance_due:  data?.filter(r => (r.balance_due ?? 0) > 0).length || 0,
        };

        if (isMounted) {
          setRows((data as DashboardOrderRow[]) || []);
          setKpis(counters);
          setLoading(false);
        }
      } catch (err) {
        console.error('Dashboard data fetch error:', err);
        if (isMounted) {
          setError(err instanceof Error ? err.message : 'Unknown error');
          setLoading(false);
        }
      }
    })();
    return () => { isMounted = false; };
  }, [filters.from, filters.to, filters.status, filters.q, filters.labId]);

  // group by date header (and keep order_number DESC inside group)
  const groups = useMemo(() => {
    const m = new Map<string, DashboardOrderRow[]>();
    rows.forEach(r => {
      const key = r.order_date; // yyyy-mm-dd
      m.set(key, [...(m.get(key) || []), r]);
    });
    return Array.from(m.entries())
      .sort((a,b) => a[0] < b[0] ? 1 : -1)
      .map(([key, arr]) => ({
        key,
        date: new Date(key),
        orders: arr.sort((a,b) => (b.order_number ?? 0) - (a.order_number ?? 0)),
      }));
  }, [rows]);

  return { loading, rows, groups, kpis, error };
}
