/**
 * trendChartSvg.ts
 *
 * Single source of truth for the "Previous History" trend chart.
 * The same SVG is rendered in the Result Verification UI and rasterised to PNG
 * for the report PDF, so the on-screen graph and the printed graph are identical.
 *
 * Style follows the classic lab-report history graph: white plot area, rounded
 * ("nice") Y axis ticks with light gridlines, axis lines on the left/bottom,
 * a blue polyline with circular markers and date labels below.
 */

export type TrendPointStatus = "high" | "low" | "normal";

export interface TrendSvgPoint {
  /** X axis label, e.g. "25 Jun, 25" */
  label: string;
  /** Optional second line under the label (usually the time) */
  sublabel?: string;
  value: number;
  status?: TrendPointStatus;
  /** Native tooltip text (browser only) */
  tooltip?: string;
}

export interface TrendSvgOptions {
  width?: number;
  height?: number;
  unit?: string;
  refMin?: number | null;
  refMax?: number | null;
  showReferenceRange?: boolean;
  /** Print the numeric value above each marker (off by default - the table carries values) */
  showValueLabels?: boolean;
  /** Force (or forbid) a zero baseline - auto-detected when omitted */
  baselineAtZero?: boolean;
  /** Emit width="100%" so the chart scales inside a flexible container */
  responsive?: boolean;
  background?: string;
  lineColor?: string;
}

export const TREND_COLORS = {
  line: "#2563eb",
  normal: "#2563eb",
  high: "#dc2626",
  low: "#f59e0b",
  grid: "#eceff3",
  axis: "#cbd5e1",
  text: "#4b5563",
  /** CSS colour for legend swatches */
  band: "rgba(34, 197, 94, 0.12)",
  /** Solid colour used with fill-opacity inside the SVG */
  bandFill: "#22c55e",
  bandEdge: "#86efac",
} as const;

export const getTrendPointColor = (status?: TrendPointStatus): string => {
  if (status === "high") return TREND_COLORS.high;
  if (status === "low") return TREND_COLORS.low;
  return TREND_COLORS.normal;
};

const FONT_FAMILY = "'Segoe UI', Arial, Helvetica, sans-serif";

const escapeXml = (value: unknown): string =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const isUsableBound = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value) && Math.abs(value) < 1e9;

const NICE_STEPS = [1, 2, 5, 10];

/** Snap a raw step to the closest "human" step (1, 2, 2.5, 5, 10 x 10^n) */
const niceStep = (rawStep: number): number => {
  if (!Number.isFinite(rawStep) || rawStep <= 0) return 1;
  const exponent = Math.floor(Math.log10(rawStep));
  const base = Math.pow(10, exponent);
  const fraction = rawStep / base;
  const best = NICE_STEPS.reduce((closest, candidate) =>
    Math.abs(Math.log(fraction / candidate)) < Math.abs(Math.log(fraction / closest))
      ? candidate
      : closest
  );
  return best * base;
};

/** Next step up in the nice-step sequence */
const nextNiceStep = (step: number): number => {
  const exponent = Math.floor(Math.log10(step));
  const base = Math.pow(10, exponent);
  const fraction = step / base;
  const next = NICE_STEPS.find((candidate) => candidate > fraction + 1e-9);
  return next !== undefined ? next * base : step * 10;
};

const buildTicks = (lo: number, hi: number, step: number): number[] => {
  let start = Math.floor(lo / step) * step;
  const end = Math.ceil(hi / step) * step;

  // Lab values are never negative - keep the baseline at zero like the printed report
  if (lo >= 0 && start < 0) start = 0;

  const ticks: number[] = [];
  for (let value = start; value <= end + step * 1e-6; value += step) {
    ticks.push(Number(value.toFixed(10)));
  }
  return ticks;
};

/**
 * Build a rounded axis scale (0, 20, 40 ... style) covering [min, max].
 */
