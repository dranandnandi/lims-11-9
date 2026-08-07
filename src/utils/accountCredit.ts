import { supabase } from './supabase';

/**
 * Account credit math, shared by Account Master, the Order Form and the B2B
 * portal so they can never disagree about how much credit an account has left.
 *
 * The formula mirrors the check-b2b-credit edge function exactly:
 *
 *   used      = outstanding bills + open orders + pending bookings
 *               - gateway payments - manual receipts        (floored at 0)
 *   available = credit limit - max(stored credit_used, used)
 *
 * Receipts are cash/cheque/bank money collected from the partner, entered
 * either in Account Master or in Billing. Both go through the
 * record_account_payment_receipt RPC, which writes the billing record and the
 * ledger entry together. They live in b2b_credit_ledger under two
 * reference_types, which is also what keeps them from being counted twice
 * alongside gateway payments (reference_type = 'payment_attempt'):
 *
 *   'manual'  = general advance, not tied to a bill. Always frees credit.
 *   'invoice' = paid against a consolidated invoice. Frees credit ONLY while
 *               that invoice is still outstanding.
 *
 * The second rule matters: an unpaid or partial invoice contributes its full
 * total to credit used, so a part-payment has to be netted off. The moment the
 * invoice is marked paid it drops out of the outstanding total altogether, and
 * netting its payments off as well would hand back the same money twice.
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

// Ledger entry types that add to an account's available credit.
const CREDIT_ENTRY_TYPES = ['PAYMENT_CREDIT', 'MANUAL_CREDIT'];

export interface AccountCreditSummary {
    accountId: string;
    accountName: string;
    creditLimit: number;
    /** accounts.credit_used, as maintained by the ledger */
    storedCreditUsed: number;
    openOrderAmount: number;
    outstandingInvoiceAmount: number;
    pendingBookingAmount: number;
    /** Successful online/gateway payments already applied to credit */
    gatewayPaymentCredit: number;
    /** Receipts currently freeing credit: advances + payments on still-open bills */
    manualPaymentCredit: number;
    /** Of the above, the part not tied to any bill */
    advanceReceiptCredit: number;
    /** Of the above, the part paid against invoices that are still outstanding */
    invoiceReceiptCredit: number;
    /** The used figure the rest of the app should show */
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

/** Pure math, so it can be reused anywhere the parts are already in hand. */
export const computeAvailableCredit = (parts: {
    creditLimit: number;
    storedCreditUsed: number;
    openOrderAmount: number;
    outstandingInvoiceAmount: number;
    pendingBookingAmount: number;
    gatewayPaymentCredit: number;
    manualPaymentCredit: number;
}): { effectiveCreditUsed: number; availableCredit: number } => {
    const liveCreditUsed = Math.max(
        0,
        parts.outstandingInvoiceAmount +
            parts.openOrderAmount +
            parts.pendingBookingAmount -
            parts.gatewayPaymentCredit -
            parts.manualPaymentCredit
    );
    const effectiveCreditUsed = Math.max(parts.storedCreditUsed, liveCreditUsed);
    return { effectiveCreditUsed, availableCredit: parts.creditLimit - effectiveCreditUsed };
};

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
 * Splits un-voided receipts into the part that always frees credit (advances)
 * and the part that only does so while its invoice is still outstanding.
 */
const sumReceiptCredits = (
    ledgerRows: { amount: unknown; entry_type: unknown; reference_type: unknown; reference_id: unknown }[],
    outstandingInvoiceIds: Set<string>
): ReceiptCreditTotals => {
    let advance = 0;
    let invoiceLinked = 0;

    for (const row of ledgerRows) {
        if (!CREDIT_ENTRY_TYPES.includes(String(row.entry_type))) continue;
        const amount = toNumber(row.amount);

        if (row.reference_type === 'manual') {
            advance += amount;
        } else if (row.reference_type === 'invoice') {
            // Once the bill is settled it leaves the outstanding total, so this
            // payment must stop being netted off or it counts twice.
            if (row.reference_id && outstandingInvoiceIds.has(String(row.reference_id))) {
                invoiceLinked += amount;
            }
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
export const fetchReceiptCreditTotal = async (accountId: string): Promise<number> => {
    const [ledgerRows, invoicesRes] = await Promise.all([
        fetchReceiptLedgerRows(accountId),
        supabase.from('consolidated_invoices').select('id, status').eq('account_id', accountId),
    ]);

    if (invoicesRes.error) {
        console.warn('Error fetching invoice statuses for receipt credit:', invoicesRes.error);
    }

    const outstandingIds = new Set(
        (invoicesRes.data || []).filter((i) => isInvoiceOutstanding(i.status)).map((i) => String(i.id))
    );

    return sumReceiptCredits(ledgerRows, outstandingIds).total;
};

/** Full credit picture for one account. */
export const fetchAccountCreditSummary = async (accountId: string): Promise<AccountCreditSummary | null> => {
    const { data: account, error: accountError } = await supabase
        .from('accounts')
        .select('id, lab_id, name, credit_limit, credit_used')
        .eq('id', accountId)
        .single();

    if (accountError || !account) {
        console.warn('Error loading account for credit summary:', accountError);
        return null;
    }

    const labId = account.lab_id;

    const [ordersRes, invoicesRes, bookingsRes, gatewayRes, ledgerRows] = await Promise.all([
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
        supabase
            .from('bookings')
            .select('quotation_amount, test_details')
            .eq('account_id', accountId)
            .eq('lab_id', labId)
            .in('status', ['pending', 'quoted', 'confirmed']),
        supabase
            .from('b2b_payment_attempts')
            .select('amount')
            .eq('account_id', accountId)
            .eq('lab_id', labId)
            .eq('status', 'success')
            .eq('credit_applied', true),
        fetchReceiptLedgerRows(accountId),
    ]);

    if (ordersRes.error) console.warn('Credit summary: open order lookup failed:', ordersRes.error);
    if (invoicesRes.error) console.warn('Credit summary: invoice lookup failed:', invoicesRes.error);
    if (bookingsRes.error) console.warn('Credit summary: booking lookup failed:', bookingsRes.error);
    if (gatewayRes.error) console.warn('Credit summary: gateway payment lookup failed:', gatewayRes.error);

    const openOrderAmount = (ordersRes.data || []).filter(isOpenCreditOrder).reduce((sum, o) => sum + orderAmount(o), 0);

    const outstandingInvoices = (invoicesRes.data || []).filter((invoice) => isInvoiceOutstanding(invoice.status));
    const outstandingInvoiceAmount = outstandingInvoices.reduce((sum, invoice) => sum + toNumber(invoice.total_amount), 0);

    const receipts = sumReceiptCredits(ledgerRows, new Set(outstandingInvoices.map((i) => String(i.id))));

    const pendingBookingAmount = (bookingsRes.data || []).reduce((sum, b) => sum + bookingAmount(b), 0);
    const gatewayPaymentCredit = (gatewayRes.data || []).reduce((sum, p) => sum + toNumber(p.amount), 0);

    const creditLimit = toNumber(account.credit_limit);
    const storedCreditUsed = toNumber(account.credit_used);

    const { effectiveCreditUsed, availableCredit } = computeAvailableCredit({
        creditLimit,
        storedCreditUsed,
        openOrderAmount,
        outstandingInvoiceAmount,
        pendingBookingAmount,
        gatewayPaymentCredit,
        manualPaymentCredit: receipts.total,
    });

    return {
        accountId,
        accountName: account.name,
        creditLimit,
        storedCreditUsed,
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
        .filter((entry) => CREDIT_ENTRY_TYPES.includes(String(entry.entry_type)))
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
