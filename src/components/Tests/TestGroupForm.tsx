import React, { useState, useEffect, useRef } from 'react';
import { X, Layers, TestTube, DollarSign, Clock, Settings, Plus, Search, AlertCircle, Brain, Building2, Edit, Sparkles, FileText, Code, RefreshCw, Calculator, Eye, EyeOff, Unlink } from 'lucide-react';

const CKEDITOR_VERSION = '47.1.0';
const CKEDITOR_SCRIPT_URL = `https://cdn.ckeditor.com/ckeditor5/${CKEDITOR_VERSION}/ckeditor5.umd.js`;
const CKEDITOR_CSS_URL = `https://cdn.ckeditor.com/ckeditor5/${CKEDITOR_VERSION}/ckeditor5.css`;
const LINKED_CKEDITOR_TEMPLATE_VALUE = '__linked_ckeditor_template__';
import { database, supabase } from '../../utils/supabase';
import {
  CalculatedDependency,
  selectPreferredCalculatedDependencies,
  dedupeDependenciesForSave,
} from '../../utils/calculatedDependencies';
import AnalyteForm from './AnalyteForm';
import { SimpleAnalyteEditor } from '../TestGroups/SimpleAnalyteEditor';
import ReportImportWizard from './ReportImportWizard';
import AnalyzerMappingPanel from './AnalyzerMappingPanel';
import BuiltinTemplatePreview from '../Reports/BuiltinTemplatePreview';
import BasicTemplateFormatBuilder from '../Reports/BasicTemplateFormatBuilder';
import { SampleTypeIndicator } from '../Common/SampleTypeIndicator';
import { SAMPLE_TYPES } from '../../utils/sampleTypes';

interface TestGroupFormProps {
  onClose: () => void;
  onSubmit: (data: any) => void;
  testGroup?: TestGroup | null;
}

interface TestGroup {
  id: string;
  name: string;
  code: string;
  category: string;
  clinicalPurpose: string;
  methodology?: string;
  description?: string;
  department?: string;
  analytes: string[];
  price: number;
  turnaroundTime: string;
  tat_hours?: number;
  sampleType: string;
  sampleConditionOptions?: string[];
  defaultSampleCondition?: string | null;
  requiresFasting: boolean;
  isActive: boolean;
  createdDate: string;
  lab_id?: string;
  to_be_copied?: boolean;
  is_outsourced?: boolean;
  default_outsourced_lab_id?: string;
  default_ai_processing_type?: string;
  group_level_prompt?: string;
  testType?: string;
  gender?: string;
  sampleColor?: string;
  barcodeSuffix?: string;
  lmpRequired?: boolean;
  idRequired?: boolean;
  consentForm?: boolean;
  preCollectionGuidelines?: string;
  flabsId?: string;
  onlyFemale?: boolean;
  onlyMale?: boolean;
  onlyBilling?: boolean;
  startFromNextPage?: boolean;
  ref_range_ai_config?: any;
  required_patient_inputs?: string[];
  default_template_style?: string | null;
  collection_charge?: number | null;
  report_priority?: number | null;
  print_options?: {
    tableBorders?: boolean;
    flagColumn?: boolean;
    flagAsterisk?: boolean;
    flagAsteriskCritical?: boolean;
    headerBackground?: string;
    alternateRows?: boolean;
    baseFontSize?: number;
    showSampleType?: boolean;
    showSampleCondition?: boolean;
    showSignature?: boolean;
    forceTableLayout?: boolean;
    analyteRowSpacing?: number;
    testGroupSpacing?: number;
  } | null;
  group_interpretation?: string | null;
  default_report_remark?: string | null;
  global_test_catalog_id?: string | null;
  analyzer_connection_id?: string | null;
  is_section_only?: boolean;
}

const INTERPRETATION_BLOCK_TAGS = /<\/(p|div|li|h[1-6]|tr)>/gi;
const INTERPRETATION_UNSUPPORTED_HTML = /<(table|figure|img|svg|iframe|canvas|video|section|article)\b/i;
const BULLET_PREFIX = /^(?:[•●▪◦\-*])\s*/;

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const decodeHtmlEntities = (value: string) => {
  if (typeof document !== 'undefined') {
    const textarea = document.createElement('textarea');
    textarea.innerHTML = value;
    return textarea.value;
  }

  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
};

const extractInterpretationLines = (value: string) => {
  const hasHtml = /<\/?[a-z][\s\S]*>/i.test(value);
  const text = hasHtml
    ? value
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<li\b[^>]*>/gi, '\n• ')
        .replace(INTERPRETATION_BLOCK_TAGS, '\n')
        .replace(/<[^>]+>/g, '')
    : value;

  return decodeHtmlEntities(text)
    .replace(/\u00a0/g, ' ')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
};

const normalizeGroupInterpretationHtml = (value: string | null | undefined) => {
  const raw = (value || '').trim();
  if (!raw) return null;

  if (INTERPRETATION_UNSUPPORTED_HTML.test(raw)) {
    return raw;
  }

  const lines = extractInterpretationLines(raw);
  if (!lines.length) return null;

  const paragraphs: string[] = [];
  let bulletGroup: string[] = [];

  const flushBullets = () => {
    if (!bulletGroup.length) return;
    paragraphs.push(
      `<p style="margin-left:20px;">${bulletGroup.map(line => escapeHtml(line)).join('<br>')}</p>`,
    );
    bulletGroup = [];
  };

  lines.forEach((line, index) => {
    if (BULLET_PREFIX.test(line)) {
      bulletGroup.push(`• ${line.replace(BULLET_PREFIX, '').trim()}`);
      return;
    }

    flushBullets();

    if (index === 0 && /^interpretation\s*[:-]\s*$/i.test(line)) {
      paragraphs.push(`<p style="margin-left:0;"><strong><u>${escapeHtml(line)}</u></strong></p>`);
      return;
    }

    paragraphs.push(`<p style="margin-left:0;">${escapeHtml(line)}</p>`);
  });

  flushBullets();

  return paragraphs.join('');
};

