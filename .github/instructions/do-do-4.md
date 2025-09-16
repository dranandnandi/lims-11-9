Here’s **Phase 4** rewritten **without omitting anything** from your original, and expanded to include the **Account** layer (bill-to entity that can be an Account or a Location). I’ve preserved all sections and code you already had, only adding/modifying where needed to support Accounts.

> Based on your original Phase 4 draft for Billing (Payment Capture, Cash Reconciliation, Billing page, Dashboard hook, and App route).&#x20;

---

# Phase 4: Billing Components (Week 2 Day 4–5) — **Revised with Account Layer**

## 4.1 Add/extend API methods in `supabase.ts`

> (Keeps your `orderTests` and `invoiceItems` helpers and **adds** missing helpers used by the components, plus Account-aware fetchers.)

```ts
// ...existing imports and supabase init...

export const database = {
  // --- Existing helpers you had ---
  orderTests: {
    getUnbilledByOrder: async (orderId: string) => {
      const labId = await database.getCurrentUserLabId();
      const { data: order } = await supabase
        .from('orders')
        .select('lab_id')
        .eq('id', orderId)
        .single();
      if (order?.lab_id !== labId) return { data: null, error: new Error('Unauthorized') };

      return supabase
        .from('order_tests')
        .select('*')
        .eq('order_id', orderId)
        .eq('is_billed', false);
    },

    markAsBilled: async (testIds: string[], invoiceId: string, billedAmounts: Record<string, number>) => {
      const updates = testIds.map((id) => ({
        id,
        is_billed: true,
        invoice_id: invoiceId,
        billed_at: new Date().toISOString(),
        billed_amount: billedAmounts[id],
      }));
      return supabase.from('order_tests').upsert(updates);
    },
  },

  invoiceItems: {
    create: async (items: any[]) => supabase.from('invoice_items').insert(items),
    getByInvoice: async (invoiceId: string) =>
      supabase.from('invoice_items').select('*').eq('invoice_id', invoiceId).order('created_at'),
  },

  // --- NEW: Account-aware invoice helpers used by Billing page/PaymentCapture ---
  invoices: {
    getById: async (id: string) =>
      supabase
        .from('invoices')
        .select('*, locations(name), accounts(name)')
        .eq('id', id)
        .single(),

    getAll: async () =>
      supabase
        .from('invoices')
        .select('*, locations(name), accounts(name)')
        .order('created_at', { ascending: false }),

    getByStatus: async (status: 'Unpaid' | 'Paid' | 'Partial') =>
      supabase
        .from('invoices')
        .select('*, locations(name), accounts(name)')
        .eq('status', status)
        .order('created_at', { ascending: false }),
  },

  // --- NEW: Payments (used by PaymentCapture & CashReconciliation) ---
  payments: {
    create: async (payload: {
      invoice_id: string;
      amount: number;
      payment_method: 'cash' | 'card' | 'upi' | 'bank' | 'credit_adjustment';
      payment_reference?: string | null;
      payment_date: string; // YYYY-MM-DD
      location_id?: string | null;
      account_id?: string | null;
      notes?: string | null;
    }) => supabase.from('payments').insert(payload).single(),

    getByInvoice: async (invoiceId: string) =>
      supabase.from('payments').select('*').eq('invoice_id', invoiceId).order('created_at'),

    // For Cash Reconciliation (cash-only, date + location)
    getByDateRange: async (fromDate: string, toDate: string, locationId: string) =>
      supabase
        .from('payments')
        .select('*, invoices(patient_name)')
        .eq('payment_method', 'cash')
        .eq('location_id', locationId)
        .gte('payment_date', fromDate)
        .lte('payment_date', toDate)
        .order('created_at'),
  },

  // --- NEW: Accounts master (reads; credit checks were added in earlier phases) ---
  accounts: {
    getAll: async () =>
      supabase.from('accounts').select('*').eq('is_active', true).order('name'),
    getById: async (id: string) => supabase.from('accounts').select('*').eq('id', id).single(),
    // Optional: verify if credit is available before allowing credit_adjustment
    checkCreditLimit: async (accountId: string) => {
      // Implement on your side if needed (running balance, limit, allowed flag)
      return { allowed: true, currentBalance: 0, creditLimit: 0, availableCredit: 0, name: '' };
    },
  },

  // --- Cash Register helpers used by CashReconciliation ---
  cashRegister: {
    getOrCreate: async (date: string, locationId: string, shift: 'morning' | 'afternoon' | 'night' | 'full_day') => {
      const labId = await database.getCurrentUserLabId();
      const { data, error } = await supabase
        .from('cash_register')
        .select('*')
        .eq('lab_id', labId)
        .eq('register_date', date)
        .eq('location_id', locationId)
        .eq('shift', shift)
        .maybeSingle();

      if (error) return { data: null, error };
      if (data) return { data, error: null };

      const { data: created, error: insertErr } = await supabase
        .from('cash_register')
        .insert({
          lab_id: labId,
          register_date: date,
          location_id: locationId,
          shift,
          opening_balance: 0,
          system_amount: 0,
        })
        .select('*')
        .single();
      return { data: created, error: insertErr };
    },

    update: async (id: string, patch: Partial<{ system_amount: number }>) =>
      supabase.from('cash_register').update(patch).eq('id', id),

    reconcile: async (id: string, actualAmount: number, notes?: string) =>
      supabase
        .from('cash_register')
        .update({
          actual_amount: actualAmount,
          reconciled: true,
          notes: notes || null,
          reconciled_at: new Date().toISOString(),
        })
        .eq('id', id),
  },

  // ...rest of your database object...
};
```

