import React, { useEffect, useMemo, useState } from 'react';
import {
  Building2, Calendar, ChevronDown, ChevronUp, Columns3, FileDown, FileSpreadsheet, Loader2,
  Printer, RefreshCw, Search, Users, TestTube, Receipt
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { database, supabase, formatAge } from '../utils/supabase';
import {
  B2B_PDF_OPTIONAL_COLUMNS,
  downloadB2BPatientListPdf,
  printB2BPatientListPdf,
  type B2BPatientPdfColumnKey,
  type B2BPatientPdfOptions,
  type B2BPatientPdfRow,
} from '../utils/b2bPatientListPdf';

interface AccountOption {
  id: string;
  name: string;
  code: string | null;
  type: string;
}

interface OrderTestRow {
  id: string;
  test_name: string;
  price: number | null;
  is_canceled: boolean;
}

interface B2BOrderRow {
  id: string;
  order_display: string | null;
  sample_id: string | null;
  order_date: string;
  status: string;
  total_amount: number | null;
  billing_status: string | null;
  is_billed: boolean | null;
  doctor: string | null;
  patient_id: string;
  patient_name: string;
  account_id: string;
  accounts: { id: string; name: string; code: string | null } | null;
  patients: {
    display_id: string | null;
    patient_number: string | null;
    age: number | null;
    age_unit: string | null;
    gender: string | null;
    phone: string | null;
    email: string | null;
  } | null;
  order_tests: OrderTestRow[] | null;
}

const MAX_ROWS = 5000;

const firstOfMonth = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
};

const today = () => new Date().toISOString().split('T')[0];

// Order dates are plain yyyy-MM-dd; parsing them as Date would shift the day
const formatDate = (value: string | null) => {
  if (!value) return '';
  const [year, month, day] = value.slice(0, 10).split('-');
  return year && month && day ? `${day}/${month}/${year}` : value;
};

const formatCurrency = (amount: number) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(amount);

type ColumnKey = B2BPatientPdfColumnKey;

/**
 * Column visibility drives both the on-screen table and the PDF, so what you see
 * is what prints. Order / Sample is off by default - the patient ID already
 * carries the accession date, so the two columns repeat each other.
 */
const DEFAULT_COLUMNS: Record<ColumnKey, boolean> = {
  date: true,
  orderRef: false,
  patientCode: true,
  ageGender: true,
  phone: true,
  doctor: false,
  tests: true,
  status: true,
  billing: true,
  amount: true,
};

const COLUMN_PREF_KEY = 'b2bPatientList.columns.v1';

const loadColumnPrefs = (): Record<ColumnKey, boolean> => {
  try {
    const saved = localStorage.getItem(COLUMN_PREF_KEY);
    if (!saved) return { ...DEFAULT_COLUMNS };
    const parsed = JSON.parse(saved) as Partial<Record<ColumnKey, boolean>>;
    // Merge over the defaults so a newly added column still shows up
    const merged = { ...DEFAULT_COLUMNS };
    (Object.keys(DEFAULT_COLUMNS) as ColumnKey[]).forEach((key) => {
      if (typeof parsed?.[key] === 'boolean') merged[key] = parsed[key] as boolean;
    });
    return merged;
  } catch {
    return { ...DEFAULT_COLUMNS };
  }
};

