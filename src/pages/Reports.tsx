import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { supabase, database, formatAge } from '../utils/supabase';
import { useMobileOptimizations } from '../utils/platformHelper';
import { MobileFAB } from '../components/ui/MobileFAB';
import {
  FileText,
  Download,
  Eye,
  Search,
  RefreshCw,
  Filter,
  X,
  Calendar,
  User,
  TestTube,
  AlertTriangle,
  TrendingUp,
  Clock,
  CheckCircle,
  FileCheck,
  XCircle,
  Loader2,
  SortAsc,
  SortDesc,
  Wand2,
  Printer,
  Settings,
  Trash2,
  FileCode,
  Sparkles,
  Send
} from 'lucide-react';
import {
  format,
  isValid,
} from 'date-fns';
import { getCalendarDateRange, parseLocalDateString, toLocalDateString, type CalendarDateFilter } from '../utils/dateRangeFilters';
import {
  viewPDFReport,
  generateTemplatePreviewPDF,
  createReportDataFromContext,
  selectTemplateForContext,
} from '../utils/pdfService';
import {
  autoAssignCompactPages,
  buildCompactGroupDefinitions,
  getCompactPlannerSuggestion,
} from '../utils/compactPrintPdf';
import { convertToCustomDomain } from '../utils/storageUrlBuilder';
import type { LabTemplateRecord, ReportData, LabBrandingHtmlDefaults } from '../utils/pdfService';
import PDFProgressModal from '../components/PDFProgressModal';
import { usePDFGeneration, isOrderReportReady } from '../hooks/usePDFGeneration';
import { buildReportLinkUrl } from '../utils/reportLink';
import QuickSendReport from '../components/WhatsApp/QuickSendReport';
import PDFSettingsModal, {
  PDFRenderSettings,
  settingsToPdfCoOptions,
  loadSavedPDFSettings,
  PDF_PRESETS
} from '../components/PDF/PDFSettingsModal';
import ReportDesignStudio from '../components/ReportStudio/ReportDesignStudio';
import { SendReportModal } from '../components/Dashboard/SendReportModal';
import { ReportPreviewModal } from '../components/Reports/ReportPreviewModal';

// Helper function to safely format dates
const safeFormatDate = (dateValue: string | null | undefined, formatString: string = 'MMM d, yyyy'): string => {
  if (!dateValue) return 'N/A';

  const date = new Date(dateValue);
  if (!isValid(date)) return 'Invalid Date';

  return format(date, formatString);
};

type DateFilter = CalendarDateFilter;
type SortField = 'sample_id' | 'patient_name' | 'order_date' | 'verified_at' | 'test_name';
type SortDirection = 'asc' | 'desc';

// Matches the Result Verification console's default ("Sample ID newest first"),
// so today's samples read 3 -> 2 -> 1 on both screens.
const DEFAULT_REPORT_SORT: { field: SortField; direction: SortDirection } = {
  field: 'sample_id',
  direction: 'desc',
};

interface ApprovedResult {
  result_id: string;
  order_id: string;
  patient_id: string;
  patient_name: string;
  test_name: string;
  status: string;
  verification_status: string;
  verified_by: string;
  verified_at: string;
  review_comment: string;
  entered_by: string;
  entered_date: string;
  reviewed_by: string;
  reviewed_date: string;
  sample_id: string;
  order_date: string;
  doctor: string;
  account_id?: string | null;
  account_name?: string | null;
  order_number?: number | null;
  patient_full_name: string;
  age: number;
  gender: string;
  phone: string;
  attachment_id?: string;
  attachment_url?: string;
  attachment_type?: string;
  attachment_name?: string;
  has_report?: boolean;
  report_status?: string;
  report_generated_at?: string;
  is_report_ready?: boolean;
  has_draft_report?: boolean;
  has_final_report?: boolean;
  has_print_pdf?: boolean;
  has_compact_ecopy?: boolean;
  draft_report?: any;
  final_report?: any;
  print_pdf_url?: string;
  print_pdf_generated_at?: string;
  compact_ecopy_url?: string;
  compact_ecopy_generated_at?: string;
  printed_at?: string | null;
  printed_by?: string | null;
  print_count?: number;
  ordered_test_names?: string[];
  // Smart Report fields
  smart_report_url?: string;
  smart_report_generated_at?: string;
}

interface OrderGroup {
  order_id: string;
  patient_id: string;
  patient_full_name: string;
  age: number;
  gender: string;
  order_date: string;
  sample_ids: string[];
  account_names: string[];
  order_numbers: number[];
  verified_at: string;
  verified_by: string;
  test_names: string[];
  results: ApprovedResult[];
  is_report_ready?: boolean;
}

interface OrderReportSettings {
  groupOrderOverrideEnabled?: boolean;
  groupOrderManualOverride?: boolean;
  groupOrder?: string[];
  printLayoutMode?: 'standard' | 'compact';
  compactPageAssignments?: Record<string, number>;
  compactPageAssignmentsManualOverride?: boolean;
  compactMaxClubbedAnalytes?: number;
}

interface OrderSettingsGroupItem {
  testGroupId: string;
  testName: string;
  reportPriority: number | null;
  printOrder: number;
  analyteCount: number;
  pageNumber: number;
  createdAt?: string | null;
}

type PreparedReport = ReportData;

const getActiveReportPriority = (priority: number | null | undefined): number => {
  return priority != null && priority > 0 ? priority : Number.MAX_SAFE_INTEGER;
};

const APPROVED_RESULTS_PAGE_SIZE = 1000;
const RELATED_LOOKUP_BATCH_SIZE = 500;

const chunkArray = <T,>(items: T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
};

