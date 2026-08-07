// Payment Gateway Types for B2B Credit System

export type PaymentProvider = 'ccavenue' | 'razorpay' | 'paytm' | 'phonepe' | 'stripe' | 'paypal';

export type PaymentEnvironment = 'test' | 'production';

export type PaymentStatus =
  | 'initiated'
  | 'pending'
  | 'processing'
  | 'success'
  | 'failed'
  | 'cancelled'
  | 'timeout'
  | 'refunded'
  | 'disputed';

export type PaymentPurpose =
  | 'credit_topup'
  | 'order_payment'
  | 'shortfall_payment'
  | 'advance_payment'
  | 'patient_invoice';

/** Who a payment attempt belongs to. Patient attempts settle against an invoice. */
export type PayerType = 'b2b_account' | 'patient';

export type PaymentLinkStatus = 'active' | 'paid' | 'failed' | 'expired' | 'cancelled';

export type CreditLedgerEntryType =
  | 'OPENING_BALANCE'
  | 'CREDIT_LIMIT_CHANGE'
  | 'ORDER_DEBIT'
  | 'ORDER_CANCEL_CREDIT'
  | 'PAYMENT_CREDIT'
  | 'MANUAL_CREDIT'
  | 'MANUAL_DEBIT'
  | 'REFUND_DEBIT'
  | 'EXPIRED_DEBIT'
  | 'TRANSFER_IN'
  | 'TRANSFER_OUT';

// Lab Payment Gateway Configuration
export interface LabPaymentGateway {
  id: string;
  lab_id: string;
  provider: PaymentProvider;
  display_name?: string;
  credentials_encrypted: PaymentGatewayCredentials;
  environment: PaymentEnvironment;
  redirect_url?: string;
  cancel_url?: string;
  webhook_url?: string;
  supported_methods: string[];
  default_currency: string;
  is_active: boolean;
  is_default: boolean;
  allow_patient_payments: boolean;
  payment_link_expiry_minutes: number;
  created_at: string;
  updated_at: string;
}

// Provider-specific credentials
export interface CCavenueCredentials {
  merchant_id: string;
  access_code: string;
  working_key: string;
  callback_access_code?: string;
  callback_working_key?: string;
  webhook_access_code?: string;
  webhook_working_key?: string;
}

export interface RazorpayCredentials {
  key_id: string;
  key_secret: string;
  webhook_secret?: string;
}

export type PaymentGatewayCredentials = CCavenueCredentials | RazorpayCredentials | Record<string, string>;

// B2B Payment Attempt
export interface B2BPaymentAttempt {
  id: string;
  lab_id: string;
  /** Null for patient payments — see payer_type. */
  account_id: string | null;
  payer_type: PayerType;
  invoice_id?: string | null;
  order_id?: string | null;
  patient_id?: string | null;
  payer_name?: string | null;
  payer_phone?: string | null;
  payer_email?: string | null;
  pending_order_id?: string;
  gateway_id: string;
  provider: PaymentProvider;
  gateway_order_id: string;
  gateway_tracking_id?: string;
  gateway_payment_id?: string;
  amount: number;
  currency: string;
  payment_purpose: PaymentPurpose;
  status: PaymentStatus;
  failure_reason?: string;
  bank_ref_number?: string;
  payment_method?: string;
  card_type?: string;
  card_last4?: string;
  credit_applied: boolean;
  credit_applied_at?: string;
  initiated_at: string;
  completed_at?: string;
  created_at: string;
  updated_at: string;
}

// B2B Credit Ledger Entry
export interface B2BCreditLedgerEntry {
  id: string;
  lab_id: string;
  account_id: string;
  entry_type: CreditLedgerEntryType;
  amount: number;
  balance_before: number;
  balance_after: number;
  reference_type?: 'order' | 'payment_attempt' | 'invoice' | 'refund' | 'manual' | 'system';
  reference_id?: string;
  remarks?: string;
  metadata?: Record<string, unknown>;
  created_at: string;
  created_by?: string;
  is_reversed: boolean;
}

