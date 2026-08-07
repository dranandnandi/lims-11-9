import React, { useState, useEffect } from 'react';
import { X, Check, FileText } from 'lucide-react';
import { database } from '../../utils/supabase';
import OnlinePaymentQR from './OnlinePaymentQR';

interface Payment {
  id: string;
  amount: number;
  payment_method: 'cash' | 'card' | 'upi' | 'bank' | 'online' | 'credit_adjustment';
  payment_reference?: string | null;
  payment_date: string;
  location_id?: string | null;
  account_id?: string | null;
  created_at: string;
  invoice_id?: string;
}

interface PaymentCaptureProps {
  invoiceId?: string;  // Single invoice mode
  orderId?: string;    // Multi-invoice mode - fetches all invoices for order
  onClose: () => void;
  onSuccess: () => void;
}

const PaymentCapture: React.FC<PaymentCaptureProps> = ({ invoiceId, orderId, onClose, onSuccess }) => {
  const [loading, setLoading] = useState(true);
  const [invoices, setInvoices] = useState<any[]>([]); // All invoices for the order
  const [primaryInvoice, setPrimaryInvoice] = useState<any>(null); // Most recent invoice for display
  const [payments, setPayments] = useState<Payment[]>([]);
  const [processing, setProcessing] = useState(false);
  const [selectedInvoiceId, setSelectedInvoiceId] = useState<string>(''); // Which invoice to record payment against

  // Display bill-to label - simplified for now
  const billTo = { kind: 'Self', name: '' };

  // Payment form state
  const [amount, setAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'card' | 'upi' | 'bank' | 'online'>('cash');
  const [paymentReference, setPaymentReference] = useState('');
  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().split('T')[0]);
  const [notes, setNotes] = useState('');
  const [onlineAmount, setOnlineAmount] = useState(0);

  useEffect(() => {
    loadInvoiceAndPayments();
  }, [invoiceId, orderId]);

  const loadInvoiceAndPayments = async () => {
    try {
      setLoading(true);
      
      let allInvoices: any[] = [];
      let allPayments: Payment[] = [];
      
      if (orderId) {
        // Multi-invoice mode: fetch ALL invoices for this order
        const { data: invoicesData, error: invoicesError } = await database.invoices.getAllByOrderId(orderId);
        if (invoicesError) throw invoicesError;
        allInvoices = invoicesData || [];
        
        // Fetch payments for each invoice
        for (const inv of allInvoices) {
          const { data: invPayments } = await database.payments.getByInvoiceId(inv.id);
          if (invPayments) {
            allPayments.push(...(invPayments as Payment[]).map(p => ({ ...p, invoice_id: inv.id })));
          }
        }
      } else if (invoiceId) {
        // Single invoice mode
        const { data: invoiceData, error: invoiceError } = await database.invoices.getById(invoiceId);
        if (invoiceError) throw invoiceError;
        if (invoiceData) allInvoices = [invoiceData];
        
        const { data: paymentsData } = await database.payments.getByInvoiceId(invoiceId);
        allPayments = (paymentsData as Payment[]) || [];
      }
      
      setInvoices(allInvoices);
      setPrimaryInvoice(allInvoices[0] || null);
      setPayments(allPayments);
      
      // Default to the invoice with highest remaining balance
      if (allInvoices.length > 0) {
        // Find invoice with most remaining balance
        let bestInvoice = allInvoices[0];
        let maxBalance = 0;
        
        for (const inv of allInvoices) {
          const invPayments = allPayments.filter(p => p.invoice_id === inv.id);
          const invPaid = invPayments.reduce((sum, p) => sum + (p.amount || 0), 0);
          const invTotal = inv.total_after_discount || inv.total || 0;
          const invBalance = invTotal - invPaid;
          if (invBalance > maxBalance) {
            maxBalance = invBalance;
            bestInvoice = inv;
          }
        }
        
        setSelectedInvoiceId(bestInvoice.id);
        setAmount(Math.max(0, maxBalance).toString());
      }
    } catch (err) {
      console.error('Error loading invoice/payments', err);
      alert('Failed to load invoice details');
    } finally {
      setLoading(false);
    }
  };

  // Aggregate totals across all invoices
  const totalInvoiced = invoices.reduce((sum, inv) => sum + (inv.total_after_discount || inv.total || 0), 0);
  const totalPaid = payments.reduce((sum, p) => sum + p.amount, 0);
  const totalBalance = totalInvoiced - totalPaid;
  const isFullyPaid = totalBalance <= 0.0001;

  // Get balance for selected invoice
  const getInvoiceBalance = (invId: string) => {
    const inv = invoices.find(i => i.id === invId);
    if (!inv) return 0;
    const invPayments = payments.filter(p => p.invoice_id === invId);
    const invPaid = invPayments.reduce((sum, p) => sum + (p.amount || 0), 0);
    return (inv.total_after_discount || inv.total || 0) - invPaid;
  };

  // 'online' hands off to the gateway (QR / pay link) instead of recording a
  // reference by hand — the webhook writes the payments row on confirmation.
  const methodChoices: Payment['payment_method'][] = ['cash', 'card', 'upi', 'bank', 'online'];

  const isOnline = paymentMethod === 'online';

  // Snapshot the amount when Online is picked. Reading `amount` live would mint a
  // fresh payment link on every keystroke.
  const resolveOnlineAmount = () => {
    const parsed = parseFloat(amount);
    return !Number.isNaN(parsed) && parsed > 0 ? parsed : getInvoiceBalance(selectedInvoiceId);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const amt = parseFloat(amount);
    if (Number.isNaN(amt) || amt <= 0) {
      alert('Please enter a valid amount');
      return;
    }

    const selectedBalance = getInvoiceBalance(selectedInvoiceId);
    if (amt > selectedBalance + 0.01) {
      alert(`Payment amount cannot exceed invoice balance of ₹${selectedBalance.toFixed(2)}`);
      return;
    }
    if (paymentMethod !== 'cash' && !paymentReference) {
      alert('Please enter a payment reference for non-cash payments');
      return;
    }

    setProcessing(true);
    try {
      const selectedInvoice = invoices.find(i => i.id === selectedInvoiceId);
      const payload = {
        invoice_id: selectedInvoiceId,
        amount: amt,
        payment_method: paymentMethod,
        payment_reference: paymentReference || null,
        payment_date: paymentDate,
        location_id: paymentMethod === 'cash' ? (selectedInvoice?.location_id ?? null) : null,
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

  if (loading || invoices.length === 0) {
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

        {/* Invoice Summary - show all invoices if multiple */}
        <div className="bg-gray-50 p-4 rounded-lg mb-6">
          {invoices.length > 1 && (
            <div className="mb-3 pb-3 border-b border-gray-200">
              <div className="flex items-center gap-2 text-sm text-blue-700 bg-blue-50 px-3 py-2 rounded-lg">
                <FileText className="w-4 h-4" />
                <span className="font-medium">This order has {invoices.length} invoices (tests added after initial billing)</span>
              </div>
            </div>
          )}
          
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <div className="text-sm text-gray-600">{invoices.length > 1 ? 'Invoices' : 'Invoice #'}</div>
              <div className="font-medium">
                {invoices.length > 1 
                  ? invoices.map(inv => inv.invoice_number || inv.id.slice(0, 8)).join(', ')
                  : (primaryInvoice?.invoice_number || primaryInvoice?.id?.slice(0, 8))
                }
              </div>
            </div>
            <div>
              <div className="text-sm text-gray-600">Patient</div>
              <div className="font-medium">{primaryInvoice?.patient_name}</div>
            </div>
            <div>
              <div className="text-sm text-gray-600">{invoices.length > 1 ? 'Total Amount' : 'Invoice Amount'}</div>
              <div className="font-medium text-lg">
                <span className="text-green-600 font-bold">₹{totalInvoiced.toFixed(2)}</span>
                {invoices.length > 1 && (
                  <span className="text-xs text-gray-500 block">
                    ({invoices.map(inv => `₹${(inv.total_after_discount || inv.total || 0).toFixed(0)}`).join(' + ')})
                  </span>
                )}
              </div>
            </div>
            <div>
              <div className="text-sm text-gray-600">Payment Type</div>
              <div className="font-medium capitalize">{primaryInvoice?.payment_type || 'self'}</div>
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

        {/* Payment Progress - shows total across all invoices */}
        <div className="mb-6">
          <div className="flex justify-between mb-2">
            <span className="text-sm font-medium text-gray-700">Payment Progress</span>
            <span className="text-sm text-gray-500">₹{totalPaid.toFixed(2)} / ₹{totalInvoiced.toFixed(2)}</span>
          </div>
          <div className="w-full bg-gray-200 rounded-full h-2">
            <div
              className={`h-2 rounded-full transition-all ${isFullyPaid ? 'bg-green-600' : 'bg-blue-600'}`}
              style={{ width: `${Math.min(100, (totalPaid / totalInvoiced) * 100)}%` }}
            />
          </div>
          <div className="mt-2 text-right">
            <span className={`text-sm font-medium ${isFullyPaid ? 'text-green-600' : 'text-orange-600'}`}>
              Balance: ₹{Math.max(0, totalBalance).toFixed(2)}
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
            {/* Invoice Selector - only show when multiple invoices */}
            {invoices.length > 1 && (
              <div className="mb-4 p-3 bg-yellow-50 rounded-lg border border-yellow-200">
                <label className="block text-sm font-medium text-gray-700 mb-2">Select Invoice to Pay *</label>
                <select
                  value={selectedInvoiceId}
                  onChange={(e) => setSelectedInvoiceId(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {invoices.map(inv => {
                    const invBalance = getInvoiceBalance(inv.id);
                    return (
                      <option key={inv.id} value={inv.id} disabled={invBalance <= 0}>
                        {inv.invoice_number || inv.id.slice(0, 8)} - ₹{(inv.total_after_discount || inv.total || 0).toFixed(2)} 
                        {invBalance > 0 ? ` (Balance: ₹${invBalance.toFixed(2)})` : ' (Paid)'}
                      </option>
                    );
                  })}
                </select>
                <p className="text-xs text-gray-500 mt-1">
                  Payment will be recorded against the selected invoice. Balance for selected: ₹{getInvoiceBalance(selectedInvoiceId).toFixed(2)}
                </p>
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Amount *</label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">₹</span>
                  <input
                    type="number"
                    required
                    min="0.01"
                    max={getInvoiceBalance(selectedInvoiceId)}
                    step="0.01"
                    value={isOnline ? onlineAmount.toFixed(2) : amount}
                    disabled={isOnline}
                    onChange={(e) => setAmount(e.target.value)}
                    className="w-full pl-8 pr-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
                    placeholder="0.00"
                  />
                </div>
                {isOnline && (
                  <p className="text-xs text-gray-500 mt-1">
                    Locked to the amount on the payment link. Switch method to change it.
                  </p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Payment Date *</label>
                <input
                  type="date"
                  required
                  value={paymentDate}
                  max={new Date().toISOString().split('T')[0]}
                  disabled={isOnline}
                  onChange={(e) => setPaymentDate(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Payment Method *</label>
              <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
                {methodChoices.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => {
                      if (m === 'online') setOnlineAmount(resolveOnlineAmount());
                      setPaymentMethod(m as any);
                    }}
                    className={`px-3 py-2 rounded-md text-sm font-medium border ${paymentMethod === m ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                      }`}
                  >
                    {m.replace('_', ' ').toUpperCase()}
                  </button>
                ))}
              </div>
            </div>

            {isOnline ? (
              /* Gateway collection: the QR / pay link replaces manual entry, and
                 the payments row is written server-side on confirmation. */
              <OnlinePaymentQR
                labId={primaryInvoice?.lab_id}
                invoiceId={selectedInvoiceId}
                patientId={primaryInvoice?.patient_id}
                amount={onlineAmount}
                payerName={primaryInvoice?.patient_name}
                invoiceNumber={
                  invoices.find((i) => i.id === selectedInvoiceId)?.invoice_number ||
                  primaryInvoice?.invoice_number
                }
                onPaid={() => onSuccess()}
                onCancel={() => setPaymentMethod('cash')}
              />
            ) : (
              <>
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
              </>
            )}
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