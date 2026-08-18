import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Search, DollarSign, FileText, Eye, CreditCard, Calendar, TrendingUp, Clock as ClockIcon, Calculator, Building, RotateCcw, File, Printer, Loader2, Receipt } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';

import { database } from '../utils/supabase';
import InvoiceForm from '../components/Billing/InvoiceForm';
import MarkAsPaidModal from '../components/Billing/MarkAsPaidModal';
import CashReconciliation from '../components/Billing/CashReconciliation';
import MonthlyAccountBilling from '../components/Billing/MonthlyAccountBilling';
import B2BAccountDashboard from '../components/Billing/B2BAccountDashboard';
import RefundRequestModal from '../components/Billing/RefundRequestModal';
import RefundApprovalConsole from '../components/Billing/RefundApprovalConsole';
import InvoiceGenerationModal from '../components/Billing/InvoiceGenerationModal';
import UnbilledOrders from '../components/Billing/UnbilledOrders';
import { ThermalPrintButton } from '../components/Invoices/ThermalPrintButton';

type DateRangePreset = 'custom' | 'today' | '7d' | '30d' | '90d' | 'all';
type PendingScope = 'pending' | 'all';
type BillToScope = 'all' | 'account' | 'location' | 'self';

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
  tax_rate?: number;
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
  // Refund fields
  total_refunded_amount?: number;
  refund_status?: 'not_requested' | 'pending' | 'partially_refunded' | 'fully_refunded';
  // For UI compatibility
  patientName?: string;
  patientId?: string;
  invoiceDate?: string;
  dueDate?: string;
  tests?: { name: string; price: number }[];
  orders?: { sample_id: string } | null;
  pdf_url?: string;
  pdf_generated_at?: string;
}