---

## 4.2 **PaymentCapture** (Account-aware)

> (Preserves your original PaymentCapture structure; adds **Bill To** (Account/Location/Self), supports `credit_adjustment` for account-billed invoices, and writes `account_id` or `location_id` on the payment accordingly.)&#x20;

```tsx
import React, { useState, useEffect } from 'react';
import { X, CreditCard, Check } from 'lucide-react';
import { database } from '../../utils/supabase';
import type { Invoice } from '../../types';

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
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [processing, setProcessing] = useState(false);

  // NEW: display bill-to label
  const billTo =
    (invoice?.account_id && invoice?.accounts?.name && { kind: 'Account', name: invoice.accounts.name }) ||
    (invoice?.location_id && invoice?.locations?.name && { kind: 'Location', name: invoice.locations.name }) ||
    { kind: 'Self', name: '' };

  // Payment form state
  const [amount, setAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'card' | 'upi' | 'bank' | 'credit_adjustment'>('cash');
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

      const { data: paymentsData, error: paymentsError } = await database.payments.getByInvoice(invoiceId);
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

  const methodChoices: Payment['payment_method'][] =
    invoice?.account_id || invoice?.payment_type === 'corporate' || invoice?.payment_type === 'insurance'
      ? ['credit_adjustment', 'cash', 'card', 'upi', 'bank'] // allow adjustments + normal payments if needed
      : ['cash', 'card', 'upi', 'bank'];

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
    if (paymentMethod !== 'cash' && paymentMethod !== 'credit_adjustment' && !paymentReference) {
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
        // tie cash to location cash box; tie credit adjustment to the account
        location_id: paymentMethod === 'cash' ? (invoice?.location_id ?? null) : null,
        account_id: paymentMethod === 'credit_adjustment' ? (invoice?.account_id ?? null) : null,
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
              <div className="grid grid-cols-5 gap-2">
                {methodChoices.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setPaymentMethod(m)}
                    className={`px-3 py-2 rounded-md text-sm font-medium border ${
                      paymentMethod === m ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                    }`}
                  >
                    {m.replace('_', ' ').toUpperCase()}
                  </button>
                ))}
              </div>
              {paymentMethod === 'credit_adjustment' && (
                <p className="text-xs text-gray-500 mt-2">
                  This records an account-ledger adjustment (no cash). Use when the invoice is billed to an Account.
                </p>
              )}
            </div>

            {paymentMethod !== 'cash' && paymentMethod !== 'credit_adjustment' && (
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
```

---

## 4.3 **CashReconciliation** (unchanged logic; clarifies it aggregates cash by **location**)

> (Your structure retained; we ensure it only sums `payment_method='cash'` and `location_id=<selected>`, as your original narrative implied.)&#x20;

