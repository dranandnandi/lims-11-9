I'll implement Phase 4, which includes the Payment Capture and Cash Reconciliation components.

## Phase 4: Billing Components (Week 2 Day 4-5)

### 4.1 First, let's add the missing API methods to supabase.ts

````typescript
// ...existing code...

// Add these methods to the database object

orderTests: {
  getUnbilledByOrder: async (orderId: string) => {
    const labId = await database.getCurrentUserLabId();
    // First verify the order belongs to this lab
    const { data: order } = await supabase
      .from('orders')
      .select('lab_id')
      .eq('id', orderId)
      .single();
    
    if (order?.lab_id !== labId) {
      return { data: null, error: new Error('Unauthorized') };
    }
    
    return supabase
      .from('order_tests')
      .select('*')
      .eq('order_id', orderId)
      .eq('is_billed', false);
  },
  
  markAsBilled: async (testIds: string[], invoiceId: string, billedAmounts: Record<string, number>) => {
    const updates = testIds.map(testId => ({
      id: testId,
      is_billed: true,
      invoice_id: invoiceId,
      billed_at: new Date().toISOString(),
      billed_amount: billedAmounts[testId]
    }));
    
    return supabase
      .from('order_tests')
      .upsert(updates);
  }
},

invoiceItems: {
  create: async (items: any[]) => {
    return supabase
      .from('invoice_items')
      .insert(items);
  },
  
  getByInvoice: async (invoiceId: string) => {
    return supabase
      .from('invoice_items')
      .select('*')
      .eq('invoice_id', invoiceId)
      .order('created_at');
  }
}
````

### 4.2 Payment Capture Component

````typescript
import React, { useState, useEffect } from 'react';
import { X, CreditCard, DollarSign, Calendar, FileText, AlertCircle, Check } from 'lucide-react';
import { database } from '../../utils/supabase';
import type { Invoice, Payment } from '../../types';

interface PaymentCaptureProps {
  invoiceId: string;
  onClose: () => void;
  onSuccess: () => void;
}

