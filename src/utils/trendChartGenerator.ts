/**
 * trendChartGenerator.ts
 *
 * Generates trend charts as PNG images for inclusion in PDF reports.
 * Uses Recharts for rendering and converts to image via canvas.
 * Supports both image output (for E-Copy/WhatsApp) and data-only output (for Print PDF).
 */

import { supabase } from "./supabase";
import {
  buildTrendChartSvg,
  formatTrendAxisDate,
  formatTrendAxisTime,
  getTrendPointColor as getSharedPointColor,
  type TrendSvgPoint,
} from "./trendChartSvg";

// ============ Types ============

const isHighFlag = (flag: string | null | undefined) =>
  flag &&
  ["h", "high", "critical_h", "critical_high"].includes(flag.toLowerCase());
const isLowFlag = (flag: string | null | undefined) =>
  flag &&
  ["l", "low", "critical_l", "critical_low"].includes(flag.toLowerCase());
const isCriticalFlag = (flag: string | null | undefined) =>
  flag &&
  (flag.toLowerCase() === "c" || flag.toLowerCase().includes("critical"));

const getPointStatus = (
  value: number,
  flag: string | null | undefined,
  referenceRange: ReferenceRangeBounds,
): "high" | "low" | "normal" => {
  if (isHighFlag(flag) || isCriticalFlag(flag)) return "high";
  if (isLowFlag(flag)) return "low";
  if (referenceRange.max !== null && value > referenceRange.max) return "high";
  if (referenceRange.min !== null && value < referenceRange.min) return "low";
  return "normal";
};

const getPointColor = (status: "high" | "low" | "normal") =>
  getSharedPointColor(status);

export interface TrendDataPoint {
  order_date: string;
  value: string | number;
  unit?: string;
  reference_range?: string;
  flag?: string | null;
}

export interface TrendChartResult {
  analyte_name: string;
  image_url: string | null; // PNG URL for E-Copy PDF
  image_base64: string | null; // Base64 for inline embedding
  data: TrendDataPoint[]; // Raw data for Print PDF table
  reference_range?: string;
  unit?: string;
  generated_at: string;
}

export interface TrendChartOptions {
  width?: number;
  height?: number;
  backgroundColor?: string;
  lineColor?: string;
  showReferenceRange?: boolean;
  maxDataPoints?: number;
}

const DEFAULT_OPTIONS: TrendChartOptions = {
  width: 500,
  height: 250,
  backgroundColor: "#ffffff",
  lineColor: "#2563eb",
  showReferenceRange: true,
  maxDataPoints: 10,
};

const escapeHtml = (value: string | number | null | undefined): string =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const formatTrendDateTime = (value: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return escapeHtml(value);

  return date.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
};

const getTrendImageSrc = (trend: TrendChartResult): string | null =>
  trend.image_base64 || trend.image_url || null;

// ============ Trend Data Fetching ============

/**
 * Fetch historical trend data for a specific analyte from a patient
 */
export const fetchTrendData = async (
  patientId: string,
  parameter: string,
  maxRecords: number = 10,
): Promise<TrendDataPoint[]> => {
  try {
    // 1. Get analyte_id for the parameter name
    const { data: analyteInfo } = await supabase
      .from("analytes")
      .select("id")
      .eq("name", parameter)
      .maybeSingle();

    let query = supabase
      .from("view_patient_history")
      .select("result_date, value, unit, reference_range, source")
      .eq("patient_id", patientId)
      .order("result_date", { ascending: false })
      .limit(maxRecords);

    if (analyteInfo) {
      query = query.eq("analyte_id", analyteInfo.id);
    } else {
      // Fallback matching by name using join if ID not found directly
      const { data: nameMatchData } = await supabase
        .from("view_patient_history")
        .select(`
          result_date, 
          value, 
          unit, 
          reference_range, 
          source,
          analytes!inner (name)
        `)
        .eq("patient_id", patientId)
        .eq("analytes.name", parameter)
        .order("result_date", { ascending: false })
        .limit(maxRecords);

      if (nameMatchData && nameMatchData.length > 0) {
        const trendData = nameMatchData.map((row: any) => ({
          order_date: row.result_date,
          value: row.value,
          unit: row.unit,
          reference_range: row.reference_range,
          flag: null, // View doesn't have flags
        }));
        return trendData.reverse();
      }

      // Final fallback to legacy view for internal data only
      const { data: legacyData } = await supabase
        .from("v_report_template_context")
        .select("order_date, analytes")
        .eq("patient_id", patientId)
        .order("order_date", { ascending: false })
        .limit(maxRecords);

      const trendData = legacyData?.flatMap((row: any) => {
        const analytes = row.analytes || [];
        return analytes
          .filter((a: any) => a.parameter === parameter)
          .map((a: any) => ({
            order_date: row.order_date,
            value: a.value,
            unit: a.unit,
            reference_range: a.reference_range,
            flag: a.flag,
          }));
      }) || [];
      return trendData.reverse();
    }

    const { data, error } = await query;

    if (error) {
      console.error("Error fetching trend data:", error);
      return [];
    }

    const trendData = (data || []).map((row: any) => ({
      order_date: row.result_date,
      value: row.value,
      unit: row.unit,
      reference_range: row.reference_range,
      flag: null,
    }));

    // Reverse to show oldest first (left to right on chart)
    return trendData.reverse();
  } catch (error) {
    console.error("Error in fetchTrendData:", error);
    return [];
  }
};

