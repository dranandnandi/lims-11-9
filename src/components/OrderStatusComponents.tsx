import React from 'react';
import { Clock, CheckCircle, AlertCircle, FileText, Package } from 'lucide-react';
// Helper function to get the display status (simplified for component use)
const getDisplayStatusForComponent = (order: {
  consistent_status: string;
  is_sample_collected: boolean;
} | null): {
  status: string;
  color: string;
  bgColor: string;
} => {
  if (!order) {
    return {
      status: 'Unknown',
      color: 'text-gray-600',
      bgColor: 'bg-gray-100'
    };
  }

  const status = order.consistent_status;

  switch (status) {
    case 'Pending Collection':
      return {
        status: 'Pending Collection',
        color: 'text-orange-600',
        bgColor: 'bg-orange-100'
      };
    case 'Sample Collected':
      return {
        status: 'Sample Collected',
        color: 'text-green-600',
        bgColor: 'bg-green-100'
      };
    case 'In Progress':
      return {
        status: 'In Progress',
        color: 'text-blue-600',
        bgColor: 'bg-blue-100'
      };
    case 'Report Ready':
      return {
        status: 'Report Ready',
        color: 'text-purple-600',
        bgColor: 'bg-purple-100'
      };
    case 'Completed':
      return {
        status: 'Completed',
        color: 'text-green-700',
        bgColor: 'bg-green-200'
      };
    default:
      return {
        status: status,
        color: 'text-gray-600',
        bgColor: 'bg-gray-100'
      };
  }
};

interface OrderStatusBadgeProps {
  order: {
    consistent_status: string;
    is_sample_collected: boolean;
    sample_collected_at?: string;
    sample_collected_by?: string;
  } | null;
  showDetails?: boolean;
  size?: 'sm' | 'md' | 'lg';
}

export const OrderStatusBadge: React.FC<OrderStatusBadgeProps> = ({
  order,
  showDetails = false,
  size = 'md'
}) => {
  const displayInfo = getDisplayStatusForComponent(order);
  
  const sizeClasses = {
    sm: 'px-2 py-1 text-xs',
    md: 'px-3 py-1 text-sm',
    lg: 'px-4 py-2 text-base'
  };

  const iconSizes = {
    sm: 'w-3 h-3',
    md: 'w-4 h-4',
    lg: 'w-5 h-5'
  };

  const getIcon = () => {
    if (!order) return <AlertCircle className={iconSizes[size]} />;
    
    switch (order.consistent_status) {
      case 'Pending Collection':
        return <Clock className={iconSizes[size]} />;
      case 'Sample Collected':
        return <CheckCircle className={iconSizes[size]} />;
      case 'In Progress':
        return <Package className={iconSizes[size]} />;
      case 'Report Ready':
        return <FileText className={iconSizes[size]} />;
      case 'Completed':
        return <CheckCircle className={iconSizes[size]} />;
      default:
        return <AlertCircle className={iconSizes[size]} />;
    }
  };

  return (
    <div className="flex flex-col space-y-2">
      {/* Main Status Badge */}
      <div className={`
        inline-flex items-center space-x-2 rounded-full font-medium
        ${sizeClasses[size]} ${displayInfo.color} ${displayInfo.bgColor}
      `}>
        {getIcon()}
        <span>{displayInfo.status}</span>
      </div>

      {/* Sample Collection Details */}
      {showDetails && order?.is_sample_collected && (
        <div className="text-xs text-gray-600 bg-green-50 px-2 py-1 rounded border-l-2 border-green-400">
          <div className="flex items-center space-x-1">
            <CheckCircle className="w-3 h-3 text-green-600" />
            <span className="font-medium">Sample Collected</span>
          </div>
          {order.sample_collected_at && (
            <div className="mt-1">
              <div>
                {new Date(order.sample_collected_at).toLocaleDateString()} at{' '}
                {new Date(order.sample_collected_at).toLocaleTimeString()}
              </div>
              {order.sample_collected_by && (
                <div className="text-green-700">By: {order.sample_collected_by}</div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Pending Collection Notice */}
      {showDetails && !order?.is_sample_collected && order?.consistent_status === 'Pending Collection' && (
        <div className="text-xs text-orange-600 bg-orange-50 px-2 py-1 rounded border-l-2 border-orange-400">
          <div className="flex items-center space-x-1">
            <Clock className="w-3 h-3 text-orange-600" />
            <span className="font-medium">Awaiting Sample Collection</span>
          </div>
        </div>
      )}
    </div>
  );
};

interface SampleCollectionToggleProps {
  order: {
    id: string;
    consistent_status: string;
    is_sample_collected: boolean;
  } | null;
  onToggle: (collected: boolean) => Promise<boolean>;
  disabled?: boolean;
}

export const SampleCollectionToggle: React.FC<SampleCollectionToggleProps> = ({
  order,
  onToggle,
  disabled = false
}) => {
  const [isUpdating, setIsUpdating] = React.useState(false);

  const handleToggle = async () => {
    if (!order || disabled || isUpdating) return;

    setIsUpdating(true);
    try {
      const success = await onToggle(!order.is_sample_collected);
      if (!success) {
        // Handle error - maybe show a toast
        console.error('Failed to update sample collection status');
      }
    } finally {
      setIsUpdating(false);
    }
  };

  if (!order) return null;

  return (
    <button
      onClick={handleToggle}
      disabled={disabled || isUpdating}
      className={`
        inline-flex items-center space-x-2 px-3 py-2 rounded-md text-sm font-medium
        transition-colors duration-200
        ${order.is_sample_collected
          ? 'bg-green-100 text-green-700 hover:bg-green-200'
          : 'bg-orange-100 text-orange-700 hover:bg-orange-200'
        }
        ${(disabled || isUpdating) ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
      `}
    >
      {isUpdating ? (
        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-current"></div>
      ) : order.is_sample_collected ? (
        <CheckCircle className="w-4 h-4" />
      ) : (
        <Clock className="w-4 h-4" />
      )}
      <span>
        {isUpdating 
          ? 'Updating...'
          : order.is_sample_collected 
            ? 'Mark as Not Collected' 
            : 'Mark as Collected'
        }
      </span>
    </button>
  );
};

export default {
  OrderStatusBadge,
  SampleCollectionToggle
};