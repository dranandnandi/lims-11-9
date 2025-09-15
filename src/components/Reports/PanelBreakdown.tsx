import React from "react";

type Panel = { name: string; expected: number; entered: number; verified: number; };
export default function PanelBreakdown({ panels }: { panels: Panel[] }) {
  if (!panels?.length) return null;
  return (
    <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
      <div className="text-sm text-gray-600 mb-2">Tests</div>
      <div className="flex flex-wrap gap-2">
        {panels.map((p, i) => {
          const pct = p.expected ? Math.round((p.entered / p.expected) * 100) : 0;
          const tone =
            p.verified === p.expected ? "bg-emerald-50 border-emerald-200 text-emerald-800" :
            pct === 0 ? "bg-gray-100 border-gray-300 text-gray-700" :
            "bg-amber-50 border-amber-200 text-amber-800";
          return (
            <span key={i} className={`inline-flex items-center rounded-full border px-3 py-1 text-sm ${tone}`}>
              {p.name}
              <span className="ml-2 text-xs opacity-80">{p.entered}/{p.expected} • Verified {p.verified}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}
