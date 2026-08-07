// Purpose: Check B2B account credit availability before order placement
// Route: POST /check-b2b-credit
// Body:
// {
//   "account_id": "uuid",
//   "order_amount": 10000,
//   "lab_id": "uuid"
// }
// Response:
// {
//   "can_proceed": true/false,
//   "credit_limit": 50000,
//   "credit_used": 20000,
//   "available_credit": 30000,
//   "order_amount": 10000,
//   "shortfall": 0,
//   "payment_required": false
// }

import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface CreditCheckRequest {
  account_id: string;
  order_amount: number;
  lab_id: string;
}

interface CreditCheckResponse {
  can_proceed: boolean;
  credit_limit: number;
  credit_used: number;
  outstanding_invoice_amount: number;
  open_order_amount: number;
  pending_booking_amount: number;
  payment_credit_amount: number;
  effective_credit_used: number;
  available_credit: number;
  order_amount: number;
  shortfall: number;
  payment_required: boolean;
  payment_gateway_enabled: boolean;
  minimum_payment: number;
  suggested_payments: {
    label: string;
    amount: number;
    description: string;
  }[];
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { account_id, order_amount, lab_id }: CreditCheckRequest = await req.json();

    if (!account_id || order_amount === undefined || !lab_id) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: account_id, order_amount, lab_id' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (order_amount < 0) {
      return new Response(
        JSON.stringify({ error: 'order_amount must be non-negative' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { persistSession: false } }
    );

    console.log('[CHECK-B2B-CREDIT] Checking credit for account:', account_id);

    // Get account credit details
    const { data: account, error: accountError } = await supabase
      .from('accounts')
      .select('id, name, credit_limit, credit_used')
      .eq('id', account_id)
      .eq('lab_id', lab_id)
      .eq('is_active', true)
      .single();

    if (accountError || !account) {
      console.error('[CHECK-B2B-CREDIT] Account error:', accountError);
      return new Response(
        JSON.stringify({ error: 'Account not found or inactive' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const creditLimit = Number(account.credit_limit) || 0;
    const storedCreditUsed = Number(account.credit_used) || 0;

    const { data: openOrders, error: openOrdersError } = await supabase
      .from('orders')
      .select('id, total_amount, final_amount, status, billing_status, is_billed')
      .eq('account_id', account_id)
      .eq('lab_id', lab_id);

    if (openOrdersError) {
      console.warn('[CHECK-B2B-CREDIT] Open order lookup failed:', openOrdersError);
    }

    const openOrderAmount = (openOrders || [])
      .filter((order: Record<string, unknown>) => {
        const status = String(order.status || '').toLowerCase();
        const billingStatus = String(order.billing_status || '').toLowerCase();
        return status !== 'cancelled' && order.is_billed !== true && billingStatus !== 'billed';
      })
      .reduce((sum: number, order: Record<string, unknown>) => {
        const finalAmount = Number(order.final_amount);
        if (Number.isFinite(finalAmount) && finalAmount > 0) return sum + finalAmount;

        const totalAmount = Number(order.total_amount);
        return sum + (Number.isFinite(totalAmount) ? totalAmount : 0);
      }, 0);

    const { data: outstandingInvoices, error: outstandingInvoicesError } = await supabase
      .from('consolidated_invoices')
      .select('id, total_amount, status')
      .eq('account_id', account_id)
      .eq('lab_id', lab_id);

    if (outstandingInvoicesError) {
      console.warn('[CHECK-B2B-CREDIT] Outstanding invoice lookup failed:', outstandingInvoicesError);
    }

    const openInvoices = (outstandingInvoices || []).filter((invoice: Record<string, unknown>) => {
      const status = String(invoice.status || '').toLowerCase();
      return status !== 'paid' && status !== 'cancelled';
    });

    const openInvoiceIds = new Set(openInvoices.map((invoice: Record<string, unknown>) => String(invoice.id)));

    const outstandingInvoiceAmount = openInvoices.reduce((sum: number, invoice: Record<string, unknown>) => {
      const amount = Number(invoice.total_amount);
      return sum + (Number.isFinite(amount) ? amount : 0);
    }, 0);

    const { data: pendingBookings, error: pendingBookingsError } = await supabase
      .from('bookings')
      .select('id, test_details, quotation_amount')
      .eq('account_id', account_id)
      .eq('lab_id', lab_id)
      .in('status', ['pending', 'quoted', 'confirmed']);

    if (pendingBookingsError) {
      console.warn('[CHECK-B2B-CREDIT] Pending booking lookup failed:', pendingBookingsError);
    }

    const pendingBookingAmount = (pendingBookings || []).reduce((sum: number, booking: Record<string, unknown>) => {
      const quoted = Number(booking.quotation_amount);
      if (Number.isFinite(quoted) && quoted > 0) return sum + quoted;

      const tests = Array.isArray(booking.test_details) ? booking.test_details : [];
      return sum + tests.reduce((testSum: number, item: unknown) => {
        if (!item || typeof item !== 'object') return testSum;
        const price = Number((item as Record<string, unknown>).price);
        return testSum + (Number.isFinite(price) ? price : 0);
      }, 0);
    }, 0);

    const { data: paymentCredits, error: paymentCreditsError } = await supabase
      .from('b2b_payment_attempts')
      .select('amount')
      .eq('account_id', account_id)
      .eq('lab_id', lab_id)
      .eq('status', 'success')
      .eq('credit_applied', true);

    if (paymentCreditsError) {
      console.warn('[CHECK-B2B-CREDIT] Payment credit lookup failed:', paymentCreditsError);
    }

    const paymentCreditAmount = (paymentCredits || []).reduce((sum: number, payment: Record<string, unknown>) => {
      const amount = Number(payment.amount);
      return sum + (Number.isFinite(amount) ? amount : 0);
    }, 0);

    // Cash / cheque / bank money the lab recorded against this account, from
    // either Account Master or Billing. Kept separate from the gateway payments
    // summed above by reference_type ('payment_attempt' vs 'manual'/'invoice').
    //
    // 'manual'  = advance, not tied to a bill -> always frees credit.
    // 'invoice' = paid against a consolidated invoice -> frees credit only while
    //             that invoice is still outstanding. Once it is marked paid it
    //             drops out of outstandingInvoiceAmount entirely, so continuing
    //             to subtract its payments would return the same money twice.
    const { data: manualCredits, error: manualCreditsError } = await supabase
      .from('b2b_credit_ledger')
      .select('amount, entry_type, reference_type, reference_id')
      .eq('account_id', account_id)
      .eq('lab_id', lab_id)
      .in('reference_type', ['manual', 'invoice'])
      .eq('is_reversed', false);

    if (manualCreditsError) {
      console.warn('[CHECK-B2B-CREDIT] Manual credit lookup failed:', manualCreditsError);
    }

    const manualCreditAmount = (manualCredits || [])
      .filter((entry: Record<string, unknown>) => {
        if (!['PAYMENT_CREDIT', 'MANUAL_CREDIT'].includes(String(entry.entry_type))) return false;
        if (entry.reference_type === 'manual') return true;
        return !!entry.reference_id && openInvoiceIds.has(String(entry.reference_id));
      })
      .reduce((sum: number, entry: Record<string, unknown>) => {
        const amount = Number(entry.amount);
        return sum + (Number.isFinite(amount) ? amount : 0);
      }, 0);

    const liveCreditUsed = Math.max(0, outstandingInvoiceAmount + openOrderAmount + pendingBookingAmount - paymentCreditAmount - manualCreditAmount);
    const effectiveCreditUsed = Math.max(storedCreditUsed, liveCreditUsed);
    const availableCredit = creditLimit - effectiveCreditUsed;
    const shortfall = Math.max(0, order_amount - availableCredit);
    const canProceed = availableCredit >= order_amount;
    const paymentRequired = !canProceed && shortfall > 0;

    // Match initiate-payment: any active gateway for the lab enables checkout.
    const { data: gateways, error: gatewaysError } = await supabase
      .from('lab_payment_gateways')
      .select('id')
      .eq('lab_id', lab_id)
      .eq('is_active', true)
      .limit(1);

    if (gatewaysError) {
      console.warn('[CHECK-B2B-CREDIT] Payment gateway lookup failed:', gatewaysError);
    }

    const paymentGatewayEnabled = !gatewaysError && (gateways?.length ?? 0) > 0;

    // Generate payment suggestions
    const suggestedPayments: CreditCheckResponse['suggested_payments'] = [];

    if (paymentRequired) {
      // Option 1: Pay exact shortfall
      suggestedPayments.push({
        label: 'Pay Shortfall',
        amount: shortfall,
        description: `Pay ₹${shortfall.toLocaleString('en-IN')} to cover the shortfall`
      });

      // Option 2: Pay full order amount
      if (shortfall < order_amount) {
        suggestedPayments.push({
          label: 'Pay Full Order',
          amount: order_amount,
          description: `Pay ₹${order_amount.toLocaleString('en-IN')} for this order`
        });
      }

      // Option 3: Custom top-up (just indicate it's available)
      suggestedPayments.push({
        label: 'Custom Amount',
        amount: 0,
        description: 'Enter a custom payment amount'
      });
    }

    const response: CreditCheckResponse = {
      can_proceed: canProceed,
      credit_limit: creditLimit,
      credit_used: effectiveCreditUsed,
      outstanding_invoice_amount: outstandingInvoiceAmount,
      open_order_amount: openOrderAmount,
      pending_booking_amount: pendingBookingAmount,
      payment_credit_amount: paymentCreditAmount,
      manual_credit_amount: manualCreditAmount,
      effective_credit_used: effectiveCreditUsed,
      available_credit: availableCredit,
      order_amount: order_amount,
      shortfall: shortfall,
      payment_required: paymentRequired,
      payment_gateway_enabled: paymentGatewayEnabled,
      minimum_payment: shortfall,
      suggested_payments: suggestedPayments
    };

    console.log('[CHECK-B2B-CREDIT] Result:', {
      account_id,
      can_proceed: canProceed,
      available_credit: availableCredit,
      outstanding_invoice_amount: outstandingInvoiceAmount,
      open_order_amount: openOrderAmount,
      pending_booking_amount: pendingBookingAmount,
      payment_credit_amount: paymentCreditAmount,
      manual_credit_amount: manualCreditAmount,
      shortfall
    });

    return new Response(
      JSON.stringify(response),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[CHECK-B2B-CREDIT] Error:', error);
    const message = error instanceof Error ? error.message : 'Internal server error';
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
