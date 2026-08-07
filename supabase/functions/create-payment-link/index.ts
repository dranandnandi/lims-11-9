// Purpose: Issue a short-lived, tokenised payment link for a patient invoice.
//          The returned URL is what the counter QR encodes and what WhatsApp carries.
// Route: POST /create-payment-link
// Auth:  Caller's JWT. Either a lab staff user in lab_id, or a patient-portal
//        user paying their own invoice. Unlike initiate-payment, this function
//        authorises the caller before using the service role.
// Body:
// {
//   "lab_id": "uuid",
//   "invoice_id": "uuid",            // or order_id
//   "order_id": "uuid" (optional),
//   "patient_id": "uuid" (optional),
//   "amount": 1250.00,
//   "payer_name": "..." (optional),
//   "payer_phone": "..." (optional),
//   "payer_email": "..." (optional),
//   "expires_in_minutes": 1440 (optional)
// }

import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { corsHeaders, generateLinkToken } from "../_shared/paymentProviders.ts";

const APP_BASE_URL = (Deno.env.get('PAYMENT_APP_BASE_URL') ?? 'https://app.limsapp.in').replace(/\/+$/, '');

interface CreatePaymentLinkRequest {
  lab_id: string;
  invoice_id?: string;
  order_id?: string;
  patient_id?: string;
  amount: number;
  payer_name?: string;
  payer_phone?: string;
  payer_email?: string;
  expires_in_minutes?: number;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const body: CreatePaymentLinkRequest = await req.json();
    const {
      lab_id,
      invoice_id,
      order_id,
      patient_id,
      amount,
      payer_name,
      payer_phone,
      payer_email,
      expires_in_minutes,
    } = body;

