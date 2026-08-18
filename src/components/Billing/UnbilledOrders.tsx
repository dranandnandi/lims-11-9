import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, Briefcase, CheckCircle2, FileText, Loader2, Receipt, Search } from 'lucide-react';
import { endOfDay, isValid, parseISO, startOfDay } from 'date-fns';

import { database, supabase } from '../../utils/supabase';
import { createInvoiceForOrder, toNum } from '../../utils/orderInvoicing';
import CreateInvoiceModal from './CreateInvoiceModal';

type DateRangePreset = 'custom' | 'today' | '7d' | '30d' | '90d' | 'all';
type BillToScope = 'all' | 'account' | 'location' | 'self';

interface UnbilledOrderTest {
  id: string;
  test_name: string;
  price: number | null;
  is_billed: boolean;
  package_id: string | null;
  test_group_id: string | null;
}

interface UnbilledOrder {
  id: string;
  order_number: number | null;
  order_display: string | null;
  sample_id: string | null;
  order_date: string;
  patient_id: string | null;
  patient_name: string;
  payment_type: string | null;
  billing_status: string | null;
  collection_charge: number | null;
  account_id: string | null;
  location_id: string | null;
  order_tests: UnbilledOrderTest[];
  order_billing_items: { id: string; amount: number | null; is_invoiced: boolean }[];
  // Derived
  unbilledTestCount: number;
  totalTestCount: number;
  pendingChargeTotal: number;
  estimatedAmount: number;
  billToScope: Exclude<BillToScope, 'all'>;
}

interface BulkResult {
  created: number;
  failed: { order: UnbilledOrder; message: string }[];
}

const formatISODate = (date: Date) => date.toISOString().split('T')[0];

/** Package rows carry the price; the tests inside a package are billed at 0. */
const isTestInsidePackage = (test: UnbilledOrderTest) => !!test.package_id && !!test.test_group_id;

