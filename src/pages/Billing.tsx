import React, { useState, useEffect } from 'react';
import { Plus, Search, Filter, DollarSign, FileText, Download, Eye, CreditCard, Calendar, TrendingUp, Clock as ClockIcon, Calculator, Building } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { generateAndDownloadReport, getLabTemplate, ReportData } from '../utils/pdfGenerator';
import { database } from '../utils/supabase';
import InvoiceForm from '../components/Billing/InvoiceForm';
import MarkAsPaidModal from '../components/Billing/MarkAsPaidModal';
import CashReconciliation from '../components/Billing/CashReconciliation';
import MonthlyAccountBilling from '../components/Billing/MonthlyAccountBilling';

interface InvoiceItem {
  id: string;
  invoice_id: string;
  test_name: string;
  price: number;
  quantity: number;
  total: number;
  created_at: string;
}

interface Invoice {
  id: string;
  patient_id: string;
  order_id: string | null;
  patient_name: string;
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  status: 'Draft' | 'Sent' | 'Paid' | 'Overdue';
  invoice_date: string;
  due_date: string;
  paid_amount?: number;
  payment_status?: string;
  payment_method?: string;
  payment_date?: string;
  notes?: string;
  created_at: string;
  updated_at: string;
  invoice_items?: InvoiceItem[];
  // For UI compatibility
  patientName?: string;
  patientId?: string;
  invoiceDate?: string;
  dueDate?: string;
  tests?: { name: string; price: number }[];
}

