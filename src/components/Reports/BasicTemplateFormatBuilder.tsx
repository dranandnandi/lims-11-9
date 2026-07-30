import React, { useMemo } from 'react';
import { formatAnalyteDisplayValue } from '../../utils/resultValueFormat';

export interface BasicPrintOptions {
  baseFontSize?: number;
  flagAsterisk?: boolean;
  flagAsteriskCritical?: boolean;
  testNameBold?: boolean;          // default false
  testNameAlignment?: 'left' | 'center' | 'right'; // default 'left'
  boldAllValues?: boolean;         // default true — all values font-weight 600; false = normal weight
  boldAbnormalValues?: boolean;    // default true — extra bold (700) for high/low; false = no extra bold
  calcMarker?: 'asterisk' | 'cal' | 'none'; // default 'cal'
  defaultDecimalPlaces?: number | null; // lab-wide result precision (0-4); undefined = as entered, per-analyte setting overrides
  padDecimals?: boolean;           // default false — true keeps trailing zeros (12.3 prints as 12.30)
  minIntegerDigits?: number | null; // leading-zero width for fixed-width formats (2 prints 3 as "03"); undefined/0 = off
  sectionHeaderInline?: boolean;   // default true = inline shaded row; false = small-caps label
  flagSymbol?: 'none' | 'before' | 'after'; // default 'none'; 'before' = flag prefix inside result; 'after' = inline flag suffix
  showFlagLegend?: boolean;        // show H=High, L=Low legend below each group table
  resultColors?: { high?: string; low?: string; enabled?: boolean }; // custom flag colors (matches edge fn)
  testGroupTitlePosition?: 'below_headers' | 'above_headers_center' | 'above_headers_left';
  qrPosition?: 'bottom_left' | 'top_left' | 'top_right' | 'header_right';
  qrHorizontalOffset?: number;
  headerQrTop?: number;      // Header QR: distance from top in px (10-80, default 20)
  headerQrRight?: number;    // Header QR: distance from right in px (10-80, default 25)
  signatureMaxHeight?: number;    // Signature image max height px (30-120, default 70)
  signatureMaxWidth?: number;     // Signature image max width px (80-260, default 180)
  reportSignatures?: {
    enabled?: boolean;
    maxCount?: number;
  };
  sectionFieldNamePct?: number;    // Section field name width % for narrative/section-only reports (20-70, default 40)
  reportDisclaimer?: string;       // Disclaimer text printed above the QR/signature footer (default text used when undefined)
  showReportDisclaimer?: boolean;  // default true — print the disclaimer line at end of report
  resultTableBackground?: 'white' | 'transparent';
  basicColumnWidths?: {
    standard?: number[];
    sibling?: number[];
  };
}

interface Props {
  printOptions: BasicPrintOptions;
  showMethodology: boolean;
  showInterpretation: boolean;
  onChange: (update: {
    printOptions?: BasicPrintOptions;
    showMethodology?: boolean;
    showInterpretation?: boolean;
  }) => void;
}

// ── Sample CBC data (same analyte shape as edge fn) ───────────────────────────
const SAMPLE_ANALYTES_BY_GROUP = new Map([
  ['grp-cbc', [
    { parameter: 'Hemoglobin',            value: '8.2',   unit: 'g/dL',    reference_range: '13.5 - 17.5',    flag: 'low',  method: 'Photometry', interpretation_low: 'Low — Risk of Anemia',          section_heading: 'Red Blood Cell Indices', sort_order: 1  },
    { parameter: 'Red Blood Cell Count',  value: '4.5',   unit: '10⁶/µL', reference_range: '4.5 - 5.9',      flag: '',     method: 'Impedance',  section_heading: 'Red Blood Cell Indices', sort_order: 2  },
    { parameter: 'Hematocrit',            value: '27.1',  unit: '%',       reference_range: '42 - 52',         flag: 'low',  method: '',           interpretation_low: 'Low',                               section_heading: 'Red Blood Cell Indices', sort_order: 3  },
    { parameter: 'MCV',                   value: '60.2',  unit: 'fL',      reference_range: '78 - 100',        flag: 'low',  method: '',           is_auto_calculated: true, interpretation_low: 'Microcytic',  section_heading: 'Red Blood Cell Indices', sort_order: 4  },
    { parameter: 'MCH',                   value: '18.2',  unit: 'pg',      reference_range: '27 - 31',         flag: 'low',  method: '',           is_auto_calculated: true, interpretation_low: 'Hypochromic', section_heading: 'Red Blood Cell Indices', sort_order: 5  },
    { parameter: 'MCHC',                  value: '30.2',  unit: 'g/dL',   reference_range: '32 - 36',         flag: 'low',  method: '',           is_auto_calculated: true, interpretation_low: 'Hypochromic', section_heading: 'Red Blood Cell Indices', sort_order: 6  },
    { parameter: 'RDW-CV',               value: '16.5',  unit: '%',       reference_range: '11.5 - 14.0',    flag: 'high', method: '',           interpretation_high: 'High — Anisocytosis',              section_heading: 'Red Blood Cell Indices', sort_order: 7  },
    { parameter: 'Total Leukocyte Count', value: '12800', unit: '/cmm',    reference_range: '4000 - 10500',   flag: 'high', method: 'Impedance',  interpretation_high: 'Leukocytosis',                     section_heading: 'White Blood Cell Differential', sort_order: 8  },
    { id: 'neutrophils-pct', parameter: 'Neutrophils (%)', value: '72', unit: '%', reference_range: '50 - 80', flag: '', method: '', section_heading: 'White Blood Cell Differential', sort_order: 9, report_display_options: { sameRowSiblingAnalyteId: 'neutrophils-abs', sameRowSiblingLabel: 'Absolute Count' } },
    { id: 'neutrophils-abs', parameter: 'Neutrophils (Abs)', value: '9216', unit: '/cmm', reference_range: '1500 - 6600', flag: 'high', method: '', is_auto_calculated: true, interpretation_high: 'Neutrophilia', section_heading: 'White Blood Cell Differential', sort_order: 10 },
    { id: 'lymphocytes-pct', parameter: 'Lymphocytes (%)', value: '20', unit: '%', reference_range: '25 - 50', flag: 'low', method: '', interpretation_low: 'Lymphopenia', section_heading: 'White Blood Cell Differential', sort_order: 11, report_display_options: { sameRowSiblingAnalyteId: 'lymphocytes-abs', sameRowSiblingLabel: 'Absolute Count' } },
    { id: 'lymphocytes-abs', parameter: 'Lymphocytes (Abs)', value: '2560', unit: '/cmm', reference_range: '1500 - 3500', flag: '', method: '', is_auto_calculated: true, section_heading: 'White Blood Cell Differential', sort_order: 12 },
    { parameter: 'Monocytes (%)',         value: '5',     unit: '%',       reference_range: '2 - 10',          flag: '',     method: '',           section_heading: 'White Blood Cell Differential', sort_order: 13 },
    { parameter: 'Eosinophils (%)',       value: '2',     unit: '%',       reference_range: '0.0 - 5.0',      flag: '',     method: '',           section_heading: 'White Blood Cell Differential', sort_order: 14 },
    { parameter: 'Basophils (%)',         value: '1',     unit: '%',       reference_range: '0 - 2',           flag: '',     method: '',           section_heading: 'White Blood Cell Differential', sort_order: 15 },
    { parameter: 'Platelet Count',        value: '420000',unit: '/cmm',   reference_range: '150000 - 450000', flag: '',     method: 'Impedance',  section_heading: 'Platelet', sort_order: 16 },
    { parameter: 'ESR (After 1 hour)',    value: '38',    unit: 'mm/hr',   reference_range: '0 - 13',          flag: 'high', method: 'Westergren', interpretation_high: 'Elevated — Inflammation / Infection', section_heading: 'ESR', sort_order: 17 },
  ]],
]);
const SAMPLE_GROUP_NAMES = new Map([['grp-cbc', 'Complete Blood Count (CBC)']]);
// Keep in sync with DEFAULT_BASIC_REPORT_DISCLAIMER in
// supabase/functions/generate-pdf-letterhead/index.ts
const DEFAULT_BASIC_REPORT_DISCLAIMER =
  'This report is electronically generated and authenticated. Results relate only to the specimen received and should be correlated clinically. This report is not valid for medico-legal purposes.';
