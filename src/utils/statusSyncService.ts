// Status Synchronization Fix
// This file addresses the disconnect between order status and sample collection status

import { supabase } from '../utils/supabase';

// Function to sync order status with sample collection status
export const syncOrderStatusWithSampleCollection = async (orderId: string): Promise<void> => {
  try {
    // Get current order and sample collection info
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('id, status, sample_collected_at, sample_collected_by')
      .eq('id', orderId)
      .single();

    if (orderError) {
      console.error('Error fetching order:', orderError);
      return;
    }

    // Determine correct status based on sample collection
    let newStatus = order.status;
    
    if (order.sample_collected_at && order.sample_collected_by) {
      // Sample is collected, but order status shows "Pending Collection"
      if (order.status === 'Pending Collection') {
        newStatus = 'Sample Collected';
      }
    } else {
      // Sample is not collected, but order status might be wrong
      if (order.status === 'Sample Collected') {
        newStatus = 'Pending Collection';
      }
    }

    // Update order status if needed
    if (newStatus !== order.status) {
      const { error: updateError } = await supabase
        .from('orders')
        .update({
          status: newStatus,
          status_updated_at: new Date().toISOString()
        })
        .eq('id', orderId);

      if (updateError) {
        console.error('Error updating order status:', updateError);
      } else {
        console.log(`Order ${orderId} status updated from "${order.status}" to "${newStatus}"`);
      }
    }
  } catch (error) {
    console.error('Error in syncOrderStatusWithSampleCollection:', error);
  }
};

// Function to handle sample collection and update order status
export const markSampleAsCollected = async (orderId: string): Promise<boolean> => {
  try {
    const { error } = await supabase
      .from('orders')
      .update({
        sample_collected_at: new Date().toISOString(),
        sample_collected_by: 'current_user_email', // Replace with actual user
        status: 'Sample Collected',
        status_updated_at: new Date().toISOString()
      })
      .eq('id', orderId);

    if (error) {
      console.error('Error marking sample as collected:', error);
      return false;
    }

    return true;
  } catch (error) {
    console.error('Error in markSampleAsCollected:', error);
    return false;
  }
};

// Function to handle sample uncollection (if needed)
export const markSampleAsNotCollected = async (orderId: string): Promise<boolean> => {
  try {
    const { error } = await supabase
      .from('orders')
      .update({
        sample_collected_at: null,
        sample_collected_by: null,
        status: 'Pending Collection',
        status_updated_at: new Date().toISOString()
      })
      .eq('id', orderId);

    if (error) {
      console.error('Error marking sample as not collected:', error);
      return false;
    }

    return true;
  } catch (error) {
    console.error('Error in markSampleAsNotCollected:', error);
    return false;
  }
};

// Function to get synchronized order data with correct status
export const getOrderWithSyncedStatus = async (orderId: string) => {
  try {
    // First sync the status
    await syncOrderStatusWithSampleCollection(orderId);
    
    // Then fetch the updated order
    const { data: order, error } = await supabase
      .from('orders')
      .select('*')
      .eq('id', orderId)
      .single();

    if (error) {
      console.error('Error fetching synced order:', error);
      return null;
    }

    return order;
  } catch (error) {
    console.error('Error in getOrderWithSyncedStatus:', error);
    return null;
  }
};

export default {
  syncOrderStatusWithSampleCollection,
  markSampleAsCollected,
  markSampleAsNotCollected,
  getOrderWithSyncedStatus
};