const Billing: React.FC = () => {
  const [searchParams] = useSearchParams();
  const view = searchParams.get('view') || 'invoices';

  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedStatus, setSelectedStatus] = useState('All');
  const [selectedInvoice, setSelectedInvoice] = useState<Invoice | null>(null);
  const [downloadingInvoices, setDownloadingInvoices] = useState<Set<string>>(new Set());
  const [showInvoiceForm, setShowInvoiceForm] = useState(false);

  // State for payment modal
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [invoiceForPayment, setInvoiceForPayment] = useState<Invoice | null>(null);

  // Fetch invoices from Supabase on component mount
  useEffect(() => {
    fetchInvoices();
  }, []);

  const fetchInvoices = async () => {
    setLoading(true);
    setError(null);
    
    try {
      const { data, error } = await database.invoices.getAll();
      
      if (error) {
        setError(error.message);
        console.error('Error loading invoices:', error);
      } else {
        // Transform the data to match our expected format
        const formattedInvoices = (data || []).map((invoice: any) => ({
          ...invoice,
          // Add UI compatibility fields
          patientName: invoice.patient_name,
          patientId: invoice.patient_id,
          invoiceDate: invoice.invoice_date,
          dueDate: invoice.due_date,
          // Transform invoice_items to tests array for UI compatibility
          tests: invoice.invoice_items ? invoice.invoice_items.map((item: any) => ({
            name: item.test_name,
            price: item.price
          })) : []
        }));
        
        setInvoices(formattedInvoices);
      }
    } catch (err) {
      setError('Failed to load invoices');
      console.error('Error:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleAddInvoice = async (invoiceData: any) => {
    try {
      const { data, error } = await database.invoices.create(invoiceData);
      
      if (error) {
        console.error('Error creating invoice:', error);
        return;
      }
      
      // Refresh the invoices list
      fetchInvoices();
      
      // Close the form
      setShowInvoiceForm(false);
    } catch (err) {
      console.error('Error creating invoice:', err);
    }
  };

  const handleOpenPaymentModal = (invoice: Invoice) => {
    setInvoiceForPayment(invoice);
    setShowPaymentModal(true);
  };

  const handleMarkInvoiceAsPaid = async (
    invoiceId: string, 
    paymentMethod: string, 
    amount: number, 
    reference: string
  ) => {
    try {
      // Create a new payment record
      const paymentData = {
        invoice_id: invoiceId,
        amount,
        payment_method: paymentMethod,
        payment_reference: reference || null,
        payment_date: new Date().toISOString().split('T')[0]
      };
      
      const { data, error } = await database.payments.create(paymentData);
      
      if (error) {
        console.error('Error recording payment:', error);
        throw new Error('Failed to record payment');
      }
      
      // Refresh the invoices list to reflect the new payment
      await fetchInvoices();
      
      // Close the payment modal
      setShowPaymentModal(false);
      setInvoiceForPayment(null);
      
      // Show success message (you could add a toast notification here)
      console.log('Payment recorded successfully');
    } catch (err) {
      console.error('Error in payment process:', err);
      throw err; // Re-throw to be caught by the modal's error handler
    }
  };

  const statuses = ['All', 'Draft', 'Sent', 'Paid', 'Overdue'];

  const filteredInvoices = invoices.filter(invoice => {
    const matchesSearch = (invoice.patient_name || invoice.patientName || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
                         invoice.id.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = selectedStatus === 'All' || invoice.status === selectedStatus;
    return matchesSearch && matchesStatus;
  });

  const getStatusColor = (status: string) => {
    const colors = {
      'Draft': 'bg-gray-100 text-gray-800',
      'Unpaid': 'bg-yellow-100 text-yellow-800',
      'Partial': 'bg-orange-100 text-orange-800',
      'Sent': 'bg-blue-100 text-blue-800',
      'Paid': 'bg-green-100 text-green-800',
      'Overdue': 'bg-red-100 text-red-800',
    };
    return colors[status as keyof typeof colors] || 'bg-gray-100 text-gray-800';
  };

  const handleDownloadInvoice = async (invoice: Invoice) => {
    setDownloadingInvoices(prev => new Set(prev).add(invoice.id));
    
    try {
      // Convert invoice data to PDF format
      const invoiceItems = invoice.invoice_items || [];
      const testItems = invoiceItems.length > 0 
        ? invoiceItems.map((item: InvoiceItem) => ({
            name: item.test_name,
            price: item.price
          }))
        : invoice.tests || [];
      
      const reportData: ReportData = {
        patient: {
          name: invoice.patient_name || invoice.patientName || '',
          id: invoice.patient_id || invoice.patientId || '',
          age: 32, // This would come from patient data
          gender: 'Female', // This would come from patient data
          referredBy: 'Self', // This would come from invoice data
        },
        report: {
          reportId: invoice.id,
          collectionDate: invoice.invoice_date || invoice.invoiceDate || '',
          reportDate: invoice.invoice_date || invoice.invoiceDate || '',
          reportType: 'Invoice',
        },
        testResults: testItems.map((test: any) => ({
          parameter: test.name,
          result: `₹${test.price}`,
          unit: 'INR',
          referenceRange: 'Service Fee',
          flag: undefined,
        })),
        interpretation: `Invoice for medical services. Total amount: ₹${invoice.total}. Payment status: ${invoice.status}. ${invoice.payment_method || invoice.paymentMethod ? `Payment method: ${invoice.payment_method || invoice.paymentMethod}` : ''}`,
        template: getLabTemplate('medilab-default'),
      };
      
      await generateAndDownloadReport(reportData);
    } catch (error) {
      console.error('Error downloading invoice:', error);
      alert('Failed to download invoice. Please try again.');
    } finally {
      setDownloadingInvoices(prev => {
        const newSet = new Set(prev);
        newSet.delete(invoice.id);
        return newSet;
      });
    }
  };

  const totalRevenue = invoices.filter(i => i.status === 'Paid').reduce((sum, i) => sum + (i.total || 0), 0);
  const pendingAmount = invoices.filter(i => i.status === 'Sent').reduce((sum, i) => sum + (i.total || 0), 0);
  const overdueAmount = invoices.filter(i => i.status === 'Overdue').reduce((sum, i) => sum + (i.total || 0), 0);
  
  // Calculate total collected today
  const todayCollections = invoices
    .filter(i => i.payment_date === new Date().toISOString().split('T')[0])
    .reduce((sum, i) => sum + (i.paid_amount || 0), 0);

  const renderContent = () => {
    if (view === 'cash-reconciliation') return <CashReconciliation />;
    if (view === 'b2b-monthly') return <MonthlyAccountBilling />;

    // Render the existing invoices UI
    return (
      <>
        {/* Financial Overview Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
          <div className="bg-gradient-to-r from-green-50 to-green-100 rounded-lg shadow-sm border border-green-200 p-6">
            <div className="flex items-center">
              <div className="bg-green-500 p-3 rounded-lg">
                <DollarSign className="h-6 w-6 text-white" />
              </div>
              <div className="ml-4">
                <div className="text-2xl font-bold text-green-900">₹{totalRevenue.toLocaleString()}</div>
                <div className="text-sm text-green-700">Total Revenue</div>
                <div className="text-xs text-green-600 mt-1">Today: ₹{todayCollections.toLocaleString()}</div>
              </div>
            </div>
          </div>
          
          <div className="bg-gradient-to-r from-blue-50 to-blue-100 rounded-lg shadow-sm border border-blue-200 p-6">
            <div className="flex items-center">
              <div className="bg-blue-500 p-3 rounded-lg">
                <ClockIcon className="h-6 w-6 text-white" />
              </div>
              <div className="ml-4">
                <div className="text-2xl font-bold text-blue-900">₹{pendingAmount.toLocaleString()}</div>
                <div className="text-sm text-blue-700">Pending Payments</div>
              </div>
            </div>
          </div>

          <div className="bg-gradient-to-r from-red-50 to-red-100 rounded-lg shadow-sm border border-red-200 p-6">
            <div className="flex items-center">
              <div className="bg-red-500 p-3 rounded-lg">
                <Calendar className="h-6 w-6 text-white" />
              </div>
              <div className="ml-4">
                <div className="text-2xl font-bold text-red-900">₹{overdueAmount.toLocaleString()}</div>
                <div className="text-sm text-red-700">Overdue Amount</div>
              </div>
            </div>
          </div>

          <div className="bg-gradient-to-r from-purple-50 to-purple-100 rounded-lg shadow-sm border border-purple-200 p-6">
            <div className="flex items-center">
              <div className="bg-purple-500 p-3 rounded-lg">
                <TrendingUp className="h-6 w-6 text-white" />
              </div>
              <div className="ml-4">
                <div className="text-2xl font-bold text-purple-900">{invoices.length}</div>
                <div className="text-sm text-purple-700">Total Invoices</div>
              </div>
            </div>
          </div>
        </div>

        {/* Search and Filter Bar */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
          <div className="flex flex-col sm:flex-row gap-4">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search by patient name or invoice ID..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-10 pr-4 py-2 w-full border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
            <select
              value={selectedStatus}
              onChange={(e) => setSelectedStatus(e.target.value)}
              className="px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            >
              {statuses.map(status => (
                <option key={status} value={status}>{status}</option>
              ))}
            </select>
            <button className="flex items-center px-4 py-2 border border-gray-300 rounded-md hover:bg-gray-50 transition-colors">
              <Filter className="h-4 w-4 mr-2" />
              Date Range
            </button>
          </div>
        </div>

        {/* Invoices Table - Existing implementation continues... */}
        {loading ? (
          <div className="flex items-center justify-center min-h-64">
            <div className="animate-spin rounded-full h-12 w-12 border-4 border-blue-600 border-t-transparent"></div>
          </div>
        ) : error ? (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">{error}</div>
        ) : (
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900">
                Invoices ({filteredInvoices.length})
              </h3>
            </div>
            
            <div className="overflow-x-auto">
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
                      Bill To
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Amount
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Status
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Dates
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {filteredInvoices.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-6 py-4 text-center text-gray-500">
                        No invoices found
                      </td>
                    </tr>
                  ) : (
                    filteredInvoices.map((invoice) => {
                      // Determine bill-to information
                      const invoiceType = (invoice as any).invoice_type || 'patient';
                      const billTo = invoiceType === 'account' 
                        ? { type: 'Account', name: (invoice as any).account?.name || 'Account' }
                        : (invoice as any).location_id 
                        ? { type: 'Location', name: (invoice as any).location?.name || 'Location' }
                        : { type: 'Self', name: 'Direct Pay' };

                      return (
                        <tr key={invoice.id} className="hover:bg-gray-50 transition-colors">
                          <td className="px-6 py-4 whitespace-nowrap">
                            <div>
                              <div className="text-sm font-medium text-gray-900">#{invoice.id.slice(0, 8)}</div>
                              <div className="text-sm text-gray-500">
                                {(invoice.invoice_items?.length || invoice.tests?.length || 0)} items
                              </div>
                              {invoiceType === 'account' && (
                                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800 mt-1">
                                  B2B Credit
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap">
                            <div>
                              <div className="text-sm font-medium text-gray-900">
                                {invoice.patient_name || invoice.patientName}
                              </div>
                              <div className="text-sm text-gray-500">
                                ID: {(invoice.patient_id || invoice.patientId || '').slice(0, 8)}
                              </div>
                            </div>
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap">
                            <div>
                              <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                                billTo.type === 'Account' ? 'bg-purple-100 text-purple-800' :
                                billTo.type === 'Location' ? 'bg-orange-100 text-orange-800' :
                                'bg-gray-100 text-gray-800'
                              }`}>
                                {billTo.type}
                              </span>
                              {billTo.name !== billTo.type && (
                                <div className="text-xs text-gray-600 mt-1 truncate max-w-32" title={billTo.name}>
                                  {billTo.name}
                                </div>
                              )}
                            </div>
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap">
                            <div className="text-sm font-bold text-gray-900">₹{invoice.total.toLocaleString()}</div>
                            <div className="text-sm text-gray-500">Sub: ₹{invoice.subtotal}</div>
                            {invoice.paid_amount !== undefined && invoice.paid_amount > 0 && (
                              <div className="text-sm text-green-600">Paid: ₹{invoice.paid_amount.toLocaleString()}</div>
                            )}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap">
                            <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusColor(invoice.payment_status || invoice.status)}`}>
                              {invoice.payment_status || invoice.status}
                            </span>
                            {invoice.payment_method && (
                              <div className="text-xs text-gray-500 mt-1">
                                {invoice.payment_method}
                              </div>
                            )}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                            <div>Issued: {new Date(invoice.invoice_date || invoice.invoiceDate || '').toLocaleDateString()}</div>
                            <div>Due: {new Date(invoice.due_date || invoice.dueDate || '').toLocaleDateString()}</div>
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm font-medium space-x-2">
                            <button
                              onClick={() => setSelectedInvoice(invoice)}
                              className="text-blue-600 hover:text-blue-900 p-1 rounded"
                              title="Preview Invoice"
                            >
                              <Eye className="h-4 w-4" />
                            </button>
                            <button 
                              onClick={() => handleDownloadInvoice(invoice)}
                              disabled={downloadingInvoices.has(invoice.id)}
                              className="text-green-600 hover:text-green-900 p-1 rounded disabled:opacity-50"
                              title="Download Invoice"
                            >
                              <Download className="h-4 w-4" />
                            </button>
                            {(invoice.payment_status !== 'Paid' && invoice.status !== 'Paid') && (
                              <button 
                                onClick={() => handleOpenPaymentModal(invoice)}
                                className="text-orange-600 hover:text-orange-900 p-1 rounded"
                                title="Record Payment"
                              >
                                <CreditCard className="h-4 w-4" />
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Rest of the existing UI... */}
      </>
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
            onClick={() => (window.location.href = '/billing?view=b2b-monthly')}
            className={`px-4 py-2 rounded-md text-sm font-medium flex items-center gap-2 ${
              view === 'b2b-monthly' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            <Building className="w-4 h-4" />
            B2B Monthly
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

      {/* Payment Gateway Integration */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Payment Methods</h3>
          
          <div className="space-y-4">
            <div className="flex items-center justify-between p-4 bg-green-50 border border-green-200 rounded-lg">
              <div className="flex items-center">
                <div className="bg-green-100 p-2 rounded">
                  <CreditCard className="h-5 w-5 text-green-600" />
                </div>
                <div className="ml-3">
                  <div className="font-medium text-green-900">UPI Payments</div>
                  <div className="text-sm text-green-700">PhonePe, GPay, Paytm</div>
                </div>
              </div>
              <span className="text-green-600 bg-green-100 px-2 py-1 rounded text-xs font-medium">Active</span>
            </div>
            
            <div className="flex items-center justify-between p-4 bg-blue-50 border border-blue-200 rounded-lg">
              <div className="flex items-center">
                <div className="bg-blue-100 p-2 rounded">
                  <CreditCard className="h-5 w-5 text-blue-600" />
                </div>
                <div className="ml-3">
                  <div className="font-medium text-blue-900">Card Payments</div>
                  <div className="text-sm text-blue-700">Visa, MasterCard, RuPay</div>
                </div>
              </div>
              <span className="text-blue-600 bg-blue-100 px-2 py-1 rounded text-xs font-medium">Active</span>
            </div>
            
            <div className="flex items-center justify-between p-4 bg-gray-50 border border-gray-200 rounded-lg">
              <div className="flex items-center">
                <div className="bg-gray-100 p-2 rounded">
                  <DollarSign className="h-5 w-5 text-gray-600" />
                </div>
                <div className="ml-3">
                  <div className="font-medium text-gray-900">Cash Payments</div>
                  <div className="text-sm text-gray-700">Counter payments</div>
                </div>
              </div>
              <span className="text-gray-600 bg-gray-100 px-2 py-1 rounded text-xs font-medium">Available</span>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Quick Actions</h3>
          
          <div className="space-y-3">
            <button className="w-full flex items-center justify-center px-4 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors">
              <Plus className="h-5 w-5 mr-2" />
              <span onClick={() => setShowInvoiceForm(true)}>Create New Invoice</span>
            </button>
            
            <button className="w-full flex items-center justify-center px-4 py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors">
              <FileText className="h-5 w-5 mr-2" />
              Generate Payment Report
            </button>
            
            <button className="w-full flex items-center justify-center px-4 py-3 bg-orange-600 text-white rounded-lg hover:bg-orange-700 transition-colors">
              <Calendar className="h-5 w-5 mr-2" />
              Send Payment Reminders
            </button>
            
            <button className="w-full flex items-center justify-center px-4 py-3 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors">
              <TrendingUp className="h-5 w-5 mr-2" />
              Financial Analytics
            </button>
          </div>
        </div>
      </div>

      {/* Invoice Preview Modal */}
      {selectedInvoice && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-75 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-6 border-b border-gray-200">
              <h2 className="text-xl font-semibold text-gray-900">Invoice Preview</h2>
              <button
                onClick={() => setSelectedInvoice(null)}
                className="text-gray-400 hover:text-gray-500 p-1 rounded"
              >
                ×
              </button>
            </div>

            <div className="p-6">
              {/* Invoice Content */}
              <div className="bg-white border border-gray-300 rounded-lg p-6">
                <div className="text-center mb-6">
                  <h1 className="text-2xl font-bold text-blue-600">MediLab Diagnostics</h1>
                  <p className="text-gray-600">123 Health Street, Medical District</p>
                  <p className="text-gray-600">Phone: +91 80 1234 5678 | GST: 29ABCDE1234F1Z5</p>
                </div>
                
                <div className="border-t border-b border-gray-300 py-4 mb-6">
                  <h2 className="text-lg font-semibold text-center text-gray-900">TAX INVOICE</h2>
                </div>
                
                <div className="grid grid-cols-2 gap-6 mb-6">
                  <div>
                    <h3 className="font-semibold text-gray-900 mb-2">Bill To:</h3>
                    <div className="text-sm space-y-1">
                      <div className="font-medium">{selectedInvoice.patient_name || selectedInvoice.patientName}</div>
                      <div>Patient ID: {selectedInvoice.patient_id || selectedInvoice.patientId}</div>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm space-y-1">
                      <div><span className="font-medium">Invoice #:</span> {selectedInvoice.id}</div>
                      <div><span className="font-medium">Date:</span> {new Date(selectedInvoice.invoice_date || selectedInvoice.invoiceDate || '').toLocaleDateString()}</div>
                      <div><span className="font-medium">Due Date:</span> {new Date(selectedInvoice.due_date || selectedInvoice.dueDate || '').toLocaleDateString()}</div>
                    </div>
                  </div>
                </div>
                
                <table className="w-full mb-6">
                  <thead>
                    <tr className="border-b border-gray-300">
                      <th className="text-left py-2">Test/Service</th>
                      <th className="text-right py-2">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(selectedInvoice.invoice_items || selectedInvoice.tests || []).map((item: any, index: number) => (
                      <tr key={index} className="border-b border-gray-100">
                        <td className="py-2">{item.test_name || item.name}</td>
                        <td className="text-right py-2">₹{item.price}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                
                <div className="border-t border-gray-300 pt-4">
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span>Subtotal:</span>
                      <span>₹{selectedInvoice.subtotal}</span>
                    </div>
                    {selectedInvoice.discount > 0 && (
                      <div className="flex justify-between">
                        <span>Discount:</span>
                        <span>-₹{selectedInvoice.discount}</span>
                      </div>
                    )}
                    <div className="flex justify-between">
                      <span>GST (18%):</span>
                      <span>₹{selectedInvoice.tax}</span>
                    </div>
                    <div className="flex justify-between font-bold text-lg border-t border-gray-300 pt-2">
                      <span>Total:</span>
                      <span>₹{selectedInvoice.total}</span>
                    </div>
                  </div>
                </div>
                
                <div className="mt-6 text-center text-sm text-gray-600">
                  <p>Thank you for choosing MediLab Diagnostics!</p>
                  <p>For queries, contact us at billing@medilab.com</p>
                </div>
              </div>
              
              <div className="flex items-center justify-end space-x-4 mt-6">
                <button
                  onClick={() => setSelectedInvoice(null)}
                  className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  Close
                </button>
                {selectedInvoice && (selectedInvoice.payment_status !== 'Paid' && selectedInvoice.status !== 'Paid') && (
                  <button 
                    onClick={() => {
                      setSelectedInvoice(null);
                      handleOpenPaymentModal(selectedInvoice);
                    }}
                    className="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 transition-colors"
                  >
                    <CreditCard className="h-4 w-4 mr-2 inline" />
                    Record Payment
                  </button>
                )}
                <button 
                  onClick={() => handleDownloadInvoice(selectedInvoice)}
                  disabled={downloadingInvoices.has(selectedInvoice.id)}
                  className="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
                >
                  <Download className="h-4 w-4 mr-2 inline" />
                  {downloadingInvoices.has(selectedInvoice.id) ? 'Generating...' : 'Download PDF'}
                </button>
                <button className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors">
                  Send Invoice
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Invoice Form Modal */}
      {showInvoiceForm && (
        <InvoiceForm
          onClose={() => setShowInvoiceForm(false)}
          onSubmit={handleAddInvoice}
        />
      )}

      {/* Mark as Paid Modal */}
      {showPaymentModal && invoiceForPayment && (
        <MarkAsPaidModal
          isOpen={showPaymentModal}
          onClose={() => {
            setShowPaymentModal(false);
            setInvoiceForPayment(null);
          }}
          invoiceId={invoiceForPayment.id}
          invoiceTotal={invoiceForPayment.total}
          paidAmount={invoiceForPayment.paid_amount || 0}
          onSubmit={handleMarkInvoiceAsPaid}
        />
      )}
    </div>
  );
};

export default Billing;