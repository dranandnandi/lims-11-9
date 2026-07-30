import React, { useEffect, useMemo, useState } from "react";
import ReactDOM from "react-dom";
import { useLocation, useNavigate } from "react-router-dom";
import { endOfDay, format, isValid, parseISO, startOfDay, subDays } from "date-fns";
import {
  Plus,
  Search,
  Filter,
  Clock as ClockIcon,
  CheckCircle,
  AlertTriangle,
  Eye,
  User,
  Calendar,
  TestTube,
  ChevronDown,
  ChevronUp,
  TrendingUp,
  UserPlus,
  DollarSign,
  FileText,
  CreditCard,
  LayoutDashboard,
  Users,
  MessageCircle,
  Mail,
  Send,
  Receipt,
  Briefcase,
  Trash2,
  X,
  Download,
  Printer,
} from "lucide-react";
import { useAuth } from "../contexts/AuthContext";
import { supabase, database, formatAge } from "../utils/supabase";
import { useMobileOptimizations } from "../utils/platformHelper";
import { MobileFAB } from "../components/ui/MobileFAB";
import OrderForm from "../components/Orders/OrderForm";
import DashboardOrderModal from "../components/Dashboard/DashboardOrderModal";
import CreateInvoiceModal from "../components/Billing/CreateInvoiceModal";
import PaymentCapture from "../components/Billing/PaymentCapture";
import { OrderStatusDisplay } from "../components/Orders/OrderStatusDisplay";
import { WhatsAppAPI } from "../utils/whatsappAPI";
import { openWhatsAppManually } from "../utils/whatsappUtils";

import { usePDFGeneration } from "../hooks/usePDFGeneration";
import SampleTransitWidget from "../components/Dashboard/SampleTransitWidget";
import { generateInvoicePDF } from "../utils/invoicePdfService";
import PhlebotomistSelector from "../components/Users/PhlebotomistSelector";
import { SampleTypeIndicator } from "../components/Common/SampleTypeIndicator";
import { SampleCollectionTracker } from "../components/Samples/SampleCollectionTracker";
import BookingQueue from "../components/Dashboard/BookingQueue";
import { useQZTray } from "../contexts/QZTrayContext";
import * as qzTrayService from "../utils/qzTrayService";

/* ===========================
   Types
=========================== */

type OrderStatus =
  | "Order Created"
  | "Sample Collection"
  | "In Progress"
  | "Pending Approval"
  | "Completed"
  | "Delivered";

type Priority = "Normal" | "Urgent" | "STAT";

type ProgressRow = {
  order_id: string;
  test_group_id: string | null;
  test_group_name: string | null;
  expected_analytes: number;
  entered_analytes: number;
  total_values: number;
  has_results: boolean;
  is_verified: boolean;
  panel_status: "Not started" | "In progress" | "Partial" | "Complete" | "Verified" | "not_started" | "in_progress" | "completed" | "pending_approval" | "verified";
  sample_type?: string;
  sample_color?: string;
  color_code?: string;
  color_name?: string;
  tat_hours?: number | null;
  tat_start_time?: string | null;
  // Section-only fields
  is_section_only?: boolean;
  has_section_content?: boolean;
  section_verification_status?: string | null;
  section_verified_at?: string | null;
};

type OrderRow = {
  id: string;
  patient_id: string;
  patient_name: string;
  patient_phone?: string | null;
  status: OrderStatus;
  priority: Priority;
  order_date: string;
  expected_date: string;
  total_amount: number;
  final_amount?: number;
  doctor: string | null;

  // sample/meta needed by modal
  sample_id: string | null;
  color_code: string | null;
  color_name: string | null;
  sample_collected_at: string | null;
  sample_collected_by: string | null;
  samples?: { id: string; barcode: string | null; sample_type?: string | null; created_at?: string | null }[] | null;

  // Billing fields
  billing_status?: "pending" | "partial" | "billed" | null;
  is_billed?: boolean | null;

  // relations
  patients: { name?: string | null; age?: string | null; gender?: string | null } | null;
  order_tests:
  | {
    id: string;
    test_group_id: string | null;
    test_name: string;
    outsourced_lab_id?: string | null;
    package_id?: string | null;
    outsourced_labs?: { name?: string | null } | null;
  }[]
  | null;

  // daily sequence for sorting
  order_number?: number | null;
};

type Panel = {
  name: string;
  expected: number;
  entered: number; // from view (clamped later)
  verified: boolean;
  status: ProgressRow["panel_status"];
  sample_type?: string;
  sample_color?: string;
  order_color?: string;
  // Section-only fields
  is_section_only?: boolean;
  has_section_content?: boolean;
  section_verification_status?: string | null;
};

// Update CardOrder type
type CardOrder = {
  // ... existing fields ...
  id: string;
  patient_name: string;
  patient_id: string;
  patient_phone?: string | null;
  status: OrderStatus;
  priority: Priority;
  order_date: string;
  expected_date: string;
  total_amount: number;
  final_amount?: number;
  doctor: string | null;
  doctor_phone?: string | null;
  doctor_email?: string | null;

  order_number?: number | null;

  sample_id: string | null;
  sample_barcode?: string | null;
  samples?: { id: string; barcode: string | null; sample_type?: string | null; created_at?: string | null }[];
  color_code: string | null;
  color_name: string | null;
  sample_collected_at: string | null;
  sample_collected_by: string | null;

  // Billing fields
  billing_status?: "pending" | "partial" | "billed" | null;
  is_billed?: boolean | null;
  invoice_id?: string | null;
  paid_amount?: number;
  due_amount?: number;
  payment_status?: "unpaid" | "partial" | "paid" | null;

  patient?:
  | {
    name?: string | null;
    age?: string | null;
    gender?: string | null;
    mobile?: string | null;
    email?: string | null;
  }
  | null;
  tests: {
    id: string;
    test_name: string;
    outsourced_lab_id?: string | null;
    outsourced_labs?: { name?: string | null } | null;
    sample_type?: string | null;
    sample_color?: string | null;
  }[];

  // B2B Account (ADDITION)
  account_name?: string | null;
  account_billing_mode?: "standard" | "monthly" | null;

  // derived
  panels: Panel[];
  expectedTotal: number;
  enteredTotal: number;

  // 3-bucket model
  pendingAnalytes: number; // not started OR partial/in-progress
  forApprovalAnalytes: number; // complete but not verified
  approvedAnalytes: number; // verified

  // Report info
  report_url?: string | null;
  report_print_url?: string | null;
  report_status?: string | null;

  // Delivery tracking (Reports)
  whatsapp_sent_at?: string | null;
  whatsapp_sent_via?: string | null;
  email_sent_at?: string | null;
  email_sent_via?: string | null;
  doctor_informed_at?: string | null;
  doctor_sent_via?: string | null;

  // Delivery tracking (Invoices)
  invoice_whatsapp_sent_at?: string | null;
  invoice_whatsapp_sent_via?: string | null;
  invoice_email_sent_at?: string | null;
  invoice_email_sent_via?: string | null;
  invoice_payment_reminder_count?: number;
  invoice_last_reminder_at?: string | null;

  // Location and transit fields
  location_id?: string | null;
  location?: string | null;
  transit_status?: string | null;
  collected_at_location_id?: string | null;
  collected_by?: string | null;
  tatStarted?: boolean;
};

const formatOrderCreationError = (error: any) => {
  const message = String(error?.message || error || "Failed to create order");
  if (message.includes("unique_sample_id_per_lab")) {
    return "Sample ID conflict while creating the order. The system will try the next available ID; please submit again if this still appears.";
  }
  return message;
};



/* ===========================
   Component
=========================== */

