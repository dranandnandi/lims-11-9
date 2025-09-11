// Types for the workflow security implementation
// These extend existing types with the new security features

// Base interfaces (adjust imports based on your existing type definitions)
interface BaseResult {
  id: string;
  order_id: string;
  patient_id: string;
  verification_status: 'pending_verification' | 'verified' | 'rejected' | 'needs_clarification';
  status: string;
  // Add other existing result properties as needed
}

interface BaseResultValue {
  id: string;
  result_id: string;
  parameter: string;
  value: string;
  flag?: string;
  // Add other existing result value properties as needed
}

export interface ResultWithSecurity extends BaseResult {
  is_locked?: boolean;
  locked_reason?: string;
  locked_at?: string;
  locked_by?: string;
  can_edit?: boolean;
  restriction_reason?: string;
}

export interface ResultValueWithSecurity extends BaseResultValue {
  can_edit?: boolean;
  result?: ResultWithSecurity;
}

export interface ResultRestrictions {
  can_edit: boolean;
  restriction_reason: string | null;
  verification_status: string;
  is_locked: boolean;
  locked_reason: string | null;
}

export interface AmendmentRequest {
  result_id: string;
  reason: string;
  proposed_changes: Record<string, any>;
  note_id?: string;
}

// Security status types
export type SecurityStatus = 
  | 'editable'
  | 'verified_locked'
  | 'report_locked'
  | 'needs_amendment';

export interface SecurityIndicator {
  status: SecurityStatus;
  icon: string;
  color: string;
  message: string;
  canEdit: boolean;
  canAmend: boolean;
}

// Audit log entry type for the frontend
export interface AuditLogEntry {
  id: string;
  table_name: string;
  record_id: string;
  action: string;
  old_values?: Record<string, any>;
  new_values?: Record<string, any>;
  user_id?: string;
  user_email?: string;
  timestamp: string;
}