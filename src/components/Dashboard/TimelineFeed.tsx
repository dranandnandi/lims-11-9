import React from "react";
import { Clock } from "lucide-react";

export type TimelineItem = {
  ts: string; // ISO
  type: "sample" | "entered" | "submitted" | "verified" | "report" | "sent" | "payment" | "attachment" | "ai";
  text: string;
  order_id: string;
};

const TimelineFeed: React.FC<{ items: TimelineItem[]; onJumpToOrder?: (id: string) => void; }> = ({ items, onJumpToOrder }) => {
  return (
    <div className="bg-white border border-gray-200 rounded-lg">
      <div className="px-4 py-3 border-b font-semibold">Recent Activity</div>
      <div className="p-3 space-y-3">
        {items.map((it, idx) => (
          <button key={idx} onClick={() => onJumpToOrder?.(it.order_id)} className="w-full text-left p-2 rounded hover:bg-gray-50">
            <div className="text-xs text-gray-500 flex items-center"><Clock className="h-3 w-3 mr-1" /> {new Date(it.ts).toLocaleString()}</div>
            <div className="text-sm">{it.text}</div>
          </button>
        ))}
        {items.length === 0 && <div className="text-sm text-gray-500 p-2">No recent events</div>}
      </div>
    </div>
  );
};

export default TimelineFeed;
