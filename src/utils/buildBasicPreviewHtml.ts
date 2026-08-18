/**
 * buildBasicPreviewHtml.ts
 *
 * Frontend port of generateBasicDefaultTemplateHtml() from the
 * generate-pdf-letterhead edge function.
 *
 * Produces a complete standalone HTML document for the quick-preview
 * srcdoc iframe on the result-verification page.
 * Pure function - no DB calls, no external deps.
 */

import { formatAnalyteDisplayValue } from './resultValueFormat';
import {
  flagLegendText,
  flagSymbolForReport,
  resolveConfiguredFlagCodes,
  type LabFlagOption,
} from './reportFlagDisplay';

export interface PreviewAnalyte {
  parameter: string;
  value: string | null;
  unit: string;
  reference_range: string;
  flag: string | null;
  section_heading?: string | null;
  is_auto_calculated?: boolean;
  is_calculated?: boolean;
  value_type?: string | null;
  /** Resolved report precision: null/undefined = as entered, 0 = integer. */
  decimal_places?: number | null;
  /** Resolved leading-zero width: null/undefined/0 = off, 2 = "03". */
  min_integer_digits?: number | null;
  analyte_id?: string | null;
  analyteId?: string | null;
  id?: string | null;
  lab_analyte_id?: string | null;
  labAnalyteId?: string | null;
  report_display_options?: {
    sameRowSiblingAnalyteId?: string | null;
    hiddenWhenRenderedAsSibling?: boolean;
  } | null;
}

/**
 * A basic-template group whose values are all shorter than this keeps them right-aligned
 * in the VALUE column. Only groups with sentence-length findings get the wide,
 * left-aligned value cell. Kept in sync with generate-pdf-letterhead.
 */
const LONG_QUALITATIVE_VALUE_CHARS = 24;

export interface PreviewTestGroup {
  testGroupId?: string | null;
  testGroupName: string;
  analytes: PreviewAnalyte[];
  groupInterpretation?: string | null;
  /** Per-group print_options overrides (test_groups.print_options); wins over the top-level printOptions. */
  printOptions?: Record<string, unknown> | null;
  /** test_groups.sample_type — printed as "Specimen: …" when showSampleType is on. */
  sampleType?: string | null;
  /** order_test_groups.sample_condition — printed as "Sample Condition: …" when showSampleCondition is on. */
  sampleCondition?: string | null;
}

export interface PreviewSection {
  sectionName: string;
  content: string;
}

export interface BuildBasicPreviewParams {
  orderId?: string;
  patientName: string;
  patientCode: string;
  ageGender: string;
  orderDate: string;
  reportDate?: string;
  referredBy?: string;
  sampleId?: string;
  /** Per-lab configurable patient-field list (mirrors report_patient_info_config used by the PDF). */
  patientInfoConfig?: { layout?: string; fields: string[] } | null;
  /** Custom patient field labels (mirrors lab_patient_field_configs used by the PDF). */
  extraFieldConfigs?: Array<{ field_key: string; label: string }>;
  /** Resolved values for configurable patient fields, keyed by field key. */
  patientFieldValues?: Record<string, string>;
  testGroups: PreviewTestGroup[];
  sections?: PreviewSection[];
  signatoryName?: string;
  signatoryDesignation?: string;
  signatoryImageUrl?: string;
  verificationUrl?: string;
  printOptions?: Record<string, unknown>;
  /**
   * The lab's Result Flag Options exactly as configured (labs.flag_options) —
   * not merged with defaults. Only these letters get printed beside a value; a
   * verdict the lab has not configured still styles the value, it just prints
   * no letter. Omit to print the engine's full vocabulary.
   */
  labFlagOptions?: LabFlagOption[] | null;
  pdfLayoutSettings?: Record<string, unknown>;
  printLayoutMode?: "standard" | "compact";
  compactPlan?: {
    orderedGroupIds?: string[];
    pageAssignments?: Record<string, number>;
    maxClubbedAnalytes?: number;
  };
}

function formatIndianNumber(val: string | number): string {
  const str = String(val).replace(/,/g, "").trim();
  const num = parseFloat(str);
  if (!Number.isFinite(num) || Math.abs(num) < 1000) return str || String(val);
  return new Intl.NumberFormat("en-IN").format(num);
}

function normalizeFlag(flag?: string | null): string {
  const raw = String(flag || "")
    .trim()
    .toLowerCase()
    .replace(/[-\s]/g, "_");
  if (!raw) return "";
  if (["h", "high", "hh", "hi"].includes(raw)) return "high";
  if (["l", "low", "ll"].includes(raw)) return "low";
  if (
    ["critical_h", "critical_high", "criticalh", "high_critical", "h*", "ch"].includes(raw)
  )
    return "critical_high";
  if (
    ["critical_l", "critical_low", "criticall", "low_critical", "l*", "cl"].includes(raw)
  )
    return "critical_low";
  if (["c", "critical", "crit"].includes(raw)) return "critical";
  if (["a", "abnormal", "abn", "pos", "positive"].includes(raw)) return "abnormal";
  return "";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Keep in sync with DEFAULT_BASIC_REPORT_DISCLAIMER in
// supabase/functions/generate-pdf-letterhead/index.ts
export const DEFAULT_BASIC_REPORT_DISCLAIMER =
  "This report is electronically generated and authenticated. Results relate only to the specimen received and should be correlated clinically. This report is not valid for medico-legal purposes.";

function toPx(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function resolvePreviewMargins(pdfLayoutSettings?: Record<string, unknown>): {
  top: number;
  right: number;
  bottom: number;
  left: number;
} {
  const margins = pdfLayoutSettings?.margins;
  const headerHeight = toPx(pdfLayoutSettings?.headerHeight, 90);
  const footerHeight = toPx(pdfLayoutSettings?.footerHeight, 80);
  const fallback = {
    top: headerHeight,
    right: 20,
    bottom: footerHeight,
    left: 20,
  };

  if (margins && typeof margins === "object" && !Array.isArray(margins)) {
    const m = margins as Record<string, unknown>;
    return {
      top: toPx(m.top, fallback.top),
      right: toPx(m.right, fallback.right),
      bottom: toPx(m.bottom, fallback.bottom),
      left: toPx(m.left, fallback.left),
    };
  }

  if (typeof margins === "string" && margins.trim()) {
    const parts = margins.trim().split(/\s+/);
    const top = toPx(parts[0], fallback.top);
    const right = toPx(parts[1], fallback.right);
    const bottom = toPx(parts[2], top);
    const left = toPx(parts[3], right);
    return { top, right, bottom, left };
  }

  return fallback;
}

function autoAssignCompactPages(
  groups: PreviewTestGroup[],
  maxClubbedAnalytes = 5,
): Record<string, number> {
  let currentPage = 1;
  let currentPageCount = 0;
  const assignments: Record<string, number> = {};

  for (const group of groups) {
    const key = group.testGroupId || group.testGroupName;
    const analyteCount = Math.max(group.analytes.filter((row) => !!row.parameter).length, 1);

    if (analyteCount > maxClubbedAnalytes) {
      if (currentPageCount > 0) currentPage += 1;
      assignments[key] = currentPage;
      currentPage += 1;
      currentPageCount = 0;
      continue;
    }

    if (currentPageCount > 0 && currentPageCount + analyteCount > maxClubbedAnalytes) {
      currentPage += 1;
      currentPageCount = 0;
    }

    assignments[key] = currentPage;
    currentPageCount += analyteCount;
  }

  return assignments;
}

function stripLooseMarkdown(value: string): string {
  return value
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/^(\*\*+)\s*/gm, "")
    .replace(/\s*(\*\*+)$/gm, "")
    .trim();
}

function formatNarrativeHtml(rawContent: string): string {
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
    if (/^[-*\u2022]\s+/.test(line)) {
      listItems.push(`<li>${escapeHtml(line.replace(/^[-*\u2022]\s+/, "").trim())}</li>`);
      continue;
    }

    flushList();

    const colonIdx = line.indexOf(":");
    if (colonIdx > 0 && colonIdx < 60) {
      parts.push(`
        <div class="narrative-kv-row">
          <div class="narrative-kv-label">${escapeHtml(line.slice(0, colonIdx).trim())}</div>
          <div class="narrative-kv-value">${escapeHtml(line.slice(colonIdx + 1).trim())}</div>
        </div>`);
      continue;
    }

    parts.push(`<p>${escapeHtml(line)}</p>`);
  }

  flushList();
  return parts.join("");
}

/** Group-level forceTableLayout wins over the lab-level value; null means auto-detect. */
function resolveBooleanOption(
  key: string,
  groupOptions: Record<string, unknown> | null | undefined,
  labOptions: Record<string, unknown> | null | undefined,
): boolean {
  for (const opts of [groupOptions, labOptions]) {
    if (opts && typeof opts[key] === "boolean") return opts[key] as boolean;
  }
  return false;
}

/** Default prefix for the sample condition line — see formatSampleCondition() in
 * generate-pdf-letterhead. A blank sampleConditionLabel prints the bare value. */
const DEFAULT_SAMPLE_CONDITION_LABEL = "Sample Condition";

