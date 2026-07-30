/**
 * Result value display precision — single source of truth for how many digits
 * appear after the decimal point on reports.
 *
 * Precision is resolved per analyte, most specific wins:
 *   result_values.decimal_places   (per-result override, rare)
 *   → lab_analytes.decimal_places  (lab-level, set in the analyte editor)
 *   → analytes.decimal_places      (global master default)
 *   → printOptions.defaultDecimalPlaces  (lab-wide, set in the Basic template builder)
 *   → null = print the value exactly as entered
 *
 * The DB COALESCEs the first three into a single `decimal_places` key on each
 * analyte in the report context, so this module only sees the resolved value.
 *
 * `0` means **round to integer** (e.g. Platelet 150.4 → 150) and must stay
 * distinct from `null`/absent, which means "inherit". Never coerce a blank
 * form field to 0.
 *
 * Keep in step with supabase/functions/generate-pdf-letterhead/resultValueFormat.ts
 * — change them together.
 */

/** Decimals applied to calculated (*cal) values when nothing else is configured. */
export const FALLBACK_DECIMAL_PLACES = 2;
/**
 * Validation ceiling, matching the CHECK constraint and
 * lab_analyte_interface_config.decimal_places. The dropdowns only offer 0-4,
 * which is all that is clinically meaningful on a printed report.
 */
export const MAX_DECIMAL_PLACES = 6;

export interface DecimalPrintOptions {
  defaultDecimalPlaces?: number | null;
  padDecimals?: boolean;
  minIntegerDigits?: number | null;
}

/**
 * Callers hold print options as loosely typed jsonb (`Record<string, unknown>`),
 * so accept that shape directly rather than forcing a cast at every call site.
 */
export type PrintOptionsLike = DecimalPrintOptions | Record<string, unknown> | null | undefined;

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

/**
 * Accepts only a whole number in 0..MAX_DECIMAL_PLACES. Anything else —
 * null, undefined, '', a float, out of range — becomes null ("inherit").
 */
export function normalizeDecimalPlaces(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const parsed = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_DECIMAL_PLACES) return null;
  return parsed;
}

/**
 * Half-up rounding that survives binary-float artifacts.
 *
 * Plain `toFixed` gets the halfway cases wrong because the decimal literal is
 * not exactly representable: (1.005).toFixed(2) === '1.00', (2.675).toFixed(2)
 * === '2.67'. Re-parsing the shortest decimal representation with a shifted
 * exponent sidesteps that: '1.005' + 'e2' parses to exactly 100.5, which rounds
 * to 101, then shifts back to 1.01.
 */