// B2B Pending Order
export interface B2BPendingOrder {
  id: string;
  lab_id: string;
  account_id: string;
  order_data: Record<string, unknown>;
  order_amount: number;
  available_credit: number;
  shortfall_amount: number;
  payment_attempt_id?: string;
  status: 'pending_payment' | 'payment_received' | 'order_created' | 'expired' | 'cancelled';
  expires_at: string;
  created_at: string;
  updated_at: string;
  created_order_id?: string;
}

// Credit Check Response
export interface CreditCheckResponse {
  can_proceed: boolean;
  credit_limit: number;
  credit_used: number;
  outstanding_invoice_amount?: number;
  open_order_amount?: number;
  pending_booking_amount?: number;
  payment_credit_amount?: number;
  /** Cash/cheque/bank receipts recorded by the lab from Account Master */
  manual_credit_amount?: number;
  effective_credit_used?: number;
  available_credit: number;
  order_amount: number;
  shortfall: number;
  payment_required: boolean;
  payment_gateway_enabled: boolean;
  minimum_payment: number;
  suggested_payments: {
    label: string;
    amount: number;
    description: string;
  }[];
}

// Initiate Payment Request
export interface InitiatePaymentRequest {
  account_id: string;
  lab_id: string;
  amount: number;
  purpose: PaymentPurpose;
  pending_order_id?: string;
  order_data?: Record<string, unknown>;
  provider?: PaymentProvider;
  return_url?: string;
  cancel_url?: string;
}

// Initiate Payment Response
export interface InitiatePaymentResponse {
  success: boolean;
  payment_id: string;
  gateway_order_id: string;
  provider: PaymentProvider;
  // CCAvenue specific
  gateway_url?: string;
  form_method?: 'POST' | 'GET';
  form_data?: Record<string, string>;
  redirect_required?: boolean;
  // Razorpay specific
  razorpay_order_id?: string;
  razorpay_key_id?: string;
  amount?: number;
  currency?: string;
  name?: string;
  description?: string;
  prefill?: {
    name?: string;
    email?: string;
    contact?: string;
  };
  notes?: Record<string, string>;
}

// Account with credit fields
export interface AccountWithCredit {
  id: string;
  lab_id: string;
  name: string;
  code?: string;
  type: string;
  credit_limit: number;
  credit_used: number;
  credit_balance: number;
  payment_gateway_enabled: boolean;
  payment_terms: number;
  is_active: boolean;
}

// Payment History filters
export interface PaymentHistoryFilters {
  account_id?: string;
  status?: PaymentStatus;
  provider?: PaymentProvider;
  date_from?: string;
  date_to?: string;
}

// Tokenised patient payment link (/pay/:token)
export interface PaymentLink {
  id: string;
  lab_id: string;
  token: string;
  invoice_id?: string | null;
  order_id?: string | null;
  patient_id?: string | null;
  amount: number;
  currency: string;
  payer_name?: string | null;
  payer_phone?: string | null;
  payer_email?: string | null;
  payment_attempt_id?: string | null;
  status: PaymentLinkStatus;
  expires_at: string;
  opened_at?: string | null;
  open_count: number;
  whatsapp_sent_at?: string | null;
  whatsapp_sent_to?: string | null;
  created_at: string;
  updated_at: string;
  created_by?: string | null;
}

export interface CreatePaymentLinkRequest {
  lab_id: string;
  invoice_id?: string;
  order_id?: string;
  patient_id?: string;
  amount: number;
  payer_name?: string;
  payer_phone?: string;
  payer_email?: string;
  expires_in_minutes?: number;
}

export interface CreatePaymentLinkResponse {
  success: boolean;
  reused: boolean;
  token: string;
  /** Absolute URL — this is what the QR encodes and WhatsApp carries. */
  url: string;
  amount: number;
  currency: string;
  expires_at: string;
  invoice_id: string;
  invoice_number?: string | null;
  payer_name?: string | null;
  payer_phone?: string | null;
  error?: string;
}
