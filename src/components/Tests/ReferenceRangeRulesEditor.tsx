/**
 * Config UI for the deterministic (non-AI) reference range rules.
 *
 * One row per rule: who it applies to (gender / age band / sample condition /
 * pregnancy) and what range they get. The preview strip at the bottom answers
 * the only question that matters while configuring — "what would this patient
 * actually get?" — without leaving the form.
 *
 * Rules are saved immediately against lab_analyte_reference_ranges rather than
 * waiting for the parent form's save, because they hang off lab_analyte_id and
 * a brand-new analyte has no id to hang them on yet.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, AlertTriangle, Info, Loader2, FlaskConical } from 'lucide-react';
import { supabase } from '../../utils/supabase';
import {
  agePartsToDays,
  daysToAgeParts,
  findRuleConflicts,
  resolveReferenceRange,
  type ReferenceRangeRule,
} from '../../utils/referenceRangeResolver';

interface Props {
  labAnalyteId?: string | null;
  analyteName?: string;
  unit?: string;
  /** The analyte's plain range, used as the fallback when no rule matches. */
  defaultRange?: string | null;
  /** Legacy gender columns, shown in the preview so the fallback is honest. */
  defaultRangeMale?: string | null;
  defaultRangeFemale?: string | null;
}

type AgeUnit = 'days' | 'months' | 'years';

interface DraftRule extends ReferenceRangeRule {
  /** Client-side only: age is edited as value+unit, stored as days. */
  _minValue: string;
  _minUnit: AgeUnit;
  _maxValue: string;
  _maxUnit: AgeUnit;
  _dirty?: boolean;
  _isNew?: boolean;
}

const GENDER_OPTIONS = [
  { value: '', label: 'Any' },
  { value: 'male', label: 'Male' },
  { value: 'female', label: 'Female' },
  { value: 'other', label: 'Other' },
];

const PREGNANCY_OPTIONS = [
  { value: '', label: 'Any' },
  { value: 'true', label: 'Pregnant' },
  { value: 'false', label: 'Not pregnant' },
];

const AGE_UNITS: AgeUnit[] = ['days', 'months', 'years'];

const toDraft = (rule: ReferenceRangeRule): DraftRule => {
  const min = daysToAgeParts(rule.age_min_days);
  const max = daysToAgeParts(rule.age_max_days);
  return {
    ...rule,
    _minValue: min ? String(min.value) : '',
    _minUnit: min?.unit ?? 'years',
    _maxValue: max ? String(max.value) : '',
    _maxUnit: max?.unit ?? 'years',
  };
};

const toRule = (draft: DraftRule): ReferenceRangeRule => ({
  ...draft,
  age_min_days: draft._minValue === '' ? null : agePartsToDays(draft._minValue, draft._minUnit),
  age_max_days: draft._maxValue === '' ? null : agePartsToDays(draft._maxValue, draft._maxUnit),
});

const emptyDraft = (): DraftRule => ({
  id: `new-${Math.random().toString(36).slice(2, 10)}`,
  gender: null,
  age_min_days: null,
  age_max_days: null,
  sample_condition: null,
  pregnancy: null,
  range_text: '',
  range_low: null,
  range_high: null,
  low_critical: null,
  high_critical: null,
  priority: 0,
  is_active: true,
  _minValue: '',
  _minUnit: 'years',
  _maxValue: '',
  _maxUnit: 'years',
  _isNew: true,
  _dirty: true,
});

const errorMessage = (err: unknown, fallback: string): string => {
  if (err && typeof err === 'object' && 'message' in err) {
    const message = String((err as { message?: unknown }).message || '').trim();
    if (message) return message;
  }
  return fallback;
};

const numberOrNull = (value: string): number | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
};

