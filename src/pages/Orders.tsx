// src/pages/Orders.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Clock as ClockIcon, CheckCircle, AlertTriangle,
  Eye, User, Calendar, TestTube, ChevronDown, ChevronUp, TrendingUp, ToggleLeft, ToggleRight, RefreshCcw, Activity, Building2, ArrowDownUp, ClipboardList, Printer
} from "lucide-react";
import { useAuth } from "../contexts/AuthContext";
import { database, supabase, formatAge } from "../utils/supabase";
import OrderForm from "../components/Orders/OrderForm";
import DailyChecklistModal from "../components/Orders/DailyChecklistModal";
import OrderDetailsModal from "../components/Orders/OrderDetailsModal";
import QuickResultEntryModal from "../components/Orders/QuickResultEntryModal";
import EnhancedOrdersPage from "../components/Orders/EnhancedOrdersPage";
import OrderFiltersBar, { OrderFilters } from "../components/Orders/OrderFiltersBar";
import { useRealtimeOrders } from "../hooks/useRealtimeOrders";
import { useAnalyzerRealtime } from "../hooks/useAnalyzerRealtime";
import { SampleTypeGroup } from "../components/Common/SampleTypeIndicator";
import { TATStatusBadge } from "../components/Orders/TATStatusBadge";
import { useMobileOptimizations } from "../utils/platformHelper";
import {
  generateWorksheetHTML,
  openWorksheetWindow,
  pendingPanels,
  WorksheetOrder,
} from "../utils/technicianWorksheet";

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
  hours_until_tat_breach?: number | null;
  is_tat_breached?: boolean;
  tat_hours?: number;
  tat_start_time?: string | null;
  // Section-only fields
  is_section_only?: boolean;
  has_section_content?: boolean;
  section_verification_status?: string | null;
  section_verified_at?: string | null;
};



type Panel = {
  name: string;
  expected: number;
  entered: number;     // from view (clamped later)
  verified: boolean;
  status: ProgressRow["panel_status"];
  isOutsourced?: boolean;
  outsourcedLab?: string;
  sample_type?: string;
  sample_color?: string;
  // TAT fields per panel
  hours_until_tat_breach?: number | null;
  is_tat_breached?: boolean;
  tat_hours?: number | null;
  // Section-only fields
  is_section_only?: boolean;
  has_section_content?: boolean;
  section_verification_status?: string | null;
};

type CardOrder = {
  id: string;
  lab_id: string;
  location_id?: string;
  patient_name: string;
  patient_id: string;
  status: OrderStatus;
  priority: Priority;
  order_date: string;
  expected_date: string;
  total_amount: number;
  final_amount?: number;
  doctor: string | null;
  account_id?: string | null;
  account_name?: string | null;
  account_billing_mode?: "standard" | "monthly" | null;

  order_number?: number | null;

  sample_id: string | null;
  sample_type?: string;
  color_code: string | null;
  color_name: string | null;
  sample_collected_at: string | null;
  sample_collected_by: string | null;

  patient?: { name?: string | null; age?: string | null; gender?: string | null } | null;
  samples?: { id: string; barcode: string | null; sample_type?: string | null; created_at?: string | null }[];
  tests: string[];
  order_tests?: any[]; // Full order_tests array with outsourcing details

  // derived
  panels: Panel[];
  expectedTotal: number;
  enteredTotal: number;

  // 3-bucket model
  pendingAnalytes: number;       // not started OR partial/in-progress
  forApprovalAnalytes: number;   // complete but not verified
  approvedAnalytes: number;      // verified

  // TAT aggregation
  hours_until_tat_breach?: number | null;
  is_tat_breached?: boolean | null;
  tat_hours?: number | null;
  tatStarted?: boolean;
};

type OrderBucketStatus = "All Done" | "Mostly Done" | "Pending" | "Approval";
type OrderSortMode = "sample_desc" | "sample_asc" | "date_desc" | "patient_az";

const ORDER_BUCKET_STATUSES: OrderBucketStatus[] = ["All Done", "Mostly Done", "Pending", "Approval"];

const formatOrderCreationError = (error: any) => {
  const message = String(error?.message || error || "Failed to create order");
  if (message.includes("unique_sample_id_per_lab")) {
    return "Sample ID conflict while creating the order. The system will try the next available ID; please submit again if this still appears.";
  }
  return message;
};

const hasMeaningfulProgressRows = (rows: ProgressRow[] | undefined) =>
  !!rows?.some((row) =>
    Number(row.expected_analytes || 0) > 0 ||
    Number(row.entered_analytes || 0) > 0 ||
    Number(row.total_values || 0) > 0 ||
    !!row.has_results ||
    row.is_section_only // Section-only tests always have meaningful progress
  );

const getOrderBucket = (o: CardOrder): OrderBucketStatus => {
  if (o.status === "Report Ready" || o.status === "Completed" || o.status === "Delivered" ||
      (o.expectedTotal > 0 && o.approvedAnalytes >= o.expectedTotal)) return "All Done";
  if (o.status === "Pending Approval") return "Approval";
  if (o.enteredTotal > 0 && o.enteredTotal >= o.expectedTotal * 0.75) return "Mostly Done";
  return "Pending";
};

/* ===========================
   Component
=========================== */

