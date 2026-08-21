// Main types file for LIMS v2
// Export all types from individual files and define new ones

export * from './dashboard';
export * from './workflow';
export * from './security';
export * from './booking';
export * from './payment';

// Core entity interfaces

export interface Lab {
  id: string;
  name: string;
  code: string;
  address?: string;
  city?: string;
  state?: string;
  pincode?: string;
  phone?: string;
  email?: string;
  barcode_printer_name?: string | null;
  report_printer_name?: string | null;
  barcode_browser_print_enabled?: boolean;
  auto_print_barcode_on_order?: boolean;
  auto_print_report_on_approval?: boolean;
  license_number?: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface User {
  id: string;
  name: string;
  email: string;
  role: 'Admin' | 'Manager' | 'Technician' | 'Data Entry' | 'Viewer';
  department?: string;
  status: 'Active' | 'Inactive' | 'Suspended';
  phone?: string;
  join_date: string;
  last_login?: string;
  permissions?: string[];
  lab_id?: string;
  department_id?: string;
  created_at: string;
  updated_at: string;
}

export interface Patient {
  id: string;
  name: string;
  age: number;
  gender: 'Male' | 'Female' | 'Other';
  phone: string;
  email?: string;
  address: string;
  city: string;
  state: string;
  pincode: string;
  emergency_contact?: string;
  emergency_phone?: string;
  blood_group?: 'A+' | 'A-' | 'B+' | 'B-' | 'AB+' | 'AB-' | 'O+' | 'O-';
  allergies?: string;
  medical_history?: string;
  registration_date: string;
  last_visit: string;
  total_tests: number;
  is_active: boolean;
  external_patient_id?: string;
  display_id?: string;
  referring_doctor?: string;
  default_doctor_id?: string;
  default_location_id?: string;
  default_payment_type: 'self' | 'credit' | 'insurance' | 'corporate';
  lab_id: string;
  created_at: string;
  updated_at: string;
}

export interface Doctor {
  id: string;
  lab_id: string;
  name: string;
  specialization?: string;
  qualification?: string;
  registration_number?: string;
  phone?: string;
  hospital_phone?: string;
  email?: string;
  preferred_contact: 'email' | 'sms' | 'whatsapp' | 'none';
  report_delivery_method: 'email' | 'whatsapp' | 'both' | 'none';
  default_discount_percent?: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Location {
  id: string;
  lab_id: string;
  name: string;
  code?: string;
  type: 'hospital' | 'clinic' | 'diagnostic_center' | 'home_collection' | 'walk_in';
  contact_person?: string;
  phone?: string;
  email?: string;
  address?: string;
  city?: string;
  state?: string;
  pincode?: string;
  supports_cash_collection: boolean;
  default_discount_percent?: number;
  credit_limit: number;
  collection_percentage?: number;
  payment_terms: number;
  is_active: boolean;
  is_cash_collection_center?: boolean;
  is_collection_center?: boolean;
  is_processing_center?: boolean;
  can_receive_samples?: boolean;
  /** null/undefined = inherit lab default & auto-detect from uploaded artwork */
  pdf_letterhead_mode?: 'background' | 'header_footer' | null;
  is_main_lab?: boolean;
  notes?: string;
  upi_id?: string;
  bank_details?: {
    account_name?: string;
    account_number?: string;
    ifsc?: string;
    bank_name?: string;
    upi_id?: string;
  };
  barcode_printer_name?: string | null;
  report_printer_name?: string | null;
  barcode_browser_print_enabled?: boolean | null;
  auto_print_barcode_on_order?: boolean | null;
  auto_print_report_on_approval?: boolean | null;
  /** users.id whose WhatsApp session sends for this branch; null = inherit labs.whatsapp_user_id */
  whatsapp_user_id?: string | null;
  /** null = inherit labs.country_code */
  whatsapp_country_code?: string | null;
  created_at: string;
  updated_at: string;
}

export interface Order {
  id: string;
  patient_id: string;
  patient_name: string;
  priority: 'Normal' | 'Urgent' | 'STAT';
  order_date: string;
  expected_date: string;
  total_amount: number;
  doctor: string;
  notes?: string;
  parent_order_id?: string;
  order_type: string;
  visit_group_id?: string;
  addition_reason?: string;
  can_add_tests: boolean;
  locked_at?: string;
  created_by?: string;
  status_updated_at?: string;
  status_updated_by?: string;
  delivered_at?: string;
  delivered_by?: string;
  color_code?: string;
  color_name?: string;
  qr_code_data?: string;
  lab_id: string;
  status: 'Order Created' | 'Sample Collection' | 'In Progress' | 'Pending Approval' | 'Completed' | 'Delivered';
  sample_id?: string;
  sample_collected_at?: string;
  sample_collected_by?: string;
  tube_barcode?: string;
  workflow_status?: string;
  order_number?: number;
  order_display?: string;
  referring_doctor_id?: string;
  location_id?: string;
  payment_type: 'self' | 'credit' | 'insurance' | 'corporate';
  is_billed: boolean;
  billing_status: 'pending' | 'partial' | 'billed';
  created_at: string;
  updated_at: string;
}

export interface TestGroup {
  id: string;
  name: string;
  code: string;
  category: string;
  clinical_purpose: string;
  price: number;
  turnaround_time: string;
  sample_type: 'Blood' | 'Urine' | 'Stool' | 'Swab' | 'Other';
  requires_fasting: boolean;
  is_active: boolean;
  default_ai_processing_type?: string;
  group_level_prompt?: string;
  lab_id?: string;
  global_test_catalog_id?: string | null;
  to_be_copied: boolean;
  description?: string;
  // New test configuration fields
  test_type?: 'Default' | 'Special' | 'Urgent' | 'Routine';
  gender?: 'Male' | 'Female' | 'Both';
  sample_color?: 'Red' | 'Blue' | 'Green' | 'Yellow' | 'Purple' | 'Gray' | 'Pink' | 'Orange';
  barcode_suffix?: string;
  lmp_required?: boolean;
  id_required?: boolean;
  consent_form?: boolean;
  pre_collection_guidelines?: string;
  flabs_id?: string;
  only_female?: boolean;
  only_male?: boolean;
  only_billing?: boolean;
  start_from_next_page?: boolean;
  created_at: string;
  updated_at: string;
}

export interface Analyte {
  id: string;
  name: string;
  unit: string;
  reference_range: string;
  low_critical?: string;
  high_critical?: string;
  interpretation_low?: string;
  interpretation_normal?: string;
  interpretation_high?: string;
  category: string;
  is_active: boolean;
  ai_processing_type?: 'ocr_report' | 'vision_card' | 'vision_color' | 'none';
  ai_prompt_override?: string;
  group_ai_mode?: string;
  is_global: boolean;
  to_be_copied: boolean;
  created_at: string;
  updated_at: string;
}

export interface Result {
  id: string;
  order_id: string;
  patient_id: string;
  patient_name: string;
  test_name: string;
  status: 'Entered' | 'Reviewed' | 'Approved' | 'Rejected';
  entered_by: string;
  entered_date: string;
  reviewed_by?: string;
  reviewed_date?: string;
  notes?: string;
  extracted_by_ai: boolean;
  ai_confidence?: number;
  manually_verified: boolean;
  ai_extraction_metadata?: any;
  attachment_id?: string;
  verification_status: 'pending_verification' | 'needs_clarification' | 'verified' | 'rejected';
  verified_by?: string;
  verified_at?: string;
  review_comment?: string;
  technician_notes?: string;
  delta_check_flag: boolean;
  critical_flag: boolean;
  priority_level: number;
  is_locked: boolean;
  locked_reason?: string;
  locked_at?: string;
  locked_by?: string;
  workflow_instance_id?: string;
  technician_id?: string;
  result_date: string;
  order_test_group_id?: string;
  test_group_id?: string;
  lab_id: string;
  order_test_id?: string;
  sample_id?: string;
  created_at: string;
  updated_at: string;
}

export interface Invoice {
  id: string;
  patient_id: string;
  order_id?: string;
  patient_name: string;
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  status: 'Draft' | 'Sent' | 'Paid' | 'Overdue';
  invoice_date: string;
  due_date: string;
  payment_method?: string;
  payment_date?: string;
  notes?: string;
  total_before_discount?: number;
  total_discount: number;
  total_after_discount?: number;
  location_id?: string;
  referring_doctor_id?: string;
  payment_type: 'self' | 'credit' | 'insurance' | 'corporate';
  is_partial: boolean;
  parent_invoice_id?: string;
  
