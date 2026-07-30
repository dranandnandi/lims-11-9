// Purpose: Create or reset portal access for a single patient
// Route: POST /create-patient-portal-user
// Body: { patient_id: string }
// Auth: service role key (called from lab admin UI)

import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function generatePin(): string {
  // 6-digit numeric PIN, no leading zeros
  return String(Math.floor(100000 + Math.random() * 900000));
}

// Virtual email — unique per patient, never receives actual email
// Format: p_{last10digits_of_phone}_{last8chars_of_patient_uuid}@patient.portal
function buildVirtualEmail(phone: string, patientId: string): string {
  const shortId = patientId.replace(/-/g, '').slice(-8);
  const cleanPhone = phone.replace(/\D/g, '').slice(-10);
  return `p_${cleanPhone}_${shortId}@patient.portal`;
}

// Supabase Auth only keeps the bcrypt hash, so the PIN would be unrecoverable after
// this one response. Record it in portal_credentials (admin-read-only via RLS) so the
// lab can look it up again from the patient page instead of forcing a reset.
async function recordPin(
  supabaseAdmin: ReturnType<typeof createClient>,
  args: { labId: string; authUserId: string; email: string; pin: string }
): Promise<void> {
  try {
    const { error } = await supabaseAdmin
      .from('portal_credentials')
      .upsert({
        lab_id: args.labId,
        credential_type: 'patient_portal',
        auth_user_id: args.authUserId,
        email: args.email,
        password_text: args.pin,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'lab_id,credential_type,email' });
    if (error) console.warn('[PATIENT-PORTAL] Could not store PIN:', error.message);
  } catch (err) {
    console.warn('[PATIENT-PORTAL] PIN store failed:', err);
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { patient_id } = await req.json();

    if (!patient_id) {
      return new Response(
        JSON.stringify({ error: 'patient_id required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false } }
    );

    // Fetch patient
    const { data: patient, error: fetchError } = await supabaseAdmin
      .from('patients')
      .select('id, name, phone, lab_id, portal_access_enabled, patient_auth_id')
      .eq('id', patient_id)
      .single();

    if (fetchError || !patient) {
      return new Response(
        JSON.stringify({ error: 'Patient not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!patient.phone) {
      return new Response(
        JSON.stringify({ error: 'Patient has no phone number — cannot create portal access' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const pin = generatePin();
    const email = buildVirtualEmail(patient.phone, patient.id);

    // If auth user already exists → reset PIN only
    if (patient.patient_auth_id) {
      const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(
        patient.patient_auth_id,
        { password: pin }
      );

      if (updateError) {
        throw new Error(`PIN reset failed: ${updateError.message}`);
      }

      await supabaseAdmin
        .from('patients')
        .update({
          portal_pin_reset_at: new Date().toISOString(),
          portal_access_enabled: true,
          portal_pin_self_set_at: null, // lab-issued PIN is now the current one again
        })
        .eq('id', patient_id);

      // The auth user's email was built from the phone number as it stood at
      // creation time; a later phone edit would make the derived value wrong, so
      // record the PIN against the address auth actually holds.
      const { data: authUser } = await supabaseAdmin.auth.admin.getUserById(patient.patient_auth_id);
      await recordPin(supabaseAdmin, {
        labId: patient.lab_id,
        authUserId: patient.patient_auth_id,
        email: authUser?.user?.email || email,
        pin,
      });

      console.log(`[PATIENT-PORTAL] PIN reset for patient ${patient_id}`);

      return new Response(
        JSON.stringify({
          success: true,
          action: 'pin_reset',
          patient_name: patient.name,
          phone: patient.phone,
          pin, // Lab uses this to send via WhatsApp
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Create new auth user
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password: pin,
      email_confirm: true, // Skip email verification — access is PIN-based via WhatsApp
      user_metadata: {
        role: 'patient',
        patient_id: patient.id,
        lab_id: patient.lab_id,
        name: patient.name,
        phone: patient.phone,
      },
    });

    if (authError) {
      throw new Error(`Auth creation failed: ${authError.message}`);
    }

    // Link auth user back to patient record
    await supabaseAdmin
      .from('patients')
      .update({
        patient_auth_id: authData.user!.id,
        portal_access_enabled: true,
        portal_access_sent_at: new Date().toISOString(),
        portal_pin_self_set_at: null,
      })
      .eq('id', patient_id);

    await recordPin(supabaseAdmin, {
      labId: patient.lab_id,
      authUserId: authData.user!.id,
      email,
      pin,
    });

    console.log(`[PATIENT-PORTAL] Created portal access for patient ${patient_id}`);

    return new Response(
      JSON.stringify({
        success: true,
        action: 'created',
        patient_name: patient.name,
        phone: patient.phone,
        pin, // Lab uses this to send via WhatsApp — never exposed to frontend beyond this call
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[PATIENT-PORTAL] ERROR:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
