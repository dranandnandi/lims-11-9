import React, { useState, useEffect } from 'react';
import * as XLSX from 'xlsx';
import { supabase } from '../../utils/supabase';
import { Plus, Edit2, Trash2, Wifi, Server, HardDrive, Copy, CheckCircle, Layers, Link2, Unlink, Download, Upload, Loader2, FileSpreadsheet } from 'lucide-react';

const CATEGORIES = [
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

interface AnalyzerProfile {
  id: string;
  name: string;
  manufacturer: string;
  model: string | null;
  protocol: string;
}

interface AnalyzerConnection {
  id: string;
  lab_id: string;
  name: string;
  profile_id: string | null;
  connection_type: 'tcp' | 'serial' | 'file';
  config: Record<string, any>;
  status: 'active' | 'inactive';
  host_mode: 'client' | 'server';
  created_at: string;
  analyzer_profiles?: AnalyzerProfile | null;
}

interface AnalyzerMappingExportRow {
  testGroupId: string;
  testGroupName: string;
  analyteId: string;
  labAnalyteId: string;
  analyteName: string;
  limsCode: string;
  unit: string;
  mappingId?: string;
  analyzerCode: string;
  analyzerDisplay: string;
  direction: 'inbound' | 'outbound' | 'bidirectional';
  verified: boolean;
}

const EMPTY_FORM = {
  name: '',
  profile_id: '',
  connection_type: 'tcp' as 'tcp' | 'serial' | 'file',
  host: '',
  port: '5000',
  device_path: '',
  host_mode: 'client' as 'client' | 'server',
  framing: 'mllp' as 'mllp' | 'raw',
  instrument_identifier: '',
  analyzer_type: '',
  worklist_flow: 'lims_push' as 'lims_push' | 'analyzer_initiated',
  direction: 'bidirectional' as 'bidirectional' | 'receive_only',
  use_saved_reference_ranges: true,
  baud_rate: '9600',
  data_bits: '8',
  stop_bits: '1',
  parity: 'none' as 'none' | 'even' | 'odd',
  status: 'active' as 'active' | 'inactive',
};

function displayAnalyteName(row: any): string {
  const la = Array.isArray(row.lab_analytes) ? row.lab_analytes[0] : row.lab_analytes;
  const a = Array.isArray(row.analytes) ? row.analytes[0] : row.analytes;
  return la?.display_name || la?.name || row.analyte_name || a?.name || la?.code || a?.code || row.lab_analyte_id || 'Unnamed analyte';
}

function limsCode(row: any): string {
  const la = Array.isArray(row.lab_analytes) ? row.lab_analytes[0] : row.lab_analytes;
  const a = Array.isArray(row.analytes) ? row.analytes[0] : row.analytes;
  return la?.code || a?.code || displayAnalyteName(row);
}

function analyteUnit(row: any): string {
  const la = Array.isArray(row.lab_analytes) ? row.lab_analytes[0] : row.lab_analytes;
  const a = Array.isArray(row.analytes) ? row.analytes[0] : row.analytes;
  return la?.lab_specific_unit || la?.unit || a?.unit || '';
}

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function readCell(row: Record<string, any>, labels: string[]): string {
  const wanted = new Set(labels.map(normalizeHeader));
  const found = Object.entries(row).find(([key]) => wanted.has(normalizeHeader(key)));
  return String(found?.[1] ?? '').trim();
}

function normalizeDirection(value: string): AnalyzerMappingExportRow['direction'] {
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
  return value.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'analyzer';
}

export default function AnalyzerConnectionsManager({ labId }: { labId: string }) {
  const [connections, setConnections] = useState<AnalyzerConnection[]>([]);
  const [profiles, setProfiles] = useState<AnalyzerProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Bulk assign state
  const [bulkCategory, setBulkCategory] = useState('');
  const [bulkAnalyzerId, setBulkAnalyzerId] = useState('');
  const [bulkPreviewCount, setBulkPreviewCount] = useState<number | null>(null);
  const [bulkAssigning, setBulkAssigning] = useState(false);
  const [bulkResult, setBulkResult] = useState<string | null>(null);
  const [mappingBusyId, setMappingBusyId] = useState<string | null>(null);
  const [mappingResult, setMappingResult] = useState<Record<string, string>>({});

  useEffect(() => {
    fetchAll();
  }, [labId]);

  async function fetchAll() {
    setLoading(true);
    const [{ data: conns }, { data: profs }] = await Promise.all([
      supabase
        .from('analyzer_connections')
        .select('*, analyzer_profiles(id, name, manufacturer, model, protocol)')
        .eq('lab_id', labId)
        .order('created_at', { ascending: false }),
      supabase
        .from('analyzer_profiles')
        .select('id, name, manufacturer, model, protocol')
        .eq('is_active', true)
        .order('manufacturer'),
    ]);
    if (conns) setConnections(conns as AnalyzerConnection[]);
    if (profs) setProfiles(profs as AnalyzerProfile[]);
    setLoading(false);
  }

  function openCreate() {
    setForm({ ...EMPTY_FORM });
    setEditingId(null);
    setError(null);
    setShowForm(true);
  }

  function openEdit(conn: AnalyzerConnection) {
    setForm({
      name: conn.name,
      profile_id: conn.profile_id ?? '',
      connection_type: conn.connection_type,
      host: conn.config?.host ?? '',
      port: conn.config?.port?.toString() ?? '5000',
      device_path: conn.config?.device ?? '',
      host_mode: conn.host_mode ?? 'client',
      framing: (String(conn.config?.framing ?? 'mllp').toLowerCase() === 'raw' ? 'raw' : 'mllp') as 'mllp' | 'raw',
      instrument_identifier: conn.config?.instrument_identifier ?? '',
      analyzer_type: conn.config?.type ?? '',
      worklist_flow: (conn.config?.worklist_flow ?? 'lims_push') as 'lims_push' | 'analyzer_initiated',
      direction: (conn.config?.direction === 'receive_only' ? 'receive_only' : 'bidirectional') as 'bidirectional' | 'receive_only',
      use_saved_reference_ranges: conn.config?.use_saved_reference_ranges !== false,
      baud_rate: conn.config?.baud_rate?.toString() ?? conn.config?.baudRate?.toString() ?? '9600',
      data_bits: conn.config?.data_bits?.toString() ?? conn.config?.dataBits?.toString() ?? '8',
      stop_bits: conn.config?.stop_bits?.toString() ?? conn.config?.stopBits?.toString() ?? '1',
      parity: (conn.config?.parity ?? 'none') as 'none' | 'even' | 'odd',
      status: conn.status ?? 'active',
    });
    setEditingId(conn.id);
    setError(null);
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    setEditingId(null);
    setError(null);
  }

  function buildConfig() {
    const common = {
      framing: form.framing,
      instrument_identifier: form.instrument_identifier.trim() || undefined,
      type: form.analyzer_type.trim() || undefined,
      worklist_flow: form.worklist_flow,
      direction: form.direction,
      use_saved_reference_ranges: form.use_saved_reference_ranges,
      mode: form.connection_type === 'tcp'
        ? (form.host_mode === 'server' ? 'tcp_server' : 'tcp_client')
        : form.connection_type === 'serial'
          ? 'serial'
          : 'file',
    };

    if (form.connection_type === 'tcp') {
      return { ...common, host: form.host.trim(), port: parseInt(form.port, 10) || 5000 };
    }
    if (form.connection_type === 'serial') {
      return {
        ...common,
        device: form.device_path.trim(),
        baud_rate: parseInt(form.baud_rate, 10) || 9600,
        data_bits: parseInt(form.data_bits, 10) || 8,
        stop_bits: parseInt(form.stop_bits, 10) || 1,
        parity: form.parity,
      };
    }
    return common;
  }

  async function handleSave() {
    if (!form.name.trim()) { setError('Name is required.'); return; }
    if (form.connection_type === 'tcp' && form.host_mode === 'client' && !form.host.trim()) { setError('Analyzer IP / Hostname is required for TCP client mode.'); return; }
    setSaving(true);
    setError(null);

    const payload = {
      lab_id: labId,
      name: form.name.trim(),
      profile_id: form.profile_id || null,
      connection_type: form.connection_type,
      config: buildConfig(),
      status: form.status,
      host_mode: form.host_mode,
    };

    let err;
    if (editingId) {
      ({ error: err } = await supabase.from('analyzer_connections').update(payload).eq('id', editingId));
    } else {
      ({ error: err } = await supabase.from('analyzer_connections').insert(payload));
    }

    setSaving(false);
    if (err) { setError(err.message); return; }
    closeForm();
    fetchAll();
  }

  async function handleDelete(id: string, name: string) {
    if (!window.confirm(`Delete analyzer connection "${name}"? This cannot be undone and will break any test groups linked to it.`)) return;
    await supabase.from('analyzer_connections').delete().eq('id', id);
    fetchAll();
  }

  function copyId(id: string) {
    navigator.clipboard.writeText(id);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  }

  // Preview count when category changes
  async function previewBulkCount(category: string) {
    setBulkPreviewCount(null);
    setBulkResult(null);
    if (!category) return;
    const { count } = await supabase
      .from('test_groups')
      .select('id', { count: 'exact', head: true })
      .eq('lab_id', labId)
      .eq('category', category)
      .eq('is_active', true);
    setBulkPreviewCount(count ?? 0);
  }

  async function handleBulkAssign(unlink = false) {
    if (!bulkCategory) return;
    setBulkAssigning(true);
    setBulkResult(null);
    const { data, error } = await supabase.rpc('bulk_assign_analyzer_to_category', {
      p_lab_id: labId,
      p_category: bulkCategory,
      p_analyzer_connection_id: unlink ? null : (bulkAnalyzerId || null),
    });
    setBulkAssigning(false);
    if (error) {
      setBulkResult(`Error: ${error.message}`);
    } else {
      const analyzerName = unlink
        ? 'unlinked'
        : connections.find(c => c.id === bulkAnalyzerId)?.name ?? 'assigned';
      setBulkResult(`${data} test group${data === 1 ? '' : 's'} ${unlink ? 'unlinked' : `linked to ${analyzerName}`}.`);
    }
  }

  async function getConnectionMappingRows(conn: AnalyzerConnection): Promise<AnalyzerMappingExportRow[]> {
    const { data: testGroups, error: groupError } = await supabase
      .from('test_groups')
      .select('id, name, code')
      .eq('lab_id', labId)
      .eq('is_active', true)
      .eq('analyzer_connection_id', conn.id)
      .order('name');

    if (groupError) throw groupError;
    const groupRows = (testGroups || []) as any[];
    const groupIds = groupRows.map(g => g.id);
    if (groupIds.length === 0) return [];

    const groupById = new Map(groupRows.map(g => [g.id, g]));
    const { data: analyteRows, error: analyteError } = await supabase
      .from('test_group_analytes')
      .select('id, test_group_id, analyte_id, lab_analyte_id, analyte_name, sort_order, display_order, analytes(id, name, code, unit), lab_analytes(id, analyte_id, name, display_name, code, unit, lab_specific_unit)')
      .eq('lab_id', labId)
      .in('test_group_id', groupIds)
      .not('lab_analyte_id', 'is', null)
      .order('test_group_id')
      .order('sort_order');

    if (analyteError) throw analyteError;
    const rows = (analyteRows || []) as any[];
    if (rows.length === 0) return [];

    const labAnalyteIds = [...new Set(rows.map(row => row.lab_analyte_id).filter(Boolean))];
    const { data: mappingRows, error: mappingError } = await supabase
      .from('test_mappings')
      .select('id, lab_analyte_id, test_group_id, lims_code, analyzer_code, analyzer_display, direction, verified, analyzer_connection_id')
      .eq('lab_id', labId)
      .eq('mapping_type', 'result_analyte')
      .in('direction', ['inbound', 'bidirectional'])
      .in('lab_analyte_id', labAnalyteIds)
      .or(`analyzer_connection_id.eq.${conn.id},analyzer_connection_id.is.null`);

    if (mappingError) throw mappingError;

    const mappingByKey = new Map<string, any>();
    for (const mapping of (mappingRows || []) as any[]) {
      const key = `${mapping.test_group_id || ''}:${mapping.lab_analyte_id}`;
      const genericKey = `:${mapping.lab_analyte_id}`;
      const isSpecific = mapping.analyzer_connection_id === conn.id;
      const preferredKey = mapping.test_group_id ? key : genericKey;
      const existing = mappingByKey.get(preferredKey);
      if (existing?.analyzer_connection_id === conn.id && !isSpecific) continue;
      mappingByKey.set(preferredKey, mapping);
    }

    return rows.map(row => {
      const group = groupById.get(row.test_group_id);
      const specific = mappingByKey.get(`${row.test_group_id}:${row.lab_analyte_id}`);
      const generic = mappingByKey.get(`:${row.lab_analyte_id}`);
      const mapping = specific || generic;
      const name = displayAnalyteName(row);
      return {
        testGroupId: row.test_group_id,
        testGroupName: group?.name || group?.code || '',
        analyteId: row.analyte_id,
        labAnalyteId: row.lab_analyte_id,
        analyteName: name,
        limsCode: mapping?.lims_code || limsCode(row),
        unit: analyteUnit(row),
        mappingId: mapping?.analyzer_connection_id === conn.id ? mapping.id : undefined,
        analyzerCode: mapping?.analyzer_code || '',
        analyzerDisplay: mapping?.analyzer_display || name,
        direction: normalizeDirection(mapping?.direction || 'inbound'),
        verified: mapping?.verified ?? true,
      };
    });
  }

  async function downloadMappingExcel(conn: AnalyzerConnection) {
    setMappingBusyId(conn.id);
    setMappingResult(prev => ({ ...prev, [conn.id]: '' }));
    try {
      const rows = await getConnectionMappingRows(conn);
      if (rows.length === 0) {
        setMappingResult(prev => ({ ...prev, [conn.id]: 'No assigned test group analytes found for this analyzer.' }));
        return;
      }

      const workbook = XLSX.utils.book_new();
      const sheetRows = rows.map((row, index) => ({
        'S.No': index + 1,
        'Instrument': conn.name,
        'Test Group': row.testGroupName,
        'Test Group ID': row.testGroupId,
        'Lab Analyte ID': row.labAnalyteId,
        'Analyte ID': row.analyteId,
        'Mapping ID': row.mappingId || '',
        'LIMS Analyte': row.analyteName,
        'LIMS Code': row.limsCode,
        'Unit': row.unit,
        'Analyzer Code': row.analyzerCode,
        'Analyzer Display': row.analyzerDisplay,
        'Direction': row.direction,
        'Verified': row.verified ? 'Yes' : 'No',
      }));
      const worksheet = XLSX.utils.json_to_sheet(sheetRows);
      worksheet['!cols'] = [
        { wch: 7 }, { wch: 24 }, { wch: 28 }, { wch: 38 }, { wch: 38 }, { wch: 38 },
        { wch: 38 }, { wch: 30 }, { wch: 18 }, { wch: 12 }, { wch: 18 }, { wch: 28 },
        { wch: 16 }, { wch: 10 },
      ];
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Mappings');

      const instructions = XLSX.utils.aoa_to_sheet([
        ['How to use'],
        ['Fill Analyzer Code and optionally Analyzer Display, Direction, Verified.'],
        ['Do not edit Test Group ID, Lab Analyte ID, Analyte ID, or Mapping ID. Upload uses these IDs to save the exact analyzer mapping.'],
        ['Rows with blank Analyzer Code are skipped.'],
      ]);
      instructions['!cols'] = [{ wch: 125 }];
      XLSX.utils.book_append_sheet(workbook, instructions, 'Instructions');

      XLSX.writeFile(workbook, `analyzer_mapping_${safeFilePart(conn.name)}_${new Date().toISOString().slice(0, 10)}.xlsx`);
      setMappingResult(prev => ({ ...prev, [conn.id]: `Downloaded ${rows.length} analyte row${rows.length === 1 ? '' : 's'}.` }));
    } catch (err: any) {
      setMappingResult(prev => ({ ...prev, [conn.id]: err?.message || 'Could not download mapping Excel.' }));
    } finally {
      setMappingBusyId(null);
    }
  }

  async function uploadMappingExcel(conn: AnalyzerConnection, file: File) {
    setMappingBusyId(conn.id);
    setMappingResult(prev => ({ ...prev, [conn.id]: '' }));
    try {
      const assignedRows = await getConnectionMappingRows(conn);
      const assignedByExactKey = new Map(assignedRows.map(row => [`${row.testGroupId}:${row.labAnalyteId}`, row]));
      const assignedByLabAnalyte = new Map(assignedRows.map(row => [row.labAnalyteId, row]));
      if (assignedRows.length === 0) throw new Error('No assigned test group analytes found for this analyzer.');

      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(new Uint8Array(buffer), { type: 'array' });
      const sheetName = workbook.SheetNames.includes('Mappings') ? 'Mappings' : workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const importedRows = XLSX.utils.sheet_to_json<Record<string, any>>(sheet, { defval: '' });
      if (importedRows.length === 0) throw new Error('The uploaded mapping sheet is empty.');

      let saved = 0;
      let skipped = 0;
      let failed = 0;

      for (const imported of importedRows) {
        const labAnalyteId = readCell(imported, ['Lab Analyte ID', 'lab_analyte_id']);
        const importedTestGroupId = readCell(imported, ['Test Group ID', 'test_group_id']);
        const analyzerCode = readCell(imported, ['Analyzer Code', 'analyzer_code']);
        if (!labAnalyteId || !analyzerCode) {
          skipped += 1;
          continue;
        }

        const assigned = (importedTestGroupId ? assignedByExactKey.get(`${importedTestGroupId}:${labAnalyteId}`) : null)
          || assignedByLabAnalyte.get(labAnalyteId);
        if (!assigned) {
          skipped += 1;
          continue;
        }

        const mappingId = readCell(imported, ['Mapping ID', 'mapping_id']) || assigned.mappingId || '';
        const payload = {
          lab_id: labId,
          analyzer_id: conn.profile_id || conn.id,
          analyzer_profile_id: conn.profile_id || null,
          analyzer_connection_id: conn.id,
          analyte_id: assigned.analyteId,
          lab_analyte_id: assigned.labAnalyteId,
          test_group_id: importedTestGroupId || assigned.testGroupId,
          lims_code: readCell(imported, ['LIMS Code', 'lims_code']) || assigned.limsCode,
          analyzer_code: analyzerCode,
          analyzer_display: readCell(imported, ['Analyzer Display', 'analyzer_display']) || assigned.analyzerDisplay || assigned.analyteName,
          analyzer_code_system: 'LOCAL',
          test_name: assigned.analyteName,
          mapping_type: 'result_analyte',
          direction: normalizeDirection(readCell(imported, ['Direction', 'direction']) || assigned.direction),
          supports_order_send: false,
          supports_result_receive: true,
          verified: normalizeBoolean(readCell(imported, ['Verified', 'verified']), assigned.verified),
          metadata: {
            source: 'settings_excel_analyzer_mapping_import',
            analyzer_name: conn.name,
            test_group_name: assigned.testGroupName,
          },
          updated_at: new Date().toISOString(),
        };

        const result = mappingId
          ? await supabase.from('test_mappings').update(payload).eq('id', mappingId).eq('lab_id', labId).select('id').single()
          : await supabase.from('test_mappings').insert(payload).select('id').single();

        if (result.error) failed += 1;
        else saved += 1;
      }

      setMappingResult(prev => ({
        ...prev,
        [conn.id]: `Imported ${saved} mapping${saved === 1 ? '' : 's'}${skipped ? `, skipped ${skipped}` : ''}${failed ? `, failed ${failed}` : ''}.`,
      }));
    } catch (err: any) {
      setMappingResult(prev => ({ ...prev, [conn.id]: err?.message || 'Could not import mapping Excel.' }));
    } finally {
      setMappingBusyId(null);
    }
  }

  const connectionTypeIcon = (type: string) => {
    if (type === 'tcp') return <Wifi className="h-4 w-4" />;
    if (type === 'serial') return <HardDrive className="h-4 w-4" />;
    return <Server className="h-4 w-4" />;
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold text-gray-800">Analyzer Connections</h3>
          <p className="text-sm text-gray-500 mt-0.5">Register physical instruments that the Bridge will communicate with.</p>
        </div>
        <button
          onClick={openCreate}
          className="flex items-center gap-1.5 px-3 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
        >
          <Plus className="h-4 w-4" />
          Add Analyzer
        </button>
      </div>

      {/* Create / Edit Form */}
      {showForm && (
        <div className="bg-gray-50 border border-gray-200 rounded-xl p-5 space-y-4">
          <h4 className="text-sm font-semibold text-gray-700">{editingId ? 'Edit Connection' : 'New Analyzer Connection'}</h4>

          {error && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
          )}

          <div className="grid grid-cols-2 gap-4">
            {/* Name */}
            <div className="col-span-2">
              <label className="block text-xs font-medium text-gray-600 mb-1">Display Name *</label>
              <input
                type="text"
                placeholder="e.g. Sysmex XN-1000 (Main Lab)"
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            {/* Profile */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Analyzer Profile</label>
              <select
                value={form.profile_id}
                onChange={e => setForm(f => ({ ...f, profile_id: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">— Select profile —</option>
                {profiles.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.manufacturer} {p.model ?? ''} ({p.protocol})
                  </option>
                ))}
              </select>
            </div>

            {/* Connection type */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Connection Type</label>
              <select
                value={form.connection_type}
                onChange={e => setForm(f => ({ ...f, connection_type: e.target.value as any }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="tcp">TCP / Network</option>
                <option value="serial">Serial / RS-232</option>
                <option value="file">File / Folder Watch</option>
              </select>
            </div>

            {/* TCP fields */}
            {form.connection_type === 'tcp' && (
              <>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Analyzer IP / Hostname{form.host_mode === 'client' ? ' *' : ''}</label>
                  <input
                    type="text"
                    placeholder={form.host_mode === 'client' ? 'e.g. 192.168.1.100' : 'optional, e.g. bridge bind IP'}
                    value={form.host}
                    onChange={e => setForm(f => ({ ...f, host: e.target.value }))}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Port</label>
                  <input
                    type="number"
                    placeholder="5000"
                    value={form.port}
                    onChange={e => setForm(f => ({ ...f, port: e.target.value }))}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </>
            )}

            {/* Serial fields */}
            {form.connection_type === 'serial' && (
              <>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Device Path</label>
                  <input
                    type="text"
                    placeholder="e.g. COM3 or /dev/ttyUSB0"
                    value={form.device_path}
                    onChange={e => setForm(f => ({ ...f, device_path: e.target.value }))}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Baud Rate</label>
                  <input
                    type="number"
                    value={form.baud_rate}
                    onChange={e => setForm(f => ({ ...f, baud_rate: e.target.value }))}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Data Bits</label>
                  <input
                    type="number"
                    value={form.data_bits}
                    onChange={e => setForm(f => ({ ...f, data_bits: e.target.value }))}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Parity</label>
                  <select
                    value={form.parity}
                    onChange={e => setForm(f => ({ ...f, parity: e.target.value as any }))}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="none">None</option>
                    <option value="even">Even</option>
                    <option value="odd">Odd</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Stop Bits</label>
                  <input
                    type="number"
                    value={form.stop_bits}
                    onChange={e => setForm(f => ({ ...f, stop_bits: e.target.value }))}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </>
            )}

            {/* Host mode */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Bridge Role</label>
              <select
                value={form.host_mode}
                onChange={e => setForm(f => ({ ...f, host_mode: e.target.value as any }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="client">Client (Bridge connects to analyzer)</option>
                <option value="server">Server (Analyzer connects to Bridge)</option>
              </select>
            </div>

            {/* Status */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Status</label>
              <select
                value={form.status}
                onChange={e => setForm(f => ({ ...f, status: e.target.value as any }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Protocol Framing</label>
              <select
                value={form.framing}
                onChange={e => setForm(f => ({ ...f, framing: e.target.value as any }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="mllp">MLLP</option>
                <option value="raw">Raw</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Workflow</label>
              <select
                value={form.worklist_flow}
                onChange={e => setForm(f => ({ ...f, worklist_flow: e.target.value as any }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="lims_push">LIMS pushes order</option>
                <option value="analyzer_initiated">Analyzer queries worklist</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Direction</label>
              <select
                value={form.direction}
                onChange={e => setForm(f => ({ ...f, direction: e.target.value as any }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="bidirectional">Bidirectional (send orders + receive results)</option>
                <option value="receive_only">Receive results only (never send orders)</option>
              </select>
              {form.direction === 'receive_only' && (
                <p className="mt-1 text-xs text-gray-500">
                  Creating an order will not send anything to this instrument. Results are still ingested by barcode.
                </p>
              )}
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Instrument Identifier</label>
              <input
                type="text"
                placeholder="e.g. BM850^HL7MW"
                value={form.instrument_identifier}
                onChange={e => setForm(f => ({ ...f, instrument_identifier: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Analyzer Type</label>
              <input
                type="text"
                placeholder="e.g. hematology"
                value={form.analyzer_type}
                onChange={e => setForm(f => ({ ...f, analyzer_type: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            {/* Reference range / flag source */}
            <div className="col-span-2">
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.use_saved_reference_ranges}
                  onChange={e => setForm(f => ({ ...f, use_saved_reference_ranges: e.target.checked }))}
                  className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="text-xs text-gray-600">
                  <span className="font-medium text-gray-700">Use saved reference ranges &amp; flags</span>
                  <span className="block text-gray-500 mt-0.5">
                    Store only the numeric result from this analyzer; take the reference range from the
                    lab's saved analyte settings and compute the H/L flag from it. Uncheck to keep the
                    range and flag reported by the machine.
                  </span>
                </span>
              </label>
            </div>
          </div>

          <div className="flex gap-2 pt-1">
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {saving ? 'Saving…' : editingId ? 'Save Changes' : 'Create Connection'}
            </button>
            <button
              onClick={closeForm}
              className="px-4 py-2 border border-gray-300 text-gray-600 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Connection list */}
      {loading ? (
        <div className="text-sm text-gray-500 py-4 text-center">Loading connections…</div>
      ) : connections.length === 0 ? (
        <div className="text-center py-10 border-2 border-dashed border-gray-200 rounded-xl">
          <Wifi className="h-8 w-8 text-gray-300 mx-auto mb-2" />
          <p className="text-sm text-gray-500">No analyzer connections yet.</p>
          <p className="text-xs text-gray-400 mt-1">Add one above, then link it to your test groups.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {connections.map(conn => (
            <div
              key={conn.id}
              className="bg-white border border-gray-200 rounded-xl px-4 py-3 flex flex-wrap items-start justify-between gap-4"
            >
              <div className="flex items-start gap-3 min-w-0">
                <div className={`mt-0.5 p-1.5 rounded-lg ${conn.status === 'active' ? 'bg-green-50 text-green-600' : 'bg-gray-100 text-gray-400'}`}>
                  {connectionTypeIcon(conn.connection_type)}
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-gray-800">{conn.name}</span>
                    <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${conn.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                      {conn.status}
                    </span>
                  </div>
                  {conn.analyzer_profiles && (
                    <p className="text-xs text-gray-500 mt-0.5">
                      {conn.analyzer_profiles.manufacturer} {conn.analyzer_profiles.model} &middot; {conn.analyzer_profiles.protocol}
                    </p>
                  )}
                  <p className="text-xs text-gray-400 mt-0.5">
                    {conn.connection_type.toUpperCase()}
                    {conn.connection_type === 'tcp' && conn.config?.host
                      ? ` · ${conn.config.host}:${conn.config.port ?? 5000}`
                      : ''}
                    {conn.connection_type === 'serial' && conn.config?.device
                      ? ` · ${conn.config.device}`
                      : ''}
                    {' · '}{conn.host_mode}
                  </p>
                  {/* Connection ID — needed for linking test groups */}
                  <div className="flex items-center gap-1 mt-1">
                    <span className="text-xs font-mono text-gray-400 truncate max-w-xs">{conn.id}</span>
                    <button
                      onClick={() => copyId(conn.id)}
                      className="text-gray-400 hover:text-blue-600 transition-colors flex-shrink-0"
                      title="Copy connection ID"
                    >
                      {copiedId === conn.id
                        ? <CheckCircle className="h-3.5 w-3.5 text-green-500" />
                        : <Copy className="h-3.5 w-3.5" />}
                    </button>
                    <span className="text-xs text-gray-400">{copiedId === conn.id ? 'Copied!' : 'Copy ID'}</span>
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-end gap-1 flex-shrink-0">
                <button
                  onClick={() => downloadMappingExcel(conn)}
                  disabled={mappingBusyId === conn.id}
                  className="flex items-center gap-1 rounded-lg border border-emerald-200 px-2 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
                  title="Download Excel mapping template for test groups assigned to this analyzer"
                >
                  {mappingBusyId === conn.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                  Excel
                </button>
                <label
                  className={`flex cursor-pointer items-center gap-1 rounded-lg border border-emerald-200 px-2 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-50 ${mappingBusyId === conn.id ? 'pointer-events-none opacity-50' : ''}`}
                  title="Upload completed Excel mapping for this analyzer"
                >
                  <Upload className="h-3.5 w-3.5" />
                  Upload
                  <input
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    className="hidden"
                    disabled={mappingBusyId === conn.id}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) uploadMappingExcel(conn, file);
                      event.target.value = '';
                    }}
                  />
                </label>
                <button
                  onClick={() => openEdit(conn)}
                  className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                  title="Edit"
                >
                  <Edit2 className="h-4 w-4" />
                </button>
                <button
                  onClick={() => handleDelete(conn.id, conn.name)}
                  className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                  title="Delete"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
              {mappingResult[conn.id] && (
                <div className="basis-full pl-10 text-xs text-emerald-700">
                  <FileSpreadsheet className="mr-1 inline h-3.5 w-3.5" />
                  {mappingResult[conn.id]}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Bulk Assign by Category */}
      {connections.length > 0 && (
        <div className="mt-6 border-t border-gray-200 pt-6">
          <div className="flex items-center gap-2 mb-1">
            <Layers className="h-4 w-4 text-teal-600" />
            <h3 className="text-base font-semibold text-gray-800">Bulk Assign by Category</h3>
          </div>
          <p className="text-sm text-gray-500 mb-4">
            Link all test groups in a category to one analyzer in a single action.
          </p>

          <div className="bg-teal-50 border border-teal-200 rounded-xl p-4 space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Category</label>
                <select
                  value={bulkCategory}
                  onChange={e => {
                    setBulkCategory(e.target.value);
                    setBulkResult(null);
                    previewBulkCount(e.target.value);
                  }}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
                >
                  <option value="">— Select category —</option>
                  {CATEGORIES.map(c => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Analyzer</label>
                <select
                  value={bulkAnalyzerId}
                  onChange={e => { setBulkAnalyzerId(e.target.value); setBulkResult(null); }}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
                >
                  <option value="">— Select analyzer —</option>
                  {connections.filter(c => c.status === 'active').map(c => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Preview */}
            {bulkCategory && bulkPreviewCount !== null && (
              <p className="text-sm text-teal-700">
                <strong>{bulkPreviewCount}</strong> active test group{bulkPreviewCount === 1 ? '' : 's'} in <strong>{bulkCategory}</strong> will be affected.
              </p>
            )}

            {/* Result */}
            {bulkResult && (
              <p className={`text-sm font-medium ${bulkResult.startsWith('Error') ? 'text-red-600' : 'text-green-700'}`}>
                {bulkResult}
              </p>
            )}

            <div className="flex gap-2">
              <button
                onClick={() => handleBulkAssign(false)}
                disabled={!bulkCategory || !bulkAnalyzerId || bulkAssigning}
                className="flex items-center gap-1.5 px-4 py-2 bg-teal-600 text-white text-sm font-medium rounded-lg hover:bg-teal-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <Link2 className="h-3.5 w-3.5" />
                {bulkAssigning ? 'Assigning…' : 'Assign All'}
              </button>
              <button
                onClick={() => handleBulkAssign(true)}
                disabled={!bulkCategory || bulkAssigning}
                className="flex items-center gap-1.5 px-4 py-2 border border-gray-300 text-gray-600 text-sm font-medium rounded-lg hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                title="Remove analyzer link from all test groups in this category"
              >
                <Unlink className="h-3.5 w-3.5" />
                Clear Category
              </button>
            </div>
          </div>
        </div>
      )}

      <p className="text-xs text-gray-400 pt-1">
        After creating a connection, use Bulk Assign above or edit individual test groups under <strong>Tests → Edit Test Group → Analyzer Interface</strong>. Excel mapping download/upload is available inside that Analyzer Interface panel.
      </p>
    </div>
  );
}
