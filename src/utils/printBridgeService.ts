import { database, supabase } from './supabase';
import {
  formatGenderAge,
  getActiveLabelLayout,
  getLabelZplMetrics,
  normalizeLabelLayout,
  type LabelLayout,
} from './labelLayout';

export type PrintBridgeStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface BarcodeLabelData {
  sampleId: string;
  patientName: string;
  sampleType?: string;
  date?: string;
  labelId?: string;
  gender?: string;
  age?: string;
  collectionTime?: string;
  referredBy?: string;
}

export interface PrintJobInsertResult {
  id: string;
}

export type PrintBridgePrinterRole =
  | 'barcode_label'
  | 'report'
  | 'invoice_thermal'
  | 'bulk_pdf_merge'
  | 'report_pdf_generate';

export type PrintBridgeJobType =
  | 'raw_zpl'
  | 'pdf_url'
  | 'pdf_base64'
  | 'html'
  | 'bulk_merge'
  | 'bulk_pdf_merge'
  | 'html_to_pdf';

let connectionStatus: PrintBridgeStatus = 'connected';
let connectionListeners: Array<(status: PrintBridgeStatus) => void> = [];

function emitStatus(status: PrintBridgeStatus) {
  connectionStatus = status;
  connectionListeners.forEach((fn) => fn(status));
}

export function onConnectionStatusChange(fn: (status: PrintBridgeStatus) => void) {
  connectionListeners.push(fn);
  fn(connectionStatus);

  return () => {
    connectionListeners = connectionListeners.filter((listener) => listener !== fn);
  };
}

export function getConnectionStatus(): PrintBridgeStatus {
  return connectionStatus;
}

export async function connect(): Promise<void> {
  emitStatus('connected');
}

export async function disconnect(): Promise<void> {
  emitStatus('disconnected');
}

export function isConnected(): boolean {
  return connectionStatus === 'connected';
}

function escapeZpl(value: string): string {
  return value.replace(/[\^~]/g, ' ');
}

function fit(value: string | undefined, length: number): string {
  const text = escapeZpl(value || '');
  return text.length > length ? `${text.slice(0, Math.max(0, length - 2))}..` : text;
}

/**
 * Generate ZPL for a thermal label using the configured label layout.
 * Compatible with Zebra, TSC, and most ZPL-capable label printers.
 * Layout matches professional lab label format:
 * - Sample type (top left)
 * - Patient name with gender/age (large, bold)
 * - Barcode (center)
 * - Sample ID, date/time (below barcode)
 * - Referred by (bottom)
 *
 * Size, dpi and font scale come from the lab/location label layout, so this
 * stays in step with the PDF renderer instead of being a second hardcoded copy.
 */