export const buildAxisScale = (
  min: number,
  max: number,
  targetTicks = 6,
  maxTicks = 9,
): { min: number; max: number; step: number; ticks: number[] } => {
  let lo = Math.min(min, max);
  let hi = Math.max(min, max);

  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = 0;
    hi = 1;
  }

  if (hi === lo) {
    const pad = Math.abs(hi) * 0.1 || 1;
    lo -= pad;
    hi += pad;
  }

  let step = niceStep((hi - lo) / Math.max(1, targetTicks));
  let ticks = buildTicks(lo, hi, step);

  // Coarsen until the axis stays readable
  let guard = 0;
  while (ticks.length > maxTicks && guard++ < 12) {
    step = nextNiceStep(step);
    ticks = buildTicks(lo, hi, step);
  }

  return {
    min: ticks[0] ?? lo,
    max: ticks[ticks.length - 1] ?? hi,
    step,
    ticks,
  };
};

const decimalsForStep = (step: number): number => {
  if (!Number.isFinite(step) || step <= 0) return 0;
  return Math.max(0, Math.min(3, Math.ceil(-Math.log10(step))));
};

const formatTick = (value: number, step: number): string => {
  const decimals = decimalsForStep(step);
  return Number(value.toFixed(decimals)).toString();
};

const formatValue = (value: number): string => {
  const abs = Math.abs(value);
  const decimals = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return Number(value.toFixed(decimals)).toString();
};

