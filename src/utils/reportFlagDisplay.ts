/**
 * reportFlagDisplay.ts
 *
 * Decides which flag letters a report is allowed to PRINT.
 *
 * Storing a flag and printing it are two different decisions. The flag engine
 * (flagDetermination.ts) has a fixed vocabulary — '', 'H', 'L', 'H*', 'L*', 'A' —
 * and its verdict is always saved, because the stored flag is what drives the
 * bold/coloured value styling on the report. Printing the letter is gated on the
 * lab's own Result Flag Options (labs.flag_options): a lab that never configured
 * "Abnormal" should not see a stray "A" beside a Positive result, but that result
 * must still come out bold.
 *
 * Keep in sync with the same helpers inlined in
 * supabase/functions/generate-pdf-letterhead/index.ts (Deno cannot import from src).
 */

export interface LabFlagOption {
  value?: string | null;
  label?: string | null;
}

/** Canonical engine verdict → the letter a report would print for it. */
const CANONICAL_SYMBOL: Record<string, string> = {
  high: "H",
  low: "L",
  critical_high: "H*",
  critical_low: "L*",
  critical: "C",
  abnormal: "A",
};

/**
 * Printed instead when the exact code is not configured but a coarser one is.
 * A lab with only H/L still gets "H" on a critical high — dropping the letter
 * entirely would understate the result.
 */
const SYMBOL_FALLBACK: Record<string, string> = {
  "H*": "H",
  "L*": "L",
  C: "",
  A: "",
};

const LEGEND_LABELS: Array<[string, string]> = [
  ["H", "High"],
  ["L", "Low"],
  ["A", "Abnormal"],
  ["H*", "Critical High"],
  ["L*", "Critical Low"],
  ["C", "Critical"],
];

/** Reduce any spelling a lab may have typed into a flag option down to a letter. */
function toFlagSymbol(raw?: string | null): string {
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

/**
 * The set of letters this lab has configured, or null when it has configured
 * none — in which case reports print the engine's full vocabulary, exactly as
 * they did before this gate existed.
 *
 * Options are matched on `value` first and on `label` second, because the
 * Settings screen lets a lab name a flag without typing a code.
 */
export function resolveConfiguredFlagCodes(
  options?: LabFlagOption[] | null,
): Set<string> | null {
  if (!Array.isArray(options) || options.length === 0) return null;
  const codes = new Set<string>();
  for (const opt of options) {
    const code = toFlagSymbol(opt?.value) || toFlagSymbol(opt?.label);
    if (code) codes.add(code);
  }
  // A list that names only "Normal" tells us nothing about letters; treat it as
  // unconfigured rather than silently blanking every flag on the report.
  return codes.size > 0 ? codes : null;
}

/**
 * The letter to print for an engine verdict, or '' to print no letter.
 * Returning '' never changes the value's styling — the caller still applies the
 * canonical class, so an unprintable flag stays bold/coloured.
 */
export function flagSymbolForReport(
  canonical: string,
  allowed: Set<string> | null,
): string {
  const symbol = CANONICAL_SYMBOL[canonical] ?? "";
  if (!symbol) return "";
  if (!allowed) return symbol;
  if (allowed.has(symbol)) return symbol;
  const fallback = SYMBOL_FALLBACK[symbol] ?? "";
  return fallback && allowed.has(fallback) ? fallback : "";
}

/** Legend text covering only the letters this lab can actually print. */
export function flagLegendText(allowed: Set<string> | null, nbsp = true): string {
  const sep = nbsp ? "&nbsp;=&nbsp;" : " = ";
  const gap = nbsp ? " &nbsp; " : "   ";
  return LEGEND_LABELS
    .filter(([code]) => !allowed || allowed.has(code))
    .map(([code, label]) => `${code}${sep}${label}`)
    .join(gap);
}