    if (!lab_id || !amount) {
      return json({ error: 'Missing required fields: lab_id, amount' }, 400);
    }
    if (!invoice_id && !order_id) {
      return json({ error: 'Either invoice_id or order_id is required' }, 400);
    }
    if (amount <= 0) {
      return json({ error: 'Amount must be greater than 0' }, 400);
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { persistSession: false } }
    );

    // ---- Authorise the caller -------------------------------------------------
    const authHeader = req.headers.get('Authorization') ?? '';
    const jwt = authHeader.replace(/^Bearer\s+/i, '');
    if (!jwt) {
      return json({ error: 'Unauthorized' }, 401);
    }

    const { data: authData, error: authError } = await supabase.auth.getUser(jwt);
    if (authError || !authData?.user) {
      return json({ error: 'Unauthorized' }, 401);
    }

    const authUser = authData.user;
    const meta = (authUser.user_metadata ?? {}) as Record<string, unknown>;
    const metaRole = meta.role as string | undefined;
    const metaPatientId = meta.patient_id as string | undefined;

    let callerUserId: string | null = null;
    let isPatientCaller = false;

    if (metaRole === 'patient' && metaPatientId) {
      isPatientCaller = true;
    } else {
      const { data: staff } = await supabase
        .from('users')
        .select('id, lab_id')
        .eq('id', authUser.id)
        .maybeSingle();

      if (!staff || staff.lab_id !== lab_id) {
        return json({ error: 'Not authorized for this lab' }, 403);
      }
      callerUserId = staff.id;
    }

    // ---- Resolve the invoice --------------------------------------------------
    let invoiceQuery = supabase
      .from('invoices')
      .select('id, order_id, patient_id, patient_name, lab_id, total, total_after_discount, invoice_number, status')
      .eq('lab_id', lab_id);

    invoiceQuery = invoice_id
      ? invoiceQuery.eq('id', invoice_id)
      : invoiceQuery.eq('order_id', order_id!).order('created_at', { ascending: false });

    const { data: invoices, error: invoiceError } = await invoiceQuery.limit(1);
    const invoice = invoices?.[0];

    if (invoiceError || !invoice) {
      return json({ error: 'Invoice not found' }, 404);
    }

    // A patient-portal caller may only pay their own invoice.
    if (isPatientCaller && invoice.patient_id !== metaPatientId) {
      return json({ error: 'Not authorized for this invoice' }, 403);
    }

    // ---- Gateway must be configured AND opted in to patient payments ----------
    const { data: gateways } = await supabase
      .from('lab_payment_gateways')
      .select('id, provider, allow_patient_payments, payment_link_expiry_minutes, is_default')
      .eq('lab_id', lab_id)
      .eq('is_active', true)
      .eq('allow_patient_payments', true)
      .order('is_default', { ascending: false })
      .limit(1);

    const gateway = gateways?.[0];
    if (!gateway) {
      return json(
        { error: 'Online payments are not enabled for this lab. Enable a payment gateway in Settings > Payment Gateway.' },
        400
      );
    }

    // ---- Validate the amount against the live balance -------------------------
    const invoiceTotal = Number(invoice.total_after_discount || invoice.total || 0);

    const { data: existingPayments } = await supabase
      .from('payments')
      .select('amount')
      .eq('invoice_id', invoice.id);

    const paidSoFar = (existingPayments ?? []).reduce((sum, p) => sum + Number(p.amount || 0), 0);
    const balance = Math.round((invoiceTotal - paidSoFar) * 100) / 100;

    if (balance <= 0) {
      return json({ error: 'This invoice is already fully paid' }, 400);
    }
    // Allow a 1 paisa tolerance for float noise.
    if (amount > balance + 0.01) {
      return json({ error: `Amount exceeds the outstanding balance of ₹${balance.toFixed(2)}` }, 400);
    }

    // ---- Reuse a live link for the same invoice+amount instead of duplicating --
    const { data: existingLinks } = await supabase
      .from('payment_links')
      .select('*')
      .eq('invoice_id', invoice.id)
      .eq('status', 'active')
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1);

    const reusable = existingLinks?.find(
      (l) => Math.abs(Number(l.amount) - Number(amount)) < 0.01
    );

    if (reusable) {
      return json({
        success: true,
        reused: true,
        token: reusable.token,
        url: `${APP_BASE_URL}/pay/${reusable.token}`,
        amount: Number(reusable.amount),
        currency: reusable.currency,
        expires_at: reusable.expires_at,
        invoice_id: invoice.id,
        payer_phone: reusable.payer_phone,
      });
    }

    // ---- Mint the link --------------------------------------------------------
    const expiryMinutes = Math.min(
      43200,
      Math.max(5, expires_in_minutes || gateway.payment_link_expiry_minutes || 1440)
    );
    const expiresAt = new Date(Date.now() + expiryMinutes * 60_000).toISOString();

    // Fall back to the patient record for the WhatsApp target.
    const resolvedPatientId = patient_id || invoice.patient_id || null;
    let resolvedPhone = payer_phone ?? null;
    let resolvedName = payer_name ?? invoice.patient_name ?? null;
    let resolvedEmail = payer_email ?? null;

    if (resolvedPatientId && (!resolvedPhone || !resolvedName)) {
      const { data: patient } = await supabase
        .from('patients')
        .select('name, phone, email')
        .eq('id', resolvedPatientId)
        .maybeSingle();

      resolvedName = resolvedName || patient?.name || null;
      resolvedPhone = resolvedPhone || patient?.phone || null;
      resolvedEmail = resolvedEmail || patient?.email || null;
    }

    // token is UNIQUE; retry a couple of times on the (astronomically unlikely) clash.
    let inserted = null;
    let insertError = null;
    for (let attempt = 0; attempt < 3 && !inserted; attempt++) {
      const token = generateLinkToken();
      const { data, error } = await supabase
        .from('payment_links')
        .insert({
          lab_id,
          token,
          invoice_id: invoice.id,
          order_id: order_id || invoice.order_id || null,
          patient_id: resolvedPatientId,
          amount,
          currency: 'INR',
          payer_name: resolvedName,
          payer_phone: resolvedPhone,
          payer_email: resolvedEmail,
          status: 'active',
          expires_at: expiresAt,
          created_by: callerUserId,
        })
        .select()
        .single();

      inserted = data;
      insertError = error;
      if (error && error.code !== '23505') break;
    }

    if (!inserted) {
      console.error('[CREATE-PAYMENT-LINK] Insert failed:', insertError);
      return json({ error: 'Failed to create payment link' }, 500);
    }

    console.log('[CREATE-PAYMENT-LINK] Issued link', {
      link_id: inserted.id,
      invoice_id: invoice.id,
      amount,
    });

    return json({
      success: true,
      reused: false,
      token: inserted.token,
      url: `${APP_BASE_URL}/pay/${inserted.token}`,
      amount: Number(inserted.amount),
      currency: inserted.currency,
      expires_at: inserted.expires_at,
      invoice_id: invoice.id,
      invoice_number: invoice.invoice_number,
      payer_name: inserted.payer_name,
      payer_phone: inserted.payer_phone,
    });
  } catch (error) {
    console.error('[CREATE-PAYMENT-LINK] Error:', error);
    return json({ error: (error as Error).message || 'Internal server error' }, 500);
  }
});
