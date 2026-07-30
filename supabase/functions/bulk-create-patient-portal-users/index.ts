// Purpose: Bulk-create portal access for all patients in a lab (idempotent)
// Route: POST /bulk-create-patient-portal-users
// Body: { lab_id: string }
// Auth: service role key (called from lab settings)
// Returns: { total, created, failed, results[] } — results include PINs for WhatsApp dispatch

import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface BulkResult {
  patient_id: string;
  name: string;
  phone: string;
  pin?: string;
  error?: string;
}

// Supabase Auth only keeps the bcrypt hash, so a PIN is unrecoverable once this
// response is gone. Record it in portal_credentials (admin-read-only via RLS) so the
// lab can re-read it from the patient page instead of resetting.
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
    if (error) console.warn('[BULK-PATIENT-PORTAL] Could not store PIN:', error.message);
  } catch (err) {
    console.warn('[BULK-PATIENT-PORTAL] PIN store failed:', err);
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { lab_id, force_reset = false } = await req.json();

    if (!lab_id) {
      return new Response(
        JSON.stringify({ error: 'lab_id required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false } }
    );

    // force_reset=true fetches ALL patients (including already activated) to reset PINs
    // force_reset=false (default) only fetches patients without portal access
    let query = supabaseAdmin
      .from('patients')
      .select('id, name, phone, lab_id, patient_auth_id')
      .eq('lab_id', lab_id)
      .eq('is_active', true)
      .not('phone', 'is', null)
      .order('created_at', { ascending: true });

    if (!force_reset) {
      query = query.eq('portal_access_enabled', false);
    }

    const { data: patients, error: fetchError } = await query;

    if (fetchError) {
      throw new Error(`Failed to fetch patients: ${fetchError.message}`);
    }

    if (!patients?.length) {
      return new Response(
        JSON.stringify({
          success: true,
          total: 0,
          created: 0,
          failed: 0,
          skipped: 0,
          message: 'All active patients already have portal access or have no phone number',
          results: [],
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`[BULK-PATIENT-PORTAL] Processing ${patients.length} patients for lab ${lab_id}`);

    let created = 0;
    let failed = 0;
    const results: BulkResult[] = [];

    // Process in batches of 50 to avoid overwhelming the auth service
    const BATCH_SIZE = 50;

    for (let i = 0; i < patients.length; i += BATCH_SIZE) {
      const batch = patients.slice(i, i + BATCH_SIZE);

      await Promise.all(
        batch.map(async (patient) => {
          try {
            const pin = String(Math.floor(100000 + Math.random() * 900000));
            const shortId = patient.id.replace(/-/g, '').slice(-8);
            const cleanPhone = patient.phone.replace(/\D/g, '').slice(-10);
            const email = `p_${cleanPhone}_${shortId}@patient.portal`;

            if (force_reset && patient.patient_auth_id) {
              // Already has auth user — just reset the PIN (password)
              const { error: resetError } = await supabaseAdmin.auth.admin.updateUserById(
                patient.patient_auth_id,
                { password: pin }
              );
              if (resetError) throw new Error(resetError.message);

              await supabaseAdmin
                .from('patients')
                .update({
                  portal_pin_reset_at: new Date().toISOString(),
                  portal_pin_self_set_at: null,
                })
                .eq('id', patient.id);

              // The stored email may predate a phone edit, so use what auth holds.
              const { data: authUser } = await supabaseAdmin.auth.admin.getUserById(patient.patient_auth_id);
              await recordPin(supabaseAdmin, {
                labId: patient.lab_id,
                authUserId: patient.patient_auth_id,
                email: authUser?.user?.email || email,
                pin,
              });
            } else {
              // Create new auth user
              const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
                email,
                password: pin,
                email_confirm: true,
                user_metadata: {
                  role: 'patient',
                  patient_id: patient.id,
                  lab_id: patient.lab_id,
                  name: patient.name,
                  phone: patient.phone,
                },
              });

              if (authError) throw new Error(authError.message);

              await supabaseAdmin
                .from('patients')
                .update({
                  patient_auth_id: authData.user!.id,
                  portal_access_enabled: true,
                  portal_access_sent_at: new Date().toISOString(),
                  portal_pin_self_set_at: null,
                })
                .eq('id', patient.id);

              await recordPin(supabaseAdmin, {
                labId: patient.lab_id,
                authUserId: authData.user!.id,
                email,
                pin,
              });
            }

            results.push({ patient_id: patient.id, name: patient.name, phone: patient.phone, pin });
            created++;
          } catch (e) {
            failed++;
            results.push({
              patient_id: patient.id,
              name: patient.name,
              phone: patient.phone,
              error: e instanceof Error ? e.message : 'Unknown error',
            });
          }
        })
      );

      // Small delay between batches to avoid auth rate limits
      if (i + BATCH_SIZE < patients.length) {
        await new Promise((r) => setTimeout(r, 300));
      }
    }

    console.log(`[BULK-PATIENT-PORTAL] Done: created=${created}, failed=${failed}`);

    return new Response(
      JSON.stringify({
        success: true,
        total: patients.length,
        created,
        failed,
        results, // Each created entry has { name, phone, pin } — lab sends PINs via WhatsApp
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[BULK-PATIENT-PORTAL] ERROR:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
