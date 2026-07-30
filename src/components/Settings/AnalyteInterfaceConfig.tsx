import React, { useState, useEffect, useCallback } from 'react';
import { supabase } from '../../utils/supabase';
import { Save, Search, CheckCircle, AlertCircle, ChevronDown, ChevronUp } from 'lucide-react';

interface LabAnalyte {
  id: string;
  name: string | null;
  analyte_name: string | null;
  display_name: string | null;
  code: string | null;
  unit: string | null;
  lab_specific_unit: string | null;
  category: string | null;
}

interface InterfaceConfig {
  id?: string;
  lab_analyte_id: string;
  instrument_unit: string;
  lims_unit: string;
  multiply_by: string;
  add_offset: string;
  // '' = keep whatever the analyzer sent; '0' = whole number.
  decimal_places: string;
  auto_verify: boolean;
  apply_to_ai_result_entry: boolean;
  apply_to_manual_result_entry: boolean;
  apply_to_quick_result_entry: boolean;
  notes: string;
  dirty: boolean;
  saving: boolean;
  saved: boolean;
  error: string | null;
}

export default function AnalyteInterfaceConfig({ labId }: { labId: string }) {
  const [analytes, setAnalytes] = useState<LabAnalyte[]>([]);
  const [configs, setConfigs] = useState<Map<string, InterfaceConfig>>(new Map());
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showOnlyConfigured, setShowOnlyConfigured] = useState(false);
  const [expandedAnalytes, setExpandedAnalytes] = useState<Set<string>>(new Set());

  const fetchAll = useCallback(async () => {
    setLoading(true);
    const [{ data: laRows }, { data: cfgRows }] = await Promise.all([
      supabase
        .from('lab_analytes')
        .select('id, name, analyte_name, display_name, code, unit, lab_specific_unit, category')
        .eq('lab_id', labId)
        .eq('is_active', true)
        .order('name'),
      supabase
        .from('lab_analyte_interface_config')
        .select('id, lab_analyte_id, instrument_unit, lims_unit, multiply_by, add_offset, decimal_places, auto_verify, apply_to_ai_result_entry, apply_to_manual_result_entry, apply_to_quick_result_entry, notes')
        .eq('lab_id', labId),
    ]);

    if (laRows) setAnalytes(laRows as LabAnalyte[]);

    const map = new Map<string, InterfaceConfig>();
    if (cfgRows) {
      for (const c of cfgRows) {
        map.set(c.lab_analyte_id, {
          id: c.id,
          lab_analyte_id: c.lab_analyte_id,
          instrument_unit: c.instrument_unit ?? '',
          lims_unit: c.lims_unit ?? '',
          multiply_by: String(c.multiply_by ?? '1'),
          add_offset: String(c.add_offset ?? '0'),
          decimal_places: c.decimal_places == null ? '' : String(c.decimal_places),
          auto_verify: c.auto_verify ?? false,
          apply_to_ai_result_entry: c.apply_to_ai_result_entry ?? false,
          apply_to_manual_result_entry: c.apply_to_manual_result_entry ?? false,
          apply_to_quick_result_entry: c.apply_to_quick_result_entry ?? false,
          notes: c.notes ?? '',
          dirty: false,
          saving: false,
          saved: false,
          error: null,
        });
      }
    }
    setConfigs(map);
    setLoading(false);
  }, [labId]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  function getConfig(laId: string): InterfaceConfig {
    return configs.get(laId) ?? {
      lab_analyte_id: laId,
      instrument_unit: '',
      lims_unit: '',
      multiply_by: '1',
      add_offset: '0',
      decimal_places: '',
      auto_verify: false,
      apply_to_ai_result_entry: false,
      apply_to_manual_result_entry: false,
      apply_to_quick_result_entry: false,
      notes: '',
      dirty: false,
      saving: false,
      saved: false,
      error: null,
    };
  }

  function updateConfig(laId: string, patch: Partial<InterfaceConfig>) {
    setConfigs(prev => {
      const next = new Map(prev);
      next.set(laId, { ...getConfig(laId), ...patch, dirty: true, saved: false });
      return next;
    });
  }

  async function saveConfig(laId: string) {
    const cfg = getConfig(laId);
    const multiplyNum = parseFloat(cfg.multiply_by);
    const offsetNum   = parseFloat(cfg.add_offset);

    if (isNaN(multiplyNum)) {
      setConfigs(prev => { const n = new Map(prev); n.set(laId, { ...cfg, error: 'Multiply By must be a number.' }); return n; });
      return;
    }

    setConfigs(prev => { const n = new Map(prev); n.set(laId, { ...cfg, saving: true, error: null }); return n; });

    const payload = {
      lab_id: labId,
      lab_analyte_id: laId,
      instrument_unit: cfg.instrument_unit.trim() || null,
      lims_unit:       cfg.lims_unit.trim()       || null,
      multiply_by:     multiplyNum,
      add_offset:      isNaN(offsetNum) ? 0 : offsetNum,
      decimal_places:  cfg.decimal_places === '' ? null : Number(cfg.decimal_places),
      auto_verify:     cfg.auto_verify,
      apply_to_ai_result_entry: cfg.apply_to_ai_result_entry,
      apply_to_manual_result_entry: cfg.apply_to_manual_result_entry,
      apply_to_quick_result_entry: cfg.apply_to_quick_result_entry,
      notes:           cfg.notes.trim() || null,
    };

    let err;
    if (cfg.id) {
      ({ error: err } = await supabase.from('lab_analyte_interface_config').update(payload).eq('id', cfg.id));
    } else {
      const { data: inserted, error: insertErr } = await supabase
        .from('lab_analyte_interface_config')
        .insert(payload)
        .select('id')
        .single();
      err = insertErr;
      if (!insertErr && inserted) {
        setConfigs(prev => { const n = new Map(prev); n.set(laId, { ...cfg, id: inserted.id }); return n; });
      }
    }

    setConfigs(prev => {
      const n = new Map(prev);
      n.set(laId, { ...getConfig(laId), saving: false, dirty: false, saved: !err, error: err?.message ?? null });
      return n;
    });

    if (!err) setTimeout(() => setConfigs(prev => {
      const n = new Map(prev);
      const c = n.get(laId); if (c) n.set(laId, { ...c, saved: false });
      return n;
    }), 2000);
  }

  const displayName = (a: LabAnalyte) =>
    a.display_name || a.name || a.analyte_name || a.code || a.id;

  const unit = (a: LabAnalyte) => a.lab_specific_unit || a.unit || '';

  const filtered = analytes.filter(a => {
    const q = search.toLowerCase();
    const matches = !q ||
      (a.name ?? '').toLowerCase().includes(q) ||
      (a.analyte_name ?? '').toLowerCase().includes(q) ||
      (a.display_name ?? '').toLowerCase().includes(q) ||
      (a.code ?? '').toLowerCase().includes(q) ||
      (a.category ?? '').toLowerCase().includes(q);
    if (!matches) return false;
    if (showOnlyConfigured) return configs.has(a.id);
    return true;
  });

  const configuredCount = analytes.filter(a => configs.has(a.id)).length;

  const toggleExpanded = (labAnalyteId: string) => {
    setExpandedAnalytes(prev => {
      const next = new Set(prev);
      if (next.has(labAnalyteId)) next.delete(labAnalyteId);
      else next.add(labAnalyteId);
      return next;
    });
  };

  const expandAllFiltered = () => {
    setExpandedAnalytes(new Set(filtered.map(a => a.id)));
  };

  const collapseAll = () => {
    setExpandedAnalytes(new Set());
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-base font-semibold text-gray-800">Analyte Interface Settings</h3>
          <p className="text-sm text-gray-500 mt-0.5">
            Configure unit conversion and auto-verify per analyte. Applied to every result received from instruments.
          </p>
        </div>
        <span className="text-xs text-gray-400 mt-1">{configuredCount} of {analytes.length} configured</span>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search analytes…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <button
          onClick={() => setShowOnlyConfigured(v => !v)}
          className={`px-3 py-2 text-sm rounded-lg border transition-colors ${showOnlyConfigured ? 'bg-blue-50 border-blue-300 text-blue-700' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}
        >
          Configured only
        </button>
        <button
          onClick={expandAllFiltered}
          disabled={filtered.length === 0}
          className="px-3 py-2 text-sm rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-40"
        >
          Expand all
        </button>
        <button
          onClick={collapseAll}
          disabled={expandedAnalytes.size === 0}
          className="px-3 py-2 text-sm rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-40"
        >
          Collapse all
        </button>
      </div>

      {loading ? (
        <div className="text-sm text-gray-400 py-6 text-center">Loading analytes…</div>
      ) : filtered.length === 0 ? (
        <div className="text-sm text-gray-400 py-6 text-center">No analytes found.</div>
      ) : (
        <div className="space-y-2">
          {filtered.map(a => {
            const cfg = getConfig(a.id);
            const isConfigured = configs.has(a.id);
            const isExpanded = expandedAnalytes.has(a.id);
            const isDefault =
              cfg.multiply_by === '1' &&
              cfg.add_offset === '0' &&
              !cfg.auto_verify &&
              !cfg.apply_to_ai_result_entry &&
              !cfg.apply_to_manual_result_entry &&
              !cfg.apply_to_quick_result_entry &&
              cfg.decimal_places === '' &&
              !cfg.instrument_unit &&
              !cfg.lims_unit;

            return (
              <div key={a.id} className={`bg-white border rounded-xl p-4 space-y-3 ${isConfigured && !isDefault ? 'border-blue-200' : 'border-gray-200'}`}>
                {/* Header row */}
                <div className="flex items-center justify-between">
                  <button
                    type="button"
                    onClick={() => toggleExpanded(a.id)}
                    className="min-w-0 flex-1 text-left"
                    aria-expanded={isExpanded}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      {isExpanded ? <ChevronUp className="h-4 w-4 shrink-0 text-gray-400" /> : <ChevronDown className="h-4 w-4 shrink-0 text-gray-400" />}
                      <span className="truncate text-sm font-semibold text-gray-800">{displayName(a)}</span>
                      {a.category && <span className="shrink-0 text-xs text-gray-400">{a.category}</span>}
                      {unit(a) && <span className="shrink-0 text-xs text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded">{unit(a)}</span>}
                      {isConfigured && !isDefault && (
                        <span className="shrink-0 rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">Configured</span>
                      )}
                    </div>
                    {!isExpanded && (
                      <div className="mt-1 truncate pl-6 text-xs text-gray-500">
                        Instrument: {cfg.instrument_unit || '-'} · LIMS: {cfg.lims_unit || '-'} · Multiply {cfg.multiply_by || '1'} · Offset {cfg.add_offset || '0'}
                        {cfg.decimal_places === '' ? '' : cfg.decimal_places === '0' ? ' · Whole number' : ` · ${cfg.decimal_places} dp`}
                        {cfg.auto_verify ? ' · Auto-verify' : ''}
                      </div>
                    )}
                  </button>
                  <div className="flex items-center gap-2">
                    {cfg.saved && <span className="flex items-center gap-1 text-xs text-green-600"><CheckCircle className="h-3.5 w-3.5" />Saved</span>}
                    {cfg.error && <span className="flex items-center gap-1 text-xs text-red-500"><AlertCircle className="h-3.5 w-3.5" />{cfg.error}</span>}
                    {cfg.dirty && (
                      <button
                        onClick={() => saveConfig(a.id)}
                        disabled={cfg.saving}
                        className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 text-white text-xs font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
                      >
                        <Save className="h-3.5 w-3.5" />
                        {cfg.saving ? 'Saving…' : 'Save'}
                      </button>
                    )}
                  </div>
                </div>

                {isExpanded && (
                  <>
                {/* Config fields */}
                <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">Instrument Unit</label>
                    <input
                      type="text"
                      placeholder={unit(a) || 'e.g. g/dL'}
                      value={cfg.instrument_unit}
                      onChange={e => updateConfig(a.id, { instrument_unit: e.target.value })}
                      className="w-full border border-gray-300 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">LIMS Unit</label>
                    <input
                      type="text"
                      placeholder={unit(a) || 'e.g. g/L'}
                      value={cfg.lims_unit}
                      onChange={e => updateConfig(a.id, { lims_unit: e.target.value })}
                      className="w-full border border-gray-300 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">Multiply By</label>
                    <input
                      type="number"
                      step="any"
                      value={cfg.multiply_by}
                      onChange={e => updateConfig(a.id, { multiply_by: e.target.value })}
                      className="w-full border border-gray-300 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">Add Offset</label>
                    <input
                      type="number"
                      step="any"
                      value={cfg.add_offset}
                      onChange={e => updateConfig(a.id, { add_offset: e.target.value })}
                      className="w-full border border-gray-300 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">Stored precision</label>
                    <select
                      value={cfg.decimal_places}
                      onChange={e => updateConfig(a.id, { decimal_places: e.target.value })}
                      className="w-full border border-gray-300 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="">As received</option>
                      <option value="0">0 — whole number</option>
                      <option value="1">1</option>
                      <option value="2">2</option>
                      <option value="3">3</option>
                      <option value="4">4</option>
                    </select>
                    <p className="mt-1 text-[11px] text-gray-400">
                      Trims the value <em>saved</em> from the instrument, after dilution and conversion.
                      This is not the report format — for that use Decimal Places on the analyte.
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-6">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={cfg.auto_verify}
                      onChange={e => updateConfig(a.id, { auto_verify: e.target.checked })}
                      className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    <span className="text-sm text-gray-700">Auto-verify results for this analyte</span>
                  </label>
                  <div className="flex-1">
                    <input
                      type="text"
                      placeholder="Notes (optional)"
                      value={cfg.notes}
                      onChange={e => updateConfig(a.id, { notes: e.target.value })}
                      className="w-full border border-gray-300 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </div>

                <div>
                  <p className="text-xs font-medium text-gray-500 mb-2">Apply conversion in result entry</p>
                  <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={cfg.apply_to_ai_result_entry}
                        onChange={e => updateConfig(a.id, { apply_to_ai_result_entry: e.target.checked })}
                        className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                      />
                      <span className="text-sm text-gray-700">AI-extracted values</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={cfg.apply_to_manual_result_entry}
                        onChange={e => updateConfig(a.id, { apply_to_manual_result_entry: e.target.checked })}
                        className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                      />
                      <span className="text-sm text-gray-700">AI Result Entry manual input</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={cfg.apply_to_quick_result_entry}
                        onChange={e => updateConfig(a.id, { apply_to_quick_result_entry: e.target.checked })}
                        className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                      />
                      <span className="text-sm text-gray-700">Quick Result Entry</span>
                    </label>
                  </div>
                </div>

                {/* Formula preview */}
                {(cfg.multiply_by !== '1' || cfg.add_offset !== '0') && (
                  <p className="text-xs text-blue-600 bg-blue-50 rounded px-2.5 py-1.5 font-mono">
                    lims_value = (instrument_value × {cfg.multiply_by || '1'}) + {cfg.add_offset || '0'}
                  </p>
                )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