const Billing: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const view = searchParams.get('view') || 'invoices';

  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedStatus, setSelectedStatus] = useState('All');
  const [selectedInvoice, setSelectedInvoice] = useState<Invoice | null>(null);

  const [showInvoiceForm, setShowInvoiceForm] = useState(false);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [datePreset, setDatePreset] = useState<DateRangePreset>('today');
  const [pendingScope, setPendingScope] = useState<PendingScope>('all');

  // Bill-to (B2B / location / direct) filtering state
  const [billToScope, setBillToScope] = useState<BillToScope>('all');
  const [selectedAccountId, setSelectedAccountId] = useState<string>('all');
  const [accounts, setAccounts] = useState<{ id: string; name: string }[]>([]);

  // Location filtering state
  const [locations, setLocations] = useState<{ id: string; name: string }[]>([]);
  const [selectedLocationId, setSelectedLocationId] = useState<string>('all');

  // State for payment modal
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [invoiceForPayment, setInvoiceForPayment] = useState<Invoice | null>(null);

  // State for refund modal
  const [showRefundModal, setShowRefundModal] = useState(false);
  const [invoiceForRefund, setInvoiceForRefund] = useState<Invoice | null>(null);

  // State for PDF generation modal
  const [showPdfModal, setShowPdfModal] = useState(false);
  const [pdfInvoiceId, setPdfInvoiceId] = useState<string | null>(null);

  // Bulk invoice selection / print state
  const [selectedInvoiceIds, setSelectedInvoiceIds] = useState<Set<string>>(new Set());
  const [isBulkPrintingInvoices, setIsBulkPrintingInvoices] = useState(false);
  const [bulkInvoicePrintProgress, setBulkInvoicePrintProgress] = useState<string | null>(null);

  // Lab details for invoice preview
  const [labDetails, setLabDetails] = useState<any>(null);

  // Fetch lab details and locations on mount
  useEffect(() => {
    const loadData = async () => {
      // Load lab details
      const labId = await database.getCurrentUserLabId();
      const { data: lab } = await database.supabase
        .from('labs')
        .select('name, address, phone, email, gst_number')
        .eq('id', labId)
        .single();

      if (lab) {
        setLabDetails(lab);
      }

      // Load locations
      const userLocInfo = await database.shouldFilterByLocation();
      const { data: allLocations } = await database.locations.getAll();

      if (allLocations) {
        if (userLocInfo.canViewAll || !userLocInfo.shouldFilter) {
          setLocations(allLocations.map((l: any) => ({ id: l.id, name: l.name })));
        } else {
          setLocations(allLocations
            .filter((l: any) => userLocInfo.locationIds.includes(l.id))
            .map((l: any) => ({ id: l.id, name: l.name }))
          );
        }
      }

      // Load B2B accounts (used by the Bill To filter and the Bill To column)
      const { data: allAccounts } = await (database as any).accounts.getAll();
      setAccounts((allAccounts || []).map((a: any) => ({ id: a.id, name: a.name })));
    };
    loadData();
  }, []);

  // Fetch invoices from Supabase on component mount
  useEffect(() => {
    fetchInvoices();
  }, []);

  const formatISODate = (date: Date) => date.toISOString().split('T')[0];

  const applyQuickRange = useCallback((preset: DateRangePreset) => {
    if (preset === 'custom') {
      setDatePreset('custom');
      return;
    }

    setDatePreset(preset);

    if (preset === 'all') {
      setDateFrom('');
      setDateTo('');
      return;
    }

    const today = new Date();
    const endDate = formatISODate(today);
    const startDate = new Date(today);

    const offsets: Record<Exclude<DateRangePreset, 'custom'>, number> = {
      today: 0,
      '7d': 7,
      '30d': 30,
      '90d': 90,
      all: 0,
    };

    const offset = offsets[preset];
    startDate.setDate(startDate.getDate() - offset);

    setDateFrom(formatISODate(startDate));
    setDateTo(endDate);
  }, []);

  useEffect(() => {
    applyQuickRange('today');
  }, [applyQuickRange]);

  const fetchInvoices = async () => {
    setLoading(true);
    setError(null);

    try {
      const labId = await database.getCurrentUserLabId();
      const { data, error } = await database.supabase
        .from('invoices')
        .select(`
          *,
          invoice_items(*),
          orders(sample_id)
        `)
        .eq('lab_id', labId)
        .order('created_at', { ascending: false });

      if (error) {
        setError(error.message);
        console.error('Error loading invoices:', error);
      } else {
        // Transform the data to match our expected format
        let formattedInvoices = (data || []).map((invoice: any) => {
          const paid = invoice.amount_paid || 0;
          const total = invoice.total || 0;
          let computedPaymentStatus = invoice.payment_status;

          // Auto-calculate status based on payment (allowing for small float diff)
          if (total > 0 && paid >= (total - 1)) {
            computedPaymentStatus = 'Paid';
          } else if (paid > 0) {
            computedPaymentStatus = 'Partial';
          }

          return {
            ...invoice,
            // Add UI compatibility fields
            paid_amount: paid,
            payment_status: computedPaymentStatus,
            patientName: invoice.patient_name,
            patientId: invoice.patient_id,
            invoiceDate: invoice.invoice_date,
            dueDate: invoice.due_date,
            // Transform invoice_items to tests array for UI compatibility
            tests: invoice.invoice_items ? invoice.invoice_items.map((item: any) => ({
              name: item.test_name,
              price: item.price
            })) : [],
            orders: invoice.orders // Pass through order info
          };
        });

        // Apply location filtering if location is selected
        if (selectedLocationId !== 'all') {
          formattedInvoices = formattedInvoices.filter(
            (invoice: any) => invoice.location_id === selectedLocationId
          );
        }

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

  const normalizeInvoiceDate = (value?: string | null) => {
    if (!value) return null;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      const trimmed = value.split('T')[0];
      return trimmed || null;
    }
    return formatISODate(parsed);
  };

  const accountNameById = useMemo(
    () => new Map(accounts.map(a => [a.id, a.name])),
    [accounts]
  );
  const locationNameById = useMemo(
    () => new Map(locations.map(l => [l.id, l.name])),
    [locations]
  );

  // An invoice is B2B when it was raised against an account, either explicitly
  // (invoice_type = account) or because the order carried an account_id.
  const getBillToScope = (invoice: any): Exclude<BillToScope, 'all'> => {
    if (invoice.invoice_type === 'account' || invoice.account_id) return 'account';
    if (invoice.location_id) return 'location';
    return 'self';
  };

  const filteredInvoices = invoices.filter(invoice => {
    const matchesSearch = (invoice.patient_name || invoice.patientName || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
      invoice.id.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = selectedStatus === 'All' || invoice.status === selectedStatus;
    const invoiceDateIso = normalizeInvoiceDate(invoice.invoice_date || invoice.invoiceDate || null);
    const matchesDate = (() => {
      if (!dateFrom && !dateTo) return true;
      if (!invoiceDateIso) return false;
      if (dateFrom && invoiceDateIso < dateFrom) return false;
      if (dateTo && invoiceDateIso > dateTo) return false;
      return true;
    })();
    const paymentState = invoice.payment_status || invoice.status;
    const matchesPendingScope = pendingScope === 'all' ? true : paymentState !== 'Paid';
    const matchesBillTo = billToScope === 'all' || getBillToScope(invoice) === billToScope;
    const matchesAccount = selectedAccountId === 'all' || (invoice as any).account_id === selectedAccountId;
    return matchesSearch && matchesStatus && matchesDate && matchesPendingScope && matchesBillTo && matchesAccount;
  });

  const toggleInvoiceSelection = (invoiceId: string) => {
    setSelectedInvoiceIds(prev => {
      const next = new Set(prev);
      if (next.has(invoiceId)) next.delete(invoiceId);
      else next.add(invoiceId);
      return next;
    });
  };

  const toggleSelectAllInvoices = () => {
    setSelectedInvoiceIds(prev => {
      const allVisible = filteredInvoices.map(i => i.id);
      const allSelected = allVisible.length > 0 && allVisible.every(id => prev.has(id));
      return allSelected ? new Set<string>() : new Set(allVisible);
    });
  };

  // Merge the already-generated PDFs of the selected invoices into one PDF and open it for printing
  const handleBulkPrintInvoices = async () => {
    const selected = filteredInvoices.filter(i => selectedInvoiceIds.has(i.id));
    if (selected.length === 0) {
      alert('Please select at least one invoice.');
      return;
    }

    const withPdf = selected.filter(i => !!i.pdf_url);
    if (withPdf.length === 0) {
      alert('None of the selected invoices have a generated PDF yet. Use the Generate PDF action first.');
      return;
    }

    const missingCount = selected.length - withPdf.length;
    if (missingCount > 0) {
      const proceed = window.confirm(
        `${missingCount} selected invoice${missingCount === 1 ? ' does' : 's do'} not have a generated PDF and will be skipped.\n\nMerge and print the remaining ${withPdf.length}?`
      );
      if (!proceed) return;
    }

    setIsBulkPrintingInvoices(true);
    setBulkInvoicePrintProgress('Preparing…');

    try {
      const { PDFDocument } = await import('pdf-lib');
      const mergedPdf = await PDFDocument.create();
      const failures: string[] = [];

      for (let index = 0; index < withPdf.length; index++) {
        const invoice = withPdf[index];
        setBulkInvoicePrintProgress(`Merging ${index + 1}/${withPdf.length}…`);
        try {
          const response = await fetch(invoice.pdf_url!);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const bytes = await response.arrayBuffer();
          const sourcePdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
          const pages = await mergedPdf.copyPages(sourcePdf, sourcePdf.getPageIndices());
          pages.forEach(page => mergedPdf.addPage(page));
        } catch (err) {
          console.error(`Failed to merge invoice ${invoice.id}:`, err);
          failures.push(`#${invoice.id.slice(0, 8)} (${invoice.patient_name || invoice.patientName || 'Unknown'})`);
        }
      }

      if (mergedPdf.getPageCount() === 0) {
        throw new Error('No invoice PDFs could be fetched for merging.');
      }

      const mergedBytes = await mergedPdf.save();
      const blob = new Blob([mergedBytes], { type: 'application/pdf' });
      const blobUrl = URL.createObjectURL(blob);
      window.open(blobUrl, '_blank');
      setTimeout(() => URL.revokeObjectURL(blobUrl), 5 * 60 * 1000);

      if (failures.length > 0) {
        alert(`Merged PDF opened, but ${failures.length} invoice${failures.length === 1 ? '' : 's'} could not be included:\n${failures.join('\n')}`);
      }
    } catch (err) {
      console.error('Bulk invoice print failed:', err);
      alert('Bulk print failed: ' + (err instanceof Error ? err.message : 'Unknown error'));
    } finally {
      setIsBulkPrintingInvoices(false);
      setBulkInvoicePrintProgress(null);
    }
  };

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



  // Updated Financials to use actual payment data (Revenue = Collected Cash - Refunds)
  const totalRevenue = invoices.reduce((sum, i) => sum + (i.paid_amount || 0) - (i.total_refunded_amount || 0), 0);
  const pendingAmount = invoices.reduce((sum, i) => sum + Math.max(0, (i.total || 0) - (i.paid_amount || 0)), 0);
  const overdueAmount = invoices
    .filter(i => i.status === 'Overdue')
    .reduce((sum, i) => sum + Math.max(0, (i.total || 0) - (i.paid_amount || 0)), 0);

  // Calculate total collected today
  const todayCollections = invoices
    .filter(i => i.payment_date === new Date().toISOString().split('T')[0])
    .reduce((sum, i) => sum + (i.paid_amount || 0), 0);

  const renderContent = () => {
    if (view === 'unbilled-orders') return <UnbilledOrders />;
    if (view === 'cash-reconciliation') return <CashReconciliation />;
    if (view === 'b2b-monthly') return <MonthlyAccountBilling />;
    if (view === 'b2b-accounts') return <B2BAccountDashboard />;
    if (view === 'refund-approvals') return <RefundApprovalConsole />;

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
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 space-y-4">
          <div className="flex flex-col lg:flex-row gap-4">
            <div className="flex-1">
              <label className="text-sm font-medium text-gray-600 mb-1 block">Search</label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                <input
                  type="text"
                  placeholder="Search by patient name or invoice ID..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-10 pr-4 py-2 w-full border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
            </div>
            <div className="w-full lg:w-56">
              <label className="text-sm font-medium text-gray-600 mb-1 block">Invoice Status</label>
              <select
                value={selectedStatus}
                onChange={(e) => setSelectedStatus(e.target.value)}
                className="px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent w-full"
              >
                {statuses.map(status => (
                  <option key={status} value={status}>{status}</option>
                ))}
              </select>
            </div>
            <div className="w-full lg:w-44">
              <label className="text-sm font-medium text-gray-600 mb-1 block">Bill To</label>
              <select
                value={billToScope}
                onChange={(e) => setBillToScope(e.target.value as BillToScope)}
                className="px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent w-full"
              >
                <option value="all">All</option>
                <option value="account">B2B Account</option>
                <option value="location">Location</option>
                <option value="self">Direct Pay</option>
              </select>
            </div>
            <div className="w-full lg:w-56">
              <label className="text-sm font-medium text-gray-600 mb-1 block">Account</label>
              <select
                value={selectedAccountId}
                onChange={(e) => setSelectedAccountId(e.target.value)}
                className="px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent w-full"
              >
                <option value="all">All Accounts</option>
                {accounts.map(account => (
                  <option key={account.id} value={account.id}>{account.name}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex flex-col xl:flex-row xl:items-end gap-4">
            <div className="flex flex-col sm:flex-row sm:items-center gap-4 flex-1">
              <div className="flex flex-col">
                <span className="text-sm font-medium text-gray-600 mb-1">From</span>
                <input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => {
                    setDateFrom(e.target.value);
                    setDatePreset('custom');
                  }}
                  className="px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
              <div className="flex flex-col">
                <span className="text-sm font-medium text-gray-600 mb-1">To</span>
                <input
                  type="date"
                  value={dateTo}
                  onChange={(e) => {
                    setDateTo(e.target.value);
                    setDatePreset('custom');
                  }}
                  className="px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 flex-1">
              {[
                { label: 'Today', value: 'today' },
                { label: '7 days', value: '7d' },
                { label: '30 days', value: '30d' },
                { label: '90 days', value: '90d' },
                { label: 'All Dates', value: 'all' },
              ].map(({ label, value }) => (
                <button
                  key={value}
                  onClick={() => applyQuickRange(value as DateRangePreset)}
                  className={`px-3 py-1.5 text-sm rounded-md border ${datePreset === value ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-600 border-gray-200 hover:border-blue-300'}`}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-3">
              <span className="text-sm font-medium text-gray-600">Payment Scope</span>
              <div className="inline-flex bg-gray-100 rounded-full p-1">
                <button
                  onClick={() => setPendingScope('pending')}
                  className={`px-3 py-1 text-sm font-semibold rounded-full ${pendingScope === 'pending' ? 'bg-amber-500 text-white shadow' : 'text-gray-600'}`}
                >
                  Pending
                </button>
                <button
                  onClick={() => setPendingScope('all')}
                  className={`px-3 py-1 text-sm font-semibold rounded-full ${pendingScope === 'all' ? 'bg-blue-600 text-white shadow' : 'text-gray-600'}`}
                >
                  All
                </button>
              </div>
            </div>

            {/* Location Filter */}
            {locations.length > 0 && (
              <div className="flex items-center gap-3">
                <span className="text-sm font-medium text-gray-600">Location</span>
                <select
                  value={selectedLocationId}
                  onChange={(e) => {
                    setSelectedLocationId(e.target.value);
                    // Trigger refetch when location changes
                    setTimeout(() => fetchInvoices(), 0);
                  }}
                  className="px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                >
                  <option value="all">All Locations</option>
                  {locations.map((location) => (
                    <option key={location.id} value={location.id}>
                      {location.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
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
            <div className="px-6 py-4 border-b border-gray-200 flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-lg font-semibold text-gray-900">
                Invoices ({filteredInvoices.length})
              </h3>
              {selectedInvoiceIds.size > 0 && (
                <div className="flex items-center gap-3">
                  <span className="text-sm font-medium text-blue-900">
                    {selectedInvoiceIds.size} selected
                  </span>
                  <button
                    onClick={() => setSelectedInvoiceIds(new Set())}
                    className="text-sm text-blue-700 hover:text-blue-900 underline"
                  >
                    Clear
                  </button>
                  <button
                    onClick={handleBulkPrintInvoices}
                    disabled={isBulkPrintingInvoices}
                    className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                      isBulkPrintingInvoices
                        ? 'bg-indigo-300 text-white cursor-not-allowed'
                        : 'bg-indigo-600 text-white hover:bg-indigo-700'
                    }`}
                    title="Merge the generated PDFs of the selected invoices into one PDF for printing"
                  >
                    {isBulkPrintingInvoices ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Printer className="w-4 h-4" />
                    )}
                    <span>{isBulkPrintingInvoices ? (bulkInvoicePrintProgress || 'Merging…') : 'Bulk Print'}</span>
                  </button>
                </div>
              )}
            </div>

            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left">
                      <input
                        type="checkbox"
                        checked={filteredInvoices.length > 0 && filteredInvoices.every(i => selectedInvoiceIds.has(i.id))}
                        onChange={toggleSelectAllInvoices}
                        className="h-4 w-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                        title="Select all"
                      />
                    </th>
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
                      <td colSpan={8} className="px-6 py-4 text-center text-gray-500">
                        No invoices found
                      </td>
                    </tr>
                  ) : (
                    filteredInvoices.map((invoice) => {
                      // Determine bill-to information
                      const invoiceType = (invoice as any).invoice_type || 'patient';
                      const accountId = (invoice as any).account_id;
                      const locationId = (invoice as any).location_id;
                      const billTo = getBillToScope(invoice) === 'account'
                        ? { type: 'Account', name: (accountId && accountNameById.get(accountId)) || 'Account' }
                        : locationId
                          ? { type: 'Location', name: locationNameById.get(locationId) || 'Location' }
                          : { type: 'Self', name: 'Direct Pay' };

                      return (
                        <tr key={invoice.id} className="hover:bg-gray-50 transition-colors">
                          <td className="px-4 py-4">
                            <input
                              type="checkbox"
                              checked={selectedInvoiceIds.has(invoice.id)}
                              onChange={() => toggleInvoiceSelection(invoice.id)}
                              className="h-4 w-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                            />
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap">
                            <div>
                              <div className="text-sm font-medium text-gray-900">#{invoice.id.slice(0, 8)}</div>
                              <div className="text-sm text-gray-500">
                                {(invoice.invoice_items?.length || invoice.tests?.length || 0)} items
                              </div>
                              {invoice.orders?.sample_id && (
                                <div className="text-xs text-purple-600 font-medium mt-0.5" title="Sample ID">
                                  SID: {invoice.orders.sample_id}
                                </div>
                              )}
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
                              <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${billTo.type === 'Account' ? 'bg-purple-100 text-purple-800' :
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
                            <div className="text-sm text-gray-500">Sub: ₹{invoice.subtotal.toLocaleString()}</div>
                            {invoice.paid_amount !== undefined && invoice.paid_amount > 0 && (
                              <div className="text-sm text-green-600">Paid: ₹{invoice.paid_amount.toLocaleString()}</div>
                            )}
                            {invoice.total_refunded_amount !== undefined && invoice.total_refunded_amount > 0 && (
                              <div className="text-sm text-orange-600 font-medium">Refund: ₹{invoice.total_refunded_amount.toLocaleString()}</div>
                            )}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap">
                            <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusColor(invoice.payment_status || invoice.status)}`}>
                              {invoice.payment_status || invoice.status}
                            </span>
                            {invoice.refund_status && invoice.refund_status !== 'not_requested' && (
                              <span className={`ml-1 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                                invoice.refund_status === 'fully_refunded' ? 'bg-orange-100 text-orange-800' :
                                invoice.refund_status === 'partially_refunded' ? 'bg-yellow-100 text-yellow-800' :
                                'bg-gray-100 text-gray-600'
                              }`}>
                                {invoice.refund_status === 'fully_refunded' ? 'Refunded' : 
                                 invoice.refund_status === 'partially_refunded' ? 'Partial Refund' : 'Refund Pending'}
                              </span>
                            )}
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
                            {/* View Invoice */}
                            <button
                              onClick={() => setSelectedInvoice(invoice)}
                              className="text-blue-600 hover:text-blue-900 p-1 rounded"
                              title="Preview Invoice"
                            >
                              <Eye className="h-4 w-4" />
                            </button>

                            {/* View PDF (if exists) */}
                            {invoice.pdf_url && (
                              <button
                                onClick={() => window.open(`${invoice.pdf_url}?t=${invoice.pdf_generated_at ? new Date(invoice.pdf_generated_at).getTime() : Date.now()}`, '_blank')}
                                className="text-indigo-600 hover:text-indigo-900 p-1 rounded"
                                title="View Generated PDF"
                              >
                                <FileText className="h-4 w-4" />
                              </button>
                            )}

                            {/* Generate/Download PDF */}
                            <button
                              onClick={() => {
                                setPdfInvoiceId(invoice.id);
                                setShowPdfModal(true);
                              }}
                              className="text-green-600 hover:text-green-900 p-1 rounded"
                              title={invoice.pdf_url ? "Regenerate PDF" : "Generate PDF"}
                            >
                              <File className="h-4 w-4" />
                            </button>

                            {/* Thermal Print */}
                            <ThermalPrintButton
                              invoiceId={invoice.id}
                              variant="icon"
                              format="thermal_80mm"
                            />

                            {/* Record Payment */}
                            {(invoice.payment_status !== 'Paid' && invoice.status !== 'Paid') && (
                              <button
                                onClick={() => handleOpenPaymentModal(invoice)}
                                className="text-orange-600 hover:text-orange-900 p-1 rounded"
                                title="Record Payment"
                              >
                                <CreditCard className="h-4 w-4" />
                              </button>
                            )}

                            {/* Request Refund */}
                            {(((invoice.paid_amount ?? 0) > 0) || invoice.payment_status === 'Paid' || invoice.status === 'Paid') && (
                              <button
                                onClick={() => {
                                  setInvoiceForRefund(invoice);
                                  setShowRefundModal(true);
                                }}
                                className="text-purple-600 hover:text-purple-900 p-1 rounded"
                                title="Request Refund"
                              >
                                <RotateCcw className="h-4 w-4" />
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
            onClick={() => {
              const params = new URLSearchParams(searchParams);
              params.set('view', 'invoices');
              setSearchParams(params);
            }}
            className={`px-4 py-2 rounded-md text-sm font-medium flex items-center gap-2 ${view === 'invoices' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
          >
            <FileText className="w-4 h-4" />
            Invoices
          </button>
          <button
            onClick={() => {
              const params = new URLSearchParams(searchParams);
              params.set('view', 'unbilled-orders');
              setSearchParams(params);
            }}
            className={`px-4 py-2 rounded-md text-sm font-medium flex items-center gap-2 ${view === 'unbilled-orders' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
          >
            <Receipt className="w-4 h-4" />
            Unbilled Orders
          </button>
          <button
            onClick={() => {
              const params = new URLSearchParams(searchParams);
              params.set('view', 'b2b-monthly');
              setSearchParams(params);
            }}
            className={`px-4 py-2 rounded-md text-sm font-medium flex items-center gap-2 ${view === 'b2b-monthly' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
          >
            <Building className="w-4 h-4" />
            B2B Monthly
          </button>
          <button
            onClick={() => {
              const params = new URLSearchParams(searchParams);
              params.set('view', 'b2b-accounts');
              setSearchParams(params);
            }}
            className={`px-4 py-2 rounded-md text-sm font-medium flex items-center gap-2 ${view === 'b2b-accounts' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
          >
            <TrendingUp className="w-4 h-4" />
            B2B Accounts
          </button>
          <button
            onClick={() => {
              const params = new URLSearchParams(searchParams);
              params.set('view', 'cash-reconciliation');
              setSearchParams(params);
            }}
            className={`px-4 py-2 rounded-md text-sm font-medium flex items-center gap-2 ${view === 'cash-reconciliation' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
          >
            <Calculator className="w-4 h-4" />
            Cash Reconciliation
          </button>
          <button
            onClick={() => {
              const params = new URLSearchParams(searchParams);
              params.set('view', 'refund-approvals');
              setSearchParams(params);
            }}
            className={`px-4 py-2 rounded-md text-sm font-medium flex items-center gap-2 ${view === 'refund-approvals' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
          >
            <RotateCcw className="w-4 h-4" />
            Refunds
          </button>
        </div>
      </div>

      {renderContent()}

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
                  <h1 className="text-2xl font-bold text-blue-600">{labDetails?.name || 'Loading...'}</h1>
                  <p className="text-gray-600">{labDetails?.address || ''}</p>
                  <p className="text-gray-600">
                    {labDetails?.phone && `Phone: ${labDetails.phone}`}
                    {labDetails?.gst_number && ` | GST: ${labDetails.gst_number}`}
                  </p>
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
                      <span>GST ({selectedInvoice.tax_rate ? `${selectedInvoice.tax_rate.toFixed(1)}` : selectedInvoice.subtotal > 0 && selectedInvoice.tax > 0 ? `${((selectedInvoice.tax / (selectedInvoice.subtotal - selectedInvoice.discount)) * 100).toFixed(1)}` : '18'}%):</span>
                      <span>₹{selectedInvoice.tax.toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between font-bold text-lg border-t border-gray-300 pt-2">
                      <span>Total:</span>
                      <span>₹{selectedInvoice.total}</span>
                    </div>
                  </div>
                </div>

                <div className="mt-6 text-center text-sm text-gray-600">
                  <p>Thank you for choosing {labDetails?.name || 'our services'}!</p>
                  {labDetails?.email && <p>For queries, contact us at {labDetails.email}</p>}
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
                  onClick={() => {
                    setPdfInvoiceId(selectedInvoice.id);
                    setShowPdfModal(true);
                    setSelectedInvoice(null);
                  }}
                  className="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 transition-colors"
                >
                  <File className="h-4 w-4 mr-2 inline" />
                  Generate PDF
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

      {/* Refund Request Modal */}
      {showRefundModal && invoiceForRefund && (
        <RefundRequestModal
          isOpen={showRefundModal}
          onClose={() => {
            setShowRefundModal(false);
            setInvoiceForRefund(null);
          }}
          invoiceId={invoiceForRefund.id}
          invoiceTotal={invoiceForRefund.total}
          amountPaid={invoiceForRefund.paid_amount || 0}
          totalRefunded={(invoiceForRefund as any).total_refunded_amount || 0}
          patientName={invoiceForRefund.patient_name || invoiceForRefund.patientName}
          invoiceItems={invoiceForRefund.invoice_items || []}
          onSuccess={() => fetchInvoices()}
        />
      )}

      {/* PDF Generation Modal */}
      {showPdfModal && pdfInvoiceId && (
        <InvoiceGenerationModal
          invoiceId={pdfInvoiceId}
          onClose={() => {
            setShowPdfModal(false);
            setPdfInvoiceId(null);
          }}
          onSuccess={(pdfUrl) => {
            console.log('PDF generated:', pdfUrl);
            fetchInvoices(); // Refresh to show updated invoice with PDF
          }}
        />
      )}
    </div>
  );
};

export default Billing;
