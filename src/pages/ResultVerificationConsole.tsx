import React, { useEffect, useMemo, useState, useCallback, useRef } from "react";
import ReactDOM from "react-dom";
import {
  Search,
  Calendar,
  ChevronDown,
  ChevronUp,
  User,
  TestTube,
  ShieldCheck,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  CheckSquare,
  RefreshCcw,
  AlertCircle,
  Clock,
  TrendingUp,
  FileText,
  Zap,
  Activity,
  BarChart3,
  Target,
  Loader2,
  Filter as FilterIcon,
  X,
  ChevronRight,
	  Eye,
	  EyeOff,
  Expand,
  Minimize,
  FileImage,
  Sparkles,
  ClipboardList,
  Stethoscope,
  Mail,
  Calculator,
	  Undo2,
	  Lock
} from "lucide-react";
import { supabase, database } from "../utils/supabase";
import { loadOrderedAnalyteRows } from "../utils/analyteDisplayOrder";
import AttachmentSelector from "../components/Reports/AttachmentSelector";
import OrderVerificationView from "./OrderVerificationView";
import { useAIResultIntelligence, type VerifierSummaryResponse, type ClinicalSummaryResponse, type GeneratedInterpretation, type ResultValue, type DeltaCheckResponse } from "../hooks/useAIResultIntelligence";
import { saveClinicalSummary } from "../utils/reportExtrasService";
import TrendGraphPanel from "../components/Results/TrendGraphPanel";
import AIResultSuggestionCard from "../components/Results/AIResultSuggestionCard";
import SectionEditor, { type SectionEditorRef } from "../components/Results/SectionEditor";
import WorkflowExecutionPanel from "../components/Workflow/WorkflowExecutionPanel";
import { useCalculatedParameters } from "../hooks/useCalculatedParameters";
import { usePermissions } from "../hooks/usePermissions";
import {
  getSectionEditPermissionForDepartment,
  getSectionVerificationPermissionForDepartment,
  getVerificationPermissionForDepartment,
} from "../utils/resultPermissions";
import { evaluateTextCalculation, normalizeCalculationResultType } from "../utils/calculationRules";
import { calculateFlag } from "../utils/flagCalculation";
import { FALLBACK_DECIMAL_PLACES, normalizeDecimalPlaces, roundHalfUp } from "../utils/resultValueFormat";

/* =========================================
   Types
========================================= */

type PanelRow = {
  order_id: string;
  result_id: string;
  test_group_id: string | null;
  test_group_name: string | null;
  has_result?: boolean;
  is_section_only?: boolean;
  expected_analytes: number;
  entered_analytes: number;
  approved_analytes: number;
  panel_ready: boolean;
  result_verification_status?: string | null;
  notes?: string | null;
  patient_id: string;
  patient_name: string;
  patient_age?: string | number | null;
  patient_gender?: string | null;
	  order_date: string;
	  department?: string | null;
  sample_id?: string | null;
  order_number?: number | null;
  doctor?: string | null;
  account_id?: string | null;
  account_name?: string | null;
  priority?: "Normal" | "Urgent" | "STAT" | null;
};

type Analyte = {
  id: string;
  result_id: string;
  analyte_id: string; // UUID reference to analytes table
  lab_analyte_id?: string | null;
  parameter: string;
  value: string | null;
  unit: string;
  reference_range: string;
  flag: string | null;
  verify_status: "pending" | "approved" | "rejected" | null;
  verify_note: string | null;
  verified_by: string | null;
  verified_at: string | null;
  // Calculated parameter fields
  is_auto_calculated?: boolean;
  calculation_inputs?: Record<string, number>;
	  calculated_at?: string;
	  is_hidden_from_report?: boolean | null;
	  hidden_reason?: string | null;
    section_heading?: string | null;
    sort_order?: number | null;
    display_order?: number | null;
};

type CalcDebugHintsByResult = Record<string, Record<string, string[]>>;

type TrendData = {
  order_date: string;
  test_name: string;
  value: string;
  unit: string;
  reference_range: string;
  flag: string | null;
};

type Attachment = {
  id: string;
  file_url: string;
  file_type: string;
  original_filename: string;
  created_at: string;
  level: 'test' | 'order';
};

type StateFilter = "all" | "pending" | "partial" | "ready";
type ViewMode = "panel" | "order";
type PanelSortMode = "sample_desc" | "sample_asc" | "date_desc" | "patient_az";

type BulkApprovalProgress = {
  total: number;
  attempted: number;
  approved: number;
  failed: number;
  skipped: number;
  status: "running" | "completed" | "failed";
};

/* =========================================
   Helpers
========================================= */

const todayISO = () => new Date().toISOString().slice(0, 10);
const fromYesterdayISO = () => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
};

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });

