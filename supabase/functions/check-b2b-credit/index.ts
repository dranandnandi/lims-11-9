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
//   "can_proceed": true/false,          // always true when bypass_credit_check
//   "bypass_credit_check": true/false,  // accounts.bypass_credit_check, honouring credit_bypass_until
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
  /** True while bypass_credit_check is on and not past credit_bypass_until - the limit never blocks */
  bypass_credit_check: boolean;
  credit_limit: number;
  credit_used: number;
  /** Total unreversed ORDER_DEBIT - the work this account has consumed */
  order_debit_amount: number;
  /** Ledger debits minus credits. Negative = advance balance. */
  ledger_credit_used: number;
  /** Money paid that no order has consumed yet. Zero unless in advance. */
  advance_balance: number;
  /** Informational only - already counted via ORDER_DEBIT */
  outstanding_invoice_amount: number;
  /** Informational only - already counted via ORDER_DEBIT */
  open_order_amount: number;
  pending_booking_amount: number;
  payment_credit_amount: number;
  manual_credit_amount: number;
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
      .select('id, name, credit_limit, credit_used, bypass_credit_check, credit_bypass_until')
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

    // Display-only breakdowns. Neither feeds the math: orders are counted
    // through their ORDER_DEBIT ledger entry, and a consolidated invoice only
    // groups orders that were already debited, so adding it would double-count.
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

    const outstandingInvoiceAmount = (outstandingInvoices || [])
      .filter((invoice: Record<string, unknown>) => {
        const status = String(invoice.status || '').toLowerCase();
        return status !== 'paid' && status !== 'cancelled';
      })
      .reduce((sum: number, invoice: Record<string, unknown>) => {
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

    // The ledger is the source of truth. Every order on an account carries an
    // ORDER_DEBIT (trg_orders_credit_debit) and every payment a credit, so the
    // running position is just debits minus credits. It is deliberately NOT
    // floored at zero: negative means the partner is in advance, having paid
    // money no order has consumed yet, and that is real headroom.
    const { data: ledgerEntries, error: ledgerError } = await supabase
      .from('b2b_credit_ledger')
      .select('amount, entry_type, reference_type, reference_id')
      .eq('account_id', account_id)
      .eq('lab_id', lab_id)
      .eq('is_reversed', false);

    if (ledgerError) {
      console.warn('[CHECK-B2B-CREDIT] Ledger lookup failed:', ledgerError);
    }

    const LEDGER_DEBIT_TYPES = ['ORDER_DEBIT', 'MANUAL_DEBIT', 'REFUND_DEBIT', 'EXPIRED_DEBIT', 'TRANSFER_OUT'];
    const LEDGER_CREDIT_TYPES = ['ORDER_CANCEL_CREDIT', 'PAYMENT_CREDIT', 'MANUAL_CREDIT', 'TRANSFER_IN'];
    const RECEIPT_ENTRY_TYPES = ['PAYMENT_CREDIT', 'MANUAL_CREDIT'];

    const entryAmount = (entry: Record<string, unknown>) => {
      const amount = Number(entry.amount);
      return Number.isFinite(amount) ? amount : 0;
    };

    const rows = (ledgerEntries || []) as Record<string, unknown>[];

    const ledgerCreditUsed = rows.reduce((sum: number, entry) => {
      const type = String(entry.entry_type);
      if (LEDGER_DEBIT_TYPES.includes(type)) return sum + entryAmount(entry);
      if (LEDGER_CREDIT_TYPES.includes(type)) return sum - entryAmount(entry);
      return sum;
    }, 0);

    const orderDebitAmount = rows
      .filter((entry) => String(entry.entry_type) === 'ORDER_DEBIT')
      .reduce((sum: number, entry) => sum + entryAmount(entry), 0);

    // Gateway payments (reference_type 'payment_attempt') and money receipted at
    // the lab ('manual' advances / 'invoice' bill payments) are reported apart
    // for the UI, but both count in full against the order debits above.
    const paymentCreditAmount = rows
      .filter((entry) => entry.reference_type === 'payment_attempt' && RECEIPT_ENTRY_TYPES.includes(String(entry.entry_type)))
      .reduce((sum: number, entry) => sum + entryAmount(entry), 0);

    const manualCreditAmount = rows
      .filter((entry) => ['manual', 'invoice'].includes(String(entry.reference_type)) && RECEIPT_ENTRY_TYPES.includes(String(entry.entry_type)))
      .reduce((sum: number, entry) => sum + entryAmount(entry), 0);

    // Bookings are quotes, not financial events, so they get no ledger entry -
    // but they still reserve headroom until they become an order or are dropped.
    const effectiveCreditUsed = ledgerCreditUsed + pendingBookingAmount;
    const availableCredit = creditLimit - effectiveCreditUsed;
    const advanceBalance = Math.max(0, -ledgerCreditUsed);
    // Accounts flagged in Account Master skip the gate entirely: the figures are
    // still reported, but nothing is blocked and no top-up is demanded. A bypass
    // may carry an expiry (credit_bypass_until) - once it passes the gate is
    // back on by itself, exactly like the lock's temporary-open window.
    const bypassExpiry = account.credit_bypass_until ? new Date(account.credit_bypass_until).getTime() : null;
    const bypassCreditCheck = account.bypass_credit_check === true && (bypassExpiry === null || bypassExpiry > Date.now());
    const canProceed = bypassCreditCheck || availableCredit >= order_amount;
    const shortfall = canProceed ? 0 : Math.max(0, order_amount - availableCredit);
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
      bypass_credit_check: bypassCreditCheck,
      credit_limit: creditLimit,
      credit_used: effectiveCreditUsed,
      order_debit_amount: orderDebitAmount,
      ledger_credit_used: ledgerCreditUsed,
      advance_balance: advanceBalance,
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
      bypass_credit_check: bypassCreditCheck,
      available_credit: availableCredit,
      order_debit_amount: orderDebitAmount,
      ledger_credit_used: ledgerCreditUsed,
      // accounts.credit_used is a cache of the same sum, maintained by
      // recalculate_account_credit_used(). A mismatch means the trigger missed
      // a write and the account needs a resync.
      stored_credit_used: storedCreditUsed,
      advance_balance: advanceBalance,
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
