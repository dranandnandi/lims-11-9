import { jsPDF } from "jspdf";

/**
 * A4 landscape "B2B partner patient list", generated client-side with jsPDF.
 * Mirrors the B2B Patient List screen: partner-wise groups of order rows with
 * patient demographics, test names + rates, status/billing and amounts, plus
 * per-partner subtotals, a partner-wise summary and a grand total band.
 *
 * Which data columns print is caller-controlled (see `columns`); the remaining
 * columns are widened proportionally so the table always fills the page width.
 */

export interface B2BPatientPdfTest {
  name: string;
  price: number | null;
}

export interface B2BPatientPdfRow {
  partnerId: string;
  partnerName: string;
  partnerCode: string | null;
  /** Plain yyyy-MM-dd order date (formatted without timezone shifting) */
  date: string;
  orderRef: string;
  /** Used only for the unique-patient counts */
  patientId: string;
  patientCode: string;
  patientName: string;
  ageGender: string;
  phone: string;
  doctor: string;
  status: string;
  /** "Billed" / "pending" / partner billing status */
  billing: string;
  amount: number;
  tests: B2BPatientPdfTest[];
}

export type B2BPatientPdfColumnKey =
  | "date"
  | "orderRef"
  | "patientCode"
  | "ageGender"
  | "phone"
  | "doctor"
  | "tests"
  | "status"
  | "billing"
  | "amount";

export interface B2BPatientPdfOptions {
  dateFrom: string;
  dateTo: string;
  labName?: string;
  /** Partner filter label, e.g. "All partners" or the partner name */
  partnerLabel?: string;
  /** Status filter label; omitted from the header when "all" */
  statusLabel?: string;
  /** Free-text search that produced this list, if any */
  searchLabel?: string;
  /** Columns to print. Omit for every column; the serial no. and patient name always print. */
  columns?: B2BPatientPdfColumnKey[];
  /** Print the per-test rate next to each test name (default true) */
  showTestRates?: boolean;
  /** Warn on the page footer that the list was capped server-side */
  truncatedAt?: number | null;
}

const PAGE_MARGIN = 28;
const CONTENT_WIDTH = 786; // A4 landscape (842pt) minus both margins
const HEADER_BOTTOM = 96;
const FOOTER_RESERVE = 30;

interface Column {
  key: string;
  label: string;
  /** Relative weight; scaled to fill CONTENT_WIDTH once the hidden columns drop out */
  width: number;
  align: "left" | "right";
}

/** Every printable column, in print order. `seq` / `patient` are not optional. */
const ALL_COLUMNS: Column[] = [
  { key: "seq", label: "#", width: 22, align: "left" },
  { key: "date", label: "Date", width: 52, align: "left" },
  { key: "orderRef", label: "Order / Sample", width: 88, align: "left" },
  { key: "patientCode", label: "Patient ID", width: 62, align: "left" },
  { key: "patient", label: "Patient Name", width: 108, align: "left" },
  { key: "ageGender", label: "Age / Sex", width: 48, align: "left" },
  { key: "phone", label: "Phone", width: 60, align: "left" },
  { key: "doctor", label: "Ref. Doctor", width: 68, align: "left" },
  { key: "tests", label: "Tests", width: 140, align: "left" },
  { key: "status", label: "Status", width: 52, align: "left" },
  { key: "billing", label: "Billing", width: 44, align: "left" },
  { key: "amount", label: "Amount", width: 58, align: "right" },
];

/** Columns the caller can switch off, in the order they print. */
export const B2B_PDF_OPTIONAL_COLUMNS: { key: B2BPatientPdfColumnKey; label: string }[] =
  ALL_COLUMNS.filter((col) => col.key !== "seq" && col.key !== "patient").map((col) => ({
    key: col.key as B2BPatientPdfColumnKey,
    label: col.label,
  }));

interface Layout {
  columns: Column[];
  x: (index: number) => number;
  right: (index: number) => number;
  /** Text anchor for a column, honouring its alignment */
  anchor: (index: number) => number;
  indexOf: (key: string) => number;
  has: (key: string) => boolean;
}

