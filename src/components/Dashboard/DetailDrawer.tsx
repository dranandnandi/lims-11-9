import React from "react";
import { X, User, Calendar } from "lucide-react";

type Props = {
  open: boolean;
  onClose: () => void;
  row: any;
};

const DetailDrawer: React.FC<Props> = ({ open, onClose, row }) => {
  if (!open || !row) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-hidden">
      <div className="absolute inset-0 bg-black bg-opacity-50" onClick={onClose} />
      <div className="absolute right-0 top-0 h-full w-96 bg-white shadow-xl">
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="text-lg font-semibold">Order Details</h2>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-4 space-y-4">
          <div className="flex items-center gap-3">
            <User className="h-5 w-5 text-blue-600" />
            <div>
              <div className="font-semibold">{row.patient_name}</div>
              <div className="text-sm text-gray-600">ID: {row.patient_id}</div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Calendar className="h-5 w-5 text-gray-600" />
            <div>
              <div className="text-sm">Order Date: {new Date(row.order_date).toLocaleDateString()}</div>
              <div className="text-sm">Expected: {new Date(row.expected_date).toLocaleDateString()}</div>
            </div>
          </div>
          <div className="text-sm">
            <div className="font-medium">Status: {row.dashboard_state}</div>
            <div>Progress: {row.entered_total}/{row.expected_total} tests</div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default DetailDrawer;
