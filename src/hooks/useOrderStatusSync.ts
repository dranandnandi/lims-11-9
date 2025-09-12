import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../utils/supabase'

export const useOrderStatusSync = (orderId: string, onStatusUpdate: (newStatus: string) => void) => {
  const handleOrderUpdate = useCallback((payload: any) => {
    if (payload.new.id === orderId && payload.new.status !== payload.old?.status) {
      onStatusUpdate(payload.new.status)
    }
  }, [orderId, onStatusUpdate])

  const handleSampleUpdate = useCallback(async (payload: any) => {
    // When sample collection status changes, refetch order status
    if (payload.new.collection_status !== payload.old?.collection_status) {
      const { data: order } = await supabase
        .from('orders')
        .select('status')
        .eq('id', orderId)
        .single()
      
      if (order) {
        onStatusUpdate(order.status)
      }
    }
  }, [orderId, onStatusUpdate])

  useEffect(() => {
    // Subscribe to order status changes
    const orderSubscription = supabase
      .channel(`order-status-${orderId}`)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'orders',
        filter: `id=eq.${orderId}`
      }, handleOrderUpdate)
      .subscribe()

    // Subscribe to sample status changes for this order
    const sampleSubscription = supabase
      .channel(`sample-status-${orderId}`)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'samples',
        filter: `order_id=eq.${orderId}`
      }, handleSampleUpdate)
      .subscribe()

    return () => {
      orderSubscription.unsubscribe()
      sampleSubscription.unsubscribe()
    }
  }, [orderId, handleOrderUpdate, handleSampleUpdate])
}