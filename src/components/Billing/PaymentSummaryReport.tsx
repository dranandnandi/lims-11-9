import React, { useState, useEffect } from 'react';
import { Calendar, DollarSign, Filter, Download, Printer, User, CreditCard } from 'lucide-react';
import { database } from '../../utils/supabase';

interface Payment {
  id: string;
  invoice_id: string;
  amount: number;
  payment_method: string;
  payment_reference: string | null;
  payment_date: string;
  received_by: string | null;
  created_at: string;
  invoices?: { patient_name: string | null; invoice_number: string | null } | null;
}

interface PaymentSummary {
  payment_method: string;
  total_amount: number;
  count: number;
}

const PaymentSummaryReport: React.FC = () => {
  const [startDate, setStartDate] = useState<string>(new Date().toISOString().split('T')[0]);
  const [endDate, setEndDate] = useState<string>(new Date().toISOString().split('T')[0]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchPayments();
  }, [startDate, endDate]);

  const fetchPayments = async () => {
    setLoading(true);
    setError(null);
    
    try {
      const { data, error } = await database.payments.getPaymentSummary(startDate, endDate);
      
      if (error) {
        setError(error.message);
        console.error('Error loading payments:', error);
      } else {
        setPayments(data || []);
      }
    } catch (err) {
      setError('Failed to load payments');
      console.error('Error:', err);
    } finally {
      setLoading(false);
    }
  };

  // Calculate payment summary by method
  const paymentSummary: PaymentSummary[] = payments.reduce((summary: PaymentSummary[], payment) => {
    const existingMethod = summary.find(s => s.payment_method === payment.payment_method);
    
    if (existingMethod) {
      existingMethod.total_amount += payment.amount;
      existingMethod.count += 1;
    } else {
      summary.push({
        payment_method: payment.payment_method,
        total_amount: payment.amount,
        count: 1
      });
    }
    
    return summary;
  }, []);

  const totalCollected = payments.reduce((sum, payment) => sum + payment.amount, 0);

  const patientNameOf = (payment: Payment) => payment.invoices?.patient_name?.trim() || '-';

  // Prefer the human-readable invoice number; the uuid is the only fallback
  const invoiceLabelOf = (payment: Payment) =>
    payment.invoices?.invoice_number?.trim() || payment.invoice_id;

  const exportCsv = () => {
    const header = ['Date', 'Patient', 'Invoice ID', 'Method', 'Reference', 'Amount'];
    const rows = payments.map((payment) => [
      new Date(payment.payment_date).toLocaleDateString(),
      patientNameOf(payment),
      invoiceLabelOf(payment),
      payment.payment_method,
      payment.payment_reference || '',
      String(payment.amount),
    ]);

    const csv = [header, ...rows]
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\r\n');

    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8;' }));
    link.download = `payment_collections_${startDate}_to_${endDate}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold text-gray-900">Payment Collections Report</h2>
        <div className="flex space-x-3">
          <button className="flex items-center px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
            <Printer className="h-4 w-4 mr-2" />
            Print Report
          </button>
          <button
            onClick={exportCsv}
            disabled={payments.length === 0}
            className="flex items-center px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Download className="h-4 w-4 mr-2" />
            Export CSV
          </button>
        </div>
      </div>

      {/* Date Range Filter */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
        <div className="flex flex-col sm:flex-row gap-4">
          <div className="flex items-center">
            <Calendar className="h-5 w-5 text-gray-400 mr-2" />
            <span className="text-sm text-gray-700 mr-2">Date Range:</span>
          </div>
          <div className="flex items-center space-x-2">
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            <span>to</span>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
          <button 
            onClick={fetchPayments}
            className="flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            <Filter className="h-4 w-4 mr-2" />
            Apply Filter
          </button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <div className="flex items-center">
            <div className="bg-green-100 p-3 rounded-lg">
              <DollarSign className="h-6 w-6 text-green-600" />
            </div>
            <div className="ml-4">
              <div className="text-2xl font-bold text-gray-900">₹{totalCollected.toLocaleString()}</div>
              <div className="text-sm text-gray-600">Total Collections</div>
            </div>
          </div>
        </div>
        
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <div className="flex items-center">
            <div className="bg-blue-100 p-3 rounded-lg">
              <CreditCard className="h-6 w-6 text-blue-600" />
            </div>
            <div className="ml-4">
              <div className="text-2xl font-bold text-gray-900">{payments.length}</div>
              <div className="text-sm text-gray-600">Total Transactions</div>
            </div>
          </div>
        </div>
        
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <div className="flex items-center">
            <div className="bg-purple-100 p-3 rounded-lg">
              <User className="h-6 w-6 text-purple-600" />
            </div>
            <div className="ml-4">
              <div className="text-2xl font-bold text-gray-900">
                {new Set(payments.map(p => p.invoice_id)).size}
              </div>
              <div className="text-sm text-gray-600">Unique Invoices</div>
            </div>
          </div>
        </div>
      </div>

      {/* Payment Method Summary */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900">
            Collections by Payment Method
          </h3>
        </div>
        
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Payment Method
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Transactions
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Total Amount
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Percentage
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {paymentSummary.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-6 py-4 text-center text-gray-500">
                    No payment data available for the selected date range
                  </td>
                </tr>
              ) : (
                paymentSummary.map((summary, index) => (
                  <tr key={index} className="hover:bg-gray-50 transition-colors">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center">
                        <div className={`p-2 rounded-full ${
                          summary.payment_method === 'Cash' ? 'bg-green-100' :
                          summary.payment_method === 'UPI' ? 'bg-purple-100' :
                          summary.payment_method.includes('Card') ? 'bg-blue-100' :
                          'bg-gray-100'
                        }`}>
                          <CreditCard className={`h-4 w-4 ${
                            summary.payment_method === 'Cash' ? 'text-green-600' :
                            summary.payment_method === 'UPI' ? 'text-purple-600' :
                            summary.payment_method.includes('Card') ? 'text-blue-600' :
                            'text-gray-600'
                          }`} />
                        </div>
                        <div className="ml-3 font-medium text-gray-900">
                          {summary.payment_method}
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                      {summary.count}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="text-sm font-bold text-gray-900">₹{summary.total_amount.toLocaleString()}</div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center">
                        <div className="text-sm font-medium text-gray-900">
                          {totalCollected > 0 ? ((summary.total_amount / totalCollected) * 100).toFixed(1) : 0}%
                        </div>
                        <div className="ml-2 w-24 bg-gray-200 rounded-full h-2">
                          <div 
                            className={`h-2 rounded-full ${
                              summary.payment_method === 'Cash' ? 'bg-green-600' :
                              summary.payment_method === 'UPI' ? 'bg-purple-600' :
                              summary.payment_method.includes('Card') ? 'bg-blue-600' :
                              'bg-gray-600'
                            }`}
                            style={{ width: `${totalCollected > 0 ? (summary.total_amount / totalCollected) * 100 : 0}%` }}
                          />
                        </div>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Detailed Transactions */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900">
            Detailed Transactions
          </h3>
        </div>
        
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Date
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Patient
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Invoice ID
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Method
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Reference
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Amount
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {payments.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-4 text-center text-gray-500">
                    No payment data available for the selected date range
                  </td>
                </tr>
              ) : (
                payments.map((payment) => (
                  <tr key={payment.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                      {new Date(payment.payment_date).toLocaleDateString()}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                      {patientNameOf(payment)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      {invoiceLabelOf(payment)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                        payment.payment_method === 'Cash' ? 'bg-green-100 text-green-800' :
                        payment.payment_method === 'UPI' ? 'bg-purple-100 text-purple-800' :
                        payment.payment_method.includes('Card') ? 'bg-blue-100 text-blue-800' :
                        'bg-gray-100 text-gray-800'
                      }`}>
                        {payment.payment_method}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                      {payment.payment_reference || '-'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="text-sm font-bold text-gray-900">₹{payment.amount.toLocaleString()}</div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default PaymentSummaryReport;