```tsx
import React, { useState, useEffect } from 'react';
import { DollarSign, AlertCircle, Calculator, Check } from 'lucide-react';
import { database } from '../../utils/supabase';
import type { Location } from '../../types';

type Shift = 'morning' | 'afternoon' | 'night' | 'full_day';

const CashReconciliation: React.FC = () => {
  const [locations, setLocations] = useState<Location[]>([]);
  const [selectedLocation, setSelectedLocation] = useState<string>('');
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split('T')[0]);
  const [shift, setShift] = useState<Shift>('full_day');
  const [loading, setLoading] = useState(false);
  const [register, setRegister] = useState<any>(null);
  const [payments, setPayments] = useState<any[]>([]);
  const [actualAmount, setActualAmount] = useState('');
  const [reconciliationNotes, setReconciliationNotes] = useState('');
  const [processing, setProcessing] = useState(false);

  useEffect(() => { loadLocations(); }, []);
  useEffect(() => { if (selectedLocation && selectedDate) loadRegisterData(); }, [selectedLocation, selectedDate, shift]);

  const loadLocations = async () => {
    try {
      const { data, error } = await database.locations.getAll();
      if (error) throw error;
      const cashLocations = (data || []).filter((l: any) => l.supports_cash_collection);
      setLocations(cashLocations);
      if (cashLocations.length === 1) setSelectedLocation(cashLocations[0].id);
    } catch (e) {
      console.error('Error loading locations:', e);
    }
  };

  const loadRegisterData = async () => {
    setLoading(true);
    try {
      const { data: reg, error } = await database.cashRegister.getOrCreate(selectedDate, selectedLocation, shift);
      if (error) throw error;
      setRegister(reg);

      if (reg.reconciled && reg.actual_amount !== null) {
        setActualAmount(String(reg.actual_amount));
        setReconciliationNotes(reg.notes || '');
      } else {
        setActualAmount('');
        setReconciliationNotes('');
      }

      const { data: cashPayments, error: payErr } = await database.payments.getByDateRange(
        selectedDate,
        selectedDate,
        selectedLocation
      );
      if (payErr) throw payErr;

      setPayments(cashPayments || []);

      if (!reg.reconciled) {
        const totalCash = (cashPayments || []).reduce((sum: number, p: any) => sum + (p.amount || 0), 0);
        const newSystemAmount = (reg.opening_balance || 0) + totalCash;
        await database.cashRegister.update(reg.id, { system_amount: newSystemAmount });
        setRegister({ ...reg, system_amount: newSystemAmount });
      }
    } catch (e) {
      console.error('Error loading register data:', e);
    } finally {
      setLoading(false);
    }
  };

  const handleReconcile = async () => {
    if (!register) return;
    const actual = parseFloat(actualAmount);
    if (Number.isNaN(actual) || actual < 0) {
      alert('Please enter a valid actual amount');
      return;
    }
    setProcessing(true);
    try {
      const { error } = await database.cashRegister.reconcile(register.id, actual, reconciliationNotes);
      if (error) throw error;
      alert('Cash register reconciled successfully');
      await loadRegisterData();
    } catch (e) {
      console.error('Error reconciling cash register:', e);
      alert('Failed to reconcile cash register');
    } finally {
      setProcessing(false);
    }
  };

  const formatCurrency = (n: number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(n);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Cash Reconciliation</h1>
        <p className="text-gray-600 mt-1">Reconcile daily cash collections by location</p>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Location</label>
            <select
              value={selectedLocation}
              onChange={(e) => setSelectedLocation(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              required
            >
              <option value="">Select Location</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Date</label>
            <input
              type="date"
              value={selectedDate}
              max={new Date().toISOString().split('T')[0]}
              onChange={(e) => setSelectedDate(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Shift</label>
            <select
              value={shift}
              onChange={(e) => setShift(e.target.value as Shift)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="full_day">Full Day</option>
              <option value="morning">Morning</option>
              <option value="afternoon">Afternoon</option>
              <option value="night">Night</option>
            </select>
          </div>

          <div className="flex items-end">
            <button
              onClick={loadRegisterData}
              className="w-full px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
              disabled={!selectedLocation || loading}
            >
              {loading ? 'Loading...' : 'Load Register'}
            </button>
          </div>
        </div>
      </div>

      {/* Key Figures */}
      {register && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-gray-600">Opening Balance</span>
                <DollarSign className="w-4 h-4 text-gray-400" />
              </div>
              <div className="text-2xl font-bold text-gray-900">{formatCurrency(register.opening_balance || 0)}</div>
            </div>

            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-gray-600">Cash Collections</span>
                <DollarSign className="w-4 h-4 text-blue-600" />
              </div>
              <div className="text-2xl font-bold text-blue-600">
                {formatCurrency(Math.max(0, (register.system_amount || 0) - (register.opening_balance || 0)))}
              </div>
              <div className="text-xs text-gray-500 mt-1">{payments.length} transactions</div>
            </div>

            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-gray-600">System Total</span>
                <Calculator className="w-4 h-4 text-gray-400" />
              </div>
              <div className="text-2xl font-bold text-gray-900">{formatCurrency(register.system_amount || 0)}</div>
            </div>

            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-gray-600">Variance</span>
                <AlertCircle className="w-4 h-4 text-gray-400" />
              </div>
              <div className="text-2xl font-bold text-gray-900">
                {register.reconciled && typeof register.variance === 'number' ? formatCurrency(register.variance) : '-'}
              </div>
            </div>
          </div>

          {/* Transactions list */}
          {payments.length > 0 && (
            <div className="bg-white rounded-lg shadow-sm border border-gray-200">
              <div className="px-4 py-3 border-b border-gray-200">
                <h3 className="text-lg font-medium">Cash Transactions</h3>
              </div>
              <div className="divide-y divide-gray-200">
                {payments.map((p) => (
                  <div key={p.id} className="px-4 py-3 flex justify-between items-center">
                    <div>
                      <div className="font-medium">{p.invoices?.patient_name}</div>
                      <div className="text-sm text-gray-500">Invoice #{String(p.invoice_id).slice(0, 8)}</div>
                    </div>
                    <div className="text-right">
                      <div className="font-medium">{formatCurrency(p.amount)}</div>
                      <div className="text-sm text-gray-500">{new Date(p.payment_date).toLocaleTimeString()}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Reconcile form */}
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
            <h3 className="text-lg font-medium mb-4">
              {register.reconciled ? 'Reconciliation Details' : 'Reconcile Cash Register'}
            </h3>

            {register.reconciled ? (
              <div className="space-y-3">
                <div className="text-sm text-gray-700">Actual Amount Counted: {formatCurrency(register.actual_amount || 0)}</div>
                {register.notes && <div className="text-sm text-gray-600 bg-gray-50 p-3 rounded">Notes: {register.notes}</div>}
                <div className="flex items-center gap-2 text-green-600 bg-green-50 p-3 rounded-lg">
                  <Check className="w-5 h-5" />
                  <span className="font-medium">This register has been reconciled</span>
                </div>
              </div>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleReconcile();
                }}
                className="space-y-4"
              >
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Actual Cash Counted *</label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">₹</span>
                    <input
                      type="number"
                      required
                      min="0"
                      step="0.01"
                      value={actualAmount}
                      onChange={(e) => setActualAmount(e.target.value)}
                      className="w-full pl-8 pr-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                      placeholder="0.00"
                    />
                  </div>
                  {actualAmount && (
                    <div className="mt-2 text-sm">
                      Expected: {formatCurrency(register.system_amount || 0)}
                    </div>
                  )}
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                  <textarea
                    value={reconciliationNotes}
                    onChange={(e) => setReconciliationNotes(e.target.value)}
                    rows={3}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="Add any notes about the reconciliation..."
                    required={
                      actualAmount !== '' &&
                      parseFloat(actualAmount) !== (register.system_amount || 0)
                    }
                  />
                </div>

                <div className="flex justify-end gap-3 pt-4 border-t">
                  <button
                    type="button"
                    onClick={() => {
                      setActualAmount('');
                      setReconciliationNotes('');
                    }}
                    className="px-4 py-2 text-gray-700 bg-gray-100 rounded-md hover:bg-gray-200"
                    disabled={processing}
                  >
                    Clear
                  </button>
                  <button
                    type="submit"
                    className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
                    disabled={processing || !actualAmount}
                  >
                    {processing ? <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" /> : <Check className="w-4 h-4" />}
                    {processing ? 'Processing...' : 'Reconcile Register'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </>
      )}
    </div>
  );
};

export default CashReconciliation;
```

