import React, { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { DashboardOrderRow } from "@/types/dashboard";
import OrderRowCompact from "./OrderRowCompact";
import IconStrip from "./IconStrip";

type Props = {
  title: string;
  orders: DashboardOrderRow[];
  onViewOrder: (id: string) => void;
  actions: Omit<React.ComponentProps<typeof IconStrip>, 'row'>;
  defaultOpen?: boolean;
};

const QueueSection: React.FC<Props> = ({ title, orders, onViewOrder, actions, defaultOpen=true }) => {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="bg-white border border-gray-200 rounded-lg">
      <div className="px-4 py-3 border-b flex items-center justify-between">
        <h3 className="font-semibold">{title} <span className="text-gray-500 font-normal">({orders.length})</span></h3>
        <button onClick={() => setOpen(!open)} className="p-2 rounded hover:bg-gray-100">{open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}</button>
      </div>
      {open && (
        <div className="p-3 space-y-3">
          {orders.map(o => (
            <OrderRowCompact
              key={o.order_id}
              row={o}
              onView={onViewOrder}
              actions={actions}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default QueueSection;
