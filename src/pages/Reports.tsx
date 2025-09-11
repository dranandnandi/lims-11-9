'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { supabase } from '../utils/supabase';
import { FileText, Download, Eye, Search, RefreshCw } from 'lucide-react';
import {
  format,
  startOfDay,
  endOfDay,
  startOfWeek,
  endOfWeek,
  startOfMonth,
  endOfMonth,
} from 'date-fns';
import { generateAndSavePDFReport, viewPDFReport } from '../utils/pdfService';
import PDFProgressModal from '../components/PDFProgressModal';
import { usePDFGeneration } from '../hooks/usePDFGeneration';

type DateFilter = 'today' | 'yesterday' | 'week' | 'month' | 'all';

interface ApprovedResult {
  result_id: string;
  order_id: string;
  patient_id: string;
  patient_name: string;
  test_name: string;
  status: string;
  verification_status: string;
  verified_by: string;
  verified_at: string;
  review_comment: string;
  entered_by: string;
  entered_date: string;
  reviewed_by: string;
  reviewed_date: string;
  sample_id: string;
  order_date: string;
  doctor: string;
  patient_full_name: string;
  age: number;
  gender: string;
  phone: string;
  attachment_id?: string;
  attachment_url?: string;
  attachment_type?: string;
  attachment_name?: string;

  // enriched fields (optional at runtime)
  has_report?: boolean;
  report_status?: string;
  report_generated_at?: string;
}

interface OrderGroup {
  order_id: string;
  patient_id: string;
  patient_full_name: string;
  age: number;
  gender: string;
  order_date: string;
  sample_ids: string[];
  verified_at: string; // latest among contained results
  verified_by: string; // from latest
  test_names: string[];
  results: ApprovedResult[]; // raw rows
}

type ReportRow = {
  order_id: string;
  status: string;
  generated_date: string;
};

type PreparedReport = {
  patient: {
    name: string;
    id: string;
    age: number;
    gender: string;
    referredBy: string;
  };
  report: {
    reportId: string;
    collectionDate: string;
    reportDate: string;
    reportType: string;
  };
  testResults: {
    parameter: string;
    result: string;
    unit: string;
    referenceRange: string;
    flag?: string;
  }[];
  interpretation: string;
};

