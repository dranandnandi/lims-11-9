// Supabase Edge Function: Full Server-Side PDF Generation with PDF.co
// Complete pipeline: Context â†’ Templates â†’ HTML â†’ PDF.co â†’ Storage

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";
import {
  fetchFrontBackPages,
  fetchLetterheadBackground,
  fetchLetterheadBackgroundForOrder,
  fetchHeaderFooterImages,
  imageUrlToBase64,
  optimizeHeaderFooterImageUrl,
  buildHeaderHtml,
  buildFooterHtml,
} from "./headerFooterHelper.ts";
import { formatAnalyteDisplayValue } from "./resultValueFormat.ts";

function formatIndianNumber(val: string | number): string {
  const str = String(val).replace(/,/g, "").trim();
  const num = parseFloat(str);
  if (!Number.isFinite(num) || Math.abs(num) < 1000) return str || String(val);
  return new Intl.NumberFormat("en-IN").format(num);
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// â”€â”€â”€ Inline Code 128-B barcode generator (no external API) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Eliminates dependency on barcodeapi.org which may return "FAILED" images
// when called from PDF rendering servers.
// renderWidth: rendered pixel width (SVG scales via viewBox to fit exactly)
function generateCode128SVG(data: string, height = 36, renderWidth = 100): string {
  if (!data) return "";
  // Code 128 symbol bar patterns (0-106)
  const PATTERNS = [
    "11011001100","11001101100","11001100110","10010011000","10010001100",
    "10001001100","10011001000","10011000100","10001100100","11001001000",
    "11001000100","11000100100","10110011100","10011011100","10011001110",
    "10111001100","10011101100","10011100110","11001110010","11001011100",
    "11001001110","11011100100","11001110100","11101101110","11101001100",
    "11100101100","11100100110","11101100100","11100110100","11100110010",
    "11011011000","11011000110","11000110110","10100011000","10001011000",
    "10001000110","10110001000","10001101000","10001100010","11010001000",
    "11000101000","11000100010","10110111000","10110001110","10001101110",
    "10111011000","10111000110","10001110110","11101110110","11010001110",
    "11000101110","11011101000","11011100010","11011101110","11101011000",
    "11101000110","11100010110","11101101000","11101100010","11100011010",
    "11101111010","11001000010","11110001010","10100110000","10100001100",
    "10010110000","10010000110","10000101100","10000100110","10110010000",
    "10110000100","10011010000","10011000010","10000110100","10000110010",
    "11000010010","11001010000","11110111010","11000010100","10001111010",
    "10100111100","10010111100","10010011110","10111100100","10011110100",
    "10011110010","11110100100","11110010100","11110010010","11011011110",
    "11011110110","11110110110","10101111000","10100011110","10001011110",
    "10111101000","10111100010","11110101000","11110100010","10111011110",
    "10111101110","11101011110","11110101110","11010000100","11010010000",
    "11010011100","11000111010",
  ];
  const START_B = 104;
  const STOP    = 106;

  const values: number[] = [START_B];
  let checksum = START_B;
  for (let i = 0; i < data.length; i++) {
    const c = data.charCodeAt(i);
    if (c < 32 || c > 126) continue; // Code 128-B range
    const v = c - 32;
    values.push(v);
    checksum += (i + 1) * v;
  }
  values.push(checksum % 103);
  values.push(STOP);

  // Build binary pattern string (each module = 1 unit in viewBox coords)
  let bits = "";
  for (const v of values) bits += PATTERNS[v];
  bits += "11"; // termination bar (2 modules)

  const totalModules = bits.length;
  let rects = "";
  for (let i = 0; i < bits.length; i++) {
    if (bits[i] === "1") {
      rects += `<rect x="${i}" y="0" width="1" height="${height}"/>`;
    }
  }
  // viewBox scales all modules to fit renderWidth exactly â€” no overflow.
  // preserveAspectRatio="none" lets the template CSS resize the barcode to the
  // configured header size without letterboxing it inside a taller/wider box;
  // bars stay proportional to each other, so the symbol still scans.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalModules} ${height}" width="${renderWidth}" height="${height}" preserveAspectRatio="none" style="display:block;"><g fill="#000000">${rects}</g></svg>`;
}
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Custom domain for reports storage (configured via Deno environment variable)
const CUSTOM_REPORTS_DOMAIN = Deno.env.get("CUSTOM_STORAGE_DOMAIN") || "";

/**
 * Get public URL for storage file with custom domain support
 */
function getPublicStorageUrl(bucket: string, path: string): string {
  if (bucket === "reports" && CUSTOM_REPORTS_DOMAIN) {
    const cleanPath = path.startsWith("/") ? path.slice(1) : path;
    return `${CUSTOM_REPORTS_DOMAIN}/${cleanPath}`;
  }

  // Fallback to Supabase default URL
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  return `${supabaseUrl}/storage/v1/object/public/${bucket}/${path}`;
}

// ============================================================
// SECTION: Configuration & Constants
// ============================================================

const PDFCO_API_URL = "https://api.pdf.co/v1/pdf/convert/from/html";
const PDFCO_JOB_STATUS_URL = "https://api.pdf.co/v1/job/check";

// Default PDF settings (fallback if not in lab settings)
const DEFAULT_PDF_SETTINGS = {
  margins: "180px 20px 150px 20px", // top right bottom left
  headerHeight: "90px",
  footerHeight: "80px",
  scale: 1.0,
  paperSize: "A4",
  displayHeaderFooter: true,
  mediaType: "screen",
  printBackground: true,
};

// Parse margin value - handles both "180px" strings and numeric 180 values
function parseMarginValue(val: unknown, defaultVal = 20): number {
  if (typeof val === "number" && !isNaN(val)) return val;
  if (typeof val === "string") {
    const parsed = parseInt(val, 10);
    return isNaN(parsed) ? defaultVal : parsed;
  }
  return defaultVal;
}

// Comprehensive baseline CSS for report styling (server-side)
const BASELINE_CSS = `
/* LIMS Report Baseline CSS - Server-Side */
/* FIX: Removed duplicate @import â€” fonts loaded via <link> tags in buildPdfBodyDocumentV2 */

:root {
  --report-font-family: "Inter", "Noto Sans", "Noto Sans Gujarati", "Noto Sans Devanagari", "Noto Sans Tamil", "Noto Sans Telugu", "Noto Sans Kannada", "Noto Sans Bengali", "Noto Sans Gurmukhi", "Noto Sans Malayalam", "Noto Sans Oriya", Arial, sans-serif;
  --report-text-color: #000000;
  --report-muted-color: #333333;
  --report-heading-color: #000000;
  --report-border-color: #999999;
  --report-accent-color: #2563eb;
  --report-background-color: #ffffff;
}

.limsv2-report {
  position: relative;
  font-family: var(--report-font-family);
  color: var(--report-text-color);
  background-color: var(--report-background-color);
  font-size: 14px;
  line-height: 1.6;
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

.limsv2-report * {
  box-sizing: border-box;
}

.limsv2-report-body {
  padding: 15px 20px;
  position: relative;
  z-index: 2;
}

.limsv2-report-body--pdf {
  padding: 0 20px;
}

/* Typography */
.limsv2-report h1, .limsv2-report h2, .limsv2-report h3,
.limsv2-report h4, .limsv2-report h5, .limsv2-report h6 {
  font-family: var(--report-font-family);
  color: var(--report-heading-color);
  margin: 0 0 0.25rem;
  line-height: 1.3;
}

.limsv2-report h1 { font-size: 2rem; }
.limsv2-report h2 { font-size: 1.5rem; }
.limsv2-report h3 { font-size: 1.25rem; }
.limsv2-report h4 { font-size: 1.1rem; }

/* Normalize headings inside interpretation blocks â€” CKEditor often saves <p> content as <h4> */
.limsv2-report .group-interpretation h1,
.limsv2-report .group-interpretation h2,
.limsv2-report .group-interpretation h3,
.limsv2-report .group-interpretation h4,
.limsv2-report .group-interpretation h5,
.limsv2-report .group-interpretation h6 {
  font-size: 13px;
  font-weight: normal;
  margin: 0 0 3px 0;
  line-height: 1.45;
  color: #111;
}

.limsv2-report p {
  margin: 0 0 0.5rem;
  color: var(--report-text-color);
}

.limsv2-report p:last-child {
  margin-bottom: 0;
}

/* Images */
.limsv2-report img {
  max-width: 100%;
  height: auto;
  display: block;
}


.limsv2-report hr {
  border: 0;
  border-top: 1px solid var(--report-border-color);
  margin: 1.5rem 0;
}

/* Watermark */
.report-watermark {
  position: absolute !important;
  top: 50% !important;
  left: 50% !important;
  transform: translate(-50%, -50%) !important;
  z-index: 1 !important;
  opacity: 0.15 !important;
  pointer-events: none !important;
  max-width: 80% !important;
}

/* Draft watermark */
.draft-watermark {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%) rotate(-45deg);
  font-size: 100px;
  color: rgba(200, 200, 200, 0.3);
  pointer-events: none;
  z-index: 1000;
}

/* =========================================
   CRITICAL PDF RENDERING FIXES 
   ========================================= */

/* Ensure containers don't clip content */
.limsv2-report .report-container,
.limsv2-report .report-body,
.report-container, 
.report-body,
.report-region,
.report-region--body {
  height: auto !important;
  min-height: auto !important;
  overflow: visible !important;
  display: block !important;
  max-width: none !important; /* Allow full width for PDF */
  border: none !important; /* Remove border to avoid box visuals in print */
  box-shadow: none !important; /* Remove shadow */
  margin: 0 !important;
  padding: 0 !important;
}

/* Ensure sections outside container are visible */
.limsv2-report section,
.limsv2-report > div {
  overflow: visible !important;
}

/* Handle page breaks better */
.section-header {
  page-break-after: avoid;
}

.patient-info {
  page-break-inside: auto;
  break-inside: auto;
}

/* Ensure tables are visible */
figure.table {
  display: block;
  overflow: visible !important;
  margin: 1em 0;
}

/* Style CKEditor figure.table tables inside interpretation blocks */
figure.table table,
.group-interpretation figure.table table,
.limsv2-interpretation-block figure.table table {
  border-collapse: collapse;
  width: 100%;
  font-size: inherit;
}
figure.table table th,
figure.table table td,
.group-interpretation figure.table table th,
.group-interpretation figure.table table td {
  border: 1px solid #ccc;
  padding: 5px 8px;
  text-align: left;
  vertical-align: top;
}
figure.table table thead th,
.group-interpretation figure.table table thead th {
  background-color: #f0f0f0;
  font-weight: bold;
}

/* =========================================
   TABLE PAGE BREAK HANDLING (PDF.co)
   Allow tables to break across pages naturally,
   but prevent breaking within individual rows
   ========================================= */
@media print {
  /* Allow tables to break across pages */
  table, .report-table, .limsv2-report table {
    page-break-inside: auto !important;
    break-inside: auto !important;
  }
  
  /* Prevent breaking within rows - keeps each row intact */
  tr, .limsv2-report tr {
    page-break-inside: avoid !important;
    break-inside: avoid !important;
  }
  
  /* Keep table headers with at least one row */
  thead {
    display: table-header-group;
  }
  
  /* Keep footer at bottom of table */
  tfoot {
    display: table-footer-group;
  }
  
  /* Ensure table body allows natural flow */
  tbody {
    page-break-inside: auto !important;
    break-inside: auto !important;
  }
  
  /* Keep section headers attached to following content */
  .test-group-header, .section-header, h3, h4 {
    page-break-after: avoid !important;
    break-after: avoid !important;
  }

  /* Allow interpretation blocks to flow across pages freely */
  .limsv2-report .group-interpretation {
    break-inside: auto !important;
    page-break-inside: auto !important;
    break-before: auto !important;
    page-break-before: auto !important;
  }

  /* Override h4 page-break rule inside interpretation â€” these are prose, not section headers */
  .limsv2-report .group-interpretation h1,
  .limsv2-report .group-interpretation h2,
  .limsv2-report .group-interpretation h3,
  .limsv2-report .group-interpretation h4,
  .limsv2-report .group-interpretation h5,
  .limsv2-report .group-interpretation h6 {
    page-break-after: auto !important;
    break-after: auto !important;
  }
}

/* Report extras */
.report-extras-section {
  margin-top: 30px;
  padding: 15px;
}

.clinical-summary-section {
  padding: 15px;
  background: #f8fafc;
  border: 1px solid var(--report-border-color);
  border-radius: 8px;
  margin-top: 15px;
}

.clinical-summary-title {
  font-size: 1rem;
  color: var(--report-heading-color);
  border-bottom: 1px solid var(--report-border-color);
  padding-bottom: 8px;
  margin-bottom: 12px;
}

/* Page break helpers */
.avoid-break {
  break-inside: auto;
  page-break-inside: auto;
}

.page-break-before {
  break-before: page;
  page-break-before: always;
}

/* Section content (doctor-filled sections) - with fallback values */
.section-content {
  font-family: var(--report-font-family, "Inter", Arial, sans-serif);
  color: var(--report-text-color, #1f2937);
  font-size: 13px;
  line-height: 1.7;
  margin: 0.5rem 0;
  white-space: pre-wrap;
  word-wrap: break-word;
  position: relative;
  z-index: 2;
}

.section-content p {
  margin: 0.4rem 0;
  color: var(--report-text-color, #1f2937);
  line-height: 1.7;
  font-size: 13px;
}

.section-content p:first-child {
  margin-top: 0;
}

.section-content p:last-child {
  margin-bottom: 0;
}

.section-content strong,
.section-content b {
  font-weight: 600;
  color: var(--report-heading-color, #111827);
}

.section-content em,
.section-content i {
  font-style: italic;
}

/* Section content lists */
.section-content ul,
.section-content ol {
  margin: 0.5rem 0;
  padding-left: 1.5rem;
  color: var(--report-text-color, #1f2937);
}

.section-content li {
  margin-bottom: 0.3rem;
  line-height: 1.6;
  font-size: 13px;
}

.section-content li:last-child {
  margin-bottom: 0;
}

/* Section headers within content */
.section-content h1,
.section-content h2,
.section-content h3,
.section-content h4,
.section-content h5,
.section-content h6 {
  font-family: var(--report-font-family, "Inter", Arial, sans-serif);
  color: var(--report-heading-color, #111827);
  font-weight: 600;
  margin: 0.75rem 0 0.5rem;
  line-height: 1.4;
}

.section-content h4 { font-size: 14px; }
.section-content h5 { font-size: 13px; }
.section-content h6 { font-size: 12px; }
		    `;

const CKE_IMAGE_ALIGNMENT_CSS = `
/* Preserve CKEditor image alignment in Chromium/PDF.co.
   The report baseline makes images display:block, so parent text-align alone
   does not move signature images unless margins are set explicitly. */
.limsv2-report .image-style-align-right,
.limsv2-report figure.image-style-align-right {
  margin-left: auto !important;
  margin-right: 0 !important;
  text-align: right !important;
}

.limsv2-report .image-style-align-center,
.limsv2-report figure.image-style-align-center {
  margin-left: auto !important;
  margin-right: auto !important;
  text-align: center !important;
}

.limsv2-report .image-style-align-left,
.limsv2-report figure.image-style-align-left {
  margin-left: 0 !important;
  margin-right: auto !important;
  text-align: left !important;
}

.limsv2-report .image-style-align-right img,
.limsv2-report figure.image-style-align-right img,
.limsv2-report p[style*="text-align:right"] img,
.limsv2-report p[style*="text-align: right"] img,
.limsv2-report div[style*="text-align:right"] img,
.limsv2-report div[style*="text-align: right"] img,
.limsv2-report li[style*="text-align:right"] img,
.limsv2-report li[style*="text-align: right"] img,
.limsv2-report td[style*="text-align:right"] img,
.limsv2-report td[style*="text-align: right"] img {
  display: block !important;
  margin-left: auto !important;
  margin-right: 0 !important;
}

.limsv2-report .image-style-align-center img,
.limsv2-report figure.image-style-align-center img,
.limsv2-report p[style*="text-align:center"] img,
.limsv2-report p[style*="text-align: center"] img,
.limsv2-report div[style*="text-align:center"] img,
.limsv2-report div[style*="text-align: center"] img,
.limsv2-report li[style*="text-align:center"] img,
.limsv2-report li[style*="text-align: center"] img,
.limsv2-report td[style*="text-align:center"] img,
.limsv2-report td[style*="text-align: center"] img {
  display: block !important;
  margin-left: auto !important;
  margin-right: auto !important;
}

.limsv2-report .image-style-align-left img,
.limsv2-report figure.image-style-align-left img,
.limsv2-report p[style*="text-align:left"] img,
.limsv2-report p[style*="text-align: left"] img,
.limsv2-report div[style*="text-align:left"] img,
.limsv2-report div[style*="text-align: left"] img,
.limsv2-report li[style*="text-align:left"] img,
.limsv2-report li[style*="text-align: left"] img,
.limsv2-report td[style*="text-align:left"] img,
.limsv2-report td[style*="text-align: left"] img {
  display: block !important;
  margin-left: 0 !important;
  margin-right: auto !important;
}
`;

// CSS injected only for CKEditor custom templates (not basic/beautiful default templates).
// These rules are intentionally excluded from BASELINE_CSS to avoid cascade conflicts
// with generated structured templates that own their own table/flag/signature styling.
const CKEDITOR_CSS = `
/* Tables â€” CKEditor template default table styling */
.limsv2-report table {
  width: 100%;
  border-collapse: collapse;
  margin: 0.75rem 0;
  font-size: 0.95rem;
  border: none;
  background: #fff;
}

.limsv2-report table thead th {
  background-color: #fff;
  color: var(--report-heading-color);
  border: none;
  border-top: 2px solid #000;
  border-bottom: 2px solid #000;
}

.limsv2-report table th,
.limsv2-report table td {
  border: none;
  padding: 10px 12px;
  text-align: left;
  vertical-align: top;
  background: #fff;
}

/* Abnormal flag classes used by CKEditor template placeholders */
.result-abnormal, .abnormal, .flag-abnormal,
.result-high, .flag-high, .result-critical_high, .result-critical_h,
.result-low, .flag-low, .result-critical_low, .result-critical_l {
  color: #000000 !important;
  font-weight: bold;
}

.result-normal, .normal, .flag-normal {
  color: inherit;
  font-weight: normal;
}

/* Header title contrast â€” dark-background sections */
.report-header-title,
.report-title,
.header-dark h1,
.header-dark h2,
.header-dark h3,
[style*="background-color: #"] h1,
[style*="background-color: rgb"] h1 {
  color: #ffffff !important;
}

/* Info grid for patient/order details */
.limsv2-report .info-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 0.75rem 1.25rem;
  margin-bottom: 1.5rem;
}

.limsv2-report .info-grid .label {
  display: block;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--report-muted-color);
}

.limsv2-report .info-grid .value {
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--report-heading-color);
}

/* Signature section */
.limsv2-report .signature-section,
.limsv2-report [class*="signature"],
.limsv2-report [id*="signature"] {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  text-align: right;
}

.limsv2-report .signature-section img,
.limsv2-report [class*="signature"] img,
.limsv2-report [id*="signature"] img {
  max-width: 180px;
  max-height: 70px;
  width: auto;
  height: auto;
  object-fit: contain;
  margin-left: auto;
  display: block;
}

/* Section spacing */
.limsv2-report .report-section {
  margin-bottom: 1.5rem;
}
`;

// ============================================================
// SECTION: Flag Determination System
// ============================================================

type FlagValue =
  | "normal"
  | "high"
  | "low"
  | "critical_high"
  | "critical_low"
  | "abnormal"
  | null;

interface ParsedRange {
  low: number | null;
  high: number | null;
  type: "range" | "less_than" | "greater_than" | "single" | "none";
}

// Known normal text patterns
const NORMAL_TEXT_PATTERNS = [
  /^negative$/i,
  /^non[\s-]?reactive$/i,
  /^normal$/i,
  /^nil$/i,
  /^absent$/i,
  /^not[\s-]?detected$/i,
  /^nd$/i,
  /^none[\s-]?seen$/i,
  /^within[\s-]?normal[\s-]?limits$/i,
  /^wnl$/i,
  /^unremarkable$/i,
  /^clear$/i,
  /^no[\s-]?growth$/i,
  /^sterile$/i,
];

// Known abnormal text patterns
const ABNORMAL_TEXT_PATTERNS = [
  /^positive$/i,
  /^reactive$/i,
  /^detected$/i,
  /^present$/i,
  /^abnormal$/i,
  /^growth$/i,
];

// Semi-quantitative normal values
const SEMI_QUANT_NORMAL = ["nil", "negative", "trace", "Â±", "+-", "neg"];
const SEMI_QUANT_ABNORMAL_ORDER = [
  "1+",
  "+",
  "2+",
  "++",
  "3+",
  "+++",
  "4+",
  "++++",
];

/**
 * Parse reference range string into numeric bounds
 */
function parseReferenceRange(refRange: string | null | undefined): ParsedRange {
  if (!refRange || typeof refRange !== "string") {
    return { low: null, high: null, type: "none" };
  }

  const cleaned = refRange
    .replace(/\([^)]*\)/g, "") // Remove parenthetical notes
    .replace(/[a-zA-Z%\/]+/g, " ") // Remove units
    .replace(/,/g, "") // Remove commas
    .trim();

  // Pattern: "< X" or "â‰¤ X"
  const lessThanMatch = cleaned.match(/[<â‰¤]\s*([\d.]+)/);
  if (lessThanMatch) {
    return { low: null, high: parseFloat(lessThanMatch[1]), type: "less_than" };
  }

  // Pattern: "> X" or "â‰¥ X"
  const greaterThanMatch = cleaned.match(/[>â‰¥]\s*([\d.]+)/);
  if (greaterThanMatch) {
    return {
      low: parseFloat(greaterThanMatch[1]),
      high: null,
      type: "greater_than",
    };
  }

  // Pattern: "X - Y" or "X â€“ Y" or "X to Y"
  const rangeMatch = cleaned.match(/([\d.]+)\s*[-â€“â€”~to]+\s*([\d.]+)/i);
  if (rangeMatch) {
    const low = parseFloat(rangeMatch[1]);
    const high = parseFloat(rangeMatch[2]);
    return {
      low: Math.min(low, high),
      high: Math.max(low, high),
      type: "range",
    };
  }

  // Single number
  const singleMatch = cleaned.match(/^([\d.]+)$/);
  if (singleMatch) {
    return { low: null, high: parseFloat(singleMatch[1]), type: "single" };
  }

  return { low: null, high: null, type: "none" };
}

/**
 * Extract numeric value from string
 */
function extractNumericValue(
  value: string | number | null | undefined,
): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return value;

  const cleaned = String(value).replace(/[,<>â‰¤â‰¥]/g, "").trim();
  const match = cleaned.match(/^-?([\d.]+)/);
  if (match) {
    const num = parseFloat(match[0]);
    return isNaN(num) ? null : num;
  }
  return null;
}

/**
 * Detect value type
 */
function detectValueType(
  value: string,
): "numeric" | "qualitative" | "semi_quantitative" | "descriptive" {
  const num = extractNumericValue(value);
  if (num !== null) return "numeric";

  const lower = value.toLowerCase().trim();

  if (/^[+-]+$/.test(value) || /^[1-4]\+$/.test(value) || lower === "trace") {
    return "semi_quantitative";
  }

  if (
    NORMAL_TEXT_PATTERNS.some((p) => p.test(lower)) ||
    ABNORMAL_TEXT_PATTERNS.some((p) => p.test(lower))
  ) {
    return "qualitative";
  }

  if (value.split(/\s+/).length > 3) {
    return "descriptive";
  }

  return "qualitative";
}

/**
 * Determine flag for a result value
 */
function determineFlag(
  value: string | number | null | undefined,
  referenceRange: string | null | undefined,
  lowCritical?: string | number | null,
  highCritical?: string | number | null,
  patientGender?: string,
  referenceRangeMale?: string | null,
  referenceRangeFemale?: string | null,
  expectedNormalValues?: string[],
): { flag: FlagValue; displayFlag: string } {
  if (value === null || value === undefined || value === "") {
    return { flag: null, displayFlag: "" };
  }

  const strValue = String(value).trim();
  const valueType = detectValueType(strValue);

  // Get appropriate reference range based on gender
  let effectiveRefRange = referenceRange;
  if (patientGender === "Male" && referenceRangeMale) {
    effectiveRefRange = referenceRangeMale;
  } else if (patientGender === "Female" && referenceRangeFemale) {
    effectiveRefRange = referenceRangeFemale;
  }

  let flag: FlagValue = null;

  if (valueType === "numeric") {
    const numValue = extractNumericValue(strValue);
    if (numValue !== null) {
      const lowCrit = extractNumericValue(lowCritical);
      const highCrit = extractNumericValue(highCritical);
      const { low, high, type } = parseReferenceRange(effectiveRefRange);

      // Critical checks first
      if (highCrit !== null && numValue >= highCrit) {
        flag = "critical_high";
      } else if (lowCrit !== null && numValue < lowCrit) {
        flag = "critical_low";
      } else if (type === "range" && low !== null && high !== null) {
        if (numValue < low) flag = "low";
        else if (numValue > high) flag = "high";
        else flag = "normal";
      } else if (type === "less_than" && high !== null) {
        flag = numValue > high ? "high" : "normal";
      } else if (type === "greater_than" && low !== null) {
        flag = numValue < low ? "low" : "normal";
      }
    }
  } else if (valueType === "qualitative") {
    const lower = strValue.toLowerCase();

    // Check expected normal values first
    if (expectedNormalValues && expectedNormalValues.length > 0) {
      const normalVals = expectedNormalValues.map((v) => v.toLowerCase());
      flag = normalVals.some((nv) => lower === nv || lower.includes(nv))
        ? "normal"
        : "abnormal";
    } else {
      // Pattern matching
      if (NORMAL_TEXT_PATTERNS.some((p) => p.test(lower))) {
        flag = "normal";
      } else if (ABNORMAL_TEXT_PATTERNS.some((p) => p.test(lower))) {
        flag = "abnormal";
      }
    }
  } else if (valueType === "semi_quantitative") {
    const normalized = strValue.toLowerCase();
    if (SEMI_QUANT_NORMAL.includes(normalized)) {
      flag = "normal";
    } else {
      const upperValue = strValue.toUpperCase();
      if (
        SEMI_QUANT_ABNORMAL_ORDER.some((v) =>
          v === upperValue || v === strValue
        )
      ) {
        const index = SEMI_QUANT_ABNORMAL_ORDER.findIndex((v) =>
          v === upperValue || v === strValue
        );
        flag = index >= 4 ? "high" : "abnormal";
      }
    }
  }

  // Convert to display string
  const displayMap: Record<string, string> = {
    "normal": "",
    "high": "High",
    "low": "Low",
    "critical_high": "Critical High",
    "critical_low": "Critical Low",
    "abnormal": "Abnormal",
  };

  return {
    flag,
    displayFlag: flag ? (displayMap[flag] || "") : "",
  };
}

type CanonicalReportFlag =
  | "normal"
  | "high"
  | "low"
  | "critical"
  | "critical_high"
  | "critical_low"
  | "abnormal"
  | null;

/**
 * Which flag letters this lab is allowed to PRINT.
 *
 * The flag engine always stores a verdict ('H' | 'L' | 'H*' | 'L*' | 'A') because
 * the stored flag drives the bold/coloured value styling. Printing the letter is
 * gated separately on the lab's Result Flag Options (labs.flag_options): a lab
 * that never configured "Abnormal" gets no "A" beside a Positive result, but the
 * value still prints bold.
 *
 * Keep in sync with src/utils/reportFlagDisplay.ts.
 */
function toLabFlagSymbol(raw?: string | null): string {
  const f = String(raw ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!f || f === "normal" || f === "n") return "";
  if (["h", "high", "hi", "hh"].includes(f)) return "H";
  if (["l", "low", "ll", "lo"].includes(f)) return "L";
  if (["h*", "critical_h", "critical_high", "criticalhigh", "high_critical"].includes(f)) return "H*";
  if (["l*", "critical_l", "critical_low", "criticallow", "low_critical"].includes(f)) return "L*";
  if (["a", "abn", "abnormal"].includes(f)) return "A";
  if (["c", "crit", "critical"].includes(f)) return "C";
  return "";
}

/** Configured letters, or null when the lab configured none (print everything). */
function resolveConfiguredFlagCodes(options: unknown): string[] | null {
  if (!Array.isArray(options) || options.length === 0) return null;
  const codes = new Set<string>();
  for (const opt of options) {
    const code = toLabFlagSymbol((opt as any)?.value) ||
      toLabFlagSymbol((opt as any)?.label);
    if (code) codes.add(code);
  }
  // A list naming only "Normal" says nothing about letters — treat as unconfigured
  // rather than blanking every flag on the report.
  return codes.size > 0 ? [...codes] : null;
}

const FLAG_SYMBOL_BY_CANONICAL: Record<string, string> = {
  high: "H",
  low: "L",
  critical_high: "H*",
  critical_low: "L*",
  critical: "C",
  abnormal: "A",
};
// A lab with only H/L still gets "H" on a critical high; dropping the letter
// entirely would understate the result. 'A' and 'C' have no coarser form.
const FLAG_SYMBOL_FALLBACK: Record<string, string> = { "H*": "H", "L*": "L", C: "", A: "" };
const FLAG_LEGEND_LABELS: Array<[string, string]> = [
  ["H", "High"],
  ["L", "Low"],
  ["A", "Abnormal"],
  ["H*", "Critical High"],
  ["L*", "Critical Low"],
  ["C", "Critical"],
];

function flagSymbolForReport(canonical: string, allowed: string[] | null): string {
  const symbol = FLAG_SYMBOL_BY_CANONICAL[canonical] ?? "";
  if (!symbol) return "";
  if (!allowed) return symbol;
  if (allowed.includes(symbol)) return symbol;
  const fallback = FLAG_SYMBOL_FALLBACK[symbol] ?? "";
  return fallback && allowed.includes(fallback) ? fallback : "";
}

function flagLegendText(allowed: string[] | null): string {
  return FLAG_LEGEND_LABELS
    .filter(([code]) => !allowed || allowed.includes(code))
    .map(([code, label]) => `${code} = ${label}`)
    .join(" &nbsp; ");
}

function normalizeReportFlag(flag?: string | null): {
  canonical: CanonicalReportFlag;
  label: string;
} {
  const raw = String(flag || "").trim();
  if (!raw) {
    return { canonical: null, label: "" };
  }

  const norm = raw
    .toLowerCase()
    .replace(/[-\s]/g, "_")
    .replace(/[^a-z0-9_*]/g, "");

  if (["n", "normal", "ok", "wnl", "within_range"].includes(norm)) {
    return { canonical: "normal", label: "" };
  }
  if (["h", "high", "hh", "hi"].includes(norm)) {
    return { canonical: "high", label: "High" };
  }
  if (["l", "low", "ll"].includes(norm)) {
    return { canonical: "low", label: "Low" };
  }
  if (["c", "critical", "crit", "c*"].includes(norm)) {
    return { canonical: "critical", label: "Critical" };
  }
  if (
    ["critical_high", "critical_h", "criticalh", "high_critical", "criticalhigh", "h*", "ch"].includes(norm)
  ) {
    return { canonical: "critical_high", label: "Critical High" };
  }
  if (
    ["critical_low", "critical_l", "criticall", "low_critical", "criticallow", "l*", "cl"].includes(norm)
  ) {
    return { canonical: "critical_low", label: "Critical Low" };
  }
  if (["a", "abnormal", "abn"].includes(norm)) {
    return { canonical: "abnormal", label: "Abnormal" };
  }

  if (norm.includes("critical") && norm.includes("high")) {
    return { canonical: "critical_high", label: "Critical High" };
  }
  if (norm.includes("critical") && norm.includes("low")) {
    return { canonical: "critical_low", label: "Critical Low" };
  }
  if (norm.includes("critical")) {
    return { canonical: "critical", label: "Critical" };
  }
  if (norm.includes("high")) {
    return { canonical: "high", label: "High" };
  }
  if (norm.includes("low")) {
    return { canonical: "low", label: "Low" };
  }

  return { canonical: "abnormal", label: raw };
}

// ============================================================
// SECTION: Analyte Placeholder Generation (Hardcoded Support)
// ============================================================

/**
 * Generate a short key from analyte name for placeholder purposes
 */
function generateAnalyteShortKey(name: string): string {
  if (!name) return "";

  // Common abbreviations mapping

  const abbreviations: Record<string, string> = {
    "C-Reactive Protein (CRP), Quantitative": "CREACT",
    "C-Reactive Protein (CRP)": "CREACT",
    "C-Reactive Protein": "CRP",
    "Hemoglobin": "HB",
    "Hb (Hemoglobin)": "HB",
    "Hematocrit": "HCT",
    "Total White Blood Cell Count": "WBC",
    "Total Leukocyte Count": "TLC",
    "Red Blood Cell Count": "RBC",
    "Platelet Count": "PLT",
    "Mean Corpuscular Volume": "MCV",
    "Alanine Aminotransferase (ALT/SGPT)": "ALT",
    "ALT (SGPT)": "ALT",
    // 5-Part CBC differential â€” canonical names
    "Neutrophils (%)": "NEUT_PCT",
    "Neutrophils (Abs)": "NEUT_ABS",
    "Lymphocytes (%)": "LYMPH_PCT",
    "Lymphocytes (Abs)": "LYMPH_ABS",
    "Monocytes (%)": "MONO_PCT",
    "Monocytes (Abs)": "MONO_ABS",
    "Eosinophils (%)": "EOS_PCT",
    "Eosinophils (Abs)": "EOS_ABS",
    "Basophils (%)": "BASO_PCT",
    "Basophils (Abs)": "BASO_ABS",
    "ESR (After 1 hour)": "ESR",
  };

  if (abbreviations[name]) return abbreviations[name];

  // Check for abbreviations in parentheses
  const parenthesesMatch = name.match(/\(([A-Z]{2,})\)/);
  if (parenthesesMatch) return parenthesesMatch[1];

  // Generate from initials
  const cleaned = name.replace(/[^a-zA-Z0-9\s-]/g, "");
  const words = cleaned.split(/\s+/).filter((w) => w.length > 0);

  if (words.length === 0) return "";
  if (words.length === 1) {
    return words[0].substring(0, Math.min(4, words[0].length)).toUpperCase();
  }

  const initials = words.map((w) => w[0]).join("").toUpperCase();
  if (initials.length < 3 && words[0].length > 1) {
    return (words[0].substring(0, 3) + initials.substring(1)).toUpperCase();
  }

  return initials;
}

/**
 * Convert flag value to CSS classes for template styling
 * Returns valueClass, flagClass, and normalized flagText
 */
function toFlagClass(flag?: string | null) {
  const normalized = normalizeReportFlag(flag);
  const canonical = normalized.canonical;

  if (!canonical || canonical === "normal") {
    return {
      valueClass: "value-normal",
      flagClass: "flag-normal",
      flagText: "",
    };
  }

  if (canonical === "low") {
    return { valueClass: "value-low", flagClass: "flag-low", flagText: "Low" };
  }
  if (canonical === "high") {
    return {
      valueClass: "value-high",
      flagClass: "flag-high",
      flagText: "High",
    };
  }

  if (canonical === "critical_high") {
    return {
      valueClass: "value-critical_h",
      flagClass: "flag-critical_h",
      flagText: "Critical High",
    };
  }
  if (canonical === "critical_low") {
    return {
      valueClass: "value-critical_l",
      flagClass: "flag-critical_l",
      flagText: "Critical Low",
    };
  }
  if (canonical === "critical") {
    return {
      valueClass: "value-abnormal",
      flagClass: "flag-abnormal",
      flagText: "Critical",
    };
  }
  if (canonical === "abnormal") {
    return {
      valueClass: "value-abnormal",
      flagClass: "flag-abnormal",
      flagText: normalized.label || "Abnormal",
    };
  }

  // abnormal / anything else
  return {
    valueClass: "value-abnormal",
    flagClass: "flag-abnormal",
    flagText: normalized.label,
  };
}

/**
 * Generate analyte-specific placeholders for templates
 * Creates both short keys (ANALYTE_HB_VALUE) and full slugs (Hemoglobin_VALUE)
 * Now includes CSS classes for styling: _VALUE_CLASS, _FLAG_CLASS, _FLAG_TEXT
 */
function generateAnalytePlaceholders(analytes: any[]): Record<string, any> {
  const placeholders: Record<string, any> = {};

  if (!analytes || analytes.length === 0) return placeholders;

  analytes.forEach((analyte) => {
    const name = analyte.parameter || analyte.name || analyte.test_name || "";
    if (!name) return;

    // Get CSS classes from flag
    const { valueClass, flagClass, flagText } = toFlagClass(analyte.flag);
    const normalizedFlag = normalizeReportFlag(analyte.flag);
    const normalizedFlagLabel = normalizedFlag.label;

    // 1. Existing Short Key Logic (ANALYTE_HB_VALUE)
    const shortKey = generateAnalyteShortKey(name);
    if (shortKey) {
      placeholders[`ANALYTE_${shortKey}_VALUE`] = formatIndianNumber(analyte.value || "");
      placeholders[`ANALYTE_${shortKey}_UNIT`] = analyte.unit || "";
      placeholders[`ANALYTE_${shortKey}_REFERENCE`] = analyte.reference_range ||
        "";
      placeholders[`ANALYTE_${shortKey}_FLAG`] = normalizedFlagLabel;
      placeholders[`ANALYTE_${shortKey}_FLAG_RAW`] = analyte.flag || "";
      placeholders[`ANALYTE_${shortKey}_METHOD`] = analyte.method || "";
      placeholders[`ANALYTE_${shortKey}_DISPLAYFLAG`] = analyte.displayFlag ||
        normalizedFlagLabel;
      // NEW: CSS class placeholders
      placeholders[`ANALYTE_${shortKey}_FLAG_TEXT`] = flagText;
      placeholders[`ANALYTE_${shortKey}_FLAG_CLASS`] = flagClass;
      placeholders[`ANALYTE_${shortKey}_VALUE_CLASS`] = valueClass;
    }

    // 2. New Full Slug Logic (Hemoglobin_VALUE) - Matches Frontend Picker
    // Slugify: "Hemoglobin (Hb)" -> "HemoglobinHb"
    const slug = name.replace(/[^a-zA-Z0-9]+/g, " ").trim().replace(/\s+/g, "");
    if (slug) {
      // Direct values
      placeholders[`${slug}`] = formatIndianNumber(analyte.value || ""); // {{Hemoglobin}}

      // Suffix variations
      placeholders[`${slug}_VALUE`] = formatIndianNumber(analyte.value || "");
      placeholders[`${slug}_UNIT`] = analyte.unit || "";
      placeholders[`${slug}_REF_RANGE`] = analyte.reference_range || ""; // Matching _REF_RANGE from frontend
      placeholders[`${slug}_REFERENCE`] = analyte.reference_range || ""; // Alias
      placeholders[`${slug}_FLAG`] = normalizedFlagLabel;
      placeholders[`${slug}_FLAG_RAW`] = analyte.flag || "";
      placeholders[`${slug}_DISPLAYFLAG`] = analyte.displayFlag || normalizedFlagLabel;
      placeholders[`${slug}_NOTE`] = analyte.notes || analyte.comments || "";
      placeholders[`${slug}_METHOD`] = analyte.method || "";
      // NEW: CSS class placeholders
      placeholders[`${slug}_FLAG_TEXT`] = flagText;
      placeholders[`${slug}_FLAG_CLASS`] = flagClass;
      placeholders[`${slug}_VALUE_CLASS`] = valueClass;
    }

    // 3. UPPER_SNAKE_CASE format for templates like {{ANALYTE_WHITE_BLOOD_CELL_COUNT_VALUE}}
    // Convert "White Blood Cell Count" -> "WHITE_BLOOD_CELL_COUNT"
    const upperSnakeKey = name
      .replace(/[^a-zA-Z0-9\s]/g, "") // Remove special chars except spaces
      .trim()
      .toUpperCase()
      .replace(/\s+/g, "_"); // Replace spaces with underscores

    if (upperSnakeKey && upperSnakeKey !== shortKey) {
      placeholders[`ANALYTE_${upperSnakeKey}_VALUE`] = formatIndianNumber(analyte.value || "");
      placeholders[`ANALYTE_${upperSnakeKey}_UNIT`] = analyte.unit || "";
      placeholders[`ANALYTE_${upperSnakeKey}_REFERENCE`] =
        analyte.reference_range || "";
      placeholders[`ANALYTE_${upperSnakeKey}_FLAG`] = normalizedFlagLabel;
      placeholders[`ANALYTE_${upperSnakeKey}_FLAG_RAW`] = analyte.flag || "";
      placeholders[`ANALYTE_${upperSnakeKey}_DISPLAYFLAG`] =
        analyte.displayFlag || normalizedFlagLabel;
      placeholders[`ANALYTE_${upperSnakeKey}_METHOD`] = analyte.method || "";
      placeholders[`ANALYTE_${upperSnakeKey}_FLAG_TEXT`] = flagText;
      placeholders[`ANALYTE_${upperSnakeKey}_FLAG_CLASS`] = flagClass;
      placeholders[`ANALYTE_${upperSnakeKey}_VALUE_CLASS`] = valueClass;
    }
  });

  // Debug: Show all placeholder keys with _VALUE suffix
  const valueKeys = Object.keys(placeholders).filter((k) =>
    k.endsWith("_VALUE")
  );
  console.log("ðŸ“‹ Generated analyte placeholders:");
  console.log("   Total keys:", Object.keys(placeholders).length);
  console.log(
    "   VALUE keys:",
    valueKeys.slice(0, 20).join(", "),
    valueKeys.length > 20 ? `... (${valueKeys.length} total)` : "",
  );

  return placeholders;
}

// ============================================================
// SECTION: Template Rendering (Simple Nunjucks-like)
// ============================================================

/**
 * Simple template rendering with {{ variable }} placeholders
 * Handles nested objects like {{ patient.name }} and arrays
 */
function renderTemplate(html: string, context: Record<string, any>): string {
  if (!html) return "";

  let result = html;

  // Replace {{ variable }} patterns
  result = result.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_, key) => {
    const trimmedKey = key.trim();
    const value = getNestedValue(context, trimmedKey);

    if (value === undefined || value === null) {
      return ""; // Empty string for missing values
    }

    if (typeof value === "object") {
      return JSON.stringify(value);
    }

    return String(value);
  });

  // Clean up qr_code visual placeholder wrapper inserted by TemplateStudio.
  // Replaces <div data-lims-placeholder="qr_code" ...><img .../></div>
  // with a clean <div class="qr-verify"><img/><p>Scan to verify</p></div>
  result = result.replace(
    /<div[^>]*data-lims-placeholder="qr_code"[^>]*>([\s\S]*?)<\/div>/gi,
    (_match, inner) => {
      const imgMatch = inner.match(/<img[^>]*>/i);
      if (imgMatch) {
        return `<div class="qr-verify" style="text-align:left;">${imgMatch[0]}<p style="margin:2px 0 0 0;font-size:9px;color:#6b7280;">Scan to verify</p></div>`;
      }
      return inner; // fallback: just return inner content
    }
  );

  return stripBrokenPdfImages(result);
}

/**
 * "Ref. Doctor" cell content: the doctor name with the degree/qualification from
 * Doctor Master on a second line beneath it.
 *
 * The cell text is `: {{value}}`, so a bare block-level degree line would start at
 * the cell's left edge — under the colon rather than under the name. Wrapping both
 * in an inline-block makes the wrapper's content box begin exactly where the name
 * begins, so the degree lines up under it. When there is no qualification this
 * returns the plain name, leaving single-line cells byte-identical to before.
 */
function buildRefDoctorBlock(name: unknown, qualification: unknown): string {
  const escapeCell = (v: unknown) =>
    String(v ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");

  const doctorName = escapeCell(name).trim();
  const degree = escapeCell(qualification).trim();
  if (!degree) return doctorName;

  // Inline styles keep this readable in templates that do not ship the
  // .basic-report-template CSS; that template's !important rules refine it.
  return `<span class="ref-doctor-block" style="display:inline-block;vertical-align:top;">${doctorName}` +
    `<div class="ref-doctor-degree" style="font-size:0.92em;font-weight:normal;color:#444;line-height:1.25;margin-top:1px;">${degree}</div>` +
    `</span>`;
}

function buildGroupRemarkHtml(remark: unknown): string {
  const value = String(remark || "").trim();
  if (!value) return "";

  const escaped = value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\r\n?|\n/g, "<br>");

  return `
    <div class="lims-group-remark" style="margin-top:10px;padding:7px 10px;border-top:1px solid #d1d5db;font-size:11px;line-height:1.45;page-break-inside:avoid;">
      <strong>Remarks:</strong> ${escaped}
    </div>
  `;
}

function injectGroupRemark(
  html: string,
  remark: unknown,
  templateContainsPlaceholder = false,
): string {
  const remarkHtml = buildGroupRemarkHtml(remark);
  if (!html || !remarkHtml || templateContainsPlaceholder || html.includes('class="lims-group-remark"')) {
    return html;
  }

  const signatureMarkers = [
    /<div[^>]*class="[^"]*\breport-footer\b[^"]*"[^>]*>/i,
    /<div[^>]*class="[^"]*\bsignatures\b[^"]*"[^>]*>/i,
  ];
  for (const marker of signatureMarkers) {
    const match = marker.exec(html);
    if (match?.index !== undefined) {
      return `${html.slice(0, match.index)}${remarkHtml}${html.slice(match.index)}`;
    }
  }

  const bodyClose = html.search(/<\/body>/i);
  return bodyClose >= 0
    ? `${html.slice(0, bodyClose)}${remarkHtml}${html.slice(bodyClose)}`
    : `${html}${remarkHtml}`;
}

function formatSignatureNameForPdf(value: unknown): string {
  if (value === undefined || value === null) return "";

  const normalized = String(value)
    .replace(/\r\n?/g, "\n")
    .replace(/\s*\/\s*/g, "\n")
    .trim();

  return normalized
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("<br/>");
}

/**
 * Return the list of signatories to render in the report footer.
 * The multi-signature footer config (pdf_layout_settings.reportSignatures) is
 * resolved upstream into signatoryInfo._signatories. When present and non-empty
 * we render those; otherwise we fall back to the single resolved signatoryInfo
 * so existing single-signature reports are unchanged.
 */
function getReportSignatories(signatoryInfo: any): any[] {
  const list = Array.isArray(signatoryInfo?._signatories)
    ? signatoryInfo._signatories.filter(
      (s: any) => s && (s.signatoryImageUrl || s.signatoryName),
    )
    : [];
  if (list.length > 0) return list;
  return signatoryInfo ? [signatoryInfo] : [];
}

function resolveSignatureImageSize(printOptions?: Record<string, unknown> | null) {
  const clamp = (value: unknown, fallback: number, min: number, max: number) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.max(min, Math.min(max, numeric)) : fallback;
  };

  return {
    maxHeight: clamp(printOptions?.signatureMaxHeight, 70, 30, 120),
    maxWidth: clamp(printOptions?.signatureMaxWidth, 180, 80, 260),
  };
}

/**
 * Inject signature image into rendered HTML - ROBUST VERSION
 * Always injects into .signatures or .report-footer if present, never truncates content
 */
function injectSignatureImage(
  html: string,
  signatoryImageUrl: string,
  signatoryName: string = "",
  signatoryDesignation: string = "",
): string {
  if (!html || !signatoryImageUrl) {
    console.log("  âš ï¸ Missing required params for signature injection");
    return html;
  }

  // Already present?
  if (html.includes(`src="${signatoryImageUrl}"`)) {
    console.log("  âœ… Signature image already present");
    return html;
  }

  // Build complete signature block with image and text
  const signatureBlockHtml = `
    <div style="margin-top: 10px;">
      <img src="${signatoryImageUrl}" alt="" style="display:block;max-height:70px;max-width:180px;width:auto;height:auto;object-fit:contain;margin-top:5px;margin-bottom:0px;" onerror="this.style.display='none'" />
      ${
    signatoryName
      ? `<p style="margin-top:8px;margin-bottom:4px;font-weight:600;font-size:14px;">${signatoryName}</p>`
      : ""
  }
      ${
    signatoryDesignation
      ? `<p style="margin-top:0;color:#64748b;font-size:12px;">${signatoryDesignation}</p>`
      : ""
  }
    </div>
  `.trim();

  console.log(
    `  ðŸ” Looking for .signatures or .report-footer block (name: ${signatoryName})`,
  );

  // 1. PRIORITY: Inject into .signatures block (most common)
  const signaturesPattern = /(<div[^>]*class="[^"]*signatures[^"]*"[^>]*>)/i;
  if (signaturesPattern.test(html)) {
    console.log("  âœ… Found .signatures block - injecting signature");
    return html.replace(signaturesPattern, `$1${signatureBlockHtml}`);
  }

  // 2. Inject into .report-footer block
  const footerPattern = /(<div[^>]*class="[^"]*report-footer[^"]*"[^>]*>)/i;
  if (footerPattern.test(html)) {
    console.log("  âœ… Found .report-footer block - injecting signature");
    return html.replace(footerPattern, `$1${signatureBlockHtml}`);
  }

  // 3. Look for any signatory/approver related classes
  const signatoryPattern =
    /(<div[^>]*class="[^"]*(?:signatory|signature-block|approver|signer)[^"]*"[^>]*>)/i;
  if (signatoryPattern.test(html)) {
    console.log("  âœ… Found signatory-related block - injecting signature");
    return html.replace(signatoryPattern, `$1${signatureBlockHtml}`);
  }

  // 4. Fallback: inject before closing </section> with report-region--body class
  const sectionPattern = /(<\/section>)/i;
  if (sectionPattern.test(html)) {
    console.log("  âš ï¸ Fallback: injecting before </section>");
    return html.replace(
      sectionPattern,
      `<div style="margin-top:20px;">${signatureBlockHtml}</div>$1`,
    );
  }

  // 5. Last resort: inject before closing </body>
  if (html.includes("</body>")) {
    console.log("  âš ï¸ Last resort: injecting before </body>");
    return html.replace(
      "</body>",
      `<div style="margin:20px;">${signatureBlockHtml}</div></body>`,
    );
  }

  // 6. Absolute last resort: Append to end of HTML string (for partials/sections)
  console.log(
    "  âš ï¸ Absolute last resort: Appending signature to end of HTML string",
  );
  return html +
    `<div style="margin-top:20px; page-break-inside: avoid;">${signatureBlockHtml}</div>`;
}

/**
 * Inject QR verification code into rendered HTML
 * Looks for .signatures, .report-footer, .qr-verify blocks or creates one
 * Places QR on left side of signature area
 */
function injectQrCode(html: string, verifyUrl: string): string {
  if (!html || !verifyUrl) {
    console.log("  âš ï¸ Missing required params for QR injection");
    return html;
  }

  // Already has QR code? Check for the actual HTML element, not just the CSS class name string
  if (html.includes('class="qr-verify"') || html.includes("class='qr-verify'") || html.includes("api.qrserver.com")) {
    console.log("  âœ… QR code already present in template");
    return html;
  }

  // Build QR block HTML
  const qrBlockHtml = `
    <div class="qr-verify" style="text-align:left;">
      <img src="https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${
    encodeURIComponent(verifyUrl)
  }" 
           alt="Verify Report" 
           style="width:60px;height:60px;" />
      <p style="margin:2px 0 0 0;font-size:9px;color:#6b7280;">Scan to verify</p>
    </div>
  `.trim();

  console.log(`  ðŸ” Looking for signature block to add QR code`);

  const topSlotPattern = /(<div[^>]*class="[^"]*qr-top-(?:left|right)-slot[^"]*"[^>]*>)/i;
  if (topSlotPattern.test(html)) {
    console.log("  âœ… Found top QR slot");
    return html.replace(topSlotPattern, `$1${qrBlockHtml}`);
  }

  // 1. PRIORITY: Look for .signatures block - wrap content in flex container
  const signaturesPattern =
    /(<div[^>]*class="[^"]*signatures[^"]*"[^>]*>)([\s\S]*?)(<\/div>\s*$|<\/div>\s*<\/|<\/div>\s*<section|<\/div>\s*<div class="(?:attachments|interpretation))/i;
  if (signaturesPattern.test(html)) {
    console.log("  âœ… Found .signatures block - adding QR with flex layout");
    return html.replace(
      signaturesPattern,
      (match, openTag, content, closeOrNext) => {
        // Modify the opening tag to add flex styles
        const flexOpenTag = openTag.replace(
          /style="([^"]*)"/,
          'style="$1;display:flex;justify-content:space-between;align-items:flex-end;"',
        )
          .replace(
            />$/,
            ' style="display:flex;justify-content:space-between;align-items:flex-end;">',
          );
        // If style was already there, the first replace worked. If not, the second adds it.
        const finalOpenTag = openTag.includes("style=")
          ? openTag.replace(
            /style="([^"]*)"/,
            'style="$1;display:flex;justify-content:space-between;align-items:flex-end;"',
          )
          : openTag.replace(
            />$/,
            ' style="display:flex;justify-content:space-between;align-items:flex-end;">',
          );

        return `${finalOpenTag}${qrBlockHtml}<div style="text-align:right;">${content}</div>${closeOrNext}`;
      },
    );
  }

  // 2. Look for .report-footer block
  const footerPattern = /(<div[^>]*class="[^"]*report-footer[^"]*"[^>]*>)/i;
  if (footerPattern.test(html)) {
    console.log("  âœ… Found .report-footer block - prepending QR");
    return html.replace(footerPattern, `$1${qrBlockHtml}`);
  }

  // 3. Look for signatory/signature-block classes
  const signatoryPattern =
    /(<div[^>]*class="[^"]*(?:signatory|signature-block|approver|signer)[^"]*"[^>]*>)/i;
  if (signatoryPattern.test(html)) {
    console.log("  âœ… Found signatory block - prepending QR");
    return html.replace(
      signatoryPattern,
      `<div style="display:flex;justify-content:space-between;align-items:flex-end;margin-top:20px;">${qrBlockHtml}$1</div>`,
    );
  }

  // 4. Fallback: inject before </section>
  const sectionPattern = /(<\/section>)/i;
  if (sectionPattern.test(html)) {
    console.log("  âš ï¸ Fallback: adding QR before </section>");
    return html.replace(
      sectionPattern,
      `<div style="margin-top:20px;text-align:left;">${qrBlockHtml}</div>$1`,
    );
  }

  // 5. Last resort: inject before </body>
  if (html.includes("</body>")) {
    console.log("  âš ï¸ Last resort: adding QR before </body>");
    return html.replace(
      "</body>",
      `<div style="margin:20px;text-align:left;">${qrBlockHtml}</div></body>`,
    );
  }

  // 6. Absolute last resort: Append to end
  console.log("  âš ï¸ Absolute last resort: Appending QR to end of HTML");
  return html +
    `<div style="margin-top:20px;text-align:left;">${qrBlockHtml}</div>`;
}

/**
 * Get nested value from object using dot notation
 * e.g., getNestedValue({patient: {name: 'John'}}, 'patient.name') => 'John'
 */
function getNestedValue(obj: Record<string, any>, path: string): any {
  const keys = path.split(".");
  let current = obj;

  for (const key of keys) {
    if (current === undefined || current === null) {
      return undefined;
    }
    current = current[key];
  }

  return current;
}

// ============================================================
// SECTION: HTML Document Builders
// ============================================================

/**
 * Generate dynamic CSS based on lab settings (colors, fonts, etc.)
 * @param settings - pdfLayoutSettings from labs table
 * @param printOptions - merged print options (lab printOptions + test-group print_options override)
 */
function generateDynamicCss(settings: any, printOptions?: any): string {
  // Underscore keys (_sampleType, _labFlagCodes, …) are internal passengers on the
  // print-options bag, not styling choices — a lab carrying only those still counts
  // as having set no print options, so no override CSS is emitted for it.
  const hasPrintOptions = !!printOptions &&
    Object.keys(printOptions).some((k) => !k.startsWith("_"));
  if (!settings || (!settings.resultColors && !settings.headerTextColor && !hasPrintOptions)) {
    return "";
  }

  let css = "/* Dynamic PDF Settings */\n";

  // Header Text Color - target all possible header classes
  if (settings.headerTextColor && settings.headerTextColor !== "inherit") {
    const color = settings.headerTextColor === "white"
      ? "#ffffff"
      : settings.headerTextColor;
    css += `
      /* Header text styling for white on dark backgrounds */
      .report-header,
      .report-header *,
      .report-header h1,
      .report-header h2,
      .report-header h3,
      .report-header p,
      .report-header .report-subtitle,
      .report-header-title,
      .report-title,
      .header-content,
      .header-content h1,
      .header-content h2,
      .header-content h3,
      .header-dark h1,
      .header-dark h2,
      .header-dark h3,
      .header-dark p,
      [class*="report-header"] h1,
      [class*="report-header"] h2,
      [class*="report-header"] p,
      [class*="report-header"] div {
        color: ${color} !important;
      }
    `;
  }

  // Result Colors
  if (settings.resultColors && settings.resultColors.enabled) {
    const { high, low, normal } = settings.resultColors;
    if (high) {
      css +=
        `.result-high, .flag-high, .result-critical_high, .result-critical-high, .result-critical_h, .result-H, .result-HH { color: ${high} !important; }\n`;
      css +=
        `.result-abnormal, .flag-abnormal, .result-A { color: ${high} !important; }\n`;
    }
    if (low) {
      css +=
        `.result-low, .flag-low, .result-critical_low, .result-critical-low, .result-critical_l, .result-L, .result-LL { color: ${low} !important; }\n`;
    }
    if (normal) {
      css +=
        `.result-normal, .flag-normal, .result-N { color: ${normal} !important; }\n`;
    }
  }

  // â”€â”€ Print Options overrides (lab-level + test-group-level) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (hasPrintOptions) {
    css += "\n/* Print Options Overrides */\n";
    const signatureSize = resolveSignatureImageSize(printOptions);
    css += `
.limsv2-report .signature-section img,
.limsv2-report [class*="signature"] img,
.limsv2-report [id*="signature"] img,
.limsv2-report .signatures img,
.limsv2-report .signature-box img {
  max-height: ${signatureSize.maxHeight}px !important;
  max-width: ${signatureSize.maxWidth}px !important;
  width: auto !important;
  height: auto !important;
  object-fit: contain !important;
}
`;

    // Remove table borders
    if (printOptions.tableBorders === false) {
      css += `
.report-table, .report-table tr, .report-table th, .report-table td,
.patient-info table, .patient-info tr, .patient-info td, .patient-info th,
.limsv2-report table, .limsv2-report tr, .limsv2-report th, .limsv2-report td {
  border: none !important;
  border-top: none !important;
  border-bottom: none !important;
  border-left: none !important;
  border-right: none !important;
}
.report-table thead tr, .report-table thead th { border: none !important; }
.report-table tbody tr, .report-table tbody tr td { border: none !important; }
`;
    }

    // Hide flag column (last column in classic layout)
    if (printOptions.flagColumn === false) {
      css += `
.report-table th:last-child,
.report-table td:last-child { display: none !important; }
`;
    }

    // Custom table header background color
    if (printOptions.headerBackground) {
      const bg = printOptions.headerBackground;
      const textColor = printOptions.headerTextColor || "#ffffff";
      css += `
.report-table thead tr th {
  background: ${bg} !important;
  background-color: ${bg} !important;
  color: ${textColor} !important;
}
`;
    }

    // Disable alternate row shading
    if (printOptions.alternateRows === false) {
      css += `
.report-table tbody tr:nth-child(even) td,
.report-table tbody tr:nth-child(even) { background: #ffffff !important; background-color: #ffffff !important; }
`;
    }

    // Base font size
    if (printOptions.baseFontSize && typeof printOptions.baseFontSize === "number") {
      const fs = Math.min(Math.max(printOptions.baseFontSize, 8), 24);
      css += `
.limsv2-report, .report-table td, .report-table th,
.patient-info td, .patient-info th { font-size: ${fs}px !important; }
`;
    }
  }

  return css;
}

/**
 * Merge lab-level printOptions (from pdf_layout_settings.printOptions) with
 * test-group-level print_options. Test-group values win over lab values.
 * Returns null if no options set at either level.
 */
function mergePrintOptions(
  labLayoutSettings: any,
  testGroupPrintOptions?: any,
): any | null {
  const labOpts = labLayoutSettings?.printOptions || null;
  const groupOpts = testGroupPrintOptions || null;
  if (!labOpts && !groupOpts && !labLayoutSettings?.resultColors) return null;
  const merged = { ...(labOpts || {}), ...(groupOpts || {}) };
  // Carry top-level resultColors into merged options so basic template can use them
  if (labLayoutSettings?.resultColors) {
    merged.resultColors = labLayoutSettings.resultColors;
  }
  return merged;
}

type PrintLayoutMode = "standard" | "compact";
type PrintPlanSource = "manual" | "deterministic" | "ai" | "fallback";

interface CompactPlanGroupDescriptor {
  groupId: string;
  groupName: string;
  analyteCount: number;
  reportPriority: number | null;
  manualOrderIndex?: number | null;
  printOrder: number;
  createdAt?: string | null;
  category?: string | null;
  department?: string | null;
  hasImages?: boolean;
  hasLongText?: boolean;
  estimatedHeight: number;
}

interface CompactPrintPlan {
  layoutMode: PrintLayoutMode;
  source: PrintPlanSource;
  orderedGroupIds: string[];
  clusters: Array<{ id: string; groupIds: string[]; reason?: string }>;
  notes?: string[];
}

function normalizePrintLayoutMode(value: unknown): PrintLayoutMode {
  return value === "compact" ? "compact" : "standard";
}

function getCompactPrintConfig(pdfLayoutSettings: any) {
  const compactPrint = pdfLayoutSettings?.compactPrint || {};
  const toInt = (value: unknown, fallback: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  const bannedKeywords = Array.isArray(compactPrint?.bannedKeywords)
    ? compactPrint.bannedKeywords.map((item: unknown) => String(item || "").toLowerCase()).filter(Boolean)
    : ["culture", "microbiology", "histopathology", "biopsy", "cytology", "immunohistochemistry"];

  return {
    enabled: compactPrint?.enabled !== false,
    aiEnabled: compactPrint?.aiEnabled !== false,
    policyText: typeof compactPrint?.policyText === "string"
      ? compactPrint.policyText.trim()
      : "",
    smallGroupThreshold: Math.max(1, toInt(compactPrint?.smallGroupThreshold, 6)),
    maxClusterAnalytes: Math.max(2, toInt(compactPrint?.maxClusterAnalytes, 14)),
    maxClusterGroups: Math.max(2, toInt(compactPrint?.maxClusterGroups, 2)),
    compactTemplateStyle: ["beautiful", "classic", "basic"].includes(compactPrint?.templateStyle)
      ? compactPrint.templateStyle as "beautiful" | "classic" | "basic"
      : "basic",
    bannedKeywords,
  };
}

function estimateCompactGroupHeight(analytes: any[]): number {
  const rows = analytes.length;
  const descriptiveRows = analytes.filter((item: any) => {
    const value = String(item?.value || "");
    return value.length > 24 || /\s{2,}|[A-Za-z]{10,}/.test(value);
  }).length;
  return 96 + (rows * 26) + (descriptiveRows * 10);
}

function isCompactEligible(
  descriptor: CompactPlanGroupDescriptor,
  compactConfig: ReturnType<typeof getCompactPrintConfig>,
): boolean {
  const haystack = `${descriptor.groupName} ${descriptor.category || ""} ${descriptor.department || ""}`.toLowerCase();
  if (descriptor.hasImages || descriptor.hasLongText) return false;
  if (compactConfig.bannedKeywords.some((keyword: string) => haystack.includes(keyword))) return false;
  return descriptor.analyteCount <= compactConfig.smallGroupThreshold;
}

function buildDeterministicCompactPlan(
  descriptors: CompactPlanGroupDescriptor[],
  layoutMode: PrintLayoutMode,
  compactConfig: ReturnType<typeof getCompactPrintConfig>,
): CompactPrintPlan {
  const ordered = [...descriptors].sort((a, b) => {
    const aManual = a.manualOrderIndex ?? Number.MAX_SAFE_INTEGER;
    const bManual = b.manualOrderIndex ?? Number.MAX_SAFE_INTEGER;
    if (aManual !== bManual) return aManual - bManual;
    const aPriority = (a.reportPriority != null && a.reportPriority > 0) ? a.reportPriority : Number.MAX_SAFE_INTEGER;
    const bPriority = (b.reportPriority != null && b.reportPriority > 0) ? b.reportPriority : Number.MAX_SAFE_INTEGER;
    if (aPriority !== bPriority) return aPriority - bPriority;
    if (a.printOrder !== b.printOrder) return a.printOrder - b.printOrder;
    return String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
  });

  if (layoutMode !== "compact") {
    return {
      layoutMode: "standard",
      source: "deterministic",
      orderedGroupIds: ordered.map((item) => item.groupId),
      clusters: ordered.map((item, index) => ({
        id: `cluster_${index + 1}`,
        groupIds: [item.groupId],
        reason: "Standard print layout keeps each group independent.",
      })),
      notes: ["Standard print layout requested."],
    };
  }

  const clusters: Array<{ id: string; groupIds: string[]; reason?: string }> = [];
  let i = 0;
  while (i < ordered.length) {
    const current = ordered[i];
    const currentEligible = isCompactEligible(current, compactConfig);
    const next = ordered[i + 1];
    const nextEligible = next ? isCompactEligible(next, compactConfig) : false;

    if (
      currentEligible &&
      nextEligible &&
      current.analyteCount + next.analyteCount <= compactConfig.maxClusterAnalytes
    ) {
      clusters.push({
        id: `cluster_${clusters.length + 1}`,
        groupIds: [current.groupId, next.groupId],
        reason: "Adjacent small compatible groups merged by deterministic planner.",
      });
      i += 2;
      continue;
    }

    clusters.push({
      id: `cluster_${clusters.length + 1}`,
      groupIds: [current.groupId],
      reason: currentEligible
        ? "Single small group retained because no safe adjacent pair fit."
        : "Group retained alone due to size or clinical category.",
    });
    i += 1;
  }

  return {
    layoutMode: "compact",
    source: "deterministic",
    orderedGroupIds: clusters.flatMap((cluster) => cluster.groupIds),
    clusters,
    notes: ["Deterministic compact print planner used."],
  };
}

function extractGeminiResponseText(payload: any): string {
  return payload?.candidates?.[0]?.content?.parts?.map((part: any) => part?.text || "").join("\n")
    || payload?.candidates?.[0]?.content?.parts?.[0]?.text
    || "";
}

function parseJsonFromModelText(text: string): any | null {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] || trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function sanitizeCompactPlan(
  rawPlan: any,
  descriptors: CompactPlanGroupDescriptor[],
  requestedLayoutMode: PrintLayoutMode,
): CompactPrintPlan | null {
  if (!rawPlan || requestedLayoutMode !== "compact") return null;

  const descriptorIds = descriptors.map((item) => item.groupId);
  const descriptorIdSet = new Set(descriptorIds);
  const seen = new Set<string>();
  const orderedGroupIds: string[] = [];

  for (const rawId of rawPlan.orderedGroupIds || []) {
    const id = String(rawId || "");
    if (!descriptorIdSet.has(id) || seen.has(id)) continue;
    seen.add(id);
    orderedGroupIds.push(id);
  }

  for (const id of descriptorIds) {
    if (!seen.has(id)) {
      seen.add(id);
      orderedGroupIds.push(id);
    }
  }

  const clusters: Array<{ id: string; groupIds: string[]; reason?: string }> = [];
  const clustered = new Set<string>();
  for (const cluster of rawPlan.clusters || []) {
    const groupIds = (cluster?.groupIds || [])
      .map((value: unknown) => String(value || ""))
      .filter((id: string) => descriptorIdSet.has(id) && !clustered.has(id));
    if (!groupIds.length) continue;
    groupIds.forEach((id: string) => clustered.add(id));
    clusters.push({
      id: String(cluster?.id || `cluster_${clusters.length + 1}`),
      groupIds,
      reason: typeof cluster?.reason === "string" ? cluster.reason : undefined,
    });
  }

  for (const id of orderedGroupIds) {
    if (!clustered.has(id)) {
      clusters.push({
        id: `cluster_${clusters.length + 1}`,
        groupIds: [id],
        reason: "Added during validation to preserve all groups.",
      });
    }
  }

  return {
    layoutMode: "compact",
    source: "ai",
    orderedGroupIds,
    clusters,
    notes: Array.isArray(rawPlan?.notes)
      ? rawPlan.notes.map((note: unknown) => String(note || "")).filter(Boolean)
      : undefined,
  };
}

async function callGeminiCompactPlanner(
  apiKey: string,
  policyText: string,
  descriptors: CompactPlanGroupDescriptor[],
): Promise<any | null> {
  const model = "gemini-2.5-flash";
  const prompt = [
    "You are planning a paper-saving compact print layout for a lab report.",
    "Return ONLY valid JSON.",
    "Keep every test group exactly once.",
    "Preserve clinical readability.",
    "Prefer grouping adjacent small compatible panels.",
    "Never merge banned or unsafe categories if present in names/categories.",
    "",
    "Policy text:",
    policyText || "Compact print should save paper while preserving readability. Prefer small compatible panel combinations.",
    "",
    "Input groups:",
    JSON.stringify(descriptors, null, 2),
    "",
    'Output schema: {"orderedGroupIds":["id1","id2"],"clusters":[{"id":"cluster_1","groupIds":["id1","id2"],"reason":"..."}],"notes":["..."]}',
  ].join("\n");

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: "application/json",
        },
      }),
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini compact planner failed: ${response.status} ${errorText}`);
  }

  const payload = await response.json();
  const text = extractGeminiResponseText(payload);
  return parseJsonFromModelText(text);
}

function reorderContextByGroupIds(context: any, orderedGroupIds: string[]): any {
  const orderIndex = new Map<string, number>(
    orderedGroupIds.map((id, index) => [id, index]),
  );
  const fallbackBase = orderedGroupIds.length + 1000;

  if (Array.isArray(context?.testGroupIds)) {
    const uniqueIds = Array.from(new Set(context.testGroupIds.map((id: unknown) => String(id || "")).filter(Boolean)));
    context.testGroupIds = uniqueIds.sort((a, b) => {
      const ai = orderIndex.get(a) ?? fallbackBase;
      const bi = orderIndex.get(b) ?? fallbackBase;
      return ai - bi || a.localeCompare(b);
    });
  }

  if (Array.isArray(context?.analytes)) {
    context.analytes = [...context.analytes].sort((a: any, b: any) => {
      const aGroup = String(a?.test_group_id || a?.testGroupId || "");
      const bGroup = String(b?.test_group_id || b?.testGroupId || "");
      const ai = orderIndex.get(aGroup) ?? fallbackBase;
      const bi = orderIndex.get(bGroup) ?? fallbackBase;
      if (ai !== bi) return ai - bi;
      const aSort = Number(a?.sort_order ?? 0);
      const bSort = Number(b?.sort_order ?? 0);
      return aSort - bSort || String(a?.parameter || "").localeCompare(String(b?.parameter || ""));
    });
  }

  return context;
}

function buildOrderedAnalytesByGroup(
  analytesByGroup: Map<string, any[]>,
  orderedGroupIds: string[],
): Map<string, any[]> {
  const ordered = new Map<string, any[]>();
  for (const groupId of orderedGroupIds) {
    const analytes = analytesByGroup.get(groupId);
    if (analytes) ordered.set(groupId, analytes);
  }
  for (const [groupId, analytes] of analytesByGroup.entries()) {
    if (!ordered.has(groupId)) ordered.set(groupId, analytes);
  }
  return ordered;
}

// â”€â”€ Configurable Patient Info Section Builder â”€â”€
interface PatientInfoConfig {
  layout: 'table' | 'inline';
  fields: string[];
}

const PATIENT_INFO_FIELD_MAP: Record<string, { label: string; placeholder: string }> = {
  patientName:          { label: 'Patient Name',     placeholder: '{{patientName}}' },
  patientId:            { label: 'Patient ID',       placeholder: '{{patientId}}' },
  registrationDate:     { label: 'Reg. Date',        placeholder: '{{orderDate}}' },
  age:                  { label: 'Age',              placeholder: '{{patientAgeFormatted}}' },
  gender:               { label: 'Gender',           placeholder: '{{patientGender}}' },
  collectionDate:       { label: 'Collected On',     placeholder: '{{collectionDate}}' },
  sampleId:             { label: 'Sample ID',        placeholder: '{{sampleId}}' },
  // Resolves to the name alone unless the doctor master has a degree saved, in
  // which case the degree renders on a second line aligned under the name.
  referringDoctorName:  { label: 'Ref. Doctor',      placeholder: '{{referringDoctorBlock}}' },
  approvedAt:           { label: 'Approved On',      placeholder: '{{approvedAt}}' },
  phone:                { label: 'Phone',            placeholder: '{{patientPhone}}' },
  sampleCollectedBy:    { label: 'Collected By',     placeholder: '{{sampleCollectedBy}}' },
  receivedAt:           { label: 'Received Date/Time', placeholder: '{{receivedAt}}' },
  collectionCenter:     { label: 'Collection Center', placeholder: '{{collectionCenter}}' },
  b2bAccountName:       { label: 'B2B / Account Name', placeholder: '{{b2bAccountName}}' },
  // Same value as b2bAccountName, printed under the wording labs that route work
  // through referring centres prefer. Both keys exist so a lab can pick either label.
  refCenter:            { label: 'Ref. Center',      placeholder: '{{refCenter}}' },
  // The lab's own main lab (labs.default_processing_location_id), i.e. where the
  // sample was analysed — as opposed to the collection centre it came from.
  processingCenter:     { label: 'Proc. Center',     placeholder: '{{processingCenter}}' },
};

function buildPatientInfoHtml(
  config: PatientInfoConfig,
  accentColor = '#5a7f3a',
  extraFieldConfigs?: Array<{ field_key: string; label: string }>,
): string {
  // Build dynamic lookup for custom_* keys from lab's field configs
  const customFieldMap: Record<string, { label: string; placeholder: string }> = {};
  if (extraFieldConfigs) {
    for (const f of extraFieldConfigs) {
      customFieldMap[`custom_${f.field_key}`] = {
        label: f.label,
        placeholder: `{{custom_${f.field_key}}}`,
      };
    }
  }

  const fields = config.fields
    .map(key => {
      if (PATIENT_INFO_FIELD_MAP[key]) return PATIENT_INFO_FIELD_MAP[key];
      if (customFieldMap[key]) return customFieldMap[key];
      // Fallback: derive label from key name (e.g. custom_abha_id â†’ "Abha Id")
      if (key.startsWith('custom_')) {
        const rawKey = key.replace(/^custom_/, '');
        const label = rawKey.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
        return { label, placeholder: `{{${key}}}` };
      }
      return undefined;
    })
    .filter(Boolean) as Array<{ label: string; placeholder: string }>;

  if (fields.length === 0) return '';

  if (config.layout === 'table') {
    // Table layout â€” 2 columns of label/value pairs per row
    const rows: string[] = [];
    for (let i = 0; i < fields.length; i += 2) {
      const f1 = fields[i];
      const f2 = fields[i + 1];
      rows.push(`<tr>
        <td style="padding: 8px 12px; border: 1px solid #e5e7eb; background: #f9fafb; width: 25%; font-weight: 500;">${f1.label}</td>
        <td style="padding: 8px 12px; border: 1px solid #e5e7eb; width: 25%;">${f1.placeholder}</td>
        ${f2 ? `<td style="padding: 8px 12px; border: 1px solid #e5e7eb; background: #f9fafb; width: 25%; font-weight: 500;">${f2.label}</td>
        <td style="padding: 8px 12px; border: 1px solid #e5e7eb; width: 25%;">${f2.placeholder}</td>` : `<td colspan="2" style="border: 1px solid #e5e7eb;"></td>`}
      </tr>`);
    }
    return `
    <div class="patient-info" style="page-break-inside: avoid;">
      <h3 style="font-size: 14px; font-weight: 600; color: #374151; margin-bottom: 8px; border-bottom: 1px solid #e5e7eb; padding-bottom: 4px;">Patient Information</h3>
      <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
        <tbody>${rows.join('')}</tbody>
      </table>
    </div>`;
  }

  // Inline layout â€” flex row of spans (beautiful style)
  // First field (usually patientName) gets prominent heading treatment
  const firstField = fields[0];
  const restFields = fields.slice(1);
  const spans = restFields.map(f => `<span><strong>${f.label}:</strong> ${f.placeholder}</span>`).join('\n        ');

  return `
    <div class="patient-info" style="margin-bottom: 16px; padding: 12px 16px; background: #ffffff; border: 1px solid #d1d5db; border-radius: 4px; page-break-inside: avoid;">
      <div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px;">
        <div style="font-size: 16px; font-weight: 700; color: ${accentColor};">
          ${firstField.placeholder}
        </div>
        <div style="font-size: 11px; color: #6b7280;">
          {{approvedAtFormatted}}
        </div>
      </div>
      <div style="display: flex; flex-wrap: wrap; gap: 12px; font-size: 12px; color: #374151;">
        ${spans}
      </div>
    </div>`;
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Shared helper: sort analytes by sort_order and group by section_heading.
//
// Returns an array of { heading: string | null, analytes: any[] } blocks.
// Analytes with no section_heading (or all the same heading) are treated as
// a single block with heading = null.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function groupAnalytesBySectionHeading(
  analytes: any[],
): { heading: string | null; analytes: any[] }[] {
  // Sort: defined sort_order first (ascending), then by insertion order
  const sorted = [...analytes].sort((a, b) => {
    const oa = a.sort_order ?? 0;
    const ob = b.sort_order ?? 0;
    return oa - ob;
  });
  console.log("ðŸ“Š Analyte sort order:", sorted.map(a => `${a.parameter}(sort_order=${a.sort_order ?? 'null'})`).join(', '));

  // Check if any analyte has a section_heading
  const hasHeadings = sorted.some((a) => a.section_heading);
  if (!hasHeadings) {
    return [{ heading: null, analytes: sorted }];
  }

  // Group into consecutive blocks sharing the same heading
  const blocks: { heading: string | null; analytes: any[] }[] = [];
  let currentHeading: string | null = null;
  let currentBlock: any[] = [];

  for (const analyte of sorted) {
    const h = analyte.section_heading ?? null;
    if (h !== currentHeading) {
      if (currentBlock.length > 0) {
        blocks.push({ heading: currentHeading, analytes: currentBlock });
      }
      currentHeading = h;
      currentBlock = [analyte];
    } else {
      currentBlock.push(analyte);
    }
  }
  if (currentBlock.length > 0) {
    blocks.push({ heading: currentHeading, analytes: currentBlock });
  }
  return blocks;
}

function getAnalyteIdentityIds(analyte: any): string[] {
  const ids = [
    analyte?.analyte_id,
    analyte?.analyteId,
    analyte?.id,
    analyte?.lab_analyte_id,
    analyte?.labAnalyteId,
    analyte?.analytes?.id,
    analyte?.lab_analytes?.id,
  ];

  return [...new Set(
    ids
      .map((value) => String(value || "").trim())
      .filter(Boolean),
  )];
}

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

/**
 * Classic default template - plain table with flag text styling.
 * This is the original default template before the 3-band color matrix was added.
 */
function generateClassicDefaultTemplateHtml(
  context: any,
  testGroupNames: Map<string, string>,
  analytesByGroup: Map<string, any[]>,
  signatoryInfo: any,
  sectionContent?: Record<string, string>,
  includeSections = true,
  showMethodology = true,
  showInterpretation = false,
  patientInfoConfig?: PatientInfoConfig | null,
  printOptions?: Record<string, unknown>,
  extraFieldConfigs?: Array<{ field_key: string; label: string }>,
  groupInterpretations?: Map<string, string>,
  sectionLabels?: Record<string, string>,
): string {
  const normalizedSectionContent =
    sectionContent && typeof sectionContent === "object" ? sectionContent : {};

  const stripLooseMarkdown = (value: string): string =>
    value
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/^(\*\*+)\s*/gm, "")
      .replace(/\s*(\*\*+)$/gm, "")
      .trim();

  const escapeNarrativeHtml = (value: string): string =>
    value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");

  const formatNarrativeHtml = (rawContent: string): string => {
    const trimmed = rawContent.trim();
    if (!trimmed) return "";
    if (/<[a-z][\s\S]*>/i.test(trimmed)) {
      return trimmed.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    }

    const lines = trimmed
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((line) => stripLooseMarkdown(line))
      .filter(Boolean);

    const parts: string[] = [];
    let listItems: string[] = [];
    const flushList = () => {
      if (!listItems.length) return;
      parts.push(`<ul>${listItems.join("")}</ul>`);
      listItems = [];
    };

    for (const line of lines) {
      if (/^[-*â€¢]\s+/.test(line)) {
        listItems.push(
          `<li>${escapeNarrativeHtml(line.replace(/^[-*â€¢]\s+/, "").trim())}</li>`,
        );
        continue;
      }

      flushList();

      const colonIdx = line.indexOf(":");
      if (colonIdx > 0 && colonIdx < 60) {
        parts.push(`
          <div class="narrative-kv-row">
            <div class="narrative-kv-label">${escapeNarrativeHtml(line.slice(0, colonIdx).trim())}</div>
            <div class="narrative-kv-value">${escapeNarrativeHtml(line.slice(colonIdx + 1).trim())}</div>
          </div>`);
        continue;
      }

      parts.push(`<p>${escapeNarrativeHtml(line)}</p>`);
    }

    flushList();
    return parts.join("");
  };

  const isNarrativeGroup = (analytes: any[]): boolean => {
    if (!analytes.length) return false;
    const narrativeRows = analytes.filter((analyte) => {
      const unit = String(analyte.unit || "").trim().toLowerCase();
      const ref = String(analyte.reference_range || "").trim();
      const valueTypeRaw = String(analyte.value_type || "").toLowerCase();
      // Count any row with no unit and no numeric reference range as narrative,
      // including section headers and plain-text paragraph rows (empty value).
      return (
        valueTypeRaw !== "qualitative" &&
        (!unit || ["n/a", "na", "-", "none", "not applicable"].includes(unit)) &&
        !/\d/.test(ref)
      );
    }).length;

    return narrativeRows > 0 && narrativeRows / analytes.length >= 0.7;
  };

  // Patient Information Section
  const patientInfoHtml = patientInfoConfig
    ? buildPatientInfoHtml(patientInfoConfig, '#5a7f3a', extraFieldConfigs)
    : `
    <div class="patient-info" style="page-break-inside: avoid;">
      <h3 style="font-size: 14px; font-weight: 600; color: #374151; margin-bottom: 8px; border-bottom: 1px solid #e5e7eb; padding-bottom: 4px;">Patient Information</h3>
      <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
        <tbody>
          <tr>
            <td style="padding: 8px 12px; border: 1px solid #e5e7eb; background: #f9fafb; width: 25%; font-weight: 500;">Patient Name</td>
            <td style="padding: 8px 12px; border: 1px solid #e5e7eb; width: 25%;">{{patientName}}</td>
            <td style="padding: 8px 12px; border: 1px solid #e5e7eb; background: #f9fafb; width: 25%; font-weight: 500;">Patient ID</td>
            <td style="padding: 8px 12px; border: 1px solid #e5e7eb; width: 25%;">{{patientId}}</td>
          </tr>
          <tr>
            <td style="padding: 8px 12px; border: 1px solid #e5e7eb; background: #f9fafb; font-weight: 500;">Age / Gender</td>
            <td style="padding: 8px 12px; border: 1px solid #e5e7eb;">{{patientAgeFormatted}} / {{patientGender}}</td>
            <td style="padding: 8px 12px; border: 1px solid #e5e7eb; background: #f9fafb; font-weight: 500;">Collected On</td>
            <td style="padding: 8px 12px; border: 1px solid #e5e7eb;">{{collectionDate}}</td>
          </tr>
          <tr>
            <td style="padding: 8px 12px; border: 1px solid #e5e7eb; background: #f9fafb; font-weight: 500;">Ref. Doctor</td>
            <td style="padding: 8px 12px; border: 1px solid #e5e7eb;">{{referringDoctorName}}</td>
            <td style="padding: 8px 12px; border: 1px solid #e5e7eb; background: #f9fafb; font-weight: 500;">Approved on</td>
            <td style="padding: 8px 12px; border: 1px solid #e5e7eb;">{{approvedAt}}</td>
          </tr>
        </tbody>
      </table>
    </div>
  `;

  // Determine if this is a section-only report (no analytes, only section content)
  const hasAnalytes = Array.from(analytesByGroup.values()).some(a => a && a.length > 0);
  const hasSections = Object.keys(normalizedSectionContent).length > 0;

  const buildSectionLabel = (key: string) => {
    if (sectionLabels?.[key]) return sectionLabels[key];
    const { rawKey } = normalizeSectionKey(key);
    if (!rawKey) return "Report Section";
    return rawKey
      .replace(/[_-]+/g, " ")
      .split(" ")
      .filter(Boolean)
      .map((part: string) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join(" ");
  };

  // Test Results Section
  let testResultsHtml = '<div class="test-results">';

  if (hasAnalytes) {
    // Normal analyte-based rendering
    testResultsHtml += '<h3 style="font-size: 14px; font-weight: 600; color: #1e40af; margin-bottom: 8px; border-bottom: 2px solid #3b82f6; padding-bottom: 4px;">Test Results</h3>';

  for (const [groupId, analytes] of analytesByGroup) {
    if (!analytes || analytes.length === 0) continue;

    const groupName = testGroupNames.get(groupId) || analytes[0]?.test_name || "Test Results";
    const sectionBlocks = groupAnalytesBySectionHeading(analytes);

    testResultsHtml += `
      <div class="test-group-section" style="margin-bottom: 16px;">
        <h4 style="font-size: 16px; font-weight: 600; color: #1e40af; padding: 6px 0; margin: 0;">${groupName}</h4>
        ${(printOptions as any)?._sampleType ? `<div style="font-size:11px;color:#6b7280;font-style:italic;margin:-4px 0 4px 0;">Specimen: ${(printOptions as any)._sampleType}</div>` : ''}
        ${(printOptions as any)?._sampleCondition ? `<div style="font-size:11px;color:#6b7280;font-style:italic;margin:-4px 0 4px 0;">Condition: ${(printOptions as any)._sampleCondition}</div>` : ''}
        <table class="report-table" style="width: 100%; border-collapse: collapse; font-size: 12px;">
          <thead>
            <tr style="background: #f1f5f9;">
              <th style="padding: 10px 12px; border: 1px solid #e5e7eb; text-align: left; font-weight: 600; width: 30%;">Test Parameter</th>
              <th style="padding: 10px 12px; border: 1px solid #e5e7eb; text-align: left; font-weight: 600; width: 20%;">Result</th>
              <th style="padding: 10px 12px; border: 1px solid #e5e7eb; text-align: left; font-weight: 600; width: 15%;">Unit</th>
              <th style="padding: 10px 12px; border: 1px solid #e5e7eb; text-align: left; font-weight: 600; width: 25%;">Reference Range</th>
              <th style="padding: 10px 12px; border: 1px solid #e5e7eb; text-align: center; font-weight: 600; width: 10%;">Flag</th>
            </tr>
          </thead>
          <tbody>
    `;

    let rowIndexGlobal = 0;
    for (const block of sectionBlocks) {
      // Render section sub-heading row if present
      if (block.heading) {
        testResultsHtml += `
            <tr>
              <td colspan="5" style="padding: 6px 12px; background: #f1f5f9; font-weight: 600; font-size: 11px; color: #374151; border: 1px solid #e5e7eb;">${block.heading}</td>
            </tr>
        `;
      }
      for (const analyte of block.analytes) {
        const rowBg = rowIndexGlobal++ % 2 === 0 ? "#ffffff" : "#f8fafc";
        const parameterName = analyte.parameter || analyte.name || analyte.test_name || "";
        const rawValue = analyte.value ?? "";
        const value = formatAnalyteDisplayValue(analyte, printOptions, rawValue);
        const unit = analyte.unit || "";
        const refRange = (analyte.reference_range || "").replace(/\n/g, "<br>");
        const flag = analyte.flag || "";
        const normalizedFlag = normalizeReportFlag(flag);
        const canonicalFlag = normalizedFlag.canonical;
        const displayFlag = normalizedFlag.label;

        const unitText = String(unit || "").trim().toLowerCase();
        const refText = String(refRange || "").trim();
        const hasNumericRef = /\d/.test(refText);
        const isDescriptive =
          unitText === "n/a" || unitText === "na" || unitText === "-" ||
          unitText === "none" || unitText === "not applicable" ||
          (!unitText && refText && !hasNumericRef);

        let flagStyle = "";
        let flagClass = "";

        if (canonicalFlag === "high" || canonicalFlag === "critical_high") {
          flagStyle = "color: #dc2626; font-weight: bold;";
          flagClass = "result-high flag-high";
        } else if (canonicalFlag === "low" || canonicalFlag === "critical_low") {
          flagStyle = "color: #ea580c; font-weight: bold;";
          flagClass = "result-low flag-low";
        } else if (canonicalFlag === "normal") {
          flagStyle = "color: #16a34a;";
          flagClass = "result-normal flag-normal";
        } else if (canonicalFlag === "critical") {
          flagStyle = "color: #7c2d12; font-weight: bold;";
          flagClass = "result-critical flag-critical";
        } else if (canonicalFlag === "abnormal") {
          flagStyle = "color: #dc2626; font-weight: bold;";
          flagClass = "result-abnormal flag-abnormal";
        }

        if (isDescriptive) {
          if (value && value.trim()) {
            testResultsHtml += `
              <tr class="descriptive-row" style="background: ${rowBg};">
                <td style="padding: 10px 12px; font-size: ${basePx}px; text-align: center; font-weight: 600;">
                  ${parameterName}
                </td>
                <td style="padding: 10px 12px; font-size: ${basePx}px; text-align: right;">
                  ${value}
                </td>
                <td style="padding: 10px 12px; font-size: ${basePx}px;"></td>
                <td style="padding: 10px 12px; font-size: ${basePx}px; color: #666;">
                  ${refText || ""}
                </td>
              </tr>
            `;
          } else {
            testResultsHtml += `
              <tr style="background: ${rowBg};">
                <td colspan="5" style="padding: 10px 12px; border: 1px solid #e5e7eb;">
                  <strong>${parameterName}:</strong> ${refText || ""}
                </td>
              </tr>
            `;
          }
          continue;
        }

        testResultsHtml += `
              <tr style="background: ${rowBg};">
                <td style="padding: 8px 12px; border: 1px solid #e5e7eb;">
                  ${parameterName}${(analyte.is_auto_calculated || analyte.is_calculated) ? '<sup style="font-size:8px;color:#6b7280;margin-left:2px;font-style:italic;">*calc</sup>' : ''}
                  ${showMethodology && analyte.method ? `<div style="font-size: 9px; color: #9ca3af; margin-top: 2px;">${analyte.method}</div>` : ""}
                </td>
                <td class="${flagClass}" style="padding: 8px 12px; border: 1px solid #e5e7eb; ${flagStyle}">${value}${printOptions?.flagAsterisk && (canonicalFlag === 'high' || canonicalFlag === 'low' || canonicalFlag === 'critical_high' || canonicalFlag === 'critical_low') ? (printOptions?.flagAsteriskCritical && (canonicalFlag === 'critical_high' || canonicalFlag === 'critical_low') ? '**' : '*') : ''}</td>
                <td style="padding: 8px 12px; border: 1px solid #e5e7eb;">${unit}</td>
                <td style="padding: 8px 12px; border: 1px solid #e5e7eb;">${refRange}</td>
                <td class="${flagClass}" style="padding: 8px 12px; border: 1px solid #e5e7eb; text-align: center; ${flagStyle}">${displayFlag}</td>
              </tr>
        `;

        if (showInterpretation) {
          let classicInterpretation = "";
          if (canonicalFlag === "high" || canonicalFlag === "critical_high") {
            classicInterpretation = analyte.interpretation_high || "";
          } else if (canonicalFlag === "low" || canonicalFlag === "critical_low") {
            classicInterpretation = analyte.interpretation_low || "";
          } else {
            classicInterpretation = analyte.interpretation_normal || "";
          }
          if (classicInterpretation) {
            testResultsHtml += `
              <tr style="background: ${rowBg};">
                <td colspan="5" style="padding: 2px 12px 6px 24px; border: 1px solid #e5e7eb; border-top: none; font-size: 11px; color: #6b7280; font-style: italic;">
                  <strong>Interpretation:</strong> ${classicInterpretation}
                </td>
              </tr>
            `;
          }
        }
      } // end for analyte
    } // end for block

    const _classicGroupInterp = groupInterpretations?.get(groupId);
    testResultsHtml += `
          </tbody>
        </table>
        ${analytes.some((a: any) => a.is_auto_calculated || a.is_calculated) ? '<p style="font-size:9px;color:#9ca3af;margin:2px 0 8px;font-style:italic;">*calc \u2013 Calculated parameter</p>' : ''}
        ${_classicGroupInterp ? `<div class="limsv2-report group-interpretation" style="margin-top:8px;padding:6px 10px;border-top:1px solid #e2e8f0;font-size:inherit;">${_classicGroupInterp}</div>` : ''}
      </div>
    `;
  }

  } else if (hasSections) {
    // â”€â”€ Section-only rendering (radiology, micro, etc.) â”€â”€
    // No analyte table â€” render section content directly as the primary report body
    const groupName = testGroupNames.size > 0
      ? Array.from(testGroupNames.values())[0]
      : "Report";

    testResultsHtml += `
      <div class="test-group-section" style="margin-bottom: 16px;">
        <h3 style="font-size: 16px; font-weight: 600; color: #1e40af; margin-bottom: 8px; border-bottom: 2px solid #3b82f6; padding-bottom: 4px;">${groupName}</h3>
    `;

    for (const [key, content] of Object.entries(normalizedSectionContent)) {
      const rawContent = String(content).trim();
      if (!rawContent) continue;

      const heading = (sectionLabels && sectionLabels[key])
        ? sectionLabels[key]
        : buildSectionLabel(key);

      // Rich HTML (e.g. Glass Prescription table) â€” pass through
      if (/<table\b/i.test(rawContent)) {
        testResultsHtml += `
          <div style="margin-top: 14px; page-break-inside: avoid;">
            <h4 style="font-size: 13px; font-weight: 600; color: #374151; margin: 0 0 6px; text-transform: uppercase; letter-spacing: 0.3px;">${heading}</h4>
            ${rawContent}
          </div>
        `;
        continue;
      }

      // Parse text â†’ lines
      const plainText = rawContent
        .replace(/<div[^>]*>/gi, "").replace(/<\/div>/gi, "\n")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .trim();

      const lines = plainText.split(/\n/).map((l: string) => l.trim()).filter(Boolean);
      const colonLines = lines.filter((l: string) => l.indexOf(":") > 0);
      const hasStructuredData = colonLines.length >= lines.length * 0.5 && colonLines.length >= 2;

      if (hasStructuredData) {
        // Key-value pairs â†’ Parameter | Finding table
        const rowsHtml = lines.map((line: string, idx: number) => {
          const colonIdx = line.indexOf(":");
          if (colonIdx > 0) {
            const rowLabel = line.substring(0, colonIdx).trim();
            const rowValue = line.substring(colonIdx + 1).trim();
            const rowBg = idx % 2 === 0 ? "#ffffff" : "#f8fafc";
            return `<tr style="background: ${rowBg};">
              <td style="padding: 8px 12px; border: 1px solid #e5e7eb; font-weight: 500; width: 40%;">${rowLabel}</td>
              <td style="padding: 8px 12px; border: 1px solid #e5e7eb; width: 60%;">${rowValue}</td>
            </tr>`;
          }
          return `<tr><td colspan="2" style="padding: 8px 12px; border: 1px solid #e5e7eb; font-weight: 600; background: #f1f5f9;">${line}</td></tr>`;
        }).join("");

        testResultsHtml += `
          <div style="margin-top: 14px; page-break-inside: avoid;">
            <h4 style="font-size: 13px; font-weight: 600; color: #374151; margin: 0 0 6px; text-transform: uppercase; letter-spacing: 0.3px;">${heading}</h4>
            <table style="width: 100%; border-collapse: collapse; font-size: 12px;">
              <thead>
                <tr style="background: #f1f5f9;">
                  <th style="padding: 8px 12px; border: 1px solid #e5e7eb; text-align: left; font-weight: 600; width: 40%;">Parameter</th>
                  <th style="padding: 8px 12px; border: 1px solid #e5e7eb; text-align: left; font-weight: 600; width: 60%;">Finding</th>
                </tr>
              </thead>
              <tbody>${rowsHtml}</tbody>
            </table>
          </div>
        `;
      } else {
        // Free text / bulky text (impression, conclusion, etc.)
        const formatted = formatSectionContentToHtml(rawContent);
        testResultsHtml += `
          <div style="margin-top: 14px; page-break-inside: avoid;">
            <h4 style="font-size: 13px; font-weight: 600; color: #374151; margin: 0 0 6px; text-transform: uppercase; letter-spacing: 0.3px;">${heading}</h4>
            <div style="font-size: 12px; color: #1f2937; line-height: 1.6; padding: 8px 12px; border: 1px solid #e5e7eb; border-radius: 4px; background: #fafafa;">
              ${formatted}
            </div>
          </div>
        `;
      }
    }

    testResultsHtml += `</div>`;
  }

  testResultsHtml += "</div>";

  // Signatory Section
  const sigName = formatSignatureNameForPdf(signatoryInfo?.signatoryName || "");
  const sigDesignation = signatoryInfo?.signatoryDesignation || "";
  const sigImageUrl = signatoryInfo?.signatoryImageUrl || "";
  const signatureSize = resolveSignatureImageSize(printOptions);

  const _defaultSigList = getReportSignatories(signatoryInfo);
  const signatoryHtml = (() => {
    if (_defaultSigList.length <= 1) {
      return `
    <div class="signatures" style="margin-top: 20px; text-align: right; page-break-inside: avoid;">
      ${sigImageUrl ? `<img src="${sigImageUrl}" alt="" style="max-height: ${signatureSize.maxHeight}px; max-width: ${signatureSize.maxWidth}px; width: auto; height: auto; object-fit: contain; margin-bottom: 5px;" onerror="this.style.display='none'" />` : ""}
      ${sigName ? `<p style="margin: 0; font-weight: 600; font-size: 14px;">${sigName}</p>` : ""}
      ${sigDesignation ? `<p style="margin: 4px 0 0 0; color: #64748b; font-size: 12px;">${sigDesignation}</p>` : ""}
    </div>
  `;
    }
    const n = _defaultSigList.length;
    const maxH = Math.min(signatureSize.maxHeight, n >= 3 ? 48 : 54);
    const maxW = Math.min(signatureSize.maxWidth, n >= 3 ? 120 : 145);
    const boxes = _defaultSigList.map((s) => {
      const nm = formatSignatureNameForPdf(s?.signatoryName || "");
      const dg = s?.signatoryDesignation || "";
      const img = s?.signatoryImageUrl || "";
      return `
      <div style="text-align:center;">
        ${img ? `<img src="${img}" alt="" style="max-height:${maxH}px; max-width:${maxW}px; width:auto; height:auto; object-fit:contain; margin:0 auto 5px; display:block;" onerror="this.style.display='none'" />` : ""}
        ${nm ? `<p style="margin:0; font-weight:600; font-size:13px;">${nm}</p>` : ""}
        ${dg ? `<p style="margin:4px 0 0 0; color:#64748b; font-size:11px;">${dg}</p>` : ""}
      </div>`;
    }).join("");
    return `
    <div class="signatures" style="margin-top: 20px; page-break-inside: avoid; display:flex; gap:20px; align-items:flex-end; justify-content:flex-end;">
      ${boxes}
    </div>
  `;
  })();

  let reportSectionsHtml = "";
  // Only render separate "Report Sections" block when there ARE analytes
  // (sections supplement the analyte table). For section-only groups, sections
  // were already rendered as primary content above.
  if (hasAnalytes && includeSections && Object.keys(normalizedSectionContent).length > 0) {
    const sectionItems = Object.entries(normalizedSectionContent)
      .filter(([, content]) => content && String(content).trim().length > 0)
      .map(([key, content]) => {
        const rawContent = String(content).trim();
        if (!rawContent) return "";
        const heading = buildSectionLabel(key);
        return renderSectionContentForTemplate(
          rawContent,
          heading,
          'font-size: 13px; font-weight: 600; color: #111827; margin: 0 0 6px;',
        );
      })
      .filter(Boolean)
      .join("");

    if (sectionItems) {
      reportSectionsHtml = `
        <div class="report-sections" style="margin-top: 18px;">
          <h3 style="font-size: 14px; font-weight: 600; color: #111827; margin-bottom: 8px; border-bottom: 1px solid #e5e7eb; padding-bottom: 4px;">Report Sections</h3>
          ${sectionItems}
        </div>
      `;
    }
  }

  return `
    <div class="default-report-template">
      ${printOptions?._suppressPatientHeader ? '' : patientInfoHtml}
      ${testResultsHtml}
      ${reportSectionsHtml}
      ${printOptions?._suppressSignature ? '' : signatoryHtml}
    </div>
  `;
}

/**
 * Helper: render section content as a Parameter | Finding table when content has
 * colon-separated key:value lines. Falls back to formatSectionContentToHtml for
 * unstructured content. Rich HTML (e.g. <table>) is passed through as-is.
 */
function renderSectionContentForTemplate(
  rawContent: string,
  heading: string,
  headingStyle: string,
): string {
  if (!rawContent) return "";

  // Rich HTML (e.g. Glass Prescription table) â€” pass through
  if (/<table\b/i.test(rawContent)) {
    return `
      <div style="margin-top: 12px;">
        <h4 style="${headingStyle}">${heading}</h4>
        ${rawContent}
      </div>
    `;
  }

  // Strip HTML wrappers to get plain text lines
  const plainText = rawContent
    .replace(/<div[^>]*>/gi, "").replace(/<\/div>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .trim();

  const lines = plainText.split(/\n/).map((l: string) => l.trim()).filter(Boolean);
  const colonLines = lines.filter((l: string) => l.indexOf(":") > 0);
  const hasStructuredData = colonLines.length >= lines.length * 0.5 && colonLines.length >= 2;

  if (hasStructuredData) {
    const rowsHtml = lines.map((line: string, idx: number) => {
      const colonIdx = line.indexOf(":");
      if (colonIdx > 0) {
        const rowLabel = line.substring(0, colonIdx).trim();
        const rowValue = line.substring(colonIdx + 1).trim();
        const rowBg = idx % 2 === 0 ? "#ffffff" : "#f8fafc";
        return `<tr style="background: ${rowBg};">
          <td style="padding: 8px 12px; border: 1px solid #e5e7eb; font-weight: 500; width: 40%;">${rowLabel}</td>
          <td style="padding: 8px 12px; border: 1px solid #e5e7eb; width: 60%;">${rowValue}</td>
        </tr>`;
      }
      return `<tr><td colspan="2" style="padding: 8px 12px; border: 1px solid #e5e7eb; font-weight: 600;">${line}</td></tr>`;
    }).join("");

    return `
      <div style="margin-top: 12px;">
        <h4 style="${headingStyle}">${heading}</h4>
        <table style="width: 100%; border-collapse: collapse; font-size: 12px;">
          <thead>
            <tr style="background: #f1f5f9;">
              <th style="padding: 10px 12px; border: 1px solid #e5e7eb; text-align: left; font-weight: 600; width: 40%;">Parameter</th>
              <th style="padding: 10px 12px; border: 1px solid #e5e7eb; text-align: left; font-weight: 600; width: 60%;">Finding</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
    `;
  }

  // Fallback: render as formatted HTML paragraphs
  const formatted = formatSectionContentToHtml(rawContent);
  if (!formatted) return "";
  return `
    <div style="margin-top: 12px;">
      <h4 style="${headingStyle}">${heading}</h4>
      ${formatted}
    </div>
  `;
}

/**
 * "Basic" template â€” old-school plain layout matching traditional printed lab reports.
 *
 * Design rules:
 *  - "TEST REPORT" title bar with 1.5px border top/bottom
 *  - Patient info as figure.table with <th> labels (15%) + <td> values (35%)
 *  - 4 columns: TEST NAME (36%) | VALUE (24%) | UNITS (12%) | Bio. Ref. Interval (28%)
 *  - Column header row: 1.5px solid border top/bottom only â€” no cell borders
 *  - Group name as center-title (underlined, uppercase) inside main-group-row
 *  - Section headings: sub-section-header class (uppercase, small, bold)
 *  - High flags â†’ red (#dc2626) bold; Low flags â†’ black bold; Qualitative abnormal â†’ black bold
 *  - Test name bold, method italic small below it, calculated marker *
 *  - Footer: flex layout â€” "Authenticated Electronic Report" left, signature right
 *  - Font size controllable via printOptions.baseFontSize (lab-level setting)
 */
const DEFAULT_BASIC_REPORT_DISCLAIMER =
  "This report is electronically generated and authenticated. Results relate only to the specimen received and should be correlated clinically. This report is not valid for medico-legal purposes.";

// A basic-template group whose values are all shorter than this keeps them right-aligned
// in the VALUE column. Only groups with sentence-length findings get the wide,
// left-aligned value cell that spans VALUE + UNITS + Bio. Ref. Interval.
const LONG_QUALITATIVE_VALUE_CHARS = 24;

function generateBasicDefaultTemplateHtml(
  _context: unknown,
  testGroupNames: Map<string, string>,
  analytesByGroup: Map<string, any[]>,
  signatoryInfo: any,
  sectionContent?: Record<string, string>,
  includeSections = true,
  showMethodology = true,
  showInterpretation = false,
  patientInfoConfig?: PatientInfoConfig | null,
  printOptions?: Record<string, unknown>,
  extraFieldConfigs?: Array<{ field_key: string; label: string }>,
  groupId?: string,
  groupInterpretations?: Map<string, string>,
  sectionLabels?: Record<string, string>,
): string {
  const normalizedSectionContent =
    sectionContent && typeof sectionContent === "object" ? sectionContent : {};

  const basePx = typeof printOptions?.baseFontSize === "number"
    ? Math.max(8, Math.min(24, printOptions.baseFontSize as number))
    : 14;
  const smallPx = Math.max(7, basePx - 3);
  const titlePx = basePx + 2;
  const sigPx = basePx + 1;
  const testNameWeight = (printOptions?.testNameBold ?? false) ? "600" : "normal";
  const testNameAlignment = (printOptions?.testNameAlignment as string) ?? "left";
  const calcMarker = (printOptions?.calcMarker as string) ?? "cal";
  const boldAllValues = (printOptions?.boldAllValues as boolean) ?? false;
  const boldAbnormal = (printOptions?.boldAbnormalValues as boolean) ?? true;
  // Bolds the patient information block values (labels stay bold either way).
  // Applied in the shared template CSS so e-copy and print stay in step.
  const patientInfoBold = (printOptions?.patientInfoBold as boolean) ?? false;
  // Vertical rule between the two patient-info column pairs (off by default).
  const patientInfoColumnDivider = (printOptions?.patientInfoColumnDivider as boolean) ?? false;
  // Patient info header geometry. The block is a 4-cell grid (label / value /
  // label / value); patientInfoLeftPct is the share of the row given to the LEFT
  // label+value pair, so a lab with long patient names can widen it beyond 50%.
  // patientInfoLabelPct is the share of each pair taken by its label column.
  // Defaults (50 / 30) reproduce the historical fixed 15% / 35% layout.
  const patientInfoLeftPct = Math.max(25, Math.min(75, Number(printOptions?.patientInfoLeftPct ?? 50)));
  const patientInfoLabelPct = Math.max(15, Math.min(60, Number(printOptions?.patientInfoLabelPct ?? 30)));
  const patientInfoRightPct = 100 - patientInfoLeftPct;
  const patientInfoWidths = {
    label1: Number((patientInfoLeftPct * patientInfoLabelPct / 100).toFixed(2)),
    value1: Number((patientInfoLeftPct * (100 - patientInfoLabelPct) / 100).toFixed(2)),
    label2: Number((patientInfoRightPct * patientInfoLabelPct / 100).toFixed(2)),
    value2: Number((patientInfoRightPct * (100 - patientInfoLabelPct) / 100).toFixed(2)),
  };
  // Header title bar: the "TEST REPORT" heading and the sample barcode can each
  // be switched off from the Basic template settings.
  const showReportTitle = printOptions?.showReportTitle !== false;
  const showHeaderBarcode = printOptions?.showHeaderBarcode !== false;
  // Title bar thickness. The bar is as tall as its tallest item, so the barcode
  // height is what usually drives it — both are adjustable to slim the header.
  const reportTitleBarPadding = Math.max(0, Math.min(10, Number(printOptions?.reportTitleBarPadding ?? 4)));
  const headerBarcodeWidth = Math.max(50, Math.min(160, Number(printOptions?.headerBarcodeWidth ?? 100)));
  const headerBarcodeHeight = Math.max(12, Math.min(48, Number(printOptions?.headerBarcodeHeight ?? 36)));
  // Slot width tracks the barcode so the centred title stays centred.
  const headerBarcodeSlotWidth = headerBarcodeWidth + 8;
  const underlineAbnormal = (printOptions?.underlineAbnormalValues as boolean) ?? false;
  const abnormalDecoration = underlineAbnormal
    ? "text-decoration: underline !important; text-underline-offset: 2px !important;"
    : "";
  const sectionHeaderInline = (printOptions?.sectionHeaderInline as boolean) ?? true;
  const resultTableBackground = printOptions?.resultTableBackground === "transparent" ? "transparent" : "#fff";
  const sectionRowBackground = printOptions?.resultTableBackground === "transparent" ? "transparent" : "#f5f5f5";
  const flagSymbol = (printOptions?.flagSymbol as string) ?? "none";
  const showFlagLegend = (printOptions?.showFlagLegend as boolean) ?? false;
  // Injected alongside the lab's print options (see _labFlagCodes at the labs
  // fetch). A verdict outside this list still styles the value, it just prints
  // no letter.
  const allowedFlagCodes = (printOptions?._labFlagCodes as string[] | null) ?? null;
  // Exact gap in px between the H/L symbol and the value (0-12, default 4)
  const flagGapPx = Math.max(0, Math.min(12, Number(printOptions?.flagGapPx ?? 4)));
  // Vertical padding applied to every result cell — the gap between two analyte rows
  // is twice this value (0-10, default 2 = the historical basic-template spacing).
  const analyteRowSpacing = Math.max(0, Math.min(10, Number(printOptions?.analyteRowSpacing ?? 2)));
  // Bottom margin of each test-group block — the gap before the next group (0-40, default 14).
  const testGroupSpacing = Math.max(0, Math.min(40, Number(printOptions?.testGroupSpacing ?? 14)));
  const testGroupTitlePosition = (printOptions?.testGroupTitlePosition as string) ?? "above_headers_center";
  const requestedQrPosition = String(printOptions?.qrPosition || "");
  const qrPosition = requestedQrPosition === "top_left" || requestedQrPosition === "top_right"
    ? requestedQrPosition
    : "bottom_left";
  const qrHorizontalOffset = Math.max(0, Math.min(80, Number(printOptions?.qrHorizontalOffset ?? 0)));
  // Section field name width percentage for narrative/section-only reports (default 40%)
  const sectionFieldNamePct = Math.max(20, Math.min(70, Number(printOptions?.sectionFieldNamePct ?? 40)));
  const colCount = 4;
  const basicColumnWidths = (printOptions?.basicColumnWidths || {}) as Record<string, unknown>;
  const standardColumnWidths = normalizeBasicColumnWidths(basicColumnWidths.standard, [36, 24, 12, 28], 4);
  const siblingColumnWidths = normalizeBasicColumnWidths(basicColumnWidths.sibling, [30, 14, 8, 16, 16, 16], 6);
  console.log("[generateBasicDefaultTemplateHtml] printOptions received:", JSON.stringify(printOptions));
  console.log("[generateBasicDefaultTemplateHtml] boldAllValues resolved to:", boldAllValues, "(raw value:", printOptions?.boldAllValues, "type:", typeof printOptions?.boldAllValues, ")");
  const resultColors = printOptions?.resultColors as Record<string, unknown> | undefined;
  const colorsEnabled = resultColors?.enabled !== false;
  const highColor = colorsEnabled ? (String(resultColors?.high || "") || "#dc2626") : "#000000";
  const lowColor = colorsEnabled ? (String(resultColors?.low || "") || "#000000") : "#000000";

  // Report disclaimer — printed by default just above the QR/signature footer.
  const showReportDisclaimer = printOptions?.showReportDisclaimer !== false;
  const reportDisclaimerText = (typeof printOptions?.reportDisclaimer === "string"
    ? printOptions.reportDisclaimer as string
    : DEFAULT_BASIC_REPORT_DISCLAIMER).trim();

  const noColorCss = `
<style>
.basic-report-template {
  font-size: ${basePx}px;
  line-height: 1.32;
  color: #000;
  font-family: Arial, Helvetica, sans-serif;
  display: flex;
  flex-direction: column;
  min-height: ${printOptions?._isCompact ? '0' : '780px'}; /* â‰ˆ A4 body height minus default top/bottom margins (180px + 150px) */
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

/* Protect rich HTML section content (e.g. Glass Prescription table) from the resets above.
   These rules MUST come after the general td/th resets and use higher specificity. */
.basic-report-template .section-rich-content table {
  border-collapse: collapse !important;
}
.basic-report-template .section-rich-content table td,
.basic-report-template .section-rich-content table th {
  border: 1px solid #9ca3af !important;
  padding: 8px !important;
  font-weight: inherit !important;
  background-color: inherit !important;
  vertical-align: middle !important;
}

/* Rich section content must flow across pages. Holding the whole block together
   (page-break-inside: avoid) pushed narrative sections â€” USG/scan reports, which
   are taller than the space left under the patient header â€” wholesale onto page 2
   and left page 1 blank. Break protection belongs on the rows and on the title,
   not on the section as a whole. */
.basic-report-template .section-rich-content {
  page-break-inside: auto !important;
  break-inside: auto !important;
}

.basic-report-template .section-rich-content > .center-title {
  page-break-after: avoid !important;
  break-after: avoid !important;
}

.basic-report-template .section-rich-content table tr {
  page-break-inside: avoid !important;
  break-inside: avoid !important;
}

/* Restore borders for clinical interpretation tables.
   Print options CSS sets .limsv2-report td { border:none !important } which kills these.
   Higher-specificity scoped rule with !important wins. */
.basic-report-template .group-interpretation figure.table table,
.basic-report-template .group-interpretation .tbl-interpretation {
  border-collapse: collapse !important;
  width: 100% !important;
}
.basic-report-template .group-interpretation figure.table table td,
.basic-report-template .group-interpretation figure.table table th,
.basic-report-template .group-interpretation .tbl-interpretation td,
.basic-report-template .group-interpretation .tbl-interpretation th {
  border: 1px solid #ccc !important;
  padding: 5px 8px !important;
  vertical-align: top !important;
}
.basic-report-template .group-interpretation figure.table table thead th,
.basic-report-template .group-interpretation .tbl-interpretation thead th {
  background-color: #f0f0f0 !important;
  font-weight: 700 !important;
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

/* Restore flag colors inside interpretation blocks (group-interpretation tables) */
.basic-report-template .group-interpretation .flag-high,
.basic-report-template .group-interpretation .value-high { color: #dc2626 !important; font-weight: 700 !important; }
.basic-report-template .group-interpretation .flag-low,
.basic-report-template .group-interpretation .value-low { color: #ea580c !important; font-weight: 700 !important; }
.basic-report-template .group-interpretation .flag-critical,
.basic-report-template .group-interpretation .flag-critical_h,
.basic-report-template .group-interpretation .value-critical { color: #dc2626 !important; font-weight: 900 !important; }
.basic-report-template .group-interpretation .flag-abnormal,
.basic-report-template .group-interpretation .value-abnormal { color: #dc2626 !important; font-weight: 700 !important; }
.basic-report-template .group-interpretation .flag-trace,
.basic-report-template .group-interpretation .value-trace { color: #ea580c !important; font-weight: 700 !important; }
.basic-report-template .group-interpretation .flag-normal,
.basic-report-template .group-interpretation .value-normal { color: #1f2937 !important; font-weight: 700 !important; }

.basic-report-template .report-title-bar {
  display: flex !important;
  align-items: center !important;
  border-top: 1.5px solid #000 !important;
  border-bottom: 1.5px solid #000 !important;
  padding: ${reportTitleBarPadding}px 0 !important;
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
  flex: 1 !important;
}

.basic-report-template .report-title-spacer {
  width: ${showHeaderBarcode ? headerBarcodeSlotWidth : 110}px !important;
  flex-shrink: 0 !important;
}

.basic-report-template .qr-top-left-slot {
  width: 110px !important;
  flex-shrink: 0 !important;
  text-align: left !important;
}

.basic-report-template .qr-top-left-slot .qr-verify img {
  width: 46px !important;
  height: 46px !important;
  display: block !important;
}

.basic-report-template .qr-top-right-slot {
  width: 108px !important;
  flex-shrink: 0 !important;
  text-align: right !important;
  margin-right: 8px !important;
}

.basic-report-template .qr-top-right-slot .qr-verify {
  display: inline-block !important;
  text-align: left !important;
}

.basic-report-template .qr-top-right-slot .qr-verify img {
  width: 46px !important;
  height: 46px !important;
  display: block !important;
}

.basic-report-template .report-title-barcode {
  width: ${headerBarcodeSlotWidth}px !important;
  flex-shrink: 0 !important;
  text-align: right !important;
  margin-right: 8px !important;
  overflow: hidden !important;
}

.basic-report-template .report-title-barcode img,
.basic-report-template .report-title-barcode svg {
  height: ${headerBarcodeHeight}px !important;
  width: ${headerBarcodeWidth}px !important;
  display: block !important;
  margin-left: auto !important;
}

.basic-report-template .patient-header-table {
  width: 100% !important;
  table-layout: fixed !important;
  margin-bottom: 0 !important;
  border: none !important;
}

.basic-report-template .patient-header-table th {
  font-weight: 700 !important;
  text-align: left !important;
  color: #000 !important;
  padding: 2px 3px !important;
  white-space: nowrap !important;
  border: none !important;
}

/* Configurable header geometry — cells 1/2 are the left label+value pair,
   cells 3/4 the right pair (see patientInfoLeftPct / patientInfoLabelPct). */
.basic-report-template .patient-header-table th:nth-child(1) { width: ${patientInfoWidths.label1}% !important; }
.basic-report-template .patient-header-table td:nth-child(2) { width: ${patientInfoWidths.value1}% !important; }
.basic-report-template .patient-header-table th:nth-child(3) { width: ${patientInfoWidths.label2}% !important; }
.basic-report-template .patient-header-table td:nth-child(4) { width: ${patientInfoWidths.value2}% !important; }

.basic-report-template .patient-header-table td {
  padding: 2px 3px !important;
  border: none !important;
  color: #111 !important;
  word-break: break-word !important;
  font-size: ${basePx}px !important;
  font-weight: ${patientInfoBold ? "700" : "normal"} !important;
}

.basic-report-template .patient-header-table th {
  font-size: ${basePx}px !important;
}

/* Doctor degree/qualification printed on its own line under the doctor name.
   The inline-block wrapper starts where the name starts (after the ": " prefix),
   so the degree line indents to match instead of hugging the cell edge. */
.basic-report-template .patient-header-table .ref-doctor-block {
  display: inline-block !important;
  vertical-align: top !important;
  max-width: 100% !important;
}

.basic-report-template .patient-header-table .ref-doctor-degree {
  font-size: ${Math.max(basePx - 1, 6)}px !important;
  font-weight: normal !important;
  color: #444 !important;
  line-height: 1.25 !important;
  margin-top: 1px !important;
  white-space: normal !important;
}
${patientInfoColumnDivider ? `
/* Vertical rule between the left and right patient info columns.
   Cell 2 of every row is the last cell of the left column pair. */
.basic-report-template .patient-header-table tr > *:nth-child(2) {
  border-right: 1px solid #000 !important;
  padding-right: 8px !important;
}

.basic-report-template .patient-header-table tr > *:nth-child(3) {
  padding-left: 8px !important;
}
` : ""}

.basic-report-template .patient-test-separator {
  border-top: 1.5px solid #000 !important;
  height: 0 !important;
  margin: 2px 0 6px !important;
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
.basic-report-template .tbl-results tbody td:nth-child(1) { width: ${formatBasicWidth(standardColumnWidths[0])} !important; text-align: ${testNameAlignment} !important; color: #111 !important; }
.basic-report-template .tbl-results tbody td:nth-child(2) { width: ${formatBasicWidth(standardColumnWidths[1])} !important; text-align: right !important; white-space: nowrap !important; overflow: hidden !important; }
.basic-report-template .tbl-results tbody td:nth-child(3) { width: ${formatBasicWidth(standardColumnWidths[2])} !important; text-align: left !important; color: #444 !important; white-space: normal !important; overflow-wrap: anywhere !important; word-break: break-word !important; }
.basic-report-template .tbl-results tbody td:nth-child(4) { width: ${formatBasicWidth(standardColumnWidths[3])} !important; text-align: left !important; color: #666 !important; white-space: normal !important; overflow-wrap: anywhere !important; word-break: break-word !important; }

.basic-report-template .tbl-results.has-sibling thead th:nth-child(1) { width: ${formatBasicWidth(siblingColumnWidths[0])} !important; text-align: ${testNameAlignment} !important; }
.basic-report-template .tbl-results.has-sibling thead th:nth-child(2) { width: ${formatBasicWidth(siblingColumnWidths[1])} !important; text-align: right !important; }
.basic-report-template .tbl-results.has-sibling thead th:nth-child(3) { width: ${formatBasicWidth(siblingColumnWidths[2])} !important; text-align: left !important; }
.basic-report-template .tbl-results.has-sibling thead th:nth-child(4) { width: ${formatBasicWidth(siblingColumnWidths[3])} !important; text-align: left !important; }
.basic-report-template .tbl-results.has-sibling thead th:nth-child(5) { width: ${formatBasicWidth(siblingColumnWidths[4])} !important; text-align: right !important; }
.basic-report-template .tbl-results.has-sibling thead th:nth-child(6) { width: ${formatBasicWidth(siblingColumnWidths[5])} !important; text-align: left !important; }
/* Only apply narrow widths to rows with sibling-section-row class */
.basic-report-template .tbl-results.has-sibling tbody tr.sibling-section-row td:nth-child(1) { width: ${formatBasicWidth(siblingColumnWidths[0])} !important; text-align: ${testNameAlignment} !important; }
.basic-report-template .tbl-results.has-sibling tbody tr.sibling-section-row td:nth-child(2) { width: ${formatBasicWidth(siblingColumnWidths[1])} !important; text-align: right !important; }
.basic-report-template .tbl-results.has-sibling tbody tr.sibling-section-row td:nth-child(3) { width: ${formatBasicWidth(siblingColumnWidths[2])} !important; text-align: left !important; white-space: normal !important; overflow-wrap: anywhere !important; word-break: break-word !important; }
.basic-report-template .tbl-results.has-sibling tbody tr.sibling-section-row td:nth-child(4) { width: ${formatBasicWidth(siblingColumnWidths[3])} !important; text-align: left !important; white-space: normal !important; overflow-wrap: anywhere !important; word-break: break-word !important; }
.basic-report-template .tbl-results.has-sibling tbody tr.sibling-section-row td:nth-child(5) { width: ${formatBasicWidth(siblingColumnWidths[4])} !important; text-align: right !important; }
.basic-report-template .tbl-results.has-sibling tbody tr.sibling-section-row td:nth-child(6) { width: ${formatBasicWidth(siblingColumnWidths[5])} !important; text-align: left !important; white-space: normal !important; overflow-wrap: anywhere !important; word-break: break-word !important; }
/* Wide widths for non-sibling rows in has-sibling table */
.basic-report-template .tbl-results.has-sibling tbody tr.wide-section-row td:nth-child(1) { width: ${formatBasicWidth(standardColumnWidths[0])} !important; text-align: ${testNameAlignment} !important; }
.basic-report-template .tbl-results.has-sibling tbody tr.wide-section-row td:nth-child(2) { width: ${formatBasicWidth(standardColumnWidths[1])} !important; text-align: right !important; }
.basic-report-template .tbl-results.has-sibling tbody tr.wide-section-row td:nth-child(3) { width: ${formatBasicWidth(standardColumnWidths[2])} !important; text-align: left !important; white-space: normal !important; overflow-wrap: anywhere !important; word-break: break-word !important; }
.basic-report-template .tbl-results.has-sibling tbody tr.wide-section-row td:nth-child(4) { width: ${formatBasicWidth(standardColumnWidths[3])} !important; text-align: left !important; white-space: normal !important; overflow-wrap: anywhere !important; word-break: break-word !important; }

.basic-report-template .same-row-sibling {
  display: inline !important;
  white-space: nowrap !important;
  color: #000 !important;
  font-size: ${basePx}px !important;
  text-align: right !important;
}

.basic-report-template .same-row-sibling-unit {
  color: #444 !important;
  font-weight: normal !important;
  margin-left: 4px !important;
  white-space: normal !important;
  overflow-wrap: anywhere !important;
  word-break: break-word !important;
}

.basic-report-template .same-row-sibling-ref {
  display: inline !important;
  color: #666 !important;
  font-size: ${smallPx + 1}px !important;
  line-height: 1.15 !important;
  text-align: right !important;
}

.basic-report-template .tbl-results td,
.basic-report-template .tbl-results th {
  border: none !important;
  padding: ${analyteRowSpacing}px 4px !important;
  line-height: 1.28 !important;
  font-size: ${basePx}px !important;
}

.basic-report-template .tbl-results tbody tr:not(.main-group-row):not(.sub-section-header):not(.interpretation-row):not(.descriptive-row) td {
  border-bottom: 0.5px dotted #e5e5e5 !important;
}

.basic-report-template .test-name-cell {
  vertical-align: top !important;
}

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
  font-weight: ${boldAllValues ? "600" : "normal"} !important;
  font-variant-numeric: tabular-nums !important;
  white-space: nowrap !important;
}

/* Must out-specify the "td:nth-child(2)" column rules above, otherwise the
   colspan'd qualitative value inherits their right-align/nowrap and the text
   drifts to the far edge of the merged cell. */
.basic-report-template .tbl-results tbody tr td.qualitative-wide-value,
.basic-report-template .tbl-results.has-sibling tbody tr.wide-section-row td.qualitative-wide-value,
.basic-report-template .tbl-results.has-sibling tbody tr.sibling-section-row td.qualitative-wide-value {
  width: ${formatBasicWidth(standardColumnWidths.slice(1).reduce((sum, width) => sum + width, 0))} !important;
  text-align: left !important;
  white-space: normal !important;
  overflow: visible !important;
  overflow-wrap: anywhere !important;
  word-break: break-word !important;
}

/* Qualitative value inside a group that also has numeric rows: stays in the VALUE
   column (so the column does not stagger) but is allowed to wrap, since the nowrap
   from ".val" / "td:nth-child(2)" would otherwise clip long text like "Non Reactive". */
.basic-report-template .tbl-results tbody tr td.qualitative-inline-value,
.basic-report-template .tbl-results.has-sibling tbody tr.wide-section-row td.qualitative-inline-value,
.basic-report-template .tbl-results.has-sibling tbody tr.sibling-section-row td.qualitative-inline-value {
  text-align: right !important;
  white-space: normal !important;
  overflow: visible !important;
  overflow-wrap: anywhere !important;
  word-break: break-word !important;
}

/* 'abnormal' (a Positive/Reactive qualitative verdict) takes the high/alert colour,
   not the low colour — printing it blue read as "below range". Matches
   src/utils/buildBasicPreviewHtml.ts so the preview and the PDF agree. */
.basic-report-template .val.high,
.basic-report-template .val.critical_high,
.basic-report-template .val.critical_h,
.basic-report-template .val.abnormal,
.basic-report-template .val.H,
.basic-report-template .val.High {
  color: ${highColor} !important;
  ${boldAbnormal ? "font-weight: 700 !important;" : ""}
  ${abnormalDecoration}
}

.basic-report-template .val.low,
.basic-report-template .val.critical_low,
.basic-report-template .val.critical_l,
.basic-report-template .val.L,
.basic-report-template .val.Low {
  color: ${lowColor} !important;
  ${boldAbnormal ? "font-weight: 700 !important;" : ""}
  ${abnormalDecoration}
}

.basic-report-template .main-group-row td {
  padding: 8px 0 5px 0 !important;
  border: none !important;
}

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
  ${sectionHeaderInline ? `border-bottom: 0.5px solid #ccc !important; background-color: ${sectionRowBackground} !important;` : ""}
}

.basic-report-template .sub-section-col-header td {
  border-bottom: 1px solid #999 !important;
  background-color: ${resultTableBackground} !important;
  color: #333 !important;
}

.basic-report-template .descriptive-row td {
  border-bottom: 0.5px dotted #e5e5e5 !important;
  color: #111 !important;
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

.basic-report-template .report-sections {
  margin-top: 14px !important;
  border-top: 1px solid #000 !important;
  padding-top: 6px !important;
}

.basic-report-template .narrative-panel {
  margin: 0 0 ${testGroupSpacing}px !important;
  border-top: 1.5px solid #000 !important;
  border-bottom: 1px solid #d1d5db !important;
  padding: 8px 0 10px !important;
}

.basic-report-template .narrative-panel .center-title {
  margin-top: 0 !important;
}

.basic-report-template .narrative-body {
  margin-top: 8px !important;
  font-size: ${basePx}px !important;
  line-height: 1.55 !important;
  color: #111 !important;
}

.basic-report-template .narrative-kv-row {
  display: grid !important;
  grid-template-columns: ${sectionFieldNamePct}% 1fr !important;
  gap: 10px !important;
  padding: 6px 0 !important;
  border-bottom: 0.5px dotted #d1d5db !important;
}

.basic-report-template .narrative-kv-label {
  font-weight: 700 !important;
  color: #111 !important;
}

.basic-report-template .narrative-kv-value {
  color: #111 !important;
}

.basic-report-template .narrative-body p {
  margin: 0 0 8px !important;
}

.basic-report-template .narrative-body ul {
  margin: 0 !important;
  padding-left: 18px !important;
}

.basic-report-template .narrative-body li {
  margin-bottom: 4px !important;
}

.basic-report-template .narrative-section-heading {
  font-weight: 700 !important;
  text-transform: uppercase !important;
  font-size: ${basePx + 1}px !important;
  padding: 10px 0 4px !important;
  border-bottom: 0.5px solid #bbb !important;
  margin-top: 8px !important;
  letter-spacing: 0.02em !important;
  color: #000 !important;
}

.basic-report-template .narrative-para {
  margin: 3px 0 6px !important;
  line-height: 1.55 !important;
}

.basic-report-template .report-disclaimer {
  margin-top: 10px !important;
  padding-top: 6px !important;
  border-top: 0.5px solid #bbb !important;
  font-size: ${smallPx}px !important;
  color: #444 !important;
  font-style: italic !important;
  line-height: 1.4 !important;
  page-break-inside: avoid !important;
}

.basic-report-template .report-footer {
  margin-top: auto !important;  /* pushes footer to bottom of available page space */
  padding-top: 30px !important; /* minimum breathing room above footer */
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
}

.basic-report-template .signature-box {
  text-align: right !important;
}

.basic-report-template .tbl-results th:last-child,
.basic-report-template .tbl-results td:last-child {
  display: table-cell !important;
}

@media print {
  .basic-report-template {
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  .basic-report-template .tbl-results thead th {
    border-top: 1.4px solid #000 !important;
    border-bottom: 1.4px solid #000 !important;
  }

  .basic-report-template .tbl-results tbody tr:not(.main-group-row):not(.sub-section-header):not(.interpretation-row):not(.descriptive-row) td {
    border-bottom: 0.4px dotted #e2e2e2 !important;
  }
}
</style>`;

  // Scope CSS to this specific test group so per-group font sizes don't bleed into other groups.
  // Without scoping, the last injected <style> block (which uses the same global `.basic-report-template`
  // class name) wins the CSS cascade and overrides all previous groups' font sizes.
  const scopedCss = groupId
    ? noColorCss.replace(/\.basic-report-template/g, `[data-test-group-id="${groupId}"] .basic-report-template`)
    : noColorCss;

  // The bar only renders when it still has content: the title, the barcode, or a
  // top-positioned QR slot. With all three off the report starts at the patient block.
  const titleBarHasQrSlot = qrPosition === "top_left" || qrPosition === "top_right";
  const reportTitleBarHtml = (!showReportTitle && !showHeaderBarcode && !titleBarHasQrSlot)
    ? ""
    : `
    <div class="report-title-bar">
      <div class="${qrPosition === "top_left" ? "qr-top-left-slot" : "report-title-spacer"}"></div>
      ${showReportTitle ? `<h2 class="report-main-title">TEST REPORT</h2>` : `<div style="flex:1;"></div>`}
      <div class="${qrPosition === "top_right" ? "qr-top-right-slot" : "report-title-barcode"}">
        ${showHeaderBarcode ? "{{barcode_image}}" : ""}
      </div>
    </div>
  `;

  const patientInfoHtml = (() => {
    // Build the field list from config, or use fallback defaults
    const configFields = patientInfoConfig
      ? patientInfoConfig.fields
          .map(key => {
            if (PATIENT_INFO_FIELD_MAP[key]) return { ...PATIENT_INFO_FIELD_MAP[key], key };
            if (key.startsWith('custom_')) {
              const found = extraFieldConfigs?.find(f => `custom_${f.field_key}` === key);
              const label = found ? found.label : key.replace(/^custom_/, '').replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase());
              return { label, placeholder: `{{${key}}}`, key };
            }
            return undefined;
          })
          .filter(Boolean) as Array<{ label: string; placeholder: string; key: string }>
      : null;

    if (configFields && configFields.length > 0) {
      // Combine age + gender into a single "Age / Sex" field when both are present
      const ageIdx = configFields.findIndex(f => f.key === 'age');
      const genderIdx = configFields.findIndex(f => f.key === 'gender');
      if (ageIdx >= 0 && genderIdx >= 0) {
        configFields[ageIdx] = { label: 'Age / Sex', placeholder: '{{patientAgeFormatted}} / {{patientGender}}', key: 'ageGender' };
        configFields.splice(genderIdx > ageIdx ? genderIdx : ageIdx + 1, 1);
      }

      const rows: string[] = [];
      for (let i = 0; i < configFields.length; i += 2) {
        const f1 = configFields[i];
        const f2 = configFields[i + 1];
        rows.push(`<tr>
          <th>${f1.label}</th><td>: ${f1.placeholder}</td>
          ${f2 ? `<th>${f2.label}</th><td>: ${f2.placeholder}</td>` : `<th></th><td></td>`}
        </tr>`);
      }
      return `
      <figure class="table" style="margin:0;">
        <table class="patient-header-table">
          <tbody>${rows.join('')}</tbody>
        </table>
      </figure>`;
    }

    // Default fallback when no config
    return `
    <figure class="table" style="margin:0;">
      <table class="patient-header-table">
        <tbody>
          <tr>
            <th>Name</th><td>: {{patientName}}</td>
            <th>Reg. No</th><td>: {{patientId}}</td>
          </tr>
          <tr>
            <th>Age / Sex</th><td>: {{patientAgeFormatted}} / {{patientGender}}</td>
            <th>Reg. Date</th><td>: {{orderDate}}</td>
          </tr>
          <tr>
            <th>Ref. By</th><td>: {{referringDoctorBlock}}</td>
            <th>Report Date</th><td>: {{reportDate}}</td>
          </tr>
        </tbody>
      </table>
    </figure>`;
  })();

  let testResultsHtml = '<div class="test-results">';

  // â”€â”€ Narrative helpers (scoped to this function) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const _stripMd = (v: string) =>
    v.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/^(\*\*+)\s*/gm, "").replace(/\s*(\*\*+)$/gm, "").trim();
  const _escHtml = (v: string) =>
    v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const _fmtNarrative = (raw: string): string => {
    const t = raw.trim();
    if (!t) return "";
    if (/<[a-z][\s\S]*>/i.test(t)) return t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    const lines = t.replace(/\r\n/g, "\n").split("\n").map((l: string) => _stripMd(l)).filter(Boolean);
    const parts: string[] = [];
    let lis: string[] = [];
    const flush = () => { if (lis.length) { parts.push(`<ul>${lis.join("")}</ul>`); lis = []; } };
    for (const line of lines) {
      if (/^[-*â€¢]\s+/.test(line)) { lis.push(`<li>${_escHtml(line.replace(/^[-*â€¢]\s+/, "").trim())}</li>`); continue; }
      flush();
      const ci = line.indexOf(":");
      if (ci > 0 && ci < 60) {
        parts.push(`<div class="narrative-kv-row"><div class="narrative-kv-label">${_escHtml(line.slice(0, ci).trim())}</div><div class="narrative-kv-value">${_escHtml(line.slice(ci + 1).trim())}</div></div>`);
        continue;
      }
      parts.push(`<p>${_escHtml(line)}</p>`);
    }
    flush();
    return parts.join("");
  };
  // Per-group layout override, set via test_groups.print_options.forceTableLayout
  // (lab-level printOptions can set a default; the group value wins after merge):
  //   true  â†’ always render the TEST NAME / VALUE / UNITS / Bio. Ref. Interval table
  //   false â†’ always render the narrative key/value panel
  //   unset â†’ fall back to the auto-detect heuristic below
  const forceTableLayout = typeof printOptions?.forceTableLayout === "boolean"
    ? printOptions.forceTableLayout as boolean
    : null;

  const _isNarrativeGroup = (analytes: any[]): boolean => {
    if (forceTableLayout !== null) {
      console.log(`[basic-template] layout override: forceTableLayout=${forceTableLayout} -> ${forceTableLayout ? "table" : "narrative"} layout, heuristic skipped`);
      return !forceTableLayout;
    }
    if (!analytes.length) return false;
    const n = analytes.filter((a: any) => {
      const unit = String(a.unit || "").trim().toLowerCase();
      const ref = String(a.reference_range || "").trim();
      const vt = String(a.value_type || "").toLowerCase();
      return vt !== "qualitative" &&
        (!unit || ["n/a", "na", "-", "none", "not applicable"].includes(unit)) &&
        !/\d/.test(ref);
    }).length;
    return n > 0 && n / analytes.length >= 0.7;
  };
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  for (const [groupId, analytes] of analytesByGroup) {
    if (!analytes || analytes.length === 0) continue;

    const groupName = testGroupNames.get(groupId) || analytes[0]?.test_name || "Test Results";
    const hasCalcInGroup = analytes.some((a: { is_auto_calculated?: boolean; is_calculated?: boolean }) =>
      a.is_auto_calculated || a.is_calculated
    );
    let hasNumericInGroup = false;

    const specimenText = (printOptions as any)?._sampleType
      ? `<div class="center-subtitle">Specimen: ${(printOptions as any)._sampleType}</div>`
      : (analytes[0]?.specimen
        ? `<div class="center-subtitle">Specimen: ${analytes[0].specimen}</div>`
        : "");
    const conditionText = (printOptions as any)?._sampleCondition
      ? `<div class="center-subtitle">Condition: ${(printOptions as any)._sampleCondition}</div>`
      : "";

	    const groupTitleBelowHeaders = testGroupTitlePosition === "below_headers";
	    const groupTitleClass = testGroupTitlePosition === "above_headers_left" ? "center-title left" : "center-title";
	    const analyteById = new Map<string, any>();
	    const sameRowSiblingIds = new Set<string>();
	    let sameRowLinkCount = 0;
	    let sameRowSiblingLabel = "Absolute Count";
	    for (const analyte of analytes) {
	      for (const analyteId of getAnalyteIdentityIds(analyte)) {
	        analyteById.set(analyteId, analyte);
	      }
	    }
	    for (const analyte of analytes) {
	      const options = analyte.report_display_options || {};
	      const siblingId = String(options.sameRowSiblingAnalyteId || "").trim();
	      if (siblingId && analyteById.has(siblingId)) {
	        sameRowSiblingIds.add(siblingId);
	        sameRowLinkCount += 1;
	        if (options.sameRowSiblingLabel) sameRowSiblingLabel = String(options.sameRowSiblingLabel);
	      }
	    }
	    const hasSameRowSibling = sameRowLinkCount > 0;
	    const effectiveColCount = hasSameRowSibling ? 6 : colCount;
	    if (sameRowLinkCount > 0) {
	      console.log(`[basic-template] same-row sibling links applied for ${groupName}: ${sameRowLinkCount}`);
	    }

	    // Pre-compute which sections have siblings for section-level header labels
	    const sectionsWithSiblings = new Set<string | null>();
	    for (const analyte of analytes) {
	      const siblingId = String(analyte.report_display_options?.sameRowSiblingAnalyteId || "").trim();
	      if (siblingId && analyteById.has(siblingId)) {
	        sectionsWithSiblings.add(analyte.section_heading ?? null);
	      }
	    }

	    if (_isNarrativeGroup(analytes)) {
      const rowsHtml = analytes.map((analyte: any) => {
        const rawParam = String(analyte.parameter || analyte.name || analyte.test_name || "").trim();
        const rawValue = String(analyte.value ?? analyte.reference_range ?? "").trim();

        // Clean ** bold markers
        const param = _stripMd(rawParam);
        const value = _stripMd(rawValue.replace(/^\*\*\s*/, "").replace(/\s*\*\*$/, ""));

        if (!param && !value) return "";

        // Section header: parameter starts with ** and value is empty or just **
        const isSectionHeader =
          /^\*\*/.test(rawParam) && (!rawValue || /^\*\*\s*$/.test(rawValue));

        if (isSectionHeader) {
          return `<div class="narrative-section-heading">${_escHtml(param)}</div>`;
        }

        // Free-text paragraph: no ** prefix on parameter and no value
        if (!/^\*\*/.test(rawParam) && !value) {
          return `<p class="narrative-para">${_escHtml(param)}</p>`;
        }

        // Key-value pair
        return `
          <div class="narrative-kv-row">
            <div class="narrative-kv-label">${_escHtml(param)}</div>
            <div class="narrative-kv-value">${_fmtNarrative(value)}</div>
          </div>`;
      }).join("");

      const narrativeGroupInterpretation = groupInterpretations?.get(groupId) || analytes[0]?.groupInterpretation;
      testResultsHtml += `
        <section class="narrative-panel">
          <div class="${groupTitleClass}">${groupName}</div>
          ${specimenText}
          ${conditionText}
          <div class="narrative-body">${rowsHtml}</div>
          ${narrativeGroupInterpretation ? `<div class="limsv2-report group-interpretation" style="margin-top:8px;padding:6px 0;border-top:1px solid #ddd;font-size:inherit;">${narrativeGroupInterpretation}</div>` : ""}
        </section>
      `;
      continue;
    }

	    // Zig-zag guard for the VALUE column.
	    //
	    // A qualitative row with no unit and no reference range can be rendered as one
	    // colspan="3" cell that is LEFT-aligned, while every other row puts its value in
	    // the narrow VALUE column RIGHT-aligned. Deciding that per row makes the column
	    // stagger whenever a group mixes the two (e.g. Urine Routine, where only some
	    // analytes are tagged value_type='qualitative' but none carry units or ranges).
	    // Decide once per group instead, so every value lands on the same vertical line.
	    //
	    // The wide cell exists so sentence-length findings are not squeezed into the
	    // narrow VALUE column, so it is reserved for groups that actually have long
	    // values. Short qualitative results (Absent, Pale Yellow, Non Reactive) stay
	    // right-aligned in the VALUE column, lining up with the numeric groups.
	    const groupHasNoUnitsOrRefs = analytes.every((a: any) =>
	      !String(a.unit || "").trim() && !String(a.reference_range || "").trim()
	    );
	    const groupUsesWideQualitativeValues = groupHasNoUnitsOrRefs &&
	      analytes.some((a: any) => String(a.value ?? "").trim().length > LONG_QUALITATIVE_VALUE_CHARS);
	    console.log(`[basic-template] ${groupName}: VALUE column = ${groupUsesWideQualitativeValues ? "wide left-aligned (long text group)" : "right-aligned in VALUE column"}`);

	    const groupColumnHeaderHtml = `
	      <table class="tbl-results" style="width:100%; table-layout:fixed; border-collapse:collapse; margin-top:4px;">
	        <colgroup>
	          <col style="width:${formatBasicWidth(standardColumnWidths[0])}">
	          <col style="width:${formatBasicWidth(standardColumnWidths[1])}">
	          <col style="width:${formatBasicWidth(standardColumnWidths[2])}">
	          <col style="width:${formatBasicWidth(standardColumnWidths[3])}">
	        </colgroup>
	        <thead>
	          <tr>
	            <th style="border-top:1.5px solid #000; border-bottom:1.5px solid #000; font-weight:700; padding:4px; text-align:left;">TEST NAME</th>
	            <th style="border-top:1.5px solid #000; border-bottom:1.5px solid #000; font-weight:700; padding:4px; text-align:right;">VALUE</th>
	            <th style="border-top:1.5px solid #000; border-bottom:1.5px solid #000; font-weight:700; padding:4px; text-align:left;">UNITS</th>
	            <th style="border-top:1.5px solid #000; border-bottom:1.5px solid #000; font-weight:700; padding:4px; text-align:left;">Bio. Ref. Interval</th>
	          </tr>
	        </thead>
	        ${groupTitleBelowHeaders ? `
	        <tbody>
	          <tr class="main-group-row">
	            <td colspan="4">
	              <div class="${groupTitleClass}">${groupName}</div>
	              ${specimenText}
	              ${conditionText}
	            </td>
	          </tr>
	        </tbody>` : ""}
	      </table>
	    `;

	    // Group title and column labels render once per test group.
	    testResultsHtml += `
	      <figure class="table" style="margin: 0 0 ${testGroupSpacing}px;">
	        ${!groupTitleBelowHeaders ? `
	          <div class="${groupTitleClass}">${groupName}</div>
	          ${specimenText}
	          ${conditionText}
	        ` : ""}
	        ${groupColumnHeaderHtml}
	    `;

    const sectionBlocks = groupAnalytesBySectionHeading(analytes);
    let isFirstSection = true;

    for (const block of sectionBlocks) {
      const sectionHasSiblings = sectionsWithSiblings.has(block.heading);
      // Determine column structure for THIS section
	      const sectionColCount = sectionHasSiblings ? 6 : 4;
	      const sectionWidths = sectionHasSiblings
	        ? {
	            name: formatBasicWidth(siblingColumnWidths[0]),
	            value: formatBasicWidth(siblingColumnWidths[1]),
	            unit: formatBasicWidth(siblingColumnWidths[2]),
	            ref: formatBasicWidth(siblingColumnWidths[3]),
	            sibVal: formatBasicWidth(siblingColumnWidths[4]),
	            sibRef: formatBasicWidth(siblingColumnWidths[5]),
	          }
	        : {
	            name: formatBasicWidth(standardColumnWidths[0]),
	            value: formatBasicWidth(standardColumnWidths[1]),
	            unit: formatBasicWidth(standardColumnWidths[2]),
	            ref: formatBasicWidth(standardColumnWidths[3]),
	          };

      // Close previous table if not first section
      if (!isFirstSection) {
        testResultsHtml += `</tbody></table>`;
      }
      isFirstSection = false;

	      // Open new table with appropriate column widths for this section
	      testResultsHtml += `
	        <table class="tbl-results${sectionHasSiblings ? " has-sibling" : ""}" style="width:100%; table-layout:fixed; border-collapse:collapse; margin-top:${block.heading ? "0" : "4"}px;">
	          <colgroup>
	            <col style="width:${sectionWidths.name}">
	            <col style="width:${sectionWidths.value}">
	            <col style="width:${sectionWidths.unit}">
	            <col style="width:${sectionWidths.ref}">
	            ${sectionHasSiblings ? `<col style="width:${sectionWidths.sibVal}"><col style="width:${sectionWidths.sibRef}">` : ""}
	          </colgroup>
	          <tbody>
	      `;

	      // Add section header row if this section has a heading
	      if (block.heading) {
	        testResultsHtml += `
	          <tr class="sub-section-header">
	            ${sectionHasSiblings
	              ? `<td colspan="4" style="font-weight:700; padding-top:6px; padding-bottom:3px; text-transform:uppercase; font-size:${smallPx + 1}px; border-bottom:0.5px solid #ccc; background-color:#f5f5f5;">${block.heading}</td><td colspan="2" style="font-weight:700; padding-top:6px; padding-bottom:3px; text-align:center; text-decoration:underline; font-size:${smallPx + 1}px; border-bottom:0.5px solid #ccc; background-color:#f5f5f5;">${sameRowSiblingLabel}</td>`
	              : `<td colspan="${sectionColCount}" style="font-weight:700; padding-top:6px; padding-bottom:3px; text-transform:uppercase; font-size:${smallPx + 1}px; border-bottom:0.5px solid #ccc; background-color:#f5f5f5;">${block.heading}</td>`}
	          </tr>
	        `;
	      }

	      for (const analyte of block.analytes) {
		        const currentAnalyteIds = getAnalyteIdentityIds(analyte);
		        if (
		          currentAnalyteIds.some((id) => sameRowSiblingIds.has(id)) &&
		          analyte.report_display_options?.hiddenWhenRenderedAsSibling !== false
		        ) {
		          continue;
		        }

	        const parameterName = analyte.parameter || analyte.name || analyte.test_name || "";
        const isCalculated = analyte.is_auto_calculated || analyte.is_calculated;
        const rawValue = analyte.value ?? "";
        const value = formatAnalyteDisplayValue(
          analyte,
          printOptions,
          rawValue,
          formatIndianNumber,
        );
        const unit = analyte.unit || "";
        const refRange = (analyte.reference_range || "").replace(/\n/g, "<br>");
        const flag = analyte.flag || "";
        const normalizedFlag = normalizeReportFlag(flag);
        const canonicalFlag = normalizedFlag.canonical;
        const calcSuffix = isCalculated
          ? calcMarker === "asterisk"
            ? `<sup style="font-size:${smallPx - 1}px; color:#444; margin-left:1px;">*</sup>`
            : calcMarker === "cal"
            ? `<span style="font-size:${smallPx - 1}px; color:#888; margin-left:2px; font-style:italic;">*cal</span>`
            : ""
		          : "";

        const unitText = String(unit || "").trim().toLowerCase();
        const refText = String(refRange || "").trim();
        const hasNumericRef = /\d/.test(refText);
        const valueTypeRaw = String(analyte.value_type || "").toLowerCase();
        const isQualitativeRow = valueTypeRaw === "qualitative" && !unitText && !refText;
        // Wide cells are left-aligned, normal value cells are right-aligned, so the
        // choice is all-or-nothing per group (see groupUsesWideQualitativeValues above).
        const isQualitativeWithoutMetadata = groupUsesWideQualitativeValues;
        // Text value staying in the VALUE column: keep it right-aligned with the numeric
        // rows, but let it wrap rather than be clipped by the column's nowrap.
        const inlineQualitativeClass =
          !groupUsesWideQualitativeValues && (isQualitativeRow || groupHasNoUnitsOrRefs)
            ? " qualitative-inline-value"
            : "";
        const isDescriptive =
          valueTypeRaw !== "qualitative" &&
          (unitText === "n/a" || unitText === "na" || unitText === "-" ||
          unitText === "none" || unitText === "not applicable" ||
          (!unitText && refText && !hasNumericRef));

        if (!isDescriptive && valueTypeRaw !== "qualitative") hasNumericInGroup = true;

        const isNumericHigh = canonicalFlag === "high" || canonicalFlag === "critical_high";
        const isNumericLow = canonicalFlag === "low" || canonicalFlag === "critical_low";

        const asteriskSuffix = (printOptions?.flagAsterisk && (isNumericHigh || isNumericLow))
          ? (printOptions?.flagAsteriskCritical &&
              (canonicalFlag === "critical_high" || canonicalFlag === "critical_low")
              ? "***"
              : "**")
          : "";

        // Short flag symbol: H / L / A / H* / L*, limited to the letters the lab
        // configured in Settings → Result Flag Options.
        const flagSymbolText = flagSymbolForReport(canonicalFlag, allowedFlagCodes);

        // Flag sits directly beside the value (the whole pair right-aligns in the result
        // column), so the visible gap is exactly flagGapPx — not the leftover column width.
        const displayValue = flagSymbol === "before" && flagSymbolText
          ? `<span style="display:inline-block;font-weight:700;margin-right:${flagGapPx}px;">${flagSymbolText}</span>${value + asteriskSuffix}`
          : flagSymbol === "after" && flagSymbolText
          ? `${value + asteriskSuffix}<span style="display:inline-block;font-weight:700;margin-left:${flagGapPx}px;">${flagSymbolText}</span>`
          : value + asteriskSuffix;

        if (isDescriptive) {
          if (value && value.trim()) {
            testResultsHtml += `
              <tr class="descriptive-row">
                <td class="test-name-cell" style="font-size:${basePx}px;">
                  <div class="test-name" style="font-size:${basePx}px; font-weight:${testNameWeight};">${parameterName}${calcSuffix}</div>
                </td>
                <td class="val" style="font-size:${basePx}px; text-align:right;">${value}</td>
                <td style="font-size:${basePx}px;"></td>
	                <td style="font-size:${basePx}px; color:#666;">${refText || ""}</td>
	                ${sectionHasSiblings ? `<td></td><td></td>` : ""}
	              </tr>
	            `;
	          } else {
	            testResultsHtml += `
	              <tr class="descriptive-row">
	                <td colspan="${sectionColCount}" style="font-size: ${basePx}px;">
	                  <span style="font-weight:600;">${parameterName}</span>: ${refText || ""}
	                </td>
              </tr>
            `;
          }
          continue;
        }

	        const valClass = canonicalFlag ? `val ${canonicalFlag}` : "val";
	        const visibleFlagRowClass = flagSymbolText
	          ? `has-visible-flag flag-${canonicalFlag}`
	          : "";
		        const siblingId = String(analyte.report_display_options?.sameRowSiblingAnalyteId || "").trim();
	        const siblingAnalyte = siblingId ? analyteById.get(siblingId) : null;
	        const siblingValueHtml = siblingAnalyte
	          ? (() => {
	              const siblingRawValue = siblingAnalyte.value ?? "";
	              const siblingValue = formatAnalyteDisplayValue(
	                siblingAnalyte,
	                printOptions,
	                siblingRawValue,
	                formatIndianNumber,
	              );
		              const siblingUnit = siblingAnalyte.unit || "";
		              if (!siblingValue && !siblingUnit) return "";
		              const siblingFlag = normalizeReportFlag(siblingAnalyte.flag || "").canonical;
		              const siblingClass = siblingFlag ? `val ${siblingFlag}` : "val";
		              return `
		                <span class="same-row-sibling">
		                  <span class="${siblingClass}">${siblingValue}</span>
		                  ${siblingUnit ? `<span class="same-row-sibling-unit">${siblingUnit}</span>` : ""}
		                </span>
		              `;
		            })()
	          : "";
	        const siblingRefHtml = siblingAnalyte
	          ? (() => {
		              const siblingRefRange = (siblingAnalyte.reference_range || "").replace(/\n/g, "<br>");
		              if (!siblingRefRange) return "";
		              return `<span class="same-row-sibling-ref">${siblingRefRange}</span>`;
		            })()
	          : "";

	        // Each section now has its own table with correct column structure
	        if (sectionHasSiblings) {
	          // 6-column layout for sibling sections
	          testResultsHtml += `
	              <tr class="${visibleFlagRowClass}">
                <td class="test-name-cell">
                  <div class="test-name" style="font-size:${basePx}px; font-weight:${testNameWeight};">
                    ${parameterName}${calcSuffix}
                  </div>
                  ${showMethodology && analyte.method
                    ? `<div class="test-method">${analyte.method}</div>`
                    : ""}
	                </td>
	                <td class="${valClass}" style="text-align:right;">${displayValue}</td>
		                <td style="text-align:left; vertical-align:top; font-size:${basePx}px; color:#444;">${unit}</td>
		                <td style="text-align:left; vertical-align:top; font-size:${smallPx + 1}px; color:#666;">${refRange}</td>
		                <td style="text-align:right; vertical-align:top;">${siblingValueHtml}</td>
		                <td style="text-align:left; vertical-align:top; font-size:${smallPx + 1}px; color:#666;">${siblingRefHtml}</td>
		              </tr>
		        `;
	        } else {
	          // 4-column layout for non-sibling sections
	          testResultsHtml += `
	              <tr class="${[
	                isQualitativeWithoutMetadata ? "qualitative-wide-row" : "",
	                visibleFlagRowClass,
	              ].filter(Boolean).join(" ")}">
                <td class="test-name-cell">
                  <div class="test-name" style="font-size:${basePx}px; font-weight:${testNameWeight};">
                    ${parameterName}${calcSuffix}
                  </div>
                  ${showMethodology && analyte.method
                    ? `<div class="test-method">${analyte.method}</div>`
                    : ""}
	                </td>
	                ${isQualitativeWithoutMetadata
	                  ? `<td class="${valClass} qualitative-wide-value" colspan="3">${displayValue}</td>`
	                  : `<td class="${valClass}${inlineQualitativeClass}" style="text-align:right;">${displayValue}</td>
		                <td style="text-align:left; vertical-align:top; font-size:${basePx}px; color:#444;">${unit}</td>
		                <td style="text-align:left; vertical-align:top; font-size:${smallPx + 1}px; color:#666;">${refRange}</td>`}
		              </tr>
		        `;
	        }

        if (showInterpretation) {
          let interp = "";
          if (isNumericHigh) interp = analyte.interpretation_high || "";
          else if (isNumericLow) interp = analyte.interpretation_low || "";
          else interp = analyte.interpretation_normal || "";

          if (interp) {
	            testResultsHtml += `
	              <tr class="interpretation-row">
	                <td colspan="${sectionColCount}">${interp}</td>
	              </tr>
	            `;
          }
        }
      }
    }

    const _basicGroupInterp = groupInterpretations?.get(groupId);
    testResultsHtml += `
          </tbody>
        </table>
        ${(() => {
          const parts: string[] = [];
          if (hasCalcInGroup && calcMarker === "asterisk") parts.push("* Calculated parameter");
          if (printOptions?.flagAsterisk) parts.push("** Abnormal value");
          if (printOptions?.flagAsterisk && printOptions?.flagAsteriskCritical) parts.push("*** Critical value");
          if (showFlagLegend && flagSymbol !== "none" && hasNumericInGroup) {
            // Legend lists only the letters this report can actually print.
            const legend = flagLegendText(allowedFlagCodes);
            if (legend) parts.push(legend);
          }
          return parts.length ? `<p class="calculated-note">${parts.join(" &nbsp;|&nbsp; ")}</p>` : "";
        })()}
        ${_basicGroupInterp ? `<div class="limsv2-report group-interpretation" style="margin-top:8px;padding:6px 0;border-top:1px solid #ddd;font-size:inherit;">${_basicGroupInterp}</div>` : ''}
      </figure>
    `;
  }

  testResultsHtml += "</div>";

  const sigName = formatSignatureNameForPdf(signatoryInfo?.signatoryName || "");
  const sigDesignation = signatoryInfo?.signatoryDesignation || "";
  const sigImageUrl = signatoryInfo?.signatoryImageUrl || "";
  const signatureSize = resolveSignatureImageSize(printOptions);

  const escapeDisclaimer = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br />");
  const disclaimerHtml = (showReportDisclaimer && reportDisclaimerText)
    ? `<div class="report-disclaimer">${escapeDisclaimer(reportDisclaimerText)}</div>`
    : "";

  const _basicSigList = getReportSignatories(signatoryInfo);
  const signatoryHtml = (() => {
    // Single signature: keep the exact original markup (backward compatible)
    if (_basicSigList.length <= 1) {
      return `
    <div class="report-footer">
      <div class="auth-text">Authenticated Electronic Report</div>
      <div class="signature-box">
        ${sigImageUrl
          ? `<img src="${sigImageUrl}" alt="" style="max-height: ${signatureSize.maxHeight}px; max-width: ${signatureSize.maxWidth}px; width: auto; height: auto; object-fit: contain; margin-bottom: 4px; display: block; margin-left: auto;" onerror="this.style.display='none'" />`
          : ""}
        ${sigName ? `<div style="font-weight:700; font-size:${sigPx}px;">${sigName}</div>` : ""}
        ${sigDesignation ? `<div style="font-size:${basePx - 1}px; margin-top:2px;">${sigDesignation}</div>` : ""}
      </div>
    </div>
  `;
    }
    // Multiple signatures: render side-by-side boxes, scaled down to fit
    const n = _basicSigList.length;
    const maxH = Math.min(signatureSize.maxHeight, n >= 3 ? 48 : 54);
    const maxW = Math.min(signatureSize.maxWidth, n >= 3 ? 120 : 145);
    const namePx = Math.max(9, sigPx - (n >= 3 ? 1 : 0));
    const boxes = _basicSigList.map((s) => {
      const nm = formatSignatureNameForPdf(s?.signatoryName || "");
      const dg = s?.signatoryDesignation || "";
      const img = s?.signatoryImageUrl || "";
      return `
        <div style="text-align:center; flex:0 1 auto;">
          ${img
            ? `<img src="${img}" alt="" style="max-height:${maxH}px; max-width:${maxW}px; width:auto; height:auto; object-fit:contain; margin:0 auto 4px; display:block;" onerror="this.style.display='none'" />`
            : ""}
          ${nm ? `<div style="font-weight:700; font-size:${namePx}px; line-height:1.18;">${nm}</div>` : ""}
          ${dg ? `<div style="font-size:${basePx - 2}px; margin-top:2px; line-height:1.15;">${dg}</div>` : ""}
        </div>`;
    }).join("");
    return `
    <div class="report-footer">
      <div class="auth-text">Authenticated Electronic Report</div>
      <div class="signature-box" style="display:flex; gap:16px; align-items:flex-end; justify-content:flex-end; text-align:center;">
        ${boxes}
      </div>
    </div>
  `;
  })();

  const buildSectionLabel = (key: string) => {
    if (sectionLabels?.[key]) return sectionLabels[key];
    const { rawKey } = normalizeSectionKey(key);
    if (!rawKey) return "Report Section";
    return rawKey
      .replace(/[_-]+/g, " ")
      .split(" ")
      .filter(Boolean)
      .map((part: string) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join(" ");
  };

  let reportSectionsHtml = "";
  if (includeSections && Object.keys(normalizedSectionContent).length > 0) {
    const sectionTables = Object.entries(normalizedSectionContent)
      .filter(([, content]) => content && String(content).trim().length > 0)
      .map(([key, content]) => {
        const rawContent = String(content).trim();
        if (!rawContent) return "";
        const label = (sectionLabels && sectionLabels[key]) ? sectionLabels[key] : buildSectionLabel(key);

        // If content contains a real <table>, render as standalone rich HTML block
        // to protect inner table borders from the basic template's border:none resets.
        // Simple <div>-wrapped text (e.g. from Survey.js) is NOT rich â€” render in columns.
        const isRichHtml = /<table\b/i.test(rawContent);
        if (isRichHtml) {
          return `
            <div class="section-rich-content" style="margin: 8px 0 14px;">
              <div class="center-title" style="text-align:center;font-weight:700;text-decoration:underline;font-size:${basePx + 1}px;margin:8px 0 6px;text-transform:uppercase;color:#000;">${label}</div>
              <div style="font-size:${basePx}px;">${rawContent}</div>
            </div>
          `;
        }

        return `
          <section class="narrative-panel">
            <div class="center-title">${label}</div>
            <div class="narrative-body">${_fmtNarrative(rawContent)}</div>
          </section>
        `;
      })
      .filter(Boolean)
      .join("");

    if (sectionTables) {
      reportSectionsHtml = sectionTables;
    }
  }

  const innerHtml = `
    ${scopedCss}
    <div class="basic-report-template" style="font-family: Arial, Helvetica, sans-serif; font-size: ${basePx}px; color: #000;">
      ${printOptions?._suppressPatientHeader ? '' : reportTitleBarHtml}
      ${printOptions?._suppressPatientHeader ? '' : patientInfoHtml}
      ${printOptions?._suppressPatientHeader ? '' : '<div class="patient-test-separator"></div>'}
      ${testResultsHtml}
      ${reportSectionsHtml}
      ${printOptions?._suppressSignature ? '' : disclaimerHtml}
      ${printOptions?._suppressSignature ? '' : signatoryHtml}
    </div>
  `;
  // The scoped CSS uses [data-test-group-id="..."] .basic-report-template selectors.
  // We must wrap the output in a matching parent element so the selectors actually apply.
  return groupId
    ? `<div data-test-group-id="${groupId}">${innerHtml}</div>`
    : innerHtml;
}

/**
 * Generate default template HTML when no custom template is found.
 *
 * Supports three styles controlled by lab setting `default_template_style`:
 *   - "beautiful" (default): 3-band color matrix with colored cells
 *   - "classic": Plain table with flag text styling
 *   - "basic": Old-school, no colours, bold H/L prefix on abnormal values
 */
function generateDefaultTemplateHtml(
  context: any,
  testGroupNames: Map<string, string>,
  analytesByGroup: Map<string, any[]>,
  signatoryInfo: any,
  sectionContent?: Record<string, string>,
  includeSections = true,
  templateStyle: 'beautiful' | 'classic' | 'basic' = 'beautiful',
  showMethodology = true,
  showInterpretation = false,
  patientInfoConfig?: PatientInfoConfig | null,
  printOptions?: Record<string, unknown>,
  extraFieldConfigs?: Array<{ field_key: string; label: string }>,
  groupId?: string,
  groupInterpretations?: Map<string, string>,
  sectionLabels?: Record<string, string>,
): string {
  // Branch to classic template if requested
  if (templateStyle === 'classic') {
    return generateClassicDefaultTemplateHtml(
      context, testGroupNames, analytesByGroup, signatoryInfo,
      sectionContent, includeSections, showMethodology, showInterpretation,
      patientInfoConfig, printOptions, extraFieldConfigs, groupInterpretations,
      sectionLabels,
    );
  }

	  // Branch to basic (old-school) template if requested
	  if (templateStyle === 'basic') {
	    console.log("[basic-template] rendering built-in basic template", {
	      groupId,
	      groups: analytesByGroup.size,
	      analytes: [...analytesByGroup.values()].reduce((count, rows) => count + rows.length, 0),
	    });
	    return generateBasicDefaultTemplateHtml(
      context, testGroupNames, analytesByGroup, signatoryInfo,
      sectionContent, includeSections, showMethodology, showInterpretation,
      patientInfoConfig, printOptions, extraFieldConfigs,
      groupId, groupInterpretations, sectionLabels,
    );
  }

  const _patient = context.patient || {};
  const _order = context.order || {};
  const normalizedSectionContent =
    sectionContent && typeof sectionContent === "object" ? sectionContent : {};

  // â”€â”€ Theme colors â”€â”€
  const THEME = {
    accent: "#5a7f3a",
    normalBg: "#4a8c4a", normalText: "#ffffff",
    borderlineBg: "#d4a84b", borderlineText: "#1f1f1f",
    abnormalBg: "#c45454", abnormalText: "#ffffff",
    headerBg: "#e8efe4", headerText: "#374151",
  };

  // â”€â”€ Helper: classify a numeric value against structured ranges â”€â”€
  function classifyValue(
    numVal: number,
    analyte: any,
  ): { column: 1 | 2 | 3; semantic: "good" | "borderline" | "bad" } | null {
    const minVal = analyte.normal_range_min != null
      ? Number(analyte.normal_range_min)
      : null;
    const maxVal = analyte.normal_range_max != null
      ? Number(analyte.normal_range_max)
      : null;

    if (minVal !== null && maxVal !== null && !isNaN(minVal) && !isNaN(maxVal)) {
      if (numVal < minVal) return { column: 1, semantic: "bad" };
      if (numVal > maxVal) return { column: 3, semantic: "bad" };
      return { column: 2, semantic: "good" };
    }

    // Fallback: try parsing text reference_range "10 - 20" style
    const refText = String(analyte.reference_range || "").trim();
    const rangeMatch = refText.match(/([\d.]+)\s*[-â€“]\s*([\d.]+)/);
    if (rangeMatch) {
      const lo = parseFloat(rangeMatch[1]);
      const hi = parseFloat(rangeMatch[2]);
      if (!isNaN(lo) && !isNaN(hi)) {
        if (numVal < lo) return { column: 1, semantic: "bad" };
        if (numVal > hi) return { column: 3, semantic: "bad" };
        return { column: 2, semantic: "good" };
      }
    }

    // One-sided upper limit: "< X" or "â‰¤ X" (e.g. Total Cholesterol < 200)
    const upperMatch = refText.match(/^[<â‰¤]\s*([\d.]+)/);
    if (upperMatch) {
      const hi = parseFloat(upperMatch[1]);
      if (!isNaN(hi)) {
        if (numVal <= hi) return { column: 2, semantic: "good" };
        return { column: 3, semantic: "bad" };
      }
    }

    // One-sided lower limit: "> X" or "â‰¥ X" (e.g. HDL > 40)
    const lowerMatch = refText.match(/^[>â‰¥]\s*([\d.]+)/);
    if (lowerMatch) {
      const lo = parseFloat(lowerMatch[1]);
      if (!isNaN(lo)) {
        if (numVal >= lo) return { column: 2, semantic: "good" };
        return { column: 1, semantic: "bad" };
      }
    }

    return null; // no structured range available
  }

  // â”€â”€ Helper: get color by semantic â”€â”€
  function getColor(semantic: "good" | "borderline" | "bad") {
    switch (semantic) {
      case "good": return { bg: THEME.normalBg, text: THEME.normalText };
      case "borderline": return { bg: THEME.borderlineBg, text: THEME.borderlineText };
      case "bad": return { bg: THEME.abnormalBg, text: THEME.abnormalText };
    }
  }

  // â”€â”€ Helper: format reference range text for a column position â”€â”€
  function formatRefForColumn(
    analyte: any,
    position: 1 | 2 | 3,
  ): string {
    const minVal = analyte.normal_range_min != null
      ? Number(analyte.normal_range_min)
      : null;
    const maxVal = analyte.normal_range_max != null
      ? Number(analyte.normal_range_max)
      : null;

    if (minVal !== null && maxVal !== null && !isNaN(minVal) && !isNaN(maxVal)) {
      if (position === 1) return `< ${minVal}`;
      if (position === 2) return `${minVal} â€“ ${maxVal}`;
      return `> ${maxVal}`;
    }

    // Fallback: parse text reference_range
    const refText = String(analyte.reference_range || "").trim();
    const rangeMatch = refText.match(/([\d.]+)\s*[-â€“]\s*([\d.]+)/);
    if (rangeMatch) {
      const lo = rangeMatch[1];
      const hi = rangeMatch[2];
      if (position === 1) return `< ${lo}`;
      if (position === 2) return `${lo} â€“ ${hi}`;
      return `> ${hi}`;
    }

    // One-sided upper limit: "< X" â€” LOW col empty, NORMAL = "< X", HIGH = "> X"
    const upperMatch = refText.match(/^[<â‰¤]\s*([\d.]+)/);
    if (upperMatch) {
      if (position === 1) return "";
      if (position === 2) return `< ${upperMatch[1]}`;
      return `> ${upperMatch[1]}`;
    }

    // One-sided lower limit: "> X" â€” LOW = "< X", NORMAL = "> X", HIGH col empty
    const lowerMatch = refText.match(/^[>â‰¥]\s*([\d.]+)/);
    if (lowerMatch) {
      if (position === 1) return `< ${lowerMatch[1]}`;
      if (position === 2) return `> ${lowerMatch[1]}`;
      return "";
    }

    if (position === 2) return refText || "";
    return "";
  }

  // â”€â”€ Helper: check if analyte has structured numeric range â”€â”€
  function hasStructuredRange(analyte: any): boolean {
    if (
      analyte.normal_range_min != null && analyte.normal_range_max != null
    ) return true;
    const refText = String(analyte.reference_range || "").trim();
    // Two-sided: "10 - 20"
    if (/[\d.]+\s*[-â€“]\s*[\d.]+/.test(refText)) return true;
    // One-sided: "< 200" or "> 40"
    if (/^[<>â‰¤â‰¥]\s*[\d.]+/.test(refText)) return true;
    return false;
  }

  // â”€â”€ Helper: check if value is numeric â”€â”€
  function isNumericValue(val: any): boolean {
    if (val == null || val === "") return false;
    const str = String(val).trim();
    return /^[<>â‰¤â‰¥]?\s*[\d.]+$/.test(str);
  }

  function extractNumericVal(val: any): number | null {
    if (val == null || val === "") return null;
    const str = String(val).trim();
    const m = str.match(/([\d.]+)/);
    return m ? parseFloat(m[1]) : null;
  }

  // â”€â”€ Helper: check if analyte is descriptive (should be shown as full-width row) â”€â”€
  function isDescriptiveAnalyte(analyte: any): boolean {
    const unitText = String(analyte.unit || "").trim().toLowerCase();
    const refText = String(analyte.reference_range || "").trim();
    const hasNumericRef = /\d/.test(refText);
    const vt = String(analyte.value_type || "").toLowerCase();

    return (
      vt === "descriptive" ||
      unitText === "n/a" || unitText === "na" || unitText === "-" ||
      unitText === "none" || unitText === "not applicable" ||
      (!unitText && !!refText && !hasNumericRef && vt !== "numeric")
    );
  }

  // â”€â”€ Helper: get flag display + color for flat table badge â”€â”€
  function getFlagBadge(flag: string): { text: string; bg: string } {
    const normalized = normalizeReportFlag(flag);

    if (normalized.canonical === "high" || normalized.canonical === "critical_high") {
      return { text: normalized.label.toUpperCase(), bg: THEME.abnormalBg };
    }
    if (normalized.canonical === "low" || normalized.canonical === "critical_low") {
      return { text: normalized.label.toUpperCase(), bg: "#ea580c" };
    }
    if (normalized.canonical === "normal") {
      return { text: "NORMAL", bg: THEME.normalBg };
    }
    if (normalized.canonical === "abnormal") {
      return { text: "ABNORMAL", bg: THEME.abnormalBg };
    }
    if (normalized.canonical === "critical") {
      return { text: "CRITICAL", bg: "#7c2d12" };
    }
    return { text: (normalized.label || flag || "").toUpperCase(), bg: "#6b7280" };
  }

  // â”€â”€ Patient Information Section â”€â”€
  const patientInfoHtml = patientInfoConfig
    ? buildPatientInfoHtml(patientInfoConfig, THEME.accent, extraFieldConfigs)
    : `
    <div class="patient-info" style="margin-bottom: 16px; padding: 12px 16px; background: #ffffff; border: 1px solid #d1d5db; border-radius: 4px; page-break-inside: avoid;">
      <div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px;">
        <div style="font-size: 16px; font-weight: 700; color: ${THEME.accent};">
          {{patientName}}
        </div>
        <div style="font-size: 11px; color: #6b7280;">
          {{approvedAtFormatted}}
        </div>
      </div>
      <div style="display: flex; flex-wrap: wrap; gap: 12px; font-size: 12px; color: #374151;">
        <span><strong>Patient ID:</strong> {{patientId}}</span>
        <span><strong>Age:</strong> {{patientAgeFormatted}}</span>
        <span><strong>Gender:</strong> {{patientGender}}</span>
        <span><strong>Physician:</strong> {{referringDoctorName}}</span>
        <span><strong>Collected:</strong> {{collectionDate}}</span>
        <span><strong>Sample ID:</strong> {{sampleId}}</span>
      </div>
    </div>
  `;

  // â”€â”€ Test Results Section - group by test group â”€â”€
  let testResultsHtml = '<div class="test-results">';

  for (const [groupId, analytes] of analytesByGroup) {
    if (!analytes || analytes.length === 0) continue;

    const groupName = testGroupNames.get(groupId) || analytes[0]?.test_name ||
      "Test Results";

    // Separate analytes into categories (sorted by sort_order first)
    const sortedAnalytes = groupAnalytesBySectionHeading(analytes).flatMap(b => b.analytes);
    const colorMatrixAnalytes: any[] = [];
    const flatTableAnalytes: any[] = [];
    const descriptiveAnalytes: any[] = [];

    for (const analyte of sortedAnalytes) {
      if (isDescriptiveAnalyte(analyte)) {
        descriptiveAnalytes.push(analyte);
      } else if (isNumericValue(analyte.value) && hasStructuredRange(analyte)) {
        colorMatrixAnalytes.push(analyte);
      } else {
        flatTableAnalytes.push(analyte);
      }
    }

    testResultsHtml += `
      <div class="test-group-section" style="margin-bottom: 20px; page-break-inside: auto;">
        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 10px; padding-bottom: 6px; border-bottom: 2px solid ${THEME.accent};">
          <h3 style="font-size: 18px; font-weight: 600; color: ${THEME.accent}; margin: 0;">${groupName}</h3>
          ${(printOptions as any)?._sampleType ? `<span style="font-size:11px;color:#6b7280;font-style:italic;">Â· Specimen: ${(printOptions as any)._sampleType}</span>` : ''}
          ${(printOptions as any)?._sampleCondition ? `<span style="font-size:11px;color:#6b7280;font-style:italic;">Â· Condition: ${(printOptions as any)._sampleCondition}</span>` : ''}
        </div>
    `;

    // â”€â”€ 3-Band Color Matrix Table (for numeric analytes with structured ranges) â”€â”€
    if (colorMatrixAnalytes.length > 0) {
      testResultsHtml += `
        <table style="width: 100%; border-collapse: collapse; font-size: 13px; background: #ffffff; -webkit-print-color-adjust: exact; print-color-adjust: exact; margin-bottom: 12px;">
          <thead>
            <tr>
              <th style="text-align: left; padding: 8px 12px; border: 1px solid #d1d5db; width: 180px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.03em; color: ${THEME.headerText}; background-color: ${THEME.headerBg}; -webkit-print-color-adjust: exact; print-color-adjust: exact;">Test Name</th>
              <th style="text-align: center; padding: 8px 12px; border: 1px solid #d1d5db; width: 130px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.03em; color: ${THEME.headerText}; background-color: ${THEME.headerBg}; -webkit-print-color-adjust: exact; print-color-adjust: exact;">Low</th>
              <th style="text-align: center; padding: 8px 12px; border: 1px solid #d1d5db; width: 130px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.03em; color: ${THEME.headerText}; background-color: ${THEME.headerBg}; -webkit-print-color-adjust: exact; print-color-adjust: exact;">Normal</th>
              <th style="text-align: center; padding: 8px 12px; border: 1px solid #d1d5db; width: 130px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.03em; color: ${THEME.headerText}; background-color: ${THEME.headerBg}; -webkit-print-color-adjust: exact; print-color-adjust: exact;">High</th>
            </tr>
          </thead>
          <tbody>
      `;

      for (const cmBlock of groupAnalytesBySectionHeading(colorMatrixAnalytes)) {
        if (cmBlock.heading) {
          testResultsHtml += `
              <tr>
                <td colspan="4" style="padding: 6px 12px; background: #f1f5f9; font-weight: 600; font-size: 11px; color: #374151; border: 1px solid #e5e7eb;">${cmBlock.heading}</td>
              </tr>
          `;
        }
        for (const analyte of cmBlock.analytes) {
          const paramName = analyte.parameter || analyte.name || analyte.test_name || "";
          const value = analyte.value ?? "";
          const unitStr = analyte.unit || "";
          const method = analyte.method || "";
          const numVal = extractNumericVal(value);
          const classification = numVal !== null ? classifyValue(numVal, analyte) : null;

          const ref1 = formatRefForColumn(analyte, 1);
          const ref2 = formatRefForColumn(analyte, 2);
          const ref3 = formatRefForColumn(analyte, 3);

          const buildColorCell = (colNum: 1 | 2 | 3, refText: string) => {
            const isActive = classification?.column === colNum;
            if (isActive) {
              const color = getColor(classification!.semantic);
              return `
                <td style="padding: 6px; border: 1px solid #d1d5db; text-align: center; vertical-align: middle; background-color: ${color.bg}; -webkit-print-color-adjust: exact; print-color-adjust: exact;">
                  <div style="font-size: 15px; font-weight: 700; color: ${color.text};">${value}</div>
                  ${unitStr ? `<div style="font-size: 10px; color: ${color.text}; opacity: 0.85; margin-top: 1px;">${unitStr}</div>` : ""}
                  ${refText ? `<div style="font-size: 10px; color: ${color.text}; opacity: 0.85; margin-top: 2px;">${refText}</div>` : ""}
                </td>
              `;
            }
            return `
              <td style="padding: 6px; border: 1px solid #d1d5db; text-align: center; vertical-align: middle; background-color: transparent;">
                <div style="font-size: 10px; color: #6b7280;">${refText}</div>
              </td>
            `;
          };

          testResultsHtml += `
              <tr style="page-break-inside: avoid;">
                <td style="font-weight: 600; padding: 10px 12px; border: 1px solid #d1d5db; color: #1f2937; width: 180px;">
                  ${paramName}${(analyte.is_auto_calculated || analyte.is_calculated) ? '<sup style="font-size:8px;color:#6b7280;margin-left:2px;font-style:italic;">*calc</sup>' : ''}
                  ${showMethodology && method ? `<div style="font-size: 9px; color: #9ca3af; margin-top: 2px;">${method}</div>` : ""}
                </td>
                ${buildColorCell(1, ref1)}
                ${buildColorCell(2, ref2)}
                ${buildColorCell(3, ref3)}
              </tr>
          `;

          // Interpretation row (shown below the analyte row if enabled)
          if (showInterpretation) {
            const canonicalFlag = normalizeReportFlag(analyte.flag).canonical;
            let interpretationText = "";
            if (canonicalFlag === "high" || canonicalFlag === "critical_high") {
              interpretationText = analyte.interpretation_high || "";
            } else if (canonicalFlag === "low" || canonicalFlag === "critical_low") {
              interpretationText = analyte.interpretation_low || "";
            } else {
              interpretationText = analyte.interpretation_normal || "";
            }
            if (interpretationText) {
              testResultsHtml += `
              <tr style="page-break-inside: avoid;">
                <td colspan="4" style="padding: 4px 12px 8px 24px; border: 1px solid #d1d5db; border-top: none; font-size: 11px; color: #6b7280; font-style: italic;">
                  <strong>Interpretation:</strong> ${interpretationText}
                </td>
              </tr>
              `;
            }
          }
        } // end for analyte
      } // end for cmBlock

      testResultsHtml += `
          </tbody>
        </table>
        ${colorMatrixAnalytes.some((a: any) => a.is_auto_calculated || a.is_calculated) ? '<p style="font-size:9px;color:#9ca3af;margin:2px 0 8px;font-style:italic;">*calc â€“ Calculated parameter</p>' : ''}
      `;
    }

    // â”€â”€ Flat Table (for numeric analytes without structured ranges, or non-numeric) â”€â”€
    if (flatTableAnalytes.length > 0) {
      testResultsHtml += `
        <table class="report-table" style="width: 100%; border-collapse: collapse; font-size: 13px; background: #ffffff; margin-bottom: 12px;">
          <thead>
            <tr>
              <th style="text-align: left; padding: 8px 12px; border: 1px solid #d1d5db; font-size: 10px; text-transform: uppercase; letter-spacing: 0.03em; color: ${THEME.headerText}; background-color: ${THEME.headerBg}; -webkit-print-color-adjust: exact; print-color-adjust: exact;">Test</th>
              <th style="text-align: center; padding: 8px 12px; border: 1px solid #d1d5db; font-size: 10px; text-transform: uppercase; letter-spacing: 0.03em; color: ${THEME.headerText}; background-color: ${THEME.headerBg}; -webkit-print-color-adjust: exact; print-color-adjust: exact;">Result</th>
              <th style="text-align: center; padding: 8px 12px; border: 1px solid #d1d5db; font-size: 10px; text-transform: uppercase; letter-spacing: 0.03em; color: ${THEME.headerText}; background-color: ${THEME.headerBg}; -webkit-print-color-adjust: exact; print-color-adjust: exact;">Unit</th>
              <th style="text-align: center; padding: 8px 12px; border: 1px solid #d1d5db; font-size: 10px; text-transform: uppercase; letter-spacing: 0.03em; color: ${THEME.headerText}; background-color: ${THEME.headerBg}; -webkit-print-color-adjust: exact; print-color-adjust: exact;">Ref. Range</th>
              <th style="text-align: center; padding: 8px 12px; border: 1px solid #d1d5db; font-size: 10px; text-transform: uppercase; letter-spacing: 0.03em; color: ${THEME.headerText}; background-color: ${THEME.headerBg}; -webkit-print-color-adjust: exact; print-color-adjust: exact;">Flag</th>
            </tr>
          </thead>
          <tbody>
      `;

      for (const flatBlock of groupAnalytesBySectionHeading(flatTableAnalytes)) {
        if (flatBlock.heading) {
          testResultsHtml += `
              <tr>
                <td colspan="5" style="padding: 6px 12px; background: #f1f5f9; font-weight: 600; font-size: 11px; color: #374151; border: 1px solid #e5e7eb;">${flatBlock.heading}</td>
              </tr>
          `;
        }
        for (const analyte of flatBlock.analytes) {
          const paramName = analyte.parameter || analyte.name || analyte.test_name || "";
          const value = analyte.value ?? "";
          const unit = analyte.unit || "";
          const refRange = analyte.reference_range || "";
          const flag = analyte.flag || "";
          const method = analyte.method || "";
          const badge = getFlagBadge(flag);
          const canonicalFlag = normalizeReportFlag(flag).canonical;
          const isAbnormal = !!canonicalFlag && canonicalFlag !== "normal";

          testResultsHtml += `
              <tr style="page-break-inside: avoid;">
                <td style="padding: 8px 12px; border: 1px solid #d1d5db; font-weight: 600; color: #1f2937;">
                  ${paramName}${(analyte.is_auto_calculated || analyte.is_calculated) ? '<sup style="font-size:8px;color:#6b7280;margin-left:2px;font-style:italic;">*calc</sup>' : ''}
                  ${showMethodology && method ? `<div style="font-size: 9px; color: #9ca3af;">${method}</div>` : ""}
                </td>
                <td style="padding: 8px 12px; border: 1px solid #d1d5db; text-align: center; font-weight: 700; color: ${isAbnormal ? badge.bg : "#374151"};">${value}</td>
                <td style="padding: 8px 12px; border: 1px solid #d1d5db; text-align: center; color: #6b7280; font-size: 12px;">${unit}</td>
                <td style="padding: 8px 12px; border: 1px solid #d1d5db; text-align: center; color: #6b7280; font-size: 12px;">${refRange}</td>
                <td style="padding: 8px 12px; border: 1px solid #d1d5db; text-align: center;">
                  ${flag ? `<span style="display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 10px; font-weight: 600; color: white; background-color: ${badge.bg}; -webkit-print-color-adjust: exact; print-color-adjust: exact;">${badge.text}</span>` : ""}
                </td>
              </tr>
          `;

          // Interpretation row (shown below the analyte row if enabled)
          if (showInterpretation) {
            let interpretationTextFlat = "";
            if (canonicalFlag === "high" || canonicalFlag === "critical_high") {
              interpretationTextFlat = analyte.interpretation_high || "";
            } else if (canonicalFlag === "low" || canonicalFlag === "critical_low") {
              interpretationTextFlat = analyte.interpretation_low || "";
            } else {
              interpretationTextFlat = analyte.interpretation_normal || "";
            }
            if (interpretationTextFlat) {
              testResultsHtml += `
              <tr style="page-break-inside: avoid;">
                <td colspan="5" style="padding: 4px 12px 8px 24px; border: 1px solid #d1d5db; border-top: none; font-size: 11px; color: #6b7280; font-style: italic;">
                  <strong>Interpretation:</strong> ${interpretationTextFlat}
                </td>
              </tr>
              `;
            }
          }
        } // end for analyte
      } // end for flatBlock

      testResultsHtml += `
          </tbody>
        </table>
        ${flatTableAnalytes.some((a: any) => a.is_auto_calculated || a.is_calculated) ? '<p style="font-size:9px;color:#9ca3af;margin:2px 0 8px;font-style:italic;">*calc \u2013 Calculated parameter</p>' : ''}
      `;
    }

    // â”€â”€ Descriptive Rows â”€â”€
    if (descriptiveAnalytes.length > 0) {
      for (const descBlock of groupAnalytesBySectionHeading(descriptiveAnalytes)) {
        if (descBlock.heading) {
          testResultsHtml += `
          <div style="padding: 6px 12px; font-weight: 600; font-size: 12px; color: ${THEME.accent}; margin-top: 8px; margin-bottom: 4px; border-bottom: 1px solid ${THEME.accent};">${descBlock.heading}</div>
          `;
        }
        for (const analyte of descBlock.analytes) {
          const paramName = analyte.parameter || analyte.name || analyte.test_name || "";
          const value = analyte.value ?? "";
          const refText = String(analyte.reference_range || "").trim();
          testResultsHtml += `
            <div style="padding: 8px 12px; border: 1px solid #e5e7eb; border-radius: 4px; margin-bottom: 6px; background: #f9fafb;">
              <strong style="color: #1f2937;">${paramName}:</strong>
              <span style="color: #374151; margin-left: 6px;">${value || refText || ""}</span>
            </div>
          `;
        }
      }
    }

    // â”€â”€ Group Interpretation Block â”€â”€
    const _groupInterp = groupInterpretations?.get(groupId);
    if (_groupInterp) {
      testResultsHtml += `
        <div class="limsv2-report group-interpretation" style="margin-top:10px;padding:8px 12px;border-top:1px solid #e5e7eb;border-radius:0 0 4px 4px;background:#f9fafb;">
          ${_groupInterp}
        </div>
      `;
    }

    testResultsHtml += `
      </div>
    `;
  }

  testResultsHtml += "</div>";

  // â”€â”€ Signatory Section â”€â”€
  const sigName = formatSignatureNameForPdf(signatoryInfo?.signatoryName || "");
  const sigDesignation = signatoryInfo?.signatoryDesignation || "";
  const sigImageUrl = signatoryInfo?.signatoryImageUrl || "";
  const signatureSize = resolveSignatureImageSize(printOptions);

  const _classicSigList = getReportSignatories(signatoryInfo);
  const signatoryHtml = (() => {
    const n = _classicSigList.length;
    const isMulti = n >= 2;
    const maxH = isMulti ? Math.min(signatureSize.maxHeight, n >= 3 ? 48 : 54) : signatureSize.maxHeight;
    const maxW = isMulti ? Math.min(signatureSize.maxWidth, n >= 3 ? 120 : 145) : signatureSize.maxWidth;
    const boxes = _classicSigList.map((s) => {
      const nm = formatSignatureNameForPdf(s?.signatoryName || "");
      const dg = s?.signatoryDesignation || "";
      const img = s?.signatoryImageUrl || "";
      return `
      <div style="display: inline-block; text-align: center; min-width: ${isMulti ? 150 : 200}px;">
        ${img ? `<img src="${img}" alt="" style="max-height: ${maxH}px; max-width: ${maxW}px; width: auto; height: auto; object-fit: contain; margin: 0 auto 5px; display: block;" onerror="this.style.display='none'" />` : ""}
        ${nm ? `<div style="border-bottom: 1px solid #374151; padding-bottom: 4px; margin-bottom: 4px; font-size: ${isMulti ? 13 : 14}px; font-weight: 600; color: #1f2937;">${nm}</div>` : ""}
        ${dg ? `<div style="font-size: 11px; color: #6b7280;">${dg}</div>` : ""}
      </div>`;
    }).join("");
    return `
    <div class="signatures" style="margin-top: 30px; text-align: right; page-break-inside: avoid; ${isMulti ? "display:flex; gap:20px; align-items:flex-end; justify-content:flex-end;" : ""}">
      ${boxes}
    </div>
  `;
  })();

  const buildSectionLabel = (key: string) => {
    if (sectionLabels?.[key]) return sectionLabels[key];
    const { rawKey } = normalizeSectionKey(key);
    if (!rawKey) return "Report Section";
    return rawKey
      .replace(/[_-]+/g, " ")
      .split(" ")
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join(" ");
  };

  let reportSectionsHtml = "";
  if (includeSections && Object.keys(normalizedSectionContent).length > 0) {
    const sectionItems = Object.entries(normalizedSectionContent)
      .filter(([, content]) => content && String(content).trim().length > 0)
      .map(([key, content]) => {
        const rawContent = String(content).trim();
        if (!rawContent) return "";
        const heading = buildSectionLabel(key);
        return renderSectionContentForTemplate(
          rawContent,
          heading,
          'font-size: 13px; font-weight: 600; color: #111827; margin: 0 0 6px;',
        );
      })
      .filter(Boolean)
      .join("");

    if (sectionItems) {
      reportSectionsHtml = `
        <div class="report-sections" style="margin-top: 18px;">
          <h3 style="font-size: 14px; font-weight: 600; color: #111827; margin-bottom: 8px; border-bottom: 1px solid #e5e7eb; padding-bottom: 4px;">Report Sections</h3>
          ${sectionItems}
        </div>
      `;
    }
  }

  // â”€â”€ Combine all sections â”€â”€
  return `
    <div class="default-report-template">
      ${printOptions?._suppressPatientHeader ? '' : patientInfoHtml}
      ${testResultsHtml}
      ${reportSectionsHtml}
      ${printOptions?._suppressSignature ? '' : signatoryHtml}
    </div>
  `;
}

/**
 * Build PDF body HTML document (main content)
 * Now supports letterhead background image, padding settings, and QR Verification Code
 */
function buildPdfBodyDocumentV2(
  bodyHtml: string,
  customCss: string,
  letterheadBackgroundUrl?: string | null,
  pdfSettings?: any,
  verificationUrl?: string | null,
): string {
  const useNativePdfHeaderFooter = !!pdfSettings?.displayHeaderFooter;
  console.log("ðŸš€ðŸš€ðŸš€ VERSION 3.3 - PER-GROUP TEMPLATE STYLE ðŸš€ðŸš€ðŸš€");
  console.log("ðŸ—ï¸ buildPdfBodyDocumentV2 called with:", {
	    bodyHtmlLength: bodyHtml?.length || 0,
    customCssLength: customCss?.length || 0,
	    letterheadUrl: letterheadBackgroundUrl || "NONE",
	    hasLetterhead: !!letterheadBackgroundUrl,
	    hasPdfSettings: !!pdfSettings,
      useNativePdfHeaderFooter,
	    verificationUrl: verificationUrl || "NONE",
	  });

  // Calculate spacer heights from settings (default to 130px)
  const topSpacerHeight = pdfSettings?.margins?.top ?? 130;
  const bottomSpacerHeight = pdfSettings?.margins?.bottom ?? 130;
  const leftPadding = pdfSettings?.margins?.left ?? 20;
  const rightPadding = pdfSettings?.margins?.right ?? 20;
  // For letterhead eCopy, PDF.co uses 0 page margins (full-bleed), so HTML content
  // needs its own padding. Fall back to 20px if the lab left margins.left/right at 0.
  const bodySidePaddingLeft = letterheadBackgroundUrl ? Math.max(leftPadding, 20) : leftPadding;
  const bodySidePaddingRight = letterheadBackgroundUrl ? Math.max(rightPadding, 20) : rightPadding;
  const useTransparentBasicBackground =
    pdfSettings?.printOptions?.resultTableBackground === "transparent";

  // QR code is now placed in signature area (bottom) - not at top
  // The QR will be injected where signature exists, on the opposite side
  // ðŸŽ¨ PDF.co compatibility: Expand CSS custom properties (variables) to literal values
  let normalizedCss = customCss;
  if (customCss) {
    const cssVarMap = new Map<string, string>();

    // Extract :root variables
    const rootMatch = customCss.match(/:root\s*\{([^}]+)\}/);
    if (rootMatch) {
      const rootBlock = rootMatch[1];
      const varMatches = rootBlock.matchAll(/--([a-z-]+)\s*:\s*([^;]+);/g);
      for (const match of varMatches) {
        cssVarMap.set(`--${match[1]}`, match[2].trim());
      }
    }

    // Replace var() references with actual values
    if (cssVarMap.size > 0) {
      normalizedCss = customCss.replace(/var\(--([a-z-]+)\)/g, (_, varName) => {
        const value = cssVarMap.get(`--${varName}`);
        return value || `var(--${varName})`; // fallback to original if not found
      });

      console.log("ðŸŽ¨ CSS Variables expanded for PDF.co:", {
        variableCount: cssVarMap.size,
        variables: Array.from(cssVarMap.keys()),
      });
    }
  }

  // ðŸ› Debug CSS inclusion
  console.log("ðŸŽ¨ buildPdfBodyDocument CSS Debug:", {
    hasBaselineCss: !!BASELINE_CSS,
    baselineCssLength: BASELINE_CSS?.length || 0,
    hasCustomCss: !!normalizedCss,
    customCssLength: normalizedCss?.length || 0,
    customCssPreview: normalizedCss?.substring(0, 100) || "NONE",
    hasLetterhead: !!letterheadBackgroundUrl,
  });

  // Build letterhead background styles if URL provided
  console.log("ðŸŽ¨ Building letterhead styles...");
  console.log("  letterheadBackgroundUrl value:", letterheadBackgroundUrl);
  console.log(
    "  letterheadBackgroundUrl type:",
    typeof letterheadBackgroundUrl,
  );
  console.log("  letterheadBackgroundUrl truthy?:", !!letterheadBackgroundUrl);

  const letterheadStyles = letterheadBackgroundUrl
    ? `
    /* Letterhead Background - Fixed layer that repeats on every PDF page */
    /* NOTE: Do NOT set @page { margin: 0; } - it overrides PDF.co margins! */
    
    html, body {
      margin: 0;
      padding: 0;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    
    /* The repeating full-page background layer */
    #page-bg {
      position: fixed;
      top: 0;
      left: 0;
      width: 210mm;
      height: 297mm;
      z-index: 0;
      pointer-events: none;
      background-image: url('${letterheadBackgroundUrl}');
      background-repeat: no-repeat;
      background-position: top left;
      background-size: 210mm 297mm; /* A4 exact sizing */
    }
    
    /* Keep content above the background */
    .limsv2-report,
    .limsv2-report-body {
      position: relative;
      z-index: 1;
    }
    
    /* CRITICAL: Remove the white sheet that hides the background layer */
    .limsv2-report,
    .limsv2-report-body {
      background: transparent !important;
      background-color: transparent !important;
    }
    
    /* Prevent white blocks from hiding the letterhead */
    .report-container,
    .report-body,
    .report-region,
    .report-region--body,
    .report-header {
      background: transparent !important;
      background-color: transparent !important;
    }
    
    /* Keep tables readable with solid white background (no bleed-through) */
    .patient-info,
    .report-table,
    .tbl-meta,
    .tbl-results,
    .tbl-interpretation {
      background: #ffffff !important;
    }

    ${useTransparentBasicBackground ? `
    /* Basic template can print directly over the uploaded full-page letterhead. */
    .basic-report-template .tbl-results,
    .basic-report-template .patient-header-table,
    .basic-report-template .tbl-results td,
    .basic-report-template .tbl-results th,
    .basic-report-template .patient-header-table td,
    .basic-report-template .patient-header-table th {
      background: transparent !important;
      background-color: transparent !important;
    }
    ` : ""}

    /* Safe content area - spacing handled by HTML TABLE spacers now */
	    .limsv2-report-body--pdf {
	      padding: 0 ${bodySidePaddingRight}px 0 ${bodySidePaddingLeft}px !important;
	    }

    /* Prevent table rows from being cut across pages */
    .report-table tr,
    .patient-info tr,
    .tbl-interpretation tr {
      break-inside: avoid;
      page-break-inside: avoid;
    }

    /* Keep headers repeated on new pages */
    .report-table thead,
    .tbl-interpretation thead {
      display: table-header-group;
    }
  `
    : "";

  console.log("  letterheadStyles length:", letterheadStyles.length);

  // Wrap content with fixed background AND repeating layout table
  // This "Print Table" technique ensures top/bottom spacing repeats on EVERY page
  // QR code is now placed in signature area at bottom
  const wrappedBody = letterheadBackgroundUrl
    ? `
    <!-- Fixed background layer - repeats on every PDF page -->
    <div id="page-bg"></div>
    
    <!-- Layout Table for Multi-Page Spacing -->
    <table style="width: 100%; max-width: 210mm; border: none; border-collapse: collapse;">
      
      <!-- HEADER SPACER (Repeats on every page) -->
      <thead style="display: table-header-group;">
        <tr>
          <td style="border: none; padding: 0;">
            <div style="height: ${topSpacerHeight}px;"></div>
          </td>
        </tr>
      </thead>
      
      <!-- FOOTER SPACER (Repeats on every page) -->
      <tfoot style="display: table-footer-group;">
        <tr>
          <td style="border: none; padding: 0;">
            <div style="height: ${bottomSpacerHeight}px;"></div>
          </td>
        </tr>
      </tfoot>
      
      <!-- MAIN CONTENT -->
      <tbody>
        <tr>
          <td style="border: none; padding: 0;">
            <div class="limsv2-report">
              <main class="limsv2-report-body limsv2-report-body--pdf">${
      bodyHtml || "<p></p>"
    }</main>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  `
    : `
    <div class="limsv2-report">
      <main class="limsv2-report-body limsv2-report-body--pdf">${
      bodyHtml || "<p></p>"
    }</main>
    </div>
  `;

  const finalHtml = `<!DOCTYPE html>
<!-- FORCE V3 UPDATE -->
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<!-- Load Google Fonts: Inter (primary) + Noto Sans (Unicode fallback) -->
<!-- FIX: Removed 9 unused Indian script Noto variants â€” saves ~200-400KB from PDF embed -->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Noto+Sans:wght@400;700&display=swap" rel="stylesheet">
<style id="lims-report-baseline">${BASELINE_CSS}</style>
${(!bodyHtml.includes('basic-report-template') && !bodyHtml.includes('report-table')) ? `<style id="lims-report-ckeditor">${CKEDITOR_CSS}</style>` : ''}
	${
	    normalizedCss
	      ? `<style id="lims-report-custom">${normalizedCss}</style>`
	      : ""
	  }
	<style id="lims-cke-image-alignment">${CKE_IMAGE_ALIGNMENT_CSS}</style>
	${
	    letterheadStyles
	      ? `<style id="lims-letterhead">${letterheadStyles}</style>`
      : ""
  }
<style id="lims-margin-overrides">
/* Left/right padding driven by lab PDF margin settings */
.limsv2-report-body--pdf { padding-left: ${bodySidePaddingLeft}px !important; padding-right: ${bodySidePaddingRight}px !important; }
</style>
</head>
<body>
${wrappedBody}
</body>
</html>`;

  console.log("ðŸŽ¯ buildPdfBodyDocumentV2 FINAL CHECK before return:");
  console.log("  - letterheadStyles included?:", !!letterheadStyles);
  console.log("  - wrappedBody type:", typeof wrappedBody);
  console.log(
    "  - Final HTML includes page-bg div?:",
    finalHtml.includes("page-bg"),
  );

  return finalHtml;
}

/**
 * Apply styling to flag values AND result values in rendered HTML
 * - Wraps flag text (high, low, H, L, etc.) in styled spans
 * - Also colors the result value in the same table row
 */
/**
 * AUTO-FIX: Scans the rendered HTML and adds semantic classes to flag cells
 * This ensures existing templates (without explicit {{_FLAG_CLASS}}) still get colored flags
 *
 * Logic:
 * 1. Finds table cells in .report-table
 * 2. Checks content (Normal, Low, High, Critical)
 * 3. Appends class="flag-low" etc. to the <td>
 */
/**
 * AUTO-FIX: Scans the rendered HTML and adds semantic classes to flag cells AND value cells
 * This ensures existing templates get robust styling for both flags and values.
 *
 * Logic:
 * 1. Scans '<tr>' blocks to find rows with abnormal flags.
 * 2. If a row has a flag (Low, High, Critical), it:
 *    - Adds 'flag-[status]' to the flag cell.
 *    - Adds 'value-[status]' to the numeric value cell in the SAME row.
 */
function addFlagClassesToHtml(html: string): string {
  if (!html) return html;

  // Process each table row separately
  return html.replace(/<tr[^>]*>[\s\S]*?<\/tr>/gi, (rowHtml) => {
    // 1. Determine flag status of this row
    let status = "";
    const lowerRow = rowHtml.toLowerCase();

    // Check for critical first (more specific)
    if (lowerRow.includes("critical_h") || lowerRow.includes("criticalh") ||
      lowerRow.includes(">h*<") || lowerRow.includes("> h* <")) {
      status = "critical_h";
    } else if (
      lowerRow.includes("critical_l") || lowerRow.includes("criticall") ||
      lowerRow.includes(">l*<") || lowerRow.includes("> l* <")
    ) status = "critical_l";
    else if (lowerRow.includes("critical")) status = "critical";
    // High / Low
    else if (
      lowerRow.includes(">high<") || lowerRow.includes(">h<") ||
      lowerRow.includes("> hh <") || lowerRow.includes(">hh<")
    ) status = "high";
    else if (
      lowerRow.includes(">low<") || lowerRow.includes(">l<") ||
      lowerRow.includes("> ll <") || lowerRow.includes(">ll<")
    ) status = "low";
    // Qualitative Abnormal (Red)
    else if (
      lowerRow.includes("detected") && !lowerRow.includes("not detected") ||
      lowerRow.includes("positive") ||
      lowerRow.includes("present") ||
      lowerRow.includes("reactive") && !lowerRow.includes("non-reactive")
    ) status = "abnormal";
    // Qualitative Warning (Amber)
    else if (
      lowerRow.includes("trace") || lowerRow.includes("borderline") ||
      lowerRow.includes("indeterminate")
    ) status = "trace";
    // Normal / Negative
    else if (
      lowerRow.includes(">normal<") || lowerRow.includes(">n<") ||
      lowerRow.includes("negative") ||
      lowerRow.includes("not detected") ||
      lowerRow.includes("absent") ||
      lowerRow.includes("non-reactive")
    ) status = "normal";

    if (!status) return rowHtml; // No flag found, return unchanged

    // 2. Inject classes into cells
    return rowHtml.replace(
      /(<td[^>]*>)([\s\S]*?)(<\/td>)/gi,
      (cellMatch, openTag, content, closeTag) => {
        const text = content.replace(/<[^>]+>/g, "").trim();
        const lowerText = text.toLowerCase();

        // Is this the FLAG cell? (Matches the status text)
        const isFlagCell =
          (status === "critical_h" &&
            (lowerText === "critical_h" || lowerText === "criticalh" || lowerText === "h*")) ||
          (status === "critical_l" &&
            (lowerText === "critical_l" || lowerText === "criticall" || lowerText === "l*")) ||
          (status === "high" && (lowerText === "high" || lowerText === "h" || lowerText === "hh")) ||
          (status === "low" && (lowerText === "low" || lowerText === "l" || lowerText === "ll")) ||
          (status === "abnormal" &&
            (lowerText.includes("detected") || lowerText === "positive" ||
              lowerText === "present" || lowerText === "reactive")) ||
          (status === "trace" &&
            (lowerText === "trace" || lowerText === "borderline")) ||
          (status === "normal" &&
            (lowerText === "normal" || lowerText === "n" ||
              lowerText === "negative" || lowerText.includes("not detected")));

        // Is this the VALUE cell? (Is numeric and NOT the flag cell)
        // Heuristic: It's a number, maybe with decimals/signs, and NOT empty
        const isValueCell = !isFlagCell &&
          /^[<>~]?\s*-?\d+(\.\d+)?\s*$/.test(text);

        let newClass = "";
        if (isFlagCell) newClass = `flag-${status}`;
        else if (isValueCell) newClass = `value-${status}`;

        if (newClass) {
          if (openTag.includes('class="')) {
            return openTag.replace('class="', `class="${newClass} `) + content +
              closeTag;
          } else {
            return openTag.replace("<td", `<td class="${newClass}"`) + content +
              closeTag;
          }
        }

        return cellMatch;
      },
    );
  });
}

/**
 * DEPRECATED: Old applyFlagStyling (kept for reference but unused if we use clean classes)
 */
function applyFlagStyling(html: string, settings?: any): string {
  // Pass through to the class adder first - this ALWAYS adds classes like value-high, flag-low
  let newHtml = addFlagClassesToHtml(html);

  // CSS injection is OPT-IN via marker OR lab settings
  // Marker in template: <!-- lims:enable-flag-styling --> or LIMS_ENABLE_FLAG_STYLING
  // OR settings.resultColors.enabled === true
  // DEFAULT: enabled unless explicitly disabled
  const optOut = settings?.resultColors?.enabled === false;
  const optIn = !optOut ||
    html.includes("lims:enable-flag-styling") ||
    html.includes("LIMS_ENABLE_FLAG_STYLING");

  if (optIn) {
    // Use lab-configured colors or defaults
    const high = settings?.resultColors?.high || "#dc2626";
    const low = settings?.resultColors?.low || "#ea580c";
    const normal = settings?.resultColors?.normal || "#1f2937";

    const css = `
<style>
/* Flag and Value Coloring - Injected via lims:enable-flag-styling marker or lab settings */
.flag-high, .value-high { color: ${high} !important; font-weight: 800; }
.flag-low, .value-low { color: ${low} !important; font-weight: 800; }
.flag-critical, .value-critical,
.flag-critical_h, .value-critical_h { color: ${high} !important; font-weight: 900; }
.flag-critical_l, .value-critical_l { color: ${low} !important; font-weight: 900; }
.flag-abnormal, .value-abnormal { color: ${high} !important; font-weight: 800; }
.flag-trace, .value-trace { color: ${low} !important; font-weight: 800; }
.flag-normal, .value-normal { color: ${normal} !important; font-weight: 700; }
</style>`;
    if (newHtml.includes("</head>")) {
      return newHtml.replace("</head>", css + "</head>");
    }
    return css + newHtml;
  }

  // No opt-in: Classes are still added by addFlagClassesToHtml
  // User's custom CSS can style .value-high, .flag-low etc with their own colors
  return newHtml;
}

/**
 * Apply header text color inline styles for PDF.co compatibility
 * This directly adds inline style="color: #fff" to h1/h2/div elements in report headers
 */
function applyHeaderTextColor(html: string, settings?: any): string {
  if (!html) return html;

  const headerColor = settings?.headerTextColor;
  if (!headerColor || headerColor === "inherit") return html;

  const color = headerColor === "white" ? "#ffffff" : headerColor;

  let styledHtml = html;

  // Strategy: Find the report-header section and identify h1/h2/divs inside it
  // Then add inline color styles

  // Check if we have a report-header class in the HTML
  if (!styledHtml.includes("report-header")) {
    console.log(
      "âš ï¸ No report-header found in HTML, skipping header text color",
    );
    return styledHtml;
  }

  // Approach: Process the HTML to add inline color to elements within report-header
  // We'll look for the pattern of header section and add styles

  // Pattern 1: Find <div class="report-header..."> and add color to children
  // Use a state machine approach to track when we're inside report-header

  let insideReportHeader = false;
  let depth = 0;
  let i = 0;
  let result = "";

  while (i < styledHtml.length) {
    // Check for opening div with report-header class
    const divMatch = styledHtml.slice(i).match(
      /^<div[^>]*class="[^"]*report-header[^"]*"[^>]*>/i,
    );
    if (divMatch) {
      insideReportHeader = true;
      depth = 1;
      result += divMatch[0];
      i += divMatch[0].length;
      continue;
    }

    // Track depth when inside report-header
    if (insideReportHeader) {
      const openDivMatch = styledHtml.slice(i).match(/^<div[^>]*>/i);
      if (openDivMatch) {
        depth++;
        result += openDivMatch[0];
        i += openDivMatch[0].length;
        continue;
      }

      const closeDivMatch = styledHtml.slice(i).match(/^<\/div>/i);
      if (closeDivMatch) {
        depth--;
        if (depth === 0) {
          insideReportHeader = false;
        }
        result += closeDivMatch[0];
        i += closeDivMatch[0].length;
        continue;
      }

      // Add color to h1 inside report-header
      const h1Match = styledHtml.slice(i).match(/^<h1([^>]*)>/i);
      if (h1Match) {
        const attrs = h1Match[1];
        if (attrs.includes("style=")) {
          // Append color to existing style
          const newTag = h1Match[0].replace(
            /style="([^"]*)"/i,
            `style="$1; color: ${color} !important;"`,
          );
          result += newTag;
        } else {
          // Add new style attribute
          result += `<h1${attrs} style="color: ${color};">`;
        }
        i += h1Match[0].length;
        continue;
      }

      // Add color to h2 inside report-header
      const h2Match = styledHtml.slice(i).match(/^<h2([^>]*)>/i);
      if (h2Match) {
        const attrs = h2Match[1];
        if (attrs.includes("style=")) {
          const newTag = h2Match[0].replace(
            /style="([^"]*)"/i,
            `style="$1; color: ${color} !important;"`,
          );
          result += newTag;
        } else {
          result += `<h2${attrs} style="color: ${color};">`;
        }
        i += h2Match[0].length;
        continue;
      }

      // Add color to div with report-subtitle class
      const subtitleMatch = styledHtml.slice(i).match(
        /^<div([^>]*class="[^"]*report-subtitle[^"]*"[^>]*)>/i,
      );
      if (subtitleMatch) {
        const attrs = subtitleMatch[1];
        if (attrs.includes("style=")) {
          const newTag = subtitleMatch[0].replace(
            /style="([^"]*)"/i,
            `style="$1; color: ${color} !important;"`,
          );
          result += newTag;
        } else {
          result += `<div${attrs} style="color: ${color};">`;
        }
        i += subtitleMatch[0].length;
        continue;
      }
    }

    // Regular character - copy as-is
    result += styledHtml[i];
    i++;
  }

  console.log("ðŸŽ¨ Applied header text color:", color);
  return result;
}

/**
 * Add draft watermark to HTML
 */
function addDraftWatermark(html: string): string {
  const watermarkDiv = '<div class="draft-watermark">DRAFT</div>';
  return html.replace("</body>", `${watermarkDiv}</body>`);
}

// ============================================================
// SECTION: Image Processing
// ============================================================

/**
 * Convert image URLs in HTML to base64 for PDF.co
 */
async function convertHtmlImagesToBase64(html: string): Promise<string> {
  if (!html || html.trim().length === 0) return "";

  const imgRegex = /<img([^>]*src=['"]([^'"]+)['"][^>]*)>/gi;
  const matches = [...html.matchAll(imgRegex)];

  let convertedHtml = html;

  for (const match of matches) {
    const fullImgTag = match[0];
    const imageUrl = match[2];

    // Skip if already base64
    if (imageUrl.startsWith("data:")) continue;

    try {
      const base64Src = await convertImageUrlToBase64(imageUrl);
      if (base64Src) {
        const newImgTag = fullImgTag.replace(imageUrl, base64Src);
        convertedHtml = convertedHtml.replace(fullImgTag, newImgTag);
        console.log(
          `âœ… Converted image to base64: ${imageUrl.substring(0, 50)}...`,
        );
      }
    } catch (error) {
      console.warn(`âš ï¸ Failed to convert image ${imageUrl}:`, error);
    }
  }

  return convertedHtml;
}

/**
 * Fetch image URL and convert to base64 data URL
 */
async function convertImageUrlToBase64(imageUrl: string): Promise<string> {
  try {
    // Strip ImageKit transformations for base64 conversion
    // ImageKit transformations like /tr:w-800,h-600/ can cause issues with base64
    let cleanUrl = imageUrl;
    if (imageUrl.includes("ik.imagekit.io") && imageUrl.includes("/tr:")) {
      // Remove transformation parameters: /tr:w-800,h-600/ -> /
      cleanUrl = imageUrl.replace(/\/tr:[^/]+\//, "/");
      console.log(
        `  ðŸ”§ Stripped ImageKit transforms: ${imageUrl} -> ${cleanUrl}`,
      );
    }
    // 1. Parse request body
    const {
      record,
      old_record,
      type,
      orderId: requestOrderId,
      htmlOverride, // NEW: For Manual Design Studio
      isManualDesign, // NEW: Flag
    } = await req.json();

    // Determine Order ID
    const orderId = requestOrderId || record?.id;

    if (!orderId) {
      throw new Error("No order_id provided in request body or record");
    }

    console.log(
      `\nðŸ“„ GENERATING PDF for Order: ${orderId} ${
        isManualDesign ? "(MANUAL DESIGN MODE)" : "(AUTO MODE)"
      }`,
    );

    // ========================================
    // MANUAL MODE: Bypass Template Logic
    // ========================================
    if (isManualDesign && htmlOverride) {
      console.log("ðŸŽ¨ Manual Design detected. Bypassing template generation.");
      console.log("ðŸ“ HTML Content Length:", htmlOverride.length);

      // Validate HTML slightly
      if (!htmlOverride.includes("<!DOCTYPE html>")) {
        console.warn("âš ï¸ Manual HTML missing DOCTYPE, might cause issues.");
      }

      // Prepare filename
      const filename = `Report_${orderId}_${new Date().getTime()}.pdf`;

      // Send directly to PDF.co
      const pdfUrl = await sendHtmlToPdfCo(
        htmlOverride,
        filename,
        PDFCO_API_KEY,
        {
          // For manual design, we assume the HTML is fully formed (A4 sized divs)
          // So we disable margins and headers/footers in PDF.co to let HTML control layout
          margins: "0px 0px 0px 0px",
          paperSize: "A4",
          printBackground: true,
          displayHeaderFooter: false,
        },
      );

      console.log("âœ… PDF generated successfully via Manual Mode:", pdfUrl);

      // Upload to Storage
      const { publicUrl } = await uploadPdfToStorage(
        supabaseClient,
        pdfUrl,
        orderId,
        undefined, // lab_id not strictly needed for path construction if simplified
        "manual_patient",
        filename,
        "final",
      );

      // Update Database (Basic)
      // We might not have all patient details here if we didn't fetch them,
      // but typically the frontend triggers this AFTER saving the order, so updates strictly to 'reports' table
      // might be needed. For now, just return the URL.

      return new Response(
        JSON.stringify({
          success: true,
          pdfUrl: publicUrl,
          status: "completed",
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ========================================
    // AUTO MODE: Original Logic
    // ========================================

    // Initialize job tracking
    job = await createJob(supabaseClient, orderId);
    console.log("âœ… Job created:", job.id);

    const response = await fetch(cleanUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);

    // Convert to base64
    let binary = "";
    for (let i = 0; i < uint8Array.length; i++) {
      binary += String.fromCharCode(uint8Array[i]);
    }
    const base64 = btoa(binary);

    // Detect content type
    const contentType = response.headers.get("content-type") || "image/png";
    return `data:${contentType};base64,${base64}`;
  } catch (error) {
    console.warn("Failed to convert image to base64:", error);
    return "";
  }
}

// ============================================================
// SECTION: PDF.co API Integration
// ============================================================

/**
 * Poll PDF.co async job until completion
 */
async function pollPdfCoJob(
  jobId: string,
  apiKey: string,
  maxAttempts = 60,
): Promise<string> {
  const pollInterval = 2000; // 2 seconds

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(
      `ðŸ“Š Polling PDF.co job ${jobId} (attempt ${attempt}/${maxAttempts})...`,
    );

    const response = await fetch(`${PDFCO_JOB_STATUS_URL}?jobid=${jobId}`, {
      headers: { "x-api-key": apiKey },
    });

    if (!response.ok) {
      throw new Error(`PDF.co job status check failed: ${response.status}`);
    }

    const result = await response.json();

    if (result.status === "success" && result.url) {
      console.log("âœ… PDF.co job completed:", result.url);
      return result.url;
    }

    if (result.status === "error") {
      throw new Error(`PDF.co job failed: ${result.message}`);
    }

    // Wait before next poll
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  throw new Error("PDF.co job polling timed out");
}

/**
 * Remove image tags that Chromium/PDF.co would render as a broken image icon.
 * CKEditor placeholders such as {{approverSignature}} can resolve to src="",
 * which causes PDF.co to print the image icon plus alt text in the PDF.
 */
function stripBrokenPdfImages(html: string): string {
  if (!html) return html;

  let removedCount = 0;
  const cleanedHtml = html.replace(/<img\b[^>]*>/gi, (imgTag) => {
    const srcMatch = imgTag.match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const rawSrc = (srcMatch?.[1] ?? srcMatch?.[2] ?? srcMatch?.[3] ?? "").trim();
    const normalizedSrc = rawSrc.replace(/&quot;/g, '"').trim();
    const shouldRemove =
      !srcMatch ||
      !normalizedSrc ||
      normalizedSrc === "#" ||
      /^about:blank$/i.test(normalizedSrc) ||
      /^(undefined|null)$/i.test(normalizedSrc) ||
      /^\{\{[\s\S]*\}\}$/.test(normalizedSrc);

    if (!shouldRemove) return imgTag;

    removedCount++;
    return "";
  });

  if (removedCount > 0) {
    console.warn(`Removed ${removedCount} broken/empty image tag(s) before PDF.co render`);
  }

  return cleanedHtml;
}

function emojiToTwemojiCodepoint(emoji: string): string {
  const codepoints = Array.from(emoji)
    .map((char) => char.codePointAt(0))
    .filter((codepoint): codepoint is number =>
      typeof codepoint === "number" && codepoint !== 0xfe0e
    );

  const hasJoiner = codepoints.includes(0x200d);
  const normalized = hasJoiner
    ? codepoints
    : codepoints.filter((codepoint) => codepoint !== 0xfe0f);

  return normalized.map((codepoint) => codepoint.toString(16)).join("-");
}

function renderEmojiAsColorIcon(emoji: string): string {
  const codepoint = emojiToTwemojiCodepoint(emoji);
  if (!codepoint) return emoji;

  return `<img class="report-emoji-icon" src="https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/svg/${codepoint}.svg" alt="${emoji}" style="display:inline-block;width:1.05em;height:1.05em;vertical-align:-0.15em;margin-right:0.18em;border:0;box-shadow:none;background:transparent;" />`;
}

function colorizeReportEmojiTextNodes(html: string): string {
  if (!html) return html;

  const emojiRegex = /[\p{Extended_Pictographic}](?:\uFE0F|\uFE0E)?(?:\u200D[\p{Extended_Pictographic}](?:\uFE0F|\uFE0E)?)*\uFE0F?/gu;
  return html.replace(/(^|>)([^<]*[\p{Extended_Pictographic}][^<]*)(?=<|$)/gu, (_match: string, prefix: string, text: string) => {
    const colorizedText = text.replace(emojiRegex, (emoji: string) => renderEmojiAsColorIcon(emoji));
    return `${prefix}${colorizedText}`;
  });
}

/**
 * Send HTML to PDF.co API and get PDF URL
 */
async function sendHtmlToPdfCo(
  html: string,
  filename: string,
  apiKey: string,
  options: {
    headerHtml?: string;
    footerHtml?: string;
    margins?: string;
    headerHeight?: string;
    footerHeight?: string;
    scale?: number;
    displayHeaderFooter?: boolean;
    paperSize?: string;
    mediaType?: string;
    printBackground?: boolean;
    grayscale?: boolean; // Convert to black & white for print versions
  } = {},
): Promise<string> {
  const sanitizedHtml = stripBrokenPdfImages(html);
  const sanitizedHeaderHtml = stripBrokenPdfImages(options.headerHtml || "");
  const sanitizedFooterHtml = stripBrokenPdfImages(options.footerHtml || "");
  console.log("ðŸ“¤ Sending HTML to PDF.co API...");
  console.log("  Filename:", filename);
  console.log("  HTML length:", sanitizedHtml.length);
  console.log("  Header length:", sanitizedHeaderHtml.length);
  console.log("  Footer length:", sanitizedFooterHtml.length);

  const parsePxValue = (value: string | number | undefined, fallback: number): number => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const match = value.match(/-?\d+(\.\d+)?/);
      if (match) return Number(match[0]);
    }
    return fallback;
  };

  const payload: Record<string, any> = {
    name: filename,
    html: sanitizedHtml,
    async: true, // Use async for large documents
    margins: options.margins || DEFAULT_PDF_SETTINGS.margins,
    papersize: options.paperSize || DEFAULT_PDF_SETTINGS.paperSize,
    displayheaderfooter: options.displayHeaderFooter ??
      DEFAULT_PDF_SETTINGS.displayHeaderFooter,
    header: sanitizedHeaderHtml,
    footer: sanitizedFooterHtml,
    headerheight: options.headerHeight || DEFAULT_PDF_SETTINGS.headerHeight,
    footerheight: options.footerHeight || DEFAULT_PDF_SETTINGS.footerHeight,
    scale: options.scale ?? DEFAULT_PDF_SETTINGS.scale,
    mediatype: options.mediaType || DEFAULT_PDF_SETTINGS.mediaType,
    printbackground: options.printBackground ??
      DEFAULT_PDF_SETTINGS.printBackground,
  };

  console.log("  Payload settings:", {
    margins: payload.margins,
    papersize: payload.papersize,
    displayheaderfooter: payload.displayheaderfooter,
    headerheight: payload.headerheight,
    footerheight: payload.footerheight,
    mediatype: payload.mediatype,
    printbackground: payload.printbackground,
  });

  if (payload.displayheaderfooter && typeof payload.margins === "string") {
    const marginParts = payload.margins.trim().split(/\s+/);
    const topMarginPx = parsePxValue(marginParts[0], 0);
    const bottomMarginPx = parsePxValue(marginParts[2] ?? marginParts[0], 0);
    const headerHeightPx = parsePxValue(payload.headerheight, 90);
    const footerHeightPx = parsePxValue(payload.footerheight, 80);

    if (topMarginPx > headerHeightPx + 40) {
      console.warn("  âš ï¸ Top margin is much larger than header height:", {
        topMarginPx,
        headerHeightPx,
      });
    }

    if (bottomMarginPx > footerHeightPx + 40) {
      console.warn("  âš ï¸ Bottom margin is much larger than footer height:", {
        bottomMarginPx,
        footerHeightPx,
      });
    }
  }

  // Add grayscale filter for print versions (converts colors to B&W)
  // PDF.co expects profiles as a JSON string with specific format
  if (options.grayscale) {
    // Use CSS filter instead since PDF.co profiles format is complex
    // We'll inject grayscale CSS into the HTML instead
    console.log("  ðŸ–¨ï¸ Grayscale mode requested - will apply via CSS filter");
  }

  const response = await fetch(PDFCO_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `PDF.co API error: ${response.status} ${response.statusText} - ${errorText}`,
    );
  }

  const result = await response.json();

  if (result.error) {
    throw new Error(`PDF.co API error: ${result.message}`);
  }

  // Handle synchronous response
  if (result.url) {
    console.log("âœ… PDF generated synchronously:", result.url);
    return result.url;
  }

  // Handle async response (poll for completion)
  if (result.jobId) {
    console.log("ðŸ“‹ PDF.co async job queued:", result.jobId);
    return pollPdfCoJob(result.jobId, apiKey);
  }

  throw new Error("PDF.co API did not return a result URL or jobId");
}

// ============================================================
// SECTION: Section Content Injection (PBS/Radiology findings, impressions)
// ============================================================

/**
 * Fetch section content for a result and return as a map of placeholder_key -> final_content
 */
async function fetchSectionContent(
  supabaseClient: any,
  resultIds: string[],
  includeImages = true,
): Promise<{
  sectionContent: Record<string, string>;
  sectionLabels: Record<string, string>;
  sectionContentByGroup: Map<string, Record<string, string>>;
  sectionPlaceholderValues: Record<string, string>;
}> {
  if (!resultIds || resultIds.length === 0) {
    return {
      sectionContent: {},
      sectionLabels: {},
      sectionContentByGroup: new Map(),
      sectionPlaceholderValues: {},
    };
  }

  try {
    // Build a map of result_id -> test_group_id so we can assign section content
    // to the correct group even when lab_template_sections.test_group_id is NULL
    // (section-only groups where the section template isn't linked to a specific group).
    const resultToGroupMap = new Map<string, string>();
    try {
      const { data: resultGroupRows } = await supabaseClient
        .from("results")
        .select("id, test_group_id")
        .in("id", resultIds);
      for (const row of (resultGroupRows || [])) {
        if (row.id && row.test_group_id) {
          resultToGroupMap.set(row.id, row.test_group_id);
        }
      }
    } catch (_e) {
      // Non-fatal: fall back to section-level test_group_id only
    }

    const { data, error } = await supabaseClient
      .from("result_section_content")
      .select(`
        result_id,
        final_content,
        cascading_selections,
        image_urls,
        lab_template_sections!inner(
          placeholder_key,
          section_name,
          test_group_id,
          display_order,
          section_config
        )
      `)
      .in("result_id", resultIds)
      .not("lab_template_sections.placeholder_key", "is", null);

    if (error || !data) {
      console.warn("Failed to fetch section content:", error?.message);
      return { sectionContent: {}, sectionLabels: {}, sectionContentByGroup: new Map(), sectionPlaceholderValues: {} };
    }

    // Sort by display_order so sections render in the configured order
    data.sort((a: any, b: any) => {
      const orderA = a.lab_template_sections?.display_order ?? 999;
      const orderB = b.lab_template_sections?.display_order ?? 999;
      if (orderA !== orderB) return orderA - orderB;
      // Secondary sort: section_name alphabetically for stable ordering
      const nameA = a.lab_template_sections?.section_name || "";
      const nameB = b.lab_template_sections?.section_name || "";
      return nameA.localeCompare(nameB);
    });

    // Build map of placeholder_key -> final_content and placeholder_key -> section_name
    // Also build per-group map: test_group_id -> { placeholder_key -> content }
    // FIX: When multiple sections share the same placeholder_key (e.g. two "findings"
    // sections), use a unique suffix (_2, _3, â€¦) so every section gets its own entry
    // instead of the later one silently overwriting the earlier one.
    const sectionContent: Record<string, string> = {};
    const sectionLabels: Record<string, string> = {};
    const sectionPlaceholderValues: Record<string, string> = {};
    const sectionContentByGroup = new Map<string, Record<string, string>>();
    const keyCounters: Record<string, number> = {}; // tracks how many times a base key has been seen
    for (const item of data) {
      const baseKey = item.lab_template_sections?.placeholder_key;
      if (baseKey) {
        const label = item.lab_template_sections?.section_name;
        const rebuiltCascadeContent = buildCascadeContentFromConfig(
          item.lab_template_sections?.section_config,
          item.cascading_selections,
        );
        const content = rebuiltCascadeContent || (item.final_content ? String(item.final_content) : "");
        const imageUrls = parseSectionImageUrls(item.image_urls);
        const imagesHtml = includeImages ? buildSectionImagesHtml(imageUrls) : "";
        const combined = [content.trim(), imagesHtml].filter(Boolean).join("\n\n");
        if (combined) {
          // Determine a unique key: first occurrence keeps the base key, subsequent get _2, _3, â€¦
          keyCounters[baseKey] = (keyCounters[baseKey] || 0) + 1;
          const uniqueKey = keyCounters[baseKey] === 1 ? baseKey : `${baseKey}_${keyCounters[baseKey]}`;

          if (label) sectionLabels[uniqueKey] = label;
          sectionContent[uniqueKey] = combined;
          Object.assign(sectionPlaceholderValues, buildSectionPlaceholderAliases({ [uniqueKey]: combined }));
          Object.assign(
            sectionPlaceholderValues,
            buildCascadePlaceholderAliases(
              uniqueKey,
              item.lab_template_sections?.section_config,
              item.cascading_selections,
            ),
          );
          // Use the section's own test_group_id first; fall back to the result's
          // test_group_id for section-only groups where the section template is
          // not explicitly linked to a test group (test_group_id IS NULL).
          const groupId = item.lab_template_sections?.test_group_id
            ?? resultToGroupMap.get(item.result_id);
          if (groupId) {
            if (!sectionContentByGroup.has(groupId)) {
              sectionContentByGroup.set(groupId, {});
            }
            sectionContentByGroup.get(groupId)![uniqueKey] = combined;
          }
        }
      }
    }
    console.log(`ðŸ“ fetchSectionContent: ${data.length} row(s) â†’ ${Object.keys(sectionContent).length} unique section(s): [${Object.keys(sectionContent).join(", ")}]`);

    return { sectionContent, sectionLabels, sectionContentByGroup, sectionPlaceholderValues };
  } catch (err) {
    console.warn("Error fetching section content:", err);
    return { sectionContent: {}, sectionLabels: {}, sectionContentByGroup: new Map(), sectionPlaceholderValues: {} };
  }
}

/**
 * Format section content to HTML
 */
function formatSectionContentToHtml(content: string): string {
  if (!content) return "";

  const trimmed = content.trim();
  if (!trimmed) return "";

  if (/^\s*</.test(trimmed)) {
    return trimmed;
  }

  const renderMarkdownBold = (value: string) =>
    value.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

  const paragraphs = trimmed
    .split(/\n\n+/)
    .map((para) => para.trim())
    .filter(Boolean);

  const labeledParagraphs =
    paragraphs.length > 1 &&
    paragraphs.every((para) => /^\*\*.+?\*\*\s*[:\-]/.test(para));

  if (labeledParagraphs) {
    const items = paragraphs
      .map((para) => renderMarkdownBold(para.replace(/\n/g, "<br/>")))
      .map((para) => `<li>${para}</li>`)
      .join("");
    return `<ul>${items}</ul>`;
  }

  // Preserve basic formatting: convert newlines to proper HTML paragraphs/breaks
  // Content comes from doctor input (CKEditor), preserve formatting
  return paragraphs
    .map((para) => {
      if (/^\s*</.test(para)) {
        return para;
      }

      const lines = para.split(/\n/).map((line) => line.trim());
      const isBulletList = lines.length > 1 && lines.every((line) =>
        /^[-â€¢]\s+/.test(line)
      );

      if (isBulletList) {
        const items = lines
          .map((line) => line.replace(/^[-â€¢]\s+/, ""))
          .map((line) => renderMarkdownBold(line))
          .map((line) => `<li>${line}</li>`)
          .join("");
        return `<ul>${items}</ul>`;
      }

      // Convert single newlines to <br/> within paragraphs
      const withBreaks = renderMarkdownBold(para.replace(/\n/g, "<br/>"));
      return `<p>${withBreaks}</p>`;
    })
    .filter(Boolean)
    .join("");
}

function parseSectionImageUrls(imageUrls: unknown): string[] {
  if (!imageUrls) return [];
  if (Array.isArray(imageUrls)) {
    return imageUrls.filter((url) => typeof url === "string" && url.trim());
  }

  if (typeof imageUrls === "string") {
    try {
      const parsed = JSON.parse(imageUrls);
      if (Array.isArray(parsed)) {
        return parsed.filter((url) => typeof url === "string" && url.trim());
      }
    } catch {
      if (imageUrls.trim()) {
        return [imageUrls.trim()];
      }
    }
  }

  return [];
}

function buildSectionImagesHtml(imageUrls: string[]): string {
  if (!imageUrls.length) return "";

  const images = imageUrls
    .map((url) => url.trim())
    .filter(Boolean)
    .map((url) => applyAttachmentImageTransformations(url, 520))
    .map(
      (url) =>
        `<img class="section-image" src="${url}" alt="Section Image" style="max-width: 100%; height: auto; border: 1px solid #e5e7eb; border-radius: 6px;" />`,
    )
    .join("");

  if (!images) return "";

  return `
    <div class="section-images" style="display: flex; flex-wrap: wrap; gap: 10px; margin-top: 8px;">
      ${images}
    </div>
  `.trim();
}

/**
 * Inject section content into HTML by replacing section placeholders
 * Supports both formats:
 *   - {{section:key}} (prefixed format)
 *   - {{key}} (simple format used in Template Studio)
 * Returns: { html, uninjectedSections } - uninjectedSections contains sections that had no matching placeholder
 */
function normalizeSectionKey(
  key: string,
): { rawKey: string; originalKey: string } {
  const trimmed = (key || "").trim();
  if (!trimmed) {
    return { rawKey: "", originalKey: "" };
  }
  if (trimmed.toLowerCase().startsWith("section:")) {
    return { rawKey: trimmed.slice(8), originalKey: trimmed };
  }
  return { rawKey: trimmed, originalKey: trimmed };
}

function buildSectionPlaceholderAliases(
  sectionContent: Record<string, string>,
): Record<string, string> {
  const aliases: Record<string, string> = {};

  for (const [key, content] of Object.entries(sectionContent || {})) {
    if (!key || !content) continue;

    aliases[key] = content;

    const { rawKey } = normalizeSectionKey(key);
    if (rawKey && rawKey !== key) {
      aliases[rawKey] = content;
    }
    if (rawKey) {
      aliases[`section:${rawKey}`] = content;
    }
  }

  return aliases;
}

function buildCascadeContentFromConfig(
  sectionConfig: unknown,
  selections: unknown,
): string {
  const config = parseMaybeJsonObject(sectionConfig);
  if (config?.mode !== "cascading" || !Array.isArray(config?.cascade_levels)) {
    return "";
  }

  const selectionMap = parseMaybeJsonObject(selections);
  const lines: string[] = [];

  const traverse = (cascadeLevels: any[]) => {
    for (const level of cascadeLevels || []) {
      const selectedIds = Array.isArray(selectionMap[level?.id])
        ? selectionMap[level.id]
        : [];
      if (selectedIds.length === 0) continue;

      const options = Array.isArray(level?.options) ? level.options : [];
      const selectedOptions = options.filter((option: any) =>
        selectedIds.includes(option?.id)
      );
      const values = selectedIds
        .map((selectedId: any) => {
          const matchedOption = options.find((option: any) => option?.id === selectedId);
          return String(matchedOption?.value ?? selectedId ?? "").trim();
        })
        .filter(Boolean)
        .join(", ");

      if (values) {
        const label = String(level?.label || "").trim();
        lines.push(label ? `${label}: ${values}` : values);
      }

      for (const option of selectedOptions) {
        if (Array.isArray(option?.sub_levels)) {
          traverse(option.sub_levels);
        }
      }
    }
  };

  traverse(config.cascade_levels);
  return lines.join("\n");
}

function slugPlaceholderKey(value: string): string {
  return String(value || "")
    .replace(/{{|}}/g, "")
    .replace(/^section:/i, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function parseMaybeJsonObject(value: unknown): Record<string, any> {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : {};
    } catch {
      return {};
    }
  }
  return typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

function buildCascadePlaceholderAliases(
  sectionKey: string,
  sectionConfig: unknown,
  selections: unknown,
): Record<string, string> {
  const aliases: Record<string, string> = {};
  const sectionSlug = slugPlaceholderKey(sectionKey);
  const config = parseMaybeJsonObject(sectionConfig);
  const selectionMap = parseMaybeJsonObject(selections);
  const levels = Array.isArray(config?.cascade_levels) ? config.cascade_levels : [];

  const traverse = (cascadeLevels: any[]) => {
    for (const level of cascadeLevels || []) {
      const selectedIds = Array.isArray(selectionMap[level?.id])
        ? selectionMap[level.id]
        : [];
      const selectedOptions = Array.isArray(level?.options)
        ? level.options.filter((option: any) => selectedIds.includes(option?.id))
        : [];
      const value = selectedOptions
        .map((option: any) => String(option?.value || "").trim())
        .filter(Boolean)
        .join(", ");
      const levelSlug = slugPlaceholderKey(level?.label || level?.id || "");

      if (value && sectionSlug && levelSlug) {
        aliases[`${sectionSlug}_${levelSlug}`] = value;
        if (!aliases[levelSlug]) aliases[levelSlug] = value;
      }

      for (const option of selectedOptions) {
        if (Array.isArray(option?.sub_levels)) {
          traverse(option.sub_levels);
        }
      }
    }
  };

  traverse(levels);
  return aliases;
}

function injectSectionContent(
  html: string,
  sectionContent: Record<string, string>,
): { html: string; uninjectedSections: Record<string, string> } {
  if (!html || Object.keys(sectionContent).length === 0) {
    return { html, uninjectedSections: {} };
  }

  let resultHtml = html;
  const uninjectedSections: Record<string, string> = {};
  let injectedCount = 0;

  for (const [key, content] of Object.entries(sectionContent)) {
    if (!content) continue;

    const { rawKey, originalKey } = normalizeSectionKey(key);
    if (!rawKey) continue;

    // Try both placeholder formats:
    // 1. {{section:key}} - prefixed format
    // 2. {{key}} - simple format (used in Template Studio CKEditor)
    // 3. {{section:...}} stored directly as placeholder_key
    const prefixedPlaceholder = `{{section:${rawKey}}}`;
    const simplePlaceholder = `{{${rawKey}}}`;
    const originalPlaceholder = originalKey.startsWith("section:")
      ? `{{${originalKey}}}`
      : null;

    const formattedContent = formatSectionContentToHtml(content);
    // Add inline styles as fallback in case CSS doesn't load
    const wrappedContent =
      `<div class="section-content" style="font-family: 'Inter', Arial, sans-serif; font-size: 13px; line-height: 1.7; color: #1f2937;">${formattedContent}</div>`;

    let found = false;

    // Check prefixed format first
    if (
      resultHtml.includes(prefixedPlaceholder) ||
      resultHtml.toLowerCase().includes(prefixedPlaceholder.toLowerCase())
    ) {
      const prefixedRegex = new RegExp(
        prefixedPlaceholder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "gi",
      );
      resultHtml = resultHtml.replace(prefixedRegex, wrappedContent);
      found = true;
      injectedCount++;
      console.log(
        `ðŸ“ Injected section "${rawKey}" via {{section:${rawKey}}} placeholder`,
      );
    } // Check simple format (e.g., {{impression}})
    else if (
      resultHtml.includes(simplePlaceholder) ||
      resultHtml.toLowerCase().includes(simplePlaceholder.toLowerCase())
    ) {
      const simpleRegex = new RegExp(
        simplePlaceholder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "gi",
      );
      resultHtml = resultHtml.replace(simpleRegex, wrappedContent);
      found = true;
      injectedCount++;
      console.log(
        `ðŸ“ Injected section "${rawKey}" via {{${rawKey}}} placeholder`,
      );
    } // Check original placeholder (if key already includes section: prefix)
    else if (
      originalPlaceholder &&
      (resultHtml.includes(originalPlaceholder) ||
        resultHtml.toLowerCase().includes(originalPlaceholder.toLowerCase()))
    ) {
      const originalRegex = new RegExp(
        originalPlaceholder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "gi",
      );
      resultHtml = resultHtml.replace(originalRegex, wrappedContent);
      found = true;
      injectedCount++;
      console.log(
        `ðŸ“ Injected section "${rawKey}" via {{${originalKey}}} placeholder`,
      );
    }

    if (!found) {
      // No placeholder found - track for fallback rendering
      uninjectedSections[rawKey] = content;
    }
  }

  console.log(
    `ðŸ“ Injected ${injectedCount} section(s) via placeholders, ${
      Object.keys(uninjectedSections).length
    } need fallback:`,
    Object.keys(sectionContent),
  );

  return { html: resultHtml, uninjectedSections };
}

/**
 * Generate fallback HTML for sections that weren't injected via placeholders
 * This ensures sections are included even when templates don't have specific placeholders
 */
function generateFallbackSectionsHtml(
  uninjectedSections: Record<string, string>,
): string {
  if (Object.keys(uninjectedSections).length === 0) return "";

  const sectionsHtml = Object.entries(uninjectedSections)
    .map(([key, content]) => {
      const formattedContent = formatSectionContentToHtml(content);
      // Capitalize first letter and replace underscores with spaces for display
      const sectionTitle = key.charAt(0).toUpperCase() +
        key.slice(1).replace(/_/g, " ");

      return `
        <div class="report-section fallback-section" style="margin-top: 16px; padding: 12px 0; border-top: 1px solid #e5e7eb;">
          <h4 style="font-family: 'Inter', Arial, sans-serif; font-size: 13px; font-weight: 600; color: #374151; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px;">${sectionTitle}</h4>
          <div class="section-content" style="font-family: 'Inter', Arial, sans-serif; font-size: 13px; color: #1f2937; line-height: 1.7;">
            ${formattedContent}
          </div>
        </div>
      `;
    })
    .join("");

  console.log(
    `ðŸ“ Generated fallback HTML for ${
      Object.keys(uninjectedSections).length
    } section(s):`,
    Object.keys(uninjectedSections),
  );

  return sectionsHtml;
}

// ============================================================
// SECTION: Report Extras (Trend Charts, Clinical Summary)
// ============================================================

/**
 * Generate watermark HTML
 */
function generateWatermarkHtml(settings: {
  enabled: boolean;
  imageUrl: string;
  opacity: number;
  position: string;
  size: string;
  rotation: number;
}): string {
  if (!settings.enabled || !settings.imageUrl) return "";

  const positionStyles: Record<string, string> = {
    "center": "top: 50%; left: 50%; transform: translate(-50%, -50%)",
    "top-left": "top: 10%; left: 10%",
    "top-right": "top: 10%; right: 10%",
    "bottom-left": "bottom: 10%; left: 10%",
    "bottom-right": "bottom: 10%; right: 10%",
  };

  const position = positionStyles[settings.position] ||
    positionStyles["center"];
  const rotation = settings.rotation ? `rotate(${settings.rotation}deg)` : "";
  const transform = position.includes("translate")
    ? position.replace(")", ` ${rotation})`)
    : `${position}; transform: ${rotation}`;

  return `
    <div class="report-watermark" style="
      position: absolute !important;
      ${transform};
      z-index: 1 !important;
      opacity: ${settings.opacity} !important;
      pointer-events: none !important;
      max-width: ${settings.size} !important;
      height: auto !important;
    ">
      <img src="${settings.imageUrl}" alt="watermark" style="width: 100%; height: auto;" />
    </div>
  `;
}

/**
 * Format clinical summary text with proper HTML structure
 * Parses structured text with sections, bullets, and formatting
 */
function formatClinicalSummary(text: string): string {
  if (!text) return "";

  let html = text;

  // Convert **Section Headers** to bold with proper styling
  html = html.replace(
    /\*\*([^*]+)\*\*/g,
    '<div style="font-weight: bold; color: #1e40af; margin-top: 15px; margin-bottom: 8px; font-size: 14px;">$1</div>',
  );

  // Convert bullet points â€¢ to proper HTML lists
  const lines = html.split("\n");
  let inList = false;
  const processedLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line.startsWith("â€¢")) {
      if (!inList) {
        processedLines.push(
          '<ul style="margin: 8px 0; padding-left: 20px; list-style-type: disc;">',
        );
        inList = true;
      }
      const content = line.substring(1).trim();
      processedLines.push(
        `<li style="margin: 4px 0; color: #374151;">${content}</li>`,
      );
    } else {
      if (inList) {
        processedLines.push("</ul>");
        inList = false;
      }
      if (line) {
        // Check if it's a section header (already converted to div above)
        if (!line.includes('<div style="font-weight: bold')) {
          processedLines.push(
            `<p style="margin: 8px 0; color: #374151;">${line}</p>`,
          );
        } else {
          processedLines.push(line);
        }
      }
    }
  }

  if (inList) {
    processedLines.push("</ul>");
  }

  return processedLines.join("\n");
}

function escapeTrendHtml(value: any): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Format a patient's age with its unit word, e.g. 7 -> "7 Years", 1 -> "1 Year",
// 6 months -> "6 Months". Falls back to the raw value if it isn't numeric and to
// an empty string when no age is set.
function formatPatientAgeDisplay(
  age: unknown,
  ageUnit?: string | null,
): string {
  if (age === null || age === undefined || age === "") return "";
  const numAge = typeof age === "number" ? age : parseInt(String(age), 10);
  if (Number.isNaN(numAge)) return String(age);
  const unit = (ageUnit || "years").toLowerCase();
  const singular: Record<string, string> = { years: "Year", months: "Month", days: "Day" };
  const plural: Record<string, string> = { years: "Years", months: "Months", days: "Days" };
  const word = numAge === 1
    ? (singular[unit] || "Year")
    : (plural[unit] || "Years");
  return `${numAge} ${word}`;
}

function formatTrendDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return escapeTrendHtml(value);
  return date.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

function buildTrendHistoryTableHtml(chart: any): string {
  const data = Array.isArray(chart?.data) ? chart.data : [];
  if (data.length === 0) return "";

  const rows = data.slice().reverse().map((point: any) => `
    <tr>
      <td style="padding: 3px 6px; border: 1px solid #d1d5db; white-space: nowrap;">${formatTrendDateTime(point.order_date || point.date || point.timestamp || "")}</td>
      <td style="padding: 3px 6px; border: 1px solid #d1d5db; text-align: right; font-weight: 600;">${escapeTrendHtml(point.value)}</td>
    </tr>
  `).join("");

  return `
    <table style="border-collapse: collapse; width: 100%; margin: 0; font-size: 9px; line-height: 1.25;">
      <thead>
        <tr style="background: #f3f4f6;">
          <th style="padding: 4px 6px; border: 1px solid #d1d5db; text-align: left; font-weight: 700;">Date Time</th>
          <th style="padding: 4px 6px; border: 1px solid #d1d5db; text-align: right; font-weight: 700;">Result</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function buildTrendChartBlockHtml(chart: any): string {
  const imgSrc = chart?.image_base64 || chart?.image_url;
  if (!imgSrc) return "";

  const analyteName = chart?.analyte_name || "Test";
  const tableHtml = buildTrendHistoryTableHtml(chart);
  const meta = [
    chart?.unit ? `Unit: ${escapeTrendHtml(chart.unit)}` : "",
    chart?.reference_range ? `Ref: ${escapeTrendHtml(chart.reference_range)}` : "",
  ].filter(Boolean).join(" | ");

  return `<div class="trend-chart" style="margin: 10px 0 16px 0; page-break-inside: avoid; break-inside: avoid;">
    <div style="font-size: 12px; font-weight: 700; color: #111827; text-align: center; margin-bottom: 5px;">${escapeTrendHtml(analyteName)} Previous History</div>
    <div style="display: table; width: 100%; table-layout: fixed; border-collapse: separate; border-spacing: 8px 0;">
      <div style="display: table-cell; width: 62%; vertical-align: top;">
        <img src="${imgSrc}" alt="${escapeTrendHtml(analyteName)} trend" style="width: 100%; max-width: 100%; height: auto; border: 1px solid #d1d5db;" />
      </div>
      <div style="display: table-cell; width: 38%; vertical-align: top;">${tableHtml}</div>
    </div>
    ${meta ? `<div style="font-size: 9px; color: #4b5563; text-align: center; margin-top: 4px;">${meta}</div>` : ""}
  </div>`;
}

/**
 * Generate HTML for report extras (trend charts, clinical summary, AI summaries, patient summary)
 */
function generateReportExtrasHtml(extras: {
  trend_charts?: any[];
  clinical_summary?: string;
  trend_graph_data?: any;
  ai_clinical_summary?: string;
  ai_patient_summary?: string;
  patient_summary_language?: string;
  ai_doctor_summary?: string;
  include_trend_graphs?: boolean;
  results_extras?: any[];
  analyzer_histogram_svgs?: Array<{ test_code: string; name: string; associated_test?: string; boundaries?: any; svg_data?: string }>;
}): string {
  if (!extras) return "";

  let html = "";

  // Trend charts from report_extras table
  if (extras.trend_charts && extras.trend_charts.length > 0) {
    html +=
      '<div class="report-extras-trends" style="margin-top: 20px; page-break-inside: avoid;">';
    html += '<h3 style="margin-bottom: 10px;">Previous History</h3>';

    for (const chart of extras.trend_charts) {
      html += buildTrendChartBlockHtml(chart);
    }

    html += "</div>";
  }

  // Trend graph data from orders table (if include_trend_graphs is true)
  if (extras.include_trend_graphs !== false && extras.trend_graph_data) {
    const trendData = extras.trend_graph_data;
    if (trendData.image_base64 || trendData.svg) {
      html +=
        '<div class="report-trend-graph" style="margin-top: 20px; page-break-inside: avoid;">';
      html += '<h3 style="margin-bottom: 10px;">Trend Analysis</h3>';
      if (trendData.image_base64) {
        html +=
          `<img src="${trendData.image_base64}" alt="Trend Graph" style="max-width: 100%; height: auto;" />`;
      } else if (trendData.svg) {
        html += trendData.svg;
      }
      html += "</div>";
    }

  }

  // Analyzer histograms from analyzer_graphs table
  if (extras.analyzer_histogram_svgs && extras.analyzer_histogram_svgs.length > 0) {
    const svgRows = extras.analyzer_histogram_svgs.filter(r => r.svg_data);
    if (svgRows.length > 0) {
      html += '<div class="analyzer-graphs-section" style="margin-top: 25px; page-break-inside: avoid;">';
      html += '<h3 style="margin: 0 0 12px 0; color: #1e40af; font-size: 13px; font-weight: 700; border-bottom: 2px solid #3b82f6; padding-bottom: 6px;">Analyzer Histograms</h3>';
      html += '<div style="display: flex; flex-wrap: wrap; gap: 12px; justify-content: flex-start;">';
      for (const row of svgRows) {
        html += '<div style="text-align: center; flex: 0 0 auto;">';
        html += row.svg_data!;
        html += '</div>';
      }
      html += '</div>';
      html += '</div>';
    }
  }

  // Clinical summary from report_extras table
  if (extras.clinical_summary) {
    // Format clinical summary with proper HTML structure
    const formattedSummary = formatClinicalSummary(extras.clinical_summary);
    html +=
      '<div class="report-extras-summary clinical-summary-section" style="margin-top: 30px; border: 2px solid #3b82f6; border-radius: 8px; padding: 20px; background: #eff6ff;">';
    html +=
      '<h2 class="clinical-summary-title" style="margin: 0 0 15px 0; color: #1e40af; font-size: 18px; font-weight: bold; text-align: center; border-bottom: 2px solid #3b82f6; padding-bottom: 10px; page-break-after: avoid; break-after: avoid;">AI Clinical Interpretation</h2>';
    html +=
      `<div class="clinical-summary-content" style="font-size: 13px; line-height: 1.6; color: #1f2937;">${formattedSummary}</div>`;
    html += "</div>";
  }

  // AI Clinical Summary from orders table
  if (extras.ai_clinical_summary) {
    const formattedAiSummary = formatClinicalSummary(
      extras.ai_clinical_summary,
    );
    html +=
      '<div class="report-ai-summary" style="margin-top: 30px; border: 2px solid #3b82f6; border-radius: 8px; padding: 20px; background: #eff6ff;">';
    html +=
      '<h2 style="margin: 0 0 15px 0; color: #1e40af; font-size: 18px; font-weight: bold; text-align: center; border-bottom: 2px solid #3b82f6; padding-bottom: 10px; page-break-after: avoid; break-after: avoid;">AI Clinical Interpretation</h2>';
    html +=
      `<div style="font-size: 13px; line-height: 1.6; color: #1f2937;">${formattedAiSummary}</div>`;
    html += "</div>";
  }

  // AI Doctor Summary from reports table
  if (extras.ai_doctor_summary) {
    html +=
      '<div class="report-doctor-summary" style="margin-top: 20px;">';
    html += '<h3 style="margin-bottom: 10px; page-break-after: avoid; break-after: avoid;">Doctor\'s Summary</h3>';
    html +=
      `<div style="padding: 10px; background: #f9fafb; border-radius: 4px;">${extras.ai_doctor_summary}</div>`;
    html += "</div>";
  }

  // AI Patient Summary from orders table (patient-friendly explanation)
  if (extras.ai_patient_summary) {
    try {
      const patientSummary = typeof extras.ai_patient_summary === "string"
        ? JSON.parse(extras.ai_patient_summary)
        : extras.ai_patient_summary;

      const languageLabel = extras.patient_summary_language
        ? ` (${
          extras.patient_summary_language.charAt(0).toUpperCase() +
          extras.patient_summary_language.slice(1)
        })`
        : "";

      html +=
        '<div class="report-patient-summary" style="margin-top: 30px; border: 2px solid #db2777; border-radius: 8px; padding: 20px; background: #fdf2f8;">';
      html +=
        `<h2 style="margin: 0 0 15px 0; color: #be185d; font-size: 18px; font-weight: bold; text-align: center; border-bottom: 2px solid #db2777; padding-bottom: 10px; page-break-after: avoid; break-after: avoid;">Your Results Summary${languageLabel}</h2>`;

      // Health Status
      if (patientSummary.health_status) {
        html += '<div style="margin-bottom: 15px;">';
        html +=
          '<h3 style="margin: 0 0 8px 0; color: #be185d; font-size: 14px; font-weight: bold;">Overall Health Status</h3>';
        html +=
          `<p style="margin: 0; font-size: 13px; line-height: 1.5; color: #1f2937;">${patientSummary.health_status}</p>`;
        html += "</div>";
      }

      // Normal Findings - Support both detailed (new) and simple (legacy) formats
      if (
        patientSummary.normal_findings_detailed &&
        patientSummary.normal_findings_detailed.length > 0
      ) {
        // New detailed format with explanations
        html += '<div style="margin-bottom: 15px;">';
        html +=
          `<h3 style="margin: 0 0 8px 0; color: #16a34a; font-size: 14px; font-weight: bold;">âœ“ Normal Findings (${patientSummary.normal_findings_detailed.length} tests)</h3>`;
        for (const finding of patientSummary.normal_findings_detailed) {
          html +=
            '<div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 6px; padding: 10px; margin-bottom: 8px;">';
          html +=
            `<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">`;
          html +=
            `<span style="font-weight: bold; color: #166534; font-size: 13px;">${
              finding.test_name || "Test"
            }</span>`;
          html +=
            `<span style="background: #dcfce7; color: #166534; padding: 2px 8px; border-radius: 10px; font-size: 11px;">âœ“ Normal</span>`;
          html += "</div>";
          if (finding.value) {
            html +=
              `<p style="margin: 4px 0; font-size: 12px; color: #374151;"><strong>Value:</strong> ${finding.value}</p>`;
          }
          if (finding.what_it_measures) {
            html +=
              `<p style="margin: 4px 0; font-size: 12px; color: #1d4ed8;"><strong>What it measures:</strong> ${finding.what_it_measures}</p>`;
          }
          if (finding.your_result_means) {
            html +=
              `<p style="margin: 4px 0; font-size: 12px; color: #166534;"><strong>Your result:</strong> ${finding.your_result_means}</p>`;
          }
          html += "</div>";
        }
        html += "</div>";
      } else if (
        patientSummary.normal_findings &&
        patientSummary.normal_findings.length > 0
      ) {
        // Legacy simple format (array of strings)
        html += '<div style="margin-bottom: 15px;">';
        html +=
          '<h3 style="margin: 0 0 8px 0; color: #16a34a; font-size: 14px; font-weight: bold;">âœ“ Normal Findings</h3>';
        html +=
          '<ul style="margin: 0; padding-left: 20px; font-size: 13px; line-height: 1.6; color: #1f2937;">';
        for (const finding of patientSummary.normal_findings) {
          html += `<li>${finding}</li>`;
        }
        html += "</ul></div>";
      } else if (patientSummary.normal_findings_summary) {
        // Summary text format
        html += '<div style="margin-bottom: 15px;">';
        html +=
          '<h3 style="margin: 0 0 8px 0; color: #16a34a; font-size: 14px; font-weight: bold;">âœ“ Normal Findings</h3>';
        html +=
          `<p style="margin: 0; font-size: 13px; line-height: 1.5; color: #1f2937;">${patientSummary.normal_findings_summary}</p>`;
        html += "</div>";
      }

      // Abnormal Findings - Enhanced to support new fields
      if (
        patientSummary.abnormal_findings &&
        patientSummary.abnormal_findings.length > 0
      ) {
        html += '<div style="margin-bottom: 15px;">';
        html +=
          '<h3 style="margin: 0 0 8px 0; color: #dc2626; font-size: 14px; font-weight: bold;">âš  Areas Needing Attention</h3>';
        for (const finding of patientSummary.abnormal_findings) {
          // Handle both string and object formats for abnormal findings
          if (typeof finding === "string") {
            html +=
              `<div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 6px; padding: 10px; margin-bottom: 8px;">`;
            html +=
              `<p style="margin: 0; font-size: 13px; color: #1f2937;">${finding}</p>`;
            html += "</div>";
          } else {
            // Object format with detailed fields
            const findingName = finding.test_name || finding.name ||
              finding.parameter || finding.label || "Finding";
            const status = finding.status || "abnormal";
            const statusColor = status === "critical"
              ? "#b91c1c"
              : status === "high"
              ? "#dc2626"
              : status === "low"
              ? "#1d4ed8"
              : "#d97706";
            const statusBg = status === "critical"
              ? "#fee2e2"
              : status === "high"
              ? "#fee2e2"
              : status === "low"
              ? "#dbeafe"
              : "#fef3c7";
            const statusLabel = status === "critical"
              ? "âš ï¸ Critical"
              : status === "high"
              ? "â†‘ High"
              : status === "low"
              ? "â†“ Low"
              : "Abnormal";

            html += `<div style="background: ${statusBg}; border: 1px solid ${
              status === "critical" || status === "high"
                ? "#fecaca"
                : status === "low"
                ? "#bfdbfe"
                : "#fde68a"
            }; border-radius: 6px; padding: 10px; margin-bottom: 8px;">`;
            html +=
              `<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">`;
            html +=
              `<span style="font-weight: bold; color: ${statusColor}; font-size: 13px;">${findingName}</span>`;
            html +=
              `<span style="background: white; color: ${statusColor}; padding: 2px 8px; border-radius: 10px; font-size: 11px; border: 1px solid ${statusColor};">${statusLabel}</span>`;
            html += "</div>";
            if (finding.value) {
              html +=
                `<p style="margin: 4px 0; font-size: 12px; color: #374151;"><strong>Value:</strong> ${finding.value}</p>`;
            }
            if (finding.what_it_measures) {
              html +=
                `<p style="margin: 4px 0; font-size: 12px; color: #1d4ed8;"><strong>What it measures:</strong> ${finding.what_it_measures}</p>`;
            }
            if (finding.explanation) {
              html +=
                `<p style="margin: 4px 0; font-size: 12px; color: #92400e;"><strong>What this means:</strong> ${finding.explanation}</p>`;
            }
            if (finding.what_to_do) {
              html +=
                `<p style="margin: 4px 0; font-size: 12px; color: #7c3aed;"><strong>What to do:</strong> ${finding.what_to_do}</p>`;
            }
            if (finding.trend) {
              const trendEmoji = finding.trend === "improving"
                ? "ðŸ“ˆ"
                : finding.trend === "worsening"
                ? "ðŸ“‰"
                : finding.trend === "stable"
                ? "âž¡ï¸"
                : "ðŸ†•";
              const trendColor = finding.trend === "improving"
                ? "#16a34a"
                : finding.trend === "worsening"
                ? "#dc2626"
                : "#6b7280";
              html +=
                `<p style="margin: 4px 0; font-size: 11px; color: ${trendColor};"><strong>Trend:</strong> ${trendEmoji} ${
                  finding.trend.charAt(0).toUpperCase() + finding.trend.slice(1)
                }</p>`;
            }
            html += "</div>";
          }
        }
        html += "</div>";
      }

      // Consultation Recommendation - Support both field names
      const consultMessage = patientSummary.consultation_recommendation ||
        patientSummary.consultation_message;
      if (consultMessage) {
        html +=
          '<div style="margin-bottom: 15px; background: #fef2f2; padding: 12px; border-radius: 6px; border-left: 4px solid #dc2626;">';
        html +=
          `<h3 style="margin: 0 0 8px 0; color: #dc2626; font-size: 14px; font-weight: bold;">ðŸ“‹ ${
            patientSummary.needs_consultation
              ? "Doctor Consultation Recommended"
              : "Recommendation"
          }</h3>`;
        html +=
          `<p style="margin: 0; font-size: 13px; line-height: 1.5; color: #1f2937;">${consultMessage}</p>`;
        html += "</div>";
      }

      // Health Tips
      if (patientSummary.health_tips && patientSummary.health_tips.length > 0) {
        html += '<div style="margin-bottom: 10px;">';
        html +=
          '<h3 style="margin: 0 0 8px 0; color: #0891b2; font-size: 14px; font-weight: bold;">ðŸ’¡ Health Tips</h3>';
        html +=
          '<ul style="margin: 0; padding-left: 20px; font-size: 13px; line-height: 1.6; color: #1f2937;">';
        for (const tip of patientSummary.health_tips) {
          html += `<li>${tip}</li>`;
        }
        html += "</ul></div>";
      }

      // Summary Message (new field - warm closing note)
      if (patientSummary.summary_message) {
        html +=
          '<div style="margin-bottom: 10px; background: linear-gradient(135deg, #fdf2f8 0%, #fce7f3 100%); padding: 12px; border-radius: 6px; border: 1px solid #fbcfe8;">';
        html +=
          `<p style="margin: 0; font-size: 13px; line-height: 1.5; color: #be185d; font-style: italic; text-align: center;">ðŸ’– ${patientSummary.summary_message}</p>`;
        html += "</div>";
      }

      html +=
        '<p style="font-size: 11px; color: #6b7280; text-align: center; margin: 15px 0 0 0; font-style: italic;">This summary is for your understanding. Please consult your doctor for medical advice.</p>';
      html += "</div>";
    } catch (e) {
      // If JSON parsing fails, render as plain text
      console.log("Patient summary parsing failed, rendering as text:", e);
      html +=
        '<div class="report-patient-summary" style="margin-top: 30px; border: 2px solid #db2777; border-radius: 8px; padding: 20px; background: #fdf2f8;">';
      html +=
        '<h2 style="margin: 0 0 15px 0; color: #be185d; font-size: 18px; font-weight: bold; text-align: center; border-bottom: 2px solid #db2777; padding-bottom: 10px; page-break-after: avoid; break-after: avoid;">Your Results Summary</h2>';
      html +=
        `<div style="font-size: 13px; line-height: 1.6; color: #1f2937;">${extras.ai_patient_summary}</div>`;
      html += "</div>";
    }
  }

  return html;
}

// ============================================================
// SECTION: Attachment Processing
// ============================================================

/**
 * Apply ImageKit transformations to letterhead background for crisp A4 rendering.
 * Requests 2480px wide (A4 @ 300dpi), high quality, PNG format to eliminate
 * JPEG compression artifacts that cause brown/pixelated backgrounds.
 */
function applyLetterheadImageTransform(url: string): string {
  if (!url) return url;
  if (!url.includes("ik.imagekit.io")) return url;

  try {
    const urlObj = new URL(url);

    // If transformations already exist, replace them for letterhead-quality
    if (url.includes("/tr:")) {
      return url.replace(/\/tr:[^/]+/, "/tr:w-1240,h-1754,c-force,q-75,f-jpg"); // FIX: was w-2480,h-3508,q-95,f-png (~85% smaller)
    }
    if (url.includes("?tr=")) {
      return url.replace(/\?tr=[^&]+/, "?tr=w-1240,h-1754,c-force,q-75,f-jpg"); // FIX: was w-2480,h-3508,q-95,f-png
    }

    // Insert transformation path segment
    const pathParts = urlObj.pathname.split("/");
    const insertIndex = pathParts.findIndex((p: string) =>
      p && !p.includes(".")
    ) + 1;
    pathParts.splice(insertIndex, 0, "tr:w-1240,h-1754,c-force,q-75,f-jpg"); // FIX: was w-2480,h-3508,q-95,f-png
    urlObj.pathname = pathParts.join("/");

    console.log("ðŸ“¸ Applied letterhead ImageKit transform: 1240x1754 q75 jpg (reduced from 2480x3508 q95 png)");
    return urlObj.toString();
  } catch (e) {
    console.log("âš ï¸ Could not apply letterhead transform:", e);
    return url;
  }
}

async function fetchCkeTemplateLetterheadUrl(
  supabaseClient: any,
  labId: string,
): Promise<string | null> {
  try {
    const { data: asset, error } = await supabaseClient
      .from("lab_branding_assets")
      .select("imagekit_url, file_url")
      .eq("lab_id", labId)
      .eq("asset_type", "letterhead")
      .eq("is_active", true)
      .eq("is_default", true)
      .maybeSingle();

    if (error) {
      console.warn("CKE letterhead lookup failed:", error.message);
      return null;
    }

    return asset?.imagekit_url || asset?.file_url || null;
  } catch (error) {
    console.warn("CKE letterhead lookup failed:", error);
    return null;
  }
}

/**
 * Apply ImageKit transformations to resize attachment images for PDF
 * Uses half-page width (~400px for A4) with auto height
 */
function applyAttachmentImageTransformations(
  url: string,
  maxWidth: number = 400,
): string {
  if (!url) return "";

  // Only transform ImageKit URLs
  if (!url.includes("ik.imagekit.io")) return url;

  try {
    const urlObj = new URL(url);

    // Check if transformations already exist
    if (url.includes("/tr:") || url.includes("?tr=")) {
      // Append width transformation to existing
      if (url.includes("/tr:")) {
        return url.replace("/tr:", `/tr:w-${maxWidth},`);
      } else if (url.includes("?tr=")) {
        return url.replace("?tr=", `?tr=w-${maxWidth},`);
      }
    }

    // Add new transformation path for width constraint
    // Format: /tr:w-400,fo-auto/ (width 400px, focus auto)
    const pathParts = urlObj.pathname.split("/");
    // Find where to insert transformation (after imagekit ID)
    const insertIndex = pathParts.findIndex((p: string) =>
      p && !p.includes(".")
    ) + 1;
    pathParts.splice(insertIndex, 0, `tr:w-${maxWidth},fo-auto,q-90`);
    urlObj.pathname = pathParts.join("/");

    console.log(`ðŸ“¸ Applied ImageKit transform: w-${maxWidth} to attachment`);
    return urlObj.toString();
  } catch (e) {
    console.log("âš ï¸ Could not apply transformations to attachment URL:", e);
    return url;
  }
}

/**
 * Generate HTML for attachments included in report
 * Images are resized to half-page width (~400px) to prevent overflow
 */
function generateAttachmentsHtml(attachments: any[]): string {
  if (!attachments || attachments.length === 0) return "";

  const includedAttachments = attachments.filter((a) =>
    a.tag === "include_in_report"
  );
  if (includedAttachments.length === 0) return "";

  // A4 page content width is ~595px (210mm at 72dpi) minus margins
  // Half page = ~400px for comfortable display with caption
  const HALF_PAGE_WIDTH = 400;

  let html =
    '<div class="report-attachments" style="margin-top: 20px; page-break-before: always;">';
  html +=
    '<h3 style="margin-bottom: 15px; color: #374151; font-size: 16px; border-bottom: 2px solid #2563eb; padding-bottom: 8px;">Attachments</h3>';

  for (const attachment of includedAttachments) {
    const isImage = attachment.file_type?.startsWith("image/");

    // Prefer imagekit_url, fallback to file_url
    let imageUrl = attachment.imagekit_url || attachment.file_url;

    if (isImage && imageUrl) {
      // Apply ImageKit transformations for proper sizing
      imageUrl = applyAttachmentImageTransformations(imageUrl, HALF_PAGE_WIDTH);

      html +=
        `<div class="attachment-item" style="margin: 15px 0; page-break-inside: avoid; text-align: center;">`;
      html += `<img src="${imageUrl}" alt="${
        attachment.file_name || "Attachment"
      }" style="max-width: ${HALF_PAGE_WIDTH}px; height: auto; border: 1px solid #e5e7eb; border-radius: 4px;" />`;
      if (attachment.file_name) {
        html +=
          `<p style="font-size: 11px; color: #6b7280; text-align: center; margin-top: 8px; font-style: italic;">${attachment.file_name}</p>`;
      }
      html += `</div>`;
    }
  }

  html += "</div>";
  return html;
}

// ============================================================
// SECTION: Storage Operations
// ============================================================

type PdfVariant = "final" | "draft" | "print";

/**
 * Download PDF from PDF.co URL and upload to Supabase Storage
 */
async function uploadPdfToStorage(
  supabase: any,
  pdfUrl: string,
  orderId: string,
  labId: string,
  patientId: string,
  filename: string,
  variant: PdfVariant = "final",
  maxRetries: number = 3,
): Promise<{ path: string; publicUrl: string }> {
  console.log("ðŸ“¥ Downloading PDF from PDF.co...");

  // Download PDF with retry logic
  let pdfBuffer: ArrayBuffer | null = null;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`  ðŸ“¥ Download attempt ${attempt}/${maxRetries}...`);

      // Add timeout to prevent hanging connections
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

      const pdfResponse = await fetch(pdfUrl, {
        signal: controller.signal,
        headers: {
          "User-Agent": "Supabase-Edge-Function/1.0",
          "Accept": "application/pdf, */*",
        },
      });

      clearTimeout(timeoutId);

      if (!pdfResponse.ok) {
        throw new Error(`Failed to download PDF: ${pdfResponse.status}`);
      }

      pdfBuffer = await pdfResponse.arrayBuffer();
      console.log(`  âœ… Download successful: ${pdfBuffer.byteLength} bytes`);
      break; // Success, exit retry loop
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(
        `  âš ï¸ Download attempt ${attempt} failed:`,
        lastError.message,
      );

      if (attempt < maxRetries) {
        // Wait before retry with longer delays for PDF.co to finalize
        // PDF.co sometimes needs time to make files available
        const waitTime = Math.min(2000 * attempt, 10000); // 2s, 4s, 6s, 8s, 10s (all variants)
        console.log(`  â³ Waiting ${waitTime}ms before retry...`);
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
    }
  }

  if (!pdfBuffer) {
    if (pdfUrl) {
      console.warn(
        `âš ï¸ FINAL FALLBACK: Failed to download PDF after ${maxRetries} attempts but PDF.co URL exists. Using temporary URL.`,
      );
      return {
        path: "",
        publicUrl: pdfUrl,
      };
    }
    throw new Error(
      `Failed to download PDF after ${maxRetries} attempts: ${lastError?.message}`,
    );
  }

  const pdfBlob = new Blob([pdfBuffer], { type: "application/pdf" });

  // Generate storage path - use simple format like normal PDF flow
  // Normal flow uses: {orderId}_{timestamp}_{variant}.pdf in 'reports' bucket
  const timestamp = Date.now();
  const suffix = variant === "final" ? "" : `_${variant}`;
  const storageFileName = `${orderId}_${timestamp}${suffix}.pdf`;

  console.log(
    "ðŸ“¤ Uploading PDF to Supabase Storage (reports bucket):",
    storageFileName,
  );

  // Upload to Supabase Storage - use 'reports' bucket like normal flow
  const { data: uploadData, error: uploadError } = await supabase.storage
    .from("reports")
    .upload(storageFileName, pdfBlob, {
      contentType: "application/pdf",
      cacheControl: "3600",
      upsert: true, // Allow overwrite
    });

  if (uploadError) {
    throw new Error(`Storage upload failed: ${uploadError.message}`);
  }

  // Get public URL (using custom domain if configured)
  const publicUrl = getPublicStorageUrl("reports", storageFileName);

  console.log("âœ… PDF uploaded to storage:", publicUrl);
  console.log("ðŸ“¡ Using custom domain:", !!CUSTOM_REPORTS_DOMAIN);

  return {
    path: storageFileName,
    publicUrl,
  };
}

// ============================================================
// SECTION: Main Edge Function
// ============================================================

serve(async (req) => {
  // Top-level try-catch to ensure CORS headers are ALWAYS returned
  try {
    console.log("ðŸ“¥ Incoming request:", req.method, req.url);

    if (req.method === "OPTIONS") {
      console.log("ðŸ“‹ Handling OPTIONS preflight request");
      console.log("ðŸ“‹ CORS headers:", corsHeaders);
      return new Response(null, {
        status: 200,
        headers: corsHeaders,
      });
    }

    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      {
        auth: { autoRefreshToken: false, persistSession: false },
      },
    );

    const PDFCO_API_KEY = Deno.env.get("PDFCO_API_KEY") ?? "";

    // Inner try-catch for main logic
    try {
      const requestBody = await req.json();

      // Support both direct calls (orderId) and webhook payloads (record.order_id)
      // Webhook payloads from Supabase Database Webhooks include: { type, table, record, schema, old_record }
      const orderId = requestBody.orderId || requestBody.record?.order_id;
      const isDraft = requestBody.isDraft;
      const htmlOverride = requestBody.htmlOverride;
      const isManualDesign = requestBody.isManualDesign;
      const isWebhook = !!requestBody.record;
      const triggeredByUserId = requestBody.triggeredByUserId; // User ID who triggered this request (for WhatsApp integration)
      const { data: orderSettingsRow } = orderId
        ? await supabaseClient
          .from("orders")
          .select("report_settings")
          .eq("id", orderId)
          .maybeSingle()
        : { data: null };
      const orderReportSettings = (orderSettingsRow as any)?.report_settings || {};
      // Priority: request body â†’ per-order setting â†’ "standard"
      // Lab-level default (compactPrint.defaultMode) is applied further down after
      // pdfSettings is loaded (line ~6996), for webhook/auto-generation paths.
      const requestedPrintLayoutMode = requestBody.printLayoutMode ?? orderReportSettings?.printLayoutMode;
      const printLayoutMode = normalizePrintLayoutMode(requestedPrintLayoutMode);

      const savedPlannerEnabled =
        orderReportSettings?.compactPageAssignmentsManualOverride === true ||
        orderReportSettings?.compactPageAssignmentsAutoGenerated === true ||
        orderReportSettings?.groupOrderManualOverride === true;

      // Compact planner overrides from request body first, then saved order planner.
      const compactGroupOrderOverride: string[] | null = Array.isArray(requestBody.compactGroupOrder)
        ? (requestBody.compactGroupOrder as unknown[]).map(String).filter(Boolean)
        : savedPlannerEnabled && Array.isArray(orderReportSettings?.groupOrder)
          ? (orderReportSettings.groupOrder as unknown[]).map(String).filter(Boolean)
        : null;
      const compactPageAssignmentsOverride: Record<string, number> | null =
        requestBody.compactPageAssignments && typeof requestBody.compactPageAssignments === "object" && !Array.isArray(requestBody.compactPageAssignments)
          ? (requestBody.compactPageAssignments as Record<string, number>)
          : savedPlannerEnabled && orderReportSettings?.compactPageAssignments && typeof orderReportSettings.compactPageAssignments === "object" && !Array.isArray(orderReportSettings.compactPageAssignments)
            ? (orderReportSettings.compactPageAssignments as Record<string, number>)
          : null;
      const compactMaxClubbedAnalytesOverride: number | null =
        typeof requestBody.compactMaxClubbedAnalytes === "number" && requestBody.compactMaxClubbedAnalytes > 0
          ? requestBody.compactMaxClubbedAnalytes
          : typeof orderReportSettings?.compactMaxClubbedAnalytes === "number" && orderReportSettings.compactMaxClubbedAnalytes > 0
            ? orderReportSettings.compactMaxClubbedAnalytes
          : null;

      console.log(
        "â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•",
      );
      console.log("ðŸ“„ PDF AUTO-GENERATION (SERVER-SIDE)");
      console.log(
        "â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•",
      );
      console.log("Order ID:", orderId);
      console.log("Is Draft:", !!isDraft);
      console.log("Print Layout Mode:", printLayoutMode);
      console.log("Is Manual Design:", !!isManualDesign);
      console.log("Is Webhook Trigger:", isWebhook);
      console.log("Triggered By User ID:", triggeredByUserId || "N/A");
      console.log(
        "PDF.co API Key:",
        PDFCO_API_KEY ? "âœ… Present" : "âŒ MISSING",
      );

      if (!orderId) {
        return new Response(
          JSON.stringify({
            error:
              "orderId is required (pass orderId directly or via webhook record.order_id)",
          }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      // ========================================
      // MANUAL MODE: Bypass Template Logic
      // ========================================
      if (isManualDesign && htmlOverride) {
        console.log(
          "ðŸŽ¨ Manual Design detected. Bypassing template generation.",
        );

        const filename = `Report_${orderId}_${new Date().getTime()}.pdf`;

        // Send directly to PDF.co
        const pdfUrl = await sendHtmlToPdfCo(
          htmlOverride,
          filename,
          PDFCO_API_KEY,
          {
            margins: "0px 0px 0px 0px",
            paperSize: "A4",
            printBackground: true,
            displayHeaderFooter: false,
          },
        );

        console.log("âœ… PDF generated successfully via Manual Mode:", pdfUrl);

        // Upload to Storage
        const { publicUrl } = await uploadPdfToStorage(
          supabaseClient,
          pdfUrl,
          orderId,
          undefined, // lab_id
          "manual_patient", // patient_id placeholder
          filename,
          "final",
        );

        return new Response(
          JSON.stringify({
            success: true,
            pdfUrl: publicUrl,
            status: "completed",
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      // ========================================
      // PRE-CHECK: Order Readiness (Panel Status)
      // ========================================
      // Compact print is always a deliberate manual action from the UI and writes to
      // print_pdf_url (not pdf_url), so it must never be blocked by panel readiness.
      if (!isDraft && printLayoutMode !== "compact") {
        console.log("\nðŸ” Pre-check: Verifying order readiness...");
        const { data: readinessData, error: readinessError } =
          await supabaseClient
            .from("v_result_panel_status")
            .select("panel_ready")
            .eq("order_id", orderId);

        if (readinessError) {
          console.warn(
            "âš ï¸ Could not verify panel status (view might be missing), proceeding with caution:",
            readinessError.message,
          );
        } else if (readinessData) {
          const isReady = readinessData.length > 0 &&
            readinessData.every((r: any) => r.panel_ready);
          console.log(
            `  â†’ Panel status: ${isReady ? "âœ… READY" : "â³ NOT READY"}`,
            readinessData,
          );

          if (!isReady) {
            console.log(
              "â›” Order is not ready for final report. Skipping auto-generation.",
            );

            // If there's an existing queue item, update it to failed/skipped so it doesn't get stuck
            await supabaseClient
              .from("pdf_generation_queue")
              .update({
                status: "failed",
                error_message: "Skipped: Order panels not ready",
                progress_stage: "Skipped (Not Ready)",
                updated_at: new Date().toISOString(),
              })
              .eq("order_id", orderId);

            return new Response(
              JSON.stringify({
                success: false,
                message:
                  "Order is not ready (panels incomplete). Pass isDraft=true to force.",
                status: "skipped",
              }),
              {
                status: 200,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
              },
            );
          }
        }
      }

      if (!PDFCO_API_KEY) {
        return new Response(
          JSON.stringify({ error: "PDFCO_API_KEY not configured" }),
          {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      // ========================================
      // Step 1: Get or Create Job from Queue
      // ========================================
      console.log("\nðŸ“‹ Step 1: Fetching/creating job in queue...");

      // First, try to get existing job
      let { data: job, error: jobError } = await supabaseClient
        .from("pdf_generation_queue")
        .select("*")
        .eq("order_id", orderId)
        .maybeSingle();

      // If no job exists, create one (for manual/direct Edge function calls)
      if (!job) {
        console.log(
          "â„¹ï¸ No queue entry found, fetching lab_id and creating entry...",
        );

        // Get lab_id from the order
        const { data: orderData, error: orderError } = await supabaseClient
          .from("orders")
          .select("lab_id")
          .eq("id", orderId)
          .single();

        if (orderError || !orderData?.lab_id) {
          console.error(
            "âŒ Failed to fetch lab_id for order:",
            orderError?.message,
          );
          return new Response(
            JSON.stringify({
              error: "Order not found or missing lab_id",
              details: orderError?.message,
            }),
            {
              status: 404,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }

        // Use upsert to handle race conditions (if trigger created entry simultaneously)
        const { data: upsertData, error: upsertError } = await supabaseClient
          .from("pdf_generation_queue")
          .upsert({
            order_id: orderId,
            lab_id: orderData.lab_id,
            status: "pending",
            priority: 5,
            created_at: new Date().toISOString(),
          }, {
            onConflict: "order_id",
            ignoreDuplicates: false,
          })
          .select()
          .single();

        if (upsertError) {
          console.error(
            "âŒ Failed to upsert queue entry:",
            upsertError?.message,
          );
          return new Response(
            JSON.stringify({
              error: "Failed to create/update queue entry",
              details: upsertError?.message,
            }),
            {
              status: 500,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }

        job = upsertData;
        console.log(
          "âœ… Created/updated queue entry:",
          job.id,
          "for lab:",
          orderData.lab_id,
        );
      }

      // If job exists but is completed, check if we can return cached or must regenerate
      if (job.status === "completed") {
        console.log(
          "â™»ï¸ Job already completed, checking if PDF still exists...",
        );

        // Check if the PDF still exists in reports table
        const { data: existingReport, error: reportError } =
          await supabaseClient
            .from("reports")
            .select("id, pdf_url, print_pdf_url, report_type")
            .eq("order_id", orderId)
            .eq("report_type", "final")
            .maybeSingle();

        // Return cached only for standard (non-compact) requests when a final PDF exists.
        // Compact print always regenerates so the new page assignments are applied.
        if (existingReport && existingReport.pdf_url && printLayoutMode !== "compact") {
          console.log(
            "âœ… Final PDF already exists in reports table, returning existing URL",
          );
          return new Response(
            JSON.stringify({
              success: true,
              status: "completed",
              pdfUrl: existingReport.pdf_url,
              printPdfUrl: existingReport.print_pdf_url,
              message: "PDF already exists",
              cached: true,
            }),
            {
              status: 200,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }

        // PDF missing or compact print â†’ reset queue to regenerate
        console.log(
          printLayoutMode === "compact"
            ? "ðŸ”„ Compact print requested â€” regenerating with updated page plan..."
            : "âš ï¸ PDF missing from reports table, regenerating...",
        );
        const { data: resetJob, error: resetError } = await supabaseClient
          .from("pdf_generation_queue")
          .update({
            status: "pending",
            error_message: null,
            retry_count: 0,
            progress_stage: null,
            progress_percent: 0,
          })
          .eq("id", job.id)
          .select()
          .single();

        if (resetError) {
          console.error("âŒ Failed to reset job status:", resetError?.message);
        } else {
          job = resetJob;
          console.log("âœ… Job reset to pending");
        }
      }

      // Reset failed/skipped/error jobs to pending so the atomic claim below succeeds.
      // These statuses occur when a previous attempt was blocked (e.g. panel readiness)
      // or errored out; the caller is explicitly retrying so we should let it through.
      if (job.status === "failed" || job.status === "skipped" || job.status === "error") {
        console.log(`â™»ï¸ Job is in '${job.status}' state â€” resetting to pending for retry`);
        const { data: resetJob, error: resetError } = await supabaseClient
          .from("pdf_generation_queue")
          .update({
            status: "pending",
            error_message: null,
            retry_count: 0,
            progress_stage: null,
            progress_percent: 0,
          })
          .eq("id", job.id)
          .select()
          .single();

        if (resetError) {
          console.error("âŒ Failed to reset failed job:", resetError?.message);
        } else {
          job = resetJob;
          console.log("âœ… Failed/skipped job reset to pending");
        }
      }

      // Prevent duplicate processing - if already processing, return early
      if (job.status === "processing") {
        console.log("â³ Job already processing, skipping duplicate request");
        return new Response(
          JSON.stringify({
            message: "Already processing",
            status: "processing",
            jobId: job.id,
          }),
          {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      console.log("âœ… Job found:", {
        id: job.id,
        status: job.status,
        labId: job.lab_id,
      });

      // ========================================
      // Step 2: Mark as Processing (Atomic Update)
      // ========================================
      console.log("\nðŸ“ Step 2: Marking job as processing...");

      // Use atomic update with status check to prevent race conditions
      const { data: updatedJob, error: updateError } = await supabaseClient
        .from("pdf_generation_queue")
        .update({
          status: "processing",
          started_at: new Date().toISOString(),
          progress_stage: "Fetching report context...",
          progress_percent: 5,
        })
        .eq("id", job.id)
        .eq("status", "pending") // Only update if still pending
        .select()
        .single();

      // If update didn't find a pending job, another process got it first
      if (updateError || !updatedJob) {
        console.log("â³ Job was claimed by another process, skipping");
        return new Response(
          JSON.stringify({
            message: "Job claimed by another process",
            status: "skipped",
          }),
          {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      // ========================================
      // Step 3: Get Template Context (RPC)
      // ========================================
      console.log("\nðŸ“Š Step 3: Fetching template context via RPC...");
      const { data: context, error: contextError } = await supabaseClient.rpc(
        "get_report_template_context",
        { p_order_id: orderId },
      );

      if (contextError || !context) {
        console.error("âŒ Context fetch failed:", contextError?.message);
        await failJob(
          supabaseClient,
          job.id,
          `Context fetch failed: ${contextError?.message}`,
        );
        return new Response(
          JSON.stringify({
            error: "Context fetch failed",
            details: contextError?.message,
          }),
          {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      // Keep report rendering resilient when an RPC definition omits patient
      // custom fields or cannot resolve a collector stored as plain text.
      const [patientContextResult, orderContextResult] = await Promise.all([
        supabaseClient
          .from("patients")
          .select("custom_fields, age_unit")
          .eq("id", context.patientId)
          .maybeSingle(),
        supabaseClient
          .from("orders")
          .select(
            "sample_collected_by, account_id, location_id, collected_at_location_id, referring_doctor_id",
          )
          .eq("id", orderId)
          .maybeSingle(),
      ]);

      if (patientContextResult.error) {
        console.warn(
          "Failed to enrich report with patient custom fields:",
          patientContextResult.error.message,
        );
      } else {
        context.patient = {
          ...(context.patient || {}),
          custom_fields: patientContextResult.data?.custom_fields || {},
          age_unit: patientContextResult.data?.age_unit || "years",
        };
      }

      let { data: resultRemarkRows, error: resultRemarkError } = await supabaseClient
        .from("results")
        .select("id, test_group_id, notes, report_remark_enabled")
        .eq("order_id", orderId);
      if (resultRemarkError) {
        // Tolerate a deploy that lands ahead of the report_remark_enabled
        // migration rather than dropping every remark from the report.
        console.warn("Retrying report remarks without the print toggle:", resultRemarkError.message);
        ({ data: resultRemarkRows, error: resultRemarkError } = await supabaseClient
          .from("results")
          .select("id, test_group_id, notes")
          .eq("order_id", orderId));
      }
      if (resultRemarkError) {
        console.warn("Failed to load test-group report remarks:", resultRemarkError.message);
      }
      const groupRemarks = new Map<string, string>();
      for (const row of resultRemarkRows || []) {
        const remark = String(row.notes || "").trim();
        // An unticked remark stays in the database for reference but is not printed.
        if (row.test_group_id && remark && (row as any).report_remark_enabled !== false) {
          groupRemarks.set(row.test_group_id, remark);
        }
      }
      context.groupRemarks = Object.fromEntries(groupRemarks);

      const rawSampleCollectedBy =
        orderContextResult.data?.sample_collected_by || "";
      if (orderContextResult.error) {
        console.warn(
          "Failed to enrich report with raw collector value:",
          orderContextResult.error.message,
        );
      } else if (!context.order?.sampleCollectedBy && rawSampleCollectedBy) {
        context.order = {
          ...(context.order || {}),
          sampleCollectedBy: rawSampleCollectedBy,
        };
        context.placeholderValues = {
          ...(context.placeholderValues || {}),
          sampleCollectedBy: rawSampleCollectedBy,
        };
      }

      if (!orderContextResult.error && orderContextResult.data) {
        const accountId = orderContextResult.data.account_id;
        const collectionLocationId =
          orderContextResult.data.collected_at_location_id ||
          orderContextResult.data.location_id;
        const referringDoctorId = orderContextResult.data.referring_doctor_id;
        const [
          accountResult,
          collectionLocationResult,
          referringDoctorResult,
          processingLabResult,
        ] = await Promise
          .all([
            accountId
              ? supabaseClient
                .from("accounts")
                .select("name")
                .eq("id", accountId)
                .maybeSingle()
              : Promise.resolve({ data: null, error: null }),
            collectionLocationId
              ? supabaseClient
                .from("locations")
                .select("name")
                .eq("id", collectionLocationId)
                .maybeSingle()
              : Promise.resolve({ data: null, error: null }),
            referringDoctorId
              ? supabaseClient
                .from("doctors")
                .select("qualification")
                .eq("id", referringDoctorId)
                .maybeSingle()
              : Promise.resolve({ data: null, error: null }),
            // Processing centre = the lab's own main lab, resolved below.
            supabaseClient
              .from("labs")
              .select("name, default_processing_location_id")
              .eq("id", job.lab_id)
              .maybeSingle(),
          ]);

        if (accountResult.error) {
          console.warn(
            "Failed to enrich report with B2B account name:",
            accountResult.error.message,
          );
        }
        if (collectionLocationResult.error) {
          console.warn(
            "Failed to enrich report with collection location name:",
            collectionLocationResult.error.message,
          );
        }
        if (referringDoctorResult.error) {
          console.warn(
            "Failed to enrich report with referring doctor qualification:",
            referringDoctorResult.error.message,
          );
        }
        if (processingLabResult.error) {
          console.warn(
            "Failed to enrich report with processing centre:",
            processingLabResult.error.message,
          );
        }

        const b2bAccountName = accountResult.data?.name || "";
        const collectionCenter =
          collectionLocationResult.data?.name ||
          context.order?.collectionCenter ||
          context.order?.locationName ||
          "";
        const referringDoctorQualification = String(
          referringDoctorResult.data?.qualification || "",
        ).trim();

        // Prefer the location the lab nominated as its main lab, then any location
        // flagged as a processing centre, and finally the lab's own name so the
        // field never prints blank on a single-site lab.
        let processingCenter = "";
        const defaultProcessingLocationId =
          processingLabResult.data?.default_processing_location_id || null;
        if (defaultProcessingLocationId) {
          const { data: processingLocation } = await supabaseClient
            .from("locations")
            .select("name")
            .eq("id", defaultProcessingLocationId)
            .maybeSingle();
          processingCenter = processingLocation?.name || "";
        }
        if (!processingCenter) {
          const { data: flaggedLocation } = await supabaseClient
            .from("locations")
            .select("name")
            .eq("lab_id", job.lab_id)
            .eq("is_processing_center", true)
            .limit(1)
            .maybeSingle();
          processingCenter = flaggedLocation?.name || "";
        }
        if (!processingCenter) {
          processingCenter = processingLabResult.data?.name || "";
        }

        context.order = {
          ...(context.order || {}),
          collectionCenter,
          b2bAccountName,
          // Alias of b2bAccountName so the "Ref. Center" field can be picked
          // instead of "B2B / Account Name" without changing the data behind it.
          refCenter: b2bAccountName,
          processingCenter,
          referringDoctorQualification,
        };
        context.placeholderValues = {
          ...(context.placeholderValues || {}),
          collectionCenter,
          b2bAccountName,
          refCenter: b2bAccountName,
          processingCenter,
          referringDoctorQualification,
        };
      }

      // RPC returns nested structure: context.patient.name, context.order.sampleId, etc.
      console.log(
        "âœ… Context fetched (full structure):",
        JSON.stringify(context, null, 2).substring(0, 2000),
      );
      console.log("âœ… Context summary:", {
        patientName: context.patient?.name ||
          context.placeholderValues?.patientName,
        patientId: context.patientId,
        patientAge: context.patient?.age || context.placeholderValues?.age,
        patientGender: context.patient?.gender ||
          context.placeholderValues?.gender,
        sampleId: context.order?.sampleId ||
          context.placeholderValues?.sampleId,
        analytes: context.analytes?.length || 0,
        analytesWithValues: (context.analytes || []).filter((a: any) =>
          a.value != null && a.value !== ""
        ).length,
        testGroupIds: context.testGroupIds || [],
        analyteNames: (context.analytes || []).slice(0, 3).map((a: any) =>
          a.parameter || a.test_name || a.name || "unknown"
        ),
      });

      // Validate that we have actual test results.
      // For section-only groups, saved report-section content is a valid result
      // even when there are zero analyte rows in context.analytes.
      if (!context.analytes || context.analytes.length === 0) {
        console.warn("âš ï¸ No analytes found in context, checking for section-only report content...");

        let hasSectionOnlyContent = false;
        try {
          const { data: resultRows, error: resultError } = await supabaseClient
            .from("results")
            .select("id")
            .eq("order_id", orderId);

          if (resultError) {
            console.warn("âš ï¸ Failed to fetch result ids for section-only validation:", resultError.message);
          } else {
	            const resultIds = (resultRows || []).map((row: any) => row.id).filter(Boolean);
	            if (resultIds.length > 0) {
	              const {
	                sectionContent: scWithImages,
	                sectionLabels,
	                sectionContentByGroup: scByGroupWithImages,
	                sectionPlaceholderValues: scPlaceholderValuesWithImages,
	              } = await fetchSectionContent(supabaseClient, resultIds, true);
              const {
                sectionContent: scNoImages,
                sectionContentByGroup: scByGroupNoImages,
              } = await fetchSectionContent(supabaseClient, resultIds, false);

              hasSectionOnlyContent =
                Object.keys(scWithImages).length > 0 ||
                Object.keys(scNoImages).length > 0 ||
                scByGroupWithImages.size > 0 ||
                scByGroupNoImages.size > 0;

              if (hasSectionOnlyContent) {
                context.sectionContent = Object.keys(scWithImages).length > 0
                  ? scWithImages
                  : (context.sectionContent || {});
                context.sectionContentNoImages = Object.keys(scNoImages).length > 0
                  ? scNoImages
                  : (context.sectionContentNoImages || context.sectionContent || {});
                context.sectionLabels = sectionLabels;
	                context.sectionContentByGroup = scByGroupWithImages.size > 0
	                  ? scByGroupWithImages
	                  : (context.sectionContentByGroup || new Map());
	                const sectionOnlyGroupIds = Array.from(context.sectionContentByGroup.keys());
	                if (sectionOnlyGroupIds.length > 0) {
	                  context.testGroupIds = Array.from(new Set([
	                    ...(context.testGroupIds || []),
	                    ...sectionOnlyGroupIds,
	                  ]));
	                }
	                context.placeholderValues = {
	                  ...(context.placeholderValues || {}),
	                  ...buildSectionPlaceholderAliases(context.sectionContent || {}),
	                  ...scPlaceholderValuesWithImages,
	                };
              }
            }
          }
        } catch (sectionValidationError) {
          console.warn("âš ï¸ Section-only validation failed:", sectionValidationError);
        }

        if (!hasSectionOnlyContent) {
          console.error("âŒ No analytes or section-only content found in context");
          await failJob(
            supabaseClient,
            job.id,
            "No test results found for this order",
          );
          return new Response(
            JSON.stringify({ error: "No test results found for this order" }),
            {
              status: 500,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }
      }

      // Check if analytes have values
      const analytesWithValues = context.analytes.filter((a: any) =>
        a.value != null && a.value !== ""
      );
      if (analytesWithValues.length === 0) {
        console.warn("âš ï¸ WARNING: All analytes have empty values!");
      }

      // ========================================
      // Step 3a: Filter out canceled tests
      // ========================================
      console.log("\nðŸš« Step 3a: Filtering canceled tests...");

      // Get canceled test_group_ids from order_tests
      const { data: canceledTests } = await supabaseClient
        .from("order_tests")
        .select("test_group_id")
        .eq("order_id", orderId)
        .eq("is_canceled", true);

      const canceledTestGroupIds = new Set(
        (canceledTests || []).map((t: any) => t.test_group_id).filter(Boolean),
      );

      if (canceledTestGroupIds.size > 0) {
        console.log(
          `ðŸ“‹ Found ${canceledTestGroupIds.size} canceled test group(s):`,
          Array.from(canceledTestGroupIds),
        );

        // Filter out analytes from canceled test groups
        const originalCount = context.analytes?.length || 0;
        context.analytes = (context.analytes || []).filter((a: any) => {
          const testGroupId = a.test_group_id || a.testGroupId;
          if (testGroupId && canceledTestGroupIds.has(testGroupId)) {
            return false; // Exclude this analyte
          }
          return true;
        });

        // Also filter testGroupIds array
        if (context.testGroupIds) {
          context.testGroupIds = context.testGroupIds.filter((id: string) =>
            !canceledTestGroupIds.has(id)
          );
        }

        console.log(
          `âœ… Filtered analytes: ${originalCount} â†’ ${context.analytes.length} (removed ${
            originalCount - context.analytes.length
          } from canceled tests)`,
        );
      } else {
        console.log("âœ… No canceled tests found - including all analytes");
      }

      // Deduplicate analytes by (test_group_id, analyte_id) â€” guards against
      // duplicate result_values rows from multiple results records for same test group
	      {
	        const seen = new Set<string>();
	        const deduped: any[] = [];
	        for (const a of (context.analytes || [])) {
	          const identity = getAnalyteIdentityIds(a)[0] || a.parameter || a.name || "";
	          const key = `${a.test_group_id ?? a.testGroupId ?? ""}|${identity}`;
          if (!seen.has(key)) {
            seen.add(key);
            deduped.push(a);
          }
        }
        if (deduped.length < (context.analytes?.length ?? 0)) {
          console.log(`âš ï¸ Removed ${(context.analytes?.length ?? 0) - deduped.length} duplicate analyte(s) from context`);
	          context.analytes = deduped;
	        }
	      }

	      // Enrich analytes with per-test-group display options, such as
	      // same-row sibling display for Differential % + Absolute Count.
	      try {
	        const groupIdsForDisplayOptions = [
	          ...new Set((context.analytes || []).map((a: any) => a.test_group_id || a.testGroupId).filter(Boolean)),
	        ];
	        if (groupIdsForDisplayOptions.length > 0) {
	          const { data: tgaDisplayRows, error: tgaDisplayError } = await supabaseClient
	            .from("test_group_analytes")
	            .select("test_group_id, analyte_id, lab_analyte_id, report_display_options")
	            .in("test_group_id", groupIdsForDisplayOptions);

	          if (tgaDisplayError) {
	            console.warn("âš ï¸ Failed to load analyte report display options:", tgaDisplayError.message);
	          } else {
		            const optionsByKey = new Map<string, any>();
		            let configuredSameRowCount = 0;
		            for (const row of tgaDisplayRows || []) {
		              const options = row.report_display_options || {};
		              if (options?.sameRowSiblingAnalyteId) configuredSameRowCount += 1;
		              for (const id of getAnalyteIdentityIds(row)) {
		                optionsByKey.set(`${row.test_group_id}|${id}`, options);
		              }
		            }
		            let enrichedSameRowCount = 0;
		            context.analytes = (context.analytes || []).map((a: any) => {
		              const groupId = a.test_group_id || a.testGroupId || "";
		              const matchedOptions = getAnalyteIdentityIds(a)
		                .map((id) => optionsByKey.get(`${groupId}|${id}`))
		                .find(Boolean);
		              if (matchedOptions?.sameRowSiblingAnalyteId) enrichedSameRowCount += 1;
		              return {
		                ...a,
		                report_display_options: matchedOptions || a.report_display_options || {},
		              };
		            });
		            console.log("[basic-template] report display options loaded:", {
		              groups: groupIdsForDisplayOptions.length,
		              rows: tgaDisplayRows?.length || 0,
		              configuredSameRowCount,
		              enrichedSameRowCount,
		            });
	          }
	        }
	      } catch (displayOptionsError) {
	        console.warn("âš ï¸ Unexpected error enriching report display options:", displayOptionsError);
	      }

	      // ========================================
	      // Step 3a.1: Enrich section content with image URLs (ecopy only)
      // ========================================
      try {
        const { data: resultRows, error: resultError } = await supabaseClient
          .from("results")
          .select("id")
          .eq("order_id", orderId);

        if (resultError) {
          console.warn(
            "âš ï¸ Failed to fetch result ids for section images:",
            resultError.message,
          );
        } else {
          const resultIds = (resultRows || [])
            .map((row: any) => row.id)
            .filter(Boolean);

	          if (resultIds.length > 0) {
            const { sectionContent: scWithImages, sectionLabels, sectionContentByGroup: scByGroupWithImages, sectionPlaceholderValues: scPlaceholderValuesWithImages } = await fetchSectionContent(
              supabaseClient,
              resultIds,
              true,
	            );
            const { sectionContent: scNoImages, sectionContentByGroup: scByGroupNoImages } = await fetchSectionContent(
              supabaseClient,
              resultIds,
              false,
            );

            const withImages = Object.keys(scWithImages).length > 0
              ? scWithImages
              : (context.sectionContent || {});
            const noImages = Object.keys(scNoImages).length > 0
              ? scNoImages
              : (context.sectionContent || {});

	            context.sectionContent = withImages;
	            context.sectionContentNoImages = noImages;
	            context.sectionLabels = sectionLabels;
	            context.sectionContentByGroup = scByGroupWithImages.size > 0 ? scByGroupWithImages : (context.sectionContentByGroup || new Map());
	            const sectionGroupIds = Array.from(context.sectionContentByGroup.keys());
	            if (sectionGroupIds.length > 0) {
	              context.testGroupIds = Array.from(new Set([
	                ...(context.testGroupIds || []),
	                ...sectionGroupIds,
	              ]));
	            }
	            context.placeholderValues = {
	              ...(context.placeholderValues || {}),
	              ...buildSectionPlaceholderAliases(withImages),
	              ...scPlaceholderValuesWithImages,
	            };
          }
        }
      } catch (err) {
        console.warn("âš ï¸ Section image enrichment failed:", err);
      }

      await updateProgress(
        supabaseClient,
        job.id,
        "Fetching lab template...",
        15,
      );

      // ========================================
      // Step 3b: Enhance Analytes with Flag Determination
      // ========================================
      console.log(
        "\nðŸ·ï¸ Step 3b: Enhancing analytes with flag determination...",
      );
      const patientGender = context.patient?.gender ||
        context.placeholderValues?.gender;

      if (context.analytes && context.analytes.length > 0) {
        context.analytes = context.analytes.map((analyte: any) => {
          // If flag already exists and is valid, keep it
          if (analyte.flag && analyte.flag.trim()) {
            return analyte;
          }

          // Determine flag using comprehensive system
          const { displayFlag, flag } = determineFlag(
            analyte.value,
            analyte.reference_range,
            analyte.low_critical,
            analyte.high_critical,
            patientGender,
            analyte.reference_range_male,
            analyte.reference_range_female,
            analyte.expected_normal_values,
          );

          return {
            ...analyte,
            flag: displayFlag,
            flag_code: flag, // Expose raw flag code (high, low, etc.) for CSS class generation
          };
        });

        const flaggedCount = context.analytes.filter((a: any) =>
          a.flag && a.flag.trim()
        ).length;
        console.log(
          `âœ… Flag determination complete: ${flaggedCount}/${context.analytes.length} analytes have flags`,
        );
      }

      await updateProgress(
        supabaseClient,
        job.id,
        "Fetching lab template...",
        15,
      );

      // ========================================
      // Step 4: Get Lab Template & Settings
      // ========================================
      console.log("\nðŸŽ¨ Step 4: Fetching lab templates & settings...");

      // Get all templates for this lab
      const { data: allTemplates, error: templateError } = await supabaseClient
        .from("lab_templates")
        .select("*")
        .eq("lab_id", job.lab_id);

      const templatesWithHtml = (allTemplates || []).filter((tpl: any) =>
        tpl?.gjs_html
      );

      console.log(
        "ðŸ“‹ Available templates:",
        templatesWithHtml.map((t: any) => ({
          name: t.template_name,
          testGroupId: t.test_group_id || "none",
          isDefault: t.is_default,
          isInterpretationOnly: !!t.is_interpretation_only,
        })),
      );

      await updateProgress(
        supabaseClient,
        job.id,
        "Fetching lab settings...",
        25,
      );

      // ========================================
      // Step 5: Get Lab Settings (Header/Footer/PDF Settings/Watermark)
      // ========================================
      console.log("\nâš™ï¸ Step 5: Fetching lab settings...");
      const { data: labSettings, error: labSettingsError } = await supabaseClient
        .from("labs")
        .select(`
        name,
        default_report_header_html, 
        default_report_footer_html, 
        pdf_layout_settings,
        pdf_letterhead_mode,
        watermark_enabled,
        watermark_image_url,
        watermark_opacity,
        watermark_position,
        watermark_size,
        watermark_rotation,
        default_template_style,
        show_methodology,
        show_interpretation,
        report_patient_info_config,
        flag_options
      `)
        .eq("id", job.lab_id)
        .single();

      if (labSettingsError) {
        console.error("  âŒ Lab settings query error:", labSettingsError.message);
      }

      // Fetch custom patient field configs for this lab (for dynamic PDF fields)
      const { data: customPatientFieldConfigs } = await supabaseClient
        .from('lab_patient_field_configs')
        .select('field_key, label, sort_order')
        .eq('lab_id', job.lab_id)
        .order('sort_order');

      const pdfLetterheadMode = labSettings?.pdf_letterhead_mode || 'background';
      console.log("  ðŸ“‹ PDF Letterhead Mode:", pdfLetterheadMode);

      // Variables for both modes
      let letterheadUrl: string | null = null;
      let headerFooterHtml: { headerHtml: string; footerHtml: string } = { headerHtml: '', footerHtml: '' };

      if (pdfLetterheadMode === 'header_footer') {
        // MODE: Separate Header/Footer Images
        // Fetch header and footer separately, convert to base64 for PDF.co native header/footer
        console.log("  ðŸ–¼ï¸ Fetching SEPARATE header/footer images (header_footer mode)...");
        const { headerUrl, footerUrl } = await fetchHeaderFooterImages(
          supabaseClient,
          orderId,
          job.lab_id,
        );

        console.log("  ðŸ“ Header URL:", headerUrl ? "FOUND" : "NOT FOUND");
        console.log("  ðŸ“ Footer URL:", footerUrl ? "FOUND" : "NOT FOUND");

        // Prefer optimized ImageKit URLs for native PDF.co header/footer rendering.
        // Large base64 data URIs can fail when branding images are wide/full-bleed banners.
        const pdfLayoutSettings = labSettings?.pdf_layout_settings || {};
        const headerHeight = pdfLayoutSettings?.headerHeight || 90;
        const footerHeight = pdfLayoutSettings?.footerHeight || 80;

        const optimizedHeaderUrl = headerUrl
          ? optimizeHeaderFooterImageUrl(headerUrl, 'header', headerHeight)
          : '';
        const optimizedFooterUrl = footerUrl
          ? optimizeHeaderFooterImageUrl(footerUrl, 'footer', footerHeight)
          : '';

        let headerSrc = optimizedHeaderUrl;
        let footerSrc = optimizedFooterUrl;

        console.log("  ðŸ–¼ï¸ Header source strategy:", headerUrl?.includes('ik.imagekit.io')
          ? "optimized-imagekit-url"
          : "original-url-or-base64");
        console.log("  ðŸ–¼ï¸ Footer source strategy:", footerUrl?.includes('ik.imagekit.io')
          ? "optimized-imagekit-url"
          : "original-url-or-base64");

        if (headerUrl) {
          const headerBase64 = await imageUrlToBase64(optimizedHeaderUrl || headerUrl);
          if (headerBase64) {
            headerSrc = headerBase64;
            console.log(headerUrl.includes('ik.imagekit.io')
              ? "  âœ… Header optimized via ImageKit and converted to base64"
              : "  âœ… Header converted to base64");
          } else {
            console.log("  âš ï¸ Header base64 failed, using URL fallback");
          }
        }

        if (footerUrl) {
          const footerBase64 = await imageUrlToBase64(optimizedFooterUrl || footerUrl);
          if (footerBase64) {
            footerSrc = footerBase64;
            console.log(footerUrl.includes('ik.imagekit.io')
              ? "  âœ… Footer optimized via ImageKit and converted to base64"
              : "  âœ… Footer converted to base64");
          } else {
            console.log("  âš ï¸ Footer base64 failed, using URL fallback");
          }
        }

        // Build header/footer HTML for PDF.co
        const sideMargins = {
          left: Number(pdfLayoutSettings?.margins?.left ?? 20),
          right: Number(pdfLayoutSettings?.margins?.right ?? 20),
        };

        headerFooterHtml = {
          headerHtml: headerSrc ? buildHeaderHtml(headerSrc, headerHeight, sideMargins) : '',
          footerHtml: footerSrc ? buildFooterHtml(footerSrc, footerHeight, sideMargins) : '',
        };

        console.log("  âœ… Header/Footer mode configured:",
          "header:", headerFooterHtml.headerHtml.length, "chars,",
          "footer:", headerFooterHtml.footerHtml.length, "chars");
        console.log("  â†”ï¸ Header/Footer bleed margins:", sideMargins);

        // letterheadUrl stays null â€” no background image in this mode
      } else {
        // MODE: Full-page Background (default/current behavior)
        // FETCH LETTERHEAD BACKGROUND IMAGE (Full-page background approach)
        // Priority: B2B Account > Location > Lab
        console.log("  ðŸ–¼ï¸ Fetching letterhead background image (background mode)...");
        console.log("  ðŸ“ Order ID:", orderId, "| Lab ID:", job.lab_id);
        const letterheadBackgroundUrl = await fetchLetterheadBackgroundForOrder(
          supabaseClient,
          orderId,
          job.lab_id,
        );

        // Apply ImageKit transforms for high-quality A4 rendering (2480x3508 @ 300dpi)
        letterheadUrl = letterheadBackgroundUrl
          ? applyLetterheadImageTransform(letterheadBackgroundUrl)
          : null;

        console.log(
          "  ðŸŽ¨ Letterhead Background URL:",
          letterheadUrl || "NOT FOUND",
        );
        if (letterheadUrl) {
          console.log(
            "  âœ… Using letterhead background:",
            letterheadUrl,
          );
        } else {
          console.log("  âš ï¸ No letterhead background found, using plain layout");
        }
      }

      // The lab's Result Flag Options ride along inside printOptions so every
      // renderer that already receives printOptions can gate the printed flag
      // letter without a new parameter on each template function.
      const labFlagCodes = resolveConfiguredFlagCodes(labSettings?.flag_options);
      const pdfSettingsRaw = (labSettings?.pdf_layout_settings || {}) as Record<string, any>;
      const pdfSettings = labFlagCodes
        ? {
          ...pdfSettingsRaw,
          printOptions: { ...(pdfSettingsRaw.printOptions || {}), _labFlagCodes: labFlagCodes },
        }
        : pdfSettingsRaw;
      console.log("  🏷️ Printable flag codes:", labFlagCodes ? labFlagCodes.join(", ") : "(all — lab has none configured)");
      const ckeTemplateLetterheadUrl = templatesWithHtml.length > 0
        ? applyLetterheadImageTransform(
          await fetchCkeTemplateLetterheadUrl(supabaseClient, job.lab_id) || "",
        ) || null
        : null;

      if (ckeTemplateLetterheadUrl) {
        console.log("  CKE template letterhead background found");
      }

      // result_colors lives inside pdf_layout_settings.resultColors (not a separate column)

      // Watermark settings
      const watermarkSettings = {
        enabled: labSettings?.watermark_enabled || false,
        imageUrl: labSettings?.watermark_image_url || "",
        opacity: labSettings?.watermark_opacity ?? 0.15,
        position: labSettings?.watermark_position || "center",
        size: labSettings?.watermark_size || "80%",
        rotation: labSettings?.watermark_rotation ?? 0,
      };

      // ========================================
      // Step 5b: Get Signatory Info (Approver fallback to Lab Default)
      // ========================================
      console.log("\nâœï¸ Step 5b: Fetching signatory information...");

      interface SignatoryInfo {
        signatoryName: string;
        signatoryDesignation: string;
        signatoryImageUrl: string;
      }

      // Helper to apply ImageKit transformations for signatures
      // Adds non-AI ImageKit transforms for sizing/focus only.
      const applySignatureTransformations = (url: string): string => {
        if (!url) return "";
        // If it's an ImageKit URL, add transformations
        if (url.includes("ik.imagekit.io")) {
          // Parse the URL and add transformations
          try {
            const urlObj = new URL(url);
            // Check if transformations already exist
            if (!url.includes("tr=")) {
              // Add transformation path
              const pathParts = urlObj.pathname.split("/");
              // Insert transformations after the imagekit path identifier
              const insertIndex = pathParts.findIndex((p: string) =>
                p && !p.includes(".")
              ) + 1;
              pathParts.splice(insertIndex, 0, "tr:fo-auto,t-true");
              urlObj.pathname = pathParts.join("/");
              return urlObj.toString();
            }
          } catch (e) {
            // If URL parsing fails, return as-is
            console.log(
              "    â†’ Could not apply transformations to signature URL",
            );
          }
        }
        return url;
      };

      // Try to get the approver/verifier from results for this order
      let signatoryInfo: SignatoryInfo = {
        signatoryName: "Authorized Signatory",
        signatoryDesignation: "",
        signatoryImageUrl: "",
      };

      try {
        // First, get any verified result to find the approver
        const { data: verifiedResult } = await supabaseClient
          .from("result_values")
          .select(`
          verified_by,
          users!result_values_verified_by_fkey(
            id,
            name,
            role,
            department
          )
        `)
          .eq("result_id", orderId)
          .not("verified_by", "is", null)
          .limit(1)
          .maybeSingle();

        // If no result found by result_id, try via results table
        let verifierUserId = verifiedResult?.verified_by as string | null;
        let verifierName = (verifiedResult?.users as any)?.name as
          | string
          | null;
        let verifierRole = (verifiedResult?.users as any)?.role as
          | string
          | null;
        let verifierDepartment = (verifiedResult?.users as any)?.department as
          | string
          | null;

        if (!verifierUserId) {
          // Try via results table joined with result_values
          const { data: resultWithVerifier } = await supabaseClient
            .from("results")
            .select(`
            id,
            result_values(
              verified_by,
              users!result_values_verified_by_fkey(id, name, role, department)
            )
          `)
            .eq("order_id", orderId)
            .limit(1)
            .maybeSingle();

          if (resultWithVerifier?.result_values) {
            const rv = Array.isArray(resultWithVerifier.result_values)
              ? resultWithVerifier.result_values.find((v: any) => v.verified_by)
              : resultWithVerifier.result_values;
            if (rv?.verified_by) {
              verifierUserId = rv.verified_by;
              verifierName = (rv.users as any)?.name;
              verifierRole = (rv.users as any)?.role;
              verifierDepartment = (rv.users as any)?.department;
            }
          }
        }

        // If still no verifier found, check the orders.approved_by field
        if (!verifierUserId) {
          const { data: orderApprover } = await supabaseClient
            .from("orders")
            .select(`
            approved_by,
            users!orders_approved_by_fkey(id, name, role, department)
         `)
            .eq("id", orderId)
            .maybeSingle();

          if (orderApprover?.approved_by) {
            verifierUserId = orderApprover.approved_by;
            verifierName = (orderApprover.users as any)?.name;
            verifierRole = (orderApprover.users as any)?.role;
            verifierDepartment = (orderApprover.users as any)?.department;
            console.log("  â†’ Verifier found via orders.approved_by");
          }
        }

        console.log(
          "  â†’ Final Verifier ID:",
          verifierUserId ? `${verifierName} (${verifierUserId})` : "None",
        );

        // If we have a verifier, check if they have a signature (prioritize default)
        if (verifierUserId) {
          const { data: userSignature } = await supabaseClient
            .from("lab_user_signatures")
            .select(
              "imagekit_url, file_url, signature_name, is_default, variants",
            )
            .eq("user_id", verifierUserId)
            .eq("lab_id", job.lab_id)
            .eq("is_active", true)
            .order("is_default", { ascending: false }) // Default first
            .limit(1)
            .maybeSingle();

          if (userSignature) {
            // Priority: variants.optimized > imagekit_url with transforms > file_url
            let sigUrl: string | null = null;

            // Try to get optimized variant first (has background removal)
            if (userSignature.variants) {
              const variants = typeof userSignature.variants === "string"
                ? JSON.parse(userSignature.variants)
                : userSignature.variants;
              if (variants?.optimized) {
                sigUrl = variants.optimized;
                console.log(
                  "  âœ… Using optimized variant (bg removed):",
                  sigUrl,
                );
              }
            }

            // Fallback to imagekit_url with transforms
            if (!sigUrl && userSignature.imagekit_url) {
              sigUrl = applySignatureTransformations(
                userSignature.imagekit_url,
              );
              console.log("  âœ… Using imagekit_url with transforms");
            }

            // Final fallback to file_url
            if (!sigUrl && userSignature.file_url) {
              sigUrl = userSignature.file_url;
              console.log("  âœ… Using file_url fallback");
            }

            if (sigUrl) {
              // Prioritize signature_name from lab_user_signatures (has full credentials like "Dr Anand - MD (Pathology)")
              // Only fall back to verifierName if signature_name is not set
              signatoryInfo = {
                signatoryName: userSignature.signature_name || verifierName ||
                  "Authorized Signatory",
                signatoryDesignation: "", // Don't show role like "Admin" - signature_name already has credentials
                signatoryImageUrl: sigUrl,
              };
              console.log(
                "  âœ… Using verifier signature:",
                signatoryInfo.signatoryName,
              );
            } else {
              // Verifier exists but has no signature - use their name but get lab default signature
              console.log(
                "  â†’ Verifier has no signature, using name with lab default signature",
              );
              signatoryInfo.signatoryName = verifierName ||
                "Authorized Signatory";
              signatoryInfo.signatoryDesignation = verifierRole ||
                verifierDepartment || "";
            }
          } else {
            // Verifier exists but has no signature entry
            console.log(
              "  â†’ No signature entry for verifier, using name with lab default signature",
            );
            signatoryInfo.signatoryName = verifierName ||
              "Authorized Signatory";
            signatoryInfo.signatoryDesignation = verifierRole ||
              verifierDepartment || "";
          }
        }

        // If no verifier signature or no verifier, fall back to lab default
        if (!signatoryInfo.signatoryImageUrl) {
          console.log("  â†’ Falling back to lab default signature...");

          // Get lab default signature from branding assets (asset_type = 'signature')
          const { data: labSignature } = await supabaseClient
            .from("lab_branding_assets")
            .select("file_url, imagekit_url, asset_metadata")
            .eq("lab_id", job.lab_id)
            .eq("asset_type", "signature")
            .eq("is_active", true)
            .order("is_default", { ascending: false }) // Default first
            .limit(1)
            .maybeSingle();

          if (labSignature) {
            // Prefer ImageKit URL with transformations
            if (labSignature.imagekit_url) {
              signatoryInfo.signatoryImageUrl = applySignatureTransformations(
                labSignature.imagekit_url,
              );
            } else if (labSignature.file_url) {
              signatoryInfo.signatoryImageUrl = labSignature.file_url;
            }

            const metadata = labSignature.asset_metadata as
              | Record<string, any>
              | null;
            if (metadata?.signatory_name) {
              signatoryInfo.signatoryName = metadata.signatory_name;
              signatoryInfo.signatoryDesignation =
                metadata.signatory_designation || "";
            } else if (signatoryInfo.signatoryName !== "Authorized Signatory") {
              signatoryInfo.signatoryName = "Authorized Signatory";
              signatoryInfo.signatoryDesignation = "";
            }
            console.log("  âœ… Using lab default signature");
          } else {
            // Try to find ANY user's default signature in this lab as last resort
            const { data: anyUserSig } = await supabaseClient
              .from("lab_user_signatures")
              .select(
                "imagekit_url, file_url, signature_name, user_id, variants",
              )
              .eq("lab_id", job.lab_id)
              .eq("is_active", true)
              .eq("is_default", true) // Only get default signatures
              .limit(1)
              .maybeSingle();

            if (anyUserSig) {
              // Priority: variants.optimized > imagekit_url with transforms > file_url
              let sigUrl: string | null = null;

              if (anyUserSig.variants) {
                const variants = typeof anyUserSig.variants === "string"
                  ? JSON.parse(anyUserSig.variants)
                  : anyUserSig.variants;
                if (variants?.optimized) {
                  sigUrl = variants.optimized;
                  console.log("  âœ… Using optimized variant (bg removed)");
                }
              }

              if (!sigUrl && anyUserSig.imagekit_url) {
                sigUrl = applySignatureTransformations(anyUserSig.imagekit_url);
              }

              if (!sigUrl && anyUserSig.file_url) {
                sigUrl = anyUserSig.file_url;
              }

              if (sigUrl) {
                signatoryInfo.signatoryImageUrl = sigUrl;
              }
              if (anyUserSig.signature_name) {
                signatoryInfo.signatoryName = anyUserSig.signature_name;
                signatoryInfo.signatoryDesignation = "";
              }
              console.log("  âœ… Using fallback user default signature");
            } else {
              console.log(
                "  âš ï¸ No default signature found - trying any active signature as final resort",
              );
              // FINAL RESORT: Get ANY active signature for this lab
              const { data: desperateSig } = await supabaseClient
                .from("lab_user_signatures")
                .select(
                  "imagekit_url, file_url, signature_name, user_id, variants",
                )
                .eq("lab_id", job.lab_id)
                .eq("is_active", true)
                .limit(1)
                .maybeSingle();

              if (desperateSig) {
                // Priority: variants.optimized > imagekit_url with transforms > file_url
                let sigUrl: string | null = null;

                if (desperateSig.variants) {
                  const variants = typeof desperateSig.variants === "string"
                    ? JSON.parse(desperateSig.variants)
                    : desperateSig.variants;
                  if (variants?.optimized) {
                    sigUrl = variants.optimized;
                    console.log(
                      "  âœ… Using optimized variant (bg removed) - FINAL RESORT",
                    );
                  }
                }

                if (!sigUrl && desperateSig.imagekit_url) {
                  sigUrl = applySignatureTransformations(
                    desperateSig.imagekit_url,
                  );
                }

                if (!sigUrl && desperateSig.file_url) {
                  sigUrl = desperateSig.file_url;
                }

                if (sigUrl) {
                  signatoryInfo.signatoryImageUrl = sigUrl;
                }
                if (desperateSig.signature_name) {
                  signatoryInfo.signatoryName = desperateSig.signature_name;
                  signatoryInfo.signatoryDesignation = "";
                }
                console.log(
                  "  âœ… Using ANY active signature found (FINAL RESORT)",
                );
              } else {
                console.log("  âŒ Absolutely no signature found for this lab");
              }
            }
          }
        }
      } catch (sigError) {
        console.error("  âŒ Error fetching signatory info:", sigError);
      }

      console.log("  â†’ Final signatory:", {
        name: signatoryInfo.signatoryName,
        designation: signatoryInfo.signatoryDesignation,
        hasImage: !!signatoryInfo.signatoryImageUrl,
      });

      // ========================================
      // Step 5c: Resolve multi-signature footer slots
      // pdf_layout_settings.reportSignatures = { enabled, maxCount, duplicatePolicy, slots[] }
      // Each active slot resolves to a signatory box in the footer.
      // ========================================
      try {
        const reportSig = (pdfSettings?.reportSignatures ?? null) as
          | Record<string, any>
          | null;

        if (
          reportSig && reportSig.enabled !== false &&
          Array.isArray(reportSig.slots)
        ) {
          const maxCount = Math.max(
            1,
            Math.min(3, Number(reportSig.maxCount ?? 1)),
          );
          const activeSlots = reportSig.slots.slice(0, maxCount);

          // Helper: pick best URL for a lab_user_signatures row
          const pickSigUrl = (sig: any): string => {
            if (!sig) return "";
            if (sig.variants) {
              try {
                const variants = typeof sig.variants === "string"
                  ? JSON.parse(sig.variants)
                  : sig.variants;
                if (variants?.optimized) return variants.optimized;
              } catch (_e) { /* ignore malformed variants */ }
            }
            if (sig.imagekit_url) {
              return applySignatureTransformations(sig.imagekit_url);
            }
            if (sig.file_url) return sig.file_url;
            return "";
          };

          // Batch-fetch all fixed signatures referenced by the slots
          const fixedIds = activeSlots
            .filter((s: any) =>
              s?.source === "fixed_signature" && s.signatureId
            )
            .map((s: any) => s.signatureId as string);

          const fixedSigMap = new Map<string, any>();
          if (fixedIds.length) {
            const { data: fixedSigs } = await supabaseClient
              .from("lab_user_signatures")
              .select("id, imagekit_url, file_url, signature_name, variants")
              .eq("lab_id", job.lab_id)
              .in("id", fixedIds);
            for (const fs of (fixedSigs || [])) fixedSigMap.set(fs.id, fs);
          }

          const resolved: Array<
            {
              signatoryName: string;
              signatoryDesignation: string;
              signatoryImageUrl: string;
            }
          > = [];

          for (const slot of activeSlots) {
            if (!slot || slot.source === "empty") continue;

            if (slot.source === "approver_signature") {
              // Use the verifier/approver signature resolved above
              if (
                signatoryInfo.signatoryImageUrl ||
                (signatoryInfo.signatoryName &&
                  signatoryInfo.signatoryName !== "Authorized Signatory")
              ) {
                resolved.push({
                  signatoryName: signatoryInfo.signatoryName,
                  signatoryDesignation: signatoryInfo.signatoryDesignation,
                  signatoryImageUrl: signatoryInfo.signatoryImageUrl,
                });
              }
            } else if (slot.source === "fixed_signature" && slot.signatureId) {
              const fs = fixedSigMap.get(slot.signatureId);
              if (fs) {
                resolved.push({
                  signatoryName: fs.signature_name || "Authorized Signatory",
                  signatoryDesignation: "",
                  signatoryImageUrl: pickSigUrl(fs),
                });
              }
            }
          }

          // Optionally drop duplicate signatures (same name + image)
          let finalList = resolved;
          if (reportSig.duplicatePolicy !== "allow_duplicates") {
            const seen = new Set<string>();
            finalList = resolved.filter((s) => {
              const key = `${(s.signatoryName || "").trim().toLowerCase()}|${
                (s.signatoryImageUrl || "").trim()
              }`;
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            });
          }

          if (finalList.length > 0) {
            (signatoryInfo as any)._signatories = finalList;
            console.log(
              `  âœ… Resolved ${finalList.length} footer signature(s):`,
              finalList.map((s) => s.signatoryName),
            );
          }
        }
      } catch (multiSigError) {
        console.error(
          "  âŒ Error resolving multi-signature slots:",
          multiSigError,
        );
      }

      await updateProgress(
        supabaseClient,
        job.id,
        "Fetching report extras...",
        35,
      );

      // ========================================
      // Step 6: Get Report Extras (Multiple Sources)
      // ========================================
      console.log(
        "\nðŸ“ˆ Step 6: Fetching report extras from multiple sources...",
      );

      // 6a. Get from report_extras table
      const { data: reportExtrasTable } = await supabaseClient
        .from("report_extras")
        .select("*")
        .eq("order_id", orderId)
        .maybeSingle();

      // 6b. Get from orders table (trend_graph_data, ai_clinical_summary, ai_patient_summary)
      const { data: orderExtras } = await supabaseClient
        .from("orders")
        .select(
          "trend_graph_data, ai_clinical_summary, ai_clinical_summary_generated_at, include_clinical_summary_in_report, ai_patient_summary, ai_patient_summary_generated_at, include_patient_summary_in_report, patient_summary_language",
        )
        .eq("id", orderId)
        .single();

      // 6b2. Get analyzer histograms from analyzer_graphs table
      const { data: analyzerGraphRows, error: analyzerGraphError } = await supabaseClient
        .from("analyzer_graphs")
        .select("test_code, name, associated_test, boundaries, svg_data")
        .eq("order_id", orderId)
        .order("created_at", { ascending: true });
      console.log(`ðŸ“Š Analyzer graphs fetched: ${analyzerGraphRows?.length ?? 0} rows`, analyzerGraphError ? `Error: ${analyzerGraphError.message}` : "OK");

      // 6c. Get from reports table (ai_doctor_summary, include_trend_graphs)
      const { data: reportRecord } = await supabaseClient
        .from("reports")
        .select(
          "ai_doctor_summary, ai_summary_generated_at, include_trend_graphs",
        )
        .eq("order_id", orderId)
        .order("generated_date", { ascending: false })
        .limit(1)
        .maybeSingle();

      // 6d. Get from results table (report_extras field)
      const { data: resultsWithExtras } = await supabaseClient
        .from("results")
        .select("id, report_extras")
        .eq("order_id", orderId)
        .not("report_extras", "is", null);

      // Convert trend_graph_data.analytes[] into trend_charts format (new format uses image_url per analyte)
      let trendChartsFromOrder: any[] = [];
      if (orderExtras?.trend_graph_data) {
        const td = typeof orderExtras.trend_graph_data === "string"
          ? JSON.parse(orderExtras.trend_graph_data)
          : orderExtras.trend_graph_data;
        if (td.include_in_report && td.analytes?.length > 0) {
          trendChartsFromOrder = td.analytes.map((a: any) => ({
            analyte_name: a.analyte_name,
            image_url: a.image_url || null,
            image_base64: null,
            data: (a.dataPoints || []).map((dp: any) => ({
              order_date: dp.date || dp.timestamp || "",
              value: dp.value,
              unit: a.unit,
              reference_range: `${a.reference_range?.min}-${a.reference_range?.max}`,
              flag: dp.flag || null,
            })),
            reference_range: `${a.reference_range?.min}-${a.reference_range?.max}`,
            unit: a.unit,
            generated_at: a.image_generated_at || new Date().toISOString(),
          }));
          console.log(`ðŸ“Š Converted ${trendChartsFromOrder.length} trend analytes from trend_graph_data (${trendChartsFromOrder.filter(c => c.image_url).length} with image_url)`);
        }
      }

      // Merge all report extras into one object
      const reportExtras = {
        // From report_extras table + order-level trend analytes merged
        trend_charts: [...(reportExtrasTable?.trend_charts || []), ...trendChartsFromOrder],
        clinical_summary: reportExtrasTable?.clinical_summary || "",
        // From orders table
        trend_graph_data: orderExtras?.trend_graph_data,
        ai_clinical_summary: orderExtras?.include_clinical_summary_in_report
          ? orderExtras?.ai_clinical_summary
          : null,
        ai_patient_summary: orderExtras?.include_patient_summary_in_report
          ? orderExtras?.ai_patient_summary
          : null,
        patient_summary_language: orderExtras?.patient_summary_language ||
          "english",
        // From reports table
        ai_doctor_summary: reportRecord?.ai_doctor_summary,
        include_trend_graphs: reportRecord?.include_trend_graphs ?? true,
        // From results table
        results_extras: resultsWithExtras || [],
        // From analyzer_graphs table
        analyzer_histogram_svgs: analyzerGraphRows || [],
      };

      // Merge report extras into context so they are available to templates
      // This fixed the issue where AI summaries were fetched but not compliant with the template data structure
      Object.assign(context, reportExtras);

      // Parse JSON fields if they are strings (TEXT columns in DB)
      const jsonFields = [
        "ai_patient_summary",
        "trend_graph_data",
        "ai_clinical_summary",
        "ai_doctor_summary",
      ];
      for (const field of jsonFields) {
        if (context[field]) {
          if (typeof context[field] === "string") {
            try {
              context[field] = JSON.parse(context[field]);
            } catch (e) {
              console.warn(`âš ï¸ Failed to parse ${field} JSON:`, e);
            }
          }
        }
      }

      // Normalize ai_patient_summary abnormal_findings to support common template accessors
      // We do this OUTSIDE the parsing loop to ensure it runs whether the data was a string or already an object
      if (
        context.ai_patient_summary &&
        context.ai_patient_summary.abnormal_findings
      ) {
        console.log("  â†’ Normalizing AI patient summary findings...");
        context.ai_patient_summary.abnormal_findings = context
          .ai_patient_summary.abnormal_findings.map((f: any) => {
            // Determine the best name for this finding (handle all possible field names)
            const findingName = f.test_name || f.name || f.parameter ||
              f.label || f.test || "";

            return {
              ...f,
              // Ensure test_name always has a value (this is what PDF template and modal use)
              test_name: findingName,
              // Alias common names to ensure template compatibility
              name: findingName,
              test: findingName,
              parameter: findingName,
              label: findingName,
              // Ensure status/flag is available and capitalized
              // If neither exists, default to empty string but handle the 'undefined' case explicitly
              flag: (f.status || f.flag)
                ? (f.status || f.flag).charAt(0).toUpperCase() +
                  (f.status || f.flag).slice(1)
                : "",
              status: f.status || f.flag || "abnormal",
              // Ensure type exists
              type: f.type || "Observation",
              // Ensure explanation exists
              explanation: f.explanation || f.description || "",
            };
          });
      }

      console.log("âœ… Report extras merged into context:", {
        hasTrendCharts: !!(context.trend_charts?.length),
        hasTrendGraphData: !!context.trend_graph_data,
        hasClinicalSummary: !!context.clinical_summary,
        hasAiClinicalSummary: !!context.ai_clinical_summary,
        hasAiPatientSummary: !!context.ai_patient_summary,
        hasAiDoctorSummary: !!context.ai_doctor_summary,
        resultsWithExtras: context.results_extras?.length || 0,
        patientSummaryLanguage: context.patient_summary_language,
      });

      await updateProgress(
        supabaseClient,
        job.id,
        "Fetching attachments...",
        40,
      );

      // ========================================
      // Step 7: Get Attachments
      // ========================================
      console.log("\nðŸ“Ž Step 7: Fetching attachments...");
      const { data: attachments } = await supabaseClient
        .from("attachments")
        .select("*")
        .eq("related_table", "orders")
        .eq("related_id", orderId)
        .eq("tag", "include_in_report");

      console.log("âœ… Attachments found:", attachments?.length || 0);

      // ========================================
      // Step 7b: Name case format (Settings â†’ Notifications â†’ Name Display Format)
      // ========================================
      let nameCaseFormat: "proper" | "upper" = "proper";
      try {
        const { data: nameCaseSettings } = await supabaseClient
          .from("lab_notification_settings")
          .select("name_case_format")
          .eq("lab_id", job.lab_id)
          .maybeSingle();
        if (nameCaseSettings?.name_case_format === "upper") {
          nameCaseFormat = "upper";
        }
      } catch (e) {
        console.warn("âš ï¸ Could not read name_case_format, defaulting to proper:", e);
      }
      console.log("ðŸ” Name case format:", nameCaseFormat);

      /** Apply the lab's name_case_format to a rendered name. */
      const applyNameCase = (value: unknown): string => {
        const name = String(value ?? "");
        if (!name) return name;
        if (nameCaseFormat === "upper") return name.toUpperCase();
        return name;
      };

      // ========================================
      // Step 7c: Get Branding Pages (Front/Back)
      // ========================================
      console.log("\nðŸŽ¨ Step 7c: Fetching front/back pages...");
      const { frontPage, lastPage } = await fetchFrontBackPages(
        supabaseClient,
        job.lab_id,
      );

      // Note: Using letterhead background instead of separate header/footer
      if (letterheadUrl) {
        console.log("âœ… Using letterhead background");
      }
      if (frontPage) console.log("âœ… Using custom front page");
      if (lastPage) console.log("âœ… Using custom last page");

      await updateProgress(
        supabaseClient,
        job.id,
        "Rendering HTML template...",
        50,
      );

      // ========================================
      // Step 8: Render HTML Template (Multi-Test Support)
      // ========================================
      console.log("\nðŸ”§ Step 8: Rendering HTML template...");

      // Initialize bodyHtml with front page if available
      // We add a specific class to handle page breaks
      let bodyHtml = "";

      if (frontPage) {
        bodyHtml +=
          `<div class="report-front-page" style="page-break-after: always; width: 100vw; height: 100vh; margin: 0; padding: 0;">${frontPage}</div>`;
      }
      let template = null; // Primary template for CSS/Settings
      let fullContext: any = null; // Define in outer scope for print version
      let rawHtmlForPrint = ""; // Capture HTML before watermark for print version
      let mergedPrintOptions: Record<string, unknown> | null = null; // Lifted to outer scope for print version

      // Group analytes by test_group_id
      let contextTestGroupIds = context.testGroupIds || [];
      const analytesByGroup = groupAnalytesByTestGroup(
        context.analytes || [],
        contextTestGroupIds,
      );
      const effectiveGroupCount = Math.max(
        contextTestGroupIds.length,
        analytesByGroup.size,
      );

      console.log("ðŸ“Š Test group analysis:", {
        contextTestGroupIds,
        analytesByGroupKeys: Array.from(analytesByGroup.keys()),
        effectiveGroupCount,
      });

      // Fetch test group names + per-group PDF style overrides
      const testGroupNames = new Map<string, string>();
      const testGroupStyles = new Map<string, string>(); // groupId â†’ 'beautiful'|'classic'
      const testGroupPrintOptions = new Map<string, Record<string, unknown>>(); // groupId â†’ print_options JSONB
      const testGroupInterpretations = new Map<string, string>(); // groupId â†’ group_interpretation HTML
      const testGroupCodes = new Map<string, string>(); // groupId â†’ test_groups.code
      const testGroupSampleTypes = new Map<string, string>(); // groupId â†’ sample_type
      const testGroupSampleConditions = new Map<string, string>();
      const testGroupIdsToFetch = [
        ...new Set(
          [...contextTestGroupIds, ...analytesByGroup.keys()].filter((id) =>
            id !== "ungrouped"
          ),
        ),
      ];

      if (testGroupIdsToFetch.length > 0) {
        // First try to get names from order_tests (has test_name which is the group name)
        const { data: orderTestsData } = await supabaseClient
          .from("order_tests")
          .select("test_group_id, test_name")
          .eq("order_id", orderId)
          .in("test_group_id", testGroupIdsToFetch);

        if (orderTestsData) {
          for (const ot of orderTestsData) {
            if (ot.test_group_id && ot.test_name) {
              testGroupNames.set(ot.test_group_id, ot.test_name);
            }
          }
        }

        const { data: orderTestGroupConditionRows } = await supabaseClient
          .from("order_test_groups")
          .select("test_group_id, sample_condition")
          .eq("order_id", orderId)
          .in("test_group_id", testGroupIdsToFetch);

        if (orderTestGroupConditionRows) {
          for (const row of orderTestGroupConditionRows) {
            const condition = String(row.sample_condition || "").trim();
            if (row.test_group_id && condition && !testGroupSampleConditions.has(row.test_group_id)) {
              testGroupSampleConditions.set(row.test_group_id, condition);
            }
          }
        }

        // Orders booked through the order form only have order_tests rows, so
        // the condition chosen at collection / result entry lives there.
        const { data: orderTestConditionRows } = await supabaseClient
          .from("order_tests")
          .select("test_group_id, sample_condition")
          .eq("order_id", orderId)
          .in("test_group_id", testGroupIdsToFetch);

        if (orderTestConditionRows) {
          for (const row of orderTestConditionRows) {
            const condition = String(row.sample_condition || "").trim();
            if (row.test_group_id && condition && !testGroupSampleConditions.has(row.test_group_id)) {
              testGroupSampleConditions.set(row.test_group_id, condition);
            }
          }
        }

        // For any groups not found in order_tests, try the test_groups table
        // Also fetch default_template_style and print_options for all groups
        const { data: testGroupsData } = await supabaseClient
          .from("test_groups")
          .select("id, name, code, default_template_style, print_options, group_interpretation, sample_type")
          .in("id", testGroupIdsToFetch);

        if (testGroupsData) {
          for (const tg of testGroupsData) {
            if (tg.id) {
              if (tg.name && !testGroupNames.has(tg.id)) {
                testGroupNames.set(tg.id, tg.name);
              }
              if (tg.default_template_style) {
                testGroupStyles.set(tg.id, tg.default_template_style);
              }
              if (tg.print_options) {
                testGroupPrintOptions.set(tg.id, tg.print_options);
              }
              if (tg.group_interpretation) {
                testGroupInterpretations.set(tg.id, tg.group_interpretation);
              }
              if (tg.code) {
                testGroupCodes.set(tg.id, tg.code);
              }
              if (tg.sample_type) {
                testGroupSampleTypes.set(tg.id, tg.sample_type);
              }
            }
          }
        }

        console.log(
          "ðŸ“‹ Test group names fetched:",
          Object.fromEntries(testGroupNames),
        );
      }

      const compactPrintConfig = getCompactPrintConfig(pdfSettings);
      let compactPrintPlan: CompactPrintPlan | null = null;
      let orderedGroupIdsForPrint = [...contextTestGroupIds];
      let orderedAnalytesByGroupForPrint = analytesByGroup;
      // Map of groupId â†’ printOrder, used by the render loop to suppress page breaks between equal-priority groups
      const printOrderByGroupId = new Map<string, number>();

      if (testGroupIdsToFetch.length > 0) {
        const descriptorById = new Map<string, CompactPlanGroupDescriptor>();
        const manualGroupOrder = Array.isArray(orderReportSettings?.groupOrder)
          ? orderReportSettings.groupOrder.map((value: unknown) => String(value || "")).filter(Boolean)
          : [];
        const manualOrderEnabled = orderReportSettings?.groupOrderManualOverride === true && manualGroupOrder.length > 0;
        const manualOrderIndexMap = new Map<string, number>(
          manualGroupOrder.map((id: string, index: number) => [id, index]),
        );

        const { data: orderTestGroupRows } = await supabaseClient
          .from("order_test_groups")
          .select("test_group_id, test_name, print_order, created_at, test_groups(category, department, report_priority)")
          .eq("order_id", orderId)
          .in("test_group_id", testGroupIdsToFetch);

        for (const row of orderTestGroupRows || []) {
          if (!row.test_group_id || descriptorById.has(row.test_group_id)) continue;
          const analytes = analytesByGroup.get(row.test_group_id) || [];
          descriptorById.set(row.test_group_id, {
            groupId: row.test_group_id,
            groupName: row.test_name || testGroupNames.get(row.test_group_id) || "Test Results",
            analyteCount: analytes.length,
            reportPriority: Number.isFinite(Number((row.test_groups as any)?.report_priority))
              ? Number((row.test_groups as any)?.report_priority)
              : null,
            manualOrderIndex: manualOrderEnabled && manualOrderIndexMap.has(row.test_group_id)
              ? manualOrderIndexMap.get(row.test_group_id)!
              : null,
            printOrder: Number(row.print_order ?? 0),
            createdAt: row.created_at || null,
            category: (row.test_groups as any)?.category || null,
            department: (row.test_groups as any)?.department || null,
            estimatedHeight: estimateCompactGroupHeight(analytes),
            hasImages: false,
            hasLongText: analytes.some((item: any) => String(item?.value || "").length > 48),
          });
        }

        const { data: orderTestRows } = await supabaseClient
          .from("order_tests")
          .select("test_group_id, test_name, print_order, created_at, test_groups(category, department, report_priority)")
          .eq("order_id", orderId)
          .in("test_group_id", testGroupIdsToFetch)
          .neq("is_canceled", true);

        for (const row of orderTestRows || []) {
          if (!row.test_group_id || descriptorById.has(row.test_group_id)) continue;
          const analytes = analytesByGroup.get(row.test_group_id) || [];
          descriptorById.set(row.test_group_id, {
            groupId: row.test_group_id,
            groupName: row.test_name || testGroupNames.get(row.test_group_id) || "Test Results",
            analyteCount: analytes.length,
            reportPriority: Number.isFinite(Number((row.test_groups as any)?.report_priority))
              ? Number((row.test_groups as any)?.report_priority)
              : null,
            manualOrderIndex: manualOrderEnabled && manualOrderIndexMap.has(row.test_group_id)
              ? manualOrderIndexMap.get(row.test_group_id)!
              : null,
            printOrder: Number(row.print_order ?? 0),
            createdAt: row.created_at || null,
            category: (row.test_groups as any)?.category || null,
            department: (row.test_groups as any)?.department || null,
            estimatedHeight: estimateCompactGroupHeight(analytes),
            hasImages: false,
            hasLongText: analytes.some((item: any) => String(item?.value || "").length > 48),
          });
        }

        for (const groupId of testGroupIdsToFetch) {
          if (descriptorById.has(groupId)) continue;
          const analytes = analytesByGroup.get(groupId) || [];
          descriptorById.set(groupId, {
            groupId,
            groupName: testGroupNames.get(groupId) || "Test Results",
            analyteCount: analytes.length,
            reportPriority: null,
            manualOrderIndex: manualOrderEnabled && manualOrderIndexMap.has(groupId)
              ? manualOrderIndexMap.get(groupId)!
              : null,
            printOrder: 999,
            createdAt: null,
            estimatedHeight: estimateCompactGroupHeight(analytes),
            hasImages: false,
            hasLongText: analytes.some((item: any) => String(item?.value || "").length > 48),
          });
        }

        // Populate outer-scope map so the render loop can read printOrder per group
        for (const [id, desc] of descriptorById.entries()) {
          printOrderByGroupId.set(id, desc.printOrder);
        }

        const descriptors = [...descriptorById.values()].sort((a, b) => {
          const aManual = a.manualOrderIndex ?? Number.MAX_SAFE_INTEGER;
          const bManual = b.manualOrderIndex ?? Number.MAX_SAFE_INTEGER;
          if (aManual !== bManual) return aManual - bManual;
          const aPriority = (a.reportPriority != null && a.reportPriority > 0) ? a.reportPriority : Number.MAX_SAFE_INTEGER;
          const bPriority = (b.reportPriority != null && b.reportPriority > 0) ? b.reportPriority : Number.MAX_SAFE_INTEGER;
          if (aPriority !== bPriority) return aPriority - bPriority;
          if (a.printOrder !== b.printOrder) return a.printOrder - b.printOrder;
          return a.groupName.localeCompare(b.groupName);
        });

        const requestedCompactMode = printLayoutMode === "compact" && compactPrintConfig.enabled
          ? "compact"
          : "standard";

        compactPrintPlan = buildDeterministicCompactPlan(
          descriptors,
          requestedCompactMode,
          compactPrintConfig,
        );

        const geminiApiKey = Deno.env.get("ALLGOOGLE_KEY") || Deno.env.get("GEMINI_API_KEY") || "";
        if (
          requestedCompactMode === "compact" &&
          compactPrintConfig.aiEnabled &&
          geminiApiKey &&
          descriptors.length > 1
        ) {
          try {
            const aiRawPlan = await callGeminiCompactPlanner(
              geminiApiKey,
              compactPrintConfig.policyText,
              descriptors,
            );
            const aiPlan = sanitizeCompactPlan(aiRawPlan, descriptors, requestedCompactMode);
            if (aiPlan) {
              compactPrintPlan = aiPlan;
            }
          } catch (compactAiError) {
            console.warn("Compact print AI planner failed, using deterministic fallback:", compactAiError);
            compactPrintPlan = compactPrintPlan
              ? {
                ...compactPrintPlan,
                source: "fallback",
                notes: [...(compactPrintPlan.notes || []), "AI planning failed, deterministic fallback used."],
              }
              : null;
          }
        }

        orderedGroupIdsForPrint = compactPrintPlan?.orderedGroupIds?.length
          ? compactPrintPlan.orderedGroupIds
          : descriptors.map((item) => item.groupId);

        // Apply manual overrides from the Order Settings UI compact page planner (Bug 1 fix)
        if (printLayoutMode === "compact" && (compactGroupOrderOverride?.length || compactPageAssignmentsOverride)) {
          const knownGroupIds = new Set(descriptors.map((d) => d.groupId));
          const baseOrder = compactGroupOrderOverride?.filter((id) => knownGroupIds.has(id)) ?? orderedGroupIdsForPrint;
          // Append any groups not listed in the override (safety net)
          const overrideGroupIds = [
            ...baseOrder,
            ...orderedGroupIdsForPrint.filter((id) => !baseOrder.includes(id)),
          ];

          if (compactPageAssignmentsOverride) {
            // Build a cluster plan from the manual page-number assignments
            const pageMap = new Map<number, string[]>();
            for (const groupId of overrideGroupIds) {
              const page = Math.max(1, Math.round(Number(compactPageAssignmentsOverride[groupId] ?? 1)));
              if (!pageMap.has(page)) pageMap.set(page, []);
              pageMap.get(page)!.push(groupId);
            }
            const sortedPages = [...pageMap.keys()].sort((a, b) => a - b);
            compactPrintPlan = {
              layoutMode: "compact",
              source: "manual",
              orderedGroupIds: overrideGroupIds,
              clusters: sortedPages.map((page, index) => ({
                id: `cluster_${index + 1}`,
                groupIds: pageMap.get(page)!,
                reason: `Page ${page} â€“ manual assignment from Order Settings compact planner.`,
              })),
              notes: ["Compact plan applied from Order Settings UI manual page assignments."],
            };
            // Update printOrderByGroupId so the render loop can detect same-page groups
            // and suppress min-height. Without this, all groups have printOrder=0 (DB default)
            // and the clubbed-group check always fails â†’ min-height:780px pushes clubbed groups off-page.
            for (const groupId of overrideGroupIds) {
              const page = Math.max(1, Math.round(Number(compactPageAssignmentsOverride[groupId] ?? 1)));
              printOrderByGroupId.set(groupId, page);
            }
          } else {
            // Only order changed, keep existing cluster structure but re-map to new order
            compactPrintPlan = {
              ...(compactPrintPlan || { clusters: [] }),
              layoutMode: "compact",
              source: "manual",
              orderedGroupIds: overrideGroupIds,
              notes: [...(compactPrintPlan?.notes || []), "Group order overridden from Order Settings UI."],
            };
          }
          orderedGroupIdsForPrint = overrideGroupIds;
          console.log("âœ… Applied Order Settings compact override:", {
            groupOrder: orderedGroupIdsForPrint,
            clusters: compactPrintPlan?.clusters?.length ?? 0,
            source: "manual",
          });
        }

        // Sync printOrderByGroupId from cluster plan so the render loop can
        // detect same-page (clubbed) groups and suppress min-height on them.
        // This covers AI planner, deterministic planner, and manual override paths.
        if (compactPrintPlan?.clusters?.length) {
          for (let ci = 0; ci < compactPrintPlan.clusters.length; ci++) {
            for (const gid of compactPrintPlan.clusters[ci].groupIds) {
              printOrderByGroupId.set(gid, ci + 1);
            }
          }
        }

        reorderContextByGroupIds(context, orderedGroupIdsForPrint);
        contextTestGroupIds = context.testGroupIds || orderedGroupIdsForPrint;
        orderedAnalytesByGroupForPrint = buildOrderedAnalytesByGroup(analytesByGroup, orderedGroupIdsForPrint);

        console.log("Ã°Å¸â€œÂ Group report priorities:", descriptors.map((d) => ({
          groupId: d.groupId,
          groupName: d.groupName,
          reportPriority: d.reportPriority,
          printOrder: d.printOrder,
          manualOrderIndex: d.manualOrderIndex ?? null,
        })));
        console.log("Ã°Å¸â€œÂ Compact print planning:", {
          requestedMode: printLayoutMode,
          resolvedMode: compactPrintPlan?.layoutMode || "standard",
          source: compactPrintPlan?.source || "deterministic",
          orderedGroupIds: orderedGroupIdsForPrint,
          clusters: compactPrintPlan?.clusters || [],
        });
      }

      // Helper: Select appropriate template
      const layoutTemplatesWithHtml = templatesWithHtml.filter((t: any) =>
        !t?.is_interpretation_only
      );
      const interpretationTemplatesWithHtml = templatesWithHtml.filter((
        t: any,
      ) => !!t?.is_interpretation_only);

      const extractBodyContent = (html: string) => {
        if (!html) return "";
        const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
        return bodyMatch ? bodyMatch[1] : html;
      };

      const getInterpretationTemplatesForGroup = (testGroupId?: string) => {
        return interpretationTemplatesWithHtml.filter((t: any) => {
          if (!testGroupId) {
            return !t.test_group_id;
          }
          return t.test_group_id === testGroupId || !t.test_group_id;
        });
      };

      const renderInterpretationBlocks = (
        interpretationTemplates: any[],
        renderContext: any,
      ) => {
        if (!interpretationTemplates.length) {
          return { html: "", css: "" };
        }

        const html = interpretationTemplates.map((tpl: any) => {
          const rendered = renderTemplate(tpl.gjs_html || "", renderContext);
          return `\n<div class="limsv2-interpretation-block" data-template-id="${tpl.id}">${extractBodyContent(rendered)}</div>`;
        }).join("\n");

        const css = interpretationTemplates
          .map((tpl: any) => tpl.gjs_css || "")
          .filter(Boolean)
          .join("\n");

        return { html, css };
      };

      console.log("ðŸ“Œ Template split summary:", {
        layoutTemplates: layoutTemplatesWithHtml.length,
        interpretationTemplates: interpretationTemplatesWithHtml.length,
      });

      const selectTemplate = (ctx: any) => {
        const testGroupId = ctx.testGroupIds?.[0];
        if (!testGroupId) return null;

        // If this test group has a forced style override, skip custom template entirely
        if (testGroupStyles.has(testGroupId)) {
          console.log(`ðŸŽ¨ Test group ${testGroupId} has style override '${testGroupStyles.get(testGroupId)}' â€” skipping custom template`);
          return null;
        }

        // Strict match only: if no exact template for this test group,
        // caller must use built-in default template (beautiful/classic).
        return layoutTemplatesWithHtml.find((t: any) => t.test_group_id === testGroupId) || null;
      };

      // Helper: Prepare full context with all extras
      const prepareFullContext = (baseContext: any) => {
        // Generate individual analyte placeholders for hardcoded template support
        const analytePlaceholders = generateAnalytePlaceholders(
          baseContext.analytes || [],
        );

        // Generate verification URL for QR code
        const verifyUrl = `https://app.limsapp.in/verify?id=${
          encodeURIComponent(
            orderId || baseContext.order?.sampleId || baseContext.sampleId ||
              "",
          )
        }`;

        // Create flat aliases for nested properties (for template compatibility)

        const sig = baseContext.signatory || {};
        const rawSigName = formatSignatureNameForPdf(
          sig.name || sig.signatoryName || signatoryInfo.signatoryName || "",
        );
        const sigDesignation = sig.designation || sig.signatoryDesignation || signatoryInfo.signatoryDesignation || "";
        let sigName = rawSigName;
        const sigUrl = sig.signature_url || sig.url || sig.signatoryImageUrl || signatoryInfo.signatoryImageUrl || "";

        // Logic to inject signature image directly into the name placeholder
        // This follows "User Request" to look for {{signatoryName}} and inject there.
        if (sigUrl && sigName) {
          const imgHtml =
            `<img src="${sigUrl}" alt="" style="display:block; max-height:70px; max-width:180px; width:auto; height:auto; object-fit:contain; margin-bottom:2px; margin-top:2px;" onerror="this.style.display='none'" />`;
          // Wrap name in span to separate it from block image, though block image forces break.
          sigName = `${imgHtml}<span>${sigName}</span>`;
        }

        const flatAliases = {
          // Patient aliases
          patientName: applyNameCase(baseContext.patient?.name),
          patientId: baseContext.patient?.displayId ||
            baseContext.patient?.id || "",
          patientAge: baseContext.patient?.age || "",
          patientAgeFormatted: formatPatientAgeDisplay(
            baseContext.patient?.age,
            baseContext.patient?.age_unit,
          ),
          patientGender: baseContext.patient?.gender || "",
          patientPhone: baseContext.patient?.phone || "",

          // Order aliases
          sampleId: baseContext.order?.sampleId || "",
          sampleBarcode: baseContext.order?.sampleBarcode || baseContext.sampleBarcode || "",
          orderId: baseContext.orderId || "",
          orderDate: (() => {
            const raw = baseContext.order?.orderDate || baseContext.meta?.orderDate || "";
            const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
            return m ? `${m[3]}-${m[2]}-${m[1]}` : raw; // ISO â†’ DD-MM-YYYY to match approvedAt format
          })(),
          collectionDate: baseContext.order?.sampleCollectedAtFormatted ||
            baseContext.order?.sampleCollectedAt || "",
          receivedAt: baseContext.order?.sampleReceivedAtFormatted ||
            baseContext.order?.sampleReceivedAt || "",
          collectionCenter: baseContext.order?.collectionCenter ||
            baseContext.order?.locationName || "",
          sampleCollectedBy: baseContext.order?.sampleCollectedBy || "",
          b2bAccountName: baseContext.order?.b2bAccountName ||
            baseContext.placeholderValues?.b2bAccountName || "",
          refCenter: baseContext.order?.refCenter ||
            baseContext.placeholderValues?.refCenter ||
            baseContext.order?.b2bAccountName ||
            baseContext.placeholderValues?.b2bAccountName || "",
          processingCenter: baseContext.order?.processingCenter ||
            baseContext.placeholderValues?.processingCenter || "",
          referringDoctorName: applyNameCase(baseContext.order?.referringDoctorName),
          referringDoctorQualification:
            baseContext.order?.referringDoctorQualification ||
            baseContext.placeholderValues?.referringDoctorQualification || "",
          // Pre-rendered "Ref. Doctor" cell — name plus the degree beneath it. Falls
          // back to the plain name when the doctor master has no degree saved.
          referringDoctorBlock: buildRefDoctorBlock(
            applyNameCase(baseContext.order?.referringDoctorName),
            baseContext.order?.referringDoctorQualification ||
              baseContext.placeholderValues?.referringDoctorQualification,
          ),
          approvedAt: baseContext.order?.approvedAtFormatted ||
            baseContext.order?.approved_at || baseContext.meta?.approvedAt ||
            "",

          // Friendly aliases used by CKE templates
          registrationDate: baseContext.order?.orderDate ||
            baseContext.meta?.orderDate || "",
          reportDate: baseContext.meta?.reportDate ||
            baseContext.order?.approvedAtFormatted ||
            baseContext.order?.approved_at || baseContext.meta?.approvedAt ||
            "",
          groupRemark: buildGroupRemarkHtml(baseContext.groupRemark),

          // Signatory aliases
          signatoryName: sigName,
          signatoryDesignation: sigDesignation,
          approverName: rawSigName,
          approvedByName: rawSigName,
          approverRole: sigDesignation,
          approverSignature: sigUrl || "",
          approvedBySignature: sigUrl || "",

          // QR verification URL
          verifyUrl: verifyUrl,
          qr_code: `<img src="https://api.qrserver.com/v1/create-qr-code/?size=100x100&data=${encodeURIComponent(verifyUrl)}" alt="Verify Report" style="width:80px;height:80px;" />`,

          // Barcode image for report header â€” inline SVG (no external API dependency)
          barcode_image: (() => {
            const barcodeVal = baseContext.order?.sampleBarcode || baseContext.sampleBarcode || baseContext.order?.sampleId || baseContext.sampleId || orderId || "";
            if (!barcodeVal) return "";
            return generateCode128SVG(barcodeVal, 36, 100);
          })(),

          // Custom patient fields (from patients.custom_fields JSONB)
          ...Object.entries(baseContext.patient?.custom_fields || {}).reduce(
            (acc: Record<string, string>, [k, v]) => {
              const value = String(v ?? '');
              acc[`custom_${k}`] = value;
              acc[`custom_${k.toLowerCase()}`] = value;
              return acc;
            },
            {},
          ),
        };

        return {
          ...baseContext,
          ...reportExtras,
          ...baseContext.placeholderValues, // âœ… CRITICAL: Spread RPC-provided placeholders to root
          ...analytePlaceholders, // Add locally generated placeholders (fallbacks)
          ...flatAliases, // Add flat aliases
          // Keep nested {{patient.name}} / {{order.referringDoctorName}} in step with
          // the flat aliases above so name casing is consistent whichever form a template uses
          patient: baseContext.patient
            ? { ...baseContext.patient, name: applyNameCase(baseContext.patient.name) }
            : baseContext.patient,
          order: baseContext.order
            ? {
              ...baseContext.order,
              referringDoctorName: applyNameCase(baseContext.order.referringDoctorName),
            }
            : baseContext.order,
          verifyUrl: verifyUrl, // QR code URL
          qr_code: `<img src="https://api.qrserver.com/v1/create-qr-code/?size=100x100&data=${encodeURIComponent(verifyUrl)}" alt="Verify Report" style="width:80px;height:80px;" />`,
          watermark: watermarkSettings.enabled
            ? watermarkSettings.imageUrl
            : null,
          signatory: signatoryInfo,
          lab: { name: labSettings?.name },
          attachments: attachments || [],
        };
      };

      // Helper: Generate dynamic CSS (extends top-level generateDynamicCss with printOptions)
      const generateDynamicCss = (settings: any, printOpts?: Record<string, unknown>) => {
        let css = `
        .limsv2-report {
          font-size: ${settings.fontSize || "14px"};
        }
      `;
        if (printOpts && Object.keys(printOpts).length > 0) {
          css += "\n/* Print Options Overrides */\n";
          if (printOpts.tableBorders === false) {
            css += `.report-table,.report-table tr,.report-table th,.report-table td,.patient-info table,.patient-info tr,.patient-info td,.patient-info th,.limsv2-report table,.limsv2-report tr,.limsv2-report th,.limsv2-report td{border:none!important;}\n`;
          }
          if (printOpts.flagColumn === false) {
            css += `.report-table th:last-child,.report-table td:last-child{display:none!important;}\n`;
          }
          if (printOpts.headerBackground) {
            const textCol = (printOpts.headerTextColor as string) || "#ffffff";
            css += `.report-table thead tr th{background:${printOpts.headerBackground}!important;background-color:${printOpts.headerBackground}!important;color:${textCol}!important;}\n`;
          }
          if (printOpts.alternateRows === false) {
            css += `.report-table tbody tr:nth-child(even) td,.report-table tbody tr:nth-child(even){background:#ffffff!important;background-color:#ffffff!important;}\n`;
          }
          if (typeof printOpts.baseFontSize === "number") {
            const fs = Math.min(Math.max(printOpts.baseFontSize, 8), 16);
            css += `.limsv2-report,.report-table td,.report-table th,.patient-info td,.patient-info th{font-size:${fs}px!important;}\n`;
          }
        }
        return css;
      };

      // Helper: Build PDF body document
      const buildPdfBodyDocument = (content: string, css: string) => {
        return `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <style>${BASELINE_CSS}\n${css}</style>
        </head>
        <body class="limsv2-report">
          ${content}
        </body>
        </html>
      `;
      };

      // Histograms injected inline per-group in multi-group path; populated below
      let histogramsByGroupId = new Map<string, any[]>();

      if (effectiveGroupCount <= 1) {
        // Single Group Logic
        template = selectTemplate(context);
        const singleGroupId = context.testGroupIds?.[0];
        const singleGroupRemark = singleGroupId ? groupRemarks.get(singleGroupId) || "" : "";
        context.groupRemark = singleGroupRemark;
        fullContext = prepareFullContext(context);
        const singlePrintOptions = mergePrintOptions(pdfSettings, singleGroupId ? testGroupPrintOptions.get(singleGroupId) : undefined);
        if (singlePrintOptions && (singlePrintOptions as any).showSampleType && singleGroupId) {
          const _st = testGroupSampleTypes.get(singleGroupId);
          if (_st) (singlePrintOptions as any)._sampleType = _st;
        }
        if (singlePrintOptions && (singlePrintOptions as any).showSampleCondition && singleGroupId) {
          const _sc = testGroupSampleConditions.get(singleGroupId);
          if (_sc) {
            (singlePrintOptions as any)._sampleCondition = _sc;
            fullContext.sampleCondition = _sc;
            fullContext.sampleConditionLabel = `Condition: ${_sc}`;
          }
        }
        mergedPrintOptions = singlePrintOptions; // lift to outer scope for print version
        const dynamicCss = generateDynamicCss(pdfSettings, singlePrintOptions ?? undefined);
        const singleInterpretationTemplates = getInterpretationTemplatesForGroup(
          singleGroupId,
        );
        let renderedHtml = "";
        let interpretationCss = "";

        if (!template) {
          // No custom template found - use default template
          const resolvedStyle = (singleGroupId && testGroupStyles.get(singleGroupId)) || labSettings?.default_template_style || 'beautiful';
          console.log(
            `âš ï¸ No custom template found for lab, using default template (style: ${resolvedStyle})`,
          );
          renderedHtml = generateDefaultTemplateHtml(
            context,
            testGroupNames,
            analytesByGroup,
            signatoryInfo,
            fullContext?.sectionContent,
            true,
            resolvedStyle,
            labSettings?.show_methodology ?? true,
            labSettings?.show_interpretation ?? false,
            labSettings?.report_patient_info_config,
            singlePrintOptions ?? undefined,
            customPatientFieldConfigs ?? [],
            singleGroupId,
            testGroupInterpretations,
            (fullContext as any)?.sectionLabels,
          );
          renderedHtml = renderTemplate(renderedHtml, fullContext); // Process placeholders
          renderedHtml = injectGroupRemark(renderedHtml, singleGroupRemark);

          // Inject QR code for verification (next to signature area)
          const defaultVerifyUrl = fullContext.verifyUrl ||
            `https://app.limsapp.in/verify?id=${
              encodeURIComponent(orderId || context.sampleId || "")
            }`;
          renderedHtml = injectQrCode(renderedHtml, defaultVerifyUrl);

          console.log(
            "âœ… Generated default template HTML, length:",
            renderedHtml.length,
          );
        } else {
          console.log("âœ… Using single template:", template.template_name);
          renderedHtml = renderTemplate(template.gjs_html, fullContext);
          renderedHtml = injectGroupRemark(
            renderedHtml,
            singleGroupRemark,
            /\{\{\s*groupRemark\s*\}\}/.test(template.gjs_html),
          );

          // Inject signature image if template doesn't have one (unless showSignature is false)
          if (signatoryInfo.signatoryImageUrl && (singlePrintOptions as any)?.showSignature !== false) {
            renderedHtml = injectSignatureImage(
              renderedHtml,
              signatoryInfo.signatoryImageUrl,
              signatoryInfo.signatoryName,
              signatoryInfo.signatoryDesignation,
            );
          }

          // Inject QR code for verification (next to signature area)
          const singleVerifyUrl = fullContext.verifyUrl ||
            `https://app.limsapp.in/verify?id=${
              encodeURIComponent(orderId || context.sampleId || "")
            }`;
          renderedHtml = injectQrCode(renderedHtml, singleVerifyUrl);
        }

        if (singleInterpretationTemplates.length > 0) {
          const renderedInterpretation = renderInterpretationBlocks(
            singleInterpretationTemplates,
            fullContext,
          );
          if (renderedInterpretation.html) {
            renderedHtml += renderedInterpretation.html;
            interpretationCss = renderedInterpretation.css;
            console.log(
              "âœ… Appended interpretation-only templates (single group):",
              singleInterpretationTemplates.map((t: any) => t.template_name),
            );
          }
        }

        console.log(
          "ðŸ”§ About to call buildPdfBodyDocumentV2 with letterhead:",
          (template?.gjs_html && ckeTemplateLetterheadUrl ? ckeTemplateLetterheadUrl : letterheadUrl) || "NONE",
        );

        const verifyUrl = `https://app.limsapp.in/verify?id=${
          encodeURIComponent(orderId || context.sampleId || "")
        }`;
        const templateCss = [
          template?.gjs_css || "",
          interpretationCss,
          dynamicCss,
        ].filter(Boolean).join("\n");
        bodyHtml = buildPdfBodyDocumentV2(
          renderedHtml,
          templateCss,
          template?.gjs_html && ckeTemplateLetterheadUrl ? ckeTemplateLetterheadUrl : letterheadUrl,
          pdfSettings,
          verifyUrl,
        );
        console.log(
          "âœ… buildPdfBodyDocumentV2 returned, HTML length:",
          bodyHtml.length,
        );
        console.log(
          "ðŸ” Checking if letterhead is in returned HTML:",
          bodyHtml.includes("page-bg") ? "YES (page-bg div found)" : "NO",
        );
        // CRITICAL: Do NOT save bodyHtml to rawHtmlForPrint if we are using V2/letterhead logic.
        // We want the print version to RE-RENDER cleanly without the letterhead structure.
        // rawHtmlForPrint = bodyHtml
      } else {
        // Multi Group Logic
        console.log("ðŸ”€ Multi-test group rendering...");
        const renderedSections: string[] = [];
        let firstGroupTemplate = null;
        let usedCkeTemplateInMulti = false;
        const multiInterpretationCssChunks: string[] = [];

        // Lift lab-level print options for print version (no single group to merge with)
        mergedPrintOptions = mergePrintOptions(pdfSettings, undefined);

        // Set base context for print version (even if not perfect for all groups)
        fullContext = prepareFullContext(context);

        // Use contextTestGroupIds as the authoritative list of groups to render
        // This ensures we render all test groups even if analytes don't have test_group_id
        const sectionContentByGroupForRender: Map<string, Record<string, string>> =
          context.sectionContentByGroup || new Map();
        const groupsToRender = contextTestGroupIds.length > 0
          ? Array.from(new Set([
            ...contextTestGroupIds,
            ...sectionContentByGroupForRender.keys(),
          ]))
          : Array.from(new Set([
            ...analytesByGroup.keys(),
            ...sectionContentByGroupForRender.keys(),
          ]));
        console.log(`ðŸ”€ Groups to render: ${JSON.stringify(groupsToRender)}`);

        // Build histogramsByGroupId: assign each analyzer histogram to its test group section.
        // Matching priority: (1) associated_test === test_groups.code, (2) group name contains
        // hematology keywords (CBC/haematology), (3) last group as fallback.
        {
          const svgRowsAll = (analyzerGraphRows || []).filter((r: any) => r.svg_data);
          if (svgRowsAll.length > 0) {
            const codeToGroupId = new Map<string, string>();
            for (const [gid, code] of testGroupCodes.entries()) {
              if (code) codeToGroupId.set(code.toUpperCase(), gid);
            }
            const hemaKeywords = ['cbc', 'haematol', 'hematol', 'blood count', 'complete blood', 'fbc', 'full blood'];
            let hemaGroupId: string | null = null;
            for (const gid of groupsToRender) {
              const name = (testGroupNames.get(gid) || '').toLowerCase();
              const code = (testGroupCodes.get(gid) || '').toLowerCase();
              if (hemaKeywords.some(k => name.includes(k) || code.includes(k))) {
                hemaGroupId = gid;
                break;
              }
            }
            const fallbackGroupId = groupsToRender[groupsToRender.length - 1] ?? null;
            for (const row of svgRowsAll) {
              const assoc = (row.associated_test || '').toUpperCase();
              let targetId = codeToGroupId.get(assoc) ?? hemaGroupId ?? fallbackGroupId;
              if (targetId) {
                if (!histogramsByGroupId.has(targetId)) histogramsByGroupId.set(targetId, []);
                histogramsByGroupId.get(targetId)!.push(row);
              }
            }
            console.log(`ðŸ“Š histogramsByGroupId built: ${[...histogramsByGroupId.entries()].map(([k,v])=>`${k}:${v.length}`).join(', ')}`);
          }
        }

        // Track previous group's printOrder to suppress page breaks between equal-priority groups
        let prevRenderedPrintOrder: number | null = null;
        for (const testGroupId of groupsToRender) {
          // Get analytes for this group (may be empty if grouping failed)
          let groupAnalytes = analytesByGroup.get(testGroupId) || [];
          const groupSectionContent = sectionContentByGroupForRender.has(testGroupId)
            ? sectionContentByGroupForRender.get(testGroupId)
            : undefined;

          // If no analytes found for this group, try to find them from ungrouped
          if (groupAnalytes.length === 0 && analytesByGroup.has("ungrouped")) {
            const ungrouped = analytesByGroup.get("ungrouped") || [];
            // Distribute ungrouped analytes - take the next one for this group
            const groupIndex = groupsToRender.indexOf(testGroupId);
            if (groupIndex >= 0 && groupIndex < ungrouped.length) {
              groupAnalytes = [ungrouped[groupIndex]];
            }
          }

          console.log(
            `ðŸ”§ Rendering test group: ${testGroupId} with ${groupAnalytes.length} analyte(s)`,
          );

          // Skip if no analytes for this group
          const hasGroupedSections = !!groupSectionContent &&
            Object.keys(groupSectionContent).some((key) =>
              String(groupSectionContent[key] || "").trim().length > 0
            );

          if (groupAnalytes.length === 0 && !hasGroupedSections) {
            console.log(
              `âš ï¸ No analytes found for test group: ${testGroupId}, skipping`,
            );
            continue;
          }

          const groupContext = {
            ...context,
            analytes: groupAnalytes,
            testGroupIds: [testGroupId],
            groupRemark: groupRemarks.get(testGroupId) || "",
          };

          // Find specific template for this group
          // But first check if this group has a forced style override
          let groupTemplate = null;
          let useGenericTemplate = false;

          if (testGroupStyles.has(testGroupId)) {
            console.log(`ðŸŽ¨ Test group ${testGroupId} has style override '${testGroupStyles.get(testGroupId)}' â€” skipping custom template`);
            useGenericTemplate = true;
          } else {
            groupTemplate = templatesWithHtml.find((t: { test_group_id?: string; is_interpretation_only?: boolean; [key: string]: unknown }) =>
              t.test_group_id === testGroupId
            ) || null;
            if (groupTemplate?.is_interpretation_only) {
              groupTemplate = null;
            }
          }

          if (!groupTemplate && !useGenericTemplate) {
            console.log(
              `âš ï¸ No specific template for ${testGroupId}, will use generic table template`,
            );
            // Don't use selectTemplate fallback - it would use another test group's template
            // Instead, flag to use generic template for this group's analytes
            useGenericTemplate = true;
          } else if (groupTemplate) {
            console.log(
              `âœ… Found specific template for ${testGroupId}: ${groupTemplate.template_name}`,
            );
          }

          const groupFullContext = prepareFullContext(groupContext);
          const groupSampleCondition = testGroupSampleConditions.get(testGroupId);
          if (groupSampleCondition) {
            groupFullContext.sampleCondition = groupSampleCondition;
            groupFullContext.sampleConditionLabel = `Condition: ${groupSampleCondition}`;
          }
          let renderedHtml = "";
          let bodyContent = "";

          // Pre-compute same-page flags (used in both template paths for QR/signature suppression)
          const _earlyGroupPrintOrder = printOrderByGroupId.get(testGroupId) ?? 999;
          const _earlyGroupsArr = groupsToRender as string[];
          const _earlyGroupIdx = _earlyGroupsArr.indexOf(testGroupId);
          const _earlyNextGId = _earlyGroupIdx >= 0 ? _earlyGroupsArr[_earlyGroupIdx + 1] : undefined;
          const _earlyNextGPrintOrder = _earlyNextGId ? (printOrderByGroupId.get(_earlyNextGId) ?? 999) : null;
          const _earlyIsSamePageAsNext = _earlyNextGPrintOrder !== null &&
            _earlyNextGPrintOrder !== 0 &&
            _earlyNextGPrintOrder !== 999 &&
            _earlyNextGPrintOrder === _earlyGroupPrintOrder;

          if (groupTemplate?.gjs_html && !useGenericTemplate) {
            if (!firstGroupTemplate) firstGroupTemplate = groupTemplate;
            usedCkeTemplateInMulti = true;

            renderedHtml = renderTemplate(
              groupTemplate.gjs_html,
              groupFullContext,
            );

            // Inject signature image if template doesn't have one (unless showSignature is false)
            const _groupShowSig = testGroupPrintOptions.get(testGroupId)?.showSignature;
            if (signatoryInfo.signatoryImageUrl && _groupShowSig !== false) {
              renderedHtml = injectSignatureImage(
                renderedHtml,
                signatoryInfo.signatoryImageUrl,
                signatoryInfo.signatoryName,
                signatoryInfo.signatoryDesignation,
              );
            }

            // Inject QR code for verification (next to signature area)
            // Skip when another group follows on the same compact page
            if (!_earlyIsSamePageAsNext) {
              const groupVerifyUrl = groupFullContext.verifyUrl ||
                `https://app.limsapp.in/verify?id=${
                  encodeURIComponent(orderId || context.sampleId || "")
                }`;
              renderedHtml = injectQrCode(renderedHtml, groupVerifyUrl);
            }

            // Extract body content
            const bodyMatch = renderedHtml.match(
              /<body[^>]*>([\s\S]*)<\/body>/i,
            );
            bodyContent = bodyMatch ? bodyMatch[1] : renderedHtml;
          } else {
            // No specific template found for this group - generate default/generic template for this group's analytes
            const testName = testGroupNames.get(testGroupId) ||
              groupAnalytes[0]?.test_name || "Test Results";
            console.log(
              `ðŸ”§ Generating generic table template for test group: ${testGroupId} (${testName}) with ${groupAnalytes.length} analyte(s)`,
            );
            const singleGroupMap = new Map<string, any[]>();
            singleGroupMap.set(testGroupId, groupAnalytes);
            // Use sections scoped to this test group; fall back to all sections only if no group mapping exists
            const groupSectionContentForRender = groupSectionContent
              ? groupSectionContent
              : (sectionContentByGroupForRender.size === 0 && renderedSections.length === 0 ? groupFullContext?.sectionContent : undefined);
            // Suppress min-height when this group shares a non-zero printOrder with its
            // neighbour (same-priority pair flows on one page â€” min-height would push the
            // second group off the page even though the page-break is suppressed).
            const _groupPrintOrder = printOrderByGroupId.get(testGroupId) ?? 999;
            const _isSamePageAsPrev = renderedSections.length > 0 &&
              prevRenderedPrintOrder !== null &&
              _groupPrintOrder !== 999 &&
              _groupPrintOrder !== 0 &&
              _groupPrintOrder === prevRenderedPrintOrder;
            const _groupsArr = groupsToRender as string[];
            const _groupIdx = _groupsArr.indexOf(testGroupId);
            const _nextGId = _groupIdx >= 0 ? _groupsArr[_groupIdx + 1] : undefined;
            const _nextGPrintOrder = _nextGId ? (printOrderByGroupId.get(_nextGId) ?? 999) : null;
            const _isSamePageAsNext = _nextGPrintOrder !== null &&
              _nextGPrintOrder !== 0 &&
              _nextGPrintOrder !== 999 &&
              _nextGPrintOrder === _groupPrintOrder;
            const _suppressMinHeight = _isSamePageAsPrev || _isSamePageAsNext;
            const _mergedGroupOpts = mergePrintOptions(pdfSettings, testGroupPrintOptions.get(testGroupId)) ?? {};
            if ((_mergedGroupOpts as any).showSampleType) {
              const _gst = testGroupSampleTypes.get(testGroupId);
              if (_gst) (_mergedGroupOpts as any)._sampleType = _gst;
            }
            if ((_mergedGroupOpts as any).showSampleCondition) {
              const _gsc = testGroupSampleConditions.get(testGroupId);
              if (_gsc) (_mergedGroupOpts as any)._sampleCondition = _gsc;
            }
            const _groupPrintOptions = _suppressMinHeight
              ? { ..._mergedGroupOpts, _isCompact: true, _suppressPatientHeader: _isSamePageAsPrev, _suppressSignature: _isSamePageAsNext }
              : (Object.keys(_mergedGroupOpts).length > 0 ? _mergedGroupOpts : undefined);

            renderedHtml = generateDefaultTemplateHtml(
              groupContext,
              testGroupNames,
              singleGroupMap,
              signatoryInfo,
              groupSectionContentForRender,
              groupSectionContentForRender != null && Object.keys(groupSectionContentForRender).length > 0,
              testGroupStyles.get(testGroupId) || labSettings?.default_template_style || 'beautiful',
              labSettings?.show_methodology ?? true,
              labSettings?.show_interpretation ?? false,
              labSettings?.report_patient_info_config,
              _groupPrintOptions,
              customPatientFieldConfigs ?? [],
              testGroupId,
              testGroupInterpretations,
              (groupFullContext as any)?.sectionLabels,
            );
            renderedHtml = renderTemplate(renderedHtml, groupFullContext);

            // Inject QR code for verification (next to signature area)
            // Skip when signature is suppressed (group is not the last on its compact page)
            if (!(_groupPrintOptions as any)?._suppressSignature) {
              const groupDefaultVerifyUrl = groupFullContext.verifyUrl ||
                `https://app.limsapp.in/verify?id=${
                  encodeURIComponent(orderId || context.sampleId || "")
                }`;
              renderedHtml = injectQrCode(renderedHtml, groupDefaultVerifyUrl);
            }

            bodyContent = renderedHtml;
          }

          const groupInterpretationTemplates =
            getInterpretationTemplatesForGroup(testGroupId);
          if (groupInterpretationTemplates.length > 0) {
            const renderedInterpretation = renderInterpretationBlocks(
              groupInterpretationTemplates,
              groupFullContext,
            );
            if (renderedInterpretation.html) {
              bodyContent += renderedInterpretation.html;
            }
            if (renderedInterpretation.css) {
              multiInterpretationCssChunks.push(renderedInterpretation.css);
            }
            console.log(
              `âœ… Appended interpretation-only templates for ${testGroupId}:`,
              groupInterpretationTemplates.map((t: any) => t.template_name),
            );
          }

          // Add separator â€” skip page break when this group shares printOrder with the previous group
          const testName = testGroupNames.get(testGroupId) ||
            groupAnalytes[0]?.test_name || groupTemplate?.template_name ||
            `Test Group ${renderedSections.length + 1}`;
          const currentPrintOrder = printOrderByGroupId.get(testGroupId) ?? 999;
          // samePageGroup=true only when groups share an EXPLICITLY configured non-zero
          // print_order. printOrder=0 is the default (unset) value â€” treat each group
          // independently so they always get their own page.
          const samePageGroup = renderedSections.length > 0 &&
            prevRenderedPrintOrder !== null &&
            currentPrintOrder !== 999 &&
            currentPrintOrder !== 0 &&
            currentPrintOrder === prevRenderedPrintOrder;
          prevRenderedPrintOrder = currentPrintOrder;
          // Inject analyzer histograms matched to this group inline, right after its results table
          const groupHistograms = histogramsByGroupId.get(testGroupId) || [];
          if (groupHistograms.length > 0) {
            let histHtml = '<div style="margin-top:16px;page-break-inside:avoid;">';
            histHtml += '<p style="margin:0 0 6px 0;font-size:11px;font-weight:700;color:#1e40af;border-bottom:1px solid #93c5fd;padding-bottom:3px;letter-spacing:0.05em;">ANALYZER HISTOGRAMS</p>';
            histHtml += '<div style="display:flex;flex-wrap:wrap;gap:10px;align-items:flex-start;">';
            for (const row of groupHistograms) {
              const svg = row.svg_data.replace(/<svg\b/i, '<svg style="max-width:160px;height:auto;display:block;"');
              histHtml += `<div style="flex:0 0 auto;text-align:center;">${svg}</div>`;
            }
            histHtml += '</div></div>';
            bodyContent += histHtml;
          }

          bodyContent = injectGroupRemark(
            bodyContent,
            groupRemarks.get(testGroupId) || "",
            !!groupTemplate?.gjs_html && /\{\{\s*groupRemark\s*\}\}/.test(groupTemplate.gjs_html),
          );

          const sectionHtml = `
          <div class="test-group-section" data-test-group-id="${testGroupId}" ${
            renderedSections.length > 0 && !samePageGroup
              ? 'style="page-break-before: always; break-before: page;"'
              : ""
          }>
            ${bodyContent}
          </div>
        `;
          renderedSections.push(sectionHtml);
          console.log(`âœ… Rendered section for ${testGroupId} (printOrder=${currentPrintOrder}, samePageGroup=${samePageGroup})`);
        }

        if (renderedSections.length === 0) {
          // No sections rendered from templates - use complete default template
          console.log(
            "âš ï¸ No custom templates rendered, using complete default template",
          );
          fullContext = prepareFullContext(context);
          const defaultHtml = generateDefaultTemplateHtml(
            context,
            testGroupNames,
            analytesByGroup,
            signatoryInfo,
            fullContext?.sectionContent,
            true,
            labSettings?.default_template_style || 'beautiful',
            labSettings?.show_methodology ?? true,
            labSettings?.show_interpretation ?? false,
            labSettings?.report_patient_info_config,
            undefined,
            customPatientFieldConfigs ?? [],
            undefined,
            testGroupInterpretations,
            (fullContext as any)?.sectionLabels,
          );
          let renderedDefaultHtml = renderTemplate(defaultHtml, fullContext);

          // Inject QR code for verification
          const fallbackVerifyUrl = fullContext.verifyUrl ||
            `https://app.limsapp.in/verify?id=${
              encodeURIComponent(orderId || context.sampleId || "")
            }`;
          renderedDefaultHtml = injectQrCode(
            renderedDefaultHtml,
            fallbackVerifyUrl,
          );

          renderedSections.push(renderedDefaultHtml);
        }

        // Use first group's exact layout template for outer shell (if available).
        // Do not fall back to unrelated lab template; generic/default sections already rendered.
        template = firstGroupTemplate || null;

        // template can be null if using default template - that's OK now
        const templateCss = [
          template?.gjs_css || "",
          multiInterpretationCssChunks.join("\n"),
        ].filter(Boolean).join("\n");
        console.log(
          "âœ… Merged multiple templates" + (template
            ? ` using base: ${template.template_name}`
            : " using default template"),
        );
        const labPrintOptions = mergePrintOptions(pdfSettings, undefined);
        mergedPrintOptions = labPrintOptions; // lift to outer scope for print version
        const dynamicCss = generateDynamicCss(pdfSettings, labPrintOptions ?? undefined);
        const multiLetterheadUrl = usedCkeTemplateInMulti && ckeTemplateLetterheadUrl
          ? ckeTemplateLetterheadUrl
          : letterheadUrl;
        console.log(
          "ðŸ”§ About to call buildPdfBodyDocumentV2 (multi-template) with letterhead:",
          multiLetterheadUrl || "NONE",
        );

        const verifyUrl = `https://app.limsapp.in/verify?id=${
          encodeURIComponent(orderId || context.sampleId || "")
        }`;
        bodyHtml = buildPdfBodyDocumentV2(
          renderedSections.join("\n"),
          templateCss + "\n" + dynamicCss,
          multiLetterheadUrl,
          pdfSettings,
          verifyUrl,
        );
        console.log(
          "âœ… buildPdfBodyDocumentV2 returned, HTML length:",
          bodyHtml.length,
        );
        console.log(
          "ðŸ” Checking if letterhead is in returned HTML:",
          bodyHtml.includes("page-bg") ? "YES (page-bg div found)" : "NO",
        );
        rawHtmlForPrint = bodyHtml; // Save for print version
      }

      // Apply flag styling (color-code high/low/normal flags)
      bodyHtml = applyFlagStyling(bodyHtml, pdfSettings);
      // CRITICAL: Only apply flag styling to rawHtmlForPrint if it contains actual HTML content
      // If rawHtmlForPrint is empty/minimal, applyFlagStyling would return just CSS which would
      // incorrectly trigger the "if (rawHtmlForPrint)" branch later but fail the regex extraction
      if (rawHtmlForPrint && rawHtmlForPrint.includes("<main")) {
        rawHtmlForPrint = applyFlagStyling(rawHtmlForPrint, pdfSettings);
      }

      // Apply header text color (white text on dark header backgrounds)
      bodyHtml = applyHeaderTextColor(bodyHtml, pdfSettings);
      if (rawHtmlForPrint && rawHtmlForPrint.includes("<main")) {
        rawHtmlForPrint = applyHeaderTextColor(rawHtmlForPrint, pdfSettings);
      }

      // Inject watermark if enabled
      if (watermarkSettings.enabled && watermarkSettings.imageUrl) {
        const watermarkHtml = generateWatermarkHtml(watermarkSettings);
        bodyHtml = bodyHtml.replace("<main", `${watermarkHtml}<main`);
        console.log("âœ… Watermark injected");
      }

      // Inject report extras (trends, clinical summary, AI summaries)
      // CRITICAL: Must inject INSIDE </main>, not before </body> - otherwise content appears outside letterhead layout table
      const extrasHtml = generateReportExtrasHtml(reportExtras);
      if (extrasHtml) {
        bodyHtml = bodyHtml.replace("</main>", `${extrasHtml}</main>`);
        console.log("âœ… Report extras injected inside main content");
      }

      // Inject attachments
      if (attachments && attachments.length > 0) {
        const attachmentsHtml = generateAttachmentsHtml(attachments);
        if (attachmentsHtml) {
          bodyHtml = bodyHtml.replace("</main>", `${attachmentsHtml}</main>`);
          console.log("âœ… Attachments injected:", attachments.length);
        }
      }

      // Inject Last Page if available (this one goes before </body> since it's a separate full page)
      if (lastPage) {
        bodyHtml = bodyHtml.replace(
          "</body>",
          `<div class="report-last-page" style="page-break-before: always; width: 100vw; height: 100vh; margin: 0; padding: 0;">${lastPage}</div></body>`,
        );
        console.log("âœ… Last page injected");
      }

      console.log("âœ… HTML rendered:", { length: bodyHtml.length });

      await updateProgress(
        supabaseClient,
        job.id,
        "Preparing PDF generation...",
        60,
      );

      // ========================================
      // Step 9: SKIP Base64 Conversion (PDF.co can fetch images directly)
      // ========================================
      console.log(
        "\nðŸ–¼ï¸ Step 9: Skipping base64 conversion (PDF.co will fetch images directly from URLs)...",
      );

      // No conversion needed - PDF.co can fetch from ImageKit URLs directly.
      // Convert report text emojis to color SVG images for e-copy PDFs; Chromium/PDF.co
      // can otherwise fall back to monochrome emoji glyphs.
      const processedBody = colorizeReportEmojiTextNodes(bodyHtml);
      const processedBodyHasLetterhead = processedBody.includes("page-bg");
      // Not using separate header/footer - using letterhead background instead
      const processedHeader = "";
      const processedFooter = "";

      console.log(
        "âœ… Using direct image URLs (faster, no base64 conversion needed)",
      );

      await updateProgress(
        supabaseClient,
        job.id,
        "Generating PDF via PDF.co...",
        70,
      );

      // ========================================
      // Step 10: Generate PDFs via PDF.co API (PARALLEL)
      // ========================================
      console.log(
        "\nðŸ“¤ Step 10: Calling PDF.co API (parallel eCopy + Print)...",
      );
      const pdfStartTime = Date.now();

      // Build PDF settings
      // CRITICAL: If letterhead is present, we must set PDF margins to 0px top/bottom
      // so the background image is not pushed down. Content spacing is handled by CSS padding.
      let margins = DEFAULT_PDF_SETTINGS.margins;

      if (processedBodyHasLetterhead) {
        // Letterhead Mode: 0px all margins (background full bleed), side padding handled by CSS
        margins = `0px 0px 0px 0px`;
        console.log(
          "ðŸ“„ Letterhead detected: Forcing 0px all margins for API, using CSS padding for content.",
        );
      } else if (pdfSettings?.margins) {
        // Standard Mode: Use saved margins (handle both "180px" strings and numeric values)
        margins =
          `${parseMarginValue(pdfSettings.margins.top, 180)}px ${parseMarginValue(pdfSettings.margins.right, 20)}px ${parseMarginValue(pdfSettings.margins.bottom, 150)}px ${parseMarginValue(pdfSettings.margins.left, 20)}px`;
      }

      const filename = `Report_${
        context.sampleId || orderId
      }_${Date.now()}.pdf`;

      // Check if lab has print settings enabled (default: true)
      const generatePrintVersion =
        labSettings?.pdf_settings?.generatePrintVersion !== false;

      // Prepare print HTML in advance (if needed) for parallel generation
      let printHtmlPrepared: string | null = null;

      // Create verification URL for QR code (used in both e-copy and print)
      const printVerifyUrl = `https://app.limsapp.in/verify?id=${
        encodeURIComponent(orderId || context.sampleId || "")
      }`;

      if (generatePrintVersion) {
        let printHtml = "";
        let effectivePrintOptionsForCss: Record<string, unknown> | null =
          mergedPrintOptions;
        const useCompactPrint =
          printLayoutMode === "compact" &&
          compactPrintPlan?.layoutMode === "compact";

        if (useCompactPrint) {
          const printSectionContent = (fullContext as any)
            ?.sectionContentNoImages || (fullContext as any)?.sectionContent || {};
          const compactPrintContext = {
            ...fullContext,
            ...printSectionContent,
            testGroupIds: orderedGroupIdsForPrint,
            sectionContent: printSectionContent,
            placeholderValues: {
              ...(fullContext?.placeholderValues || {}),
              ...printSectionContent,
            },
            isForPrint: true,
            hideWatermark: true,
            watermarkText: "",
            showWatermark: false,
          };
          const compactPrintOptions = {
            ...(mergedPrintOptions || {}),
            baseFontSize: Number((mergedPrintOptions as any)?.baseFontSize || 14),
            alternateRows: false,
            _isCompact: true,
          };
          effectivePrintOptionsForCss = compactPrintOptions;

          const emptySignatory = { signatoryName: "", signatoryDesignation: "", signatoryImageUrl: "" };

          // Per-group rendering â€” mirrors the eCopy path exactly:
          // page-break-before between groups on different pages, no break for same-page groups,
          // patient header / title bar suppressed for subsequent groups on the same page,
          // signature / QR suppressed for non-last groups on the same page.
          {
            const printGroupIds = orderedGroupIdsForPrint.filter(
              (id) => (orderedAnalytesByGroupForPrint.get(id)?.length ?? 0) > 0
            );
            const lastGroupId = printGroupIds.at(-1);
            const printSectionParts: string[] = [];
            let printPrevPageNum: number | null = null;

            for (const groupId of printGroupIds) {
              const groupAnalytes = orderedAnalytesByGroupForPrint.get(groupId) ?? [];
              const groupPageNum = printOrderByGroupId.get(groupId) ?? 999;

              const isSamePageAsPrev = printPrevPageNum !== null &&
                groupPageNum !== 0 && groupPageNum !== 999 &&
                groupPageNum === printPrevPageNum;

              const groupIdx = printGroupIds.indexOf(groupId);
              const nextGroupId = groupIdx >= 0 ? printGroupIds[groupIdx + 1] : undefined;
              const nextPageNum = nextGroupId ? (printOrderByGroupId.get(nextGroupId) ?? 999) : null;
              const isSamePageAsNext = nextPageNum !== null &&
                nextPageNum !== 0 && nextPageNum !== 999 &&
                nextPageNum === groupPageNum;

              const isLastGroup = groupId === lastGroupId;
              // Last group on its page = no following group shares the same page number
              const isLastOnPage = !isSamePageAsNext;

              const groupPrintOptions = {
                ...compactPrintOptions,
                _suppressPatientHeader: isSamePageAsPrev,
                _suppressSignature: !isLastOnPage,
              };

              const groupAnalyteMap = new Map([[groupId, groupAnalytes]]);
              const groupCtx = { ...compactPrintContext, testGroupIds: [groupId] };

              let groupHtml = generateDefaultTemplateHtml(
                groupCtx,
                testGroupNames,
                groupAnalyteMap,
                signatoryInfo,                          // every page's last group shows signature
                isLastGroup ? printSectionContent : {}, // sections only on absolute last page
                isLastGroup,
                compactPrintConfig.compactTemplateStyle,
                labSettings?.show_methodology ?? true,
                false,
                labSettings?.report_patient_info_config,
                groupPrintOptions,
                customPatientFieldConfigs ?? [],
                undefined,
                testGroupInterpretations,
                (fullContext as any)?.sectionLabels,
              );
              groupHtml = renderTemplate(groupHtml, compactPrintContext);
              groupHtml = injectGroupRemark(groupHtml, groupRemarks.get(groupId) || "");
              if (isLastOnPage) {
                groupHtml = injectQrCode(groupHtml, printVerifyUrl);
              }

              const pageBreakStyle = !isSamePageAsPrev && printSectionParts.length > 0
                ? 'style="page-break-before: always; break-before: page;"'
                : '';
              printSectionParts.push(`<div ${pageBreakStyle}>${groupHtml}</div>`);
              printPrevPageNum = groupPageNum;
            }

            let compactRenderedHtml = printSectionParts.join('');
            compactRenderedHtml = addFlagClassesToHtml(compactRenderedHtml);
            printHtml = buildPdfBodyDocumentV2(compactRenderedHtml, "", null, pdfSettings, printVerifyUrl);
            console.log(`âœ… Built compact print HTML per-group (${printSectionParts.length} groups, plan-aware page breaks)`);
          }
        } else if (rawHtmlForPrint) {
          // rawHtmlForPrint contains the full E-Copy HTML with letterhead styles and spacers
          // For print version, we need to extract just the CONTENT and rebuild with null letterhead

          // Strategy: Extract the content inside <main class="limsv2-report-body...">...</main>
          // and rebuild a clean HTML document without letterhead
          const mainContentMatch = rawHtmlForPrint.match(
            /<main[^>]*class="[^"]*limsv2-report-body[^"]*"[^>]*>([\s\S]*?)<\/main>/i,
          );

          if (mainContentMatch) {
            const extractedContent = mainContentMatch[1];
            console.log(
              "âœ… Extracted main content from rawHtmlForPrint, length:",
              extractedContent.length,
            );

            // Rebuild clean HTML with NO letterhead (pass null for letterheadBackgroundUrl)
            // Print version: Include QR code for verification (positioned at top since no letterhead spacer)
            printHtml = buildPdfBodyDocumentV2(
              extractedContent,
              "",
              null,
              pdfSettings,
              printVerifyUrl,
            );
            console.log(
              "âœ… Rebuilt print HTML without letterhead, with QR code",
            );
          } else {
            // Fallback: Try to strip letterhead elements manually
            console.log(
              "âš ï¸ Could not extract main content, falling back to stripping approach",
            );
            printHtml = rawHtmlForPrint;

            // Remove letterhead styles
            printHtml = printHtml.replace(
              /<style id="lims-letterhead">[\s\S]*?<\/style>/gi,
              "",
            );

            // Remove background div
            printHtml = printHtml.replace(/<div id="page-bg"><\/div>/gi, "");

            // Keep QR code but fix its position for print (no letterhead spacer, so use 25px from top)
            printHtml = printHtml.replace(
              /(<div[^>]*style="[^"]*top:\s*)\d+px/gi,
              "$125px",
            );
          }
        } else {
          const printSectionContent = (fullContext as any)
            ?.sectionContentNoImages || (fullContext as any)?.sectionContent || {};
          const printTemplateContext = {
            ...fullContext,
            ...printSectionContent,
            sectionContent: printSectionContent,
            placeholderValues: {
              ...(fullContext?.placeholderValues || {}),
              ...printSectionContent,
            },
            isForPrint: true,
            hideWatermark: true,
            watermarkText: "",
            showWatermark: false,
          };
          let printRenderedHtml = "";
          const printInterpretationTemplates = getInterpretationTemplatesForGroup(
            context.testGroupIds?.[0],
          );
          const renderedPrintInterpretation = renderInterpretationBlocks(
            printInterpretationTemplates,
            printTemplateContext,
          );

          if (template?.gjs_html) {
            // Use custom template
            printRenderedHtml = renderTemplate(
              template.gjs_html,
              printTemplateContext,
            );
            const printGroupId = context.testGroupIds?.[0];
            printRenderedHtml = injectGroupRemark(
              printRenderedHtml,
              printGroupId ? groupRemarks.get(printGroupId) || "" : "",
              /\{\{\s*groupRemark\s*\}\}/.test(template.gjs_html),
            );

            // Inject signature image if template doesn't have one (Critical for print version, unless showSignature is false)
            if (signatoryInfo.signatoryImageUrl && (mergedPrintOptions as any)?.showSignature !== false) {
              printRenderedHtml = injectSignatureImage(
                printRenderedHtml,
                signatoryInfo.signatoryImageUrl,
                signatoryInfo.signatoryName,
                signatoryInfo.signatoryDesignation,
              );
            }

            // Inject QR code for verification (next to signature area)
            const printVerifyUrlForQr = `https://app.limsapp.in/verify?id=${
              encodeURIComponent(orderId || context.sampleId || "")
            }`;
            printRenderedHtml = injectQrCode(
              printRenderedHtml,
              printVerifyUrlForQr,
            );

            if (renderedPrintInterpretation.html) {
              printRenderedHtml += renderedPrintInterpretation.html;
            }
          } else {
            // No custom template - use default template
            console.log("âš ï¸ Using default template for print version");
            const printSingleGroupId = context.testGroupIds?.[0];
            const printResolvedStyle = (printSingleGroupId && testGroupStyles.get(printSingleGroupId)) || labSettings?.default_template_style || 'beautiful';
            printRenderedHtml = generateDefaultTemplateHtml(
              context,
              testGroupNames,
              analytesByGroup,
              signatoryInfo,
              printSectionContent,
              true,
              printResolvedStyle,
              labSettings?.show_methodology ?? true,
              labSettings?.show_interpretation ?? false,
              labSettings?.report_patient_info_config,
              mergedPrintOptions ?? undefined,
              customPatientFieldConfigs ?? [],
              printSingleGroupId,
              testGroupInterpretations,
              (fullContext as any)?.sectionLabels,
            );
            printRenderedHtml = renderTemplate(
              printRenderedHtml,
              printTemplateContext,
            );
            printRenderedHtml = injectGroupRemark(
              printRenderedHtml,
              printSingleGroupId ? groupRemarks.get(printSingleGroupId) || "" : "",
            );

            // Inject QR code for verification (next to signature area)
            const printDefaultVerifyUrl = `https://app.limsapp.in/verify?id=${
              encodeURIComponent(orderId || context.sampleId || "")
            }`;
            printRenderedHtml = injectQrCode(
              printRenderedHtml,
              printDefaultVerifyUrl,
            );

            if (renderedPrintInterpretation.html) {
              printRenderedHtml += renderedPrintInterpretation.html;
            }
          }

          // AUTO-FIX: Apply flag classes (so we can style them bold in print CSS)
          printRenderedHtml = addFlagClassesToHtml(printRenderedHtml);

          // Build print HTML body - gjs_css is injected separately below after this block
          // CRITICAL: Pass null for letterhead so we get a clean HTML without background/spacers
          // Print version: Include QR code for verification (positioned at top since no letterhead spacer)
          printHtml = buildPdfBodyDocumentV2(
            printRenderedHtml,
            renderedPrintInterpretation.css || "",
            null,
            pdfSettings,
            printVerifyUrl,
          );
          console.log(
            "âœ… Built print HTML without gjs_css, with QR code (clean print mode)",
          );

          // Skip section content injection for print fallback path.
          // Sections already render via template placeholders to avoid duplicates.
        }

        // Strip section images for print output
        printHtml = printHtml.replace(
          /<div class="section-images"[\s\S]*?<\/div>/gi,
          "",
        );
        printHtml = printHtml.replace(
          /<img[^>]*class="section-image"[^>]*>/gi,
          "",
        );

        // Strip old lims-report-custom (may be from eCopy gjs_css or empty), then re-inject
        // with: gjs_css (template's own CSS) + merged printOptions overrides
        printHtml = printHtml.replace(
          /<style id="lims-report-custom">[\s\S]*?<\/style>/gi,
          "",
        );
        {
          const gjsCssPart = template?.gjs_css || "";
          const printOptionsCss = (effectivePrintOptionsForCss && Object.keys(effectivePrintOptionsForCss).length > 0)
            ? generateDynamicCss(pdfSettings, effectivePrintOptionsForCss)
            : generateDynamicCss(pdfSettings);
          const combinedCss = [gjsCssPart, printOptionsCss].filter(Boolean).join("\n");
          if (combinedCss) {
            printHtml = printHtml.replace(
              "</head>",
              `<style id="lims-report-custom">${combinedCss}</style></head>`,
            );
          }
        }

        // Inject report extras - INSIDE </main> not </body> for proper layout
        // Exclude histograms already injected inline into their test group section (multi-group path)
        const inlineInjectedHistoCodes = new Set(
          [...histogramsByGroupId.values()].flat().map((r: any) => r.test_code)
        );
        const reportExtrasForPrint = inlineInjectedHistoCodes.size > 0
          ? {
              ...reportExtras,
              analyzer_histogram_svgs: (reportExtras.analyzer_histogram_svgs || [])
                .filter((r: any) => !inlineInjectedHistoCodes.has(r.test_code)),
            }
          : reportExtras;

        let printExtrasHtml = "";
        if (useCompactPrint) {
          // Compact print: include analyzer graphs only, scaled down to fit on page
          const svgRows = (reportExtrasForPrint.analyzer_histogram_svgs || []).filter((r: any) => r.svg_data);
          if (svgRows.length > 0) {
            printExtrasHtml = '<div style="margin-top:10px;page-break-inside:avoid;">';
            printExtrasHtml += '<p style="margin:0 0 5px 0;font-size:10px;font-weight:700;color:#1e40af;border-bottom:1px solid #93c5fd;padding-bottom:2px;letter-spacing:0.05em;">ANALYZER HISTOGRAMS</p>';
            printExtrasHtml += '<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:flex-start;">';
            for (const row of svgRows) {
              // Scale SVG down by injecting max-width on the svg tag
              const compactSvg = row.svg_data.replace(/<svg\b/i, '<svg style="max-width:130px;height:auto;display:block;"');
              printExtrasHtml += `<div style="flex:0 0 auto;text-align:center;">${compactSvg}</div>`;
            }
            printExtrasHtml += '</div></div>';
          }
        } else {
          printExtrasHtml = generateReportExtrasHtml(reportExtrasForPrint);
        }
        if (printExtrasHtml) {
          printHtml = printHtml.replace("</main>", `${printExtrasHtml}</main>`);
        }

        // NOTE: Attachments are NOT injected into print version (only in e-copy)

        // SKIP: Convert images to base64 (PDF.co can fetch directly)
        // printHtml = await convertHtmlImagesToBase64(printHtml)
        console.log("âœ… Print HTML ready (using direct image URLs)");

        // Inject print-optimized CSS (grayscale, simplified colors)
        // REFINED: Don't nuke ALL backgrounds (protects table headers)
        // Font weights in the print copy must mirror the basic-template CSS
        // (generateBasicDefaultTemplateHtml) so print and e-copy look identical.
        // Previously these were hardcoded to 600/700/900, which silently
        // out-specified the template rules and bolded the whole result table.
        const pcOpts = effectivePrintOptionsForCss || mergedPrintOptions || {};
        const pcBoldAllValues = (pcOpts.boldAllValues as boolean) ?? false;
        const pcTestNameBold = (pcOpts.testNameBold as boolean) ?? false;
        const pcBoldAbnormal = (pcOpts.boldAbnormalValues as boolean) ?? true;
        const pcUnderlineAbnormal =
          (pcOpts.underlineAbnormalValues as boolean) ?? false;
        const pcPatientInfoBold = (pcOpts.patientInfoBold as boolean) ?? false;
        const pcPatientInfoColumnDivider =
          (pcOpts.patientInfoColumnDivider as boolean) ?? false;

        const printCss = `
        <style id="lims-print-css">
          /* FORCE BLACK & WHITE / GRAYSCALE */
          html, body {
            -webkit-filter: grayscale(100%) !important;
            filter: grayscale(100%) !important;
            background: white !important;
            color: black !important;
          }
          
          /* RESET fancy UI backgrounds, but keep table headers readable */
          .report-header,
          .section-header,
          .note,
          .report-container {
            background: transparent !important;
            box-shadow: none !important;
          }
          
          /* Ensure explicit table borders for print legibility
             Skipped when: tableBorders=false OR a custom GrapesJS template is used
             (custom templates control their own border styles via gjs_css) */
          ${!template?.gjs_html && mergedPrintOptions?.tableBorders !== false ? `table, tr, th, td { border-color: #000 !important; }` : ''}

          /* Force black text for everything */
          body, p, span, td, th, div, h1, h2, h3, h4, h5, h6, strong, b, i, em {
            color: #000000 !important;
          }

          /* Neutralize colored backgrounds - specific targeting */
          .bg-blue-50, .bg-green-50, .bg-yellow-50, .bg-red-50,
          [class*="bg-"], [style*="background"] {
            background-color: #ffffff !important;
            background: #ffffff !important;
          }

          /* Neutralize colored text */
          [class*="text-"], [style*="color"] {
            color: #000000 !important;
          }

          /* Explicitly kill shadows on containers */
          .report-container, .report-body, .card, .box {
            box-shadow: none !important;
            border: none !important;
          }

          /* Clean table styling for print - only for default templates, not custom GrapesJS */
          ${!template?.gjs_html ? `
          table { border-collapse: collapse !important; ${mergedPrintOptions?.tableBorders !== false ? 'border: 1px solid #000 !important;' : 'border: none !important;'} }
          tr { ${mergedPrintOptions?.tableBorders !== false ? '' : 'border: none !important; border-top: none !important; border-bottom: none !important;'} }
          td, th { ${mergedPrintOptions?.tableBorders !== false ? 'border: 1px solid #000 !important;' : 'border: none !important;'} padding: 4px 8px !important; color: black !important; }
          thead th { background: #f0f0f0 !important; font-weight: bold !important; ${mergedPrintOptions?.tableBorders !== false ? 'border-bottom: 2px solid #000 !important;' : ''} }
          ` : ''}

          /* Header/Footer specific fixes for B&W */
          .report-header, .report-footer {
             background: transparent !important;
             color: black !important;
             border: none !important;
          }

          /* Darken report result tables for physical paper prints */
          .tbl-results,
          .tbl-results *,
          .basic-report-template .tbl-results,
          .basic-report-template .tbl-results * {
            color: #000000 !important;
            opacity: 1 !important;
            -webkit-text-fill-color: #000000 !important;
          }

          /* Darken only — weight is left to the template CSS so the print copy
             honours boldAllValues / testNameBold like the e-copy does. */
          .tbl-results td,
          .tbl-results th,
          .basic-report-template .tbl-results td,
          .basic-report-template .tbl-results th {
            text-shadow: 0 0 0 #000000 !important;
          }

          .tbl-results thead th,
          .basic-report-template .tbl-results thead th,
          .main-group-row td,
          .sub-section-header td,
          .center-title {
            font-weight: 700 !important;
            color: #000000 !important;
          }

          .test-name,
          .basic-report-template .test-name {
            color: #000000 !important;
            font-weight: ${pcTestNameBold ? "600" : "normal"} !important;
            opacity: 1 !important;
          }

          .val,
          .same-row-sibling,
          .basic-report-template .val,
          .basic-report-template .same-row-sibling {
            color: #000000 !important;
            font-weight: ${pcBoldAllValues ? "600" : "normal"} !important;
            opacity: 1 !important;
          }

          .same-row-sibling-unit,
          .same-row-sibling-ref,
          .basic-report-template .same-row-sibling-unit,
          .basic-report-template .same-row-sibling-ref {
            color: #000000 !important;
            font-weight: normal !important;
            opacity: 1 !important;
          }

          .basic-report-template .patient-header-table td {
            font-weight: ${pcPatientInfoBold ? "700" : "normal"} !important;
          }

          ${pcPatientInfoColumnDivider ? `
          /* Patient info column divider. The generic print border rules above
             would otherwise box every cell, so clear them first and draw only
             the single vertical rule between the two column pairs. */
          .basic-report-template .patient-header-table tr > *,
          .basic-report-template .patient-header-table td,
          .basic-report-template .patient-header-table th {
            border: none !important;
          }
          .basic-report-template .patient-header-table tr > *:nth-child(2) {
            border-right: 1px solid #000 !important;
            padding-right: 8px !important;
          }
          .basic-report-template .patient-header-table tr > *:nth-child(3) {
            padding-left: 8px !important;
          }
          ` : ""}

          /* Hide non-print elements */
          .watermark, .draft-watermark { display: none !important; }

          /* Abnormal emphasis in Print Mode — follows boldAbnormalValues /
             underlineAbnormalValues so it matches the e-copy. */
          .value-low, .flag-low,
          .value-high, .flag-high,
          .value-critical, .flag-critical,
          .value-abnormal, .flag-abnormal,
          .value-trace, .flag-trace,
          .value-critical_h, .flag-critical_h,
          .value-critical_l, .flag-critical_l {
            color: #000000 !important;
            ${pcBoldAbnormal ? "font-weight: 700 !important;" : ""}
          }

          tr.has-visible-flag > td.val,
          tr.has-visible-flag > td .val,
          .basic-report-template tr.has-visible-flag > td.val,
          .basic-report-template tr.has-visible-flag > td .val {
            color: #000000 !important;
            ${pcBoldAbnormal ? "font-weight: 700 !important;" : ""}
            ${
          pcUnderlineAbnormal
            ? `text-decoration-line: underline !important;
            text-decoration-thickness: 1.2px !important;
            text-underline-offset: 2px !important;`
            : ""
        }
          }
        </style>
      `;
        printHtml = printHtml.replace("</head>", `${printCss}</head>`);
        console.log("âœ… Print CSS injected (grayscale + clean styling)");

        // Inject Last Page for print version (same as eCopy - after all content, before </body>)
        if (lastPage) {
          printHtml = printHtml.replace(
            "</body>",
            `<div class="report-last-page" style="page-break-before: always; width: 100vw; height: 100vh; margin: 0; padding: 0;">${lastPage}</div></body>`,
          );
          console.log("âœ… Last page injected into print version");
        }

        printHtmlPrepared = printHtml;
      }

      // ========================================
      // PARALLEL PDF Generation - eCopy + Print simultaneously
      // ========================================
      console.log("ðŸ“¤ Preparing to send HTML to PDF.co...");
      console.log("  ï¿½ PDF Mode:", pdfLetterheadMode);
      console.log("  ðŸ“„ Processed body length:", processedBody.length);
      if (pdfLetterheadMode === 'header_footer') {
        console.log("  ðŸ–¼ï¸ Header HTML length:", headerFooterHtml.headerHtml.length);
        console.log("  ðŸ–¼ï¸ Footer HTML length:", headerFooterHtml.footerHtml.length);
      } else {
        console.log(
          "  ðŸ” Checking for letterhead in HTML:",
          processedBody.includes("page-bg") ? "âœ… FOUND (page-bg)" : "âŒ NOT FOUND",
        );
        console.log(
          "  ðŸ” Checking for letterhead URL in HTML:",
          processedBody.includes("background-image")
            ? "âœ… FOUND"
            : "âŒ NOT FOUND",
        );
      }

      // Build PDF.co options based on mode
      const isHeaderFooterMode = pdfLetterheadMode === 'header_footer';
      const hasNativeHeaderFooterAssets = isHeaderFooterMode &&
        !processedBodyHasLetterhead &&
        !!headerFooterHtml.headerHtml &&
        !!headerFooterHtml.footerHtml;

      if (isHeaderFooterMode) {
        console.log(
          "  ðŸ§¾ Native PDF.co header/footer payload:",
          hasNativeHeaderFooterAssets ? "ENABLED" : "DISABLED (missing header or footer image)",
        );
      }

      const eCopyPromise = sendHtmlToPdfCo(
        processedBody,
        filename,
        PDFCO_API_KEY,
        {
          headerHtml: hasNativeHeaderFooterAssets ? headerFooterHtml.headerHtml : processedHeader,
          footerHtml: hasNativeHeaderFooterAssets ? headerFooterHtml.footerHtml : processedFooter,
          margins: hasNativeHeaderFooterAssets
            ? (pdfSettings?.margins
              ? `${parseMarginValue(pdfSettings.margins.top, 180)}px ${parseMarginValue(pdfSettings.margins.right, 20)}px ${parseMarginValue(pdfSettings.margins.bottom, 150)}px ${parseMarginValue(pdfSettings.margins.left, 20)}px`
              : DEFAULT_PDF_SETTINGS.margins)
            : margins,
          headerHeight: hasNativeHeaderFooterAssets
            ? (pdfSettings?.headerHeight
              ? `${parseMarginValue(pdfSettings.headerHeight, 90)}px`
              : DEFAULT_PDF_SETTINGS.headerHeight)
            : (processedBodyHasLetterhead
              ? "0px"
              : (pdfSettings?.headerHeight
                ? `${parseMarginValue(pdfSettings.headerHeight, 90)}px`
                : DEFAULT_PDF_SETTINGS.headerHeight)),
          footerHeight: hasNativeHeaderFooterAssets
            ? (pdfSettings?.footerHeight
              ? `${parseMarginValue(pdfSettings.footerHeight, 80)}px`
              : DEFAULT_PDF_SETTINGS.footerHeight)
            : (processedBodyHasLetterhead
              ? "0px"
              : (pdfSettings?.footerHeight
                ? `${parseMarginValue(pdfSettings.footerHeight, 80)}px`
                : DEFAULT_PDF_SETTINGS.footerHeight)),
          scale: pdfSettings?.scale ?? DEFAULT_PDF_SETTINGS.scale,
          displayHeaderFooter: hasNativeHeaderFooterAssets
            ? true
            : (processedBodyHasLetterhead
              ? false
              : (pdfSettings?.displayHeaderFooter ??
                DEFAULT_PDF_SETTINGS.displayHeaderFooter)),
          paperSize: DEFAULT_PDF_SETTINGS.paperSize,
          mediaType: DEFAULT_PDF_SETTINGS.mediaType,
          printBackground: DEFAULT_PDF_SETTINGS.printBackground,
        },
      );

      const printPromise = printHtmlPrepared
        ? sendHtmlToPdfCo(
          printHtmlPrepared,
          `Print_${filename}`,
          PDFCO_API_KEY!,
          {
            // Print PDF should always be body-only.
            // Native PDF.co header/footer is reserved for eCopy only.
            headerHtml: "",
            footerHtml: "",
            // Use lab's saved margins for print (with 20px minimum)
            margins: `${Math.max(parseMarginValue(pdfSettings?.margins?.top, 20), 20)}px ${Math.max(parseMarginValue(pdfSettings?.margins?.right, 20), 20)}px ${Math.max(parseMarginValue(pdfSettings?.margins?.bottom, 20), 20)}px ${Math.max(parseMarginValue(pdfSettings?.margins?.left, 20), 20)}px`,
            headerHeight: "0px",
            footerHeight: "0px",
            scale: pdfSettings?.scale ?? DEFAULT_PDF_SETTINGS.scale,
            displayHeaderFooter: false,
            paperSize: DEFAULT_PDF_SETTINGS.paperSize,
            mediaType: "print",
            printBackground: true,
          },
        )
        : Promise.resolve(null);

      // Wait for both PDFs to generate in parallel
      const [pdfCoUrl, printPdfCoUrl] = await Promise.all([
        eCopyPromise,
        printPromise,
      ]);

      console.log(
        `âœ… PDFs generated in ${Date.now() - pdfStartTime}ms (parallel)`,
      );
      console.log("  eCopy URL:", pdfCoUrl ? "âœ“" : "âœ—");
      console.log("  Print URL:", printPdfCoUrl ? "âœ“" : "skipped");

      await updateProgress(
        supabaseClient,
        job.id,
        "Uploading PDFs to storage...",
        85,
      );

      // ========================================
      // Step 11: Upload PDFs to Storage (PARALLEL)
      // ========================================
      console.log(
        "\nðŸ“¦ Step 11: Uploading PDFs to Supabase Storage (parallel)...",
      );
      const uploadStartTime = Date.now();

      // Small delay before downloads to let PDF.co finalize
      await new Promise((resolve) => setTimeout(resolve, 1500));

      const eCopyUploadPromise = uploadPdfToStorage(
        supabaseClient,
        pdfCoUrl,
        orderId,
        job.lab_id,
        context.patientId || "unknown",
        filename,
        "final",
        5,
      );

      const printUploadPromise = printPdfCoUrl
        ? uploadPdfToStorage(
          supabaseClient,
          printPdfCoUrl,
          orderId,
          job.lab_id,
          context.patientId || "unknown",
          `Print_${filename}`,
          "print",
          5,
        ).catch((err) => {
          console.warn("âš ï¸ Print upload failed (non-fatal):", err.message);
          return null;
        })
        : Promise.resolve(null);

      const [eCopyResult, printResult] = await Promise.all([
        eCopyUploadPromise,
        printUploadPromise,
      ]);

      let storageUrl = eCopyResult.publicUrl;
      let printStorageUrl: string | null = printResult?.publicUrl || null;

      // If eCopy used temp fallback (path is empty), attempt one final delayed retry
      // before giving up and keeping the temp URL as last resort
      if (eCopyResult.path === "" && pdfCoUrl) {
        console.warn(
          "âš ï¸ eCopy fell back to temp URL â€” waiting 15s then attempting one final retry...",
        );
        await new Promise((resolve) => setTimeout(resolve, 15000));
        try {
          const retryResult = await uploadPdfToStorage(
            supabaseClient,
            pdfCoUrl,
            orderId,
            job.lab_id,
            context.patientId || "unknown",
            filename,
            "final",
            3,
          );
          if (retryResult.path !== "") {
            storageUrl = retryResult.publicUrl;
            console.log(
              "âœ… Final delayed retry succeeded â€” eCopy saved to storage:",
              storageUrl,
            );
          } else {
            console.warn(
              "âš ï¸ Final delayed retry also returned temp URL â€” keeping temp URL as last resort:",
              storageUrl,
            );
          }
        } catch (retryErr) {
          console.warn(
            "âš ï¸ Final delayed retry threw â€” keeping temp URL as last resort:",
            retryErr instanceof Error ? retryErr.message : String(retryErr),
          );
          // storageUrl already holds the temp URL â€” leave it unchanged
        }
      }

      console.log(
        `âœ… PDFs uploaded in ${Date.now() - uploadStartTime}ms (parallel)`,
      );
      console.log("  eCopy:", storageUrl);
      console.log("  Print:", printStorageUrl || "none");

      await updateProgress(
        supabaseClient,
        job.id,
        "Updating database records...",
        95,
      );

      // ========================================
      // Step 12: Update Database Records
      // ========================================
      console.log("\nðŸ’¾ Step 12: Updating database records...");

      const now = new Date().toISOString();

      // Get patient_id and doctor name from context (required fields for reports table)
      // Try multiple sources for patient_id
      let patientId = context.patientId || context.patient?.id;

      // If still null, try to get from orders table
      if (!patientId) {
        const { data: orderData } = await supabaseClient
          .from("orders")
          .select("patient_id")
          .eq("id", orderId)
          .single();
        patientId = orderData?.patient_id;
      }

      const doctorName = context.order?.referringDoctorName ||
        context.placeholderValues?.referringDoctorName ||
        context.order?.doctor ||
        "";

      if (!patientId) {
        console.error("âŒ Missing patient_id - cannot create report record");
        console.error("Context patient sources:", {
          contextPatientId: context.patientId,
          patientObjectId: context.patient?.id,
          orderId,
        });
        // Don't throw - continue without creating report record, PDF is still generated
        console.warn(
          "âš ï¸ Skipping report record creation due to missing patient_id",
        );
      }

      console.log("ðŸ“‹ Report record data:", {
        orderId,
        patientId,
        doctorName,
        pdfUrl: storageUrl,
        printPdfUrl: printStorageUrl || "none",
      });

      // Track report ID for notification - declare before the if block so it's in scope
      let reportIdForNotif: string | null = null;

      // Only create/update report record if we have patient_id
      if (patientId) {
        // Update or create report record - include ALL fields like normal flow
        const { data: existingReport, error: selectError } =
          await supabaseClient
            .from("reports")
            .select("id")
            .eq("order_id", orderId)
            .maybeSingle();

        // Fields to update (for existing record)
        // Compact mode: save eCopy to compact_ecopy_url â€” never overwrite pdf_url (standard eCopy).
        // Standard mode: save eCopy to pdf_url as usual.
        const updateFields = {
          ...(printLayoutMode !== "compact"
            ? { pdf_url: storageUrl, pdf_generated_at: now }
            : { compact_ecopy_url: storageUrl, compact_ecopy_generated_at: now }),
          status: "completed",
          report_status: "completed",
          report_type: isDraft ? "draft" : "final",
          print_layout_mode: printLayoutMode,
          print_plan_json: compactPrintPlan,
          print_plan_source: compactPrintPlan?.source || null,
          updated_at: now,
          ...(printStorageUrl && {
            print_pdf_url: printStorageUrl,
            print_pdf_generated_at: now,
          }),
        };

        // Fields for new record (includes required fields)
        const insertFields = {
          order_id: orderId,
          patient_id: patientId,
          lab_id: job.lab_id, // Add lab_id for multi-lab filtering
          doctor: doctorName,
          generated_date: now,
          ...updateFields,
        };

        // Initialize with existing report ID if it exists
        reportIdForNotif = existingReport?.id || null;

        if (existingReport) {
          const { error: updateError } = await supabaseClient
            .from("reports")
            .update(updateFields)
            .eq("id", reportIdForNotif);

          if (updateError) {
            console.error("âš ï¸ Report update error:", updateError);
          } else {
            console.log("âœ… Updated existing report record with all fields");
          }
        } else {
          const { data: newReport, error: insertError } = await supabaseClient
            .from("reports")
            .insert(insertFields)
            .select("id")
            .single();

          if (insertError) {
            console.error("âš ï¸ Report insert error:", insertError);
            console.error("Insert data:", insertFields);
          } else {
            reportIdForNotif = newReport.id;
            console.log(
              "âœ… Created new report record with all fields, ID:",
              reportIdForNotif,
            );
          }
        }
      } // End of if (patientId)

      // Mark job as completed - WITH ERROR CHECKING
      const { error: completeError } = await supabaseClient
        .from("pdf_generation_queue")
        .update({
          status: "completed",
          completed_at: new Date().toISOString(),
          progress_stage: "Completed",
          progress_percent: 100,
        })
        .eq("id", job.id);

      if (completeError) {
        console.error("âš ï¸ Failed to mark job as completed:", completeError);
        // Try again with simpler update
        const { error: retryError } = await supabaseClient
          .from("pdf_generation_queue")
          .update({ status: "completed", progress_percent: 100 })
          .eq("id", job.id);

        if (retryError) {
          console.error("âŒ Retry also failed:", retryError);
        } else {
          console.log("âœ… Job marked complete on retry");
        }
      } else {
        console.log("âœ… Job marked as COMPLETED in queue");
      }

      // ====== AUTO-TRIGGER WHATSAPP NOTIFICATIONS ======
      // Trigger if we have a valid report ID
      if (patientId && reportIdForNotif) {
        console.log("ðŸ“² Checking WhatsApp auto-send settings...");
        try {
          // Fetch lab notification settings
          const { data: notifSettings } = await supabaseClient
            .from("lab_notification_settings")
            .select("*")
            .eq("lab_id", job.lab_id)
            .maybeSingle();

          if (
            notifSettings?.auto_send_report_to_patient ||
            notifSettings?.auto_send_report_to_doctor
          ) {
            console.log("ðŸ“² Auto-send enabled, fetching recipient details...");

            const parseMinutes = (
              timeStr: string | null | undefined,
              fallback: string,
            ) => {
              const [h, m] = (timeStr || fallback).split(":").map(Number);
              return (h * 60) + m;
            };

            // Edge functions run in UTC. Send window times are in IST (UTC+5:30).
            const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
            const utcNow = Date.now();
            const istDate = new Date(utcNow + IST_OFFSET_MS);
            const currentMinutes = istDate.getUTCHours() * 60 + istDate.getUTCMinutes();
            console.log(`â° Time check: UTC=${new Date(utcNow).toISOString()}, IST=${istDate.toISOString()}, currentMinutes=${currentMinutes}`);
            const startMinutes = parseMinutes(notifSettings.send_window_start, "09:00:00");
            const endMinutes = parseMinutes(notifSettings.send_window_end, "21:00:00");
            const withinWindow = startMinutes <= endMinutes
              ? (currentMinutes >= startMinutes && currentMinutes <= endMinutes)
              : (currentMinutes >= startMinutes || currentMinutes <= endMinutes);
            console.log(`â° Window: ${startMinutes}-${endMinutes}, current=${currentMinutes}, within=${withinWindow}`);

            const requiredStatus =
              String(notifSettings.send_report_on_status || "Completed").toLowerCase();
            const { data: reportForStatus } = await supabaseClient
              .from("reports")
              .select("status, report_status")
              .eq("id", reportIdForNotif)
              .maybeSingle();
            const currentStatus =
              String(reportForStatus?.report_status || reportForStatus?.status || "")
                .toLowerCase();
            const statusMatches = currentStatus === requiredStatus;
            console.log(`ðŸ“‹ Status check: required=${requiredStatus}, current=${currentStatus}, matches=${statusMatches}`);

            // Calculate next window start in IST, convert to UTC for scheduled_for
            const [startHour, startMinute] =
              (notifSettings.send_window_start || "09:00:00").split(":").map(Number);
            const nextIst = new Date(utcNow + IST_OFFSET_MS);
            nextIst.setUTCHours(startHour, startMinute, 0, 0);
            if (nextIst.getTime() <= utcNow + IST_OFFSET_MS) {
              nextIst.setUTCDate(nextIst.getUTCDate() + 1);
            }
            const nextWindowStart = new Date(nextIst.getTime() - IST_OFFSET_MS);

            const canAttemptImmediate = withinWindow && statusMatches;
            console.log(`ðŸš¦ canAttemptImmediate=${canAttemptImmediate} (window=${withinWindow}, status=${statusMatches})`);
            const shouldQueueOutsideWindow = notifSettings.queue_outside_window !== false;
            const deferredScheduledFor = withinWindow
              ? new Date().toISOString()
              : nextWindowStart.toISOString();

            // Fetch patient and doctor phone numbers, plus clinical summary fields
            const { data: order } = await supabaseClient
              .from("orders")
              .select(`
              patient_name,
              ai_clinical_summary,
              include_clinical_summary_in_report,
              patients!inner (id, phone, name),
              doctors (id, phone, name)
            `)
              .eq("id", orderId)
              .single();

            if (order) {
              const { data: orderTests } = await supabaseClient
                .from("order_tests")
                .select("test_name")
                .eq("order_id", orderId);

              const testNames = orderTests?.map((t) =>
                t.test_name
              ).join(", ") || "Lab Test";

              // Fetch lab details once for use throughout WhatsApp notification section
              const { data: lab } = await supabaseClient
                .from("labs")
                .select("name, whatsapp_user_id, country_code, block_send_on_due")
                .eq("id", job.lab_id)
                .single();

              // ========================================
              // SMART WHATSAPP ROUTING (Priority Order)
              // ========================================
              // 1. User who triggered (highest priority) - whoever clicked "Generate PDF"
              // 2. Location-based user (branch manager) - assigned to order's location
              // 3. Lab-level account (fallback) - central WhatsApp account
              // ========================================

              let whatsappUserId: string | null = null;
              let whatsappUserName: string | null = null;

              // Priority 1: User who triggered this request
              if (triggeredByUserId) {
                const { data: triggeringUser } = await supabaseClient
                  .from("users")
                  .select("id, name, whatsapp_user_id")
                  .eq("id", triggeredByUserId)
                  .single();

                if (triggeringUser?.whatsapp_user_id) {
                  whatsappUserId = triggeringUser.whatsapp_user_id;
                  whatsappUserName = triggeringUser.name;
                  console.log(
                    `âœ… [Priority 1] Using triggering user's WhatsApp: ${whatsappUserName}`,
                  );
                } else {
                  console.log(
                    `âš ï¸ Triggering user (${
                      triggeringUser?.name || triggeredByUserId
                    }) has no whatsapp_user_id - checking location...`,
                  );
                }
              }

              // Priority 2: Location-based routing (find user assigned to order's location)
              if (!whatsappUserId && order.location_id) {
                console.log(
                  `ðŸ” Checking for location-based WhatsApp user for location: ${order.location_id}`,
                );

                // Find users assigned to this location with WhatsApp connected
                // Prioritize: Lab Manager > Lab Technician > any user with WhatsApp
                const { data: locationUsers } = await supabaseClient
                  .from("users")
                  .select(
                    "id, name, role, whatsapp_user_id, default_location_id",
                  )
                  .eq("lab_id", job.lab_id)
                  .not("whatsapp_user_id", "is", null)
                  .or(`default_location_id.eq.${order.location_id}`)
                  .order("role", { ascending: true }) // Lab Manager comes before Lab Technician
                  .limit(5);

                if (locationUsers && locationUsers.length > 0) {
                  // Prefer Lab Manager role if available
                  const locationUser = locationUsers.find((u) =>
                    u.role === "Lab Manager"
                  ) || locationUsers[0];
                  whatsappUserId = locationUser.whatsapp_user_id;
                  whatsappUserName = locationUser.name;
                  console.log(
                    `âœ… [Priority 2] Using location-based WhatsApp: ${whatsappUserName} (${locationUser.role}) at location ${order.location_id}`,
                  );
                } else {
                  console.log(
                    `âš ï¸ No users with WhatsApp found for location: ${order.location_id}`,
                  );
                }
              }

              // Priority 3: Lab-level fallback (deprecated but kept for backwards compatibility)
              if (!whatsappUserId && lab?.whatsapp_user_id) {
                whatsappUserId = lab.whatsapp_user_id;
                whatsappUserName = lab.name;
                console.log(
                  `âœ… [Priority 3] Using lab-level WhatsApp fallback: ${lab.name}`,
                );
              }

              if (!whatsappUserId) {
                console.warn(
                  "âš ï¸ No whatsapp_user_id configured - notifications will be queued only",
                );
              }

              // Use existing Netlify function for sending reports
              const NETLIFY_SEND_REPORT_URL =
                "https://app.limsapp.in/.netlify/functions/send-report-url";

              // Helper function to send WhatsApp via Netlify function
              const sendWhatsApp = async (
                phone: string,
                message: string,
                pdfUrl: string,
                patientName: string,
              ): Promise<boolean> => {
                if (!whatsappUserId) {
                  console.log(
                    "â­ï¸ Skipping immediate send - no whatsapp_user_id configured",
                  );
                  return false;
                }

                try {
                  // Use lab's country code (already fetched)
                  const countryCode = lab?.country_code || "+91"; // Default to India
                  console.log("ðŸŒ Using country code:", countryCode);

                  let cleanPhone = phone.replace(/\D/g, "");

                  // Remove leading 0 (common for local numbers)
                  if (cleanPhone.startsWith("0")) {
                    cleanPhone = cleanPhone.substring(1);
                  }

                  // Format phone number with lab's country code
                  let formattedPhone: string;
                  const countryCodeDigits = countryCode.replace(/\D/g, "");

                  if (cleanPhone.length === 10) {
                    // 10 digit number - add country code
                    formattedPhone = countryCode + cleanPhone;
                  } else if (
                    cleanPhone.startsWith(countryCodeDigits) &&
                    cleanPhone.length === (10 + countryCodeDigits.length)
                  ) {
                    // Already has country code digits - just add +
                    formattedPhone = "+" + cleanPhone;
                  } else if (cleanPhone.length > 10) {
                    // Assume it has country code, just add +
                    formattedPhone = "+" + cleanPhone;
                  } else {
                    // Fallback - add country code
                    formattedPhone = countryCode + cleanPhone;
                  }

                  console.log(
                    `ðŸ“¤ Sending WhatsApp to ${formattedPhone} via Netlify function`,
                  );

                  // Extract filename from URL
                  const urlParts = pdfUrl.split("/");
                  const fileName = urlParts[urlParts.length - 1];

                  const requestBody = {
                    userId: whatsappUserId,
                    fileUrl: pdfUrl,
                    fileName: fileName,
                    caption: message,
                    phoneNumber: formattedPhone,
                    templateData: {
                      PatientName: patientName,
                    },
                  };

                  console.log(
                    "ðŸ“‹ Request payload:",
                    JSON.stringify(requestBody, null, 2),
                  );

                  const response = await fetch(NETLIFY_SEND_REPORT_URL, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(requestBody),
                  });

                  const responseText = await response.text();

                  if (!response.ok) {
                    console.error(
                      `âŒ Netlify function error: ${response.status} ${response.statusText}`,
                    );
                    console.error(`   Response: ${responseText}`);
                    return false;
                  }

                  try {
                    const result = JSON.parse(responseText);
                    console.log(`âœ… WhatsApp sent successfully:`, result);
                  } catch {
                    console.log(
                      `âœ… WhatsApp sent successfully (raw response): ${responseText}`,
                    );
                  }
                  return true;
                } catch (error) {
                  console.error(`âŒ WhatsApp send exception:`, error);
                  return false;
                }
              };

              // Check per-order due block (shared by patient + doctor notification)
              let blockedByDue = false;
              if (lab?.block_send_on_due) {
                const { data: dueStatus } = await supabaseClient
                  .from("order_due_status")
                  .select("has_due")
                  .eq("order_id", orderId)
                  .maybeSingle();
                if (dueStatus?.has_due) {
                  console.log("â›” Auto-send blocked â€” order has outstanding balance:", orderId);
                  blockedByDue = true;
                }
              }

              // Send to patient - use WhatsApp template if available (same as Dashboard)
              if (
                notifSettings.auto_send_report_to_patient &&
                order.patients?.phone
              ) {
                // Try to fetch WhatsApp template from database
                let patientMessage =
                  `Hello ${order.patient_name}, your ${testNames} report is ready. Please find it attached.`;

                try {
                  // Correct table: whatsapp_message_templates, column: category
                  const { data: template } = await supabaseClient
                    .from("whatsapp_message_templates")
                    .select("message_content")
                    .eq("lab_id", job.lab_id)
                    .eq("category", "report_ready")
                    .eq("is_default", true)
                    .eq("is_active", true)
                    .maybeSingle();

                  if (template?.message_content) {
                    // Replace placeholders - format is [PlaceholderName] not {{PlaceholderName}}
                    patientMessage = template.message_content
                      .replace(
                        /\[PatientName\]/gi,
                        order.patient_name || "Patient",
                      )
                      .replace(/\[OrderId\]/gi, orderId.slice(-6))
                      .replace(/\[TestName\]/gi, testNames)
                      .replace(/\[ReportUrl\]/gi, storageUrl)
                      .replace(/\[LabName\]/gi, lab?.name || "")
                      .replace(/\[LabAddress\]/gi, "") // Not fetched in this context
                      .replace(/\[LabContact\]/gi, "") // Not fetched in this context
                      .replace(/\[LabEmail\]/gi, ""); // Not fetched in this context

                    console.log(
                      "âœ… Using WhatsApp template for patient message",
                    );
                  } else {
                    console.log(
                      "â„¹ï¸ No WhatsApp template found, using default message",
                    );
                  }
                } catch (templateError) {
                  console.error(
                    "âš ï¸ Error fetching WhatsApp template:",
                    templateError,
                  );
                }

                // Add "Thank you" if not already present
                if (
                  !patientMessage.includes("Thank you") &&
                  !patientMessage.includes("thank you")
                ) {
                  patientMessage += "\n\nThank you.";
                }

                const sent = !blockedByDue && canAttemptImmediate
                  ? await sendWhatsApp(
                    order.patients.phone,
                    patientMessage,
                    storageUrl,
                    order.patient_name,
                  )
                  : false;

                if (sent) {
                  await supabaseClient
                    .from("reports")
                    .update({
                      whatsapp_sent_at: new Date().toISOString(),
                      whatsapp_sent_to: order.patients.phone,
                      whatsapp_sent_via: "api",
                    })
                    .eq("id", reportIdForNotif);
                  console.log(
                    "âœ… WhatsApp sent to patient:",
                    order.patients.phone,
                  );
                } else {
                  // Queue for retry
                  const shouldQueue = statusMatches || shouldQueueOutsideWindow;
                  if (shouldQueue) {
                    await supabaseClient
                      .from("notification_queue")
                      .insert({
                        lab_id: job.lab_id,
                        recipient_type: "patient",
                        recipient_phone: order.patients.phone,
                        recipient_name: order.patient_name,
                        recipient_id: order.patients.id,
                        trigger_type: "report_ready",
                        order_id: orderId,
                        report_id: reportIdForNotif,
                        message_content: patientMessage,
                        attachment_url: storageUrl,
                        attachment_type: "report",
                        status: "pending",
                        scheduled_for: deferredScheduledFor,
                        last_error: !statusMatches
                          ? `Waiting for report status ${notifSettings.send_report_on_status || "Completed"}`
                          : (withinWindow ? "Initial send failed" : "Outside send window"),
                      });
                    console.log("ðŸ“¥ Patient notification queued for retry");
                  } else {
                    console.log(
                      "â­ï¸ Skipping patient notification: outside send window and queue disabled",
                    );
                  }
                }
              }

              // Send to doctor (with clinical summary if enabled)
              if (
                notifSettings.auto_send_report_to_doctor && order.doctors?.phone
              ) {
                // Build doctor message - include clinical summary if toggled
                let doctorMessage = `Hello Dr. ${
                  order.doctors.name || "Doctor"
                },\n\nThe report for patient ${order.patient_name} (${testNames}) is ready.`;

                // Add clinical summary if include_clinical_summary_in_report is true
                const includeClinicalSummary =
                  (order as any).include_clinical_summary_in_report || false;
                const clinicalSummary = (order as any).ai_clinical_summary ||
                  "";

                if (includeClinicalSummary && clinicalSummary) {
                  doctorMessage +=
                    `\n\nðŸ“‹ Clinical Summary:\n${clinicalSummary}`;
                  console.log(
                    "ðŸ“‹ Including AI clinical summary in doctor message",
                  );
                }

                doctorMessage +=
                  `\n\nPlease find the attached report.\n\nThank you,\n${
                    lab?.name || "Lab"
                  }`;

                const sent = !blockedByDue && canAttemptImmediate
                  ? await sendWhatsApp(
                    order.doctors.phone,
                    doctorMessage,
                    storageUrl,
                    order.patient_name,
                  )
                  : false;

                if (sent) {
                  await supabaseClient
                    .from("reports")
                    .update({
                      doctor_informed_at: new Date().toISOString(),
                      doctor_informed_via: "whatsapp",
                    })
                    .eq("id", reportIdForNotif);
                  console.log(
                    "âœ… WhatsApp sent to doctor:",
                    order.doctors.phone,
                  );
                } else {
                  // Queue for retry
                  const shouldQueue = statusMatches || shouldQueueOutsideWindow;
                  if (shouldQueue) {
                    await supabaseClient
                      .from("notification_queue")
                      .insert({
                        lab_id: job.lab_id,
                        recipient_type: "doctor",
                        recipient_phone: order.doctors.phone,
                        recipient_name: order.doctors.name,
                        recipient_id: order.doctors.id,
                        trigger_type: "report_ready",
                        order_id: orderId,
                        report_id: reportIdForNotif,
                        message_content: doctorMessage,
                        attachment_url: storageUrl,
                        attachment_type: "report",
                        status: "pending",
                        scheduled_for: deferredScheduledFor,
                        last_error: !statusMatches
                          ? `Waiting for report status ${notifSettings.send_report_on_status || "Completed"}`
                          : (withinWindow ? "Initial send failed" : "Outside send window"),
                      });
                    console.log("ðŸ“¥ Doctor notification queued for retry");
                  } else {
                    console.log(
                      "â­ï¸ Skipping doctor notification: outside send window and queue disabled",
                    );
                  }
                }
              }
            }
          } else {
            console.log("ðŸ“² Auto-send not enabled for this lab");
          }
        } catch (waError) {
          console.error("âš ï¸ WhatsApp notification error (non-fatal):", waError);
          // Don't fail the PDF generation if notifications fail
        }
      }
      // ====== END WHATSAPP NOTIFICATIONS ======

      console.log(
        "â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•",
      );
      console.log("âœ… PDF GENERATION COMPLETE");
      console.log("eCopy URL:", storageUrl);
      console.log("Print URL:", printStorageUrl || "Not generated");
      console.log("Job ID:", job.id);
      console.log(
        "â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•",
      );

      return new Response(
        JSON.stringify({
          success: true,
          status: "completed",
          pdfUrl: printLayoutMode !== "compact" ? storageUrl : null,
          printPdfUrl: printStorageUrl,
          compactEcopyUrl: printLayoutMode === "compact" ? storageUrl : null,
          storagePath: eCopyResult.path,
          jobId: job.id,
          orderId,
          reportType: "final",
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    } catch (error) {
      console.error(
        "â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•",
      );
      console.error("âŒ PDF GENERATION ERROR:", error);
      console.error(
        "â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•",
      );

      return new Response(
        JSON.stringify({
          error: "PDF generation failed",
          details: String(error),
          message: error instanceof Error ? error.message : "Unknown error",
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }
  } catch (topError) {
    // Top-level error handler - ensures CORS headers are ALWAYS returned
    console.error("âŒ TOP-LEVEL ERROR (before main logic):", topError);
    return new Response(
      JSON.stringify({
        error: "Request processing failed",
        details: String(topError),
        message: topError instanceof Error ? topError.message : "Unknown error",
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});

// ============================================================
// SECTION: Helper Functions
// ============================================================

async function updateProgress(
  supabase: any,
  jobId: string,
  stage: string,
  percent: number,
) {
  await supabase
    .from("pdf_generation_queue")
    .update({ progress_stage: stage, progress_percent: percent })
    .eq("id", jobId);
}

async function failJob(supabase: any, jobId: string, errorMessage: string) {
  await supabase
    .from("pdf_generation_queue")
    .update({
      status: "failed",
      error_message: errorMessage,
      completed_at: new Date().toISOString(),
    })
    .eq("id", jobId);
}

/**
 * Helper function to group analytes by test_group_id
 * If analytes don't have test_group_id but contextTestGroupIds is provided,
 * distribute analytes across groups based on position or test name matching
 */
function groupAnalytesByTestGroup(
  analytes: any[],
  contextTestGroupIds: string[] = [],
): Map<string, any[]> {
  const grouped = new Map<string, any[]>();

  // First pass: group by test_group_id if present on analyte
  const ungroupedAnalytes: any[] = [];

  for (const analyte of analytes) {
    const testGroupId = analyte.test_group_id;
    if (testGroupId) {
      if (!grouped.has(testGroupId)) {
        grouped.set(testGroupId, []);
      }
      grouped.get(testGroupId)!.push(analyte);
    } else {
      ungroupedAnalytes.push(analyte);
    }
  }

  // If we have ungrouped analytes and context provides testGroupIds,
  // try to match them or distribute evenly
  if (ungroupedAnalytes.length > 0 && contextTestGroupIds.length > 0) {
    console.log(
      `âš ï¸ ${ungroupedAnalytes.length} analytes without test_group_id, attempting to match with ${contextTestGroupIds.length} context groups`,
    );

    // Ensure all context test group IDs have entries
    for (const tgId of contextTestGroupIds) {
      if (!grouped.has(tgId)) {
        grouped.set(tgId, []);
      }
    }

    // Try to match ungrouped analytes to context groups
    // This is a fallback - ideally RPC should return test_group_id on each analyte
    for (const analyte of ungroupedAnalytes) {
      // If only one context group, assign to it
      if (contextTestGroupIds.length === 1) {
        grouped.get(contextTestGroupIds[0])!.push(analyte);
      } else {
        // Otherwise put in 'ungrouped' - the rendering will use contextTestGroupIds
        if (!grouped.has("ungrouped")) {
          grouped.set("ungrouped", []);
        }
        grouped.get("ungrouped")!.push(analyte);
      }
    }
  } else if (ungroupedAnalytes.length > 0) {
    // No context groups, put all ungrouped in one bucket
    grouped.set("ungrouped", ungroupedAnalytes);
  }

  return grouped;
}
