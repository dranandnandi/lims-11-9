import React, { useState } from 'react';
import { X, Save } from 'lucide-react';
import { database } from '../../utils/supabase';
import { recordAccountCashReceipt, AccountPaymentMode } from '../../utils/accountCredit';

interface ReceivePaymentModalProps {
    accountId: string;
    accountName: string;
    currentBalance?: number;
    totalAmount?: number;
    paidAmount?: number;
    consolidatedInvoiceId?: string;
    onClose: () => void;
    onSuccess: () => void;
}

const ReceivePaymentModal: React.FC<ReceivePaymentModalProps> = ({
    accountId,
    accountName,
    currentBalance = 0,
    totalAmount,
    paidAmount = 0,
    consolidatedInvoiceId,
    onClose,
    onSuccess
}) => {
    const [amount, setAmount] = useState<string>('');
    const [paymentDate, setPaymentDate] = useState(new Date().toISOString().split('T')[0]);
    const [paymentMethod, setPaymentMethod] = useState('neft');
    const [reference, setReference] = useState('');
    const [notes, setNotes] = useState('');
    const [loading, setLoading] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!amount || parseFloat(amount) <= 0) return;

        setLoading(true);
        try {
            const paymentAmount = parseFloat(amount);

            // Single entry point shared with Account Master: writes the
            // credit_transactions billing record AND the b2b_credit_ledger entry
            // that frees the account's credit, in one transaction. Recording the
            // payment in only one of the two is what used to double-count it.
            await recordAccountCashReceipt({
                accountId,
                amount: paymentAmount,
                paymentMode: paymentMethod as AccountPaymentMode,
                referenceNo: reference,
                receivedOn: paymentDate,
                remarks: notes,
                consolidatedInvoiceId: consolidatedInvoiceId || null,
            });

            // Consolidated B2B invoices are tracked in a separate table, so
            // we need an explicit status update when the payment is tied to one.
            if (consolidatedInvoiceId) {
                const normalizedTotal = Number(totalAmount ?? currentBalance) || 0;
                const newPaidAmount = (Number(paidAmount) || 0) + paymentAmount;
                const newStatus = newPaidAmount >= normalizedTotal ? 'paid' : 'partial';

                const { error: invoiceError } = await (database as any).consolidatedInvoices?.update?.(
                    consolidatedInvoiceId,
                    {
                        status: newStatus,
                        paid_at: newStatus === 'paid' ? new Date().toISOString() : null,
                    }
                );

                if (invoiceError) throw invoiceError;
            }

            onSuccess();
            onClose();
        } catch (error: any) {
            console.error('Error recording payment:', error);
            alert(error?.message || 'Failed to record payment');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
            <div className="bg-white rounded-lg p-6 w-full max-w-md">
                <div className="flex justify-between items-center mb-6">
                    <h2 className="text-xl font-bold text-gray-900">Receive Payment</h2>
                    <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
                        <X className="w-6 h-6" />
                    </button>
                </div>

                <div className="mb-6 bg-blue-50 p-4 rounded-lg">
                    <div className="text-sm text-gray-600">Account</div>
                    <div className="font-medium text-lg text-blue-900">{accountName}</div>
                    {totalAmount !== undefined && (
                        <div className="mt-1 flex justify-between text-sm">
                            <span className="text-gray-600">Invoice Total:</span>
                            <span className="font-semibold">₹{totalAmount.toFixed(2)}</span>
                        </div>
                    )}
                    {paidAmount > 0 && (
                        <div className="mt-1 flex justify-between text-sm">
                            <span className="text-gray-600">Paid Amount:</span>
                            <span className="font-semibold text-green-700">₹{paidAmount.toFixed(2)}</span>
                        </div>
                    )}
                    {currentBalance !== undefined && (
                        <div className="mt-2 flex justify-between text-sm">
                            <span className="text-gray-600">Current Due:</span>
                            <span className="font-bold">₹{currentBalance.toFixed(2)}</span>
                        </div>
                    )}
                </div>

                <form onSubmit={handleSubmit} className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Payment Amount</label>
                        <div className="relative">
                            <span className="absolute left-3 top-2 text-gray-500">₹</span>
                            <input
                                type="number"
                                step="0.01"
                                min="0"
                                required
                                value={amount}
                                onChange={(e) => setAmount(e.target.value)}
                                className="w-full pl-8 pr-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500"
                                placeholder="0.00"
                            />
                        </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">Date</label>
                            <input
                                type="date"
                                required
                                value={paymentDate}
                                onChange={(e) => setPaymentDate(e.target.value)}
                                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500"
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">Method</label>
                            <select
                                value={paymentMethod}
                                onChange={(e) => setPaymentMethod(e.target.value)}
                                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500"
                            >
                                <option value="cash">Cash</option>
                                <option value="neft">NEFT / RTGS</option>
                                <option value="cheque">Cheque</option>
                                <option value="upi">UPI</option>
                                <option value="card">Card</option>
                            </select>
                        </div>
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Reference No.</label>
                        <input
                            type="text"
                            value={reference}
                            onChange={(e) => setReference(e.target.value)}
                            placeholder="Cheque No, Transaction ID, etc."
                            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500"
                        />
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                        <textarea
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                            rows={2}
                            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500"
                        />
                    </div>

                    <div className="flex justify-end gap-3 pt-4 border-t">
                        <button
                            type="button"
                            onClick={onClose}
                            className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50"
                        >
                            Cancel
                        </button>
                        <button
                            type="submit"
                            disabled={loading}
                            className="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 flex items-center gap-2 disabled:opacity-50"
                        >
                            {loading ? 'Processing...' : <><Save className="w-4 h-4" /> Record Payment</>}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
};

export default ReceivePaymentModal;