// ============ Reference Range Parsing ============

interface ReferenceRangeBounds {
  min: number | null;
  max: number | null;
}

/**
 * Parse reference range string into min/max bounds
 * Handles formats: "10-20", "<20", ">10", "10 - 20", "< 10.0"
 */
export const parseReferenceRange = (
  rangeStr?: string,
): ReferenceRangeBounds => {
  if (!rangeStr) return { min: null, max: null };

  const normalized = rangeStr.trim().toLowerCase();

  // Format: "10-20" or "10 - 20"
  const rangeMatch = normalized.match(/^([\d.]+)\s*[-–]\s*([\d.]+)$/);
  if (rangeMatch) {
    return {
      min: parseFloat(rangeMatch[1]),
      max: parseFloat(rangeMatch[2]),
    };
  }

  // Format: "<20" or "< 20"
  const lessThanMatch = normalized.match(/^<\s*([\d.]+)$/);
  if (lessThanMatch) {
    return {
      min: null,
      max: parseFloat(lessThanMatch[1]),
    };
  }

  // Format: ">10" or "> 10"
  const greaterThanMatch = normalized.match(/^>\s*([\d.]+)$/);
  if (greaterThanMatch) {
    return {
      min: parseFloat(greaterThanMatch[1]),
      max: null,
    };
  }

  return { min: null, max: null };
};

// ============ SVG Chart Generation ============

/**
 * Convert report trend rows into the shared chart point format
 */
export const toTrendSvgPoints = (
  data: TrendDataPoint[],
  fallbackReferenceRange?: string,
  fallbackUnit?: string,
): TrendSvgPoint[] =>
  (data || [])
    .map((d) => {
      const numericValue = parseFloat(String(d.value));
      if (!Number.isFinite(numericValue)) return null;

      const refRange = parseReferenceRange(
        d.reference_range || fallbackReferenceRange,
      );
      const status = getPointStatus(numericValue, d.flag, refRange);
      const unit = d.unit || fallbackUnit || "";
      const label = formatTrendAxisDate(d.order_date);
      const time = formatTrendAxisTime(d.order_date);

      return {
        label,
        value: numericValue,
        status,
        tooltip: `${label}${time ? ` ${time}` : ""}: ${numericValue}${
          unit ? ` ${unit}` : ""
        }`,
      } as TrendSvgPoint;
    })
    .filter((point): point is TrendSvgPoint => point !== null);

/**
 * Generate the "Previous History" line chart for trend data as an SVG string.
 * Shares its renderer with the Result Verification UI so screen and PDF match.
 */
export const generateTrendSVG = (
  data: TrendDataPoint[],
  options: TrendChartOptions = {},
): string => {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const points = toTrendSvgPoints(data);
  const refRange = parseReferenceRange(data?.[0]?.reference_range);

  return buildTrendChartSvg(points, {
    width: opts.width,
    height: opts.height,
    unit: data?.[0]?.unit,
    refMin: refRange.min,
    refMax: refRange.max,
    showReferenceRange: opts.showReferenceRange,
    background: opts.backgroundColor === "transparent"
      ? "#ffffff"
      : opts.backgroundColor,
    lineColor: opts.lineColor,
  });
};

// ============ Image Generation & Storage ============

/**
 * Convert SVG to PNG blob using canvas
 */