const DEFAULT_BASIC_STANDARD_WIDTHS = [36, 24, 12, 28];
const DEFAULT_BASIC_SIBLING_WIDTHS = [30, 14, 8, 16, 16, 16];

function normalizeBasicColumnWidths(raw: unknown, fallback: number[], expectedLength: number): number[] {
  if (!Array.isArray(raw) || raw.length !== expectedLength) return fallback;
  const values = raw.map((value) => Number(value));
  const total = values.reduce((sum, value) => sum + value, 0);
  if (values.some((value) => !Number.isFinite(value) || value <= 0) || Math.abs(total - 100) > 0.5) {
    return fallback;
  }
  return values;
}

function formatBasicWidth(value: number): string {
  return `${Number(value.toFixed(2))}%`;
}

function editableBasicColumnWidths(raw: unknown, fallback: number[], expectedLength: number): number[] {
  if (!Array.isArray(raw) || raw.length !== expectedLength) return fallback;
  return raw.map((value, index) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback[index];
  });
}

function withCalculatedLastWidth(widths: number[]): number[] {
  if (widths.length < 2) return widths;
  const lastIndex = widths.length - 1;
  const leading = widths.slice(0, lastIndex);
  const leadingTotal = leading.reduce((sum, width) => sum + width, 0);
  return [...leading, Math.max(1, Number((100 - leadingTotal).toFixed(2)))];
}

// ── Exact port of groupAnalytesBySectionHeading from edge fn ─────────────────
function groupAnalytesBySectionHeading(analytes: any[]): { heading: string | null; analytes: any[] }[] {
  const sorted = [...analytes].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  const hasHeadings = sorted.some((a) => a.section_heading);
  if (!hasHeadings) return [{ heading: null, analytes: sorted }];
  const blocks: { heading: string | null; analytes: any[] }[] = [];
  let currentHeading: string | null = null;
  let currentBlock: any[] = [];
  for (const analyte of sorted) {
    const h = analyte.section_heading ?? null;
    if (h !== currentHeading) {
      if (currentBlock.length > 0) blocks.push({ heading: currentHeading, analytes: currentBlock });
      currentHeading = h;
      currentBlock = [];
    }
    currentBlock.push(analyte);
  }
  if (currentBlock.length > 0) blocks.push({ heading: currentHeading, analytes: currentBlock });
  return blocks;
}

// ── Exact port of normalizeReportFlag from edge fn ───────────────────────────
function normalizeReportFlag(flag: string): { canonical: string } {
  const f = (flag || '').toLowerCase().trim();
  if (f === 'high' || f === 'h')           return { canonical: 'high' };
  if (f === 'low'  || f === 'l')           return { canonical: 'low' };
  if (f === 'critical_high' || f === 'ch') return { canonical: 'critical_high' };
  if (f === 'critical_low'  || f === 'cl') return { canonical: 'critical_low' };
  if (f === 'abnormal' || f === 'a')       return { canonical: 'abnormal' };
  return { canonical: f };
}

