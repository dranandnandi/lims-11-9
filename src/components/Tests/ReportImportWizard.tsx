/**
 * ReportImportWizard
 *
 * Upload a lab report image/PDF → AI extracts analyte data → diff review → apply to DB.
 *
 * Pipeline:
 *   Gemini 2.5 Flash (vision) → extract from file
 *   Claude Haiku 4.5          → match to DB analytes → CRUD JSON
 */

import React, { useCallback, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  FileText,
  Loader2,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';
import { database, supabase } from '../../utils/supabase';
import { SAMPLE_TYPES } from '../../utils/sampleTypes';

const IMPORT_FUNCTION_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ai-report-import`;

// ─── Types ────────────────────────────────────────────────────────────────────

interface LabAnalyteUpdates {
  unit?: string;
  reference_range?: string;
  reference_range_male?: string;
  reference_range_female?: string;
}

interface TgaUpdates {
  section_heading?: string;
  sort_order?: number;
}

interface AnalyteChange {
  extracted_name: string;
  analyte_id: string;
  lab_analyte_id: string;
  matched_name: string;
  matched_code: string;
  match_confidence: number;
  is_currently_attached?: boolean;
  needs_attachment?: boolean;
  lab_analyte_updates: LabAnalyteUpdates;
  tga_updates: TgaUpdates;
  current_values: {
    unit: string;
    reference_range: string;
    reference_range_male: string;
    reference_range_female: string;
    section_heading: string;
    sort_order: number;
  };
  has_lab_analyte_changes: boolean;
  has_tga_changes: boolean;
}

interface UnmatchedAnalyte {
  extracted_name: string;
  unit: string;
  reference_range?: string;
  reference_range_male?: string;
  reference_range_female?: string;
  reference_range_pediatric?: string;
  section_header?: string;
  position: number;
}

interface MissingAttachedAnalyte {
  tga_id?: string;
  analyte_id: string;
  lab_analyte_id: string;
  name: string;
  code: string;
  section_heading: string;
  sort_order: number;
}

interface ImportResult {
  test_group_updates: { methodology?: string; sample_type?: string };
  test_group_current: { methodology: string; sample_type: string };
  has_test_group_changes: boolean;
  analyte_changes: AnalyteChange[];
  unmatched_analytes: UnmatchedAnalyte[];
  missing_attached_analytes?: MissingAttachedAnalyte[];
  extraction_notes?: string;
}

interface ExistingAnalyte {
  id: string;
  lab_analyte_id: string;
  name: string;
  code: string;
  category?: string;
  unit: string;
  reference_range: string;
  reference_range_male?: string | null;
  reference_range_female?: string | null;
}

interface ExistingTGA {
  id?: string;
  analyte_id: string;
  lab_analyte_id?: string | null;
  sort_order: number;
  section_heading: string;
}

interface Props {
  testGroupId: string;
  testGroup: { methodology?: string; sampleType?: string; sample_type?: string };
  existingAnalytes: ExistingAnalyte[];
  existingTga: ExistingTGA[];
  defaultAnalyteCategory?: string;
  onClose: () => void;
  onApplied: () => void; // reload form data after apply
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ConfidenceBadge({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const color =
    pct >= 90 ? 'bg-green-100 text-green-800' :
    pct >= 75 ? 'bg-yellow-100 text-yellow-800' :
    'bg-red-100 text-red-800';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${color}`}>
      {pct}%
    </span>
  );
}

