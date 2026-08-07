// Purpose: Initialize payment with payment gateway (CCAvenue, Razorpay)
// Route: POST /initiate-payment
// Body:
// {
//   "account_id": "uuid",
//   "lab_id": "uuid",
//   "amount": 10000,
//   "purpose": "credit_topup" | "order_payment" | "shortfall_payment",
//   "pending_order_id": "uuid" (optional),
//   "order_data": {} (optional - for pending orders),
//   "provider": "ccavenue" | "razorpay" (optional, uses default),
//   "return_url": "https://...",
//   "cancel_url": "https://..."
// }

import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import {
  corsHeaders,
  generateOrderId,
  handleCCAvenue,
  handleRazorpay,
} from "../_shared/paymentProviders.ts";

interface InitiatePaymentRequest {
  account_id: string;
  lab_id: string;
  amount: number;
  purpose: 'credit_topup' | 'order_payment' | 'shortfall_payment' | 'advance_payment';
  pending_order_id?: string;
  order_data?: Record<string, unknown>;
  provider?: string;
  return_url?: string;
  cancel_url?: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const body: InitiatePaymentRequest = await req.json();
    const {
      account_id,
      lab_id,
      amount,
      purpose = 'credit_topup',
      pending_order_id,
      order_data,
      provider: requestedProvider,
      return_url,
      cancel_url
    } = body;

    // Validate required fields
    if (!account_id || !lab_id || !amount) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: account_id, lab_id, amount' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (amount <= 0) {
      return new Response(
        JSON.stringify({ error: 'Amount must be greater than 0' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { persistSession: false } }
    );

    console.log('[INITIATE-PAYMENT] Starting payment:', { account_id, lab_id, amount, purpose });

    // Get account details
    const { data: account, error: accountError } = await supabase
      .from('accounts')
      .select('id, name, billing_email, billing_phone')
      .eq('id', account_id)
      .eq('lab_id', lab_id)
      .single();

    if (accountError || !account) {
      return new Response(
        JSON.stringify({ error: 'Account not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Get payment gateway configuration
    let gatewayQuery = supabase
      .from('lab_payment_gateways')
      .select('*')
      .eq('lab_id', lab_id)
      .eq('is_active', true);

    if (requestedProvider) {
      gatewayQuery = gatewayQuery.eq('provider', requestedProvider);
    } else {
      gatewayQuery = gatewayQuery.eq('is_default', true);
    }

    const { data: gateways, error: gatewayError } = await gatewayQuery.limit(1);

    let resolvedGateways = gateways ?? [];

    if (gatewayError || !resolvedGateways.length) {
      // Try to get any active gateway if no default
      const { data: anyGateway } = await supabase
        .from('lab_payment_gateways')
        .select('*')
        .eq('lab_id', lab_id)
        .eq('is_active', true)
        .limit(1);

      if (!anyGateway?.length) {
        return new Response(
          JSON.stringify({ error: 'No active payment gateway configured for this lab' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      resolvedGateways = anyGateway;
    }

    const gateway = resolvedGateways[0];
    const provider = gateway.provider;
    const credentials = gateway.credentials_encrypted || {};
    const gatewayOrderId = generateOrderId(provider.toUpperCase().substring(0, 3));

    console.log('[INITIATE-PAYMENT] Using gateway:', { provider, gateway_id: gateway.id });

    // Create payment attempt record
    const { data: paymentAttempt, error: attemptError } = await supabase
      .from('b2b_payment_attempts')
      .insert({
        lab_id,
        account_id,
        pending_order_id,
        gateway_id: gateway.id,
        provider,
        gateway_order_id: gatewayOrderId,
        amount,
        currency: gateway.default_currency || 'INR',
        payment_purpose: purpose,
        status: 'initiated',
        idempotency_key: `${account_id}-${Date.now()}`,
        raw_request: body
      })
      .select()
      .single();

    if (attemptError) {
      console.error('[INITIATE-PAYMENT] Failed to create payment attempt:', attemptError);
      throw new Error('Failed to create payment record');
    }

    // If there is B2B booking/order data, preserve it across redirect-based gateways.
    if (order_data && (purpose === 'order_payment' || purpose === 'shortfall_payment')) {
      const { error: pendingError } = await supabase
        .from('b2b_pending_orders')
        .insert({
          lab_id,
          account_id,
          order_data,
          order_amount: order_data.order_amount || amount,
          available_credit: Math.max(0, Number(order_data.order_amount || amount) - amount),
          shortfall_amount: amount,
          payment_attempt_id: paymentAttempt.id,
          status: 'pending_payment'
        });

      if (pendingError) {
        console.warn('[INITIATE-PAYMENT] Failed to create pending order:', pendingError);
      }
    }

    let responseData: Record<string, unknown>;

    const payer = {
      name: account.name || 'B2B Client',
      email: account.billing_email,
      phone: account.billing_phone,
    };

    // Handle different payment providers
    if (provider === 'ccavenue') {
      responseData = await handleCCAvenue(
        gateway,
        credentials,
        paymentAttempt,
        payer,
        amount,
        return_url || gateway.redirect_url,
        cancel_url || gateway.cancel_url
      );
    } else if (provider === 'razorpay') {
      responseData = await handleRazorpay(
        gateway,
        credentials,
        paymentAttempt,
        payer,
        amount
      );
    } else {
      return new Response(
        JSON.stringify({ error: `Unsupported payment provider: ${provider}` }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Update payment attempt with request details
    await supabase
      .from('b2b_payment_attempts')
      .update({
        status: 'pending',
        raw_request: { ...body, gateway_response: responseData }
      })
      .eq('id', paymentAttempt.id);

    console.log('[INITIATE-PAYMENT] Payment initiated successfully:', {
      payment_id: paymentAttempt.id,
      gateway_order_id: gatewayOrderId
    });

    return new Response(
      JSON.stringify({
        success: true,
        payment_id: paymentAttempt.id,
        gateway_order_id: gatewayOrderId,
        provider,
        ...responseData
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[INITIATE-PAYMENT] Error:', error);
    return new Response(
      JSON.stringify({ error: (error as Error).message || 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
