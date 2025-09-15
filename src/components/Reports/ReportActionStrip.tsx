import React from "react";
import { Eye, Download, Printer, Mail, PhoneCall, CheckCircle2 } from "lucide-react";

type Props = {
  disabledSend: boolean;
  onView: () => void;
  onDownload: () => void;
  onPrintBW: () => void;
  onEmail: () => void;
  onWhatsapp: () => void;
  onMarkDelivered: () => void;
};

export default function ReportActionStrip({
  disabledSend,
  onView, onDownload, onPrintBW, onEmail, onWhatsapp, onMarkDelivered
}: Props) {
  const btn = "inline-flex items-center px-2.5 py-1 rounded-md border bg-white text-gray-700 hover:bg-gray-50";
  const primary = `inline-flex items-center px-2.5 py-1 rounded-md ${disabledSend ? "bg-gray-300 cursor-not-allowed" : "bg-blue-600 hover:bg-blue-700"} text-white`;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button className={btn} onClick={onView} title="View (opens PDF / draft)">
        <Eye className="h-4 w-4 mr-1" /> View
      </button>
      <button className={btn} onClick={onDownload} title="Download (PDF)">
        <Download className="h-4 w-4 mr-1" /> Download
      </button>
      <button className={btn} onClick={onPrintBW} title="Print (B/W)">
        <Printer className="h-4 w-4 mr-1" /> Print
      </button>
      <button className={primary} onClick={onEmail} disabled={disabledSend} title={disabledSend ? "Complete verification to send" : "Send by email"}>
        <Mail className="h-4 w-4 mr-1" /> Email
      </button>
      <button className={primary} onClick={onWhatsapp} disabled={disabledSend} title={disabledSend ? "Complete verification to send" : "Send by WhatsApp"}>
        <PhoneCall className="h-4 w-4 mr-1" /> WhatsApp
      </button>
      <button className={primary} onClick={onMarkDelivered} disabled={disabledSend} title="Mark Delivered">
        <CheckCircle2 className="h-4 w-4 mr-1" /> Delivered
      </button>
    </div>
  );
}
