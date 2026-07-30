// Result value display precision for rendered reports.
//
// Deno port of src/utils/resultValueFormat.ts — the browser preview
// (buildBasicPreviewHtml) and this edge function must format identically or the
// on-screen preview stops matching the printed PDF. Change them together.
//
// Precision resolution, most specific wins:
//   result_values.decimal_places → lab_analytes.decimal_places
//   → analytes.decimal_places → printOptions.defaultDecimalPlaces → as entered
// The report-context view COALESCEs the first three into one `decimal_places`
// key per analyte, so this module only sees the resolved value.
//
// `0` means round to integer and must stay distinct from null ("inherit").

export const FALLBACK_DECIMAL_PLACES = 2;
// Matches lab_analyte_interface_config.decimal_places so both settings share a range.
export const MAX_DECIMAL_PLACES = 6;

export interface DecimalPrintOptions {
  defaultDecimalPlaces?: number | null;
  padDecimals?: boolean;
  minIntegerDigits?: number | null;
}

// Renderers hold print options as loosely typed jsonb, so accept that shape
// directly rather than forcing a cast at every call site.
export type PrintOptionsLike =
  | DecimalPrintOptions
  | Record<string, unknown>
  | null
  | undefined;

function readDefaultDecimalPlaces(printOptions: PrintOptionsLike): unknown {
  return printOptions ? (printOptions as DecimalPrintOptions).defaultDecimalPlaces : null;
}

function readPadDecimals(printOptions: PrintOptionsLike): boolean {
  return Boolean(printOptions && (printOptions as DecimalPrintOptions).padDecimals);
}

interface FormattableAnalyte {
  value?: unknown;
  decimal_places?: unknown;
  min_integer_digits?: unknown;
  value_type?: unknown;
  is_auto_calculated?: boolean | null;
  is_calculated?: boolean | null;
}

export function normalizeDecimalPlaces(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const parsed = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_DECIMAL_PLACES) {
    return null;
  }
  return parsed;
}

/**
 * Half-up rounding that survives binary-float artifacts. Plain toFixed gets
 * halfway cases wrong — (1.005).toFixed(2) === '1.00', (2.675).toFixed(2) ===
 * '2.67' — because the decimal literal is not exactly representable. Re-parsing
 * the shortest decimal representation with a shifted exponent avoids it.
 */
export function roundHalfUp(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return value;
  const asString = String(value);
  if (asString.includes("e") || asString.includes("E")) {
    const factor = Math.pow(10, decimals);
    return (value < 0 ? -1 : 1) * Math.round(Math.abs(value) * factor) / factor;
  }
  const shifted = Number(`${asString}e${decimals}`);
  if (!Number.isFinite(shifted)) return value;
  const rounded = (shifted < 0 ? -1 : 1) * Math.round(Math.abs(shifted));
  const restored = Number(`${rounded}e${-decimals}`);
  return Number.isFinite(restored) ? restored : value;
}

/**
 * Non-numeric text is always returned untouched — this is what protects
 * '<0.01', '1:160', 'Nil', 'Not Detected'.
 */
export function formatResultValue(
  raw: unknown,
  decimals: number | null,
  pad = false,
): string {
  const asString = String(raw ?? "").trim();
  if (!asString || decimals === null) return asString;

  const numeric = Number(asString.replace(/,/g, ""));
  if (!Number.isFinite(numeric)) return asString;

  const rounded = roundHalfUp(numeric, decimals);
  return pad ? rounded.toFixed(decimals) : String(rounded);
}

function isCalculatedAnalyte(analyte: FormattableAnalyte | null | undefined): boolean {
  return Boolean(analyte?.is_auto_calculated || analyte?.is_calculated);
}

/** Qualitative / semi-quantitative / descriptive analytes are never reformatted. */
export function isNumericAnalyte(analyte: FormattableAnalyte | null | undefined): boolean {
  const valueType = String(analyte?.value_type ?? "").trim().toLowerCase();
  return valueType === "" || valueType === "numeric";
}

