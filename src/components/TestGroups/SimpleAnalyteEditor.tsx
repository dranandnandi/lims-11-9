import React, { useState, useMemo, useRef, useEffect } from 'react';
import { X, Save, AlertCircle, Flag, Calculator, Link2, Search, Plus, Trash2, ChevronDown, Activity } from 'lucide-react';
import { database, supabase } from '../../utils/supabase';
import {
  dedupeDependenciesForSave,
  selectPreferredCalculatedDependencies,
} from '../../utils/calculatedDependencies';
import {
  DECIMAL_PLACES_OPTIONS,
  INTEGER_WIDTH_OPTIONS,
  normalizeDecimalPlaces,
  normalizeIntegerWidth,
} from '../../utils/resultValueFormat';

interface SourceAnalyte {
  id: string;
  lab_analyte_id?: string | null;
  name: string;
  unit: string;
  category?: string;
}

interface SelectedSourceAnalyte extends SourceAnalyte {
  variableName: string;
}

const parseRefRangeKnowledge = (value: any): any => {
  if (typeof value !== 'string') return value;

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const formatRefRangeKnowledge = (value: any): string => {
  const parsed = parseRefRangeKnowledge(value);

  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    if (typeof parsed.text_rules === 'string') return parsed.text_rules;
    return Object.keys(parsed).length > 0 ? JSON.stringify(parsed, null, 2) : '';
  }

  return typeof parsed === 'string' ? parsed : '';
};

const buildRefRangeKnowledge = (text: string, originalValue: any): any => {
  const trimmed = text.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // Plain text continues to use the legacy text_rules wrapper.
  }

  const original = parseRefRangeKnowledge(originalValue);
  if (original && typeof original === 'object' && !Array.isArray(original) && 'text_rules' in original) {
    return { ...original, text_rules: text };
  }

  return { text_rules: text };
};

interface SimpleAnalyteEditorProps {
  /** IDs of analytes currently attached to this test group — used to surface them first in the dependency picker */
  testGroupAnalyteIds?: string[];
  analyte: {
    id: string;
    name: string;
    unit: string;
    reference_range: string;
    category: string;
    method?: string;
    description?: string;
    is_critical?: boolean;
    normal_range_min?: number;
    normal_range_max?: number;
    low_critical?: string | number | null;
    high_critical?: string | number | null;
    interpretation_low?: string;
    interpretation_normal?: string;
    interpretation_high?: string;
    is_active?: boolean;
    ai_processing_type?: string;
    ai_prompt_override?: string | null;
    group_ai_mode?: string;
    is_global?: boolean;
    to_be_copied?: boolean;
    ref_range_knowledge?: any;
    expected_normal_values?: string[];
    expected_value_flag_map?: Record<string, string>;
    value_type?: string;
    /** Report precision for this lab: null = inherit lab default, 0 = integer. */
    decimal_places?: number | null;
    /** Leading-zero width: null = inherit lab default, 0 = off, 2 = "03". */
    min_integer_digits?: number | null;
    expected_value_codes?: Record<string, string>;
    default_value?: string | null;
    // Calculated parameter fields
    is_calculated?: boolean;
    formula?: string;
    formula_variables?: string[];
    formula_description?: string;
    calculation_result_type?: 'numeric' | 'text';
    // Lab-level display name override (highest priority in PDF reports)
    display_name?: string | null;
    // lab_analytes PK — used to load/save lab_analyte_interface_config
    lab_analyte_id?: string | null;
  };
  availableAnalytes?: SourceAnalyte[];
  onSave: (analyte: any) => void;
  onCancel: () => void;
}

