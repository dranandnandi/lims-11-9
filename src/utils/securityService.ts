import { supabase } from './supabase';
import { 
  ResultWithSecurity, 
  ResultRestrictions, 
  AmendmentRequest, 
  SecurityIndicator, 
  SecurityStatus,
  AuditLogEntry 
} from '../types/security';

/**
 * Security Service for LIMS Workflow
 * Handles result locking, verification, and amendment processes
 */

// Check if a result can be edited
export const canEditResult = async (resultId: string): Promise<boolean> => {
  try {
    const { data, error } = await supabase
      .rpc('can_edit_result', { p_result_id: resultId });
    
    if (error) {
      console.error('Error checking edit permissions:', error);
      return false;
    }
    
    return data || false;
  } catch (error) {
    console.error('Error in canEditResult:', error);
    return false;
  }
};

// Get detailed restrictions for a result
export const getResultRestrictions = async (resultId: string): Promise<ResultRestrictions | null> => {
  try {
    const { data, error } = await supabase
      .rpc('get_result_restrictions', { p_result_id: resultId });
    
    if (error) {
      console.error('Error getting result restrictions:', error);
      return null;
    }
    
    return data?.[0] || null;
  } catch (error) {
    console.error('Error in getResultRestrictions:', error);
    return null;
  }
};

// Request an amendment for a locked/verified result
export const requestResultAmendment = async (amendment: AmendmentRequest): Promise<string | null> => {
  try {
    const { data, error } = await supabase
      .rpc('request_result_amendment', {
        p_result_id: amendment.result_id,
        p_reason: amendment.reason,
        p_proposed_changes: amendment.proposed_changes
      });
    
    if (error) {
      console.error('Error requesting amendment:', error);
      throw new Error(error.message);
    }
    
    return data; // Returns the note_id
  } catch (error) {
    console.error('Error in requestResultAmendment:', error);
    throw error;
  }
};

// Get security status indicator for UI
export const getSecurityIndicator = (result: ResultWithSecurity): SecurityIndicator => {
  if (result.verification_status === 'verified' && result.is_locked) {
    return {
      status: 'report_locked',
      icon: '🔒',
      color: 'text-red-600',
      message: 'Result locked after report generation',
      canEdit: false,
      canAmend: true
    };
  }
  
  if (result.verification_status === 'verified') {
    return {
      status: 'verified_locked',
      icon: '✅',
      color: 'text-green-600',
      message: 'Result verified and locked',
      canEdit: false,
      canAmend: true
    };
  }
  
  if (result.is_locked) {
    return {
      status: 'report_locked',
      icon: '🔒',
      color: 'text-amber-600',
      message: result.locked_reason || 'Result locked',
      canEdit: false,
      canAmend: true
    };
  }
  
  if (result.verification_status === 'needs_clarification') {
    return {
      status: 'needs_amendment',
      icon: '⚠️',
      color: 'text-orange-600',
      message: 'Needs clarification',
      canEdit: false,
      canAmend: true
    };
  }
  
  return {
    status: 'editable',
    icon: '✏️',
    color: 'text-gray-600',
    message: 'Editable',
    canEdit: true,
    canAmend: false
  };
};

// Get audit logs for a specific result
export const getResultAuditLogs = async (resultId: string): Promise<AuditLogEntry[]> => {
  try {
    const { data, error } = await supabase
      .from('audit_logs')
      .select('*')
      .or(`record_id.eq.${resultId},new_values->>result_id.eq.${resultId}`)
      .in('table_name', ['results', 'result_values'])
      .order('timestamp', { ascending: false });
    
    if (error) {
      console.error('Error fetching audit logs:', error);
      return [];
    }
    
    return data || [];
  } catch (error) {
    console.error('Error in getResultAuditLogs:', error);
    return [];
  }
};

// Get audit logs for multiple results in an order
export const getOrderAuditLogs = async (orderId: string): Promise<AuditLogEntry[]> => {
  try {
    // First get all result IDs for this order
    const { data: results, error: resultsError } = await supabase
      .from('results')
      .select('id')
      .eq('order_id', orderId);
    
    if (resultsError) {
      console.error('Error fetching results for order:', resultsError);
      return [];
    }
    
    if (!results || results.length === 0) {
      return [];
    }
    
    const resultIds = results.map(r => r.id);
    
    // Get audit logs for all results and the order itself
    const { data, error } = await supabase
      .from('audit_logs')
      .select('*')
      .or(`record_id.eq.${orderId},record_id.in.(${resultIds.join(',')})`)
      .in('table_name', ['orders', 'results', 'result_values', 'reports'])
      .order('timestamp', { ascending: false });
    
    if (error) {
      console.error('Error fetching order audit logs:', error);
      return [];
    }
    
    return data || [];
  } catch (error) {
    console.error('Error in getOrderAuditLogs:', error);
    return [];
  }
};

// Unlock a result (admin function)
export const unlockResult = async (resultId: string, reason: string): Promise<boolean> => {
  try {
    const { error } = await supabase
      .from('results')
      .update({ 
        is_locked: false, 
        locked_reason: null,
        locked_at: null,
        locked_by: null
      })
      .eq('id', resultId);
    
    if (error) {
      console.error('Error unlocking result:', error);
      return false;
    }
    
    // Log the unlock action
    await supabase
      .from('audit_logs')
      .insert({
        table_name: 'results',
        record_id: resultId,
        action: 'MANUAL_UNLOCK',
        new_values: { reason, unlocked_at: new Date().toISOString() }
      });
    
    return true;
  } catch (error) {
    console.error('Error in unlockResult:', error);
    return false;
  }
};

// Verify a result
export const verifyResult = async (resultId: string, comment?: string): Promise<boolean> => {
  try {
    const updateData: any = {
      verification_status: 'verified',
      verified_at: new Date().toISOString(),
      manually_verified: true
    };
    
    if (comment) {
      updateData.review_comment = comment;
    }
    
    const { error } = await supabase
      .from('results')
      .update(updateData)
      .eq('id', resultId);
    
    if (error) {
      console.error('Error verifying result:', error);
      return false;
    }
    
    return true;
  } catch (error) {
    console.error('Error in verifyResult:', error);
    return false;
  }
};

// Reject a result verification
export const rejectResult = async (resultId: string, reason: string): Promise<boolean> => {
  try {
    const { error } = await supabase
      .from('results')
      .update({
        verification_status: 'rejected',
        review_comment: reason
      })
      .eq('id', resultId);
    
    if (error) {
      console.error('Error rejecting result:', error);
      return false;
    }
    
    return true;
  } catch (error) {
    console.error('Error in rejectResult:', error);
    return false;
  }
};

// Get amendment notes for a result
export const getAmendmentNotes = async (resultId: string): Promise<any[]> => {
  try {
    const { data, error } = await supabase
      .from('result_verification_notes')
      .select(`
        *,
        author:users(name, email)
      `)
      .eq('result_id', resultId)
      .ilike('note', 'AMENDMENT REQUEST:%')
      .order('created_at', { ascending: false });
    
    if (error) {
      console.error('Error fetching amendment notes:', error);
      return [];
    }
    
    return data || [];
  } catch (error) {
    console.error('Error in getAmendmentNotes:', error);
    return [];
  }
};

export default {
  canEditResult,
  getResultRestrictions,
  requestResultAmendment,
  getSecurityIndicator,
  getResultAuditLogs,
  getOrderAuditLogs,
  unlockResult,
  verifyResult,
  rejectResult,
  getAmendmentNotes
};