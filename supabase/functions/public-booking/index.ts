// Purpose: Public, no-login booking endpoint behind the /book/:slug page and the
//          embeddable website widget. The lab's public slug is the only
//          identifier a caller needs; there is no session and no patient login.
// Route:  POST /public-booking          { slug }        -> lab profile + config + test catalog
//         POST /public-booking/submit   { slug, ... }   -> create a pending booking, return its reference
// Auth:   verify_jwt = false
//
// Everything runs on the service role because the anon role has no read access
// to test_groups/packages and no insert on bookings (by design — see
// 20260813000000_public_booking_links.sql). Prices are always re-read from the
// database; the client's numbers are never trusted.

import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

// Unambiguous alphabet: no O/0, no I/1 — patients read these out over the phone.
const REF_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

const DEFAULT_CONFIG = {
  headline: 'Book a lab test',
  intro: '',
  show_prices: true,
  catalog_mode: 'all',
  selected_test_group_ids: [] as string[],
  selected_package_ids: [] as string[],
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

// A lab-wide ceiling so one bad actor cannot flood a lab's booking queue.
const MAX_BOOKINGS_PER_LAB_PER_HOUR = 60;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function serviceClient() {
  return createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { auth: { persistSession: false } }
  );
}

function makeReference() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let code = '';
  for (const b of bytes) code += REF_ALPHABET[b % REF_ALPHABET.length];
  return `BK-${code}`;
}

/** Coarse, non-reversible client fingerprint kept only for abuse triage. */
async function hashClient(req: Request) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || req.headers.get('cf-connecting-ip')
    || '';
  if (!ip) return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip));
  return Array.from(new Uint8Array(digest)).slice(0, 8)
    .map((b) => b.toString(16).padStart(2, '0')).join('');
}

function normalisePhone(raw: unknown) {
  return String(raw ?? '').replace(/\D/g, '');
}