// ── Exact port of generateBasicDefaultTemplateHtml from edge fn ──────────────
function buildBasicHtml(
  testGroupNames: Map<string, string>,
  analytesByGroup: Map<string, any[]>,
  showMethodology: boolean,
  showInterpretation: boolean,
  printOptions: BasicPrintOptions,
): string {
  const basePx  = Math.max(8, Math.min(24, printOptions.baseFontSize ?? 14));
  const smallPx = Math.max(7, basePx - 3);
  const titlePx = basePx + 2;
  const sigPx   = basePx + 1;
  const testNameWeight = (printOptions.testNameBold ?? false) ? '600' : 'normal';
  const testNameAlignment = printOptions.testNameAlignment ?? 'left';
  const calcMarker = printOptions.calcMarker ?? 'cal';
  const boldAllValues = printOptions.boldAllValues ?? false;
  const boldAbnormal = printOptions.boldAbnormalValues ?? true;
  const sectionHeaderInline = printOptions.sectionHeaderInline ?? true;
  const flagSymbol = printOptions.flagSymbol ?? 'none';
  const showFlagLegend = printOptions.showFlagLegend ?? false;
  const testGroupTitlePosition = printOptions.testGroupTitlePosition ?? 'above_headers_center';
  const qrPosition = printOptions.qrPosition ?? 'bottom_left';
  const qrHorizontalOffset = Math.max(0, Math.min(80, printOptions.qrHorizontalOffset ?? 0));
  const headerQrTop = Math.max(10, Math.min(80, printOptions.headerQrTop ?? 20));
  const headerQrRight = Math.max(10, Math.min(80, printOptions.headerQrRight ?? 25));
  const signatureMaxHeight = Math.max(30, Math.min(120, Number(printOptions.signatureMaxHeight ?? 70)));
  const signatureMaxWidth = Math.max(80, Math.min(260, Number(printOptions.signatureMaxWidth ?? 180)));
  const signatureSampleCount = printOptions.reportSignatures?.enabled === false
    ? 0
    : Math.max(1, Math.min(3, Number(printOptions.reportSignatures?.maxCount ?? 1)));
  const resultTableBackground = printOptions.resultTableBackground === 'transparent' ? 'transparent' : '#fff';
  const sectionRowBackground = printOptions.resultTableBackground === 'transparent' ? 'transparent' : '#f5f5f5';
  const colCount = 4;
  const standardColumnWidths = normalizeBasicColumnWidths(printOptions.basicColumnWidths?.standard, DEFAULT_BASIC_STANDARD_WIDTHS, 4);
  const siblingColumnWidths = normalizeBasicColumnWidths(printOptions.basicColumnWidths?.sibling, DEFAULT_BASIC_SIBLING_WIDTHS, 6);
  const highColor = printOptions.resultColors?.enabled ? (printOptions.resultColors?.high ?? '#dc2626') : '#dc2626';
  const lowColor  = printOptions.resultColors?.enabled ? (printOptions.resultColors?.low  ?? '#000')    : '#000';
  const showReportDisclaimer = printOptions.showReportDisclaimer !== false;
  const reportDisclaimerText = (typeof printOptions.reportDisclaimer === 'string'
    ? printOptions.reportDisclaimer
    : DEFAULT_BASIC_REPORT_DISCLAIMER).trim();

  const noColorCss = `
<style>
.basic-report-template {
  font-size: ${basePx}px;
  line-height: 1.32;
  color: #000;
  font-family: Arial, Helvetica, sans-serif;
}

.basic-report-template table {
  border: none !important;
  border-collapse: collapse !important;
}

.basic-report-template td,
.basic-report-template th {
  color: #000 !important;
  font-weight: normal;
  background-color: ${resultTableBackground} !important;
  vertical-align: top !important;
}

.basic-report-template td {
  padding: 2px 4px !important;
}

.basic-report-template th {
  padding: 3px 4px !important;
}

.basic-report-template .result-normal,
.basic-report-template .flag-normal,
.basic-report-template .value-normal,
.basic-report-template .result-high,
.basic-report-template .flag-high,
.basic-report-template .value-high,
.basic-report-template .result-low,
.basic-report-template .flag-low,
.basic-report-template .value-low,
.basic-report-template .result-critical,
.basic-report-template .flag-critical,
.basic-report-template .value-critical,
.basic-report-template .result-abnormal,
.basic-report-template .flag-abnormal,
.basic-report-template .value-abnormal,
.basic-report-template .flag-trace,
.basic-report-template .value-trace {
  color: #000 !important;
  font-weight: normal;
}

.basic-report-template .report-title-bar {
  display: flex !important;
  align-items: center !important;
  border-top: 1.5px solid #000 !important;
  border-bottom: 1.5px solid #000 !important;
  padding: 4px 0 !important;
  margin: 6px 0 10px !important;
}

.basic-report-template .report-main-title {
  text-align: center !important;
  font-size: ${titlePx + 1}px !important;
  border: none !important;
  padding: 0 !important;
  margin: 0 !important;
  font-weight: 700 !important;
  color: #000 !important;
  line-height: 1.2 !important;
}

.basic-report-template .patient-header-table {
  width: 100% !important;
  table-layout: fixed !important;
  margin-bottom: 0 !important;
  border: none !important;
}

.basic-report-template .patient-header-table th {
  width: 15% !important;
  font-weight: 700 !important;
  text-align: left !important;
  color: #000 !important;
  padding: 2px 3px !important;
  white-space: nowrap !important;
  border: none !important;
}

.basic-report-template .patient-header-table td {
  width: 35% !important;
  padding: 2px 3px !important;
  border: none !important;
  color: #111 !important;
  word-break: break-word !important;
  font-size: ${basePx}px !important;
}

.basic-report-template .patient-header-table th {
  font-size: ${basePx}px !important;
}

.basic-report-template .tbl-results {
  width: 100% !important;
  table-layout: fixed !important;
  border-collapse: collapse !important;
  border: none !important;
  margin-top: 4px !important;
}

.basic-report-template .tbl-results thead th {
  border-top: 1.5px solid #000 !important;
  border-bottom: 1.5px solid #000 !important;
  border-left: none !important;
  border-right: none !important;
  font-weight: 700 !important;
  color: #000 !important;
  padding: 4px 4px !important;
  font-size: ${Math.max(10, basePx - 0.5)}px !important;
  vertical-align: middle !important;
}

.basic-report-template .tbl-results thead th:nth-child(1) { width: ${formatBasicWidth(standardColumnWidths[0])} !important; text-align: ${testNameAlignment} !important; }
.basic-report-template .tbl-results thead th:nth-child(2) { width: ${formatBasicWidth(standardColumnWidths[1])} !important; text-align: right !important; }
.basic-report-template .tbl-results thead th:nth-child(3) { width: ${formatBasicWidth(standardColumnWidths[2])} !important; text-align: left !important; }
.basic-report-template .tbl-results thead th:nth-child(4) { width: ${formatBasicWidth(standardColumnWidths[3])} !important; text-align: left !important; }
.basic-report-template .tbl-results.has-sibling thead th:nth-child(1) { width: ${formatBasicWidth(siblingColumnWidths[0])} !important; }
.basic-report-template .tbl-results.has-sibling thead th:nth-child(2) { width: ${formatBasicWidth(siblingColumnWidths[1])} !important; }
.basic-report-template .tbl-results.has-sibling thead th:nth-child(3) { width: ${formatBasicWidth(siblingColumnWidths[2])} !important; }
.basic-report-template .tbl-results.has-sibling thead th:nth-child(4) { width: ${formatBasicWidth(siblingColumnWidths[3])} !important; }
.basic-report-template .tbl-results.has-sibling thead th:nth-child(5) { width: ${formatBasicWidth(siblingColumnWidths[4])} !important; }
.basic-report-template .tbl-results.has-sibling thead th:nth-child(6) { width: ${formatBasicWidth(siblingColumnWidths[5])} !important; }
.basic-report-template .tbl-results tbody td:nth-child(1) { width: ${formatBasicWidth(standardColumnWidths[0])} !important; text-align: ${testNameAlignment} !important; color: #111 !important; }
.basic-report-template .tbl-results tbody td:nth-child(2) { width: ${formatBasicWidth(standardColumnWidths[1])} !important; text-align: right !important; }
.basic-report-template .tbl-results tbody td:nth-child(3) { width: ${formatBasicWidth(standardColumnWidths[2])} !important; text-align: left !important; color: #444 !important; white-space: nowrap !important; }
.basic-report-template .tbl-results tbody td:nth-child(4) { width: ${formatBasicWidth(standardColumnWidths[3])} !important; text-align: left !important; color: #666 !important; }

.basic-report-template .tbl-results.has-sibling tbody tr.sibling-data-row td:nth-child(1) { width: ${formatBasicWidth(siblingColumnWidths[0])} !important; }
.basic-report-template .tbl-results.has-sibling tbody tr.sibling-data-row td:nth-child(2) { width: ${formatBasicWidth(siblingColumnWidths[1])} !important; }
.basic-report-template .tbl-results.has-sibling tbody tr.sibling-data-row td:nth-child(3) { width: ${formatBasicWidth(siblingColumnWidths[2])} !important; }
.basic-report-template .tbl-results.has-sibling tbody tr.sibling-data-row td:nth-child(4) { width: ${formatBasicWidth(siblingColumnWidths[3])} !important; }
.basic-report-template .tbl-results.has-sibling tbody tr.sibling-data-row td:nth-child(5) { width: ${formatBasicWidth(siblingColumnWidths[4])} !important; text-align: right !important; }
.basic-report-template .tbl-results.has-sibling tbody tr.sibling-data-row td:nth-child(6) { width: ${formatBasicWidth(siblingColumnWidths[5])} !important; text-align: left !important; }

.basic-report-template .tbl-results td {
  border: none !important;
  padding: 2px 4px !important;
  line-height: 1.28 !important;
}

.basic-report-template .tbl-results tbody tr:not(.main-group-row):not(.sub-section-header):not(.interpretation-row):not(.descriptive-row) td {
  border-bottom: 0.5px dotted #e5e5e5 !important;
}

.basic-report-template .test-name-cell { vertical-align: top !important; }

.basic-report-template .test-name {
  font-size: ${basePx}px !important;
  font-weight: ${testNameWeight} !important;
  color: #111 !important;
  line-height: 1.22 !important;
}

.basic-report-template .test-method {
  font-size: ${smallPx}px !important;
  color: #444 !important;
  font-style: italic !important;
  margin-top: 1px !important;
  line-height: 1.2 !important;
}

.basic-report-template .val {
  text-align: right !important;
  vertical-align: top !important;
  font-size: ${basePx}px !important;
  font-weight: ${boldAllValues ? '600' : 'normal'} !important;
  font-variant-numeric: tabular-nums !important;
}

.basic-report-template .val.high,
.basic-report-template .val.critical_high,
.basic-report-template .val.critical_h,
.basic-report-template .val.H,
.basic-report-template .val.High {
  color: ${highColor} !important;
  ${boldAbnormal ? 'font-weight: 700 !important;' : ''}
}

.basic-report-template .val.low,
.basic-report-template .val.critical_low,
.basic-report-template .val.critical_l,
.basic-report-template .val.abnormal,
.basic-report-template .val.L,
.basic-report-template .val.Low {
  color: ${lowColor} !important;
  ${boldAbnormal ? 'font-weight: 700 !important;' : ''}
}

.basic-report-template .main-group-row td { padding: 0 !important; border: none !important; }

.basic-report-template .center-title {
  text-align: center !important;
  font-weight: 700 !important;
  text-decoration: underline !important;
  font-size: ${basePx + 1}px !important;
  margin: 8px 0 0 !important;
  text-transform: uppercase !important;
  line-height: 1.2 !important;
  color: #000 !important;
}

.basic-report-template .center-title.left {
  text-align: left !important;
  text-decoration: none !important;
  margin: 0 0 6px !important;
}

.basic-report-template .center-subtitle {
  text-align: center !important;
  font-size: ${smallPx + 1}px !important;
  margin: 2px 0 6px !important;
  color: #444 !important;
  font-weight: 600 !important;
}

.basic-report-template .sub-section-header td {
  font-weight: 700 !important;
  padding-top: ${sectionHeaderInline ? 6 : 12}px !important;
  padding-bottom: 3px !important;
  text-transform: uppercase !important;
  font-size: ${sectionHeaderInline ? basePx - 1 : smallPx + 1}px !important;
  letter-spacing: ${sectionHeaderInline ? 0 : 0.25}px !important;
  border: none !important;
  color: #000 !important;
  ${sectionHeaderInline ? `border-bottom: 0.5px solid #ccc !important; background-color: ${sectionRowBackground} !important;` : ''}
}

.basic-report-template .descriptive-row td {
  border-bottom: 0.5px dotted #e5e5e5 !important;
  color: #111 !important;
}

.basic-report-template .tbl-results.has-sibling .sub-section-header .sibling-section-title,
.basic-report-template .tbl-results.has-sibling .sub-section-header .sibling-section-label {
  width: auto !important;
}

.basic-report-template .tbl-results.has-sibling .sub-section-header .sibling-section-label {
  text-align: left !important;
  text-decoration: underline !important;
}

.basic-report-template .tbl-results .qualitative-wide-value {
  width: ${formatBasicWidth(standardColumnWidths.slice(1).reduce((sum, width) => sum + width, 0))} !important;
  text-align: left !important;
  white-space: normal !important;
  overflow: visible !important;
  overflow-wrap: anywhere !important;
  word-break: break-word !important;
}

.basic-report-template .interpretation-row td {
  padding: 1px 6px 4px 20px !important;
  font-size: ${smallPx}px !important;
  color: #333 !important;
  font-style: italic !important;
  border-bottom: none !important;
}