const UnbilledOrders: React.FC = () => {
  const [orders, setOrders] = useState<UnbilledOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [searchTerm, setSearchTerm] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [datePreset, setDatePreset] = useState<DateRangePreset>('30d');
  const [billToScope, setBillToScope] = useState<BillToScope>('all');
  const [selectedAccountId, setSelectedAccountId] = useState<string>('all');
  const [selectedLocationId, setSelectedLocationId] = useState<string>('all');

  const [locations, setLocations] = useState<{ id: string; name: string }[]>([]);
  const [accounts, setAccounts] = useState<{ id: string; name: string }[]>([]);

  const [selectedOrderIds, setSelectedOrderIds] = useState<Set<string>>(new Set());
  const [billingInProgress, setBillingInProgress] = useState(false);
  const [billingProgress, setBillingProgress] = useState<string | null>(null);
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null);

  // Single-order review flow reuses the existing modal
  const [reviewOrderId, setReviewOrderId] = useState<string | null>(null);

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
    const startDate = new Date(today);
    const offsets: Record<Exclude<DateRangePreset, 'custom'>, number> = {
      today: 0,
      '7d': 7,
      '30d': 30,
      '90d': 90,
      all: 0,
    };
    startDate.setDate(startDate.getDate() - offsets[preset]);

    setDateFrom(formatISODate(startDate));
    setDateTo(formatISODate(today));
  }, []);

  useEffect(() => {
    applyQuickRange('30d');
  }, [applyQuickRange]);

  useEffect(() => {
    const loadFilterOptions = async () => {
      const [userLocInfo, { data: allLocations }, { data: allAccounts }] = await Promise.all([
        database.shouldFilterByLocation(),
        database.locations.getAll(),
        (database as any).accounts.getAll(),
      ]);

      if (allLocations) {
        const visible = userLocInfo.canViewAll || !userLocInfo.shouldFilter
          ? allLocations
          : allLocations.filter((l: any) => userLocInfo.locationIds.includes(l.id));
        setLocations(visible.map((l: any) => ({ id: l.id, name: l.name })));
      }

      setAccounts((allAccounts || []).map((a: any) => ({ id: a.id, name: a.name })));
    };
    loadFilterOptions().catch(err => console.error('Error loading filter options:', err));
  }, []);

  const loadOrders = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const labId = await database.getCurrentUserLabId();
      const { shouldFilter, locationIds } = await database.shouldFilterByLocation();

      const ORDER_COLUMNS = `
        id, order_number, order_display, sample_id, order_date, patient_id, patient_name,
        payment_type, billing_status, is_billed, collection_charge, account_id, location_id,
        order_tests(id, test_name, price, is_billed, package_id, test_group_id),
        order_billing_items(id, amount, is_invoiced)
      `;

      // Shared scope: lab, permitted locations, selected date range.
      const scopedQuery = () => {
        let q = supabase
          .from('orders')
          .select(ORDER_COLUMNS)
          .eq('lab_id', labId)
          .order('order_date', { ascending: false });

        if (shouldFilter && locationIds.length > 0) {
          q = q.in('location_id', locationIds);
        }
        if (dateFrom) {
          const parsedFrom = parseISO(dateFrom);
          q = q.gte('order_date', isValid(parsedFrom) ? startOfDay(parsedFrom).toISOString() : dateFrom);
        }
        if (dateTo) {
          const parsedTo = parseISO(dateTo);
          q = q.lte('order_date', isValid(parsedTo) ? endOfDay(parsedTo).toISOString() : dateTo);
        }
        return q;
      };

      // Anything not fully billed yet: pending, partial, or never stamped
      const query = scopedQuery().or('billing_status.is.null,billing_status.neq.billed');

      // PostgREST caps every response at 1000 rows, so page until a short page ends it.
      const PAGE_SIZE = 500;
      const rows: any[] = [];
      for (let from = 0; ; from += PAGE_SIZE) {
        const { data: page, error: pageError } = await query.range(from, from + PAGE_SIZE - 1);
        if (pageError) throw pageError;
        rows.push(...(page || []));
        if (!page || page.length < PAGE_SIZE) break;
      }

      // An extra charge added *after* the order was invoiced leaves it stamped 'billed',
      // so the status filter above misses it and the charge can never be billed. Pull
      // those orders back in explicitly.
      const { data: pendingChargeRows, error: chargeError } = await supabase
        .from('order_billing_items')
        .select('order_id')
        .eq('lab_id', labId)
        .eq('is_invoiced', false);
      if (chargeError) throw chargeError;

      const alreadyLoaded = new Set(rows.map(r => r.id));
      const strandedIds = [...new Set((pendingChargeRows || []).map((c: any) => c.order_id))]
        .filter((id: string) => id && !alreadyLoaded.has(id));

      // Chunked so the .in() list stays inside PostgREST's URL length limit.
      for (let i = 0; i < strandedIds.length; i += 100) {
        const { data: strandedPage, error: strandedError } = await scopedQuery()
          .in('id', strandedIds.slice(i, i + 100));
        if (strandedError) throw strandedError;
        rows.push(...(strandedPage || []));
      }

      const mapped: UnbilledOrder[] = rows.map((o: any) => {
        const tests: UnbilledOrderTest[] = o.order_tests || [];
        const billableTests = tests.filter(t => !isTestInsidePackage(t));
        const unbilledTests = billableTests.filter(t => !t.is_billed);
        const pendingCharges = (o.order_billing_items || []).filter((c: any) => !c.is_invoiced);
        const pendingChargeTotal = pendingCharges.reduce((s: number, c: any) => s + toNum(c.amount), 0);

        // An already-invoiced order carries an invoiced collection charge, so only
        // count it for orders that have not been billed at all yet.
        const alreadyInvoiced = o.billing_status === 'partial' || o.billing_status === 'billed';
        const collectionCharge = alreadyInvoiced ? 0 : toNum(o.collection_charge);
        const testTotal = unbilledTests.reduce((s, t) => s + toNum(t.price), 0);

        return {
          ...o,
          order_tests: tests,
          order_billing_items: o.order_billing_items || [],
          unbilledTestCount: unbilledTests.length,
          totalTestCount: billableTests.length,
          pendingChargeTotal,
          estimatedAmount: testTotal + pendingChargeTotal + collectionCharge,
          billToScope: o.account_id ? 'account' : o.location_id ? 'location' : 'self',
        } as UnbilledOrder;
      })
        // Orders whose tests are all billed have nothing left to invoice, even if
        // their billing_status was never stamped.
        .filter(o => o.unbilledTestCount > 0 || o.pendingChargeTotal > 0);

      setOrders(mapped);
      setSelectedOrderIds(new Set());
    } catch (err) {
      console.error('Error loading unbilled orders:', err);
      setError(err instanceof Error ? err.message : 'Failed to load unbilled orders');
    } finally {
      setLoading(false);
    }
  }, [dateFrom, dateTo]);

  useEffect(() => {
    loadOrders();
  }, [loadOrders]);

  const accountNameById = useMemo(
    () => new Map(accounts.map(a => [a.id, a.name])),
    [accounts]
  );
  const locationNameById = useMemo(
    () => new Map(locations.map(l => [l.id, l.name])),
    [locations]
  );

  const filteredOrders = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    return orders.filter(order => {
      if (billToScope !== 'all' && order.billToScope !== billToScope) return false;
      if (selectedAccountId !== 'all' && order.account_id !== selectedAccountId) return false;
      if (selectedLocationId !== 'all' && order.location_id !== selectedLocationId) return false;
      if (!term) return true;
      return (
        (order.patient_name || '').toLowerCase().includes(term) ||
        (order.sample_id || '').toLowerCase().includes(term) ||
        String(order.order_number || '').includes(term) ||
        order.id.toLowerCase().includes(term)
      );
    });
  }, [orders, searchTerm, billToScope, selectedAccountId, selectedLocationId]);

  const selectedOrders = useMemo(
    () => filteredOrders.filter(o => selectedOrderIds.has(o.id)),
    [filteredOrders, selectedOrderIds]
  );
  const selectedTotal = selectedOrders.reduce((s, o) => s + o.estimatedAmount, 0);
  const unbilledTotal = filteredOrders.reduce((s, o) => s + o.estimatedAmount, 0);
  const b2bCount = filteredOrders.filter(o => o.billToScope === 'account').length;

  const toggleOrder = (orderId: string) => {
    setSelectedOrderIds(prev => {
      const next = new Set(prev);
      if (next.has(orderId)) next.delete(orderId);
      else next.add(orderId);
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelectedOrderIds(prev => {
      const visibleIds = filteredOrders.map(o => o.id);
      const allSelected = visibleIds.length > 0 && visibleIds.every(id => prev.has(id));
      return allSelected ? new Set<string>() : new Set(visibleIds);
    });
  };

  const handleBulkCreateInvoices = async () => {
    if (selectedOrders.length === 0) {
      alert('Please select at least one order.');
      return;
    }

    const b2bSelected = selectedOrders.filter(o => o.billToScope === 'account').length;
    const confirmMessage =
      `Create ${selectedOrders.length} invoice${selectedOrders.length === 1 ? '' : 's'} ` +
      `(one per order) totalling about ₹${selectedTotal.toFixed(2)}?` +
      (b2bSelected > 0 ? `\n\n${b2bSelected} will be posted as B2B credit invoices to their account ledger.` : '') +
      `\n\nDefault discounts (account price list, location, doctor) will be applied automatically.`;
    if (!window.confirm(confirmMessage)) return;

    setBillingInProgress(true);
    setBulkResult(null);
    const failed: BulkResult['failed'] = [];
    let created = 0;

    // Sequential on purpose: each invoice updates its order and may post a credit
    // transaction, and the account ledger should not be written concurrently.
    for (let i = 0; i < selectedOrders.length; i++) {
      const order = selectedOrders[i];
      setBillingProgress(`Billing ${i + 1}/${selectedOrders.length} — ${order.patient_name}`);
      try {
        await createInvoiceForOrder(order.id);
        created++;
      } catch (err) {
        console.error(`Failed to create invoice for order ${order.id}:`, err);
        failed.push({ order, message: err instanceof Error ? err.message : 'Unknown error' });
      }
    }

    setBillingInProgress(false);
    setBillingProgress(null);
    setBulkResult({ created, failed });
    await loadOrders();
  };

  const scopeLabel: Record<Exclude<BillToScope, 'all'>, string> = {
    account: 'B2B Account',
    location: 'Location',
    self: 'Direct',
  };

  const billToName = (order: UnbilledOrder) => {
    if (order.account_id) return accountNameById.get(order.account_id) || 'Account';
    if (order.location_id) return locationNameById.get(order.location_id) || 'Location';
    return 'Direct Pay';
  };

  return (
    <div className="space-y-6">
      {/* Summary */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-gradient-to-r from-amber-50 to-amber-100 rounded-lg shadow-sm border border-amber-200 p-6">
          <div className="flex items-center">
            <div className="bg-amber-500 p-3 rounded-lg">
              <Receipt className="h-6 w-6 text-white" />
            </div>
            <div className="ml-4">
              <div className="text-2xl font-bold text-amber-900">{filteredOrders.length}</div>
              <div className="text-sm text-amber-700">Unbilled Orders</div>
            </div>
          </div>
        </div>

        <div className="bg-gradient-to-r from-blue-50 to-blue-100 rounded-lg shadow-sm border border-blue-200 p-6">
          <div className="flex items-center">
            <div className="bg-blue-500 p-3 rounded-lg">
              <FileText className="h-6 w-6 text-white" />
            </div>
            <div className="ml-4">
              <div className="text-2xl font-bold text-blue-900">₹{unbilledTotal.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
              <div className="text-sm text-blue-700">Estimated Value</div>
            </div>
          </div>
        </div>

        <div className="bg-gradient-to-r from-purple-50 to-purple-100 rounded-lg shadow-sm border border-purple-200 p-6">
          <div className="flex items-center">
            <div className="bg-purple-500 p-3 rounded-lg">
              <Briefcase className="h-6 w-6 text-white" />
            </div>
            <div className="ml-4">
              <div className="text-2xl font-bold text-purple-900">{b2bCount}</div>
              <div className="text-sm text-purple-700">B2B Account Orders</div>
            </div>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 space-y-4">
        <div className="flex flex-col lg:flex-row gap-4">
          <div className="flex-1">
            <label className="text-sm font-medium text-gray-600 mb-1 block">Search</label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search by patient name, SID or order number..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-10 pr-4 py-2 w-full border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
          </div>
          <div className="w-full lg:w-48">
            <label className="text-sm font-medium text-gray-600 mb-1 block">Bill To</label>
            <select
              value={billToScope}
              onChange={(e) => setBillToScope(e.target.value as BillToScope)}
              className="px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 w-full"
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
              className="px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 w-full"
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
                onChange={(e) => { setDateFrom(e.target.value); setDatePreset('custom'); }}
                className="px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div className="flex flex-col">
              <span className="text-sm font-medium text-gray-600 mb-1">To</span>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => { setDateTo(e.target.value); setDatePreset('custom'); }}
                className="px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
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

          {locations.length > 0 && (
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium text-gray-600">Location</span>
              <select
                value={selectedLocationId}
                onChange={(e) => setSelectedLocationId(e.target.value)}
                className="px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
              >
                <option value="all">All Locations</option>
                {locations.map(location => (
                  <option key={location.id} value={location.id}>{location.name}</option>
                ))}
              </select>
            </div>
          )}
        </div>
      </div>

      {/* Bulk result banner */}
      {bulkResult && (
        <div className={`rounded-lg border p-4 ${bulkResult.failed.length > 0 ? 'bg-amber-50 border-amber-200' : 'bg-green-50 border-green-200'}`}>
          <div className="flex items-start gap-3">
            {bulkResult.failed.length > 0
              ? <AlertCircle className="h-5 w-5 text-amber-600 mt-0.5" />
              : <CheckCircle2 className="h-5 w-5 text-green-600 mt-0.5" />}
            <div className="flex-1">
              <div className={`font-medium ${bulkResult.failed.length > 0 ? 'text-amber-900' : 'text-green-900'}`}>
                {bulkResult.created} invoice{bulkResult.created === 1 ? '' : 's'} created
                {bulkResult.failed.length > 0 && ` · ${bulkResult.failed.length} failed`}
              </div>
              {bulkResult.failed.length > 0 && (
                <ul className="mt-2 text-sm text-amber-800 space-y-1">
                  {bulkResult.failed.map(({ order, message }) => (
                    <li key={order.id}>
                      {order.sample_id || `#${order.id.slice(0, 8)}`} ({order.patient_name}) — {message}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <button onClick={() => setBulkResult(null)} className="text-gray-400 hover:text-gray-600">×</button>
          </div>
        </div>
      )}

      {/* Table */}
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
              Unbilled Orders ({filteredOrders.length})
            </h3>
            {selectedOrders.length > 0 && (
              <div className="flex items-center gap-3">
                <span className="text-sm font-medium text-blue-900">
                  {selectedOrders.length} selected · ₹{selectedTotal.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                </span>
                <button
                  onClick={() => setSelectedOrderIds(new Set())}
                  className="text-sm text-blue-700 hover:text-blue-900 underline"
                  disabled={billingInProgress}
                >
                  Clear
                </button>
                <button
                  onClick={handleBulkCreateInvoices}
                  disabled={billingInProgress}
                  className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                    billingInProgress
                      ? 'bg-blue-300 text-white cursor-not-allowed'
                      : 'bg-blue-600 text-white hover:bg-blue-700'
                  }`}
                  title="Create one invoice per selected order using the default discount rules"
                >
                  {billingInProgress
                    ? <Loader2 className="w-4 h-4 animate-spin" />
                    : <Receipt className="w-4 h-4" />}
                  <span>
                    {billingInProgress
                      ? (billingProgress || 'Creating…')
                      : `Create ${selectedOrders.length} Invoice${selectedOrders.length === 1 ? '' : 's'}`}
                  </span>
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
                      checked={filteredOrders.length > 0 && filteredOrders.every(o => selectedOrderIds.has(o.id))}
                      onChange={toggleSelectAll}
                      className="h-4 w-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                      title="Select all"
                    />
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Order</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Patient</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Bill To</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Unbilled Items</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Est. Amount</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {filteredOrders.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-6 py-4 text-center text-gray-500">
                      No unbilled orders found
                    </td>
                  </tr>
                ) : (
                  filteredOrders.map(order => (
                    <tr key={order.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-4">
                        <input
                          type="checkbox"
                          checked={selectedOrderIds.has(order.id)}
                          onChange={() => toggleOrder(order.id)}
                          disabled={billingInProgress}
                          className="h-4 w-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                        />
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm font-medium text-gray-900">
                          {order.order_display || `#${order.id.slice(0, 8)}`}
                        </div>
                        {order.sample_id && (
                          <div className="text-xs text-purple-600 font-medium mt-0.5" title="Sample ID">
                            SID: {order.sample_id}
                          </div>
                        )}
                        <div className="text-xs text-gray-500 mt-0.5">
                          {new Date(order.order_date).toLocaleDateString()}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm font-medium text-gray-900">{order.patient_name}</div>
                        <div className="text-sm text-gray-500">
                          ID: {(order.patient_id || '').slice(0, 8)}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                          order.billToScope === 'account' ? 'bg-purple-100 text-purple-800' :
                          order.billToScope === 'location' ? 'bg-orange-100 text-orange-800' :
                          'bg-gray-100 text-gray-800'
                        }`}>
                          {scopeLabel[order.billToScope]}
                        </span>
                        <div className="text-xs text-gray-600 mt-1 truncate max-w-32" title={billToName(order)}>
                          {billToName(order)}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-700">
                        <div>{order.unbilledTestCount} of {order.totalTestCount} tests</div>
                        {order.pendingChargeTotal > 0 && (
                          <div className="text-xs text-amber-700 mt-0.5">
                            + charges ₹{order.pendingChargeTotal.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                          </div>
                        )}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm font-bold text-gray-900">
                          ₹{order.estimatedAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                        </div>
                        <div className="text-xs text-gray-500">before discounts</div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                          order.billing_status === 'partial' || order.billing_status === 'billed'
                            ? 'bg-orange-100 text-orange-800'
                            : 'bg-yellow-100 text-yellow-800'
                        }`}>
                          {/* 'billed' only reaches this list when a charge was added after
                              the invoice, which is the same "something is left" state. */}
                          {order.billing_status === 'partial' || order.billing_status === 'billed'
                            ? 'Partially Billed'
                            : 'Unbilled'}
                        </span>
                        {order.payment_type && order.payment_type !== 'self' && (
                          <div className="text-xs text-gray-500 mt-1 capitalize">{order.payment_type}</div>
                        )}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                        <button
                          onClick={() => setReviewOrderId(order.id)}
                          disabled={billingInProgress}
                          className="px-3 py-1.5 rounded-md border border-blue-200 text-blue-700 hover:bg-blue-50 disabled:opacity-50"
                          title="Open the full invoice builder for this order"
                        >
                          Review &amp; Bill
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {reviewOrderId && (
        <CreateInvoiceModal
          orderId={reviewOrderId}
          onClose={() => setReviewOrderId(null)}
          onSuccess={() => {
            setReviewOrderId(null);
            loadOrders();
          }}
        />
      )}
    </div>
  );
};

export default UnbilledOrders;
