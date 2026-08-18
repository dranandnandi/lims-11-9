import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import {
  Loader2,
  Search,
  Check,
  ShoppingCart,
  Home,
  Building2,
  CheckCircle2,
  XCircle,
  ChevronLeft,
  Clock,
  Phone,
  MapPin,
  AlertCircle,
  ShieldCheck,
  Droplet,
} from 'lucide-react';
import { supabase } from '../utils/supabase';

/**
 * Public booking page — /book/:slug (and /book/:slug/embed for website widgets).
 *
 * No session required: the lab's public slug is the only identifier. The page
 * talks exclusively to the `public-booking` edge function (verify_jwt = false),
 * which reads the catalog and writes the booking with the service role. Prices
 * shown here are informational — the function re-prices everything server-side.
 *
 * Labs share this URL from Google Business Profile, their website, WhatsApp or
 * a QR code. Submissions land in the staff Booking Queue as `public_web`.
 */

interface CatalogItem {
  id: string;
  type: 'test_group' | 'package';
  name: string;
  category?: string | null;
  price: number;
  requires_fasting?: boolean;
  turnaround_time?: string | null;
  sample_type?: string | null;
  only_male?: boolean;
  only_female?: boolean;
  description?: string | null;
}

interface LabProfile {
  name: string;
  city?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  currency_code?: string | null;
  logo_url?: string | null;
}

interface BookingConfig {
  headline: string;
  intro: string;
  show_prices: boolean;
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
}

interface Confirmation {
  reference: string;
  amount: number;
  lab_phone?: string | null;
  scheduled_at?: string | null;
  collection_type: string;
}

type Step = 'tests' | 'details' | 'done';

const money = (value: number, currency?: string | null) =>
  `${currency && currency !== 'INR' ? `${currency} ` : '₹'}${Number(value || 0).toFixed(0)}`;

/** Local-time "YYYY-MM-DDTHH:mm" — toISOString() would shift the slot by the UTC offset. */
const toLocalIso = (day: Date, hour: number, minute: number) => {
  const d = new Date(day);
  d.setHours(hour, minute, 0, 0);
  return d;
};