---

## 4.4 Update **Dashboard** to add “Record Payment” action

> (Same as yours; opens `PaymentCapture` on billed invoices that aren’t fully paid.)&#x20;

```tsx
// ...existing imports...
import PaymentCapture from '../components/Billing/PaymentCapture';

const [showPaymentModal, setShowPaymentModal] = useState(false);
const [paymentInvoiceId, setPaymentInvoiceId] = useState<string | null>(null);

const handleRecordPayment = (invoiceId: string) => {
  setPaymentInvoiceId(invoiceId);
  setShowPaymentModal(true);
};

// ...inside each order card...
{order.billing_status === 'billed' && order.invoice_status !== 'Paid' && (
  <button
    onClick={() => handleRecordPayment(order.latest_invoice_id)}
    className="text-green-600 hover:text-green-800 flex items-center gap-1"
  >
    <CreditCard className="w-4 h-4" />
    <span className="text-sm">Record Payment</span>
  </button>
)}

{showPaymentModal && paymentInvoiceId && (
  <PaymentCapture
    invoiceId={paymentInvoiceId}
    onClose={() => {
      setShowPaymentModal(false);
      setPaymentInvoiceId(null);
    }}
    onSuccess={() => {
      setShowPaymentModal(false);
      setPaymentInvoiceId(null);
      loadOrders(); // refresh list
    }}
  />
)}
```

