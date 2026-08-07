// Purpose: Handle payment gateway webhooks (server-to-server notifications)
// Routes:
//   POST /payment-webhook?provider=ccavenue  (CCAvenue webhook)
//   POST /payment-webhook?provider=razorpay  (Razorpay webhook)
//
// This is separate from payment-callback which handles browser redirects.
// Webhooks are more reliable as they don't depend on user's browser.

import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { crypto } from "https://deno.land/std@0.208.0/crypto/mod.ts";
import { decodeHex } from "https://deno.land/std@0.208.0/encoding/hex.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-razorpay-signature',
};

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const provider = url.searchParams.get('provider') || 'ccavenue';

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { auth: { persistSession: false } }
  );

  try {
    console.log('[PAYMENT-WEBHOOK] Received webhook:', { provider, method: req.method });

    if (provider === 'ccavenue') {
      return await handleCCAvenueWebhook(req, supabase);
    } else if (provider === 'razorpay') {
      return await handleRazorpayWebhook(req, supabase);
    } else {
      return new Response(
        JSON.stringify({ error: `Unsupported provider: ${provider}` }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
  } catch (error) {
    console.error('[PAYMENT-WEBHOOK] Error:', error);
    // Always return 200 to acknowledge receipt (prevent retries for processing errors)
    return new Response(
      JSON.stringify({ status: 'error', message: error.message }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

// Handle CCAvenue webhook notifications
async function handleCCAvenueWebhook(req: Request, supabase: ReturnType<typeof createClient>) {
  let encResponse: string | null = null;

  // CCAvenue may send as form data or JSON
  const contentType = req.headers.get('content-type') || '';

  if (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data')) {
    const formData = await req.formData();
    encResponse = formData.get('encResp') as string;
  } else if (contentType.includes('application/json')) {
    const json = await req.json();
    encResponse = json.encResp || json.enc_response;
  } else {
    // Try to parse as text (query string format)
    const text = await req.text();
    const params = new URLSearchParams(text);
    encResponse = params.get('encResp');
  }

  if (!encResponse) {
    console.error('[PAYMENT-WEBHOOK] No encrypted response found');
    return new Response(
      JSON.stringify({ status: 'error', message: 'Missing encrypted response' }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  // Get all active CCAvenue gateways to try decryption
  const { data: gateways } = await supabase
    .from('lab_payment_gateways')
    .select('id, lab_id, credentials_encrypted')
    .eq('provider', 'ccavenue')
    .eq('is_active', true);

  if (!gateways?.length) {
    console.error('[PAYMENT-WEBHOOK] No CCAvenue gateways configured');
    return new Response(
      JSON.stringify({ status: 'error', message: 'No gateway configured' }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  let decryptedResponse: Record<string, string> | null = null;
  let matchedGateway: typeof gateways[0] | null = null;

  // Try each gateway's possible working keys. CCAvenue may encrypt the
  // notification with either the webhook URL key or the transaction key.
  for (const gateway of gateways) {
    const credentials = gateway.credentials_encrypted as Record<string, string>;
    const workingKeys = [
      credentials?.webhook_working_key,
      credentials?.callback_working_key,
      credentials?.working_key,
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
      console.log('[PAYMENT-WEBHOOK] Successfully decrypted with gateway:', gateway.id);
      break;
    } catch (e) {
      continue;
    }
  }

    if (decryptedResponse && matchedGateway) break;
  }

  if (!decryptedResponse || !matchedGateway) {
    console.error('[PAYMENT-WEBHOOK] Failed to decrypt response');
    return new Response(
      JSON.stringify({ status: 'error', message: 'Decryption failed' }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  console.log('[PAYMENT-WEBHOOK] CCAvenue webhook data:', {
    order_id: decryptedResponse.order_id,
    order_status: decryptedResponse.order_status,
    tracking_id: decryptedResponse.tracking_id,
    event_type: decryptedResponse.event_type || 'payment'
  });

  const gatewayOrderId = decryptedResponse.order_id;
  const orderStatus = decryptedResponse.order_status;
  const trackingId = decryptedResponse.tracking_id;
  const eventType = decryptedResponse.event_type || 'payment'; // payment, refund, chargeback
  const amount = parseFloat(decryptedResponse.amount) || 0;

  // Find the payment attempt
  const { data: paymentAttempt, error: findError } = await supabase
    .from('b2b_payment_attempts')
    .select('*')
    .eq('gateway_order_id', gatewayOrderId)
    .single();

  if (findError || !paymentAttempt) {
    console.error('[PAYMENT-WEBHOOK] Payment attempt not found:', gatewayOrderId);
    return new Response(
      JSON.stringify({ status: 'error', message: 'Payment not found' }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  // The key-matching loop above walks every lab's CCAvenue gateway, so confirm
  // the key that decrypted this payload actually belongs to the paying lab.
  if (matchedGateway.lab_id !== paymentAttempt.lab_id) {
    console.error('[PAYMENT-WEBHOOK] Gateway/lab mismatch', {
      gateway_lab: matchedGateway.lab_id,
      attempt_lab: paymentAttempt.lab_id,
      order_id: gatewayOrderId
    });
    return new Response(
      JSON.stringify({ status: 'error', message: 'Gateway does not belong to this payment' }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  // Handle different event types
  if (eventType === 'refund') {
    await handleRefund(supabase, paymentAttempt, decryptedResponse);
  } else if (eventType === 'chargeback') {
    await handleChargeback(supabase, paymentAttempt, decryptedResponse);
  } else {
    // Regular payment notification
    await handlePaymentNotification(supabase, paymentAttempt, decryptedResponse, amount);
  }

  // Log the webhook
  await supabase.from('b2b_payment_attempts').update({
    webhook_received_at: new Date().toISOString(),
    webhook_verified: true,
    webhook_data: decryptedResponse,
    updated_at: new Date().toISOString()
  }).eq('id', paymentAttempt.id);

  return new Response(
    JSON.stringify({ status: 'ok', order_id: gatewayOrderId }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
}

// Handle payment status notification
async function handlePaymentNotification(
  supabase: ReturnType<typeof createClient>,
  paymentAttempt: Record<string, unknown>,
  response: Record<string, string>,
  amount: number
) {
  const orderStatus = response.order_status;
  const trackingId = response.tracking_id;

  // Determine status
  let status: string;
  let failureReason: string | null = null;

  if (orderStatus === 'Success') {
    status = 'success';
  } else if (orderStatus === 'Failure') {
    status = 'failed';
    failureReason = response.failure_message || response.status_message;
  } else if (orderStatus === 'Aborted') {
    status = 'cancelled';
    failureReason = 'Payment was cancelled';
  } else if (orderStatus === 'Timeout') {
    status = 'timeout';
    failureReason = 'Payment session timed out';
  } else {
    status = 'failed';
    failureReason = `Unknown status: ${orderStatus}`;
  }

  // Only update if status is different or not yet completed
  const currentStatus = paymentAttempt.status as string;
  if (currentStatus === 'success' && status === 'success') {
    console.log('[PAYMENT-WEBHOOK] Payment already marked as success, skipping');
    return;
  }

  // Update payment attempt
  await supabase
    .from('b2b_payment_attempts')
    .update({
      status,
      gateway_tracking_id: trackingId,
      failure_reason: failureReason,
      bank_ref_number: response.bank_ref_no,
      payment_method: response.payment_mode,
      card_type: response.card_name,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq('id', paymentAttempt.id);

  // If successful and not yet settled, settle it
  if (status === 'success' && !paymentAttempt.credit_applied) {
    await settleSuccessfulPayment(supabase, paymentAttempt, amount, 'ccavenue', trackingId);
  }

  // Mirror a terminal failure onto the patient's pay link so the counter screen
  // and the /pay page both stop showing "awaiting payment".
  if (paymentAttempt.payer_type === 'patient' && status !== 'success') {
    await supabase
      .from('payment_links')
      .update({ status: status === 'cancelled' ? 'active' : 'failed' })
      .eq('payment_attempt_id', paymentAttempt.id as string)
      .neq('status', 'paid');
  }
}

// Handle refund notification
async function handleRefund(
  supabase: ReturnType<typeof createClient>,
  paymentAttempt: Record<string, unknown>,
  response: Record<string, string>
) {
  const refundAmount = parseFloat(response.refund_amount || response.amount) || 0;
  const refundId = response.refund_ref_no || response.tracking_id;

  console.log('[PAYMENT-WEBHOOK] Processing refund:', {
    payment_id: paymentAttempt.id,
    refund_amount: refundAmount,
    refund_id: refundId
  });

  // Update payment status
  await supabase
    .from('b2b_payment_attempts')
    .update({
      status: 'refunded',
      refund_amount: refundAmount,
      refund_id: refundId,
      refunded_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq('id', paymentAttempt.id);

  // Debit the credit (reverse the payment)
  if (paymentAttempt.credit_applied) {
    const accountId = paymentAttempt.account_id as string;
    const labId = paymentAttempt.lab_id as string;

    await supabase.rpc('add_credit_ledger_entry', {
      p_lab_id: labId,
      p_account_id: accountId,
      p_entry_type: 'REFUND_DEBIT',
      p_amount: -refundAmount, // Negative to debit
      p_reference_type: 'payment_attempt',
      p_reference_id: paymentAttempt.id,
      p_remarks: `Refund processed. Refund ID: ${refundId}`,
      p_metadata: {
        refund_id: refundId,
        original_payment_id: paymentAttempt.id,
        provider: 'ccavenue'
      }
    });

    console.log('[PAYMENT-WEBHOOK] Credit debited for refund:', { accountId, refundAmount });
  }
}

// Handle chargeback notification
async function handleChargeback(
  supabase: ReturnType<typeof createClient>,
  paymentAttempt: Record<string, unknown>,
  response: Record<string, string>
) {
  const chargebackAmount = parseFloat(response.chargeback_amount || response.amount) || 0;
  const chargebackId = response.chargeback_ref_no || response.tracking_id;

  console.log('[PAYMENT-WEBHOOK] Processing chargeback:', {
    payment_id: paymentAttempt.id,
    chargeback_amount: chargebackAmount,
    chargeback_id: chargebackId
  });

  // Update payment status
  await supabase
    .from('b2b_payment_attempts')
    .update({
      status: 'disputed',
      chargeback_amount: chargebackAmount,
      chargeback_id: chargebackId,
      disputed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq('id', paymentAttempt.id);

  // Debit the credit (reverse the payment)
  if (paymentAttempt.credit_applied) {
    const accountId = paymentAttempt.account_id as string;
    const labId = paymentAttempt.lab_id as string;

    await supabase.rpc('add_credit_ledger_entry', {
      p_lab_id: labId,
      p_account_id: accountId,
      p_entry_type: 'REFUND_DEBIT', // Using same type for chargeback
      p_amount: -chargebackAmount,
      p_reference_type: 'payment_attempt',
      p_reference_id: paymentAttempt.id,
      p_remarks: `Chargeback processed. Chargeback ID: ${chargebackId}`,
      p_metadata: {
        chargeback_id: chargebackId,
        original_payment_id: paymentAttempt.id,
        provider: 'ccavenue',
        is_chargeback: true
      }
    });

    console.log('[PAYMENT-WEBHOOK] Credit debited for chargeback:', { accountId, chargebackAmount });
  }
}

// Handle Razorpay webhook (same as in payment-callback, but for completeness)
async function handleRazorpayWebhook(req: Request, supabase: ReturnType<typeof createClient>) {
  const signature = req.headers.get('x-razorpay-signature');
  const body = await req.text();

  if (!signature) {
    return new Response(
      JSON.stringify({ status: 'error', message: 'Missing signature' }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const event = JSON.parse(body);
  console.log('[PAYMENT-WEBHOOK] Razorpay event:', event.event);

  // Handle different event types
  const eventType = event.event;
  const payment = event.payload?.payment?.entity;
  const refund = event.payload?.refund?.entity;

  if (!payment && !refund) {
    return new Response(
      JSON.stringify({ status: 'ignored', message: 'No payment/refund entity' }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const orderId = payment?.order_id || refund?.payment_id;

  // Find payment attempt
  const { data: paymentAttempt } = await supabase
    .from('b2b_payment_attempts')
    .select('*, lab_payment_gateways!gateway_id(credentials_encrypted)')
    .or(`gateway_order_id.eq.${orderId},gateway_payment_id.eq.${orderId}`)
    .single();

  if (!paymentAttempt) {
    console.error('[PAYMENT-WEBHOOK] Payment attempt not found:', orderId);
    return new Response(
      JSON.stringify({ status: 'error', message: 'Payment not found' }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  // Verify signature
  const webhookSecret = paymentAttempt.lab_payment_gateways?.credentials_encrypted?.webhook_secret;
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
      console.error('[PAYMENT-WEBHOOK] Invalid Razorpay signature');
      return new Response(
        JSON.stringify({ status: 'error', message: 'Invalid signature' }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
  }

  // Handle based on event type
  if (eventType === 'payment.captured') {
    const amount = payment.amount / 100;
    await supabase.from('b2b_payment_attempts').update({
      status: 'success',
      gateway_payment_id: payment.id,
      payment_method: payment.method,
      completed_at: new Date().toISOString(),
      webhook_received_at: new Date().toISOString(),
      webhook_verified: true,
      updated_at: new Date().toISOString()
    }).eq('id', paymentAttempt.id);

    if (!paymentAttempt.credit_applied) {
      await settleSuccessfulPayment(supabase, paymentAttempt, amount, 'razorpay', payment.id);
    }
  } else if (eventType === 'payment.failed') {
    await supabase.from('b2b_payment_attempts').update({
      status: 'failed',
      failure_reason: payment.error_description,
      webhook_received_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }).eq('id', paymentAttempt.id);
  } else if (eventType === 'refund.created' || eventType === 'refund.processed') {
    const refundAmount = refund.amount / 100;
    await supabase.from('b2b_payment_attempts').update({
      status: 'refunded',
      refund_amount: refundAmount,
      refund_id: refund.id,
      refunded_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }).eq('id', paymentAttempt.id);

    // Debit credit for refund
    if (paymentAttempt.credit_applied) {
      await supabase.rpc('add_credit_ledger_entry', {
        p_lab_id: paymentAttempt.lab_id,
        p_account_id: paymentAttempt.account_id,
        p_entry_type: 'REFUND_DEBIT',
        p_amount: -refundAmount,
        p_reference_type: 'payment_attempt',
        p_reference_id: paymentAttempt.id,
        p_remarks: `Razorpay refund. Refund ID: ${refund.id}`,
        p_metadata: { refund_id: refund.id, provider: 'razorpay' }
      });
    }
  }

  return new Response(
    JSON.stringify({ status: 'ok' }),
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
      console.error('[PAYMENT-WEBHOOK] Failed to settle patient payment:', error);
      return;
    }

    console.log('[PAYMENT-WEBHOOK] Patient payment settled:', {
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
  // Check idempotency
  if (paymentAttempt.credit_applied) {
    console.log('[PAYMENT-WEBHOOK] Credit already applied:', paymentAttempt.id);
    await releasePendingB2BBooking(supabase, paymentAttempt);
    return;
  }

  const accountId = paymentAttempt.account_id as string;
  const labId = paymentAttempt.lab_id as string;

  // Atomic lock check
  const { data: lockCheck } = await supabase
    .from('b2b_payment_attempts')
    .update({ credit_applied: true, credit_applied_at: new Date().toISOString() })
    .eq('id', paymentAttempt.id)
    .eq('credit_applied', false)
    .select();

  if (!lockCheck?.length) {
    console.log('[PAYMENT-WEBHOOK] Credit already being applied');
    await releasePendingB2BBooking(supabase, paymentAttempt);
    return;
  }

  // Add credit ledger entry
  const { error: ledgerError } = await supabase.rpc('add_credit_ledger_entry', {
    p_lab_id: labId,
    p_account_id: accountId,
    p_entry_type: 'PAYMENT_CREDIT',
    p_amount: amount,
    p_reference_type: 'payment_attempt',
    p_reference_id: paymentAttempt.id,
    p_remarks: `Payment via ${provider} (webhook). Transaction: ${transactionId}`,
    p_metadata: {
      provider,
      transaction_id: transactionId,
      payment_attempt_id: paymentAttempt.id,
      source: 'webhook'
    }
  });

  if (ledgerError) {
    console.error('[PAYMENT-WEBHOOK] Failed to add ledger entry:', ledgerError);
    // Rollback lock
    await supabase
      .from('b2b_payment_attempts')
      .update({ credit_applied: false, credit_applied_at: null })
      .eq('id', paymentAttempt.id);
    return;
  }

  await releasePendingB2BBooking(supabase, paymentAttempt);

  console.log('[PAYMENT-WEBHOOK] Credit applied successfully:', { accountId, amount });
}

async function releasePendingB2BBooking(
  supabase: ReturnType<typeof createClient>,
  paymentAttempt: Record<string, unknown>
) {
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
      console.error('[PAYMENT-WEBHOOK] Failed to create booking after payment:', bookingError);
      return;
    }
  }

  await supabase
    .from('b2b_pending_orders')
    .update({ status: 'order_created', updated_at: new Date().toISOString() })
    .eq('id', pendingPaymentOrder.id);
}
