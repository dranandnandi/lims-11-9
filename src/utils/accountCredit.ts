import { supabase } from './supabase';

/**
 * Account credit math, shared by Account Master, the Order Form and the B2B
 * portal so they can never disagree about how much credit an account has left.
 *
 * The b2b_credit_ledger is the source of truth. Every order placed on an
 * account writes an ORDER_DEBIT (see the trg_orders_credit_debit trigger) and
 * every payment writes a credit, so the running position is simply:
 *
 *   ledger used = debits - credits            (may go negative)
 *   used        = ledger used + pending bookings
 *   available   = credit limit - used
 *
 * Nothing is floored at zero. A negative ledger position is an *advance
 * balance*: money the partner has paid that no order has consumed yet, which
 * correctly reads as headroom above the credit limit. Flooring it - as this
 * module used to - silently swallowed every top-up made with nothing
 * outstanding.
 *
 * Consolidated invoices are deliberately absent from the math. An invoice only
 * groups orders that have already been debited, so counting it as well would
 * charge the partner twice for the same work.
 *
 * Pending bookings are the one non-ledger term. A booking is a quote, not a
 * financial event, so it gets no ledger entry - but it still reserves headroom
 * until it either becomes an order (which debits) or is dropped.
 *
 * Receipts are cash/cheque/bank money collected from the partner, entered
 * either in Account Master or in Billing. Both go through the
 * record_account_payment_receipt RPC, which writes the billing record and the
 * ledger entry together. They live in b2b_credit_ledger under two
 * reference_types:
 *
 *   'manual'  = general advance, not tied to a bill
 *   'invoice' = paid against a consolidated invoice
 *
 * Both now free credit unconditionally. The old rule - invoice-linked receipts
 * stop counting once their invoice is marked paid - existed only because unpaid
 * invoices were themselves counted as usage, so a settled invoice had to take
 * its payments with it. With orders carrying the debit instead, retiring those
 * payments would leave the order debit standing and put the partner permanently
 * in the red for work they had already paid for.
 */

// 'neft' / 'rtgs' come from the Billing modal, which has stored them for a long
// time; the RPC accepts them so historical rows keep rendering the same way.
export type AccountPaymentMode =
    | 'cash' | 'cheque' | 'bank_transfer' | 'upi' | 'card' | 'other' | 'neft' | 'rtgs';

/** Modes offered in the Account Master receipt form. */
export const ACCOUNT_PAYMENT_MODES: { value: AccountPaymentMode; label: string }[] = [
    { value: 'cash', label: 'Cash' },
    { value: 'cheque', label: 'Cheque' },
    { value: 'bank_transfer', label: 'Bank Transfer / NEFT' },
    { value: 'upi', label: 'UPI' },
    { value: 'card', label: 'Card' },
    { value: 'other', label: 'Other' },
];

// Ledger entry types that record money received from the partner. Used both for
// the receipt list and for the credit side of the running position.
const RECEIPT_ENTRY_TYPES = ['PAYMENT_CREDIT', 'MANUAL_CREDIT'];

// The full ledger sign convention, matching recalculate_account_credit_used().
const LEDGER_DEBIT_TYPES = ['ORDER_DEBIT', 'MANUAL_DEBIT', 'REFUND_DEBIT', 'EXPIRED_DEBIT', 'TRANSFER_OUT'];
const LEDGER_CREDIT_TYPES = ['ORDER_CANCEL_CREDIT', 'PAYMENT_CREDIT', 'MANUAL_CREDIT', 'TRANSFER_IN'];

export interface AccountCreditSummary {
    accountId: string;
    accountName: string;
    /** True while the bypass is on AND not expired - no credit gate may block this account */
    bypassCreditCheck: boolean;
    /** When the active bypass runs out (ISO). Null = no expiry, or no bypass at all. */
    bypassCreditUntil: string | null;
    creditLimit: number;
    /** accounts.credit_used, as maintained by the ledger. Negative = advance held. */
    storedCreditUsed: number;
    /** Total unreversed ORDER_DEBIT - the work this account has consumed */
    orderDebitAmount: number;
    /** Debits minus credits from the ledger alone. Negative = advance balance. */
    ledgerCreditUsed: number;
    /** Money paid but not yet consumed by any order. Zero unless in advance. */
    advanceBalance: number;
    /**
     * Informational only - NOT part of the math. Orders are already counted via
     * their ORDER_DEBIT, and invoices only group orders that were debited.
     */
    openOrderAmount: number;
    /** Informational only - see openOrderAmount */
    outstandingInvoiceAmount: number;
    /** Quotes reserving headroom until they become orders. Part of the math. */
    pendingBookingAmount: number;
    /** Successful online/gateway payments already applied to credit */
    gatewayPaymentCredit: number;
    /** Cash/cheque/bank receipts freeing credit: advances + bill payments */
    manualPaymentCredit: number;
    /** Of the above, the part not tied to any bill */
    advanceReceiptCredit: number;
    /** Of the above, the part paid against a consolidated invoice */
    invoiceReceiptCredit: number;
    /** The used figure the rest of the app should show (ledger + bookings) */
    effectiveCreditUsed: number;
    availableCredit: number;
}

