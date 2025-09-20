import React from "react";
import { X, Search, Eye, Loader2, AlertTriangle } from "lucide-react";
import { supabase, database } from "../../utils/supabase";
import OrderDetailsModal from "../Orders/OrderDetailsModal";

export type KpiKind =
  | "approved"          // results.verification_status = 'verified'
  | "for_approval"      // pending_verification / needs_clarification
  | "pending"           // nothing entered yet
  | "overdue"           // expected_date < today & not delivered
  | "in_process";       // working, not yet verified

type DateRange = { from?: string; to?: string };

type Row = {
  id: string;
  patient_name: string;
  patient_id: string;
  status: string;
  order_date: string;
  expected_date: string;
  total_amount: number | null;
  sample_id: string | null;
  panels?: string[];       // optional
  progress?: string | null; // optional “entered/expected”
};

type Props = {
  open: boolean;
  onClose: () => void;
  kind: KpiKind;
  title?: string;
  dateRange?: DateRange;
};

const KpiDetailModal: React.FC<Props> = ({ open, onClose, kind, title, dateRange }) => {
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [rows, setRows] = React.useState<Row[]>([]);
  const [q, setQ] = React.useState("");
  const [selected, setSelected] = React.useState<Row | null>(null);

  const labelForKind: Record<KpiKind, string> = {
    approved: "Approved (Verified) Orders",
    for_approval: "Orders Waiting for Approval",
    pending: "Orders with No Results Entered",
    overdue: "Overdue Orders",
    in_process: "Orders In Process",
  };

  React.useEffect(() => {
    if (!open) return;
    let abort = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        // Base selector for orders we’ll always show in the table
        const baseSelect = `
          id, patient_id, patient_name, status, order_date, expected_date,
          total_amount, sample_id
        `;

        const applyDate = (query: any) => {
          if (dateRange?.from) query.gte("order_date", dateRange.from);
          if (dateRange?.to) query.lte("order_date", dateRange.to);
          return query;
        };

        let list: Row[] = [];

        if (kind === "approved") {
          // Use results with verified status, then join orders in a second query
          const { data: rids, error: rErr } = await supabase
            .from("results")
            .select("order_id")
            .eq("verification_status", "verified");
          if (rErr) throw rErr;
          const orderIds = Array.from(new Set((rids || []).map((r) => r.order_id).filter(Boolean)));
          if (orderIds.length === 0) {
            list = [];
          } else {
            let q1 = supabase.from("orders").select(baseSelect).in("id", orderIds);
            q1 = applyDate(q1);
            const { data: o, error: oErr } = await q1;
            if (oErr) throw oErr;
            list = (o || []) as Row[];
          }
        }

        if (kind === "for_approval") {
          const { data: r2, error: r2Err } = await supabase
            .from("results")
            .select("order_id")
            .in("verification_status", ["pending_verification", "needs_clarification"]);
          if (r2Err) throw r2Err;
          const orderIds = Array.from(new Set((r2 || []).map((r) => r.order_id).filter(Boolean)));
          let q1 = supabase.from("orders").select(baseSelect).in("id", orderIds);
          q1 = applyDate(q1);
          const { data: o, error: oErr } = await q1;
          if (oErr) throw oErr;
          list = (o || []) as Row[];
        }

        if (kind === "pending") {
          // Orders with no result_values at all
          // (left join emulation: pull orders then filter by NOT IN results.order_id)
          const { data: withResults, error: wrErr } = await supabase
            .from("result_values")
            .select("order_id");
          if (wrErr) throw wrErr;
          const hasRes = new Set((withResults || []).map((x) => x.order_id));
          let q1 = supabase.from("orders").select(baseSelect);
          q1 = applyDate(q1);
          const { data: o, error: oErr } = await q1;
          if (oErr) throw oErr;
          list = (o || [])
            .filter((r) => !hasRes.has(r.id) && (r.status === "Order Created" || r.status === "Sample Collection" || r.status === "In Progress")) as Row[];
        }

        if (kind === "overdue") {
          const { data: o, error: oErr } = await supabase
            .from("orders")
            .select(baseSelect)
            .lt("expected_date", new Date().toISOString().slice(0, 10))
            .not("status", "in", '("Completed","Delivered")');
          if (oErr) throw oErr;
          list = (o || []) as Row[];
        }

        if (kind === "in_process") {
          const { data: o, error: oErr } = await supabase
            .from("orders")
            .select(baseSelect)
            .eq("status", "In Progress");
          if (oErr) throw oErr;
          list = (o || []) as Row[];
        }

        // Optional: try enrich with simple panel names (best effort)
        try {
          const ids = list.map((r) => r.id);
          if (ids.length) {
            const { data: ots } = await supabase
              .from("order_test_groups")
              .select("order_id, test_name")
              .in("order_id", ids);
            const byOrder = new Map<string, string[]>();
            (ots || []).forEach((t) => {
              const arr = byOrder.get(t.order_id) || [];
              arr.push(t.test_name);
              byOrder.set(t.order_id, arr);
            });
            list = list.map((r) => ({ ...r, panels: byOrder.get(r.id) || [] }));
          }
        } catch {
          // ignore enrichment failures
        }

        if (!abort) setRows(list);
      } catch (e: any) {
        if (!abort) setError(e?.message || "Failed to load data.");
      } finally {
        if (!abort) setLoading(false);
      }
    })();

    return () => {
      abort = true;
    };
  }, [open, kind, dateRange?.from, dateRange?.to]);

  const filtered = React.useMemo(() => {
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
        {/* header */}
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <div>
            <div className="text-lg md:text-xl font-semibold text-gray-900">
              {title || labelForKind[kind]}
            </div>
            <div className="text-xs text-gray-500">
              {dateRange?.from ? `From ${dateRange.from}` : ""}{" "}
              {dateRange?.to ? `to ${dateRange.to}` : ""}
            </div>
          </div>
          <button className="p-2 rounded-lg hover:bg-gray-100" onClick={onClose}>
            <X className="h-5 w-5 text-gray-600" />
          </button>
        </div>

        {/* controls */}
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

        {/* body */}
        <div className="px-5 py-4 max-h-[70vh] overflow-auto">
          {loading ? (
            <div className="py-16 flex items-center justify-center text-gray-600">
              <Loader2 className="h-5 w-5 animate-spin mr-2" />
              Loading…
            </div>
          ) : error ? (
            <div className="py-12 flex items-center justify-center text-red-700">
              <AlertTriangle className="h-5 w-5 mr-2" /> {error}
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-12 text-center text-gray-600">No records.</div>
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
                        {r.panels && r.panels.length ? (
                          <div className="flex flex-wrap gap-1">
                            {r.panels.slice(0, 3).map((p, i) => (
                              <span key={i} className="px-2 py-0.5 text-xs rounded-full bg-gray-100 text-gray-700">
                                {p}
                              </span>
                            ))}
                            {r.panels.length > 3 && (
                              <span className="px-2 py-0.5 text-xs rounded-full bg-gray-50 text-gray-500">
                                +{r.panels.length - 3} more
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

      {/* open your existing OrderDetailsModal on row click */}
      {selected && (
        <OrderDetailsModal
          order={{
            id: selected.id,
            patient_name: selected.patient_name,
            patient_id: selected.patient_id,
            tests: selected.panels || [],
            status: "In Progress",
            priority: "Normal",
            order_date: selected.order_date,
            expected_date: selected.expected_date,
            total_amount: Number(selected.total_amount || 0),
            doctor: "",
            sample_id: null,
            color_code: null,
            color_name: null,
            qr_code_data: null,
            sample_collected_at: null,
            sample_collected_by: null,
          }}
          onClose={() => setSelected(null)}
          onUpdateStatus={async (orderId: string, newStatus: string) => {
            try {
              // Update the order status in the database
              const { error } = await database.orders.update(orderId, { 
                status: newStatus,
                status_updated_at: new Date().toISOString()
              });
              if (error) {
                console.error('Error updating order status:', error);
                return;
              }
              
              console.log(`Order ${orderId} status updated to: ${newStatus}`);
              setSelected(null);
            } catch (error) {
              console.error('Error updating order status:', error);
            }
          }}
          onSubmitResults={() => setSelected(null)}
        />
      )}
    </div>
  );
};

export default KpiDetailModal;
