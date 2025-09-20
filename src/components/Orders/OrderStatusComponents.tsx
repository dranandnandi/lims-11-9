import React from 'react';
import { CheckCircle, Clock, AlertTriangle, Package, Truck } from 'lucide-react';

interface OrderStatusBadgeProps {
  order: {
    status: string;
    sample_collected_at?: string | null;
    sample_collected_by?: string | null;
  };
  showDetails?: boolean;
  className?: string;
}

export const OrderStatusBadge: React.FC<OrderStatusBadgeProps> = ({ 
  order, 
  showDetails = false, 
  className = '' 
}) => {
  const getStatusInfo = () => {
    // Determine consistent status based on sample collection
    const hasCollectedSample = !!(order.sample_collected_at && order.sample_collected_by);
    
    if (hasCollectedSample) {
      switch (order.status) {
        case 'In Progress':
        case 'Sample Collected':
          return {
            status: 'Sample Collected',
            color: 'bg-blue-100 text-blue-800',
            icon: Package,
            description: 'Sample has been collected and is ready for processing'
          };
        case 'Pending Approval':
          return {
            status: 'Pending Approval',
            color: 'bg-yellow-100 text-yellow-800',
            icon: AlertTriangle,
            description: 'Results are ready and awaiting approval'
          };
        case 'Completed':
          return {
            status: 'Completed',
            color: 'bg-green-100 text-green-800',
            icon: CheckCircle,
            description: 'All tests completed and approved'
          };
        case 'Delivered':
          return {
            status: 'Delivered',
            color: 'bg-gray-100 text-gray-800',
            icon: Truck,
            description: 'Results have been delivered to patient'
          };
        default:
          return {
            status: 'Sample Collected',
            color: 'bg-blue-100 text-blue-800',
            icon: Package,
            description: 'Sample collected and processing'
          };
      }
    } else {
      return {
        status: 'Pending Collection',
        color: 'bg-orange-100 text-orange-800',
        icon: Clock,
        description: 'Waiting for sample collection'
      };
    }
  };

  const statusInfo = getStatusInfo();
  const Icon = statusInfo.icon;

  return (
    <div className={`inline-flex items-center gap-2 ${className}`}>
      <span className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium ${statusInfo.color}`}>
        <Icon className="h-4 w-4 mr-1" />
        {statusInfo.status}
      </span>
      
      {showDetails && order.sample_collected_at && (
        <div className="text-xs text-gray-600">
          <div>Collected: {new Date(order.sample_collected_at).toLocaleString()}</div>
          {order.sample_collected_by && (
            <div>By: {order.sample_collected_by}</div>
          )}
        </div>
      )}
    </div>
  );
};

interface SampleCollectionButtonProps {
  order: {
    id: string;
    status: string;
    sample_collected_at?: string | null;
    sample_collected_by?: string | null;
  };
  onCollectionUpdate: (orderId: string, newStatus: string) => void;
  disabled?: boolean;
  className?: string;
}

export const SampleCollectionButton: React.FC<SampleCollectionButtonProps> = ({
  order,
  onCollectionUpdate,
  disabled = false,
  className = ''
}) => {
  const [updating, setUpdating] = useState(false);

  const handleToggleCollection = async () => {
    setUpdating(true);
    try {
      const isCollected = !!(order.sample_collected_at && order.sample_collected_by);
      
      if (isCollected) {
        const { success, error } = await database.orders.markSampleNotCollected(order.id);
        if (success) {
          onCollectionUpdate(order.id, 'Pending Collection');
        } else {
          console.error('Failed to mark as not collected:', error);
          alert('Failed to update sample collection status');
        }
      } else {
        const { success, error } = await database.orders.markSampleCollected(order.id);
        if (success) {
          onCollectionUpdate(order.id, 'Sample Collected');
        } else {
          console.error('Failed to mark as collected:', error);
          alert('Failed to update sample collection status');
        }
      }
    } catch (err) {
      console.error('Error toggling sample collection:', err);
      alert('An error occurred while updating sample collection status');
    } finally {
      setUpdating(false);
    }
  };

  const isCollected = !!(order.sample_collected_at && order.sample_collected_by);

  return (
    <button
      onClick={handleToggleCollection}
      disabled={disabled || updating}
      className={`inline-flex items-center px-4 py-2 rounded-md text-sm font-medium transition-colors ${
        isCollected
          ? 'bg-red-100 text-red-700 hover:bg-red-200'
          : 'bg-green-100 text-green-700 hover:bg-green-200'
      } disabled:opacity-50 disabled:cursor-not-allowed ${className}`}
    >
      {updating ? (
        <>
          <div className="animate-spin rounded-full h-4 w-4 border-2 border-current border-t-transparent mr-2"></div>
          Updating...
        </>
      ) : isCollected ? (
        <>
          <Clock className="h-4 w-4 mr-2" />
          Mark Not Collected
        </>
      ) : (
        <>
          <CheckCircle className="h-4 w-4 mr-2" />
          Mark Sample Collected
        </>
      )}
    </button>
  );
};