.basic-report-template .calculated-note {
  font-size: ${smallPx}px !important;
  color: #444 !important;
  margin: 3px 0 6px !important;
  font-style: italic !important;
}

.basic-report-template .group-interpretation-block {
  margin-top: 10px !important;
  font-size: ${basePx}px !important;
}

.basic-report-template .group-interpretation-block .section-header {
  font-size: ${basePx + 2}px !important;
  font-weight: 700 !important;
  color: #0b4aa2 !important;
  padding: 10px 0 6px 0 !important;
  margin: 16px 0 8px 0 !important;
  border-bottom: 2px solid #0b4aa2 !important;
  letter-spacing: 0.02em !important;
  background: transparent !important;
}

.basic-report-template .group-interpretation-block figure.table {
  margin: 8px 0 0 0 !important;
  width: 100% !important;
}

.basic-report-template .group-interpretation-block .tbl-interpretation {
  width: 100% !important;
  border-collapse: collapse !important;
  table-layout: fixed !important;
  font-size: ${basePx}px !important;
  border: 1px solid #d1daf0 !important;
  background: #fff !important;
  margin-top: 8px !important;
}

.basic-report-template .group-interpretation-block .tbl-interpretation thead th {
  background: #0b4aa2 !important;
  color: #fff !important;
  font-weight: 700 !important;
  padding: 9px 12px !important;
  text-align: left !important;
  font-size: ${basePx}px !important;
  border: 1px solid #0b4aa2 !important;
  vertical-align: top !important;
}

.basic-report-template .group-interpretation-block .tbl-interpretation tbody td {
  padding: 9px 12px !important;
  border: 1px solid #e2eaf8 !important;
  vertical-align: top !important;
  line-height: 1.5 !important;
  font-size: ${basePx}px !important;
  color: #1f2937 !important;
  word-break: break-word !important;
}

.basic-report-template .group-interpretation-block .tbl-interpretation tbody tr:nth-child(even) td {
  background: #f5f8ff !important;
}

.basic-report-template .group-interpretation-block .tbl-interpretation th:first-child,
.basic-report-template .group-interpretation-block .tbl-interpretation td:first-child {
  width: 100px !important;
  font-weight: 600 !important;
  white-space: nowrap !important;
  color: #1e3a6e !important;
}

.basic-report-template .group-interpretation-block .tbl-interpretation tbody td:first-child {
  border-left: 3px solid #cbd5e1 !important;
}

.basic-report-template .group-interpretation-block .note {
  margin-top: 10px !important;
  padding: 10px 14px !important;
  border-left: 4px solid #0b4aa2 !important;
  background: #f0f5ff !important;
  font-size: ${smallPx + 0.5}px !important;
  color: #334155 !important;
  line-height: 1.55 !important;
}

.basic-report-template .group-interpretation-block .note strong {
  color: #0b4aa2 !important;
}

.basic-report-template .report-sections {
  margin-top: 14px !important;
  border-top: 1px solid #000 !important;
  padding-top: 6px !important;
}

.basic-report-template .report-disclaimer {
  margin-top: 10px !important;
  padding-top: 6px !important;
  border-top: 0.5px solid #bbb !important;
  font-size: ${smallPx}px !important;
  color: #444 !important;
  font-style: italic !important;
  line-height: 1.4 !important;
}

.basic-report-template .report-footer {
  margin-top: 20px !important;
  padding-top: 8px !important;
  display: flex !important;
  justify-content: space-between !important;
  align-items: flex-end !important;
  page-break-inside: avoid !important;
  border-top: none !important;
}

.basic-report-template .report-footer .qr-verify {
  margin-left: ${qrHorizontalOffset}px !important;
}

.basic-report-template .qr-top-left-slot .qr-verify {
  margin-left: ${qrHorizontalOffset}px !important;
}

.basic-report-template .qr-top-right-slot .qr-verify {
  margin-right: ${qrHorizontalOffset}px !important;
}

.basic-report-template .auth-text {
  font-size: ${smallPx}px !important;
  color: #444 !important;
  font-style: italic !important;
  flex: 1 1 auto !important;
}

.basic-report-template .signature-row {
  display: flex !important;
  justify-content: flex-end !important;
  align-items: flex-end !important;
  gap: 14px !important;
  flex: 0 1 auto !important;
  max-width: 72% !important;
}
.basic-report-template .signature-box {
  text-align: right !important;
  flex: 0 1 150px !important;
  min-width: 0 !important;
  margin-left: 10px !important;
  overflow-wrap: anywhere !important;
}
.basic-report-template .signature-sample {
  max-height: ${signatureSampleCount >= 2 ? Math.min(signatureMaxHeight, 54) : signatureMaxHeight}px !important;
  max-width: ${signatureSampleCount >= 3 ? Math.min(signatureMaxWidth, 128) : signatureSampleCount === 2 ? Math.min(signatureMaxWidth, 150) : signatureMaxWidth}px !important;
  width: auto !important;
  height: auto !important;
  object-fit: contain !important;
  margin-bottom: 4px !important;
  display: block !important;
  margin-left: auto !important;
}

