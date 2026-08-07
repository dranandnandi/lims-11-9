// Purpose: Public, token-bearer endpoint behind the /pay/:token page.
//          The token IS the credential — nothing here requires a session, and
//          nothing here returns anything the bearer shouldn't already know.
// Route:  GET  /pay-link?token=...          -> display metadata
//         POST /pay-link/start { token }    -> create the gateway attempt, return redirect payload
//         GET  /pay-link/status?token=...   -> polling for the counter screen
// Auth:   verify_jwt = false

import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import {
  corsHeaders,
  generateOrderId,
  handleCCAvenue,
  handleRazorpay,
} from "../_shared/paymentProviders.ts";

const APP_BASE_URL = (Deno.env.get('PAYMENT_APP_BASE_URL') ?? 'https://app.limsapp.in').replace(/\/+$/, '');
const FUNCTIONS_BASE_URL = (Deno.env.get('PAYMENT_FUNCTIONS_BASE_URL') ?? Deno.env.get('SUPABASE_URL') ?? '').replace(/\/+$/, '');

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

/** Marks the link expired in-place if it has aged out, and reports the effective status. */
async function resolveLink(supabase: ReturnType<typeof serviceClient>, token: string) {
  const { data: link } = await supabase
    .from('payment_links')
    .select('*')
    .eq('token', token)
    .maybeSingle();

  if (!link) return { link: null, expired: false };

  const expired = new Date(link.expires_at).getTime() < Date.now();

  if (expired && (link.status === 'active' || link.status === 'failed')) {
    await supabase.from('payment_links').update({ status: 'expired' }).eq('id', link.id);
    link.status = 'expired';
  }

  return { link, expired };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const isStart = url.pathname.endsWith('/start');
    const isStatus = url.pathname.endsWith('/status');

    let token = url.searchParams.get('token') ?? '';
    let bodyJson: Record<string, unknown> = {};

    if (req.method === 'POST') {
      try {
        bodyJson = await req.json();
      } catch {
        bodyJson = {};
      }
      token = (bodyJson.token as string) || token;
    }

    if (!token) {
      return json({ error: 'Missing token' }, 400);
    }

    const supabase = serviceClient();
    const { link } = await resolveLink(supabase, token);

    if (!link) {
      return json({ error: 'Payment link not found' }, 404);
    }

    // ---------------------------------------------------------------- status --
    if (isStatus) {
      let paidAt: string | null = null;
      let attemptStatus: string | null = null;

      if (link.payment_attempt_id) {
        const { data: attempt } = await supabase
          .from('b2b_payment_attempts')
          .select('status, completed_at, payment_method')
          .eq('id', link.payment_attempt_id)
          .maybeSingle();

        attemptStatus = attempt?.status ?? null;
        paidAt = attempt?.completed_at ?? null;
      }

      return json({
        status: link.status,
        attempt_status: attemptStatus,
        payment_id: link.payment_attempt_id,
        paid_at: paidAt,
        amount: Number(link.amount),
      });
    }

    // ------------------------------------------------------------- metadata --
    if (!isStart) {
      const { data: lab } = await supabase
        .from('labs')
        .select('name, city, phone')
        .eq('id', link.lab_id)
        .maybeSingle();

      const { data: logo } = await supabase
        .from('lab_branding_assets')
        .select('file_url')
        .eq('lab_id', link.lab_id)
        .eq('asset_type', 'logo')
        .eq('is_active', true)
        .order('is_default', { ascending: false })
        .limit(1)
        .maybeSingle();

      let invoiceNumber: string | null = null;
      if (link.invoice_id) {
        const { data: invoice } = await supabase
          .from('invoices')
          .select('invoice_number')
          .eq('id', link.invoice_id)
          .maybeSingle();
        invoiceNumber = invoice?.invoice_number ?? null;
      }

      // Deliberately narrow: no ids beyond what the bearer already holds.
      return json({
        status: link.status,
        amount: Number(link.amount),
        currency: link.currency,
        payer_name: link.payer_name,
        invoice_number: invoiceNumber,
        expires_at: link.expires_at,
        expired: link.status === 'expired',
        lab_name: lab?.name ?? null,
        lab_city: lab?.city ?? null,
        lab_phone: lab?.phone ?? null,
        lab_logo_url: logo?.file_url ?? null,
      });
    }

    // ---------------------------------------------------------------- start --
    if (link.status === 'paid') {
      return json({ error: 'This payment has already been completed', status: 'paid' }, 409);
    }
    if (link.status === 'expired') {
      return json({ error: 'This payment link has expired', status: 'expired' }, 410);
    }
    if (link.status === 'cancelled') {
      return json({ error: 'This payment link was cancelled', status: 'cancelled' }, 410);
    }

    const { data: gateways } = await supabase
      .from('lab_payment_gateways')
      .select('*')
      .eq('lab_id', link.lab_id)
      .eq('is_active', true)
      .eq('allow_patient_payments', true)
      .order('is_default', { ascending: false })
      .limit(1);

    const gateway = gateways?.[0];
    if (!gateway) {
      return json({ error: 'Online payments are not enabled for this lab' }, 400);
    }

    const provider = gateway.provider as string;
    const credentials = gateway.credentials_encrypted || {};
    const gatewayOrderId = generateOrderId(provider.toUpperCase().substring(0, 3));
    const amount = Number(link.amount);

    const { data: paymentAttempt, error: attemptError } = await supabase
      .from('b2b_payment_attempts')
      .insert({
        lab_id: link.lab_id,
        account_id: null,
        payer_type: 'patient',
        invoice_id: link.invoice_id,
        order_id: link.order_id,
        patient_id: link.patient_id,
        payer_name: link.payer_name,
        payer_phone: link.payer_phone,
        payer_email: link.payer_email,
        gateway_id: gateway.id,
        provider,
        gateway_order_id: gatewayOrderId,
        amount,
        currency: link.currency || 'INR',
        payment_purpose: 'patient_invoice',
        status: 'initiated',
        idempotency_key: `${link.token}-${Date.now()}`,
        raw_request: { token: link.token, link_id: link.id },
      })
      .select()
      .single();

    if (attemptError || !paymentAttempt) {
      console.error('[PAY-LINK] Failed to create payment attempt:', attemptError);
      return json({ error: 'Failed to start payment' }, 500);
    }

    const payer = {
      name: link.payer_name || 'Patient',
      email: link.payer_email,
      phone: link.payer_phone,
    };

    // CCAvenue POSTs its response back to the callback function, which then
    // bounces the browser to /pay/:token/success|failed.
    const redirectUrl = gateway.redirect_url || `${FUNCTIONS_BASE_URL}/functions/v1/payment-callback?provider=${provider}`;
    const cancelUrl = gateway.cancel_url || `${APP_BASE_URL}/pay/${link.token}/failed`;

    let responseData: Record<string, unknown>;

    if (provider === 'ccavenue') {
      responseData = await handleCCAvenue(
        gateway,
        credentials,
        paymentAttempt,
        payer,
        amount,
        redirectUrl,
        cancelUrl,
        { linkToken: link.token }
      );
    } else if (provider === 'razorpay') {
      responseData = await handleRazorpay(
        gateway,
        credentials,
        paymentAttempt,
        payer,
        amount,
        {
          linkToken: link.token,
          title: 'Lab Payment',
          description: `Payment for ${payer.name}`,
        }
      );
    } else {
      return json({ error: `Unsupported payment provider: ${provider}` }, 400);
    }

    await supabase
      .from('b2b_payment_attempts')
      .update({
        status: 'pending',
        raw_request: { token: link.token, link_id: link.id, gateway_response: responseData },
      })
      .eq('id', paymentAttempt.id);

    await supabase
      .from('payment_links')
      .update({
        payment_attempt_id: paymentAttempt.id,
        opened_at: link.opened_at ?? new Date().toISOString(),
        open_count: (link.open_count ?? 0) + 1,
        status: 'active',
      })
      .eq('id', link.id);

    console.log('[PAY-LINK] Payment started', {
      link_id: link.id,
      payment_id: paymentAttempt.id,
      provider,
    });

    return json({
      success: true,
      payment_id: paymentAttempt.id,
      gateway_order_id: gatewayOrderId,
      provider,
      ...responseData,
    });
  } catch (error) {
    console.error('[PAY-LINK] Error:', error);
    return json({ error: (error as Error).message || 'Internal server error' }, 500);
  }
});
