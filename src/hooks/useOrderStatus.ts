import { useState, useEffect } from 'react';
import { supabase } from '../utils/supabase';
import { syncOrderStatusWithSampleCollection } from '../utils/statusSyncService';

interface OrderWithConsistentStatus {
  id: string;
  status: string;
  consistent_status: string;
  is_sample_collected: boolean;
  sample_collected_at?: string;
  sample_collected_by?: string;
  patient_name: string;
  order_date: string;
  expected_date: string;
  // Add other order fields as needed
}

interface UseOrderStatusResult {
  order: OrderWithConsistentStatus | null;
  loading: boolean;
  error: string | null;
  refreshOrder: () => Promise<void>;
  markAsCollected: () => Promise<boolean>;
  markAsNotCollected: () => Promise<boolean>;
}

export const useOrderStatus = (orderId: string | null): UseOrderStatusResult => {
  const [order, setOrder] = useState<OrderWithConsistentStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchOrder = async () => {
    if (!orderId) {
      setOrder(null);
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      setError(null);

      // First sync the status
      await syncOrderStatusWithSampleCollection(orderId);

      // Then fetch from the consistent view
      const { data, error: fetchError } = await supabase
        .from('orders_with_consistent_status')
        .select('*')
        .eq('id', orderId)
        .single();

      if (fetchError) {
        setError(fetchError.message);
        setOrder(null);
      } else {
        setOrder(data);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setOrder(null);
    } finally {
      setLoading(false);
    }
  };

  const markAsCollected = async (): Promise<boolean> => {
    if (!orderId) return false;

    try {
      const { error } = await supabase
        .from('orders')
        .update({
          sample_collected_at: new Date().toISOString(),
          sample_collected_by: 'current_user@example.com', // Replace with actual user
          status_updated_at: new Date().toISOString()
        })
        .eq('id', orderId);

      if (error) {
        console.error('Error marking sample as collected:', error);
        return false;
      }

      // Refresh the order data
      await fetchOrder();
      return true;
    } catch (err) {
      console.error('Error in markAsCollected:', err);
      return false;
    }
  };

  const markAsNotCollected = async (): Promise<boolean> => {
    if (!orderId) return false;

    try {
      const { error } = await supabase
        .from('orders')
        .update({
          sample_collected_at: null,
          sample_collected_by: null,
          status_updated_at: new Date().toISOString()
        })
        .eq('id', orderId);

      if (error) {
        console.error('Error marking sample as not collected:', error);
        return false;
      }

      // Refresh the order data
      await fetchOrder();
      return true;
    } catch (err) {
      console.error('Error in markAsNotCollected:', err);
      return false;
    }
  };

  useEffect(() => {
    fetchOrder();
  }, [orderId]);

  return {
    order,
    loading,
    error,
    refreshOrder: fetchOrder,
    markAsCollected,
    markAsNotCollected
  };
};

// Helper function to get the display status
export const getDisplayStatus = (order: OrderWithConsistentStatus | null): {
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

export default useOrderStatus;