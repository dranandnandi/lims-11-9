// Purpose: Resolve a patient portal login when one mobile number has accounts at
// several labs (or duplicate patient rows inside one lab).
//
// Route: POST /patient-portal-login
// Body:  { phone: string, pin: string }
// Auth:  none (public) — this is the login endpoint itself.
//
// Why this exists: the old flow called resolve_patient_virtual_email(phone), which
// returned the OLDEST matching patient only (LIMIT 1). A number registered at 20 labs
// therefore always tried the same account and failed with invalid_credentials even
// when the PIN was correct for a different lab. Here we ask the DB which of the
// candidate accounts the PIN actually belongs to (bcrypt compare inside a
// service-role-only RPC) and hand the caller that one virtual email. The client then
// performs the real sign-in against Supabase Auth, so no session is minted here.
//
// The matcher RPC is a password oracle by nature, so it is never exposed to anon —
// only this function can call it, and it throttles per mobile number.

import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Throttle: MAX_FAILED wrong PINs inside WINDOW_MS locks the number for LOCK_MS.
const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;
const MAX_FAILED = 8;

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

interface MatchRow {
  email: string;
  patient_id: string;
  patient_name: string;
  lab_id: string;
  lab_name: string | null;
  last_order_at: string | null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { phone, pin } = await req.json();

    const digits = String(phone || '').replace(/\D/g, '');
    const cleanPin = String(pin || '').trim();

    if (digits.length < 10) {
      return json({ success: false, reason: 'invalid_phone', message: 'Enter a valid mobile number.' }, 400);
    }
    if (!cleanPin) {
      return json({ success: false, reason: 'invalid_pin', message: 'Enter your PIN.' }, 400);
    }
    const last10 = digits.slice(-10);

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false } }
    );

    // --- Throttle check -----------------------------------------------------
    const nowMs = Date.now();
    const { data: attempt } = await supabaseAdmin
      .from('patient_portal_login_attempts')
      .select('phone_last10, failed_count, window_started, locked_until')
      .eq('phone_last10', last10)
      .maybeSingle();

    if (attempt?.locked_until && new Date(attempt.locked_until).getTime() > nowMs) {
      const minsLeft = Math.max(1, Math.ceil((new Date(attempt.locked_until).getTime() - nowMs) / 60000));
      return json({
        success: false,
        reason: 'locked',
        message: `Too many incorrect PIN attempts. Please try again in ${minsLeft} minute${minsLeft === 1 ? '' : 's'}, or use "Forgot PIN".`,
      }, 429);
    }

    // --- Which account does this PIN belong to? -----------------------------
    const { data: matches, error: matchError } = await supabaseAdmin
      .rpc('patient_portal_match_login', { p_phone: last10, p_pin: cleanPin });

    if (matchError) {
      console.error('[PORTAL-LOGIN] matcher RPC failed:', matchError);
      return json({ success: false, reason: 'error', message: 'Unable to sign in right now. Please try again.' }, 500);
    }

    const rows = (matches || []) as MatchRow[];

    if (rows.length === 0) {
      // Record the failure. Fresh window if the previous one has expired.
      const windowExpired =
        !attempt?.window_started || nowMs - new Date(attempt.window_started).getTime() > WINDOW_MS;
      const failedCount = windowExpired ? 1 : (attempt?.failed_count ?? 0) + 1;
      const nowIso = new Date(nowMs).toISOString();

      await supabaseAdmin.from('patient_portal_login_attempts').upsert({
        phone_last10: last10,
        failed_count: failedCount,
        window_started: windowExpired ? nowIso : attempt!.window_started,
        last_attempt: nowIso,
        locked_until: failedCount >= MAX_FAILED ? new Date(nowMs + LOCK_MS).toISOString() : null,
      });

      // Distinguish "no portal access at all" from "wrong PIN" so the patient gets
      // an actionable message. This leaks only whether the number is registered,
      // which the phone step of the login screen already reveals.
      const { data: accessCount } = await supabaseAdmin
        .rpc('patient_portal_phone_access_count', { p_phone: last10 });

      if (!accessCount) {
        return json({
          success: false,
          reason: 'no_access',
          message: 'No portal access found for this mobile number. Please contact your lab to activate access.',
        }, 404);
      }

      const remaining = Math.max(0, MAX_FAILED - failedCount);
      return json({
        success: false,
        reason: 'wrong_pin',
        message: remaining > 0 && remaining <= 3
          ? `Incorrect PIN. ${remaining} attempt${remaining === 1 ? '' : 's'} left before a temporary lock.`
          : 'Incorrect PIN. Please check the PIN sent to your mobile and try again.',
      }, 401);
    }

    // Success — clear the failure counter.
    if (attempt) {
      await supabaseAdmin.from('patient_portal_login_attempts').delete().eq('phone_last10', last10);
    }

    // More than one account on this number can share a PIN by coincidence
    // (6 digits, several labs). Let the patient pick which lab to open.
    if (rows.length > 1) {
      console.log(`[PORTAL-LOGIN] ${rows.length} accounts share this PIN for ****${last10.slice(-4)}`);
      return json({
        success: true,
        multiple: true,
        accounts: rows.map((r) => ({
          email: r.email,
          patient_name: r.patient_name,
          lab_name: r.lab_name || 'Your lab',
        })),
      });
    }

    const match = rows[0];
    console.log(`[PORTAL-LOGIN] Matched patient ${match.patient_id} at lab ${match.lab_id}`);

    return json({
      success: true,
      multiple: false,
      email: match.email,
      patient_name: match.patient_name,
      lab_name: match.lab_name || 'Your lab',
    });

  } catch (error) {
    console.error('[PORTAL-LOGIN] ERROR:', error);
    return json({ success: false, reason: 'error', message: 'Something went wrong. Please try again.' }, 500);
  }
});