export const svgToPngBlob = async (
  svgString: string,
  width: number,
  height: number,
): Promise<Blob | null> => {
  return new Promise((resolve) => {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = width * 2; // 2x for retina
      canvas.height = height * 2;
      const ctx = canvas.getContext("2d");

      if (!ctx) {
        console.error("Could not get canvas context");
        resolve(null);
        return;
      }

      // Scale for retina
      ctx.scale(2, 2);

      // Create image from SVG
      const img = new Image();
      const svgBlob = new Blob([svgString], {
        type: "image/svg+xml;charset=utf-8",
      });
      const url = URL.createObjectURL(svgBlob);

      img.onload = () => {
        // Fill white background for PNG
        ctx.fillStyle = "white";
        ctx.fillRect(0, 0, width, height);

        ctx.drawImage(img, 0, 0, width, height);
        URL.revokeObjectURL(url);

        canvas.toBlob(
          (blob) => {
            resolve(blob);
          },
          "image/png",
          0.95,
        );
      };

      img.onerror = (e) => {
        console.error("Error loading SVG for conversion:", e);
        URL.revokeObjectURL(url);
        resolve(null);
      };

      img.src = url;
    } catch (error) {
      console.error("Error converting SVG to PNG:", error);
      resolve(null);
    }
  });
};

/**
 * Convert blob to base64 data URL
 */
export const blobToBase64 = (blob: Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
};

/**
 * Upload chart image to Supabase storage
 */
export const uploadChartImage = async (
  blob: Blob,
  orderId: string,
  analyteName: string,
): Promise<string | null> => {
  try {
    const safeAnalyteName = analyteName.replace(/[^a-zA-Z0-9]/g, "_")
      .toLowerCase();
    const timestamp = Date.now();
    const filePath =
      `reports/${orderId}/trends/${safeAnalyteName}_${timestamp}.png`;

    const { error: uploadError } = await supabase.storage
      .from("attachments")
      .upload(filePath, blob, {
        contentType: "image/png",
        upsert: true,
      });

    if (uploadError) {
      console.error("Error uploading chart image:", uploadError);
      return null;
    }

    const { data: { publicUrl } } = supabase.storage
      .from("attachments")
      .getPublicUrl(filePath);

    return publicUrl;
  } catch (error) {
    console.error("Error in uploadChartImage:", error);
    return null;
  }
};

// ============ Main Generation Function ============

/**
 * Generate a complete trend chart result for an analyte
 * Returns both image URL and raw data for hybrid rendering
 */
export const generateTrendChart = async (
  patientId: string,
  analyteName: string,
  orderId: string,
  options: TrendChartOptions = {},
): Promise<TrendChartResult> => {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  // Fetch trend data
  const data = await fetchTrendData(patientId, analyteName, opts.maxDataPoints);

  const result: TrendChartResult = {
    analyte_name: analyteName,
    image_url: null,
    image_base64: null,
    data,
    reference_range: data[0]?.reference_range,
    unit: data[0]?.unit,
    generated_at: new Date().toISOString(),
  };

  if (data.length < 2) {
    // Not enough data points for a meaningful trend
    console.log(
      `Skipping trend chart for ${analyteName}: only ${data.length} data point(s)`,
    );
    return result;
  }

  try {
    // Generate SVG
    const svg = generateTrendSVG(data, opts);

    // Convert to PNG
    const pngBlob = await svgToPngBlob(svg, opts.width!, opts.height!);

    if (pngBlob) {
      // Upload to storage
      const imageUrl = await uploadChartImage(pngBlob, orderId, analyteName);
      result.image_url = imageUrl;

      // Also store base64 for inline embedding
      result.image_base64 = await blobToBase64(pngBlob);
    }
  } catch (error) {
    console.error(`Error generating trend chart for ${analyteName}:`, error);
  }

  return result;
};

/**
 * Generate trend charts for multiple analytes (typically flagged ones)
 */
export const generateTrendChartsForAnalytes = async (
  patientId: string,
  analytes: { name: string; flag?: string | null }[],
  orderId: string,
  options: TrendChartOptions = {},
): Promise<TrendChartResult[]> => {
  const results: TrendChartResult[] = [];

  // Filter to only flagged analytes by default
  const flaggedAnalytes = analytes.filter((a) =>
    a.flag &&
    (isHighFlag(a.flag) || isLowFlag(a.flag) || isCriticalFlag(a.flag) ||
      ["A", "a", "abnormal"].includes(a.flag.toLowerCase()))
  );

  for (const analyte of flaggedAnalytes) {
    const result = await generateTrendChart(
      patientId,
      analyte.name,
      orderId,
      options,
    );
    if (result.data.length >= 2) {
      results.push(result);
    }
  }

  return results;
};

