import React from 'react';
import { CheckCircle, Clock, Package, FileText, Send } from 'lucide-react';
import { useOrderStatusCentral } from '../../hooks/useOrderStatusCentral';

interface QuickStatusButtonsProps {
  orderId: string;
  currentStatus: string;
  onStatusChanged: () => void;
}

export const QuickStatusButtons: React.FC<QuickStatusButtonsProps> = ({
  orderId,
  currentStatus,
  onStatusChanged
}) => {
  const {
    markSampleCollected,
    startProcessing,
    submitForApproval,
    approveResults,
    deliverOrder,
    isUpdating
  } = useOrderStatusCentral();

  const handleStatusUpdate = async (action: () => Promise<any>) => {
    const result = await action();
    if (result.success) {
      onStatusChanged();
    } else {
      alert(result.message);
    }
  };

  // Normalize possible synonyms/variants to our canonical states
  const normalizeStatus = (s: string) => {
    if (!s) return s;
    const t = s.trim();
    if (t.toLowerCase() === 'sample collected' || t.toLowerCase() === 'samplecollection') return 'Sample Collection';
    if (t.toLowerCase() === 'in process') return 'In Progress';
    return t;
  };

  const getAvailableActions = () => {
    const status = normalizeStatus(currentStatus);
    switch (status) {
      case 'Order Created':
        return (
          <button
            onClick={() => handleStatusUpdate(() => markSampleCollected(orderId))}
            disabled={isUpdating}
            className="inline-flex items-center px-4 py-2 bg-purple-600 text-white rounded-md hover:bg-purple-700 disabled:opacity-50"
          >
            <Package className="h-4 w-4 mr-2" />
            Mark Sample Collected
          </button>
        );
      case 'Sample Collection':
        return (
          <button
            onClick={() => handleStatusUpdate(() => startProcessing(orderId))}
            disabled={isUpdating}
            className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
          >
            <Clock className="h-4 w-4 mr-2" />
            Start Processing
          </button>
        );
      case 'Sample Collected': // tolerate this variant
        return (
          <button
            onClick={() => handleStatusUpdate(() => startProcessing(orderId))}
            disabled={isUpdating}
            className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
          >
            <Clock className="h-4 w-4 mr-2" />
            Start Processing
          </button>
        );
      case 'In Progress':
        return (
          <button
            onClick={() => handleStatusUpdate(() => submitForApproval(orderId))}
            disabled={isUpdating}
            className="inline-flex items-center px-4 py-2 bg-yellow-600 text-white rounded-md hover:bg-yellow-700 disabled:opacity-50"
          >
            <FileText className="h-4 w-4 mr-2" />
            Submit for Approval
          </button>
        );
      case 'Pending Approval':
        return (
          <button
            onClick={() => handleStatusUpdate(() => approveResults(orderId))}
            disabled={isUpdating}
            className="inline-flex items-center px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50"
          >
            <CheckCircle className="h-4 w-4 mr-2" />
            Approve Results
          </button>
        );
      case 'Completed':
        return (
          <button
            onClick={() => handleStatusUpdate(() => deliverOrder(orderId))}
            disabled={isUpdating}
            className="inline-flex items-center px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50"
          >
            <Send className="h-4 w-4 mr-2" />
            Mark as Delivered
          </button>
        );
      default:
        return null;
    }
  };

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium text-gray-700">Quick Status Updates</h3>
      {getAvailableActions()}
      {isUpdating && (
        <div className="text-sm text-gray-500 italic">Updating status...</div>
      )}
    </div>
  );
};

export default QuickStatusButtons;