function DiffValue({
  label, current, proposed,
}: { label: string; current: string | number; proposed: string | number | undefined }) {
  if (proposed === undefined || proposed === null || proposed === '') return null;
  const changed = String(proposed) !== String(current);
  return (
    <div className="flex items-start gap-2 text-xs">
      <span className="text-gray-500 w-32 shrink-0">{label}</span>
      {changed ? (
        <span className="flex items-center gap-1">
          <span className="line-through text-red-400">{current || '—'}</span>
          <span className="text-green-700 font-medium">→ {proposed}</span>
        </span>
      ) : (
        <span className="text-gray-400">{current || '—'} (unchanged)</span>
      )}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

const ReportImportWizard: React.FC<Props> = ({
  testGroupId,
  testGroup,
  existingAnalytes,
  existingTga,
  defaultAnalyteCategory,
  onClose,
  onApplied,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [stage, setStage] = useState<'upload' | 'loading' | 'review' | 'applying' | 'done'>('upload');
  const [loadingMessage, setLoadingMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  // Selection state — track which items user wants to apply
  const [applyTestGroup, setApplyTestGroup] = useState(true);
  const [selectedChanges, setSelectedChanges] = useState<Set<string>>(new Set()); // keyed by lab_analyte_id
  const [selectedNewAnalytes, setSelectedNewAnalytes] = useState<Set<string>>(new Set());
  const [showUnmatched, setShowUnmatched] = useState(false);

  const [applyLog, setApplyLog] = useState<string[]>([]);

  const getUnmatchedKey = (u: UnmatchedAnalyte) => `${u.position}:${u.extracted_name}:${u.unit}`;

  // ── File handling ──────────────────────────────────────────────────────────

  const processFile = useCallback(async (file: File) => {
    const allowedTypes = [
      'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf',
    ];
    if (!allowedTypes.includes(file.type)) {
      setError('Unsupported file type. Please upload JPEG, PNG, WebP, HEIC, or PDF.');
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      setError('File size must be under 20 MB.');
      return;
    }

    setError(null);
    setStage('loading');
    setLoadingMessage('Reading file…');

    // Convert to base64
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        resolve(dataUrl.split(',')[1]); // strip data:...;base64, prefix
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

    setLoadingMessage('Stage 1 — Gemini 2.5 Flash is reading the report…');

    const payload = {
      file_base64: base64,
      file_mime_type: file.type,
      test_group: {
        methodology: testGroup.methodology ?? '',
        sample_type: testGroup.sample_type ?? testGroup.sampleType ?? '',
      },
      existing_analytes: existingAnalytes,
      existing_tga: existingTga,
      // sample_type is an enum column — tell the AI what it may return
      allowed_sample_types: SAMPLE_TYPES,
    };

    let response: Response;
    try {
      response = await fetch(IMPORT_FUNCTION_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify(payload),
      });
    } catch (networkErr) {
      setError('Network error — could not reach the import service.');
      setStage('upload');
      return;
    }

    setLoadingMessage('Stage 2 — Claude Haiku is matching analytes…');

    const data = await response.json();

    if (!response.ok) {
      setError(data.error || 'Import service returned an error.');
      setStage('upload');
      return;
    }

    const importResult = data as ImportResult;
    setResult(importResult);

    // Pre-select all changes that have actual differences
    const initial = new Set<string>();
    for (const c of importResult.analyte_changes ?? []) {
      if (c.has_lab_analyte_changes || c.has_tga_changes || c.needs_attachment) {
        initial.add(c.lab_analyte_id);
      }
    }
    setSelectedChanges(initial);
    setSelectedNewAnalytes(new Set((importResult.unmatched_analytes ?? []).map(getUnmatchedKey)));
    setApplyTestGroup(importResult.has_test_group_changes);
    setStage('review');
  }, [testGroup, existingAnalytes, existingTga]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
  }, [processFile]);

  // ── Apply changes ──────────────────────────────────────────────────────────

  const applyChanges = async () => {
    if (!result) return;
    setStage('applying');
    const log: string[] = [];
    let ok = 0;
    let fail = 0;

    // 1. Test group updates
    if (applyTestGroup && result.has_test_group_changes) {
      const updates = result.test_group_updates;
      if (Object.keys(updates).length > 0) {
        const { error: tgErr } = await supabase
          .from('test_groups')
          .update(updates)
          .eq('id', testGroupId);
        if (tgErr) {
          log.push(`✗ Test group update failed: ${tgErr.message}`);
          fail++;
        } else {
          log.push(`✓ Test group fields updated (${Object.keys(updates).join(', ')})`);
          ok++;
        }
      }
    }

    // 2. Analyte-level updates
    for (const change of result.analyte_changes ?? []) {
      if (!selectedChanges.has(change.lab_analyte_id)) continue;

      // 2a. lab_analytes update
      if (change.has_lab_analyte_changes && Object.keys(change.lab_analyte_updates).length > 0) {
        const { error: laErr } = await supabase
          .from('lab_analytes')
          .update(change.lab_analyte_updates)
          .eq('id', change.lab_analyte_id);
        if (laErr) {
          log.push(`✗ ${change.matched_name} — lab_analyte update failed: ${laErr.message}`);
          fail++;
        } else {
          log.push(`✓ ${change.matched_name} — ref ranges/unit updated`);
          ok++;
        }
      }

      // 2b. test_group_analytes update
      if (change.needs_attachment || (change.has_tga_changes && Object.keys(change.tga_updates).length > 0)) {
        const tgaPayload = {
          test_group_id: testGroupId,
          analyte_id: change.analyte_id,
          lab_analyte_id: change.lab_analyte_id,
          sort_order: change.tga_updates.sort_order ?? change.current_values.sort_order ?? 0,
          section_heading: change.tga_updates.section_heading ?? change.current_values.section_heading ?? null,
          is_visible: true,
        };
        // The table is UNIQUE (test_group_id, analyte_id) — match the existing row
        // on analyte_id, not just lab_analyte_id, or we insert a duplicate.
        const existingTgaRow = existingTga.find(
          (row) => row.analyte_id === change.analyte_id ||
            (!!row.lab_analyte_id && row.lab_analyte_id === change.lab_analyte_id)
        );
        const tgaQuery = existingTgaRow?.id
          ? supabase.from('test_group_analytes').update(tgaPayload).eq('id', existingTgaRow.id)
          : supabase
              .from('test_group_analytes')
              .upsert(tgaPayload, { onConflict: 'test_group_id,analyte_id' });
        const { error: tgaErr } = await tgaQuery;
        if (tgaErr) {
          log.push(`✗ ${change.matched_name} — test group attach/update failed: ${tgaErr.message}`);
          fail++;
        } else {
          log.push(
            change.needs_attachment
              ? `✓ ${change.matched_name} — attached to test group with report order/section`
              : `✓ ${change.matched_name} — sort order/section heading updated`
          );
          ok++;
        }
      }
    }

    // 3. Create new analytes and attach them to this test group
    for (const unmatched of result.unmatched_analytes ?? []) {
      if (!selectedNewAnalytes.has(getUnmatchedKey(unmatched))) continue;

      const createPayload: Record<string, any> = {
        name: unmatched.extracted_name,
        unit: unmatched.unit || '',
        reference_range: unmatched.reference_range || '',
        reference_range_male: unmatched.reference_range_male || undefined,
        reference_range_female: unmatched.reference_range_female || undefined,
        category: defaultAnalyteCategory || 'General',
        is_active: true,
        is_global: false,
      };

      if (unmatched.reference_range_pediatric) {
        createPayload.ref_range_knowledge = {
          imported_from_report_ai: true,
          pediatric_reference_range: unmatched.reference_range_pediatric,
        };
      }

      const { data: createdAnalyte, error: createErr } = await database.analytes.create(createPayload);
      if (createErr || !createdAnalyte?.id || !createdAnalyte?.lab_analyte_id) {
        log.push(`✗ ${unmatched.extracted_name} — analyte creation failed: ${createErr?.message || 'Unknown error'}`);
        fail++;
        continue;
      }

      const { error: attachErr } = await supabase
        .from('test_group_analytes')
        .upsert(
          {
            test_group_id: testGroupId,
            analyte_id: createdAnalyte.id,
            lab_analyte_id: createdAnalyte.lab_analyte_id,
            sort_order: unmatched.position || 0,
            section_heading: unmatched.section_header || null,
            is_visible: true,
          },
          { onConflict: 'test_group_id,analyte_id' }
        );

      if (attachErr) {
        log.push(`✗ ${unmatched.extracted_name} — created but failed to attach: ${attachErr.message}`);
        fail++;
        continue;
      }

      log.push(`✓ ${unmatched.extracted_name} — created and attached to test group`);
      ok++;
    }

    log.unshift(`Applied ${ok} change${ok !== 1 ? 's' : ''}, ${fail} error${fail !== 1 ? 's' : ''}.`);
    setApplyLog(log);
    setStage('done');
    if (fail === 0) {
      // auto-close after success in 1.5s to reload parent
      setTimeout(() => {
        onApplied();
        onClose();
      }, 1500);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-purple-600" />
            <h2 className="text-lg font-semibold text-gray-900">AI Report Import</h2>
            <span className="text-xs text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full">
              Gemini 2.5 Flash + Claude Haiku
            </span>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="overflow-y-auto flex-1 px-6 py-5 space-y-5">

          {/* ── UPLOAD STAGE ── */}
          {stage === 'upload' && (
            <>
              <p className="text-sm text-gray-600">
                Upload your lab's current report format (image or PDF). AI will extract analyte names,
                reference ranges, units, section headers, and sort order — then match them to your existing
                test group configuration and show you exactly what would change.
              </p>

              {error && (
                <div className="flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">
                  <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                  {error}
                </div>
              )}

              <div
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className={`border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition-colors ${
                  dragOver
                    ? 'border-purple-400 bg-purple-50'
                    : 'border-gray-300 hover:border-purple-400 hover:bg-gray-50'
                }`}
              >
                <Upload className="h-10 w-10 text-gray-400 mx-auto mb-3" />
                <p className="text-sm font-medium text-gray-700">
                  Drop your lab report here or click to browse
                </p>
                <p className="text-xs text-gray-500 mt-1">
                  Supports: JPEG, PNG, WebP, HEIC, PDF · Max 20 MB
                </p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) processFile(f);
                    e.target.value = '';
                  }}
                />
              </div>

              <div className="bg-blue-50 rounded-lg p-4 text-xs text-blue-700 space-y-1">
                <p className="font-medium">What gets extracted &amp; compared:</p>
                <ul className="list-disc list-inside space-y-0.5 text-blue-600">
                  <li>Analyte reference ranges (M/F/combined) → updates <code>lab_analytes</code></li>
                  <li>Unit of measurement → updates <code>lab_analytes</code></li>
                  <li>Section headers (report groupings) → updates <code>test_group_analytes.section_heading</code></li>
                  <li>Print order of analytes → updates <code>test_group_analytes.sort_order</code></li>
                  <li>Methodology &amp; sample type → updates <code>test_groups</code></li>
                </ul>
                <p className="text-blue-500 mt-2">You review every change before anything is saved.</p>
              </div>
            </>
          )}

          {/* ── LOADING STAGE ── */}
          {stage === 'loading' && (
            <div className="flex flex-col items-center justify-center py-16 space-y-4">
              <Loader2 className="h-10 w-10 text-purple-500 animate-spin" />
              <p className="text-sm font-medium text-gray-700">{loadingMessage}</p>
              <div className="flex gap-2 text-xs text-gray-400">
                <span className={loadingMessage.includes('Stage 1') ? 'text-purple-600 font-medium' : ''}>
                  Stage 1: Gemini 2.5 Flash
                </span>
                <span>→</span>
                <span className={loadingMessage.includes('Stage 2') ? 'text-purple-600 font-medium' : ''}>
                  Stage 2: Claude Haiku
                </span>
              </div>
            </div>
          )}

          {/* ── REVIEW STAGE ── */}
          {stage === 'review' && result && (
            <>
              {result.extraction_notes && (
                <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-4 py-2">
                  <span className="font-medium">AI note: </span>{result.extraction_notes}
                </div>
              )}

              {/* Test Group Fields */}
              {result.has_test_group_changes && (
                <div className="border border-gray-200 rounded-lg overflow-hidden">
                  <div className="flex items-center justify-between bg-gray-50 px-4 py-3 border-b border-gray-200">
                    <span className="text-sm font-medium text-gray-800">Test Group Fields</span>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={applyTestGroup}
                        onChange={(e) => setApplyTestGroup(e.target.checked)}
                        className="h-4 w-4 rounded text-purple-600"
                      />
                      <span className="text-xs text-gray-600">Apply</span>
                    </label>
                  </div>
                  <div className="px-4 py-3 space-y-2">
                    <DiffValue
                      label="Methodology"
                      current={result.test_group_current.methodology}
                      proposed={result.test_group_updates.methodology}
                    />
                    <DiffValue
                      label="Sample Type"
                      current={result.test_group_current.sample_type}
                      proposed={result.test_group_updates.sample_type}
                    />
                  </div>
                </div>
              )}

              {/* Analyte Changes */}
              {result.analyte_changes.length > 0 && (
                <div className="border border-gray-200 rounded-lg overflow-hidden">
                  <div className="flex items-center justify-between bg-gray-50 px-4 py-3 border-b border-gray-200">
                    <span className="text-sm font-medium text-gray-800">
                      Analyte Changes ({result.analyte_changes.length})
                    </span>
                    <div className="flex gap-3 text-xs text-gray-500">
                      <button
                        type="button"
                        onClick={() => setSelectedChanges(new Set(result.analyte_changes.map(c => c.lab_analyte_id)))}
                        className="text-purple-600 hover:underline"
                      >
                        Select all
                      </button>
                      <button
                        type="button"
                        onClick={() => setSelectedChanges(new Set())}
                        className="text-gray-500 hover:underline"
                      >
                        None
                      </button>
                    </div>
                  </div>

                  <div className="divide-y divide-gray-100 max-h-72 overflow-y-auto">
                    {result.analyte_changes.map((change) => (
                      <div key={change.lab_analyte_id} className="px-4 py-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex items-start gap-3 min-w-0">
                            <input
                              type="checkbox"
                              checked={selectedChanges.has(change.lab_analyte_id)}
                              onChange={(e) => {
                                const next = new Set(selectedChanges);
                                if (e.target.checked) next.add(change.lab_analyte_id);
                                else next.delete(change.lab_analyte_id);
                                setSelectedChanges(next);
                              }}
                              className="h-4 w-4 rounded text-purple-600 mt-0.5 shrink-0"
                            />
                            <div className="min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-sm font-medium text-gray-800">
                                  {change.matched_name}
                                </span>
                                <span className="text-xs text-gray-400">({change.matched_code})</span>
                                {change.needs_attachment && (
                                  <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">
                                    Will attach to this group
                                  </span>
                                )}
                                {change.extracted_name !== change.matched_name && (
                                  <span className="text-xs text-gray-400 italic">
                                    extracted as "{change.extracted_name}"
                                  </span>
                                )}
                                <ConfidenceBadge value={change.match_confidence} />
                              </div>
                              <div className="mt-2 space-y-1">
                                {change.has_lab_analyte_changes && (
                                  <>
                                    <DiffValue label="Unit" current={change.current_values.unit} proposed={change.lab_analyte_updates.unit} />
                                    <DiffValue label="Ref range" current={change.current_values.reference_range} proposed={change.lab_analyte_updates.reference_range} />
                                    <DiffValue label="Ref range (M)" current={change.current_values.reference_range_male} proposed={change.lab_analyte_updates.reference_range_male} />
                                    <DiffValue label="Ref range (F)" current={change.current_values.reference_range_female} proposed={change.lab_analyte_updates.reference_range_female} />
                                  </>
                                )}
                                {change.has_tga_changes && (
                                  <>
                                    <DiffValue label="Section heading" current={change.current_values.section_heading} proposed={change.tga_updates.section_heading} />
                                    <DiffValue label="Sort order" current={change.current_values.sort_order} proposed={change.tga_updates.sort_order} />
                                  </>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Nothing to change */}
              {!result.has_test_group_changes && result.analyte_changes.length === 0 && (
                <div className="flex flex-col items-center py-8 text-center text-gray-500">
                  <CheckCircle className="h-8 w-8 text-green-500 mb-2" />
                  <p className="text-sm font-medium">Everything is already up to date!</p>
                  <p className="text-xs text-gray-400 mt-1">
                    No differences found between your report format and current configuration.
                  </p>
                </div>
              )}

              {(result.missing_attached_analytes?.length ?? 0) > 0 && (
                <div className="border border-orange-200 rounded-lg bg-orange-50 px-4 py-3">
                  <p className="text-sm font-medium text-orange-800">
                    {result.missing_attached_analytes!.length} attached analyte
                    {result.missing_attached_analytes!.length !== 1 ? 's are' : ' is'} missing from this report
                  </p>
                  <p className="text-xs text-orange-700 mt-1">
                    Nothing will be removed automatically. Review these test-group-specific analytes manually:
                  </p>
                  <p className="text-xs text-orange-800 mt-2">
                    {result.missing_attached_analytes!.map((item) => item.name).join(', ')}
                  </p>
                </div>
              )}

              {/* New analytes to create */}
              {result.unmatched_analytes.length > 0 && (
                <div className="border border-amber-200 rounded-lg overflow-hidden">
                  <button
                    type="button"
                    className="w-full flex items-center justify-between bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800"
                    onClick={() => setShowUnmatched((v) => !v)}
                  >
                    <span>
                      <FileText className="inline h-4 w-4 mr-1" />
                      {result.unmatched_analytes.length} new analyte{result.unmatched_analytes.length !== 1 ? 's' : ''} not found in your lab
                      <span className="text-xs font-normal ml-1">(can be created and attached)</span>
                    </span>
                    {showUnmatched ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  </button>
                  {showUnmatched && (
                    <div className="divide-y divide-amber-100 max-h-40 overflow-y-auto">
                      {result.unmatched_analytes.map((u, i) => (
                        <div key={getUnmatchedKey(u)} className="px-4 py-2 text-xs text-gray-600 flex items-center gap-3">
                          <input
                            type="checkbox"
                            checked={selectedNewAnalytes.has(getUnmatchedKey(u))}
                            onChange={(e) => {
                              const next = new Set(selectedNewAnalytes);
                              if (e.target.checked) next.add(getUnmatchedKey(u));
                              else next.delete(getUnmatchedKey(u));
                              setSelectedNewAnalytes(next);
                            }}
                            className="h-4 w-4 rounded text-purple-600 shrink-0"
                          />
                          <span className="font-medium">{u.extracted_name}</span>
                          <span className="text-gray-400">{u.unit || 'No unit'}</span>
                          {u.reference_range && <span className="text-gray-400">{u.reference_range}</span>}
                          {u.reference_range_male && <span className="text-gray-400">M: {u.reference_range_male}</span>}
                          {u.reference_range_female && <span className="text-gray-400">F: {u.reference_range_female}</span>}
                          {u.reference_range_pediatric && <span className="text-gray-400">P: {u.reference_range_pediatric}</span>}
                          {u.section_header && <span className="text-gray-400 italic">{u.section_header}</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {/* ── APPLYING STAGE ── */}
          {stage === 'applying' && (
            <div className="flex flex-col items-center justify-center py-16 space-y-4">
              <Loader2 className="h-8 w-8 text-purple-500 animate-spin" />
              <p className="text-sm text-gray-600">Applying changes…</p>
            </div>
          )}

          {/* ── DONE STAGE ── */}
          {stage === 'done' && (
            <div className="space-y-3">
              <div className={`flex items-center gap-2 text-sm font-medium ${
                applyLog[0]?.includes('0 error') ? 'text-green-700' : 'text-amber-700'
              }`}>
                <CheckCircle className="h-5 w-5" />
                {applyLog[0]}
              </div>
              <div className="bg-gray-50 rounded-lg p-4 max-h-60 overflow-y-auto">
                {applyLog.slice(1).map((line, i) => (
                  <p key={i} className={`text-xs ${line.startsWith('✓') ? 'text-green-700' : 'text-red-600'}`}>
                    {line}
                  </p>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-gray-200 bg-gray-50">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900"
          >
            {stage === 'done' ? 'Close' : 'Cancel'}
          </button>

          {stage === 'review' && result && (
            <div className="flex items-center gap-3">
              <span className="text-xs text-gray-500">
                {selectedChanges.size} analyte change{selectedChanges.size !== 1 ? 's' : ''} selected
                {selectedNewAnalytes.size > 0 ? ` + ${selectedNewAnalytes.size} new analyte${selectedNewAnalytes.size !== 1 ? 's' : ''}` : ''}
                {applyTestGroup && result.has_test_group_changes ? ' + test group fields' : ''}
              </span>
              <button
                type="button"
                onClick={applyChanges}
                disabled={
                  selectedChanges.size === 0 &&
                  selectedNewAnalytes.size === 0 &&
                  (!applyTestGroup || !result.has_test_group_changes)
                }
                className="px-5 py-2 bg-purple-600 text-white text-sm font-medium rounded-lg hover:bg-purple-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
              >
                Apply Selected Changes
              </button>
            </div>
          )}

          {stage === 'done' && applyLog[0]?.includes('error') && !applyLog[0]?.includes('0 error') && (
            <button
              type="button"
              onClick={() => { onApplied(); onClose(); }}
              className="px-4 py-2 bg-purple-600 text-white text-sm rounded-lg hover:bg-purple-700"
            >
              Close &amp; Reload
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default ReportImportWizard;