  // NEW: Dual invoice system fields
  invoice_type: 'patient' | 'account';
  account_id?: string;
  billing_period?: string; // Format: YYYY-MM for monthly billing
  consolidated_invoice_id?: string; // Links B2B credit invoices to monthly consolidated invoice
  
  lab_id: string;
  created_at: string;
  updated_at: string;
}

export interface Payment {
  id: string;
  lab_id?: string;
  invoice_id: string;
  amount: number;
  payment_method: 'cash' | 'card' | 'upi' | 'bank' | 'credit_adjustment';
  payment_reference?: string;
  payment_date: string;
  location_id?: string;
  collected_by?: string;
  notes?: string;
  created_at: string;
}

export interface PriceMaster {
  id: string;
  lab_id: string;
  name: string;
  description?: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface PriceMasterItem {
  id: string;
  price_master_id: string;
  test_group_id: string;
  price: number;
  created_at: string;
  updated_at: string;
  // joined
  test_group?: {
    name: string;
    code: string;
    price: number; // base price
  };
}

export interface Account {
  id: string;
  lab_id: string;
  name: string;
  type: 'hospital' | 'corporate' | 'insurer' | 'clinic' | 'doctor' | 'other';
  contact_person?: string;
  phone?: string;
  email?: string;
  address?: string;
  city?: string;
  state?: string;
  pincode?: string;
  default_discount_percent?: number;
  credit_limit: number;
  payment_terms: number; // days
  notes?: string;
  is_active: boolean;
  price_master_id?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConsolidatedInvoice {
  id: string;
  account_id: string;
  lab_id: string;
  invoice_number: string;
  billing_period_start: string; // date: YYYY-MM-DD (first day of billing period)
  billing_period_end: string;   // date: YYYY-MM-DD (last day of billing period)
  subtotal: number;
  tax_amount: number;
  discount_amount: number;
  total_amount: number;
  status: 'draft' | 'sent' | 'paid' | 'partial' | 'overdue' | 'cancelled';
  due_date?: string;
  pdf_url?: string;
  sent_at?: string;
  paid_at?: string;
  notes?: string;
  created_at: string;
  created_by?: string;
  // Joined field from accounts relation
  accounts?: { name: string };
}

export interface CashRegister {
  id: string;
  lab_id?: string;
  register_date: string;
  location_id?: string;
  shift: 'morning' | 'afternoon' | 'night' | 'full_day';
  opening_balance: number;
  system_amount: number;
  actual_amount?: number;
  closing_balance?: number;
  variance?: number;
  notes?: string;
  reconciled: boolean;
  reconciled_by?: string;
  reconciled_at?: string;
  created_by?: string;
  created_at: string;
}

export interface CreditTransaction {
  id: string;
  lab_id?: string;
  location_id?: string;
  patient_id?: string;
  invoice_id?: string;
  amount: number;
  transaction_type: 'credit' | 'payment' | 'adjustment';
  payment_method?: string;
  reference_number?: string;
  notes?: string;
  balance_after?: number;
  created_by?: string;
  created_at: string;
}

export interface Attachment {
  id: string;
  patient_id?: string;
  related_table: string;
  related_id: string;
  file_url: string;
  file_type?: string;
  description?: string;
  uploaded_by?: string;
  lab_id: string;
  file_path?: string;
  original_filename?: string;
  stored_filename?: string;
  file_size?: number;
  upload_timestamp: string;
  ai_processed: boolean;
  ai_confidence?: number;
  processing_status?: 'pending' | 'processing' | 'processed' | 'failed';
  imagekit_url?: string | null;
  imagekit_file_id?: string | null;
  processed_url?: string | null;
  variants?: Record<string, string> | null;
  image_processed_at?: string | null;
  image_processing_error?: string | null;
  resolved_file_url?: string | null;
  ai_processed_at?: string;
  ai_processing_type?: string;
  ai_metadata?: any;
  tag?: string;
  order_id?: string;
  order_test_id?: string;
  created_at: string;
}

// Form data types
export interface PatientFormData {
  name: string;
  age: number;
  gender: 'Male' | 'Female' | 'Other';
  phone: string;
  email?: string;
  address: string;
  city: string;
  state: string;
  pincode: string;
  emergency_contact?: string;
  emergency_phone?: string;
  blood_group?: string;
  allergies?: string;
  medical_history?: string;
  referring_doctor?: string;
  default_doctor_id?: string;
  default_location_id?: string;
  default_payment_type?: 'self' | 'credit' | 'insurance' | 'corporate';
  requestedTests?: string[];
}

export interface OrderFormData {
  patientId: string;
  selectedTests: string[];
  priority: 'Normal' | 'Urgent' | 'STAT';
  doctor: string;
  notes?: string;
  expectedDate: string;
  referring_doctor_id?: string;
  location_id?: string;
  payment_type?: 'self' | 'credit' | 'insurance' | 'corporate';
}

// API Response types
export interface ApiResponse<T> {
  data: T | null;
  error: Error | null;
}

export interface PaginatedResponse<T> {
  data: T[];
  count: number;
  page: number;
  limit: number;
  total_pages: number;
}

// Component prop types
export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export interface TableColumn<T> {
  key: keyof T;
  label: string;
  sortable?: boolean;
  render?: (value: any, item: T) => React.ReactNode;
}

// Search and filter types
export interface SearchFilters {
  query?: string;
  status?: string;
  dateFrom?: string;
  dateTo?: string;
  priority?: string;
  lab_id?: string;
}

// Billing types
export interface BillingStatistics {
  total_invoices: number;
  total_amount: number;
  paid_amount: number;
  pending_amount: number;
  overdue_amount: number;
  this_month_revenue: number;
  last_month_revenue: number;
  growth_percentage: number;
}

export interface PaymentSummary {
  date: string;
  cash_amount: number;
  card_amount: number;
  upi_amount: number;
  bank_amount: number;
  total_amount: number;
  transaction_count: number;
}

// Refund Management Types
export type RefundStatus = 'draft' | 'pending_approval' | 'approved' | 'rejected' | 'paid' | 'cancelled';
export type RefundMethod = 'cash' | 'card' | 'upi' | 'cheque' | 'net_banking' | 'wallet' | 'bank_transfer' | 'credit_adjustment';
export type RefundReasonCategory = 'test_cancelled' | 'duplicate_billing' | 'patient_request' | 'price_correction' | 'insurance_adjustment' | 'error_correction' | 'other';

export interface RefundedItem {
  item_id?: string;
  test_name: string;
  amount: number;
  reason?: string;
}

export interface RefundRequest {
  id: string;
  lab_id: string;
  location_id?: string;
  invoice_id: string;
  order_id?: string;
  patient_id: string;
  refund_amount: number;
  refunded_items: RefundedItem[];
  refund_method: RefundMethod;
  status: RefundStatus;
  reason_category?: RefundReasonCategory;
  reason_details?: string;
  admin_notes?: string;
  rejection_reason?: string;
  
