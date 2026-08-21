// ===========================================================
// OrderDetailsModal.tsx
// P0 UX fixes + mobile polish (no DB migration)
// - Auto-close after submit
// - Hide already-submitted analytes from entry UI
// - Block-structured for easier editing
// - (ADDED) Attachments list + order_id on upload
// - (ADDED) v_order_test_progress chips inside modal
// - (ADDED) Submitted values (read-only) per test group
// - (ADDED) Result Audit button/modal
// - (ADDED) Duplicate-safe submit (reuse results row, upsert values)
// ===========================================================

import React, { useState, useEffect, useRef } from "react";
import ReactDOM from "react-dom";
import {
  X,
  Upload,
  Camera,
  FileText,
  Brain,
  Zap,
  CheckCircle,
  AlertTriangle,
  Layers,
  TestTube2,
  QrCode,
  Calendar,
  Clock,
  ArrowRight,
  Printer,
  ImageIcon,
  FileText as FileIcon,
	  Eye,
	  EyeOff,
  Trash2,
  Maximize2,
  ExternalLink,
  Download,
  Lock,
  Unlock,
  Crop,
  Mic,
  Link2,
} from "lucide-react";
import QRCodeLib from "qrcode";
import { database, attachments as attachmentsAPI, supabase, uploadFile } from "../../utils/supabase";
import { selectPreferredCalculatedDependencies } from "../../utils/calculatedDependencies";
import { evaluateTextCalculation, normalizeCalculationResultType } from "../../utils/calculationRules";
import { applyAnalyteDisplayOrder } from "../../utils/analyteDisplayOrder";
import { useAuth } from "../../contexts/AuthContext";
import { useOrderStatusCentral } from "../../hooks/useOrderStatusCentral";
import QuickStatusButtons from "../Orders/QuickStatusButtons";
import MultiImageUploader from "../Upload/MultiImageUploader";
import BatchImageViewer from "../Upload/BatchImageViewer";
import SingleImageViewer from "../Upload/SingleImageViewer";
import { ImageCropper } from "../Upload/ImageCropper";
import PopoutInput from "./PopoutInput";
import PhlebotomistSelector from "../Users/PhlebotomistSelector";
import { OrderStatusDisplay } from "./OrderStatusDisplay";
import { capturePhoto, isNative } from "../../utils/androidFileUpload";
import { calculateFlagsForResults, calculateFlag } from "../../utils/flagCalculation";
import SectionEditor from "../Results/SectionEditor";
import VoiceRecorder from "../Voice/VoiceRecorder";
import InlineDependencyEditor from "../Results/InlineDependencyEditor";
import {
  applyAnalyteInterfaceConversion,
  getAnalyteInterfaceConfig,
  isAnalyteInterfaceConversionEnabled,
  type AnalyteInterfaceConversionConfig,
} from "../../utils/analyteInterfaceConversion";
import { normalizeResultFlagForSave } from "../../utils/referenceRangeService";
import {
  contextForGroup,
  fetchPatientRangeInfo,
  fetchRangeRules,
  rangeAuditColumns,
  resolveForAnalyte,
  type PatientRangeInfo,
  type RangeRuleMap,
} from "../../utils/referenceRangeLoader";

interface WorkflowStep {
  name: string;
  description: string;
  completed?: boolean;
  current?: boolean;
  timestamp?: string;
}

interface NextStep {
  action: string;
  description: string;
  urgent?: boolean;
  priority?: "low" | "medium" | "high";
  assignedTo?: string;
  deadline?: string;
}

interface StatusAction {
  status: string;
  label: string;
  primary?: boolean;
}

const hasMeaningfulTextValue = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

interface ExtractedValue {
  parameter: string;
  value: string;
  unit: string;
  reference: string;
  reference_locked?: boolean;
  flag?: string;
  analyte_id?: string | null;
  lab_analyte_id?: string | null;
  is_calculated?: boolean;
  expected_normal_values?: string[];
  expected_value_flag_map?: Record<string, string>;
  expected_value_codes?: Record<string, string>;
  value_type?: string;
  default_value?: string;
  formula?: string | null;
  formula_variables?: string[] | string | null;
  calculation_result_type?: string | null;
  verify_note?: string; // Re-run request note from verifier
  is_rerun?: boolean; // Indicates this is a re-run request
	  ai_color_observation?: string; // Color strip: observed pad color + reason for selected value
	  is_hidden_from_report?: boolean;
	  hidden_reason?: string;
  interface_config?: AnalyteInterfaceConversionConfig | null;
  interface_conversion_pending?: boolean;
}

interface Order {
  id: string;
  patient_name: string;
  patient_id: string;
  tests: string[];
  status: string;
  priority: string;
  order_date: string;
  expected_date: string;
  total_amount: number;
  final_amount?: number;
  collection_charge?: number | null;
  doctor: string | null;
  lab_id: string;
  sample_id?: string;
  color_code?: string;
  color_name?: string;
  qr_code_data?: string;
  sample_collected_at?: string;
  sample_collected_by?: string;
}

interface OrderDetailsModalProps {
  order: Order;
  onClose: () => void;
  onUpdateStatus?: (orderId: string, newStatus: string) => void;
  onSubmitResults?: (orderId: string, resultsData: ExtractedValue[]) => void;
  onAfterSubmit?: () => void | Promise<void>;
  onAfterSaveDraft?: () => void | Promise<void>;
  initialTab?: "details" | "results";
}

interface TestGroupResult {
  test_group_id: string;
  test_group_name: string;
  is_section_only?: boolean;
  group_level_prompt?: string | null;
  default_ai_processing_type?: string | null;
  ref_range_ai_config?: { enabled?: boolean; consider_age?: boolean } | null;
  order_test_group_id?: string | null;
  order_test_id?: string | null;
  source?: "order_test_groups" | "order_tests";
  analytes: {
    id: string;
    lab_analyte_id?: string | null;
    name: string;
    code: string;
    units?: string;
    reference_range?: string;
    normal_range_min?: number;
    normal_range_max?: number;
    is_calculated?: boolean;
    formula?: string | null;
    formula_variables?: string[] | string | null;
    calculation_result_type?: string | null;
	      existing_result?: {
	        id: string;
	        value: string;
	        status: string;
	        unit?: string;
	        reference_range?: string;
	        verified_at?: string;
	        flag?: string;
	        verify_note?: string;
	        is_hidden_from_report?: boolean;
	        hidden_reason?: string;
	      } | null;
  }[];
}

// ===========================================================
// #endregion Types
// ===========================================================

// ===========================================================
// #region Helpers (workflow/steps/status labels)
// ===========================================================

const getWorkflowSteps = (currentStatus: string, order?: any): WorkflowStep[] => {
  const allSteps = [
    { name: "Order Created", description: "Order placed and confirmed" },
    { name: "Sample Collection", description: "Collect sample from patient" },
    { name: "In Progress", description: "Laboratory analysis in progress" },
    { name: "Pending Approval", description: "Results awaiting approval" },
    { name: "Completed", description: "Results approved and ready" },
    { name: "Delivered", description: "Results delivered to patient" },
  ];

  // Map current status to workflow position
  const getStatusIndex = (status: string, hasSample: boolean) => {
    if (status === 'Pending Collection' || status === 'Order Created') return hasSample ? 2 : 1;
    if (status === 'In Progress') return 2;
    if (status === 'Pending Approval') return 3;
    if (status === 'Report Ready' || status === 'Completed') return 4;
    if (status === 'Delivered') return 5;
    return 0;
  };

  const hasSampleCollected = !!order?.sample_collected_at;
  const currentIndex = getStatusIndex(currentStatus, hasSampleCollected);

  return allSteps.map((step, index) => {
    let completed = index < currentIndex;
    let current = index === currentIndex;

    // Sample Collection step logic
    if (step.name === "Sample Collection") {
      if (hasSampleCollected) {
        completed = true;
        current = false;
      } else if (currentStatus === "Pending Collection" || currentStatus === "Order Created") {
        completed = false;
        current = true;
      } else {
        completed = false;
        current = false;
      }
    }

    let timestamp: string | undefined;
    if (completed || current) {
      if (step.name === "Order Created") {
        timestamp = order?.order_date;
      } else if (step.name === "Sample Collection" && order?.sample_collected_at) {
        timestamp = order.sample_collected_at;
      }
    }

    return { ...step, completed, current, timestamp };
  });
};

const getNextSteps = (currentStatus: string, order: any): NextStep[] => {
  // Normalize status - handle both old and new status names
  const hasSample = !!order?.sample_collected_at;

  switch (currentStatus) {
    case "Order Created":
    case "Pending Collection":
      return [
        {
          action: "Collect Sample",
          description: `Collect ${order.color_name || "assigned"} tube sample from patient ${order.patient_name}`,
          urgent: true,
          priority: "high",
          assignedTo: "Sample Collection Team",
          deadline: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
        },
      ];
    case "Sample Collection":
      // Legacy status - redirect to proper handling
      if (hasSample) {
        return [
          {
            action: "Complete Testing",
            description: "Finish all laboratory tests and enter results",
            priority: "medium",
            assignedTo: "Lab Technicians",
          },
          {
            action: "Enter Results",
            description: "Input test results into the system",
            priority: "high",
            assignedTo: "Data Entry Team",
          },
        ];
      }
      return [
        {
          action: "Begin Laboratory Analysis",
          description: "Process sample and begin testing procedures",
          priority: "high",
          assignedTo: "Laboratory Team",
          deadline: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        },
      ];
    case "In Progress":
      return [
        {
          action: "Complete Testing",
          description: "Finish all laboratory tests and enter results",
          priority: "medium",
          assignedTo: "Lab Technicians",
        },
        {
          action: "Enter Results",
          description: "Input test results into the system",
          priority: "high",
          assignedTo: "Data Entry Team",
        },
      ];
    case "Pending Approval":
      return [
        {
          action: "Review & Approve Results",
          description: "Medical review and approval of test results",
          urgent: true,
          priority: "high",
          assignedTo: "Medical Officer",
          deadline: order.expected_date,
        },
      ];
    case "Report Ready":
    case "Completed":
      return [
        {
          action: "Deliver Results",
          description: "Send results to patient via preferred method",
          priority: "medium",
          assignedTo: "Patient Services",
        },
      ];
    case "Delivered":
      return [
        {
          action: "Follow Up",
          description: "Follow up with patient if needed",
          priority: "low",
          assignedTo: "Patient Care Team",
        },
      ];
    default:
      return [];
  }
};

// Delete a single attachment (from batch thumbnail outside viewer)
const handleDeleteAttachment = async (attachmentId: string) => {
  if (!confirm('Are you sure you want to delete this image?')) return;
  try {
    const { data: att, error: fetchError } = await supabase
      .from('attachments')
      .select('file_path')
      .eq('id', attachmentId)
      .single();
    if (fetchError) throw fetchError;

    if (att?.file_path) {
      const { error: storageError } = await supabase.storage
        .from('attachments')
        .remove([att.file_path]);
      if (storageError) console.warn('Storage delete error:', storageError);
    }

    const { error: deleteError } = await supabase
      .from('attachments')
      .delete()
      .eq('id', attachmentId);
    if (deleteError) throw deleteError;

    // Refresh lists
    fetchUploadBatches();
    fetchAttachmentsForOrder();

  } catch (error) {
    console.error('Error deleting attachment:', error);
    alert('Failed to delete image');
  }
};

const getAvailableStatusActions = (
  currentStatus: string,
  _order?: any
): StatusAction[] => {
  switch (currentStatus) {
    case "Order Created":
      return [{ status: "Sample Collection", label: "Mark Sample Collected", primary: true }];
    case "Sample Collection":
      return [{ status: "In Progress", label: "Start Processing", primary: true }];
    case "In Progress":
      return [{ status: "Pending Approval", label: "Submit for Approval", primary: true }];
    case "Pending Approval":
      return [
        { status: "Completed", label: "Approve Results", primary: true },
        { status: "In Progress", label: "Return for Revision" },
      ];
    case "Completed":
      return [{ status: "Delivered", label: "Mark as Delivered", primary: true }];
    default:
      return [];
  }
};