function resolveSampleConditionLabel(
  groupOptions: Record<string, unknown> | null | undefined,
  labOptions: Record<string, unknown> | null | undefined,
): string {
  for (const opts of [groupOptions, labOptions]) {
    const raw = opts?.sampleConditionLabel;
    if (raw !== undefined && raw !== null) return String(raw).trim();
  }
  return DEFAULT_SAMPLE_CONDITION_LABEL;
}

/**
 * "Specimen: …" / "Sample Condition: …" subtitle lines under a group title.
 * Mirrors generateBasicDefaultTemplateHtml() in generate-pdf-letterhead, which
 * gates them on the showSampleType / showSampleCondition print options.
 */
function buildGroupSubtitleHtml(
  group: PreviewTestGroup,
  labOptions: Record<string, unknown> | null | undefined,
): string {
  const sampleType = String(group.sampleType || "").trim();
  const sampleCondition = String(group.sampleCondition || "").trim();
  const specimen = sampleType && resolveBooleanOption("showSampleType", group.printOptions, labOptions)
    ? `<div class="center-subtitle">Specimen: ${escapeHtml(sampleType)}</div>`
    : "";
  const conditionLabel = resolveSampleConditionLabel(group.printOptions, labOptions);
  const condition = sampleCondition && resolveBooleanOption("showSampleCondition", group.printOptions, labOptions)
    ? `<div class="center-subtitle">${conditionLabel ? `${escapeHtml(conditionLabel)}: ` : ""}${escapeHtml(sampleCondition)}</div>`
    : "";
  return `${specimen}${condition}`;
}

function resolveForceTableLayout(
  groupOptions: Record<string, unknown> | null | undefined,
  labOptions: Record<string, unknown> | null | undefined,
): boolean | null {
  for (const opts of [groupOptions, labOptions]) {
    if (opts && typeof opts.forceTableLayout === "boolean") return opts.forceTableLayout;
  }
  return null;
}

/**
 * Decide whether a group renders as the narrative key/value panel instead of the
 * standard results table.
 *
 * `forceTableLayout` (test_groups.print_options, merged over lab printOptions) is an
 * explicit escape hatch and wins over the heuristic:
 *   true  → always the results table
 *   false → always the narrative panel
 *   null  → auto-detect (mirrors _isNarrativeGroup in generate-pdf-letterhead)
 */
function isNarrativeGroup(
  analytes: PreviewAnalyte[],
  forceTableLayout: boolean | null = null,
): boolean {
  if (forceTableLayout !== null) return !forceTableLayout;
  if (!analytes.length) return false;
  const narrativeRows = analytes.filter((analyte) => {
    const unit = String(analyte.unit || "").trim().toLowerCase();
    const ref = String(analyte.reference_range || "").trim();
    // Count any row that has no unit and no numeric reference range as narrative.
    // This includes section header rows and plain-text paragraph rows (empty value)
    // which the old check incorrectly excluded.
    return (
      (!unit || ["n/a", "na", "-", "none", "not applicable"].includes(unit)) &&
      !/\d/.test(ref)
    );
  }).length;

  return narrativeRows > 0 && narrativeRows / analytes.length >= 0.7;
}