  // Audit trail
  requested_by: string;
  approved_by?: string;
  rejected_by?: string;
  paid_by?: string;
  cancelled_by?: string;
  
  // Timestamps
  created_at: string;
  submitted_at?: string;
  approved_at?: string;
  rejected_at?: string;
  paid_at?: string;
  cancelled_at?: string;
  updated_at?: string;
  
  // Joined fields (from views/queries)
  invoice_total?: number;
  amount_paid?: number;
  already_refunded?: number;
  max_refundable?: number;
  patient_name?: string;
  patient_phone?: string;
  requested_by_name?: string;
  location_name?: string;
  hours_pending?: number;
}

export interface RefundRequestCreateData {
  invoice_id: string;
  refund_amount: number;
  refund_method: RefundMethod;
  reason_category?: RefundReasonCategory;
  reason_details?: string;
  refunded_items?: RefundedItem[];
}

export interface DailyCashSummary {
  lab_id: string;
  location_id?: string;
  location_name?: string;
  summary_date: string;
  cash_collections: number;
  non_cash_collections: number;
  total_collections: number;
  cash_refunds: number;
  net_cash: number;
  payment_count: number;
  invoice_count: number;
}

// =============================================
// AI-Enhanced Result Values
// =============================================
export interface ResultValue {
  id: string;
  result_id: string;
  order_id: string;
  analyte_id: string;
  analyte_name: string;
  value: string;
  unit?: string;
  reference_range?: string;
  flag?: string; // Final flag (L/H/C/N)
  interpretation?: string; // Final interpretation
  
