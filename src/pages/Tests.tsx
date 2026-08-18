import React, { useState, useEffect, useRef } from 'react';
import { Plus, Edit2, Trash2, Search, Filter, X, Save, AlertCircle, Beaker, Layers, Package, DollarSign, Eye, EyeOff, Edit, Link2, Calculator, RefreshCw, Brain, ChevronDown, ShieldAlert, FlaskConical } from 'lucide-react';
import { database, supabase } from '../utils/supabase';
import { useAuth } from '../contexts/AuthContext';
import TestGroupForm from '../components/Tests/TestGroupForm';
import TestForm from '../components/Tests/TestForm';
import AnalyteForm from '../components/Tests/AnalyteForm';
import PackageForm from '../components/Tests/PackageForm';
import TestDetailModal from '../components/Tests/TestDetailModal';
import AnalyteDetailModal from '../components/Tests/AnalyteDetailModal';
import TestGroupDetailModal from '../components/Tests/TestGroupDetailModal';
import PackageDetailModal from '../components/Tests/PackageDetailModal';
import { SimpleAnalyteEditor } from '../components/TestGroups/SimpleAnalyteEditor';
import AnalyteDependencyManager from '../components/Tests/AnalyteDependencyManager';
import { AITestConfigurator } from '../components/AITools/AITestConfigurator';
import { TestConfigurationResponse, normalizeAnalyteValueType } from '../utils/geminiAI';
import { SampleTypeIndicator } from '../components/Common/SampleTypeIndicator';

interface Test {
  id: string;
  name: string;
  category: string;
  method?: string;
  sampleType?: string;
  price?: number;
  turnaroundTime?: string;
  referenceRange?: string;
  units?: string;
  description?: string;
  isActive?: boolean;
  requiresFasting?: boolean;
  criticalValues?: string;
  interpretation?: string;
}

interface Analyte {
  id: string;
  lab_analyte_id?: string; // lab_analytes primary key (used for per-row deactivation)
  sampleType?: string | null;
  testGroupCount?: number;
  name: string;
  unit: string;
  referenceRange?: string;
  lowCritical?: string | number;
  highCritical?: string | number;
  interpretation?: {
    low?: string;
    normal?: string;
    high?: string;
  };
  category: string;
  isActive?: boolean;
  createdDate?: string;
  // Calculated parameter fields
  isCalculated?: boolean;
  formula?: string;
  formulaVariables?: string[];
  formulaDescription?: string;
  calculationResultType?: 'numeric' | 'text';
  // Extended fields for editor
  normalRangeMin?: number;
  normalRangeMax?: number;
  interpretationLow?: string;
  interpretationNormal?: string;
  interpretationHigh?: string;
  method?: string;
  description?: string;
  isCritical?: boolean;
  ref_range_knowledge?: any;
  aiProcessingType?: string;
  groupAiMode?: 'group_only' | 'individual' | 'both' | string;
  aiPromptOverride?: string;
  isGlobal?: boolean;
  toBeCopied?: boolean;
  expected_normal_values?: string[];
  expected_value_flag_map?: Record<string, string>;
}

const normalizeSampleType = (value: unknown): string =>
  String(value || '').trim().toLowerCase();

