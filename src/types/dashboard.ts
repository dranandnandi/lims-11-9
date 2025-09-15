export type DashboardState =
  | "pending"        // no values entered
  | "for_approval"   // entered>0 but not all verified
  | "approved"       // all verified
  | "report_ready"   // approved + pdf ready
  | "delivered";     // report delivered

export interface DashboardOrderRow {
  order_id: string;
  order_date: string;        // ISO date
  expected_date: string;     // ISO date
  order_number?: number | null;

  patient_id: string;
  patient_name: string;
  age?: number | null;
  gender?: string | null;
  doctor?: string | null;

  priority: "Normal" | "Urgent" | "STAT";
  total_amount: number;

  sample_collected_at?: string | null;
  sample_status?: string | null;

  expected_total: number;    // analytes
  entered_total: number;
  verified_total: number;
  percent_complete: number;  // 0..100
  any_partial: boolean;
  all_verified: boolean;

  report_status?: string | null;
  report_pdf_ready: boolean;
  report_pdf_url?: string | null;
  delivered_at?: string | null;

  invoice_total?: number | null;
  paid_total?: number | null;
  balance_due?: number | null;

  attachments_count: number;
  ai_used: boolean;
  is_overdue: boolean;
  dashboard_state: DashboardState;

  tests: { name: string; status: string; entered: number; expected: number; verified: boolean }[];
}

export interface KpiCounters {
  pending: number;
  for_approval: number;
  approved: number;
  report_ready: number;
  delivered: number;
  overdue: number;
  balance_due: number;
}
