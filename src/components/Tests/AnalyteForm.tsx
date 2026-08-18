import React, { useState, useMemo, useRef, useEffect } from 'react';
import { X, Beaker, AlertTriangle, Settings, Brain, Calculator, Search, Plus, Trash2, ChevronDown, Flag, Sparkles, Loader2, CheckCircle, ChevronUp } from 'lucide-react';
import { generateAnalyteConfiguration, AnalyteConfigurationResponse } from '../../utils/geminiAI';

interface SourceAnalyte {
  id: string;
  lab_analyte_id?: string | null;
  name: string;
  unit: string;
  category?: string;
}

interface SelectedSourceAnalyte extends SourceAnalyte {
  variableName: string; // User-customizable slug for formula
}

interface FlagOption {
  value: string;
  label: string;
}

interface AnalyteFormProps {
  onClose: () => void;
  onSubmit: (data: any) => void;
  analyte?: Analyte | null;
  availableAnalytes?: SourceAnalyte[]; // List of analytes for formula picker
  labFlagOptions?: FlagOption[]; // Lab-level flag options for mapping
}

interface Analyte {
  id: string;
  name: string;
  unit: string;
  referenceRange: string;
  lowCritical?: string | number;
  highCritical?: string | number;
  // Snake-case fallbacks for raw DB objects
  low_critical?: string | number | null;
  high_critical?: string | number | null;
  interpretation: {
    low: string;
    normal: string;
    high: string;
  };
  category: string;
  isActive: boolean;
  createdDate: string;
  aiProcessingType?: string;
  groupAiMode?: 'group_only' | 'individual' | 'both';
  aiPromptOverride?: string;
  ref_range_knowledge?: any;
  // Calculated parameter fields
  isCalculated?: boolean;
  formula?: string;
  formulaVariables?: string[];
  formulaDescription?: string;
  calculation_result_type?: 'numeric' | 'text';
  /** camelCase shape used by the Tests page analyte list */
  calculationResultType?: 'numeric' | 'text';
  // Value type and identification
  value_type?: string;
  code?: string;
  description?: string;
  // Dropdown options for qualitative values
  expected_normal_values?: string[];
  // Map of dropdown value → flag code (e.g. {"Reactive":"A","Non-Reactive":""})
  expected_value_flag_map?: Record<string, string>;
  // Display name for PDF override
  display_name?: string | null;
}

const DEFAULT_FLAG_OPTIONS: FlagOption[] = [
  { value: '', label: 'Normal' },
  { value: 'H', label: 'High' },
  { value: 'L', label: 'Low' },
  { value: 'A', label: 'Abnormal' },
  { value: 'C', label: 'Critical' },
];