const PublicBooking: React.FC = () => {
  const { slug } = useParams<{ slug: string }>();
  const [searchParams] = useSearchParams();
  const embedded =
    window.location.pathname.endsWith('/embed') || searchParams.get('embed') === '1';

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [lab, setLab] = useState<LabProfile | null>(null);
  const [config, setConfig] = useState<BookingConfig | null>(null);
  const [tests, setTests] = useState<CatalogItem[]>([]);
  const [packages, setPackages] = useState<CatalogItem[]>([]);

  const [step, setStep] = useState<Step>('tests');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<CatalogItem[]>([]);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);

  const [form, setForm] = useState({
    name: '',
    phone: '',
    age: '',
    gender: '' as '' | 'Male' | 'Female' | 'Other',
    email: '',
    collection_type: '' as '' | 'home_collection' | 'walk_in',
    date: '',
    time: '',
    address: '',
    city: '',
    pincode: '',
    notes: '',
    company: '', // honeypot — hidden from humans
  });

  const rootRef = useRef<HTMLDivElement>(null);

  // ------------------------------------------------------------------ load --

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      if (!slug) {
        setError('This booking link is not valid.');
        setLoading(false);
        return;
      }

      try {
        const { data, error: fnError } = await supabase.functions.invoke('public-booking', {
          body: { slug },
        });

        if (fnError) throw fnError;
        if (!data || data.error) throw new Error(data?.error || 'Booking is not available.');
        if (cancelled) return;

        setLab(data.lab);
        setConfig(data.config);
        setTests(data.tests || []);
        setPackages(data.packages || []);
        setForm((prev) => ({
          ...prev,
          collection_type: data.config?.allow_walk_in
            ? 'walk_in'
            : data.config?.allow_home_collection
              ? 'home_collection'
              : '',
        }));
      } catch (err) {
        if (!cancelled) {
          setError(
            (err as Error)?.message || 'Online booking is not available for this lab right now.'
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  // Let a host page size the iframe to the content.
  useEffect(() => {
    if (!embedded) return;
    const post = () => {
      window.parent?.postMessage(
        { type: 'anpro-booking-height', height: rootRef.current?.scrollHeight ?? 0 },
        '*'
      );
    };
    post();
    const observer = new ResizeObserver(post);
    if (rootRef.current) observer.observe(rootRef.current);
    return () => observer.disconnect();
  }, [embedded, step, loading, selected.length]);

  // --------------------------------------------------------------- derived --

  const currency = lab?.currency_code;
  const showPrices = config?.show_prices !== false;

  const selectedIds = useMemo(() => new Set(selected.map((s) => `${s.type}:${s.id}`)), [selected]);

  const itemsTotal = useMemo(
    () => selected.reduce((sum, item) => sum + (item.price || 0), 0),
    [selected]
  );

  const collectionCharge =
    form.collection_type === 'home_collection' ? config?.home_collection_charge || 0 : 0;

  const total = itemsTotal + collectionCharge;

  const filteredTests = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tests;
    return tests.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        (t.category || '').toLowerCase().includes(q)
    );
  }, [tests, query]);

  const filteredPackages = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return packages;
    return packages.filter((p) => p.name.toLowerCase().includes(q));
  }, [packages, query]);

  const groupedTests = useMemo(() => {
    const map = new Map<string, CatalogItem[]>();
    filteredTests.forEach((t) => {
      const key = t.category || 'Other tests';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(t);
    });
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [filteredTests]);

  const dayOptions = useMemo(() => {
    const days: Array<{ value: string; label: string }> = [];
    const span = Math.max(1, Math.min(config?.slot_days_ahead ?? 7, 60));
    for (let i = 0; i < span; i++) {
      const d = new Date();
      d.setDate(d.getDate() + i);
      days.push({
        value: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
        label:
          i === 0
            ? 'Today'
            : i === 1
              ? 'Tomorrow'
              : d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }),
      });
    }
    return days;
  }, [config?.slot_days_ahead]);

  const timeOptions = useMemo(() => {
    if (!config || !form.date) return [];
    const startHour = Math.max(0, Math.min(config.slot_start_hour ?? 7, 23));
    const endHour = Math.max(startHour, Math.min(config.slot_end_hour ?? 20, 23));
    const stepMinutes = Math.max(15, Math.min(config.slot_minutes ?? 30, 120));

    const [y, m, d] = form.date.split('-').map(Number);
    const day = new Date(y, (m || 1) - 1, d || 1);
    const slots: Array<{ value: string; label: string }> = [];

    for (let minutes = startHour * 60; minutes <= endHour * 60; minutes += stepMinutes) {
      const at = toLocalIso(day, Math.floor(minutes / 60), minutes % 60);
      if (at.getTime() < Date.now()) continue; // no booking into the past
      slots.push({
        value: `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`,
        label: at.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }),
      });
    }
    return slots;
  }, [config, form.date]);

  // Clear a slot that has just aged out of the list (e.g. the page was left open).
  useEffect(() => {
    if (form.time && !timeOptions.some((t) => t.value === form.time)) {
      setForm((prev) => ({ ...prev, time: '' }));
    }
  }, [timeOptions, form.time]);

  // ---------------------------------------------------------------- actions --

  const toggleItem = (item: CatalogItem) => {
    const key = `${item.type}:${item.id}`;
    setSelected((prev) =>
      prev.some((s) => `${s.type}:${s.id}` === key)
        ? prev.filter((s) => `${s.type}:${s.id}` !== key)
        : [...prev, item]
    );
  };

  const handleSubmit = useCallback(async () => {
    if (!slug || !config) return;
    setFormError(null);

    if (form.name.trim().length < 2) return setFormError('Please enter the patient name.');
    if (form.phone.replace(/\D/g, '').length < 10) {
      return setFormError('Please enter a valid 10-digit mobile number.');
    }
    if (config.require_age_gender && (!form.age || !form.gender)) {
      return setFormError('Please enter the patient age and gender.');
    }
    if (config.require_email && !/^\S+@\S+\.\S+$/.test(form.email)) {
      return setFormError('Please enter a valid email address.');
    }
    if (!form.collection_type) return setFormError('Please choose how the sample will be collected.');
    if (form.collection_type === 'home_collection' && form.address.trim().length < 8) {
      return setFormError('Please enter the full address for home collection.');
    }
    if (!form.date || !form.time) return setFormError('Please choose a preferred date and time.');

    const [y, m, d] = form.date.split('-').map(Number);
    const [hh, mm] = form.time.split(':').map(Number);
    const scheduledAt = toLocalIso(new Date(y, (m || 1) - 1, d || 1), hh || 0, mm || 0);

    setSubmitting(true);
    try {
      const { data, error: fnError } = await supabase.functions.invoke('public-booking/submit', {
        body: {
          slug,
          company: form.company,
          patient: {
            name: form.name.trim(),
            phone: form.phone,
            age: form.age || undefined,
            gender: form.gender || undefined,
            email: form.email.trim() || undefined,
          },
          items: selected.map((s) => ({ id: s.id, type: s.type })),
          collection_type: form.collection_type,
          scheduled_at: scheduledAt.toISOString(),
          address:
            form.collection_type === 'home_collection'
              ? { address: form.address.trim(), city: form.city.trim(), pincode: form.pincode.trim() }
              : undefined,
          notes: form.notes.trim() || undefined,
          referrer: document.referrer || undefined,
        },
      });

      if (fnError) throw fnError;
      if (!data || data.error) throw new Error(data?.error || 'Could not submit your booking.');

      setConfirmation(data as Confirmation);
      setStep('done');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      setFormError((err as Error)?.message || 'Could not submit your booking. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }, [slug, config, form, selected]);

  // ----------------------------------------------------------------- shell --

  // A plain function, not a component: rendering it as <Shell> would create a new
  // component type each render and remount the inputs, losing focus on every keystroke.
  const shell = (children: React.ReactNode) => (
    <div
      ref={rootRef}
      className={embedded ? 'bg-white' : 'min-h-screen bg-gray-50 py-6 px-4'}
    >
      <div className={embedded ? 'w-full' : 'max-w-2xl mx-auto'}>
        <div
          className={
            embedded
              ? 'bg-white'
              : 'bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden'
          }
        >
          {lab && (
            <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-3">
              {lab.logo_url && (
                <img src={lab.logo_url} alt="" className="h-10 w-auto object-contain" />
              )}
              <div className="min-w-0">
                <div className="font-semibold text-gray-900 truncate">{lab.name}</div>
                {(lab.city || lab.phone) && (
                  <div className="text-xs text-gray-500 truncate">
                    {[lab.city, lab.phone].filter(Boolean).join(' · ')}
                  </div>
                )}
              </div>
            </div>
          )}
          <div className="p-5">{children}</div>
        </div>
        {!embedded && (
          <p className="text-center text-xs text-gray-400 mt-4">
            Secure booking · Your details are shared only with {lab?.name || 'the lab'}
          </p>
        )}
      </div>
    </div>
  );

  // --------------------------------------------------------------- states --

  if (loading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  if (error || !config) {
    return (
      shell(
        <div className="text-center py-6">
          <XCircle className="w-14 h-14 text-red-500 mx-auto mb-3" />
          <h1 className="text-lg font-semibold text-gray-900">Booking unavailable</h1>
          <p className="text-sm text-gray-600 mt-2">{error}</p>
        </div>
      )
    );
  }

  if (step === 'done' && confirmation) {
    return (
      shell(
        <div className="text-center py-4">
          <CheckCircle2 className="w-16 h-16 text-green-600 mx-auto mb-3" />
          <h1 className="text-xl font-semibold text-gray-900">Booking request received</h1>
          <p className="text-sm text-gray-600 mt-2">
            The lab will call you shortly to confirm your appointment.
          </p>

          <div className="mt-5 bg-gray-50 border border-gray-200 rounded-xl p-4 text-left space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-500">Reference</span>
              <span className="font-mono font-semibold text-gray-900">{confirmation.reference}</span>
            </div>
            {confirmation.scheduled_at && (
              <div className="flex justify-between">
                <span className="text-gray-500">Preferred slot</span>
                <span className="text-gray-900">
                  {new Date(confirmation.scheduled_at).toLocaleString('en-IN', {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })}
                </span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-gray-500">Collection</span>
              <span className="text-gray-900">
                {confirmation.collection_type === 'home_collection' ? 'Home collection' : 'At the lab'}
              </span>
            </div>
            {showPrices && (
              <div className="flex justify-between pt-2 border-t border-gray-200">
                <span className="text-gray-500">Estimated total</span>
                <span className="font-semibold text-gray-900">
                  {money(confirmation.amount, currency)}
                </span>
              </div>
            )}
          </div>

          {confirmation.lab_phone && (
            <p className="text-sm text-gray-500 mt-4 flex items-center justify-center gap-1.5">
              <Phone className="w-3.5 h-3.5" />
              Questions? Call {confirmation.lab_phone}
            </p>
          )}
        </div>
      )
    );
  }

  // ----------------------------------------------------------- step: tests --

  if (step === 'tests') {
    return (
      shell(
        <>
        <h1 className="text-lg font-semibold text-gray-900">{config.headline}</h1>
        {config.intro && <p className="text-sm text-gray-600 mt-1">{config.intro}</p>}

        <div className="relative mt-4">
          <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tests or health packages"
            className="w-full pl-9 pr-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <div className="mt-4 space-y-5 max-h-[52vh] overflow-y-auto pr-1">
          {filteredPackages.length > 0 && (
            <section>
              <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                Health packages
              </h2>
              <div className="space-y-2">
                {filteredPackages.map((pkg) => {
                  const active = selectedIds.has(`package:${pkg.id}`);
                  return (
                    <button
                      key={pkg.id}
                      type="button"
                      onClick={() => toggleItem(pkg)}
                      className={`w-full text-left p-3 rounded-xl border transition-colors ${
                        active
                          ? 'border-blue-500 bg-blue-50'
                          : 'border-gray-200 hover:border-gray-300 bg-white'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="font-medium text-gray-900 text-sm">{pkg.name}</div>
                          {pkg.description && (
                            <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">
                              {pkg.description}
                            </p>
                          )}
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {showPrices && (
                            <span className="text-sm font-semibold text-gray-900">
                              {money(pkg.price, currency)}
                            </span>
                          )}
                          <span
                            className={`w-5 h-5 rounded-full border flex items-center justify-center ${
                              active ? 'bg-blue-600 border-blue-600' : 'border-gray-300'
                            }`}
                          >
                            {active && <Check className="w-3 h-3 text-white" />}
                          </span>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {groupedTests.map(([category, items]) => (
            <section key={category}>
              <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                {category}
              </h2>
              <div className="space-y-2">
                {items.map((test) => {
                  const active = selectedIds.has(`test_group:${test.id}`);
                  return (
                    <button
                      key={test.id}
                      type="button"
                      onClick={() => toggleItem(test)}
                      className={`w-full text-left p-3 rounded-xl border transition-colors ${
                        active
                          ? 'border-blue-500 bg-blue-50'
                          : 'border-gray-200 hover:border-gray-300 bg-white'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="font-medium text-gray-900 text-sm">{test.name}</div>
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-xs text-gray-500">
                            {test.requires_fasting && (
                              <span className="text-amber-600">Fasting required</span>
                            )}
                            {test.turnaround_time && (
                              <span className="flex items-center gap-1">
                                <Clock className="w-3 h-3" />
                                {test.turnaround_time}
                              </span>
                            )}
                            {test.sample_type && (
                              <span className="flex items-center gap-1">
                                <Droplet className="w-3 h-3" />
                                {test.sample_type}
                              </span>
                            )}
                            {test.only_female && <span>Female only</span>}
                            {test.only_male && <span>Male only</span>}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {showPrices && (
                            <span className="text-sm font-semibold text-gray-900">
                              {money(test.price, currency)}
                            </span>
                          )}
                          <span
                            className={`w-5 h-5 rounded-full border flex items-center justify-center ${
                              active ? 'bg-blue-600 border-blue-600' : 'border-gray-300'
                            }`}
                          >
                            {active && <Check className="w-3 h-3 text-white" />}
                          </span>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}

          {!filteredTests.length && !filteredPackages.length && (
            <p className="text-sm text-gray-500 text-center py-8">
              No tests match “{query}”. Try a different search{lab?.phone ? ` or call ${lab.phone}` : ''}.
            </p>
          )}
        </div>

        <div className="mt-5 pt-4 border-t border-gray-200 flex items-center justify-between gap-3">
          <div className="text-sm">
            <div className="text-gray-500 flex items-center gap-1.5">
              <ShoppingCart className="w-4 h-4" />
              {selected.length} selected
            </div>
            {showPrices && selected.length > 0 && (
              <div className="font-semibold text-gray-900">{money(itemsTotal, currency)}</div>
            )}
          </div>
          <button
            type="button"
            disabled={!selected.length}
            onClick={() => setStep('details')}
            className="px-6 py-3 bg-blue-600 text-white rounded-lg font-semibold text-sm hover:bg-blue-700 disabled:opacity-50"
          >
            Continue
          </button>
        </div>
        </>
      )
    );
  }

  // --------------------------------------------------------- step: details --

  const inputClass =
    'w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500';

  return (
    shell(
      <>
      <button
        type="button"
        onClick={() => setStep('tests')}
        className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-3"
      >
        <ChevronLeft className="w-4 h-4" />
        Back to tests
      </button>

      <h1 className="text-lg font-semibold text-gray-900">Your details</h1>

      <div className="mt-4 space-y-3">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">
            Patient name <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className={inputClass}
            placeholder="Full name"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">
            Mobile number <span className="text-red-500">*</span>
          </label>
          <input
            type="tel"
            inputMode="numeric"
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value.replace(/[^\d+\s-]/g, '') })}
            className={inputClass}
            placeholder="10-digit mobile number"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Age {config.require_age_gender && <span className="text-red-500">*</span>}
            </label>
            <input
              type="number"
              min={0}
              max={129}
              value={form.age}
              onChange={(e) => setForm({ ...form, age: e.target.value })}
              className={inputClass}
              placeholder="Years"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Gender {config.require_age_gender && <span className="text-red-500">*</span>}
            </label>
            <select
              value={form.gender}
              onChange={(e) => setForm({ ...form, gender: e.target.value as typeof form.gender })}
              className={inputClass}
            >
              <option value="">Select</option>
              <option value="Male">Male</option>
              <option value="Female">Female</option>
              <option value="Other">Other</option>
            </select>
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">
            Email {config.require_email && <span className="text-red-500">*</span>}
          </label>
          <input
            type="email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            className={inputClass}
            placeholder="For the digital report (optional)"
          />
        </div>

        {/* Honeypot — hidden from humans, filled only by bots */}
        <input
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={form.company}
          onChange={(e) => setForm({ ...form, company: e.target.value })}
          className="hidden"
          aria-hidden="true"
        />

        {/* ------------------------------------------------------ collection -- */}
        <div className="pt-2">
          <label className="block text-xs font-medium text-gray-600 mb-2">
            How would you like the sample collected?
          </label>
          <div className="grid grid-cols-2 gap-3">
            {config.allow_walk_in && (
              <button
                type="button"
                onClick={() => setForm({ ...form, collection_type: 'walk_in' })}
                className={`p-3 rounded-xl border text-left ${
                  form.collection_type === 'walk_in'
                    ? 'border-blue-500 bg-blue-50'
                    : 'border-gray-200 hover:border-gray-300'
                }`}
              >
                <Building2 className="w-5 h-5 text-blue-600 mb-1" />
                <div className="text-sm font-medium text-gray-900">Visit the lab</div>
                <div className="text-xs text-gray-500">Walk in at your slot</div>
              </button>
            )}
            {config.allow_home_collection && (
              <button
                type="button"
                onClick={() => setForm({ ...form, collection_type: 'home_collection' })}
                className={`p-3 rounded-xl border text-left ${
                  form.collection_type === 'home_collection'
                    ? 'border-blue-500 bg-blue-50'
                    : 'border-gray-200 hover:border-gray-300'
                }`}
              >
                <Home className="w-5 h-5 text-blue-600 mb-1" />
                <div className="text-sm font-medium text-gray-900">Home collection</div>
                <div className="text-xs text-gray-500">
                  {config.home_collection_charge > 0
                    ? `+ ${money(config.home_collection_charge, currency)}`
                    : 'Free pickup'}
                </div>
              </button>
            )}
          </div>
        </div>

        {form.collection_type === 'home_collection' && (
          <div className="space-y-3 p-3 bg-gray-50 rounded-xl border border-gray-200">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                Collection address <span className="text-red-500">*</span>
              </label>
              <textarea
                rows={2}
                value={form.address}
                onChange={(e) => setForm({ ...form, address: e.target.value })}
                className={inputClass}
                placeholder="House / flat, street, landmark"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <input
                type="text"
                value={form.city}
                onChange={(e) => setForm({ ...form, city: e.target.value })}
                className={inputClass}
                placeholder="City"
              />
              <input
                type="text"
                inputMode="numeric"
                value={form.pincode}
                onChange={(e) => setForm({ ...form, pincode: e.target.value })}
                className={inputClass}
                placeholder="Pincode"
              />
            </div>
          </div>
        )}

        {/* ------------------------------------------------------------ slot -- */}
        <div className="pt-2">
          <label className="block text-xs font-medium text-gray-600 mb-1">
            Preferred date <span className="text-red-500">*</span>
          </label>
          <select
            value={form.date}
            onChange={(e) => setForm({ ...form, date: e.target.value, time: '' })}
            className={inputClass}
          >
            <option value="">Select a date</option>
            {dayOptions.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
        </div>

        {form.date && (
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Preferred time <span className="text-red-500">*</span>
            </label>
            {timeOptions.length ? (
              <div className="grid grid-cols-3 gap-2 max-h-40 overflow-y-auto">
                {timeOptions.map((t) => (
                  <button
                    key={t.value}
                    type="button"
                    onClick={() => setForm({ ...form, time: t.value })}
                    className={`py-2 rounded-lg border text-xs font-medium ${
                      form.time === t.value
                        ? 'border-blue-500 bg-blue-50 text-blue-700'
                        : 'border-gray-200 text-gray-700 hover:border-gray-300'
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-xs text-gray-500">
                No slots left today — please pick another date.
              </p>
            )}
          </div>
        )}

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Notes for the lab</label>
          <textarea
            rows={2}
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
            className={inputClass}
            placeholder="Doctor's name, prescription details, anything else (optional)"
          />
        </div>
      </div>

      {/* --------------------------------------------------------- summary -- */}
      <div className="mt-5 bg-gray-50 border border-gray-200 rounded-xl p-4 space-y-1.5 text-sm">
        {selected.map((item) => (
          <div key={`${item.type}:${item.id}`} className="flex justify-between gap-3">
            <span className="text-gray-700 truncate">{item.name}</span>
            {showPrices && (
              <span className="text-gray-900 shrink-0">{money(item.price, currency)}</span>
            )}
          </div>
        ))}
        {collectionCharge > 0 && (
          <div className="flex justify-between gap-3">
            <span className="text-gray-700">Home collection</span>
            {showPrices && (
              <span className="text-gray-900">{money(collectionCharge, currency)}</span>
            )}
          </div>
        )}
        {showPrices && (
          <div className="flex justify-between pt-2 mt-1 border-t border-gray-200 font-semibold">
            <span className="text-gray-900">Estimated total</span>
            <span className="text-gray-900">{money(total, currency)}</span>
          </div>
        )}
      </div>

      {config.terms && <p className="text-xs text-gray-500 mt-3">{config.terms}</p>}

      {formError && (
        <div className="mt-4 flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg p-3">
          <AlertCircle className="w-4 h-4 text-red-600 mt-0.5 shrink-0" />
          <p className="text-sm text-red-700">{formError}</p>
        </div>
      )}

      <button
        type="button"
        onClick={handleSubmit}
        disabled={submitting}
        className="mt-4 w-full py-3.5 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 disabled:opacity-60 flex items-center justify-center gap-2"
      >
        {submitting ? (
          <>
            <Loader2 className="w-5 h-5 animate-spin" />
            Sending your request…
          </>
        ) : (
          'Confirm booking request'
        )}
      </button>

      <div className="mt-3 flex items-center justify-center gap-1.5 text-xs text-gray-400">
        <ShieldCheck className="w-3.5 h-3.5" />
        No payment now — the lab confirms your slot by phone
      </div>

      {lab?.address && (
        <p className="mt-3 text-xs text-gray-400 flex items-start justify-center gap-1.5 text-center">
          <MapPin className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          {lab.address}
        </p>
      )}
      </>
    )
  );
};

export default PublicBooking;
