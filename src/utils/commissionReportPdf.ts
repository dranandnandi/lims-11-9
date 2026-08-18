import { jsPDF } from "jspdf";

/**
 * A4 landscape commission statement, generated client-side with jsPDF.
 * Mirrors what the Commission Report screen shows: per-doctor order rows with
 * billed/unbilled split, the expandable test & billing item breakdown, and
 * payable totals that keep unbilled money out of the payable figures.
 */

export interface CommissionPdfLineItem {
  item_type: string;
  name: string;
  amount: number;
  sharing_base: number;
  sharing_percent: number;
  commission: number;
}

export interface CommissionPdfDetail {
  order_id: string;
  patient_name: string;
  date: string;
  billing_status: string | null;
  is_billed: boolean;
  gross_amount: number;
  discount_amount: number;
  discount_source: string | null;
  discount_commission_mode: string;
  paid_amount: number;
  due_amount: number;
  payment_status: string;
  adjustments: {
    dr_discount?: number;
    outsource_cost?: number;
    package_diff?: number;
  };
  sharing_base: number;
  sharing_percent: number;
  commission: number;
  line_items: CommissionPdfLineItem[];
}

export interface CommissionPdfDoctor {
  doctor_id: string;
  doctor_name: string;
  is_configured: boolean;
  total_revenue: number;
  total_commission: number;
  orders_count: number;
  unbilled_revenue: number;
  unbilled_commission: number;
  unbilled_orders_count: number;
  details: CommissionPdfDetail[];
}

/**
 * How much of the per-order test / billing item breakdown the statement prints:
 * - `none`  : order rows only, sharing shown at order level
 * - `names` : test & billing item names listed, sharing still only at order level
 * - `full`  : each item with its amount, sharing percent and commission
 */
export type CommissionPdfItemDetail = "none" | "names" | "full";

/** Table columns that can be dropped from the statement to slim it down */
export type CommissionPdfOptionalColumn =
  | "status"
  | "payment"
  | "adjust"
  | "base"
  | "commission";

export interface CommissionPdfOptions {
  dateFrom: string;
  dateTo: string;
  labName?: string;
  /** Detail level for the per-order breakdown under each row (default `full`) */
  itemDetail?: CommissionPdfItemDetail;
  /** Columns to leave out; the remaining ones stretch to fill the page width */
  hiddenColumns?: CommissionPdfOptionalColumn[];
  /** @deprecated use `itemDetail`; kept so older callers keep working */
  includeItems?: boolean;
}

const PAGE_MARGIN = 28;
const CONTENT_WIDTH = 786; // A4 landscape (842pt) minus both margins
const HEADER_BOTTOM = 92;
const FOOTER_RESERVE = 34;

interface Column {
  key: string;
  label: string;
  width: number;
  align: "left" | "right";
}

const COLUMNS: Column[] = [
  { key: "order", label: "Order", width: 54, align: "left" },
  { key: "patient", label: "Patient", width: 118, align: "left" },
  { key: "date", label: "Date", width: 56, align: "left" },
  { key: "status", label: "Status", width: 48, align: "left" },
  { key: "gross", label: "Gross", width: 58, align: "right" },
  { key: "discount", label: "Discount", width: 60, align: "right" },
  { key: "paid", label: "Paid", width: 56, align: "right" },
  { key: "due", label: "Due", width: 56, align: "right" },
  { key: "payment", label: "Payment", width: 50, align: "left" },
  { key: "adjust", label: "Adjustments", width: 82, align: "left" },
  { key: "base", label: "Base", width: 58, align: "right" },
  { key: "commission", label: "Commission", width: 66, align: "right" },
];

/**
 * Drops the hidden columns and stretches the survivors proportionally so the
 * table always fills the page width instead of leaving a ragged right edge.
 */
const layoutColumns = (hidden: CommissionPdfOptionalColumn[] = []): Column[] => {
  const hiddenSet = new Set<string>(hidden);
  const kept = COLUMNS.filter((col) => !hiddenSet.has(col.key));
  const total = kept.reduce((sum, col) => sum + col.width, 0);
  if (!total) return kept;
  const scale = CONTENT_WIDTH / total;
  return kept.map((col) => ({ ...col, width: col.width * scale }));
};