const Dashboard: React.FC = () => {
  const { user, blockSendOnDue } = useAuth();
  const { settings: qzSettings, connect: qzConnect } = useQZTray();

  const [orders, setOrders] = useState<CardOrder[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [isCollapsedView, setIsCollapsedView] = useState(false);
  const [isHeaderCollapsed, setIsHeaderCollapsed] = useState(true);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"All" | OrderStatus>("All");
  const [doctorFilter, setDoctorFilter] = useState<string>("All");
  const [dashboardTab, setDashboardTab] = useState<"standard" | "patient-visits">("standard");
  const [bookingQueueOpen, setBookingQueueOpen] = useState(false);
  const [pendingBookingsCount, setPendingBookingsCount] = useState(0);

  useEffect(() => {
    database.bookings
      .list({ status: "pending" })
      .then(({ data }) => {
        if (data) {
          setPendingBookingsCount(
            (data as any[]).filter((b) => !["converted", "cancelled"].includes(b.status)).length
          );
        }
      })
      .catch(() => {});
  }, []);

  // Date range state - default to last 5 calendar days
  const [dateFrom, setDateFrom] = useState<string>(() => {
    return format(subDays(new Date(), 4), "yyyy-MM-dd");
  });
  const [dateTo, setDateTo] = useState<string>(() => format(new Date(), "yyyy-MM-dd"));
  const [allDates, setAllDates] = useState(false); // ✅ FIX: “All Dates” without breaking query

  const [showOrderForm, setShowOrderForm] = useState(false);
  const [processingBooking, setProcessingBooking] = useState<any>(null); // State for booking being processed
  const [selectedOrder, setSelectedOrder] = useState<CardOrder | null>(null);

  // Booking routed in from another page (e.g. Phlebo Collections "Process Order")
  const routerLocation = useLocation();
  const routerNavigate = useNavigate();
  useEffect(() => {
    const routedBooking = (routerLocation.state as any)?.processBooking;
    if (routedBooking) {
      setProcessingBooking(routedBooking);
      setShowOrderForm(true);
      // Clear the state so refresh/back doesn't reopen the form
      routerNavigate(routerLocation.pathname, { replace: true, state: null });
    }
  }, [routerLocation.state]);

  // Auto-open collection modal after order creation
  const [pendingAutoCollectOrderId, setPendingAutoCollectOrderId] = useState<string | null>(null);
  const [autoOpenCollectModal, setAutoOpenCollectModal] = useState(false);

  // State for invoice modal
  const [showInvoiceModal, setShowInvoiceModal] = useState(false);
  const [invoiceOrderId, setInvoiceOrderId] = useState<string | null>(null);

  // State for payment modal
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [paymentOrderId, setPaymentOrderId] = useState<string | null>(null);

  // PDF Generation
  // const { generatePDF } = usePDFGeneration(); // Currently unused
  const [isSendingReport, setIsSendingReport] = useState<string | null>(null);
  const [isSendingInvoice, setIsSendingInvoice] = useState<string | null>(null);
  const [printingReportId, setPrintingReportId] = useState<string | null>(null);
  const [printingLabelId, setPrintingLabelId] = useState<string | null>(null);

  // dashboard counters
  const [summary, setSummary] = useState({
    allDone: 0,
    mostlyDone: 0,
    pending: 0,
    awaitingApproval: 0,
  });

  // Sample Collection Modal State
  const [labId, setLabId] = useState<string | null>(null);
  const [showCollectionModal, setShowCollectionModal] = useState(false);
  const [collectionOrder, setCollectionOrder] = useState<CardOrder | null>(null);
  const [selectedPhlebotomistId, setSelectedPhlebotomistId] = useState<string>("");
  const [selectedPhlebotomistName, setSelectedPhlebotomistName] = useState<string>("");

  useEffect(() => {
    fetchOrders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateFrom, dateTo, allDates]);

  // Load auto_open_collection_modal setting once
  // eslint-disable-next-line no-console
  useEffect(() => {
    database.getCurrentUserLabId().then(async (labId) => {
      if (!labId) { console.debug('[AutoCollect] No labId found'); return; }
      const { data, error } = await supabase
        .from('labs')
        .select('auto_open_collection_modal')
        .eq('id', labId)
        .single();
      console.debug('[AutoCollect] DB row:', data, 'error:', error);
      const enabled = !!data?.auto_open_collection_modal;
      console.debug('[AutoCollect] Setting autoOpenCollectModal =', enabled);
      if (enabled) setAutoOpenCollectModal(true);
    });
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.altKey && e.key === 'n') {
        e.preventDefault();
        setShowOrderForm(true);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Read daily sequence (prefer order_number; fallback to tail of sample_id)
  const getDailySeq = (o: CardOrder) => {
    if (typeof o.order_number === "number" && !Number.isNaN(o.order_number)) return o.order_number;
    const tail = String(o.sample_id || "").split("-").pop() || "";
    const n = parseInt(tail, 10);
    return Number.isFinite(n) ? n : 0;
  };

  const fetchOrders = async () => {
    const lab_id = await database.getCurrentUserLabId();
    setLabId(lab_id);

    if (!lab_id) {
      console.error("No lab_id found for current user");
      return;
    }

    // 1) base orders with optional date filter
    let q = supabase
      .from("orders")
      .select(
        `
id, patient_id, patient_name, status, priority, order_date, expected_date, total_amount, final_amount, doctor,
  order_number, sample_id, color_code, color_name, sample_collected_at, sample_collected_by,
  billing_status, is_billed, referring_doctor_id,
  location_id, transit_status, collected_at_location_id,
  patients(name, age, age_unit, gender, phone, email),
  samples(id, barcode, sample_type, created_at),
  order_tests(id, test_group_id, test_name, outsourced_lab_id, package_id, is_billed, invoice_id, is_canceled, outsourced_labs(name), test_groups(sample_type, sample_color)),
  doctors(phone, email),
  locations!orders_location_id_fkey(id, name, type),
  accounts(name, billing_mode)
      `
      )
      .eq("lab_id", lab_id)
      .order("order_date", { ascending: false })
      .order("id", { ascending: false });

    // Apply location filtering if required
    const { shouldFilter, locationIds } = await database.shouldFilterByLocation();
    if (shouldFilter && locationIds.length > 0) {
      q = q.in("location_id", locationIds);
    }

    if (!allDates) {
      const parsedFrom = parseISO(dateFrom);
      const parsedTo = parseISO(dateTo);
      const queryStart = isValid(parsedFrom) ? startOfDay(parsedFrom).toISOString() : dateFrom;
      const queryEnd = isValid(parsedTo) ? endOfDay(parsedTo).toISOString() : `${dateTo}T23:59:59.999Z`;

      q = q.gte("order_date", queryStart).lte("order_date", queryEnd);
    }

    // PostgREST caps every response at 1000 rows, so page through with
    // range() until a short page signals the end.
    const PAGE_SIZE = 1000;
    const orderRows: OrderRow[] = [];
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data: page, error } = await q.range(from, from + PAGE_SIZE - 1);
      if (error) {
        console.error("orders load error", error);
        return;
      }
      orderRows.push(...((page || []) as OrderRow[]));
      if (!page || page.length < PAGE_SIZE) break;
    }

    const orderIds = orderRows.map((o) => o.id);
    if (orderIds.length === 0) {
      setOrders([]);
      return;
    }

    // Run .in() lookups in id chunks so large order sets neither exceed URL
    // limits nor get truncated by the 1000-row response cap, paging each
    // chunk in case its result set alone exceeds the cap.
    const fetchAllChunked = async (
      ids: string[],
      buildQuery: (chunkIds: string[]) => any,
      label: string,
    ): Promise<any[]> => {
      const CHUNK = 100;
      const chunks: string[][] = [];
      for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK));
      const results = await Promise.all(chunks.map(async (chunkIds) => {
        const rows: any[] = [];
        const query = buildQuery(chunkIds);
        for (let from = 0; ; from += PAGE_SIZE) {
          const { data, error } = await query.range(from, from + PAGE_SIZE - 1);
          if (error) {
            console.error(`${label} load error`, error);
            break;
          }
          rows.push(...(data || []));
          if (!data || data.length < PAGE_SIZE) break;
        }
        return rows;
      }));
      return results.flat();
    };

    // 2) view-based progress
    const prog = await fetchAllChunked(
      orderIds,
      (ids) =>
        supabase
          .from("v_order_test_progress_enhanced")
          .select("*")
          .in("order_id", ids),
      "progress view",
    );

    const byOrder = new Map<string, ProgressRow[]>();
    (prog || []).forEach((r) => {
      const arr = byOrder.get((r as any).order_id) || [];
      arr.push(r as ProgressRow);
      byOrder.set((r as any).order_id, arr);
    });

    // 3) Fetch billing data in two batched requests. The previous per-order,
    // per-invoice fan-out produced dozens of duplicate requests on every refresh.
    const allInvoices = await fetchAllChunked(
      orderIds,
      (ids) =>
        supabase
          .from("invoices")
          .select(`
            id, order_id, invoice_date, subtotal, total, total_after_discount,
            total_refunded_amount, whatsapp_sent_at, whatsapp_sent_via,
            email_sent_at, email_sent_via, payment_reminder_count, last_reminder_at
          `)
          .in("order_id", ids)
          .order("invoice_date", { ascending: false }),
      "invoice batch",
    );

    const invoiceIds = (allInvoices || []).map((invoice: any) => invoice.id);
    const allPayments = await fetchAllChunked(
      invoiceIds,
      (ids) =>
        supabase
          .from("payments")
          .select("invoice_id, amount")
          .in("invoice_id", ids),
      "payment batch",
    );

    const paidByInvoice = new Map<string, number>();
    (allPayments || []).forEach((payment: any) => {
      paidByInvoice.set(
        payment.invoice_id,
        (paidByInvoice.get(payment.invoice_id) || 0) + Number(payment.amount || 0),
      );
    });

    const invoicesByOrder = new Map<string, any[]>();
    (allInvoices || []).forEach((invoice: any) => {
      const orderInvoices = invoicesByOrder.get(invoice.order_id) || [];
      orderInvoices.push(invoice);
      invoicesByOrder.set(invoice.order_id, orderInvoices);
    });

    const invoiceMap = new Map(orderIds.map((orderId) => {
      const invoices = invoicesByOrder.get(orderId) || [];
      const primaryInvoice = invoices[0] || null;
      return [orderId, {
        orderId,
        invoices,
        primaryInvoice,
        totalInvoiced: invoices.reduce(
          (sum, invoice) => sum + Number(invoice.total_after_discount || invoice.total || invoice.subtotal || 0),
          0,
        ),
        totalSubtotal: invoices.reduce(
          (sum, invoice) => sum + Number(invoice.subtotal || invoice.total || 0),
          0,
        ),
        totalRefunded: invoices.reduce(
          (sum, invoice) => sum + Number(invoice.total_refunded_amount || 0),
          0,
        ),
        paidAmount: invoices.reduce(
          (sum, invoice) => sum + (paidByInvoice.get(invoice.id) || 0),
          0,
        ),
        deliveryStatus: primaryInvoice ? {
          whatsapp_sent_at: primaryInvoice.whatsapp_sent_at,
          whatsapp_sent_via: primaryInvoice.whatsapp_sent_via,
          email_sent_at: primaryInvoice.email_sent_at,
          email_sent_via: primaryInvoice.email_sent_via,
          payment_reminder_count: primaryInvoice.payment_reminder_count,
          last_reminder_at: primaryInvoice.last_reminder_at,
        } : {},
      }];
    }));

    // 3.6) Fetch uninvoiced extra charges (order_billing_items) per order
    // These are charges added via the order modal but not yet on any invoice.
    // They must be added to orderAmount so due_amount is correct.
    const uninvoicedChargesMap = new Map<string, number>();
    const billingItemsRows = await fetchAllChunked(
      orderIds,
      (ids) =>
        supabase
          .from('order_billing_items')
          .select('order_id, amount')
          .in('order_id', ids)
          .eq('is_invoiced', false),
      'billing items',
    );
    (billingItemsRows || []).forEach((row: any) => {
      uninvoicedChargesMap.set(row.order_id, (uninvoicedChargesMap.get(row.order_id) || 0) + (row.amount || 0));
    });

    // 3.5) Fetch reports with delivery status for these orders
    const reportMap = new Map<
      string,
      {
        pdf_url: string | null;
        print_pdf_url: string | null;
        status: string | null;
        whatsapp_sent_at: string | null;
        whatsapp_sent_via: string | null;
        email_sent_at: string | null;
        email_sent_via: string | null;
        doctor_informed_at: string | null;
        doctor_sent_via: string | null;
      }
    >();

    const reportsData = await fetchAllChunked(
      orderIds,
      (ids) =>
        supabase
          .from("reports")
          .select("order_id, pdf_url, print_pdf_url, status, report_type, whatsapp_sent_at, whatsapp_sent_via, email_sent_at, email_sent_via, doctor_informed_at, doctor_sent_via")
          .in("order_id", ids)
          .eq("report_type", "final"),
      "reports",
    );

    (reportsData || []).forEach((r: any) => {
      reportMap.set(r.order_id, {
        pdf_url: r.pdf_url,
        print_pdf_url: r.print_pdf_url ?? null,
        status: r.status,
        whatsapp_sent_at: r.whatsapp_sent_at,
        whatsapp_sent_via: r.whatsapp_sent_via,
        email_sent_at: r.email_sent_at,
        email_sent_via: r.email_sent_via,
        doctor_informed_at: r.doctor_informed_at,
        doctor_sent_via: r.doctor_sent_via,
      });
    });

    // 4) shape cards
    const cards: CardOrder[] = orderRows.map((o: any) => {
      const rows = byOrder.get(o.id) || [];
      const invoiceInfo = invoiceMap.get(o.id);
      const reportInfo = reportMap.get(o.id);

      // Calculate dynamic expected date based on TAT (only when sample has been received)
      let calculatedExpectedDateMs = 0;
      let hasTatStartTime = false;
      rows.forEach((r) => {
        if (r.tat_hours && r.tat_start_time) {
          hasTatStartTime = true;
          const start = new Date(r.tat_start_time).getTime();
          const duration = Number(r.tat_hours) * 3600 * 1000;
          const end = start + duration;
          if (end > calculatedExpectedDateMs) calculatedExpectedDateMs = end;
        }
      });

      // TAT only starts after sample receipt — no fallback calculation before that
      const dynamicExpectedDate = calculatedExpectedDateMs > 0 ? new Date(calculatedExpectedDateMs).toISOString() : o.expected_date;
      // TAT is considered started if view has tat_start_time (tat_hours configured) OR sample was collected
      const tatStarted = hasTatStartTime || !!o.sample_collected_at;

      const panels: Panel[] = rows.map((r) => ({
        name: r.test_group_name || "Test",
        expected: r.expected_analytes || 0,
        entered: r.entered_analytes || 0,
        verified: !!r.is_verified,
        status: r.panel_status,
        sample_type: r.sample_type,
        sample_color: r.sample_color,
        order_color: r.color_code,
        // Section-only fields
        is_section_only: r.is_section_only,
        has_section_content: r.has_section_content,
        section_verification_status: r.section_verification_status,
      }));

      const expectedTotal = panels.reduce((sum, p) => sum + p.expected, 0);
      const enteredTotal = panels.reduce((sum, p) => sum + Math.min(p.entered, p.expected), 0);

      const approvedAnalytes = panels.reduce((sum, p) => {
        if (p.verified || p.status === "Verified") return sum + Math.min(p.entered, p.expected);
        return sum;
      }, 0);

      const pendingAnalytes = Math.max(expectedTotal - enteredTotal, 0);
      const forApprovalAnalytes = Math.max(enteredTotal - approvedAnalytes, 0);

      const doctorData = (o as any).doctors;
      const doctor_phone = doctorData?.phone || null;
      const doctor_email = doctorData?.email || null;
      const orderSamples = Array.isArray((o as any).samples)
        ? [...((o as any).samples || [])].sort((a: any, b: any) =>
            new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime()
          )
        : [];
      const primarySample = orderSamples[0] || null;

      // Extra uninvoiced charges for this order (not yet on any invoice)
      const uninvoicedCharges = uninvoicedChargesMap.get(o.id) || 0;

      return {
        id: o.id,
        patient_name: o.patient_name,
        patient_id: o.patient_id,
        patient_phone: o.patients?.phone,
        status: o.status,
        priority: o.priority,
        order_date: o.order_date,
        expected_date: dynamicExpectedDate,
        tatStarted,
        // Include uninvoiced charges in displayed total
        total_amount: (o.final_amount || o.total_amount || 0) + uninvoicedCharges,
        // Use totalInvoiced from aggregated invoices, fallback to order amount + uninvoiced charges
        final_amount: invoiceInfo?.totalInvoiced
          ? Math.max(invoiceInfo.totalInvoiced, (o.final_amount || o.total_amount || 0) + uninvoicedCharges)
          : ((o.final_amount || o.total_amount || 0) + uninvoicedCharges),
        doctor: o.doctor,
        doctor_phone,
        doctor_email,

        order_number: o.order_number ?? null,
        sample_id: o.sample_id,
        sample_barcode: primarySample?.barcode || null,
        samples: orderSamples,
        color_code: o.color_code,
        color_name: o.color_name,
        sample_collected_at: o.sample_collected_at,
        sample_collected_by: o.sample_collected_by,

        // Billing status: "partial" if pre-discount subtotal < order amount+charges, else use DB status
        // Use totalSubtotal (pre-discount) so a discount doesn't falsely mark the order as partially billed
        billing_status: (() => {
          if (!invoiceInfo?.invoices?.length) return o.billing_status;
          const orderAmount = (o.final_amount || o.total_amount || 0) + uninvoicedCharges;
          const invoicedSubtotal = invoiceInfo.totalSubtotal || 0;
          return (orderAmount - invoicedSubtotal) > 1 ? 'partial' : o.billing_status;
        })(),
        is_billed: o.is_billed,
        // Use primary invoice ID for actions (most recent)
        invoice_id: invoiceInfo?.primaryInvoice?.id || null,
        // Aggregated paid amount across all invoices
        paid_amount: invoiceInfo?.paidAmount || 0,
        // Due amount = effective total (order + uninvoiced charges) - paid - refunded
        due_amount: (() => {
          const baseOrderAmount = o.final_amount || o.total_amount || 0;
          // Add uninvoiced charges on top of order amount
          const orderAmount = baseOrderAmount + uninvoicedCharges;
          const invoicedAmount = invoiceInfo?.totalInvoiced || 0;
          const paidAmount = invoiceInfo?.paidAmount || 0;
          const refundedAmount = invoiceInfo?.totalRefunded || 0;

          // When invoice exists, use invoiced total (already reflects discounts) + any uninvoiced extras.
          // Do NOT take max with orderAmount — that would ignore discounts applied on the invoice.
          const effectiveTotal = invoicedAmount > 0
            ? invoicedAmount + uninvoicedCharges
            : orderAmount;
          return Math.max(0, effectiveTotal - paidAmount - refundedAmount);
        })(),
        // Payment status based on aggregated amounts
        payment_status: (() => {
          const baseOrderAmount = o.final_amount || o.total_amount || 0;
          const orderAmount = baseOrderAmount + uninvoicedCharges;
          const invoicedAmount = invoiceInfo?.totalInvoiced || 0;
          const paidAmount = invoiceInfo?.paidAmount || 0;
          const refundedAmount = invoiceInfo?.totalRefunded || 0;

          const effectiveTotal = invoicedAmount > 0
            ? invoicedAmount + uninvoicedCharges
            : orderAmount;
          const netOwed = Math.max(0, effectiveTotal - refundedAmount);

          if (!netOwed) return "unpaid";
          // Allow small float diff (1.0)
          if (paidAmount > 0 && paidAmount >= (netOwed - 1)) return "paid";
          if (paidAmount > 0) return "partial";
          return "unpaid";
        })() as "unpaid" | "partial" | "paid",

        patient: {
          name: o.patients?.name,
          age: o.patients?.age,
          gender: o.patients?.gender,
          mobile: o.patients?.phone,
          email: o.patients?.email,
        },

        tests: (o.order_tests || []).map((t: any) => ({
          id: t.id,
          test_name: t.test_name,
          outsourced_lab_id: t.outsourced_lab_id,
          outsourced_labs: t.outsourced_labs,
          sample_type: t.test_groups?.sample_type,
          sample_color: t.test_groups?.sample_color,
          is_billed: t.is_billed,
          invoice_id: t.invoice_id,
          is_canceled: t.is_canceled,
        })),

        // B2B account (ADDITION)
        account_name: o.accounts?.name || null,
        account_billing_mode: o.accounts?.billing_mode || null,

        panels,
        expectedTotal,
        enteredTotal,
        pendingAnalytes,
        forApprovalAnalytes,
        approvedAnalytes,

        report_url: reportInfo?.pdf_url,
        report_print_url: reportInfo?.print_pdf_url ?? null,
        report_status: reportInfo?.status,
        whatsapp_sent_at: reportInfo?.whatsapp_sent_at,
        whatsapp_sent_via: reportInfo?.whatsapp_sent_via,
        email_sent_at: reportInfo?.email_sent_at,
        email_sent_via: reportInfo?.email_sent_via,
        doctor_informed_at: reportInfo?.doctor_informed_at,
        doctor_sent_via: reportInfo?.doctor_sent_via,

        // Invoice delivery tracking
        invoice_whatsapp_sent_at: (invoiceInfo as any)?.deliveryStatus?.whatsapp_sent_at,
        invoice_whatsapp_sent_via: (invoiceInfo as any)?.deliveryStatus?.whatsapp_sent_via,
        invoice_email_sent_at: (invoiceInfo as any)?.deliveryStatus?.email_sent_at,
        invoice_email_sent_via: (invoiceInfo as any)?.deliveryStatus?.email_sent_via,
        invoice_payment_reminder_count: (invoiceInfo as any)?.deliveryStatus?.payment_reminder_count,
        invoice_last_reminder_at: (invoiceInfo as any)?.deliveryStatus?.last_reminder_at,

        // Location and transit fields
        location_id: o.location_id || null,
        location: o.locations?.name || null,
        transit_status: o.transit_status || null,
        collected_at_location_id: o.collected_at_location_id || null,
        collected_by: o.sample_collected_by || null,
      };
    });

    // sort: date DESC, then daily seq DESC
    const sorted = cards.sort((a, b) => {
      const dA = new Date(a.order_date).setHours(0, 0, 0, 0);
      const dB = new Date(b.order_date).setHours(0, 0, 0, 0);
      if (dA !== dB) return dB - dA;
      const nA = getDailySeq(a);
      const nB = getDailySeq(b);
      return nB - nA;
    });

    const s = sorted.reduce(
      (acc, o) => {
        // All Done: explicit Completed/Delivered status OR all expected analytes are approved/verified
        if (o.status === "Completed" || o.status === "Delivered" ||
            (o.expectedTotal > 0 && o.approvedAnalytes >= o.expectedTotal)) acc.allDone++;
        else if (o.status === "Pending Approval") acc.awaitingApproval++;
        else if (o.enteredTotal > 0 && o.enteredTotal >= o.expectedTotal * 0.75) acc.mostlyDone++;
        else acc.pending++;
        return acc;
      },
      { allDone: 0, mostlyDone: 0, pending: 0, awaitingApproval: 0 }
    );

    setOrders(sorted);
    setSummary(s);
  };

  /* ===========================
     Handlers
  =========================== */

  const handleAddOrder = async (orderData: any) => {
    try {
      if (!orderData.patient_id) {
        alert("❌ Error: Patient is required");
        throw new Error("Patient is required");
      }

      if (!orderData.referring_doctor_id && !orderData.doctor) {
        alert("❌ Error: Referring doctor is required");
        throw new Error("Referring doctor is required");
      }

      const labId = await database.getCurrentUserLabId();
      const orderDataWithLab = { ...orderData, lab_id: labId };

      const { data: order, error: orderError } = await database.orders.create(orderDataWithLab);
      if (orderError) {
        const errorMessage = formatOrderCreationError(orderError);
        alert(`❌ Order Creation Failed: ${errorMessage} `);
        throw orderError;
      }

      // Update pending TRF attachments - ONLY for current user + lab + recent uploads
      const PENDING_ORDER_UUID = "00000000-0000-0000-0000-000000000000";
      const { data: currentUser } = await supabase.auth.getUser();
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      
      const { error: updateError } = await supabase
        .from("attachments")
        .update({ related_id: order.id, order_id: order.id })
        .eq("related_table", "orders")
        .eq("related_id", PENDING_ORDER_UUID)
        .eq("description", "Test Request Form for order creation")
        .eq("uploaded_by", currentUser?.user?.id) // Only current user's uploads
        .eq("lab_id", labId) // Only current lab
        .gte("upload_timestamp", oneHourAgo); // Only recent uploads (within 1 hour)

      if (updateError) console.warn("Failed to update TRF attachment:", updateError);

      // ✅ AUTO-CREATE SAMPLES
      try {
        const { createSamplesForOrder } = await import("../services/sampleService");

        let orderTests = order.order_tests;
        let otError: any = null;
        if (!orderTests?.length) {
          const orderTestsResult = await supabase
            .from("order_tests")
            .select(
              `
id,
  order_id,
  test_group_id,
  test_name,
  test_groups: test_group_id(sample_type, sample_color)
    `
            )
            .eq("order_id", order.id);
          orderTests = orderTestsResult.data;
          otError = orderTestsResult.error;
        }

        if (otError) {
          console.error("Error fetching order tests for sample creation:", otError);
        } else if (!orderTests || orderTests.length === 0) {
          console.warn("⚠️ No order tests found for sample creation via Dashboard. Order:", order.id);
        } else {
          const testGroupsWithInfo = orderTests.map((ot: any) => {
            const groupData = Array.isArray(ot.test_groups) ? ot.test_groups[0] : ot.test_groups;
            return {
              id: ot.id,
              order_id: ot.order_id,
              test_group_id: ot.test_group_id,
              test_name: ot.test_name,
              test_group: {
                sample_type: groupData?.sample_type || "Blood",
                sample_color: groupData?.sample_color,
              },
            };
          });

          await createSamplesForOrder(order.id, testGroupsWithInfo, labId || order.lab_id, orderData.patient_id, {
            preBarcodedBarcode: orderData.__preBarcoded ? orderData.__preBarcodedBarcode : null,
            collectedAt: order.sample_collected_at || orderData.sample_collected_at || null,
            collectedBy: order.sample_collector_id || orderData.sample_collector_id || null,
          });
        }
      } catch (sampleCheckErr) {
        console.error("Error auto-creating samples from Dashboard:", sampleCheckErr);
      }

      // 5. Update Booking Status (if converted)
      if (processingBooking) {
        try {
          await database.bookings.update(processingBooking.id, {
            status: 'converted',
            converted_order_id: order.id,
            updated_at: new Date().toISOString()
          });
          console.log('✅ Booking status updated to converted:', processingBooking.id);
        } catch (bookingErr) {
          console.error('Failed to update booking status:', bookingErr);
          // Non-blocking error
        }
      }

      // OrderForm may still be creating invoice and payment rows. Its final
      // onClose callback performs the single dashboard refresh.
      console.log("✅ Order created successfully!");

      // Return order for invoice/payment creation in OrderForm
      return order;
    } catch (error: any) {
      console.error("Dashboard: Error creating order:", error);
      throw error; // Re-throw so OrderForm knows creation failed
    }
  };

  const handleDeleteOrder = async (orderId: string) => {
    if (!window.confirm("Are you sure you want to delete this order? This action cannot be undone and will delete all associated tests and results.")) return;

    try {
      const { error } = await database.orders.delete(orderId);
      if (error) {
        throw error;
      }
      fetchOrders();
    } catch (error: any) {
      console.error("Error deleting order:", error);
      // 23503 = FK violation. The only constraint that still blocks deletion is
      // consolidated_invoice_items, which is intentional: the order is already
      // on an issued consolidated invoice.
      if (error?.code === "23503") {
        alert(
          "This order cannot be deleted because it is already billed on a consolidated invoice.\n\nRemove it from the invoice first, or cancel the order instead of deleting it.",
        );
        return;
      }
      alert("Failed to delete order. Please try again.");
    }
  };

  const handleCreateInvoice = (orderId: string) => {
    setInvoiceOrderId(orderId);
    setShowInvoiceModal(true);
  };

  const handleRecordPayment = async (orderId: string) => {
    try {
      // Check if invoice exists for this order
      const { data: invoices, error } = await database.invoices.getAllByOrderId(orderId);
      if (error || !invoices || invoices.length === 0) {
        // No invoice exists - ask user if they want to create one first
        const createFirst = window.confirm(
          "No invoice found for this order.\n\nWould you like to create an invoice first?\n\nClick OK to create invoice, Cancel to go back."
        );
        if (createFirst) {
          handleCreateInvoice(orderId);
        }
        return;
      }
      // Pass orderId to PaymentCapture - it will fetch all invoices
      setPaymentOrderId(orderId);
      setShowPaymentModal(true);
    } catch (error) {
      console.error("Error fetching invoice for order:", error);
      alert("Failed to fetch invoice details. Please try again.");
    }
  };

  const handleOpenCollectionModal = async (order: CardOrder) => {
    try {
      const { getSamplesForOrder, createSamplesForOrder } = await import("../services/sampleService");
      const existingSamples = await getSamplesForOrder(order.id);

      if (existingSamples.length === 0) {
        const { data: orderTests } = await supabase
          .from("order_tests")
          .select(
            `
id,
  order_id,
  test_group_id,
  test_name,
  test_groups: test_group_id(sample_type, sample_color)
          `
          )
          .eq("order_id", order.id);

        if (orderTests && orderTests.length > 0) {
          const labId = await database.getCurrentUserLabId();
          const testGroupsWithInfo = orderTests.map((ot: any) => {
            const groupData = Array.isArray(ot.test_groups) ? ot.test_groups[0] : ot.test_groups;
            return {
              id: ot.id,
              order_id: ot.order_id,
              test_group_id: ot.test_group_id,
              test_name: ot.test_name,
              test_group: {
                sample_type: groupData?.sample_type || "Blood",
                sample_color: groupData?.sample_color,
              },
            };
          });

          await createSamplesForOrder(order.id, testGroupsWithInfo, labId, order.patient_id);
        }
      }
    } catch (err) {
      console.error("Error auto-creating samples during collection:", err);
    }

    setCollectionOrder(order);
    setSelectedPhlebotomistId("");
    setSelectedPhlebotomistName("");
    setShowCollectionModal(true);
  };

  useEffect(() => {
    if (!pendingAutoCollectOrderId) return;

    const order = orders.find((o) => o.id === pendingAutoCollectOrderId);
    if (!order) return;

    setPendingAutoCollectOrderId(null);
    handleOpenCollectionModal(order);
  }, [pendingAutoCollectOrderId, orders]);

  const handleSaveCollection = async () => {
    if (!collectionOrder) return;

    try {
      await database.orders.markSampleCollected(
        collectionOrder.id,
        selectedPhlebotomistName || undefined,
        selectedPhlebotomistId || undefined,
      );
      await database.orders.checkAndUpdateStatus(collectionOrder.id);
      setShowCollectionModal(false);
      fetchOrders();
    } catch (err) {
      console.error("Error saving collection info:", err);
      setShowCollectionModal(false);
      fetchOrders();
    }
  };

  const handleInformDoctor = async (order: CardOrder) => {
    if (!order.doctor_phone) {
      alert("Doctor's phone number not found. Please ensure the doctor profile has a valid phone number.");
      return;
    }

    try {
      const { data: report } = await database.reports.getByOrderId(order.id);

      if (report && report.doctor_informed_at) {
        const informedDate = new Date(report.doctor_informed_at).toLocaleString();
        const confirmResend = window.confirm(
          `Doctor was already informed on ${informedDate} via ${report.doctor_informed_via || "WhatsApp"}.\n\nSend again ? `
        );
        if (!confirmResend) return;
      }

      // If final report exists, send with PDF and clinical summary
      if (report && report.report_type === "final" && report.pdf_url) {
        const { data: orderData, error: orderFetchError } = await supabase
          .from("orders")
          .select("ai_clinical_summary, send_clinical_summary_to_doctor")
          .eq("id", order.id)
          .single();

        // Debug: Log clinical summary data
        console.log('[Dashboard InformDoctor] Order data fetch:', {
          orderId: order.id,
          orderFetchError,
          send_clinical_summary_to_doctor: orderData?.send_clinical_summary_to_doctor,
          ai_clinical_summary_exists: !!orderData?.ai_clinical_summary,
          ai_clinical_summary_length: orderData?.ai_clinical_summary?.length || 0
        });

        // Use send_clinical_summary_to_doctor flag for WhatsApp messages
        const includeClinicalSummary = orderData?.send_clinical_summary_to_doctor || false;
        const clinicalSummary = orderData?.ai_clinical_summary || "";

        console.log('[Dashboard InformDoctor] Clinical summary decision:', {
          includeClinicalSummary,
          hasClinicalSummary: !!clinicalSummary,
          willIncludeInMessage: includeClinicalSummary && !!clinicalSummary
        });

        let message = `Hello ${order.doctor || "Doctor"}, \n\nThe final report for patient ${order.patient_name}(Order #${order.id.slice(
          -6
        )
          }) is ready.`;

        if (includeClinicalSummary && clinicalSummary) {
          message += `\n\n📋 Clinical Summary: \n${clinicalSummary} `;
          console.log('[Dashboard InformDoctor] ✅ Clinical summary ADDED to message');
        } else {
          console.log('[Dashboard InformDoctor] ⚠️ Clinical summary NOT added - flag:', includeClinicalSummary, 'summary exists:', !!clinicalSummary);
        }

        message += `\n\nPlease find the attached report.\n\nThank you.`;

        const connection = await WhatsAppAPI.getConnectionStatus();
        if (!connection?.success || !connection.isConnected) {
          const { success, method } = await openWhatsAppManually(order.doctor_phone, message, report.pdf_url, "doctor");
          if (success && method === "manual_link") {
            const { data: auth } = await supabase.auth.getUser();
            await database.reports.recordDoctorNotification(report.id, {
              via: "whatsapp",
              sentBy: auth?.user?.id || "",
              sentVia: "manual_link",
            });
            alert("WhatsApp opened. Please send the message manually.");
            fetchOrders();
          }
          return;
        }

        const formattedPhone = WhatsAppAPI.formatPhoneNumber(order.doctor_phone);
        if (!WhatsAppAPI.validatePhoneNumber(order.doctor_phone)) {
          alert("Invalid phone number format. Please update the doctor phone.");
          return;
        }

        const confirmMsg = window.confirm(`Send final report to ${order.doctor} (${order.doctor_phone})?\n\nMessage: \n${message} `);
        if (!confirmMsg) return;

        const result = await WhatsAppAPI.sendReportFromUrl(formattedPhone, report.pdf_url, message, order.patient_name);

        if (result.success) {
          const { data: auth } = await supabase.auth.getUser();
          await database.reports.recordDoctorNotification(report.id, { via: "whatsapp", sentBy: auth?.user?.id || "" });
          alert("Report sent to doctor successfully!");
          fetchOrders();
        } else {
          alert("Failed to send report: " + result.message);
        }

        return;
      }

      // No final report - text-only
      let message = "";
      try {
        const labId = await database.getCurrentUserLabId();
        const { data: template } = await database.whatsappTemplates.getDefault("doctor_notification", labId);

        if (template) {
          const { data: labData } = await supabase.from("labs").select("name, address, phone, email").eq("id", labId!).single();
          const testNames = order.tests?.map((t) => t.test_name).join(", ") || "Tests";

          const { replacePlaceholders } = await import("../utils/whatsappTemplates");
          message = replacePlaceholders(template.message_content, {
            DoctorName: order.doctor || "Doctor",
            PatientName: order.patient_name,
            OrderId: order.id.slice(-6),
            OrderStatus: order.status,
            TestName: testNames,
            LabName: labData?.name || "",
            LabAddress: labData?.address || "",
            LabContact: labData?.phone || "",
            LabEmail: labData?.email || "",
          });
        }
      } catch (err) {
        console.error("Error fetching template:", err);
      }

      if (!message) {
        message = `Hello ${order.doctor || "Doctor"}, \n\nOrder #${order.id.slice(-6)} for patient ${order.patient_name} is currently ${order.status}.`;
      }

      if (!message.includes("Thank you")) message += `\n\nThank you.`;

      const connection = await WhatsAppAPI.getConnectionStatus();
      if (!connection?.success || !connection.isConnected) {
        const { success, method } = await openWhatsAppManually(order.doctor_phone, message, undefined, "doctor");
        if (success && method === "manual_link") {
          if (report) {
            const { data: auth } = await supabase.auth.getUser();
            await database.reports.recordDoctorNotification(report.id, {
              via: "whatsapp",
              sentBy: auth?.user?.id || "",
              sentVia: "manual_link",
            });
          }
          alert("WhatsApp opened. Please send the message manually.");
          fetchOrders();
        }
        return;
      }

      const formattedPhone = WhatsAppAPI.formatPhoneNumber(order.doctor_phone);
      if (!WhatsAppAPI.validatePhoneNumber(order.doctor_phone)) {
        alert("Invalid phone number format. Please update the doctor phone.");
        return;
      }

      const confirmMsg = window.confirm(`Send WhatsApp to ${order.doctor} (${order.doctor_phone})?\n\nMessage: \n${message} `);
      if (!confirmMsg) return;

      const result = await WhatsAppAPI.sendTextMessage(formattedPhone, message);
      if (result.success) {
        if (report) {
          const { data: auth } = await supabase.auth.getUser();
          await database.reports.recordDoctorNotification(report.id, { via: "whatsapp", sentBy: auth?.user?.id || "" });
        }
        alert("Message sent successfully!");
        fetchOrders();
      } else {
        alert("Failed to send message: " + result.message);
      }
    } catch (error) {
      console.error("Error sending message:", error);
      alert("Error sending message.");
    }
  };

  const handleSendReport = async (order: CardOrder, type: "whatsapp" | "email") => {
    if (isSendingReport) return;

    try {
      const { data: report, error: reportError } = await database.reports.getByOrderId(order.id);
      if (reportError || !report) {
        alert("Report not found. Please generate it from the Reports page first.");
        return;
      }
      if (report.report_type !== "final") {
        alert("Cannot send draft report. Please ensure all results are verified and final report is generated.");
        return;
      }
      if (!report.pdf_url) {
        alert("Report PDF not generated yet. Please generate it from the Reports page first.");
        return;
      }

      const alreadySent = await database.reports.wasAlreadySent(report.id, type);
      if (alreadySent) {
        const sentField = type === "whatsapp" ? "whatsapp_sent_at" : "email_sent_at";
        const { data: deliveryData } = await database.reports.getDeliveryStatus(report.id);
        const sentDate = deliveryData ? new Date((deliveryData as any)[sentField]).toLocaleString() : "unknown date";
        const sentTo = type === "whatsapp" ? (deliveryData as any)?.whatsapp_sent_to : (deliveryData as any)?.email_sent_to;

        const confirmResend = window.confirm(`Report already sent via ${type} on ${sentDate}${sentTo ? ` to ${sentTo}` : ""}.\n\nSend again ? `);
        if (!confirmResend) return;
      }

      setIsSendingReport(order.id);

      if (type === "whatsapp") {
        // Block send if lab policy is active, order has a balance, and user is not Admin
        const isAdmin = String(user?.user_metadata?.role || '').toLowerCase() === 'admin';
        if (blockSendOnDue && (order.due_amount ?? 0) > 0 && !isAdmin) {
          alert('Report cannot be sent\u2014this order has an outstanding balance. Please collect payment first or contact the Admin.');
          setIsSendingReport(null);
          return;
        }

        let phone = order.patient_phone || "";
        if (!phone && order.patient_id) {
          const { data: patientData } = await supabase.from("patients").select("phone").eq("id", order.patient_id).single();
          phone = patientData?.phone || "";
        }

        const normalizePhone = (p: string): string => {
          const digitsOnly = p.replace(/\D/g, "");
          if (digitsOnly.length <= 10) return digitsOnly;
          return digitsOnly.slice(-10);
        };

        phone = normalizePhone(phone);

        if (!phone || phone.length < 10) {
          const input = window.prompt("Patient phone not found. Enter phone number to send report:", phone);
          if (!input) {
            setIsSendingReport(null);
            return;
          }
          phone = normalizePhone(input);
        }

        if (phone.length !== 10) {
          alert("Invalid phone number. Please enter a valid 10-digit number.");
          setIsSendingReport(null);
          return;
        }

        let caption = `Lab Report for ${order.patient_name}(Order #${order.id.slice(-6)})`;

        try {
          const labId = await database.getCurrentUserLabId();
          const { data: template } = await database.whatsappTemplates.getDefault("report_ready", labId);

          if (template) {
            const { data: labData } = await supabase.from("labs").select("name, address, phone, email").eq("id", labId!).single();
            const testNames = order.tests?.map((t) => t.test_name).join(", ") || "Tests";

            const { replacePlaceholders } = await import("../utils/whatsappTemplates");
            caption = replacePlaceholders(template.message_content, {
              PatientName: order.patient_name,
              OrderId: order.id.slice(-6),
              TestName: testNames,
              ReportUrl: report.pdf_url,
              LabName: labData?.name || "",
              LabAddress: labData?.address || "",
              LabContact: labData?.phone || "",
              LabEmail: labData?.email || "",
            });
          }
        } catch (err) {
          console.error("Error fetching template:", err);
        }

        caption += `\n\nThank you.`;

        const connection = await WhatsAppAPI.getConnectionStatus();
        if (!connection?.success || !connection.isConnected) {
          const { success, method } = await openWhatsAppManually(phone, caption, report.pdf_url, "patient");
          if (success && method === "manual_link") {
            const { data: auth } = await supabase.auth.getUser();
            await database.reports.recordWhatsAppSend(report.id, {
              to: phone,
              caption,
              sentBy: auth?.user?.id || "",
              includedClinicalSummary: false,
              sentVia: "manual_link",
            });
            alert("WhatsApp opened. Please send the message manually.");
            fetchOrders();
          }
          setIsSendingReport(null);
          return;
        }

        const result = await WhatsAppAPI.sendReportFromUrl(phone, report.pdf_url, caption, order.patient_name);

        if (result.success) {
          const { data: auth } = await supabase.auth.getUser();
          await database.reports.recordWhatsAppSend(report.id, {
            to: phone,
            caption,
            sentBy: auth?.user?.id || "",
            includedClinicalSummary: false,
          });
          alert("Report sent via WhatsApp!");
          fetchOrders();
        } else {
          alert("Failed to send report: " + result.message);
        }
      } else {
        let email = (order as any).patient?.email || "";
        const input = window.prompt("Enter email address to send report:", email);
        if (!input) {
          setIsSendingReport(null);
          return;
        }
        email = input;

        let emailBody = `Please find the lab report for ${order.patient_name}(Order #${order.id.slice(-6)}) below: \n\n`;
        emailBody += `Report Link: ${report.pdf_url} \n\nThank you.`;

        const subject = encodeURIComponent(`Lab Report: ${order.patient_name} `);
        const body = encodeURIComponent(emailBody);
        window.open(`mailto:${email}?subject = ${subject}& body=${body} `, "_blank");

        const { data: auth } = await supabase.auth.getUser();
        await database.reports.recordEmailSend(report.id, {
          to: email,
          sentBy: auth?.user?.id || "",
          includedClinicalSummary: false,
        });

        alert("Email client opened. Please send the email.");
        fetchOrders();
      }
    } catch (error) {
      console.error("Error sending report:", error);
      alert("Failed to send report. Please try again.");
    } finally {
      setIsSendingReport(null);
    }
  };

  const handleSendInvoice = async (order: CardOrder) => {
    if (isSendingInvoice) return;

    try {
      setIsSendingInvoice(order.id);

      // Fetch ALL invoices for this order (supports multiple invoices when tests added after billing)
      const { data: invoices, error: invoiceError } = await database.invoices.getAllByOrderId(order.id);
      if (invoiceError || !invoices || invoices.length === 0) {
        alert("Invoice not found. Please create an invoice first.");
        setIsSendingInvoice(null);
        return;
      }

      const sentInvoices = invoices.filter((invoice: any) => invoice.whatsapp_sent_at);
      if (sentInvoices.length > 0) {
        const latestSentAt = sentInvoices
          .map((invoice: any) => invoice.whatsapp_sent_at)
          .filter(Boolean)
          .sort()
          .pop();
        const sentDate = latestSentAt ? new Date(latestSentAt).toLocaleString() : "an earlier time";
        const confirmResend = window.confirm(
          `Invoice already sent via WhatsApp on ${sentDate}.\n\nSend again?`
        );
        if (!confirmResend) {
          setIsSendingInvoice(null);
          return;
        }
      }

      // Calculate totals across all invoices
      const totalInvoiced = invoices.reduce((sum, inv) => sum + (inv.total_after_discount || inv.total || 0), 0);
      const totalPaid = invoices.reduce((sum, inv) => sum + (inv.paid_amount || 0), 0);
      const totalBalance = totalInvoiced - totalPaid;

      // Generate PDFs for all invoices that don't have one
      const { data: templates } = await database.invoiceTemplates.getAll();
      const defaultTemplate = templates?.find((t: any) => t.is_default) || templates?.[0];

      if (!defaultTemplate) {
        alert("No invoice template found. Please configure templates in Settings.");
        setIsSendingInvoice(null);
        return;
      }

      // Ensure all invoices have PDFs
      const pdfUrls: string[] = [];
      for (const invoice of invoices) {
        let pdfUrl = invoice.pdf_url;
        if (!pdfUrl) {
          pdfUrl = await generateInvoicePDF(invoice.id, defaultTemplate.id, { triggerNotification: false });
          if (!pdfUrl) {
            alert(`Failed to generate PDF for invoice ${invoice.invoice_number || invoice.id.slice(0, 8)}`);
            setIsSendingInvoice(null);
            return;
          }
        }
        pdfUrls.push(pdfUrl);
      }

      let phone = order.patient_phone || "";
      if (!phone && order.patient_id) {
        const { data: patientData } = await supabase.from("patients").select("phone").eq("id", order.patient_id).single();
        phone = patientData?.phone || "";
      }

      const normalizePhone = (p: string): string => {
        const digitsOnly = p.replace(/\D/g, "");
        if (digitsOnly.length <= 10) return digitsOnly;
        return digitsOnly.slice(-10);
      };

      phone = normalizePhone(phone);

      if (!phone || phone.length < 10) {
        const input = window.prompt("Patient phone not found. Enter phone number to send invoice:", phone);
        if (!input) {
          setIsSendingInvoice(null);
          return;
        }
        phone = normalizePhone(input);
      }

      if (phone.length !== 10) {
        alert("Invalid phone number. Please enter a valid 10-digit number.");
        setIsSendingInvoice(null);
        return;
      }

      // Build message with all invoices info
      const invoiceListText = invoices.length > 1
        ? `\n\nInvoices (${invoices.length}):\n${invoices.map(inv => 
            `• ${inv.invoice_number || inv.id.slice(0, 8)}: ₹${(inv.total_after_discount || inv.total || 0).toLocaleString()}`
          ).join('\n')}\n`
        : '';

      const pdfLinksText = invoices.length > 1
        ? pdfUrls.map((url, i) => `${invoices[i].invoice_number || invoices[i].id.slice(0, 8)}: ${url}`).join('\n\n')
        : pdfUrls[0];

      const baseMessage =
        `Dear ${order.patient_name}, \n\n` +
        `Your invoice${invoices.length > 1 ? 's are' : ' is'} ready.` +
        invoiceListText +
        `\nTotal Amount: ₹${totalInvoiced.toLocaleString()} \n` +
        (totalPaid > 0
          ? `Paid: ₹${totalPaid.toLocaleString()} \nBalance Due: ₹${totalBalance.toLocaleString()} \n\n`
          : "\n") +
        `Thank you for choosing our services!`;

      const messageWithLink =
        `Dear ${order.patient_name}, \n\n` +
        `Your invoice${invoices.length > 1 ? 's are' : ' is'} ready. Please find the invoice PDF${invoices.length > 1 ? 's' : ''} here: \n\n${pdfLinksText} \n` +
        invoiceListText +
        `\nTotal Amount: ₹${totalInvoiced.toLocaleString()} \n` +
        (totalPaid > 0
          ? `Paid: ₹${totalPaid.toLocaleString()} \nBalance Due: ₹${totalBalance.toLocaleString()} \n\n`
          : "\n") +
        `Thank you for choosing our services!`;

      // Try backend API first - send primary invoice PDF
      try {
        const connection = await WhatsAppAPI.getConnectionStatus();
        if (!connection.isConnected) throw new Error("WhatsApp not connected");

        // Send first invoice PDF with full message
        const result = await WhatsAppAPI.sendReportFromUrl(phone, pdfUrls[0], baseMessage, order.patient_name, "Invoice");

        if (result.success) {
          // Record WhatsApp send for all invoices
          for (const invoice of invoices) {
            try {
              await database.invoices.recordWhatsAppSend(invoice.id, {
                to: phone,
                caption: baseMessage,
                sentBy: user?.id || "",
                sentVia: "api",
              });
            } catch (recordError) {
              console.error("Failed to record invoice WhatsApp send:", recordError);
            }
          }

          // If multiple invoices, send additional PDFs
          if (pdfUrls.length > 1) {
            for (let i = 1; i < pdfUrls.length; i++) {
              try {
                await WhatsAppAPI.sendReportFromUrl(
                  phone, 
                  pdfUrls[i], 
                  `Invoice ${invoices[i].invoice_number || invoices[i].id.slice(0, 8)}`,
                  order.patient_name,
                  "Invoice"
                );
              } catch (err) {
                console.error(`Failed to send additional invoice ${i}:`, err);
              }
            }
          }

          alert(`Invoice${invoices.length > 1 ? 's' : ''} sent via WhatsApp successfully!`);
          fetchOrders();
          setIsSendingInvoice(null);
          return;
        }
      } catch (apiError) {
        console.log("Backend API failed, falling back to manual WhatsApp:", apiError);
      }

      // Fallback to manual WhatsApp link
      const { success: manualSuccess } = await openWhatsAppManually(phone, messageWithLink);
      if (manualSuccess) {
        // Record WhatsApp send for all invoices
        for (const invoice of invoices) {
          try {
            await database.invoices.recordWhatsAppSend(invoice.id, {
              to: phone,
              caption: messageWithLink,
              sentBy: user?.id || "",
              sentVia: "manual_link",
            });
          } catch (recordError) {
            console.error("Failed to record invoice WhatsApp send:", recordError);
          }
        }

        alert("WhatsApp opened. Please send the message manually.");
        fetchOrders();
      }
    } catch (error) {
      console.error("Error sending invoice:", error);
      alert("Failed to send invoice. Please try again.");
    } finally {
      setIsSendingInvoice(null);
    }
  };

  const handlePrintInvoice = async (order: CardOrder) => {
    try {
      const { data: invoices } = await database.invoices.getAllByOrderId(order.id);
      if (!invoices || invoices.length === 0) {
        alert("Invoice not found. Please create an invoice first.");
        return;
      }

      // Ensure primary invoice has a PDF
      const primaryInvoice = invoices[0];
      let pdfUrl = primaryInvoice.pdf_url;

      if (!pdfUrl) {
        const { data: templates } = await database.invoiceTemplates.getAll();
        const defaultTemplate = templates?.find((t: any) => t.is_default) || templates?.[0];
        if (!defaultTemplate) {
          alert("No invoice template found. Please configure templates in Settings.");
          return;
        }
        pdfUrl = await generateInvoicePDF(primaryInvoice.id, defaultTemplate.id, { triggerNotification: false });
      }

      if (pdfUrl) {
        window.open(`${pdfUrl}?t=${Date.now()}`, '_blank');
      }
    } catch (error) {
      console.error("Error printing invoice:", error);
      alert("Failed to load invoice for printing. Please try again.");
    }
  };

  const handlePrintReport = async (order: CardOrder) => {
    const pdfUrl = order.report_print_url || order.report_url;
    console.debug('[PrintBridge][ReportPrint] dashboard print clicked', {
      orderId: order.id,
      patientName: order.patient_name,
      reportUrl: order.report_url,
      reportPrintUrl: order.report_print_url,
      selectedPdfUrl: pdfUrl,
      configuredPrinter: qzSettings.reportPrinterName,
      queueReady: qzTrayService.isConnected(),
    });

    if (!pdfUrl) {
      console.warn('[PrintBridge][ReportPrint] print blocked: no report PDF URL', { orderId: order.id });
      alert("Report PDF not generated yet.");
      return;
    }

    if (!qzSettings.reportPrinterName) {
      console.warn('[PrintBridge][ReportPrint] print blocked: report printer is not configured', { orderId: order.id });
      alert("Report Printer is not configured in Workflow Settings.");
      return;
    }

    try {
      setPrintingReportId(order.id);

      if (!qzTrayService.isConnected()) {
        console.debug('[PrintBridge][ReportPrint] queue paused, resuming', { orderId: order.id });
        await qzConnect();
      }

      console.debug('[PrintBridge][ReportPrint] queueing report PDF', {
        orderId: order.id,
        printerName: qzSettings.reportPrinterName,
        pdfUrl,
      });
      await qzTrayService.printPDFFromUrl(qzSettings.reportPrinterName, pdfUrl);
      console.debug('[PrintBridge][ReportPrint] print job queued', {
        orderId: order.id,
        printerName: qzSettings.reportPrinterName,
        pdfUrl,
      });
    } catch (error: any) {
      console.error("Print bridge report queue failed:", error);
      alert(error?.message || "Failed to queue report for LIMS Utility.");
    } finally {
      setPrintingReportId(null);
    }
  };

  const getDashboardLabelData = (order: CardOrder): qzTrayService.BarcodeLabelData[] => {
    const labelDate = new Date(order.order_date);
    const primaryPanel = order.panels.find((panel) => panel.sample_type || panel.name) || order.panels[0];
    const sourceSamples = order.samples?.length
      ? order.samples
      : order.sample_barcode
        ? [{ id: order.sample_id || order.sample_barcode, barcode: order.sample_barcode, sample_type: primaryPanel?.sample_type || order.color_name || "Sample" }]
        : [];

    return sourceSamples
      .map((sample) => ({
        sample,
        barcodeValue: String(sample.barcode || '').trim(),
      }))
      .filter(({ barcodeValue }) => !!barcodeValue)
      .map(({ sample, barcodeValue }) => ({
        sampleId: barcodeValue,
        labelId: sample.id || barcodeValue,
        patientName: order.patient_name || "Sample",
        sampleType: sample.sample_type || primaryPanel?.sample_type || order.color_name || "Sample",
        date: isValid(labelDate)
          ? labelDate.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "2-digit" }).replace(/ /g, "-")
          : undefined,
        collectionTime: isValid(labelDate)
          ? labelDate.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false })
          : undefined,
        gender: order.patient?.gender || undefined,
        age: order.patient?.age ? String(order.patient.age) : undefined,
        referredBy: order.doctor || undefined,
      }));
  };

  const handlePrintBarcodeLabel = async (order: CardOrder) => {
    const labelData = getDashboardLabelData(order);
    if (labelData.length === 0) {
      alert("No sample barcode is available for this order.");
      return;
    }

    const barcodePrinterName = qzSettings.barcodePrinterName;

    try {
      setPrintingLabelId(order.id);

      if (!barcodePrinterName || qzSettings.barcodeBrowserPrintEnabled) {
        qzTrayService.printBarcodeLabelsInBrowser(labelData, barcodePrinterName);
        return;
      }

      if (!qzTrayService.isConnected()) {
        await qzConnect();
      }

      for (const label of labelData) {
        await qzTrayService.printBarcodeLabel(barcodePrinterName, label);
      }
    } catch (error: any) {
      console.error("Print bridge label queue failed:", error);
      alert(error?.message || "Failed to print barcode label.");
    } finally {
      setPrintingLabelId(null);
    }
  };

  const getBillingBadge = (order: any) => {
    if (order.billing_status === "billed") {
      return (
        <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800">
          💰 Fully Billed
        </span>
      );
    } else if (order.billing_status === "partial") {
      return (
        <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">
          💸 Partially Billed
        </span>
      );
    } else {
      return (
        <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-800">
          📋 Not Billed
        </span>
      );
    }
  };

  /* ------------- filtering + grouping ------------- */
  const uniqueDoctors = useMemo(() => {
    const docs = new Set<string>();
    orders.forEach((o) => { if (o.doctor) docs.add(o.doctor); });
    return Array.from(docs).sort();
  }, [orders]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return orders.filter((o) => {
      const matchesQ = o.patient_name.toLowerCase().includes(q) || (o.patient_id || "").toLowerCase().includes(q) || (o.id || "").toLowerCase().includes(q);
      const matchesStatus = statusFilter === "All" || o.status === statusFilter;
      const matchesDoctor = doctorFilter === "All" || o.doctor === doctorFilter;
      return matchesQ && matchesStatus && matchesDoctor;
    });
  }, [orders, search, statusFilter, doctorFilter]);

  type Group = { key: string; label: string; orders: CardOrder[] };
  const groups: Group[] = useMemo(() => {
    const map = new Map<string, { date: Date; orders: CardOrder[] }>();
    filtered.forEach((o) => {
      const d = new Date(o.order_date);
      d.setHours(0, 0, 0, 0);
      const k = d.toISOString().slice(0, 10);
      map.set(k, map.get(k) || { date: d, orders: [] });
      map.get(k)!.orders.push(o);
    });

    return Array.from(map.entries())
      .sort((a, b) => b[1].date.getTime() - a[1].date.getTime())
      .map(([key, v]) => ({
        key,
        label: v.date.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" }),
        orders: v.orders.sort((a, b) => {
          const nA = getDailySeq(a);
          const nB = getDailySeq(b);
          if (nA !== nB) return nB - nA;
          return new Date(b.order_date).getTime() - new Date(a.order_date).getTime();
        }),
      }));
  }, [filtered]);

  const openDetails = (o: CardOrder) => setSelectedOrder(o);

  const setDateRange = (days: number) => {
    const to = new Date();
    const from = new Date();
    from.setDate(to.getDate() - Math.max(days - 1, 0));

    setAllDates(false);
    setDateTo(to.toISOString().split("T")[0]);
    setDateFrom(from.toISOString().split("T")[0]);
  };

  const setToday = () => {
    const today = new Date().toISOString().split("T")[0];
    setAllDates(false);
    setDateFrom(today);
    setDateTo(today);
  };

  const mobile = useMobileOptimizations();

  return (
    <>
      <div className={mobile.spacing}>
        {/* Header */}
        <div className="flex flex-col gap-3">
          {!mobile.isMobile ? (
            <div className="grid grid-cols-3 items-center">
              {/* Left: Title */}
              <h1 className={`${mobile.titleSize} font-bold text-gray-900 flex items-center gap-2`}>
                Test Orders
                <button
                  onClick={() => setIsHeaderCollapsed(!isHeaderCollapsed)}
                  className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors text-gray-500"
                  title={isHeaderCollapsed ? "Show Filters" : "Hide Filters"}
                >
                  {isHeaderCollapsed ? <ChevronDown className="h-5 w-5" /> : <ChevronUp className="h-5 w-5" />}
                </button>
              </h1>
              {/* Center: Create Order — prominent CTA */}
              <div className="flex justify-center items-center gap-3">
                <button
                  onClick={() => setShowOrderForm(true)}
                  className="inline-flex items-center gap-2 px-8 py-3 bg-primary-600 text-white text-lg font-bold rounded-xl hover:bg-primary-700 active:bg-primary-800 shadow-lg hover:shadow-xl transition-all"
                >
                  <Plus className="h-6 w-6" />
                  Create Order
                </button>
                <button
                  onClick={() => setBookingQueueOpen((o) => !o)}
                  className={`relative inline-flex items-center gap-2 px-4 py-3 rounded-xl font-semibold shadow-sm border transition-all ${
                    bookingQueueOpen
                      ? "bg-blue-50 text-blue-700 border-blue-300"
                      : "bg-white text-gray-700 border-gray-200 hover:bg-blue-50 hover:border-blue-200"
                  }`}
                  title="View pending bookings"
                >
                  <Calendar className="h-5 w-5 text-blue-600" />
                  Booking Queue
                  {pendingBookingsCount > 0 && (
                    <span className="absolute -top-2 -right-2 min-w-[22px] h-[22px] px-1.5 flex items-center justify-center rounded-full bg-red-500 text-white text-xs font-bold shadow">
                      {pendingBookingsCount > 99 ? "99+" : pendingBookingsCount}
                    </span>
                  )}
                </button>
              </div>
              {/* Right: secondary controls */}
              <div className="flex justify-end">
                <button
                  onClick={() => setIsCollapsedView(!isCollapsedView)}
                  className={`px-4 py-2 rounded-lg font-medium transition-colors ${isCollapsedView ? "bg-primary-600 text-white" : "bg-gray-100 text-gray-700 hover:bg-gray-200"}`}
                >
                  {isCollapsedView ? "Expand Cards" : "Collapse Cards"}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <h1 className={`${mobile.titleSize} font-bold text-gray-900 flex items-center gap-2`}>
                Test Orders
                <button
                  onClick={() => setIsHeaderCollapsed(!isHeaderCollapsed)}
                  className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors text-gray-500"
                  title={isHeaderCollapsed ? "Show Filters" : "Hide Filters"}
                >
                  {isHeaderCollapsed ? <ChevronDown className="h-5 w-5" /> : <ChevronUp className="h-5 w-5" />}
                </button>
              </h1>
            </div>
          )}

          {mobile.isMobile && (
            <button
              onClick={() => setShowOrderForm(true)}
              className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-primary-600 text-white px-4 py-3 text-sm font-semibold shadow-sm hover:bg-primary-700 transition-colors"
            >
              <Plus className="h-5 w-5" />
              Create Order
            </button>
          )}

          {!mobile.isMobile && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setDashboardTab("standard")}
                className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg font-medium shadow-sm transition-all ${dashboardTab === "standard" ? "bg-blue-50 text-blue-700 border border-blue-200" : "bg-white text-gray-700 border border-gray-200 hover:bg-gray-50"}`}
              >
                <LayoutDashboard className="h-4 w-4" />
                Standard View
              </button>
              <button
                onClick={() => setDashboardTab("patient-visits")}
                className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg font-medium shadow-sm transition-all ${dashboardTab === "patient-visits" ? "bg-blue-50 text-blue-700 border border-blue-200" : "bg-white text-gray-700 border border-gray-200 hover:bg-gray-50"}`}
              >
                <Users className="h-4 w-4" />
                Patient Visits
              </button>
            </div>
          )}
        </div>

        {!isHeaderCollapsed && (
          <div className="mt-4 space-y-4">
            {/* Overview cards */}
            <div className={`grid ${mobile.gridCols} ${mobile.isMobile ? "gap-3" : mobile.gap}`}>
              <div className={`bg-green-50 border border-green-200 rounded-lg ${mobile.isMobile ? "p-4" : mobile.cardPadding} shadow-sm transition-all hover:shadow-md`}>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-2xl font-bold text-green-900 leading-tight">{summary.allDone}</div>
                    <div className={`${mobile.isMobile ? "text-sm" : mobile.textSize} text-green-700 font-medium whitespace-nowrap`}>All Done</div>
                  </div>
                  <div className="bg-green-500 p-2.5 rounded-lg shadow-sm shrink-0">
                    <CheckCircle className="h-5 w-5 text-white" />
                  </div>
                </div>
              </div>

              <div className={`bg-blue-50 border border-blue-200 rounded-lg ${mobile.isMobile ? "p-4" : mobile.cardPadding} shadow-sm transition-all hover:shadow-md`}>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-2xl font-bold text-blue-900 leading-tight">{summary.mostlyDone}</div>
                    <div className={`${mobile.isMobile ? "text-sm" : mobile.textSize} text-blue-700 font-medium whitespace-nowrap`}>Mostly Done</div>
                  </div>
                  <div className="bg-blue-500 p-2.5 rounded-lg shadow-sm shrink-0">
                    <TrendingUp className="h-5 w-5 text-white" />
                  </div>
                </div>
              </div>

              <div className={`bg-yellow-50 border border-yellow-200 rounded-lg ${mobile.isMobile ? "p-4" : mobile.cardPadding} shadow-sm transition-all hover:shadow-md`}>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-2xl font-bold text-yellow-900 leading-tight">{summary.pending}</div>
                    <div className={`${mobile.isMobile ? "text-sm" : mobile.textSize} text-yellow-700 font-medium whitespace-nowrap`}>Pending</div>
                  </div>
                  <div className="bg-yellow-500 p-2.5 rounded-lg shadow-sm shrink-0">
                    <ClockIcon className="h-5 w-5 text-white" />
                  </div>
                </div>
              </div>

              <div className={`bg-orange-50 border border-orange-200 rounded-lg ${mobile.isMobile ? "p-4" : mobile.cardPadding} shadow-sm transition-all hover:shadow-md`}>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-2xl font-bold text-orange-900 leading-tight">{summary.awaitingApproval}</div>
                    <div className={`${mobile.isMobile ? "text-sm" : mobile.textSize} text-orange-700 font-medium whitespace-nowrap`}>Awaiting Approval</div>
                  </div>
                  <div className="bg-orange-500 p-2.5 rounded-lg shadow-sm shrink-0">
                    <AlertTriangle className="h-5 w-5 text-white" />
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Booking Queue - available in all views */}
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden mb-2">
          <button
            onClick={() => setBookingQueueOpen((o) => !o)}
            className="w-full flex items-center justify-between px-5 py-3 hover:bg-gray-50 transition-colors"
          >
            <div className="flex items-center gap-2">
              <Calendar className="h-4 w-4 text-blue-600" />
              <span className="font-semibold text-gray-800">Booking Queue</span>
              {pendingBookingsCount > 0 && (
                <span className="min-w-[20px] h-5 px-1.5 flex items-center justify-center rounded-full bg-red-500 text-white text-xs font-bold">
                  {pendingBookingsCount > 99 ? "99+" : pendingBookingsCount}
                </span>
              )}
            </div>
            {bookingQueueOpen ? <ChevronUp className="h-4 w-4 text-gray-500" /> : <ChevronDown className="h-4 w-4 text-gray-500" />}
          </button>
          {bookingQueueOpen && (
            <div className="border-t border-gray-100 p-4">
              <BookingQueue
                onCountChange={setPendingBookingsCount}
                onProcessBooking={(booking) => {
                  setProcessingBooking(booking);
                  setShowOrderForm(true);
                }}
              />
            </div>
          )}
        </div>

        <SampleTransitWidget />

        {/* Search / Filters */}
        <div className={`bg-white rounded-lg border border-gray-200 shadow-sm ${mobile.cardPadding}`}>
          <div className="flex flex-col gap-3">
            {/* Search row — always visible */}
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={mobile.isMobile ? "Search patient..." : "Search by patient, order ID, or patient ID…"}
                  className={`w-full pl-10 pr-4 ${mobile.isMobile ? "py-2.5 text-base" : "py-2"} border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 shadow-sm transition-all`}
                />
              </div>
              <button
                onClick={() => setFiltersOpen((o) => !o)}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-lg border text-sm font-medium transition-colors ${filtersOpen ? "bg-blue-50 border-blue-300 text-blue-700" : "bg-white border-gray-300 text-gray-600 hover:bg-gray-50"}`}
              >
                <Filter className="h-4 w-4" />
                {!mobile.isMobile && "Filters"}
                {(statusFilter !== "All" || doctorFilter !== "All" || allDates) && (
                  <span className="ml-0.5 bg-blue-500 text-white text-xs rounded-full w-4 h-4 flex items-center justify-center leading-none">
                    {[statusFilter !== "All", doctorFilter !== "All", allDates].filter(Boolean).length}
                  </span>
                )}
              </button>
            </div>

            {/* Collapsible filters */}
            {filtersOpen && (
              <div className="flex flex-col gap-3 pt-1 border-t border-gray-100">
                <div className="flex gap-2 flex-wrap">
                  <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value as any)}
                    className={`flex-1 min-w-[140px] ${mobile.isMobile ? "px-3 py-2.5 text-base" : "px-3 py-2"} border border-gray-300 rounded-lg bg-white font-medium shadow-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-200`}
                  >
                    {["All", "Order Created", "Sample Collection", "In Progress", "Pending Approval", "Completed", "Delivered"].map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>

                  <select
                    value={doctorFilter}
                    onChange={(e) => setDoctorFilter(e.target.value)}
                    className={`flex-1 min-w-[140px] ${mobile.isMobile ? "px-3 py-2.5 text-base" : "px-3 py-2"} border border-gray-300 rounded-lg bg-white font-medium shadow-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-200`}
                  >
                    <option value="All">All Ref By</option>
                    {uniqueDoctors.map((doc) => (
                      <option key={doc} value={doc}>{doc}</option>
                    ))}
                  </select>

                  {doctorFilter !== "All" && (
                    <button
                      onClick={() => setDoctorFilter("All")}
                      className="px-3 py-1.5 text-xs bg-blue-100 text-blue-700 rounded-lg border border-blue-200 hover:bg-blue-200 font-medium whitespace-nowrap"
                    >
                      ✕ {doctorFilter}
                    </button>
                  )}
                </div>

                {/* Date Range */}
                {mobile.isMobile ? (
                  <div className="bg-gradient-to-br from-gray-50 to-blue-50 rounded-xl p-4 space-y-4 border border-gray-200">
                    <h3 className="text-base font-bold text-gray-900">Date Range:</h3>

                    {!allDates && (
                      <div className="space-y-2">
                        <div className="flex items-center gap-2">
                          <label className="text-sm font-medium text-gray-600 w-16">From:</label>
                          <input
                            type="date"
                            value={dateFrom}
                            onChange={(e) => {
                              setAllDates(false);
                              setDateFrom(e.target.value);
                            }}
                            className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 bg-white"
                          />
                        </div>
                        <div className="flex items-center gap-2">
                          <label className="text-sm font-medium text-gray-600 w-16">To:</label>
                          <input
                            type="date"
                            value={dateTo}
                            onChange={(e) => {
                              setAllDates(false);
                              setDateTo(e.target.value);
                            }}
                            className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 bg-white"
                          />
                        </div>
                      </div>
                    )}

                    <div className="grid grid-cols-2 gap-2">
                      <button onClick={setToday} className="px-3 py-2.5 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 font-medium shadow-sm">
                        Today
                      </button>
                      <button onClick={() => setDateRange(5)} className="px-3 py-2.5 text-sm bg-white border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 font-medium">
                        5 days
                      </button>
                      <button onClick={() => setDateRange(30)} className="px-3 py-2.5 text-sm bg-white border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 font-medium">
                        30 days
                      </button>
                      <button onClick={() => setDateRange(90)} className="px-3 py-2.5 text-sm bg-white border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 font-medium">
                        90 days
                      </button>
                      <button
                        onClick={() => setAllDates(true)}
                        className="col-span-2 px-3 py-2.5 text-sm bg-white border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 font-medium"
                      >
                        All Dates
                      </button>
                    </div>

                    <div className="grid grid-cols-2 gap-2 pt-2 border-t border-gray-200">
                      <button
                        onClick={() => setStatusFilter("Pending Approval")}
                        className={`px-3 py-2.5 text-sm rounded-lg font-medium ${statusFilter === "Pending Approval" ? "bg-orange-500 text-white shadow-sm" : "bg-orange-100 text-orange-700 hover:bg-orange-200"} `}
                      >
                        Pending
                      </button>
                      <button
                        onClick={() => setStatusFilter("All")}
                        className={`px-3 py-2.5 text-sm rounded-lg font-medium ${statusFilter === "All" ? "bg-gray-700 text-white shadow-sm" : "bg-gray-100 text-gray-700 hover:bg-gray-200"} `}
                      >
                        All
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="pt-2 border-t border-gray-100">
                    <div className="flex items-center gap-2 mb-2">
                      <Calendar className="h-4 w-4 text-gray-600" />
                      <span className="text-sm font-medium text-gray-700">Date Range:</span>
                      <button
                        onClick={() => setAllDates(!allDates)}
                        className={`ml-2 px-2 py-0.5 text-xs rounded border ${allDates ? "bg-blue-50 border-blue-200 text-blue-700" : "bg-white border-gray-200 text-gray-600"} `}
                      >
                        {allDates ? "All Dates ON" : "All Dates OFF"}
                      </button>
                    </div>

                    {!allDates && (
                      <>
                        <div className="flex gap-2 mb-2">
                          <div className="flex-1">
                            <label className="text-sm text-gray-600 block mb-1">From:</label>
                            <input
                              type="date"
                              value={dateFrom}
                              onChange={(e) => {
                                setAllDates(false);
                                setDateFrom(e.target.value);
                              }}
                              className="w-full px-3 py-1.5 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500"
                            />
                          </div>

                          <div className="flex-1">
                            <label className="text-sm text-gray-600 block mb-1">To:</label>
                            <input
                              type="date"
                              value={dateTo}
                              onChange={(e) => {
                                setAllDates(false);
                                setDateTo(e.target.value);
                              }}
                              className="w-full px-3 py-1.5 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500"
                            />
                          </div>
                        </div>

                        <div className="flex flex-wrap gap-1">
                          <button onClick={setToday} className="px-3 py-1 text-sm bg-blue-100 text-blue-700 rounded hover:bg-blue-200">
                            Today
                          </button>
                          <button onClick={() => setDateRange(5)} className="px-3 py-1 text-sm bg-gray-100 text-gray-700 rounded hover:bg-gray-200">
                            5 days
                          </button>
                          <button onClick={() => setDateRange(30)} className="px-3 py-1 text-sm bg-gray-100 text-gray-700 rounded hover:bg-gray-200">
                            30 days
                          </button>
                          <button onClick={() => setDateRange(90)} className="px-3 py-1 text-sm bg-gray-100 text-gray-700 rounded hover:bg-gray-200">
                            90 days
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {
        isHeaderCollapsed && (
          <div className="mt-4 flex flex-wrap items-center gap-3 animate-in fade-in slide-in-from-top-2 duration-300">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Quick search..."
                className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 h-10 shadow-sm transition-all"
              />
            </div>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as any)}
              className="w-full sm:w-48 px-3 py-2 border border-gray-300 rounded-lg bg-white font-medium h-10 shadow-sm focus:ring-2 focus:ring-blue-200 transition-all"
            >
              {["All", "Order Created", "Sample Collection", "In Progress", "Pending Approval", "Completed", "Delivered"].map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
        )
      }

      {/* Groups + Cards */}
      <div className={`mt-6 bg-white rounded-lg border border-gray-200 shadow-sm ${mobile.isMobile ? "mb-20" : ""}`}>
        <div className={`${mobile.isMobile ? "px-3 py-3" : "px-6 py-4"} border-b border-gray-200 bg-gray-50/50`}>
          <h3 className={`${mobile.isMobile ? "text-base" : "text-lg"} font-semibold text-gray-900`}>Test Orders ({filtered.length})</h3>
        </div>

        {
          groups.length === 0 ? (
            <div className="text-center py-12">
              <TestTube className="h-12 w-12 text-gray-300 mx-auto mb-3" />
              <p className="text-gray-600">No Orders Found</p>
            </div>
          ) : (
            <div className="space-y-8">
              {groups.map((g) => (
                <div key={g.key} className="px-6">
                  <div className="flex items-center justify-between py-4 border-b-2 mb-6 border-gray-200">
                    <h4 className="text-lg font-semibold text-gray-700">{g.label}</h4>
                    <div className="text-sm text-gray-500">
                      {g.orders.length} order{g.orders.length !== 1 ? "s" : ""}
                    </div>
                  </div>

                  {isCollapsedView ? (
                    <div className="space-y-2">
                      {g.orders.map((o) => {
                        const pct = o.expectedTotal > 0 ? Math.round((o.enteredTotal / o.expectedTotal) * 100) : 0;
                        const visiblePanels = mobile.isMobile ? o.panels.slice(0, 2) : o.panels;
                        const hiddenPanelCount = Math.max(0, o.panels.length - visiblePanels.length);
                        const fallbackTests = o.tests.filter((t) => !t.test_name?.startsWith("📦"));
                        const visibleFallbackTests = mobile.isMobile ? fallbackTests.slice(0, 2) : fallbackTests;
                        const hiddenFallbackTestCount = Math.max(0, fallbackTests.length - visibleFallbackTests.length);

                        return (
                          <div
                            key={o.id}
                            role="button"
                            onClick={() => openDetails(o)}
                            className="w-full px-3 pt-3 pb-2 border rounded-lg hover:shadow-md transition-all cursor-pointer border-gray-200 bg-white flex flex-col gap-1.5"
                          >
                            <div className="flex items-center justify-between">
                            <div className="flex items-center space-x-4 flex-1 min-w-0">
                              <div className="flex items-center justify-center w-6 h-6 bg-blue-100 text-blue-700 rounded-full font-bold text-xs border border-blue-200">
                                {String(getDailySeq(o)).padStart(3, "0")}
                              </div>
                              <User className="h-4 w-4 text-blue-600 shrink-0" />
                              <span className="font-medium text-gray-900 truncate">{o.patient?.name || o.patient_name}</span>
                              <span className="text-sm text-gray-600 truncate">
                                {formatAge(o.patient?.age, (o.patient as any)?.age_unit)} • {o.patient?.gender || "N/A"}
                              </span>

                              {o.account_name && (
                                <span className="flex items-center gap-1 text-xs text-indigo-600 font-medium bg-indigo-50 px-1.5 py-0.5 rounded border border-indigo-100 truncate max-w-[140px]">
                                  <Briefcase className="h-3 w-3" />
                                  {o.account_name}
                                </span>
                              )}

                              {o.doctor && (
                                <span className="hidden sm:flex items-center gap-1 text-xs text-purple-700 font-medium bg-purple-50 px-1.5 py-0.5 rounded border border-purple-100 truncate max-w-[160px]">
                                  👨‍⚕️ {o.doctor}
                                </span>
                              )}

                              <span className="text-xs text-gray-500">{o.sample_id ? `#${String(o.sample_id).split("-").pop()} ` : "No Sample"}</span>
                            </div>

                            <div className="flex items-center space-x-3 flex-shrink-0">
                              <div className="text-xs text-gray-600">
                                {pct}% ({o.enteredTotal}/{o.expectedTotal})
                              </div>

                              <OrderStatusDisplay order={o} compact={true} />

                              <div className="flex items-center space-x-1">
                                {o.report_url && <span className="px-1.5 py-0.5 text-xs font-medium rounded bg-blue-100 text-blue-700 border border-blue-200" title="Final Report Available">📄</span>}
                                {o.doctor_informed_at && (
                                  <span
                                    className="px-1.5 py-0.5 text-xs font-medium rounded bg-purple-100 text-purple-700 border border-purple-200"
                                    title={`Doctor Informed: ${new Date(o.doctor_informed_at).toLocaleString()} `}
                                  >
                                    👨‍⚕️
                                  </span>
                                )}
                                {(o.whatsapp_sent_at || o.email_sent_at) && (
                                  <span
                                    className="px-1.5 py-0.5 text-xs font-medium rounded bg-green-100 text-green-700 border border-green-200"
                                    title={`Sent: ${new Date(o.whatsapp_sent_at || o.email_sent_at!).toLocaleString()} `}
                                  >
                                    {o.whatsapp_sent_at ? "📱" : "📧"}
                                  </span>
                                )}
                                {o.invoice_whatsapp_sent_at && (
                                  <span
                                    className="px-1.5 py-0.5 text-xs font-medium rounded bg-teal-100 text-teal-700 border border-teal-200"
                                    title={`Invoice sent via WhatsApp: ${new Date(o.invoice_whatsapp_sent_at).toLocaleString()} `}
                                  >
                                    💬
                                  </span>
                                )}
                                {o.invoice_email_sent_at && (
                                  <span
                                    className="px-1.5 py-0.5 text-xs font-medium rounded bg-indigo-100 text-indigo-700 border border-indigo-200"
                                    title={`Invoice sent via Email: ${new Date(o.invoice_email_sent_at).toLocaleString()} `}
                                  >
                                    ✉️
                                  </span>
                                )}
                                {o.invoice_payment_reminder_count && o.invoice_payment_reminder_count > 0 && (
                                  <span className="px-1.5 py-0.5 text-xs font-medium rounded bg-amber-100 text-amber-700 border border-amber-200" title={`${o.invoice_payment_reminder_count} payment reminder(s) sent`}>
                                    🔔{o.invoice_payment_reminder_count}
                                  </span>
                                )}
                              </div>

                              {o.payment_status === "paid" ? (
                                <span className="px-2 py-1 text-xs font-bold rounded-full bg-green-100 text-green-800 border border-green-300">✓ Fully Paid</span>
                              ) : o.payment_status === "partial" ? (
                                <span className="px-2 py-1 text-xs font-bold rounded-full bg-orange-100 text-orange-800 border border-orange-300">
                                  ₹{(o.paid_amount || 0).toLocaleString()} Paid
                                </span>
                              ) : o.billing_status === "billed" ? (
                                <span className="px-2 py-1 text-xs font-bold rounded-full bg-red-100 text-red-800 border border-red-300">Unpaid/Billed</span>
                              ) : o.account_billing_mode === 'monthly' ? (
                                <span className="px-2 py-1 text-xs font-semibold rounded-full bg-purple-100 text-purple-800 border border-purple-300">🏢 Monthly Billing</span>
                              ) : (
                                <span className="px-2 py-1 text-xs font-semibold rounded-full bg-yellow-100 text-yellow-800 border border-yellow-300">Not Billed</span>
                              )}

                              <div className="flex flex-col items-end">
                                <span className="text-base font-bold text-gray-900">₹{Number(o.total_amount || 0).toLocaleString()}</span>
                                {!o.account_name && ((o.paid_amount || 0) > 0 || (o.due_amount || 0) > 0) && (
                                  <span className="text-xs font-semibold">
                                    {(o.paid_amount || 0) > 0 && (
                                      <span className="text-green-600">Paid: ₹{Number(o.paid_amount || 0).toLocaleString()}</span>
                                    )}
                                    {(o.paid_amount || 0) > 0 && (o.due_amount || 0) > 0 && (
                                      <span className="text-gray-400"> · </span>
                                    )}
                                    {(o.due_amount || 0) > 0 && (
                                      <span className="text-red-600">Due: ₹{Number(o.due_amount || 0).toLocaleString()}</span>
                                    )}
                                  </span>
                                )}
                              </div>

                              {o.priority !== "Normal" && (
                                <span className={`px-2 py-1 text-xs rounded-full ${o.priority === "Urgent" ? "bg-orange-100 text-orange-800" : "bg-red-100 text-red-800"}`}>
                                  {o.priority}
                                </span>
                              )}
                            </div>
                            </div>
                            {/* Test panel status chips */}
                            {(o.panels.length > 0 || o.tests.filter(t => !t.test_name?.startsWith("📦")).length > 0) && (
                              <div className="flex flex-wrap gap-1.5 pl-10 pb-0.5">
                                {o.panels.length > 0
                                  ? o.panels.map((p, i) => {
                                    // Section-only: show section status instead of analyte counts
                                    const isSectionVerified = p.section_verification_status === 'verified';
                                    const chipColor = p.is_section_only
                                      ? (isSectionVerified
                                          ? "border-green-200 bg-green-50 text-green-800"
                                          : p.has_section_content
                                            ? "border-amber-200 bg-amber-50 text-amber-800"
                                            : "border-gray-200 bg-gray-50 text-gray-600")
                                      : (p.verified
                                          ? "border-green-200 bg-green-50 text-green-800"
                                          : p.entered > 0
                                            ? "border-amber-200 bg-amber-50 text-amber-800"
                                            : "border-gray-200 bg-gray-50 text-gray-600");
                                    const statusText = p.is_section_only
                                      ? (isSectionVerified ? "✓" : p.has_section_content ? "Saved" : "Pending")
                                      : `${p.entered}/${p.expected}${p.verified ? " ✓" : ""}`;
                                    const titleText = p.is_section_only
                                      ? `${p.name}: ${isSectionVerified ? "Verified" : p.has_section_content ? "Saved, pending approval" : "Section pending"}`
                                      : `${p.name}: ${p.entered}/${p.expected}`;
                                    return (
                                      <span
                                        key={`chip-${i}`}
                                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[10px] font-semibold ${chipColor}`}
                                        title={titleText}
                                      >
                                        {p.name}
                                        <span className="opacity-70">{statusText}</span>
                                      </span>
                                    );
                                  })
                                  : o.tests.filter(t => !t.test_name?.startsWith("📦")).map((t, i) => (
                                    <span key={i} className="inline-flex items-center px-2 py-0.5 rounded border border-gray-200 bg-gray-50 text-[10px] font-semibold text-gray-600 truncate max-w-[150px]" title={t.test_name}>
                                      {t.test_name}
                                    </span>
                                  ))
                                }
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    // Expanded
                    <div className="space-y-4">
                      {g.orders.map((o) => {
                        const pct = o.expectedTotal > 0 ? Math.round((o.enteredTotal / o.expectedTotal) * 100) : 0;
                        const visiblePanels = mobile.isMobile ? o.panels.slice(0, 2) : o.panels;
                        const hiddenPanelCount = Math.max(0, o.panels.length - visiblePanels.length);
                        const fallbackTests = o.tests.filter((t) => !t.test_name?.startsWith("📦"));
                        const visibleFallbackTests = mobile.isMobile ? fallbackTests.slice(0, 2) : fallbackTests;
                        const hiddenFallbackTestCount = Math.max(0, fallbackTests.length - visibleFallbackTests.length);

                        return (
                          <div key={o.id} className="w-full p-4 border-2 rounded-lg hover:shadow-lg transition-all border-gray-200 bg-white">
                            {/* Top row */}
                            <div className="flex items-start justify-between gap-3 pb-3 border-b border-gray-200">
                              <div className="flex items-center gap-3 flex-1 min-w-0">
                                <div className="flex items-center justify-center w-8 h-8 bg-blue-100 text-blue-700 rounded-full font-bold text-sm border-2 border-blue-300 shrink-0">
                                  {String(getDailySeq(o)).padStart(3, "0")}
                                </div>
                                <User className="h-6 w-6 text-blue-600 shrink-0" />
                                <div className="min-w-0 flex-1">
                                  <div className="text-lg sm:text-xl font-bold text-gray-900 truncate">{o.patient?.name || o.patient_name}</div>
                                  <div className="text-sm text-gray-600 truncate">
                                    {formatAge(o.patient?.age, (o.patient as any)?.age_unit)} • {o.patient?.gender || "N/A"}
                                  </div>
                                  <div className="mt-1">
                                    <span className="text-xs text-gray-500 font-mono bg-gray-50 px-2 py-0.5 rounded border">
                                      {o.sample_id ? `#${String(o.sample_id).split("-").pop()} ` : "No Sample ID"}
                                    </span>
                                  </div>
                                </div>
                              </div>

                              <div className="flex flex-col items-end gap-2 shrink-0">
                                <div className="flex items-center gap-2">
                                  <OrderStatusDisplay order={o} compact={false} />
                                </div>

                                <div className="flex items-center gap-1.5">
                                  {o.report_url && (
                                    <span className="px-2 py-1 text-xs font-semibold rounded-lg bg-blue-100 text-blue-700 border border-blue-300" title="Final Report Available">
                                      📄 Report Ready
                                    </span>
                                  )}
                                  {o.doctor_informed_at && (
                                    <span className="px-2 py-1 text-xs font-semibold rounded-lg bg-purple-100 text-purple-700 border border-purple-300" title={`Doctor Informed: ${new Date(o.doctor_informed_at).toLocaleString()} `}>
                                      👨‍⚕️ Dr Informed
                                    </span>
                                  )}
                                  {(o.whatsapp_sent_at || o.email_sent_at) && (
                                    <span className="px-2 py-1 text-xs font-semibold rounded-lg bg-green-100 text-green-700 border border-green-300" title={`Sent: ${new Date(o.whatsapp_sent_at || o.email_sent_at!).toLocaleString()} `}>
                                      {o.whatsapp_sent_at ? "📱 Sent" : "📧 Emailed"}
                                    </span>
                                  )}
                                  {o.invoice_whatsapp_sent_at && (
                                    <span className="px-2 py-1 text-xs font-semibold rounded-lg bg-teal-100 text-teal-700 border border-teal-300" title={`Invoice sent via WhatsApp: ${new Date(o.invoice_whatsapp_sent_at).toLocaleString()} `}>
                                      💬 Invoice Sent
                                    </span>
                                  )}
                                  {o.invoice_email_sent_at && (
                                    <span className="px-2 py-1 text-xs font-semibold rounded-lg bg-indigo-100 text-indigo-700 border border-indigo-300" title={`Invoice sent via Email: ${new Date(o.invoice_email_sent_at).toLocaleString()} `}>
                                      ✉️ Invoice Emailed
                                    </span>
                                  )}
                                  {o.invoice_payment_reminder_count && o.invoice_payment_reminder_count > 0 && (
                                    <span
                                      className="px-2 py-1 text-xs font-semibold rounded-lg bg-amber-100 text-amber-700 border border-amber-300"
                                      title={`${o.invoice_payment_reminder_count} payment reminder(s) sent - Last: ${o.invoice_last_reminder_at ? new Date(o.invoice_last_reminder_at).toLocaleString() : "N/A"} `}
                                    >
                                      🔔 {o.invoice_payment_reminder_count} Reminder{o.invoice_payment_reminder_count > 1 ? "s" : ""}
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>

                            {/* Doctor + sample row */}
                            <div className="flex items-center justify-between gap-3 py-3 bg-gradient-to-r from-purple-50 to-blue-50 rounded-lg px-3 mt-3 border border-purple-100">
                              <div className="flex items-center gap-4 flex-1">
                                {o.doctor && (
                                  <div className="flex items-center gap-2">
                                    <span className="text-2xl">👨‍⚕️</span>
                                    <div>
                                      <div className="text-xs text-gray-600 font-medium">Referring Doctor</div>
                                      <div className="text-base font-bold text-gray-900">{o.doctor}</div>
                                    </div>
                                  </div>
                                )}

                                {o.sample_id && (
                                  <div className="flex items-center gap-2">
                                    <div
                                      className="w-7 h-7 rounded-full border-2 border-white shadow-md flex items-center justify-center text-white font-bold text-xs"
                                      style={{ backgroundColor: o.color_code || "#8B5CF6" }}
                                      title={`Sample Color: ${o.color_code || "N/A"} `}
                                    >
                                      {(o.color_name || "T").charAt(0)}
                                    </div>
                                    <div>
                                      <div className="text-xs text-gray-600 font-medium">Sample ID</div>
                                      <div className="font-mono font-bold text-gray-900 text-sm">#{String(o.sample_id).split("-").pop()}</div>
                                    </div>
                                  </div>
                                )}

                                {o.account_name && (
                                  <div className="flex items-center gap-2 bg-indigo-50 border border-indigo-100 rounded-lg px-2 py-1">
                                    <Briefcase className="h-4 w-4 text-indigo-600" />
                                    <div>
                                      <div className="text-xs text-gray-600 font-medium">Account</div>
                                      <div className="text-sm font-bold text-indigo-800">{o.account_name}</div>
                                    </div>
                                  </div>
                                )}
                              </div>

                              <div className="text-right">
                                <div className="flex items-center justify-end gap-2">
                                  <div className="text-2xl font-bold text-gray-900">₹{Number(o.final_amount ?? o.total_amount ?? 0).toLocaleString()}</div>
                                  {getBillingBadge(o)}
                                </div>
                                <div className="flex items-center justify-end gap-3 mt-1 text-xs">
                                  {(o.paid_amount || 0) > 0 && (
                                    <span className="font-semibold text-green-600">Paid: ₹{Number(o.paid_amount || 0).toLocaleString()}</span>
                                  )}
                                  {(o.due_amount || 0) > 0 ? (
                                    <span className="font-semibold text-red-600">Due: ₹{Number(o.due_amount || 0).toLocaleString()}</span>
                                  ) : (
                                    <span className="font-semibold text-green-600">Due: ₹0</span>
                                  )}
                                </div>
                              </div>
                            </div>

                            {/* Details */}
                            <div className="mt-3">
                              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 bg-blue-50 rounded-lg text-xs sm:text-sm border border-blue-100">
                                {o.patient?.mobile && (
                                  <div className="flex items-center gap-1.5 text-blue-800">
                                    <span className="text-base">📱</span>
                                    <span className="font-semibold">{o.patient.mobile}</span>
                                  </div>
                                )}
                                {o.patient?.email && (
                                  <div className="hidden sm:flex items-center gap-1.5 text-blue-700">
                                    <span className="text-base">✉️</span>
                                    <span>{o.patient.email}</span>
                                  </div>
                                )}
                                {o.location && (
                                  <div className="flex items-center gap-1.5 text-purple-700">
                                    <span className="text-base">🏥</span>
                                    <span className="font-medium">{o.location}</span>
                                  </div>
                                )}
                                {o.transit_status && o.transit_status !== "received_at_lab" && (
                                  <div
                                    className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full ${o.transit_status === "in_transit"
                                      ? "bg-amber-100 text-amber-800"
                                      : o.transit_status === "pending_dispatch"
                                        ? "bg-yellow-100 text-yellow-800"
                                        : "bg-gray-100 text-gray-700"
                                      }`}
                                  >
                                    <span className="text-base">🚚</span>
                                    <span className="font-medium text-xs">
                                      {o.transit_status === "in_transit"
                                        ? "In Transit"
                                        : o.transit_status === "pending_dispatch"
                                          ? "Pending Dispatch"
                                          : o.transit_status === "at_collection_point"
                                            ? "At Collection"
                                            : o.transit_status}
                                    </span>
                                  </div>
                                )}
                              </div>

                              {/* Order Info & Tests */}
                              <div className="mt-3 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3 bg-gray-50 rounded-lg p-3 border border-gray-200">
                                <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                                  <div className="min-w-[120px]">
                                    <div className="text-xs text-gray-500 font-medium">Order ID</div>
                                    <div className="font-bold text-gray-900 text-base">#{(o.id || "").slice(-6)}</div>
                                    <div className="mt-1">
                                      <OrderStatusDisplay order={o} compact={true} />
                                    </div>
                                  </div>

                                  <div className="flex-1">
                                    {(() => {
                                      const packageTest = o.tests.find((t) => t.test_name?.startsWith("📦"));
                                      const packageName = packageTest?.test_name?.replace("📦", "").trim();

                                      return (
                                        <>
                                          <div className="text-xs text-gray-500 mb-1">
                                            Tests ({o.tests.length})
                                            {packageName && (
                                              <span className="ml-2 px-2 py-0.5 bg-purple-100 text-purple-700 rounded border border-purple-200 font-semibold">
                                                📦 {packageName}
                                              </span>
                                            )}
                                          </div>

                                          <div className="flex flex-wrap gap-2">
                                            {o.panels.length > 0
                                              ? visiblePanels.map((p, i) => {
                                                // Section-only: check section status instead of analyte progress
                                                const isSectionVerified = p.section_verification_status === 'verified';
                                                const progress = p.is_section_only
                                                  ? (p.has_section_content ? 100 : 0)
                                                  : (p.expected > 0 ? (p.entered / p.expected) * 100 : 0);
                                                const panelColor = p.is_section_only
                                                  ? (isSectionVerified
                                                      ? "border-green-200 bg-green-50"
                                                      : p.has_section_content
                                                        ? "border-amber-200 bg-amber-50"
                                                        : "border-gray-200 bg-white")
                                                  : (p.verified
                                                      ? "border-green-200 bg-green-50"
                                                      : p.entered > 0
                                                        ? "border-amber-200 bg-amber-50"
                                                        : "border-gray-200 bg-white");
                                                const statusText = p.is_section_only
                                                  ? (isSectionVerified ? "✓ Verified" : p.has_section_content ? "Saved" : "Pending")
                                                  : `${p.entered}/${p.expected}${progress === 100 ? " ✓" : ""}`;

                                                return (
                                                  <div
                                                    key={`${p.name}-${i}`}
                                                    className={`flex items-center gap-2 border rounded-lg px-3 py-1.5 shadow-sm transition-all duration-300 max-w-[170px] ${panelColor}`}
                                                  >
                                                    <SampleTypeIndicator
                                                      sampleType={p.sample_type || "Blood"}
                                                      sampleColor={o.color_code || undefined}
                                                      size="sm"
                                                    />
                                                    <div className="min-w-0">
                                                      <div className="font-bold text-gray-900 text-xs truncate" title={p.name}>{p.name}</div>
                                                      <div className="text-[10px] text-gray-500 font-medium">
                                                        {statusText}
                                                      </div>
                                                    </div>
                                                  </div>
                                                );
                                              })
                                              : visibleFallbackTests.map((t, i) => (
                                                  <span key={i} className="px-2 py-0.5 rounded text-xs bg-blue-100 text-blue-800">
                                                    {t.test_name}
                                                  </span>
                                                ))}
                                            {o.panels.length > 0 && hiddenPanelCount > 0 && (
                                              <span className="px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-700 border border-gray-200">
                                                +{hiddenPanelCount} more
                                              </span>
                                            )}
                                            {o.panels.length === 0 && hiddenFallbackTestCount > 0 && (
                                              <span className="px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-700 border border-gray-200">
                                                +{hiddenFallbackTestCount} more
                                              </span>
                                            )}
                                          </div>
                                        </>
                                      );
                                    })()}
                                  </div>
                                </div>

                                <div className="text-right shrink-0">
                                  <div className="flex items-center justify-end gap-2 text-sm text-gray-600">
                                    <span>Ordered: {new Date(o.order_date).toLocaleDateString()}</span>
                                    {(() => {
                                      // If TAT hasn't started yet (no sample received), show message instead of time
                                      if (!o.tatStarted) {
                                        return (
                                          <span className="text-amber-600 font-medium text-xs">
                                            ⏳ TAT starts after collection
                                          </span>
                                        );
                                      }

                                      const completedStatuses = ['Report Ready', 'Completed', 'Delivered'];
                                      const isCompleted = completedStatuses.includes(o.status) ||
                                        (o.expectedTotal > 0 && o.approvedAnalytes >= o.expectedTotal);

                                      // If no valid expected date (no tat_hours configured), show collection time
                                      if (!o.expected_date || isNaN(new Date(o.expected_date).getTime())) {
                                        return o.sample_collected_at ? (
                                          <span className="text-xs text-green-700">
                                            Collected: {new Date(o.sample_collected_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                                          </span>
                                        ) : null;
                                      }

                                      const now = new Date();
                                      const exp = new Date(o.expected_date);
                                      const isStartOfDay = (exp.getHours() === 0 && exp.getMinutes() === 0) ||
                                        (exp.getHours() === 5 && exp.getMinutes() === 30);

                                      const cutoff = new Date(exp);
                                      if (isStartOfDay) {
                                        cutoff.setHours(23, 59, 59, 999);
                                      }

                                      const isOverdue = !isCompleted && cutoff < now;
                                      const showTime = !isStartOfDay;

                                      return (
                                        <span className={isOverdue ? "text-red-600 font-semibold" : ""}>
                                          Exp: {exp.toLocaleDateString()}
                                          {showTime && " " + exp.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                                          {isOverdue && " ⚠️"}
                                        </span>
                                      );
                                    })()}
                                  </div>
                                </div>
                              </div>

                              {/* Additional Info */}
                              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 px-3 text-sm text-gray-600">
                                {o.collected_by && (
                                  <div className="flex items-center gap-1">
                                    <span className="font-medium text-gray-700">Collected by:</span>
                                    <span className="font-semibold">{o.collected_by}</span>
                                  </div>
                                )}
                                {o.sample_collected_at && (
                                  <div className="flex items-center gap-1">
                                    <span className="font-medium text-gray-700">Collection Time:</span>
                                    <span className="font-semibold">{new Date(o.sample_collected_at).toLocaleString()}</span>
                                  </div>
                                )}
                              </div>

                              {/* Actions */}
                              <div className="mt-3 grid grid-cols-2 sm:flex gap-2 justify-end px-3 py-2 bg-gray-50 rounded-lg border-t-2 border-blue-200">
                                {!o.sample_collected_at && (
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleOpenCollectionModal(o);
                                    }}
                                    className="inline-flex items-center justify-center px-3 py-1.5 text-sm font-medium bg-amber-500 text-white rounded-lg hover:bg-amber-600 transition-colors shadow-sm"
                                    title="Mark Sample Collected"
                                  >
                                    <TestTube className="h-4 w-4 mr-1.5" />
                                    Collect
                                  </button>
                                )}

                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    openDetails(o);
                                  }}
                                  className="inline-flex items-center justify-center px-3 py-1.5 text-sm font-medium bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors"
                                >
                                  <Eye className="h-4 w-4 mr-1.5" />
                                  View
                                </button>

                                <button
                                  onClick={async (e) => {
                                    e.stopPropagation();
                                    await handlePrintBarcodeLabel(o);
                                  }}
                                  disabled={printingLabelId === o.id}
                                  className="inline-flex items-center justify-center px-3 py-1.5 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-blue-300 disabled:cursor-not-allowed transition-colors"
                                  title="Print barcode label"
                                >
                                  {printingLabelId === o.id ? "..." : <Printer className="h-4 w-4 mr-1.5" />}
                                  Label
                                </button>

                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleInformDoctor(o);
                                  }}
                                  disabled={!o.doctor_phone}
                                  className={`inline-flex items-center justify-center px-3 py-1.5 text-sm font-medium rounded-lg text-white transition-colors ${o.doctor_phone ? "bg-green-600 hover:bg-green-700" : "bg-gray-300 cursor-not-allowed"}`}
                                  title={o.doctor_phone ? `Inform ${o.doctor || ""} ` : "Doctor phone not available"}
                                >
                                  <MessageCircle className="h-4 w-4 mr-1.5" />
                                  Inform Dr.
                                </button>

                                {o.report_url && (
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      window.open(o.report_url!, "_blank");
                                    }}
                                    className="inline-flex items-center justify-center px-3 py-1.5 text-sm font-medium rounded-lg text-white bg-emerald-600 hover:bg-emerald-700 transition-colors"
                                    title="Download Report PDF"
                                  >
                                    <Download className="h-4 w-4 mr-1.5" />
                                    Download
                                  </button>
                                )}

                                {o.report_url && (
                                  <button
                                    onClick={async (e) => {
                                      e.stopPropagation();
                                      await handlePrintReport(o);
                                    }}
                                    disabled={printingReportId === o.id}
                                    className="inline-flex items-center justify-center px-2 py-1.5 text-sm font-medium rounded-lg text-white bg-emerald-700 hover:bg-emerald-800 disabled:bg-emerald-300 disabled:cursor-not-allowed transition-colors"
                                    title={o.report_print_url ? "Queue report for LIMS Utility" : "Queue report PDF for LIMS Utility"}
                                  >
                                    {printingReportId === o.id ? "..." : <Printer className="h-4 w-4" />}
                                  </button>
                                )}

                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleSendReport(o, "whatsapp");
                                  }}
                                  disabled={!o.report_url || !!isSendingReport}
                                  className={`hidden sm:inline-flex items-center px-3 py-1.5 text-sm font-medium rounded-lg text-white transition-colors ${o.report_url ? "bg-green-600 hover:bg-green-700" : "bg-gray-300 cursor-not-allowed"}`}
                                  title={o.report_url ? "Send Report via WhatsApp" : "Report not generated yet"}
                                >
                                  <Send className="h-4 w-4 mr-1.5" />
                                  {isSendingReport === o.id ? "..." : "WhatsApp"}
                                </button>

                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleSendReport(o, "email");
                                  }}
                                  disabled={!o.report_url || !!isSendingReport}
                                  className={`hidden sm:inline-flex items-center px-3 py-1.5 text-sm font-medium rounded-lg text-white transition-colors ${o.report_url ? "bg-blue-500 hover:bg-blue-600" : "bg-gray-300 cursor-not-allowed"}`}
                                  title={o.report_url ? "Send Report via Email" : "Report not generated yet"}
                                >
                                  <Mail className="h-4 w-4 mr-1.5" />
                                  Email
                                </button>

                                {o.billing_status === "billed" && (
                                  <>
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handlePrintInvoice(o);
                                      }}
                                      className="inline-flex items-center justify-center px-3 py-1.5 text-sm font-medium rounded-lg text-white bg-indigo-600 hover:bg-indigo-700 transition-colors"
                                      title="Print Invoice"
                                    >
                                      <Printer className="h-4 w-4 mr-1.5" />
                                      Print
                                    </button>
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleSendInvoice(o);
                                      }}
                                      disabled={!!isSendingInvoice}
                                      className="inline-flex items-center justify-center px-3 py-1.5 text-sm font-medium rounded-lg text-white bg-purple-600 hover:bg-purple-700 transition-colors"
                                      title="Generate & Send Invoice via WhatsApp"
                                    >
                                      <Receipt className="h-4 w-4 mr-1.5" />
                                      {isSendingInvoice === o.id ? "..." : "Invoice"}
                                    </button>
                                  </>
                                )}



                                {o.billing_status !== "billed" && (
                                  <>
                                    {o.account_billing_mode === 'monthly' ? (
                                      <div className="inline-flex items-center px-3 py-1.5 text-sm font-medium bg-gray-100 text-gray-600 rounded-lg border border-gray-200 cursor-help" title="To be billed in monthly consolidation">
                                        <Briefcase className="h-4 w-4 mr-1.5" />
                                        Monthly Account
                                      </div>
                                    ) : (
                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          handleCreateInvoice(o.id);
                                        }}
                                        className="inline-flex items-center px-3 py-1.5 text-sm font-medium bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
                                      >
                                        <DollarSign className="h-4 w-4 mr-1.5" />
                                        Invoice
                                      </button>
                                    )}
                                  </>
                                )}

                                {/* Always show Pay button - will prompt to create invoice if needed */}
                                {(o.due_amount || 0) > 0 && o.account_billing_mode !== 'monthly' && (
                                  <button
                                    onClick={async (e) => {
                                      e.stopPropagation();
                                      await handleRecordPayment(o.id);
                                    }}
                                    className={`inline-flex items-center px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
                                      o.billing_status === 'billed' || o.billing_status === 'partial'
                                        ? 'bg-purple-600 text-white hover:bg-purple-700'
                                        : 'bg-purple-100 text-purple-700 hover:bg-purple-200 border border-purple-300'
                                    }`}
                                    title={o.billing_status !== 'billed' && o.billing_status !== 'partial' ? 'Will create invoice first' : 'Record payment'}
                                  >
                                    <CreditCard className="h-4 w-4 mr-1.5" />
                                    Pay
                                  </button>
                                )}

                                {/* Delete Order (Admin Only) - Hide if billed */}
                                {['admin', 'administrator', 'super admin', 'lab_manager', 'owner', 'manager'].some(r => String(user?.user_metadata?.role || '').toLowerCase().includes(r)) && !o.is_billed && o.billing_status !== 'billed' && (
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleDeleteOrder(o.id);
                                    }}
                                    className="inline-flex items-center px-3 py-1.5 text-sm font-medium bg-red-100 text-red-700 rounded-lg hover:bg-red-200 transition-colors border border-red-200"
                                    title="Delete Order"
                                  >
                                    <Trash2 className="h-4 w-4 mr-1.5" />
                                    Delete
                                  </button>
                                )}
                              </div>

                              {/* Progress */}
                              <div className="mt-3 bg-gradient-to-r from-blue-50 to-indigo-50 rounded-lg p-3 border border-blue-200">
                                <div className="flex items-center justify-between text-xs mb-1">
                                  <span className="text-blue-800 font-medium flex items-center">📊 Overall Progress</span>
                                  <span className="text-blue-800 font-bold">
                                    {o.enteredTotal}/{o.expectedTotal} analytes
                                  </span>
                                </div>

                                <div className="relative w-full bg-gray-200 rounded-full h-2.5 overflow-hidden border">
                                  <div
                                    className="absolute left-0 top-0 h-2.5 transition-all duration-700 rounded-full"
                                    style={{
                                      width: `${pct}% `,
                                      background:
                                        pct === 0
                                          ? "#ef4444"
                                          : pct < 25
                                            ? "linear-gradient(90deg, #ef4444 0%, #f97316 100%)"
                                            : pct < 50
                                              ? "linear-gradient(90deg, #f97316 0%, #eab308 100%)"
                                              : pct < 75
                                                ? "linear-gradient(90deg, #eab308 0%, #84cc16 100%)"
                                                : pct < 100
                                                  ? "linear-gradient(90deg, #84cc16 0%, #22c55e 100%)"
                                                  : "#10b981",
                                      boxShadow: pct > 0 ? `0 0 12px ${pct < 50 ? "#ef444440" : "#22c55e40"} ` : "none",
                                    }}
                                  />

                                  <div
                                    className="absolute left-0 top-0 h-4 bg-green-600 transition-all duration-500 rounded-full opacity-80"
                                    style={{ width: `${o.expectedTotal > 0 ? (o.approvedAnalytes / o.expectedTotal) * 100 : 0}% ` }}
                                  />

                                  <div className="absolute top-0 w-0.5 h-4 bg-white shadow-lg" style={{ left: `${pct}% ` }} />

                                  {pct > 75 && (
                                    <div className="absolute inset-0 rounded-full opacity-30">
                                      <div className="absolute top-1 left-1/4 w-1 h-1 bg-white rounded-full animate-pulse" />
                                      <div className="absolute top-2 right-1/3 w-0.5 h-0.5 bg-white rounded-full animate-pulse delay-150" />
                                      <div className="absolute bottom-1 left-2/3 w-1 h-1 bg-white rounded-full animate-pulse delay-300" />
                                    </div>
                                  )}
                                </div>

                                <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 text-xs mt-1">
                                  <div className="inline-flex items-center bg-white rounded px-1.5 py-0.5 border border-gray-200">
                                    <span className="inline-block w-2 h-2 bg-red-400 rounded-full mr-1" />
                                    <span className="text-gray-600">
                                      Pending: <strong>{o.pendingAnalytes}</strong>
                                    </span>
                                  </div>
                                  <div className="inline-flex items-center bg-white rounded px-1.5 py-0.5 border border-amber-200">
                                    <span className="inline-block w-2 h-2 bg-amber-500 rounded-full mr-1" />
                                    <span className="text-amber-700">
                                      Approval: <strong>{o.forApprovalAnalytes}</strong>
                                    </span>
                                  </div>
                                  <div className="inline-flex items-center bg-white rounded px-1.5 py-0.5 border border-green-200">
                                    <span className="inline-block w-2 h-2 bg-green-500 rounded-full mr-1" />
                                    <span className="text-green-700">
                                      Approved: <strong>{o.approvedAnalytes}</strong>
                                    </span>
                                  </div>
                                  <div className="hidden sm:inline-flex items-center bg-white rounded px-1.5 py-0.5 border border-blue-200 justify-end">
                                    <span
                                      className={`font - bold text - xs ${pct < 25 ? "text-red-600" : pct < 50 ? "text-orange-600" : pct < 75 ? "text-yellow-600" : pct < 100 ? "text-lime-600" : "text-green-600"
                                        } `}
                                    >
                                      {pct < 25 ? "🔴" : pct < 50 ? "🟠" : pct < 75 ? "🟡" : pct < 100 ? "🟢" : "✅"} Total: {o.expectedTotal}
                                    </span>
                                  </div>
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )
        }
      </div>

      {/* Footer stats */}
      <div className="bg-gradient-to-r from-blue-50 to-purple-50 rounded-lg p-4 border border-blue-200">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-sm">
          <div className="flex items-center gap-6">
            <div className="flex items-center">
              <Calendar className="h-4 w-4 text-blue-600 mr-1" />
              <span className="text-blue-900 font-medium">
                Total Orders: {orders.length}
                {!allDates && (
                  <span className="text-blue-700 ml-1">
                    ({new Date(dateFrom).toLocaleDateString()} - {new Date(dateTo).toLocaleDateString()})
                  </span>
                )}
                {allDates && <span className="text-blue-700 ml-1">(All Dates)</span>}
              </span>
            </div>
            <div className="flex items-center">
              <AlertTriangle className="h-4 w-4 text-red-600 mr-1" />
              <span className="text-red-900 font-medium">Overdue: {orders.filter((o) => {
                const done = ['Report Ready', 'Completed', 'Delivered'].includes(o.status) ||
                  (o.expectedTotal > 0 && o.approvedAnalytes >= o.expectedTotal);
                return !done && o.tatStarted && new Date(o.expected_date) < new Date();
              }).length}</span>
            </div>
          </div>

          <div className="flex items-center">
            <TrendingUp className="h-4 w-4 text-purple-600 mr-1" />
            <span className="text-purple-900 font-medium">
              Avg TAT:{" "}
              {orders.length
                ? Math.round(
                  orders.reduce((sum, o) => {
                    const diffHrs = (Date.now() - new Date(o.order_date).getTime()) / 36e5;
                    return sum + diffHrs;
                  }, 0) / orders.length
                )
                : 0}
              h
            </span>
          </div>
        </div>
      </div>

      {/* Modals */}
      {
        showOrderForm && (
          <OrderForm
            initialBookingData={processingBooking}
            onClose={() => {
              setProcessingBooking(null);
              setShowOrderForm(false);
              fetchOrders();
            }}
            onSubmit={handleAddOrder}
            onOrderCreated={autoOpenCollectModal ? (orderId) => {
              console.debug('[AutoCollect] onOrderCreated fired, orderId:', orderId, '| autoOpenCollectModal:', autoOpenCollectModal);
              setPendingAutoCollectOrderId(orderId);
              console.debug('[AutoCollect] pending collection order set; final form close will refresh dashboard');
            } : undefined}
          />
        )
      }

      {
        selectedOrder && (
          <DashboardOrderModal
            order={selectedOrder}
            onClose={() => setSelectedOrder(null)}
            onUpdateStatus={async (orderId: string, newStatus: string) => {
              try {
                const { error } = await database.orders.update(orderId, {
                  status: newStatus,
                  status_updated_at: new Date().toISOString(),
                  status_updated_by: user?.email || "Unknown",
                });
                if (error) {
                  console.error("Error updating order status:", error);
                  return;
                }
                await fetchOrders();
                setSelectedOrder(null);
              } catch (error) {
                console.error("Error updating order status:", error);
              }
            }}
          />
        )
      }

      {
        showInvoiceModal && invoiceOrderId && (
          <CreateInvoiceModal
            orderId={invoiceOrderId}
            onClose={() => {
              setShowInvoiceModal(false);
              setInvoiceOrderId(null);
            }}
            onSuccess={() => {
              setShowInvoiceModal(false);
              setInvoiceOrderId(null);
              fetchOrders();
            }}
          />
        )
      }

      {
        showPaymentModal && paymentOrderId && (
          <PaymentCapture
            orderId={paymentOrderId}
            onClose={() => {
              setShowPaymentModal(false);
              setPaymentOrderId(null);
            }}
            onSuccess={() => {
              setShowPaymentModal(false);
              setPaymentOrderId(null);
              // Small delay to ensure DB propagation
              setTimeout(() => fetchOrders(), 500);
            }}
          />
        )
      }

      {
        showCollectionModal && collectionOrder && ReactDOM.createPortal(
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
            <div className="bg-white rounded-lg shadow-xl w-full max-w-md overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 bg-gray-50 border-b border-gray-100">
                <h3 className="font-semibold text-gray-900 flex items-center gap-2">
                  <TestTube className="h-5 w-5 text-blue-600" />
                  Collect Sample
                </h3>
                <button onClick={() => setShowCollectionModal(false)} className="text-gray-400 hover:text-gray-600">
                  <span className="sr-only">Close</span>
                  <X className="h-6 w-6" />
                </button>
              </div>

              <div className="p-4 space-y-4">
                <div className="bg-blue-50 p-3 rounded-lg border border-blue-100">
                  <div className="text-sm text-blue-900 font-medium">{collectionOrder.patient_name}</div>
                  <div className="text-xs text-blue-700 flex gap-2 mt-1">
                    <span>Order #{collectionOrder.id.slice(-6)}</span>
                    <span>•</span>
                    <span>{collectionOrder.sample_id || "Sample Tracking"}</span>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Collected By (Optional)</label>
                  {labId && (
                    <PhlebotomistSelector
                      labId={labId}
                      value={selectedPhlebotomistId}
                      onChange={(id, name) => {
                        setSelectedPhlebotomistId(id || "");
                        setSelectedPhlebotomistName(name);
                      }}
                    />
                  )}
                </div>

                <div className="max-h-[60vh] overflow-y-auto pr-1">
                  <SampleCollectionTracker
                    orderId={collectionOrder.id}
                    collectedById={selectedPhlebotomistId || undefined}
                    showFinishButton={false}
                    onSampleCollected={() => {
                      fetchOrders();
                    }}
                  />
                </div>

                <div className="flex justify-end gap-3 mt-4 pt-2 border-t border-gray-100">
                  <button onClick={() => setShowCollectionModal(false)} className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200">
                    Close
                  </button>
                  <button onClick={handleSaveCollection} className="px-4 py-2 text-sm font-medium text-white bg-primary-600 rounded-lg hover:bg-primary-700 shadow-sm">
                    Save & Finish
                  </button>
                </div>
              </div>
            </div>
          </div>,
          document.body
        )
      }

      {
        Math.max(window.innerWidth) < 768 && (
          <MobileFAB icon={Plus} onClick={() => setShowOrderForm(true)} label="Create Order" />
        )
      }
    </>
  );
};

export default Dashboard;