/** Keep the visible columns in print order and stretch them to fill the page width. */
const buildLayout = (visible?: B2BPatientPdfColumnKey[]): Layout => {
  const allowed = visible ? new Set<string>(visible) : null;
  const kept = ALL_COLUMNS.filter(
    (col) => col.key === "seq" || col.key === "patient" || !allowed || allowed.has(col.key),
  );
  const weight = kept.reduce((sum, col) => sum + col.width, 0);
  const scale = weight > 0 ? CONTENT_WIDTH / weight : 1;
  const columns = kept.map((col) => ({ ...col, width: col.width * scale }));

  const x = (index: number) =>
    PAGE_MARGIN + columns.slice(0, index).reduce((sum, col) => sum + col.width, 0);
  const right = (index: number) => x(index) + columns[index].width - 4;

  return {
    columns,
    x,
    right,
    anchor: (index: number) => (columns[index].align === "right" ? right(index) : x(index) + 4),
    indexOf: (key: string) => columns.findIndex((col) => col.key === key),
    has: (key: string) => columns.some((col) => col.key === key),
  };
};

/** jsPDF's helvetica has no rupee glyph, so amounts print as "Rs." like the other statements */
const money = (value: number | null | undefined): string =>
  `Rs. ${Number(value || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

const compactMoney = (value: number | null | undefined): string =>
  Number(value || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });

// Order dates are plain yyyy-MM-dd; parsing them as Date would shift the day
const shortDate = (value: string | null | undefined): string => {
  if (!value) return "-";
  const [year, month, day] = String(value).slice(0, 10).split("-");
  return year && month && day ? `${day}/${month}/${year}` : String(value);
};

const titleCase = (value: string): string =>
  value ? value.charAt(0).toUpperCase() + value.slice(1).replace(/_/g, " ") : "-";

const testsText = (tests: B2BPatientPdfTest[], showRates: boolean): string => {
  if (!tests.length) return "-";
  return tests
    .map((test) =>
      showRates && test.price != null
        ? `${test.name} (${compactMoney(test.price)})`
        : test.name,
    )
    .join(", ");
};

interface PartnerGroup {
  id: string;
  name: string;
  code: string | null;
  rows: B2BPatientPdfRow[];
  patients: number;
  tests: number;
  amount: number;
}

const groupByPartner = (rows: B2BPatientPdfRow[]): PartnerGroup[] => {
  const groups = new Map<string, { name: string; code: string | null; rows: B2BPatientPdfRow[] }>();
  rows.forEach((row) => {
    if (!groups.has(row.partnerId)) {
      groups.set(row.partnerId, {
        name: row.partnerName || "Unknown partner",
        code: row.partnerCode || null,
        rows: [],
      });
    }
    groups.get(row.partnerId)!.rows.push(row);
  });

  return Array.from(groups.entries())
    .map(([id, group]) => ({
      id,
      name: group.name,
      code: group.code,
      rows: group.rows,
      patients: new Set(group.rows.map((row) => row.patientId)).size,
      tests: group.rows.reduce((sum, row) => sum + row.tests.length, 0),
      amount: group.rows.reduce((sum, row) => sum + Number(row.amount || 0), 0),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
};

export const generateB2BPatientListPdf = (
  rows: B2BPatientPdfRow[],
  options: B2BPatientPdfOptions,
): jsPDF => {
  const doc = new jsPDF({ unit: "pt", format: "a4", orientation: "landscape" });
  const pageHeight = doc.internal.pageSize.getHeight();
  const rightEdge = PAGE_MARGIN + CONTENT_WIDTH;
  const showTestRates = options.showTestRates !== false;
  const layout = buildLayout(options.columns);

  const groups = groupByPartner(rows);
  const totals = {
    partners: groups.length,
    patients: new Set(rows.map((row) => row.patientId)).size,
    orders: rows.length,
    tests: rows.reduce((sum, row) => sum + row.tests.length, 0),
    amount: rows.reduce((sum, row) => sum + Number(row.amount || 0), 0),
    billed: rows.filter((row) => /billed/i.test(row.billing)).length,
  };
  const billedAmount = rows
    .filter((row) => /billed/i.test(row.billing))
    .reduce((sum, row) => sum + Number(row.amount || 0), 0);

  const wrap = (text: string, width: number): string[] =>
    doc.splitTextToSize(String(text ?? "-") || "-", width - 8) as string[];

  const filterLine = [
    `Partner: ${options.partnerLabel || "All partners"}`,
    options.statusLabel && options.statusLabel !== "all" ? `Status: ${titleCase(options.statusLabel)}` : "",
    options.searchLabel ? `Search: "${options.searchLabel}"` : "",
  ]
    .filter(Boolean)
    .join("   |   ");

  const drawPageHeader = () => {
    doc.setTextColor(17, 24, 39);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(14);
    doc.text(options.labName || "B2B Patient List", PAGE_MARGIN, 40);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(75, 85, 99);
    doc.text("B2B Partner Patient List", PAGE_MARGIN, 56);
    doc.text(
      `Period: ${shortDate(options.dateFrom) || "start"} to ${shortDate(options.dateTo) || "today"}`,
      PAGE_MARGIN,
      70,
    );

    doc.setFontSize(8.5);
    doc.text(filterLine, PAGE_MARGIN, 83);

    doc.text(`Generated: ${new Date().toLocaleString("en-IN")}`, rightEdge, 40, { align: "right" });
    doc.text(
      `Partners: ${totals.partners}  |  Patients: ${totals.patients}  |  Orders: ${totals.orders}  |  Tests: ${totals.tests}`,
      rightEdge,
      56,
      { align: "right" },
    );
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9.5);
    doc.setTextColor(17, 24, 39);
    doc.text(`Total Amount: ${money(totals.amount)}`, rightEdge, 71, { align: "right" });
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    doc.setTextColor(75, 85, 99);
    doc.text(
      `Billed: ${totals.billed} order${totals.billed === 1 ? "" : "s"} (${money(billedAmount)})  |  Unbilled: ${money(totals.amount - billedAmount)}`,
      rightEdge,
      83,
      { align: "right" },
    );

    doc.setDrawColor(209, 213, 219);
    doc.line(PAGE_MARGIN, 88, rightEdge, 88);
  };

  const drawTableHeader = (y: number): number => {
    doc.setFillColor(241, 245, 249);
    doc.rect(PAGE_MARGIN, y, CONTENT_WIDTH, 18, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7.5);
    doc.setTextColor(55, 65, 81);
    layout.columns.forEach((col, index) => {
      doc.text(col.label, layout.anchor(index), y + 12, { align: col.align });
    });
    return y + 18;
  };

  drawPageHeader();
  let y = HEADER_BOTTOM;

  const ensureSpace = (needed: number, repeatTableHeader: boolean): void => {
    if (y + needed <= pageHeight - FOOTER_RESERVE) return;
    doc.addPage();
    drawPageHeader();
    y = HEADER_BOTTOM;
    if (repeatTableHeader) y = drawTableHeader(y);
  };

  if (rows.length === 0) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(107, 114, 128);
    doc.text("No B2B patients found for these filters.", PAGE_MARGIN, y + 20);
  }

  for (const group of groups) {
    ensureSpace(60, false);

    // Partner band
    doc.setFillColor(239, 246, 255);
    doc.rect(PAGE_MARGIN, y, CONTENT_WIDTH, 24, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10.5);
    doc.setTextColor(30, 64, 175);
    const partnerTitle = `${group.name}${group.code ? ` (${group.code})` : ""}`;
    doc.text(partnerTitle, PAGE_MARGIN + 6, y + 16);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(107, 114, 128);
    doc.text(
      `${group.patients} patient${group.patients === 1 ? "" : "s"} | ${group.rows.length} order${
        group.rows.length === 1 ? "" : "s"
      } | ${group.tests} test${group.tests === 1 ? "" : "s"}`,
      PAGE_MARGIN + 12 + doc.getTextWidth(partnerTitle),
      y + 16,
    );

    doc.setFont("helvetica", "bold");
    doc.setFontSize(9.5);
    doc.setTextColor(17, 24, 39);
    doc.text(money(group.amount), rightEdge - 6, y + 16, { align: "right" });
    y += 28;

    y = drawTableHeader(y);

    group.rows.forEach((row, index) => {
      // splitTextToSize measures with the active font, so match the draw settings first
      doc.setFont("helvetica", "normal");
      doc.setFontSize(7.5);
      const value = (key: string): string => {
        switch (key) {
          case "seq": return String(index + 1);
          case "date": return shortDate(row.date);
          case "orderRef": return row.orderRef;
          case "patientCode": return row.patientCode;
          case "patient": return row.patientName;
          case "ageGender": return row.ageGender || "-";
          case "phone": return row.phone || "-";
          case "doctor": return row.doctor || "-";
          case "tests": return testsText(row.tests, showTestRates);
          case "status": return titleCase(row.status);
          case "billing": return titleCase(row.billing);
          case "amount": return money(row.amount);
          default: return "-";
        }
      };
      const cells: Record<string, string[]> = {};
      layout.columns.forEach((col) => {
        cells[col.key] = col.key === "seq" ? [String(index + 1)] : wrap(value(col.key), col.width);
      });
      const lineCount = Math.max(...layout.columns.map((col) => cells[col.key].length));
      const rowHeight = Math.max(16, lineCount * 9 + 7);

      ensureSpace(rowHeight, true);

      if (index % 2 === 1) {
        doc.setFillColor(249, 250, 251);
        doc.rect(PAGE_MARGIN, y, CONTENT_WIDTH, rowHeight, "F");
      }
      doc.setDrawColor(229, 231, 235);
      doc.rect(PAGE_MARGIN, y, CONTENT_WIDTH, rowHeight);

      doc.setFontSize(7.5);
      layout.columns.forEach((col, colIndex) => {
        if (col.key === "amount") {
          doc.setFont("helvetica", "bold");
          doc.setTextColor(17, 24, 39);
        } else if (col.key === "patient") {
          doc.setFont("helvetica", "bold");
          doc.setTextColor(31, 41, 55);
        } else if (col.key === "billing" && !/billed/i.test(row.billing)) {
          doc.setFont("helvetica", "normal");
          doc.setTextColor(180, 83, 9);
        } else {
          doc.setFont("helvetica", "normal");
          doc.setTextColor(55, 65, 81);
        }
        doc.text(cells[col.key], layout.anchor(colIndex), y + 11, { align: col.align });
      });
      doc.setFont("helvetica", "normal");
      y += rowHeight;
    });

    // Partner subtotal — amounts stay on the statement even if the Amount column is off
    ensureSpace(22, true);
    doc.setFillColor(243, 244, 246);
    doc.rect(PAGE_MARGIN, y, CONTENT_WIDTH, 18, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.setTextColor(17, 24, 39);
    doc.text(
      `Subtotal - ${group.name}  (${group.rows.length} order${group.rows.length === 1 ? "" : "s"}, ${group.tests} test${
        group.tests === 1 ? "" : "s"
      })`,
      PAGE_MARGIN + 4,
      y + 12,
    );
    const amountIndex = layout.indexOf("amount");
    doc.text(money(group.amount), amountIndex >= 0 ? layout.right(amountIndex) : rightEdge - 4, y + 12, {
      align: "right",
    });
    y += 26;
  }

  // Partner-wise summary: only useful when the run spans more than one partner
  if (groups.length > 1) {
    const summaryRowHeight = 16;
    ensureSpace(40 + (groups.length + 1) * summaryRowHeight, false);

    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.setTextColor(17, 24, 39);
    doc.text("Partner-wise Summary", PAGE_MARGIN, y + 12);
    y += 20;

    const summaryCols: Column[] = [
      { key: "partner", label: "B2B Partner", width: 300, align: "left" },
      { key: "patients", label: "Patients", width: 90, align: "right" },
      { key: "orders", label: "Orders", width: 90, align: "right" },
      { key: "tests", label: "Tests", width: 90, align: "right" },
      { key: "amount", label: "Amount", width: 120, align: "right" },
    ];
    const summaryWidth = summaryCols.reduce((sum, col) => sum + col.width, 0);
    const summaryX = (index: number) =>
      PAGE_MARGIN + summaryCols.slice(0, index).reduce((sum, col) => sum + col.width, 0);
    const summaryAnchor = (index: number) =>
      summaryCols[index].align === "right"
        ? summaryX(index) + summaryCols[index].width - 4
        : summaryX(index) + 4;

    doc.setFillColor(241, 245, 249);
    doc.rect(PAGE_MARGIN, y, summaryWidth, summaryRowHeight, "F");
    doc.setFontSize(8);
    doc.setTextColor(55, 65, 81);
    summaryCols.forEach((col, index) => {
      doc.text(col.label, summaryAnchor(index), y + 11, { align: col.align });
    });
    y += summaryRowHeight;

    groups.forEach((group) => {
      ensureSpace(summaryRowHeight, false);
      doc.setDrawColor(229, 231, 235);
      doc.rect(PAGE_MARGIN, y, summaryWidth, summaryRowHeight);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      doc.setTextColor(55, 65, 81);
      const values = [
        `${group.name}${group.code ? ` (${group.code})` : ""}`,
        String(group.patients),
        String(group.rows.length),
        String(group.tests),
        money(group.amount),
      ];
      summaryCols.forEach((col, index) => {
        doc.text(values[index], summaryAnchor(index), y + 11, { align: col.align });
      });
      y += summaryRowHeight;
    });

    ensureSpace(summaryRowHeight, false);
    doc.setFillColor(229, 231, 235);
    doc.rect(PAGE_MARGIN, y, summaryWidth, summaryRowHeight, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.setTextColor(17, 24, 39);
    const totalValues = [
      "Total",
      String(totals.patients),
      String(totals.orders),
      String(totals.tests),
      money(totals.amount),
    ];
    summaryCols.forEach((col, index) => {
      doc.text(totalValues[index], summaryAnchor(index), y + 11, { align: col.align });
    });
    y += summaryRowHeight + 12;
  }

  // Grand total band
  ensureSpace(44, false);
  doc.setFillColor(30, 64, 175);
  doc.rect(PAGE_MARGIN, y, CONTENT_WIDTH, 30, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.setTextColor(255, 255, 255);
  doc.text("Grand Total", PAGE_MARGIN + 8, y + 19);
  doc.text(
    `Partners ${totals.partners}    Patients ${totals.patients}    Orders ${totals.orders}    Tests ${totals.tests}    Amount ${money(totals.amount)}`,
    rightEdge - 8,
    y + 19,
    { align: "right" },
  );
  y += 38;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(107, 114, 128);
  doc.text(
    `Billed: ${money(billedAmount)} across ${totals.billed} order${totals.billed === 1 ? "" : "s"}   |   Pending billing: ${money(
      totals.amount - billedAmount,
    )} across ${totals.orders - totals.billed} order${totals.orders - totals.billed === 1 ? "" : "s"}`,
    PAGE_MARGIN,
    y,
  );

  // Footers
  const pageCount = doc.getNumberOfPages();
  const note = options.truncatedAt
    ? `Cancelled tests are excluded. Only the first ${options.truncatedAt.toLocaleString("en-IN")} orders are listed - narrow the date range for the rest.`
    : "Cancelled tests are excluded from test counts and amounts.";
  for (let page = 1; page <= pageCount; page += 1) {
    doc.setPage(page);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(156, 163, 175);
    doc.text(note, PAGE_MARGIN, pageHeight - 14);
    doc.text(`Page ${page} of ${pageCount}`, rightEdge, pageHeight - 14, { align: "right" });
  }

  return doc;
};

const fileName = (options: B2BPatientPdfOptions): string => {
  const scope = (options.partnerLabel || "all_partners")
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40)
    .toLowerCase();
  return `b2b_patient_list_${scope}_${options.dateFrom || "start"}_to_${options.dateTo || "end"}.pdf`;
};

export const downloadB2BPatientListPdf = (
  rows: B2BPatientPdfRow[],
  options: B2BPatientPdfOptions,
): void => {
  generateB2BPatientListPdf(rows, options).save(fileName(options));
};

/** Open the generated PDF in a new tab with the browser print dialog queued. */
export const printB2BPatientListPdf = (
  rows: B2BPatientPdfRow[],
  options: B2BPatientPdfOptions,
): void => {
  const doc = generateB2BPatientListPdf(rows, options);
  doc.autoPrint();
  const url = doc.output("bloburl") as unknown as string;
  const win = window.open(url, "_blank");
  if (!win) {
    // Popup blocked - fall back to a download so the report is never lost
    doc.save(fileName(options));
  }
};