/** Last 5 characters of the order reference — enough to identify it on paper */
const shortOrderRef = (value: string): string => {
  const text = String(value ?? "").trim();
  return text.length > 5 ? text.slice(-5) : text || "-";
};

const money = (value: number | null | undefined): string =>
  `Rs. ${Number(value || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

const shortDate = (value: string): string => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "-" : parsed.toLocaleDateString("en-GB");
};

const titleCase = (value: string): string =>
  value ? value.charAt(0).toUpperCase() + value.slice(1) : "-";

const adjustmentsText = (detail: CommissionPdfDetail): string => {
  const parts = Object.entries(detail.adjustments)
    .filter(([, amount]) => Number(amount) > 0)
    .map(([key, amount]) => `${key.replace(/_/g, " ")}: ${Math.round(Number(amount))}`);
  return parts.length ? parts.join(", ") : "-";
};

const discountText = (detail: CommissionPdfDetail): string => {
  if (!(detail.discount_amount > 0)) return "-";
  const mode = detail.discount_source === "doctor"
    ? detail.discount_commission_mode.replace(/_/g, " ")
    : "absorbed by lab";
  return `-${Math.round(detail.discount_amount)} (${detail.discount_source || "unknown"}, ${mode})`;
};

export const generateCommissionReportPdf = (
  commissions: CommissionPdfDoctor[],
  options: CommissionPdfOptions,
): jsPDF => {
  const doc = new jsPDF({ unit: "pt", format: "a4", orientation: "landscape" });
  const pageHeight = doc.internal.pageSize.getHeight();
  const rightEdge = PAGE_MARGIN + CONTENT_WIDTH;
  const itemDetail: CommissionPdfItemDetail =
    options.itemDetail ?? (options.includeItems === false ? "none" : "full");
  const columns = layoutColumns(options.hiddenColumns);
  const columnX = (index: number) =>
    PAGE_MARGIN + columns.slice(0, index).reduce((sum, col) => sum + col.width, 0);
  const columnIndex = (key: string) => columns.findIndex((col) => col.key === key);
  /** Right edge of a column, or the page's right edge if that column is hidden */
  const columnRight = (key: string): number => {
    const index = columnIndex(key);
    return index < 0 ? rightEdge : columnX(index) + columns[index].width;
  };

  const totals = commissions.reduce(
    (acc, c) => ({
      revenue: acc.revenue + c.total_revenue,
      commission: acc.commission + c.total_commission,
      orders: acc.orders + c.orders_count,
      unbilledRevenue: acc.unbilledRevenue + c.unbilled_revenue,
      unbilledCommission: acc.unbilledCommission + c.unbilled_commission,
      unbilledOrders: acc.unbilledOrders + c.unbilled_orders_count,
    }),
    { revenue: 0, commission: 0, orders: 0, unbilledRevenue: 0, unbilledCommission: 0, unbilledOrders: 0 },
  );

  const wrap = (text: string, width: number): string[] =>
    doc.splitTextToSize(String(text ?? "-"), width - 8) as string[];

  const drawPageHeader = () => {
    doc.setTextColor(17, 24, 39);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(14);
    doc.text(options.labName || "Commission Report", PAGE_MARGIN, 40);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(75, 85, 99);
    doc.text("Doctor Commission Report", PAGE_MARGIN, 56);
    doc.text(
      `Period: ${shortDate(options.dateFrom)} to ${shortDate(options.dateTo)}`,
      PAGE_MARGIN,
      70,
    );

    doc.setFontSize(8.5);
    doc.text(`Generated: ${new Date().toLocaleString("en-IN")}`, rightEdge, 40, { align: "right" });
    doc.text(
      `Billed: ${money(totals.revenue)}  |  Payable: ${money(totals.commission)}  |  Billed orders: ${totals.orders}`,
      rightEdge,
      56,
      { align: "right" },
    );
    doc.text(
      `Unbilled: ${money(totals.unbilledRevenue)}  |  Pending commission: ${money(totals.unbilledCommission)}  |  Unbilled orders: ${totals.unbilledOrders}`,
      rightEdge,
      70,
      { align: "right" },
    );

    doc.setDrawColor(209, 213, 219);
    doc.line(PAGE_MARGIN, 80, rightEdge, 80);
  };

  const drawTableHeader = (y: number): number => {
    doc.setFillColor(241, 245, 249);
    doc.rect(PAGE_MARGIN, y, CONTENT_WIDTH, 18, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.setTextColor(55, 65, 81);
    columns.forEach((col, index) => {
      const x = col.align === "right" ? columnX(index) + col.width - 4 : columnX(index) + 4;
      doc.text(col.label, x, y + 12, { align: col.align });
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

  for (const commission of commissions) {
    ensureSpace(64, false);

    // Doctor band
    doc.setFillColor(236, 253, 245);
    doc.rect(PAGE_MARGIN, y, CONTENT_WIDTH, 26, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10.5);
    doc.setTextColor(6, 95, 70);
    doc.text(commission.doctor_name, PAGE_MARGIN + 6, y + 17);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(107, 114, 128);
    const doctorNameWidth = doc.getTextWidth(commission.doctor_name) + 14;
    doc.text(
      commission.is_configured
        ? `${commission.orders_count} billed order${commission.orders_count === 1 ? "" : "s"}` +
          (commission.unbilled_orders_count > 0 ? ` | ${commission.unbilled_orders_count} unbilled` : "")
        : "Sharing not configured - referral listing only",
      PAGE_MARGIN + 6 + doctorNameWidth,
      y + 17,
    );

    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor(17, 24, 39);
    doc.text(
      `Revenue ${money(commission.total_revenue)}` +
        (commission.is_configured ? `   Commission ${money(commission.total_commission)}` : ""),
      rightEdge - 6,
      y + 11,
      { align: "right" },
    );
    if (commission.unbilled_orders_count > 0) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(7.5);
      doc.setTextColor(180, 83, 9);
      doc.text(
        `Unbilled ${money(commission.unbilled_revenue)}` +
          (commission.is_configured ? ` (${money(commission.unbilled_commission)} pending billing)` : ""),
        rightEdge - 6,
        y + 21,
        { align: "right" },
      );
    }
    y += 30;

    y = drawTableHeader(y);

    for (const detail of commission.details) {
      // splitTextToSize measures with the active font, so match the draw settings first
      doc.setFont("helvetica", "normal");
      doc.setFontSize(7.5);
      const values: Record<string, string> = {
        order: shortOrderRef(detail.order_id),
        patient: detail.patient_name,
        date: shortDate(detail.date),
        status: detail.is_billed ? "Billed" : titleCase(detail.billing_status || "unbilled"),
        gross: money(detail.gross_amount),
        discount: discountText(detail),
        paid: money(detail.paid_amount),
        due: detail.due_amount > 0 ? money(detail.due_amount) : "-",
        payment: titleCase(detail.payment_status),
        adjust: adjustmentsText(detail),
        base: money(detail.sharing_base),
        commission: commission.is_configured ? money(detail.commission) : "-",
      };
      const cells: Record<string, string[]> = {};
      columns.forEach((col) => {
        cells[col.key] = wrap(values[col.key], col.width);
      });
      const lineCount = Math.max(...columns.map((col) => cells[col.key].length));
      const rowHeight = Math.max(16, lineCount * 9 + 8);

      const showItems = itemDetail !== "none" && detail.line_items.length > 0;
      const itemLines = !showItems
        ? []
        : itemDetail === "names"
          ? detail.line_items.map((item) => item.name)
          : detail.line_items.map((item) =>
              `${item.name} [${item.item_type === "billing_item" ? "Billing" : "Test"}] ${money(item.amount)}` +
              (commission.is_configured
                ? ` @ ${item.sharing_percent}% = ${money(item.commission)}`
                : ""),
            );
      let wrappedItems: string[] = [];
      if (itemLines.length) {
        doc.setFontSize(7);
        const joined = itemDetail === "names"
          ? `Tests: ${itemLines.join(", ")}`
          : itemLines.join("   -   ");
        wrappedItems = doc.splitTextToSize(joined, CONTENT_WIDTH - 24) as string[];
      }
      const itemsHeight = wrappedItems.length ? wrappedItems.length * 9 + 10 : 0;

      ensureSpace(rowHeight + itemsHeight, true);

      if (!detail.is_billed) {
        doc.setFillColor(255, 251, 235);
        doc.rect(PAGE_MARGIN, y, CONTENT_WIDTH, rowHeight, "F");
      }
      doc.setDrawColor(229, 231, 235);
      doc.rect(PAGE_MARGIN, y, CONTENT_WIDTH, rowHeight);

      doc.setFont("helvetica", "normal");
      doc.setFontSize(7.5);
      columns.forEach((col, index) => {
        if (col.key === "commission") {
          doc.setFont("helvetica", "bold");
          doc.setTextColor(detail.is_billed ? 5 : 180, detail.is_billed ? 150 : 83, detail.is_billed ? 105 : 9);
        } else if (col.key === "discount" && detail.discount_amount > 0) {
          doc.setTextColor(194, 65, 12);
        } else {
          doc.setTextColor(55, 65, 81);
        }
        const x = col.align === "right" ? columnX(index) + col.width - 4 : columnX(index) + 4;
        doc.text(cells[col.key], x, y + 11, { align: col.align });
        doc.setFont("helvetica", "normal");
      });
      y += rowHeight;

      if (wrappedItems.length) {
        doc.setFillColor(249, 250, 251);
        doc.rect(PAGE_MARGIN, y, CONTENT_WIDTH, itemsHeight, "F");
        doc.setDrawColor(229, 231, 235);
        doc.rect(PAGE_MARGIN, y, CONTENT_WIDTH, itemsHeight);
        doc.setFont("helvetica", "normal");
        doc.setFontSize(7);
        doc.setTextColor(107, 114, 128);
        doc.text(wrappedItems, PAGE_MARGIN + 12, y + 10);
        y += itemsHeight;
      }
    }

    // Doctor subtotal
    ensureSpace(20, true);
    doc.setFillColor(243, 244, 246);
    doc.rect(PAGE_MARGIN, y, CONTENT_WIDTH, 18, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.setTextColor(17, 24, 39);
    doc.text(`Subtotal - ${commission.doctor_name}`, PAGE_MARGIN + 4, y + 12);
    doc.text(money(commission.total_revenue), columnRight("gross") - 4, y + 12, { align: "right" });
    if (columnIndex("commission") >= 0) {
      doc.text(
        commission.is_configured ? money(commission.total_commission) : "-",
        columnRight("commission") - 4,
        y + 12,
        { align: "right" },
      );
    }
    y += 26;
  }

  // Grand total
  ensureSpace(56, false);
  doc.setFillColor(6, 95, 70);
  doc.rect(PAGE_MARGIN, y, CONTENT_WIDTH, 30, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.setTextColor(255, 255, 255);
  doc.text("Grand Total (payable)", PAGE_MARGIN + 8, y + 19);
  doc.text(
    `Billed Revenue ${money(totals.revenue)}    Payable Commission ${money(totals.commission)}    Billed Orders ${totals.orders}`,
    rightEdge - 8,
    y + 19,
    { align: "right" },
  );
  y += 34;

  if (totals.unbilledOrders > 0) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(180, 83, 9);
    doc.text(
      `Unbilled (not payable): ${money(totals.unbilledRevenue)} revenue, ${money(totals.unbilledCommission)} commission across ${totals.unbilledOrders} order${totals.unbilledOrders === 1 ? "" : "s"}.`,
      PAGE_MARGIN,
      y + 8,
    );
  }

  // Footers
  const pageCount = doc.getNumberOfPages();
  for (let page = 1; page <= pageCount; page += 1) {
    doc.setPage(page);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(156, 163, 175);
    doc.text(
      "Unbilled orders are listed for reference only and are excluded from payable totals.",
      PAGE_MARGIN,
      pageHeight - 16,
    );
    doc.text(`Page ${page} of ${pageCount}`, rightEdge, pageHeight - 16, { align: "right" });
  }

  return doc;
};

export const downloadCommissionReportPdf = (
  commissions: CommissionPdfDoctor[],
  options: CommissionPdfOptions,
): void => {
  const doc = generateCommissionReportPdf(commissions, options);
  doc.save(`commission-report-${options.dateFrom}-to-${options.dateTo}.pdf`);
};
