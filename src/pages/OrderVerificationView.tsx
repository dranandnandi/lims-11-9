import React, { useEffect, useMemo, useRef, useState } from "react";
import ReactDOM from "react-dom";
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  CheckSquare,
  ChevronDown,
  ChevronUp,
  ClipboardList,
  Clock,
  Edit,
  Expand,
  Eye,
  FileImage,
  FileText,
  Loader2,
  Minimize,
  Printer,
  RefreshCcw,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  Sparkles,
  Stethoscope,
  TestTube,
  TrendingUp,
  User,
  X,
  XCircle,
	  Zap
} from "lucide-react";
import { buildBasicPreviewHtml } from "../utils/buildBasicPreviewHtml";
import AttachmentSelector from "../components/Reports/AttachmentSelector";
import {
  useAIResultIntelligence,
  type ClinicalSummaryResponse,
  type GeneratedInterpretation,
  type VerifierSummaryResponse,
  type PatientSummaryResponse,
  type SupportedLanguage,
  type DeltaCheckResponse,
  type OrderDeltaCheckResponse,
  LANGUAGE_DISPLAY_NAMES
} from "../hooks/useAIResultIntelligence";
import { supabase, database, aiAnalysis } from "../utils/supabase";
import { loadOrderedAnalyteRows } from "../utils/analyteDisplayOrder";
import { runAIFlagAnalysis, analyzeAndSaveFlag } from "../utils/aiFlagAnalysis";
import { saveClinicalSummary, toggleOrderSummaryInReport, saveClinicalSummaryOptions } from "../utils/reportExtrasService";
import TrendGraphPanel from "../components/Results/TrendGraphPanel";
import PatientSummaryModal from "../components/Results/PatientSummaryModal";
import SectionEditor from "../components/Results/SectionEditor";
import WorkflowExecutionPanel from "../components/Workflow/WorkflowExecutionPanel";

interface PanelRow {
  order_id: string;
  result_id: string;
  test_group_id: string | null;
  test_group_name: string | null;
  has_result?: boolean;
  is_section_only?: boolean;
  expected_analytes: number;
  entered_analytes: number;
  approved_analytes: number;
  hidden_analytes?: number;
  handled_analytes?: number;
  panel_ready: boolean;
  result_verification_status?: string | null;
  notes?: string | null;
  patient_id: string;
	  patient_name: string;
	  order_date: string;
  sample_id?: string | null;
  order_number?: number | null;
  doctor?: string | null;
  account_id?: string | null;
  account_name?: string | null;
  priority?: "Normal" | "Urgent" | "STAT" | null;
}

interface Analyte {
  id: string;
  result_id: string;
  analyte_id?: string; // FK to analytes table for historical data lookup
  parameter: string;
  value: string | null;
  unit: string;
  reference_range: string;
  flag: string | null;
  flag_source?: 'rule' | 'ai' | 'manual' | null;
  flag_confidence?: number | null;
  ai_interpretation?: string | null;
  ai_audit_status?: 'pending' | 'confirmed' | 'overridden' | 'needs_review' | 'none' | 'approved' | 'rejected' | null;
  is_auto_calculated?: boolean | null;
  verify_status: "pending" | "approved" | "rejected" | null;
  verify_note: string | null;
  verified_by: string | null;
  verified_at: string | null;
  is_hidden_from_report?: boolean | null;
  hidden_reason?: string | null;
  section_heading?: string | null;
  sort_order?: number | null;
  display_order?: number | null;
}

interface Attachment {
  id: string;
  file_url: string;
  file_type: string;
  original_filename: string;
  created_at: string;
  level: "test" | "order";
}

interface OrderGroup {
  orderId: string;
  patientId: string;
  patientName: string;
  orderDate: string;
  sortTimestamp: number;
  sampleId: string | null;
  orderNumber: number | null;
  doctor: string | null;
  accountName: string | null;
  priority?: "Normal" | "Urgent" | "STAT" | null;
  panels: PanelRow[];
  stats: {
    expected: number;
    entered: number;
    approved: number;
    hidden: number;
    handled: number;
    readyPanels: number;
  };
}

type OrderProgressTotals = {
  expected: number;
  entered: number;
  approved: number;
};

interface OrderVerificationViewProps {
  onBackToPanel?: () => void;
}

type AttachmentViewMode = "test" | "all";

type StateFilter = "all" | "pending" | "partial" | "ready";
type OrderSortMode = "sample_desc" | "sample_asc" | "date_desc" | "patient_az";

const todayISO = () => new Date().toISOString().slice(0, 10);
const fromYesterdayISO = () => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
};

const fetchRowsByIds = async (
  table: string,
  select: string,
  ids: string[],
  chunkSize = 80,
) => {
  const uniqueIds = Array.from(new Set(ids.filter(Boolean)));
  if (uniqueIds.length === 0) return [] as any[];

  const rows: any[] = [];
  for (let i = 0; i < uniqueIds.length; i += chunkSize) {
    const chunk = uniqueIds.slice(i, i + chunkSize);
    const { data, error } = await supabase
      .from(table)
      .select(select)
      .in("id", chunk);

    if (error) throw error;
    rows.push(...(data || []));
  }

  return rows;
};

const fetchPanelStatusRows = async (
  labId: string,
  from: string,
  to: string,
  shouldFilter: boolean,
  locationIds: string[],
) => {
  const pageSize = 1000;
  const rows: any[] = [];

  for (let start = 0; ; start += pageSize) {
    let query = supabase
      .from("v_result_panel_status")
      .select("*")
      .eq("lab_id", labId)
      .gte("order_date", from)
      .lte("order_date", to)
      // order_date alone is not unique (every panel of a day shares it), so paging
      // on it can repeat/drop rows across pages. Tie-break on the view's grain.
      .order("order_date", { ascending: false })
      .order("order_id", { ascending: true })
      .order("test_group_id", { ascending: true })
      .range(start, start + pageSize - 1);

    if (shouldFilter && locationIds.length > 0) {
      query = query.in("location_id", locationIds);
    }

    const { data, error } = await query;
    if (error) throw error;

    rows.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }

  return rows;
};

