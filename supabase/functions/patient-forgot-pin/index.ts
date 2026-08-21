// Purpose: Self-service PIN reset for patient portal users.
// Route: POST /patient-forgot-pin
// Body: { phone: string }
// Auth: none (public) — the new PIN is never returned to the caller; it is only
// delivered via the lab's connected WhatsApp session to the registered number.
// The password is updated ONLY after the WhatsApp send succeeds, so a failed
// send never locks the patient out of their current PIN.
//
// One mobile number can hold portal access at several labs, and the caller cannot
// tell us which lab they mean — they have forgotten the PIN that would identify it.
// So every portal account on the number is reset and each lab's new PIN is sent from
// that lab's own WhatsApp session, one message per lab.

import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { resolveWhatsAppSender, formatPhoneForSender } from '../_shared/whatsappSender.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Minimum gap between self-service resets for one patient
const RESET_COOLDOWN_MS = 2 * 60 * 1000;

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function generatePin(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}


Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { phone } = await req.json();
    const cleanDigits = String(phone || '').replace(/\D/g, '');

    if (cleanDigits.length < 10) {
      return json({ success: false, reason: 'invalid_phone', message: 'Enter a valid mobile number.' }, 400);
    }
    const last10 = cleanDigits.slice(-10);

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false } }
    );

    // Find portal-enabled patients whose phone ends with the given number.
    // ilike on the last 4 digits narrows the scan; exact match happens in JS
    // because stored phone formats vary (spaces, +91, dashes).
    const { data: candidates } = await supabaseAdmin
      .from('patients')
      .select('id, name, phone, lab_id, default_location_id, patient_auth_id, portal_pin_reset_at, portal_access_enabled')
      .eq('portal_access_enabled', true)
      .eq('is_active', true)
      .not('patient_auth_id', 'is', null)
      .ilike('phone', `%${last10.slice(-4)}%`)
      .limit(500);

    const patients = (candidates || []).filter(
      (p) => String(p.phone || '').replace(/\D/g, '').slice(-10) === last10
    );

    if (patients.length === 0) {
      return json({
        success: false,
        reason: 'not_found',
        message: 'No portal access found for this mobile number. Please contact your lab.',
      }, 404);
    }

    // Throttle repeated resets — the most recent reset across all of the number's
    // accounts governs, so the endpoint cannot be cycled lab by lab.
    const lastReset = patients
      .map((p) => (p.portal_pin_reset_at ? new Date(p.portal_pin_reset_at).getTime() : 0))
      .reduce((a, b) => Math.max(a, b), 0);

    if (lastReset && Date.now() - lastReset < RESET_COOLDOWN_MS) {
      return json({
        success: false,
        reason: 'too_soon',
        message: 'A PIN was sent recently. Please wait a couple of minutes and check WhatsApp.',
      }, 429);
    }

    const waBase = Deno.env.get('WHATSAPP_API_BASE_URL') || 'https://app.limsapp.in/whatsapp';
    const waKey = Deno.env.get('WHATSAPP_API_KEY') || 'whatsapp-lims-secure-api-key-2024';

    const labIds = [...new Set(patients.map((p) => p.lab_id))];
    const { data: labRows } = await supabaseAdmin
      .from('labs')
      .select('id, name')
      .in('id', labIds);

    const labsById = new Map((labRows || []).map((l) => [l.id, l]));

    let sentCount = 0;
    let whatsappUnavailable = 0;
    const labNamesSent: string[] = [];

    // Reset each account the number owns. Per account: send first, apply the new PIN
    // only on a successful send, so a delivery failure never strands the patient
    // without a working PIN.
    for (const patient of patients) {
      const lab = labsById.get(patient.lab_id);

      // Send from the branch the patient is registered at when that branch has
      // its own number, so the PIN arrives from a number they recognise.
      const sender = await resolveWhatsAppSender(supabaseAdmin, {
        labId: patient.lab_id,
        locationId: patient.default_location_id,
      });

      if (!sender.userId) {
        whatsappUnavailable++;
        continue;
      }

      const pin = generatePin();
      const message =
        `Hello ${patient.name},\n\nYour new patient portal PIN for *${lab?.name || 'your lab'}* is *${pin}*.\n\n` +
        `Login: https://app.limsapp.in/patient/login\n` +
        `Use your registered mobile number and this PIN.\n\n` +
        `If you did not request this, please contact ${lab?.name || 'your lab'}.`;

      let sendOk = false;
      try {
        const waRes = await fetch(`${waBase}/api/external/messages/send-user`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-API-Key': waKey },
          body: JSON.stringify({
            userId: sender.userId,
            phoneNumber: formatPhoneForSender(patient.phone, sender.countryCode),
            message,
          }),
        });
        const waJson = await waRes.json().catch(() => ({}));
        sendOk = waRes.ok && waJson?.success !== false;
        if (!sendOk) console.error('[FORGOT-PIN] WhatsApp send failed:', patient.id, waRes.status, waJson);
      } catch (err) {
        console.error('[FORGOT-PIN] WhatsApp send error:', patient.id, err);
      }

      if (!sendOk) continue;

      const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(
        patient.patient_auth_id,
        { password: pin }
      );

      if (updateError) {
        console.error('[FORGOT-PIN] Password update failed after send:', patient.id, updateError);
        continue;
      }

      await supabaseAdmin
        .from('patients')
        .update({
          portal_pin_reset_at: new Date().toISOString(),
          portal_pin_self_set_at: null,
        })
        .eq('id', patient.id);

      // Keep the lab's patient page able to show the current PIN.
      try {
        const { data: authUser } = await supabaseAdmin.auth.admin.getUserById(patient.patient_auth_id);
        if (authUser?.user?.email) {
          await supabaseAdmin
            .from('portal_credentials')
            .upsert({
              lab_id: patient.lab_id,
              credential_type: 'patient_portal',
              auth_user_id: patient.patient_auth_id,
              email: authUser.user.email,
              password_text: pin,
              updated_at: new Date().toISOString(),
            }, { onConflict: 'lab_id,credential_type,email' });
        }
      } catch (credErr) {
        console.warn('[FORGOT-PIN] PIN store failed:', credErr);
      }

      sentCount++;
      if (lab?.name && !labNamesSent.includes(lab.name)) labNamesSent.push(lab.name);
    }

    // A patient's PIN attempts are throttled per number; a successful reset should
    // not leave them locked out of the PIN they were just sent.
    if (sentCount > 0) {
      await supabaseAdmin.from('patient_portal_login_attempts').delete().eq('phone_last10', last10);
    }

    if (sentCount === 0) {
      return json({
        success: false,
        reason: whatsappUnavailable === patients.length ? 'whatsapp_unavailable' : 'send_failed',
        message: 'Could not send a new PIN right now. Please contact your lab to reset your PIN.',
      });
    }

    console.log(`[FORGOT-PIN] Reset ${sentCount}/${patients.length} accounts for ****${last10.slice(-4)}`);

    return json({
      success: true,
      accounts_reset: sentCount,
      message: sentCount === 1
        ? `A new PIN has been sent via WhatsApp to your number ending ${last10.slice(-4)}.`
        : `Your number is registered at ${sentCount} labs — a separate PIN for each has been sent on WhatsApp (${labNamesSent.join(', ')}). Use the PIN for the lab whose reports you want to see.`,
    });

  } catch (error) {
    console.error('[FORGOT-PIN] ERROR:', error);
    return json({ success: false, reason: 'error', message: 'Something went wrong. Please try again.' }, 500);
  }
});
