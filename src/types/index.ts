// Main types file for LIMS v2
// Export all types from individual files and define new ones

export * from './dashboard';
export * from './workflow';
export * from './security';

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
  payment_terms: number;
  is_active: boolean;
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
  to_be_copied: boolean;
  description?: string;
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
  created_at: string;
  updated_at: string;
}

export interface ConsolidatedInvoice {
  id: string;
  account_id: string;
  account_name: string;
  billing_period: string; // Format: YYYY-MM
  subtotal: number;
  total_discount: number;
  tax: number;
  total: number;
  status: 'Draft' | 'Sent' | 'Paid' | 'Overdue';
  invoice_date: string;
  due_date: string;
  payment_date?: string;
  notes?: string;
  invoice_count: number; // Number of individual invoices consolidated
  patient_count: number; // Number of unique patients
  lab_id: string;
  created_at: string;
  updated_at: string;
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
  processing_status?: 'pending' | 'processed' | 'failed';
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