/**
 * With nothing configured this returns 2 for calculated values (the rounding
 * reports have always applied) and null for everything else, so manual and
 * analyzer values keep printing exactly as today until a lab opts in.
 */
export function resolveDecimalPlaces(
  analyte: FormattableAnalyte | null | undefined,
  printOptions?: PrintOptionsLike,
): number | null {
  const perAnalyte = normalizeDecimalPlaces(analyte?.decimal_places);
  if (perAnalyte !== null) return perAnalyte;

  const labDefault = normalizeDecimalPlaces(readDefaultDecimalPlaces(printOptions));
  if (labDefault !== null) return labDefault;

  return isCalculatedAnalyte(analyte) ? FALLBACK_DECIMAL_PLACES : null;
}

/** Rounds and pads decimals. Renderers should call formatAnalyteDisplayValue. */
export function formatAnalyteResultValue(
  analyte: FormattableAnalyte | null | undefined,
  printOptions?: PrintOptionsLike,
  rawOverride?: unknown,
): string {
  const raw = rawOverride !== undefined ? rawOverride : analyte?.value;
  if (!isNumericAnalyte(analyte)) return String(raw ?? "").trim();

  return formatResultValue(
    raw,
    resolveDecimalPlaces(analyte, printOptions),
    readPadDecimals(printOptions),
  );
}

// ─── Leading-zero width (fixed-width legacy formats) ─────────────────────────
//
// Minimum digits BEFORE the decimal point. Display only — never written back to
// result_values.value, unlike decimal_places.

export const MAX_INTEGER_WIDTH = 4;

export function normalizeIntegerWidth(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const parsed = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_INTEGER_WIDTH) return null;
  return parsed;
}

export function resolveMinIntegerDigits(
  analyte: FormattableAnalyte | null | undefined,
  printOptions?: PrintOptionsLike,
): number | null {
  const perAnalyte = normalizeIntegerWidth(analyte?.min_integer_digits);
  if (perAnalyte !== null) return perAnalyte;
  return normalizeIntegerWidth(
    printOptions ? (printOptions as DecimalPrintOptions).minIntegerDigits : null,
  );
}

// Plain or thousands-grouped number and nothing else, so titers ("1:160"),
// operators ("<0.01") and text results are never padded.
const PLAIN_NUMBER = /^(-?)(\d[\d,]*)(\.\d+)?$/;

/**
 * Left-pads the integer part with zeros. Must run AFTER thousands grouping:
 * formatIndianNumber parses with parseFloat and would strip the zeros off.
 */
export function padIntegerWidth(display: string, minDigits: number | null): string {
  if (minDigits === null || minDigits <= 1) return display;

  const trimmed = display.trim();
  const match = PLAIN_NUMBER.exec(trimmed);
  if (!match) return display;

  const sign = match[1];
  const integerPart = match[2];
  const decimalPart = match[3] ?? "";
  const digitCount = integerPart.replace(/,/g, "").length;
  if (digitCount >= minDigits) return display;

  return `${sign}${"0".repeat(minDigits - digitCount)}${integerPart}${decimalPart}`;
}

/**
 * The one call every renderer should use: round, group, then pad — in that
 * order, so the leading zeros survive.
 */
export function formatAnalyteDisplayValue(
  analyte: FormattableAnalyte | null | undefined,
  printOptions?: PrintOptionsLike,
  rawOverride?: unknown,
  groupThousands?: (value: string) => string,
): string {
  const rounded = formatAnalyteResultValue(analyte, printOptions, rawOverride);
  const grouped = groupThousands ? groupThousands(rounded) : rounded;
  // Qualitative/semi-quantitative/descriptive analytes are never reformatted,
  // even when the stored text happens to parse as a number.
  if (!isNumericAnalyte(analyte)) return grouped;
  return padIntegerWidth(grouped, resolveMinIntegerDigits(analyte, printOptions));
}