// Parse formula variables from string or array format
const parseFormulaVariables = (formulaVariables: string[] | string | null | undefined): string[] => {
  if (!formulaVariables) return [];
  if (Array.isArray(formulaVariables)) return formulaVariables.filter(Boolean);
  try {
    const parsed = JSON.parse(formulaVariables);
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
};

// ===========================================================
// #endregion Helpers
// ===========================================================

const OrderDetailsModal: React.FC<OrderDetailsModalProps> = ({
  order,
  onClose,
  onUpdateStatus,
  onSubmitResults,
  onAfterSubmit,
  onAfterSaveDraft,
  initialTab,
}) => {
  // =========================================================
  // #region State
  // =========================================================
  const { user } = useAuth();

  const [activeTab, setActiveTab] = useState<"details" | "results">(initialTab ?? "details");

  // Multi-Image Upload / AI
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [attachmentId, setAttachmentId] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isOCRProcessing, setIsOCRProcessing] = useState(false);
  const [ocrResults, setOcrResults] = useState<any>(null);
  const [ocrError, setOcrError] = useState<string | null>(null);

  // Multi-image batch support
  const [showMultiUpload, setShowMultiUpload] = useState(false);
  const [uploadBatches, setUploadBatches] = useState<any[]>([]);
  const [selectedBatch, setSelectedBatch] = useState<any | null>(null);
  const [showBatchViewer, setShowBatchViewer] = useState(false);
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null);
  const [showImageViewer, setShowImageViewer] = useState(false);

  // AI analysis for multi-image
  const [selectedBatchForAI, setSelectedBatchForAI] = useState<any | null>(null);
  const [multiImageAIInstructions, setMultiImageAIInstructions] = useState<string>('');
  const [availableImagesForAI, setAvailableImagesForAI] = useState<any[]>([]);
  // Selected images for AI analysis (allows user to choose which images to process)
  const [selectedImagesForAI, setSelectedImagesForAI] = useState<Set<string>>(new Set());

  // Test-level attachment support
  const [uploadScope, setUploadScope] = useState<'order' | 'test'>('order');
  const [selectedTestId, setSelectedTestId] = useState<string>('');
  const [enableOptimization, setEnableOptimization] = useState<boolean>(true);
  const [optimizationProgress, setOptimizationProgress] = useState<{
    progress: number;
    fileName: string;
  } | null>(null);

  // Crop State
  const [cropTargetId, setCropTargetId] = useState<string | null>(null);

  const handleImageCrop = async (croppedFile: File) => {
    if (!cropTargetId) return;

    try {
      const attachment = attachments.find(a => a.id === cropTargetId);
      if (!attachment) {
        alert('Attachment not found');
        return;
      }

      const filePath = attachment.file_path;

      if (!filePath) {
        alert('File path not found for this attachment');
        return;
      }

      console.log('Uploading cropped file:', { filePath, size: croppedFile.size, type: croppedFile.type });

      const { data, error } = await supabase.storage
        .from('attachments')
        .upload(filePath, croppedFile, {
          upsert: true,
          contentType: croppedFile.type,
          cacheControl: '0'
        });

      if (error) {
        console.error('Supabase storage error:', error);
        throw error;
      }

      console.log('Upload successful:', data);

      // Force refresh of the image by updating the local state with a cache buster
      setAttachments(prev => prev.map(a => {
        if (a.id === cropTargetId) {
          const newUrl = a.file_url.includes('?') ? a.file_url + `&t=${Date.now()}` : a.file_url + `?t=${Date.now()}`;
          return {
            ...a,
            resolved_file_url: newUrl,
            file_size: croppedFile.size,
          };
        }
        return a;
      }));

      // Find if this image is in availableImagesForAI and update it too
      setAvailableImagesForAI(prev => prev.map(a => {
        if (a.id === cropTargetId) {
          return {
            ...a,
            file_size: croppedFile.size
          }
        }
        return a;
      }));

      alert('Image cropped successfully!');

    } catch (error: any) {
      console.error('Error cropping image:', error);
      alert(`Failed to save cropped image: ${error?.message || error?.toString() || 'Unknown error'}`);
    } finally {
      setCropTargetId(null);
    }
  };



  // --- AI console state ---
  type AiStep = {
    id: string;
    label: string;
    status: "todo" | "doing" | "done" | "error";
    detail?: string;
    ts?: string;
  };

  const [aiPhase, setAiPhase] = useState<"idle" | "running" | "done" | "error">("idle");
  const [aiSteps, setAiSteps] = useState<AiStep[]>([]);
  const [aiProgress, setAiProgress] = useState(0);
  const [aiMatchedCount, setAiMatchedCount] = useState(0);
  const aiLogRef = React.useRef<HTMLDivElement>(null);

  // Centralized status updater (for quick buttons and collection actions)
  const { markSampleCollected: markCollectedCentral } = useOrderStatusCentral();
  const [updatingCollection, setUpdatingCollection] = useState(false);
  const [selectedPhlebotomistId, setSelectedPhlebotomistId] = useState<string>('');
  const [selectedPhlebotomistName, setSelectedPhlebotomistName] = useState<string>('');
  const [showPhlebotomistSelector, setShowPhlebotomistSelector] = useState(false);

  const handleMarkSampleCollected = async () => {
    // If no phlebotomist selected, show selector first
    if (!order.sample_collected_at && !showPhlebotomistSelector) {
      setShowPhlebotomistSelector(true);
      return;
    }

    try {
      setUpdatingCollection(true);
      const { error } = await database.orders.markSampleCollected(
        order.id,
        selectedPhlebotomistName || undefined,
        selectedPhlebotomistId || undefined
      );
      if (error) {
        alert('Failed to mark sample collected');
        return;
      }
      await database.orders.checkAndUpdateStatus(order.id);
      if (onUpdateStatus) await onUpdateStatus(order.id, "Sample Collection");
      setShowPhlebotomistSelector(false);
    } catch (e) {
      console.error("Error marking sample collected:", e);
      alert("Failed to mark sample collected");
    } finally {
      setUpdatingCollection(false);
    }
  };

  const handleMarkSampleNotCollected = async () => {
    try {
      setUpdatingCollection(true);
      const { error } = await database.orders.markSampleNotCollected(order.id);
      if (error) {
        console.error("Error marking not collected:", error);
        alert("Failed to mark as not collected");
        return;
      }
      if (onUpdateStatus) await onUpdateStatus(order.id, "Pending Collection");
    } catch (e) {
      console.error("Error marking sample not collected:", e);
      alert("Failed to mark sample not collected");
    } finally {
      setUpdatingCollection(false);
    }
  };

  React.useEffect(() => {
    if (aiPhase === "running" && aiLogRef.current) {
      aiLogRef.current.scrollTop = aiLogRef.current.scrollHeight;
    }
  }, [aiSteps, aiPhase]);

  const aiStart = () => {
    setAiPhase("running");
    setAiProgress(4);
    setAiMatchedCount(0);
    setAiSteps([
      { id: "prep", label: "Preparing runtime", status: "doing", ts: new Date().toISOString() },
      { id: "attach", label: "Validating uploaded attachment", status: "todo" },
      { id: "vision", label: "Extracting text (Vision OCR)", status: "todo" },
      { id: "nlp", label: "Parsing & normalizing (Gemini)", status: "todo" },
      { id: "match", label: "Matching to analytes catalog", status: "todo" },
      { id: "fill", label: "Autofilling result grid", status: "todo" },
      { id: "final", label: "Finalizing", status: "todo" },
    ]);
  };

  const aiMark = (id: string, patch: Partial<AiStep>, bump = 12) => {
    setAiSteps(prev => prev.map(s => s.id === id ? { ...s, ...patch, ts: new Date().toISOString() } : s));
    setAiProgress(p => Math.min(100, p + bump));
  };

  const aiFail = (id: string, message: string) => {
    aiMark(id, { status: "error", detail: message }, 0);
    setAiPhase("error");
  };

  // Result entry
  const [extractedValues, setExtractedValues] = useState<ExtractedValue[]>([]);
  const [manualValues, setManualValues] = useState<ExtractedValue[]>([]);
  const [existingResultId, setExistingResultId] = useState<string | null>(null);

  // Popout input state
  const [popoutInput, setPopoutInput] = useState<{
    isOpen: boolean;
    field: { index: number; fieldName: keyof ExtractedValue };
    title: string;
    placeholder: string;
    suggestions?: string[];
  } | null>(null);

  // Catalog & order analytes/test-groups
  const [orderAnalytes, setOrderAnalytes] = useState<any[]>([]);
  const [testGroups, setTestGroups] = useState<TestGroupResult[]>([]);
  // Deterministic (non-AI) reference range rules keyed by lab_analyte_id, and
  // the patient facts they match against.
  const [rangeRules, setRangeRules] = useState<RangeRuleMap>(new Map());
  const [patientRangeInfo, setPatientRangeInfo] = useState<PatientRangeInfo | null>(null);

  /**
   * Audit columns describing how the range on a saved row was decided.
   *
   * A range the AI resolver supplied is recorded as such; otherwise a value that
   * no longer matches the analyte's resolved range means a human typed over it.
   */
  const rangeAuditFor = (row: any, analyte: any) => {
    if (row?.range_source === "ai") {
      return { range_rule_id: null, range_source: "ai", applied_range_rule: row.applied_range_rule || null };
    }
    const edited = (row?.reference || "") !== (analyte?.reference_range || "");
    return rangeAuditColumns(analyte, { edited });
  };
  const [selectedTestGroup, setSelectedTestGroup] = useState<string>();

  // Get all available order tests for test selection
  const availableOrderTests = React.useMemo(() => {
    return testGroups
      .filter(tg => tg.order_test_id)
      .map(tg => ({
        id: tg.order_test_id!,
        name: tg.test_group_name
      }));
  }, [testGroups]);

  // AI helpers
  const [selectedAnalyteForAI, setSelectedAnalyteForAI] = useState<any | null>(null);
  const [aiProcessingConfig, setAiProcessingConfig] = useState<{ type: string; prompt?: string } | null>(null);

  // Modal scroll preservation
  const modalScrollRef = useRef<HTMLDivElement>(null);

  // UX states
  const [savingDraft, setSavingDraft] = useState(false);
  const [submittingResults, setSubmittingResults] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [activeEntryMode, setActiveEntryMode] = useState<"manual" | "ai">("manual");

  // Voice Input
  const [showVoiceInput, setShowVoiceInput] = useState(false);
  const [voiceAnalyzing, setVoiceAnalyzing] = useState(false);
  const [voiceTranscript, setVoiceTranscript] = useState<string>("");

  // QR
  const [qrCodeImage, setQrCodeImage] = useState<string>("");

  // attachments
  const [attachments, setAttachments] = React.useState<any[]>([]);
  const [activeAttachment, setActiveAttachment] = React.useState<any | null>(null);
  const [progressRows, setProgressRows] = useState<any[]>([]);
  const [readonlyByTG, setReadonlyByTG] = useState<Record<string, any[]>>({});
  const [resultIdByTG, setResultIdByTG] = useState<Record<string, string>>({});
  const [calcDeps, setCalcDeps] = useState<{ calculated_analyte_id: string; calculated_lab_analyte_id?: string | null; source_analyte_id: string; source_lab_analyte_id?: string | null; variable_name: string }[]>([]);

  const getPreferredDepsForCalculated = React.useCallback((
    deps: { calculated_analyte_id: string; calculated_lab_analyte_id?: string | null; source_analyte_id: string; source_lab_analyte_id?: string | null; variable_name: string }[],
    analyteId?: string | null,
    labAnalyteId?: string | null,
    availableSourceIds?: ReadonlySet<string>,
  ) => {
    return selectPreferredCalculatedDependencies(
      deps,
      analyteId,
      labAnalyteId,
      availableSourceIds,
    );
  }, []);

  // Inline dependency editor state
  const [editingDependency, setEditingDependency] = useState<{
    value: ExtractedValue;
    missingVariables: string[];
  } | null>(null);

  // =========================================================
  // #endregion State
  // =========================================================

  // =========================================================
  // #region Effects (init + QR + analytes/results load)
  // =========================================================

  // Generate QR code when qr data changes
  React.useEffect(() => {
    if (order.qr_code_data) {
      generateQRCodeDataURL(order.qr_code_data).then(setQrCodeImage);
    }
  }, [order.qr_code_data]);

  React.useEffect(() => {
    supabase
      .from("attachments")
      .select("id,file_url,file_path,file_type,original_filename,file_size,upload_timestamp,batch_id,batch_sequence,image_label,imagekit_url,processed_url,variants,processing_status,image_processed_at,image_processing_error")
      .or(`order_id.eq.${order.id},and(related_table.eq.orders,related_id.eq.${order.id})`)
      .order("upload_timestamp", { ascending: false })
      .then(({ data }) => {
        const resolvedData = (data || []).map((attachment: any) => ({
          ...attachment,
          resolved_file_url: attachment.imagekit_url || attachment.processed_url || attachment.file_url,
        }));

        setAttachments(resolvedData);

        // Set active attachment and enable AI if images exist
        if (!activeAttachment && resolvedData.length) {
          setActiveAttachment(resolvedData[0]);
          setAttachmentId(resolvedData[0].id);
        }

        updateAiStateFromAttachments(resolvedData, { preferActiveAttachment: true });
      });
  }, [order.id]);

  // First-load data
  React.useEffect(() => {
    fetchOrderAnalytes();
    fetchProgressView();
    fetchReadonlyResults();
    fetchUploadBatches();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When order analytes are ready, seed manual values (only those WITHOUT existing results)
  React.useEffect(() => {
    if (orderAnalytes.length > 0) {
      console.log('📋 Initializing manualValues from orderAnalytes:', orderAnalytes);
      // Show analytes that either:
      // 1. Don't have an existing result, OR
      // 2. Have a re-run request (verify_note contains "RE-RUN")
      // Note: verify_status="pending" alone is NOT enough - that's the default for unverified results
      const hasRerunRequest = (result: any) =>
        result?.verify_note && result.verify_note.toUpperCase().includes("RE-RUN");

      const hasExistingValue = (result: any) =>
        hasMeaningfulTextValue(result?.value);

      const seed = orderAnalytes
        .filter((a: any) =>
          !a.existing_result ||
          !hasExistingValue(a.existing_result) ||
          hasRerunRequest(a.existing_result)
        )
        .map((analyte: any) => {
          const existingResult = analyte.existing_result;
          const isRerun = hasRerunRequest(existingResult);
            return {
              analyte_id: analyte.id,
              lab_analyte_id: (analyte as any).lab_analyte_id || null,
              parameter: analyte.name,
            // Pre-fill with existing value for re-run requests so technician can see previous value
            value: isRerun && existingResult ? existingResult.value || "" : "",
            unit: analyte.unit || existingResult?.unit || "",
            reference: analyte.reference_range || existingResult?.reference_range || "",
            flag: isRerun && existingResult ? existingResult.flag : undefined,
            is_calculated: !!analyte.is_calculated,
            formula: analyte.formula ?? null,
            formula_variables: analyte.formula_variables ?? null,
            // Carried on the row so live recalculation knows to run text rules
            // instead of feeding the JSON rule list to the numeric evaluator.
            calculation_result_type: analyte.calculation_result_type ?? null,
            expected_normal_values: analyte.expected_normal_values || [],
            expected_value_flag_map: analyte.expected_value_flag_map || {},
            expected_value_codes: analyte.expected_value_codes || {},
            value_type: analyte.value_type || undefined,
	            verify_note: isRerun && existingResult?.verify_note ? existingResult.verify_note : undefined,
	            is_rerun: isRerun,
	            is_hidden_from_report: !!existingResult?.is_hidden_from_report,
	            hidden_reason: existingResult?.hidden_reason || "",
              interface_config: analyte.interface_config || null,
              interface_conversion_pending: false,
	          };
        });
      console.log('📋 Seeded manualValues:', seed);
      setManualValues(seed);
      fetchExistingResult();
    }
  }, [orderAnalytes]);

  // =========================================================
  // #endregion Effects
  // =========================================================

  // =========================================================
  // #region QR helpers
  // =========================================================

  const generateQRCodeDataURL = async (data: string): Promise<string> => {
    try {
      return await QRCodeLib.toDataURL(data, {
        width: 200,
        margin: 2,
        color: { dark: "#000000", light: "#FFFFFF" },
      });
    } catch {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      canvas.width = 200;
      canvas.height = 200;
      if (ctx) {
        ctx.fillStyle = "#000000";
        ctx.fillRect(0, 0, 200, 200);
        ctx.fillStyle = "#ffffff";
        for (let i = 0; i < 20; i++)
          for (let j = 0; j < 20; j++)
            if ((i + j) % 3 === 0 || i === j) ctx.fillRect(i * 10, j * 10, 10, 10);
      }
      return canvas.toDataURL("image/png");
    }
  };

  const handlePrintQRCode = async () => {
    if (!order.qr_code_data) return;
    const printWindow = window.open("", "_blank");
    if (!printWindow) return;
    const qrCodeImageForPrint = await generateQRCodeDataURL(order.qr_code_data);
    printWindow.document.write(`
      <!DOCTYPE html><html><head><title>Sample QR Code - ${order.sample_id || ""}</title>
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <style>
        body{font-family:Arial,sans-serif;margin:20px;text-align:center}
        .qr-container{border:2px solid #000;padding:20px;display:inline-block;margin:20px;max-width:92vw}
        .qr-code{width:200px;height:200px;margin:10px auto;border:1px solid #ccc}
        .sample-info{margin-top:20px;text-align:left}
        .sample-info div{margin:5px 0;word-break:break-word}
        .color-indicator{width:30px;height:30px;border-radius:50%;display:inline-block;margin-right:10px;vertical-align:middle;border:2px solid #333}
        @media print{body{margin:0}}
      </style></head><body>
        <div class="qr-container">
          <h2>Sample Tracking Label</h2>
          <img src="${qrCodeImageForPrint}" alt="QR Code" class="qr-code" />
          <div class="sample-info">
            <div><strong>Sample ID:</strong> ${order.sample_id || "N/A"}</div>
            <div><strong>Patient:</strong> ${order.patient_name}</div>
            <div><strong>Order ID:</strong> ${order.id}</div>
            <div><strong>Sample Tube:</strong> <span class="color-indicator" style="background-color:${order.color_code}"></span>${order.color_name || ""}</div>
            <div><strong>Order Date:</strong> ${new Date(order.order_date).toLocaleDateString()}</div>
            <div><strong>Tests:</strong> ${order.tests.join(", ")}</div>
            ${(() => {
        const orderTests = (order as any).order_tests || [];
        const outsourcedTests = orderTests.filter((ot: any) => ot.outsourced_lab_id);
        if (outsourcedTests.length > 0) {
          return `<div style="color: #ea580c; font-weight: bold; margin-top: 5px;">⚠️ ${outsourcedTests.length} test(s) outsourced</div>`;
        }
        return '';
      })()}
          </div>
        </div>
        <script>window.onload=()=>{window.print();window.onafterprint=()=>window.close();}</script>
      </body></html>`);
    printWindow.document.close();
  };

  // =========================================================
  // #endregion QR helpers
  // =========================================================

  // =========================================================
  // #region Data fetchers
  // =========================================================

  const fetchOrderAnalytes = async () => {
    try {
      const { data: orderData, error: orderError } = await database.orders.getById(order.id);
      if (orderError || !orderData) return;

      // Pull order + test-groups + existing results
      const { data, error } = await supabase
        .from("orders")
        .select(
          `
          id,
          lab_id,
          patient_id,
          patient_name,
          order_test_groups(
            id,
            test_group_id,
            test_name,
            price,
            sample_condition,
            test_groups(
              id,
              name,
              code,
              is_section_only,
              group_level_prompt,
              default_ai_processing_type,
              ref_range_ai_config,
              lab_id,
              test_group_analytes(
                analyte_id,
                lab_analyte_id,
                sort_order,
                display_order,
                section_heading,
                analytes(
                  id,
                  name,
                  code,
                  unit,
                  reference_range,
                  ai_processing_type,
                  ai_prompt_override,
                  expected_normal_values,
                  expected_value_flag_map,
                  is_calculated,
                  formula,
                  formula_variables,
                  calculation_result_type
                ),
                lab_analytes(
                  id,
                  name,
                  code,
                  unit,
                  reference_range,
                  lab_specific_reference_range,
                  reference_range_male,
                  reference_range_female,
                  low_critical,
                  high_critical,
                  expected_normal_values,
                  expected_value_flag_map,
                  expected_value_codes,
                  value_type,
                  default_value,
                  method,
                  is_calculated,
                  formula,
                  formula_variables,
                  formula_description,
                  calculation_result_type,
                  lab_analyte_interface_config(
                    multiply_by,
                    add_offset,
                    decimal_places,
                    lims_unit,
                    apply_to_ai_result_entry,
                    apply_to_manual_result_entry,
                    apply_to_quick_result_entry
                  )
                )
              )
            )
          ),
          order_tests(
            id,
            test_name,
            test_group_id,
            sample_id,
            sample_condition,
            is_canceled,
            outsourced_lab_id,
            test_groups(
              id,
              name,
              code,
              is_section_only,
              group_level_prompt,
              default_ai_processing_type,
              ref_range_ai_config,
              lab_id,
              test_group_analytes(
                analyte_id,
                lab_analyte_id,
                sort_order,
                display_order,
                section_heading,
                analytes(
                  id,
                  name,
                  code,
                  unit,
                  reference_range,
                  ai_processing_type,
                  ai_prompt_override,
                  expected_normal_values,
                  expected_value_flag_map,
                  is_calculated,
                  formula,
                  formula_variables,
                  calculation_result_type
                ),
                lab_analytes(
                  id,
                  name,
                  code,
                  unit,
                  reference_range,
                  lab_specific_reference_range,
                  reference_range_male,
                  reference_range_female,
                  low_critical,
                  high_critical,
                  expected_normal_values,
                  expected_value_flag_map,
                  expected_value_codes,
                  value_type,
                  default_value,
                  method,
                  is_calculated,
                  formula,
                  formula_variables,
                  formula_description,
                  calculation_result_type,
                  lab_analyte_interface_config(
                    multiply_by,
                    add_offset,
                    decimal_places,
                    lims_unit,
                    apply_to_ai_result_entry,
                    apply_to_manual_result_entry,
                    apply_to_quick_result_entry
                  )
                )
              )
            )
          ),
          results(
            id,
            order_id,
            test_name,
            status,
            verified_at,
            verified_by,
            created_at,
            order_test_group_id,
            order_test_id,
            test_group_id,
            lab_id,
            result_values(
              id,
              analyte_name,
              value,
              unit,
              reference_range,
              flag,
              analyte_id,
	              order_test_group_id,
	              order_test_id,
	              verify_status,
	              verify_note,
	              is_hidden_from_report,
	              hidden_reason
	            )
          )
        `
        )
        .eq("id", order.id)
        .single();
      if (error) throw error;

      // Deterministic (non-AI) reference range rules. Loaded before the analyte
      // mapping below so every downstream consumer of analyte.reference_range —
      // manual entry seed, AI extraction merge, save payload — sees the range
      // that actually applies to this patient and this sample condition.
      const allLabAnalyteIdsForRanges: string[] = [
        ...(data.order_test_groups || []),
        ...(data.order_tests || []),
      ].flatMap((row: any) =>
        (row.test_groups?.test_group_analytes || []).map((tga: any) => tga.lab_analyte_id),
      ).filter(Boolean);

      const [rangeRulesMap, patientRangeData] = await Promise.all([
        fetchRangeRules(allLabAnalyteIdsForRanges),
        fetchPatientRangeInfo(order.id, (order as any).patient_id),
      ]);
      setRangeRules(rangeRulesMap);
      setPatientRangeInfo(patientRangeData);

      const resolveAnalyteRange = (la: any, a: any, labAnalyteId: string | null, sampleCondition: string | null) =>
        resolveForAnalyte(rangeRulesMap, {
          lab_analyte_id: labAnalyteId,
          lab_specific_reference_range: la?.lab_specific_reference_range,
          reference_range: la?.reference_range ?? a?.reference_range,
          reference_range_male: la?.reference_range_male,
          reference_range_female: la?.reference_range_female,
          low_critical: la?.low_critical,
          high_critical: la?.high_critical,
        }, contextForGroup(patientRangeData, sampleCondition));

      const tgFromOTG =
        data.order_test_groups?.filter((otg: any) => otg.test_groups).map((otg: any) => ({
          test_group_id: otg.test_groups.id,
          test_group_name: otg.test_groups.name,
          is_section_only: !!otg.test_groups.is_section_only,
          group_level_prompt: otg.test_groups.group_level_prompt || null,
          default_ai_processing_type: otg.test_groups.default_ai_processing_type || null,
          ref_range_ai_config: otg.test_groups.ref_range_ai_config || null,
          order_test_group_id: otg.id,
          order_test_id: null,
          source: "order_test_groups" as const,
          analytes:
            [...(otg.test_groups.test_group_analytes || [])]
              .sort((a: any, b: any) => {
                const ao = a.sort_order ?? a.display_order ?? 0;
                const bo = b.sort_order ?? b.display_order ?? 0;
                return ao - bo;
              })
              .map((tga: any) => {
              const a = tga.analytes;
              const la = tga.lab_analyte_id ? tga.lab_analytes : null;
              const labAnalyteId = tga.lab_analyte_id || la?.id || null;
              const resolvedRange = resolveAnalyteRange(la, a, labAnalyteId, otg.sample_condition || null);
              return {
                ...a,
                sort_order: tga.sort_order,
                display_order: tga.display_order,
                section_heading: tga.section_heading || null,
                lab_analyte_id: labAnalyteId,
                name: la?.name || a.name,
                unit: la?.unit || a.unit,
                reference_range: resolvedRange.range_text,
                range_rule_id: resolvedRange.rule_id,
                range_source: resolvedRange.source,
                applied_range_rule: resolvedRange.applied_rule,
                reference_range_male: la?.reference_range_male ?? undefined,
                reference_range_female: la?.reference_range_female ?? undefined,
                expected_normal_values: la?.expected_normal_values ?? a.expected_normal_values,
                expected_value_flag_map: la?.expected_value_flag_map ?? a.expected_value_flag_map,
                expected_value_codes: la?.expected_value_codes ?? a.expected_value_codes ?? {},
                value_type: la?.value_type ?? a.value_type,
                default_value: la?.default_value ?? null,
                method: la?.method ?? a.method,
                is_calculated: la?.is_calculated ?? a.is_calculated,
                formula: la?.formula ?? a.formula,
                formula_variables: la?.formula_variables ?? a.formula_variables,
                formula_description: la?.formula_description ?? undefined,
                calculation_result_type: la?.calculation_result_type ?? a.calculation_result_type ?? 'numeric',
                interface_config: getAnalyteInterfaceConfig(la?.lab_analyte_interface_config),
                code: a.code || otg.test_groups.code,
                units: la?.unit || a.unit,
                existing_result: (() => {
                    const byOtgId = data.results?.find((r: any) => r.order_test_group_id === otg.id);
                    const fromPrimary = byOtgId?.result_values?.find((rv: any) =>
                      rv.analyte_id === a.id || (!rv.analyte_id && rv.analyte_name === a.name));
                    if (fromPrimary) return fromPrimary;
                    for (const r of data.results || []) {
                      if (r.test_group_id !== otg.test_groups.id) continue;
                      const rv = r.result_values?.find((rv: any) =>
                        rv.analyte_id === a.id || (!rv.analyte_id && rv.analyte_name === a.name));
                      if (rv) return rv;
                    }
                    // Final fallback: scan ALL result rows regardless of test_group_id
                    // (handles Save Draft results which have no test_group_id set)
                    for (const r of data.results || []) {
                      const rv = r.result_values?.find((rv: any) =>
                        rv.analyte_id === a.id || rv.analyte_name === a.name);
                      if (rv) return rv;
                    }
                    return null;
                  })(),
              };
            }) || [],
        })) || [];

      const tgFromOT =
        data.order_tests
          ?.filter((ot: any) => ot.test_groups && ot.test_group_id && !ot.is_canceled && !ot.outsourced_lab_id)
          .map((ot: any) => ({
            test_group_id: ot.test_groups.id,
            test_group_name: ot.test_groups.name,
            is_section_only: !!ot.test_groups.is_section_only,
            group_level_prompt: ot.test_groups.group_level_prompt || null,
            default_ai_processing_type: ot.test_groups.default_ai_processing_type || null,
            ref_range_ai_config: ot.test_groups.ref_range_ai_config || null,
            order_test_group_id: null,
            order_test_id: ot.id,
            source: "order_tests" as const,
            analytes:
              [...(ot.test_groups.test_group_analytes || [])]
                .sort((a: any, b: any) => {
                  const ao = a.sort_order ?? a.display_order ?? 0;
                  const bo = b.sort_order ?? b.display_order ?? 0;
                  return ao - bo;
                })
                .map((tga: any) => {
                const a = tga.analytes;
                const la = tga.lab_analyte_id ? tga.lab_analytes : null;
                const labAnalyteId = tga.lab_analyte_id || la?.id || null;
                const resolvedRange = resolveAnalyteRange(la, a, labAnalyteId, ot.sample_condition || null);
                return {
                  ...a,
                  sort_order: tga.sort_order,
                  display_order: tga.display_order,
                  section_heading: tga.section_heading || null,
                  lab_analyte_id: labAnalyteId,
                  name: la?.name || a.name,
                  unit: la?.unit || a.unit,
                  reference_range: resolvedRange.range_text,
                  range_rule_id: resolvedRange.rule_id,
                  range_source: resolvedRange.source,
                  applied_range_rule: resolvedRange.applied_rule,
                  reference_range_male: la?.reference_range_male ?? undefined,
                  reference_range_female: la?.reference_range_female ?? undefined,
                  expected_normal_values: la?.expected_normal_values ?? a.expected_normal_values,
                  expected_value_flag_map: la?.expected_value_flag_map ?? a.expected_value_flag_map,
                  expected_value_codes: la?.expected_value_codes ?? a.expected_value_codes ?? {},
                  value_type: la?.value_type ?? a.value_type,
                  default_value: la?.default_value ?? null,
                  method: la?.method ?? a.method,
                  is_calculated: la?.is_calculated ?? a.is_calculated,
                  formula: la?.formula ?? a.formula,
                  formula_variables: la?.formula_variables ?? a.formula_variables,
                  formula_description: la?.formula_description ?? undefined,
                  calculation_result_type: la?.calculation_result_type ?? a.calculation_result_type ?? 'numeric',
                  interface_config: getAnalyteInterfaceConfig(la?.lab_analyte_interface_config),
                  code: a.code || ot.test_groups.code,
                  units: la?.unit || a.unit,
                  existing_result: (() => {
                      // Primary: result row explicitly linked to this order_test
                      const byOrderTestId = data.results?.find((r: any) => r.order_test_id === ot.id);
                      const fromPrimary = byOrderTestId?.result_values?.find((rv: any) =>
                        rv.analyte_id === a.id || (!rv.analyte_id && rv.analyte_name === a.name));
                      if (fromPrimary) return fromPrimary;
                      // Fallback: any result row for this order/test_group that has the analyte value
                      for (const r of data.results || []) {
                        if (r.test_group_id !== ot.test_group_id) continue;
                        const rv = r.result_values?.find((rv: any) =>
                          rv.analyte_id === a.id || (!rv.analyte_id && rv.analyte_name === a.name));
                        if (rv) return rv;
                      }
                      // Final fallback: scan ALL result rows regardless of test_group_id
                      for (const r of data.results || []) {
                        const rv = r.result_values?.find((rv: any) =>
                          rv.analyte_id === a.id || rv.analyte_name === a.name);
                        if (rv) return rv;
                      }
                      return null;
                    })(),
                };
              }) || [],
          })) || [];

      // Merge by test_group_id and union analytes
      const merged = [...tgFromOTG, ...tgFromOT].reduce((acc: TestGroupResult[], current: any) => {
        const idx = acc.findIndex((tg) => tg.test_group_id === current.test_group_id);
        if (idx === -1) {
          acc.push(current);
        } else {
          const existing = acc[idx];
          const mergedAnalytes = [...existing.analytes];
          current.analytes.forEach((a: any) => {
            if (!mergedAnalytes.find((m) => m.id === a.id)) mergedAnalytes.push(a);
          });
          acc[idx] = {
            ...existing,
            analytes: mergedAnalytes,
            order_test_group_id: existing.order_test_group_id || current.order_test_group_id,
            order_test_id: existing.order_test_id || current.order_test_id,
            is_section_only: existing.is_section_only || current.is_section_only,
          };
        }
        return acc;
      }, []);

      setTestGroups(merged);

      try {
        const groupIds = merged.map((tg) => tg.test_group_id).filter(Boolean);
        if (groupIds.length > 0) {
          const { data: techSections } = await supabase
            .from("lab_template_sections")
            .select("test_group_id")
            .eq("allow_technician_entry", true)
            .in("test_group_id", groupIds);

          const techGroupIds = new Set((techSections || []).map((s: any) => s.test_group_id));

          // Also include section-only groups (e.g. radiology, microbiology)
          // so they always get a result stub for SectionEditor to attach to
          const sectionOnlyIds = new Set(
            merged.filter((tg) => tg.is_section_only).map((tg) => tg.test_group_id)
          );
          const needsStubIds = new Set([...techGroupIds, ...sectionOnlyIds]);

          if (needsStubIds.size > 0) {
            const [{ data: { user: currentUser } }, userLabId] = await Promise.all([
              supabase.auth.getUser(),
              database.getCurrentUserLabId(),
            ]);

            for (const tg of merged) {
              if (!needsStubIds.has(tg.test_group_id)) continue;
              if (resultIdByTG[tg.test_group_id]) continue;

              const { data: stub } = await supabase
                .from("results")
                .upsert({
                  order_id: order.id,
                  patient_id: safeUuid(order.patient_id),
                  patient_name: order.patient_name,
                  test_name: tg.test_group_name,
                  status: "Entered",
                  entered_by: currentUser?.email || "Unknown",
                  entered_date: new Date().toISOString().split("T")[0],
                  test_group_id: tg.test_group_id,
                  lab_id: userLabId,
                  ...(tg.order_test_group_id && { order_test_group_id: tg.order_test_group_id }),
                  ...(tg.order_test_id && { order_test_id: tg.order_test_id }),
                }, { onConflict: "order_id,test_name", ignoreDuplicates: false })
                .select("id")
                .single();

              if (stub?.id) {
                setResultIdByTG((prev) => ({ ...prev, [tg.test_group_id]: stub.id }));
              }
            }
          }
        }
      } catch (sectionStubError) {
        console.warn("Unable to pre-create section result rows:", sectionStubError);
      }

      // Build flat analytes for initial manual seed (hide already-submitted ones)
      let flatAnalytes = merged.flatMap((tg) => tg.analytes);

      // Fallback enrichment: fetch lab_analytes for analytes that didn't get
      // lab-specific overrides from the primary query (legacy rows without lab_analyte_id)
      const analyteIds = flatAnalytes.map((a: any) => a.id).filter(Boolean);
      if (analyteIds.length > 0 && data.lab_id) {
        const { data: labAnalytes } = await supabase
          .from('lab_analytes')
          .select(`
            analyte_id,
            name, unit, reference_range,
            reference_range_male, reference_range_female,
            expected_normal_values, expected_value_flag_map,
            expected_value_codes, value_type, default_value,
            is_calculated, formula, formula_variables, formula_description, calculation_result_type
          `)
          .eq('lab_id', data.lab_id)
          .in('analyte_id', analyteIds)
          .order('created_at', { ascending: true });

        if (labAnalytes && labAnalytes.length > 0) {
          // Deduplicate: keep only the first (earliest) row per analyte_id
          const labAnalytesMap = new Map<string, any>();
          for (const la of labAnalytes) {
            if (!labAnalytesMap.has(la.analyte_id)) labAnalytesMap.set(la.analyte_id, la);
          }

          // Merge all lab-specific overrides into analytes (lab_analytes takes priority)
          flatAnalytes = flatAnalytes.map((analyte: any) => {
            const la = labAnalytesMap.get(analyte.id);
            if (!la) return analyte;
            const updates: any = {};

            // Display fields — prefer lab-specific if set
            if (la.name)                updates.name             = la.name;
            if (la.unit)                updates.unit             = la.unit;
            if (la.reference_range)     updates.reference_range  = la.reference_range;
            if (la.reference_range_male)  updates.reference_range_male  = la.reference_range_male;
            if (la.reference_range_female) updates.reference_range_female = la.reference_range_female;

            // Calculated parameter fields — prefer lab-specific
            if (la.is_calculated != null) updates.is_calculated       = la.is_calculated;
            if (la.formula)               updates.formula              = la.formula;
            if (la.formula_variables)     updates.formula_variables    = la.formula_variables;
            if (la.formula_description)   updates.formula_description  = la.formula_description;
            if (la.calculation_result_type) updates.calculation_result_type = la.calculation_result_type;

            // Dropdown options
            if (la.expected_normal_values) {
              let v = la.expected_normal_values;
              if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = []; } }
              if (v?.length > 0) updates.expected_normal_values = v;
            }
            if (la.expected_value_flag_map) {
              let m = la.expected_value_flag_map;
              if (typeof m === 'string') { try { m = JSON.parse(m); } catch { m = {}; } }
              if (m && Object.keys(m).length > 0) updates.expected_value_flag_map = m;
            }

            // Quick codes, value type, default value
            if (la.expected_value_codes) {
              let c = la.expected_value_codes;
              if (typeof c === 'string') { try { c = JSON.parse(c); } catch { c = {}; } }
              if (c && Object.keys(c).length > 0) updates.expected_value_codes = c;
            }
            if (la.value_type) updates.value_type = la.value_type;
            if (la.default_value) updates.default_value = la.default_value;

            return Object.keys(updates).length > 0 ? { ...analyte, ...updates } : analyte;
          });
        }
      }

      // Fetch analyte_dependencies; prefer lab-specific rows over global (lab_id IS NULL)
      const calcAnalyteIds = flatAnalytes
        .filter((a: any) => a.is_calculated)
        .map((a: any) => a.id)
        .filter(Boolean);
      if (calcAnalyteIds.length > 0) {
        const { data: depsData } = await supabase
          .from('analyte_dependencies')
          .select('calculated_analyte_id, calculated_lab_analyte_id, source_analyte_id, source_lab_analyte_id, variable_name, lab_id')
          .in('calculated_analyte_id', calcAnalyteIds)
          .or(`lab_id.eq.${order.lab_id},lab_id.is.null`);
        setCalcDeps((depsData || []) as any);
      }

      setOrderAnalytes(flatAnalytes);
    } catch (err) {
      console.error("Error fetching order analytes:", err);
    }
  };

  const fetchExistingResult = async () => {
    try {
      const { data, error } = await database.results.getByOrderId(order.id);
      if (error || !data?.length) return;
      const mostRecentResult = data[0];
      setExistingResultId(mostRecentResult.id);

      if (mostRecentResult.result_values?.length) {
        setManualValues((prev) => {
          const updated = [...prev];
          mostRecentResult.result_values.forEach((rv: any) => {
            const idx = updated.findIndex((v) => v.parameter === rv.parameter);
            if (idx !== -1) {
              updated[idx] = {
                ...updated[idx],
                value: rv.value,
                unit: rv.unit,
                reference: rv.reference_range,
                flag: rv.flag,
              };
            }
          });
          return updated;
        });
      }
    } catch (err) {
      console.error("Error fetching existing result:", err);
    }
  };

  // NEW: attachments list (accept both order_id and related_table/related_id)
  const fetchAttachmentsForOrder = async () => {
    try {
      const attachmentColumns =
        "id, original_filename, file_url, file_type, file_size, uploaded_by, upload_timestamp, description, imagekit_url, processed_url, variants, processing_status, image_processed_at, image_processing_error";

      const q1 = await supabase
        .from("attachments")
        .select(attachmentColumns)
        .eq("order_id", order.id)
        .order("upload_timestamp", { ascending: false });

      const q2 = await supabase
        .from("attachments")
        .select(attachmentColumns)
        .eq("related_table", "orders")
        .eq("related_id", order.id)
        .order("upload_timestamp", { ascending: false });

      const list = [...(q1.data || []), ...(q2.data || [])];
      // de-dup on id
      const dedup = Object.values(
        list.reduce((m: any, a: any) => (
          (m[a.id] = {
            ...a,
            resolved_file_url: a.imagekit_url || a.processed_url || a.file_url,
          }),
          m
        ), {})
      );

      const normalized = dedup as any[];
      setAttachments(normalized);
      if (!activeAttachment && normalized.length > 0) {
        setActiveAttachment(normalized[0] as any);
      }
      updateAiStateFromAttachments(normalized, { preferActiveAttachment: true });
    } catch (e) {
      console.error("Error loading attachments", e);
    }
  };

  const updateAiStateFromAttachments = (
    nextAttachments: any[],
    options?: { preferActiveAttachment?: boolean }
  ) => {
    const imageAttachments = (nextAttachments || []).filter((att: any) =>
      att?.file_type?.startsWith("image/")
    );

    if (imageAttachments.length === 0) {
      setAvailableImagesForAI([]);
      setSelectedImagesForAI(new Set());
      setSelectedBatchForAI(null);
      setMultiImageAIInstructions('');
      return;
    }

    const preferredActive = options?.preferActiveAttachment && activeAttachment
      ? imageAttachments.find((att: any) => att.id === activeAttachment.id) || imageAttachments[0]
      : imageAttachments[0];

    let imagesToAnalyze: any[] = [];
    let virtualBatchId: string | null = null;

    if (preferredActive?.batch_id) {
      imagesToAnalyze = imageAttachments.filter(
        (att: any) => att.batch_id === preferredActive.batch_id
      );
      virtualBatchId = preferredActive.batch_id;
    } else {
      imagesToAnalyze = imageAttachments;
      virtualBatchId = `virtual-${order.id}`;
    }

    if (imagesToAnalyze.length > 1) {
      setAvailableImagesForAI(imagesToAnalyze);
      // Only auto-select the first image; user must manually select additional images
      setSelectedImagesForAI(new Set([imagesToAnalyze[0].id]));
      setSelectedBatchForAI({
        id: virtualBatchId,
        batchId: virtualBatchId,
        files: imagesToAnalyze,
        total_files: imagesToAnalyze.length,
      });

      const imageReferences = imagesToAnalyze
        .map((att: any) => att.image_label || `Image ${att.batch_sequence || imagesToAnalyze.indexOf(att) + 1}`)
        .join(', ');
      const firstImageLabel = imagesToAnalyze[0]?.image_label || `Image ${imagesToAnalyze[0]?.batch_sequence || 1}`;
      const secondImageLabel = imagesToAnalyze[1]
        ? (imagesToAnalyze[1]?.image_label || `Image ${imagesToAnalyze[1]?.batch_sequence || 2}`)
        : '';

      setMultiImageAIInstructions(
        `Analyze uploaded images (${imageReferences}):\n` +
        `- From ${firstImageLabel}: Extract primary test results\n` +
        (imagesToAnalyze[1] ? `- From ${secondImageLabel}: Extract secondary parameters\n` : '') +
        (imagesToAnalyze.length > 2 ? `- From remaining images: Extract additional data\n` : '') +
        `\nMap results to specific image references.`
      );
    } else {
      setAvailableImagesForAI(imagesToAnalyze);
      // Only auto-select the first image
      setSelectedImagesForAI(new Set(imagesToAnalyze.length > 0 ? [imagesToAnalyze[0].id] : []));
      setSelectedBatchForAI(null);
      setMultiImageAIInstructions('');
    }
  };

  const resolveAttachmentUrl = (attachment?: any): string => {
    if (!attachment) return "";
    return (
      attachment.resolved_file_url ||
      attachment.imagekit_url ||
      attachment.processed_url ||
      attachment.fileUrl ||
      attachment.file_url ||
      ""
    );
  };

  const resolvePdfSrc = (attachment?: any): string => {
    const url = resolveAttachmentUrl(attachment);
    return url ? `${url}#view=FitH` : "";
  };

  // NEW: v_order_test_progress rows
  const fetchProgressView = async () => {
    try {
      const { data, error } = await supabase
        .from("v_order_test_progress")
        .select(
          "order_test_id, order_id, test_group_id, test_group_name, expected_analytes, entered_analytes, total_values, has_results, is_verified, panel_status"
        )
        .eq("order_id", order.id);
      if (!error) setProgressRows(data || []);
    } catch (e) {
      console.error("Error loading v_order_test_progress", e);
    }
  };

  // NEW: read-only submitted values (grouped by test_group_id)
  const fetchReadonlyResults = async () => {
    try {
      const { data, error } = await supabase
        .from("results")
        .select(
          `
          id, order_id, test_group_id, order_test_group_id, order_test_id, test_name, created_at, status,
          result_values ( id, analyte_id, analyte_name, value, unit, reference_range, flag )
        `
        )
        .eq("order_id", order.id)
        .order("created_at", { ascending: false });
      if (error) return;

      const map: Record<string, any[]> = {};
      const idMap: Record<string, string> = {};
      (data || []).forEach((r: any) => {
        const key = r.test_group_id || r.order_test_group_id || r.order_test_id || "unknown";
        const arr = r.result_values || [];
        if (!map[key]) map[key] = [];
        // keep newest first; if same analyte appears, latest stays at top
        map[key] = [...arr, ...(map[key] || [])];
        if (!idMap[key]) idMap[key] = r.id;
      });
      setReadonlyByTG(map);
      // Use functional merge to avoid overwriting stubs created by fetchOrderAnalytes
      setResultIdByTG((prev) => ({ ...prev, ...idMap }));
    } catch (e) {
      console.error("Error loading readonly results", e);
    }
  };

  // Fetch upload batches for this order
  const fetchUploadBatches = async () => {
    try {
      const { data, error } = await database.attachmentBatch.getBatchesByOrder(order.id);
      if (error) {
        console.error("Error fetching upload batches:", error);
        return;
      }
      setUploadBatches(data || []);
    } catch (e) {
      console.error("Error loading upload batches", e);
    }
  };

  // Handle batch upload completion
  const handleBatchComplete = async (batch: any) => {
    try {
      // Refresh the batches list
      await fetchUploadBatches();

      // Refresh the attachments list
      await fetchAttachmentsForOrder();

      // Update AI analysis state for the new batch
      if (batch.files && batch.files.length > 0) {
        const normalizedFiles = batch.files.map((file: any) => ({
          ...file,
          resolved_file_url: file.resolved_file_url || file.imagekit_url || file.processed_url || file.file_url,
        }));

        // Set the latest batch as available for AI analysis
        setSelectedBatchForAI({
          ...batch,
          batchId: batch?.batchId || batch?.id,
          files: normalizedFiles,
        });
        setAvailableImagesForAI(normalizedFiles);

        // Set default multi-image AI instructions
        const imageReferences = normalizedFiles.map((file: any, index: number) =>
          `Image ${index + 1}`
        ).join(', ');

        setMultiImageAIInstructions(
          `Please analyze the uploaded images (${imageReferences}):\n` +
          `- From Image 1: Extract primary test results and measurements\n` +
          (normalizedFiles.length > 1 ? `- From Image 2: Extract secondary parameters and observations\n` : '') +
          (normalizedFiles.length > 2 ? `- From Image 3+: Extract additional data and quality indicators\n` : '') +
          `\nProvide results mapped to each image reference.`
        );

        // Set the first attachment for compatibility with existing AI system
        setAttachmentId(normalizedFiles[0].id);
        setActiveAttachment(normalizedFiles[0]);
        setUploadedFile(normalizedFiles[0].file || null);
      }

      // Close the multi-upload modal
      setShowMultiUpload(false);

      // Show success message with AI hint
      alert(`Successfully uploaded ${batch.totalFiles} files as batch! AI analysis is now available for multi-image processing.`);

    } catch (error) {
      console.error('Error handling batch completion:', error);
      alert('Upload completed but failed to refresh the file list.');
    }
  };

  // =========================================================
  // #endregion Data fetchers
  // =========================================================

  // =========================================================
  // #region File upload & AI
  // =========================================================

  const handleFileUpload = async (file: File) => {
    setIsUploading(true);
    setOcrError(null);
    try {
      // Use the new attachments.upload method with test-level support
      const metadata = {
        related_table: 'orders' as const,
        related_id: order.id,
        order_id: order.id,
        order_test_id: uploadScope === 'test' && selectedTestId ? selectedTestId : undefined,
        patient_id: order.patient_id,
        description: `${uploadScope === 'test' ? 'Test-specific' : 'Order-level'} lab result document for order ${order.id}`,
        tag: uploadScope === 'test' ? 'test-specific' : 'order-level'
      };

      const { data: attachment, error } = await attachmentsAPI.upload(file, metadata, {
        optimize: enableOptimization,
        onOptimizationProgress: (progress: number, fileName: string) => {
          setOptimizationProgress({ progress, fileName });
        }
      });

      if (error) throw new Error(String(error) || 'Upload failed');
      const enrichedAttachment = {
        ...attachment,
        resolved_file_url: attachment.resolved_file_url || attachment.imagekit_url || attachment.processed_url || attachment.file_url,
      };

      setAttachmentId(enrichedAttachment.id);
      setUploadedFile(file);
      // refresh visible list + AI image list
      const nextAttachments = [enrichedAttachment, ...attachments];
      setAttachments(nextAttachments);
      setActiveAttachment(enrichedAttachment);
      updateAiStateFromAttachments(nextAttachments, { preferActiveAttachment: true });
      // short refresh to ensure UI reflects any server-side transforms
      await fetchAttachmentsForOrder();

      // mark("upload", "ok", { name: file.name }); // Comment out until mark function is available
    } catch (err) {
      console.error("Error uploading file:", err);
      setOcrError("Failed to upload file. Please try again.");
    } finally {
      setIsUploading(false);
      setOptimizationProgress(null); // Reset optimization progress
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFileUpload(file);
  };

  // Handle native camera capture
  const handleCameraCapture = async () => {
    if (isNative()) {
      try {
        // First check and request permissions
        const { Camera } = await import('@capacitor/camera');
        const permissions = await Camera.checkPermissions();

        if (permissions.camera !== 'granted') {
          const requested = await Camera.requestPermissions();
          if (requested.camera !== 'granted') {
            alert('Camera permission is required to take photos. Please enable it in Settings.');
            return;
          }
        }

        // Now try to capture the photo
        const { CameraResultType, CameraSource } = await import('@capacitor/camera');
        const photo = await Camera.getPhoto({
          quality: 90,
          allowEditing: false,
          resultType: CameraResultType.DataUrl,
          source: CameraSource.Camera,
          saveToGallery: false,
          correctOrientation: true
        });

        if (!photo.dataUrl) {
          throw new Error('No image data received from camera');
        }

        // Convert base64 to blob for upload
        const response = await fetch(photo.dataUrl);
        const blob = await response.blob();

        // Create a File object
        const fileName = `camera_capture_${Date.now()}.${photo.format || 'jpg'}`;
        const file = new File([blob], fileName, { type: `image/${photo.format || 'jpeg'}` });

        // Process the file using existing handler
        handleFileUpload(file);

        console.log('Photo captured and uploaded successfully');
      } catch (error: any) {
        console.error('Camera capture error:', error);
        // More specific error messages
        if (error.message?.includes('User cancelled') || error.message?.includes('cancelled')) {
          console.log('Camera capture cancelled by user');
        } else if (error.message?.includes('No camera') || error.message?.includes('not available')) {
          alert('No camera available on this device');
        } else if (error.message?.includes('permission')) {
          alert('Camera permission denied. Please enable camera access in Settings > Apps > AnPro LIMS > Permissions.');
        } else {
          alert(`Failed to capture photo: ${error.message || 'Unknown error'}. Please try again.`);
        }
      }
    } else {
      // Fallback to HTML file input with camera
      document.getElementById("file-upload")?.click();
    }
  };

  // Handle multi-image batch upload completion
  const handleBatchUploadComplete = async (batch: any) => {
    try {
      // Refresh attachment list
      await fetchAttachmentsForOrder();

      const normalizedBatch = {
        ...batch,
        files: (batch.files || []).map((file: any) => ({
          ...file,
          resolved_file_url: file.resolved_file_url || file.imagekit_url || file.processed_url || file.file_url,
        })),
      };

      // Add to batch list
      setUploadBatches(prev => [normalizedBatch, ...prev]);

      // Close multi-upload interface
      setShowMultiUpload(false);

      // Update AI analysis state for the new batch
      if (normalizedBatch.files && normalizedBatch.files.length > 0) {
        // Set the latest batch as available for AI analysis
        setSelectedBatchForAI({
          ...normalizedBatch,
          batchId: normalizedBatch?.batchId || normalizedBatch?.id,
          files: normalizedBatch.files,
        });
        setAvailableImagesForAI(normalizedBatch.files);

        // Set default multi-image AI instructions
        const imageReferences = normalizedBatch.files.map((file: any, index: number) =>
          `Image ${index + 1}`
        ).join(', ');

        setMultiImageAIInstructions(
          `Analyze uploaded images (${imageReferences}):\n` +
          `- From Image 1: Extract primary test results\n` +
          (normalizedBatch.files.length > 1 ? `- From Image 2: Extract secondary parameters\n` : '') +
          (normalizedBatch.files.length > 2 ? `- From Image 3+: Extract additional data\n` : '') +
          `\nMap results to specific image references.`
        );

        // Set the first attachment for compatibility and focus
        const firstAtt = normalizedBatch.files[0];
        setAttachmentId(firstAtt.id);
        setActiveAttachment(firstAtt);
        setUploadedFile(firstAtt.file || null);
      }

      // Show success message
      alert(`Successfully uploaded ${batch.files.length} images in batch! AI analysis ready.`);

    } catch (error) {
      console.error('Error handling batch upload completion:', error);
    }
  };

  // Handle viewing a specific batch
  const handleViewBatch = (batch: any) => {
    setSelectedBatch(batch);
    setShowBatchViewer(true);
  };

  // Handle deleting a batch
  const handleDeleteBatch = async (batch: any) => {
    const confirmMessage = `Are you sure you want to delete this batch with ${batch.total_files} images? This action cannot be undone.`;

    if (confirm(confirmMessage)) {
      try {
        // Fetch attachments for the batch
        const { data: attachments, error: fetchError } = await supabase
          .from('attachments')
          .select('id, file_path')
          .eq('batch_id', batch.id);

        if (fetchError) throw fetchError;

        // Delete files from storage
        const filePaths = (attachments || []).map((a: any) => a.file_path).filter(Boolean);
        if (filePaths.length > 0) {
          const { error: storageError } = await supabase.storage
            .from('attachments')
            .remove(filePaths);
          if (storageError) console.warn('Storage delete error:', storageError);
        }

        // Delete attachments rows
        const { error: attachmentsDeleteError } = await supabase
          .from('attachments')
          .delete()
          .eq('batch_id', batch.id);
        if (attachmentsDeleteError) throw attachmentsDeleteError;

        // Delete the batch record
        const { error: batchDeleteError } = await supabase
          .from('attachment_batches')
          .delete()
          .eq('id', batch.id);
        if (batchDeleteError) throw batchDeleteError;

        // Update local state
        setUploadBatches(prev => prev.filter(b => b.id !== batch.id));

        // Clear AI state if this was the selected batch
        if (selectedBatchForAI?.id === batch.id) {
          setSelectedBatchForAI(null);
          setAvailableImagesForAI([]);
          setMultiImageAIInstructions('');
        }

        // Refresh attachments
        await loadExistingAttachments();

        alert('Batch deleted successfully');

      } catch (error) {
        console.error('Error deleting batch:', error);
        alert('Failed to delete batch. Please try again.');
      }
    }
  };

  const handleSelectAnalyteForAI = (analyte: any) => {
    setSelectedAnalyteForAI(analyte);
    setAiProcessingConfig({
      type: analyte.ai_processing_type || "ocr_report",
      prompt: analyte.ai_prompt_override || undefined,
    });
  };

  const buildAnalyteDisambiguationHints = (analytes: Array<{ name?: string | null; code?: string | null; unit?: string | null; reference_range?: string | null }>) => {
    const valid = analytes
      .filter((a) => (a.name || "").trim().length > 0)
      .map((a) => ({
        name: (a.name || "").trim(),
        code: (a.code || "").trim(),
        unit: (a.unit || "").trim(),
        reference: (a.reference_range || "").trim(),
      }));

    const namePairs: string[] = [];
    for (let i = 0; i < valid.length; i++) {
      for (let j = i + 1; j < valid.length; j++) {
        const a = valid[i].name.toLowerCase();
        const b = valid[j].name.toLowerCase();
        if (a.includes(b) || b.includes(a)) {
          namePairs.push(`${valid[i].name} <> ${valid[j].name}`);
        }
      }
    }

    const analyteLines = valid.map((a) => {
      const extras = [
        a.code ? `code=${a.code}` : "",
        a.unit ? `unit=${a.unit}` : "",
        a.reference ? `ref=${a.reference}` : "",
      ].filter(Boolean).join(", ");
      return extras ? `- ${a.name} (${extras})` : `- ${a.name}`;
    });

    const pairLine = namePairs.length > 0
      ? `Potentially confusable names: ${namePairs.join("; ")}.`
      : "No obvious near-duplicate names detected.";

    return {
      analyteLines,
      pairLine,
    };
  };

  const buildOptimizedGroupPrompt = ({
    testGroupName,
    basePrompt,
    analytes,
    analytesToExtract,
  }: {
    testGroupName: string;
    basePrompt?: string | null;
    analytes: Array<{ name?: string | null; code?: string | null; unit?: string | null; reference_range?: string | null }>;
    analytesToExtract: string[];
  }) => {
    const { analyteLines, pairLine } = buildAnalyteDisambiguationHints(analytes);
    const extractList = analytesToExtract.length > 0 ? analytesToExtract : analytes.map((a) => (a.name || "").trim()).filter(Boolean);

    const optimizerBlock = [
      `TEST GROUP CONTEXT: ${testGroupName}`,
      `STRICT EXTRACTION TARGETS (ONLY these keys): ${extractList.join(", ")}`,
      `Do NOT return parameters outside this list.`,
      `Use exact full-name matching. Prefer longest exact phrase match when names overlap (example: "Very-Low-Density Lipoprotein" must not map to "Low-Density Lipoprotein").`,
      `Never infer or fabricate calculated parameters; only extract values explicitly present in report text/image.`,
      pairLine,
      "Analyte dictionary:",
      ...analyteLines,
      "Return only valid JSON.",
    ].join("\n");

    if (basePrompt && basePrompt.trim().length > 0) {
      return `${basePrompt.trim()}\n\n${optimizerBlock}`;
    }

    return `Extract lab results for this test group.\n${optimizerBlock}`;
  };

  // Voice Input Analysis Handler
  const handleVoiceAnalyze = async (audioBlob: Blob) => {
    setVoiceAnalyzing(true);
    aiStart();

    try {
      aiMark("voice", { status: "doing", detail: "Recording voice input..." });

      // Convert audio blob to base64
      const arrayBuffer = await audioBlob.arrayBuffer();
      const base64Audio = btoa(
        new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), "")
      );

      aiMark("voice", { status: "done", detail: "Audio captured" });
      aiMark("transcribe", { status: "doing", detail: "Transcribing with Gemini..." });

      // Get target test group and analytes
      const targetTestGroup =
        (selectedTestGroup && testGroups.find((tg) => tg.test_group_id === selectedTestGroup)) ||
        (selectedTestId && testGroups.find((tg) => tg.order_test_id === selectedTestId)) ||
        testGroups[0];

      // Build analyte catalog for matching (all non-calculated analytes)
      const analyteCatalog = manualValues
        .filter((v) => !v.is_calculated)
        .map((v) => ({
          id: v.analyte_id,
          lab_analyte_id: v.lab_analyte_id || null,
          name: v.parameter,
          unit: v.unit || "",
          reference_range: v.reference || "",
        }));

      // Only extract analytes that don't have values yet (same as image AI)
      const analytesToExtract = manualValues
        .filter(
          (v) =>
            !v.is_calculated &&
            (!v.value || (typeof v.value === 'string' && v.value.trim() === ""))
        )
        .map((v) => v.parameter);

      // Call voice-to-results edge function
      const { data: voiceResult, error: voiceError } = await supabase.functions.invoke(
        "voice-to-results",
        {
          body: {
            audioBase64: base64Audio,
            mimeType: audioBlob.type || "audio/webm",
            analyteCatalog,
            analytesToExtract,
            orderId: order.id,
            testGroupId: targetTestGroup?.test_group_id,
          },
        }
      );

      if (voiceError) {
        throw new Error(voiceError.message || "Voice analysis failed");
      }

      if (!voiceResult?.success) {
        throw new Error(voiceResult?.error || "Voice processing returned no results");
      }

      aiMark("transcribe", {
        status: "done",
        detail: `Transcript: "${voiceResult.transcript?.slice(0, 60)}..."`,
      });

      setVoiceTranscript(voiceResult.transcript || "");

      // Process extracted parameters - ensure value is always a string (same as image AI)
      const extractedParams = (voiceResult.extractedParameters || [])
        .filter((p: any) => {
          // Filter out null/empty values (same as image AI)
          const rawValue = p.value;
          return rawValue != null &&
            rawValue !== 'null' &&
            rawValue !== 'NULL' &&
            (typeof rawValue === 'string' ? rawValue.trim() !== '' : true);
        })
        .map((p: any) => ({
          parameter: p.parameter,
          value: String(p.value),  // Always convert to string
          unit: p.unit || "",
          reference: p.reference_range || "",
          flag: p.flag || undefined,
          matched: !!p.matched,
          analyte_id: p.analyte_id || null,
          lab_analyte_id: p.lab_analyte_id || null,
          confidence: p.confidence || 0.95,
        }));

      aiMark("match", {
        status: "doing",
        detail: `Matching ${extractedParams.length} parameters...`,
      });

      setExtractedValues(extractedParams);

      // Auto-fill manualValues with extracted data (same robust matching as image AI)
      setManualValues((prev) => {
        console.log('🎤 Voice Extraction - Matching parameters:');
        console.log('  Current manualValues:', prev);
        console.log('  Extracted params:', extractedParams);

        const updated = [...prev];
        let matchedCount = 0;

        // Get the raw extracted parameters with all fields
        const rawExtractedParams = voiceResult.extractedParameters || [];

        extractedParams.forEach((ep: ExtractedValue) => {
          const epParamName = ep.parameter || (ep as any).parameterName || '';
            const rawEp = rawExtractedParams.find(
              (r: any) => (r.parameter || r.parameterName) === epParamName
            ) || {};
            const epNameLower = epParamName.toLowerCase().trim();
            const epAnalyteId = ep.analyte_id || rawEp.analyte_id;
            const epLabAnalyteId = ep.lab_analyte_id || rawEp.lab_analyte_id;

            // Try multiple matching strategies (same as image AI)
            const idx = updated.findIndex((v) => {
              const vNameLower = v.parameter.toLowerCase().trim();

              // 1. Match by lab_analyte_id (most precise for lab-specific analytes)
              if (v.lab_analyte_id && epLabAnalyteId && v.lab_analyte_id === epLabAnalyteId) {
                return true;
              }

              // 2. Match by analyte_id
              if (v.analyte_id && epAnalyteId && v.analyte_id === epAnalyteId) {
                return true;
              }

              // 3. Match by exact parameter name
              if (vNameLower === epNameLower) {
                return true;
              }

            // 3. Match if parameter names share significant overlap (exact only to avoid false positives)
            if (vNameLower === epNameLower) {
              return true;
            }

            // 4. Match abbreviation in parentheses, e.g. "Mean Corpuscular Hemoglobin (MCH)"
            if (vNameLower.includes(`(${epNameLower})`) || vNameLower.includes(` ${epNameLower} `)) {
              return true;
            }

            // 5. Match common abbreviation patterns
            const abbreviations: Record<string, string[]> = {
              'wbc': ['white blood cell', 'leukocyte'],
              'rbc': ['red blood cell', 'erythrocyte'],
              'hgb': ['hemoglobin', 'haemoglobin'],
              'hb': ['hemoglobin', 'haemoglobin'],
              'hct': ['hematocrit', 'haematocrit'],
              'plt': ['platelet'],
              'mcv': ['mean corpuscular volume', 'mean cell volume'],
              'mch': ['mean corpuscular hemoglobin'],
              'mchc': ['mean corpuscular hemoglobin concentration'],
              'neu': ['neutrophil', 'absolute neutrophil'],
              'lym': ['lymphocyte', 'absolute lymphocyte'],
              'mon': ['monocyte'],
              'eos': ['eosinophil', 'absolute eosinophil'],
              'bas': ['basophil', 'absolute basophil'],
              'mpv': ['mean platelet volume'],
              'rdw': ['red cell distribution width'],
              'pdw': ['platelet distribution width'],
              'pct': ['plateletcrit', 'thrombocrit'],
              'esr': ['erythrocyte sedimentation rate'],
              'tsh': ['thyroid stimulating hormone'],
              'alt': ['alanine transaminase', 'sgpt'],
              'ast': ['aspartate transaminase', 'sgot'],
              'alp': ['alkaline phosphatase'],
              'ggt': ['gamma glutamyl transferase'],
            };

            const abbrevMatches = abbreviations[epNameLower] || abbreviations[epNameLower.replace(/[%#]$/, '')];
            if (abbrevMatches) {
              return abbrevMatches.some(full => vNameLower.includes(full));
            }

            return false;
          });

          if (idx !== -1 && !updated[idx].is_calculated) {
            // Recalculate flag client-side instead of trusting AI-returned flag
            // AI can return wrong flags (e.g. "Low" for a value above range)
            const convertedValue = applyAnalyteInterfaceConversion(
              ep.value,
              updated[idx].interface_config,
              "ai",
            );
            const recalculatedFlag = calculateFlag(
              convertedValue,
              updated[idx].reference || ep.reference || ''
            );
            const finalFlag = recalculatedFlag || ep.flag || undefined;
            console.log(`  ✅ Voice Matched: ${ep.parameter} (${ep.value}) → ${updated[idx].parameter} | AI flag: ${ep.flag} → Recalculated: ${recalculatedFlag || 'Normal'}`);
            updated[idx] = {
              ...updated[idx],
              value: convertedValue,
              unit: updated[idx].interface_config &&
                isAnalyteInterfaceConversionEnabled(updated[idx].interface_config, "ai")
                ? updated[idx].interface_config.lims_unit || updated[idx].unit
                : updated[idx].unit,
              flag: finalFlag,
              interface_conversion_pending: false,
            };
            matchedCount++;
          } else {
            console.log(`  ⚠️ Voice Unmatched: ${ep.parameter} (${ep.value})`);
          }
        });

        console.log(`📊 Voice Match summary: ${matchedCount} of ${extractedParams.length} parameters matched`);

        aiMark("match", {
          status: "done",
          detail: `${matchedCount} of ${extractedParams.length} parameters matched`,
        });

        // Recompute calculated parameters after AI fills in values
        return recomputeCalculatedValues(updated);
      });

      setAiPhase("done");
      setAiMatchedCount(extractedParams.filter((p: any) => p.matched).length);
      setShowVoiceInput(false);
    } catch (error: any) {
      console.error("Voice analysis error:", error);
      aiFail("voice", error.message || "Voice analysis failed");
    } finally {
      setVoiceAnalyzing(false);
    }
  };

  const handleRunAIProcessing = async (analyteConfig?: { type: string; prompt?: string }) => {
    aiStart();
    setIsOCRProcessing(true);
    setOcrError(null);

    try {
      aiMark("attach", { status: "doing" });

      // Check for attachments (single or batch)
      if (!attachmentId && (!selectedBatchForAI || !availableImagesForAI.length)) {
        aiFail("attach", "No attachments found. Upload images first.");
        setIsOCRProcessing(false);
        return;
      }

      // Determine target test group FIRST (before filtering images)
      // Priority: 1) Selected test group, 2) Selected test, 3) Attachment's test, 4) Selected analyte, 5) First test

      // Get test group info from active attachment (if available)
      // Note: ai_metadata may be stored as JSON string in DB
      let parsedAiMetadata = activeAttachment?.ai_metadata;
      if (typeof parsedAiMetadata === 'string') {
        try {
          parsedAiMetadata = JSON.parse(parsedAiMetadata);
        } catch (e) {
          parsedAiMetadata = {};
        }
      }

      const attachmentTestGroupId = parsedAiMetadata?.test_group_id ||
                                    activeAttachment?.metadata?.test_group_id;
      const attachmentOrderTestId = activeAttachment?.order_test_id;

      console.log('[AI] Attachment test info:', {
        attachmentTestGroupId,
        attachmentOrderTestId,
        selectedTestId,
        attachmentTag: activeAttachment?.tag
      });

      const targetTestGroup =
        (selectedTestGroup && testGroups.find((tg) => tg.test_group_id === selectedTestGroup)) ||
        (selectedTestId && testGroups.find((tg) => tg.order_test_id === selectedTestId)) ||
        // NEW: Use attachment's order_test_id or test_group_id if available
        (attachmentOrderTestId && testGroups.find((tg) => tg.order_test_id === attachmentOrderTestId)) ||
        (attachmentTestGroupId && testGroups.find((tg) => tg.test_group_id === attachmentTestGroupId)) ||
        (selectedAnalyteForAI
          ? testGroups.find((tg) => tg.analytes?.some((analyte: any) => analyte.id === selectedAnalyteForAI.id))
          : undefined) ||
        testGroups[0];

      const targetTestGroupId = targetTestGroup?.test_group_id || null;
      console.log('[AI] Target test group:', targetTestGroup?.test_group_name, 'ID:', targetTestGroupId);

      // Use user-selected images (if any selected), otherwise use all available
      let imagesForThisTest = selectedImagesForAI.size > 0
        ? availableImagesForAI.filter((img: any) => selectedImagesForAI.has(img.id))
        : availableImagesForAI;

      // Further filter by test group if applicable
      if (targetTestGroupId && imagesForThisTest.length > 1) {
        // Filter to only images assigned to this test group
        const filteredImages = imagesForThisTest.filter((img: any) => {
          // Check if image has test_group_id metadata
          const imgTestGroupId = img.test_group_id || img.metadata?.test_group_id;
          // If no test group assigned to image, OR matches target test group
          return !imgTestGroupId || imgTestGroupId === targetTestGroupId;
        });

        if (filteredImages.length > 0) {
          imagesForThisTest = filteredImages;
          console.log(`Filtered ${imagesForThisTest.length} images for test group:`, targetTestGroup?.test_group_name);
        } else {
          // If no images match, warn user but continue with all images
          console.warn(`No images found for test group ${targetTestGroup?.test_group_name}, using all available images`);
        }
      }

      const isMultiImage = imagesForThisTest.length > 1;
      const attachmentDetail = isMultiImage
        ? `${imagesForThisTest.length} images for ${targetTestGroup?.test_group_name || 'test'}`
        : "Single image";

      aiMark("attach", { status: "done", detail: attachmentDetail });

      aiMark("vision", { status: "doing" });
      const processingType = analyteConfig?.type || aiProcessingConfig?.type || targetTestGroup?.default_ai_processing_type || "ocr_report";
      const customPrompt = analyteConfig?.prompt || aiProcessingConfig?.prompt;

      const activeTestGroupKey = targetTestGroupId || 'order';

      // IMPORTANT: When a specific test is selected, ONLY use that test's analytes
      // Do NOT fall back to all orderAnalytes - this causes AI to map wrong tests
      let orderScopedAnalytes: any[] = [];

      if (targetTestGroup?.analytes?.length) {
        // Use selected test's analytes ONLY
        orderScopedAnalytes = targetTestGroup.analytes;
        console.log(`[AI] Using ${orderScopedAnalytes.length} analytes from selected test: ${targetTestGroup.test_group_name}`);
      } else if (selectedTestId || selectedTestGroup) {
        // Test was selected but no analytes found - warn and use empty (strict mode)
        console.warn(`[AI] Test selected but no analytes found for: ${targetTestGroup?.test_group_name || selectedTestId}`);
        // Try to find analytes from order_tests
        const selectedOrderTest = order.order_tests?.find((ot: any) => ot.id === selectedTestId);
        if (selectedOrderTest?.test_groups?.test_group_analytes?.length) {
          orderScopedAnalytes = selectedOrderTest.test_groups.test_group_analytes.map((tga: any) => ({
            ...tga.analytes,
            code: selectedOrderTest.test_groups.code,
          }));
          console.log(`[AI] Found ${orderScopedAnalytes.length} analytes from order_tests fallback`);
        } else {
          // Still no analytes - use orderAnalytes but log warning
          orderScopedAnalytes = orderAnalytes;
          console.warn(`[AI] FALLBACK: Using all ${orderScopedAnalytes.length} order analytes (test-specific not found)`);
        }
      } else {
        // No test selected - use all order analytes
        orderScopedAnalytes = orderAnalytes || [];
        console.log(`[AI] No test selected, using all ${orderScopedAnalytes.length} order analytes`);
      }

      type AnalyteCatalogEntry = {
        id: string;
        lab_analyte_id: string | null;
        name: string | null;
        unit: string | null;
        reference_range: string | null;
        code: string | null;
      };

      const analyteCatalogMap = orderScopedAnalytes.reduce(
        (catalog, analyte: any) => {
          if (!analyte?.id || typeof analyte.id !== 'string') {
            return catalog;
          }
          if (analyte?.is_calculated) {
            return catalog;
          }

          if (!catalog.has(analyte.id)) {
            catalog.set(analyte.id, {
              id: analyte.id,
              lab_analyte_id: analyte.lab_analyte_id || null,
              name: analyte.name || analyte.analyte_name || null,
              unit: analyte.unit || analyte.units || null,
              reference_range: analyte.reference_range || null,
              code: analyte.code || analyte.analyte_code || null,
            });
          }

          return catalog;
        },
        new Map<string, AnalyteCatalogEntry>(),
      );

      const analyteCatalog: AnalyteCatalogEntry[] = Array.from(analyteCatalogMap.values());

      const analyteIdsForVision = analyteCatalog
        .map((entry) => entry.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);

      const resolvedBatchId =
        selectedBatchForAI?.batchId ||
        selectedBatchForAI?.id ||
        imagesForThisTest[0]?.batch_id ||
        activeAttachment?.batch_id ||
        null;

      // Use filtered images for reference
      // When using batch mode with multiple images, include ALL images in referenceImages
      const useAllImagesInBatch = !attachmentId && imagesForThisTest.length > 0;

      const referenceImagesForVision = imagesForThisTest
        .filter((img: any) => useAllImagesInBatch || !attachmentId || img.id !== attachmentId)
        .map((img: any) => {
          const url = resolveAttachmentUrl(img);
          if (!url) return null;
          return {
            url,
            type: "supporting",
            description: img.image_label || `Image ${img.batch_sequence || 1}`,
            testGroupId: img.test_group_id || img.metadata?.test_group_id || targetTestGroupId,
          };
        })
        .filter(Boolean) as Array<{ url: string; type: string; description?: string; testGroupId?: string }>;

      // For batch mode, use the first image ID if attachmentId is not set
      const primaryAttachmentId = attachmentId || (imagesForThisTest.length > 0 ? imagesForThisTest[0]?.id : null);

      const visionPayload = {
        attachmentId: primaryAttachmentId,
        aiProcessingType: processingType,
        analysisType: (processingType === "ocr_report" || processingType === "THERMAL_SLIP_OCR" || processingType === "INSTRUMENT_SCREEN_OCR") ? "text"
          : (processingType === "COLOR_STRIP_MULTIPARAM" || processingType === "SINGLE_WELL_COLORIMETRIC" || processingType === "vision_color") ? "colors"
          : "all",
        orderId: order.id,
        testGroupId: targetTestGroupId || undefined,
        analyteIds: analyteIdsForVision.length ? analyteIdsForVision : undefined,
        batchId: resolvedBatchId || undefined,
        referenceImages: referenceImagesForVision.length ? referenceImagesForVision : undefined,
        customInstruction:
          customPrompt || (imagesForThisTest.length > 1 ? multiImageAIInstructions : undefined),
      };

      const visionResponse = await supabase.functions.invoke("vision-ocr", {
        body: visionPayload
      });
      if (visionResponse.error) throw new Error(visionResponse.error.message);
      aiMark("vision", { status: "done", detail: (visionResponse.data?.fullText || "").slice(0, 80) + "…" });

      aiMark("nlp", { status: "doing" });
      const analytesToExtract = manualValues
        .filter(
          (v) =>
            !v.is_calculated &&
            (!v.value || (typeof v.value === 'string' && v.value.trim() === ""))
        )
        .map((v) => v.parameter);

      // Use the detected processing type from vision-ocr response (auto-detection result)
      const detectedProcessingType = visionResponse.data?.metadata?.aiProcessingType || processingType;

      // Build optimized test-group prompt for disambiguation (especially useful when group prompt is missing)
      const detectedCustomPrompt = visionResponse.data?.customPrompt || customPrompt || (imagesForThisTest.length > 1 ? multiImageAIInstructions : undefined);
      const effectiveAiPrompt = buildOptimizedGroupPrompt({
        testGroupName: targetTestGroup?.test_group_name || "Selected Test Group",
        basePrompt: detectedCustomPrompt || targetTestGroup?.group_level_prompt || "",
        analytes: analyteCatalog,
        analytesToExtract,
      });

      // Prepare request body with multi-image support - USE FILTERED IMAGES
      const requestBody = {
        rawText: visionResponse.data?.fullText,
        visionResults: visionResponse.data,
        originalBase64Image: visionResponse.data?.originalBase64Image,
        aiProcessingType: detectedProcessingType,  // Use detected type from vision-ocr
        aiPromptOverride: effectiveAiPrompt,
        analyteCatalog,
        analytesToExtract: analytesToExtract.length ? analytesToExtract : undefined,
        orderId: order.id,
        testGroupId: visionPayload.testGroupId,
        analyteIds: visionPayload.analyteIds,
        // Multi-image context - USE FILTERED IMAGES
        isMultiImage: imagesForThisTest.length > 1,
        imageReferences: imagesForThisTest.map((img: any, idx: number) => ({
          sequence: idx + 1,
          label: img.image_label || `Image ${idx + 1}`,
          attachmentId: img.id,
          fileUrl: resolveAttachmentUrl(img) || img.fileUrl,
          testGroupId: img.test_group_id || img.metadata?.test_group_id || targetTestGroupId,
        })),
        batchId: visionPayload.batchId,
        referenceImages: visionPayload.referenceImages,
      };

      const geminiResponse = await supabase.functions.invoke("gemini-nlp", {
        body: requestBody,
        headers: {
          "x-attachment-id": attachmentId || "",
          "x-order-id": order.id,
          "x-batch-id": visionPayload.batchId || "",
          "x-multi-image": imagesForThisTest.length > 1 ? "true" : "false",
          "x-test-group-id": targetTestGroupId || "",
        },
      });
      if (geminiResponse.error) throw new Error(geminiResponse.error.message);
      aiMark("nlp", { status: "done", detail: "Tokens parsed" });

      aiMark("match", { status: "doing" });
      const result = geminiResponse.data;
      let matchedCount = 0;
      const strictTargetSet = new Set(
        analytesToExtract.map((name) => name.toLowerCase().trim())
      );

      // your existing shape-handling remains
      const foundCount =
        Array.isArray(result?.extractedParameters) ? result.extractedParameters.length :
          (result && typeof result === "object" && !Array.isArray(result)) ? Object.keys(result).length : 0;

      if (foundCount > 0) {
        if (
          analytesToExtract.length &&
          result &&
          typeof result === "object" &&
          !Array.isArray(result) &&
          !result.extractedParameters
        ) {
          setOcrResults(result);
          setManualValues((prev) => {
            const updated = [...prev];
            Object.keys(result).forEach((paramName) => {
              const idx = updated.findIndex((v) => v.parameter === paramName);
              // Filter out null, "null", undefined, and empty values
              const rawValue = result[paramName];
              const isValidValue = rawValue &&
                rawValue !== 'null' &&
                rawValue !== 'NULL' &&
                (typeof rawValue === 'string' ? rawValue.trim() !== '' : true);

              if (idx !== -1 && isValidValue && !updated[idx].is_calculated) {
                const convertedValue = applyAnalyteInterfaceConversion(
                  rawValue,
                  updated[idx].interface_config,
                  "ai",
                );
                updated[idx] = {
                  ...updated[idx],
                  value: convertedValue,
                  unit: updated[idx].interface_config &&
                    isAnalyteInterfaceConversionEnabled(updated[idx].interface_config, "ai")
                    ? updated[idx].interface_config.lims_unit || updated[idx].unit
                    : updated[idx].unit,
                  interface_conversion_pending: false,
                };
              }
            });
            // Recompute calculated parameters after AI fills in values
            return recomputeCalculatedValues(updated);
          });
          setExtractedValues([]);
          matchedCount = foundCount;
        } else if (Array.isArray(result?.extractedParameters)) {
          // Filter out null values from extracted parameters
          const extractedParams = result.extractedParameters
            .filter((p: any) => {
              // Skip if value is null, "null", undefined, or empty
              const rawValue = p.value;
              return rawValue &&
                rawValue !== 'null' &&
                rawValue !== 'NULL' &&
                (typeof rawValue === 'string' ? rawValue.trim() !== '' : true);
            })
            .map((p: any) => ({
              parameter: p.parameter,
              value: p.value,
              unit: p.unit || "",
              reference: p.reference_range || "",
              flag: p.flag || undefined,
              matched: !!p.matched,
              analyte_id: p.analyte_id || null,
              lab_analyte_id: p.lab_analyte_id || null,
              confidence: p.confidence || 0.95,
            }));
          setExtractedValues(extractedParams);
          setOcrResults(result);
          setManualValues((prev) => {
            console.log('🔍 AI Extraction - Matching parameters:');
            console.log('  Current manualValues:', prev);
            console.log('  Extracted params:', extractedParams);

            const updated = [...prev];
            const addedParameters: ExtractedValue[] = [];
            let currentMatchedCount = 0;

            // Get the raw extracted parameters with all fields (including matched_to)
            const rawExtractedParams = result.extractedParameters || [];

            extractedParams.forEach((ep: ExtractedValue) => {
              // ✅ FIX: Find the matching raw param by parameter name, not by index
              // This is needed because extractedParams is filtered (removes empty values)
              // but rawExtractedParams is unfiltered
              const epParamName = ep.parameter || (ep as any).parameterName || '';
              const rawEp = rawExtractedParams.find(
                (r: any) => (r.parameter || r.parameterName) === epParamName
              ) || {};
              const matchedTo = (rawEp.matched_to || '').toLowerCase().trim();
              const epNameLower = epParamName.toLowerCase().trim();
              const epAnalyteId = ep.analyte_id || rawEp.analyte_id;
              const epLabAnalyteId = ep.lab_analyte_id || rawEp.lab_analyte_id;

              // Try multiple matching strategies
              const idx = updated.findIndex((v) => {
                const vNameLower = v.parameter.toLowerCase().trim();

                // 1. Match by lab_analyte_id (most precise for lab-specific analytes)
                if (v.lab_analyte_id && epLabAnalyteId && v.lab_analyte_id === epLabAnalyteId) {
                  return true;
                }

                // 2. Match by analyte_id
                if (v.analyte_id && epAnalyteId && v.analyte_id === epAnalyteId) {
                  return true;
                }

                // 3. Match by exact parameter name
                if (vNameLower === epNameLower) {
                  return true;
                }

                // 4. Match if matched_to exactly equals the parameter name
                if (matchedTo && matchedTo === vNameLower) {
                  return true;
                }

                // 5. Match if parameter names share significant overlap (e.g., "WBC" in "White Blood Cell Count (WBC)")
                if (vNameLower.includes(`(${epNameLower})`) || vNameLower.includes(` ${epNameLower} `)) {
                  return true;
                }

                // 6. Match common abbreviation patterns
                const abbreviations: Record<string, string[]> = {
                  'wbc': ['white blood cell', 'leukocyte'],
                  'rbc': ['red blood cell', 'erythrocyte'],
                  'hgb': ['hemoglobin', 'haemoglobin'],
                  'hct': ['hematocrit', 'haematocrit'],
                  'plt': ['platelet'],
                  'mcv': ['mean corpuscular volume', 'mean cell volume'],
                  'mch': ['mean corpuscular hemoglobin'],
                  'mchc': ['mean corpuscular hemoglobin concentration', 'mchc'],
                  'neu': ['neutrophil', 'absolute neutrophil'],
                  'lym': ['lymphocyte', 'absolute lymphocyte'],
                  'mon': ['monocyte'],
                  'eos': ['eosinophil', 'absolute eosinophil'],
                  'bas': ['basophil', 'absolute basophil'],
                  'mpv': ['mean platelet volume'],
                  'rdw': ['red cell distribution width', 'rdw'],
                  'rdw-cv': ['rdw-cv', 'rdw cv', 'red cell distribution width'],
                  'rdw-sd': ['rdw-sd', 'rdw sd', 'red cell distribution width'],
                  'pdw': ['platelet distribution width', 'pdw'],
                  'pct': ['plateletcrit', 'pct', 'thrombocrit'],
                };

                const abbrevMatches = abbreviations[epNameLower];
                // Also try stripping % and # suffixes (e.g., NEU% -> NEU)
                const baseAbbrev = epNameLower.replace(/[%#]$/, '');
                const finalMatches = abbrevMatches || abbreviations[baseAbbrev];
                if (finalMatches) {
                  return finalMatches.some(full => vNameLower.includes(full));
                }

                return false;
              });

              if (idx !== -1 && !updated[idx].is_calculated) {
                // For dropdown analytes: snap AI value to the closest matching option
                let resolvedValue = ep.value;
                const opts = updated[idx].expected_normal_values;
                if (opts && opts.length > 0 && ep.value) {
                  const aiVal = String(ep.value).trim().toLowerCase();
                  const exact = opts.find((o: string) => o === ep.value);
                  if (!exact) {
                    const caseInsensitive = opts.find((o: string) => o.toLowerCase() === aiVal);
                    resolvedValue = caseInsensitive ?? ep.value;
                  }
                }
                resolvedValue = applyAnalyteInterfaceConversion(
                  resolvedValue,
                  updated[idx].interface_config,
                  "ai",
                );
                // Recalculate flag client-side instead of trusting AI-returned flag
                const recalculatedFlag = calculateFlag(
                  String(resolvedValue),
                  updated[idx].reference || ep.reference || ''
                );
                const finalFlag = recalculatedFlag || ep.flag || undefined;
                console.log(`  ✅ Matched: ${ep.parameter} (${resolvedValue}) → ${updated[idx].parameter} | AI flag: ${ep.flag} → Recalculated: ${recalculatedFlag || 'Normal'}`);
                updated[idx] = {
                  ...updated[idx],
                  value: resolvedValue,
                  unit: updated[idx].interface_config &&
                    isAnalyteInterfaceConversionEnabled(updated[idx].interface_config, "ai")
                    ? updated[idx].interface_config.lims_unit || updated[idx].unit
                    : updated[idx].unit,
                  flag: finalFlag,
                  ai_color_observation: rawEp.color_observation || undefined,
                  interface_conversion_pending: false,
                };
                currentMatchedCount++;
              } else if (idx === -1) {
                const normalizedEpName = ep.parameter?.toLowerCase().trim();
                const canAppendUnknown =
                  strictTargetSet.size === 0 ||
                  (normalizedEpName && strictTargetSet.has(normalizedEpName));

                if (canAppendUnknown) {
                  const addedFlag = calculateFlag(String(ep.value), ep.reference || '') || ep.flag;
                  console.log(`  ➕ Adding new parameter: ${ep.parameter} (${ep.value})`);
                  addedParameters.push({
                    analyte_id: epAnalyteId,
                    lab_analyte_id: epLabAnalyteId || null,
                    parameter: ep.parameter,
                    value: ep.value,
                    unit: ep.unit,
                    reference: ep.reference,
                    flag: addedFlag
                  });
                } else {
                  console.log(`  ⚠️ Ignored non-target parameter from AI: ${ep.parameter}`);
                }
              }
            });

            console.log(`📊 Match summary: ${currentMatchedCount} updated, ${addedParameters.length} added`);

            // Recompute calculated parameters after AI fills in values
            if (addedParameters.length > 0) {
              return recomputeCalculatedValues([...updated, ...addedParameters]);
            }

            return recomputeCalculatedValues(updated);
          });
          matchedCount = result.extractedParameters.filter((p: any) => p?.matched).length;
        }
      }

      setAiMatchedCount(matchedCount);
      aiMark("match", { status: "done", detail: `Matched ${matchedCount} analyte(s)` });

      aiMark("fill", { status: "doing" });
      // after you update state:
      aiMark("fill", { status: "done", detail: "Values placed into grid" });

      aiMark("final", { status: "done" });
      setAiPhase("done");
      setAiProgress(100);

      // Mark processed images as AI-analyzed in database
      const processedImageIds = imagesForThisTest.map((img: any) => img.id).filter(Boolean);
      if (processedImageIds.length > 0) {
        await supabase
          .from("attachments")
          .update({
            ai_processed: true,
            ai_processed_at: new Date().toISOString(),
            ai_metadata: {
              processedAt: new Date().toISOString(),
              matchedCount,
              testGroupId: targetTestGroupId,
              processingType,
            }
          })
          .in("id", processedImageIds);

        // Update local state to reflect AI processing
        setAttachments((prev) =>
          prev.map((att) =>
            processedImageIds.includes(att.id)
              ? { ...att, ai_processed: true, ai_processed_at: new Date().toISOString() }
              : att
          )
        );
        setAvailableImagesForAI((prev) =>
          prev.map((att) =>
            processedImageIds.includes(att.id)
              ? { ...att, ai_processed: true, ai_processed_at: new Date().toISOString() }
              : att
          )
        );
      }

      // Store batch context for persistence if multi-image processing
      if (imagesForThisTest.length > 1 && selectedBatchForAI) {
        localStorage.setItem(
          `ai_batch_${activeTestGroupKey}`,
          JSON.stringify({
            batchId: selectedBatchForAI.batchId,
            processed: true,
            processedAt: new Date().toISOString(),
            imageCount: imagesForThisTest.length,
            matchedCount,
            testGroupId: targetTestGroupId,
          })
        );
      }

      if (!matchedCount) setOcrError("OCR parsed text but no analytes matched your catalogue.");
    } catch (err: any) {
      aiFail("final", err?.message || "Unknown error");
      setOcrError("Failed to process document. Please try again.");
    } finally {
      setIsOCRProcessing(false);
    }
  };

  // =========================================================
  // #endregion File upload & AI
  // =========================================================

  // =========================================================
  // #region Local helpers (UI colors, hide-completed, etc.)
  // =========================================================

  const styleUtils = {
    aiProcessingType: {
      label: (t: string) =>
        (
          {
            none: "Manual Entry Only",
            ocr_report: "OCR Report Processing",
            vision_card: "Vision Card Analysis",
            vision_color: "Vision Color Analysis",
          } as any
        )[t] || t,
      color: (t: string) =>
        (
          {
            none: "bg-gray-100 text-gray-800",
            ocr_report: "bg-blue-100 text-blue-800",
            vision_card: "bg-green-100 text-green-800",
            vision_color: "bg-purple-100 text-purple-800",
          } as any
        )[t] || "bg-gray-100 text-gray-800",
    },
    status: (s: string) =>
      (
        {
          "Sample Collection": "bg-blue-100 text-blue-800",
          "In Progress": "bg-orange-100 text-orange-800",
          "Pending Approval": "bg-yellow-100 text-yellow-800",
          Completed: "bg-green-100 text-green-800",
          Delivered: "bg-gray-100 text-gray-800",
        } as any
      )[s] || "bg-gray-100 text-gray-800",
    priority: (p: string) =>
      (
        {
          Normal: "bg-gray-100 text-gray-800",
          Urgent: "bg-orange-100 text-orange-800",
          STAT: "bg-red-100 text-red-800",
        } as any
      )[p] || "bg-gray-100 text-gray-800",
    flag: (f?: string) => {
      const normalizedFlag = (f || "").trim().toLowerCase();
      if (["h", "high", "critical_h", "critical_high", "h*", "hh"].includes(normalizedFlag)) {
        return "text-red-600 bg-red-100";
      }
      if (["l", "low", "critical_l", "critical_low", "l*", "ll"].includes(normalizedFlag)) {
        return "text-blue-600 bg-blue-100";
      }
      if (["c", "critical"].includes(normalizedFlag)) {
        return "text-orange-600 bg-orange-100";
      }
      return "";
    },
    confidence: (c: number) =>
      c >= 0.95
        ? "text-green-600 bg-green-100"
        : c >= 0.9
          ? "text-yellow-600 bg-yellow-100"
          : "text-red-600 bg-red-100",
  };

  const getAIProcessingTypeLabel = styleUtils.aiProcessingType.label;
  const getAIProcessingTypeColor = styleUtils.aiProcessingType.color;
  const getStatusColor = styleUtils.status;
  const getPriorityColor = styleUtils.priority;
  const getFlagColor = styleUtils.flag;
  const getConfidenceColor = styleUtils.confidence;

  const DEFAULT_FLAG_OPTIONS = [
    { value: "", label: "Normal" },
    { value: "H", label: "High" },
    { value: "L", label: "Low" },
    { value: "critical_h", label: "Critical High" },
    { value: "critical_l", label: "Critical Low" },
    { value: "A", label: "Abnormal" },
    { value: "C", label: "Critical" },
  ];

  const [labFlagOptions, setLabFlagOptions] = useState(DEFAULT_FLAG_OPTIONS);

  // Fetch lab flag options when order loads
  useEffect(() => {
    if (!order?.lab_id) return;
    const fetchLabFlags = async () => {
      try {
        const { data } = await supabase.from('labs').select('flag_options').eq('id', order.lab_id).single();
        if (data?.flag_options && Array.isArray(data.flag_options) && data.flag_options.length > 0) {
          setLabFlagOptions(data.flag_options);
        }
      } catch { /* use defaults */ }
    };
    fetchLabFlags();
  }, [order?.lab_id]);

  // Mark analytes immediately as "submitted" locally and hide them from entry
  const markAnalytesAsSubmitted = (submitted: ExtractedValue[]) => {
    setTestGroups((prev) =>
      prev.map((tg) => ({
        ...tg,
        analytes: tg.analytes.map((a) => {
          const m = submitted.find((s) => s.parameter === a.name);
          return m
            ? {
              ...a,
              existing_result: {
                id: "local",
                value: m.value,
                status: "pending_verification",
              },
            }
            : a;
        }),
      }))
    );

    // Remove from manualValues list (they disappear from the entry table)
    setManualValues((prev) => prev.filter((v) => !submitted.some((s) => s.parameter === v.parameter)));
  };

  // =========================================================
  // #endregion Local helpers
  // =========================================================

  // =========================================================
  // #region Draft & Submit handlers
  // =========================================================

  // Recompute all calculated analytes from current manualValues snapshot.
  // Called after any manual value change so calculated rows update live.
  const recomputeCalculatedValues = React.useCallback((values: ExtractedValue[]): ExtractedValue[] => {
    const toVariableSlug = (name: string): string => {
      const abbrevMap: Record<string, string> = {
        'total cholesterol': 'TC', 'hdl cholesterol': 'HDL', 'ldl cholesterol': 'LDL',
        'triglycerides': 'TG', 'hemoglobin': 'HGB', 'hematocrit': 'HCT',
        'red blood cell': 'RBC', 'white blood cell': 'WBC', 'platelet': 'PLT',
        'mean corpuscular volume': 'MCV', 'mean corpuscular hemoglobin': 'MCH',
        'albumin': 'ALB', 'globulin': 'GLOB', 'total protein': 'TP',
        'creatinine': 'CREAT', 'blood urea nitrogen': 'BUN', 'urea': 'UREA',
        'glucose': 'GLU', 'calcium': 'CA', 'sodium': 'NA', 'potassium': 'K',
      };
      const lower = name.toLowerCase();
      for (const [full, abbrev] of Object.entries(abbrevMap)) {
        if (lower.includes(full)) return abbrev.toLowerCase();
      }
      const words = name.replace(/[^a-zA-Z0-9\s]/g, '').split(/\s+/);
      if (words.length === 1) return words[0].substring(0, 4).toLowerCase();
      return words.map(w => w.substring(0, 3)).join('').toLowerCase().substring(0, 6);
    };

    const toNumberLocal = (raw: string | number | null | undefined): number | null => {
      if (raw === null || raw === undefined || raw === "") return null;
      const parsed = Number(String(raw).trim());
      return Number.isFinite(parsed) ? parsed : null;
    };

      const parseVars = (fv: string[] | string | null | undefined): string[] => {
      if (!fv) return [];
      if (Array.isArray(fv)) return fv.filter(Boolean);
      try { return (JSON.parse(fv) as string[]).filter(Boolean); } catch { return []; }
    };

    // Build lookup: UUID → number, name_lower → number
    // Stores both so formula resolution works even when dep points to a different
    // copy of the same analyte (different ID, same name)
    const lookup = new Map<string, number>();
    // Inject patient context so formulas like eGFR can use AGE / GENDER_MALE
    const patientAge = order.patient?.age ? Number(order.patient.age) : null;
    const patientGender = order.patient?.gender;
    if (patientAge !== null && Number.isFinite(patientAge)) {
      lookup.set('age', patientAge);
    }
    if (patientGender) {
      lookup.set('gender_male', patientGender === 'Male' ? 1 : 0);
      lookup.set('gender_female', patientGender === 'Female' ? 1 : 0);
      lookup.set('gender', patientGender === 'Male' ? 1 : 0);
    }
    const RECALC_MATH_BUILTINS = new Set(['math', 'pow', 'abs', 'sqrt', 'min', 'max', 'ceil', 'floor', 'round', 'log', 'exp']);

    for (const tg of testGroups) {
      for (const a of tg.analytes) {
        if (a.is_calculated) continue;
        const savedVal = a.existing_result?.value;
        const num = toNumberLocal(savedVal);
        if (num !== null) {
          if (a.id) lookup.set(a.id, num);
          if ((a as any).lab_analyte_id) lookup.set((a as any).lab_analyte_id, num);
          lookup.set(a.name.toLowerCase(), num);
          lookup.set(toVariableSlug(a.name), num);
          if ((a as any).code) lookup.set(String((a as any).code).toLowerCase(), num);
        }
      }
    }

    for (const v of values) {
      if (v.is_calculated) continue;
      const num = toNumberLocal(v.value);
      if (num === null || v.value === "") continue;
      if (v.analyte_id) lookup.set(v.analyte_id, num);
      if (v.lab_analyte_id) lookup.set(v.lab_analyte_id, num);
      if (v.parameter) lookup.set(v.parameter.toLowerCase(), num);
      if (v.parameter) lookup.set(toVariableSlug(v.parameter), num);
    }

    return values.map(v => {
      if (!v.is_calculated || !v.formula) return v;

      // Normalize math syntax before token scanning.
      let formula = v.formula.trim()
        .replace(/\bpow\s*\(/g, 'Math.pow(')
        .replace(/\^/g, '**');

      const analyteRef = testGroups.flatMap(tg => tg.analytes).find(a => a.id === v.analyte_id || a.name === v.parameter);
      const vars = parseVars(analyteRef?.formula_variables ?? null);
      const analyteSliceDeps = getPreferredDepsForCalculated(
        calcDeps,
        v.analyte_id,
        v.lab_analyte_id,
        new Set(lookup.keys()),
      );
      const scope: Record<string, number> = {};

      // Phase 1: replace formula_variables — don't return early on miss.
      for (const variable of vars) {
        const key = variable.toLowerCase();
        const dep = analyteSliceDeps.find(d => d.variable_name.toLowerCase() === key);

        let val: number | undefined =
          dep?.source_lab_analyte_id ? lookup.get(dep.source_lab_analyte_id) : undefined;
        if (val === undefined) val = dep ? lookup.get(dep.source_analyte_id) : undefined;
        if (val === undefined) val = lookup.get(key);
        if (val === undefined && dep) {
          const srcAnalyte = testGroups
            .flatMap(tg => tg.analytes)
            .find(a =>
              ((a as any).lab_analyte_id && dep.source_lab_analyte_id && (a as any).lab_analyte_id === dep.source_lab_analyte_id) ||
              a.id === dep.source_analyte_id
            );
          if (srcAnalyte?.name) {
            val = lookup.get(srcAnalyte.name.toLowerCase());
            if (val === undefined) {
              val = lookup.get(toVariableSlug(srcAnalyte.name));
            }
          }
        }

        if (val !== undefined) {
          scope[variable] = val;
          scope[variable.toUpperCase()] = val;
          scope[variable.toLowerCase()] = val;
          formula = formula.replace(new RegExp(`\\b${variable}\\b`, "g"), String(val));
        }
      }

      if (normalizeCalculationResultType(v.calculation_result_type) === 'text') {
        const textResult = evaluateTextCalculation(v.formula, scope);
        return textResult.success ? { ...v, value: textResult.value, flag: '' } : v;
      }

      // Phase 2: resolve remaining alphabetic tokens (handles code/alias mismatches).
      const remainingTokens = formula.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) || [];
      for (const token of remainingTokens) {
        if (RECALC_MATH_BUILTINS.has(token.toLowerCase())) continue;
        const tokenKey = token.toLowerCase();
        const dep = analyteSliceDeps.find(d => d.variable_name.toLowerCase() === tokenKey);
        let val: number | undefined = dep?.source_lab_analyte_id ? lookup.get(dep.source_lab_analyte_id) : undefined;
        if (val === undefined && dep) val = lookup.get(dep.source_analyte_id);
        if (val === undefined) val = lookup.get(tokenKey);
        if (val === undefined) return v; // keep old value
        scope[token] = val;
        scope[token.toUpperCase()] = val;
        scope[token.toLowerCase()] = val;
        formula = formula.replace(new RegExp(`\\b${token}\\b`, "g"), String(val));
      }

      try {
        // eslint-disable-next-line no-new-func
        const computed = Function(`"use strict"; return (${formula});`)();
        if (!Number.isFinite(computed)) return v;
        return { ...v, value: String(Math.round(computed * 10000) / 10000) };
      } catch { return v; }
    });
  }, [testGroups, calcDeps, order, getPreferredDepsForCalculated]);

  const getCalculatedDebugInfo = React.useCallback((value: ExtractedValue) => {
    if (!value.is_calculated) return null;

    const toVariableSlug = (name: string): string => {
      const abbrevMap: Record<string, string> = {
        'total cholesterol': 'TC', 'hdl cholesterol': 'HDL', 'ldl cholesterol': 'LDL',
        'triglycerides': 'TG', 'hemoglobin': 'HGB', 'hematocrit': 'HCT',
        'red blood cell': 'RBC', 'white blood cell': 'WBC', 'platelet': 'PLT',
        'mean corpuscular volume': 'MCV', 'mean corpuscular hemoglobin': 'MCH',
        'albumin': 'ALB', 'globulin': 'GLOB', 'total protein': 'TP',
        'creatinine': 'CREAT', 'blood urea nitrogen': 'BUN', 'urea': 'UREA',
        'glucose': 'GLU', 'calcium': 'CA', 'sodium': 'NA', 'potassium': 'K',
      };
      const lower = name.toLowerCase();
      for (const [full, abbrev] of Object.entries(abbrevMap)) {
        if (lower.includes(full)) return abbrev.toLowerCase();
      }
      const words = name.replace(/[^a-zA-Z0-9\s]/g, '').split(/\s+/).filter(Boolean);
      if (words.length === 0) return "";
      if (words.length === 1) return words[0].substring(0, 4).toLowerCase();
      return words.map(w => w.substring(0, 3)).join('').toLowerCase().substring(0, 6);
    };

    const toNumberLocal = (raw: string | number | null | undefined): number | null => {
      if (raw === null || raw === undefined || raw === "") return null;
      const parsed = Number(String(raw).replace(/,/g, "").trim());
      return Number.isFinite(parsed) ? parsed : null;
    };

    const analyteObj = testGroups.flatMap(tg => tg.analytes).find((a: any) => a.id === value.analyte_id || a.name === value.parameter);
    if (!analyteObj?.formula) return null;

    const lookup = new Map<string, number>();
    for (const tg of testGroups) {
      for (const a of tg.analytes) {
        if (a.is_calculated) continue;
        const num = toNumberLocal(a.existing_result?.value);
        if (num !== null) {
          if (a.id) lookup.set(a.id, num);
          if ((a as any).lab_analyte_id) lookup.set((a as any).lab_analyte_id, num);
          if (a.name) {
            lookup.set(a.name.toLowerCase(), num);
            const slug = toVariableSlug(a.name);
            if (slug) lookup.set(slug, num);
          }
        }
      }
    }
    for (const mv of manualValues) {
      if (mv.is_calculated) continue;
      const num = toNumberLocal(mv.value);
      if (num !== null) {
        if (mv.analyte_id) lookup.set(mv.analyte_id, num);
        if (mv.lab_analyte_id) lookup.set(mv.lab_analyte_id, num);
        if (mv.parameter) {
          lookup.set(mv.parameter.toLowerCase(), num);
          const slug = toVariableSlug(mv.parameter);
          if (slug) lookup.set(slug, num);
        }
      }
    }

    const deps = getPreferredDepsForCalculated(
      calcDeps,
      value.analyte_id,
      value.lab_analyte_id,
      new Set(lookup.keys()),
    );
    const dependencies = deps.map((dep) => {
      const sourceAnalyte = testGroups
        .flatMap(tg => tg.analytes)
        .find((a: any) =>
          (dep.source_lab_analyte_id && (a as any).lab_analyte_id === dep.source_lab_analyte_id) ||
          a.id === dep.source_analyte_id
        );
      let resolvedValue =
        (dep.source_lab_analyte_id ? lookup.get(dep.source_lab_analyte_id) : undefined) ??
        lookup.get(dep.source_analyte_id);
      if (resolvedValue === undefined && sourceAnalyte?.name) {
        resolvedValue = lookup.get(sourceAnalyte.name.toLowerCase());
        if (resolvedValue === undefined) {
          const slug = toVariableSlug(sourceAnalyte.name);
          if (slug) resolvedValue = lookup.get(slug);
        }
      }
      return {
        variable: dep.variable_name,
        sourceName: sourceAnalyte?.name || dep.source_analyte_id?.slice(0, 8) || dep.variable_name,
        value: resolvedValue,
      };
    });

    const missing = dependencies.filter((dep) => dep.value === undefined).map((dep) => dep.variable);
    return {
      formula: analyteObj.formula,
      dependencies,
      missing,
      hasDependencies: dependencies.length > 0,
    };
  }, [manualValues, testGroups, calcDeps, getPreferredDepsForCalculated]);

	  const handleManualValueChange = React.useCallback((index: number, field: keyof ExtractedValue, value: string) => {
    setManualValues((prev) => {
      const updated = prev.map((item, i) => {
        if (i !== index) return item;
        if (item.is_calculated && field === "value") return item;
        return {
          ...item,
          [field]: value,
          ...(field === "value" ? { interface_conversion_pending: true } : {}),
        };
      });
      // Recompute calculated analytes whenever a numeric value changes
      if (field === "value") return recomputeCalculatedValues(updated);
      return updated;
    });
	  }, [recomputeCalculatedValues]);

  const handleManualValueBlur = React.useCallback((index: number, rawValue: string) => {
    setManualValues((prev) => {
      const updated = prev.map((item, i) => {
        if (i !== index || item.is_calculated || !item.interface_conversion_pending) return item;
        const convertedValue = applyAnalyteInterfaceConversion(
          rawValue,
          item.interface_config,
          "manual",
        );
        return {
          ...item,
          value: convertedValue,
          unit: item.interface_config &&
            isAnalyteInterfaceConversionEnabled(item.interface_config, "manual")
            ? item.interface_config.lims_unit || item.unit
            : item.unit,
          flag: calculateFlag(convertedValue, item.reference || '') || item.flag,
          interface_conversion_pending: false,
        };
      });
      return recomputeCalculatedValues(updated);
    });
  }, [recomputeCalculatedValues]);

	  const toggleManualValueHidden = React.useCallback((index: number) => {
	    setManualValues((prev) =>
	      prev.map((item, i) => {
	        if (i !== index) return item;
	        const nextHidden = !item.is_hidden_from_report;
	        return {
	          ...item,
	          is_hidden_from_report: nextHidden,
	          hidden_reason: nextHidden ? (item.hidden_reason || "Hidden from report") : "",
	        };
	      })
	    );
	  }, []);

  // Popout input helpers
  const openPopoutInput = (
    index: number,
    fieldName: keyof ExtractedValue,
    currentValue: string,
    parameterName: string
  ) => {
    if (fieldName === 'value' && manualValues[index]?.is_calculated) return;

    const suggestions = fieldName === 'unit'
      ? ['mg/dL', 'g/dL', 'mmol/L', 'IU/L', 'ng/mL', '%', 'cells/μL', 'K/uL', 'M/uL', 'fl', 'pg']
      : fieldName === 'reference'
        ? ['Normal', 'See lab reference', '0.5-1.2 mg/dL', '70-99 mg/dL', '4 - 11', '4.5 - 5.5', '11.5 - 14.5', '80 - 100', '27 - 31', '32 - 36']
        : [];

    setPopoutInput({
      isOpen: true,
      field: { index, fieldName },
      title: `Enter ${fieldName} for ${parameterName}`,
      placeholder: `Enter ${fieldName}...`,
      suggestions
    });
  };

  const getDefaultReferenceRangeForValue = React.useCallback((value: Pick<ExtractedValue, "analyte_id" | "parameter">) => {
    const analyteMatch = orderAnalytes.find((analyte: any) =>
      (value.analyte_id && analyte.id === value.analyte_id) || analyte.name === value.parameter
    );
    if (analyteMatch?.reference_range) return analyteMatch.reference_range;

    for (const group of testGroups) {
      const testAnalyte = group.analytes.find((analyte) =>
        (value.analyte_id && analyte.id === value.analyte_id) || analyte.name === value.parameter
      );
      if (testAnalyte?.reference_range) return testAnalyte.reference_range;
    }

    return "";
  }, [orderAnalytes, testGroups]);

  const unlockReferenceRange = React.useCallback((index: number) => {
    setManualValues((prev) =>
      prev.map((item, i) => {
        if (i !== index) return item;
        return {
          ...item,
          reference: getDefaultReferenceRangeForValue(item),
          reference_locked: false,
        };
      })
    );
  }, [getDefaultReferenceRangeForValue]);

  const handlePopoutSave = (value: string) => {
    if (!popoutInput) return;
    const { index, fieldName } = popoutInput.field;
    if (fieldName === "reference") {
      setManualValues((prev) =>
        prev.map((item, i) => {
          if (i !== index) return item;
          return {
            ...item,
            reference: value,
            reference_locked: true,
          };
        })
      );
    } else {
      if (fieldName === "value") {
        setManualValues((prev) => {
          const updated = prev.map((item, i) => {
            if (i !== index || item.is_calculated) return item;
            const convertedValue = applyAnalyteInterfaceConversion(
              value,
              item.interface_config,
              "manual",
            );
            return {
              ...item,
              value: convertedValue,
              unit: item.interface_config &&
                isAnalyteInterfaceConversionEnabled(item.interface_config, "manual")
                ? item.interface_config.lims_unit || item.unit
                : item.unit,
              flag: calculateFlag(convertedValue, item.reference || '') || item.flag,
              interface_conversion_pending: false,
            };
          });
          return recomputeCalculatedValues(updated);
        });
      } else {
        handleManualValueChange(index, fieldName, value);
      }
    }
    setPopoutInput(null);
  };

  const handleSaveDraft = async () => {
    const actionableRows = manualValues.filter((v) => !v.is_calculated);
	    const validResults = actionableRows.filter((v) =>
	      (v.value && typeof v.value === 'string' && v.value.trim() !== "") || v.is_hidden_from_report
	    );
    if (!validResults.length) {
      alert("Please enter at least one test result before saving draft.");
      return;
    }

    const savedScrollTop = modalScrollRef.current?.scrollTop ?? 0;

    setSavingDraft(true);
    setSaveMessage(null);

    try {
      const [currentUser, userLabId] = await Promise.all([
        supabase.auth.getUser(),
        database.getCurrentUserLabId()
      ]);

      const getGroupKey = (tg: Pick<TestGroupResult, "test_group_id" | "order_test_group_id" | "order_test_id">) => {
        if (tg.order_test_group_id) return `otg:${tg.order_test_group_id}`;
        if (tg.order_test_id) return `ot:${tg.order_test_id}`;
        return `tg:${tg.test_group_id}`;
      };

      const { data: existingRows, error: existingRowsError } = await supabase
        .from("results")
        .select("id, test_group_id, order_test_group_id, order_test_id")
        .eq("order_id", order.id);
      if (existingRowsError) throw existingRowsError;

      const existingResultRowByGroupKey = new Map<string, string>();
      for (const row of existingRows || []) {
        if (row.order_test_group_id) existingResultRowByGroupKey.set(`otg:${row.order_test_group_id}`, row.id);
        if (row.order_test_id) existingResultRowByGroupKey.set(`ot:${row.order_test_id}`, row.id);
        if (row.test_group_id) existingResultRowByGroupKey.set(`tg:${row.test_group_id}`, row.id);
      }

      for (const testGroup of testGroups) {
        const rowsToPersist = validResults.filter((v) =>
          testGroup.analytes.some((a) =>
            (v.analyte_id && a.id === v.analyte_id) || a.name === v.parameter
          )
        );
        if (rowsToPersist.length === 0) continue;

        const groupKey = getGroupKey(testGroup);
        let resultRowId = existingResultRowByGroupKey.get(groupKey) || null;

        if (!resultRowId) {
          const { data: savedResult, error: resultError } = await supabase
            .from("results")
            .upsert({
              order_id: order.id,
              patient_id: order.patient_id,
              patient_name: order.patient_name,
              test_name: testGroup.test_group_name,
              status: "Entered",
              verification_status: null,
              entered_by: currentUser.data.user?.email || "Unknown User",
              entered_date: new Date().toISOString().split("T")[0],
              test_group_id: testGroup.test_group_id,
              lab_id: userLabId,
              ...(testGroup.order_test_group_id && { order_test_group_id: testGroup.order_test_group_id }),
              ...(testGroup.order_test_id && { order_test_id: testGroup.order_test_id }),
            }, { onConflict: "order_id,test_name", ignoreDuplicates: false })
            .select("id")
            .single();
          if (resultError) throw resultError;
          resultRowId = savedResult.id;
          existingResultRowByGroupKey.set(groupKey, resultRowId);
        } else {
          const { error: resultUpdateError } = await supabase
            .from("results")
            .update({
              status: "Entered",
              verification_status: null,
              entered_by: currentUser.data.user?.email || "Unknown User",
              entered_date: new Date().toISOString().split("T")[0],
              lab_id: userLabId,
            })
            .eq("id", resultRowId);
          if (resultUpdateError) throw resultUpdateError;
        }

        const analyteIdsToDelete = rowsToPersist
          .map((r) => r.analyte_id || testGroup.analytes.find((a) => a.name === r.parameter)?.id)
          .filter(Boolean) as string[];
        if (analyteIdsToDelete.length > 0) {
          const { error: deleteError } = await supabase
            .from("result_values")
            .delete()
            .eq("result_id", resultRowId)
            .in("analyte_id", analyteIdsToDelete);
          if (deleteError) throw deleteError;
        }

        const resultValuesData = rowsToPersist.map((r) => {
          const analyte = testGroup.analytes.find((a) => a.id === r.analyte_id)
            || testGroup.analytes.find((a) => a.name?.trim().toLowerCase() === r.parameter?.trim().toLowerCase());
          const autoFlag = r.flag || calculateFlag(r.value, r.reference || "");
          return {
            result_id: resultRowId!,
            analyte_id: analyte?.id || r.analyte_id || undefined,
            lab_analyte_id: analyte?.lab_analyte_id || null,
            analyte_name: r.parameter,
            parameter: r.parameter,
            value: r.value && r.value.trim() !== "" ? r.value : null,
            unit: r.unit || "",
            reference_range: r.reference || "",
            ...rangeAuditFor(r, analyte),
            flag: normalizeResultFlagForSave(autoFlag, r.value),
            flag_source: r.flag ? 'manual' : 'auto_numeric',
            is_auto_calculated: !!r.is_calculated,
            order_id: order.id,
            test_group_id: testGroup.test_group_id,
            lab_id: userLabId,
	            verify_status: r.is_hidden_from_report ? 'approved' : 'pending',
	            is_hidden_from_report: !!r.is_hidden_from_report,
	            hidden_reason: r.is_hidden_from_report ? (r.hidden_reason || "Hidden from report") : null,
            ...(testGroup.order_test_group_id && { order_test_group_id: testGroup.order_test_group_id }),
            ...(testGroup.order_test_id && { order_test_id: testGroup.order_test_id }),
          };
        });

        const { error: valuesError } = await supabase.from("result_values").insert(resultValuesData);
        if (valuesError) throw valuesError;
      }

      setSaveMessage("Draft saved successfully!");

      await Promise.allSettled([
        fetchReadonlyResults(),
        fetchProgressView(),
        fetchExistingResult(),
      ]);

      // Call the callback if provided
      if (onAfterSaveDraft) {
        await onAfterSaveDraft();
      }

      // Restore scroll position after state updates
      requestAnimationFrame(() => {
        if (modalScrollRef.current) {
          modalScrollRef.current.scrollTop = savedScrollTop;
        }
      });

      setTimeout(() => setSaveMessage(null), 3000);
    } catch (err) {
      console.error("Error saving draft:", err);
      setSaveMessage("Failed to save draft. Please try again.");
      requestAnimationFrame(() => {
        if (modalScrollRef.current) {
          modalScrollRef.current.scrollTop = savedScrollTop;
        }
      });
      setTimeout(() => setSaveMessage(null), 5000);
    } finally {
      setSavingDraft(false);
    }
  };

	  const handleSubmitResults = async () => {
	    const actionableRows = manualValues.filter((v) => !v.is_calculated);
	    const validResults = actionableRows.filter((v) =>
	      (v.value && typeof v.value === 'string' && v.value.trim() !== "") || v.is_hidden_from_report
	    );
    const savedScrollTop = modalScrollRef.current?.scrollTop ?? 0;

    // If only calculated rows are pending (no manual-entry analytes), allow workflow to continue.
    if (!validResults.length && actionableRows.length > 0) {
      alert("Please enter at least one test result.");
      return;
    }

    setSubmittingResults(true);
    setSaveMessage(null);

    // Initial clone for mutation by AI
    const finalResults = validResults.map(v => ({ ...v }));

    try {
      // 1. AUTO-RESOLVE RANGES for test groups with AI enabled
      const groupsToResolve = testGroups.filter(tg =>
        tg.ref_range_ai_config?.enabled === true
      );

      if (groupsToResolve.length > 0) {
        setSaveMessage(`Auto-resolving ranges for ${groupsToResolve.length} group(s)...`);
        const { findResolvedReferenceRange, resolveReferenceRanges } = await import('../../utils/referenceRangeService');

        for (const tg of groupsToResolve) {
          const payload = tg.analytes.map(a => {
            const vItem = finalResults.find(v => v.parameter === a.name);
            return {
              id: a.id,
              lab_analyte_id: a.lab_analyte_id || null,
              name: a.name,
              value: vItem?.value || '',
              unit: a.units || vItem?.unit || ''
            };
          });

          try {
            const resolved = await resolveReferenceRanges(order.id, tg.test_group_id, payload);
            resolved?.forEach(r => {
              if (r.used_reference_range) {
                const target = finalResults.find(v => findResolvedReferenceRange([r], v));
                if (target && !target.reference_locked) {
                  target.reference = r.used_reference_range;
                  (target as any).range_source = "ai";
                  (target as any).applied_range_rule = r.applied_rule || null;
                  if (r.flag && ['H', 'L', 'C', 'LL', 'HH', 'H*', 'L*', 'high', 'low', 'critical_h', 'critical_l', 'critical_high', 'critical_low'].includes(r.flag)) target.flag = r.flag;
                }
              }
            });
          } catch (aiErr) {
            console.warn(`Failed to auto-resolve group ${tg.test_group_name}`, aiErr);
          }
        }
      }

      setSaveMessage("Saving results...");

      const [currentUser, userLabId] = await Promise.all([
        supabase.auth.getUser(),
        database.getCurrentUserLabId()
      ]);

      // Determine which test groups to save to based on attachment info
      // If image was test-specific, only save to that test group
      let targetTestGroupsForSave = testGroups;

      // Parse ai_metadata if it's a string
      let attachmentAiMeta = activeAttachment?.ai_metadata;
      if (typeof attachmentAiMeta === 'string') {
        try {
          attachmentAiMeta = JSON.parse(attachmentAiMeta);
        } catch (e) {
          attachmentAiMeta = {};
        }
      }

      const saveToOrderTestId = activeAttachment?.order_test_id;
      const saveToTestGroupId = attachmentAiMeta?.test_group_id || activeAttachment?.metadata?.test_group_id;

      if (saveToOrderTestId || saveToTestGroupId) {
        // Filter to only the target test group
        targetTestGroupsForSave = testGroups.filter((tg) =>
          (saveToOrderTestId && tg.order_test_id === saveToOrderTestId) ||
          (saveToTestGroupId && tg.test_group_id === saveToTestGroupId)
        );
        console.log(`[SAVE] Test-specific image - only saving to ${targetTestGroupsForSave.length} test group(s):`,
          targetTestGroupsForSave.map(tg => tg.test_group_name));
      } else {
        console.log('[SAVE] Order-level image - saving to all matching test groups');
      }

      // Prefetch outsourced status once to avoid one query per test group.
      const targetTestGroupIds = Array.from(new Set(
        targetTestGroupsForSave
          .map((tg) => tg.test_group_id)
          .filter((id): id is string => typeof id === "string" && !!id)
      ));
      const outsourcedTestGroupIds = new Set<string>();
      if (targetTestGroupIds.length > 0) {
        const { data: orderTestRows, error: orderTestRowsError } = await supabase
          .from('order_tests')
          .select('test_group_id, outsourced_lab_id')
          .eq('order_id', order.id)
          .in('test_group_id', targetTestGroupIds);
        if (orderTestRowsError) throw orderTestRowsError;
        for (const row of orderTestRows || []) {
          if (row.test_group_id && row.outsourced_lab_id) outsourcedTestGroupIds.add(row.test_group_id);
        }
      }

      const submittedRowsForUx: ExtractedValue[] = [];
      const submittedRowsByTestGroup = new Map<string, ExtractedValue[]>();
      const bulkGroups: any[] = [];

      const toNumber = (raw: string | number | null | undefined): number | null => {
        if (raw === null || raw === undefined) return null;
        const parsed = Number(String(raw).trim());
        return Number.isFinite(parsed) ? parsed : null;
      };

      const addLookupAliases = (
        lookup: Map<string, number>,
        analyteName: string | undefined,
        analyteCode: string | undefined,
        value: string | number | null | undefined
      ) => {
        const num = toNumber(value);
        if (num === null) return;

        const name = (analyteName || "").trim();
        const code = (analyteCode || "").trim();
        if (name) lookup.set(name.toLowerCase(), num);
        if (code) lookup.set(code.toLowerCase(), num);

        if (name) {
          const acronym = (name.match(/\b[A-Z0-9]{2,}\b/g) || []).join(" ").trim();
          if (acronym) {
            acronym.split(/\s+/).forEach((token) => lookup.set(token.toLowerCase(), num));
          }
        }
      };

      const parseFormulaVariables = (formulaVariables: string[] | string | null | undefined): string[] => {
        if (!formulaVariables) return [];
        if (Array.isArray(formulaVariables)) return formulaVariables.filter(Boolean);
        try {
          const parsed = JSON.parse(formulaVariables);
          return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
        } catch {
          return [];
        }
      };

      // ── Future-proof calculated parameter evaluation ──────────────────────
      // Fetch analyte_dependencies for ALL calculated analytes across all test
      // groups in one query.  Each row maps:
      //   calculated_analyte_id  → the analyte whose value we compute
      //   source_analyte_id      → the UUID of the input analyte
      //   variable_name          → the token used in the formula  (e.g. "TG")
      //
      // This means any new calculated parameter only needs a row here – no
      // code/naming convention in the analyte record is required.
      const allCalcAnalyteIds = targetTestGroupsForSave
        .flatMap((tg) => tg.analytes.filter((a) => a.is_calculated).map((a) => a.id))
        .filter(Boolean) as string[];

      type DepRow = { calculated_analyte_id: string; calculated_lab_analyte_id?: string | null; source_analyte_id: string; source_lab_analyte_id?: string | null; variable_name: string };
      let allDeps: DepRow[] = [];
      if (allCalcAnalyteIds.length > 0) {
        const { data: depsData } = await supabase
          .from('analyte_dependencies')
          .select('calculated_analyte_id, calculated_lab_analyte_id, source_analyte_id, source_lab_analyte_id, variable_name, lab_id')
          .in('calculated_analyte_id', allCalcAnalyteIds)
          .or(`lab_id.eq.${order.lab_id},lab_id.is.null`);
        allDeps = (depsData || []) as DepRow[];
      }

      // evaluateCalculatedValue now receives the deps slice for this analyte.
      // Resolution order:
      //   1. source_analyte_id key in valueLookup  (UUID — always unique)
      //   2. variable_name key  (lowercased)        (dep-based fallback)
      //   3. analyte name / code keys               (legacy / no-dep fallback)
      const EVAL_MATH_BUILTINS = new Set(['math', 'pow', 'abs', 'sqrt', 'min', 'max', 'ceil', 'floor', 'round', 'log', 'exp']);

      const evaluateCalculatedValue = (
        analyte: TestGroupResult["analytes"][number],
        valueLookup: Map<string, number>,
        deps: DepRow[]
      ): string => {
        const formula = analyte.formula?.trim();
        if (!formula) return "";

        const variables = parseFormulaVariables(analyte.formula_variables);

        // Normalize math syntax before token scanning.
        let resolved = formula
          .replace(/\bpow\s*\(/g, 'Math.pow(')
          .replace(/\^/g, '**');

        const analyteDepSlice = deps.filter(
          (d) =>
            (analyte.lab_analyte_id && d.calculated_lab_analyte_id === analyte.lab_analyte_id) ||
            (!d.calculated_lab_analyte_id && d.calculated_analyte_id === analyte.id)
        );
        const scope: Record<string, number> = {};

        // Phase 1: replace variables from formula_variables — don't return early on miss.
        for (const variable of variables) {
          const variableKey = String(variable || "").trim().toLowerCase();
          if (!variableKey) continue;

          const dep = analyteDepSlice.find((d) => d.variable_name.toLowerCase() === variableKey);
          let variableValue: number | undefined =
            dep?.source_lab_analyte_id ? valueLookup.get(dep.source_lab_analyte_id) : undefined;

          if (variableValue === undefined)
            variableValue = dep ? valueLookup.get(dep.source_analyte_id) : undefined;

          if (variableValue === undefined)
            variableValue = valueLookup.get(variableKey);

          if (variableValue === undefined) {
            const fallbackMatch = Array.from(valueLookup.entries()).find(
              ([key]) =>
                typeof key === 'string' && key.length <= 20 &&
                (key === variableKey || key.includes(variableKey) || variableKey.includes(key))
            );
            variableValue = fallbackMatch?.[1];
          }

          if (variableValue !== undefined) {
            scope[String(variable)] = variableValue;
            scope[String(variable).toUpperCase()] = variableValue;
            scope[String(variable).toLowerCase()] = variableValue;
            const escapedVar = String(variable).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            resolved = resolved.replace(new RegExp(`\\b${escapedVar}\\b`, "g"), String(variableValue));
          }
        }

        if (normalizeCalculationResultType((analyte as any).calculation_result_type) === 'text') {
          return evaluateTextCalculation(formula, scope).value;
        }

        // Phase 2: resolve remaining alphabetic tokens (handles code/alias mismatches).
        const remainingTokens = resolved.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) || [];
        for (const token of remainingTokens) {
          if (EVAL_MATH_BUILTINS.has(token.toLowerCase())) continue;
          const tokenKey = token.toLowerCase();
          const dep = analyteDepSlice.find((d) => d.variable_name.toLowerCase() === tokenKey);
          let val: number | undefined = dep?.source_lab_analyte_id ? valueLookup.get(dep.source_lab_analyte_id) : undefined;
          if (val === undefined && dep) val = valueLookup.get(dep.source_analyte_id);
          if (val === undefined) val = valueLookup.get(tokenKey);
          if (val === undefined) return "";
          scope[token] = val;
          scope[token.toUpperCase()] = val;
          scope[token.toLowerCase()] = val;
          resolved = resolved.replace(new RegExp(`\\b${token}\\b`, "g"), String(val));
        }

        try {
          const computed = Function(`"use strict"; return (${resolved});`)();
          if (!Number.isFinite(computed)) return "";
          return String(Math.round(Number(computed) * 10000) / 10000);
        } catch {
          return "";
        }
      };

      for (const testGroup of targetTestGroupsForSave) {
        // Manual/AI entered rows for this group
        const testGroupResults = finalResults.filter((v) => testGroup.analytes.some((a) => a.name === v.parameter));

        const valueLookup = new Map<string, number>();
        for (const analyte of testGroup.analytes) {
          const manual = manualValues.find((v) => v.analyte_id === analyte.id) || manualValues.find((v) => v.parameter === analyte.name);
          const aiOrManual = testGroupResults.find((v) => v.analyte_id === analyte.id) || testGroupResults.find((v) => v.parameter === analyte.name);
          const val = aiOrManual?.value ?? manual?.value ?? analyte.existing_result?.value;
          // Store by UUID (primary key — always unique, no naming convention needed)
        if (analyte.id) {
          const num = toNumber(val);
          if (num !== null) valueLookup.set(analyte.id, num);
          if (num !== null && analyte.lab_analyte_id) valueLookup.set(analyte.lab_analyte_id, num);
        }
          addLookupAliases(valueLookup, analyte.name, analyte.code, val);
        }

        // Always derive calculated rows from analyte definitions so they are persisted even if hidden in manualValues
        const calculatedRowsForGroup: ExtractedValue[] = testGroup.analytes
          .filter((a) => !!a.is_calculated)
          .map((a) => {
            const manual = manualValues.find((v) => v.analyte_id === a.id) || manualValues.find((v) => v.parameter === a.name);
            // Pass only deps for this specific calculated analyte
            const analyteDepSlice = getPreferredDepsForCalculated(
              allDeps,
              a.id,
              (a as any).lab_analyte_id || null,
              new Set(valueLookup.keys()),
            );
            const calculatedValue = evaluateCalculatedValue(a, valueLookup, analyteDepSlice);
            return {
              analyte_id: a.id,
              parameter: a.name,
              value: manual?.value?.trim() ? manual.value : calculatedValue,
              unit: manual?.unit || a.units || "",
	              reference: manual?.reference || a.reference_range || "",
	              flag: manual?.flag,
	              is_calculated: true,
	              is_hidden_from_report: !!manual?.is_hidden_from_report,
	              hidden_reason: manual?.hidden_reason || "",
	            };
	          })
	          .filter((row) => hasMeaningfulTextValue(row.value) || row.is_hidden_from_report);

        const rowsToPersist = [...testGroupResults, ...calculatedRowsForGroup].reduce<ExtractedValue[]>((acc, row) => {
          if (!acc.some((r) => r.analyte_id === row.analyte_id || r.parameter === row.parameter)) {
            acc.push(row);
          }
          return acc;
        }, []);
        if (rowsToPersist.length === 0) continue;

        const resultValuesData = rowsToPersist.map((r) => {
          const analyte = testGroup.analytes.find((a) => a.name === r.parameter)
            || testGroup.analytes.find((a) => a.name?.trim().toLowerCase() === r.parameter?.trim().toLowerCase())
            || (r.analyte_id ? testGroup.analytes.find((a) => a.id === r.analyte_id) : undefined);
          // If user explicitly set a flag (via dropdown or flag mapping), mark as manual so AI won't overwrite
          const hasUserFlag = !!r.flag;
          const autoFlag = r.flag || calculateFlag(r.value, r.reference || '');
          return {
            analyte_id: analyte?.id || r.analyte_id || undefined,
            lab_analyte_id: analyte?.lab_analyte_id || null,
            analyte_name: r.parameter,
            parameter: r.parameter,
            value: r.value && r.value.trim() !== "" ? r.value : null,
            unit: r.unit || "",
            reference_range: r.reference || "",
            ...rangeAuditFor(r, analyte),
	            flag: normalizeResultFlagForSave(autoFlag, r.value),
	            flag_source: hasUserFlag ? 'manual' : 'auto_numeric',
	            is_auto_calculated: !!r.is_calculated,
	            verify_status: r.is_hidden_from_report ? 'approved' : 'pending',
	            is_hidden_from_report: !!r.is_hidden_from_report,
	            hidden_reason: r.is_hidden_from_report ? (r.hidden_reason || "Hidden from report") : null,
          };
        });

        bulkGroups.push({
          test_group_id: testGroup.test_group_id,
          order_test_group_id: testGroup.order_test_group_id || null,
          order_test_id: testGroup.order_test_id || null,
          test_name: testGroup.test_group_name,
          locked_mode: "skip",
          extracted_by_ai: !!attachmentId,
          ai_confidence: ocrResults?.metadata?.ocrConfidence || null,
          attachment_id: attachmentId || null,
          values: resultValuesData,
        });
        submittedRowsByTestGroup.set(testGroup.test_group_id, rowsToPersist);
      }

      const { data: bulkSave, error: bulkSaveError } = await supabase.rpc("save_result_entry_bulk", {
        p_order_id: order.id,
        p_patient_id: order.patient_id,
        p_patient_name: order.patient_name,
        p_lab_id: userLabId,
        p_entered_by: currentUser.data.user?.email || "Unknown User",
        p_auto_verify: false,
        p_groups: bulkGroups,
      });
      if (bulkSaveError) throw bulkSaveError;

      for (const saved of (bulkSave as any)?.result_ids || []) {
        if (!saved.test_group_id || saved.locked) continue;
        submittedRowsForUx.push(...(submittedRowsByTestGroup.get(saved.test_group_id) || []));

        if (!outsourcedTestGroupIds.has(saved.test_group_id)) {
          database.inventory.triggerAutoConsume({
            labId: userLabId,
            orderId: order.id,
            resultId: saved.result_id || undefined,
            testGroupId: saved.test_group_id,
          }).catch(err => console.warn('Inventory auto-consume failed (non-blocking):', err));
        }
      }

      try {
        setSaveMessage("Finalizing flags and reference details...");
        const { runAIFlagAnalysis } = await import('../../utils/aiFlagAnalysis');
        await runAIFlagAnalysis(order.id, { applyToDatabase: true, createAudit: true, useAIService: true });
      } catch (flagErr) {
        console.warn('AI flag analysis failed:', flagErr);
      }

      // Local immediate UX: hide submitted analytes now
      markAnalytesAsSubmitted(submittedRowsForUx.length > 0 ? submittedRowsForUx : finalResults);

      // Refresh read-only view + progress ONCE after all saves complete
      fetchReadonlyResults();
      fetchProgressView();

      setSaveMessage("Successfully saved test results!");

      // Restore scroll position after state updates from fetchReadonlyResults/fetchProgressView
      requestAnimationFrame(() => {
        if (modalScrollRef.current) {
          modalScrollRef.current.scrollTop = savedScrollTop;
        }
      });

      // Notify parent and close modal shortly after success
      setTimeout(() => {
        // Call whichever callback is provided
        if (onSubmitResults) {
          onSubmitResults(order.id, finalResults);
        } else if (onAfterSubmit) {
          onAfterSubmit();
        }
        onClose(); // <=== P0: close the modal after submit
      }, 500);

      setTimeout(() => setSaveMessage(null), 4000);
    } catch (err) {
      console.error("Error submitting results:", err);
      setSaveMessage("Failed to submit results. Please try again.");
      setTimeout(() => setSaveMessage(null), 5000);
    } finally {
      setSubmittingResults(false);
    }
  };

  // =========================================================
  // #endregion Draft & Submit handlers
  // =========================================================

  // =========================================================
  // #region Small render helpers
  // =========================================================

  const renderFileUpload = () => (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-2">
        Upload{" "}
        {aiProcessingConfig?.type === "vision_card"
          ? "Test Card Image"
          : aiProcessingConfig?.type === "vision_color"
            ? "Color Analysis Image"
            : "Lab Result Document"}
      </label>

      <div className="border-2 border-dashed border-purple-300 rounded-lg p-4 text-center hover:border-purple-400 transition-colors">
        {uploadedFile ? (
          <div className="space-y-3">
            <div className="flex items-center justify-center">
              <div className="bg-purple-100 p-3 rounded-full">
                <FileText className="h-8 w-8 text-purple-600" />
              </div>
            </div>
            <div>
              <div className="text-sm font-medium text-gray-900">{uploadedFile.name}</div>
              <div className="text-xs text-gray-500">{(uploadedFile.size / 1024 / 1024).toFixed(2)} MB</div>
              {aiProcessingConfig && (
                <div className="text-xs text-purple-600 mt-1">
                  AI Type: {getAIProcessingTypeLabel(aiProcessingConfig.type)}
                </div>
              )}
            </div>
            <button
              onClick={() => document.getElementById("file-upload")?.click()}
              className="text-purple-600 hover:text-purple-700 text-sm font-medium bg-purple-100 px-3 py-1 rounded"
            >
              Change File
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex justify-center">
              <div className="bg-purple-100 p-3 rounded-full">
                <Upload className="h-8 w-8 text-purple-600" />
              </div>
            </div>

            {/* Test selection for upload scope */}
            <div className="space-y-3 mb-4">
              <div className="flex items-center justify-center space-x-4">
                <label className="flex items-center text-sm">
                  <input
                    type="radio"
                    value="order"
                    checked={uploadScope === 'order'}
                    onChange={(e) => setUploadScope(e.target.value as 'order' | 'test')}
                    className="mr-2"
                  />
                  <span>Order Level</span>
                </label>
                <label className="flex items-center text-sm">
                  <input
                    type="radio"
                    value="test"
                    checked={uploadScope === 'test'}
                    onChange={(e) => setUploadScope(e.target.value as 'order' | 'test')}
                    className="mr-2"
                  />
                  <span>Test Specific</span>
                </label>
              </div>

              {/* Test selector when test-specific is selected */}
              {uploadScope === 'test' && (
                <select
                  value={selectedTestId}
                  onChange={(e) => setSelectedTestId(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-purple-500 text-sm"
                  required
                >
                  <option value="">Select a test...</option>
                  {availableOrderTests.map(test => (
                    <option key={test.id} value={test.id}>
                      {test.name}
                    </option>
                  ))}
                </select>
              )}

              {uploadScope === 'test' && !selectedTestId && (
                <p className="text-xs text-amber-600 text-center">
                  Please select a test to upload a test-specific attachment
                </p>
              )}
            </div>

            {/* Optimization Settings */}
            <div className="bg-blue-50 rounded-lg p-3 border border-blue-200">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  <input
                    type="checkbox"
                    id="enable-optimization"
                    checked={enableOptimization}
                    onChange={(e) => setEnableOptimization(e.target.checked)}
                    className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                  />
                  <label htmlFor="enable-optimization" className="text-sm font-medium text-gray-700">
                    Optimize images before upload
                  </label>
                </div>
              </div>
              <p className="text-xs text-gray-500 mt-1">
                Reduces file size by up to 70% while maintaining quality. Recommended for faster uploads.
              </p>

              {/* Optimization Progress */}
              {optimizationProgress && (
                <div className="mt-3 p-2 bg-white rounded border">
                  <div className="flex items-center justify-between text-xs text-gray-600 mb-1">
                    <span>Optimizing {optimizationProgress.fileName}...</span>
                    <span>{Math.round(optimizationProgress.progress)}%</span>
                  </div>
                  <div className="w-full bg-gray-200 rounded-full h-2">
                    <div
                      className="bg-blue-600 h-2 rounded-full transition-all duration-300 ease-out"
                      style={{ width: `${optimizationProgress.progress}%` }}
                    />
                  </div>
                </div>
              )}
            </div>

            <div className="space-y-3">
              {/* Single File Upload with Camera Option */}
              <div className="flex flex-col sm:flex-row gap-2 justify-center">
                <button
                  onClick={() => document.getElementById("file-upload")?.click()}
                  disabled={isUploading || (uploadScope === 'test' && !selectedTestId)}
                  className="flex items-center justify-center px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:bg-purple-400 disabled:cursor-not-allowed transition-colors min-h-touch"
                >
                  {isUploading ? (
                    <>
                      <span className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent mr-2" />
                      Uploading...
                    </>
                  ) : (
                    <>
                      <Upload className="h-4 w-4 mr-2" />
                      Single{" "}
                      {aiProcessingConfig?.type === "vision_card"
                        ? "Test Card"
                        : aiProcessingConfig?.type === "vision_color"
                          ? "Color Image"
                          : "Document"}
                    </>
                  )}
                </button>

                {/* Camera Button */}
                {isNative() && (
                  <button
                    onClick={handleCameraCapture}
                    disabled={isUploading || (uploadScope === 'test' && !selectedTestId)}
                    className="flex items-center justify-center px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:bg-green-400 disabled:cursor-not-allowed transition-colors min-h-touch"
                  >
                    <Camera className="h-4 w-4 mr-2" />
                    Camera
                  </button>
                )}
              </div>

              {/* Multi-Image Upload Button - TEMPORARILY HIDDEN */}
              <div className="text-center hidden">
                <span className="text-xs text-gray-400">or</span>
              </div>

              <button
                onClick={() => setShowMultiUpload(true)}
                disabled={isUploading || (uploadScope === 'test' && !selectedTestId)}
                className="hidden flex items-center justify-center mx-auto px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-blue-400 disabled:cursor-not-allowed transition-colors"
              >
                <Upload className="h-4 w-4 mr-2" />
                Upload Multiple Images
              </button>

              <p className="text-xs text-gray-500 mt-2">
                Single: {aiProcessingConfig?.type === "ocr_report" ? "JPG, PNG, PDF" : "JPG, PNG"} (max 10MB)<br />
                Multiple: JPG, PNG (up to 5 images, max 10MB each)
              </p>
              {aiProcessingConfig && (
                <p className="text-xs text-purple-600 mt-1">
                  Optimized for: {getAIProcessingTypeLabel(aiProcessingConfig.type)}
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      <input
        id="file-upload"
        type="file"
        accept={aiProcessingConfig?.type === "ocr_report" ? "image/*,.pdf" : "image/*"}
        onChange={handleFileInputChange}
        className="hidden"
      />
    </div>
  );

  // === AI Auto-Range Handler ===
  const handleAIResolve = async (tgId: string) => {
    const tg = testGroups.find((t) => t.test_group_id === tgId);
    if (!tg) return;

    setSaveMessage("Resolving reference ranges...");

    const payload = tg.analytes.map((a) => {
      const val = manualValues.find((mv) => mv.parameter === a.name);
      return {
        id: a.id,
        name: a.name,
        value: val?.value || "",
        unit: val?.unit || a.units || "",
      };
    });

    try {
      const { findResolvedReferenceRange, resolveReferenceRanges } = await import('../../utils/referenceRangeService');
      const resolved = await resolveReferenceRanges(order.id, tgId, payload);

      if (resolved) {
        setManualValues((prev) => {
          const next = [...prev];
          resolved.forEach((r) => {
            if (r.used_reference_range) {
              const idx = next.findIndex((n) => findResolvedReferenceRange([r], n));
              if (idx !== -1 && !next[idx].reference_locked) {
                next[idx] = {
                  ...next[idx],
                  reference: r.used_reference_range,
                  range_source: "ai",
                  applied_range_rule: r.applied_rule || null,
                } as any;
              }
            }
          });
          return next;
        });
        setSaveMessage("Ranges Applied!");
        setTimeout(() => setSaveMessage(null), 3000);
      }
    } catch (err) {
      console.error(err);
      setSaveMessage("Request Failed");
      setTimeout(() => setSaveMessage(null), 3000);
    }
  };

  // Plain function (not a React component) so it is called inline and never
  // unmounts/remounts on parent re-render, preserving input focus.
		  const renderTestGroupEntry = (testGroup: TestGroupResult, entryMode: "manual" | "ai") => {
		    const testGroupValues = testGroup.analytes
          .map((a) =>
            manualValues.find((v) =>
              (v.analyte_id && v.analyte_id === a.id) || v.parameter === a.name
            )
          )
          .filter((v): v is ExtractedValue => !!v);
	    const actionableTestGroupValues = testGroupValues.filter((v) => !v.is_calculated);
    const completedCount = actionableTestGroupValues.filter((v) => v.value && typeof v.value === 'string' && v.value.trim() !== "").length;
    const pendingCount = actionableTestGroupValues.length - completedCount;

    return (
      <div className="border border-gray-200 rounded-lg p-3 sm:p-4 mb-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
	            <h4 className="text-base sm:text-lg font-medium line-clamp-2">
	              {testGroup.test_group_name}
	            </h4>
	            {testGroup.is_section_only && (
	              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700">
	                Section-only
	              </span>
	            )}

            {/* AI Auto-Range Button */}
            <button
              type="button"
              onClick={() => handleAIResolve(testGroup.test_group_id)}
              className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-purple-700 bg-purple-50 hover:bg-purple-100 border border-purple-200 rounded transition-colors"
              title="Resolve Reference Ranges automatically"
            >
              <Brain className="w-3 h-3" />
              <span className="hidden sm:inline">Auto-Range</span>
            </button>

            {/* Sample Collection Status */}
            <div className="flex flex-wrap items-center gap-2">
              <span className={`px-2 py-1 rounded-full text-xs font-medium ${order.sample_collected_at
                ? 'bg-green-100 text-green-800'
                : 'bg-yellow-100 text-yellow-800'
                }`}>
                {order.sample_collected_at ? 'Sample Collected' : 'Sample Pending'}
              </span>

              {/* Sample Collection Action Buttons */}
              {order.sample_collected_at ? (
                <button
                  type="button"
                  onClick={handleMarkSampleNotCollected}
                  disabled={updatingCollection}
                  className="px-3 py-1 text-xs bg-red-100 text-red-700 rounded hover:bg-red-200 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {updatingCollection ? 'Updating...' : 'Mark Not Collected'}
                </button>
              ) : (
                <>
                  {showPhlebotomistSelector ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <PhlebotomistSelector
                        labId={order.lab_id}
                        value={selectedPhlebotomistId}
                        onChange={(userId, userName) => {
                          setSelectedPhlebotomistId(userId || '');
                          setSelectedPhlebotomistName(userName);
                        }}
                        className="text-xs"
                        placeholder="Select collector..."
                      />
                      <button
                        type="button"
                        onClick={handleMarkSampleCollected}
                        disabled={updatingCollection}
                        className="px-3 py-1 text-xs bg-green-100 text-green-700 rounded hover:bg-green-200 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                      >
                        {updatingCollection ? 'Collecting...' : 'Confirm'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowPhlebotomistSelector(false)}
                        disabled={updatingCollection}
                        className="px-3 py-1 text-xs bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={handleMarkSampleCollected}
                      disabled={updatingCollection}
                      className="px-3 py-1 text-xs bg-green-100 text-green-700 rounded hover:bg-green-200 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {updatingCollection ? 'Updating...' : 'Mark Collected'}
                    </button>
                  )}
                </>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
            <span className="text-sm text-gray-500">
              {completedCount}/{actionableTestGroupValues.length} completed • {pendingCount} pending
            </span>
            <div className="w-20 bg-gray-200 rounded-full h-2">
              <div
                className="bg-blue-600 h-2 rounded-full transition-all"
                style={{
                  width: `${actionableTestGroupValues.length ? (completedCount / actionableTestGroupValues.length) * 100 : 100}%`,
                }}
              />
            </div>
          </div>
        </div>

	        {entryMode === "ai" && testGroup.analytes.length > 0 && (
          <div className="mb-4 p-3 bg-purple-50 border border-purple-200 rounded-lg">
            <h5 className="text-sm font-medium text-purple-900 mb-2">AI Processing for {testGroup.test_group_name}</h5>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {testGroup.analytes.map((analyte) => (
                <div
                  key={analyte.id}
                  onClick={() => handleSelectAnalyteForAI(analyte)}
                  className={`p-2 border rounded cursor-pointer transition-all ${selectedAnalyteForAI?.id === analyte.id ? "border-purple-500 bg-purple-100" : "border-gray-200 hover:border-gray-300"
                    }`}
                >
                  <div className="text-sm font-medium">{analyte.name}</div>
                  <span
                    className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${getAIProcessingTypeColor(
                      (analyte as any).ai_processing_type || "none"
                    )}`}
                  >
                    {getAIProcessingTypeLabel((analyte as any).ai_processing_type || "none")}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

	        <div className="-mx-4 overflow-x-auto">
	          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Parameter</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Value</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Unit</th>
	                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Reference Range</th>
	                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Flag</th>
	                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Report</th>
	              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {testGroupValues.map((value) => {
                const globalIndex = manualValues.findIndex((v) => v.parameter === value.parameter);
                return (
	                  <tr key={value.parameter} className={`hover:bg-gray-50 ${value.is_hidden_from_report ? 'bg-slate-50 text-slate-500' : value.is_calculated ? 'bg-blue-50/40' : ''}`}>
                    {/* Parameter Name */}
                    <td className="px-4 py-3 w-[220px] max-w-[260px] overflow-hidden">
                      <div className="font-medium text-gray-900">
                        {value.parameter}
                        {value.is_calculated && (
                          <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800">
                            CALC
                          </span>
                        )}
	                        {value.is_rerun && (
	                          <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-orange-100 text-orange-800">
	                            RE-RUN
	                          </span>
	                        )}
	                        {value.is_hidden_from_report && (
	                          <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-slate-200 text-slate-700">
	                            hidden
	                          </span>
	                        )}
                      </div>
                      {value.verify_note && (
                        <div className="mt-1 text-xs text-orange-600 bg-orange-50 px-2 py-1 rounded">
                          {value.verify_note}
                        </div>
                      )}
                      {value.is_calculated && (() => {
                        const debugInfo = getCalculatedDebugInfo(value);
                        if (!debugInfo?.formula) return null;
                        return (
                          <div className="mt-1.5 text-xs bg-blue-50 border border-blue-100 rounded p-1.5 space-y-0.5 overflow-hidden">
                            <div className="font-mono text-blue-700 mb-1 break-all" title={debugInfo.formula}>
                              f: {debugInfo.formula}
                            </div>
                            {debugInfo.hasDependencies && debugInfo.missing.length > 0 && (
                              <button
                                type="button"
                                onClick={() => setEditingDependency({ value, missingVariables: debugInfo.missing })}
                                className="text-red-700 hover:text-red-900 hover:underline flex items-center gap-1 cursor-pointer font-medium"
                              >
                                <Link2 className="h-3 w-3" />
                                Missing: {debugInfo.missing.join(", ")}
                              </button>
                            )}
                            {!debugInfo.hasDependencies ? (
                              <button
                                type="button"
                                onClick={() => setEditingDependency({ value, missingVariables: debugInfo.missing })}
                                className="text-amber-600 hover:text-amber-800 hover:underline flex items-center gap-1 cursor-pointer font-medium"
                              >
                                <Link2 className="h-3 w-3" />
                                No dependencies saved — open Dependency Manager
                              </button>
                            ) : (
                              debugInfo.dependencies.map(dep => {
                                const hasValue = dep.value !== undefined;
                                const sourceName = dep.sourceName;
                                const sourceManual = { value: dep.value };
                                return (
                                  <div key={dep.variable} className={`flex flex-wrap items-center gap-1 ${hasValue ? 'text-green-700' : 'text-red-600'}`}>
                                    <span>{hasValue ? '✓' : '✗'}</span>
                                    <span className="font-mono font-medium break-all">{dep.variable}</span>
                                    <span className="text-gray-500 break-all">→ {sourceName}</span>
                                    {hasValue && <span className="font-semibold">= {sourceManual?.value}</span>}
                                    {!hasValue && <span className="italic">(no value yet)</span>}
                                  </div>
                                );
                              })
                            )}
                          </div>
                        );
                      })()}
                    </td>

                    {/* ✅ Value Input - Dropdown if expected_normal_values, else Pop-out */}
                    <td className="px-4 py-3 min-w-[140px]">
                      {value.ai_color_observation && (
                        <div className="mb-1 flex items-start gap-1 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                          <span className="mt-0.5 shrink-0">🎨</span>
                          <span>{value.ai_color_observation}</span>
                        </div>
                      )}
                      {value.expected_normal_values && value.expected_normal_values.length > 0 ? (
                        <select
                          value={value.value || ""}
                          onChange={(e) => {
                            handleManualValueChange(globalIndex, "value", e.target.value);
                            // Auto-set flag from expected_value_flag_map
                            const flagMap = value.expected_value_flag_map;
                            if (flagMap && flagMap[e.target.value] !== undefined) {
                              handleManualValueChange(globalIndex, "flag", flagMap[e.target.value]);
                            }
                          }}
                          onKeyDown={(e) => {
                            // Quick code resolution: e.g. pressing "1" selects "Non-Reactive"
                            const codes = value.expected_value_codes;
                            if (codes && Object.keys(codes).length > 0 && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
                              const code = e.key.toUpperCase();
                              const resolved = codes[code];
                              if (resolved) {
                                e.preventDefault();
                                handleManualValueChange(globalIndex, "value", resolved);
                                const flagMap = value.expected_value_flag_map;
                                if (flagMap && flagMap[resolved] !== undefined) {
                                  handleManualValueChange(globalIndex, "flag", flagMap[resolved]);
                                }
                              }
                            }
                          }}
                          disabled={!!value.is_calculated}
                          className={`w-full px-3 py-2 border rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 ${value.value && typeof value.value === 'string' && value.value.trim()
                            ? 'border-green-300 bg-green-50 text-green-800'
                            : 'border-gray-300 bg-white text-gray-700'
                            }`}
                        >
                          <option value="">Select value...</option>
                          {value.expected_normal_values.map((opt: string) => (
                            <option key={opt} value={opt}>{opt}</option>
                          ))}
                          {/* Show quick code hints if available */}
                          {value.expected_value_codes && Object.keys(value.expected_value_codes).length > 0 && (
                            <option disabled>── Quick codes ──</option>
                          )}
                          {value.expected_value_codes && Object.entries(value.expected_value_codes).map(([code, val]) => (
                            <option key={`hint-${code}`} disabled>{code} → {val}</option>
                          ))}
                        </select>
                      ) : value.is_calculated ? (
                        <input
                          disabled
                          value={value.value || ''}
                          placeholder="Auto-calculated"
                          className="w-full px-2 py-1 bg-blue-50 border border-blue-200 rounded text-blue-800 font-medium"
                        />
                      ) : (
                        <input
                          type="text"
                          value={value.value || ''}
                          onChange={(e) => handleManualValueChange(globalIndex, 'value', e.target.value)}
                          onBlur={(e) => handleManualValueBlur(globalIndex, e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }}
                          autoComplete="off"
                          placeholder="Enter value..."
                          className={`w-full px-3 py-1.5 border rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500 ${value.value && typeof value.value === 'string' && value.value.trim()
                            ? 'border-green-300 bg-green-50 text-green-800'
                            : 'border-gray-300 bg-white text-gray-900'
                          }`}
                        />
                      )}
                    </td>

                    {/* Unit — inline input */}
                    <td className="px-4 py-3 min-w-[120px]">
                      <input
                        type="text"
                        value={value.unit || ''}
                        onChange={(e) => handleManualValueChange(globalIndex, 'unit', e.target.value)}
                        placeholder="Unit..."
                        className={`w-full px-3 py-1.5 border rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500 ${value.unit && typeof value.unit === 'string' && value.unit.trim()
                          ? 'border-blue-300 bg-blue-50 text-blue-800'
                          : 'border-gray-300 bg-white text-gray-900'
                        }`}
                      />
                    </td>

                    {/* Reference range — inline input */}
                    <td className="px-4 py-3 min-w-[180px]">
                      <div className="relative">
                        <input
                          type="text"
                          value={value.reference || ''}
                          onChange={(e) => !value.reference_locked && handleManualValueChange(globalIndex, 'reference', e.target.value)}
                          readOnly={value.reference_locked}
                          placeholder="Reference range..."
                          className={`w-full px-3 py-1.5 pr-8 border rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500 ${
                            value.reference_locked
                              ? 'border-amber-300 bg-amber-50 text-amber-800 cursor-not-allowed'
                              : value.reference && typeof value.reference === 'string' && value.reference.trim()
                                ? 'border-purple-300 bg-purple-50 text-purple-800'
                                : 'border-gray-300 bg-white text-gray-900'
                          }`}
                        />
                        {value.reference_locked ? (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              unlockReferenceRange(globalIndex);
                            }}
                            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-amber-700 transition-colors hover:bg-amber-200 hover:text-amber-900"
                            title="Unlock reference range and restore default"
                            aria-label="Unlock reference range"
                          >
                            <Unlock className="h-3.5 w-3.5" />
                          </button>
                        ) : null}
                      </div>
                    </td>

                    {/* ✅ Keep Flag as Select (no pop-out needed) */}
	                    <td className="px-4 py-3 min-w-[120px]">
	                      <select
                        value={value.flag || ""}
                        onChange={(e) => handleManualValueChange(globalIndex, "flag", e.target.value)}
                        className="w-full px-2 py-1 border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                      >
                        {labFlagOptions.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
	                      </select>
	                    </td>
	                    <td className="px-4 py-3 min-w-[90px]">
	                      <button
	                        type="button"
	                        onClick={() => toggleManualValueHidden(globalIndex)}
	                        className={`inline-flex items-center justify-center rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
	                          value.is_hidden_from_report
	                            ? 'border-slate-400 bg-slate-100 text-slate-700'
	                            : 'border-gray-200 bg-white text-gray-500 hover:bg-gray-50'
	                        }`}
	                        title={value.is_hidden_from_report ? 'Show this analyte on report' : 'Hide this analyte from report'}
	                      >
	                        <EyeOff className="h-3.5 w-3.5" />
	                      </button>
	                    </td>
	                  </tr>
                );
              })}

	              {testGroupValues.length === 0 && (
	                <tr>
		                  <td colSpan={6} className="px-4 py-6 text-sm text-gray-500 text-center">
	                    {testGroup.is_section_only
	                      ? "This is a section-only test group. Fill the report sections below."
	                      : "All analytes for this test group are already submitted or verified."}
	                  </td>
	                </tr>
	              )}
	            </tbody>
	          </table>
	        </div>
	        {resultIdByTG[testGroup.test_group_id] && (
	          <div className="mt-4 border-t border-blue-100 bg-blue-50/30 px-4 py-3 rounded-b-lg">
	            <SectionEditor
	              resultId={resultIdByTG[testGroup.test_group_id]}
	              testGroupId={testGroup.test_group_id}
	              editorRole="technician"
	              showAIAssistant={false}
	            />
	          </div>
	        )}
	      </div>
	    );
	  };

  // =========================================================
  // #endregion Small render helpers
  // =========================================================

  // Helpers to render progress chips and submitted values
  const statusChipColor = (panel_status: string) =>
    ({
      "Not started": "bg-gray-100 text-gray-800",
      "In progress": "bg-blue-100 text-blue-800",
      Partial: "bg-amber-100 text-amber-800",
      Complete: "bg-green-100 text-green-800",
      Verified: "bg-emerald-100 text-emerald-800",
    } as any)[panel_status] || "bg-gray-100 text-gray-800";

  // =========================================================
  // #region Render
  // =========================================================

  return ReactDOM.createPortal(
    <div className="fixed inset-0 bg-gray-600 bg-opacity-75 flex items-center justify-center z-50 p-2 sm:p-4">
      <div ref={modalScrollRef} className="bg-white rounded-lg shadow-xl w-full max-w-6xl max-h-[92vh] sm:max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-4 sm:p-6 border-b border-gray-200 sticky top-0 bg-white z-10">
          <div className="min-w-0">
            <h2 className="text-base sm:text-xl font-semibold text-gray-900 truncate">Order Details</h2>
            <p className="text-xs sm:text-sm text-gray-600 mt-1">Order ID: {order.id}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-500 p-1 rounded">
            <X className="h-6 w-6" />
          </button>
        </div>

        {/* Tabs */}
        <div className="border-b border-gray-200">
          <div className="flex space-x-6 sm:space-x-8 px-4 sm:px-6 overflow-x-auto">
            <button
              onClick={() => setActiveTab("details")}
              className={`py-3 sm:py-4 text-sm font-medium border-b-2 transition-colors ${activeTab === "details" ? "border-blue-500 text-blue-600" : "border-transparent text-gray-500 hover:text-gray-700"
                }`}
            >
              Order Details
            </button>
            <button
              onClick={() => setActiveTab("results")}
              className={`py-3 sm:py-4 text-sm font-medium border-b-2 transition-colors ${activeTab === "results" ? "border-blue-500 text-blue-600" : "border-transparent text-gray-500 hover:text-gray-700"
                }`}
            >
              AI Result Entry
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="p-4 sm:p-6">
          {activeTab === "details" ? (
            <div className="space-y-6">
              {/* Quick Status */}
              <div className="bg-white border border-gray-200 rounded-lg p-4 sm:p-6">
                <div className="flex items-center justify-between">
                  <h3 className="text-lg font-semibold text-gray-900">Quick Status Updates</h3>
                </div>
                <div className="mt-3">
                  <QuickStatusButtons
                    orderId={order.id}
                    currentStatus={order.status}
                    labId={order.lab_id}
                    onStatusChanged={async () => {
                      // Parent will refresh and/or close
                      if (onUpdateStatus) await onUpdateStatus(order.id, order.status);
                    }}
                  />
                </div>
              </div>

              {/* Attachments */}
              <div className="bg-white border border-gray-200 rounded-lg p-4 sm:p-6">
                <h3 className="text-lg font-semibold text-gray-900 mb-3">Attachments</h3>

                {attachments.length === 0 ? (
                  <div className="text-sm text-gray-500">No attachments.</div>
                ) : (
                  <>
                    {/* Horizontal Scroll List - Compact */}
                    <div className="flex gap-3 overflow-x-auto pb-2 snap-x">
                      {attachments.map(a => {
                        const shortName = a.original_filename.length > 15
                          ? a.original_filename.substring(0, 12) + '...' + a.original_filename.split('.').pop()
                          : a.original_filename;

                        return (
                          <button
                            key={a.id}
                            onClick={() => setActiveAttachment(a)}
                            className={`flex-shrink-0 w-32 p-2 rounded-lg border text-left snap-start transition-all relative ${activeAttachment?.id === a.id
                              ? "border-blue-500 bg-blue-50 ring-1 ring-blue-500"
                              : "border-gray-200 bg-white hover:border-gray-300"
                              }`}
                            title={a.original_filename}
                          >
                            {/* AI Processed Badge */}
                            {a.ai_processed && (
                              <div className="absolute -top-1 -right-1 z-10">
                                <span
                                  className="flex items-center justify-center h-5 w-5 rounded-full bg-green-500 text-white text-[10px] shadow-sm"
                                  title={`AI analyzed ${a.ai_processed_at ? new Date(a.ai_processed_at).toLocaleString() : ''}`}
                                >
                                  ✓
                                </span>
                              </div>
                            )}
                            <div className="h-20 bg-gray-100 rounded mb-2 overflow-hidden flex items-center justify-center">
                              {a.file_type?.startsWith("image/") ? (
                                <img
                                  src={resolveAttachmentUrl(a)}
                                  alt=""
                                  className="w-full h-full object-cover"
                                />
                              ) : (
                                <FileText className="h-8 w-8 text-gray-400" />
                              )}
                            </div>
                            <div className="text-xs font-medium text-gray-900 truncate">{shortName}</div>
                            <div className="text-[10px] text-gray-500 truncate">
                              {(Number(a.file_size || 0) / 1024).toFixed(0)} KB
                            </div>
                          </button>
                        );
                      })}
                    </div>

                    {/* Active Attachment Details & Preview */}
                    {activeAttachment && (
                      <div className="mt-4 space-y-4">
                        {/* Info Grid */}
                        <div className="bg-gray-50 rounded-lg p-3 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 text-xs">
                          <div>
                            <span className="text-gray-500 block">Filename</span>
                            <span className="font-medium text-gray-900 break-words line-clamp-2" title={activeAttachment.original_filename}>
                              {activeAttachment.original_filename}
                            </span>
                          </div>
                          <div>
                            <span className="text-gray-500 block">Type</span>
                            <span className="font-medium text-gray-900">{activeAttachment.file_type || "Unknown"}</span>
                          </div>
                          <div>
                            <span className="text-gray-500 block">Size</span>
                            <span className="font-medium text-gray-900">{(Number(activeAttachment.file_size || 0) / 1024).toFixed(1)} KB</span>
                          </div>
                          <div>
                            <span className="text-gray-500 block">Uploaded</span>
                            <span className="font-medium text-gray-900">{new Date(activeAttachment.upload_timestamp).toLocaleDateString()}</span>
                          </div>
                          {activeAttachment.description && (
                            <div className="col-span-2 mt-1 pt-2 border-t border-gray-200">
                              <span className="text-gray-500 block mb-1">Description</span>
                              <details className="group">
                                <summary className="font-medium text-gray-900 cursor-pointer list-none flex items-center gap-1">
                                  <span className="line-clamp-1 group-open:hidden">{activeAttachment.description}</span>
                                  <span className="hidden group-open:inline">{activeAttachment.description}</span>
                                </summary>
                              </details>
                            </div>
                          )}
                        </div>

                        {/* Action Buttons - Compact Row */}
                        <div className="flex gap-2 overflow-x-auto no-scrollbar">
                          {activeAttachment.file_type?.startsWith("image/") && (
                            <button
                              onClick={() => {
                                setSelectedImageId(activeAttachment.id);
                                setShowImageViewer(true);
                              }}
                              className="flex-shrink-0 px-3 py-2 bg-white border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 text-xs font-medium flex items-center gap-1.5"
                            >
                              <Maximize2 className="h-3.5 w-3.5" />
                              View
                            </button>
                          )}
                          <button
                            onClick={() => {
                              const url = resolveAttachmentUrl(activeAttachment);
                              if (url) window.open(url, '_blank');
                            }}
                            className="flex-shrink-0 px-3 py-2 bg-white border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 text-xs font-medium flex items-center gap-1.5"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                            Open
                          </button>
                          <button
                            onClick={() => {
                              const link = document.createElement('a');
                              const url = resolveAttachmentUrl(activeAttachment);
                              if (!url) return;
                              link.href = url;
                              link.download = activeAttachment.original_filename;
                              link.click();
                            }}
                            className="flex-shrink-0 px-3 py-2 bg-white border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 text-xs font-medium flex items-center gap-1.5"
                          >
                            <Download className="h-3.5 w-3.5" />
                            Download
                          </button>
                          {/* Crop Button for existing images */}
                          {activeAttachment.file_type?.startsWith("image/") && (
                            <button
                              onClick={() => setCropTargetId(activeAttachment.id)}
                              className="flex-shrink-0 px-3 py-2 bg-white border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 text-xs font-medium flex items-center gap-1.5"
                            >
                              <Crop className="h-3.5 w-3.5" />
                              Crop
                            </button>
                          )}
                        </div>

                        {/* Preview Area */}
                        <div className="border rounded-lg bg-gray-100 h-48 sm:h-[300px] flex items-center justify-center overflow-hidden relative">
                          {activeAttachment.file_type?.startsWith("image/") ? (
                            <img
                              src={resolveAttachmentUrl(activeAttachment)}
                              alt={activeAttachment.original_filename}
                              className="max-h-full max-w-full object-contain"
                            />
                          ) : activeAttachment.file_type === "application/pdf" ? (
                            <iframe
                              src={resolvePdfSrc(activeAttachment)}
                              className="w-full h-full"
                              title={activeAttachment.original_filename}
                            />
                          ) : (
                            <div className="text-center p-4">
                              <FileText className="h-12 w-12 text-gray-400 mx-auto mb-2" />
                              <div className="text-sm text-gray-600">Preview not available</div>
                              <a
                                href={resolveAttachmentUrl(activeAttachment)}
                                target="_blank"
                                rel="noreferrer"
                                className="text-xs text-blue-600 underline mt-1 block"
                              >
                                Open File
                              </a>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>

              {/* Image Batches */}
              {uploadBatches.length > 0 && (
                <div className="bg-white border border-gray-200 rounded-lg p-4 sm:p-6">
                  <h3 className="text-lg font-semibold text-gray-900 mb-3 flex items-center gap-2">
                    📸 Image Batches
                    <span className="text-sm font-normal text-gray-500">({uploadBatches.length})</span>
                  </h3>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {uploadBatches.map((batch) => (
                      <div
                        key={batch.id}
                        className="border border-gray-200 rounded-lg p-3 hover:border-blue-300 transition-colors"
                      >
                        <div className="flex items-start justify-between mb-2">
                          <div>
                            <div className="text-sm font-medium text-gray-900">
                              Batch Upload • {batch.total_files} images
                            </div>
                            <div className="text-xs text-gray-500">
                              {new Date(batch.created_at).toLocaleDateString()} at{' '}
                              {new Date(batch.created_at).toLocaleTimeString()}
                            </div>
                          </div>
                          <span className={`px-2 py-1 text-xs font-medium rounded ${batch.batch_status === 'completed'
                            ? 'bg-green-100 text-green-800'
                            : batch.batch_status === 'failed'
                              ? 'bg-red-100 text-red-800'
                              : 'bg-yellow-100 text-yellow-800'
                            }`}>
                            {batch.batch_status}
                          </span>
                        </div>

                        {batch.batch_description && (
                          <p className="text-xs text-gray-600 mb-3">{batch.batch_description}</p>
                        )}

                        {/* Preview thumbnails with delete option */}
                        <div className="flex gap-2 mb-3 overflow-x-auto no-scrollbar">
                          {batch.attachments?.slice(0, 4).map((attachment: any) => (
                            <div key={attachment.id} className="flex-shrink-0 relative group">
                              {attachment.file_type.startsWith('image/') ? (
                                <img
                                  src={resolveAttachmentUrl(attachment)}
                                  alt={attachment.image_label}
                                  className="w-12 h-12 object-cover rounded border"
                                />
                              ) : (
                                <div className="w-12 h-12 bg-gray-200 rounded border flex items-center justify-center">
                                  <FileText className="h-4 w-4 text-gray-400" />
                                </div>
                              )}
                              {/* Delete overlay on hover */}
                              <button
                                onClick={() => handleDeleteAttachment(attachment.id)}
                                className="absolute top-0 right-0 -mt-1 -mr-1 w-5 h-5 bg-red-600 text-white rounded-full opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center hover:bg-red-700"
                                title="Delete this image"
                              >
                                <X className="h-3 w-3" />
                              </button>
                            </div>
                          ))}
                          {batch.attachments?.length > 4 && (
                            <div className="w-12 h-12 bg-gray-100 rounded border flex items-center justify-center text-xs text-gray-500">
                              +{batch.attachments.length - 4}
                            </div>
                          )}
                        </div>

                        {/* AI Reference Labels */}
                        <div className="flex flex-wrap gap-1 mb-3">
                          {batch.attachments?.slice(0, 3).map((attachment: any) => (
                            <span
                              key={attachment.id}
                              className="px-2 py-1 bg-blue-100 text-blue-800 text-xs font-medium rounded"
                              title={attachment.original_filename}
                            >
                              {attachment.image_label}
                            </span>
                          ))}
                          {batch.attachments?.length > 3 && (
                            <span className="px-2 py-1 bg-gray-100 text-gray-600 text-xs rounded">
                              +{batch.attachments.length - 3} more
                            </span>
                          )}
                        </div>

                        <div className="flex gap-2">
                          <button
                            onClick={() => handleViewBatch(batch)}
                            className="flex-1 px-3 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 flex items-center justify-center gap-1"
                          >
                            <Eye className="h-4 w-4" />
                            View Batch ({batch.total_files} images)
                          </button>
                          <button
                            onClick={() => handleDeleteBatch(batch)}
                            className="px-3 py-2 bg-red-600 text-white text-sm rounded hover:bg-red-700 flex items-center justify-center gap-1"
                            title="Delete entire batch"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Order Summary */}
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 sm:p-6">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div>
                    <div className="text-blue-600 font-medium">Patient</div>
                    <div className="text-blue-900 font-semibold">{order.patient_name}</div>
                    <div className="text-blue-700 text-sm">{order.patient_id}</div>
                  </div>
                  <div>
                    <div className="text-blue-600 font-medium mb-2">Status</div>
                    <OrderStatusDisplay order={order} showDetails={true} />
                  </div>
                  <div>
                    <div className="text-blue-600 font-medium">Priority</div>
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getPriorityColor(order.priority)}`}>
                      {order.priority}
                    </span>
                  </div>
                  <div>
                    <div className="text-blue-600 font-medium">Amount</div>
                    <div className="text-blue-900 font-semibold">₹{(order.final_amount ?? order.total_amount).toLocaleString()}</div>
                    {order.collection_charge && order.collection_charge > 0 && (
                      <div className="text-xs text-orange-600 mt-0.5">incl. ₹{order.collection_charge} collection</div>
                    )}
                  </div>
                </div>
              </div>

              {/* Sample Tracking */}
              {order.sample_id && (
                <div className="bg-green-50 border border-green-200 rounded-lg p-4 sm:p-6">
                  <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center">
                    <TestTube2 className="h-5 w-5 mr-2 text-green-600" />
                    Sample Tracking Information
                  </h3>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    {/* Sample ID & Color */}
                    <div className="flex items-center space-x-4">
                      <div
                        className="w-12 h-12 rounded-full border-4 border-gray-300 flex-shrink-0"
                        style={{ backgroundColor: order.color_code }}
                        title={`Sample Color: ${order.color_name}`}
                      />
                      <div>
                        <div className="text-sm font-medium text-gray-700">Sample ID</div>
                        <div className="text-lg font-bold text-green-900">{order.sample_id}</div>
                        <div className="text-sm text-green-700">{order.color_name} Tube</div>
                      </div>
                    </div>

                    {/* QR code - HIDDEN */}
                    {false && (
                      <div>
                        <div className="text-sm font-medium text-gray-700 mb-2 flex items-center justify-between">
                          <div className="flex items-center">
                            <QrCode className="h-4 w-4 mr-1" />
                            QR Code
                          </div>
                          {order.qr_code_data && (
                            <button
                              onClick={handlePrintQRCode}
                              className="flex items-center px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
                            >
                              <Printer className="h-3 w-3 mr-1" />
                              Print Label
                            </button>
                          )}
                        </div>
                        {order.qr_code_data ? (
                          <div className="space-y-3">
                            <div className="bg-white border-2 border-green-300 rounded-lg p-4 text-center">
                              <div className="mb-2">
                                {qrCodeImage ? (
                                  <img src={qrCodeImage} alt="Sample QR Code" className="w-32 h-32 mx-auto border border-gray-300 rounded" />
                                ) : (
                                  <div className="w-32 h-32 mx-auto border border-gray-300 rounded bg-gray-100 flex items-center justify-center">
                                    <QrCode className="h-8 w-8 text-gray-400" />
                                  </div>
                                )}
                              </div>
                              <div className="text-xs text-gray-600">Scan to access sample information</div>
                            </div>
                          </div>
                        ) : (
                          <div className="text-sm text-gray-500 bg-gray-50 border border-gray-200 rounded-lg p-3 text-center">
                            <QrCode className="h-8 w-8 mx-auto mb-2 text-gray-400" />
                            No QR code generated
                          </div>
                        )}
                      </div>
                    )}

                    {/* Collection Status */}
                    <div>
                      <div className="text-sm font-medium text-gray-700 mb-2">Collection Status</div>
                      {order.sample_collected_at ? (
                        <div className="bg-green-100 border border-green-300 rounded-lg p-3">
                          <div className="flex items-center text-green-800 mb-1">
                            <CheckCircle className="h-4 w-4 mr-1" />
                            <span className="font-medium">Collected</span>
                          </div>
                          <div className="text-xs text-green-700">{new Date(order.sample_collected_at).toLocaleString()}</div>
                          {order.sample_collected_by && <div className="text-xs text-green-700">By: {order.sample_collected_by}</div>}
                        </div>
                      ) : (
                        <div className="bg-yellow-100 border border-yellow-300 rounded-lg p-3">
                          <div className="flex items-center text-yellow-800 mb-1">
                            <Clock className="h-4 w-4 mr-1" />
                            <span className="font-medium">Pending Collection</span>
                          </div>
                          <div className="text-xs text-yellow-700">Sample needs to be collected from patient</div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Tests Ordered + Panel Progress Chips */}
              <div className="bg-white border border-gray-200 rounded-lg p-4 sm:p-6">
                <h3 className="text-lg font-semibold text-gray-900 mb-4">Tests Ordered</h3>

                {progressRows.length > 0 && (
                  <div className="mb-3">
                    <div className="flex flex-wrap gap-2">
                      {progressRows.map((r) => (
                        <span
                          key={r.order_test_id || r.test_group_id}
                          className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium border ${statusChipColor(
                            r.panel_status
                          )}`}
                          title={r.test_group_name}
                        >
                          {r.test_group_name}: {r.entered_analytes}/{r.expected_analytes} • {r.panel_status}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {order.tests.map((test, index) => {
                    // Find corresponding order_test to check outsourcing status
                    const orderTest = (order as any).order_tests?.find((ot: any) => ot.test_name === test);
                    const isOutsourced = orderTest?.outsourced_lab_id;
                    const outsourcedLabName = orderTest?.outsourced_labs?.name;

                    return (
                      <div key={index} className="bg-gray-50 rounded-lg p-4">
                        <div className="flex items-center justify-between">
                          <div className="font-medium text-gray-900">{test}</div>
                          {isOutsourced ? (
                            <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium bg-orange-100 text-orange-700 rounded-full border border-orange-200">
                              🏥 {outsourcedLabName || 'Outsourced'}
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium bg-green-100 text-green-700 rounded-full border border-green-200">
                              🏠 In-house
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Submitted Values (read-only) */}
              <div className="bg-white border border-gray-200 rounded-lg p-4 sm:p-6">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-lg font-semibold text-gray-900">Submitted Values (read-only)</h3>
                </div>

                {testGroups.length === 0 ? (
                  <div className="text-sm text-gray-500">No test groups configured.</div>
                ) : (
                  <div className="space-y-4">
                    {testGroups.map((tg) => {
                      const key = tg.test_group_id || tg.order_test_group_id || tg.order_test_id;
                      const rows = applyAnalyteDisplayOrder(
                        readonlyByTG[key as string] || [],
                        (tg.analytes || []).map((analyte: any) => ({
                          analyte_id: analyte.id,
                          sort_order: analyte.sort_order,
                          display_order: analyte.display_order,
                          section_heading: analyte.section_heading,
                        }))
                      );
	                      if (!rows.length && !tg.is_section_only && !resultIdByTG[key]) return null;
	                      return (
	                        <div key={key} className="border rounded-lg">
                          <div className="px-4 py-2 bg-gray-50 border-b font-medium">{tg.test_group_name}</div>
                          <div className="overflow-x-auto">
                            <table className="min-w-full divide-y divide-gray-200">
                              <thead className="bg-gray-50">
                                <tr>
                                  <th className="px-4 py-2 text-left text-xs font-semibold text-gray-600">Parameter</th>
                                  <th className="px-4 py-2 text-left text-xs font-semibold text-gray-600">Value</th>
                                  <th className="px-4 py-2 text-left text-xs font-semibold text-gray-600">Unit</th>
                                  <th className="px-4 py-2 text-left text-xs font-semibold text-gray-600">Reference</th>
                                  <th className="px-4 py-2 text-left text-xs font-semibold text-gray-600">Flag</th>
                                </tr>
                              </thead>
	                              <tbody className="bg-white divide-y divide-gray-100">
	                                {rows.map((rv: any, index: number) => (
                                    <React.Fragment key={rv.id}>
                                      {rv.section_heading && rv.section_heading !== rows[index - 1]?.section_heading && (
                                        <tr className="bg-blue-50">
                                          <td colSpan={5} className="px-4 py-2 text-xs font-bold uppercase tracking-wide text-blue-800">
                                            {rv.section_heading}
                                          </td>
                                        </tr>
                                      )}
	                                    <tr>
                                        <td className="px-4 py-2 text-sm">{rv.analyte_name}</td>
                                        <td className="px-4 py-2 text-sm">{rv.value}</td>
                                        <td className="px-4 py-2 text-sm">{rv.unit}</td>
                                        <td className="px-4 py-2 text-sm">{rv.reference_range}</td>
                                        <td className="px-4 py-2 text-sm">
                                          <span className={`px-1.5 py-0.5 rounded ${getFlagColor(rv.flag)}`}>{rv.flag || ""}</span>
                                        </td>
                                      </tr>
                                    </React.Fragment>
	                                ))}
	                                {rows.length === 0 && (
	                                  <tr>
	                                    <td colSpan={5} className="px-4 py-4 text-sm text-gray-500 text-center">
	                                      {tg.is_section_only
	                                        ? "No analyte rows for this section-only test group. Report sections are available below."
	                                        : "No submitted analyte rows for this test group."}
	                                    </td>
	                                  </tr>
	                                )}
	                              </tbody>
                            </table>
                          </div>
                          {/* Report Sections for this test group */}
                          {resultIdByTG[key] && tg.test_group_id && (
                            <div className="border-t border-gray-100 p-3 bg-gray-50/50">
                              <SectionEditor
                                resultId={resultIdByTG[key]}
                                testGroupId={tg.test_group_id}
                                editorRole="doctor"
                                showAIAssistant={false}
                              />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Workflow + Next Steps */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="bg-white border border-gray-200 rounded-lg p-4 sm:p-6">
                  <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center">
                    <ArrowRight className="h-5 w-5 mr-2 text-blue-600" />
                    Workflow Progress
                  </h3>
                  <div className="space-y-4">
                    {getWorkflowSteps(order.status, order).map((step, index) => (
                      <div key={step.name} className="flex items-center space-x-3">
                        <div
                          className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${step.completed ? "bg-green-500 text-white" : step.current ? "bg-blue-500 text-white" : "bg-gray-200 text-gray-600"
                            }`}
                        >
                          {step.completed ? <CheckCircle className="h-4 w-4" /> : index + 1}
                        </div>
                        <div className="flex-1">
                          <div
                            className={`font-medium ${step.current ? "text-blue-900" : step.completed ? "text-green-900" : "text-gray-600"}`}
                          >
                            {step.name}
                          </div>
                          <div className="text-sm text-gray-500">{step.description}</div>
                          {step.timestamp && <div className="text-xs text-gray-400">
                            {/* date-only strings (YYYY-MM-DD) have no real time — show date only to avoid IST UTC-midnight shift (+5:30) */}
                            {/^\d{4}-\d{2}-\d{2}$/.test(step.timestamp)
                              ? new Date(step.timestamp + 'T00:00:00').toLocaleDateString()
                              : new Date(step.timestamp).toLocaleString()}
                          </div>}
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* TAT Summary */}
                  {(() => {
                    const tatStart = order.sample_collected_at;
                    if (!tatStart) return null;

                    const startMs = new Date(tatStart).getTime();
                    const nowMs = Date.now();
                    const elapsedMs = nowMs - startMs;
                    const elapsedHours = elapsedMs / 3_600_000;

                    const isCompleted = ['Report Ready', 'Completed', 'Delivered'].includes(order.status);
                    const deadline = order.expected_date ? new Date(order.expected_date) : null;
                    // Valid only if after TAT start — rules out DB default values equal to order_date
                    const isValidDeadline = deadline && !isNaN(deadline.getTime()) && deadline.getFullYear() > 2000 && deadline.getTime() > startMs;
                    const isBreached = isValidDeadline && !isCompleted && deadline!.getTime() < nowMs;

                    const fmt = (h: number) => {
                      if (h < 1) return `${Math.round(h * 60)}m`;
                      return `${Math.floor(h)}h ${Math.round((h % 1) * 60)}m`;
                    };

                    return (
                      <div className={`mt-4 rounded-lg p-3 text-xs border ${isCompleted ? 'bg-green-50 border-green-200' : isBreached ? 'bg-red-50 border-red-200' : 'bg-blue-50 border-blue-200'}`}>
                        <div className="font-semibold text-gray-700 mb-2 flex items-center gap-1">
                          <Clock className="h-3.5 w-3.5" /> TAT Summary
                        </div>
                        <div className="space-y-1 text-gray-600">
                          <div className="flex justify-between">
                            <span>Started:</span>
                            <span className="font-medium">{new Date(tatStart).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                          </div>
                          {isValidDeadline && (
                            <div className="flex justify-between">
                              <span>Deadline:</span>
                              <span className={`font-medium ${isBreached ? 'text-red-600' : 'text-gray-700'}`}>
                                {deadline!.toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                              </span>
                            </div>
                          )}
                          <div className="flex justify-between">
                            <span>Elapsed:</span>
                            <span className={`font-medium ${isBreached ? 'text-red-600' : isCompleted ? 'text-green-700' : 'text-blue-700'}`}>{fmt(elapsedHours)}</span>
                          </div>
                          {isValidDeadline && !isCompleted && (
                            <div className="flex justify-between">
                              <span>Status:</span>
                              <span className={`font-semibold ${isBreached ? 'text-red-600' : 'text-green-600'}`}>
                                {isBreached ? `⚠ Breached by ${fmt(elapsedHours - (deadline!.getTime() - startMs) / 3_600_000)}` : `✓ On track (${fmt((deadline!.getTime() - nowMs) / 3_600_000)} left)`}
                              </span>
                            </div>
                          )}
                          {isCompleted && (
                            <div className="flex justify-between">
                              <span>Status:</span>
                              <span className="font-semibold text-green-600">✓ Completed in {fmt(elapsedHours)}</span>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })()}
                </div>

                <div className="bg-white border border-gray-200 rounded-lg p-4 sm:p-6">
                  <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center">
                    <Calendar className="h-5 w-5 mr-2 text-orange-600" />
                    Next Steps
                  </h3>
                  <div className="space-y-4">
                    {getNextSteps(order.status, order).map((step, index) => (
                      <div
                        key={index}
                        className={`p-4 rounded-lg border-l-4 ${step.urgent ? "bg-red-50 border-red-400" : step.priority === "high" ? "bg-orange-50 border-orange-400" : "bg-blue-50 border-blue-400"
                          }`}
                      >
                        <div className={`font-medium ${step.urgent ? "text-red-900" : step.priority === "high" ? "text-orange-900" : "text-blue-900"}`}>
                          {step.action}
                        </div>
                        <div className="text-sm text-gray-600 mt-1">{step.description}</div>
                        {step.assignedTo && <div className="text-xs text-gray-500 mt-2">Assigned to: {step.assignedTo}</div>}
                        {step.deadline && <div className="text-xs text-gray-500">Deadline: {new Date(step.deadline).toLocaleString()}</div>}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            // ========================= Results Tab =========================
            <div className="space-y-6">
              {/* AI OCR Section */}
              <div className="bg-gradient-to-r from-purple-50 to-blue-50 border border-purple-200 rounded-lg p-4 sm:p-6">
                <h3 className="text-lg font-semibold text-purple-900 mb-4 flex items-center">
                  <Brain className="h-5 w-5 mr-2" />
                  AI-Powered Result Processing
                </h3>

                <div className="space-y-4">
                  {renderFileUpload()}

                  {/* Multi-Image Context Display */}
                  {availableImagesForAI.length > 1 && (
                    <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-4">
                      <div className="flex items-center justify-between mb-2">
                        <h4 className="font-medium text-blue-900 flex items-center gap-2">
                          <ImageIcon className="h-4 w-4" />
                          Multi-Image Analysis Ready ({availableImagesForAI.length} images)
                        </h4>
                        <button
                          onClick={() => {
                            setSelectedBatch(selectedBatchForAI);
                            setShowBatchViewer(true);
                          }}
                          className="text-xs px-2 py-1 bg-blue-100 text-blue-700 rounded hover:bg-blue-200"
                        >
                          Preview Images
                        </button>
                      </div>
                      <div className="text-sm text-blue-800 space-y-2">
                        <div className="flex items-center justify-between">
                          <p>Select images for AI analysis:</p>
                          <div className="flex gap-2">
                            <button
                              onClick={() => setSelectedImagesForAI(new Set(availableImagesForAI.map((img: any) => img.id)))}
                              className="text-xs px-2 py-0.5 text-blue-600 hover:text-blue-800 underline"
                            >
                              Select All
                            </button>
                            <button
                              onClick={() => setSelectedImagesForAI(new Set())}
                              className="text-xs px-2 py-0.5 text-blue-600 hover:text-blue-800 underline"
                            >
                              Clear
                            </button>
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {availableImagesForAI.map((img: any, idx: number) => (
                            <label
                              key={idx}
                              className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs cursor-pointer transition-colors ${selectedImagesForAI.has(img.id)
                                ? 'bg-blue-200 text-blue-900 border border-blue-400'
                                : 'bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100'
                                }`}
                            >
                              <input
                                type="checkbox"
                                checked={selectedImagesForAI.has(img.id)}
                                onChange={(e) => {
                                  const newSet = new Set(selectedImagesForAI);
                                  if (e.target.checked) {
                                    newSet.add(img.id);
                                  } else {
                                    newSet.delete(img.id);
                                  }
                                  setSelectedImagesForAI(newSet);
                                }}
                                className="h-3 w-3 text-blue-600 rounded"
                              />
                              <span>{img.image_label || `Image ${idx + 1}`}</span>
                              {img.ai_processed && (
                                <span className="ml-1 text-green-600" title={`AI analyzed ${img.ai_processed_at ? new Date(img.ai_processed_at).toLocaleString() : ''}`}>
                                  ✓
                                </span>
                              )}
                            </label>
                          ))}
                        </div>
                        {selectedImagesForAI.size > 0 && selectedImagesForAI.size < availableImagesForAI.length && (
                          <p className="text-xs text-blue-600 mt-1">
                            {selectedImagesForAI.size} of {availableImagesForAI.length} images selected
                          </p>
                        )}
                      </div>

                      {/* AI Instructions Preview */}
                      <details className="mt-3">
                        <summary className="text-xs text-blue-600 cursor-pointer hover:text-blue-800">
                          AI Analysis Instructions
                        </summary>
                        <div className="mt-2 p-2 bg-white rounded border text-xs text-gray-700">
                          <pre className="whitespace-pre-wrap">{multiImageAIInstructions}</pre>
                        </div>
                      </details>
                    </div>
                  )}

                  {/* Sticky AI toolbar */}
                  <div className="sticky top-[64px] z-10 -mx-4 sm:-mx-6 px-4 sm:px-6 py-2 bg-white/80 backdrop-blur border-b">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-slate-600">AI assistant</span>
                        {availableImagesForAI.length > 1 && (
                          <span className="px-2 py-1 bg-blue-100 text-blue-700 text-xs rounded">
                            {selectedImagesForAI.size > 0 && selectedImagesForAI.size < availableImagesForAI.length
                              ? `${selectedImagesForAI.size}/${availableImagesForAI.length} Selected`
                              : `Multi-Image Mode`}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        {/* Voice Input Button */}
                        <button
                          onClick={() => setShowVoiceInput(!showVoiceInput)}
                          disabled={voiceAnalyzing}
                          className={`inline-flex items-center px-3 py-1.5 rounded-md transition-colors ${
                            showVoiceInput
                              ? "bg-indigo-100 text-indigo-700 border border-indigo-300"
                              : "bg-gray-100 text-gray-700 hover:bg-indigo-50 hover:text-indigo-600"
                          }`}
                          title="Voice Input"
                        >
                          <Mic className="h-4 w-4 mr-1" />
                          Voice
                        </button>
                        {/* Image Analysis Button */}
                        <button
                          onClick={() => handleRunAIProcessing()}
                          disabled={isOCRProcessing || (!attachmentId && availableImagesForAI.length === 0) || (availableImagesForAI.length > 1 && selectedImagesForAI.size === 0)}
                          className="inline-flex items-center px-3 py-1.5 rounded-md bg-gradient-to-r from-purple-600 to-blue-600 text-white
                                     disabled:from-gray-400 disabled:to-gray-400"
                        >
                          {isOCRProcessing ? "Analysing…" :
                            availableImagesForAI.length > 1
                              ? (selectedImagesForAI.size === availableImagesForAI.length
                                ? "Analyze All Images"
                                : `Analyze ${selectedImagesForAI.size} Image${selectedImagesForAI.size !== 1 ? 's' : ''}`)
                              : "Process with AI"}
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Voice Input Section */}
                  {showVoiceInput && (
                    <div className="mt-3 mb-3">
                      <VoiceRecorder
                        onRecordingComplete={(blob, duration) => {
                          console.log(`Voice recording complete: ${duration}s`);
                        }}
                        onAnalyze={handleVoiceAnalyze}
                        disabled={isOCRProcessing}
                        analyzing={voiceAnalyzing}
                      />
                      {voiceTranscript && (
                        <div className="mt-2 p-3 bg-gray-50 rounded-lg border border-gray-200">
                          <p className="text-xs font-medium text-gray-500 mb-1">Last Transcript:</p>
                          <p className="text-sm text-gray-700">{voiceTranscript}</p>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Sliding AI console */}
                  <div className={`transition-all duration-300 ${aiPhase === "idle" ? "max-h-0 opacity-0" : "max-h-[340px] opacity-100"} overflow-hidden mt-3`}>
                    <div className="rounded-xl bg-slate-900 text-slate-100 p-4 font-mono text-xs shadow-inner border border-slate-800">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <span className={`inline-flex h-2.5 w-2.5 rounded-full ${aiPhase === "running" ? "bg-cyan-400 animate-pulse" : aiPhase === "done" ? "bg-green-400" : "bg-red-400"}`} />
                          <span className="uppercase tracking-wider">
                            {aiPhase === "running" ? "Analysing…" : aiPhase === "done" ? "Completed" : aiPhase === "error" ? "Error" : ""}
                          </span>
                        </div>
                        <div className="w-40 h-2 bg-slate-700 rounded-full overflow-hidden">
                          <div className="h-full bg-cyan-400 transition-[width] duration-300" style={{ width: `${aiProgress}%` }} />
                        </div>
                      </div>

                      <div ref={aiLogRef} className="space-y-2 max-h-64 overflow-auto pr-2">
                        {aiSteps.map(s => (
                          <div key={s.id} className="flex items-start gap-2">
                            <span className={`mt-1 h-3 w-3 rounded-full
                                              ${s.status === "done" ? "bg-green-400" :
                                s.status === "doing" ? "bg-cyan-400" :
                                  s.status === "error" ? "bg-red-400" : "bg-slate-600"}`} />
                            <div>
                              <div className="text-[11px]">
                                <span className="text-slate-300">{s.label}</span>
                                {s.ts && <span className="text-slate-500"> • {new Date(s.ts).toLocaleTimeString()}</span>}
                              </div>
                              {s.detail && <div className="text-[11px] text-slate-400">{s.detail}</div>}
                            </div>
                          </div>
                        ))}
                      </div>

                      {aiPhase !== "idle" && (
                        <div className={`mt-3 p-2 rounded ${aiPhase === "done" && aiMatchedCount > 0
                          ? "bg-green-700/30 text-green-200"
                          : aiPhase === "done"
                            ? "bg-yellow-700/30 text-yellow-200"
                            : "bg-red-700/30 text-red-200"}`}>
                          {aiPhase === "done" && aiMatchedCount > 0 && <>AI filled <b>{aiMatchedCount}</b> parameter{aiMatchedCount > 1 ? "s" : ""}. Review & submit.</>}
                          {aiPhase === "done" && aiMatchedCount === 0 && <>No parameters recognized. Please enter values manually.</>}
                          {aiPhase === "error" && <>AI processing failed. Try again or enter manually.</>}
                        </div>
                      )}
                    </div>
                  </div>

                  {aiPhase === "done" && (
                    <div className={`mt-4 p-3 rounded-lg ${aiMatchedCount > 0 ? "bg-green-50 border border-green-200 text-green-800"
                      : "bg-yellow-50 border border-yellow-200 text-yellow-800"}`}>
                      <div className="flex items-start justify-between">
                        <div>
                          {aiMatchedCount > 0
                            ? <>AI filled <b>{aiMatchedCount}</b> parameters. Review & submit.</>
                            : <>No parameters recognized. Please enter values manually.</>}

                          {/* Multi-image processing summary */}
                          {availableImagesForAI.length > 1 && (
                            <div className="mt-2 text-sm opacity-75">
                              <span className="inline-flex items-center gap-1">
                                <ImageIcon className="h-3 w-3" />
                                Processed {availableImagesForAI.length} images
                              </span>
                              {selectedBatchForAI && (
                                <span className="ml-2 px-2 py-0.5 bg-white/50 rounded text-xs">
                                  Batch: {selectedBatchForAI.batch_name || `#${selectedBatchForAI.id?.substring(0, 8)}`}
                                </span>
                              )}
                            </div>
                          )}
                        </div>

                        {availableImagesForAI.length > 1 && (
                          <button
                            onClick={() => setShowBatchViewer(true)}
                            className="text-xs px-2 py-1 bg-white/50 hover:bg-white/70 rounded transition-colors"
                          >
                            View Images
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Test Group filter */}
              {testGroups.length > 1 && (
                <div className="bg-white border border-gray-200 rounded-lg p-4">
                  <label className="block text-sm font-medium text-gray-700 mb-2">Select Test Group</label>
                  <select
                    value={selectedTestGroup || ""}
                    onChange={(e) => setSelectedTestGroup(e.target.value)}
                    className="w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  >
                    <option value="">All Test Groups</option>
                    {testGroups.map((tg) => (
                      <option key={tg.test_group_id} value={tg.test_group_id}>
                        {tg.test_group_name} ({tg.analytes.filter((a: any) => !a.existing_result && !a.is_calculated).length} pending)
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Entry mode toggle */}
              <div className="bg-white border border-gray-200 rounded-lg p-4">
                <div className="flex items-center space-x-4">
                  <h3 className="text-lg font-semibold">Result Entry Mode</h3>
                  <div className="flex bg-gray-100 rounded-lg p-1">
                    <button
                      onClick={() => setActiveEntryMode("manual")}
                      className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${activeEntryMode === "manual" ? "bg-white text-blue-600 shadow-sm" : "text-gray-600 hover:text-gray-900"
                        }`}
                    >
                      Manual Entry
                    </button>
                    <button
                      onClick={() => setActiveEntryMode("ai")}
                      className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${activeEntryMode === "ai" ? "bg-white text-blue-600 shadow-sm" : "text-gray-600 hover:text-gray-900"
                        }`}
                    >
                      AI Upload
                    </button>
                  </div>
                </div>
              </div>

              {/* Results table(s) */}
              <div className="bg-white border border-gray-200 rounded-lg p-4 sm:p-6">
                <h3 className="text-lg font-semibold text-gray-900 mb-4">
                  Test Group Results{" "}
                  {selectedTestGroup && `- ${testGroups.find((tg) => tg.test_group_id === selectedTestGroup)?.test_group_name}`}
                </h3>

                {testGroups.length === 0 ? (
                  <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                    <div className="flex items-center text-yellow-800">
                      <AlertTriangle className="h-5 w-5 mr-2" />
                      <div>
                        <p className="font-semibold">No Test Groups Found</p>
                        <p className="text-sm">This order doesn't have any test groups configured for result entry.</p>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {testGroups
                      .filter((tg) => !selectedTestGroup || tg.test_group_id === selectedTestGroup)
                      .map((tg) => (
                        <React.Fragment key={tg.test_group_id}>
                          {renderTestGroupEntry(tg, activeEntryMode)}
                        </React.Fragment>
                      ))}
                  </div>
                )}

                {saveMessage && (
                  <div
                    className={`mt-4 p-3 rounded-lg ${saveMessage.includes("successfully")
                      ? "bg-green-50 border border-green-200 text-green-700"
                      : "bg-red-50 border border-red-200 text-red-700"
                      }`}
                  >
                    <div className="flex items-center">
                      {saveMessage.includes("successfully") ? (
                        <CheckCircle className="h-4 w-4 mr-2" />
                      ) : (
                        <AlertTriangle className="h-4 w-4 mr-2" />
                      )}
                      {saveMessage}
                    </div>
                  </div>
                )}

                {/* Multi-Image Upload Button - TEMPORARILY HIDDEN */}
                <div className="mt-4 flex justify-center hidden">
                  <button
                    onClick={() => setShowMultiUpload(true)}
                    className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 flex items-center gap-2 shadow-md transition-colors"
                  >
                    <Camera className="h-5 w-5" />
                    Upload Multiple Images
                  </button>
                </div>

                {/* Sticky mobile action bar */}
                <div className="mt-6 sm:mt-6 sm:flex sm:justify-end sm:space-x-4 space-y-2 sm:space-y-0 sticky bottom-0 bg-white py-3 sm:py-0">
                  <div className="flex flex-col sm:flex-row sm:justify-end gap-2">
                    <button
                      onClick={handleSaveDraft}
                      disabled={savingDraft}
                      className="px-6 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 disabled:bg-gray-100 disabled:cursor-not-allowed transition-colors"
                    >
                      {savingDraft ? (
                        <>
                          <span className="animate-spin rounded-full h-4 w-4 border-2 border-gray-600 border-t-transparent mr-2 inline-block" />
                          Saving Draft...
                        </>
                      ) : (
                        "Save Draft"
                      )}
                    </button>
                    <button
                      onClick={handleSubmitResults}
                      disabled={submittingResults}
                      className="px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:bg-green-400 disabled:cursor-not-allowed transition-colors"
                    >
                      {submittingResults ? (
                        <>
                          <span className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent mr-2 inline-block" />
                          Submitting...
                        </>
                      ) : (
                        "Submit Results"
                      )}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
        {/* end body */}
      </div>

      {/* Multi-Image Upload Modal */}
      {showMultiUpload && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[60] p-4">
          <div className="bg-white rounded-lg max-w-4xl w-full max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b">
              <div className="flex justify-between items-center">
                <h2 className="text-xl font-semibold text-gray-900 flex items-center gap-2">
                  <Camera className="h-6 w-6" />
                  Upload Multiple Images
                </h2>
                <button
                  onClick={() => setShowMultiUpload(false)}
                  className="p-2 hover:bg-gray-100 rounded-lg"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>

            <div className="p-6">
              <MultiImageUploader
                maxFiles={10}
                maxSizePerFile={10 * 1024 * 1024} // 10MB
                acceptedFormats={['image/*', '.pdf']}
                onUploadComplete={handleBatchComplete}
                context={{
                  orderId: order.id,
                  testId: uploadScope === 'test' ? selectedTestId : undefined,
                  scope: uploadScope,
                  patientId: order.patient_id
                }}
              />
            </div>
          </div>
        </div>
      )}

      {/* Batch Viewer Modal */}
      {
        showBatchViewer && selectedBatch && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[60] p-4">
            <div className="bg-white rounded-lg max-w-6xl w-full max-h-[90vh] overflow-y-auto">
              <div className="p-6 border-b">
                <div className="flex justify-between items-center">
                  <h2 className="text-xl font-semibold text-gray-900 flex items-center gap-2">
                    <Eye className="h-6 w-6" />
                    {selectedBatch.id?.startsWith('virtual-') ? 'Images' : 'Batch'}: {selectedBatch.total_files} Images
                    {selectedBatch.created_at && (
                      <span className="text-sm font-normal text-gray-500">
                        ({new Date(selectedBatch.created_at).toLocaleDateString()})
                      </span>
                    )}
                  </h2>
                  <button
                    onClick={() => setShowBatchViewer(false)}
                    className="p-2 hover:bg-gray-100 rounded-lg"
                  >
                    <X className="h-5 w-5" />
                  </button>
                </div>
              </div>

              <div className="p-6">
                {selectedBatch.id?.startsWith('virtual-') ? (
                  // Simple inline viewer for virtual batches
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                    {selectedBatch.files?.map((img: any, idx: number) => (
                      <div key={img.id} className="border rounded-lg p-2">
                        <img
                          src={img.resolved_file_url || img.file_url}
                          alt={img.image_label || `Image ${idx + 1}`}
                          className="w-full h-48 object-contain bg-gray-50 rounded"
                        />
                        <p className="text-sm text-center mt-2 text-gray-700">
                          {img.image_label || `Image ${idx + 1}`}
                        </p>
                      </div>
                    ))}
                  </div>
                ) : (
                  // Use BatchImageViewer for real batches
                  <BatchImageViewer
                    batchId={selectedBatch.id}
                    onClose={() => setShowBatchViewer(false)}
                    onRemove={(imageId) => {
                      // Handle image removal
                      fetchUploadBatches();
                      fetchAttachmentsForOrder();
                    }}
                    onUpdateLabel={(imageId, newLabel) => {
                      // Handle label update
                      console.log(`Updated label for ${imageId} to ${newLabel}`);
                    }}
                    onBatchDeleted={(batchId) => {
                      // Handle batch deletion - refresh the batches list and close viewer
                      fetchUploadBatches();
                      fetchAttachmentsForOrder();
                      setShowBatchViewer(false);
                      setSelectedBatch(null);

                      // Update AI state if this was the selected batch for AI
                      if (selectedBatchForAI?.id === batchId) {
                        setSelectedBatchForAI(null);
                        setAvailableImagesForAI([]);
                        setMultiImageAIInstructions('');
                      }
                    }}
                    enableAIReference={true}
                    readonly={false}
                  />
                )}
              </div>
            </div>
          </div>
        )
      }

      {/* Single Image Viewer */}
      {
        showImageViewer && selectedImageId && (
          <SingleImageViewer
            imageId={selectedImageId}
            onClose={() => {
              setShowImageViewer(false);
              setSelectedImageId(null);
            }}
            onRemove={(imageId) => {
              // Handle image removal - refresh attachments
              fetchAttachmentsForOrder();
              setShowImageViewer(false);
              setSelectedImageId(null);
              setActiveAttachment(null);
            }}
            onUpdateDescription={(imageId, description) => {
              // Handle description update
              console.log(`Updated description for ${imageId} to ${description}`);
              fetchAttachmentsForOrder();
            }}
            readonly={false}
          />
        )
      }

      {/* Image Cropper Modal */}
      {
        cropTargetId && (() => {
          const attachment = attachments.find(a => a.id === cropTargetId);
          if (attachment) {
            // We need to fetch the file from the URL to pass to ImageCropper
            // For now, we'll create a simple wrapper that fetches it
            const fetchAndCrop = async () => {
              try {
                const url = resolveAttachmentUrl(attachment);
                if (!url) return null;

                const response = await fetch(url);
                const blob = await response.blob();
                const file = new File([blob], attachment.original_filename, { type: attachment.file_type });

                return (
                  <ImageCropper
                    imageFile={file}
                    onCrop={handleImageCrop}
                    onCancel={() => setCropTargetId(null)}
                  />
                );
              } catch (error) {
                console.error('Error loading image for crop:', error);
                setCropTargetId(null);
                return null;
              }
            };

            // Use a simple component to handle async loading
            const CropperWrapper = () => {
              const [cropperElement, setCropperElement] = React.useState<JSX.Element | null>(null);

              React.useEffect(() => {
                fetchAndCrop().then(setCropperElement);
              }, []);

              return cropperElement;
            };

            return <CropperWrapper />;
          }
          return null;
        })()
      }

      {/* ✅ Pop-out Input Modal */}
      <PopoutInput
        isOpen={popoutInput?.isOpen || false}
        onClose={() => setPopoutInput(null)}
        onSave={handlePopoutSave}
        initialValue={popoutInput?.field ? manualValues[popoutInput.field.index]?.[popoutInput.field.fieldName] || '' : ''}
        placeholder={popoutInput?.placeholder || ''}
        title={popoutInput?.title || ''}
        suggestions={popoutInput?.suggestions}
      />

      {/* Inline Dependency Editor */}
      {editingDependency && (
        <InlineDependencyEditor
          analyte={{
            id: editingDependency.value.analyte_id || '',
            lab_analyte_id: editingDependency.value.lab_analyte_id,
            name: editingDependency.value.parameter,
            formula: editingDependency.value.formula || '',
            formulaVariables: parseFormulaVariables(editingDependency.value.formula_variables),
          }}
          missingVariables={editingDependency.missingVariables}
          availableAnalytes={orderAnalytes
            .filter(a => !a.is_calculated && a.id !== editingDependency.value.analyte_id)
            .map(a => ({
              id: a.id,
              lab_analyte_id: a.lab_analyte_id,
              name: a.name,
              unit: a.unit,
              code: a.code,
            }))
          }
          onClose={() => setEditingDependency(null)}
          onSaved={() => {
            setEditingDependency(null);
            // Reload data and recalculate
            fetchOrderAnalytes();
          }}
        />
      )}

    </div >,
    document.body
  );
};

export default OrderDetailsModal;
