import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { QRCodeCanvas } from 'qrcode.react';
import {
  Globe,
  Loader2,
  Copy,
  Check,
  ExternalLink,
  AlertCircle,
  Save,
  Code2,
  QrCode,
  Search,
} from 'lucide-react';
import { supabase } from '../../utils/supabase';

/**
 * Public booking link settings.
 *
 * Turns on the lab's no-login booking page (/book/:slug) — the link a lab puts
 * on its website, Google Business Profile or a QR poster. Submissions arrive in
 * the Booking Queue as `public_web`; nothing here creates orders directly.
 */

interface PublicBookingSettingsProps {
  labId: string;
}

interface BookingConfig {
  headline: string;
  intro: string;
  show_prices: boolean;
  catalog_mode: 'all' | 'selected';
  selected_test_group_ids: string[];
  selected_package_ids: string[];
  allow_home_collection: boolean;
  allow_walk_in: boolean;
  home_collection_charge: number;
  require_email: boolean;
  require_age_gender: boolean;
  slot_days_ahead: number;
  slot_start_hour: number;
  slot_end_hour: number;
  slot_minutes: number;
  terms: string;
  max_per_phone_per_day: number;
}

const DEFAULT_CONFIG: BookingConfig = {
  headline: 'Book a lab test',
  intro: '',
  show_prices: true,
  catalog_mode: 'all',
  selected_test_group_ids: [],
  selected_package_ids: [],
  allow_home_collection: true,
  allow_walk_in: true,
  home_collection_charge: 0,
  require_email: false,
  require_age_gender: true,
  slot_days_ahead: 7,
  slot_start_hour: 7,
  slot_end_hour: 20,
  slot_minutes: 30,
  terms: '',
  max_per_phone_per_day: 5,
};

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);

