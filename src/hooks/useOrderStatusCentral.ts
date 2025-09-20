import { useState, useCallback } from 'react';
import { database } from '../utils/supabase';
import { useAuth } from '../contexts/AuthContext';

interface StatusUpdateResult {
  success: boolean;
  message: string;
  updatedOrder?: any;
}

export const useOrderStatusCentral = () => {
  const { user } = useAuth();
  const [isUpdating, setIsUpdating] = useState(false);

  const updateOrderStatus = useCallback(async (
    orderId: string,
    newStatus: string
  ): Promise<StatusUpdateResult> => {
    setIsUpdating(true);

    try {
      const updateData: any = {
        status: newStatus,
        status_updated_at: new Date().toISOString(),
        status_updated_by: user?.email || 'Unknown'
      };

      if (newStatus === 'Sample Collection') {
        updateData.sample_collected_at = new Date().toISOString();
        updateData.sample_collected_by = user?.email || 'Unknown';
      }

      const { data, error } = await database.orders.update(orderId, updateData);
      if (error) {
        return { success: false, message: `Failed to update status: ${error.message}` };
      }

      // Auto-progression
      const { data: autoUpdate } = await database.orders.checkAndUpdateStatus(orderId);
      let message = `Order status updated to: ${newStatus}`;
      if (autoUpdate?.statusChanged) {
        message = `Order status updated to: ${autoUpdate.status} (auto from ${newStatus})`;
      }

      return { success: true, message, updatedOrder: data };
    } catch (err) {
      return { success: false, message: 'Unexpected error while updating status' };
    } finally {
      setIsUpdating(false);
    }
  }, [user]);

  const markSampleCollected = useCallback(async (orderId: string) => {
    return updateOrderStatus(orderId, 'Sample Collection');
  }, [updateOrderStatus]);

  const startProcessing = useCallback(async (orderId: string) => {
    return updateOrderStatus(orderId, 'In Progress');
  }, [updateOrderStatus]);

  const submitForApproval = useCallback(async (orderId: string) => {
    return updateOrderStatus(orderId, 'Pending Approval');
  }, [updateOrderStatus]);

  const approveResults = useCallback(async (orderId: string) => {
    return updateOrderStatus(orderId, 'Completed');
  }, [updateOrderStatus]);

  const deliverOrder = useCallback(async (orderId: string) => {
    return updateOrderStatus(orderId, 'Delivered');
  }, [updateOrderStatus]);

  return {
    updateOrderStatus,
    markSampleCollected,
    startProcessing,
    submitForApproval,
    approveResults,
    deliverOrder,
    isUpdating
  };
};

export type { StatusUpdateResult };