function getPreviewAnalyteIdentityIds(analyte: PreviewAnalyte): string[] {
  const ids = [
    analyte.analyte_id,
    analyte.analyteId,
    analyte.id,
    analyte.lab_analyte_id,
    analyte.labAnalyteId,
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
 * Client-side paginator injected into the preview document.
 *
 * The preview emits one `.preview-page` box per group (plus one for report
 * sections). A box is `min-height: 297mm`, so content longer than a page simply
 * made the box taller: the patient header stayed at the very top and the footer
 * trailed after all the content instead of sitting at a page bottom. The PDF does
 * not have this problem because PDF.co paginates natively.
 *
 * After load (images included, so heights are final) this walks each overflowing
 * page and reflows its content into real page boxes, cloning the patient header
 * onto each one. Block-level text (p, li, headings, table rows) is never split
 * mid-element — an element that does not fit moves to the next page whole.
 */
const PAGINATOR_SCRIPT = `<script>
(function () {
  // Never broken across a page boundary — moved whole to the next page instead.
  var ATOMIC = "tr,td,th,img,svg,p,li,h1,h2,h3,h4,h5,h6,.center-title,.narrative-kv-row,.report-footer,.report-disclaimer";
  var MAX_PAGES = 80; // runaway guard
  // Printing maps A4 to 1122.5px while the on-screen probe reports 1123px, so a box
  // packed flush to the screen height spills a fraction onto the next sheet and the
  // trailing "break-after: page" then emits a blank one. Pack a little short of the
  // page so the printed box always clears the boundary.
  var SAFETY = 12;

  function pageHeightPx() {
    var probe = document.createElement("div");
    probe.style.cssText = "position:absolute;visibility:hidden;top:0;left:0;height:297mm;";
    document.body.appendChild(probe);
    var h = probe.offsetHeight;
    probe.parentNode.removeChild(probe);
    return h;
  }

  function isAtomic(node) {
    return node.nodeType !== 1 || !node.matches || node.matches(ATOMIC);
  }

  function isTitle(node) {
    if (!node || node.nodeType !== 1) return false;
    if (node.classList && node.classList.contains("center-title")) return true;
    return /^H[1-6]$/.test(node.tagName);
  }

  function paginate(srcPage, H) {
    var LIMIT = H - SAFETY;
    var touched = [srcPage];

    // The page box is min-height:297mm, so offsetHeight is pinned at a full page and
    // cannot reveal how much room is left. Suppress it while measuring so heights
    // report actual content, and restore it once the reflow is done.
    function unpin(page) { page.style.minHeight = "0"; }
    function repin(page) { page.style.minHeight = ""; }

    unpin(srcPage);
    if (srcPage.offsetHeight <= LIMIT) { repin(srcPage); return; } // already fits

    var kids = Array.prototype.slice.call(srcPage.children);
    var header = kids.filter(function (n) {
      return n.classList && n.classList.contains("preview-page-header");
    })[0] || null;
    var headerHtml = header ? header.outerHTML : "";
    var tail = kids.filter(function (n) {
      return n.classList &&
        (n.classList.contains("report-footer") || n.classList.contains("report-disclaimer"));
    });
    var content = kids.filter(function (n) {
      return n !== header && tail.indexOf(n) === -1;
    });

    // Detach everything but the header; the footer is re-attached to the last page.
    tail.concat(content).forEach(function (n) { srcPage.removeChild(n); });

    var cur = srcPage;
    var made = 0;

    function overflows() { return cur.offsetHeight > LIMIT; }

    // Start a fresh page and rebuild the wrapper chain (e.g. .test-results,
    // .narrative-body) so a split container continues with the same styling.
    function newPage(host) {
      var np = document.createElement("div");
      np.className = srcPage.className;
      unpin(np);
      touched.push(np);
      if (headerHtml) np.insertAdjacentHTML("beforeend", headerHtml);
      cur.parentNode.insertBefore(np, cur.nextSibling);
      cur = np;
      made++;

      var chain = [];
      var n = host;
      while (n && n.classList && !n.classList.contains("preview-page")) {
        chain.unshift(n);
        n = n.parentNode;
      }
      var parent = np;
      chain.forEach(function (w) {
        var clone = w.cloneNode(false);
        parent.appendChild(clone);
        parent = clone;
      });
      return parent;
    }

    // Places nodes into host, breaking to new pages as needed. Returns the host
    // at this nesting level on whichever page we ended up on.
    function flow(nodes, host) {
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        host.appendChild(n);
        if (!overflows() || made >= MAX_PAGES) continue;

        if (!isAtomic(n) && n.children.length > 0) {
          // Split the container: keep it as the opening fragment, reflow its children.
          var inner = Array.prototype.slice.call(n.childNodes);
          while (n.firstChild) n.removeChild(n.firstChild);
          var endHost = flow(inner, n);
          host = endHost.parentNode || host;
          continue;
        }

        // Unsplittable — move it to a new page, dragging any heading that would
        // otherwise be stranded alone at the bottom of the page we are leaving.
        host.removeChild(n);
        var orphan = isTitle(host.lastElementChild) ? host.lastElementChild : null;
        if (orphan) host.removeChild(orphan);
        host = newPage(host);
        if (orphan) host.appendChild(orphan);
        host.appendChild(n);
      }
      return host;
    }

    flow(content, srcPage);

    // The disclaimer + signature footer go on the last page, but only if they still
    // fit there — appending them blind was pushing the footer onto an extra sheet.
    tail.forEach(function (n) { cur.appendChild(n); });
    if (tail.length && overflows() && made < MAX_PAGES) {
      tail.forEach(function (n) { n.parentNode.removeChild(n); });
      var footHost = newPage(cur);
      tail.forEach(function (n) { footHost.appendChild(n); });
    }

    touched.forEach(function (page) {
      repin(page);
      // Marks a box whose content is known to fit inside SAFETY of a page, which
      // lets the print stylesheet pin it to an exact sheet (see .preview-paged).
      page.classList.add("preview-paged");
    });
  }

  function paginateAll() {
    var H = pageHeightPx();
    if (!H) return;
    Array.prototype.slice.call(document.querySelectorAll(".preview-page"))
      .forEach(function (page) {
        try { paginate(page, H); } catch (e) { /* leave the page unpaginated */ }
      });
    // Safety net: never leave a page with measurement min-height still suppressed.
    Array.prototype.slice.call(document.querySelectorAll(".preview-page"))
      .forEach(function (page) {
        if (page.style.minHeight === "0" || page.style.minHeight === "0px") {
          page.style.minHeight = "";
        }
      });
  }

  if (document.readyState === "complete") paginateAll();
  else window.addEventListener("load", paginateAll);
})();
<\/script>`;

export function buildBasicPreviewHtml(params: BuildBasicPreviewParams): string {
  const {
    orderId = "",
    patientName,
    patientCode,
    ageGender,
    orderDate,
    reportDate = new Date().toLocaleString("en-IN", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }),
    referredBy = "",
    sampleId = "",
    patientInfoConfig = null,
    extraFieldConfigs = [],
    patientFieldValues = {},
    testGroups,
    sections = [],
    signatoryName = "",
    signatoryDesignation = "",
    signatoryImageUrl = "",
    verificationUrl = "",
    printOptions = {},
    labFlagOptions = null,
    pdfLayoutSettings = {},
    printLayoutMode = "standard",
    compactPlan = {},
  } = params;

  const basePx =
    typeof printOptions.baseFontSize === "number"
      ? Math.max(8, Math.min(24, printOptions.baseFontSize as number))
      : 14;
  const smallPx = Math.max(7, basePx - 3);
  const testNameWeight = (printOptions.testNameBold ?? false) ? "600" : "normal";
  const boldAllValues = (printOptions.boldAllValues as boolean) ?? false;
  const boldAbnormal = (printOptions.boldAbnormalValues as boolean) ?? true;
  // Bolds the patient information block values (labels stay bold either way).
  const patientInfoBold = (printOptions.patientInfoBold as boolean) ?? false;
  // Draws a vertical rule between the two patient-info column pairs.
  const patientInfoColumnDivider = (printOptions.patientInfoColumnDivider as boolean) ?? false;
  // Patient info header geometry — share of the row given to the LEFT label+value
  // pair, and the share of each pair taken by its label. Defaults (50 / 30)
  // reproduce the historical fixed 15% / 35% layout.
  const patientInfoLeftPct = Math.max(25, Math.min(75, Number(printOptions.patientInfoLeftPct ?? 50)));
  const patientInfoLabelPct = Math.max(15, Math.min(60, Number(printOptions.patientInfoLabelPct ?? 30)));
  const patientInfoRightPct = 100 - patientInfoLeftPct;
  const patientInfoWidths = {
    label1: Number((patientInfoLeftPct * patientInfoLabelPct / 100).toFixed(2)),
    value1: Number((patientInfoLeftPct * (100 - patientInfoLabelPct) / 100).toFixed(2)),
    label2: Number((patientInfoRightPct * patientInfoLabelPct / 100).toFixed(2)),
    value2: Number((patientInfoRightPct * (100 - patientInfoLabelPct) / 100).toFixed(2)),
  };
  // "TEST REPORT" heading in the header bar (the barcode itself is PDF-only).
  const showReportTitle = printOptions.showReportTitle !== false;
  const reportTitleBarPadding = Math.max(0, Math.min(10, Number(printOptions.reportTitleBarPadding ?? 4)));
  const underlineAbnormal = (printOptions.underlineAbnormalValues as boolean) ?? false;
  const abnormalDecoration = underlineAbnormal
    ? "text-decoration: underline !important; text-underline-offset: 2px !important;"
    : "";
  const sectionHeaderInline = (printOptions.sectionHeaderInline as boolean) ?? true;
  const flagSymbol = (printOptions.flagSymbol as string) ?? "none";
  const showFlagLegend = (printOptions.showFlagLegend as boolean) ?? false;
  // Letters this lab prints. A verdict outside the list (typically 'A' on a lab
  // that only configured High/Low) still styles the value — it just has no letter.
  const allowedFlagCodes = resolveConfiguredFlagCodes(labFlagOptions);
  // Exact gap in px between the H/L symbol and the value (0-12, default 4)
  const flagGapPx = Math.max(0, Math.min(12, Number(printOptions.flagGapPx ?? 4)));
  // Vertical padding on every result cell — the gap between two analyte rows is twice
  // this value (0-10, default 2 = the historical basic-template spacing).
  const analyteRowSpacing = Math.max(0, Math.min(10, Number(printOptions.analyteRowSpacing ?? 2)));
  // Bottom margin of each test-group block — the gap before the next group (0-40, default 14).
  const testGroupSpacing = Math.max(0, Math.min(40, Number(printOptions.testGroupSpacing ?? 14)));
  const calcMarker = (printOptions.calcMarker as string) ?? "cal";
  const flagAsterisk = (printOptions.flagAsterisk as boolean) ?? false;
  const flagAsteriskCritical = (printOptions.flagAsteriskCritical as boolean) ?? false;
  const testGroupTitlePosition = (printOptions.testGroupTitlePosition as string) ?? "above_headers_center";
  const requestedQrPosition = String(printOptions.qrPosition || "");
  const qrPosition = requestedQrPosition === "top_left" || requestedQrPosition === "top_right"
    ? requestedQrPosition
    : "bottom_left";
  const qrHorizontalOffset = Math.max(0, Math.min(80, Number(printOptions.qrHorizontalOffset ?? 0)));
  const signatureMaxHeight = Math.max(30, Math.min(120, Number(printOptions.signatureMaxHeight ?? 70)));
  const signatureMaxWidth = Math.max(80, Math.min(260, Number(printOptions.signatureMaxWidth ?? 180)));
  const resultTableBackground = printOptions.resultTableBackground === "transparent" ? "transparent" : "#fff";
  const sectionRowBackground = printOptions.resultTableBackground === "transparent" ? "transparent" : "#f5f5f5";
  // Section field name width percentage for narrative/section-only reports (default 40%)
  const sectionFieldNamePct = Math.max(20, Math.min(70, Number(printOptions.sectionFieldNamePct ?? 40)));
  const colCount = 4;
  const basicColumnWidths = (printOptions.basicColumnWidths || {}) as Record<string, unknown>;
  const standardColumnWidths = normalizeBasicColumnWidths(basicColumnWidths.standard, [36, 24, 12, 28], 4);
  const siblingColumnWidths = normalizeBasicColumnWidths(basicColumnWidths.sibling, [30, 14, 8, 16, 16, 16], 6);
  const showReportDisclaimer = printOptions.showReportDisclaimer !== false;
  const reportDisclaimerText = (typeof printOptions.reportDisclaimer === "string"
    ? printOptions.reportDisclaimer as string
    : DEFAULT_BASIC_REPORT_DISCLAIMER).trim();
  const resultColors = printOptions.resultColors as Record<string, unknown> | undefined;
  const colorsEnabled = resultColors?.enabled !== false;
  const highColor = colorsEnabled ? (String(resultColors?.high || "") || "#dc2626") : "#000000";
  const lowColor = colorsEnabled ? (String(resultColors?.low || "") || "#000000") : "#000000";
  const isCompact = printLayoutMode === "compact";
  const previewMargins = resolvePreviewMargins(pdfLayoutSettings);
  const compactMaxClubbedAnalytes = Math.max(1, Number(compactPlan.maxClubbedAnalytes || 5));
  const orderedGroupIds = compactPlan.orderedGroupIds || [];
  const orderedGroupIndex = new Map(orderedGroupIds.map((id, index) => [id, index]));
	  const visibleTestGroups = testGroups
	    .map((group) => ({
	      ...group,
	      analytes: (group.analytes || []).filter((row: any) => !row.is_hidden_from_report),
	    }))
	    .filter((group) => group.analytes.length > 0);
	  const orderedTestGroups = [...visibleTestGroups].sort((a, b) => {
    const aKey = a.testGroupId || "";
    const bKey = b.testGroupId || "";
    const aOrder = orderedGroupIndex.has(aKey) ? orderedGroupIndex.get(aKey)! : Number.MAX_SAFE_INTEGER;
    const bOrder = orderedGroupIndex.has(bKey) ? orderedGroupIndex.get(bKey)! : Number.MAX_SAFE_INTEGER;
    return aOrder - bOrder;
  });
  const compactAssignments = isCompact
    ? Object.keys(compactPlan.pageAssignments || {}).length
      ? compactPlan.pageAssignments!
      : autoAssignCompactPages(orderedTestGroups, compactMaxClubbedAnalytes)
    : {};

  const css = `<style>
	* { box-sizing: border-box; }
	body {
	  margin: 0;
	  min-width: calc(210mm + 24px);
	  font-family: Arial, Helvetica, sans-serif;
	  font-size: ${basePx}px;
	  color: #000;
	  background: #eef2f7;
	  overflow: auto;
	}
	.preview-shell { width: 210mm; margin: 12px auto; }
		.preview-page {
			  width: 210mm; min-height: 297mm; background: #fff; padding: ${previewMargins.top}px ${previewMargins.right}px ${previewMargins.bottom}px ${previewMargins.left}px;
		  margin: 0 auto 12px; box-shadow: 0 10px 28px rgba(15, 23, 42, 0.14);
		  display: flex; flex-direction: column;
		  break-after: page; page-break-after: always;
		}
	.preview-page:last-child { margin-bottom: 0; break-after: auto; page-break-after: auto; }
	/* Repeated on every paginated page — must never be squeezed by the flex page box. */
	.preview-page-header { flex-shrink: 0; }
	.preview-mode-badge {
	  float: right; font-size: ${smallPx}px; color: #475569; border: 1px solid #cbd5e1;
	  padding: 2px 6px; border-radius: 999px; text-transform: uppercase; letter-spacing: 0.04em;
	}
	table { border: none !important; border-collapse: collapse !important; }
td, th { color: #000 !important; font-weight: normal; background-color: ${resultTableBackground} !important; vertical-align: top !important; }
td { padding: 2px 4px !important; }
th { padding: 3px 4px !important; }
	.report-title-bar {
	  display: flex; align-items: center;
	  border-top: 1.5px solid #000; border-bottom: 1.5px solid #000;
	  padding: ${reportTitleBarPadding}px 0; margin: 6px 0 10px;
	}
	.report-main-title {
	  text-align: center; font-size: ${basePx + 3}px;
	  border: none; padding: 0; margin: 0; font-weight: 700; color: #000;
	}
		.report-id-line { display: none; }
		.report-id-line strong { color: #111827; }
.patient-header-table { width: 100%; table-layout: fixed; margin-bottom: 0; border: none !important; }
.patient-header-table th {
  font-weight: 700; text-align: left; color: #000;
  padding: 2px 3px !important; white-space: nowrap; border: none !important;
  font-size: ${basePx}px;
}
/* Configurable header geometry — cells 1/2 are the left label+value pair,
   cells 3/4 the right pair (see patientInfoLeftPct / patientInfoLabelPct). */
.patient-header-table th:nth-child(1) { width: ${patientInfoWidths.label1}%; }
.patient-header-table td:nth-child(2) { width: ${patientInfoWidths.value1}%; }
.patient-header-table th:nth-child(3) { width: ${patientInfoWidths.label2}%; }
.patient-header-table td:nth-child(4) { width: ${patientInfoWidths.value2}%; }
.patient-header-table td {
  padding: 2px 3px !important; border: none !important;
  color: #111 !important; word-break: break-word; font-size: ${basePx}px;
  font-weight: ${patientInfoBold ? "700" : "normal"};
}
/* Doctor degree/qualification printed on its own line under the doctor name.
   The inline-block wrapper starts where the name starts (after the ": " prefix),
   so the degree line indents to match instead of hugging the cell edge. */
.patient-header-table .ref-doctor-block {
  display: inline-block;
  vertical-align: top;
  max-width: 100%;
}
.patient-header-table .ref-doctor-degree {
  font-size: ${Math.max(basePx - 1, 6)}px;
  font-weight: normal;
  color: #444;
  line-height: 1.25;
  margin-top: 1px;
  white-space: normal;
}
${patientInfoColumnDivider ? `
/* Vertical rule between the left and right patient info columns.
   Cell 2 of every row is the last cell of the left column pair. */
.patient-header-table tr > *:nth-child(2) {
  border-right: 1px solid #000 !important;
  padding-right: 8px !important;
}
.patient-header-table tr > *:nth-child(3) {
  padding-left: 8px !important;
}
` : ""}
.patient-test-separator {
  border-top: 1.5px solid #000;
  height: 0;
  margin: 2px 0 6px;
}
.tbl-results {
  width: 100%; table-layout: fixed; border-collapse: collapse;
  border: none !important; margin-top: 4px;
}
.tbl-results thead th {
  border-top: 1.5px solid #000 !important; border-bottom: 1.5px solid #000 !important;
  border-left: none !important; border-right: none !important;
  font-weight: 700; color: #000; padding: 4px 4px !important;
  font-size: ${Math.max(10, basePx - 0.5)}px; vertical-align: middle;
}
		.tbl-results thead th:nth-child(1) { width: ${formatBasicWidth(standardColumnWidths[0])}; text-align: left; }
		.tbl-results thead th:nth-child(2) { width: ${formatBasicWidth(standardColumnWidths[1])}; text-align: right; }
		.tbl-results thead th:nth-child(3) { width: ${formatBasicWidth(standardColumnWidths[2])}; text-align: left; }
		.tbl-results thead th:nth-child(4) { width: ${formatBasicWidth(standardColumnWidths[3])}; text-align: left; }
			.tbl-results tbody td:nth-child(1) { width: ${formatBasicWidth(standardColumnWidths[0])}; text-align: left; color: #111 !important; }
			.tbl-results tbody td:nth-child(2) { width: ${formatBasicWidth(standardColumnWidths[1])}; text-align: right; white-space: nowrap; overflow: hidden; }
			.tbl-results tbody td:nth-child(3) { width: ${formatBasicWidth(standardColumnWidths[2])}; text-align: left; color: #444 !important; white-space: normal; overflow-wrap: anywhere; word-break: break-word; }
			.tbl-results tbody td:nth-child(4) { width: ${formatBasicWidth(standardColumnWidths[3])}; text-align: left; color: #666 !important; white-space: normal; overflow-wrap: anywhere; word-break: break-word; }
			.tbl-results.has-sibling thead th:nth-child(1) { width: ${formatBasicWidth(siblingColumnWidths[0])}; text-align: left; }
			.tbl-results.has-sibling thead th:nth-child(2) { width: ${formatBasicWidth(siblingColumnWidths[1])}; text-align: right; }
			.tbl-results.has-sibling thead th:nth-child(3) { width: ${formatBasicWidth(siblingColumnWidths[2])}; text-align: left; }
			.tbl-results.has-sibling thead th:nth-child(4) { width: ${formatBasicWidth(siblingColumnWidths[3])}; text-align: left; }
			.tbl-results.has-sibling thead th:nth-child(5) { width: ${formatBasicWidth(siblingColumnWidths[4])}; text-align: right; }
			.tbl-results.has-sibling thead th:nth-child(6) { width: ${formatBasicWidth(siblingColumnWidths[5])}; text-align: left; }
			.tbl-results.has-sibling tbody td:nth-child(1) { width: ${formatBasicWidth(siblingColumnWidths[0])}; text-align: left; }
			.tbl-results.has-sibling tbody td:nth-child(2) { width: ${formatBasicWidth(siblingColumnWidths[1])}; text-align: right; }
			.tbl-results.has-sibling tbody td:nth-child(3) { width: ${formatBasicWidth(siblingColumnWidths[2])}; text-align: left; white-space: normal; overflow-wrap: anywhere; word-break: break-word; }
			.tbl-results.has-sibling tbody td:nth-child(4) { width: ${formatBasicWidth(siblingColumnWidths[3])}; text-align: left; white-space: normal; overflow-wrap: anywhere; word-break: break-word; }
			.tbl-results.has-sibling tbody td:nth-child(5) { width: ${formatBasicWidth(siblingColumnWidths[4])}; text-align: right; }
			.tbl-results.has-sibling tbody td:nth-child(6) { width: ${formatBasicWidth(siblingColumnWidths[5])}; text-align: left; white-space: normal; overflow-wrap: anywhere; word-break: break-word; }
		.same-row-sibling { display: inline; white-space: nowrap; color: #000; font-size: ${basePx}px; text-align: right; }
		.same-row-sibling-unit { color: #444; font-weight: normal; margin-left: 4px; white-space: normal; overflow-wrap: anywhere; word-break: break-word; }
		.same-row-sibling-ref { display: inline; color: #666; font-size: ${smallPx + 1}px; line-height: 1.15; text-align: left; }
		.sub-section-col-header td {
		  border-bottom: 1px solid #999 !important;
		  background-color: ${resultTableBackground} !important;
		  color: #333 !important;
		}
	.tbl-results td, .tbl-results th { border: none !important; padding: ${analyteRowSpacing}px 4px !important; line-height: 1.28; font-size: ${basePx}px !important; }
.tbl-results tbody tr:not(.main-group-row):not(.sub-section-header):not(.descriptive-row) td {
  border-bottom: 0.5px dotted #e5e5e5 !important;
}
.test-name { font-size: ${basePx}px; font-weight: ${testNameWeight}; color: #111; line-height: 1.22; }
.val { text-align: right; vertical-align: top; font-size: ${basePx}px; font-weight: ${boldAllValues ? "600" : "normal"}; white-space: nowrap; }
.val.high, .val.critical_high { color: ${highColor} !important; ${boldAbnormal ? "font-weight: 700 !important;" : ""} ${abnormalDecoration} }
.val.low, .val.critical_low   { color: ${lowColor} !important;  ${boldAbnormal ? "font-weight: 700 !important;" : ""} ${abnormalDecoration} }
.val.abnormal { color: ${highColor} !important; ${boldAbnormal ? "font-weight: 700 !important;" : ""} ${abnormalDecoration} }
.main-group-row td { padding: 8px 0 5px 0 !important; border: none !important; }
.center-title {
  text-align: center; font-weight: 700; text-decoration: underline;
  font-size: ${basePx + 1}px; margin: 8px 0 0;
  text-transform: uppercase; line-height: 1.2; color: #000;
}
.center-title.left {
  text-align: left;
  text-decoration: none;
  margin: 0 0 6px;
}
.center-subtitle {
  text-align: center; font-size: ${smallPx + 1}px; margin: 2px 0 6px;
  color: #444; font-weight: 600;
}
.sub-section-header td {
  font-weight: 700 !important;
  padding-top: ${sectionHeaderInline ? 6 : 12}px !important;
  padding-bottom: 3px !important; text-transform: uppercase !important;
  font-size: ${sectionHeaderInline ? basePx - 1 : smallPx + 1}px !important;
  border: none !important; color: #000 !important;
  ${sectionHeaderInline ? `border-bottom: 0.5px solid #ccc !important; background-color: ${sectionRowBackground} !important;` : ""}
}
.tbl-results.has-sibling .sub-section-header .sibling-section-title,
.tbl-results.has-sibling .sub-section-header .sibling-section-label {
  width: auto !important;
}
.tbl-results.has-sibling .sub-section-header .sibling-section-title {
  text-align: left !important;
}
.tbl-results.has-sibling .sub-section-header .sibling-section-label {
  text-align: center !important;
  text-decoration: underline !important;
}
.descriptive-row td { border-bottom: 0.5px dotted #e5e5e5 !important; color: #111 !important; }
.tbl-results .qualitative-wide-value {
  width: ${formatBasicWidth(standardColumnWidths.slice(1).reduce((sum, width) => sum + width, 0))} !important;
  text-align: left !important;
  white-space: normal !important;
  overflow: visible !important;
  overflow-wrap: anywhere !important;
  word-break: break-word !important;
}
/* Qualitative value inside a group that also has numeric rows: stays in the VALUE
   column so the column does not stagger, but may wrap instead of being clipped. */
.tbl-results .qualitative-inline-value {
  text-align: right !important;
  white-space: normal !important;
  overflow: visible !important;
  overflow-wrap: anywhere !important;
  word-break: break-word !important;
}
.calculated-note { font-size: ${smallPx}px; color: #444; margin: 3px 0 6px; font-style: italic; }
/* Group interpretation — kept in sync with generateBasicDefaultTemplateHtml's
   plain .group-interpretation styling so the preview matches the delivered PDF. */
.group-interpretation { margin-top: 8px; padding: 6px 0; border-top: 1px solid #ddd; font-size: ${basePx}px; }
.group-interpretation figure.table { margin: 8px 0 0 0; width: 100%; }
.group-interpretation figure.table table,
.group-interpretation .tbl-interpretation {
  border-collapse: collapse !important;
  width: 100% !important;
}
.group-interpretation figure.table table td,
.group-interpretation figure.table table th,
.group-interpretation .tbl-interpretation td,
.group-interpretation .tbl-interpretation th {
  border: 1px solid #ccc !important;
  padding: 5px 8px !important;
  vertical-align: top !important;
}
.group-interpretation figure.table table thead th,
.group-interpretation .tbl-interpretation thead th {
  background-color: #f0f0f0 !important;
  font-weight: 700 !important;
}
.group-interpretation .flag-high, .group-interpretation .value-high { color: #dc2626 !important; font-weight: 700 !important; }
.group-interpretation .flag-low, .group-interpretation .value-low { color: #ea580c !important; font-weight: 700 !important; }
.group-interpretation .flag-critical, .group-interpretation .flag-critical_h, .group-interpretation .value-critical { color: #dc2626 !important; font-weight: 900 !important; }
.group-interpretation .flag-abnormal, .group-interpretation .value-abnormal { color: #dc2626 !important; font-weight: 700 !important; }
.group-interpretation .flag-trace, .group-interpretation .value-trace { color: #ea580c !important; font-weight: 700 !important; }
.group-interpretation .flag-normal, .group-interpretation .value-normal { color: #1f2937 !important; font-weight: 700 !important; }
/* Report-section rich HTML (tables inside section content) — border protection,
   mirrors .section-rich-content in the PDF template. */
.section-rich-content table { border-collapse: collapse !important; }
.section-rich-content table td,
.section-rich-content table th {
  border: 1px solid #9ca3af !important;
  padding: 8px !important;
  font-weight: inherit !important;
  background-color: inherit !important;
  vertical-align: middle !important;
}
/* Rich section content must flow across pages — see the matching note in the PDF
   template. Holding the block together blanked page 1 on narrative reports. */
.section-rich-content { page-break-inside: auto; break-inside: auto; }
.section-rich-content > .center-title { page-break-after: avoid; break-after: avoid; }
.section-rich-content table tr { page-break-inside: avoid; break-inside: avoid; }
.narrative-panel {
  margin: 0 0 ${testGroupSpacing}px;
  border-top: 1.5px solid #000;
  border-bottom: 1px solid #d1d5db;
  padding: 8px 0 10px;
}
.narrative-panel .center-title { margin-top: 0; }
.narrative-body {
  margin-top: 8px;
  font-size: ${basePx}px;
  line-height: 1.55;
  color: #111;
}
.narrative-kv-row {
  display: grid;
  grid-template-columns: ${sectionFieldNamePct}% 1fr;
  gap: 10px;
  padding: 6px 0;
  border-bottom: 0.5px dotted #d1d5db;
}
.narrative-kv-label { font-weight: 700; color: #111; }
.narrative-kv-value { color: #111; }
.narrative-body p { margin: 0 0 8px; }
.narrative-body ul { margin: 0; padding-left: 18px; }
.narrative-body li { margin-bottom: 4px; }
.narrative-section-heading {
  font-weight: 700; text-transform: uppercase;
  font-size: ${basePx + 1}px; padding: 10px 0 4px;
  border-bottom: 0.5px solid #bbb; margin-top: 8px;
  letter-spacing: 0.02em; color: #000;
}
.narrative-para { margin: 3px 0 6px; line-height: 1.55; }
		.test-results { display: flex; flex-direction: column; flex: 1 1 auto; }
		.report-disclaimer { margin-top: 10px; padding-top: 6px; border-top: 0.5px solid #bbb; font-size: ${smallPx}px; color: #444; font-style: italic; line-height: 1.4; page-break-inside: avoid; break-inside: avoid; }
		.report-footer { margin-top: auto; padding-top: 30px; display: flex; justify-content: space-between; align-items: flex-end; page-break-inside: avoid; break-inside: avoid; }
	.report-footer .qr-verify { margin-left: ${qrHorizontalOffset}px; }
	.qr-top-left-slot .qr-verify { margin-left: ${qrHorizontalOffset}px; }
	.qr-top-right-slot .qr-verify { margin-right: ${qrHorizontalOffset}px; }
	.qr-verify img { width: 46px; height: 46px; display: block; }
	.qr-verify p { margin: 2px 0 0; font-size: ${smallPx}px; color: #6b7280; }
	.auth-text { font-size: ${smallPx}px; color: #444; font-style: italic; }
	.signatory-box { text-align: right; }
	.signature-image { max-height: ${signatureMaxHeight}px; max-width: ${signatureMaxWidth}px; width: auto; height: auto; margin-bottom: 4px; display: block; margin-left: auto; object-fit: contain; }
	.signatory-name { font-weight: 700; font-size: ${basePx + 1}px; }
	.signatory-role { font-size: ${basePx - 1}px; margin-top: 2px; color: #333; }
		.compact-page .report-main-title { font-size: ${basePx + 3}px; padding: 5px 0; margin-bottom: 10px; }
		.compact-page .patient-header-table { margin-bottom: 0; }
		.compact-page .patient-header-table th,
		.compact-page .patient-header-table td,
		.compact-page .tbl-results td,
		.compact-page .tbl-results th { font-size: ${basePx}px !important; padding-top: ${analyteRowSpacing}px !important; padding-bottom: ${analyteRowSpacing}px !important; }
		.compact-page figure { margin-bottom: ${Math.round(testGroupSpacing / 2)}px !important; page-break-inside: avoid; break-inside: avoid; }
		.compact-page .center-title { font-size: ${basePx + 1}px; margin-top: 8px; }
		@media print {
		  body { margin: 0; background: #fff; }
		  body { min-width: 0; overflow: visible; }
		  .preview-shell { width: auto; margin: 0; }
			  .preview-page { width: auto; min-height: auto; margin: 0; padding: ${previewMargins.top}px ${previewMargins.right}px ${previewMargins.bottom}px ${previewMargins.left}px; box-shadow: none; }
			  @page { size: A4; margin: 0; }
			  /* Boxes the paginator packed are pinned to a hair under a sheet. Letting
			     them size to content made a box land a fraction over the printable
			     height, so it spilled and the trailing break-after emitted a blank
			     sheet. Only boxes carrying .preview-paged are pinned — if pagination
			     never ran, layout falls back to content height rather than clipping. */
			  .preview-page.preview-paged { height: 296mm; min-height: 0; overflow: hidden; }
			  .preview-page.preview-paged:last-child { height: auto; overflow: visible; }
		}
	</style>`;

  // Patient header — mirror the configurable field list the PDF uses
  // (generateBasicDefaultTemplateHtml → patientInfoHtml). When the lab has no
  // report_patient_info_config, fall back to the same default 6 fields the PDF uses.
  const PREVIEW_PATIENT_FIELD_LABELS: Record<string, string> = {
    patientName: "Patient Name",
    patientId: "Patient ID",
    registrationDate: "Reg. Date",
    age: "Age",
    gender: "Gender",
    collectionDate: "Collected On",
    sampleId: "Sample ID",
    referringDoctorName: "Ref. Doctor",
    approvedAt: "Approved On",
    phone: "Phone",
    sampleCollectedBy: "Collected By",
    receivedAt: "Received Date/Time",
    collectionCenter: "Collection Center",
    b2bAccountName: "B2B / Account Name",
    refCenter: "Ref. Center",
    processingCenter: "Proc. Center",
  };
  const patientValueFor = (key: string): string => {
    if (patientFieldValues && Object.prototype.hasOwnProperty.call(patientFieldValues, key)) {
      return String(patientFieldValues[key] ?? "");
    }
    switch (key) {
      case "patientName": return patientName || "";
      case "patientId": return patientCode || "";
      case "sampleId": return sampleId || "";
      case "referringDoctorName": return referredBy || "";
      default: return "";
    }
  };
  // Referring doctor's degree from Doctor Master — a second line inside the
  // "Ref. Doctor" cell (mirrors buildRefDoctorBlock in generate-pdf-letterhead).
  // The cell text is ": <value>", so the inline-block wrapper is what makes the
  // degree line up under the name rather than under the colon.
  const refDoctorQualification = String(
    patientFieldValues?.referringDoctorQualification ?? "",
  ).trim();
  const refDoctorBlock = (name: string): string =>
    refDoctorQualification
      ? `<span class="ref-doctor-block">${escapeHtml(name)}` +
        `<div class="ref-doctor-degree">${escapeHtml(refDoctorQualification)}</div></span>`
      : escapeHtml(name);
  const patientCellHtml = (key: string, value: string): string =>
    key === "referringDoctorName" ? refDoctorBlock(value) : escapeHtml(value);

  const buildPatientHeaderRows = (): string => {
    const configFields = (patientInfoConfig && Array.isArray(patientInfoConfig.fields) && patientInfoConfig.fields.length > 0)
      ? patientInfoConfig.fields
          .map((key) => {
            if (PREVIEW_PATIENT_FIELD_LABELS[key]) return { label: PREVIEW_PATIENT_FIELD_LABELS[key], key };
            if (key.startsWith("custom_")) {
              const found = extraFieldConfigs?.find((f) => `custom_${f.field_key}` === key);
              const label = found
                ? found.label
                : key.replace(/^custom_/, "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
              return { label, key };
            }
            return undefined;
          })
          .filter(Boolean) as Array<{ label: string; key: string }>
      : null;

    if (configFields && configFields.length > 0) {
      // Combine age + gender into a single "Age / Sex" field when both are present.
      const ageIdx = configFields.findIndex((f) => f.key === "age");
      const genderIdx = configFields.findIndex((f) => f.key === "gender");
      if (ageIdx >= 0 && genderIdx >= 0) {
        configFields[ageIdx] = { label: "Age / Sex", key: "ageGender" };
        configFields.splice(genderIdx > ageIdx ? genderIdx : ageIdx + 1, 1);
      }
      const valueFor = (key: string): string =>
        key === "ageGender"
          ? ([patientValueFor("age"), patientValueFor("gender")].filter(Boolean).join(" / ") || ageGender || "")
          : patientValueFor(key);

      const rows: string[] = [];
      for (let i = 0; i < configFields.length; i += 2) {
        const f1 = configFields[i];
        const f2 = configFields[i + 1];
        rows.push(`<tr>
          <th>${escapeHtml(f1.label)}</th><td>: ${patientCellHtml(f1.key, valueFor(f1.key))}</td>
          ${f2 ? `<th>${escapeHtml(f2.label)}</th><td>: ${patientCellHtml(f2.key, valueFor(f2.key))}</td>` : `<th></th><td></td>`}
        </tr>`);
      }
      return rows.join("");
    }

    // Default fallback — identical field set to the PDF's default (no Sample ID row).
    return `<tr>
          <th>Name</th><td>: ${escapeHtml(patientName || "")}</td>
          <th>Reg. No</th><td>: ${escapeHtml(patientCode || "")}</td>
        </tr>
        <tr>
          <th>Age / Sex</th><td>: ${escapeHtml(ageGender || "")}</td>
          <th>Reg. Date</th><td>: ${escapeHtml(orderDate || "")}</td>
        </tr>
        <tr>
          <th>Ref. By</th><td>: ${refDoctorBlock(referredBy || "")}</td>
          <th>Report Date</th><td>: ${escapeHtml(reportDate || "")}</td>
        </tr>`;
  };

  // Wrapped in .preview-page-header so the client-side paginator can clone it onto
  // every page it creates (see the paginator script at the foot of this document).
  const patientHtml = `
  <div class="preview-page-header">
	  <div>
	    <div class="report-id-line">
	      <span>${orderId ? `Order ID: <strong>${escapeHtml(orderId)}</strong>` : ""}</span>
	      <span class="preview-mode-badge">${isCompact ? "Compact Preview" : "Basic Preview"}</span>
	    </div>
	    ${(!showReportTitle && qrPosition !== "top_left" && qrPosition !== "top_right") ? "" : `
	    <div class="report-title-bar">
	      <div class="qr-top-left-slot" style="width:110px;flex-shrink:0;"></div>
	      ${showReportTitle ? `<h2 class="report-main-title" style="flex:1;">TEST REPORT</h2>` : `<div style="flex:1;"></div>`}
	      <div class="qr-top-right-slot" style="width:110px;flex-shrink:0;text-align:right;"></div>
	    </div>`}
	  </div>
  <figure style="margin:0;">
    <table class="patient-header-table">
      <tbody>${buildPatientHeaderRows()}</tbody>
	    </table>
	  </figure>
    <div class="patient-test-separator"></div>
  </div>`;

  // Test results (all groups)
    // Report sections — mirror the PDF's reportSectionsHtml: rich HTML (content with a
    // real <table>) renders as a border-protected block; plain text renders as a
    // narrative-panel with a centered underlined title.
    let sectionsHtml = "";
    const validSections = sections.filter(s => s.content && s.content.trim());
    if (validSections.length > 0) {
      sectionsHtml = validSections.map((sec) => {
        const rawContent = sec.content.trim();
        const isRichHtml = /<table\b/i.test(rawContent);
        if (isRichHtml) {
          return `
        <div class="section-rich-content" style="margin: 8px 0 14px;">
          <div class="center-title">${escapeHtml(sec.sectionName)}</div>
          <div style="font-size:${basePx}px;">${rawContent}</div>
        </div>`;
        }
        return `
        <section class="narrative-panel">
          <div class="center-title">${escapeHtml(sec.sectionName)}</div>
          <div class="narrative-body">${formatNarrativeHtml(rawContent)}</div>
        </section>`;
      }).join("");
    }

    const qrBlock = verificationUrl
      ? `<div class="qr-verify">
          <img src="https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(verificationUrl)}" alt="Verify Report" />
          <p>Scan to verify</p>
        </div>`
      : "";

    const topQrBlock = qrPosition === "top_left" ? qrBlock : "";
    const topRightQrBlock = qrPosition === "top_right" ? qrBlock : "";
    const footerQrBlock = qrPosition === "bottom_left" ? qrBlock : "";
    let patientHtmlWithQr = topQrBlock
      ? patientHtml.replace(
          '<div class="qr-top-left-slot" style="width:110px;flex-shrink:0;"></div>',
          `<div class="qr-top-left-slot" style="width:110px;flex-shrink:0;">${topQrBlock}</div>`,
        )
      : patientHtml;
    if (topRightQrBlock) {
      patientHtmlWithQr = patientHtmlWithQr.replace(
        '<div class="qr-top-right-slot" style="width:110px;flex-shrink:0;text-align:right;"></div>',
        `<div class="qr-top-right-slot" style="width:110px;flex-shrink:0;text-align:right;">${topRightQrBlock}</div>`,
      );
    }
    const authBlock = `<div>${footerQrBlock}<div class="auth-text">Authenticated Electronic Report</div></div>`;

    const signatoryBlock = (signatoryName || signatoryDesignation || signatoryImageUrl)
      ? `<div class="signatory-box">
          ${signatoryImageUrl ? `<img class="signature-image" src="${escapeHtml(signatoryImageUrl)}" alt="" onerror="this.style.display='none'" />` : ""}
          ${signatoryName ? `<div class="signatory-name">${escapeHtml(signatoryName)}</div>` : ""}
          ${signatoryDesignation ? `<div class="signatory-role">${escapeHtml(signatoryDesignation)}</div>` : ""}
        </div>`
      : "";

    const disclaimerHtml = (showReportDisclaimer && reportDisclaimerText)
      ? `<div class="report-disclaimer">${escapeHtml(reportDisclaimerText).replace(/\n/g, "<br />")}</div>`
      : "";

    const footerHtml = `
    ${disclaimerHtml}
    <div class="report-footer">
      ${authBlock}
      ${signatoryBlock}
    </div>`;

	  let testResultsHtml = isCompact ? '<div class="compact-pages">' : '<div class="standard-pages">';
	  let currentCompactPage = 0;
	  const standardGroupCount = orderedTestGroups.filter((group) => group.analytes?.length).length;
	  let standardRenderedGroupIndex = 0;

	  for (let groupIndex = 0; groupIndex < orderedTestGroups.length; groupIndex += 1) {
	    const group = orderedTestGroups[groupIndex];
	    if (!group.analytes || group.analytes.length === 0) continue;
	    let standardPageFooterHtml = "";

	    if (isCompact) {
	      const groupKey = group.testGroupId || group.testGroupName;
	      const pageNumber = Math.max(1, Number(compactAssignments[groupKey] || 1));
	      if (pageNumber !== currentCompactPage) {
		        if (currentCompactPage > 0) testResultsHtml += `</div>${footerHtml}</div>`;
	        currentCompactPage = pageNumber;
	        testResultsHtml += `<div class="preview-page compact-page">${patientHtmlWithQr}<div class="test-results">`;
	      }
	    }
	    if (!isCompact) {
	      standardRenderedGroupIndex += 1;
	      standardPageFooterHtml = !sectionsHtml && standardRenderedGroupIndex === standardGroupCount
	        ? footerHtml
	        : "";
	      testResultsHtml += `<div class="preview-page standard-page">${patientHtmlWithQr}<div class="test-results">`;
	    }

    const groupForceTableLayout = resolveForceTableLayout(group.printOptions, printOptions);
    const groupSubtitleHtml = buildGroupSubtitleHtml(group, printOptions);

    if (isNarrativeGroup(group.analytes, groupForceTableLayout)) {
      const titleClass = testGroupTitlePosition === "above_headers_left" ? "center-title left" : "center-title";
      const rowsHtml = group.analytes.map((analyte) => {
        const rawParam = (analyte.parameter || "").trim();
        const rawValue = (analyte.value || analyte.reference_range || "").trim();

        // Clean ** bold markers from both sides
        const param = stripLooseMarkdown(rawParam);
        const value = stripLooseMarkdown(rawValue.replace(/^\*\*\s*/, "").replace(/\s*\*\*$/, ""));

        if (!param && !value) return "";

        // Section header: parameter starts with ** and value is empty or just **
        const isSectionHeader =
          /^\*\*/.test(rawParam) &&
          (!rawValue || /^\*\*\s*$/.test(rawValue));

        if (isSectionHeader) {
          return `<div class="narrative-section-heading">${escapeHtml(param)}</div>`;
        }

        // Free-text paragraph: no ** prefix on parameter and no value
        if (!/^\*\*/.test(rawParam) && !value) {
          return `<p class="narrative-para">${escapeHtml(param)}</p>`;
        }

        // Key-value pair
        return `
        <div class="narrative-kv-row">
          <div class="narrative-kv-label">${escapeHtml(param)}</div>
          <div class="narrative-kv-value">${formatNarrativeHtml(value)}</div>
        </div>`;
      }).join("");

	      testResultsHtml += `
	      <section class="narrative-panel">
	        <div class="${titleClass}">${group.testGroupName}</div>
	        ${groupSubtitleHtml}
	        <div class="narrative-body">${rowsHtml}</div>
	        ${group.groupInterpretation ? `<div class="limsv2-report group-interpretation">${group.groupInterpretation}</div>` : ""}
	      </section>`;
	      if (!isCompact) testResultsHtml += `</div>${standardPageFooterHtml}</div>`;
	      continue;
	    }

		    let hasCalcInGroup = false;
		    const analyteById = new Map<string, PreviewAnalyte>();
		    const sameRowSiblingIds = new Set<string>();
		    let sameRowSiblingLabel = "Absolute Count";
		    for (const row of group.analytes) {
		      for (const analyteId of getPreviewAnalyteIdentityIds(row)) {
		        analyteById.set(analyteId, row);
		      }
		    }
		    for (const row of group.analytes) {
		      const options = row.report_display_options || {};
		      const siblingId = String(options.sameRowSiblingAnalyteId || "").trim();
		      if (siblingId && analyteById.has(siblingId)) {
		        sameRowSiblingIds.add(siblingId);
		        if ((options as any).sameRowSiblingLabel) sameRowSiblingLabel = String((options as any).sameRowSiblingLabel);
		      }
		    }
		    const hasSameRowSibling = sameRowSiblingIds.size > 0;
		    const effectiveColCount = hasSameRowSibling ? 6 : colCount;

    // Pre-compute which sections have siblings
    const sectionsWithSiblings = new Set<string | null>();
    for (const a of group.analytes) {
      const siblingId = String(a.report_display_options?.sameRowSiblingAnalyteId || "").trim();
      if (siblingId && analyteById.has(siblingId)) {
        sectionsWithSiblings.add(a.section_heading ?? null);
      }
    }

    const groupTitleBelowHeaders = testGroupTitlePosition === "below_headers";
    const groupTitleClass = testGroupTitlePosition === "above_headers_left" ? "center-title left" : "center-title";

	    testResultsHtml += `
	  <figure style="margin: 0 0 ${testGroupSpacing}px;">
		    ${!groupTitleBelowHeaders ? `<div class="${groupTitleClass}">${group.testGroupName}</div>${groupSubtitleHtml}` : ""}
			    <table class="tbl-results${hasSameRowSibling ? " has-sibling" : ""}">
			      ${hasSameRowSibling ? `<colgroup>
			        <col style="width:${formatBasicWidth(siblingColumnWidths[0])}">
		        <col style="width:${formatBasicWidth(siblingColumnWidths[1])}">
		        <col style="width:${formatBasicWidth(siblingColumnWidths[2])}">
		        <col style="width:${formatBasicWidth(siblingColumnWidths[3])}">
				        <col style="width:${formatBasicWidth(siblingColumnWidths[4])}">
				        <col style="width:${formatBasicWidth(siblingColumnWidths[5])}">
				      </colgroup>` : ""}
		      <thead>
		        <tr>
		          <th>TEST NAME</th>
		          <th>VALUE</th>
		          <th>UNITS</th>
		          <th>Bio. Ref. Interval</th>
		          ${hasSameRowSibling ? `<th colspan="2"></th>` : ""}
		        </tr>
		      </thead>
			      <tbody>
			        ${groupTitleBelowHeaders ? `
		        <tr class="main-group-row">
	          <td colspan="${effectiveColCount}">
	            <div class="center-title">${group.testGroupName}</div>
	            ${groupSubtitleHtml}
	          </td>
        </tr>` : ""}`;

    // Group analytes by section_heading - stable, first-appearance order so that
    // same-section analytes are always together even if sort_order values leave gaps.
    type SectionBlock = { heading: string | null; analytes: PreviewAnalyte[] };
    const sectionBlockMap = new Map<string | null, PreviewAnalyte[]>();
    const sectionOrder: (string | null)[] = [];
    for (const a of group.analytes) {
      const heading = a.section_heading ?? null;
      if (!sectionBlockMap.has(heading)) {
        sectionBlockMap.set(heading, []);
        sectionOrder.push(heading);
      }
      sectionBlockMap.get(heading)!.push(a);
    }
    const sectionBlocks: SectionBlock[] = sectionOrder.map(h => ({ heading: h, analytes: sectionBlockMap.get(h)! }));

    const groupLegendParts: string[] = [];

    // Wide colspan'd value cells are left-aligned while normal value cells are
    // right-aligned, so mixing the two inside one group staggers the VALUE column.
    // Decide once per group, off the printed data (unit / reference range) rather than
    // the value_type tag, and reserve the wide cell for groups that actually have
    // sentence-length values — short results stay right-aligned in the VALUE column.
    // Mirrors generateBasicDefaultTemplateHtml in the PDF function.
    const groupHasNoUnitsOrRefs = group.analytes.every(
      (a) => !String(a.unit || "").trim() && !String(a.reference_range || "").trim(),
    );
    const groupUsesWideQualitativeValues = groupHasNoUnitsOrRefs &&
      group.analytes.some((a) => String(a.value ?? "").trim().length > LONG_QUALITATIVE_VALUE_CHARS);

	    for (const block of sectionBlocks) {
	      const sectionHasSiblings = sectionsWithSiblings.has(block.heading);
	      if (block.heading) {
	        if (sectionHasSiblings && hasSameRowSibling) {
	          // Section with siblings: show section name plus the sibling label only.
		        testResultsHtml += `
		        <tr class="sub-section-header">
		          <td class="sibling-section-title" colspan="4">${block.heading}</td>
		          <td class="sibling-section-label" colspan="2">${sameRowSiblingLabel}</td>
		        </tr>`;
	        } else {
          // Section without siblings: span all columns
	        testResultsHtml += `
	        <tr class="sub-section-header">
	          <td colspan="${effectiveColCount}">${block.heading}</td>
	        </tr>`;
        }
      }

	      for (const analyte of block.analytes) {
		        const currentAnalyteIds = getPreviewAnalyteIdentityIds(analyte);
		        if (
		          currentAnalyteIds.some((id) => sameRowSiblingIds.has(id)) &&
		          analyte.report_display_options?.hiddenWhenRenderedAsSibling !== false
		        ) {
		          continue;
	        }

	        const rawValue = analyte.value ?? "";
        const unit = analyte.unit || "";
        const refRange = (analyte.reference_range || "").replace(/\n/g, "<br>");
        const canonical = normalizeFlag(analyte.flag);
        const isCalc = analyte.is_auto_calculated ?? false;
        if (isCalc) hasCalcInGroup = true;

        const unitText = unit.trim().toLowerCase();
        const refText = refRange.trim();
        const hasNumericRef = /\d/.test(refText);
        const valueTypeRaw = String(analyte.value_type || "").toLowerCase();
        const isQualitativeRow = valueTypeRaw === "qualitative" && !unitText && !refText;
        const isQualitativeWithoutMetadata = groupUsesWideQualitativeValues;
        // Text value staying in the VALUE column: keep it right-aligned with the numeric
        // rows, but let it wrap rather than be clipped by the column's nowrap.
        const inlineQualitativeClass =
          !groupUsesWideQualitativeValues && (isQualitativeRow || groupHasNoUnitsOrRefs)
            ? " qualitative-inline-value"
            : "";
        const isDescriptive =
          valueTypeRaw !== "qualitative" &&
          (unitText === "n/a" ||
          unitText === "na" ||
          unitText === "-" ||
          unitText === "none" ||
          (!unitText && refText && !hasNumericRef));

        // *cal / *cal(text) suffix
        const calcSuffix = isCalc
          ? calcMarker === "asterisk"
            ? `<sup style="font-size:${smallPx - 1}px; color:#444; margin-left:1px;">*</sup>`
            : calcMarker === "cal"
            ? `<span style="font-size:${smallPx - 1}px; color:#888; margin-left:2px; font-style:italic;">*cal</span>`
            : ""
          : "";

        // ** / *** asterisk suffix on value
        const isNumericHigh = canonical === "high" || canonical === "critical_high";
        const isNumericLow = canonical === "low" || canonical === "critical_low";
        const asteriskSuffix = flagAsterisk && (isNumericHigh || isNumericLow)
          ? flagAsteriskCritical && (canonical === "critical_high" || canonical === "critical_low")
            ? "***"
            : "**"
          : "";

        if (isDescriptive) {
	        testResultsHtml += `
	        <tr class="descriptive-row">
	          <td colspan="${effectiveColCount}" style="font-size:${basePx}px;">
	            <span style="font-weight:600;">${analyte.parameter}${calcSuffix}</span>: ${rawValue || refText || ""}
	          </td>
        </tr>`;
          continue;
        }

        const sym = flagSymbol !== "none" ? flagSymbolForReport(canonical, allowedFlagCodes) : "";
        const formattedValue = formatAnalyteDisplayValue(
          analyte,
          printOptions,
          rawValue,
          formatIndianNumber,
        );
	        const displayValue =
	          flagSymbol === "before" && sym
	            ? `<span style="display:inline-block;font-weight:700;margin-right:${flagGapPx}px;">${sym}</span>${formattedValue + asteriskSuffix}`
	            : flagSymbol === "after" && sym
	            ? `${formattedValue + asteriskSuffix}<span style="display:inline-block;font-weight:700;margin-left:${flagGapPx}px;">${sym}</span>`
	            : formattedValue + asteriskSuffix;

	        const valClass = canonical ? `val ${canonical}` : "val";
		        const siblingId = String(analyte.report_display_options?.sameRowSiblingAnalyteId || "").trim();
	        const siblingAnalyte = siblingId ? analyteById.get(siblingId) : null;
	        const siblingValueHtml = siblingAnalyte
	          ? (() => {
		              const siblingValue = formatAnalyteDisplayValue(
		                siblingAnalyte,
		                printOptions,
		                undefined,
		                formatIndianNumber,
		              );
		              const siblingUnit = siblingAnalyte.unit || "";
		              if (!siblingValue && !siblingUnit) return "";
		              const siblingCanonical = normalizeFlag(siblingAnalyte.flag);
		              const siblingClass = siblingCanonical ? `val ${siblingCanonical}` : "val";
		              return `<span class="same-row-sibling"><span class="${siblingClass}">${siblingValue}</span>${siblingUnit ? `<span class="same-row-sibling-unit">${siblingUnit}</span>` : ""}</span>`;
		            })()
		          : "";
	        const siblingRefHtml = siblingAnalyte
	          ? (() => {
		              const siblingRefRange = (siblingAnalyte.reference_range || "").replace(/\n/g, "<br>");
		              if (!siblingRefRange) return "";
		              return `<span class="same-row-sibling-ref">${siblingRefRange}</span>`;
		            })()
		          : "";

        // Determine if THIS row's section has siblings
        const rowSectionHasSiblings = sectionsWithSiblings.has(analyte.section_heading ?? null);

        // Use explicit widths: sibling sections get 6-column narrow layout, non-sibling sections get 4-column wide layout
	        if (hasSameRowSibling && rowSectionHasSiblings) {
	          // 6-column narrow layout for sibling sections
	          testResultsHtml += `
	          <tr>
	            <td class="test-name-cell" style="width:${formatBasicWidth(siblingColumnWidths[0])};">
	              <div class="test-name">${analyte.parameter}${calcSuffix}</div>
	            </td>
	            <td class="${valClass}" style="width:${formatBasicWidth(siblingColumnWidths[1])}; text-align:right;">${displayValue}</td>
	            <td style="width:${formatBasicWidth(siblingColumnWidths[2])}; text-align:left; vertical-align:top; font-size:${basePx}px; color:#444;">${unit}</td>
	            <td style="width:${formatBasicWidth(siblingColumnWidths[3])}; text-align:left; vertical-align:top; font-size:${smallPx + 1}px; color:#666;">${refRange}</td>
	            <td style="width:${formatBasicWidth(siblingColumnWidths[4])}; text-align:right; vertical-align:top;">${siblingValueHtml}</td>
	            <td style="width:${formatBasicWidth(siblingColumnWidths[5])}; text-align:left; vertical-align:top; font-size:${smallPx + 1}px; color:#666;">${siblingRefHtml}</td>
	          </tr>`;
	        } else if (hasSameRowSibling && !rowSectionHasSiblings) {
	          // 4-column wide layout (with colspan) for non-sibling sections in a table that has siblings elsewhere
	          testResultsHtml += `
	          <tr class="${isQualitativeWithoutMetadata ? "qualitative-wide-row" : ""}">
	            <td class="test-name-cell" style="width:${formatBasicWidth(standardColumnWidths[0])};">
	              <div class="test-name">${analyte.parameter}${calcSuffix}</div>
	            </td>
	            ${isQualitativeWithoutMetadata
	              ? `<td class="${valClass} qualitative-wide-value" colspan="5">${displayValue}</td>`
	              : `<td class="${valClass}${inlineQualitativeClass}" style="width:${formatBasicWidth(standardColumnWidths[1])}; text-align:right;">${displayValue}</td>
	            <td style="width:${formatBasicWidth(standardColumnWidths[2])}; text-align:left; vertical-align:top; font-size:${basePx}px; color:#444;">${unit}</td>
	            <td style="width:${formatBasicWidth(standardColumnWidths[3])}; text-align:left; vertical-align:top; font-size:${smallPx + 1}px; color:#666;" colspan="3">${refRange}</td>`}
	          </tr>`;
        } else {
          // Standard 4-column layout (no siblings in entire table)
          testResultsHtml += `
          <tr class="${isQualitativeWithoutMetadata ? "qualitative-wide-row" : ""}">
            <td class="test-name-cell">
              <div class="test-name">${analyte.parameter}${calcSuffix}</div>
            </td>
            ${isQualitativeWithoutMetadata
              ? `<td class="${valClass} qualitative-wide-value" colspan="3">${displayValue}</td>`
              : `<td class="${valClass}${inlineQualitativeClass}">${displayValue}</td>
            <td style="text-align:left; vertical-align:top; font-size:${basePx}px; color:#444;">${unit}</td>
            <td style="text-align:left; vertical-align:top; font-size:${smallPx + 1}px; color:#666;">${refRange}</td>`}
          </tr>`;
        }
      }
    }

    // Per-group legend
    if (hasCalcInGroup && calcMarker === "asterisk") groupLegendParts.push("* Calculated parameter");
    if (flagAsterisk) groupLegendParts.push("** Abnormal value");
    if (flagAsterisk && flagAsteriskCritical) groupLegendParts.push("*** Critical value");
    if (showFlagLegend && flagSymbol !== "none") {
      // The legend lists only what the report can actually print.
      const legend = flagLegendText(allowedFlagCodes);
      if (legend) groupLegendParts.push(legend);
    }

    testResultsHtml += `
      </tbody>
    </table>
    ${groupLegendParts.length ? `<p class="calculated-note">${groupLegendParts.join(" &nbsp;|&nbsp; ")}</p>` : ""}
	    ${group.groupInterpretation ? `<div class="limsv2-report group-interpretation">${group.groupInterpretation}</div>` : ""}
	  </figure>`;
	    if (!isCompact) testResultsHtml += `</div>${standardPageFooterHtml}</div>`;
	  }

			  testResultsHtml += isCompact
			    ? currentCompactPage > 0
				      ? `${sectionsHtml}</div>${footerHtml}</div></div>`
			      : `<div class="preview-page compact-page">${patientHtml}${sectionsHtml}${footerHtml}</div></div>`
			    : `${sectionsHtml ? `<div class="preview-page standard-page">${patientHtml}${sectionsHtml}${footerHtml}</div>` : ""}</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Quick Preview</title>
${css}
</head>
<body>
<div class="preview-shell" style="font-family: Arial, Helvetica, sans-serif; font-size: ${basePx}px; color: #000;">
  ${testResultsHtml}
</div>
${PAGINATOR_SCRIPT}
</body>
</html>`;
}
