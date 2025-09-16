import React, { useState, useEffect } from 'react';
import { DollarSign, AlertCircle, Calculator, Check } from 'lucide-react';
import { database } from '../../utils/supabase';

type Shift = 'morning' | 'afternoon' | 'night' | 'full_day';

interface Location {
  id: string;
  name: string;
  supports_cash_collection?: boolean;
}

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