const Reports: React.FC = () => {
  const [approvedResults, setApprovedResults] = useState<ApprovedResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState<{
    dateFilter: DateFilter;
    search: string;
    status: 'all';
  }>({
    dateFilter: 'today',
    search: '',
    status: 'all',
  });

  // Selection now at order level
  const [selectedOrders, setSelectedOrders] = useState<Set<string>>(new Set());

  // Add PDF generation hook
  const { isGenerating, stage, progress, generatePDF, resetState } = usePDFGeneration();

  // Load approved results
  const loadApprovedResults = useCallback(async () => {
    try {
      setLoading(true);

      // Get date range based on filter
      let dateRange = { start: new Date(), end: new Date() };
      const now = new Date();

      switch (filters.dateFilter) {
        case 'today':
          dateRange.start = startOfDay(now);
          dateRange.end = endOfDay(now);
          break;
        case 'yesterday': {
          const yesterday = new Date(now);
          yesterday.setDate(yesterday.getDate() - 1);
          dateRange.start = startOfDay(yesterday);
          dateRange.end = endOfDay(yesterday);
          break;
        }
        case 'week':
          dateRange.start = startOfWeek(now);
          dateRange.end = endOfWeek(now);
          break;
        case 'month':
          dateRange.start = startOfMonth(now);
          dateRange.end = endOfMonth(now);
          break;
        case 'all':
          dateRange.start = new Date(2000, 0, 1);
          dateRange.end = new Date(2100, 0, 1);
          break;
      }

      const { data, error } = await supabase
        .from('view_approved_results')
        .select('*')
        .gte('verified_at', dateRange.start.toISOString())
        .lte('verified_at', dateRange.end.toISOString())
        .order('verified_at', { ascending: false });

      if (!error && data) {
        // Load existing reports to check which orders already have reports
        let existingReports: ReportRow[] = [];
        const orderIds = data.map((r: ApprovedResult) => r.order_id).filter(Boolean);

        if (orderIds.length > 0) {
          const { data: reportsData } = await supabase
            .from('reports')
            .select('order_id, status, generated_date')
            .in('order_id', orderIds);
          existingReports = (reportsData as ReportRow[]) || [];
        }

        const reportMap = new Map(existingReports.map((r) => [r.order_id, r]));

        // Add report status to each result
        const enhancedData: ApprovedResult[] = (data as ApprovedResult[]).map((result) => ({
          ...result,
          has_report: reportMap.has(result.order_id),
          report_status: reportMap.get(result.order_id)?.status,
          report_generated_at: reportMap.get(result.order_id)?.generated_date,
        }));

        // Filter by search
        let filtered = enhancedData;
        if (filters.search) {
          const searchLower = filters.search.toLowerCase();
          filtered = enhancedData.filter(
            (result) =>
              result.patient_full_name.toLowerCase().includes(searchLower) ||
              result.test_name.toLowerCase().includes(searchLower) ||
              result.sample_id.toLowerCase().includes(searchLower) ||
              result.order_id.toLowerCase().includes(searchLower),
          );
        }

        setApprovedResults(filtered);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Error loading approved results:', err);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    loadApprovedResults();
  }, [loadApprovedResults]);

  // Derived grouping; ensure only one row per order id
  const orderGroups: OrderGroup[] = useMemo(() => {
    const map = new Map<string, OrderGroup>();
    for (const r of approvedResults) {
      let group = map.get(r.order_id);
      if (!group) {
        group = {
          order_id: r.order_id,
          patient_id: r.patient_id,
          patient_full_name: r.patient_full_name,
          age: r.age,
          gender: r.gender,
          order_date: r.order_date,
          sample_ids: [r.sample_id],
          verified_at: r.verified_at,
          verified_by: r.verified_by,
          test_names: [r.test_name],
          results: [r],
        };
        map.set(r.order_id, group);
      } else {
        group.results.push(r);
        if (!group.sample_ids.includes(r.sample_id)) group.sample_ids.push(r.sample_id);
        if (!group.test_names.includes(r.test_name)) group.test_names.push(r.test_name);
        // If this result verified later, update group metadata
        if (new Date(r.verified_at) > new Date(group.verified_at)) {
          group.verified_at = r.verified_at;
          group.verified_by = r.verified_by;
        }
      }
    }
    // Return sorted by verified_at desc
    return Array.from(map.values()).sort(
      (a, b) => new Date(b.verified_at).getTime() - new Date(a.verified_at).getTime(),
    );
  }, [approvedResults]);

  // Generate / upsert report per selected order
  const generateReport = async () => {
    if (selectedOrders.size === 0) {
      // eslint-disable-next-line no-alert
      alert('Please select at least one order');
      return;
    }

    try {
      const userId = (await supabase.auth.getUser()).data.user?.id;
      if (!userId) {
        // eslint-disable-next-line no-alert
        alert('User not authenticated');
        return;
      }

      let successCount = 0;
      let errorCount = 0;

      for (const orderId of selectedOrders) {
        const group = orderGroups.find((g) => g.order_id === orderId);
        if (!group) continue;

        try {
          const { error } = await supabase.from('reports').upsert(
            {
              order_id: orderId,
              patient_id: group.patient_id,
              status: 'Generated',
              generated_date: new Date().toISOString(),
              notes: JSON.stringify({
                test_names: group.test_names,
                sample_ids: group.sample_ids,
                verified_at: group.verified_at,
                verified_by: group.verified_by,
              }),
            },
            {
              onConflict: 'order_id',
              ignoreDuplicates: false, // update existing records
            },
          );

          if (error) {
            // eslint-disable-next-line no-console
            console.error(`Error generating report for order ${orderId}:`, error);
            errorCount++;
          } else {
            successCount++;
          }
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error(`Exception for order ${orderId}:`, e);
          errorCount++;
        }
      }

      // Clear selections
      setSelectedOrders(new Set());

      // Show result summary
      if (successCount > 0 && errorCount === 0) {
        // eslint-disable-next-line no-alert
        alert(`Successfully generated ${successCount} report(s)`);
      } else if (successCount > 0 && errorCount > 0) {
        // eslint-disable-next-line no-alert
        alert(`Generated ${successCount} report(s), ${errorCount} failed`);
      } else {
        // eslint-disable-next-line no-alert
        alert('Failed to generate reports. Please try again.');
      }

      // Refresh the list
      await loadApprovedResults();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('Error generating reports:', e);
      // eslint-disable-next-line no-alert
      alert('An error occurred while generating reports');
    }
  };

  // Toggle order selection
  const toggleOrderSelection = (orderId: string) => {
    const next = new Set(selectedOrders);
    if (next.has(orderId)) next.delete(orderId);
    else next.add(orderId);
    setSelectedOrders(next);
  };

  const selectAllOrders = () => setSelectedOrders(new Set(orderGroups.map((g) => g.order_id)));
  const clearSelection = () => setSelectedOrders(new Set());

  // View PDF for a specific order
  const handleView = async (orderId: string) => {
    console.log('handleView called for orderId:', orderId);
    
    const group = orderGroups.find(g => g.order_id === orderId);
    if (!group) {
      console.error('Group not found for orderId:', orderId);
      alert('Order not found');
      return;
    }

    try {
      console.log('Preparing report data for group:', group);
      // Prepare report data
      const reportData = await prepareReportData(group);
      console.log('Report data prepared:', reportData);
      
      // View PDF (will generate if doesn't exist)
      const pdfUrl = await viewPDFReport(orderId, reportData);
      console.log('PDF URL received:', pdfUrl);
      
      if (pdfUrl) {
        window.open(pdfUrl, '_blank');
      } else {
        alert('Failed to generate or view PDF report');
      }
    } catch (error) {
      console.error('View failed:', error);
      alert('Failed to view report: ' + (error instanceof Error ? error.message : 'Unknown error'));
    }
  };

  // Download PDF for a specific order (aggregated). Fallback to simple HTML download
  const handleDownload = async (orderId: string) => {
    console.log('handleDownload called for orderId:', orderId);
    
    const group = orderGroups.find(g => g.order_id === orderId);
    if (!group) {
      console.error('Group not found for orderId:', orderId);
      alert('Order not found');
      return;
    }

    try {
      console.log('Preparing report data for download:', group);
      // Prepare report data
      const reportData = await prepareReportData(group);
      console.log('Report data prepared for download:', reportData);
      
      // Use the progress-enabled PDF generation
      await generatePDF(orderId, reportData);
    } catch (error) {
      console.error('Download failed:', error);
      alert('Download failed: ' + (error instanceof Error ? error.message : 'Unknown error'));
    }
  };

  // Helper function to prepare report data
  const prepareReportData = async (group: OrderGroup): Promise<PreparedReport> => {
    // Fetch analyte-level values for each result (best-effort)
    const analyteRows: {
      parameter: string;
      result: string;
      unit: string;
      referenceRange: string;
      flag?: string;
    }[] = [];

    for (const r of group.results) {
      try {
        // Query result_values table directly instead of using RPC
        const { data: values, error } = await supabase
          .from('result_values')
          .select('parameter, value, unit, reference_range, flag')
          .eq('result_id', r.result_id);

        if (error) {
          // eslint-disable-next-line no-console
          console.warn('Failed to fetch result values for', r.result_id, error);
        } else {
          (values || []).forEach((v: any) => {
            analyteRows.push({
              parameter: `${r.test_name} - ${v.parameter}`,
              result: v.value,
              unit: v.unit || '',
              referenceRange: v.reference_range || '',
              flag: v.flag || '',
            });
          });
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('get_result_values failed for', r.result_id, e);
      }
    }

    if (analyteRows.length === 0) {
      // minimal row per test if no values
      group.test_names.forEach((tn) =>
        analyteRows.push({ parameter: tn, result: '-', unit: '', referenceRange: '' }),
      );
    }

    return {
      patient: {
        name: group.patient_full_name,
        id: group.patient_id,
        age: group.age,
        gender: group.gender,
        referredBy: group.results[0]?.doctor || '-',
      },
      report: {
        reportId: group.order_id,
        collectionDate: group.order_date,
        reportDate: new Date().toISOString(),
        reportType: 'Lab Tests',
      },
      testResults: analyteRows,
      interpretation: 'Auto-generated report based on approved lab results.',
    };
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Reports</h1>
            <p className="text-gray-600 mt-1">Generate and manage lab reports</p>
          </div>

          <button
            onClick={loadApprovedResults}
            className="flex items-center space-x-2 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
          >
            <RefreshCw className="w-4 h-4" />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      <div className="p-6">
        {/* Filters */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 mb-6">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search patient, test, sample..."
                className="w-full pl-10 pr-3 py-2 border rounded-lg"
                value={filters.search}
                onChange={(e) => setFilters({ ...filters, search: e.target.value })}
              />
            </div>

            <select
              className="border rounded-lg px-3 py-2"
              value={filters.dateFilter}
              onChange={(e) => setFilters({ ...filters, dateFilter: e.target.value as DateFilter })}
            >
              <option value="today">Today</option>
              <option value="yesterday">Yesterday</option>
              <option value="week">This Week</option>
              <option value="month">This Month</option>
              <option value="all">All Dates</option>
            </select>

            <div className="flex space-x-2">
              <button
                onClick={selectAllOrders}
                className="px-3 py-2 text-sm border border-gray-300 rounded hover:bg-gray-50"
              >
                Select All
              </button>
              <button
                onClick={clearSelection}
                className="px-3 py-2 text-sm border border-gray-300 rounded hover:bg-gray-50"
              >
                Clear
              </button>
            </div>
          </div>
        </div>

        {/* Results Table */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200">
          <div className="p-4 border-b border-gray-200 flex items-center justify-between">
            <h2 className="text-lg font-semibold">Approved Results</h2>
            {selectedOrders.size > 0 && (
              <div className="flex items-center space-x-2">
                <span className="text-sm text-gray-600">{selectedOrders.size} selected</span>
                <button
                  onClick={generateReport}
                  className="px-4 py-2 bg-green-600 text-white text-sm rounded hover:bg-green-700 flex items-center space-x-1"
                >
                  <FileText className="w-4 h-4" />
                  <span>Generate Reports</span>
                </button>
              </div>
            )}
          </div>

          <div className="overflow-x-auto">
            {loading ? (
              <div className="p-8 text-center">
                <RefreshCw className="w-6 h-6 animate-spin mx-auto text-gray-400" />
                <p className="mt-2 text-gray-500">Loading approved results...</p>
              </div>
            ) : orderGroups.length === 0 ? (
              <div className="p-8 text-center text-gray-500">
                <FileText className="w-12 h-12 mx-auto mb-2 text-gray-300" />
                <p>No approved results found</p>
              </div>
            ) : (
              <table className="w-full">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                      Order
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                      Patient
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                      Tests
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                      Samples
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                      Order Date
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                      Approved By
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                      Approved At
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {orderGroups.map((group) => (
                    <tr key={group.order_id} className="hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={selectedOrders.has(group.order_id)}
                          onChange={() => toggleOrderSelection(group.order_id)}
                          className="rounded"
                        />
                        <div className="text-xs text-gray-500 mt-1">{group.order_id}</div>
                      </td>
                      <td className="px-4 py-3">
                        <div>
                          <div className="font-medium text-gray-900">{group.patient_full_name}</div>
                          <div className="text-sm text-gray-500">
                            {group.age}y {group.gender}
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div
                          className="text-sm max-w-xs truncate"
                          title={group.test_names.join(', ')}
                        >
                          {group.test_names.join(', ')}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-sm" title={group.sample_ids.join(', ')}>
                          {group.sample_ids.join(', ')}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-sm">
                          {group.order_date
                            ? format(new Date(group.order_date), 'MMM d, yyyy')
                            : '-'}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-sm">{group.verified_by || '-'}</div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-sm">
                          {group.verified_at
                            ? format(new Date(group.verified_at), 'MMM d, yyyy h:mm a')
                            : '-'}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex space-x-2">
                          <button
                            className="text-blue-600 hover:text-blue-700 text-sm flex items-center space-x-1"
                            onClick={() => handleView(group.order_id)}
                          >
                            <Eye className="w-4 h-4" />
                            <span>View</span>
                          </button>
                          <button
                            className={`text-green-600 hover:text-green-700 text-sm flex items-center space-x-1 ${
                              isGenerating ? 'opacity-50 cursor-not-allowed' : ''
                            }`}
                            onClick={() => handleDownload(group.order_id)}
                            disabled={isGenerating}
                          >
                            {isGenerating ? (
                              <>
                                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-green-600"></div>
                                <span>Generating...</span>
                              </>
                            ) : (
                              <>
                                <Download className="w-4 h-4" />
                                <span>Download</span>
                              </>
                            )}
                          </button>
                          {(group.results[0] as ApprovedResult)?.has_report && (
                            <span className="text-xs bg-green-100 text-green-800 px-2 py-1 rounded">
                              Report Generated
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {/* PDF Progress Modal */}
      <PDFProgressModal
        isVisible={isGenerating}
        stage={stage}
        progress={progress}
        onClose={resetState}
      />
    </div>
  );
};

export default Reports;