async function loadLab(supabase: ReturnType<typeof serviceClient>, slugRaw: unknown) {
  const slug = String(slugRaw ?? '').trim().toLowerCase();
  if (!slug) return { lab: null, config: DEFAULT_CONFIG };

  const { data: lab } = await supabase
    .from('labs')
    .select('id, name, city, address, phone, email, currency_code, public_booking_enabled, public_booking_config')
    .eq('public_booking_slug', slug)
    .maybeSingle();

  if (!lab || !lab.public_booking_enabled) return { lab: null, config: DEFAULT_CONFIG };

  return { lab, config: { ...DEFAULT_CONFIG, ...(lab.public_booking_config || {}) } };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const isSubmit = url.pathname.endsWith('/submit');

    let body: Record<string, unknown> = {};
    if (req.method === 'POST') {
      try {
        body = await req.json();
      } catch {
        body = {};
      }
    }

    const slug = (body.slug as string) || url.searchParams.get('slug') || '';
    const supabase = serviceClient();
    const { lab, config } = await loadLab(supabase, slug);

    if (!lab) {
      return json({ error: 'Online booking is not available for this lab.' }, 404);
    }

    // ------------------------------------------------------------- catalog --
    if (!isSubmit) {
      const [{ data: logo }, { data: groups }, { data: packages }] = await Promise.all([
        supabase
          .from('lab_branding_assets')
          .select('file_url')
          .eq('lab_id', lab.id)
          .eq('asset_type', 'logo')
          .eq('is_active', true)
          .order('is_default', { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from('test_groups')
          .select('id, name, category, price, requires_fasting, turnaround_time, sample_type, only_male, only_female, description')
          .eq('lab_id', lab.id)
          .eq('is_active', true)
          // IS NOT TRUE, not = false: these columns are nullable on older rows
          .not('is_section_only', 'is', true)
          .not('only_billing', 'is', true)
          .order('name'),
        supabase
          .from('packages')
          .select('id, name, category, price, description')
          .eq('lab_id', lab.id)
          .eq('is_active', true)
          .order('name'),
      ]);

      const pickedGroups = new Set(config.selected_test_group_ids || []);
      const pickedPackages = new Set(config.selected_package_ids || []);
      const filterBySelection = config.catalog_mode === 'selected';

      return json({
        lab: {
          name: lab.name,
          city: lab.city,
          address: lab.address,
          phone: lab.phone,
          email: lab.email,
          currency_code: lab.currency_code || 'INR',
          logo_url: logo?.file_url ?? null,
        },
        config: {
          headline: config.headline,
          intro: config.intro,
          show_prices: config.show_prices,
          allow_home_collection: config.allow_home_collection,
          allow_walk_in: config.allow_walk_in,
          home_collection_charge: Number(config.home_collection_charge) || 0,
          require_email: config.require_email,
          require_age_gender: config.require_age_gender,
          slot_days_ahead: config.slot_days_ahead,
          slot_start_hour: config.slot_start_hour,
          slot_end_hour: config.slot_end_hour,
          slot_minutes: config.slot_minutes,
          terms: config.terms,
        },
        tests: (groups || [])
          .filter((g) => !filterBySelection || pickedGroups.has(g.id))
          .map((g) => ({
            id: g.id,
            type: 'test_group',
            name: g.name,
            category: g.category,
            price: Number(g.price) || 0,
            requires_fasting: !!g.requires_fasting,
            turnaround_time: g.turnaround_time,
            sample_type: g.sample_type,
            only_male: !!g.only_male,
            only_female: !!g.only_female,
            description: g.description,
          })),
        packages: (packages || [])
          .filter((p) => !filterBySelection || pickedPackages.has(p.id))
          .map((p) => ({
            id: p.id,
            type: 'package',
            name: p.name,
            category: p.category,
            price: Number(p.price) || 0,
            description: p.description,
          })),
      });
    }

    // -------------------------------------------------------------- submit --

    // Honeypot: a hidden field no human fills in.
    if (String(body.company ?? '').trim()) {
      return json({ error: 'Submission rejected.' }, 400);
    }

    const patient = (body.patient || {}) as Record<string, unknown>;
    const name = String(patient.name ?? '').trim();
    const phone = normalisePhone(patient.phone);
    const email = String(patient.email ?? '').trim();
    const items = Array.isArray(body.items) ? body.items : [];

    if (name.length < 2) return json({ error: 'Please enter the patient name.' }, 400);
    if (phone.length < 10 || phone.length > 15) {
      return json({ error: 'Please enter a valid mobile number.' }, 400);
    }
    if (config.require_email && !/^\S+@\S+\.\S+$/.test(email)) {
      return json({ error: 'Please enter a valid email address.' }, 400);
    }
    if (!items.length) return json({ error: 'Please select at least one test.' }, 400);
    if (items.length > 40) return json({ error: 'Too many tests selected.' }, 400);

    const collectionType = String(body.collection_type ?? 'walk_in');
    if (collectionType === 'home_collection' && !config.allow_home_collection) {
      return json({ error: 'Home collection is not available for this lab.' }, 400);
    }
    if (collectionType === 'walk_in' && !config.allow_walk_in) {
      return json({ error: 'Walk-in booking is not available for this lab.' }, 400);
    }
    if (!['home_collection', 'walk_in'].includes(collectionType)) {
      return json({ error: 'Please choose how you want the sample collected.' }, 400);
    }

    let address: Record<string, unknown> | null = null;
    if (collectionType === 'home_collection') {
      const raw = (body.address || {}) as Record<string, unknown>;
      const line = String(raw.address ?? '').trim();
      if (line.length < 8) {
        return json({ error: 'Please enter the full collection address.' }, 400);
      }
      address = {
        address: line.slice(0, 500),
        city: String(raw.city ?? '').trim().slice(0, 120) || null,
        pincode: String(raw.pincode ?? '').trim().slice(0, 12) || null,
      };
    }

    // Slot must be in the future and inside the booking window the lab allows.
    let scheduledAt: string | null = null;
    if (body.scheduled_at) {
      const when = new Date(String(body.scheduled_at));
      if (Number.isNaN(when.getTime())) {
        return json({ error: 'Please choose a valid appointment time.' }, 400);
      }
      const horizon = Date.now() + (Number(config.slot_days_ahead) || 7) * 86400000 + 86400000;
      if (when.getTime() < Date.now() - 3600000 || when.getTime() > horizon) {
        return json({ error: 'Please choose an appointment time within the allowed window.' }, 400);
      }
      scheduledAt = when.toISOString();
    }

    // --------------------------------------------------------- rate limits --
    const dayAgo = new Date(Date.now() - 86400000).toISOString();
    const hourAgo = new Date(Date.now() - 3600000).toISOString();

    const { data: recentForLab } = await supabase
      .from('bookings')
      .select('id, patient_info, created_at')
      .eq('lab_id', lab.id)
      .eq('booking_source', 'public_web')
      .gte('created_at', dayAgo);

    const labLastHour = (recentForLab || []).filter((b) => b.created_at >= hourAgo).length;
    if (labLastHour >= MAX_BOOKINGS_PER_LAB_PER_HOUR) {
      return json({ error: 'Too many booking requests right now. Please call the lab.' }, 429);
    }

    const perPhoneCap = Number(config.max_per_phone_per_day) || 5;
    const samePhone = (recentForLab || []).filter(
      (b) => normalisePhone((b.patient_info as Record<string, unknown> | null)?.phone) === phone
    ).length;
    if (samePhone >= perPhoneCap) {
      return json(
        { error: 'You already have booking requests with this lab. Please call us to add more.' },
        429
      );
    }

    // ------------------------------------------------- server-side pricing --
    const requestedGroupIds = items
      .filter((i: Record<string, unknown>) => i.type !== 'package')
      .map((i: Record<string, unknown>) => String(i.id));
    const requestedPackageIds = items
      .filter((i: Record<string, unknown>) => i.type === 'package')
      .map((i: Record<string, unknown>) => String(i.id));

    const [{ data: groupRows }, { data: packageRows }] = await Promise.all([
      requestedGroupIds.length
        ? supabase
            .from('test_groups')
            .select('id, name, price')
            .eq('lab_id', lab.id)
            .eq('is_active', true)
            .in('id', requestedGroupIds)
        : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
      requestedPackageIds.length
        ? supabase
            .from('packages')
            .select('id, name, price')
            .eq('lab_id', lab.id)
            .eq('is_active', true)
            .in('id', requestedPackageIds)
        : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
    ]);

    interface BookingItem {
      id: string;
      name: string;
      price: number;
      type: 'test_group' | 'package' | 'note';
    }

    const testDetails: BookingItem[] = [
      ...(groupRows || []).map((g) => ({
        id: g.id as string,
        name: g.name as string,
        price: Number(g.price) || 0,
        type: 'test_group' as const,
      })),
      ...(packageRows || []).map((p) => ({
        id: p.id as string,
        name: p.name as string,
        price: Number(p.price) || 0,
        type: 'package' as const,
      })),
    ];

    if (!testDetails.length) {
      return json({ error: 'The selected tests are no longer available. Please refresh and try again.' }, 400);
    }

    const collectionCharge = collectionType === 'home_collection'
      ? Number(config.home_collection_charge) || 0
      : 0;
    const amount = testDetails.reduce((sum, t) => sum + t.price, 0) + collectionCharge;

    if (collectionCharge > 0) {
      testDetails.push({
        id: 'home-collection-charge',
        name: 'Home collection charge',
        price: collectionCharge,
        type: 'note',
      });
    }

    // -------------------------------------------------------------- insert --
    const ageRaw = Number(patient.age);
    const patientInfo = {
      name: name.slice(0, 160),
      phone,
      age: Number.isFinite(ageRaw) && ageRaw > 0 && ageRaw < 130 ? Math.round(ageRaw) : undefined,
      gender: ['Male', 'Female', 'Other'].includes(String(patient.gender))
        ? String(patient.gender)
        : undefined,
      email: email ? email.slice(0, 160) : undefined,
    };

    const sourceMeta = {
      channel: 'public_link',
      slug: String(slug).toLowerCase(),
      referrer: String(body.referrer ?? '').slice(0, 300) || null,
      user_agent: (req.headers.get('user-agent') || '').slice(0, 300) || null,
      ip_hash: await hashClient(req),
      notes: String(body.notes ?? '').trim().slice(0, 1000) || null,
    };

    let inserted: { id: string; public_reference: string } | null = null;
    let lastError: unknown = null;

    // Retry only guards against a reference collision (1 in 32^6).
    for (let attempt = 0; attempt < 5 && !inserted; attempt++) {
      const { data, error } = await supabase
        .from('bookings')
        .insert({
          lab_id: lab.id,
          booking_source: 'public_web',
          status: 'pending',
          patient_info: patientInfo,
          test_details: testDetails,
          scheduled_at: scheduledAt,
          collection_type: collectionType,
          home_collection_address: address,
          quotation_amount: amount,
          public_reference: makeReference(),
          source_meta: sourceMeta,
          created_by: null,
        })
        .select('id, public_reference')
        .single();

      if (!error) {
        inserted = data as { id: string; public_reference: string };
        break;
      }
      lastError = error;
      if ((error as { code?: string }).code !== '23505') break;
    }

    if (!inserted) {
      console.error('[PUBLIC-BOOKING] Insert failed:', lastError);
      return json({ error: 'Could not save your booking. Please call the lab.' }, 500);
    }

    console.log('[PUBLIC-BOOKING] Booking created', {
      lab_id: lab.id,
      booking_id: inserted.id,
      reference: inserted.public_reference,
      items: testDetails.length,
    });

    return json({
      success: true,
      reference: inserted.public_reference,
      amount,
      currency: lab.currency_code || 'INR',
      lab_name: lab.name,
      lab_phone: lab.phone,
      scheduled_at: scheduledAt,
      collection_type: collectionType,
    });
  } catch (error) {
    console.error('[PUBLIC-BOOKING] Error:', error);
    return json({ error: (error as Error).message || 'Internal server error' }, 500);
  }
});