.basic-report-template .tbl-results th:last-child,
.basic-report-template .tbl-results td:last-child {
  display: table-cell !important;
}
</style>`;

  const patientInfoHtml = `
    <div class="report-title-bar">
      <div class="qr-top-left-slot" style="width:110px;flex-shrink:0;">
        ${qrPosition === 'top_left' ? `
          <div class="qr-verify" style="text-align:left;">
            <div style="width:46px;height:46px;border:1px solid #9ca3af;background:
              linear-gradient(90deg,#111 10%,transparent 10%,transparent 20%,#111 20%,#111 30%,transparent 30%,transparent 40%,#111 40%,#111 50%,transparent 50%,transparent 60%,#111 60%,#111 70%,transparent 70%,transparent 80%,#111 80%,#111 90%,transparent 90%),
              linear-gradient(#111 10%,transparent 10%,transparent 20%,#111 20%,#111 30%,transparent 30%,transparent 40%,#111 40%,#111 50%,transparent 50%,transparent 60%,#111 60%,#111 70%,transparent 70%,transparent 80%,#111 80%,#111 90%,transparent 90%);
              background-size:10px 10px;background-color:#fff;"></div>
            <p style="margin:2px 0 0;font-size:9px;color:#6b7280;">Scan to verify</p>
          </div>` : ''}
      </div>
      <h2 class="report-main-title" style="flex:1;">TEST REPORT</h2>
      <div class="qr-top-right-slot" style="width:110px;flex-shrink:0;text-align:right;">
        ${qrPosition === 'top_right' ? `
          <div class="qr-verify" style="display:inline-block;text-align:left;">
            <div style="width:46px;height:46px;border:1px solid #9ca3af;background:
              linear-gradient(90deg,#111 10%,transparent 10%,transparent 20%,#111 20%,#111 30%,transparent 30%,transparent 40%,#111 40%,#111 50%,transparent 50%,transparent 60%,#111 60%,#111 70%,transparent 70%,transparent 80%,#111 80%,#111 90%,transparent 90%),
              linear-gradient(#111 10%,transparent 10%,transparent 20%,#111 20%,#111 30%,transparent 30%,transparent 40%,#111 40%,#111 50%,transparent 50%,transparent 60%,#111 60%,#111 70%,transparent 70%,transparent 80%,#111 80%,#111 90%,transparent 90%);
              background-size:10px 10px;background-color:#fff;"></div>
            <p style="margin:2px 0 0;font-size:9px;color:#6b7280;">Scan to verify</p>
          </div>` : ''}
      </div>
    </div>
    <figure class="table" style="margin:0;">
      <table class="patient-header-table">
        <tbody>
          <tr>
            <th>Name</th><td>: John Doe</td>
            <th>Reg. No</th><td>: LB-2026-00142</td>
          </tr>
          <tr>
            <th>Age / Sex</th><td>: 42Y / Male</td>
            <th>Reg. Date</th><td>: 17-Mar-2026</td>
          </tr>
          <tr>
            <th>Ref. By</th><td>: Dr. A. Sharma</td>
            <th>Report Date</th><td>: 17-Mar-2026</td>
          </tr>
        </tbody>
      </table>
    </figure>
  `;

  let testResultsHtml = '<div class="test-results">';

  for (const [groupId, analytes] of analytesByGroup) {
    if (!analytes || analytes.length === 0) continue;

    const groupName = testGroupNames.get(groupId) || analytes[0]?.test_name || 'Test Results';
    const hasCalcInGroup = analytes.some((a: any) => a.is_auto_calculated || a.is_calculated);
    const specimenText = analytes[0]?.specimen
      ? `<div class="center-subtitle">Specimen: ${analytes[0].specimen}</div>`
      : '';

    const groupTitleBelowHeaders = testGroupTitlePosition === 'below_headers';
    const groupTitleClass = testGroupTitlePosition === 'above_headers_left' ? 'center-title left' : 'center-title';
    const analyteById = new Map<string, any>();
    const sameRowSiblingIds = new Set<string>();
    const sectionsWithSiblings = new Set<string | null>();
    let sameRowSiblingLabel = 'Absolute Count';
    for (const analyte of analytes) {
      if (analyte.id) analyteById.set(String(analyte.id), analyte);
    }
    for (const analyte of analytes) {
      const options = analyte.report_display_options || {};
      const siblingId = String(options.sameRowSiblingAnalyteId || '').trim();
      if (siblingId && analyteById.has(siblingId)) {
        sameRowSiblingIds.add(siblingId);
        sectionsWithSiblings.add(analyte.section_heading ?? null);
        if (options.sameRowSiblingLabel) sameRowSiblingLabel = String(options.sameRowSiblingLabel);
      }
    }
    const hasSameRowSibling = sameRowSiblingIds.size > 0;
    const effectiveColCount = hasSameRowSibling ? 6 : colCount;

    testResultsHtml += `
      <figure class="table" style="margin: 0 0 14px;">
        ${!groupTitleBelowHeaders ? `
          <div class="${groupTitleClass}" style="font-size:${basePx + 1}px;">${groupName}</div>
          ${specimenText}
		        ` : ''}
		        <table class="tbl-results${hasSameRowSibling ? ' has-sibling' : ''}">
              ${hasSameRowSibling ? `<colgroup>
                ${siblingColumnWidths.map((width) => `<col style="width:${formatBasicWidth(width)}">`).join('')}
              </colgroup>` : ''}
		          <thead>
		            <tr>
		              <th style="font-size:${basePx}px;">TEST NAME</th>
		              <th style="font-size:${basePx}px;">VALUE</th>
		              <th style="font-size:${basePx}px;">UNITS</th>
		              <th style="font-size:${basePx}px;">Bio. Ref. Interval</th>
                  ${hasSameRowSibling ? '<th></th><th></th>' : ''}
		            </tr>
		          </thead>
		          <tbody>
		            ${groupTitleBelowHeaders ? `
            <tr class="main-group-row">
              <td colspan="${effectiveColCount}">
                <div class="center-title" style="font-size:${basePx + 1}px;">${groupName}</div>
                ${specimenText}
              </td>
            </tr>
            ` : ''}
    `;

    const sectionBlocks = groupAnalytesBySectionHeading(analytes);
    for (const block of sectionBlocks) {
      const sectionHasSiblings = sectionsWithSiblings.has(block.heading);
      if (block.heading) {
        testResultsHtml += `
            <tr class="sub-section-header">
              ${sectionHasSiblings
                ? `<td class="sibling-section-title" colspan="4">${block.heading}</td><td class="sibling-section-label" colspan="2">${sameRowSiblingLabel}</td>`
                : `<td colspan="${effectiveColCount}" style="font-size:${smallPx + 1}px;">${block.heading}</td>`}
            </tr>
        `;
      }

      for (const analyte of block.analytes) {
        if (analyte.id && sameRowSiblingIds.has(String(analyte.id))) continue;
        const parameterName = analyte.parameter || analyte.name || analyte.test_name || '';
        const isCalculated    = analyte.is_auto_calculated || analyte.is_calculated;
        const rawValue        = analyte.value ?? '';
        const value           = formatAnalyteDisplayValue(analyte, printOptions, rawValue);
        const unit          = analyte.unit || '';
        const refRange      = analyte.reference_range || '';
        const flag          = analyte.flag || '';
        const normalizedFlag  = normalizeReportFlag(flag);
        const canonicalFlag   = normalizedFlag.canonical;

        const unitText      = String(unit || '').trim().toLowerCase();
        const refText       = String(refRange || '').trim();
        const hasNumericRef = /\d/.test(refText);
        const valueTypeRaw = String(analyte.value_type || '').toLowerCase();
        const isQualitativeWithoutMetadata =
          valueTypeRaw === 'qualitative' && !unitText && !refText;
        const isDescriptive =
          valueTypeRaw !== 'qualitative' &&
          (unitText === 'n/a' || unitText === 'na' || unitText === '-' ||
          unitText === 'none' || unitText === 'not applicable' ||
          (!unitText && refText && !hasNumericRef));

        const isNumericHigh = canonicalFlag === 'high' || canonicalFlag === 'critical_high';
        const isNumericLow  = canonicalFlag === 'low'  || canonicalFlag === 'critical_low';

        const asteriskSuffix = (printOptions?.flagAsterisk && (isNumericHigh || isNumericLow))
          ? (printOptions?.flagAsteriskCritical &&
              (canonicalFlag === 'critical_high' || canonicalFlag === 'critical_low')
              ? '***' : '**')
          : '';

        // Short flag symbol: H / L / A / H* / L*
        const flagSymbolText = (() => {
          if (!canonicalFlag || canonicalFlag === 'normal') return '';
          if (canonicalFlag === 'high') return 'H';
          if (canonicalFlag === 'low') return 'L';
          if (canonicalFlag === 'critical_high') return 'H*';
          if (canonicalFlag === 'critical_low') return 'L*';
          if (canonicalFlag === 'abnormal') return 'A';
          return '';
        })();

        const displayValue = flagSymbol === 'before' && flagSymbolText
          ? `<span style="display:inline-block;min-width:${basePx * 1.15}px;text-align:center;font-weight:700;margin-right:4px;">${flagSymbolText}</span>${value + asteriskSuffix}`
          : flagSymbol === 'after' && flagSymbolText
          ? `${value + asteriskSuffix} <span style="font-weight:700;">${flagSymbolText}</span>`
          : value + asteriskSuffix;

        if (isDescriptive) {
          testResultsHtml += `
              <tr class="descriptive-row">
                <td colspan="${effectiveColCount}" style="font-size: ${basePx}px;">
                  <span style="font-weight:600;">${parameterName}</span>: ${value || refText || ''}
                </td>
              </tr>
          `;
          continue;
        }

        const valClass = canonicalFlag ? `val ${canonicalFlag}` : 'val';
        const siblingId = String(analyte.report_display_options?.sameRowSiblingAnalyteId || '').trim();
        const siblingAnalyte = siblingId ? analyteById.get(siblingId) : null;
        const siblingValue = siblingAnalyte?.value ?? '';
        const siblingUnit = siblingAnalyte?.unit || '';
        const siblingRefRange = siblingAnalyte?.reference_range || '';
        const siblingFlag = siblingAnalyte ? normalizeReportFlag(siblingAnalyte.flag || '').canonical : '';
        const siblingValClass = siblingFlag ? `val ${siblingFlag}` : 'val';

        const calcSuffix = isCalculated
          ? calcMarker === 'asterisk' ? `<sup style="font-size:${smallPx - 1}px; color:#444; margin-left:1px;">*</sup>`
          : calcMarker === 'cal'      ? `<span style="font-size:${smallPx - 1}px; color:#888; margin-left:2px; font-style:italic;">*cal</span>`
          : ''
          : '';

        testResultsHtml += `
              <tr class="${sectionHasSiblings ? 'sibling-data-row' : ''} ${isQualitativeWithoutMetadata ? 'qualitative-wide-row' : ''}">
                <td class="test-name-cell">
                  <div class="test-name" style="font-size:${basePx}px; font-weight:${testNameWeight};">
                    ${parameterName}${calcSuffix}
                  </div>
                  ${showMethodology && analyte.method ? `<div class="test-method" style="font-size:${smallPx}px;">${analyte.method}</div>` : ''}
                </td>
                ${isQualitativeWithoutMetadata
                  ? `<td class="${valClass} qualitative-wide-value" colspan="3" style="font-size:${basePx}px;">${displayValue}</td>`
                  : `<td class="${valClass}" style="font-size:${basePx}px;">${displayValue}</td>
                <td style="text-align:left; vertical-align:top; font-size:${basePx}px; color:#444;">${unit}</td>
                <td style="text-align:left; vertical-align:top; font-size:${smallPx + 1}px; color:#666;">${refRange}</td>
                ${sectionHasSiblings
                  ? `<td style="text-align:right; vertical-align:top;"><span class="${siblingValClass}">${siblingValue}</span>${siblingUnit ? ` <span style="color:#444;font-weight:normal;">${siblingUnit}</span>` : ''}</td>
                <td style="text-align:left; vertical-align:top; font-size:${smallPx + 1}px; color:#666;">${siblingRefRange}</td>`
                  : ''}`}
              </tr>
        `;

        if (showInterpretation) {
          let interp = '';
          if (isNumericHigh) interp = analyte.interpretation_high || '';
          else if (isNumericLow) interp = analyte.interpretation_low || '';
          else interp = analyte.interpretation_normal || '';
          if (interp) {
            testResultsHtml += `
              <tr class="interpretation-row">
                <td colspan="${effectiveColCount}" style="font-size:${smallPx}px;">${interp}</td>
              </tr>
            `;
          }
        }
      }
    }

    testResultsHtml += `
          </tbody>
        </table>
        ${(() => {
          const parts: string[] = [];
          if (hasCalcInGroup && calcMarker === 'asterisk') parts.push('* Calculated parameter');
          if (printOptions.flagAsterisk) parts.push('** Abnormal value');
          if (printOptions.flagAsterisk && printOptions.flagAsteriskCritical) parts.push('*** Critical value');
          if (showFlagLegend && flagSymbol !== 'none') parts.push('H = High &nbsp; L = Low &nbsp; A = Abnormal &nbsp; H* = Critical High &nbsp; L* = Critical Low');
          return parts.length ? `<p class="calculated-note">${parts.join(' &nbsp;|&nbsp; ')}</p>` : '';
        })()}
        ${analytes[0]?.groupInterpretation ? `<div class="group-interpretation-block">${analytes[0].groupInterpretation}</div>` : ''}
      </figure>
    `;
  }

  testResultsHtml += '</div>';

  const sampleSignatureBlocks = Array.from({ length: signatureSampleCount }, (_, index) => `
      <div class="signature-box">
        <svg class="signature-sample" viewBox="0 0 220 80" xmlns="http://www.w3.org/2000/svg" aria-label="Sample signature">
          <path d="M12 48 C35 12, 45 78, 62 38 S91 20, 104 47 S132 70, 144 34 S171 20, 188 44 S207 54, 216 31" fill="none" stroke="#1d4ed8" stroke-width="4" stroke-linecap="round"/>
          <path d="M30 64 C78 58, 145 61, 214 50" fill="none" stroke="#1d4ed8" stroke-width="3" stroke-linecap="round"/>
        </svg>
        <div style="font-weight:700; font-size:${Math.max(9, sigPx - (signatureSampleCount >= 3 ? 1 : 0))}px; line-height:1.15;">${index === 0 ? 'Dr. Signatory Name' : `Dr. Signatory ${index + 1}`}</div>
        <div style="font-size:${Math.max(8, basePx - 2)}px; margin-top:2px; line-height:1.15;">MD Pathology</div>
      </div>
  `).join('');

  const signatoryHtml = `
    <div class="report-footer">
      ${qrPosition === 'bottom_left' ? `<div class="qr-verify" style="text-align:left;">
        <div style="width:60px;height:60px;border:1px solid #9ca3af;background:
          linear-gradient(90deg,#111 10%,transparent 10%,transparent 20%,#111 20%,#111 30%,transparent 30%,transparent 40%,#111 40%,#111 50%,transparent 50%,transparent 60%,#111 60%,#111 70%,transparent 70%,transparent 80%,#111 80%,#111 90%,transparent 90%),
          linear-gradient(#111 10%,transparent 10%,transparent 20%,#111 20%,#111 30%,transparent 30%,transparent 40%,#111 40%,#111 50%,transparent 50%,transparent 60%,#111 60%,#111 70%,transparent 70%,transparent 80%,#111 80%,#111 90%,transparent 90%);
          background-size:12px 12px;background-color:#fff;"></div>
        <p style="margin:2px 0 0 0;font-size:9px;color:#6b7280;">Scan to verify</p>
      </div>` : '<div></div>'}
      <div class="auth-text">Authenticated Electronic Report</div>
      <div class="signature-row">${sampleSignatureBlocks}</div>
    </div>
  `;

  const headerQrHtml = qrPosition === 'header_right' ? `
    <div style="position:absolute;top:${headerQrTop}px;right:${headerQrRight}px;z-index:10;text-align:left;">
      <div style="width:55px;height:55px;border:1px solid #9ca3af;background:
        linear-gradient(90deg,#111 10%,transparent 10%,transparent 20%,#111 20%,#111 30%,transparent 30%,transparent 40%,#111 40%,#111 50%,transparent 50%,transparent 60%,#111 60%,#111 70%,transparent 70%,transparent 80%,#111 80%,#111 90%,transparent 90%),
        linear-gradient(#111 10%,transparent 10%,transparent 20%,#111 20%,#111 30%,transparent 30%,transparent 40%,#111 40%,#111 50%,transparent 50%,transparent 60%,#111 60%,#111 70%,transparent 70%,transparent 80%,#111 80%,#111 90%,transparent 90%);
        background-size:11px 11px;background-color:#fff;"></div>
      <p style="margin:2px 0 0 0;font-size:8px;color:#555;">Scan to verify</p>
    </div>` : '';

  const disclaimerHtml = (showReportDisclaimer && reportDisclaimerText)
    ? `<div class="report-disclaimer">${reportDisclaimerText
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br />')}</div>`
    : '';

  return `
    ${noColorCss}
    <div class="basic-report-template" style="position:relative;font-family: Arial, Helvetica, sans-serif; font-size: ${basePx}px; color: #000;">
      ${headerQrHtml}
      ${patientInfoHtml}
      ${testResultsHtml}
      ${disclaimerHtml}
      ${signatoryHtml}
    </div>
  `;
}

// ── Controls ──────────────────────────────────────────────────────────────────

function Toggle({ checked, disabled, onChange }: { checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-offset-1 focus:ring-indigo-500 disabled:opacity-40 ${checked ? 'bg-indigo-600' : 'bg-gray-300'}`}
    >
      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-4' : 'translate-x-1'}`} />
    </button>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5 border-b border-gray-100 last:border-0">
      <div>
        <p className="text-sm font-medium text-gray-800">{label}</p>
        {hint && <p className="text-xs text-gray-400 mt-0.5">{hint}</p>}
      </div>
      <div className="shrink-0 flex items-center">{children}</div>
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function BasicTemplateFormatBuilder({ printOptions, showMethodology, showInterpretation, onChange }: Props) {
  const setPO = (patch: Partial<BasicPrintOptions>) =>
    onChange({ printOptions: { ...printOptions, ...patch } });
  const standardWidths = withCalculatedLastWidth(editableBasicColumnWidths(printOptions.basicColumnWidths?.standard, DEFAULT_BASIC_STANDARD_WIDTHS, 4));
  const siblingWidths = withCalculatedLastWidth(editableBasicColumnWidths(printOptions.basicColumnWidths?.sibling, DEFAULT_BASIC_SIBLING_WIDTHS, 6));
  const siblingBlockStart = Number(siblingWidths.slice(0, 4).reduce((sum, width) => sum + width, 0).toFixed(2));
  const setColumnWidth = (kind: 'standard' | 'sibling', index: number, value: number) => {
    const current = kind === 'standard' ? standardWidths : siblingWidths;
    const lastIndex = current.length - 1;
    if (index === lastIndex) return;
    const otherLeadingTotal = current
      .slice(0, lastIndex)
      .reduce((sum, width, widthIndex) => widthIndex === index ? sum : sum + width, 0);
    const cappedValue = Math.max(1, Math.min(Number(value) || 1, 99 - otherLeadingTotal));
    const next = current.map((width, widthIndex) => widthIndex === index ? cappedValue : width);
    next[lastIndex] = Number((100 - next.slice(0, lastIndex).reduce((sum, width) => sum + width, 0)).toFixed(2));
    setPO({
      basicColumnWidths: {
        ...(printOptions.basicColumnWidths || {}),
        [kind]: next,
      },
    });
  };
  const setSiblingBlockStart = (value: number) => {
    const nextStart = Math.max(45, Math.min(80, Number(value) || 68));
    const currentLeftTotal = siblingWidths.slice(0, 4).reduce((sum, width) => sum + width, 0);
    const currentRightTotal = siblingWidths.slice(4).reduce((sum, width) => sum + width, 0);
    const leftScale = nextStart / currentLeftTotal;
    const rightScale = (100 - nextStart) / currentRightTotal;
    const next = siblingWidths.map((width, index) =>
      Number((width * (index < 4 ? leftScale : rightScale)).toFixed(2)),
    );
    next[next.length - 1] = Number((100 - next.slice(0, -1).reduce((sum, width) => sum + width, 0)).toFixed(2));
    setPO({
      basicColumnWidths: {
        ...(printOptions.basicColumnWidths || {}),
        sibling: next,
      },
    });
  };

  const html = useMemo(
    () => buildBasicHtml(SAMPLE_GROUP_NAMES, SAMPLE_ANALYTES_BY_GROUP, showMethodology, showInterpretation, printOptions),
    [printOptions, showMethodology, showInterpretation],
  );

  return (
    <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
      <div className="px-4 py-3 bg-gray-50 border-b border-gray-200">
        <span className="text-sm font-semibold text-gray-800">Basic (Old School) — Live Preview</span>
        <span className="ml-2 text-xs text-gray-400">Exact output from PDF engine · sample CBC data</span>
      </div>

      <div className="flex flex-col lg:flex-row divide-y lg:divide-y-0 lg:divide-x divide-gray-200">

        {/* Settings */}
	        <div className="lg:w-72 shrink-0 p-4 space-y-0.5 overflow-y-auto" style={{ maxHeight: 600 }}>
          <Row label="Base Font Size" hint="8 – 24 px">
            <div className="flex items-center gap-2">
              <input
                type="range" min={8} max={24} step={1}
                value={printOptions.baseFontSize ?? 14}
                onChange={(e) => setPO({ baseFontSize: Number(e.target.value) })}
                className="w-24 accent-indigo-600"
              />
              <span className="w-6 text-sm font-mono font-semibold text-gray-700">
                {printOptions.baseFontSize ?? 14}
              </span>
            </div>
          </Row>
          <Row label="Show Methodology" hint="Italic method below test name">
            <Toggle checked={showMethodology} onChange={(v) => onChange({ showMethodology: v })} />
          </Row>
          <Row label="Show Interpretation" hint="Italic text below flagged rows">
            <Toggle checked={showInterpretation} onChange={(v) => onChange({ showInterpretation: v })} />
          </Row>
          <Row label="Report Background" hint="Transparent prints directly over the uploaded letterhead watermark">
            <select
              value={printOptions.resultTableBackground ?? 'white'}
              onChange={(e) => setPO({ resultTableBackground: e.target.value as BasicPrintOptions['resultTableBackground'] })}
              className="text-sm border border-gray-300 rounded px-2 py-1 bg-white"
            >
              <option value="white">White rows</option>
              <option value="transparent">Transparent</option>
            </select>
          </Row>
          <Row label="Test Name Bold" hint="Bold test names (off = normal weight)">
            <Toggle checked={printOptions.testNameBold ?? false} onChange={(v) => setPO({ testNameBold: v })} />
          </Row>
          <Row label="Test Name Align" hint="Horizontal alignment of test name column">
            <select
              value={printOptions.testNameAlignment ?? 'left'}
              onChange={(e) => setPO({ testNameAlignment: e.target.value as 'left' | 'center' | 'right' })}
              className="text-sm border border-gray-300 rounded px-2 py-1 bg-white"
            >
              <option value="left">Left</option>
              <option value="center">Center</option>
              <option value="right">Right</option>
            </select>
          </Row>
          <Row label="Bold All Values" hint="All result values semi-bold (off = normal weight)">
            <Toggle checked={printOptions.boldAllValues ?? false} onChange={(v) => setPO({ boldAllValues: v })} />
          </Row>
          <Row label="Bold Abnormal Values" hint="Extra bold for high/low values (off = normal weight)">
            <Toggle checked={printOptions.boldAbnormalValues ?? true} onChange={(v) => setPO({ boldAbnormalValues: v })} />
          </Row>
          <Row label="Calculated Marker" hint="How to mark auto-calculated fields">
            <select
              value={printOptions.calcMarker ?? 'cal'}
              onChange={(e) => setPO({ calcMarker: e.target.value as 'asterisk' | 'cal' | 'none' })}
              className="text-sm border border-gray-300 rounded px-2 py-1 bg-white"
            >
              <option value="asterisk">* (superscript)</option>
              <option value="cal">*cal (text)</option>
              <option value="none">None</option>
            </select>
          </Row>
          <Row label="Decimal Places" hint="Lab-wide result precision. Individual analytes can override this in the analyte editor">
            <select
              value={printOptions.defaultDecimalPlaces ?? ''}
              onChange={(e) => setPO({ defaultDecimalPlaces: e.target.value === '' ? null : Number(e.target.value) })}
              className="text-sm border border-gray-300 rounded px-2 py-1 bg-white"
            >
              <option value="">As entered</option>
              <option value="0">0 — Integer (150)</option>
              <option value="1">1 — 0.0</option>
              <option value="2">2 — 0.00</option>
              <option value="3">3 — 0.000</option>
              <option value="4">4 — 0.0000</option>
            </select>
          </Row>
          <Row label="Pad Decimals" hint="Keep trailing zeros so the value column lines up (12.3 prints as 12.30)">
            <Toggle checked={printOptions.padDecimals ?? false} onChange={(v) => setPO({ padDecimals: v })} />
          </Row>
          <Row label="Leading Zeros" hint="Fixed-width legacy formats only — pads the whole-number part (3 prints as 03)">
            <select
              value={printOptions.minIntegerDigits ?? ''}
              onChange={(e) => setPO({ minIntegerDigits: e.target.value === '' ? null : Number(e.target.value) })}
              className="text-sm border border-gray-300 rounded px-2 py-1 bg-white"
            >
              <option value="">Off</option>
              <option value="2">2 digits (03)</option>
              <option value="3">3 digits (003)</option>
              <option value="4">4 digits (0003)</option>
            </select>
          </Row>
          <Row label="Section Header Style" hint="Small caps label vs inline shaded row">
            <select
              value={(printOptions.sectionHeaderInline ?? true) ? 'inline' : 'label'}
              onChange={(e) => setPO({ sectionHeaderInline: e.target.value === 'inline' })}
              className="text-sm border border-gray-300 rounded px-2 py-1 bg-white"
            >
              <option value="label">Small caps label</option>
              <option value="inline">Inline shaded row</option>
            </select>
          </Row>
          <Row label="Test Group Title" hint="Place panel name above headers or below them">
            <select
              value={printOptions.testGroupTitlePosition ?? 'above_headers_center'}
              onChange={(e) => setPO({ testGroupTitlePosition: e.target.value as BasicPrintOptions['testGroupTitlePosition'] })}
              className="text-sm border border-gray-300 rounded px-2 py-1 bg-white"
            >
              <option value="below_headers">Below headers</option>
              <option value="above_headers_center">Above headers centered</option>
              <option value="above_headers_left">Above headers left</option>
            </select>
          </Row>
          <Row label="QR Position" hint="Place verification QR in the report title or footer">
            <select
              value={printOptions.qrPosition ?? 'bottom_left'}
              onChange={(e) => setPO({ qrPosition: e.target.value as BasicPrintOptions['qrPosition'] })}
              className="text-sm border border-gray-300 rounded px-2 py-1 bg-white"
            >
              <option value="bottom_left">Bottom left</option>
              <option value="top_left">Top left</option>
              <option value="top_right">Top right</option>
              <option value="header_right">Header right (letterhead area)</option>
            </select>
          </Row>
          {printOptions.qrPosition === 'header_right' ? (
            <>
              <Row label="Header QR Top" hint="Distance from top of page (px)">
                <div className="flex items-center gap-2">
                  <input
                    type="range" min={10} max={80} step={2}
                    value={printOptions.headerQrTop ?? 20}
                    onChange={(e) => setPO({ headerQrTop: Number(e.target.value) })}
                    className="w-24 accent-indigo-600"
                  />
                  <span className="w-10 text-sm font-mono font-semibold text-gray-700">
                    {printOptions.headerQrTop ?? 20}
                  </span>
                </div>
              </Row>
              <Row label="Header QR Right" hint="Distance from right edge (px)">
                <div className="flex items-center gap-2">
                  <input
                    type="range" min={10} max={80} step={2}
                    value={printOptions.headerQrRight ?? 25}
                    onChange={(e) => setPO({ headerQrRight: Number(e.target.value) })}
                    className="w-24 accent-indigo-600"
                  />
                  <span className="w-10 text-sm font-mono font-semibold text-gray-700">
                    {printOptions.headerQrRight ?? 25}
                  </span>
                </div>
              </Row>
            </>
          ) : (
            <Row
              label="QR Horizontal Shift"
              hint={printOptions.qrPosition === 'top_right'
                ? 'Move the top-right QR left from the right edge'
                : 'Move the QR right from the left edge'}
            >
              <div className="flex items-center gap-2">
                <input
                  type="range" min={0} max={80} step={2}
                  value={printOptions.qrHorizontalOffset ?? 0}
                  onChange={(e) => setPO({ qrHorizontalOffset: Number(e.target.value) })}
                  className="w-24 accent-indigo-600"
                />
                <span className="w-10 text-sm font-mono font-semibold text-gray-700">
                  {printOptions.qrHorizontalOffset ?? 0}
                </span>
              </div>
            </Row>
          )}
          <Row label="Signature Height" hint="Image max height in PDF (30-120 px)">
            <div className="flex items-center gap-2">
              <input
                type="range" min={30} max={120} step={5}
                value={printOptions.signatureMaxHeight ?? 70}
                onChange={(e) => setPO({ signatureMaxHeight: Number(e.target.value) })}
                className="w-24 accent-indigo-600"
              />
              <span className="w-10 text-sm font-mono font-semibold text-gray-700">
                {printOptions.signatureMaxHeight ?? 70}
              </span>
            </div>
          </Row>
          <Row label="Signature Width" hint="Image max width in PDF (80-260 px)">
            <div className="flex items-center gap-2">
              <input
                type="range" min={80} max={260} step={10}
                value={printOptions.signatureMaxWidth ?? 180}
                onChange={(e) => setPO({ signatureMaxWidth: Number(e.target.value) })}
                className="w-24 accent-indigo-600"
              />
              <span className="w-10 text-sm font-mono font-semibold text-gray-700">
                {printOptions.signatureMaxWidth ?? 180}
              </span>
            </div>
          </Row>
          <Row label="Disclaimer" hint="Printed above the QR & signature at the end of the report">
            <Toggle
              checked={printOptions.showReportDisclaimer !== false}
              onChange={(v) => setPO({ showReportDisclaimer: v })}
            />
          </Row>
          {printOptions.showReportDisclaimer !== false && (
            <div className="py-2.5 border-b border-gray-100">
              <textarea
                rows={4}
                value={printOptions.reportDisclaimer ?? DEFAULT_BASIC_REPORT_DISCLAIMER}
                onChange={(e) => setPO({ reportDisclaimer: e.target.value })}
                placeholder="Disclaimer text printed at the end of every report"
                className="w-full text-xs border border-gray-300 rounded px-2 py-1.5 resize-y focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
              <button
                type="button"
                onClick={() => setPO({ reportDisclaimer: DEFAULT_BASIC_REPORT_DISCLAIMER })}
                className="mt-1 text-xs text-indigo-600 hover:underline"
              >
                Reset to default
              </button>
            </div>
          )}
          <Row label="Section Field %" hint="Field name width for section-only reports (20-70%)">
            <div className="flex items-center gap-2">
              <input
                type="range" min={20} max={70} step={5}
                value={printOptions.sectionFieldNamePct ?? 40}
                onChange={(e) => setPO({ sectionFieldNamePct: Number(e.target.value) })}
                className="w-24 accent-indigo-600"
              />
              <span className="w-10 text-sm font-mono font-semibold text-gray-700">
                {printOptions.sectionFieldNamePct ?? 40}%
              </span>
            </div>
          </Row>
	          <Row label="4-Col Widths" hint="Edit first 3; Ref auto-fills to 100">
	            <div className="grid grid-cols-4 gap-1">
	              {standardWidths.map((width, index) => (
	                <input
	                  key={`standard-width-${index}`}
	                  type="number"
	                  min={1}
	                  max={97}
	                  step={1}
	                  value={width}
	                  readOnly={index === standardWidths.length - 1}
	                  onChange={(e) => setColumnWidth('standard', index, Number(e.target.value))}
	                  className={`w-11 text-xs border border-gray-300 rounded px-1 py-0.5 text-right ${index === standardWidths.length - 1 ? 'bg-gray-100 text-gray-500' : ''}`}
	                />
	              ))}
	            </div>
	          </Row>
	          <Row label="Sibling Widths" hint="Edit first 5; Abs Ref auto-fills">
	            <div className="grid grid-cols-6 gap-1">
	              {siblingWidths.map((width, index) => (
	                <input
	                  key={`sibling-width-${index}`}
	                  type="number"
	                  min={1}
	                  max={95}
	                  step={1}
	                  value={width}
	                  readOnly={index === siblingWidths.length - 1}
	                  onChange={(e) => setColumnWidth('sibling', index, Number(e.target.value))}
	                  className={`w-9 text-xs border border-gray-300 rounded px-1 py-0.5 text-right ${index === siblingWidths.length - 1 ? 'bg-gray-100 text-gray-500' : ''}`}
	                />
	              ))}
            </div>
          </Row>
          <Row
            label="Absolute Count Start"
            hint="Lower value moves the sibling block left"
          >
            <div className="flex flex-col items-end gap-1.5">
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={45}
                  max={80}
                  step={1}
                  value={siblingBlockStart}
                  onChange={(e) => setSiblingBlockStart(Number(e.target.value))}
                  className="w-24 accent-indigo-600"
                />
                <span className="w-10 text-sm font-mono font-semibold text-gray-700">
                  {siblingBlockStart}%
                </span>
              </div>
              <div className="flex h-4 w-36 overflow-hidden rounded border border-gray-300 text-[9px] leading-4">
                <div
                  className="bg-gray-100 text-center text-gray-500"
                  style={{ width: `${siblingBlockStart}%` }}
                >
                  Primary
                </div>
                <div
                  className="bg-indigo-100 text-center text-indigo-700"
                  style={{ width: `${100 - siblingBlockStart}%` }}
                >
                  Absolute
                </div>
              </div>
            </div>
          </Row>
          <Row label="Flag Symbol" hint="Show H/L symbol before or after value">
            <select
              value={printOptions.flagSymbol ?? 'none'}
              onChange={(e) => setPO({ flagSymbol: e.target.value as 'none' | 'before' | 'after', showFlagLegend: e.target.value === 'none' ? false : printOptions.showFlagLegend })}
              className="text-sm border border-gray-300 rounded px-2 py-1 bg-white"
            >
              <option value="none">None</option>
              <option value="before">Before value</option>
              <option value="after">After value (inline)</option>
            </select>
          </Row>
          <Row label="Flag Legend" hint="H=High, L=Low legend below table">
            <Toggle
              checked={!!printOptions.showFlagLegend}
              disabled={(printOptions.flagSymbol ?? 'none') === 'none' && !printOptions.flagAsterisk}
              onChange={(v) => setPO({ showFlagLegend: v })}
            />
          </Row>
          <Row label="Flag Asterisk (*)" hint="Append * to H/L values">
            <Toggle
              checked={!!printOptions.flagAsterisk}
              onChange={(v) => setPO({ flagAsterisk: v, flagAsteriskCritical: v ? printOptions.flagAsteriskCritical : false })}
            />
          </Row>
          <Row label="Critical Double (**)" hint="** for critical values">
            <Toggle
              checked={!!printOptions.flagAsteriskCritical}
              disabled={!printOptions.flagAsterisk}
              onChange={(v) => setPO({ flagAsteriskCritical: v })}
            />
          </Row>
        </div>

        {/* Preview — exact HTML from edge fn */}
        <div className="flex-1 p-4 bg-gray-50 overflow-auto" style={{ maxHeight: 600 }}>
          <div dangerouslySetInnerHTML={{ __html: html }} />
        </div>
      </div>
    </div>
  );
}