const emptyChart = (width: number, height: number, background: string, message: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
  `<rect x="0" y="0" width="${width}" height="${height}" fill="${background}"/>` +
  `<text x="${width / 2}" y="${height / 2}" text-anchor="middle" fill="#94a3b8" ` +
  `font-family="${FONT_FAMILY}" font-size="12">${escapeXml(message)}</text></svg>`;

/**
 * Render the trend chart as a standalone SVG string.
 */
export const buildTrendChartSvg = (
  points: TrendSvgPoint[],
  options: TrendSvgOptions = {},
): string => {
  const width = options.width ?? 500;
  const height = options.height ?? 250;
  const background = options.background ?? "#ffffff";
  const lineColor = options.lineColor ?? TREND_COLORS.line;
  const showReferenceRange = options.showReferenceRange !== false;

  const usablePoints = (points || []).filter((point) =>
    point && Number.isFinite(point.value)
  );

  if (usablePoints.length === 0) {
    return emptyChart(width, height, background, "No trend data available");
  }

  const refMin = showReferenceRange && isUsableBound(options.refMin) ? options.refMin : null;
  const refMax = showReferenceRange && isUsableBound(options.refMax) && options.refMax > 0
    ? options.refMax
    : null;

  const values = usablePoints.map((point) => point.value);
  const boundValues = [...values];
  if (refMin !== null) boundValues.push(refMin);
  if (refMax !== null) boundValues.push(refMax);

  // Printed history graphs sit on a zero baseline unless the values are clustered
  // high up, where a zero baseline would flatten the trend
  const minBound = Math.min(...boundValues);
  const maxBound = Math.max(...boundValues);
  const baselineAtZero = options.baselineAtZero ??
    (minBound >= 0 && maxBound > 0 && minBound <= maxBound * 0.5);

  const scale = buildAxisScale(baselineAtZero ? 0 : minBound, maxBound);

  // Axis geometry - left padding follows the widest tick label
  const tickLabels = scale.ticks.map((tick) => formatTick(tick, scale.step));
  const widestTick = tickLabels.reduce((longest, label) => Math.max(longest, label.length), 1);
  const unitLabel = (options.unit || "").trim();

  const labelFontSize = 9;
  const paddingTop = 14;
  const paddingRight = 16;
  const paddingLeft = (unitLabel ? 14 : 4) + 10 + widestTick * 5.6;

  // Decide label orientation / density before fixing the bottom padding
  const plotWidthHorizontal = width - paddingLeft - paddingRight;
  const widestLabel = usablePoints.reduce(
    (longest, point) => Math.max(longest, point.label.length),
    1,
  );
  const approxLabelWidth = widestLabel * labelFontSize * 0.58 + 8;
  const rotateLabels = approxLabelWidth * usablePoints.length > plotWidthHorizontal;
  const hasSublabels = usablePoints.some((point) => !!point.sublabel);

  const paddingBottom = rotateLabels ? 50 : hasSublabels ? 36 : 28;
  const plotWidth = Math.max(10, width - paddingLeft - paddingRight);
  const plotHeight = Math.max(10, height - paddingTop - paddingBottom);
  const plotLeft = paddingLeft;
  const plotRight = paddingLeft + plotWidth;
  const plotTop = paddingTop;
  const plotBottom = paddingTop + plotHeight;

  const xAt = (index: number) =>
    usablePoints.length === 1
      ? plotLeft + plotWidth / 2
      : plotLeft + (index / (usablePoints.length - 1)) * plotWidth;

  const span = scale.max - scale.min || 1;
  const yAt = (value: number) =>
    plotBottom - ((value - scale.min) / span) * plotHeight;

  const round = (value: number) => Math.round(value * 100) / 100;

  // Gridlines + Y axis labels
  const gridLines = scale.ticks.map((tick, index) => {
    const y = round(yAt(tick));
    const isBaseline = index === 0;
    return (
      `<line x1="${round(plotLeft)}" y1="${y}" x2="${round(plotRight)}" y2="${y}" ` +
      `stroke="${isBaseline ? TREND_COLORS.axis : TREND_COLORS.grid}" stroke-width="1"/>`
    );
  }).join("");

  const yAxisLabels = scale.ticks.map((tick, index) => {
    const y = round(yAt(tick)) + 3;
    return (
      `<text x="${round(plotLeft - 6)}" y="${y}" text-anchor="end" fill="${TREND_COLORS.text}" ` +
      `font-family="${FONT_FAMILY}" font-size="9">${escapeXml(tickLabels[index])}</text>`
    );
  }).join("");

  // Reference range band
  let referenceBand = "";
  if (refMin !== null || refMax !== null) {
    const top = refMax !== null ? yAt(refMax) : plotTop;
    const bottom = refMin !== null ? yAt(refMin) : plotBottom;
    const bandTop = round(Math.min(top, bottom));
    const bandHeight = round(Math.abs(bottom - top));
    if (bandHeight > 0.5) {
      referenceBand =
        `<rect x="${round(plotLeft)}" y="${bandTop}" width="${round(plotWidth)}" height="${bandHeight}" ` +
        `fill="${TREND_COLORS.bandFill}" fill-opacity="0.12"/>`;
      [refMax, refMin].forEach((bound) => {
        if (bound === null) return;
        const y = round(yAt(bound));
        referenceBand +=
          `<line x1="${round(plotLeft)}" y1="${y}" x2="${round(plotRight)}" y2="${y}" ` +
          `stroke="${TREND_COLORS.bandEdge}" stroke-width="1" stroke-dasharray="4,3"/>`;
      });
    }
  }

  const axes =
    `<line x1="${round(plotLeft)}" y1="${round(plotTop)}" x2="${round(plotLeft)}" y2="${round(plotBottom)}" ` +
    `stroke="${TREND_COLORS.axis}" stroke-width="1"/>` +
    `<line x1="${round(plotLeft)}" y1="${round(plotBottom)}" x2="${round(plotRight)}" y2="${round(plotBottom)}" ` +
    `stroke="${TREND_COLORS.axis}" stroke-width="1"/>`;

  const linePath = usablePoints.length > 1
    ? `<path d="${
      usablePoints
        .map((point, index) =>
          `${index === 0 ? "M" : "L"} ${round(xAt(index))} ${round(yAt(point.value))}`
        )
        .join(" ")
    }" fill="none" stroke="${lineColor}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`
    : "";

  const markers = usablePoints.map((point, index) => {
    const cx = round(xAt(index));
    const cy = round(yAt(point.value));
    const color = getTrendPointColor(point.status);
    const tooltip = point.tooltip
      ? `<title>${escapeXml(point.tooltip)}</title>`
      : "";
    return (
      `<g>${tooltip}<circle cx="${cx}" cy="${cy}" r="3.4" fill="${color}" stroke="#ffffff" stroke-width="1.2"/></g>`
    );
  }).join("");

  const valueLabels = options.showValueLabels
    ? usablePoints.map((point, index) => {
      const x = round(xAt(index));
      const y = round(yAt(point.value) - 8);
      const color = point.status && point.status !== "normal"
        ? getTrendPointColor(point.status)
        : "#374151";
      return (
        `<text x="${x}" y="${y}" text-anchor="middle" fill="${color}" ` +
        `font-family="${FONT_FAMILY}" font-size="9" font-weight="600">${
          escapeXml(formatValue(point.value))
        }</text>`
      );
    }).join("")
    : "";

  // X axis labels - thin them out when they cannot all fit
  const slotWidth = rotateLabels ? labelFontSize * 1.7 : approxLabelWidth;
  const maxLabels = Math.max(1, Math.floor(plotWidth / slotWidth));
  const stride = Math.max(1, Math.ceil(usablePoints.length / maxLabels));

  const keptLabels = new Set<number>();
  for (let index = 0; index < usablePoints.length; index += stride) keptLabels.add(index);
  const lastIndex = usablePoints.length - 1;
  if (!keptLabels.has(lastIndex)) {
    const previous = Math.max(...Array.from(keptLabels));
    // Drop the neighbour when the final label would sit on top of it
    if (lastIndex - previous < stride * 0.6) keptLabels.delete(previous);
    keptLabels.add(lastIndex);
  }

  const xAxisLabels = usablePoints.map((point, index) => {
    if (!keptLabels.has(index)) return "";

    const x = round(xAt(index));
    const y = plotBottom + 14;

    if (rotateLabels) {
      return (
        `<text x="${x}" y="${y}" text-anchor="end" fill="${TREND_COLORS.text}" ` +
        `font-family="${FONT_FAMILY}" font-size="${labelFontSize}" ` +
        `transform="rotate(-40 ${x} ${y})">${escapeXml(point.label)}</text>`
      );
    }

    const primary =
      `<text x="${x}" y="${y}" text-anchor="middle" fill="${TREND_COLORS.text}" ` +
      `font-family="${FONT_FAMILY}" font-size="${labelFontSize}">${escapeXml(point.label)}</text>`;

    const secondary = point.sublabel
      ? `<text x="${x}" y="${y + 11}" text-anchor="middle" fill="#9ca3af" ` +
        `font-family="${FONT_FAMILY}" font-size="8">${escapeXml(point.sublabel)}</text>`
      : "";

    return primary + secondary;
  }).join("");

  const unitTitle = unitLabel
    ? `<text x="10" y="${round(plotTop + plotHeight / 2)}" text-anchor="middle" ` +
      `fill="${TREND_COLORS.text}" font-family="${FONT_FAMILY}" font-size="9" ` +
      `transform="rotate(-90 10 ${round(plotTop + plotHeight / 2)})">${escapeXml(unitLabel)}</text>`
    : "";

  const sizeAttrs = options.responsive
    ? `width="100%" height="100%" preserveAspectRatio="xMidYMid meet"`
    : `width="${width}" height="${height}"`;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" ${sizeAttrs} viewBox="0 0 ${width} ${height}" ` +
    `font-family="${FONT_FAMILY}">` +
    `<rect x="0" y="0" width="${width}" height="${height}" fill="${background}"/>` +
    referenceBand +
    gridLines +
    axes +
    linePath +
    markers +
    valueLabels +
    yAxisLabels +
    xAxisLabels +
    unitTitle +
    `</svg>`
  );
};

/** "25 Jun, 25" - the date format used on the printed history graph */
export const formatTrendAxisDate = (value: string | Date): string => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value ?? "");
  const day = String(date.getDate()).padStart(2, "0");
  const month = date.toLocaleDateString("en-GB", { month: "short" });
  const year = String(date.getFullYear()).slice(-2);
  return `${day} ${month}, ${year}`;
};

/** "11:00 AM" */
export const formatTrendAxisTime = (value: string | Date): string => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
};

export default {
  buildTrendChartSvg,
  buildAxisScale,
  getTrendPointColor,
  formatTrendAxisDate,
  formatTrendAxisTime,
  TREND_COLORS,
};
