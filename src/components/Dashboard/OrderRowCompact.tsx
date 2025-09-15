import React from "react";
import { User, AlertTriangle } from "lucide-react";
import IconStrip from "./IconStrip";
import { DashboardOrderRow } from "@/types/dashboard";

type Props = {
  row: DashboardOrderRow;
  onView: (id: string) => void;
  actions: Omit<React.ComponentProps<typeof IconStrip>, 'row'>;
};

const OrderRowCompact: React.FC<Props> = ({ row, onView, actions }) => {
  const seq = String(row.order_number ?? 0).padStart(3, "0");
  const overdue = row.is_overdue && !row.delivered_at;
  const pct = Math.round(row.percent_complete || (row.expected_total ? (row.entered_total / row.expected_total) * 100 : 0));

  return (
    <div className="w-full p-3 border rounded-lg bg-white hover:shadow-sm transition">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 bg-blue-100 text-blue-700 rounded-full font-bold text-sm border-2 border-blue-200">
            {seq}
          </div>
          <div className="flex items-center gap-3">
            <User className="h-5 w-5 text-blue-600 shrink-0" />
            <div>
              <div className="text-base font-bold text-gray-900">{row.patient_name}</div>
              <div className="text-xs text-gray-600">ID: {row.patient_id}</div>
            </div>
          </div>
        </div>

        <IconStrip row={row} {...actions} />
      </div>

      {/* tests chips */}
      <div className="mt-2 flex flex-wrap gap-2">
        {row.tests.map((t, i) => (
          <span key={i} className={`px-2 py-1 rounded-full border text-sm ${
            t.verified ? "border-green-300 bg-green-50 text-green-800"
            : t.entered > 0 ? "border-amber-300 bg-amber-50 text-amber-800"
            : "border-blue-300 bg-blue-50 text-blue-800"
          }`}>
            {t.name} <span className="opacity-70 text-xs ml-1">{t.entered}/{t.expected}</span>
          </span>
        ))}
      </div>

      {/* progress */}
      <div className="mt-2">
        <div className="flex items-center justify-between text-xs text-gray-600 mb-1">
          <span>Progress</span>
          <span className="font-medium">{pct}% Complete</span>
        </div>
        <div className="w-full bg-blue-200/50 rounded h-2">
          <div className="bg-blue-600 h-2 rounded" style={{ width: `${pct}%` }} />
        </div>
        <div className="flex items-center gap-4 mt-1 text-xs text-gray-600">
          <span>Entered: {row.entered_total}</span>
          <span>Approved: {row.verified_total}</span>
          <span className="ml-auto">Total expected: {row.expected_total}</span>
          {overdue && <span className="inline-flex items-center text-red-600 font-medium"><AlertTriangle className="h-3 w-3 mr-1" /> Overdue</span>}
        </div>
      </div>
    </div>
  );
};

export default OrderRowCompact;
