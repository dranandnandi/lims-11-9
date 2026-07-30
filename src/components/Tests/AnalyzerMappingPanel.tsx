import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { AlertCircle, CheckCircle, Download, FileSpreadsheet, Loader2, Save, Sparkles, Upload, Wand2, X } from 'lucide-react';
import { database, supabase } from '../../utils/supabase';

const IMPORT_FUNCTION_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ai-analyzer-mapping-import`;

interface AnalyzerConnection {
  id: string;
  name: string;
  status?: string | null;
  profile_id?: string | null;
}

interface TestGroupAnalyte {
  id: string;
  lab_analyte_id?: string | null;
  name?: string | null;
  display_name?: string | null;
  code?: string | null;
  unit?: string | null;
}

interface MappingRow {
  id?: string;
  lab_analyte_id: string;
  analyte_id: string;
  lims_code: string;
  analyzer_code: string;
  analyzer_display: string;
  analyzer_code_system: string;
  direction: 'inbound' | 'outbound' | 'bidirectional';
  mapping_type: string;
  verified: boolean;
  ai_confidence?: number | null;
  ai_source?: string | null;
  test_name: string;
  dirty: boolean;
  saving: boolean;
  saved: boolean;
  error: string | null;
  source?: 'connection' | 'generic' | 'new';
}

interface AiSuggestion {
  lab_analyte_id: string;
  analyte_id?: string;
  analyte_name: string;
  analyzer_code: string;
  analyzer_display?: string;
  confidence: number;
  rationale?: string;
  source_text?: string;
}

interface Props {
  testGroupId: string;
  testGroupName: string;
  labId?: string | null;
  analyzerConnection: AnalyzerConnection | null;
  analytes: TestGroupAnalyte[];
  onReload?: () => void;
}

function displayAnalyteName(analyte: TestGroupAnalyte): string {
  return analyte.display_name || analyte.name || analyte.code || 'Unnamed analyte';
}

function mappingKey(analyte: TestGroupAnalyte): string {
  return analyte.lab_analyte_id || analyte.id;
}

function normalizeExcelCell(value: unknown): string {
  return String(value ?? '').trim();
}

function normalizeExcelHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function getExcelValue(row: Record<string, any>, labels: string[]): string {
  const wanted = new Set(labels.map(normalizeExcelHeader));
  const found = Object.entries(row).find(([key]) => wanted.has(normalizeExcelHeader(key)));
  return normalizeExcelCell(found?.[1]);
}

function normalizeDirection(value: string): MappingRow['direction'] {
  const normalized = value.toLowerCase();
  if (normalized === 'outbound' || normalized === 'bidirectional') return normalized;
  return 'inbound';
}

function normalizeBoolean(value: string, fallback = true): boolean {
  const normalized = value.toLowerCase();
  if (!normalized) return fallback;
  return ['yes', 'true', '1', 'y', 'verified'].includes(normalized);
}

function safeFilePart(value: string): string {
  return value.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'instrument';
}

function defaultMapping(analyte: TestGroupAnalyte): MappingRow {
  const name = displayAnalyteName(analyte);
  return {
    lab_analyte_id: analyte.lab_analyte_id || '',
    analyte_id: analyte.id,
    lims_code: analyte.code || name,
    analyzer_code: '',
    analyzer_display: name,
    analyzer_code_system: 'LOCAL',
    direction: 'inbound',
    mapping_type: 'result_analyte',
    verified: true,
    test_name: name,
    dirty: false,
    saving: false,
    saved: false,
    error: null,
    source: 'new',
  };
}

function ConfidenceBadge({ value }: { value: number }) {
  const pct = Math.round((value || 0) * 100);
  const color =
    pct >= 90 ? 'bg-green-100 text-green-700' :
    pct >= 75 ? 'bg-yellow-100 text-yellow-700' :
    'bg-red-100 text-red-700';
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${color}`}>{pct}%</span>;
}