const PublicBookingSettings: React.FC<PublicBookingSettingsProps> = ({ labId }) => {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const [labName, setLabName] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [slug, setSlug] = useState('');
  const [savedSlug, setSavedSlug] = useState('');
  const [config, setConfig] = useState<BookingConfig>(DEFAULT_CONFIG);

  const [slugState, setSlugState] = useState<'idle' | 'checking' | 'free' | 'taken' | 'invalid'>('idle');
  const [catalogQuery, setCatalogQuery] = useState('');
  const [testGroups, setTestGroups] = useState<Array<{ id: string; name: string; category: string }>>([]);
  const [packages, setPackages] = useState<Array<{ id: string; name: string }>>([]);

  const publicUrl = savedSlug ? `${window.location.origin}/book/${savedSlug}` : '';

  // -------------------------------------------------------------------- load --

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      try {
        const [{ data: lab, error: labError }, { data: groups }, { data: pkgs }] = await Promise.all([
          supabase
            .from('labs')
            .select('name, public_booking_enabled, public_booking_slug, public_booking_config')
            .eq('id', labId)
            .single(),
          supabase
            .from('test_groups')
            .select('id, name, category')
            .eq('lab_id', labId)
            .eq('is_active', true)
            // Same filter the public page applies, so the picker matches what patients see
            .not('is_section_only', 'is', true)
            .not('only_billing', 'is', true)
            .order('name'),
          supabase
            .from('packages')
            .select('id, name')
            .eq('lab_id', labId)
            .eq('is_active', true)
            .order('name'),
        ]);

        if (labError) throw labError;
        if (cancelled) return;

        setLabName(lab?.name || '');
        setEnabled(!!lab?.public_booking_enabled);
        setSlug(lab?.public_booking_slug || '');
        setSavedSlug(lab?.public_booking_slug || '');
        setConfig({ ...DEFAULT_CONFIG, ...(lab?.public_booking_config || {}) });
        setTestGroups(groups || []);
        setPackages(pkgs || []);
      } catch (err) {
        if (!cancelled) setError((err as Error)?.message || 'Could not load booking settings.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [labId]);

  // ------------------------------------------------------ slug availability --

  useEffect(() => {
    const candidate = slug.trim().toLowerCase();

    if (!candidate) return setSlugState('idle');
    if (candidate === savedSlug) return setSlugState('free');
    if (!/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/.test(candidate)) return setSlugState('invalid');

    setSlugState('checking');
    const timer = setTimeout(async () => {
      const { data, error: rpcError } = await supabase.rpc('public_booking_slug_available', {
        p_slug: candidate,
        p_lab_id: labId,
      });
      if (rpcError) return setSlugState('idle');
      setSlugState(data ? 'free' : 'taken');
    }, 400);

    return () => clearTimeout(timer);
  }, [slug, savedSlug, labId]);

  // ------------------------------------------------------------------- save --

  const handleSave = useCallback(async () => {
    setError(null);
    setSaved(false);

    const candidate = slug.trim().toLowerCase();

    if (enabled && !candidate) {
      return setError('Choose a link name before turning the booking page on.');
    }
    if (candidate && slugState === 'invalid') {
      return setError('The link name may only use lowercase letters, numbers and hyphens (3-50 characters).');
    }
    if (candidate && slugState === 'taken') {
      return setError('That link name is already used by another lab. Please pick a different one.');
    }
    if (enabled && !config.allow_walk_in && !config.allow_home_collection) {
      return setError('Allow at least one collection option — visit the lab or home collection.');
    }

    setSaving(true);
    try {
      const { error: updateError } = await supabase
        .from('labs')
        .update({
          public_booking_enabled: enabled,
          public_booking_slug: candidate || null,
          public_booking_config: config,
        })
        .eq('id', labId);

      if (updateError) {
        // 23505 = the unique index on public_booking_slug
        throw new Error(
          (updateError as { code?: string }).code === '23505'
            ? 'That link name is already taken. Please pick a different one.'
            : updateError.message
        );
      }

      setSavedSlug(candidate);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError((err as Error)?.message || 'Could not save booking settings.');
    } finally {
      setSaving(false);
    }
  }, [labId, enabled, slug, slugState, config]);

  const copy = (key: string, value: string) => {
    navigator.clipboard.writeText(value);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  };

  const embedSnippet = useMemo(
    () =>
      publicUrl
        ? `<iframe id="anpro-booking" src="${publicUrl}/embed" style="width:100%;border:0;min-height:640px"
  title="Book a lab test"></iframe>
<script>
  window.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'anpro-booking-height') {
      document.getElementById('anpro-booking').style.height = e.data.height + 'px';
    }
  });
</script>`
        : '',
    [publicUrl]
  );

  const filteredGroups = useMemo(() => {
    const q = catalogQuery.trim().toLowerCase();
    if (!q) return testGroups;
    return testGroups.filter(
      (g) => g.name.toLowerCase().includes(q) || (g.category || '').toLowerCase().includes(q)
    );
  }, [testGroups, catalogQuery]);

  const toggleId = (key: 'selected_test_group_ids' | 'selected_package_ids', id: string) => {
    setConfig((prev) => {
      const current = prev[key] || [];
      return {
        ...prev,
        [key]: current.includes(id) ? current.filter((x) => x !== id) : [...current, id],
      };
    });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
      </div>
    );
  }

  const inputClass =
    'w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500';

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Header */}
      <div>
        <h2 className="text-lg font-semibold text-gray-800 flex items-center gap-2">
          <Globe className="h-5 w-5 text-blue-600" />
          Public Booking Link
        </h2>
        <p className="text-sm text-gray-500 mt-1">
          A no-login page where patients pick tests and request an appointment. Put the link on your
          website, Google Business Profile, WhatsApp or a QR poster — requests land in your Booking Queue.
        </p>
      </div>

      {/* Enable */}
      <div className="flex items-center justify-between p-4 border border-gray-200 rounded-xl">
        <div>
          <p className="text-sm font-medium text-gray-900">Online booking page</p>
          <p className="text-xs text-gray-500 mt-0.5">
            {enabled ? 'Patients can book right now.' : 'The link returns "not available" while this is off.'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setEnabled((v) => !v)}
          className={`relative w-12 h-6 rounded-full transition-colors ${enabled ? 'bg-blue-600' : 'bg-gray-300'}`}
          aria-pressed={enabled}
        >
          <span
            className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${
              enabled ? 'translate-x-6' : ''
            }`}
          />
        </button>
      </div>

      {/* Slug */}
      <div className="space-y-2">
        <label className="block text-sm font-medium text-gray-700">Your booking link</label>
        <div className="flex items-stretch">
          <span className="px-3 py-2 bg-gray-100 border border-r-0 border-gray-300 rounded-l-lg text-sm text-gray-500 flex items-center">
            {window.location.origin}/book/
          </span>
          <input
            type="text"
            value={slug}
            onChange={(e) => setSlug(slugify(e.target.value))}
            placeholder={slugify(labName) || 'your-lab-name'}
            className="flex-1 px-3 py-2 border border-gray-300 rounded-r-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div className="text-xs h-4">
          {slugState === 'checking' && <span className="text-gray-500">Checking availability…</span>}
          {slugState === 'free' && slug && <span className="text-green-600">This link is available.</span>}
          {slugState === 'taken' && <span className="text-red-600">Already taken — try another.</span>}
          {slugState === 'invalid' && (
            <span className="text-red-600">Use 3-50 lowercase letters, numbers or hyphens.</span>
          )}
          {!slug && !!slugify(labName) && (
            <button
              type="button"
              onClick={() => setSlug(slugify(labName))}
              className="text-blue-600 hover:underline"
            >
              Use “{slugify(labName)}”
            </button>
          )}
        </div>
      </div>

      {/* Live link + QR + embed */}
      {savedSlug && (
        <div className="border border-gray-200 rounded-xl divide-y divide-gray-100">
          <div className="p-4 flex flex-wrap items-center gap-3">
            <code className="flex-1 min-w-[220px] text-sm text-gray-800 break-all">{publicUrl}</code>
            <button
              type="button"
              onClick={() => copy('url', publicUrl)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              {copied === 'url' ? <Check className="w-3.5 h-3.5 text-green-600" /> : <Copy className="w-3.5 h-3.5" />}
              Copy
            </button>
            <a
              href={publicUrl}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              Open
            </a>
          </div>

          <div className="p-4 flex items-start gap-4">
            <QRCodeCanvas value={publicUrl} size={104} includeMargin className="shrink-0" />
            <div className="text-sm">
              <p className="font-medium text-gray-900 flex items-center gap-1.5">
                <QrCode className="w-4 h-4 text-gray-400" />
                QR for posters and reception desks
              </p>
              <p className="text-xs text-gray-500 mt-1">
                Right-click the code to save it, then print it on your poster, visiting card or bill.
              </p>
            </div>
          </div>

          <div className="p-4">
            <p className="text-sm font-medium text-gray-900 flex items-center gap-1.5">
              <Code2 className="w-4 h-4 text-gray-400" />
              Website widget
            </p>
            <p className="text-xs text-gray-500 mt-1 mb-2">
              Paste this into your website to embed the booking form; it resizes itself to fit.
            </p>
            <pre className="text-xs bg-gray-900 text-gray-100 rounded-lg p-3 overflow-x-auto">
              {embedSnippet}
            </pre>
            <button
              type="button"
              onClick={() => copy('embed', embedSnippet)}
              className="mt-2 flex items-center gap-1.5 px-3 py-1.5 text-sm bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              {copied === 'embed' ? <Check className="w-3.5 h-3.5 text-green-600" /> : <Copy className="w-3.5 h-3.5" />}
              Copy embed code
            </button>
          </div>
        </div>
      )}

      {/* Page content */}
      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-gray-800">Page content</h3>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Headline</label>
          <input
            type="text"
            value={config.headline}
            onChange={(e) => setConfig({ ...config, headline: e.target.value })}
            className={inputClass}
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Intro text</label>
          <textarea
            rows={2}
            value={config.intro}
            onChange={(e) => setConfig({ ...config, intro: e.target.value })}
            className={inputClass}
            placeholder="e.g. NABL-accredited reports within 24 hours."
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">
            Terms shown above the confirm button
          </label>
          <textarea
            rows={2}
            value={config.terms}
            onChange={(e) => setConfig({ ...config, terms: e.target.value })}
            className={inputClass}
            placeholder="e.g. Slots are confirmed by our team over a phone call."
          />
        </div>
      </div>

      {/* Options */}
      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-gray-800">Booking options</h3>
        <div className="grid sm:grid-cols-2 gap-3">
          {([
            ['show_prices', 'Show prices on the page'],
            ['allow_walk_in', 'Allow "visit the lab" bookings'],
            ['allow_home_collection', 'Allow home collection'],
            ['require_age_gender', 'Require age and gender'],
            ['require_email', 'Require an email address'],
          ] as Array<[keyof BookingConfig, string]>).map(([key, label]) => (
            <label
              key={key as string}
              className="flex items-center gap-2 p-3 border border-gray-200 rounded-lg text-sm cursor-pointer hover:bg-gray-50"
            >
              <input
                type="checkbox"
                checked={!!config[key]}
                onChange={(e) => setConfig({ ...config, [key]: e.target.checked })}
                className="rounded border-gray-300"
              />
              {label}
            </label>
          ))}
        </div>

        <div className="grid sm:grid-cols-3 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Home collection charge</label>
            <input
              type="number"
              min={0}
              value={config.home_collection_charge}
              onChange={(e) =>
                setConfig({ ...config, home_collection_charge: Number(e.target.value) || 0 })
              }
              className={inputClass}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Days ahead bookable</label>
            <input
              type="number"
              min={1}
              max={60}
              value={config.slot_days_ahead}
              onChange={(e) => setConfig({ ...config, slot_days_ahead: Number(e.target.value) || 7 })}
              className={inputClass}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Requests per phone / day</label>
            <input
              type="number"
              min={1}
              max={50}
              value={config.max_per_phone_per_day}
              onChange={(e) =>
                setConfig({ ...config, max_per_phone_per_day: Number(e.target.value) || 5 })
              }
              className={inputClass}
            />
          </div>
        </div>

        <div className="grid sm:grid-cols-3 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Slots start (hour)</label>
            <input
              type="number"
              min={0}
              max={23}
              value={config.slot_start_hour}
              onChange={(e) => setConfig({ ...config, slot_start_hour: Number(e.target.value) || 0 })}
              className={inputClass}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Slots end (hour)</label>
            <input
              type="number"
              min={0}
              max={23}
              value={config.slot_end_hour}
              onChange={(e) => setConfig({ ...config, slot_end_hour: Number(e.target.value) || 0 })}
              className={inputClass}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Slot length (minutes)</label>
            <select
              value={config.slot_minutes}
              onChange={(e) => setConfig({ ...config, slot_minutes: Number(e.target.value) })}
              className={inputClass}
            >
              {[15, 20, 30, 45, 60].map((m) => (
                <option key={m} value={m}>
                  {m} minutes
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Catalog */}
      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-gray-800">Which tests are bookable?</h3>
        <div className="flex gap-3">
          {(['all', 'selected'] as const).map((mode) => (
            <label
              key={mode}
              className={`flex-1 p-3 border rounded-lg text-sm cursor-pointer ${
                config.catalog_mode === mode ? 'border-blue-500 bg-blue-50' : 'border-gray-200'
              }`}
            >
              <input
                type="radio"
                className="sr-only"
                checked={config.catalog_mode === mode}
                onChange={() => setConfig({ ...config, catalog_mode: mode })}
              />
              <span className="font-medium text-gray-900">
                {mode === 'all' ? 'All active tests and packages' : 'Only the ones I pick'}
              </span>
              <span className="block text-xs text-gray-500 mt-0.5">
                {mode === 'all'
                  ? 'New tests appear on the page automatically.'
                  : `${config.selected_test_group_ids.length + config.selected_package_ids.length} item(s) selected.`}
              </span>
            </label>
          ))}
        </div>

        {config.catalog_mode === 'selected' && (
          <div className="border border-gray-200 rounded-xl">
            <div className="p-3 border-b border-gray-100 relative">
              <Search className="w-4 h-4 text-gray-400 absolute left-6 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={catalogQuery}
                onChange={(e) => setCatalogQuery(e.target.value)}
                placeholder="Search tests"
                className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div className="max-h-64 overflow-y-auto p-3 space-y-1">
              {packages.map((p) => (
                <label key={p.id} className="flex items-center gap-2 text-sm py-1 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={config.selected_package_ids.includes(p.id)}
                    onChange={() => toggleId('selected_package_ids', p.id)}
                    className="rounded border-gray-300"
                  />
                  <span className="text-gray-900">{p.name}</span>
                  <span className="text-xs text-blue-600">Package</span>
                </label>
              ))}
              {filteredGroups.map((g) => (
                <label key={g.id} className="flex items-center gap-2 text-sm py-1 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={config.selected_test_group_ids.includes(g.id)}
                    onChange={() => toggleId('selected_test_group_ids', g.id)}
                    className="rounded border-gray-300"
                  />
                  <span className="text-gray-900">{g.name}</span>
                  <span className="text-xs text-gray-400">{g.category}</span>
                </label>
              ))}
              {!filteredGroups.length && !packages.length && (
                <p className="text-sm text-gray-500 py-4 text-center">No active tests found.</p>
              )}
            </div>
          </div>
        )}
      </div>

      {error && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg p-3">
          <AlertCircle className="w-4 h-4 text-red-600 mt-0.5 shrink-0" />
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      <div className="flex items-center gap-3 pt-2 border-t border-gray-200">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-2 px-5 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-60"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          Save booking settings
        </button>
        {saved && (
          <span className="text-sm text-green-600 flex items-center gap-1.5">
            <Check className="w-4 h-4" />
            Saved
          </span>
        )}
      </div>
    </div>
  );
};

export default PublicBookingSettings;