const OrderVerificationView: React.FC<OrderVerificationViewProps> = ({ onBackToPanel }) => {
  const [from, setFrom] = useState(fromYesterdayISO());
  const [to, setTo] = useState(todayISO());
  const [q, setQ] = useState("");
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");
  const [doctorFilter, setDoctorFilter] = useState("all");
  const [accountFilter, setAccountFilter] = useState("all");
  const [orderSortMode, setOrderSortMode] = useState<OrderSortMode>("sample_desc");
  const [panels, setPanels] = useState<PanelRow[]>([]);
  const [orderProgressTotalsById, setOrderProgressTotalsById] = useState<Record<string, OrderProgressTotals>>({});
  const [orderSortTimestampById, setOrderSortTimestampById] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rowsByResult, setRowsByResult] = useState<Record<string, Analyte[]>>({});
  const [openOrders, setOpenOrders] = useState<Record<string, boolean>>({});
  const [openPanels, setOpenPanels] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [remarksByResult, setRemarksByResult] = useState<Record<string, string>>({});
  const [remarkDirty, setRemarkDirty] = useState<Record<string, boolean>>({});
  const [remarkSaving, setRemarkSaving] = useState<Record<string, boolean>>({});
  const [attachmentsByOrder, setAttachmentsByOrder] = useState<Record<string, Attachment[]>>({});
  const [attachmentViewMode, setAttachmentViewMode] = useState<AttachmentViewMode>("test");
  const [selectedOrders, setSelectedOrders] = useState<Set<string>>(new Set());
  const [bulkProcessing, setBulkProcessing] = useState(false);
  const [showAllAnalytesLoading, setShowAllAnalytesLoading] = useState<Record<string, boolean>>({});
  const [showAttachmentSelector, setShowAttachmentSelector] = useState(false);
  const [selectedOrderForAttachments, setSelectedOrderForAttachments] = useState<string | null>(null);
  const [includeTrendsInReport, setIncludeTrendsInReport] = useState<Record<string, boolean>>({});
  const [includeSummaryInReport, setIncludeSummaryInReport] = useState<Record<string, boolean>>({});
  const [savingReportExtras, setSavingReportExtras] = useState<Record<string, boolean>>({});
  const [currentLabId, setCurrentLabId] = useState<string | null>(null);
  const [trendData, setTrendData] = useState<Record<string, any[]>>({});
  const [showTrendModal, setShowTrendModal] = useState(false);
  const [selectedAnalyteTrend, setSelectedAnalyteTrend] = useState<{ parameter: string; patientId: string } | null>(null);
  const [loadingTrend, setLoadingTrend] = useState(false);
  const [aiVerifierSummary, setAiVerifierSummary] = useState<Record<string, VerifierSummaryResponse>>({});
  const [aiClinicalSummary, setAiClinicalSummary] = useState<Record<string, ClinicalSummaryResponse>>({});
  const [aiGeneratedInterpretations, setAiGeneratedInterpretations] = useState<Record<string, GeneratedInterpretation[]>>({});
  const [showAiSummaryModal, setShowAiSummaryModal] = useState(false);
  const [aiSummaryTarget, setAiSummaryTarget] = useState<{ type: "verifier" | "clinical"; resultId?: string; orderId?: string } | null>(null);
  const [showInterpretationsModal, setShowInterpretationsModal] = useState(false);
  const [interpretationsTargetResultId, setInterpretationsTargetResultId] = useState<string | null>(null);
  // AI Delta Check state - quality control comparing current vs historical values
  const [aiDeltaCheckResults, setAiDeltaCheckResults] = useState<Record<string, DeltaCheckResponse>>({});
  const [showDeltaCheckModal, setShowDeltaCheckModal] = useState(false);
  const [deltaCheckTargetResultId, setDeltaCheckTargetResultId] = useState<string | null>(null);
  // Order-level AI Delta Check state - comprehensive order validation with inter-test group analysis
  const [orderDeltaCheckResults, setOrderDeltaCheckResults] = useState<Record<string, OrderDeltaCheckResponse>>({});
  const [showOrderDeltaCheckModal, setShowOrderDeltaCheckModal] = useState(false);
  const [orderDeltaCheckTargetOrderId, setOrderDeltaCheckTargetOrderId] = useState<string | null>(null);
  const [generatingOrderDeltaCheck, setGeneratingOrderDeltaCheck] = useState<Record<string, boolean>>({});
  // Track clinical summary options per order
  const [sendSummaryToDoctor, setSendSummaryToDoctor] = useState<Record<string, boolean>>({});
  // Loading state for clinical summary generation per order
  const [generatingClinicalSummary, setGeneratingClinicalSummary] = useState<Record<string, boolean>>({});
  // Patient Summary state
  const [aiPatientSummary, setAiPatientSummary] = useState<Record<string, PatientSummaryResponse>>({});
  const [generatingPatientSummary, setGeneratingPatientSummary] = useState<Record<string, boolean>>({});
  const [showPatientSummaryModal, setShowPatientSummaryModal] = useState(false);
  const [patientSummaryTarget, setPatientSummaryTarget] = useState<{ orderId: string; patientName?: string; referringDoctor?: string } | null>(null);
  const [labPreferredLanguage, setLabPreferredLanguage] = useState<SupportedLanguage>('english');

  const [isAdmin, setIsAdmin] = useState(false);

  // Quick preview state
  const [labPrintOptions, setLabPrintOptions] = useState<Record<string, unknown>>({});
  const [labPdfLayoutSettings, setLabPdfLayoutSettings] = useState<Record<string, any>>({});
  // Per-lab configurable patient-field list + custom field labels (same source the PDF uses).
  const [labPatientInfoConfig, setLabPatientInfoConfig] = useState<{ layout?: string; fields: string[] } | null>(null);
  const [labExtraFieldConfigs, setLabExtraFieldConfigs] = useState<Array<{ field_key: string; label: string }>>([]);
  const [labSignatoryDefaults, setLabSignatoryDefaults] = useState<{ name: string; designation: string }>({ name: "", designation: "" });
  const [quickPreview, setQuickPreview] = useState<{ html: string; patientName: string } | null>(null);
  const [quickPreviewLoading, setQuickPreviewLoading] = useState<Record<string, boolean>>({});
  const previewIframeRef = useRef<HTMLIFrameElement>(null);

  // Default flag options - will be merged with lab settings if available
  const DEFAULT_FLAG_OPTIONS = [
    { value: '', label: 'Normal' },
    { value: 'H', label: 'High' },
    { value: 'L', label: 'Low' },
    { value: 'C', label: 'Critical' },
    { value: 'critical_h', label: 'Critical High' },
    { value: 'critical_l', label: 'Critical Low' },
    { value: 'A', label: 'Abnormal' },
  ];
  const [labFlagOptions, setLabFlagOptions] = useState(DEFAULT_FLAG_OPTIONS);

  // Maps any raw DB flag variant → one of the 7 labFlagOptions values
  const getNormalizedFlag = (flag: string | null | undefined): string => {
    if (!flag) return '';
    const f = flag.trim().toLowerCase().replace(/[-\s]/g, '_');
    // Normal
    if (f === '' || f === 'normal' || f === 'n' || f === 'neg' || f === 'negative') return '';
    // High
    if (f === 'h' || f === 'high' || f === 'hi' || f === 'hh') return 'H';
    // Low
    if (f === 'l' || f === 'low' || f === 'll') return 'L';
    // Critical High (before generic "critical" check)
    if (f === 'critical_h' || f === 'critical_high' || f === 'criticalh' ||
        f === 'ch' || f === 'high_critical') return 'critical_h';
    // Critical Low (before generic "critical" check)
    if (f === 'critical_l' || f === 'critical_low' || f === 'criticall' ||
        f === 'cl' || f === 'low_critical') return 'critical_l';
    // Generic Critical
    if (f === 'c' || f === 'critical' || f === 'crit' || f === 'crit.' ||
        f === 'panic' || f === 'pnc') return 'C';
    // Abnormal
    if (f === 'a' || f === 'abnormal' || f === 'abn' || f === 'pos' || f === 'positive') return 'A';
    // Fallback: return as-is (may still match a dropdown value like 'H','L','C','A','critical_h','critical_l')
    return flag.trim();
  };

  // Returns Tailwind CSS classes for the flag select element background/text/border
  const getFlagSelectClass = (normalizedFlag: string): string => {
    if (normalizedFlag === 'H' || normalizedFlag === 'critical_h')
      return 'bg-red-100 text-red-800 border-red-300';
    if (normalizedFlag === 'L' || normalizedFlag === 'critical_l')
      return 'bg-blue-100 text-blue-800 border-blue-300';
    if (normalizedFlag === 'C')
      return 'bg-red-200 text-red-900 border-red-400';
    if (normalizedFlag === 'A')
      return 'bg-amber-100 text-amber-800 border-amber-300';
    return 'bg-gray-50 text-gray-600 border-gray-300';
  };

  const aiIntelligence = useAIResultIntelligence();

  const getDailySeq = (order: Pick<OrderGroup, "orderNumber" | "sampleId">) => {
    if (typeof order.orderNumber === "number" && Number.isFinite(order.orderNumber)) return order.orderNumber;
    const tail = String(order.sampleId || "").match(/(?:^|[/-])(\d+)\s*$/)?.[1] || "";
    const parsed = parseInt(tail, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  };

  // Check if current user is admin (for reopen-for-correction feature)
  useEffect(() => {
    const checkAdmin = async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return;
        const { data: userData } = await supabase
          .from('users')
          .select('role')
          .eq('id', user.id)
          .single();
        const role = (userData?.role || '').toLowerCase();
        setIsAdmin(['admin', 'super_admin', 'lab_admin'].includes(role));
      } catch { /* ignore */ }
    };
    checkAdmin();
  }, []);

  useEffect(() => {
    const fetchLabId = async () => {
      const labId = await database.getCurrentUserLabId();
      setCurrentLabId(labId);

      // Fetch pdf_layout_settings and flag_options for basic preview
      if (labId) {
        try {
          const { data: labData } = await supabase
            .from("labs")
            .select("pdf_layout_settings, default_signatory_name, default_signatory_designation, flag_options, report_patient_info_config")
            .eq("id", labId)
            .single();
          if (labData?.pdf_layout_settings) {
            setLabPdfLayoutSettings(labData.pdf_layout_settings as Record<string, any>);
            if (labData.pdf_layout_settings.printOptions) {
              setLabPrintOptions(labData.pdf_layout_settings.printOptions as Record<string, unknown>);
            }
          }
          // Patient-field config drives which patient fields the report shows (parity with PDF).
          const patientInfoCfg = (labData as any)?.report_patient_info_config;
          if (patientInfoCfg && Array.isArray(patientInfoCfg.fields)) {
            setLabPatientInfoConfig(patientInfoCfg as { layout?: string; fields: string[] });
          }
          const { data: fieldConfigs } = await supabase
            .from("lab_patient_field_configs")
            .select("field_key, label, sort_order")
            .eq("lab_id", labId)
            .order("sort_order");
          if (Array.isArray(fieldConfigs) && fieldConfigs.length > 0) {
            setLabExtraFieldConfigs(
              fieldConfigs.map((f: any) => ({ field_key: f.field_key, label: f.label })),
            );
          }
          setLabSignatoryDefaults({
            name: labData?.default_signatory_name || "",
            designation: labData?.default_signatory_designation || "",
          });
          // Merge lab flag options with defaults (lab options take precedence, defaults fill gaps)
          if (labData?.flag_options && Array.isArray(labData.flag_options) && labData.flag_options.length > 0) {
            const labFlags = labData.flag_options as { value: string; label: string }[];
            // Create merged list: lab options first, then any defaults not in lab options
            const labValues = new Set(labFlags.map(f => f.value));
            const merged = [
              ...labFlags,
              ...DEFAULT_FLAG_OPTIONS.filter(d => !labValues.has(d.value))
            ];
            setLabFlagOptions(merged);
          }
        } catch { /* non-critical, preview will fall back to defaults */ }
      }
    };
    fetchLabId();
  }, []);

  const loadPanels = async () => {
    setLoading(true);
    setError(null);

    // Get current lab ID for filtering
    const labId = currentLabId || await database.getCurrentUserLabId();
    if (!labId) {
      setError("No lab context found. Please log in again.");
      setPanels([]);
      setLoading(false);
      return;
    }

    const { shouldFilter, locationIds } = await database.shouldFilterByLocation();

    let data: any[];
    try {
      data = await fetchPanelStatusRows(labId, from, to, shouldFilter, locationIds);
    } catch (error: any) {
      setError(error?.message || "Failed to load verification panels");
      setPanels([]);
      setLoading(false);
      return;
    }

	      const basePanels = (data || []) as PanelRow[];
      const needsStatusFallback = basePanels.some((row) => !Object.prototype.hasOwnProperty.call(row, "result_verification_status"));
      const resultIds = Array.from(new Set(basePanels
          .filter((row) =>
            row.has_result === true ||
            (row.has_result === undefined && (
              (row.entered_analytes || 0) > 0 ||
              (row.handled_analytes || 0) > 0 ||
              row.panel_ready ||
              !!row.is_section_only
            ))
          )
          .map((row) => row.result_id)
          .filter(Boolean)));
      const baseOrderIds = Array.from(new Set(basePanels.map((row) => row.order_id).filter(Boolean)));

      if (baseOrderIds.length > 0) {
        const { data: progressRows, error: progressErr } = await supabase
          .from("v_order_test_progress_enhanced")
          .select("order_id, expected_analytes, entered_analytes, is_verified, panel_status")
          .in("order_id", baseOrderIds);

        if (progressErr) {
          console.warn("Unable to load dashboard-style order progress totals:", progressErr);
          setOrderProgressTotalsById({});
        } else {
          const totals: Record<string, OrderProgressTotals> = {};
          (progressRows || []).forEach((row: any) => {
            const orderId = row.order_id;
            if (!orderId) return;
            const expected = Number(row.expected_analytes || 0);
            const entered = Math.min(Number(row.entered_analytes || 0), expected);
            const verified = !!row.is_verified || row.panel_status === "Verified";
            if (!totals[orderId]) totals[orderId] = { expected: 0, entered: 0, approved: 0 };
            totals[orderId].expected += expected;
            totals[orderId].entered += entered;
            if (verified) totals[orderId].approved += entered;
          });
          setOrderProgressTotalsById(totals);
        }
      } else {
        setOrderProgressTotalsById({});
      }

      if (basePanels.length > 0) {
        const resultStatuses = await fetchRowsByIds("results", "id, verification_status, notes", resultIds);

        const resultMap = new Map(resultStatuses.map((row: any) => [row.id, row]));
        const panelRows = basePanels.map((row) => {
          const result = resultMap.get(row.result_id) as any;
          return {
            ...row,
            result_verification_status: row.result_verification_status ?? (needsStatusFallback ? result?.verification_status ?? null : null),
            notes: result?.notes ?? row.notes ?? null,
          };
        });
        setPanels(panelRows);
        setRemarksByResult((current) => {
          const next = { ...current };
          for (const panel of panelRows) {
            if (!remarkDirty[panel.result_id]) next[panel.result_id] = panel.notes || "";
          }
          return next;
        });

        // Enrich panel rows with order metadata for sample sorting and cross-page filters.
        try {
          const orderIds = Array.from(new Set(panelRows.map((row) => row.order_id).filter(Boolean)));
          if (orderIds.length > 0) {
            const orderRows = await fetchRowsByIds(
              "orders",
              "id, created_at, order_date, sample_id, order_number, doctor, account_id, priority, accounts(name)",
              orderIds,
            );

            const nextSortMap: Record<string, number> = {};
            const orderMeta = new Map<string, Partial<PanelRow>>();
            orderRows.forEach((o: any) => {
              const ts = new Date(o.created_at || o.order_date).getTime();
              if (Number.isFinite(ts)) nextSortMap[o.id] = ts;
              const accountInfo = Array.isArray(o.accounts) ? o.accounts[0] : o.accounts;
              orderMeta.set(o.id, {
                sample_id: o.sample_id || null,
                order_number: o.order_number ?? null,
                doctor: o.doctor || null,
                account_id: o.account_id || null,
                account_name: accountInfo?.name || null,
                priority: o.priority || "Normal",
              });
            });
            setPanels(panelRows.map(row => ({ ...row, ...(orderMeta.get(row.order_id) || {}) })));
            setOrderSortTimestampById(nextSortMap);
          } else {
            setOrderSortTimestampById({});
          }
        } catch (sortErr) {
          console.warn("Unable to fetch order created_at for sort fallback:", sortErr);
          setOrderSortTimestampById({});
        }
      } else {
        setPanels(basePanels);
        setOrderSortTimestampById({});
      }
	    setLoading(false);
	  };

  useEffect(() => {
    if (currentLabId) {
      loadPanels();
    }
  }, [from, to, currentLabId]);

  const groupByOrder = useMemo(() => {
    // Prefer the view's real-result marker. Older databases do not expose it,
    // so fall back to the previous entered/handled analyte behavior.
    const filtered = (panels || []).filter(row => {
      const hasResultForVerification =
        row.has_result === true ||
        (row.has_result === undefined && (
          (row?.entered_analytes || 0) > 0 ||
          (row?.handled_analytes || 0) > 0 ||
          !!row.is_section_only
        ));
      if (!hasResultForVerification) return false;

	      const matchesSearch = q
	        ? (row.patient_name || "").toLowerCase().includes(q.toLowerCase()) ||
	        (row.test_group_name || "").toLowerCase().includes(q.toLowerCase()) ||
	        row.order_id.toLowerCase().includes(q.toLowerCase()) ||
	        (row.sample_id || "").toLowerCase().includes(q.toLowerCase())
	        : true;

	      if (!matchesSearch) return false;
      if (doctorFilter !== "all" && !(row.doctor || "").toLowerCase().includes(doctorFilter.toLowerCase())) return false;
      if (accountFilter !== "all" && !(row.account_name || "").toLowerCase().includes(accountFilter.toLowerCase())) return false;

      if (stateFilter === "ready") {
        return row.is_section_only
          ? row.result_verification_status === "verified"
          : row.panel_ready;
      }
	      if (stateFilter === "pending") {
	        return row.is_section_only
	          ? row.result_verification_status !== "verified"
	          : (!row.panel_ready && (row.approved_analytes || 0) === 0);
	      }
	      if (stateFilter === "partial") {
	        return row.is_section_only
	          ? false
	          : (
	              !row.panel_ready &&
	              (row.approved_analytes || 0) > 0 &&
	              (row.approved_analytes || 0) < row.expected_analytes
	            );
	      }
      return true;
    });

    const bucket: Record<string, OrderGroup> = {};

    filtered.forEach(row => {
      if (!bucket[row.order_id]) {
        bucket[row.order_id] = {
          orderId: row.order_id,
          patientId: row.patient_id,
	          patientName: row.patient_name,
	          orderDate: row.order_date,
	          sortTimestamp: orderSortTimestampById[row.order_id] ?? new Date(row.order_date).getTime(),
          sampleId: row.sample_id || null,
          orderNumber: row.order_number ?? null,
          doctor: row.doctor || null,
          accountName: row.account_name || null,
          priority: row.priority || "Normal",
	          panels: [],
	          stats: {
	            expected: 0,
	            entered: 0,
	            approved: 0,
	            hidden: 0,
	            handled: 0,
	            readyPanels: 0
	          }
        };
      }

      bucket[row.order_id].panels.push(row);
	      bucket[row.order_id].stats.expected += row.expected_analytes;
	      bucket[row.order_id].stats.entered += row.entered_analytes;
	      bucket[row.order_id].stats.approved += row.approved_analytes;
	      bucket[row.order_id].stats.hidden += row.hidden_analytes || 0;
	      bucket[row.order_id].stats.handled += row.handled_analytes || row.entered_analytes || 0;
      if (row.is_section_only ? row.result_verification_status === "verified" : row.panel_ready) {
        bucket[row.order_id].stats.readyPanels += 1;
      }

      const rowTs = orderSortTimestampById[row.order_id] ?? new Date(row.order_date).getTime();
      if (Number.isFinite(rowTs)) {
        bucket[row.order_id].sortTimestamp = Math.max(bucket[row.order_id].sortTimestamp, rowTs);
      }
    });

    Object.values(bucket).forEach(order => {
      const dashboardTotals = orderProgressTotalsById[order.orderId];
      if (!dashboardTotals) return;
      order.stats.expected = dashboardTotals.expected;
      order.stats.entered = Math.max(dashboardTotals.entered, order.stats.handled);
      order.stats.approved = Math.max(order.stats.approved, dashboardTotals.approved);
      order.stats.handled = Math.max(order.stats.handled, order.stats.entered);
    });

	    return Object.values(bucket).sort((a, b) => {
      if (orderSortMode === "patient_az") {
        return a.patientName.localeCompare(b.patientName);
      }

      if (orderSortMode === "date_desc") {
        const dateDiff = new Date(b.orderDate).getTime() - new Date(a.orderDate).getTime();
        if (dateDiff !== 0) return dateDiff;
      }

      const nA = getDailySeq(a);
      const nB = getDailySeq(b);
      if (nA !== nB) return orderSortMode === "sample_asc" ? nA - nB : nB - nA;
	      if (b.sortTimestamp !== a.sortTimestamp) return b.sortTimestamp - a.sortTimestamp;
	      return b.orderId.localeCompare(a.orderId);
	    });
	  }, [panels, q, stateFilter, doctorFilter, accountFilter, orderSortMode, orderSortTimestampById, orderProgressTotalsById]);

  const doctorOptions = useMemo(() => (
    Array.from(new Set((panels || []).map(row => row.doctor).filter(Boolean) as string[])).sort()
  ), [panels]);

  const accountOptions = useMemo(() => (
    Array.from(new Set((panels || []).map(row => row.account_name).filter(Boolean) as string[])).sort()
  ), [panels]);

  const stats = useMemo(() => {
    const totalOrders = groupByOrder.length;
    const readyOrders = groupByOrder.filter(order => order.stats.readyPanels === order.panels.length).length;
    const pendingOrders = groupByOrder.filter(order => order.stats.readyPanels === 0).length;
    const partialOrders = totalOrders - readyOrders - pendingOrders;
    return { totalOrders, readyOrders, pendingOrders, partialOrders };
  }, [groupByOrder]);

  // Returns analytes data directly AND caches in state
  const ensureAnalytesLoaded = async (resultId: string, forceRefresh = false): Promise<Analyte[]> => {
    // Return cached data if available and not forcing refresh
    if (!forceRefresh && rowsByResult[resultId]) return rowsByResult[resultId];

    const { data, error } = await supabase
      .from("result_values")
      .select(
	        "id,result_id,analyte_id,parameter,value,unit,reference_range,flag,flag_source,flag_confidence,ai_interpretation,ai_audit_status,verify_status,verify_note,verified_by,verified_at,is_hidden_from_report,hidden_reason"
      )
      .eq("result_id", resultId)
      .order("parameter", { ascending: true });

    if (!error && data) {
      const testGroupId = panels.find((panel) => panel.result_id === resultId)?.test_group_id;
      const analytes = await loadOrderedAnalyteRows(
        supabase,
        testGroupId,
        data as unknown as Analyte[]
      );
      setRowsByResult(prev => ({ ...prev, [resultId]: analytes }));
      return analytes;
    }

    if (error && `${error.message}`.includes("verify_status")) {
      const fallback = await supabase
        .from("result_values")
        .select("id,result_id,analyte_id,parameter,value,unit,reference_range,flag,flag_source,flag_confidence,ai_interpretation")
        .eq("result_id", resultId)
        .order("parameter", { ascending: true });

      if (!fallback.error && fallback.data) {
        const mapped = (fallback.data || []).map((row: any) => ({
          id: row.id,
          result_id: row.result_id,
          analyte_id: row.analyte_id,
          parameter: row.parameter,
          value: row.value,
          unit: row.unit,
          reference_range: row.reference_range,
          flag: row.flag,
          flag_source: row.flag_source,
          flag_confidence: row.flag_confidence,
          ai_interpretation: row.ai_interpretation,
	          ai_audit_status: null,
	          verify_status: "pending",
	          verify_note: null,
	          verified_by: null,
	          verified_at: null,
	          is_hidden_from_report: false,
	          hidden_reason: null
	        })) as Analyte[];
        const testGroupId = panels.find((panel) => panel.result_id === resultId)?.test_group_id;
        const ordered = await loadOrderedAnalyteRows(supabase, testGroupId, mapped);
        setRowsByResult(prev => ({ ...prev, [resultId]: ordered }));
        return ordered;
      }
    }

    return []; // Return empty array if all else fails
  };

  const loadAttachments = async (orderId: string) => {
    if (attachmentsByOrder[orderId]) return;
    try {
      const { data, error } = await supabase
        .from("attachments")
        .select("id,file_url,file_type,original_filename,created_at,order_test_id")
        .eq("order_id", orderId)
        .order("created_at", { ascending: false });

      if (error) throw error;

      const attachments: Attachment[] = (data || []).map(att => ({
        id: att.id,
        file_url: att.file_url,
        file_type: att.file_type,
        original_filename: att.original_filename,
        created_at: att.created_at,
        level: att.order_test_id ? "test" : "order"
      }));

      setAttachmentsByOrder(prev => ({ ...prev, [orderId]: attachments }));
    } catch (err) {
      console.error("Failed to load attachments", err);
    }
  };

  const loadTrendData = async (patientId: string, parameter: string) => {
    const cacheKey = `${patientId}-${parameter}`;
    if (trendData[cacheKey]) {
      setSelectedAnalyteTrend({ patientId, parameter });
      setShowTrendModal(true);
      return;
    }

    setLoadingTrend(true);
    try {
      // 1. Get analyte_id for the parameter name if we don't have it
      // In this view, we generally have access to rowsByResult which has analytes with analyte_id
      let targetedAnalyteId: string | undefined;
      Object.values(rowsByResult).forEach(analytes => {
        const found = analytes.find(a => a.parameter === parameter);
        if (found?.analyte_id) targetedAnalyteId = found.analyte_id;
      });

      // 2. Query view_patient_history which includes both internal and external data
      let query = supabase
        .from("view_patient_history")
        .select("result_date, value, unit, reference_range, source")
        .eq("patient_id", patientId)
        .order("result_date", { ascending: false })
        .limit(15);

      if (targetedAnalyteId) {
        query = query.eq("analyte_id", targetedAnalyteId);
      } else {
        // Fallback: If no ID, we might have to rely on internal results only 
        // or join with analytes table. But for now, let's try to find it.
        const { data: analyteInfo } = await supabase
          .from("analytes")
          .select("id")
          .eq("name", parameter)
          .maybeSingle();
        if (analyteInfo) {
          query = query.eq("analyte_id", analyteInfo.id);
        } else {
          // If still no ID, use legacy view for internal data only as fallback
          const { data: legacyData } = await supabase
            .from("v_report_template_context")
            .select("order_date, analytes")
            .eq("patient_id", patientId)
            .order("order_date", { ascending: false })
            .limit(10);

          const extracted = (legacyData || []).flatMap((row: any) => {
            const analytes = row.analytes || [];
            return analytes
              .filter((a: any) => a.parameter === parameter)
              .map((a: any) => ({
                order_date: row.order_date,
                test_name: a.parameter,
                value: a.value,
                unit: a.unit,
                reference_range: a.reference_range,
                flag: a.flag
              }));
          });
          setTrendData(prev => ({ ...prev, [cacheKey]: extracted }));
          setSelectedAnalyteTrend({ patientId, parameter });
          setShowTrendModal(true);
          return;
        }
      }

      const { data, error } = await query;
      if (error) throw error;

      const extracted = (data || []).map((row: any) => ({
        order_date: row.result_date,
        test_name: parameter,
        value: row.value,
        unit: row.unit,
        reference_range: row.reference_range,
        flag: null, // Basic view doesn't have flags yet
        source: row.source
      }));

      setTrendData(prev => ({ ...prev, [cacheKey]: extracted }));
      setSelectedAnalyteTrend({ patientId, parameter });
      setShowTrendModal(true);
    } catch (err) {
      console.error("Failed to load trend data", err);
      alert("Failed to load trend data");
    } finally {
      setLoadingTrend(false);
    }
  };

  const toggleOrder = async (orderId: string) => {
    const isOpening = !openOrders[orderId];
    setOpenOrders(prev => ({ ...prev, [orderId]: !prev[orderId] }));
    if (!attachmentsByOrder[orderId]) await loadAttachments(orderId);
    if (isOpening) {
      const orderPanels = panels.filter(panel => panel.order_id === orderId);
      await Promise.all(orderPanels.map(panel => ensureAnalytesLoaded(panel.result_id)));
    }
  };

  const togglePanel = async (resultId: string) => {
    const isOpening = !openPanels[resultId];
    setOpenPanels(prev => ({ ...prev, [resultId]: !prev[resultId] }));
    // Always re-fetch from DB when opening a panel so flag values are never stale
    if (isOpening) await ensureAnalytesLoaded(resultId, true);
  };

  const setBusyFor = (key: string, val: boolean) => setBusy(prev => ({ ...prev, [key]: val }));

  const saveGroupRemark = async (panel: PanelRow, silent = false): Promise<boolean> => {
    const notes = remarksByResult[panel.result_id]?.trim() || null;
    setRemarkSaving((current) => ({ ...current, [panel.result_id]: true }));
    const { error } = await supabase
      .from("results")
      .update({ notes })
      .eq("id", panel.result_id);
    setRemarkSaving((current) => ({ ...current, [panel.result_id]: false }));

    if (error) {
      console.error("Failed to save report remark", error);
      if (!silent) alert("Failed to save report remark");
      return false;
    }

    setRemarkDirty((current) => ({ ...current, [panel.result_id]: false }));
    setPanels((current) => current.map((row) =>
      row.result_id === panel.result_id ? { ...row, notes } : row
    ));
    return true;
  };

  const approveAnalyte = async (analyteId: string) => {
    setBusyFor(analyteId, true);
    const { error } = await supabase
      .from("result_values")
      .update({ verify_status: "approved", verified_at: new Date().toISOString() })
      .eq("id", analyteId);
    setBusyFor(analyteId, false);

    if (!error) {
      setRowsByResult(prev => {
        const next = { ...prev };
        Object.keys(next).forEach(resultId => {
          next[resultId] = next[resultId].map(analyte => (analyte.id === analyteId ? { ...analyte, verify_status: "approved" } : analyte));
        });
        return next;
      });
      await loadPanels();
    }
  };

  const rejectAnalyte = async (analyteId: string) => {
    const note = prompt("Add a note (optional)", "") ?? null;
    setBusyFor(analyteId, true);
    const { error } = await supabase
      .from("result_values")
      .update({
        verify_status: "rejected",
        verify_note: note && note.length ? note : null,
        verified_at: new Date().toISOString()
      })
      .eq("id", analyteId);
    setBusyFor(analyteId, false);

    if (!error) {
      setRowsByResult(prev => {
        const next = { ...prev };
        Object.keys(next).forEach(resultId => {
          next[resultId] = next[resultId].map(analyte => (analyte.id === analyteId ? { ...analyte, verify_status: "rejected", verify_note: note } : analyte));
        });
        return next;
      });
      await loadPanels();
    }
  };

  const approvePanel = async (panel: PanelRow, analytes: Analyte[]) => {
    if (remarkDirty[panel.result_id]) {
      const remarkSaved = await saveGroupRemark(panel, true);
      if (!remarkSaved) {
        alert("Approval stopped because the report remark could not be saved.");
        return;
      }
    }

    if (panel.is_section_only) {
      setBusyFor(panel.result_id, true);
      try {
        const { error } = await supabase
          .from("results")
          .update({
            verification_status: "verified",
            verified_at: new Date().toISOString(),
            manually_verified: true,
          })
          .eq("id", panel.result_id);

        if (error) throw error;
        await loadPanels();
      } catch (err) {
        console.error("Failed to approve section-only panel", err);
      } finally {
        setBusyFor(panel.result_id, false);
      }
      return;
    }

    if (!analytes.length) return;
    const ids = analytes.map(a => a.id);
    setBusyFor(panel.result_id, true);
    setSavingReportExtras(prev => ({ ...prev, [panel.order_id]: true }));

    try {
      const { error } = await supabase
        .from("result_values")
        .update({ verify_status: "approved", verified_at: new Date().toISOString() })
        .in("id", ids);

      if (error) throw error;

      setRowsByResult(prev => ({
        ...prev,
        [panel.result_id]: (prev[panel.result_id] || []).map(analyte => ({ ...analyte, verify_status: "approved" }))
      }));

      if (includeSummaryInReport[panel.order_id] && aiClinicalSummary[panel.order_id]) {
        const summary = aiClinicalSummary[panel.order_id];
        await saveClinicalSummary(panel.result_id, {
          text: summary.clinical_interpretation || summary.executive_summary || "",
          recommendation: summary.suggested_followup?.join("\n"),
          generated_at: new Date().toISOString(),
          generated_by: "ai"
        });
      }

      await loadPanels();
    } catch (err) {
      console.error("Failed to approve panel", err);
    } finally {
      setBusyFor(panel.result_id, false);
      setSavingReportExtras(prev => ({ ...prev, [panel.order_id]: false }));
    }
  };

  // Update flag on a result_value and update local state
  const handleFlagChange = async (resultId: string, analyteId: string, newFlag: string) => {
    try {
      await supabase
        .from('result_values')
        .update({ flag: newFlag || null, flag_source: 'manual' })
        .eq('id', analyteId);

      // Update local state
      setRowsByResult(prev => {
        const rows = prev[resultId];
        if (!rows) return prev;
        return {
          ...prev,
          [resultId]: rows.map(a => a.id === analyteId ? { ...a, flag: newFlag || null, flag_source: 'manual' } : a)
        };
      });
    } catch (err) {
      console.error('Failed to update flag:', err);
    }
  };

  const reopenPanelForCorrection = async (panel: PanelRow) => {
    const reason = window.prompt("Reason for reopening this panel (required):");
    if (!reason?.trim()) {
      alert("A reason is required to reopen an approved panel.");
      return;
    }

    const confirmed = window.confirm(
      `Are you sure you want to reopen "${panel.test_group_name}" for correction?\n\n` +
      `This will:\n` +
      `- Reset all analyte approvals to Pending\n` +
      `- Invalidate the current report PDF\n` +
      `- Require re-approval after correction\n\n` +
      `Reason: ${reason}`
    );
    if (!confirmed) return;

    setBusyFor(panel.result_id, true);
    try {
      const now = new Date().toISOString();
      const { data: { user } } = await supabase.auth.getUser();

      // 1. Reset result_values for this panel
      const { error: rvError } = await supabase
        .from("result_values")
        .update({
          verify_status: "pending",
          verified_at: null,
          verified_by: null,
          verify_note: null,
        })
        .eq("result_id", panel.result_id);
      if (rvError) throw rvError;

      // 2. Reset results row
      const { error: resError } = await supabase
        .from("results")
        .update({
          verification_status: "pending_verification",
          verified_at: null,
          manually_verified: false,
          report_extras: null,
          is_locked: false,
          locked_reason: null,
          locked_at: null,
          locked_by: null,
        })
        .eq("id", panel.result_id);
      if (resError) throw resError;

      // 3. Clear stale report PDF
      await supabase
        .from("reports")
        .update({ pdf_url: null, status: "Draft" })
        .eq("order_id", panel.order_id);

      // 4. Downgrade order status if currently Completed
      await supabase
        .from("orders")
        .update({
          status: "Pending Approval",
          status_updated_at: now,
          status_updated_by: "Admin (Correction)",
        })
        .eq("id", panel.order_id)
        .eq("status", "Completed");

      // 5. Insert audit record
      await supabase.from("result_verification_audit").insert({
        result_id: panel.result_id,
        action: "reopened_for_correction",
        performed_by: user?.id || null,
        performed_at: now,
        previous_status: "approved",
        new_status: "pending_verification",
        comment: reason,
        metadata: {
          order_id: panel.order_id,
          test_group_name: panel.test_group_name,
          test_group_id: panel.test_group_id,
        },
      });

      // 6. Update local state
      setRowsByResult(prev => ({
        ...prev,
        [panel.result_id]: (prev[panel.result_id] || []).map(a => ({
          ...a,
          verify_status: "pending" as const,
          verified_at: null,
          verified_by: null,
          verify_note: null,
        })),
      }));

      await loadPanels();
      alert(`Panel "${panel.test_group_name}" reopened for correction.`);
    } catch (err) {
      console.error("Failed to reopen panel:", err);
      alert("Failed to reopen panel. Please try again.");
    } finally {
      setBusyFor(panel.result_id, false);
    }
  };

  const approveEntireOrder = async (order: OrderGroup) => {
    setBulkProcessing(true);
    try {
      for (const panel of order.panels) {
        // Use the freshly returned analytes instead of reading rowsByResult
        // immediately after setState, which can still be stale unless the UI
        // has already preloaded them via "Show All Analytes".
        const analytes = await ensureAnalytesLoaded(panel.result_id);
        await approvePanel(panel, analytes);
      }
    } finally {
      setBulkProcessing(false);
    }
  };

  const handleQuickPreview = async (order: OrderGroup) => {
    setQuickPreviewLoading(prev => ({ ...prev, [order.orderId]: true }));
    try {
      // 1. Ensure all analytes are loaded for every panel — capture returned values
      //    to avoid reading from stale rowsByResult closure after state updates
      const loadedAnalytes = await Promise.all(order.panels.map(p => ensureAnalytesLoaded(p.result_id)));
      const loadedByResultId = new Map(order.panels.map((p, i) => [p.result_id, loadedAnalytes[i]]));

      // 2. Fetch patient + order details, plus per-panel metadata in parallel
      const groupIds = order.panels.map(p => p.test_group_id).filter(Boolean) as string[];

      const allResultIds = order.panels.map(p => p.result_id);

      const fetchOrderForPreview = async () => {
        const primary = await supabase
          .from("orders")
          .select("sample_id, doctor, report_settings")
          .eq("id", order.orderId)
          .single();

        if (!primary.error) return primary;

        console.warn("[QuickPreview] orders rich select failed, retrying without report_settings", {
          orderId: order.orderId,
          error: primary.error,
        });

        return supabase
          .from("orders")
          .select("sample_id, doctor")
          .eq("id", order.orderId)
          .single();
      };

      const fetchTestGroupAnalyteMetaForPreview = async () => {
        if (groupIds.length === 0) return { data: [] as any[], error: null };

        const primary = await supabase
          .from("test_group_analytes")
          .select("test_group_id, analyte_id, sort_order, section_heading, analytes(name)")
          .in("test_group_id", groupIds);

        if (!primary.error) return primary;

        console.warn("[QuickPreview] test_group_analytes metadata select failed, retrying without analytes join", {
          groupIds,
          error: primary.error,
        });

        return supabase
          .from("test_group_analytes")
          .select("test_group_id, analyte_id, sort_order, section_heading")
          .in("test_group_id", groupIds);
      };

      const fetchVerifierForPreview = async () => {
        let verifierId: string | null = null;

        if (allResultIds.length > 0) {
          const rv = await supabase
            .from("result_values")
            .select("verified_by")
            .in("result_id", allResultIds)
            .not("verified_by", "is", null)
            .limit(1)
            .maybeSingle();

          if (rv.error) {
            console.warn("[QuickPreview] verifier result_values lookup failed", {
              resultIds: allResultIds,
              error: rv.error,
            });
          }
          verifierId = (rv.data?.verified_by as string) ?? null;
        }

        // Fall back to orders.approved_by — same as generate-pdf-letterhead — so the
        // signatory resolves for labs that record approval at the order level rather
        // than per result value.
        if (!verifierId) {
          const ord = await supabase
            .from("orders")
            .select("approved_by")
            .eq("id", order.orderId)
            .maybeSingle();
          if (ord.error) {
            console.warn("[QuickPreview] orders.approved_by lookup failed", {
              orderId: order.orderId,
              error: ord.error,
            });
          }
          verifierId = ((ord.data as any)?.approved_by as string) ?? null;
        }

        if (!verifierId) return { data: null as any, error: null };

        const user = await supabase
          .from("users")
          .select("name, role")
          .eq("id", verifierId)
          .maybeSingle();

        if (user.error) {
          console.warn("[QuickPreview] verifier user lookup failed", {
            userId: verifierId,
            error: user.error,
          });
        }

        return {
          data: {
            verified_by: verifierId,
            users: user.data || null,
          },
          error: user.error,
        };
      };

      const applySignatureTransformations = (url: string): string => {
        if (!url || !url.includes("ik.imagekit.io") || url.includes("tr=")) return url;
        try {
          const urlObj = new URL(url);
          const pathParts = urlObj.pathname.split("/");
          const insertIndex = pathParts.findIndex((part) => part && !part.includes(".")) + 1;
          pathParts.splice(insertIndex, 0, "tr:fo-auto,t-true");
          urlObj.pathname = pathParts.join("/");
          return urlObj.toString();
        } catch {
          return url;
        }
      };

      const getOptimizedSignatureUrl = (signature: any): string => {
        const variants = typeof signature?.variants === "string"
          ? (() => {
              try { return JSON.parse(signature.variants); } catch { return {}; }
            })()
          : signature?.variants;
        return variants?.optimized ||
          (signature?.imagekit_url ? applySignatureTransformations(signature.imagekit_url) : "") ||
          signature?.file_url ||
          "";
      };

      const fetchSignatoryForPreview = async (verifierUserId?: string | null, verifierUser?: any) => {
        const fallback = {
          name: verifierUser?.name || labSignatoryDefaults.name || "Authorized Signatory",
          designation: verifierUser?.role || labSignatoryDefaults.designation || "",
          imageUrl: "",
        };

        if (!currentLabId) return fallback;

        if (verifierUserId) {
          const { data: userSignature, error } = await supabase
            .from("lab_user_signatures")
            .select("imagekit_url, file_url, signature_name, is_default, variants")
            .eq("user_id", verifierUserId)
            .eq("lab_id", currentLabId)
            .eq("is_active", true)
            .order("is_default", { ascending: false })
            .limit(1)
            .maybeSingle();

          if (error) {
            console.warn("[QuickPreview] verifier signature lookup failed", error);
          }

          const sigUrl = getOptimizedSignatureUrl(userSignature);
          if (sigUrl) {
            return {
              name: userSignature?.signature_name || fallback.name,
              designation: userSignature?.signature_name ? "" : fallback.designation,
              imageUrl: sigUrl,
            };
          }
        }

        const { data: labSignature, error: labSigError } = await supabase
          .from("lab_branding_assets")
          .select("file_url, imagekit_url, asset_metadata")
          .eq("lab_id", currentLabId)
          .eq("asset_type", "signature")
          .eq("is_active", true)
          .order("is_default", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (labSigError) {
          console.warn("[QuickPreview] lab signature lookup failed", labSigError);
        }

        let sigUrl = labSignature?.imagekit_url
          ? applySignatureTransformations(labSignature.imagekit_url)
          : labSignature?.file_url || "";

        // The lab default signature carries its signatory name/designation in
        // asset_metadata — use it, same as the PDF's lab-default path.
        if (sigUrl) {
          const meta = (labSignature?.asset_metadata as any) || null;
          if (meta?.signatory_name) {
            fallback.name = meta.signatory_name;
            fallback.designation = meta.signatory_designation || "";
          }
        }

        if (!sigUrl) {
          const { data: anyUserSignature, error: anySigError } = await supabase
            .from("lab_user_signatures")
            .select("imagekit_url, file_url, signature_name, is_default, variants")
            .eq("lab_id", currentLabId)
            .eq("is_active", true)
            .order("is_default", { ascending: false })
            .limit(1)
            .maybeSingle();

          if (anySigError) {
            console.warn("[QuickPreview] fallback signature lookup failed", anySigError);
          }

          sigUrl = getOptimizedSignatureUrl(anyUserSignature);
          // Prefer the signature's own credentialed name over the generic fallback.
          if (
            sigUrl &&
            anyUserSignature?.signature_name &&
            (!fallback.name || fallback.name === "Authorized Signatory")
          ) {
            fallback.name = anyUserSignature.signature_name;
            fallback.designation = "";
          }
        }

        return { ...fallback, imageUrl: sigUrl };
      };

      const [patientRes, orderRes, tgaRes, tgRes, sectionsRes, verifierRes] = await Promise.all([
        supabase
          .from("patients")
          .select("age, age_unit, gender, display_id")
          .eq("id", order.patientId)
          .single(),
        fetchOrderForPreview(),
        // section_heading + sort_order + is_auto_calculated from test_group_analytes
        fetchTestGroupAnalyteMetaForPreview(),
        // per-group print_options override
        groupIds.length > 0
          ? supabase
              .from("test_groups")
              .select("id, print_options, group_interpretation")
              .in("id", groupIds)
          : Promise.resolve({ data: [] as any[], error: null }),
        // report sections (findings, impression, etc.)
        allResultIds.length > 0
          ? supabase
              .from("result_section_content")
              .select("result_id, final_content, lab_template_sections(section_name, display_order, section_type)")
              .in("result_id", allResultIds)
              .order("section_id")
          : Promise.resolve({ data: [] as any[], error: null }),
        // signatory: first verified_by user across all result_values
        fetchVerifierForPreview(),
      ]);

      [
        ["patients", patientRes.error],
        ["orders", orderRes.error],
        ["test_group_analytes", tgaRes.error],
        ["test_groups", tgRes.error],
        ["result_section_content", sectionsRes.error],
        ["verifier", verifierRes.error],
      ].forEach(([label, error]) => {
        if (error) {
          console.warn(`[QuickPreview] ${label} query returned an error`, error);
        }
      });

      // ── Patient fields ──────────────────────────────────────────────────────────
      // Resolve from the SAME source the PDF uses — the get_report_template_context RPC
      // plus the identical enrichment queries generate-pdf-letterhead runs — so the
      // preview's patient fields (including custom/special fields) match the PDF exactly.
      const formatPatientAgeDisplay = (age: unknown, ageUnit?: string | null): string => {
        if (age === null || age === undefined || age === "") return "";
        const numAge = typeof age === "number" ? age : parseInt(String(age), 10);
        if (Number.isNaN(numAge)) return String(age);
        const unit = (ageUnit || "years").toLowerCase();
        const singular: Record<string, string> = { years: "Year", months: "Month", days: "Day" };
        const plural: Record<string, string> = { years: "Years", months: "Months", days: "Days" };
        const word = numAge === 1 ? (singular[unit] || "Year") : (plural[unit] || "Years");
        return `${numAge} ${word}`;
      };
      // Registration/order date → DD-MM-YYYY, matching the PDF's {{orderDate}} formatting.
      const toDDMMYYYY = (raw: unknown): string => {
        if (!raw) return "";
        const s = String(raw);
        const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (m) return `${m[3]}-${m[2]}-${m[1]}`;
        const d = new Date(s);
        if (!Number.isNaN(d.getTime())) {
          const dd = String(d.getDate()).padStart(2, "0");
          const mm = String(d.getMonth() + 1).padStart(2, "0");
          return `${dd}-${mm}-${d.getFullYear()}`;
        }
        return s;
      };

      let reportCtx: any = null;
      const patientFieldValues: Record<string, string> = {};
      let reportDateResolved = "";
      // Seed core fields from the always-available queries so they resolve even if the
      // RPC is unavailable. The RPC below overrides these with richer, timezone-formatted
      // values and adds the special fields (phone, collection/received dates, B2B, etc.).
      Object.assign(patientFieldValues, {
        patientName: order.patientName || "",
        patientId: patientRes.data?.display_id ?? "",
        registrationDate: toDDMMYYYY(order.orderDate),
        age: formatPatientAgeDisplay(patientRes.data?.age, patientRes.data?.age_unit),
        gender: patientRes.data?.gender ?? "",
        sampleId: orderRes.data?.sample_id ?? "",
        referringDoctorName: orderRes.data?.doctor ?? "",
      });
      try {
        const { data: ctx, error: ctxErr } = await supabase.rpc(
          "get_report_template_context",
          { p_order_id: order.orderId },
        );
        if (ctxErr) console.warn("[QuickPreview] get_report_template_context failed", ctxErr);
        reportCtx = ctx || null;

        // Same enrichment the PDF performs: patient custom fields + raw collector,
        // B2B account name, and collection-center location name.
        const [pEnrich, oEnrich] = await Promise.all([
          supabase
            .from("patients")
            .select("custom_fields, age_unit")
            .eq("id", (reportCtx?.patientId as string) ?? order.patientId)
            .maybeSingle(),
          supabase
            .from("orders")
            .select("sample_collected_by, account_id, location_id, collected_at_location_id")
            .eq("id", order.orderId)
            .maybeSingle(),
        ]);

        let b2bAccountName = "";
        let collectionCenterName =
          reportCtx?.order?.collectionCenter || reportCtx?.order?.locationName || "";
        if (oEnrich.data) {
          const accountId = (oEnrich.data as any).account_id;
          const locId =
            (oEnrich.data as any).collected_at_location_id || (oEnrich.data as any).location_id;
          const [acc, loc] = await Promise.all([
            accountId
              ? supabase.from("accounts").select("name").eq("id", accountId).maybeSingle()
              : Promise.resolve({ data: null } as any),
            locId
              ? supabase.from("locations").select("name").eq("id", locId).maybeSingle()
              : Promise.resolve({ data: null } as any),
          ]);
          b2bAccountName = (acc.data as any)?.name || "";
          collectionCenterName = (loc.data as any)?.name || collectionCenterName;
        }

        const cp = (reportCtx?.patient || {}) as any;
        const co = (reportCtx?.order || {}) as any;
        const ageUnit = (pEnrich.data as any)?.age_unit || "years";
        // Mirror generate-pdf-letterhead's flatAliases resolution key-for-key.
        Object.assign(patientFieldValues, {
          patientName: cp.name || order.patientName || "",
          patientId: cp.displayId || cp.id || (patientRes.data?.display_id ?? ""),
          registrationDate: toDDMMYYYY(reportCtx?.meta?.orderDate) || toDDMMYYYY(order.orderDate),
          age: formatPatientAgeDisplay(cp.age ?? patientRes.data?.age, ageUnit),
          gender: cp.gender || (patientRes.data?.gender ?? ""),
          phone: cp.phone || "",
          sampleId: co.sampleId || (orderRes.data?.sample_id ?? ""),
          collectionDate: co.sampleCollectedAtFormatted || co.sampleCollectedAt || "",
          receivedAt: co.sampleReceivedAtFormatted || co.sampleReceivedAt || "",
          collectionCenter: collectionCenterName,
          sampleCollectedBy: co.sampleCollectedBy || (oEnrich.data as any)?.sample_collected_by || "",
          b2bAccountName,
          referringDoctorName: co.referringDoctorName || (orderRes.data?.doctor ?? ""),
          approvedAt: co.approvedAtFormatted || co.approvedAt || "",
        });

        // Custom patient fields (patients.custom_fields JSONB) — same alias keys the PDF emits.
        const customFields = ((pEnrich.data as any)?.custom_fields || {}) as Record<string, unknown>;
        for (const [k, v] of Object.entries(customFields)) {
          // Trim so whitespace-only stored values render blank (parity with the PDF,
          // whose renderTemplate resolves a missing placeholder to "").
          const val = String(v ?? "").trim();
          patientFieldValues[`custom_${k}`] = val;
          patientFieldValues[`custom_${k.toLowerCase()}`] = val;
        }

        reportDateResolved = reportCtx?.meta?.reportDate || co.approvedAtFormatted || "";
      } catch (e) {
        console.warn("[QuickPreview] patient field resolution failed; using fallbacks", e);
      }

      // Fallbacks for the default (no-config) header layout and if the RPC failed.
      const ageFormatted =
        patientFieldValues.age ||
        formatPatientAgeDisplay(patientRes.data?.age, patientRes.data?.age_unit);
      const gender = patientFieldValues.gender || (patientRes.data?.gender ?? "");
      const patientCode = patientFieldValues.patientId || (patientRes.data?.display_id ?? "");
      const sampleId = patientFieldValues.sampleId || (orderRes.data?.sample_id ?? "");
      const referredBy = patientFieldValues.referringDoctorName || (orderRes.data?.doctor ?? "");
      const ageGender = [ageFormatted, gender].filter(Boolean).join(" / ");
      const orderDate = patientFieldValues.registrationDate || toDDMMYYYY(order.orderDate);

      // Build lookup: test_group_id → Map<analyte_id, { sort_order, section_heading, is_auto_calculated }>
      // Also build a name-based fallback for result_values rows where analyte_id is null.
      type TgaMeta = { sort_order: number; section_heading: string | null; is_auto_calculated: boolean };
      const tgaByGroup     = new Map<string, Map<string, TgaMeta>>();
      const tgaByGroupName = new Map<string, Map<string, TgaMeta>>();
      for (const row of tgaRes.data || []) {
        if (!row.test_group_id) continue;
        if (!tgaByGroup.has(row.test_group_id))     tgaByGroup.set(row.test_group_id,     new Map());
        if (!tgaByGroupName.has(row.test_group_id)) tgaByGroupName.set(row.test_group_id, new Map());
        const meta: TgaMeta = {
          sort_order:       row.sort_order ?? 999,
          section_heading:  row.section_heading ?? null,
          is_auto_calculated: (row.analytes as any)?.is_auto_calculated ?? false,
        };
        if (row.analyte_id) tgaByGroup.get(row.test_group_id)!.set(row.analyte_id, meta);
        const aName = (row.analytes as any)?.name;
        if (aName) tgaByGroupName.get(row.test_group_id)!.set(aName.toLowerCase(), meta);
      }

      // Build report sections: sorted by display_order, group across all panels
      const reportSections = (sectionsRes.data || [])
        .filter((s: any) => s.final_content && String(s.final_content).trim())
        .sort((a: any, b: any) => {
          const aOrd = (a.lab_template_sections as any)?.display_order ?? 99;
          const bOrd = (b.lab_template_sections as any)?.display_order ?? 99;
          return aOrd - bOrd;
        })
        // deduplicate by section_name (multiple panels may have same section)
        .reduce((acc: any[], s: any) => {
          const name = (s.lab_template_sections as any)?.section_name || "Section";
          if (!acc.find(x => x.sectionName === name)) {
            acc.push({ sectionName: name, content: String(s.final_content).trim() });
          }
          return acc;
        }, []);

	      // Signatory
	      const verifierUser = (verifierRes.data as any)?.users;
	      const verifierUserId = (verifierRes.data as any)?.verified_by || null;
	      const previewSignatory = await fetchSignatoryForPreview(verifierUserId, verifierUser);
	      // Supplement from the RPC's resolved approver (the same signature the PDF uses via
	      // orders.approved_by → default signature) when the direct lookups came up empty.
	      const ctxApproverSig = String(reportCtx?.order?.approverSignature || "");
	      const ctxApproverName = String(reportCtx?.order?.approvedByName || "");
	      const signatoryImageUrl = previewSignatory.imageUrl || ctxApproverSig || "";
	      let signatoryName = previewSignatory.name || "";
	      if ((!signatoryName || signatoryName === "Authorized Signatory") && ctxApproverName) {
	        signatoryName = ctxApproverName;
	      }
	      const signatoryDesignation = previewSignatory.designation || "";
	      const verificationUrl = `https://app.limsapp.in/verify?id=${encodeURIComponent(order.orderId || sampleId || "")}`;
      const orderReportSettings = ((orderRes.data as any)?.report_settings || {}) as {
        groupOrderOverrideEnabled?: boolean;
        groupOrder?: string[];
        printLayoutMode?: "standard" | "compact";
        compactPageAssignments?: Record<string, number>;
        compactMaxClubbedAnalytes?: number;
      };
      const labCompactPrint = (labPdfLayoutSettings?.compactPrint || {}) as Record<string, any>;
      const printLayoutMode: "standard" | "compact" =
        orderReportSettings.printLayoutMode === "compact" ||
        labCompactPrint.defaultMode === "compact"
          ? "compact"
          : "standard";
      const groupOrder = Array.isArray(orderReportSettings.groupOrder)
        ? orderReportSettings.groupOrder
        : [];
      const groupOrderIndex = new Map(groupOrder.map((id, index) => [id, index]));

      // Build lookup: test_group_id → merged printOptions (lab-level overridden by group-level)
      const groupPrintOptions = new Map<string, Record<string, unknown>>();
      const groupInterpretations = new Map<string, string>(); // test_group_id → group_interpretation HTML
      for (const tg of tgRes.data || []) {
        const groupOpts = tg.print_options || {};
        groupPrintOptions.set(tg.id, { ...labPrintOptions, ...groupOpts });
        if (tg.group_interpretation) groupInterpretations.set(tg.id, tg.group_interpretation);
      }

      // 3. Determine the dominant print options (first group that has its own wins; else lab)
      //    For the whole preview we use one merged set (same as how single-group PDF works).
      //    If multiple groups have different options we use the first non-empty group override,
      //    falling back to lab-level.
      let resolvedPrintOptions: Record<string, unknown> = { ...labPrintOptions };
      for (const gid of groupIds) {
        const gOpts = (tgRes.data || []).find((t: any) => t.id === gid)?.print_options;
        if (gOpts && Object.keys(gOpts).length > 0) {
          resolvedPrintOptions = { ...labPrintOptions, ...gOpts };
          break;
        }
      }

      // 4. Build test groups with sorted + section-headed analytes
      const orderedPanels = [...order.panels].sort((a, b) => {
        const aOrder = a.test_group_id && groupOrderIndex.has(a.test_group_id)
          ? groupOrderIndex.get(a.test_group_id)!
          : Number.MAX_SAFE_INTEGER;
        const bOrder = b.test_group_id && groupOrderIndex.has(b.test_group_id)
          ? groupOrderIndex.get(b.test_group_id)!
          : Number.MAX_SAFE_INTEGER;
        return aOrder - bOrder;
      });

	      const testGroups = orderedPanels
	        .map(panel => {
          // Use captured return values (not stale rowsByResult closure)
          const raw = loadedByResultId.get(panel.result_id) || [];
          const metaMap = panel.test_group_id
            ? (tgaByGroup.get(panel.test_group_id) ?? new Map<string, TgaMeta>())
            : new Map<string, TgaMeta>();

          const nameMap = panel.test_group_id
            ? (tgaByGroupName.get(panel.test_group_id) ?? new Map<string, TgaMeta>())
            : new Map<string, TgaMeta>();

          const analytes = raw
            .map(a => {
              const meta =
                (a.analyte_id ? metaMap.get(a.analyte_id) : undefined) ??
                nameMap.get(a.parameter?.toLowerCase() ?? "");
	              return {
	                parameter: a.parameter,
	                value: a.value,
	                unit: a.unit,
	                reference_range: a.reference_range,
	                flag: a.flag,
	                section_heading: meta?.section_heading ?? null,
	                is_auto_calculated: a.is_auto_calculated ?? meta?.is_auto_calculated ?? false,
	                _sort: meta?.sort_order ?? 999,
	              };
            })
            .sort((x, y) => x._sort - y._sort)
            .map(({ _sort: _s, ...rest }) => rest);

          return {
            testGroupId: panel.test_group_id,
            testGroupName: panel.test_group_name || "Test Results",
            analytes,
            groupInterpretation: panel.test_group_id
              ? (groupInterpretations.get(panel.test_group_id) ?? null)
              : null,
          };
	        })
	        .filter(g => g.analytes.length > 0);

      console.info("[QuickPreview] building preview", {
        orderId: order.orderId,
        printLayoutMode,
        groupCount: testGroups.length,
        groupOrder,
        compactPageAssignments: orderReportSettings.compactPageAssignments || null,
	        compactMaxClubbedAnalytes: orderReportSettings.compactMaxClubbedAnalytes || Number(labCompactPrint.maxClubbedAnalytes || 5),
	        hasSignatureImage: !!signatoryImageUrl,
	        hasVerificationUrl: !!verificationUrl,
	        pdfLayoutSettings: labPdfLayoutSettings,
	        queryErrors: {
          patients: !!patientRes.error,
          orders: !!orderRes.error,
          testGroupAnalytes: !!tgaRes.error,
          testGroups: !!tgRes.error,
          sections: !!sectionsRes.error,
          verifier: !!verifierRes.error,
        },
      });

      const html = buildBasicPreviewHtml({
        orderId: order.orderId,
        patientName: order.patientName,
        patientCode,
        ageGender,
        orderDate,
        reportDate: reportDateResolved || undefined,
        referredBy,
        sampleId,
        patientInfoConfig: labPatientInfoConfig,
        extraFieldConfigs: labExtraFieldConfigs,
        patientFieldValues,
        testGroups,
	        sections: reportSections,
	        signatoryName,
	        signatoryDesignation,
	        signatoryImageUrl,
	        verificationUrl,
	        printOptions: resolvedPrintOptions,
	        pdfLayoutSettings: labPdfLayoutSettings,
	        printLayoutMode,
        compactPlan: {
          orderedGroupIds: groupOrder,
          pageAssignments: orderReportSettings.compactPageAssignments,
          maxClubbedAnalytes: orderReportSettings.compactMaxClubbedAnalytes || Number(labCompactPrint.maxClubbedAnalytes || 5),
        },
      });

      setQuickPreview({ html, patientName: order.patientName });
    } catch (err) {
      console.error("Quick preview failed:", err);
    } finally {
      setQuickPreviewLoading(prev => ({ ...prev, [order.orderId]: false }));
    }
  };

  const showAllAnalytesForOrder = async (order: OrderGroup) => {
    setShowAllAnalytesLoading(prev => ({ ...prev, [order.orderId]: true }));
    try {
      setOpenOrders(prev => ({ ...prev, [order.orderId]: true }));
      setOpenPanels(prev => {
        const next = { ...prev };
        order.panels.forEach(panel => {
          next[panel.result_id] = true;
        });
        return next;
      });
      await Promise.all(order.panels.map(panel => ensureAnalytesLoaded(panel.result_id)));
    } finally {
      setShowAllAnalytesLoading(prev => ({ ...prev, [order.orderId]: false }));
    }
  };

  // Run AI Flag Analysis for an entire order
  const runOrderAIFlagAnalysis = async (orderId: string) => {
    setBusyFor(`ai-flag-${orderId}`, true);
    try {
      const result = await runAIFlagAnalysis(orderId, {
        applyToDatabase: true,
        createAudit: true
      });

      // Refresh the analytes data after AI analysis
      const order = groupByOrder.find(o => o.orderId === orderId);
      if (order) {
        for (const panel of order.panels) {
          // Clear cache to force refresh
          setRowsByResult(prev => {
            const next = { ...prev };
            delete next[panel.result_id];
            return next;
          });
          // Reload analytes
          await ensureAnalytesLoaded(panel.result_id);
        }
      }

      // Show summary
      const { flagsChanged, totalProcessed, errors } = result;
      if (errors.length > 0) {
        console.warn('Some flag analyses failed:', errors);
      }
      alert(`AI Flag Analysis Complete:\n- ${totalProcessed} results analyzed\n- ${flagsChanged} flags updated\n- ${errors.length} errors`);
    } catch (err) {
      console.error('Failed to run AI flag analysis:', err);
      alert('Failed to run AI flag analysis. Check console for details.');
    } finally {
      setBusyFor(`ai-flag-${orderId}`, false);
    }
  };

  const toggleOrderSelection = (orderId: string) => {
    setSelectedOrders(prev => {
      const next = new Set(prev);
      if (next.has(orderId)) next.delete(orderId);
      else next.add(orderId);
      return next;
    });
  };

  const bulkApproveOrders = async () => {
    if (selectedOrders.size === 0) return;
    setBulkProcessing(true);
    for (const orderId of selectedOrders) {
      const order = groupByOrder.find(o => o.orderId === orderId);
      if (order) await approveEntireOrder(order);
    }
    setSelectedOrders(new Set());
    setBulkProcessing(false);
  };

  /**
   * Fetch historical data for a patient from view_patient_history
   * This includes both internal orders and external reports
   */
  const fetchHistoricalData = async (
    patientId: string,
    analyteIds: string[],
    excludeOrderId?: string
  ): Promise<Record<string, Array<{
    date: string;
    value: string;
    flag?: string | null;
    source: 'internal' | 'external';
    lab_name?: string;
  }>>> => {
    if (!patientId || analyteIds.length === 0) return {};

    try {
      // Note: view_patient_history doesn't have order_id directly. 
      // For internal results, source_id is the result_value_id.
      const { data, error } = await database.supabase
        .from('view_patient_history')
        .select('analyte_id, value, unit, result_date, source, reference_range, source_id')
        .eq('patient_id', patientId)
        .in('analyte_id', analyteIds)
        .order('result_date', { ascending: false })
        .limit(100);

      if (error) {
        console.error('Failed to fetch historical data:', error);
        return {};
      }

      // Group by analyte_id
      const historyByAnalyte: Record<string, Array<{
        date: string;
        value: string;
        flag?: string | null;
        source: 'internal' | 'external';
        lab_name?: string;
      }>> = {};

      for (const row of data || []) {
        if (!row.analyte_id) continue;

        // Basic attempt to exclude current order if we had a way to map source_id to order_id
        // For now, we'll just include all since it's "history" and usually we want to see trends including current

        if (!historyByAnalyte[row.analyte_id]) {
          historyByAnalyte[row.analyte_id] = [];
        }

        historyByAnalyte[row.analyte_id].push({
          date: row.result_date ? new Date(row.result_date).toLocaleDateString() : 'Unknown',
          value: row.value || '',
          flag: null,
          source: row.source as 'internal' | 'external',
          lab_name: row.source === 'external' ? 'External Lab' : undefined
        });
      }

      console.log(`Fetched historical data for ${Object.keys(historyByAnalyte).length} analytes`);
      return historyByAnalyte;
    } catch (err) {
      console.error('Error fetching historical data:', err);
      return {};
    }
  };

  const handleGenerateClinicalSummary = async (order: OrderGroup, forceRegenerate: boolean = false) => {
    // Set loading state
    setGeneratingClinicalSummary(prev => ({ ...prev, [order.orderId]: true }));

    try {
      // First, check if a saved summary already exists (unless force regenerate)
      if (!forceRegenerate) {
        // Check orders table first (preferred location during verification)
        const { data: existingOrder, error: orderError } = await database.supabase
          .from('orders')
          .select('ai_clinical_summary, ai_clinical_summary_generated_at')
          .eq('id', order.orderId)
          .single();

        let savedText: string | null = null;
        let savedAt: string | null = null;

        if (!orderError && existingOrder?.ai_clinical_summary) {
          savedText = existingOrder.ai_clinical_summary;
          savedAt = existingOrder.ai_clinical_summary_generated_at;
          console.log('Found clinical summary in orders table');
        } else {
          // Fallback: check reports table
          const { data: existingReport, error: reportError } = await database.supabase
            .from('reports')
            .select('ai_doctor_summary, ai_summary_generated_at')
            .eq('order_id', order.orderId)
            .order('generated_date', { ascending: false })
            .limit(1)
            .maybeSingle();

          if (!reportError && existingReport?.ai_doctor_summary) {
            savedText = existingReport.ai_doctor_summary;
            savedAt = existingReport.ai_summary_generated_at;
            console.log('Found clinical summary in reports table');
          }
        }

        if (savedText) {
          console.log('Showing saved clinical summary');

          // Create a mock ClinicalSummaryResponse for the modal
          const parsedSummary: ClinicalSummaryResponse = {
            executive_summary: savedText, // Show the full saved text
            significant_findings: [],
            suggested_followup: [],
            urgent_findings: [],
            clinical_interpretation: '',
            overall_impression: 'Previously saved summary',
            _savedFromDb: true, // Flag to indicate this is saved
            _generatedAt: savedAt
          };

          setAiClinicalSummary(prev => ({ ...prev, [order.orderId]: parsedSummary }));
          setAiSummaryTarget({ type: "clinical", orderId: order.orderId });
          setShowAiSummaryModal(true);
          setGeneratingClinicalSummary(prev => ({ ...prev, [order.orderId]: false }));
          return;
        }
      }

      // No existing summary or force regenerate - generate new
      // First, collect all analyte IDs to fetch historical data
      const allAnalyteIds: string[] = [];
      const panelAnalytesMap: Map<string, Analyte[]> = new Map();

      // Load analytes for all panels first
      for (const panel of order.panels) {
        const analytes = await ensureAnalytesLoaded(panel.result_id);
        panelAnalytesMap.set(panel.result_id, analytes);
        analytes.forEach(a => {
          if (a.analyte_id) allAnalyteIds.push(a.analyte_id);
        });
      }

      // Fetch historical data for all analytes
      const historicalData = await fetchHistoricalData(order.patientId || '', allAnalyteIds, order.orderId);
      console.log(`Fetched historical data for ${Object.keys(historicalData).length} analytes`);

      // Build test groups with historical data
      const testGroups = order.panels.map(panel => {
        const analytes = panelAnalytesMap.get(panel.result_id) || [];
        console.log(`Panel ${panel.test_group_name}: ${analytes.length} analytes loaded`, analytes.map(a => ({ name: a.parameter, value: a.value })));
        return {
          name: panel.test_group_name || "Unnamed Panel",
          category: "panel",
          result_values: analytes.map(a => ({
            analyte_id: a.analyte_id,
            analyte_name: a.parameter,
            value: a.value || "",
            unit: a.unit,
            reference_range: a.reference_range,
            flag: (getNormalizedFlag(a.flag) || null) as string | null,
            interpretation: a.verify_note,
            // Include historical values if available
            historical_values: a.analyte_id ? historicalData[a.analyte_id] : undefined
          }))
        };
      });

      console.log('Sending to AI with historical data:', JSON.stringify(testGroups, null, 2));

      const summary = await aiIntelligence.getClinicalSummary(testGroups, {
        age: undefined,
        gender: undefined,
        clinical_notes: undefined
      });

      // Auto-save to database immediately after generating
      try {
        await handleSaveClinicalSummary(order.orderId, summary);
        console.log('Clinical summary auto-saved to database');
      } catch (saveError) {
        console.error('Failed to auto-save clinical summary:', saveError);
        // Don't block the UI, still show the modal
      }

      setAiClinicalSummary(prev => ({ ...prev, [order.orderId]: summary }));
      setAiSummaryTarget({ type: "clinical", orderId: order.orderId });
      setShowAiSummaryModal(true);
    } catch (err) {
      console.error("Failed to generate clinical summary", err);
      alert("Failed to generate clinical summary");
    } finally {
      // Clear loading state
      setGeneratingClinicalSummary(prev => ({ ...prev, [order.orderId]: false }));
    }
  };

  /**
   * Generate patient-friendly summary in selected language
   */
  const handleGeneratePatientSummary = async (
    order: OrderGroup,
    language: SupportedLanguage = labPreferredLanguage,
    forceRegenerate: boolean = false
  ) => {
    // Set loading state
    setGeneratingPatientSummary(prev => ({ ...prev, [order.orderId]: true }));
    setPatientSummaryTarget({
      orderId: order.orderId,
      patientName: order.patientName,
      referringDoctor: undefined // TODO: Get from order if available
    });
    setShowPatientSummaryModal(true);

    try {
      // Check if existing summary exists (unless force regenerate)
      if (!forceRegenerate) {
        const { data: existingOrder, error: orderError } = await database.supabase
          .from('orders')
          .select('ai_patient_summary, ai_patient_summary_generated_at, patient_summary_language')
          .eq('id', order.orderId)
          .single();

        if (!orderError && existingOrder?.ai_patient_summary) {
          try {
            const savedSummary = JSON.parse(existingOrder.ai_patient_summary) as PatientSummaryResponse;
            savedSummary._savedFromDb = true;
            savedSummary._generatedAt = existingOrder.ai_patient_summary_generated_at;
            setAiPatientSummary(prev => ({ ...prev, [order.orderId]: savedSummary }));
            setGeneratingPatientSummary(prev => ({ ...prev, [order.orderId]: false }));
            return;
          } catch (parseError) {
            console.log('Failed to parse saved patient summary, regenerating...');
          }
        }
      }

      // Build test groups data with historical data
      // First, collect all analyte IDs
      const allAnalyteIds: string[] = [];
      const panelAnalytesMap: Map<string, Analyte[]> = new Map();

      // Load analytes for all panels first
      for (const panel of order.panels) {
        const analytes = await ensureAnalytesLoaded(panel.result_id);
        panelAnalytesMap.set(panel.result_id, analytes);
        analytes.forEach(a => {
          if (a.analyte_id) allAnalyteIds.push(a.analyte_id);
        });
      }

      // Fetch historical data for all analytes
      const historicalData = await fetchHistoricalData(order.patientId || '', allAnalyteIds, order.orderId);
      console.log(`Patient summary: Fetched historical data for ${Object.keys(historicalData).length} analytes`);

      // Build test groups with historical data
      const testGroups = order.panels.map(panel => {
        const analytes = panelAnalytesMap.get(panel.result_id) || [];
        return {
          name: panel.test_group_name || "Unnamed Panel",
          category: "panel",
          result_values: analytes.map(a => ({
            analyte_id: a.analyte_id,
            analyte_name: a.parameter,
            value: a.value || "",
            unit: a.unit,
            reference_range: a.reference_range,
            // Pass the raw flag value to AI - it handles all variations (H, L, C, critical_h, critical_l, etc.)
            flag: a.flag || null,
            interpretation: a.verify_note,
            // Include historical values if available
            historical_values: a.analyte_id ? historicalData[a.analyte_id] : undefined
          }))
        };
      });

      // Get referring doctor name (if available)
      const { data: orderData } = await database.supabase
        .from('orders')
        .select('doctor')
        .eq('id', order.orderId)
        .single();
      const referringDoctor = orderData?.doctor || undefined;

      // Generate patient summary
      const summary = await aiIntelligence.getPatientSummary(
        testGroups,
        language,
        referringDoctor,
        { age: undefined, gender: undefined, clinical_notes: undefined }
      );

      // Auto-save to database
      try {
        await database.supabase
          .from('orders')
          .update({
            ai_patient_summary: JSON.stringify(summary),
            ai_patient_summary_generated_at: new Date().toISOString(),
            patient_summary_language: language
          })
          .eq('id', order.orderId);
        console.log('Patient summary auto-saved to database');
      } catch (saveError) {
        console.error('Failed to auto-save patient summary:', saveError);
      }

      setAiPatientSummary(prev => ({ ...prev, [order.orderId]: summary }));
      setPatientSummaryTarget({
        orderId: order.orderId,
        patientName: order.patientName,
        referringDoctor
      });
    } catch (err) {
      console.error("Failed to generate patient summary", err);
      alert("Failed to generate patient summary");
      setShowPatientSummaryModal(false);
    } finally {
      setGeneratingPatientSummary(prev => ({ ...prev, [order.orderId]: false }));
    }
  };

  const handleVerifierSummary = async (panel: PanelRow, analytes: Analyte[]) => {
    try {
      const summary = await aiIntelligence.getVerifierSummary(
        {
          test_group_name: panel.test_group_name || "",
          test_group_code: panel.test_group_id || ""
        },
        analytes.map(analyte => ({
          analyte_name: analyte.parameter,
          value: String(analyte.value || ""),
          unit: analyte.unit,
          reference_range: analyte.reference_range,
          flag: (getNormalizedFlag(analyte.flag) || null) as string | null,
          interpretation: analyte.verify_note
        }))
      );

      setAiVerifierSummary(prev => ({ ...prev, [panel.result_id]: summary }));
      setAiSummaryTarget({ type: "verifier", resultId: panel.result_id });
      setShowAiSummaryModal(true);
    } catch (err) {
      console.error("Failed to get verifier summary", err);
      alert("Failed to generate verifier summary");
    }
  };

  const handleInterpretations = async (panel: PanelRow, analytes: Analyte[]) => {
    try {
      const labId = currentLabId;
      if (!labId) {
        alert("Lab context missing");
        return;
      }

      const response = await aiIntelligence.generateMissingInterpretations(
        analytes.map(a => ({
          id: a.id,
          name: a.parameter,
          unit: a.unit,
          reference_range: a.reference_range,
          interpretation_low: null,
          interpretation_normal: null,
          interpretation_high: null
        })),
        {
          test_group_name: panel.test_group_name || "",
          test_group_code: panel.test_group_id || ""
        }
      );

      setAiGeneratedInterpretations(prev => ({ ...prev, [panel.result_id]: response.interpretations }));
      setInterpretationsTargetResultId(panel.result_id);
      setShowInterpretationsModal(true);
    } catch (err) {
      console.error("Failed to generate interpretations", err);
      alert("Failed to generate interpretations");
    }
  };

  // AI Delta Check handler - compares current values with historical data
  const handleDeltaCheck = async (panel: PanelRow, analytes: Analyte[]) => {
    try {
      // First fetch historical results for this patient
      const patientId = panel.patient_id;

      // Get in-house historical results
      const { data: historicalData } = await supabase
        .from('result_values')
        .select(`
          id, analyte_id, parameter, value, unit, reference_range, flag, created_at,
          results!inner(order_id, created_at, orders!inner(patient_id))
        `)
        .eq('results.orders.patient_id', patientId)
        .neq('result_id', panel.result_id)
        .order('created_at', { ascending: false })
        .limit(50);

      // Get external/outsourced historical results
      const { data: externalData } = await supabase
        .from('external_result_values')
        .select(`
          id, original_analyte_name, value, unit, reference_range, created_at,
          external_reports!fk_erv_report!inner(patient_id)
        `)
        .eq('external_reports.patient_id', patientId)
        .order('created_at', { ascending: false })
        .limit(50);

      // Build related test results array for AI
      const relatedTestResults = [
        ...(historicalData || []).map((h: any) => ({
          test_date: h.results?.created_at || h.created_at,
          source: 'in-house' as const,
          analytes: [{
            name: h.parameter,
            value: h.value,
            unit: h.unit,
            reference_range: h.reference_range,
            flag: h.flag
          }]
        })),
        ...(externalData || []).map((e: any) => ({
          test_date: e.created_at,
          source: 'external' as const,
          analytes: [{
            name: e.original_analyte_name,
            value: e.value,
            unit: e.unit,
            reference_range: e.reference_range,
            flag: null
          }]
        }))
      ];

      // Build current result values
      const resultValues = analytes.map(a => ({
        id: a.id,
        analyte_name: a.parameter,
        value: a.value || '',
        unit: a.unit,
        reference_range: a.reference_range,
        flag: a.flag
      }));

      // Call Delta Check AI function
      const deltaCheckResult = await aiIntelligence.performDeltaCheck(
        { id: panel.test_group_id || '', name: panel.test_group_name || '', code: '' },
        resultValues,
        { id: patientId, name: panel.patient_name },
        relatedTestResults
      );

      if (deltaCheckResult) {
        setAiDeltaCheckResults(prev => ({ ...prev, [panel.result_id]: deltaCheckResult }));
        setDeltaCheckTargetResultId(panel.result_id);
        setShowDeltaCheckModal(true);
      }
    } catch (error) {
      console.error('AI Delta Check failed:', error);
      alert('Failed to run Delta Check. Please try again.');
    }
  };

  // Order-level AI Delta Check handler - validates ALL test groups together with inter-test-group analysis
  const handleOrderDeltaCheck = async (order: OrderGroup) => {
    // Calculate entry percentage
    const entryPercentage = order.stats.expected > 0
      ? (order.stats.entered / order.stats.expected) * 100
      : 0;

    if (entryPercentage < 80) {
      alert(`Only ${entryPercentage.toFixed(0)}% of results are entered. Order-level delta check requires at least 80% completion.`);
      return;
    }

    setGeneratingOrderDeltaCheck(prev => ({ ...prev, [order.orderId]: true }));

    try {
      // Load all analytes for all panels
      const allPanelAnalytes = await Promise.all(
        order.panels.map(async (panel) => {
          const analytes = await ensureAnalytesLoaded(panel.result_id);
          return { panel, analytes };
        })
      );

      // Fetch historical data for this patient
      const patientId = order.patientId;
      const [{ data: historicalData }, { data: externalData }] = await Promise.all([
        supabase
          .from('result_values')
          .select(`
            id, analyte_id, parameter, value, unit, reference_range, flag, created_at,
            results!inner(order_id, created_at, orders!inner(patient_id))
          `)
          .eq('results.orders.patient_id', patientId)
          .not('results.order_id', 'eq', order.orderId)
          .order('created_at', { ascending: false })
          .limit(100),
        supabase
          .from('external_result_values')
          .select(`
            id, original_analyte_name, value, unit, reference_range, created_at,
            external_reports!fk_erv_report!inner(patient_id)
          `)
          .eq('external_reports.patient_id', patientId)
          .order('created_at', { ascending: false })
          .limit(50),
      ]);

      // Group historical data by date
      const historyByDate = new Map<string, { test_date: string; source: 'in-house' | 'external'; analytes: any[] }>();

      (historicalData || []).forEach((h: any) => {
        const date = (h.results?.created_at || h.created_at)?.split('T')[0] || 'unknown';
        if (!historyByDate.has(date)) {
          historyByDate.set(date, { test_date: date, source: 'in-house', analytes: [] });
        }
        historyByDate.get(date)!.analytes.push({
          name: h.parameter,
          value: h.value,
          unit: h.unit,
          reference_range: h.reference_range,
          flag: h.flag,
        });
      });

      (externalData || []).forEach((e: any) => {
        const date = e.created_at?.split('T')[0] || 'unknown';
        const key = `ext_${date}`;
        if (!historyByDate.has(key)) {
          historyByDate.set(key, { test_date: date, source: 'external', analytes: [] });
        }
        historyByDate.get(key)!.analytes.push({
          name: e.original_analyte_name,
          value: e.value,
          unit: e.unit,
          reference_range: e.reference_range,
          flag: null,
        });
      });

      // Build test groups array with result values
      const testGroups = allPanelAnalytes.map(({ panel, analytes }) => ({
        test_group_name: panel.test_group_name || 'Unknown',
        test_group_code: panel.test_group_id || '',
        category: 'General',
        result_values: analytes
          .filter(a => a.value !== null && a.value !== '')
          .map(a => ({
            id: a.id,
            analyte_name: a.parameter,
            value: a.value || '',
            unit: a.unit,
            reference_range: a.reference_range,
            flag: a.flag,
          })),
      })).filter(tg => tg.result_values.length > 0);

      if (testGroups.length === 0) {
        alert('No test results to analyze. Please enter values first.');
        setGeneratingOrderDeltaCheck(prev => ({ ...prev, [order.orderId]: false }));
        return;
      }

      // Get patient info from first panel
      const firstPanel = order.panels[0];
      const { data: patientData } = await supabase
        .from('patients')
        .select('age, gender')
        .eq('id', patientId)
        .single();

      // Call order-level delta check
      const result = await aiIntelligence.performOrderDeltaCheck(
        testGroups,
        {
          age: patientData?.age,
          gender: patientData?.gender,
        },
        Array.from(historyByDate.values())
      );

      if (result) {
        setOrderDeltaCheckResults(prev => ({ ...prev, [order.orderId]: result }));
        setOrderDeltaCheckTargetOrderId(order.orderId);
        setShowOrderDeltaCheckModal(true);
      } else {
        alert('No delta check results generated. Please try again.');
      }
    } catch (error) {
      console.error('Order-level AI Delta Check failed:', error);
      alert('Failed to run Order Delta Check: ' + (error instanceof Error ? error.message : 'Unknown error'));
    } finally {
      setGeneratingOrderDeltaCheck(prev => ({ ...prev, [order.orderId]: false }));
    }
  };

  // Handler to save clinical summary to reports table
  const handleSaveClinicalSummary = async (orderId: string, summary: ClinicalSummaryResponse) => {
    // Format the summary as a readable text for the report
    const summaryText = `
**Executive Summary**
${summary.executive_summary}

${summary.significant_findings.length > 0 ? `**Significant Findings**
${summary.significant_findings.map(f => `• ${f.finding}: ${f.clinical_significance}`).join('\n')}` : ''}

${summary.suggested_followup.length > 0 ? `**Suggested Follow-up**
${summary.suggested_followup.map(f => `• ${f}`).join('\n')}` : ''}

${summary.urgent_findings && summary.urgent_findings.length > 0 ? `**Urgent Findings**
${summary.urgent_findings.map(f => `• ${f}`).join('\n')}` : ''}
    `.trim();

    // Save to reports table (for PDF generation)
    const { error } = await aiAnalysis.saveDoctorSummary(orderId, summaryText);
    if (error) throw error;

    // ALSO save to orders table (for WhatsApp messages)
    // This is needed because WhatsApp code reads from orders.ai_clinical_summary
    const { data: { user } } = await supabase.auth.getUser();
    const { error: orderError } = await supabase
      .from('orders')
      .update({
        ai_clinical_summary: summaryText,
        ai_clinical_summary_generated_at: new Date().toISOString(),
        ai_clinical_summary_generated_by: user?.id || null
      })
      .eq('id', orderId);
    
    if (orderError) {
      console.error('Failed to save clinical summary to orders table:', orderError);
    } else {
      console.log(`✅ Clinical summary saved to orders.ai_clinical_summary for order ${orderId}`);
    }
  };

  // Handle include in report option - persist to database
  const handleIncludeInReport = async (orderId: string, include: boolean) => {
    setIncludeSummaryInReport(prev => ({ ...prev, [orderId]: include }));

    // Save to database so PDF generation picks it up
    try {
      const result = await toggleOrderSummaryInReport(orderId, include);
      if (!result.success) {
        console.error('Failed to save include flag:', result.error);
      } else {
        console.log(`✅ Order ${orderId}: Include summary in report saved = ${include}`);
      }
    } catch (error) {
      console.error('Error saving include flag:', error);
    }
  };

  // Handle send to doctor option
  const handleSendToDoctor = async (orderId: string, summary: ClinicalSummaryResponse) => {
    setSendSummaryToDoctor(prev => ({ ...prev, [orderId]: true }));
    // This will be used when sending the report to the doctor
    // The WhatsApp/email sending will include this summary
    console.log(`Order ${orderId}: Will send clinical summary to doctor with report`);
  };

  const setDateRange = (days: number) => {
    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - days);
    setTo(end.toISOString().split("T")[0]);
    setFrom(start.toISOString().split("T")[0]);
  };

  const AttachmentViewer: React.FC<{ orderId: string }> = ({ orderId }) => {
    const attachments = attachmentsByOrder[orderId] || [];
    const [expandedAttachments, setExpandedAttachments] = useState<Set<string>>(new Set());
    const [previewContent, setPreviewContent] = useState<Record<string, string>>({});
    const [previewLoading, setPreviewLoading] = useState<Record<string, boolean>>({});

    if (!attachments.length) {
      return (
        <div className="text-sm text-gray-500 bg-gray-50 p-3 rounded-lg border border-gray-200">
          <div className="flex items-center space-x-2">
            <FileText className="h-4 w-4" />
            <span>No attachments found for this order</span>
          </div>
        </div>
      );
    }

    const testAttachments = attachments.filter(att => att.level === "test");
    const orderAttachments = attachments.filter(att => att.level !== "test");

    const shouldShowTestOnly = attachmentViewMode === "test";
    const toRender = shouldShowTestOnly ? testAttachments : attachments;

    const isPreviewable = (att: any) => {
      const fileType = att.file_type || '';
      const filename = att.original_filename?.toLowerCase() || '';
      return fileType === 'text/plain' ||
        fileType === 'application/json' ||
        fileType?.startsWith('image/') ||
        filename.endsWith('.txt') ||
        filename.endsWith('.json') ||
        filename.endsWith('.csv') ||
        filename.endsWith('.png') ||
        filename.endsWith('.jpg') ||
        filename.endsWith('.jpeg') ||
        filename.endsWith('.gif') ||
        filename.endsWith('.bmp');
    };

    const isImage = (att: any) => {
      const fileType = att.file_type || '';
      const filename = att.original_filename?.toLowerCase() || '';
      return fileType?.startsWith('image/') || filename.match(/\.(png|jpg|jpeg|gif|bmp)$/);
    };

    const handleExpand = async (att: any) => {
      const isExpanded = expandedAttachments.has(att.id);
      
      if (!isExpanded && isPreviewable(att) && !previewContent[att.id] && !isImage(att)) {
        setPreviewLoading(prev => ({ ...prev, [att.id]: true }));
        try {
          const response = await fetch(att.file_url);
          const text = await response.text();
          setPreviewContent(prev => ({ ...prev, [att.id]: text }));
        } catch (error) {
          console.error('Failed to load preview:', error);
          setPreviewContent(prev => ({ ...prev, [att.id]: 'Failed to load preview' }));
        } finally {
          setPreviewLoading(prev => ({ ...prev, [att.id]: false }));
        }
      }
      
      setExpandedAttachments(prev => {
        const next = new Set(prev);
        if (isExpanded) {
          next.delete(att.id);
        } else {
          next.add(att.id);
        }
        return next;
      });
    };

    return (
      <div className="space-y-2">
        {toRender.map(att => {
          const expanded = expandedAttachments.has(att.id);
          const levelColor = att.level === "test" ? "text-blue-600" : "text-gray-600";
          const levelBgColor = att.level === "test" ? "bg-blue-50" : "bg-gray-50";
          const borderColor = att.level === "test" ? "border-blue-200" : "border-gray-200";

          return (
            <div key={att.id} className={`border rounded-lg ${levelBgColor} ${borderColor}`}>
              <div className="flex items-center justify-between p-3">
                <div className="flex items-center space-x-2 flex-1">
                  <FileText className={`h-4 w-4 ${levelColor}`} />
                  <div className="flex-1">
                    <p className="text-sm font-medium text-gray-900">{att.original_filename}</p>
                    <p className={`text-xs ${levelColor}`}>
                      {att.level === "test" ? "Test" : "Order"} Level • {new Date(att.created_at).toLocaleDateString()}
                    </p>
                  </div>
                </div>
                <div className="flex items-center space-x-2">
                  {isPreviewable(att) && (
                    <button
                      onClick={() => handleExpand(att)}
                      className={`p-1.5 rounded ${levelColor} hover:bg-white/50 transition-colors`}
                      title={expanded ? "Collapse preview" : "Expand preview"}
                    >
                      {expanded ? <Minimize className="h-4 w-4" /> : <Expand className="h-4 w-4" />}
                    </button>
                  )}
                  <a
                    href={att.file_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`p-1.5 rounded ${levelColor} hover:bg-white/50 transition-colors`}
                    title="Open in new tab"
                  >
                    <Eye className="h-4 w-4" />
                  </a>
                </div>
              </div>

              {/* Inline Preview */}
              {expanded && (
                <div className="border-t p-4 bg-white/70">
                  {previewLoading[att.id] ? (
                    <div className="flex items-center justify-center py-8">
                      <RefreshCcw className="h-5 w-5 animate-spin mr-2 text-gray-500" />
                      <span className="text-sm text-gray-600">Loading preview...</span>
                    </div>
                  ) : isImage(att) ? (
                    <div className="max-h-96 overflow-y-auto border rounded bg-white p-2">
                      <img
                        src={att.file_url}
                        alt={att.original_filename}
                        className="max-w-full h-auto rounded mx-auto"
                        style={{ maxHeight: '400px' }}
                      />
                    </div>
                  ) : previewContent[att.id] ? (
                    <div className="max-h-96 overflow-y-auto border rounded bg-white">
                      <pre className="text-sm bg-gray-50 p-4 whitespace-pre-wrap break-words font-mono leading-relaxed">
                        {previewContent[att.id].length > 2000 
                          ? `${previewContent[att.id].substring(0, 2000)}...\n\n[Preview truncated - full content available in new tab]` 
                          : previewContent[att.id]}
                      </pre>
                    </div>
                  ) : (
                    <div className="text-sm text-gray-500 py-6 text-center">
                      Preview not available for this file type
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {shouldShowTestOnly && !testAttachments.length && orderAttachments.length > 0 && (
          <div className="text-xs text-amber-600 bg-amber-50 p-3 rounded-lg border border-amber-200">
            <div className="flex items-center space-x-2">
              <AlertTriangle className="h-4 w-4" />
              <span>Switch to "All" view to see {orderAttachments.length} order-level attachment{orderAttachments.length > 1 ? "s" : ""}</span>
            </div>
          </div>
        )}
      </div>
    );
  };

  const TrendModal: React.FC = () => {
    if (!showTrendModal || !selectedAnalyteTrend) return null;

    const cacheKey = `${selectedAnalyteTrend.patientId}-${selectedAnalyteTrend.parameter}`;
    const trends = trendData[cacheKey] || [];

    return ReactDOM.createPortal(
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
        <div className="bg-white rounded-2xl shadow-2xl max-w-4xl w-full max-h-[90vh] overflow-hidden">
          <div className="bg-gradient-to-r from-blue-600 to-indigo-600 px-6 py-4 flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <TrendingUp className="h-6 w-6 text-white" />
              <h3 className="text-xl font-bold text-white">Trend: {selectedAnalyteTrend.parameter}</h3>
            </div>
            <button
              onClick={() => setShowTrendModal(false)}
              className="text-white hover:bg-white hover:bg-opacity-20 rounded-full p-2"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="p-6 overflow-y-auto max-h-[calc(90vh-80px)]">
            {trends.length === 0 ? (
              <div className="text-center py-12">
                <Activity className="h-16 w-16 text-gray-300 mx-auto mb-4" />
                <p className="text-gray-500 text-lg">No historical data available</p>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="bg-gradient-to-r from-blue-50 to-indigo-50 rounded-xl p-4">
                  <p className="text-sm text-gray-600">Most recent {trends.length} readings</p>
                </div>
                <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                  <table className="min-w-full">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500">Date</th>
                        <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500">Value</th>
                        <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500">Unit</th>
                        <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500">Reference</th>
                        <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500">Flag</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {trends.map((trend, idx) => (
                        <tr key={idx}>
                          <td className="px-4 py-3 text-sm text-gray-800">{new Date(trend.order_date).toLocaleString()}</td>
                          <td className="px-4 py-3 text-sm font-semibold text-gray-900">{trend.value ?? "—"}</td>
                          <td className="px-4 py-3 text-sm text-gray-700">{trend.unit}</td>
                          <td className="px-4 py-3 text-sm text-gray-600">{trend.reference_range}</td>
                          <td className="px-4 py-3 text-sm text-gray-700">{trend.flag || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>,
      document.body
    );
  };

  const percentage = (approved: number, expected: number) => {
    if (!expected) return 0;
    return Math.round((approved / expected) * 100);
  };

  return (
    <div className="bg-gradient-to-br from-gray-50 to-blue-50 min-h-screen">
      <div className="bg-white shadow-sm border-b">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4">
            <div>
              <h1 className="text-2xl lg:text-3xl font-bold text-gray-900">Order Verification Console</h1>
              <p className="text-sm lg:text-base text-gray-600">Review and approve results grouped by order with AI assistance</p>
              <div className="flex items-center space-x-3 mt-2">
                <button
                  onClick={() => setDateRange(0)}
                  className="px-2.5 py-1 text-xs rounded-full border border-gray-200 text-gray-600 hover:border-blue-400"
                >
                  Today
                </button>
                <button
                  onClick={() => setDateRange(7)}
                  className="px-2.5 py-1 text-xs rounded-full border border-gray-200 text-gray-600 hover:border-blue-400"
                >
                  7 days
                </button>
                <button
                  onClick={() => setDateRange(30)}
                  className="px-2.5 py-1 text-xs rounded-full border border-gray-200 text-gray-600 hover:border-blue-400"
                >
                  30 days
                </button>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={loadPanels}
                className="inline-flex items-center px-3.5 py-2 bg-white border-2 border-gray-200 rounded-lg hover:border-gray-400 text-sm"
              >
                <RefreshCcw className={`h-5 w-5 mr-2 ${loading ? "animate-spin text-blue-600" : "text-gray-600"}`} />
                Refresh
              </button>
              {onBackToPanel && (
                <button
                  onClick={onBackToPanel}
                  className="inline-flex items-center px-3.5 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm"
                >
                  Return to Panel View
                </button>
              )}
              {selectedOrders.size > 0 && (
                <button
                  onClick={bulkApproveOrders}
                  disabled={bulkProcessing}
                  className="inline-flex items-center px-3.5 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 text-sm"
                >
                  {bulkProcessing ? <Loader2 className="h-5 w-5 mr-2 animate-spin" /> : <CheckCircle2 className="h-5 w-5 mr-2" />}
                  Approve Selected
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-6 py-6 space-y-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-gradient-to-br from-blue-50 to-indigo-100 rounded-xl p-4">
            <div className="text-2xl font-bold text-blue-600">{stats.totalOrders}</div>
            <div className="text-xs text-blue-700">Total Orders</div>
          </div>
          <div className="bg-gradient-to-br from-green-50 to-emerald-100 rounded-xl p-4">
            <div className="text-2xl font-bold text-green-600">{stats.readyOrders}</div>
            <div className="text-xs text-green-700">Fully Verified</div>
          </div>
          <div className="bg-gradient-to-br from-amber-50 to-orange-100 rounded-xl p-4">
            <div className="text-2xl font-bold text-amber-600">{stats.partialOrders}</div>
            <div className="text-xs text-amber-700">Partially Verified</div>
          </div>
          <div className="bg-gradient-to-br from-red-50 to-rose-100 rounded-xl p-4">
            <div className="text-2xl font-bold text-red-600">{stats.pendingOrders}</div>
            <div className="text-xs text-red-700">Pending Review</div>
          </div>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-4 space-y-3">
          <div className="flex flex-col lg:flex-row gap-4">
	            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 flex-1">
              <label className="flex flex-col text-sm text-gray-600">
                From
                <input
                  type="date"
                  value={from}
                  onChange={e => setFrom(e.target.value)}
                  className="mt-1 px-3 py-2 border-2 border-gray-200 rounded-xl text-sm"
                />
              </label>
              <label className="flex flex-col text-sm text-gray-600">
                To
                <input
                  type="date"
                  value={to}
                  onChange={e => setTo(e.target.value)}
                  className="mt-1 px-3 py-2 border-2 border-gray-200 rounded-xl text-sm"
	                />
	              </label>
              <label className="flex flex-col text-sm text-gray-600">
                Ref Doctor
                <select
                  value={doctorFilter}
                  onChange={e => setDoctorFilter(e.target.value)}
                  className="mt-1 px-3 py-2 border-2 border-gray-200 rounded-xl text-sm"
                >
                  <option value="all">All Doctors</option>
                  {doctorOptions.map(doctor => (
                    <option key={doctor} value={doctor}>{doctor}</option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col text-sm text-gray-600">
                B2B Client
                <select
                  value={accountFilter}
                  onChange={e => setAccountFilter(e.target.value)}
                  className="mt-1 px-3 py-2 border-2 border-gray-200 rounded-xl text-sm"
                >
                  <option value="all">All B2B Clients</option>
                  {accountOptions.map(account => (
                    <option key={account} value={account}>{account}</option>
                  ))}
                </select>
              </label>
	            </div>
	            <div className="flex-1 relative">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400" />
              <input
                value={q}
                onChange={e => setQ(e.target.value)}
	                placeholder="Search patients, tests, sample IDs, or order IDs..."
                className="w-full pl-12 pr-4 py-2.5 text-sm border-2 border-gray-200 rounded-xl"
              />
	            </div>
            <select
              value={orderSortMode}
              onChange={e => setOrderSortMode(e.target.value as OrderSortMode)}
              className="px-3 py-2.5 border-2 border-gray-200 rounded-xl text-sm"
              title="Sort orders"
            >
              <option value="sample_desc">Sample ID newest first</option>
              <option value="sample_asc">Sample ID oldest first</option>
              <option value="date_desc">Order date newest first</option>
              <option value="patient_az">Patient A-Z</option>
            </select>
	            <div className="flex items-center space-x-3">
              {(["all", "ready", "partial", "pending"] as StateFilter[]).map(filter => (
                <button
                  key={filter}
                  onClick={() => setStateFilter(filter)}
                  className={`px-3 py-1.5 rounded-xl border-2 text-xs font-semibold ${stateFilter === filter ? "border-blue-500 text-blue-600" : "border-transparent text-gray-500"}`}
                >
                  {filter.charAt(0).toUpperCase() + filter.slice(1)}
                </button>
              ))}
            </div>
          </div>
        </div>

        {error && (
          <div className="bg-red-50 border-2 border-red-200 rounded-2xl p-6">
            <div className="flex items-center">
              <AlertTriangle className="h-6 w-6 text-red-600 mr-3" />
              <div>
                <h4 className="text-lg font-semibold text-red-800">Failed to load orders</h4>
                <p className="text-red-600">{error}</p>
              </div>
            </div>
          </div>
        )}

        {loading && (
          <div className="space-y-6">
            {[...Array(3)].map((_, idx) => (
              <div key={idx} className="bg-white rounded-2xl border border-gray-200 p-6 animate-pulse">
                <div className="h-6 bg-gray-200 rounded w-1/3 mb-4" />
                <div className="h-4 bg-gray-200 rounded w-1/2" />
              </div>
            ))}
          </div>
        )}

        {!loading && groupByOrder.length === 0 && (
          <div className="bg-white rounded-2xl border-2 border-dashed border-gray-300 p-12 text-center">
            <div className="mx-auto w-24 h-24 bg-gray-100 rounded-full flex items-center justify-center mb-6">
              <TestTube className="w-12 h-12 text-gray-400" />
            </div>
            <h3 className="text-2xl font-bold text-gray-900 mb-3">No Orders Found</h3>
            <p className="text-gray-600 mb-6 max-w-md mx-auto text-lg">
              No orders match your filters for the selected date range.
            </p>
            <div className="flex justify-center space-x-4">
              <button
                onClick={() => {
	                  setQ("");
	                  setStateFilter("all");
                  setDoctorFilter("all");
                  setAccountFilter("all");
                  setOrderSortMode("sample_desc");
	                  setDateRange(7);
                }}
                className="px-6 py-3 bg-blue-600 text-white rounded-xl hover:bg-blue-700"
              >
                Reset Filters
              </button>
              <button
                onClick={loadPanels}
                className="px-6 py-3 border-2 border-gray-300 text-gray-700 rounded-xl hover:border-gray-400"
              >
                Refresh Data
              </button>
            </div>
          </div>
        )}

        {!loading && groupByOrder.length > 0 && (
          <div className="space-y-6">
	            {groupByOrder.map(order => {
	              const enteredCount = Math.min(order.stats.entered || order.stats.handled || 0, order.stats.expected);
	              const approvedCount = Math.min(order.stats.approved || 0, order.stats.expected);
	              const orderHandledPct = percentage(enteredCount, order.stats.expected);
	              const pendingCount = Math.max(0, order.stats.expected - enteredCount);
	              const forApprovalCount = Math.max(0, enteredCount - approvedCount);
	              const allReady = order.stats.expected > 0 && approvedCount >= order.stats.expected;
	              const allAnalytesHandled = order.stats.expected > 0 && pendingCount === 0;

              return (
                <div key={order.orderId} className="border-2 rounded-2xl bg-white shadow-sm">
                  <div className="p-6 border-b border-gray-100">
                    <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4">
                      <div className="flex items-start space-x-4">
                        <input
                          type="checkbox"
                          checked={selectedOrders.has(order.orderId)}
                          onChange={() => toggleOrderSelection(order.orderId)}
                          className="w-5 h-5 mt-1 rounded border-2 border-gray-300 text-blue-600"
                        />
                        <div>
                          <div className="flex items-center space-x-3">
                            <div className="bg-gradient-to-br from-blue-500 to-indigo-600 p-3 rounded-xl">
                              <User className="h-6 w-6 text-white" />
                            </div>
                            <div>
                              <h3 className="text-2xl font-bold text-gray-900">{order.patientName}</h3>
                              <p className="text-sm text-gray-500">Order #{order.orderId}</p>
                              <p className="text-sm text-gray-500">{new Date(order.orderDate).toLocaleString()}</p>
                            </div>
                          </div>
                          <div className="mt-3 flex items-center space-x-3">
	                            {allReady ? (
	                              <span className="inline-flex items-center px-3 py-1.5 rounded-full bg-green-100 text-green-700 text-sm font-semibold">
	                                <ShieldCheck className="h-4 w-4 mr-2" /> Fully Verified
	                              </span>
	                            ) : allAnalytesHandled ? (
	                              <span className="inline-flex items-center px-3 py-1.5 rounded-full bg-blue-100 text-blue-700 text-sm font-semibold">
	                                <CheckCircle2 className="h-4 w-4 mr-2" /> Ready for Approval ({enteredCount}/{order.stats.expected})
	                              </span>
		                            ) : enteredCount > 0 ? (
		                              <span className="inline-flex items-center px-3 py-1.5 rounded-full bg-amber-100 text-amber-700 text-sm font-semibold">
		                                <AlertTriangle className="h-4 w-4 mr-2" /> Partial ({enteredCount}/{order.stats.expected})
		                              </span>
                            ) : (
                              <span className="inline-flex items-center px-3 py-1.5 rounded-full bg-red-100 text-red-700 text-sm font-semibold">
                                <AlertCircle className="h-4 w-4 mr-2" /> Pending
                              </span>
                            )}
                            {order.priority && order.priority !== "Normal" && (
                              <span className={`inline-flex items-center px-3 py-1.5 rounded-full text-sm font-semibold ${
                                order.priority === "STAT"
                                  ? "bg-red-100 text-red-800 border border-red-300 animate-pulse"
                                  : "bg-orange-100 text-orange-800 border border-orange-300"
                              }`}>
                                {order.priority === "STAT" ? "🚨 STAT" : "⚡ Urgent"}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="flex flex-col items-end space-y-3">
                        <div className="text-sm text-gray-500">Progress</div>
                        <div className="flex items-center space-x-3">
                          <div className="w-48 bg-gray-100 rounded-full h-3">
	                            <div className="h-3 rounded-full bg-gradient-to-r from-blue-500 to-indigo-600" style={{ width: `${orderHandledPct}%` }} />
	                          </div>
	                          <span className="text-gray-700 font-semibold">{orderHandledPct}%</span>
	                        </div>
	                        <div className="flex flex-wrap justify-end gap-1 text-[11px]">
	                          <span className="rounded bg-red-50 px-2 py-0.5 text-red-600">Pending: {pendingCount}</span>
	                          <span className="rounded bg-amber-50 px-2 py-0.5 text-amber-700">For approval: {forApprovalCount}</span>
	                          <span className="rounded bg-green-50 px-2 py-0.5 text-green-700">Approved: {approvedCount}</span>
	                          {order.stats.hidden > 0 && (
	                            <span className="rounded bg-slate-50 px-2 py-0.5 text-slate-700">Hidden: {order.stats.hidden}</span>
	                          )}
	                          <span className="rounded bg-blue-50 px-2 py-0.5 text-blue-700">Total: {order.stats.expected}</span>
	                        </div>
                        <div className="flex flex-wrap gap-2">
                          <button
                            onClick={() => toggleOrder(order.orderId)}
                            className="px-4 py-2 rounded-xl border border-gray-200 hover:bg-gray-50"
                          >
                            {openOrders[order.orderId] ? "Hide Panels" : "Show Panels"}
                          </button>
                          <button
                            onClick={() => showAllAnalytesForOrder(order)}
                            disabled={showAllAnalytesLoading[order.orderId]}
                            className="px-4 py-2 rounded-xl border border-gray-200 hover:bg-gray-50 disabled:opacity-50"
                          >
                            {showAllAnalytesLoading[order.orderId] ? "Loading Analytes..." : "Show All Analytes"}
                          </button>
                          <button
                            onClick={() => {
                              setSelectedOrderForAttachments(order.orderId);
                              setShowAttachmentSelector(true);
                            }}
                            className="inline-flex items-center px-4 py-2 rounded-xl bg-gradient-to-r from-purple-600 to-indigo-600 text-white"
                          >
                            <FileImage className="h-4 w-4 mr-2" /> Manage Attachments
                          </button>
                          <button
                            onClick={() => handleGenerateClinicalSummary(order)}
                            disabled={generatingClinicalSummary[order.orderId]}
                            className={`inline-flex items-center px-4 py-2 rounded-xl bg-gradient-to-r from-teal-600 to-cyan-600 text-white transition-all duration-200 ${generatingClinicalSummary[order.orderId] ? 'opacity-75 cursor-wait' : 'hover:from-teal-700 hover:to-cyan-700 active:scale-95'}`}
                          >
                            {generatingClinicalSummary[order.orderId] ? (
                              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            ) : (
                              <Stethoscope className="h-4 w-4 mr-2" />
                            )}
                            {generatingClinicalSummary[order.orderId] ? 'Generating...' : 'Clinical Summary'}
                          </button>
                          <button
                            onClick={() => handleGeneratePatientSummary(order)}
                            disabled={generatingPatientSummary[order.orderId]}
                            className={`inline-flex items-center px-4 py-2 rounded-xl bg-gradient-to-r from-pink-600 to-rose-600 text-white transition-all duration-200 ${generatingPatientSummary[order.orderId] ? 'opacity-75 cursor-wait' : 'hover:from-pink-700 hover:to-rose-700 active:scale-95'}`}
                            title="Generate patient-friendly summary"
                          >
                            {generatingPatientSummary[order.orderId] ? (
                              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            ) : (
                              <User className="h-4 w-4 mr-2" />
                            )}
                            {generatingPatientSummary[order.orderId] ? 'Generating...' : 'Patient Summary'}
                          </button>
                          {/* Order-level AI Delta Check - only enabled when 80%+ results are entered */}
                          <button
                            onClick={() => handleOrderDeltaCheck(order)}
                            disabled={generatingOrderDeltaCheck[order.orderId] || order.stats.expected === 0 || (order.stats.entered / order.stats.expected) < 0.8}
                            className={`inline-flex items-center px-4 py-2 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 text-white transition-all duration-200 ${
                              generatingOrderDeltaCheck[order.orderId] || (order.stats.expected > 0 && (order.stats.entered / order.stats.expected) < 0.8)
                                ? 'opacity-50 cursor-not-allowed'
                                : 'hover:from-amber-600 hover:to-orange-600 active:scale-95'
                            }`}
                            title={
                              order.stats.expected > 0 && (order.stats.entered / order.stats.expected) < 0.8
                                ? `Order Delta Check requires 80%+ results entered (currently ${Math.round((order.stats.entered / order.stats.expected) * 100)}%)`
                                : 'Order-level AI Delta Check - Validates ALL test groups together with inter-test-group analysis'
                            }
                          >
                            {generatingOrderDeltaCheck[order.orderId] ? (
                              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            ) : (
                              <Zap className="h-4 w-4 mr-2" />
                            )}
                            {generatingOrderDeltaCheck[order.orderId] ? 'Analyzing...' : 'Order Delta Check'}
                          </button>
                          {/* AI Flags button hidden - flag analysis now done in backend automatically */}
                          <button
                            onClick={() => handleQuickPreview(order)}
                            disabled={quickPreviewLoading[order.orderId]}
                            className="inline-flex items-center px-4 py-2 rounded-xl bg-gradient-to-r from-sky-600 to-blue-600 text-white transition-all duration-200 hover:from-sky-700 hover:to-blue-700 active:scale-95 disabled:opacity-50"
                            title="Quick preview — basic print view of all results"
                          >
                            {quickPreviewLoading[order.orderId] ? (
                              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            ) : (
                              <Eye className="h-4 w-4 mr-2" />
                            )}
                            {quickPreviewLoading[order.orderId] ? "Loading..." : "Quick Preview"}
                          </button>
                          <button
                            onClick={() => approveEntireOrder(order)}
                            disabled={bulkProcessing}
                            className="inline-flex items-center px-4 py-2 rounded-xl bg-gradient-to-r from-green-600 to-emerald-600 text-white disabled:opacity-50"
                          >
                            {bulkProcessing ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <CheckCircle2 className="h-4 w-4 mr-2" />} Approve Order
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>

                  {openOrders[order.orderId] && (
                    <div className="p-6 space-y-6 bg-gray-50">
                      {order.panels.map(panel => {
                        const analytes = rowsByResult[panel.result_id] || [];
                        const isPanelOpen = openPanels[panel.result_id];

                        return (
                          <div key={panel.result_id} className="bg-white rounded-2xl shadow-sm border border-gray-200">
                            <div className="p-6 border-b border-gray-100">
                              <div className="flex flex-col md:flex-row md:items-center justify-between">
                                <div>
                                  <h4 className="text-xl font-semibold text-gray-900">{panel.test_group_name}</h4>
                                  <p className="text-sm text-gray-500">{panel.expected_analytes} analytes</p>
                                </div>
                                <div className="flex flex-wrap gap-2 mt-4 md:mt-0">
                                  <button
                                    onClick={() => togglePanel(panel.result_id)}
                                    className="px-3 py-2 rounded-xl border border-gray-200 hover:bg-gray-50 text-sm"
                                  >
                                    {isPanelOpen ? "Hide Analytes" : "Show Analytes"}
                                  </button>
                                  <button
                                    onClick={async () => {
                                      const analytesData = await ensureAnalytesLoaded(panel.result_id);
                                      await handleDeltaCheck(panel, analytesData);
                                    }}
                                    disabled={aiIntelligence.loading}
                                    className="inline-flex items-center px-3 py-2 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 text-white disabled:opacity-50 text-sm"
                                    title="AI Delta Check - Compare current values with historical data to detect potential errors"
                                  >
                                    {aiIntelligence.loading ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Zap className="h-4 w-4 mr-1.5" />} AI Delta Check
                                  </button>
                                  {/* AI Summary button hidden - analysis now done in backend automatically */}
                                  <button
                                    onClick={async () => {
                                      const analytesData = await ensureAnalytesLoaded(panel.result_id);
                                      await approvePanel(panel, analytesData);
                                    }}
                                    disabled={busy[panel.result_id]}
                                    className="inline-flex items-center px-3 py-2 rounded-xl bg-gradient-to-r from-green-600 to-emerald-600 text-white disabled:opacity-50 text-sm"
                                  >
                                    {busy[panel.result_id] ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <CheckSquare className="h-4 w-4 mr-1.5" />} Approve Panel
                                  </button>
                                  {isAdmin && panel.panel_ready && (
                                    <button
                                      onClick={() => reopenPanelForCorrection(panel)}
                                      disabled={busy[panel.result_id]}
                                      className="inline-flex items-center px-3 py-2 rounded-xl bg-gradient-to-r from-orange-500 to-red-500 text-white disabled:opacity-50 text-sm"
                                      title="Admin: Reopen this panel for value correction"
                                    >
                                      {busy[panel.result_id] ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <RefreshCcw className="h-4 w-4 mr-1.5" />} Reopen for Correction
                                    </button>
                                  )}
                                </div>
                              </div>
                            </div>

                            {isPanelOpen && (
                              <div className="p-6">
                                <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-x-auto">
                                  <table className="min-w-full">
                                    <thead className="bg-gradient-to-r from-gray-50 to-gray-100">
                                      <tr>
                                        <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600">Analyte</th>
                                        <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600">Value</th>
                                        <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 hidden sm:table-cell">Unit</th>
                                        <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 hidden sm:table-cell">Reference</th>
                                        <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600">Flag</th>
                                        <th className="px-4 py-3 text-left text-xs font-semibold text-gray-600 hidden sm:table-cell">Status</th>
                                      </tr>
                                    </thead>
                                    <tbody className="divide-y divide-gray-100">
                                      {analytes.map((analyte, index) => {
	                                        const isRerunRequest = analyte.verify_note && analyte.verify_note.toUpperCase().includes("RE-RUN");
	                                        const isHidden = !!analyte.is_hidden_from_report;
	                                        return (
                                          <React.Fragment key={analyte.id}>
                                            {analyte.section_heading && analyte.section_heading !== analytes[index - 1]?.section_heading && (
                                              <tr className="bg-blue-50">
                                                <td colSpan={6} className="px-4 py-2 text-xs font-bold uppercase tracking-wide text-blue-800">
                                                  {analyte.section_heading}
                                                </td>
                                              </tr>
                                            )}
	                                          <tr className={`hover:bg-blue-50 ${isHidden ? 'bg-slate-50 text-slate-500' : isRerunRequest ? 'bg-orange-50' : ''}`}>
                                          <td className="px-4 py-4">
                                            <div className="flex items-center gap-2">
                                              <div className="font-semibold text-gray-900">{analyte.parameter}</div>
	                                              {isRerunRequest && (
	                                                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-orange-100 text-orange-800 border border-orange-200">
                                                  <RefreshCw className="h-3 w-3 mr-1" />
                                                  RE-RUN
	                                                </span>
	                                              )}
	                                              {isHidden && (
	                                                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-slate-200 text-slate-700 border border-slate-300">
	                                                  Hidden from report
	                                                </span>
	                                              )}
	                                            </div>
	                                            {isHidden && (
	                                              <div className="mt-1 text-xs text-slate-500">
	                                                {analyte.hidden_reason || "Will not print on final report"}
	                                              </div>
	                                            )}
                                            {isRerunRequest && analyte.verify_note && (
                                              <div className="mt-1 text-xs text-orange-600 bg-orange-50 px-2 py-1 rounded border border-orange-200">
                                                {analyte.verify_note}
                                              </div>
                                            )}
                                            <button
                                              className="inline-flex items-center text-blue-600 hover:text-blue-800 text-xs mt-1"
                                              onClick={() => loadTrendData(order.patientId, analyte.parameter)}
                                              disabled={loadingTrend && selectedAnalyteTrend?.parameter === analyte.parameter}
                                            >
                                              {loadingTrend && selectedAnalyteTrend?.parameter === analyte.parameter ? (
                                                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                                              ) : (
                                                <TrendingUp className="h-3 w-3 mr-1" />
                                              )}
                                              Trend
                                            </button>
                                          </td>
                                          <td className="px-4 py-4 text-base sm:text-lg font-bold text-gray-900">{analyte.value ?? "—"}</td>
                                          <td className="px-4 py-4 text-gray-700 hidden sm:table-cell">{analyte.unit}</td>
                                          <td className="px-4 py-4 text-sm text-gray-600 hidden sm:table-cell">{analyte.reference_range}</td>
                                          <td className="px-4 py-4 hidden sm:table-cell">
                                            <div className="flex flex-col gap-1">
                                              <select
                                                value={getNormalizedFlag(analyte.flag)}
                                                onChange={(e) => handleFlagChange(panel.result_id, analyte.id, e.target.value)}
                                                className={`px-2 py-1 border rounded text-xs font-medium focus:outline-none focus:ring-2 focus:ring-blue-500 ${getFlagSelectClass(getNormalizedFlag(analyte.flag))}`}
                                              >
                                                {labFlagOptions.map((opt, i) => (
                                                  <option key={i} value={opt.value}>{opt.label}</option>
                                                ))}
                                              </select>
                                              {analyte.flag_source && (
                                                <span className="text-[10px] text-gray-400">
                                                  {analyte.flag_source === 'ai' ? 'AI' : analyte.flag_source === 'rule' ? 'Rule' : analyte.flag_source === 'manual' ? 'Manual' : analyte.flag_source}
                                                  {analyte.flag_confidence && analyte.flag_confidence < 0.8 && (
                                                    <span className="ml-1 text-amber-500">({Math.round(analyte.flag_confidence * 100)}%)</span>
                                                  )}
                                                </span>
                                              )}
                                            </div>
                                            {analyte.ai_interpretation && (
                                              <div className="mt-1 text-xs text-gray-500 italic max-w-[200px] truncate" title={analyte.ai_interpretation}>
                                                {analyte.ai_interpretation}
                                              </div>
                                            )}
                                          </td>
                                          <td className="px-4 py-4">
                                            {analyte.verify_status === "approved" ? (
                                              <span className="inline-flex items-center px-3 py-1.5 rounded-full bg-green-100 text-green-700 text-xs font-semibold">
                                                <CheckCircle2 className="h-4 w-4 mr-1" /> Approved
                                              </span>
                                            ) : analyte.verify_status === "rejected" ? (
                                              <div className="flex flex-col space-y-2">
                                                <span className="inline-flex items-center px-3 py-1.5 rounded-lg text-sm font-semibold bg-gradient-to-r from-red-600 to-rose-600 text-white">
                                                  <XCircle className="h-4 w-4 mr-1" /> Rejected
                                                </span>
                                                {analyte.verify_note && (
                                                  <div className="text-xs text-gray-500 italic bg-gray-50 p-2 rounded border">
                                                    Note: {analyte.verify_note}
                                                  </div>
                                                )}
                                                <div className="flex items-center space-x-2">
                                                  <button
                                                    disabled={busy[analyte.id]}
                                                    onClick={() => approveAnalyte(analyte.id)}
                                                    className="inline-flex items-center px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-gradient-to-r from-green-100 to-emerald-100 text-green-700 hover:from-green-200 hover:to-emerald-200 transition-all duration-200 shadow-sm disabled:opacity-50"
                                                    title="Approve this analyte"
                                                  >
                                                    <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
                                                    Approve
                                                  </button>
                                                  <button
                                                    disabled={busy[analyte.id]}
                                                    onClick={async () => {
                                                      const note = prompt("Add a note for re-run request:", "Please re-run this test") ?? null;
                                                      if (!note?.trim()) {
                                                        alert("Note is required to send for re-run");
                                                        return;
                                                      }
                                                      setBusyFor(analyte.id, true);
                                                      const { error } = await supabase
                                                        .from("result_values")
                                                        .update({
                                                          verify_status: "pending",
                                                          verify_note: `RE-RUN REQUESTED: ${note}`,
                                                          verified_at: null,
                                                          verified_by: null,
                                                        })
                                                        .eq("id", analyte.id);
                                                      setBusyFor(analyte.id, false);
                                                      if (!error) {
                                                        setRowsByResult(prev => {
                                                          const next = { ...prev };
                                                          Object.keys(next).forEach(resultId => {
                                                            next[resultId] = next[resultId].map(a =>
                                                              a.id === analyte.id
                                                                ? { ...a, verify_status: "pending", verify_note: `RE-RUN REQUESTED: ${note}`, verified_at: null }
                                                                : a
                                                            );
                                                          });
                                                          return next;
                                                        });
                                                        await loadPanels();
                                                        alert("Analyte sent back for re-run");
                                                      }
                                                    }}
                                                    className="inline-flex items-center px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-gradient-to-r from-orange-100 to-amber-100 text-orange-700 hover:from-orange-200 hover:to-amber-200 transition-all duration-200 shadow-sm disabled:opacity-50"
                                                    title="Send back to result entry for re-run"
                                                  >
                                                    <RefreshCw className="h-3.5 w-3.5 mr-1" />
                                                    Send for Re-run
                                                  </button>
                                                </div>
                                              </div>
                                            ) : (
                                              <div className="flex items-center space-x-2">
                                                <button
                                                  onClick={() => approveAnalyte(analyte.id)}
                                                  disabled={busy[analyte.id]}
                                                  className="px-3 py-1.5 rounded-lg bg-green-500 text-white text-xs"
                                                >
                                                  Approve
                                                </button>
                                                <button
                                                  onClick={() => rejectAnalyte(analyte.id)}
                                                  disabled={busy[analyte.id]}
                                                  className="px-3 py-1.5 rounded-lg bg-red-100 text-red-700 text-xs"
                                                >
                                                  Reject
                                                </button>
                                              </div>
                                            )}
                                          </td>
	                                          </tr>
                                          </React.Fragment>
                                      );})}
                                    </tbody>
                                  </table>
                                </div>

                                <div className="mt-6 rounded-xl border border-amber-200 bg-amber-50/50 p-5">
                                  <div className="mb-2 flex items-center justify-between gap-3">
                                    <div>
                                      <h5 className="font-semibold text-amber-900">Report Remarks</h5>
                                      <p className="text-xs text-amber-700">Printed below this test group in the final report.</p>
                                    </div>
                                    <button
                                      type="button"
                                      disabled={!remarkDirty[panel.result_id] || remarkSaving[panel.result_id]}
                                      onClick={() => saveGroupRemark(panel)}
                                      className="inline-flex items-center rounded-lg bg-amber-600 px-3 py-2 text-sm font-semibold text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
                                    >
                                      {remarkSaving[panel.result_id] && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                                      Save Remark
                                    </button>
                                  </div>
                                  <textarea
                                    value={remarksByResult[panel.result_id] || ""}
                                    onChange={(event) => {
                                      setRemarksByResult((current) => ({ ...current, [panel.result_id]: event.target.value }));
                                      setRemarkDirty((current) => ({ ...current, [panel.result_id]: true }));
                                    }}
                                    rows={3}
                                    maxLength={2000}
                                    placeholder="Optional report-visible remark"
                                    className="w-full resize-y rounded-lg border border-amber-200 bg-white px-3 py-2 text-sm text-gray-800 outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-100"
                                  />
                                </div>

                                {/* Report Sections Editor (PBS/Radiology findings, impressions, etc.) */}
                                {panel.test_group_id && (
                                  <div className="mt-6">
                                    <SectionEditor
                                      resultId={panel.result_id}
                                      testGroupId={panel.test_group_id}
                                      showAIAssistant={false}
                                      onSave={() => {
                                        console.log('Section content saved for result:', panel.result_id);
                                      }}
                                    />
                                  </div>
                                )}

                                {/* Workflow Execution Panel - Shows workflow history and document generation */}
                                <div className="mt-6">
                                  <WorkflowExecutionPanel
                                    orderId={panel.order_id}
                                    testGroupId={panel.test_group_id || undefined}
                                    resultId={panel.result_id}
                                    showDocumentButton={true}
                                    onGenerateDocument={(instanceId) => {
                                      console.log('Generate document for workflow instance:', instanceId);
                                    }}
                                  />
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}

                      <div className="bg-white rounded-2xl shadow-sm border border-gray-200">
                        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
                          <h4 className="text-lg font-semibold text-gray-900 flex items-center">
                            <FileText className="h-5 w-5 mr-2 text-blue-600" /> Attachments
                          </h4>
                          <div className="flex items-center space-x-2">
                            <button
                              onClick={() => setAttachmentViewMode("test")}
                              className={`px-3 py-1 rounded-full text-xs font-semibold ${attachmentViewMode === "test" ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-500"}`}
                            >
                              Test Only
                            </button>
                            <button
                              onClick={() => setAttachmentViewMode("all")}
                              className={`px-3 py-1 rounded-full text-xs font-semibold ${attachmentViewMode === "all" ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-500"}`}
                            >
                              All
                            </button>
                          </div>
                        </div>
                        <div className="p-6">
                          <AttachmentViewer orderId={order.orderId} />
                        </div>
                      </div>

                      {/* Historical Trends Section - using shared TrendGraphPanel component */}
                      {(() => {
                        // Collect all analytes from all panels for this order
                        const allAnalytes = order.panels.flatMap(panel => rowsByResult[panel.result_id] || []);
                        return (
                          <div className="bg-white rounded-2xl shadow-sm border border-gray-200 mt-6">
                            <TrendGraphPanel
	                              orderId={order.orderId}
	                              patientId={order.patientId}
	                              analyteIds={allAnalytes.map((a: any) => a.analyte_id || '')}
	                              analyteNames={allAnalytes.map((a: any) => a.parameter)}
                              includeInReport={includeTrendsInReport[order.orderId] ?? false}
                              onIncludeInReportChange={(include) => {
                                setIncludeTrendsInReport(prev => ({ ...prev, [order.orderId]: include }));
                              }}
                              onSaved={() => {
                                setIncludeTrendsInReport(prev => ({ ...prev, [order.orderId]: true }));
                              }}
                            />
                          </div>
                        );
                      })()}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <TrendModal />

      {showAttachmentSelector && selectedOrderForAttachments && (
        <AttachmentSelector
          orderId={selectedOrderForAttachments}
          onClose={() => {
            setShowAttachmentSelector(false);
            setSelectedOrderForAttachments(null);
          }}
          onSave={() => {
            if (selectedOrderForAttachments) {
              setAttachmentsByOrder(prev => {
                const updated = { ...prev };
                delete updated[selectedOrderForAttachments];
                return updated;
              });
              loadAttachments(selectedOrderForAttachments);
            }
          }}
        />
      )}

      {showAiSummaryModal && aiSummaryTarget && (
        <AISummaryModal
          target={aiSummaryTarget}
          summaries={{
            verifier: aiVerifierSummary,
            clinical: aiClinicalSummary
          }}
          onClose={() => {
            setShowAiSummaryModal(false);
            setAiSummaryTarget(null);
          }}
          onSaveClinicalSummary={handleSaveClinicalSummary}
          onIncludeInReport={handleIncludeInReport}
          onSendToDoctor={handleSendToDoctor}
          onRegenerate={(orderId) => {
            // Find the order and force regenerate
            const order = groupByOrder.find(o => o.orderId === orderId);
            if (order) {
              handleGenerateClinicalSummary(order, true);
            }
          }}
        />
      )}

      {showInterpretationsModal && interpretationsTargetResultId && (
        <AIInterpretationsModal
          interpretations={aiGeneratedInterpretations[interpretationsTargetResultId] || []}
          labId={currentLabId}
          onClose={() => {
            setShowInterpretationsModal(false);
            setInterpretationsTargetResultId(null);
          }}
        />
      )}

      {/* AI Delta Check Modal (Panel-level) */}
      {showDeltaCheckModal && deltaCheckTargetResultId && aiDeltaCheckResults[deltaCheckTargetResultId] && (
        <AIDeltaCheckModal
          deltaCheck={aiDeltaCheckResults[deltaCheckTargetResultId]}
          onClose={() => {
            setShowDeltaCheckModal(false);
            setDeltaCheckTargetResultId(null);
          }}
        />
      )}

      {/* Order-Level AI Delta Check Modal */}
      {showOrderDeltaCheckModal && orderDeltaCheckTargetOrderId && orderDeltaCheckResults[orderDeltaCheckTargetOrderId] && (
        <OrderDeltaCheckModal
          deltaCheck={orderDeltaCheckResults[orderDeltaCheckTargetOrderId]}
          onClose={() => {
            setShowOrderDeltaCheckModal(false);
            setOrderDeltaCheckTargetOrderId(null);
          }}
        />
      )}

      {/* ── Quick Preview Modal ────────────────────────────────────────────── */}
      {quickPreview && ReactDOM.createPortal(
        <div
          className="fixed inset-0 z-50 flex flex-col bg-black/60"
          onClick={() => setQuickPreview(null)}
        >
          <div
            className="relative flex flex-col w-full h-full bg-white shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200 bg-gray-50 shrink-0">
              <div className="flex items-center space-x-2">
                <Eye className="h-5 w-5 text-sky-600" />
                <span className="font-semibold text-gray-800">
                  Quick Preview — {quickPreview.patientName}
                </span>
                <span className="text-xs text-gray-400 ml-1">(Basic print style)</span>
              </div>
              <div className="flex items-center space-x-2">
                <button
                  onClick={() => previewIframeRef.current?.contentWindow?.print()}
                  className="inline-flex items-center px-3 py-1.5 rounded-lg bg-sky-600 text-white text-sm hover:bg-sky-700"
                >
                  <Printer className="h-4 w-4 mr-1.5" /> Print
                </button>
                <button
                  onClick={() => setQuickPreview(null)}
                  className="p-1.5 rounded-lg hover:bg-gray-200 text-gray-600"
                  title="Close"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>
            {/* iframe */}
	            <iframe
	              ref={previewIframeRef}
	              srcDoc={quickPreview.html}
	              className="flex-1 w-full border-0 bg-slate-100"
	              title="Quick Preview"
	            />
          </div>
        </div>,
        document.body
      )}

      {showPatientSummaryModal && patientSummaryTarget && (
        <PatientSummaryModal
          orderId={patientSummaryTarget.orderId}
          patientName={patientSummaryTarget.patientName}
          referringDoctor={patientSummaryTarget.referringDoctor}
          summary={aiPatientSummary[patientSummaryTarget.orderId] || null}
          isGenerating={generatingPatientSummary[patientSummaryTarget.orderId] || false}
          onClose={() => {
            setShowPatientSummaryModal(false);
            setPatientSummaryTarget(null);
          }}
          onRegenerate={(language) => {
            const order = groupByOrder.find(o => o.orderId === patientSummaryTarget.orderId);
            if (order) {
              handleGeneratePatientSummary(order, language, true);
            }
          }}
          onSave={async (orderId, summary) => {
            await database.supabase
              .from('orders')
              .update({
                ai_patient_summary: JSON.stringify(summary),
                ai_patient_summary_generated_at: new Date().toISOString()
              })
              .eq('id', orderId);
            setAiPatientSummary(prev => ({ ...prev, [orderId]: summary }));
          }}
          onIncludeInPdf={async (orderId, include) => {
            await database.supabase
              .from('orders')
              .update({ include_patient_summary_in_report: include })
              .eq('id', orderId);
          }}
          onSendWhatsApp={async (orderId, summary) => {
            try {
              // Get patient phone from order
              const { data: orderData } = await database.supabase
                .from('orders')
                .select('patient_id, patients(phone, name)')
                .eq('id', orderId)
                .single();

              const patientPhone = (orderData?.patients as any)?.phone;

              if (!patientPhone) {
                alert('Patient phone number not found. Cannot send WhatsApp.');
                return;
              }

              // Format summary for WhatsApp
              let text = `🏥 *Your Health Report Summary*\n\n`;
              text += `📋 *Health Status:*\n${summary.health_status}\n\n`;

              if (summary.normal_findings_summary) {
                text += `✅ *Normal Findings:*\n${summary.normal_findings_summary}\n\n`;
              }

              if (summary.abnormal_findings && summary.abnormal_findings.length > 0) {
                text += `⚠️ *Findings Requiring Attention:*\n`;
                summary.abnormal_findings.forEach((f: any) => {
                  const statusEmoji = f.status === 'high' ? '📈' : f.status === 'low' ? '📉' : '⚠️';
                  text += `${statusEmoji} *${f.test_name}:* ${f.value}\n   ${f.explanation}\n`;
                });
                text += '\n';
              }

              if (summary.needs_consultation && summary.consultation_message) {
                text += `👨‍⚕️ *Recommendation:*\n${summary.consultation_message}\n\n`;
              }

              if (summary.health_tips && summary.health_tips.length > 0) {
                text += `💡 *Health Tips:*\n`;
                summary.health_tips.forEach((tip: string, i: number) => {
                  text += `${i + 1}. ${tip}\n`;
                });
              }

              text += `\n_This summary is for your understanding only. Please consult your doctor for medical advice._`;

              // Format phone number
              let phone = patientPhone.replace(/\D/g, '');
              if (phone.length === 10) {
                phone = '91' + phone;
              }

              // Open WhatsApp
              const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
              const encodedText = encodeURIComponent(text);
              const whatsappUrl = isMobile
                ? `whatsapp://send?phone=${phone}&text=${encodedText}`
                : `https://web.whatsapp.com/send?phone=${phone}&text=${encodedText}`;

              window.open(whatsappUrl, '_blank');
            } catch (error) {
              console.error('Failed to send WhatsApp:', error);
              alert('Failed to open WhatsApp. Please try again.');
            }
          }}
        />
      )}
    </div>
  );
};

const TrendModal: React.FC = () => {
  const [state, setState] = useState<{
    visible: boolean;
    trends: any[];
    title: string;
  }>({ visible: false, trends: [], title: "" });
  return null;
};

interface AISummaryModalProps {
  target: { type: "verifier" | "clinical"; resultId?: string; orderId?: string };
  summaries: {
    verifier: Record<string, VerifierSummaryResponse>;
    clinical: Record<string, ClinicalSummaryResponse>;
  };
  onClose: () => void;
  onSaveClinicalSummary?: (orderId: string, summary: ClinicalSummaryResponse) => Promise<void>;
  onIncludeInReport?: (orderId: string, include: boolean) => void;
  onSendToDoctor?: (orderId: string, summary: ClinicalSummaryResponse) => void;
  onRegenerate?: (orderId: string) => void;
}

const AISummaryModal: React.FC<AISummaryModalProps> = ({ target, summaries, onClose, onSaveClinicalSummary, onIncludeInReport, onSendToDoctor, onRegenerate }) => {
  const [includeInReport, setIncludeInReport] = useState(false);
  const [sendToDoctor, setSendToDoctor] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadingOptions, setLoadingOptions] = useState(true);

  const isVerifier = target.type === "verifier";
  const originalSummary = isVerifier
    ? target.resultId
      ? summaries.verifier[target.resultId]
      : null
    : target.orderId
      ? summaries.clinical[target.orderId]
      : null;

  // Load saved options from database when modal opens
  React.useEffect(() => {
    const loadSavedOptions = async () => {
      if (!isVerifier && target.orderId) {
        try {
          const { data, error } = await supabase
            .from('orders')
            .select('include_clinical_summary_in_report, send_clinical_summary_to_doctor')
            .eq('id', target.orderId)
            .single();
          
          if (!error && data) {
            setIncludeInReport(data.include_clinical_summary_in_report || false);
            setSendToDoctor(data.send_clinical_summary_to_doctor || false);
            console.log('✅ Loaded saved options:', data);
          }
        } catch (err) {
          console.error('Error loading saved options:', err);
        }
      }
      setLoadingOptions(false);
    };
    
    loadSavedOptions();
  }, [target.orderId, isVerifier]);

  // Editable state for clinical summary
  const [editedSummary, setEditedSummary] = useState<ClinicalSummaryResponse | null>(
    !isVerifier && originalSummary && 'executive_summary' in originalSummary
      ? { ...originalSummary } as ClinicalSummaryResponse
      : null
  );

  // Update editedSummary when originalSummary changes
  React.useEffect(() => {
    if (!isVerifier && originalSummary && 'executive_summary' in originalSummary) {
      setEditedSummary({ ...originalSummary } as ClinicalSummaryResponse);
    }
  }, [originalSummary, isVerifier]);

  if (!originalSummary) return null;

  const summary = isEditing && editedSummary ? editedSummary : originalSummary;

  const handleSaveEdits = async () => {
    if (!editedSummary || !target.orderId || !onSaveClinicalSummary) return;

    setSaving(true);
    try {
      await onSaveClinicalSummary(target.orderId, editedSummary);
      setIsEditing(false);
      alert('Clinical summary saved successfully!');
    } catch (error) {
      console.error('Failed to save clinical summary:', error);
      alert('Failed to save clinical summary');
    } finally {
      setSaving(false);
    }
  };

  const handleConfirmOptions = async () => {
    if (!isVerifier && target.orderId) {
      setSaving(true);
      try {
        // If including in report, ALWAYS save the clinical summary to the database first
        if (includeInReport && onSaveClinicalSummary) {
          await onSaveClinicalSummary(target.orderId, summary as ClinicalSummaryResponse);
          console.log('✅ Clinical summary saved to database');
        }

        // Save BOTH options (include in PDF and send to doctor) using the new function
        const result = await saveClinicalSummaryOptions(target.orderId, {
          includeInReport,
          sendToDoctor
        });
        
        if (!result.success) {
          console.error('Failed to save options:', result.error);
        } else {
          console.log(`✅ Options saved: includeInReport=${includeInReport}, sendToDoctor=${sendToDoctor}`);
        }

        // Notify parent about report inclusion preference (for UI state)
        onIncludeInReport?.(target.orderId, includeInReport);

        // Handle send to doctor callback
        if (sendToDoctor && onSendToDoctor) {
          onSendToDoctor(target.orderId, summary as ClinicalSummaryResponse);
        }
      } catch (error) {
        console.error('Failed to save clinical summary:', error);
        alert('Failed to save clinical summary to database');
        setSaving(false);
        return; // Don't close if save failed
      }
      setSaving(false);
    }
    onClose();
  };

  // Check if this is a saved summary from database
  const isSavedSummary = !isVerifier && 'executive_summary' in summary && (summary as ClinicalSummaryResponse)._savedFromDb;
  const savedAt = isSavedSummary ? (summary as ClinicalSummaryResponse)._generatedAt : null;

  return ReactDOM.createPortal(
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-4xl w-full max-h-[90vh] overflow-hidden">
        <div className="bg-gradient-to-r from-purple-600 to-indigo-600 px-6 py-4 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            {isVerifier ? <ClipboardList className="h-6 w-6 text-white" /> : <Stethoscope className="h-6 w-6 text-white" />}
            <div>
              <h3 className="text-xl font-bold text-white">
                {isVerifier ? "AI Verifier Summary" : "Clinical Summary"}
              </h3>
              {isSavedSummary && (
                <p className="text-xs text-purple-200">
                  Saved {savedAt ? new Date(savedAt).toLocaleString() : 'previously'}
                </p>
              )}
            </div>
            {isSavedSummary && (
              <span className="ml-2 px-2 py-1 bg-green-500 text-white text-xs rounded-full font-medium">
                Saved
              </span>
            )}
          </div>
          <div className="flex items-center space-x-2">
            {isSavedSummary && onRegenerate && (
              <button
                onClick={() => {
                  onClose();
                  onRegenerate(target.orderId!);
                }}
                className="flex items-center space-x-1 px-3 py-1.5 bg-white bg-opacity-20 text-white rounded-lg hover:bg-opacity-30 text-sm"
              >
                <RefreshCw className="h-4 w-4" />
                <span>Regenerate</span>
              </button>
            )}
            <button
              onClick={onClose}
              className="text-white hover:bg-white hover:bg-opacity-20 rounded-full p-2"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="p-6 overflow-y-auto max-h-[calc(90vh-280px)]">
          {isVerifier && "overall_assessment" in summary ? (
            <div className="space-y-6">
              <div className="bg-purple-50 rounded-xl p-4 border border-purple-200">
                <h4 className="text-lg font-semibold text-purple-900">Overall Assessment</h4>
                <p className="text-purple-800">{summary.overall_assessment}</p>
              </div>
              {summary.abnormal_findings.length > 0 && (
                <div className="bg-amber-50 rounded-xl p-4 border border-amber-200">
                  <h4 className="text-lg font-semibold text-amber-900">Abnormal Findings</h4>
                  <ul className="list-disc list-inside text-amber-800">
                    {summary.abnormal_findings.map((finding, idx) => (
                      <li key={idx}>{finding}</li>
                    ))}
                  </ul>
                </div>
              )}
              {summary.critical_alerts.length > 0 && (
                <div className="bg-red-50 rounded-xl p-4 border border-red-200">
                  <h4 className="text-lg font-semibold text-red-900">Critical Alerts</h4>
                  <ul className="list-disc list-inside text-red-800">
                    {summary.critical_alerts.map((alert, idx) => (
                      <li key={idx}>{alert}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-6">
              {/* Executive Summary - Editable */}
              <div className="bg-blue-50 rounded-xl p-4 border border-blue-200">
                <h4 className="text-lg font-semibold text-blue-900 mb-2">Executive Summary</h4>
                {isEditing && editedSummary ? (
                  <textarea
                    value={editedSummary.executive_summary}
                    onChange={(e) => setEditedSummary(prev => prev ? { ...prev, executive_summary: e.target.value } : null)}
                    className="w-full p-3 border border-blue-300 rounded-lg text-blue-800 bg-white min-h-[100px] focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    placeholder="Enter executive summary..."
                  />
                ) : (
                  <p className="text-blue-800">{(summary as ClinicalSummaryResponse).executive_summary}</p>
                )}
              </div>

              {/* Significant Findings - Editable */}
              <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                <div className="px-4 py-3 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
                  <h4 className="text-lg font-semibold text-gray-900">Significant Findings</h4>
                  {isEditing && editedSummary && (
                    <button
                      onClick={() => setEditedSummary(prev => prev ? {
                        ...prev,
                        significant_findings: [...prev.significant_findings, { finding: '', clinical_significance: '', test_group: '' }]
                      } : null)}
                      className="text-xs px-3 py-1 bg-blue-100 text-blue-700 rounded-full hover:bg-blue-200"
                    >
                      + Add Finding
                    </button>
                  )}
                </div>
                {isEditing && editedSummary ? (
                  <div className="p-4 space-y-3">
                    {editedSummary.significant_findings.map((finding, idx) => (
                      <div key={idx} className="flex gap-3 items-start">
                        <div className="flex-1 space-y-2">
                          <input
                            value={finding.finding}
                            onChange={(e) => {
                              const updated = [...editedSummary.significant_findings];
                              updated[idx] = { ...updated[idx], finding: e.target.value };
                              setEditedSummary(prev => prev ? { ...prev, significant_findings: updated } : null);
                            }}
                            className="w-full p-2 border border-gray-300 rounded-lg text-sm"
                            placeholder="Finding..."
                          />
                          <input
                            value={finding.clinical_significance}
                            onChange={(e) => {
                              const updated = [...editedSummary.significant_findings];
                              updated[idx] = { ...updated[idx], clinical_significance: e.target.value };
                              setEditedSummary(prev => prev ? { ...prev, significant_findings: updated } : null);
                            }}
                            className="w-full p-2 border border-gray-300 rounded-lg text-sm"
                            placeholder="Clinical significance..."
                          />
                        </div>
                        <button
                          onClick={() => {
                            const updated = editedSummary.significant_findings.filter((_, i) => i !== idx);
                            setEditedSummary(prev => prev ? { ...prev, significant_findings: updated } : null);
                          }}
                          className="p-2 text-red-500 hover:bg-red-50 rounded-lg"
                          title="Remove finding"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                    ))}
                    {editedSummary.significant_findings.length === 0 && (
                      <p className="text-sm text-gray-500 text-center py-2">No findings. Click "Add Finding" to add one.</p>
                    )}
                  </div>
                ) : (summary as ClinicalSummaryResponse).significant_findings.length > 0 ? (
                  <table className="min-w-full">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500">Finding</th>
                        <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500">Clinical Significance</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {(summary as ClinicalSummaryResponse).significant_findings.map((finding, idx) => (
                        <tr key={idx}>
                          <td className="px-4 py-3 text-sm text-gray-800">{finding.finding}</td>
                          <td className="px-4 py-3 text-sm text-gray-600">{finding.clinical_significance}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="p-4 text-sm text-gray-500">No significant findings.</p>
                )}
              </div>

              {/* Suggested Follow-up - Editable */}
              <div className="bg-green-50 rounded-xl p-4 border border-green-200">
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-lg font-semibold text-green-900">Suggested Follow-up</h4>
                  {isEditing && editedSummary && (
                    <button
                      onClick={() => setEditedSummary(prev => prev ? {
                        ...prev,
                        suggested_followup: [...prev.suggested_followup, '']
                      } : null)}
                      className="text-xs px-3 py-1 bg-green-100 text-green-700 rounded-full hover:bg-green-200"
                    >
                      + Add Item
                    </button>
                  )}
                </div>
                {isEditing && editedSummary ? (
                  <div className="space-y-2">
                    {editedSummary.suggested_followup.map((item, idx) => (
                      <div key={idx} className="flex gap-2 items-center">
                        <input
                          value={item}
                          onChange={(e) => {
                            const updated = [...editedSummary.suggested_followup];
                            updated[idx] = e.target.value;
                            setEditedSummary(prev => prev ? { ...prev, suggested_followup: updated } : null);
                          }}
                          className="flex-1 p-2 border border-green-300 rounded-lg text-sm bg-white"
                          placeholder="Follow-up suggestion..."
                        />
                        <button
                          onClick={() => {
                            const updated = editedSummary.suggested_followup.filter((_, i) => i !== idx);
                            setEditedSummary(prev => prev ? { ...prev, suggested_followup: updated } : null);
                          }}
                          className="p-2 text-red-500 hover:bg-red-50 rounded-lg"
                          title="Remove item"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                    ))}
                    {editedSummary.suggested_followup.length === 0 && (
                      <p className="text-sm text-green-700">No follow-up suggestions. Click "Add Item" to add one.</p>
                    )}
                  </div>
                ) : (summary as ClinicalSummaryResponse).suggested_followup.length > 0 ? (
                  <ul className="list-disc list-inside text-green-800">
                    {(summary as ClinicalSummaryResponse).suggested_followup.map((item, idx) => (
                      <li key={idx}>{item}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-green-700">No follow-up suggestions.</p>
                )}
              </div>

              {/* Urgent Findings - Editable */}
              <div className="bg-red-50 rounded-xl p-4 border border-red-200">
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-lg font-semibold text-red-900">Urgent Findings</h4>
                  {isEditing && editedSummary && (
                    <button
                      onClick={() => setEditedSummary(prev => prev ? {
                        ...prev,
                        urgent_findings: [...(prev.urgent_findings || []), '']
                      } : null)}
                      className="text-xs px-3 py-1 bg-red-100 text-red-700 rounded-full hover:bg-red-200"
                    >
                      + Add Urgent Finding
                    </button>
                  )}
                </div>
                {isEditing && editedSummary ? (
                  <div className="space-y-2">
                    {(editedSummary.urgent_findings || []).map((item, idx) => (
                      <div key={idx} className="flex gap-2 items-center">
                        <input
                          value={item}
                          onChange={(e) => {
                            const updated = [...(editedSummary.urgent_findings || [])];
                            updated[idx] = e.target.value;
                            setEditedSummary(prev => prev ? { ...prev, urgent_findings: updated } : null);
                          }}
                          className="flex-1 p-2 border border-red-300 rounded-lg text-sm bg-white"
                          placeholder="Urgent finding..."
                        />
                        <button
                          onClick={() => {
                            const updated = (editedSummary.urgent_findings || []).filter((_, i) => i !== idx);
                            setEditedSummary(prev => prev ? { ...prev, urgent_findings: updated } : null);
                          }}
                          className="p-2 text-red-500 hover:bg-red-50 rounded-lg"
                          title="Remove item"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                    ))}
                    {(!editedSummary.urgent_findings || editedSummary.urgent_findings.length === 0) && (
                      <p className="text-sm text-red-700">No urgent findings. Click "Add Urgent Finding" to add one.</p>
                    )}
                  </div>
                ) : (summary as ClinicalSummaryResponse).urgent_findings && (summary as ClinicalSummaryResponse).urgent_findings!.length > 0 ? (
                  <ul className="list-disc list-inside text-red-800">
                    {(summary as ClinicalSummaryResponse).urgent_findings!.map((item, idx) => (
                      <li key={idx}>{item}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-red-700">No urgent findings.</p>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="border-t bg-gray-50 px-6 py-4">
          {!isVerifier && target.orderId ? (
            <div className="space-y-4">
              {/* Status indicator */}
              {!isEditing && (
                <div className="flex items-center gap-2 text-sm text-green-700 bg-green-50 px-3 py-2 rounded-lg">
                  <CheckCircle2 className="h-4 w-4" />
                  <span>Clinical summary has been automatically saved to database</span>
                </div>
              )}

              {isEditing && (
                <div className="flex items-center gap-2 text-sm text-amber-700 bg-amber-50 px-3 py-2 rounded-lg">
                  <Edit className="h-4 w-4" />
                  <span>Editing mode - make your changes and click "Save Changes"</span>
                </div>
              )}

              {/* Options */}
              <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={includeInReport}
                    onChange={(e) => setIncludeInReport(e.target.checked)}
                    disabled={loadingOptions}
                    className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500 disabled:opacity-50"
                  />
                  <span className="text-sm text-gray-700">Include in final PDF report</span>
                </label>

                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={sendToDoctor}
                    onChange={(e) => setSendToDoctor(e.target.checked)}
                    disabled={loadingOptions}
                    className="w-4 h-4 text-purple-600 rounded focus:ring-purple-500 disabled:opacity-50"
                  />
                  <span className="text-sm text-gray-700">Send summary with report to doctor</span>
                </label>
              </div>

              {/* Actions */}
              <div className="flex items-center justify-between pt-2">
                {/* Edit/Save toggle */}
                <div className="flex items-center gap-2">
                  {!isEditing ? (
                    <button
                      onClick={() => setIsEditing(true)}
                      className="inline-flex items-center px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
                    >
                      <Edit className="h-4 w-4 mr-2" />
                      Edit Summary
                    </button>
                  ) : (
                    <>
                      <button
                        onClick={() => {
                          setIsEditing(false);
                          // Reset to original
                          if (originalSummary && 'executive_summary' in originalSummary) {
                            setEditedSummary({ ...originalSummary } as ClinicalSummaryResponse);
                          }
                        }}
                        className="px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
                      >
                        Cancel Edit
                      </button>
                      <button
                        onClick={handleSaveEdits}
                        disabled={saving}
                        className="inline-flex items-center px-4 py-2 bg-gradient-to-r from-green-600 to-emerald-600 text-white rounded-lg hover:from-green-700 hover:to-emerald-700 transition-all duration-200 shadow-sm font-semibold disabled:opacity-50"
                      >
                        {saving ? (
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        ) : (
                          <Save className="h-4 w-4 mr-2" />
                        )}
                        Save Changes
                      </button>
                    </>
                  )}
                </div>

                {/* Confirm/Close */}
                <div className="flex items-center gap-3">
                  <button
                    onClick={onClose}
                    disabled={saving}
                    className="px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
                  >
                    Close
                  </button>
                  {!isEditing && (
                    <button
                      onClick={handleConfirmOptions}
                      disabled={saving}
                      className="inline-flex items-center px-6 py-2 bg-gradient-to-r from-blue-600 to-indigo-600 text-white rounded-lg hover:from-blue-700 hover:to-indigo-700 transition-all duration-200 shadow-sm font-semibold disabled:opacity-50"
                    >
                      {saving ? (
                        <>
                          <span className="animate-spin h-5 w-5 mr-2 border-2 border-white border-t-transparent rounded-full"></span>
                          Saving...
                        </>
                      ) : (
                        <>
                          <CheckCircle2 className="h-5 w-5 mr-2" />
                          Confirm Options
                        </>
                      )}
                    </button>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <p className="text-sm text-gray-600">Use this intelligence as a guide before final approval.</p>
              <button
                onClick={onClose}
                className="px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Close
              </button>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
};

interface AIInterpretationsModalProps {
  interpretations: GeneratedInterpretation[];
  labId: string | null;
  onClose: () => void;
}

const AIInterpretationsModal: React.FC<AIInterpretationsModalProps> = ({ interpretations, labId, onClose }) => {
  const [saving, setSaving] = useState(false);
  const aiIntelligence = useAIResultIntelligence();

  if (!interpretations.length) return null;

  const handleSave = async () => {
    if (!labId) {
      alert("Lab context unavailable");
      return;
    }

    setSaving(true);
    try {
      const result = await aiIntelligence.saveInterpretationsToDb(labId, interpretations);
      alert(`Saved ${result.success.length} interpretations${result.failed.length ? `, ${result.failed.length} failed` : ""}`);
      onClose();
    } catch (err) {
      console.error("Failed to save interpretations", err);
      alert("Failed to save interpretations");
    } finally {
      setSaving(false);
    }
  };

  return ReactDOM.createPortal(
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-4xl w-full max-h-[90vh] overflow-hidden">
        <div className="bg-gradient-to-r from-amber-500 to-orange-500 px-6 py-4 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <Zap className="h-6 w-6 text-white" />
            <h3 className="text-xl font-bold text-white">AI Interpretations</h3>
            <span className="bg-white bg-opacity-20 px-2 py-1 rounded-full text-sm text-white">
              {interpretations.length} analytes
            </span>
          </div>
          <button
            onClick={onClose}
            className="text-white hover:bg-white hover:bg-opacity-20 rounded-full p-2"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-6 overflow-y-auto max-h-[calc(90vh-160px)]">
          <div className="space-y-4">
            {interpretations.map((interp, idx) => (
              <div key={idx} className="border border-gray-200 rounded-xl p-4 bg-gray-50">
                <div className="text-lg font-semibold text-gray-900 mb-2">{interp.analyte_name}</div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm text-gray-700">
                  <div>
                    <p className="font-semibold text-gray-600">Low</p>
                    <p>{interp.interpretation_low}</p>
                  </div>
                  <div>
                    <p className="font-semibold text-gray-600">Normal</p>
                    <p>{interp.interpretation_normal}</p>
                  </div>
                  <div>
                    <p className="font-semibold text-gray-600">High</p>
                    <p>{interp.interpretation_high}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="border-t bg-gray-50 px-6 py-4 flex items-center justify-between">
          <p className="text-sm text-gray-600">Review interpretations before saving to your lab knowledge base.</p>
          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="inline-flex items-center px-6 py-2 bg-gradient-to-r from-blue-600 to-indigo-600 text-white rounded-lg disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-5 w-5 mr-2 animate-spin" /> : <CheckCircle2 className="h-5 w-5 mr-2" />} Save to Lab
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};

/* ----------------- AI Delta Check Modal Component ----------------- */
interface AIDeltaCheckModalProps {
  deltaCheck: DeltaCheckResponse;
  onClose: () => void;
}

const AIDeltaCheckModal: React.FC<AIDeltaCheckModalProps> = ({ deltaCheck, onClose }) => {
  const getConfidenceColor = (level: string) => {
    switch (level) {
      case 'high': return 'from-green-500 to-emerald-500';
      case 'medium': return 'from-yellow-500 to-amber-500';
      case 'low': return 'from-red-500 to-rose-500';
      default: return 'from-gray-500 to-slate-500';
    }
  };

  const getRecommendationColor = (rec: string) => {
    switch (rec) {
      case 'approve': return 'bg-green-100 text-green-800 border-green-200';
      case 'review_required': return 'bg-yellow-100 text-yellow-800 border-yellow-200';
      case 'reject': return 'bg-red-100 text-red-800 border-red-200';
      default: return 'bg-gray-100 text-gray-800 border-gray-200';
    }
  };

  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case 'critical': return 'bg-red-100 text-red-800 border-red-300';
      case 'high': return 'bg-orange-100 text-orange-800 border-orange-300';
      case 'medium': return 'bg-yellow-100 text-yellow-800 border-yellow-300';
      case 'low': return 'bg-blue-100 text-blue-800 border-blue-300';
      default: return 'bg-gray-100 text-gray-800 border-gray-300';
    }
  };

  return ReactDOM.createPortal(
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-4xl w-full max-h-[90vh] overflow-hidden">
        {/* Header */}
        <div className="bg-gradient-to-r from-amber-500 to-orange-500 px-6 py-4 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <ShieldCheck className="h-6 w-6 text-white" />
            <h3 className="text-xl font-bold text-white">AI Delta Check Results</h3>
            <span className={`px-3 py-1 rounded-full text-sm font-semibold bg-gradient-to-r ${getConfidenceColor(deltaCheck.confidence_level)} text-white`}>
              {deltaCheck.confidence_score}% Confidence
            </span>
          </div>
          <button
            onClick={onClose}
            className="text-white hover:bg-white hover:bg-opacity-20 rounded-full p-2 transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto max-h-[calc(90vh-160px)] space-y-6">
          {/* Summary Section */}
          <div className="bg-gradient-to-r from-gray-50 to-slate-50 rounded-xl p-4 border border-gray-200">
            <div className="flex items-start gap-4">
              <div className={`flex-shrink-0 p-3 rounded-full ${deltaCheck.confidence_level === 'high' ? 'bg-green-100' : deltaCheck.confidence_level === 'medium' ? 'bg-yellow-100' : 'bg-red-100'}`}>
                {deltaCheck.confidence_level === 'high' ? (
                  <CheckCircle2 className="h-6 w-6 text-green-600" />
                ) : deltaCheck.confidence_level === 'medium' ? (
                  <AlertTriangle className="h-6 w-6 text-yellow-600" />
                ) : (
                  <AlertCircle className="h-6 w-6 text-red-600" />
                )}
              </div>
              <div className="flex-1">
                <p className="text-gray-700">{deltaCheck.summary}</p>
                <div className="mt-2">
                  <span className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-semibold border ${getRecommendationColor(deltaCheck.recommendation)}`}>
                    Recommendation: {deltaCheck.recommendation.replace('_', ' ').toUpperCase()}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Issues Section */}
          {deltaCheck.issues.length > 0 && (
            <div className="space-y-3">
              <h4 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
                <AlertCircle className="h-5 w-5 text-red-500" />
                Issues Identified ({deltaCheck.issues.length})
              </h4>
              <div className="space-y-3">
                {deltaCheck.issues.map((issue, idx) => (
                  <div key={idx} className={`rounded-xl p-4 border ${getSeverityColor(issue.severity)}`}>
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="font-semibold">{issue.analyte_name}</span>
                          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${getSeverityColor(issue.severity)}`}>
                            {issue.severity.toUpperCase()}
                          </span>
                          <span className="text-xs px-2 py-0.5 rounded-full bg-gray-200 text-gray-700">
                            {issue.issue_type.replace(/_/g, ' ')}
                          </span>
                        </div>
                        <p className="text-sm text-gray-700">{issue.description}</p>
                        {issue.current_value && issue.expected_range && (
                          <p className="text-xs text-gray-500 mt-1">
                            Current: <span className="font-mono">{issue.current_value}</span> | Expected: <span className="font-mono">{issue.expected_range}</span>
                          </p>
                        )}
                        {issue.suggested_action && (
                          <p className="text-sm text-blue-700 mt-2 flex items-center gap-1">
                            <Zap className="h-3 w-3" /> Suggested: {issue.suggested_action}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Validated Results Section */}
          {deltaCheck.validated_results.length > 0 && (
            <div className="space-y-3">
              <h4 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
                <CheckCircle2 className="h-5 w-5 text-green-500" />
                Validated Results ({deltaCheck.validated_results.length})
              </h4>
              <div className="flex flex-wrap gap-2">
                {deltaCheck.validated_results.map((result, idx) => (
                  <span key={idx} className="inline-flex items-center px-3 py-1.5 rounded-lg bg-green-50 text-green-800 text-sm border border-green-200">
                    <CheckCircle2 className="h-4 w-4 mr-1.5" />
                    {result}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Verifier Notes Section */}
          {deltaCheck.verifier_notes && (
            <div className="bg-blue-50 rounded-xl p-4 border border-blue-200">
              <h4 className="text-sm font-semibold text-blue-900 mb-2 flex items-center gap-2">
                <FileText className="h-4 w-4" />
                Notes for Verifier
              </h4>
              <p className="text-sm text-blue-800 whitespace-pre-wrap">{deltaCheck.verifier_notes}</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t bg-gray-50 px-6 py-4 flex items-center justify-between">
          <p className="text-sm text-gray-600">Review the delta check results before proceeding with verification.</p>
          <button
            onClick={onClose}
            className="px-6 py-2 bg-gradient-to-r from-gray-600 to-slate-600 text-white rounded-lg hover:from-gray-700 hover:to-slate-700 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

/* ----------------- Order-Level AI Delta Check Modal Component ----------------- */
interface OrderDeltaCheckModalProps {
  deltaCheck: OrderDeltaCheckResponse;
  onClose: () => void;
}

const OrderDeltaCheckModal: React.FC<OrderDeltaCheckModalProps> = ({ deltaCheck, onClose }) => {
  const getConfidenceColor = (level: string) => {
    switch (level) {
      case 'high': return 'from-green-500 to-emerald-500';
      case 'medium': return 'from-yellow-500 to-amber-500';
      case 'low': return 'from-red-500 to-rose-500';
      default: return 'from-gray-500 to-slate-500';
    }
  };

  const getRecommendationColor = (rec: string) => {
    switch (rec) {
      case 'approve': return 'bg-green-100 text-green-800 border-green-200';
      case 'review_required': return 'bg-yellow-100 text-yellow-800 border-yellow-200';
      case 'reject': return 'bg-red-100 text-red-800 border-red-200';
      default: return 'bg-gray-100 text-gray-800 border-gray-200';
    }
  };

  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case 'critical': return 'bg-red-100 text-red-800 border-red-300';
      case 'warning': return 'bg-yellow-100 text-yellow-800 border-yellow-300';
      case 'info': return 'bg-blue-100 text-blue-800 border-blue-300';
      default: return 'bg-gray-100 text-gray-800 border-gray-300';
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'pass': return 'bg-green-100 text-green-800 border-green-200';
      case 'warning': return 'bg-yellow-100 text-yellow-800 border-yellow-200';
      case 'fail': return 'bg-red-100 text-red-800 border-red-200';
      default: return 'bg-gray-100 text-gray-800 border-gray-200';
    }
  };

  const totalIssues = (deltaCheck.test_group_issues?.reduce((sum, tg) => sum + (tg.issues?.length || 0), 0) || 0) +
    (deltaCheck.inter_test_group_issues?.length || 0);

  return ReactDOM.createPortal(
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-5xl w-full max-h-[90vh] overflow-hidden">
        {/* Header */}
        <div className="bg-gradient-to-r from-amber-500 to-orange-600 px-6 py-4 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <ShieldCheck className="h-6 w-6 text-white" />
            <h3 className="text-xl font-bold text-white">Order-Level AI Delta Check</h3>
            <span className={`px-3 py-1 rounded-full text-sm font-semibold bg-gradient-to-r ${getConfidenceColor(deltaCheck.confidence_level)} text-white shadow-sm`}>
              {deltaCheck.confidence_score}% Confidence
            </span>
          </div>
          <button
            onClick={onClose}
            className="text-white hover:bg-white hover:bg-opacity-20 rounded-full p-2 transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto max-h-[calc(90vh-180px)] space-y-6">
          {/* Summary Section */}
          <div className="bg-gradient-to-r from-gray-50 to-slate-50 rounded-xl p-4 border border-gray-200">
            <div className="flex items-start gap-4">
              <div className={`flex-shrink-0 p-3 rounded-full ${deltaCheck.confidence_level === 'high' ? 'bg-green-100' : deltaCheck.confidence_level === 'medium' ? 'bg-yellow-100' : 'bg-red-100'}`}>
                {deltaCheck.confidence_level === 'high' ? (
                  <CheckCircle2 className="h-6 w-6 text-green-600" />
                ) : deltaCheck.confidence_level === 'medium' ? (
                  <AlertTriangle className="h-6 w-6 text-yellow-600" />
                ) : (
                  <AlertCircle className="h-6 w-6 text-red-600" />
                )}
              </div>
              <div className="flex-1">
                <p className="text-gray-700 text-lg">{deltaCheck.summary}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <span className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-semibold border ${getRecommendationColor(deltaCheck.recommendation)}`}>
                    Recommendation: {deltaCheck.recommendation?.replace('_', ' ').toUpperCase()}
                  </span>
                  <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-gray-100 text-gray-700 border border-gray-200">
                    {totalIssues} Issue{totalIssues !== 1 ? 's' : ''} Found
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Quality Breakdown by Test Group */}
          {deltaCheck.quality_breakdown && deltaCheck.quality_breakdown.length > 0 && (
            <div className="space-y-3">
              <h4 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
                <BarChart3 className="h-5 w-5 text-indigo-500" />
                Quality Score by Test Group
              </h4>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                {deltaCheck.quality_breakdown.map((item, idx) => (
                  <div key={idx} className={`rounded-xl p-4 border ${getStatusColor(item.status)}`}>
                    <div className="font-medium text-sm truncate">{item.test_group}</div>
                    <div className="flex items-center justify-between mt-2">
                      <span className="text-2xl font-bold">{item.score}</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${getStatusColor(item.status)}`}>
                        {item.status.toUpperCase()}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Inter-Test Group Issues - The key differentiator */}
          {deltaCheck.inter_test_group_issues && deltaCheck.inter_test_group_issues.length > 0 && (
            <div className="space-y-3">
              <h4 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
                <Activity className="h-5 w-5 text-purple-500" />
                Inter-Test Group Validation ({deltaCheck.inter_test_group_issues.length})
              </h4>
              <div className="space-y-3">
                {deltaCheck.inter_test_group_issues.map((issue, idx) => (
                  <div key={idx} className={`rounded-xl p-4 border ${getSeverityColor(issue.severity)}`}>
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-2">
                          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${getSeverityColor(issue.severity)}`}>
                            {issue.severity?.toUpperCase()}
                          </span>
                          <span className="text-xs px-2 py-0.5 rounded-full bg-purple-100 text-purple-700">
                            {issue.issue_type?.replace(/_/g, ' ')}
                          </span>
                        </div>
                        <p className="text-sm text-gray-700 font-medium">{issue.description}</p>
                        <div className="mt-2 flex flex-wrap gap-1">
                          <span className="text-xs text-gray-500">Groups:</span>
                          {issue.test_groups_involved?.map((tg, i) => (
                            <span key={i} className="text-xs px-2 py-0.5 rounded bg-gray-200 text-gray-700">{tg}</span>
                          ))}
                        </div>
                        {issue.affected_analytes && issue.affected_analytes.length > 0 && (
                          <div className="mt-1 flex flex-wrap gap-1">
                            <span className="text-xs text-gray-500">Analytes:</span>
                            {issue.affected_analytes.map((a, i) => (
                              <span key={i} className="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-800">{a}</span>
                            ))}
                          </div>
                        )}
                        {issue.clinical_rationale && (
                          <p className="text-xs text-gray-600 mt-2 italic">
                            <strong>Clinical rationale:</strong> {issue.clinical_rationale}
                          </p>
                        )}
                        {issue.suggested_action && (
                          <p className="text-sm text-blue-700 mt-2 flex items-center gap-1">
                            <Zap className="h-3 w-3" /> {issue.suggested_action}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Per-Test-Group Issues */}
          {deltaCheck.test_group_issues && deltaCheck.test_group_issues.some(tg => tg.issues && tg.issues.length > 0) && (
            <div className="space-y-3">
              <h4 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
                <AlertCircle className="h-5 w-5 text-red-500" />
                Issues by Test Group
              </h4>
              <div className="space-y-4">
                {deltaCheck.test_group_issues.filter(tg => tg.issues && tg.issues.length > 0).map((tg, tgIdx) => (
                  <div key={tgIdx} className="border border-gray-200 rounded-xl overflow-hidden">
                    <div className="bg-gray-100 px-4 py-2 font-medium text-gray-800 flex items-center gap-2">
                      <TestTube className="h-4 w-4" />
                      {tg.test_group_name}
                      <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full">
                        {tg.issues.length} issue{tg.issues.length !== 1 ? 's' : ''}
                      </span>
                    </div>
                    <div className="p-4 space-y-2">
                      {tg.issues.map((issue, issueIdx) => (
                        <div key={issueIdx} className={`rounded-lg p-3 border ${getSeverityColor(issue.severity)}`}>
                          <div className="flex items-center gap-2 mb-1">
                            <span className="font-medium text-sm">{issue.affected_analytes?.join(', ')}</span>
                            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${getSeverityColor(issue.severity)}`}>
                              {issue.severity?.toUpperCase()}
                            </span>
                          </div>
                          <p className="text-sm text-gray-700">{issue.description}</p>
                          {issue.suggested_action && (
                            <p className="text-xs text-blue-700 mt-1 flex items-center gap-1">
                              <Zap className="h-3 w-3" /> {issue.suggested_action}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Attention Required */}
          {deltaCheck.attention_required && deltaCheck.attention_required.length > 0 && (
            <div className="space-y-3">
              <h4 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
                <Eye className="h-5 w-5 text-amber-500" />
                Attention Required ({deltaCheck.attention_required.length})
              </h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {deltaCheck.attention_required.map((item, idx) => (
                  <div key={idx} className="flex items-center gap-3 p-3 bg-amber-50 rounded-lg border border-amber-200">
                    <AlertTriangle className="h-4 w-4 text-amber-600 flex-shrink-0" />
                    <div>
                      <span className="text-sm font-medium text-amber-800">{item.analyte}</span>
                      <span className="text-xs text-amber-600 ml-2">({item.test_group})</span>
                      <p className="text-xs text-amber-700 mt-0.5">{item.reason}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Validated Results Section */}
          {deltaCheck.validated_results && deltaCheck.validated_results.length > 0 && (
            <div className="space-y-3">
              <h4 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
                <CheckCircle2 className="h-5 w-5 text-green-500" />
                Validated Results ({deltaCheck.validated_results.length})
              </h4>
              <div className="flex flex-wrap gap-2">
                {deltaCheck.validated_results.slice(0, 20).map((result, idx) => (
                  <span key={idx} className="inline-flex items-center px-3 py-1.5 rounded-lg bg-green-50 text-green-800 text-sm border border-green-200">
                    <CheckCircle2 className="h-3 w-3 mr-1.5" />
                    {result}
                  </span>
                ))}
                {deltaCheck.validated_results.length > 20 && (
                  <span className="inline-flex items-center px-3 py-1.5 rounded-lg bg-gray-100 text-gray-600 text-sm border border-gray-200">
                    +{deltaCheck.validated_results.length - 20} more
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Verifier Notes Section */}
          {deltaCheck.verifier_notes && (
            <div className="bg-blue-50 rounded-xl p-4 border border-blue-200">
              <h4 className="text-sm font-semibold text-blue-900 mb-2 flex items-center gap-2">
                <FileText className="h-4 w-4" />
                Notes for Verifier
              </h4>
              <p className="text-sm text-blue-800 whitespace-pre-wrap">{deltaCheck.verifier_notes}</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t bg-gray-50 px-6 py-4 flex items-center justify-between">
          <p className="text-sm text-gray-600">Review the comprehensive order-level delta check before proceeding.</p>
          <div className="flex gap-3">
            <button
              onClick={() => {
                const text = `Order Delta Check Results\n\nConfidence: ${deltaCheck.confidence_score}%\nRecommendation: ${deltaCheck.recommendation}\n\nSummary:\n${deltaCheck.summary}\n\nVerifier Notes:\n${deltaCheck.verifier_notes || 'None'}`;
                navigator.clipboard.writeText(text);
                alert('Results copied to clipboard!');
              }}
              className="px-4 py-2 bg-white border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Copy to Clipboard
            </button>
            <button
              onClick={onClose}
              className="px-6 py-2 bg-gradient-to-r from-gray-600 to-slate-600 text-white rounded-lg hover:from-gray-700 hover:to-slate-700 transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default OrderVerificationView;