export interface AccountCashReceipt {
    id: string;
    amount: number;
    paymentMode: AccountPaymentMode;
    referenceNo: string | null;
    receivedOn: string | null;
    remarks: string | null;
    createdAt: string;
    createdBy: string | null;
    isReversed: boolean;
    reversalReason: string | null;
    /** Set when the receipt was entered against a consolidated invoice */
    linkedInvoiceId: string | null;
    /** 'account_master' | 'billing' */
    source: string;
    /** Only un-linked advances can be voided; invoice payments belong to Billing */
    canVoid: boolean;
}

const toNumber = (value: unknown): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * True when the account is exempt from credit blocking. Every credit gate in
 * the app funnels through this, so switching the flag on in Account Master
 * releases order creation, B2B bookings and report downloads at once.
 *
 * A bypass may be time-limited, exactly like the lock's temporary-open window:
 * credit_bypass_until in the future = still live, in the past = spent, so the
 * limits start blocking again on their own. Null = no expiry.
 *
 * Deliberately independent of is_locked - a locked account stays blocked.
 */
export const isCreditCheckBypassed = (
    account: { bypass_credit_check?: boolean | null; credit_bypass_until?: string | null } | null | undefined
): boolean => {
    if (account?.bypass_credit_check !== true) return false;
    if (account.credit_bypass_until && new Date(account.credit_bypass_until).getTime() <= Date.now()) return false;
    return true;
};

/**
 * The one place that decides whether a credit position blocks an action.
 * `required` is the amount about to be charged (0 = just checking the account
 * is not already over its limit).
 */
export const isCreditAllowed = (
    parts: { availableCredit: number; bypassCreditCheck?: boolean | null },
    required = 0
): boolean => parts.bypassCreditCheck === true || required <= parts.availableCredit;

/**
 * Pure math, so it can be reused anywhere the parts are already in hand.
 *
 * `ledgerCreditUsed` is debits minus credits and is expected to go negative when
 * the partner is in advance - do not clamp it on the way in. Pending bookings
 * are added on top because a quote reserves headroom without being a ledger
 * event.
 */
export const computeAvailableCredit = (parts: {
    creditLimit: number;
    ledgerCreditUsed: number;
    pendingBookingAmount: number;
}): { effectiveCreditUsed: number; availableCredit: number; advanceBalance: number } => {
    const effectiveCreditUsed = parts.ledgerCreditUsed + parts.pendingBookingAmount;
    return {
        effectiveCreditUsed,
        availableCredit: parts.creditLimit - effectiveCreditUsed,
        advanceBalance: Math.max(0, -parts.ledgerCreditUsed),
    };
};

/** Debits minus credits over a set of ledger rows. Negative = advance balance. */
export const sumLedgerPosition = (
    rows: { amount: unknown; entry_type: unknown }[]
): number =>
    rows.reduce((sum, row) => {
        const type = String(row.entry_type);
        if (LEDGER_DEBIT_TYPES.includes(type)) return sum + toNumber(row.amount);
        if (LEDGER_CREDIT_TYPES.includes(type)) return sum - toNumber(row.amount);
        return sum;
    }, 0);

const orderAmount = (order: Record<string, unknown>): number => {
    const finalAmount = toNumber(order.final_amount);
    if (finalAmount > 0) return finalAmount;
    return toNumber(order.total_amount);
};

const isOpenCreditOrder = (order: Record<string, unknown>): boolean => {
    const status = String(order.status || '').toLowerCase();
    const billingStatus = String(order.billing_status || '').toLowerCase();
    return status !== 'cancelled' && order.is_billed !== true && billingStatus !== 'billed';
};

const bookingAmount = (booking: Record<string, unknown>): number => {
    const quoted = toNumber(booking.quotation_amount);
    if (quoted > 0) return quoted;

    const tests = Array.isArray(booking.test_details) ? booking.test_details : [];
    return tests.reduce((sum: number, item: unknown) => {
        if (!item || typeof item !== 'object') return sum;
        return sum + toNumber((item as Record<string, unknown>).price);
    }, 0);
};

const SETTLED_INVOICE_STATUSES = ['paid', 'cancelled'];