const TestGroupForm: React.FC<TestGroupFormProps> = ({ onClose, onSubmit, testGroup }) => {
  const [formData, setFormData] = useState({
    name: testGroup?.name || '',
    code: testGroup?.code || '',
    category: testGroup?.category || '',
    clinicalPurpose: testGroup?.clinicalPurpose || '',
    methodology: testGroup?.methodology || '',
    description: testGroup?.description || '',
    department: testGroup?.department || '',
    selectedAnalytes: testGroup?.analytes || [],
    price: testGroup?.price?.toString() || '',
    collection_charge: testGroup?.collection_charge?.toString() || '',
    turnaroundTime: testGroup?.turnaroundTime || '',
    tat_hours: testGroup?.tat_hours?.toString() || '3',
    sampleType: testGroup?.sampleType || '',
    sampleConditionOptions: testGroup?.sampleConditionOptions || [],
    defaultSampleCondition: testGroup?.defaultSampleCondition || '',
    requiresFasting: testGroup?.requiresFasting ?? false,
    isActive: testGroup?.isActive ?? true,
    default_ai_processing_type: testGroup?.default_ai_processing_type || 'THERMAL_SLIP_OCR',
    group_level_prompt: testGroup?.group_level_prompt || '',
    // New fields from the screenshot
    testType: testGroup?.testType || 'Default',
    gender: testGroup?.gender || 'Both',
    sampleColor: testGroup?.sampleColor || 'Red',
    barcodeSuffix: testGroup?.barcodeSuffix || '',
    lmpRequired: testGroup?.lmpRequired ?? false,
    idRequired: testGroup?.idRequired ?? false,
    consentForm: testGroup?.consentForm ?? false,
    preCollectionGuidelines: testGroup?.preCollectionGuidelines || '',
    flabsId: testGroup?.flabsId || '',
    onlyFemale: testGroup?.onlyFemale ?? false,
    onlyMale: testGroup?.onlyMale ?? false,
    onlyBilling: testGroup?.onlyBilling ?? false,
    startFromNextPage: testGroup?.startFromNextPage ?? false,
    default_template_style: testGroup?.default_template_style || '',
    report_priority: testGroup?.report_priority?.toString() || '',
    print_options: testGroup?.print_options ?? null,
    is_outsourced: testGroup?.is_outsourced ?? false,
    default_outsourced_lab_id: testGroup?.default_outsourced_lab_id || '',
    ref_range_ai_config: testGroup?.ref_range_ai_config || { enabled: false, consider_age: true },
    required_patient_inputs: testGroup?.required_patient_inputs || [],
    group_interpretation: testGroup?.group_interpretation || '',
    default_report_remark: testGroup?.default_report_remark || '',
    global_test_catalog_id: testGroup?.global_test_catalog_id || '',
    analyzer_connection_id: testGroup?.analyzer_connection_id || '',
    is_section_only: testGroup?.is_section_only ?? false,
  });

  const [analytes, setAnalytes] = useState<any[]>([]);
  const [calculatedDependencies, setCalculatedDependencies] = useState<CalculatedDependency[]>([]);
  const [outsourcedLabs, setOutsourcedLabs] = useState<any[]>([]);
  const [analyzerConnections, setAnalyzerConnections] = useState<any[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [showSelectedOnly, setShowSelectedOnly] = useState(false);
  const [showAnalyteForm, setShowAnalyteForm] = useState(false);
  const [loading, setLoading] = useState(true);
  const [editingAttachedAnalyte, setEditingAttachedAnalyte] = useState<any>(null);
  const [labMethodOptions, setLabMethodOptions] = useState<string[]>([]);
  const [newMethodValue, setNewMethodValue] = useState('');
  const [methodError, setMethodError] = useState<string | null>(null);
  const [labReportTemplates, setLabReportTemplates] = useState<Array<{
    id: string;
    template_name: string;
    test_group_id?: string | null;
    gjs_html?: string | null;
    is_interpretation_only?: boolean | null;
  }>>([]);
  const [reportLayoutSelection, setReportLayoutSelection] = useState(
    testGroup?.default_template_style || ''
  );
  type AnalyteReportDisplayOptions = {
    sameRowSiblingAnalyteId?: string | null;
    sameRowSiblingLabel?: string;
    sameRowSiblingPosition?: 'right';
    hiddenWhenRenderedAsSibling?: boolean;
  };
  type AnalyteMetadata = {
    tga_id?: string;
    lab_analyte_id?: string | null;
    sort_order: number;
    section_heading: string;
    is_visible: boolean;
    report_display_options?: AnalyteReportDisplayOptions;
  };
  // Per-analyte metadata for sort_order, section_heading, visibility, and report display options.
  const [analyteMetadata, setAnalyteMetadata] = useState<Record<string, AnalyteMetadata>>({});
  // All analytes linked to this test group (including hidden/inactive lab_analytes)
  const [allLinkedAnalytes, setAllLinkedAnalytes] = useState<any[]>([]);
  const [showImportWizard, setShowImportWizard] = useState(false);
  const [syncingGlobal, setSyncingGlobal] = useState(false);
  const [syncGlobalResult, setSyncGlobalResult] = useState<string | null>(null);
  const [aiLayoutBusy, setAiLayoutBusy] = useState(false);
  const [aiDropdownBusy, setAiDropdownBusy] = useState(false);
  const [aiCalcBusy, setAiCalcBusy] = useState(false);
  const [aiHelperResult, setAiHelperResult] = useState<string | null>(null);
  const [showReportPreview, setShowReportPreview] = useState(false);
  const [newSampleCondition, setNewSampleCondition] = useState('');

  // Group interpretation CKEditor state
  const [interpCkLoaded, setInterpCkLoaded] = useState(false);
  const [interpCkError, setInterpCkError] = useState<string | null>(null);
  const [interpTab, setInterpTab] = useState<'visual' | 'html'>('visual');
  const [showInterpEditor, setShowInterpEditor] = useState(!!testGroup?.group_interpretation);
  const interpEditorRef = useRef<HTMLDivElement>(null);
  const interpInitRef = useRef(false);

  // Load analytes and outsourced labs
  useEffect(() => {
    loadData();
    loadLabMethodOptions();
  }, []);

  // Load CKEditor for group interpretation editor
  useEffect(() => {
    if (!showInterpEditor) return;
    if (interpCkLoaded) return;
    const load = async () => {
      if ((window as any).CKEDITOR) { setInterpCkLoaded(true); return; }
      if (!document.querySelector(`link[href="${CKEDITOR_CSS_URL}"]`)) {
        const link = document.createElement('link');
        link.rel = 'stylesheet'; link.href = CKEDITOR_CSS_URL;
        document.head.appendChild(link);
      }
      const existing = document.querySelector(`script[src="${CKEDITOR_SCRIPT_URL}"]`);
      await new Promise<void>((resolve, reject) => {
        if (existing) {
          // Another component started the load — wait for that same tag to finish.
          if ((window as any).CKEDITOR) { resolve(); return; }
          existing.addEventListener('load', () => resolve());
          existing.addEventListener('error', () => reject(new Error('CKEditor CDN script failed to load')));
          return;
        }
        const s = document.createElement('script');
        s.src = CKEDITOR_SCRIPT_URL; s.async = true;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('CKEditor CDN script failed to load'));
        document.head.appendChild(s);
      });
      if (!(window as any).CKEDITOR?.ClassicEditor) {
        throw new Error('CKEditor loaded but did not expose ClassicEditor');
      }
      setInterpCkLoaded(true);
    };
    load().catch((e) => {
      console.error('CKEditor load error', e);
      setInterpCkError(e?.message || 'Could not load the visual editor');
    });
  }, [showInterpEditor]);

  // Init CKEditor once loaded and the visual tab is on screen.
  // CKEditor gets its own throwaway <div> (not the React-managed host) so that
  // React never fights it over the DOM, and StrictMode's double mount can't
  // leave a half-built editor behind.
  useEffect(() => {
    if (!showInterpEditor || !interpCkLoaded || interpTab !== 'visual') return;
    const host = interpEditorRef.current;
    if (!host || interpInitRef.current) return;
    interpInitRef.current = true;

    let cancelled = false;
    let created: any = null;
    const mount = document.createElement('div');
    host.appendChild(mount);

    const init = async () => {
      try {
        const CKE = (window as any).CKEDITOR;
        if (!CKE?.ClassicEditor) throw new Error('CKEditor bundle is not available');
        const { Essentials, Bold, Italic, Underline, Link, List, Paragraph, Heading,
                Alignment, Indent, IndentBlock, Table, TableToolbar, BlockQuote, Undo, SourceEditing } = CKE;
        const buildConfig = (licenseKey: string) => ({
          licenseKey,
          plugins: [Essentials, Bold, Italic, Underline, Link, List, Paragraph, Heading,
                    Alignment, Indent, IndentBlock, Table, TableToolbar, BlockQuote, Undo, SourceEditing],
          toolbar: ['heading', '|', 'bold', 'italic', 'underline', '|',
                    'link', 'bulletedList', 'numberedList', '|',
                    'alignment', 'indent', 'outdent', '|',
                    'insertTable', 'blockQuote', '|', 'undo', 'redo'],
          table: { contentToolbar: ['tableColumn', 'tableRow', 'mergeTableCells'] },
        });
        const envKey = (import.meta.env.VITE_CKEDITOR_LICENSE_KEY as string) || '';
        // Every plugin above is open source, so GPL is a valid fallback if the
        // configured key is missing/expired/invalid (CKEditor 47 refuses to start otherwise).
        let editor: any;
        try {
          editor = await CKE.ClassicEditor.create(mount, buildConfig(envKey || 'GPL'));
        } catch (licenseErr) {
          if (!envKey) throw licenseErr;
          console.warn('CKEditor license key rejected, falling back to GPL', licenseErr);
          mount.innerHTML = '';
          editor = await CKE.ClassicEditor.create(mount, buildConfig('GPL'));
        }
        created = editor;
        if (cancelled) { editor.destroy().catch(() => {}); return; }
        editor.setData(formData.group_interpretation || '');
        editor.model.document.on('change:data', () => {
          setFormData(prev => ({ ...prev, group_interpretation: editor.getData() }));
        });
        const el = editor.ui.view.editable.element;
        if (el) { el.style.minHeight = '140px'; el.style.maxHeight = '320px'; el.style.overflowY = 'auto'; }
        setInterpCkError(null);
      } catch (e: any) {
        console.error('CKEditor init error', e);
        // Never leave an empty box — surface the reason and let the HTML tab take over.
        setInterpCkError(e?.message || 'The visual editor could not start');
      }
    };
    init();

    return () => {
      cancelled = true;
      interpInitRef.current = false;
      if (created) created.destroy().catch(() => {}).finally(() => mount.remove());
      else mount.remove();
    };
  }, [showInterpEditor, interpCkLoaded, interpTab]);

  const loadData = async () => {
    try {
      setLoading(true);
      const labId = await database.getCurrentUserLabId();

      const requests: Promise<any>[] = [
        database.analytes.getAll(),
        supabase.from('outsourced_labs').select('*').eq('is_active', true).order('name') as unknown as Promise<any>,
        labId
          ? supabase.from('analyzer_connections').select('id, name, status, profile_id').eq('lab_id', labId).order('name') as unknown as Promise<any>
          : Promise.resolve({ data: [], error: null }),
      ];
      const reportTemplatesPromise = labId
        ? supabase
            .from('lab_templates')
            .select('id, template_name, test_group_id, gjs_html, is_interpretation_only')
            .eq('lab_id', labId)
            .eq('is_active', true)
            .not('gjs_html', 'is', null)
            .order('template_name') as unknown as Promise<any>
        : Promise.resolve({ data: [], error: null });
	      if (testGroup?.id) {
	        requests.push(
	          supabase
	            .from('test_group_analytes')
	            .select('id, analyte_id, lab_analyte_id, sort_order, section_heading, is_visible, report_display_options')
	            .eq('test_group_id', testGroup.id) as unknown as Promise<any>
	        );
	      }

      const [requestResults, reportTemplatesRes] = await Promise.all([
        Promise.all(requests),
        reportTemplatesPromise,
      ]);
      const [analytesRes, labsRes, analyzerRes, tgaRes] = requestResults;

      if (reportTemplatesRes?.error) {
        console.error('Error loading report templates:', reportTemplatesRes.error);
      } else {
        const templates = (reportTemplatesRes?.data || []).filter((template: any) =>
          template?.gjs_html && !template?.is_interpretation_only
        );
        setLabReportTemplates(templates);
        if (!testGroup?.default_template_style && testGroup?.id && templates.some((template: any) => template.test_group_id === testGroup.id)) {
          setReportLayoutSelection(LINKED_CKEDITOR_TEMPLATE_VALUE);
        }
      }

      // Fetch all linked analytes with lab_analytes as source of truth.
      // lab_analytes is always the authoritative source for test-group-linked analytes.
      // Global analytes table is only used as fallback for fields not present in lab_analytes.
      let allLinkedData: any[] = [];
      if (testGroup?.id) {
        if (labId) {
          // Use TGA rows already fetched above (includes lab_analyte_id)
          const tgaRows = tgaRes?.data || [];

          const withLabAnalyte = (tgaRows || []).filter((r: any) => r.lab_analyte_id);
          const withoutLabAnalyte = (tgaRows || []).filter((r: any) => !r.lab_analyte_id);

          const labAnalyteIds = withLabAnalyte.map((r: any) => r.lab_analyte_id);
          const fallbackAnalyteIds = withoutLabAnalyte.map((r: any) => r.analyte_id).filter(Boolean);

            const LA_SELECT = `
              id, analyte_id, sample_type,
              name, unit, category, reference_range, method,
              low_critical, high_critical,
              interpretation_low, interpretation_normal, interpretation_high,
              lab_specific_reference_range,
            lab_specific_interpretation_low,
            lab_specific_interpretation_normal,
            lab_specific_interpretation_high,
            value_type, decimal_places, min_integer_digits, expected_normal_values, expected_value_flag_map,
            expected_value_codes, default_value,
            is_calculated, formula, formula_variables, formula_description, calculation_result_type,
            is_critical, normal_range_min, normal_range_max,
            ai_processing_type, group_ai_mode, ai_prompt_override,
            ref_range_knowledge, display_name, is_active,
            analytes!inner(id, name, unit, reference_range, category, is_active, is_global, is_calculated, formula, formula_variables, formula_description, calculation_result_type)
          `;

          // Fetch by lab_analyte_id (exact, no duplicates)
          const [directRes, fallbackRes] = await Promise.all([
            labAnalyteIds.length > 0
              ? supabase.from('lab_analytes').select(LA_SELECT).in('id', labAnalyteIds)
              : Promise.resolve({ data: [] }),
            fallbackAnalyteIds.length > 0
              ? supabase.from('lab_analytes').select(LA_SELECT).eq('lab_id', labId).in('analyte_id', fallbackAnalyteIds)
              : Promise.resolve({ data: [] }),
          ]);

          // Merge: prefer direct rows; for fallback, deduplicate by analyte_id (take first)
          const seenAnalyteIds = new Set<string>();
          const laRows: any[] = [];
          for (const la of ((directRes.data || []) as any[])) {
            if (!seenAnalyteIds.has(la.analyte_id)) {
              seenAnalyteIds.add(la.analyte_id);
              laRows.push(la);
            }
          }
          for (const la of ((fallbackRes.data || []) as any[])) {
            if (!seenAnalyteIds.has(la.analyte_id)) {
              seenAnalyteIds.add(la.analyte_id);
              laRows.push(la);
            }
          }

          const linkedIds = laRows.map((la: any) => la.analyte_id);

          if (linkedIds.length > 0) {
            // Helper: parse jsonb that Supabase may return as a raw JSON string
            const parseJsonb = <T,>(val: any, fallback: T): T => {
              if (val === null || val === undefined) return fallback;
              if (typeof val === 'string') {
                try { return JSON.parse(val) as T; } catch { return fallback; }
              }
              return val as T;
            };

            allLinkedData = laRows.map((la: any) => {
                const global = Array.isArray(la.analytes) ? la.analytes[0] : la.analytes;

                const expectedNormalValues = parseJsonb<string[]>(la.expected_normal_values, []);
                const expectedValueFlagMap = parseJsonb<Record<string, string>>(la.expected_value_flag_map, {});
                const expectedValueCodes   = parseJsonb<Record<string, string>>(la.expected_value_codes, {});
                const refRangeKnowledge    = parseJsonb<any>(la.ref_range_knowledge, {});
                // formula_variables may be stored as JSON string "[]" or an actual array
                const laFormulaVars  = parseJsonb<string[]>(la.formula_variables, []);
                const glbFormulaVars = parseJsonb<string[]>(global?.formula_variables, []);

                return {
                  // Identity — always from global analytes
                  id: la.analyte_id,
                  lab_analyte_id: la.id,  // preserve lab_analyte PK for interface config lookup
                  sample_type: la.sample_type ?? global?.sample_type ?? null,
                  category: la.category ?? global?.category ?? '',
                  is_global: global?.is_global ?? false,
                  // All display/entry fields — lab_analytes is source of truth, global is fallback
                  name: la.name || global?.name,
                  unit: la.unit || global?.unit,
                  // Use ?? not || so explicit empty string (user cleared field) is respected
                  reference_range: la.lab_specific_reference_range ?? la.reference_range ?? global?.reference_range,
                  referenceRange:  la.lab_specific_reference_range ?? la.reference_range ?? global?.reference_range,
                  method: la.method,
                  low_critical: la.low_critical,
                  high_critical: la.high_critical,
                  interpretation_low:    la.lab_specific_interpretation_low    || la.interpretation_low,
                  interpretation_normal: la.lab_specific_interpretation_normal || la.interpretation_normal,
                  interpretation_high:   la.lab_specific_interpretation_high   || la.interpretation_high,
                  value_type: la.value_type || null,
                  // Lab-level only: null means "inherit", so do NOT fall back to the
                  // global value here or the editor would show it as a lab override.
                  decimal_places: la.decimal_places ?? null,
                  min_integer_digits: la.min_integer_digits ?? null,
                  expected_normal_values: expectedNormalValues,
                  expected_value_flag_map: expectedValueFlagMap,
                  expected_value_codes: expectedValueCodes,
                  default_value: la.default_value ?? null,
                  // Formula: lab_analytes wins, fall back to global
                  // (calculated analytes from AI configurator store formula on global table initially)
                  is_calculated:    la.is_calculated    ?? global?.is_calculated    ?? false,
                  formula:          la.formula          ?? global?.formula          ?? null,
                  formula_variables: laFormulaVars.length > 0 ? laFormulaVars : glbFormulaVars,
                  formula_description: la.formula_description ?? global?.formula_description ?? null,
                  calculation_result_type: la.calculation_result_type ?? global?.calculation_result_type ?? 'numeric',
                  is_critical:     la.is_critical ?? false,
                  normal_range_min: la.normal_range_min,
                  normal_range_max: la.normal_range_max,
                  ai_processing_type: la.ai_processing_type,
                  group_ai_mode: la.group_ai_mode,
                  ai_prompt_override: la.ai_prompt_override ?? null,
                  ref_range_knowledge: refRangeKnowledge,
                  display_name: la.display_name ?? null,
                  is_active: la.is_active,
                };
            });
          }
        }
      }

      if (analytesRes.error) {
        console.error('Error loading analytes:', analytesRes.error);
      } else {
        setAnalytes(analytesRes.data || []);
      }

      if (labsRes.error) {
        console.error('Error loading outsourced labs:', labsRes.error);
      } else {
        setOutsourcedLabs(labsRes.data || []);
      }

      if (!analyzerRes?.error) {
        setAnalyzerConnections(analyzerRes?.data || []);
      }

	      if (tgaRes && !tgaRes.error && tgaRes.data) {
	        const meta: Record<string, AnalyteMetadata> = {};
	        for (const row of tgaRes.data) {
	          meta[row.analyte_id] = {
	            tga_id: row.id,
	            lab_analyte_id: row.lab_analyte_id,
	            sort_order: row.sort_order ?? 0,
	            section_heading: row.section_heading ?? '',
	            is_visible: row.is_visible ?? true,
	            report_display_options: row.report_display_options || {},
	          };
	        }
	        setAnalyteMetadata(meta);
	      }

      if (allLinkedData.length > 0) {
        setAllLinkedAnalytes(allLinkedData);
      }
    } catch (error) {
      console.error('Error loading data:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadLabMethodOptions = async () => {
    try {
      const { data, error: loadError } = await database.labs.getById();
      if (loadError) {
        console.error('Failed to load lab method options:', loadError);
        return;
      }
      const options = Array.isArray(data?.method_options) ? data.method_options : [];
      setLabMethodOptions(options);
    } catch (error) {
      console.error('Failed to load lab method options:', error);
    }
  };

  const handleAddMethodOption = async () => {
    setMethodError(null);
    const trimmed = newMethodValue.trim();
    if (!trimmed) return;
    if (labMethodOptions.some((option) => option.toLowerCase() === trimmed.toLowerCase())) {
      setFormData(prev => ({ ...prev, methodology: trimmed }));
      setNewMethodValue('');
      return;
    }

    try {
      const labId = await database.getCurrentUserLabId();
      if (!labId) {
        setMethodError('No lab context found.');
        return;
      }

      const nextOptions = [...labMethodOptions, trimmed];
      const { error: updateError } = await database.labs.update(labId, {
        method_options: nextOptions,
      });

      if (updateError) {
        setMethodError(updateError instanceof Error ? updateError.message : 'Failed to add method');
        return;
      }

      setLabMethodOptions(nextOptions);
      setFormData(prev => ({ ...prev, methodology: trimmed }));
      setNewMethodValue('');
    } catch (error) {
      console.error('Failed to update lab method options:', error);
      setMethodError(error instanceof Error ? error.message : 'Failed to add method');
    }
  };

  // Filter analytes based on search query, selected state, and test-group sample type.
  const filteredAnalytes = (() => {
    const selectedSampleType = String(formData.sampleType || '').trim().toLowerCase();
    const filtered = analytes.filter(analyte => {
      const analyteSampleType = String(analyte.sample_type || analyte.sampleType || '').trim().toLowerCase();
      const matchesSearch =
        analyte.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        analyte.category.toLowerCase().includes(searchQuery.toLowerCase()) ||
        analyte.unit.toLowerCase().includes(searchQuery.toLowerCase());
      const matchesSelected = !showSelectedOnly || formData.selectedAnalytes.includes(analyte.id);
      const matchesSampleType =
        !selectedSampleType ||
        !analyteSampleType ||
        analyteSampleType === selectedSampleType ||
        formData.selectedAnalytes.includes(analyte.id);
      return matchesSearch && matchesSelected && matchesSampleType;
    });

    if (!selectedSampleType) return filtered;

    const bestByAnalyteId = new Map<string, any>();
    const score = (analyte: any) => {
      const analyteSampleType = String(analyte.sample_type || analyte.sampleType || '').trim().toLowerCase();
      if (analyteSampleType === selectedSampleType) return 2;
      if (!analyteSampleType) return 1;
      return 0;
    };

    for (const analyte of filtered) {
      const existing = bestByAnalyteId.get(analyte.id);
      if (!existing || score(analyte) > score(existing)) {
        bestByAnalyteId.set(analyte.id, analyte);
      }
    }

    return Array.from(bestByAnalyteId.values());
  })();

  useEffect(() => {
    const loadCalculatedDependencies = async () => {
      const calculatedAnalyteIds = analytes
        .filter((analyte) => analyte.is_calculated && formData.selectedAnalytes.includes(analyte.id))
        .map((analyte) => analyte.id);

      if (!testGroup?.id || calculatedAnalyteIds.length === 0) {
        setCalculatedDependencies([]);
        return;
      }

      const labId = await database.getCurrentUserLabId();
      let query = supabase
        .from('analyte_dependencies')
        .select('calculated_analyte_id, calculated_lab_analyte_id, source_analyte_id, source_lab_analyte_id, variable_name, lab_id')
        .in('calculated_analyte_id', calculatedAnalyteIds);
      if (labId) {
        query = query.or(`lab_id.eq.${labId},lab_id.is.null`);
      }

      const { data, error } = await query;
      if (error) {
        console.error('Error loading calculated dependency warnings:', error);
        return;
      }
      setCalculatedDependencies((data || []) as CalculatedDependency[]);
    };

    loadCalculatedDependencies();
  }, [testGroup?.id, analytes, formData.selectedAnalytes]);

  const handleAddNewAnalyte = async (analyteData: any) => {
    try {
      // Use database.analytes.create() — this also creates the lab_analytes row
      // so the analyte becomes visible in the Analytes list immediately
      const { data, error } = await database.analytes.create({
        name: analyteData.name,
        unit: analyteData.unit,
        reference_range: analyteData.referenceRange,
        low_critical: analyteData.lowCritical,
        high_critical: analyteData.highCritical,
        interpretation_low: analyteData.interpretation?.low,
        interpretation_normal: analyteData.interpretation?.normal,
        interpretation_high: analyteData.interpretation?.high,
        category: analyteData.category,
        sample_type: formData.sampleType || null,
        is_active: analyteData.isActive ?? true,
        is_global: false,
        ai_processing_type: analyteData.aiProcessingType,
        ai_prompt_override: analyteData.aiPromptOverride,
        group_ai_mode: analyteData.groupAiMode || 'individual',
        is_calculated: analyteData.isCalculated || false,
        formula: analyteData.isCalculated ? (analyteData.formula || null) : null,
        formula_variables: analyteData.isCalculated && analyteData.formulaVariables?.length
          ? analyteData.formulaVariables
          : [],
        formula_description: analyteData.isCalculated ? (analyteData.formulaDescription || null) : null,
        calculation_result_type: analyteData.calculation_result_type || analyteData.calculationResultType || 'numeric',
      });

      if (error) {
        console.error('Error creating analyte:', error);
        alert('Failed to create analyte. Please try again.');
        return;
      }

      // Save lab-specific analyte_dependencies if source analytes were selected
	      if (analyteData.isCalculated && analyteData.sourceDependencies?.length > 0) {
	        const depsLabId = await database.getCurrentUserLabId();
	        const { error: depError } = await database.analyteDependencies.setDependencies(
	          data.id,
	          analyteData.sourceDependencies,
	          depsLabId ?? undefined,
	          data.lab_analyte_id || null,
	        );
	        if (depError) {
	          console.error('Error creating dependencies:', depError);
        }
      }

      // Refresh analytes list
      await loadData();

      // Auto-select the newly created analyte
      setFormData(prev => ({
        ...prev,
        selectedAnalytes: [...prev.selectedAnalytes, data.id]
      }));

      setShowAnalyteForm(false);
      alert('Analyte created successfully for your lab!');
    } catch (error) {
      console.error('Error creating analyte:', error);
      alert('Failed to create analyte. Please try again.');
    }
  };

  const handleUpdateAttachedAnalyte = async (_updatedAnalyte: any) => {
    // SimpleAnalyteEditor already saved all fields to lab_analytes directly.
    // Do not save again here — a second partial save would strip fields like
    // value_type, expected_value_codes, default_value that were just written.
    // Just reload from DB (lab_analytes is now source of truth) and close.
    await loadData();
    setEditingAttachedAnalyte(null);
  };

  const categories = [
    'Hematology',
    'Biochemistry',
    'Serology',
    'Microbiology',
    'Immunology',
    'Immunohematology',
    'Blood Banking',
    'Molecular Diagnostics',
    'Clinical Pathology',
    'Histopathology',
    'Cytology',
    'Toxicology',
    'Endocrinology',
    'Cardiology',
    'Radiology',
    'General',
  ];

  const sampleTypes = SAMPLE_TYPES;

  const handleSyncFromGlobal = async () => {
    if (!testGroup?.name || syncingGlobal) return;
    setSyncingGlobal(true);
    setSyncGlobalResult(null);
    try {
      const labId = await database.getCurrentUserLabId();
      if (!labId) throw new Error('Unable to determine lab context');
      console.log('[SyncFromGlobal] lab_id:', labId, 'test_group_name:', testGroup.name, 'test_group_code:', testGroup.code);
      const { data, error: fnError } = await supabase.functions.invoke('onboarding-lab', {
        body: { lab_id: labId, mode: 'single', test_group_name: testGroup.name, test_group_code: testGroup.code }
      });
      if (fnError) throw new Error(fnError.message);
      if (!data?.success) {
        if (data?.debug) console.error('[SyncFromGlobal] debug:', data.debug);
        throw new Error(data?.error || 'Sync failed');
      }
      const parts = [];
      if (data.analytesAdded) parts.push(`${data.analytesAdded} added`);
      if (data.analytesUpdated) parts.push(`${data.analytesUpdated} updated`);
      if (data.groupDetailsSynced) parts.push('test details updated');
      if (data.interpretationSynced) parts.push('interpretation updated');
      const msg = parts.length ? `Synced: ${parts.join(', ')}` : 'Synced: already up to date';
      setSyncGlobalResult(msg);
      if (data.syncedTestGroup) {
        setFormData(prev => ({
          ...prev,
          code: data.syncedTestGroup.code || prev.code,
          category: data.syncedTestGroup.category || prev.category,
          sampleType: data.syncedTestGroup.sample_type || prev.sampleType,
          default_ai_processing_type: data.syncedTestGroup.default_ai_processing_type || prev.default_ai_processing_type,
          group_level_prompt: data.syncedTestGroup.group_level_prompt ?? prev.group_level_prompt,
          global_test_catalog_id: data.syncedTestGroup.global_test_catalog_id || prev.global_test_catalog_id,
        }));
      }
      // Refresh metadata so sort_order and section_heading populate from the DB
      await loadData();
    } catch (err: any) {
      setSyncGlobalResult(`Error: ${err.message}`);
    } finally {
      setSyncingGlobal(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      // Get current user's lab_id
      const labId = await database.getCurrentUserLabId();

      // Auto-sync legacy booleans from required_patient_inputs
      const rpi = formData.required_patient_inputs;
      const sampleConditionOptions = Array.from(
        new Set(
          (formData.sampleConditionOptions || [])
            .map((value: string) => value.trim())
            .filter(Boolean),
        ),
      );
      const defaultSampleCondition = sampleConditionOptions.includes(formData.defaultSampleCondition)
        ? formData.defaultSampleCondition
        : sampleConditionOptions[0] || '';
      const groupInterpretationHtml = normalizeGroupInterpretationHtml(formData.group_interpretation);

      onSubmit({
        ...formData,
        sampleConditionOptions,
        defaultSampleCondition: defaultSampleCondition || null,
        category: formData.category || null,
        analytes: formData.is_section_only ? [] : formData.selectedAnalytes,
        analyteMetadata: formData.is_section_only ? {} : analyteMetadata,
        price: parseFloat(formData.price),
        collection_charge: formData.collection_charge ? parseFloat(formData.collection_charge) : null,
        tat_hours: parseFloat(formData.tat_hours) || 3,
        default_ai_processing_type: formData.default_ai_processing_type,
        group_level_prompt: formData.group_level_prompt,
        methodology: formData.methodology || null,
        description: formData.description || null,
        department: formData.department || null,
        lab_id: labId,
        to_be_copied: false,
        is_outsourced: formData.is_outsourced,
        default_outsourced_lab_id: formData.default_outsourced_lab_id || null,
        ref_range_ai_config: formData.ref_range_ai_config,
        required_patient_inputs: formData.required_patient_inputs,
        default_template_style:
          reportLayoutSelection === LINKED_CKEDITOR_TEMPLATE_VALUE
            ? null
            : formData.default_template_style || null,
        report_priority: formData.report_priority ? parseInt(formData.report_priority, 10) : null,
        print_options: formData.print_options || null,
        group_interpretation: groupInterpretationHtml,
        default_report_remark: formData.default_report_remark?.trim() || null,
        global_test_catalog_id: formData.global_test_catalog_id || null,
        analyzer_connection_id: formData.analyzer_connection_id || null,
        is_section_only: formData.is_section_only,
        // Auto-sync legacy boolean fields from required_patient_inputs
        lmpRequired: rpi.includes('lmp'),
        idRequired: rpi.includes('id_document'),
        consentForm: rpi.includes('consent_form'),
      });
    } catch (error) {
      console.error('Error getting lab ID:', error);
      alert('Error: Could not determine your lab. Please try again.');
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value, type } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: type === 'checkbox' ? (e.target as HTMLInputElement).checked : value
    }));
  };

  const addSampleConditionOption = () => {
    const value = newSampleCondition.trim();
    if (!value) return;
    setFormData(prev => {
      const options = Array.from(new Set([...(prev.sampleConditionOptions || []), value]));
      return {
        ...prev,
        sampleConditionOptions: options,
        defaultSampleCondition: prev.defaultSampleCondition || value,
      };
    });
    setNewSampleCondition('');
  };

  const removeSampleConditionOption = (value: string) => {
    setFormData(prev => {
      const options = (prev.sampleConditionOptions || []).filter((item: string) => item !== value);
      return {
        ...prev,
        sampleConditionOptions: options,
        defaultSampleCondition: prev.defaultSampleCondition === value ? (options[0] || '') : prev.defaultSampleCondition,
      };
    });
  };

	  const handleAnalyteSelection = (analyteId: string) => {
	    setFormData(prev => ({
	      ...prev,
	      selectedAnalytes: prev.selectedAnalytes.includes(analyteId)
	        ? prev.selectedAnalytes.filter(id => id !== analyteId)
        : [...prev.selectedAnalytes, analyteId]
	    }));
	  };

	  const updateSameRowSibling = (primaryId: string, siblingId: string) => {
	    setAnalyteMetadata(prev => {
	      const primary = prev[primaryId] || { sort_order: 0, section_heading: '', is_visible: true };
	      const previousSiblingId = primary.report_display_options?.sameRowSiblingAnalyteId || '';
	      const next: Record<string, AnalyteMetadata> = {
	        ...prev,
	        [primaryId]: {
	          ...primary,
	          report_display_options: siblingId
	            ? {
	                ...(primary.report_display_options || {}),
	                sameRowSiblingAnalyteId: siblingId,
	                sameRowSiblingLabel: primary.report_display_options?.sameRowSiblingLabel || 'Absolute Count',
	                sameRowSiblingPosition: 'right',
	              }
	            : {
	                ...(primary.report_display_options || {}),
	                sameRowSiblingAnalyteId: null,
	                sameRowSiblingLabel: '',
	              },
	        },
	      };

	      if (previousSiblingId && previousSiblingId !== siblingId && prev[previousSiblingId]) {
	        const oldSibling = prev[previousSiblingId];
	        next[previousSiblingId] = {
	          ...oldSibling,
	          report_display_options: {
	            ...(oldSibling.report_display_options || {}),
	            hiddenWhenRenderedAsSibling: false,
	          },
	        };
	      }

	      for (const [id, meta] of Object.entries(prev)) {
	        if (id !== primaryId && meta.report_display_options?.sameRowSiblingAnalyteId === siblingId) {
	          next[id] = {
	            ...meta,
	            report_display_options: {
	              ...(meta.report_display_options || {}),
	              sameRowSiblingAnalyteId: null,
	              sameRowSiblingLabel: '',
	            },
	          };
	        }
	      }

	      if (siblingId) {
	        const sibling = next[siblingId] || prev[siblingId] || { sort_order: 0, section_heading: '', is_visible: true };
	        next[siblingId] = {
	          ...sibling,
	          report_display_options: {
	            ...(sibling.report_display_options || {}),
	            hiddenWhenRenderedAsSibling: true,
	          },
	        };
	      }

	      return next;
	    });
	  };

  // Provider-only controls: keep code in place but hidden from lab UI.
  const showProviderOnlyFields = false;

  const aiProcessingTypes = [
    { value: 'MANUAL_ENTRY_NO_VISION', label: 'Manual Entry (No AI)', description: 'Manual data entry without AI vision processing' },
    { value: 'THERMAL_SLIP_OCR', label: 'Thermal Slip OCR', description: 'Extract values from thermal printer slips (analyzers)' },
    { value: 'INSTRUMENT_SCREEN_OCR', label: 'Instrument Screen OCR', description: 'Extract values from instrument display screens' },
    { value: 'RAPID_CARD_LFA', label: 'Rapid Card / LFA', description: 'Analyze lateral flow assay cards (pregnancy, malaria, etc.)' },
    { value: 'COLOR_STRIP_MULTIPARAM', label: 'Color Strip (Multi-param)', description: 'Multi-parameter color strip analysis (urine, water)' },
    { value: 'SINGLE_WELL_COLORIMETRIC', label: 'Single Well Colorimetric', description: 'Single well/tube color analysis (ELISA, chemistry)' },
    { value: 'AGGLUTINATION_CARD', label: 'Agglutination Card', description: 'Blood typing and agglutination pattern analysis' },
    { value: 'MICROSCOPY_MORPHOLOGY', label: 'Microscopy Morphology', description: 'Microscope image analysis (blood smear, microbiology)' },
    { value: 'ZONE_OF_INHIBITION', label: 'Zone of Inhibition', description: 'Antibiotic sensitivity zone measurement' },
    { value: 'MENISCUS_SCALE_READING', label: 'Meniscus Scale Reading', description: 'ESR tube or graduated scale reading' },
    { value: 'SAMPLE_QUALITY_TUBE_CHECK', label: 'Sample Quality Check', description: 'Sample quality verification (hemolysis, lipemia)' },
    { value: 'UNKNOWN_NEEDS_REVIEW', label: 'Unknown (Needs Review)', description: 'Uncategorized - requires manual classification' },
  ];

  // Build selected analyte details: prefer rich lab_analytes data, fall back to global analytes
  // This ensures hidden/inactive lab_analytes are still shown, AND newly added analytes appear too
  const selectedAnalyteDetails = (() => {
    const linkedIds = new Set(allLinkedAnalytes.map((a: any) => a.id));
    // Existing linked analytes — use lab_analytes data as source of truth.
    // Do NOT replace with global analyte: it lacks lab-specific fields like
    // expected_value_codes, value_type, default_value, reference_range overrides.
    const base = allLinkedAnalytes.map((linked: any) => linked);
    // Newly checked analytes not yet in the DB-fetched list
    const newlyAdded = analytes.filter(a =>
      formData.selectedAnalytes.includes(a.id) && !linkedIds.has(a.id)
    );
    const analytePool = [...base, ...newlyAdded].filter(a =>
      formData.selectedAnalytes.includes(a.id)
    );
    // Sort by sort_order (0 means unset, put those last)
    return [...analytePool].sort((a, b) => {
      const oa = analyteMetadata[a.id]?.sort_order ?? 0;
      const ob = analyteMetadata[b.id]?.sort_order ?? 0;
      if (oa === 0 && ob === 0) return 0;
      if (oa === 0) return 1;
      if (ob === 0) return -1;
      return oa - ob;
    });
  })();

  const buildAiHelperPayload = (action: 'layout_order' | 'dropdown_values' | 'calculated_fields') => ({
    action,
    test_group: {
      name: formData.name || testGroup?.name || '',
      code: formData.code || testGroup?.code || '',
      category: formData.category || testGroup?.category || '',
      sample_type: formData.sampleType || testGroup?.sampleType || '',
    },
    analytes: selectedAnalyteDetails.map((analyte: any, index: number) => {
      const meta = analyteMetadata[analyte.id] || { sort_order: 0, section_heading: '', is_visible: true };
      const expectedValues = Array.isArray(analyte.expected_normal_values)
        ? analyte.expected_normal_values
        : [];
      return {
        analyte_id: analyte.id,
        lab_analyte_id: meta.lab_analyte_id || analyte.lab_analyte_id || null,
        name: analyte.name,
        code: analyte.code || '',
        unit: analyte.unit || '',
        category: analyte.category || '',
        sample_type: analyte.sample_type || analyte.sampleType || '',
        value_type: analyte.value_type || '',
        expected_normal_values: expectedValues,
        reference_range: analyte.referenceRange || analyte.reference_range || '',
        sort_order: meta.sort_order || index + 1,
        section_heading: meta.section_heading || '',
        is_calculated: analyte.is_calculated ?? false,
        formula: analyte.formula || '',
        formula_variables: Array.isArray(analyte.formula_variables) ? analyte.formula_variables : [],
      };
    }),
  });

  const invokeAiHelper = async (action: 'layout_order' | 'dropdown_values' | 'calculated_fields') => {
    const payload = buildAiHelperPayload(action);
    const { data, error } = await supabase.functions.invoke('ai-test-group-analyte-helper', {
      body: payload,
    });
    if (error) throw new Error(error.message);
    if (!data?.success) throw new Error(data?.error || 'AI helper failed');
    return data.data || {};
  };

  const handleAiArrangeSections = async () => {
    if (aiLayoutBusy || formData.is_section_only || selectedAnalyteDetails.length === 0) return;
    setAiLayoutBusy(true);
    setAiHelperResult(null);
    try {
      const result = await invokeAiHelper('layout_order');
      const items = Array.isArray(result.items) ? result.items : [];
      if (items.length === 0) throw new Error('AI did not return any layout suggestions');

      setAnalyteMetadata(prev => {
        const next = { ...prev };
        for (const item of items) {
          const analyteId = String(item.analyte_id || '');
          if (!analyteId) continue;
          const current = next[analyteId] || { sort_order: 0, section_heading: '', is_visible: true };
          const proposedSection = String(item.section_heading || '').trim();
          next[analyteId] = {
            ...current,
            sort_order: Number(item.sort_order) || current.sort_order || 0,
            section_heading: current.section_heading || proposedSection,
            is_visible: current.is_visible ?? true,
          };
        }
        return next;
      });

      setAiHelperResult(`AI arranged ${items.length} analytes. Existing section headings were kept.`);
    } catch (error: any) {
      setAiHelperResult(`Error: ${error.message || 'AI layout failed'}`);
    } finally {
      setAiLayoutBusy(false);
    }
  };

  const handleAiDropdownValues = async () => {
    if (aiDropdownBusy || formData.is_section_only || selectedAnalyteDetails.length === 0) return;
    setAiDropdownBusy(true);
    setAiHelperResult(null);
    try {
      const result = await invokeAiHelper('dropdown_values');
      const updates = Array.isArray(result.updates) ? result.updates : [];
      const createVariants = Array.isArray(result.create_variants) ? result.create_variants : [];
      let changed = 0;

      for (const update of updates) {
        const labAnalyteId = update.lab_analyte_id;
        if (!labAnalyteId) continue;
        const expectedValues = Array.isArray(update.expected_normal_values)
          ? update.expected_normal_values.map((value: any) => String(value).trim()).filter(Boolean)
          : [];
        const updatePayload: Record<string, any> = {};
        if (update.value_type) updatePayload.value_type = update.value_type;
        if (expectedValues.length > 0) updatePayload.expected_normal_values = expectedValues;
        if (Object.keys(updatePayload).length === 0) continue;

        const { error } = await database.labAnalytes.updateFieldsById(labAnalyteId, updatePayload);
        if (error) throw new Error(error.message || `Failed updating ${labAnalyteId}`);
        setAllLinkedAnalytes(prev => prev.map((analyte: any) =>
          analyte.lab_analyte_id === labAnalyteId
            ? { ...analyte, ...updatePayload }
            : analyte
        ));
        setAnalytes(prev => prev.map((analyte: any) =>
          analyte.lab_analyte_id === labAnalyteId
            ? { ...analyte, ...updatePayload }
            : analyte
        ));
        changed++;
      }

      for (const variant of createVariants) {
        const replaceAnalyteId = String(variant.replace_analyte_id || '');
        const expectedValues = Array.isArray(variant.expected_normal_values)
          ? variant.expected_normal_values.map((value: any) => String(value).trim()).filter(Boolean)
          : [];
        if (!replaceAnalyteId || !variant.name) continue;

        const { data: created, error } = await database.analytes.create({
          name: String(variant.name),
          code: variant.code || undefined,
          unit: variant.unit || '',
          reference_range: variant.reference_range || '',
          category: variant.category || formData.category || 'General',
          sample_type: variant.sample_type || formData.sampleType || null,
          is_active: true,
          is_global: false,
          value_type: variant.value_type || 'semi_quantitative',
          expected_normal_values: expectedValues,
          group_ai_mode: 'individual',
        });
        if (error || !created?.id) {
          throw new Error(error?.message || `Failed creating ${variant.name}`);
        }

        const replacementMeta = analyteMetadata[replaceAnalyteId] || { sort_order: 0, section_heading: '', is_visible: true };
        setFormData(prev => ({
          ...prev,
          selectedAnalytes: prev.selectedAnalytes.map((id: string) => id === replaceAnalyteId ? created.id : id),
        }));
        setAnalyteMetadata(prev => {
          const next = { ...prev };
          delete next[replaceAnalyteId];
          next[created.id] = {
            ...replacementMeta,
            lab_analyte_id: created.lab_analyte_id || null,
            sort_order: Number(variant.sort_order) || replacementMeta.sort_order || 0,
            section_heading: replacementMeta.section_heading || String(variant.section_heading || '').trim(),
            is_visible: replacementMeta.is_visible ?? true,
          };
          return next;
        });
        const createdForList = {
          ...created,
          referenceRange: created.reference_range,
          sample_type: created.sample_type || variant.sample_type || formData.sampleType || null,
          value_type: variant.value_type || 'semi_quantitative',
          expected_normal_values: expectedValues,
        };
        setAnalytes(prev => [...prev, createdForList]);
        setAllLinkedAnalytes(prev => [
          ...prev.filter((analyte: any) => analyte.id !== replaceAnalyteId),
          createdForList,
        ]);
        changed++;
      }

      setAiHelperResult(
        changed > 0
          ? `AI updated dropdown/value type for ${changed} analyte${changed !== 1 ? 's' : ''}. Save the test group to persist replacements.`
          : 'AI found no dropdown changes needed.'
      );
    } catch (error: any) {
      setAiHelperResult(`Error: ${error.message || 'AI dropdown setup failed'}`);
    } finally {
      setAiDropdownBusy(false);
    }
  };

  const handleAiCalculatedFields = async () => {
    if (aiCalcBusy || formData.is_section_only || selectedAnalyteDetails.length === 0) return;
    setAiCalcBusy(true);
    setAiHelperResult(null);
    try {
      const labId = await database.getCurrentUserLabId();
      if (!labId) throw new Error('Unable to determine lab context');

      const result = await invokeAiHelper('calculated_fields');
      const calculated = Array.isArray(result.calculated) ? result.calculated : [];
      if (calculated.length === 0) {
        setAiHelperResult('AI found no calculated fields in this test group.');
        return;
      }

      // Lookup for resolving AI source references back to real analyte rows
      const analyteById = new Map<string, any>();
      for (const analyte of selectedAnalyteDetails) {
        analyteById.set(String(analyte.id), analyte);
      }
      const resolveLabAnalyteId = (analyteId: string, fallback?: any) =>
        analyteMetadata[analyteId]?.lab_analyte_id ||
        fallback?.lab_analyte_id ||
        null;

      let changed = 0;
      let skippedMissingSources = 0;

      for (const item of calculated) {
        const analyteId = String(item.analyte_id || '');
        if (!analyteId || !analyteById.has(analyteId)) continue;
        const formula = String(item.formula || '').trim();
        if (!formula) continue;

        const targetAnalyte = analyteById.get(analyteId);
        const labAnalyteId = item.lab_analyte_id || resolveLabAnalyteId(analyteId, targetAnalyte);

        // Resolve source dependencies — every source must exist in this group
        const sources = Array.isArray(item.sources) ? item.sources : [];
        const deps: Array<{ source_analyte_id: string; source_lab_analyte_id: string | null; variable_name: string }> = [];
        const variableNames: string[] = [];
        let hasMissingSource = false;
        for (const src of sources) {
          const srcId = String(src.analyte_id || '');
          const variableName = String(src.variable_name || '').trim();
          if (!srcId || !variableName) continue;
          const srcAnalyte = analyteById.get(srcId);
          if (!srcAnalyte) {
            hasMissingSource = true;
            break;
          }
          deps.push({
            source_analyte_id: srcId,
            source_lab_analyte_id: resolveLabAnalyteId(srcId, srcAnalyte),
            variable_name: variableName,
          });
          variableNames.push(variableName);
        }

        if (hasMissingSource || deps.length === 0) {
          skippedMissingSources++;
          continue;
        }

        const calcResultType = item.calculation_result_type === 'text' ? 'text' : 'numeric';
        const patch = {
          is_calculated: true,
          formula,
          formula_variables: variableNames,
          formula_description: item.formula_description || null,
          calculation_result_type: calcResultType,
        };

        // Persist formula config on the lab_analyte row (lab-specific)
        if (labAnalyteId) {
          const { error } = await database.labAnalytes.updateFieldsById(labAnalyteId, patch);
          if (error) throw new Error(error.message || `Failed updating ${labAnalyteId}`);
        }

        // Persist dependency mappings (variable_name → source analyte)
        const dedupedDeps = dedupeDependenciesForSave(deps);
        const { error: depError } = await database.analyteDependencies.setDependencies(
          analyteId,
          dedupedDeps,
          labId,
          labAnalyteId,
        );
        if (depError) throw new Error(depError.message || `Failed saving dependencies for ${analyteId}`);

        // Reflect changes locally so is_calculated + warnings update immediately
        setAllLinkedAnalytes(prev => prev.map((analyte: any) =>
          analyte.id === analyteId ? { ...analyte, ...patch } : analyte
        ));
        setAnalytes(prev => prev.map((analyte: any) =>
          analyte.id === analyteId ? { ...analyte, ...patch } : analyte
        ));
        changed++;
      }

      const parts: string[] = [];
      if (changed > 0) {
        parts.push(`AI linked ${changed} calculated field${changed !== 1 ? 's' : ''} with formulas and source dependencies.`);
      }
      if (skippedMissingSources > 0) {
        parts.push(`${skippedMissingSources} skipped (required source analytes not in this group).`);
      }
      setAiHelperResult(parts.length > 0 ? parts.join(' ') : 'AI found no calculated fields to link.');
    } catch (error: any) {
      setAiHelperResult(`Error: ${error.message || 'AI calculated-field setup failed'}`);
    } finally {
      setAiCalcBusy(false);
    }
  };

  const selectedAnalyzerConnection = analyzerConnections.find(
    (connection: any) => connection.id === formData.analyzer_connection_id
  ) || null;

  const getCalculatedDependencyIssues = (analyte: any) => {
    if (!analyte.is_calculated) return { missing: [] as CalculatedDependency[], duplicateCount: 0 };

    const exact = analyte.lab_analyte_id
      ? calculatedDependencies.filter(
          (dependency) => dependency.calculated_lab_analyte_id === analyte.lab_analyte_id,
        )
      : [];
    const candidates = exact.length > 0
      ? exact
      : calculatedDependencies.filter(
          (dependency) =>
            !dependency.calculated_lab_analyte_id &&
            dependency.calculated_analyte_id === analyte.id,
        );
    const selectedIds = new Set(formData.selectedAnalytes);
    const preferred = selectPreferredCalculatedDependencies(
      calculatedDependencies,
      analyte.id,
      analyte.lab_analyte_id,
      selectedIds,
    );
    const missing = preferred.filter(
      (dependency) =>
        !selectedIds.has(dependency.source_analyte_id) &&
        (!dependency.source_lab_analyte_id || !selectedIds.has(dependency.source_lab_analyte_id)),
    );

    return {
      missing,
      duplicateCount: Math.max(0, candidates.length - preferred.length),
    };
  };

  const linkedCkeditorTemplates = testGroup?.id
    ? labReportTemplates.filter((template) => template.test_group_id === testGroup.id)
    : [];
  const selectedLinkedCkeditorTemplate = linkedCkeditorTemplates[0] || null;

  return (
    <div className="fixed inset-0 bg-gray-600 bg-opacity-75 flex items-center justify-center p-4" style={{ zIndex: 99999 }}>
      <div className="bg-white rounded-lg shadow-xl w-full max-w-6xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <h2 className="text-xl font-semibold text-gray-900 flex items-center">
            <Layers className="h-6 w-6 mr-2 text-green-600" />
            {testGroup ? 'Edit Test Group' : 'Create Test Group'}
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-500 p-1 rounded"
          >
            <X className="h-6 w-6" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-6">
          {/* Basic Information */}
          <div className="space-y-4">
            <h3 className="text-lg font-medium text-gray-900 flex items-center">
              <TestTube className="h-5 w-5 mr-2" />
              Basic Information
            </h3>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Test Group Name *
                </label>
                <input
                  type="text"
                  name="name"
                  required
                  value={formData.name}
                  onChange={handleChange}
                  placeholder="e.g., Complete Blood Count"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Test Code *
                </label>
                <input
                  type="text"
                  name="code"
                  required
                  value={formData.code}
                  onChange={handleChange}
                  placeholder="e.g., CBC"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Category
                </label>
                <select
                  name="category"
                  value={formData.category}
                  onChange={handleChange}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                >
                  <option value="">Select Category</option>
                  {categories.map(category => (
                    <option key={category} value={category}>{category}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Sample Type *
                </label>
                <select
                  name="sampleType"
                  required
                  value={formData.sampleType}
                  onChange={handleChange}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                >
                  <option value="">Select Sample Type</option>
                  {sampleTypes.map(type => (
                    <option key={type} value={type}>{type}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="border border-gray-200 rounded-lg p-3 bg-gray-50">
              <div className="flex items-start justify-between gap-3 mb-2">
                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    Sample Condition Options
                  </label>
                  <p className="text-xs text-gray-500">
                    Optional per-test dropdown shown during sample collection, e.g. Morning, Fasting, Random.
                  </p>
                </div>
                {formData.sampleConditionOptions.length > 0 && (
                  <select
                    value={formData.defaultSampleCondition}
                    onChange={(e) => setFormData(prev => ({ ...prev, defaultSampleCondition: e.target.value }))}
                    className="min-w-[180px] px-2 py-1.5 text-xs border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                    title="Default sample condition"
                  >
                    <option value="">No default</option>
                    {formData.sampleConditionOptions.map((option: string) => (
                      <option key={option} value={option}>{option}</option>
                    ))}
                  </select>
                )}
              </div>

              <div className="flex flex-wrap gap-2 mb-2">
                {formData.sampleConditionOptions.length === 0 ? (
                  <span className="text-xs text-gray-500">No condition options configured.</span>
                ) : formData.sampleConditionOptions.map((option: string) => (
                  <span key={option} className="inline-flex items-center gap-1 px-2 py-1 bg-white border border-gray-200 rounded-full text-xs text-gray-700">
                    {option}
                    {formData.defaultSampleCondition === option && (
                      <span className="text-[10px] text-blue-600 font-medium">default</span>
                    )}
                    <button
                      type="button"
                      onClick={() => removeSampleConditionOption(option)}
                      className="text-gray-400 hover:text-red-500"
                      aria-label={`Remove ${option}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>

              <div className="flex gap-2">
                <input
                  type="text"
                  value={newSampleCondition}
                  onChange={(e) => setNewSampleCondition(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addSampleConditionOption();
                    }
                  }}
                  placeholder="Add condition, e.g. Fasting Sample"
                  className="flex-1 min-w-[220px] px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white"
                />
                <button
                  type="button"
                  onClick={addSampleConditionOption}
                  className="px-3 py-2 text-sm bg-gray-900 text-white rounded-md hover:bg-gray-800"
                >
                  Add
                </button>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Clinical Purpose *
              </label>
              <textarea
                name="clinicalPurpose"
                required
                rows={2}
                value={formData.clinicalPurpose}
                onChange={handleChange}
                placeholder="Describe the clinical purpose and indications for this test group"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Methodology / Technique
              </label>
              <select
                name="methodology"
                value={formData.methodology}
                onChange={handleChange}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                <option value="">Select Method</option>
                {labMethodOptions.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
              <div className="mt-2 flex flex-wrap gap-2">
                <input
                  type="text"
                  value={newMethodValue}
                  onChange={(e) => setNewMethodValue(e.target.value)}
                  placeholder="Add new method"
                  className="flex-1 min-w-[200px] px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
                <button
                  type="button"
                  onClick={handleAddMethodOption}
                  className="px-3 py-2 bg-gray-900 text-white rounded-md hover:bg-gray-800"
                >
                  Add Method
                </button>
              </div>
              {methodError && (
                <div className="text-xs text-red-600 mt-1">{methodError}</div>
              )}
              <div className="text-xs text-gray-500 mt-1">
                Methods are saved per lab and available for all analytes and test groups.
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Department
                </label>
                <input
                  type="text"
                  name="department"
                  value={formData.department}
                  onChange={handleChange}
                  placeholder="e.g., Hematology, Biochemistry"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Description
              </label>
              <textarea
                name="description"
                rows={2}
                value={formData.description}
                onChange={handleChange}
                placeholder="Brief description of this test group"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
          </div>

          {/* Test Configuration - Enhanced Settings */}
          <div className="space-y-4 border-t border-gray-200 pt-6">
            <h3 className="text-lg font-medium text-gray-900 flex items-center">
              <Settings className="h-5 w-5 mr-2 text-purple-600" />
              Test Configuration Settings
            </h3>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* Test Type */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Test Type
                </label>
                <select
                  name="testType"
                  value={formData.testType}
                  onChange={handleChange}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                >
                  <option value="Default">Default</option>
                  <option value="Special">Special</option>
                  <option value="Urgent">Urgent</option>
                  <option value="Routine">Routine</option>
                </select>
              </div>

              {/* Gender */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Gender *
                </label>
                <div className="flex items-center space-x-4">
                  <label className="flex items-center">
                    <input
                      type="radio"
                      name="gender"
                      value="Male"
                      checked={formData.gender === 'Male'}
                      onChange={handleChange}
                      className="h-4 w-4 text-purple-600 focus:ring-purple-500 border-gray-300"
                    />
                    <span className="ml-2 text-sm text-gray-700">Male</span>
                  </label>
                  <label className="flex items-center">
                    <input
                      type="radio"
                      name="gender"
                      value="Female"
                      checked={formData.gender === 'Female'}
                      onChange={handleChange}
                      className="h-4 w-4 text-purple-600 focus:ring-purple-500 border-gray-300"
                    />
                    <span className="ml-2 text-sm text-gray-700">Female</span>
                  </label>
                  <label className="flex items-center">
                    <input
                      type="radio"
                      name="gender"
                      value="Both"
                      checked={formData.gender === 'Both'}
                      onChange={handleChange}
                      className="h-4 w-4 text-purple-600 focus:ring-purple-500 border-gray-300"
                    />
                    <span className="ml-2 text-sm text-gray-700">Both</span>
                  </label>
                </div>
              </div>

              {/* Test Code (moved here for better organization) */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Test Code *
                </label>
                <input
                  type="text"
                  name="code"
                  required
                  value={formData.code}
                  onChange={handleChange}
                  placeholder="e.g., 17OHP"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* Sample Color */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Sample Color
                </label>
                <select
                  name="sampleColor"
                  value={formData.sampleColor}
                  onChange={handleChange}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                >
                  <option value="Red">Red</option>
                  <option value="Blue">Blue</option>
                  <option value="Green">Green</option>
                  <option value="Yellow">Yellow</option>
                  <option value="Purple">Purple</option>
                  <option value="Gray">Gray</option>
                  <option value="Pink">Pink</option>
                  <option value="Orange">Orange</option>
                </select>
              </div>

              {/* Barcode Suffix */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Barcode Suffix
                </label>
                <input
                  type="text"
                  name="barcodeSuffix"
                  value={formData.barcodeSuffix}
                  onChange={handleChange}
                  placeholder="Enter suffix"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                />
              </div>

              {/* Price */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Price (₹) *
                </label>
                <input
                  type="number"
                  name="price"
                  required
                  min="0"
                  step="0.01"
                  value={formData.price}
                  onChange={handleChange}
                  placeholder="0"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                />
              </div>

              {/* Collection Charge */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Collection Charge (₹)
                </label>
                <input
                  type="number"
                  name="collection_charge"
                  min="0"
                  step="0.01"
                  value={formData.collection_charge}
                  onChange={handleChange}
                  placeholder="0"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                />
                <p className="text-xs text-gray-500 mt-1">Extra charge for sample collection (e.g. home visit)</p>
              </div>

              {/* TAT Hours */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  TAT (Hours) *
                </label>
                <input
                  type="number"
                  name="tat_hours"
                  required
                  min="0.5"
                  max="720"
                  step="0.5"
                  value={formData.tat_hours}
                  onChange={handleChange}
                  placeholder="3"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                />
                <p className="text-xs text-gray-500 mt-1">Turnaround time for this test (used for TAT breach alerts)</p>
              </div>
            </div>

            <div className="rounded-xl border border-purple-200 bg-purple-50/60 p-4">
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  name="is_section_only"
                  checked={formData.is_section_only}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setFormData(prev => ({
                      ...prev,
                      is_section_only: checked,
                      selectedAnalytes: checked ? [] : prev.selectedAnalytes,
                    }));
                    if (checked) {
                      setAnalyteMetadata({});
                      setShowSelectedOnly(false);
                    }
                  }}
                  className="mt-1 h-4 w-4 text-purple-600 focus:ring-purple-500 border-gray-300 rounded"
                />
                <div>
                  <div className="text-sm font-semibold text-purple-900">Section-only report</div>
                  <p className="text-xs text-purple-700 mt-1">
                    Use this for radiology, pathology impressions, narrative findings, or other report types that do not need analyte rows.
                    When enabled, analyte selection is disabled and verification will happen at the section/report level.
                  </p>
                </div>
              </label>
            </div>

            {showProviderOnlyFields && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Flabs ID */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Flabs ID
                  </label>
                  <input
                    type="text"
                    name="flabsId"
                    value={formData.flabsId}
                    onChange={handleChange}
                    placeholder="FLT0625"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                  />
                </div>
              </div>
            )}

            {/* Additional Options */}
            <div className="bg-amber-50 rounded-lg p-4">
              <label className="block text-sm font-medium text-gray-900 mb-3">
                Additional Options
              </label>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                <label className="flex items-center">
                  <input
                    type="checkbox"
                    name="isActive"
                    checked={formData.isActive}
                    onChange={handleChange}
                    className="h-4 w-4 text-green-600 focus:ring-green-500 border-gray-300 rounded"
                  />
                  <span className="ml-2 text-sm text-gray-700">Is Active</span>
                </label>
                <label className="flex items-center">
                  <input
                    type="checkbox"
                    name="requiresFasting"
                    checked={formData.requiresFasting}
                    onChange={handleChange}
                    className="h-4 w-4 text-orange-600 focus:ring-orange-500 border-gray-300 rounded"
                  />
                  <span className="ml-2 text-sm text-gray-700">Requires Fasting</span>
                </label>
                <label className="flex items-center">
                  <input
                    type="checkbox"
                    name="onlyFemale"
                    checked={formData.onlyFemale}
                    onChange={handleChange}
                    className="h-4 w-4 text-amber-600 focus:ring-amber-500 border-gray-300 rounded"
                  />
                  <span className="ml-2 text-sm text-gray-700">Only Female</span>
                </label>
                <label className="flex items-center">
                  <input
                    type="checkbox"
                    name="onlyMale"
                    checked={formData.onlyMale}
                    onChange={handleChange}
                    className="h-4 w-4 text-amber-600 focus:ring-amber-500 border-gray-300 rounded"
                  />
                  <span className="ml-2 text-sm text-gray-700">Only Male</span>
                </label>
                <label className="flex items-center">
                  <input
                    type="checkbox"
                    name="onlyBilling"
                    checked={formData.onlyBilling}
                    onChange={handleChange}
                    className="h-4 w-4 text-amber-600 focus:ring-amber-500 border-gray-300 rounded"
                  />
                  <span className="ml-2 text-sm text-gray-700">Only Billing</span>
                </label>
                <label className="flex items-center">
                  <input
                    type="checkbox"
                    name="startFromNextPage"
                    checked={formData.startFromNextPage}
                    onChange={handleChange}
                    className="h-4 w-4 text-amber-600 focus:ring-amber-500 border-gray-300 rounded"
                  />
                  <span className="ml-2 text-sm text-gray-700">Start from Next Page</span>
                </label>
              </div>
	              {/* Per-test-group PDF layout override */}
	              <div className="mt-3">
	                <label className="block text-sm font-medium text-gray-700 mb-1">
	                  Report Priority
	                </label>
	                <input
	                  type="number"
	                  name="report_priority"
	                  min="0"
	                  step="1"
	                  value={formData.report_priority}
	                  onChange={handleChange}
	                  placeholder="Leave blank for normal/default"
	                  className="w-full px-3 py-2 border border-amber-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-amber-500"
	                />
	                <p className="text-xs text-gray-500 mt-1">
	                  Lower numbers print earlier. Example: CBC `10`, Lipid `20`, Culture `900`.
	                </p>
	              </div>
	              <div className="mt-3">
	                <label className="block text-sm font-medium text-gray-700 mb-1">
	                  Report Layout Style
	                </label>
                  <select
                    name="default_template_style"
                    value={reportLayoutSelection}
                    onChange={(event) => {
                      const value = event.target.value;
                      setReportLayoutSelection(value);
                      setFormData(prev => ({
                        ...prev,
                        default_template_style: value === LINKED_CKEDITOR_TEMPLATE_VALUE ? '' : value,
                      }));
                    }}
                    className="w-full px-3 py-2 border border-amber-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-amber-500"
                  >
                    {selectedLinkedCkeditorTemplate ? (
                      <option value={LINKED_CKEDITOR_TEMPLATE_VALUE}>
                        CKEditor Template - {selectedLinkedCkeditorTemplate.template_name}
                      </option>
                    ) : null}
                    <option value="">Lab Default{selectedLinkedCkeditorTemplate ? ' / auto template fallback' : ''}</option>
                    <option value="beautiful">Beautiful (3-Column Color Matrix)</option>
                    <option value="classic">Classic (Plain Table)</option>
                    <option value="basic">Basic (Old School - No Color)</option>
                  </select>
                  <p className="text-xs text-gray-500 mt-1">
                    {selectedLinkedCkeditorTemplate
                      ? 'Choose CKEditor to use the linked template in generate-pdf-letterhead. Built-in styles override the linked template.'
                      : 'No linked CKEditor template found for this test group. Built-in styles override any linked custom template.'}
                  </p>

                {/* Preview toggle */}
                <button
                  type="button"
                  onClick={() => setShowReportPreview(v => !v)}
                  className="mt-2 flex items-center gap-1.5 text-xs font-medium text-indigo-600 hover:text-indigo-800 transition-colors"
                >
                  {showReportPreview ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  {showReportPreview ? 'Hide report preview' : 'Preview report with dummy data'}
                </button>

                {/* Live report preview */}
                  {showReportPreview && (() => {
                    const effectiveStyle = reportLayoutSelection || 'beautiful';
                    // Build preview analytes from selected analytes with dummy values
                  const previewAnalytes = selectedAnalyteDetails.length > 0
                    ? selectedAnalyteDetails.map((a: any, i: number) => ({
                        parameter: a.name || a.parameter || 'Parameter',
                        value: a.reference_range
                          ? (() => {
                              const m = (a.reference_range || '').match(/[\d.]+/);
                              return m ? String(parseFloat(m[0]) * (i % 3 === 0 ? 0.7 : i % 3 === 1 ? 1.1 : 1.0)) : '10.5';
                            })()
                          : '10.5',
                        unit: a.unit || '',
                        reference_range: a.reference_range || a.lab_specific_reference_range || '',
                        flag: i % 4 === 0 ? 'low' : i % 4 === 1 ? 'high' : '',
                        method: a.method || '',
                        interpretation_high: a.interpretation_high || a.lab_specific_interpretation_high || '',
                        interpretation_low: a.interpretation_low || a.lab_specific_interpretation_low || '',
                        section_heading: analyteMetadata[a.id]?.section_heading || a.section_heading || '',
                        sort_order: analyteMetadata[a.id]?.sort_order ?? (i + 1),
                      }))
                    : undefined;

                  const printOpts = formData.print_options ?? {};

                    return (
                      <div className="mt-3">
                        {effectiveStyle === LINKED_CKEDITOR_TEMPLATE_VALUE ? (
                          <div className="rounded-md border border-indigo-200 bg-indigo-50 p-3 text-sm text-indigo-800 flex items-start gap-2">
                            <FileText className="h-4 w-4 mt-0.5 flex-shrink-0" />
                            <div>
                              <div className="font-medium">{selectedLinkedCkeditorTemplate?.template_name}</div>
                              <div className="text-xs mt-1">
                                This test group will use the linked CKEditor template during PDF letterhead generation.
                              </div>
                            </div>
                          </div>
                        ) : effectiveStyle === 'basic' ? (
                          <BasicTemplateFormatBuilder
                            printOptions={printOpts}
                            showMethodology={true}
                          showInterpretation={false}
                          onChange={() => {}}
                        />
                        ) : (
                          <BuiltinTemplatePreview
                            style={effectiveStyle as 'beautiful' | 'classic'}
                          showMethodology={true}
                          showInterpretation={false}
                          printOptions={printOpts}
                          customAnalytes={previewAnalytes}
                          testGroupName={formData.name || 'Test Group'}
                        />
                      )}
                    </div>
                  );
                })()}
              </div>

              {/* Print Style Overrides */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-sm font-medium text-gray-700">Print Style Overrides</label>
                  {formData.print_options && Object.keys(formData.print_options).length > 0 && (
                    <button type="button"
                      onClick={() => setFormData(prev => ({ ...prev, print_options: null }))}
                      className="text-xs text-red-500 hover:text-red-700 font-medium">
                      ↩ Clear all — use lab defaults
                    </button>
                  )}
                </div>
                <p className="text-xs text-gray-500 mb-2">
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-medium text-xs">↩ Lab</span> = inherit lab setting &nbsp;·&nbsp;
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500 text-white text-xs">On/Off</span> = override for this test group only
                </p>
                <div className="border border-amber-200 rounded-lg p-3 bg-amber-50 space-y-2.5">
                  {([
                    { key: 'tableBorders', label: 'Table Borders' },
                    { key: 'flagColumn', label: 'Flag Column (Classic)' },
                    { key: 'flagAsterisk', label: 'Flag Asterisk * on H/L' },
                    { key: 'flagAsteriskCritical', label: 'Critical Double **', disabledWhen: !(formData.print_options as any)?.flagAsterisk },
                    { key: 'boldAllValues', label: 'Bold All Values' },
                    { key: 'boldAbnormalValues', label: 'Bold Abnormal Values' },
                    { key: 'underlineAbnormalValues', label: 'Underline Abnormal Values' },
                    { key: 'alternateRows', label: 'Alternate Row Shading' },
                    { key: 'showSampleType', label: 'Show Sample Type on Report' },
                    { key: 'showSampleCondition', label: 'Show Sample Condition on Report' },
                    { key: 'showSignature', label: 'Show Signature on Report' },
                    {
                      key: 'forceTableLayout',
                      label: 'Force Table Layout',
                      hint: 'On = always the TEST NAME / VALUE / UNITS table · Off = always the narrative key–value list · ↩ Lab = auto-detect (groups with no units and non-numeric ranges, e.g. Urine Routine, default to narrative)',
                    },
                  ] as { key: string; label: string; disabledWhen?: boolean; hint?: string }[]).map(({ key, label, disabledWhen, hint }) => {
                    const opts = (formData.print_options || {}) as Record<string, unknown>;
                    const isSet = key in opts && opts[key] !== undefined;
                    const val = opts[key];
                    const clearKey = (k: string) => setFormData(prev => {
                      const next = { ...(prev.print_options || {}) } as Record<string, unknown>;
                      delete next[k];
                      return { ...prev, print_options: Object.keys(next).length > 0 ? next as typeof prev.print_options : null };
                    });
                    const setKey = (k: string, v: unknown) => setFormData(prev => ({ ...prev, print_options: { ...(prev.print_options || {}), [k]: v } }));
                    return (
                      <div key={key} className={`flex items-start justify-between gap-3${disabledWhen ? ' opacity-40 pointer-events-none' : ''}`}>
                        <div className="min-w-0">
                          <span className="text-sm text-gray-700">{label}</span>
                          {hint && <p className="text-xs text-gray-500 mt-0.5">{hint}</p>}
                        </div>
                        <div className="flex items-center gap-1 flex-shrink-0">
                          {(['lab', 'on', 'off'] as const).map(opt => {
                            const active = opt === 'lab' ? !isSet : opt === 'on' ? val === true : val === false;
                            return (
                              <button type="button" key={opt}
                                onClick={() => opt === 'lab' ? clearKey(key) : setKey(key, opt === 'on')}
                                className={`px-2 py-0.5 text-xs rounded border transition-colors ${active ? 'bg-amber-500 text-white border-amber-500' : 'bg-white text-gray-500 border-gray-300 hover:border-amber-400'}`}>
                                {opt === 'lab' ? '↩ Lab' : opt === 'on' ? 'On' : 'Off'}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}

                  {/* Sample Condition Label — the prefix printed before the value
                      (e.g. "Sample Condition: Fasting"). Blank prints the bare value. */}
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <span className="text-sm text-gray-700">Sample Condition Label</span>
                      <p className="text-xs text-gray-500 mt-0.5">Prefix before the value, e.g. "Sample Condition: Fasting". Clear it to print just "Fasting".</p>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {(formData.print_options as any)?.sampleConditionLabel !== undefined && (
                        <button type="button"
                          onClick={() => setFormData(prev => {
                            const next = { ...(prev.print_options || {}) } as Record<string, unknown>;
                            delete next.sampleConditionLabel;
                            return { ...prev, print_options: Object.keys(next).length > 0 ? next as typeof prev.print_options : null };
                          })}
                          className="text-xs px-2 py-0.5 rounded border bg-white text-gray-500 border-gray-300 hover:border-amber-400">
                          ↩ Lab
                        </button>
                      )}
                      <input type="text"
                        value={(formData.print_options as any)?.sampleConditionLabel ?? ''}
                        placeholder="Sample Condition"
                        onChange={(e) => setFormData(prev => ({ ...prev, print_options: { ...(prev.print_options || {}), sampleConditionLabel: e.target.value } }))}
                        className="w-40 px-2 py-1 border border-gray-300 rounded text-sm" />
                    </div>
                  </div>

                  {/* Header Color */}
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-gray-700">Header Color</span>
                    <div className="flex items-center gap-2">
                      {(formData.print_options as any)?.headerBackground ? (
                        <button type="button"
                          onClick={() => setFormData(prev => {
                            const next = { ...(prev.print_options || {}) } as Record<string, unknown>;
                            delete next.headerBackground;
                            return { ...prev, print_options: Object.keys(next).length > 0 ? next as typeof prev.print_options : null };
                          })}
                          className="text-xs px-2 py-0.5 rounded border bg-white text-gray-500 border-gray-300 hover:border-amber-400">
                          ↩ Lab
                        </button>
                      ) : (
                        <span className="text-xs text-gray-400 italic">Lab default</span>
                      )}
                      <input type="color"
                        value={(formData.print_options as any)?.headerBackground || '#0b4aa2'}
                        onChange={(e) => setFormData(prev => ({ ...prev, print_options: { ...(prev.print_options || {}), headerBackground: e.target.value } }))}
                        className="h-7 w-7 rounded border border-gray-300 cursor-pointer" />
                    </div>
                  </div>

                  {/* Font Size */}
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-gray-700">Font Size (px)</span>
                    <div className="flex items-center gap-2">
                      {(formData.print_options as any)?.baseFontSize !== undefined && (
                        <button type="button"
                          onClick={() => setFormData(prev => {
                            const next = { ...(prev.print_options || {}) } as Record<string, unknown>;
                            delete next.baseFontSize;
                            return { ...prev, print_options: Object.keys(next).length > 0 ? next as typeof prev.print_options : null };
                          })}
                          className="text-xs px-2 py-0.5 rounded border bg-white text-gray-500 border-gray-300 hover:border-amber-400">
                          ↩ Lab
                        </button>
                      )}
                      <input type="number" min={8} max={24}
                        value={(formData.print_options as any)?.baseFontSize ?? ''}
                        placeholder="Lab default"
                        onChange={(e) => setFormData(prev => ({ ...prev, print_options: { ...(prev.print_options || {}), baseFontSize: e.target.value ? parseInt(e.target.value) : undefined } }))}
                        className="w-20 px-2 py-1 border border-gray-300 rounded text-sm" />
                    </div>
                  </div>

                  {/* Basic-template spacing — leave blank to inherit the lab setting */}
                  {([
                    { key: 'analyteRowSpacing', label: 'Analyte Row Gap (px)', min: 0, max: 10, labDefault: 2, hint: 'Space above & below each analyte row' },
                    { key: 'testGroupSpacing', label: 'Test Group Gap (px)', min: 0, max: 40, labDefault: 14, hint: 'Space printed below this test group' },
                  ] as { key: string; label: string; min: number; max: number; labDefault: number; hint: string }[]).map(({ key, label, min, max, labDefault, hint }) => {
                    const current = (formData.print_options as any)?.[key];
                    const clearKey = () => setFormData(prev => {
                      const next = { ...(prev.print_options || {}) } as Record<string, unknown>;
                      delete next[key];
                      return { ...prev, print_options: Object.keys(next).length > 0 ? next as typeof prev.print_options : null };
                    });
                    return (
                      <div key={key} className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <span className="text-sm text-gray-700">{label}</span>
                          <p className="text-xs text-gray-500 mt-0.5">{hint} · lab default {labDefault}</p>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          {current !== undefined && current !== null && (
                            <button type="button"
                              onClick={clearKey}
                              className="text-xs px-2 py-0.5 rounded border bg-white text-gray-500 border-gray-300 hover:border-amber-400">
                              ↩ Lab
                            </button>
                          )}
                          <input type="number" min={min} max={max}
                            value={current ?? ''}
                            placeholder="Lab default"
                            onChange={(e) => {
                              if (e.target.value === '') { clearKey(); return; }
                              const parsed = Math.max(min, Math.min(max, parseInt(e.target.value, 10)));
                              if (Number.isNaN(parsed)) return;
                              setFormData(prev => ({ ...prev, print_options: { ...(prev.print_options || {}), [key]: parsed } }));
                            }}
                            className="w-20 px-2 py-1 border border-gray-300 rounded text-sm" />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Group Interpretation */}
            <div className="bg-purple-50 border border-purple-200 rounded-lg p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <FileText className="h-4 w-4 text-purple-600" />
                  <span className="text-sm font-medium text-purple-900">Group Interpretation</span>
                  <span className="text-xs text-purple-500 bg-purple-100 px-1.5 py-0.5 rounded">Shown in report after results</span>
                </div>
                {!showInterpEditor ? (
                  <button
                    type="button"
                    onClick={() => setShowInterpEditor(true)}
                    className="flex items-center gap-1 px-2 py-1 text-xs bg-purple-600 text-white rounded hover:bg-purple-700"
                  >
                    <Plus className="h-3 w-3" /> Add Interpretation
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => { setShowInterpEditor(false); setFormData(prev => ({ ...prev, group_interpretation: '' })); }}
                    className="text-xs text-red-500 hover:text-red-700"
                  >
                    Remove
                  </button>
                )}
              </div>
              {showInterpEditor && (
                <div className="mt-2">
                  <p className="text-xs text-purple-600 mb-2">
                    Rich text rendered after this test group's result table in all report styles. Font size inherits the test group's base font size setting.
                  </p>
                  {/* Tab bar */}
                  <div className="flex gap-1 mb-2">
                    <button
                      type="button"
                      onClick={() => setInterpTab('visual')}
                      className={`flex items-center gap-1 px-2 py-1 text-xs rounded border transition-colors ${interpTab === 'visual' ? 'bg-purple-600 text-white border-purple-600' : 'bg-white text-gray-600 border-gray-300 hover:border-purple-400'}`}
                    >
                      <FileText className="h-3 w-3" /> Visual
                    </button>
                    <button
                      type="button"
                      onClick={() => setInterpTab('html')}
                      className={`flex items-center gap-1 px-2 py-1 text-xs rounded border transition-colors ${interpTab === 'html' ? 'bg-purple-600 text-white border-purple-600' : 'bg-white text-gray-600 border-gray-300 hover:border-purple-400'}`}
                    >
                      <Code className="h-3 w-3" /> HTML
                    </button>
                  </div>
                  {/* Visual (CKEditor) tab */}
                  {interpTab === 'visual' && (
                    <div className="border border-purple-200 rounded bg-white">
                      {interpCkError ? (
                        <div className="p-3 text-xs text-red-600">
                          Visual editor could not load ({interpCkError}). Switch to the <strong>HTML</strong> tab to
                          write the interpretation — it saves exactly the same way.
                        </div>
                      ) : !interpCkLoaded ? (
                        <div className="flex items-center justify-center h-24 text-sm text-gray-400">Loading editor…</div>
                      ) : null}
                      <div ref={interpEditorRef} style={{ display: interpCkLoaded && !interpCkError ? 'block' : 'none' }} />
                    </div>
                  )}
                  {/* HTML tab */}
                  {interpTab === 'html' && (
                    <textarea
                      rows={8}
                      value={formData.group_interpretation || ''}
                      onChange={(e) => setFormData(prev => ({ ...prev, group_interpretation: e.target.value }))}
                      placeholder="<p>Paste or type HTML here...</p>"
                      className="w-full px-3 py-2 border border-purple-200 rounded bg-white text-xs font-mono focus:outline-none focus:ring-2 focus:ring-purple-400"
                    />
                  )}
                </div>
              )}
            </div>

            {/* Default Report Remark */}
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
              <div className="flex items-center gap-2 mb-2">
                <FileText className="h-4 w-4 text-amber-600" />
                <span className="text-sm font-medium text-amber-900">Default Report Remark</span>
                <span className="text-xs text-amber-600 bg-amber-100 px-1.5 py-0.5 rounded">Prefilled during result entry</span>
              </div>
              <textarea
                rows={2}
                maxLength={2000}
                value={formData.default_report_remark || ''}
                onChange={(e) => setFormData(prev => ({ ...prev, default_report_remark: e.target.value }))}
                placeholder="e.g. Kindly correlate clinically."
                className="w-full px-3 py-2 border border-amber-200 rounded bg-white text-sm focus:outline-none focus:ring-2 focus:ring-amber-300"
              />
              <p className="mt-1 text-xs text-amber-700">
                Plain text loaded into the Report Remarks box for every order of this group. The
                technician can edit it, or untick it there to leave it off that report.
              </p>
            </div>

            {/* Pre-Collection Guidelines */}
            <div className="bg-green-50 rounded-lg p-4">
              <div className="flex items-center justify-between mb-3">
                <label className="flex items-center">
                  <input
                    type="checkbox"
                    checked={!!formData.preCollectionGuidelines}
                    onChange={(e) => {
                      if (!e.target.checked) {
                        setFormData(prev => ({ ...prev, preCollectionGuidelines: '' }));
                      } else {
                        setFormData(prev => ({ ...prev, preCollectionGuidelines: ' ' }));
                      }
                    }}
                    className="h-4 w-4 text-green-600 focus:ring-green-500 border-gray-300 rounded"
                  />
                  <span className="ml-2 text-sm font-medium text-gray-900">Pre-Collection Guidelines</span>
                </label>
                {formData.preCollectionGuidelines && (
                  <button
                    type="button"
                    onClick={() => setFormData(prev => ({ ...prev, preCollectionGuidelines: '' }))}
                    className="text-sm text-green-600 hover:text-green-700"
                  >
                    Clear
                  </button>
                )}
              </div>
              {formData.preCollectionGuidelines && (
                <textarea
                  name="preCollectionGuidelines"
                  rows={3}
                  value={formData.preCollectionGuidelines}
                  onChange={handleChange}
                  placeholder="Enter pre-collection guidelines for this test (e.g., fasting requirements, timing instructions)..."
                  className="w-full px-3 py-2 border border-green-300 rounded-md focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
                />
              )}
            </div>
          </div>

          {/* Analyte Selection */}
          <div className="space-y-4 border-t border-gray-200 pt-6">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-medium text-gray-900">Select Analytes</h3>
                {formData.is_section_only && (
                  <p className="text-sm text-purple-700 mt-1">
                    Analyte selection is disabled because this test group is marked as section-only.
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={loadData}
                  disabled={loading || formData.is_section_only}
                  className="flex items-center px-3 py-1.5 text-sm border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                  title="Refresh analyte list"
                >
                  <RefreshCw className={`h-4 w-4 mr-1 ${loading ? 'animate-spin' : ''}`} />
                  Refresh
                </button>
                <button
                  type="button"
                  onClick={() => setShowAnalyteForm(true)}
                  disabled={formData.is_section_only}
                  className="flex items-center px-3 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  <Plus className="h-4 w-4 mr-1" />
                  Add New Analyte
                </button>
              </div>
            </div>

            {/* Search Box + Show Selected Toggle */}
            <div className="flex items-center gap-3">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 h-4 w-4" />
                <input
                  type="text"
                  placeholder="Search analytes by name, category, or unit..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  disabled={formData.is_section_only}
                  className="w-full pl-9 pr-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
              <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer whitespace-nowrap">
                <input
                  type="checkbox"
                  checked={showSelectedOnly}
                  onChange={(e) => setShowSelectedOnly(e.target.checked)}
                  disabled={formData.is_section_only}
                  className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                />
                Show Selected ({formData.selectedAnalytes.length})
              </label>
            </div>

            {formData.is_section_only && (
              <div className="text-center py-8 bg-purple-50 rounded-lg border border-purple-200">
                <AlertCircle className="h-10 w-10 text-purple-400 mx-auto mb-3" />
                <h4 className="text-base font-medium text-purple-900 mb-1">Section-only mode is enabled</h4>
                <p className="text-sm text-purple-700">
                  This report will use section content instead of analyte rows.
                </p>
              </div>
            )}

            {/* No Analytes Available Message */}
            {!formData.is_section_only && !loading && analytes.length === 0 && (
              <div className="text-center py-8 bg-gray-50 rounded-lg border-2 border-dashed border-gray-300">
                <AlertCircle className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                <h4 className="text-lg font-medium text-gray-900 mb-2">No Analytes Available</h4>
                <p className="text-gray-600 mb-4">
                  You need to create analytes before you can create a test group.
                  <br />
                  <span className="text-sm text-blue-600">Analytes will be created for your lab. Owner can promote good ones to global templates.</span>
                </p>
                <button
                  type="button"
                  onClick={() => setShowAnalyteForm(true)}
                  className="flex items-center px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors mx-auto"
                >
                  <Plus className="h-4 w-4 mr-2" />
                  Create Your First Analyte
                </button>
              </div>
            )}

            {/* Loading State */}
            {!formData.is_section_only && loading && (
              <div className="text-center py-8">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto"></div>
                <p className="text-gray-600 mt-2">Loading analytes...</p>
              </div>
            )}

            {/* No Search Results */}
            {!formData.is_section_only && !loading && analytes.length > 0 && filteredAnalytes.length === 0 && (searchQuery || showSelectedOnly) && (
              <div className="text-center py-8 bg-gray-50 rounded-lg border border-gray-200">
                <Search className="h-8 w-8 text-gray-400 mx-auto mb-2" />
                <p className="text-gray-600 mb-4">
                  {showSelectedOnly && !searchQuery
                    ? 'No analytes selected yet.'
                    : `No analytes found matching "${searchQuery}"`}
                  <br />
                  <span className="text-sm text-blue-600">
                    {showSelectedOnly && !searchQuery ? 'Select analytes from the full list.' : 'Create a new analyte for your lab.'}
                  </span>
                </p>
                <button
                  type="button"
                  onClick={() => setShowAnalyteForm(true)}
                  className="flex items-center px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors mx-auto"
                >
                  <Plus className="h-4 w-4 mr-2" />
                  Create New Analyte
                </button>
              </div>
            )}

            {/* Analyte Selection Grid */}
            {!formData.is_section_only && filteredAnalytes.length > 0 && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-h-60 overflow-y-auto border border-gray-200 rounded-lg p-4">
                {filteredAnalytes.map((analyte) => (
                  <label key={analyte.id} className="flex items-start p-3 border border-gray-200 rounded-lg hover:bg-gray-50 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={formData.selectedAnalytes.includes(analyte.id)}
                      onChange={() => handleAnalyteSelection(analyte.id)}
                      className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded mt-1"
                    />
                    <div className="ml-3 flex-1">
                      <div className="text-sm font-medium text-gray-900 flex items-center gap-2">
                        {analyte.sample_type && (
                          <SampleTypeIndicator sampleType={analyte.sample_type} size="sm" />
                        )}
                        {analyte.name}
                        {analyte.is_calculated && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-amber-100 text-amber-700 text-xs font-medium rounded border border-amber-300">
                            <Calculator className="w-3 h-3" />
                            Calc
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-gray-500 mt-1">
                        Unit: {analyte.unit} • Range: {analyte.referenceRange}
                      </div>
                      <div className="text-xs text-gray-400">
                        Category: {analyte.category}
                      </div>
                    </div>
                  </label>
                ))}
              </div>
            )}

            {/* Selected Analytes Summary */}
            {!formData.is_section_only && formData.selectedAnalytes.length > 0 && (
              <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                <div className="flex items-center justify-between mb-2">
                  <h4 className="font-medium text-green-900">
                    Selected Analytes ({formData.selectedAnalytes.length}
                    {selectedAnalyteDetails.filter((a: any) => a.is_calculated).length > 0 && (
                      <span className="text-amber-700 ml-1 text-sm font-normal">
                        · {selectedAnalyteDetails.filter((a: any) => a.is_calculated).length} calculated
                      </span>
                    )}
                    {Object.values(analyteMetadata).filter(m => !m.is_visible).length > 0 && (
                      <span className="text-orange-600 ml-1 text-sm font-normal">
                        · {Object.values(analyteMetadata).filter(m => !m.is_visible).length} hidden on report
                      </span>
                    )})
                  </h4>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleAiArrangeSections}
                      disabled={aiLayoutBusy || loading}
                      className="flex items-center gap-1 px-2 py-1 border border-purple-300 text-purple-700 rounded hover:bg-purple-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-xs"
                      title="Use AI to set analyte report order and fill missing section headings"
                    >
                      <Sparkles className={`h-3 w-3 ${aiLayoutBusy ? 'animate-pulse' : ''}`} />
                      {aiLayoutBusy ? 'Arranging...' : 'AI Order/Sections'}
                    </button>
                    <button
                      type="button"
                      onClick={handleAiDropdownValues}
                      disabled={aiDropdownBusy || loading}
                      className="flex items-center gap-1 px-2 py-1 border border-indigo-300 text-indigo-700 rounded hover:bg-indigo-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-xs"
                      title="Use AI to add dropdown expected values or create sample-specific analyte variants"
                    >
                      <Sparkles className={`h-3 w-3 ${aiDropdownBusy ? 'animate-pulse' : ''}`} />
                      {aiDropdownBusy ? 'Checking...' : 'AI Dropdowns'}
                    </button>
                    <button
                      type="button"
                      onClick={handleAiCalculatedFields}
                      disabled={aiCalcBusy || loading}
                      className="flex items-center gap-1 px-2 py-1 border border-emerald-300 text-emerald-700 rounded hover:bg-emerald-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-xs"
                      title="Use AI to detect calculated parameters, mark them calculated, and link their formulas and source dependencies"
                    >
                      <Calculator className={`h-3 w-3 ${aiCalcBusy ? 'animate-pulse' : ''}`} />
                      {aiCalcBusy ? 'Linking...' : 'AI Calculated'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (confirm(`Remove all ${formData.selectedAnalytes.length} analytes from this test group?`)) {
                          setFormData(prev => ({ ...prev, selectedAnalytes: [] }));
                          setAnalyteMetadata({});
                        }
                      }}
                      className="flex items-center gap-1 px-2 py-1 border border-red-300 text-red-600 rounded hover:bg-red-50 transition-colors text-xs"
                      title="Remove all analytes from this test group"
                    >
                      <X className="h-3 w-3" />
                      Remove All
                    </button>
                    {testGroup?.id && (
                      <div className="flex flex-col items-end">
                        <button
                          type="button"
                          onClick={handleSyncFromGlobal}
                          disabled={syncingGlobal}
                          className="flex items-center gap-1 px-2 py-1 border border-blue-300 text-blue-700 rounded hover:bg-blue-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-xs"
                          title="Pull sort order & section headings from global catalog"
                        >
                          <RefreshCw className={`h-3 w-3 ${syncingGlobal ? 'animate-spin' : ''}`} />
                          {syncingGlobal ? 'Syncing...' : 'Sync from Global'}
                        </button>
                        {syncGlobalResult && (
                          <span className={`text-xs mt-1 ${syncGlobalResult.startsWith('Error') ? 'text-red-500' : 'text-green-600'}`}>
                            {syncGlobalResult}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
                {aiHelperResult && (
                  <div className={`mb-3 text-xs px-3 py-2 rounded border ${
                    aiHelperResult.startsWith('Error')
                      ? 'bg-red-50 border-red-200 text-red-700'
                      : 'bg-purple-50 border-purple-200 text-purple-700'
                  }`}>
                    {aiHelperResult}
                  </div>
                )}
                <p className="text-xs text-gray-500 mb-3">Set sort order and optional section sub-headings for PDF report grouping.</p>
                <div className="space-y-2">
	                  {selectedAnalyteDetails.map((analyte) => {
	                    const meta = analyteMetadata[analyte.id] || { sort_order: 0, section_heading: '', is_visible: true, report_display_options: {} };
	                    const isHidden = !meta.is_visible;
	                    const reportOptions = meta.report_display_options || {};
	                    const dependencyIssues = getCalculatedDependencyIssues(analyte);
	                    const missingDependencyLabels = dependencyIssues.missing.map((dependency) => {
	                      const source = analytes.find((candidate: any) =>
	                        candidate.id === dependency.source_analyte_id ||
	                        (!!dependency.source_lab_analyte_id && candidate.lab_analyte_id === dependency.source_lab_analyte_id)
	                      );
	                      return source?.name || dependency.variable_name;
	                    });
	                    const pairedWithName = selectedAnalyteDetails.find((item: any) =>
	                      analyteMetadata[item.id]?.report_display_options?.sameRowSiblingAnalyteId === analyte.id
	                    )?.name;
	                    return (
	                      <div key={analyte.id} className={`p-2 rounded border shadow-sm ${isHidden ? 'bg-gray-50 border-gray-200 opacity-75' : 'bg-white border-green-100'}`}>
                        <div className="flex items-center justify-between mb-1">
                          <div className="flex items-center gap-2">
                            {meta.sort_order > 0 && (
                              <span className="text-xs font-bold text-gray-400 w-5 text-right">{meta.sort_order}.</span>
                            )}
                            <span className={`font-medium text-sm ${isHidden ? 'text-gray-500' : 'text-gray-800'}`}>{analyte.name}</span>
                            <span className="text-xs text-gray-400">
                              {analyte.referenceRange ? `(${analyte.referenceRange})` : ''}
                              {analyte.unit ? ` [${analyte.unit}]` : ''}
                            </span>
	                            {analyte.is_calculated && (
	                              <span
	                                className="inline-flex items-center gap-1 text-xs bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded font-medium border border-amber-300"
	                                title={analyte.formula ? `Formula: ${analyte.formula}` : 'Calculated analyte (no formula configured yet)'}
	                              >
	                                <Calculator className="w-3 h-3" />
	                                Calculated
	                              </span>
	                            )}
	                            {isHidden && (
	                              <span className="text-xs bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded font-medium">Hidden on Report</span>
	                            )}
	                            {pairedWithName && (
	                              <span className="text-xs bg-indigo-100 text-indigo-700 px-1.5 py-0.5 rounded font-medium">Same row with {pairedWithName}</span>
	                            )}
	                            {missingDependencyLabels.length > 0 && (
	                              <span
	                                className="inline-flex items-center gap-1 text-xs bg-red-100 text-red-700 px-1.5 py-0.5 rounded font-medium border border-red-200"
	                                title={`Calculated source not in this group: ${missingDependencyLabels.join(', ')}`}
	                              >
	                                <AlertCircle className="w-3 h-3" />
	                                Source not in group
	                              </span>
	                            )}
	                            {dependencyIssues.duplicateCount > 0 && (
	                              <span
	                                className="inline-flex items-center gap-1 text-xs bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded font-medium border border-amber-200"
	                                title={`${dependencyIssues.duplicateCount} duplicate dependency row(s) will be ignored during calculation`}
	                              >
	                                <AlertCircle className="w-3 h-3" />
	                                {dependencyIssues.duplicateCount} duplicate ignored
	                              </span>
	                            )}
	                          </div>
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              title={isHidden ? 'Show on report' : 'Hide on report'}
                              onClick={() => setAnalyteMetadata(prev => ({
                                ...prev,
                                [analyte.id]: { ...meta, is_visible: !meta.is_visible }
                              }))}
                              className={`p-1 rounded hover:bg-gray-100 ${isHidden ? 'text-orange-500' : 'text-gray-400 hover:text-gray-600'}`}
                            >
                              {isHidden ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditingAttachedAnalyte(analyte)}
                              className="text-blue-600 hover:text-blue-800 text-xs font-medium px-2 py-1 rounded hover:bg-blue-50 flex items-center"
                            >
                              <Edit className="w-3 h-3 mr-1" />
                              Edit
                            </button>
                            <button
                              type="button"
                              title="Delink analyte from this test group"
                              onClick={() => {
                                if (confirm(`Remove "${analyte.name}" from this test group?`)) {
                                  setFormData(prev => ({ ...prev, selectedAnalytes: prev.selectedAnalytes.filter((id: string) => id !== analyte.id) }));
                                  setAllLinkedAnalytes(prev => prev.filter(a => a.id !== analyte.id));
                                  setAnalyteMetadata(prev => { const next = { ...prev }; delete next[analyte.id]; return next; });
                                }
                              }}
                              className="text-red-400 hover:text-red-600 p-1 rounded hover:bg-red-50"
                            >
                              <Unlink className="w-3.5 h-3.5" />
                            </button>
                          </div>
	                        </div>
	                        {analyte.is_calculated && (
	                          <div className="mb-2 rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
	                            {analyte.formula ? (
	                              <>
	                                <span className="font-medium">Formula:</span>{' '}
	                                <code className="font-mono bg-white/70 border border-amber-200 rounded px-1 py-0.5">{analyte.formula}</code>
	                                {Array.isArray(analyte.formula_variables) && analyte.formula_variables.length > 0 && (
	                                  <span className="ml-2 text-amber-700">
	                                    Variables: {analyte.formula_variables.join(', ')}
	                                  </span>
	                                )}
	                              </>
	                            ) : (
	                              <>Marked as calculated but no formula configured. Use <strong>AI Calculated</strong> or edit this analyte to set one.</>
	                            )}
	                          </div>
	                        )}
	                        {missingDependencyLabels.length > 0 && (
	                          <div className="mb-2 rounded border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-700">
	                            Formula source not attached to this test group: <strong>{missingDependencyLabels.join(', ')}</strong>. Edit this analyte and choose the in-group source.
	                          </div>
	                        )}
	                        <div className="flex gap-2 mt-1">
                          <div className="flex items-center gap-1">
                            <label className="text-xs text-gray-500 whitespace-nowrap">Order:</label>
                            <input
                              type="number"
                              min={0}
                              value={meta.sort_order}
                              onChange={(e) => setAnalyteMetadata(prev => ({
                                ...prev,
                                [analyte.id]: { ...meta, sort_order: parseInt(e.target.value) || 0 }
                              }))}
                              className="w-14 text-xs border border-gray-300 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-400"
                            />
                          </div>
	                          <div className="flex items-center gap-1 flex-1">
                            <label className="text-xs text-gray-500 whitespace-nowrap">Section Heading:</label>
                            <input
                              type="text"
                              value={meta.section_heading}
                              placeholder="e.g. Chemical Examination"
                              onChange={(e) => setAnalyteMetadata(prev => ({
                                ...prev,
                                [analyte.id]: { ...meta, section_heading: e.target.value }
                              }))}
                              className="flex-1 text-xs border border-gray-300 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-400"
                            />
	                          </div>
	                        </div>
	                        <div className="flex gap-2 mt-2">
	                          <div className="flex items-center gap-1 flex-1">
	                            <label className="text-xs text-gray-500 whitespace-nowrap">Same Row Sibling:</label>
	                            <select
	                              value={reportOptions.sameRowSiblingAnalyteId || ''}
	                              onChange={(e) => updateSameRowSibling(analyte.id, e.target.value)}
	                              className="flex-1 text-xs border border-gray-300 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-400"
	                            >
	                              <option value="">None</option>
	                              {selectedAnalyteDetails
	                                .filter((candidate: any) => candidate.id !== analyte.id)
	                                .map((candidate: any) => (
	                                  <option key={candidate.id} value={candidate.id}>
	                                    {candidate.name}
	                                  </option>
	                                ))}
	                            </select>
	                          </div>
	                          {reportOptions.sameRowSiblingAnalyteId && (
	                            <div className="flex items-center gap-1 w-48">
	                              <label className="text-xs text-gray-500 whitespace-nowrap">Label:</label>
	                              <input
	                                type="text"
	                                value={reportOptions.sameRowSiblingLabel || 'Absolute Count'}
	                                onChange={(e) => setAnalyteMetadata(prev => ({
	                                  ...prev,
	                                  [analyte.id]: {
	                                    ...meta,
	                                    report_display_options: {
	                                      ...(reportOptions || {}),
	                                      sameRowSiblingLabel: e.target.value,
	                                      sameRowSiblingPosition: 'right',
	                                    },
	                                  },
	                                }))}
	                                className="w-full text-xs border border-gray-300 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-400"
	                              />
	                            </div>
	                          )}
	                        </div>
	                      </div>
	                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Required Patient Inputs & Pre-Conditions */}
          <div className="space-y-4 border-t border-gray-200 pt-6">
            <h3 className="text-lg font-medium text-gray-900 flex items-center">
              <AlertCircle className="h-5 w-5 mr-2 text-blue-600" />
              Required Patient Inputs & Pre-Conditions
            </h3>
            <p className="text-sm text-gray-500 -mt-2">
              When checked, the order form will require these inputs before submission.
            </p>

            <div className="bg-blue-50 rounded-lg p-4">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {[
                  { key: 'pregnancy_status', label: 'Pregnancy Status' },
                  { key: 'lmp', label: 'LMP (Last Menstrual Period)' },
                  { key: 'weight', label: 'Weight' },
                  { key: 'height', label: 'Height' },
                  { key: 'blood_pressure', label: 'Blood Pressure' },
                  { key: 'id_document', label: 'ID Document (Aadhaar etc.)' },
                  { key: 'consent_form', label: 'Consent Form' },
                ].map(({ key, label }) => (
                  <label key={key} className="flex items-center px-3 py-2 border rounded-md bg-white hover:bg-blue-50 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={formData.required_patient_inputs.includes(key)}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        setFormData(prev => ({
                          ...prev,
                          required_patient_inputs: checked
                            ? [...prev.required_patient_inputs, key]
                            : prev.required_patient_inputs.filter(f => f !== key)
                        }));
                      }}
                      className="h-4 w-4 text-blue-600 rounded"
                    />
                    <span className="ml-2 text-sm">{label}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>

          {/* AI Reference Range Configuration */}
          <div className="space-y-4 border-t border-gray-200 pt-6">
            <h3 className="text-lg font-medium text-gray-900 flex items-center">
              <Brain className="h-5 w-5 mr-2 text-purple-600" />
              AI Reference Range Configuration
            </h3>

            <div className="bg-purple-50 rounded-lg p-4 space-y-4">
              <label className="flex items-center">
                <input
                  type="checkbox"
                  checked={formData.ref_range_ai_config?.enabled}
                  onChange={(e) => setFormData(prev => ({
                    ...prev,
                    ref_range_ai_config: { ...prev.ref_range_ai_config, enabled: e.target.checked }
                  }))}
                  className="h-4 w-4 text-purple-600 focus:ring-purple-500 border-gray-300 rounded"
                />
                <span className="ml-2 font-medium text-gray-900">Enable AI Reference Range Determination</span>
              </label>

              {formData.ref_range_ai_config?.enabled && (
                <div className="ml-6 grid grid-cols-2 gap-4">
                  <label className="flex items-center">
                    <input
                      type="checkbox"
                      checked={formData.ref_range_ai_config?.consider_age}
                      onChange={(e) => setFormData(prev => ({
                        ...prev,
                        ref_range_ai_config: { ...prev.ref_range_ai_config, consider_age: e.target.checked }
                      }))}
                      className="h-4 w-4 text-purple-600 rounded"
                    />
                    <span className="ml-2 text-sm">Consider Exact Age (Pediatric)</span>
                  </label>
                </div>
              )}
            </div>
          </div>




          {/* Outsourced Configuration */}
          <div className="space-y-4 border-t border-gray-200 pt-6">
            <h3 className="text-lg font-medium text-gray-900 flex items-center">
              <Building2 className="h-5 w-5 mr-2 text-blue-600" />
              Outsourced Configuration
            </h3>

            <div className="space-y-4">
              <div className="flex items-center gap-6">
                <label className="flex items-center">
                  <input
                    type="checkbox"
                    name="is_outsourced"
                    checked={formData.is_outsourced}
                    onChange={handleChange}
                    className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                  />
                  <span className="ml-2 text-sm text-gray-700">Outsourced</span>
                </label>
                <label className="flex items-center">
                  <input
                    type="checkbox"
                    checked={!formData.is_outsourced}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setFormData(prev => ({
                          ...prev,
                          is_outsourced: false,
                          default_outsourced_lab_id: '',
                        }));
                      }
                    }}
                    className="h-4 w-4 text-green-600 focus:ring-green-500 border-gray-300 rounded"
                  />
                  <span className="ml-2 text-sm text-gray-700">In House</span>
                </label>
              </div>

              {formData.is_outsourced && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Default Outsourced Lab
                  </label>
                  <select
                    name="default_outsourced_lab_id"
                    value={formData.default_outsourced_lab_id}
                    onChange={handleChange}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  >
                    <option value="">Select Lab</option>
                    {outsourcedLabs.map(lab => (
                      <option key={lab.id} value={lab.id}>{lab.name}</option>
                    ))}
                  </select>
                  <p className="text-xs text-gray-500 mt-1">
                    Select the default lab where this test is sent. You can change this per order.
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Analyzer Interface */}
          {analyzerConnections.length > 0 && (
            <div className="space-y-4 border-t border-gray-200 pt-6">
              <h3 className="text-lg font-medium text-gray-900 flex items-center">
                <Settings className="h-5 w-5 mr-2 text-teal-600" />
                Analyzer Interface
              </h3>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Connected Analyzer
                </label>
                <select
                  value={formData.analyzer_connection_id}
                  onChange={(e) => setFormData(prev => ({ ...prev, analyzer_connection_id: e.target.value }))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent"
                >
                  <option value="">None (manual entry / no auto-dispatch)</option>
                  {analyzerConnections.map((ac: any) => (
                    <option key={ac.id} value={ac.id}>
                      {ac.name}{ac.status ? ` — ${ac.status}` : ''}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-gray-500 mt-1">
                  All tests in this group will be auto-dispatched to the selected analyzer after order registration.
                  Map each attached analyte's analyzer result code below so inbound results update the correct analyte.
                </p>
              </div>
              {formData.analyzer_connection_id && testGroup?.id ? (
                <AnalyzerMappingPanel
                  testGroupId={testGroup.id}
                  testGroupName={formData.name || testGroup.name}
                  labId={testGroup.lab_id || null}
                  analyzerConnection={selectedAnalyzerConnection}
                  analytes={selectedAnalyteDetails}
                  onReload={loadData}
                />
              ) : formData.analyzer_connection_id ? (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                  Save this test group first, then reopen it to map analyzer codes for the connected analyzer.
                </div>
              ) : null}
            </div>
          )}

          {showProviderOnlyFields && (
            <div className="space-y-4">
              <h3 className="text-lg font-medium text-gray-900 flex items-center">
                <Brain className="h-5 w-5 mr-2 text-purple-600" />
                AI Processing Configuration (for this Test Group)
              </h3>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Default AI Processing Type
                  </label>
                  <select
                    name="default_ai_processing_type"
                    value={formData.default_ai_processing_type}
                    onChange={handleChange}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  >
                    {aiProcessingTypes.map(type => (
                      <option key={type.value} value={type.value}>{type.label}</option>
                    ))}
                  </select>
                  <div className="text-xs text-gray-500 mt-1">
                    {aiProcessingTypes.find(t => t.value === formData.default_ai_processing_type)?.description}
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Group-Level AI Prompt (Optional)
                  </label>
                  <textarea
                    name="group_level_prompt"
                    rows={4}
                    value={formData.group_level_prompt}
                    onChange={handleChange}
                    placeholder="Enter a custom prompt for AI processing at the test group level. This overrides analyte-level prompts if group AI mode is 'group_only'."
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                  <div className="text-xs text-gray-500 mt-1">This prompt will be used if the analyte's AI mode is 'group_only' or 'both'.</div>
                </div>
              </div>
            </div>
          )}

          {/* Form Actions */}
          <div className="flex items-center justify-between pt-6 border-t border-gray-200">
            <div className="flex items-center gap-2">
              {testGroup?.id && (
                <button
                  type="button"
                  onClick={() => setShowImportWizard(true)}
                  className="flex items-center gap-2 px-4 py-2 border border-purple-300 text-purple-700 rounded-md hover:bg-purple-50 transition-colors text-sm"
                >
                  <Sparkles className="h-4 w-4" />
                  Import from Report
                </button>
              )}
              {testGroup?.id && (
                <div className="flex flex-col">
                  <button
                    type="button"
                    onClick={handleSyncFromGlobal}
                    disabled={syncingGlobal}
                    className="flex items-center gap-2 px-4 py-2 border border-blue-300 text-blue-700 rounded-md hover:bg-blue-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm"
                    title="Reattach any missing analytes from global catalog (non-destructive)"
                  >
                    <RefreshCw className={`h-4 w-4 ${syncingGlobal ? 'animate-spin' : ''}`} />
                    {syncingGlobal ? 'Syncing...' : 'Sync from Global'}
                  </button>
                  {syncGlobalResult && (
                    <span className={`text-xs mt-1 ${syncGlobalResult.startsWith('Error') ? 'text-red-500' : 'text-green-600'}`}>
                      {syncGlobalResult}
                    </span>
                  )}
                </div>
              )}
            </div>
            <div className="flex items-center space-x-4">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={false}
                className="px-6 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
              >
                {testGroup ? 'Update Test Group' : 'Create Test Group'}
              </button>
            </div>
          </div>
        </form>
      </div >

       {/* Analyte Form Modal */}
       {
         showAnalyteForm && (
           <AnalyteForm
             onClose={() => setShowAnalyteForm(false)}
             onSubmit={handleAddNewAnalyte}
           />
         )
       }

        {/* Edit Attached Analyte Modal */}
        {editingAttachedAnalyte && (
            <SimpleAnalyteEditor
                analyte={{
                  ...editingAttachedAnalyte,
                  lab_analyte_id: editingAttachedAnalyte.lab_analyte_id ?? null,
                }}
                availableAnalytes={analytes
                    .filter(a => !a.is_calculated && a.id !== editingAttachedAnalyte.id)
                    .map(a => ({ id: a.id, lab_analyte_id: a.lab_analyte_id || null, name: a.name, unit: a.unit || '', category: a.category }))}
                testGroupAnalyteIds={formData.selectedAnalytes.filter((id: string) => id !== editingAttachedAnalyte.id)}
                onSave={handleUpdateAttachedAnalyte}
                onCancel={() => setEditingAttachedAnalyte(null)}
            />
        )}

        {/* AI Report Import Wizard */}
        {showImportWizard && testGroup?.id && (
          <ReportImportWizard
            testGroupId={testGroup.id}
            testGroup={{
              methodology: formData.methodology,
              sampleType: formData.sampleType,
            }}
            existingAnalytes={analytes
              .filter(a => Boolean(a.lab_analyte_id))
              .map(a => ({
                id: a.id,
                lab_analyte_id: a.lab_analyte_id,
                name: a.name,
                code: a.code ?? '',
                category: a.category ?? 'General',
                unit: a.unit ?? '',
                reference_range: a.reference_range ?? '',
                reference_range_male: a.reference_range_male ?? null,
                reference_range_female: a.reference_range_female ?? null,
              }))}
            existingTga={Object.entries(analyteMetadata).map(([analyte_id, meta]) => ({
              id: meta.tga_id,
              analyte_id,
              lab_analyte_id: meta.lab_analyte_id ?? null,
              sort_order: meta.sort_order,
              section_heading: meta.section_heading,
            }))}
            defaultAnalyteCategory={formData.category || 'General'}
            onClose={() => setShowImportWizard(false)}
            onApplied={() => {
              setShowImportWizard(false);
              loadData(); // reload analytes + TGA metadata
            }}
          />
        )}
    </div >
  );
};

export default TestGroupForm;