const B2BPatientList: React.FC = () => {
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [orders, setOrders] = useState<B2BOrderRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [labName, setLabName] = useState<string | undefined>();

  const [accountId, setAccountId] = useState('all');
  const [fromDate, setFromDate] = useState(firstOfMonth);
  const [toDate, setToDate] = useState(today);
  const [statusFilter, setStatusFilter] = useState('all');
  const [searchTerm, setSearchTerm] = useState('');

  const [columns, setColumns] = useState<Record<ColumnKey, boolean>>(loadColumnPrefs);
  const [showTestRates, setShowTestRates] = useState(true);
  const [showColumnPicker, setShowColumnPicker] = useState(false);

  useEffect(() => {
    loadAccounts();
    loadLabName();
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(COLUMN_PREF_KEY, JSON.stringify(columns));
    } catch {
      // A blocked localStorage just means the choice resets next visit
    }
  }, [columns]);

  useEffect(() => {
    loadOrders();
    // Re-query whenever the server-side filters change; search/status filter locally
  }, [accountId, fromDate, toDate]);

  const loadAccounts = async () => {
    try {
      const labId = await database.getCurrentUserLabId();
      if (!labId) return;

      const { data, error: accountsError } = await supabase
        .from('accounts')
        .select('id, name, code, type')
        .eq('lab_id', labId)
        .order('name');

      if (accountsError) throw accountsError;
      setAccounts(data || []);
    } catch (err: any) {
      console.error('Error loading accounts:', err);
    }
  };

  const loadLabName = async () => {
    try {
      const labId = await database.getCurrentUserLabId();
      if (!labId) return;
      const { data } = await supabase.from('labs').select('name').eq('id', labId).single();
      setLabName(data?.name || undefined);
    } catch {
      // The PDF header falls back to a generic title if the lab name can't be read
    }
  };

  const loadOrders = async () => {
    try {
      setLoading(true);
      setError(null);

      const labId = await database.getCurrentUserLabId();
      if (!labId) {
        setError('Unable to determine lab. Please log in again.');
        return;
      }

      let query = supabase
        .from('orders')
        .select(`
          id, order_display, sample_id, order_date, status, total_amount,
          billing_status, is_billed, doctor, patient_id, patient_name, account_id,
          accounts(id, name, code),
          patients(display_id, patient_number, age, age_unit, gender, phone, email),
          order_tests(id, test_name, price, is_canceled)
        `)
        .eq('lab_id', labId)
        .not('account_id', 'is', null)
        .order('order_date', { ascending: false })
        .limit(MAX_ROWS);

      if (accountId !== 'all') query = query.eq('account_id', accountId);
      if (fromDate) query = query.gte('order_date', fromDate);
      if (toDate) query = query.lte('order_date', toDate);

      const { data, error: ordersError } = await query;
      if (ordersError) throw ordersError;

      setOrders((data || []) as unknown as B2BOrderRow[]);
      setTruncated((data || []).length >= MAX_ROWS);
    } catch (err: any) {
      console.error('Error loading B2B patient list:', err);
      setOrders([]);
      setError(err?.message || 'Failed to load the B2B patient list');
    } finally {
      setLoading(false);
    }
  };

  const activeTests = (order: B2BOrderRow) => (order.order_tests || []).filter((test) => !test.is_canceled);

  const orderAmount = (order: B2BOrderRow) => {
    const total = Number(order.total_amount);
    if (Number.isFinite(total) && total > 0) return total;
    // Orders billed purely through their tests can carry a zero header amount
    return activeTests(order).reduce((sum, test) => sum + (Number(test.price) || 0), 0);
  };

  const patientCode = (order: B2BOrderRow) =>
    order.patients?.display_id || order.patients?.patient_number || `#${order.patient_id.slice(0, 8).toUpperCase()}`;

  const orderRef = (order: B2BOrderRow) =>
    order.order_display || order.sample_id || `#${order.id.slice(0, 8).toUpperCase()}`;

  const statusOptions = useMemo(
    () => Array.from(new Set(orders.map((order) => order.status).filter(Boolean))).sort(),
    [orders]
  );

  const filteredOrders = useMemo(() => {
    const search = searchTerm.trim().toLowerCase();
    return orders.filter((order) => {
      if (statusFilter !== 'all' && order.status !== statusFilter) return false;
      if (!search) return true;
      return (
        (order.patient_name || '').toLowerCase().includes(search) ||
        patientCode(order).toLowerCase().includes(search) ||
        orderRef(order).toLowerCase().includes(search) ||
        (order.patients?.phone || '').toLowerCase().includes(search) ||
        (order.accounts?.name || '').toLowerCase().includes(search) ||
        activeTests(order).some((test) => (test.test_name || '').toLowerCase().includes(search))
      );
    });
  }, [orders, statusFilter, searchTerm]);

  // Group by partner so an "All partners" run reads like a partner-wise report
  const groupedOrders = useMemo(() => {
    const groups = new Map<string, { name: string; code: string | null; rows: B2BOrderRow[] }>();
    filteredOrders.forEach((order) => {
      const key = order.account_id;
      if (!groups.has(key)) {
        groups.set(key, {
          name: order.accounts?.name || 'Unknown partner',
          code: order.accounts?.code || null,
          rows: [],
        });
      }
      groups.get(key)!.rows.push(order);
    });
    return Array.from(groups.entries())
      .map(([id, group]) => ({ id, ...group }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [filteredOrders]);

  const totals = useMemo(() => {
    const patientIds = new Set(filteredOrders.map((order) => order.patient_id));
    const testCount = filteredOrders.reduce((sum, order) => sum + activeTests(order).length, 0);
    const amount = filteredOrders.reduce((sum, order) => sum + orderAmount(order), 0);
    return {
      partners: new Set(filteredOrders.map((order) => order.account_id)).size,
      patients: patientIds.size,
      orders: filteredOrders.length,
      tests: testCount,
      amount,
    };
  }, [filteredOrders]);

  const visibleColumnCount = (Object.keys(columns) as ColumnKey[]).filter((key) => columns[key]).length;

  // Same visibility rules as the PDF, so the table and the printout stay in sync
  const tableColumns = useMemo(() => {
    const ageGender = (order: B2BOrderRow) =>
      [
        order.patients?.age != null ? formatAge(order.patients.age, order.patients.age_unit) : '',
        order.patients?.gender || '',
      ].filter(Boolean).join(' / ') || '-';

    const defs: {
      key: ColumnKey | 'patient';
      label: string;
      align?: 'right';
      nowrap?: boolean;
      render: (order: B2BOrderRow) => React.ReactNode;
    }[] = [
      {
        key: 'date',
        label: 'Date',
        nowrap: true,
        render: (order) => <span className="text-sm text-gray-600">{formatDate(order.order_date)}</span>,
      },
      {
        key: 'orderRef',
        label: 'Order / Sample',
        nowrap: true,
        render: (order) => <span className="font-mono text-xs text-gray-600">{orderRef(order)}</span>,
      },
      {
        key: 'patientCode',
        label: 'Patient ID',
        nowrap: true,
        render: (order) => <span className="font-mono text-xs text-gray-600">{patientCode(order)}</span>,
      },
      {
        key: 'patient',
        label: 'Patient',
        render: (order) => (
          <span className="text-sm font-medium text-gray-900">{order.patient_name || '-'}</span>
        ),
      },
      {
        key: 'ageGender',
        label: 'Age / Gender',
        nowrap: true,
        render: (order) => <span className="text-sm text-gray-600">{ageGender(order)}</span>,
      },
      {
        key: 'phone',
        label: 'Phone',
        nowrap: true,
        render: (order) => <span className="text-sm text-gray-600">{order.patients?.phone || '-'}</span>,
      },
      {
        key: 'doctor',
        label: 'Ref. Doctor',
        render: (order) => <span className="text-sm text-gray-600">{order.doctor || '-'}</span>,
      },
      {
        key: 'tests',
        label: 'Tests',
        render: (order) => {
          const tests = activeTests(order);
          if (tests.length === 0) return <span className="text-sm text-gray-400">-</span>;
          return (
            <div className="flex flex-wrap gap-1">
              {tests.map((test) => (
                <span
                  key={test.id}
                  className="inline-flex items-center rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-700"
                  title={test.price != null ? `Rate: ${formatCurrency(Number(test.price))}` : undefined}
                >
                  {test.test_name}
                  {showTestRates && test.price != null && (
                    <span className="ml-1 text-gray-500">{formatCurrency(Number(test.price))}</span>
                  )}
                </span>
              ))}
            </div>
          );
        },
      },
      {
        key: 'status',
        label: 'Status',
        nowrap: true,
        render: (order) => (
          <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">
            {order.status}
          </span>
        ),
      },
      {
        key: 'billing',
        label: 'Billing',
        nowrap: true,
        render: (order) => (
          <span
            className={`text-xs font-medium uppercase tracking-wide ${
              order.is_billed ? 'text-green-600' : 'text-amber-600'
            }`}
          >
            {order.is_billed ? 'Billed' : (order.billing_status || 'pending')}
          </span>
        ),
      },
      {
        key: 'amount',
        label: 'Amount',
        align: 'right',
        nowrap: true,
        render: (order) => (
          <span className="text-sm font-medium text-gray-900">{formatCurrency(orderAmount(order))}</span>
        ),
      },
    ];

    return defs.filter((def) => def.key === 'patient' || columns[def.key as ColumnKey]);
  }, [columns, showTestRates]);

  const selectedAccountName =
    accountId === 'all' ? 'All partners' : accounts.find((account) => account.id === accountId)?.name || 'Partner';

  // The PDF is built from the same filtered rows the table renders, so both always agree
  const pdfRows = (): B2BPatientPdfRow[] =>
    filteredOrders.map((order) => ({
      partnerId: order.account_id,
      partnerName: order.accounts?.name || 'Unknown partner',
      partnerCode: order.accounts?.code || null,
      date: order.order_date,
      orderRef: orderRef(order),
      patientId: order.patient_id,
      patientCode: patientCode(order),
      patientName: order.patient_name || '-',
      ageGender: [
        order.patients?.age != null ? formatAge(order.patients.age, order.patients.age_unit) : '',
        order.patients?.gender || '',
      ].filter(Boolean).join(' / '),
      phone: order.patients?.phone || '',
      doctor: order.doctor || '',
      status: order.status || '',
      billing: order.is_billed ? 'Billed' : (order.billing_status || 'pending'),
      amount: orderAmount(order),
      tests: activeTests(order).map((test) => ({
        name: test.test_name || '-',
        price: test.price != null ? Number(test.price) : null,
      })),
    }));

  const pdfOptions = (): B2BPatientPdfOptions => ({
    dateFrom: fromDate,
    dateTo: toDate,
    labName,
    partnerLabel: selectedAccountName,
    statusLabel: statusFilter,
    searchLabel: searchTerm.trim() || undefined,
    columns: (Object.keys(columns) as ColumnKey[]).filter((key) => columns[key]),
    showTestRates,
    truncatedAt: truncated ? MAX_ROWS : null,
  });

  const handlePrint = () => {
    if (filteredOrders.length === 0) return;
    try {
      printB2BPatientListPdf(pdfRows(), pdfOptions());
    } catch (err) {
      console.error('Error printing B2B patient list:', err);
      setError(err instanceof Error ? err.message : 'Failed to generate the print preview');
    }
  };

  const handleDownloadPdf = () => {
    if (filteredOrders.length === 0) return;
    try {
      downloadB2BPatientListPdf(pdfRows(), pdfOptions());
    } catch (err) {
      console.error('Error generating B2B patient list PDF:', err);
      setError(err instanceof Error ? err.message : 'Failed to generate the PDF');
    }
  };

  const handleExport = () => {
    const workbook = XLSX.utils.book_new();

    const patientRows = filteredOrders.map((order) => {
      const tests = activeTests(order);
      return {
        'B2B Partner': order.accounts?.name || '',
        'Date': formatDate(order.order_date),
        'Order / Sample ID': orderRef(order),
        'Patient ID': patientCode(order),
        'Patient Name': order.patient_name,
        'Age': order.patients?.age != null ? formatAge(order.patients.age, order.patients.age_unit) : '',
        'Gender': order.patients?.gender || '',
        'Phone': order.patients?.phone || '',
        'Referring Doctor': order.doctor || '',
        'Tests': tests.map((test) => test.test_name).join(', '),
        'Test Count': tests.length,
        'Status': order.status,
        'Billing': order.is_billed ? 'Billed' : (order.billing_status || 'pending'),
        'Amount': orderAmount(order),
      };
    });

    const patientSheet = XLSX.utils.json_to_sheet(patientRows);
    patientSheet['!cols'] = [
      { wch: 26 }, { wch: 12 }, { wch: 18 }, { wch: 18 }, { wch: 26 }, { wch: 8 },
      { wch: 9 }, { wch: 14 }, { wch: 22 }, { wch: 50 }, { wch: 11 }, { wch: 16 },
      { wch: 12 }, { wch: 12 },
    ];
    XLSX.utils.book_append_sheet(workbook, patientSheet, 'Patients');

    // One row per test keeps the export usable for rate-wise reconciliation
    const testRows = filteredOrders.flatMap((order) =>
      activeTests(order).map((test) => ({
        'B2B Partner': order.accounts?.name || '',
        'Date': formatDate(order.order_date),
        'Order / Sample ID': orderRef(order),
        'Patient ID': patientCode(order),
        'Patient Name': order.patient_name,
        'Age': order.patients?.age != null ? formatAge(order.patients.age, order.patients.age_unit) : '',
        'Gender': order.patients?.gender || '',
        'Phone': order.patients?.phone || '',
        'Test Name': test.test_name,
        'Rate': Number(test.price) || 0,
        'Status': order.status,
      }))
    );

    const testSheet = XLSX.utils.json_to_sheet(testRows);
    testSheet['!cols'] = [
      { wch: 26 }, { wch: 12 }, { wch: 18 }, { wch: 18 }, { wch: 26 },
      { wch: 8 }, { wch: 9 }, { wch: 14 }, { wch: 38 }, { wch: 10 }, { wch: 16 },
    ];
    XLSX.utils.book_append_sheet(workbook, testSheet, 'Test Details');

    const scope = accountId === 'all'
      ? 'all_partners'
      : (accounts.find((account) => account.id === accountId)?.name || 'partner')
        .replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 40);

    XLSX.writeFile(workbook, `b2b_patients_${scope}_${fromDate || 'start'}_to_${toDate || 'end'}.xlsx`);
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4 print:hidden">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">B2B Patient List</h1>
          <p className="mt-1 text-sm text-gray-500">
            Partner-wise patient list with test details, rates and billing status.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={loadOrders}
            disabled={loading}
            className="flex items-center rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-600 transition-colors hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            {loading ? 'Loading...' : 'Refresh'}
          </button>
          <button
            onClick={handlePrint}
            disabled={filteredOrders.length === 0}
            title="Open a print-ready A4 landscape PDF of the listed patients"
            className="flex items-center rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Printer className="mr-2 h-4 w-4" />
            Print
          </button>
          <button
            onClick={handleDownloadPdf}
            disabled={filteredOrders.length === 0}
            title="Download the listed patients, tests and totals as a PDF"
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-300"
          >
            <FileDown className="h-4 w-4" />
            Download PDF
          </button>
          <button
            onClick={handleExport}
            disabled={filteredOrders.length === 0}
            title="Download the listed patients and their tests as an Excel file"
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-gray-300"
          >
            <FileSpreadsheet className="h-4 w-4" />
            Export to Excel
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm print:hidden">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-5">
          <div className="md:col-span-2">
            <label htmlFor="b2b-account" className="mb-1 block text-xs font-medium text-gray-600">
              B2B Partner
            </label>
            <div className="relative">
              <Building2 className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <select
                id="b2b-account"
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                className="w-full rounded-lg border border-gray-300 py-2 pl-10 pr-3 focus:border-blue-500 focus:ring-2 focus:ring-blue-500"
              >
                <option value="all">All B2B partners</option>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}{account.code ? ` (${account.code})` : ''}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label htmlFor="b2b-from" className="mb-1 block text-xs font-medium text-gray-600">From Date</label>
            <div className="relative">
              <Calendar className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <input
                id="b2b-from"
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                className="w-full rounded-lg border border-gray-300 py-2 pl-10 pr-3 focus:border-blue-500 focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          <div>
            <label htmlFor="b2b-to" className="mb-1 block text-xs font-medium text-gray-600">To Date</label>
            <div className="relative">
              <Calendar className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <input
                id="b2b-to"
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                className="w-full rounded-lg border border-gray-300 py-2 pl-10 pr-3 focus:border-blue-500 focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          <div>
            <label htmlFor="b2b-status" className="mb-1 block text-xs font-medium text-gray-600">Status</label>
            <select
              id="b2b-status"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-blue-500 focus:ring-2 focus:ring-blue-500"
            >
              <option value="all">All statuses</option>
              {statusOptions.map((status) => (
                <option key={status} value={status}>{status}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="relative mt-4">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            placeholder="Search by patient, patient ID, order/sample ID, phone, test or partner..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full rounded-lg border border-gray-300 py-2 pl-10 pr-3 focus:border-blue-500 focus:ring-2 focus:ring-blue-500"
          />
        </div>

        {/* Column picker - drives the table below and the print / PDF output */}
        <div className="mt-4 border-t border-gray-100 pt-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setShowColumnPicker((open) => !open)}
              className="inline-flex items-center gap-2 text-sm font-medium text-gray-700 hover:text-blue-600"
            >
              <Columns3 className="h-4 w-4" />
              Columns ({visibleColumnCount} of {B2B_PDF_OPTIONAL_COLUMNS.length})
              {showColumnPicker ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </button>
            <span className="text-xs text-gray-500">Applies to the table, print and PDF</span>
          </div>

          {showColumnPicker && (
            <div className="mt-3 space-y-3">
              <div className="flex flex-wrap gap-x-5 gap-y-2">
                {B2B_PDF_OPTIONAL_COLUMNS.map((column) => (
                  <label key={column.key} className="inline-flex items-center gap-2 text-sm text-gray-700">
                    <input
                      type="checkbox"
                      checked={columns[column.key]}
                      onChange={(e) =>
                        setColumns((prev) => ({ ...prev, [column.key]: e.target.checked }))
                      }
                      className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    {column.label}
                  </label>
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-4">
                <label
                  className={`inline-flex items-center gap-2 text-sm ${columns.tests ? 'text-gray-700' : 'text-gray-400'}`}
                  title={columns.tests ? undefined : 'Enable the Tests column first'}
                >
                  <input
                    type="checkbox"
                    checked={showTestRates}
                    disabled={!columns.tests}
                    onChange={(e) => setShowTestRates(e.target.checked)}
                    className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:opacity-50"
                  />
                  Show rate next to each test
                </label>
                <button
                  type="button"
                  onClick={() => setColumns({ ...DEFAULT_COLUMNS })}
                  className="text-xs font-medium text-blue-600 hover:text-blue-700"
                >
                  Reset to default
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setColumns(
                      (Object.keys(DEFAULT_COLUMNS) as ColumnKey[]).reduce(
                        (all, key) => ({ ...all, [key]: true }),
                        {} as Record<ColumnKey, boolean>
                      )
                    )
                  }
                  className="text-xs font-medium text-blue-600 hover:text-blue-700"
                >
                  Select all
                </button>
              </div>
              <p className="text-xs text-gray-500">
                Amounts always appear in the partner subtotals and grand total, even with the Amount column off.
              </p>
            </div>
          )}
        </div>

        {error && (
          <div className="mt-3 rounded-lg border border-red-100 bg-red-50 p-2 text-sm text-red-600">{error}</div>
        )}
        {truncated && (
          <div className="mt-3 rounded-lg border border-amber-100 bg-amber-50 p-2 text-sm text-amber-700">
            Showing the first {MAX_ROWS.toLocaleString()} orders only. Narrow the date range to see the rest.
          </div>
        )}
      </div>

      {/* Summary */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
        {[
          { label: 'Partners', value: String(totals.partners), icon: Building2, tone: 'text-indigo-600 bg-indigo-50' },
          { label: 'Patients', value: String(totals.patients), icon: Users, tone: 'text-blue-600 bg-blue-50' },
          { label: 'Orders', value: String(totals.orders), icon: Receipt, tone: 'text-purple-600 bg-purple-50' },
          { label: 'Tests', value: String(totals.tests), icon: TestTube, tone: 'text-teal-600 bg-teal-50' },
          { label: 'Amount', value: formatCurrency(totals.amount), icon: Receipt, tone: 'text-green-600 bg-green-50' },
        ].map((tile) => {
          const Icon = tile.icon;
          return (
            <div key={tile.label} className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
              <div className="flex items-center gap-3">
                <div className={`rounded-lg p-2 ${tile.tone}`}>
                  <Icon className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <p className="truncate text-lg font-bold text-gray-900">{tile.value}</p>
                  <p className="text-xs uppercase tracking-wide text-gray-500">{tile.label}</p>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 px-4 py-3">
          <h2 className="text-sm font-semibold text-gray-900">
            {selectedAccountName} &middot; {formatDate(fromDate) || 'start'} to {formatDate(toDate) || 'today'}
          </h2>
          <span className="text-xs text-gray-500">
            Showing {filteredOrders.length} of {orders.length} orders
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                {tableColumns.map((column) => (
                  <th
                    key={column.key}
                    className={`px-4 py-3 text-xs font-medium uppercase tracking-wider text-gray-500 ${
                      column.align === 'right' ? 'text-right' : 'text-left'
                    }`}
                  >
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {loading ? (
                <tr>
                  <td colSpan={tableColumns.length} className="px-4 py-10 text-center text-sm text-gray-500">
                    Loading patients...
                  </td>
                </tr>
              ) : filteredOrders.length === 0 ? (
                <tr>
                  <td colSpan={tableColumns.length} className="px-4 py-10 text-center text-sm text-gray-500">
                    No B2B patients found for these filters.
                  </td>
                </tr>
              ) : (
                groupedOrders.map((group) => {
                  const groupPatients = new Set(group.rows.map((order) => order.patient_id)).size;
                  const groupTests = group.rows.reduce((sum, order) => sum + activeTests(order).length, 0);
                  const groupAmount = group.rows.reduce((sum, order) => sum + orderAmount(order), 0);

                  return (
                    <React.Fragment key={group.id}>
                      <tr className="bg-blue-50/60">
                        <td colSpan={tableColumns.length} className="px-4 py-2">
                          <div className="flex flex-wrap items-center justify-between gap-2 text-sm font-semibold text-blue-800">
                            <span>
                              {group.name}{group.code ? ` (${group.code})` : ''}
                              <span className="ml-2 font-normal text-blue-700">
                                &middot; {groupPatients} patients &middot; {group.rows.length} orders &middot; {groupTests} tests
                              </span>
                            </span>
                            <span>{formatCurrency(groupAmount)}</span>
                          </div>
                        </td>
                      </tr>
                      {group.rows.map((order) => (
                        <tr key={order.id} className="hover:bg-gray-50">
                          {tableColumns.map((column) => (
                            <td
                              key={column.key}
                              className={`px-4 py-3 ${column.nowrap ? 'whitespace-nowrap' : ''} ${
                                column.align === 'right' ? 'text-right' : ''
                              }`}
                            >
                              {column.render(order)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </React.Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default B2BPatientList;