const PaymentCapture: React.FC<PaymentCaptureProps> = ({ 
  invoiceId, 
  onClose, 
  onSuccess 
}) => {
  const [loading, setLoading] = useState(true);
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [processing, setProcessing] = useState(false);
  
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
      
      // Load invoice details
      const { data: invoiceData, error: invoiceError } = await database.invoices.getById(invoiceId);
      if (invoiceError) throw invoiceError;
      
      setInvoice(invoiceData);
      
      // Load existing payments
      const { data: paymentsData, error: paymentsError } = await database.payments.getByInvoice(invoiceId);
      if (paymentsError) throw paymentsError;
      
      setPayments(paymentsData || []);
      
      // Calculate remaining amount
      if (invoiceData) {
        const totalPaid = paymentsData?.reduce((sum, p) => sum + p.amount, 0) || 0;
        const remaining = (invoiceData.total_after_discount || invoiceData.total) - totalPaid;
        setAmount(Math.max(0, remaining).toString());
      }
      
    } catch (error) {
      console.error('Error loading invoice:', error);
      alert('Failed to load invoice details');
    } finally {
      setLoading(false);
    }
  };

  const calculateTotalPaid = () => {
    return payments.reduce((sum, p) => sum + p.amount, 0);
  };

  const calculateBalance = () => {
    if (!invoice) return 0;
    const invoiceTotal = invoice.total_after_discount || invoice.total;
    const totalPaid = calculateTotalPaid();
    return invoiceTotal - totalPaid;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    const paymentAmount = parseFloat(amount);
    
    if (isNaN(paymentAmount) || paymentAmount <= 0) {
      alert('Please enter a valid amount');
      return;
    }
    
    const balance = calculateBalance();
    if (paymentAmount > balance) {
      alert(`Payment amount cannot exceed balance of ₹${balance.toFixed(2)}`);
      return;
    }
    
    if (paymentMethod !== 'cash' && !paymentReference) {
      alert('Please enter a payment reference for non-cash payments');
      return;
    }
    
    setProcessing(true);
    
    try {
      // Create payment record
      const paymentData = {
        invoice_id: invoiceId,
        amount: paymentAmount,
        payment_method: paymentMethod,
        payment_reference: paymentReference || null,
        payment_date: paymentDate,
        location_id: invoice?.location_id || null,
        notes
      };
      
      const { error } = await database.payments.create(paymentData);
      if (error) throw error;
      
      // Show success message
      alert('Payment recorded successfully');
      
      onSuccess();
      
    } catch (error) {
      console.error('Error recording payment:', error);
      alert('Failed to record payment. Please try again.');
    } finally {
      setProcessing(false);
    }
  };

  if (loading || !invoice) {
    return (
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
        <div className="bg-white rounded-lg p-6">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        </div>
      </div>
    );
  }

  const invoiceTotal = invoice.total_after_discount || invoice.total;
  const totalPaid = calculateTotalPaid();
  const balance = calculateBalance();
  const isFullyPaid = balance === 0;

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
              <div className="font-medium capitalize">{invoice.payment_type || 'Self'}</div>
            </div>
          </div>
        </div>

        {/* Payment Progress */}
        <div className="mb-6">
          <div className="flex justify-between mb-2">
            <span className="text-sm font-medium text-gray-700">Payment Progress</span>
            <span className="text-sm text-gray-500">
              ₹{totalPaid.toFixed(2)} / ₹{invoiceTotal.toFixed(2)}
            </span>
          </div>
          <div className="w-full bg-gray-200 rounded-full h-2">
            <div
              className={`h-2 rounded-full transition-all ${
                isFullyPaid ? 'bg-green-600' : 'bg-blue-600'
              }`}
              style={{ width: `${Math.min(100, (totalPaid / invoiceTotal) * 100)}%` }}
            />
          </div>
          <div className="mt-2 text-right">
            <span className={`text-sm font-medium ${
              isFullyPaid ? 'text-green-600' : 'text-orange-600'
            }`}>
              Balance: ₹{balance.toFixed(2)}
            </span>
          </div>
        </div>

        {/* Payment History */}
        {payments.length > 0 && (
          <div className="mb-6">
            <h3 className="text-lg font-medium mb-3">Payment History</h3>
            <div className="space-y-2">
              {payments.map((payment) => (
                <div key={payment.id} className="bg-gray-50 p-3 rounded-lg flex justify-between items-center">
                  <div className="flex items-center gap-3">
                    <div className={`p-2 rounded-full ${
                      payment.payment_method === 'cash' ? 'bg-green-100' :
                      payment.payment_method === 'card' ? 'bg-blue-100' :
                      payment.payment_method === 'upi' ? 'bg-purple-100' :
                      'bg-gray-100'
                    }`}>
                      <CreditCard className="w-4 h-4" />
                    </div>
                    <div>
                      <div className="font-medium">₹{payment.amount.toFixed(2)}</div>
                      <div className="text-sm text-gray-600">
                        {payment.payment_method.toUpperCase()}
                        {payment.payment_reference && ` • ${payment.payment_reference}`}
                      </div>
                    </div>
                  </div>
                  <div className="text-sm text-gray-500">
                    {new Date(payment.payment_date).toLocaleDateString()}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Payment Form */}
        {!isFullyPaid && (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Amount *
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-500">₹</span>
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
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Payment Date *
                </label>
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
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Payment Method *
              </label>
              <div className="grid grid-cols-4 gap-2">
                {(['cash', 'card', 'upi', 'bank'] as const).map((method) => (
                  <button
                    key={method}
                    type="button"
                    onClick={() => setPaymentMethod(method)}
                    className={`px-3 py-2 rounded-md text-sm font-medium border ${
                      paymentMethod === method
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                    }`}
                  >
                    {method.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>

            {paymentMethod !== 'cash' && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Reference Number *
                </label>
                <input
                  type="text"
                  required={paymentMethod !== 'cash'}
                  value={paymentReference}
                  onChange={(e) => setPaymentReference(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder={
                    paymentMethod === 'card' ? 'Transaction ID' :
                    paymentMethod === 'upi' ? 'UPI Reference' :
                    'Bank Reference'
                  }
                />
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Notes (Optional)
              </label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="Add any notes about this payment..."
              />
            </div>

            <div className="flex justify-end gap-3 pt-4 border-t">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-gray-700 bg-gray-100 rounded-md hover:bg-gray-200"
                disabled={processing}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
                disabled={processing}
              >
                {processing ? (
                  <>
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                    Processing...
                  </>
                ) : (
                  <>
                    <Check className="w-4 h-4" />
                    Record Payment
                  </>
                )}
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
            <p className="text-sm text-green-700 mt-1">
              This invoice has been fully paid. No further payments are required.
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

export default PaymentCapture;
````

### 4.3 Cash Reconciliation Component

````typescript
import React, { useState, useEffect } from 'react';
import { Calendar, DollarSign, MapPin, Check, X, AlertCircle, Calculator } from 'lucide-react';
import { database } from '../../utils/supabase';
import type { Location, CashRegister } from '../../types';

const CashReconciliation: React.FC = () => {
  const [locations, setLocations] = useState<Location[]>([]);
  const [selectedLocation, setSelectedLocation] = useState<string>('');
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split('T')[0]);
  const [shift, setShift] = useState<'morning' | 'afternoon' | 'night' | 'full_day'>('full_day');
  const [loading, setLoading] = useState(false);
  const [register, setRegister] = useState<CashRegister | null>(null);
  const [payments, setPayments] = useState<any[]>([]);
  
  // Reconciliation form
  const [actualAmount, setActualAmount] = useState('');
  const [reconciliationNotes, setReconciliationNotes] = useState('');
  const [processing, setProcessing] = useState(false);

  useEffect(() => {
    loadLocations();
  }, []);

  useEffect(() => {
    if (selectedLocation && selectedDate) {
      loadRegisterData();
    }
  }, [selectedLocation, selectedDate, shift]);

  const loadLocations = async () => {
    try {
      // Only load locations that support cash collection
      const { data, error } = await database.locations.getAll();
      if (error) throw error;
      
      const cashLocations = data?.filter(loc => loc.supports_cash_collection) || [];
      setLocations(cashLocations);
      
      // Auto-select first location if only one
      if (cashLocations.length === 1) {
        setSelectedLocation(cashLocations[0].id);
      }
    } catch (error) {
      console.error('Error loading locations:', error);
    }
  };

  const loadRegisterData = async () => {
    setLoading(true);
    try {
      // Get or create cash register for the date
      const { data: registerData, error: registerError } = await database.cashRegister.getOrCreate(
        selectedDate,
        selectedLocation,
        shift
      );
      
      if (registerError) throw registerError;
      
      setRegister(registerData);
      
      // If already reconciled, set the actual amount
      if (registerData.reconciled && registerData.actual_amount !== null) {
        setActualAmount(registerData.actual_amount.toString());
        setReconciliationNotes(registerData.notes || '');
      } else {
        setActualAmount('');
        setReconciliationNotes('');
      }
      
      // Load cash payments for this location and date
      const { data: paymentsData, error: paymentsError } = await database.payments.getByDateRange(
        selectedDate,
        selectedDate,
        selectedLocation
      );
      
      if (paymentsError) throw paymentsError;
      
      // Filter only cash payments
      const cashPayments = paymentsData?.filter(p => p.payment_method === 'cash') || [];
      setPayments(cashPayments);
      
      // Update system amount if not reconciled
      if (!registerData.reconciled) {
        const totalCash = cashPayments.reduce((sum, p) => sum + p.amount, 0);
        const updatedAmount = registerData.opening_balance + totalCash;
        
        // Update register with calculated system amount
        await database.cashRegister.update(registerData.id, {
          system_amount: updatedAmount
        });
        
        setRegister({
          ...registerData,
          system_amount: updatedAmount
        });
      }
      
    } catch (error) {
      console.error('Error loading register data:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleReconcile = async () => {
    if (!register) return;
    
    const actual = parseFloat(actualAmount);
    
    if (isNaN(actual) || actual < 0) {
      alert('Please enter a valid actual amount');
      return;
    }
    
    setProcessing(true);
    
    try {
      const { error } = await database.cashRegister.reconcile(
        register.id,
        actual,
        reconciliationNotes
      );
      
      if (error) throw error;
      
      alert('Cash register reconciled successfully');
      
      // Reload data
      await loadRegisterData();
      
    } catch (error) {
      console.error('Error reconciling cash register:', error);
      alert('Failed to reconcile cash register');
    } finally {
      setProcessing(false);
    }
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      minimumFractionDigits: 2
    }).format(amount);
  };

  const getVarianceColor = (variance: number) => {
    if (variance === 0) return 'text-green-600';
    if (Math.abs(variance) < 100) return 'text-yellow-600';
    return 'text-red-600';
  };

  const getVarianceBackground = (variance: number) => {
    if (variance === 0) return 'bg-green-50 border-green-200';
    if (Math.abs(variance) < 100) return 'bg-yellow-50 border-yellow-200';
    return 'bg-red-50 border-red-200';
  };

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
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Location
            </label>
            <select
              value={selectedLocation}
              onChange={(e) => setSelectedLocation(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              required
            >
              <option value="">Select Location</option>
              {locations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </select>
          </div>
          
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Date
            </label>
            <input
              type="date"
              value={selectedDate}
              max={new Date().toISOString().split('T')[0]}
              onChange={(e) => setSelectedDate(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Shift
            </label>
            <select
              value={shift}
              onChange={(e) => setShift(e.target.value as any)}
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

      {/* Register Data */}
      {register && (
        <>
          {/* Summary Cards */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-gray-600">Opening Balance</span>
                <DollarSign className="w-4 h-4 text-gray-400" />
              </div>
              <div className="text-2xl font-bold text-gray-900">
                {formatCurrency(register.opening_balance)}
              </div>
            </div>
            
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-gray-600">Cash Collections</span>
                <DollarSign className="w-4 h-4 text-blue-600" />
              </div>
              <div className="text-2xl font-bold text-blue-600">
                {formatCurrency(register.system_amount - register.opening_balance)}
              </div>
              <div className="text-xs text-gray-500 mt-1">
                {payments.length} transactions
              </div>
            </div>
            
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-gray-600">System Total</span>
                <Calculator className="w-4 h-4 text-gray-400" />
              </div>
              <div className="text-2xl font-bold text-gray-900">
                {formatCurrency(register.system_amount)}
              </div>
            </div>
            
            <div className={`bg-white rounded-lg shadow-sm border p-4 ${
              register.reconciled ? getVarianceBackground(register.variance || 0) : 'border-gray-200'
            }`}>
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-gray-600">Variance</span>
                <AlertCircle className={`w-4 h-4 ${
                  register.reconciled ? getVarianceColor(register.variance || 0) : 'text-gray-400'
                }`} />
              </div>
              <div className={`text-2xl font-bold ${
                register.reconciled ? getVarianceColor(register.variance || 0) : 'text-gray-400'
              }`}>
                {register.reconciled && register.variance !== null
                  ? formatCurrency(register.variance)
                  : '-'
                }
              </div>
            </div>
          </div>

          {/* Transaction Details */}
          {payments.length > 0 && (
            <div className="bg-white rounded-lg shadow-sm border border-gray-200">
              <div className="px-4 py-3 border-b border-gray-200">
                <h3 className="text-lg font-medium">Cash Transactions</h3>
              </div>
              <div className="divide-y divide-gray-200">
                {payments.map((payment) => (
                  <div key={payment.id} className="px-4 py-3 flex justify-between items-center">
                    <div>
                      <div className="font-medium">{payment.invoice?.patient_name}</div>
                      <div className="text-sm text-gray-500">
                        Invoice #{payment.invoice_id.slice(0, 8)}
                        {payment.collected_by_user && ` • ${payment.collected_by_user.name}`}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-medium">{formatCurrency(payment.amount)}</div>
                      <div className="text-sm text-gray-500">
                        {new Date(payment.created_at).toLocaleTimeString()}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Reconciliation Form */}
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
            <h3 className="text-lg font-medium mb-4">
              {register.reconciled ? 'Reconciliation Details' : 'Reconcile Cash Register'}
            </h3>
            
            {register.reconciled ? (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Actual Amount Counted
                    </label>
                    <div className="text-lg font-medium">{formatCurrency(register.actual_amount || 0)}</div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Reconciled By
                    </label>
                    <div className="text-lg">
                      {register.reconciled_by_user?.name || 'Unknown'}
                      <div className="text-sm text-gray-500">
                        {register.reconciled_at && new Date(register.reconciled_at).toLocaleString()}
                      </div>
                    </div>
                  </div>
                </div>
                
                {register.notes && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Notes
                    </label>
                    <p className="text-gray-600 bg-gray-50 p-3 rounded">{register.notes}</p>
                  </div>
                )}
                
                <div className="flex items-center gap-2 text-green-600 bg-green-50 p-3 rounded-lg">
                  <Check className="w-5 h-5" />
                  <span className="font-medium">This register has been reconciled</span>
                </div>
              </div>
            ) : (
              <form onSubmit={(e) => { e.preventDefault(); handleReconcile(); }} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Actual Cash Counted *
                  </label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-500">₹</span>
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
                      Expected: {formatCurrency(register.system_amount)}
                      {parseFloat(actualAmount) !== register.system_amount && (
                        <span className={`ml-2 font-medium ${
                          getVarianceColor(parseFloat(actualAmount) - register.system_amount)
                        }`}>
                          (Variance: {formatCurrency(parseFloat(actualAmount) - register.system_amount)})
                        </span>
                      )}
                    </div>
                  )}
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Notes
                  </label>
                  <textarea
                    value={reconciliationNotes}
                    onChange={(e) => setReconciliationNotes(e.target.value)}
                    rows={3}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="Add any notes about the reconciliation..."
                    required={actualAmount && parseFloat(actualAmount) !== register.system_amount}
                  />
                  {actualAmount && parseFloat(actualAmount) !== register.system_amount && (
                    <p className="text-sm text-yellow-600 mt-1">
                      * Notes are required when there is a variance
                    </p>
                  )}
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
                    {processing ? (
                      <>
                        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                        Processing...
                      </>
                    ) : (
                      <>
                        <Check className="w-4 h-4" />
                        Reconcile Register
                      </>
                    )}
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
````

### 4.4 Update Dashboard to Add Payment Action

````typescript
// ...existing code...

// Add PaymentCapture import
import PaymentCapture from '../components/Billing/PaymentCapture';

// Add state for payment modal
const [showPaymentModal, setShowPaymentModal] = useState(false);
const [paymentInvoiceId, setPaymentInvoiceId] = useState<string | null>(null);

// Add function to handle payment
const handleRecordPayment = (invoiceId: string) => {
  setPaymentInvoiceId(invoiceId);
  setShowPaymentModal(true);
};

// In the order card, add a payment button for billed orders
{order.billing_status === 'billed' && order.invoice_status !== 'Paid' && (
  <button
    onClick={() => handleRecordPayment(order.latest_invoice_id)}
    className="text-green-600 hover:text-green-800 flex items-center gap-1"
  >
    <CreditCard className="w-4 h-4" />
    <span className="text-sm">Record Payment</span>
  </button>
)}

// Add the payment modal at the end
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
      loadOrders(); // Refresh to update payment status
    }}
  />
)}
````

### 4.5 Create Billing Page with Navigation

````typescript
import React, { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { FileText, CreditCard, Calculator, Wallet, Search, Filter, DollarSign } from 'lucide-react';
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
    if (view === 'invoices') {
      loadInvoices();
    }
  }, [view, selectedStatus]);

  const loadInvoices = async () => {
    setLoading(true);
    try {
      let query = database.invoices.getAll();
      
      // Apply status filter
      if (selectedStatus === 'pending') {
        query = database.invoices.getByStatus('Unpaid');
      } else if (selectedStatus === 'paid') {
        query = database.invoices.getByStatus('Paid');
      } else if (selectedStatus === 'partial') {
        query = database.invoices.getByStatus('Partial');
      }
      
      const { data, error } = await query;
      if (error) throw error;
      
      setInvoices(data || []);
    } catch (error) {
      console.error('Error loading invoices:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleRecordPayment = (invoiceId: string) => {
    setSelectedInvoiceId(invoiceId);
    setShowPaymentModal(true);
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      minimumFractionDigits: 0
    }).format(amount);
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'Paid':
        return 'bg-green-100 text-green-800';
      case 'Partial':
        return 'bg-yellow-100 text-yellow-800';
      case 'Unpaid':
        return 'bg-red-100 text-red-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  const renderContent = () => {
    switch (view) {
      case 'cash-reconciliation':
        return <CashReconciliation />;
        
      case 'today':
        // Today's collections view
        return (
          <div>
            <h2 className="text-xl font-semibold mb-4">Today's Collections</h2>
            {/* Implementation for today's collections */}
          </div>
        );
        
      default:
        // Invoices view
        return (
          <div className="space-y-6">
            {/* Filters */}
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
              <div className="flex flex-col sm:flex-row gap-4">
                <div className="flex-1">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
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
                  {['all', 'pending', 'partial', 'paid'].map((status) => (
                    <button
                      key={status}
                      onClick={() => setSelectedStatus(status)}
                      className={`px-4 py-2 rounded-md text-sm font-medium ${
                        selectedStatus === status
                          ? 'bg-blue-600 text-white'
                          : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                      }`}
                    >
                      {status.charAt(0).toUpperCase() + status.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Invoices List */}
            {loading ? (
              <div className="flex justify-center items-center h-64">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
              </div>
            ) : (
              <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Invoice Details
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Patient
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Amount
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Status
                      </th>
                      <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {invoices
                      .filter(invoice => 
                        !searchQuery || 
                        invoice.patient_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                        invoice.id.toLowerCase().includes(searchQuery.toLowerCase())
                      )
                      .map((invoice) => (
                        <tr key={invoice.id}>
                          <td className="px-6 py-4">
                            <div>
                              <div className="text-sm font-medium text-gray-900">
                                #{invoice.id.slice(0, 8)}
                              </div>
                              <div className="text-sm text-gray-500">
                                {new Date(invoice.invoice_date).toLocaleDateString()}
                              </div>
                            </div>
                          </td>
                          <td className="px-6 py-4">
                            <div className="text-sm text-gray-900">{invoice.patient_name}</div>
                            <div className="text-sm text-gray-500 capitalize">{invoice.payment_type}</div>
                          </td>
                          <td className="px-6 py-4">
                            <div className="text-sm font-medium text-gray-900">
                              {formatCurrency(invoice.total_after_discount || invoice.total)}
                            </div>
                            {invoice.total_discount > 0 && (
                              <div className="text-xs text-green-600">
                                Discount: {formatCurrency(invoice.total_discount)}
                              </div>
                            )}
                            {invoice.paid_amount > 0 && invoice.paid_amount < invoice.total && (
                              <div className="text-xs text-blue-600">
                                Paid: {formatCurrency(invoice.paid_amount)}
                              </div>
                            )}
                          </td>
                          <td className="px-6 py-4">
                            <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusBadge(invoice.status)}`}>
                              {invoice.status}
                            </span>
                          </td>
                          <td className="px-6 py-4 text-center">
                            <div className="flex items-center justify-center gap-2">
                              <button className="text-blue-600 hover:text-blue-800">
                                <FileText className="w-4 h-4" />
                              </button>
                              {invoice.status !== 'Paid' && (
                                <button
                                  onClick={() => handleRecordPayment(invoice.id)}
                                  className="text-green-600 hover:text-green-800"
                                >
                                  <CreditCard className="w-4 h-4" />
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold text-gray-900">Billing Management</h1>
        
        {/* View Tabs */}
        <div className="flex gap-2">
          <button
            onClick={() => window.location.href = '/billing?view=invoices'}
            className={`px-4 py-2 rounded-md text-sm font-medium flex items-center gap-2 ${
              view === 'invoices' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            <FileText className="w-4 h-4" />
            Invoices
          </button>
          <button
            onClick={() => window.location.href = '/billing?view=cash-reconciliation'}
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
````

### 4.6 Update App.tsx to Add Billing Route

````typescript
// ...existing code...

// Add import
import Billing from './pages/Billing';

// Add route
<Route path="/billing" element={<AuthRoute><Billing /></AuthRoute>} />
````

This completes Phase 4 with:

1. ✅ Added missing API methods to supabase.ts (orderTests, invoiceItems)
2. ✅ Created PaymentCapture component with partial payment support
3. ✅ Created CashReconciliation component with variance tracking
4. ✅ Updated Dashboard with payment action buttons
5. ✅ Created Billing page with invoice list and navigation
6. ✅ Added billing route to App.tsx

All components follow the project patterns:
- Use `database` object for all API calls (lab-scoped)
- Proper TypeScript interfaces
- Consistent error handling
- Responsive design with Tailwind CSS
- Security considerations (checking lab ownership)
- Support for multiple payment methods
- Cash register tracking by location and shift
- Variance analysis and reconciliation notes

The billing system is now complete with invoice creation, payment recording, and cash reconciliation features!

Similar code found with 1 license type