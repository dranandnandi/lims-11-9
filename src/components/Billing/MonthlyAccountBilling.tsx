import React, { useState, useEffect } from 'react';
import { Search, FileText, Plus, Building, Eye } from 'lucide-react';
import { database } from '../../utils/supabase';
import type { Invoice, Account, ConsolidatedInvoice } from '../../types';

interface MonthlyAccountBillingProps {
  onClose?: () => void;
}

interface BillingPeriodSummary {
  period: string;
  accountCount: number;
  totalAmount: number;
  invoiceCount: number;
  patientCount: number;
}

interface AccountBillingSummary {
  account: Account;
  invoices: Invoice[];
  totalAmount: number;
  invoiceCount: number;
  patientCount: number;
  hasConsolidated: boolean;
  consolidatedInvoice?: ConsolidatedInvoice;
}

const MonthlyAccountBilling: React.FC<MonthlyAccountBillingProps> = ({ onClose }) => {
  const [loading, setLoading] = useState(true);
  const [selectedPeriod, setSelectedPeriod] = useState('');
  const [availablePeriods, setAvailablePeriods] = useState<BillingPeriodSummary[]>([]);
  const [accountSummaries, setAccountSummaries] = useState<AccountBillingSummary[]>([]);
  const [selectedAccount, setSelectedAccount] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [consolidating, setConsolidating] = useState<string | null>(null);
  const [previewInvoices, setPreviewInvoices] = useState<Invoice[]>([]);

  useEffect(() => {
    loadAvailablePeriods();
  }, []);

  useEffect(() => {
    if (selectedPeriod) {
      loadPeriodData();
    }
  }, [selectedPeriod]);

  const loadAvailablePeriods = async () => {
    try {
      setLoading(true);
      // Get all account invoices grouped by billing period
      const { data: invoices, error } = await database.invoices.getByBillingPeriod('');
      if (error) throw error;

      // Group by billing period
      const periodMap = new Map<string, Invoice[]>();
      (invoices || []).forEach((invoice) => {
        if (invoice.invoice_type === 'account' && invoice.billing_period) {
          const period = invoice.billing_period;
          if (!periodMap.has(period)) {
            periodMap.set(period, []);
          }
          periodMap.get(period)!.push(invoice);
        }
      });

      // Convert to summaries
      const periods = Array.from(periodMap.entries()).map(([period, periodInvoices]) => {
        const accounts = new Set(periodInvoices.map(inv => inv.account_id).filter(Boolean));
        const patients = new Set(periodInvoices.map(inv => inv.patient_id));
        const totalAmount = periodInvoices.reduce((sum, inv) => sum + (inv.total_after_discount || inv.total), 0);

        return {
          period,
          accountCount: accounts.size,
          totalAmount,
          invoiceCount: periodInvoices.length,
          patientCount: patients.size
        };
      }).sort((a, b) => b.period.localeCompare(a.period));

      setAvailablePeriods(periods);
      
      // Auto-select current month if available
      const currentMonth = new Date().toISOString().slice(0, 7);
      if (periods.find(p => p.period === currentMonth)) {
        setSelectedPeriod(currentMonth);
      } else if (periods.length > 0) {
        setSelectedPeriod(periods[0].period);
      }
    } catch (error) {
      console.error('Error loading periods:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadPeriodData = async () => {
    try {
      setLoading(true);
      const { data: invoices, error: invoicesError } = await database.invoices.getByBillingPeriod(selectedPeriod);
      if (invoicesError) throw invoicesError;

      // Get accounts using the correct API path  
      const { data: accounts, error: accountsError } = await (database as any).accounts?.getAll?.() || { data: [], error: null };
      if (accountsError) throw accountsError;

      const { data: consolidatedInvoices, error: consolidatedError } = await database.consolidatedInvoices.getAll();
      if (consolidatedError) throw consolidatedError;

      // Group invoices by account
      const accountMap = new Map<string, Invoice[]>();
      (invoices || []).forEach((invoice) => {
        if (invoice.invoice_type === 'account' && invoice.account_id) {
          if (!accountMap.has(invoice.account_id)) {
            accountMap.set(invoice.account_id, []);
          }
          accountMap.get(invoice.account_id)!.push(invoice);
        }
      });

      // Create account summaries
      const summaries: AccountBillingSummary[] = Array.from(accountMap.entries()).map(([accountId, accountInvoices]) => {
        const account = (accounts || []).find((acc: any) => acc.id === accountId);
        if (!account) return null;

        const totalAmount = accountInvoices.reduce((sum, inv) => sum + (inv.total_after_discount || inv.total), 0);
        const patients = new Set(accountInvoices.map(inv => inv.patient_id));
        
        // Check if already consolidated
        const consolidatedInvoice = (consolidatedInvoices || []).find(
          ci => ci.account_id === accountId && ci.billing_period === selectedPeriod
        );

        return {
          account,
          invoices: accountInvoices,
          totalAmount,
          invoiceCount: accountInvoices.length,
          patientCount: patients.size,
          hasConsolidated: !!consolidatedInvoice,
          consolidatedInvoice
        };
      }).filter(Boolean) as AccountBillingSummary[];

      setAccountSummaries(summaries.sort((a, b) => a.account.name.localeCompare(b.account.name)));
    } catch (error) {
      console.error('Error loading period data:', error);
    } finally {
      setLoading(false);
    }
  };

  const handlePreviewInvoices = (accountId: string) => {
    const summary = accountSummaries.find(s => s.account.id === accountId);
    if (summary) {
      setPreviewInvoices(summary.invoices);
      setSelectedAccount(accountId);
    }
  };

  const handleCreateConsolidatedInvoice = async (accountId: string) => {
    const summary = accountSummaries.find(s => s.account.id === accountId);
    if (!summary) return;

    setConsolidating(accountId);
    try {
      // Create consolidated invoice
      const consolidatedData = {
        account_id: accountId,
        account_name: summary.account.name,
        billing_period: selectedPeriod,
        subtotal: summary.invoices.reduce((sum, inv) => sum + inv.subtotal, 0),
        total_discount: summary.invoices.reduce((sum, inv) => sum + inv.total_discount, 0),
        tax: summary.invoices.reduce((sum, inv) => sum + (inv.tax || 0), 0),
        total: summary.totalAmount,
        status: 'Sent' as const,
        invoice_date: new Date().toISOString(),
        due_date: new Date(Date.now() + (summary.account.payment_terms || 30) * 24 * 60 * 60 * 1000).toISOString(),
        notes: `Consolidated invoice for ${summary.invoiceCount} orders covering ${summary.patientCount} patients`,
        invoice_count: summary.invoiceCount,
        patient_count: summary.patientCount
      };

      const { data: consolidatedInvoice, error: createError } = await database.consolidatedInvoices.create(consolidatedData);
      if (createError) throw createError;

      // Mark individual invoices as consolidated
      const invoiceIds = summary.invoices.map(inv => inv.id);
      const { error: markError } = await database.invoices.markAsConsolidated(invoiceIds, consolidatedInvoice.id);
      if (markError) throw markError;

      // Reload data
      await loadPeriodData();
      alert(`Consolidated invoice created successfully for ${summary.account.name}`);
    } catch (error) {
      console.error('Error creating consolidated invoice:', error);
      alert('Failed to create consolidated invoice. Please try again.');
    } finally {
      setConsolidating(null);
    }
  };

  const formatCurrency = (amount: number) => `₹${amount.toFixed(2)}`;
  const formatPeriod = (period: string) => {
    const [year, month] = period.split('-');
    const date = new Date(parseInt(year), parseInt(month) - 1);
    return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long' });
  };

  const filteredSummaries = accountSummaries.filter(summary =>
    summary.account.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    summary.account.type.toLowerCase().includes(searchTerm.toLowerCase())
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Monthly Account Billing</h2>
          <p className="text-gray-600">Generate consolidated invoices for B2B accounts</p>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50"
          >
            Close
          </button>
        )}
      </div>

      {/* Period Selector */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
        <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center">
          <div className="flex-1">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Select Billing Period
            </label>
            <select
              value={selectedPeriod}
              onChange={(e) => setSelectedPeriod(e.target.value)}
              className="w-full sm:w-48 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">Select period...</option>
              {availablePeriods.map(period => (
                <option key={period.period} value={period.period}>
                  {formatPeriod(period.period)} ({period.accountCount} accounts)
                </option>
              ))}
            </select>
          </div>

          {selectedPeriod && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
              <div>
                <div className="text-gray-600">Accounts</div>
                <div className="font-bold">{availablePeriods.find(p => p.period === selectedPeriod)?.accountCount || 0}</div>
              </div>
              <div>
                <div className="text-gray-600">Invoices</div>
                <div className="font-bold">{availablePeriods.find(p => p.period === selectedPeriod)?.invoiceCount || 0}</div>
              </div>
              <div>
                <div className="text-gray-600">Patients</div>
                <div className="font-bold">{availablePeriods.find(p => p.period === selectedPeriod)?.patientCount || 0}</div>
              </div>
              <div>
                <div className="text-gray-600">Total Amount</div>
                <div className="font-bold text-green-600">
                  {formatCurrency(availablePeriods.find(p => p.period === selectedPeriod)?.totalAmount || 0)}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Search and Filters */}
      {selectedPeriod && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
          <div className="flex gap-4">
            <div className="flex-1">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 w-5 h-5" />
                <input
                  type="text"
                  placeholder="Search accounts..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Account Summaries */}
      {selectedPeriod && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200">
          <div className="px-6 py-4 border-b border-gray-200">
            <h3 className="text-lg font-medium text-gray-900">
              Account Billing for {formatPeriod(selectedPeriod)}
            </h3>
          </div>

          <div className="divide-y divide-gray-200">
            {filteredSummaries.map(summary => (
              <div key={summary.account.id} className="p-6">
                <div className="flex items-center justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-3">
                      <Building className="w-5 h-5 text-gray-400" />
                      <div>
                        <h4 className="font-medium text-gray-900">{summary.account.name}</h4>
                        <p className="text-sm text-gray-500 capitalize">{summary.account.type}</p>
                      </div>
                    </div>
                    
                    <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
                      <div>
                        <span className="text-gray-600">Invoices:</span>
                        <span className="ml-1 font-medium">{summary.invoiceCount}</span>
                      </div>
                      <div>
                        <span className="text-gray-600">Patients:</span>
                        <span className="ml-1 font-medium">{summary.patientCount}</span>
                      </div>
                      <div>
                        <span className="text-gray-600">Total Amount:</span>
                        <span className="ml-1 font-medium text-green-600">
                          {formatCurrency(summary.totalAmount)}
                        </span>
                      </div>
                      <div>
                        <span className="text-gray-600">Status:</span>
                        <span className={`ml-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                          summary.hasConsolidated 
                            ? 'bg-green-100 text-green-800' 
                            : 'bg-yellow-100 text-yellow-800'
                        }`}>
                          {summary.hasConsolidated ? 'Consolidated' : 'Pending'}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handlePreviewInvoices(summary.account.id)}
                      className="px-3 py-2 text-sm border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50 flex items-center gap-1"
                    >
                      <Eye className="w-4 h-4" />
                      Preview
                    </button>

                    {summary.hasConsolidated ? (
                      <button
                        className="px-3 py-2 text-sm bg-gray-100 text-gray-500 rounded-md cursor-not-allowed flex items-center gap-1"
                        disabled
                      >
                        <FileText className="w-4 h-4" />
                        Consolidated
                      </button>
                    ) : (
                      <button
                        onClick={() => handleCreateConsolidatedInvoice(summary.account.id)}
                        disabled={consolidating === summary.account.id}
                        className="px-3 py-2 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1"
                      >
                        <Plus className="w-4 h-4" />
                        {consolidating === summary.account.id ? 'Creating...' : 'Create Consolidated'}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}

            {filteredSummaries.length === 0 && (
              <div className="p-8 text-center text-gray-500">
                {searchTerm 
                  ? 'No accounts found matching your search'
                  : 'No account invoices found for this period'
                }
              </div>
            )}
          </div>
        </div>
      )}

      {/* Invoice Preview Modal */}
      {selectedAccount && previewInvoices.length > 0 && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 w-full max-w-4xl max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-6">
              <h3 className="text-xl font-bold text-gray-900">
                Preview Invoices - {accountSummaries.find(s => s.account.id === selectedAccount)?.account.name}
              </h3>
              <button
                onClick={() => {
                  setSelectedAccount(null);
                  setPreviewInvoices([]);
                }}
                className="text-gray-400 hover:text-gray-600"
              >
                ×
              </button>
            </div>

            <div className="space-y-4">
              {previewInvoices.map(invoice => (
                <div key={invoice.id} className="border border-gray-200 rounded-lg p-4">
                  <div className="flex justify-between items-start">
                    <div>
                      <div className="font-medium">Invoice #{invoice.id.slice(0, 8)}</div>
                      <div className="text-sm text-gray-600">{invoice.patient_name}</div>
                      <div className="text-sm text-gray-500">
                        {new Date(invoice.invoice_date).toLocaleDateString()}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-bold text-green-600">
                        {formatCurrency(invoice.total_after_discount || invoice.total)}
                      </div>
                      <div className="text-sm text-gray-500">
                        Status: {invoice.status}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-6 pt-4 border-t border-gray-200">
              <div className="flex justify-between items-center">
                <div className="font-medium">
                  Total: {previewInvoices.length} invoices
                </div>
                <div className="font-bold text-lg text-green-600">
                  {formatCurrency(
                    previewInvoices.reduce((sum, inv) => sum + (inv.total_after_discount || inv.total), 0)
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default MonthlyAccountBilling;