import React from "react";

/** Minimal placeholder so the page builds. Replace with real audit later. */
const ResultAudit: React.FC<{ orderId: string }> = ({ orderId }) => {
  return (
    <div className="p-4 rounded-lg border bg-white">
      <h3 className="text-lg font-semibold">Result Audit</h3>
      <p className="text-sm text-gray-600">
        Audit view not wired yet. Order: <span className="font-mono">{orderId}</span>
      </p>
    </div>
  );
};

export default ResultAudit;