// ============ HTML Generation for Print PDF ============

/**
 * Generate HTML table for trend data (for print PDF without images)
 */
export const generateTrendTableHtml = (
  trendResult: TrendChartResult,
): string => {
  if (!trendResult.data || trendResult.data.length === 0) {
    return "";
  }

  const rows = trendResult.data.map((d, i) => {
    const date = new Date(d.order_date).toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "2-digit",
    });
    const isLatest = i === trendResult.data.length - 1;
    const flagClass = isHighFlag(d.flag)
      ? "color: #dc3545;"
      : isLowFlag(d.flag)
      ? "color: #0066cc;"
      : "";
    const latestBadge = isLatest
      ? ' <span style="background: #3b82f6; color: white; padding: 1px 6px; border-radius: 3px; font-size: 9px;">LATEST</span>'
      : "";

    return `<tr>
      <td style="padding: 4px 8px; border: 1px solid #ddd;">${date}${latestBadge}</td>
      <td style="padding: 4px 8px; border: 1px solid #ddd; font-weight: 600; ${flagClass}">${d.value}</td>
      <td style="padding: 4px 8px; border: 1px solid #ddd;">${
      d.flag || "-"
    }</td>
    </tr>`;
  }).join("");

  return `
    <div style="margin-bottom: 15px;">
      <h4 style="margin: 0 0 8px 0; color: #333; font-size: 13px;">
        ${trendResult.analyte_name} ${
    trendResult.unit ? `(${trendResult.unit})` : ""
  }
        ${
    trendResult.reference_range
      ? `<span style="font-weight: normal; color: #666; font-size: 11px;"> | Ref: ${trendResult.reference_range}</span>`
      : ""
  }
      </h4>
      <table style="border-collapse: collapse; font-size: 11px; width: auto;">
        <thead>
          <tr style="background: #f3f4f6;">
            <th style="padding: 4px 8px; border: 1px solid #ddd; text-align: left;">Date</th>
            <th style="padding: 4px 8px; border: 1px solid #ddd; text-align: left;">Value</th>
            <th style="padding: 4px 8px; border: 1px solid #ddd; text-align: left;">Flag</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
};

/**
 * Generate print-friendly HTML table for trend data (black & white, no backgrounds)
 */
export const generateTrendTableHtmlPrint = (
  trendResult: TrendChartResult,
): string => {
  if (!trendResult.data || trendResult.data.length === 0) {
    return "";
  }

  const rows = trendResult.data.map((d, i) => {
    const date = new Date(d.order_date).toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "2-digit",
    });
    const isLatest = i === trendResult.data.length - 1;
    const flagStyle = d.flag ? "font-weight: bold;" : "";
    const latestMarker = isLatest ? " *" : "";

    return `<tr>
      <td style="padding: 4px 8px; border: 1px solid #333;">${date}${latestMarker}</td>
      <td style="padding: 4px 8px; border: 1px solid #333; font-weight: 600; ${flagStyle}">${d.value}</td>
      <td style="padding: 4px 8px; border: 1px solid #333;">${
      d.flag || "-"
    }</td>
    </tr>`;
  }).join("");

  return `
    <div style="margin-bottom: 15px;">
      <h4 style="margin: 0 0 8px 0; color: #000; font-size: 12px;">
        ${trendResult.analyte_name} ${
    trendResult.unit ? `(${trendResult.unit})` : ""
  }
        ${
    trendResult.reference_range
      ? `<span style="font-weight: normal; font-size: 10px;"> | Ref: ${trendResult.reference_range}</span>`
      : ""
  }
      </h4>
      <table style="border-collapse: collapse; font-size: 10px; width: auto;">
        <thead>
          <tr>
            <th style="padding: 4px 8px; border: 1px solid #333; text-align: left;">Date</th>
            <th style="padding: 4px 8px; border: 1px solid #333; text-align: left;">Value</th>
            <th style="padding: 4px 8px; border: 1px solid #333; text-align: left;">Flag</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="margin: 4px 0 0 0; font-size: 9px; color: #333;">* Latest result</p>
    </div>
  `;
};

const generateCompactTrendHistoryTableHtml = (
  trendResult: TrendChartResult,
): string => {
  if (!trendResult.data || trendResult.data.length === 0) {
    return "";
  }

  const rows = trendResult.data
    .slice()
    .reverse()
    .map((d) => {
      const refRange = parseReferenceRange(d.reference_range || trendResult.reference_range);
      const numericValue = parseFloat(String(d.value));
      const status = Number.isFinite(numericValue)
        ? getPointStatus(numericValue, d.flag, refRange)
        : "normal";
      const valueColor = status === "normal" ? "#111827" : getPointColor(status);

      return `<tr>
        <td style="padding: 3px 6px; border: 1px solid #d1d5db; white-space: nowrap;">${formatTrendDateTime(d.order_date)}</td>
        <td style="padding: 3px 6px; border: 1px solid #d1d5db; text-align: right; font-weight: 600; color: ${valueColor};">${escapeHtml(d.value)}</td>
      </tr>`;
    }).join("");

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
};

const generateTrendCardHtml = (
  trend: TrendChartResult,
  forPrint: boolean,
): string => {
  const imgSrc = getTrendImageSrc(trend);
  const historyTable = generateCompactTrendHistoryTableHtml(trend);

  if (!imgSrc) {
    return forPrint
      ? generateTrendTableHtmlPrint(trend)
      : generateTrendTableHtml(trend);
  }

  const borderColor = forPrint ? "#333" : "#d1d5db";
  const titleColor = forPrint ? "#000" : "#111827";
  const imageFilter = forPrint ? "filter: grayscale(1);" : "";
  const meta = [
    trend.unit ? `Unit: ${escapeHtml(trend.unit)}` : "",
    trend.reference_range ? `Ref: ${escapeHtml(trend.reference_range)}` : "",
  ].filter(Boolean).join(" | ");

  return `
    <div class="trend-chart" style="margin: 10px 0 16px 0; page-break-inside: avoid; break-inside: avoid;">
      <div style="font-size: 12px; font-weight: 700; color: ${titleColor}; text-align: center; margin-bottom: 5px;">
        ${escapeHtml(trend.analyte_name)} Previous History
      </div>
      <div style="display: table; width: 100%; table-layout: fixed; border-collapse: separate; border-spacing: 8px 0;">
        <div style="display: table-cell; width: 62%; vertical-align: top;">
          <img src="${imgSrc}" alt="${escapeHtml(trend.analyte_name)} trend" style="width: 100%; max-width: 100%; height: auto; border: 1px solid ${borderColor}; ${imageFilter}" />
        </div>
        <div style="display: table-cell; width: 38%; vertical-align: top;">
          ${historyTable}
        </div>
      </div>
      ${meta ? `<div style="font-size: 9px; color: #4b5563; text-align: center; margin-top: 4px;">${meta}</div>` : ""}
    </div>
  `;
};

/**
 * Generate complete trend section HTML with either images or tables
 * forPrint: When true, uses black & white styling suitable for printing
 */
export const generateTrendSectionHtml = (
  trends: TrendChartResult[],
  forPrint: boolean = false,
): string => {
  if (!trends || trends.length === 0) {
    return "";
  }

  const content = trends.map((trend) => generateTrendCardHtml(trend, forPrint)).join("");

  // Print version: black & white header, no emoji
  if (forPrint) {
    return `
      <div style="margin-top: 20px;">
        <h3 style="font-size: 14px; color: #000; border-bottom: 1px solid #333; padding-bottom: 6px; margin-bottom: 12px;">
          Previous History
        </h3>
        ${content}
      </div>
    `;
  }

  return `
    <div style="margin-top: 20px;">
      <h3 style="font-size: 16px; color: #1e40af; border-bottom: 2px solid #3b82f6; padding-bottom: 8px; margin-bottom: 15px;">
        Previous History
      </h3>
      ${content}
    </div>
  `;
};

export default {
  fetchTrendData,
  parseReferenceRange,
  generateTrendSVG,
  svgToPngBlob,
  blobToBase64,
  uploadChartImage,
  generateTrendChart,
  generateTrendChartsForAnalytes,
  generateTrendTableHtml,
  generateTrendTableHtmlPrint,
  generateTrendSectionHtml,
};