export const ReferenceRangeRulesEditor: React.FC<Props> = ({
  labAnalyteId,
  analyteName,
  unit,
  defaultRange,
  defaultRangeMale,
  defaultRangeFemale,
}) => {
  const [drafts, setDrafts] = useState<DraftRule[]>([]);
  const [conditionOptions, setConditionOptions] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Preview controls
  const [previewGender, setPreviewGender] = useState('female');
  const [previewAge, setPreviewAge] = useState('35');
  const [previewAgeUnit, setPreviewAgeUnit] = useState<AgeUnit>('years');
  const [previewCondition, setPreviewCondition] = useState('');
  const [previewPregnancy, setPreviewPregnancy] = useState('');

  const load = useCallback(async () => {
    if (!labAnalyteId) {
      setDrafts([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const { data, error: err } = await supabase
        .from('lab_analyte_reference_ranges')
        .select('*')
        .eq('lab_analyte_id', labAnalyteId)
        .order('priority', { ascending: false })
        .order('created_at', { ascending: true });
      if (err) throw err;
      setDrafts(((data || []) as ReferenceRangeRule[]).map(toDraft));
    } catch (err) {
      setError(errorMessage(err, 'Could not load reference range rules.'));
    } finally {
      setLoading(false);
    }
  }, [labAnalyteId]);

  useEffect(() => { load(); }, [load]);

  // Sample condition vocabulary comes from the test groups this analyte sits in,
  // so the rule and the order screen speak the same words.
  useEffect(() => {
    if (!labAnalyteId) return;
    (async () => {
      try {
        const { data } = await supabase
          .from('test_group_analytes')
          .select('test_groups(sample_condition_options)')
          .eq('lab_analyte_id', labAnalyteId);
        const options = new Set<string>();
        type ConditionRow = { test_groups?: { sample_condition_options?: unknown } | null };
        for (const row of (data || []) as ConditionRow[]) {
          const list = row?.test_groups?.sample_condition_options;
          if (Array.isArray(list)) list.forEach((o: string) => { if (o?.trim()) options.add(o.trim()); });
        }
        setConditionOptions([...options].sort());
      } catch { /* free-text entry still works */ }
    })();
  }, [labAnalyteId]);

  const rules = useMemo(() => drafts.map(toRule), [drafts]);
  const conflicts = useMemo(() => findRuleConflicts(rules), [rules]);

  const preview = useMemo(() => resolveReferenceRange(
    rules,
    {
      gender: previewGender || null,
      ageInDays: previewAge === '' ? null : agePartsToDays(previewAge, previewAgeUnit),
      sampleCondition: previewCondition || null,
      pregnancy: previewPregnancy === '' ? null : previewPregnancy === 'true',
    },
    {
      reference_range: defaultRange,
      reference_range_male: defaultRangeMale,
      reference_range_female: defaultRangeFemale,
    },
  ), [rules, previewGender, previewAge, previewAgeUnit, previewCondition, previewPregnancy,
      defaultRange, defaultRangeMale, defaultRangeFemale]);

  const patch = (id: string, changes: Partial<DraftRule>) =>
    setDrafts(prev => prev.map(d => (d.id === id ? { ...d, ...changes, _dirty: true } : d)));

  const addRow = () => setDrafts(prev => [...prev, emptyDraft()]);

  const removeRow = async (id: string) => {
    const draft = drafts.find(d => d.id === id);
    setDrafts(prev => prev.filter(d => d.id !== id));
    if (draft && !draft._isNew) {
      const { error: err } = await supabase.from('lab_analyte_reference_ranges').delete().eq('id', id);
      if (err) {
        setError(`Could not delete the rule: ${err.message}`);
        load();
      }
    }
  };

  const saveAll = async () => {
    if (!labAnalyteId) return;
    const dirty = drafts.filter(d => d._dirty);
    if (dirty.length === 0) {
      setNotice('No changes to save.');
      return;
    }

    const blank = dirty.find(d => !String(d.range_text || '').trim());
    if (blank) {
      setError('Every rule needs a range. Fill it in or remove the row.');
      return;
    }

    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      for (const draft of dirty) {
        const rule = toRule(draft);
        const payload = {
          lab_analyte_id: labAnalyteId,
          // lab_id is forced to the parent analyte's lab by a trigger; sending a
          // placeholder keeps the NOT NULL constraint satisfied on insert.
          gender: rule.gender || null,
          age_min_days: rule.age_min_days,
          age_max_days: rule.age_max_days,
          sample_condition: String(rule.sample_condition || '').trim() || null,
          pregnancy: rule.pregnancy,
          range_text: String(rule.range_text).trim(),
          range_low: rule.range_low,
          range_high: rule.range_high,
          low_critical: rule.low_critical,
          high_critical: rule.high_critical,
          priority: Number(rule.priority ?? 0),
          is_active: rule.is_active !== false,
          notes: rule.notes || null,
        };

        if (draft._isNew) {
          const { data: parent } = await supabase
            .from('lab_analytes').select('lab_id').eq('id', labAnalyteId).single();
          const { error: err } = await supabase
            .from('lab_analyte_reference_ranges')
            .insert({ ...payload, lab_id: parent?.lab_id });
          if (err) throw err;
        } else {
          const { error: err } = await supabase
            .from('lab_analyte_reference_ranges').update(payload).eq('id', draft.id);
          if (err) throw err;
        }
      }
      await load();
      setNotice(`Saved ${dirty.length} rule${dirty.length === 1 ? '' : 's'}.`);
    } catch (err) {
      // The unique index on the predicate set is the likely culprit; say so
      // plainly rather than surfacing a raw constraint name.
      const message = errorMessage(err, 'Could not save the rules.');
      setError(
        message.includes('uq_lab_analyte_ref_range_predicates')
          ? 'Two rules have identical conditions. Change one of them — the resolver cannot choose between them.'
          : message,
      );
    } finally {
      setSaving(false);
    }
  };

  if (!labAnalyteId) {
    return (
      <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-4 text-sm text-gray-600">
        <div className="flex items-center gap-2 font-medium text-gray-700">
          <Info className="h-4 w-4" />
          Reference Range Rules
        </div>
        <p className="mt-1">
          Save this analyte first. Rules for gender, age and sample condition attach to the
          saved lab analyte.
        </p>
      </div>
    );
  }

  const dirtyCount = drafts.filter(d => d._dirty).length;

  return (
    <div className="rounded-lg border border-indigo-200 bg-indigo-50/50 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="flex items-center gap-2 text-base font-medium text-gray-900">
            <FlaskConical className="h-4 w-4 text-indigo-600" />
            Reference Range Rules
          </h4>
          <p className="mt-0.5 text-xs text-gray-600">
            Deterministic — no AI. The most specific matching rule wins
            (sample condition &gt; gender &gt; age &gt; pregnancy). When nothing matches,
            the analyte&apos;s default range is used.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={addRow}
            className="inline-flex items-center gap-1 rounded border border-indigo-300 bg-white px-3 py-1.5 text-sm font-medium text-indigo-700 hover:bg-indigo-50"
          >
            <Plus className="h-4 w-4" /> Add rule
          </button>
          <button
            type="button"
            onClick={saveAll}
            disabled={saving || dirtyCount === 0}
            className="inline-flex items-center gap-1 rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-gray-300"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {dirtyCount > 0 ? `Save ${dirtyCount} rule${dirtyCount === 1 ? '' : 's'}` : 'Saved'}
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
      )}
      {notice && !error && (
        <div className="mb-3 rounded border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">{notice}</div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 py-6 text-sm text-gray-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading rules…
        </div>
      ) : drafts.length === 0 ? (
        <p className="rounded border border-dashed border-indigo-200 bg-white px-3 py-4 text-center text-sm text-gray-500">
          No rules yet — every patient gets the default range
          {defaultRange ? <> (<span className="font-mono">{defaultRange}</span>)</> : null}.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-gray-500">
                <th className="pb-2 pr-2">Gender</th>
                <th className="pb-2 pr-2">Age from</th>
                <th className="pb-2 pr-2">Age to</th>
                <th className="pb-2 pr-2">Condition</th>
                <th className="pb-2 pr-2">Pregnancy</th>
                <th className="pb-2 pr-2">Range</th>
                <th className="pb-2 pr-2">Crit. low</th>
                <th className="pb-2 pr-2">Crit. high</th>
                <th className="pb-2 pr-2">Priority</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {drafts.map(draft => (
                <tr key={draft.id} className={draft._dirty ? 'bg-amber-50/60' : ''}>
                  <td className="py-1 pr-2">
                    <select
                      value={draft.gender || ''}
                      onChange={e => patch(draft.id, { gender: e.target.value || null })}
                      className="w-full rounded border border-gray-300 px-2 py-1"
                    >
                      {GENDER_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </td>
                  <td className="py-1 pr-2">
                    <div className="flex gap-1">
                      <input
                        type="number" min={0}
                        value={draft._minValue}
                        onChange={e => patch(draft.id, { _minValue: e.target.value })}
                        placeholder="any"
                        className="w-16 rounded border border-gray-300 px-2 py-1"
                      />
                      <select
                        value={draft._minUnit}
                        onChange={e => patch(draft.id, { _minUnit: e.target.value as AgeUnit })}
                        className="rounded border border-gray-300 px-1 py-1 text-xs"
                      >
                        {AGE_UNITS.map(u => <option key={u} value={u}>{u}</option>)}
                      </select>
                    </div>
                  </td>
                  <td className="py-1 pr-2">
                    <div className="flex gap-1">
                      <input
                        type="number" min={0}
                        value={draft._maxValue}
                        onChange={e => patch(draft.id, { _maxValue: e.target.value })}
                        placeholder="any"
                        className="w-16 rounded border border-gray-300 px-2 py-1"
                      />
                      <select
                        value={draft._maxUnit}
                        onChange={e => patch(draft.id, { _maxUnit: e.target.value as AgeUnit })}
                        className="rounded border border-gray-300 px-1 py-1 text-xs"
                      >
                        {AGE_UNITS.map(u => <option key={u} value={u}>{u}</option>)}
                      </select>
                    </div>
                  </td>
                  <td className="py-1 pr-2">
                    <input
                      list={`conditions-${labAnalyteId}`}
                      value={draft.sample_condition || ''}
                      onChange={e => patch(draft.id, { sample_condition: e.target.value || null })}
                      placeholder="any"
                      className="w-36 rounded border border-gray-300 px-2 py-1"
                    />
                  </td>
                  <td className="py-1 pr-2">
                    <select
                      value={draft.pregnancy === null || draft.pregnancy === undefined ? '' : String(draft.pregnancy)}
                      onChange={e => patch(draft.id, { pregnancy: e.target.value === '' ? null : e.target.value === 'true' })}
                      className="rounded border border-gray-300 px-2 py-1"
                    >
                      {PREGNANCY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </td>
                  <td className="py-1 pr-2">
                    <input
                      value={draft.range_text || ''}
                      onChange={e => patch(draft.id, { range_text: e.target.value })}
                      placeholder="70 - 100"
                      className="w-32 rounded border border-gray-300 px-2 py-1 font-mono"
                    />
                  </td>
                  <td className="py-1 pr-2">
                    <input
                      type="number" step="any"
                      value={draft.low_critical ?? ''}
                      onChange={e => patch(draft.id, { low_critical: numberOrNull(e.target.value) })}
                      className="w-20 rounded border border-gray-300 px-2 py-1"
                    />
                  </td>
                  <td className="py-1 pr-2">
                    <input
                      type="number" step="any"
                      value={draft.high_critical ?? ''}
                      onChange={e => patch(draft.id, { high_critical: numberOrNull(e.target.value) })}
                      className="w-20 rounded border border-gray-300 px-2 py-1"
                    />
                  </td>
                  <td className="py-1 pr-2">
                    <input
                      type="number"
                      value={draft.priority ?? 0}
                      onChange={e => patch(draft.id, { priority: Number(e.target.value) || 0 })}
                      className="w-16 rounded border border-gray-300 px-2 py-1"
                    />
                  </td>
                  <td className="py-1">
                    <button
                      type="button"
                      onClick={() => removeRow(draft.id)}
                      className="rounded p-1 text-red-500 hover:bg-red-50"
                      title="Delete rule"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <datalist id={`conditions-${labAnalyteId}`}>
            {conditionOptions.map(o => <option key={o} value={o} />)}
          </datalist>
        </div>
      )}

      {conflicts.length > 0 && (
        <div className="mt-3 space-y-1">
          {conflicts.map((c, i) => (
            <div
              key={i}
              className={`flex items-start gap-2 rounded px-3 py-2 text-xs ${
                c.kind === 'gap'
                  ? 'border border-blue-200 bg-blue-50 text-blue-800'
                  : 'border border-amber-200 bg-amber-50 text-amber-800'
              }`}
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{c.message}</span>
            </div>
          ))}
        </div>
      )}

      {/* Preview — check a rule set before trusting it to a real report. */}
      <div className="mt-4 rounded border border-indigo-200 bg-white p-3">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-indigo-700">
          Preview
        </div>
        <div className="flex flex-wrap items-end gap-2 text-sm">
          <label className="flex flex-col gap-0.5">
            <span className="text-xs text-gray-500">Gender</span>
            <select
              value={previewGender}
              onChange={e => setPreviewGender(e.target.value)}
              className="rounded border border-gray-300 px-2 py-1"
            >
              <option value="">Unknown</option>
              <option value="male">Male</option>
              <option value="female">Female</option>
              <option value="other">Other</option>
            </select>
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-xs text-gray-500">Age</span>
            <div className="flex gap-1">
              <input
                type="number" min={0}
                value={previewAge}
                onChange={e => setPreviewAge(e.target.value)}
                className="w-16 rounded border border-gray-300 px-2 py-1"
              />
              <select
                value={previewAgeUnit}
                onChange={e => setPreviewAgeUnit(e.target.value as AgeUnit)}
                className="rounded border border-gray-300 px-1 py-1 text-xs"
              >
                {AGE_UNITS.map(u => <option key={u} value={u}>{u}</option>)}
              </select>
            </div>
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-xs text-gray-500">Condition</span>
            <input
              list={`conditions-${labAnalyteId}`}
              value={previewCondition}
              onChange={e => setPreviewCondition(e.target.value)}
              placeholder="none"
              className="w-36 rounded border border-gray-300 px-2 py-1"
            />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-xs text-gray-500">Pregnancy</span>
            <select
              value={previewPregnancy}
              onChange={e => setPreviewPregnancy(e.target.value)}
              className="rounded border border-gray-300 px-2 py-1"
            >
              <option value="">Unknown</option>
              <option value="true">Pregnant</option>
              <option value="false">Not pregnant</option>
            </select>
          </label>

          <div className="ml-auto rounded bg-gray-50 px-3 py-2">
            <div className="text-xs text-gray-500">
              {analyteName || 'This analyte'} would report
            </div>
            <div className="font-mono text-base font-semibold text-gray-900">
              {preview.range_text || '—'}{unit ? <span className="ml-1 text-xs font-normal text-gray-500">{unit}</span> : null}
            </div>
            <div className="text-xs text-gray-500">
              {preview.source === 'rule'
                ? `Rule: ${preview.applied_rule}`
                : preview.source === 'gender_column'
                  ? 'Legacy gender column'
                  : preview.source === 'lab_default'
                    ? 'Default range'
                    : 'Nothing configured'}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ReferenceRangeRulesEditor;
