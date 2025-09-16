import React, { useState, useEffect } from 'react';
import { X, Check } from 'lucide-react';
import { database } from '../../utils/supabase';

interface Payment {
  id: string;
  amount: number;
  payment_method: 'cash' | 'card' | 'upi' | 'bank' | 'credit_adjustment';
  payment_reference?: string | null;
  payment_date: string;
  location_id?: string | null;
  account_id?: string | null;
  created_at: string;
}

interface PaymentCaptureProps {
  invoiceId: string;
  onClose: () => void;
  onSuccess: () => void;
}

const PaymentCapture: React.FC<PaymentCaptureProps> = ({ invoiceId, onClose, onSuccess }) => {
  const [loading, setLoading] = useState(true);
  const [invoice, setInvoice] = useState<any>(null); // Use any for now to avoid type issues
  const [payments, setPayments] = useState<Payment[]>([]);
  const [processing, setProcessing] = useState(false);

  // Display bill-to label - simplified for now
  const billTo = { kind: 'Self', name: '' };

  // Payment form state
  const [amount, setAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'card' | 'upi' | 'bank'>('cash');
  const [paymentReference, setPaymentReference] = useState('');
  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().split('T')[0]);
  const [notes, setNotes] = useState('');

  useEffect(() => {
    loadInvoiceAndPayments();
  }, [invoiceId]);

  const loadInvoiceAndPayments = async () => {
    try {
      setLoading(true);
      const { data: invoiceData, error: invoiceError } = await database.invoices.getById(invoiceId);
      if (invoiceError) throw invoiceError;
      setInvoice(invoiceData as any);

      const { data: paymentsData, error: paymentsError } = await database.payments.getByInvoiceId(invoiceId);
      if (paymentsError) throw paymentsError;
      setPayments((paymentsData as any[]) || []);

      if (invoiceData) {
        const totalPaid = (paymentsData || []).reduce((sum: number, p: any) => sum + (p.amount || 0), 0);
        const remaining = (invoiceData.total_after_discount || invoiceData.total) - totalPaid;
        setAmount(Math.max(0, remaining).toString());
      }
    } catch (err) {
      console.error('Error loading invoice/payments', err);
      alert('Failed to load invoice details');
    } finally {
      setLoading(false);
    }
  };

  const totalPaid = payments.reduce((sum, p) => sum + p.amount, 0);
  const invoiceTotal = (invoice?.total_after_discount ?? invoice?.total ?? 0);
  const balance = invoiceTotal - totalPaid;
  const isFullyPaid = balance <= 0.0001;

  const methodChoices: Payment['payment_method'][] = ['cash', 'card', 'upi', 'bank'];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const amt = parseFloat(amount);
    if (Number.isNaN(amt) || amt <= 0) {
      alert('Please enter a valid amount');
      return;
    }
    if (amt > balance) {
      alert(`Payment amount cannot exceed balance of ₹${balance.toFixed(2)}`);
      return;
    }
    if (paymentMethod !== 'cash' && !paymentReference) {
      alert('Please enter a payment reference for non-cash payments');
      return;
    }

    setProcessing(true);
    try {
      const payload = {
        invoice_id: invoiceId,
        amount: amt,
        payment_method: paymentMethod,
        payment_reference: paymentReference || null,
        payment_date: paymentDate,
        location_id: paymentMethod === 'cash' ? (invoice?.location_id ?? null) : null,
        notes: notes || null,
      };

      const { error } = await database.payments.create(payload as any);
      if (error) throw error;

      alert('Payment recorded successfully');
      onSuccess();
    } catch (err) {
      console.error('Error recording payment', err);
      alert('Failed to record payment. Please try again.');
    } finally {
      setProcessing(false);
    }
  };

  if (loading || !invoice) {
    return (
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
        <div className="bg-white rounded-lg p-6">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 w-full max-w-3xl max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-2xl font-bold text-gray-900">Record Payment</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="w-6 h-6" />
          </button>
        </div>

        {/* Invoice Summary */}
        <div className="bg-gray-50 p-4 rounded-lg mb-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <div className="text-sm text-gray-600">Invoice #</div>
              <div className="font-medium">{invoice.id.slice(0, 8)}</div>
            </div>
            <div>
              <div className="text-sm text-gray-600">Patient</div>
              <div className="font-medium">{invoice.patient_name}</div>
            </div>
            <div>
              <div className="text-sm text-gray-600">Invoice Amount</div>
              <div className="font-medium">₹{invoiceTotal.toFixed(2)}</div>
            </div>
            <div>
              <div className="text-sm text-gray-600">Payment Type</div>
              <div className="font-medium capitalize">{invoice.payment_type || 'self'}</div>
            </div>
          </div>

          {/* NEW: Bill-To badge */}
          <div className="mt-3 text-sm">
            <span className="text-gray-600 mr-1">Bill To:</span>
            <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-blue-100 text-blue-800">
              {billTo.kind}
              {billTo.name ? ` • ${billTo.name}` : ''}
            </span>
          </div>
        </div>

        {/* Payment Progress */}
        <div className="mb-6">
          <div className="flex justify-between mb-2">
            <span className="text-sm font-medium text-gray-700">Payment Progress</span>
            <span className="text-sm text-gray-500">₹{totalPaid.toFixed(2)} / ₹{invoiceTotal.toFixed(2)}</span>
          </div>
          <div className="w-full bg-gray-200 rounded-full h-2">
            <div
              className={`h-2 rounded-full transition-all ${isFullyPaid ? 'bg-green-600' : 'bg-blue-600'}`}
              style={{ width: `${Math.min(100, (totalPaid / invoiceTotal) * 100)}%` }}
            />
          </div>
          <div className="mt-2 text-right">
            <span className={`text-sm font-medium ${isFullyPaid ? 'text-green-600' : 'text-orange-600'}`}>
              Balance: ₹{Math.max(0, balance).toFixed(2)}
            </span>
          </div>
        </div>

        {/* Payment History */}
        {payments.length > 0 && (
          <div className="mb-6">
            <h3 className="text-lg font-medium mb-3">Payment History</h3>
            <div className="space-y-2">
              {payments.map((p) => (
                <div key={p.id} className="bg-gray-50 p-3 rounded-lg flex justify-between items-center">
                  <div>
                    <div className="font-medium">₹{p.amount.toFixed(2)}</div>
                    <div className="text-sm text-gray-600">
                      {p.payment_method.toUpperCase()}
                      {p.payment_reference ? ` • ${p.payment_reference}` : ''}
                      {p.account_id && ' • Account Adj.'}
                      {p.location_id && ' • Cash @ Location'}
                    </div>
                  </div>
                  <div className="text-sm text-gray-500">{new Date(p.payment_date).toLocaleDateString()}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Payment Form (with credit_adjustment option when account-billed) */}
        {!isFullyPaid && (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Amount *</label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">₹</span>
                  <input
                    type="number"
                    required
                    min="0.01"
                    max={balance}
                    step="0.01"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    className="w-full pl-8 pr-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="0.00"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Payment Date *</label>
                <input
                  type="date"
                  required
                  value={paymentDate}
                  max={new Date().toISOString().split('T')[0]}
                  onChange={(e) => setPaymentDate(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Payment Method *</label>
              <div className="grid grid-cols-4 gap-2">
                {methodChoices.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setPaymentMethod(m as any)}
                    className={`px-3 py-2 rounded-md text-sm font-medium border ${
                      paymentMethod === m ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                    }`}
                  >
                    {m.replace('_', ' ').toUpperCase()}
                  </button>
                ))}
              </div>
            </div>

            {paymentMethod !== 'cash' && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Reference Number *</label>
                <input
                  type="text"
                  required
                  value={paymentReference}
                  onChange={(e) => setPaymentReference(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder={
                    paymentMethod === 'card' ? 'Transaction ID' : paymentMethod === 'upi' ? 'UPI Reference' : 'Bank Reference'
                  }
                />
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Notes (Optional)</label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="Add any notes about this payment..."
              />
            </div>

            <div className="flex justify-end gap-3 pt-4 border-t">
              <button type="button" onClick={onClose} className="px-4 py-2 text-gray-700 bg-gray-100 rounded-md hover:bg-gray-200" disabled={processing}>
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
                disabled={processing}
              >
                {processing ? <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" /> : <Check className="w-4 h-4" />}
                {processing ? 'Processing...' : 'Record Payment'}
              </button>
            </div>
          </form>
        )}

        {/* Fully Paid Message */}
        {isFullyPaid && (
          <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-center">
            <div className="text-green-600 mb-2">
              <Check className="w-12 h-12 mx-auto" />
            </div>
            <h3 className="text-lg font-medium text-green-900">Invoice Fully Paid</h3>
            <p className="text-sm text-green-700 mt-1">This invoice has been fully paid. No further payments are required.</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default PaymentCapture;