const AnalyzerMappingPanel: React.FC<Props> = ({
  testGroupId,
  testGroupName,
  labId: initialLabId,
  analyzerConnection,
  analytes,
  onReload,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const excelInputRef = useRef<HTMLInputElement>(null);
  const [labId, setLabId] = useState<string | null>(initialLabId || null);
  const [mappings, setMappings] = useState<Map<string, MappingRow>>(new Map());
  const [loading, setLoading] = useState(false);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [excelBusy, setExcelBusy] = useState(false);
  const [excelMessage, setExcelMessage] = useState<string | null>(null);
  const [showAiImport, setShowAiImport] = useState(false);
  const [aiStage, setAiStage] = useState<'upload' | 'loading' | 'review' | 'applying'>('upload');
  const [aiMode, setAiMode] = useState<'image' | 'text'>('image');
  const [aiText, setAiText] = useState('');
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiSuggestions, setAiSuggestions] = useState<AiSuggestion[]>([]);
  const [selectedSuggestions, setSelectedSuggestions] = useState<Set<string>>(new Set());
  const [dragOver, setDragOver] = useState(false);

  const mappableAnalytes = useMemo(
    () => analytes.filter((analyte) => Boolean(analyte.lab_analyte_id)),
    [analytes],
  );

  const missingLabAnalyteCount = analytes.length - mappableAnalytes.length;

  const loadMappings = useCallback(async () => {
    if (!analyzerConnection?.id || mappableAnalytes.length === 0) {
      setMappings(new Map());
      return;
    }

    setLoading(true);
    setPanelError(null);
    try {
      const resolvedLabId = labId || await database.getCurrentUserLabId();
      setLabId(resolvedLabId);
      if (!resolvedLabId) throw new Error('Unable to determine lab context.');

      const labAnalyteIds = mappableAnalytes.map((a) => a.lab_analyte_id as string);
      const { data, error } = await supabase
        .from('test_mappings')
        .select('id, lab_analyte_id, analyte_id, lims_code, analyzer_code, analyzer_display, analyzer_code_system, direction, mapping_type, verified, ai_confidence, test_name, analyzer_connection_id')
        .eq('lab_id', resolvedLabId)
        .eq('mapping_type', 'result_analyte')
        .in('direction', ['inbound', 'bidirectional'])
        .in('lab_analyte_id', labAnalyteIds)
        .or(`analyzer_connection_id.eq.${analyzerConnection.id},analyzer_connection_id.is.null`);

      if (error) throw error;

      const byLabAnalyte = new Map<string, MappingRow>();
      for (const row of (data || []) as any[]) {
        const existing = byLabAnalyte.get(row.lab_analyte_id);
        const isConnectionSpecific = row.analyzer_connection_id === analyzerConnection.id;
        if (existing && existing.source === 'connection' && !isConnectionSpecific) continue;

        byLabAnalyte.set(row.lab_analyte_id, {
          id: isConnectionSpecific ? row.id : undefined,
          lab_analyte_id: row.lab_analyte_id,
          analyte_id: row.analyte_id,
          lims_code: row.lims_code || '',
          analyzer_code: row.analyzer_code || '',
          analyzer_display: row.analyzer_display || row.test_name || '',
          analyzer_code_system: row.analyzer_code_system || 'LOCAL',
          direction: row.direction || 'inbound',
          mapping_type: row.mapping_type || 'result_analyte',
          verified: row.verified ?? true,
          ai_confidence: row.ai_confidence,
          test_name: row.test_name || '',
          dirty: false,
          saving: false,
          saved: false,
          error: null,
          source: isConnectionSpecific ? 'connection' : 'generic',
        });
      }

      const next = new Map<string, MappingRow>();
      for (const analyte of mappableAnalytes) {
        const key = mappingKey(analyte);
        next.set(key, byLabAnalyte.get(analyte.lab_analyte_id as string) || defaultMapping(analyte));
      }
      setMappings(next);
    } catch (err: any) {
      setPanelError(err?.message || 'Failed to load analyzer mappings.');
    } finally {
      setLoading(false);
    }
  }, [analyzerConnection?.id, labId, mappableAnalytes]);

  useEffect(() => {
    loadMappings();
  }, [loadMappings]);

  const getMapping = (analyte: TestGroupAnalyte) =>
    mappings.get(mappingKey(analyte)) || defaultMapping(analyte);

  const patchMapping = (analyte: TestGroupAnalyte, patch: Partial<MappingRow>) => {
    const key = mappingKey(analyte);
    setMappings((prev) => {
      const next = new Map(prev);
      next.set(key, { ...getMapping(analyte), ...patch, dirty: true, saved: false, error: null });
      return next;
    });
  };

  const setMappingStatus = (analyte: TestGroupAnalyte, patch: Partial<MappingRow>) => {
    const key = mappingKey(analyte);
    setMappings((prev) => {
      const next = new Map(prev);
      next.set(key, { ...getMapping(analyte), ...patch });
      return next;
    });
  };

  const persistMapping = async (analyte: TestGroupAnalyte, mapping: MappingRow, source: string): Promise<boolean> => {
    if (!analyzerConnection?.id) return false;
    const resolvedLabId = labId || await database.getCurrentUserLabId();
    if (!resolvedLabId) {
      setPanelError('Unable to determine lab context.');
      return false;
    }

    if (!mapping.lab_analyte_id) return false;
    const analyzerCode = mapping.analyzer_code.trim();
    if (!analyzerCode) {
      setMappingStatus(analyte, { error: 'Analyzer code is required.' });
      return false;
    }

    setMappingStatus(analyte, { saving: true, error: null });
    const payload = {
      lab_id: resolvedLabId,
      analyzer_id: analyzerConnection.profile_id || analyzerConnection.id,
      analyzer_profile_id: analyzerConnection.profile_id || null,
      analyzer_connection_id: analyzerConnection.id,
      analyte_id: analyte.id,
      lab_analyte_id: mapping.lab_analyte_id,
      test_group_id: testGroupId,
      lims_code: mapping.lims_code.trim() || analyte.code || displayAnalyteName(analyte),
      analyzer_code: analyzerCode,
      analyzer_display: mapping.analyzer_display.trim() || displayAnalyteName(analyte),
      analyzer_code_system: mapping.analyzer_code_system.trim() || 'LOCAL',
      test_name: displayAnalyteName(analyte),
      mapping_type: 'result_analyte',
      direction: mapping.direction || 'inbound',
      supports_order_send: false,
      supports_result_receive: true,
      verified: mapping.verified,
      ai_confidence: mapping.ai_confidence ?? null,
      ai_source: mapping.ai_confidence ? (mapping.ai_source || 'analyzer_mapping_image') : null,
      metadata: {
        source,
        test_group_name: testGroupName,
      },
      updated_at: new Date().toISOString(),
    };

    const query = mapping.id
      ? supabase.from('test_mappings').update(payload).eq('id', mapping.id).select('id').single()
      : supabase.from('test_mappings').insert(payload).select('id').single();

    const { data, error } = await query;
    if (error) {
      setMappingStatus(analyte, { saving: false, error: error.message });
      return false;
    }

    setMappingStatus(analyte, {
      id: data?.id || mapping.id,
      dirty: false,
      saving: false,
      saved: true,
      error: null,
      source: 'connection',
    });
    setTimeout(() => setMappingStatus(analyte, { saved: false }), 1800);
    return true;
  };

  const saveMapping = async (analyte: TestGroupAnalyte) => {
    const mapping = getMapping(analyte);
    await persistMapping(
      analyte,
      mapping,
      mapping.ai_confidence ? 'ai_analyzer_mapping_helper' : 'manual_test_group_mapping',
    );
  };

  const saveDirtyMappings = async () => {
    for (const analyte of mappableAnalytes) {
      const mapping = getMapping(analyte);
      if (mapping.dirty && mapping.analyzer_code.trim()) {
        await saveMapping(analyte);
      }
    }
    onReload?.();
  };

  const downloadExcelTemplate = () => {
    if (!analyzerConnection || mappableAnalytes.length === 0) return;

    const rows = mappableAnalytes.map((analyte, index) => {
      const mapping = getMapping(analyte);
      return {
        'S.No': index + 1,
        'Instrument': analyzerConnection.name,
        'Test Group': testGroupName,
        'Lab Analyte ID': analyte.lab_analyte_id || '',
        'Analyte ID': analyte.id,
        'LIMS Analyte': displayAnalyteName(analyte),
        'LIMS Code': mapping.lims_code || analyte.code || displayAnalyteName(analyte),
        'Unit': analyte.unit || '',
        'Analyzer Code': mapping.analyzer_code || '',
        'Analyzer Display': mapping.analyzer_display || displayAnalyteName(analyte),
        'Direction': mapping.direction || 'inbound',
        'Verified': mapping.verified ? 'Yes' : 'No',
      };
    });

    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(rows);
    worksheet['!cols'] = [
      { wch: 7 }, { wch: 24 }, { wch: 28 }, { wch: 38 }, { wch: 38 },
      { wch: 32 }, { wch: 18 }, { wch: 12 }, { wch: 18 }, { wch: 28 },
      { wch: 16 }, { wch: 10 },
    ];
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Mappings');

    const instructions = XLSX.utils.aoa_to_sheet([
      ['How to use'],
      ['Fill Analyzer Code and optionally Analyzer Display, Direction, Verified.'],
      ['Do not edit Lab Analyte ID or Analyte ID; upload uses Lab Analyte ID to update the exact assigned analyte.'],
      ['Rows with blank Analyzer Code are skipped and existing mappings are left unchanged.'],
    ]);
    instructions['!cols'] = [{ wch: 120 }];
    XLSX.utils.book_append_sheet(workbook, instructions, 'Instructions');

    const date = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(workbook, `analyzer_mapping_${safeFilePart(analyzerConnection.name)}_${date}.xlsx`);
  };

  const processExcelFile = async (file: File) => {
    if (!analyzerConnection?.id) {
      setPanelError('Select a connected analyzer first.');
      return;
    }
    if (mappableAnalytes.length === 0) {
      setPanelError('Attach and save analytes before importing analyzer codes.');
      return;
    }

    setExcelBusy(true);
    setPanelError(null);
    setExcelMessage(null);

    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(new Uint8Array(buffer), { type: 'array' });
      const sheetName = workbook.SheetNames.includes('Mappings') ? 'Mappings' : workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json<Record<string, any>>(sheet, { defval: '' });
      if (rows.length === 0) throw new Error('The uploaded mapping sheet is empty.');

      const analyteByLabAnalyteId = new Map(
        mappableAnalytes.map((analyte) => [analyte.lab_analyte_id as string, analyte]),
      );

      let failed = 0;
      let saved = 0;
      let skipped = 0;
      for (const row of rows) {
        const labAnalyteId = getExcelValue(row, ['Lab Analyte ID', 'lab_analyte_id']);
        const analyzerCode = getExcelValue(row, ['Analyzer Code', 'analyzer_code']);
        if (!labAnalyteId || !analyzerCode) {
          skipped += 1;
          continue;
        }

        const analyte = analyteByLabAnalyteId.get(labAnalyteId);
        if (!analyte) {
          skipped += 1;
          continue;
        }

        const current = getMapping(analyte);
        const nextMapping: MappingRow = {
          ...current,
          lab_analyte_id: labAnalyteId,
          analyte_id: analyte.id,
          lims_code: getExcelValue(row, ['LIMS Code', 'lims_code']) || current.lims_code || analyte.code || displayAnalyteName(analyte),
          analyzer_code: analyzerCode,
          analyzer_display: getExcelValue(row, ['Analyzer Display', 'analyzer_display']) || current.analyzer_display || displayAnalyteName(analyte),
          analyzer_code_system: current.analyzer_code_system || 'LOCAL',
          direction: normalizeDirection(getExcelValue(row, ['Direction', 'direction']) || current.direction),
          verified: normalizeBoolean(getExcelValue(row, ['Verified', 'verified']), current.verified),
          test_name: displayAnalyteName(analyte),
          dirty: false,
          saving: false,
          saved: false,
          error: null,
        };

        const didSave = await persistMapping(analyte, nextMapping, 'excel_analyzer_mapping_import');
        if (didSave) saved += 1;
        else failed += 1;
      }

      setExcelMessage(`Imported ${saved} mapping${saved === 1 ? '' : 's'}${skipped ? `, skipped ${skipped} row${skipped === 1 ? '' : 's'}` : ''}${failed ? `, failed ${failed}` : ''}.`);
      await loadMappings();
      onReload?.();
    } catch (err: any) {
      setPanelError(err?.message || 'Could not import mapping Excel.');
    } finally {
      setExcelBusy(false);
    }
  };

  const canRunAiImport = (): boolean => {
    if (!analyzerConnection?.id) {
      setAiError('Select a connected analyzer first.');
      return false;
    }
    if (mappableAnalytes.length === 0) {
      setAiError('Save analytes to this test group before importing analyzer codes.');
      return false;
    }
    return true;
  };

  const requestAiSuggestions = async (source: Record<string, unknown>) => {
    setAiError(null);
    setAiStage('loading');

    try {
      const response = await fetch(IMPORT_FUNCTION_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({
          ...source,
          test_group: { id: testGroupId, name: testGroupName },
          analyzer_connection: analyzerConnection,
          analytes: mappableAnalytes.map((analyte) => ({
            analyte_id: analyte.id,
            lab_analyte_id: analyte.lab_analyte_id,
            name: displayAnalyteName(analyte),
            lims_code: analyte.code || displayAnalyteName(analyte),
            unit: analyte.unit || '',
          })),
        }),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.message || data.error || 'AI mapping helper failed.');

      const suggestions = (data.suggestions || []) as AiSuggestion[];
      setAiSuggestions(suggestions);
      setSelectedSuggestions(new Set(suggestions.filter((s) => s.confidence >= 0.75).map((s) => s.lab_analyte_id)));
      setAiStage('review');
    } catch (err: any) {
      setAiError(err?.message || 'AI mapping helper failed.');
      setAiStage('upload');
    }
  };

  const processAiFile = async (file: File) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (!allowedTypes.includes(file.type)) {
      setAiError('Unsupported file type. Upload JPEG, PNG, WebP, or GIF.');
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      setAiError('File size must be under 20 MB.');
      return;
    }
    if (!canRunAiImport()) return;

    setAiError(null);
    setAiStage('loading');

    let base64: string;
    try {
      base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
    } catch {
      setAiError('Could not read the selected image.');
      setAiStage('upload');
      return;
    }

    await requestAiSuggestions({ file_base64: base64, file_mime_type: file.type });
  };

  const processAiText = async () => {
    const trimmed = aiText.trim();
    if (!trimmed) {
      setAiError('Paste the analyzer message or code list first.');
      return;
    }
    if (trimmed.length > 200000) {
      setAiError('Analyzer text must be under 200,000 characters.');
      return;
    }
    if (!canRunAiImport()) return;

    await requestAiSuggestions({ text_content: trimmed });
  };

  const applyAiSuggestions = () => {
    setAiStage('applying');
    const byLabAnalyte = new Map(mappableAnalytes.map((analyte) => [analyte.lab_analyte_id, analyte]));
    for (const suggestion of aiSuggestions) {
      if (!selectedSuggestions.has(suggestion.lab_analyte_id)) continue;
      const analyte = byLabAnalyte.get(suggestion.lab_analyte_id);
      if (!analyte) continue;
      patchMapping(analyte, {
        analyzer_code: suggestion.analyzer_code || '',
        analyzer_display: suggestion.analyzer_display || displayAnalyteName(analyte),
        ai_confidence: suggestion.confidence,
        ai_source: aiMode === 'text' ? 'analyzer_mapping_text' : 'analyzer_mapping_image',
        verified: suggestion.confidence >= 0.9,
      });
    }
    setShowAiImport(false);
    setAiStage('upload');
  };

  const configuredCount = mappableAnalytes.filter((analyte) => getMapping(analyte).analyzer_code.trim()).length;
  const dirtyCount = mappableAnalytes.filter((analyte) => getMapping(analyte).dirty).length;

  if (!analyzerConnection) {
    return null;
  }

  return (
    <div className="rounded-lg border border-teal-200 bg-teal-50/50 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h4 className="text-sm font-semibold text-teal-900">Analyte code mapping for {analyzerConnection.name}</h4>
          <p className="mt-1 text-xs text-teal-700">
            Map analyzer result codes only for analytes attached to this test group. These mappings are saved for this connected analyzer.
          </p>
          <p className="mt-1 text-xs text-teal-700">
            {configuredCount} of {mappableAnalytes.length} analytes mapped
            {missingLabAnalyteCount > 0 ? ` (${missingLabAnalyteCount} need this test group saved first)` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
          <button
            type="button"
            onClick={downloadExcelTemplate}
            disabled={loading || excelBusy || mappableAnalytes.length === 0}
            className="inline-flex items-center gap-1.5 rounded-md border border-emerald-300 bg-white px-3 py-2 text-xs font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
          >
            <Download className="h-3.5 w-3.5" />
            Download Excel
          </button>
          <button
            type="button"
            onClick={() => excelInputRef.current?.click()}
            disabled={loading || excelBusy || mappableAnalytes.length === 0}
            className="inline-flex items-center gap-1.5 rounded-md border border-emerald-300 bg-white px-3 py-2 text-xs font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
          >
            {excelBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileSpreadsheet className="h-3.5 w-3.5" />}
            Upload Excel
          </button>
          <input
            ref={excelInputRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) processExcelFile(file);
              event.target.value = '';
            }}
          />
          <button
            type="button"
            onClick={() => setShowAiImport(true)}
            disabled={loading || mappableAnalytes.length === 0}
            className="inline-flex items-center gap-1.5 rounded-md border border-purple-300 bg-white px-3 py-2 text-xs font-medium text-purple-700 hover:bg-purple-50 disabled:opacity-50"
          >
            <Sparkles className="h-3.5 w-3.5" />
            AI Mapping Helper
          </button>
          <button
            type="button"
            onClick={saveDirtyMappings}
            disabled={dirtyCount === 0}
            className="inline-flex items-center gap-1.5 rounded-md bg-teal-600 px-3 py-2 text-xs font-medium text-white hover:bg-teal-700 disabled:opacity-50"
          >
            <Save className="h-3.5 w-3.5" />
            Save {dirtyCount > 0 ? `${dirtyCount} ` : ''}mapping{dirtyCount === 1 ? '' : 's'}
          </button>
        </div>
      </div>

      {panelError && (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {panelError}
        </div>
      )}

      {excelMessage && (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-700">
          <CheckCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {excelMessage}
        </div>
      )}

      {loading ? (
        <div className="mt-4 flex items-center gap-2 text-sm text-teal-700">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading analyzer mappings...
        </div>
      ) : (
        <div className="mt-4 overflow-hidden rounded-lg border border-teal-100 bg-white">
          <div className="grid grid-cols-12 gap-2 border-b border-gray-100 bg-gray-50 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
            <div className="col-span-4">LIMS analyte</div>
            <div className="col-span-3">Analyzer code</div>
            <div className="col-span-3">Analyzer display</div>
            <div className="col-span-2 text-right">Status</div>
          </div>
          <div className="max-h-80 divide-y divide-gray-100 overflow-y-auto">
            {mappableAnalytes.length === 0 ? (
              <div className="px-3 py-6 text-center text-sm text-gray-500">
                Attach and save analytes before mapping analyzer codes.
              </div>
            ) : (
              mappableAnalytes.map((analyte) => {
                const mapping = getMapping(analyte);
                return (
                  <div key={mappingKey(analyte)} className="grid grid-cols-12 items-center gap-2 px-3 py-2">
                    <div className="col-span-4 min-w-0">
                      <div className="truncate text-sm font-medium text-gray-800">{displayAnalyteName(analyte)}</div>
                      <div className="truncate text-xs text-gray-400">{mapping.lims_code || analyte.code || analyte.lab_analyte_id}</div>
                    </div>
                    <div className="col-span-3">
                      <input
                        type="text"
                        value={mapping.analyzer_code}
                        onChange={(e) => patchMapping(analyte, { analyzer_code: e.target.value })}
                        placeholder="e.g. HGB"
                        className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
                      />
                    </div>
                    <div className="col-span-3">
                      <input
                        type="text"
                        value={mapping.analyzer_display}
                        onChange={(e) => patchMapping(analyte, { analyzer_display: e.target.value })}
                        placeholder={displayAnalyteName(analyte)}
                        className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
                      />
                    </div>
                    <div className="col-span-2 flex items-center justify-end gap-2">
                      {mapping.source === 'generic' && (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700" title="A generic mapping exists; saving will create analyzer-specific mapping.">
                          Generic
                        </span>
                      )}
                      {mapping.saved && <CheckCircle className="h-4 w-4 text-green-600" />}
                      {mapping.error && <span className="text-xs text-red-600" title={mapping.error}>Error</span>}
                      {mapping.dirty && (
                        <button
                          type="button"
                          onClick={() => saveMapping(analyte)}
                          disabled={mapping.saving}
                          className="rounded-md bg-teal-600 px-2 py-1 text-xs font-medium text-white hover:bg-teal-700 disabled:opacity-50"
                        >
                          {mapping.saving ? 'Saving...' : 'Save'}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {showAiImport && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4">
          <div className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-xl bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
              <div className="flex items-center gap-2">
                <Sparkles className="h-5 w-5 text-purple-600" />
                <h3 className="text-lg font-semibold text-gray-900">AI Analyzer Mapping Helper</h3>
                <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500">
                  {aiMode === 'text' ? 'Claude Haiku' : 'Claude Haiku vision'}
                </span>
              </div>
              <button type="button" onClick={() => setShowAiImport(false)} className="text-gray-400 hover:text-gray-600">
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
              {aiError && (
                <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  {aiError}
                </div>
              )}

              {aiStage === 'upload' && (
                <>
                  <div className="flex gap-2 rounded-lg bg-gray-100 p-1">
                    <button
                      type="button"
                      onClick={() => { setAiMode('image'); setAiError(null); }}
                      className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium ${
                        aiMode === 'image' ? 'bg-white text-purple-700 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                      }`}
                    >
                      Upload image
                    </button>
                    <button
                      type="button"
                      onClick={() => { setAiMode('text'); setAiError(null); }}
                      className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium ${
                        aiMode === 'text' ? 'bg-white text-purple-700 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                      }`}
                    >
                      Paste analyzer text
                    </button>
                  </div>
                  <p className="text-sm text-gray-600">
                    {aiMode === 'text'
                      ? "Paste a raw analyzer message (ASTM/HL7 frames), a code list, or anything copied from the analyzer software. AI will extract analyzer codes only and propose matches against this test group's attached analytes."
                      : "Upload an analyzer code list, printout, software screen, or mapping sheet. AI will extract analyzer codes only and propose matches against this test group's attached analytes."}
                  </p>
                </>
              )}

              {aiStage === 'upload' && aiMode === 'text' && (
                <>
                  <textarea
                    value={aiText}
                    onChange={(event) => setAiText(event.target.value)}
                    rows={12}
                    spellCheck={false}
                    placeholder={'Paste anything the analyzer sends or shows, for example:\n\nHGB  Hemoglobin  g/dL\nRBC  Red Blood Cell Count  10^6/uL\nWBC  Total WBC Count  10^3/uL\n\nor a raw frame:\nR|1|^^^HGB^1|13.2|g/dL||N||F||||20260725103000'}
                    className="w-full rounded-lg border border-gray-300 p-3 font-mono text-xs leading-relaxed focus:outline-none focus:ring-2 focus:ring-purple-500"
                  />
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-gray-500">{aiText.trim().length.toLocaleString()} characters</span>
                    <button
                      type="button"
                      onClick={processAiText}
                      disabled={!aiText.trim()}
                      className="inline-flex items-center gap-1.5 rounded-md bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-700 disabled:opacity-50"
                    >
                      <Wand2 className="h-4 w-4" />
                      Map with AI
                    </button>
                  </div>
                </>
              )}

              {aiStage === 'upload' && aiMode === 'image' && (
                <>
                  <div
                    onDragOver={(event) => { event.preventDefault(); setDragOver(true); }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={(event) => {
                      event.preventDefault();
                      setDragOver(false);
                      const file = event.dataTransfer.files[0];
                      if (file) processAiFile(file);
                    }}
                    onClick={() => fileInputRef.current?.click()}
                    className={`cursor-pointer rounded-xl border-2 border-dashed p-10 text-center transition-colors ${
                      dragOver ? 'border-purple-400 bg-purple-50' : 'border-gray-300 hover:border-purple-400 hover:bg-gray-50'
                    }`}
                  >
                    <Upload className="mx-auto mb-3 h-10 w-10 text-gray-400" />
                    <p className="text-sm font-medium text-gray-700">Drop mapping image here or click to browse</p>
                    <p className="mt-1 text-xs text-gray-500">JPEG, PNG, WebP, GIF. Max 20 MB.</p>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/jpeg,image/png,image/webp,image/gif"
                      className="hidden"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) processAiFile(file);
                        event.target.value = '';
                      }}
                    />
                  </div>
                </>
              )}

              {aiStage === 'loading' && (
                <div className="flex flex-col items-center justify-center py-16">
                  <Loader2 className="mb-3 h-10 w-10 animate-spin text-purple-500" />
                  <p className="text-sm font-medium text-gray-700">Reading analyzer codes and matching analytes...</p>
                </div>
              )}

              {aiStage === 'review' && (
                <>
                  {aiSuggestions.length === 0 ? (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                      No confident analyzer code matches were found. {aiMode === 'text' ? 'Paste more of the analyzer message' : 'Try a clearer image'} or enter codes manually.
                    </div>
                  ) : (
                    <div className="overflow-hidden rounded-lg border border-gray-200">
                      <div className="grid grid-cols-12 gap-2 border-b border-gray-100 bg-gray-50 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
                        <div className="col-span-1">Use</div>
                        <div className="col-span-3">Analyte</div>
                        <div className="col-span-2">Code</div>
                        <div className="col-span-2">Confidence</div>
                        <div className="col-span-4">Reason</div>
                      </div>
                      <div className="max-h-80 divide-y divide-gray-100 overflow-y-auto">
                        {aiSuggestions.map((suggestion) => (
                          <div key={`${suggestion.lab_analyte_id}:${suggestion.analyzer_code}`} className="grid grid-cols-12 items-start gap-2 px-4 py-3 text-sm">
                            <div className="col-span-1">
                              <input
                                type="checkbox"
                                checked={selectedSuggestions.has(suggestion.lab_analyte_id)}
                                onChange={(event) => {
                                  const next = new Set(selectedSuggestions);
                                  if (event.target.checked) next.add(suggestion.lab_analyte_id);
                                  else next.delete(suggestion.lab_analyte_id);
                                  setSelectedSuggestions(next);
                                }}
                                className="h-4 w-4 rounded border-gray-300 text-purple-600"
                              />
                            </div>
                            <div className="col-span-3 font-medium text-gray-800">{suggestion.analyte_name}</div>
                            <div className="col-span-2 font-mono text-gray-900">{suggestion.analyzer_code}</div>
                            <div className="col-span-2"><ConfidenceBadge value={suggestion.confidence} /></div>
                            <div className="col-span-4 text-xs text-gray-500">{suggestion.rationale || suggestion.source_text || '-'}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="flex items-center justify-between border-t border-gray-200 bg-gray-50 px-6 py-4">
              <button type="button" onClick={() => setShowAiImport(false)} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900">
                Cancel
              </button>
              {aiStage === 'review' && (
                <button
                  type="button"
                  onClick={applyAiSuggestions}
                  disabled={selectedSuggestions.size === 0}
                  className="rounded-md bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-700 disabled:opacity-50"
                >
                  Apply selected suggestions
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AnalyzerMappingPanel;
