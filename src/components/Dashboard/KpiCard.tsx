import React from "react";
import { CheckCircle, AlertTriangle, FileCheck, Send, Clock, IndianRupee } from "lucide-react";
import { KpiCounters } from "@/types/dashboard";

type Props = { kpis: KpiCounters; onSelect?: (key: keyof KpiCounters) => void; };

const KpiCards: React.FC<Props> = ({ kpis, onSelect }) => {
  const Item = ({
    label, value, icon, tone, keyName,
  }: { label: string; value: number; icon: React.ReactNode; tone: string; keyName: keyof KpiCounters; }) => (
    <button
      onClick={() => onSelect?.(keyName)}
      className={`flex items-center justify-between p-4 rounded-lg border ${tone} w-full text-left`}
    >
      <div>
        <div className="text-2xl font-bold">{value}</div>
        <div className="text-sm opacity-80">{label}</div>
      </div>
      <div className="p-2 rounded-lg bg-white/60">{icon}</div>
    </button>
  );

  return (
    <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
      <Item keyName="pending"      label="Pending"        value={kpis.pending}      icon={<Clock className="h-5 w-5 text-yellow-700" />}  tone="bg-yellow-50 border-yellow-200" />
      <Item keyName="for_approval" label="For approval"   value={kpis.for_approval} icon={<AlertTriangle className="h-5 w-5 text-orange-700" />} tone="bg-orange-50 border-orange-200" />
      <Item keyName="approved"     label="Approved"       value={kpis.approved}     icon={<CheckCircle className="h-5 w-5 text-green-700" />}  tone="bg-green-50 border-green-200" />
      <Item keyName="report_ready" label="Report ready"   value={kpis.report_ready} icon={<FileCheck className="h-5 w-5 text-blue-700" />}   tone="bg-blue-50 border-blue-200" />
      <Item keyName="delivered"    label="Delivered"      value={kpis.delivered}    icon={<Send className="h-5 w-5 text-indigo-700" />}      tone="bg-indigo-50 border-indigo-200" />
      <Item keyName="balance_due"  label="Balance due"    value={kpis.balance_due}  icon={<IndianRupee className="h-5 w-5 text-purple-700" />} tone="bg-purple-50 border-purple-200" />
    </div>
  );
};

export default KpiCards;
