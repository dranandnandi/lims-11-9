import { supabase } from './supabase';

export interface OrderStatusUpdate {
  orderId: string;
  newStatus: string;
  sampleCollectedAt?: string | null;
  sampleCollectedBy?: string | null;
  updatedBy?: string;
}

export class StatusSyncService {
  /**
   * Update order status with automatic sample collection sync
   */
  static async updateOrderStatus(update: OrderStatusUpdate): Promise<{ success: boolean; data?: any; error?: string }> {
    try {
      const { data: user } = await supabase.auth.getUser();
      const updaterName = update.updatedBy || user.data.user?.user_metadata?.full_name || user.data.user?.email || 'Unknown User';
      
      // Prepare update payload
      const updatePayload: any = {
        status: update.newStatus,
        status_updated_at: new Date().toISOString(),
        status_updated_by: updaterName
      };

      // Handle sample collection status changes
      if (update.newStatus === 'Sample Collected' || update.newStatus === 'In Progress') {
        // If marking as collected or in progress, ensure sample collection fields are set
        if (!update.sampleCollectedAt) {
          updatePayload.sample_collected_at = new Date().toISOString();
          updatePayload.sample_collected_by = updaterName;
        }
      } else if (update.newStatus === 'Pending Collection' || update.newStatus === 'Order Created') {
        // If marking as pending collection, clear sample collection fields
        updatePayload.sample_collected_at = null;
        updatePayload.sample_collected_by = null;
      }

      // Apply the update
      const { data, error } = await supabase
        .from('orders')
        .update(updatePayload)
        .eq('id', update.orderId)
        .select()
        .single();

      if (error) {
        console.error('Error updating order status:', error);
        return { success: false, error: error.message };
      }

      console.log('Order status updated successfully:', data);
      return { success: true, data };
    } catch (err) {
      console.error('Error in updateOrderStatus:', err);
      return { success: false, error: 'Failed to update order status' };
    }
  }

  /**
   * Mark sample as collected
   */
  static async markSampleCollected(orderId: string, collectedBy?: string): Promise<{ success: boolean; data?: any; error?: string }> {
    try {
      const { data: user } = await supabase.auth.getUser();
      const collectorName = collectedBy || user.data.user?.user_metadata?.full_name || user.data.user?.email || 'Unknown User';
      
      const { data, error } = await supabase
        .from('orders')
        .update({
          sample_collected_at: new Date().toISOString(),
          sample_collected_by: collectorName,
          status: 'Sample Collected',
          status_updated_at: new Date().toISOString(),
          status_updated_by: collectorName
        })
        .eq('id', orderId)
        .select()
        .single();

      if (error) {
        console.error('Error marking sample as collected:', error);
        return { success: false, error: error.message };
      }

      console.log('Sample marked as collected successfully:', data);
      return { success: true, data };
    } catch (err) {
      console.error('Error in markSampleCollected:', err);
      return { success: false, error: 'Failed to mark sample as collected' };
    }
  }

  /**
   * Mark sample as not collected
   */
  static async markSampleNotCollected(orderId: string): Promise<{ success: boolean; data?: any; error?: string }> {
    try {
      const { data: user } = await supabase.auth.getUser();
      const updaterName = user.data.user?.user_metadata?.full_name || user.data.user?.email || 'Unknown User';
      
      const { data, error } = await supabase
        .from('orders')
        .update({
          sample_collected_at: null,
          sample_collected_by: null,
          status: 'Pending Collection',
          status_updated_at: new Date().toISOString(),
          status_updated_by: updaterName
        })
        .eq('id', orderId)
        .select()
        .single();

      if (error) {
        console.error('Error marking sample as not collected:', error);
        return { success: false, error: error.message };
      }

      console.log('Sample marked as not collected successfully:', data);
      return { success: true, data };
    } catch (err) {
      console.error('Error in markSampleNotCollected:', err);
      return { success: false, error: 'Failed to mark sample as not collected' };
    }
  }

  /**
   * Check if order status is consistent with sample collection
   */
  static checkStatusConsistency(order: any): { isConsistent: boolean; recommendedStatus: string; issue?: string } {
    const hasCollectedSample = !!(order.sample_collected_at && order.sample_collected_by);
    
    if (hasCollectedSample) {
      if (order.status === 'Pending Collection' || order.status === 'Order Created') {
        return {
          isConsistent: false,
          recommendedStatus: 'Sample Collected',
          issue: 'Sample is collected but status shows pending collection'
        };
      }
      return { isConsistent: true, recommendedStatus: order.status };
    } else {
      if (order.status === 'Sample Collected' || order.status === 'In Progress') {
        return {
          isConsistent: false,
          recommendedStatus: 'Pending Collection',
          issue: 'Status shows collected but sample collection data is missing'
        };
      }
      return { isConsistent: true, recommendedStatus: order.status };
    }
  }

  useEffect(() => {
    loadOrder();
  }, [orderId]);

  return {
    order,
    loading,
    error,
    reload: loadOrder
  };
};