export function generateBarcodeLabelZPL(data: BarcodeLabelData, layoutOverride?: LabelLayout): string {
  const { sampleId, patientName, sampleType, date, labelId, gender, age, collectionTime, referredBy } = data;

  const now = new Date();
  const dateStr = date || now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }).replace(/ /g, '-');
  const timeStr = collectionTime || now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  const dateTimeStr = `${dateStr} ${timeStr}`;

  const barcodeValue = fit(sampleId, 32);
  const displayType = fit(sampleType || 'Sample', 20);

  // Format patient name with gender and age (e.g., "Mr. Bhavik Pate M 34 Y").
  // Gender is abbreviated to its initial so the age fits the narrow slot.
  const genderAgeStr = formatGenderAge(gender, age);
  const displayName = fit(patientName || 'Patient', 24);
  const displayGenderAge = fit(genderAgeStr, 12);

  // Sample ID for display below barcode
  const displaySampleId = fit(labelId || sampleId, 20);

  // Referred by
  const displayReferredBy = fit(referredBy || '', 34);

  const layout = layoutOverride ? normalizeLabelLayout(layoutOverride) : getActiveLabelLayout();
  const m = getLabelZplMetrics(layout);

  return [
    '^XA',
    '^CI28',
    '~SD30',
    `^PW${m.printWidthDots}`,
    `^LL${m.labelLengthDots}`,
    '^LH0,0',

    // Row 1: Sample Type (top left)
    `^FO${m.leftDots},${m.typeYDots}^A0N,${m.typeFontDots},${m.typeFontDots}`,
    `^FD${displayType}.^FS`,

    // Row 2: Patient Name + Gender/Age (same line)
    `^FO${m.leftDots},${m.nameYDots}^A0N,${m.nameFontDots},${m.nameFontDots}`,
    `^FD${displayName}^FS`,
    `^FO${m.genderAgeXDots},${m.nameYDots}^A0N,${m.nameFontDots},${m.nameFontDots}`,
    `^FD${displayGenderAge}^FS`,

    // Row 3: Barcode (centered, thick bars for better scanning)
    `^FO${m.barcodeXDots},${m.barcodeYDots}^BY${m.moduleWidth},3,${m.barcodeHeightDots}`,
    `^BCN,${m.barcodeHeightDots},N,N,N`,
    `^FD${barcodeValue}^FS`,

    // Row 4: Sample ID (left) + Date/Time (right)
    `^FO${m.leftDots},${m.infoYDots}^A0N,${m.infoFontDots},${m.infoFontDots}`,
    `^FD${displaySampleId}^FS`,
    `^FO${m.dateTimeXDots},${m.infoYDots}^A0N,${m.infoFontDots},${m.infoFontDots}`,
    `^FD${dateTimeStr}^FS`,

    // Row 5: Referred By (bottom, if provided)
    ...(displayReferredBy ? [
      `^FO${m.leftDots},${m.referredByYDots}^A0N,${m.infoFontDots},${m.infoFontDots}`,
      `^FD${displayReferredBy}^FS`,
    ] : []),

    '^XZ',
  ].join('\n');
}

async function resolvePrintContext() {
  const [{ data: authData }, labId, locationId] = await Promise.all([
    supabase.auth.getUser(),
    database.getCurrentUserLabId(),
    database.getCurrentUserPrimaryLocation(),
  ]);

  if (!labId) {
    throw new Error('Cannot queue print job: current user lab could not be resolved.');
  }

  return {
    labId,
    locationId: locationId || null,
    userId: authData.user?.id || null,
  };
}

export type BulkPdfSortMode = 'sample_desc' | 'sample_asc' | 'order_id_asc' | 'order_id_desc' | 'date_desc' | 'patient_az';

export interface BulkPdfItem {
  order_id: string;
  sample_id: string | null;
  patient_name: string;
  order_number: number | null;
  order_date: string | null;
  pdf_url: string;
}

export interface BulkPdfMergePayload {
  pdf_list: BulkPdfItem[];
  sort_mode: BulkPdfSortMode;
  output_filename: string;
  save_to_folder: string | null;
  total_count: number;
  print_after_merge?: boolean;
}

export type HtmlToPdfVariant = 'ecopy' | 'print';

export interface HtmlToPdfDocument {
  variant: HtmlToPdfVariant;
  html: string;
  output_filename: string;
  title?: string | null;
  storage_path?: string | null;
  save_to_folder?: string | null;
  paper?: 'A4' | 'Letter';
  landscape?: boolean;
  print_background?: boolean;
}

export interface HtmlToPdfPayload {
  order_id: string;
  report_id: string | null;
  documents: HtmlToPdfDocument[];
  save_to_folder: string | null;
  archive_local_copy: boolean;
  requested_at: string;
}

