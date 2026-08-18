import { createClient } from "@supabase/supabase-js";
import {
  generateOrderQRCodeData,
  generateOrderSampleId,
  getOrderAssignedColor,
} from "./colorAssignment";
import {
  autoAssignCompactPages,
  buildCompactGroupDefinitions,
} from "./compactPrintPdf";
import { notificationTriggerService } from "./notificationTriggerService";
import { optimizeBatch, smartOptimizeImage } from "./imageOptimizer";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error("Missing Supabase environment variables");
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

const normalizeSampleType = (value: unknown): string =>
  String(value || "").trim().toLowerCase();

const buildSampleAwareLabAnalyteMap = (
  rows: Array<{ id: string; analyte_id: string; sample_type?: string | null; created_at?: string | null }> | null | undefined,
  sampleType?: unknown,
): Record<string, string> => {
  const wanted = normalizeSampleType(sampleType);
  const map: Record<string, string> = {};
  const generic: Record<string, string> = {};

  for (const row of rows || []) {
    const rowSampleType = normalizeSampleType(row.sample_type);
    if (wanted && rowSampleType === wanted && !map[row.analyte_id]) {
      map[row.analyte_id] = row.id;
      continue;
    }

    if (!rowSampleType && !generic[row.analyte_id]) {
      generic[row.analyte_id] = row.id;
    }
  }

  if (!wanted) {
    for (const [analyteId, labAnalyteId] of Object.entries(generic)) {
      if (!map[analyteId]) map[analyteId] = labAnalyteId;
    }
  }

  return map;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID_RE.test(value);

const isSampleIdConflictError = (error: any) =>
  error?.code === "23505" &&
  String(error?.message || error?.details || "").includes("unique_sample_id_per_lab");

const getDailySequenceFromOrder = (order: any): number => {
  if (typeof order?.order_number === "number" && Number.isFinite(order.order_number)) {
    return order.order_number;
  }

  const tail = String(order?.sample_id || "").match(/(?:^|[/-])(\d+)\s*$/)?.[1] || "";
  const parsed = parseInt(tail, 10);
  return Number.isFinite(parsed) ? parsed : 0;
};

// Sorts package_test_groups rows by the package-level display_order the user set
// in the package editor. Rows predating that column fall back to test group name.
export const sortPackageTestGroups = <T extends any[]>(rows: T): T => {
  if (!Array.isArray(rows)) return rows;
  return [...rows].sort((a: any, b: any) => {
    const ao = Number.isFinite(Number(a?.display_order))
      ? Number(a.display_order)
      : Number.MAX_SAFE_INTEGER;
    const bo = Number.isFinite(Number(b?.display_order))
      ? Number(b.display_order)
      : Number.MAX_SAFE_INTEGER;
    if (ao !== bo) return ao - bo;
    return String(a?.test_groups?.name || "").localeCompare(
      String(b?.test_groups?.name || ""),
    );
  }) as T;
};

// Strips package_test_groups rows whose test group has since been deactivated,
// then applies the package's own display order.
// The package editor only lists active groups, so a deactivated link is
// invisible there yet would still be re-saved and expanded into new orders.
const dropInactivePackageLinks = <T,>(pkg: T): T => {
  const clean = (p: any) => {
    if (!p || !Array.isArray(p.package_test_groups)) return p;
    return {
      ...p,
      package_test_groups: sortPackageTestGroups(
        p.package_test_groups.filter(
          (ptg: any) => ptg?.test_groups && ptg.test_groups.is_active !== false,
        ),
      ),
    };
  };
  return (Array.isArray(pkg) ? pkg.map(clean) : clean(pkg)) as T;
};

const normalizeActiveReportPriority = (priority: unknown): number => {
  const numeric = Number(priority);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : Number.MAX_SAFE_INTEGER;
};

const autoSaveCompactPlannerForOrder = async (
  orderId: string,
  labId?: string | null,
  pdfLayoutSettings?: Record<string, any> | null,
) => {
  try {
    if (!isUuid(orderId)) return;

    const { data: orderRow, error: orderError } = await supabase
      .from("orders")
      .select("report_settings")
      .eq("id", orderId)
      .maybeSingle();

    if (orderError) {
      console.warn("Auto compact planner: failed to fetch order settings", orderError);
      return;
    }

    const currentSettings = ((orderRow as any)?.report_settings || {}) as Record<string, any>;
    if (
      currentSettings.groupOrderManualOverride === true ||
      currentSettings.compactPageAssignmentsManualOverride === true
    ) {
      console.log(`Auto compact planner skipped for order ${orderId}: manual planner exists`);
      return;
    }

    let effectivePdfSettings = pdfLayoutSettings || null;
    if (!effectivePdfSettings && labId) {
      const { data: lab } = await supabase
        .from("labs")
        .select("pdf_layout_settings")
        .eq("id", labId)
        .maybeSingle();
      effectivePdfSettings = ((lab as any)?.pdf_layout_settings || null) as Record<string, any> | null;
    }

    const compactPrint = (effectivePdfSettings?.compactPrint || {}) as Record<string, any>;
    const maxClubbedAnalytes = Math.max(
      1,
      Number(
        currentSettings.compactMaxClubbedAnalytes ||
          compactPrint.maxClubbedAnalytes ||
          compactPrint.maxClusterAnalytes ||
          5,
      ) || 5,
    );

    const { data: context, error: contextError } = await database.reports.getTemplateContext(orderId);
    if (contextError || !context) {
      console.warn("Auto compact planner: failed to load report context", contextError);
      return;
    }

    const [{ data: orderTestGroupRows }, { data: orderTestRows }] = await Promise.all([
      supabase
        .from("order_test_groups")
        .select("test_group_id, test_name, print_order, created_at, test_groups(report_priority)")
        .eq("order_id", orderId),
      supabase
        .from("order_tests")
        .select("test_group_id, test_name, print_order, created_at, test_groups(report_priority)")
        .eq("order_id", orderId)
        .neq("is_canceled", true),
    ]);

    const descriptorMap = new Map<string, {
      testGroupId: string;
      testName: string;
      reportPriority: number | null;
      printOrder: number;
      createdAt?: string | null;
    }>();

    const pushDescriptor = (row: any) => {
      if (!row?.test_group_id || descriptorMap.has(row.test_group_id)) return;
      const testGroup = Array.isArray(row.test_groups) ? row.test_groups[0] : row.test_groups;
      const priority = Number(testGroup?.report_priority);
      descriptorMap.set(row.test_group_id, {
        testGroupId: row.test_group_id,
        testName: row.test_name || "Test Results",
        reportPriority: Number.isFinite(priority) ? priority : null,
        printOrder: Number(row.print_order ?? 0),
        createdAt: row.created_at || null,
      });
    };

    (orderTestGroupRows || []).forEach(pushDescriptor);
    (orderTestRows || []).forEach(pushDescriptor);

    for (const groupId of context.testGroupIds || []) {
      if (!groupId || descriptorMap.has(groupId)) continue;
      descriptorMap.set(groupId, {
        testGroupId: groupId,
        testName: "Test Results",
        reportPriority: null,
        printOrder: 999,
        createdAt: null,
      });
    }

    const orderedGroups = [...descriptorMap.values()].sort((a, b) => {
      const aPriority = normalizeActiveReportPriority(a.reportPriority);
      const bPriority = normalizeActiveReportPriority(b.reportPriority);
      if (aPriority !== bPriority) return aPriority - bPriority;
      if (a.printOrder !== b.printOrder) return a.printOrder - b.printOrder;
      return a.testName.localeCompare(b.testName);
    });

    const orderedGroupIds = orderedGroups.map((group) => group.testGroupId);
    const compactGroups = buildCompactGroupDefinitions(context, orderedGroupIds);
    const compactPageAssignments = autoAssignCompactPages(compactGroups, maxClubbedAnalytes);
    const now = new Date().toISOString();

    await supabase
      .from("orders")
      .update({
        report_settings: {
          ...currentSettings,
          ...(currentSettings.printLayoutMode || compactPrint.defaultMode === "compact"
            ? { printLayoutMode: currentSettings.printLayoutMode || "compact" }
            : {}),
          groupOrder: orderedGroupIds,
          groupOrderManualOverride: false,
          compactPageAssignments,
          compactPageAssignmentsManualOverride: false,
          compactPageAssignmentsAutoGenerated: true,
          compactPlannerGeneratedAt: now,
          compactMaxClubbedAnalytes: maxClubbedAnalytes,
        },
        updated_at: now,
      })
      .eq("id", orderId);

    console.log(`✅ Auto compact planner saved for order ${orderId}`, {
      groups: orderedGroupIds.length,
      pages: new Set(Object.values(compactPageAssignments)).size,
    });
  } catch (error) {
    console.warn("Auto compact planner failed:", error);
  }
};

export interface ReportTemplateContextMeta {
  orderNumber: string;
  orderDate: string | null;
  reportDate: string | null;
  status: string;
  totalAmount: number | null;
  createdAt: string | null;
  allAnalytesApproved: boolean | null;
}

export interface ReportTemplatePatient {
  name: string;
  displayId: string;
  age: number | null;
  gender: string;
  phone: string;
  dateOfBirth: string | null;
  registrationDate: string | null;
}

export interface ReportTemplateOrder {
  sampleCollectedAt: string | null;
  sampleCollectedBy: string;
  sampleId: string;
  locationId: string;
  locationName: string;
  referringDoctorId: string;
  referringDoctorName: string;
  approvedAt: string | null;
}

export interface ReportTemplateAnalyteRow {
  result_id?: string;
  analyte_id?: string;
  parameter?: string;
  value?: string;
  unit?: string;
  method?: string;
  reference_range?: string;
  reference_range_male?: string;
  reference_range_female?: string;
  low_critical?: string;
  high_critical?: string;
  flag?: string;
  flag_source?: string;
  flag_confidence?: number;
  ai_interpretation?: string;
  ai_audit_status?: string;
  verify_status?: string;
  test_name?: string;
  test_group_id?: string;
  value_type?: string;
  expected_normal_values?: string[];
  is_auto_calculated?: boolean;
  is_calculated?: boolean;
}

export interface ReportTemplateContext {
  orderId: string;
  patientId: string | null;
  labId: string | null;
  meta: ReportTemplateContextMeta;
  patient: ReportTemplatePatient;
  order: ReportTemplateOrder;
  analytes: ReportTemplateAnalyteRow[];
  analyteParameters: string[];
  testGroupIds: string[];
  placeholderValues: Record<string, string | number | boolean | null>;
  sectionContent?: Record<string, string>; // Doctor-filled section content (findings, interpretations, etc.)
  labBranding?: ReportTemplateLabBranding;
}

export interface ReportTemplateLabBranding {
  defaultHeaderHtml?: string | null;
  defaultFooterHtml?: string | null;
}

// Branding & Signature System Interfaces
export interface LabBrandingAsset {
  id: string;
  lab_id: string;
  asset_type: "header" | "footer" | "watermark" | "logo" | "letterhead";
  asset_name: string;
  file_url: string;
  file_path: string;
  file_type: string;
  file_size?: number;
  dimensions?: { width: number; height: number };
  variants?: Record<string, string> | null;
  imagekit_url?: string | null;
  imagekit_file_id?: string | null;
  is_active: boolean;
  is_default: boolean;
  description?: string;
  usage_context?: string[];
  created_by?: string;
  updated_by?: string;
  created_at: string;
  updated_at: string;
}

export interface LabUserSignature {
  id: string;
  lab_id: string;
  user_id: string;
  signature_type: "digital" | "handwritten" | "stamp" | "text";
  signature_name: string;
  file_url?: string;
  file_path?: string;
  file_type?: string;
  file_size?: number;
  dimensions?: { width: number; height: number };
  variants?: Record<string, string> | null;
  imagekit_url?: string | null;
  imagekit_file_id?: string | null;
  text_signature?: string;
  signature_data?: Record<string, any>;
  is_active: boolean;
  is_default: boolean;
  description?: string;
  usage_context?: string[];
  created_by?: string;
  updated_by?: string;
  created_at: string;
  updated_at: string;
}

export interface LabReportBrandingDefaults {
  labId: string;
  labName?: string | null;
  defaultReportHeaderHtml: string | null;
  defaultReportFooterHtml: string | null;
}

export interface LabPatientFieldConfig {
  id: string;
  lab_id: string;
  field_key: string;        // e.g. "abha_id"
  label: string;            // e.g. "ABHA ID"
  field_type: 'text' | 'number' | 'select';
  options?: string[] | null; // for select type
  searchable: boolean;
  required: boolean;
  use_for_ai_ref_range: boolean; // inject value into AI reference range context
  sort_order: number;
  created_at?: string;
}

export interface LabPatientFormSettings {
  id?: string;
  lab_id?: string;
  show_salutation: boolean;
  salutation_options: string[];
  show_middle_name: boolean;
  age_mode: 'age' | 'dob' | 'both';
  show_gender: boolean;
  gender_options: string[];
  phone_required: boolean;
  show_email: boolean;
  email_required: boolean;
  show_address: boolean;
  show_city: boolean;
  show_state: boolean;
  show_pincode: boolean;
  show_emergency_contact: boolean;
  show_blood_group: boolean;
  show_allergies: boolean;
  show_medical_history: boolean;
  show_referring_doctor: boolean;
  created_at?: string;
  updated_at?: string;
}

export const DEFAULT_PATIENT_FORM_SETTINGS: LabPatientFormSettings = {
  show_salutation: false,
  salutation_options: ['Mr.', 'Mrs.', 'Ms.', 'Dr.', 'Master', 'Baby', 'Prof.', 'Shri.', 'Smt.', 'Ku.'],
  show_middle_name: true,
  age_mode: 'both',
  show_gender: true,
  gender_options: ['Male', 'Female', 'Other'],
  phone_required: true,
  show_email: true,
  email_required: false,
  show_address: false,
  show_city: false,
  show_state: false,
  show_pincode: false,
  show_emergency_contact: false,
  show_blood_group: false,
  show_allergies: false,
  show_medical_history: false,
  show_referring_doctor: true,
};

interface LabContactRecord {
  id: string;
  name: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  phone: string | null;
  email: string | null;
  license_number: string | null;
}

type BrandingAssetSnippet = Pick<
  LabBrandingAsset,
  | "asset_type"
  | "asset_name"
  | "description"
  | "file_url"
  | "imagekit_url"
  | "variants"
>;

const escapeHtml = (value: string): string => {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };

  return value.replace(/[&<>\"']/g, (char) => map[char] ?? char);
};

const joinDisplayParts = (
  parts: Array<string | null | undefined>,
  separator: string,
): string => {
  return parts
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter((part) => part.length > 0)
    .join(separator);
};

const pickAssetPrimaryUrl = (
  asset?: BrandingAssetSnippet | null,
): string | null => {
  if (!asset) {
    return null;
  }

  if (asset.imagekit_url && asset.imagekit_url.trim().length > 0) {
    return asset.imagekit_url.trim();
  }

  const variants = asset.variants && typeof asset.variants === "object"
    ? asset.variants
    : null;
  if (variants) {
    const variantKeys = [
      "optimized",
      "optimized_url",
      "optimizedUrl",
      "default",
      "original",
    ];
    for (const key of variantKeys) {
      const candidate = (variants as Record<string, unknown>)[key];
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        return candidate.trim();
      }
    }

    for (const value of Object.values(variants)) {
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
      }
    }
  }

  if (asset.file_url && asset.file_url.trim().length > 0) {
    return asset.file_url.trim();
  }

  return null;
};

const composeHeaderHtml = (
  lab: LabContactRecord,
  asset?: BrandingAssetSnippet | null,
): string => {
  const logoUrl = pickAssetPrimaryUrl(asset);

  // If asset is explicitly a 'header' type, usually it's a full-width banner
  // Return simple full-width image container
  if (asset?.asset_type === "header" && logoUrl) {
    return `<div class="lab-header-branding" style="width:100%;"><img src="${
      escapeHtml(logoUrl)
    }" alt="${
      escapeHtml(asset.asset_name)
    }" style="max-width:100%;height:auto;object-fit:contain;"></div>`;
  }

  const displayName = escapeHtml(lab.name ?? asset?.asset_name ?? "Laboratory");
  const addressLine = joinDisplayParts(
    [lab.address, lab.city, lab.state, lab.pincode],
    ", ",
  );
  const contactLine = joinDisplayParts([lab.phone, lab.email], " • ");
  const descriptionLine = asset?.description
    ? escapeHtml(asset.description)
    : "";

  const addressHtml = addressLine
    ? `<div style="font-size:12px;color:#4b5563;">${
      escapeHtml(addressLine)
    }</div>`
    : "";
  const contactHtml = contactLine
    ? `<div style="font-size:12px;color:#4b5563;margin-top:2px;">${
      escapeHtml(contactLine)
    }</div>`
    : "";
  const descriptionHtml = descriptionLine
    ? `<div style="font-size:11px;color:#6b7280;margin-top:6px;">${descriptionLine}</div>`
    : "";

  const logoHtml = logoUrl
    ? `<div style="flex:0 0 auto;max-width:220px;display:flex;align-items:center;justify-content:flex-start;">
        <img src="${
      escapeHtml(logoUrl)
    }" alt="${displayName} branding" style="max-height:80px;width:auto;object-fit:contain;" />
      </div>`
    : "";

  return `
    <div style="width:100%;display:flex;align-items:flex-start;justify-content:space-between;gap:18px;font-family:'Inter','Helvetica Neue',Arial,sans-serif;">
      ${logoHtml}
      <div style="flex:1 1 auto;text-align:right;">
        <div style="font-size:18px;font-weight:600;color:#111827;">${displayName}</div>
        ${addressHtml}
        ${contactHtml}
        ${descriptionHtml}
      </div>
    </div>
  `.trim();
};

const composeFooterHtml = (
  lab: LabContactRecord,
  asset?: BrandingAssetSnippet | null,
): string => {
  const logoUrl = pickAssetPrimaryUrl(asset);

  // If asset is explicitly a 'footer' type, treat as full-width banner
  if (asset?.asset_type === "footer" && logoUrl) {
    return `<div class="lab-footer-branding" style="width:100%;"><img src="${
      escapeHtml(logoUrl)
    }" alt="${
      escapeHtml(asset.asset_name)
    }" style="max-width:100%;height:auto;object-fit:contain;"></div>`;
  }

  const accentName = escapeHtml(lab.name ?? asset?.asset_name ?? "Laboratory");
  const addressLine = joinDisplayParts(
    [lab.address, lab.city, lab.state, lab.pincode],
    ", ",
  );
  const contactLine = joinDisplayParts([lab.phone, lab.email], " • ");
  const licenseLine = lab.license_number
    ? `License: ${escapeHtml(lab.license_number)}`
    : "";
  const descriptionLine = asset?.description
    ? escapeHtml(asset.description)
    : "";

  const addressHtml = addressLine
    ? `<div style="margin-top:6px;">${escapeHtml(addressLine)}</div>`
    : "";
  const contactHtml = contactLine
    ? `<div style="margin-top:4px;">${escapeHtml(contactLine)}</div>`
    : "";
  const licenseHtml = licenseLine
    ? `<div style="margin-top:4px;color:#6b7280;">${licenseLine}</div>`
    : "";
  const descriptionHtml = descriptionLine
    ? `<div style="margin-top:6px;color:#6b7280;">${descriptionLine}</div>`
    : "";

  const logoHtml = logoUrl
    ? `<div style="flex:0 0 auto;max-width:180px;display:flex;justify-content:flex-end;">
        <img src="${
      escapeHtml(logoUrl)
    }" alt="${accentName} seal" style="max-height:70px;width:auto;object-fit:contain;" />
      </div>`
    : "";

  return `
    <div style="width:100%;display:flex;align-items:center;justify-content:space-between;gap:18px;font-family:'Inter','Helvetica Neue',Arial,sans-serif;font-size:12px;color:#4b5563;">
      <div style="flex:1 1 auto;line-height:1.45;">
        <div style="font-weight:600;color:#111827;">${accentName}</div>
        ${addressHtml}
        ${contactHtml}
        ${licenseHtml}
        ${descriptionHtml}
      </div>
      ${logoHtml}
    </div>
  `.trim();
};

// File upload utilities
export const uploadFile = async (
  file: File,
  filePath: string,
  options?: { upsert?: boolean },
) => {
  const { data, error } = await supabase.storage
    .from("attachments")
    .upload(filePath, file, {
      upsert: options?.upsert || false,
      contentType: file.type,
    });

  if (error) {
    throw new Error(`Upload failed: ${error.message}`);
  }

  // Get public URL
  const { data: publicUrlData } = supabase.storage
    .from("attachments")
    .getPublicUrl(data.path);

  return {
    path: data.path,
    publicUrl: publicUrlData.publicUrl,
    fullPath: data.fullPath,
  };
};

// Generate organized file path
export const generateFilePath = (
  fileName: string,
  patientId?: string,
  labId?: string,
  category: string = "general",
): string => {
  const timestamp = Date.now();
  const sanitizedFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, "_");

  if (labId && patientId) {
    return `${category}/${labId}/${patientId}_${timestamp}_${sanitizedFileName}`;
  } else if (patientId) {
    return `${category}/${patientId}_${timestamp}_${sanitizedFileName}`;
  } else {
    return `${category}/${timestamp}_${sanitizedFileName}`;
  }
};

// Generate branding asset file path
export const generateBrandingFilePath = (
  labId: string,
  assetType: "header" | "footer" | "watermark" | "logo" | "letterhead",
  fileName: string,
): string => {
  const timestamp = Date.now();
  const sanitizedFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, "_");
  return `attachments/labs/${labId}/branding/${assetType}/${timestamp}_${sanitizedFileName}`;
};

// Generate user signature file path
export const generateSignatureFilePath = (
  labId: string,
  userId: string,
  fileName: string,
): string => {
  const timestamp = Date.now();
  const sanitizedFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, "_");
  return `attachments/labs/${labId}/users/${userId}/signature/${timestamp}_${sanitizedFileName}`;
};

// Auth helper functions
export const auth = {
  signUp: async (email: string, password: string, userData?: any) => {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: userData,
      },
    });
    return { data, error };
  },

  signIn: async (email: string, password: string) => {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    return { data, error };
  },

  signOut: async () => {
    const { error } = await supabase.auth.signOut();
    return { error };
  },

  getCurrentUser: async () => {
    const { data: { user }, error } = await supabase.auth.getUser();
    return { user, error };
  },

  getSession: async () => {
    const { data: { session }, error } = await supabase.auth.getSession();
    return { session, error };
  },
};

// ============================================================================
// Lab ID Cache - prevents repeated DB queries during result entry sessions
// ============================================================================
let _cachedLabId: string | null = null;
let _cachedLabIdUserId: string | null = null; // Track which user the cache is for
let _labIdInflightPromise: Promise<string | null> | null = null; // Deduplicates concurrent calls

// ============================================================================
// User Cache - prevents repeated auth.getUser() calls
// ============================================================================
let _cachedUser: any = null;
let _cachedUserTimestamp: number = 0;
const USER_CACHE_TTL_MS = 60000; // Cache user for 60 seconds

const resolveCurrentAppUserId = async (): Promise<string | null> => {
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return null;

  try {
    const { data: byAuth } = await supabase
      .from("users")
      .select("id")
      .eq("auth_user_id", user.id)
      .maybeSingle();

    if (byAuth?.id) return byAuth.id;

    if (user.email) {
      const { data: byEmail } = await supabase
        .from("users")
        .select("id")
        .eq("email", user.email)
        .maybeSingle();

      if (byEmail?.id) return byEmail.id;
    }
  } catch (err) {
    console.warn("Could not resolve current app user id:", err);
  }

  return null;
};

// Clear cache on auth state change
supabase.auth.onAuthStateChange((event) => {
  if (event === "SIGNED_OUT" || event === "USER_UPDATED") {
    _cachedLabId = null;
    _cachedLabIdUserId = null;
    _labIdInflightPromise = null;
    _cachedUser = null;
    _cachedUserTimestamp = 0;
  }
});

// Database helper functions for patients
export const database = {
  // Expose supabase client for direct queries when needed
  supabase,

  // Clear lab ID cache (call when switching labs or on logout)
  clearLabIdCache: () => {
    _cachedLabId = null;
    _cachedLabIdUserId = null;
    _labIdInflightPromise = null;
  },

  // Helper to get current user's lab ID (with caching)
  getCurrentUserLabId: async () => {
    // Return cached value immediately if available
    if (_cachedLabId) return _cachedLabId;

    // Deduplicate concurrent calls — all share one in-flight promise
    if (_labIdInflightPromise) return _labIdInflightPromise;

    _labIdInflightPromise = (async () => {
      try {
        const { data: { user }, error } = await supabase.auth.getUser();
        if (error || !user) {
          console.error("Error fetching user:", error);
          return null;
        }

    // Primary: Check users table for lab_id (most reliable)
    try {
      const { data: userData, error: userDataError } = await supabase
        .from("users")
        .select("lab_id")
        .eq("email", user.email) // Match by email since auth.users.id might be different from public.users.id
        .eq("status", "Active")
        .maybeSingle();

      if (!userDataError && userData?.lab_id) {
        // Cache the result
        _cachedLabId = userData.lab_id;
        _cachedLabIdUserId = user.id;
        return userData.lab_id;
      }
    } catch (err) {
      console.warn("Could not fetch lab_id from users table:", err);
    }

    if (user?.user_metadata?.lab_id) {
      console.warn(
        "Using lab_id from user metadata (consider updating users table):",
        user.user_metadata.lab_id,
      );
      // Cache the result
      _cachedLabId = user.user_metadata.lab_id;
      _cachedLabIdUserId = user.id;
      return user.user_metadata.lab_id;
    }

    // Tertiary: Check user_labs table for user-lab assignment (if exists)
    try {
      const { data: userLab, error: userLabError } = await supabase
        .from("user_labs")
        .select("lab_id")
        .eq("user_id", user.id)
        .eq("is_active", true)
        .single();

      if (!userLabError && userLab?.lab_id) {
        console.warn(
          "Using lab_id from user_labs table (consider updating users table):",
          userLab.lab_id,
        );
        // Cache the result
        _cachedLabId = userLab.lab_id;
        _cachedLabIdUserId = user.id;
        return userLab.lab_id;
      }
    } catch (err) {
      // user_labs table might not exist, which is fine
    }

    // Final fallback: For development/demo purposes, get first available lab
    try {
      const { data: labs, error: labError } = await supabase
        .from("labs")
        .select("id")
        .eq("is_active", true)
        .limit(1);

      if (!labError && labs && labs.length > 0) {
        console.warn(
          "Lab ID not found for user. Using first available lab for demo:",
          labs[0].id,
        );
        console.warn(
          "Please update the users table with proper lab_id for user:",
          user.email,
        );
        // Cache the result
        _cachedLabId = labs[0].id;
        _cachedLabIdUserId = user.id;
        return labs[0].id;
      }
    } catch (err) {
      console.warn("Could not fetch default lab:", err);
    }

        console.error("No lab_id found for user and no default lab available");
        return null;
      } finally {
        _labIdInflightPromise = null;
      }
    })();
    return _labIdInflightPromise;
  },

  getCurrentAppUserId: async (): Promise<string | null> => {
    return resolveCurrentAppUserId();
  },

  // Helper to get current user's assigned location IDs
  getCurrentUserLocationIds: async (): Promise<string[]> => {
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) return [];

    try {
      // Get user's id from users table
      const { data: userData } = await supabase
        .from("users")
        .select("id")
        .eq("email", user.email)
        .eq("status", "Active")
        .maybeSingle();

      if (!userData?.id) return [];

      // Get assigned locations from user_centers
      const { data: centers } = await supabase
        .from("user_centers")
        .select("location_id")
        .eq("user_id", userData.id);

      return centers?.map((c) => c.location_id).filter(Boolean) || [];
    } catch (err) {
      console.warn("Could not fetch user locations:", err);
      return [];
    }
  },

  // Helper to get current user's primary location
  getCurrentUserPrimaryLocation: async (): Promise<string | null> => {
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) return null;

    try {
      const { data: userData } = await supabase
        .from("users")
        .select("id")
        .eq("email", user.email)
        .eq("status", "Active")
        .maybeSingle();

      if (!userData?.id) return null;

      // Use .maybeSingle() instead of .single() to handle case where no primary location exists
      const { data: center } = await supabase
        .from("user_centers")
        .select("location_id")
        .eq("user_id", userData.id)
        .eq("is_primary", true)
        .maybeSingle();

      return center?.location_id || null;
    } catch (err) {
      console.warn("Could not fetch user primary location:", err);
      return null;
    }
  },

  // Helper to check if current user should have location filtering applied
  shouldFilterByLocation: async (): Promise<
    { shouldFilter: boolean; locationIds: string[]; canViewAll: boolean }
  > => {
    const labId = await database.getCurrentUserLabId();
    if (!labId) {
      return { shouldFilter: false, locationIds: [], canViewAll: true };
    }

    try {
      // Check if lab enforces location restrictions
      const { data: lab } = await supabase
        .from("labs")
        .select("enforce_location_restrictions")
        .eq("id", labId)
        .maybeSingle();

      if (!lab?.enforce_location_restrictions) {
        return { shouldFilter: false, locationIds: [], canViewAll: true };
      }

      // Get user info
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        return { shouldFilter: false, locationIds: [], canViewAll: true };
      }

      const { data: userData } = await supabase
        .from("users")
        .select(`
          id, 
          role,
          user_roles (
            role_name
          )
        `)
        .eq("email", user.email)
        .eq("status", "Active")
        .maybeSingle();

      if (!userData?.id) {
        return { shouldFilter: false, locationIds: [], canViewAll: true };
      }

      // Admins bypass location restrictions
      const userRole = (userData.role || "").toLowerCase();
      // Safe access to nested role name
      const joinRoleName =
        (userData.user_roles as any)?.role_name?.toLowerCase() || "";

      if (
        ["admin", "administrator", "super_admin", "super admin"].includes(
          userRole,
        ) ||
        ["admin", "administrator", "super_admin", "super admin"].includes(
          joinRoleName,
        )
      ) {
        return { shouldFilter: false, locationIds: [], canViewAll: true };
      }

      // Check user's location assignments and override flag
      const { data: centers } = await supabase
        .from("user_centers")
        .select("location_id, can_view_all_locations")
        .eq("user_id", userData.id);

      // If user has can_view_all_locations flag, no filtering
      const canViewAll = centers?.some((c) => c.can_view_all_locations) ||
        false;
      if (canViewAll) {
        return { shouldFilter: false, locationIds: [], canViewAll: true };
      }

      const locationIds = centers?.map((c) => c.location_id).filter(Boolean) ||
        [];

      // If user has no assigned locations, FAIL CLOSED (show nothing)
      if (locationIds.length === 0) {
        return {
          shouldFilter: true,
          locationIds: ["00000000-0000-0000-0000-000000000000"],
          canViewAll: false,
        };
      }

      return { shouldFilter: true, locationIds, canViewAll: false };
    } catch (err) {
      console.warn("Error checking location filter:", err);
      return { shouldFilter: false, locationIds: [], canViewAll: true };
    }
  },

  labs: {
    getBrandingDefaults: async (): Promise<
      { data: LabReportBrandingDefaults | null; error: Error | null }
    > => {
      const labId = await database.getCurrentUserLabId();
      if (!labId) {
        return {
          data: null,
          error: new Error("No lab_id found for current user"),
        };
      }

      const { data, error } = await supabase
        .from("labs")
        .select(
          "id, name, default_report_header_html, default_report_footer_html",
        )
        .eq("id", labId)
        .maybeSingle();

      if (error) {
        return { data: null, error };
      }

      if (!data) {
        return { data: null, error: null };
      }

      const payload: LabReportBrandingDefaults = {
        labId: data.id,
        labName: data.name ?? null,
        defaultReportHeaderHtml: data.default_report_header_html ?? null,
        defaultReportFooterHtml: data.default_report_footer_html ?? null,
      };

      return { data: payload, error: null };
    },

    updateBrandingHtmlDefaults: async (
      input: { headerHtml?: string | null; footerHtml?: string | null },
      labIdOverride?: string,
    ): Promise<
      { data: LabReportBrandingDefaults | null; error: Error | null }
    > => {
      const labId = labIdOverride || (await database.getCurrentUserLabId());
      if (!labId) {
        return {
          data: null,
          error: new Error("No lab_id found for current user"),
        };
      }

      const updatePayload: Record<string, string | null> = {};
      if (Object.prototype.hasOwnProperty.call(input, "headerHtml")) {
        updatePayload.default_report_header_html = input.headerHtml ?? null;
      }
      if (Object.prototype.hasOwnProperty.call(input, "footerHtml")) {
        updatePayload.default_report_footer_html = input.footerHtml ?? null;
      }

      if (Object.keys(updatePayload).length === 0) {
        return { data: null, error: null };
      }

      updatePayload.updated_at = new Date().toISOString();

      const { data, error } = await supabase
        .from("labs")
        .update(updatePayload)
        .eq("id", labId)
        .select(
          "id, name, default_report_header_html, default_report_footer_html",
        )
        .maybeSingle();

      if (error) {
        return { data: null, error };
      }

      if (!data) {
        return { data: null, error: null };
      }

      return {
        data: {
          labId: data.id,
          labName: data.name ?? null,
          defaultReportHeaderHtml: data.default_report_header_html ?? null,
          defaultReportFooterHtml: data.default_report_footer_html ?? null,
        },
        error: null,
      };
    },

    getDefaultApprovalSignature: async (
      labId: string,
    ): Promise<string | null> => {
      try {
        // First try to get from lab's default branding
        const { data: brandingData, error: brandingError } = await supabase
          .from("lab_branding_assets")
          .select("file_url, imagekit_url")
          .eq("lab_id", labId)
          .eq("asset_type", "signature")
          .eq("is_default", true)
          .single();

        if (!brandingError && brandingData) {
          return brandingData.imagekit_url || brandingData.file_url;
        }

        // Fallback: Get any signature from users in this lab
        const { data: userSignature, error: userError } = await supabase
          .from("lab_user_signatures")
          .select("signature_url, processed_signature_url, imagekit_url")
          .eq("lab_id", labId)
          .eq("is_active", true)
          .order("created_at", { ascending: false })
          .limit(1)
          .single();

        if (!userError && userSignature) {
          return userSignature.imagekit_url ||
            userSignature.processed_signature_url ||
            userSignature.signature_url;
        }

        return null;
      } catch (error) {
        console.error("Error fetching default approval signature:", error);
        return null;
      }
    },

    getById: async (labId?: string): Promise<{ data: any; error: any }> => {
      try {
        const id = labId || await database.getCurrentUserLabId();
        if (!id) {
          return { data: null, error: new Error("No lab_id found") };
        }

        const { data, error } = await supabase
          .from("labs")
          .select("*")
          .eq("id", id)
          .single();

        return { data, error };
      } catch (error) {
        console.error("Error fetching lab:", error);
        return { data: null, error };
      }
    },

    update: async (labId: string, updates: {
      name?: string;
      code?: string;
      address?: string;
      city?: string;
      state?: string;
      pincode?: string;
      phone?: string;
      email?: string;
      email_domain?: string;
      license_number?: string;
      registration_number?: string;
      watermark_enabled?: boolean;
      watermark_opacity?: number;
      watermark_position?: string;
      watermark_size?: string;
      watermark_rotation?: number;
      preferred_language?: string;
      method_options?: string[];
      pdf_letterhead_mode?: "background" | "header_footer";
      loyalty_enabled?: boolean;
      loyalty_conversion_rate?: number;
      loyalty_min_redeem_points?: number;
      loyalty_point_value?: number;
    }): Promise<{ data: any; error: any }> => {
      try {
        const { data, error } = await supabase
          .from("labs")
          .update({ ...updates, updated_at: new Date().toISOString() })
          .eq("id", labId)
          .select()
          .single();

        return { data, error };
      } catch (error) {
        console.error("Error updating lab:", error);
        return { data: null, error };
      }
    },
  },

  auth: {
    getCurrentUser: async () => {
      try {
        const { data: { user }, error } = await supabase.auth.getUser();
        if (error || !user) {
          return { data: null, error };
        }
        return { data: { user }, error: null };
      } catch (error) {
        console.error("Error fetching current user:", error);
        return { data: null, error };
      }
    },

    getCurrentUserWithLab: async (): Promise<{ data: any; error: any }> => {
      try {
        const { data: authData, error: authError } = await supabase.auth
          .getUser();
        if (authError || !authData.user) {
          return { data: null, error: authError };
        }

        const { data: userData, error: userError } = await supabase
          .from("users")
          .select(`
            id,
            name,
            email,
            lab_id,
            labs(id, name, code)
          `)
          .eq("email", authData.user.email)
          .eq("status", "Active")
          .single();

        return { data: userData, error: userError };
      } catch (error) {
        console.error("Error fetching current user with lab:", error);
        return { data: null, error };
      }
    },
  },

  users: {
    getLabUsers: async (
      labId: string,
    ): Promise<{ data: any[]; error: any }> => {
      try {
        const { data, error } = await supabase
          .from("users")
          .select(`
            id,
            name,
            email,
            role,
            department,
            phone,
            lab_id,
            status,
            is_phlebotomist,
            created_at,
            last_login,
            lab_user_signatures!lab_user_signatures_user_id_fkey(
              id,
              signature_name,
              file_url,
              imagekit_url,
              is_active,
              is_default
            )
          `)
          .eq("lab_id", labId)
          .order("created_at", { ascending: false });

        return { data: data || [], error };
      } catch (error) {
        console.error("Error fetching lab users:", error);
        return { data: [], error };
      }
    },

    getPhlebotomists: async (
      labId?: string,
    ): Promise<{ data: any[]; error: any }> => {
      try {
        const lab_id = labId || await database.getCurrentUserLabId();
        if (!lab_id) {
          return { data: [], error: new Error("No lab_id found") };
        }

        const { data, error } = await supabase
          .from("users")
          .select("id, name, email, role, phone, contact_number, is_phlebotomist")
          .eq("lab_id", lab_id)
          .eq("status", "Active")
          .eq("is_phlebotomist", true)
          .order("name");

        return { data: data || [], error };
      } catch (error) {
        console.error("Error fetching phlebotomists:", error);
        return { data: [], error };
      }
    },

    // Alias for consistency
    listPhlebotomists: async (labId?: string) => {
      return database.users.getPhlebotomists(labId);
    },

    updatePhlebotomistStatus: async (
      userId: string,
      isPhlebotomist: boolean,
    ) => {
      try {
        const { data, error } = await supabase
          .from("users")
          .update({ is_phlebotomist: isPhlebotomist })
          .eq("id", userId)
          .select()
          .single();

        return { data, error };
      } catch (error) {
        console.error("Error updating phlebotomist status:", error);
        return { data: null, error };
      }
    },

    getSignatureByUserId: async (
      userId: string,
      labId?: string,
    ): Promise<string | null> => {
      try {
        let query = supabase
          .from("lab_user_signatures")
          .select("signature_url, processed_signature_url, imagekit_url")
          .eq("user_id", userId)
          .eq("is_active", true);

        // If labId is provided, filter by it for additional security
        if (labId) {
          query = query.eq("lab_id", labId);
        }

        const { data, error } = await query.single();

        if (error || !data) return null;

        // Prefer processed/imagekit URL, fallback to original
        return data.imagekit_url || data.processed_signature_url ||
          data.signature_url;
      } catch (error) {
        console.error("Error fetching user signature:", error);
        return null;
      }
    },
  },

  locations: {
    getAll: async (): Promise<{ data: any[]; error: any }> => {
      try {
        const lab_id = await database.getCurrentUserLabId();
        if (!lab_id) {
          return {
            data: [],
            error: new Error("No lab_id found for current user"),
          };
        }

        const filterCheck = await database.shouldFilterByLocation();

        let query = supabase
          .from("locations")
          .select("*")
          .eq("lab_id", lab_id)
          .eq("is_active", true)
          .order("name");

        if (
          filterCheck.shouldFilter && !filterCheck.canViewAll &&
          filterCheck.locationIds.length > 0
        ) {
          query = query.in("id", filterCheck.locationIds);
        }

        const { data, error } = await query;
        return { data: data || [], error };
      } catch (error) {
        console.error("Error fetching locations:", error);
        return { data: [], error };
      }
    },

    getById: async (id: string): Promise<{ data: any; error: any }> => {
      try {
        const { data, error } = await supabase
          .from("locations")
          .select("*")
          .eq("id", id)
          .single();

        return { data, error };
      } catch (error) {
        console.error("Error fetching location:", error);
        return { data: null, error };
      }
    },

    create: async (locationData: {
      name: string;
      code?: string;
      type?:
        | "hospital"
        | "clinic"
        | "diagnostic_center"
        | "home_collection"
        | "walk_in";
      address?: string;
      phone?: string;
      email?: string;
      contact_person?: string;
      credit_limit?: number;
      collection_percentage?: number;
      is_cash_collection_center?: boolean;
      notes?: string;
    }): Promise<{ data: any; error: any }> => {
      try {
        const lab_id = await database.getCurrentUserLabId();
        if (!lab_id) {
          return {
            data: null,
            error: new Error("No lab_id found for current user"),
          };
        }

        const { data, error } = await supabase
          .from("locations")
          .insert([{
            ...locationData,
            type: locationData.type || "diagnostic_center",
            lab_id,
            is_active: true,
            supports_cash_collection: locationData.is_cash_collection_center ||
              false,
            payment_terms: 0,
          }])
          .select()
          .single();

        return { data, error };
      } catch (error) {
        console.error("Error creating location:", error);
        return { data: null, error };
      }
    },

    update: async (id: string, locationData: {
      name?: string;
      code?: string;
      type?:
        | "hospital"
        | "clinic"
        | "diagnostic_center"
        | "home_collection"
        | "walk_in";
      address?: string;
      phone?: string;
      email?: string;
      contact_person?: string;
      credit_limit?: number;
      collection_percentage?: number;
      is_cash_collection_center?: boolean;
      notes?: string;
      is_active?: boolean;
    }): Promise<{ data: any; error: any }> => {
      try {
        const { data, error } = await supabase
          .from("locations")
          .update({
            ...locationData,
            updated_at: new Date().toISOString(),
          })
          .eq("id", id)
          .select()
          .single();

        return { data, error };
      } catch (error) {
        console.error("Error updating location:", error);
        return { data: null, error };
      }
    },

    delete: async (id: string): Promise<{ error: any }> => {
      try {
        const { error } = await supabase
          .from("locations")
          .delete()
          .eq("id", id);

        return { error };
      } catch (error) {
        console.error("Error deleting location:", error);
        return { error };
      }
    },
  },

  creditTransactions: {
    getByLocation: async (
      locationId: string,
      limit: number = 50,
    ): Promise<{ data: any[]; error: any }> => {
      try {
        const { data, error } = await supabase
          .from("credit_transactions")
          .select("*")
          .eq("location_id", locationId)
          .order("created_at", { ascending: false })
          .limit(limit);

        return { data: data || [], error };
      } catch (error) {
        console.error("Error fetching credit transactions:", error);
        return { data: [], error };
      }
    },

    getCreditSummaryByLocation: async (
      locationId: string,
    ): Promise<{ data: { current_balance: number } | null; error: any }> => {
      try {
        const { data, error } = await supabase
          .from("credit_transactions")
          .select("amount, transaction_type")
          .eq("location_id", locationId);

        if (error) {
          return { data: null, error };
        }

        // Calculate current balance: credits - (payments + adjustments)
        let balance = 0;
        (data || []).forEach((tx: any) => {
          if (tx.transaction_type === "credit") {
            balance += Number(tx.amount) || 0;
          } else {
            balance -= Number(tx.amount) || 0;
          }
        });

        return { data: { current_balance: balance }, error: null };
      } catch (error) {
        console.error("Error fetching credit summary:", error);
        return { data: null, error };
      }
    },

    create: async (transactionData: {
      location_id: string;
      amount: number;
      type: "credit" | "debit";
      description?: string;
      reference_type?: string;
      reference_id?: string;
    }): Promise<{ data: any; error: any }> => {
      try {
        const lab_id = await database.getCurrentUserLabId();
        if (!lab_id) {
          return {
            data: null,
            error: new Error("No lab_id found for current user"),
          };
        }

        const { data, error } = await supabase
          .from("credit_transactions")
          .insert([{
            location_id: transactionData.location_id,
            amount: transactionData.amount,
            transaction_type: transactionData.type === "credit"
              ? "credit"
              : "payment",
            notes: transactionData.description,
            reference_number: transactionData.reference_id,
            lab_id,
            created_at: new Date().toISOString(),
          }])
          .select()
          .single();

        return { data, error };
      } catch (error) {
        console.error("Error creating credit transaction:", error);
        return { data: null, error };
      }
    },
  },

  bookings: {
    create: async (payload: any) => {
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) {
        return {
          data: null,
          error: new Error("No lab_id found for current user"),
        };
      }
      const { data, error } = await supabase
        .from("bookings")
        .insert({
          ...payload,
          lab_id,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .select()
        .single();
      return { data, error };
    },

    update: async (id: string, updates: any) => {
      const { data, error } = await supabase
        .from("bookings")
        .update({
          ...updates,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id)
        .select()
        .single();
      return { data, error };
    },

    list: async (filters?: { status?: string; source?: string }) => {
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) return { data: [], error: new Error("No lab_id") };

      let query = supabase
        .from("bookings")
        .select("*")
        .eq("lab_id", lab_id)
        .order("created_at", { ascending: false });

      if (filters?.status) {
        query = query.eq("status", filters.status);
      }
      if (filters?.source) {
        query = query.eq("booking_source", filters.source);
      }

      const { data, error } = await query;
      return { data: (data as any[]) || [], error };
    },

    getById: async (id: string) => {
      const { data, error } = await supabase
        .from("bookings")
        .select("*")
        .eq("id", id)
        .single();
      return { data, error };
    },
  },

  aiProtocols: {
    create: async (payload: {
      name: string;
      lab_id: string;
      category: string;
      status: string;
      description?: string | null;
      config?: Record<string, unknown>;
      ui_config?: Record<string, unknown>;
      result_mapping?: Record<string, unknown>;
    }) => {
      const { data, error } = await supabase
        .from("ai_protocols")
        .insert({
          ...payload,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .select()
        .single();

      return { data, error };
    },

    update: async (protocolId: string, updates: Record<string, unknown>) => {
      const { data, error } = await supabase
        .from("ai_protocols")
        .update({
          ...updates,
          updated_at: new Date().toISOString(),
        })
        .eq("id", protocolId)
        .select()
        .single();

      return { data, error };
    },

    getById: async (protocolId: string) => {
      const { data, error } = await supabase
        .from("ai_protocols")
        .select("*")
        .eq("id", protocolId)
        .single();

      return { data, error };
    },
  },

  aiAnalysis: {
    saveDoctorSummary: async (orderId: string, summary: string) => {
      try {
        const labId = await database.getCurrentUserLabId();
        if (!labId) {
          return { error: new Error("No lab_id found for current user") };
        }

        // Check if report exists
        const { data: existingReport } = await supabase
          .from("reports")
          .select("id")
          .eq("order_id", orderId)
          .maybeSingle();

        if (existingReport) {
          const { error } = await supabase
            .from("reports")
            .update({
              ai_doctor_summary: summary,
              ai_summary_generated_at: new Date().toISOString(),
            })
            .eq("id", existingReport.id);
          return { error };
        } else {
          // Create new report record if it doesn't exist
          const { error } = await supabase
            .from("reports")
            .insert({
              lab_id: labId,
              order_id: orderId,
              ai_doctor_summary: summary,
              ai_summary_generated_at: new Date().toISOString(),
              status: "Draft",
              generated_date: new Date().toISOString(),
            });
          return { error };
        }
      } catch (error) {
        console.error("Error saving doctor summary:", error);
        return { error };
      }
    },
  },

  whatsappTemplates: {
    getDefault: async (category: string, labId?: string) => {
      try {
        const id = labId || await database.getCurrentUserLabId();
        if (!id) return { data: null, error: new Error("No lab_id found") };

        const { data, error } = await supabase
          .from("whatsapp_message_templates")
          .select("*")
          .eq("lab_id", id)
          .eq("category", category)
          .eq("is_default", true)
          .maybeSingle();

        return { data, error };
      } catch (error) {
        console.error("Error fetching default WhatsApp template:", error);
        return { data: null, error };
      }
    },
  },

  invoiceTemplates: {
    getAll: async () => {
      try {
        const labId = await database.getCurrentUserLabId();
        if (!labId) return { data: [], error: new Error("No lab_id found") };

        const { data, error } = await supabase
          .from("invoice_templates")
          .select("*")
          .eq("lab_id", labId)
          .order("is_default", { ascending: false });

        return { data: data || [], error };
      } catch (error) {
        console.error("Error fetching invoice templates:", error);
        return { data: [], error };
      }
    },
  },

  patients: {
    getAll: async () => {
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) {
        return {
          data: null,
          error: new Error("No lab_id found for current user"),
        };
      }

      const { data, error } = await supabase
        .from("patients")
        .select("*")
        .eq("is_active", true)
        .eq("lab_id", lab_id)
        .order("created_at", { ascending: false });
      return { data, error };
    },

    getAllWithTestCounts: async () => {
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) {
        return {
          data: null,
          error: new Error("No lab_id found for current user"),
        };
      }

      const { data, error } = await supabase
        .from("patients")
        .select(`
          *,
          orders!inner(count)
        `)
        .eq("is_active", true)
        .eq("lab_id", lab_id)
        .order("created_at", { ascending: false });
      // Optionally, transform data here if needed
      return { data, error };
    },

    getById: async (id: string) => {
      const { data, error } = await supabase
        .from("patients")
        .select("*")
        .eq("id", id)
        .single();
      return { data, error };
    },

    create: async (patientData: any) => {
      const {
        requestedTests,
        referring_doctor,
        referring_doctor_id,
        ...patientDetails
      } = patientData;

      // Get current user's lab_id
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) {
        return {
          data: null,
          error: new Error("No lab_id found for current user"),
        };
      }

      // Get today's date in DD-Mon-YYYY format
      const today = new Date();
      const day = today.getDate().toString().padStart(2, "0");
      const month = today.toLocaleString("en-US", { month: "short" });
      const year = today.getFullYear();
      const dateFormatted = `${day}-${month}-${year}`;

      // Count patients registered today to determine sequential number
      const { count: todayCount, error: countError } = await supabase
        .from("patients")
        .select("id", { count: "exact", head: true })
        .eq("lab_id", lab_id)
        .gte("created_at", today.toISOString().split("T")[0]);

      if (countError) {
        console.error("Error counting today's patients:", countError);
        return { data: null, error: countError };
      }

      // Calculate sequential number (1-indexed)
      const sequentialNumber = (todayCount || 0) + 1;

      // Generate display_id in format DD-Mon-YYYY-SeqNum
      const display_id = `${dateFormatted}-${sequentialNumber}`;

      // Ensure custom_fields is always a plain object (never a pre-stringified string)
      if (patientDetails.custom_fields && typeof patientDetails.custom_fields === 'string') {
        try { patientDetails.custom_fields = JSON.parse(patientDetails.custom_fields); } catch { patientDetails.custom_fields = {}; }
      }

      // Create patient with display_id and lab_id
      const { data, error } = await supabase
        .from("patients")
        .insert([{
          ...patientDetails,
          referring_doctor,
          display_id,
          lab_id,
        }])
        .select()
        .single();

      if (error || !data) {
        return { data, error };
      }

      // Patient created successfully - QR codes and colors are now handled in orders
      // Step 3: Create order if tests were requested
      if (requestedTests && requestedTests.length > 0) {
        try {
          // Get test groups from database to match test names
          const { data: testGroups, error: testGroupsError } = await supabase
            .from("test_groups")
            .select("*");

          if (testGroupsError) {
            console.error("Error fetching test groups:", testGroupsError);
          } else {
            // Match requested tests to test groups
            const matchedTests: string[] = [];
            let totalAmount = 0;

            requestedTests.forEach((testName: string) => {
              const matchedGroup = testGroups?.find((group) =>
                group.name.toLowerCase().includes(testName.toLowerCase()) ||
                testName.toLowerCase().includes(group.name.toLowerCase())
              );

              if (matchedGroup) {
                matchedTests.push(matchedGroup.name);
                totalAmount += matchedGroup.price;
              } else {
                // Add unmatched tests as-is for manual review
                matchedTests.push(testName);
                totalAmount += 500; // Default price for unmatched tests
              }
            });

            if (matchedTests.length > 0) {
              // Create order for the new patient
              const orderData = {
                patient_name: data.name,
                patient_id: data.id,
                tests: matchedTests,
                status: "Sample Collection",
                priority: "Normal",
                order_date: new Date().toISOString().split("T")[0],
                expected_date:
                  new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString()
                    .split("T")[0], // 2 days from now
                total_amount: totalAmount,
                doctor: referring_doctor || "Self",
                referring_doctor_id: referring_doctor_id || null,
              };

              const { data: orderResult, error: orderError } = await database
                .orders.create(orderData);

              if (orderError) {
                console.error("Order creation failed:", orderError);
              } else {
                console.log("Order created successfully:", orderResult?.id);
                return {
                  data: {
                    ...data,
                    order_created: true,
                    order_id: orderResult?.id,
                    matched_tests: matchedTests.length,
                    total_tests: requestedTests.length,
                  },
                  error: null,
                };
              }
            }
          }
        } catch (orderCreationError) {
          console.error("Error in order creation process:", orderCreationError);
          // Don't fail patient creation if order creation fails
        }
      }

      // Patient created successfully
      return { data: data, error: null };
    },

    update: async (id: string, patientData: any) => {
      const { data, error } = await supabase
        .from("patients")
        .update(patientData)
        .eq("id", id)
        .select()
        .single();
      return { data, error };
    },

    delete: async (id: string) => {
      const { error } = await supabase
        .from("patients")
        .update({ is_active: false })
        .eq("id", id);
      return { error };
    },
  },

  // ============================================================
  // Custom Patient Field Configs (per-lab)
  // ============================================================
  labPatientFieldConfigs: {
    getAll: async (): Promise<{ data: LabPatientFieldConfig[] | null; error: any }> => {
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) return { data: null, error: new Error("No lab_id") };
      const { data, error } = await supabase
        .from("lab_patient_field_configs")
        .select("*")
        .eq("lab_id", lab_id)
        .order("sort_order", { ascending: true });
      return { data, error };
    },

    create: async (config: Omit<LabPatientFieldConfig, "id" | "lab_id" | "created_at">): Promise<{ data: LabPatientFieldConfig | null; error: any }> => {
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) return { data: null, error: new Error("No lab_id") };
      const { data, error } = await supabase
        .from("lab_patient_field_configs")
        .insert({ ...config, lab_id })
        .select()
        .single();
      return { data, error };
    },

    update: async (id: string, updates: Partial<Omit<LabPatientFieldConfig, "id" | "lab_id" | "created_at">>): Promise<{ data: LabPatientFieldConfig | null; error: any }> => {
      const { data, error } = await supabase
        .from("lab_patient_field_configs")
        .update(updates)
        .eq("id", id)
        .select()
        .single();
      return { data, error };
    },

    delete: async (id: string): Promise<{ error: any }> => {
      const { error } = await supabase
        .from("lab_patient_field_configs")
        .delete()
        .eq("id", id);
      return { error };
    },

    // Fetch only the searchable fields (used by patient search in OrderForm)
    getSearchable: async (): Promise<LabPatientFieldConfig[]> => {
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) return [];
      const { data } = await supabase
        .from("lab_patient_field_configs")
        .select("field_key, label, field_type")
        .eq("lab_id", lab_id)
        .eq("searchable", true)
        .order("sort_order", { ascending: true });
      return data || [];
    },
  },

  // ============================================================
  // Patient Form Settings (per-lab built-in field visibility)
  // ============================================================
  patientFormSettings: {
    get: async (): Promise<{ data: LabPatientFormSettings | null; error: any }> => {
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) return { data: null, error: new Error('No lab_id') };
      const { data, error } = await supabase
        .from('lab_patient_form_settings')
        .select('*')
        .eq('lab_id', lab_id)
        .maybeSingle();
      return { data, error };
    },

    upsert: async (settings: Partial<Omit<LabPatientFormSettings, 'id' | 'lab_id' | 'created_at' | 'updated_at'>>): Promise<{ data: LabPatientFormSettings | null; error: any }> => {
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) return { data: null, error: new Error('No lab_id') };
      const { data, error } = await supabase
        .from('lab_patient_form_settings')
        .upsert({ ...settings, lab_id, updated_at: new Date().toISOString() }, { onConflict: 'lab_id' })
        .select()
        .single();
      return { data, error };
    },
  },

  // Get today's patient count for color assignment
  getTodaysPatientsCount: async () => {
    const today = new Date().toISOString().split("T")[0];
    const { count, error } = await supabase
      .from("patients")
      .select("id", { count: "exact", head: true })
      .gte("created_at", today);

    return { count: count || 0, error };
  },

  // ========================================
  // Loyalty Points System
  // ========================================
  loyaltyPoints: {
    /**
     * Get patient's loyalty balance for the current lab
     */
    getBalance: async (
      patientId: string,
    ): Promise<{ data: any; error: any }> => {
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) return { data: null, error: new Error("No lab_id found") };

      const { data, error } = await supabase
        .from("patient_loyalty_points")
        .select("*")
        .eq("patient_id", patientId)
        .eq("lab_id", lab_id)
        .maybeSingle();

      return {
        data: data ||
          { current_balance: 0, total_earned: 0, total_redeemed: 0 },
        error,
      };
    },

    /**
     * Get transaction history for a patient
     */
    getTransactions: async (
      patientId: string,
      limit = 50,
    ): Promise<{ data: any[]; error: any }> => {
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) return { data: [], error: new Error("No lab_id found") };

      const { data, error } = await supabase
        .from("loyalty_transactions")
        .select("*, orders(sample_id, patient_name)")
        .eq("patient_id", patientId)
        .eq("lab_id", lab_id)
        .order("created_at", { ascending: false })
        .limit(limit);

      return { data: data || [], error };
    },

    /**
     * Earn points from an order (called after order creation/payment)
     * amount = the billable amount on which points are calculated
     */
    earnPoints: async (
      patientId: string,
      orderId: string,
      amount: number,
    ): Promise<{ data: any; error: any }> => {
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) return { data: null, error: new Error("No lab_id found") };

      // Fetch lab loyalty settings
      const { data: lab } = await supabase
        .from("labs")
        .select("loyalty_enabled, loyalty_conversion_rate")
        .eq("id", lab_id)
        .single();

      if (!lab?.loyalty_enabled) return { data: null, error: null }; // silently skip

      const conversionRate = lab.loyalty_conversion_rate || 0.1;
      const pointsEarned = Math.floor(amount * conversionRate);
      if (pointsEarned <= 0) return { data: null, error: null };

      // Upsert patient balance
      const { data: existing } = await supabase
        .from("patient_loyalty_points")
        .select("id, current_balance, total_earned")
        .eq("patient_id", patientId)
        .eq("lab_id", lab_id)
        .maybeSingle();

      let newBalance: number;
      let newTotalEarned: number;

      if (existing?.id) {
        newBalance = (existing.current_balance || 0) + pointsEarned;
        newTotalEarned = (existing.total_earned || 0) + pointsEarned;
        await supabase
          .from("patient_loyalty_points")
          .update({
            current_balance: newBalance,
            total_earned: newTotalEarned,
            updated_at: new Date().toISOString(),
          })
          .eq("id", existing.id);
      } else {
        newBalance = pointsEarned;
        newTotalEarned = pointsEarned;
        await supabase
          .from("patient_loyalty_points")
          .insert({
            patient_id: patientId,
            lab_id,
            current_balance: newBalance,
            total_earned: newTotalEarned,
          });
      }

      // Record transaction
      const { data: txn, error: txnError } = await supabase
        .from("loyalty_transactions")
        .insert({
          patient_id: patientId,
          lab_id,
          order_id: orderId,
          type: "earned",
          points: pointsEarned,
          balance_after: newBalance,
          description:
            `Earned ${pointsEarned} pts on order (₹${amount.toLocaleString()})`,
        })
        .select()
        .single();

      notificationTriggerService.triggerLoyaltyPoints(
        patientId,
        orderId,
        lab_id,
        "earned",
        { points: pointsEarned, balance: newBalance },
      ).catch((err) =>
        console.warn("Loyalty points WhatsApp notification failed:", err)
      );

      return { data: { pointsEarned, newBalance }, error: txnError };
    },

    /**
     * Redeem points on an order — returns the discount amount
     */
    redeemPoints: async (
      patientId: string,
      orderId: string,
      pointsToRedeem: number,
    ): Promise<{ data: any; error: any }> => {
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) return { data: null, error: new Error("No lab_id found") };

      if (pointsToRedeem <= 0) {
        return { data: null, error: new Error("Points must be positive") };
      }

      // Fetch lab settings
      const { data: lab } = await supabase
        .from("labs")
        .select(
          "loyalty_enabled, loyalty_point_value, loyalty_min_redeem_points",
        )
        .eq("id", lab_id)
        .single();

      if (!lab?.loyalty_enabled) {
        return { data: null, error: new Error("Loyalty program not enabled") };
      }

      // Check balance
      const { data: balance } = await supabase
        .from("patient_loyalty_points")
        .select("id, current_balance, total_redeemed")
        .eq("patient_id", patientId)
        .eq("lab_id", lab_id)
        .maybeSingle();

      if (!balance || balance.current_balance < pointsToRedeem) {
        return { data: null, error: new Error("Insufficient points balance") };
      }

      if (balance.current_balance < (lab.loyalty_min_redeem_points || 100)) {
        return {
          data: null,
          error: new Error(
            `Minimum ${
              lab.loyalty_min_redeem_points || 100
            } points required to redeem`,
          ),
        };
      }

      const pointValue = lab.loyalty_point_value || 1.0;
      const discountAmount = pointsToRedeem * pointValue;
      const newBalance = balance.current_balance - pointsToRedeem;
      const newTotalRedeemed = (balance.total_redeemed || 0) + pointsToRedeem;

      // Update balance
      await supabase
        .from("patient_loyalty_points")
        .update({
          current_balance: newBalance,
          total_redeemed: newTotalRedeemed,
          updated_at: new Date().toISOString(),
        })
        .eq("id", balance.id);

      // Record transaction
      await supabase
        .from("loyalty_transactions")
        .insert({
          patient_id: patientId,
          lab_id,
          order_id: orderId,
          type: "redeemed",
          points: -pointsToRedeem,
          balance_after: newBalance,
          description: `Redeemed ${pointsToRedeem} pts for ₹${
            discountAmount.toFixed(2)
          } discount`,
        });

      // Update order with loyalty info
      await supabase
        .from("orders")
        .update({
          loyalty_points_redeemed: pointsToRedeem,
          loyalty_discount_amount: discountAmount,
        })
        .eq("id", orderId);

      notificationTriggerService.triggerLoyaltyPoints(
        patientId,
        orderId,
        lab_id,
        "redeemed",
        {
          points: pointsToRedeem,
          balance: newBalance,
          discountAmount,
        },
      ).catch((err) =>
        console.warn("Loyalty redemption WhatsApp notification failed:", err)
      );

      return {
        data: { discountAmount, pointsRedeemed: pointsToRedeem, newBalance },
        error: null,
      };
    },

    /**
     * Manually adjust points (admin action)
     */
    adjustPoints: async (
      patientId: string,
      points: number,
      reason: string,
    ): Promise<{ data: any; error: any }> => {
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) return { data: null, error: new Error("No lab_id found") };

      const { data: { user } } = await supabase.auth.getUser();

      const { data: existing } = await supabase
        .from("patient_loyalty_points")
        .select("id, current_balance, total_earned, total_redeemed")
        .eq("patient_id", patientId)
        .eq("lab_id", lab_id)
        .maybeSingle();

      const currentBalance = existing?.current_balance || 0;
      const newBalance = Math.max(0, currentBalance + points);

      if (existing?.id) {
        const updates: any = {
          current_balance: newBalance,
          updated_at: new Date().toISOString(),
        };
        if (points > 0) {
          updates.total_earned = (existing.total_earned || 0) + points;
        }
        await supabase.from("patient_loyalty_points").update(updates).eq(
          "id",
          existing.id,
        );
      } else {
        await supabase.from("patient_loyalty_points").insert({
          patient_id: patientId,
          lab_id,
          current_balance: newBalance,
          total_earned: points > 0 ? points : 0,
          total_redeemed: 0,
        });
      }

      await supabase.from("loyalty_transactions").insert({
        patient_id: patientId,
        lab_id,
        type: "adjusted",
        points,
        balance_after: newBalance,
        description: reason ||
          `Manual adjustment: ${points > 0 ? "+" : ""}${points} points`,
        created_by: user?.id || null,
      });

      return { data: { newBalance, adjusted: points }, error: null };
    },

    /**
     * Get lab loyalty settings
     */
    getLabSettings: async (): Promise<{ data: any; error: any }> => {
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) return { data: null, error: new Error("No lab_id found") };

      const { data, error } = await supabase
        .from("labs")
        .select(
          "loyalty_enabled, loyalty_conversion_rate, loyalty_min_redeem_points, loyalty_point_value",
        )
        .eq("id", lab_id)
        .single();

      return { data, error };
    },
  },

  reports: {
    getTemplateContext: async (orderId: string) => {
      if (!orderId) {
        return { data: null, error: new Error("orderId is required") };
      }

      const {
        data: { session },
        error: sessionError,
      } = await supabase.auth.getSession();

      if (sessionError) {
        console.error(
          "Failed to load session for template context:",
          sessionError,
        );
        return { data: null, error: sessionError };
      }

      const accessToken = session?.access_token;
      if (!accessToken) {
        return {
          data: null,
          error: new Error("No active session found for current user"),
        };
      }

      let response: Response;
      try {
        response = await fetch("/.netlify/functions/get-template-context", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: supabaseAnonKey,
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ orderId }),
        });
      } catch (networkError) {
        console.error(
          "Network error fetching report template context:",
          networkError,
        );
        return {
          data: null,
          error: networkError instanceof Error
            ? networkError
            : new Error("Network error"),
        };
      }

      let payload: {
        success?: boolean;
        context?: ReportTemplateContext;
        error?: string;
      } | null = null;
      try {
        payload = (await response.json()) as typeof payload;
      } catch (parseError) {
        console.error("Failed to parse template context response:", parseError);
        return {
          data: null,
          error: new Error("Invalid response from template context endpoint"),
        };
      }

      if (!response.ok) {
        const message = payload?.error ||
          `Template context request failed with status ${response.status}`;
        return { data: null, error: new Error(message) };
      }

      if (!payload?.success) {
        const message = payload?.error || "Failed to load report context";
        return { data: null, error: new Error(message) };
      }

      const context = payload.context;

      if (!context) {
        return {
          data: null,
          error: new Error("No context returned for order"),
        };
      }

      const placeholderValues = context.placeholderValues;
      const normalizedPlaceholderValues: Record<
        string,
        string | number | boolean | null
      > =
        placeholderValues && typeof placeholderValues === "object" &&
          !Array.isArray(placeholderValues)
          ? (placeholderValues as Record<
            string,
            string | number | boolean | null
          >)
          : {};

      const labBrandingSource =
        context.labBranding && typeof context.labBranding === "object" &&
          !Array.isArray(context.labBranding)
          ? (context.labBranding as {
            defaultHeaderHtml?: unknown;
            defaultFooterHtml?: unknown;
          })
          : undefined;

      const normalizedLabBranding: ReportTemplateLabBranding | undefined =
        labBrandingSource
          ? {
            defaultHeaderHtml:
              typeof labBrandingSource.defaultHeaderHtml === "string"
                ? labBrandingSource.defaultHeaderHtml
                : labBrandingSource.defaultHeaderHtml == null
                ? null
                : String(labBrandingSource.defaultHeaderHtml),
            defaultFooterHtml:
              typeof labBrandingSource.defaultFooterHtml === "string"
                ? labBrandingSource.defaultFooterHtml
                : labBrandingSource.defaultFooterHtml == null
                ? null
                : String(labBrandingSource.defaultFooterHtml),
          }
          : undefined;

      const normalized: ReportTemplateContext = {
        ...context,
        orderId: context.orderId ? String(context.orderId) : "",
        patientId: context.patientId ? String(context.patientId) : null,
        labId: context.labId ? String(context.labId) : null,
        analyteParameters: Array.isArray(context.analyteParameters)
          ? context.analyteParameters.map((
            param,
          ) => (param == null ? "" : String(param))).filter((param) =>
            param.length > 0
          )
          : [],
        testGroupIds: Array.isArray(context.testGroupIds)
          ? context.testGroupIds.map((id) => (id == null ? "" : String(id)))
            .filter((id) => id.length > 0)
          : [],
        analytes: Array.isArray(context.analytes)
          ? (context.analytes as ReportTemplateAnalyteRow[])
          : [],
        placeholderValues: normalizedPlaceholderValues,
        labBranding: normalizedLabBranding,
      };

      return { data: normalized, error: null };
    },

    getAll: async (labIdOverride?: string) => {
      const labId = labIdOverride || await database.getCurrentUserLabId();
      if (!labId) {
        return {
          data: [],
          error: new Error("No lab_id found for current user"),
        };
      }
      const { data, error } = await supabase
        .from("reports")
        .select(
          "id, patient_id, result_id, status, generated_date, doctor, notes, created_at, updated_at, lab_id, patients(name), results(test_name)",
        )
        .eq("lab_id", labId)
        .order("generated_date", { ascending: false });
      return { data, error };
    },

    getById: async (id: string, labIdOverride?: string) => {
      const labId = labIdOverride || await database.getCurrentUserLabId();
      if (!labId) {
        return {
          data: null,
          error: new Error("No lab_id found for current user"),
        };
      }
      const { data, error } = await supabase
        .from("reports")
        .select("*")
        .eq("id", id)
        .eq("lab_id", labId)
        .single();
      return { data, error };
    },

    create: async (reportData: any, labIdOverride?: string) => {
      const labId = labIdOverride || await database.getCurrentUserLabId();
      if (!labId) {
        return {
          data: null,
          error: new Error("No lab_id found for current user"),
        };
      }
      const { data, error } = await supabase
        .from("reports")
        .insert([{ ...reportData, lab_id: labId }])
        .select()
        .single();
      return { data, error };
    },

    update: async (id: string, reportData: any, labIdOverride?: string) => {
      const labId = labIdOverride || await database.getCurrentUserLabId();
      if (!labId) {
        return {
          data: null,
          error: new Error("No lab_id found for current user"),
        };
      }
      const { data, error } = await supabase
        .from("reports")
        .update(reportData)
        .eq("id", id)
        .eq("lab_id", labId)
        .select()
        .single();
      return { data, error };
    },

    delete: async (id: string, labIdOverride?: string) => {
      const labId = labIdOverride || await database.getCurrentUserLabId();
      if (!labId) {
        return { error: new Error("No lab_id found for current user") };
      }
      const { error } = await supabase
        .from("reports")
        .delete()
        .eq("id", id)
        .eq("lab_id", labId);
      return { error };
    },

    // Delivery tracking methods
    recordWhatsAppSend: async (reportId: string, params: {
      to: string;
      caption: string;
      sentBy: string;
      includedClinicalSummary: boolean;
      sentVia?: "api" | "manual_link";
    }) => {
      const { data, error } = await supabase
        .from("reports")
        .update({
          whatsapp_sent_at: new Date().toISOString(),
          whatsapp_sent_to: params.to,
          whatsapp_sent_by: params.sentBy,
          whatsapp_caption: params.caption,
          clinical_summary_included: params.includedClinicalSummary,
          whatsapp_sent_via: params.sentVia || "api",
        })
        .eq("id", reportId)
        .select()
        .single();
      return { data, error };
    },

    recordEmailSend: async (reportId: string, params: {
      to: string;
      sentBy: string;
      includedClinicalSummary: boolean;
    }) => {
      const { data, error } = await supabase
        .from("reports")
        .update({
          email_sent_at: new Date().toISOString(),
          email_sent_to: params.to,
          email_sent_by: params.sentBy,
          clinical_summary_included: params.includedClinicalSummary,
        })
        .eq("id", reportId)
        .select()
        .single();
      return { data, error };
    },

    recordDoctorNotification: async (reportId: string, params: {
      via: "whatsapp" | "email" | "both";
      sentBy: string;
      sentVia?: "api" | "manual_link";
    }) => {
      const { data, error } = await supabase
        .from("reports")
        .update({
          doctor_informed_at: new Date().toISOString(),
          doctor_informed_via: params.via,
          doctor_informed_by: params.sentBy,
          doctor_sent_via: params.sentVia || "api",
        })
        .eq("id", reportId)
        .select()
        .single();
      return { data, error };
    },

    getDeliveryStatus: async (reportId: string) => {
      const { data, error } = await supabase
        .from("reports")
        .select(`
          whatsapp_sent_at,
          whatsapp_sent_to,
          whatsapp_sent_by,
          whatsapp_caption,
          whatsapp_sent_via,
          email_sent_at,
          email_sent_to,
          email_sent_by,
          email_sent_via,
          doctor_informed_at,
          doctor_informed_via,
          doctor_informed_by,
          doctor_sent_via,
          clinical_summary_included
        `)
        .eq("id", reportId)
        .single();
      return { data, error };
    },

    wasAlreadySent: async (
      reportId: string,
      type: "whatsapp" | "email" | "doctor",
    ) => {
      const { data, error } = await supabase
        .from("reports")
        .select(`
          whatsapp_sent_at,
          email_sent_at,
          doctor_informed_at
        `)
        .eq("id", reportId)
        .single();

      if (error || !data) return false;

      if (type === "whatsapp") return !!data.whatsapp_sent_at;
      if (type === "email") return !!data.email_sent_at;
      if (type === "doctor") return !!data.doctor_informed_at;
      return false;
    },

    getByOrderId: async (orderId: string) => {
      const { data, error } = await supabase
        .from("reports")
        .select("*")
        .eq("order_id", orderId)
        .eq("report_type", "final")
        .maybeSingle();
      return { data, error };
    },
  },

  labTemplates: {
    list: async (labIdOverride?: string) => {
      const labId = labIdOverride || await database.getCurrentUserLabId();
      if (!labId) {
        return {
          data: [],
          error: new Error("No lab_id found for current user"),
        };
      }

      const { data, error } = await supabase
        .from("lab_templates")
        .select("*")
        .eq("lab_id", labId)
        .order("template_name", { ascending: true });

      return { data: (data as any[]) || [], error };
    },

    getById: async (templateId: string, labIdOverride?: string) => {
      const labId = labIdOverride || await database.getCurrentUserLabId();
      if (!labId) {
        return {
          data: null,
          error: new Error("No lab_id found for current user"),
        };
      }

      const { data, error } = await supabase
        .from("lab_templates")
        .select("*")
        .eq("lab_id", labId)
        .eq("id", templateId)
        .single();

      return { data, error };
    },

    create: async (params: {
      labId?: string;
      name: string;
      description?: string | null;
      category?: string | null;
      testGroupId?: string | null;
      project?: any;
      html?: string | null;
      css?: string | null;
      components?: any;
      styles?: any;
      userId?: string | null;
      isDefault?: boolean;
      isInterpretationOnly?: boolean;
    }) => {
      const labId = params.labId || await database.getCurrentUserLabId();
      if (!labId) {
        return {
          data: null,
          error: new Error("No lab_id found for current user"),
        };
      }

      const payload = {
        lab_id: labId,
        template_name: params.name,
        template_description: params.description ?? null,
        test_group_id: params.testGroupId ?? null,
        category: params.category ?? "general",
        gjs_project: params.project ?? null,
        gjs_html: params.html ?? null,
        gjs_css: params.css ?? null,
        gjs_components: params.components ?? null,
        gjs_styles: params.styles ?? null,
        is_default: params.isDefault ?? false,
        is_interpretation_only: params.isInterpretationOnly ?? false,
        created_by: params.userId ?? null,
        updated_by: params.userId ?? null,
      };

      const { data, error } = await supabase
        .from("lab_templates")
        .insert([payload])
        .select("*")
        .single();

      if (error || !data) {
        return { data: null, error };
      }

      await supabase
        .from("lab_template_versions")
        .insert({
          template_id: data.id,
          version_number: 1,
          gjs_project: params.project ?? null,
          gjs_html: params.html ?? null,
          gjs_css: params.css ?? null,
          gjs_components: params.components ?? null,
          gjs_styles: params.styles ?? null,
          created_by: params.userId ?? null,
          version_name: "Initial",
        });

      return { data, error: null };
    },

    saveProject: async (params: {
      templateId: string;
      labId?: string;
      project: any;
      html?: string | null;
      css?: string | null;
      components?: any;
      styles?: any;
      userId?: string | null;
    }) => {
      const labId = params.labId || await database.getCurrentUserLabId();
      if (!labId) {
        return {
          data: null,
          error: new Error("No lab_id found for current user"),
        };
      }

      const existing = await supabase
        .from("lab_templates")
        .select("template_version")
        .eq("lab_id", labId)
        .eq("id", params.templateId)
        .single();

      if (existing.error) {
        return { data: null, error: existing.error };
      }

      const currentVersion =
        (existing.data?.template_version as number | null) ?? 1;
      const nextVersion = currentVersion + 1;

      const { data, error } = await supabase
        .from("lab_templates")
        .update({
          gjs_project: params.project ?? null,
          gjs_html: params.html ?? null,
          gjs_css: params.css ?? null,
          gjs_components: params.components ?? null,
          gjs_styles: params.styles ?? null,
          template_version: nextVersion,
          updated_by: params.userId ?? null,
        })
        .eq("lab_id", labId)
        .eq("id", params.templateId)
        .select("*")
        .single();

      if (error || !data) {
        return { data: null, error };
      }

      await supabase
        .from("lab_template_versions")
        .insert({
          template_id: params.templateId,
          version_number: nextVersion,
          gjs_project: params.project ?? null,
          gjs_html: params.html ?? null,
          gjs_css: params.css ?? null,
          gjs_components: params.components ?? null,
          gjs_styles: params.styles ?? null,
          created_by: params.userId ?? null,
          version_name: `v${nextVersion}`,
        });

      return { data, error: null };
    },

    updateMetadata: async (params: {
      templateId: string;
      labId?: string;
      name?: string;
      description?: string | null;
      category?: string | null;
      testGroupId?: string | null;
      isDefault?: boolean;
      isInterpretationOnly?: boolean;
      userId?: string | null;
    }) => {
      const labId = params.labId || (await database.getCurrentUserLabId());
      if (!labId) {
        return {
          data: null,
          error: new Error("No lab_id found for current user"),
        };
      }

      const updates: Record<string, any> = {
        updated_by: params.userId ?? null,
      };

      if (typeof params.name === "string") {
        updates.template_name = params.name;
      }
      if (params.description !== undefined) {
        updates.template_description = params.description;
      }
      if (params.category !== undefined) {
        updates.category = params.category ?? null;
      }
      if (params.testGroupId !== undefined) {
        updates.test_group_id = params.testGroupId ?? null;
      }
      if (typeof params.isDefault === "boolean") {
        updates.is_default = params.isDefault;
      }
      if (typeof params.isInterpretationOnly === "boolean") {
        updates.is_interpretation_only = params.isInterpretationOnly;
      }

      const { data, error } = await supabase
        .from("lab_templates")
        .update(updates)
        .eq("lab_id", labId)
        .eq("id", params.templateId)
        .select("*")
        .single();

      return { data, error };
    },

    updateVerification: async (params: {
      templateId: string;
      labId?: string;
      status: string;
      summary?: string | null;
      details?: Record<string, any> | null;
      checkedAt?: string;
      userId?: string | null;
    }) => {
      const labId = params.labId || (await database.getCurrentUserLabId());
      if (!labId) {
        return {
          data: null,
          error: new Error("No lab_id found for current user"),
        };
      }

      const updates: Record<string, any> = {
        ai_verification_status: params.status,
        ai_verification_summary: params.summary ?? null,
        ai_verification_details: params.details ?? null,
        ai_verification_checked_at: params.checkedAt ??
          new Date().toISOString(),
        updated_by: params.userId ?? null,
      };

      const { data, error } = await supabase
        .from("lab_templates")
        .update(updates)
        .eq("lab_id", labId)
        .eq("id", params.templateId)
        .select("*")
        .single();

      return { data, error };
    },

    delete: async (templateId: string, labIdOverride?: string) => {
      const labId = labIdOverride || (await database.getCurrentUserLabId());
      if (!labId) {
        return { error: new Error("No lab_id found for current user") };
      }

      // Delete template versions first (foreign key constraint)
      const { error: versionsError } = await supabase
        .from("lab_template_versions")
        .delete()
        .eq("template_id", templateId);

      if (versionsError) {
        return { error: versionsError };
      }

      // Delete the main template
      const { error } = await supabase
        .from("lab_templates")
        .delete()
        .eq("lab_id", labId)
        .eq("id", templateId);

      return { error };
    },
  },

  templateParameters: {
    listLabParameters: async (labIdOverride?: string) => {
      const labId = labIdOverride || (await database.getCurrentUserLabId());
      if (!labId) {
        return {
          data: [],
          error: new Error("No lab_id found for current user"),
        };
      }

      const { data, error } = await supabase
        .from("lab_analytes")
        .select(
          `
            id,
            analyte_id,
            lab_specific_name,
            lab_specific_unit,
            lab_specific_reference_range,
            lab_specific_interpretation_low,
            lab_specific_interpretation_normal,
            lab_specific_interpretation_high,
            name,
            unit,
            reference_range,
            interpretation_low,
            interpretation_normal,
            interpretation_high,
            analytes:analytes!inner ( id, name, unit, reference_range )
          `,
        )
        .eq("lab_id", labId)
        .eq("is_active", true)
        .eq("visible", true)
        .order("lab_specific_name", { ascending: true, nullsFirst: false })
        .order("name", { ascending: true, nullsFirst: false });

      if (error) {
        return { data: [], error };
      }

      const mapped = (data || []).map((row: any) => {
        const baseAnalyte = row.analytes || {};
        const label =
          (row.lab_specific_name || row.name || baseAnalyte.name || "Analyte")
            .trim();
        const slug = label.replace(/[^a-zA-Z0-9]+/g, " ").trim().replace(
          /\s+/g,
          "",
        );

        return {
          id: row.analyte_id || row.id || baseAnalyte.id,
          label,
          placeholder: `{{${slug || "Analyte"}}}`,
          unit: row.lab_specific_unit || row.unit || baseAnalyte.unit || null,
          referenceRange: row.lab_specific_reference_range ||
            row.reference_range ||
            baseAnalyte.reference_range ||
            null,
        };
      });

      return { data: mapped, error: null };
    },

    listTestGroupParameters: async (testGroupId: string) => {
      if (!testGroupId) {
        return { data: [], error: new Error("testGroupId is required") };
      }

      const labId = await database.getCurrentUserLabId();
      if (!labId) {
        return {
          data: [],
          error: new Error("No lab_id found for current user"),
        };
      }

      // Get lab-specific analytes for this test group
      // Include 'code' field for proper placeholder generation matching backend RPC
      const { data, error } = await supabase
        .from("test_group_analytes")
        .select(
          `analyte_id,
           lab_analyte_id,
           created_at,
           analytes!inner ( id, name, code, unit, reference_range, value_type ),
           lab_analytes ( id, name, code, unit, reference_range, lab_specific_reference_range, value_type )`,
        )
        .eq("test_group_id", testGroupId)
        .order("created_at", { ascending: true });

      if (error) {
        return { data: [], error };
      }

      // Build lab_analytes map: prefer direct lab_analyte_id join, fallback to analyte_id+lab_id
      const rowsWithLabAnalyte = (data || []).filter((r: any) => r.lab_analyte_id && r.lab_analytes);
      const rowsWithoutLabAnalyte = (data || []).filter((r: any) => !r.lab_analyte_id || !r.lab_analytes);

      let labAnalytesMap: Record<string, any> = {};

      // Direct lab_analyte_id rows — no ambiguity
      for (const row of rowsWithLabAnalyte) {
        labAnalytesMap[row.analyte_id] = row.lab_analytes;
      }

      // Fallback for legacy rows without lab_analyte_id
      const fallbackIds = rowsWithoutLabAnalyte.map((r: any) => r.analyte_id).filter(Boolean);
      if (fallbackIds.length > 0) {
        const { data: labAnalytes } = await supabase
          .from("lab_analytes")
          .select("*")
          .eq("lab_id", labId)
          .in("analyte_id", fallbackIds)
          .order("created_at", { ascending: true });

        if (labAnalytes) {
          for (const la of labAnalytes) {
            if (!labAnalytesMap[la.analyte_id]) {
              labAnalytesMap[la.analyte_id] = la;
            }
          }
        }
      }

      const mapped = (data || []).map((row: any) => {
        const baseAnalyte = row.analytes || {};
        const labOverride = labAnalytesMap[row.analyte_id] || {};

        // Prefer lab-specific values over base analyte values
        const label = (
          labOverride.lab_specific_name ||
          labOverride.name ||
          baseAnalyte.name ||
          "Unnamed Analyte"
        ).trim();

        // Generate placeholder code that matches backend RPC pattern:
        // Use analyte.code if available, otherwise sanitize the parameter name
        // Pattern: ANALYTE_[CODE]_VALUE (uppercase, alphanumeric only)
        const valueType = (baseAnalyte.value_type || "numeric").toString();
        const isDescriptive = [
          "qualitative",
          "semi_quantitative",
          "descriptive",
        ].includes(
          valueType.toLowerCase(),
        );
        const analyteCode = (!isDescriptive && baseAnalyte.code)
          ? baseAnalyte.code.replace(/[^A-Za-z0-9]+/g, "").toUpperCase()
          : label.replace(/[^A-Za-z0-9]+/g, "").toUpperCase();

        // Main placeholder is ANALYTE_[CODE] (value will be added as suffix in variations)
        const placeholderBase = `ANALYTE_${analyteCode}`;

        return {
          id: baseAnalyte.id || row.analyte_id,
          label,
          // Main placeholder for the VALUE
          placeholder: `{{${placeholderBase}_VALUE}}`,
          // Store the base for generating variations
          placeholderBase,
          unit: labOverride.lab_specific_unit || labOverride.unit ||
            baseAnalyte.unit || null,
          referenceRange: labOverride.lab_specific_reference_range ||
            labOverride.reference_range || baseAnalyte.reference_range || null,
          valueType,
        };
      });

      return { data: mapped, error: null };
    },

    listPatientParameters: async (patientId: string) => {
      if (!patientId) {
        return { data: [], error: new Error("patientId is required") };
      }

      const { data, error } = await supabase
        .from("patients")
        .select(`
          id,
          name,
          gender,
          date_of_birth,
          default_doctor_id,
          default_location_id
        `)
        .eq("id", patientId)
        .single();

      if (error || !data) {
        return { data: [], error: error || new Error("Patient not found") };
      }

      const placeholders = [
        { key: "patientName", label: "Patient Name", value: data.name || "" },
        {
          key: "patientGender",
          label: "Patient Gender",
          value: data.gender || "",
        },
        {
          key: "patientDOB",
          label: "Patient Date of Birth",
          value: data.date_of_birth || "",
        },
        { key: "patientId", label: "Patient ID", value: data.id },
      ];

      const mapped = placeholders.map((item) => ({
        id: item.key,
        label: item.label,
        placeholder: `{{${item.key}}}`,
        value: item.value,
      }));

      return { data: mapped, error: null };
    },
  },

  orders: {
    getAll: async () => {
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) {
        return {
          data: null,
          error: new Error("No lab_id found for current user"),
        };
      }

      const { data, error } = await supabase
        .from("orders")
        .select(`
          *,
          patients(name, age, gender),
          order_tests(test_name, created_at, outsourced_lab_id, outsourced_labs(name)),
          results(id, status, result_values(parameter, value, unit, reference_range, flag))
        `)
        .eq("lab_id", lab_id)
        .order("order_date", { ascending: false });

      if (error || !data) return { data, error };

      // Sort order_tests by creation date (newest first) for each order
      data.forEach((order: any) => {
        if (order.order_tests && order.order_tests.length > 0) {
          order.order_tests.sort((a: any, b: any) => {
            const dateA = new Date(a.created_at || new Date());
            const dateB = new Date(b.created_at || new Date());
            return dateB.getTime() - dateA.getTime();
          });
        }
      });

      // Manually fetch attachments for each order
      const ordersWithAttachments = await Promise.all(
        data.map(async (order) => {
          const { data: orderAttachments } = await supabase
            .from("attachments")
            .select("id, file_url, original_filename, file_type")
            .eq("related_table", "orders")
            .eq("related_id", order.id);

          return {
            ...order,
            attachments: orderAttachments || [],
          };
        }),
      );

      return { data: ordersWithAttachments, error: null };
    },

    getById: async (id: string) => {
      const { data, error } = await supabase
        .from("orders")
        .select(`
          *,
          order_tests(*, created_at, outsourced_lab_id, outsourced_labs(name))
        `)
        .eq("id", id)
        .single();

      // Sort order_tests by creation date (newest first) if data exists
      if (data && data.order_tests) {
        data.order_tests.sort((a: any, b: any) => {
          const dateA = new Date(a.created_at || a.created_at);
          const dateB = new Date(b.created_at || b.created_at);
          return dateB.getTime() - dateA.getTime();
        });
      }

      return { data, error };
    },

    create: async (orderData: any) => {
      // Get current user's lab_id
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) {
        return {
          data: null,
          error: new Error("No lab_id found for current user"),
        };
      }
      // Get current auth user id for created_by
      const { data: auth } = await supabase.auth.getUser();
      const authUserId = auth?.user?.id || null;

      // First get the daily sequence for sample ID generation
      const orderDate = orderData.order_date ||
        new Date().toISOString().split("T")[0];

      // Fetch lab code so the sample_id is namespaced per lab
      // (e.g. "ML001-12-Apr-2026-001" instead of global "12-Apr-2026-001")
      const { data: labRow } = await supabase
        .from("labs")
        .select("code")
        .eq("id", lab_id)
        .maybeSingle();
      const labCode: string | undefined = labRow?.code ?? undefined;

      // Read existing orders for this date and start after the highest used
      // sequence. Counting alone can reuse IDs after deletes or concurrent saves.
      const { data: dailyOrders, error: sequenceError } = await supabase
        .from("orders")
        .select("sample_id, order_number")
        .eq("lab_id", lab_id)
        .gte("order_date", orderDate)
        .lt(
          "order_date",
          new Date(new Date(orderDate).getTime() + 24 * 60 * 60 * 1000)
            .toISOString().split("T")[0],
        );

      if (sequenceError) {
        console.error("Error reading daily order sequence:", sequenceError);
        return { data: null, error: sequenceError };
      }

      // Create the order with sample tracking data and lab_id
      // Strip frontend-only fields that don't exist as DB columns
      const { tests, trfAttachmentId, __createAndNew, __preBarcoded, __preBarcodedBarcode, ...orderDetails } = orderData;
      let dailySequence = Math.max(
        dailyOrders?.length || 0,
        ...(dailyOrders || []).map(getDailySequenceFromOrder),
      ) + 1;

      let order: any = null;
      let lastInsertError: any = null;
      const orderId = orderDetails?.id || crypto.randomUUID();

      for (let attempt = 0; attempt < 10; attempt += 1) {
        const sampleId = generateOrderSampleId(
          new Date(orderDate),
          dailySequence,
          labCode,
        );
        const { color_code, color_name } = getOrderAssignedColor(dailySequence);
        const qrCodeData = generateOrderQRCodeData({
          id: orderId,
          patientId: orderData.patient_id,
          sampleId,
          orderDate,
          colorCode: color_code,
          colorName: color_name,
          patientName: orderData.patient_name,
        });
        const orderWithSample = {
          ...orderDetails,
          id: orderId,
          sample_id: sampleId,
          color_code,
          color_name,
          qr_code_data: qrCodeData,
          lab_id,
          created_by: orderDetails?.created_by ?? authUserId,
          status: orderData.status || "Order Created", // Default status
        };

        const { data: insertedOrder, error } = await supabase
          .from("orders")
          .insert([orderWithSample])
          .select()
          .single();

        if (!error) {
          order = insertedOrder;
          break;
        }

        lastInsertError = error;
        if (!isSampleIdConflictError(error)) {
          return { data: null, error };
        }

        dailySequence += 1;
      }

      if (!order) {
        return {
          data: null,
          error: new Error(
            lastInsertError
              ? "Could not assign a unique sample ID. Please try again."
              : "Order creation failed",
          ),
        };
      }

      const updatedOrder = order;
      let createdOrderTests: any[] = [];

      // Then create the associated tests only if there are tests to create
      if (updatedOrder && tests && Array.isArray(tests) && tests.length > 0) {
        let orderTestsData: any[] = [];

        // Handle both string array (legacy) and object array (new format)
        if (typeof tests[0] === "string") {
          // Legacy format - lookup test_group_ids from test_groups table
          const validTestNames = tests.filter((test) =>
            test && typeof test === "string" && test.trim() !== ""
          );

          if (validTestNames.length > 0) {
            const { data: testGroups, error: testGroupError } = await supabase
              .from("test_groups")
              .select("id, name")
              .in("name", validTestNames);

            if (testGroupError) {
              console.error("Error fetching test groups:", testGroupError);
            }

            // Create a map of test name to test_group_id
            const testGroupMap = new Map<string, string>();
            (testGroups || []).forEach((tg) => {
              testGroupMap.set(tg.name, tg.id);
            });

            orderTestsData = validTestNames.map((testName) => ({
              order_id: updatedOrder.id,
              test_name: testName,
              test_group_id: testGroupMap.get(testName) || null,
              sample_id: updatedOrder.sample_id,
              lab_id,
            }));
          }
        } else {
          // New format - tests are objects with id, name, and type
          const validTestObjects = tests.filter((test) =>
            test &&
            typeof test === "object" &&
            test.name &&
            test.name.trim() !== ""
          );

          // Separate packages from individual tests
          const packages = validTestObjects.filter((test) =>
            test.type === "package"
          );
          const individualTests = validTestObjects.filter((test) =>
            test.type !== "package"
          );

          // Add individual tests with their prices
          orderTestsData = individualTests.map((test) => ({
            order_id: updatedOrder.id,
            test_name: test.name,
            test_group_id: test.id || null,
            package_id: null,
            price: test.price ?? 0, // Store price for billing
            sample_id: updatedOrder.sample_id,
            lab_id,
            outsourced_lab_id: test.outsourced_lab_id || null,
          }));

          // For packages, add both the package record AND expand to individual test groups
          if (packages.length > 0) {
            // Fetch package details with test groups
            const packageIds = packages.map((p) => p.id).filter(Boolean);

            if (packageIds.length > 0) {
              const { data: packageDetails } = await supabase
                .from("packages")
                .select(`
                  id,
                  name,
                  package_test_groups(
                    test_group_id,
                    display_order,
                    test_groups(id, name, is_active)
                  )
                `)
                .in("id", packageIds);

              // Add package entry (with package_id set and PACKAGE PRICE)
              packages.forEach((pkg) => {
                orderTestsData.push({
                  order_id: updatedOrder.id,
                  test_name: `📦 ${pkg.name}`, // Prefix with package emoji for visibility
                  test_group_id: null,
                  package_id: pkg.id,
                  price: pkg.price ?? 0, // Store PACKAGE price for billing
                  sample_id: updatedOrder.sample_id,
                  lab_id,
                  outsourced_lab_id: null,
                });

                // Expand package test groups - these have ₹0 price (included in package)
                const pkgDetails = packageDetails?.find((pd) =>
                  pd.id === pkg.id
                );
                if (pkgDetails?.package_test_groups) {
                  // Expand in the package's own display order
                  sortPackageTestGroups(pkgDetails.package_test_groups).forEach((ptg: any) => {
                    // Skip test groups deactivated after they were linked
                    if (ptg.test_groups && ptg.test_groups.is_active !== false) {
                      orderTestsData.push({
                        order_id: updatedOrder.id,
                        test_name: ptg.test_groups.name,
                        test_group_id: ptg.test_groups.id,
                        package_id: pkg.id, // Link to parent package
                        price: 0, // ₹0 - included in package price
                        sample_id: updatedOrder.sample_id,
                        lab_id,
                        outsourced_lab_id: null,
                      });
                    }
                  });
                }
              });
            }
          }
        }

        if (orderTestsData.length > 0) {
          console.log(
            "Creating order_tests with test_group_ids:",
            orderTestsData,
          );

          const { data: insertedOrderTests, error: orderTestsError } = await supabase
            .from("order_tests")
            .insert(orderTestsData)
            .select(`
              id, order_id, test_group_id, test_name, package_id, price,
              outsourced_lab_id, sample_id,
              test_groups: test_group_id(sample_type, sample_color)
            `);

          if (orderTestsError) {
            console.error("Error creating order tests:", orderTestsError);
            return { data: updatedOrder, error: orderTestsError };
          }
          createdOrderTests = insertedOrderTests || [];

          console.log(
            `✅ Created ${orderTestsData.length} order test records with proper test_group_ids`,
          );

          // ✅ Fix package pricing - update prices after insert to override any trigger
          // Tests inside a package (have package_id AND test_group_id) should be ₹0
          const packageTestsToUpdate = orderTestsData.filter((t) =>
            t.package_id && t.test_group_id
          );
          if (packageTestsToUpdate.length > 0) {
            const testNames = packageTestsToUpdate.map((t) => t.test_name);
            const { error: priceUpdateError } = await supabase
              .from("order_tests")
              .update({ price: 0 })
              .eq("order_id", updatedOrder.id)
              .in("test_name", testNames)
              .not("test_group_id", "is", null); // Only update those with test_group_id (not package entry)

            if (priceUpdateError) {
              console.warn(
                "Could not update package test prices:",
                priceUpdateError,
              );
            } else {
              console.log(
                `✅ Updated ${packageTestsToUpdate.length} package tests to ₹0 price`,
              );

              // Recalculate order total_amount from order_tests to ensure consistency
              const { data: updatedOrderTests } = await supabase
                .from("order_tests")
                .select("price")
                .eq("order_id", updatedOrder.id);

              if (updatedOrderTests) {
                const correctTotal = updatedOrderTests.reduce(
                  (sum, t) => sum + (Number(t.price) || 0),
                  0,
                );
                await supabase
                  .from("orders")
                  .update({ total_amount: correctTotal })
                  .eq("id", updatedOrder.id);
                console.log(
                  `✅ Updated order total_amount to ₹${correctTotal}`,
                );
              }
            }
          }

          // ✅ Auto-create placeholder results for outsourced tests
          const outsourcedTests = orderTestsData.filter((test) =>
            test.outsourced_lab_id
          );
          if (outsourcedTests.length > 0) {
            console.log(
              `Creating ${outsourcedTests.length} placeholder results for outsourced tests`,
            );

            const outsourcedResults = outsourcedTests.map((test) => ({
              order_id: updatedOrder.id,
              patient_id: orderData.patient_id,
              patient_name: orderData.patient_name,
              test_name: test.test_name,
              test_group_id: test.test_group_id,
              lab_id: test.lab_id,
              outsourced_to_lab_id: test.outsourced_lab_id,
              outsourced_status: "pending_send",
              outsourced_logistics_status: "pending_dispatch",
              status: "Entered", // Use valid result_status enum value
              verification_status: "pending_verification",
              entered_by: orderData.created_by || "System",
              entered_date: new Date().toISOString().split("T")[0],
              created_at: new Date().toISOString(),
            }));

            const { error: resultsError } = await supabase
              .from("results")
              .insert(outsourcedResults);

            if (resultsError) {
              console.error("Error creating outsourced results:", resultsError);
              // Don't fail the order creation, just log the error
            } else {
              console.log(
                `✅ Created ${outsourcedResults.length} placeholder results for outsourced tests`,
              );
            }
          }
        }
      }

      const finalData = {
        ...updatedOrder,
        tests: tests || [],
        order_tests: createdOrderTests,
      };

      // Trigger order registration notification (async, don't block response)
      notificationTriggerService.triggerOrderRegistered(updatedOrder.id, lab_id)
        .catch((err) =>
          console.error(
            "Error triggering order registration notification:",
            err,
          )
        );

      database.inventory.consumeScopedItems({
        scope: "per_order",
        orderId: updatedOrder.id,
        sourceRef: updatedOrder.id,
        source: "auto_order",
        reason: "Auto-consumed on order creation",
      }).catch((err) => {
        console.warn("Per-order inventory consumption failed:", err);
      });

      if (updatedOrder.sample_collected_at) {
        database.inventory.consumeScopedItems({
          scope: "per_sample",
          orderId: updatedOrder.id,
          sourceRef: `order:${updatedOrder.id}:registration-collection`,
          source: "auto_sample",
          reason: "Auto-consumed on registration sample collection",
        }).catch((err) => {
          console.warn("Per-sample inventory consumption failed during registration:", err);
        });
      }

      return { data: finalData, error: null };
    },

    update: async (id: string, orderData: any) => {
      const { data, error } = await supabase
        .from("orders")
        .update(orderData)
        .eq("id", id)
        .select()
        .single();
      return { data, error };
    },

    // NEW: Sample collection methods
    markSampleCollected: async (
      orderId: string,
      collectedBy?: string,
      collectorUserId?: string,
    ) => {
      try {
        const { data: auth } = await supabase.auth.getUser();
        const collectorName = collectedBy ||
          auth?.user?.user_metadata?.full_name || auth?.user?.email ||
          "Unknown User";
        const collectorId = collectorUserId || auth?.user?.id;

        const now = new Date().toISOString();
        const { data, error } = await supabase
          .from("orders")
          .update({
            sample_collected_at: now,
            sample_collected_by: collectorName,
            sample_collector_id: collectorId, // NEW: Track collector user ID
            sample_received_at: now, // TAT starts from sample receipt (same as collection when no transit)
            status: "Sample Collection",
            status_updated_at: now,
            status_updated_by: collectorName,
          })
          .eq("id", orderId)
          .select()
          .single();

        if (error) {
          console.error("Error marking sample as collected:", error);
          return { data: null, error };
        }

        const { count: sampleCount, error: sampleCountError } = await supabase
          .from("samples")
          .select("id", { count: "exact", head: true })
          .eq("order_id", orderId);

        if (!sampleCountError && (!sampleCount || sampleCount === 0)) {
          database.inventory.consumeScopedItems({
            scope: "per_sample",
            orderId,
            sourceRef: `order:${orderId}:sample-collection`,
            source: "auto_sample",
            reason: "Auto-consumed on order sample collection",
          }).catch((err) => {
            console.warn("Per-sample inventory consumption failed after markSampleCollected:", err);
          });
        }

        console.log("Sample marked as collected successfully:", data);
        return { data, error: null };
      } catch (err) {
        console.error("Error in markSampleCollected:", err);
        return { data: null, error: err };
      }
    },

    markSampleNotCollected: async (orderId: string) => {
      try {
        const { data: auth } = await supabase.auth.getUser();
        const updaterName = auth?.user?.user_metadata?.full_name ||
          auth?.user?.email || "Unknown User";

        const { data, error } = await supabase
          .from("orders")
          .update({
            sample_collected_at: null,
            sample_collected_by: null,
            status: "Order Created",
            status_updated_at: new Date().toISOString(),
            status_updated_by: updaterName,
          })
          .eq("id", orderId)
          .select()
          .single();

        if (error) {
          console.error("Error marking sample as not collected:", error);
          return { data: null, error };
        }

        console.log("Sample marked as not collected successfully:", data);
        return { data, error: null };
      } catch (err) {
        console.error("Error in markSampleNotCollected:", err);
        return { data: null, error: err };
      }
    },

    updateStatus: async (
      orderId: string,
      newStatus: string,
      updatedBy?: string,
    ) => {
      try {
        const { data: auth } = await supabase.auth.getUser();
        const updaterName = updatedBy || auth?.user?.user_metadata?.full_name ||
          auth?.user?.email || "Unknown User";

        const { data, error } = await supabase
          .from("orders")
          .update({
            status: newStatus,
            status_updated_at: new Date().toISOString(),
            status_updated_by: updaterName,
          })
          .eq("id", orderId)
          .select()
          .single();

        if (error) {
          console.error("Error updating order status:", error);
          return { data: null, error };
        }

        console.log("Order status updated successfully:", data);
        return { data, error: null };
      } catch (err) {
        console.error("Error in updateStatus:", err);
        return { data: null, error: err };
      }
    },
    delete: async (id: string) => {
      const { error } = await supabase
        .from("orders")
        .delete()
        .eq("id", id);
      return { error };
    },

    // Auto-update order status based on results
    checkAndUpdateStatus: async (orderId: string) => {
      try {
        if (!isUuid(orderId)) {
          return { data: null, error: new Error("Invalid order ID") };
        }

        const { data: rpcData, error: rpcError } = await supabase
          .rpc("check_and_update_order_status", { p_order_id: orderId });

        if (!rpcError) {
          const rpcStatus = String((rpcData as any)?.new_status || (rpcData as any)?.status || "");
          const rpcStatusChanged = (rpcData as any)?.status_changed === true;
          if (rpcStatusChanged && (rpcStatus === "Report Ready" || rpcStatus === "Completed")) {
            supabase
              .from("orders")
              .select("lab_id")
              .eq("id", orderId)
              .maybeSingle()
              .then(async ({ data: readyOrder }) => {
                if (!(readyOrder as any)?.lab_id) return;
                const { data: lab } = await supabase
                  .from("labs")
                  .select("pdf_layout_settings")
                  .eq("id", (readyOrder as any).lab_id)
                  .maybeSingle();

                await autoSaveCompactPlannerForOrder(orderId, (readyOrder as any).lab_id, (lab as any)?.pdf_layout_settings);

                if ((lab as any)?.pdf_layout_settings?.compactPrint?.autoOnApproval === true) {
                  supabase.functions
                    .invoke("generate-pdf-letterhead", {
                      body: { orderId, printLayoutMode: "compact" },
                    })
                    .then(() => console.log(`✅ Auto compact print triggered for order ${orderId}`))
                    .catch((e) => console.error("Auto compact print failed:", e));
                }
              })
              .catch((e) => console.error("Auto compact planner RPC follow-up failed:", e));
          }
          return { data: rpcData, error: null };
        }

        console.warn("RPC check_and_update_order_status failed, falling back to client status check:", rpcError);

        // Get order with tests and results
        const { data: order, error: orderError } = await supabase
          .from("orders")
          .select(`
            id, status, lab_id,
            order_tests(id),
            results(id, status, verification_status, result_values(id))
          `)
          .eq("id", orderId)
          .single();

        if (orderError || !order) {
          console.error("Error fetching order for status check:", orderError);
          return { data: null, error: orderError };
        }

        const totalTests = order.order_tests?.length || 0;
        const results = order.results || [];

        // Count results by status
        const resultsWithValues = results.filter((r: any) =>
          r.result_values && r.result_values.length > 0
        );
        const approvedResults = results.filter((r: any) =>
          r.status === "Approved" || r.verification_status === "verified"
        );

        let newStatus = order.status;

        // Determine new status based on completion
        if (order.status === "Sample Collected" || order.status === "In Progress") {
          if (totalTests > 0 && approvedResults.length >= totalTests) {
            // All results verified — jump straight to Report Ready
            newStatus = "Report Ready";
          } else if (order.status === "In Progress" && resultsWithValues.length >= totalTests && totalTests > 0) {
            newStatus = "Pending Approval";
          } else if (order.status === "Sample Collected" && resultsWithValues.length >= totalTests && totalTests > 0) {
            newStatus = "In Progress";
          }
        } else if (order.status === "Pending Approval") {
          // If all results are approved/verified, move to Report Ready
          if (approvedResults.length >= totalTests && totalTests > 0) {
            newStatus = "Report Ready";
          }
        }

        // Update status if it changed
        if (newStatus !== order.status) {
          const { data: updatedOrder, error: updateError } = await supabase
            .from("orders")
            .update({
              status: newStatus,
              status_updated_at: new Date().toISOString(),
              status_updated_by: "System (Auto)",
            })
            .eq("id", orderId)
            .select()
            .single();

          if (updateError) {
            console.error("Error updating order status:", updateError);
            return { data: null, error: updateError };
          }

          console.log(
            `Order ${orderId} status automatically updated from "${order.status}" to "${newStatus}"`,
          );

          // Auto-save compact planner on approval, then optionally auto-generate compact print.
          if ((newStatus === "Report Ready" || newStatus === "Completed") && order.lab_id) {
            supabase
              .from("labs")
              .select("pdf_layout_settings")
              .eq("id", order.lab_id)
              .single()
              .then(async ({ data: lab }) => {
                await autoSaveCompactPlannerForOrder(orderId, order.lab_id, lab?.pdf_layout_settings);

                if (lab?.pdf_layout_settings?.compactPrint?.autoOnApproval === true) {
                  supabase.functions
                    .invoke("generate-pdf-letterhead", {
                      body: { orderId, printLayoutMode: "compact" },
                    })
                    .then(() => console.log(`✅ Auto compact print triggered for order ${orderId}`))
                    .catch((e) => console.error("Auto compact print failed:", e));
                }
              });
          }

          return {
            data: {
              ...updatedOrder,
              statusChanged: true,
              previousStatus: order.status,
            },
            error: null,
          };
        }

        return { data: { ...order, statusChanged: false }, error: null };
      } catch (error) {
        console.error("Error in checkAndUpdateStatus:", error);
        return { data: null, error };
      }
    },

    // Mark order as delivered (manual trigger)
    markAsDelivered: async (orderId: string, deliveredBy?: string) => {
      try {
        const { data: updatedOrder, error } = await supabase
          .from("orders")
          .update({
            status: "Delivered",
            delivered_at: new Date().toISOString(),
            delivered_by: deliveredBy || "System",
            status_updated_at: new Date().toISOString(),
            status_updated_by: deliveredBy || "System",
          })
          .eq("id", orderId)
          .select()
          .single();

        if (error) {
          console.error("Error marking order as delivered:", error);
          return { data: null, error };
        }

        console.log(`Order ${orderId} marked as delivered`);
        return { data: updatedOrder, error: null };
      } catch (error) {
        console.error("Error in markAsDelivered:", error);
        return { data: null, error };
      }
    },

    // Get all orders for a B2B account within a billing period (YYYY-MM)
    getByAccountAndPeriod: async (accountId: string, billingPeriod: string) => {
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) return { data: null, error: new Error("No lab_id found") };

      const [year, month] = billingPeriod.split('-').map(Number);
      const periodStart = `${billingPeriod}-01`;
      const lastDay = new Date(year, month, 0).getDate();
      const periodEnd = `${billingPeriod}-${String(lastDay).padStart(2, '0')}`;

      const { data, error } = await supabase
        .from("orders")
        .select(`
          id, order_number, order_date, total_amount, final_amount, patient_id,
          billing_status,
          patients(name),
          consolidated_invoice_items(consolidated_invoice_id)
        `)
        .eq("lab_id", lab_id)
        .eq("account_id", accountId)
        .gte("order_date", periodStart)
        .lte("order_date", periodEnd)
        .order("order_date", { ascending: true });

      return { data, error };
    },
  },

  results: {
    getAll: async () => {
      const { data, error } = await supabase
        .from("results")
        .select(`
          *, 
          result_values(*), 
          attachment_id, 
          extracted_by_ai, 
          ai_confidence, 
          manually_verified, 
          ai_extraction_metadata
        `) // Include AI and attachment columns
        .order("entered_date", { ascending: false });

      if (error || !data) {
        return { data, error };
      }

      // For each result, if it doesn't have a direct attachment_id,
      // check for attachments linked to its order
      const enrichedData = await Promise.all(
        data.map(async (result) => {
          if (!result.attachment_id && result.order_id) {
            // Look for attachments linked to this order
            const { data: orderAttachments } = await supabase
              .from("attachments")
              .select("id, file_url, description, original_filename")
              .eq("related_table", "orders")
              .eq("related_id", result.order_id)
              .order("created_at", { ascending: false })
              .limit(1);

            if (orderAttachments && orderAttachments.length > 0) {
              return {
                ...result,
                attachment_id: orderAttachments[0].id,
                attachment_info: orderAttachments[0],
              };
            }
          }
          return result;
        }),
      );

      return { data: enrichedData, error };
    },

    getById: async (id: string) => {
      const { data, error } = await supabase
        .from("results")
        .select(
          "*, result_values(*), attachment_id, extracted_by_ai, ai_confidence, manually_verified, ai_extraction_metadata",
        )
        .eq("id", id)
        .single();

      if (error || !data) {
        return { data, error };
      }

      // If no direct attachment_id, check for attachments linked to the order
      if (!data.attachment_id && data.order_id) {
        const { data: orderAttachments } = await supabase
          .from("attachments")
          .select("id, file_url, description, original_filename")
          .eq("related_table", "orders")
          .eq("related_id", data.order_id)
          .order("created_at", { ascending: false })
          .limit(1);

        if (orderAttachments && orderAttachments.length > 0) {
          return {
            data: {
              ...data,
              attachment_id: orderAttachments[0].id,
              attachment_info: orderAttachments[0],
            },
            error: null,
          };
        }
      }

      return { data, error };
    },

    getByOrderId: async (orderId: string) => {
      const { data, error } = await supabase
        .from("results")
        .select(
          "*, result_values(*), attachment_id, extracted_by_ai, ai_confidence, manually_verified, ai_extraction_metadata",
        )
        .eq("order_id", orderId)
        .order("entered_date", { ascending: false });

      if (error || !data) {
        return { data, error };
      }

      // For each result, if it doesn't have a direct attachment_id,
      // check for attachments linked to this order
      const enrichedData = await Promise.all(
        data.map(async (result) => {
          if (!result.attachment_id) {
            // Look for attachments linked to this order
            const { data: orderAttachments } = await supabase
              .from("attachments")
              .select("id, file_url, description, original_filename")
              .eq("related_table", "orders")
              .eq("related_id", orderId)
              .order("created_at", { ascending: false })
              .limit(1);

            if (orderAttachments && orderAttachments.length > 0) {
              return {
                ...result,
                attachment_id: orderAttachments[0].id,
                attachment_info: orderAttachments[0],
              };
            }
          }
          return result;
        }),
      );

      return { data: enrichedData, error };
    },
    getByOrderAndTestGroup: async (orderId: string, testGroupId: string) => {
      const { data, error } = await supabase
        .from("results")
        .select("*")
        .eq("order_id", orderId)
        .eq("test_group_id", testGroupId)
        .order("entered_date", { ascending: false })
        .limit(1)
        .maybeSingle();
      return { data, error };
    },
    create: async (resultData: any) => {
      const { values, ...rest } = resultData; // Separate values array
      const { data: result, error } = await supabase
        .from("results")
        .insert([rest]) // This will now include attachment_id and AI fields if provided
        .select()
        .single();

      if (error) {
        return { data: null, error };
      }

      if (result && values && values.length > 0) {
        // First, get all analytes to map parameter names to analyte_ids
        const { data: analytes, error: analytesError } = await supabase
          .from("analytes")
          .select("id, name");

        if (analytesError) {
          console.error("Error fetching analytes:", analytesError);
          return { data: null, error: analytesError };
        }

        // Create a map of analyte names to IDs
        const analyteMap = new Map(analytes?.map((a) => [a.name, a.id]) || []);

        // Resolve lab_analyte_id for each analyte in the lab context
        const labId = rest.lab_id || result.lab_id;
        const resolvedAnalyteIds = values.map((v: any) => v.analyte_id || analyteMap.get(v.parameter)).filter(Boolean) as string[];
        const labAnalyteMap = new Map<string, string>();
        if (labId && resolvedAnalyteIds.length > 0) {
          const { data: laRows } = await supabase
            .from('lab_analytes')
            .select('id, analyte_id')
            .eq('lab_id', labId)
            .in('analyte_id', resolvedAnalyteIds)
            .order('created_at', { ascending: true });
          if (laRows) {
            for (const la of laRows) {
              if (!labAnalyteMap.has(la.analyte_id)) labAnalyteMap.set(la.analyte_id, la.id);
            }
          }
        }

        const resultValuesToInsert = values.map((val: any) => ({
          result_id: result.id,
          order_id: result.order_id, // Add order_id for trigger compatibility
          analyte_id: val.analyte_id || analyteMap.get(val.parameter) || null, // Use provided ID or map parameter name
          lab_analyte_id: val.lab_analyte_id || labAnalyteMap.get(val.analyte_id || analyteMap.get(val.parameter) || '') || null,
          parameter: val.parameter, // Keep parameter name as well
          value: val.value,
          unit: val.unit,
	          reference_range: val.reference_range,
	          flag: val.flag,
	          verify_status: val.is_hidden_from_report ? "approved" : (val.verify_status || "pending"),
	          is_hidden_from_report: !!val.is_hidden_from_report,
	          hidden_reason: val.is_hidden_from_report ? (val.hidden_reason || "Hidden from report") : null,
	        }));

        const { error: valuesError } = await supabase
          .from("result_values")
          .insert(resultValuesToInsert);

        if (valuesError) {
          // Optionally, handle rollback of the result if result_values insertion fails
          console.error("Error inserting result values:", valuesError);
          return { data: null, error: valuesError };
        }
      }

      // Auto-update order status after result creation
      if (result.order_id) {
        await database.orders.checkAndUpdateStatus(result.order_id);
      }

      return { data: result, error: null };
    },

    update: async (id: string, resultData: any) => {
      const { values, ...rest } = resultData; // Separate values array from main result data

      // First update the main result record
      const { data: result, error } = await supabase
        .from("results")
        .update(rest)
        .eq("id", id)
        .select()
        .single();

      if (error) {
        return { data: null, error };
      }

      // If values are provided, update the result_values table
      if (result && values && values.length > 0) {
        // First delete existing result_values for this result
        const { error: deleteError } = await supabase
          .from("result_values")
          .delete()
          .eq("result_id", id);

        if (deleteError) {
          console.error("Error deleting existing result values:", deleteError);
          return { data: null, error: deleteError };
        }

        // Then insert the new result_values
        // First, get all analytes to map parameter names to analyte_ids
        const { data: analytes, error: analytesError } = await supabase
          .from("analytes")
          .select("id, name");

        if (analytesError) {
          console.error("Error fetching analytes:", analytesError);
          return { data: null, error: analytesError };
        }

        // Create a map of analyte names to IDs
        const analyteMap = new Map(analytes?.map((a) => [a.name, a.id]) || []);

        // Resolve lab_analyte_id for each analyte in the lab context
        const labId = rest.lab_id || result.lab_id;
        const resolvedAnalyteIds = values.map((v: any) => v.analyte_id || analyteMap.get(v.parameter)).filter(Boolean) as string[];
        const labAnalyteMapUpd = new Map<string, string>();
        if (labId && resolvedAnalyteIds.length > 0) {
          const { data: laRows } = await supabase
            .from('lab_analytes')
            .select('id, analyte_id')
            .eq('lab_id', labId)
            .in('analyte_id', resolvedAnalyteIds)
            .order('created_at', { ascending: true });
          if (laRows) {
            for (const la of laRows) {
              if (!labAnalyteMapUpd.has(la.analyte_id)) labAnalyteMapUpd.set(la.analyte_id, la.id);
            }
          }
        }

        const resultValuesToInsert = values.map((val: any) => ({
          result_id: id,
          order_id: result.order_id, // Add order_id for trigger compatibility
          analyte_id: val.analyte_id || analyteMap.get(val.parameter) || null, // Use provided ID or map parameter name
          lab_analyte_id: val.lab_analyte_id || labAnalyteMapUpd.get(val.analyte_id || analyteMap.get(val.parameter) || '') || null,
          parameter: val.parameter, // Keep parameter name as well
          value: val.value,
          unit: val.unit,
	          reference_range: val.reference_range,
	          flag: val.flag,
	          verify_status: val.is_hidden_from_report ? "approved" : (val.verify_status || "pending"),
	          is_hidden_from_report: !!val.is_hidden_from_report,
	          hidden_reason: val.is_hidden_from_report ? (val.hidden_reason || "Hidden from report") : null,
	        }));

        const { error: valuesError } = await supabase
          .from("result_values")
          .insert(resultValuesToInsert);

        if (valuesError) {
          console.error("Error inserting updated result values:", valuesError);
          return { data: null, error: valuesError };
        }
      }

      // Auto-update order status after result update (especially for approval)
      if (result.order_id) {
        await database.orders.checkAndUpdateStatus(result.order_id);
      }

      return { data: result, error: null };
    },

    delete: async (id: string) => {
      const { error } = await supabase
        .from("results")
        .delete()
        .eq("id", id);
      return { error };
    },

    getByPatientId: async (patientId: string) => {
      const { data, error } = await supabase
        .from("results")
        .select(
          "*, result_values(*), attachment_id, extracted_by_ai, ai_confidence, manually_verified, ai_extraction_metadata",
        )
        .eq("patient_id", patientId)
        .order("entered_date", { ascending: false });

      if (error || !data) {
        return { data, error };
      }

      // For each result, if it doesn't have a direct attachment_id,
      // check for attachments linked to its order
      const enrichedData = await Promise.all(
        data.map(async (result) => {
          if (!result.attachment_id && result.order_id) {
            // Look for attachments linked to this order
            const { data: orderAttachments } = await supabase
              .from("attachments")
              .select("id, file_url, description, original_filename")
              .eq("related_table", "orders")
              .eq("related_id", result.order_id)
              .order("created_at", { ascending: false })
              .limit(1);

            if (orderAttachments && orderAttachments.length > 0) {
              return {
                ...result,
                attachment_id: orderAttachments[0].id,
                attachment_info: orderAttachments[0],
              };
            }
          }
          return result;
        }),
      );

      return { data: enrichedData, error };
    },

    // New function to get results by attachment ID
    getByAttachmentId: async (attachmentId: string) => {
      const { data, error } = await supabase
        .from("results")
        .select(
          "*, result_values(*), attachment_id, extracted_by_ai, ai_confidence, manually_verified, ai_extraction_metadata",
        )
        .eq("attachment_id", attachmentId)
        .order("entered_date", { ascending: false });
      return { data, error };
    },

    // Get report extras (trend charts, clinical summary) for a result
    getReportExtras: async (resultId: string) => {
      const { data, error } = await supabase
        .from("results")
        .select("report_extras")
        .eq("id", resultId)
        .single();
      return { data: data?.report_extras || null, error };
    },

    // Update report extras (merge with existing)
    updateReportExtras: async (
      resultId: string,
      extras: Record<string, any>,
    ) => {
      // First get existing extras
      const { data: existing } = await supabase
        .from("results")
        .select("report_extras")
        .eq("id", resultId)
        .single();

      const merged = {
        ...(existing?.report_extras || {}),
        ...extras,
        last_updated: new Date().toISOString(),
      };

      const { data, error } = await supabase
        .from("results")
        .update({ report_extras: merged })
        .eq("id", resultId)
        .select("report_extras")
        .single();

      return { data: data?.report_extras || null, error };
    },

    // Get report extras for all results in an order (for PDF generation)
    getReportExtrasForOrder: async (orderId: string) => {
      const { data, error } = await supabase
        .from("results")
        .select("id, report_extras")
        .eq("order_id", orderId)
        .not("report_extras", "is", null);

      if (error || !data) {
        return { data: null, error };
      }

      // Merge all report extras from different results
      const merged: Record<string, any> = {
        trend_charts: [],
        include_trends_in_report: false,
        include_summary_in_report: false,
      };

      for (const result of data) {
        const extras = result.report_extras as Record<string, any>;
        if (!extras) continue;

        // Merge trend charts
        if (extras.trend_charts && extras.trend_charts.length > 0) {
          merged.trend_charts = [
            ...merged.trend_charts,
            ...extras.trend_charts,
          ];
          if (extras.include_trends_in_report) {
            merged.include_trends_in_report = true;
          }
        }

        // Use the first clinical summary found
        if (extras.clinical_summary && !merged.clinical_summary) {
          merged.clinical_summary = extras.clinical_summary;
          merged.include_summary_in_report = extras.include_summary_in_report;
        }
      }

      const hasData = merged.trend_charts?.length || merged.clinical_summary;
      return { data: hasData ? merged : null, error: null };
    },
  },

  resultValues: {
    createMany: async (values: any[]): Promise<{ data: any; error: any }> => {
      if (!values || values.length === 0) {
        return { data: [], error: null };
      }

      const { data, error } = await supabase
        .from("result_values")
        .insert(values)
        .select();

      return { data, error };
    },
    updateVerificationStatus: async (
      resultValueIds: string[],
      status: "approved" | "rejected" | "pending",
      note?: string,
    ): Promise<{ data: any; error: any }> => {
      try {
        // Get current user
        const { data: currentUser } = await database.auth.getCurrentUser();
        if (!currentUser?.user) {
          throw new Error("User not authenticated");
        }

        const updateData: any = {
          verify_status: status,
          verified: status === "approved",
          verified_by: currentUser.user.id,
          verified_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };

        if (note) {
          updateData.verify_note = note;
        }

        const { data, error } = await supabase
          .from("result_values")
          .update(updateData)
          .in("id", resultValueIds)
          .select(`
            id,
            verify_status,
            verified_by,
            verified_at,
            order_id,
            users:verified_by(id, name, email, lab_id)
          `);

        // Log the verification event if we have workflow support
        if (!error && data && data.length > 0) {
          try {
            await database.workflows?.logStepEvent({
              order_id: data[0]?.order_id || "",
              step_name: "result_verification",
              user_id: currentUser.user.id,
              event_data: {
                result_value_ids: resultValueIds,
                status,
                note,
              },
            });
          } catch (workflowError) {
            console.warn("Could not log workflow event:", workflowError);
            // Don't fail the main operation if workflow logging fails
          }
        }

        return { data, error };
      } catch (error) {
        console.error("Error updating verification status:", error);
        return { data: null, error };
      }
    },

    bulkApprove: async (
      resultValueIds: string[],
      note?: string,
    ): Promise<{ data: any; error: any }> => {
      return database.resultValues.updateVerificationStatus(
        resultValueIds,
        "approved",
        note,
      );
    },

    bulkReject: async (
      resultValueIds: string[],
      note?: string,
    ): Promise<{ data: any; error: any }> => {
      return database.resultValues.updateVerificationStatus(
        resultValueIds,
        "rejected",
        note,
      );
    },

    getVerifierSignature: async (
      resultValueId: string,
    ): Promise<string | null> => {
      try {
        const { data, error } = await supabase
          .from("result_values")
          .select(`
            verified_by,
            lab_id,
            users:verified_by(
              id,
              lab_id,
              lab_user_signatures(
                signature_url,
                processed_signature_url,
                imagekit_url,
                is_active
              )
            )
          `)
          .eq("id", resultValueId)
          .eq("verify_status", "approved")
          .single();

        if (
          error || !data?.verified_by ||
          !data.users?.lab_user_signatures?.length
        ) {
          return null;
        }

        // Get the active signature for this user
        const signature = data.users.lab_user_signatures.find((sig: any) =>
          sig.is_active
        );
        if (!signature) return null;

        // Return best available URL
        return signature.imagekit_url || signature.processed_signature_url ||
          signature.signature_url;
      } catch (error) {
        console.error("Error fetching verifier signature:", error);
        return null;
      }
    },

    getApproverInfo: async (
      resultId: string,
    ): Promise<{ userId: string; labId: string } | null> => {
      try {
        const { data, error } = await supabase
          .from("result_values")
          .select(`
            verified_by,
            lab_id,
            users:verified_by(id, email, lab_id)
          `)
          .eq("result_id", resultId)
          .eq("verify_status", "approved")
          .single();

        if (error || !data?.verified_by) return null;

        return {
          userId: data.verified_by,
          labId: data.lab_id || data.users?.lab_id,
        };
      } catch (error) {
        console.error("Error fetching approver info:", error);
        return null;
      }
    },

    getPendingForLab: async (
      labId: string,
    ): Promise<{ data: any[]; error: any }> => {
      try {
        const { data, error } = await supabase
          .from("result_values")
          .select(`
            id,
            parameter,
            value,
            verify_status,
            verified_by,
            verified_at,
            order_id,
            result_id,
            lab_id,
            flag,
            flag_source,
            flag_confidence,
            ai_interpretation,
            ai_audit_status,
            orders(id, order_number, patient_id, patients(name)),
            users:verified_by(id, name, email, lab_id)
          `)
          .eq("lab_id", labId)
          .in("verify_status", ["pending", "rejected"])
          .order("created_at", { ascending: false });

        return { data: data || [], error };
      } catch (error) {
        console.error("Error fetching pending results:", error);
        return { data: [], error };
      }
    },

    // Update result value with AI flag analysis results
    updateWithAIFlag: async (resultValueId: string, updates: {
      flag?: string;
      flag_source?: "rule" | "ai" | "manual";
      flag_confidence?: number;
      ai_interpretation?: string;
      ai_audit_status?: "pending" | "approved" | "rejected";
      ai_audit_notes?: string;
      // Enriched analyte snapshot fields for PDF template
      normal_range_min?: number | null;
      normal_range_max?: number | null;
      low_critical?: string | null;
      high_critical?: string | null;
      reference_range_male?: string | null;
      reference_range_female?: string | null;
      method?: string | null;
      value_type?: string | null;
    }): Promise<{ data: any; error: any }> => {
      try {
        const { data, error } = await supabase
          .from("result_values")
          .update({
            ...updates,
            updated_at: new Date().toISOString(),
          })
          .eq("id", resultValueId)
          .select()
          .single();
        return { data, error };
      } catch (error) {
        console.error("Error updating result value with AI flag:", error);
        return { data: null, error };
      }
    },

    // Bulk update result values with AI flags
    bulkUpdateWithAIFlags: async (
      updates: Array<{
        id: string;
        flag?: string;
        flag_source?: "rule" | "ai" | "manual";
        flag_confidence?: number;
        ai_interpretation?: string;
        ai_audit_status?: "pending" | "approved" | "rejected";
        reference_range?: string | null;
        // Enriched analyte snapshot fields for PDF template
        normal_range_min?: number | null;
        normal_range_max?: number | null;
        low_critical?: string | null;
        high_critical?: string | null;
        reference_range_male?: string | null;
        reference_range_female?: string | null;
        method?: string | null;
        value_type?: string | null;
      }>,
    ): Promise<{ success: number; failed: number }> => {
      let successCount = 0;
      let failedCount = 0;

      for (const update of updates) {
        const { error } = await supabase
          .from("result_values")
          .update({
            flag: update.flag,
            flag_source: update.flag_source,
            flag_confidence: update.flag_confidence,
            ai_interpretation: update.ai_interpretation,
            ai_audit_status: update.ai_audit_status,
            ...(update.reference_range !== undefined
              ? { reference_range: update.reference_range }
              : {}),
            // Enriched analyte snapshot fields (only set if provided)
            ...(update.normal_range_min !== undefined
              ? { normal_range_min: update.normal_range_min }
              : {}),
            ...(update.normal_range_max !== undefined
              ? { normal_range_max: update.normal_range_max }
              : {}),
            ...(update.low_critical !== undefined
              ? { low_critical: update.low_critical }
              : {}),
            ...(update.high_critical !== undefined
              ? { high_critical: update.high_critical }
              : {}),
            ...(update.reference_range_male !== undefined
              ? { reference_range_male: update.reference_range_male }
              : {}),
            ...(update.reference_range_female !== undefined
              ? { reference_range_female: update.reference_range_female }
              : {}),
            ...(update.method !== undefined ? { method: update.method } : {}),
            ...(update.value_type !== undefined
              ? { value_type: update.value_type }
              : {}),
            updated_at: new Date().toISOString(),
          })
          .eq("id", update.id);

        if (error) {
          console.error(`Failed to update result ${update.id}:`, error);
          failedCount++;
        } else {
          successCount++;
        }
      }

      return { success: successCount, failed: failedCount };
    },

    // Get result value with full flag context for verification
    getWithFlagContext: async (
      resultValueId: string,
    ): Promise<{ data: any; error: any }> => {
      try {
        const { data, error } = await supabase
          .from("result_values")
          .select(`
            *,
            results:result_id(
              id,
              order_id,
              test_group_id,
              orders:order_id(
                id,
                order_number,
                patient_id,
                patients:patient_id(name, gender, dob)
              )
            ),
            analytes:analyte_id(
              id,
              name,
              unit,
              reference_range,
              reference_range_male,
              reference_range_female,
              low_critical,
              high_critical,
              value_type,
              expected_normal_values,
              flag_rules,
              interpretation_low,
              interpretation_normal,
              interpretation_high
            )
          `)
          .eq("id", resultValueId)
          .single();

        return { data, error };
      } catch (error) {
        console.error("Error fetching result value with flag context:", error);
        return { data: null, error };
      }
    },

    // Get all result values for an order with flag details (used by PDF and verification)
    getForOrderWithFlags: async (
      orderId: string,
    ): Promise<{ data: any[]; error: any }> => {
      try {
        const { data, error } = await supabase
          .from("result_values")
          .select(`
            id,
            lab_id,
            parameter,
            value,
            unit,
            reference_range,
            flag,
            flag_source,
            flag_confidence,
            ai_interpretation,
            ai_audit_status,
            ai_audit_notes,
            verify_status,
            verified_by,
            verified_at,
            analyte_id,
            result_id,
            results:result_id(
              id,
              test_group_id,
              test_groups:test_group_id(id, name, code, category)
            ),
            analytes:analyte_id(
              id,
              name,
              unit,
              reference_range,
              reference_range_male,
              reference_range_female,
              low_critical,
              high_critical,
              value_type,
              expected_normal_values,
              ref_range_knowledge,
              flag_rules,
              interpretation_low,
              interpretation_normal,
              interpretation_high
            )
          `)
          .eq("order_id", orderId)
          .order("parameter");

        return { data: data || [], error };
      } catch (error) {
        console.error("Error fetching result values with flags:", error);
        return { data: [], error };
      }
    },
  },

  invoices: {
    getAll: async () => {
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) {
        return {
          data: null,
          error: new Error("No lab_id found for current user"),
        };
      }

      // Query invoices with basic data
      const { data, error } = await supabase
        .from("invoices")
        .select(`
          *,
          invoice_items(*)
        `)
        .eq("lab_id", lab_id)
        .order("invoice_date", { ascending: false });

      if (error) {
        return { data: null, error };
      }

      // Calculate paid_amount from payments table for each invoice
      const invoicesWithPayments = await Promise.all(
        (data || []).map(async (invoice) => {
          const { data: payments } = await supabase
            .from("payments")
            .select("amount")
            .eq("invoice_id", invoice.id);

          const paid_amount = (payments || []).reduce(
            (sum, p) => sum + parseFloat(p.amount || "0"),
            0,
          );

          return {
            ...invoice,
            paid_amount,
            payment_status: invoice.status,
          };
        }),
      );

      return { data: invoicesWithPayments, error: null };
    },

    getById: async (id: string) => {
      const { data, error } = await supabase
        .from("invoices")
        .select(`
          *,
          invoice_items(*)
        `)
        .eq("id", id)
        .single();
      return { data, error };
    },

    create: async (invoiceData: any) => {
      const { invoice_items, ...invoiceDetails } = invoiceData;

      // Get current user's lab_id
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) {
        return {
          data: null,
          error: new Error("No lab_id found for current user"),
        };
      }

      // Ensure location_id is populated
      let location_id = invoiceDetails.location_id;
      if (!location_id) {
        // Try to get from order if order_id is provided
        if (invoiceDetails.order_id) {
          const { data: order } = await supabase
            .from("orders")
            .select("location_id")
            .eq("id", invoiceDetails.order_id)
            .single();
          if (order?.location_id) {
            location_id = order.location_id;
          }
        }
        // If still no location, get user's default location
        if (!location_id) {
          const { data: { user } } = await supabase.auth.getUser();
          if (user) {
            const { data: userData } = await supabase
              .from("users")
              .select("default_location_id")
              .eq("id", user.id)
              .single();
            if (userData?.default_location_id) {
              location_id = userData.default_location_id;
            }
          }
        }
        // If still no location, get lab's default location
        if (!location_id && lab_id) {
          const { data: labData } = await supabase
            .from("labs")
            .select("default_processing_location_id")
            .eq("id", lab_id)
            .single();
          if (labData?.default_processing_location_id) {
            location_id = labData.default_processing_location_id;
          }
        }
      }

      // First create the invoice with lab_id and location_id
      const { data: invoice, error } = await supabase
        .from("invoices")
        .insert([{ ...invoiceDetails, lab_id, location_id }])
        .select()
        .single();

      if (error) {
        return { data: null, error };
      }

      // Then create the associated invoice items
      if (invoice && invoice_items && invoice_items.length > 0) {
        const invoiceItemsToInsert = invoice_items.map((item: any) => ({
          ...item,
          invoice_id: invoice.id,
          lab_id,
        }));

        const { error: itemsError } = await supabase
          .from("invoice_items")
          .insert(invoiceItemsToInsert);

        if (itemsError) {
          console.error("Error inserting invoice items:", itemsError);
          return { data: invoice, error: itemsError };
        }
      }

      return { data: { ...invoice, invoice_items }, error: null };
    },

    update: async (id: string, invoiceData: any) => {
      const { data, error } = await supabase
        .from("invoices")
        .update(invoiceData)
        .eq("id", id)
        .select()
        .single();
      return { data, error };
    },

    delete: async (id: string) => {
      const { error } = await supabase
        .from("invoices")
        .delete()
        .eq("id", id);
      return { error };
    },

    // NEW: Dual invoice system methods
    getUnbilledByAccount: async (accountId: string, billingPeriod?: string) => {
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) {
        return {
          data: null,
          error: new Error("No lab_id found for current user"),
        };
      }

      let query = supabase
        .from("invoices")
        .select(`
          *,
          invoice_items(*)
        `)
        .eq("lab_id", lab_id)
        .eq("account_id", accountId)
        .eq("invoice_type", "account")
        .is("consolidated_invoice_id", null); // Not yet consolidated

      if (billingPeriod) {
        query = query.eq("billing_period", billingPeriod);
      }

      const { data, error } = await query.order("invoice_date", {
        ascending: false,
      });
      return { data, error };
    },

    getByBillingPeriod: async (billingPeriod: string) => {
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) {
        return {
          data: null,
          error: new Error("No lab_id found for current user"),
        };
      }

      let query = supabase
        .from("invoices")
        .select(`
          *,
          invoice_items(*),
          accounts(name)
        `)
        .eq("lab_id", lab_id);

      if (billingPeriod) {
        query = query.eq("billing_period", billingPeriod);
      }

      const { data, error } = await query
        .order("account_id")
        .order("invoice_date", { ascending: false });

      return { data, error };
    },

    markAsConsolidated: async (
      invoiceIds: string[],
      consolidatedInvoiceId: string,
    ) => {
      const { data, error } = await supabase
        .from("invoices")
        .update({ consolidated_invoice_id: consolidatedInvoiceId })
        .in("id", invoiceIds)
        .select();

      return { data, error };
    },

    getByOrderId: async (orderId: string) => {
      const { data, error } = await supabase
        .from("invoices")
        .select(`
          *,
          invoice_items(*)
        `)
        .eq("order_id", orderId)
        .order("invoice_date", { ascending: false })
        .limit(1)
        .maybeSingle();

      return { data, error };
    },

    // Get ALL invoices for an order (for orders with multiple invoices due to added tests)
    getAllByOrderId: async (orderId: string) => {
      const { data, error } = await supabase
        .from("invoices")
        .select(`
          *,
          invoice_items(*)
        `)
        .eq("order_id", orderId)
        .order("invoice_date", { ascending: false });

      return { data: data || [], error };
    },

    // Delivery tracking methods for invoices
    recordWhatsAppSend: async (invoiceId: string, params: {
      to: string;
      caption: string;
      sentBy: string;
      sentVia?: "api" | "manual_link";
    }) => {
      const { data, error } = await supabase
        .from("invoices")
        .update({
          whatsapp_sent_at: new Date().toISOString(),
          whatsapp_sent_to: params.to,
          whatsapp_sent_by: params.sentBy || null,
          whatsapp_caption: params.caption,
          whatsapp_sent_via: params.sentVia || "api",
        })
        .eq("id", invoiceId)
        .select()
        .single();
      return { data, error };
    },

    recordEmailSend: async (invoiceId: string, params: {
      to: string;
      sentBy: string;
      sentVia?: "api" | "manual_link";
    }) => {
      const { data, error } = await supabase
        .from("invoices")
        .update({
          email_sent_at: new Date().toISOString(),
          email_sent_to: params.to,
          email_sent_by: params.sentBy || null,
          email_sent_via: params.sentVia || "api",
        })
        .eq("id", invoiceId)
        .select()
        .single();
      return { data, error };
    },

    recordPaymentReminder: async (invoiceId: string, params: {
      sentBy: string;
      sentVia?: "api" | "manual_link";
    }) => {
      const { data, error } = await supabase
        .from("invoices")
        .update({
          last_reminder_at: new Date().toISOString(),
          reminder_sent_by: params.sentBy || null,
        })
        .eq("id", invoiceId)
        .select()
        .single();
      return { data, error };
    },

    getDeliveryStatus: async (invoiceId: string) => {
      const { data, error } = await supabase
        .from("invoices")
        .select(`
          whatsapp_sent_at,
          whatsapp_sent_to,
          whatsapp_sent_by,
          whatsapp_caption,
          whatsapp_sent_via,
          email_sent_at,
          email_sent_to,
          email_sent_by,
          email_sent_via,
          payment_reminder_count,
          last_reminder_at,
          reminder_sent_by
        `)
        .eq("id", invoiceId)
        .single();
      return { data, error };
    },

    wasAlreadySent: async (invoiceId: string, type: "whatsapp" | "email") => {
      const { data, error } = await supabase
        .from("invoices")
        .select(`
          whatsapp_sent_at,
          email_sent_at
        `)
        .eq("id", invoiceId)
        .single();

      if (error || !data) return false;

      if (type === "whatsapp") return !!data.whatsapp_sent_at;
      if (type === "email") return !!data.email_sent_at;
      return false;
    },
  },

  // NEW: Consolidated invoices methods
  consolidatedInvoices: {
    getAll: async () => {
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) {
        return {
          data: null,
          error: new Error("No lab_id found for current user"),
        };
      }

      const { data, error } = await supabase
        .from("consolidated_invoices")
        .select(`
          *,
          account:accounts!consolidated_invoices_account_id_fkey(name)
        `)
        .eq("lab_id", lab_id)
        .order("created_at", { ascending: false });

      return { data, error };
    },

    getById: async (id: string) => {
      const { data, error } = await supabase
        .from("consolidated_invoices")
        .select(`
          *,
          account:accounts!consolidated_invoices_account_id_fkey(name)
        `)
        .eq("id", id)
        .single();

      return { data, error };
    },

    create: async (consolidatedData: any) => {
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) {
        return {
          data: null,
          error: new Error("No lab_id found for current user"),
        };
      }

      const { data, error } = await supabase
        .from("consolidated_invoices")
        .insert([{ ...consolidatedData, lab_id }])
        .select()
        .single();

      return { data, error };
    },

    update: async (id: string, updates: any) => {
      const { data, error } = await supabase
        .from("consolidated_invoices")
        .update(updates)
        .eq("id", id)
        .select()
        .single();

      return { data, error };
    },

    getByAccount: async (accountId: string) => {
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) {
        return {
          data: null,
          error: new Error("No lab_id found for current user"),
        };
      }

      const { data, error } = await supabase
        .from("consolidated_invoices")
        .select("*")
        .eq("lab_id", lab_id)
        .eq("account_id", accountId)
        .order("billing_period_start", { ascending: false });

      return { data, error };
    },
  },

  invoice_items: {
    create: async (items: any[]) => {
      const { data, error } = await supabase
        .from("invoice_items")
        .insert(items)
        .select();
      return { data, error };
    },

    update: async (id: string, itemData: any) => {
      const { data, error } = await supabase
        .from("invoice_items")
        .update(itemData)
        .eq("id", id)
        .select()
        .single();
      return { data, error };
    },

    delete: async (id: string) => {
      const { error } = await supabase
        .from("invoice_items")
        .delete()
        .eq("id", id);
      return { error };
    },
  },

  payments: {
    getByInvoiceId: async (invoiceId: string) => {
      const { data, error } = await supabase
        .from("payments")
        .select("*")
        .eq("invoice_id", invoiceId)
        .order("payment_date", { ascending: false });
      return { data, error };
    },

    create: async (paymentData: any) => {
      // Get current user's lab_id if not already provided
      if (!paymentData.lab_id) {
        const lab_id = await database.getCurrentUserLabId();
        if (!lab_id) {
          return {
            data: null,
            error: new Error("No lab_id found for current user"),
          };
        }
        paymentData.lab_id = lab_id;
      }

      // Get current user info for received_by
      if (!paymentData.received_by) {
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
          paymentData.received_by = user.id;
        }
      }

      // Get location_id from invoice if not provided
      if (!paymentData.location_id && paymentData.invoice_id) {
        const { data: invoice } = await supabase
          .from("invoices")
          .select("location_id, order_id")
          .eq("id", paymentData.invoice_id)
          .single();

        if (invoice?.location_id) {
          paymentData.location_id = invoice.location_id;
        } else if (invoice?.order_id) {
          // If invoice has no location, try to get from order
          const { data: order } = await supabase
            .from("orders")
            .select("location_id")
            .eq("id", invoice.order_id)
            .single();
          if (order?.location_id) {
            paymentData.location_id = order.location_id;
          }
        }

        // If still no location, get user's default location
        if (!paymentData.location_id) {
          const { data: { user } } = await supabase.auth.getUser();
          if (user) {
            const { data: userData } = await supabase
              .from("users")
              .select("default_location_id")
              .eq("id", user.id)
              .single();
            if (userData?.default_location_id) {
              paymentData.location_id = userData.default_location_id;
            }
          }
        }
      }

      const { data, error } = await supabase
        .from("payments")
        .insert([paymentData])
        .select()
        .single();

      if (error) {
        console.error("Error creating payment:", error);
        return { data: null, error };
      }

      // Update invoice status after successful payment
      if (data && paymentData.invoice_id) {
        try {
          console.log(
            "Updating invoice status for invoice:",
            paymentData.invoice_id,
          );

          // Get total payments for this invoice
          const { data: payments, error: paymentsError } = await supabase
            .from("payments")
            .select("amount")
            .eq("invoice_id", paymentData.invoice_id);

          if (paymentsError) {
            console.error("Error fetching payments:", paymentsError);
            return { data, error: null }; // Return payment but log error
          }

          // Get invoice total
          const { data: invoice, error: invoiceError } = await supabase
            .from("invoices")
            .select("total")
            .eq("id", paymentData.invoice_id)
            .single();

          if (invoiceError) {
            console.error("Error fetching invoice:", invoiceError);
            return { data, error: null }; // Return payment but log error
          }

          if (invoice && payments) {
            const totalPaid = payments.reduce(
              (sum, p) => sum + parseFloat(p.amount || "0"),
              0,
            );
            const invoiceTotal = parseFloat(invoice.total || "0");

            let newStatus = "Unpaid";
            if (totalPaid >= invoiceTotal) {
              newStatus = "Paid";
            } else if (totalPaid > 0) {
              newStatus = "Partial";
            }

            console.log("Invoice status update:", {
              invoiceId: paymentData.invoice_id,
              totalPaid,
              invoiceTotal,
              newStatus,
            });

            // Update invoice status
            const { error: updateError } = await supabase
              .from("invoices")
              .update({
                status: newStatus,
                payment_method: paymentData.payment_method,
                payment_date: paymentData.payment_date,
              })
              .eq("id", paymentData.invoice_id);

            if (updateError) {
              console.error("Error updating invoice status:", updateError);
            } else {
              console.log("Invoice status updated successfully to:", newStatus);
            }
          }
        } catch (updateErr) {
          console.error("Exception updating invoice status:", updateErr);
          // Don't fail the whole operation, payment was successful
        }
      }

      return { data, error: null };
    },

    getPaymentSummary: async (
      startDate?: string,
      endDate?: string,
      method?: string,
    ) => {
      // Patient name lives on the invoice, not the payment row
      let query = supabase
        .from("payments")
        .select("*, invoices(patient_name, invoice_number)");

      if (startDate) {
        query = query.gte("payment_date", startDate);
      }

      if (endDate) {
        query = query.lte("payment_date", endDate);
      }

      if (method) {
        query = query.eq("payment_method", method);
      }

      const { data, error } = await query.order("payment_date", {
        ascending: false,
      });
      return { data, error };
    },

    // User-based Daily Collection Report
    getCollectionReport: async (fromDate: string, toDate: string) => {
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) return { data: null, error: new Error('No lab found') };

      const { data: ordersData, error: ordersError } = await supabase
        .from('orders')
        .select('id, order_date, order_number, patient_name, doctor, total_amount, final_amount, created_by, patient_id, patients:patient_id(phone)')
        .eq('lab_id', lab_id)
        .gte('order_date', fromDate)
        .lte('order_date', `${toDate}T23:59:59.999Z`)
        .order('created_by', { ascending: true })
        .order('order_date', { ascending: true });

      if (ordersError) return { data: null, error: ordersError };

      const orders = ordersData || [];
      const orderIds = orders.map((o: any) => o.id).filter(Boolean);

      if (orderIds.length === 0) {
        return { data: { orders: [], invoices: [], payments: [], users: [] }, error: null };
      }

      // Invoices for discount + total_after_discount
      const { data: invoicesData } = await supabase
        .from('invoices')
        .select('id, order_id, total, total_after_discount, discount, status')
        .in('order_id', orderIds);
      const invoices = invoicesData || [];

      // Payments within date range
      const invoiceIds = invoices.map((i: any) => i.id).filter(Boolean);
      let payments: any[] = [];
      if (invoiceIds.length > 0) {
        const { data: paymentsData } = await supabase
          .from('payments')
          .select('invoice_id, amount, payment_method, payment_date')
          .in('invoice_id', invoiceIds)
          .gte('payment_date', fromDate)
          .lte('payment_date', `${toDate}T23:59:59.999Z`);
        payments = paymentsData || [];
      }

      // User names for created_by IDs
      const userIds = [...new Set(orders.map((o: any) => o.created_by).filter(Boolean))];
      let users: any[] = [];
      if (userIds.length > 0) {
        const { data: usersData } = await supabase
          .from('users')
          .select('id, name, email')
          .in('id', userIds as string[]);
        users = usersData || [];
      }

      return { data: { orders, invoices, payments, users }, error: null };
    },

    // For Cash Reconciliation (cash-only, date + location)
    getByDateRange: async (
      fromDate: string,
      toDate: string,
      locationId: string,
    ) => {
      const { data, error } = await supabase
        .from("payments")
        .select("*, invoices(patient_name)")
        .eq("payment_method", "cash")
        .eq("location_id", locationId)
        .gte("payment_date", fromDate)
        .lte("payment_date", toDate)
        .order("created_at");
      return { data, error };
    },
  },

  // =============================================
  // REFUND REQUESTS
  // =============================================
  refundRequests: {
    // Get all refund requests for the lab
    getAll: async (filters?: { status?: string; location_id?: string }) => {
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) {
        return {
          data: null,
          error: new Error("No lab_id found for current user"),
        };
      }

      let query = supabase
        .from("refund_requests")
        .select(`
          *,
          invoices(total, patient_name),
          patients(name, phone),
          users!refund_requests_requested_by_fkey(name)
        `)
        .eq("lab_id", lab_id)
        .order("created_at", { ascending: false });

      if (filters?.status) {
        query = query.eq("status", filters.status);
      }

      if (filters?.location_id) {
        query = query.eq("location_id", filters.location_id);
      }

      const { data, error } = await query;
      return { data, error };
    },

    // Get refund requests for a specific invoice
    getByInvoiceId: async (invoiceId: string) => {
      const { data, error } = await supabase
        .from("refund_requests")
        .select(`
          *,
          users!refund_requests_requested_by_fkey(name),
          users!refund_requests_approved_by_fkey(name),
          users!refund_requests_paid_by_fkey(name)
        `)
        .eq("invoice_id", invoiceId)
        .order("created_at", { ascending: false });
      return { data, error };
    },

    // Get pending approvals (admin view)
    getPendingApprovals: async () => {
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) {
        return {
          data: null,
          error: new Error("No lab_id found for current user"),
        };
      }

      const { data, error } = await supabase
        .from("v_pending_refund_approvals")
        .select("*")
        .eq("lab_id", lab_id)
        .order("created_at", { ascending: true });
      return { data, error };
    },

    // Get daily cash summary with refunds
    getDailyCashSummary: async (date?: string, locationId?: string) => {
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) {
        return {
          data: null,
          error: new Error("No lab_id found for current user"),
        };
      }

      let query = supabase
        .from("v_daily_cash_summary")
        .select("*")
        .eq("lab_id", lab_id);

      if (date) {
        query = query.eq("summary_date", date);
      }

      if (locationId) {
        query = query.eq("location_id", locationId);
      }

      const { data, error } = await query.order("summary_date", {
        ascending: false,
      });
      return { data, error };
    },

    // Get cash refunds paid on a specific date (for reconciliation view)
    getCashRefundsByDate: async (date: string, locationId?: string) => {
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) {
        return {
          data: null,
          error: new Error("No lab_id found for current user"),
        };
      }

      const startOfDay = `${date}T00:00:00`;
      const endOfDay = `${date}T23:59:59.999`;

      let query = supabase
        .from("refund_requests")
        .select(`
          id,
          invoice_id,
          refund_amount,
          refund_method,
          reason_category,
          reason_details,
          paid_at,
          status,
          locations(name),
          users!refund_requests_requested_by_fkey(name)
        `)
        .eq("lab_id", lab_id)
        .eq("refund_method", "cash")
        .eq("status", "paid")
        .gte("paid_at", startOfDay)
        .lte("paid_at", endOfDay)
        .order("paid_at", { ascending: false });

      if (locationId && locationId !== "all") {
        query = query.eq("location_id", locationId);
      }

      const { data, error } = await query;
      return { data, error };
    },

    // Create a new refund request (calls RPC function)
    create: async (refundData: {
      invoice_id: string;
      refund_amount: number;
      refund_method: string;
      reason_category?: string;
      reason_details?: string;
      refunded_items?: any[];
    }) => {
      // RPC function handles user authentication and lookup via email
      const { data, error } = await supabase.rpc("create_refund_request", {
        p_invoice_id: refundData.invoice_id,
        p_refund_amount: refundData.refund_amount,
        p_refund_method: refundData.refund_method,
        p_reason_category: refundData.reason_category || null,
        p_reason_details: refundData.reason_details || null,
        p_refunded_items: refundData.refunded_items || [],
      });
      return { data, error };
    },

    // Approve a refund request (admin only, calls RPC function)
    approve: async (refundId: string, adminNotes?: string) => {
      const { data, error } = await supabase.rpc("approve_refund", {
        p_refund_id: refundId,
        p_admin_notes: adminNotes || null,
      });
      return { data, error };
    },

    // Reject a refund request (admin only, calls RPC function)
    reject: async (refundId: string, rejectionReason: string) => {
      const { data, error } = await supabase.rpc("reject_refund", {
        p_refund_id: refundId,
        p_rejection_reason: rejectionReason,
      });
      return { data, error };
    },

    // Mark refund as paid (admin only, calls RPC function)
    markPaid: async (refundId: string, paymentReference?: string) => {
      const { data, error } = await supabase.rpc("mark_refund_paid", {
        p_refund_id: refundId,
        p_payment_reference: paymentReference || null,
      });
      return { data, error };
    },

    // Cancel a refund request (by requester)
    cancel: async (refundId: string) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        return { data: null, error: new Error("User not authenticated") };
      }

      // Get user's internal ID using email (matches getCurrentUserLabId pattern)
      const { data: userData, error: userError } = await supabase
        .from("users")
        .select("id")
        .eq("email", user.email)
        .eq("status", "Active")
        .single();

      if (userError || !userData) {
        return { data: null, error: new Error("User not found") };
      }

      const { data, error } = await supabase
        .from("refund_requests")
        .update({
          status: "cancelled",
          cancelled_by: userData.id,
          cancelled_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", refundId)
        .in("status", ["draft", "pending_approval"])
        .select()
        .single();
      return { data, error };
    },

    // Get refund statistics for dashboard
    getStats: async () => {
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) {
        return {
          data: null,
          error: new Error("No lab_id found for current user"),
        };
      }

      const { data, error } = await supabase
        .from("refund_requests")
        .select("status, refund_amount")
        .eq("lab_id", lab_id);

      if (error) return { data: null, error };

      const stats = {
        pending_count: 0,
        pending_amount: 0,
        approved_count: 0,
        approved_amount: 0,
        paid_count: 0,
        paid_amount: 0,
        rejected_count: 0,
        total_count: data?.length || 0,
      };

      (data || []).forEach((r) => {
        if (r.status === "pending_approval") {
          stats.pending_count++;
          stats.pending_amount += r.refund_amount;
        } else if (r.status === "approved") {
          stats.approved_count++;
          stats.approved_amount += r.refund_amount;
        } else if (r.status === "paid") {
          stats.paid_count++;
          stats.paid_amount += r.refund_amount;
        } else if (r.status === "rejected") {
          stats.rejected_count++;
        }
      });

      return { data: stats, error: null };
    },
  },

  analytes: {
    getAll: async () => {
      const labId = await database.getCurrentUserLabId();
      if (!labId) {
        console.warn(
          "No lab ID found for current user, fetching all active analytes globally. This might not be the intended behavior for a multi-lab setup.",
        );
        const { data, error } = await supabase
          .from("analytes")
          .select("*")
          .order("name");
        return { data, error };
      }

      // Fetch analytes joined with lab_analytes for the specific lab
      const { data, error } = await supabase
        .from("lab_analytes")
        .select(`
          id,
          sample_type,
          is_active,
          visible,
          category,
          reference_range,
          reference_range_male,
          reference_range_female,
          low_critical,
          high_critical,
          method,
          lab_specific_method,
          ref_range_knowledge,
          lab_specific_reference_range,
          lab_specific_interpretation_low,
          lab_specific_interpretation_normal,
          lab_specific_interpretation_high,
          expected_normal_values,
          expected_value_flag_map,
          value_type,
          code,
          description,
          is_calculated,
          formula,
          formula_variables,
          formula_description,
          calculation_result_type,
          is_critical,
          normal_range_min,
          normal_range_max,
          ai_processing_type,
          name,
          unit,
          display_name,
          default_value,
          test_group_analytes(count),
          analytes(*)
        `)
        .eq("lab_id", labId)
        .eq("is_active", true)
        .eq("visible", true);

      if (error) {
        return { data: null, error };
      }

      // Flatten the structure to match the expected Analyte interface
      const formattedData = Array.isArray(data)
        ? data.map((item) => {
          // item.analytes may be an array or object, handle accordingly
          const analyteObj = Array.isArray(item.analytes)
            ? item.analytes[0]
            : item.analytes;
          if (analyteObj) {
            // Parse expected_normal_values from lab_analytes (may be string or array)
            let expectedNormalValues = analyteObj.expected_normal_values || [];
            if (item.expected_normal_values) {
              // Lab-specific override takes priority
              if (typeof item.expected_normal_values === "string") {
                try {
                  expectedNormalValues = JSON.parse(
                    item.expected_normal_values,
                  );
                } catch {
                  expectedNormalValues = [];
                }
              } else if (Array.isArray(item.expected_normal_values)) {
                expectedNormalValues = item.expected_normal_values;
              }
            }

            // Parse expected_value_flag_map from lab_analytes
            let expectedValueFlagMap = analyteObj.expected_value_flag_map || {};
            if (item.expected_value_flag_map) {
              if (typeof item.expected_value_flag_map === "string") {
                try {
                  expectedValueFlagMap = JSON.parse(
                    item.expected_value_flag_map,
                  );
                } catch { /* keep global */ }
              } else {
                expectedValueFlagMap = item.expected_value_flag_map;
              }
            }

            return {
              ...analyteObj,
              lab_analyte_id: item.id,
              test_group_count: Array.isArray(item.test_group_analytes)
                ? (item.test_group_analytes[0]?.count ?? 0)
                : 0,
              is_active: item.is_active,
              visible: item.visible,
              // Prioritize lab-specific category if it exists, otherwise use global
              category: item.category || analyteObj.category || "General",
              // Prioritize lab-specific critical values if present
              low_critical: item.low_critical ?? analyteObj.low_critical,
              high_critical: item.high_critical ?? analyteObj.high_critical,
              // Prioritize lab-specific method if present
              method: item.lab_specific_method || item.method ||
                analyteObj.method,
              // Prioritize lab-specific values if they exist, otherwise use global
              referenceRange: item.lab_specific_reference_range ||
                item.reference_range || analyteObj.reference_range,
              reference_range: item.lab_specific_reference_range ??
                item.reference_range ?? analyteObj.reference_range,
              reference_range_male: item.reference_range_male ??
                analyteObj.reference_range_male,
              reference_range_female: item.reference_range_female ??
                analyteObj.reference_range_female,
              interpretation: {
                low: item.lab_specific_interpretation_low ||
                  analyteObj.interpretation_low,
                normal: item.lab_specific_interpretation_normal ||
                  analyteObj.interpretation_normal,
                high: item.lab_specific_interpretation_high ||
                  analyteObj.interpretation_high,
              },
              ref_range_knowledge: item.ref_range_knowledge ||
                analyteObj.ref_range_knowledge,
              expected_normal_values: expectedNormalValues,
              expected_value_flag_map: expectedValueFlagMap,
              // Prioritize lab-specific value_type, code, description
              value_type: item.value_type || analyteObj.value_type || "numeric",
              code: item.code || analyteObj.code || "",
              description: item.description || analyteObj.description || "",
              // Prioritize lab-specific overrides for formula/calculated fields
              is_calculated: item.is_calculated ?? analyteObj.is_calculated ?? false,
              formula: item.formula ?? analyteObj.formula ?? null,
              formula_variables: item.formula_variables ?? analyteObj.formula_variables ?? [],
              formula_description: item.formula_description ?? analyteObj.formula_description ?? null,
              calculation_result_type: item.calculation_result_type ?? analyteObj.calculation_result_type ?? "numeric",
              // Prioritize lab-specific critical/range fields
              is_critical: item.is_critical ?? analyteObj.is_critical ?? null,
              normal_range_min: item.normal_range_min ?? analyteObj.normal_range_min ?? null,
              normal_range_max: item.normal_range_max ?? analyteObj.normal_range_max ?? null,
              // Prioritize lab-specific ai_processing_type
              ai_processing_type: item.ai_processing_type ?? analyteObj.ai_processing_type ?? null,
              // Prioritize lab-specific name/unit/display_name
              name: item.name || analyteObj.name,
              unit: item.unit || analyteObj.unit,
              display_name: item.display_name ?? analyteObj.display_name ?? null,
              // Lab-level default value for result entry pre-fill
              default_value: item.default_value ?? null,
              sample_type: item.sample_type ?? analyteObj.sample_type ?? null,
            };
          }
          return null;
        }).filter(Boolean)
        : [];
      return { data: formattedData, error: null };
    },

    // Get global analytes (for master analyte management)
    getAllGlobal: async () => {
      const { data, error } = await supabase
        .from("analytes")
        .select("*")
        .eq("is_global", true)
        .eq("is_active", true)
        .order("name");
      return { data, error };
    },

    // Create a new analyte
	    create: async (analyteData: {
      name: string;
      unit: string;
      reference_range: string;
      reference_range_male?: string;
      reference_range_female?: string;
      low_critical?: string;
      high_critical?: string;
      interpretation_low?: string;
      interpretation_normal?: string;
      interpretation_high?: string;
      category?: string;
      sample_type?: string | null;
      is_global?: boolean;
      is_active?: boolean;
      ai_processing_type?: string;
      ai_prompt_override?: string;
      group_ai_mode?: string;
      ref_range_knowledge?: any;
      // Calculated parameter fields
      is_calculated?: boolean;
      formula?: string | null;
      formula_variables?: string[];
      formula_description?: string | null;
      calculation_result_type?: "numeric" | "text";
      // Flag determination fields
      value_type?:
        | "numeric"
        | "qualitative"
        | "semi_quantitative"
        | "descriptive";
      expected_normal_values?: string[];
      expected_value_flag_map?: Record<string, string>;
      flag_rules?: any;
      code?: string;
      description?: string;
    }) => {
      // First create the analyte in the analytes table
	      const { data, error } = await supabase
	        .from("analytes")
        .insert([{
          name: analyteData.name,
          unit: analyteData.unit,
          reference_range: analyteData.reference_range,
          reference_range_male: analyteData.reference_range_male,
          reference_range_female: analyteData.reference_range_female,
          low_critical: analyteData.low_critical,
          high_critical: analyteData.high_critical,
          interpretation_low: analyteData.interpretation_low,
          interpretation_normal: analyteData.interpretation_normal,
          interpretation_high: analyteData.interpretation_high,
          category: analyteData.category || "General", // Ensure category is never null
          sample_type: analyteData.sample_type || null,
          is_global: analyteData.is_global || false,
          is_active: analyteData.is_active !== false, // Default to true
          ai_processing_type: analyteData.ai_processing_type,
          ai_prompt_override: analyteData.ai_prompt_override,
          group_ai_mode: analyteData.group_ai_mode || "individual",
          ref_range_knowledge: analyteData.ref_range_knowledge || null,
          // Calculated parameter fields
          is_calculated: analyteData.is_calculated || false,
          formula: analyteData.formula || null,
          formula_variables: analyteData.formula_variables || [],
          formula_description: analyteData.formula_description || null,
          calculation_result_type: analyteData.calculation_result_type || "numeric",
          // Flag determination fields
          value_type: analyteData.value_type || "numeric",
          expected_normal_values: analyteData.expected_normal_values || [],
          expected_value_flag_map: analyteData.expected_value_flag_map || {},
          flag_rules: analyteData.flag_rules || null,
          code: analyteData.code || null,
          description: analyteData.description || null,
        }])
        .select()
        .single();

      if (error || !data) {
        return { data, error };
      }

      // Also create a lab_analytes entry for the current user's lab
	      const labId = await database.getCurrentUserLabId();
	      let createdLabAnalyteId: string | null = null;
	      if (labId) {
	        const { data: labAnalyteRow, error: labAnalyteError } = await supabase
	          .from("lab_analytes")
	          .insert([{
	            lab_id: labId,
	            analyte_id: data.id,
	            is_active: true,
	            visible: true,
	            name: data.name,
	            unit: data.unit,
	            category: data.category,
	            sample_type: data.sample_type || null,
	            reference_range: data.reference_range,
	            reference_range_male: data.reference_range_male,
	            reference_range_female: data.reference_range_female,
	            low_critical: data.low_critical,
	            high_critical: data.high_critical,
	            interpretation_low: data.interpretation_low,
	            interpretation_normal: data.interpretation_normal,
            interpretation_high: data.interpretation_high,
            method: data.method || null,
            description: data.description || null,
            ref_range_knowledge: data.ref_range_knowledge || null,
            ai_processing_type: data.ai_processing_type || null,
            ai_prompt_override: data.ai_prompt_override || null,
            group_ai_mode: data.group_ai_mode || "individual",
            is_calculated: data.is_calculated || false,
            formula: data.formula || null,
            formula_variables: data.formula_variables || [],
            formula_description: data.formula_description || null,
            calculation_result_type: data.calculation_result_type || "numeric",
            value_type: data.value_type || "numeric",
            expected_normal_values: data.expected_normal_values || [],
            expected_value_flag_map: data.expected_value_flag_map || {},
            code: data.code || null,
            is_critical: data.is_critical ?? null,
            normal_range_min: data.normal_range_min ?? null,
            normal_range_max: data.normal_range_max ?? null,
            display_name: null,
	            default_value: null,
	          }])
	          .select("id")
	          .single();

	        if (labAnalyteError) {
	          return { data: null, error: labAnalyteError };
	        }

	        createdLabAnalyteId = labAnalyteRow?.id || null;
	      }

	      return {
	        data: {
	          ...data,
	          lab_analyte_id: createdLabAnalyteId,
	        },
	        error,
	      };
	    },

    // Update analyte global status
    updateGlobalStatus: async (analyteId: string, isGlobal: boolean) => {
      const { data, error } = await supabase
        .from("analytes")
        .update({ is_global: isGlobal })
        .eq("id", analyteId)
        .select()
        .single();
      return { data, error };
    },

    // Update analyte
    update: async (analyteId: string, updates: {
      name?: string;
      unit?: string;
      reference_range?: string;
      reference_range_male?: string;
      reference_range_female?: string;
      low_critical?: string;
      high_critical?: string;
      interpretation_low?: string;
      interpretation_normal?: string;
      interpretation_high?: string;
      category?: string;
      is_active?: boolean;
      ai_processing_type?: string;
      ai_prompt_override?: string;
      // Calculated parameter fields
      is_calculated?: boolean;
      formula?: string | null;
      formula_variables?: string[];
      formula_description?: string | null;
      calculation_result_type?: "numeric" | "text";
      // Flag determination fields
      value_type?:
        | "numeric"
        | "qualitative"
        | "semi_quantitative"
        | "descriptive";
      expected_normal_values?: string[];
      flag_rules?: any;
      code?: string;
      description?: string;
    }) => {
      const { data, error } = await supabase
        .from("analytes")
        .update({
          name: updates.name,
          unit: updates.unit,
          reference_range: updates.reference_range,
          reference_range_male: updates.reference_range_male,
          reference_range_female: updates.reference_range_female,
          low_critical: updates.low_critical,
          high_critical: updates.high_critical,
          interpretation_low: updates.interpretation_low,
          interpretation_normal: updates.interpretation_normal,
          interpretation_high: updates.interpretation_high,
          category: updates.category,
          is_active: updates.is_active,
          ai_processing_type: updates.ai_processing_type,
          ai_prompt_override: updates.ai_prompt_override,
          // Calculated parameter fields
          is_calculated: updates.is_calculated,
          formula: updates.formula,
          formula_variables: updates.formula_variables,
          formula_description: updates.formula_description,
          calculation_result_type: updates.calculation_result_type,
          // Flag determination fields
          value_type: updates.value_type,
          expected_normal_values: updates.expected_normal_values,
          flag_rules: updates.flag_rules,
          code: updates.code,
          description: updates.description,
          updated_at: new Date().toISOString(),
        })
        .eq("id", analyteId)
        .select()
        .single();
      return { data, error };
    },
  },

  // Workflow dynamic engine helpers (lab scoped)
  workflows: {
    create: async (payload: {
      name: string;
      description?: string | null;
      type: string;
      category?: string | null;
      is_active?: boolean;
      lab_id?: string | null;
    }) => {
      const { data, error } = await supabase
        .from("workflows")
        .insert({
          ...payload,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .select()
        .single();

      return { data, error };
    },

    getLabWorkflowForTest: async (labId: string, testCode: string) => {
      try {
        // Find mapping
        const { data: mapping, error: mapError } = await supabase
          .from("test_workflow_map")
          .select("id, workflow_version_id")
          .eq("lab_id", labId)
          .eq("test_code", testCode)
          .eq("is_default", true)
          .maybeSingle();
        if (mapError || !mapping) return { data: null, error: mapError };
        const { data: version, error: verError } = await supabase
          .from("workflow_versions")
          .select("id, version, definition, workflow_id")
          .eq("id", mapping.workflow_version_id)
          .single();
        if (verError) return { data: null, error: verError };
        return { data: version, error: null };
      } catch (e: any) {
        return { data: null, error: e };
      }
    },
    getOrderWorkflowInstance: async (orderId: string) => {
      const { data, error } = await supabase
        .from("order_workflow_instances")
        .select(
          "id, workflow_version_id, current_step_id, started_at, completed_at",
        )
        .eq("order_id", orderId)
        .maybeSingle();
      return { data, error };
    },
    createOrderWorkflowInstance: async (
      orderId: string,
      workflowVersionId: string,
      firstStepId: string,
    ) => {
      const { data, error } = await supabase
        .from("order_workflow_instances")
        .insert({
          order_id: orderId,
          workflow_version_id: workflowVersionId,
          current_step_id: firstStepId,
        })
        .select()
        .single();
      return { data, error };
    },
    updateOrderWorkflowCurrentStep: async (
      instanceId: string,
      nextStepId: string | null,
    ) => {
      const patch: any = { current_step_id: nextStepId };
      if (!nextStepId) patch.completed_at = new Date().toISOString();
      const { data, error } = await supabase
        .from("order_workflow_instances")
        .update(patch)
        .eq("id", instanceId)
        .select()
        .single();
      return { data, error };
    },
    insertStepEvent: async (
      instanceId: string,
      stepId: string,
      eventType: string,
      payload?: any,
    ) => {
      const { data, error } = await supabase
        .from("workflow_step_events")
        .insert({
          instance_id: instanceId,
          step_id: stepId,
          event_type: eventType,
          payload,
        })
        .select()
        .single();
      return { data, error };
    },

    logStepEvent: async (eventData: {
      order_id: string;
      step_name: string;
      user_id: string;
      event_data?: any;
    }): Promise<void> => {
      try {
        await supabase
          .from("workflow_step_events")
          .insert({
            ...eventData,
            created_at: new Date().toISOString(),
          });
      } catch (error) {
        console.error("Error logging workflow step event:", error);
      }
    },
  },

  workflowVersions: {
    create: async (payload: {
      workflow_id: string;
      version: string;
      definition: Record<string, unknown>;
      description?: string | null;
      active?: boolean;
    }) => {
      const { data, error } = await supabase
        .from("workflow_versions")
        .insert({
          workflow_id: payload.workflow_id,
          version: parseInt(payload.version) || 1,
          definition: payload.definition,
          description: payload.description || null,
          active: payload.active || false,
          created_at: new Date().toISOString(),
        })
        .select()
        .single();

      return { data, error };
    },

    update: async (versionId: string, updates: Record<string, unknown>) => {
      const { data, error } = await supabase
        .from("workflow_versions")
        .update(updates)
        .eq("id", versionId)
        .select()
        .single();

      return { data, error };
    },

    getById: async (versionId: string) => {
      const { data, error } = await supabase
        .from("workflow_versions")
        .select("*")
        .eq("id", versionId)
        .single();

      return { data, error };
    },

    getAll: async () => {
      const { data, error } = await supabase
        .from("workflow_versions")
        .select(`
          id,
          name,
          description,
          active,
          created_at,
          version,
          definition,
          workflow_id
        `)
        .order("created_at", { ascending: false });

      return { data, error };
    },

    delete: async (versionId: string) => {
      const { error } = await supabase
        .from("workflow_versions")
        .delete()
        .eq("id", versionId);

      return { error };
    },
  },

  testWorkflowMap: {
    async getAll() {
      const labId = await database.getCurrentUserLabId();
      if (!labId) {
        return { data: null, error: new Error("No lab context") };
      }

      const { data, error } = await supabase
        .from("test_workflow_map")
        .select(`
          id,
          test_group_id,
          workflow_version_id,
          test_code,
          is_default,
          is_active,
          priority,
          created_at,
          test_groups (
            id,
            name,
            code,
            category,
            price
          ),
          workflow_versions (
            id,
            name,
            description,
            active
          )
        `)
        .eq("lab_id", labId)
        .order("priority", { ascending: true });

      return { data, error };
    },

    async getByTestGroupId(testGroupId: string) {
      const labId = await database.getCurrentUserLabId();
      if (!labId) {
        return { data: null, error: new Error("No lab context") };
      }

      const { data, error } = await supabase
        .from("test_workflow_map")
        .select(`
          *,
          workflow_versions (
            id,
            name,
            description,
            definition,
            active
          )
        `)
        .eq("test_group_id", testGroupId)
        .eq("lab_id", labId)
        .eq("is_active", true)
        .order("priority", { ascending: true });

      return { data, error };
    },

    async create(mappingData: any) {
      const labId = await database.getCurrentUserLabId();
      if (!labId) {
        return { data: null, error: new Error("No lab context") };
      }

      // Verify the test group belongs to the current lab
      const { data: testGroup } = await supabase
        .from("test_groups")
        .select("lab_id, code")
        .eq("id", mappingData.test_group_id)
        .eq("lab_id", labId)
        .single();

      if (!testGroup) {
        return {
          data: null,
          error: new Error("Test group not found or access denied"),
        };
      }

      const { data, error } = await supabase
        .from("test_workflow_map")
        .insert([{
          ...mappingData,
          lab_id: labId,
          test_code: mappingData.test_code || testGroup.code,
          created_at: new Date().toISOString(),
        }])
        .select()
        .single();

      return { data, error };
    },

    async update(id: string, updates: any) {
      const labId = await database.getCurrentUserLabId();
      if (!labId) {
        return { data: null, error: new Error("No lab context") };
      }

      const { data, error } = await supabase
        .from("test_workflow_map")
        .update({
          ...updates,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id)
        .eq("lab_id", labId)
        .select()
        .single();

      return { data, error };
    },

    async delete(id: string) {
      const labId = await database.getCurrentUserLabId();
      if (!labId) {
        return { data: null, error: new Error("No lab context") };
      }

      const { data, error } = await supabase
        .from("test_workflow_map")
        .delete()
        .eq("id", id)
        .eq("lab_id", labId)
        .select()
        .single();

      return { data, error };
    },
  },

  aiIssues: {
    create: async (payload: {
      workflow_version_id: string;
      issue_type: string;
      description: string;
      severity?: string;
      metadata?: Record<string, unknown> | null;
    }) => {
      const { data, error } = await supabase
        .from("ai_issues")
        .insert({
          ...payload,
          created_at: new Date().toISOString(),
        })
        .select()
        .single();

      return { data, error };
    },
  },

  // Lab-specific analyte management
  labAnalytes: {
    // Get one lab_analyte row by its own primary key
    getById: async (labAnalyteId: string) => {
      const { data, error } = await supabase
        .from("lab_analytes")
        .select(`
          *,
          analytes(*)
        `)
        .eq("id", labAnalyteId)
        .single();
      return { data, error };
    },

    // Get lab-specific analyte configuration
    getByLabAndAnalyte: async (labId: string, analyteId: string, sampleType?: string | null) => {
      const query = supabase
        .from("lab_analytes")
        .select(`
          *,
          analytes(*)
        `)
        .eq("lab_id", labId)
        .eq("analyte_id", analyteId)
        .order("created_at", { ascending: true });

      const { data, error } = await query.limit(10);
      if (error) return { data: null, error };

      const rows = data || [];
      const wanted = normalizeSampleType(sampleType);
      const exact = wanted
        ? rows.find((row: any) => normalizeSampleType(row.sample_type) === wanted)
        : null;
      const generic = rows.find((row: any) => !normalizeSampleType(row.sample_type));
      return { data: exact || generic || rows[0] || null, error: null };
    },

    // Get multiple lab-specific analytes by analyte IDs
    getByLabAndAnalyteIds: async (labId: string, analyteIds: string[]) => {
      if (!labId || !analyteIds.length) {
        return { data: [], error: null };
      }

      const { data, error } = await supabase
        .from("lab_analytes")
        .select(`
          *,
          analytes(*)
        `)
        .eq("lab_id", labId)
        .in("analyte_id", analyteIds);
      return { data: data || [], error };
    },

    // Update lab-specific analyte settings
    updateLabSpecific: async (labId: string, analyteId: string, updates: {
      is_active?: boolean;
      visible?: boolean;
      sample_type?: string | null;
      name?: string;
      unit?: string;
      method?: string;
      reference_range?: string;
      reference_range_male?: string;
      reference_range_female?: string;
      low_critical?: number | string | null;
      high_critical?: number | string | null;
      interpretation_low?: string;
      interpretation_normal?: string;
      interpretation_high?: string;
      category?: string;
      lab_specific_name?: string;
      lab_specific_unit?: string;
      lab_specific_method?: string;
      lab_specific_reference_range?: string;
      lab_specific_reference_range_male?: string;
      lab_specific_reference_range_female?: string;
      lab_specific_low_critical?: string;
      lab_specific_high_critical?: string;
      lab_specific_interpretation_low?: string;
      lab_specific_interpretation_normal?: string;
      lab_specific_interpretation_high?: string;
      ref_range_knowledge?: any;
      // Flag determination fields
      value_type?:
        | "numeric"
        | "qualitative"
        | "semi_quantitative"
        | "descriptive";
      // Report display precision: null = inherit, 0 = round to integer
      decimal_places?: number | null;
      // Leading-zero width for fixed-width printouts: null = inherit, 0 = off
      min_integer_digits?: number | null;
      expected_normal_values?: string[];
      expected_value_flag_map?: Record<string, string>;
      flag_rules?: any;
      code?: string;
      description?: string;
      display_name?: string | null;
      is_critical?: boolean;
      normal_range_min?: number | null;
      normal_range_max?: number | null;
      ai_processing_type?: string | null;
      is_calculated?: boolean;
      formula?: string | null;
      formula_variables?: string[];
      formula_description?: string | null;
      calculation_result_type?: "numeric" | "text";
    }) => {
      const { data, error } = await supabase
        .from("lab_analytes")
        .update(updates)
        .eq("lab_id", labId)
        .eq("analyte_id", analyteId)
        .select()
        .single();
      return { data, error };
    },

    // Update one exact lab_analytes row by its own primary key
    updateFieldsById: async (labAnalyteId: string, updates: Record<string, any>) => {
      const { data, error } = await supabase
        .from("lab_analytes")
        .update(updates)
        .eq("id", labAnalyteId)
        .select()
        .single();
      return { data, error };
    },

    // Update a specific lab_analytes row by its own primary key (for deactivating duplicates)
    updateById: async (labAnalyteId: string, updates: { is_active?: boolean; visible?: boolean }) => {
      const { data, error } = await supabase
        .from("lab_analytes")
        .update(updates)
        .eq("id", labAnalyteId)
        .select()
        .single();
      return { data, error };
    },

    // Add global analytes to a specific lab
    addGlobalAnalytesToLab: async (labId: string) => {
      const { data, error } = await supabase.rpc("add_global_analytes_to_lab", {
        target_lab_id: labId,
      });
      return { data, error };
    },

    // Get all lab analytes for a specific lab (including inactive/invisible ones)
    getAllForLab: async (labId: string) => {
      const { data, error } = await supabase
        .from("lab_analytes")
        .select(`
          *,
          test_group_analytes(count),
          analytes(*)
        `)
        .eq("lab_id", labId)
        .order("analytes(name)");
      return { data, error };
    },

    // Sync global analytes to all labs
    syncGlobalAnalytesToAllLabs: async () => {
      const { data, error } = await supabase.rpc(
        "sync_global_analytes_to_all_labs",
      );
      return { data, error };
    },

    // Get analyte usage statistics
    getUsageStats: async () => {
      const { data, error } = await supabase.rpc("get_analyte_lab_usage_stats");
      return { data, error };
    },

    // Bulk update interpretations for multiple analytes (used by AI interpretation generator)
    updateInterpretations: async (
      labId: string,
      interpretations: Array<{
        analyte_id: string;
        interpretation_low?: string;
        interpretation_normal?: string;
        interpretation_high?: string;
      }>,
    ) => {
      const results: { success: string[]; failed: string[] } = {
        success: [],
        failed: [],
      };

      for (const interp of interpretations) {
        const updates: Record<string, string> = {};
        if (interp.interpretation_low) {
          updates.interpretation_low = interp.interpretation_low;
        }
        if (interp.interpretation_normal) {
          updates.interpretation_normal = interp.interpretation_normal;
        }
        if (interp.interpretation_high) {
          updates.interpretation_high = interp.interpretation_high;
        }

        if (Object.keys(updates).length === 0) continue;

        // First check if lab_analyte exists
        const { data: existing } = await supabase
          .from("lab_analytes")
          .select("id")
          .eq("lab_id", labId)
          .eq("analyte_id", interp.analyte_id)
          .single();

        if (existing) {
          // Update existing lab_analyte
          const { error } = await supabase
            .from("lab_analytes")
            .update(updates)
            .eq("lab_id", labId)
            .eq("analyte_id", interp.analyte_id);

          if (error) {
            console.error(
              `Failed to update interpretations for analyte ${interp.analyte_id}:`,
              error,
            );
            results.failed.push(interp.analyte_id);
          } else {
            results.success.push(interp.analyte_id);
          }
        } else {
          // Create new lab_analyte with interpretations
          const { error } = await supabase
            .from("lab_analytes")
            .insert({
              lab_id: labId,
              analyte_id: interp.analyte_id,
              is_active: true,
              ...updates,
            });

          if (error) {
            console.error(
              `Failed to create lab_analyte with interpretations for ${interp.analyte_id}:`,
              error,
            );
            results.failed.push(interp.analyte_id);
          } else {
            results.success.push(interp.analyte_id);
          }
        }
      }

      return {
        data: results,
        error: results.failed.length > 0
          ? new Error(`Failed to update ${results.failed.length} analytes`)
          : null,
      };
    },
    // ...existing code...
  },

  testGroups: {
    listByLab: async (labIdOverride?: string) => {
      const labId = labIdOverride || (await database.getCurrentUserLabId());
      if (!labId) {
        return {
          data: [],
          error: new Error("No lab_id found for current user"),
        };
      }

      const { data, error } = await supabase
        .from("test_groups")
        .select("id, name, category, lab_id")
        .eq("is_active", true)
        .or(`lab_id.eq.${labId},lab_id.is.null`)
        .order("name", { ascending: true });

      return { data: (data as any[]) || [], error };
    },

    getByLabId: async (labId: string) => {
      const { data, error } = await supabase
        .from("test_groups")
        .select("id, name, category, lab_id, description")
        .eq("is_active", true)
        .or(`lab_id.eq.${labId},lab_id.is.null`)
        .order("name", { ascending: true });

      return { data: (data as any[]) || [], error };
    },

    list: async (labIdOverride?: string) => {
      return database.testGroups.listByLab(labIdOverride);
    },

    getAll: async () => {
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) {
        return {
          data: null,
          error: new Error("No lab_id found for current user"),
        };
      }

      const { data, error } = await supabase
        .from("test_groups")
        .select(`
            id,
            name,
            code,
            category,
            clinical_purpose,
            methodology,
            price,
            turnaround_time,
            tat_hours,
            sample_type,
            sample_condition_options,
            default_sample_condition,
            requires_fasting,
            is_active,
            created_at,
            updated_at,
            default_ai_processing_type,
            group_level_prompt,
            lab_id,
            to_be_copied,
            description,
            department,
            test_type,
            gender,
            sample_color,
            barcode_suffix,
            lmp_required,
            id_required,
            consent_form,
            pre_collection_guidelines,
            flabs_id,
            only_female,
            only_male,
            only_billing,
	            start_from_next_page,
	            report_priority,
	            default_template_style,
	            print_options,
            is_outsourced,
            default_outsourced_lab_id,
            required_patient_inputs,
            ref_range_ai_config,
            collection_charge,
            group_interpretation,
            default_report_remark,
            global_test_catalog_id,
            analyzer_connection_id,
            is_section_only,
            test_group_analytes(
              analyte_id,
              lab_analyte_id,
	              sort_order,
	              section_heading,
	              is_visible,
	              report_display_options,
	              analytes(
                id,
                name,
                code,
                unit,
                reference_range,
                ai_processing_type,
                ai_prompt_override,
                group_ai_mode,
                ref_range_knowledge
              ),
              lab_analytes(
                id,
                name,
                sample_type,
                unit,
                reference_range,
                lab_specific_reference_range,
                value_type,
                expected_normal_values,
                expected_value_codes,
                expected_value_flag_map,
                default_value,
                method,
                low_critical,
                high_critical,
                is_calculated,
                formula,
                formula_variables,
                calculation_result_type,
                ai_processing_type,
                ai_prompt_override,
                group_ai_mode,
                ref_range_knowledge,
                lab_analyte_interface_config(
                  id,
                  analyzer_connection_id,
                  instrument_unit,
                  lims_unit,
                  multiply_by,
                  add_offset,
                  dilution_factor,
                  dilution_mode,
                  auto_verify,
                  notes
                )
              )
            )
        `)
        .eq("lab_id", lab_id)
        .eq("is_active", true)
        .order("name");
      return { data, error };
    },

    getById: async (id: string) => {
      const { data, error } = await supabase
        .from("test_groups")
        .select(`
            id,
            name,
            code,
            category,
            clinical_purpose,
            methodology,
            price,
            turnaround_time,
            tat_hours,
            sample_type,
            sample_condition_options,
            default_sample_condition,
            requires_fasting,
            is_active,
            created_at,
            updated_at,
            default_ai_processing_type,
            group_level_prompt,
            lab_id,
            to_be_copied,
            description,
            department,
            test_type,
            gender,
            sample_color,
            barcode_suffix,
            lmp_required,
            id_required,
            consent_form,
            pre_collection_guidelines,
            flabs_id,
            only_female,
            only_male,
            only_billing,
	            start_from_next_page,
	            report_priority,
	            default_template_style,
	            print_options,
            is_outsourced,
            default_outsourced_lab_id,
            required_patient_inputs,
            ref_range_ai_config,
	            collection_charge,
		            group_interpretation,
		            default_report_remark,
		            global_test_catalog_id,
		            analyzer_connection_id,
	            is_section_only,
	            test_group_analytes(
              analyte_id,
              lab_analyte_id,
	              sort_order,
	              section_heading,
	              is_visible,
	              report_display_options,
	              analytes(
                id,
                name,
                code,
                unit,
                reference_range,
                ai_processing_type,
                ai_prompt_override,
                group_ai_mode,
                ref_range_knowledge
              ),
              lab_analytes(
                id,
                name,
                sample_type,
                unit,
                reference_range,
                lab_specific_reference_range,
                value_type,
                expected_normal_values,
                expected_value_codes,
                expected_value_flag_map,
                default_value,
                method,
                low_critical,
                high_critical,
                is_calculated,
                formula,
                formula_variables,
                calculation_result_type,
                ai_processing_type,
                ai_prompt_override,
                group_ai_mode,
                ref_range_knowledge,
                lab_analyte_interface_config(
                  id,
                  analyzer_connection_id,
                  instrument_unit,
                  lims_unit,
                  multiply_by,
                  add_offset,
                  dilution_factor,
                  dilution_mode,
                  auto_verify,
                  notes
                )
              )
            )
        `)
        .eq("id", id)
        .single();
      return { data, error };
    },

    getByNames: async (names: string[]) => {
      const { data, error } = await supabase
        .from("test_groups")
        .select(`
            id,
            name,
            code,
            category,
            clinical_purpose,
            methodology,
            price,
            turnaround_time,
            tat_hours,
            sample_type,
            sample_condition_options,
            default_sample_condition,
            requires_fasting,
            is_active,
            created_at,
            updated_at,
            default_ai_processing_type,
            group_level_prompt,
            lab_id,
            to_be_copied,
            description,
            department,
            test_type,
            gender,
            sample_color,
            barcode_suffix,
            lmp_required,
            id_required,
            consent_form,
            pre_collection_guidelines,
            flabs_id,
            only_female,
            only_male,
            only_billing,
	            start_from_next_page,
	            report_priority,
	            default_template_style,
	            is_outsourced,
            default_outsourced_lab_id,
            required_patient_inputs,
            ref_range_ai_config,
            default_report_remark,
            test_group_analytes(
              analyte_id,
              lab_analyte_id,
	              sort_order,
	              section_heading,
	              is_visible,
	              report_display_options,
	              analytes(
                id,
                name,
                code,
                unit,
                reference_range,
                ai_processing_type,
                ai_prompt_override,
                group_ai_mode,
                ref_range_knowledge
              ),
              lab_analytes(
                id,
                name,
                sample_type,
                unit,
                reference_range,
                lab_specific_reference_range,
                value_type,
                expected_normal_values,
                expected_value_codes,
                expected_value_flag_map,
                default_value,
                method,
                low_critical,
                high_critical,
                is_calculated,
                formula,
                formula_variables,
                calculation_result_type,
                ai_processing_type,
                ai_prompt_override,
                group_ai_mode,
                ref_range_knowledge
              )
            )
        `)
        .in("name", names)
        .eq("is_active", true);
      return { data, error };
    },

    create: async (testGroupData: any) => {
      try {
        // Ensure all required fields have valid values
        const sanitizedData = {
          name: testGroupData.name || "Unnamed Test Group",
          code: testGroupData.code || "UNNAMED",
          category: testGroupData.category || "Laboratory",
          clinical_purpose: testGroupData.clinicalPurpose ||
            "Clinical assessment and diagnosis",
          methodology: testGroupData.methodology || null,
          price: testGroupData.price || 0,
          turnaround_time: testGroupData.turnaroundTime || "24 hours",
          tat_hours: testGroupData.tat_hours || 3, // TAT in hours for breach calculation
          sample_type: testGroupData.sampleType || "Serum",
          sample_condition_options: Array.isArray(testGroupData.sampleConditionOptions)
            ? testGroupData.sampleConditionOptions
            : [],
          default_sample_condition: testGroupData.defaultSampleCondition || null,
          requires_fasting: testGroupData.requiresFasting || false,
          is_active: testGroupData.isActive !== false,
          default_ai_processing_type:
            testGroupData.default_ai_processing_type || "ocr_report",
          group_level_prompt: testGroupData.group_level_prompt || null,
          lab_id: testGroupData.lab_id || null,
          to_be_copied: testGroupData.to_be_copied || false,
          // New configuration fields
          test_type: testGroupData.testType || "Default",
          gender: testGroupData.gender || "Both",
          sample_color: testGroupData.sampleColor || "Red",
          barcode_suffix: testGroupData.barcodeSuffix || null,
          // Auto-sync legacy booleans from required_patient_inputs
          lmp_required:
            (testGroupData.required_patient_inputs || []).includes("lmp") ||
            testGroupData.lmpRequired || false,
          id_required:
            (testGroupData.required_patient_inputs || []).includes(
              "id_document",
            ) || testGroupData.idRequired || false,
          consent_form:
            (testGroupData.required_patient_inputs || []).includes(
              "consent_form",
            ) || testGroupData.consentForm || false,
          pre_collection_guidelines: testGroupData.preCollectionGuidelines ||
            null,
          flabs_id: testGroupData.flabsId || null,
          only_female: testGroupData.onlyFemale || false,
          only_male: testGroupData.onlyMale || false,
          only_billing: testGroupData.onlyBilling || false,
          start_from_next_page: testGroupData.startFromNextPage || false,
          description: testGroupData.description || null,
          department: testGroupData.department || null,
          ref_range_ai_config: testGroupData.ref_range_ai_config || null,
          required_patient_inputs: testGroupData.required_patient_inputs || [],
          is_outsourced: testGroupData.is_outsourced || false,
          default_outsourced_lab_id: testGroupData.default_outsourced_lab_id || null,
	          default_template_style: testGroupData.default_template_style || null,
	          print_options: testGroupData.print_options ?? null,
	          report_priority: Number.isFinite(Number(testGroupData.report_priority))
	            ? Number(testGroupData.report_priority)
	            : null,
	          collection_charge: testGroupData.collection_charge ?? null,
		          group_interpretation: testGroupData.group_interpretation || null,
		          default_report_remark: testGroupData.default_report_remark || null,
		          global_test_catalog_id: testGroupData.global_test_catalog_id || null,
		          analyzer_connection_id: testGroupData.analyzer_connection_id || null,
	          is_section_only: testGroupData.is_section_only || false,
	        };

        console.log("Creating test group with data:", sanitizedData);

        // Step 1: Create the test group
        const { data: testGroup, error: testGroupError } = await supabase
          .from("test_groups")
          .insert([sanitizedData])
          .select()
          .single();

        if (testGroupError) {
          console.error("Error creating test group:", testGroupError);
          return { data: null, error: testGroupError };
        }

	        // Step 2: Create test group analyte relationships
	        if (testGroupData.analytes && testGroupData.analytes.length > 0) {
          const labId = testGroup.lab_id || testGroupData.lab_id || null;

          // Resolve lab_analyte_id for each analyte. Prefer the row scoped to
          // this test group's sample type, then fall back to generic.
          let labAnalyteMap: Record<string, string> = {};
          if (labId) {
            const { data: laRows } = await supabase
              .from("lab_analytes")
              .select("id, analyte_id, sample_type, created_at")
              .eq("lab_id", labId)
              .in("analyte_id", testGroupData.analytes)
              .order("created_at", { ascending: true });
            labAnalyteMap = buildSampleAwareLabAnalyteMap(laRows, testGroup.sample_type || testGroupData.sampleType);
          }

	          const analyteMetadata: Record<string, { sort_order?: number; section_heading?: string; is_visible?: boolean; report_display_options?: Record<string, unknown> }> =
	            testGroupData.analyteMetadata || {};

	          const analyteRelations = testGroupData.analytes.map((
	            analyteId: string,
	          ) => ({
	            test_group_id: testGroup.id,
	            analyte_id: analyteId,
	            lab_analyte_id: labAnalyteMap[analyteId] || null,
	            sort_order: analyteMetadata[analyteId]?.sort_order ?? 0,
	            section_heading: analyteMetadata[analyteId]?.section_heading || null,
	            is_visible: analyteMetadata[analyteId]?.is_visible ?? true,
	            report_display_options: analyteMetadata[analyteId]?.report_display_options || {},
	          }));

          const { error: relationError } = await supabase
            .from("test_group_analytes")
            .insert(analyteRelations);

          if (relationError) {
            console.error(
              "Error creating test group analyte relations:",
              relationError,
            );
            // Still return the test group even if analyte relations failed
            return { data: testGroup, error: relationError };
	          }
	        }

	        const normalizedCategory = String(testGroup.category || testGroupData.category || "").toLowerCase();
	        const normalizedSampleType = String(testGroup.sample_type || testGroupData.sampleType || "").toLowerCase();
	        const shouldSeedRadiologySections =
	          !!testGroup.is_section_only &&
	          (
	            normalizedCategory.includes("radiology") ||
	            normalizedSampleType.includes("x-ray") ||
	            normalizedSampleType.includes("x ray") ||
	            normalizedSampleType.includes("xray") ||
	            normalizedSampleType.includes("ct") ||
	            normalizedSampleType.includes("usg") ||
	            normalizedSampleType.includes("ultrasound") ||
	            normalizedSampleType.includes("sonography")
	          );

	        if (shouldSeedRadiologySections) {
	          const { data: existingSections } = await supabase
	            .from("lab_template_sections")
	            .select("id")
	            .eq("test_group_id", testGroup.id)
	            .limit(1);

	          if (!existingSections?.length) {
	            await supabase.from("lab_template_sections").insert([
	              {
	                lab_id: testGroup.lab_id,
	                test_group_id: testGroup.id,
	                section_type: "clinical_history",
	                section_name: "Clinical History",
	                placeholder_key: "clinical_history",
	                display_order: 1,
	                default_content: "",
	                predefined_options: [],
	                is_required: false,
	                is_editable: true,
	                allow_images: false,
	                allow_technician_entry: true,
	              },
	              {
	                lab_id: testGroup.lab_id,
	                test_group_id: testGroup.id,
	                section_type: "technique",
	                section_name: "Examination / Technique",
	                placeholder_key: "technique",
	                display_order: 2,
	                default_content: "",
	                predefined_options: [],
	                is_required: false,
	                is_editable: true,
	                allow_images: false,
	                allow_technician_entry: true,
	              },
	              {
	                lab_id: testGroup.lab_id,
	                test_group_id: testGroup.id,
	                section_type: "findings",
	                section_name: "Findings",
	                placeholder_key: "findings",
	                display_order: 3,
	                default_content: "",
	                predefined_options: [],
	                is_required: true,
	                is_editable: true,
	                allow_images: true,
	                allow_technician_entry: true,
	              },
	              {
	                lab_id: testGroup.lab_id,
	                test_group_id: testGroup.id,
	                section_type: "impression",
	                section_name: "Impression",
	                placeholder_key: "impression",
	                display_order: 4,
	                default_content: "",
	                predefined_options: [],
	                is_required: true,
	                is_editable: true,
	                allow_images: false,
	                allow_technician_entry: false,
	              },
	              {
	                lab_id: testGroup.lab_id,
	                test_group_id: testGroup.id,
	                section_type: "recommendation",
	                section_name: "Recommendation",
	                placeholder_key: "recommendation",
	                display_order: 5,
	                default_content: "",
	                predefined_options: [],
	                is_required: false,
	                is_editable: true,
	                allow_images: false,
	                allow_technician_entry: false,
	              },
	            ]);
	          }
	        }

	        return { data: testGroup, error: null };
      } catch (error) {
        console.error("Unexpected error creating test group:", error);
        return { data: null, error };
      }
    },

    update: async (id: string, updates: any) => {
      try {
	        // Step 1: Update the test group
	        const updatePayload: Record<string, any> = {
	            name: updates.name,
	            code: updates.code,
	            category: updates.category,
            clinical_purpose: updates.clinicalPurpose,
            methodology: updates.methodology ?? null,
            price: updates.price,
            turnaround_time: updates.turnaroundTime,
            tat_hours: updates.tat_hours, // TAT in hours for breach calculation
            sample_type: updates.sampleType,
            sample_condition_options: Array.isArray(updates.sampleConditionOptions)
              ? updates.sampleConditionOptions
              : [],
            default_sample_condition: updates.defaultSampleCondition || null,
            requires_fasting: updates.requiresFasting,
            is_active: updates.isActive,
            default_ai_processing_type: updates.default_ai_processing_type,
            group_level_prompt: updates.group_level_prompt,
            // New configuration fields
            test_type: updates.testType,
            gender: updates.gender,
            sample_color: updates.sampleColor,
            barcode_suffix: updates.barcodeSuffix,
            // Auto-sync legacy booleans from required_patient_inputs
            lmp_required:
              (updates.required_patient_inputs || []).includes("lmp") ||
              updates.lmpRequired || false,
            id_required:
              (updates.required_patient_inputs || []).includes("id_document") ||
              updates.idRequired || false,
            consent_form:
              (updates.required_patient_inputs || []).includes(
                "consent_form",
              ) || updates.consentForm || false,
            pre_collection_guidelines: updates.preCollectionGuidelines,
            flabs_id: updates.flabsId,
            only_female: updates.onlyFemale,
            only_male: updates.onlyMale,
            only_billing: updates.onlyBilling,
            start_from_next_page: updates.startFromNextPage,
            description: updates.description ?? null,
            department: updates.department ?? null,
            ref_range_ai_config: updates.ref_range_ai_config,
            required_patient_inputs: updates.required_patient_inputs,
            is_outsourced: updates.is_outsourced,
	            default_outsourced_lab_id: updates.default_outsourced_lab_id,
	            default_template_style: updates.default_template_style || null,
	            print_options: updates.print_options ?? null,
	            report_priority: Number.isFinite(Number(updates.report_priority))
	              ? Number(updates.report_priority)
	              : null,
	            collection_charge: updates.collection_charge ?? null,
	            group_interpretation: updates.group_interpretation ?? null,
	            default_report_remark: updates.default_report_remark ?? null,
	            analyzer_connection_id: updates.analyzer_connection_id || null,
		            is_section_only: updates.is_section_only || false,
		            updated_at: new Date().toISOString(),
	        };
	        if (Object.prototype.hasOwnProperty.call(updates, "global_test_catalog_id")) {
	          updatePayload.global_test_catalog_id = updates.global_test_catalog_id || null;
	        }

	        const { data, error } = await supabase
	          .from("test_groups")
	          .update(updatePayload)
	          .eq("id", id)
	          .select()
	          .single();

        if (error) {
          console.error("Error updating test group:", error);
          return { data: null, error };
        }

        // Step 2: Update analyte relationships if analytes are provided
	        if (updates.analytes && Array.isArray(updates.analytes)) {
          const newAnalyteIds: string[] = updates.analytes;
	          const analyteMetadata: Record<string, { sort_order?: number; section_heading?: string; is_visible?: boolean; report_display_options?: Record<string, unknown> }> =
	            updates.analyteMetadata || {};

          // Resolve lab_analyte_id for each analyte_id. Prefer the row scoped
          // to this test group's sample type, then fall back to generic.
          let labAnalyteMap: Record<string, string> = {};
          const labId = data?.lab_id || null;
          if (labId && newAnalyteIds.length > 0) {
            const { data: laRows } = await supabase
              .from("lab_analytes")
              .select("id, analyte_id, sample_type, created_at")
              .eq("lab_id", labId)
              .in("analyte_id", newAnalyteIds)
              .order("created_at", { ascending: true });
            labAnalyteMap = buildSampleAwareLabAnalyteMap(laRows, data?.sample_type || updates.sampleType);
          }

          // Insert new analytes first (keeps count > 0, preventing the orphan
          // auto-link trigger from firing during the subsequent delete step)
          if (newAnalyteIds.length > 0) {
            const analyteRelations = newAnalyteIds.map((analyteId: string) => ({
              test_group_id: id,
              analyte_id: analyteId,
              lab_analyte_id: labAnalyteMap[analyteId] || null,
            }));

            const { error: insertError } = await supabase
              .from("test_group_analytes")
              .upsert(analyteRelations, {
                onConflict: "test_group_id,analyte_id",
                ignoreDuplicates: true,
              });

            if (insertError) {
              console.error(
                "Error inserting new analyte relationships:",
                insertError,
              );
              return { data, error: insertError };
            }

            // Update sort_order, section_heading, and lab_analyte_id for each analyte
            for (const analyteId of newAnalyteIds) {
              const meta = analyteMetadata[analyteId];
              const labAnalyteId = labAnalyteMap[analyteId] || null;
	              const updatePayload: Record<string, any> = {
	                sort_order: meta?.sort_order ?? 0,
	                section_heading: meta?.section_heading || null,
	                is_visible: meta?.is_visible ?? true,
	                report_display_options: meta?.report_display_options || {},
	              };
              // Always backfill lab_analyte_id when we have it resolved
              if (labAnalyteId) updatePayload.lab_analyte_id = labAnalyteId;
              await supabase
                .from("test_group_analytes")
                .update(updatePayload)
                .eq("test_group_id", id)
                .eq("analyte_id", analyteId);
            }
          }

          // Then delete analytes that are no longer in the new set
          let deleteQuery = supabase
            .from("test_group_analytes")
            .delete()
            .eq("test_group_id", id);

          if (newAnalyteIds.length > 0) {
            deleteQuery = deleteQuery.not(
              "analyte_id",
              "in",
              `(${newAnalyteIds.join(",")})`,
            );
          }

          const { error: deleteError } = await deleteQuery;

	          if (deleteError) {
	            console.error(
	              "Error deleting removed analyte relationships:",
	              deleteError,
	            );
	            return { data, error: deleteError };
	          }
	        }

	        const normalizedCategory = String(data?.category || updates.category || "").toLowerCase();
	        const normalizedSampleType = String(data?.sample_type || updates.sampleType || "").toLowerCase();
	        const shouldSeedRadiologySections =
	          !!data?.is_section_only &&
	          (
	            normalizedCategory.includes("radiology") ||
	            normalizedSampleType.includes("x-ray") ||
	            normalizedSampleType.includes("x ray") ||
	            normalizedSampleType.includes("xray") ||
	            normalizedSampleType.includes("ct") ||
	            normalizedSampleType.includes("usg") ||
	            normalizedSampleType.includes("ultrasound") ||
	            normalizedSampleType.includes("sonography")
	          );

	        if (shouldSeedRadiologySections) {
	          const { data: existingSections } = await supabase
	            .from("lab_template_sections")
	            .select("id")
	            .eq("test_group_id", id)
	            .limit(1);

	          if (!existingSections?.length) {
	            await supabase.from("lab_template_sections").insert([
	              {
	                lab_id: data.lab_id,
	                test_group_id: id,
	                section_type: "clinical_history",
	                section_name: "Clinical History",
	                placeholder_key: "clinical_history",
	                display_order: 1,
	                default_content: "",
	                predefined_options: [],
	                is_required: false,
	                is_editable: true,
	                allow_images: false,
	                allow_technician_entry: true,
	              },
	              {
	                lab_id: data.lab_id,
	                test_group_id: id,
	                section_type: "technique",
	                section_name: "Examination / Technique",
	                placeholder_key: "technique",
	                display_order: 2,
	                default_content: "",
	                predefined_options: [],
	                is_required: false,
	                is_editable: true,
	                allow_images: false,
	                allow_technician_entry: true,
	              },
	              {
	                lab_id: data.lab_id,
	                test_group_id: id,
	                section_type: "findings",
	                section_name: "Findings",
	                placeholder_key: "findings",
	                display_order: 3,
	                default_content: "",
	                predefined_options: [],
	                is_required: true,
	                is_editable: true,
	                allow_images: true,
	                allow_technician_entry: true,
	              },
	              {
	                lab_id: data.lab_id,
	                test_group_id: id,
	                section_type: "impression",
	                section_name: "Impression",
	                placeholder_key: "impression",
	                display_order: 4,
	                default_content: "",
	                predefined_options: [],
	                is_required: true,
	                is_editable: true,
	                allow_images: false,
	                allow_technician_entry: false,
	              },
	              {
	                lab_id: data.lab_id,
	                test_group_id: id,
	                section_type: "recommendation",
	                section_name: "Recommendation",
	                placeholder_key: "recommendation",
	                display_order: 5,
	                default_content: "",
	                predefined_options: [],
	                is_required: false,
	                is_editable: true,
	                allow_images: false,
	                allow_technician_entry: false,
	              },
	            ]);
	          }
	        }

	        return { data, error: null };
      } catch (error) {
        console.error("Unexpected error updating test group:", error);
        return { data: null, error };
      }
    },

    delete: async (id: string) => {
      // First delete analyte relationships
      await supabase
        .from("test_group_analytes")
        .delete()
        .eq("test_group_id", id);

      // Then delete the test group
      const { error } = await supabase
        .from("test_groups")
        .delete()
        .eq("id", id);

      return { error };
    },
  },

  // Reads here run through dropInactivePackageLinks: a package keeps its
  // package_test_groups row when a test group is later deactivated, and that
  // link is invisible in the package editor (which lists only active groups)
  // yet would still be re-saved and expanded into new orders.
  packages: {
    getAll: async () => {
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) {
        return { data: null, error: { message: "No lab context found" } };
      }
      const { data, error } = await supabase
        .from("packages")
        .select(`
          id,
          name,
          description,
          price,
          discount_percentage,
          category,
          validity_days,
          is_active,
          created_at,
          updated_at,
          lab_id,
          package_test_groups(
            test_group_id,
            display_order,
            test_groups(
              id,
              name,
              code,
              category,
              price,
              is_active
            )
          )
        `)
        .eq("lab_id", lab_id)
        .eq("is_active", true)
        .order("name");
      return { data: dropInactivePackageLinks(data), error };
    },

    getById: async (id: string) => {
      const { data, error } = await supabase
        .from("packages")
        .select(`
          id,
          name,
          description,
          price,
          discount_percentage,
          category,
          validity_days,
          is_active,
          created_at,
          updated_at,
          lab_id,
          package_test_groups(
            test_group_id,
            display_order,
            test_groups(
              id,
              name,
              code,
              category,
              price,
              clinical_purpose,
              turnaround_time,
              sample_type,
              requires_fasting,
              is_active
            )
          )
        `)
        .eq("id", id)
        .single();
      return { data: dropInactivePackageLinks(data), error };
    },

    create: async (packageData: any) => {
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) {
        return { data: null, error: { message: "No lab context found" } };
      }

      // Extract testGroupIds to prevent Supabase error (column does not exist)
      const { testGroupIds, ...pkgData } = packageData;

      const { data: pkg, error: pkgError } = await supabase
        .from("packages")
        .insert([{ ...pkgData, lab_id }])
        .select()
        .single();

      if (pkgError || !pkg) return { data: null, error: pkgError };

      // Link test groups if provided
      if (
        testGroupIds && Array.isArray(testGroupIds) && testGroupIds.length > 0
      ) {
        // Array position is the package-level display order chosen in the editor
        const links = testGroupIds.map((tgId: string, index: number) => ({
          package_id: pkg.id,
          test_group_id: tgId,
          display_order: index,
        }));

        const { error: linkError } = await supabase
          .from("package_test_groups")
          .insert(links);

        if (linkError) console.error("Error linking test groups:", linkError);
      }

      return { data: pkg, error: null };
    },

    update: async (id: string, packageData: any) => {
      // Extract testGroupIds
      const { testGroupIds, ...pkgData } = packageData;

      const { data, error } = await supabase
        .from("packages")
        .update(pkgData)
        .eq("id", id)
        .select()
        .single();

      if (error) return { data: null, error };

      // If testGroupIds is provided, update the links
      if (testGroupIds && Array.isArray(testGroupIds)) {
        // Delete existing links
        await supabase
          .from("package_test_groups")
          .delete()
          .eq("package_id", id);

        // Insert new links if any
        if (testGroupIds.length > 0) {
          const links = testGroupIds.map((tgId: string, index: number) => ({
            package_id: id,
            test_group_id: tgId,
            display_order: index,
          }));

          const { error: linkError } = await supabase
            .from("package_test_groups")
            .insert(links);

          if (linkError) {
            console.error("Error updating test group links:", linkError);
          }
        }
      }

      return { data, error };
    },

    delete: async (id: string) => {
      // First delete related package_test_groups
      await supabase
        .from("package_test_groups")
        .delete()
        .eq("package_id", id);

      // Then delete the package
      const { error } = await supabase
        .from("packages")
        .delete()
        .eq("id", id);

      return { error };
    },

    // Expand package into individual test groups for order creation
    expandForOrder: async (packageId: string) => {
      const { data: pkg, error } = await database.packages.getById(packageId);
      if (error || !pkg) return { data: null, error };

      const testGroups = (pkg.package_test_groups || []).map((ptg: any) => ({
        ...ptg.test_groups,
        source_package_id: packageId,
        package_name: pkg.name,
        // Price is overridden by package - tests inherit package discount
        original_price: ptg.test_groups?.price || 0,
        discounted_price: pkg.discount_percentage
          ? (ptg.test_groups?.price || 0) *
            (1 - (pkg.discount_percentage / 100))
          : ptg.test_groups?.price || 0,
      }));

      return {
        data: {
          package: pkg,
          testGroups,
          totalPackagePrice: pkg.price, // Use package price instead of sum
        },
        error: null,
      };
    },
  },

  // ============================================
  // TEMPLATE SECTIONS (Pre-defined report sections)
  // ============================================
  templateSections: {
    /**
     * Get all sections for a template
     */
    getByTemplate: async (templateId: string) => {
      const { data, error } = await supabase
        .from("lab_template_sections")
        .select("*")
        .eq("template_id", templateId)
        .order("display_order");
      return { data, error };
    },

    /**
     * Get all sections for a test group
     */
    getByTestGroup: async (testGroupId: string) => {
      const { data, error } = await supabase
        .from("lab_template_sections")
        .select("*")
        .eq("test_group_id", testGroupId)
        .order("display_order");
      return { data, error };
    },

    /**
     * Get all sections for current lab
     */
    getAll: async () => {
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) return { data: null, error: { message: "No lab context" } };

      const { data, error } = await supabase
        .from("lab_template_sections")
        .select(`
          *,
          lab_templates(id, template_name),
          test_groups(id, name)
        `)
        .eq("lab_id", lab_id)
        .order("display_order");
      return { data, error };
    },

    /**
     * Create a new section
     */
    create: async (sectionData: {
      template_id?: string;
      test_group_id?: string;
      section_type: string;
      section_name: string;
      display_order?: number;
      default_content?: string;
      predefined_options?: string[];
      is_required?: boolean;
      is_editable?: boolean;
      allow_images?: boolean;
      allow_technician_entry?: boolean;
      placeholder_key?: string;
      section_config?: any;
    }) => {
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) return { data: null, error: { message: "No lab context" } };

      const { data, error } = await supabase
        .from("lab_template_sections")
        .insert([{ ...sectionData, lab_id }])
        .select()
        .single();
      return { data, error };
    },

    /**
     * Update a section
     */
    update: async (
      id: string,
      sectionData: Partial<{
        section_type: string;
        section_name: string;
        display_order: number;
        default_content: string;
        predefined_options: string[];
        is_required: boolean;
        is_editable: boolean;
        allow_images: boolean;
        allow_technician_entry: boolean;
        placeholder_key: string;
        section_config: any;
      }>,
    ) => {
      const { data, error } = await supabase
        .from("lab_template_sections")
        .update({ ...sectionData, updated_at: new Date().toISOString() })
        .eq("id", id)
        .select()
        .single();
      return { data, error };
    },

    /**
     * Delete a section — clears result_section_content rows first to satisfy FK constraint
     */
    delete: async (id: string) => {
      const { error: contentErr } = await supabase
        .from("result_section_content")
        .delete()
        .eq("section_id", id);
      if (contentErr) return { error: contentErr };

      const { error } = await supabase
        .from("lab_template_sections")
        .delete()
        .eq("id", id);
      return { error };
    },
  },

  // ============================================
  // RESULT SECTION CONTENT (Doctor-filled content)
  // ============================================
  resultSectionContent: {
    /**
     * Get all section content for a result
     */
    getByResult: async (resultId: string) => {
      const { data, error } = await supabase
        .from("result_section_content")
        .select(`
          *,
          lab_template_sections(
            id,
            section_type,
            section_name,
            default_content,
            predefined_options,
            allow_images,
            allow_technician_entry,
            placeholder_key,
            display_order,
            section_config
          )
        `)
        .eq("result_id", resultId)
        .order("section_id");
      return { data, error };
    },

    /**
     * Create new section content
     */
    create: async (contentData: {
      result_id: string;
      section_id: string;
      selected_options?: number[];
      custom_text?: string;
      final_content: string;
      image_urls?: string[];
    }) => {
      const { data, error } = await supabase
        .from("result_section_content")
        .insert([{
          ...contentData,
          edited_at: new Date().toISOString(),
        }])
        .select()
        .single();
      return { data, error };
    },

    /**
     * Update existing section content
     */
    update: async (id: string, contentData: {
      selected_options?: number[];
      custom_text?: string;
      final_content?: string;
      image_urls?: string[];
    }) => {
      const { data, error } = await supabase
        .from("result_section_content")
        .update({
          ...contentData,
          edited_at: new Date().toISOString(),
        })
        .eq("id", id)
        .select()
        .single();
      return { data, error };
    },

    /**
     * Create or update section content
     * final_content becomes immutable after finalization
     */
    upsert: async (contentData: {
      result_id: string;
      section_id: string;
      selected_options?: any[];
      custom_text?: string;
      final_content: string;
      image_urls?: string[];
      cascading_selections?: Record<string, string[]>;
    }, userId: string) => {
      const { data, error } = await supabase
        .from("result_section_content")
        .upsert({
          ...contentData,
          edited_by: userId,
          edited_at: new Date().toISOString(),
        }, {
          onConflict: "result_id,section_id",
        })
        .select()
        .single();
      return { data, error };
    },

    /**
     * Get section content for PDF rendering (returns map of placeholder_key -> final_content)
     */
    getForPdfRendering: async (
      resultId: string,
    ): Promise<{ data: Record<string, string> | null; error: any }> => {
      const { data, error } = await supabase
        .from("result_section_content")
        .select(`
          final_content,
          image_urls,
          lab_template_sections!inner(
            placeholder_key
          )
        `)
        .eq("result_id", resultId)
        .not("lab_template_sections.placeholder_key", "is", null);

      if (error || !data) return { data: null, error };

      const buildSectionHtml = (
        content: string | null | undefined,
        imageUrls?: string[] | null,
      ) => {
        const trimmedContent = typeof content === "string"
          ? content.trim()
          : "";
        const formattedText = trimmedContent
          ? `<div class="section-content">${
            /<[a-z][\s\S]*>/i.test(trimmedContent)
              ? trimmedContent
              : trimmedContent.replace(/\r\n/g, "\n").replace(/\n/g, "<br/>")
          }</div>`
          : "";

        const urls = Array.isArray(imageUrls) ? imageUrls.filter(Boolean) : [];
        const imageHtml = urls.length > 0
          ? `<div class="section-images">${
            urls
              .map((url) => {
                const separator = url.includes("?") ? "&" : "?";
                return `<img src="${url}${separator}tr=w-1200,q-85,sharpen-5" class="report-section-image" />`;
              })
              .join("")
          }
            </div>`
          : "";

        return `${formattedText}${imageHtml}`.trim();
      };

      // Build map of placeholder_key -> final_content html
      const sectionMap: Record<string, string> = {};
      for (const item of data) {
        const key = (item.lab_template_sections as any)?.placeholder_key;
        if (key) {
          const html = buildSectionHtml(
            item.final_content,
            item.image_urls as string[] | null,
          );
          if (html) {
            sectionMap[key] = html;
          }
        }
      }
      return { data: sectionMap, error: null };
    },

    /**
     * Finalize section content (makes it immutable)
     */
    finalize: async (id: string, userId: string) => {
      const { data, error } = await supabase
        .from("result_section_content")
        .update({
          is_finalized: true,
          finalized_at: new Date().toISOString(),
          finalized_by: userId,
        })
        .eq("id", id)
        .select()
        .single();
      return { data, error };
    },

    /**
     * Finalize all sections for a result
     */
    finalizeAllForResult: async (resultId: string, userId: string) => {
      const { data, error } = await supabase
        .from("result_section_content")
        .update({
          is_finalized: true,
          finalized_at: new Date().toISOString(),
          finalized_by: userId,
        })
        .eq("result_id", resultId)
        .eq("is_finalized", false)
        .select();
      return { data, error };
    },

    /**
     * Initialize sections for a result from template defaults
     */
    initializeFromTemplate: async (
      resultId: string,
      testGroupId: string,
      userId: string,
    ) => {
      // Get sections for the test group
      const { data: sections, error: fetchError } = await database
        .templateSections.getByTestGroup(testGroupId);
      if (fetchError || !sections || sections.length === 0) {
        return { data: [], error: fetchError };
      }

      // Create content entries with default values
      const contentEntries = sections.map((section) => ({
        result_id: resultId,
        section_id: section.id,
        selected_options: [],
        custom_text: "",
        final_content: section.default_content || "",
        image_urls: [],
        edited_by: userId,
        edited_at: new Date().toISOString(),
      }));

      const { data, error } = await supabase
        .from("result_section_content")
        .insert(contentEntries)
        .select();
      return { data, error };
    },
  },

  // ============================================
  // ANALYTE DEPENDENCIES (Calculated parameters)
  // ============================================
    analyteDependencies: {
      /**
       * Get all dependencies for a calculated analyte
       */
      getByAnalyte: async (
        calculatedAnalyteId: string,
        options?: { labId?: string; calculatedLabAnalyteId?: string | null },
      ) => {
        let query = supabase
          .from("analyte_dependencies")
          .select(`
            *,
            source_analyte:analytes!analyte_dependencies_source_analyte_id_fkey(id, name, unit),
            source_lab_analyte:lab_analytes!analyte_dependencies_source_lab_analyte_id_fkey(id, analyte_id, name, unit, category)
          `);

        if (options?.calculatedLabAnalyteId) {
          query = query.or(
            `calculated_lab_analyte_id.eq.${options.calculatedLabAnalyteId},and(calculated_lab_analyte_id.is.null,calculated_analyte_id.eq.${calculatedAnalyteId})`,
          );
        } else {
          query = query.eq("calculated_analyte_id", calculatedAnalyteId);
        }

        if (options?.labId) {
          query = query.or(`lab_id.eq.${options.labId},lab_id.is.null`);
        }

        const { data, error } = await query;
        if (error || !data) {
          return { data, error };
        }

        let resolved = data;

        // Prefer exact calculated_lab_analyte matches when they exist.
        // This avoids mixing old fallback dependency rows with the newer
        // exact lab-analyte dependency rows for the same calculated analyte.
        if (options?.calculatedLabAnalyteId) {
          const exact = resolved.filter(
            (row: any) => row.calculated_lab_analyte_id === options.calculatedLabAnalyteId,
          );
          if (exact.length > 0) {
            resolved = exact;
          } else if (options?.labId) {
            const labScopedFallback = resolved.filter(
              (row: any) =>
                !row.calculated_lab_analyte_id &&
                row.lab_id === options.labId,
            );
            if (labScopedFallback.length > 0) {
              resolved = labScopedFallback;
            }
          }
        } else if (options?.labId) {
          const labScoped = resolved.filter(
            (row: any) => row.lab_id === options.labId || row.lab_id == null,
          );
          if (labScoped.length > 0) {
            resolved = labScoped;
          }
        }

        return { data: resolved, error };
      },

    /**
     * Get all analytes that depend on a source analyte
     */
    getDependents: async (sourceAnalyteId: string) => {
      const { data, error } = await supabase
        .from("analyte_dependencies")
        .select(`
          *,
          calculated_analyte:analytes!analyte_dependencies_calculated_analyte_id_fkey(id, name, formula)
        `)
        .eq("source_analyte_id", sourceAnalyteId);
      return { data, error };
    },

    /**
     * Create a dependency (circular check is done at DB level)
     */
      create: async (dependencyData: {
        calculated_analyte_id: string;
        source_analyte_id: string;
        variable_name: string;
        lab_id?: string;
        calculated_lab_analyte_id?: string | null;
        source_lab_analyte_id?: string | null;
      }) => {
        // Client-side circular check before DB call
        const hasCycle = await database.analyteDependencies.checkCircular(
          dependencyData.calculated_analyte_id,
          dependencyData.source_analyte_id,
          dependencyData.lab_id,
        );
      if (hasCycle) {
        return {
          data: null,
          error: {
            message:
              "Circular dependency detected. This would create an infinite calculation loop.",
          },
        };
      }

      const { data, error } = await supabase
        .from("analyte_dependencies")
        .insert([dependencyData])
        .select()
        .single();
      return { data, error };
    },

    /**
     * Delete a dependency
     */
    delete: async (id: string) => {
      const { error } = await supabase
        .from("analyte_dependencies")
        .delete()
        .eq("id", id);
      return { error };
    },

    /**
     * Check for circular dependencies (client-side BFS)
     * Returns true if adding this dependency would create a cycle
     */
      checkCircular: async (
        calculatedAnalyteId: string,
        sourceAnalyteId: string,
        labId?: string,
      ): Promise<boolean> => {
        const visited = new Set<string>([calculatedAnalyteId]);
        const queue = [sourceAnalyteId];

      while (queue.length > 0) {
        const current = queue.shift()!;

        // Found cycle
        if (current === calculatedAnalyteId) {
          return true;
        }

        if (visited.has(current)) continue;
        visited.add(current);

        // Get what this analyte depends on (if it's calculated)
          let query = supabase
            .from("analyte_dependencies")
            .select("source_analyte_id")
            .eq("calculated_analyte_id", current);

          if (labId) {
            query = query.or(`lab_id.eq.${labId},lab_id.is.null`);
          }

          const { data } = await query;

        if (data) {
          for (const dep of data) {
            if (!visited.has(dep.source_analyte_id)) {
              queue.push(dep.source_analyte_id);
            }
          }
        }
      }

      return false;
    },

    /**
     * Set up all dependencies for a calculated analyte at once.
     * Pass labId to store lab-specific dependencies (recommended).
     * Omit labId only for seeding global/default dependencies.
     */
      setDependencies: async (
        calculatedAnalyteId: string,
        dependencies: Array<{
          source_analyte_id: string;
          variable_name: string;
          source_lab_analyte_id?: string | null;
        }>,
        labId?: string,
        calculatedLabAnalyteId?: string | null,
      ) => {
        // Delete existing dependencies for this analyte scoped to the same lab
        let deleteQuery = supabase
          .from("analyte_dependencies")
          .delete();

        if (calculatedLabAnalyteId) {
          deleteQuery = deleteQuery.or(
            `calculated_lab_analyte_id.eq.${calculatedLabAnalyteId},and(calculated_lab_analyte_id.is.null,calculated_analyte_id.eq.${calculatedAnalyteId})`,
          );
        } else {
          deleteQuery = deleteQuery.eq("calculated_analyte_id", calculatedAnalyteId);
        }

        const { error: deleteError } = labId
          ? await deleteQuery.eq("lab_id", labId)
          : await deleteQuery.is("lab_id", null);
        if (deleteError) {
          return { data: null, error: deleteError };
        }

      if (dependencies.length === 0) {
        return { data: [], error: null };
      }

      const uniqueDependencies = Array.from(
        dependencies.reduce((preferred, dependency) => {
          const key = dependency.variable_name.trim().toUpperCase();
          const current = preferred.get(key);
          if (!current || (!current.source_lab_analyte_id && dependency.source_lab_analyte_id)) {
            preferred.set(key, dependency);
          }
          return preferred;
        }, new Map<string, (typeof dependencies)[number]>()).values(),
      );

      // Check for cycles before inserting
        for (const dep of uniqueDependencies) {
          const hasCycle = await database.analyteDependencies.checkCircular(
            calculatedAnalyteId,
            dep.source_analyte_id,
            labId,
          );
        if (hasCycle) {
          return {
            data: null,
            error: {
              message:
                `Circular dependency detected with analyte ID: ${dep.source_analyte_id}`,
            },
          };
        }
      }

      // Insert new lab-specific dependencies
        const insertData = uniqueDependencies.map((dep) => ({
          calculated_analyte_id: calculatedAnalyteId,
          source_analyte_id: dep.source_analyte_id,
          variable_name: dep.variable_name,
          ...(dep.source_lab_analyte_id ? { source_lab_analyte_id: dep.source_lab_analyte_id } : {}),
          ...(calculatedLabAnalyteId ? { calculated_lab_analyte_id: calculatedLabAnalyteId } : {}),
          ...(labId ? { lab_id: labId } : {}),
        }));

      const { data, error } = await supabase
        .from("analyte_dependencies")
        .insert(insertData)
        .select();
      return { data, error };
    },
  },

  // ============================================
  // FLAG AUDITS (AI Flag Analysis Audit Trail)
  // ============================================
  flagAudits: {
    /**
     * Create a flag audit record
     */
    create: async (auditData: {
      result_value_id: string;
      original_value: string;
      auto_determined_flag?: string | null;
      auto_flag_source?: string | null;
      ai_suggested_flag?: string | null;
      final_flag?: string | null;
      auto_confidence?: number;
      ai_confidence?: number;
      resolution_notes?: string;
      ai_reasoning?: string;
      result_id?: string;
      order_id?: string;
      analyte_id?: string;
      lab_id?: string;
    }) => {
      const { data: { user } } = await supabase.auth.getUser();
      const lab_id = auditData.lab_id || await database.getCurrentUserLabId();
      const { data, error } = await supabase
        .from("ai_flag_audits")
        .insert([{
          ...auditData,
          lab_id,
          resolved_by: user?.id,
        }])
        .select()
        .single();
      return { data, error };
    },

    /**
     * Get pending audits for review
     */
    getPending: async (labId?: string) => {
      let query = supabase
        .from("ai_flag_audits")
        .select(`
          *,
          result_values:result_value_id(
            id,
            parameter,
            value,
            unit,
            reference_range,
            order_id,
            orders:order_id(
              order_number,
              patient_id,
              patients:patient_id(name)
            )
          )
        `)
        .eq("audit_status", "pending")
        .order("created_at", { ascending: false });

      if (labId) {
        query = query.eq("result_values.lab_id", labId);
      }

      const { data, error } = await query;
      return { data, error };
    },

    /**
     * Resolve an audit (approve or reject the flag change)
     */
    resolve: async (auditId: string, resolution: {
      status: "approved" | "rejected";
      notes?: string;
    }) => {
      const { data: { user } } = await supabase.auth.getUser();
      const { data, error } = await supabase
        .from("ai_flag_audits")
        .update({
          audit_status: resolution.status,
          audit_notes: resolution.notes,
          reviewed_by: user?.id,
          reviewed_at: new Date().toISOString(),
        })
        .eq("id", auditId)
        .select()
        .single();
      return { data, error };
    },

    /**
     * Get audit history for a result value
     */
    getForResultValue: async (resultValueId: string) => {
      const { data, error } = await supabase
        .from("ai_flag_audits")
        .select("*")
        .eq("result_value_id", resultValueId)
        .order("created_at", { ascending: false });
      return { data, error };
    },

    /**
     * Get flag audit statistics
     */
    getStats: async (
      labId?: string,
      dateRange?: { start: Date; end: Date },
    ) => {
      let query = supabase
        .from("ai_flag_audits")
        .select("flag_source, audit_status, confidence_score");

      if (dateRange) {
        query = query
          .gte("created_at", dateRange.start.toISOString())
          .lte("created_at", dateRange.end.toISOString());
      }

      const { data, error } = await query;

      if (error || !data) {
        return { data: null, error };
      }

      // Calculate stats
      const stats = {
        total: data.length,
        bySource: {
          rule: data.filter((d) => d.flag_source === "rule").length,
          ai: data.filter((d) => d.flag_source === "ai").length,
          manual: data.filter((d) => d.flag_source === "manual").length,
        },
        byStatus: {
          pending: data.filter((d) => d.audit_status === "pending").length,
          approved: data.filter((d) => d.audit_status === "approved").length,
          rejected: data.filter((d) => d.audit_status === "rejected").length,
        },
        averageConfidence: data.length > 0
          ? data.reduce((sum, d) => sum + (d.confidence_score || 0), 0) /
            data.length
          : 0,
      };

      return { data: stats, error: null };
    },
  },

  // ============================================
  // ANALYTE FLAG RULES
  // ============================================
  analyteFlagRules: {
    /**
     * Get flag rules for an analyte
     */
    getForAnalyte: async (analyteId: string) => {
      const { data, error } = await supabase
        .from("analyte_flag_rules")
        .select("*")
        .eq("analyte_id", analyteId)
        .order("priority", { ascending: true });
      return { data, error };
    },

    /**
     * Create a flag rule
     */
    create: async (ruleData: {
      analyte_id: string;
      rule_name: string;
      rule_type: "range" | "pattern" | "formula";
      condition: any;
      result_flag: string;
      priority?: number;
      is_active?: boolean;
    }) => {
      const { data, error } = await supabase
        .from("analyte_flag_rules")
        .insert([ruleData])
        .select()
        .single();
      return { data, error };
    },

    /**
     * Update a flag rule
     */
    update: async (ruleId: string, updates: {
      rule_name?: string;
      condition?: any;
      result_flag?: string;
      priority?: number;
      is_active?: boolean;
    }) => {
      const { data, error } = await supabase
        .from("analyte_flag_rules")
        .update({
          ...updates,
          updated_at: new Date().toISOString(),
        })
        .eq("id", ruleId)
        .select()
        .single();
      return { data, error };
    },

    /**
     * Delete a flag rule
     */
    delete: async (ruleId: string) => {
      const { error } = await supabase
        .from("analyte_flag_rules")
        .delete()
        .eq("id", ruleId);
      return { error };
    },
  },
};

// Attachment batch management helpers
export const attachmentBatch = {
  async uploadMultiple(files: File[], context: {
    orderId: string;
    testId?: string;
    scope: "order" | "test";
    labId: string;
    patientId: string;
    userId: string;
    optimize?: boolean;
    onOptimizationProgress?: (progress: number, fileName: string) => void;
  }) {
    const batchId = crypto.randomUUID();

    // Create batch record first
    const { error: batchError } = await supabase
      .from("attachment_batches")
      .insert({
        id: batchId,
        order_id: context.orderId,
        patient_id: context.patientId,
        upload_type: context.scope,
        total_files: files.length,
        upload_context: {
          testId: context.testId,
          scope: context.scope,
        },
        uploaded_by: context.userId,
        lab_id: context.labId,
        batch_status: "uploading",
        batch_description: `${
          context.scope === "test" ? "Test-specific" : "Order-level"
        } batch upload of ${files.length} files`,
      });

    if (batchError) throw batchError;

    // Optimize images if enabled
    let filesToUpload = files;
    let totalOptimizationStats = null;

    if (context.optimize !== false) {
      console.log(`Optimizing ${files.length} files for batch upload...`);
      const optimizationResult = await optimizeBatch(
        files,
        context.onOptimizationProgress,
      );

      filesToUpload = optimizationResult.files;
      totalOptimizationStats = optimizationResult.totalStats;

      if (totalOptimizationStats.savedBytes > 0) {
        console.log(
          `Batch optimization complete: ${totalOptimizationStats.savedPercent}% reduction`,
        );
      }
    }

    const uploadPromises = filesToUpload.map(async (file, index) => {
      const sequence = index + 1;
      const label = `Image ${sequence}`;

      // Generate unique path with batch info
      const filePath = `${context.labId}/${new Date().getFullYear()}/${
        new Date().getMonth() + 1
      }/${batchId}/${sequence}_${file.name}`;

      try {
        // Upload to storage
        const { error: storageError } = await supabase.storage
          .from("attachments")
          .upload(filePath, file);

        if (storageError) throw storageError;

        // Get public URL
        const { data: urlData } = supabase.storage
          .from("attachments")
          .getPublicUrl(filePath);

        // Create attachment record
        const attachmentData = {
          batch_id: batchId,
          batch_sequence: sequence,
          batch_total: files.length,
          image_label: label,
          file_path: filePath,
          file_url: urlData.publicUrl,
          original_filename: file.name,
          file_size: file.size,
          file_type: file.type,
          related_table: "orders",
          related_id: context.orderId,
          order_id: context.orderId,
          patient_id: context.patientId,
          lab_id: context.labId,
          uploaded_by: context.userId,
          description: `${label} from batch upload`,
          batch_metadata: {
            originalIndex: index + 1,
            uploadContext: context,
          },
          processing_status: "pending",
        };

        const { data: attachment, error: attachmentError } = await supabase
          .from("attachments")
          .insert(attachmentData)
          .select()
          .single();

        if (attachmentError) throw attachmentError;

        if (attachment?.id) {
          await queueImageKitProcessing({
            attachmentId: attachment.id,
            labId: context.labId,
            storagePath: filePath,
            fileName: file.name,
            contentType: file.type,
            assetType: context.scope === "test"
              ? "order-test-attachment"
              : "order-attachment",
          });

          attachment.processing_status = "processing";
          attachment.resolved_file_url = attachment.imagekit_url ||
            attachment.processed_url || attachment.file_url;
        }

        return { success: true, data: attachment };
      } catch (error) {
        return { success: false, error, fileName: file.name };
      }
    });

    const results = await Promise.allSettled(uploadPromises);

    // Update batch status
    const successful = results.filter((r) =>
      r.status === "fulfilled" && r.value.success
    );
    const failed = results.filter((r) =>
      r.status === "rejected" || (r.status === "fulfilled" && !r.value.success)
    );

    await supabase
      .from("attachment_batches")
      .update({
        batch_status: failed.length > 0 ? "failed" : "completed",
        batch_description:
          `Batch upload: ${successful.length} successful, ${failed.length} failed`,
      })
      .eq("id", batchId);

    return {
      batchId,
      successful: successful.map((r) =>
        r.status === "fulfilled" ? r.value.data : null
      ).filter(Boolean),
      failed: failed.map((r) =>
        r.status === "fulfilled" ? r.value : { error: "Unknown error" }
      ),
      totalFiles: files.length,
      optimizationStats: totalOptimizationStats,
    };
  },

  async getBatch(batchId: string) {
    // Get batch first
    const { data: batch, error: batchError } = await supabase
      .from("attachment_batches")
      .select("*")
      .eq("id", batchId)
      .single();

    if (batchError) return { data: null, error: batchError };

    // Get attachments for this batch
    const { data: attachments, error: attachError } = await supabase
      .from("attachments")
      .select("*")
      .eq("batch_id", batchId)
      .order("batch_sequence");

    if (attachError) return { data: null, error: attachError };
    const normalized = (attachments || []).map((attachment) => ({
      ...attachment,
      resolved_file_url: attachment.imagekit_url || attachment.processed_url ||
        attachment.file_url,
    }));

    return {
      data: {
        ...batch,
        attachments: normalized,
      },
      error: null,
    };
  },

  async getBatchesByOrder(orderId: string) {
    // Get batches first
    const { data: batches, error: batchError } = await supabase
      .from("attachment_batches")
      .select("*")
      .eq("order_id", orderId)
      .order("created_at", { ascending: false });

    if (batchError) return { data: null, error: batchError };

    // Get attachments for each batch
    if (batches && batches.length > 0) {
      const batchIds = batches.map((b) => b.id);
      const { data: attachments, error: attachError } = await supabase
        .from("attachments")
        .select(
          "id, batch_id, image_label, batch_sequence, file_url, file_type, original_filename, file_size, imagekit_url, processed_url, processing_status, variants, image_processed_at",
        )
        .in("batch_id", batchIds)
        .order("batch_sequence");

      if (attachError) return { data: null, error: attachError };

      const normalizedAttachments = (attachments || []).map((attachment) => ({
        ...attachment,
        resolved_file_url: attachment.imagekit_url ||
          attachment.processed_url || attachment.file_url,
      }));

      // Merge attachments with batches
      const batchesWithAttachments = batches.map((batch) => ({
        ...batch,
        attachments: normalizedAttachments.filter((att) =>
          att.batch_id === batch.id
        ),
      }));

      return { data: batchesWithAttachments, error: null };
    }

    return { data: batches, error: null };
  },

  async updateBatchMetadata(batchId: string, metadata: Record<string, any>) {
    const { data, error } = await supabase
      .from("attachment_batches")
      .update({ upload_context: metadata })
      .eq("id", batchId)
      .select()
      .single();

    return { data, error };
  },
};

const resolveImageKitFunctionUrl = (): string => {
  const direct = import.meta.env.VITE_IMAGEKIT_PROCESS_ENDPOINT;
  if (direct && typeof direct === "string" && direct.trim().length > 0) {
    return direct.trim();
  }

  const base = import.meta.env.VITE_NETLIFY_FUNCTIONS_BASE_URL;
  if (base && typeof base === "string" && base.trim().length > 0) {
    return `${base.replace(/\/$/, "")}/.netlify/functions/imagekit-process`;
  }

  return "/.netlify/functions/imagekit-process";
};

const queueImageKitProcessing = async (payload: {
  attachmentId: string;
  labId: string;
  storagePath: string;
  fileName?: string;
  contentType?: string;
  assetType?: string;
}) => {
  if (typeof fetch !== "function") {
    return;
  }

  const endpoint = resolveImageKitFunctionUrl();

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-netlify-background": "true",
      },
      body: JSON.stringify({
        assetId: payload.attachmentId,
        tableName: "attachments",
        labId: payload.labId,
        storageBucket: "attachments",
        storagePath: payload.storagePath,
        fileName: payload.fileName,
        contentType: payload.contentType,
        assetType: payload.assetType || "order-attachment",
      }),
    });

    if (!response.ok) {
      console.warn("ImageKit processing request failed", response.status);
    }
  } catch (error) {
    console.warn("Failed to trigger ImageKit processing", error);
  }
};

// Database helper functions for attachments
export const attachments = {
  // Upload file with metadata including test-level support
  upload: async (file: File, metadata: {
    patient_id?: string;
    related_table: string;
    related_id: string;
    order_id?: string;
    order_test_id?: string; // New field for test-level attachments
    description?: string;
    tag?: string;
    optimize?: boolean; // Enable image optimization
  }, options?: {
    optimize?: boolean;
    onOptimizationProgress?: (progress: number, fileName: string) => void;
  }) => {
    try {
      // Optimize image if enabled and it's an image file
      let fileToUpload = file;
      let optimizationStats = null;

      const shouldOptimize = options?.optimize ?? metadata.optimize ?? true;

      if (shouldOptimize !== false && file.type.startsWith("image/")) {
        if (options?.onOptimizationProgress) {
          options.onOptimizationProgress(10, file.name);
        }
        console.log(
          `Optimizing image: ${file.name} (${
            (file.size / 1024 / 1024).toFixed(2)
          } MB)`,
        );
        const result = await smartOptimizeImage(file);
        fileToUpload = result.file;
        optimizationStats = result.stats;

        if (optimizationStats) {
          console.log(
            `Image optimized: ${optimizationStats.savedPercent}% reduction`,
          );
        }
        if (options?.onOptimizationProgress) {
          options.onOptimizationProgress(100, file.name);
        }
      }

      const labId = await database.getCurrentUserLabId();
      const timestamp = Date.now();
      const fileName = `${timestamp}_${fileToUpload.name}`;
      const filePath = `attachments/${labId}/${fileName}`;

      // Upload file to storage
      const { error: uploadError } = await supabase.storage
        .from("attachments")
        .upload(filePath, fileToUpload);

      if (uploadError) throw uploadError;

      // Get public URL
      const { data: { publicUrl } } = supabase.storage
        .from("attachments")
        .getPublicUrl(filePath);

      // Save attachment metadata
      const { data, error } = await supabase
        .from("attachments")
        .insert({
          patient_id: metadata.patient_id,
          related_table: metadata.related_table,
          related_id: metadata.related_id,
          order_id: metadata.order_id,
          order_test_id: metadata.order_test_id, // Save test association
          file_url: publicUrl,
          file_type: fileToUpload.type,
          file_path: filePath,
          original_filename: file.name,
          stored_filename: fileName,
          file_size: fileToUpload.size,
          description: metadata.description,
          tag: metadata.tag,
          lab_id: labId,
          uploaded_by: (await supabase.auth.getUser()).data.user?.id,
          processing_status: "pending",
        })
        .select()
        .single();

      if (error) throw error;

      if (data?.id) {
        await queueImageKitProcessing({
          attachmentId: data.id,
          labId,
          storagePath: filePath,
          fileName: file.name,
          contentType: file.type,
          assetType: metadata.tag === "test-specific"
            ? "order-test-attachment"
            : "order-attachment",
        });

        data.processing_status = "processing";
        data.resolved_file_url = data.imagekit_url || data.processed_url ||
          data.file_url;
      }
      return { data, error: null };
    } catch (error) {
      console.error("Error uploading attachment:", error);
      return { data: null, error };
    }
  },

  // Get attachments by order test ID
  getByOrderTest: async (orderTestId: string) => {
    try {
      const { data, error } = await supabase
        .from("attachments")
        .select("*")
        .eq("order_test_id", orderTestId)
        .order("created_at", { ascending: false });

      if (error) throw error;
      return { data, error: null };
    } catch (error) {
      console.error("Error fetching test attachments:", error);
      return { data: null, error };
    }
  },

  // Get attachments by order with test information
  getByOrderWithTestInfo: async (orderId: string) => {
    try {
      const { data, error } = await supabase
        .from("attachments")
        .select(`
          *,
          order_tests!attachments_order_test_id_fkey(
            id,
            test_name,
            test_group_id
          )
        `)
        .eq("order_id", orderId)
        .order("created_at", { ascending: false });

      if (error) throw error;
      return { data, error: null };
    } catch (error) {
      console.error("Error fetching order attachments:", error);
      return { data: null, error };
    }
  },

  getByRelatedId: async (relatedTable: string, relatedId: string) => {
    const { data, error } = await supabase
      .from("attachments")
      .select("*")
      .eq("related_table", relatedTable)
      .eq("related_id", relatedId)
      .order("created_at", { ascending: false });
    return { data, error };
  },

  getByIdWithProcessingStatus: async (attachmentId: string) => {
    const { data, error } = await supabase
      .from("attachments")
      .select("id, imagekit_url, processed_url, file_url, processing_status")
      .eq("id", attachmentId)
      .single();
    return { data, error };
  },

  // Helper function specifically for orders (commonly used)
  getByOrderId: async (orderId: string) => {
    return attachments.getByRelatedId("orders", orderId);
  },

  // Helper function specifically for patients
  getByPatientIdRelated: async (patientId: string) => {
    return attachments.getByRelatedId("patients", patientId);
  },

  // Helper function specifically for results
  getByResultId: async (resultId: string) => {
    return attachments.getByRelatedId("results", resultId);
  },

  getByPatientId: async (patientId: string) => {
    const { data, error } = await supabase
      .from("attachments")
      .select("*")
      .eq("patient_id", patientId)
      .order("created_at", { ascending: false });
    return { data, error };
  },

  getByLabId: async (labId: string) => {
    const { data, error } = await supabase
      .from("attachments")
      .select("*")
      .eq("lab_id", labId)
      .order("created_at", { ascending: false });
    return { data, error };
  },
  getById: async (id: string) => {
    const { data, error } = await supabase
      .from("attachments")
      .select("*")
      .eq("id", id)
      .single();
    return { data, error };
  },

  create: async (attachmentData: any) => {
    const { data, error } = await supabase
      .from("attachments")
      .insert([attachmentData])
      .select()
      .single();
    return { data, error };
  },

  updateDescription: async (id: string, description: string) => {
    const { data, error } = await supabase
      .from("attachments")
      .update({ description })
      .eq("id", id)
      .select()
      .single();
    return { data, error };
  },
  delete: async (id: string) => {
    // First get the file path to delete from storage
    const { data: attachment, error: fetchError } = await supabase
      .from("attachments")
      .select("file_path")
      .eq("id", id)
      .single();

    if (fetchError) {
      return { error: fetchError };
    }

    // Delete from storage
    if (attachment?.file_path) {
      const { error: storageError } = await supabase.storage
        .from("attachments")
        .remove([attachment.file_path]);

      if (storageError) {
        console.warn("Failed to delete file from storage:", storageError);
      }
    }

    // Delete from database
    const { error } = await supabase
      .from("attachments")
      .delete()
      .eq("id", id);
    return { error };
  },

  // Delete entire batch
  async deleteBatch(batchId: string) {
    try {
      // Get all attachments in the batch first
      const { data: attachments, error: fetchError } = await supabase
        .from("attachments")
        .select("file_path, id")
        .eq("batch_id", batchId);

      if (fetchError) return { error: fetchError };

      // Delete files from storage
      if (attachments && attachments.length > 0) {
        const filePaths = attachments
          .map((att) => att.file_path)
          .filter(Boolean);

        if (filePaths.length > 0) {
          const { error: storageError } = await supabase.storage
            .from("attachments")
            .remove(filePaths);

          if (storageError) {
            console.warn(
              "Some files failed to delete from storage:",
              storageError,
            );
          }
        }
      }

      // Delete attachments from database
      const { error: attachmentsDeleteError } = await supabase
        .from("attachments")
        .delete()
        .eq("batch_id", batchId);

      if (attachmentsDeleteError) return { error: attachmentsDeleteError };

      // Delete batch record
      const { error: batchDeleteError } = await supabase
        .from("attachment_batches")
        .delete()
        .eq("id", batchId);

      return { error: batchDeleteError };
    } catch (error) {
      console.error("Error deleting batch:", error);
      return { error };
    }
  },

  // Delete all batches for an order
  async deleteAllBatchesForOrder(orderId: string) {
    try {
      // Get all batches for the order
      const { data: batches, error: fetchError } = await supabase
        .from("attachment_batches")
        .select("id")
        .eq("order_id", orderId);

      if (fetchError) return { error: fetchError };

      // Delete each batch
      const deletePromises = batches?.map((batch) =>
        this.deleteBatch(batch.id)
      ) || [];

      const results = await Promise.allSettled(deletePromises);

      // Check if any deletions failed
      const failures = results.filter((result) =>
        result.status === "rejected" ||
        (result.status === "fulfilled" && result.value.error)
      );

      if (failures.length > 0) {
        console.warn("Some batch deletions failed:", failures);
        return {
          error: new Error(
            `Failed to delete ${failures.length} of ${batches?.length} batches`,
          ),
        };
      }

      return { error: null };
    } catch (error) {
      console.error("Error deleting all batches for order:", error);
      return { error };
    }
  },
};

// Database helper functions for OCR results
export const ocrResults = {
  getByAttachmentId: async (attachmentId: string) => {
    const { data, error } = await supabase
      .from("ocr_results")
      .select("*")
      .eq("attachment_id", attachmentId)
      .order("created_at", { ascending: false });
    return { data, error };
  },

  create: async (ocrData: any) => {
    const { data, error } = await supabase
      .from("ocr_results")
      .insert([ocrData])
      .select()
      .single();
    return { data, error };
  },
};

// User management helper functions
export const userManagement = {
  // Get current user's profile from public.users
  getCurrentUserProfile: async () => {
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return { data: null, error: authError };
    }

    const { data, error } = await supabase
      .from("users")
      .select(`
        *,
        labs(id, name, code)
      `)
      .eq("email", user.email)
      .single();

    return { data, error };
  },

  // Update user's lab assignment
  updateUserLab: async (userId: string, labId: string) => {
    const { data, error } = await supabase
      .from("users")
      .update({
        lab_id: labId,
        updated_at: new Date().toISOString(),
      })
      .eq("id", userId)
      .select()
      .single();

    return { data, error };
  },

  // Get all users for a specific lab
  getUsersByLab: async (labId: string) => {
    const { data, error } = await supabase
      .from("users")
      .select(`
        id,
        name,
        email,
        role,
        status,
        join_date,
        last_login
      `)
      .eq("lab_id", labId)
      .eq("status", "Active")
      .order("name");

    return { data, error };
  },
};

// Phase 2 API Methods - Master Data Management
const masterDataAPI = {
  // Doctors API
  doctors: {
    getAll: async () => {
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) {
        return {
          data: null,
          error: new Error("No lab_id found for current user"),
        };
      }

      const { data, error } = await supabase
        .from("doctors")
        .select("*")
        .eq("lab_id", lab_id)
        .eq("is_active", true)
        .order("name");
      return { data, error };
    },

    getById: async (id: string) => {
      const { data, error } = await supabase
        .from("doctors")
        .select("*")
        .eq("id", id)
        .single();
      return { data, error };
    },

    search: async (searchTerm: string) => {
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) {
        return {
          data: null,
          error: new Error("No lab_id found for current user"),
        };
      }

      const { data, error } = await supabase
        .from("doctors")
        .select("*")
        .eq("lab_id", lab_id)
        .eq("is_active", true)
        .or(
          `name.ilike.%${searchTerm}%,license_number.ilike.%${searchTerm}%,specialization.ilike.%${searchTerm}%,hospital.ilike.%${searchTerm}%`,
        )
        .order("name")
        .limit(20);
      return { data, error };
    },

    create: async (doctorData: {
      name: string;
      license_number?: string;
      specialization?: string;
      qualification?: string;
      phone?: string;
      email?: string;
      hospital?: string;
      address?: string;
      is_referring_doctor?: boolean;
      notes?: string;
    }) => {
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) {
        return {
          data: null,
          error: new Error("No lab_id found for current user"),
        };
      }

      const { data, error } = await supabase
        .from("doctors")
        .insert([{
          ...doctorData,
          lab_id,
          is_active: true,
          created_at: new Date().toISOString(),
        }])
        .select()
        .single();
      return { data, error };
    },

    update: async (id: string, updates: {
      name?: string;
      license_number?: string;
      specialization?: string;
      qualification?: string;
      phone?: string;
      email?: string;
      hospital?: string;
      address?: string;
      is_referring_doctor?: boolean;
      notes?: string;
      is_active?: boolean;
    }) => {
      const { data, error } = await supabase
        .from("doctors")
        .update({
          ...updates,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id)
        .select()
        .single();
      return { data, error };
    },

    delete: async (id: string) => {
      const { data, error } = await supabase
        .from("doctors")
        .update({
          is_active: false,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id)
        .select()
        .single();
      return { data, error };
    },
  },

  // Locations API
  locations: {
    getAll: async () => {
      const lab_id = await database.getCurrentUserLabId();
      console.log("[locations.getAll v2] Lab ID:", lab_id);
      if (!lab_id) {
        return {
          data: null,
          error: new Error("No lab_id found for current user"),
        };
      }

      // Apply location filtering based on user restrictions
      const filterCheck = await database.shouldFilterByLocation();

      let query = supabase
        .from("locations")
        .select("*")
        .eq("lab_id", lab_id)
        .eq("is_active", true)
        .order("name");

      if (
        filterCheck.shouldFilter && !filterCheck.canViewAll &&
        filterCheck.locationIds.length > 0
      ) {
        query = query.in("id", filterCheck.locationIds);
      }

      const { data, error } = await query;
      return { data, error };
    },

    getById: async (id: string) => {
      const { data, error } = await supabase
        .from("locations")
        .select("*")
        .eq("id", id)
        .single();
      return { data, error };
    },

    getWithCreditBalance: async (id: string) => {
      const { data, error } = await supabase
        .from("locations")
        .select(`
          *,
          credit_transactions!location_id(
            amount,
            type,
            created_at
          )
        `)
        .eq("id", id)
        .single();

      if (error || !data) {
        return { data, error };
      }

      // Calculate current credit balance
      const creditTransactions = data.credit_transactions || [];
      const totalCredits = creditTransactions
        .filter((t: any) => t.type === "credit")
        .reduce((sum: number, t: any) => sum + parseFloat(t.amount), 0);
      const totalDebits = creditTransactions
        .filter((t: any) => t.type === "debit")
        .reduce((sum: number, t: any) => sum + parseFloat(t.amount), 0);

      const currentBalance = totalCredits - totalDebits;

      return {
        data: {
          ...data,
          current_credit_balance: currentBalance,
        },
        error: null,
      };
    },

    create: async (locationData: {
      name: string;
      code?: string;
      address?: string;
      phone?: string;
      email?: string;
      contact_person?: string;
      credit_limit?: number;
      collection_percentage?: number;
      is_cash_collection_center?: boolean;
      notes?: string;
    }) => {
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) {
        return {
          data: null,
          error: new Error("No lab_id found for current user"),
        };
      }

      const { data, error } = await supabase
        .from("locations")
        .insert([{
          ...locationData,
          lab_id,
          is_active: true,
          created_at: new Date().toISOString(),
        }])
        .select()
        .single();
      return { data, error };
    },

    update: async (id: string, updates: {
      name?: string;
      code?: string;
      address?: string;
      phone?: string;
      email?: string;
      contact_person?: string;
      credit_limit?: number;
      collection_percentage?: number;
      is_cash_collection_center?: boolean;
      notes?: string;
      is_active?: boolean;
    }) => {
      const { data, error } = await supabase
        .from("locations")
        .update({
          ...updates,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id)
        .select()
        .single();
      return { data, error };
    },

    delete: async (id: string) => {
      const { data, error } = await supabase
        .from("locations")
        .update({
          is_active: false,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id)
        .select()
        .single();
      return { data, error };
    },

    checkCreditLimit: async (id: string, orderAmount: number) => {
      const { data: location, error } = await supabase
        .from("locations")
        .select(`
          *,
          credit_transactions!location_id(
            amount,
            transaction_type,
            created_at
          )
        `)
        .eq("id", id)
        .single();

      if (error || !location) {
        return {
          allowed: false,
          currentBalance: 0,
          creditLimit: 0,
          availableCredit: 0,
          name: "",
          error,
        };
      }

      // Calculate current credit balance
      const creditTransactions = location.credit_transactions || [];
      const totalCredits = creditTransactions
        .filter((t: any) => t.transaction_type === "credit")
        .reduce((sum: number, t: any) => sum + parseFloat(t.amount), 0);
      const totalDebits = creditTransactions
        .filter((t: any) => t.transaction_type === "debit")
        .reduce((sum: number, t: any) => sum + parseFloat(t.amount), 0);

      const currentBalance = totalCredits - totalDebits;
      const creditLimit = location.credit_limit || 0;
      const availableCredit = creditLimit - currentBalance;
      const allowed = orderAmount <= availableCredit;

      return {
        allowed,
        currentBalance,
        creditLimit,
        availableCredit,
        name: location.name,
        error: null,
      };
    },

    // Get collection centers (locations that collect samples)
    getCollectionCenters: async () => {
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) {
        return {
          data: null,
          error: new Error("No lab_id found for current user"),
        };
      }

      // Apply location filtering
      const filterCheck = await database.shouldFilterByLocation();

      let query = supabase
        .from("locations")
        .select("*")
        .eq("lab_id", lab_id)
        .eq("is_active", true)
        .eq("is_collection_center", true)
        .order("name");

      if (
        filterCheck.shouldFilter && !filterCheck.canViewAll &&
        filterCheck.locationIds.length > 0
      ) {
        query = query.in("id", filterCheck.locationIds);
      }

      const { data, error } = await query;
      return { data, error };
    },

    // Get processing centers (main labs that process samples)
    getProcessingCenters: async () => {
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) {
        return {
          data: null,
          error: new Error("No lab_id found for current user"),
        };
      }

      // Apply location filtering
      const filterCheck = await database.shouldFilterByLocation();

      let query = supabase
        .from("locations")
        .select("*")
        .eq("lab_id", lab_id)
        .eq("is_active", true)
        .eq("is_processing_center", true)
        .order("name");

      if (
        filterCheck.shouldFilter && !filterCheck.canViewAll &&
        filterCheck.locationIds.length > 0
      ) {
        query = query.in("id", filterCheck.locationIds);
      }

      const { data, error } = await query;
      return { data, error };
    },

    // Get locations that can receive samples
    getReceivingLocations: async () => {
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) {
        return {
          data: null,
          error: new Error("No lab_id found for current user"),
        };
      }

      // Apply location filtering
      const filterCheck = await database.shouldFilterByLocation();

      let query = supabase
        .from("locations")
        .select("*")
        .eq("lab_id", lab_id)
        .eq("is_active", true)
        .eq("can_receive_samples", true)
        .order("name");

      if (
        filterCheck.shouldFilter && !filterCheck.canViewAll &&
        filterCheck.locationIds.length > 0
      ) {
        query = query.in("id", filterCheck.locationIds);
      }

      const { data, error } = await query;
      return { data, error };
    },

    // Get default processing location for the lab
    getDefaultProcessingCenter: async () => {
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) {
        return {
          data: null,
          error: new Error("No lab_id found for current user"),
        };
      }

      const { data: lab, error: labError } = await supabase
        .from("labs")
        .select("default_processing_location_id")
        .eq("id", lab_id)
        .single();

      if (labError || !lab?.default_processing_location_id) {
        return { data: null, error: labError };
      }

      const { data, error } = await supabase
        .from("locations")
        .select("*")
        .eq("id", lab.default_processing_location_id)
        .single();

      return { data, error };
    },

    // Set location as collection center or processing center
    setLocationType: async (id: string, params: {
      is_collection_center?: boolean;
      is_processing_center?: boolean;
      can_receive_samples?: boolean;
    }) => {
      const { data, error } = await supabase
        .from("locations")
        .update({
          ...params,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id)
        .select()
        .single();
      return { data, error };
    },
  },

  // Accounts API
  accounts: {
    getAll: async () => {
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) {
        return {
          data: null,
          error: new Error("No lab_id found for current user"),
        };
      }

      const { data, error } = await supabase
        .from("accounts")
        .select("*")
        .eq("lab_id", lab_id)
        .eq("is_active", true)
        .order("name");
      return { data, error };
    },

    getById: async (id: string) => {
      const { data, error } = await supabase
        .from("accounts")
        .select("*")
        .eq("id", id)
        .single();
      return { data, error };
    },

    search: async (searchTerm: string) => {
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) {
        return {
          data: null,
          error: new Error("No lab_id found for current user"),
        };
      }

      const { data, error } = await supabase
        .from("accounts")
        .select("*")
        .eq("lab_id", lab_id)
        .eq("is_active", true)
        .or(
          `name.ilike.%${searchTerm}%,type.ilike.%${searchTerm}%,contact_person.ilike.%${searchTerm}%`,
        )
        .order("name")
        .limit(20);
      return { data, error };
    },

    create: async (accountData: {
      name: string;
      type:
        | "hospital"
        | "corporate"
        | "insurer"
        | "clinic"
        | "doctor"
        | "other";
      contact_person?: string;
      phone?: string;
      email?: string;
      address?: string;
      credit_limit?: number;
      default_discount_percent?: number;
      payment_terms?: number;
      notes?: string;
    }) => {
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) {
        return {
          data: null,
          error: new Error("No lab_id found for current user"),
        };
      }

      const { data, error } = await supabase
        .from("accounts")
        .insert([{
          ...accountData,
          lab_id,
          is_active: true,
          created_at: new Date().toISOString(),
        }])
        .select()
        .single();
      return { data, error };
    },

    update: async (id: string, updates: {
      name?: string;
      type?:
        | "hospital"
        | "corporate"
        | "insurer"
        | "clinic"
        | "doctor"
        | "other";
      contact_person?: string;
      phone?: string;
      email?: string;
      address?: string;
      credit_limit?: number;
      default_discount_percent?: number;
      payment_terms?: number;
      notes?: string;
      is_active?: boolean;
    }) => {
      const { data, error } = await supabase
        .from("accounts")
        .update({
          ...updates,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id)
        .select()
        .single();
      return { data, error };
    },

    delete: async (id: string) => {
      const { data, error } = await supabase
        .from("accounts")
        .update({
          is_active: false,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id)
        .select()
        .single();
      return { data, error };
    },

    // Uses the shared credit model (ledger debits less credits, plus pending
    // bookings held in reserve), so the order form agrees with the B2B portal
    // and the check-b2b-credit edge function. Note availableCredit can exceed
    // the credit limit when the partner is in advance - do not clamp it here.
    // Imported lazily to keep this module free of import cycles.
    checkCreditLimit: async (id: string, orderAmount: number) => {
      const { fetchAccountCreditSummary, isCreditAllowed } = await import("./accountCredit");
      const summary = await fetchAccountCreditSummary(id);

      if (!summary) {
        return {
          allowed: false,
          bypassCreditCheck: false,
          currentBalance: 0,
          creditLimit: 0,
          availableCredit: 0,
          name: "",
          error: new Error("Could not load account credit position"),
        };
      }

      return {
        // Accounts flagged in Account Master are never blocked by credit
        allowed: isCreditAllowed(summary, orderAmount),
        bypassCreditCheck: summary.bypassCreditCheck,
        bypassCreditUntil: summary.bypassCreditUntil,
        currentBalance: summary.effectiveCreditUsed,
        creditLimit: summary.creditLimit,
        availableCredit: summary.availableCredit,
        manualPaymentCredit: summary.manualPaymentCredit,
        name: summary.accountName,
        error: null,
      };
    },
  },

  // Order Tests API
  orderTests: {
    getUnbilledByOrder: async (orderId: string) => {
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) {
        return {
          data: null,
          error: new Error("No lab_id found for current user"),
        };
      }

      const { data, error } = await supabase
        .from("order_tests")
        .select("id, test_group_id, test_name, price, is_billed, invoice_id")
        .eq("order_id", orderId)
        .eq("is_billed", false)
        .order("test_name");

      return { data, error };
    },

    getAll: async (orderId: string) => {
      const { data, error } = await supabase
        .from("order_tests")
        .select("*")
        .eq("order_id", orderId)
        .order("test_name");

      return { data, error };
    },

    updateBillingStatus: async (testId: string, billingData: {
      is_billed: boolean;
      invoice_id?: string;
      billed_at?: string;
      billed_amount?: number;
    }) => {
      const { data, error } = await supabase
        .from("order_tests")
        .update(billingData)
        .eq("id", testId)
        .select()
        .single();

      return { data, error };
    },
  },

  // Enhanced Payments API
  enhancedPayments: {
    getAllPayments: async (filters?: {
      startDate?: string;
      endDate?: string;
      paymentMethod?: string;
      locationId?: string;
    }) => {
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) {
        return {
          data: null,
          error: new Error("No lab_id found for current user"),
        };
      }

      let query = supabase
        .from("payments")
        .select(`
          *,
          invoices(
            id,
            invoice_number,
            total_amount,
            status
          ),
          locations(
            id,
            name
          ),
          cash_registers(
            id,
            register_name
          )
        `)
        .eq("lab_id", lab_id);

      if (filters?.startDate) {
        query = query.gte("payment_date", filters.startDate);
      }
      if (filters?.endDate) {
        query = query.lte("payment_date", filters.endDate);
      }
      if (filters?.paymentMethod) {
        query = query.eq("payment_method", filters.paymentMethod);
      }
      if (filters?.locationId) {
        query = query.eq("location_id", filters.locationId);
      }

      const { data, error } = await query.order("payment_date", {
        ascending: false,
      });
      return { data, error };
    },

    createPayment: async (paymentData: {
      invoice_id: string;
      amount: number;
      payment_method:
        | "cash"
        | "card"
        | "upi"
        | "cheque"
        | "bank_transfer"
        | "credit";
      reference_number?: string;
      location_id?: string;
      cash_register_id?: string;
      cheque_number?: string;
      cheque_date?: string;
      bank_name?: string;
      notes?: string;
    }) => {
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) {
        return {
          data: null,
          error: new Error("No lab_id found for current user"),
        };
      }

      // Start transaction
      const { data: payment, error: paymentError } = await supabase
        .from("payments")
        .insert([{
          ...paymentData,
          lab_id,
          payment_date: new Date().toISOString().split("T")[0],
          created_at: new Date().toISOString(),
        }])
        .select()
        .single();

      if (paymentError) {
        return { data: null, error: paymentError };
      }

      // Update invoice status based on payment
      if (payment) {
        await masterDataAPI.enhancedPayments.updateInvoiceStatus(
          paymentData.invoice_id,
        );

        // If cash payment and register specified, update cash register
        if (
          paymentData.payment_method === "cash" && paymentData.cash_register_id
        ) {
          await masterDataAPI.cashRegister.addTransaction(
            paymentData.cash_register_id,
            {
              type: "collection",
              amount: paymentData.amount,
              description: `Payment for Invoice #${payment.id}`,
              reference_id: payment.id,
            },
          );
        }

        // If credit payment, create credit transaction
        if (
          paymentData.payment_method === "credit" && paymentData.location_id
        ) {
          await masterDataAPI.creditTransactions.create({
            location_id: paymentData.location_id,
            amount: paymentData.amount,
            type: "debit",
            description: `Payment for Invoice #${payment.id}`,
            reference_type: "payment",
            reference_id: payment.id,
          });
        }
      }

      return { data: payment, error: null };
    },

    updateInvoiceStatus: async (invoiceId: string) => {
      // Get total payments for this invoice
      const { data: payments } = await supabase
        .from("payments")
        .select("amount")
        .eq("invoice_id", invoiceId);

      // Get invoice total
      const { data: invoice } = await supabase
        .from("invoices")
        .select("total_amount")
        .eq("id", invoiceId)
        .single();

      if (!invoice || !payments) return;

      const totalPaid = payments.reduce(
        (sum, p) => sum + parseFloat(p.amount),
        0,
      );
      const invoiceTotal = parseFloat(invoice.total_amount);

      let status = "pending";
      if (totalPaid >= invoiceTotal) {
        status = "paid";
      } else if (totalPaid > 0) {
        status = "partially_paid";
      }

      await supabase
        .from("invoices")
        .update({
          status,
          updated_at: new Date().toISOString(),
        })
        .eq("id", invoiceId);
    },

    getPaymentsByInvoice: async (invoiceId: string) => {
      const { data, error } = await supabase
        .from("payments")
        .select(`
          *,
          locations(name),
          cash_registers(register_name)
        `)
        .eq("invoice_id", invoiceId)
        .order("payment_date", { ascending: false });
      return { data, error };
    },
  },

  // Cash Register API
  cashRegister: {
    getAll: async () => {
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) {
        return {
          data: null,
          error: new Error("No lab_id found for current user"),
        };
      }

      const { data, error } = await supabase
        .from("cash_registers")
        .select("*")
        .eq("lab_id", lab_id)
        .eq("is_active", true)
        .order("register_name");
      return { data, error };
    },

    getById: async (id: string) => {
      const { data, error } = await supabase
        .from("cash_registers")
        .select(`
          *,
          cash_register_transactions(
            id,
            type,
            amount,
            description,
            transaction_date,
            created_at
          )
        `)
        .eq("id", id)
        .single();

      if (error || !data) {
        return { data, error };
      }

      // Calculate current balance
      const transactions = data.cash_register_transactions || [];
      const collections = transactions
        .filter((t: any) => t.type === "collection")
        .reduce((sum: number, t: any) => sum + parseFloat(t.amount), 0);
      const expenses = transactions
        .filter((t: any) => t.type === "expense")
        .reduce((sum: number, t: any) => sum + parseFloat(t.amount), 0);

      const currentBalance = parseFloat(data.opening_balance) + collections -
        expenses;

      return {
        data: {
          ...data,
          current_balance: currentBalance,
          total_collections: collections,
          total_expenses: expenses,
        },
        error: null,
      };
    },

    create: async (registerData: {
      register_name: string;
      location_id?: string;
      opening_balance: number;
      responsible_person?: string;
      description?: string;
    }) => {
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) {
        return {
          data: null,
          error: new Error("No lab_id found for current user"),
        };
      }

      const { data, error } = await supabase
        .from("cash_registers")
        .insert([{
          ...registerData,
          lab_id,
          is_active: true,
          created_at: new Date().toISOString(),
        }])
        .select()
        .single();
      return { data, error };
    },

    addTransaction: async (registerId: string, transactionData: {
      type: "collection" | "expense";
      amount: number;
      description: string;
      reference_id?: string;
    }) => {
      const { data, error } = await supabase
        .from("cash_register_transactions")
        .insert([{
          cash_register_id: registerId,
          ...transactionData,
          transaction_date: new Date().toISOString().split("T")[0],
          created_at: new Date().toISOString(),
        }])
        .select()
        .single();
      return { data, error };
    },

    getDailyReconciliation: async (registerId: string, date: string) => {
      const { data: register, error: registerError } = await masterDataAPI
        .cashRegister.getById(registerId);
      if (registerError || !register) {
        return { data: null, error: registerError };
      }

      const { data: transactions, error: transactionsError } = await supabase
        .from("cash_register_transactions")
        .select("*")
        .eq("cash_register_id", registerId)
        .eq("transaction_date", date)
        .order("created_at");

      if (transactionsError) {
        return { data: null, error: transactionsError };
      }

      const dailyCollections = transactions
        ?.filter((t) => t.type === "collection")
        .reduce((sum, t) => sum + parseFloat(t.amount), 0) || 0;

      const dailyExpenses = transactions
        ?.filter((t) => t.type === "expense")
        .reduce((sum, t) => sum + parseFloat(t.amount), 0) || 0;

      return {
        data: {
          register,
          date,
          transactions: transactions || [],
          daily_collections: dailyCollections,
          daily_expenses: dailyExpenses,
          net_change: dailyCollections - dailyExpenses,
          expected_balance: register.current_balance,
        },
        error: null,
      };
    },

    closeDay: async (registerId: string, closingData: {
      closing_balance: number;
      variance?: number;
      notes?: string;
    }) => {
      const date = new Date().toISOString().split("T")[0];

      const { data, error } = await supabase
        .from("cash_register_closings")
        .insert([{
          cash_register_id: registerId,
          closing_date: date,
          ...closingData,
          created_at: new Date().toISOString(),
        }])
        .select()
        .single();
      return { data, error };
    },

    // Phase 4 methods for CashReconciliation
    getOrCreate: async (
      date: string,
      locationId: string,
      shift: "morning" | "afternoon" | "night" | "full_day",
    ) => {
      const labId = await database.getCurrentUserLabId();
      const { data, error } = await supabase
        .from("cash_register")
        .select("*")
        .eq("lab_id", labId)
        .eq("register_date", date)
        .eq("location_id", locationId)
        .eq("shift", shift)
        .maybeSingle();

      if (error) return { data: null, error };
      if (data) return { data, error: null };

      // Get current user ID for created_by
      const { data: { user } } = await supabase.auth.getUser();

      const { data: created, error: insertErr } = await supabase
        .from("cash_register")
        .insert({
          lab_id: labId,
          register_date: date,
          location_id: locationId,
          shift,
          opening_balance: 0,
          system_amount: 0,
          created_by: user?.id || null,
        })
        .select("*")
        .single();
      return { data: created, error: insertErr };
    },

    update: async (id: string, patch: Partial<{ system_amount: number }>) =>
      supabase.from("cash_register").update(patch).eq("id", id),

    reconcile: async (id: string, actualAmount: number, notes?: string) => {
      // Get current user ID for reconciled_by
      const { data: { user } } = await supabase.auth.getUser();

      // Get current register data to calculate closing_balance
      const { data: register } = await supabase
        .from("cash_register")
        .select("opening_balance, system_amount")
        .eq("id", id)
        .single();

      const closingBalance = register
        ? parseFloat(register.opening_balance) +
          parseFloat(register.system_amount)
        : actualAmount;

      return supabase
        .from("cash_register")
        .update({
          actual_amount: actualAmount,
          closing_balance: closingBalance,
          variance: actualAmount - closingBalance,
          reconciled: true,
          reconciled_by: user?.id || null,
          reconciled_at: new Date().toISOString(),
          notes: notes || null,
        })
        .eq("id", id);
    },
  },

  // Credit Transactions API
  creditTransactions: {
    getByLocation: async (locationId: string, limit?: number) => {
      let query = supabase
        .from("credit_transactions")
        .select("*")
        .eq("location_id", locationId)
        .order("created_at", { ascending: false });

      if (limit) {
        query = query.limit(limit);
      }

      const { data, error } = await query;
      return { data, error };
    },

    create: async (transactionData: {
      location_id: string;
      amount: number;
      type: "credit" | "debit";
      description: string;
      reference_type?: string;
      reference_id?: string;
      notes?: string;
    }) => {
      const { data, error } = await supabase
        .from("credit_transactions")
        .insert([{
          ...transactionData,
          transaction_date: new Date().toISOString().split("T")[0],
          created_at: new Date().toISOString(),
        }])
        .select()
        .single();
      return { data, error };
    },

    getCreditSummaryByLocation: async (locationId: string) => {
      const { data: transactions, error } = await supabase
        .from("credit_transactions")
        .select("amount, type")
        .eq("location_id", locationId);

      if (error || !transactions) {
        return { data: null, error };
      }

      const totalCredits = transactions
        .filter((t) => t.type === "credit")
        .reduce((sum, t) => sum + parseFloat(t.amount), 0);

      const totalDebits = transactions
        .filter((t) => t.type === "debit")
        .reduce((sum, t) => sum + parseFloat(t.amount), 0);

      return {
        data: {
          location_id: locationId,
          total_credits: totalCredits,
          total_debits: totalDebits,
          current_balance: totalCredits - totalDebits,
        },
        error: null,
      };
    },

    getLocationCreditReport: async (startDate?: string, endDate?: string) => {
      const lab_id = await database.getCurrentUserLabId();
      if (!lab_id) {
        return {
          data: null,
          error: new Error("No lab_id found for current user"),
        };
      }

      let query = supabase
        .from("credit_transactions")
        .select(`
          *,
          locations!location_id(
            id,
            name,
            credit_limit
          )
        `)
        .eq("locations.lab_id", lab_id);

      if (startDate) {
        query = query.gte("transaction_date", startDate);
      }
      if (endDate) {
        query = query.lte("transaction_date", endDate);
      }

      const { data, error } = await query.order("transaction_date", {
        ascending: false,
      });
      return { data, error };
    },
  },

  // --- NEW Phase 4: Account-aware invoice helpers used by Billing page/PaymentCapture ---
  // NOTE: Renamed to avoid overriding the primary invoices API above (which includes create/update/delete)
  invoicesV4: {
    getById: async (id: string) =>
      supabase
        .from("invoices")
        .select("*, locations(name), accounts(name)")
        .eq("id", id)
        .single(),

    getAll: async () =>
      supabase
        .from("invoices")
        .select("*, locations(name), accounts(name)")
        .order("created_at", { ascending: false }),

    getByStatus: async (status: "Unpaid" | "Paid" | "Partial") =>
      supabase
        .from("invoices")
        .select("*, locations(name), accounts(name)")
        .eq("status", status)
        .order("created_at", { ascending: false }),
  },
  // --- Phase 4: Payments - USING ENHANCED VERSION FROM LINES 2688-2850 ---
  // Legacy direct insert removed - now using enhanced version with auto-population
};

// Branding & Signature System API
const brandingSignatureAPI = {
  // Lab Branding Assets
  labBrandingAssets: {
    getAll: async (labIdOverride?: string) => {
      const labId = labIdOverride || await database.getCurrentUserLabId();
      if (!labId) {
        return {
          data: [],
          error: new Error("No lab_id found for current user"),
        };
      }

      const { data, error } = await supabase
        .from("lab_branding_assets")
        .select("*")
        .eq("lab_id", labId)
        .eq("is_active", true)
        .order("asset_type")
        .order("is_default", { ascending: false })
        .order("created_at", { ascending: false });

      return { data: (data as LabBrandingAsset[]) || [], error };
    },

    getByType: async (assetType: string, labIdOverride?: string) => {
      const labId = labIdOverride || await database.getCurrentUserLabId();
      if (!labId) {
        return {
          data: [],
          error: new Error("No lab_id found for current user"),
        };
      }

      const { data, error } = await supabase
        .from("lab_branding_assets")
        .select("*")
        .eq("lab_id", labId)
        .eq("asset_type", assetType)
        .eq("is_active", true)
        .order("is_default", { ascending: false })
        .order("created_at", { ascending: false });

      return { data: (data as LabBrandingAsset[]) || [], error };
    },

    getDefault: async (assetType: string, labIdOverride?: string) => {
      const labId = labIdOverride || await database.getCurrentUserLabId();
      if (!labId) {
        return {
          data: null,
          error: new Error("No lab_id found for current user"),
        };
      }

      const { data, error } = await supabase
        .from("lab_branding_assets")
        .select("*")
        .eq("lab_id", labId)
        .eq("asset_type", assetType)
        .eq("is_default", true)
        .eq("is_active", true)
        .maybeSingle();

      return { data: data as LabBrandingAsset | null, error };
    },

    create: async (assetData: {
      asset_type: "header" | "footer" | "watermark" | "logo" | "letterhead";
      asset_name: string;
      file: File;
      description?: string;
      usage_context?: string[];
      is_default?: boolean;
      dimensions?: { width: number; height: number };
    }) => {
      const labId = await database.getCurrentUserLabId();
      if (!labId) {
        return {
          data: null,
          error: new Error("No lab_id found for current user"),
        };
      }

      const { data: { user } } = await supabase.auth.getUser();
      const userId = user?.id;

      // Generate file path
      const filePath = generateBrandingFilePath(
        labId,
        assetData.asset_type,
        assetData.file.name,
      );

      // Upload file to storage
      const { error: uploadError } = await supabase.storage
        .from("attachments")
        .upload(filePath, assetData.file);

      if (uploadError) {
        return { data: null, error: uploadError };
      }

      // Get public URL
      const { data: { publicUrl } } = supabase.storage
        .from("attachments")
        .getPublicUrl(filePath);

      // Create database record
      const { data, error } = await supabase
        .from("lab_branding_assets")
        .insert([{
          lab_id: labId,
          asset_type: assetData.asset_type,
          asset_name: assetData.asset_name,
          file_url: publicUrl,
          file_path: filePath,
          file_type: assetData.file.type,
          file_size: assetData.file.size,
          dimensions: assetData.dimensions,
          description: assetData.description,
          usage_context: assetData.usage_context || ["reports"],
          is_default: assetData.is_default || false,
          is_active: true,
          created_by: userId,
          updated_by: userId,
        }])
        .select()
        .single();

      return { data: data as LabBrandingAsset | null, error };
    },

    update: async (assetId: string, updates: {
      asset_name?: string;
      description?: string;
      usage_context?: string[];
      is_active?: boolean;
    }) => {
      const { data: { user } } = await supabase.auth.getUser();
      const userId = user?.id;

      const { data, error } = await supabase
        .from("lab_branding_assets")
        .update({
          ...updates,
          updated_by: userId,
          updated_at: new Date().toISOString(),
        })
        .eq("id", assetId)
        .select()
        .single();

      return { data: data as LabBrandingAsset | null, error };
    },

    setDefault: async (assetId: string, labIdOverride?: string) => {
      const labId = labIdOverride || await database.getCurrentUserLabId();
      if (!labId) {
        return {
          data: null,
          error: new Error("No lab_id found for current user"),
        };
      }

      // Get asset to find its type
      const { data: asset, error: assetError } = await supabase
        .from("lab_branding_assets")
        .select("asset_type")
        .eq("id", assetId)
        .single();

      if (assetError || !asset) {
        return {
          data: null,
          error: assetError || new Error("Asset not found"),
        };
      }

      // Use RPC function to set default
      const { data, error } = await supabase.rpc("set_default_branding_asset", {
        p_asset_id: assetId,
        p_lab_id: labId,
        p_asset_type: asset.asset_type,
      });

      if (error) {
        return { data, error };
      }

      const shouldSync = asset.asset_type === "header" ||
        asset.asset_type === "footer";
      if (shouldSync) {
        const syncResult = await syncLabBrandingDefaultsForLab(labId);
        if (syncResult.error) {
          return { data, error: syncResult.error };
        }
      }

      return { data, error: null };
    },

    delete: async (assetId: string) => {
      // Get asset file path
      const { data: asset, error: fetchError } = await supabase
        .from("lab_branding_assets")
        .select("file_path")
        .eq("id", assetId)
        .single();

      if (fetchError) {
        return { error: fetchError };
      }

      // Delete from storage
      if (asset?.file_path) {
        await supabase.storage
          .from("attachments")
          .remove([asset.file_path]);
      }

      // Delete from database
      const { error } = await supabase
        .from("lab_branding_assets")
        .delete()
        .eq("id", assetId);

      return { error };
    },
  },

  // User Signatures
  userSignatures: {
    getAll: async (userIdOverride?: string, labIdOverride?: string) => {
      const labId = labIdOverride || await database.getCurrentUserLabId();
      if (!labId) {
        return {
          data: [],
          error: new Error("No lab_id found for current user"),
        };
      }

      const { data: { user } } = await supabase.auth.getUser();
      const userId = userIdOverride || user?.id;

      if (!userId) {
        return { data: [], error: new Error("No user_id found") };
      }

      const { data, error } = await supabase
        .from("lab_user_signatures")
        .select("*")
        .eq("lab_id", labId)
        .eq("user_id", userId)
        .eq("is_active", true)
        .order("is_default", { ascending: false })
        .order("created_at", { ascending: false });

      return { data: (data as LabUserSignature[]) || [], error };
    },

    getAllForLab: async (labIdOverride?: string) => {
      const labId = labIdOverride || await database.getCurrentUserLabId();
      if (!labId) {
        return {
          data: [],
          error: new Error("No lab_id found for current user"),
        };
      }

      const { data, error } = await supabase
        .from("lab_user_signatures")
        .select(`
          *,
          users!user_id(id, name, email, role)
        `)
        .eq("lab_id", labId)
        .eq("is_active", true)
        .order("created_at", { ascending: false });

      return { data: (data as any[]) || [], error };
    },

    getDefault: async (userIdOverride?: string, labIdOverride?: string) => {
      const labId = labIdOverride || await database.getCurrentUserLabId();
      if (!labId) {
        return {
          data: null,
          error: new Error("No lab_id found for current user"),
        };
      }

      const { data: { user } } = await supabase.auth.getUser();
      const userId = userIdOverride || user?.id;

      if (!userId) {
        return { data: null, error: new Error("No user_id found") };
      }

      const { data, error } = await supabase
        .from("lab_user_signatures")
        .select("*")
        .eq("lab_id", labId)
        .eq("user_id", userId)
        .eq("is_default", true)
        .eq("is_active", true)
        .maybeSingle();

      return { data: data as LabUserSignature | null, error };
    },

    create: async (signatureData: {
      signature_type: "digital" | "handwritten" | "stamp" | "text";
      signature_name: string;
      file?: File;
      text_signature?: string;
      signature_data?: Record<string, any>;
      description?: string;
      usage_context?: string[];
      is_default?: boolean;
      dimensions?: { width: number; height: number };
    }) => {
      const labId = await database.getCurrentUserLabId();
      if (!labId) {
        return {
          data: null,
          error: new Error("No lab_id found for current user"),
        };
      }

      const { data: { user } } = await supabase.auth.getUser();
      const userId = user?.id;

      if (!userId) {
        return { data: null, error: new Error("No user_id found") };
      }

      let filePath: string | undefined;
      let fileUrl: string | undefined;
      let fileType: string | undefined;
      let fileSize: number | undefined;

      // Upload file if provided (for digital/handwritten/stamp signatures)
      if (signatureData.file) {
        filePath = generateSignatureFilePath(
          labId,
          userId,
          signatureData.file.name,
        );

        const { error: uploadError } = await supabase.storage
          .from("attachments")
          .upload(filePath, signatureData.file);

        if (uploadError) {
          return { data: null, error: uploadError };
        }

        const { data: { publicUrl } } = supabase.storage
          .from("attachments")
          .getPublicUrl(filePath);

        fileUrl = publicUrl;
        fileType = signatureData.file.type;
        fileSize = signatureData.file.size;
      }

      // Create database record
      const { data, error } = await supabase
        .from("lab_user_signatures")
        .insert([{
          lab_id: labId,
          user_id: userId,
          signature_type: signatureData.signature_type,
          signature_name: signatureData.signature_name,
          file_url: fileUrl,
          file_path: filePath,
          file_type: fileType,
          file_size: fileSize,
          dimensions: signatureData.dimensions,
          text_signature: signatureData.text_signature,
          signature_data: signatureData.signature_data,
          description: signatureData.description,
          usage_context: signatureData.usage_context || ["reports"],
          is_default: signatureData.is_default || false,
          is_active: true,
          created_by: userId,
          updated_by: userId,
        }])
        .select()
        .single();

      return { data: data as LabUserSignature | null, error };
    },

    update: async (signatureId: string, updates: {
      signature_name?: string;
      text_signature?: string;
      signature_data?: Record<string, any>;
      description?: string;
      usage_context?: string[];
      is_active?: boolean;
    }) => {
      const { data: { user } } = await supabase.auth.getUser();
      const userId = user?.id;

      const { data, error } = await supabase
        .from("lab_user_signatures")
        .update({
          ...updates,
          updated_by: userId,
          updated_at: new Date().toISOString(),
        })
        .eq("id", signatureId)
        .select()
        .single();

      return { data: data as LabUserSignature | null, error };
    },

    setDefault: async (
      signatureId: string,
      userIdOverride?: string,
      labIdOverride?: string,
    ) => {
      const labId = labIdOverride || await database.getCurrentUserLabId();
      if (!labId) {
        return {
          data: null,
          error: new Error("No lab_id found for current user"),
        };
      }

      const { data: { user } } = await supabase.auth.getUser();
      const userId = userIdOverride || user?.id;

      if (!userId) {
        return { data: null, error: new Error("No user_id found") };
      }

      // Use RPC function to set default
      const { data, error } = await supabase.rpc("set_default_user_signature", {
        p_signature_id: signatureId,
        p_user_id: userId,
        p_lab_id: labId,
      });

      return { data, error };
    },

    delete: async (signatureId: string) => {
      // Get signature file path
      const { data: signature, error: fetchError } = await supabase
        .from("lab_user_signatures")
        .select("file_path")
        .eq("id", signatureId)
        .single();

      if (fetchError) {
        return { error: fetchError };
      }

      // Delete from storage if file exists
      if (signature?.file_path) {
        await supabase.storage
          .from("attachments")
          .remove([signature.file_path]);
      }

      // Delete from database
      const { error } = await supabase
        .from("lab_user_signatures")
        .delete()
        .eq("id", signatureId);

      return { error };
    },
  },

  // =============================================
  // Outsourced Reports Management API
  // =============================================
  outsourcedReports: {
    getAll: async (filters?: {
      status?: string;
      matched?: "matched" | "unmatched";
      dateRange?: { start: string; end: string };
      labId?: string;
    }) => {
      const labId = filters?.labId || await database.getCurrentUserLabId();
      if (!labId) {
        return {
          data: null,
          error: new Error("No lab_id found for current user"),
        };
      }

      let query = supabase
        .from("outsourced_reports")
        .select("*")
        .eq("lab_id", labId);

      if (filters?.status) {
        query = query.eq("status", filters.status);
      }

      if (filters?.matched === "matched") {
        query = query.not("order_id", "is", null);
      } else if (filters?.matched === "unmatched") {
        query = query.is("order_id", null);
      }

      if (filters?.dateRange) {
        query = query
          .gte("received_at", filters.dateRange.start)
          .lte("received_at", filters.dateRange.end);
      }

      query = query.order("received_at", { ascending: false });

      const { data, error } = await query;
      return { data, error };
    },

    getById: async (reportId: string) => {
      const { data, error } = await supabase
        .from("outsourced_reports")
        .select("*")
        .eq("id", reportId)
        .single();

      return { data, error };
    },

    linkToOrder: async (
      reportId: string,
      orderId: string,
      patientId: string,
      confidence?: number,
    ) => {
      const { data: { user } } = await supabase.auth.getUser();
      const userId = user?.id;

      const { data, error } = await supabase
        .from("outsourced_reports")
        .update({
          order_id: orderId,
          patient_id: patientId,
          match_confidence: confidence || null,
          matched_at: new Date().toISOString(),
          matched_by: userId || null,
          status: "verified",
        })
        .eq("id", reportId)
        .select()
        .single();

      if (!error && orderId) {
        // Update related result's outsourced_status to 'received'
        await supabase
          .from("results")
          .update({ outsourced_status: "received" })
          .eq("order_id", orderId)
          .in("outsourced_status", ["sent", "awaiting_report"]);
      }

      return { data, error };
    },

    suggestMatches: async (reportId: string, maxResults: number = 5) => {
      const { data: report, error: reportError } = await supabase
        .from("outsourced_reports")
        .select("ai_extracted_data, received_at, lab_id")
        .eq("id", reportId)
        .single();

      if (reportError || !report) {
        return {
          data: null,
          error: reportError || new Error("Report not found"),
        };
      }

      const extractedData = report.ai_extracted_data as any;
      const patientName = extractedData?.patient_name;
      const testName = extractedData?.test_name;

      if (!patientName) {
        return { data: [], error: null };
      }

      // Get lab settings for date range
      const { data: settings } = await supabase
        .from("lab_outsourcing_settings")
        .select("match_date_range_days")
        .eq("lab_id", report.lab_id)
        .single();

      const dateRangeDays = settings?.match_date_range_days || 7;
      const startDate = new Date(report.received_at);
      startDate.setDate(startDate.getDate() - dateRangeDays);
      const endDate = new Date(report.received_at);
      endDate.setDate(endDate.getDate() + dateRangeDays);

      // Fuzzy match orders by patient name and date range
      const { data: orders, error: ordersError } = await supabase
        .from("orders")
        .select(`
          id,
          order_number,
          patient_id,
          patient_name,
          order_date,
          order_tests!inner(test_name, outsourced_lab_id)
        `)
        .eq("lab_id", report.lab_id)
        .gte("order_date", startDate.toISOString())
        .lte("order_date", endDate.toISOString())
        .not("order_tests.outsourced_lab_id", "is", null);

      if (ordersError || !orders) {
        return { data: [], error: ordersError };
      }

      // Calculate match confidence for each order
      const suggestions = orders
        .map((order: any) => {
          const matchReasons: string[] = [];
          let confidence = 0;

          // Name similarity (simplified - basic comparison)
          const nameLower = patientName.toLowerCase();
          const orderNameLower = order.patient_name.toLowerCase();

          if (orderNameLower === nameLower) {
            confidence += 0.5;
            matchReasons.push("Exact name match");
          } else if (
            orderNameLower.includes(nameLower) ||
            nameLower.includes(orderNameLower)
          ) {
            confidence += 0.3;
            matchReasons.push("Partial name match");
          }

          // Test name matching
          const orderTestNames = (order.order_tests || []).map((ot: any) =>
            ot.test_name.toLowerCase()
          );
          if (
            testName && orderTestNames.some((tn: string) =>
              tn.includes(testName.toLowerCase())
            )
          ) {
            confidence += 0.3;
            matchReasons.push("Test name match");
          }

          // Date proximity
          const daysDiff = Math.abs(
            (new Date(order.order_date).getTime() -
              new Date(report.received_at).getTime()) / (1000 * 60 * 60 * 24),
          );
          if (daysDiff <= 1) {
            confidence += 0.2;
            matchReasons.push("Same day order");
          } else if (daysDiff <= 3) {
            confidence += 0.1;
            matchReasons.push("Recent order");
          }

          return {
            order_id: order.id,
            patient_id: order.patient_id,
            patient_name: order.patient_name,
            order_number: order.order_number,
            order_date: order.order_date,
            confidence: Math.min(confidence, 1.0),
            match_reasons: matchReasons,
            test_names: orderTestNames,
          };
        })
        .filter((s: any) => s.confidence > 0.2)
        .sort((a: any, b: any) => b.confidence - a.confidence)
        .slice(0, maxResults);

      // Store suggestions in the report
      await supabase
        .from("outsourced_reports")
        .update({ match_suggestions: suggestions })
        .eq("id", reportId);

      return { data: suggestions, error: null };
    },

    updateLogisticsStatus: async (
      resultId: string,
      logisticsStatus: string,
      notes?: string,
      outsourcedStatus?: string, // ✅ Add parameter to update outsourced_status
    ) => {
      const { data: { user } } = await supabase.auth.getUser();
      const userId = user?.id;

      const updateData: any = {
        outsourced_logistics_status: logisticsStatus,
        logistics_notes: notes || null,
      };

      // ✅ Update outsourced_status if provided
      if (outsourcedStatus) {
        updateData.outsourced_status = outsourcedStatus;
      }

      if (logisticsStatus === "in_transit") {
        updateData.dispatched_at = new Date().toISOString();
        updateData.dispatched_by = userId;
      }

      const { data, error } = await supabase
        .from("results")
        .update(updateData)
        .eq("id", resultId)
        .select()
        .single();

      return { data, error };
    },

    getPendingTests: async (filters?: {
      outsourcedLabId?: string;
      status?: string;
      fromDate?: string;
      toDate?: string;
      locationIds?: string[]; // ✅ Add location filter parameter
    }) => {
      const labId = await database.getCurrentUserLabId();
      if (!labId) {
        return {
          data: null,
          error: new Error("No lab_id found for current user"),
        };
      }

      let query = supabase
        .from("results")
        .select(`
          id,
          order_id,
          test_name,
          outsourced_to_lab_id,
          outsourced_status,
          outsourced_logistics_status,
          tracking_barcode,
          dispatched_at,
          dispatched_by,
          outsourced_tat_estimate,
          logistics_notes,
          created_at,
          orders!inner(
            order_number,
            patient_id,
            patient_name,
            order_date,
            location_id
          ),
          outsourced_labs(name)
        `)
        .eq("lab_id", labId)
        .not("outsourced_to_lab_id", "is", null);

      if (filters?.outsourcedLabId) {
        query = query.eq("outsourced_to_lab_id", filters.outsourcedLabId);
      }

      // ✅ Updated logic: awaiting_report includes sent tests (unless cancelled)
      if (filters?.status === "awaiting_report") {
        // Show both 'awaiting_report' AND 'sent' tests (dispatched ones)
        // Exclude only if explicitly cancelled (logistics_status = 'pending_dispatch' with status = 'pending_send')
        query = query.in("outsourced_status", ["awaiting_report", "sent"]);
      } else if (filters?.status) {
        query = query.eq("outsourced_status", filters.status);
      } else {
        query = query.in("outsourced_status", [
          "pending_send",
          "sent",
          "awaiting_report",
        ]);
      }

      // ✅ Add date filters
      if (filters?.fromDate) {
        query = query.gte("created_at", filters.fromDate);
      }

      if (filters?.toDate) {
        // Add one day to include the entire end date
        const endDate = new Date(filters.toDate);
        endDate.setDate(endDate.getDate() + 1);
        query = query.lt("created_at", endDate.toISOString());
      }

      // ✅ Add location filtering
      if (filters?.locationIds && filters.locationIds.length > 0) {
        query = query.in("orders.location_id", filters.locationIds);
      }

      query = query.order("created_at", { ascending: false });

      const { data, error } = await query;

      // Transform to flat structure
      const transformedData = data?.map((item: any) => ({
        result_id: item.id,
        order_id: item.order_id,
        order_number: item.orders?.order_number,
        patient_id: item.orders?.patient_id,
        patient_name: item.orders?.patient_name,
        test_name: item.test_name,
        outsourced_to_lab_id: item.outsourced_to_lab_id,
        outsourced_lab_name: item.outsourced_labs?.name,
        outsourced_status: item.outsourced_status,
        outsourced_logistics_status: item.outsourced_logistics_status,
        tracking_barcode: item.tracking_barcode,
        dispatched_at: item.dispatched_at,
        dispatched_by: item.dispatched_by,
        outsourced_tat_estimate: item.outsourced_tat_estimate,
        logistics_notes: item.logistics_notes,
        created_at: item.created_at,
      }));

      return { data: transformedData, error };
    },

    getLabSettings: async (labId?: string) => {
      const targetLabId = labId || await database.getCurrentUserLabId();
      if (!targetLabId) {
        return { data: null, error: new Error("No lab_id found") };
      }

      const { data, error } = await supabase
        .from("lab_outsourcing_settings")
        .select("*")
        .eq("lab_id", targetLabId)
        .single();

      return { data, error };
    },

    updateLabSettings: async (settings: Partial<any>) => {
      const labId = await database.getCurrentUserLabId();
      if (!labId) {
        return {
          data: null,
          error: new Error("No lab_id found for current user"),
        };
      }

      const { data, error } = await supabase
        .from("lab_outsourcing_settings")
        .upsert({
          lab_id: labId,
          ...settings,
          updated_at: new Date().toISOString(),
        })
        .eq("lab_id", labId)
        .select()
        .single();

      return { data, error };
    },

    generateTrackingBarcode: async (resultId: string) => {
      const barcode = `OUT-${Date.now()}-${resultId.slice(0, 8)}`;

      const { data, error } = await supabase
        .from("results")
        .update({ tracking_barcode: barcode })
        .eq("id", resultId)
        .select()
        .single();

      return { data: { barcode, ...data }, error };
    },
  },

  // ============================================================
  // INTRA-LAB SAMPLE TRANSIT MANAGEMENT
  // ============================================================
  sampleTransits: {
    // Get all transits for current lab with optional filters
    getAll: async (filters?: {
      status?: string;
      fromLocationId?: string;
      toLocationId?: string;
      fromDate?: string;
      toDate?: string;
    }) => {
      const labId = await database.getCurrentUserLabId();
      if (!labId) {
        return {
          data: null,
          error: new Error("No lab_id found for current user"),
        };
      }

      let query = supabase
        .from("sample_transits")
        .select(`
          *,
          from_location:locations!sample_transits_from_location_id_fkey(id, name, type),
          to_location:locations!sample_transits_to_location_id_fkey(id, name, type),
          orders(id, order_number, patient_name, order_date),
          samples(id, sample_type, barcode),
          dispatched_by_user:users!sample_transits_dispatched_by_fkey(id, name),
          received_by_user:users!sample_transits_received_by_fkey(id, name)
        `)
        .eq("lab_id", labId);

      if (filters?.status) {
        query = query.eq("status", filters.status);
      }
      if (filters?.fromLocationId) {
        query = query.eq("from_location_id", filters.fromLocationId);
      }
      if (filters?.toLocationId) {
        query = query.eq("to_location_id", filters.toLocationId);
      }
      if (filters?.fromDate) {
        query = query.gte("created_at", filters.fromDate);
      }
      if (filters?.toDate) {
        const endDate = new Date(filters.toDate);
        endDate.setDate(endDate.getDate() + 1);
        query = query.lt("created_at", endDate.toISOString());
      }

      query = query.order("created_at", { ascending: false });

      const { data, error } = await query;
      return { data, error };
    },

    // Get pending dispatch items for a location
    getPendingDispatch: async (fromLocationId?: string) => {
      const labId = await database.getCurrentUserLabId();
      if (!labId) {
        return {
          data: null,
          error: new Error("No lab_id found for current user"),
        };
      }

      // Get orders with samples collected at location but not yet dispatched
      let query = supabase
        .from("orders")
        .select(`
          id,
          order_number,
          patient_name,
          order_date,
          location_id,
          collected_at_location_id,
          transit_status,
          sample_collected_at,
          locations!orders_location_id_fkey(id, name, type)
        `)
        .eq("lab_id", labId)
        .in("transit_status", ["at_collection_point", "pending_dispatch"])
        .not("sample_collected_at", "is", null);

      if (fromLocationId) {
        query = query.or(
          `location_id.eq.${fromLocationId},collected_at_location_id.eq.${fromLocationId}`,
        );
      }

      query = query.order("sample_collected_at", { ascending: true });

      const { data, error } = await query;
      return { data, error };
    },

    // Create a new transit record (dispatch samples)
    create: async (transitData: {
      order_id?: string;
      sample_id?: string;
      from_location_id: string;
      to_location_id: string;
      priority?: "urgent" | "high" | "normal" | "low";
      dispatch_notes?: string;
      estimated_arrival_at?: string;
      batch_id?: string;
    }) => {
      const labId = await database.getCurrentUserLabId();
      if (!labId) {
        return {
          data: null,
          error: new Error("No lab_id found for current user"),
        };
      }

      const { data: { user } } = await supabase.auth.getUser();
      const { data: userData } = await supabase
        .from("users")
        .select("id")
        .eq("email", user?.email)
        .single();

      // Generate tracking barcode
      const barcode = `TRN-${Date.now()}-${
        Math.random().toString(36).slice(2, 8).toUpperCase()
      }`;

      const { data, error } = await supabase
        .from("sample_transits")
        .insert([{
          lab_id: labId,
          ...transitData,
          status: "pending_dispatch",
          tracking_barcode: barcode,
          dispatched_at: new Date().toISOString(),
          dispatched_by: userData?.id,
        }])
        .select()
        .single();

      // Update order transit_status if order_id provided
      if (!error && transitData.order_id) {
        await supabase
          .from("orders")
          .update({ transit_status: "pending_dispatch" })
          .eq("id", transitData.order_id);
      }

      return { data, error };
    },

    // Bulk dispatch multiple orders
    bulkDispatch: async (params: {
      order_ids: string[];
      from_location_id: string;
      to_location_id: string;
      priority?: "urgent" | "high" | "normal" | "low";
      dispatch_notes?: string;
    }) => {
      const labId = await database.getCurrentUserLabId();
      if (!labId) {
        return {
          data: null,
          error: new Error("No lab_id found for current user"),
        };
      }

      const { data: { user } } = await supabase.auth.getUser();
      const { data: userData } = await supabase
        .from("users")
        .select("id")
        .eq("email", user?.email)
        .single();

      // Generate batch ID
      const batchId = crypto.randomUUID();
      const now = new Date().toISOString();

      // Create transit records for each order
      const transitRecords = params.order_ids.map((orderId, idx) => ({
        lab_id: labId,
        order_id: orderId,
        from_location_id: params.from_location_id,
        to_location_id: params.to_location_id,
        status: "in_transit",
        tracking_barcode: `TRN-${Date.now()}-${idx}-${
          Math.random().toString(36).slice(2, 6).toUpperCase()
        }`,
        dispatched_at: now,
        dispatched_by: userData?.id,
        priority: params.priority || "normal",
        dispatch_notes: params.dispatch_notes,
        batch_id: batchId,
      }));

      const { data, error } = await supabase
        .from("sample_transits")
        .insert(transitRecords)
        .select();

      // Update all orders to in_transit
      if (!error) {
        await supabase
          .from("orders")
          .update({ transit_status: "in_transit" })
          .in("id", params.order_ids);
      }

      return { data, error, batchId };
    },

    // Update transit status
    updateStatus: async (transitId: string, status: string, notes?: string) => {
      const { data: { user } } = await supabase.auth.getUser();
      const { data: userData } = await supabase
        .from("users")
        .select("id")
        .eq("email", user?.email)
        .single();

      const updateData: any = { status };

      if (status === "in_transit") {
        updateData.dispatched_at = new Date().toISOString();
        updateData.dispatched_by = userData?.id;
      } else if (status === "delivered" || status === "received") {
        updateData.received_at = new Date().toISOString();
        updateData.received_by = userData?.id;
        if (notes) updateData.receipt_notes = notes;
      } else if (status === "issue_reported") {
        updateData.issue_reported_at = new Date().toISOString();
        updateData.issue_reported_by = userData?.id;
        if (notes) updateData.issue_description = notes;
      }

      const { data, error } = await supabase
        .from("sample_transits")
        .update(updateData)
        .eq("id", transitId)
        .select()
        .single();

      return { data, error };
    },

    // Receive samples at destination
    receive: async (transitId: string, params?: {
      receipt_notes?: string;
      temperature_at_receipt?: number;
      condition_at_receipt?: "good" | "acceptable" | "damaged" | "rejected";
    }) => {
      const { data: { user } } = await supabase.auth.getUser();
      const { data: userData } = await supabase
        .from("users")
        .select("id")
        .eq("email", user?.email)
        .single();

      const { data, error } = await supabase
        .from("sample_transits")
        .update({
          status: "received",
          received_at: new Date().toISOString(),
          received_by: userData?.id,
          receipt_notes: params?.receipt_notes,
          temperature_at_receipt: params?.temperature_at_receipt,
          condition_at_receipt: params?.condition_at_receipt,
        })
        .eq("id", transitId)
        .select(`
          *,
          orders(id)
        `)
        .single();

      // Update order transit_status to received_at_lab AND set sample_received_at
      if (!error && data?.order_id) {
        await supabase
          .from("orders")
          .update({
            transit_status: "received_at_lab",
            sample_received_at: new Date().toISOString(),
          })
          .eq("id", data.order_id);
      }

      return { data, error };
    },

    // Bulk receive multiple transits
    bulkReceive: async (transitIds: string[], params?: {
      receipt_notes?: string;
      condition_at_receipt?: "good" | "acceptable" | "damaged" | "rejected";
    }) => {
      const { data: { user } } = await supabase.auth.getUser();
      const { data: userData } = await supabase
        .from("users")
        .select("id")
        .eq("email", user?.email)
        .single();

      const now = new Date().toISOString();

      const { data, error } = await supabase
        .from("sample_transits")
        .update({
          status: "received",
          received_at: now,
          received_by: userData?.id,
          receipt_notes: params?.receipt_notes,
          condition_at_receipt: params?.condition_at_receipt,
        })
        .in("id", transitIds)
        .select("order_id");

      // Update all related orders
      if (!error && data) {
        const orderIds = data.map((t) => t.order_id).filter(Boolean);
        if (orderIds.length > 0) {
          await supabase
            .from("orders")
            .update({
              transit_status: "received_at_lab",
              sample_received_at: now,
            })
            .in("id", orderIds);
        }
      }

      return { data, error };
    },

    // Get transit statistics for a location
    getStats: async (locationId?: string) => {
      const labId = await database.getCurrentUserLabId();
      if (!labId) {
        return {
          data: null,
          error: new Error("No lab_id found for current user"),
        };
      }

      // Get counts by status
      let pendingQuery = supabase
        .from("sample_transits")
        .select("id", { count: "exact", head: true })
        .eq("lab_id", labId)
        .eq("status", "pending_dispatch");

      let inTransitQuery = supabase
        .from("sample_transits")
        .select("id", { count: "exact", head: true })
        .eq("lab_id", labId)
        .eq("status", "in_transit");

      let receivedTodayQuery = supabase
        .from("sample_transits")
        .select("id", { count: "exact", head: true })
        .eq("lab_id", labId)
        .eq("status", "received")
        .gte("received_at", new Date().toISOString().split("T")[0]);

      if (locationId) {
        pendingQuery = pendingQuery.eq("from_location_id", locationId);
        inTransitQuery = inTransitQuery.or(
          `from_location_id.eq.${locationId},to_location_id.eq.${locationId}`,
        );
        receivedTodayQuery = receivedTodayQuery.eq(
          "to_location_id",
          locationId,
        );
      }

      const [pending, inTransit, receivedToday] = await Promise.all([
        pendingQuery,
        inTransitQuery,
        receivedTodayQuery,
      ]);

      return {
        data: {
          pendingDispatch: pending.count || 0,
          inTransit: inTransit.count || 0,
          receivedToday: receivedToday.count || 0,
        },
        error: null,
      };
    },

    // Generate tracking barcode for a transit
    generateTrackingBarcode: async (transitId: string) => {
      const barcode = `TRN-${Date.now()}-${transitId.slice(0, 8)}`;

      const { data, error } = await supabase
        .from("sample_transits")
        .update({ tracking_barcode: barcode })
        .eq("id", transitId)
        .select()
        .single();

      return { data: { barcode, ...data }, error };
    },
  },
};

// Merge master data APIs into main database object

Object.assign(database, masterDataAPI, brandingSignatureAPI);

// Workflow management helpers
export const workflowVersions = {
  getAll: async () => {
    const { data, error } = await supabase
      .from("workflow_versions")
      .select(`
        *,
        workflows(name, description, type, category, lab_id, is_active)
      `)
      .order("created_at", { ascending: false });
    return { data, error };
  },

  getById: async (id: string) => {
    const { data, error } = await supabase
      .from("workflow_versions")
      .select(`
        *,
        workflows(name, description, type, category, lab_id, is_active)
      `)
      .eq("id", id)
      .single();
    return { data, error };
  },

  getByWorkflowId: async (workflowId: string) => {
    const { data, error } = await supabase
      .from("workflow_versions")
      .select("*")
      .eq("workflow_id", workflowId)
      .order("version", { ascending: false });
    return { data, error };
  },

  create: async (versionData: {
    workflow_id: string;
    version: string;
    definition: any;
    description?: string;
    active?: boolean;
  }) => {
    const { data, error } = await supabase
      .from("workflow_versions")
      .insert([versionData])
      .select()
      .single();
    return { data, error };
  },

  update: async (id: string, updates: {
    definition?: any;
    description?: string;
    active?: boolean;
  }) => {
    const { data, error } = await supabase
      .from("workflow_versions")
      .update(updates)
      .eq("id", id)
      .select()
      .single();
    return { data, error };
  },

  delete: async (id: string) => {
    const { error } = await supabase
      .from("workflow_versions")
      .delete()
      .eq("id", id);
    return { error };
  },
};

export const workflows = {
  getAll: async () => {
    const { data, error } = await supabase
      .from("workflows")
      .select("*")
      .order("created_at", { ascending: false });
    return { data, error };
  },

  getById: async (id: string) => {
    const { data, error } = await supabase
      .from("workflows")
      .select("*")
      .eq("id", id)
      .single();
    return { data, error };
  },

  create: async (workflowData: {
    name: string;
    description?: string;
    type: string;
    category?: string;
    lab_id: string;
    is_active?: boolean;
  }) => {
    const { data, error } = await supabase
      .from("workflows")
      .insert([workflowData])
      .select()
      .single();
    return { data, error };
  },

  update: async (id: string, updates: {
    name?: string;
    description?: string;
    type?: string;
    category?: string;
    is_active?: boolean;
  }) => {
    const { data, error } = await supabase
      .from("workflows")
      .update(updates)
      .eq("id", id)
      .select()
      .single();
    return { data, error };
  },

  delete: async (id: string) => {
    const { error } = await supabase
      .from("workflows")
      .delete()
      .eq("id", id);
    return { error };
  },
};

export const aiProtocols = {
  getAll: async () => {
    const { data, error } = await supabase
      .from("ai_protocols")
      .select("*")
      .order("created_at", { ascending: false });
    return { data, error };
  },

  getById: async (id: string) => {
    const { data, error } = await supabase
      .from("ai_protocols")
      .select("*")
      .eq("id", id)
      .single();
    return { data, error };
  },

  create: async (protocolData: {
    name: string;
    description?: string;
    config: any;
    status?: string;
    lab_id: string;
  }) => {
    const { data, error } = await supabase
      .from("ai_protocols")
      .insert([protocolData])
      .select()
      .single();
    return { data, error };
  },

  update: async (id: string, updates: {
    name?: string;
    description?: string;
    config?: any;
    status?: string;
  }) => {
    const { data, error } = await supabase
      .from("ai_protocols")
      .update(updates)
      .eq("id", id)
      .select()
      .single();
    return { data, error };
  },

  delete: async (id: string) => {
    const { error } = await supabase
      .from("ai_protocols")
      .delete()
      .eq("id", id);
    return { error };
  },
};

export const testWorkflowMap = {
  getAll: async (labIdOverride?: string) => {
    const labId = labIdOverride || await database.getCurrentUserLabId();
    if (!labId) {
      return { data: [], error: new Error("No lab_id found for current user") };
    }

    const { data, error } = await supabase
      .from("test_workflow_map")
      .select(`
        id,
        workflow_version_id,
        test_group_id,
        analyte_id,
        is_default,
        is_active,
        priority,
        created_at,
        workflow_versions!inner(id, name),
        test_groups!inner(id, name, lab_id),
        analytes(id, name)
      `)
      .eq("test_groups.lab_id", labId)
      .order("priority", { ascending: true });
    return { data, error };
  },

  getByTestGroupId: async (testGroupId: string, labIdOverride?: string) => {
    const labId = labIdOverride || await database.getCurrentUserLabId();
    if (!labId) {
      return { data: [], error: new Error("No lab_id found for current user") };
    }

    const { data, error } = await supabase
      .from("test_workflow_map")
      .select(`
        id,
        workflow_version_id,
        test_group_id,
        analyte_id,
        is_default,
        is_active,
        priority,
        workflow_versions(id, name, definition, active),
        test_groups!inner(id, name, lab_id),
        analytes(id, name)
      `)
      .eq("test_groups.lab_id", labId)
      .eq("test_group_id", testGroupId)
      .eq("is_active", true)
      .order("priority", { ascending: true });
    return { data, error };
  },

  create: async (mappingData: {
    test_group_id?: string;
    analyte_id?: string;
    workflow_version_id: string;
    test_code: string;
    is_active?: boolean;
    is_default?: boolean;
    priority?: number;
    lab_id?: string;
  }) => {
    const labId = mappingData.lab_id || await database.getCurrentUserLabId();
    if (!labId) {
      return {
        data: null,
        error: new Error("No lab_id found for current user"),
      };
    }

    if (!mappingData.test_code) {
      return { data: null, error: new Error("test_code is required") };
    }

    const payload = {
      ...mappingData,
      lab_id: labId,
      is_active: mappingData.is_active ?? true,
      is_default: mappingData.is_default ?? false,
      priority: mappingData.priority ?? 1,
    };

    const { data, error } = await supabase
      .from("test_workflow_map")
      .insert([payload])
      .select()
      .single();
    return { data, error };
  },

  update: async (id: string, updates: {
    workflow_version_id?: string;
    is_active?: boolean;
    is_default?: boolean;
    priority?: number;
  }, labIdOverride?: string) => {
    const labId = labIdOverride || await database.getCurrentUserLabId();
    if (!labId) {
      return {
        data: null,
        error: new Error("No lab_id found for current user"),
      };
    }

    const { data, error } = await supabase
      .from("test_workflow_map")
      .update(updates)
      .eq("id", id)
      .eq("lab_id", labId)
      .select()
      .single();
    return { data, error };
  },

  delete: async (id: string, labIdOverride?: string) => {
    const labId = labIdOverride || await database.getCurrentUserLabId();
    if (!labId) {
      return { error: new Error("No lab_id found for current user") };
    }

    const { error } = await supabase
      .from("test_workflow_map")
      .delete()
      .eq("id", id)
      .eq("lab_id", labId);
    return { error };
  },
};

const workflowAI = {
  async queueProcessing(payload: {
    workflow_instance_id: string;
    order_id: string;
    test_group_id?: string | null;
    lab_id?: string | null;
    workflow_data?: Record<string, unknown>;
    image_attachments?: unknown[];
    reference_images?: unknown[];
  }) {
    const insertPayload = {
      workflow_instance_id: payload.workflow_instance_id,
      order_id: payload.order_id,
      test_group_id: payload.test_group_id ?? null,
      lab_id: payload.lab_id ?? null,
      workflow_data: payload.workflow_data ?? {},
      image_attachments: payload.image_attachments ?? [],
      reference_images: payload.reference_images ?? [],
      processing_status: "pending" as const,
    };

    const { data, error } = await supabase
      .from("workflow_ai_processing")
      .upsert(insertPayload, { onConflict: "workflow_instance_id" })
      .select()
      .single();

    return { data, error };
  },

  async getByOrder(orderId: string) {
    const { data, error } = await supabase
      .from("workflow_ai_processing")
      .select(`
        *,
        order_workflow_instances (
          id,
          workflow_name,
          completed_at,
          step_name
        ),
        test_groups (id, name)
      `)
      .eq("order_id", orderId)
      .order("created_at", { ascending: false });

    return { data, error };
  },

  async markStatus(
    id: string,
    status: "pending" | "processing" | "completed" | "failed",
    patch: Record<string, unknown> = {},
  ) {
    const timestamps: Record<string, string> = {};

    if (status === "processing") {
      timestamps.processing_started_at = new Date().toISOString();
    }

    if (status === "completed") {
      timestamps.processing_completed_at = new Date().toISOString();
    }

    const { data, error } = await supabase
      .from("workflow_ai_processing")
      .update({
        processing_status: status,
        updated_at: new Date().toISOString(),
        ...timestamps,
        ...patch,
      })
      .eq("id", id)
      .select()
      .single();

    return { data, error };
  },
};

// Add AI Analysis & Trends namespace
export const aiAnalysis = {
  /**
   * Save trend graph data for an order
   */
  saveTrendData: async (orderId: string, trendData: any, userId?: string) => {
    try {
      if (!userId) {
        const { data: { user } } = await supabase.auth.getUser();
        if (user?.email) {
          const { data: userData } = await supabase
            .from("users")
            .select("id")
            .eq("email", user.email)
            .eq("status", "Active")
            .single();
          userId = userData?.id;
        }
      }

      const { data, error } = await supabase.rpc("save_trend_graph_data", {
        p_order_id: orderId,
        p_trend_data: trendData,
        p_user_id: userId,
      });

      if (error) throw error;
      return { data, error: null };
    } catch (error) {
      console.error("Failed to save trend data:", error);
      return { data: null, error };
    }
  },

  /**
   * Save AI-generated doctor summary to report
   */
  saveDoctorSummary: async (
    orderId: string,
    summary: string,
    userId?: string,
  ) => {
    try {
      if (!userId) {
        const { data: { user } } = await supabase.auth.getUser();
        if (user?.email) {
          const { data: userData } = await supabase
            .from("users")
            .select("id")
            .eq("email", user.email)
            .eq("status", "Active")
            .single();
          userId = userData?.id;
        }
      }

      const { data, error } = await supabase.rpc("generate_ai_doctor_summary", {
        p_order_id: orderId,
        p_summary_text: summary,
        p_user_id: userId,
      });

      if (error) throw error;
      return { data, error: null };
    } catch (error) {
      console.error("Failed to save AI summary:", error);
      return { data: null, error };
    }
  },

  /**
   * Apply AI suggestions to result value (flag + interpretation)
   */
  applyAISuggestions: async (
    resultValueId: string,
    options?: {
      applyFlag?: boolean;
      applyInterpretation?: boolean;
      customFlag?: string;
      customInterpretation?: string;
    },
  ) => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      let userId = null;
      if (user?.email) {
        const { data: userData } = await supabase
          .from("users")
          .select("id")
          .eq("email", user.email)
          .eq("status", "Active")
          .single();
        userId = userData?.id;
      }

      const { data, error } = await supabase.rpc(
        "apply_ai_suggestions_to_result_value",
        {
          p_result_value_id: resultValueId,
          p_user_id: userId,
          p_apply_flag: options?.applyFlag ?? true,
          p_apply_interpretation: options?.applyInterpretation ?? true,
          p_custom_flag: options?.customFlag ?? null,
          p_custom_interpretation: options?.customInterpretation ?? null,
        },
      );

      if (error) throw error;
      return { data, error: null };
    } catch (error) {
      console.error("Failed to apply AI suggestions:", error);
      return { data: null, error };
    }
  },

  /**
   * Get trend data for an order
   */
  getTrendData: async (orderId: string) => {
    try {
      const { data, error } = await supabase
        .from("orders")
        .select(
          "trend_graph_data, trend_graph_generated_at, trend_graph_generated_by",
        )
        .eq("id", orderId)
        .maybeSingle();

      if (error) throw error;
      // Return null data if order not found (graceful handling)
      return { data: data || null, error: null };
    } catch (error) {
      console.error("Failed to get trend data:", error);
      return { data: null, error };
    }
  },

  /**
   * Update include_in_report flag for trend data and generate/upload images if included
   */
	  updateTrendIncludeInReport: async (
	    orderId: string,
	    includeInReport: boolean,
	    selectedAnalyteKeys?: string[],
	  ) => {
    try {
      // First get the existing trend data
      const { data: orderData, error: fetchError } = await supabase
        .from("orders")
        .select("trend_graph_data")
        .eq("id", orderId)
        .single();

      if (fetchError) throw fetchError;

      const existingData = orderData?.trend_graph_data || {};
	      const normalizedSelectedKeys = (selectedAnalyteKeys || existingData.selected_analyte_keys || [])
	        .map((key: string) => key?.toString().trim().toLowerCase())
	        .filter(Boolean);
	      const shouldIncludeAnalyte = (analyte: any) => {
	        if (normalizedSelectedKeys.length === 0) return true;
	        const key = (analyte.analyte_id || analyte.analyte_name || "").toString().trim().toLowerCase();
	        return normalizedSelectedKeys.includes(key);
	      };
	      const baseAnalytes = Array.isArray(existingData.analytes)
	        ? existingData.analytes.map((analyte: any) => ({
	          ...analyte,
	          selected_for_report: shouldIncludeAnalyte(analyte),
	        }))
	        : existingData.analytes;
	      let updatedData = {
	        ...existingData,
	        analytes: baseAnalytes,
	        selected_analyte_keys: normalizedSelectedKeys,
	        include_in_report: includeInReport,
	        include_in_report_updated_at: new Date().toISOString(),
	      };

      // If including in report and we have analytes, generate and upload images
      if (
        includeInReport && existingData.analytes &&
        existingData.analytes.length > 0
      ) {
        console.log(
          `📸 Generating trend graph images for ${existingData.analytes.length} analytes...`,
        );

        // Dynamically import trendChartGenerator to avoid circular dependency
        const { generateTrendSVG, svgToPngBlob, uploadChartImage } =
          await import("./trendChartGenerator");

	        const analytesWithImages = await Promise.all(
	          baseAnalytes.map(async (analyte: any) => {
	            if (!shouldIncludeAnalyte(analyte)) {
	              return {
	                ...analyte,
	                selected_for_report: false,
	              };
	            }
	            try {
              // Convert stored data format to TrendDataPoint format for SVG generation
              const trendDataPoints = analyte.dataPoints?.map((dp: any) => ({
                order_date: dp.date || dp.timestamp,
                value: dp.value,
                unit: analyte.unit,
                reference_range: `${analyte.reference_range?.min || 0}-${
                  analyte.reference_range?.max || 100
                }`,
                flag: dp.flag || null,
              })) || [];

              if (trendDataPoints.length < 2) {
                console.log(
                  `⏭️ Skipping ${analyte.analyte_name}: insufficient data points`,
                );
                return analyte;
              }

              // Generate SVG
              const svg = generateTrendSVG(trendDataPoints, {
                width: 500,
                height: 250,
                backgroundColor: "white",
                showReferenceRange: true,
              });

              // Convert to PNG
              const pngBlob = await svgToPngBlob(svg, 500, 250);

              if (pngBlob) {
                // Upload to storage
                const imageUrl = await uploadChartImage(
                  pngBlob,
                  orderId,
                  analyte.analyte_name,
                );

                if (imageUrl) {
                  console.log(
                    `✅ Uploaded trend image for ${analyte.analyte_name}`,
                  );
	                  return {
	                    ...analyte,
	                    selected_for_report: true,
	                    image_url: imageUrl,
	                    image_generated_at: new Date().toISOString(),
	                  };
                }
              }

              return analyte;
            } catch (err) {
              console.error(
                `Failed to generate image for ${analyte.analyte_name}:`,
                err,
              );
              return analyte;
            }
          }),
        );

        updatedData = {
          ...updatedData,
          analytes: analytesWithImages,
          images_generated_at: new Date().toISOString(),
        };

        console.log(
          `📊 Generated images for ${
            analytesWithImages.filter((a: any) => a.image_url).length
          }/${analytesWithImages.length} analytes`,
        );
      }

      const { data, error } = await supabase
        .from("orders")
        .update({ trend_graph_data: updatedData })
        .eq("id", orderId)
        .select();

      if (error) throw error;
      return { data, error: null };
    } catch (error) {
      console.error("Failed to update trend include in report:", error);
      return { data: null, error };
    }
  },
};

// WhatsApp Templates API
const whatsappTemplates = {
  list: async (labIdOverride?: string, category?: string) => {
    const labId = labIdOverride || await database.getCurrentUserLabId();
    if (!labId) {
      return { data: [], error: new Error("No lab_id found for current user") };
    }

    let query = supabase
      .from("whatsapp_message_templates")
      .select("*")
      .eq("lab_id", labId)
      .order("category", { ascending: true })
      .order("name", { ascending: true });

    if (category) {
      query = query.eq("category", category);
    }

    const { data, error } = await query;
    return { data: data || [], error };
  },

  get: async (id: string) => {
    const { data, error } = await supabase
      .from("whatsapp_message_templates")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    return { data, error };
  },

  getDefault: async (category: string, labIdOverride?: string) => {
    const labId = labIdOverride || await database.getCurrentUserLabId();
    if (!labId) {
      return {
        data: null,
        error: new Error("No lab_id found for current user"),
      };
    }

    const { data, error } = await supabase
      .from("whatsapp_message_templates")
      .select("*")
      .eq("lab_id", labId)
      .eq("category", category)
      .eq("is_default", true)
      .eq("is_active", true)
      .maybeSingle();

    return { data, error };
  },

  create: async (templateData: {
    name: string;
    category: string;
    message_content: string;
    requires_attachment?: boolean;
    placeholders?: string[];
    is_active?: boolean;
    is_default?: boolean;
  }) => {
    const labId = await database.getCurrentUserLabId();
    if (!labId) {
      return {
        data: null,
        error: new Error("No lab_id found for current user"),
      };
    }

    const { data: { user } } = await supabase.auth.getUser();
    const userId = user?.id;

    const { data, error } = await supabase
      .from("whatsapp_message_templates")
      .insert({
        ...templateData,
        lab_id: labId,
        created_by: userId,
      })
      .select()
      .single();

    return { data, error };
  },

  update: async (
    id: string,
    templateData: Partial<{
      name: string;
      category: string;
      message_content: string;
      requires_attachment: boolean;
      placeholders: string[];
      is_active: boolean;
      is_default: boolean;
    }>,
  ) => {
    const { data, error } = await supabase
      .from("whatsapp_message_templates")
      .update(templateData)
      .eq("id", id)
      .select()
      .single();

    return { data, error };
  },

  delete: async (id: string) => {
    const { error } = await supabase
      .from("whatsapp_message_templates")
      .delete()
      .eq("id", id);

    return { error };
  },

  // Seed default templates for a lab
  seedDefaults: async (labIdOverride?: string) => {
    const labId = labIdOverride || await database.getCurrentUserLabId();
    if (!labId) {
      return { error: new Error("No lab_id found for current user") };
    }

    const { data: { user } } = await supabase.auth.getUser();
    const userId = user?.id;

    // Check existing categories so new default categories can be added later
    const { data: existing } = await supabase
      .from("whatsapp_message_templates")
      .select("category")
      .eq("lab_id", labId);

    const existingCategories = new Set(
      (existing || []).map((template: any) => template.category),
    );

    // Import default templates
    const { DEFAULT_TEMPLATES, extractPlaceholders } = await import(
      "./whatsappTemplates"
    );

    const templates = [
      {
        name: DEFAULT_TEMPLATES.report_ready.name,
        category: "report_ready",
        message_content: DEFAULT_TEMPLATES.report_ready.message,
        requires_attachment: DEFAULT_TEMPLATES.report_ready.requires_attachment,
        placeholders: extractPlaceholders(
          DEFAULT_TEMPLATES.report_ready.message,
        ),
        is_default: true,
        is_active: true,
      },
      {
        name: DEFAULT_TEMPLATES.appointment_reminder.name,
        category: "appointment_reminder",
        message_content: DEFAULT_TEMPLATES.appointment_reminder.message,
        requires_attachment:
          DEFAULT_TEMPLATES.appointment_reminder.requires_attachment,
        placeholders: extractPlaceholders(
          DEFAULT_TEMPLATES.appointment_reminder.message,
        ),
        is_default: true,
        is_active: true,
      },
      {
        name: DEFAULT_TEMPLATES.test_results.name,
        category: "test_results",
        message_content: DEFAULT_TEMPLATES.test_results.message,
        requires_attachment: DEFAULT_TEMPLATES.test_results.requires_attachment,
        placeholders: extractPlaceholders(
          DEFAULT_TEMPLATES.test_results.message,
        ),
        is_default: true,
        is_active: true,
      },
      {
        name: DEFAULT_TEMPLATES.doctor_notification.name,
        category: "doctor_notification",
        message_content: DEFAULT_TEMPLATES.doctor_notification.message,
        requires_attachment:
          DEFAULT_TEMPLATES.doctor_notification.requires_attachment,
        placeholders: extractPlaceholders(
          DEFAULT_TEMPLATES.doctor_notification.message,
        ),
        is_default: true,
        is_active: true,
      },
      {
        name: DEFAULT_TEMPLATES.payment_reminder.name,
        category: "payment_reminder",
        message_content: DEFAULT_TEMPLATES.payment_reminder.message,
        requires_attachment:
          DEFAULT_TEMPLATES.payment_reminder.requires_attachment,
        placeholders: extractPlaceholders(
          DEFAULT_TEMPLATES.payment_reminder.message,
        ),
        is_default: true,
        is_active: true,
      },
      {
        name: DEFAULT_TEMPLATES.registration_confirmation.name,
        category: "registration_confirmation",
        message_content: DEFAULT_TEMPLATES.registration_confirmation.message,
        requires_attachment:
          DEFAULT_TEMPLATES.registration_confirmation.requires_attachment,
        placeholders: extractPlaceholders(
          DEFAULT_TEMPLATES.registration_confirmation.message,
        ),
        is_default: true,
        is_active: true,
      },
      {
        name: DEFAULT_TEMPLATES.doctor_registration_confirmation.name,
        category: "doctor_registration_confirmation",
        message_content:
          DEFAULT_TEMPLATES.doctor_registration_confirmation.message,
        requires_attachment:
          DEFAULT_TEMPLATES.doctor_registration_confirmation.requires_attachment,
        placeholders: extractPlaceholders(
          DEFAULT_TEMPLATES.doctor_registration_confirmation.message,
        ),
        is_default: true,
        is_active: true,
      },
      {
        name: DEFAULT_TEMPLATES.doctor_report_ready.name,
        category: "doctor_report_ready",
        message_content: DEFAULT_TEMPLATES.doctor_report_ready.message,
        requires_attachment:
          DEFAULT_TEMPLATES.doctor_report_ready.requires_attachment,
        placeholders: extractPlaceholders(
          DEFAULT_TEMPLATES.doctor_report_ready.message,
        ),
        is_default: true,
        is_active: true,
      },
      {
        name: DEFAULT_TEMPLATES.invoice_generated.name,
        category: "invoice_generated",
        message_content: DEFAULT_TEMPLATES.invoice_generated.message,
        requires_attachment:
          DEFAULT_TEMPLATES.invoice_generated.requires_attachment,
        placeholders: extractPlaceholders(
          DEFAULT_TEMPLATES.invoice_generated.message,
        ),
        is_default: true,
        is_active: true,
      },
      {
        name: DEFAULT_TEMPLATES.loyalty_points_earned.name,
        category: "loyalty_points_earned",
        message_content: DEFAULT_TEMPLATES.loyalty_points_earned.message,
        requires_attachment:
          DEFAULT_TEMPLATES.loyalty_points_earned.requires_attachment,
        placeholders: extractPlaceholders(
          DEFAULT_TEMPLATES.loyalty_points_earned.message,
        ),
        is_default: true,
        is_active: true,
      },
      {
        name: DEFAULT_TEMPLATES.loyalty_points_redeemed.name,
        category: "loyalty_points_redeemed",
        message_content: DEFAULT_TEMPLATES.loyalty_points_redeemed.message,
        requires_attachment:
          DEFAULT_TEMPLATES.loyalty_points_redeemed.requires_attachment,
        placeholders: extractPlaceholders(
          DEFAULT_TEMPLATES.loyalty_points_redeemed.message,
        ),
        is_default: true,
        is_active: true,
      },
    ];

    const templatesToInsert = templates.filter((template) =>
      !existingCategories.has(template.category)
    );

    if (templatesToInsert.length === 0) {
      return { error: null };
    }

    const { error } = await supabase
      .from("whatsapp_message_templates")
      .insert(templatesToInsert.map((t) => ({
        ...t,
        lab_id: labId,
        created_by: userId,
      })));

    return { error };
  },
};

// PDF Generation Queue namespace
const pdfQueue = {
  getNextJob: async (workerId: string) => {
    const { data, error } = await supabase.rpc("get_next_pdf_job", {
      worker_id: workerId,
    });

    return { data: data?.[0] || null, error };
  },

  markComplete: async (jobId: string, pdfUrl: string) => {
    const { error } = await supabase.rpc("complete_pdf_job", {
      job_id: jobId,
      pdf_url: pdfUrl,
    });

    return { error };
  },

  markFailed: async (jobId: string, errorMessage: string) => {
    const { error } = await supabase.rpc("fail_pdf_job", {
      job_id: jobId,
      error_msg: errorMessage,
    });

    return { error };
  },

  updateProgress: async (jobId: string, stage: string, percent: number) => {
    const { error } = await supabase.rpc("update_pdf_job_progress", {
      job_id: jobId,
      stage,
      percent,
    });

    return { error };
  },

  retryJob: async (jobId: string) => {
    const { error } = await supabase.rpc("retry_pdf_job", {
      job_id: jobId,
    });

    return { error };
  },

  getQueueStatus: async (labIdOverride?: string) => {
    const labId = labIdOverride || await database.getCurrentUserLabId();
    if (!labId) {
      return {
        data: null,
        error: new Error("No lab_id found for current user"),
      };
    }

    const { data, error } = await supabase
      .from("pdf_generation_queue")
      .select(`
        id,
        order_id,
        status,
        priority,
        created_at,
        started_at,
        completed_at,
        progress_stage,
        progress_percent,
        error_message,
        retry_count,
        max_retries,
        processing_by
      `)
      .eq("lab_id", labId)
      .order("created_at", { ascending: false })
      .limit(100);

    return { data, error };
  },

  getJobForOrder: async (orderId: string) => {
    const { data, error } = await supabase
      .from("pdf_generation_queue")
      .select("*")
      .eq("order_id", orderId)
      .maybeSingle();

    return { data, error };
  },

  getStatistics: async (labIdOverride?: string) => {
    const labId = labIdOverride || await database.getCurrentUserLabId();
    if (!labId) {
      return {
        data: null,
        error: new Error("No lab_id found for current user"),
      };
    }

    const { data, error } = await supabase
      .from("pdf_generation_queue")
      .select("status")
      .eq("lab_id", labId);

    if (error) return { data: null, error };

    const stats = {
      pending: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      total: data?.length || 0,
    };

    data?.forEach((job) => {
      if (job.status in stats) {
        stats[job.status as keyof typeof stats]++;
      }
    });

    return { data: stats, error: null };
  },

  // Trigger on-demand PDF generation via edge function (fully server-side)
  triggerGeneration: async (
    orderId: string,
    onProgress?: (stage: string, percent: number) => void,
  ) => {
    try {
      console.log(
        "🚀 Triggering server-side PDF generation for order:",
        orderId,
      );
      onProgress?.("Starting server-side PDF generation...", 5);

      // Get current user ID for WhatsApp integration
      const { data: { user } } = await supabase.auth.getUser();
      const triggeredByUserId = user?.id;

      // Call edge function - it handles everything server-side:
      // Context fetch → Template rendering → PDF.co generation → Storage upload
      const { data, error } = await supabase.functions.invoke(
        "generate-pdf-letterhead",
        {
          body: { orderId, triggeredByUserId },
        },
      );

      if (error) {
        console.error("❌ Edge function failed:", error);
        return { data: null, error };
      }

      // Check for error response from edge function
      if (data?.error) {
        console.error("❌ PDF generation failed:", data.error, data.details);
        return {
          data: null,
          error: new Error(
            data.error + (data.details ? `: ${data.details}` : ""),
          ),
        };
      }

      // Handle already completed case
      if (data?.status === "completed" && data?.pdfUrl) {
        console.log("✅ PDF already exists:", data.pdfUrl);
        onProgress?.("PDF already generated", 100);
        return { data: { success: true, pdfUrl: data.pdfUrl }, error: null };
      }

      // Check for successful completion
      if (data?.status === "processing") {
        console.log("â³ PDF generation already in progress:", data?.jobId);
        onProgress?.("PDF generation already in progress", 35);
        return {
          data: {
            success: true,
            status: "processing",
            jobId: data?.jobId || null,
            message: data?.message || "Already processing",
          },
          error: null,
        };
      }

      if (!data?.success || !data?.pdfUrl) {
        console.error("❌ Edge function returned unexpected response:", data);
        return {
          data: null,
          error: new Error(
            data?.message || "PDF generation failed - no URL returned",
          ),
        };
      }

      // Update order status
      await supabase
        .from("orders")
        .update({
          report_generation_status: "completed",
          report_auto_generated_at: new Date().toISOString(),
        })
        .eq("id", orderId);

      onProgress?.("Complete!", 100);
      console.log("✅ PDF generation complete:", data.pdfUrl);

      return {
        data: {
          success: true,
          pdfUrl: data.pdfUrl,
          storagePath: data.storagePath,
          jobId: data.jobId,
        },
        error: null,
      };
    } catch (error) {
      console.error("❌ PDF generation error:", error);

      // Mark job as failed
      await supabase
        .from("pdf_generation_queue")
        .update({
          status: "failed",
          error_message: error instanceof Error ? error.message : String(error),
        })
        .eq("order_id", orderId);

      return {
        data: null,
        error: error instanceof Error
          ? error
          : new Error("Failed to generate PDF"),
      };
    }
  },
};

// Add workflow helpers to database object
Object.assign(database, {
  workflowVersions,
  workflows,
  aiProtocols,
  testWorkflowMap,
  attachmentBatch,
  workflowAI,
  aiAnalysis,
  whatsappTemplates,
  pdfQueue,
});

// ============================================
// FLAG AUDIT & RULES NAMESPACE
// ============================================

const flagAudits = {
  async create(audit: {
    result_value_id?: string;
    result_id?: string;
    analyte_id?: string;
    order_id?: string;
    patient_age?: number;
    patient_gender?: string;
    original_value: string;
    original_unit?: string;
    reference_range_used?: string;
    auto_determined_flag?: string;
    auto_flag_source?: string;
    auto_confidence?: number;
    ai_suggested_flag?: string;
    ai_confidence?: number;
    ai_reasoning?: string;
    priority?: "low" | "normal" | "high" | "critical";
  }) {
    const lab_id = await database.getCurrentUserLabId();
    if (!lab_id) throw new Error("No lab context");

    return supabase
      .from("ai_flag_audits")
      .insert({ ...audit, lab_id })
      .select()
      .single();
  },

  async getPending(limit = 50) {
    const lab_id = await database.getCurrentUserLabId();
    if (!lab_id) throw new Error("No lab context");

    return supabase
      .from("ai_flag_audits")
      .select(`
        *,
        analytes(name, unit),
        orders(order_number, patient:patients(name, age, gender))
      `)
      .eq("lab_id", lab_id)
      .eq("status", "pending")
      .order("priority", { ascending: true })
      .order("created_at", { ascending: true })
      .limit(limit);
  },

  async getByResultValue(resultValueId: string) {
    return supabase
      .from("ai_flag_audits")
      .select("*")
      .eq("result_value_id", resultValueId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
  },

  async resolve(id: string, data: {
    final_flag: string;
    resolution_method:
      | "auto_accepted"
      | "ai_accepted"
      | "manual_override"
      | "ignored";
    resolution_notes?: string;
  }) {
    const { data: { user } } = await supabase.auth.getUser();

    return supabase
      .from("ai_flag_audits")
      .update({
        ...data,
        status: data.resolution_method === "ignored"
          ? "ignored"
          : "manually_resolved",
        resolved_by: user?.id,
        resolved_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .select()
      .single();
  },

  async getStats() {
    const lab_id = await database.getCurrentUserLabId();
    if (!lab_id) throw new Error("No lab context");

    const { data } = await supabase
      .from("ai_flag_audits")
      .select("status, priority")
      .eq("lab_id", lab_id);

    return {
      pending: data?.filter((d) => d.status === "pending").length || 0,
      pendingCritical:
        data?.filter((d) => d.status === "pending" && d.priority === "critical")
          .length || 0,
      resolved: data?.filter((d) => d.status !== "pending").length || 0,
    };
  },
};

const analyteFlagRules = {
  async getForAnalyte(analyteId: string) {
    const lab_id = await database.getCurrentUserLabId();

    return supabase
      .from("analyte_flag_rules")
      .select("*")
      .eq("analyte_id", analyteId)
      .or(`lab_id.eq.${lab_id},lab_id.is.null`)
      .eq("is_active", true)
      .order("rule_priority", { ascending: false });
  },

  async getAll() {
    const lab_id = await database.getCurrentUserLabId();
    if (!lab_id) throw new Error("No lab context");

    return supabase
      .from("analyte_flag_rules")
      .select(`
        *,
        analytes(name, unit, category)
      `)
      .or(`lab_id.eq.${lab_id},lab_id.is.null`)
      .eq("is_active", true)
      .order("rule_priority", { ascending: false });
  },

  async create(rule: {
    analyte_id: string;
    rule_name: string;
    rule_priority?: number;
    age_min?: number;
    age_max?: number;
    gender?: "Male" | "Female";
    ref_low?: number;
    ref_high?: number;
    critical_low?: number;
    critical_high?: number;
    normal_values?: string[];
    abnormal_values?: string[];
  }) {
    const lab_id = await database.getCurrentUserLabId();
    if (!lab_id) throw new Error("No lab context");

    return supabase
      .from("analyte_flag_rules")
      .insert({ ...rule, lab_id })
      .select()
      .single();
  },

  async update(
    id: string,
    updates: Partial<{
      rule_name: string;
      rule_priority: number;
      age_min: number;
      age_max: number;
      gender: string;
      ref_low: number;
      ref_high: number;
      critical_low: number;
      critical_high: number;
      normal_values: string[];
      abnormal_values: string[];
      is_active: boolean;
    }>,
  ) {
    return supabase
      .from("analyte_flag_rules")
      .update(updates)
      .eq("id", id)
      .select()
      .single();
  },

  async delete(id: string) {
    return supabase
      .from("analyte_flag_rules")
      .delete()
      .eq("id", id);
  },
};

// Add flag audit helpers to database object
Object.assign(database, {
  flagAudits,
  analyteFlagRules,
});

/**
 * Invoice Templates Database Functions
 */
export const invoiceTemplates = {
  /**
   * Get all invoice templates for current lab
   */
  async getAll() {
    const lab_id = await database.getCurrentUserLabId();
    if (!lab_id) throw new Error("No lab context");

    return supabase
      .from("invoice_templates")
      .select("*")
      .eq("lab_id", lab_id)
      .eq("is_active", true)
      .order("is_default", { ascending: false })
      .order("created_at", { ascending: false });
  },

  /**
   * Get default invoice template for current lab
   */
  async getDefault(labId?: string) {
    const lab_id = labId || await database.getCurrentUserLabId();
    if (!lab_id) throw new Error("No lab context");

    return supabase
      .from("invoice_templates")
      .select("*")
      .eq("lab_id", lab_id)
      .eq("is_default", true)
      .eq("is_active", true)
      .maybeSingle();
  },

  /**
   * Get invoice template by ID
   */
  async getById(id: string) {
    return supabase
      .from("invoice_templates")
      .select("*")
      .eq("id", id)
      .single();
  },

  /**
   * Create new invoice template
   */
  async create(template: {
    template_name: string;
    template_description?: string;
    category?: string;
    gjs_html?: string;
    gjs_css?: string;
    gjs_components?: any;
    gjs_styles?: any;
    gjs_project?: any;
    is_default?: boolean;
    include_payment_terms?: boolean;
    payment_terms_text?: string;
    include_tax_breakdown?: boolean;
    include_bank_details?: boolean;
    bank_details?: any;
    tax_disclaimer?: string;
  }) {
    const lab_id = await database.getCurrentUserLabId();
    if (!lab_id) throw new Error("No lab context");

    const { data: { user } } = await supabase.auth.getUser();

    return supabase
      .from("invoice_templates")
      .insert({
        ...template,
        lab_id,
        created_by: user?.id,
      })
      .select()
      .single();
  },

  /**
   * Update invoice template
   */
  async update(
    id: string,
    updates: Partial<{
      template_name: string;
      template_description: string;
      category: string;
      gjs_html: string;
      gjs_css: string;
      gjs_components: any;
      gjs_styles: any;
      gjs_project: any;
      is_default: boolean;
      is_active: boolean;
      include_payment_terms: boolean;
      payment_terms_text: string;
      include_tax_breakdown: boolean;
      include_bank_details: boolean;
      bank_details: any;
      tax_disclaimer: string;
    }>,
  ) {
    const { data: { user } } = await supabase.auth.getUser();

    return supabase
      .from("invoice_templates")
      .update({
        ...updates,
        updated_by: user?.id,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .select()
      .single();
  },

  /**
   * Set template as default (unsets other defaults)
   */
  async setDefault(id: string) {
    const lab_id = await database.getCurrentUserLabId();
    if (!lab_id) throw new Error("No lab context");

    // The trigger will handle unsetting other defaults
    return supabase
      .from("invoice_templates")
      .update({ is_default: true })
      .eq("id", id)
      .select()
      .single();
  },

  /**
   * Soft delete invoice template
   */
  async delete(id: string) {
    return supabase
      .from("invoice_templates")
      .update({ is_active: false })
      .eq("id", id);
  },

  /**
   * Hard delete invoice template (admin only)
   */
  async permanentDelete(id: string) {
    return supabase
      .from("invoice_templates")
      .delete()
      .eq("id", id);
  },
};

// Add invoice templates to database object
Object.assign(database, {
  invoiceTemplates,
});

async function syncLabBrandingDefaultsForLab(
  labId: string,
): Promise<{ error: Error | null }> {
  const { data: labRecord, error: labFetchError } = await supabase
    .from("labs")
    .select(
      "id, name, address, city, state, pincode, phone, email, license_number",
    )
    .eq("id", labId)
    .maybeSingle();

  if (labFetchError) {
    return { error: labFetchError };
  }

  if (!labRecord) {
    return {
      error: new Error("Lab not found while syncing branding defaults"),
    };
  }

  const { data: assets, error: assetsError } = await supabase
    .from("lab_branding_assets")
    .select(
      "asset_type, asset_name, description, file_url, imagekit_url, variants",
    )
    .eq("lab_id", labId)
    .eq("is_default", true)
    .in("asset_type", ["header", "footer"]);

  if (assetsError) {
    return { error: assetsError };
  }

  const assetList = Array.isArray(assets)
    ? (assets as BrandingAssetSnippet[])
    : [];
  const headerAsset =
    assetList.find((asset) => asset.asset_type === "header") ?? null;
  const footerAsset =
    assetList.find((asset) => asset.asset_type === "footer") ?? null;

  const headerHtml = composeHeaderHtml(
    labRecord as LabContactRecord,
    headerAsset,
  );
  const footerHtml = composeFooterHtml(
    labRecord as LabContactRecord,
    footerAsset,
  );

  const updateResult = await database.labs.updateBrandingHtmlDefaults(
    {
      headerHtml,
      footerHtml,
    },
    labId,
  );

  return { error: updateResult.error };
}

// ============================================
// NOTIFICATION SETTINGS NAMESPACE
// ============================================

const notificationSettings = {
  /**
   * Get notification settings for a lab
   */
  async get(labIdOverride?: string) {
    const labId = labIdOverride || await database.getCurrentUserLabId();
    if (!labId) {
      return {
        data: null,
        error: new Error("No lab_id found for current user"),
      };
    }

    return supabase
      .from("lab_notification_settings")
      .select("*")
      .eq("lab_id", labId)
      .maybeSingle();
  },

  /**
   * Create or update notification settings
   */
  async upsert(settings: {
    auto_send_report_to_patient?: boolean;
    auto_send_report_to_doctor?: boolean;
    send_report_on_status?: string;
    auto_send_invoice_to_patient?: boolean;
    auto_send_registration_confirmation?: boolean;
    auto_send_registration_to_doctor?: boolean;
    auto_send_loyalty_points?: boolean;
    auto_send_loyalty_redemption?: boolean;
    include_test_details_in_registration?: boolean;
    include_invoice_in_registration?: boolean;
    default_patient_channel?: string;
    send_window_start?: string;
    send_window_end?: string;
    queue_outside_window?: boolean;
    max_messages_per_patient_per_day?: number;
  }, labIdOverride?: string) {
    const labId = labIdOverride || await database.getCurrentUserLabId();
    if (!labId) {
      return {
        data: null,
        error: new Error("No lab_id found for current user"),
      };
    }

    return supabase
      .from("lab_notification_settings")
      .upsert({
        lab_id: labId,
        ...settings,
        updated_at: new Date().toISOString(),
      }, { onConflict: "lab_id" })
      .select()
      .single();
  },
};

const notificationQueue = {
  /**
   * Get pending notifications
   */
  async getPending(limit = 10, labIdOverride?: string) {
    const labId = labIdOverride || await database.getCurrentUserLabId();

    let query = supabase
      .from("notification_queue")
      .select("*")
      .eq("status", "pending")
      .lt("attempts", 3)
      .order("created_at", { ascending: true })
      .limit(limit);

    if (labId) {
      query = query.eq("lab_id", labId);
    }

    return query;
  },

  /**
   * Get notification queue with filters
   */
  async list(filters?: {
    status?: string;
    trigger_type?: string;
    recipient_type?: string;
    limit?: number;
  }, labIdOverride?: string) {
    const labId = labIdOverride || await database.getCurrentUserLabId();
    if (!labId) {
      return { data: [], error: new Error("No lab_id found for current user") };
    }

    let query = supabase
      .from("notification_queue")
      .select("*")
      .eq("lab_id", labId)
      .order("created_at", { ascending: false })
      .limit(filters?.limit || 50);

    if (filters?.status) {
      query = query.eq("status", filters.status);
    }
    if (filters?.trigger_type) {
      query = query.eq("trigger_type", filters.trigger_type);
    }
    if (filters?.recipient_type) {
      query = query.eq("recipient_type", filters.recipient_type);
    }

    return query;
  },

  /**
   * Add notification to queue
   */
  async add(notification: {
    recipient_type: "patient" | "doctor";
    recipient_phone: string;
    recipient_name?: string;
    recipient_id?: string;
    trigger_type:
      | "report_ready"
      | "invoice_generated"
      | "order_registered"
      | "payment_reminder"
      | "loyalty_points_earned"
      | "loyalty_points_redeemed";
    order_id?: string;
    report_id?: string;
    invoice_id?: string;
    template_id?: string;
    message_content?: string;
    attachment_url?: string;
    attachment_type?: string;
    scheduled_for?: string;
  }, labIdOverride?: string) {
    const labId = labIdOverride || await database.getCurrentUserLabId();
    if (!labId) {
      return {
        data: null,
        error: new Error("No lab_id found for current user"),
      };
    }

    return supabase
      .from("notification_queue")
      .insert({
        lab_id: labId,
        ...notification,
        status: "pending",
        scheduled_for: notification.scheduled_for || new Date().toISOString(),
        attempts: 0,
        max_attempts: 3,
      })
      .select()
      .single();
  },

  /**
   * Update notification status
   */
  async updateStatus(id: string, status: string, additionalFields?: {
    sent_at?: string;
    last_error?: string;
    whatsapp_message_id?: string;
    attempts?: number;
  }) {
    return supabase
      .from("notification_queue")
      .update({
        status,
        ...additionalFields,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);
  },

  /**
   * Get queue stats for a lab
   */
  async getStats(labIdOverride?: string) {
    const labId = labIdOverride || await database.getCurrentUserLabId();
    if (!labId) {
      return {
        data: null,
        error: new Error("No lab_id found for current user"),
      };
    }

    const { data, error } = await supabase
      .from("notification_queue")
      .select("status")
      .eq("lab_id", labId);

    if (error) return { data: null, error };

    const stats = {
      pending: 0,
      sent: 0,
      failed: 0,
      total: data?.length || 0,
    };

    data?.forEach((item) => {
      if (
        item.status === "pending" || item.status === "scheduled" ||
        item.status === "sending"
      ) {
        stats.pending++;
      } else if (item.status === "sent") {
        stats.sent++;
      } else if (item.status === "failed") {
        stats.failed++;
      }
    });

    return { data: stats, error: null };
  },
};

// ============================================================================
// PRICING API - Location, Outsourced Lab, and Account Pricing
// ============================================================================

/**
 * Location Test Prices - B2C pricing for franchise locations
 */
const locationTestPrices = {
  /**
   * Get all test prices for a location
   */
  async getByLocation(locationId: string) {
    const { data, error } = await supabase
      .from("location_test_prices")
      .select(`
        *,
        test_group:test_groups(id, name, code, price, category)
      `)
      .eq("location_id", locationId)
      .eq("is_active", true)
      .lte("effective_from", new Date().toISOString().split("T")[0])
      .order("test_group(name)");
    return { data, error };
  },

  /**
   * Get all location prices for current lab (all locations)
   */
  async getAll() {
    const lab_id = await database.getCurrentUserLabId();
    if (!lab_id) {
      return {
        data: null,
        error: new Error("No lab_id found for current user"),
      };
    }

    const { data, error } = await supabase
      .from("location_test_prices")
      .select(`
        *,
        location:locations!inner(id, name, lab_id, collection_percentage, receivable_type),
        test_group:test_groups(id, name, code, price, category)
      `)
      .eq("location.lab_id", lab_id)
      .eq("is_active", true)
      .order("location(name), test_group(name)");
    return { data, error };
  },

  /**
   * Get effective price for a test at a location
   */
  async getPrice(locationId: string, testGroupId: string) {
    const today = new Date().toISOString().split("T")[0];
    const { data, error } = await supabase
      .from("location_test_prices")
      .select("*")
      .eq("location_id", locationId)
      .eq("test_group_id", testGroupId)
      .eq("is_active", true)
      .lte("effective_from", today)
      .order("effective_from", { ascending: false })
      .limit(1)
      .maybeSingle();
    return { data, error };
  },

  /**
   * Upsert test price for location
   */
  async upsert(data: {
    location_id: string;
    test_group_id: string;
    patient_price: number;
    lab_receivable?: number | null;
    effective_from?: string;
    notes?: string;
  }) {
    const { data: { user } } = await supabase.auth.getUser();
    const userId = user?.id;

    // Check if exists
    const { data: existing } = await supabase
      .from("location_test_prices")
      .select("id")
      .eq("location_id", data.location_id)
      .eq("test_group_id", data.test_group_id)
      .eq("is_active", true)
      .maybeSingle();

    if (existing) {
      // Update
      const { data: updated, error } = await supabase
        .from("location_test_prices")
        .update({
          patient_price: data.patient_price,
          lab_receivable: data.lab_receivable,
          effective_from: data.effective_from ||
            new Date().toISOString().split("T")[0],
          notes: data.notes,
          updated_by: userId,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id)
        .select()
        .single();
      return { data: updated, error };
    } else {
      // Insert
      const { data: inserted, error } = await supabase
        .from("location_test_prices")
        .insert({
          ...data,
          effective_from: data.effective_from ||
            new Date().toISOString().split("T")[0],
          created_by: userId,
          is_active: true,
        })
        .select()
        .single();
      return { data: inserted, error };
    }
  },

  /**
   * Bulk upsert prices (for CSV import)
   */
  async bulkUpsert(
    locationId: string,
    prices: Array<{
      test_group_id: string;
      patient_price: number;
      lab_receivable?: number | null;
    }>,
  ) {
    const { data: { user } } = await supabase.auth.getUser();
    const userId = user?.id;
    const today = new Date().toISOString().split("T")[0];

    const results = { success: 0, failed: 0, errors: [] as string[] };

    for (const price of prices) {
      const { error } = await this.upsert({
        location_id: locationId,
        test_group_id: price.test_group_id,
        patient_price: price.patient_price,
        lab_receivable: price.lab_receivable,
        effective_from: today,
      });

      if (error) {
        results.failed++;
        results.errors.push(`${price.test_group_id}: ${error.message}`);
      } else {
        results.success++;
      }
    }

    return results;
  },

  /**
   * Delete (soft) a price entry
   */
  async delete(id: string) {
    const { data, error } = await supabase
      .from("location_test_prices")
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .single();
    return { data, error };
  },

  /**
   * Copy prices from one location to another
   */
  async copyFromLocation(sourceLocationId: string, targetLocationId: string) {
    const { data: sourcePrices, error: fetchError } = await this.getByLocation(
      sourceLocationId,
    );
    if (fetchError || !sourcePrices) {
      return { success: false, error: fetchError };
    }

    const results = await this.bulkUpsert(
      targetLocationId,
      sourcePrices.map((p) => ({
        test_group_id: p.test_group_id,
        patient_price: p.patient_price,
        lab_receivable: p.lab_receivable,
      })),
    );

    return { success: results.failed === 0, ...results };
  },
};

/**
 * Location Package Prices
 */
const locationPackagePrices = {
  async getByLocation(locationId: string) {
    const { data, error } = await supabase
      .from("location_package_prices")
      .select(`
        *,
        package:packages(id, name, price, category)
      `)
      .eq("location_id", locationId)
      .eq("is_active", true)
      .lte("effective_from", new Date().toISOString().split("T")[0])
      .order("package(name)");
    return { data, error };
  },

  async upsert(data: {
    location_id: string;
    package_id: string;
    patient_price: number;
    lab_receivable?: number | null;
    effective_from?: string;
    notes?: string;
  }) {
    const { data: { user } } = await supabase.auth.getUser();
    const userId = user?.id;

    const { data: existing } = await supabase
      .from("location_package_prices")
      .select("id")
      .eq("location_id", data.location_id)
      .eq("package_id", data.package_id)
      .eq("is_active", true)
      .maybeSingle();

    if (existing) {
      const { data: updated, error } = await supabase
        .from("location_package_prices")
        .update({
          patient_price: data.patient_price,
          lab_receivable: data.lab_receivable,
          effective_from: data.effective_from ||
            new Date().toISOString().split("T")[0],
          notes: data.notes,
          updated_by: userId,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id)
        .select()
        .single();
      return { data: updated, error };
    } else {
      const { data: inserted, error } = await supabase
        .from("location_package_prices")
        .insert({
          ...data,
          effective_from: data.effective_from ||
            new Date().toISOString().split("T")[0],
          created_by: userId,
          is_active: true,
        })
        .select()
        .single();
      return { data: inserted, error };
    }
  },

  async delete(id: string) {
    const { data, error } = await supabase
      .from("location_package_prices")
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .single();
    return { data, error };
  },
};

/**
 * Outsourced Lab Prices - Cost tracking for outsourced tests
 */
const outsourcedLabPrices = {
  /**
   * Get all prices for an outsourced lab
   */
  async getByOutsourcedLab(outsourcedLabId: string) {
    const { data, error } = await supabase
      .from("outsourced_lab_prices")
      .select(`
        *,
        test_group:test_groups(id, name, code, price, category)
      `)
      .eq("outsourced_lab_id", outsourcedLabId)
      .eq("is_active", true)
      .lte("effective_from", new Date().toISOString().split("T")[0])
      .order("test_group(name)");
    return { data, error };
  },

  /**
   * Get all outsourced lab prices for current lab
   */
  async getAll() {
    const lab_id = await database.getCurrentUserLabId();
    if (!lab_id) {
      return {
        data: null,
        error: new Error("No lab_id found for current user"),
      };
    }

    const { data, error } = await supabase
      .from("outsourced_lab_prices")
      .select(`
        *,
        outsourced_lab:outsourced_labs(id, name),
        test_group:test_groups(id, name, code, price, category)
      `)
      .eq("lab_id", lab_id)
      .eq("is_active", true)
      .order("outsourced_lab(name), test_group(name)");
    return { data, error };
  },

  /**
   * Get cost for a test at an outsourced lab
   */
  async getCost(outsourcedLabId: string, testGroupId: string) {
    const today = new Date().toISOString().split("T")[0];
    const { data, error } = await supabase
      .from("outsourced_lab_prices")
      .select("*")
      .eq("outsourced_lab_id", outsourcedLabId)
      .eq("test_group_id", testGroupId)
      .eq("is_active", true)
      .lte("effective_from", today)
      .order("effective_from", { ascending: false })
      .limit(1)
      .maybeSingle();
    return { data, error };
  },

  /**
   * Upsert cost for outsourced lab
   */
  async upsert(data: {
    outsourced_lab_id: string;
    test_group_id: string;
    cost: number;
    effective_from?: string;
    notes?: string;
  }) {
    const lab_id = await database.getCurrentUserLabId();
    if (!lab_id) {
      return {
        data: null,
        error: new Error("No lab_id found for current user"),
      };
    }

    const { data: { user } } = await supabase.auth.getUser();
    const userId = user?.id;

    const { data: existing } = await supabase
      .from("outsourced_lab_prices")
      .select("id")
      .eq("outsourced_lab_id", data.outsourced_lab_id)
      .eq("test_group_id", data.test_group_id)
      .eq("is_active", true)
      .maybeSingle();

    if (existing) {
      const { data: updated, error } = await supabase
        .from("outsourced_lab_prices")
        .update({
          cost: data.cost,
          effective_from: data.effective_from ||
            new Date().toISOString().split("T")[0],
          notes: data.notes,
          updated_by: userId,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id)
        .select()
        .single();
      return { data: updated, error };
    } else {
      const { data: inserted, error } = await supabase
        .from("outsourced_lab_prices")
        .insert({
          ...data,
          lab_id,
          effective_from: data.effective_from ||
            new Date().toISOString().split("T")[0],
          created_by: userId,
          is_active: true,
        })
        .select()
        .single();
      return { data: inserted, error };
    }
  },

  /**
   * Bulk upsert prices (for CSV import)
   */
  async bulkUpsert(
    outsourcedLabId: string,
    prices: Array<{
      test_group_id: string;
      cost: number;
    }>,
  ) {
    const results = { success: 0, failed: 0, errors: [] as string[] };

    for (const price of prices) {
      const { error } = await this.upsert({
        outsourced_lab_id: outsourcedLabId,
        test_group_id: price.test_group_id,
        cost: price.cost,
      });

      if (error) {
        results.failed++;
        results.errors.push(`${price.test_group_id}: ${error.message}`);
      } else {
        results.success++;
      }
    }

    return results;
  },

  /**
   * Delete (soft) a price entry
   */
  async delete(id: string) {
    const { data, error } = await supabase
      .from("outsourced_lab_prices")
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .single();
    return { data, error };
  },

  /**
   * Get outsourced costs report (date range)
   */
  async getCostsReport(
    startDate: string,
    endDate: string,
    outsourcedLabId?: string,
  ) {
    const lab_id = await database.getCurrentUserLabId();
    if (!lab_id) {
      return {
        data: null,
        error: new Error("No lab_id found for current user"),
      };
    }

    let query = supabase
      .from("order_tests")
      .select(`
        id,
        test_name,
        price,
        created_at,
        order:orders!inner(
          id,
          patient_name,
          order_date,
          lab_id
        ),
        test_group:test_groups(id, name, code),
        outsourced_lab:outsourced_labs(id, name)
      `)
      .eq("order.lab_id", lab_id)
      .not("outsourced_lab_id", "is", null)
      .gte("created_at", startDate)
      .lte("created_at", endDate);

    if (outsourcedLabId) {
      query = query.eq("outsourced_lab_id", outsourcedLabId);
    }

    const { data: tests, error } = await query.order("created_at", {
      ascending: false,
    });

    if (error) return { data: null, error };

    // Enrich with costs from outsourced_lab_prices
    const enrichedData = await Promise.all(
      (tests || []).map(async (test: any) => {
        if (test.outsourced_lab?.id && test.test_group?.id) {
          const { data: costData } = await this.getCost(
            test.outsourced_lab.id,
            test.test_group.id,
          );
          return {
            ...test,
            outsourced_cost: costData?.cost || 0,
            margin: (test.price || 0) - (costData?.cost || 0),
          };
        }
        return { ...test, outsourced_cost: 0, margin: test.price || 0 };
      }),
    );

    // Calculate summary
    const summary = {
      total_tests: enrichedData.length,
      total_revenue: enrichedData.reduce((sum, t) => sum + (t.price || 0), 0),
      total_cost: enrichedData.reduce(
        (sum, t) => sum + (t.outsourced_cost || 0),
        0,
      ),
      total_margin: enrichedData.reduce((sum, t) => sum + (t.margin || 0), 0),
      by_lab: {} as Record<
        string,
        {
          name: string;
          tests: number;
          revenue: number;
          cost: number;
          margin: number;
        }
      >,
    };

    enrichedData.forEach((t: any) => {
      const labId = t.outsourced_lab?.id || "unknown";
      const labName = t.outsourced_lab?.name || "Unknown";
      if (!summary.by_lab[labId]) {
        summary.by_lab[labId] = {
          name: labName,
          tests: 0,
          revenue: 0,
          cost: 0,
          margin: 0,
        };
      }
      summary.by_lab[labId].tests++;
      summary.by_lab[labId].revenue += t.price || 0;
      summary.by_lab[labId].cost += t.outsourced_cost || 0;
      summary.by_lab[labId].margin += t.margin || 0;
    });

    return { data: { details: enrichedData, summary }, error: null };
  },
};

/**
 * Account Package Prices - B2B package pricing
 */
const accountPackagePrices = {
  /**
   * Get all package prices for an account
   */
  async getByAccount(accountId: string) {
    const { data, error } = await supabase
      .from("account_package_prices")
      .select(`
        *,
        package:packages(id, name, price, category, description)
      `)
      .eq("account_id", accountId)
      .eq("is_active", true)
      .lte("effective_from", new Date().toISOString().split("T")[0])
      .order("package(name)");
    return { data, error };
  },

  /**
   * Get all account package prices for current lab
   */
  async getAll() {
    const lab_id = await database.getCurrentUserLabId();
    if (!lab_id) {
      return {
        data: null,
        error: new Error("No lab_id found for current user"),
      };
    }

    const { data, error } = await supabase
      .from("account_package_prices")
      .select(`
        *,
        account:accounts!inner(id, name, lab_id, type),
        package:packages(id, name, price, category)
      `)
      .eq("account.lab_id", lab_id)
      .eq("is_active", true)
      .order("account(name), package(name)");
    return { data, error };
  },

  /**
   * Get price for a package for an account
   */
  async getPrice(accountId: string, packageId: string) {
    const today = new Date().toISOString().split("T")[0];
    const { data, error } = await supabase
      .from("account_package_prices")
      .select("*")
      .eq("account_id", accountId)
      .eq("package_id", packageId)
      .eq("is_active", true)
      .lte("effective_from", today)
      .order("effective_from", { ascending: false })
      .limit(1)
      .maybeSingle();
    return { data, error };
  },

  /**
   * Upsert package price for account
   */
  async upsert(data: {
    account_id: string;
    package_id: string;
    price: number;
    effective_from?: string;
    notes?: string;
  }) {
    const { data: { user } } = await supabase.auth.getUser();
    const userId = user?.id;

    const { data: existing } = await supabase
      .from("account_package_prices")
      .select("id")
      .eq("account_id", data.account_id)
      .eq("package_id", data.package_id)
      .eq("is_active", true)
      .maybeSingle();

    if (existing) {
      const { data: updated, error } = await supabase
        .from("account_package_prices")
        .update({
          price: data.price,
          effective_from: data.effective_from ||
            new Date().toISOString().split("T")[0],
          notes: data.notes,
          updated_by: userId,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id)
        .select()
        .single();
      return { data: updated, error };
    } else {
      const { data: inserted, error } = await supabase
        .from("account_package_prices")
        .insert({
          ...data,
          effective_from: data.effective_from ||
            new Date().toISOString().split("T")[0],
          created_by: userId,
          is_active: true,
        })
        .select()
        .single();
      return { data: inserted, error };
    }
  },

  /**
   * Bulk upsert prices (for CSV import)
   */
  async bulkUpsert(
    accountId: string,
    prices: Array<{
      package_id: string;
      price: number;
    }>,
  ) {
    const results = { success: 0, failed: 0, errors: [] as string[] };

    for (const price of prices) {
      const { error } = await this.upsert({
        account_id: accountId,
        package_id: price.package_id,
        price: price.price,
      });

      if (error) {
        results.failed++;
        results.errors.push(`${price.package_id}: ${error.message}`);
      } else {
        results.success++;
      }
    }

    return results;
  },

  /**
   * Delete (soft) a price entry
   */
  async delete(id: string) {
    const { data, error } = await supabase
      .from("account_package_prices")
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .single();
    return { data, error };
  },
};

/**
 * Location Receivables Report
 */
const locationReceivables = {
  /**
   * Get receivables report for a date range
   */
  async getReport(startDate: string, endDate: string, locationId?: string) {
    const lab_id = await database.getCurrentUserLabId();
    if (!lab_id) {
      return {
        data: null,
        error: new Error("No lab_id found for current user"),
      };
    }

    // Get orders with location and invoice info
    let query = supabase
      .from("orders")
      .select(`
        id,
        patient_name,
        order_date,
        total_amount,
        collected_at_location_id,
        location:locations!collected_at_location_id(
          id, name, collection_percentage, receivable_type
        ),
        order_tests(
          id,
          test_name,
          price,
          test_group_id
        ),
        invoices(
          id,
          total,
          amount_paid,
          status
        )
      `)
      .eq("lab_id", lab_id)
      .gte("order_date", startDate)
      .lte("order_date", endDate)
      .not("collected_at_location_id", "is", null);

    if (locationId) {
      query = query.eq("collected_at_location_id", locationId);
    }

    const { data: orders, error } = await query.order("order_date", {
      ascending: false,
    });

    if (error) return { data: null, error };

    // Calculate receivables for each order
    const enrichedOrders = await Promise.all(
      (orders || []).map(async (order: any) => {
        const location = order.location;
        let receivable = 0;

        if (location?.receivable_type === "own_center") {
          // Own center: receivable = 100% of collected amount
          receivable = order.total_amount || 0;
        } else if (location?.receivable_type === "test_wise") {
          // Test-wise: lookup each test's receivable
          for (const test of (order.order_tests || [])) {
            const { data: priceData } = await locationTestPrices.getPrice(
              location.id,
              test.test_group_id,
            );
            if (priceData?.lab_receivable) {
              receivable += priceData.lab_receivable;
            } else if (location.collection_percentage) {
              receivable += (test.price || 0) *
                (location.collection_percentage / 100);
            }
          }
        } else {
          // Percentage-based
          receivable = (order.total_amount || 0) *
            ((location?.collection_percentage || 0) / 100);
        }

        return {
          ...order,
          calculated_receivable: Math.round(receivable * 100) / 100,
          collected_amount: order.invoices?.[0]?.amount_paid || 0,
        };
      }),
    );

    // Calculate summary
    const summary = {
      total_orders: enrichedOrders.length,
      total_order_value: enrichedOrders.reduce(
        (sum, o) => sum + (o.total_amount || 0),
        0,
      ),
      total_receivable: enrichedOrders.reduce(
        (sum, o) => sum + (o.calculated_receivable || 0),
        0,
      ),
      total_collected: enrichedOrders.reduce(
        (sum, o) => sum + (o.collected_amount || 0),
        0,
      ),
      by_location: {} as Record<string, {
        name: string;
        orders: number;
        order_value: number;
        receivable: number;
        collected: number;
        receivable_type: string;
      }>,
    };

    enrichedOrders.forEach((o: any) => {
      const locId = o.location?.id || "unknown";
      const locName = o.location?.name || "Unknown";
      const recType = o.location?.receivable_type || "percentage";

      if (!summary.by_location[locId]) {
        summary.by_location[locId] = {
          name: locName,
          orders: 0,
          order_value: 0,
          receivable: 0,
          collected: 0,
          receivable_type: recType,
        };
      }
      summary.by_location[locId].orders++;
      summary.by_location[locId].order_value += o.total_amount || 0;
      summary.by_location[locId].receivable += o.calculated_receivable || 0;
      summary.by_location[locId].collected += o.collected_amount || 0;
    });

    return { data: { details: enrichedOrders, summary }, error: null };
  },
};

/**
 * Pricing Helper - Resolve final price for an order item
 */
const pricingHelper = {
  /**
   * Resolve the effective price for a test
   * Priority: Direct Account Price (B2B) → Price Master Price → Location Price (B2C) → Base Price
   */
  async resolveTestPrice(
    testGroupId: string,
    basePrice: number,
    options: {
      accountId?: string | null;
      locationId?: string | null;
    },
  ): Promise<{
    price: number;
    source: "account" | "location" | "base";
    lab_receivable?: number;
  }> {
    // 1. Check direct B2B account price (highest priority)
    if (options.accountId) {
      const { data: accountPrice } = await supabase
        .from("account_prices")
        .select("price")
        .eq("account_id", options.accountId)
        .eq("test_group_id", testGroupId)
        .eq("is_active", true)
        .lte("effective_from", new Date().toISOString().split("T")[0])
        .order("effective_from", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (accountPrice?.price !== undefined) {
        return { price: accountPrice.price, source: "account" };
      }

      // 2. Check linked price master price
      const { data: account } = await supabase
        .from("accounts")
        .select("price_master_id")
        .eq("id", options.accountId)
        .maybeSingle();

      if (account?.price_master_id) {
        const { data: planPrice } = await supabase
          .from("price_master_items")
          .select("price")
          .eq("price_master_id", account.price_master_id)
          .eq("test_group_id", testGroupId)
          .maybeSingle();

        if (planPrice?.price !== undefined) {
          return { price: planPrice.price, source: "account" };
        }
      }
    }

    // 3. Check location price (B2C franchise)
    if (options.locationId) {
      const { data: locationPrice } = await locationTestPrices.getPrice(
        options.locationId,
        testGroupId,
      );

      if (locationPrice?.patient_price !== undefined) {
        return {
          price: locationPrice.patient_price,
          source: "location",
          lab_receivable: locationPrice.lab_receivable || undefined,
        };
      }
    }

    // 4. Fall back to base price
    return { price: basePrice, source: "base" };
  },

  /**
   * Resolve the effective price for a package
   * Priority: Account Price (B2B) → Location Price (B2C) → Base Price
   */
  async resolvePackagePrice(
    packageId: string,
    basePrice: number,
    options: {
      accountId?: string | null;
      locationId?: string | null;
    },
  ): Promise<{
    price: number;
    source: "account" | "location" | "base";
    lab_receivable?: number;
  }> {
    // 1. Check B2B account price (highest priority)
    if (options.accountId) {
      const { data: accountPrice } = await accountPackagePrices.getPrice(
        options.accountId,
        packageId,
      );

      if (accountPrice?.price !== undefined) {
        return { price: accountPrice.price, source: "account" };
      }
    }

    // 2. Check location price (B2C franchise)
    if (options.locationId) {
      const { data: locationPrice } = await supabase
        .from("location_package_prices")
        .select("*")
        .eq("location_id", options.locationId)
        .eq("package_id", packageId)
        .eq("is_active", true)
        .lte("effective_from", new Date().toISOString().split("T")[0])
        .order("effective_from", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (locationPrice?.patient_price !== undefined) {
        return {
          price: locationPrice.patient_price,
          source: "location",
          lab_receivable: locationPrice.lab_receivable || undefined,
        };
      }
    }

    // 3. Fall back to base price
    return { price: basePrice, source: "base" };
  },

  /**
   * Get all prices for a location or account (for order form dropdown)
   */
  async getPriceMatrix(options: {
    accountId?: string | null;
    locationId?: string | null;
  }): Promise<{
    testPrices: Record<
      string,
      { price: number; source: string; lab_receivable?: number }
    >;
    packagePrices: Record<
      string,
      { price: number; source: string; lab_receivable?: number }
    >;
  }> {
    const testPrices: Record<
      string,
      { price: number; source: string; lab_receivable?: number }
    > = {};
    const packagePrices: Record<
      string,
      { price: number; source: string; lab_receivable?: number }
    > = {};

    // Get account test prices (B2B)
    if (options.accountId) {
      const { data: account } = await supabase
        .from("accounts")
        .select("price_master_id")
        .eq("id", options.accountId)
        .maybeSingle();

      if (account?.price_master_id) {
        const { data: priceMasterItems } = await supabase
          .from("price_master_items")
          .select("test_group_id, price")
          .eq("price_master_id", account.price_master_id);

        (priceMasterItems || []).forEach((p: any) => {
          testPrices[p.test_group_id] = { price: p.price, source: "account" };
        });
      }

      const { data: accountTestPrices } = await supabase
        .from("account_prices")
        .select("test_group_id, price")
        .eq("account_id", options.accountId)
        .eq("is_active", true);

      (accountTestPrices || []).forEach((p: any) => {
        testPrices[p.test_group_id] = { price: p.price, source: "account" };
      });

      const { data: accountPkgPrices } = await accountPackagePrices
        .getByAccount(options.accountId);
      (accountPkgPrices || []).forEach((p: any) => {
        packagePrices[p.package_id] = { price: p.price, source: "account" };
      });
    }

    // Get location prices (B2C) - only if not already set by account
    if (options.locationId) {
      const { data: locTestPrices } = await locationTestPrices.getByLocation(
        options.locationId,
      );
      (locTestPrices || []).forEach((p: any) => {
        if (!testPrices[p.test_group_id]) {
          testPrices[p.test_group_id] = {
            price: p.patient_price,
            source: "location",
            lab_receivable: p.lab_receivable || undefined,
          };
        }
      });

      const { data: locPkgPrices } = await locationPackagePrices.getByLocation(
        options.locationId,
      );
      (locPkgPrices || []).forEach((p: any) => {
        if (!packagePrices[p.package_id]) {
          packagePrices[p.package_id] = {
            price: p.patient_price,
            source: "location",
            lab_receivable: p.lab_receivable || undefined,
          };
        }
      });
    }

    return { testPrices, packagePrices };
  },
};

// =============================================
// ANALYTICS NAMESPACE
// =============================================

export type AnalyticsDateRange = {
  from: Date;
  to: Date;
};

export type AnalyticsFilters = {
  lab_id: string;
  date_range?: AnalyticsDateRange;
  location_id?: string;
  department?: string;
  account_id?: string;
};

export type KpiSummary = {
  date: string;
  total_orders: number;
  total_revenue: number;
  avg_order_value: number;
  samples_collected: number;
  reports_generated: number;
  pending_reports: number;
  critical_results: number;
  tat_breaches: number;
};

export type RevenueDaily = {
  date: string;
  location_id: string | null;
  location_name: string | null;
  gross_revenue: number;
  discounts: number;
  net_revenue: number;
  cash_collected: number;
  card_collected: number;
  upi_collected: number;
  bank_transfer_collected: number;
  credit_outstanding: number;
  refunds: number;
  invoice_count: number;
  order_count: number;
};

export type DepartmentStats = {
  date: string;
  department: string;
  order_count: number;
  test_count: number;
  revenue: number;
  order_percentage: number;
  revenue_percentage: number;
};

export type StatusDistribution = {
  date: string;
  status: string;
  count: number;
  percentage: number;
};

export type TestPopularity = {
  test_group_id: string;
  test_name: string;
  department: string | null;
  order_count: number;
  revenue: number;
  avg_price: number;
  rank_by_volume: number;
  rank_by_revenue: number;
};

export type TatSummary = {
  date: string;
  department: string | null;
  test_name: string;
  target_tat: number | null;
  avg_tat_hours: number;
  min_tat_hours: number;
  max_tat_hours: number;
  within_target: number;
  breached: number;
  total_tests: number;
  breach_percentage: number;
};

export type LocationPerformance = {
  location_id: string | null;
  location_name: string | null;
  date: string;
  order_count: number;
  patient_count: number;
  test_count: number;
  revenue: number;
  collected: number;
  collection_efficiency: number;
  sample_collection_rate: number;
  avg_processing_hours: number;
};

export type AccountPerformance = {
  account_id: string;
  account_name: string;
  account_type: string | null;
  date: string;
  order_count: number;
  patient_count: number;
  revenue: number;
  collected: number;
  outstanding_amount: number;
  avg_order_value: number;
  avg_payment_days: number;
};

export type OutsourcedSummary = {
  outsourced_lab_id: string;
  outsourced_lab_name: string;
  date: string;
  test_count: number;
  order_count: number;
  cost: number;
  revenue: number;
  margin: number;
  margin_percentage: number;
  pending_results: number;
  avg_tat_hours: number | null;
};

export type CriticalAlert = {
  order_id: string;
  patient_id: string;
  patient_name: string;
  patient_phone: string | null;
  test_name: string;
  analyte_name: string;
  value: string;
  unit: string | null;
  reference_range: string | null;
  flag: string;
  result_date: string;
  doctor_name: string | null;
  doctor_phone: string | null;
  hours_since_result: number;
  is_notified: boolean;
};

export type PatientDemographic = {
  date: string;
  gender: string;
  age_group: string;
  patient_count: number;
  order_count: number;
  revenue: number;
};

export type HourlyDistribution = {
  date: string;
  hour: number;
  order_count: number;
  avg_order_value: number;
};

export type PaymentMethodStats = {
  date: string;
  payment_method: string;
  transaction_count: number;
  total_amount: number;
  avg_amount: number;
  percentage: number;
};

const analytics = {
  /**
   * Get KPI summary for analytics dashboard header
   */
  async getKpiSummary(
    filters: AnalyticsFilters,
  ): Promise<{ data: KpiSummary[] | null; error: any }> {
    let query = supabase
      .from("v_analytics_kpi_summary")
      .select("*")
      .eq("lab_id", filters.lab_id);

    if (filters.date_range) {
      query = query
        .gte("date", filters.date_range.from.toISOString().split("T")[0])
        .lte("date", filters.date_range.to.toISOString().split("T")[0]);
    }

    if (filters.location_id) {
      query = query.eq("location_id", filters.location_id);
    } else {
      query = query.is("location_id", null);
    }

    const { data, error } = await query.order("date", { ascending: false });
    return { data, error };
  },

  /**
   * Get aggregated KPIs for a date range (single row totals)
   */
  async getKpiTotals(
    filters: AnalyticsFilters,
  ): Promise<{ data: KpiSummary | null; error: any }> {
    const { data, error } = await this.getKpiSummary(filters);
    if (error || !data || data.length === 0) return { data: null, error };

    // Aggregate all days
    const totals: KpiSummary = {
      date: filters.date_range?.from.toISOString().split("T")[0] ||
        new Date().toISOString().split("T")[0],
      total_orders: data.reduce((sum, d) => sum + (d.total_orders || 0), 0),
      total_revenue: data.reduce((sum, d) => sum + (d.total_revenue || 0), 0),
      avg_order_value: 0,
      samples_collected: data.reduce(
        (sum, d) => sum + (d.samples_collected || 0),
        0,
      ),
      reports_generated: data.reduce(
        (sum, d) => sum + (d.reports_generated || 0),
        0,
      ),
      pending_reports: data.reduce(
        (sum, d) => sum + (d.pending_reports || 0),
        0,
      ),
      critical_results: data.reduce(
        (sum, d) => sum + (d.critical_results || 0),
        0,
      ),
      tat_breaches: data.reduce((sum, d) => sum + (d.tat_breaches || 0), 0),
    };
    totals.avg_order_value = totals.total_orders > 0
      ? Math.round(totals.total_revenue / totals.total_orders)
      : 0;

    return { data: totals, error: null };
  },

  /**
   * Get daily revenue breakdown
   */
  async getRevenueDaily(
    filters: AnalyticsFilters,
  ): Promise<{ data: RevenueDaily[] | null; error: any }> {
    let query = supabase
      .from("v_analytics_revenue_daily")
      .select("*")
      .eq("lab_id", filters.lab_id);

    if (filters.date_range) {
      query = query
        .gte("date", filters.date_range.from.toISOString().split("T")[0])
        .lte("date", filters.date_range.to.toISOString().split("T")[0]);
    }

    if (filters.location_id) {
      query = query.eq("location_id", filters.location_id);
    }

    const { data, error } = await query.order("date", { ascending: false });
    return { data, error };
  },

  /**
   * Get orders breakdown by department
   */
  async getOrdersByDepartment(
    filters: AnalyticsFilters,
  ): Promise<{ data: DepartmentStats[] | null; error: any }> {
    let query = supabase
      .from("v_analytics_orders_by_department")
      .select("*")
      .eq("lab_id", filters.lab_id);

    if (filters.date_range) {
      query = query
        .gte("date", filters.date_range.from.toISOString().split("T")[0])
        .lte("date", filters.date_range.to.toISOString().split("T")[0]);
    }

    if (filters.location_id) {
      query = query.eq("location_id", filters.location_id);
    } else {
      query = query.is("location_id", null);
    }

    if (filters.department) {
      query = query.eq("department", filters.department);
    }

    const { data, error } = await query.order("date", { ascending: false });
    return { data, error };
  },

  /**
   * Get orders by status for funnel/donut chart
   */
  async getOrdersByStatus(
    filters: AnalyticsFilters,
  ): Promise<{ data: StatusDistribution[] | null; error: any }> {
    let query = supabase
      .from("v_analytics_orders_by_status")
      .select("*")
      .eq("lab_id", filters.lab_id);

    if (filters.date_range) {
      query = query
        .gte("date", filters.date_range.from.toISOString().split("T")[0])
        .lte("date", filters.date_range.to.toISOString().split("T")[0]);
    }

    if (filters.location_id) {
      query = query.eq("location_id", filters.location_id);
    } else {
      query = query.is("location_id", null);
    }

    const { data, error } = await query.order("count", { ascending: false });
    return { data, error };
  },

  /**
   * Get top tests by volume and revenue
   */
  async getTestPopularity(
    filters: AnalyticsFilters,
    limit = 10,
  ): Promise<{ data: TestPopularity[] | null; error: any }> {
    let query = supabase
      .from("v_analytics_test_popularity")
      .select("*")
      .eq("lab_id", filters.lab_id);

    if (filters.location_id) {
      query = query.eq("location_id", filters.location_id);
    } else {
      query = query.is("location_id", null);
    }

    const { data, error } = await query.lte("rank_by_volume", limit);
    return { data, error };
  },

  /**
   * Get TAT summary by department
   */
  async getTatSummary(
    filters: AnalyticsFilters,
  ): Promise<{ data: TatSummary[] | null; error: any }> {
    let query = supabase
      .from("v_analytics_tat_summary")
      .select("*")
      .eq("lab_id", filters.lab_id);

    if (filters.date_range) {
      query = query
        .gte("date", filters.date_range.from.toISOString().split("T")[0])
        .lte("date", filters.date_range.to.toISOString().split("T")[0]);
    }

    if (filters.location_id) {
      query = query.eq("location_id", filters.location_id);
    } else {
      query = query.is("location_id", null);
    }

    if (filters.department) {
      query = query.eq("department", filters.department);
    }

    const { data, error } = await query.order("breach_percentage", {
      ascending: false,
    });
    return { data, error };
  },

  /**
   * Get location performance metrics
   */
  async getLocationPerformance(
    filters: AnalyticsFilters,
  ): Promise<{ data: LocationPerformance[] | null; error: any }> {
    let query = supabase
      .from("v_analytics_location_performance")
      .select("*")
      .eq("lab_id", filters.lab_id);

    if (filters.date_range) {
      query = query
        .gte("date", filters.date_range.from.toISOString().split("T")[0])
        .lte("date", filters.date_range.to.toISOString().split("T")[0]);
    }

    if (filters.location_id) {
      query = query.eq("location_id", filters.location_id);
    }

    const { data, error } = await query.order("revenue", { ascending: false });
    return { data, error };
  },

  /**
   * Get B2B account performance
   */
  async getAccountPerformance(
    filters: AnalyticsFilters,
  ): Promise<{ data: AccountPerformance[] | null; error: any }> {
    let query = supabase
      .from("v_analytics_account_performance")
      .select("*")
      .eq("lab_id", filters.lab_id);

    if (filters.date_range) {
      query = query
        .gte("date", filters.date_range.from.toISOString().split("T")[0])
        .lte("date", filters.date_range.to.toISOString().split("T")[0]);
    }

    if (filters.location_id) {
      query = query.eq("location_id", filters.location_id);
    } else {
      query = query.is("location_id", null);
    }

    if (filters.account_id) {
      query = query.eq("account_id", filters.account_id);
    }

    const { data, error } = await query.order("revenue", { ascending: false });
    return { data, error };
  },

  /**
   * Get outsourced lab metrics
   */
  async getOutsourcedSummary(
    filters: AnalyticsFilters,
  ): Promise<{ data: OutsourcedSummary[] | null; error: any }> {
    let query = supabase
      .from("v_analytics_outsourced_summary")
      .select("*")
      .eq("lab_id", filters.lab_id);

    if (filters.date_range) {
      query = query
        .gte("date", filters.date_range.from.toISOString().split("T")[0])
        .lte("date", filters.date_range.to.toISOString().split("T")[0]);
    }

    if (filters.location_id) {
      query = query.eq("location_id", filters.location_id);
    } else {
      query = query.is("location_id", null);
    }

    const { data, error } = await query.order("revenue", { ascending: false });
    return { data, error };
  },

  /**
   * Get critical and abnormal alerts
   */
  async getCriticalAlerts(
    filters: AnalyticsFilters,
  ): Promise<{ data: CriticalAlert[] | null; error: any }> {
    let query = supabase
      .from("v_analytics_critical_alerts")
      .select("*")
      .eq("lab_id", filters.lab_id);

    if (filters.location_id) {
      query = query.eq("location_id", filters.location_id);
    }

    const { data, error } = await query
      .order("flag", { ascending: true }) // C first, then H, then L
      .order("hours_since_result", { ascending: false })
      .limit(100);

    return { data, error };
  },

  /**
   * Get patient demographics
   */
  async getPatientDemographics(
    filters: AnalyticsFilters,
  ): Promise<{ data: PatientDemographic[] | null; error: any }> {
    let query = supabase
      .from("v_analytics_patient_demographics")
      .select("*")
      .eq("lab_id", filters.lab_id);

    if (filters.date_range) {
      query = query
        .gte("date", filters.date_range.from.toISOString().split("T")[0])
        .lte("date", filters.date_range.to.toISOString().split("T")[0]);
    }

    if (filters.location_id) {
      query = query.eq("location_id", filters.location_id);
    } else {
      query = query.is("location_id", null);
    }

    const { data, error } = await query.order("patient_count", {
      ascending: false,
    });
    return { data, error };
  },

  /**
   * Get hourly order distribution
   */
  async getHourlyDistribution(
    filters: AnalyticsFilters,
  ): Promise<{ data: HourlyDistribution[] | null; error: any }> {
    let query = supabase
      .from("v_analytics_hourly_distribution")
      .select("*")
      .eq("lab_id", filters.lab_id);

    if (filters.date_range) {
      query = query
        .gte("date", filters.date_range.from.toISOString().split("T")[0])
        .lte("date", filters.date_range.to.toISOString().split("T")[0]);
    }

    if (filters.location_id) {
      query = query.eq("location_id", filters.location_id);
    } else {
      query = query.is("location_id", null);
    }

    const { data, error } = await query.order("hour", { ascending: true });
    return { data, error };
  },

  /**
   * Get payment method distribution
   */
  async getPaymentMethods(
    filters: AnalyticsFilters,
  ): Promise<{ data: PaymentMethodStats[] | null; error: any }> {
    let query = supabase
      .from("v_analytics_payment_methods")
      .select("*")
      .eq("lab_id", filters.lab_id);

    if (filters.date_range) {
      query = query
        .gte("date", filters.date_range.from.toISOString().split("T")[0])
        .lte("date", filters.date_range.to.toISOString().split("T")[0]);
    }

    if (filters.location_id) {
      query = query.eq("location_id", filters.location_id);
    } else {
      query = query.is("location_id", null);
    }

    const { data, error } = await query.order("total_amount", {
      ascending: false,
    });
    return { data, error };
  },

  /**
   * Get daily cash summary (from existing view)
   */
  async getDailyCashSummary(
    options: { lab_id: string; date: Date; location_id?: string },
  ): Promise<{ data: any[] | null; error: any }> {
    let query = supabase
      .from("v_daily_cash_summary")
      .select("*")
      .eq("lab_id", options.lab_id)
      .eq("summary_date", options.date.toISOString().split("T")[0]);

    if (options.location_id) {
      query = query.eq("location_id", options.location_id);
    }

    const { data, error } = await query;
    return { data, error };
  },
};

// ============================================================================
// INVENTORY MODULE - AI-First Inventory Management
// ============================================================================

export interface InventoryItem {
  id: string;
  lab_id: string;
  location_id?: string | null;
  name: string;
  code?: string;
  type: "reagent" | "consumable" | "calibrator" | "control" | "general";
  current_stock: number;
  unit: string;
  min_stock: number;
  batch_number?: string;
  expiry_date?: string;
  storage_temp?: string;
  storage_location?: string;
  consumption_scope:
      | "per_test"
      | "per_sample"
      | "per_order"
      | "qc_only"
      | "general"
      | "manual";
  consumption_per_use?: number;
  pack_contains?: number;
  unit_price?: number;
  supplier_name?: string;
  supplier_contact?: string;
  is_partner_orderable?: boolean;
  ai_data?: Record<string, any>;
  is_active: boolean;
  notes?: string;
  created_at: string;
  updated_at: string;
  created_by?: string;
  // Computed fields from views
  tests_remaining?: number;
  days_to_expiry?: number;
  needs_attention?: boolean;
}

export interface InventoryTransaction {
  id: string;
  lab_id: string;
  item_id: string;
  location_id?: string | null;
  type: "in" | "out" | "adjust";
  quantity: number;
  stock_before?: number;
  stock_after?: number;
  reason?: string;
  reference?: string;
  batch_number?: string;
  expiry_date?: string;
  unit_price?: number;
  order_id?: string;
  result_id?: string;
  test_group_id?: string;
  ai_input?: Record<string, any>;
  performed_by?: string;
  created_at: string;
  // Joined fields
  item?: InventoryItem;
  performed_by_user?: { name: string; email: string };
}

export interface StockAlert {
  id: string;
  lab_id: string;
  item_id: string;
  location_id?: string | null;
  type: "low_stock" | "out_of_stock" | "expiring" | "expired";
  message: string;
  current_value?: number;
  threshold_value?: number;
  ai_suggestion?: string;
  status: "active" | "dismissed" | "resolved";
  dismissed_by?: string;
  dismissed_at?: string;
  resolved_at?: string;
  resolution_note?: string;
  created_at: string;
  // Joined fields
  item?: InventoryItem;
}

export interface InventoryTestMapping {
  id: string;
  lab_id: string;
  test_group_id?: string;
  analyte_id?: string;
  item_id: string;
  quantity_per_test: number;
  unit?: string;
  ai_suggested: boolean;
  ai_confidence?: number;
  ai_reasoning?: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  created_by?: string;
  // Joined fields
  item?: InventoryItem;
  test_group?: { id: string; name: string };
  analyte?: { id: string; name: string };
}

export interface InventoryDashboardStats {
  total_items: number;
  low_stock_count: number;
  out_of_stock_count: number;
  expiring_soon_count: number;
  active_alerts_count: number;
  total_value: number;
}

export interface InventoryOrderItem {
  item_id?: string;
  name: string;
  quantity: number;
  unit: string;
  unit_price?: number;
  total?: number;
}

export interface InventoryOrder {
  id: string;
  lab_id: string;
  order_number?: string;
  order_date: string;
  supplier_id?: string;
  supplier_name?: string;
  items: InventoryOrderItem[];
  subtotal?: number;
  tax_amount?: number;
  total_amount?: number;
  status:
    | "draft"
    | "requested"
    | "approved"
    | "ordered"
    | "received"
    | "cancelled";
  ai_suggested?: boolean;
  request_source?: string;
  requested_by?: string;
  requested_at?: string;
  approved_by?: string;
  approved_at?: string;
  approval_note?: string;
  invoice_number?: string;
  invoice_date?: string;
  received_at?: string;
  received_by?: string;
  notes?: string;
  created_at: string;
  updated_at: string;
  created_by?: string;
}

const inventory = {
  // ============================================================================
  // ITEMS CRUD
  // ============================================================================

  async getItems(options?: {
    type?: string;
    search?: string;
    lowStockOnly?: boolean;
    expiringDays?: number;
    isActive?: boolean;
    locationId?: string;
  }): Promise<{ data: InventoryItem[] | null; error: any }> {
    const labId = await database.getCurrentUserLabId();
    if (!labId) return { data: null, error: new Error("No lab_id found") };

    const tableName = options?.lowStockOnly
      ? "v_inventory_with_tests"
      : "inventory_items";
    let query = supabase
      .from(tableName)
      .select("*")
      .eq("lab_id", labId)
      .order("name");

    if (options?.type) {
      query = query.eq("type", options.type);
    }

    if (options?.search) {
      query = query.or(
        `name.ilike.%${options.search}%,code.ilike.%${options.search}%`,
      );
    }

    if (options?.lowStockOnly) {
      query = query.in("stock_status", ["low_stock", "out_of_stock"]);
    }

    if (options?.isActive !== undefined) {
      query = query.eq("is_active", options.isActive);
    }

    if (options?.locationId) {
      query = query.eq("location_id", options.locationId);
    }

    const { data, error } = await query;
    return { data, error };
  },

  async getItemsWithStats(
    options?: { locationId?: string },
  ): Promise<{ data: InventoryItem[] | null; error: any }> {
    const labId = await database.getCurrentUserLabId();
    if (!labId) return { data: null, error: new Error("No lab_id found") };

    // Use the view that includes tests_remaining calculation
    let query = supabase
      .from("v_inventory_with_tests")
      .select("*")
      .eq("lab_id", labId)
      .eq("is_active", true)
      .order("name");

    if (options?.locationId) {
      query = query.eq("location_id", options.locationId);
    }

    const { data, error } = await query;

    return { data, error };
  },

  async getItemsNeedingAttention(
    options?: { locationId?: string },
  ): Promise<{ data: InventoryItem[] | null; error: any }> {
    const labId = await database.getCurrentUserLabId();
    if (!labId) return { data: null, error: new Error("No lab_id found") };

    // Use the attention view
    let query = supabase
      .from("v_inventory_attention")
      .select("*")
      .eq("lab_id", labId)
      .order("priority", { ascending: true });

    if (options?.locationId) {
      query = query.eq("location_id", options.locationId);
    }

    const { data, error } = await query;

    return { data, error };
  },

  async getItemById(
    itemId: string,
  ): Promise<{ data: InventoryItem | null; error: any }> {
    const { data, error } = await supabase
      .from("inventory_items")
      .select("*")
      .eq("id", itemId)
      .single();

    return { data, error };
  },

  async createItem(
    item: Partial<InventoryItem> & { location_id?: string | null },
  ): Promise<{ data: InventoryItem | null; error: any }> {
    const labId = await database.getCurrentUserLabId();
    if (!labId) return { data: null, error: new Error("No lab_id found") };

    const appUserId = await database.getCurrentAppUserId();

    let locationId = item.location_id;
    if (!locationId) {
      const { data: lab } = await supabase
        .from("labs")
        .select("default_processing_location_id")
        .eq("id", labId)
        .single();
      locationId = lab?.default_processing_location_id || null;
    }

    const { data, error } = await supabase
      .from("inventory_items")
      .insert({
        ...item,
        lab_id: labId,
        location_id: locationId,
        created_by: appUserId,
      })
      .select()
      .single();

    return { data, error };
  },

  async updateItem(
    itemId: string,
    updates: Partial<InventoryItem>,
  ): Promise<{ data: InventoryItem | null; error: any }> {
    const { data, error } = await supabase
      .from("inventory_items")
      .update({
        ...updates,
        updated_at: new Date().toISOString(),
      })
      .eq("id", itemId)
      .select()
      .single();

    return { data, error };
  },

  async deleteItem(itemId: string): Promise<{ error: any }> {
    // Soft delete by setting is_active to false
    const { error } = await supabase
      .from("inventory_items")
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq("id", itemId);

    return { error };
  },

  // ============================================================================
  // TRANSACTIONS
  // ============================================================================

  async getTransactions(options?: {
    itemId?: string;
    type?: "in" | "out" | "adjust";
    fromDate?: string;
    toDate?: string;
    limit?: number;
    locationId?: string;
  }): Promise<{ data: InventoryTransaction[] | null; error: any }> {
    const labId = await database.getCurrentUserLabId();
    if (!labId) return { data: null, error: new Error("No lab_id found") };

    let query = supabase
      .from("inventory_transactions")
      .select(`
        *,
        item:inventory_items(id, name, code, unit),
        performed_by_user:users!inventory_transactions_performed_by_fkey(name, email)
      `)
      .eq("lab_id", labId)
      .order("created_at", { ascending: false });

    if (options?.itemId) {
      query = query.eq("item_id", options.itemId);
    }

    if (options?.type) {
      query = query.eq("type", options.type);
    }

    if (options?.fromDate) {
      query = query.gte("created_at", options.fromDate);
    }

    if (options?.toDate) {
      query = query.lte("created_at", options.toDate);
    }

    if (options?.limit) {
      query = query.limit(options.limit);
    }

    if (options?.locationId) {
      query = query.eq("location_id", options.locationId);
    }

    const { data, error } = await query;
    return { data, error };
  },

  async createTransaction(transaction: {
    item_id: string;
    type: "in" | "out" | "adjust";
    quantity: number;
    reason?: string;
    reference?: string;
    batch_number?: string;
    expiry_date?: string;
    unit_price?: number;
    order_id?: string;
    result_id?: string;
    test_group_id?: string;
    ai_input?: Record<string, any>;
    location_id?: string;
  }): Promise<{ data: InventoryTransaction | null; error: any }> {
    const labId = await database.getCurrentUserLabId();
    if (!labId) return { data: null, error: new Error("No lab_id found") };

    const appUserId = await database.getCurrentAppUserId();

    const { data, error } = await supabase
      .from("inventory_transactions")
      .insert({
        ...transaction,
        lab_id: labId,
        performed_by: appUserId,
      })
      .select()
      .single();

    return { data, error };
  },

  // ============================================================================
  // STOCK OPERATIONS
  // ============================================================================

  async addStock(params: {
    itemId: string;
    quantity: number;
    reason?: string;
    reference?: string;
    batchNumber?: string;
    expiryDate?: string;
    unitPrice?: number;
    supplierName?: string;
    locationId?: string;
  }): Promise<{ data: InventoryTransaction | null; error: any }> {
    return this.createTransaction({
      item_id: params.itemId,
      type: "in",
      quantity: params.quantity,
      reason: params.reason || "Purchase",
      reference: params.reference,
      batch_number: params.batchNumber,
      expiry_date: params.expiryDate,
      unit_price: params.unitPrice,
      location_id: params.locationId,
    });
  },

  async consumeStock(params: {
    itemId: string;
    quantity: number;
    reason: string;
    orderId?: string;
    resultId?: string;
    testGroupId?: string;
    locationId?: string;
  }): Promise<{ data: InventoryTransaction | null; error: any }> {
    return this.createTransaction({
      item_id: params.itemId,
      type: "out",
      quantity: params.quantity,
      reason: params.reason,
      order_id: params.orderId,
      result_id: params.resultId,
      test_group_id: params.testGroupId,
      location_id: params.locationId,
    });
  },

  async adjustStock(params: {
    itemId: string;
    newQuantity: number;
    reason: string;
    locationId?: string;
  }): Promise<{ data: InventoryTransaction | null; error: any }> {
    return this.createTransaction({
      item_id: params.itemId,
      type: "adjust",
      quantity: params.newQuantity,
      reason: params.reason,
      location_id: params.locationId,
    });
  },

  // ============================================================================
  // ALERTS
  // ============================================================================

  async getAlerts(options?: {
    status?: "active" | "dismissed" | "resolved";
    type?: "low_stock" | "out_of_stock" | "expiring" | "expired";
    locationId?: string;
  }): Promise<{ data: StockAlert[] | null; error: any }> {
    const labId = await database.getCurrentUserLabId();
    if (!labId) return { data: null, error: new Error("No lab_id found") };

    let query = supabase
      .from("stock_alerts")
      .select(`
        *,
        item:inventory_items(id, name, code, current_stock, unit, min_stock)
      `)
      .eq("lab_id", labId)
      .order("created_at", { ascending: false });

    if (options?.status) {
      query = query.eq("status", options.status);
    } else {
      query = query.eq("status", "active"); // Default to active
    }

    if (options?.type) {
      query = query.eq("type", options.type);
    }

    if (options?.locationId) {
      query = query.eq("location_id", options.locationId);
    }

    const { data, error } = await query;
    return { data, error };
  },

  async dismissAlert(alertId: string): Promise<{ error: any }> {
    const { data: { user } } = await supabase.auth.getUser();

    const { error } = await supabase
      .from("stock_alerts")
      .update({
        status: "dismissed",
        dismissed_by: user?.id,
        dismissed_at: new Date().toISOString(),
      })
      .eq("id", alertId);

    return { error };
  },

  async resolveAlert(
    alertId: string,
    resolutionNote?: string,
  ): Promise<{ error: any }> {
    const { error } = await supabase
      .from("stock_alerts")
      .update({
        status: "resolved",
        resolved_at: new Date().toISOString(),
        resolution_note: resolutionNote,
      })
      .eq("id", alertId);

    return { error };
  },

  // ============================================================================
  // DASHBOARD STATS
  // ============================================================================

  async getDashboardStats(
    options?: { locationId?: string },
  ): Promise<{ data: InventoryDashboardStats | null; error: any }> {
    const labId = await database.getCurrentUserLabId();
    if (!labId) return { data: null, error: new Error("No lab_id found") };

    try {
      // Get stats from database function
      const { data, error } = await supabase.rpc(
        "fn_inventory_dashboard_stats",
        {
          p_lab_id: labId,
          p_location_id: options?.locationId || null,
        },
      );

      if (error) {
        // Fallback to manual calculation if function doesn't exist
        let itemsQuery = supabase
          .from("inventory_items")
          .select("id, current_stock, min_stock, unit_price, expiry_date")
          .eq("lab_id", labId)
          .eq("is_active", true);

        if (options?.locationId) {
          itemsQuery = itemsQuery.eq("location_id", options.locationId);
        }

        const { data: items } = await itemsQuery;

        let alertsQuery = supabase
          .from("stock_alerts")
          .select("id")
          .eq("lab_id", labId)
          .eq("status", "active");

        if (options?.locationId) {
          alertsQuery = alertsQuery.eq("location_id", options.locationId);
        }

        const { data: alerts } = await alertsQuery;

        const today = new Date();
        const thirtyDaysFromNow = new Date(
          today.getTime() + 30 * 24 * 60 * 60 * 1000,
        );

        const stats: InventoryDashboardStats = {
          total_items: items?.length || 0,
          low_stock_count: items?.filter((i) =>
            i.current_stock <= i.min_stock && i.current_stock > 0
          ).length || 0,
          out_of_stock_count: items?.filter((i) =>
            i.current_stock <= 0
          ).length || 0,
          expiring_soon_count: items?.filter((i) => {
            if (!i.expiry_date) return false;
            const exp = new Date(i.expiry_date);
            return exp <= thirtyDaysFromNow && exp > today;
          }).length || 0,
          active_alerts_count: alerts?.length || 0,
          total_value: items?.reduce((sum, i) =>
            sum + (i.current_stock * (i.unit_price || 0)), 0) || 0,
        };

        return { data: stats, error: null };
      }

      const row = Array.isArray(data) ? (data[0] || null) : (data || null);
      if (!row) return { data: null, error: null };

      const normalized: InventoryDashboardStats = {
        total_items: row.total_items ?? 0,
        low_stock_count: row.low_stock_count ?? row.low_stock ?? 0,
        out_of_stock_count: row.out_of_stock_count ?? row.out_of_stock ?? 0,
        expiring_soon_count: row.expiring_soon_count ?? row.expiring_soon ?? 0,
        active_alerts_count: row.active_alerts_count ?? 0,
        total_value: row.total_value ?? 0,
      };

      return { data: normalized, error: null };
    } catch (err) {
      return { data: null, error: err };
    }
  },

  async triggerAutoConsume(params: {
    labId: string;
    orderId: string;
    resultId?: string;
    testGroupId: string;
  }): Promise<{ data: any | null; error: any }> {
    const appUserId = await database.getCurrentAppUserId();

    // Primary path: edge function (supports analyte-level logic and dedupe)
    try {
      const { data, error } = await supabase.functions.invoke(
        "inventory-auto-consume",
        {
          body: {
            labId: params.labId,
            orderId: params.orderId,
            resultId: params.resultId || null,
            testGroupId: params.testGroupId,
            userId: appUserId || undefined,
          },
        },
      );

      if (!error) {
        return { data, error: null };
      }
    } catch (err) {
      // Fall through to RPC fallback
    }

    // Fallback path: DB RPC so consumption still gets registered
    try {
      const { data: rpcData, error: rpcError } = await supabase.rpc(
        "fn_inventory_auto_consume",
        {
          p_lab_id: params.labId,
          p_order_id: params.orderId,
          p_result_id: params.resultId || null,
          p_test_group_id: params.testGroupId,
          p_user_id: appUserId,
        },
      );

      return { data: rpcData, error: rpcError };
    } catch (rpcErr) {
      return { data: null, error: rpcErr };
    }
  },

  async consumeScopedItems(params: {
    scope: "per_sample" | "per_order";
    orderId: string;
    sourceRef: string;
    source?: "auto_sample" | "auto_order";
    reason?: string;
  }): Promise<{ data: { consumed: number; skipped: number } | null; error: any }> {
    const labId = await database.getCurrentUserLabId();
    if (!labId) return { data: null, error: new Error("No lab_id found") };

    const source = params.source || (params.scope === "per_sample" ? "auto_sample" : "auto_order");

    try {
      const { data: items, error: itemsError } = await supabase
        .from("inventory_items")
        .select("id, name, current_stock, consumption_per_use, pack_contains, location_id")
        .eq("lab_id", labId)
        .eq("consumption_scope", params.scope)
        .eq("is_active", true)
        .gt("consumption_per_use", 0);

      if (itemsError) return { data: null, error: itemsError };

      let consumed = 0;
      let skipped = 0;

      for (const item of items || []) {
        const { data: existingTx, error: existingError } = await supabase
          .from("inventory_transactions")
          .select("id")
          .eq("lab_id", labId)
          .eq("order_id", params.orderId)
          .eq("item_id", item.id)
          .eq("type", "out")
          .contains("ai_input", {
            source,
            source_ref: params.sourceRef,
          })
          .limit(1);

        if (existingError) {
          return { data: null, error: existingError };
        }

        if (existingTx && existingTx.length > 0) {
          skipped += 1;
          continue;
        }

        const rawPerUse = Number(item.consumption_per_use || 0);
        const deduction = item.pack_contains && item.pack_contains > 0
          ? rawPerUse / item.pack_contains
          : rawPerUse;

        if (!(deduction > 0)) {
          skipped += 1;
          continue;
        }

        const { error: txError } = await this.createTransaction({
          item_id: item.id,
          type: "out",
          quantity: deduction,
          reason: params.reason || `Auto-consumed: ${params.scope}`,
          order_id: params.orderId,
          location_id: item.location_id || undefined,
          ai_input: {
            source,
            scope: params.scope,
            source_ref: params.sourceRef,
          },
        });

        if (txError) {
          return { data: null, error: txError };
        }

        consumed += 1;
      }

      return { data: { consumed, skipped }, error: null };
    } catch (err) {
      return { data: null, error: err };
    }
  },

  async consumeQCRunItems(params: {
    runId: string;
  }): Promise<{ data: { consumed: number; skipped: number } | null; error: any }> {
    const labId = await database.getCurrentUserLabId();
    if (!labId) return { data: null, error: new Error("No lab_id found") };

    try {
      const { data: run, error: runError } = await supabase
        .from("qc_runs")
        .select("id, qc_results(qc_lot_id)")
        .eq("id", params.runId)
        .single();

      if (runError) return { data: null, error: runError };

      const qcLotIds = Array.from(
        new Set(
          (((run as any)?.qc_results || []) as Array<{ qc_lot_id?: string | null }>)
            .map((row) => row.qc_lot_id)
            .filter(Boolean),
        ),
      ) as string[];

      if (qcLotIds.length === 0) {
        return { data: { consumed: 0, skipped: 0 }, error: null };
      }

      const { data: items, error: itemsError } = await supabase
        .from("inventory_items")
        .select("id, name, current_stock, consumption_per_use, pack_contains, location_id, qc_lot_id")
        .eq("lab_id", labId)
        .eq("is_active", true)
        .eq("consumption_scope", "qc_only")
        .in("qc_lot_id", qcLotIds);

      if (itemsError) return { data: null, error: itemsError };

      let consumed = 0;
      let skipped = 0;

      for (const item of items || []) {
        const sourceRef = `qc_run:${params.runId}:${item.qc_lot_id || item.id}`;
        const { data: existingTx, error: existingError } = await supabase
          .from("inventory_transactions")
          .select("id")
          .eq("lab_id", labId)
          .eq("item_id", item.id)
          .eq("type", "out")
          .contains("ai_input", {
            source: "qc",
            source_ref: sourceRef,
          })
          .limit(1);

        if (existingError) {
          return { data: null, error: existingError };
        }

        if (existingTx && existingTx.length > 0) {
          skipped += 1;
          continue;
        }

        const rawPerUse = Number(item.consumption_per_use || 0);
        const deduction = item.pack_contains && item.pack_contains > 0
          ? rawPerUse / item.pack_contains
          : rawPerUse;

        if (!(deduction > 0)) {
          skipped += 1;
          continue;
        }

        const { error: txError } = await this.createTransaction({
          item_id: item.id,
          type: "out",
          quantity: deduction,
          reason: "Auto-consumed on QC run completion",
          location_id: item.location_id || undefined,
          ai_input: {
            source: "qc",
            scope: "qc_only",
            source_ref: sourceRef,
            qc_run_id: params.runId,
            qc_lot_id: item.qc_lot_id,
          },
        });

        if (txError) {
          return { data: null, error: txError };
        }

        consumed += 1;
      }

      return { data: { consumed, skipped }, error: null };
    } catch (err) {
      return { data: null, error: err };
    }
  },

  // ============================================================================
  // STOCK WARNINGS (for result entry UI)
  // ============================================================================

  async getStockWarningsForTest(testGroupId: string, labId: string): Promise<{
    data:
      | Array<{
        itemId: string;
        itemName: string;
        currentStock: number;
        minStock: number;
        unit: string;
        status: "out_of_stock" | "low_stock";
      }>
      | null;
    error: any;
  }> {
    try {
      const { data, error } = await supabase
        .from("inventory_test_mapping")
        .select(`
          item_id,
          inventory_items!inner (
            id,
            name,
            current_stock,
            min_stock,
            unit,
            is_active
          )
        `)
        .eq("test_group_id", testGroupId)
        .eq("lab_id", labId)
        .eq("is_active", true);

      if (error) return { data: null, error };

      const warnings = (data || [])
        .map((m: any) => {
          const item = m.inventory_items;
          if (!item || !item.is_active) return null;

          if (item.current_stock <= 0) {
            return {
              itemId: item.id,
              itemName: item.name,
              currentStock: item.current_stock,
              minStock: item.min_stock || 0,
              unit: item.unit || "pcs",
              status: "out_of_stock" as const,
            };
          }
          if (item.min_stock > 0 && item.current_stock <= item.min_stock) {
            return {
              itemId: item.id,
              itemName: item.name,
              currentStock: item.current_stock,
              minStock: item.min_stock,
              unit: item.unit || "pcs",
              status: "low_stock" as const,
            };
          }
          return null;
        })
        .filter(Boolean);

      return { data: warnings, error: null };
    } catch (err) {
      return { data: null, error: err };
    }
  },

  // ============================================================================
  // PURCHASE ORDER REQUESTS (Lean, AI-first)
  // ============================================================================

  async getPurchaseOrders(options?: {
    status?: InventoryOrder["status"];
    limit?: number;
  }): Promise<{ data: InventoryOrder[] | null; error: any }> {
    const labId = await database.getCurrentUserLabId();
    if (!labId) return { data: null, error: new Error("No lab_id found") };

    let query = supabase
      .from("inventory_orders")
      .select("*")
      .eq("lab_id", labId)
      .order("created_at", { ascending: false });

    if (options?.status) {
      query = query.eq("status", options.status);
    }

    if (options?.limit) {
      query = query.limit(options.limit);
    }

    const { data, error } = await query;
    return { data: data as InventoryOrder[] | null, error };
  },

  async createPurchaseOrder(input: {
    supplier_id?: string;
    supplier_name?: string;
    items: InventoryOrderItem[];
    tax_amount?: number;
    notes?: string;
    ai_suggested?: boolean;
    request_source?: string;
    status?: InventoryOrder["status"];
  }): Promise<{ data: InventoryOrder | null; error: any }> {
    const labId = await database.getCurrentUserLabId();
    if (!labId) return { data: null, error: new Error("No lab_id found") };

    const appUserId = await database.getCurrentAppUserId();
    let userId: string | null = null;
    if (user?.id) {
      const { data: appUserByAuth } = await supabase
        .from("users")
        .select("id")
        .eq("auth_user_id", user.id)
        .maybeSingle();

      if (appUserByAuth?.id) {
        userId = appUserByAuth.id;
      } else if (user.email) {
        const { data: appUserByEmail } = await supabase
          .from("users")
          .select("id")
          .eq("email", user.email)
          .maybeSingle();
        userId = appUserByEmail?.id || null;
      }
    }

    const cleanItems = (input.items || [])
      .filter((item) => item.name?.trim() && Number(item.quantity) > 0)
      .map((item) => {
        const quantity = Number(item.quantity);
        const unitPrice = Number(item.unit_price || 0);
        return {
          item_id: item.item_id || null,
          name: item.name.trim(),
          quantity,
          unit: item.unit || "pcs",
          unit_price: unitPrice,
          total: quantity * unitPrice,
        };
      });

    if (cleanItems.length === 0) {
      return {
        data: null,
        error: new Error(
          "At least one item is required to create a PO request",
        ),
      };
    }

    const subtotal = cleanItems.reduce(
      (sum, item) => sum + (item.total || 0),
      0,
    );
    const taxAmount = Number(input.tax_amount || 0);
    const totalAmount = subtotal + taxAmount;
    const nowIso = new Date().toISOString();
    const status = input.status || "requested";
    const orderNumber = `PO-${new Date().getFullYear()}-${
      Date.now().toString().slice(-6)
    }`;

    const insertPayload: any = {
      lab_id: labId,
      order_number: orderNumber,
      supplier_id: input.supplier_id || null,
      supplier_name: input.supplier_name || null,
      items: cleanItems,
      subtotal: subtotal,
      tax_amount: taxAmount,
      total_amount: totalAmount,
      status,
      ai_suggested: Boolean(input.ai_suggested),
      request_source: input.request_source ||
        (input.ai_suggested ? "low_stock_reorder" : "manual"),
      notes: input.notes || null,
      created_by: userId,
    };

    if (status === "requested") {
      insertPayload.requested_by = userId;
      insertPayload.requested_at = nowIso;
    }

    const { data, error } = await supabase
      .from("inventory_orders")
      .insert(insertPayload)
      .select("*")
      .single();

    return { data: data as InventoryOrder | null, error };
  },

  async updatePurchaseOrder(
    orderId: string,
    input: {
      supplier_id?: string;
      supplier_name?: string;
      items: InventoryOrderItem[];
      tax_amount?: number;
      notes?: string;
    },
  ): Promise<{ data: InventoryOrder | null; error: any }> {
    const labId = await database.getCurrentUserLabId();
    if (!labId) return { data: null, error: new Error("No lab_id found") };

    const cleanItems = (input.items || [])
      .filter((item) => item.name?.trim() && Number(item.quantity) > 0)
      .map((item) => {
        const quantity = Number(item.quantity);
        const unitPrice = Number(item.unit_price || 0);
        return {
          item_id: item.item_id || null,
          name: item.name.trim(),
          quantity,
          unit: item.unit || "pcs",
          unit_price: unitPrice,
          total: quantity * unitPrice,
        };
      });

    if (cleanItems.length === 0) {
      return {
        data: null,
        error: new Error("At least one item is required in the PO"),
      };
    }

    const subtotal = cleanItems.reduce(
      (sum, item) => sum + (item.total || 0),
      0,
    );
    const taxAmount = Number(input.tax_amount || 0);
    const totalAmount = subtotal + taxAmount;

    const payload: Record<string, any> = {
      supplier_id: input.supplier_id || null,
      supplier_name: input.supplier_name || null,
      items: cleanItems,
      subtotal,
      tax_amount: taxAmount,
      total_amount: totalAmount,
      notes: input.notes || null,
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from("inventory_orders")
      .update(payload)
      .eq("id", orderId)
      .eq("lab_id", labId)
      .select("*")
      .single();

    return { data: data as InventoryOrder | null, error };
  },

  async updatePurchaseOrderStatus(
    orderId: string,
    status: InventoryOrder["status"],
    options?: {
      approvalNote?: string;
      invoiceNumber?: string;
      invoiceDate?: string;
    },
  ): Promise<{ data: InventoryOrder | null; error: any }> {
    const { data: { user } } = await supabase.auth.getUser();
    let userId: string | null = null;
    if (user?.id) {
      const { data: appUserByAuth } = await supabase
        .from("users")
        .select("id")
        .eq("auth_user_id", user.id)
        .maybeSingle();

      if (appUserByAuth?.id) {
        userId = appUserByAuth.id;
      } else if (user.email) {
        const { data: appUserByEmail } = await supabase
          .from("users")
          .select("id")
          .eq("email", user.email)
          .maybeSingle();
        userId = appUserByEmail?.id || null;
      }
    }
    const payload: Record<string, any> = {
      status,
      updated_at: new Date().toISOString(),
    };

    if (status === "approved") {
      payload.approved_by = userId;
      payload.approved_at = new Date().toISOString();
      payload.approval_note = options?.approvalNote || null;
    }

    if (status === "received") {
      payload.received_by = userId;
      payload.received_at = new Date().toISOString();
      payload.invoice_number = options?.invoiceNumber || null;
      payload.invoice_date = options?.invoiceDate || null;
    }

    const { data, error } = await supabase
      .from("inventory_orders")
      .update(payload)
      .eq("id", orderId)
      .select("*")
      .single();

    return { data: data as InventoryOrder | null, error };
  },

  async receivePurchaseOrder(input: {
    order: InventoryOrder;
    invoiceNumber?: string;
    invoiceDate?: string;
    locationId?: string;
  }): Promise<{ data: InventoryOrder | null; error: any }> {
    const labId = await database.getCurrentUserLabId();
    if (!labId) return { data: null, error: new Error("No lab_id found") };

    const orderItems = Array.isArray(input.order.items)
      ? input.order.items
      : [];
    if (orderItems.length === 0) {
      return { data: null, error: new Error("PO has no items to receive") };
    }

    for (const line of orderItems) {
      const quantity = Number(line.quantity || 0);
      if (quantity <= 0) continue;

      let itemId = line.item_id || null;

      if (!itemId) {
        const { data: existing } = await supabase
          .from("inventory_items")
          .select("id")
          .eq("lab_id", labId)
          .ilike("name", line.name)
          .eq("is_active", true)
          .limit(1)
          .maybeSingle();

        itemId = existing?.id || null;
      }

      if (!itemId) {
        const { data: createdItem, error: createErr } = await this.createItem({
          name: line.name,
          unit: line.unit || "pcs",
          type: "consumable",
          current_stock: 0,
          supplier_name: input.order.supplier_name || undefined,
          location_id: input.locationId || null,
        });
        if (createErr) return { data: null, error: createErr };
        itemId = createdItem?.id || null;
      }

      if (!itemId) {
        return {
          data: null,
          error: new Error(`Unable to resolve inventory item for ${line.name}`),
        };
      }

      const { error: txErr } = await this.addStock({
        itemId,
        quantity,
        reason: `PO Received: ${input.order.order_number || input.order.id}`,
        reference: input.invoiceNumber || input.order.order_number || undefined,
        unitPrice: Number(line.unit_price || 0) || undefined,
        supplierName: input.order.supplier_name || undefined,
        locationId: input.locationId,
      });

      if (txErr) return { data: null, error: txErr };
    }

    return this.updatePurchaseOrderStatus(input.order.id, "received", {
      invoiceNumber: input.invoiceNumber,
      invoiceDate: input.invoiceDate,
    });
  },

  // ============================================================================
  // TEST MAPPING
  // ============================================================================

  async getTestMappings(
    testGroupId?: string,
  ): Promise<{ data: InventoryTestMapping[] | null; error: any }> {
    const labId = await database.getCurrentUserLabId();
    if (!labId) return { data: null, error: new Error("No lab_id found") };

    let query = supabase
      .from("inventory_test_mapping")
      .select(`
        *,
        item:inventory_items(id, name, code, unit, current_stock),
        test_group:test_groups(id, name),
        analyte:analytes(id, name)
      `)
      .eq("lab_id", labId)
      .eq("is_active", true);

    if (testGroupId) {
      query = query.eq("test_group_id", testGroupId);
    }

    const { data, error } = await query;
    return { data, error };
  },

  async createTestMapping(mapping: {
    test_group_id?: string;
    analyte_id?: string;
    item_id: string;
    quantity_per_test: number;
    unit?: string;
  }): Promise<{ data: InventoryTestMapping | null; error: any }> {
    const labId = await database.getCurrentUserLabId();
    if (!labId) return { data: null, error: new Error("No lab_id found") };

    const { data: { user } } = await supabase.auth.getUser();

    const { data, error } = await supabase
      .from("inventory_test_mapping")
      .insert({
        ...mapping,
        lab_id: labId,
        created_by: user?.id,
      })
      .select()
      .single();

    return { data, error };
  },

  async deleteTestMapping(mappingId: string): Promise<{ error: any }> {
    const { error } = await supabase
      .from("inventory_test_mapping")
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq("id", mappingId);

    return { error };
  },

  // ============================================================================
  // AI INPUT PARSING (calls edge function)
  // ============================================================================

  async parseAiInput(
    input: string,
    inputType: "voice" | "text" | "ocr" = "text",
  ): Promise<{
    data: any | null;
    error: any;
  }> {
    const labId = await database.getCurrentUserLabId();
    if (!labId) return { data: null, error: new Error("No lab_id found") };

    const { data: { user } } = await supabase.auth.getUser();

    // Get existing items for matching
    const { data: items } = await supabase
      .from("inventory_items")
      .select("id, name, code, unit, current_stock")
      .eq("lab_id", labId)
      .eq("is_active", true);

    const { data, error } = await supabase.functions.invoke(
      "inventory-ai-input",
      {
        body: {
          input,
          inputType,
          labId,
          userId: user?.id,
          existingItems: items || [],
        },
      },
    );

    return { data, error };
  },

  // ============================================================================
  // BULK OPERATIONS (PDF Import)
  // ============================================================================

  async bulkCreateOrUpdateItems(
    items: Array<{
      name: string;
      code?: string;
      type?: string;
      quantity: number;
      unit?: string;
      batch_number?: string;
      expiry_date?: string;
      unit_price?: number;
      supplier_name?: string;
    }>,
    locationId?: string,
  ): Promise<{
    data: { created: number; updated: number; errors: string[] } | null;
    error: any;
  }> {
    const labId = await database.getCurrentUserLabId();
    if (!labId) return { data: null, error: new Error("No lab_id found") };

    const { data: { user } } = await supabase.auth.getUser();

    const results = { created: 0, updated: 0, errors: [] as string[] };

    let resolvedLocationId = locationId;
    if (!resolvedLocationId) {
      const { data: lab } = await supabase
        .from("labs")
        .select("default_processing_location_id")
        .eq("id", labId)
        .single();
      resolvedLocationId = lab?.default_processing_location_id || null;
    }

    for (const item of items) {
      try {
        // Check if item exists (by name or code)
        const { data: existing } = await supabase
          .from("inventory_items")
          .select("id, current_stock")
          .eq("lab_id", labId)
          .or(`name.ilike.${item.name},code.eq.${item.code || ""}`)
          .maybeSingle();

        if (existing) {
          // Create transaction record (trigger updates stock)
          await supabase
            .from("inventory_transactions")
            .insert({
              lab_id: labId,
              item_id: existing.id,
              location_id: null,
              type: "in",
              quantity: item.quantity,
              reason: "PDF Import",
              batch_number: item.batch_number,
              expiry_date: item.expiry_date,
              unit_price: item.unit_price,
              performed_by: appUserId,
            });

          results.updated++;
        } else {
          // Create new item
            const { data: newItem, error: createError } = await supabase
              .from("inventory_items")
              .insert({
              lab_id: labId,
              location_id: resolvedLocationId,
              name: item.name,
              code: item.code,
              type: item.type || "consumable",
              current_stock: 0,
              unit: item.unit || "pcs",
              batch_number: item.batch_number,
              expiry_date: item.expiry_date,
              unit_price: item.unit_price,
              supplier_name: item.supplier_name,
              created_by: appUserId,
            })
            .select()
            .single();

          if (createError) {
            results.errors.push(
              `Failed to create ${item.name}: ${createError.message}`,
            );
          } else {
            // Create initial transaction
            await supabase
              .from("inventory_transactions")
              .insert({
                lab_id: labId,
                item_id: newItem.id,
                location_id: resolvedLocationId,
                type: "in",
                quantity: item.quantity,
                reason: "PDF Import - Initial Stock",
                batch_number: item.batch_number,
                expiry_date: item.expiry_date,
                unit_price: item.unit_price,
                performed_by: appUserId,
              });

            results.created++;
          }
        }
      } catch (err: any) {
        results.errors.push(`Error processing ${item.name}: ${err.message}`);
      }
    }

    return { data: results, error: null };
  },

  // ============================================================================
  // CONSUMPTION SUMMARY
  // ============================================================================

  async getConsumptionSummary(
    days: number = 30,
  ): Promise<{ data: any[] | null; error: any }> {
    const labId = await database.getCurrentUserLabId();
    if (!labId) return { data: null, error: new Error("No lab_id found") };

    const { data, error } = await supabase
      .from("v_inventory_consumption_summary")
      .select("*")
      .eq("lab_id", labId);

    return { data, error };
  },

  // ============================================================================
  // AI CLASSIFICATION & MAPPING
  // ============================================================================

  async getClassificationStats(): Promise<{
    data: {
      pending: number;
      classified: number;
      mapped: number;
      confirmed: number;
      byCategory: {
        qc_control: number;
        test_specific: number;
        general: number;
      };
    } | null;
    error: any;
  }> {
    const labId = await database.getCurrentUserLabId();
    if (!labId) return { data: null, error: new Error("No lab_id found") };

    const { data: items, error } = await supabase
      .from("inventory_items")
      .select("id, ai_classification_status, ai_category")
      .eq("lab_id", labId)
      .eq("is_active", true);

    if (error) return { data: null, error };

    const stats = {
      pending:
        items?.filter((i) =>
          !i.ai_classification_status ||
          i.ai_classification_status === "pending"
        ).length || 0,
      classified:
        items?.filter((i) => i.ai_classification_status === "classified")
          .length || 0,
      mapped:
        items?.filter((i) => i.ai_classification_status === "mapped").length ||
        0,
      confirmed:
        items?.filter((i) => i.ai_classification_status === "confirmed")
          .length || 0,
      byCategory: {
        qc_control:
          items?.filter((i) => i.ai_category === "qc_control").length || 0,
        test_specific:
          items?.filter((i) => i.ai_category === "test_specific").length || 0,
        general: items?.filter((i) => i.ai_category === "general").length || 0,
      },
    };

    return { data: stats, error: null };
  },

  async getPendingClassificationItems(
    limit: number = 50,
  ): Promise<{ data: InventoryItem[] | null; error: any }> {
    const labId = await database.getCurrentUserLabId();
    if (!labId) return { data: null, error: new Error("No lab_id found") };

    const { data, error } = await supabase
      .from("inventory_items")
      .select("*")
      .eq("lab_id", labId)
      .eq("is_active", true)
      .or(
        "ai_classification_status.is.null,ai_classification_status.eq.pending",
      )
      .order("created_at", { ascending: false })
      .limit(limit);

    return { data, error };
  },

  async getClassifiedItems(
    category?: string,
    limit: number = 50,
  ): Promise<{ data: InventoryItem[] | null; error: any }> {
    const labId = await database.getCurrentUserLabId();
    if (!labId) return { data: null, error: new Error("No lab_id found") };

    let query = supabase
      .from("inventory_items")
      .select("*")
      .eq("lab_id", labId)
      .eq("is_active", true)
      .eq("ai_classification_status", "classified")
      .order("ai_classification_confidence", { ascending: false })
      .limit(limit);

    if (category) {
      query = query.eq("ai_category", category);
    }

    const { data, error } = await query;
    return { data, error };
  },

  async getMappingSummaries(
    limit: number = 50,
  ): Promise<{ data: any[] | null; error: any }> {
    const labId = await database.getCurrentUserLabId();
    if (!labId) return { data: null, error: new Error("No lab_id found") };

    const { data, error } = await supabase
      .from("v_inventory_mapping_summary")
      .select("*")
      .eq("lab_id", labId)
      .gt("total_mappings", 0)
      .limit(limit);

    return { data, error };
  },

  async runAIClassification(
    itemIds?: string[],
    batchSize: number = 10,
  ): Promise<{
    data: {
      success: boolean;
      classified: number;
      categories: {
        qc_control: number;
        test_specific: number;
        general: number;
      };
      results: any[];
    } | null;
    error: any;
  }> {
    const labId = await database.getCurrentUserLabId();
    if (!labId) return { data: null, error: new Error("No lab_id found") };

    // Get items to classify
    let items: InventoryItem[] = [];
    if (itemIds && itemIds.length > 0) {
      const { data } = await supabase
        .from("inventory_items")
        .select(
          "id, name, code, type, unit, current_stock, primary_mapping_instruction",
        )
        .eq("lab_id", labId)
        .in("id", itemIds)
        .limit(batchSize);
      items = data || [];
    } else {
      const { data } = await supabase
        .from("inventory_items")
        .select(
          "id, name, code, type, unit, current_stock, primary_mapping_instruction",
        )
        .eq("lab_id", labId)
        .eq("is_active", true)
        .or(
          "ai_classification_status.is.null,ai_classification_status.eq.pending",
        )
        .limit(batchSize);
      items = data || [];
    }

    if (items.length === 0) {
      return {
        data: {
          success: true,
          classified: 0,
          categories: { qc_control: 0, test_specific: 0, general: 0 },
          results: [],
        },
        error: null,
      };
    }

    const { data, error } = await supabase.functions.invoke(
      "inventory-ai-classify",
      {
        body: {
          lab_id: labId,
          items: items.map((i) => ({
            id: i.id,
            name: i.name,
            code: i.code,
            type: i.type,
            unit: i.unit,
            current_stock: i.current_stock,
            primary_mapping_instruction: i.primary_mapping_instruction,
          })),
          batch_size: batchSize,
        },
      },
    );

    return { data, error };
  },

  async runAIMapping(itemIds?: string[], batchSize: number = 10): Promise<{
    data: {
      success: boolean;
      items_processed: number;
      total_mappings_created: number;
      qc_links_created: number;
      results: any[];
    } | null;
    error: any;
  }> {
    const labId = await database.getCurrentUserLabId();
    if (!labId) return { data: null, error: new Error("No lab_id found") };

    const { data, error } = await supabase.functions.invoke(
      "inventory-ai-map",
      {
        body: {
          lab_id: labId,
          item_ids: itemIds,
          batch_size: batchSize,
        },
      },
    );

    return { data, error };
  },

  async updateMappingInstruction(
    itemId: string,
    instruction: string,
  ): Promise<{ error: any }> {
    const { error } = await supabase
      .from("inventory_items")
      .update({
        primary_mapping_instruction: instruction,
        updated_at: new Date().toISOString(),
      })
      .eq("id", itemId);

    return { error };
  },

  async confirmMapping(mappingId: string): Promise<{ error: any }> {
    const { data: { user } } = await supabase.auth.getUser();

    const { error } = await supabase.rpc("fn_inventory_confirm_mapping", {
      p_mapping_id: mappingId,
      p_user_id: user?.id,
    });

    return { error };
  },

  async linkQCLot(itemId: string, qcLotId: string): Promise<{ error: any }> {
    const { error } = await supabase.rpc("fn_inventory_link_qc_lot", {
      p_item_id: itemId,
      p_qc_lot_id: qcLotId,
    });

    return { error };
  },
};

// Add pricing namespaces to database object
Object.assign(database, {
  notificationSettings,
  notificationQueue,
  locationTestPrices,
  locationPackagePrices,
  outsourcedLabPrices,
  accountPackagePrices,
  locationReceivables,
  pricingHelper,
  analytics,
  inventory,
});

// ─── Price Masters API ────────────────────────────────────────────────────────
export const priceMasters = {
  /** List all price master plans for the current lab */
  getAll: async () => {
    const lab_id = await database.getCurrentUserLabId();
    if (!lab_id) return { data: null, error: new Error("No lab_id") };
    const { data, error } = await supabase
      .from("price_masters")
      .select("*")
      .eq("lab_id", lab_id)
      .order("name");
    return { data, error };
  },

  /** Get a single price master by id */
  getById: async (id: string) => {
    const { data, error } = await supabase
      .from("price_masters")
      .select("*")
      .eq("id", id)
      .single();
    return { data, error };
  },

  /** Create a new price master plan */
  create: async (payload: { name: string; description?: string; is_active?: boolean }) => {
    const lab_id = await database.getCurrentUserLabId();
    if (!lab_id) return { data: null, error: new Error("No lab_id") };
    const { data, error } = await supabase
      .from("price_masters")
      .insert([{ ...payload, lab_id }])
      .select()
      .single();
    return { data, error };
  },

  /** Update an existing price master plan */
  update: async (id: string, payload: Partial<{ name: string; description: string; is_active: boolean }>) => {
    const { data, error } = await supabase
      .from("price_masters")
      .update(payload)
      .eq("id", id)
      .select()
      .single();
    return { data, error };
  },

  /** Delete a price master plan (also cascades items) */
  delete: async (id: string) => {
    const { error } = await supabase.from("price_masters").delete().eq("id", id);
    return { error };
  },

  // ── Items (test prices within a plan) ──────────────────────────────────────

  /** Get all test prices for a specific plan, joined with test_group info */
  getItems: async (priceMasterId: string) => {
    const lab_id = await database.getCurrentUserLabId();
    if (!lab_id) return { data: null, error: new Error("No lab_id") };
    const { data, error } = await supabase
      .from("price_master_items")
      .select("*, test_group:test_groups(id, name, code, price)")
      .eq("price_master_id", priceMasterId)
      .eq("lab_id", lab_id)
      .order("test_group(name)");
    return { data, error };
  },

  /** Upsert a test price within a plan */
  upsertItem: async (priceMasterId: string, testGroupId: string, price: number) => {
    const lab_id = await database.getCurrentUserLabId();
    if (!lab_id) return { data: null, error: new Error("No lab_id") };
    const { data, error } = await supabase
      .from("price_master_items")
      .upsert(
        { price_master_id: priceMasterId, test_group_id: testGroupId, lab_id, price, updated_at: new Date().toISOString() },
        { onConflict: "price_master_id,test_group_id" }
      )
      .select()
      .single();
    return { data, error };
  },

  /** Remove a test price from a plan */
  deleteItem: async (itemId: string) => {
    const lab_id = await database.getCurrentUserLabId();
    if (!lab_id) return { error: new Error("No lab_id") };
    const { error } = await supabase.from("price_master_items").delete().eq("id", itemId).eq("lab_id", lab_id);
    return { error };
  },

  /**
   * Resolve the effective price for a test for a given account.
   * Priority: price_master_items → account_prices → test_groups.price
   */
  getEffectivePrice: async (accountId: string, testGroupId: string): Promise<number | null> => {
    // 1. Get the account to find price_master_id
    const { data: account } = await supabase
      .from("accounts")
      .select("price_master_id")
      .eq("id", accountId)
      .single();

    if (account?.price_master_id) {
      const { data: item } = await supabase
        .from("price_master_items")
        .select("price")
        .eq("price_master_id", account.price_master_id)
        .eq("test_group_id", testGroupId)
        .single();
      if (item) return item.price;
    }

    // 2. Fall back to account_prices
    const { data: accountPrice } = await supabase
      .from("account_prices")
      .select("price")
      .eq("account_id", accountId)
      .eq("test_group_id", testGroupId)
      .single();
    if (accountPrice) return accountPrice.price;

    // 3. Fall back to base test price
    const { data: tg } = await supabase
      .from("test_groups")
      .select("price")
      .eq("id", testGroupId)
      .single();
    return tg?.price ?? null;
  },
};

// Attach priceMasters to the database object so callers can use database.priceMasters.*
Object.assign(database, { priceMasters });

/**
 * Format patient age with correct unit abbreviation
 * @param age - The age value
 * @param age_unit - The unit: 'years' | 'months' | 'days' (defaults to 'years')
 * @returns Formatted string like "9y", "6m", "15d"
 */
export const formatAge = (
  age: number | string | null | undefined,
  age_unit?: string | null,
): string => {
  if (age === null || age === undefined || age === "") return "N/A";

  const unitMap: Record<string, string> = {
    years: "y",
    months: "m",
    days: "d",
  };

  const unit = age_unit || "years";
  const abbrev = unitMap[unit] || "y";

  return `${age}${abbrev}`;
};

/**
 * Format patient age with full unit name
 * @param age - The age value
 * @param age_unit - The unit: 'years' | 'months' | 'days' (defaults to 'years')
 * @returns Formatted string like "9 years", "6 months", "15 days"
 */
export const formatAgeFull = (
  age: number | string | null | undefined,
  age_unit?: string | null,
): string => {
  if (age === null || age === undefined || age === "") return "N/A";

  const unit = age_unit || "years";
  const numAge = typeof age === "string" ? parseInt(age, 10) : age;

  // Handle singular/plural
  if (numAge === 1) {
    const singularMap: Record<string, string> = {
      years: "year",
      months: "month",
      days: "day",
    };
    return `${numAge} ${singularMap[unit] || "year"}`;
  }

  return `${age} ${unit}`;
};
