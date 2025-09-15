import React from "react";

export default function ReportStatusPill({ readiness }: { readiness: "pending"|"partial"|"ready" }) {
  const map = {
    pending: "bg-gray-100 text-gray-700 border-gray-200",
    partial: "bg-amber-50 text-amber-800 border-amber-200",
    ready:   "bg-emerald-50 text-emerald-800 border-emerald-200",
  } as const;

  const label = readiness === "ready" ? "Ready" : readiness === "partial" ? "Draft (Partial)" : "Pending";
  return (
    <span className={`inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-semibold border ${map[readiness]}`}>
      {label}
    </span>
  );
}
