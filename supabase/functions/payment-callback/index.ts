// Purpose: Handle payment gateway callbacks (CCAvenue redirect, Razorpay webhook)
// Routes:
//   POST /payment-callback?provider=ccavenue  (redirect from CCAvenue)
//   POST /payment-callback?provider=razorpay  (webhook from Razorpay)
//   POST /payment-callback/verify             (client-side verification for Razorpay)

import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { crypto } from "https://deno.land/std@0.208.0/crypto/mod.ts";
import { decodeHex } from "https://deno.land/std@0.208.0/encoding/hex.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-razorpay-signature',
};

const appBaseUrl = (Deno.env.get('PAYMENT_APP_BASE_URL') || 'https://app.limsapp.in').replace(/\/$/, '');

// CCAvenue decryption helper
async function decryptCCAvenue(encryptedText: string, workingKey: string): Promise<string> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  // Generate MD5 hash of working key
  const keyData = encoder.encode(workingKey);
  const hashBuffer = await crypto.subtle.digest('MD5', keyData);
  const key = new Uint8Array(hashBuffer);

  // CCAvenue's integration kits use a fixed IV: 00 01 02 ... 0f.
  const iv = new Uint8Array(16);
  for (let i = 0; i < iv.length; i++) iv[i] = i;

  // Import the key
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'AES-CBC' },
    false,
    ['decrypt']
  );

  // Decode hex to bytes
  const encryptedBytes = decodeHex(encryptedText);

  // Decrypt
  const decryptedBuffer = await crypto.subtle.decrypt(
    { name: 'AES-CBC', iv },
    cryptoKey,
    encryptedBytes
  );

  // Remove PKCS7 padding
  const decrypted = new Uint8Array(decryptedBuffer);
  const paddingLength = decrypted[decrypted.length - 1];
  const unpaddedLength = decrypted.length - paddingLength;

  return decoder.decode(decrypted.slice(0, unpaddedLength));
}

// Parse CCAvenue response string to object
function parseCCAvenueResponse(responseString: string): Record<string, string> {
  const result: Record<string, string> = {};
  const pairs = responseString.split('&');
  for (const pair of pairs) {
    const [key, value] = pair.split('=');
    if (key) {
      result[key] = decodeURIComponent(value || '');
    }
  }
  return result;
}