const Orders: React.FC = () => {
  const { user } = useAuth();
  const mobile = useMobileOptimizations();

  const [orders, setOrders] = useState<CardOrder[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [showOrderForm, setShowOrderForm] = useState(false);
  const [showDailyChecklist, setShowDailyChecklist] = useState(false);
  const [selectedOrder, setSelectedOrder] = useState<CardOrder | null>(null);
  const [openOnResults, setOpenOnResults] = useState(false);
  const [quickEntryOrder, setQuickEntryOrder] = useState<CardOrder | null>(null);
  const [viewMode, setViewMode] = useState<'standard' | 'enhanced'>('standard');
  const [orderSortMode, setOrderSortMode] = useState<OrderSortMode>("sample_desc");
  const [isRefreshingOrders, setIsRefreshingOrders] = useState(false);
  const progressRowsCacheRef = useRef<Map<string, ProgressRow[]>>(new Map());
  const ordersRefreshTimerRef = useRef<number | null>(null);

  // Filter state
  const [filters, setFilters] = useState<OrderFilters>({
    status: "All",
    priority: "All",
    from: new Date().toISOString().slice(0, 10), // Today's date
    to: new Date().toISOString().slice(0, 10)    // Today's date
  });

  const [locations, setLocations] = useState<{ id: string; name: string }[]>([]);
  const [accounts, setAccounts] = useState<{ id: string; name: string }[]>([]);

  // Load locations on mount
  useEffect(() => {
    const loadLocations = async () => {
      const userLocInfo = await database.shouldFilterByLocation();
      const { data: allLocations } = await database.locations.getAll();

      if (allLocations) {
        if (userLocInfo.canViewAll || !userLocInfo.shouldFilter) {
          setLocations(allLocations.map((l: any) => ({ id: l.id, name: l.name })));
        } else {
          setLocations(allLocations
            .filter((l: any) => userLocInfo.locationIds.includes(l.id))
            .map((l: any) => ({ id: l.id, name: l.name }))
          );
        }
      }
    };
    loadLocations();
  }, []);

  useEffect(() => {
    const loadAccounts = async () => {
      const { data, error } = await database.accounts.getAll();
      if (error) {
        console.error("accounts load error", error);
        return;
      }
      setAccounts((data || []).map((account: any) => ({ id: account.id, name: account.name })));
    };

    loadAccounts();
  }, []);

  // dashboard counters
  const [summary, setSummary] = useState({ allDone: 0, mostlyDone: 0, pending: 0, awaitingApproval: 0 });

  // RE-RUN requests tracking
  const [rerunRequests, setRerunRequests] = useState<{ order_id: string; count: number; analytes: string[] }[]>([]);
  const [totalRerunCount, setTotalRerunCount] = useState(0);

  // Create a map of order_id to rerun info for quick lookup
  const rerunByOrder = useMemo(() => {
    const map = new Map<string, { count: number; analytes: string[] }>();
    rerunRequests.forEach(r => map.set(r.order_id, { count: r.count, analytes: r.analytes }));
    return map;
  }, [rerunRequests]);

  const toggleStatusFilter = (status: NonNullable<OrderFilters["status"]>) => {
    setFilters(f => ({ ...f, status: f.status === status ? "All" : status }));
  };

  // Fetch RE-RUN requests
  const fetchRerunRequests = async () => {
    const lab_id = await database.getCurrentUserLabId();
    if (!lab_id) return;

    // Fetch result_values with RE-RUN in verify_note, pending status
    const { data, error } = await supabase
      .from('result_values')
      .select(`
        id,
        analyte_name,
        verify_note,
        results!inner (
          id,
          order_id,
          orders!inner (
            id,
            lab_id,
            status
          )
        )
      `)
      .eq('verify_status', 'pending')
      .ilike('verify_note', '%RE-RUN%')
      .eq('results.orders.lab_id', lab_id)
      .neq('results.orders.status', 'Completed')
      .neq('results.orders.status', 'Delivered');

    if (error) {
      console.error('Error fetching re-run requests:', error);
      return;
    }

    // Group by order_id
    const byOrder = new Map<string, { count: number; analytes: string[] }>();
    (data || []).forEach((rv: any) => {
      const orderId = rv.results?.order_id;
      if (orderId) {
        const existing = byOrder.get(orderId) || { count: 0, analytes: [] };
        existing.count++;
        if (rv.analyte_name && !existing.analytes.includes(rv.analyte_name)) {
          existing.analytes.push(rv.analyte_name);
        }
        byOrder.set(orderId, existing);
      }
    });

    const requests = Array.from(byOrder.entries()).map(([order_id, info]) => ({
      order_id,
      count: info.count,
      analytes: info.analytes
    }));

    setRerunRequests(requests);
    setTotalRerunCount(data?.length || 0);
  };

  useEffect(() => {
    fetchOrders();
    fetchRerunRequests();
  }, []);

  // Get user's lab_id for realtime filtering
  const [userLabId, setUserLabId] = useState<string>('');

  useEffect(() => {
    const getLabId = async () => {
      const labId = await database.getCurrentUserLabId();
      if (labId) {
        setUserLabId(labId);
      }
    };
    getLabId();
  }, []);

  // 🔬 ANALYZER REALTIME: Track LIS result arrivals per order
  const analyzerActivity = useAnalyzerRealtime(userLabId);

  // Trailing-edge refresh for realtime bursts. The list load is four queries
  // over every order in the lab, so it must run once per burst, not once per
  // changed row.
  const scheduleOrdersRefresh = () => {
    if (ordersRefreshTimerRef.current !== null) {
      window.clearTimeout(ordersRefreshTimerRef.current);
    }
    ordersRefreshTimerRef.current = window.setTimeout(() => {
      ordersRefreshTimerRef.current = null;
      fetchOrders();
    }, 1200);
  };

  useEffect(() => () => {
    if (ordersRefreshTimerRef.current !== null) {
      window.clearTimeout(ordersRefreshTimerRef.current);
    }
  }, []);

  // 🔴 REALTIME: Subscribe to order changes
  const { isConnected: realtimeConnected } = useRealtimeOrders({
    labId: userLabId,
    enabled: !!userLabId, // Only enable when we have lab_id
    onInsert: async (newOrder) => {

      // Fetch full order data with relations
      const { data: fullOrderData } = await supabase
        .from("orders")
        .select(`
          id, lab_id, patient_id, patient_name, status, priority, order_date, expected_date, total_amount, final_amount, doctor, account_id,
          order_number, sample_id, color_code, color_name, sample_collected_at, sample_collected_by,
          accounts(name, billing_mode),
          patients(name, age, gender),
          order_tests(id, test_group_id, test_name, outsourced_lab_id, outsourced_labs(name))
        `)
        .eq('id', newOrder.id)
        .single();

      if (fullOrderData) {
        // Transform to CardOrder format (simplified - no progress data yet)
        const orderRow = fullOrderData as any;
        const panels: Panel[] = []; // Will be populated on next refresh

        const newCardOrder: CardOrder = {
          id: orderRow.id,
          lab_id: orderRow.lab_id,
          patient_name: orderRow.patient_name,
          patient_id: orderRow.patient_id,
          status: orderRow.status,
          priority: orderRow.priority,
          order_date: orderRow.order_date,
          expected_date: orderRow.expected_date,
          total_amount: orderRow.total_amount,
          final_amount: orderRow.final_amount || orderRow.total_amount,
          doctor: orderRow.doctor,
          account_id: orderRow.account_id,
          account_name: orderRow.accounts?.name || null,
          account_billing_mode: orderRow.accounts?.billing_mode || null,
          order_number: orderRow.order_number ?? null,
          sample_id: orderRow.sample_id,
          color_code: orderRow.color_code,
          color_name: orderRow.color_name,
          sample_collected_at: orderRow.sample_collected_at,
          sample_collected_by: orderRow.sample_collected_by,
          patient: orderRow.patients,
          tests: (orderRow.order_tests || []).map((t: any) => t.test_name),
          order_tests: orderRow.order_tests || [],
          panels,
          expectedTotal: 0,
          enteredTotal: 0,
          pendingAnalytes: 0,
          forApprovalAnalytes: 0,
          approvedAnalytes: 0,
        };

        setOrders(prev => [newCardOrder, ...prev]);
      }
    },
    onUpdate: (updatedOrder) => {
      // Saving results touches an order several times in quick succession, and
      // each event used to trigger the full four-query list load. Coalesce the
      // burst into one refresh once the writes settle.
      scheduleOrdersRefresh();
    },
    onDelete: (deletedOrderId) => {
      setOrders(prev => prev.filter(order => order.id !== deletedOrderId));
    }
  });

  // Update selected order when orders change (for modal refresh after status update)
  useEffect(() => {
    if (selectedOrder) {
      const updatedOrder = orders.find(order => order.id === selectedOrder.id);
      if (updatedOrder && (
        updatedOrder.status !== selectedOrder.status ||
        updatedOrder.sample_collected_at !== selectedOrder.sample_collected_at ||
        updatedOrder.sample_collected_by !== selectedOrder.sample_collected_by ||
        updatedOrder.tests.length !== selectedOrder.tests.length ||
        (updatedOrder.order_tests?.length || 0) !== (selectedOrder.order_tests?.length || 0)
      )) {
        console.log(`Updating modal order data: ${selectedOrder.status} → ${updatedOrder.status}`);
        console.log(`Sample collection: ${selectedOrder.sample_collected_at} → ${updatedOrder.sample_collected_at}`);
        setSelectedOrder(updatedOrder);
      }
    }
  }, [orders, selectedOrder]);

  // Read daily sequence (prefer order_number; fallback to tail of sample_id)
  const getDailySeq = (o: CardOrder) => {
    if (typeof o.order_number === "number" && !Number.isNaN(o.order_number)) return o.order_number;
    const tail = String(o.sample_id || "").match(/(?:^|[/-])(\d+)\s*$/)?.[1] || "";
    const n = parseInt(tail, 10);
    return Number.isFinite(n) ? n : 0;
  };

  const compareOrders = (a: CardOrder, b: CardOrder) => {
    if (orderSortMode === "patient_az") {
      return (a.patient?.name || a.patient_name).localeCompare(b.patient?.name || b.patient_name);
    }

    if (orderSortMode === "date_desc") {
      const dateDiff = new Date(b.order_date).getTime() - new Date(a.order_date).getTime();
      if (dateDiff !== 0) return dateDiff;
    }

    const nA = getDailySeq(a);
    const nB = getDailySeq(b);
    if (nA !== nB) {
      return orderSortMode === "sample_asc" ? nA - nB : nB - nA;
    }

    return new Date(b.order_date).getTime() - new Date(a.order_date).getTime();
  };

  const fetchOrders = async () => {
    // A direct refresh satisfies any burst still waiting on the debounce.
    if (ordersRefreshTimerRef.current !== null) {
      window.clearTimeout(ordersRefreshTimerRef.current);
      ordersRefreshTimerRef.current = null;
    }
    setIsRefreshingOrders(true);
    // Get current user's lab_id
    try {
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) {
        console.error('No lab_id found for current user');
        return;
      }

      // 1) base orders
      let query = supabase
        .from("orders")
        .select(`
        id, lab_id, location_id, patient_id, patient_name, status, priority, order_date, expected_date, total_amount, final_amount, doctor, account_id,
        order_number, sample_id, color_code, color_name, sample_collected_at, sample_collected_by,
        accounts(name, billing_mode),
        patients(name, age, gender),
        samples(id, barcode, sample_type, created_at),
        order_tests(
          id, test_group_id, test_name, outsourced_lab_id,
          outsourced_labs(name),
          test_groups(sample_type, sample_color)
        )
      `)
        .eq('lab_id', lab_id)
        .order("order_date", { ascending: false });

      // Apply location filtering
      const { shouldFilter, locationIds } = await database.shouldFilterByLocation();
      if (shouldFilter && locationIds.length > 0) {
        query = query.in('location_id', locationIds);
      }

      const { data: rows, error } = await query;

      if (error) {
        console.error("orders load error", error);
        return;
      }

      const orderRows = (rows || []) as any[]; // Use any temporarily to solve complex relation casting
      const orderIds = orderRows.map((o) => o.id);
      if (orderIds.length === 0) {
        setOrders([]);
        setSummary({ allDone: 0, mostlyDone: 0, pending: 0, awaitingApproval: 0 });
        return;
      }

    // 2) view-based progress (Using ENHANCED view for TAT)
    // Only the columns the cards actually read. select=* on this view carried
    // ~40 columns per panel row and dominated the payload of every refresh.
    const { data: prog, error: pErr } = await supabase
      .from("v_order_test_progress_enhanced")
      .select(
        "order_id, test_group_id, test_group_name, expected_analytes, entered_analytes, " +
        "is_verified, panel_status, sample_type, sample_color, " +
        "tat_hours, tat_start_time, hours_until_tat_breach, is_tat_breached, " +
        "is_section_only, has_section_content, section_verification_status"
      )
      .in("order_id", orderIds);

    if (pErr) console.error("progress view error", pErr);

	    const byOrder = new Map<string, ProgressRow[]>();
	    (prog || []).forEach((r) => {
	      const arr = byOrder.get(r.order_id) || [];
	      arr.push(r as ProgressRow);
	      byOrder.set(r.order_id, arr);
	    });

	    for (const orderId of orderIds) {
	      const freshRows = byOrder.get(orderId) || [];
	      if (hasMeaningfulProgressRows(freshRows)) {
	        progressRowsCacheRef.current.set(orderId, freshRows);
	        continue;
	      }

	      const cachedRows = progressRowsCacheRef.current.get(orderId);
	      if (hasMeaningfulProgressRows(cachedRows)) {
	        byOrder.set(orderId, cachedRows!);
	      }
	    }

    // 3) invoice aggregation — single batched query instead of one per order
    const { data: allInvoices } = await supabase
      .from("invoices")
      .select("order_id, total_after_discount, total, subtotal")
      .in("order_id", orderIds);

    const invoiceMap = new Map<string, { orderId: string; totalInvoiced: number }>();
    for (const inv of allInvoices || []) {
      const existing = invoiceMap.get(inv.order_id) || { orderId: inv.order_id, totalInvoiced: 0 };
      existing.totalInvoiced += Number(inv.total_after_discount || inv.total || inv.subtotal || 0);
      invoiceMap.set(inv.order_id, existing);
    }

    // 4) shape cards with new buckets
    const cards: CardOrder[] = orderRows.map((o) => {
      const rows = byOrder.get(o.id) || [];
      const invoiceInfo = invoiceMap.get(o.id);
      const orderAmount = o.final_amount || o.total_amount || 0;
      const effectiveDisplayAmount = invoiceInfo?.totalInvoiced
        ? Math.max(invoiceInfo.totalInvoiced, orderAmount)
        : orderAmount;

      // Calculate dynamic expected date based on TAT (only when sample has been received)
      let calculatedExpectedDateMs = 0;
      let hasTatStartTime = false;
      rows.forEach((r) => {
        if (r.tat_hours && r.tat_start_time) {
          hasTatStartTime = true;
          const start = new Date(r.tat_start_time).getTime();
          const duration = Number(r.tat_hours) * 3600 * 1000;
          const end = start + duration;
          if (end > calculatedExpectedDateMs) {
            calculatedExpectedDateMs = end;
          }
        }
      });

      // TAT only starts after sample receipt — no fallback calculation before that
      const dynamicExpectedDate = calculatedExpectedDateMs > 0
        ? new Date(calculatedExpectedDateMs).toISOString()
        : o.expected_date;
      // TAT is considered started if the view has a tat_start_time (sample collected + tat_hours set),
      // OR if the sample was collected at all (even if no tat_hours configured for any test)
      const tatStarted = hasTatStartTime || !!o.sample_collected_at;
      const panels: Panel[] = rows.map((r) => {
        // Check if this test group is outsourced
        const outsourcedTest = (o.order_tests || []).find((t: any) => t.test_group_id === r.test_group_id);
        const labInfo = Array.isArray(outsourcedTest?.outsourced_labs)
          ? outsourcedTest.outsourced_labs[0]
          : outsourcedTest?.outsourced_labs;

        // Get sample info from joined test_groups if not in view
        const testGroupInfo = (outsourcedTest as any)?.test_groups;
        const effectiveSampleType = r.sample_type || testGroupInfo?.sample_type;
        const effectiveSampleColor = r.sample_color || testGroupInfo?.sample_color;

        return {
          name: r.test_group_name || "Test",
          expected: r.expected_analytes || 0,
          entered: r.entered_analytes || 0,
          verified: !!r.is_verified,
          status: r.panel_status,
          isOutsourced: !!outsourcedTest?.outsourced_lab_id,
          outsourcedLab: labInfo?.name,
          sample_type: effectiveSampleType,
          sample_color: effectiveSampleColor,
          // TAT fields per panel
          hours_until_tat_breach: r.hours_until_tat_breach,
          is_tat_breached: r.is_tat_breached,
          tat_hours: r.tat_hours,
          // Section-only fields
          is_section_only: r.is_section_only,
          has_section_content: r.has_section_content,
          section_verification_status: r.section_verification_status,
        };
      });

      // Calculate TAT aggregates (worst case: min hours remaining)
      let minHours: number | null = null;
      let isBreached = false;
      let maxTatHours: number | null = null;

      rows.forEach(r => {
        if (r.hours_until_tat_breach !== undefined && r.hours_until_tat_breach !== null) {
          if (minHours === null || r.hours_until_tat_breach < minHours) {
            minHours = r.hours_until_tat_breach;
          }
        }
        if (r.is_tat_breached) isBreached = true;
        if (r.tat_hours && (maxTatHours === null || r.tat_hours > maxTatHours)) {
          maxTatHours = r.tat_hours;
        }
      });


      // Calculate totals correctly
      const expectedTotal = panels.reduce((sum, p) => sum + p.expected, 0);
      const enteredTotal = panels.reduce((sum, p) => sum + Math.min(p.entered, p.expected), 0);

      // ✅ Fix: Calculate approved analytes correctly
      // Only count analytes from verified panels, not entire expected total
      const approvedAnalytes = panels.reduce((sum, p) => {
        if (p.verified || p.status === "Verified") {
          return sum + Math.min(p.entered, p.expected); // Only count entered analytes that are verified
        }
        return sum;
      }, 0);

      // ✅ Fix: Calculate pending and for-approval correctly
      const pendingAnalytes = Math.max(expectedTotal - enteredTotal, 0); // Not entered yet
      const forApprovalAnalytes = Math.max(enteredTotal - approvedAnalytes, 0); // Entered but not verified

      // Debug logging for verification (can be removed later)
      if (o.id && expectedTotal > 0) {
        console.debug(`Order ${o.id.slice(-6)}: Expected = ${expectedTotal}, Entered = ${enteredTotal}, Approved = ${approvedAnalytes}, Pending = ${pendingAnalytes}, ForApproval = ${forApprovalAnalytes} `);
      }

      return {
        id: o.id,
        lab_id: o.lab_id,
        location_id: o.location_id,
        patient_name: o.patient_name,
        patient_id: o.patient_id,
        status: o.status,
        priority: o.priority,
        order_date: o.order_date,
        expected_date: dynamicExpectedDate,
        total_amount: o.total_amount,
        final_amount: effectiveDisplayAmount,
        doctor: o.doctor,
        account_id: o.account_id,
        account_name: o.accounts?.name || null,
        account_billing_mode: o.accounts?.billing_mode || null,

        order_number: o.order_number ?? null,
        sample_id: o.sample_id,
        color_code: o.color_code,
        color_name: o.color_name,
        sample_collected_at: o.sample_collected_at,
        sample_collected_by: o.sample_collected_by,

        patient: o.patients,
        samples: [...(o.samples || [])].sort((a: any, b: any) =>
          String(a.created_at || '').localeCompare(String(b.created_at || '')) ||
          String(a.barcode || '').localeCompare(String(b.barcode || ''))
        ),
        tests: (o.order_tests || []).map((t: any) => t.test_name),
        order_tests: o.order_tests || [], // ✅ Include full order_tests with outsourcing data

        panels,
        expectedTotal,
        enteredTotal,
        pendingAnalytes,
        forApprovalAnalytes,
        approvedAnalytes,

        hours_until_tat_breach: minHours,
        is_tat_breached: isBreached,
        tat_hours: maxTatHours,
        tatStarted
      };
    });

    // sort: date DESC, then daily seq DESC (002 above 001)
    const sorted = cards.sort((a, b) => {
      const dA = new Date(a.order_date).setHours(0, 0, 0, 0);
      const dB = new Date(b.order_date).setHours(0, 0, 0, 0);
      if (dA !== dB) return dB - dA;
      const nA = getDailySeq(a);
      const nB = getDailySeq(b);
      return nB - nA;
    });

	    // dashboard summary (kept)
	    const s = sorted.reduce(
	      (acc, o) => {
	        const bucket = getOrderBucket(o);
	        if (bucket === "All Done") acc.allDone++;
	        else if (bucket === "Approval") acc.awaitingApproval++;
	        else if (bucket === "Mostly Done") acc.mostlyDone++;
	        else acc.pending++;
	        return acc;
	      },
	      { allDone: 0, mostlyDone: 0, pending: 0, awaitingApproval: 0 }
    );

      setOrders(sorted);
      setSummary(s);
    } finally {
      setIsRefreshingOrders(false);
    }
  };

  const refreshOrdersData = async () => {
    await Promise.all([fetchOrders(), fetchRerunRequests()]);
  };

  /* ------------- filtering + grouping ------------- */
  const filtered = useMemo(() => {
    const q = (filters.q || "").toLowerCase();
    return orders.filter((o) => {
      // Search filter
      const matchesQ = !filters.q ||
        o.patient_name.toLowerCase().includes(q) ||
        (o.patient_id || "").toLowerCase().includes(q) ||
        (o.id || "").toLowerCase().includes(q) ||
        (o.doctor || "").toLowerCase().includes(q);

	      // Status filter
	      const matchesStatus = !filters.status || filters.status === "All" ||
	        (filters.status === "Re-Run Requests"
	          ? rerunByOrder.has(o.id)
	          : ORDER_BUCKET_STATUSES.includes(filters.status as OrderBucketStatus)
	            ? getOrderBucket(o) === filters.status
	            : o.status === filters.status);

      // Priority filter
      const matchesPriority = !filters.priority || filters.priority === "All" || o.priority === filters.priority;

      // Date range filter
      const matchesDateRange = () => {
        if (!filters.from && !filters.to) return true;
        const orderDate = new Date(o.order_date);
        const fromDate = filters.from ? new Date(filters.from) : null;
        const toDate = filters.to ? new Date(filters.to) : null;

        if (fromDate && orderDate < fromDate) return false;
        if (toDate && orderDate > toDate) return false;
        return true;
      };

      // Doctor filter
      const matchesDoctor = !filters.doctor ||
        (o.doctor || "").toLowerCase().includes((filters.doctor || "").toLowerCase());

      const matchesAccount = !filters.account ||
        (o.account_name || "").toLowerCase().includes((filters.account || "").toLowerCase());

      // Location filter
      const matchesLocation = !filters.locationId || o.location_id === filters.locationId;

      return matchesQ && matchesStatus && matchesPriority && matchesDateRange() && matchesDoctor && matchesAccount && matchesLocation;
    });
	  }, [orders, filters, rerunByOrder]);

  // Calculate order counts for filter bar
  const orderCounts = useMemo(() => {
    const total = orders.length;
    const byStatus: Record<string, number> = {};
    const byPriority: Record<string, number> = {};

    orders.forEach(order => {
      byStatus[order.status] = (byStatus[order.status] || 0) + 1;
      byPriority[order.priority] = (byPriority[order.priority] || 0) + 1;
    });

    return {
      total,
      byStatus,
      byPriority
    };
  }, [orders]);

  // Calculate filtered summary stats that update based on filters
  const filteredSummary = useMemo(() => {
	    return filtered.reduce(
	      (acc, o) => {
	        const bucket = getOrderBucket(o);
	        if (bucket === "All Done") acc.allDone++;
	        else if (bucket === "Approval") acc.awaitingApproval++;
	        else if (bucket === "Mostly Done") acc.mostlyDone++;
	        else acc.pending++;
	        return acc;
	      },
      { allDone: 0, mostlyDone: 0, pending: 0, awaitingApproval: 0 }
    );
  }, [filtered]);

  // Transform orders for EnhancedOrdersPage
  const transformedOrdersForEnhanced = useMemo(() => {
    return filtered.map(order => ({
      id: order.id,
      patient_id: order.patient_id,
      patient_name: order.patient_name,
      status: order.status,
      total_amount: order.final_amount ?? order.total_amount,
      order_date: order.order_date,
      created_at: order.order_date,
      order_number: order.order_number ?? null,
      sample_id: order.sample_id || undefined,
      sample_type: order.sample_type,
      color_name: order.color_name || undefined,
      tests: order.tests,
      panels: order.panels.map(panel => ({
        name: panel.name,
        expected: panel.expected,
        entered: panel.entered,
        status: panel.status,
        verified: panel.verified,
      })),
      visit_group_id: order.sample_id ? `sample - ${order.sample_id} ` : `${order.patient_id} -${order.order_date.slice(0, 10)} `,
      order_type: 'initial' as const
    }));
  }, [filtered]);

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
        label: v.date.toLocaleDateString("en-IN", {
          weekday: "long",
          day: "numeric",
          month: "long",
          year: "numeric",
        }),
        orders: v.orders.sort(compareOrders),
      }));
  }, [filtered, orderSortMode]);

  /* ------------- technician worksheet ------------- */
  const toWorksheetOrder = (o: CardOrder): WorksheetOrder => ({
    seq: getDailySeq(o),
    orderId: o.id,
    sampleId: o.sample_id,
    barcodes: (o.samples || []).map((s) => s.barcode).filter((b): b is string => !!b),
    patientName: o.patient?.name || o.patient_name,
    patientAgeGender: [
      formatAge(o.patient?.age, (o.patient as any)?.age_unit),
      o.patient?.gender,
    ].filter(Boolean).join(" • "),
    doctor: o.doctor,
    accountName: o.account_name,
    priority: o.priority,
    orderDate: o.order_date,
    colorName: o.color_name,
    colorCode: o.color_code,
    panels: o.panels,
  });

  const printWorksheet = (g: { label: string; orders: CardOrder[] }) => {
    const worksheetOrders = g.orders.map(toWorksheetOrder);
    if (!worksheetOrders.some((o) => pendingPanels(o).length > 0)) {
      alert("No pending test groups for this date — nothing to put on a worksheet.");
      return;
    }
    const activeFilters = [
      filters.status && filters.status !== "All" ? filters.status : null,
      filters.priority && filters.priority !== "All" ? filters.priority : null,
      filters.account || null,
      filters.doctor ? `Dr. ${filters.doctor}` : null,
      filters.locationId ? locations.find((l) => l.id === filters.locationId)?.name || null : null,
    ].filter(Boolean).join(", ");

    try {
      openWorksheetWindow(
        generateWorksheetHTML(worksheetOrders, {
          dateLabel: g.label,
          subtitle: activeFilters || undefined,
        })
      );
    } catch (err: any) {
      alert(err?.message || "Failed to open the worksheet.");
    }
  };

  const openDetails = (o: CardOrder) => { setOpenOnResults(false); setSelectedOrder(o); };
  const openResultEntry = (o: CardOrder) => { setQuickEntryOrder(o); };
  const openEnhancedResultEntry = (order: { id: string }) => {
    const fullOrder = orders.find((o) => o.id === order.id);
    if (fullOrder) setQuickEntryOrder(fullOrder);
  };

  // Enhanced view handlers
  const handleAddOrder = async (orderData: any) => {
    try {
      console.log('Creating new order:', orderData);
      console.log('Tests array:', orderData.tests, 'Length:', orderData.tests?.length);
      console.log('Test objects structure:', orderData.tests?.[0]);

      // Validate required fields before API call
      if (!orderData.patient_id) {
        alert('❌ Error: Patient is required');
        throw new Error('Patient is required');
      }

      if (!orderData.referring_doctor_id && !orderData.doctor) {
        alert('❌ Error: Referring doctor is required');
        throw new Error('Referring doctor is required');
      }

      // Create the order in the database
      const { data: order, error: orderError } = await database.orders.create(orderData);
      if (orderError) {
        console.error('Error creating order:', orderError);
        const errorMessage = formatOrderCreationError(orderError);
        alert(`❌ Order Creation Failed: ${errorMessage} `);
        throw orderError;
      }

      console.log('Order created successfully:', order);

      // Link TRF attachment to this order — only if a specific attachment ID was provided
      const trfAttachmentId = orderData.trfAttachmentId;
      if (trfAttachmentId) {
        const { error: updateError } = await supabase
          .from('attachments')
          .update({ related_id: order.id, order_id: order.id })
          .eq('id', trfAttachmentId)
          .eq('lab_id', labId); // Safety: only update attachments from this lab

        if (updateError) {
          console.warn('Failed to link TRF attachment to order:', updateError);
        } else {
          console.log('Linked TRF attachment', trfAttachmentId, 'to order:', order.id);
        }
      }

      // ✅ AUTO-CREATE SAMPLES: Generate samples based on test group requirements
      try {
        // Import sample service dynamically to avoid circular dependencies
        const { createSamplesForOrder } = await import('../services/sampleService');

        // Fetch order_test_groups with test_group info for sample creation
        const { data: orderTestGroups, error: otgError } = await supabase
          .from('order_test_groups')
          .select(`
    id,
      order_id,
      test_group_id,
      test_name,
      test_groups!inner(sample_type, sample_color)
          `)
          .eq('order_id', order.id);

        if (otgError) {
          console.error('Error fetching order test groups for sample creation:', otgError);
        } else if (!orderTestGroups || orderTestGroups.length === 0) {
          console.warn('⚠️ No order test groups found for sample creation. Samples will NOT be created for Order:', order.id);
        } else {
          // Transform data to match service interface
          const testGroupsWithInfo = orderTestGroups.map(otg => {
            // Handle potential array return from join
            const groupData = Array.isArray(otg.test_groups) ? otg.test_groups[0] : otg.test_groups;
            return {
              id: otg.id,
              order_id: otg.order_id,
              test_group_id: otg.test_group_id,
              test_name: otg.test_name,
              test_group: {
                sample_type: (groupData as any)?.sample_type || 'Blood',
                sample_color: (groupData as any)?.sample_color
              }
            };
          });

          // Create samples
          const samples = await createSamplesForOrder(
            order.id,
            testGroupsWithInfo,
            order.lab_id,
            order.patient_id,
            {
              preBarcodedBarcode: orderData.__preBarcoded ? orderData.__preBarcodedBarcode : null,
              collectedAt: order.sample_collected_at || orderData.sample_collected_at || null,
              collectedBy: order.sample_collector_id || orderData.sample_collector_id || null,
            }
          );

          console.log(`✅ Created ${samples.length} sample(s) for order ${order.id}: `, samples);
        }
      } catch (sampleError) {
        console.error('Error creating samples (non-critical):', sampleError);
        // Don't fail the order creation if sample generation fails
      }

      // ✅ OPTIMIZED: Instead of re-fetching all orders, fetch only the new order with required data
      const lab_id = await database.getCurrentUserLabId();
      if (lab_id) {
        const { data: newOrderData, error: fetchError } = await supabase
          .from("orders")
          .select(`
	    id, lab_id, patient_id, patient_name, status, priority, order_date, expected_date, total_amount, final_amount, doctor, account_id,
	      order_number, sample_id, color_code, color_name, sample_collected_at, sample_collected_by,
	      accounts(name, billing_mode),
	      patients(name, age, gender),
      order_tests(id, test_group_id, test_name, outsourced_lab_id, outsourced_labs(name))
        `)
          .eq('id', order.id)
          .eq('lab_id', lab_id)
          .single();

        if (!fetchError && newOrderData) {
          // Transform the new order into CardOrder format
          const orderRow = newOrderData as any;

          // Fetch progress for this order only
          const { data: prog } = await supabase
            .from("v_order_test_progress")
            .select("*")
            .eq("order_id", order.id);

          const rows = (prog || []) as ProgressRow[];
          const panels: Panel[] = rows.map((r) => {
            const outsourcedTest = orderRow.order_tests?.find((ot: any) =>
              ot.test_group_id === r.test_group_id && ot.outsourced_lab_id
            );

            return {
              name: r.test_group_name || "Test",
              expected: r.expected_analytes || 0,
              entered: r.entered_analytes || 0,
              verified: !!r.is_verified,
              status: r.panel_status,
              isOutsourced: !!outsourcedTest,
              outsourcedLab: outsourcedTest?.outsourced_labs?.name,
              sample_type: r.sample_type,
              sample_color: r.sample_color,
            };
          });

          const expectedTotal = panels.reduce((sum, p) => sum + p.expected, 0);
          const enteredTotal = panels.reduce((sum, p) => sum + Math.min(p.entered, p.expected), 0);
          const approvedAnalytes = panels.reduce((sum, p) => {
            if (p.verified || p.status === "Verified") {
              return sum + Math.min(p.entered, p.expected);
            }
            return sum;
          }, 0);
          const pendingAnalytes = Math.max(expectedTotal - enteredTotal, 0);
          const forApprovalAnalytes = Math.max(enteredTotal - approvedAnalytes, 0);

          const newCardOrder: CardOrder = {
            id: orderRow.id,
            lab_id: orderRow.lab_id,
            patient_name: orderRow.patient_name,
            patient_id: orderRow.patient_id,
            status: orderRow.status,
            priority: orderRow.priority,
            order_date: orderRow.order_date,
            expected_date: orderRow.expected_date,
            total_amount: orderRow.total_amount,
            final_amount: orderRow.final_amount || orderRow.total_amount,
            doctor: orderRow.doctor,
            account_id: orderRow.account_id,
            account_name: orderRow.accounts?.name || null,
            account_billing_mode: orderRow.accounts?.billing_mode || null,
            order_number: orderRow.order_number ?? null,
            sample_id: orderRow.sample_id,
            color_code: orderRow.color_code,
            color_name: orderRow.color_name,
            sample_collected_at: orderRow.sample_collected_at,
            sample_collected_by: orderRow.sample_collected_by,
            patient: orderRow.patients,
            tests: (orderRow.order_tests || []).map((t: any) => t.test_name),
            order_tests: orderRow.order_tests || [],
            panels,
            expectedTotal,
            enteredTotal,
            pendingAnalytes,
            forApprovalAnalytes,
            approvedAnalytes,
          };

          // Add new order to the beginning of the orders array
          setOrders(prev => [newCardOrder, ...prev]);
          console.log('✅ Added new order to list without full re-fetch');
        } else {
          console.warn('Failed to fetch new order data, falling back to full refresh');
          await fetchOrders();
        }
      } else {
        // Fallback to full refresh if no lab_id
        await fetchOrders();
      }

      // Close the form
      if (!orderData.__createAndNew) {
        setShowOrderForm(false);

      // Show success message
      alert('✅ Order created successfully!');

      }

      // Return the order so OrderForm can use it for invoice/payment creation
      return order;
    } catch (error: any) {
      console.error('Error creating order:', error);
      // Don't close form on error so user can fix issues
      // Error message already shown above
      throw error; // Re-throw so OrderForm knows creation failed
    }
  };

  const handleUpdateStatus = async () => {
    // Centralized components perform the update; here we only refresh data
    await fetchOrders();
  };

  const handleNewSession = () => {
    setShowOrderForm(true);
  };

  const handleNewPatientVisit = () => {
    setShowOrderForm(true);
  };

  // If enhanced view is selected, render EnhancedOrdersPage
  if (viewMode === 'enhanced') {
    return (
      <div className="space-y-6">
        {/* View Mode Toggle */}
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-4">
            <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Test Orders</h1>

            {/* Realtime Connection Indicator */}
            <div className={`flex items - center gap - 1.5 px - 2 py - 1 rounded - full text - xs font - medium ${realtimeConnected
              ? 'bg-green-100 text-green-700'
              : 'bg-gray-100 text-gray-500'
              } `}>
              <span className={`w - 2 h - 2 rounded - full ${realtimeConnected ? 'bg-green-500' : 'bg-gray-400'
                } `}></span>
              {realtimeConnected ? 'Live' : 'Offline'}
            </div>

            <div className="flex items-center space-x-2 bg-gray-100 rounded-lg p-1">
              <button
                onClick={() => setViewMode('standard')}
                className="flex items-center px-3 py-1.5 rounded-md text-sm font-medium transition-colors text-gray-600 hover:text-gray-800"
              >
                <ToggleLeft className="h-4 w-4 mr-1" />
                Standard View
              </button>
              <button
                onClick={() => setViewMode('enhanced')}
                className="flex items-center px-3 py-1.5 rounded-md text-sm font-medium transition-colors bg-white text-blue-600 shadow-sm"
              >
                <ToggleRight className="h-4 w-4 mr-1" />
                Patient Visits
              </button>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowDailyChecklist(true)}
              className="inline-flex items-center rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 shadow-sm transition-colors hover:bg-gray-50"
              title="Print daily checklist"
            >
              <ClipboardList className="h-4 w-4 mr-2" />
              Daily Checklist
            </button>
            <button
              type="button"
              onClick={refreshOrdersData}
              disabled={isRefreshingOrders}
              className="inline-flex items-center rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 shadow-sm transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
              title="Refresh orders"
            >
              <RefreshCcw className={`h-4 w-4 mr-2 ${isRefreshingOrders ? "animate-spin" : ""}`} />
              Refresh
            </button>
          </div>
        </div>

        {/* Filters Bar */}
        <OrderFiltersBar
          value={filters}
          onChange={setFilters}
          orderCounts={orderCounts}
          locations={locations}
          accounts={accounts}
        />

        <EnhancedOrdersPage
          orders={transformedOrdersForEnhanced}
          onAddOrder={handleAddOrder}
          onUpdateStatus={handleUpdateStatus}
          onRefreshOrders={fetchOrders}
          onQuickResultEntry={openEnhancedResultEntry}
          onNewSession={handleNewSession}
          onNewPatientVisit={handleNewPatientVisit}
        />

        {/* Modals */}
        {showDailyChecklist && (
          <DailyChecklistModal onClose={() => setShowDailyChecklist(false)} />
        )}
        {showOrderForm && (
          <OrderForm
            onClose={() => setShowOrderForm(false)}
            onSubmit={handleAddOrder}
          />
        )}

        {selectedOrder && (
          <OrderDetailsModal
            order={{
              ...selectedOrder,
              doctor: selectedOrder.doctor || '',
              sample_id: selectedOrder.sample_id || undefined,
              color_code: selectedOrder.color_code || undefined,
              color_name: selectedOrder.color_name || undefined,
              sample_collected_at: selectedOrder.sample_collected_at || undefined,
              sample_collected_by: selectedOrder.sample_collected_by || undefined
            }}
            initialTab="details"
            onClose={() => { setSelectedOrder(null); setOpenOnResults(false); }}
            onUpdateStatus={handleUpdateStatus}
            onSubmitResults={async (_orderId: string, _resultsData: any[]) => {
              console.log('onSubmitResults called');
              await fetchOrders();
              setSelectedOrder(null);
              setOpenOnResults(false);
            }}
          />
        )}
        {quickEntryOrder && (
          <QuickResultEntryModal
            order={quickEntryOrder}
            onClose={() => setQuickEntryOrder(null)}
            onSubmitted={() => { fetchOrders(); setQuickEntryOrder(null); }}
          />
        )}
      </div>
    );
  }

  /* ===========================
     Standard UI
  =========================== */

  return (
    <div className="space-y-3">
      {/* Header with View Mode Toggle */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center space-x-4">
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900">Test Orders</h1>
          <div className="flex items-center space-x-2 bg-gray-100 rounded-lg p-1">
            <button
              onClick={() => setViewMode('standard')}
              className="flex items-center px-3 py-1.5 rounded-md text-sm font-medium transition-colors bg-white text-blue-600 shadow-sm"
            >
              <ToggleLeft className="h-4 w-4 mr-1" />
              Standard View
            </button>
            <button
              onClick={() => setViewMode('enhanced')}
              className="flex items-center px-3 py-1.5 rounded-md text-sm font-medium transition-colors text-gray-600 hover:text-gray-800"
            >
              <ToggleRight className="h-4 w-4 mr-1" />
              Patient Visits
            </button>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowDailyChecklist(true)}
            className="inline-flex items-center justify-center rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 shadow-sm transition-colors hover:bg-gray-50"
            title="Print daily checklist"
          >
            <ClipboardList className="h-4 w-4 mr-2" />
            Daily Checklist
          </button>
          <button
            type="button"
            onClick={refreshOrdersData}
            disabled={isRefreshingOrders}
            className="inline-flex items-center justify-center rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 shadow-sm transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
            title="Refresh orders"
          >
            <RefreshCcw className={`h-4 w-4 mr-2 ${isRefreshingOrders ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* Overview cards */}
      {/* Overview cards - Compact Mobile Grid */}
	      <div className="grid grid-cols-2 md:grid-cols-5 gap-2 md:gap-3">
	        <button
	          type="button"
	          onClick={() => toggleStatusFilter("All Done")}
	          aria-pressed={filters.status === "All Done"}
	          className={`text-left bg-green-50 border border-green-200 rounded-lg p-2 md:p-3 relative overflow-hidden cursor-pointer transition-all hover:border-green-400 hover:shadow-sm ${filters.status === "All Done" ? "ring-2 ring-green-600 ring-opacity-80" : ""}`}
	        >
	          <div className="relative z-10">
	            <div className="text-lg md:text-xl font-bold text-green-900">{filteredSummary.allDone}</div>
	            <div className="text-xs md:text-sm text-green-700 font-medium">All Done</div>
	          </div>
	          <CheckCircle className="absolute right-2 bottom-2 h-8 w-8 text-green-500/20 md:static md:h-5 md:w-5 md:text-white md:bg-green-500 md:p-1 md:rounded-lg md:opacity-100" />
	        </button>
	        <button
	          type="button"
	          onClick={() => toggleStatusFilter("Mostly Done")}
	          aria-pressed={filters.status === "Mostly Done"}
	          className={`text-left bg-blue-50 border border-blue-200 rounded-lg p-2 md:p-3 relative overflow-hidden cursor-pointer transition-all hover:border-blue-400 hover:shadow-sm ${filters.status === "Mostly Done" ? "ring-2 ring-blue-600 ring-opacity-80" : ""}`}
	        >
	          <div className="relative z-10">
	            <div className="text-lg md:text-xl font-bold text-blue-900">{filteredSummary.mostlyDone}</div>
	            <div className="text-xs md:text-sm text-blue-700 font-medium">Mostly Done</div>
	          </div>
	          <TrendingUp className="absolute right-2 bottom-2 h-8 w-8 text-blue-500/20 md:static md:h-5 md:w-5 md:text-white md:bg-blue-500 md:p-1 md:rounded-lg md:opacity-100" />
	        </button>
	        <button
	          type="button"
	          onClick={() => toggleStatusFilter("Pending")}
	          aria-pressed={filters.status === "Pending"}
	          className={`text-left bg-yellow-50 border border-yellow-200 rounded-lg p-2 md:p-3 relative overflow-hidden cursor-pointer transition-all hover:border-yellow-400 hover:shadow-sm ${filters.status === "Pending" ? "ring-2 ring-yellow-600 ring-opacity-80" : ""}`}
	        >
	          <div className="relative z-10">
	            <div className="text-lg md:text-xl font-bold text-yellow-900">{filteredSummary.pending}</div>
	            <div className="text-xs md:text-sm text-yellow-700 font-medium">Pending</div>
	          </div>
	          <ClockIcon className="absolute right-2 bottom-2 h-8 w-8 text-yellow-500/20 md:static md:h-5 md:w-5 md:text-white md:bg-yellow-500 md:p-1 md:rounded-lg md:opacity-100" />
	        </button>
	        <button
	          type="button"
	          onClick={() => toggleStatusFilter("Approval")}
	          aria-pressed={filters.status === "Approval"}
	          className={`text-left bg-orange-50 border border-orange-200 rounded-lg p-2 md:p-3 relative overflow-hidden cursor-pointer transition-all hover:border-orange-400 hover:shadow-sm ${filters.status === "Approval" ? "ring-2 ring-orange-600 ring-opacity-80" : ""}`}
	        >
	          <div className="relative z-10">
	            <div className="text-lg md:text-xl font-bold text-orange-900">{filteredSummary.awaitingApproval}</div>
	            <div className="text-xs md:text-sm text-orange-700 font-medium">Approval</div>
	          </div>
	          <AlertTriangle className="absolute right-2 bottom-2 h-8 w-8 text-orange-500/20 md:static md:h-5 md:w-5 md:text-white md:bg-orange-500 md:p-1 md:rounded-lg md:opacity-100" />
	        </button>
	        {/* RE-RUN Requests Card */}
	        <button
	          type="button"
	          onClick={() => toggleStatusFilter("Re-Run Requests")}
	          aria-pressed={filters.status === "Re-Run Requests"}
	          className={`border rounded-lg p-2 md:p-3 relative overflow-hidden cursor-pointer transition-all ${totalRerunCount > 0 ? 'bg-red-50 border-red-300 ring-2 ring-red-400 ring-opacity-50' : 'bg-gray-50 border-gray-200'} ${filters.status === 'Re-Run Requests' ? 'ring-2 ring-red-600 ring-opacity-80' : ''}`}>
	          <div className="relative z-10">
	            <div className={`text-lg md:text-xl font-bold ${totalRerunCount > 0 ? 'text-red-900 animate-pulse' : 'text-gray-600'}`}>
              {totalRerunCount}
            </div>
            <div className={`text-xs md:text-sm font-medium ${totalRerunCount > 0 ? 'text-red-700' : 'text-gray-500'}`}>
              RE-RUN Requests
            </div>
            {totalRerunCount > 0 && (
              <div className="text-xs text-red-600 mt-1">
                {rerunRequests.length} order{rerunRequests.length !== 1 ? 's' : ''}
              </div>
	            )}
	          </div>
	          <RefreshCcw className={`absolute right-2 bottom-2 h-8 w-8 md:static md:h-5 md:w-5 md:p-1 md:rounded-lg md:opacity-100 ${totalRerunCount > 0 ? 'text-red-500/20 md:text-white md:bg-red-500 animate-spin-slow' : 'text-gray-400/20 md:text-white md:bg-gray-400'}`} />
	        </button>
	      </div>

      {/* Filters Bar */}
      <OrderFiltersBar
        value={filters}
        onChange={setFilters}
        orderCounts={orderCounts}
        locations={locations}
        accounts={accounts}
      />

      <div className="flex justify-end">
        <div className="relative">
          <ArrowDownUp className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <select
            value={orderSortMode}
            onChange={(e) => setOrderSortMode(e.target.value as OrderSortMode)}
            className="h-9 rounded-lg border border-gray-300 bg-white pl-9 pr-8 text-sm text-gray-700 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            title="Sort orders"
          >
            <option value="sample_desc">Sample ID high to low</option>
            <option value="sample_asc">Sample ID low to high</option>
            <option value="date_desc">Newest order date</option>
            <option value="patient_az">Patient A-Z</option>
          </select>
        </div>
      </div>

      {/* Groups + Cards */}
      <div className="bg-white rounded-lg border border-gray-200">
        <div className="px-4 py-3 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900">Test Orders ({filtered.length})</h3>
        </div>

        {groups.length === 0 ? (
          <div className="text-center py-12">
            <TestTube className="h-12 w-12 text-gray-300 mx-auto mb-3" />
            <p className="text-gray-600">No Orders Found</p>
          </div>
        ) : (
          <div className="space-y-4">
            {groups.map((g) => (
              <div key={g.key} className="px-4">
                <div className="flex items-center justify-between gap-2 py-3 border-b mb-3 border-gray-200">
                  <h4 className="text-base font-semibold text-gray-700">{g.label}</h4>
                  <div className="flex items-center gap-3">
                    <div className="text-sm text-gray-500">{g.orders.length} order{g.orders.length !== 1 ? "s" : ""}</div>
                    <button
                      type="button"
                      onClick={() => printWorksheet(g)}
                      className="inline-flex items-center rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-700 shadow-sm transition-colors hover:bg-gray-50"
                      title="Download / print a bench worksheet of pending test groups for this date"
                    >
                      <Printer className="h-3.5 w-3.5 mr-1.5" />
                      Worksheet
                    </button>
                  </div>
                </div>

                <div className="space-y-4">
	                  {g.orders.map((o) => {
	                    const pct = o.expectedTotal > 0
	                      ? Math.min(100, Math.round((o.enteredTotal / o.expectedTotal) * 100))
	                      : 0;
                    const visiblePanels = mobile.isMobile ? o.panels.slice(0, 2) : o.panels;
                    const hiddenPanelCount = Math.max(0, o.panels.length - visiblePanels.length);
                    const visibleTests = mobile.isMobile ? o.tests.slice(0, 2) : o.tests;
                    const hiddenTestCount = Math.max(0, o.tests.length - visibleTests.length);

                    // Debug logging
                    if (pct === 0 && o.expectedTotal > 0) {
                      console.debug(`⚠️ Order ${o.sample_id}: pct=0 but expected=${o.expectedTotal}, entered=${o.enteredTotal}, panels=`, o.panels.map(p => ({ name: p.name, entered: p.entered, expected: p.expected })));
                    }

                    return (
                      <div
                        key={o.id}
                        role="button"
                        onClick={() => openDetails(o)}
                        className="w-full p-3 md:p-4 border rounded-lg hover:shadow-md transition-all cursor-pointer border-gray-200 bg-white"
                      >
                        {/* Top row */}
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex items-center gap-2 md:gap-3">
                            <div className="flex items-center justify-center w-6 h-6 md:w-8 md:h-8 bg-blue-100 text-blue-700 rounded-full font-bold text-xs md:text-sm border border-blue-200">
                              {String(getDailySeq(o)).padStart(3, "0")}
                            </div>
                            <div className="flex items-center gap-2 md:gap-3">
                              <User className="h-5 w-5 md:h-6 md:w-6 text-blue-600 shrink-0" />
                              <div>
                                <div className="text-base md:text-2xl font-bold text-gray-900 leading-tight">
                                  {o.patient?.name || o.patient_name}
                                </div>
                                <div className="text-xs md:text-base text-gray-700">
                                  {formatAge(o.patient?.age, (o.patient as any)?.age_unit)} • {o.patient?.gender || "N/A"}
	                                  {(() => {
	                                    const barcodes = (o.samples || [])
	                                      .map((s) => s.barcode)
	                                      .filter((b): b is string => !!b);
	                                    if (barcodes.length === 0) return null;
	                                    return (
	                                      <span className="font-mono font-semibold text-gray-800 select-all cursor-text" title="Sample barcode(s)">
	                                        {" • "}{barcodes.join("/")}
	                                      </span>
	                                    );
	                                  })()}
	                                </div>
	                                {o.account_name && (
	                                  <div className="mt-1 inline-flex items-center gap-1 rounded-md border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700">
	                                    <Building2 className="h-3 w-3" />
	                                    {o.account_name}
	                                  </div>
	                                )}
                              </div>
                            </div>
                          </div>

                          <div className="flex items-center gap-1 md:gap-2" onClick={(e) => e.stopPropagation()}>
                            {/* RE-RUN Request Badge */}
                            {rerunByOrder.has(o.id) && (
                              <span className="inline-flex items-center px-2 py-0.5 md:px-2.5 md:py-1 rounded-lg text-xs md:text-sm font-bold border bg-red-100 text-red-800 border-red-300 whitespace-nowrap animate-pulse">
                                <RefreshCcw className="h-3 w-3 md:h-3.5 md:w-3.5 mr-1" />
                                RE-RUN ({rerunByOrder.get(o.id)?.count})
                              </span>
                            )}
                            {/* LIS Analyzer Result Badge */}
                            {analyzerActivity.has(o.id) && (() => {
                              const act = analyzerActivity.get(o.id)!;
                              return (
                                <span
                                  title={`Analyzer results received at ${new Date(act.receivedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}
                                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-xs font-bold border bg-purple-100 text-purple-800 border-purple-300 whitespace-nowrap${act.isNew ? ' animate-pulse' : ''}`}
                                >
                                  <Activity className="h-3 w-3" />
                                  LIS{act.count > 1 ? ` ×${act.count}` : ''}
                                </span>
                              );
                            })()}
                            <span className="inline-flex items-center px-2 py-0.5 md:px-3 md:py-1.5 rounded-lg text-xs md:text-sm font-bold border bg-blue-100 text-blue-800 border-blue-200 whitespace-nowrap">
                              {o.status === "In Progress" ? "In Process" : o.status}
                            </span>
                            {o.priority !== "Normal" && (
                              <span className={`inline-flex items-center px-2 py-0.5 md:px-2.5 md:py-1 rounded-lg text-xs md:text-sm font-bold border whitespace-nowrap ${
                                o.priority === "STAT"
                                  ? "bg-red-100 text-red-800 border-red-300 animate-pulse"
                                  : "bg-orange-100 text-orange-800 border-orange-300"
                              }`}>
                                {o.priority === "STAT" ? "🚨 STAT" : "⚡ Urgent"}
                              </span>
                            )}
                            <button
                              className="p-2 text-gray-600 hover:bg-gray-100 rounded-lg"
                              onClick={() => setExpanded((prev) => ({ ...prev, [o.id]: !prev[o.id] }))}
                            >
                              {expanded[o.id] ? <ChevronUp className="h-5 w-5" /> : <ChevronDown className="h-5 w-5" />}
                            </button>
                          </div>
                        </div>

                        {/* TAT Badge — only for in-progress orders */}
                        {!['Report Ready', 'Completed', 'Delivered'].includes(o.status) && (
                          <div className="mt-1 flex justify-end">
                            <TATStatusBadge
                              hoursUntilBreach={o.hours_until_tat_breach ?? null}
                              isBreached={o.is_tat_breached ?? null}
                              tatHours={o.tat_hours ?? null}
                              compact={true}
                            />
                          </div>
                        )}

                        {/* Middle: sample + tests */}
                        <div className="mt-3 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3 bg-gray-50 rounded-lg p-3">
                          <div className="flex flex-col sm:flex-row sm:items-center gap-6">
                            <div className="min-w-[110px]">
                              <div className="flex flex-col items-start gap-1">
                                <span className="text-xs text-gray-500 font-mono bg-white px-2 py-0.5 rounded border">
                                  {o.sample_id ? `#${String(o.sample_id).split("-").pop()} ` : 'No Sample'}
                                </span>
                                <SampleTypeGroup
                                  samples={o.panels.map(p => ({ sampleType: p.sample_type || 'Blood' }))}
                                  size="sm"
                                />
                              </div>
                            </div>

                            {o.sample_id && (
                              <div className="hidden sm:flex items-center gap-2">
                                <div
                                  className="w-8 h-8 rounded-full border-2 border-white shadow-md flex items-center justify-center text-white font-bold text-xs"
                                  style={{ backgroundColor: o.color_code || "#8B5CF6" }}
                                  title={`Sample Color: ${o.color_code || "N/A"} `}
                                >
                                  {(o.color_name || "Tube").charAt(0)}
                                </div>
                                <div>
                                  <div className="text-xs text-gray-600">Sample</div>
                                  <div className="font-mono font-bold text-gray-900 text-sm">
                                    {String(o.sample_id).split("-").pop()}
                                  </div>
                                </div>
                              </div>
                            )}

                            <div className="flex-1">
                              <div className="text-sm text-gray-600 mb-1">
                                Tests ({o.tests.length})
                                {(() => {
                                  const orderTests = (o as any).order_tests || [];
                                  const outsourcedCount = orderTests.filter((ot: any) => ot.outsourced_lab_id).length;
                                  if (outsourcedCount > 0) {
                                    return (
                                      <span className="ml-2 inline-flex items-center gap-0.5 px-1.5 py-0.5 text-xs font-medium bg-orange-100 text-orange-700 rounded">
                                        🏥 {outsourcedCount} outsourced
                                      </span>
                                    );
                                  }
                                  return null;
                                })()}
                              </div>
                              <div className="flex flex-wrap gap-3">
                                {o.panels.length > 0
                                  ? visiblePanels.map((p, i) => {
                                    // For section-only: 100% if content saved, 0% otherwise
                                    const progress = p.is_section_only
                                      ? (p.has_section_content ? 100 : 0)
                                      : (p.expected > 0 ? (p.entered / p.expected) * 100 : 0);

                                    // Modern minimalistic colors based on progress
                                    const getMinimalColor = (percent: number, isOutsourced?: boolean, isSectionOnly?: boolean, isVerified?: boolean) => {
                                      if (isOutsourced) return "bg-purple-50 border-purple-200 text-purple-800";
                                      // Section-only special colors
                                      if (isSectionOnly) {
                                        if (isVerified) return "bg-green-50 border-green-200 text-green-800";
                                        if (percent === 100) return "bg-amber-50 border-amber-200 text-amber-800"; // Saved but not verified
                                        return "bg-gray-100 border-gray-300 text-gray-700"; // Not started
                                      }
                                      if (percent === 0) return "bg-gray-100 border-gray-300 text-gray-700";
                                      if (percent < 40) return "bg-red-50 border-red-200 text-red-800";
                                      if (percent < 70) return "bg-orange-50 border-orange-200 text-orange-800";
                                      if (percent < 90) return "bg-yellow-50 border-yellow-200 text-yellow-800";
                                      return "bg-green-50 border-green-200 text-green-800";
                                    };

                                    const colorClass = getMinimalColor(progress, p.isOutsourced, p.is_section_only, p.section_verification_status === 'verified');

                                    return (
                                      <div
                                        key={`${p.name} -${i} `}
                                        className={`border rounded - lg px - 3 py - 2 transition - all duration - 300 ${colorClass} `}
                                      >
                                        <div className="font-medium text-sm mb-1 flex items-center gap-1">
                                          {p.isOutsourced && <span>🏥</span>}
                                          {p.name}
                                          {/* TAT indicator per panel — hide for completed orders */}
                                          {p.tat_hours && !p.isOutsourced && !['Report Ready', 'Completed', 'Delivered'].includes(o.status) && (
                                            <span 
                                              className={`ml-1 text-xs px-1 py-0.5 rounded ${
                                                p.is_tat_breached 
                                                  ? 'bg-red-500 text-white animate-pulse' 
                                                  : p.hours_until_tat_breach !== null && p.hours_until_tat_breach !== undefined && p.hours_until_tat_breach < 2 
                                                    ? 'bg-yellow-400 text-yellow-900' 
                                                    : 'bg-gray-200 text-gray-600'
                                              }`}
                                              title={`TAT: ${p.tat_hours}h | ${p.is_tat_breached ? 'BREACHED' : p.hours_until_tat_breach !== null ? `${p.hours_until_tat_breach.toFixed(1)}h left` : 'Not started'}`}
                                            >
                                              {p.is_tat_breached ? '⏰!' : `${p.tat_hours}h`}
                                            </span>
                                          )}
                                        </div>
                                        <div className="flex items-center justify-between text-xs">
                                          {p.isOutsourced ? (
                                            <>
                                              <span className="font-medium">Outsourced</span>
                                              <span className="text-xs opacity-75 truncate max-w-[80px]" title={p.outsourcedLab}>
                                                {p.outsourcedLab || 'External Lab'}
                                              </span>
                                            </>
                                          ) : p.is_section_only ? (
                                            <>
                                              <span className="font-medium">
                                                {p.has_section_content ? '✓ Section Saved' : 'Section Pending'}
                                              </span>
                                              <span className="text-xs opacity-75">
                                                {p.section_verification_status === 'verified'
                                                  ? '✅ Verified'
                                                  : p.has_section_content
                                                    ? 'Pending Approval'
                                                    : 'Not Started'}
                                              </span>
                                            </>
                                          ) : (
                                            <>
                                              <span className="font-mono">
                                                {p.entered}/{p.expected} analytes
                                              </span>
                                              <span className="text-xs opacity-75">
                                                {progress === 0 ? "Pending" : progress < 100 ? "Partial" : "Complete"}
                                              </span>
                                            </>
                                          )}
                                        </div>
                                      </div>
                                    );
                                  })
                                  : visibleTests.map((t, i) => {
                                    // Find corresponding order_test to check outsourcing status
                                    const orderTests = (o as any).order_tests || [];
                                    const orderTest = orderTests.find((ot: any) => ot.test_name === t);
                                    const isOutsourced = orderTest?.outsourced_lab_id;

                                    return (
                                      <span
                                        key={i}
                                        className={`px - 2 py - 1 rounded text - sm ${isOutsourced
                                          ? 'bg-orange-100 text-orange-800 border border-orange-200'
                                          : 'bg-blue-100 text-blue-800'
                                          } `}
                                      >
                                        {isOutsourced && '🏥 '}{t}
                                      </span>
                                    );
                                  })}
                                {o.panels.length > 0 && hiddenPanelCount > 0 && (
                                  <span className="px-2 py-1 rounded text-xs bg-gray-100 text-gray-700 border border-gray-200">
                                    +{hiddenPanelCount} more
                                  </span>
                                )}
                                {o.panels.length === 0 && hiddenTestCount > 0 && (
                                  <span className="px-2 py-1 rounded text-xs bg-gray-100 text-gray-700 border border-gray-200">
                                    +{hiddenTestCount} more
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>

                          <div className="text-right">
                            <div className="text-xl sm:text-2xl font-bold text-green-600">
                              ₹{Number(o.final_amount ?? o.total_amount ?? 0).toLocaleString()}
                            </div>
                            <div className="text-sm text-gray-600">
                              <div>Ordered: {new Date(o.order_date).toLocaleDateString()}</div>
                                {!o.tatStarted ? (
                                  <div className="text-amber-600 font-medium text-xs">
                                    ⏳ TAT starts after collection
                                  </div>
                                ) : o.expected_date && !isNaN(new Date(o.expected_date).getTime()) ? (
                                  <div className={`${new Date(o.expected_date) < new Date() && !['Report Ready', 'Completed', 'Delivered'].includes(o.status) ? "text-red-600 font-bold" : ""} `}>
                                    Expected: {mobile.isMobile
                                      ? new Date(o.expected_date).toLocaleDateString()
                                      : new Date(o.expected_date).toLocaleString(undefined, { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                                    {new Date(o.expected_date) < new Date() && !['Report Ready', 'Completed', 'Delivered'].includes(o.status) && " ⚠️ OVERDUE"}
                                  </div>
                                ) : o.sample_collected_at ? (
                                  <div className="text-xs text-green-700">
                                    Collected: {new Date(o.sample_collected_at).toLocaleString(undefined, { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                                  </div>
                                ) : null}
                              </div>

                            {/* Order card actions */}
                            <div className="mt-3 flex flex-col sm:flex-row gap-2">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  openDetails(o);
                                }}
                                className="inline-flex items-center px-3 py-1.5 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700"
                              >
                                <Eye className="h-4 w-4 mr-1" />
                                View Details
                              </button>

                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  openResultEntry(o);
                                }}
                                className="inline-flex items-center px-3 py-1.5 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700"
                              >
                                <TestTube className="h-4 w-4 mr-1" />
                                Enter Results
                              </button>

                            </div>
                          </div>
                        </div>

                        {/* Enhanced Progress + legend */}
                        <div className="mt-3 bg-gradient-to-r from-blue-50 to-indigo-50 rounded-lg p-3 border border-blue-200">
                          <div className="flex items-center justify-between text-sm mb-2">
                            <span className="text-blue-800 font-semibold flex items-center">
                              📊 Overall Progress
                            </span>
                            <span className="text-blue-800 font-bold text-base">
                              {o.enteredTotal}/{o.expectedTotal} analytes
                            </span>
                          </div>

	                          {/* Result-entry progress bar. Verification pending is shown in the legend, not as incomplete entry progress. */}
	                          <div className="relative w-full bg-gray-200 rounded-full h-4 mb-3 overflow-hidden border">
	                            <div
	                              className="absolute left-0 top-0 h-4 transition-all duration-700 rounded-full"
	                              style={{
	                                width: `${pct}%`,
	                                background: pct === 0
	                                  ? '#ef4444'
	                                  : pct < 25
	                                    ? 'linear-gradient(90deg, #ef4444 0%, #f97316 100%)'
	                                    : pct < 50
	                                      ? 'linear-gradient(90deg, #f97316 0%, #eab308 100%)'
	                                      : pct < 75
	                                        ? 'linear-gradient(90deg, #eab308 0%, #84cc16 100%)'
	                                        : pct < 100
	                                          ? 'linear-gradient(90deg, #84cc16 0%, #22c55e 100%)'
	                                          : '#10b981',
	                                boxShadow: pct > 0 ? `0 0 12px ${pct < 50 ? '#ef444440' : '#22c55e40'}` : 'none'
	                              }}
	                            />
	
	                            {/* Progress indicator line */}
	                            <div
	                              className="absolute top-0 w-0.5 h-4 bg-white shadow-lg"
	                              style={{ left: `${pct}%` }}
	                            />

                            {/* Sparkle effect for high progress */}
                            {pct > 75 && (
                              <div className="absolute inset-0 rounded-full opacity-30">
                                <div className="absolute top-1 left-1/4 w-1 h-1 bg-white rounded-full animate-pulse" />
                                <div className="absolute top-2 right-1/3 w-0.5 h-0.5 bg-white rounded-full animate-pulse delay-150" />
                                <div className="absolute bottom-1 left-2/3 w-1 h-1 bg-white rounded-full animate-pulse delay-300" />
                              </div>
                            )}
                          </div>

                          {/* Enhanced legend with better spacing and icons */}
                          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 text-sm">
                            <div className="inline-flex items-center bg-white rounded-md px-2 py-1 border border-gray-200">
                              <span className="inline-block w-3 h-3 bg-red-400 rounded-full mr-2 shadow-sm" />
                              <span className="text-gray-700">Pending: <strong>{o.pendingAnalytes}</strong></span>
                            </div>
                            <div className="inline-flex items-center bg-white rounded-md px-2 py-1 border border-amber-200">
                              <span className="inline-block w-3 h-3 bg-amber-500 rounded-full mr-2 shadow-sm" />
	                              <span className="text-amber-700">Verification pending: <strong>{o.forApprovalAnalytes}</strong></span>
                            </div>
                            <div className="inline-flex items-center bg-white rounded-md px-2 py-1 border border-green-200">
                              <span className="inline-block w-3 h-3 bg-green-500 rounded-full mr-2 shadow-sm" />
                              <span className="text-green-700">Approved: <strong>{o.approvedAnalytes}</strong></span>
                            </div>
                            <div className="inline-flex items-center bg-white rounded-md px-2 py-1 border border-blue-200 lg:justify-end">
                              <span className={`font - bold ${pct < 25 ? 'text-red-600' : pct < 50 ? 'text-orange-600' : pct < 75 ? 'text-yellow-600' : pct < 100 ? 'text-lime-600' : 'text-green-600'} `}>
                                {pct < 25 ? '🔴' : pct < 50 ? '🟠' : pct < 75 ? '🟡' : pct < 100 ? '🟢' : '✅'} Total: {o.expectedTotal}
                              </span>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer stats */}
      <div className="bg-gradient-to-r from-blue-50 to-purple-50 rounded-lg p-4 border border-blue-200">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-sm">
          <div className="flex items-center gap-6">
            <div className="flex items-center">
              <Calendar className="h-4 w-4 text-blue-600 mr-1" />
              <span className="text-blue-900 font-medium">Total Orders: {orders.length}</span>
            </div>
            <div className="flex items-center">
              <AlertTriangle className="h-4 w-4 text-red-600 mr-1" />
              <span className="text-red-900 font-medium">
                Overdue: {orders.filter((o) => new Date(o.expected_date).setHours(0, 0, 0, 0) < new Date().setHours(0, 0, 0, 0)).length}
              </span>
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
      {showDailyChecklist && (
        <DailyChecklistModal onClose={() => setShowDailyChecklist(false)} />
      )}
      {showOrderForm && (
        <OrderForm
          onClose={() => setShowOrderForm(false)}
          onSubmit={handleAddOrder}
        />
      )}

      {selectedOrder && (
        <OrderDetailsModal
          order={{
            ...selectedOrder,
            doctor: selectedOrder.doctor || '',
            sample_id: selectedOrder.sample_id || undefined,
            color_code: selectedOrder.color_code || undefined,
            color_name: selectedOrder.color_name || undefined,
            sample_collected_at: selectedOrder.sample_collected_at || undefined,
            sample_collected_by: selectedOrder.sample_collected_by || undefined
          }}
          initialTab="details"
          onClose={() => { setSelectedOrder(null); setOpenOnResults(false); }}
          onUpdateStatus={handleUpdateStatus}
          onSubmitResults={async (_orderId: string, _resultsData: any[]) => {
            console.log('onSubmitResults called');
            await fetchOrders();
            setSelectedOrder(null);
          }}
        />
      )}
      {quickEntryOrder && (
        <QuickResultEntryModal
          order={quickEntryOrder}
          onClose={() => setQuickEntryOrder(null)}
          onSubmitted={() => { fetchOrders(); setQuickEntryOrder(null); }}
        />
      )}

      {/* Bottom spacer for mobile */}
      <div className="h-4 sm:hidden"></div>

      {/* Order Details Modal */}
      {selectedOrder && (
        <OrderDetailsModal
          order={{
            ...selectedOrder,
            tests: selectedOrder.tests || []
          }}
          onClose={() => {
            setSelectedOrder(null);
            fetchOrders(); // Refresh orders when modal closes
          }}
          onUpdateStatus={handleUpdateStatus}
          onSubmitResults={() => {
            fetchOrders(); // Refresh orders after submitting results
            setSelectedOrder(null);
          }}
        />
      )}
    </div>
  );
};

export default Orders;