async function insertPrintJob(input: {
  printerRole: PrintBridgePrinterRole;
  jobType: PrintBridgeJobType;
  payload: Record<string, unknown>;
  copies?: number;
  priority?: number;
  orderId?: string | null;
  sampleId?: string | null;
  reportId?: string | null;
  invoiceId?: string | null;
  idempotencyKey?: string | null;
}): Promise<PrintJobInsertResult> {
  const context = await resolvePrintContext();

  const { data, error } = await supabase
    .from('print_jobs')
    .insert({
      lab_id: context.labId,
      location_id: context.locationId,
      printer_role: input.printerRole,
      job_type: input.jobType,
      status: 'pending',
      priority: input.priority ?? 5,
      payload: input.payload,
      copies: input.copies ?? 1,
      requested_by: context.userId,
      order_id: input.orderId ?? null,
      sample_id: input.sampleId ?? null,
      report_id: input.reportId ?? null,
      invoice_id: input.invoiceId ?? null,
      idempotency_key: input.idempotencyKey ?? null,
    })
    .select('id')
    .single();

  if (error) {
    throw new Error(`Failed to queue print job: ${error.message}`);
  }

  return { id: data.id };
}

export async function enqueueBarcodeLabelPrint(
  printerName: string,
  data: BarcodeLabelData
): Promise<PrintJobInsertResult> {
  const zpl = generateBarcodeLabelZPL(data);

  return insertPrintJob({
    printerRole: 'barcode_label',
    jobType: 'raw_zpl',
    payload: {
      printer_name: printerName.trim(),
      language: 'zpl',
      zpl,
      sample_id: data.labelId || data.sampleId,
      sample_barcode: data.sampleId,
      patient_name: data.patientName,
      sample_type: data.sampleType || null,
      label_date: data.date || null,
      gender: data.gender || null,
      age: data.age || null,
      collection_time: data.collectionTime || null,
      referred_by: data.referredBy || null,
    },
    sampleId: data.labelId || null,
    priority: 3,
    idempotencyKey: null,
  });
}

export async function enqueueReportPrint(
  printerName: string,
  pdfUrl: string
): Promise<PrintJobInsertResult> {
  return insertPrintJob({
    printerRole: 'report',
    jobType: 'pdf_url',
    payload: {
      printer_name: printerName.trim(),
      pdf_url: pdfUrl,
      paper: 'A4',
      fit_to_page: true,
    },
    priority: 5,
  });
}

export async function enqueueThermalHtmlPrint(input: {
  printerName: string;
  html: string;
  widthMm?: 58 | 80;
  invoiceId?: string | null;
}): Promise<PrintJobInsertResult> {
  return insertPrintJob({
    printerRole: 'invoice_thermal',
    jobType: 'html',
    payload: {
      printer_name: input.printerName.trim(),
      html: input.html,
      width_mm: input.widthMm ?? 80,
    },
    invoiceId: input.invoiceId ?? null,
    priority: 4,
  });
}

export async function enqueueHtmlToPdfBridgeJob(input: {
  orderId: string;
  reportId?: string | null;
  documents: HtmlToPdfDocument[];
  saveToFolder?: string | null;
  archiveLocalCopy?: boolean;
  priority?: number;
  idempotencyKey?: string | null;
}): Promise<PrintJobInsertResult> {
  if (!input.orderId) {
    throw new Error('Cannot queue HTML to PDF job: orderId is required.');
  }

  const documents = input.documents.filter((document) => document.html.trim() && document.output_filename.trim());
  if (documents.length === 0) {
    throw new Error('Cannot queue HTML to PDF job: at least one HTML document is required.');
  }

  return insertPrintJob({
    printerRole: 'report_pdf_generate',
    jobType: 'html_to_pdf',
    payload: {
      order_id: input.orderId,
      report_id: input.reportId ?? null,
      documents: documents.map((document) => ({
        ...document,
        paper: document.paper ?? 'A4',
        landscape: document.landscape ?? false,
        print_background: document.print_background ?? true,
        save_to_folder: document.save_to_folder ?? input.saveToFolder ?? null,
      })),
      save_to_folder: input.saveToFolder ?? null,
      archive_local_copy: input.archiveLocalCopy ?? true,
      requested_at: new Date().toISOString(),
    } satisfies HtmlToPdfPayload,
    priority: input.priority ?? 6,
    orderId: input.orderId,
    reportId: input.reportId ?? null,
    idempotencyKey: input.idempotencyKey ?? null,
  });
}