// Verify Razorpay signature
async function verifyRazorpaySignature(
  orderId: string,
  paymentId: string,
  signature: string,
  secret: string
): Promise<boolean> {
  const encoder = new TextEncoder();
  const data = `${orderId}|${paymentId}`;

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  const computedSignature = Array.from(new Uint8Array(signatureBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  return computedSignature === signature;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const provider = url.searchParams.get('provider') || 'ccavenue';
  const isVerifyEndpoint = url.pathname.endsWith('/verify');

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { auth: { persistSession: false } }
  );

  try {
    console.log('[PAYMENT-CALLBACK] Received callback:', { provider, isVerifyEndpoint });

    if (provider === 'ccavenue') {
      return await handleCCAvenueCallback(req, supabase);
    } else if (provider === 'razorpay') {
      if (isVerifyEndpoint) {
        return await handleRazorpayVerify(req, supabase);
      }
      return await handleRazorpayWebhook(req, supabase);
    } else {
      return new Response(
        JSON.stringify({ error: `Unsupported provider: ${provider}` }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
  } catch (error) {
    console.error('[PAYMENT-CALLBACK] Error:', error);
    return new Response(
      JSON.stringify({ error: error.message || 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

// Handle CCAvenue redirect callback
async function handleCCAvenueCallback(req: Request, supabase: ReturnType<typeof createClient>) {
  // CCAvenue sends form data
  const formData = await req.formData();
  const encResponse = formData.get('encResp') as string;

  if (!encResponse) {
    return new Response(
      JSON.stringify({ error: 'Missing encrypted response' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  // Get the order_id from the encrypted response to find the gateway
  // We need to find the payment attempt first to get the working key
  // For now, we'll try to match based on merchant_param1 (our payment_id)

  // First, let's try to find the payment attempt
  // CCAvenue also sends order_id in the encrypted response, but we need to decrypt first
  // We'll need to try each active gateway's key - not ideal but necessary

  const { data: gateways } = await supabase
    .from('lab_payment_gateways')
    .select('id, lab_id, credentials_encrypted')
    .eq('provider', 'ccavenue')
    .eq('is_active', true);

  if (!gateways?.length) {
    return new Response(
      JSON.stringify({ error: 'No CCAvenue gateway configured' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  let decryptedResponse: Record<string, string> | null = null;
  let matchedGateway: typeof gateways[0] | null = null;

  // Try each gateway's possible working keys. CCAvenue may encrypt the
  // response with either the response URL key or the transaction key.
  for (const gateway of gateways) {
    const credentials = gateway.credentials_encrypted as Record<string, string>;
    const workingKeys = [
      credentials?.callback_working_key,
      credentials?.working_key,
      credentials?.webhook_working_key,
      credentials?.cancel_working_key,
    ].filter((key, index, keys): key is string =>
      Boolean(key) && keys.indexOf(key) === index
    );

    for (const workingKey of workingKeys) {
      if (!workingKey) continue;

      try {
      const decryptedString = await decryptCCAvenue(encResponse, workingKey);
      decryptedResponse = parseCCAvenueResponse(decryptedString);
      matchedGateway = gateway;
      break;
    } catch (e) {
        console.log('[PAYMENT-CALLBACK] Decryption failed for gateway/key:', gateway.id);
      continue;
    }
  }

    if (decryptedResponse && matchedGateway) break;
  }

  if (!decryptedResponse || !matchedGateway) {
    console.error('[PAYMENT-CALLBACK] Failed to decrypt CCAvenue response');
    return new Response(
      JSON.stringify({ error: 'Failed to decrypt payment response' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  console.log('[PAYMENT-CALLBACK] CCAvenue response:', {
    order_id: decryptedResponse.order_id,
    order_status: decryptedResponse.order_status,
    tracking_id: decryptedResponse.tracking_id
  });

  // Extract key fields
  const gatewayOrderId = decryptedResponse.order_id;
  const orderStatus = decryptedResponse.order_status;
  const trackingId = decryptedResponse.tracking_id;
  const paymentAttemptId = decryptedResponse.merchant_param1;
  const amount = parseFloat(decryptedResponse.amount) || 0;

  // Find the payment attempt
  const { data: paymentAttempt, error: findError } = await supabase
    .from('b2b_payment_attempts')
    .select('*')
    .eq('gateway_order_id', gatewayOrderId)
    .single();

  if (findError || !paymentAttempt) {
    console.error('[PAYMENT-CALLBACK] Payment attempt not found:', gatewayOrderId);
    return new Response(
      JSON.stringify({ error: 'Payment attempt not found' }),
      { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  // The key-matching loop above walks every lab's CCAvenue gateway, so confirm
  // the key that decrypted this response actually belongs to the paying lab.
  if (matchedGateway.lab_id !== paymentAttempt.lab_id) {
    console.error('[PAYMENT-CALLBACK] Gateway/lab mismatch', {
      gateway_lab: matchedGateway.lab_id,
      attempt_lab: paymentAttempt.lab_id,
      order_id: gatewayOrderId
    });
    return new Response(
      JSON.stringify({ error: 'Gateway does not belong to this payment' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  // Determine status
  let status: string;
  let failureReason: string | null = null;

  if (orderStatus === 'Success') {
    status = 'success';
  } else if (orderStatus === 'Failure') {
    status = 'failed';
    failureReason = decryptedResponse.failure_message || decryptedResponse.status_message;
  } else if (orderStatus === 'Aborted') {
    status = 'cancelled';
    failureReason = 'Payment was cancelled by user';
  } else {
    status = 'failed';
    failureReason = `Unknown status: ${orderStatus}`;
  }

  // Update payment attempt
  const { error: updateError } = await supabase
    .from('b2b_payment_attempts')
    .update({
      status,
      gateway_tracking_id: trackingId,
      failure_reason: failureReason,
      bank_ref_number: decryptedResponse.bank_ref_no,
      payment_method: decryptedResponse.payment_mode,
      card_type: decryptedResponse.card_name,
      raw_response: decryptedResponse,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq('id', paymentAttempt.id);

  if (updateError) {
    console.error('[PAYMENT-CALLBACK] Failed to update payment attempt:', updateError);
  }

  // If successful, settle it (credit ledger for B2B, payments row for patients)
  if (status === 'success') {
    await settleSuccessfulPayment(supabase, paymentAttempt, amount, 'ccavenue', trackingId);
  }

  // Patient payments came from a /pay/:token link; send the browser back there.
  const linkToken = decryptedResponse.merchant_param4 || '';
  const isPatientPayment = paymentAttempt.payer_type === 'patient';

  if (isPatientPayment && status !== 'success' && linkToken) {
    await supabase
      .from('payment_links')
      .update({ status: status === 'cancelled' ? 'active' : 'failed' })
      .eq('token', linkToken)
      .neq('status', 'paid');
  }

  // Return redirect URL or JSON response
  const successBase = isPatientPayment && linkToken
    ? `${appBaseUrl}/pay/${linkToken}/success`
    : `${appBaseUrl}/b2b/payment/success`;
  const failureBase = isPatientPayment && linkToken
    ? `${appBaseUrl}/pay/${linkToken}/failed`
    : `${appBaseUrl}/b2b/payment/failed`;

  const redirectUrl = status === 'success'
    ? `${successBase}?payment_id=${paymentAttempt.id}`
    : `${failureBase}?payment_id=${paymentAttempt.id}&reason=${encodeURIComponent(failureReason || 'Payment failed')}`;

  // For browser redirect, return HTML
  return new Response(
    `<!DOCTYPE html>
    <html>
    <head><meta http-equiv="refresh" content="0;url=${redirectUrl}"></head>
    <body>Redirecting...</body>
    </html>`,
    {
      status: 200,
      headers: { 'Content-Type': 'text/html' }
    }
  );
}

// Handle Razorpay webhook
async function handleRazorpayWebhook(req: Request, supabase: ReturnType<typeof createClient>) {
  const signature = req.headers.get('x-razorpay-signature');
  const body = await req.text();

  if (!signature) {
    return new Response(
      JSON.stringify({ error: 'Missing signature' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const event = JSON.parse(body);
  console.log('[PAYMENT-CALLBACK] Razorpay webhook event:', event.event);

  if (event.event !== 'payment.captured' && event.event !== 'payment.failed') {
    return new Response(
      JSON.stringify({ status: 'ignored' }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const payment = event.payload.payment.entity;
  const orderId = payment.order_id;
  const paymentId = payment.id;

  // Find the payment attempt
  const { data: paymentAttempt } = await supabase
    .from('b2b_payment_attempts')
    .select('*, lab_payment_gateways!gateway_id(credentials_encrypted)')
    .or(`gateway_order_id.eq.${orderId},raw_request->razorpay_order_id.eq.${orderId}`)
    .single();

  if (!paymentAttempt) {
    console.error('[PAYMENT-CALLBACK] Payment attempt not found for Razorpay order:', orderId);
    return new Response(
      JSON.stringify({ error: 'Payment attempt not found' }),
      { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  // Verify signature
  const gateway = paymentAttempt.lab_payment_gateways;
  const webhookSecret = gateway?.credentials_encrypted?.webhook_secret;

  if (webhookSecret) {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(webhookSecret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
    const computedSignature = Array.from(new Uint8Array(signatureBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    if (computedSignature !== signature) {
      console.error('[PAYMENT-CALLBACK] Invalid Razorpay signature');
      return new Response(
        JSON.stringify({ error: 'Invalid signature' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
  }

  const status = event.event === 'payment.captured' ? 'success' : 'failed';
  const amount = payment.amount / 100; // Convert from paise

  // Update payment attempt
  await supabase
    .from('b2b_payment_attempts')
    .update({
      status,
      gateway_payment_id: paymentId,
      payment_method: payment.method,
      failure_reason: status === 'failed' ? payment.error_description : null,
      raw_response: event,
      webhook_received_at: new Date().toISOString(),
      webhook_verified: true,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq('id', paymentAttempt.id);

  // Settle if successful
  if (status === 'success') {
    await settleSuccessfulPayment(supabase, paymentAttempt, amount, 'razorpay', paymentId);
  }

  return new Response(
    JSON.stringify({ status: 'ok' }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
}

// Handle Razorpay client-side verification
async function handleRazorpayVerify(req: Request, supabase: ReturnType<typeof createClient>) {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, payment_id } = await req.json();

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !payment_id) {
    return new Response(
      JSON.stringify({ error: 'Missing required fields' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  // Find the payment attempt
  const { data: paymentAttempt } = await supabase
    .from('b2b_payment_attempts')
    .select('*, lab_payment_gateways!gateway_id(credentials_encrypted)')
    .eq('id', payment_id)
    .single();

  if (!paymentAttempt) {
    return new Response(
      JSON.stringify({ error: 'Payment attempt not found' }),
      { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const gateway = paymentAttempt.lab_payment_gateways;
  const keySecret = gateway?.credentials_encrypted?.key_secret;

  if (!keySecret) {
    return new Response(
      JSON.stringify({ error: 'Gateway configuration error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  // Verify signature
  const isValid = await verifyRazorpaySignature(
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
    keySecret
  );

  if (!isValid) {
    await supabase
      .from('b2b_payment_attempts')
      .update({
        status: 'failed',
        failure_reason: 'Signature verification failed',
        updated_at: new Date().toISOString()
      })
      .eq('id', payment_id);

    return new Response(
      JSON.stringify({ success: false, error: 'Invalid signature' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  // Update and apply credit
  const amount = Number(paymentAttempt.amount);

  await supabase
    .from('b2b_payment_attempts')
    .update({
      status: 'success',
      gateway_payment_id: razorpay_payment_id,
      gateway_signature: razorpay_signature,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq('id', payment_id);

  // Re-read so the settlement sees the freshly written success status.
  const { data: settledAttempt } = await supabase
    .from('b2b_payment_attempts')
    .select('*')
    .eq('id', payment_id)
    .single();

  await settleSuccessfulPayment(
    supabase,
    settledAttempt ?? paymentAttempt,
    amount,
    'razorpay',
    razorpay_payment_id
  );

  return new Response(
    JSON.stringify({ success: true, payment_id }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
}

// Route a successful payment to the right settlement path.
// B2B account payments become credit-ledger entries; patient payments become a
// real `payments` row against the invoice (see settle_patient_payment()).
async function settleSuccessfulPayment(
  supabase: ReturnType<typeof createClient>,
  paymentAttempt: Record<string, unknown>,
  amount: number,
  provider: string,
  transactionId: string
) {
  if (paymentAttempt.payer_type === 'patient') {
    const { data, error } = await supabase.rpc('settle_patient_payment', {
      p_attempt_id: paymentAttempt.id
    });

    if (error) {
      console.error('[PAYMENT-CALLBACK] Failed to settle patient payment:', error);
      return;
    }

    console.log('[PAYMENT-CALLBACK] Patient payment settled:', {
      payment_attempt_id: paymentAttempt.id,
      payments_row: data,
      provider,
      transactionId
    });
    return;
  }

  await applyPaymentCredit(supabase, paymentAttempt, amount, provider, transactionId);
}

// Apply payment credit to account
async function applyPaymentCredit(
  supabase: ReturnType<typeof createClient>,
  paymentAttempt: Record<string, unknown>,
  amount: number,
  provider: string,
  transactionId: string
) {
  // Check idempotency - prevent double crediting
  if (paymentAttempt.credit_applied) {
    console.log('[PAYMENT-CALLBACK] Credit already applied for:', paymentAttempt.id);
    await releasePendingB2BBooking(supabase, paymentAttempt);
    return;
  }

  const accountId = paymentAttempt.account_id as string;
  const labId = paymentAttempt.lab_id as string;

  console.log('[PAYMENT-CALLBACK] Applying credit:', { accountId, amount, provider });

  // Start a transaction-like operation
  // 1. Mark credit as being applied (lock)
  const { data: lockCheck } = await supabase
    .from('b2b_payment_attempts')
    .update({ credit_applied: true, credit_applied_at: new Date().toISOString() })
    .eq('id', paymentAttempt.id)
    .eq('credit_applied', false) // Only if not already applied
    .select();

  if (!lockCheck?.length) {
    console.log('[PAYMENT-CALLBACK] Credit already being applied or applied');
    return;
  }

  // 2. Add credit ledger entry
  const { error: ledgerError } = await supabase.rpc('add_credit_ledger_entry', {
    p_lab_id: labId,
    p_account_id: accountId,
    p_entry_type: 'PAYMENT_CREDIT',
    p_amount: amount,
    p_reference_type: 'payment_attempt',
    p_reference_id: paymentAttempt.id,
    p_remarks: `Payment via ${provider}. Transaction: ${transactionId}`,
    p_metadata: {
      provider,
      transaction_id: transactionId,
      payment_attempt_id: paymentAttempt.id
    }
  });

  if (ledgerError) {
    console.error('[PAYMENT-CALLBACK] Failed to add ledger entry:', ledgerError);
    // Rollback the lock
    await supabase
      .from('b2b_payment_attempts')
      .update({ credit_applied: false, credit_applied_at: null })
      .eq('id', paymentAttempt.id);
    return;
  }

  // 3. Check if there's a pending order/booking to release
  await releasePendingB2BBooking(supabase, paymentAttempt);

  console.log('[PAYMENT-CALLBACK] Credit applied successfully:', {
    account_id: accountId,
    amount,
    payment_attempt_id: paymentAttempt.id
  });
}

async function releasePendingB2BBooking(
  supabase: ReturnType<typeof createClient>,
  paymentAttempt: Record<string, unknown>
) {
  if (paymentAttempt.pending_order_id) {
    const { data: pendingOrder } = await supabase
      .from('b2b_pending_orders')
      .select('*')
      .eq('payment_attempt_id', paymentAttempt.id)
      .eq('status', 'pending_payment')
      .single();

    if (pendingOrder) {
      // Update pending order status
      await supabase
        .from('b2b_pending_orders')
        .update({ status: 'payment_received', updated_at: new Date().toISOString() })
        .eq('id', pendingOrder.id);

      // TODO: Trigger order creation from pending_order.order_data
      console.log('[PAYMENT-CALLBACK] Pending order ready for creation:', pendingOrder.id);
    }
  }

  const { data: pendingPaymentOrder } = await supabase
    .from('b2b_pending_orders')
    .select('*')
    .eq('payment_attempt_id', paymentAttempt.id)
    .eq('status', 'pending_payment')
    .maybeSingle();

  if (!pendingPaymentOrder) return;

  const orderData = pendingPaymentOrder.order_data as Record<string, unknown> | null;
  if (!orderData?.patient_info || !Array.isArray(orderData.test_details)) {
    await supabase
      .from('b2b_pending_orders')
      .update({ status: 'payment_received', updated_at: new Date().toISOString() })
      .eq('id', pendingPaymentOrder.id);
    return;
  }

  const { data: existingBooking } = await supabase
    .from('bookings')
    .select('id')
    .eq('account_id', paymentAttempt.account_id)
    .eq('lab_id', paymentAttempt.lab_id)
    .contains('patient_info', orderData.patient_info as Record<string, unknown>)
    .limit(1)
    .maybeSingle();

  if (!existingBooking) {
    const orderAmount = Number(orderData.order_amount || pendingPaymentOrder.order_amount || 0);
    const paidAmount = Number(paymentAttempt.amount || 0);
    const remainingCreditAmount = Math.max(0, orderAmount - paidAmount);

    const { error: bookingError } = await supabase.from('bookings').insert({
      lab_id: paymentAttempt.lab_id,
      account_id: paymentAttempt.account_id,
      b2b_client_id: paymentAttempt.account_id,
      status: 'pending',
      booking_source: 'b2b_portal',
      patient_info: orderData.patient_info,
      test_details: orderData.test_details,
      scheduled_at: orderData.scheduled_at || null,
      quotation_amount: remainingCreditAmount,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    if (bookingError) {
      console.error('[PAYMENT-CALLBACK] Failed to create booking after payment:', bookingError);
      return;
    }
  }

  await supabase
    .from('b2b_pending_orders')
    .update({ status: 'order_created', updated_at: new Date().toISOString() })
    .eq('id', pendingPaymentOrder.id);
}