const normalizeIdForSearch = (value: string) => value.replace(/-/g, "").toLowerCase();
const getDailySeq = (row: Pick<PanelRow, "order_number" | "sample_id">) => {
  if (typeof row.order_number === "number" && Number.isFinite(row.order_number)) return row.order_number;
  const tail = String(row.sample_id || "").match(/(?:^|[/-])(\d+)\s*$/)?.[1] || "";
  const parsed = parseInt(tail, 10);
  return Number.isFinite(parsed) ? parsed : 0;
};
const toNumber = (raw: string | number | null | undefined): number | null => {
  if (raw === null || raw === undefined) return null;
  const parsed = Number(String(raw).replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : null;
};
const toVariableSlug = (name: string): string => {
  const abbrevMap: Record<string, string> = {
    "total cholesterol": "TC",
    "hdl cholesterol": "HDL",
    "ldl cholesterol": "LDL",
    "triglycerides": "TG",
    "hemoglobin": "HGB",
    "hematocrit": "HCT",
    "red blood cell": "RBC",
    "white blood cell": "WBC",
    "platelet": "PLT",
    "mean corpuscular volume": "MCV",
    "mean corpuscular hemoglobin": "MCH",
    "albumin": "ALB",
    "globulin": "GLOB",
    "total protein": "TP",
    "creatinine": "CREAT",
    "blood urea nitrogen": "BUN",
    "urea": "UREA",
    "glucose": "GLU",
    "calcium": "CA",
    "sodium": "NA",
    "potassium": "K",
  };
  const lower = name.toLowerCase();
  for (const [full, abbrev] of Object.entries(abbrevMap)) {
    if (lower.includes(full)) return abbrev.toLowerCase();
  }
  const words = name.replace(/[^a-zA-Z0-9\s]/g, "").split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  if (words.length === 1) return words[0].substring(0, 4).toLowerCase();
  return words.map((w) => w.substring(0, 3)).join("").toLowerCase().substring(0, 6);
};

type CanonicalFlag =
  | "normal"
  | "high"
  | "low"
  | "abnormal"
  | "critical"
  | "critical_high"
  | "critical_low";

const FLAG_DROPDOWN_OPTIONS: Array<{ value: CanonicalFlag; label: string }> = [
  { value: "normal", label: "Normal" },
  { value: "high", label: "High" },
  { value: "low", label: "Low" },
  { value: "abnormal", label: "Abnormal" },
  { value: "critical", label: "Critical" },
  { value: "critical_high", label: "Critical High" },
  { value: "critical_low", label: "Critical Low" },
];

const normalizeFlagToken = (flag: string | null | undefined) =>
  (flag || "")
    .trim()
    .toLowerCase()
    .replace(/[-\s]/g, "_")
    .replace(/[^a-z0-9_]/g, "");

const normalizeFormulaForPanelEvaluation = (formula: string): string => {
  let expression = formula.trim().replace(/\bpow\s*\(/g, "Math.pow(");

  // JavaScript cannot parse `base ** -0.411`; convert lab-style ^ powers to Math.pow().
  // Handles common LIMS formulas like: 141 * (CREAT / 0.9) ^ -0.411 * 0.993 ^ AGE
  const powerPattern =
    /(\([^()]+\)|-?\d+(?:\.\d+)?|[A-Za-z_][A-Za-z0-9_]*)\s*\^\s*(\([^()]+\)|-?\d+(?:\.\d+)?|[A-Za-z_][A-Za-z0-9_]*)/g;

  for (let i = 0; i < 10; i++) {
    const next = expression.replace(powerPattern, "Math.pow($1, $2)");
    if (next === expression) break;
    expression = next;
  }

  return expression;
};

const getCanonicalFlag = (flag: string | null | undefined): CanonicalFlag | null => {
  const token = normalizeFlagToken(flag);
  if (!token) return null;

  if (["n", "normal", "ok", "within_range", "withinnormal", "wnl"].includes(token)) return "normal";
  if (["h", "high", "hh", "hi"].includes(token)) return "high";
  if (["l", "low", "ll"].includes(token)) return "low";
  if (["a", "abnormal", "abn"].includes(token)) return "abnormal";
  if (["c", "critical", "crit", "panic"].includes(token)) return "critical";
  if (["critical_high", "criticalh", "critical_h", "high_critical", "criticalhigh", "ch"].includes(token)) return "critical_high";
  if (["critical_low", "criticall", "critical_l", "low_critical", "criticallow", "cl"].includes(token)) return "critical_low";

  if (token.includes("critical") && token.includes("high")) return "critical_high";
  if (token.includes("critical") && token.includes("low")) return "critical_low";
  if (token.includes("critical")) return "critical";
  if (token.includes("high")) return "high";
  if (token.includes("low")) return "low";

  return null;
};

const getDisplayFlagLabel = (flag: string | null | undefined): string | null => {
  const canonical = getCanonicalFlag(flag);
  if (!canonical) return flag || null;

  const option = FLAG_DROPDOWN_OPTIONS.find((opt) => opt.value === canonical);
  return option?.label || flag || null;
};

const getFlagBadgeStyles = (flag: string | null | undefined) => {
  const canonical = getCanonicalFlag(flag);

  if (canonical === "high" || canonical === "critical_high") {
    return { bg: "bg-red-100", text: "text-red-800" };
  }
  if (canonical === "low" || canonical === "critical_low") {
    return { bg: "bg-blue-100", text: "text-blue-800" };
  }
  if (canonical === "critical" || canonical === "abnormal") {
    return { bg: "bg-orange-100", text: "text-orange-800" };
  }
  if (canonical === "normal") {
    return { bg: "bg-emerald-100", text: "text-emerald-800" };
  }

  return { bg: "bg-gray-100", text: "text-gray-800" };
};

const describeSupabaseError = (error: unknown) => {
  if (!error || typeof error !== "object") return { message: String(error) };
  const err = error as {
    message?: string;
    code?: string;
    details?: string;
    hint?: string;
    name?: string;
    status?: number;
  };

  return {
    message: err.message,
    code: err.code,
    details: err.details,
    hint: err.hint,
    name: err.name,
    status: err.status,
  };
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

const toStoredFlagValue = (canonicalFlag: string | null | undefined): string | null => {
  const canonical = getCanonicalFlag(canonicalFlag);
  if (!canonical || canonical === "normal") return null;

  switch (canonical) {
    case "high":
      return "H";
    case "low":
      return "L";
    case "critical":
      return "C";
    case "critical_high":
      return "critical_high";
    case "critical_low":
      return "critical_low";
    case "abnormal":
      return "abnormal";
    default:
      return canonicalFlag || null;
  }
};

const toSelectFlagValue = (flag: string | null | undefined): CanonicalFlag => getCanonicalFlag(flag) || "normal";

const isCriticalFlag = (flag: string | null | undefined) => {
  const canonical = getCanonicalFlag(flag);
  return canonical === "critical" || canonical === "critical_high" || canonical === "critical_low";
};

const isAbnormalFlag = (flag: string | null | undefined) => {
  const canonical = getCanonicalFlag(flag);
  return !!canonical && canonical !== "normal";
};

const toAISuggestionFlag = (flag: string | null | undefined): "H" | "L" | "C" | null => {
  const canonical = getCanonicalFlag(flag);
  if (canonical === "high") return "H";
  if (canonical === "low") return "L";
  if (canonical === "critical" || canonical === "critical_high" || canonical === "critical_low") return "C";
  return null;
};

/* =========================================
   Attachment Item Component
========================================= */

interface AttachmentItemProps {
  attachment: Attachment;
  levelColor: string;
  levelBgColor: string;
}

const AttachmentItem: React.FC<AttachmentItemProps> = ({ attachment, levelColor, levelBgColor }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [previewContent, setPreviewContent] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const isPreviewable = attachment.file_type === 'text/plain' ||
    attachment.file_type === 'application/json' ||
    attachment.file_type?.startsWith('image/') ||
    attachment.original_filename.toLowerCase().endsWith('.txt') ||
    attachment.original_filename.toLowerCase().endsWith('.json') ||
    attachment.original_filename.toLowerCase().endsWith('.csv') ||
    attachment.original_filename.toLowerCase().endsWith('.png') ||
    attachment.original_filename.toLowerCase().endsWith('.jpg') ||
    attachment.original_filename.toLowerCase().endsWith('.jpeg') ||
    attachment.original_filename.toLowerCase().endsWith('.gif') ||
    attachment.original_filename.toLowerCase().endsWith('.bmp');

  const isImage = attachment.file_type?.startsWith('image/') ||
    attachment.original_filename.toLowerCase().match(/\.(png|jpg|jpeg|gif|bmp)$/);

  const handleExpand = async () => {
    if (!isExpanded && isPreviewable && !previewContent && !isImage) {
      setPreviewLoading(true);
      try {
        const response = await fetch(attachment.file_url);
        const text = await response.text();
        setPreviewContent(text);
      } catch (error) {
        console.error('Failed to load preview:', error);
        setPreviewContent('Failed to load preview');
      } finally {
        setPreviewLoading(false);
      }
    }
    setIsExpanded(!isExpanded);
  };

  return (
    <div className={`border rounded ${levelBgColor} ${levelColor.replace('text-', 'border-')}`}>
      <div className="flex items-center justify-between p-2">
        <div className="flex items-center space-x-2 flex-1">
          <FileText className={`h-4 w-4 ${levelColor}`} />
          <div className="flex-1">
            <p className="text-sm font-medium">{attachment.original_filename}</p>
            <p className={`text-xs ${levelColor}`}>
              {attachment.level === 'test' ? 'Test' : 'Order'} Level • {new Date(attachment.created_at).toLocaleDateString()}
            </p>
          </div>
        </div>
        <div className="flex items-center space-x-1">
          {isPreviewable && (
            <button
              onClick={handleExpand}
              className={`p-1 ${levelColor} hover:opacity-75 transition-opacity`}
              title={isExpanded ? "Minimize" : "Expand preview"}
            >
              {isExpanded ? <Minimize className="h-4 w-4" /> : <Expand className="h-4 w-4" />}
            </button>
          )}
          <a
            href={attachment.file_url}
            target="_blank"
            rel="noopener noreferrer"
            className={`${levelColor} hover:opacity-75 transition-opacity`}
            title="Open in new tab"
          >
            <Eye className="h-4 w-4" />
          </a>
        </div>
      </div>

      {isExpanded && (
        <div className="border-t p-4 bg-white/50">
          {previewLoading ? (
            <div className="flex items-center justify-center py-8">
              <RefreshCcw className="h-5 w-5 animate-spin mr-2" />
              <span className="text-sm text-gray-600">Loading preview...</span>
            </div>
          ) : isImage ? (
            <div className="max-h-96 overflow-y-auto border rounded bg-white p-2">
              <img
                src={attachment.file_url}
                alt={attachment.original_filename}
                className="max-w-full h-auto rounded"
                style={{ maxHeight: '500px' }}
              />
            </div>
          ) : previewContent ? (
            <div className="max-h-96 overflow-y-auto border rounded bg-white">
              <pre className="text-sm bg-gray-50 p-4 whitespace-pre-wrap break-words font-mono leading-relaxed">
                {previewContent.length > 2000 ? `${previewContent.substring(0, 2000)}...\n\n[Preview truncated - full content available in new tab]` : previewContent}
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
};

/* =========================================
   Attachment Viewer Component
========================================= */

interface AttachmentViewerProps {
  attachments: Attachment[];
  viewMode: 'test' | 'all';
}

const AttachmentViewer: React.FC<AttachmentViewerProps> = ({ attachments, viewMode }) => {
  const testAttachments = attachments.filter(a => a.level === 'test');
  const orderAttachments = attachments.filter(a => a.level === 'order');
  const filteredAttachments = viewMode === 'test' ? testAttachments : attachments;

  if (filteredAttachments.length === 0) {
    if (viewMode === 'test') {
      if (orderAttachments.length > 0) {
        return (
          <div className="space-y-3">
            <div className="text-sm text-amber-600 bg-amber-50 p-3 rounded-lg border border-amber-200">
              <div className="flex items-center space-x-2">
                <AlertTriangle className="h-4 w-4" />
                <span className="font-medium">No test-specific attachments for this test</span>
              </div>
              <p className="text-xs text-amber-700 mt-1">
                There are {orderAttachments.length} order-level attachment{orderAttachments.length > 1 ? 's' : ''} available. Switch to "All" view to see them.
              </p>
            </div>
          </div>
        );
      } else {
        return (
          <div className="text-sm text-gray-500 bg-gray-50 p-3 rounded-lg border border-gray-200">
            <div className="flex items-center space-x-2">
              <FileText className="h-4 w-4" />
              <span>No attachments found for this test or order</span>
            </div>
          </div>
        );
      }
    } else {
      return (
        <div className="text-sm text-gray-500 bg-gray-50 p-3 rounded-lg border border-gray-200">
          <div className="flex items-center space-x-2">
            <FileText className="h-4 w-4" />
            <span>No attachments found for this order</span>
          </div>
        </div>
      );
    }
  }

  return (
    <div className="space-y-2">
      {viewMode === 'all' && testAttachments.length > 0 && orderAttachments.length > 0 && (
        <div className="mb-4">
          <h5 className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-2">Test-Specific Attachments</h5>
          <div className="space-y-2">
            {testAttachments.map(attachment => (
              <AttachmentItem
                key={attachment.id}
                attachment={attachment}
                levelColor="text-blue-600"
                levelBgColor="bg-blue-50"
              />
            ))}
          </div>

          {orderAttachments.length > 0 && (
            <>
              <h5 className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-2 mt-4">Order-Level Attachments</h5>
              <div className="space-y-2">
                {orderAttachments.map(attachment => (
                  <AttachmentItem
                    key={attachment.id}
                    attachment={attachment}
                    levelColor="text-gray-600"
                    levelBgColor="bg-gray-50"
                  />
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {viewMode === 'test' && (
        <div className="space-y-2">
          {testAttachments.map(attachment => (
            <AttachmentItem
              key={attachment.id}
              attachment={attachment}
              levelColor="text-blue-600"
              levelBgColor="bg-blue-50"
            />
          ))}
        </div>
      )}

      {viewMode === 'all' && (testAttachments.length === 0 || orderAttachments.length === 0) && (
        <div className="space-y-2">
          {filteredAttachments.map(attachment => (
            <AttachmentItem
              key={attachment.id}
              attachment={attachment}
              levelColor={attachment.level === 'test' ? "text-blue-600" : "text-gray-600"}
              levelBgColor={attachment.level === 'test' ? "bg-blue-50" : "bg-gray-50"}
            />
          ))}
        </div>
      )}
    </div>
  );
};

/* =========================================
   Modern Result Verification Console
========================================= */

const ResultVerificationConsole: React.FC = () => {
  const { loading: permissionsLoading, hasAnyPermission, hasPermission } = usePermissions();
  // filters
  const [from, setFrom] = useState(fromYesterdayISO());
  const [to, setTo] = useState(todayISO());
	  const [q, setQ] = useState("");
	  const [stateFilter, setStateFilter] = useState<StateFilter>("all");
	  const [viewMode, setViewMode] = useState<ViewMode>("order");
	  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const [doctorFilter, setDoctorFilter] = useState("all");
  const [accountFilter, setAccountFilter] = useState("all");
  const [panelSortMode, setPanelSortMode] = useState<PanelSortMode>("sample_desc");

  // attachment view mode
  const [attachmentViewMode, setAttachmentViewMode] = useState<'test' | 'all'>('test');

  // data
  const [panels, setPanels] = useState<PanelRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // analytes cache by result_id
  const [rowsByResult, setRowsByResult] = useState<Record<string, Analyte[]>>({});
  const [calcDebugHints, setCalcDebugHints] = useState<CalcDebugHintsByResult>({});
  const [open, setOpen] = useState<Record<string, boolean>>({}); // result_id -> bool
  const [busy, setBusy] = useState<Record<string, boolean>>({});  // small per-row spinner
  const [remarksByResult, setRemarksByResult] = useState<Record<string, string>>({});
  const [remarkDirty, setRemarkDirty] = useState<Record<string, boolean>>({});
  const [remarkSaving, setRemarkSaving] = useState<Record<string, boolean>>({});
  const sectionEditorRefs = useRef<Record<string, SectionEditorRef | null>>({});

  // attachments cache by order_id
  const [attachmentsByOrder, setAttachmentsByOrder] = useState<Record<string, Attachment[]>>({});

  // bulk operations
  const [selectedPanels, setSelectedPanels] = useState<Set<string>>(new Set());
  const [bulkProcessing, setBulkProcessing] = useState(false);
  const [bulkApprovalProgress, setBulkApprovalProgress] = useState<BulkApprovalProgress | null>(null);

  // AI intelligence
  const aiIntelligence = useAIResultIntelligence();
  const [aiVerifierSummary, setAiVerifierSummary] = useState<Record<string, VerifierSummaryResponse>>({});
  const [aiClinicalSummary, setAiClinicalSummary] = useState<Record<string, ClinicalSummaryResponse>>({});
  const [showAiSummaryModal, setShowAiSummaryModal] = useState(false);
  const [aiSummaryTarget, setAiSummaryTarget] = useState<{ type: 'verifier' | 'clinical'; resultId?: string; orderId?: string } | null>(null);
  const [aiGeneratedInterpretations, setAiGeneratedInterpretations] = useState<Record<string, GeneratedInterpretation[]>>({});
  const [showDeltaCheckModal, setShowDeltaCheckModal] = useState(false);
  const [deltaCheckTargetResultId, setDeltaCheckTargetResultId] = useState<string | null>(null);
  // AI Delta Check results - quality control check comparing current vs historical values
  const [aiDeltaCheckResults, setAiDeltaCheckResults] = useState<Record<string, DeltaCheckResponse>>({});
  const [currentLabId, setCurrentLabId] = useState<string | null>(null);
  const currentVerifierIdRef = useRef<string | null | undefined>(undefined);
  const [trendData, setTrendData] = useState<Record<string, TrendData[]>>({});
  const [showTrendModal, setShowTrendModal] = useState(false);
  const [selectedAnalyteTrend, setSelectedAnalyteTrend] = useState<{ parameter: string; patientId: string } | null>(null);
  const [loadingTrend, setLoadingTrend] = useState(false);

  // attachment selector
  const [showAttachmentSelector, setShowAttachmentSelector] = useState(false);
  const [selectedOrderForAttachments, setSelectedOrderForAttachments] = useState<string | null>(null);

  // Report extras (trends and clinical summary inclusion)
  const [includeTrendsInReport, setIncludeTrendsInReport] = useState<Record<string, boolean>>({});
  const [includeSummaryInReport, setIncludeSummaryInReport] = useState<Record<string, boolean>>({});
  const [savingReportExtras, setSavingReportExtras] = useState<Record<string, boolean>>({});

  /* ----------------- Load attachments ----------------- */
  const loadAttachments = async (orderId: string) => {
    if (attachmentsByOrder[orderId]) return; // Already loaded

    try {
      const { data, error } = await supabase
        .from('attachments')
        .select(`
          id,
          file_url,
          file_type,
          original_filename,
          created_at,
          order_test_id
        `)
        .eq('order_id', orderId)
        .order('created_at', { ascending: false });

      if (error) throw error;

      const attachments: Attachment[] = (data || []).map(att => ({
        id: att.id,
        file_url: att.file_url,
        file_type: att.file_type,
        original_filename: att.original_filename,
        created_at: att.created_at,
        level: att.order_test_id ? 'test' : 'order'
      }));

      setAttachmentsByOrder(prev => ({ ...prev, [orderId]: attachments }));
    } catch (error) {
      console.error('Error loading attachments:', error);
    }
  };

  // Load current lab ID on mount
  useEffect(() => {
    const loadLabId = async () => {
      const labId = await database.getCurrentUserLabId();
      setCurrentLabId(labId);
    };
    loadLabId();
  }, []);

  const canVerifyWorkbench = hasAnyPermission(['results.verify', 'results.verify_radiology', 'results.verify_section_only']);
  const canUnapproveResults = hasPermission('results.unapprove');
  const canVerifyRow = useCallback((row: PanelRow) => {
    if (row.is_section_only) {
      return hasPermission(getSectionVerificationPermissionForDepartment(row.department));
    }

    return hasPermission(getVerificationPermissionForDepartment(row.department));
  }, [hasPermission]);

  const canEditSectionsForRow = useCallback((row: PanelRow) => (
    hasPermission(getSectionEditPermissionForDepartment(row.department, 'doctor'))
  ), [hasPermission]);

  /* ----------------- Load panels with lab filter ----------------- */
  const loadPanels = async (silent = false) => {
    if (!silent) setLoading(true);
    setErr(null);

    // Get current lab ID for filtering
    const labId = currentLabId || await database.getCurrentUserLabId();
    if (!labId) {
      setErr("No lab context found. Please log in again.");
      setPanels([]);
      if (!silent) setLoading(false);
      return;
    }

    // ✅ Apply location filtering for access control
    const { shouldFilter, locationIds } = await database.shouldFilterByLocation();

    try {
      const data = await fetchPanelStatusRows(labId, from, to, shouldFilter, locationIds);
      const basePanels = (data || []) as PanelRow[];
      const needsStatusFallback = basePanels.some((row) => !Object.prototype.hasOwnProperty.call(row, "result_verification_status"));
      const resultIds = Array.from(new Set(basePanels
          .filter((row) =>
            row.has_result === true ||
            (row.has_result === undefined && (
              (row.entered_analytes || 0) > 0 ||
              row.panel_ready ||
              !!row.is_section_only
            ))
          )
          .map((row) => row.result_id)
          .filter(Boolean)));
      const statusFallbackIds = needsStatusFallback ? resultIds : [];
      const patientIds = Array.from(new Set(basePanels.map((row) => row.patient_id).filter(Boolean)));
	      const orderIds = Array.from(new Set(basePanels.map((row) => row.order_id).filter(Boolean)));

	      const [resultRows, patientRows, orderRows] = await Promise.all([
	        fetchRowsByIds("results", "id, verification_status, notes", resultIds),
	        fetchRowsByIds("patients", "id, age, gender", patientIds),
	        fetchRowsByIds("orders", "id, sample_id, order_number, doctor, account_id, priority, accounts(name)", orderIds),
	      ]);

	      const resultMap = new Map(resultRows.map((row: any) => [row.id, row]));
	      const patientMap = new Map(patientRows.map((patient: any) => [patient.id, patient]));
	      const orderMap = new Map(orderRows.map((order: any) => {
        const accountInfo = Array.isArray(order.accounts) ? order.accounts[0] : order.accounts;
        return [order.id, {
          sample_id: order.sample_id || null,
          order_number: order.order_number ?? null,
          doctor: order.doctor || null,
          account_id: order.account_id || null,
          account_name: accountInfo?.name || null,
          priority: order.priority || "Normal",
        }];
      }));
      const hydratedPanels = basePanels.map((row) => {
        const patient = patientMap.get(row.patient_id) as any;
        const order = orderMap.get(row.order_id) as Partial<PanelRow> | undefined;
        const result = resultMap.get(row.result_id) as any;
        return {
          ...row,
	          ...(order || {}),
          result_verification_status: row.result_verification_status ?? (statusFallbackIds.includes(row.result_id) ? result?.verification_status ?? null : null),
          notes: result?.notes ?? row.notes ?? null,
          patient_age: row.patient_age ?? patient?.age ?? null,
		          patient_gender: row.patient_gender ?? patient?.gender ?? null,
	        };
	      });
      setPanels(hydratedPanels);
      setRemarksByResult((current) => {
        const next = { ...current };
        for (const panel of hydratedPanels) {
          if (!remarkDirty[panel.result_id]) {
            next[panel.result_id] = panel.notes || "";
          }
        }
        return next;
      });
    } catch (error: any) {
      setErr(error?.message || "Failed to load verification panels");
      setPanels([]);
    }
    if (!silent) setLoading(false);
  };

  useEffect(() => {
    if (currentLabId) {
      loadPanels();
    }
  }, [from, to, currentLabId]);

  /* ----------------- Filter panels ----------------- */
	  const filteredPanels = useMemo(() => {
    const k = q.trim().toLowerCase();
    const normalizedSearchId = normalizeIdForSearch(k);

	    // Prefer the view's real-result marker. Older databases do not expose it,
	    // so fall back to the previous entered-analyte/section-only behavior.
	    let list = (panels || []).filter((r) =>
	      r.has_result === true ||
	      (r.has_result === undefined && (
	        (r?.entered_analytes || 0) > 0 ||
	        !!r.is_section_only
	      ))
	    );

    if (k) {
      list = list.filter(
        (r) =>
	          (r.patient_name || "").toLowerCase().includes(k) ||
	          (r.test_group_name || "").toLowerCase().includes(k) ||
          (r.sample_id || "").toLowerCase().includes(k) ||
	          (r.order_id || "").toLowerCase().includes(k) ||
	          normalizeIdForSearch(r.order_id || "").includes(normalizedSearchId)
	      );
	    }

    if (doctorFilter !== "all") {
      list = list.filter((r) => (r.doctor || "").toLowerCase().includes(doctorFilter.toLowerCase()));
    }

    if (accountFilter !== "all") {
      list = list.filter((r) => (r.account_name || "").toLowerCase().includes(accountFilter.toLowerCase()));
    }

    if (stateFilter === "ready") {
      list = list.filter((r) =>
        r.is_section_only ? r.result_verification_status === "verified" : r.panel_ready
      );
    } else if (stateFilter === "pending") {
      list = list.filter((r) =>
        r.is_section_only
          ? r.result_verification_status !== "verified"
          : (!r.panel_ready && (r.approved_analytes || 0) === 0)
      );
    } else if (stateFilter === "partial") {
      list = list.filter(
        (r) =>
          !r.is_section_only &&
          !r.panel_ready &&
          r.approved_analytes > 0 &&
          r.approved_analytes < r.expected_analytes
      );
    }

    list = [...list].sort((a, b) => {
      if (panelSortMode === "patient_az") return (a.patient_name || "").localeCompare(b.patient_name || "");
      if (panelSortMode === "date_desc") {
        const dateDiff = new Date(b.order_date).getTime() - new Date(a.order_date).getTime();
        if (dateDiff !== 0) return dateDiff;
      }

      const nA = getDailySeq(a);
      const nB = getDailySeq(b);
      if (nA !== nB) return panelSortMode === "sample_asc" ? nA - nB : nB - nA;
      return new Date(b.order_date).getTime() - new Date(a.order_date).getTime();
    });

		    return list;
		  }, [panels, q, stateFilter, doctorFilter, accountFilter, panelSortMode]);

  const doctorOptions = useMemo(() => (
    Array.from(new Set((panels || []).map(row => row.doctor).filter(Boolean) as string[])).sort()
  ), [panels]);

  const accountOptions = useMemo(() => (
    Array.from(new Set((panels || []).map(row => row.account_name).filter(Boolean) as string[])).sort()
  ), [panels]);

	  const allFilteredPanelsSelected = useMemo(
	    () => filteredPanels.length > 0 && filteredPanels.every((panel) => selectedPanels.has(panel.result_id)),
	    [filteredPanels, selectedPanels]
	  );

	  /* ----------------- Load analytes for panel ----------------- */
  const ensureAnalytesLoaded = async (result_id: string): Promise<Analyte[]> => {
    if (rowsByResult[result_id]) return rowsByResult[result_id];

    const { data, error } = await supabase
      .from("result_values")
      .select(
        [
          "id",
          "result_id",
          "analyte_id",
          "lab_analyte_id",
          "parameter",
          "value",
          "unit",
          "reference_range",
          "flag",
          "verify_status",
          "verify_note",
          "verified_by",
          "verified_at",
          "is_auto_calculated",
          "calculation_inputs",
	          "calculated_at",
	          "is_hidden_from_report",
	          "hidden_reason",
        ].join(",")
      )
      .eq("result_id", result_id)
      .order("parameter", { ascending: true });

    if (!error && data) {
      const testGroupId = panels.find((panel) => panel.result_id === result_id)?.test_group_id;
      const analytes = await loadOrderedAnalyteRows(
        supabase,
        testGroupId,
        data as unknown as Analyte[]
      );
      setRowsByResult((s) => ({ ...s, [result_id]: analytes }));
      return analytes;
    } else {
      // Fallback if verify_* columns do not exist
      if (String(error.message || "").includes("column") && String(error.message).includes("verify_status")) {
        const { data: data2, error: e2 } = await supabase
          .from("result_values")
          .select("id,result_id,analyte_id,lab_analyte_id,parameter,value,unit,reference_range,flag,is_auto_calculated,calculation_inputs,calculated_at")
          .eq("result_id", result_id)
          .order("parameter", { ascending: true });

        if (!e2) {
          const mapped = (data2 || []).map((r: any) => ({
            id: r.id,
            result_id: r.result_id,
            analyte_id: r.analyte_id,
            lab_analyte_id: r.lab_analyte_id || null,
            parameter: r.parameter,
            value: r.value,
            unit: r.unit,
            reference_range: r.reference_range,
            flag: r.flag,
            verify_status: "pending",
            verify_note: null,
            verified_by: null,
            verified_at: null,
            is_auto_calculated: r.is_auto_calculated,
            calculation_inputs: r.calculation_inputs,
	            calculated_at: r.calculated_at,
	            is_hidden_from_report: false,
	            hidden_reason: null,
	          })) as Analyte[];
          const testGroupId = panels.find((panel) => panel.result_id === result_id)?.test_group_id;
          const ordered = await loadOrderedAnalyteRows(supabase, testGroupId, mapped);
          setRowsByResult((s) => ({ ...s, [result_id]: ordered }));
          return ordered;
        }
      }
    }

    console.warn("[ResultVerification] No analytes loaded for result", { result_id, error });
    return [];
  };

  /* ----------------- Load trend data for analyte ----------------- */
  const loadTrendData = async (patientId: string, parameter: string) => {
    const cacheKey = `${patientId}-${parameter}`;
    if (trendData[cacheKey]) {
      setSelectedAnalyteTrend({ parameter, patientId });
      setShowTrendModal(true);
      return;
    }

    setLoadingTrend(true);
    try {
      const { data, error } = await supabase
        .from('v_report_template_context')
        .select('order_date, analytes')
        .eq('patient_id', patientId)
        .order('order_date', { ascending: false })
        .limit(10);

      if (error) throw error;

      // Extract relevant analyte data from jsonb array
      const extractedTrend = data?.flatMap((row: any) => {
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
      }) || [];

      setTrendData((prev) => ({ ...prev, [cacheKey]: extractedTrend as TrendData[] }));
      setSelectedAnalyteTrend({ parameter, patientId });
      setShowTrendModal(true);
    } catch (error) {
      console.error('Error loading trend data:', error);
      alert('Failed to load trend data');
    } finally {
      setLoadingTrend(false);
    }
  };

  const toggleOpen = async (row: PanelRow) => {
    const k = row.result_id;
    const savedScroll = window.scrollY;
    setOpen((s) => ({ ...s, [k]: !s[k] }));
    requestAnimationFrame(() => window.scrollTo({ top: savedScroll, behavior: 'instant' as ScrollBehavior }));
    if (!rowsByResult[k]) await ensureAnalytesLoaded(k);
    if (!attachmentsByOrder[row.order_id]) await loadAttachments(row.order_id);
  };

  /* ----------------- Selection handlers ----------------- */
  const togglePanelSelection = (resultId: string) => {
    setBulkApprovalProgress(null);
    setSelectedPanels(prev => {
      const newSet = new Set(prev);
      if (newSet.has(resultId)) {
        newSet.delete(resultId);
      } else {
        newSet.add(resultId);
      }
      return newSet;
    });
  };

  const selectAllPanels = () => {
    setBulkApprovalProgress(null);
    setSelectedPanels(new Set(filteredPanels.map(p => p.result_id)));
  };

  const clearSelection = () => {
    setBulkApprovalProgress(null);
    setSelectedPanels(new Set());
  };

  /* ----------------- Mutations ----------------- */
  const setBusyFor = (key: string, v: boolean) => setBusy((s) => ({ ...s, [key]: v }));
  const getCurrentVerifierId = async () => {
    if (currentVerifierIdRef.current !== undefined) return currentVerifierIdRef.current;
    const { data: { user } } = await supabase.auth.getUser();
    currentVerifierIdRef.current = user?.id || null;
    return currentVerifierIdRef.current;
  };

  const saveGroupRemark = async (row: PanelRow, silent = false): Promise<boolean> => {
    const notes = remarksByResult[row.result_id]?.trim() || null;
    setRemarkSaving((current) => ({ ...current, [row.result_id]: true }));
    const { error } = await supabase
      .from("results")
      .update({ notes })
      .eq("id", row.result_id);
    setRemarkSaving((current) => ({ ...current, [row.result_id]: false }));

    if (error) {
      console.error("Failed to save report remark:", error);
      if (!silent) alert("Failed to save report remark");
      return false;
    }

    setRemarkDirty((current) => ({ ...current, [row.result_id]: false }));
    setPanels((current) => current.map((panel) =>
      panel.result_id === row.result_id ? { ...panel, notes } : panel
    ));
    return true;
  };

  const approveAnalyte = async (rv_id: string) => {
    setBusyFor(rv_id, true);
    const verifiedBy = await getCurrentVerifierId();
    const { error } = await supabase
      .from("result_values")
      .update({ verify_status: "approved", verified_at: new Date().toISOString(), verified_by: verifiedBy })
      .eq("id", rv_id);
    setBusyFor(rv_id, false);

    if (!error) {
      // update client cache
      setRowsByResult((s) => {
        const next = { ...s };
        for (const rid in next) {
          next[rid] = next[rid].map((a) => (a.id === rv_id ? { ...a, verify_status: "approved" } : a));
        }
        return next;
      });
      await loadPanels(true);
    }
  };

  const unapproveAnalyte = async (rv_id: string, result_id: string) => {
    if (!window.confirm("Revert this analyte back to pending? This will allow re-verification and re-entry of results.")) return;
    setBusyFor(rv_id, true);
    const { error } = await supabase
      .from("result_values")
      .update({
        verify_status: "pending",
        verify_note: "Unapproved – sent back for re-verification",
        verified_at: null,
        verified_by: null,
      })
      .eq("id", rv_id);

    if (!error) {
      // Unlock the result so new values can be entered
      await supabase
        .from("results")
        .update({ is_locked: false, locked_reason: null, locked_at: null, locked_by: null })
        .eq("id", result_id);

      setRowsByResult((s) => {
        const next = { ...s };
        for (const rid in next) {
          next[rid] = next[rid].map((a) =>
            a.id === rv_id
              ? { ...a, verify_status: "pending", verify_note: "Unapproved – sent back for re-verification", verified_at: null, verified_by: null }
              : a
          );
        }
        return next;
      });
      await loadPanels(true);
    }
    setBusyFor(rv_id, false);
  };

  const rejectAnalyte = async (rv_id: string) => {
    const note = prompt("Add a note (optional)", "") ?? null;
    setBusyFor(rv_id, true);
    const { error } = await supabase
      .from("result_values")
      .update({
        verify_status: "rejected",
        verify_note: note && note.length ? note : null,
        verified_at: new Date().toISOString(),
      })
      .eq("id", rv_id);
    setBusyFor(rv_id, false);

    if (!error) {
      setRowsByResult((s) => {
        const next = { ...s };
        for (const rid in next) {
          next[rid] = next[rid].map((a) => (a.id === rv_id ? { ...a, verify_status: "rejected", verify_note: note } : a));
        }
        return next;
      });
      await loadPanels(true);
    }
  };

  // Send rejected analyte back to result entry as pending (for re-run)
  const sendForRerun = async (rv_id: string) => {
    const note = prompt("Add a note for re-run request:", "Please re-run this test") ?? null;
    if (!note?.trim()) {
      alert("Note is required to send for re-run");
      return;
    }

    setBusyFor(rv_id, true);
    const { error } = await supabase
      .from("result_values")
      .update({
        verify_status: "pending",
        verify_note: `RE-RUN REQUESTED: ${note}`,
        verified_at: null,
        verified_by: null,
      })
      .eq("id", rv_id);
    setBusyFor(rv_id, false);

    if (!error) {
      setRowsByResult((s) => {
        const next = { ...s };
        for (const rid in next) {
          next[rid] = next[rid].map((a) =>
            a.id === rv_id
              ? { ...a, verify_status: "pending", verify_note: `RE-RUN REQUESTED: ${note}`, verified_at: null, verified_by: null }
              : a
          );
        }
        return next;
      });
      await loadPanels(true);
      alert("Analyte sent back for re-run");
    }
  };

  // Edit analyte value inline — works for all statuses (pending / approved / rejected)
  const [showAISuggestionMap, setShowAISuggestionMap] = useState<Record<string, boolean>>({});
  const [recalculating, setRecalculating] = useState<Record<string, boolean>>({});
  const [editingAnalyteId, setEditingAnalyteId] = useState<string | null>(null);
  const [editValues, setEditValues] = useState<{
    value: string;
    unit: string;
    reference_range: string;
    flag: string | null;
  }>({ value: "", unit: "", reference_range: "", flag: null });

  const startEditAnalyte = (analyte: Analyte) => {
    setEditingAnalyteId(analyte.id);
    setEditValues({
      value: analyte.value || "",
      unit: analyte.unit,
      reference_range: analyte.reference_range,
      flag: toSelectFlagValue(analyte.flag),
    });
  };

  const cancelEditAnalyte = () => {
    setEditingAnalyteId(null);
    setEditValues({ value: "", unit: "", reference_range: "", flag: null });
  };

  const saveEditedAnalyte = async (rv_id: string) => {
    if (!editValues.value.trim()) {
      alert("Value is required");
      return;
    }

    const updatedFlag = toStoredFlagValue(editValues.flag);

    setBusyFor(rv_id, true);
    const { error } = await supabase
      .from("result_values")
      .update({
        value: editValues.value,
        unit: editValues.unit,
        reference_range: editValues.reference_range,
        flag: updatedFlag,
        verify_status: "pending", // Reset to pending after edit
        verify_note: "Value edited by verifier",
        verified_at: null,
        verified_by: null,
      })
      .eq("id", rv_id);
    setBusyFor(rv_id, false);

    if (!error) {
      setRowsByResult((s) => {
        const next = { ...s };
        for (const rid in next) {
          next[rid] = next[rid].map((a) =>
            a.id === rv_id
              ? {
                ...a,
                value: editValues.value,
                unit: editValues.unit,
                reference_range: editValues.reference_range,
                flag: updatedFlag,
                verify_status: "pending",
                verify_note: "Value edited by verifier",
                verified_at: null,
                verified_by: null
              }
              : a
          );
        }
        return next;
      });
      setEditingAnalyteId(null);
    }
  };

  const approveAllInPanel = async (row: PanelRow) => {
    if (!canVerifyRow(row)) {
      alert("You do not have permission to verify this report.");
      return;
    }

    if (remarkDirty[row.result_id]) {
      const remarkSaved = await saveGroupRemark(row, true);
      if (!remarkSaved) {
        alert("Approval stopped because the report remark could not be saved.");
        return;
      }
    }

    if (row.is_section_only) {
      setBusyFor(row.result_id, true);
      try {
        const verifiedBy = await getCurrentVerifierId();
        const sectionEditor = sectionEditorRefs.current[row.result_id];
        if (sectionEditor) {
          await sectionEditor.save();
        }

        const { error } = await supabase
          .from("results")
          .update({
            verification_status: "verified",
            verified_at: new Date().toISOString(),
            verified_by: verifiedBy,
            manually_verified: true,
          })
          .eq("id", row.result_id);

        if (error) {
          throw error;
        }

        await loadPanels(true);
      } catch (error) {
        console.error("Failed to approve section-only panel:", error);
        alert("Failed to approve section-only report");
      } finally {
        setBusyFor(row.result_id, false);
      }
      return;
    }

    const list = rowsByResult[row.result_id] || await ensureAnalytesLoaded(row.result_id);
    if (!list.length) {
      console.warn("[ResultVerification] Approval skipped because no analytes were found", {
        result_id: row.result_id,
        order_id: row.order_id,
        test_group_name: row.test_group_name,
      });
      return;
    }
    const ids = list.map((a) => a.id);
    setBusyFor(row.result_id, true);
    setSavingReportExtras(prev => ({ ...prev, [row.order_id]: true }));

    try {
      const verifiedBy = await getCurrentVerifierId();
      console.info("[ResultVerification] Approving panel analytes", {
        result_id: row.result_id,
        order_id: row.order_id,
        test_group_name: row.test_group_name,
        analyte_count: ids.length,
      });

      const { error } = await supabase
        .from("result_values")
        .update({ verify_status: "approved", verified_at: new Date().toISOString(), verified_by: verifiedBy })
        .in("id", ids);

      if (error) {
        console.error("[ResultVerification] Failed to approve panel analytes", {
          result_id: row.result_id,
          order_id: row.order_id,
          error: describeSupabaseError(error),
          raw_error: error,
        });
        throw error;
      }

      if (!error) {
        setRowsByResult((s) => ({
          ...s,
          [row.result_id]: (s[row.result_id] || []).map((a) => ({ ...a, verify_status: "approved" })),
        }));

        // Generate and save report extras (trends and clinical summary) if enabled
        try {
	          // Save clinical summary if enabled and exists
          if (includeSummaryInReport[row.order_id] && aiClinicalSummary[row.order_id]) {
            console.log('Saving clinical summary to report extras...');
            const summaryResponse = aiClinicalSummary[row.order_id];
            await saveClinicalSummary(row.result_id, {
              text: summaryResponse.clinical_interpretation || summaryResponse.executive_summary || '',
              recommendation: summaryResponse.suggested_followup?.join('\n'),
              generated_at: new Date().toISOString(),
              generated_by: 'ai',
            });
          }
        } catch (extrasError) {
          console.error('Failed to save report extras:', extrasError);
          // Don't block the approval - extras are optional
        }

        await loadPanels(true);
      }
    } finally {
      setBusyFor(row.result_id, false);
      setSavingReportExtras(prev => ({ ...prev, [row.order_id]: false }));
    }
  };

  const unapproveAllInPanel = async (row: PanelRow) => {
    if (!canUnapproveResults) {
      alert("You do not have permission to unapprove reports.");
      return;
    }

    if (row.is_section_only) {
      if (!window.confirm("Revert this section-only report back to pending verification?")) return;

      setBusyFor(row.result_id, true);
      const { error } = await supabase
        .from("results")
        .update({
          verification_status: "pending_verification",
          verified_at: null,
          is_locked: false,
          locked_reason: null,
          locked_at: null,
          locked_by: null,
        })
        .eq("id", row.result_id);

      if (!error) {
        await loadPanels(true);
      }
      setBusyFor(row.result_id, false);
      return;
    }

    const list = rowsByResult[row.result_id] || [];
    const approvedIds = list.filter((a) => a.verify_status === "approved").map((a) => a.id);
    if (!approvedIds.length) return;
    if (!window.confirm(`Revert ${approvedIds.length} approved analyte(s) back to pending?`)) return;

    setBusyFor(row.result_id, true);
    const { error } = await supabase
      .from("result_values")
      .update({
        verify_status: "pending",
        verify_note: "Unapproved – sent back for re-verification",
        verified_at: null,
        verified_by: null,
      })
      .in("id", approvedIds);

    if (!error) {
      // Unlock the result so new values can be entered
      await supabase
        .from("results")
        .update({ is_locked: false, locked_reason: null, locked_at: null, locked_by: null })
        .eq("id", row.result_id);

      setRowsByResult((s) => ({
        ...s,
        [row.result_id]: (s[row.result_id] || []).map((a) =>
          a.verify_status === "approved"
            ? { ...a, verify_status: "pending", verify_note: "Unapproved – sent back for re-verification", verified_at: null, verified_by: null }
            : a
        ),
      }));
      await loadPanels(true);
    }
    setBusyFor(row.result_id, false);
  };

  /* Recalculate all auto-calculated analytes in a panel from saved source values */
  const recalculatePanel = async (row: PanelRow) => {
    const allRows = rowsByResult[row.result_id] || [];
    const calcRows = allRows.filter(a => a.is_auto_calculated && a.analyte_id);
    const srcRows  = allRows.filter(a => !a.is_auto_calculated && a.value !== null && a.value !== '');
    if (calcRows.length === 0) {
      alert('No calculated parameters found in this panel.');
      return;
    }

    setRecalculating(prev => ({ ...prev, [row.result_id]: true }));
    setCalcDebugHints(prev => ({ ...prev, [row.result_id]: {} }));
    try {
      const calcIds = calcRows.map(a => a.analyte_id);
      const srcIds  = srcRows.map(a => a.analyte_id).filter(Boolean) as string[];

      const labId = currentLabId || await database.getCurrentUserLabId();
      const [{ data: labFormulas }, { data: rawDeps }, { data: srcAnalytesData }, { data: srcLabAnalytesData }] = await Promise.all([
        // Prefer lab_analytes formula over global analytes formula
        supabase.from('lab_analytes')
          .select('analyte_id, is_calculated, formula, formula_variables, calculation_result_type, decimal_places')
          .eq('lab_id', labId!)
          .in('analyte_id', calcIds),
        supabase.from('analyte_dependencies')
          .select('calculated_analyte_id, calculated_lab_analyte_id, source_analyte_id, source_lab_analyte_id, variable_name, lab_id')
          .in('calculated_analyte_id', calcIds)
          .or(`lab_id.eq.${labId},lab_id.is.null`),
        srcIds.length > 0
          ? supabase.from('analytes').select('id, name, code').in('id', srcIds)
          : Promise.resolve({ data: [] as any[] }),
        supabase.from('lab_analytes')
          .select('id, analyte_id, name')
          .eq('lab_id', labId!)
          .in('id', srcRows.map(a => a.lab_analyte_id).filter(Boolean) as string[]),
      ]);
      const depSourceIds = Array.from(new Set((rawDeps || []).map((d: any) => d.source_analyte_id).filter(Boolean)));
      const depSourceLabIds = Array.from(new Set((rawDeps || []).map((d: any) => d.source_lab_analyte_id).filter(Boolean)));
      const [{ data: depSourceAnalytesData }, { data: depSourceLabAnalytesData }] = await Promise.all([
        depSourceIds.length > 0
          ? supabase.from('analytes').select('id, name, code').in('id', depSourceIds)
          : Promise.resolve({ data: [] as any[] }),
        depSourceLabIds.length > 0
          ? supabase.from('lab_analytes').select('id, analyte_id, name').eq('lab_id', labId!).in('id', depSourceLabIds)
          : Promise.resolve({ data: [] as any[] }),
      ]);
      // Fall back to global analytes formula for any analyte not in lab_analytes
      const labFormulaMap = new Map((labFormulas || []).map((r: any) => [r.analyte_id, r]));
      const globalFormulasNeeded = calcIds.filter(id => !labFormulaMap.has(id));
      if (globalFormulasNeeded.length > 0) {
        const { data: globalFormulas } = await supabase.from('analytes').select('id, formula, formula_variables, calculation_result_type, decimal_places').in('id', globalFormulasNeeded);
        (globalFormulas || []).forEach((r: any) => labFormulaMap.set(r.id, { analyte_id: r.id, ...r }));
      }
      // Remap to match shape expected downstream ({ id, formula, formula_variables })
      const formulas = Array.from(labFormulaMap.values()).map((r: any) => ({
        id: r.analyte_id ?? r.id,
        formula: r.formula,
        formula_variables: r.formula_variables,
        calculation_result_type: r.calculation_result_type ?? 'numeric',
        decimal_places: r.decimal_places ?? null,
      }));
      // Deduplicate deps: prefer lab-specific over global
      const depSeen = new Set<string>();
      const deps: { calculated_analyte_id: string; calculated_lab_analyte_id?: string | null; source_analyte_id: string; source_lab_analyte_id?: string | null; variable_name: string }[] = [];
      const depsSorted = [...(rawDeps || [])].sort((a: any, b: any) => (a.lab_id ? -1 : 1) - (b.lab_id ? -1 : 1));
      for (const row of depsSorted as any[]) {
        const key = `${row.calculated_lab_analyte_id || row.calculated_analyte_id}:${row.variable_name}`;
        if (!depSeen.has(key)) { depSeen.add(key); deps.push(row); }
      }

      // Build lookup: analyte_id / param name / code → numeric value
      const valueLookup = new Map<string, number>();
      const sourceNameByAnalyteId = new Map<string, string>();
      const sourceCodeByAnalyteId = new Map<string, string>();
      const sourceNameByLabAnalyteId = new Map<string, string>();
      for (const item of [...(srcAnalytesData || []), ...(depSourceAnalytesData || [])]) {
        if (item?.id && item?.name) sourceNameByAnalyteId.set(item.id, item.name);
        if (item?.id && item?.code) sourceCodeByAnalyteId.set(item.id, String(item.code));
      }
      for (const item of [...(srcLabAnalytesData || []), ...(depSourceLabAnalytesData || [])]) {
        if (item?.id && item?.name) sourceNameByLabAnalyteId.set(item.id, item.name);
      }
      for (const r of srcRows) {
        const num = toNumber(r.value);
        if (num === null) continue;
        if (r.analyte_id) valueLookup.set(r.analyte_id, num);
        if (r.lab_analyte_id) valueLookup.set(r.lab_analyte_id, num);
        valueLookup.set(r.parameter.toLowerCase(), num);
        const rowSlug = toVariableSlug(r.parameter);
        if (rowSlug) valueLookup.set(rowSlug, num);
        const sa = (srcAnalytesData || []).find((s: any) => s.id === r.analyte_id);
        if (sa?.code) valueLookup.set((sa.code as string).toLowerCase(), num);
        if (sa?.name) {
          valueLookup.set((sa.name as string).toLowerCase(), num);
          const analyteSlug = toVariableSlug(sa.name as string);
          if (analyteSlug) valueLookup.set(analyteSlug, num);
        }
      }
      const patientAge = toNumber(row.patient_age);
      if (patientAge !== null) {
        valueLookup.set('AGE', patientAge);
        valueLookup.set('age', patientAge);
      }
      const patientGender = String(row.patient_gender || '').trim().toLowerCase();
      const isMale = patientGender === 'male' || patientGender === 'm';
      const isFemale = patientGender === 'female' || patientGender === 'f';
      valueLookup.set('GENDER_MALE', isMale ? 1 : 0);
      valueLookup.set('gender_male', isMale ? 1 : 0);
      valueLookup.set('GENDER_FEMALE', isFemale ? 1 : 0);
      valueLookup.set('gender_female', isFemale ? 1 : 0);
      valueLookup.set('GENDER', isMale ? 1 : (isFemale ? 0 : 0.5));
      valueLookup.set('gender', isMale ? 1 : (isFemale ? 0 : 0.5));

      const parseVars = (raw: any): string[] => {
        if (!raw) return [];
        if (Array.isArray(raw)) return raw.filter(Boolean);
        try { const p = JSON.parse(raw); return Array.isArray(p) ? p.filter(Boolean) : []; }
        catch { return []; }
      };

      const updates: Array<{ id: string; value: string; inputs: Record<string, number>; flag: string | null; flagSource: string }> = [];
      const debugHintsForResult: Record<string, string[]> = {};
      const recalcLogPrefix = `[Panel Recalculate][${row.result_id}]`;

      console.groupCollapsed(`${recalcLogPrefix} ${row.test_group_name || 'Panel'}: ${calcRows.length} calculated analyte(s)`);
      console.info(`${recalcLogPrefix} Source values`, srcRows.map((r) => ({
        row_id: r.id,
        analyte_id: r.analyte_id,
        lab_analyte_id: r.lab_analyte_id,
        parameter: r.parameter,
        value: r.value,
      })));
      console.info(`${recalcLogPrefix} Formulas loaded`, formulas.map((f: any) => ({
        analyte_id: f.id,
        formula: f.formula,
        formula_variables: f.formula_variables,
        calculation_result_type: f.calculation_result_type,
      })));
      console.info(`${recalcLogPrefix} Dependencies loaded`, deps);

      try {
        for (const calcRow of calcRows) {
          const calcLogBase = {
            row_id: calcRow.id,
            analyte_id: calcRow.analyte_id,
            lab_analyte_id: calcRow.lab_analyte_id,
            parameter: calcRow.parameter,
          };
          const fi = (formulas || []).find((f: any) => f.id === calcRow.analyte_id);
          if (!fi?.formula) {
            debugHintsForResult[calcRow.id] = ["formula not configured"];
            console.warn(`${recalcLogPrefix} Skipped calculated analyte: no formula`, calcLogBase);
            continue;
          }

          const exactLabDeps = calcRow.lab_analyte_id
            ? (deps || []).filter((d: any) => d.calculated_lab_analyte_id === calcRow.lab_analyte_id)
            : [];
          const fallbackDeps = (deps || []).filter((d: any) =>
            !d.calculated_lab_analyte_id && d.calculated_analyte_id === calcRow.analyte_id
          );
          const rowDeps = exactLabDeps.length > 0 ? exactLabDeps : fallbackDeps;
          const scope: Record<string, number> = {};
          let allFound = true;
          const missingVariables: string[] = [];

          console.debug(`${recalcLogPrefix} Calculating`, {
            ...calcLogBase,
            formula: fi.formula,
            formula_variables: parseVars(fi.formula_variables),
            dependency_mode: exactLabDeps.length > 0 ? 'lab-specific' : (fallbackDeps.length > 0 ? 'fallback/global' : 'formula_variables'),
            dependencies: rowDeps,
          });

          if (rowDeps.length > 0) {
            for (const dep of rowDeps) {
              let val = valueLookup.get(dep.source_lab_analyte_id || '') ??
                        valueLookup.get(dep.source_analyte_id) ??
                        valueLookup.get((dep.variable_name as string).toLowerCase());
              if (val === undefined && dep.source_lab_analyte_id) {
                const sourceName = sourceNameByLabAnalyteId.get(dep.source_lab_analyte_id);
                if (sourceName) {
                  val = valueLookup.get(sourceName.toLowerCase());
                  if (val === undefined) {
                    const slug = toVariableSlug(sourceName);
                    if (slug) val = valueLookup.get(slug);
                  }
                }
              }
              if (val === undefined && dep.source_analyte_id) {
                const sourceName = sourceNameByAnalyteId.get(dep.source_analyte_id);
                const sourceCode = sourceCodeByAnalyteId.get(dep.source_analyte_id);
                if (sourceName) {
                  val = valueLookup.get(sourceName.toLowerCase());
                  if (val === undefined) {
                    const slug = toVariableSlug(sourceName);
                    if (slug) val = valueLookup.get(slug);
                  }
                }
                if (val === undefined && sourceCode) {
                  val = valueLookup.get(sourceCode.toLowerCase());
                }
              }
              if (val === undefined) {
                allFound = false;
                missingVariables.push(dep.variable_name);
                console.warn(`${recalcLogPrefix} Missing dependency value`, {
                  ...calcLogBase,
                  dependency: dep,
                  known_lookup_keys: Array.from(valueLookup.keys()),
                });
                break;
              }
              scope[dep.variable_name] = val;
              scope[String(dep.variable_name).toUpperCase()] = val;

              const aliasCandidates = [
                dep.source_lab_analyte_id ? sourceNameByLabAnalyteId.get(dep.source_lab_analyte_id) : null,
                dep.source_analyte_id ? sourceNameByAnalyteId.get(dep.source_analyte_id) : null,
                dep.source_analyte_id ? sourceCodeByAnalyteId.get(dep.source_analyte_id) : null,
              ].filter(Boolean) as string[];

              for (const alias of aliasCandidates) {
                scope[alias] = val;
                scope[alias.toUpperCase()] = val;
                scope[alias.toLowerCase()] = val;
                const slug = toVariableSlug(alias);
                if (slug) {
                  scope[slug] = val;
                  scope[slug.toUpperCase()] = val;
                }
              }
            }
	          } else {
	            // Fallback: use formula_variables
	            for (const v of parseVars(fi.formula_variables)) {
	              const val = valueLookup.get(v.toLowerCase()) ?? valueLookup.get(v) ?? valueLookup.get(toVariableSlug(v));
              if (val === undefined) {
                allFound = false;
                missingVariables.push(v);
                console.warn(`${recalcLogPrefix} Missing formula variable value`, {
                  ...calcLogBase,
                  variable: v,
                  known_lookup_keys: Array.from(valueLookup.keys()),
                });
                break;
              }
	              scope[v] = val;
	            }
	          }

	          // Patient context is not an analyte dependency, but formulas like eGFR
	          // commonly require AGE / GENDER_MALE alongside source analytes.
	          for (const contextKey of ['AGE', 'age', 'GENDER_MALE', 'gender_male', 'GENDER_FEMALE', 'gender_female', 'GENDER', 'gender']) {
	            const contextValue = valueLookup.get(contextKey);
	            if (contextValue !== undefined) {
	              scope[contextKey] = contextValue;
	            }
	          }

	          if (!allFound || Object.keys(scope).length === 0) {
            debugHintsForResult[calcRow.id] = missingVariables.length > 0 ? missingVariables : ["source values"];
            console.warn(`${recalcLogPrefix} Not calculated: missing source values`, {
              ...calcLogBase,
              missing: debugHintsForResult[calcRow.id],
              scope,
            });
            continue;
          }

          if (normalizeCalculationResultType((fi as any).calculation_result_type) === 'text') {
            const textResult = evaluateTextCalculation(fi.formula, scope);
            if (!textResult.success) {
              debugHintsForResult[calcRow.id] = [textResult.error || "text calculation"];
              console.warn(`${recalcLogPrefix} Not calculated: text rule evaluation failed`, {
                ...calcLogBase,
                formula: fi.formula,
                scope,
                error_message: textResult.error,
              });
              continue;
            }
            updates.push({ id: calcRow.id, value: textResult.value, inputs: { ...scope }, flag: null, flagSource: 'auto_text' });
            console.info(`${recalcLogPrefix} Text calculation matched`, {
              ...calcLogBase,
              value: textResult.value,
              formula: fi.formula,
              scope,
            });
            continue;
          }

          let resolved = (fi.formula as string).trim();
          for (const [k, v] of Object.entries(scope)) {
            const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            resolved = resolved.replace(new RegExp(`\\b${esc}\\b`, 'g'), String(v));
          }
          resolved = normalizeFormulaForPanelEvaluation(resolved);
          if (!/^[0-9+\-*/().\sA-Za-z,_?:<>=!]+$/.test(resolved)) {
            debugHintsForResult[calcRow.id] = ["formula syntax"];
            console.warn(`${recalcLogPrefix} Not calculated: formula syntax check failed`, {
              ...calcLogBase,
              formula: fi.formula,
              resolved,
              scope,
            });
            continue;
          }
          try {
            const computed = Function('"use strict"; return (' + resolved + ');')();
            if (!Number.isFinite(computed)) {
              debugHintsForResult[calcRow.id] = ["non-finite result"];
              console.warn(`${recalcLogPrefix} Not calculated: non-finite result`, {
                ...calcLogBase,
                formula: fi.formula,
                resolved,
                scope,
                computed,
              });
              continue;
            }
            // Honour the analyte's configured precision (0 = integer) so this
            // button cannot undo it. Unconfigured stays at 2 dp as before.
            const roundedValue = String(roundHalfUp(
              Number(computed),
              normalizeDecimalPlaces(fi.decimal_places) ?? FALLBACK_DECIMAL_PLACES,
            ));
            const recalculatedFlag = calculateFlag(roundedValue, calcRow.reference_range || '') || 'normal';
            updates.push({
              id: calcRow.id,
              value: roundedValue,
              inputs: { ...scope },
              flag: recalculatedFlag,
              flagSource: 'auto_numeric',
            });
            console.info(`${recalcLogPrefix} Calculated successfully`, {
              ...calcLogBase,
              value: roundedValue,
              formula: fi.formula,
              resolved,
              scope,
            });
          } catch (err) {
            debugHintsForResult[calcRow.id] = ["formula evaluation"];
	            console.warn(`${recalcLogPrefix} Not calculated: formula evaluation error`, {
	              ...calcLogBase,
	              formula: fi.formula,
	              resolved,
	              scope,
	              error_message: err instanceof Error ? err.message : String(err),
	              error: err,
	            });
            continue;
          }
        }
      } finally {
        console.groupEnd();
      }

      setCalcDebugHints(prev => ({ ...prev, [row.result_id]: debugHintsForResult }));

      if (updates.length === 0) {
        alert('Could not recalculate — make sure all source values (e.g. TG, TC, HDL, LDL) are saved first.');
        return;
      }

      const patchResults = await Promise.all(updates.map(upd =>
        supabase.from('result_values').update({
          value: upd.value,
          flag: upd.flag,
          flag_source: upd.flagSource,
          calculation_inputs: upd.inputs,
          calculated_at: new Date().toISOString(),
          is_auto_calculated: true,
          verify_status: 'pending',
          verify_note: 'Recalculated by verifier',
          verified_at: null,
          verified_by: null,
        }).eq('id', upd.id).select('id, value, flag')
      ));

      const firstError = patchResults.find(r => r.error);
      if (firstError?.error) {
        alert(`Recalculate failed: ${firstError.error.message}`);
        return;
      }

      // Only update rows that were confirmed saved by the DB response
      const savedIds = new Set(
        patchResults.flatMap(r => (r.data || []).map((d: any) => d.id as string))
      );

      if (savedIds.size === 0) {
        alert('Recalculate: no rows were updated — check permissions or verify the result is not locked/approved.');
        return;
      }

      setRowsByResult(s => ({
        ...s,
        [row.result_id]: (s[row.result_id] || []).map(a => {
          const upd = updates.find(u => u.id === a.id && savedIds.has(a.id));
          if (!upd) return a;
          return {
            ...a,
            value: upd.value,
            flag: upd.flag,
            calculation_inputs: upd.inputs,
            calculated_at: new Date().toISOString(),
            is_auto_calculated: true,
            verify_status: 'pending' as const,
            verify_note: 'Recalculated by verifier',
            verified_at: null,
            verified_by: null,
          };
        }),
      }));
      await loadPanels(true);
    } finally {
      setRecalculating(prev => ({ ...prev, [row.result_id]: false }));
    }
  };

  const bulkApproveSelected = async () => {
    const selectedResultIds = Array.from(selectedPanels);
    console.info("[ResultVerification] Bulk approve selected clicked", {
      selected_count: selectedResultIds.length,
      selected_result_ids: selectedResultIds,
    });

    if (selectedResultIds.length === 0) return;

    setBulkProcessing(true);
    try {
      const selectedRows = selectedResultIds
        .map(resultId => filteredPanels.find(p => p.result_id === resultId))
        .filter((row): row is PanelRow => !!row);

      const missingRows = selectedResultIds.length - selectedRows.length;
      if (missingRows > 0) {
        console.warn("[ResultVerification] Some selected panels were not found in the current filter", {
          missing_count: missingRows,
          selected_result_ids: selectedResultIds,
        });
      }

      const failedRows: Array<{ row: PanelRow; error: unknown }> = [];
      setBulkApprovalProgress({
        total: selectedResultIds.length,
        attempted: 0,
        approved: 0,
        failed: 0,
        skipped: missingRows,
        status: "running",
      });

      for (const row of selectedRows) {
        try {
          await approveAllInPanel(row);
          setBulkApprovalProgress(prev => prev ? ({
            ...prev,
            attempted: prev.attempted + 1,
            approved: prev.approved + 1,
          }) : prev);
        } catch (error) {
          failedRows.push({ row, error });
          setBulkApprovalProgress(prev => prev ? ({
            ...prev,
            attempted: prev.attempted + 1,
            failed: prev.failed + 1,
          }) : prev);
          console.error("[ResultVerification] Bulk approve panel failed", {
            result_id: row.result_id,
            order_id: row.order_id,
            test_group_name: row.test_group_name,
            error: describeSupabaseError(error),
            raw_error: error,
          });
        }
      }

      if (failedRows.length === 0) {
        setSelectedPanels(new Set());
      } else {
        setSelectedPanels(new Set(failedRows.map(({ row }) => row.result_id)));
        alert(`${failedRows.length} of ${selectedRows.length} selected panels failed approval. The failed panels are still selected. Check the console for the database error message.`);
      }
      setBulkApprovalProgress(prev => prev ? ({
        ...prev,
        status: failedRows.length > 0 ? "failed" : "completed",
      }) : prev);

      console.info("[ResultVerification] Bulk approve selected completed", {
        attempted_count: selectedRows.length,
        failed_count: failedRows.length,
      });
    } catch (error) {
      console.error("[ResultVerification] Bulk approve selected failed", {
        error: describeSupabaseError(error),
        raw_error: error,
      });
      setBulkApprovalProgress(prev => prev ? ({ ...prev, status: "failed" }) : prev);
      alert("Bulk approval failed. Please check the console for details.");
    } finally {
      setBulkProcessing(false);
    }
  };

  const handleEmailReport = async (row: PanelRow) => {
    if (!currentLabId) {
      alert("Lab ID not found");
      return;
    }

    const confirmSend = window.confirm(`Send report email to ${row.patient_name}?`);
    if (!confirmSend) return;

    setBusyFor(row.result_id, true);
    try {
      const response = await fetch('/.netlify/functions/send-email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + (await supabase.auth.getSession()).data.session?.access_token,
        },
        body: JSON.stringify({
          to: 'patient@example.com', // TODO: Get actual patient email
          subject: `Test Report: ${row.test_group_name} - ${row.patient_name}`,
          templateId: 'patient_report',
          labId: currentLabId,
          data: {
            patientName: row.patient_name,
            reportDate: fmtDate(row.order_date),
            labName: 'Your Lab Name', // TODO: Get from lab settings
            downloadUrl: `${window.location.origin}/reports/${row.order_id}`, // Placeholder
          }
        }),
      });

      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Failed to send email');

      alert('Email sent successfully!');
    } catch (error) {
      console.error('Error sending email:', error);
      alert('Failed to send email: ' + (error instanceof Error ? error.message : 'Unknown error'));
    } finally {
      setBusyFor(row.result_id, false);
    }
  };

  /* ----------------- Stats ----------------- */
  const stats = useMemo(() => {
    const total = panels.length;
    const ready = panels.filter((p) => p.is_section_only ? p.result_verification_status === "verified" : p.panel_ready).length;
    const pending = panels.filter(
      (p) => p.is_section_only ? p.result_verification_status !== "verified" : (!p.panel_ready && p.approved_analytes === 0)
    ).length;
    const partial = total - ready - pending;
    const critical = panels.filter(p =>
      rowsByResult[p.result_id]?.some(a => isCriticalFlag(a.flag))
    ).length;

    return { total, ready, partial, pending, critical };
  }, [panels, rowsByResult]);

  if (permissionsLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <Loader2 className="h-8 w-8 animate-spin text-blue-600 mx-auto mb-4" />
          <p className="text-gray-600">Checking permissions...</p>
        </div>
      </div>
    );
  }

  if (!canVerifyWorkbench) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center max-w-md">
          <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <Lock className="h-8 w-8 text-red-600" />
          </div>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">Access Denied</h2>
          <p className="text-gray-600">
            You don't have permission to verify results.
          </p>
        </div>
      </div>
    );
  }

  /* ----------------- UI Components ----------------- */
  const StatsBadge: React.FC<{
    icon: React.FC<any>,
    label: string,
    value: number,
    color: string,
    bgColor: string,
    onClick?: () => void
  }> = ({ icon: Icon, label, value, color, bgColor, onClick }) => (
    <div
      className={`${bgColor} rounded-xl p-6 cursor-pointer hover:shadow-md transition-all duration-200 border-2 border-transparent hover:border-${color.split('-')[0]}-200`}
      onClick={onClick}
    >
      <div className="flex items-center justify-between">
        <div>
          <div className={`text-3xl font-bold ${color}`}>{value}</div>
          <div className={`text-sm font-medium ${color.replace('600', '700')}`}>{label}</div>
        </div>
        <div className={`${color.replace('600', '100')} p-3 rounded-full`}>
          <Icon className={`h-6 w-6 ${color}`} />
        </div>
      </div>
    </div>
  );

  const StateBadge: React.FC<{ row: PanelRow }> = ({ row }) => {
    if (row.is_section_only) {
      if (row.result_verification_status === "verified") {
        return (
          <span className="inline-flex items-center px-3 py-1.5 rounded-full text-sm font-semibold bg-gradient-to-r from-green-100 to-emerald-100 text-green-800 border border-green-200 shadow-sm">
            <ShieldCheck className="h-4 w-4 mr-2" />
            Verified
          </span>
        );
      }

      if (row.panel_ready) {
        return (
          <span className="inline-flex items-center px-3 py-1.5 rounded-full text-sm font-semibold bg-gradient-to-r from-blue-100 to-indigo-100 text-blue-800 border border-blue-200 shadow-sm">
            <FileText className="h-4 w-4 mr-2" />
            Ready For Approval
          </span>
        );
      }
    }

    if (row.panel_ready) {
      return (
        <span className="inline-flex items-center px-3 py-1.5 rounded-full text-sm font-semibold bg-gradient-to-r from-green-100 to-emerald-100 text-green-800 border border-green-200 shadow-sm">
          <ShieldCheck className="h-4 w-4 mr-2" />
          Verified
        </span>
      );
    }
    if (row.approved_analytes > 0) {
      return (
        <span className="inline-flex items-center px-3 py-1.5 rounded-full text-sm font-semibold bg-gradient-to-r from-amber-100 to-orange-100 text-amber-800 border border-amber-200 shadow-sm">
          <AlertTriangle className="h-4 w-4 mr-2" />
          Partial ({row.approved_analytes}/{row.expected_analytes})
        </span>
      );
    }
    return (
      <span className="inline-flex items-center px-3 py-1.5 rounded-full text-sm font-semibold bg-gradient-to-r from-red-100 to-pink-100 text-red-800 border border-red-200 shadow-sm">
        <AlertCircle className="h-4 w-4 mr-2" />
        Pending
      </span>
    );
  };

  // Render function (not a React.FC) — keeps it inside the parent closure so it can
  // read state directly, but React never treats it as a component type, so it never
  // unmounts/remounts on re-render. Fixes scroll-to-top and input focus loss.
  const renderAnalyteRow = (a: Analyte, row: PanelRow) => {
    const status = a.verify_status || "pending";
    const isBusy = !!busy[a.id];
    const cacheKey = `${row.patient_id}-${a.parameter}`;
    const hasTrend = trendData[cacheKey] && trendData[cacheKey].length > 0;
    const showAISuggestion = !!showAISuggestionMap[a.id];
	    const isEditing = editingAnalyteId === a.id;
	    const isRerunRequest = a.verify_note && a.verify_note.toUpperCase().includes("RE-RUN");
	    const isHidden = !!a.is_hidden_from_report;
	    const debugMissing = calcDebugHints[a.result_id]?.[a.id] || [];
    const canVerify = canVerifyRow(row);
    const canUnapprove = canUnapproveResults;

    return (
      <>
	        <tr className={`hover:bg-blue-50 transition-colors ${isHidden ? 'bg-slate-50 text-slate-500' : a.is_auto_calculated ? 'bg-amber-50/50' : ''} ${isRerunRequest ? 'bg-orange-50' : ''}`}>
          <td className="px-4 py-4">
            <div className="flex items-center space-x-2">
              <div className="font-semibold text-gray-900">{a.parameter}</div>
	              {isRerunRequest && (
	                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-orange-100 text-orange-800 border border-orange-200">
                  <RefreshCcw className="h-3 w-3 mr-1" />
                  RE-RUN
	                </span>
	              )}
	              {isHidden && (
	                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-slate-200 text-slate-700 border border-slate-300">
	                  <EyeOff className="h-3 w-3 mr-1" />
	                  Hidden from report
	                </span>
	              )}
              {a.is_auto_calculated && (
                <span
                  className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${
                    a.value
                      ? 'bg-amber-100 text-amber-800 border-amber-200'
                      : 'bg-red-100 text-red-800 border-red-200'
                  }`}
                  title={
                    a.calculation_inputs && Object.keys(a.calculation_inputs).length > 0
                      ? `Calculated from: ${Object.entries(a.calculation_inputs).map(([k, v]) => `${k}=${v}`).join(', ')}`
                      : a.value
                        ? 'Auto-calculated (inputs not recorded)'
                        : 'Calculation failed — source values may be missing. Click Recalculate.'
                  }
                >
                  <Calculator className="h-3 w-3 mr-1" />
                  {a.value ? 'Calc' : 'Calc (failed)'}
                </span>
              )}
              <button
                onClick={() => loadTrendData(row.patient_id, a.parameter)}
                disabled={loadingTrend}
                className="inline-flex items-center text-blue-600 hover:text-blue-800 transition-colors"
                title="View trend"
              >
                {loadingTrend && selectedAnalyteTrend?.parameter === a.parameter ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <TrendingUp className="h-4 w-4" />
                )}
              </button>
              {hasTrend && (
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                  {trendData[cacheKey].length}
                </span>
              )}
              <button
                onClick={() => setShowAISuggestionMap(prev => ({ ...prev, [a.id]: !prev[a.id] }))}
                className="inline-flex items-center text-purple-600 hover:text-purple-800 transition-colors"
                title="Toggle AI suggestions"
              >
                <Sparkles className="h-4 w-4" />
              </button>
            </div>
	            {isRerunRequest && a.verify_note && (
	              <div className="mt-1 text-xs text-orange-600 bg-orange-50 px-2 py-1 rounded border border-orange-200">
	                {a.verify_note}
	              </div>
	            )}
	            {isHidden && (
	              <div className="mt-1 text-xs text-slate-500">
	                {a.hidden_reason || "Will not print on final report"}
	              </div>
	            )}
            {a.is_auto_calculated && !a.value && (
              <div className="mt-1 text-xs text-red-600 bg-red-50 px-2 py-1 rounded border border-red-200">
                Missing source values — enter all required analytes then click Recalculate
                {a.calculation_inputs && Object.keys(a.calculation_inputs).length > 0 && (
                  <span className="ml-1 text-gray-500">
                    (found: {Object.keys(a.calculation_inputs).join(', ')})
                  </span>
                )}
                {debugMissing.length > 0 && (
                  <div className="mt-1 text-[11px] text-red-700">
                    Missing: {debugMissing.join(", ")}
                  </div>
                )}
              </div>
            )}
            {a.is_auto_calculated && a.value && a.calculation_inputs && Object.keys(a.calculation_inputs).length > 0 && (
              <div className="mt-1 text-xs text-amber-700">
                Inputs: {Object.entries(a.calculation_inputs).map(([k, v]) => `${k}=${v}`).join(' · ')}
              </div>
            )}
            {a.value && !isRerunRequest && !a.is_auto_calculated && (
              <div className="text-sm text-gray-600 mt-1">
                Last updated: {a.verified_at ? new Date(a.verified_at).toLocaleString() : 'Never'}
              </div>
            )}
          </td>
          <td className="px-4 py-4">
            {isEditing ? (
              <input
                type="text"
                value={editValues.value}
                onChange={(e) => setEditValues(prev => ({ ...prev, value: e.target.value }))}
                className="w-full px-2 py-1 border border-blue-300 rounded focus:ring-2 focus:ring-blue-500 font-bold text-lg"
                placeholder="Enter value"
              />
            ) : (
              <div className="font-bold text-lg text-gray-900">{a.value ?? "—"}</div>
            )}
          </td>
          <td className="px-4 py-4">
            {isEditing ? (
              <input
                type="text"
                value={editValues.unit}
                onChange={(e) => setEditValues(prev => ({ ...prev, unit: e.target.value }))}
                className="w-full px-2 py-1 border border-blue-300 rounded focus:ring-2 focus:ring-blue-500 font-medium"
                placeholder="Unit"
              />
            ) : (
              <span className="font-medium text-gray-700">{a.unit}</span>
            )}
          </td>
          <td className="px-4 py-4">
            {isEditing ? (
              <input
                type="text"
                value={editValues.reference_range}
                onChange={(e) => setEditValues(prev => ({ ...prev, reference_range: e.target.value }))}
                className="w-full px-2 py-1 border border-blue-300 rounded focus:ring-2 focus:ring-blue-500 text-sm"
                placeholder="Reference range"
              />
            ) : (
              <div className="text-sm text-gray-600 max-w-xs">{a.reference_range}</div>
            )}
          </td>
          <td className="px-4 py-4">
            {isEditing ? (
              <select
                value={toSelectFlagValue(editValues.flag)}
                onChange={(e) => setEditValues(prev => ({ ...prev, flag: e.target.value || "normal" }))}
                className="px-2 py-1 border border-blue-300 rounded focus:ring-2 focus:ring-blue-500"
              >
                {FLAG_DROPDOWN_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            ) : (
              (() => {
                const flagLabel = getDisplayFlagLabel(a.flag);
                if (!flagLabel || getCanonicalFlag(a.flag) === "normal") return null;
                const styles = getFlagBadgeStyles(a.flag);
                return (
                  <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-bold ${styles.bg} ${styles.text} border`}>
                    {flagLabel}
                  </span>
                );
              })()
            )}
          </td>
          <td className="px-4 py-4">
            <div className="flex items-center space-x-3">
              {isEditing ? (
                // Edit mode buttons
                <div className="flex items-center space-x-2">
                  <button
	                    disabled={isBusy || !canVerify}
                    onClick={() => saveEditedAnalyte(a.id)}
                    className="inline-flex items-center px-3 py-2 rounded-lg text-sm font-semibold bg-gradient-to-r from-blue-500 to-indigo-500 text-white hover:from-blue-600 hover:to-indigo-600 transition-all duration-200 shadow-sm disabled:opacity-50"
                  >
                    {isBusy ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <CheckCircle2 className="h-4 w-4 mr-2" />
                    )}
                    Save
                  </button>
                  <button
                    onClick={cancelEditAnalyte}
                    className="inline-flex items-center px-3 py-2 rounded-lg text-sm font-semibold bg-gray-200 text-gray-700 hover:bg-gray-300 transition-all duration-200"
                  >
                    <X className="h-4 w-4 mr-2" />
                    Cancel
                  </button>
                </div>
              ) : status === "approved" ? (
                <div className="flex items-center space-x-2">
                  <span className="inline-flex items-center px-4 py-2 rounded-lg text-sm font-semibold bg-gradient-to-r from-green-600 to-emerald-600 text-white shadow-sm">
                    <CheckSquare className="h-4 w-4 mr-2" />
                    Approved
                  </span>
                  <button
                    disabled={isBusy}
                    onClick={() => startEditAnalyte(a)}
                    className="inline-flex items-center px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-gradient-to-r from-blue-100 to-indigo-100 text-blue-700 hover:from-blue-200 hover:to-indigo-200 transition-all duration-200 shadow-sm disabled:opacity-50"
                    title="Edit value — resets to pending for re-verification"
                  >
                    <svg className="h-3.5 w-3.5 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                    </svg>
                    Edit
                  </button>
	                  {canUnapprove && (
	                    <button
	                      disabled={isBusy}
	                      onClick={() => unapproveAnalyte(a.id, a.result_id)}
                      className="inline-flex items-center px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-gradient-to-r from-orange-100 to-amber-100 text-orange-700 hover:from-orange-200 hover:to-amber-200 transition-all duration-200 shadow-sm disabled:opacity-50"
                      title="Admin: Revert to pending without editing"
                    >
                      <Undo2 className="h-3.5 w-3.5 mr-1" />
                      Unapprove
                    </button>
                  )}
                </div>
              ) : status === "rejected" ? (
                // Rejected state - show Edit and Re-run options
                <div className="flex flex-col space-y-2">
                  <div className="flex items-center space-x-2">
                    <span className="inline-flex items-center px-3 py-1.5 rounded-lg text-sm font-semibold bg-gradient-to-r from-red-600 to-rose-600 text-white">
                      <XCircle className="h-4 w-4 mr-2" />
                      Rejected
                    </span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <button
                      disabled={isBusy}
                      onClick={() => startEditAnalyte(a)}
                      className="inline-flex items-center px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-gradient-to-r from-blue-100 to-indigo-100 text-blue-700 hover:from-blue-200 hover:to-indigo-200 transition-all duration-200 shadow-sm disabled:opacity-50"
                      title="Edit value and reset to pending"
                    >
                      <svg className="h-3.5 w-3.5 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                      </svg>
                      Edit Value
                    </button>
                    <button
                      disabled={isBusy}
                      onClick={() => sendForRerun(a.id)}
                      className="inline-flex items-center px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-gradient-to-r from-orange-100 to-amber-100 text-orange-700 hover:from-orange-200 hover:to-amber-200 transition-all duration-200 shadow-sm disabled:opacity-50"
                      title="Send back to result entry for re-run"
                    >
                      <RefreshCcw className="h-3.5 w-3.5 mr-1.5" />
                      Send for Re-run
                    </button>
                  </div>
                </div>
              ) : (
                // Pending state - show Edit / Approve / Reject
                <div className="flex items-center flex-wrap gap-2">
                  <button
                      disabled={isBusy || !canVerify}
                      onClick={() => approveAnalyte(a.id)}
                    className="inline-flex items-center px-3 py-2 rounded-lg text-sm font-semibold bg-gradient-to-r from-green-500 to-emerald-500 text-white hover:from-green-600 hover:to-emerald-600 transition-all duration-200 shadow-sm disabled:opacity-50"
                  >
                    {isBusy ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <CheckCircle2 className="h-4 w-4 mr-2" />
                    )}
                    Approve
                  </button>

                  <button
                      disabled={isBusy || !canVerify}
                      onClick={() => rejectAnalyte(a.id)}
                    className="inline-flex items-center px-3 py-2 rounded-lg text-sm font-semibold bg-gradient-to-r from-red-100 to-rose-100 text-red-700 hover:from-red-200 hover:to-rose-200 transition-all duration-200 shadow-sm disabled:opacity-50"
                  >
                    <XCircle className="h-4 w-4 mr-2" />
                    Reject
                  </button>

                  <button
                    disabled={isBusy}
                    onClick={() => startEditAnalyte(a)}
                    className="inline-flex items-center px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-gradient-to-r from-gray-100 to-slate-100 text-gray-600 hover:from-gray-200 hover:to-slate-200 transition-all duration-200 shadow-sm disabled:opacity-50"
                    title="Edit value"
                  >
                    <svg className="h-3.5 w-3.5 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                    </svg>
                    Edit
                  </button>
                </div>
              )}
            </div>

            {a.verify_note && (
              <div className="text-xs text-gray-500 mt-2 italic bg-gray-50 p-2 rounded border">
                Note: {a.verify_note}
              </div>
            )}
          </td>
        </tr>
        {showAISuggestion && (
          <tr>
            <td colSpan={6} className="px-4 py-2 bg-gray-50">
              <AIResultSuggestionCard
                resultValue={{
                  id: a.id,
                  analyte_name: a.parameter,
                  value: a.value || '',
                  unit: a.unit,
                  reference_range: a.reference_range,
                  flag: toAISuggestionFlag(a.flag),
                  ai_suggested_flag: null,
                  ai_suggested_interpretation: null,
                  trend_interpretation: null
                }}
                onApplied={async () => {
                  // Reload analytes after applying AI suggestions
                  await ensureAnalytesLoaded(a.result_id);
                }}
              />
            </td>
          </tr>
        )}
      </>
    );
  };

  const handleRunAIAnalysis = async (row: PanelRow) => {
    if (!confirm(`Run AI Flag & Range Analysis for order #${row.order_id.slice(-8)}?`)) return;

    setBusyFor(row.result_id, true);
    try {
      // Dynamic import to avoid loading AI logic unless needed
      const { runAIFlagAnalysis } = await import('../utils/aiFlagAnalysis');

      const result = await runAIFlagAnalysis(row.order_id, {
        useAIService: true, // Force AI service
        applyToDatabase: true,
        createAudit: true,
        overrideManual: false
      });

      if (result.flagsChanged > 0 || result.results.length > 0) {
        alert(`AI Analysis Completed.\nFlags Changed: ${result.flagsChanged}\nTotal Processed: ${result.totalProcessed}`);
        // Reload data
        await ensureAnalytesLoaded(row.result_id);
      } else {
        alert('AI Analysis Completed. No changes detected.');
      }
    } catch (e) {
      console.error(e);
      alert('AI Analysis failed.');
    } finally {
      setBusyFor(row.result_id, false);
    }
  };

  const renderPanelCard = (row: PanelRow) => {
    const isOpen = !!open[row.result_id];
    const analytes = rowsByResult[row.result_id] || [];
    const isSelected = selectedPanels.has(row.result_id);
    const pct = row.expected_analytes > 0
      ? Math.round((row.approved_analytes / row.expected_analytes) * 100)
      : 0;

    return (
      <div className={`border-2 rounded-2xl bg-white shadow-sm hover:shadow-lg transition-all duration-300 ${isSelected ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:border-gray-300'
        }`}>
        {/* Header */}
        <div className="p-6 border-b border-gray-100">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-4">
              <input
                type="checkbox"
                checked={isSelected}
                onChange={() => togglePanelSelection(row.result_id)}
                className="w-5 h-5 rounded-md border-2 border-gray-300 text-blue-600 focus:ring-blue-500 focus:ring-2"
              />

              <div className="flex items-center space-x-4">
                <div className="bg-gradient-to-br from-blue-500 to-indigo-600 p-3 rounded-xl shadow-sm">
                  <User className="h-6 w-6 text-white" />
                </div>
                <div>
                  <h3 className="text-xl font-bold text-gray-900">
                    {row.patient_name}
                  </h3>
                  <div className="flex items-center space-x-3 text-sm text-gray-600">
                    <span className="flex items-center">
                      <Calendar className="h-4 w-4 mr-1" />
                      {fmtDate(row.order_date)}
                    </span>
                    <span className="flex items-center">
                      <FileText className="h-4 w-4 mr-1" />
                      #{row.order_id.slice(-8)}
                    </span>
                    {row.priority && row.priority !== "Normal" && (
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-lg text-xs font-bold border ${
                        row.priority === "STAT"
                          ? "bg-red-100 text-red-800 border-red-300 animate-pulse"
                          : "bg-orange-100 text-orange-800 border-orange-300"
                      }`}>
                        {row.priority === "STAT" ? "🚨 STAT" : "⚡ Urgent"}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div className="flex items-center space-x-4">
              <div className="text-right">
                <div className="text-sm text-gray-600 mb-1">Progress</div>
                <div className="flex items-center space-x-3">
                  <div className="text-lg font-bold text-gray-900">
                    {row.approved_analytes}/{row.expected_analytes}
                  </div>
                  <div className="w-24 bg-gray-200 h-3 rounded-full overflow-hidden">
                    <div
                      className={`h-3 rounded-full transition-all duration-500 ${pct >= 100 ? 'bg-gradient-to-r from-green-500 to-emerald-500' :
                        pct >= 50 ? 'bg-gradient-to-r from-amber-500 to-orange-500' :
                          'bg-gradient-to-r from-red-500 to-rose-500'
                        }`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="text-sm font-semibold text-gray-700">{pct}%</span>
                </div>
              </div>

              <StateBadge row={row} />

              <button
                onClick={() => toggleOpen(row)}
                className="p-3 rounded-xl hover:bg-gray-100 transition-colors"
                aria-label="Toggle panel details"
              >
                {isOpen ? (
                  <ChevronUp className="h-6 w-6 text-gray-600" />
                ) : (
                  <ChevronDown className="h-6 w-6 text-gray-600" />
                )}
              </button>
            </div>
          </div>

          <div className="mt-4 flex items-center justify-between">
            <button
              onClick={() => toggleOpen(row)}
              className="flex items-center space-x-3 p-2 -m-2 rounded-lg hover:bg-gray-50 transition-colors cursor-pointer flex-1"
              title="Click to expand/collapse test details"
            >
              <TestTube className="h-5 w-5 text-gray-500" />
	              <span className="text-lg font-semibold text-gray-900">
	                {row.test_group_name}
	              </span>
	              <span className="text-sm text-gray-500">
	                {row.is_section_only ? '(Section-only report)' : `(${row.expected_analytes} analytes)`}
	              </span>
              {isOpen ? (
                <ChevronUp className="h-4 w-4 text-gray-400 ml-2" />
              ) : (
                <ChevronDown className="h-4 w-4 text-gray-400 ml-2" />
              )}
            </button>

            {!isOpen && (
              <div className="flex items-center gap-2">
                {/* Report Extras Checkboxes */}
                <div className="hidden lg:flex items-center gap-3 mr-2 px-3 py-1.5 bg-gray-50 rounded-lg border border-gray-200">
                  <label className="flex items-center gap-1.5 cursor-pointer text-xs font-medium text-gray-600 hover:text-gray-800">
                    <input
                      type="checkbox"
                      checked={includeTrendsInReport[row.order_id] ?? false}
                      onChange={(e) => setIncludeTrendsInReport(prev => ({ ...prev, [row.order_id]: e.target.checked }))}
                      className="w-3.5 h-3.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                    />
                    <TrendingUp className="h-3.5 w-3.5" />
                    <span>Trends</span>
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer text-xs font-medium text-gray-600 hover:text-gray-800">
                    <input
                      type="checkbox"
                      checked={includeSummaryInReport[row.order_id] ?? false}
                      onChange={(e) => setIncludeSummaryInReport(prev => ({ ...prev, [row.order_id]: e.target.checked }))}
                      disabled={!aiClinicalSummary[row.order_id]}
                      className="w-3.5 h-3.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer disabled:opacity-50"
                      title={aiClinicalSummary[row.order_id] ? "Include clinical summary in report" : "Generate Doctor Summary from expanded panel first"}
                    />
                    <Stethoscope className="h-3.5 w-3.5" />
                    <span className={!aiClinicalSummary[row.order_id] ? "opacity-50" : ""}>Summary</span>
                  </label>
                </div>
                {/* Doctor Summary removed - it's at ORDER level, available in expanded panel's AIDoctorSummaryPanel component */}
                <button
                  onClick={() => {
                    setSelectedOrderForAttachments(row.order_id);
                    setShowAttachmentSelector(true);
                  }}
                  className="inline-flex items-center px-3 py-2 sm:px-4 sm:py-2 bg-gradient-to-r from-purple-600 to-indigo-600 text-white rounded-lg sm:rounded-xl hover:from-purple-700 hover:to-indigo-700 transition-all duration-200 shadow-sm font-semibold text-xs sm:text-sm"
                  title="Manage which attachments to include in final report"
                >
                  <FileImage className="h-4 w-4 sm:mr-2" />
                  <span className="hidden sm:inline">Manage Attachments</span>
                </button>
                <button
                  onClick={() => handleEmailReport(row)}
	                  disabled={busy[row.result_id] || !canVerifyRow(row)}
                  className="inline-flex items-center px-3 py-2 sm:px-4 sm:py-2 bg-gradient-to-r from-blue-500 to-cyan-500 text-white rounded-lg sm:rounded-xl hover:from-blue-600 hover:to-cyan-600 transition-all duration-200 shadow-sm font-semibold text-xs sm:text-sm"
                  title="Email Report to Patient"
                >
                  <Mail className="h-4 w-4 sm:mr-2" />
                  <span className="hidden sm:inline">Email</span>
                </button>
                <button
                  disabled={busy[row.result_id] || recalculating[row.result_id]}
                  onClick={() => recalculatePanel(row)}
                  className="inline-flex items-center px-3 py-2 sm:px-4 sm:py-2 bg-gradient-to-r from-amber-500 to-yellow-500 text-white rounded-lg sm:rounded-xl hover:from-amber-600 hover:to-yellow-600 transition-all duration-200 shadow-sm font-semibold disabled:opacity-50 text-xs sm:text-sm"
                  title="Recalculate all calculated parameters (VLDL, TC/HDL ratio, etc.)"
                >
                  {recalculating[row.result_id] ? (
                    <Loader2 className="h-4 w-4 sm:mr-2 animate-spin" />
                  ) : (
                    <Calculator className="h-4 w-4 sm:mr-2" />
                  )}
                  <span className="hidden sm:inline">Recalculate</span>
                </button>
                <button
                  disabled={busy[row.result_id]}
                  onClick={() => approveAllInPanel(row)}
                  className="inline-flex items-center px-3 py-2 sm:px-4 sm:py-2 bg-gradient-to-r from-green-600 to-emerald-600 text-white rounded-lg sm:rounded-xl hover:from-green-700 hover:to-emerald-700 transition-all duration-200 shadow-sm font-semibold disabled:opacity-50 text-xs sm:text-sm"
                >
                  {busy[row.result_id] ? (
                    <Loader2 className="h-4 w-4 sm:mr-2 animate-spin" />
                  ) : (
                    <CheckCircle2 className="h-4 w-4 sm:mr-2" />
                  )}
	                  <span className="hidden sm:inline">{row.is_section_only ? 'Approve Report' : 'Approve All'}</span>
	                </button>
		                {canUnapproveResults && (row.approved_analytes > 0 || row.result_verification_status === "verified") && (
	                  <button
                    disabled={busy[row.result_id]}
                    onClick={() => unapproveAllInPanel(row)}
                    className="inline-flex items-center px-3 py-2 sm:px-4 sm:py-2 bg-gradient-to-r from-orange-500 to-amber-500 text-white rounded-lg sm:rounded-xl hover:from-orange-600 hover:to-amber-600 transition-all duration-200 shadow-sm font-semibold disabled:opacity-50 text-xs sm:text-sm"
                    title="Admin: Revert all approved analytes back to pending"
                  >
                    <Undo2 className="h-4 w-4 sm:mr-2" />
                    <span className="hidden sm:inline">Unapprove All</span>
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Expanded content */}
        {isOpen && (
          <div className="p-6 bg-gray-50">
            <div className="mb-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
              <div className="text-sm text-gray-600">
	                <span className="font-semibold">Entered:</span> {row.entered_analytes} •
	                <span className="font-semibold ml-2">
	                  {row.is_section_only ? 'Report Status:' : 'Approved:'}
	                </span>{" "}
	                {row.is_section_only
	                  ? (row.result_verification_status === "verified" ? "Verified" : "Pending Verification")
	                  : row.approved_analytes}
	              </div>
              <div className="flex flex-wrap items-center gap-2">
                {/* AI Delta Check Button - Quality control comparing current vs historical */}
                <button
                  disabled={aiIntelligence.loading || analytes.length === 0}
                  onClick={async () => {
                    try {
                      // Get patient ID for fetching historical data
                      const patientId = row.patient_id;

                      // Convert analytes to ResultValue format with historical data
                      const resultValuesWithHistory: ResultValue[] = await Promise.all(
                        analytes
                          .filter(a => a.value)
                          .map(async (a) => {
                            // Fetch historical values for this analyte from past orders
                            const { data: historyData } = await supabase
                              .from('result_values')
                              .select(`
                                value,
                                flag,
                                created_at,
                                results!inner(
                                  order_id,
                                  orders!inner(
                                    patient_id,
                                    created_at
                                  )
                                )
                              `)
                              .eq('analyte_id', a.analyte_id || a.id)
                              .eq('results.orders.patient_id', patientId)
                              .neq('id', a.id) // Exclude current value
                              .not('value', 'is', null)
                              .order('created_at', { ascending: false })
                              .limit(10);

                            // Also fetch external/outsourced results if available
                            const { data: externalData } = await supabase
                              .from('external_result_values')
                              .select('value, original_analyte_name, created_at, external_reports!fk_erv_report!inner(patient_id)')
                              .eq('external_reports.patient_id', patientId)
                              .ilike('original_analyte_name', `%${a.parameter}%`)
                              .order('created_at', { ascending: false })
                              .limit(5);

                            const historicalValues = [
                              ...(historyData || []).map((h: any) => ({
                                date: new Date(h.created_at).toLocaleDateString(),
                                value: h.value,
                                flag: h.flag,
                                source: 'internal' as const,
                              })),
                              ...(externalData || []).map((e: any) => ({
                                date: new Date(e.created_at).toLocaleDateString(),
                                value: e.value,
                                flag: null,
                                source: 'external' as const,
                              })),
                            ].sort((x, y) => new Date(y.date).getTime() - new Date(x.date).getTime());

                            return {
                              id: a.id,
                              analyte_id: a.analyte_id || a.id,
                              analyte_name: a.parameter,
                              value: a.value || '',
                              unit: a.unit,
                              reference_range: a.reference_range,
                              flag: toAISuggestionFlag(a.flag),
                              historical_values: historicalValues,
                            };
                          })
                      );

                      if (resultValuesWithHistory.length === 0) {
                        alert('No analyte values to analyze. Please enter values first.');
                        return;
                      }

                      const testGroup = {
                        test_group_name: row.test_group_name || 'Unknown',
                        test_group_code: row.test_group_id || '',
                        category: 'General',
                      };

                      // Call Delta Check AI function
                      const deltaCheckResult = await aiIntelligence.performDeltaCheck(
                        testGroup,
                        resultValuesWithHistory,
                        { age: row.patient_age, gender: row.patient_gender }
                      );

                      if (deltaCheckResult) {
                        setAiDeltaCheckResults(prev => ({ ...prev, [row.result_id]: deltaCheckResult }));
                        setDeltaCheckTargetResultId(row.result_id);
                        setShowDeltaCheckModal(true);
                      } else {
                        alert('No delta check results generated. Please try again.');
                      }
                    } catch (error) {
                      console.error('AI Delta Check failed:', error);
                      alert('Failed to perform delta check: ' + (error instanceof Error ? error.message : 'Unknown error'));
                    }
                  }}
                  className="inline-flex items-center px-4 py-2 bg-gradient-to-r from-amber-500 to-orange-500 text-white rounded-lg hover:from-amber-600 hover:to-orange-600 transition-all duration-200 shadow-sm font-medium text-sm disabled:opacity-50"
                  title="AI Delta Check - Compare current values with historical data to detect potential errors"
                >
                  {aiIntelligence.loading ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Zap className="h-4 w-4 mr-2" />
                  )}
                  AI Delta Check
                </button>

                {/* AI Flag & Range Analysis Button - Hidden (now done in backend automatically) */}
                {/* AI Verifier Summary Button - Hidden (now done in backend automatically) */}

                <button
                  disabled={busy[row.result_id] || recalculating[row.result_id]}
                  onClick={() => recalculatePanel(row)}
                  className="inline-flex items-center px-5 py-3 bg-gradient-to-r from-amber-500 to-yellow-500 text-white rounded-xl hover:from-amber-600 hover:to-yellow-600 transition-all duration-200 shadow-lg font-semibold disabled:opacity-50"
                  title="Recalculate all calculated parameters from current source values"
                >
                  {recalculating[row.result_id] ? (
                    <Loader2 className="h-5 w-5 mr-2 animate-spin" />
                  ) : (
                    <Calculator className="h-5 w-5 mr-2" />
                  )}
	                  Recalculate
	                </button>
	                <button
	                  disabled={busy[row.result_id] || !canVerifyRow(row)}
	                  onClick={() => approveAllInPanel(row)}
	                  className="inline-flex items-center px-6 py-3 bg-gradient-to-r from-green-600 to-emerald-600 text-white rounded-xl hover:from-green-700 hover:to-emerald-700 transition-all duration-200 shadow-lg font-semibold disabled:opacity-50"
                >
                  {busy[row.result_id] ? (
                    <Loader2 className="h-5 w-5 mr-2 animate-spin" />
                  ) : (
                    <CheckCircle2 className="h-5 w-5 mr-2" />
                  )}
	                  {row.is_section_only ? 'Approve Section Report' : 'Approve All Analytes'}
	                </button>
		                {canUnapproveResults && (row.approved_analytes > 0 || row.result_verification_status === "verified") && (
	                  <button
                    disabled={busy[row.result_id]}
                    onClick={() => unapproveAllInPanel(row)}
                    className="inline-flex items-center px-6 py-3 bg-gradient-to-r from-orange-500 to-amber-500 text-white rounded-xl hover:from-orange-600 hover:to-amber-600 transition-all duration-200 shadow-lg font-semibold disabled:opacity-50"
                    title="Admin: Revert all approved analytes back to pending"
                  >
                    <Undo2 className="h-5 w-5 mr-2" />
                    Unapprove All
                  </button>
                )}
              </div>
            </div>

	            {row.is_section_only ? (
	              <div className="bg-white rounded-xl shadow-sm border border-purple-200 p-6">
	                <div className="flex items-start gap-3">
	                  <FileText className="h-5 w-5 text-purple-600 mt-0.5" />
	                  <div>
	                    <h4 className="text-base font-semibold text-gray-900">Section-only report</h4>
	                    <p className="text-sm text-gray-600 mt-1">
	                      This test group is verified using section content instead of analyte rows.
	                    </p>
	                  </div>
	                </div>
	              </div>
	            ) : (
	            <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
	              <table className="min-w-full">
                <thead className="bg-gradient-to-r from-gray-50 to-gray-100">
                  <tr>
                    <th className="px-4 py-4 text-left text-sm font-bold text-gray-700 uppercase tracking-wider">
                      Analyte
                    </th>
                    <th className="px-4 py-4 text-left text-sm font-bold text-gray-700 uppercase tracking-wider">
                      Value
                    </th>
                    <th className="px-4 py-4 text-left text-sm font-bold text-gray-700 uppercase tracking-wider">
                      Unit
                    </th>
                    <th className="px-4 py-4 text-left text-sm font-bold text-gray-700 uppercase tracking-wider">
                      Reference Range
                    </th>
                    <th className="px-4 py-4 text-left text-sm font-bold text-gray-700 uppercase tracking-wider">
                      Flag
                    </th>
                    <th className="px-4 py-4 text-left text-sm font-bold text-gray-700 uppercase tracking-wider">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {analytes.map((a, index) => (
                    <React.Fragment key={a.id}>
                      {a.section_heading && a.section_heading !== analytes[index - 1]?.section_heading && (
                        <tr className="bg-blue-50">
                          <td colSpan={6} className="px-4 py-2 text-xs font-bold uppercase tracking-wide text-blue-800">
                            {a.section_heading}
                          </td>
                        </tr>
                      )}
                      {renderAnalyteRow(a, row)}
                    </React.Fragment>
                  ))}
                </tbody>
	              </table>
	            </div>
	            )}

            <div className="mt-6 rounded-xl border border-amber-200 bg-amber-50/50 p-5 shadow-sm">
              <div className="mb-2 flex items-center justify-between gap-3">
                <div>
                  <h4 className="font-semibold text-amber-900">Report Remarks</h4>
                  <p className="text-xs text-amber-700">
                    Printed below this test group in the final report.
                  </p>
                </div>
                <button
                  type="button"
                  disabled={!remarkDirty[row.result_id] || remarkSaving[row.result_id]}
                  onClick={() => saveGroupRemark(row)}
                  className="inline-flex items-center rounded-lg bg-amber-600 px-3 py-2 text-sm font-semibold text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {remarkSaving[row.result_id] && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Save Remark
                </button>
              </div>
              <textarea
                value={remarksByResult[row.result_id] || ""}
                onChange={(event) => {
                  const value = event.target.value;
                  setRemarksByResult((current) => ({ ...current, [row.result_id]: value }));
                  setRemarkDirty((current) => ({ ...current, [row.result_id]: true }));
                }}
                rows={3}
                maxLength={2000}
                placeholder="Optional report-visible remark"
                className="w-full resize-y rounded-lg border border-amber-200 bg-white px-3 py-2 text-sm text-gray-800 outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-100"
              />
            </div>

            {/* Attachments section */}
            <div className="mt-6 bg-white rounded-xl shadow-sm border border-gray-200">
              <div className="px-6 py-4 border-b border-gray-200">
                <div className="flex items-center justify-between">
                  <h4 className="text-lg font-semibold text-gray-900 flex items-center">
                    <FileText className="h-5 w-5 mr-2 text-blue-600" />
                    Attachments
                    {attachmentsByOrder[row.order_id] && (
                      <span className="ml-2 text-sm bg-blue-100 text-blue-800 px-2 py-1 rounded-full">
                        {attachmentsByOrder[row.order_id].length}
                      </span>
                    )}
                  </h4>
                  <div className="flex items-center space-x-2">
                    <button
                      onClick={() => setAttachmentViewMode('test')}
                      className={`text-xs px-3 py-1 rounded-full transition-colors ${attachmentViewMode === 'test'
                        ? 'bg-blue-100 text-blue-700 font-medium'
                        : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                        }`}
                    >
                      Test Only
                      {attachmentsByOrder[row.order_id] && (
                        <span className="ml-1 text-xs">
                          ({attachmentsByOrder[row.order_id].filter(a => a.level === 'test').length})
                        </span>
                      )}
                    </button>
                    <button
                      onClick={() => setAttachmentViewMode('all')}
                      className={`text-xs px-3 py-1 rounded-full transition-colors ${attachmentViewMode === 'all'
                        ? 'bg-blue-100 text-blue-700 font-medium'
                        : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                        }`}
                    >
                      All
                      {attachmentsByOrder[row.order_id] && (
                        <span className="ml-1 text-xs">
                          ({attachmentsByOrder[row.order_id].length})
                        </span>
                      )}
                    </button>
                  </div>
                </div>
              </div>
              <div className="p-6">
                <AttachmentViewer
                  attachments={attachmentsByOrder[row.order_id] || []}
                  viewMode={attachmentViewMode}
                />
              </div>
            </div>

            {/* AI Trend Graphs Section */}
            <div className="mt-6">
              <TrendGraphPanel
                orderId={row.order_id}
                patientId={row.patient_id}
                analyteIds={analytes.map(a => a.analyte_id || '')}
                analyteNames={analytes.map(a => a.parameter)}
                includeInReport={includeTrendsInReport[row.order_id] ?? false}
                onIncludeInReportChange={(include) => {
                  setIncludeTrendsInReport(prev => ({ ...prev, [row.order_id]: include }));
                }}
                onSaved={() => {
                  // Auto-enable include in report when trends are saved
                  setIncludeTrendsInReport(prev => ({ ...prev, [row.order_id]: true }));
                }}
              />
            </div>

            {/* Report Sections Editor (PBS/Radiology findings, impressions, etc.) */}
            {row.test_group_id && (
              <div className="mt-6">
	                <SectionEditor
	                  ref={(instance) => {
	                    sectionEditorRefs.current[row.result_id] = instance;
	                  }}
	                  resultId={row.result_id}
	                  testGroupId={row.test_group_id}
	                  showAIAssistant={false}
                      readOnly={!canEditSectionsForRow(row)}
                      canEdit={canEditSectionsForRow(row)}
	                  onSave={() => {
	                    console.log('Section content saved for result:', row.result_id);
	                  }}
                />
              </div>
            )}

            {/* Workflow Execution Panel - Shows workflow history and document generation */}
            <div className="mt-6">
              <WorkflowExecutionPanel
                orderId={row.order_id}
                testGroupId={row.test_group_id || undefined}
                resultId={row.result_id}
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
  };

  /* ----------------- Date Preset Functions ----------------- */
  const setDateRange = (days: number) => {
    const to = new Date();
    const from = new Date();
    from.setDate(to.getDate() - days);

    setTo(to.toISOString().split('T')[0]);
    setFrom(from.toISOString().split('T')[0]);
  };

  const setToday = () => {
    const today = new Date().toISOString().split('T')[0];
    setFrom(today);
    setTo(today);
  };

  /* ----------------- Trend Modal Component ----------------- */
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
              <h3 className="text-xl font-bold text-white">
                Trend: {selectedAnalyteTrend.parameter}
              </h3>
            </div>
            <button
              onClick={() => setShowTrendModal(false)}
              className="text-white hover:bg-white hover:bg-opacity-20 rounded-full p-2 transition-colors"
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
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <span className="text-gray-600 font-medium">Total Records:</span>
                      <span className="ml-2 text-gray-900 font-bold">{trends.length}</span>
                    </div>
                    <div>
                      <span className="text-gray-600 font-medium">Date Range:</span>
                      <span className="ml-2 text-gray-900 font-bold">
                        {trends.length > 0 && fmtDate(trends[trends.length - 1].order_date)} - {trends.length > 0 && fmtDate(trends[0].order_date)}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                  <table className="min-w-full">
                    <thead className="bg-gradient-to-r from-gray-50 to-gray-100">
                      <tr>
                        <th className="px-4 py-3 text-left text-sm font-bold text-gray-700 uppercase">
                          Order Date
                        </th>
                        <th className="px-4 py-3 text-left text-sm font-bold text-gray-700 uppercase">
                          Test Name
                        </th>
                        <th className="px-4 py-3 text-left text-sm font-bold text-gray-700 uppercase">
                          Value
                        </th>
                        <th className="px-4 py-3 text-left text-sm font-bold text-gray-700 uppercase">
                          Unit
                        </th>
                        <th className="px-4 py-3 text-left text-sm font-bold text-gray-700 uppercase">
                          Range
                        </th>
                        <th className="px-4 py-3 text-left text-sm font-bold text-gray-700 uppercase">
                          Flag
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {trends.map((trend, idx) => {
                        const isLatest = idx === 0;
                        return (
                          <tr
                            key={idx}
                            className={`${isLatest ? 'bg-blue-50 font-semibold' : 'hover:bg-gray-50'
                              } transition-colors`}
                          >
                            <td className="px-4 py-3 text-sm text-gray-900">
                              {fmtDate(trend.order_date)}
                              {isLatest && (
                                <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold bg-blue-100 text-blue-800">
                                  Latest
                                </span>
                              )}
                            </td>
                            <td className="px-4 py-3 text-sm text-gray-700">
                              {trend.test_name}
                            </td>
                            <td className="px-4 py-3">
                              <span className="text-lg font-bold text-gray-900">
                                {trend.value}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-sm font-medium text-gray-700">
                              {trend.unit}
                            </td>
                            <td className="px-4 py-3 text-sm text-gray-600">
                              {trend.reference_range}
                            </td>
                            <td className="px-4 py-3">
                              {trend.flag && (
                                <span
                                  className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-bold ${getFlagBadgeStyles(trend.flag).bg} ${getFlagBadgeStyles(trend.flag).text}`}
                                >
                                  {getDisplayFlagLabel(trend.flag)}
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
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

  /* ----------------- AI Summary Modal Component ----------------- */
  const AISummaryModal: React.FC = () => {
    if (!showAiSummaryModal || !aiSummaryTarget) return null;

    const isVerifier = aiSummaryTarget.type === 'verifier';
    const summary = isVerifier && aiSummaryTarget.resultId
      ? aiVerifierSummary[aiSummaryTarget.resultId]
      : (aiSummaryTarget.orderId ? aiClinicalSummary[aiSummaryTarget.orderId] : null);

    if (!summary) return null;

    const getRecommendationColor = (rec: string) => {
      switch (rec) {
        case 'approve': return 'bg-green-100 text-green-800 border-green-300';
        case 'needs_clarification': return 'bg-amber-100 text-amber-800 border-amber-300';
        case 'reject': return 'bg-red-100 text-red-800 border-red-300';
        default: return 'bg-gray-100 text-gray-800 border-gray-300';
      }
    };

    return ReactDOM.createPortal(
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
        <div className="bg-white rounded-2xl shadow-2xl max-w-4xl w-full max-h-[90vh] overflow-hidden">
          <div className="bg-gradient-to-r from-purple-600 to-indigo-600 px-6 py-4 flex items-center justify-between">
            <div className="flex items-center space-x-3">
              {isVerifier ? (
                <ClipboardList className="h-6 w-6 text-white" />
              ) : (
                <Stethoscope className="h-6 w-6 text-white" />
              )}
              <h3 className="text-xl font-bold text-white">
                {isVerifier ? 'AI Verifier Summary' : 'Clinical Summary for Doctor'}
              </h3>
            </div>
            <button
              onClick={() => {
                setShowAiSummaryModal(false);
                setAiSummaryTarget(null);
              }}
              className="text-white hover:bg-white hover:bg-opacity-20 rounded-full p-2 transition-colors"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="p-6 overflow-y-auto max-h-[calc(90vh-80px)]">
            {isVerifier && 'overall_assessment' in summary ? (
              // Verifier Summary
              <div className="space-y-6">
                {/* Overall Assessment */}
                <div className="bg-gradient-to-r from-purple-50 to-indigo-50 rounded-xl p-4 border border-purple-200">
                  <h4 className="font-semibold text-purple-900 mb-2 flex items-center">
                    <Sparkles className="h-5 w-5 mr-2" />
                    Overall Assessment
                  </h4>
                  <p className="text-gray-800">{(summary as VerifierSummaryResponse).overall_assessment}</p>
                </div>

                {/* Recommendation */}
                <div className={`rounded-xl p-4 border-2 ${getRecommendationColor((summary as VerifierSummaryResponse).recommendation)}`}>
                  <div className="flex items-center justify-between">
                    <div>
                      <h4 className="font-semibold mb-1">AI Recommendation</h4>
                      <span className="text-lg font-bold capitalize">
                        {(summary as VerifierSummaryResponse).recommendation.replace('_', ' ')}
                      </span>
                    </div>
                    {(summary as VerifierSummaryResponse).recommendation === 'approve' && (
                      <CheckCircle2 className="h-8 w-8 text-green-600" />
                    )}
                    {(summary as VerifierSummaryResponse).recommendation === 'needs_clarification' && (
                      <AlertTriangle className="h-8 w-8 text-amber-600" />
                    )}
                    {(summary as VerifierSummaryResponse).recommendation === 'reject' && (
                      <XCircle className="h-8 w-8 text-red-600" />
                    )}
                  </div>
                  <p className="text-sm mt-2 opacity-80">{(summary as VerifierSummaryResponse).recommendation_reason}</p>
                </div>

                {/* Abnormal Findings */}
                {(summary as VerifierSummaryResponse).abnormal_findings.length > 0 && (
                  <div className="bg-amber-50 rounded-xl p-4 border border-amber-200">
                    <h4 className="font-semibold text-amber-900 mb-3 flex items-center">
                      <AlertTriangle className="h-5 w-5 mr-2" />
                      Abnormal Findings
                    </h4>
                    <ul className="space-y-2">
                      {(summary as VerifierSummaryResponse).abnormal_findings.map((finding, idx) => (
                        <li key={idx} className="flex items-start text-gray-800">
                          <span className="inline-block w-2 h-2 bg-amber-500 rounded-full mt-2 mr-3 flex-shrink-0" />
                          {finding}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Critical Alerts */}
                {(summary as VerifierSummaryResponse).critical_alerts.length > 0 && (
                  <div className="bg-red-50 rounded-xl p-4 border border-red-200">
                    <h4 className="font-semibold text-red-900 mb-3 flex items-center">
                      <AlertCircle className="h-5 w-5 mr-2" />
                      Critical Alerts
                    </h4>
                    <ul className="space-y-2">
                      {(summary as VerifierSummaryResponse).critical_alerts.map((alert, idx) => (
                        <li key={idx} className="flex items-start text-red-800 font-medium">
                          <span className="inline-block w-2 h-2 bg-red-500 rounded-full mt-2 mr-3 flex-shrink-0" />
                          {alert}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Verifier Notes */}
                {(summary as VerifierSummaryResponse).verifier_notes && (
                  <div className="bg-gray-50 rounded-xl p-4 border border-gray-200">
                    <h4 className="font-semibold text-gray-700 mb-2">Additional Notes</h4>
                    <p className="text-gray-600 text-sm">{(summary as VerifierSummaryResponse).verifier_notes}</p>
                  </div>
                )}
              </div>
            ) : (
              // Clinical Summary
              <div className="space-y-6">
                {/* Executive Summary */}
                <div className="bg-gradient-to-r from-blue-50 to-cyan-50 rounded-xl p-4 border border-blue-200">
                  <h4 className="font-semibold text-blue-900 mb-2 flex items-center">
                    <Stethoscope className="h-5 w-5 mr-2" />
                    Executive Summary
                  </h4>
                  <p className="text-gray-800">{(summary as ClinicalSummaryResponse).executive_summary}</p>
                </div>

                {/* Significant Findings */}
                {(summary as ClinicalSummaryResponse).significant_findings.length > 0 && (
                  <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                    <div className="bg-gray-50 px-4 py-3 border-b">
                      <h4 className="font-semibold text-gray-900">Significant Findings</h4>
                    </div>
                    <div className="divide-y">
                      {(summary as ClinicalSummaryResponse).significant_findings.map((finding, idx) => (
                        <div key={idx} className="p-4">
                          <div className="flex items-start justify-between">
                            <div className="flex-1">
                              <p className="font-medium text-gray-900">{finding.finding}</p>
                              <p className="text-sm text-gray-600 mt-1">{finding.clinical_significance}</p>
                            </div>
                            <span className="text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded-full ml-3">
                              {finding.test_group}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Clinical Interpretation */}
                <div className="bg-purple-50 rounded-xl p-4 border border-purple-200">
                  <h4 className="font-semibold text-purple-900 mb-2">Clinical Interpretation</h4>
                  <p className="text-gray-800 whitespace-pre-wrap">{(summary as ClinicalSummaryResponse).clinical_interpretation}</p>
                </div>

                {/* Urgent Findings */}
                {(summary as ClinicalSummaryResponse).urgent_findings.length > 0 && (
                  <div className="bg-red-50 rounded-xl p-4 border border-red-200">
                    <h4 className="font-semibold text-red-900 mb-3 flex items-center">
                      <AlertCircle className="h-5 w-5 mr-2" />
                      Urgent Findings
                    </h4>
                    <ul className="space-y-2">
                      {(summary as ClinicalSummaryResponse).urgent_findings.map((finding, idx) => (
                        <li key={idx} className="flex items-start text-red-800 font-medium">
                          <span className="inline-block w-2 h-2 bg-red-500 rounded-full mt-2 mr-3 flex-shrink-0" />
                          {finding}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Suggested Follow-up */}
                {(summary as ClinicalSummaryResponse).suggested_followup.length > 0 && (
                  <div className="bg-green-50 rounded-xl p-4 border border-green-200">
                    <h4 className="font-semibold text-green-900 mb-3">Suggested Follow-up</h4>
                    <ul className="space-y-2">
                      {(summary as ClinicalSummaryResponse).suggested_followup.map((item, idx) => (
                        <li key={idx} className="flex items-start text-gray-800">
                          <span className="inline-block w-2 h-2 bg-green-500 rounded-full mt-2 mr-3 flex-shrink-0" />
                          {item}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Footer with Copy Button */}
          <div className="border-t bg-gray-50 px-6 py-4 flex items-center justify-between">
            <p className="text-sm text-gray-600">
              {isVerifier ? (
                <>
                  <ClipboardList className="h-4 w-4 inline mr-1 text-purple-500" />
                  AI-generated verification summary for internal review
                </>
              ) : (
                <>
                  <Stethoscope className="h-4 w-4 inline mr-1 text-cyan-500" />
                  AI-generated clinical summary for referring physician
                </>
              )}
            </p>
            <div className="flex items-center gap-3">
              <button
                onClick={() => {
                  setShowAiSummaryModal(false);
                  setAiSummaryTarget(null);
                }}
                className="px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors font-medium"
              >
                Close
              </button>
              <button
                onClick={() => {
                  // Format summary for clipboard
                  let text = '';
                  if (isVerifier && 'overall_assessment' in summary) {
                    const vs = summary as VerifierSummaryResponse;
                    text = `VERIFIER SUMMARY\n\n`;
                    text += `Overall Assessment:\n${vs.overall_assessment}\n\n`;
                    text += `Recommendation: ${vs.recommendation.replace('_', ' ').toUpperCase()}\n`;
                    text += `Reason: ${vs.recommendation_reason}\n\n`;
                    if (vs.abnormal_findings.length > 0) {
                      text += `Abnormal Findings:\n${vs.abnormal_findings.map(f => `• ${f}`).join('\n')}\n\n`;
                    }
                    if (vs.critical_alerts.length > 0) {
                      text += `Critical Alerts:\n${vs.critical_alerts.map(a => `• ${a}`).join('\n')}\n\n`;
                    }
                    if (vs.verifier_notes) {
                      text += `Notes: ${vs.verifier_notes}\n`;
                    }
                  } else {
                    const cs = summary as ClinicalSummaryResponse;
                    text = `CLINICAL SUMMARY FOR REFERRING PHYSICIAN\n\n`;
                    text += `Executive Summary:\n${cs.executive_summary}\n\n`;
                    text += `Clinical Interpretation:\n${cs.clinical_interpretation}\n\n`;
                    if (cs.significant_findings.length > 0) {
                      text += `Significant Findings:\n${cs.significant_findings.map(f => `• ${f.finding} (${f.test_group})\n  Clinical Significance: ${f.clinical_significance}`).join('\n')}\n\n`;
                    }
                    if (cs.urgent_findings.length > 0) {
                      text += `URGENT FINDINGS:\n${cs.urgent_findings.map(f => `⚠️ ${f}`).join('\n')}\n\n`;
                    }
                    if (cs.suggested_followup.length > 0) {
                      text += `Suggested Follow-up:\n${cs.suggested_followup.map(s => `• ${s}`).join('\n')}\n`;
                    }
                  }
                  navigator.clipboard.writeText(text).then(() => {
                    alert('Summary copied to clipboard!');
                  }).catch(() => {
                    alert('Failed to copy to clipboard');
                  });
                }}
                className="inline-flex items-center px-6 py-2 bg-gradient-to-r from-blue-600 to-indigo-600 text-white rounded-lg hover:from-blue-700 hover:to-indigo-700 transition-all duration-200 shadow-sm font-semibold"
              >
                <FileText className="h-5 w-5 mr-2" />
                Copy to Clipboard
              </button>
            </div>
          </div>
        </div>
      </div>,
      document.body
    );
  };

  /* ----------------- AI Delta Check Modal Component ----------------- */
  const AIDeltaCheckModal: React.FC = () => {
    if (!showDeltaCheckModal || !deltaCheckTargetResultId) return null;

    // Get Delta Check results
    const deltaCheck = aiDeltaCheckResults[deltaCheckTargetResultId];

    if (!deltaCheck) return null;

    // Helper to get severity color
    const getSeverityColor = (severity: string) => {
      switch (severity) {
        case 'critical': return 'bg-red-100 text-red-800 border-red-300';
        case 'warning': return 'bg-yellow-100 text-yellow-800 border-yellow-300';
        case 'info': return 'bg-blue-100 text-blue-800 border-blue-300';
        default: return 'bg-gray-100 text-gray-800 border-gray-300';
      }
    };

    const getSeverityIcon = (severity: string) => {
      switch (severity) {
        case 'critical': return <XCircle className="h-5 w-5 text-red-600" />;
        case 'warning': return <AlertTriangle className="h-5 w-5 text-yellow-600" />;
        case 'info': return <AlertCircle className="h-5 w-5 text-blue-600" />;
        default: return <AlertCircle className="h-5 w-5 text-gray-600" />;
      }
    };

    const getIssueTypeLabel = (type: string) => {
      switch (type) {
        case 'input_error': return 'Possible Input Error';
        case 'sample_issue': return 'Sample Issue';
        case 'conflicting_result': return 'Conflicting Results';
        case 'unusual_change': return 'Unusual Change';
        case 'quality_concern': return 'Quality Concern';
        default: return type;
      }
    };

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
        case 'approve': return 'bg-green-100 text-green-800 border-green-300';
        case 'review_required': return 'bg-yellow-100 text-yellow-800 border-yellow-300';
        case 'reject': return 'bg-red-100 text-red-800 border-red-300';
        default: return 'bg-gray-100 text-gray-800 border-gray-300';
      }
    };

    return ReactDOM.createPortal(
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
        <div className="bg-white rounded-2xl shadow-2xl max-w-5xl w-full max-h-[90vh] overflow-hidden">
          {/* Header */}
          <div className="bg-gradient-to-r from-amber-500 to-orange-500 px-6 py-4 flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <Zap className="h-6 w-6 text-white" />
              <h3 className="text-xl font-bold text-white">
                AI Delta Check Results
              </h3>
              <span className={`px-3 py-1 rounded-full text-sm font-semibold bg-gradient-to-r ${getConfidenceColor(deltaCheck.confidence_level)} text-white`}>
                {deltaCheck.confidence_score}% Confidence
              </span>
            </div>
            <button
              onClick={() => {
                setShowDeltaCheckModal(false);
                setDeltaCheckTargetResultId(null);
              }}
              className="text-white hover:bg-white hover:bg-opacity-20 rounded-full p-2 transition-colors"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="p-6 overflow-y-auto max-h-[calc(90vh-160px)]">
            {/* Summary Section */}
            <div className="mb-6">
              <div className="flex items-start gap-4 p-4 bg-gray-50 rounded-xl border border-gray-200">
                <div className={`flex-shrink-0 p-3 rounded-full ${deltaCheck.confidence_level === 'high' ? 'bg-green-100' : deltaCheck.confidence_level === 'medium' ? 'bg-yellow-100' : 'bg-red-100'}`}>
                  {deltaCheck.confidence_level === 'high' ? (
                    <CheckCircle2 className="h-8 w-8 text-green-600" />
                  ) : deltaCheck.confidence_level === 'medium' ? (
                    <AlertTriangle className="h-8 w-8 text-yellow-600" />
                  ) : (
                    <XCircle className="h-8 w-8 text-red-600" />
                  )}
                </div>
                <div className="flex-1">
                  <h4 className="font-bold text-gray-900 text-lg mb-1">Summary</h4>
                  <p className="text-gray-700">{deltaCheck.summary}</p>
                  <div className="mt-3 flex items-center gap-3">
                    <span className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-semibold border ${getRecommendationColor(deltaCheck.recommendation)}`}>
                      Recommendation: {deltaCheck.recommendation.replace('_', ' ').toUpperCase()}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Issues Section */}
            {deltaCheck.issues.length > 0 && (
              <div className="mb-6">
                <h4 className="font-bold text-gray-900 text-lg mb-3 flex items-center">
                  <AlertTriangle className="h-5 w-5 mr-2 text-amber-600" />
                  Issues Identified ({deltaCheck.issues.length})
                </h4>
                <div className="space-y-3">
                  {deltaCheck.issues.map((issue, idx) => (
                    <div key={idx} className={`rounded-xl p-4 border ${getSeverityColor(issue.severity)}`}>
                      <div className="flex items-start gap-3">
                        {getSeverityIcon(issue.severity)}
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="font-bold text-gray-900">{getIssueTypeLabel(issue.issue_type)}</span>
                            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${issue.severity === 'critical' ? 'bg-red-200 text-red-800' : issue.severity === 'warning' ? 'bg-yellow-200 text-yellow-800' : 'bg-blue-200 text-blue-800'}`}>
                              {issue.severity.toUpperCase()}
                            </span>
                          </div>
                          <p className="text-sm text-gray-700 mb-2">{issue.description}</p>
                          <div className="flex flex-wrap gap-1 mb-2">
                            {issue.affected_analytes.map((analyte, i) => (
                              <span key={i} className="text-xs bg-white bg-opacity-60 px-2 py-0.5 rounded border">
                                {analyte}
                              </span>
                            ))}
                          </div>
                          <div className="grid md:grid-cols-2 gap-3 mt-3">
                            <div className="bg-white bg-opacity-50 rounded-lg p-3">
                              <div className="text-xs font-semibold text-gray-500 uppercase mb-1">Evidence</div>
                              <p className="text-sm text-gray-700">{issue.evidence}</p>
                            </div>
                            <div className="bg-white bg-opacity-50 rounded-lg p-3">
                              <div className="text-xs font-semibold text-gray-500 uppercase mb-1">Suggested Action</div>
                              <p className="text-sm text-gray-700">{issue.suggested_action}</p>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Validated Results */}
            {deltaCheck.validated_results.length > 0 && (
              <div className="mb-6">
                <h4 className="font-bold text-gray-900 text-lg mb-3 flex items-center">
                  <CheckCircle2 className="h-5 w-5 mr-2 text-green-600" />
                  Validated Results ({deltaCheck.validated_results.length})
                </h4>
                <div className="flex flex-wrap gap-2">
                  {deltaCheck.validated_results.map((result, idx) => (
                    <span key={idx} className="inline-flex items-center px-3 py-1 bg-green-50 text-green-800 rounded-full text-sm border border-green-200">
                      <CheckCircle2 className="h-4 w-4 mr-1" />
                      {result}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Verifier Notes */}
            {deltaCheck.verifier_notes && (
              <div className="bg-blue-50 rounded-xl p-4 border border-blue-200">
                <h4 className="font-bold text-blue-900 text-lg mb-2 flex items-center">
                  <FileText className="h-5 w-5 mr-2" />
                  Verifier Notes
                </h4>
                <p className="text-sm text-blue-800 whitespace-pre-wrap">{deltaCheck.verifier_notes}</p>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="border-t bg-gray-50 px-4 sm:px-6 py-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-gray-600">
              <AlertCircle className="h-4 w-4 inline mr-1 text-amber-500" />
              Review the delta check findings before proceeding with verification.
            </p>
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
              <button
                onClick={() => {
                  setShowDeltaCheckModal(false);
                  setDeltaCheckTargetResultId(null);
                }}
                className="px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors font-medium"
              >
                Close
              </button>
              <button
                onClick={() => {
                  // Copy delta check results to clipboard
                  const text = `DELTA CHECK RESULTS\n\nConfidence: ${deltaCheck.confidence_score}% (${deltaCheck.confidence_level})\nRecommendation: ${deltaCheck.recommendation}\n\nSummary:\n${deltaCheck.summary}\n\n${deltaCheck.issues.length > 0 ? `Issues (${deltaCheck.issues.length}):\n${deltaCheck.issues.map(i => `• [${i.severity.toUpperCase()}] ${i.issue_type}: ${i.description}`).join('\n')}\n\n` : ''}Validated: ${deltaCheck.validated_results.join(', ')}\n\nNotes:\n${deltaCheck.verifier_notes}`;
                  navigator.clipboard.writeText(text).then(() => {
                    alert('Delta check results copied to clipboard!');
                  });
                }}
                className="inline-flex items-center justify-center px-6 py-2 bg-gradient-to-r from-blue-600 to-indigo-600 text-white rounded-lg hover:from-blue-700 hover:to-indigo-700 transition-all duration-200 shadow-sm font-semibold"
              >
                <FileText className="h-5 w-5 mr-2" />
                Copy to Clipboard
              </button>
            </div>
          </div>
        </div>
      </div>,
      document.body
    );
  };

  if (viewMode === "order") {
    return <OrderVerificationView onBackToPanel={() => setViewMode("panel")} />;
  }

  /* ----------------- Render ----------------- */
  const showBulkApprovalStatus = selectedPanels.size > 0 || !!bulkApprovalProgress;
  const bulkApprovalStatusLabel = bulkApprovalProgress
    ? bulkApprovalProgress.status === "running"
      ? `Approving ${bulkApprovalProgress.attempted}/${bulkApprovalProgress.total}`
      : `Approved ${bulkApprovalProgress.approved}/${bulkApprovalProgress.total}`
    : "Ready for bulk verification operations";
  const bulkApprovalHasIssues = !!bulkApprovalProgress && (bulkApprovalProgress.failed > 0 || bulkApprovalProgress.skipped > 0);

  return (
    <div className="bg-gradient-to-br from-gray-50 to-blue-50">
      {/* Modern Header */}
      <div className="bg-white shadow-sm border-b">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
          <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4 sm:gap-6">
            <div>
              <h1 className="text-2xl sm:text-4xl font-bold text-gray-900 mb-2">
                Result Verification Console
              </h1>
              <p className="text-sm sm:text-lg text-gray-600">
                High-performance analyte verification with intelligent workflows
              </p>
              <div className="flex flex-wrap items-center gap-2 sm:gap-4 mt-3">
                <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-blue-100 text-blue-800">
                  <Activity className="h-4 w-4 mr-2" />
                  Real-time Processing
                </span>
                <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-purple-100 text-purple-800">
                  <Target className="h-4 w-4 mr-2" />
                  Batch Operations
                </span>
              </div>
            </div>

            <div className="flex flex-col gap-3 w-full lg:w-auto sm:flex-row sm:items-center sm:gap-4">
              <div className="flex items-center bg-gray-100 rounded-full p-1 w-full sm:w-auto">
                <button
                  onClick={() => setViewMode("panel")}
                  className={`flex-1 sm:flex-none px-4 py-2 text-sm font-semibold rounded-full transition-colors ${viewMode === "panel" ? "bg-white shadow text-blue-600" : "text-gray-600"}`}
                >
                  Panel View
                </button>
                <button
                  onClick={() => setViewMode("order")}
                  className={`flex-1 sm:flex-none px-4 py-2 text-sm font-semibold rounded-full transition-colors ${viewMode === "order" ? "bg-white shadow text-blue-600" : "text-gray-600"}`}
                >
                  Order View
                </button>
              </div>
              <button
                onClick={loadPanels}
                className="inline-flex items-center justify-center px-4 py-3 bg-white border-2 border-gray-300 rounded-xl hover:border-gray-400 hover:shadow-md transition-all duration-200 font-semibold w-full sm:w-auto"
                title="Refresh data"
              >
                <RefreshCcw className={`h-5 w-5 mr-2 ${loading ? "animate-spin text-blue-600" : "text-gray-600"}`} />
                Refresh
              </button>

              {selectedPanels.size > 0 && (
                <button
                  onClick={bulkApproveSelected}
                  disabled={bulkProcessing}
                  className="inline-flex items-center justify-center px-5 py-3 bg-gradient-to-r from-green-600 to-emerald-600 text-white rounded-xl hover:from-green-700 hover:to-emerald-700 transition-all duration-200 shadow-lg font-semibold disabled:opacity-50 w-full sm:w-auto"
                >
                  {bulkProcessing ? (
                    <Loader2 className="h-5 w-5 mr-2 animate-spin" />
                  ) : (
                    <Zap className="h-5 w-5 mr-2" />
                  )}
                  {bulkProcessing && bulkApprovalProgress
                    ? `Approving ${bulkApprovalProgress.attempted}/${bulkApprovalProgress.total}`
                    : `Bulk Approve (${selectedPanels.size})`}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-6 sm:space-y-8">
        {/* Statistics Dashboard */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
          <StatsBadge
            icon={BarChart3}
            label="Total Panels"
            value={stats.total}
            color="text-blue-600"
            bgColor="bg-gradient-to-br from-blue-50 to-indigo-100"
            onClick={() => setStateFilter('all')}
          />
          <StatsBadge
            icon={CheckCircle2}
            label="Verified"
            value={stats.ready}
            color="text-green-600"
            bgColor="bg-gradient-to-br from-green-50 to-emerald-100"
            onClick={() => setStateFilter('ready')}
          />
          <StatsBadge
            icon={Clock}
            label="Partial"
            value={stats.partial}
            color="text-amber-600"
            bgColor="bg-gradient-to-br from-amber-50 to-orange-100"
            onClick={() => setStateFilter('partial')}
          />
          <StatsBadge
            icon={AlertTriangle}
            label="Pending"
            value={stats.pending}
            color="text-red-600"
            bgColor="bg-gradient-to-br from-red-50 to-rose-100"
            onClick={() => setStateFilter('pending')}
          />
        </div>

        {/* Enhanced Filters */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
          <div className="p-4 sm:p-6 border-b border-gray-100">
            <div className="flex flex-col lg:flex-row gap-3 sm:gap-4">
              {/* Search Bar */}
              <div className="flex-1 relative">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400" />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
	                  placeholder="Search patients, tests, sample IDs, or order IDs..."
                  className="w-full pl-12 pr-4 py-3 sm:py-4 text-base sm:text-lg border-2 border-gray-200 rounded-xl focus:border-blue-500 focus:ring-4 focus:ring-blue-100 transition-all duration-200"
                />
                {q && (
                  <button
                    onClick={() => setQ('')}
                    className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  >
                    <X className="h-5 w-5" />
                  </button>
                )}
              </div>

              {/* Quick Filters */}
              <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                <select
                  value={stateFilter}
                  onChange={(e) => setStateFilter(e.target.value as StateFilter)}
                  className="px-4 py-3 sm:py-4 border-2 border-gray-200 rounded-xl focus:border-blue-500 focus:ring-4 focus:ring-blue-100 text-base sm:text-lg font-medium"
                >
                  <option value="all">All Status</option>
                  <option value="pending">Pending Only</option>
                  <option value="partial">Partial Only</option>
                  <option value="ready">Verified Only</option>
                </select>

	                <button
	                  onClick={() => setShowAdvancedFilters(!showAdvancedFilters)}
	                  className={`inline-flex items-center justify-center px-4 py-3 sm:py-4 border-2 rounded-xl transition-all duration-200 font-semibold ${showAdvancedFilters
	                    ? 'bg-blue-100 border-blue-300 text-blue-700'
                    : 'border-gray-300 text-gray-700 hover:border-gray-400 hover:bg-gray-50'
                    }`}
                >
                  <FilterIcon className="h-5 w-5 mr-2" />
                  Advanced
                  {showAdvancedFilters ? (
                    <ChevronUp className="h-4 w-4 ml-2" />
                  ) : (
	                    <ChevronDown className="h-4 w-4 ml-2" />
	                  )}
	                </button>
	                <button
	                  onClick={selectAllPanels}
	                  disabled={filteredPanels.length === 0 || allFilteredPanelsSelected}
	                  className="inline-flex items-center justify-center px-4 py-3 sm:py-4 border-2 border-blue-200 text-blue-700 rounded-xl hover:bg-blue-50 hover:border-blue-300 transition-all duration-200 font-semibold disabled:cursor-not-allowed disabled:opacity-60"
	                >
	                  <CheckSquare className="h-5 w-5 mr-2" />
	                  {allFilteredPanelsSelected ? 'All Selected' : `Select All (${filteredPanels.length})`}
	                </button>
	              </div>
	            </div>

            {/* Advanced Filters Panel */}
            {showAdvancedFilters && (
              <div className="mt-6 pt-6 border-t border-gray-100">
	                <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-6">
                  <div>
                    <label className="block text-sm font-semibold text-gray-700 mb-3">Date Range</label>
                    <div className="space-y-3">
                      <div className="flex items-center space-x-2">
                        <Calendar className="h-4 w-4 text-gray-500" />
                        <input
                          type="date"
                          value={from}
                          onChange={(e) => setFrom(e.target.value)}
                          className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                        />
                      </div>
                      <div className="text-center text-gray-500 text-sm">to</div>
                      <div className="flex items-center space-x-2">
                        <Calendar className="h-4 w-4 text-gray-500" />
                        <input
                          type="date"
                          value={to}
                          onChange={(e) => setTo(e.target.value)}
                          className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                        />
                      </div>
                    </div>
                  </div>

	                  <div>
	                    <label className="block text-sm font-semibold text-gray-700 mb-3">Quick Presets</label>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        onClick={setToday}
                        className="px-3 py-2 text-sm bg-blue-100 text-blue-700 rounded-lg hover:bg-blue-200 transition-colors font-medium"
                      >
                        Today
                      </button>
                      <button
                        onClick={() => setDateRange(7)}
                        className="px-3 py-2 text-sm bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors font-medium"
                      >
                        7 Days
                      </button>
                      <button
                        onClick={() => setDateRange(30)}
                        className="px-3 py-2 text-sm bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors font-medium"
                      >
                        30 Days
                      </button>
                      <button
                        onClick={() => setDateRange(90)}
                        className="px-3 py-2 text-sm bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors font-medium"
                      >
                        90 Days
                      </button>
                    </div>
	                  </div>

                  <div>
                    <label className="block text-sm font-semibold text-gray-700 mb-3">Ref Doctor</label>
                    <select
                      value={doctorFilter}
                      onChange={(e) => setDoctorFilter(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    >
                      <option value="all">All Doctors</option>
                      {doctorOptions.map(doctor => (
                        <option key={doctor} value={doctor}>{doctor}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm font-semibold text-gray-700 mb-3">B2B Client</label>
                    <select
                      value={accountFilter}
                      onChange={(e) => setAccountFilter(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    >
                      <option value="all">All B2B Clients</option>
                      {accountOptions.map(account => (
                        <option key={account} value={account}>{account}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm font-semibold text-gray-700 mb-3">Sort By</label>
                    <select
                      value={panelSortMode}
                      onChange={(e) => setPanelSortMode(e.target.value as PanelSortMode)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                    >
                      <option value="sample_desc">Sample ID newest first</option>
                      <option value="sample_asc">Sample ID oldest first</option>
                      <option value="date_desc">Order date newest first</option>
                      <option value="patient_az">Patient A-Z</option>
                    </select>
                  </div>

	                  <div>
                    <label className="block text-sm font-semibold text-gray-700 mb-3">Bulk Actions</label>
                    <div className="space-y-2">
	                      <button
	                        onClick={selectAllPanels}
	                        disabled={filteredPanels.length === 0 || bulkProcessing}
	                        className="w-full px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium disabled:opacity-50"
	                      >
                        Select All ({filteredPanels.length})
                      </button>
	                      <button
	                        onClick={clearSelection}
	                        disabled={(selectedPanels.size === 0 && !bulkApprovalProgress) || bulkProcessing}
	                        className="w-full px-4 py-2 text-sm border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors font-medium disabled:opacity-50"
	                      >
                        Clear Selection
                      </button>
                      <button
                        onClick={() => {
                          if (selectedPanels.size === 1) {
                            const resultId = Array.from(selectedPanels)[0];
                            const panel = panels.find(p => p.result_id === resultId);
                            if (panel) {
                              setSelectedOrderForAttachments(panel.order_id);
                              setShowAttachmentSelector(true);
                            }
                          } else {
                            alert('Please select exactly one panel to manage attachments');
                          }
                        }}
                        disabled={selectedPanels.size !== 1}
                        className="w-full px-4 py-2 text-sm border-2 border-purple-300 bg-purple-50 text-purple-700 rounded-lg hover:bg-purple-100 hover:border-purple-400 transition-colors font-medium disabled:opacity-50 flex items-center justify-center gap-2"
                      >
                        <FileImage className="h-4 w-4" />
                        Manage Report Attachments
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Selection Summary */}
        {showBulkApprovalStatus && (
          <div className="bg-gradient-to-r from-blue-600 to-indigo-600 rounded-2xl p-4 sm:p-6 text-white shadow-lg">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3">
                <div className="bg-white/20 p-3 rounded-xl">
                  {bulkProcessing ? (
                    <Loader2 className="h-6 w-6 animate-spin" />
                  ) : bulkApprovalProgress && !bulkApprovalHasIssues ? (
                    <CheckCircle2 className="h-6 w-6" />
                  ) : bulkApprovalHasIssues ? (
                    <AlertTriangle className="h-6 w-6" />
                  ) : (
                    <CheckSquare className="h-6 w-6" />
                  )}
                </div>
                <div className="space-y-2">
                  <div className="text-lg sm:text-xl font-bold">
                    {selectedPanels.size > 0
                      ? `${selectedPanels.size} panel${selectedPanels.size !== 1 ? 's' : ''} selected`
                      : `Bulk approval ${bulkApprovalHasIssues ? 'completed with issues' : 'complete'}`}
                  </div>
                  <div className="text-blue-100 text-sm sm:text-base">
                    {bulkApprovalStatusLabel}
                  </div>
                  {bulkApprovalProgress && (
                    <div className="flex flex-wrap gap-2 text-xs sm:text-sm">
                      <span className="rounded-full bg-white/20 px-3 py-1">
                        Attempted {bulkApprovalProgress.attempted}/{bulkApprovalProgress.total}
                      </span>
                      <span className="rounded-full bg-emerald-400/25 px-3 py-1">
                        Approved {bulkApprovalProgress.approved}
                      </span>
                      {bulkApprovalProgress.failed > 0 && (
                        <span className="rounded-full bg-red-400/25 px-3 py-1">
                          Failed {bulkApprovalProgress.failed}
                        </span>
                      )}
                      {bulkApprovalProgress.skipped > 0 && (
                        <span className="rounded-full bg-amber-400/25 px-3 py-1">
                          Skipped {bulkApprovalProgress.skipped}
                        </span>
                      )}
                    </div>
                  )}
                  {bulkApprovalProgress && bulkApprovalProgress.total > 0 && (
                    <div className="h-2 max-w-xl overflow-hidden rounded-full bg-white/20">
                      <div
                        className="h-full rounded-full bg-white transition-all duration-300"
                        style={{ width: `${Math.round(((bulkApprovalProgress.attempted + bulkApprovalProgress.skipped) / bulkApprovalProgress.total) * 100)}%` }}
                      />
                    </div>
                  )}
                </div>
              </div>
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
                <button
                  onClick={clearSelection}
                  disabled={bulkProcessing}
                  className="px-4 py-2 bg-white/20 text-white rounded-lg hover:bg-white/30 transition-colors font-medium disabled:opacity-50"
                >
                  Clear
                </button>
                {selectedPanels.size > 0 && (
                  <button
                    onClick={bulkApproveSelected}
                    disabled={bulkProcessing}
                    className="inline-flex items-center justify-center px-6 py-3 bg-white text-blue-600 rounded-xl hover:bg-gray-50 transition-colors font-bold shadow-sm disabled:opacity-50"
                  >
                    {bulkProcessing ? (
                      <Loader2 className="h-5 w-5 mr-2 animate-spin inline" />
                    ) : (
                      <Zap className="h-5 w-5 mr-2 inline" />
                    )}
                    {bulkProcessing && bulkApprovalProgress
                      ? `Approving ${bulkApprovalProgress.attempted}/${bulkApprovalProgress.total}`
                      : "Approve Selected"}
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Error Display */}
        {err && (
          <div className="bg-red-50 border-2 border-red-200 rounded-2xl p-6">
            <div className="flex items-center">
              <AlertTriangle className="h-6 w-6 text-red-600 mr-3" />
              <div>
                <h3 className="text-lg font-semibold text-red-900">Error Loading Data</h3>
                <p className="text-red-700">{err}</p>
              </div>
            </div>
          </div>
        )}

        {/* Loading State */}
        {loading && (
          <div className="space-y-6">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="bg-white rounded-2xl border border-gray-200 p-6 animate-pulse">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center space-x-4">
                    <div className="w-12 h-12 bg-gray-200 rounded-xl"></div>
                    <div className="space-y-2">
                      <div className="h-6 bg-gray-200 rounded w-48"></div>
                      <div className="h-4 bg-gray-200 rounded w-32"></div>
                    </div>
                  </div>
                  <div className="h-8 w-24 bg-gray-200 rounded-full"></div>
                </div>
                <div className="h-4 bg-gray-200 rounded w-full"></div>
              </div>
            ))}
          </div>
        )}

        {/* Empty State */}
        {!loading && filteredPanels.length === 0 && (
          <div className="bg-white rounded-2xl border-2 border-dashed border-gray-300 p-12 text-center">
            <div className="mx-auto w-24 h-24 bg-gray-100 rounded-full flex items-center justify-center mb-6">
              <TestTube className="w-12 h-12 text-gray-400" />
            </div>
            <h3 className="text-2xl font-bold text-gray-900 mb-3">No Results Found</h3>
            <p className="text-gray-600 mb-6 max-w-md mx-auto text-lg">
              No verification results match your current filters for the selected date range.
            </p>
            <div className="flex justify-center space-x-4">
              <button
                onClick={() => {
                  setQ('');
                  setStateFilter('all');
                  setShowAdvancedFilters(false);
                }}
                className="px-6 py-3 bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition-colors font-semibold"
              >
                Clear All Filters
              </button>
              <button
                onClick={loadPanels}
                className="px-6 py-3 border-2 border-gray-300 text-gray-700 rounded-xl hover:border-gray-400 hover:bg-gray-50 transition-colors font-semibold"
              >
                Refresh Data
              </button>
            </div>
          </div>
        )}

        {/* Results Grid */}
        {!loading && filteredPanels.length > 0 && (
          <div className="space-y-6">
            {/* Results Header */}
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-2xl font-bold text-gray-900">
                  Verification Queue
                </h2>
                <p className="text-gray-600 mt-1">
                  {filteredPanels.length} panel{filteredPanels.length !== 1 ? 's' : ''} found
                </p>
              </div>

              {selectedPanels.size === 0 && (
                <div className="flex items-center space-x-2 text-sm text-gray-500">
                  <span>Select panels for bulk operations</span>
                  <ChevronRight className="h-4 w-4" />
                </div>
              )}
            </div>

            {/* Panel Cards */}
            <div className="space-y-6">
              {filteredPanels.map((row) => (
                <React.Fragment key={row.result_id}>{renderPanelCard(row)}</React.Fragment>
              ))}
            </div>
          </div>
        )}

        {/* Modern Footer */}
        <div className="bg-gradient-to-r from-gray-900 to-gray-800 rounded-2xl p-6 text-white shadow-xl">
          <div className="flex flex-col md:flex-row items-center justify-between gap-4">
            <div className="flex items-center space-x-6">
              <div className="flex items-center">
                <TrendingUp className="h-5 w-5 mr-2 text-blue-400" />
                <span className="font-semibold">
                  Performance: {stats.ready > 0 ? Math.round((stats.ready / stats.total) * 100) : 0}% verified
                </span>
              </div>
              <div className="flex items-center">
                <Clock className="h-5 w-5 mr-2 text-green-400" />
                <span className="font-semibold">
                  Date Range: {fmtDate(from)} - {fmtDate(to)}
                </span>
              </div>
            </div>
            <div className="text-sm text-gray-300">
              Last updated: {new Date().toLocaleTimeString()}
            </div>
          </div>
        </div>
      </div>

      {/* Trend Modal */}
      <TrendModal />

      {/* AI Summary Modal */}
      <AISummaryModal />

      {/* AI Delta Check Modal */}
      <AIDeltaCheckModal />

      {/* Attachment Selector Modal */}
      {showAttachmentSelector && selectedOrderForAttachments && (
        <AttachmentSelector
          orderId={selectedOrderForAttachments}
          onClose={() => {
            setShowAttachmentSelector(false);
            setSelectedOrderForAttachments(null);
          }}
          onSave={() => {
            // Reload attachments after save
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
    </div>
  );
};

export default ResultVerificationConsole;