const buildSampleAwareLabAnalyteMap = (
  rows: Array<{ id: string; analyte_id: string; sample_type?: string | null }> | null | undefined,
  sampleType?: unknown,
): Record<string, string> => {
  const wanted = normalizeSampleType(sampleType);
  const map: Record<string, string> = {};
  const generic: Record<string, string> = {};

  for (const row of rows || []) {
    const rowSampleType = normalizeSampleType(row.sample_type);
    if (wanted && rowSampleType === wanted && !map[row.analyte_id]) {
      map[row.analyte_id] = row.id;
    } else if (!rowSampleType && !generic[row.analyte_id]) {
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

interface TestGroup {
  id: string;
  name: string;
  code?: string;
  category: string;
  clinicalPurpose?: string;
  methodology?: string;
  price?: number;
  turnaroundTime?: string;
  tat_hours?: number;
  sampleType?: string;
  sampleConditionOptions?: string[];
  defaultSampleCondition?: string | null;
  requiresFasting?: boolean;
  isActive?: boolean;
  createdDate?: string;
  default_ai_processing_type?: string;
  group_level_prompt?: string;
  global_test_catalog_id?: string | null;
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
  default_template_style?: string | null;
  print_options?: Record<string, unknown> | null;
  report_priority?: number | null;
  analytes?: string[];
  analyteDisplay?: Array<{
    analyte_id: string;
    // The specific lab_analytes row this group links to — the same global
    // analyte can have several rows with different units/ranges.
    lab_analyte_id?: string | null;
    lab_analytes?: any;
    sort_order?: number | null;
    display_order?: number | null;
    section_heading?: string | null;
  }>;
  ref_range_ai_config?: any;
  required_patient_inputs?: string[];
  group_interpretation?: string | null;
  default_report_remark?: string | null;
  is_outsourced?: boolean;
  default_outsourced_lab_id?: string;
  is_section_only?: boolean;
}

interface PackageType {
  id: string;
  name: string;
  description: string;
  testGroupIds: string[];
  price: number;
  discountPercentage: number;
  category: string;
  validityDays: number;
  isActive: boolean;
}

const Tests: React.FC = () => {
  console.log('🔵 Tests.tsx page is opening/rendering');
  const { user } = useAuth();
  const [isAdmin, setIsAdmin] = useState(false);

  const normalizeAIProcessingType = (type?: string | null): string => {
    const normalized = (type || '').trim().toUpperCase();
    const aliasMap: Record<string, string> = {
      GEMINI: 'THERMAL_SLIP_OCR',
      OCR_REPORT: 'THERMAL_SLIP_OCR',
      VISION_CARD: 'RAPID_CARD_LFA',
      VISION_COLOR: 'COLOR_STRIP_MULTIPARAM',
    };
    const value = aliasMap[normalized] || normalized;
    const valid = new Set([
      'MANUAL_ENTRY_NO_VISION',
      'THERMAL_SLIP_OCR',
      'INSTRUMENT_SCREEN_OCR',
      'RAPID_CARD_LFA',
      'COLOR_STRIP_MULTIPARAM',
      'SINGLE_WELL_COLORIMETRIC',
      'AGGLUTINATION_CARD',
      'MICROSCOPY_MORPHOLOGY',
      'ZONE_OF_INHIBITION',
      'MENISCUS_SCALE_READING',
      'SAMPLE_QUALITY_TUBE_CHECK',
      'UNKNOWN_NEEDS_REVIEW'
    ]);
    return valid.has(value) ? value : 'MANUAL_ENTRY_NO_VISION';
  };

  const [tests, setTests] = useState<Test[]>([]);
  const [testGroups, setTestGroups] = useState<TestGroup[]>([]);
  const [inactiveTestGroups, setInactiveTestGroups] = useState<TestGroup[]>([]);
  const [showInactiveTestGroups, setShowInactiveTestGroups] = useState(false);
  const [loadingInactiveTestGroups, setLoadingInactiveTestGroups] = useState(false);
  const [analytes, setAnalytes] = useState<Analyte[]>([]);
  const [inactiveAnalytes, setInactiveAnalytes] = useState<Analyte[]>([]);
  const [showInactiveAnalytes, setShowInactiveAnalytes] = useState(false);
  const [loadingInactiveAnalytes, setLoadingInactiveAnalytes] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [packages, setPackages] = useState<PackageType[]>([]);
  const [showTestForm, setShowTestForm] = useState(false);
  const [showAnalyteForm, setShowAnalyteForm] = useState(false);
  const [showTestGroupForm, setShowTestGroupForm] = useState(false);
  const [showPackageForm, setShowPackageForm] = useState(false);
  const [showTestDetail, setShowTestDetail] = useState(false);
  const [showAnalyteDetail, setShowAnalyteDetail] = useState(false);
  const [showTestGroupDetail, setShowTestGroupDetail] = useState(false);
  const [showPackageDetail, setShowPackageDetail] = useState(false);
  const [selectedTest, setSelectedTest] = useState<Test | null>(null);
  const [selectedAnalyte, setSelectedAnalyte] = useState<Analyte | null>(null);
  const [selectedTestGroup, setSelectedTestGroup] = useState<TestGroup | null>(null);
  const [selectedPackage, setSelectedPackage] = useState<PackageType | null>(null);
  const [editingTest, setEditingTest] = useState<Test | null>(null);
  const [editingAnalyte, setEditingAnalyte] = useState<Analyte | null>(null);
  const [editingTestGroup, setEditingTestGroup] = useState<TestGroup | null>(null);
  const [editingPackage, setEditingPackage] = useState<PackageType | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [activeTab, setActiveTab] = useState<'groups' | 'analytes' | 'packages' | 'legacy'>('groups');
  const [showEditAnalyteModal, setShowEditAnalyteModal] = useState(false);
  const [showDependencyManager, setShowDependencyManager] = useState(false);
  const [dependencyAnalyte, setDependencyAnalyte] = useState<Analyte | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMode, setSyncMode] = useState<'sync' | 'reset' | null>(null);
  const [syncStatus, setSyncStatus] = useState<string>('');
  const [showDangerDropdown, setShowDangerDropdown] = useState(false);
  const [dangerModal, setDangerModal] = useState<'sync' | 'reset' | null>(null);
  const [dangerStep, setDangerStep] = useState<1 | 2>(1);
  const [dangerChecked, setDangerChecked] = useState(false);
  const [dangerTypeInput, setDangerTypeInput] = useState('');
  const dangerDropdownRef = useRef<HTMLDivElement>(null);

  // State for AI Configurator
  const [showAIConfigurator, setShowAIConfigurator] = useState(false);
  const [analyteSort, setAnalyteSort] = useState<'asc' | 'desc' | null>(null);
  const [outsourcedFilter, setOutsourcedFilter] = useState<'all' | 'inhouse' | 'outsourced'>('all');

  // Lab-level flag options for analyte flag mapping
  const [labFlagOptions, setLabFlagOptions] = useState<Array<{value: string; label: string}>>([]);

  // Analyte linked test groups popup
  const [analyteGroupsPopup, setAnalyteGroupsPopup] = useState<{
    analyte: Analyte;
    groups: { id: string; name: string; code?: string; category: string }[];
    loading: boolean;
  } | null>(null);

  console.log('✅ Tests component state initialized');

  const transformTestGroupRow = (group: any): TestGroup => ({
    id: group.id,
    name: group.name,
    code: group.code,
    category: group.category,
    clinicalPurpose: group.clinical_purpose,
    methodology: group.methodology,
    price: group.price,
    turnaroundTime: group.turnaround_time,
    tat_hours: group.tat_hours,
    sampleType: group.sample_type,
    sampleConditionOptions: Array.isArray(group.sample_condition_options) ? group.sample_condition_options : [],
    defaultSampleCondition: group.default_sample_condition || null,
    requiresFasting: group.requires_fasting,
    isActive: group.is_active,
    createdDate: group.created_at,
    default_ai_processing_type: group.default_ai_processing_type,
    group_level_prompt: group.group_level_prompt,
    testType: group.test_type || 'Default',
    gender: group.gender || 'Both',
    sampleColor: group.sample_color || 'Red',
    barcodeSuffix: group.barcode_suffix,
    lmpRequired: group.lmp_required || false,
    idRequired: group.id_required || false,
    consentForm: group.consent_form || false,
    preCollectionGuidelines: group.pre_collection_guidelines,
    flabsId: group.flabs_id,
    onlyFemale: group.only_female || false,
    onlyMale: group.only_male || false,
    onlyBilling: group.only_billing || false,
    startFromNextPage: group.start_from_next_page || false,
    report_priority: group.report_priority ?? null,
    default_template_style: group.default_template_style || null,
    print_options: group.print_options ?? null,
    is_outsourced: group.is_outsourced || false,
    default_outsourced_lab_id: group.default_outsourced_lab_id,
    ref_range_ai_config: group.ref_range_ai_config,
    required_patient_inputs: group.required_patient_inputs || [],
    group_interpretation: group.group_interpretation || null,
    default_report_remark: group.default_report_remark || null,
    global_test_catalog_id: group.global_test_catalog_id || null,
    analyzer_connection_id: group.analyzer_connection_id || null,
    is_section_only: group.is_section_only || false,
    analytes: group.test_group_analytes ? group.test_group_analytes.map((tga: any) => tga.analyte_id) : [],
    analyteDisplay: group.test_group_analytes || []
  });

  const handleAIConfigurationGenerated = async (config: TestConfigurationResponse) => {
    try {
      const toBoolean = (value: unknown): boolean => {
        if (typeof value === 'boolean') return value;
        if (typeof value === 'string') return value.trim().toLowerCase() === 'true';
        return false;
      };

      const parseFormulaVariables = (value: unknown): string[] => {
        if (Array.isArray(value)) return value.map(String).map((v) => v.trim()).filter(Boolean);
        if (typeof value === 'string') {
          const trimmed = value.trim();
          if (!trimmed) return [];
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) return parsed.map(String).map((v) => v.trim()).filter(Boolean);
          } catch {
            return trimmed.split(',').map((v) => v.trim()).filter(Boolean);
          }
        }
        return [];
      };

      const labId = await database.getCurrentUserLabId();
      if (!labId) {
        alert('Error: Could not determine your lab context. Please try again.');
        return;
      }

      console.log('Generating AI Configuration for Lab:', labId, config);

      // Check for existing test group
      const { data: existingGroups } = await supabase
        .from('test_groups')
        .select('id, name, code')
        // Check for conflicts in this lab (or global if we want strict uniqueness)
        .eq('lab_id', labId)
        .or(`name.eq.${config.test_group.name},code.eq.${config.test_group.code}`)
        .limit(1);

      if (existingGroups && existingGroups.length > 0) {
        alert(`Test group "${config.test_group.name}" or code "${config.test_group.code}" already exists in your lab.`);
        return;
      }

      // 1. Create Test Group
      const testGroupData = {
        name: config.test_group.name,
        code: config.test_group.code,
        global_test_catalog_id: null,
        category: config.test_group.category,
        clinical_purpose: config.test_group.clinical_purpose,
        price: parseFloat(config.test_group.price),
        turnaround_time: config.test_group.turnaround_time,
        sample_type: config.test_group.sample_type,
        requires_fasting: config.test_group.requires_fasting,
        is_active: true,
        default_ai_processing_type: normalizeAIProcessingType(config.test_group.default_ai_processing_type),
        group_level_prompt: config.test_group.group_level_prompt,
        lab_id: labId,
        to_be_copied: false,
        // Default new fields
        test_type: 'Default',
        gender: 'Both',
        sample_color: 'Red'
      };

      const { data: newTestGroup, error: tgError } = await supabase
        .from('test_groups')
        .insert(testGroupData)
        .select()
        .single();

      if (tgError) throw new Error('Failed to create test group: ' + tgError.message);

      console.log('✅ Test Group Created:', newTestGroup);

      // 2. Create or Reuse Analytes
      const finalAnalyteIds = [];
      const createdAnalytesInfo = [];

	      // We process analytes sequentially
	      for (const analyteData of config.analytes) {
	        let analyteId = null;
	        const isCalculated = toBoolean((analyteData as any).is_calculated);
	        const formula = typeof (analyteData as any).formula === 'string' ? (analyteData as any).formula.trim() : '';
	        const formulaVariables = parseFormulaVariables((analyteData as any).formula_variables);
	        const calculationResultType = (analyteData as any).calculation_result_type === 'text' ? 'text' : 'numeric';
	        const expectedNormalValues = Array.isArray((analyteData as any).expected_normal_values)
	          ? (analyteData as any).expected_normal_values.map((value: unknown) => String(value).trim()).filter(Boolean)
	          : [];
	        const normalizedValueType = normalizeAnalyteValueType(
	          (analyteData as any).value_type,
	          expectedNormalValues,
	          analyteData.unit,
	        ) || (isCalculated ? 'numeric' : null);

	        // A. Check if analyte already exists (exact name match)
	        const { data: existingAnalyte } = await supabase
	          .from('analytes')
	          .select('id, name, is_calculated, formula, value_type, expected_normal_values')
	          .ilike('name', analyteData.name.trim())
	          .limit(1)
	          .single();

        if (existingAnalyte) {
          console.log(`♻️ Reusing existing analyte: ${existingAnalyte.name} (${existingAnalyte.id})`);
          analyteId = existingAnalyte.id;
        } else {
          // B. Create new analyte if not found
          const analytePayload = {
            name: analyteData.name.trim(),
            unit: analyteData.unit,
            reference_range: analyteData.reference_range,
            low_critical: analyteData.low_critical ? parseFloat(analyteData.low_critical) : null,
            high_critical: analyteData.high_critical ? parseFloat(analyteData.high_critical) : null,
            interpretation_low: analyteData.interpretation_low,
            interpretation_normal: analyteData.interpretation_normal,
            interpretation_high: analyteData.interpretation_high,
            category: analyteData.category,
            sample_type: config.test_group.sample_type || null,
            is_active: true,
            is_global: false, // Lab specific
            ai_processing_type: normalizeAIProcessingType(analyteData.ai_processing_type || config.test_group.default_ai_processing_type),
	            group_ai_mode: analyteData.group_ai_mode || 'individual',
	            is_calculated: isCalculated,
	            formula: formula || null,
	            formula_variables: formulaVariables,
	            formula_description: (analyteData as any).formula_description || null,
	            calculation_result_type: calculationResultType,
	            value_type: normalizedValueType,
	            expected_normal_values: expectedNormalValues
	          };

          const { data: newAnalyte, error: analyteError } = await supabase
            .from('analytes')
            .insert(analytePayload)
            .select()
            .single();

          if (analyteError) {
            console.error('Error creating analyte:', analyteData.name, analyteError);
          } else if (newAnalyte) {
            console.log(`✨ Created new analyte: ${newAnalyte.name}`);
            analyteId = newAnalyte.id;
            createdAnalytesInfo.push(newAnalyte.name);
          }
        }

	        const existingExpectedValues = Array.isArray((existingAnalyte as any)?.expected_normal_values)
	          ? (existingAnalyte as any).expected_normal_values
	          : [];
	        const shouldBackfillValueType = !!(existingAnalyte && analyteId && normalizedValueType && !(existingAnalyte as any).value_type);
	        const shouldBackfillExpectedValues = !!(existingAnalyte && analyteId && expectedNormalValues.length > 0 && existingExpectedValues.length === 0);
	        const shouldBackfillCalculated =
	          !!(existingAnalyte && analyteId && isCalculated && formula && (!(existingAnalyte as any).is_calculated || !(existingAnalyte as any).formula));

	        if (shouldBackfillCalculated || shouldBackfillValueType || shouldBackfillExpectedValues) {
	          const { error: updateExistingError } = await supabase
	            .from('analytes')
	            .update({
	              ...(shouldBackfillCalculated ? {
	                is_calculated: true,
	                formula,
	                formula_variables: formulaVariables,
	                formula_description: (analyteData as any).formula_description || null,
	                calculation_result_type: calculationResultType,
	                reference_range: analyteData.reference_range || null,
	                interpretation_low: analyteData.interpretation_low || null,
	                interpretation_normal: analyteData.interpretation_normal || null,
	                interpretation_high: analyteData.interpretation_high || null,
	              } : {}),
	              ...(shouldBackfillValueType ? { value_type: normalizedValueType } : {}),
	              ...(shouldBackfillExpectedValues ? { expected_normal_values: expectedNormalValues } : {}),
	            })
	            .eq('id', existingAnalyte.id);

	          if (updateExistingError) {
	            console.warn(`Failed to enrich existing analyte ${existingAnalyte.name}:`, updateExistingError);
	          }
	        }

        if (analyteId) {
          finalAnalyteIds.push({ id: analyteId });
        }
      }

      console.log(`✅ Processed ${finalAnalyteIds.length} analytes (Created: ${createdAnalytesInfo.length}, Reused: ${finalAnalyteIds.length - createdAnalytesInfo.length})`);

      // 3. Link Analytes to Test Group
      if (newTestGroup && finalAnalyteIds.length > 0) {
        // Resolve lab_analyte_id for each analyte. Prefer this test group's
        // sample type, then fall back to the generic lab analyte row.
        let labAnalyteMap: Record<string, string> = {};
        if (newTestGroup.lab_id) {
          const { data: laRows } = await supabase
            .from('lab_analytes')
            .select('id, analyte_id, sample_type')
            .eq('lab_id', newTestGroup.lab_id)
            .in('analyte_id', finalAnalyteIds.map(a => a.id))
            .order('created_at', { ascending: true });
          labAnalyteMap = buildSampleAwareLabAnalyteMap(laRows, newTestGroup.sample_type || config.test_group.sample_type);
        }

        const relationships = finalAnalyteIds.map((a, index) => ({
          test_group_id: newTestGroup.id,
          analyte_id: a.id,
          lab_analyte_id: labAnalyteMap[a.id] || null,
          is_visible: true,
          display_order: index + 1
        }));

        const { error: relError } = await supabase.from('test_group_analytes').insert(relationships);
        if (relError) console.error('Error linking analytes:', relError);
      }

      alert(`✅ Successfully created "${config.test_group.name}"!\n\nDetails:\n• Test Group Created\n• ${createdAnalytesInfo.length} New Analytes Created\n• ${finalAnalyteIds.length - createdAnalytesInfo.length} Existing Analytes Reused\n• All generated and linked.`);
      setShowAIConfigurator(false);

      // Trigger data reload
      window.location.reload();

    } catch (e: any) {
      console.error('AI Config Error:', e);
      alert('Error creating AI configuration: ' + (e.message || e));
    }
  };

  // Fetch admin role
  React.useEffect(() => {
    if (!user?.id) return;
    supabase.from('users').select('role').eq('id', user.id).single().then(({ data }) => {
      setIsAdmin(data?.role?.toLowerCase() === 'admin');
    });
  }, [user?.id]);

  // Close danger dropdown on outside click
  React.useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dangerDropdownRef.current && !dangerDropdownRef.current.contains(e.target as Node)) {
        setShowDangerDropdown(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const openDangerModal = (mode: 'sync' | 'reset') => {
    setDangerModal(mode);
    setDangerStep(1);
    setDangerChecked(false);
    setDangerTypeInput('');
    setShowDangerDropdown(false);
  };

  const closeDangerModal = () => {
    setDangerModal(null);
    setDangerStep(1);
    setDangerChecked(false);
    setDangerTypeInput('');
  };

  const loadData = React.useCallback(async () => {
      try {
        console.log('🔄 Starting parallel data load');

        const [analytesResult, testGroupsResult, packagesResult] = await Promise.all([
          database.analytes.getAll(),
          database.testGroups.getAll(),
          database.packages.getAll(),
        ]);

        // Process analytes
        const { data: dbAnalytesData, error: analytesError } = analytesResult;
        if (analytesError) {
          console.error('❌ Error loading analytes from database:', analytesError);
          setAnalytes([]);
        } else {
          console.log('✅ Analytes loaded:', dbAnalytesData?.length || 0, 'records');
          const transformedAnalytes = (dbAnalytesData || []).map(analyte => ({
            id: analyte.id,
            lab_analyte_id: analyte.lab_analyte_id,
            testGroupCount: analyte.test_group_count ?? 0,
            name: analyte.name,
            unit: analyte.unit,
            referenceRange: analyte.reference_range || analyte.referenceRange,
            lowCritical: analyte.low_critical,
            highCritical: analyte.high_critical,
            interpretation: {
              low: analyte.interpretation_low || analyte.interpretation?.low || '',
              normal: analyte.interpretation_normal || analyte.interpretation?.normal || '',
              high: analyte.interpretation_high || analyte.interpretation?.high || ''
            },
            category: analyte.category,
            isActive: analyte.is_active ?? true,
            createdDate: analyte.created_at || new Date().toISOString(),
            isCalculated: analyte.is_calculated || false,
            formula: analyte.formula || '',
            formulaVariables: analyte.formula_variables || [],
            formulaDescription: analyte.formula_description || '',
            normalRangeMin: analyte.normal_range_min ?? undefined,
            normalRangeMax: analyte.normal_range_max ?? undefined,
            interpretationLow: analyte.interpretation_low,
            interpretationNormal: analyte.interpretation_normal,
            interpretationHigh: analyte.interpretation_high,
            method: analyte.method || undefined,
            description: analyte.description || undefined,
            isCritical: analyte.is_critical ?? false,
            aiProcessingType: analyte.ai_processing_type || undefined,
            groupAiMode: analyte.group_ai_mode || undefined,
            aiPromptOverride: analyte.ai_prompt_override || undefined,
            isGlobal: analyte.is_global ?? false,
            toBeCopied: analyte.to_be_copied ?? false,
            ref_range_knowledge: analyte.ref_range_knowledge,
            expected_normal_values: analyte.expected_normal_values || [],
            expected_value_flag_map: analyte.expected_value_flag_map || {},
          }));
          setAnalytes(transformedAnalytes);
        }

        // Process test groups
        const { data: dbTestGroupsData, error: testGroupsError } = testGroupsResult;
        if (testGroupsError) {
          console.error('❌ Error loading test groups from database:', testGroupsError);
          setTestGroups([]);
        } else {
          console.log('✅ Test Groups loaded:', dbTestGroupsData?.length || 0, 'records');
          const transformedTestGroups = (dbTestGroupsData || []).map(group => ({
            id: group.id,
            name: group.name,
            code: group.code,
            category: group.category,
            clinicalPurpose: group.clinical_purpose,
            methodology: group.methodology,
            price: group.price,
            turnaroundTime: group.turnaround_time,
            tat_hours: group.tat_hours,
            sampleType: group.sample_type,
            sampleConditionOptions: Array.isArray(group.sample_condition_options) ? group.sample_condition_options : [],
            defaultSampleCondition: group.default_sample_condition || null,
            requiresFasting: group.requires_fasting,
            isActive: group.is_active,
            createdDate: group.created_at,
            default_ai_processing_type: group.default_ai_processing_type,
            group_level_prompt: group.group_level_prompt,
            testType: group.test_type || 'Default',
            gender: group.gender || 'Both',
            sampleColor: group.sample_color || 'Red',
            barcodeSuffix: group.barcode_suffix,
            lmpRequired: group.lmp_required || false,
            idRequired: group.id_required || false,
            consentForm: group.consent_form || false,
            preCollectionGuidelines: group.pre_collection_guidelines,
            flabsId: group.flabs_id,
            onlyFemale: group.only_female || false,
            onlyMale: group.only_male || false,
            onlyBilling: group.only_billing || false,
	            startFromNextPage: group.start_from_next_page || false,
	            report_priority: group.report_priority ?? null,
	            default_template_style: group.default_template_style || null,
            print_options: group.print_options ?? null,
            is_outsourced: group.is_outsourced || false,
            default_outsourced_lab_id: group.default_outsourced_lab_id,
            ref_range_ai_config: group.ref_range_ai_config,
            required_patient_inputs: group.required_patient_inputs || [],
            group_interpretation: group.group_interpretation || null,
		            default_report_remark: group.default_report_remark || null,
		            global_test_catalog_id: group.global_test_catalog_id || null,
		            analyzer_connection_id: group.analyzer_connection_id || null,
		            is_section_only: group.is_section_only || false,
	            analytes: group.test_group_analytes ? group.test_group_analytes.map((tga: any) => tga.analyte_id) : [],
              analyteDisplay: group.test_group_analytes || []
	          }));
          setTestGroups(transformedTestGroups);
        }

        // Process packages
        const { data: dbPackagesData, error: packagesError } = packagesResult;
        if (packagesError) {
          console.error('❌ Error loading packages from database:', packagesError);
          setPackages([]);
        } else {
          console.log('✅ Packages loaded:', dbPackagesData?.length || 0, 'records');
          const transformedPackages = (dbPackagesData || []).map(pkg => {
            const ptg = pkg.package_test_groups || [];
            const testGroupIds = Array.isArray(ptg)
              ? ptg.map((item: any) => item.test_group_id).filter(Boolean)
              : [];
            return {
              id: pkg.id,
              name: pkg.name,
              description: pkg.description || '',
              price: pkg.price,
              discountPercentage: pkg.discount_percentage || 0,
              category: pkg.category || 'General',
              validityDays: pkg.validity_days || 30,
              isActive: pkg.is_active ?? true,
              testGroupIds,
              createdDate: pkg.created_at || new Date().toISOString()
            };
          });
          setPackages(transformedPackages);
        }

        setTests([]);
      } catch (error) {
        console.error('Error loading data:', error);
        setAnalytes([]);
        setTestGroups([]);
        setTests([]);
        setPackages([]);
      }
  }, []);

  // Load data on component mount
  React.useEffect(() => {
    console.log('📊 Loading data from database...');
    loadData().then(() => {
      console.log('✅ All data loaded successfully');
    });

    // Fetch lab flag options for analyte flag mapping
    const loadLabFlagOptions = async () => {
      try {
        const labId = await database.getCurrentUserLabId();
        if (!labId) return;
        const { data } = await supabase.from('labs').select('flag_options').eq('id', labId).single();
        if (data?.flag_options && Array.isArray(data.flag_options)) {
          setLabFlagOptions(data.flag_options);
        }
      } catch (err) {
        console.error('Failed to load lab flag options:', err);
      }
    };
    loadLabFlagOptions();
  }, []);

  const categories = [
    'All',
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
    'General',
  ];

  const filteredPackages = (packages || []).filter(pkg => {
    const matchesSearch = pkg.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      pkg.description.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesCategory = selectedCategory === 'All' || pkg.category === selectedCategory;
    return matchesSearch && matchesCategory;
  });

  const filteredTestGroups = (() => {
    const filtered = (testGroups || []).filter(group => {
      const isVisible = group.isActive !== false;
      const matchesSearch = group.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        (group.code?.toLowerCase().includes(searchTerm.toLowerCase()) ?? false);
      const matchesCategory = selectedCategory === 'All' || group.category === selectedCategory;
      const matchesOutsourced = outsourcedFilter === 'all' ||
        (outsourcedFilter === 'outsourced' && group.is_outsourced) ||
        (outsourcedFilter === 'inhouse' && !group.is_outsourced);
      return isVisible && matchesSearch && matchesCategory && matchesOutsourced;
    });
    if (analyteSort === null) return filtered;
    return [...filtered].sort((a, b) => {
      const diff = (a.analytes?.length || 0) - (b.analytes?.length || 0);
      return analyteSort === 'asc' ? diff : -diff;
    });
  })();

  const filteredAnalytes = (analytes || []).filter(analyte => {
    const matchesSearch = analyte.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      analyte.id.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesCategory = selectedCategory === 'All' || analyte.category === selectedCategory;
    return matchesSearch && matchesCategory;
  });

  const filteredLegacyTests = (tests || []).filter(test => {
    const matchesSearch = test.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      test.id.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesCategory = selectedCategory === 'All' || test.category === selectedCategory;
    return matchesSearch && matchesCategory;
  });

  const getCategoryColor = (category: string) => {
    const colors = {
      'Hematology': 'bg-red-100 text-red-800',
      'Biochemistry': 'bg-blue-100 text-blue-800',
      'Serology': 'bg-green-100 text-green-800',
      'Microbiology': 'bg-purple-100 text-purple-800',
      'Immunology': 'bg-orange-100 text-orange-800',
      'Radiology': 'bg-sky-100 text-sky-800',
    };
    return colors[category as keyof typeof colors] || 'bg-gray-100 text-gray-800';
  };

  const handleAddTest = (_formData: any) => {
    console.warn('Individual tests are not supported. Please use test groups instead.');
    alert('Individual tests are not supported. Please use test groups instead.');
    setShowTestForm(false);
  };

  const handleAddAnalyte = async (formData: any) => {
    console.log('Creating analyte with data:', formData);
    try {
      const { data: newAnalyte, error } = await database.analytes.create({
        name: formData.name,
        unit: formData.unit,
        reference_range: formData.referenceRange,
        low_critical: formData.lowCritical,
        high_critical: formData.highCritical,
        interpretation_low: formData.interpretation?.low,
        interpretation_normal: formData.interpretation?.normal,
        interpretation_high: formData.interpretation?.high,
        category: formData.category,
        sample_type: formData.sampleType || formData.sample_type || null,
        is_active: formData.isActive ?? true,
        // AI processing fields
        ai_processing_type: formData.aiProcessingType || undefined,
        ai_prompt_override: formData.aiPromptOverride || undefined,
        group_ai_mode: formData.groupAiMode || 'individual',
        ref_range_knowledge: formData.ref_range_knowledge || null,
        // Calculated parameter fields
        is_calculated: formData.isCalculated || false,
        formula: formData.formula || null,
        formula_variables: formData.formulaVariables || [],
        formula_description: formData.formulaDescription || null,
        calculation_result_type: formData.calculation_result_type || formData.calculationResultType || 'numeric',
        // Flag determination fields
        value_type: formData.value_type || 'numeric',
        code: formData.code || undefined,
        description: formData.description || undefined,
        // Dropdown options for qualitative values
        expected_normal_values: formData.expected_normal_values || [],
        // Dropdown value → flag mapping
        expected_value_flag_map: formData.expected_value_flag_map || {},
      });

      if (error) {
        console.error('Error creating analyte:', error);
        alert('Failed to create analyte. Please try again.');
        return;
      }

	      if (newAnalyte) {
	        const transformedAnalyte = {
	          id: newAnalyte.id,
	          lab_analyte_id: (newAnalyte as any).lab_analyte_id || null,
	          sampleType: (newAnalyte as any).sample_type || null,
	          name: newAnalyte.name,
          unit: newAnalyte.unit,
          referenceRange: newAnalyte.reference_range,
          lowCritical: newAnalyte.low_critical,
          highCritical: newAnalyte.high_critical,
          interpretation: {
            low: newAnalyte.interpretation_low || '',
            normal: newAnalyte.interpretation_normal || '',
            high: newAnalyte.interpretation_high || ''
          },
          category: newAnalyte.category,
          isActive: newAnalyte.is_active,
          createdDate: newAnalyte.created_at || new Date().toISOString(),
          // Calculated fields
          isCalculated: newAnalyte.is_calculated || false,
          formula: newAnalyte.formula || '',
          formulaVariables: newAnalyte.formula_variables || [],
          formulaDescription: newAnalyte.formula_description || '',
          calculationResultType: newAnalyte.calculation_result_type || 'numeric',
          // Extended fields
          normalRangeMin: newAnalyte.normal_range_min ?? undefined,
          normalRangeMax: newAnalyte.normal_range_max ?? undefined,
          interpretationLow: newAnalyte.interpretation_low,
          interpretationNormal: newAnalyte.interpretation_normal,
          interpretationHigh: newAnalyte.interpretation_high,
          method: newAnalyte.method || undefined,
          description: newAnalyte.description || undefined,
          isCritical: newAnalyte.is_critical ?? false,
          aiProcessingType: newAnalyte.ai_processing_type || undefined,
          groupAiMode: newAnalyte.group_ai_mode || undefined,
          aiPromptOverride: newAnalyte.ai_prompt_override || undefined,
          isGlobal: newAnalyte.is_global ?? false,
          toBeCopied: newAnalyte.to_be_copied ?? false,
          ref_range_knowledge: newAnalyte.ref_range_knowledge,
          expected_normal_values: newAnalyte.expected_normal_values || [],
          expected_value_flag_map: newAnalyte.expected_value_flag_map || {}
        };

        setAnalytes(prev => [...prev, transformedAnalyte]);
        setShowAnalyteForm(false);

        // If it's a calculated analyte with source dependencies selected in form, create them automatically
	        if (newAnalyte.is_calculated && formData.sourceDependencies?.length > 0) {
	          console.log('Creating dependencies automatically:', formData.sourceDependencies);
	          try {
	            const depsLabId = await database.getCurrentUserLabId();
	            const { error: depError } = await database.analyteDependencies.setDependencies(
	              newAnalyte.id,
	              formData.sourceDependencies,
	              depsLabId ?? undefined,
	              (newAnalyte as any).lab_analyte_id || null,
	            );
	            if (depError) {
	              console.error('Error creating dependencies:', depError);
              alert('Analyte created but failed to link dependencies. Use "Manage Dependencies" button to link them manually.');
            } else {
              alert('Analyte created with dependencies linked successfully!');
            }
          } catch (depErr) {
            console.error('Error creating dependencies:', depErr);
            alert('Analyte created but failed to link dependencies. Use "Manage Dependencies" button to link them manually.');
          }
        }
        // If formula_variables exist but no sourceDependencies, show the dependency manager
        else if (newAnalyte.is_calculated && newAnalyte.formula_variables?.length > 0) {
          setDependencyAnalyte(transformedAnalyte);
          setShowDependencyManager(true);
        } else {
          alert('Analyte created successfully!');
        }
      }
    } catch (error) {
      console.error('Unexpected error:', error);
      alert('Failed to create analyte. Please try again.');
    }
  };

  const handleAddTestGroup = async (formData: any) => {
    console.log('Creating test group with data:', formData);
    try {
      const { data: newTestGroup, error } = await database.testGroups.create(formData);

      if (error) {
        console.error('Error creating test group:', error);
        alert('Failed to create test group. Please try again.');
        return;
      }

      if (newTestGroup) {
        setTestGroups(prev => [...prev, newTestGroup]);
        setShowTestGroupForm(false);
        alert('Test group created successfully!');
      }
    } catch (error) {
      console.error('Unexpected error:', error);
      alert('Failed to create test group. Please try again.');
    }
  };

  const handleAddPackage = async (formData: any) => {
    console.log('Creating package with data:', formData);
    try {
      // Create the package first
      const { data: newPackage, error: packageError } = await database.packages.create({
        name: formData.name,
        description: formData.description,
        price: formData.price,
        discount_percentage: formData.discountPercentage || 0,
        category: formData.category,
        validity_days: formData.validityDays || 30,
        is_active: formData.isActive ?? true,
      });

      if (packageError || !newPackage) {
        console.error('Error creating package:', packageError);
        alert('Failed to create package. Please try again.');
        return;
      }

      // Link test groups to package
      if (formData.testGroupIds && formData.testGroupIds.length > 0) {
        // Array position is the package-level display order chosen in the editor
        const packageTestGroups = formData.testGroupIds.map((tgId: string, index: number) => ({
          package_id: newPackage.id,
          test_group_id: tgId,
          display_order: index
        }));

        const { error: linkError } = await supabase
          .from('package_test_groups')
          .insert(packageTestGroups);

        if (linkError) {
          console.error('Error linking test groups to package:', linkError);
        }
      }

      // Reload packages to get the updated list
      const { data: dbPackagesData } = await database.packages.getAll();
      if (dbPackagesData) {
        const transformedPackages = dbPackagesData.map(pkg => ({
          id: pkg.id,
          name: pkg.name,
          description: pkg.description || '',
          price: pkg.price,
          discountPercentage: pkg.discount_percentage || 0,
          category: pkg.category || 'General',
          validityDays: pkg.validity_days || 30,
          isActive: pkg.is_active ?? true,
          testGroupIds: pkg.package_test_groups?.map((ptg: any) => ptg.test_group_id) || [],
          createdDate: pkg.created_at
        }));
        setPackages(transformedPackages);
      }

      setShowPackageForm(false);
      setEditingPackage(null);
      console.log('✅ Package created successfully:', newPackage.id);
    } catch (error) {
      console.error('Error creating package:', error);
      alert('Failed to create package. Please try again.');
    }
  };

  // View handlers
  const handleViewPackage = (pkg: PackageType) => {
    setSelectedPackage(pkg);
    setShowPackageDetail(true);
  };

  const handleViewTestGroup = (group: TestGroup) => {
    setSelectedTestGroup(group);
    setShowTestGroupDetail(true);
  };

  const handleViewAnalyte = (analyte: Analyte) => {
    setSelectedAnalyte(analyte);
    setShowAnalyteDetail(true);
  };

  const handleViewLegacyTest = (test: Test) => {
    setSelectedTest(test);
    setShowTestDetail(true);
  };

  // Edit handlers
  const handleEditPackage = (pkg: PackageType) => {
    setEditingPackage(pkg);
    setShowPackageForm(true);
  };

  const handleEditTestGroup = (group: TestGroup) => {
    setEditingTestGroup(group);
    setShowTestGroupForm(true);
  };

  const handleEditAnalyte = async (analyte: Analyte) => {
    try {
      let labAnalyte: any = null;
      if (analyte.lab_analyte_id) {
        const { data } = await database.labAnalytes.getById(analyte.lab_analyte_id);
        labAnalyte = data;
      } else {
        const labId = await database.getCurrentUserLabId();
        if (labId) {
          const { data } = await database.labAnalytes.getByLabAndAnalyte(labId, analyte.id);
          labAnalyte = data;
        }
      }

      if (labAnalyte) {
          const analyteSource = Array.isArray(labAnalyte.analytes) ? labAnalyte.analytes[0] : labAnalyte.analytes;
          const normalizeNumber = (value: any) => {
            if (value === null || value === undefined || value === '') return undefined;
            const parsed = typeof value === 'number' ? value : Number(value);
            return Number.isNaN(parsed) ? undefined : parsed;
          };

          setEditingAnalyte({
            ...analyte,
            name: labAnalyte.name || analyte.name,
            unit: labAnalyte.unit ?? analyte.unit,
            category: labAnalyte.category || analyte.category || 'General',
            referenceRange: (labAnalyte.lab_specific_reference_range ?? labAnalyte.reference_range ?? analyte.referenceRange) ?? '',
            lowCritical: normalizeNumber(labAnalyte.low_critical) ?? analyte.lowCritical,
            highCritical: normalizeNumber(labAnalyte.high_critical) ?? analyte.highCritical,
            interpretation: {
              low: labAnalyte.lab_specific_interpretation_low || labAnalyte.interpretation_low || analyte.interpretation?.low || '',
              normal: labAnalyte.lab_specific_interpretation_normal || labAnalyte.interpretation_normal || analyte.interpretation?.normal || '',
              high: labAnalyte.lab_specific_interpretation_high || labAnalyte.interpretation_high || analyte.interpretation?.high || ''
            },
            normalRangeMin: normalizeNumber(labAnalyte.normal_range_min) ?? analyte.normalRangeMin,
            normalRangeMax: normalizeNumber(labAnalyte.normal_range_max) ?? analyte.normalRangeMax,
            method: labAnalyte.lab_specific_method || labAnalyte.method || analyteSource?.method || analyte.method,
            description: labAnalyte.description || analyteSource?.description || analyte.description,
            isCritical: labAnalyte.is_critical ?? analyte.isCritical,
            ref_range_knowledge: labAnalyte.ref_range_knowledge || analyte.ref_range_knowledge,
            expected_normal_values: labAnalyte.expected_normal_values || analyte.expected_normal_values || [],
            expected_value_flag_map: labAnalyte.expected_value_flag_map || (analyteSource as any)?.expected_value_flag_map || analyte.expected_value_flag_map || {},
            // Calculated parameter fields: lab_analytes is source of truth, global analyte is fallback
            isCalculated: labAnalyte.is_calculated ?? analyteSource?.is_calculated ?? analyte.isCalculated ?? false,
            formula: labAnalyte.formula ?? analyteSource?.formula ?? analyte.formula ?? '',
            formulaVariables: labAnalyte.formula_variables ?? analyteSource?.formula_variables ?? analyte.formulaVariables ?? [],
            formulaDescription: labAnalyte.formula_description ?? analyteSource?.formula_description ?? analyte.formulaDescription ?? '',
            calculationResultType: labAnalyte.calculation_result_type ?? analyteSource?.calculation_result_type ?? analyte.calculationResultType ?? 'numeric',
            // Lab-level display name override
            display_name: labAnalyte.display_name || null,
            // Report precision: lab-level only, null = inherit (never fall back to global here)
            decimal_places: labAnalyte.decimal_places ?? null,
            min_integer_digits: labAnalyte.min_integer_digits ?? null,
            value_type: labAnalyte.value_type ?? null,
            lab_analyte_id: labAnalyte.id || analyte.lab_analyte_id,
          });
          setShowEditAnalyteModal(true);
          return;
      }
    } catch (error) {
      console.error('Failed to load lab analyte for edit:', error);
    }

    setEditingAnalyte(analyte);
    setShowEditAnalyteModal(true);
  };

  const handleEditLegacyTest = (test: Test) => {
    setEditingTest(test);
    setShowTestForm(true);
  };

  // Update handlers
  const handleUpdatePackage = async (formData: any) => {
    if (!editingPackage) return;

    try {
      // Update the package
      const { error: updateError } = await database.packages.update(editingPackage.id, {
        name: formData.name,
        description: formData.description,
        price: formData.price,
        discount_percentage: formData.discountPercentage || 0,
        category: formData.category,
        validity_days: formData.validityDays || 30,
        is_active: formData.isActive ?? true,
      });

      if (updateError) {
        console.error('Error updating package:', updateError);
        alert('Failed to update package. Please try again.');
        return;
      }

      // Update test group links - delete existing and insert new
      await supabase
        .from('package_test_groups')
        .delete()
        .eq('package_id', editingPackage.id);

      if (formData.testGroupIds && formData.testGroupIds.length > 0) {
        const packageTestGroups = formData.testGroupIds.map((tgId: string, index: number) => ({
          package_id: editingPackage.id,
          test_group_id: tgId,
          display_order: index
        }));

        await supabase
          .from('package_test_groups')
          .insert(packageTestGroups);
      }

      // Reload packages
      const { data: dbPackagesData } = await database.packages.getAll();
      if (dbPackagesData) {
        const transformedPackages = dbPackagesData.map(pkg => ({
          id: pkg.id,
          name: pkg.name,
          description: pkg.description || '',
          price: pkg.price,
          discountPercentage: pkg.discount_percentage || 0,
          category: pkg.category || 'General',
          validityDays: pkg.validity_days || 30,
          isActive: pkg.is_active ?? true,
          testGroupIds: pkg.package_test_groups?.map((ptg: any) => ptg.test_group_id) || [],
          createdDate: pkg.created_at
        }));
        setPackages(transformedPackages);
      }

      setShowPackageForm(false);
      setEditingPackage(null);
      console.log('✅ Package updated successfully');
    } catch (error) {
      console.error('Error updating package:', error);
      alert('Failed to update package. Please try again.');
    }
  };

  const handleUpdateTestGroup = async (formData: any) => {
    if (!editingTestGroup) return;

    try {
      const { data: updatedTestGroup, error } = await database.testGroups.update(editingTestGroup.id, formData);

      if (error) {
        console.error('Error updating test group:', error);
        alert('Failed to update test group. Please try again.');
        return;
      }

      if (updatedTestGroup) {
        const transformedGroup: TestGroup = {
          id: updatedTestGroup.id,
          name: updatedTestGroup.name,
          code: updatedTestGroup.code,
          category: updatedTestGroup.category,
          clinicalPurpose: updatedTestGroup.clinical_purpose,
          methodology: updatedTestGroup.methodology,
          price: updatedTestGroup.price,
          turnaroundTime: updatedTestGroup.turnaround_time,
          tat_hours: updatedTestGroup.tat_hours,
          sampleType: updatedTestGroup.sample_type,
          sampleConditionOptions: Array.isArray(updatedTestGroup.sample_condition_options) ? updatedTestGroup.sample_condition_options : [],
          defaultSampleCondition: updatedTestGroup.default_sample_condition || null,
          requiresFasting: updatedTestGroup.requires_fasting,
          isActive: updatedTestGroup.is_active,
          createdDate: updatedTestGroup.created_at,
          default_ai_processing_type: updatedTestGroup.default_ai_processing_type,
          group_level_prompt: updatedTestGroup.group_level_prompt,
          testType: updatedTestGroup.test_type || 'Default',
          gender: updatedTestGroup.gender || 'Both',
          sampleColor: updatedTestGroup.sample_color || 'Red',
          barcodeSuffix: updatedTestGroup.barcode_suffix,
          lmpRequired: updatedTestGroup.lmp_required || false,
          idRequired: updatedTestGroup.id_required || false,
          consentForm: updatedTestGroup.consent_form || false,
          preCollectionGuidelines: updatedTestGroup.pre_collection_guidelines,
          flabsId: updatedTestGroup.flabs_id,
          onlyFemale: updatedTestGroup.only_female || false,
          onlyMale: updatedTestGroup.only_male || false,
          onlyBilling: updatedTestGroup.only_billing || false,
	          startFromNextPage: updatedTestGroup.start_from_next_page || false,
	          report_priority: updatedTestGroup.report_priority ?? null,
	          analytes: formData.analytes || [],
          ref_range_ai_config: updatedTestGroup.ref_range_ai_config,
          required_patient_inputs: updatedTestGroup.required_patient_inputs,
          is_outsourced: updatedTestGroup.is_outsourced,
	          default_outsourced_lab_id: updatedTestGroup.default_outsourced_lab_id,
	          default_template_style: updatedTestGroup.default_template_style || null,
	          print_options: updatedTestGroup.print_options ?? null,
		          group_interpretation: updatedTestGroup.group_interpretation || null,
		          default_report_remark: updatedTestGroup.default_report_remark || null,
		          global_test_catalog_id: updatedTestGroup.global_test_catalog_id || null,
		          analyzer_connection_id: updatedTestGroup.analyzer_connection_id || null,
		          is_section_only: updatedTestGroup.is_section_only || false,
	        };
        setTestGroups(prev => prev.map(tg => tg.id === editingTestGroup.id ? transformedGroup : tg));
        setShowTestGroupForm(false);
        setEditingTestGroup(null);
        alert('Test group updated successfully!');
      }
    } catch (error) {
      console.error('Unexpected error:', error);
      alert('Failed to update test group. Please try again.');
    }
  };

  const handleUpdateAnalyte = async (formData: any) => {
    if (!editingAnalyte) return;

    console.log('Updating analyte with data:', formData);
    try {
      const interpretationLow = formData.interpretation_low ?? formData.interpretation?.low ?? formData.interpretationLow ?? '';
      const interpretationNormal = formData.interpretation_normal ?? formData.interpretation?.normal ?? formData.interpretationNormal ?? '';
      const interpretationHigh = formData.interpretation_high ?? formData.interpretation?.high ?? formData.interpretationHigh ?? '';
      const referenceRange = formData.reference_range ?? formData.referenceRange ?? '';
      const lowCritical = formData.low_critical ?? formData.lowCritical ?? null;
      const highCritical = formData.high_critical ?? formData.highCritical ?? null;
      const normalRangeMin = formData.normal_range_min ?? formData.normalRangeMin ?? undefined;
      const normalRangeMax = formData.normal_range_max ?? formData.normalRangeMax ?? undefined;
      const isActive = formData.is_active ?? formData.isActive ?? true;
      const method = formData.method ?? undefined;
      const description = formData.description ?? undefined;
      const isCritical = formData.is_critical ?? formData.isCritical ?? false;
      const aiProcessingType = formData.ai_processing_type ?? formData.aiProcessingType ?? undefined;
      const groupAiMode = formData.group_ai_mode ?? formData.groupAiMode ?? undefined;
      const aiPromptOverride = formData.ai_prompt_override ?? formData.aiPromptOverride ?? undefined;
      const isGlobal = formData.is_global ?? formData.isGlobal ?? false;
      const toBeCopied = formData.to_be_copied ?? formData.toBeCopied ?? false;

      // Get current lab ID
      const labId = await database.getCurrentUserLabId();
      if (!labId) {
        alert('Unable to determine lab context. Please try again.');
        return;
      }

      // Update lab_analytes table (lab-specific copy) instead of global analytes
      const analyteUpdates = {
          // Update actual values in lab_analytes
          name: formData.name,
          unit: formData.unit,
          method: method,
          reference_range: referenceRange,
          low_critical: lowCritical,
          high_critical: highCritical,
          interpretation_low: interpretationLow,
          interpretation_normal: interpretationNormal,
          interpretation_high: interpretationHigh,
          category: formData.category,
          is_active: isActive,
          // Set lab_specific_* fields to mark customization (prevents global sync overwrite)
          lab_specific_name: formData.name,
          lab_specific_unit: formData.unit,
          lab_specific_method: method,
          lab_specific_reference_range: referenceRange,
          lab_specific_interpretation_low: interpretationLow,
          lab_specific_interpretation_normal: interpretationNormal,
          lab_specific_interpretation_high: interpretationHigh,
          ref_range_knowledge: formData.ref_range_knowledge,
          // Value type, code, description
          value_type: formData.value_type || formData.valueType || undefined,
          code: formData.code || undefined,
          description: description,
          // Dropdown options for qualitative values
          expected_normal_values: formData.expected_normal_values || [],
          // Dropdown value → flag mapping
          expected_value_flag_map: formData.expected_value_flag_map || {},
          is_calculated: formData.is_calculated ?? formData.isCalculated ?? false,
          formula: formData.formula || null,
          formula_variables: formData.formula_variables ?? formData.formulaVariables ?? [],
          formula_description: formData.formula_description ?? formData.formulaDescription ?? null,
          calculation_result_type: formData.calculation_result_type ?? formData.calculationResultType ?? 'numeric',
        };

      const { data: updatedAnalyte, error } = editingAnalyte.lab_analyte_id
        ? await database.labAnalytes.updateFieldsById(editingAnalyte.lab_analyte_id, analyteUpdates)
        : await database.labAnalytes.updateLabSpecific(
            labId,
            editingAnalyte.id, // This is the analyte_id
            analyteUpdates
          );

      if (error) {
        console.error('Error updating lab analyte:', error);
        alert('Failed to update analyte. Please try again.');
        return;
      }

      if (updatedAnalyte) {
        const transformedAnalyte = {
          id: updatedAnalyte.analyte_id || editingAnalyte.id, // Use analyte_id from lab_analytes
          lab_analyte_id: updatedAnalyte.id || editingAnalyte.lab_analyte_id,
          name: updatedAnalyte.name,
          unit: updatedAnalyte.unit,
          referenceRange: updatedAnalyte.reference_range ?? referenceRange,
          lowCritical: updatedAnalyte.low_critical ?? lowCritical,
          highCritical: updatedAnalyte.high_critical ?? highCritical,
          interpretation: {
            low: updatedAnalyte.interpretation_low ?? interpretationLow,
            normal: updatedAnalyte.interpretation_normal ?? interpretationNormal,
            high: updatedAnalyte.interpretation_high ?? interpretationHigh
          },
          category: updatedAnalyte.category,
          isActive: updatedAnalyte.is_active ?? isActive,
          createdDate: updatedAnalyte.created_at || editingAnalyte.createdDate,
          // Extended fields
          normalRangeMin: updatedAnalyte.normal_range_min ?? normalRangeMin,
          normalRangeMax: updatedAnalyte.normal_range_max ?? normalRangeMax,
          interpretationLow: updatedAnalyte.interpretation_low ?? interpretationLow,
          interpretationNormal: updatedAnalyte.interpretation_normal ?? interpretationNormal,
          interpretationHigh: updatedAnalyte.interpretation_high ?? interpretationHigh,
          method: updatedAnalyte.method ?? method,
          description: updatedAnalyte.description ?? description,
          isCritical: updatedAnalyte.is_critical ?? isCritical,
          aiProcessingType: updatedAnalyte.ai_processing_type ?? aiProcessingType,
          groupAiMode: updatedAnalyte.group_ai_mode ?? groupAiMode,
          aiPromptOverride: updatedAnalyte.ai_prompt_override ?? aiPromptOverride,
          isGlobal: updatedAnalyte.is_global ?? isGlobal,
          toBeCopied: updatedAnalyte.to_be_copied ?? toBeCopied,
          ref_range_knowledge: updatedAnalyte.ref_range_knowledge,
          expected_normal_values: updatedAnalyte.expected_normal_values || formData.expected_normal_values || [],
          expected_value_flag_map: updatedAnalyte.expected_value_flag_map || formData.expected_value_flag_map || {},
          // Calculated parameter fields (from formData since they're saved to global analytes table)
          isCalculated: formData.is_calculated ?? formData.isCalculated ?? editingAnalyte.isCalculated ?? false,
          formula: formData.formula ?? editingAnalyte.formula ?? '',
          formulaVariables: formData.formula_variables ?? formData.formulaVariables ?? editingAnalyte.formulaVariables ?? [],
          formulaDescription: formData.formula_description ?? formData.formulaDescription ?? editingAnalyte.formulaDescription ?? '',
          calculationResultType: formData.calculation_result_type ?? formData.calculationResultType ?? editingAnalyte.calculationResultType ?? 'numeric'
        };

        setAnalytes(prev => prev.map(a => a.id === editingAnalyte.id ? transformedAnalyte : a));
        setShowEditAnalyteModal(false);
        setEditingAnalyte(null);
        alert('Analyte updated successfully! (Lab-specific customization saved)');
      }
    } catch (error) {
      console.error('Unexpected error:', error);
      alert('Failed to update analyte. Please try again.');
    }
  };

  // Fetch test groups linked to an analyte and show popup
  const handleShowAnalyteGroups = async (analyte: Analyte) => {
    setAnalyteGroupsPopup({ analyte, groups: [], loading: true });
    const labId = await database.getCurrentUserLabId();
    const { data, error } = await supabase
      .from('test_group_analytes')
      .select('test_groups!inner(id, name, code, category, lab_id)')
      .eq('analyte_id', analyte.id)
      .eq('test_groups.lab_id', labId);
    if (!error && data) {
      const groups = data
        .map((r: any) => Array.isArray(r.test_groups) ? r.test_groups[0] : r.test_groups)
        .filter(Boolean);
      setAnalyteGroupsPopup({ analyte, groups, loading: false });
    } else {
      setAnalyteGroupsPopup({ analyte, groups: [], loading: false });
    }
  };

  // Handler for SimpleAnalyteEditor which already saves to lab_analytes directly.
  // Do NOT save to DB again — a second partial save strips fields like
  // value_type, expected_value_codes, default_value, formula that were just written.
  const handleSimpleEditorSave = (formData: any) => {
    if (!editingAnalyte) return;

    const transformedAnalyte = {
      ...editingAnalyte,
      lab_analyte_id: formData.lab_analyte_id ?? editingAnalyte.lab_analyte_id,
      name: formData.name,
      unit: formData.unit,
      referenceRange: formData.reference_range ?? editingAnalyte.referenceRange,
      lowCritical: formData.low_critical ?? editingAnalyte.lowCritical,
      highCritical: formData.high_critical ?? editingAnalyte.highCritical,
      interpretation: {
        low: formData.interpretation_low ?? editingAnalyte.interpretationLow,
        normal: formData.interpretation_normal ?? editingAnalyte.interpretationNormal,
        high: formData.interpretation_high ?? editingAnalyte.interpretationHigh,
      },
      category: formData.category || editingAnalyte.category || 'General',
      isActive: formData.is_active ?? editingAnalyte.isActive,
      interpretationLow: formData.interpretation_low ?? editingAnalyte.interpretationLow,
      interpretationNormal: formData.interpretation_normal ?? editingAnalyte.interpretationNormal,
      interpretationHigh: formData.interpretation_high ?? editingAnalyte.interpretationHigh,
      method: formData.method ?? editingAnalyte.method,
      description: formData.description ?? editingAnalyte.description,
      isCritical: formData.is_critical ?? editingAnalyte.isCritical,
      aiProcessingType: formData.ai_processing_type ?? editingAnalyte.aiProcessingType,
      groupAiMode: formData.group_ai_mode ?? editingAnalyte.groupAiMode,
      aiPromptOverride: formData.ai_prompt_override ?? editingAnalyte.aiPromptOverride,
      ref_range_knowledge: formData.ref_range_knowledge,
      expected_normal_values: formData.expected_normal_values || [],
      expected_value_flag_map: formData.expected_value_flag_map || {},
      isCalculated: formData.is_calculated ?? editingAnalyte.isCalculated ?? false,
      formula: formData.formula ?? editingAnalyte.formula ?? '',
      formulaVariables: formData.formula_variables ?? editingAnalyte.formulaVariables ?? [],
      formulaDescription: formData.formula_description ?? editingAnalyte.formulaDescription ?? '',
      calculationResultType: formData.calculation_result_type ?? editingAnalyte.calculationResultType ?? 'numeric',
    };

    setAnalytes(prev => prev.map(a => a.id === editingAnalyte.id ? transformedAnalyte : a));
    setShowEditAnalyteModal(false);
    setEditingAnalyte(null);
  };

  const handleUpdateTest = (formData: any) => {
    if (!editingTest) return;

    const updatedTest = {
      ...editingTest,
      name: formData.name,
      category: formData.category,
      method: formData.method,
      sampleType: formData.sampleType,
      price: parseFloat(formData.price),
      turnaroundTime: formData.turnaroundTime,
      referenceRange: formData.referenceRange,
      units: formData.units,
      description: formData.description,
      isActive: formData.isActive,
      requiresFasting: formData.requiresFasting,
      criticalValues: formData.criticalValues,
      interpretation: formData.interpretation,
    };

    setTests(prev => prev.map(t => t.id === editingTest.id ? updatedTest : t));
    setShowTestForm(false);
    setEditingTest(null);
  };

  // Close handlers
  const handleClosePackageForm = () => {
    setShowPackageForm(false);
    setEditingPackage(null);
  };

  const handleCloseTestGroupForm = () => {
    setShowTestGroupForm(false);
    setEditingTestGroup(null);
  };

  const handleCloseAnalyteForm = () => {
    setShowAnalyteForm(false);
    setEditingAnalyte(null);
  };

  const handleCloseTestForm = () => {
    setShowTestForm(false);
    setEditingTest(null);
  };

  const handleCloseAnalyteModal = () => {
    setShowEditAnalyteModal(false);
    setEditingAnalyte(null);
  };

  // Sync test groups and analytes from global catalog
  const handleSyncFromGlobal = async (skipConfirm = false) => {
    if (syncing) return;
    if (!skipConfirm) { openDangerModal('sync'); return; }

    setSyncing(true);
    setSyncMode('sync');
    setSyncStatus('Initializing sync...');
    setError(null);

    try {
      setSyncStatus('Connecting to lab...');
      const labId = await database.getCurrentUserLabId();
      if (!labId) {
        setError('Unable to determine lab context');
        setSyncing(false);
        setSyncMode(null);
        return;
      }

      console.log('🔄 Syncing from global catalog for lab:', labId);
      setSyncStatus('Syncing from global catalog...');

      // Call the onboarding-lab edge function
      const { data, error: fnError } = await supabase.functions.invoke('onboarding-lab', {
        body: { lab_id: labId, mode: 'sync' }
      });

      if (fnError) {
        console.error('Edge function error:', fnError);
        setError(`Sync failed: ${fnError.message}`);
        setSyncing(false);
        setSyncMode(null);
        return;
      }

      console.log('✅ Sync response:', data);
      const syncDiagnostics = data?.syncDiagnostics;
      if (syncDiagnostics) {
        console.group('[Test Sync] Global catalog sync diagnostics');
        console.log('[Test Sync] Stats:', data?.stats || {});
        if (syncDiagnostics.skippedTests?.length) {
          console.warn(`[Test Sync] Skipped ${syncDiagnostics.skippedTests.length} global test(s)`);
          console.table(syncDiagnostics.skippedTests);
        }
        if (syncDiagnostics.createFailures?.length) {
          console.error(`[Test Sync] Failed to create ${syncDiagnostics.createFailures.length} chunk(s)`);
          console.table(syncDiagnostics.createFailures);
        }
        if (syncDiagnostics.createCandidates?.length) {
          console.log(`[Test Sync] Create candidates: ${syncDiagnostics.createCandidates.length}`);
          console.table(syncDiagnostics.createCandidates);
        }
        if (syncDiagnostics.createdTests?.length) {
          console.log(`[Test Sync] Created tests: ${syncDiagnostics.createdTests.length}`);
          console.table(syncDiagnostics.createdTests);
        }
        if (syncDiagnostics.existingMatches?.length) {
          console.log(`[Test Sync] Existing matches updated/not created: ${syncDiagnostics.existingMatches.length}`);
          console.table(syncDiagnostics.existingMatches);
        }
        console.groupEnd();
      }
      setSyncStatus('Reloading test groups...');

      // Reload test groups to reflect changes
      const { data: dbTestGroupsData, error: testGroupsError } = await database.testGroups.getAll();
      if (!testGroupsError && dbTestGroupsData) {
        const transformedTestGroups = (dbTestGroupsData || []).map(group => ({
          id: group.id,
          name: group.name,
          code: group.code,
          category: group.category,
          clinicalPurpose: group.clinical_purpose,
          price: group.price,
          turnaroundTime: group.turnaround_time,
          sampleType: group.sample_type,
          sampleConditionOptions: Array.isArray(group.sample_condition_options) ? group.sample_condition_options : [],
          defaultSampleCondition: group.default_sample_condition || null,
          requiresFasting: group.requires_fasting,
          isActive: group.is_active,
          createdDate: group.created_at,
          default_ai_processing_type: group.default_ai_processing_type,
          group_level_prompt: group.group_level_prompt,
          testType: group.test_type || 'Default',
          gender: group.gender || 'Both',
          sampleColor: group.sample_color || 'Red',
          barcodeSuffix: group.barcode_suffix,
          lmpRequired: group.lmp_required || false,
          idRequired: group.id_required || false,
          consentForm: group.consent_form || false,
          preCollectionGuidelines: group.pre_collection_guidelines,
          flabsId: group.flabs_id,
          onlyFemale: group.only_female || false,
          onlyMale: group.only_male || false,
          onlyBilling: group.only_billing || false,
	          startFromNextPage: group.start_from_next_page || false,
	          report_priority: group.report_priority ?? null,
	          default_template_style: group.default_template_style || null,
          print_options: group.print_options ?? null,
	          group_interpretation: group.group_interpretation || null,
	          default_report_remark: group.default_report_remark || null,
	          global_test_catalog_id: group.global_test_catalog_id || null,
	          analyzer_connection_id: group.analyzer_connection_id || null,
	          analytes: group.test_group_analytes ? group.test_group_analytes.map((tga: any) => tga.analyte_id) : [],
            analyteDisplay: group.test_group_analytes || []
        }));
        setTestGroups(transformedTestGroups);
      }

      setSyncStatus('Reloading analytes...');
      // Reload analytes
      const { data: dbAnalytesData, error: analytesError } = await database.analytes.getAll();
      if (!analytesError && dbAnalytesData) {
        const transformedAnalytes = (dbAnalytesData || []).map(analyte => ({
          id: analyte.id,
          lab_analyte_id: analyte.lab_analyte_id,
          testGroupCount: analyte.test_group_count ?? 0,
          name: analyte.name,
          unit: analyte.unit,
          referenceRange: analyte.reference_range || analyte.referenceRange,
          lowCritical: analyte.low_critical,
          highCritical: analyte.high_critical,
          interpretation: {
            low: analyte.interpretation_low || analyte.interpretation?.low || '',
            normal: analyte.interpretation_normal || analyte.interpretation?.normal || '',
            high: analyte.interpretation_high || analyte.interpretation?.high || ''
          },
          category: analyte.category,
          isActive: analyte.is_active ?? true,
          createdDate: analyte.created_at || new Date().toISOString(),
          isCalculated: analyte.is_calculated || false,
          formula: analyte.formula || '',
          formulaVariables: analyte.formula_variables || [],
          formulaDescription: analyte.formula_description || '',
          // Extended mapping
          normalRangeMin: analyte.normal_range_min ?? undefined,
          normalRangeMax: analyte.normal_range_max ?? undefined,
          interpretationLow: analyte.interpretation_low,
          interpretationNormal: analyte.interpretation_normal,
          interpretationHigh: analyte.interpretation_high,
          method: analyte.method || undefined,
          description: analyte.description || undefined,
          isCritical: analyte.is_critical ?? false,
          aiProcessingType: analyte.ai_processing_type || undefined,
          groupAiMode: analyte.group_ai_mode || undefined,
          aiPromptOverride: analyte.ai_prompt_override || undefined,
          isGlobal: analyte.is_global ?? false,
          toBeCopied: analyte.to_be_copied ?? false,
          ref_range_knowledge: analyte.ref_range_knowledge,
          expected_normal_values: analyte.expected_normal_values || []
        }));
        setAnalytes(transformedAnalytes);
      }

      setSyncStatus('Complete!');
      const message = data?.message || 'Sync completed successfully!';
      alert(`✅ ${message}\n\nTest groups: ${data?.testGroupsCreated || 0} created\nAnalytes: ${data?.analytesCreated || 0} synced`);

    } catch (err) {
      console.error('Sync error:', err);
      setError(`Sync failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setSyncing(false);
      setSyncMode(null);
      setSyncStatus('');
    }
  };

  // Reset test groups to defaults from global catalog (deletes all and recreates)
  const handleResetToDefaults = async (skipConfirm = false) => {
    if (syncing) return;
    if (!skipConfirm) { openDangerModal('reset'); return; }

    setSyncing(true);
    setSyncMode('reset');
    setSyncStatus('Preparing reset...');
    setError(null);

    try {
      setSyncStatus('Connecting to lab...');
      const labId = await database.getCurrentUserLabId();
      if (!labId) {
        setError('Unable to determine lab context');
        setSyncing(false);
        setSyncMode(null);
        return;
      }

      console.log('🔄 Resetting test groups to defaults for lab:', labId);
      setSyncStatus('Deleting existing test groups...');

      // Call the onboarding-lab edge function with reset mode
      const { data, error: fnError } = await supabase.functions.invoke('onboarding-lab', {
        body: { lab_id: labId, mode: 'reset' }
      });

      if (fnError) {
        console.error('Edge function error:', fnError);
        setError(`Reset failed: ${fnError.message}`);
        setSyncing(false);
        setSyncMode(null);
        return;
      }

      console.log('✅ Reset response:', data);
      setSyncStatus('Reloading test groups...');

      // Reload test groups to reflect changes
      const { data: dbTestGroupsData, error: testGroupsError } = await database.testGroups.getAll();
      if (!testGroupsError && dbTestGroupsData) {
        const transformedTestGroups = (dbTestGroupsData || []).map(group => ({
          id: group.id,
          name: group.name,
          code: group.code,
          category: group.category,
          clinicalPurpose: group.clinical_purpose,
          price: group.price,
          turnaroundTime: group.turnaround_time,
          sampleType: group.sample_type,
          sampleConditionOptions: Array.isArray(group.sample_condition_options) ? group.sample_condition_options : [],
          defaultSampleCondition: group.default_sample_condition || null,
          requiresFasting: group.requires_fasting,
          isActive: group.is_active,
          createdDate: group.created_at,
          default_ai_processing_type: group.default_ai_processing_type,
          group_level_prompt: group.group_level_prompt,
          testType: group.test_type || 'Default',
          gender: group.gender || 'Both',
          sampleColor: group.sample_color || 'Red',
          barcodeSuffix: group.barcode_suffix,
          lmpRequired: group.lmp_required || false,
          idRequired: group.id_required || false,
          consentForm: group.consent_form || false,
          preCollectionGuidelines: group.pre_collection_guidelines,
          flabsId: group.flabs_id,
          onlyFemale: group.only_female || false,
          onlyMale: group.only_male || false,
          onlyBilling: group.only_billing || false,
	          startFromNextPage: group.start_from_next_page || false,
	          report_priority: group.report_priority ?? null,
	          default_template_style: group.default_template_style || null,
          print_options: group.print_options ?? null,
	          global_test_catalog_id: group.global_test_catalog_id || null,
	          analyzer_connection_id: group.analyzer_connection_id || null,
	          analytes: group.test_group_analytes ? group.test_group_analytes.map((tga: any) => tga.analyte_id) : [],
            analyteDisplay: group.test_group_analytes || []
        }));
        setTestGroups(transformedTestGroups);
      }

      setSyncStatus('Complete!');
      const message = data?.message || 'Reset completed successfully!';
      alert(`✅ ${message}\n\nTest groups deleted: ${data?.testGroupsDeleted || 0}\nTest groups created: ${data?.testGroupsCreated || 0}\nDuplicates removed: ${data?.duplicatesRemoved || 0}\nOrphan lab_analytes deleted: ${data?.orphanLabAnalytesDeleted || 0}\nOrphan lab_templates deleted: ${data?.orphanLabTemplatesDeleted || 0}`);

    } catch (err) {
      console.error('Reset error:', err);
      setError(`Reset failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setSyncing(false);
      setSyncMode(null);
      setSyncStatus('');
    }
  };

  const handleDeleteTestGroup = async (group: TestGroup) => {
    if (!window.confirm(`Are you sure you want to delete test group "${group.name}"? If linked with orders, it will be hidden (set inactive).`)) return;

    try {
      const { error } = await database.testGroups.delete(group.id);
      if (error) throw error;
      setTestGroups(prev => prev.filter(g => g.id !== group.id));
    } catch (e: any) {
      console.warn("Hard delete failed, trying soft hide (is_active=false):", e);
      try {
        const { error: hideError } = await database.testGroups.update(group.id, {
          isActive: false,
        });
        if (hideError) throw hideError;

        setTestGroups(prev => prev.filter(g => g.id !== group.id));
        if (showInactiveTestGroups) {
          setInactiveTestGroups(prev => [{ ...group, isActive: false }, ...prev]);
        }
        alert('Test group is used in existing orders. It was hidden by setting Is Active = false.');
      } catch (hideErr: any) {
        console.error("Soft hide failed", hideErr);
        alert("Failed to delete/hide test group. It may be used in existing orders.");
      }
    }
  };

  const handleReactivateTestGroup = async (group: TestGroup) => {
    try {
      const { error } = await supabase
        .from('test_groups')
        .update({ is_active: true, updated_at: new Date().toISOString() })
        .eq('id', group.id);
      if (error) throw error;

      setInactiveTestGroups(prev => prev.filter(g => g.id !== group.id));
      setTestGroups(prev => [{ ...group, isActive: true }, ...prev]);
    } catch (e: any) {
      console.error("Reactivate test group failed", e);
      alert("Failed to reactivate test group.");
    }
  };

  const handleLoadInactiveTestGroups = async () => {
    if (inactiveTestGroups.length > 0) return;
    try {
      setLoadingInactiveTestGroups(true);
      const labId = await database.getCurrentUserLabId();
      if (!labId) return;

      const { data, error } = await supabase
        .from('test_groups')
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
          group_interpretation,
          default_report_remark,
          global_test_catalog_id,
          analyzer_connection_id,
          is_section_only,
          test_group_analytes(analyte_id, sort_order, section_heading, is_visible, report_display_options)
        `)
        .eq('lab_id', labId)
        .eq('is_active', false)
        .order('name');

      if (error) throw error;
      setInactiveTestGroups((data || []).map(transformTestGroupRow));
    } catch (e: any) {
      console.error("Load inactive test groups failed", e);
    } finally {
      setLoadingInactiveTestGroups(false);
    }
  };

  const handleDeleteAnalyte = async (analyte: Analyte) => {
    if ((analyte.testGroupCount ?? 0) > 0) {
      alert(`This analyte is still attached to ${analyte.testGroupCount} test group(s). Remove those links first, or deactivate it instead.`);
      return;
    }
    if (!window.confirm(`Are you sure you want to delete/hide analyte "${analyte.name}"?`)) return;

    try {
      const labId = await database.getCurrentUserLabId();
      if (!labId) return;

      const { error } = await database.labAnalytes.updateLabSpecific(labId, analyte.id, { visible: false });
      if (error) throw error;

      setAnalytes(prev => prev.filter(a => a.id !== analyte.id));
    } catch (e: any) {
      console.error("Hide failed", e);
      alert("Failed to delete analyte.");
    }
  };

  const handleDeactivateAnalyte = async (analyte: Analyte) => {
    if (!analyte.lab_analyte_id) return;
    try {
      const { error } = await database.labAnalytes.updateById(analyte.lab_analyte_id, { is_active: false });
      if (error) throw error;
      setAnalytes(prev => prev.filter(a => a.lab_analyte_id !== analyte.lab_analyte_id));
      if (showInactiveAnalytes) {
        setInactiveAnalytes(prev => [{ ...analyte, isActive: false }, ...prev]);
      }
    } catch (e: any) {
      console.error("Deactivate failed", e);
      alert("Failed to deactivate analyte.");
    }
  };

  const handleReactivateAnalyte = async (analyte: Analyte) => {
    if (!analyte.lab_analyte_id) return;
    try {
      const { error } = await database.labAnalytes.updateById(analyte.lab_analyte_id, { is_active: true });
      if (error) throw error;
      setInactiveAnalytes(prev => prev.filter(a => a.lab_analyte_id !== analyte.lab_analyte_id));
      setAnalytes(prev => [{ ...analyte, isActive: true }, ...prev]);
    } catch (e: any) {
      console.error("Reactivate failed", e);
      alert("Failed to reactivate analyte.");
    }
  };

  const handleLoadInactiveAnalytes = async () => {
    if (inactiveAnalytes.length > 0) return; // already loaded
    try {
      setLoadingInactiveAnalytes(true);
      const labId = await database.getCurrentUserLabId();
      if (!labId) return;
      const { data, error } = await database.labAnalytes.getAllForLab(labId);
      if (error) throw error;
      const inactive: Analyte[] = (data || [])
        .filter((item: any) => item.is_active === false && item.visible !== false)
        .map((item: any) => {
          const a = Array.isArray(item.analytes) ? item.analytes[0] : item.analytes;
          return {
            id: a?.id || item.analyte_id,
            lab_analyte_id: item.id,
            testGroupCount: Array.isArray(item.test_group_analytes)
              ? (item.test_group_analytes[0]?.count ?? 0)
              : 0,
            name: a?.name || item.name || "Unknown",
            unit: a?.unit || item.unit || "",
            category: item.category || a?.category || "General",
            referenceRange: item.lab_specific_reference_range || a?.reference_range || "",
            lowCritical: item.low_critical,
            highCritical: item.high_critical,
            isActive: false,
          };
        });
      setInactiveAnalytes(inactive);
    } catch (e: any) {
      console.error("Load inactive failed", e);
    } finally {
      setLoadingInactiveAnalytes(false);
    }
  };

  return (
    <>
      {/* Sync/Reset Loading Modal */}
      {syncing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl p-8 max-w-md w-full mx-4 transform animate-pulse">
            {/* Header */}
            <div className="text-center mb-6">
              <div className="inline-flex items-center justify-center w-16 h-16 bg-gradient-to-br from-blue-500 to-purple-600 rounded-full mb-4">
                <RefreshCw className="h-8 w-8 text-white animate-spin" />
              </div>
              <h3 className="text-xl font-bold text-gray-900">
                {syncMode === 'reset' ? '🔄 Resetting Test Groups' : '🔄 Syncing from Global'}
              </h3>
            </div>

            {/* Progress Animation */}
            <div className="mb-6">
              <div className="flex items-center justify-center space-x-2 mb-4">
                <div className="w-3 h-3 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></div>
                <div className="w-3 h-3 bg-purple-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></div>
                <div className="w-3 h-3 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></div>
              </div>

              {/* Pulsing bar */}
              <div className="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
                <div className="h-full bg-gradient-to-r from-blue-500 via-purple-500 to-blue-500 animate-pulse rounded-full"
                  style={{ width: '100%', animation: 'pulse 1.5s ease-in-out infinite' }}></div>
              </div>
            </div>

            {/* Status Text */}
            <div className="text-center">
              <p className="text-gray-700 font-medium mb-2">{syncStatus || 'Processing...'}</p>
              <p className="text-sm text-gray-500">
                {syncMode === 'reset'
                  ? 'Deleting old data and restoring from global catalog...'
                  : 'Syncing your test groups with AI configuration...'}
              </p>
            </div>

            {/* Warning for reset mode */}
            {syncMode === 'reset' && (
              <div className="mt-6 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                <p className="text-sm text-amber-700 text-center">
                  ⚠️ This may take a moment. Please don't close this page.
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="space-y-3 max-w-7xl mx-auto">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Test Management System</h1>
            <p className="text-gray-500 text-sm">Manage analytes, test groups, and diagnostic panels</p>
          </div>
          <div className="flex space-x-2">
            <button
              onClick={async () => {
                setRefreshing(true);
                await loadData();
                setRefreshing(false);
              }}
              disabled={refreshing}
              className="flex items-center px-3 py-1.5 text-sm border border-gray-300 text-gray-600 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50"
              title="Refresh data"
            >
              <RefreshCw className={`h-4 w-4 mr-1 ${refreshing ? 'animate-spin' : ''}`} />
              Refresh
            </button>
            {isAdmin && <div className="relative" ref={dangerDropdownRef}>
              <button
                onClick={() => setShowDangerDropdown(v => !v)}
                disabled={syncing}
                className="flex items-center px-3 py-1.5 text-sm border border-orange-400 text-orange-600 rounded-lg hover:bg-orange-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                title="Admin-only dangerous catalog operations"
              >
                <ShieldAlert className="h-4 w-4 mr-1" />
                Catalog Actions
                <ChevronDown className="h-3.5 w-3.5 ml-1" />
              </button>
              {showDangerDropdown && (
                <div className="absolute right-0 mt-1 w-56 bg-white border border-gray-200 rounded-lg shadow-lg z-50 overflow-hidden">
                  <div className="px-3 py-2 bg-orange-50 border-b border-orange-100">
                    <p className="text-xs font-semibold text-orange-700 uppercase tracking-wide">Admin Only — Destructive</p>
                  </div>
                  <button
                    onClick={() => openDangerModal('sync')}
                    className="w-full flex items-center px-3 py-2.5 text-sm text-green-700 hover:bg-green-50 transition-colors text-left"
                  >
                    <RefreshCw className="h-4 w-4 mr-2 flex-shrink-0" />
                    <span>
                      <span className="font-medium block">Sync from Global</span>
                      <span className="text-xs text-gray-500">Updates AI config, adds missing tests</span>
                    </span>
                  </button>
                  <button
                    onClick={() => openDangerModal('reset')}
                    className="w-full flex items-center px-3 py-2.5 text-sm text-red-700 hover:bg-red-50 transition-colors text-left border-t border-gray-100"
                  >
                    <Trash2 className="h-4 w-4 mr-2 flex-shrink-0" />
                    <span>
                      <span className="font-medium block">Reset to Defaults</span>
                      <span className="text-xs text-gray-500">Deletes ALL tests & restores from global</span>
                    </span>
                  </button>
                </div>
              )}
            </div>}
            <button
              onClick={() => setShowAnalyteForm(true)}
              className="flex items-center px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              <Beaker className="h-4 w-4 mr-1" />
              Add Analyte
            </button>
            <button
              onClick={() => setShowAIConfigurator(true)}
              className="flex items-center px-3 py-1.5 text-sm bg-gradient-to-r from-purple-600 to-indigo-600 text-white rounded-lg hover:from-purple-700 hover:to-indigo-700 transition-all shadow-md transform hover:-translate-y-0.5"
            >
              <Brain className="h-4 w-4 mr-1" />
              AI Test Creator
            </button>
            <button
              onClick={() => setShowPackageForm(true)}
              className="flex items-center px-3 py-1.5 text-sm bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors"
            >
              <Plus className="h-4 w-4 mr-1" />
              Create Package
            </button>
            {isAdmin && (
              <button
                onClick={() => setShowTestGroupForm(true)}
                className="flex items-center px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
              >
                <Plus className="h-4 w-4 mr-1" />
                Create Test Group
              </button>
            )}
          </div>
        </div>

        {
          error && (
            <div className="mb-2 p-3 bg-red-50 border border-red-200 rounded-md flex items-center space-x-2 text-sm">
              <AlertCircle className="w-4 h-4 text-red-600" />
              <span className="text-red-700">{error}</span>
              <button
                onClick={() => setError(null)}
                className="ml-auto text-red-600 hover:text-red-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )
        }

        {/* Tab Navigation - Compact */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-1">
          <div className="flex space-x-1">
            <button
              onClick={() => setActiveTab('groups')}
              className={`flex-1 flex items-center justify-center px-3 py-2 rounded-md text-sm font-medium transition-all ${activeTab === 'groups'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
                }`}
            >
              <Layers className="h-4 w-4 mr-2" />
              Test Groups ({testGroups.length})
            </button>
            <button
              onClick={() => setActiveTab('analytes')}
              className={`flex-1 flex items-center justify-center px-3 py-2 rounded-md text-sm font-medium transition-all ${activeTab === 'analytes'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
                }`}
            >
              <Beaker className="h-4 w-4 mr-2" />
              Analytes ({analytes.length})
            </button>
            <button
              onClick={() => setActiveTab('packages')}
              className={`flex-1 flex items-center justify-center px-3 py-2 rounded-md text-sm font-medium transition-all ${activeTab === 'packages'
                ? 'bg-purple-600 text-white shadow-sm'
                : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
                }`}
            >
              <Package className="h-4 w-4 mr-2" />
              Packages ({packages.length})
            </button>
          </div>
        </div>
        {/* Stats Cards - Compact */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-3">
            <div className="flex items-center">
              <div className="bg-purple-100 p-2 rounded-lg">
                <Package className="h-5 w-5 text-purple-600" />
              </div>
              <div className="ml-3">
                <div className="text-xl font-bold text-gray-900">{packages.length}</div>
                <div className="text-xs text-gray-600">Health Packages</div>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-3">
            <div className="flex items-center">
              <div className="bg-green-100 p-2 rounded-lg">
                <Layers className="h-5 w-5 text-green-600" />
              </div>
              <div className="ml-3">
                <div className="text-xl font-bold text-gray-900">{testGroups.length}</div>
                <div className="text-xs text-gray-600">Test Groups</div>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-3">
            <div className="flex items-center">
              <div className="bg-blue-100 p-2 rounded-lg">
                <Beaker className="h-5 w-5 text-blue-600" />
              </div>
              <div className="ml-3">
                <div className="text-xl font-bold text-gray-900">{analytes.length}</div>
                <div className="text-xs text-gray-600">Analytes</div>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-3">
            <div className="flex items-center">
              <div className="bg-orange-100 p-2 rounded-lg">
                <DollarSign className="h-5 w-5 text-orange-600" />
              </div>
              <div className="ml-3">
                <div className="text-xl font-bold text-gray-900">₹{packages.length > 0 ? Math.round(packages.reduce((sum, pkg) => sum + pkg.price, 0) / packages.length) : 0}</div>
                <div className="text-xs text-gray-600">Avg Package Price</div>
              </div>
            </div>
          </div>
        </div>

        {/* Search and Filter Bar - Compact */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-3">
          <div className="flex flex-col sm:flex-row gap-2">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search tests by name or ID..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-9 pr-3 py-1.5 w-full text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
            <select
              value={selectedCategory}
              onChange={(e) => setSelectedCategory(e.target.value)}
              className="px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            >
              {categories.map(category => (
                <option key={category} value={category}>{category}</option>
              ))}
            </select>
            {activeTab === 'groups' && (
              <select
                value={outsourcedFilter}
                onChange={(e) => setOutsourcedFilter(e.target.value as 'all' | 'inhouse' | 'outsourced')}
                className="px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                <option value="all">All (In-house &amp; Outsourced)</option>
                <option value="inhouse">In-house Only</option>
                <option value="outsourced">Outsourced Only</option>
              </select>
            )}
            <button className="flex items-center px-3 py-1.5 text-sm border border-gray-300 rounded-md hover:bg-gray-50 transition-colors">
              <Filter className="h-4 w-4 mr-1" />
              More Filters
            </button>
          </div>
        </div>

        {/* Test Groups Tab */}
        {
          activeTab === 'groups' && (
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
              <div className="px-3 py-2 border-b border-gray-200 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-gray-900">
                  Test Groups ({filteredTestGroups.length})
                </h3>
                <button
                  onClick={() => {
                    const next = !showInactiveTestGroups;
                    setShowInactiveTestGroups(next);
                    if (next) handleLoadInactiveTestGroups();
                  }}
                  className={`text-xs px-2 py-1 rounded border transition-colors ${showInactiveTestGroups ? 'bg-amber-100 border-amber-400 text-amber-700' : 'bg-gray-100 border-gray-300 text-gray-600 hover:bg-gray-200'}`}
                >
                  {showInactiveTestGroups ? 'Hide Inactive' : 'Show Inactive'}
                </button>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full divide-y divide-gray-200 text-sm">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Group Details</th>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Category</th>
                      <th
                        className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase cursor-pointer select-none hover:text-blue-600"
                        onClick={() => setAnalyteSort(s => s === 'asc' ? 'desc' : s === 'desc' ? null : 'asc')}
                        title="Sort by analyte count"
                      >
                        Analytes {analyteSort === 'asc' ? '↑' : analyteSort === 'desc' ? '↓' : '↕'}
                      </th>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Price</th>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Sample</th>
                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
	                    {filteredTestGroups.map((group) => (
	                      <tr key={group.id} className="hover:bg-gray-50 transition-colors">
	                        <td className="px-3 py-2">
	                          <div>
	                            <div className="flex items-center gap-2 flex-wrap">
	                              <div className="font-medium text-gray-900 text-sm">{group.name}</div>
	                              {group.is_section_only && (
	                                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-purple-100 text-purple-800 border border-purple-200">
	                                  Section Only
	                                </span>
	                              )}
	                            </div>
	                            <div className="text-xs text-gray-500">Code: {group.code} • {group.turnaroundTime}</div>
	                          </div>
	                        </td>
                        <td className="px-3 py-2">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${getCategoryColor(group.category)}`}>
                            {group.category}
                          </span>
                        </td>
	                        <td className="px-3 py-2">
	                          <div className="text-sm font-medium text-gray-900">
	                            {group.is_section_only ? '—' : (group.analytes?.length || 0)}
	                          </div>
	                        </td>
                        <td className="px-3 py-2">
                          <div className="font-medium text-gray-900">₹{group.price || 0}</div>
                        </td>
                          <td className="px-3 py-2 text-gray-600 text-xs">
                            {group.sampleType ? (
                              <div className="flex items-center gap-2">
                                <SampleTypeIndicator sampleType={group.sampleType} size="sm" />
                                <span>{group.sampleType}</span>
                              </div>
                            ) : 'N/A'}
                          </td>
                        <td className="px-3 py-2 text-sm font-medium">
                          <button
                            onClick={() => handleViewTestGroup(group)}
                            className="text-blue-600 hover:text-blue-900 p-1 rounded"
                            title="View Test Group Details"
                          >
                            <Eye className="h-4 w-4" />
                          </button>
                          {isAdmin && (
                            <>
                              <button
                                onClick={() => handleEditTestGroup(group)}
                                className="text-gray-600 hover:text-gray-900 p-1 rounded"
                                title="Edit Test Group"
                              >
                                <Edit className="h-4 w-4" />
                              </button>
                              <button
                                onClick={() => handleDeleteTestGroup(group)}
                                className="text-red-500 hover:text-red-700 p-1 rounded"
                                title="Delete Test Group"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Inactive Test Groups Section */}
              {showInactiveTestGroups && (
                <div className="border-t border-amber-200 bg-amber-50">
                  <div className="px-3 py-2 border-b border-amber-200 flex items-center justify-between">
                    <h4 className="text-xs font-semibold text-amber-800">
                      Inactive Test Groups ({inactiveTestGroups.length})
                      <span className="ml-1 font-normal text-amber-600">-- click Reactivate to restore</span>
                    </h4>
                    {loadingInactiveTestGroups && <span className="text-xs text-amber-600">Loading...</span>}
                  </div>
                  {inactiveTestGroups.length === 0 && !loadingInactiveTestGroups ? (
                    <div className="px-3 py-4 text-xs text-amber-600 text-center">No inactive test groups found.</div>
                  ) : (
                    <table className="w-full text-xs divide-y divide-amber-100">
                      <tbody>
                        {inactiveTestGroups.map((group) => (
                          <tr key={group.id} className="opacity-60 hover:opacity-80">
                            <td className="px-3 py-2 w-2/5">
                              <span className="font-medium text-gray-700">{group.name}</span>
                              <div className="text-gray-400">Code: {group.code || 'N/A'}</div>
                            </td>
                            <td className="px-3 py-2 w-1/5">
                              <span className="px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500 text-xs">{group.category}</span>
                            </td>
                            <td className="px-3 py-2 w-1/5 text-gray-500">
                              {group.is_section_only ? 'Section only' : `${group.analytes?.length || 0} analytes`}
                            </td>
                            <td className="px-3 py-2 w-1/5 text-gray-500">{group.sampleType || 'N/A'}</td>
                            <td className="px-3 py-2 text-right">
                              <button
                                onClick={() => handleReactivateTestGroup(group)}
                                className="text-xs px-2 py-1 bg-green-100 text-green-700 border border-green-300 rounded hover:bg-green-200"
                              >
                                Reactivate
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </div>
          )
        }

        {/* Analytes Tab */}
        {
          activeTab === 'analytes' && (
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
              <div className="px-3 py-2 border-b border-gray-200 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-gray-900">
                  Analytes ({filteredAnalytes.length})
                </h3>
                <button
                  onClick={() => {
                    const next = !showInactiveAnalytes;
                    setShowInactiveAnalytes(next);
                    if (next) handleLoadInactiveAnalytes();
                  }}
                  className={`text-xs px-2 py-1 rounded border transition-colors ${showInactiveAnalytes ? 'bg-amber-100 border-amber-400 text-amber-700' : 'bg-gray-100 border-gray-300 text-gray-600 hover:bg-gray-200'}`}
                >
                  {showInactiveAnalytes ? 'Hide Inactive' : 'Show Inactive'}
                </button>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full divide-y divide-gray-200 text-sm">
	                  <thead className="bg-gray-50">
	                    <tr>
	                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Analyte Details</th>
	                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Category</th>
	                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Attached Groups</th>
	                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Reference Range</th>
	                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Critical Values</th>
	                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {filteredAnalytes.map((analyte) => (
                      <tr key={analyte.id} className="hover:bg-gray-50 transition-colors">
                        <td className="px-3 py-2">
                          <div>
                            <div className="flex items-center gap-1.5">
                              <span className="font-medium text-gray-900">{analyte.name}</span>
                              {analyte.isCalculated && (
                                <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 text-xs font-medium">
                                  <Calculator className="h-3 w-3 mr-0.5" />
                                  Calc
                                </span>
                              )}
                              <button
                                onClick={() => handleShowAnalyteGroups(analyte)}
                                className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 text-xs font-medium hover:bg-blue-100 border border-blue-200"
                                title="View linked test groups"
                              >
                                <FlaskConical className="h-3 w-3" />
                                Groups
                              </button>
                            </div>
                            <div className="text-xs text-gray-500">Unit: {analyte.unit}</div>
                            {analyte.isCalculated && analyte.formula && (
                              <div className="text-xs text-amber-600 font-mono mt-0.5">{analyte.formula}</div>
                            )}
                          </div>
                        </td>
	                        <td className="px-3 py-2">
	                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${getCategoryColor(analyte.category)}`}>
	                            {analyte.category}
	                          </span>
	                        </td>
	                        <td className="px-3 py-2">
	                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
	                            (analyte.testGroupCount ?? 0) > 0
	                              ? 'bg-amber-100 text-amber-800'
	                              : 'bg-green-100 text-green-800'
	                          }`}>
	                            {analyte.testGroupCount ?? 0}
	                          </span>
	                        </td>
	                        <td className="px-3 py-2">
	                          <div className="text-gray-900 text-xs">{analyte.referenceRange || 'N/A'}</div>
	                        </td>
                        <td className="px-3 py-2">
                          <div className="text-xs">
                            {analyte.lowCritical && <div className="text-red-600">Low: {analyte.lowCritical}</div>}
                            {analyte.highCritical && <div className="text-red-600">High: {analyte.highCritical}</div>}
                            {!analyte.lowCritical && !analyte.highCritical && <span className="text-gray-400">-</span>}
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-0.5">
                            <button
                              onClick={() => handleViewAnalyte(analyte)}
                              className="text-blue-600 hover:text-blue-900 p-1 rounded"
                              title="View Analyte Details"
                            >
                              <Eye className="h-4 w-4" />
                            </button>
                            <button
                              onClick={() => handleEditAnalyte(analyte)}
                              className="text-gray-600 hover:text-gray-900 p-1 rounded"
                              title="Edit Analyte"
                            >
                              <Edit className="h-4 w-4" />
                            </button>
                            {analyte.lab_analyte_id && (
                              <button
                                onClick={() => handleDeactivateAnalyte(analyte)}
                                className="text-amber-500 hover:text-amber-700 p-1 rounded"
                                title="Deactivate (hide from lists, can reactivate)"
                              >
                                <EyeOff className="h-4 w-4" />
                              </button>
                            )}
	                            <button
	                              onClick={() => handleDeleteAnalyte(analyte)}
	                              disabled={(analyte.testGroupCount ?? 0) > 0}
	                              className={`p-1 rounded ${
	                                (analyte.testGroupCount ?? 0) > 0
	                                  ? 'text-gray-300 cursor-not-allowed'
	                                  : 'text-red-500 hover:text-red-700'
	                              }`}
	                              title={
	                                (analyte.testGroupCount ?? 0) > 0
	                                  ? `Cannot delete: attached to ${analyte.testGroupCount} test group(s)`
	                                  : 'Delete Analyte'
	                              }
	                            >
	                              <Trash2 className="h-4 w-4" />
	                            </button>
                            {analyte.isCalculated && (
                              <button
                                onClick={() => {
                                  setDependencyAnalyte(analyte);
                                  setShowDependencyManager(true);
                                }}
                                className="text-amber-600 hover:text-amber-900 p-1 rounded"
                                title="Manage Dependencies"
                              >
                                <Link2 className="h-4 w-4" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Inactive Analytes Section */}
              {showInactiveAnalytes && (
                <div className="border-t border-amber-200 bg-amber-50">
                  <div className="px-3 py-2 border-b border-amber-200 flex items-center justify-between">
                    <h4 className="text-xs font-semibold text-amber-800">
                      Inactive Analytes ({inactiveAnalytes.length})
                      <span className="ml-1 font-normal text-amber-600">— click Reactivate to restore</span>
                    </h4>
                    {loadingInactiveAnalytes && <span className="text-xs text-amber-600">Loading...</span>}
                  </div>
                  {inactiveAnalytes.length === 0 && !loadingInactiveAnalytes ? (
                    <div className="px-3 py-4 text-xs text-amber-600 text-center">No inactive analytes found.</div>
                  ) : (
                    <table className="w-full text-xs divide-y divide-amber-100">
                      <tbody>
                        {inactiveAnalytes.map((analyte) => (
                          <tr key={analyte.lab_analyte_id} className="opacity-60 hover:opacity-80">
                            <td className="px-3 py-2 w-2/5">
                              <span className="font-medium text-gray-700">{analyte.name}</span>
                              <div className="text-gray-400">Unit: {analyte.unit}</div>
                            </td>
                            <td className="px-3 py-2 w-1/5">
                              <span className="px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500 text-xs">{analyte.category}</span>
                            </td>
                            <td className="px-3 py-2 w-1/4 text-gray-500">{analyte.referenceRange || '—'}</td>
                            <td className="px-3 py-2 text-right">
                              <button
                                onClick={() => handleReactivateAnalyte(analyte)}
                                className="text-xs px-2 py-1 bg-green-100 text-green-700 border border-green-300 rounded hover:bg-green-200"
                              >
                                Reactivate
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </div>
          )
        }

        {/* Packages Tab */}
        {
          activeTab === 'packages' && (
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
              <div className="px-3 py-2 border-b border-gray-200 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-gray-900">
                  Health Packages ({filteredPackages.length})
                </h3>
              </div>

              {filteredPackages.length === 0 ? (
                <div className="p-8 text-center text-gray-500">
                  <Package className="h-12 w-12 mx-auto mb-3 text-gray-300" />
                  <p>No health packages created yet.</p>
                  <button
                    onClick={() => setShowPackageForm(true)}
                    className="mt-3 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 text-sm"
                  >
                    Create Your First Package
                  </button>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full divide-y divide-gray-200 text-sm">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Package Details</th>
                        <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Category</th>
                        <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Tests</th>
                        <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Price</th>
                        <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                        <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                      {filteredPackages.map((pkg) => (
                        <tr key={pkg.id} className="hover:bg-gray-50 transition-colors">
                          <td className="px-3 py-2">
                            <div>
                              <div className="font-medium text-gray-900">{pkg.name}</div>
                              <div className="text-xs text-gray-500 truncate max-w-xs">{pkg.description}</div>
                            </div>
                          </td>
                          <td className="px-3 py-2">
                            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-800">
                              {pkg.category || 'General'}
                            </span>
                          </td>
                          <td className="px-3 py-2">
                            <div className="text-sm text-gray-900">{pkg.testGroupIds?.length || 0} tests</div>
                          </td>
                          <td className="px-3 py-2">
                            <div className="font-medium text-green-600">₹{pkg.price || 0}</div>
                            {pkg.discountPercentage > 0 && (
                              <div className="text-xs text-gray-500">{pkg.discountPercentage}% discount</div>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${pkg.isActive ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'
                              }`}>
                              {pkg.isActive ? 'Active' : 'Inactive'}
                            </span>
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-0.5">
                              <button
                                onClick={() => handleViewPackage(pkg)}
                                className="text-blue-600 hover:text-blue-900 p-1 rounded"
                                title="View Package Details"
                              >
                                <Eye className="h-4 w-4" />
                              </button>
                              <button
                                onClick={() => handleEditPackage(pkg)}
                                className="text-gray-600 hover:text-gray-900 p-1 rounded"
                                title="Edit Package"
                              >
                                <Edit className="h-4 w-4" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )
        }

        {/* Test Form Modal */}
        {
          showTestForm && (
            <TestForm
              onClose={handleCloseTestForm}
              onSubmit={editingTest ? handleUpdateTest : handleAddTest}
              test={editingTest}
            />
          )
        }

        {/* Analyte Form Modal */}
        {
          showAnalyteForm && (
            <AnalyteForm
              onClose={handleCloseAnalyteForm}
              onSubmit={editingAnalyte ? handleUpdateAnalyte : handleAddAnalyte}
              analyte={editingAnalyte}
	              availableAnalytes={analytes.filter(a => a.id !== undefined).map(a => ({
	                id: a.id,
	                lab_analyte_id: (a as any).lab_analyte_id || null,
	                name: a.name,
	                unit: a.unit,
	                category: a.category
              }))}
              labFlagOptions={labFlagOptions}
            />
          )
        }

        {/* Test Group Form Modal - USES ENHANCED TESTGROUPFORM */}
        {
          showTestGroupForm && (
            <TestGroupForm
              onClose={handleCloseTestGroupForm}
              onSubmit={editingTestGroup ? handleUpdateTestGroup : handleAddTestGroup}
              testGroup={editingTestGroup}
            />
          )
        }

        {/* Package Form Modal */}
        {
          showPackageForm && (
            <PackageForm
              onClose={handleClosePackageForm}
              onSubmit={editingPackage ? handleUpdatePackage : handleAddPackage}
              package={editingPackage}
            />
          )
        }

        {/* Detail Modals */}
        {
          showTestDetail && selectedTest && (
            <TestDetailModal
              test={selectedTest}
              onClose={() => setShowTestDetail(false)}
              onEdit={() => {
                setShowTestDetail(false);
                handleEditLegacyTest(selectedTest);
              }}
            />
          )
        }

        {
          showAnalyteDetail && selectedAnalyte && (
            <AnalyteDetailModal
              analyte={selectedAnalyte}
              onClose={() => setShowAnalyteDetail(false)}
              onEdit={() => {
                setShowAnalyteDetail(false);
                handleEditAnalyte(selectedAnalyte);
              }}
            />
          )
        }

        {
          showTestGroupDetail && selectedTestGroup && (
            <TestGroupDetailModal
              testGroup={selectedTestGroup}
              analytes={analytes}
              onClose={() => setShowTestGroupDetail(false)}
              onEdit={() => {
                setShowTestGroupDetail(false);
                handleEditTestGroup(selectedTestGroup);
              }}
            />
          )
        }

        {
          showPackageDetail && selectedPackage && (
            <PackageDetailModal
              package={selectedPackage}
              testGroups={testGroups}
              onClose={() => setShowPackageDetail(false)}
              onEdit={() => {
                setShowPackageDetail(false);
                handleEditPackage(selectedPackage);
              }}
            />
          )
        }

        {/* Edit Analyte Modal */}
        {
          showEditAnalyteModal && editingAnalyte && (
            <SimpleAnalyteEditor
              analyte={{
                id: editingAnalyte.id,
                lab_analyte_id: editingAnalyte.lab_analyte_id || null,
                name: editingAnalyte.name,
                unit: editingAnalyte.unit,
                category: editingAnalyte.category,
                reference_range: editingAnalyte.referenceRange || '',
                low_critical: editingAnalyte.lowCritical,
                high_critical: editingAnalyte.highCritical,
                normal_range_min: editingAnalyte.normalRangeMin,
                normal_range_max: editingAnalyte.normalRangeMax,
                interpretation_low: editingAnalyte.interpretationLow,
                interpretation_normal: editingAnalyte.interpretationNormal,
                interpretation_high: editingAnalyte.interpretationHigh,
                is_critical: editingAnalyte.isCritical,
                method: editingAnalyte.method,
                description: editingAnalyte.description,
                is_active: editingAnalyte.isActive,
                ref_range_knowledge: editingAnalyte.ref_range_knowledge,
                expected_normal_values: editingAnalyte.expected_normal_values,
                expected_value_flag_map: editingAnalyte.expected_value_flag_map,
                ai_processing_type: editingAnalyte.aiProcessingType,
                ai_prompt_override: editingAnalyte.aiPromptOverride,
                group_ai_mode: editingAnalyte.groupAiMode,
                is_global: editingAnalyte.isGlobal,
                to_be_copied: editingAnalyte.toBeCopied,
                is_calculated: editingAnalyte.isCalculated,
                formula: editingAnalyte.formula,
                formula_variables: editingAnalyte.formulaVariables,
                formula_description: editingAnalyte.formulaDescription,
                // Without this the Result Type picker always reopens on "Numeric formula"
                // and re-saving silently downgrades a text-rule analyte back to numeric.
                calculation_result_type: editingAnalyte.calculationResultType === 'text' ? 'text' : 'numeric',
                display_name: (editingAnalyte as any).display_name || null,
                value_type: (editingAnalyte as any).value_type ?? undefined,
                decimal_places: (editingAnalyte as any).decimal_places ?? null,
                min_integer_digits: (editingAnalyte as any).min_integer_digits ?? null,
              }}
              availableAnalytes={analytes
                .filter(a => a.id !== editingAnalyte.id)
                .map(a => ({
                  id: a.id,
                  lab_analyte_id: (a as any).lab_analyte_id || null,
                  name: a.name,
                  unit: a.unit || '',
                  category: a.category
                }))}
              onSave={handleSimpleEditorSave}
              onCancel={handleCloseAnalyteModal}
            />
          )
        }

        {/* Dependency Manager Modal */}
        {
          showDependencyManager && dependencyAnalyte && (
            <AnalyteDependencyManager
              analyte={{
                id: dependencyAnalyte.id,
                lab_analyte_id: dependencyAnalyte.lab_analyte_id || null,
                name: dependencyAnalyte.name,
                formula: dependencyAnalyte.formula || '',
                formulaVariables: dependencyAnalyte.formulaVariables || []
              }}
              onClose={() => {
                setShowDependencyManager(false);
                setDependencyAnalyte(null);
              }}
              onSaved={() => {
                // Refresh analytes after saving dependencies
                console.log('Dependencies saved, refreshing...');
              }}
            />
          )
        }

        {/* Analyte Linked Test Groups Popup */}
        {analyteGroupsPopup && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={() => setAnalyteGroupsPopup(null)}>
            <div className="bg-white rounded-lg shadow-xl w-full max-w-md" onClick={e => e.stopPropagation()}>
              <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-gray-900">Linked Test Groups</h3>
                  <p className="text-xs text-gray-500 mt-0.5">{analyteGroupsPopup.analyte.name}</p>
                </div>
                <button onClick={() => setAnalyteGroupsPopup(null)} className="text-gray-400 hover:text-gray-600 p-1 rounded">
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="p-4">
                {analyteGroupsPopup.loading ? (
                  <p className="text-xs text-gray-500 text-center py-4">Loading...</p>
                ) : analyteGroupsPopup.groups.length === 0 ? (
                  <div className="text-center py-4">
                    <p className="text-xs text-red-600 font-medium">No test groups linked</p>
                    <p className="text-xs text-gray-400 mt-1">This analyte can be safely deleted.</p>
                  </div>
                ) : (
                  <ul className="divide-y divide-gray-100">
                    {analyteGroupsPopup.groups.map(g => (
                      <li key={g.id} className="py-2 flex items-center justify-between">
                        <div>
                          <span className="text-sm font-medium text-gray-900">{g.name}</span>
                          {g.code && <span className="ml-1.5 text-xs text-gray-400">({g.code})</span>}
                        </div>
                        <span className={`text-xs px-2 py-0.5 rounded-full ${getCategoryColor(g.category)}`}>{g.category}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="px-4 py-3 border-t border-gray-100 flex justify-between items-center bg-gray-50 rounded-b-lg">
                <span className="text-xs text-gray-500">
                  {analyteGroupsPopup.loading ? '...' : `${analyteGroupsPopup.groups.length} group${analyteGroupsPopup.groups.length !== 1 ? 's' : ''} linked`}
                </span>
                <button onClick={() => setAnalyteGroupsPopup(null)} className="text-xs px-3 py-1.5 bg-gray-200 text-gray-700 rounded hover:bg-gray-300">
                  Close
                </button>
              </div>
            </div>
          </div>
        )}

        {/* AI Configurator Modal */}
        {showAIConfigurator && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
            <div className="bg-white rounded-xl shadow-2xl w-full max-w-5xl max-h-[90vh] overflow-hidden flex flex-col animate-in fade-in zoom-in duration-200">
              <div className="p-4 border-b border-gray-100 flex items-center justify-between bg-gray-50/50">
                <h2 className="text-lg font-semibold text-gray-800 flex items-center">
                  <Brain className="h-5 w-5 mr-2 text-purple-600" />
                  AI Test Group Creator
                </h2>
                <button
                  onClick={() => setShowAIConfigurator(false)}
                  className="text-gray-400 hover:text-gray-600 p-1 hover:bg-gray-100 rounded-full transition-colors"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-0 bg-white">
                <AITestConfigurator
                  onConfigurationGenerated={handleAIConfigurationGenerated}
                />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Danger Action Confirmation Modal */}
      {dangerModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md">
            {/* Header */}
            <div className={`flex items-center gap-3 px-5 py-4 rounded-t-xl ${dangerModal === 'reset' ? 'bg-red-50 border-b border-red-200' : 'bg-amber-50 border-b border-amber-200'}`}>
              <ShieldAlert className={`h-5 w-5 flex-shrink-0 ${dangerModal === 'reset' ? 'text-red-600' : 'text-amber-600'}`} />
              <div>
                <p className={`font-semibold ${dangerModal === 'reset' ? 'text-red-800' : 'text-amber-800'}`}>
                  {dangerModal === 'reset' ? 'Reset All Tests to Defaults' : 'Sync from Global Catalog'}
                </p>
                <p className="text-xs text-gray-500">Step {dangerStep} of 2 — Admin confirmation required</p>
              </div>
            </div>

            <div className="px-5 py-4">
              {dangerStep === 1 ? (
                <>
                  <div className={`rounded-lg p-3 mb-4 text-sm ${dangerModal === 'reset' ? 'bg-red-50 border border-red-200 text-red-800' : 'bg-amber-50 border border-amber-200 text-amber-800'}`}>
                    {dangerModal === 'reset' ? (
                      <>
                        <p className="font-semibold mb-1">⚠️ This will permanently delete ALL test groups and restore them from the global catalog.</p>
                        <ul className="list-disc list-inside space-y-0.5 text-xs mt-2">
                          <li>All custom lab-level pricing will be lost</li>
                          <li>All custom test group modifications will be lost</li>
                          <li>All analyte-level customizations will be lost</li>
                          <li>This action <strong>cannot be undone</strong></li>
                        </ul>
                      </>
                    ) : (
                      <>
                        <p className="font-semibold mb-1">This will push AI config and analyte settings from the global catalog to your lab.</p>
                        <ul className="list-disc list-inside space-y-0.5 text-xs mt-2">
                          <li>Existing test groups will have AI settings overwritten</li>
                          <li>New tests from global catalog will be added</li>
                          <li>Lab-level pricing and custom fields are preserved</li>
                        </ul>
                      </>
                    )}
                  </div>
                  <label className="flex items-start gap-2.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={dangerChecked}
                      onChange={e => setDangerChecked(e.target.checked)}
                      className="mt-0.5 h-4 w-4 accent-orange-500"
                    />
                    <span className="text-sm text-gray-700">
                      I understand the risks and want to proceed with this action
                    </span>
                  </label>
                </>
              ) : (
                <>
                  <p className="text-sm text-gray-700 mb-3">
                    Type <strong className="font-mono">{dangerModal === 'reset' ? 'RESET' : 'SYNC'}</strong> below to confirm:
                  </p>
                  <input
                    type="text"
                    value={dangerTypeInput}
                    onChange={e => setDangerTypeInput(e.target.value)}
                    placeholder={dangerModal === 'reset' ? 'Type RESET' : 'Type SYNC'}
                    autoFocus
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-orange-400"
                  />
                  <p className="text-xs text-gray-400 mt-1.5">Case-sensitive</p>
                </>
              )}
            </div>

            <div className="flex justify-end gap-2 px-5 py-3 border-t border-gray-100">
              <button
                onClick={closeDangerModal}
                className="px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              {dangerStep === 1 ? (
                <button
                  disabled={!dangerChecked}
                  onClick={() => setDangerStep(2)}
                  className="px-4 py-2 text-sm font-medium bg-orange-500 text-white rounded-lg hover:bg-orange-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Continue →
                </button>
              ) : (
                <button
                  disabled={dangerTypeInput !== (dangerModal === 'reset' ? 'RESET' : 'SYNC')}
                  onClick={() => {
                    closeDangerModal();
                    if (dangerModal === 'sync') handleSyncFromGlobal(true);
                    else handleResetToDefaults(true);
                  }}
                  className={`px-4 py-2 text-sm font-medium text-white rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${dangerModal === 'reset' ? 'bg-red-600 hover:bg-red-700' : 'bg-green-600 hover:bg-green-700'}`}
                >
                  {dangerModal === 'reset' ? 'Delete & Reset' : 'Sync Now'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default Tests;