export function roundHalfUp(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return value;
  const asString = String(value);
  if (asString.includes('e') || asString.includes('E')) {
    // Exponential notation (very large/small magnitudes) — no lab result lands
    // here, so plain arithmetic is good enough.
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
 * Formats one raw stored value. Non-numeric text is always returned untouched,
 * which is what protects '<0.01', '1:160', 'Nil', 'Not Detected'.
 *
 * @param decimals null = leave the value exactly as entered.
 * @param pad      true = keep trailing zeros (12.3 → '12.30'); false = trim (12.30 → '12.3').
 */
export function formatResultValue(
  raw: unknown,
  decimals: number | null,
  pad = false,
): string {
  const asString = String(raw ?? '').trim();
  if (!asString || decimals === null) return asString;

  const numeric = Number(asString.replace(/,/g, ''));
  if (!Number.isFinite(numeric)) return asString;

  const rounded = roundHalfUp(numeric, decimals);
  return pad ? rounded.toFixed(decimals) : String(rounded);
}

function isCalculatedAnalyte(analyte: FormattableAnalyte | null | undefined): boolean {
  return Boolean(analyte?.is_auto_calculated || analyte?.is_calculated);
}

/**
 * True when the analyte's value is a number we may reformat. Qualitative,
 * semi-quantitative and descriptive analytes are never touched, even if the
 * technician happened to type something numeric.
 */
export function isNumericAnalyte(analyte: FormattableAnalyte | null | undefined): boolean {
  const valueType = String(analyte?.value_type ?? '').trim().toLowerCase();
  return valueType === '' || valueType === 'numeric';
}

/**
 * Decimals to apply to this analyte, or null to print it as entered.
 *
 * With nothing configured this returns 2 for calculated values (matching the
 * hardcoded rounding reports have always applied) and null for everything else,
 * so manually entered and analyzer values keep printing byte-for-byte as today
 * until a lab opts in.
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

/**
 * Rounds and pads decimals. Renderers should call formatAnalyteDisplayValue
 * instead, which also applies leading-zero width in the correct order.
 */
export function formatAnalyteResultValue(
  analyte: FormattableAnalyte | null | undefined,
  printOptions?: PrintOptionsLike,
  rawOverride?: unknown,
): string {
  const raw = rawOverride !== undefined ? rawOverride : analyte?.value;
  if (!isNumericAnalyte(analyte)) return String(raw ?? '').trim();

  return formatResultValue(
    raw,
    resolveDecimalPlaces(analyte, printOptions),
    readPadDecimals(printOptions),
  );
}

// ─── Leading-zero width (fixed-width legacy formats) ─────────────────────────
//
// Minimum digits BEFORE the decimal point, e.g. 3 -> "03" at width 2. Purely
// cosmetic: unlike decimal_places this is never written back to
// result_values.value, because "03" in the database would read as a formatting
// bug in the entry console, trend graphs, delta checks and analyzer exports.

/** Accepts a whole number 0..MAX_INTEGER_WIDTH; anything else means "off". */
export const MAX_INTEGER_WIDTH = 4;

export function normalizeIntegerWidth(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const parsed = typeof raw === 'number' ? raw : Number(raw);
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

/**
 * Matches a plain or thousands-grouped number and nothing else, so titers
 * ("1:160"), operators ("<0.01") and text results are never padded.
 */
const PLAIN_NUMBER = /^(-?)(\d[\d,]*)(\.\d+)?$/;

/**
 * Left-pads the integer part with zeros. Must run AFTER any thousands
 * grouping: formatIndianNumber parses with parseFloat and would strip the
 * zeros back off. Values that already reach the width are returned unchanged,
 * which is why a grouped number (>= 4 digits) is never touched.
 */
export function padIntegerWidth(display: string, minDigits: number | null): string {
  if (minDigits === null || minDigits <= 1) return display;

  const trimmed = display.trim();
  const match = PLAIN_NUMBER.exec(trimmed);
  if (!match) return display;

  const [, sign, integerPart, decimalPart = ''] = match;
  const digitCount = integerPart.replace(/,/g, '').length;
  if (digitCount >= minDigits) return display;

  return `${sign}${'0'.repeat(minDigits - digitCount)}${integerPart}${decimalPart}`;
}

/**
 * The one call every report renderer should use. Rounds, applies thousands
 * grouping if the renderer supplies a grouper, then pads to the configured
 * width — in that order, so the zeros survive.
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

/** Dropdown choices for the analyte editor. '' = inherit, '0' = integer. */
export const DECIMAL_PLACES_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'Lab default' },
  { value: '0', label: '0 — Integer (150)' },
  { value: '1', label: '1 — 0.0' },
  { value: '2', label: '2 — 0.00' },
  { value: '3', label: '3 — 0.000' },
  { value: '4', label: '4 — 0.0000' },
];

/** Dropdown choices for leading-zero width. '' = inherit lab default. */
export const INTEGER_WIDTH_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'Lab default' },
  { value: '0', label: 'Off — no leading zeros (3)' },
  { value: '2', label: '2 digits (03)' },
  { value: '3', label: '3 digits (003)' },
  { value: '4', label: '4 digits (0003)' },
];
