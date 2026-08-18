import React, { useCallback, useEffect, useState } from 'react';
import { X, Wallet, Loader2, Undo2, AlertCircle, CheckCircle2 } from 'lucide-react';
import {
    ACCOUNT_PAYMENT_MODES,
    AccountCashReceipt,
    AccountCreditSummary,
    AccountPaymentMode,
    fetchAccountCashReceipts,
    fetchAccountCreditSummary,
    recordAccountCashReceipt,
    voidAccountCashReceipt,
} from '../../utils/accountCredit';

interface Props {
    account: { id: string; name: string };
    onClose: () => void;
    /** Fired after a receipt is recorded or voided, so callers can refresh. */
    onCreditChanged?: () => void;
}

const formatCurrency = (amount: number) =>
    new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(amount || 0);

const formatDate = (value: string | null) => {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '-';
    return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

const modeLabel = (mode: AccountPaymentMode) =>
    ACCOUNT_PAYMENT_MODES.find((m) => m.value === mode)?.label || mode;

const todayIso = () => new Date().toISOString().slice(0, 10);

const AccountCreditModal: React.FC<Props> = ({ account, onClose, onCreditChanged }) => {
    const [summary, setSummary] = useState<AccountCreditSummary | null>(null);
    const [receipts, setReceipts] = useState<AccountCashReceipt[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [voidingId, setVoidingId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);

    const [amount, setAmount] = useState('');
    const [paymentMode, setPaymentMode] = useState<AccountPaymentMode>('cash');
    const [referenceNo, setReferenceNo] = useState('');
    const [receivedOn, setReceivedOn] = useState(todayIso());
    const [remarks, setRemarks] = useState('');

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const [summaryData, receiptData] = await Promise.all([
                fetchAccountCreditSummary(account.id),
                fetchAccountCashReceipts(account.id),
            ]);
            setSummary(summaryData);
            setReceipts(receiptData);
        } finally {
            setLoading(false);
        }
    }, [account.id]);

    useEffect(() => {
        load();
    }, [load]);

    const resetForm = () => {
        setAmount('');
        setPaymentMode('cash');
        setReferenceNo('');
        setReceivedOn(todayIso());
        setRemarks('');
    };

    const handleRecord = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);
        setSuccess(null);

        const parsedAmount = Number(amount);
        if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
            setError('Enter an amount greater than zero.');
            return;
        }
        if (paymentMode === 'cheque' && !referenceNo.trim()) {
            setError('Enter the cheque number.');
            return;
        }

        setSaving(true);
        try {
            const result = await recordAccountCashReceipt({
                accountId: account.id,
                amount: parsedAmount,
                paymentMode,
                referenceNo,
                receivedOn,
                remarks,
            });
            setSuccess(
                `${formatCurrency(parsedAmount)} recorded. Available credit is now ${formatCurrency(Number(result.available_credit))}.`
            );
            resetForm();
            await load();
            onCreditChanged?.();
        } catch (err: any) {
            setError(err?.message || 'Failed to record the receipt.');
        } finally {
            setSaving(false);
        }
    };

    const handleVoid = async (receipt: AccountCashReceipt) => {
        const reason = window.prompt(
            `Void the ${formatCurrency(receipt.amount)} receipt? The credit it gave back will be withdrawn.\n\nReason (optional):`
        );
        if (reason === null) return;

        setError(null);
        setSuccess(null);
        setVoidingId(receipt.id);
        try {
            await voidAccountCashReceipt(receipt.id, reason);
            setSuccess('Receipt voided.');
            await load();
            onCreditChanged?.();
        } catch (err: any) {
            setError(err?.message || 'Failed to void the receipt.');
        } finally {
            setVoidingId(null);
        }
    };

    const availableCredit = summary?.availableCredit ?? 0;

    return (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
            <div className="bg-white rounded-lg w-full max-w-4xl max-h-[92vh] overflow-y-auto">
                <div className="flex items-center justify-between p-5 border-b border-gray-200 sticky top-0 bg-white z-10">
                    <div className="flex items-center gap-3">
                        <div className="h-10 w-10 rounded-lg bg-emerald-50 flex items-center justify-center">
                            <Wallet className="w-5 h-5 text-emerald-600" />
                        </div>
                        <div>
                            <h2 className="text-lg font-bold text-gray-900">Credit &amp; Payments</h2>
                            <p className="text-sm text-gray-500">{account.name}</p>
                        </div>
                    </div>
                    <button onClick={onClose} className="text-gray-400 hover:text-gray-600" title="Close">
                        <X className="w-5 h-5" />
                    </button>
                </div>

                <div className="p-5 space-y-6">
                    {error && (
                        <div className="flex items-start gap-2 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
                            <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                            <span>{error}</span>
                        </div>
                    )}
                    {success && (
                        <div className="flex items-start gap-2 p-3 rounded-lg bg-green-50 border border-green-200 text-sm text-green-700">
                            <CheckCircle2 className="w-4 h-4 mt-0.5 flex-shrink-0" />
                            <span>{success}</span>
                        </div>
                    )}

                    {loading ? (
                        <div className="py-12 text-center text-gray-500">
                            <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" />
                            Loading credit position...
                        </div>
                    ) : !summary ? (
                        <div className="py-12 text-center text-gray-500">Could not load this account&apos;s credit position.</div>
                    ) : (
                        <>
                            {/* Credit position */}
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                                <div className="rounded-lg border border-gray-200 p-4">
                                    <div className="text-xs uppercase tracking-wide text-gray-500">Credit Limit</div>
                                    <div className="text-xl font-bold text-gray-900 mt-1">{formatCurrency(summary.creditLimit)}</div>
                                    <div className="text-xs text-gray-400 mt-1">Set on the account, unchanged by receipts</div>
                                </div>
                                <div className="rounded-lg border border-gray-200 p-4">
                                    <div className="text-xs uppercase tracking-wide text-gray-500">Credit Used</div>
                                    <div className={`text-xl font-bold mt-1 ${summary.effectiveCreditUsed >= 0 ? 'text-orange-600' : 'text-green-700'}`}>
                                        {formatCurrency(summary.effectiveCreditUsed)}
                                    </div>
                                    <div className="text-xs text-gray-400 mt-1">
                                        {summary.effectiveCreditUsed < 0
                                            ? 'In advance — paid more than has been consumed'
                                            : 'Orders placed and bookings held, net of payments'}
                                    </div>
                                </div>
                                <div className={`rounded-lg border p-4 ${availableCredit >= 0 ? 'border-green-200 bg-green-50' : 'border-red-200 bg-red-50'}`}>
                                    <div className="text-xs uppercase tracking-wide text-gray-500">Available Credit</div>
                                    <div className={`text-xl font-bold mt-1 ${availableCredit >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                                        {formatCurrency(availableCredit)}
                                    </div>
                                    <div className="text-xs text-gray-500 mt-1">
                                        {summary.bypassCreditCheck
                                            ? summary.bypassCreditUntil
                                                ? `Credit check bypassed till ${new Date(summary.bypassCreditUntil).toLocaleString()}`
                                                : 'Credit check bypassed — bookings allowed regardless'
                                            : availableCredit >= 0
                                                ? 'Partner can book against this'
                                                : 'Over limit — portal bookings blocked'}
                                    </div>
                                </div>
                            </div>

                            {/* Breakdown */}
                            <div className="rounded-lg border border-gray-200 divide-y divide-gray-100 text-sm">
                                {/* The terms of the balance, in the order they apply. Open orders
                                    and outstanding bills sit below the line as context only: both
                                    are already inside "Orders Placed", so adding them here would
                                    read as double the charge. */}
                                <div className="flex items-center justify-between px-4 py-2.5">
                                    <span className="text-gray-500">Orders Placed</span>
                                    <span className="font-medium text-orange-600">{formatCurrency(summary.orderDebitAmount)}</span>
                                </div>
                                <div className="flex items-center justify-between px-4 py-2.5">
                                    <span className="text-gray-500">Pending Bookings</span>
                                    <span className="font-medium text-amber-600">{formatCurrency(summary.pendingBookingAmount)}</span>
                                </div>
                                <div className="flex items-center justify-between px-4 py-2.5">
                                    <span className="text-gray-500">Online Payments Applied</span>
                                    <span className="font-medium text-green-600">-{formatCurrency(summary.gatewayPaymentCredit)}</span>
                                </div>
                                <div className="flex items-center justify-between px-4 py-2.5 bg-emerald-50/50">
                                    <span className="text-gray-600 font-medium">Payments Received (advance)</span>
                                    <span className="font-semibold text-green-700">-{formatCurrency(summary.advanceReceiptCredit)}</span>
                                </div>
                                <div className="flex items-center justify-between px-4 py-2.5 bg-emerald-50/50">
                                    <span className="text-gray-600 font-medium">Payments Received (against bills)</span>
                                    <span className="font-semibold text-green-700">-{formatCurrency(summary.invoiceReceiptCredit)}</span>
                                </div>
                                {summary.advanceBalance > 0 && (
                                    <div className="flex items-center justify-between px-4 py-2.5 bg-emerald-50">
                                        <span className="text-gray-700 font-semibold">Advance Balance</span>
                                        <span className="font-bold text-green-700">{formatCurrency(summary.advanceBalance)}</span>
                                    </div>
                                )}
                                <div className="flex items-center justify-between px-4 py-2 text-xs text-gray-400">
                                    <span>Of which not yet billed: {formatCurrency(summary.openOrderAmount)}</span>
                                    <span>On outstanding bills: {formatCurrency(summary.outstandingInvoiceAmount)}</span>
                                </div>
                            </div>

                            {/* Record a receipt */}
                            <form onSubmit={handleRecord} className="rounded-lg border border-gray-200 p-4 space-y-4">
                                <div>
                                    <h3 className="font-semibold text-gray-900">Record Payment Received</h3>
                                    <p className="text-sm text-gray-500">
                                        Money collected from this account at the lab, not tied to a particular bill. Adds to their
                                        available credit and shows up in Billing as a received payment — the partner portal and order
                                        form pick it up immediately.
                                    </p>
                                    <p className="text-sm text-amber-700 mt-1">
                                        Paying off a specific invoice? Use Billing → B2B Accounts → Receive Payment instead, so the
                                        bill is marked paid at the same time.
                                    </p>
                                </div>

                                <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                                    <div>
                                        <label className="block text-sm font-medium text-gray-700 mb-1">Amount (₹) *</label>
                                        <input
                                            type="number"
                                            min="0"
                                            step="0.01"
                                            value={amount}
                                            onChange={(e) => setAmount(e.target.value)}
                                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                                            placeholder="0.00"
                                            required
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-sm font-medium text-gray-700 mb-1">Mode</label>
                                        <select
                                            value={paymentMode}
                                            onChange={(e) => setPaymentMode(e.target.value as AccountPaymentMode)}
                                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                                        >
                                            {ACCOUNT_PAYMENT_MODES.map((mode) => (
                                                <option key={mode.value} value={mode.value}>{mode.label}</option>
                                            ))}
                                        </select>
                                    </div>
                                    <div>
                                        <label className="block text-sm font-medium text-gray-700 mb-1">
                                            Reference / Cheque No.
                                        </label>
                                        <input
                                            type="text"
                                            value={referenceNo}
                                            onChange={(e) => setReferenceNo(e.target.value)}
                                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                                            placeholder="Optional"
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-sm font-medium text-gray-700 mb-1">Received On</label>
                                        <input
                                            type="date"
                                            value={receivedOn}
                                            onChange={(e) => setReceivedOn(e.target.value)}
                                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                                        />
                                    </div>
                                </div>

                                <div>
                                    <label className="block text-sm font-medium text-gray-700 mb-1">Remarks</label>
                                    <input
                                        type="text"
                                        value={remarks}
                                        onChange={(e) => setRemarks(e.target.value)}
                                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                                        placeholder="e.g. Collected by field executive"
                                    />
                                </div>

                                <div className="flex justify-end">
                                    <button
                                        type="submit"
                                        disabled={saving}
                                        className="px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-60 flex items-center gap-2"
                                    >
                                        {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                                        {saving ? 'Recording...' : 'Record Payment'}
                                    </button>
                                </div>
                            </form>

                            {/* History */}
                            <div>
                                <h3 className="font-semibold text-gray-900 mb-2">Receipt History</h3>
                                {receipts.length === 0 ? (
                                    <div className="rounded-lg border border-dashed border-gray-300 py-8 text-center text-sm text-gray-500">
                                        No payments recorded for this account yet.
                                    </div>
                                ) : (
                                    <div className="rounded-lg border border-gray-200 overflow-hidden">
                                        <table className="min-w-full divide-y divide-gray-200 text-sm">
                                            <thead className="bg-gray-50">
                                                <tr>
                                                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Received On</th>
                                                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Mode</th>
                                                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Applied To</th>
                                                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Reference</th>
                                                    <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">Amount</th>
                                                    <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">Action</th>
                                                </tr>
                                            </thead>
                                            <tbody className="divide-y divide-gray-100">
                                                {receipts.map((receipt) => (
                                                    <tr key={receipt.id} className={receipt.isReversed ? 'bg-gray-50 text-gray-400' : ''}>
                                                        <td className="px-4 py-2.5">
                                                            <div>{formatDate(receipt.receivedOn || receipt.createdAt)}</div>
                                                            {receipt.remarks && (
                                                                <div className="text-xs text-gray-400">{receipt.remarks}</div>
                                                            )}
                                                        </td>
                                                        <td className="px-4 py-2.5 capitalize">{modeLabel(receipt.paymentMode)}</td>
                                                        <td className="px-4 py-2.5">
                                                            {receipt.linkedInvoiceId ? (
                                                                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700">
                                                                    Invoice
                                                                </span>
                                                            ) : (
                                                                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600">
                                                                    Advance
                                                                </span>
                                                            )}
                                                        </td>
                                                        <td className="px-4 py-2.5">{receipt.referenceNo || '-'}</td>
                                                        <td className={`px-4 py-2.5 text-right font-medium ${receipt.isReversed ? 'line-through' : 'text-green-700'}`}>
                                                            {formatCurrency(receipt.amount)}
                                                        </td>
                                                        <td className="px-4 py-2.5 text-right">
                                                            {receipt.isReversed ? (
                                                                <span
                                                                    className="text-xs text-gray-500"
                                                                    title={receipt.reversalReason || undefined}
                                                                >
                                                                    Voided
                                                                </span>
                                                            ) : !receipt.canVoid ? (
                                                                <span className="text-xs text-gray-400" title="Correct this from Billing, where the invoice status lives">
                                                                    Via Billing
                                                                </span>
                                                            ) : (
                                                                <button
                                                                    onClick={() => handleVoid(receipt)}
                                                                    disabled={voidingId === receipt.id}
                                                                    className="text-red-600 hover:text-red-800 disabled:opacity-50 inline-flex items-center gap-1 text-xs"
                                                                    title="Void this receipt"
                                                                >
                                                                    {voidingId === receipt.id ? (
                                                                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                                                    ) : (
                                                                        <Undo2 className="w-3.5 h-3.5" />
                                                                    )}
                                                                    Void
                                                                </button>
                                                            )}
                                                        </td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                )}
                            </div>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
};

export default AccountCreditModal;
