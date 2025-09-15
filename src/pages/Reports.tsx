import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { supabase } from '../utils/supabase';
import { 
  FileText, 
  Download, 
  Eye, 
  Search, 
  RefreshCw, 
  Filter,
  X,
  Calendar,
  User,
  TestTube,
  AlertTriangle,
  TrendingUp,
  Clock,
  CheckCircle,
  FileCheck,
  XCircle,
  Loader2,
  SortAsc,
  SortDesc
} from 'lucide-react';
import {
  format,
  isValid,
  startOfDay,
  endOfDay,
  startOfWeek,
  endOfWeek,
  startOfMonth,
  endOfMonth,
} from 'date-fns';
import { viewPDFReport } from '../utils/pdfService';
import PDFProgressModal from '../components/PDFProgressModal';
import { usePDFGeneration, isOrderReportReady } from '../hooks/usePDFGeneration';

// Helper function to safely format dates
const safeFormatDate = (dateValue: string | null | undefined, formatString: string = 'MMM d, yyyy'): string => {
  if (!dateValue) return 'N/A';
  
  const date = new Date(dateValue);
  if (!isValid(date)) return 'Invalid Date';
  
  return format(date, formatString);
};

type DateFilter = 'today' | 'yesterday' | 'week' | 'month' | 'all';
type SortField = 'patient_name' | 'order_date' | 'verified_at' | 'test_name';
type SortDirection = 'asc' | 'desc';

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
  has_report?: boolean;
  report_status?: string;
  report_generated_at?: string;
  is_report_ready?: boolean;
  has_draft_report?: boolean;
  has_final_report?: boolean;
  draft_report?: any;
  final_report?: any;
}