function getDailySeq(order: { order_number?: number | null; sample_id?: string | null }): number {
  if (typeof order.order_number === 'number' && Number.isFinite(order.order_number)) {
    return order.order_number;
  }
  const tail = String(order.sample_id || '').match(/(?:^|[/-])(\d+)\s*$/)?.[1] || '';
  const parsed = parseInt(tail, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sortPdfList(items: BulkPdfItem[], sortMode: BulkPdfSortMode): BulkPdfItem[] {
  return [...items].sort((a, b) => {
    switch (sortMode) {
      case 'patient_az':
        return (a.patient_name || '').localeCompare(b.patient_name || '');

      case 'date_desc': {
        const dateDiff = new Date(b.order_date || 0).getTime() - new Date(a.order_date || 0).getTime();
        if (dateDiff !== 0) return dateDiff;
        return getDailySeq(b) - getDailySeq(a);
      }

      case 'order_id_asc':
        return (a.order_id || '').localeCompare(b.order_id || '', undefined, { numeric: true });

      case 'order_id_desc':
        return (b.order_id || '').localeCompare(a.order_id || '', undefined, { numeric: true });

      case 'sample_asc':
        return getDailySeq(a) - getDailySeq(b);

      case 'sample_desc':
      default:
        return getDailySeq(b) - getDailySeq(a);
    }
  });
}

export async function enqueueBulkPdfMerge(input: {
  orderIds: string[];
  sortMode: BulkPdfSortMode;
  outputFilename?: string;
  saveToFolder?: string | null;
  printAfterMerge?: boolean;
}): Promise<PrintJobInsertResult & { total_count: number }> {
  const { data: orders, error } = await supabase
    .from('orders')
    .select(`
      id,
      sample_id,
      patient_name,
      order_number,
      order_date,
      reports!reports_order_id_fkey(report_type, print_pdf_url)
    `)
    .in('id', input.orderIds);

  if (error) {
    throw new Error(`Failed to fetch orders: ${error.message}`);
  }

  const pdfList: BulkPdfItem[] = [];

  for (const order of orders || []) {
    const reports = Array.isArray(order.reports) ? order.reports : order.reports ? [order.reports] : [];
    const finalReports = reports.filter((r: { report_type?: string | null }) => r?.report_type !== 'draft');
    const draftReports = reports.filter((r: { report_type?: string | null }) => r?.report_type === 'draft');
    const reportWithPrintUrl =
      finalReports.find((r: { print_pdf_url?: string | null }) => !!r?.print_pdf_url) ||
      draftReports.find((r: { print_pdf_url?: string | null }) => !!r?.print_pdf_url);

    if (reportWithPrintUrl?.print_pdf_url) {
      pdfList.push({
        order_id: order.id,
        sample_id: order.sample_id,
        patient_name: order.patient_name,
        order_number: order.order_number,
        order_date: order.order_date,
        pdf_url: reportWithPrintUrl.print_pdf_url,
      });
    }
  }

  if (pdfList.length === 0) {
    throw new Error('No print PDFs available for the selected orders');
  }

  const sortedList = sortPdfList(pdfList, input.sortMode);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = input.outputFilename || `bulk_reports_${timestamp}.pdf`;

  const result = await insertPrintJob({
    printerRole: 'bulk_pdf_merge',
    jobType: 'bulk_pdf_merge',
    payload: {
      pdf_list: sortedList,
      sort_mode: input.sortMode,
      output_filename: filename,
      save_to_folder: input.saveToFolder ?? null,
      total_count: sortedList.length,
      print_after_merge: input.printAfterMerge ?? false,
    } satisfies BulkPdfMergePayload,
    priority: 6,
  });

  return { ...result, total_count: sortedList.length };
}