export const SimpleAnalyteEditor: React.FC<SimpleAnalyteEditorProps> = ({
  analyte,
  availableAnalytes = [],
  testGroupAnalyteIds = [],
  onSave,
  onCancel
}) => {
  const [formData, setFormData] = useState(analyte);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [labMethodOptions, setLabMethodOptions] = useState<string[]>([]);
  const [newMethodValue, setNewMethodValue] = useState('');
  // Separate state for expected_normal_values as newline-separated text
  const [expectedNormalValuesText, setExpectedNormalValuesText] = useState(
    analyte.expected_normal_values?.join('\n') || ''
  );
  const [valueType, setValueType] = useState<string>(analyte.value_type || '');
  // Kept as a string so '' (inherit lab default) stays distinct from '0' (integer).
  const [decimalPlaces, setDecimalPlaces] = useState<string>(
    analyte.decimal_places === null || analyte.decimal_places === undefined
      ? ''
      : String(analyte.decimal_places)
  );
  const [integerWidth, setIntegerWidth] = useState<string>(
    analyte.min_integer_digits === null || analyte.min_integer_digits === undefined
      ? ''
      : String(analyte.min_integer_digits)
  );
  const [defaultValue, setDefaultValue] = useState<string>(analyte.default_value || '');
  const [refRangeKnowledgeText, setRefRangeKnowledgeText] = useState(
    formatRefRangeKnowledge(analyte.ref_range_knowledge)
  );
  // Quick codes state: array of { code, value } pairs for UI editing
  const [quickCodes, setQuickCodes] = useState<Array<{ code: string; value: string }>>(
    Object.entries(analyte.expected_value_codes || {}).map(([code, value]) => ({ code, value }))
  );
  // Formula state for calculated parameters
  const [formulaData, setFormulaData] = useState({
    is_calculated: analyte.is_calculated || false,
    formula: analyte.formula || '',
    formula_variables: analyte.formula_variables || [] as string[],
    formula_description: analyte.formula_description || '',
    calculation_result_type: analyte.calculation_result_type || 'numeric'
  });
  const [formulaVariablesText, setFormulaVariablesText] = useState(
    (analyte.formula_variables || []).join(', ')
  );
  // Source analyte picker state
  const [selectedSources, setSelectedSources] = useState<SelectedSourceAnalyte[]>([]);
  const [sourceSearchTerm, setSourceSearchTerm] = useState('');
  const [showSourcePicker, setShowSourcePicker] = useState(false);
  const formulaInputRef = useRef<HTMLInputElement>(null);
  const sourcePickerRef = useRef<HTMLDivElement>(null);
  // Flag mapping state
  const [expectedValueFlagMap, setExpectedValueFlagMap] = useState<Record<string, string>>(
    analyte.expected_value_flag_map || {}
  );

  useEffect(() => {
    setFormData(analyte);
    setExpectedNormalValuesText(analyte.expected_normal_values?.join('\n') || '');
    setValueType(analyte.value_type || '');
    setDecimalPlaces(
      analyte.decimal_places === null || analyte.decimal_places === undefined
        ? ''
        : String(analyte.decimal_places)
    );
    setIntegerWidth(
      analyte.min_integer_digits === null || analyte.min_integer_digits === undefined
        ? ''
        : String(analyte.min_integer_digits)
    );
    setDefaultValue(analyte.default_value || '');
    setRefRangeKnowledgeText(formatRefRangeKnowledge(analyte.ref_range_knowledge));
    setQuickCodes(
      Object.entries(analyte.expected_value_codes || {}).map(([code, value]) => ({ code, value }))
    );
    setFormulaData({
      is_calculated: analyte.is_calculated || false,
      formula: analyte.formula || '',
      formula_variables: analyte.formula_variables || [],
      formula_description: analyte.formula_description || '',
      calculation_result_type: analyte.calculation_result_type || 'numeric'
    });
    setFormulaVariablesText((analyte.formula_variables || []).join(', '));
    setExpectedValueFlagMap(analyte.expected_value_flag_map || {});
  }, [analyte]);
  const [labFlagOptions, setLabFlagOptions] = useState<Array<{value: string; label: string}>>([
    { value: '', label: 'Normal' },
    { value: 'H', label: 'High' },
    { value: 'L', label: 'Low' },
    { value: 'A', label: 'Abnormal' },
    { value: 'C', label: 'Critical' },
  ]);

  // Analyzer interface config state (lab_analyte_interface_config row)
  const [interfaceConfigId, setInterfaceConfigId] = useState<string | null>(null);
  const [interfaceConfig, setInterfaceConfig] = useState({
    instrument_unit: '',
    lims_unit: '',
    multiply_by: '1',
    add_offset: '0',
    dilution_factor: '1',
    dilution_mode: 'auto',
    // '' = keep the value as received; '0' = whole number.
    decimal_places: '',
    auto_verify: false,
    apply_to_ai_result_entry: false,
    apply_to_manual_result_entry: false,
    apply_to_quick_result_entry: false,
    notes: '',
  });

  React.useEffect(() => {
    const loadLabOptions = async () => {
      try {
        const labId = await database.getCurrentUserLabId();
        if (!labId) return;
        const { data } = await database.labs.getById(labId);
        const options = Array.isArray(data?.method_options) ? data.method_options : [];
        setLabMethodOptions(options);
        // Load lab flag options
        if (data?.flag_options && Array.isArray(data.flag_options)) {
          setLabFlagOptions(data.flag_options);
        }
      } catch (loadError) {
        console.error('Failed to load lab options:', loadError);
      }
    };

    const loadInterfaceConfig = async () => {
      const labAnalyteId = analyte.lab_analyte_id;
      if (!labAnalyteId) return;
      try {
        const { data } = await supabase
          .from('lab_analyte_interface_config')
          .select('id, instrument_unit, lims_unit, multiply_by, add_offset, dilution_factor, dilution_mode, decimal_places, auto_verify, apply_to_ai_result_entry, apply_to_manual_result_entry, apply_to_quick_result_entry, notes')
          .eq('lab_analyte_id', labAnalyteId)
          .maybeSingle();
        if (data) {
          setInterfaceConfigId(data.id);
          setInterfaceConfig({
            instrument_unit: data.instrument_unit || '',
            lims_unit: data.lims_unit || '',
            multiply_by: String(data.multiply_by ?? 1),
            add_offset: String(data.add_offset ?? 0),
            dilution_factor: String(data.dilution_factor ?? 1),
            dilution_mode: data.dilution_mode || 'auto',
            decimal_places: data.decimal_places == null ? '' : String(data.decimal_places),
            auto_verify: data.auto_verify ?? false,
            apply_to_ai_result_entry: data.apply_to_ai_result_entry ?? false,
            apply_to_manual_result_entry: data.apply_to_manual_result_entry ?? false,
            apply_to_quick_result_entry: data.apply_to_quick_result_entry ?? false,
            notes: data.notes || '',
          });
        }
      } catch (e) {
        console.error('Failed to load interface config:', e);
      }
    };

    loadLabOptions();
    loadInterfaceConfig();
  }, []);

  // Generate a short variable slug from analyte name
  const generateVariableSlug = (name: string): string => {
    const abbreviations: Record<string, string> = {
      'total cholesterol': 'TC', 'hdl cholesterol': 'HDL', 'ldl cholesterol': 'LDL',
      'triglycerides': 'TG', 'hemoglobin': 'HGB', 'hematocrit': 'HCT',
      'red blood cell': 'RBC', 'white blood cell': 'WBC', 'platelet': 'PLT',
      'mean corpuscular volume': 'MCV', 'mean corpuscular hemoglobin': 'MCH',
      'albumin': 'ALB', 'globulin': 'GLOB', 'total protein': 'TP',
      'creatinine': 'CREAT', 'blood urea nitrogen': 'BUN', 'urea': 'UREA',
      'glucose': 'GLU', 'calcium': 'CA', 'sodium': 'NA', 'potassium': 'K',
    };
    const lowerName = name.toLowerCase();
    // Use prefix + word-boundary matching to avoid compound names like
    // "HbA1c (Glycosylated Hemoglobin)" incorrectly matching "hemoglobin" → HGB.
    const startsWithWord = (str: string, prefix: string): boolean => {
      if (!str.startsWith(prefix)) return false;
      return str.length === prefix.length || /[\s,(]/.test(str[prefix.length]);
    };
    for (const [full, abbrev] of Object.entries(abbreviations)) {
      if (startsWithWord(lowerName, full)) return abbrev;
    }
    const words = name.replace(/[^a-zA-Z0-9\s]/g, '').split(/\s+/);
    if (words.length === 1) return words[0].substring(0, 4).toUpperCase();
    return words.map(w => w.substring(0, 3)).join('').toUpperCase().substring(0, 6);
  };

  // Pre-populate selectedSources from saved dependency rows first.
  // Falling back to formula_variables slug matching is lossy and can reopen
  // the wrong analyte (for example ALB matching "Albumin, Urine").
  useEffect(() => {
    const loadSelectedSources = async () => {
      if (!formulaData.is_calculated && !analyte.is_calculated) {
        setSelectedSources([]);
        return;
      }

      try {
        const labId = await database.getCurrentUserLabId();
        const { data: existingDeps, error: depsError } = await database.analyteDependencies.getByAnalyte(analyte.id, {
          labId: labId || undefined,
          calculatedLabAnalyteId: analyte.lab_analyte_id || null,
        });

        if (!depsError && existingDeps && existingDeps.length > 0) {
          const availableSourceIds = new Set<string>(testGroupAnalyteIds);
          for (const source of availableAnalytes) {
            if (testGroupAnalyteIds.includes(source.id) && source.lab_analyte_id) {
              availableSourceIds.add(source.lab_analyte_id);
            }
          }
          const preferredDeps = selectPreferredCalculatedDependencies(
            existingDeps as any[],
            analyte.id,
            analyte.lab_analyte_id,
            availableSourceIds,
          );
          const sources = preferredDeps.map((dep: any) => {
            const sourceLabAnalyte = dep.source_lab_analyte;
            const sourceAnalyte = dep.source_analyte;
            return {
              id: sourceLabAnalyte?.analyte_id || sourceAnalyte?.id || dep.source_analyte_id,
              lab_analyte_id: dep.source_lab_analyte_id || sourceLabAnalyte?.id || null,
              name: sourceLabAnalyte?.name || sourceAnalyte?.name || dep.variable_name,
              unit: sourceLabAnalyte?.unit || sourceAnalyte?.unit || '',
              category: sourceLabAnalyte?.category,
              variableName: dep.variable_name,
            };
          });
          setSelectedSources(sources);
          return;
        }
      } catch (e) {
        console.error('Failed to load analyte dependencies for editor:', e);
      }

      if (analyte.formula_variables && analyte.formula_variables.length > 0 && availableAnalytes.length > 0) {
        const localInGroupSet = new Set(testGroupAnalyteIds);
        const sources = analyte.formula_variables.map((varName: string) => {
          const allMatches = availableAnalytes.filter(a => generateVariableSlug(a.name) === varName);
          // Prefer in-group analytes to break ties when multiple analytes share the same slug
          const matched = allMatches.find(a => localInGroupSet.has(a.id)) || allMatches[0];
          return matched
            ? { ...matched, variableName: varName }
            : { id: `_manual_${varName}`, name: varName, unit: '', variableName: varName };
        });
        setSelectedSources(sources);
        return;
      }

      setSelectedSources([]);
    };

    loadSelectedSources();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analyte.id, analyte.lab_analyte_id, analyte.formula_variables, availableAnalytes]);

  // Sync selectedSources → formulaVariablesText
  useEffect(() => {
    if (selectedSources.length > 0) {
      setFormulaVariablesText(selectedSources.map(s => s.variableName).join(', '));
    }
  }, [selectedSources]);

  // Close picker on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (sourcePickerRef.current && !sourcePickerRef.current.contains(e.target as Node)) {
        setShowSourcePicker(false);
      }
    };
    if (showSourcePicker) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showSourcePicker]);

  const inGroupSet = useMemo(() => new Set(testGroupAnalyteIds), [testGroupAnalyteIds]);
  // Treat "in group" as an exact analyte attachment check only.
  // Name-based fallback makes duplicate same-name analytes (for example multiple
  // Albumin rows) all appear as if they belong to this test group.
  const isInGroup = (source: { id: string }) => inGroupSet.has(source.id);

  const filteredSourceAnalytes = useMemo(() => {
    const filtered = availableAnalytes.filter(a => {
      if (a.id === analyte.id) return false;
      if (selectedSources.some(s => s.id === a.id)) return false;
      if (sourceSearchTerm) {
        const q = sourceSearchTerm.toLowerCase();
        return a.name.toLowerCase().includes(q) || a.category?.toLowerCase().includes(q);
      }
      return true;
    });

    // Collapse obvious duplicate choices in the picker. This keeps the source
    // list aligned with what the user expects from test_group_analytes while
    // still preserving distinct analytes when their displayed unit differs.
    const dedupedMap = new Map<string, SourceAnalyte>();
    for (const item of filtered) {
      const key = `${item.name.trim().toLowerCase()}|${(item.unit || '').trim().toLowerCase()}`;
      const existing = dedupedMap.get(key);
      if (!existing) {
        dedupedMap.set(key, item);
        continue;
      }

      const existingScore =
        (isInGroup(existing) ? 10 : 0) +
        (existing.lab_analyte_id ? 2 : 0);
      const itemScore =
        (isInGroup(item) ? 10 : 0) +
        (item.lab_analyte_id ? 2 : 0);

      if (itemScore > existingScore) {
        dedupedMap.set(key, item);
      }
    }

    const deduped = Array.from(dedupedMap.values());
    // Sort: analytes in this test group appear first
    deduped.sort((a, b) => {
      const aIn = isInGroup(a) ? 0 : 1;
      const bIn = isInGroup(b) ? 0 : 1;
      if (aIn !== bIn) return aIn - bIn;
      return a.name.localeCompare(b.name);
    });
    return deduped.slice(0, 30);
  }, [availableAnalytes, selectedSources, sourceSearchTerm, analyte.id, inGroupSet]);

  const handleAddSource = (source: SourceAnalyte) => {
    let varName = generateVariableSlug(source.name);
    let counter = 1;
    while (selectedSources.some(s => s.variableName === varName)) {
      varName = `${generateVariableSlug(source.name)}${counter}`;
      counter++;
    }
    setSelectedSources(prev => [...prev, { ...source, variableName: varName }]);
    setSourceSearchTerm('');
    setShowSourcePicker(false);
  };

  const handleRemoveSource = (id: string) => {
    setSelectedSources(prev => prev.filter(s => s.id !== id));
  };

  const handleUpdateVariableName = (id: string, newName: string) => {
    setSelectedSources(prev => prev.map(s =>
      s.id === id ? { ...s, variableName: newName.toUpperCase().replace(/[^A-Z0-9_]/g, '') } : s
    ));
  };

  const handleInsertVariable = (variableName: string) => {
    if (formulaInputRef.current) {
      const input = formulaInputRef.current;
      const start = input.selectionStart || 0;
      const end = input.selectionEnd || 0;
      const current = formulaData.formula;
      const next = current.substring(0, start) + variableName + current.substring(end);
      setFormulaData(prev => ({ ...prev, formula: next }));
      setTimeout(() => {
        input.focus();
        input.setSelectionRange(start + variableName.length, start + variableName.length);
      }, 0);
    } else {
      setFormulaData(prev => ({ ...prev, formula: prev.formula + variableName }));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);

    try {
      // Validate required fields (e.preventDefault bypasses browser native validation)
      if (!formData.category) {
        throw new Error('Category is required. Please select a category.');
      }

      // Get current lab ID
      const labId = await database.getCurrentUserLabId();
      if (!labId) {
        throw new Error('Unable to determine lab context');
      }

      // Parse expected_normal_values from newline-separated text
      const expected_normal_values = expectedNormalValuesText
        ? expectedNormalValuesText.split('\n').map(v => v.trim()).filter(Boolean)
        : [];
      // Build expected_value_codes map from quick codes rows (filter blank entries)
      const expected_value_codes = quickCodes
        .filter(r => r.code.trim() && r.value.trim())
        .reduce<Record<string, string>>((acc, r) => { acc[r.code.trim().toUpperCase()] = r.value.trim(); return acc; }, {});

      // Resolve formula variables from picker or text input
      const parsedVars = selectedSources.length > 0
        ? selectedSources.map(s => s.variableName)
        : formulaVariablesText.split(',').map(v => v.trim()).filter(Boolean);

      // Update lab_analytes table (lab-specific) — formula fields are stored here,
      // NOT in the global analytes table, so one lab's formula change never affects others.
      const updates = {
          // Update actual values
          name: formData.name,
          unit: formData.unit,
          method: formData.method,
          reference_range: formData.reference_range,
          category: formData.category,
          low_critical: formData.low_critical,
          high_critical: formData.high_critical,
          interpretation_low: formData.interpretation_low,
          interpretation_normal: formData.interpretation_normal,
          interpretation_high: formData.interpretation_high,
          is_active: formData.is_active,
          // Lab-level display name override for PDF reports
          display_name: (formData as any).display_name?.trim() || null,
          // Set lab_specific_* fields to mark as customized (prevents global sync overwrite)
          lab_specific_name: formData.name,
          lab_specific_unit: formData.unit,
          lab_specific_method: formData.method,
          lab_specific_reference_range: formData.reference_range,
          lab_specific_interpretation_low: formData.interpretation_low,
          lab_specific_interpretation_normal: formData.interpretation_normal,
          lab_specific_interpretation_high: formData.interpretation_high,
          ref_range_knowledge: buildRefRangeKnowledge(
            refRangeKnowledgeText,
            formData.ref_range_knowledge
          ),
          // Value type (numeric, qualitative, semi_quantitative, descriptive)
          value_type: valueType || null,
          // Report precision: null = inherit lab default, 0 = round to integer
          decimal_places: normalizeDecimalPlaces(decimalPlaces),
          // Leading-zero width for fixed-width formats: null = inherit, 0 = off
          min_integer_digits: normalizeIntegerWidth(integerWidth),
          // Default pre-fill value for result entry
          default_value: defaultValue.trim() || null,
          // Dropdown options for qualitative/dropdown values
          expected_normal_values: expected_normal_values,
          // Dropdown value → flag mapping (not used for qualitative type)
          expected_value_flag_map: valueType === 'qualitative' ? {} : expectedValueFlagMap,
          // Quick code shortcuts for qualitative type
          expected_value_codes: Object.keys(expected_value_codes).length > 0 ? expected_value_codes : null,
          // AI processing config — stored at lab level so labs can override global defaults
          ai_processing_type: (formData as any).ai_processing_type || null,
          group_ai_mode: formData.group_ai_mode || null,
          ai_prompt_override: formData.ai_prompt_override ?? null,
          // Calculated parameter config — stored at lab level so edits are lab-specific
          is_calculated: formulaData.is_calculated ?? false,
          formula: formulaData.formula || null,
          formula_variables: parsedVars.length > 0 ? parsedVars : [],
          formula_description: formulaData.formula_description || null,
          calculation_result_type: formulaData.calculation_result_type || 'numeric',
        };

      const { data, error: updateError } = formData.lab_analyte_id
        ? await database.labAnalytes.updateFieldsById(formData.lab_analyte_id, updates)
        : await database.labAnalytes.updateLabSpecific(
            labId,
            formData.id, // legacy fallback by analyte_id
            updates
          );

      if (updateError) throw updateError;
      const resolvedLabAnalyteId =
        (data as any)?.id || formData.lab_analyte_id || analyte.lab_analyte_id || null;

      // Save lab_analyte_interface_config (dilution, unit conversion, auto-verify)
      const labAnalyteId = resolvedLabAnalyteId;
      if (labAnalyteId) {
        const configPayload = {
          lab_id: labId,
          lab_analyte_id: labAnalyteId,
          instrument_unit: interfaceConfig.instrument_unit || null,
          lims_unit: interfaceConfig.lims_unit || null,
          multiply_by: parseFloat(interfaceConfig.multiply_by) || 1,
          add_offset: parseFloat(interfaceConfig.add_offset) || 0,
          dilution_factor: Math.max(1, parseFloat(interfaceConfig.dilution_factor) || 1),
          dilution_mode: interfaceConfig.dilution_mode || 'auto',
          decimal_places: interfaceConfig.decimal_places === '' ? null : Number(interfaceConfig.decimal_places),
          auto_verify: interfaceConfig.auto_verify,
          apply_to_ai_result_entry: interfaceConfig.apply_to_ai_result_entry,
          apply_to_manual_result_entry: interfaceConfig.apply_to_manual_result_entry,
          apply_to_quick_result_entry: interfaceConfig.apply_to_quick_result_entry,
          notes: interfaceConfig.notes || null,
          updated_at: new Date().toISOString(),
        };
        if (interfaceConfigId) {
          await supabase
            .from('lab_analyte_interface_config')
            .update(configPayload)
            .eq('id', interfaceConfigId);
        } else {
          const { data: newConfig } = await supabase
            .from('lab_analyte_interface_config')
            .insert(configPayload)
            .select('id')
            .single();
          if (newConfig?.id) setInterfaceConfigId(newConfig.id);
        }
      }

      // Replace lab-specific analyte_dependencies on every calculated-config save.
      // When no picker sources are selected, this intentionally clears old rows so
      // recalculation falls back to the newly saved formula_variables instead.
      if (formulaData.is_calculated || analyte.is_calculated) {
        const deps = dedupeDependenciesForSave(
          selectedSources
            .filter(s => !s.id.startsWith('_manual_')) // skip manual-only entries
            .map(s => ({ source_analyte_id: s.id, source_lab_analyte_id: s.lab_analyte_id || null, variable_name: s.variableName })),
        );

        console.info('[Calculated Analyte Save] Saving formula/dependencies', {
          analyte_id: formData.id,
          lab_analyte_id: resolvedLabAnalyteId,
          formula: formulaData.formula || null,
          formula_variables: parsedVars,
          calculation_result_type: formulaData.calculation_result_type || 'numeric',
          dependencies: deps,
        });

        const { error: depError } = await database.analyteDependencies.setDependencies(formData.id, deps, labId, resolvedLabAnalyteId);
        if (depError) {
          console.error('Failed to save analyte dependencies:', depError);
        }
      }

      onSave({
        ...formData,
        lab_analyte_id: resolvedLabAnalyteId,
        value_type: valueType || null,
        decimal_places: normalizeDecimalPlaces(decimalPlaces),
        min_integer_digits: normalizeIntegerWidth(integerWidth),
        default_value: defaultValue.trim() || null,
        expected_normal_values,
        expected_value_flag_map: valueType === 'qualitative' ? {} : expectedValueFlagMap,
        expected_value_codes: Object.keys(expected_value_codes).length > 0 ? expected_value_codes : null,
        ...formulaData,
        formula_variables: parsedVars.length > 0 ? parsedVars : [],
        calculation_result_type: formulaData.calculation_result_type || 'numeric',
      });
    } catch (error) {
      console.error('Failed to update analyte:', error);
      setError(error instanceof Error ? error.message : 'Failed to update analyte');
    } finally {
      setSaving(false);
    }
  };

  const handleAddMethodOption = async () => {
    const trimmed = newMethodValue.trim();
    if (!trimmed) return;

    if (labMethodOptions.some((option) => option.toLowerCase() === trimmed.toLowerCase())) {
      setNewMethodValue('');
      return;
    }

    try {
      const labId = await database.getCurrentUserLabId();
      if (!labId) {
        throw new Error('Unable to determine lab context');
      }

      const nextOptions = [...labMethodOptions, trimmed];
      const { error: updateError } = await database.labs.update(labId, {
        method_options: nextOptions,
      });

      if (updateError) {
        throw updateError;
      }

      setLabMethodOptions(nextOptions);
      setFormData(prev => ({ ...prev, method: trimmed }));
      setNewMethodValue('');
    } catch (updateError) {
      console.error('Failed to update lab method options:', updateError);
      setError(updateError instanceof Error ? updateError.message : 'Failed to add method option');
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-6">
          <h3 className="text-xl font-semibold">Edit Analyte</h3>
          <button onClick={onCancel} className="text-gray-400 hover:text-gray-600">
            <X className="w-6 h-6" />
          </button>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-md flex items-center space-x-2">
            <AlertCircle className="w-5 h-5 text-red-600" />
            <span className="text-red-700 text-sm">{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Basic Information Section */}
          <div className="bg-gray-50 p-4 rounded-lg">
            <h4 className="text-lg font-medium text-gray-900 mb-4">Basic Information</h4>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Analyte Name *</label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder="e.g., Hemoglobin, Glucose, White Blood Cell Count"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Display Name <span className="text-xs text-gray-400 font-normal">(PDF override, optional)</span>
                </label>
                <input
                  type="text"
                  value={(formData as any).display_name || ''}
                  onChange={(e) => setFormData(prev => ({ ...prev, display_name: e.target.value } as any))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder="e.g., Serum Cholesterol (shown in report)"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Unit</label>
                <input
                  type="text"
                  value={formData.unit}
                  onChange={(e) => setFormData(prev => ({ ...prev, unit: e.target.value }))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder="e.g., g/dL, mg/dL, %, K/uL, M/uL"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Value Type</label>
                <select
                  value={valueType}
                  onChange={(e) => setValueType(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                >
                  <option value="">Default (auto-detect)</option>
                  <option value="numeric">Numeric — auto flag H/L/H*/L*</option>
                  <option value="qualitative">Qualitative — no auto flag, free text + quick codes</option>
                  <option value="semi_quantitative">Semi-Quantitative — 1+/2+/Trace patterns</option>
                  <option value="descriptive">Descriptive — free text, never flagged</option>
                </select>
                <p className="text-xs text-gray-500 mt-1">
                  <strong>Qualitative</strong>: use for Blood Group, Culture results, etc. Supports quick-code shortcuts and optional ref range display. No auto flag calculation.
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Decimal Places
                  <span className="ml-1 text-xs text-gray-400 font-normal">(how the value prints on the report)</span>
                </label>
                <select
                  value={decimalPlaces}
                  onChange={(e) => setDecimalPlaces(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                >
                  {DECIMAL_PLACES_OPTIONS.map(option => (
                    <option key={option.value || 'inherit'} value={option.value}>{option.label}</option>
                  ))}
                </select>
                <p className="text-xs text-gray-500 mt-1">
                  Pick <strong>0 — Integer</strong> for counts that should never show a decimal (Platelet, WBC).
                  <strong> Lab default</strong> follows the Decimal Places setting in Settings &rarr; Report Format.
                  Only numeric values are affected — text results like <code>&lt;0.01</code> or <code>1:160</code> always print as entered.
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Leading Zeros
                  <span className="ml-1 text-xs text-gray-400 font-normal">(fixed-width printouts)</span>
                </label>
                <select
                  value={integerWidth}
                  onChange={(e) => setIntegerWidth(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                >
                  {INTEGER_WIDTH_OPTIONS.map(option => (
                    <option key={option.value || 'inherit'} value={option.value}>{option.label}</option>
                  ))}
                </select>
                <p className="text-xs text-gray-500 mt-1">
                  Pads the whole-number part so every value has the same width, for referring
                  hospitals or exports that expect a fixed column. Affects printing only — the
                  saved value stays <code>3</code>, not <code>03</code>.
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Category *</label>
                <select
                  value={formData.category}
                  onChange={(e) => setFormData(prev => ({ ...prev, category: e.target.value }))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  required
                >
                  <option value="">Select Category</option>
                  <option value="Hematology">Hematology</option>
                  <option value="Biochemistry">Biochemistry</option>
                  <option value="Serology">Serology</option>
                  <option value="Microbiology">Microbiology</option>
                  <option value="Immunology">Immunology</option>
                  <option value="Immunohematology">Immunohematology</option>
                  <option value="Blood Banking">Blood Banking</option>
                  <option value="Molecular Diagnostics">Molecular Diagnostics</option>
                  <option value="Clinical Pathology">Clinical Pathology</option>
                  <option value="Histopathology">Histopathology</option>
                  <option value="Cytology">Cytology</option>
                  <option value="Toxicology">Toxicology</option>
                  <option value="Endocrinology">Endocrinology</option>
                  <option value="Cardiology">Cardiology</option>
                  <option value="General">General</option>
                </select>
              </div>
            </div>
          </div>

          {/* Reference Values Section */}
          <div className="bg-blue-50 p-4 rounded-lg">
            <h4 className="text-lg font-medium text-gray-900 mb-4">Reference Values</h4>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Reference Range (Text)</label>
                <textarea
                  rows={3}
                  value={formData.reference_range}
                  onChange={(e) => setFormData(prev => ({ ...prev, reference_range: e.target.value }))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-y"
                  placeholder="e.g., 12-16 (F), 14-18 (M) or Normal/Abnormal&#10;Press Enter for multiple lines"
                />
                <p className="text-xs text-gray-500 mt-1">Text description of normal ranges, including gender/age specific values</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Numeric Range (for automated validation)
                </label>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs text-gray-600 mb-1">Minimum Normal Value</label>
                    <input
                      type="number"
                      step="0.001"
                      value={formData.normal_range_min || ''}
                      onChange={(e) => setFormData(prev => ({
                        ...prev,
                        normal_range_min: e.target.value ? parseFloat(e.target.value) : undefined
                      }))}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      placeholder="e.g., 12.0"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-600 mb-1">Maximum Normal Value</label>
                    <input
                      type="number"
                      step="0.001"
                      value={formData.normal_range_max || ''}
                      onChange={(e) => setFormData(prev => ({
                        ...prev,
                        normal_range_max: e.target.value ? parseFloat(e.target.value) : undefined
                      }))}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      placeholder="e.g., 16.0"
                    />
                  </div>
                </div>
                <p className="text-xs text-gray-500 mt-1">Used for automatic flagging of abnormal results</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Critical Values (immediate notification required)
                </label>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs text-gray-600 mb-1">Low Critical Value</label>
                    <input
                      type="text"
                      value={formData.low_critical ?? ''}
                      onChange={(e) => setFormData(prev => ({
                        ...prev,
                        low_critical: e.target.value || null
                      }))}
                      className="w-full px-3 py-2 border border-red-300 rounded-md focus:ring-2 focus:ring-red-500 focus:border-transparent"
                      placeholder="e.g., 5.0 or <5 or ≤5"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-600 mb-1">High Critical Value</label>
                    <input
                      type="text"
                      value={formData.high_critical ?? ''}
                      onChange={(e) => setFormData(prev => ({
                        ...prev,
                        high_critical: e.target.value || null
                      }))}
                      className="w-full px-3 py-2 border border-red-300 rounded-md focus:ring-2 focus:ring-red-500 focus:border-transparent"
                      placeholder="e.g., 200.0 or >200 or ≥300"
                    />
                  </div>
                </div>
                <p className="text-xs text-red-600 mt-1">Values requiring immediate physician notification</p>
              </div>

              {/* Expected Values section — behaviour differs by value_type */}
              <div className="mt-4 pt-4 border-t border-blue-200">
                {valueType === 'qualitative' ? (
                  <>
                    {/* Qualitative: quick codes + optional values list */}
                    <div className="mb-3">
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Quick Codes
                        <span className="ml-1 text-xs text-gray-400 font-normal">(shorthand for fast entry)</span>
                      </label>
                      <p className="text-xs text-gray-500 mb-2">
                        Define short codes that auto-fill the full value during result entry. E.g. type "P" → "Positive". Codes are case-insensitive.
                      </p>
                      <div className="space-y-2">
                        {quickCodes.map((row, idx) => (
                          <div key={idx} className="flex items-center gap-2">
                            <input
                              type="text"
                              value={row.code}
                              onChange={e => setQuickCodes(prev => prev.map((r, i) => i === idx ? { ...r, code: e.target.value.toUpperCase() } : r))}
                              placeholder="Code"
                              maxLength={6}
                              className="w-20 px-2 py-1.5 border border-gray-300 rounded-md text-sm font-mono focus:ring-2 focus:ring-purple-400 focus:outline-none uppercase"
                            />
                            <span className="text-gray-400 text-xs">→</span>
                            <input
                              type="text"
                              value={row.value}
                              onChange={e => setQuickCodes(prev => prev.map((r, i) => i === idx ? { ...r, value: e.target.value } : r))}
                              placeholder="Full value"
                              className="flex-1 px-2 py-1.5 border border-gray-300 rounded-md text-sm focus:ring-2 focus:ring-purple-400 focus:outline-none"
                            />
                            <button
                              type="button"
                              onClick={() => setQuickCodes(prev => prev.filter((_, i) => i !== idx))}
                              className="text-red-400 hover:text-red-600 text-xs px-1"
                            >✕</button>
                          </div>
                        ))}
                        <button
                          type="button"
                          onClick={() => setQuickCodes(prev => [...prev, { code: '', value: '' }])}
                          className="mt-1 text-sm text-purple-600 hover:text-purple-800 flex items-center gap-1"
                        >
                          <Plus className="h-3.5 w-3.5" /> Add code
                        </button>
                      </div>
                    </div>

                    {/* Optional values list for autocomplete suggestions */}
                    <div className="mt-3">
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Allowed Values
                        <span className="ml-1 text-xs text-gray-400 font-normal">(optional — shown as autocomplete suggestions)</span>
                      </label>
                      <textarea
                        value={expectedNormalValuesText}
                        onChange={e => setExpectedNormalValuesText(e.target.value)}
                        rows={3}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-purple-400 focus:border-transparent"
                        placeholder="Enter one value per line, e.g.:&#10;Non-Reactive&#10;Reactive&#10;Equivocal"
                      />
                      <p className="text-xs text-gray-500 mt-1">
                        Optional. If set, these appear as suggestions in the result entry field. Quick codes above take priority for keyboard shortcut entry.
                      </p>
                    </div>

                    {/* Default value for result entry pre-fill */}
                    <div className="mt-3">
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Default Value
                        <span className="ml-1 text-xs text-gray-400 font-normal">(pre-filled in result entry)</span>
                      </label>
                      <input
                        type="text"
                        value={defaultValue}
                        onChange={e => setDefaultValue(e.target.value)}
                        placeholder={quickCodes.length > 0 ? `e.g. ${quickCodes[0]?.value || 'Non-Reactive'}` : 'e.g. Non-Reactive'}
                        className="w-full px-3 py-2 border border-amber-300 rounded-md focus:ring-2 focus:ring-amber-400 focus:border-transparent bg-amber-50"
                      />
                      <p className="text-xs text-gray-500 mt-1">
                        When a new result is being entered, this value is shown pre-filled (amber highlight). The tech can change or clear it before submitting.
                      </p>
                    </div>

                    <p className="text-xs text-blue-600 bg-blue-50 rounded px-2 py-1 mt-2">
                      Flag auto-calculation is disabled for Qualitative type. Use the Reference Range field above to show a descriptive normal value (e.g. "Negative") in reports.
                    </p>
                  </>
                ) : (
                  <>
                    {/* Non-qualitative: dropdown options + flag mapping */}
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Expected Values (Dropdown Options)
                    </label>
                    <textarea
                      value={expectedNormalValuesText}
                      onChange={(e) => setExpectedNormalValuesText(e.target.value)}
                      rows={4}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      placeholder="Enter one value per line, e.g.:&#10;Negative&#10;Positive&#10;Reactive&#10;Non-Reactive"
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      Enter one option per line. When set, users will see a dropdown instead of free text input.
                    </p>
                    {expectedNormalValuesText && (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {expectedNormalValuesText.split('\n').filter(v => v.trim()).map((val, idx) => (
                          <span key={idx} className="px-2 py-1 bg-blue-100 text-blue-800 rounded text-xs">
                            {val.trim()}
                          </span>
                        ))}
                      </div>
                    )}
                    {/* Default value for result entry pre-fill */}
                    <div className="mt-3">
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Default Value
                        <span className="ml-1 text-xs text-gray-400 font-normal">(pre-filled in result entry)</span>
                      </label>
                      <input
                        type="text"
                        value={defaultValue}
                        onChange={e => setDefaultValue(e.target.value)}
                        placeholder="e.g. Negative, 0, Normal"
                        className="w-full px-3 py-2 border border-amber-300 rounded-md focus:ring-2 focus:ring-amber-400 focus:border-transparent bg-amber-50"
                      />
                      <p className="text-xs text-gray-500 mt-1">
                        Pre-fills this value in result entry for new results (amber highlight). Tech can change before submitting.
                      </p>
                    </div>

                    {expectedNormalValuesText && expectedNormalValuesText.split('\n').filter(v => v.trim()).length > 0 && (
                      <div className="mt-3 bg-white border border-blue-200 rounded-lg p-3">
                        <h5 className="text-sm font-medium text-gray-700 mb-2 flex items-center">
                          <Flag className="h-4 w-4 mr-1.5 text-orange-500" />
                          Flag Mapping (auto-set flag when value is selected)
                        </h5>
                        <div className="space-y-2">
                          {expectedNormalValuesText.split('\n').filter(v => v.trim()).map((val, idx) => {
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
                                  {labFlagOptions.map((opt, i) => (
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
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Result Interpretation Section */}
          <div className="bg-purple-50 p-4 rounded-lg">
            <h4 className="text-lg font-medium text-gray-900 mb-4">Result Interpretation</h4>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Low Value Interpretation</label>
                <textarea
                  value={formData.interpretation_low || ''}
                  onChange={(e) => setFormData(prev => ({ ...prev, interpretation_low: e.target.value }))}
                  rows={2}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder="Clinical significance when value is below normal range"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Normal Value Interpretation</label>
                <textarea
                  value={formData.interpretation_normal || ''}
                  onChange={(e) => setFormData(prev => ({ ...prev, interpretation_normal: e.target.value }))}
                  rows={2}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder="Clinical significance when value is within normal range"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">High Value Interpretation</label>
                <textarea
                  value={formData.interpretation_high || ''}
                  onChange={(e) => setFormData(prev => ({ ...prev, interpretation_high: e.target.value }))}
                  rows={2}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder="Clinical significance when value is above normal range"
                />
              </div>
            </div>
          </div>

          {/* Testing Method & Quality Section */}
          <div className="bg-green-50 p-4 rounded-lg">
            <h4 className="text-lg font-medium text-gray-900 mb-4">Testing Method & Quality</h4>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Testing Method</label>
                <select
                  value={formData.method || ''}
                  onChange={(e) => setFormData(prev => ({ ...prev, method: e.target.value || undefined }))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                >
                  <option value="">Select Method</option>
                  {labMethodOptions.map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
                <div className="mt-2 flex items-center gap-2">
                  <input
                    type="text"
                    value={newMethodValue}
                    onChange={(e) => setNewMethodValue(e.target.value)}
                    placeholder="Add new method"
                    className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                  <button
                    type="button"
                    onClick={handleAddMethodOption}
                    className="px-3 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
                  >
                    Add
                  </button>
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  Methods are saved per lab and available for all analytes in this lab.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="flex items-start space-x-3">
                  <input
                    type="checkbox"
                    id="is_critical"
                    checked={formData.is_critical || false}
                    onChange={(e) => setFormData(prev => ({ ...prev, is_critical: e.target.checked }))}
                    className="mt-1 rounded border-gray-300 text-red-600 focus:ring-red-500"
                  />
                  <div>
                    <label htmlFor="is_critical" className="text-sm font-medium text-gray-700">
                      Critical Value Parameter
                    </label>
                    <p className="text-xs text-gray-500 mt-1">
                      Can have critical values requiring immediate notification
                    </p>
                  </div>
                </div>

                <div className="flex items-start space-x-3">
                  <input
                    type="checkbox"
                    id="is_active"
                    checked={formData.is_active !== false}
                    onChange={(e) => setFormData(prev => ({ ...prev, is_active: e.target.checked }))}
                    className="mt-1 rounded border-gray-300 text-green-600 focus:ring-green-500"
                  />
                  <div>
                    <label htmlFor="is_active" className="text-sm font-medium text-gray-700">
                      Active Status
                    </label>
                    <p className="text-xs text-gray-500 mt-1">
                      Analyte is available for use in tests
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* AI Processing & Configuration Section */}
          <div className="bg-indigo-50 p-4 rounded-lg">
            <h4 className="text-lg font-medium text-gray-900 mb-4">AI Processing & Configuration</h4>

            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">AI Processing Type</label>
                  <select
                    value={formData.ai_processing_type || ''}
                    onChange={(e) => setFormData(prev => ({ ...prev, ai_processing_type: e.target.value || undefined }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  >
                    <option value="">Select Processing Type</option>
                    <option value="ocr_report">OCR Report</option>
                    <option value="manual_entry">Manual Entry</option>
                    <option value="instrument_interface">Instrument Interface</option>
                    <option value="batch_processing">Batch Processing</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Group AI Mode</label>
                  <select
                    value={formData.group_ai_mode || ''}
                    onChange={(e) => setFormData(prev => ({ ...prev, group_ai_mode: e.target.value || undefined }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  >
                    <option value="">Select AI Mode</option>
                    <option value="individual">Individual</option>
                    <option value="group">Group</option>
                    <option value="batch">Batch</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">AI Prompt Override</label>
                <textarea
                  value={formData.ai_prompt_override || ''}
                  onChange={(e) => setFormData(prev => ({ ...prev, ai_prompt_override: e.target.value || null }))}
                  rows={3}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder="Custom AI processing instructions for this analyte..."
                />
                <p className="text-xs text-gray-500 mt-1">Override default AI processing prompts with custom instructions</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Reference Range Rules (AI Context)</label>
                <textarea
                  value={refRangeKnowledgeText}
                  onChange={(e) => setRefRangeKnowledgeText(e.target.value)}
                  rows={6}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent font-mono text-sm"
                  placeholder="Enter plain-text rules, or a JSON object such as {&quot;dog&quot;:&quot;...&quot;,&quot;cat&quot;:&quot;...&quot;}."
                />
                <p className="text-xs text-gray-500 mt-1">
                  Plain text is saved as text_rules. Existing species-keyed JSON is displayed and preserved as an object.
                </p>
              </div>

            </div>
          </div>

          {/* Calculated Parameter Section */}
          <div className="bg-amber-50 p-4 rounded-lg border border-amber-200">
            <h4 className="text-lg font-medium text-gray-900 mb-4 flex items-center">
              <Calculator className="w-5 h-5 mr-2 text-amber-600" />
              Calculated Parameter
            </h4>

            <div className="space-y-4">
              <div className="flex items-start space-x-3">
                <input
                  type="checkbox"
                  id="is_calculated"
                  checked={formulaData.is_calculated}
                  onChange={(e) => setFormulaData(prev => ({ ...prev, is_calculated: e.target.checked }))}
                  className="mt-1 rounded border-gray-300 text-amber-600 focus:ring-amber-500"
                />
                <div>
                  <label htmlFor="is_calculated" className="text-sm font-medium text-gray-700">
                    This is a Calculated Parameter
                  </label>
                  <p className="text-xs text-gray-500 mt-1">
                    Value is auto-computed from other analytes using a formula
                  </p>
                </div>
              </div>

              {formulaData.is_calculated && (
                <div className="space-y-4">
                  {/* Step 1: Select Source Analytes */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Step 1: Select Source Analytes
                    </label>
                    <p className="text-xs text-gray-500 mb-2">
                      Choose the analytes whose values will be used in the formula
                    </p>

                    {/* Selected Sources */}
                    {selectedSources.length > 0 && (
                      <div className="mb-3 space-y-2">
                        {selectedSources.map(source => (
                          <div key={source.id} className={`flex items-center gap-2 bg-white rounded-lg p-2 ${isInGroup(source) ? 'border border-green-300' : 'border border-amber-200'}`}>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-1.5">
                                <span className="text-sm font-medium text-gray-900 truncate">{source.name}</span>
                                {isInGroup(source) && (
                                  <span className="flex-shrink-0 text-xs px-1.5 py-0.5 bg-green-100 text-green-700 rounded-full font-medium">In group</span>
                                )}
                                {!isInGroup(source) && source.id && !source.id.startsWith('_manual_') && (
                                  <span className="flex-shrink-0 text-xs px-1.5 py-0.5 bg-yellow-100 text-yellow-700 rounded-full font-medium" title="This analyte is not in the current test group — add it to ensure the formula calculates">⚠ Not in group</span>
                                )}
                              </div>
                              {source.unit && <div className="text-xs text-gray-500">{source.unit}</div>}
                            </div>
                            <div className="flex items-center gap-2 flex-shrink-0">
                              <span className="text-xs text-gray-500">Var:</span>
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
                                className="p-1 text-red-500 hover:text-red-700"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Analyte Picker Dropdown */}
                    {availableAnalytes.length > 0 ? (
                      <div className="relative" ref={sourcePickerRef}>
                        <div
                          className="flex items-center gap-2 px-3 py-2 border border-gray-300 rounded-md bg-white cursor-pointer hover:border-amber-400"
                          onClick={() => setShowSourcePicker(v => !v)}
                        >
                          <Plus className="h-4 w-4 text-amber-600" />
                          <span className="text-sm text-gray-600">Add source analyte...</span>
                          <ChevronDown className="h-4 w-4 text-gray-400 ml-auto" />
                        </div>
                        {showSourcePicker && (
                          <div className="absolute z-10 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-64 overflow-hidden">
                            <div className="p-2 border-b border-gray-100">
                              <div className="relative">
                                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
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
                              {filteredSourceAnalytes.length === 0 ? (
                                <div className="p-3 text-sm text-gray-500 text-center">No matching analytes found</div>
                              ) : (
                                filteredSourceAnalytes.map((a, idx) => {
                                  const isInGrp = isInGroup(a);
                                  // Show section header when transitioning from in-group to others
                                  const prevIsInGroup = idx > 0 ? isInGroup(filteredSourceAnalytes[idx - 1]) : true;
                                  const showSeparator = !isInGrp && prevIsInGroup && filteredSourceAnalytes.some(x => isInGroup(x));
                                  return (
                                    <React.Fragment key={a.id}>
                                      {showSeparator && (
                                        <div className="px-3 py-1 bg-gray-50 border-t border-b border-gray-100 text-xs text-gray-400 font-medium uppercase tracking-wide">
                                          Other analytes
                                        </div>
                                      )}
                                      {idx === 0 && isInGrp && (
                                        <div className="px-3 py-1 bg-green-50 border-b border-green-100 text-xs text-green-700 font-medium uppercase tracking-wide">
                                          In this test group
                                        </div>
                                      )}
                                      <div
                                        className={`px-3 py-2 cursor-pointer flex items-center justify-between ${isInGrp ? 'hover:bg-green-50 bg-green-50/30' : 'hover:bg-amber-50'}`}
                                        onClick={() => handleAddSource(a)}
                                      >
                                        <div className="flex items-center gap-2 min-w-0">
                                          <div>
                                            <div className="text-sm font-medium text-gray-900">{a.name}</div>
                                            <div className="text-xs text-gray-500">{a.unit}{a.category ? ` • ${a.category}` : ''}</div>
                                          </div>
                                          {isInGrp && (
                                            <span className="flex-shrink-0 text-xs px-1.5 py-0.5 bg-green-100 text-green-700 rounded-full font-medium">
                                              In group
                                            </span>
                                          )}
                                        </div>
                                        <span className="text-xs text-amber-600 font-mono flex-shrink-0 ml-2">{generateVariableSlug(a.name)}</span>
                                      </div>
                                    </React.Fragment>
                                  );
                                })
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    ) : (
                      /* Fallback: manual text input when no analytes passed */
                      <div>
                        <input
                          type="text"
                          value={formulaVariablesText}
                          onChange={(e) => setFormulaVariablesText(e.target.value)}
                          className="w-full px-3 py-2 border border-amber-300 rounded-md focus:ring-2 focus:ring-amber-500 focus:border-transparent font-mono bg-amber-50"
                          placeholder="e.g., Hb, RBC, PCV"
                        />
                        <p className="text-xs text-gray-500 mt-1">
                          Enter variable names manually (comma-separated).
                        </p>
                        {formulaVariablesText && (
                          <div className="mt-2 flex flex-wrap gap-2">
                            {formulaVariablesText.split(',').map(v => v.trim()).filter(Boolean).map((v, i) => (
                              <span key={i} className="px-2 py-1 bg-amber-100 text-amber-800 rounded text-xs font-mono">{v}</span>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Step 2: Build Formula */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Result Type
                    </label>
                    <select
                      value={formulaData.calculation_result_type || 'numeric'}
                      onChange={(e) => setFormulaData(prev => ({
                        ...prev,
                        calculation_result_type: e.target.value as 'numeric' | 'text',
                      }))}
                      className="w-full px-3 py-2 mb-3 border border-amber-300 rounded-md focus:ring-2 focus:ring-amber-500 focus:border-transparent bg-white"
                    >
                      <option value="numeric">Numeric formula</option>
                      <option value="text">Text rules</option>
                    </select>

                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Step 2: Build {formulaData.calculation_result_type === 'text' ? 'Text Rules' : 'Formula'} *
                    </label>

                    {/* Quick-insert buttons */}
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
                        <span className="text-xs text-gray-400 self-center ml-1">Click to insert</span>
                      </div>
                    )}

                    <input
                      ref={formulaInputRef}
                      type="text"
                      value={formulaData.formula}
                      onChange={(e) => setFormulaData(prev => ({ ...prev, formula: e.target.value }))}
                      className="w-full px-3 py-2 border border-amber-300 rounded-md focus:ring-2 focus:ring-amber-500 focus:border-transparent font-mono bg-amber-50"
                      placeholder={formulaData.calculation_result_type === 'text'
                        ? '[{"when":"PLT >= 150000 && PLT <= 450000","value":"Platelets are seen adequate on smear."}]'
                        : 'e.g., (HGB / RBC) * 10'}
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      {formulaData.calculation_result_type === 'text'
                        ? 'Use JSON rules with when/value. Conditions can use <, <=, >, >=, ==, &&, ||.'
                        : 'Operators: + - * / ( ) | Functions: sqrt(), pow(), abs(), round()'}
                    </p>
                  </div>

                  {/* Formula Preview */}
                  {(formulaData.formula || selectedSources.length > 0) && (
                    <div className="bg-white border border-amber-300 rounded-lg p-3">
                      <h4 className="text-sm font-medium text-amber-900 mb-2">Formula Preview</h4>
                      <div className="text-sm text-amber-800 font-mono bg-amber-100 p-2 rounded">
                        {formulaData.formula || '(No formula entered)'}
                      </div>
                      {selectedSources.length > 0 && (
                        <div className="mt-2 space-y-1">
                          <div className="text-xs text-amber-700 font-medium">Variable Mappings:</div>
                          {selectedSources.map(s => (
                            <div key={s.id} className="text-xs text-amber-600 pl-2">
                              {s.variableName} → {s.name}{s.unit ? ` (${s.unit})` : ''}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Formula Description */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Formula Description</label>
                    <input
                      type="text"
                      value={formulaData.formula_description}
                      onChange={(e) => setFormulaData(prev => ({ ...prev, formula_description: e.target.value }))}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-amber-500 focus:border-transparent"
                      placeholder="e.g., MCH = (Hemoglobin / RBC count) × 10"
                    />
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Additional Information Section */}
          <div className="bg-yellow-50 p-4 rounded-lg">
            <h4 className="text-lg font-medium text-gray-900 mb-4">Additional Information</h4>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Description & Notes</label>
              <textarea
                value={formData.description || ''}
                onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                rows={4}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="Additional notes, clinical significance, sample requirements, interference factors, etc."
              />
              <p className="text-xs text-gray-500 mt-1">
                Include any important information about sample collection, storage, clinical significance, or interpretation notes
              </p>
            </div>
          </div>

          {/* Analyzer Interface Config — only shown when this analyte has a lab_analyte_id */}
          {analyte.lab_analyte_id && (
            <div className="bg-teal-50 p-4 rounded-lg border border-teal-200">
              <h4 className="text-lg font-medium text-gray-900 mb-1 flex items-center">
                <Activity className="w-5 h-5 mr-2 text-teal-600" />
                Analyzer Interface Config
              </h4>
              <p className="text-xs text-teal-700 mb-4">
                Lab-specific settings for how this analyte is processed on the analyzer. These override global defaults per lab.
              </p>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Dilution Factor
                    <span className="ml-1 text-xs text-gray-400 font-normal">(1 = neat, 2 = 1:2, 5 = 1:5)</span>
                  </label>
                  <input
                    type="number"
                    min="1"
                    step="0.5"
                    value={interfaceConfig.dilution_factor}
                    onChange={(e) => setInterfaceConfig(prev => ({ ...prev, dilution_factor: e.target.value }))}
                    className="w-full px-3 py-2 border border-teal-300 rounded-md focus:ring-2 focus:ring-teal-500 focus:border-transparent"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Dilution Mode</label>
                  <select
                    value={interfaceConfig.dilution_mode}
                    onChange={(e) => setInterfaceConfig(prev => ({ ...prev, dilution_mode: e.target.value }))}
                    className="w-full px-3 py-2 border border-teal-300 rounded-md focus:ring-2 focus:ring-teal-500 focus:border-transparent"
                  >
                    <option value="auto">Auto — analyzer dilutes automatically</option>
                    <option value="manual">Manual — technician dilutes before loading</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Stored Precision
                    <span className="ml-1 text-xs text-gray-400 font-normal">(what gets saved from the instrument)</span>
                  </label>
                  <select
                    value={interfaceConfig.decimal_places}
                    onChange={(e) => setInterfaceConfig(prev => ({ ...prev, decimal_places: e.target.value }))}
                    className="w-full px-3 py-2 border border-teal-300 rounded-md focus:ring-2 focus:ring-teal-500 focus:border-transparent"
                  >
                    <option value="">As received — keep analyzer precision</option>
                    <option value="0">0 — whole number (integer)</option>
                    <option value="1">1 decimal</option>
                    <option value="2">2 decimals</option>
                    <option value="3">3 decimals</option>
                    <option value="4">4 decimals</option>
                  </select>
                  <p className="text-xs text-teal-700 mt-1">
                    Trims the value saved from the analyzer, after dilution and conversion. This is
                    separate from <strong>Decimal Places</strong> above, which controls how the value
                    prints on the report.
                  </p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Instrument Unit
                    <span className="ml-1 text-xs text-gray-400 font-normal">(unit the analyzer reports in)</span>
                  </label>
                  <input
                    type="text"
                    value={interfaceConfig.instrument_unit}
                    onChange={(e) => setInterfaceConfig(prev => ({ ...prev, instrument_unit: e.target.value }))}
                    placeholder="e.g., mmol/L"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-teal-500 focus:border-transparent"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    LIMS Unit
                    <span className="ml-1 text-xs text-gray-400 font-normal">(unit shown in reports)</span>
                  </label>
                  <input
                    type="text"
                    value={interfaceConfig.lims_unit}
                    onChange={(e) => setInterfaceConfig(prev => ({ ...prev, lims_unit: e.target.value }))}
                    placeholder="e.g., mg/dL"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-teal-500 focus:border-transparent"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Multiply By
                    <span className="ml-1 text-xs text-gray-400 font-normal">(unit conversion factor)</span>
                  </label>
                  <input
                    type="number"
                    step="0.001"
                    value={interfaceConfig.multiply_by}
                    onChange={(e) => setInterfaceConfig(prev => ({ ...prev, multiply_by: e.target.value }))}
                    placeholder="1"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-teal-500 focus:border-transparent"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    result = (instrument_value × multiply_by) + add_offset
                  </p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Add Offset
                    <span className="ml-1 text-xs text-gray-400 font-normal">(applied after multiply)</span>
                  </label>
                  <input
                    type="number"
                    step="0.001"
                    value={interfaceConfig.add_offset}
                    onChange={(e) => setInterfaceConfig(prev => ({ ...prev, add_offset: e.target.value }))}
                    placeholder="0"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-teal-500 focus:border-transparent"
                  />
                </div>
              </div>

              <div className="mt-4 flex items-start space-x-3">
                <input
                  type="checkbox"
                  id="auto_verify"
                  checked={interfaceConfig.auto_verify}
                  onChange={(e) => setInterfaceConfig(prev => ({ ...prev, auto_verify: e.target.checked }))}
                  className="mt-1 rounded border-gray-300 text-teal-600 focus:ring-teal-500"
                />
                <div>
                  <label htmlFor="auto_verify" className="text-sm font-medium text-gray-700">
                    Auto-Verify Results
                  </label>
                  <p className="text-xs text-gray-500 mt-0.5">
                    Skip manual verification for this analyte when received from analyzer (use only for low-risk parameters).
                  </p>
                </div>
              </div>

              <div className="mt-4">
                <p className="text-sm font-medium text-gray-700 mb-2">Apply conversion in result entry</p>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <label className="flex items-start gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={interfaceConfig.apply_to_ai_result_entry}
                      onChange={(e) => setInterfaceConfig(prev => ({ ...prev, apply_to_ai_result_entry: e.target.checked }))}
                      className="mt-1 rounded border-gray-300 text-teal-600 focus:ring-teal-500"
                    />
                    <span className="text-sm text-gray-700">AI-extracted values</span>
                  </label>
                  <label className="flex items-start gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={interfaceConfig.apply_to_manual_result_entry}
                      onChange={(e) => setInterfaceConfig(prev => ({ ...prev, apply_to_manual_result_entry: e.target.checked }))}
                      className="mt-1 rounded border-gray-300 text-teal-600 focus:ring-teal-500"
                    />
                    <span className="text-sm text-gray-700">AI Result Entry manual input</span>
                  </label>
                  <label className="flex items-start gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={interfaceConfig.apply_to_quick_result_entry}
                      onChange={(e) => setInterfaceConfig(prev => ({ ...prev, apply_to_quick_result_entry: e.target.checked }))}
                      className="mt-1 rounded border-gray-300 text-teal-600 focus:ring-teal-500"
                    />
                    <span className="text-sm text-gray-700">Quick Result Entry</span>
                  </label>
                </div>
                <p className="text-xs text-gray-500 mt-2">
                  Enabled numeric values use (entered value x multiply by) + add offset.
                </p>
              </div>

              <div className="mt-4">
                <label className="block text-sm font-medium text-gray-700 mb-1">Interface Notes</label>
                <textarea
                  value={interfaceConfig.notes}
                  onChange={(e) => setInterfaceConfig(prev => ({ ...prev, notes: e.target.value }))}
                  rows={2}
                  placeholder="Any special handling notes for this analyte on the analyzer..."
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-teal-500 focus:border-transparent"
                />
              </div>
            </div>
          )}

          <div className="flex justify-end space-x-3 pt-4 border-t">
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2 text-gray-700 bg-gray-100 rounded-md hover:bg-gray-200"
              disabled={saving}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center space-x-2"
            >
              {saving ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                  <span>Saving...</span>
                </>
              ) : (
                <>
                  <Save className="w-4 h-4" />
                  <span>Save Changes</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