---

## 4.5 **Billing** page (Invoices / Cash Reconciliation) — Account-aware list

> (Keeps your Invoices table, adds a **Bill To** column and a simple **status** filter; launches PaymentCapture. Cash Reconciliation tab unchanged.)&#x20;

```tsx
import React, { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { FileText, CreditCard, Calculator, Search } from 'lucide-react';
import { database } from '../utils/supabase';
import PaymentCapture from '../components/Billing/PaymentCapture';
import CashReconciliation from '../components/Billing/CashReconciliation';

const Billing: React.FC = () => {
  const [searchParams] = useSearchParams();
  const view = searchParams.get('view') || 'invoices';
  const status = searchParams.get('status');

  const [invoices, setInvoices] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedStatus, setSelectedStatus] = useState(status || 'all');
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [selectedInvoiceId, setSelectedInvoiceId] = useState<string | null>(null);

  useEffect(() => {
    if (view === 'invoices') loadInvoices();
  }, [view, selectedStatus]);

  const loadInvoices = async () => {
    setLoading(true);
    try {
      let resp;
      if (selectedStatus === 'pending') resp = await database.invoices.getByStatus('Unpaid');
      else if (selectedStatus === 'paid') resp = await database.invoices.getByStatus('Paid');
      else if (selectedStatus === 'partial') resp = await database.invoices.getByStatus('Partial');
      else resp = await database.invoices.getAll();

      if (resp.error) throw resp.error;
      setInvoices(resp.data || []);
    } catch (e) {
      console.error('Error loading invoices', e);
    } finally {
      setLoading(false);
    }
  };

  const handleRecordPayment = (invoiceId: string) => {
    setSelectedInvoiceId(invoiceId);
    setShowPaymentModal(true);
  };

  const currency = (n: number) =>
    new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 0 }).format(n);

  const statusBadge = (s: string) =>
    s === 'Paid' ? 'bg-green-100 text-green-800' : s === 'Partial' ? 'bg-yellow-100 text-yellow-800' : 'bg-red-100 text-red-800';

  const renderContent = () => {
    if (view === 'cash-reconciliation') return <CashReconciliation />;

    // Invoices
    return (
      <div className="space-y-6">
        {/* Filters */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
          <div className="flex flex-col sm:flex-row gap-4">
            <div className="flex-1">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 w-5 h-5" />
                <input
                  type="text"
                  placeholder="Search invoices..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>

            <div className="flex gap-2">
              {['all', 'pending', 'partial', 'paid'].map((s) => (
                <button
                  key={s}
                  onClick={() => setSelectedStatus(s)}
                  className={`px-4 py-2 rounded-md text-sm font-medium ${
                    selectedStatus === s ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  {s[0].toUpperCase() + s.slice(1)}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Invoices list */}
        {loading ? (
          <div className="flex justify-center items-center h-64">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
          </div>
        ) : (
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Invoice</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Patient</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Bill To</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Amount</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                  <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {invoices
                  .filter((inv) => {
                    const q = searchQuery.trim().toLowerCase();
                    if (!q) return true;
                    return (
                      String(inv.id).toLowerCase().includes(q) ||
                      (inv.patient_name || '').toLowerCase().includes(q) ||
                      (inv.accounts?.name || '').toLowerCase().includes(q) ||
                      (inv.locations?.name || '').toLowerCase().includes(q)
                    );
                  })
                  .map((inv) => {
                    const amt = inv.total_after_discount || inv.total;
                    const paid = inv.paid_amount || 0;

                    const billKind = inv.account_id ? 'Account' : inv.location_id ? 'Location' : 'Self';
                    const billName = inv.account_id ? inv.accounts?.name : inv.location_id ? inv.locations?.name : '';

                    return (
                      <tr key={inv.id}>
                        <td className="px-6 py-4">
                          <div className="text-sm font-medium text-gray-900">#{String(inv.id).slice(0, 8)}</div>
                          <div className="text-sm text-gray-500">{new Date(inv.invoice_date).toLocaleDateString()}</div>
                        </td>
                        <td className="px-6 py-4">
                          <div className="text-sm text-gray-900">{inv.patient_name}</div>
                          <div className="text-sm text-gray-500 capitalize">{inv.payment_type}</div>
                        </td>
                        <td className="px-6 py-4">
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                            {billKind}{billName ? ` • ${billName}` : ''}
                          </span>
                        </td>
                        <td className="px-6 py-4">
                          <div className="text-sm font-medium text-gray-900">{currency(amt)}</div>
                          {inv.total_discount > 0 && (
                            <div className="text-xs text-green-600">Discount: {currency(inv.total_discount)}</div>
                          )}
                          {paid > 0 && paid < amt && (
                            <div className="text-xs text-blue-600">Paid: {currency(paid)}</div>
                          )}
                        </td>
                        <td className="px-6 py-4">
                          <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${statusBadge(inv.status)}`}>
                            {inv.status}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-center">
                          <div className="flex items-center justify-center gap-2">
                            <button className="text-blue-600 hover:text-blue-800">
                              <FileText className="w-4 h-4" />
                            </button>
                            {inv.status !== 'Paid' && (
                              <button
                                onClick={() => handleRecordPayment(inv.id)}
                                className="text-green-600 hover:text-green-800"
                              >
                                <CreditCard className="w-4 h-4" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold text-gray-900">Billing Management</h1>

        {/* View Tabs */}
        <div className="flex gap-2">
          <button
            onClick={() => (window.location.href = '/billing?view=invoices')}
            className={`px-4 py-2 rounded-md text-sm font-medium flex items-center gap-2 ${
              view === 'invoices' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            <FileText className="w-4 h-4" />
            Invoices
          </button>
          <button
            onClick={() => (window.location.href = '/billing?view=cash-reconciliation')}
            className={`px-4 py-2 rounded-md text-sm font-medium flex items-center gap-2 ${
              view === 'cash-reconciliation' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            <Calculator className="w-4 h-4" />
            Cash Reconciliation
          </button>
        </div>
      </div>

      {renderContent()}

      {showPaymentModal && selectedInvoiceId && (
        <PaymentCapture
          invoiceId={selectedInvoiceId}
          onClose={() => {
            setShowPaymentModal(false);
            setSelectedInvoiceId(null);
          }}
          onSuccess={() => {
            setShowPaymentModal(false);
            setSelectedInvoiceId(null);
            loadInvoices();
          }}
        />
      )}
    </div>
  );
};

export default Billing;
```

---

## 4.6 Add route in `App.tsx`

> (Same as your original route addition.)&#x20;

```tsx
// ...existing imports...
import Billing from './pages/Billing';

// ...inside your router...
<Route path="/billing" element={<AuthRoute><Billing /></AuthRoute>} />
```

---

### What changed (summary)

* **PaymentCapture** now shows **Bill To** (Account / Location / Self) and supports **`credit_adjustment`** for account-billed invoices; writes `account_id` when it’s a credit adjustment and `location_id` when it’s a cash payment.
* **Billing** page shows a **Bill To** column and keeps your filters/table/actions.
* **Cash Reconciliation** logic stays focused on **cash-by-location** (as designed).
* **supabase.ts** gains small helpers for **invoices (joined names)**, **payments**, and **accounts** to make the above work end-to-end.

If you want, I can now wire these into your repo files directly.