const isInvoiceOutstanding = (status: unknown) =>
    !SETTLED_INVOICE_STATUSES.includes(String(status || '').toLowerCase());

interface ReceiptCreditTotals {
    advance: number;
    invoiceLinked: number;
    total: number;
}

/**
 * Splits un-voided receipts into advances and payments made against a bill.
 * Both count in full: the order-level ORDER_DEBIT is what the payment is
 * cancelling, and that debit stays put when the invoice is marked paid, so
 * there is nothing left to double-count against.
 */
const sumReceiptCredits = (
    ledgerRows: { amount: unknown; entry_type: unknown; reference_type: unknown; reference_id: unknown }[]
): ReceiptCreditTotals => {
    let advance = 0;
    let invoiceLinked = 0;

    for (const row of ledgerRows) {
        if (!RECEIPT_ENTRY_TYPES.includes(String(row.entry_type))) continue;
        const amount = toNumber(row.amount);

        if (row.reference_type === 'manual') {
            advance += amount;
        } else if (row.reference_type === 'invoice') {
            invoiceLinked += amount;
        }
    }

    return { advance, invoiceLinked, total: advance + invoiceLinked };
};

const fetchReceiptLedgerRows = async (accountId: string) => {
    const { data, error } = await supabase
        .from('b2b_credit_ledger')
        .select('amount, entry_type, reference_type, reference_id')
        .eq('account_id', accountId)
        .in('reference_type', ['manual', 'invoice'])
        .eq('is_reversed', false);

    if (error) {
        console.warn('Error fetching receipt ledger entries:', error);
        return [];
    }
    return data || [];
};

/**
 * Total receipt credit currently freeing headroom for an account.
 * Used where only the number is needed (e.g. the partner portal).
 */
export const fetchReceiptCreditTotal = async (accountId: string): Promise<number> =>
    sumReceiptCredits(await fetchReceiptLedgerRows(accountId)).total;

/** Full credit picture for one account. */
export const fetchAccountCreditSummary = async (accountId: string): Promise<AccountCreditSummary | null> => {
    const { data: account, error: accountError } = await supabase
        .from('accounts')
        .select('id, lab_id, name, credit_limit, credit_used, bypass_credit_check, credit_bypass_until')
        .eq('id', accountId)
        .single();

    if (accountError || !account) {
        console.warn('Error loading account for credit summary:', accountError);
        return null;
    }

    const labId = account.lab_id;

    const [ledgerRes, bookingsRes, ordersRes, invoicesRes] = await Promise.all([
        supabase
            .from('b2b_credit_ledger')
            .select('amount, entry_type, reference_type, reference_id')
            .eq('account_id', accountId)
            .eq('is_reversed', false),
        supabase
            .from('bookings')
            .select('quotation_amount, test_details')
            .eq('account_id', accountId)
            .eq('lab_id', labId)
            .in('status', ['pending', 'quoted', 'confirmed']),
        // Display-only breakdowns. Neither feeds the math - orders are already
        // counted through their ORDER_DEBIT, and invoices only group them.
        supabase
            .from('orders')
            .select('total_amount, final_amount, status, billing_status, is_billed')
            .eq('account_id', accountId)
            .eq('lab_id', labId),
        supabase
            .from('consolidated_invoices')
            .select('id, total_amount, status')
            .eq('account_id', accountId)
            .eq('lab_id', labId),
    ]);

    if (ledgerRes.error) console.warn('Credit summary: ledger lookup failed:', ledgerRes.error);
    if (bookingsRes.error) console.warn('Credit summary: booking lookup failed:', bookingsRes.error);
    if (ordersRes.error) console.warn('Credit summary: open order lookup failed:', ordersRes.error);
    if (invoicesRes.error) console.warn('Credit summary: invoice lookup failed:', invoicesRes.error);

    const ledgerRows = ledgerRes.data || [];

    const orderDebitAmount = ledgerRows
        .filter((row) => String(row.entry_type) === 'ORDER_DEBIT')
        .reduce((sum, row) => sum + toNumber(row.amount), 0);

    const gatewayPaymentCredit = ledgerRows
        .filter((row) => row.reference_type === 'payment_attempt' && RECEIPT_ENTRY_TYPES.includes(String(row.entry_type)))
        .reduce((sum, row) => sum + toNumber(row.amount), 0);

    const receipts = sumReceiptCredits(ledgerRows);

    const openOrderAmount = (ordersRes.data || []).filter(isOpenCreditOrder).reduce((sum, o) => sum + orderAmount(o), 0);
    const outstandingInvoiceAmount = (invoicesRes.data || [])
        .filter((invoice) => isInvoiceOutstanding(invoice.status))
        .reduce((sum, invoice) => sum + toNumber(invoice.total_amount), 0);

    const pendingBookingAmount = (bookingsRes.data || []).reduce((sum, b) => sum + bookingAmount(b), 0);

    const creditLimit = toNumber(account.credit_limit);
    const storedCreditUsed = toNumber(account.credit_used);
    const ledgerCreditUsed = sumLedgerPosition(ledgerRows);

    const { effectiveCreditUsed, availableCredit, advanceBalance } = computeAvailableCredit({
        creditLimit,
        ledgerCreditUsed,
        pendingBookingAmount,
    });

    return {
        accountId,
        accountName: account.name,
        bypassCreditCheck: isCreditCheckBypassed(account),
        bypassCreditUntil: isCreditCheckBypassed(account) ? (account.credit_bypass_until || null) : null,
        creditLimit,
        storedCreditUsed,
        orderDebitAmount,
        ledgerCreditUsed,
        advanceBalance,
        openOrderAmount,
        outstandingInvoiceAmount,
        pendingBookingAmount,
        gatewayPaymentCredit,
        manualPaymentCredit: receipts.total,
        advanceReceiptCredit: receipts.advance,
        invoiceReceiptCredit: receipts.invoiceLinked,
        effectiveCreditUsed,
        availableCredit,
    };
};