interface OrderGroup {
  order_id: string;
  patient_id: string;
  patient_full_name: string;
  age: number;
  gender: string;
  order_date: string;
  sample_ids: string[];
  verified_at: string;
  verified_by: string;
  test_names: string[];
  results: ApprovedResult[];
  is_report_ready?: boolean;
}

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
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedStatus, setSelectedStatus] = useState<'all' | 'ready' | 'pending' | 'processing'>('all');
  const [selectedTestType, setSelectedTestType] = useState('all');
  const [selectedDoctor, setSelectedDoctor] = useState('all');
  const [dateFilter, setDateFilter] = useState<DateFilter>('today');
  const [sortField, setSortField] = useState<SortField>('verified_at');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [showFilters, setShowFilters] = useState(false);
  const [selectedOrders, setSelectedOrders] = useState<Set<string>>(new Set());

  // PDF generation hook
  const { isGenerating, stage, progress, generatePDF, resetState } = usePDFGeneration();

  // Load approved results
  const loadApprovedResults = useCallback(async () => {
    try {
      setLoading(true);

      // Get date range based on filter
      let dateRange = { start: new Date(), end: new Date() };
      const now = new Date();

      switch (dateFilter) {
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
        let existingReports: any[] = [];
        const orderIds = data.map((r: ApprovedResult) => r.order_id).filter(Boolean);

        if (orderIds.length > 0) {
          const { data: reportsData } = await supabase
            .from('reports')
            .select('order_id, status, generated_date, report_type')
            .in('order_id', orderIds);
          existingReports = (reportsData as any[]) || [];
        }

        const draftReportMap = new Map(
          existingReports
            .filter(r => r.report_type === 'draft')
            .map((r) => [r.order_id, r])
        );
        const finalReportMap = new Map(
          existingReports
            .filter(r => r.report_type === 'final')
            .map((r) => [r.order_id, r])
        );

        const enhancedData: ApprovedResult[] = await Promise.all(
          (data as ApprovedResult[]).map(async (result) => {
            const draftReport = draftReportMap.get(result.order_id);
            const finalReport = finalReportMap.get(result.order_id);
            const isReady = await isOrderReportReady(result.order_id);
            
            return {
              ...result,
              has_report: finalReportMap.has(result.order_id) || draftReportMap.has(result.order_id),
              report_status: finalReport?.status || draftReport?.status,
              report_generated_at: finalReport?.generated_date || draftReport?.generated_date,
              is_report_ready: isReady,
              has_draft_report: draftReportMap.has(result.order_id),
              has_final_report: finalReportMap.has(result.order_id),
              draft_report: draftReport,
              final_report: finalReport
            };
          })
        );

        setApprovedResults(enhancedData);
      }
    } catch (err) {
      console.error('Error loading approved results:', err);
    } finally {
      setLoading(false);
    }
  }, [dateFilter]);

  useEffect(() => {
    loadApprovedResults();
  }, [loadApprovedResults]);

  // Transform and filter data
  const orderGroups: OrderGroup[] = useMemo(() => {
    const map = new Map<string, OrderGroup>();
    
    let filtered = approvedResults;

    // Apply search filter
    if (searchTerm) {
      const searchLower = searchTerm.toLowerCase();
      filtered = filtered.filter(
        (result) =>
          result.patient_full_name.toLowerCase().includes(searchLower) ||
          result.test_name.toLowerCase().includes(searchLower) ||
          result.sample_id.toLowerCase().includes(searchLower) ||
          result.order_id.toLowerCase().includes(searchLower)
      );
    }

    // Apply test type filter
    if (selectedTestType !== 'all') {
      filtered = filtered.filter(result => 
        result.test_name.toLowerCase().includes(selectedTestType.toLowerCase())
      );
    }

    // Apply doctor filter
    if (selectedDoctor !== 'all') {
      filtered = filtered.filter(result => 
        result.doctor?.toLowerCase().includes(selectedDoctor.toLowerCase())
      );
    }

    // Apply status filter
    if (selectedStatus !== 'all') {
      filtered = filtered.filter(result => {
        switch (selectedStatus) {
          case 'ready':
            return result.is_report_ready && !result.has_final_report;
          case 'pending':
            return !result.is_report_ready;
          case 'processing':
            return result.has_draft_report && !result.has_final_report;
          default:
            return true;
        }
      });
    }

    // Group by order
    for (const r of filtered) {
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
          is_report_ready: r.is_report_ready || false
        };
        map.set(r.order_id, group);
      } else {
        group.results.push(r);
        if (!group.sample_ids.includes(r.sample_id)) group.sample_ids.push(r.sample_id);
        if (!group.test_names.includes(r.test_name)) group.test_names.push(r.test_name);
        if (new Date(r.verified_at) > new Date(group.verified_at)) {
          group.verified_at = r.verified_at;
          group.verified_by = r.verified_by;
        }
        group.is_report_ready = group.is_report_ready && (r.is_report_ready || false);
      }
    }

    // Sort groups
    const sorted = Array.from(map.values()).sort((a, b) => {
      let aValue: any, bValue: any;
      
      switch (sortField) {
        case 'patient_name':
          aValue = a.patient_full_name;
          bValue = b.patient_full_name;
          break;
        case 'order_date':
          aValue = new Date(a.order_date).getTime();
          bValue = new Date(b.order_date).getTime();
          break;
        case 'test_name':
          aValue = a.test_names.join(', ');
          bValue = b.test_names.join(', ');
          break;
        default:
          aValue = new Date(a.verified_at).getTime();
          bValue = new Date(b.verified_at).getTime();
      }
      
      if (sortDirection === 'asc') {
        return aValue < bValue ? -1 : aValue > bValue ? 1 : 0;
      } else {
        return aValue > bValue ? -1 : aValue < bValue ? 1 : 0;
      }
    });

    return sorted;
  }, [approvedResults, searchTerm, selectedTestType, selectedDoctor, selectedStatus, sortField, sortDirection]);

  // Get unique values for filters
  const uniqueTestTypes = useMemo(() => {
    const types = new Set(approvedResults.map(r => r.test_name));
    return Array.from(types).sort();
  }, [approvedResults]);

  const uniqueDoctors = useMemo(() => {
    const doctors = new Set(approvedResults.map(r => r.doctor).filter(Boolean));
    return Array.from(doctors).sort();
  }, [approvedResults]);

  // Statistics for dashboard
  const statistics = useMemo(() => {
    const totalOrders = orderGroups.length;
    const readyForGeneration = orderGroups.filter(g => g.is_report_ready && !g.results[0]?.has_final_report).length;
    const pendingVerification = orderGroups.filter(g => !g.is_report_ready).length;
    const completed = orderGroups.filter(g => g.results[0]?.has_final_report).length;
    
    return { totalOrders, readyForGeneration, pendingVerification, completed };
  }, [orderGroups]);

  // Handlers
  const handleView = async (orderId: string) => {
    const group = orderGroups.find(g => g.order_id === orderId);
    if (!group) {
      alert('Order not found');
      return;
    }

    try {
      const reportData = await prepareReportData(group);
      const pdfUrl = await viewPDFReport(orderId, reportData);
      
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

  const handleDownload = useCallback(async (orderId: string, forceDraft = false) => {
    try {
      await generatePDF(orderId, forceDraft);
    } catch (error) {
      console.error('Download failed:', error);
      alert('Download failed: ' + (error instanceof Error ? error.message : 'Unknown error'));
    }
  }, [generatePDF]);

  const prepareReportData = async (group: OrderGroup): Promise<PreparedReport> => {
    const analyteRows: {
      parameter: string;
      result: string;
      unit: string;
      referenceRange: string;
      flag?: string;
    }[] = [];

    for (const r of group.results) {
      try {
        const { data: values, error } = await supabase
          .from('result_values')
          .select('parameter, value, unit, reference_range, flag')
          .eq('result_id', r.result_id);

        if (error) {
          console.warn('Failed to fetch result values for', r.result_id, error);
        } else {
          (values || []).forEach((v: any) => {
            analyteRows.push({
              parameter: `${r.test_name} - ${v.parameter}`,
              result: v.value,
              unit: v.unit || '',
              referenceRange: v.reference_range || '',
              flag: v.flag || ''
            });
          });
        }
      } catch (e) {
        console.warn('get_result_values failed for', r.result_id, e);
      }
    }

    if (analyteRows.length === 0) {
      group.test_names.forEach((tn) =>
        analyteRows.push({ parameter: tn, result: '—', unit: '', referenceRange: '' })
      );
    }

    return {
      patient: {
        name: group.patient_full_name,
        id: group.patient_id,
        age: group.age,
        gender: group.gender,
        referredBy: group.results[0]?.doctor || 'Self'
      },
      report: {
        reportId: group.order_id,
        collectionDate: group.order_date,
        reportDate: new Date().toISOString(),
        reportType: 'Lab Tests'
      },
      testResults: analyteRows,
      interpretation: 'Auto-generated report based on approved lab results.'
    };
  };

  const toggleOrderSelection = (orderId: string) => {
    const next = new Set(selectedOrders);
    if (next.has(orderId)) next.delete(orderId);
    else next.add(orderId);
    setSelectedOrders(next);
  };

  const selectAllOrders = () => setSelectedOrders(new Set(orderGroups.map((g) => g.order_id)));
  const clearSelection = () => setSelectedOrders(new Set());
  const clearAllFilters = () => {
    setSearchTerm('');
    setSelectedStatus('all');
    setSelectedTestType('all');
    setSelectedDoctor('all');
    setDateFilter('today');
  };

  const generateReport = async () => {
    if (selectedOrders.size === 0) {
      alert('Please select at least one order');
      return;
    }

    try {
      const userId = (await supabase.auth.getUser()).data.user?.id;
      if (!userId) {
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
              ignoreDuplicates: false,
            }
          );

          if (error) {
            console.error(`Error generating report for order ${orderId}:`, error);
            errorCount++;
          } else {
            successCount++;
          }
        } catch (e) {
          console.error(`Exception for order ${orderId}:`, e);
          errorCount++;
        }
      }

      clearSelection();

      if (successCount > 0 && errorCount === 0) {
        alert(`Successfully generated ${successCount} report(s)`);
      } else if (successCount > 0 && errorCount > 0) {
        alert(`Generated ${successCount} report(s), ${errorCount} failed`);
      } else {
        alert('Failed to generate reports. Please try again.');
      }

      await loadApprovedResults();
    } catch (e) {
      console.error('Error generating reports:', e);
      alert('An error occurred while generating reports');
    }
  };

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('desc');
    }
  };

  const getStatusBadge = (group: OrderGroup) => {
    const result = group.results[0] as ApprovedResult;
    
    if (result?.has_final_report) {
      return (
        <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800 border border-green-200">
          <CheckCircle className="w-3 h-3 mr-1" />
          Final Available
        </span>
      );
    }
    
    if (result?.has_draft_report) {
      return (
        <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800 border border-blue-200">
          <FileCheck className="w-3 h-3 mr-1" />
          Draft Available
        </span>
      );
    }
    
    if (group.is_report_ready) {
      return (
        <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-amber-100 text-amber-800 border border-amber-200">
          <Clock className="w-3 h-3 mr-1" />
          Ready to Generate
        </span>
      );
    }
    
    return (
      <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-600 border border-gray-200">
        <XCircle className="w-3 h-3 mr-1" />
        Pending Verification
      </span>
    );
  };

  const LoadingSkeleton = () => (
    <div className="space-y-4">
      {[...Array(5)].map((_, i) => (
        <div key={i} className="bg-white rounded-lg border border-gray-200 p-6 animate-pulse">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-4">
              <div className="w-4 h-4 bg-gray-200 rounded"></div>
              <div className="space-y-2">
                <div className="h-4 bg-gray-200 rounded w-48"></div>
                <div className="h-3 bg-gray-200 rounded w-32"></div>
              </div>
            </div>
            <div className="flex space-x-2">
              <div className="h-8 w-16 bg-gray-200 rounded"></div>
              <div className="h-8 w-24 bg-gray-200 rounded"></div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );

  const EmptyState = () => (
    <div className="bg-white rounded-lg border border-gray-200 p-12 text-center">
      <div className="mx-auto w-24 h-24 bg-gray-100 rounded-full flex items-center justify-center mb-6">
        <FileText className="w-12 h-12 text-gray-400" />
      </div>
      <h3 className="text-lg font-semibold text-gray-900 mb-2">No Reports Found</h3>
      <p className="text-gray-600 mb-6 max-w-md mx-auto">
        No approved results match your current filters. Try adjusting your search criteria or date range.
      </p>
      <div className="flex justify-center space-x-3">
        <button
          onClick={clearAllFilters}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
        >
          Clear All Filters
        </button>
        <button
          onClick={loadApprovedResults}
          className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
        >
          Refresh Data
        </button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Enhanced Header */}
      <div className="bg-white border-b shadow-sm px-6 py-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">Lab Reports</h1>
            <p className="text-gray-600 mt-2">Generate and manage laboratory test reports</p>
          </div>

          {/* Quick Stats */}
          <div className="hidden lg:flex items-center space-x-6">
            <div className="text-center">
              <div className="text-2xl font-bold text-blue-600">{statistics.totalOrders}</div>
              <div className="text-xs text-gray-500">Total Orders</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-green-600">{statistics.readyForGeneration}</div>
              <div className="text-xs text-gray-500">Ready</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-amber-600">{statistics.pendingVerification}</div>
              <div className="text-xs text-gray-500">Pending</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-gray-600">{statistics.completed}</div>
              <div className="text-xs text-gray-500">Completed</div>
            </div>
          </div>

          <button
            onClick={loadApprovedResults}
            className="flex items-center space-x-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
            disabled={loading}
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {/* Enhanced Filters Section */}
      <div className="bg-white border-b shadow-sm px-6 py-4">
        <div className="space-y-4">
          {/* Primary Search Bar */}
          <div className="flex flex-col sm:flex-row gap-4">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
              <input
                type="text"
                placeholder="Search patients, tests, samples, or order IDs..."
                className="w-full pl-10 pr-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-base"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
              {searchTerm && (
                <button
                  onClick={() => setSearchTerm('')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
            <button
              onClick={() => setShowFilters(!showFilters)}
              className={`flex items-center space-x-2 px-4 py-3 border rounded-lg transition-colors ${
                showFilters ? 'bg-blue-50 border-blue-300 text-blue-700' : 'border-gray-300 text-gray-700 hover:bg-gray-50'
              }`}
            >
              <Filter className="w-4 h-4" />
              <span>Filters</span>
              {(selectedStatus !== 'all' || selectedTestType !== 'all' || selectedDoctor !== 'all' || dateFilter !== 'today') && (
                <span className="w-2 h-2 bg-blue-500 rounded-full"></span>
              )}
            </button>
          </div>

          {/* Advanced Filters */}
          {showFilters && (
            <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Date Range</label>
                  <select
                    value={dateFilter}
                    onChange={(e) => setDateFilter(e.target.value as DateFilter)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  >
                    <option value="today">Today</option>
                    <option value="yesterday">Yesterday</option>
                    <option value="week">This Week</option>
                    <option value="month">This Month</option>
                    <option value="all">All Dates</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Report Status</label>
                  <select
                    value={selectedStatus}
                    onChange={(e) => setSelectedStatus(e.target.value as any)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  >
                    <option value="all">All Statuses</option>
                    <option value="ready">Ready to Generate</option>
                    <option value="pending">Pending Verification</option>
                    <option value="processing">Processing</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Test Type</label>
                  <select
                    value={selectedTestType}
                    onChange={(e) => setSelectedTestType(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  >
                    <option value="all">All Tests</option>
                    {uniqueTestTypes.map(type => (
                      <option key={type} value={type}>{type}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Doctor</label>
                  <select
                    value={selectedDoctor}
                    onChange={(e) => setSelectedDoctor(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  >
                    <option value="all">All Doctors</option>
                    {uniqueDoctors.map(doctor => (
                      <option key={doctor} value={doctor}>{doctor}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="flex items-center justify-between mt-4 pt-4 border-t border-gray-200">
                <div className="text-sm text-gray-600">
                  {orderGroups.length} orders found
                </div>
                <div className="flex space-x-2">
                  <button
                    onClick={clearAllFilters}
                    className="px-3 py-1 text-sm text-gray-600 border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
                  >
                    Clear All
                  </button>
                  <button
                    onClick={() => setShowFilters(false)}
                    className="px-3 py-1 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
                  >
                    Apply Filters
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Selection Actions */}
          {selectedOrders.size > 0 && (
            <div className="bg-blue-50 rounded-lg p-4 border border-blue-200">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-3">
                  <span className="text-sm font-medium text-blue-900">
                    {selectedOrders.size} order{selectedOrders.size !== 1 ? 's' : ''} selected
                  </span>
                  <button
                    onClick={clearSelection}
                    className="text-sm text-blue-700 hover:text-blue-900 underline"
                  >
                    Clear selection
                  </button>
                </div>
                <button
                  onClick={generateReport}
                  className="flex items-center space-x-2 px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 transition-colors"
                >
                  <FileText className="w-4 h-4" />
                  <span>Generate Reports</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Main Content */}
      <div className="p-6">
        {/* Statistics Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
            <div className="flex items-center">
              <div className="bg-blue-100 p-3 rounded-lg">
                <FileText className="h-6 w-6 text-blue-600" />
              </div>
              <div className="ml-4">
                <div className="text-2xl font-bold text-gray-900">{statistics.totalOrders}</div>
                <div className="text-sm text-gray-600">Total Orders</div>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
            <div className="flex items-center">
              <div className="bg-green-100 p-3 rounded-lg">
                <CheckCircle className="h-6 w-6 text-green-600" />
              </div>
              <div className="ml-4">
                <div className="text-2xl font-bold text-gray-900">{statistics.readyForGeneration}</div>
                <div className="text-sm text-gray-600">Ready for Reports</div>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
            <div className="flex items-center">
              <div className="bg-amber-100 p-3 rounded-lg">
                <Clock className="h-6 w-6 text-amber-600" />
              </div>
              <div className="ml-4">
                <div className="text-2xl font-bold text-gray-900">{statistics.pendingVerification}</div>
                <div className="text-sm text-gray-600">Pending Verification</div>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
            <div className="flex items-center">
              <div className="bg-purple-100 p-3 rounded-lg">
                <TrendingUp className="h-6 w-6 text-purple-600" />
              </div>
              <div className="ml-4">
                <div className="text-2xl font-bold text-gray-900">{statistics.completed}</div>
                <div className="text-sm text-gray-600">Completed</div>
              </div>
            </div>
          </div>
        </div>

        {/* Results Section */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200">
          <div className="px-6 py-4 border-b border-gray-200">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-semibold text-gray-900">Approved Results</h2>
                <p className="text-sm text-gray-600 mt-1">
                  {orderGroups.length} orders ready for report generation
                </p>
              </div>
              
              <div className="flex items-center space-x-2">
                <button
                  onClick={selectAllOrders}
                  className="text-sm text-blue-600 hover:text-blue-700 underline"
                  disabled={orderGroups.length === 0}
                >
                  Select All
                </button>
                <button
                  onClick={clearSelection}
                  className="text-sm text-gray-600 hover:text-gray-700 underline"
                  disabled={selectedOrders.size === 0}
                >
                  Clear All
                </button>
              </div>
            </div>
          </div>

          {/* Table Header */}
          <div className="hidden lg:block border-b border-gray-200 bg-gray-50">
            <div className="px-6 py-3">
              <div className="grid grid-cols-12 gap-4 text-xs font-medium text-gray-500 uppercase tracking-wider">
                <div className="col-span-1">Select</div>
                <div className="col-span-3">
                  <button
                    onClick={() => handleSort('patient_name')}
                    className="flex items-center space-x-1 hover:text-gray-700"
                  >
                    <span>Patient Information</span>
                    {sortField === 'patient_name' && (
                      sortDirection === 'asc' ? <SortAsc className="w-3 h-3" /> : <SortDesc className="w-3 h-3" />
                    )}
                  </button>
                </div>
                <div className="col-span-2">
                  <button
                    onClick={() => handleSort('test_name')}
                    className="flex items-center space-x-1 hover:text-gray-700"
                  >
                    <span>Tests</span>
                    {sortField === 'test_name' && (
                      sortDirection === 'asc' ? <SortAsc className="w-3 h-3" /> : <SortDesc className="w-3 h-3" />
                    )}
                  </button>
                </div>
                <div className="col-span-2">
                  <button
                    onClick={() => handleSort('order_date')}
                    className="flex items-center space-x-1 hover:text-gray-700"
                  >
                    <span>Order Date</span>
                    {sortField === 'order_date' && (
                      sortDirection === 'asc' ? <SortAsc className="w-3 h-3" /> : <SortDesc className="w-3 h-3" />
                    )}
                  </button>
                </div>
                <div className="col-span-2">Status</div>
                <div className="col-span-2">Actions</div>
              </div>
            </div>
          </div>

          {/* Results Content */}
          <div className="divide-y divide-gray-200">
            {loading ? (
              <div className="p-6">
                <LoadingSkeleton />
              </div>
            ) : orderGroups.length === 0 ? (
              <div className="p-6">
                <EmptyState />
              </div>
            ) : (
              <div className="max-h-[60vh] overflow-y-auto">
                {orderGroups.map((group, index) => (
                  <div 
                    key={group.order_id} 
                    className={`p-6 hover:bg-gray-50 transition-colors ${
                      index % 2 === 0 ? 'bg-white' : 'bg-gray-25'
                    }`}
                  >
                    {/* Desktop View */}
                    <div className="hidden lg:grid lg:grid-cols-12 lg:gap-4 lg:items-center">
                      <div className="col-span-1">
                        <input
                          type="checkbox"
                          checked={selectedOrders.has(group.order_id)}
                          onChange={() => toggleOrderSelection(group.order_id)}
                          className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 w-4 h-4"
                        />
                      </div>

                      <div className="col-span-3">
                        <div className="flex items-center space-x-3">
                          <div className="bg-blue-100 p-2 rounded-full">
                            <User className="w-4 h-4 text-blue-600" />
                          </div>
                          <div>
                            <div className="font-semibold text-gray-900 text-base">
                              {group.patient_full_name}
                            </div>
                            <div className="text-sm text-gray-600">
                              {group.age}y • {group.gender} • ID: {group.patient_id.slice(-8)}
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="col-span-2">
                        <div className="space-y-1">
                          {group.test_names.map((testName, idx) => (
                            <div key={idx} className="flex items-center space-x-2">
                              <TestTube className="w-3 h-3 text-gray-400" />
                              <span className="text-sm text-gray-900">{testName}</span>
                            </div>
                          ))}
                        </div>
                      </div>

                      <div className="col-span-2">
                        <div className="text-sm">
                          <div className="font-medium text-gray-900">
                            {safeFormatDate(group.order_date, 'MMM d, yyyy')}
                          </div>
                          <div className="text-gray-600">
                            Sample: {group.sample_ids.join(', ')}
                          </div>
                        </div>
                      </div>

                      <div className="col-span-2">
                        {getStatusBadge(group)}
                      </div>

                      <div className="col-span-2">
                        <div className="flex items-center space-x-2">
                          <button
                            className="flex items-center space-x-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
                            onClick={() => handleView(group.order_id)}
                          >
                            <Eye className="w-4 h-4" />
                            <span>View</span>
                          </button>
                          
                          {group.is_report_ready ? (
                            <>
                              {!(group.results[0] as ApprovedResult)?.has_final_report ? (
                                <button
                                  className={`flex items-center space-x-1 px-3 py-1.5 text-sm bg-green-600 text-white rounded-md hover:bg-green-700 transition-colors ${
                                    isGenerating ? 'opacity-50 cursor-not-allowed' : ''
                                  }`}
                                  onClick={() => handleDownload(group.order_id, false)}
                                  disabled={isGenerating}
                                  title="Generate final report"
                                >
                                  {isGenerating ? (
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                  ) : (
                                    <Download className="w-4 h-4" />
                                  )}
                                  <span>Final</span>
                                </button>
                              ) : (
                                <button
                                  className="flex items-center space-x-1 px-3 py-1.5 text-sm bg-green-600 text-white rounded-md hover:bg-green-700 transition-colors"
                                  onClick={() => {
                                    const finalReport = (group.results[0] as ApprovedResult)?.final_report;
                                    if (finalReport?.pdf_url) {
                                      window.open(finalReport.pdf_url, '_blank');
                                    }
                                  }}
                                  title="Download final report"
                                >
                                  <Download className="w-4 h-4" />
                                  <span>Download</span>
                                </button>
                              )}
                            </>
                          ) : (
                            <button
                              className={`flex items-center space-x-1 px-3 py-1.5 text-sm bg-amber-600 text-white rounded-md hover:bg-amber-700 transition-colors ${
                                isGenerating ? 'opacity-50 cursor-not-allowed' : ''
                              }`}
                              onClick={() => handleDownload(group.order_id, true)}
                              disabled={isGenerating}
                              title="Generate draft report"
                            >
                              {isGenerating ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                              ) : (
                                <Download className="w-4 h-4" />
                              )}
                              <span>Draft</span>
                            </button>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Mobile Card View */}
                    <div className="lg:hidden">
                      <div className="bg-white rounded-lg border border-gray-200 p-4 shadow-sm">
                        <div className="flex items-start justify-between mb-4">
                          <div className="flex items-center space-x-3">
                            <input
                              type="checkbox"
                              checked={selectedOrders.has(group.order_id)}
                              onChange={() => toggleOrderSelection(group.order_id)}
                              className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 w-4 h-4 mt-1"
                            />
                            <div>
                              <div className="font-semibold text-gray-900 text-lg">
                                {group.patient_full_name}
                              </div>
                              <div className="text-sm text-gray-600">
                                {group.age}y • {group.gender}
                              </div>
                            </div>
                          </div>
                          {getStatusBadge(group)}
                        </div>

                        <div className="space-y-3">
                          <div className="flex items-center justify-between">
                            <span className="text-sm text-gray-600">Order Date:</span>
                            <span className="text-sm font-medium text-gray-900">
                              {safeFormatDate(group.order_date, 'MMM d, yyyy')}
                            </span>
                          </div>

                          <div className="flex items-center justify-between">
                            <span className="text-sm text-gray-600">Tests:</span>
                            <span className="text-sm text-gray-900">
                              {group.test_names.length} test{group.test_names.length !== 1 ? 's' : ''}
                            </span>
                          </div>

                          <div className="flex items-center justify-between">
                            <span className="text-sm text-gray-600">Sample ID:</span>
                            <span className="text-sm font-mono text-gray-900">
                              {group.sample_ids.join(', ')}
                            </span>
                          </div>
                        </div>

                        <div className="flex space-x-2 mt-4 pt-4 border-t border-gray-200">
                          <button
                            className="flex-1 flex items-center justify-center space-x-1 px-3 py-2 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
                            onClick={() => handleView(group.order_id)}
                          >
                            <Eye className="w-4 h-4" />
                            <span>View</span>
                          </button>
                          
                          {group.is_report_ready ? (
                            <button
                              className={`flex-1 flex items-center justify-center space-x-1 px-3 py-2 text-sm bg-green-600 text-white rounded-md hover:bg-green-700 transition-colors ${
                                isGenerating ? 'opacity-50 cursor-not-allowed' : ''
                              }`}
                              onClick={() => handleDownload(group.order_id, false)}
                              disabled={isGenerating}
                            >
                              {isGenerating ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                              ) : (
                                <Download className="w-4 h-4" />
                              )}
                              <span>Final</span>
                            </button>
                          ) : (
                            <button
                              className={`flex-1 flex items-center justify-center space-x-1 px-3 py-2 text-sm bg-amber-600 text-white rounded-md hover:bg-amber-700 transition-colors ${
                                isGenerating ? 'opacity-50 cursor-not-allowed' : ''
                              }`}
                              onClick={() => handleDownload(group.order_id, true)}
                              disabled={isGenerating}
                            >
                              {isGenerating ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                              ) : (
                                <Download className="w-4 h-4" />
                              )}
                              <span>Draft</span>
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Footer Summary */}
        <div className="mt-8 bg-gradient-to-r from-blue-50 to-purple-50 rounded-lg p-6 border border-blue-200">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 text-sm">
            <div className="flex items-center space-x-6">
              <div className="flex items-center">
                <Calendar className="h-4 w-4 text-blue-600 mr-2" />
                <span className="text-blue-900 font-medium">
                  Viewing: {dateFilter === 'all' ? 'All dates' : dateFilter}
                </span>
              </div>
              <div className="flex items-center">
                <AlertTriangle className="h-4 w-4 text-red-600 mr-2" />
                <span className="text-red-900 font-medium">
                  Urgent: {orderGroups.filter(g => g.results.some(r => r.verification_status === 'verified')).length}
                </span>
              </div>
            </div>
            <div className="flex items-center">
              <TrendingUp className="h-4 w-4 text-purple-600 mr-2" />
              <span className="text-purple-900 font-medium">
                Average TAT: {orderGroups.length > 0 ? 
                  Math.round(
                    orderGroups.reduce((sum, g) => {
                      const orderDate = new Date(g.order_date).getTime();
                      const verifiedDate = new Date(g.verified_at).getTime();
                      return sum + ((verifiedDate - orderDate) / (1000 * 60 * 60));
                    }, 0) / orderGroups.length
                  ) : 0
                }h
              </span>
            </div>
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