const Reports: React.FC = () => {
  const [approvedResults, setApprovedResults] = useState<ApprovedResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedStatus, setSelectedStatus] = useState<'all' | 'ready' | 'pending' | 'processing'>('all');
  const [selectedTestType, setSelectedTestType] = useState('all');
  const [selectedDoctor, setSelectedDoctor] = useState('all');
  const [selectedAccount, setSelectedAccount] = useState('all');
  const [dateFilter, setDateFilter] = useState<DateFilter>('today');
  const [customStartDate, setCustomStartDate] = useState('');
  const [customEndDate, setCustomEndDate] = useState('');
  const [sortField, setSortField] = useState<SortField>(DEFAULT_REPORT_SORT.field);
  const [sortDirection, setSortDirection] = useState<SortDirection>(DEFAULT_REPORT_SORT.direction);
  const [showFilters, setShowFilters] = useState(false);
  const [selectedOrders, setSelectedOrders] = useState<Set<string>>(new Set());
  const [isQueueingSelectedReports, setIsQueueingSelectedReports] = useState(false);
  const [isDeletingSelectedReports, setIsDeletingSelectedReports] = useState(false);
  const [isGeneratingSelectedReports, setIsGeneratingSelectedReports] = useState(false);
  const [isBulkPrintingSelectedReports, setIsBulkPrintingSelectedReports] = useState(false);
  const [bulkPrintProgress, setBulkPrintProgress] = useState<string | null>(null);
  const [isTestingTemplate, setIsTestingTemplate] = useState(false);
  const [previewingOrderId, setPreviewingOrderId] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [userLabId, setUserLabId] = useState<string | null>(null);

  // PDF Settings Modal state
  const [showPDFSettings, setShowPDFSettings] = useState(false);
  const [pdfSettingsOrderId, setPdfSettingsOrderId] = useState<string | null>(null);
  const [showOrderSettings, setShowOrderSettings] = useState(false);
  const [orderSettingsOrderId, setOrderSettingsOrderId] = useState<string | null>(null);
  const [orderSettingsGroups, setOrderSettingsGroups] = useState<OrderSettingsGroupItem[]>([]);
  const [orderSettingsLayoutMode, setOrderSettingsLayoutMode] = useState<'standard' | 'compact'>('compact');
  const [orderSettingsMaxClubbedAnalytes, setOrderSettingsMaxClubbedAnalytes] = useState(5);
  const [orderSettingsLoading, setOrderSettingsLoading] = useState(false);
  const [orderSettingsSaving, setOrderSettingsSaving] = useState(false);
  const [orderSettingsManualOrderTouched, setOrderSettingsManualOrderTouched] = useState(false);
  const [orderSettingsCompactPagesTouched, setOrderSettingsCompactPagesTouched] = useState(false);
  const [orderSettingsExistingPrintUrl, setOrderSettingsExistingPrintUrl] = useState<string | null>(null);
  const [orderSettingsExistingEcopyUrl, setOrderSettingsExistingEcopyUrl] = useState<string | null>(null);
  const [smartReportLoadingId, setSmartReportLoadingId] = useState<string | null>(null);
  const [generatingOrderId, setGeneratingOrderId] = useState<string | null>(null);
  // Per-button generating state: keys are `${orderId}:ecopy`, `${orderId}:compact-print`, `${orderId}:compact-ecopy`
  const [generatingPdfSet, setGeneratingPdfSet] = useState<Set<string>>(new Set());
  const startPdfGeneration = (orderId: string, type: 'ecopy' | 'compact-print' | 'compact-ecopy') =>
    setGeneratingPdfSet(prev => new Set(prev).add(`${orderId}:${type}`));
  const stopPdfGeneration = (orderId: string, type: 'ecopy' | 'compact-print' | 'compact-ecopy') =>
    setGeneratingPdfSet(prev => { const s = new Set(prev); s.delete(`${orderId}:${type}`); return s; });
  const isPdfGenerating = (orderId: string, type: 'ecopy' | 'compact-print' | 'compact-ecopy') =>
    generatingPdfSet.has(`${orderId}:${type}`);

  // Report Studio & Send Report
  const [reportStudioOrderId, setReportStudioOrderId] = useState<string | null>(null);
  const [viewingOrder, setViewingOrder] = useState<OrderGroup | null>(null);
  const [sendReportModalData, setSendReportModalData] = useState<{ orderId: string, patientName: string, doctorName: string, doctorPhone: string, clinicalSummary?: string, includeClinicalSummary?: boolean, reportUrl: string } | null>(null);

  const getSampleSeqFromGroup = (group: OrderGroup) => {
    const explicit = group.order_numbers.find((n) => typeof n === 'number' && Number.isFinite(n));
    if (typeof explicit === 'number') return explicit;
    const sample = group.sample_ids[0] || '';
    const tail = String(sample).match(/(?:^|[/-])(\d+)\s*$/)?.[1] || '';
    const parsed = parseInt(tail, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  };

  const handleOpenSendDoctor = async (group: OrderGroup) => {
    try {
      // Find report URL
	      const result = group.results[0] as ApprovedResult;
	      const finalReport = result?.final_report;
	      const reportUrl = finalReport?.pdf_url || result?.compact_ecopy_url || finalReport?.compact_ecopy_url || finalReport?.print_pdf_url;

      if (!reportUrl) {
        alert('Please generate a final report before sending to doctor.');
        return;
      }

      // Fetch latest order details for summary, send-to-doctor flag, and phone (join with doctors table for phone)
      const { data: orderData, error } = await supabase
        .from('orders')
        .select('doctor, ai_clinical_summary, send_clinical_summary_to_doctor, referring_doctor:doctors(phone)')
        .eq('id', group.order_id)
        .single();

      if (error) throw error;

      // Debug: Log fetched data
      console.log('[Reports handleOpenSendDoctor] Fetched order data:', {
        orderId: group.order_id,
        send_clinical_summary_to_doctor: orderData.send_clinical_summary_to_doctor,
        ai_clinical_summary_exists: !!orderData.ai_clinical_summary,
        ai_clinical_summary_length: orderData.ai_clinical_summary?.length || 0
      });

      // Extract phone from the joined doctors table
      const doctorPhone = (orderData.referring_doctor as { phone?: string } | null)?.phone || '';

      const modalData = {
        orderId: group.order_id,
        patientName: group.patient_full_name,
        doctorName: orderData.doctor || 'Doctor',
        doctorPhone,
        clinicalSummary: orderData.ai_clinical_summary,
        includeClinicalSummary: orderData.send_clinical_summary_to_doctor || false,  // Use send_to_doctor flag for WhatsApp
        reportUrl: convertToCustomDomain(reportUrl) || reportUrl
      };

      console.log('[Reports handleOpenSendDoctor] Modal data being set:', {
        orderId: modalData.orderId,
        includeClinicalSummary: modalData.includeClinicalSummary,
        clinicalSummaryExists: !!modalData.clinicalSummary
      });

      setSendReportModalData(modalData);
    } catch (err) {
      console.error('Error preparing send modal:', err);
      alert('Failed to load order details.');
    }
  };

  // PDF generation hook
  const { isGenerating, stage, progress, pdfUrl, generatePDF, regenerateWithSettings, resetState } = usePDFGeneration();

  // PDF Queue Status tracking
  const [pdfQueueStatus, setPdfQueueStatus] = useState<Map<string, any>>(new Map());
  const [isPolling, setIsPolling] = useState(false);
  const previousQueueStatusRef = React.useRef<Map<string, any>>(new Map());

  // Stable report link state per order, polled alongside the queue.
  // A job sits in 'processing' for the whole download+upload tail, but the link
  // resolves to a real PDF as soon as PDF.co has rendered -- so this is what
  // decides whether the row's actions are usable, not the queue status.
  // orderId -> { final?: {status, url}, print?: {status, url} }
  const [reportLinkStatus, setReportLinkStatus] = useState<
    Map<string, Record<string, { status: string; url: string }>>
  >(new Map());

  /** A variant is usable once it resolves to an actual PDF rather than a wait page. */
  const getReadyReportLink = useCallback(
    (orderId: string, variant: 'final' | 'print') => {
      const entry = reportLinkStatus.get(orderId)?.[variant];
      if (!entry) return null;
      return entry.status === 'temp' || entry.status === 'permanent' ? entry.url : null;
    },
    [reportLinkStatus]
  );

  const isReportLinkViewable = useCallback(
    (orderId: string) => !!getReadyReportLink(orderId, 'final'),
    [getReadyReportLink]
  );

  /**
   * Whether the row's actions should stay disabled.
   *
   * Previously this was "the queue says processing", which kept View/Download/
   * WhatsApp greyed out for the entire upload tail even though the report was
   * already viewable. Once the stable link resolves there is a real PDF behind
   * it, so the buttons are enabled and the progress card just keeps ticking.
   */
  const isOrderBusy = useCallback((orderId: string) => {
    if (isReportLinkViewable(orderId)) return false;
    return generatingOrderId === orderId
      || pdfQueueStatus.get(orderId)?.status === 'processing';
  }, [isReportLinkViewable, generatingOrderId, pdfQueueStatus]);

  // Poll PDF queue status for orders
  const pollPDFQueueStatus = useCallback(async (orderIds: string[], shouldReloadOnComplete = true) => {
    if (orderIds.length === 0) return;

    try {
      const jobs: any[] = [];
      for (const orderIdBatch of chunkArray(orderIds, RELATED_LOOKUP_BATCH_SIZE)) {
        const { data: batchJobs, error } = await supabase
          .from('pdf_generation_queue')
          .select('*')
          .in('order_id', orderIdBatch);

        if (error) {
          console.error('Error polling PDF queue:', error);
          return;
        }

        jobs.push(...((batchJobs as any[]) || []));
      }

      const statusMap = new Map<string, any>();
      let hasNewlyCompleted = false;

      // Group jobs by order_id
      if (jobs) {
        for (const job of jobs) {
          statusMap.set(job.order_id, job);

          // Check if this job just completed
          const prevJob = previousQueueStatusRef.current.get(job.order_id);
          if (job.status === 'completed' && prevJob && prevJob.status !== 'completed') {
            console.log('🎉 Job just completed for order:', job.order_id);
            hasNewlyCompleted = true;
          }
        }
      }

      // Update the ref for next comparison
      previousQueueStatusRef.current = statusMap;
      setPdfQueueStatus(statusMap);

      // Piggyback the stable-link state on the same poll. Labs not enrolled
      // simply have no rows, leaving the map empty and every gate unchanged.
      try {
        const links: any[] = [];
        for (const orderIdBatch of chunkArray(orderIds, RELATED_LOOKUP_BATCH_SIZE)) {
          const { data: batchLinks } = await supabase
            .from('report_links')
            .select('order_id, variant, status, token')
            .in('variant', ['final', 'print'])
            .in('order_id', orderIdBatch);
          links.push(...((batchLinks as any[]) || []));
        }
        const linkMap = new Map<string, Record<string, { status: string; url: string }>>();
        for (const link of links) {
          const entry = linkMap.get(link.order_id) ?? {};
          entry[link.variant] = { status: link.status, url: buildReportLinkUrl(link.token) };
          linkMap.set(link.order_id, entry);
        }
        setReportLinkStatus(linkMap);
      } catch (linkErr) {
        console.warn('Report link status poll failed (non-fatal):', linkErr);
      }

      // If any job just completed, reload approved results
      if (hasNewlyCompleted && shouldReloadOnComplete) {
        console.log('🔄 Reloading approved results after job completion...');
        setTimeout(() => {
          loadApprovedResults();
        }, 500);
      }
    } catch (error) {
      console.error('Error polling PDF queue status:', error);
    }
  }, []);

  // Load approved results
  const loadApprovedResults = useCallback(async () => {
    try {
      setLoading(true);

      // Get current lab context
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) {
        console.error('No lab context available');
        setLoading(false);
        return;
      }

      // Store lab ID for PDF settings
      setUserLabId(lab_id);

      const dateRange = getCalendarDateRange(dateFilter, new Date(), {
        start: customStartDate,
        end: customEndDate,
      });

      // ✅ Apply location filtering for access control
      const { shouldFilter, locationIds } = await database.shouldFilterByLocation();

      const data: ApprovedResult[] = [];
      let fetchFrom = 0;
      let fetchError: any = null;

      while (true) {
        let query = supabase
          .from('view_approved_results')
          .select('*')
          .eq('lab_id', lab_id)
          .gte('verified_at', dateRange.start.toISOString())
          .lte('verified_at', dateRange.end.toISOString())
          .order('verified_at', { ascending: false })
          .range(fetchFrom, fetchFrom + APPROVED_RESULTS_PAGE_SIZE - 1);

        // Apply location filter if user is restricted
        if (shouldFilter && locationIds.length > 0) {
          query = query.in('location_id', locationIds);
        }

        const { data: pageData, error } = await query;
        if (error) {
          fetchError = error;
          break;
        }

        const rows = (pageData as ApprovedResult[]) || [];
        data.push(...rows);

        if (rows.length < APPROVED_RESULTS_PAGE_SIZE) {
          break;
        }
        fetchFrom += APPROVED_RESULTS_PAGE_SIZE;
      }

      if (fetchError) {
        throw fetchError;
      }

      if (data) {
        // 1. Bulk Fetch Existing Reports
        let existingReports: any[] = [];
        const orderIds = Array.from(new Set(data.map((r: ApprovedResult) => r.order_id).filter(Boolean)));

        if (orderIds.length > 0) {
          for (const orderIdBatch of chunkArray(orderIds, RELATED_LOOKUP_BATCH_SIZE)) {
            const { data: reportsData } = await supabase
              .from('reports')
              .select('id, order_id, status, generated_date, report_type, pdf_url, pdf_generated_at, print_pdf_url, print_pdf_generated_at, print_layout_mode, compact_ecopy_url, compact_ecopy_generated_at, printed_at, printed_by, print_count')
              .in('order_id', orderIdBatch);
            existingReports.push(...((reportsData as any[]) || []));
          }
        }

        // 2. Bulk Fetch Patient Phones
        const patientPhoneMap = new Map<string, string>();
        const patientIds = Array.from(
          new Set((data as ApprovedResult[]).map((r) => r.patient_id).filter(Boolean))
        );

        if (patientIds.length > 0) {
          for (const patientIdBatch of chunkArray(patientIds, RELATED_LOOKUP_BATCH_SIZE)) {
            const { data: patientsData, error: patientsError } = await supabase
              .from('patients')
              .select('id, phone')
              .in('id', patientIdBatch);

            if (!patientsError && patientsData) {
              for (const patient of patientsData as Array<{ id: string; phone?: string | null }>) {
                if (patient?.id) {
                  patientPhoneMap.set(patient.id, patient.phone || '');
                }
              }
            }
          }
        }

        // 3. Bulk Fetch Smart Report URLs and order metadata
        const smartReportMap = new Map<string, { url: string; generated_at: string }>();
        const orderMetaMap = new Map<string, { account_id?: string | null; account_name?: string | null; order_number?: number | null; sample_id?: string | null; doctor?: string | null }>();
        if (orderIds.length > 0) {
          for (const orderIdBatch of chunkArray(orderIds, RELATED_LOOKUP_BATCH_SIZE)) {
            const { data: ordersData } = await supabase
              .from('orders')
              .select('id, smart_report_url, smart_report_generated_at, account_id, order_number, sample_id, doctor, accounts(name)')
              .in('id', orderIdBatch);

            if (ordersData) {
              ordersData.forEach((order: any) => {
                const accountInfo = Array.isArray(order.accounts) ? order.accounts[0] : order.accounts;
                orderMetaMap.set(order.id, {
                  account_id: order.account_id || null,
                  account_name: accountInfo?.name || null,
                  order_number: order.order_number ?? null,
                  sample_id: order.sample_id || null,
                  doctor: order.doctor || null,
                });
                if (order.smart_report_url) {
                  smartReportMap.set(order.id, {
                    url: order.smart_report_url,
                    generated_at: order.smart_report_generated_at
                  });
                }
              });
            }
          }
        }

        const reportsByOrder = new Map<string, any[]>();
        for (const report of existingReports) {
          if (!report?.order_id) continue;
          const orderReports = reportsByOrder.get(report.order_id) || [];
          orderReports.push(report);
          reportsByOrder.set(report.order_id, orderReports);
        }

        // Use the same all-panel readiness source as the verification page and
        // PDF edge function. view_approved_results only contains approved rows,
        // so it cannot determine whether other ordered panels are still pending.
        const panelStatusByOrder = new Map<string, Array<{
          panel_ready: boolean;
          test_group_name: string | null;
        }>>();
        if (orderIds.length > 0) {
          for (const orderIdBatch of chunkArray(orderIds, RELATED_LOOKUP_BATCH_SIZE)) {
            const { data: panelStatusData, error: panelStatusError } = await supabase
              .from('v_result_panel_status')
              .select('order_id, panel_ready, test_group_name')
              .in('order_id', orderIdBatch);

            if (panelStatusError) {
              console.warn('Could not load panel readiness for reports:', panelStatusError.message);
              break;
            }

            for (const panel of panelStatusData || []) {
              if (!panel?.order_id) continue;
              const panels = panelStatusByOrder.get(panel.order_id) || [];
              panels.push({
                panel_ready: panel.panel_ready === true,
                test_group_name: panel.test_group_name || null,
              });
              panelStatusByOrder.set(panel.order_id, panels);
            }
          }
        }

        const getLatestReport = (reports: any[], reportType: 'draft' | 'final') => {
          return reports
            .filter((report) => report.report_type === reportType)
            .sort((a, b) => {
              const aTime = new Date(a.pdf_generated_at || a.print_pdf_generated_at || a.compact_ecopy_generated_at || a.generated_date || 0).getTime();
              const bTime = new Date(b.pdf_generated_at || b.print_pdf_generated_at || b.compact_ecopy_generated_at || b.generated_date || 0).getTime();
              return bTime - aTime;
            })[0] || null;
        };

        // Process data in memory without inner async calls
        const enhancedData: ApprovedResult[] = (data as ApprovedResult[]).map((result) => {
          const orderReports = reportsByOrder.get(result.order_id) || [];
          const finalReport = getLatestReport(orderReports, 'final');
          const draftReport = getLatestReport(orderReports, 'draft');
          const primaryReport = finalReport || draftReport;
          const hasAnyFinalPdf = !!(
            finalReport?.pdf_url ||
            finalReport?.print_pdf_url ||
            finalReport?.compact_ecopy_url
          );
          const hasAnyDraftPdf = !!(
            draftReport?.pdf_url ||
            draftReport?.print_pdf_url ||
            draftReport?.compact_ecopy_url
          );
          const panelStatuses = panelStatusByOrder.get(result.order_id);
          const isReady = panelStatuses
            ? panelStatuses.length > 0 && panelStatuses.every((panel) => panel.panel_ready)
            : result.verification_status === 'verified';
          const orderedTestNames = Array.from(new Set(
            (panelStatuses || [])
              .map((panel) => panel.test_group_name)
              .filter((name): name is string => Boolean(name))
          ));
          const resolvedPhone = result.phone || patientPhoneMap.get(result.patient_id) || '';
          const smartReport = smartReportMap.get(result.order_id);
          const orderMeta = orderMetaMap.get(result.order_id);

          return {
            ...result,
            sample_id: result.sample_id || orderMeta?.sample_id || '',
            doctor: result.doctor || orderMeta?.doctor || '',
            account_id: orderMeta?.account_id || null,
            account_name: orderMeta?.account_name || null,
            order_number: orderMeta?.order_number ?? null,
            has_report: orderReports.length > 0,
            report_status: primaryReport?.status,
            report_generated_at: primaryReport?.generated_date,
            is_report_ready: isReady,
            has_draft_report: hasAnyDraftPdf,
            has_final_report: hasAnyFinalPdf,
            has_print_pdf: !!(finalReport?.print_pdf_url || draftReport?.print_pdf_url),
            has_compact_ecopy: !!(finalReport?.compact_ecopy_url || draftReport?.compact_ecopy_url),
            draft_report: draftReport,
            final_report: finalReport,
            print_pdf_url: (finalReport?.print_pdf_url || draftReport?.print_pdf_url) || undefined,
            print_pdf_generated_at: (finalReport?.print_pdf_generated_at || draftReport?.print_pdf_generated_at) || undefined,
            compact_ecopy_url: (finalReport?.compact_ecopy_url || draftReport?.compact_ecopy_url) || undefined,
            compact_ecopy_generated_at: (finalReport?.compact_ecopy_generated_at || draftReport?.compact_ecopy_generated_at) || undefined,
            printed_at: (finalReport?.printed_at || draftReport?.printed_at) || null,
            printed_by: (finalReport?.printed_by || draftReport?.printed_by) || null,
            print_count: (finalReport?.print_count ?? draftReport?.print_count ?? 0),
            phone: resolvedPhone,
            ordered_test_names: orderedTestNames.length > 0 ? orderedTestNames : undefined,
            // Smart Report fields
            smart_report_url: smartReport?.url,
            smart_report_generated_at: smartReport?.generated_at
          };
        });

        setApprovedResults(enhancedData);

        // Poll PDF queue status for orders (bulk)
        const uniqueOrderIds = Array.from(new Set(enhancedData.map(r => r.order_id)));
        await pollPDFQueueStatus(uniqueOrderIds);
      }
    } catch (err) {
      console.error('Error loading approved results:', err);
    } finally {
      setLoading(false);
    }
  }, [dateFilter, customStartDate, customEndDate, pollPDFQueueStatus]);

  useEffect(() => {
    const checkAdminStatus = async () => {
      console.log('🔍 Checking admin status...');
      try {
        const { data: { user } } = await supabase.auth.getUser();
        console.log('👤 Current user ID:', user?.id);

        if (user) {
          const { data: userData, error } = await supabase
            .from('users')
            .select('role')
            .eq('id', user.id)
            .single();

          console.log('📋 User role data:', userData);
          if (error) console.error('❌ Error fetching user role:', error);

          if (userData && (userData.role === 'admin' || userData.role === 'super_admin' || userData.role === 'lab_admin')) {
            console.log('✅ User identified as ADMIN');
            setIsAdmin(true);
          } else {
            console.log('⚠️ User is NOT identified as admin. Role:', userData?.role);
            setIsAdmin(false);
          }
        } else {
          console.log('❌ No authenticated user found during admin check');
        }
      } catch (err) {
        console.error('❌ Exception checking admin status:', err);
      }
    };
    checkAdminStatus();
  }, []);

  useEffect(() => {
    loadApprovedResults();
  }, [loadApprovedResults]);

  // Auto-trigger PDF generation for pending jobs
  useEffect(() => {
    if (approvedResults.length === 0) return;

    // Find pending jobs that need auto-generation
    const pendingJobs = Array.from(pdfQueueStatus.entries()).filter(
      ([, job]) => job.status === 'pending'
    );

    // Auto-trigger generation for first pending job (one at a time)
    if (pendingJobs.length > 0) {
      const [orderId] = pendingJobs[0];

      // ✅ Pre-check: Verify ALL panels are ready before triggering
      // This prevents premature PDF generation for multi-group orders
      // where only some test groups have been approved.
      isOrderReportReady(orderId).then((ready) => {
        if (!ready) {
          console.log('⏳ Skipping auto-trigger for', orderId, '— not all panels ready yet');
          return;
        }

        console.log('🤖 Auto-triggering PDF generation for:', orderId);

        // Trigger and poll when complete
        database.pdfQueue.triggerGeneration(orderId).then(({ data, error }) => {
          if (error) {
            console.error('❌ Auto-generation failed:', error);
          } else {
            console.log('✅ PDF generation complete, refreshing status...', data);
          }
          // Always poll after generation attempt (success or fail)
          const orderIds = Array.from(new Set(approvedResults.map(r => r.order_id)));
          pollPDFQueueStatus(orderIds);
          // Also reload results to get updated report info
          loadApprovedResults();
        });
      });
    }
  }, [pdfQueueStatus, approvedResults, pollPDFQueueStatus, loadApprovedResults]);

  // Poll PDF queue status every 2 seconds for active jobs
  useEffect(() => {
    if (approvedResults.length === 0) return;

    // Check if there are active jobs that need polling
    const hasActiveJobs = Array.from(pdfQueueStatus.values()).some(
      job => job.status === 'pending' || job.status === 'processing'
    );

    // Only set up interval if there are active jobs
    if (!hasActiveJobs) return;

    const orderIds = Array.from(new Set(approvedResults.map(r => r.order_id)));

    const interval = setInterval(() => {
      // Double-check active jobs before each poll
      const stillHasActiveJobs = Array.from(pdfQueueStatus.values()).some(
        job => job.status === 'pending' || job.status === 'processing'
      );

      if (stillHasActiveJobs) {
        pollPDFQueueStatus(orderIds);
      }
    }, 2000); // Poll every 2 seconds for faster UI updates

    return () => clearInterval(interval);
  }, [approvedResults, pollPDFQueueStatus]); // Removed pdfQueueStatus from dependencies to prevent infinite loop

  // Transform and filter data
  const orderGroups: OrderGroup[] = useMemo(() => {
    const map = new Map<string, OrderGroup>();

    let filtered = approvedResults;

    // Apply search filter
    if (searchTerm) {
      const searchLower = searchTerm.toLowerCase();
      filtered = filtered.filter(
        (result) =>
          (result.patient_full_name || '').toLowerCase().includes(searchLower) ||
          (result.test_name || '').toLowerCase().includes(searchLower) ||
          (result.sample_id || '').toLowerCase().includes(searchLower) ||
          (result.order_id || '').toLowerCase().includes(searchLower)
      );
    }

    // Apply test type filter
    if (selectedTestType !== 'all') {
      filtered = filtered.filter(result =>
        (result.test_name || '').toLowerCase().includes(selectedTestType.toLowerCase())
      );
    }

    // Apply doctor filter
    if (selectedDoctor !== 'all') {
      filtered = filtered.filter(result =>
        result.doctor?.toLowerCase().includes(selectedDoctor.toLowerCase())
      );
    }

    if (selectedAccount !== 'all') {
      filtered = filtered.filter(result =>
        (result.account_name || '').toLowerCase().includes(selectedAccount.toLowerCase())
      );
    }

    // Apply status filter
    if (selectedStatus !== 'all') {
      filtered = filtered.filter(result => {
        switch (selectedStatus) {
          case 'ready':
            return result.is_report_ready && !result.has_final_report;
          case 'pending':
            return !result.is_report_ready;
          case 'processing':
            return result.has_draft_report && !result.has_final_report;
          default:
            return true;
        }
      });
    }

    // Group by order
    for (const r of filtered) {
      let group = map.get(r.order_id);
      if (!group) {
        group = {
          order_id: r.order_id,
          patient_id: r.patient_id,
          patient_full_name: r.patient_full_name,
          age: r.age,
          gender: r.gender,
          order_date: r.order_date,
          sample_ids: r.sample_id ? [r.sample_id] : [],
          account_names: r.account_name ? [r.account_name] : [],
          order_numbers: typeof r.order_number === 'number' ? [r.order_number] : [],
          verified_at: r.verified_at,
          verified_by: r.verified_by,
          test_names: r.ordered_test_names?.length
            ? [...r.ordered_test_names]
            : r.test_name ? [r.test_name] : [],
          results: [r],
          is_report_ready: r.is_report_ready || false
        };
        map.set(r.order_id, group);
      } else {
        // Check if this result_id already exists to prevent duplicates
        const existingResult = group.results.find(existing => existing.result_id === r.result_id);
        if (!existingResult) {
          group.results.push(r);
        }
        if (r.sample_id && !group.sample_ids.includes(r.sample_id)) group.sample_ids.push(r.sample_id);
        if (r.account_name && !group.account_names.includes(r.account_name)) group.account_names.push(r.account_name);
        if (typeof r.order_number === 'number' && !group.order_numbers.includes(r.order_number)) group.order_numbers.push(r.order_number);
        const resultTestNames = r.ordered_test_names?.length ? r.ordered_test_names : [r.test_name];
        for (const testName of resultTestNames) {
          if (testName && !group.test_names.includes(testName)) group.test_names.push(testName);
        }
        if (new Date(r.verified_at) > new Date(group.verified_at)) {
          group.verified_at = r.verified_at;
          group.verified_by = r.verified_by;
        }
        group.is_report_ready = group.is_report_ready && (r.is_report_ready || false);
      }
    }

    // Sort groups
    const sorted = Array.from(map.values()).sort((a, b) => {
      let aValue: any, bValue: any;

      switch (sortField) {
        case 'patient_name':
          aValue = a.patient_full_name;
          bValue = b.patient_full_name;
          break;
        case 'sample_id':
          aValue = getSampleSeqFromGroup(a);
          bValue = getSampleSeqFromGroup(b);
          break;
        case 'order_date':
          aValue = new Date(a.order_date).getTime();
          bValue = new Date(b.order_date).getTime();
          break;
        case 'test_name':
          aValue = (a.test_names || []).join(', ');
          bValue = (b.test_names || []).join(', ');
          break;
        default:
          aValue = new Date(a.verified_at).getTime();
          bValue = new Date(b.verified_at).getTime();
      }

      if (sortDirection === 'asc') {
        return aValue < bValue ? -1 : aValue > bValue ? 1 : 0;
      } else {
        return aValue > bValue ? -1 : aValue < bValue ? 1 : 0;
      }
    });

    return sorted;
  }, [approvedResults, searchTerm, selectedTestType, selectedDoctor, selectedAccount, selectedStatus, sortField, sortDirection]);

  // Get unique values for filters
  const uniqueTestTypes = useMemo(() => {
    const types = new Set(approvedResults.map(r => r.test_name));
    return Array.from(types).sort();
  }, [approvedResults]);

  const uniqueDoctors = useMemo(() => {
    const doctors = new Set(approvedResults.map(r => r.doctor).filter(Boolean));
    return Array.from(doctors).sort();
  }, [approvedResults]);

  const uniqueAccounts = useMemo(() => {
    const accounts = new Set(approvedResults.map(r => r.account_name).filter(Boolean));
    return Array.from(accounts).sort();
  }, [approvedResults, orderSettingsCompactPagesTouched, orderSettingsManualOrderTouched]);

  // Statistics for dashboard
  const statistics = useMemo(() => {
    const totalOrders = orderGroups.length;
    const readyForGeneration = orderGroups.filter(g => g.is_report_ready && !g.results[0]?.has_final_report).length;
    const pendingVerification = orderGroups.filter(g => !g.is_report_ready).length;
    const finalReports = orderGroups.filter(g => g.results[0]?.has_final_report).length;

    return { totalOrders, readyForGeneration, pendingVerification, finalReports };
  }, [orderGroups]);

  // Handlers
  const handleView = async (orderId: string) => {
    const group = orderGroups.find(g => g.order_id === orderId);
    if (!group) {
      alert('Order not found');
      return;
    }
    setViewingOrder(group);
  };

  const isTempPdfUrl = (url?: string | null): boolean =>
    !!url && url.includes('pdf-temp-files.s3.amazonaws.com');

  const handleDownload = useCallback(async (orderId: string, forceDraft = false, draftVariant: 'ecopy' | 'print' = 'ecopy') => {
    try {
      setGeneratingOrderId(orderId);
      await generatePDF(orderId, forceDraft, draftVariant);
      // Keep button disabled for 3 seconds after generation to prevent double-clicking
      // The queue polling will show the actual status
      setTimeout(async () => {
        await loadApprovedResults();
        // Only clear if no queue job is processing for this order
        const { data: job } = await supabase
          .from('pdf_generation_queue')
          .select('status')
          .eq('order_id', orderId)
          .single();

        if (!job || job.status !== 'processing') {
          setGeneratingOrderId(null);
        }
      }, 3000);
    } catch (error) {
      console.error('Download failed:', error);
      alert('Download failed: ' + (error instanceof Error ? error.message : 'Unknown error'));
      setGeneratingOrderId(null);
    }
  }, [generatePDF, loadApprovedResults]);

  const handleRetryStuckJob = useCallback(async (orderId: string, forceDraft = false, draftVariant: 'ecopy' | 'print' = 'ecopy') => {
    try {
      await supabase.from('pdf_generation_queue').delete().eq('order_id', orderId);
      setPdfQueueStatus(prev => { const next = new Map(prev); next.delete(orderId); return next; });
      setGeneratingOrderId(null);
      await handleDownload(orderId, forceDraft, draftVariant);
    } catch (error) {
      console.error('Retry stuck job failed:', error);
      alert('Retry failed: ' + (error instanceof Error ? error.message : 'Unknown error'));
    }
  }, [handleDownload]);

  // Generate Smart Report (forceRegenerate=true bypasses cache, used for right-click regenerate)
  const handleSmartReport = async (orderId: string, forceRegenerate = false) => {
    try {
      setSmartReportLoadingId(orderId);

      // Smart Report V2 - Two-page approach:
      // Page 1: Cover page with letterhead, lab/patient info (PDF.co)
      // Page 2+: Clean results with AI analysis (Gamma AI)
      // Final: Merged with PDF.co
      console.log('🚀 Starting Smart Report V2 for order:', orderId, forceRegenerate ? '(force regenerate)' : '');

      const { data: smartData, error: smartError } = await supabase.functions.invoke('generate-smart-report-v2', {
        body: { orderId, forceRegenerate }
      });

      if (smartError) throw smartError;

      console.log('✨ Smart Report V2 Result:', smartData);

      // Open the PDF (cached or newly generated)
      if (smartData?.pdfUrl) {
        window.open(smartData.pdfUrl, '_blank');
        // Refresh data if this was a new generation (not cached)
        if (!smartData.cached) {
          loadApprovedResults();
        }
      } else if (smartData?.mergedUrl) {
        // Fallback to merged URL (temporary PDF.co URL)
        window.open(smartData.mergedUrl, '_blank');
      } else if (smartData?.gammaUrl) {
        // Last fallback to just the Gamma portion
        window.open(smartData.gammaUrl, '_blank');
        alert('Note: Only Gamma portion generated. Cover page merge may have failed.');
      } else {
        alert('Smart report generated but no URL returned.');
      }

    } catch (error) {
      console.error('Smart report V2 failed:', error);
      alert('Failed to generate Smart Report: ' + (error instanceof Error ? error.message : 'Unknown error'));
    } finally {
      setSmartReportLoadingId(null);
    }
  };

  const handleHtmlPreview = async (orderId: string) => {
    try {
      console.log('🚀 Triggering Hybrid PDF Generation (One-Shot) for:', orderId);
      // alert('Starting Hybrid PDF Generation... Please wait.');

      const { data, error } = await supabase.functions.invoke('generate-pdf-oneshot', {
        body: { order_id: orderId }
      });

      if (error) throw error;

      console.log('✅ Hybrid Generation Result:', data);

      if (data?.pdfUrl) {
        window.open(data.pdfUrl, '_blank');
      } else {
        alert('Report generated but no URL returned check console.');
      }

    } catch (error) {
      console.error('Hybrid Report Gen failed:', error);
      alert('Failed to generate Hybrid Report: ' + (error instanceof Error ? error.message : 'Unknown error'));
    }
  };



  // Stamp an order's report as printed so the list shows a "Printed" status and
  // staff can tell at a glance which hard copies have already been taken out.
  const markOrderPrinted = useCallback(async (orderIds: string | string[]) => {
    const ids = Array.from(new Set((Array.isArray(orderIds) ? orderIds : [orderIds]).filter(Boolean)));
    if (ids.length === 0) return;

    const printedAt = new Date().toISOString();

    // Optimistic — flip the badge/row colour straight away.
    setApprovedResults(prev => prev.map(result => (
      ids.includes(result.order_id)
        ? { ...result, printed_at: printedAt, print_count: (result.print_count ?? 0) + 1 }
        : result
    )));

    try {
      const { data: { user } } = await supabase.auth.getUser();

      const { data: existingRows } = await supabase
        .from('reports')
        .select('order_id, print_count')
        .in('order_id', ids);

      const countByOrder = new Map<string, number>(
        ((existingRows as Array<{ order_id: string; print_count: number | null }>) || [])
          .map(row => [row.order_id, row.print_count ?? 0])
      );

      const updates = await Promise.all(ids.map(orderId =>
        supabase
          .from('reports')
          .update({
            printed_at: printedAt,
            printed_by: user?.id ?? null,
            print_count: (countByOrder.get(orderId) ?? 0) + 1,
            updated_at: printedAt,
          })
          .eq('order_id', orderId)
          .select('order_id')
      ));

      const failed = updates.find(update => update.error);
      if (failed?.error) throw failed.error;

      // A row that was not written (missing report row / blocked by RLS) must not
      // keep showing an optimistic "Printed" badge.
      const savedCount = updates.reduce((total, update) => total + ((update.data as unknown[])?.length ?? 0), 0);
      if (savedCount < ids.length) {
        console.warn(`Print status saved for ${savedCount}/${ids.length} orders — re-syncing.`);
        void loadApprovedResults();
      }
    } catch (error) {
      console.error('Could not record print status:', error);
      // Re-sync so the badge never claims a print that was not saved.
      void loadApprovedResults();
    }
  }, [loadApprovedResults]);

  const handleLetterheadGeneration = async (
    orderId: string,
    printLayoutMode: 'standard' | 'compact' = 'standard',
    pdfType?: 'ecopy' | 'compact-print' | 'compact-ecopy',
    extraBody?: Record<string, unknown>
  ) => {
    const trackingType = pdfType ?? (printLayoutMode === 'compact' ? 'compact-ecopy' : 'ecopy');
    if (isPdfGenerating(orderId, trackingType)) return; // prevent double-click
    startPdfGeneration(orderId, trackingType);
    try {
      console.log('🚀 Triggering Letterhead PDF Generation for:', orderId);

      const { data: { user } } = await supabase.auth.getUser();
      const triggeredByUserId = user?.id;

      const { data, error } = await supabase.functions.invoke('generate-pdf-letterhead', {
        body: { orderId, triggeredByUserId, printLayoutMode, ...(extraBody ?? {}) }
      });

      if (error) {
        console.error('Supabase function error:', error);
        throw error;
      }

      console.log('✅ Letterhead Generation Result:', data);

      const generatedUrl = printLayoutMode === 'compact'
        ? data?.compactEcopyUrl || data?.printPdfUrl || data?.pdfUrl
        : data?.pdfUrl;

      if (generatedUrl) {
        window.open(generatedUrl, '_blank');
        if (trackingType === 'compact-print') {
          await markOrderPrinted(orderId);
        }
      } else {
        alert('Report generated but no URL returned. Check console.');
      }

      await loadApprovedResults();

    } catch (error) {
      console.error('Letterhead Report Gen failed:', error);
      alert('Failed to generate Letterhead Report: ' + (error instanceof Error ? error.message : 'Unknown error'));
    } finally {
      stopPdfGeneration(orderId, trackingType);
    }
  };

  const verifyBulkReportDeletePermission = useCallback(async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        alert('You must be logged in to delete reports.');
        return false;
      }

      const { data: userData, error } = await supabase
        .from('users')
        .select('role')
        .eq('id', user.id)
        .single();

      if (error) throw error;

      const userRoleLower = (userData?.role || '').toLowerCase();
      const hasPermission = Boolean(userData && (
        userRoleLower === 'admin' ||
        userRoleLower === 'super_admin' ||
        userRoleLower === 'lab_admin'
      ));

      if (!hasPermission) {
        alert(`Permission denied. Your role is '${userData?.role || 'unknown'}', but 'admin' or 'super_admin' is required.`);
      }

      return hasPermission;
    } catch (checkError) {
      console.error('Error checking permissions:', checkError);
      alert('Failed to verify permissions. See console for details.');
      return false;
    }
  }, []);

  const handleDeleteReport = useCallback(async (orderId: string) => {
    // Perform on-demand admin check to be absolutely sure and debuggable
    console.log('🕵️‍♀️ Verifying admin status before deletion...');
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        console.error('❌ No authenticated user found on click');
        alert('You must be logged in to delete reports.');
        return;
      }

      const { data: userData, error } = await supabase
        .from('users')
        .select('role')
        .eq('id', user.id)
        .single();

      console.log('📋 On-click User Role:', userData?.role);

      const userRoleLower = (userData?.role || '').toLowerCase();
      const hasPermission = userData && (
        userRoleLower === 'admin' ||
        userRoleLower === 'super_admin' ||
        userRoleLower === 'lab_admin'
      );

      if (!hasPermission) {
        console.warn('⛔ Permission denied. User role:', userData?.role);
        alert(`Permission denied. Your role is '${userData?.role || 'unknown'}', but 'admin' or 'super_admin' is required.`);
        return;
      }

      console.log('✅ Permission granted.');

    } catch (checkError) {
      console.error('❌ Error checking permissions:', checkError);
      alert('Failed to verify permissions. See console for details.');
      return;
    }

    if (!window.confirm('Are you sure you want to delete this report? This action removes the report record but keeps the order and results. This cannot be undone.')) return;

    try {
      const { error } = await supabase
        .from('reports')
        .delete()
        .eq('order_id', orderId);

      if (error) throw error;

      alert('Report deleted successfully');
      // Update local state immediately to reflect removal
      const updatedResults = approvedResults.map(r => {
        if (r.order_id === orderId) {
          return {
            ...r,
            has_report: false,
            has_draft_report: false,
            has_final_report: false,
            is_report_ready: true, // Reset to ready since report is gone
            report_status: undefined,
            report_generated_at: undefined,
            print_pdf_url: undefined
          };
        }
        return r;
      });
      setApprovedResults(updatedResults);
      await loadApprovedResults(); // Full reload to be sure
    } catch (error) {
      console.error('Error deleting report:', error);
      alert('Failed to delete report: ' + (error instanceof Error ? error.message : 'Unknown error'));
    }
  }, [isAdmin, approvedResults, loadApprovedResults]);

  const handleDeleteSelectedReports = useCallback(async () => {
    const selectedOrderIds = Array.from(selectedOrders);
    if (selectedOrderIds.length === 0) {
      alert('Please select at least one order');
      return;
    }

    const hasPermission = await verifyBulkReportDeletePermission();
    if (!hasPermission) return;

    const selectedGroupsWithReports = selectedOrderIds
      .map((orderId) => orderGroups.find((group) => group.order_id === orderId))
      .filter((group): group is OrderGroup => Boolean(group))
      .filter((group) => Boolean((group.results[0] as ApprovedResult | undefined)?.has_report));

    if (selectedGroupsWithReports.length === 0) {
      alert('No generated reports found for the selected orders.');
      return;
    }

    const confirmMessage = `Delete generated reports for ${selectedGroupsWithReports.length} selected order${selectedGroupsWithReports.length === 1 ? '' : 's'}? This removes report records but keeps the orders and results. This cannot be undone.`;
    if (!window.confirm(confirmMessage)) return;

    setIsDeletingSelectedReports(true);
    try {
      const orderIdsToDelete = selectedGroupsWithReports.map((group) => group.order_id);
      const { error } = await supabase
        .from('reports')
        .delete()
        .in('order_id', orderIdsToDelete);

      if (error) throw error;

      setApprovedResults((prev) =>
        prev.map((result) => {
          if (!orderIdsToDelete.includes(result.order_id)) return result;

          return {
            ...result,
            has_report: false,
            has_draft_report: false,
            has_final_report: false,
            is_report_ready: true,
            report_status: undefined,
            report_generated_at: undefined,
            draft_report: null,
            final_report: null,
            print_pdf_url: undefined,
            compact_ecopy_url: undefined,
          };
        })
      );

      setSelectedOrders(new Set());
      alert(`Deleted ${orderIdsToDelete.length} generated report${orderIdsToDelete.length === 1 ? '' : 's'}.`);
      await loadApprovedResults();
    } catch (error) {
      console.error('Error deleting selected reports:', error);
      alert('Failed to delete selected reports: ' + (error instanceof Error ? error.message : 'Unknown error'));
    } finally {
      setIsDeletingSelectedReports(false);
    }
  }, [loadApprovedResults, orderGroups, selectedOrders, verifyBulkReportDeletePermission]);

  const handleBulkPrintSelectedReports = useCallback(async () => {
    const selectedOrderIds = Array.from(selectedOrders);
    if (selectedOrderIds.length === 0) {
      alert('Please select at least one order');
      return;
    }

    const selectedGroups = selectedOrderIds
      .map((orderId) => orderGroups.find((group) => group.order_id === orderId))
      .filter((group): group is OrderGroup => Boolean(group));

    const groupsWithPrintPdf = selectedGroups.filter((group) => {
      const result = group.results[0] as ApprovedResult | undefined;
      return Boolean(
        result?.print_pdf_url ||
        result?.final_report?.print_pdf_url ||
        result?.draft_report?.print_pdf_url
      );
    });

    if (groupsWithPrintPdf.length === 0) {
      alert('None of the selected orders have a generated print PDF yet. Generate print copies first.');
      return;
    }

    const missingCount = selectedGroups.length - groupsWithPrintPdf.length;
    if (missingCount > 0) {
      const proceed = window.confirm(
        `${missingCount} selected order${missingCount === 1 ? ' does' : 's do'} not have a generated print PDF and will be skipped.\n\nMerge and print the remaining ${groupsWithPrintPdf.length}?`
      );
      if (!proceed) return;
    }

    setIsBulkPrintingSelectedReports(true);
    setBulkPrintProgress('Starting…');

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('You must be logged in.');
      const { data: userData } = await supabase.from('users').select('lab_id').eq('id', user.id).single();
      if (!userData?.lab_id) throw new Error('Could not resolve your lab.');

      const orderIds = groupsWithPrintPdf.map((group) => group.order_id);

      const { data: reqData, error: reqError } = await supabase
        .from('bulk_pdf_download_requests')
        .insert({
          lab_id: userData.lab_id,
          order_ids: orderIds,
          total_orders: orderIds.length,
          status: 'pending',
          created_by: user.id,
          download_type: 'merged',
        })
        .select()
        .single();

      if (reqError || !reqData) throw new Error(reqError?.message || 'Failed to create merge request');

      const { error: fnError } = await supabase.functions.invoke('bulk-pdf-merge', {
        body: { request_id: reqData.id, sort_mode: 'sample_asc' },
      });
      if (fnError) throw new Error(fnError.message);

      const startedAt = Date.now();
      while (Date.now() - startedAt < 5 * 60 * 1000) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const { data: status } = await supabase
          .from('bulk_pdf_download_requests')
          .select('status, zip_url, processed_orders, total_orders, error_message')
          .eq('id', reqData.id)
          .single();

        if (!status) continue;
        setBulkPrintProgress(`Merging ${status.processed_orders ?? 0}/${status.total_orders ?? orderIds.length}…`);

        if (status.status === 'completed' && status.zip_url) {
          window.open(status.zip_url, '_blank');
          await markOrderPrinted(orderIds);
          return;
        }
        if (status.status === 'failed') {
          throw new Error(status.error_message || 'Merge failed');
        }
      }
      throw new Error('Merge timed out. Try again or select fewer orders.');
    } catch (error) {
      console.error('Bulk print merge failed:', error);
      alert('Bulk print failed: ' + (error instanceof Error ? error.message : 'Unknown error'));
    } finally {
      setIsBulkPrintingSelectedReports(false);
      setBulkPrintProgress(null);
    }
  }, [markOrderPrinted, orderGroups, selectedOrders]);

  const moveOrderSettingsGroup = useCallback((index: number, direction: -1 | 1) => {
    setOrderSettingsGroups(prev => {
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= prev.length) return prev;
      const next = [...prev];
      const [item] = next.splice(index, 1);
      next.splice(nextIndex, 0, item);
      return next;
    });
    setOrderSettingsManualOrderTouched(true);
  }, []);

  const setOrderSettingsGroupPage = useCallback((testGroupId: string, pageNumber: number) => {
    setOrderSettingsGroups((prev) =>
      prev.map((group) =>
        group.testGroupId === testGroupId
          ? { ...group, pageNumber: Math.max(1, pageNumber) }
          : group,
      ),
    );
    setOrderSettingsCompactPagesTouched(true);
  }, []);

  const setOrderSettingsGroupOwnPage = useCallback((testGroupId: string) => {
    setOrderSettingsGroups((prev) => {
      const currentMax = prev.reduce((max, group) => Math.max(max, group.pageNumber), 1);
      return prev.map((group) =>
        group.testGroupId === testGroupId
          ? { ...group, pageNumber: currentMax + 1 }
        : group,
      );
    });
    setOrderSettingsCompactPagesTouched(true);
  }, []);

  const setOrderSettingsGroupClubPrevious = useCallback((testGroupId: string) => {
    setOrderSettingsGroups((prev) => {
      const index = prev.findIndex((group) => group.testGroupId === testGroupId);
      if (index <= 0) return prev;
      const previousPage = prev[index - 1].pageNumber;
      return prev.map((group) =>
        group.testGroupId === testGroupId
          ? { ...group, pageNumber: previousPage }
        : group,
      );
    });
    setOrderSettingsCompactPagesTouched(true);
  }, []);

  const autoArrangeCompactPages = useCallback(() => {
    setOrderSettingsGroups((prev) => {
      const assignments = autoAssignCompactPages(prev, orderSettingsMaxClubbedAnalytes);
      return prev.map((group) => ({
        ...group,
        pageNumber: assignments[group.testGroupId] || 1,
      }));
    });
    setOrderSettingsCompactPagesTouched(true);
  }, [orderSettingsMaxClubbedAnalytes]);

  const handleLocalCompactPrint = useCallback(async (
    orderId: string,
    overrideGroups?: OrderSettingsGroupItem[],
    overrideMaxClubbedAnalytes?: number,
  ) => {
    const { data: authData } = await supabase.auth.getSession();
    if (!authData?.session) throw new Error('Not authenticated');

    const triggeredByUserId = authData.session.user?.id;
    const compactPageAssignments = overrideGroups && overrideGroups.length > 0
      ? Object.fromEntries(overrideGroups.map((group) => [group.testGroupId, group.pageNumber]))
      : undefined;
    const orderedGroupIds = overrideGroups && overrideGroups.length > 0
      ? overrideGroups.map((group) => group.testGroupId)
      : undefined;

    const { data, error } = await supabase.functions.invoke('generate-pdf-letterhead', {
      body: {
        orderId,
        triggeredByUserId,
        printLayoutMode: 'compact',
        // Note: isDraft is intentionally omitted — the edge function bypasses the
        // panel-readiness check for compact print, so we don't need to force draft mode
        // (which would downgrade an existing final report's report_type).
        ...(orderedGroupIds ? { compactGroupOrder: orderedGroupIds } : {}),
        ...(compactPageAssignments ? { compactPageAssignments } : {}),
        ...(overrideMaxClubbedAnalytes ? { compactMaxClubbedAnalytes: overrideMaxClubbedAnalytes } : {}),
      }
    });

    if (error) throw error;

    const generatedUrl = data?.printPdfUrl || data?.pdfUrl;
    if (!generatedUrl) throw new Error('Compact print generated but no URL returned.');

    window.open(generatedUrl, '_blank');
    await markOrderPrinted(orderId);
    await loadApprovedResults();
    return generatedUrl;
  }, [loadApprovedResults, markOrderPrinted]);

  const saveOrderReportSettings = useCallback(async (
    orderId: string,
    groups: OrderSettingsGroupItem[],
    printLayoutMode: 'standard' | 'compact',
    compactMaxClubbedAnalytes?: number,
    manualOrderOverride = orderSettingsManualOrderTouched,
    compactPagesOverride = orderSettingsCompactPagesTouched,
  ) => {
    const reportSettings: OrderReportSettings = {
      groupOrderOverrideEnabled: manualOrderOverride && groups.length > 0,
      groupOrderManualOverride: manualOrderOverride && groups.length > 0,
      groupOrder: groups.map(group => group.testGroupId),
      printLayoutMode,
      compactPageAssignments: Object.fromEntries(groups.map((group) => [group.testGroupId, group.pageNumber])),
      compactPageAssignmentsManualOverride: compactPagesOverride && groups.length > 0,
      compactMaxClubbedAnalytes: compactMaxClubbedAnalytes ?? 5,
    };

    const { error: orderError } = await supabase
      .from('orders')
      .update({
        report_settings: reportSettings,
        updated_at: new Date().toISOString(),
      })
      .eq('id', orderId);

    if (orderError) throw orderError;

    await Promise.all(groups.map((group, index) =>
      Promise.all([
        supabase
          .from('order_test_groups')
          .update({ print_order: index + 1 })
          .eq('order_id', orderId)
          .eq('test_group_id', group.testGroupId),
        supabase
          .from('order_tests')
          .update({ print_order: index + 1 })
          .eq('order_id', orderId)
          .eq('test_group_id', group.testGroupId),
      ])
    ));

    const existingReport = approvedResults.find(result => result.order_id === orderId)?.final_report;
    if (existingReport?.order_id) {
      await supabase
        .from('reports')
        .update({
          print_layout_mode: printLayoutMode,
          updated_at: new Date().toISOString(),
        })
        .eq('order_id', orderId);
    }
  }, [approvedResults]);

  // Open order-level report settings modal for a specific order
  const handleOpenPDFSettings = useCallback(async (orderId: string) => {
    setOrderSettingsOrderId(orderId);
    setShowOrderSettings(true);
    setOrderSettingsLoading(true);

    try {
      const currentGroup = orderGroups.find(group => group.order_id === orderId);
      const currentLayoutMode = (currentGroup?.results?.[0] as ApprovedResult | undefined)?.final_report?.print_layout_mode === 'standard'
        ? 'standard'
        : 'compact';

      // Reset existing URL state for fresh load
      setOrderSettingsExistingPrintUrl(null);
      setOrderSettingsExistingEcopyUrl(null);

      const [{ data: orderData, error: orderError }, { data: otgData, error: otgError }, { data: otData, error: otError }, { data: context, error: contextError }, { data: existingReport }] = await Promise.all([
        supabase.from('orders').select('report_settings').eq('id', orderId).maybeSingle(),
        supabase
          .from('order_test_groups')
          .select('test_group_id, test_name, print_order, created_at, test_groups(report_priority)')
          .eq('order_id', orderId),
        supabase
          .from('order_tests')
          .select('test_group_id, test_name, print_order, created_at, test_groups(report_priority)')
          .eq('order_id', orderId)
          .neq('is_canceled', true),
        database.reports.getTemplateContext(orderId),
        supabase.from('reports').select('print_pdf_url, compact_ecopy_url').eq('order_id', orderId).eq('report_type', 'final').maybeSingle(),
      ]);

      if (orderError) throw orderError;
      if (otgError) throw otgError;
      if (otError) throw otError;
      if (contextError) throw contextError;

      setOrderSettingsExistingPrintUrl((existingReport as any)?.print_pdf_url || null);
      setOrderSettingsExistingEcopyUrl((existingReport as any)?.compact_ecopy_url || null);

      const reportSettings = (orderData as { report_settings?: OrderReportSettings | null } | null)?.report_settings || {};
      const useSavedCompactPages = reportSettings.compactPageAssignmentsManualOverride === true;
      const descriptorMap = new Map<string, OrderSettingsGroupItem>();
      const pushRow = (row: any) => {
        if (!row?.test_group_id || descriptorMap.has(row.test_group_id)) return;
        descriptorMap.set(row.test_group_id, {
          testGroupId: row.test_group_id,
          testName: row.test_name || 'Test Results',
          reportPriority: Number.isFinite(Number(row?.test_groups?.report_priority))
            ? Number(row.test_groups.report_priority)
            : null,
          printOrder: Number(row?.print_order ?? 0),
          analyteCount: 0,
          pageNumber: 1,
          createdAt: row?.created_at || null,
        });
      };

      (otgData || []).forEach(pushRow);
      (otData || []).forEach(pushRow);

      if (!descriptorMap.size && currentGroup) {
        currentGroup.results.forEach((result, index) => {
          const testGroupId = (result as any).test_group_id as string | undefined;
          if (!testGroupId || descriptorMap.has(testGroupId)) return;
          descriptorMap.set(testGroupId, {
            testGroupId,
            testName: result.test_name,
            reportPriority: null,
            printOrder: index + 1,
            analyteCount: 0,
            pageNumber: 1,
            createdAt: null,
          });
        });
      }

      const manualOrder = Array.isArray(reportSettings.groupOrder) ? reportSettings.groupOrder : [];
      const manualIndex = new Map(manualOrder.map((id, index) => [id, index]));
      const useManualOrder = reportSettings.groupOrderManualOverride === true;
      const resolvedGroups = [...descriptorMap.values()].sort((a, b) => {
        const aManual = manualIndex.has(a.testGroupId) ? manualIndex.get(a.testGroupId)! : Number.MAX_SAFE_INTEGER;
        const bManual = manualIndex.has(b.testGroupId) ? manualIndex.get(b.testGroupId)! : Number.MAX_SAFE_INTEGER;
        if (useManualOrder && aManual !== bManual) return aManual - bManual;
        const aPriority = getActiveReportPriority(a.reportPriority);
        const bPriority = getActiveReportPriority(b.reportPriority);
        if (aPriority !== bPriority) return aPriority - bPriority;
        if (a.printOrder !== b.printOrder) return a.printOrder - b.printOrder;
        return a.testName.localeCompare(b.testName);
      });

      const compactDefinitions = context
        ? buildCompactGroupDefinitions(context, resolvedGroups.map((group) => group.testGroupId))
        : [];
      const definitionMap = new Map(compactDefinitions.map((group) => [group.testGroupId, group]));
      const autoAssignments = autoAssignCompactPages(compactDefinitions, reportSettings.compactMaxClubbedAnalytes || 5);

      setOrderSettingsMaxClubbedAnalytes(reportSettings.compactMaxClubbedAnalytes || 5);
      setOrderSettingsGroups(resolvedGroups.map((group) => ({
        ...group,
        analyteCount: definitionMap.get(group.testGroupId)?.analyteCount || 0,
        pageNumber: (useSavedCompactPages ? reportSettings.compactPageAssignments?.[group.testGroupId] : undefined) || autoAssignments[group.testGroupId] || 1,
      })));
      setOrderSettingsManualOrderTouched(useManualOrder);
      setOrderSettingsCompactPagesTouched(useSavedCompactPages);
      setOrderSettingsLayoutMode(reportSettings.printLayoutMode === 'standard' ? 'standard' : currentLayoutMode);
    } catch (error) {
      console.error('Failed to load order report settings:', error);
      alert('Failed to load order report settings.');
      setShowOrderSettings(false);
      setOrderSettingsOrderId(null);
    } finally {
      setOrderSettingsLoading(false);
    }
  }, [orderGroups]);

  // Handle PDF regeneration with custom settings
  const handleRegenerateWithSettings = useCallback(async (settings: PDFRenderSettings) => {
    if (!pdfSettingsOrderId) return;

    try {
      const pdfCoOptions = settingsToPdfCoOptions(settings);
      await regenerateWithSettings(pdfSettingsOrderId, pdfCoOptions);

      // Refresh the list after regeneration
      setTimeout(async () => {
        await loadApprovedResults();
      }, 1000);

      setShowPDFSettings(false);
      setPdfSettingsOrderId(null);
    } catch (error) {
      console.error('Regeneration failed:', error);
      alert('PDF regeneration failed: ' + (error instanceof Error ? error.message : 'Unknown error'));
    }
  }, [pdfSettingsOrderId, regenerateWithSettings, loadApprovedResults]);

  const handleSaveOrderSettings = useCallback(async () => {
    if (!orderSettingsOrderId) return;
    setOrderSettingsSaving(true);
    try {
      await saveOrderReportSettings(orderSettingsOrderId, orderSettingsGroups, orderSettingsLayoutMode, orderSettingsMaxClubbedAnalytes);
      await loadApprovedResults();
      alert('Order report settings saved.');
    } catch (error) {
      console.error('Failed to save order report settings:', error);
      alert('Failed to save order report settings.');
    } finally {
      setOrderSettingsSaving(false);
    }
  }, [loadApprovedResults, orderSettingsGroups, orderSettingsLayoutMode, orderSettingsMaxClubbedAnalytes, orderSettingsOrderId, saveOrderReportSettings]);

  const handleRegenerateFromOrderSettings = useCallback(async () => {
    if (!orderSettingsOrderId) return;
    setOrderSettingsSaving(true);
    try {
      await saveOrderReportSettings(orderSettingsOrderId, orderSettingsGroups, orderSettingsLayoutMode, orderSettingsMaxClubbedAnalytes);
      if (orderSettingsLayoutMode === 'compact') {
        await handleLocalCompactPrint(orderSettingsOrderId, orderSettingsGroups, orderSettingsMaxClubbedAnalytes);
      } else {
        await handleLetterheadGeneration(orderSettingsOrderId, orderSettingsLayoutMode);
      }
    } catch (error) {
      console.error('Failed to regenerate print from order settings:', error);
      alert('Failed to regenerate print PDF.');
    } finally {
      setOrderSettingsSaving(false);
    }
  }, [handleLetterheadGeneration, handleLocalCompactPrint, orderSettingsGroups, orderSettingsLayoutMode, orderSettingsMaxClubbedAnalytes, orderSettingsOrderId, saveOrderReportSettings]);

  const handleRegenerateEcopyFromOrderSettings = useCallback(async () => {
    if (!orderSettingsOrderId) return;
    setOrderSettingsSaving(true);
    try {
      await saveOrderReportSettings(orderSettingsOrderId, orderSettingsGroups, orderSettingsLayoutMode, orderSettingsMaxClubbedAnalytes);
      const orderedGroupIds = orderSettingsGroups.map(g => g.testGroupId);
      const compactPageAssignments = Object.fromEntries(orderSettingsGroups.map(g => [g.testGroupId, g.pageNumber]));
      await handleLetterheadGeneration(orderSettingsOrderId, 'compact', 'compact-ecopy', {
        compactGroupOrder: orderedGroupIds,
        compactPageAssignments,
        compactMaxClubbedAnalytes: orderSettingsMaxClubbedAnalytes,
      });
    } catch (error) {
      console.error('Failed to regenerate eCopy from order settings:', error);
      alert('Failed to regenerate eCopy PDF.');
    } finally {
      setOrderSettingsSaving(false);
    }
  }, [handleLetterheadGeneration, orderSettingsGroups, orderSettingsLayoutMode, orderSettingsMaxClubbedAnalytes, orderSettingsOrderId, saveOrderReportSettings]);

  const prepareReportData = async (group: OrderGroup): Promise<PreparedReport> => {
    const { data: context, error } = await database.reports.getTemplateContext(group.order_id);
    if (error || !context) {
      console.error('Failed to load report context for order', group.order_id, error);
      throw new Error('Could not load report data for this order');
    }

    if (!Array.isArray(context.analytes) || context.analytes.length === 0) {
      throw new Error('No analyte data is available for this order');
    }

    const isDraft = context.meta?.allAnalytesApproved !== true;

    let selectedTemplate: LabTemplateRecord | null = null;
    try {
      const { data: templates, error: templateError } = await database.labTemplates.list();
      if (templateError) {
        console.warn('Unable to load lab templates for report preparation:', templateError);
      } else if (Array.isArray(templates) && templates.length > 0) {
        selectedTemplate = selectTemplateForContext(templates as LabTemplateRecord[], context);
      }
    } catch (templateFetchError) {
      console.warn('Unexpected error fetching lab templates:', templateFetchError);
    }

    return createReportDataFromContext(context, {
      template: selectedTemplate,
      isDraft,
    });
  };

  const toggleOrderSelection = (orderId: string) => {
    const next = new Set(selectedOrders);
    if (next.has(orderId)) next.delete(orderId);
    else next.add(orderId);
    setSelectedOrders(next);
  };

  const selectAllOrders = () => setSelectedOrders(new Set(orderGroups.map((g) => g.order_id)));
  const clearSelection = () => setSelectedOrders(new Set());

  const dateFilterLabel = (() => {
    if (dateFilter === 'all') return 'All dates';
    if (dateFilter !== 'custom') return dateFilter;
    const pretty = (value: string) => {
      const parsed = parseLocalDateString(value);
      return parsed ? parsed.toLocaleDateString() : null;
    };
    const from = customStartDate ? pretty(customStartDate) : null;
    const to = customEndDate ? pretty(customEndDate) : null;
    if (from && to) return from === to ? from : `${from} to ${to}`;
    if (from) return `From ${from}`;
    if (to) return `Up to ${to}`;
    return 'All dates';
  })();

  const clearAllFilters = () => {
    setSearchTerm('');
    setSelectedStatus('all');
    setSelectedTestType('all');
    setSelectedDoctor('all');
    setSelectedAccount('all');
    setDateFilter('today');
    setCustomStartDate('');
    setCustomEndDate('');
    setSortField(DEFAULT_REPORT_SORT.field);
    setSortDirection(DEFAULT_REPORT_SORT.direction);
  };

  const getReportUrlForQueue = (result?: ApprovedResult | null): string | null => {
    const finalReport = result?.final_report;
    const candidates = [
      finalReport?.pdf_url,
      result?.compact_ecopy_url,
      finalReport?.compact_ecopy_url,
      finalReport?.print_pdf_url,
      result?.print_pdf_url,
    ].filter(Boolean) as string[];

    const usableUrl = candidates.find((url) => !isTempPdfUrl(url)) || candidates[0];
    return usableUrl ? convertToCustomDomain(usableUrl) || usableUrl : null;
  };

  const queueSelectedReportsForWhatsApp = async () => {
    if (selectedOrders.size === 0) {
      alert('Please select at least one order');
      return;
    }

    if (!userLabId) {
      alert('Lab context not available. Please refresh and try again.');
      return;
    }

    setIsQueueingSelectedReports(true);

    try {
      const selectedGroups = Array.from(selectedOrders)
        .map((orderId) => orderGroups.find((group) => group.order_id === orderId))
        .filter(Boolean) as OrderGroup[];

      const queueRows: any[] = [];
      const skipped: string[] = [];
      const candidateOrderIds: string[] = [];

      for (const group of selectedGroups) {
        const result = group.results[0] as ApprovedResult | undefined;
        const reportUrl = getReportUrlForQueue(result);
        const patientPhone = result?.phone;

        if (!reportUrl) {
          skipped.push(`${group.patient_full_name}: report PDF missing`);
          continue;
        }

        if (!patientPhone) {
          skipped.push(`${group.patient_full_name}: phone missing`);
          continue;
        }

        const testName = (group.test_names || []).join(', ') || 'lab';
        candidateOrderIds.push(group.order_id);
        queueRows.push({
          lab_id: userLabId,
          recipient_type: 'patient',
          recipient_phone: patientPhone,
          recipient_name: group.patient_full_name,
          recipient_id: group.patient_id,
          trigger_type: 'report_ready',
          order_id: group.order_id,
          report_id: result?.final_report?.id || null,
          message_content: `Hello ${group.patient_full_name}, your ${testName} report is ready. Please find it attached.`,
          attachment_url: reportUrl,
          attachment_type: 'report',
          status: 'pending',
          scheduled_for: new Date().toISOString(),
          last_error: 'Queued manually from Reports page',
        });
      }

      if (queueRows.length === 0) {
        alert(`No selected reports could be queued.\n\n${skipped.slice(0, 8).join('\n')}`);
        return;
      }

      const { data: existingQueue, error: existingError } = await supabase
        .from('notification_queue')
        .select('order_id')
        .eq('lab_id', userLabId)
        .eq('recipient_type', 'patient')
        .eq('trigger_type', 'report_ready')
        .in('status', ['pending', 'scheduled', 'sending'])
        .in('order_id', candidateOrderIds);

      if (existingError) throw existingError;

      const alreadyQueued = new Set((existingQueue || []).map((row: any) => row.order_id));
      const rowsToInsert = queueRows.filter((row) => !alreadyQueued.has(row.order_id));

      if (rowsToInsert.length === 0) {
        alert('All valid selected reports are already in the WhatsApp queue.');
        return;
      }

      const { error: insertError } = await supabase
        .from('notification_queue')
        .insert(rowsToInsert);

      if (insertError) throw insertError;

      clearSelection();

      let processorMessage = 'Queue processor will send them in the background.';
      try {
        const { data: processorData, error: processorError } = await supabase.functions.invoke('process-notification-queue', {
          body: { labId: userLabId, limit: Math.max(rowsToInsert.length, 10) },
        });

        if (processorError) {
          processorMessage = 'Queued, but automatic processing did not start.';
          console.warn('Notification queue processor error:', processorError);
        } else if (processorData) {
          processorMessage = `Queue processed: ${processorData.sent || 0} sent, ${processorData.failed || 0} failed.`;
        }
      } catch (processorError) {
        processorMessage = 'Queued, but automatic processing did not start.';
        console.warn('Notification queue processor exception:', processorError);
      }

      const duplicateCount = queueRows.length - rowsToInsert.length;
      const parts = [`Queued ${rowsToInsert.length} report${rowsToInsert.length === 1 ? '' : 's'} for WhatsApp.`];
      if (duplicateCount > 0) parts.push(`${duplicateCount} already queued.`);
      if (skipped.length > 0) parts.push(`${skipped.length} skipped.`);
      parts.push(processorMessage);
      alert(parts.join(' '));
    } catch (error) {
      console.error('Failed to queue selected reports:', error);
      alert('Failed to queue selected reports: ' + (error instanceof Error ? error.message : 'Unknown error'));
    } finally {
      setIsQueueingSelectedReports(false);
    }
  };

  const generateReport = async () => {
    if (selectedOrders.size === 0) {
      alert('Please select at least one order');
      return;
    }

    if (!userLabId) {
      alert('Lab context not available. Please refresh and try again.');
      return;
    }

    setIsGeneratingSelectedReports(true);

    try {
      const { data: userData } = await supabase.auth.getUser();
      const triggeredByUserId = userData.user?.id;
      if (!triggeredByUserId) {
        alert('User not authenticated');
        return;
      }

      const selectedOrderIds = Array.from(selectedOrders);
      let queuedCount = 0;
      let errorCount = 0;
      const skipped: string[] = [];

      for (const orderId of selectedOrderIds) {
        const group = orderGroups.find((g) => g.order_id === orderId);
        if (!group) continue;

        if (!group.is_report_ready) {
          skipped.push(`${group.patient_full_name}: panels not ready`);
          errorCount++;
          continue;
        }

        try {
          const { data, error } = await supabase.functions.invoke('generate-pdf-letterhead', {
            body: {
              orderId,
              triggeredByUserId,
            },
          });

          if (error) {
            console.error(`Error generating report for order ${orderId}:`, error);
            skipped.push(`${group.patient_full_name}: ${error.message || 'edge function failed'}`);
            errorCount++;
            continue;
          }

          if (data?.error || data?.success === false) {
            const message = data?.message || data?.details || data?.error || 'generation rejected';
            console.error(`Report generation rejected for order ${orderId}:`, data);
            skipped.push(`${group.patient_full_name}: ${message}`);
            errorCount++;
            continue;
          }

          queuedCount++;
        } catch (e) {
          console.error(`Exception for order ${orderId}:`, e);
          skipped.push(`${group.patient_full_name}: ${e instanceof Error ? e.message : 'unknown error'}`);
          errorCount++;
        }
      }

      clearSelection();
      await pollPDFQueueStatus(selectedOrderIds, false);

      if (queuedCount > 0 && errorCount === 0) {
        alert(`Started PDF generation for ${queuedCount} report(s)`);
      } else if (queuedCount > 0 && errorCount > 0) {
        alert(`Started PDF generation for ${queuedCount} report(s), ${errorCount} skipped or failed.\n\n${skipped.slice(0, 8).join('\n')}`);
      } else {
        alert(`No reports were generated.\n\n${skipped.slice(0, 8).join('\n') || 'Please try again.'}`);
      }

      // Refresh the data to show updated report status
      await loadApprovedResults();
    } catch (e) {
      console.error('Error generating reports:', e);
      alert('An error occurred while generating reports');
    } finally {
      setIsGeneratingSelectedReports(false);
    }
  };

  const handleTemplatePreview = async () => {
    if (isTestingTemplate) {
      return;
    }

    let previewWindow: Window | null = null;
    let navigated = false;

    try {
      setIsTestingTemplate(true);

      previewWindow = window.open('', '_blank', 'noopener,noreferrer');
      if (previewWindow) {
        previewWindow.document.write(
          '<html><body style="font-family:Arial,sans-serif;padding:16px;">Generating template preview…</body></html>'
        );
      }

      const { data: templates, error } = await database.labTemplates.list();
      if (error) {
        console.error('Failed to load lab templates:', error);
        alert('Unable to load saved templates. Please try again.');
        return;
      }

      const typedTemplates: LabTemplateRecord[] = Array.isArray(templates)
        ? (templates as LabTemplateRecord[])
        : [];

      if (typedTemplates.length === 0) {
        alert('No saved templates found. Please create one in Template Studio first.');
        return;
      }

      const templateRecord = typedTemplates.find((tpl) => tpl.is_default) ?? typedTemplates[0];
      if (!templateRecord?.gjs_html) {
        alert('The selected template has no HTML content yet. Save your template in Template Studio before testing.');
        return;
      }

      let brandingDefaults: LabBrandingHtmlDefaults | undefined;
      try {
        const { data: labBranding, error: brandingError } = await database.labs.getBrandingDefaults();
        if (brandingError) {
          console.warn('Failed to load lab branding defaults:', brandingError);
        } else if (labBranding) {
          brandingDefaults = {
            headerHtml: labBranding.defaultReportHeaderHtml ?? null,
            footerHtml: labBranding.defaultReportFooterHtml ?? null,
          };
        }
      } catch (brandingFetchError) {
        console.warn('Unexpected error loading lab branding defaults for preview:', brandingFetchError);
      }

      const pdfUrl = await generateTemplatePreviewPDF(templateRecord, {
        brandingDefaults,
      });
      if (pdfUrl) {
        if (previewWindow) {
          previewWindow.location.replace(pdfUrl);
          navigated = true;
        } else {
          window.open(pdfUrl, '_blank', 'noopener');
        }
      } else {
        alert('Failed to generate template preview.');
      }
    } catch (error) {
      console.error('Template preview failed:', error);
      alert('Failed to generate template preview. Please try again.');
    } finally {
      setIsTestingTemplate(false);
      if (previewWindow && !navigated) {
        previewWindow.close();
      }
    }
  };

  const handleOrderTemplatePreview = async (group: OrderGroup) => {
    if (previewingOrderId) {
      return;
    }

    let previewWindow: Window | null = null;
    let navigated = false;

    try {
      setPreviewingOrderId(group.order_id);

      previewWindow = window.open('', '_blank', 'noopener,noreferrer');
      if (previewWindow) {
        previewWindow.document.write(
          '<html><body style="font-family:Arial,sans-serif;padding:16px;">Preparing patient template preview…</body></html>'
        );
      }

      const { data: templates, error } = await database.labTemplates.list();
      if (error) {
        console.error('Failed to load lab templates:', error);
        alert('Unable to load saved templates. Please try again.');
        return;
      }

      const typedTemplates: LabTemplateRecord[] = Array.isArray(templates)
        ? (templates as LabTemplateRecord[])
        : [];

      if (typedTemplates.length === 0) {
        alert('No saved templates found. Please create one in Template Studio first.');
        return;
      }

      const { data: context, error: contextError } = await database.reports.getTemplateContext(group.order_id);
      if (contextError || !context) {
        console.error('Failed to load template context for preview:', contextError);
        alert('Unable to load report data for this order. Please try again.');
        return;
      }

      if (!Array.isArray(context.analytes) || context.analytes.length === 0) {
        alert('No analyte data is available for this order yet. Capture result values before generating a template preview.');
        return;
      }

      const templateRecord = selectTemplateForContext(typedTemplates, context);
      if (!templateRecord || !templateRecord.gjs_html) {
        alert('No saved template with HTML content was found. Please create or update a template in the Template Studio.');
        return;
      }

      const pdfUrl = await generateTemplatePreviewPDF(
        templateRecord,
        {
          context,
          overrides: {
            preview_mode: true,
            preview_generated_at: new Date().toISOString(),
            report_is_draft: context.meta?.allAnalytesApproved !== true,
          },
          brandingDefaults: {
            headerHtml: (() => {
              const placeholders = (context.placeholderValues ?? {}) as Record<string, unknown>;
              if (typeof context.labBranding?.defaultHeaderHtml === 'string' && context.labBranding.defaultHeaderHtml.trim()) {
                return context.labBranding.defaultHeaderHtml;
              }
              const direct = placeholders['labDefaultHeaderHtml'];
              if (typeof direct === 'string' && direct.trim()) {
                return direct;
              }
              const snake = placeholders['lab_default_header_html'];
              if (typeof snake === 'string' && snake.trim()) {
                return snake;
              }
              return undefined;
            })(),
            footerHtml: (() => {
              const placeholders = (context.placeholderValues ?? {}) as Record<string, unknown>;
              if (typeof context.labBranding?.defaultFooterHtml === 'string' && context.labBranding.defaultFooterHtml.trim()) {
                return context.labBranding.defaultFooterHtml;
              }
              const direct = placeholders['labDefaultFooterHtml'];
              if (typeof direct === 'string' && direct.trim()) {
                return direct;
              }
              const snake = placeholders['lab_default_footer_html'];
              if (typeof snake === 'string' && snake.trim()) {
                return snake;
              }
              return undefined;
            })(),
          },
        },
        typedTemplates  // Pass all templates for multi-test-group support
      );
      if (pdfUrl) {
        if (previewWindow) {
          previewWindow.location.replace(pdfUrl);
          navigated = true;
        } else {
          window.open(pdfUrl, '_blank', 'noopener');
        }
      } else {
        alert('Failed to generate patient-specific template preview.');
      }
    } catch (error) {
      console.error('Order template preview failed:', error);
      alert('Failed to generate patient-specific template preview. Please try again.');
    } finally {
      setPreviewingOrderId(null);
      if (previewWindow && !navigated) {
        previewWindow.close();
      }
    }
  };

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('desc');
    }
  };

  // Print status for an order: used for the badge, row tint and button colours.
  const getPrintInfo = (group: OrderGroup) => {
    const result = group.results[0] as ApprovedResult | undefined;
    const printedAt = result?.printed_at || null;
    const printCount = result?.print_count ?? 0;
    return {
      printedAt,
      printCount,
      isPrinted: Boolean(printedAt),
      label: printedAt
        ? `Printed ${safeFormatDate(printedAt, 'MMM d, yyyy h:mm a')}${printCount > 1 ? ` • ${printCount} times` : ''}`
        : 'Not printed yet',
    };
  };

  const getPrintedBadge = (group: OrderGroup) => {
    const { isPrinted, printCount, label } = getPrintInfo(group);
    if (!isPrinted) return null;

    return (
      <span
        className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-slate-700 text-white border border-slate-800"
        title={label}
      >
        <Printer className="w-3 h-3 mr-1" />
        Printed{printCount > 1 ? ` ×${printCount}` : ''}
      </span>
    );
  };

  const getStatusBadge = (group: OrderGroup) => {
    const result = group.results[0] as ApprovedResult;

    if (result?.has_final_report) {
      return (
        <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800 border border-green-200">
          <CheckCircle className="w-3 h-3 mr-1" />
          Final Available
        </span>
      );
    }

    if (group.is_report_ready) {
      return (
        <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800 border border-green-200">
          <CheckCircle className="w-3 h-3 mr-1" />
          Fully Verified
        </span>
      );
    }

    if (result?.has_draft_report) {
      return (
        <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800 border border-blue-200">
          <FileCheck className="w-3 h-3 mr-1" />
          Draft Available
        </span>
      );
    }

    return (
      <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-amber-100 text-amber-800 border border-amber-200">
        <AlertTriangle className="w-3 h-3 mr-1" />
        Partial Verification
      </span>
    );
  };

  // Get PDF auto-generation status badge
  const getPDFAutoGenBadge = (orderId: string) => {
    const job = pdfQueueStatus.get(orderId);

    if (!job) return null;

    switch (job.status) {
      case 'pending':
        return (
          <div className="flex items-center space-x-2 px-3 py-1.5 bg-yellow-50 border border-yellow-200 rounded-md">
            <Clock className="w-4 h-4 text-yellow-600 animate-pulse" />
            <div className="flex flex-col">
              <span className="text-xs font-medium text-yellow-800">Queued for Auto-Generation</span>
              <button
                onClick={async () => {
                  try {
                    const { data, error } = await database.pdfQueue.triggerGeneration(orderId);
                    if (error) {
                      console.error('Failed to trigger generation:', error);
                    } else {
                      console.log('✅ Generation complete:', data);
                    }
                    // Poll immediately after completion
                    await pollPDFQueueStatus([orderId]);
                    // Reload to get updated report info
                    await loadApprovedResults();
                  } catch (error) {
                    console.error('Failed to trigger generation:', error);
                    await pollPDFQueueStatus([orderId]);
                  }
                }}
                className="text-xs text-yellow-700 hover:text-yellow-900 font-medium mt-1 text-left underline"
              >
                Generate Now
              </button>
            </div>
          </div>
        );

      case 'processing':
        // Animated progress stages for better UX
        const progressPercent = job.progress_percent || 0;
        const progressStage = job.progress_stage || 'Initializing...';

        // The link already resolves to a real PDF, so the remaining work is the
        // storage upload happening behind a URL the user can already open. Say
        // that plainly instead of showing a spinner that implies "not ready".
        if (isReportLinkViewable(orderId)) {
          return (
            <div className="flex items-center space-x-2 px-2 py-1 bg-green-50 border border-green-200 rounded-md">
              <CheckCircle className="w-3.5 h-3.5 text-green-600" />
              <div className="flex flex-col">
                <span className="text-xs font-medium text-green-800">Report ready</span>
                <span className="text-[10px] text-green-600">
                  Saving to storage in background ({progressPercent}%)
                </span>
              </div>
            </div>
          );
        }

        // Determine stage icon and color based on progress
        const getStageInfo = (percent: number) => {
          if (percent < 20) return { stage: 'Fetching data', icon: '📊' };
          if (percent < 40) return { stage: 'Loading template', icon: '🎨' };
          if (percent < 60) return { stage: 'Rendering HTML', icon: '🔧' };
          if (percent < 80) return { stage: 'Generating PDF', icon: '📄' };
          if (percent < 95) return { stage: 'Uploading', icon: '☁️' };
          return { stage: 'Finalizing', icon: '✨' };
        };

        const stageInfo = getStageInfo(progressPercent);

        return (
          <div className="flex flex-col space-y-2 px-3 py-2 bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-lg shadow-sm">
            {/* Header with animated spinner */}
            <div className="flex items-center space-x-2">
              <div className="relative">
                <Loader2 className="w-5 h-5 text-blue-600 animate-spin" />
                <div className="absolute inset-0 w-5 h-5 border-2 border-blue-200 rounded-full animate-ping opacity-20"></div>
              </div>
              <div className="flex flex-col flex-1">
                <span className="text-xs font-semibold text-blue-800">Generating PDF...</span>
                <span className="text-xs text-blue-600 flex items-center">
                  <span className="mr-1">{stageInfo.icon}</span>
                  {progressStage || stageInfo.stage}
                </span>
              </div>
              <span className="text-sm font-bold text-blue-700">{progressPercent}%</span>
            </div>

            {/* Animated progress bar */}
            <div className="relative w-full h-2 bg-blue-100 rounded-full overflow-hidden">
              {/* Background shimmer effect */}
              <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/30 to-transparent animate-shimmer"></div>
              {/* Actual progress */}
              <div
                className="h-full bg-gradient-to-r from-blue-500 via-blue-600 to-indigo-500 rounded-full transition-all duration-500 ease-out relative overflow-hidden"
                style={{ width: `${Math.max(progressPercent, 5)}%` }}
              >
                {/* Moving shine effect on progress bar */}
                <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/40 to-transparent animate-shine"></div>
              </div>
            </div>

            {/* Helpful message */}
            <p className="text-[10px] text-blue-500 italic animate-pulse">
              {progressPercent < 50
                ? '⏳ Please wait, preparing your report...'
                : progressPercent < 90
                  ? '🚀 Almost there, generating PDF...'
                  : '✅ Finishing up, just a moment...'}
            </p>
          </div>
        );

      case 'completed':
        return (
          <div className="flex items-center space-x-2 px-2 py-1 bg-green-50 border border-green-200 rounded-md">
            <CheckCircle className="w-3.5 h-3.5 text-green-600" />
            <span className="text-xs font-medium text-green-800">Auto-Generated</span>
          </div>
        );

      case 'failed':
        return (
          <div className="flex items-center space-x-2 px-3 py-1.5 bg-red-50 border border-red-200 rounded-md">
            <XCircle className="w-4 h-4 text-red-600" />
            <div className="flex flex-col">
              <span className="text-xs font-medium text-red-800">Generation Failed</span>
              {job.error_message && (
                <span className="text-xs text-red-600 truncate max-w-xs" title={job.error_message}>
                  {job.error_message}
                </span>
              )}
              <button
                onClick={async () => {
                  await database.pdfQueue.retryJob(job.id);
                  await pollPDFQueueStatus([orderId]);
                }}
                className="text-xs text-red-700 hover:text-red-800 font-medium mt-1 text-left"
              >
                Retry Generation
              </button>
            </div>
          </div>
        );

      default:
        return null;
    }
  };

  const LoadingSkeleton = () => (
    <div className="space-y-4">
      {[...Array(5)].map((_, i) => (
        <div key={i} className="bg-white rounded-lg border border-gray-200 p-6 animate-pulse">
	              <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center space-x-4">
              <div className="w-4 h-4 bg-gray-200 rounded"></div>
              <div className="space-y-2">
                <div className="h-4 bg-gray-200 rounded w-48"></div>
                <div className="h-3 bg-gray-200 rounded w-32"></div>
              </div>
            </div>
            <div className="flex space-x-2">
              <div className="h-8 w-16 bg-gray-200 rounded"></div>
              <div className="h-8 w-24 bg-gray-200 rounded"></div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );

  const EmptyState = () => (
    <div className="bg-white rounded-lg border border-gray-200 p-12 text-center">
      <div className="mx-auto w-24 h-24 bg-gray-100 rounded-full flex items-center justify-center mb-6">
        <FileText className="w-12 h-12 text-gray-400" />
      </div>
      <h3 className="text-lg font-semibold text-gray-900 mb-2">No Reports Found</h3>
      <p className="text-gray-600 mb-6 max-w-md mx-auto">
        No approved results match your current filters. Try adjusting your search criteria or date range.
      </p>
      <div className="flex justify-center space-x-3">
        <button
          onClick={clearAllFilters}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
        >
          Clear All Filters
        </button>
        <button
          onClick={loadApprovedResults}
          className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
        >
          Refresh Data
        </button>
      </div>
    </div>
  );

  const mobile = useMobileOptimizations();

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Enhanced Header - Mobile optimized */}
      <div className={`bg-white border-b shadow-sm ${mobile.containerPadding} ${mobile.headerPadding} safe-area-x`}>
        <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4">
          <div className="flex-1 min-w-0">
            <h1 className={`${mobile.titleSize} font-bold text-gray-900`}>Lab Reports</h1>
            <p className={`${mobile.textSize} text-gray-600 mt-1 ${mobile.isMobile ? '' : 'md:mt-2'}`}>
              {mobile.isMobile ? 'Generate & manage reports' : 'Generate and manage laboratory test reports'}
            </p>
          </div>

          {/* Quick Stats */}
          <div className="hidden lg:flex items-center space-x-6">
            <div className="text-center">
              <div className="text-2xl font-bold text-blue-600">{statistics.totalOrders}</div>
              <div className="text-xs text-gray-500">Total Orders</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-green-600">{statistics.readyForGeneration}</div>
              <div className="text-xs text-gray-500">Fully Verified</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-amber-600">{statistics.pendingVerification}</div>
              <div className="text-xs text-gray-500">Pending Verification</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-gray-600">{statistics.finalReports}</div>
              <div className="text-xs text-gray-500">Final Reports</div>
            </div>
          </div>

          <div className="flex items-center space-x-3">
            <button
              onClick={handleTemplatePreview}
              className={`flex items-center space-x-2 px-4 py-2 rounded-lg transition-colors ${isTestingTemplate
                ? 'bg-purple-400 text-white cursor-not-allowed opacity-80'
                : 'bg-purple-600 text-white hover:bg-purple-700'
                }`}
              disabled={isTestingTemplate}
            >
              {isTestingTemplate ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Wand2 className="w-4 h-4" />
              )}
              <span>{isTestingTemplate ? 'Generating…' : 'Preview Saved Template'}</span>
            </button>
            <button
              onClick={loadApprovedResults}
              className="flex items-center space-x-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:cursor-not-allowed disabled:opacity-70"
              disabled={loading}
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              <span>Refresh</span>
            </button>
          </div>
        </div>
      </div>

      {/* Enhanced Filters Section */}
      <div className="bg-white border-b shadow-sm px-4 md:px-6 py-4 safe-area-x">
        <div className="space-y-4">
          {/* Primary Search Bar */}
          <div className="flex flex-col sm:flex-row gap-3 md:gap-4">
            <div className="flex-1 relative min-w-0">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 md:w-5 md:h-5 text-gray-400" />
              <input
                type="text"
                placeholder="Search patients, tests, samples..."
                className="w-full pl-9 md:pl-10 pr-4 py-2.5 md:py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-sm md:text-base"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
              {searchTerm && (
                <button
                  onClick={() => setSearchTerm('')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
	            <button
	              onClick={() => setShowFilters(!showFilters)}
	              className={`flex items-center space-x-2 px-4 py-3 border rounded-lg transition-colors ${showFilters ? 'bg-blue-50 border-blue-300 text-blue-700' : 'border-gray-300 text-gray-700 hover:bg-gray-50'
	                }`}
	            >
	              <Filter className="w-4 h-4" />
	              <span>Filters</span>
	              {(selectedStatus !== 'all' || selectedTestType !== 'all' || selectedDoctor !== 'all' || selectedAccount !== 'all' || dateFilter !== 'today') && (
	                <span className="w-2 h-2 bg-blue-500 rounded-full"></span>
	              )}
	            </button>
	            <button
	              onClick={selectAllOrders}
	              disabled={orderGroups.length === 0 || selectedOrders.size === orderGroups.length}
	              className="flex items-center justify-center space-x-2 px-4 py-3 border border-blue-200 text-blue-700 rounded-lg hover:bg-blue-50 transition-colors disabled:cursor-not-allowed disabled:opacity-60"
	            >
	              <CheckCircle className="w-4 h-4" />
	              <span>{selectedOrders.size === orderGroups.length && orderGroups.length > 0 ? 'All Selected' : 'Select All'}</span>
	            </button>
	          </div>

          {/* Advanced Filters */}
          {showFilters && (
            <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
	              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Date Range</label>
                  <select
                    value={dateFilter}
                    onChange={(e) => {
                      const next = e.target.value as DateFilter;
                      if (next === 'custom' && !customStartDate && !customEndDate) {
                        // Seed both ends with today so switching over doesn't load every record.
                        const today = toLocalDateString(new Date());
                        setCustomStartDate(today);
                        setCustomEndDate(today);
                      }
                      setDateFilter(next);
                    }}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  >
                    <option value="today">Today</option>
                    <option value="yesterday">Yesterday</option>
                    <option value="week">This Week</option>
                    <option value="month">This Month</option>
                    <option value="custom">Custom Range</option>
                    <option value="all">All Dates</option>
                  </select>
                </div>

                {dateFilter === 'custom' && (
                  <>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">From Date</label>
                      <input
                        type="date"
                        value={customStartDate}
                        max={customEndDate || undefined}
                        onChange={(e) => setCustomStartDate(e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">To Date</label>
                      <input
                        type="date"
                        value={customEndDate}
                        min={customStartDate || undefined}
                        onChange={(e) => setCustomEndDate(e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                      />
                    </div>
                  </>
                )}

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Report Status</label>
                  <select
                    value={selectedStatus}
                    onChange={(e) => setSelectedStatus(e.target.value as any)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  >
                    <option value="all">All Statuses</option>
                    <option value="ready">Fully Verified</option>
                    <option value="pending">Pending Verification</option>
                    <option value="processing">Draft Available</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Test Type</label>
                  <select
                    value={selectedTestType}
                    onChange={(e) => setSelectedTestType(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  >
                    <option value="all">All Tests</option>
                    {uniqueTestTypes.map(type => (
                      <option key={type} value={type}>{type}</option>
                    ))}
                  </select>
                </div>

	                <div>
	                  <label className="block text-sm font-medium text-gray-700 mb-2">Doctor</label>
                  <select
                    value={selectedDoctor}
                    onChange={(e) => setSelectedDoctor(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  >
                    <option value="all">All Doctors</option>
                    {uniqueDoctors.map(doctor => (
                      <option key={doctor} value={doctor}>{doctor}</option>
                    ))}
	                  </select>
	                </div>

	                <div>
	                  <label className="block text-sm font-medium text-gray-700 mb-2">B2B Client</label>
	                  <select
	                    value={selectedAccount}
	                    onChange={(e) => setSelectedAccount(e.target.value)}
	                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
	                  >
	                    <option value="all">All B2B Clients</option>
	                    {uniqueAccounts.map(account => (
	                      <option key={account} value={account}>{account}</option>
	                    ))}
	                  </select>
	                </div>

	                <div>
	                  <label className="block text-sm font-medium text-gray-700 mb-2">Sort By</label>
	                  <select
	                    value={`${sortField}:${sortDirection}`}
	                    onChange={(e) => {
	                      const [field, direction] = e.target.value.split(':') as [SortField, SortDirection];
	                      setSortField(field);
	                      setSortDirection(direction);
	                    }}
	                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
	                  >
	                    <option value="sample_id:desc">Sample ID newest first</option>
	                    <option value="sample_id:asc">Sample ID oldest first</option>
	                    <option value="verified_at:desc">Verified newest first</option>
	                    <option value="order_date:desc">Order date newest first</option>
	                    <option value="patient_name:asc">Patient A-Z</option>
	                  </select>
	                </div>
	              </div>

              <div className="flex items-center justify-between mt-4 pt-4 border-t border-gray-200">
                <div className="text-sm text-gray-600">
                  {orderGroups.length} orders found
                </div>
                <div className="flex space-x-2">
                  <button
                    onClick={clearAllFilters}
                    className="px-3 py-1 text-sm text-gray-600 border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
                  >
                    Clear All
                  </button>
                  <button
                    onClick={() => setShowFilters(false)}
                    className="px-3 py-1 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
                  >
                    Apply Filters
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Selection Actions */}
          {selectedOrders.size > 0 && (
            <div className="bg-blue-50 rounded-lg p-4 border border-blue-200">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center space-x-3">
                  <span className="text-sm font-medium text-blue-900">
                    {selectedOrders.size} order{selectedOrders.size !== 1 ? 's' : ''} selected
                  </span>
                  <button
                    onClick={clearSelection}
                    className="text-sm text-blue-700 hover:text-blue-900 underline"
                  >
                    Clear selection
                  </button>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <button
                    onClick={queueSelectedReportsForWhatsApp}
                    disabled={isQueueingSelectedReports}
                    className={`flex items-center space-x-2 px-4 py-2 rounded-md transition-colors ${
                      isQueueingSelectedReports
                        ? 'bg-emerald-300 text-white cursor-not-allowed'
                        : 'bg-emerald-600 text-white hover:bg-emerald-700'
                    }`}
                  >
                    {isQueueingSelectedReports ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Send className="w-4 h-4" />
                    )}
                    <span>{isQueueingSelectedReports ? 'Queueing...' : 'Queue WhatsApp'}</span>
                  </button>
                  <button
                    onClick={handleBulkPrintSelectedReports}
                    disabled={isBulkPrintingSelectedReports}
                    className={`flex items-center space-x-2 px-4 py-2 rounded-md transition-colors ${
                      isBulkPrintingSelectedReports
                        ? 'bg-indigo-300 text-white cursor-not-allowed'
                        : 'bg-indigo-600 text-white hover:bg-indigo-700'
                    }`}
                    title="Merge the generated print PDFs of the selected orders into one PDF for printing"
                  >
                    {isBulkPrintingSelectedReports ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Printer className="w-4 h-4" />
                    )}
                    <span>{isBulkPrintingSelectedReports ? (bulkPrintProgress || 'Merging…') : 'Bulk Print'}</span>
                  </button>
                  <button
                    onClick={handleDeleteSelectedReports}
                    disabled={isDeletingSelectedReports}
                    className={`flex items-center space-x-2 px-4 py-2 rounded-md transition-colors ${
                      isDeletingSelectedReports
                        ? 'bg-red-300 text-white cursor-not-allowed'
                        : 'bg-red-600 text-white hover:bg-red-700'
                    }`}
                  >
                    {isDeletingSelectedReports ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Trash2 className="w-4 h-4" />
                    )}
                    <span>{isDeletingSelectedReports ? 'Deleting...' : 'Delete Generated Report'}</span>
                  </button>
                  <button
                    onClick={generateReport}
                    disabled={isGeneratingSelectedReports}
                    className={`flex items-center space-x-2 px-4 py-2 rounded-md transition-colors ${
                      isGeneratingSelectedReports
                        ? 'bg-green-300 text-white cursor-not-allowed'
                        : 'bg-green-600 text-white hover:bg-green-700'
                    }`}
                  >
                    {isGeneratingSelectedReports ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <FileText className="w-4 h-4" />
                    )}
                    <span>{isGeneratingSelectedReports ? 'Generating...' : 'Generate Reports'}</span>
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Main Content */}
      <div className="p-6">
        {/* Statistics Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
            <div className="flex items-center">
              <div className="bg-blue-100 p-3 rounded-lg">
                <FileText className="h-6 w-6 text-blue-600" />
              </div>
              <div className="ml-4">
                <div className="text-2xl font-bold text-gray-900">{statistics.totalOrders}</div>
                <div className="text-sm text-gray-600">Total Orders</div>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
            <div className="flex items-center">
              <div className="bg-green-100 p-3 rounded-lg">
                <CheckCircle className="h-6 w-6 text-green-600" />
              </div>
              <div className="ml-4">
                <div className="text-2xl font-bold text-gray-900">{statistics.readyForGeneration}</div>
                <div className="text-sm text-gray-600">Fully Verified</div>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
            <div className="flex items-center">
              <div className="bg-amber-100 p-3 rounded-lg">
                <Clock className="h-6 w-6 text-amber-600" />
              </div>
              <div className="ml-4">
                <div className="text-2xl font-bold text-gray-900">{statistics.pendingVerification}</div>
                <div className="text-sm text-gray-600">Pending Verification</div>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
            <div className="flex items-center">
              <div className="bg-purple-100 p-3 rounded-lg">
                <TrendingUp className="h-6 w-6 text-purple-600" />
              </div>
              <div className="ml-4">
                <div className="text-2xl font-bold text-gray-900">{statistics.finalReports}</div>
                <div className="text-sm text-gray-600">Final Reports</div>
              </div>
            </div>
          </div>
        </div>

        {/* Results Section */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200">
          <div className="px-6 py-4 border-b border-gray-200">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-semibold text-gray-900">Approved Results</h2>
                <p className="text-sm text-gray-600 mt-1">
                  {orderGroups.length} approved result orders
                </p>
              </div>

              <div className="flex items-center space-x-2">
                <button
                  onClick={selectAllOrders}
                  className="text-sm text-blue-600 hover:text-blue-700 underline"
                  disabled={orderGroups.length === 0}
                >
                  Select All
                </button>
                <button
                  onClick={clearSelection}
                  className="text-sm text-gray-600 hover:text-gray-700 underline"
                  disabled={selectedOrders.size === 0}
                >
                  Clear All
                </button>
              </div>
            </div>
          </div>

          {/* Table Header */}
          <div className="hidden lg:block border-b border-gray-200 bg-gray-50">
            <div className="px-6 py-3">
              <div className="grid grid-cols-12 gap-4 text-xs font-medium text-gray-500 uppercase tracking-wider">
                <div className="col-span-1">Select</div>
                <div className="col-span-3">
                  <button
                    onClick={() => handleSort('patient_name')}
                    className="flex items-center space-x-1 hover:text-gray-700"
                  >
                    <span>Patient Information</span>
                    {sortField === 'patient_name' && (
                      sortDirection === 'asc' ? <SortAsc className="w-3 h-3" /> : <SortDesc className="w-3 h-3" />
                    )}
                  </button>
                </div>
                <div className="col-span-2">
                  <button
                    onClick={() => handleSort('test_name')}
                    className="flex items-center space-x-1 hover:text-gray-700"
                  >
                    <span>Tests</span>
                    {sortField === 'test_name' && (
                      sortDirection === 'asc' ? <SortAsc className="w-3 h-3" /> : <SortDesc className="w-3 h-3" />
                    )}
                  </button>
                </div>
                <div className="col-span-2">
                  <button
                    onClick={() => handleSort('order_date')}
                    className="flex items-center space-x-1 hover:text-gray-700"
                  >
                    <span>Order Date</span>
                    {sortField === 'order_date' && (
                      sortDirection === 'asc' ? <SortAsc className="w-3 h-3" /> : <SortDesc className="w-3 h-3" />
                    )}
                  </button>
                </div>
                <div className="col-span-4 text-right">Status</div>
              </div>
            </div>
          </div>

          {/* Results Content */}
          <div className="divide-y divide-gray-200">
            {loading ? (
              <div className="p-6">
                <LoadingSkeleton />
              </div>
            ) : orderGroups.length === 0 ? (
              <div className="p-6">
                <EmptyState />
              </div>
            ) : (
              <div className="max-h-[60vh] overflow-y-auto">
                {orderGroups.map((group, index) => (
                  <div
                    key={group.order_id}
                    className={`p-6 transition-colors border-l-4 ${getPrintInfo(group).isPrinted
                      ? 'border-l-slate-500 bg-slate-50 hover:bg-slate-100'
                      : `border-l-transparent hover:bg-gray-50 ${index % 2 === 0 ? 'bg-white' : 'bg-gray-25'}`
                      }`}
                  >
                    {/* Desktop View */}
                    <div className="hidden lg:block">
                      {/* Main Info Row */}
                      <div className="grid grid-cols-12 gap-4 items-center">
                        <div className="col-span-1">
                          <input
                            type="checkbox"
                            checked={selectedOrders.has(group.order_id)}
                            onChange={() => toggleOrderSelection(group.order_id)}
                            className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 w-4 h-4"
                          />
                        </div>

                        <div className="col-span-3">
                          <div className="flex items-center space-x-3">
                            <div className="bg-blue-100 p-2 rounded-full">
                              <User className="w-4 h-4 text-blue-600" />
                            </div>
                            <div>
                              <div className="font-semibold text-gray-900 text-base">
                                {group.patient_full_name}
                              </div>
                              <div className="text-sm text-gray-600">
                                {formatAge(group.age, (group as any).age_unit)} • {group.gender} • ID: {group.patient_id.slice(-8)}
                              </div>
                            </div>
                          </div>
                        </div>

                        <div className="col-span-2">
                          <div className="space-y-1">
                            {(group.test_names || []).map((testName, idx) => (
                              <div key={idx} className="flex items-center space-x-2">
                                <TestTube className="w-3 h-3 text-gray-400" />
                                <span className="text-sm text-gray-900">{testName}</span>
                              </div>
                            ))}
                          </div>
                        </div>

                        <div className="col-span-2">
                          <div className="text-sm">
                            <div className="font-medium text-gray-900">
                              {safeFormatDate(group.order_date, 'MMM d, yyyy')}
                            </div>
                            <div className="text-gray-600">
                              Sample: {(group.sample_ids || []).join(', ')}
                            </div>
                          </div>
                        </div>

                        <div className="col-span-4 flex items-center justify-end gap-2">
                          {getStatusBadge(group)}
                          {getPrintedBadge(group)}
                          {getPDFAutoGenBadge(group.order_id)}
                        </div>
                      </div>

                      {/* Action Buttons Row */}
                      <div className="mt-2 ml-12 flex flex-wrap items-center gap-1.5">
                        {/* View & Design */}
                        <button
                          className="flex items-center space-x-1 px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
                          onClick={() => handleView(group.order_id)}
                          title="Quick preview"
                        >
                          <Eye className="w-3.5 h-3.5" />
                          <span>View</span>
                        </button>

                        {/* Design button hidden — not functional yet */}

                        <span className="w-px h-4 bg-gray-300" />

                        {(group.is_report_ready || (group.results[0] as ApprovedResult)?.has_final_report || (group.results[0] as ApprovedResult)?.has_draft_report) ? (
                          <>
                            {!(group.results[0] as ApprovedResult)?.has_final_report ? (
                              /* Not generated yet */
                              <>
                                {(group.results[0] as ApprovedResult)?.has_draft_report && (
                                  <div className="flex items-center gap-0.5">
                                    <button
                                      className="flex items-center space-x-1 px-2 py-1 text-xs bg-amber-600 text-white rounded-l hover:bg-amber-700 transition-colors"
                                      onClick={() => {
                                        const url = (group.results[0] as ApprovedResult)?.draft_report?.pdf_url;
                                        if (url && !isTempPdfUrl(url)) window.open(url, '_blank');
                                        else void handleDownload(group.order_id, true, 'ecopy');
                                      }}
                                      title="Download eCopy draft"
                                    >
                                      <Download className="w-3.5 h-3.5" />
                                      <span>eCopy</span>
                                    </button>
                                    <button
                                      className={`flex items-center px-1.5 py-1 text-xs rounded-r transition-colors border-l border-amber-700 ${(group.results[0] as ApprovedResult)?.draft_report?.print_pdf_url ? 'bg-amber-500 text-white hover:bg-amber-600' : 'bg-gray-200 text-gray-500 cursor-not-allowed'}`}
                                      onClick={() => {
                                        const url = (group.results[0] as ApprovedResult)?.draft_report?.print_pdf_url;
                                        if (url) { window.open(url, '_blank'); void markOrderPrinted(group.order_id); }
                                      }}
                                      disabled={!(group.results[0] as ApprovedResult)?.draft_report?.print_pdf_url}
                                      title="Download print draft"
                                    >
                                      <Printer className="w-3.5 h-3.5" />
                                    </button>
                                  </div>
                                )}
                                {/* The report row still says "not generated" until the
                                    approved-results query refreshes, but the stable
                                    links already resolve to real PDFs. Offer them
                                    straight away rather than making the user wait for
                                    the storage upload and a list reload. */}
                                {(() => {
                                  const ecopyLink = getReadyReportLink(group.order_id, 'final');
                                  const printLink = getReadyReportLink(group.order_id, 'print');
                                  if (!ecopyLink && !printLink) return null;
                                  return (
                                    <div className="flex items-center gap-0.5">
                                      {ecopyLink && (
                                        <button
                                          className={`flex items-center space-x-1 px-2 py-1 text-xs bg-green-600 text-white hover:bg-green-700 transition-colors ${printLink ? 'rounded-l' : 'rounded'}`}
                                          onClick={() => window.open(ecopyLink, '_blank')}
                                          title="Download eCopy (link stays valid permanently)"
                                        >
                                          <Download className="w-3.5 h-3.5" />
                                          <span>Download</span>
                                        </button>
                                      )}
                                      {printLink && (
                                        <button
                                          className={`flex items-center px-1.5 py-1 text-xs bg-emerald-600 text-white hover:bg-emerald-700 transition-colors border-l border-emerald-800 ${ecopyLink ? 'rounded-r' : 'rounded'}`}
                                          onClick={() => {
                                            window.open(printLink, '_blank');
                                            void markOrderPrinted(group.order_id);
                                          }}
                                          title="Print copy (link stays valid permanently)"
                                        >
                                          <Printer className="w-3.5 h-3.5" />
                                        </button>
                                      )}
                                    </div>
                                  );
                                })()}
                                <button
                                  className={`flex items-center space-x-1 px-2 py-1 text-xs bg-green-600 text-white rounded hover:bg-green-700 transition-colors ${(isOrderBusy(group.order_id)) ? 'opacity-50 cursor-not-allowed' : ''}`}
                                  onClick={() => handleDownload(group.order_id, false)}
                                  disabled={isOrderBusy(group.order_id)}
                                  title="Generate final report"
                                >
                                  {(isOrderBusy(group.order_id)) ? (
                                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                  ) : (
                                    <Download className="w-3.5 h-3.5" />
                                  )}
                                  <span>Generate</span>
                                </button>
                                {(() => {
                                  const job = pdfQueueStatus.get(group.order_id);
                                  const isStuck = job && (job.status === 'processing' || job.status === 'pending') &&
                                    Date.now() - new Date(job.started_at ?? job.created_at).getTime() > 60_000;
                                  if (!isStuck) return null;
                                  return (
                                    <button
                                      className="flex items-center space-x-1 px-2 py-1 text-xs bg-red-100 text-red-700 rounded hover:bg-red-200 transition-colors border border-red-300"
                                      onClick={() => handleRetryStuckJob(group.order_id, false)}
                                      title="Job appears stuck — click to delete and retry"
                                    >
                                      <RefreshCw className="w-3 h-3" />
                                      <span>Retry</span>
                                    </button>
                                  );
                                })()}
                                <button
                                  className="flex items-center px-1.5 py-1 text-xs bg-gray-200 text-gray-700 rounded hover:bg-gray-300 transition-colors"
                                  onClick={() => handleOpenPDFSettings(group.order_id)}
                                  title="PDF Settings"
                                >
                                  <Settings className="w-3.5 h-3.5" />
                                </button>
                              </>
                            ) : (
                              /* Already generated */
                              <>
                                <button
                                  className={`flex items-center space-x-1 px-2 py-1 text-xs rounded transition-colors ${isTempPdfUrl((group.results[0] as ApprovedResult)?.final_report?.pdf_url) ? 'bg-amber-500 text-white hover:bg-amber-600' : 'bg-green-600 text-white hover:bg-green-700'} ${isPdfGenerating(group.order_id, 'ecopy') ? 'opacity-60 cursor-not-allowed' : ''}`}
                                  onClick={() => {
                                    const finalReport = (group.results[0] as ApprovedResult)?.final_report;
	                                    if (finalReport?.pdf_url && !isTempPdfUrl(finalReport.pdf_url)) { window.open(finalReport.pdf_url, '_blank'); return; }
	                                    const compactUrl = (group.results[0] as ApprovedResult)?.compact_ecopy_url || finalReport?.compact_ecopy_url || finalReport?.print_pdf_url;
	                                    if (compactUrl) { window.open(compactUrl, '_blank'); return; }
	                                    void handleLetterheadGeneration(group.order_id, 'standard', 'ecopy');
                                  }}
                                  disabled={isPdfGenerating(group.order_id, 'ecopy')}
                                  title={isPdfGenerating(group.order_id, 'ecopy') ? 'Generating eCopy…' : isTempPdfUrl((group.results[0] as ApprovedResult)?.final_report?.pdf_url) ? 'PDF link expired — click to regenerate' : 'Download final report'}
                                >
                                  {isPdfGenerating(group.order_id, 'ecopy') ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                                  <span>{isPdfGenerating(group.order_id, 'ecopy') ? 'Gen…' : isTempPdfUrl((group.results[0] as ApprovedResult)?.final_report?.pdf_url) ? 'Re-gen' : 'Download'}</span>
                                </button>

                                <button
                                  className={`flex items-center space-x-1 px-1.5 py-1 text-xs rounded transition-colors ${getPrintInfo(group).isPrinted ? 'bg-slate-700 text-white hover:bg-slate-800' : (group.results[0] as ApprovedResult)?.final_report?.print_pdf_url ? 'bg-emerald-600 text-white hover:bg-emerald-700' : 'bg-gray-200 text-gray-700 hover:bg-gray-300'} ${isPdfGenerating(group.order_id, 'compact-print') ? 'opacity-60 cursor-not-allowed' : ''}`}
                                  onClick={() => {
                                    const printUrl = (group.results[0] as ApprovedResult)?.final_report?.print_pdf_url;
                                    if (printUrl) { window.open(printUrl, '_blank'); void markOrderPrinted(group.order_id); return; }
                                    void handleLetterheadGeneration(group.order_id, 'compact', 'compact-print');
                                  }}
                                  onContextMenu={(e) => { e.preventDefault(); if (window.confirm('Regenerate compact print PDF?')) void handleLetterheadGeneration(group.order_id, 'compact', 'compact-print'); }}
                                  disabled={isPdfGenerating(group.order_id, 'compact-print')}
                                  title={isPdfGenerating(group.order_id, 'compact-print') ? 'Generating compact print…' : getPrintInfo(group).isPrinted ? `${getPrintInfo(group).label} — click to print again` : (group.results[0] as ApprovedResult)?.final_report?.print_pdf_url ? 'Open compact print PDF. Right-click to regenerate.' : 'Generate compact print PDF'}
                                >
                                  {isPdfGenerating(group.order_id, 'compact-print') ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Printer className="w-3.5 h-3.5" />}
                                  {getPrintInfo(group).isPrinted && <CheckCircle className="w-3 h-3" />}
                                </button>
                                <button
                                  className={`flex items-center px-1.5 py-1 text-xs rounded transition-colors ${(group.results[0] as ApprovedResult)?.compact_ecopy_url ? 'bg-indigo-600 text-white hover:bg-indigo-700' : 'bg-gray-200 text-gray-700 hover:bg-gray-300'} ${isPdfGenerating(group.order_id, 'compact-ecopy') ? 'opacity-60 cursor-not-allowed' : ''}`}
                                  onClick={() => {
                                    const ecopyUrl = (group.results[0] as ApprovedResult)?.compact_ecopy_url;
                                    if (ecopyUrl) { window.open(ecopyUrl, '_blank'); return; }
                                    void handleLetterheadGeneration(group.order_id, 'compact', 'compact-ecopy');
                                  }}
                                  onContextMenu={(e) => { e.preventDefault(); if (window.confirm('Regenerate compact eCopy PDF?')) void handleLetterheadGeneration(group.order_id, 'compact', 'compact-ecopy'); }}
                                  disabled={isPdfGenerating(group.order_id, 'compact-ecopy')}
                                  title={isPdfGenerating(group.order_id, 'compact-ecopy') ? 'Generating compact eCopy…' : (group.results[0] as ApprovedResult)?.compact_ecopy_url ? 'Open compact eCopy PDF. Right-click to regenerate.' : 'Generate compact eCopy PDF'}
                                >
                                  {isPdfGenerating(group.order_id, 'compact-ecopy') ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileText className="w-3.5 h-3.5" />}
                                </button>

                                <button
                                  className="flex items-center px-1.5 py-1 text-xs bg-gray-200 text-gray-700 rounded hover:bg-gray-300 transition-colors"
                                  onClick={() => handleOpenPDFSettings(group.order_id)}
                                  title="Settings"
                                >
                                  <Settings className="w-3.5 h-3.5" />
                                </button>

                                <span className="w-px h-4 bg-gray-300" />

                                <button
                                  className="flex items-center space-x-1 px-2 py-1 text-xs bg-gradient-to-r from-pink-500 to-rose-500 text-white rounded hover:from-pink-600 hover:to-rose-600 transition-colors"
                                  onClick={() => {
                                    const smartUrl = (group.results[0] as ApprovedResult)?.smart_report_url;
                                    if (smartUrl) window.open(smartUrl, '_blank');
                                    else handleSmartReport(group.order_id);
                                  }}
                                  onContextMenu={(e) => {
                                    e.preventDefault();
                                    if (window.confirm('Regenerate Smart Report? This will create a new AI-enhanced report.')) {
                                      handleSmartReport(group.order_id, true);
                                    }
                                  }}
                                  disabled={smartReportLoadingId === group.order_id}
                                  title={`AI Smart Report${(group.results[0] as ApprovedResult)?.smart_report_url ? ' (cached - right-click to regenerate)' : ''}`}
                                >
                                  {smartReportLoadingId === group.order_id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                                  <span>Smart</span>
                                </button>

                                {/* Smart Report WhatsApp */}
                                {(() => {
                                  const result = group.results[0] as ApprovedResult;
                                  const smartReportUrl = result?.smart_report_url;
                                  const customDomainSmartUrl = smartReportUrl ? convertToCustomDomain(smartReportUrl) : smartReportUrl;
                                  if (customDomainSmartUrl) {
                                    return (
                                      <QuickSendReport
                                        reportUrl={customDomainSmartUrl}
                                        reportName={`Smart Report - ${group.patient_full_name} - ${(group.test_names || []).join(', ')}`}
                                        patientName={group.patient_full_name}
                                        patientPhone={result?.phone}
                                        testName={(group.test_names || []).join(', ')}
                                        label="Smart Report via WhatsApp"
                                        onSent={(result) => alert(result.success ? 'Smart Report sent via WhatsApp!' : 'Failed: ' + result.message)}
                                      />
                                    );
                                  }
                                  return null;
                                })()}

                                {/* WhatsApp & Doctor */}
                                {(() => {
                                  const result = group.results[0] as ApprovedResult;
	                                  const reportUrl = result?.final_report?.pdf_url || result?.compact_ecopy_url || result?.final_report?.compact_ecopy_url;
                                  const customDomainReportUrl = reportUrl ? convertToCustomDomain(reportUrl) : reportUrl;
                                  if (result?.has_final_report || result?.final_report) {
                                    return (
                                      <>
                                        <QuickSendReport
                                          reportUrl={customDomainReportUrl || `#demo-report-${group.order_id}`}
                                          reportName={`${group.patient_full_name} - ${(group.test_names || []).join(', ')}`}
                                          patientName={group.patient_full_name}
                                          patientPhone={result?.phone}
                                          testName={(group.test_names || []).join(', ')}
                                          onSent={(result) => alert(result.success ? 'Report sent via WhatsApp!' : 'Failed: ' + result.message)}
                                        />
                                        <button
                                          onClick={() => handleOpenSendDoctor(group)}
                                          className="flex items-center px-1.5 py-1 text-xs bg-green-100 text-green-700 rounded hover:bg-green-200 transition-colors"
                                          title="Send to Doctor"
                                        >
                                          <User className="w-3.5 h-3.5" />
                                        </button>
                                      </>
                                    );
                                  }
                                  return null;
                                })()}
                              </>
                            )}
                          </>
                        ) : (
                          <>
                            <div className="flex items-center gap-0.5">
                              <button
                                className={`flex items-center space-x-1 px-2 py-1 text-xs bg-amber-600 text-white rounded-l hover:bg-amber-700 transition-colors ${(isOrderBusy(group.order_id)) ? 'opacity-50 cursor-not-allowed' : ''}`}
                                onClick={() => handleDownload(group.order_id, true, 'ecopy')}
                                disabled={isOrderBusy(group.order_id)}
                                title="Generate eCopy draft (letterhead)"
                              >
                                {(isOrderBusy(group.order_id)) ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                                <span>Draft eCopy</span>
                              </button>
                              <button
                                className={`flex items-center space-x-1 px-2 py-1 text-xs bg-amber-500 text-white rounded-r hover:bg-amber-600 transition-colors border-l border-amber-700 ${(isOrderBusy(group.order_id)) ? 'opacity-50 cursor-not-allowed' : ''}`}
                                onClick={() => handleDownload(group.order_id, true, 'print')}
                                disabled={isOrderBusy(group.order_id)}
                                title="Generate print draft (no letterhead)"
                              >
                                <Printer className="w-3.5 h-3.5" />
                                <span>Draft Print</span>
                              </button>
                            </div>
                            {(() => {
                              const job = pdfQueueStatus.get(group.order_id);
                              const isStuck = job && (job.status === 'processing' || job.status === 'pending') &&
                                Date.now() - new Date(job.started_at ?? job.created_at).getTime() > 60_000;
                              if (!isStuck) return null;
                              return (
                                <button
                                  className="flex items-center space-x-1 px-2 py-1 text-xs bg-red-100 text-red-700 rounded hover:bg-red-200 transition-colors border border-red-300"
                                  onClick={() => handleRetryStuckJob(group.order_id, true)}
                                  title="Job appears stuck — click to delete and retry"
                                >
                                  <RefreshCw className="w-3 h-3" />
                                  <span>Retry</span>
                                </button>
                              );
                            })()}
                          </>
                        )}

                        {(group.results[0] as ApprovedResult)?.has_report && (
                          <button
                            className="flex items-center px-1.5 py-1 text-xs bg-red-50 text-red-600 rounded hover:bg-red-100 transition-colors"
                            onClick={() => handleDeleteReport(group.order_id)}
                            title="Delete Report"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Mobile Card View */}
                    <div className="lg:hidden">
                      <div className={`rounded-lg border p-4 shadow-sm ${getPrintInfo(group).isPrinted ? 'bg-slate-50 border-slate-300' : 'bg-white border-gray-200'}`}>
                        <div className="flex items-start justify-between mb-4">
                          <div className="flex items-center space-x-3">
                            <input
                              type="checkbox"
                              checked={selectedOrders.has(group.order_id)}
                              onChange={() => toggleOrderSelection(group.order_id)}
                              className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 w-4 h-4 mt-1"
                            />
                            <div>
                              <div className="font-semibold text-gray-900 text-lg">
                                {group.patient_full_name}
                              </div>
                              <div className="text-sm text-gray-600">
                                {formatAge(group.age, (group as any).age_unit)} • {group.gender}
                              </div>
                            </div>
                          </div>
                          <div className="flex flex-col items-end gap-1">
                            {getStatusBadge(group)}
                            {getPrintedBadge(group)}
                          </div>
                        </div>

                        <div className="space-y-3">
                          <div className="flex items-center justify-between">
                            <span className="text-sm text-gray-600">Order Date:</span>
                            <span className="text-sm font-medium text-gray-900">
                              {safeFormatDate(group.order_date, 'MMM d, yyyy')}
                            </span>
                          </div>

                          <div className="flex items-center justify-between">
                            <span className="text-sm text-gray-600">Tests:</span>
                            <span className="text-sm text-gray-900">
                              {(group.test_names || []).length} test{(group.test_names || []).length !== 1 ? 's' : ''}
                            </span>
                          </div>

                          <div className="flex items-center justify-between">
                            <span className="text-sm text-gray-600">Sample ID:</span>
                            <span className="text-sm font-mono text-gray-900">
                              {(group.sample_ids || []).join(', ')}
                            </span>
                          </div>
                        </div>

                        {/* PDF Auto-Generation Status Badge for Mobile */}
                        {getPDFAutoGenBadge(group.order_id) && (
                          <div className="mt-3">
                            {getPDFAutoGenBadge(group.order_id)}
                          </div>
                        )}

                        <div className="flex space-x-2 mt-4 pt-4 border-t border-gray-200">
                          <button
                            className="flex-1 flex items-center justify-center space-x-1 px-3 py-2 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
                            onClick={() => handleView(group.order_id)}
                          >
                            <Eye className="w-4 h-4" />
                            <span>View</span>
                          </button>

                          {(group.is_report_ready || (group.results[0] as ApprovedResult)?.has_final_report || (group.results[0] as ApprovedResult)?.has_draft_report) ? (
                            <>
                              {!(group.results[0] as ApprovedResult)?.has_final_report ? (
                                <>
                                  {(group.results[0] as ApprovedResult)?.has_draft_report && (
                                    <div className="flex items-center gap-0.5">
                                      <button
                                        className="flex-1 flex items-center justify-center space-x-1 px-3 py-2 text-sm bg-amber-600 text-white rounded-l-md hover:bg-amber-700 transition-colors"
                                        onClick={() => {
                                          const url = (group.results[0] as ApprovedResult)?.draft_report?.pdf_url;
                                          if (url && !isTempPdfUrl(url)) window.open(url, '_blank');
                                          else void handleDownload(group.order_id, true, 'ecopy');
                                        }}
                                        title="Download eCopy draft"
                                      >
                                        <Download className="w-4 h-4" />
                                        <span>eCopy</span>
                                      </button>
                                      <button
                                        className={`flex items-center justify-center px-3 py-2 text-sm rounded-r-md transition-colors border-l border-amber-700 ${(group.results[0] as ApprovedResult)?.draft_report?.print_pdf_url ? 'bg-amber-500 text-white hover:bg-amber-600' : 'bg-gray-200 text-gray-500 cursor-not-allowed'}`}
                                        onClick={() => {
                                          const url = (group.results[0] as ApprovedResult)?.draft_report?.print_pdf_url;
                                          if (url) { window.open(url, '_blank'); void markOrderPrinted(group.order_id); }
                                        }}
                                        disabled={!(group.results[0] as ApprovedResult)?.draft_report?.print_pdf_url}
                                        title="Download print draft"
                                      >
                                        <Printer className="w-4 h-4" />
                                      </button>
                                    </div>
                                  )}
                                  <button
                                    className={`flex-1 flex items-center justify-center space-x-1 px-3 py-2 text-sm bg-purple-600 text-white rounded-md hover:bg-purple-700 transition-colors ${previewingOrderId === group.order_id ? 'opacity-80 cursor-not-allowed' : ''
                                      }`}
                                    onClick={() => handleOrderTemplatePreview(group)}
                                    disabled={previewingOrderId === group.order_id}
                                    title="Preview using saved template"
                                  >
                                    {previewingOrderId === group.order_id ? (
                                      <Loader2 className="w-4 h-4 animate-spin" />
                                    ) : (
                                      <Wand2 className="w-4 h-4" />
                                    )}
                                    <span>Template</span>
                                  </button>
                                  <button
                                    className={`flex-1 flex items-center justify-center space-x-1 px-3 py-2 text-sm bg-green-600 text-white rounded-md hover:bg-green-700 transition-colors ${(isOrderBusy(group.order_id))
                                      ? 'opacity-50 cursor-not-allowed'
                                      : ''
                                      }`}
                                    onClick={() => handleDownload(group.order_id, false)}
                                    disabled={isOrderBusy(group.order_id)}
                                    title="Generate final report"
                                  >
                                    {(isOrderBusy(group.order_id)) ? (
                                      <div className="flex items-center space-x-1">
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                        {pdfQueueStatus.get(group.order_id)?.progress_percent && (
                                          <span className="text-xs">{pdfQueueStatus.get(group.order_id).progress_percent}%</span>
                                        )}
                                      </div>
                                    ) : (
                                      <Download className="w-4 h-4" />
                                    )}
                                    <span>{(isOrderBusy(group.order_id)) ? 'Gen...' : 'Final'}</span>
                                  </button>
                                  {(() => {
                                    const job = pdfQueueStatus.get(group.order_id);
                                    const isStuck = job && (job.status === 'processing' || job.status === 'pending') &&
                                      Date.now() - new Date(job.started_at ?? job.created_at).getTime() > 60_000;
                                    if (!isStuck) return null;
                                    return (
                                      <button
                                        className="flex items-center justify-center space-x-1 px-3 py-2 text-sm bg-red-100 text-red-700 rounded-md hover:bg-red-200 transition-colors border border-red-300"
                                        onClick={() => handleRetryStuckJob(group.order_id, false)}
                                        title="Job appears stuck — click to delete and retry"
                                      >
                                        <RefreshCw className="w-4 h-4" />
                                        <span>Retry</span>
                                      </button>
                                    );
                                  })()}
                                  {false && (
                                    <>
                                      <button
                                        className="flex-1 flex items-center justify-center space-x-1 px-3 py-2 text-sm bg-indigo-600 text-white rounded-md hover:bg-indigo-700 transition-colors"
                                        onClick={() => handleHtmlPreview(group.order_id)}
                                        title="Preview HTML"
                                      >
                                        <FileCode className="w-4 h-4" />
                                        <span>HTML</span>
                                      </button>
                                      <button
                                        className="flex-1 flex items-center justify-center space-x-1 px-3 py-2 text-sm bg-orange-600 text-white rounded-md hover:bg-orange-700 transition-colors"
                                        onClick={() => handleLetterheadGeneration(group.order_id)}
                                        title="Generate with Letterhead Function"
                                      >
                                        <FileCode className="w-4 h-4" />
                                        <span>LF</span>
                                      </button>
                                    </>
                                  )}
                                  <button
                                    className="flex items-center justify-center px-3 py-2 text-sm bg-gray-600 text-white rounded-md hover:bg-gray-700 transition-colors"
                                    onClick={() => handleOpenPDFSettings(group.order_id)}
                                    title="PDF Settings"
                                  >
                                    <Settings className="w-4 h-4" />
                                  </button>
                                </>
                              ) : (
                                <>
                                  <button
                                    className={`flex-1 flex items-center justify-center space-x-1 px-3 py-2 text-sm rounded-md transition-colors ${isTempPdfUrl((group.results[0] as ApprovedResult)?.final_report?.pdf_url) ? 'bg-amber-500 text-white hover:bg-amber-600' : 'bg-green-600 text-white hover:bg-green-700'}`}
                                    onClick={() => {
                                      const finalReport = (group.results[0] as ApprovedResult)?.final_report;
	                                      if (finalReport?.pdf_url && !isTempPdfUrl(finalReport.pdf_url)) {
	                                        window.open(finalReport.pdf_url, '_blank');
	                                      } else if ((group.results[0] as ApprovedResult)?.compact_ecopy_url || finalReport?.compact_ecopy_url || finalReport?.print_pdf_url) {
	                                        window.open((group.results[0] as ApprovedResult)?.compact_ecopy_url || finalReport?.compact_ecopy_url || finalReport?.print_pdf_url, '_blank');
	                                      } else {
	                                        void handleLetterheadGeneration(group.order_id);
	                                      }
                                    }}
                                    title={isTempPdfUrl((group.results[0] as ApprovedResult)?.final_report?.pdf_url) ? 'PDF link expired — click to regenerate' : 'Download final report'}
                                  >
                                    <Download className="w-4 h-4" />
                                    <span>{isTempPdfUrl((group.results[0] as ApprovedResult)?.final_report?.pdf_url) ? 'Re-generate' : 'Download'}</span>
                                  </button>
                                  {false && (
                                    <>
                                      <button
                                        className="flex-1 flex items-center justify-center space-x-1 px-3 py-2 text-sm bg-indigo-600 text-white rounded-md hover:bg-indigo-700 transition-colors"
                                        onClick={() => handleHtmlPreview(group.order_id)}
                                        title="Preview HTML"
                                      >
                                        <FileCode className="w-4 h-4" />
                                        <span>HTML</span>
                                      </button>
                                      <button
                                        className="flex-1 flex items-center justify-center space-x-1 px-3 py-2 text-sm bg-orange-600 text-white rounded-md hover:bg-orange-700 transition-colors"
                                        onClick={() => handleLetterheadGeneration(group.order_id)}
                                        title="Generate with Letterhead Function"
                                      >
                                        <FileCode className="w-4 h-4" />
                                        <span>LF</span>
                                      </button>
                                    </>
                                  )}
                                  <button
                                    className="flex-1 flex items-center justify-center space-x-1 px-3 py-2 text-sm bg-gradient-to-r from-pink-500 to-rose-500 text-white rounded-md hover:from-pink-600 hover:to-rose-600 transition-colors shadow-sm"
                                    onClick={() => {
                                      const smartUrl = (group.results[0] as ApprovedResult)?.smart_report_url;
                                      if (smartUrl) window.open(smartUrl, '_blank');
                                      else handleSmartReport(group.order_id);
                                    }}
                                    onContextMenu={(e) => {
                                      e.preventDefault();
                                      if (window.confirm('Regenerate Smart Report? This will create a new AI-enhanced report.')) {
                                        handleSmartReport(group.order_id, true);
                                      }
                                    }}
                                    disabled={smartReportLoadingId === group.order_id}
                                    title={`Smart Report${(group.results[0] as ApprovedResult)?.smart_report_url ? ' (cached - right-click to regenerate)' : ''}`}
                                  >
                                    {smartReportLoadingId === group.order_id ? (
                                      <Loader2 className="w-4 h-4 animate-spin" />
                                    ) : (
                                      <Sparkles className="w-4 h-4" />
                                    )}
                                    <span>Smart</span>
                                  </button>

                                  {/* Smart Report WhatsApp Send Button for Mobile */}
                                  {(() => {
                                    const result = group.results[0] as ApprovedResult;
                                    const smartReportUrl = result?.smart_report_url;
                                    const customDomainSmartUrl = smartReportUrl ? convertToCustomDomain(smartReportUrl) : smartReportUrl;
                                    if (customDomainSmartUrl) {
                                      return (
                                        <div className="flex-1">
                                          <QuickSendReport
                                            reportUrl={customDomainSmartUrl}
                                            reportName={`Smart Report - ${group.patient_full_name} - ${(group.test_names || []).join(', ')}`}
                                            patientName={group.patient_full_name}
                                            patientPhone={result?.phone}
                                            testName={(group.test_names || []).join(', ')}
                                            label="Smart Report via WhatsApp"
                                            onSent={(result) => {
                                              if (result.success) {
                                                alert('Smart Report sent successfully via WhatsApp!');
                                              } else {
                                                alert('Failed to send Smart Report: ' + result.message);
                                              }
                                            }}
                                          />
                                        </div>
                                      );
                                    }
                                    return null;
                                  })()}

                                  <button
                                    className="flex items-center justify-center px-3 py-2 text-sm bg-gray-600 text-white rounded-md hover:bg-gray-700 transition-colors"
                                    onClick={() => handleOpenPDFSettings(group.order_id)}
                                    title="PDF Settings"
                                  >
                                    <Settings className="w-4 h-4" />
                                  </button>
                                  <button
                                    className={`flex-1 flex items-center justify-center space-x-1 px-3 py-2 text-sm rounded-md transition-colors ${getPrintInfo(group).isPrinted ? 'bg-slate-700 text-white hover:bg-slate-800' : (group.results[0] as ApprovedResult)?.final_report?.print_pdf_url ? 'bg-emerald-600 text-white hover:bg-emerald-700' : 'bg-gray-200 text-gray-700 hover:bg-gray-300'}`}
                                    onClick={() => {
                                      const printUrl = (group.results[0] as ApprovedResult)?.final_report?.print_pdf_url;
                                      if (printUrl) { window.open(printUrl, '_blank'); void markOrderPrinted(group.order_id); return; }
                                      void handleLetterheadGeneration(group.order_id, 'compact', 'compact-print');
                                    }}
                                    onContextMenu={(e) => { e.preventDefault(); if (window.confirm('Regenerate compact print PDF?')) void handleLetterheadGeneration(group.order_id, 'compact', 'compact-print'); }}
                                    title={getPrintInfo(group).isPrinted ? `${getPrintInfo(group).label} — tap to print again` : (group.results[0] as ApprovedResult)?.final_report?.print_pdf_url ? 'Open compact print PDF. Right-click to regenerate.' : 'Generate compact print PDF'}
                                  >
                                    <Printer className="w-4 h-4" />
                                    <span>{getPrintInfo(group).isPrinted ? 'Printed' : 'Print'}</span>
                                  </button>
                                  <button
                                    className={`flex-1 flex items-center justify-center space-x-1 px-3 py-2 text-sm rounded-md transition-colors ${(group.results[0] as ApprovedResult)?.compact_ecopy_url ? 'bg-indigo-600 text-white hover:bg-indigo-700' : 'bg-gray-200 text-gray-700 hover:bg-gray-300'}`}
                                    onClick={() => {
                                      const ecopyUrl = (group.results[0] as ApprovedResult)?.compact_ecopy_url;
                                      if (ecopyUrl) { window.open(ecopyUrl, '_blank'); return; }
                                      void handleLetterheadGeneration(group.order_id, 'compact');
                                    }}
                                    onContextMenu={(e) => { e.preventDefault(); if (window.confirm('Regenerate compact eCopy PDF?')) void handleLetterheadGeneration(group.order_id, 'compact'); }}
                                    title={(group.results[0] as ApprovedResult)?.compact_ecopy_url ? 'Open compact eCopy. Right-click to regenerate.' : 'Generate compact eCopy PDF'}
                                  >
                                    <FileText className="w-4 h-4" />
                                    <span>eCopy</span>
                                  </button>

                                  {/* WhatsApp Send Button for Mobile */}
                                  {(() => {
                                    const result = group.results[0] as ApprovedResult;
                                    const finalReport = result?.final_report;
                                    const hasFinalReport = result?.has_final_report;
                                    const reportUrl = finalReport?.pdf_url;

                                    if (hasFinalReport || finalReport || reportUrl) {
                                      return (
                                        <div className="flex-1">
                                          <QuickSendReport
                                            reportUrl={reportUrl || `#demo-report-${group.order_id}`}
                                            reportName={`${group.patient_full_name} - ${(group.test_names || []).join(', ')}`}
                                            patientName={group.patient_full_name}
                                            patientPhone={result?.phone}
                                            testName={(group.test_names || []).join(', ')}
                                            onSent={(result) => {
                                              if (result.success) {
                                                alert('Report sent successfully via WhatsApp!');
                                              } else {
                                                alert('Failed to send report: ' + result.message);
                                              }
                                            }}
                                          />
                                        </div>
                                      );
                                    }
                                    return null;
                                  })()}
                                </>
                              )}
                            </>
                          ) : (
                            <>
                              <div className="flex-1 flex items-center gap-0.5">
                                <button
                                  className={`flex-1 flex items-center justify-center space-x-1 px-3 py-2 text-sm bg-amber-600 text-white rounded-l-md hover:bg-amber-700 transition-colors ${(isOrderBusy(group.order_id))
                                    ? 'opacity-50 cursor-not-allowed'
                                    : ''
                                    }`}
                                  onClick={() => handleDownload(group.order_id, true, 'ecopy')}
                                  disabled={isOrderBusy(group.order_id)}
                                  title="Generate eCopy draft (letterhead)"
                                >
                                  {(isOrderBusy(group.order_id)) ? (
                                    <div className="flex items-center space-x-1">
                                      <Loader2 className="w-4 h-4 animate-spin" />
                                      {pdfQueueStatus.get(group.order_id)?.progress_percent && (
                                        <span className="text-xs">{pdfQueueStatus.get(group.order_id).progress_percent}%</span>
                                      )}
                                    </div>
                                  ) : (
                                    <Download className="w-4 h-4" />
                                  )}
                                  <span>{(isOrderBusy(group.order_id)) ? 'Gen...' : 'Draft eCopy'}</span>
                                </button>
                                <button
                                  className={`flex items-center justify-center px-3 py-2 text-sm bg-amber-500 text-white rounded-r-md hover:bg-amber-600 transition-colors border-l border-amber-700 ${(isOrderBusy(group.order_id))
                                    ? 'opacity-50 cursor-not-allowed'
                                    : ''
                                    }`}
                                  onClick={() => handleDownload(group.order_id, true, 'print')}
                                  disabled={isOrderBusy(group.order_id)}
                                  title="Generate print draft (no letterhead)"
                                  aria-label="Generate draft print PDF"
                                >
                                  <Printer className="w-4 h-4" />
                                </button>
                              </div>
                              {(() => {
                                const job = pdfQueueStatus.get(group.order_id);
                                const isStuck = job && (job.status === 'processing' || job.status === 'pending') &&
                                  Date.now() - new Date(job.started_at ?? job.created_at).getTime() > 60_000;
                                if (!isStuck) return null;
                                return (
                                  <button
                                    className="flex items-center justify-center space-x-1 px-3 py-2 text-sm bg-red-100 text-red-700 rounded-md hover:bg-red-200 transition-colors border border-red-300"
                                    onClick={() => handleRetryStuckJob(group.order_id, true)}
                                    title="Job appears stuck — click to delete and retry"
                                  >
                                    <RefreshCw className="w-4 h-4" />
                                    <span>Retry</span>
                                  </button>
                                );
                              })()}
                            </>
                          )}
                          {(group.results[0] as ApprovedResult)?.has_report && (
                            <button
                              className="flex items-center justify-center px-3 py-2 text-sm bg-red-50 text-red-600 rounded-md hover:bg-red-100 transition-colors border border-red-200"
                              onClick={() => handleDeleteReport(group.order_id)}
                              title="Delete Report Record"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Footer Summary */}
        <div className="mt-8 bg-gradient-to-r from-blue-50 to-purple-50 rounded-lg p-6 border border-blue-200">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 text-sm">
            <div className="flex items-center space-x-6">
              <div className="flex items-center">
                <Calendar className="h-4 w-4 text-blue-600 mr-2" />
                <span className="text-blue-900 font-medium">
                  Viewing: {dateFilterLabel}
                </span>
              </div>
              <div className="flex items-center">
                <AlertTriangle className="h-4 w-4 text-red-600 mr-2" />
                <span className="text-red-900 font-medium">
                  Urgent: {orderGroups.filter(g => g.results.some(r => r.verification_status === 'verified')).length}
                </span>
              </div>
            </div>
            <div className="flex items-center">
              <TrendingUp className="h-4 w-4 text-purple-600 mr-2" />
              <span className="text-purple-900 font-medium">
                Average TAT: {orderGroups.length > 0 ?
                  Math.round(
                    orderGroups.reduce((sum, g) => {
                      const orderDate = new Date(g.order_date).getTime();
                      const verifiedDate = new Date(g.verified_at).getTime();
                      return sum + ((verifiedDate - orderDate) / (1000 * 60 * 60));
                    }, 0) / orderGroups.length
                  ) : 0
                }h
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* PDF Progress Modal */}
      <PDFProgressModal
        isVisible={isGenerating}
        stage={stage}
        progress={progress}
        pdfUrl={pdfUrl}
        onView={() => { if (pdfUrl) window.open(pdfUrl, '_blank'); }}
        onClose={resetState}
      />

      {showOrderSettings && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-2xl rounded-xl bg-white shadow-2xl border border-gray-200">
            <div className="flex items-center justify-between px-6 py-4 border-b">
              <div>
                <h3 className="text-lg font-semibold text-gray-900">Order Report Settings</h3>
                <p className="text-sm text-gray-500">Adjust order-level report sequence and compact print mode.</p>
              </div>
              <button
                className="p-2 rounded-md hover:bg-gray-100"
                onClick={() => {
                  setShowOrderSettings(false);
                  setOrderSettingsOrderId(null);
                }}
                disabled={orderSettingsSaving}
              >
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </div>

            <div className="px-6 py-5 space-y-6 max-h-[75vh] overflow-y-auto">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Print Mode</label>
                <div className="inline-flex rounded-lg border border-gray-200 overflow-hidden">
                  <button
                    type="button"
                    className={`px-4 py-2 text-sm ${orderSettingsLayoutMode === 'standard' ? 'bg-blue-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`}
                    onClick={() => setOrderSettingsLayoutMode('standard')}
                    disabled={orderSettingsSaving}
                  >
                    Standard
                  </button>
                  <button
                    type="button"
                    className={`px-4 py-2 text-sm border-l border-gray-200 ${orderSettingsLayoutMode === 'compact' ? 'bg-emerald-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`}
                    onClick={() => setOrderSettingsLayoutMode('compact')}
                    disabled={orderSettingsSaving}
                  >
                    Compact
                  </button>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="block text-sm font-medium text-gray-700">Resolved Group Order</label>
                  <span className="text-xs text-gray-500">Move items up or down to override the default priority.</span>
                </div>
                {orderSettingsLoading ? (
                  <div className="flex items-center gap-2 text-sm text-gray-500 py-4">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Loading order settings...
                  </div>
                ) : orderSettingsGroups.length === 0 ? (
                  <div className="text-sm text-gray-500 py-4">No test groups found for this order.</div>
                ) : (
                  <div className="space-y-2">
                    {orderSettingsGroups.map((group, index) => (
                      <div key={group.testGroupId} className="flex items-center justify-between rounded-lg border border-gray-200 px-3 py-3 bg-gray-50">
                        <div>
                          <div className="text-sm font-medium text-gray-900">{index + 1}. {group.testName}</div>
                          <div className="text-xs text-gray-500">
                            {getActiveReportPriority(group.reportPriority) !== Number.MAX_SAFE_INTEGER ? `Global priority ${group.reportPriority}` : 'No global priority'}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            className="px-3 py-1.5 text-xs rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-100 disabled:opacity-40"
                            onClick={() => moveOrderSettingsGroup(index, -1)}
                            disabled={index === 0 || orderSettingsSaving}
                          >
                            Up
                          </button>
                          <button
                            type="button"
                            className="px-3 py-1.5 text-xs rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-100 disabled:opacity-40"
                            onClick={() => moveOrderSettingsGroup(index, 1)}
                            disabled={index === orderSettingsGroups.length - 1 || orderSettingsSaving}
                          >
                            Down
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Compact Page Planner — shown only when compact mode is selected */}
              {orderSettingsLayoutMode === 'compact' && (
                <div className="space-y-4 rounded-xl border border-emerald-200 bg-emerald-50/50 p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Compact Page Planner</label>
                      <p className="text-xs text-gray-500">
                        Choose which tests share a page. Larger tests like CBC or Lipid can stay alone, while 1-2 small tests can be clubbed.
                      </p>
                    </div>
                    <div className="flex items-end gap-2">
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">Auto-club limit</label>
                        <input
                          type="number"
                          min={1}
                          max={20}
                          value={orderSettingsMaxClubbedAnalytes}
                          onChange={(e) => setOrderSettingsMaxClubbedAnalytes(Math.max(1, Number(e.target.value) || 5))}
                          className="w-24 rounded-md border border-gray-300 px-3 py-2 text-sm"
                          disabled={orderSettingsSaving}
                        />
                      </div>
                      <button
                        type="button"
                        className="rounded-md border border-emerald-300 bg-white px-3 py-2 text-sm text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
                        onClick={autoArrangeCompactPages}
                        disabled={orderSettingsSaving || orderSettingsLoading || orderSettingsGroups.length === 0}
                      >
                        Auto Arrange
                      </button>
                    </div>
                  </div>

                  {/* Page summary cards */}
                  <div className="grid gap-2 sm:grid-cols-2">
                    {Array.from(new Set(orderSettingsGroups.map((g) => g.pageNumber))).sort((a, b) => a - b).map((pageNumber) => {
                      const pageGroups = orderSettingsGroups.filter((g) => g.pageNumber === pageNumber);
                      const totalAnalytes = pageGroups.reduce((sum, g) => sum + (g.analyteCount || 0), 0);
                      return (
                        <div key={`summary-${pageNumber}`} className="rounded-lg border border-emerald-100 bg-white px-3 py-3">
                          <div className="flex items-center justify-between">
                            <div className="text-sm font-semibold text-gray-900">Page {pageNumber}</div>
                            <div className="text-[11px] font-medium text-emerald-700">{totalAnalytes} analyte{totalAnalytes === 1 ? '' : 's'}</div>
                          </div>
                          <div className="mt-2 text-xs text-gray-600">{pageGroups.map((g) => g.testName).join(', ')}</div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Per-group controls */}
                  <div className="space-y-2">
                    {orderSettingsGroups.map((group) => {
                      const pageOptions = Array.from({ length: Math.max(6, orderSettingsGroups.length) }, (_, i) => i + 1);
                      const suggestion = getCompactPlannerSuggestion(
                        orderSettingsGroups,
                        group.testGroupId,
                        Object.fromEntries(orderSettingsGroups.map((g) => [g.testGroupId, g.pageNumber])),
                        orderSettingsMaxClubbedAnalytes,
                      );
                      const suggestionTone =
                        suggestion.kind === 'standalone-large' ? 'bg-amber-100 text-amber-800'
                          : suggestion.kind === 'clubbed' ? 'bg-emerald-100 text-emerald-800'
                            : suggestion.kind === 'manual-shared' ? 'bg-violet-100 text-violet-800'
                              : 'bg-sky-100 text-sky-800';
                      return (
                        <div key={`${group.testGroupId}-page`} className="flex flex-col gap-2 rounded-lg border border-emerald-100 bg-white px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                          <div>
                            <div className="flex flex-wrap items-center gap-2">
                              <div className="text-sm font-medium text-gray-900">{group.testName}</div>
                              <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${suggestionTone}`}>{suggestion.label}</span>
                            </div>
                            <div className="text-xs text-gray-500 mt-1">{group.analyteCount} analyte{group.analyteCount === 1 ? '' : 's'}</div>
                            <div className="text-[11px] text-gray-500 mt-1">{suggestion.description}</div>
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              className="rounded-md border border-gray-300 px-2.5 py-2 text-xs text-gray-700 hover:bg-gray-100 disabled:opacity-50"
                              onClick={() => setOrderSettingsGroupOwnPage(group.testGroupId)}
                              disabled={orderSettingsSaving}
                            >
                              Own Page
                            </button>
                            <button
                              type="button"
                              className="rounded-md border border-gray-300 px-2.5 py-2 text-xs text-gray-700 hover:bg-gray-100 disabled:opacity-50"
                              onClick={() => setOrderSettingsGroupClubPrevious(group.testGroupId)}
                              disabled={orderSettingsSaving || orderSettingsGroups[0]?.testGroupId === group.testGroupId}
                            >
                              Club Previous
                            </button>
                            <span className="text-xs font-medium text-gray-600">Print on page</span>
                            <select
                              value={group.pageNumber}
                              onChange={(e) => setOrderSettingsGroupPage(group.testGroupId, Number(e.target.value))}
                              className="rounded-md border border-gray-300 px-3 py-2 text-sm"
                              disabled={orderSettingsSaving}
                            >
                              {pageOptions.map((pageNo) => (
                                <option key={pageNo} value={pageNo}>Page {pageNo}</option>
                              ))}
                            </select>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between gap-3 px-6 py-4 border-t bg-gray-50">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="px-4 py-2 text-sm rounded-md border border-gray-300 bg-white text-gray-700 hover:bg-gray-100 disabled:opacity-50"
                  onClick={handleSaveOrderSettings}
                  disabled={orderSettingsLoading || orderSettingsSaving || !orderSettingsOrderId}
                >
                  {orderSettingsSaving ? 'Saving...' : 'Save Settings'}
                </button>
                <button
                  type="button"
                  className="px-4 py-2 text-sm rounded-md border border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100 disabled:opacity-50"
                  onClick={() => {
                    setPdfSettingsOrderId(orderSettingsOrderId);
                    setShowPDFSettings(true);
                  }}
                  disabled={orderSettingsSaving || !orderSettingsOrderId}
                >
                  PDF Margin & Layout Settings
                </button>
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  className="px-4 py-2 text-sm rounded-md border border-gray-300 bg-white text-gray-700 hover:bg-gray-100 disabled:opacity-50"
                  onClick={() => {
                    setShowOrderSettings(false);
                    setOrderSettingsOrderId(null);
                  }}
                  disabled={orderSettingsSaving}
                >
                  Close
                </button>
                {orderSettingsLayoutMode === 'compact' && (
                  <div className="flex items-center rounded-md overflow-hidden border border-indigo-300">
                    <button
                      type="button"
                      className="px-4 py-2 text-sm bg-indigo-50 text-indigo-700 hover:bg-indigo-100 disabled:opacity-50"
                      onClick={() => {
                        if (orderSettingsExistingEcopyUrl) window.open(orderSettingsExistingEcopyUrl, '_blank');
                        else void handleRegenerateEcopyFromOrderSettings();
                      }}
                      disabled={orderSettingsLoading || orderSettingsSaving || !orderSettingsOrderId}
                    >
                      {orderSettingsSaving ? 'Working...' : orderSettingsExistingEcopyUrl ? 'Open Compact eCopy' : 'Generate Compact eCopy'}
                    </button>
                    {orderSettingsExistingEcopyUrl && (
                      <button
                        type="button"
                        className="px-2 py-2 text-sm bg-indigo-100 text-indigo-700 hover:bg-indigo-200 border-l border-indigo-300 disabled:opacity-50"
                        onClick={() => { if (window.confirm('Regenerate compact eCopy PDF?')) void handleRegenerateEcopyFromOrderSettings(); }}
                        disabled={orderSettingsSaving}
                        title="Force regenerate"
                      >
                        ↺
                      </button>
                    )}
                  </div>
                )}
                <div className="flex items-center rounded-md overflow-hidden border border-emerald-600">
                  <button
                    type="button"
                    className="px-4 py-2 text-sm bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
                    onClick={() => {
                      if (orderSettingsExistingPrintUrl) {
                        window.open(orderSettingsExistingPrintUrl, '_blank');
                        if (orderSettingsOrderId) void markOrderPrinted(orderSettingsOrderId);
                      } else void handleRegenerateFromOrderSettings();
                    }}
                    disabled={orderSettingsLoading || orderSettingsSaving || !orderSettingsOrderId}
                  >
                    {orderSettingsSaving ? 'Working...' : orderSettingsExistingPrintUrl
                      ? `Open ${orderSettingsLayoutMode === 'compact' ? 'Compact' : 'Standard'} Print`
                      : `Generate ${orderSettingsLayoutMode === 'compact' ? 'Compact' : 'Standard'} Print`}
                  </button>
                  {orderSettingsExistingPrintUrl && (
                    <button
                      type="button"
                      className="px-2 py-2 text-sm bg-emerald-700 text-white hover:bg-emerald-800 border-l border-emerald-500 disabled:opacity-50"
                      onClick={() => { if (window.confirm('Force regenerate print PDF?')) void handleRegenerateFromOrderSettings(); }}
                      disabled={orderSettingsSaving}
                      title="Force regenerate"
                    >
                      ↺
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* PDF Settings Modal (margins, scale, letterhead mode) */}
      <PDFSettingsModal
        isOpen={showPDFSettings}
        onClose={() => { setShowPDFSettings(false); setPdfSettingsOrderId(null); }}
        onRegenerate={handleRegenerateWithSettings}
        isRegenerating={isGenerating}
        labId={userLabId ?? undefined}
      />

      {/* Report Design Studio */}
      {reportStudioOrderId && (
        <ReportDesignStudio
          orderId={reportStudioOrderId}
          onClose={() => setReportStudioOrderId(null)}
          onSuccess={(url) => {
            alert('Report Generated Successfully!');
            loadApprovedResults(); // Refresh list to show new report
            if (url) window.open(url, '_blank'); // Open the generated PDF
          }}
        />
      )}

      {/* Send Report Modal */}
      {sendReportModalData && (
        <SendReportModal
          {...sendReportModalData}
          onClose={() => setSendReportModalData(null)}
        />
      )}

      {/* Report Preview Modal */}
      {viewingOrder && (
        <ReportPreviewModal
          isOpen={!!viewingOrder}
          onClose={() => setViewingOrder(null)}
          orderId={viewingOrder.order_id}
          patientName={viewingOrder.patient_full_name}
          patientPhone={viewingOrder.results[0]?.phone}
          testNames={Array.isArray(viewingOrder.test_names) ? viewingOrder.test_names : []}
          doctorName={viewingOrder.results[0]?.doctor}
          onReportGenerated={loadApprovedResults}
        />
      )}

      {/* Mobile FAB - Generate Report */}
      <MobileFAB
        icon={FileText}
        onClick={handleTemplatePreview}
        label="Preview Template"
      />
    </div>
  );
};

export default Reports;