/** Receipt history for the Account Master ledger view. */
export const fetchAccountCashReceipts = async (accountId: string, limit = 50): Promise<AccountCashReceipt[]> => {
    const { data, error } = await supabase
        .from('b2b_credit_ledger')
        .select('id, amount, entry_type, remarks, metadata, created_at, created_by, is_reversed, reversal_reason, reference_type, reference_id')
        .eq('account_id', accountId)
        .in('reference_type', ['manual', 'invoice'])
        .order('created_at', { ascending: false })
        .limit(limit);

    if (error) {
        console.warn('Error fetching account receipts:', error);
        return [];
    }

    return (data || [])
        .filter((entry) => RECEIPT_ENTRY_TYPES.includes(String(entry.entry_type)))
        .map((entry) => {
            const metadata = (entry.metadata || {}) as Record<string, unknown>;
            return {
                id: entry.id,
                amount: toNumber(entry.amount),
                paymentMode: (String(metadata.payment_mode || 'cash') as AccountPaymentMode),
                referenceNo: (metadata.reference_no as string) || null,
                receivedOn: (metadata.received_on as string) || null,
                remarks: entry.remarks || null,
                createdAt: entry.created_at,
                createdBy: entry.created_by || null,
                isReversed: !!entry.is_reversed,
                reversalReason: entry.reversal_reason || null,
                linkedInvoiceId: entry.reference_type === 'invoice' ? (entry.reference_id as string) || null : null,
                source: String(metadata.source || (entry.reference_type === 'invoice' ? 'billing' : 'account_master')),
                canVoid: entry.reference_type === 'manual' && !entry.is_reversed,
            };
        });
};

export interface RecordCashReceiptInput {
    accountId: string;
    amount: number;
    paymentMode: AccountPaymentMode;
    referenceNo?: string;
    receivedOn?: string;
    remarks?: string;
    /** Ties the receipt to a bill. Omit for a general advance. */
    consolidatedInvoiceId?: string | null;
}

export interface RecordCashReceiptResult {
    entry_id: string;
    credit_transaction_id: string;
    amount: number;
    credit_limit: number;
    credit_used: number;
    available_credit: number;
}

/**
 * The single entry point for money received from an account, used by both
 * Account Master and Billing. One RPC writes the billing record and the credit
 * ledger entry together, so the two can never disagree.
 */
export const recordAccountCashReceipt = async (input: RecordCashReceiptInput): Promise<RecordCashReceiptResult> => {
    const { data, error } = await supabase.rpc('record_account_payment_receipt', {
        p_account_id: input.accountId,
        p_amount: input.amount,
        p_payment_mode: input.paymentMode,
        p_reference_no: input.referenceNo?.trim() || null,
        p_received_on: input.receivedOn || null,
        p_remarks: input.remarks?.trim() || null,
        p_consolidated_invoice_id: input.consolidatedInvoiceId || null,
    });

    if (error) throw new Error(error.message || 'Failed to record the receipt');
    return data as RecordCashReceiptResult;
};

/** Voids a receipt entered by mistake and withdraws the credit it granted. */
export const voidAccountCashReceipt = async (entryId: string, reason?: string) => {
    const { data, error } = await supabase.rpc('reverse_account_cash_receipt', {
        p_entry_id: entryId,
        p_reason: reason?.trim() || null,
    });

    if (error) throw new Error(error.message || 'Failed to void the receipt');
    return data as { entry_id: string; credit_limit: number; credit_used: number; available_credit: number };
};