const AnalyteForm: React.FC<AnalyteFormProps> = ({ onClose, onSubmit, analyte, availableAnalytes = [], labFlagOptions }) => {
  const flagOptions = labFlagOptions && labFlagOptions.length > 0 ? labFlagOptions : DEFAULT_FLAG_OPTIONS;

  // Flag map state: { "Reactive": "A", "Non-Reactive": "" }
  const [expectedValueFlagMap, setExpectedValueFlagMap] = useState<Record<string, string>>(
    analyte?.expected_value_flag_map || {}
  );

  const [formData, setFormData] = useState({
    name: analyte?.name || '',
    unit: analyte?.unit || '',
    referenceRange: analyte?.referenceRange || '',
    lowCritical: analyte?.lowCritical ?? analyte?.low_critical ?? '',
    highCritical: analyte?.highCritical ?? analyte?.high_critical ?? '',
    category: analyte?.category || '',
    interpretationLow: analyte?.interpretation?.low || '',
    interpretationNormal: analyte?.interpretation?.normal || '',
    interpretationHigh: analyte?.interpretation?.high || '',
    isActive: analyte?.isActive ?? true,
    groupAiMode: analyte?.groupAiMode || 'individual',
    aiProcessingType: analyte?.aiProcessingType || 'ocr_report',
    aiPromptOverride: analyte?.aiPromptOverride || '',
    refRangeKnowledgeText: analyte?.ref_range_knowledge?.text_rules || '',
    // Calculated parameter fields
    isCalculated: analyte?.isCalculated || false,
    formula: analyte?.formula || '',
    formulaVariables: analyte?.formulaVariables?.join(', ') || '',
    formulaDescription: analyte?.formulaDescription || '',
    // Accept either shape — the Tests page passes camelCase, so reading only the
    // snake_case key silently reset text-rule analytes back to numeric on save.
    calculationResultType: analyte?.calculation_result_type || analyte?.calculationResultType || 'numeric',
    // Value type and identification
    value_type: analyte?.value_type || 'numeric',
    code: analyte?.code || '',
    description: analyte?.description || '',
    // Dropdown options for qualitative values
    expectedNormalValues: analyte?.expected_normal_values?.join('\n') || '',
    // Display name for PDF override
    displayName: analyte?.display_name || '',
  });

  // State for source analyte picker (calculated parameters)
  const [selectedSources, setSelectedSources] = useState<SelectedSourceAnalyte[]>([]);
  const [sourceSearchTerm, setSourceSearchTerm] = useState('');
  const [showSourcePicker, setShowSourcePicker] = useState(false);
  const formulaInputRef = useRef<HTMLInputElement>(null);
  const sourcePickerRef = useRef<HTMLDivElement>(null);

  // AI helper state
  const [showAiHelper, setShowAiHelper] = useState(false);
  const [aiPromptText, setAiPromptText] = useState('');
  const [aiCategoryHint, setAiCategoryHint] = useState('');
  const [isAiGenerating, setIsAiGenerating] = useState(false);
  const [aiSuggestion, setAiSuggestion] = useState<AnalyteConfigurationResponse | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiApplied, setAiApplied] = useState(false);

  // Generate a variable slug from analyte name
  const generateVariableSlug = (name: string): string => {
    // Common abbreviations
    const abbreviations: Record<string, string> = {
      'total cholesterol': 'TC',
      'hdl cholesterol': 'HDL',
      'ldl cholesterol': 'LDL',
      'triglycerides': 'TG',
      'hemoglobin': 'HGB',
      'hematocrit': 'HCT',
      'red blood cell': 'RBC',
      'white blood cell': 'WBC',
      'platelet': 'PLT',
      'mean corpuscular volume': 'MCV',
      'mean corpuscular hemoglobin': 'MCH',
      'albumin': 'ALB',
      'globulin': 'GLOB',
      'total protein': 'TP',
      'creatinine': 'CREAT',
      'blood urea nitrogen': 'BUN',
      'urea': 'UREA',
      'glucose': 'GLU',
      'calcium': 'CA',
      'sodium': 'NA',
      'potassium': 'K',
      'chloride': 'CL',
    };

    const lowerName = name.toLowerCase();

    // Check for common abbreviations using prefix + word-boundary matching.
    // Using .includes() would wrongly match compound names like
    // "HbA1c (Glycosylated Hemoglobin)" as HGB because it contains "hemoglobin".
    const startsWithWord = (str: string, prefix: string): boolean => {
      if (!str.startsWith(prefix)) return false;
      return str.length === prefix.length || /[\s,(]/.test(str[prefix.length]);
    };
    for (const [fullName, abbrev] of Object.entries(abbreviations)) {
      if (startsWithWord(lowerName, fullName)) {
        return abbrev;
      }
    }

    // Generate slug: remove special chars, convert to uppercase, take first 3-4 chars of each word
    const words = name.replace(/[^a-zA-Z0-9\s]/g, '').split(/\s+/);
    if (words.length === 1) {
      return words[0].substring(0, 4).toUpperCase();
    }
    return words.map(w => w.substring(0, 3)).join('').toUpperCase().substring(0, 6);
  };

  // Filter available analytes for picker
  const filteredSourceAnalytes = useMemo(() => {
    const filtered = availableAnalytes.filter(a => {
      // Exclude current analyte if editing
      if (analyte?.id && a.id === analyte.id) return false;
      // Exclude already selected
      if (selectedSources.some(s => s.id === a.id)) return false;
      // Apply search filter
      if (sourceSearchTerm) {
        const search = sourceSearchTerm.toLowerCase();
        return a.name.toLowerCase().includes(search) ||
               a.category?.toLowerCase().includes(search);
      }
      return true;
    });
    return filtered.slice(0, 15); // Limit to 15 results
  }, [availableAnalytes, selectedSources, sourceSearchTerm, analyte?.id]);

  // Close picker when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (sourcePickerRef.current && !sourcePickerRef.current.contains(e.target as Node)) {
        setShowSourcePicker(false);
      }
    };
    if (showSourcePicker) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showSourcePicker]);

  // Sync formulaVariables with selectedSources
  useEffect(() => {
    if (selectedSources.length > 0) {
      const variableNames = selectedSources.map(s => s.variableName).join(', ');
      setFormData(prev => ({ ...prev, formulaVariables: variableNames }));
    }
  }, [selectedSources]);

  // Add source analyte to selection
  const handleAddSource = (source: SourceAnalyte) => {
    const variableName = generateVariableSlug(source.name);
    // Ensure unique variable name
    let uniqueName = variableName;
    let counter = 1;
    while (selectedSources.some(s => s.variableName === uniqueName)) {
      uniqueName = `${variableName}${counter}`;
      counter++;
    }
    setSelectedSources(prev => [...prev, { ...source, variableName: uniqueName }]);
    setSourceSearchTerm('');
    setShowSourcePicker(false);
  };

  // Remove source analyte
  const handleRemoveSource = (id: string) => {
    setSelectedSources(prev => prev.filter(s => s.id !== id));
  };

  // Update variable name for a source
  const handleUpdateVariableName = (id: string, newName: string) => {
    setSelectedSources(prev => prev.map(s =>
      s.id === id ? { ...s, variableName: newName.toUpperCase().replace(/[^A-Z0-9_]/g, '') } : s
    ));
  };

  // Insert variable into formula at cursor position
  const handleInsertVariable = (variableName: string) => {
    if (formulaInputRef.current) {
      const input = formulaInputRef.current;
      const start = input.selectionStart || 0;
      const end = input.selectionEnd || 0;
      const currentFormula = formData.formula;
      const newFormula = currentFormula.substring(0, start) + variableName + currentFormula.substring(end);
      setFormData(prev => ({ ...prev, formula: newFormula }));
      // Restore focus and cursor position
      setTimeout(() => {
        input.focus();
        input.setSelectionRange(start + variableName.length, start + variableName.length);
      }, 0);
    } else {
      // Just append if no ref
      setFormData(prev => ({ ...prev, formula: prev.formula + variableName }));
    }
  };

  const categories = [
    'Hematology',
    'Biochemistry',
    'Serology',
    'Microbiology',
    'Immunology',
    'Immunohematology',
    'Blood Banking',
    'Molecular Biology',
    'Molecular Diagnostics',
    'Clinical Pathology',
    'Histopathology',
    'Cytology',
    'Toxicology',
    'Endocrinology',
    'Endocrinology/Immunology',
    'Cardiology',
    'Urinalysis',
    'General',
  ];

  const aiProcessingTypes = [
    { value: 'none', label: 'None - Manual Entry Only', description: 'No AI processing for this analyte' },
    { value: 'ocr_report', label: 'OCR Report Processing', description: 'Extract values from printed reports and instrument displays' },
    { value: 'vision_card', label: 'Vision Card Analysis', description: 'Analyze test cards and lateral flow devices' },
    { value: 'vision_color', label: 'Vision Color Analysis', description: 'Color-based analysis for strips and visual tests' },
  ];

  const groupAiModes = [
    { value: 'individual', label: 'Individual Analyte Processing', description: 'AI processes this analyte independently.' },
    { value: 'group_only', label: 'Group-Level Processing Only', description: 'AI processes this analyte only as part of a test group.' },
    { value: 'both', label: 'Both Individual & Group Processing', description: 'AI can process this analyte individually or as part of a group.' },
  ];

  const handleAiGenerate = async () => {
    const nameToUse = aiPromptText.trim() || formData.name.trim();
    if (!nameToUse) {
      setAiError('Please enter an analyte name or description.');
      return;
    }
    setIsAiGenerating(true);
    setAiError(null);
    setAiSuggestion(null);
    setAiApplied(false);
    try {
      const result = await generateAnalyteConfiguration(nameToUse, {
        description: aiPromptText.trim() !== nameToUse ? aiPromptText.trim() : undefined,
        category: aiCategoryHint || undefined,
      });
      setAiSuggestion(result);
    } catch (err) {
      setAiError(err instanceof Error ? err.message : 'AI generation failed. Please try again.');
    } finally {
      setIsAiGenerating(false);
    }
  };

  const handleAiApply = () => {
    if (!aiSuggestion) return;
    setFormData(prev => ({
      ...prev,
      name: aiSuggestion.name || prev.name,
      code: aiSuggestion.code || prev.code,
      unit: aiSuggestion.unit || prev.unit,
      referenceRange: aiSuggestion.reference_range || prev.referenceRange,
      lowCritical: aiSuggestion.low_critical ?? prev.lowCritical,
      highCritical: aiSuggestion.high_critical ?? prev.highCritical,
      interpretationLow: aiSuggestion.interpretation_low || prev.interpretationLow,
      interpretationNormal: aiSuggestion.interpretation_normal || prev.interpretationNormal,
      interpretationHigh: aiSuggestion.interpretation_high || prev.interpretationHigh,
      category: aiSuggestion.category || prev.category,
      value_type: aiSuggestion.value_type || prev.value_type,
      description: aiSuggestion.description || prev.description,
      aiProcessingType: aiSuggestion.ai_processing_type || prev.aiProcessingType,
      groupAiMode: aiSuggestion.group_ai_mode || prev.groupAiMode,
      aiPromptOverride: aiSuggestion.ai_prompt_override || prev.aiPromptOverride,
      isCalculated: aiSuggestion.is_calculated ?? prev.isCalculated,
      formula: aiSuggestion.formula ?? prev.formula,
      formulaVariables: aiSuggestion.formula_variables?.join(', ') ?? prev.formulaVariables,
      formulaDescription: aiSuggestion.formula_description ?? prev.formulaDescription,
      calculationResultType: (aiSuggestion as any).calculation_result_type ?? prev.calculationResultType,
      expectedNormalValues: aiSuggestion.expected_normal_values?.join('\n') || prev.expectedNormalValues,
    }));
    setAiApplied(true);
    setAiSuggestion(null);
    setShowAiHelper(false);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    // Use selected sources if available, otherwise parse from text
    const formulaVariables = selectedSources.length > 0
      ? selectedSources.map(s => s.variableName)
      : formData.formulaVariables
        ? formData.formulaVariables.split(',').map(v => v.trim()).filter(Boolean)
        : [];

    // Build source dependencies for immediate linking (if analytes were selected)
    const sourceDependencies = selectedSources.length > 0
      ? selectedSources.map(s => ({
          source_analyte_id: s.id,
          source_lab_analyte_id: s.lab_analyte_id || null,
          variable_name: s.variableName
        }))
      : [];

    onSubmit({
      ...formData,
      interpretation: {
        low: formData.interpretationLow,
        normal: formData.interpretationNormal,
        high: formData.interpretationHigh,
      },
      ref_range_knowledge: { text_rules: formData.refRangeKnowledgeText },
      // Formula variables from either selection or text input
      formulaVariables,
      calculation_result_type: formData.calculationResultType,
      // Include source dependencies for immediate creation
      sourceDependencies,
      // Value type and identification
      value_type: formData.value_type,
      code: formData.code || undefined,
      description: formData.description || undefined,
      // Parse expected normal values from newline-separated string
      expected_normal_values: formData.expectedNormalValues
        ? formData.expectedNormalValues.split('\n').map(v => v.trim()).filter(Boolean)
        : [],
      // Dropdown value → flag mapping
      expected_value_flag_map: expectedValueFlagMap,
      // Display name for PDF override
      display_name: formData.displayName || null,
    });
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value, type } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: type === 'checkbox' ? (e.target as HTMLInputElement).checked : value
    }));
  };

  return (
    <div className="fixed inset-0 bg-gray-600 bg-opacity-75 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <h2 className="text-xl font-semibold text-gray-900 flex items-center">
            <Beaker className="h-6 w-6 mr-2 text-blue-600" />
            {analyte ? 'Edit Analyte' : 'Add New Analyte'}
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-500 p-1 rounded"
          >
            <X className="h-6 w-6" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-6">

          {/* AI Analyte Helper */}
          <div className="border border-purple-200 rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() => { setShowAiHelper(v => !v); setAiError(null); setAiSuggestion(null); }}
              className="w-full flex items-center justify-between px-4 py-3 bg-purple-50 hover:bg-purple-100 transition-colors"
            >
              <span className="flex items-center gap-2 text-sm font-medium text-purple-800">
                <Sparkles className="h-4 w-4 text-purple-600" />
                Generate with AI
                {aiApplied && (
                  <span className="flex items-center gap-1 text-xs text-green-700 bg-green-100 px-2 py-0.5 rounded-full">
                    <CheckCircle className="h-3 w-3" /> Applied
                  </span>
                )}
              </span>
              {showAiHelper ? <ChevronUp className="h-4 w-4 text-purple-600" /> : <ChevronDown className="h-4 w-4 text-purple-600" />}
            </button>

            {showAiHelper && (
              <div className="p-4 space-y-3 bg-white">
                <p className="text-xs text-gray-500">
                  Describe the analyte and AI will fill all fields — name, unit, reference range, interpretations, AI config, and more.
                </p>

                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    Analyte name or description *
                  </label>
                  <input
                    type="text"
                    value={aiPromptText}
                    onChange={e => setAiPromptText(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), handleAiGenerate())}
                    placeholder='e.g. "Hemoglobin" or "Serum creatinine for kidney function"'
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    Category hint (optional)
                  </label>
                  <select
                    value={aiCategoryHint}
                    onChange={e => setAiCategoryHint(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500"
                  >
                    <option value="">Auto-detect</option>
                    {['Hematology','Biochemistry','Serology','Endocrinology','Coagulation','Urinalysis',
                      'Microbiology','Immunology','Molecular Biology','Lipid Profile','Liver Function',
                      'Kidney Function','Thyroid','Diabetes','Hormones','Electrolytes','Cardiac',
                      'Tumor Markers','Vitamins & Minerals','Allergy'].map(c => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </div>

                {aiError && (
                  <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-md text-xs text-red-700">
                    <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                    {aiError}
                  </div>
                )}

                {/* AI Preview */}
                {aiSuggestion && (
                  <div className="border border-purple-200 rounded-md bg-purple-50 p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-purple-800">AI Suggestion Preview</span>
                      <span className="text-xs text-purple-600 bg-purple-100 px-2 py-0.5 rounded-full">
                        {Math.round((aiSuggestion.confidence || 0) * 100)}% confidence
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-gray-700">
                      <div><span className="font-medium">Name:</span> {aiSuggestion.name}</div>
                      <div><span className="font-medium">Code:</span> {aiSuggestion.code}</div>
                      <div><span className="font-medium">Unit:</span> {aiSuggestion.unit}</div>
                      <div><span className="font-medium">Ref. Range:</span> {aiSuggestion.reference_range}</div>
                      <div><span className="font-medium">Category:</span> {aiSuggestion.category}</div>
                      <div><span className="font-medium">Value Type:</span> {aiSuggestion.value_type}</div>
                      <div><span className="font-medium">AI Processing:</span> {aiSuggestion.ai_processing_type}</div>
                      <div><span className="font-medium">Group AI Mode:</span> {aiSuggestion.group_ai_mode}</div>
                      {aiSuggestion.low_critical && <div><span className="font-medium">Critical Low:</span> {aiSuggestion.low_critical}</div>}
                      {aiSuggestion.high_critical && <div><span className="font-medium">Critical High:</span> {aiSuggestion.high_critical}</div>}
                      {aiSuggestion.expected_normal_values?.length > 0 && (
                        <div className="col-span-2"><span className="font-medium">Expected Values:</span> {aiSuggestion.expected_normal_values.join(', ')}</div>
                      )}
                    </div>
                    {aiSuggestion.reasoning && (
                      <p className="text-xs text-purple-700 italic border-t border-purple-200 pt-2">{aiSuggestion.reasoning}</p>
                    )}
                    <div className="flex gap-2 pt-1">
                      <button
                        type="button"
                        onClick={handleAiApply}
                        className="flex-1 flex items-center justify-center gap-1 px-3 py-1.5 bg-purple-600 text-white text-xs rounded-md hover:bg-purple-700 transition-colors"
                      >
                        <CheckCircle className="h-3.5 w-3.5" />
                        Apply to Form
                      </button>
                      <button
                        type="button"
                        onClick={() => setAiSuggestion(null)}
                        className="px-3 py-1.5 text-xs border border-gray-300 rounded-md hover:bg-gray-50 transition-colors text-gray-600"
                      >
                        Discard
                      </button>
                    </div>
                  </div>
                )}

                <button
                  type="button"
                  onClick={handleAiGenerate}
                  disabled={isAiGenerating}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-purple-600 text-white text-sm rounded-md hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {isAiGenerating ? (
                    <><Loader2 className="h-4 w-4 animate-spin" /> Generating...</>
                  ) : (
                    <><Sparkles className="h-4 w-4" /> Generate Configuration</>
                  )}
                </button>
              </div>
            )}
          </div>

          {/* Basic Information */}
          <div className="space-y-4">
            <h3 className="text-lg font-medium text-gray-900 flex items-center">
              <Settings className="h-5 w-5 mr-2" />
              Basic Information
            </h3>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Analyte Name *
                </label>
                <input
                  type="text"
                  name="name"
                  required
                  value={formData.name}
                  onChange={handleChange}
                  placeholder="e.g., Hemoglobin"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Display Name <span className="text-gray-400 font-normal">(PDF override, optional)</span>
                </label>
                <input
                  type="text"
                  name="displayName"
                  value={formData.displayName}
                  onChange={handleChange}
                  placeholder="e.g., Serum Cholesterol (shown in reports)"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Category *
                </label>
                <select
                  name="category"
                  required
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
                  Unit *
                </label>
                <input
                  type="text"
                  name="unit"
                  required
                  value={formData.unit}
                  onChange={handleChange}
                  placeholder="e.g., g/dL, mg/dL, /μL"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Analyte Code
                </label>
                <input
                  type="text"
                  name="code"
                  value={formData.code}
                  onChange={handleChange}
                  placeholder="e.g., HGB, GLU, WBC"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Value Type
                </label>
                <select
                  name="value_type"
                  value={formData.value_type}
                  onChange={handleChange}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                >
                  <option value="numeric">Numeric</option>
                  <option value="qualitative">Qualitative</option>
                  <option value="semi_quantitative">Semi-Quantitative</option>
                  <option value="descriptive">Descriptive</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Reference Range *
                </label>
                <input
                  type="text"
                  name="referenceRange"
                  required
                  value={formData.referenceRange}
                  onChange={handleChange}
                  placeholder="e.g., 12.0-16.0 or M: 13.5-17.5, F: 12.0-16.0"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
            </div>

            {/* Description */}
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Description
              </label>
              <textarea
                name="description"
                rows={2}
                value={formData.description}
                onChange={handleChange}
                placeholder="Brief description of this analyte, clinical significance, or notes"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>

            {/* Expected Normal Values - Dropdown Options */}
            <div className="mt-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Expected Values (Dropdown Options)
                {(formData.value_type === 'qualitative' || formData.value_type === 'semi_quantitative') && (
                  <span className="text-red-500 ml-1">*</span>
                )}
              </label>
              <textarea
                name="expectedNormalValues"
                rows={4}
                value={formData.expectedNormalValues}
                onChange={handleChange}
                placeholder={
                  formData.value_type === 'semi_quantitative'
                    ? "Enter one value per line, e.g.:\nNil\nTrace\n1+\n2+\n3+\n4+"
                    : "Enter one value per line, e.g.:\nNegative\nPositive\nReactive\nNon-Reactive"
                }
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
              <p className="text-xs text-gray-500 mt-1">
                {formData.value_type === 'qualitative' && 'For qualitative analytes: Positive/Negative, Reactive/Non-Reactive, Blood Groups (A, B, AB, O), etc.'}
                {formData.value_type === 'semi_quantitative' && 'For semi-quantitative: Nil/Trace/1+/2+/3+/4+ (urinalysis), pH levels, titer values, etc.'}
                {formData.value_type === 'numeric' && 'Optional for numeric analytes. Leave empty for free-form number entry.'}
                {formData.value_type === 'descriptive' && 'Optional for descriptive analytes. Usually left empty for free-text entry.'}
              </p>
              {formData.expectedNormalValues && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {formData.expectedNormalValues.split('\n').filter(v => v.trim()).map((val, idx) => (
                    <span key={idx} className="px-2 py-1 bg-blue-100 text-blue-800 rounded text-xs">
                      {val.trim()}
                    </span>
                  ))}
                </div>
              )}
              {/* Flag Mapping for each dropdown option */}
              {formData.expectedNormalValues && formData.expectedNormalValues.split('\n').filter(v => v.trim()).length > 0 && (
                <div className="mt-3 bg-gray-50 border border-gray-200 rounded-lg p-3">
                  <h4 className="text-sm font-medium text-gray-700 mb-2 flex items-center">
                    <Flag className="h-4 w-4 mr-1.5 text-orange-500" />
                    Flag Mapping (auto-set flag when value is selected)
                  </h4>
                  <div className="space-y-2">
                    {formData.expectedNormalValues.split('\n').filter(v => v.trim()).map((val, idx) => {
                      const trimmed = val.trim();
                      return (
                        <div key={idx} className="flex items-center gap-3">
                          <span className="text-sm text-gray-800 min-w-[140px] font-medium">{trimmed}</span>
                          <span className="text-gray-400 text-xs">&rarr;</span>
                          <select
                            value={expectedValueFlagMap[trimmed] ?? ''}
                            onChange={(e) => {
                              setExpectedValueFlagMap(prev => ({
                                ...prev,
                                [trimmed]: e.target.value
                              }));
                            }}
                            className="px-2 py-1.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                          >
                            {flagOptions.map((opt, i) => (
                              <option key={i} value={opt.value}>{opt.label}{opt.value ? ` (${opt.value})` : ''}</option>
                            ))}
                          </select>
                        </div>
                      );
                    })}
                  </div>
                  <p className="text-xs text-gray-500 mt-2">
                    When a user selects a dropdown value during result entry, the flag will auto-set to the mapped value.
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Critical Values */}
          <div className="space-y-4">
            <h3 className="text-lg font-medium text-gray-900 flex items-center">
              <AlertTriangle className="h-5 w-5 mr-2 text-red-500" />
              Critical Values
            </h3>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Low Critical Value
                </label>
                <input
                  type="text"
                  name="lowCritical"
                  value={formData.lowCritical}
                  onChange={handleChange}
                  placeholder="e.g., 7.0"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  High Critical Value
                </label>
                <input
                  type="text"
                  name="highCritical"
                  value={formData.highCritical}
                  onChange={handleChange}
                  placeholder="e.g., 20.0"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
            </div>
          </div>

          {/* Clinical Interpretation */}
          <div className="space-y-4">
            <h3 className="text-lg font-medium text-gray-900">Clinical Interpretation</h3>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Low Values Interpretation
                </label>
                <textarea
                  name="interpretationLow"
                  rows={2}
                  value={formData.interpretationLow}
                  onChange={handleChange}
                  placeholder="Clinical significance of low values"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Normal Values Interpretation
                </label>
                <textarea
                  name="interpretationNormal"
                  rows={2}
                  value={formData.interpretationNormal}
                  onChange={handleChange}
                  placeholder="Clinical significance of normal values"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  High Values Interpretation
                </label>
                <textarea
                  name="interpretationHigh"
                  rows={2}
                  value={formData.interpretationHigh}
                  onChange={handleChange}
                  placeholder="Clinical significance of high values"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
            </div>
          </div>

          {/* Settings */}
          <div className="space-y-4">
            <h3 className="text-lg font-medium text-gray-900 flex items-center">
              <Settings className="h-5 w-5 mr-2" />
              Analyte Settings
            </h3>

            <div className="space-y-3">
              <label className="flex items-center">
                <input
                  type="checkbox"
                  name="isActive"
                  checked={formData.isActive}
                  onChange={handleChange}
                  className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                />
                <span className="ml-2 text-sm text-gray-700">Analyte is active and available for use</span>
              </label>
              <label className="flex items-center">
                <input
                  type="checkbox"
                  name="isCalculated"
                  checked={formData.isCalculated}
                  onChange={handleChange}
                  className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                />
                <span className="ml-2 text-sm text-gray-700">This is a calculated parameter (value derived from formula)</span>
              </label>
            </div>
          </div>

          {/* Calculated Parameter Configuration */}
          {formData.isCalculated && (
            <div className="space-y-4 bg-amber-50 border border-amber-200 rounded-lg p-4">
              <h3 className="text-lg font-medium text-gray-900 flex items-center">
                <Calculator className="h-5 w-5 mr-2 text-amber-600" />
                Formula Configuration
              </h3>

              <div className="space-y-4">
                {/* Step 1: Select Source Analytes */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Step 1: Select Source Analytes *
                  </label>
                  <p className="text-xs text-gray-500 mb-2">
                    Choose the analytes whose values will be used in the formula
                  </p>

                  {/* Selected Sources */}
                  {selectedSources.length > 0 && (
                    <div className="mb-3 space-y-2">
                      {selectedSources.map(source => (
                        <div
                          key={source.id}
                          className="flex items-center gap-2 bg-white border border-amber-200 rounded-lg p-2"
                        >
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium text-gray-900 truncate">
                              {source.name}
                            </div>
                            <div className="text-xs text-gray-500">{source.unit} • {source.category}</div>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-gray-500">Variable:</span>
                            <input
                              type="text"
                              value={source.variableName}
                              onChange={(e) => handleUpdateVariableName(source.id, e.target.value)}
                              className="w-20 px-2 py-1 text-xs font-mono border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-amber-500 uppercase"
                              placeholder="VAR"
                            />
                            <button
                              type="button"
                              onClick={() => handleInsertVariable(source.variableName)}
                              className="px-2 py-1 text-xs bg-amber-600 text-white rounded hover:bg-amber-700"
                              title="Insert into formula"
                            >
                              + Insert
                            </button>
                            <button
                              type="button"
                              onClick={() => handleRemoveSource(source.id)}
                              className="p-1 text-red-600 hover:text-red-800"
                              title="Remove"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Add Source Analyte Picker */}
                  <div className="relative" ref={sourcePickerRef}>
                    <div
                      className="flex items-center gap-2 px-3 py-2 border border-gray-300 rounded-md bg-white cursor-pointer hover:border-amber-400"
                      onClick={() => setShowSourcePicker(!showSourcePicker)}
                    >
                      <Plus className="h-4 w-4 text-amber-600" />
                      <span className="text-sm text-gray-600">Add source analyte...</span>
                      <ChevronDown className="h-4 w-4 text-gray-400 ml-auto" />
                    </div>

                    {showSourcePicker && (
                      <div className="absolute z-10 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-64 overflow-hidden">
                        <div className="p-2 border-b border-gray-100">
                          <div className="relative">
                            <Search className="absolute left-2 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                            <input
                              type="text"
                              value={sourceSearchTerm}
                              onChange={(e) => setSourceSearchTerm(e.target.value)}
                              placeholder="Search analytes..."
                              className="w-full pl-8 pr-3 py-1.5 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-amber-500"
                              autoFocus
                            />
                          </div>
                        </div>
                        <div className="max-h-48 overflow-y-auto">
                          {availableAnalytes.length === 0 ? (
                            <div className="p-3 text-sm text-gray-500 text-center">
                              No analytes available. Save this form first, then manage dependencies.
                            </div>
                          ) : filteredSourceAnalytes.length === 0 ? (
                            <div className="p-3 text-sm text-gray-500 text-center">
                              No matching analytes found
                            </div>
                          ) : (
                            filteredSourceAnalytes.map(a => (
                              <div
                                key={a.id}
                                className="px-3 py-2 hover:bg-amber-50 cursor-pointer flex items-center justify-between"
                                onClick={() => handleAddSource(a)}
                              >
                                <div>
                                  <div className="text-sm font-medium text-gray-900">{a.name}</div>
                                  <div className="text-xs text-gray-500">{a.unit} • {a.category}</div>
                                </div>
                                <span className="text-xs text-amber-600 font-mono">
                                  {generateVariableSlug(a.name)}
                                </span>
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Manual variable input fallback */}
                  {availableAnalytes.length === 0 && (
                    <div className="mt-2">
                      <input
                        type="text"
                        name="formulaVariables"
                        value={formData.formulaVariables}
                        onChange={handleChange}
                        placeholder="e.g., TC, HDL, TG (comma-separated)"
                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent text-sm"
                      />
                      <p className="text-xs text-gray-500 mt-1">
                        Enter variable names manually. After saving, use "Manage Dependencies" to link them.
                      </p>
                    </div>
                  )}
                </div>

                {/* Step 2: Build Formula */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Result Type
                  </label>
                  <select
                    name="calculationResultType"
                    value={formData.calculationResultType}
                    onChange={handleChange}
                    className="w-full px-3 py-2 mb-3 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent"
                  >
                    <option value="numeric">Numeric formula</option>
                    <option value="text">Text rules</option>
                  </select>

                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Step 2: Build {formData.calculationResultType === 'text' ? 'Text Rules' : 'Formula'} *
                  </label>

                  {/* Quick Insert Buttons */}
                  {selectedSources.length > 0 && (
                    <div className="flex flex-wrap gap-1 mb-2">
                      {selectedSources.map(s => (
                        <button
                          key={s.id}
                          type="button"
                          onClick={() => handleInsertVariable(s.variableName)}
                          className="px-2 py-1 text-xs font-mono bg-amber-100 text-amber-800 rounded hover:bg-amber-200 border border-amber-300"
                          title={`Insert ${s.name}`}
                        >
                          {s.variableName}
                        </button>
                      ))}
                      <span className="text-xs text-gray-400 self-center ml-2">Click to insert</span>
                    </div>
                  )}

                  <input
                    ref={formulaInputRef}
                    type="text"
                    name="formula"
                    value={formData.formula}
                    onChange={handleChange}
                    placeholder={formData.calculationResultType === 'text'
                      ? '[{"when":"PLT < 150000","value":"Platelets are reduced on smear."}]'
                      : 'e.g., TC - HDL - (TG / 5)'}
                    required={formData.isCalculated}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent font-mono"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    {formData.calculationResultType === 'text'
                      ? 'Use JSON rules: [{"when":"PLT >= 150000 && PLT <= 450000","value":"Platelets are seen adequate on smear."}]'
                      : 'Operators: + - * / ( ) | Functions: sqrt(), pow(), abs(), round()'}
                  </p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Formula Description
                  </label>
                  <textarea
                    name="formulaDescription"
                    rows={2}
                    value={formData.formulaDescription}
                    onChange={handleChange}
                    placeholder="e.g., LDL Cholesterol calculated using Friedewald equation"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent"
                  />
                </div>

                {/* Formula Preview */}
                <div className="bg-white border border-amber-300 rounded-lg p-3">
                  <h4 className="text-sm font-medium text-amber-900 mb-2">Formula Preview</h4>
                  <div className="text-sm text-amber-800 font-mono bg-amber-100 p-2 rounded">
                    {formData.formula || '(No formula entered)'}
                  </div>
                  {selectedSources.length > 0 && (
                    <div className="mt-2 space-y-1">
                      <div className="text-xs text-amber-700 font-medium">Variable Mappings:</div>
                      {selectedSources.map(s => (
                        <div key={s.id} className="text-xs text-amber-600 pl-2">
                          {s.variableName} → {s.name} ({s.unit})
                        </div>
                      ))}
                    </div>
                  )}
                  {selectedSources.length === 0 && formData.formulaVariables && (
                    <div className="mt-2 text-xs text-amber-700">
                      <strong>Variables:</strong> {formData.formulaVariables.split(',').map(v => v.trim()).filter(Boolean).join(', ') || 'None'}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* AI Configuration */}
          <div className="space-y-4">
            <h3 className="text-lg font-medium text-gray-900 flex items-center">
              <Brain className="h-5 w-5 mr-2 text-purple-600" />
              AI Processing Configuration
            </h3>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  AI Processing Type
                </label>
                <select
                  name="aiProcessingType"
                  value={formData.aiProcessingType}
                  onChange={handleChange}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                >
                  {aiProcessingTypes.map(type => (
                    <option key={type.value} value={type.value}>{type.label}</option>
                  ))}
                </select>
                <div className="text-xs text-gray-500 mt-1">
                  {aiProcessingTypes.find(t => t.value === formData.aiProcessingType)?.description}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Group AI Mode
                </label>
                <select
                  name="groupAiMode"
                  value={formData.groupAiMode}
                  onChange={handleChange}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                >
                  {groupAiModes.map(mode => (
                    <option key={mode.value} value={mode.value}>{mode.label}</option>
                  ))}
                </select>
                <div className="text-xs text-gray-500 mt-1">{groupAiModes.find(m => m.value === formData.groupAiMode)?.description}</div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Custom AI Prompt (Optional)
                </label>
                <textarea
                  name="aiPromptOverride"
                  rows={4}
                  value={formData.aiPromptOverride}
                  onChange={handleChange}
                  placeholder="Enter custom prompt for AI processing. Leave empty to use default prompts."
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
                <div className="text-xs text-gray-500 mt-1">
                  Custom prompts override default AI behavior for this specific analyte
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Reference Range Rules (AI Context)
                </label>
                <textarea
                  name="refRangeKnowledgeText"
                  rows={4}
                  value={formData.refRangeKnowledgeText}
                  onChange={handleChange}
                  placeholder="Describe specific rules for this analyte (e.g., 'Adult Males: 13-17, Females: 12-16. Pregnancy T1: 11-14...'). The AI will use this knowledge to resolve ranges dynamically."
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                />
                <div className="text-xs text-gray-500 mt-1">
                  Provide specific context, conditions, or rules that the AI should follow when determining reference ranges and flags.
                </div>
              </div>

              {/* AI Configuration Preview */}
              {formData.aiProcessingType !== 'none' && (
                <div className="bg-purple-50 border border-purple-200 rounded-lg p-3">
                  <h4 className="text-sm font-medium text-purple-900 mb-2">AI Configuration Preview</h4>
                  <div className="text-xs text-purple-800 space-y-1">
                    <div><strong>Processing Type:</strong> {aiProcessingTypes.find(t => t.value === formData.aiProcessingType)?.label}</div>
                    <div><strong>Vision API Features:</strong> {
                      formData.aiProcessingType === 'ocr_report' ? 'Text Detection' :
                        formData.aiProcessingType === 'vision_card' ? 'Object Detection' :
                          formData.aiProcessingType === 'vision_color' ? 'Color Analysis' : 'None'
                    }</div>
                    <div><strong>Custom Prompt:</strong> {formData.aiPromptOverride ? 'Yes' : 'Default'}</div>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Form Actions */}
          <div className="flex items-center justify-end space-x-4 pt-6 border-t border-gray-200">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
            >
              {analyte ? 'Update Analyte' : 'Add Analyte'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default AnalyteForm;
