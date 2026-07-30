export interface AnalyteInterfaceConversionConfig {
  multiply_by?: number | string | null;
  add_offset?: number | string | null;
  // null/undefined = leave the entered precision alone; 0 = whole number.
  decimal_places?: number | string | null;
  lims_unit?: string | null;
  apply_to_ai_result_entry?: boolean | null;
  apply_to_manual_result_entry?: boolean | null;
  apply_to_quick_result_entry?: boolean | null;
}

export type AnalyteInterfaceConversionSource =
  | "ai"
  | "manual"
  | "quick";

export const getAnalyteInterfaceConfig = (
  config:
    | AnalyteInterfaceConversionConfig
    | AnalyteInterfaceConversionConfig[]
    | null
    | undefined,
): AnalyteInterfaceConversionConfig | null => {
  if (!config) return null;
  if (!Array.isArray(config)) return config;
  return config[0] || null;
};

export const isAnalyteInterfaceConversionEnabled = (
  config: AnalyteInterfaceConversionConfig,
  source: AnalyteInterfaceConversionSource,
): boolean => {
  if (source === "ai") return config.apply_to_ai_result_entry === true;
  if (source === "manual") return config.apply_to_manual_result_entry === true;
  return config.apply_to_quick_result_entry === true;
};

const formatConvertedNumber = (value: number): string =>
  Number(value.toPrecision(15)).toString();

export const applyAnalyteInterfaceConversion = (
  rawValue: string | number | null | undefined,
  config: AnalyteInterfaceConversionConfig | null | undefined,
  source: AnalyteInterfaceConversionSource,
): string => {
  const original = rawValue == null ? "" : String(rawValue);
  if (!config || !isAnalyteInterfaceConversionEnabled(config, source)) return original;

  const normalized = original.replace(/,/g, "").trim();
  if (!normalized) return original;
  const numericValue = Number(normalized);
  if (!Number.isFinite(numericValue)) return original;

  const multiplyBy = Number(config.multiply_by ?? 1);
  const addOffset = Number(config.add_offset ?? 0);
  const safeMultiplyBy = Number.isFinite(multiplyBy) ? multiplyBy : 1;
  const safeAddOffset = Number.isFinite(addOffset) ? addOffset : 0;

  const converted = (numericValue * safeMultiplyBy) + safeAddOffset;

  // Precision is pinned after conversion, matching the analyzer ingest path.
  const decimals = config.decimal_places == null ? null : Number(config.decimal_places);
  if (decimals != null && Number.isInteger(decimals) && decimals >= 0 && decimals <= 6) {
    const fixed = converted.toFixed(decimals);
    return Number(fixed) === 0 ? (0).toFixed(decimals) : fixed;
  }

  return formatConvertedNumber(converted);
};