  // AI-suggested fields (populated by AI, reviewed by verifier)
  ai_suggested_flag?: string;
  ai_suggested_interpretation?: string;
  verifier_notes?: string;
  
  // Override tracking
  flag_override_by?: string;
  flag_override_at?: string;
  interpretation_override_by?: string;
  interpretation_override_at?: string;
  
  created_at: string;
  updated_at: string;
}

// =============================================
// Report with AI Summary & Trend Graphs
// =============================================
export interface Report {
  id: string;
  order_id: string;
  patient_id: string;
  report_type: 'standard' | 'consolidated' | 'interim';
  status: 'draft' | 'final' | 'amended';
  generated_date: string;
  pdf_url?: string;
  pdf_generated_at?: string;
  print_pdf_url?: string;
  print_pdf_generated_at?: string;
  
  // AI Doctor Summary
  ai_doctor_summary?: string;
  ai_summary_generated_at?: string;
  ai_summary_reviewed_by?: string;
  ai_summary_reviewed_at?: string;
  
  // Trend Graphs
  include_trend_graphs: boolean;
  trend_graphs_config?: TrendGraphConfig;
  
  lab_id: string;
  created_at: string;
  updated_at: string;
}

export interface TrendGraphConfig {
  analytes: string[]; // Array of analyte IDs to show trends for
  date_range_days?: number; // How many days of history
  show_reference_range?: boolean;
  show_flags?: boolean;
}

// =============================================
// Order with Trend Data
// =============================================
export interface TrendGraphData {
  analytes: TrendAnalyteData[];
  patient_id: string;
  generated_at: string;
}

export interface TrendAnalyteData {
  analyte_id: string;
  analyte_name: string;
  unit: string;
  reference_range: string;
  data_points: TrendDataPoint[];
}

export interface TrendDataPoint {
  date: string;
  value: number;
  flag?: string;
  order_id: string;
  sample_id?: string;
}

// =============================================
// Outsourced Reports System
// =============================================
export interface OutsourcedReport {
  id: string;
  lab_id: string;
  source: 'email_forward' | 'direct_connect' | 'manual_upload';
  sender_email?: string;
  recipient_email?: string;
  subject?: string;
  received_at: string;
  file_url: string;
  file_name?: string;
  status: 'pending_processing' | 'processing' | 'processed' | 'failed' | 'verified';
  ai_extracted_data?: OutsourcedReportAIData;
  ai_confidence?: number;
  patient_id?: string;
  order_id?: string;
  processing_error?: string;
  matched_user_id?: string;
  match_confidence?: number;
  match_suggestions?: OrderMatchSuggestion[];
  matched_at?: string;
  matched_by?: string;
  merge_status: 'pending' | 'in_progress' | 'completed' | 'failed';
  created_at: string;
  updated_at: string;
}

export interface OutsourcedReportAIData {
  patient_name?: string;
  test_name?: string;
  collection_date?: string;
  lab_name?: string;
  results?: Array<{
    analyte_name: string;
    value: string;
    unit: string;
    reference_range: string;
    flag?: string;
  }>;
}

export interface OrderMatchSuggestion {
  order_id: string;
  patient_id: string;
  patient_name: string;
  order_number?: number;
  order_date: string;
  confidence: number;
  match_reasons: string[];
  test_names?: string[];
}

export interface LabOutsourcingSettings {
  id: string;
  lab_id: string;
  auto_match: boolean;
  match_confidence_threshold: number;
  match_date_range_days: number;
  logistics_providers: LogisticsProvider[];
  default_tat_days: number;
  enable_logistics_tracking: boolean;
  merge_mode: 'print_only' | 'ecopy_only' | 'both';
  auto_merge_on_match: boolean;
  preserve_outsourced_branding: boolean;
  created_at: string;
  updated_at: string;
}

export interface LogisticsProvider {
  id: string;
  name: string;
  contact?: string;
  tracking_url_template?: string;
}

export interface OutsourcedTestQueueItem {
  result_id: string;
  order_id: string;
  order_number?: number;
  patient_id: string;
  patient_name: string;
  test_name: string;
  outsourced_to_lab_id: string;
  outsourced_lab_name?: string;
  outsourced_status: 'not_outsourced' | 'pending_send' | 'sent' | 'awaiting_report' | 'received' | 'merged';
  outsourced_logistics_status?: 'pending_dispatch' | 'awaiting_pickup' | 'in_transit' | 'delivered_to_lab' | 'report_awaited';
  tracking_barcode?: string;
  dispatched_at?: string;
  dispatched_by?: string;
  outsourced_tat_estimate?: string;
  logistics_notes?: string;
  created_at: string;
}

export interface MergedPDFResult {
  printPdfUrl?: string;
  ecopyPdfUrl?: string;
  mergedAt: string;
  success: boolean;
  error?: string;
}
