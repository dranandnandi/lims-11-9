import React, { useState } from 'react';
import { 
  FileText,
  Brain,
  TestTube,
  Activity,
  RefreshCw
} from 'lucide-react';
import { Result, initializeStorage } from '../utils/localStorage';
import { database, supabase } from '../utils/supabase';
import { useAuth } from '../contexts/AuthContext';
import { hasAbnormalFlags } from '../utils/flagCalculation';

// Import Entry Mode Components
// import OrderSelector from '../components/Results/EntryMode/OrderSelector';
import AIUploadPanel from '../components/Results/EntryMode/AIUploadPanel';
import ManualEntryForm from '../components/Results/EntryMode/ManualEntryForm';
import WorkflowPanel from '../components/Results/EntryMode/WorkflowPanel';
import DepartmentView from '../components/Results/EntryMode/DepartmentView';
import EnhancedViewSelector from '../components/Results/EnhancedViewSelector';
import ResultStatsDashboard from '../components/Results/ResultStatsDashboard';
import BatchOperations from '../components/Results/BatchOperations';
// QuickActionToolbar intentionally disabled to avoid scroll issues

// Verification stats interface kept for future use
// interface VerificationStats {
//   pending_count: number;
//   approved_count: number;
//   rejected_count: number;
//   clarification_count: number;
//   urgent_count: number;
//   avg_verification_time_hours: number;
// }

// Enhanced types for the new entry system
interface OrderTestProgress {
  order_id: string;
  patient_id: string;
  patient_name: string;
  sample_id: string;
  order_status: string;
  priority: string;
  test_group_id: string;
  test_group_name: string;
  department: string;
  total_analytes: number;
  completed_analytes: number;
  panel_status: 'not_started' | 'in_progress' | 'completed';
  completion_percentage: number;
  workflow_eligible: boolean;
  last_activity: string;
  hours_since_order: number;
}

interface OrderWithProgress {
  id: string;
  patient_name: string;
  patient_id?: string; // Add this
  age?: number;
  sample_id: string;
  priority: string;
  status: string;
  created_at: string;
  lab_id?: string; // Add this
  color_code?: string | null;
  color_name?: string | null;
  testGroups: OrderTestProgress[];
  totalTests: number;
  completedTests: number;
  percentComplete: number;
}

interface ProcessingStatus {
  id: string;
  status: 'uploading' | 'processing' | 'completed' | 'failed';
  progress: number;
  message?: string;
  results?: any[];
}

type ViewMode = 'entry' | 'review';
type EntryViewMode = 'order-based' | 'test-group' | 'department';
type EntryMethod = 'ai-upload' | 'manual' | 'workflow';

const Results: React.FC = () => {
  useAuth();
  const [results, setResults] = useState<Result[]>([]);
  // const [verificationStats, setVerificationStats] = useState<VerificationStats | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  // Unused legacy states removed during entry-mode refactor
  const [viewMode, setViewMode] = useState<ViewMode>('entry');
  const [loading, setLoading] = useState(false);

  // New state for entry mode
  const [entryViewMode, setEntryViewMode] = useState<EntryViewMode>('order-based');
  const [entryMethod, setEntryMethod] = useState<EntryMethod>('ai-upload');
  const [selectedOrder, setSelectedOrder] = useState<OrderWithProgress | null>(null);
  // Removed unused local states from earlier implementations
  const [, setProcessingStatus] = useState<ProcessingStatus | null>(null);
  const [selectedDepartment, setSelectedDepartment] = useState<string | null>(null);
  const [availableTestGroups, setAvailableTestGroups] = useState<{ id: string; name: string; department: string }[]>([]);
  const [selectedTestGroupId, setSelectedTestGroupId] = useState<string | null>(null);
  const [currentLabId, setCurrentLabId] = useState<string>('');

  // Enhanced filter state
  const [filters, setFilters] = useState({
    mode: viewMode,
    entrySubMode: entryViewMode,
    searchTerm: '',
    department: null as string | null,
    status: 'pending',
    priority: 'all',
    dateRange: 'today',
    dateFrom: '' as string | null,
    dateTo: '' as string | null,
    urgentOnly: false,
    workflowEligibleOnly: false
  });

  // Available departments (derived from data)
  const [availableDepartments, setAvailableDepartments] = useState<string[]>([]);

  // Batch operations state
  const [showBatchOperations, setShowBatchOperations] = useState(false);
  const [selectedForBatch, setSelectedForBatch] = useState<Set<string>>(new Set());

  // Real-time updates state
  const [realTimeNotification, setRealTimeNotification] = useState<{
    message: string;
    type: 'info' | 'success' | 'warning';
    timestamp: Date;
  } | null>(null);
  const [showStats, setShowStats] = useState(false);

  // Performance optimization state
  const [pagination, setPagination] = useState({
    page: 1,
    pageSize: 50,
    total: 0
  });
  const [, setLoadingMore] = useState(false);

  // helper: compute age from yyyy-mm-dd
  const calculateAge = (dobIso: string): number => {
    const dob = new Date(dobIso);
    const today = new Date();
    let age = today.getFullYear() - dob.getFullYear();
    const m = today.getMonth() - dob.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) {
      age--;
    }
    return age;
  };

  // Load results from localStorage on component mount
  React.useEffect(() => {
    initializeStorage(); // Initialize local storage for other data (e.g., analytes, test groups)
    fetchResults();
    fetchDepartments();
    fetchTestGroups();
    setupRealTimeSubscriptions();
    database.getCurrentUserLabId().then(id => setCurrentLabId(id || ''));
    
    // Cleanup subscriptions on unmount
    return () => {
      cleanupSubscriptions();
    };
  }, []);

  // Refetch data when view mode changes
  React.useEffect(() => {
    fetchResults(); // Refetch appropriate data for the current view mode
  }, [viewMode]);

  // Real-time subscription management
  const [subscriptions, setSubscriptions] = useState<any[]>([]);

  const setupRealTimeSubscriptions = async () => {
    const userLabId = await database.getCurrentUserLabId();
    if (!userLabId) return;

    // Subscribe to results table changes
    const resultsSubscription = supabase
      .channel('results-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'results',
          filter: `lab_id=eq.${userLabId}`
        },
        (payload) => {
          console.log('Results table change detected:', payload);
          handleResultsRealTimeUpdate(payload);
        }
      )
      .subscribe();

    // Subscribe to result_values table changes
    const resultValuesSubscription = supabase
      .channel('result-values-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'result_values'
        },
        (payload: any) => {
          console.log('Result values change detected:', payload);
          handleResultValuesRealTimeUpdate();
        }
      )
      .subscribe();

    // Subscribe to orders table changes for status updates
    const ordersSubscription = supabase
      .channel('orders-changes')
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'orders',
          filter: `lab_id=eq.${userLabId}`
        },
        (payload: any) => {
          console.log('Order status change detected:', payload);
          handleOrderStatusRealTimeUpdate(payload);
        }
      )
      .subscribe();

    setSubscriptions([resultsSubscription, resultValuesSubscription, ordersSubscription]);
  };

  const cleanupSubscriptions = () => {
    subscriptions.forEach(subscription => {
      supabase.removeChannel(subscription);
    });
    setSubscriptions([]);
  };

  const handleResultsRealTimeUpdate = (payload: any) => {
    const { eventType, new: newRecord, old: oldRecord } = payload as {
      eventType: 'INSERT' | 'UPDATE' | 'DELETE';
      new: any;
      old: any;
    };
    
    // Show notification
    const notificationMessage = {
      INSERT: 'New result added',
      UPDATE: 'Result updated',
      DELETE: 'Result deleted'
    }[eventType] || 'Result changed';
    
    setRealTimeNotification({
      message: notificationMessage,
      type: eventType === 'DELETE' ? 'warning' : 'info',
      timestamp: new Date()
    });
    
    // Clear notification after 3 seconds
    setTimeout(() => setRealTimeNotification(null), 3000);
    
    setResults(prevResults => {
      switch (eventType) {
        case 'INSERT':
          // Add new result if it doesn't exist
          const existsInsert = prevResults.some(r => r.id === newRecord.id);
          if (!existsInsert) {
            const newResult = mapResultFromDatabase(newRecord);
            return [...prevResults, newResult];
          }
          return prevResults;
          
        case 'UPDATE':
          // Update existing result
          return prevResults.map(result => 
            result.id === newRecord.id 
              ? { ...result, ...mapResultFromDatabase(newRecord) }
              : result
          );
          
        case 'DELETE':
          // Remove deleted result
          return prevResults.filter(result => result.id !== oldRecord.id);
          
        default:
          return prevResults;
      }
    });
  };

  const handleResultValuesRealTimeUpdate = () => {
    // Show notification for value changes
    setRealTimeNotification({
      message: 'Result values updated',
      type: 'success',
      timestamp: new Date()
    });
    
    // Clear notification after 3 seconds
    setTimeout(() => setRealTimeNotification(null), 3000);
    
    // Refresh the entire results list when result values change
    // This ensures we get the latest values with proper joins
    fetchResults();
  };

  const handleOrderStatusRealTimeUpdate = (payload: any) => {
    const { new: newRecord } = payload;
    
    // Show notification for order status changes
    setRealTimeNotification({
      message: `Order status updated to ${newRecord.status}`,
      type: 'info',
      timestamp: new Date()
    });
    
    // Clear notification after 3 seconds
    setTimeout(() => setRealTimeNotification(null), 3000);
    
    // Update any orders in our current view
    setSelectedOrder(prevOrder => {
      if (prevOrder && prevOrder.id === newRecord.id) {
        return {
          ...prevOrder,
          status: newRecord.status
        };
      }
      return prevOrder;
    });
    
    // Also refresh the results to get updated order status
    fetchResults();
  };

  const mapResultFromDatabase = (dbResult: any): Result => {
    return {
      id: dbResult.id,
      orderId: dbResult.order_id,
      patientId: dbResult.patient_id,
      patientName: dbResult.patient_name || 'Unknown Patient',
      testName: dbResult.test_name || 'Unknown Test',
      status: dbResult.status,
      enteredBy: dbResult.entered_by,
      enteredDate: dbResult.entered_date,
      reviewedBy: dbResult.reviewed_by,
      reviewedDate: dbResult.reviewed_date,
      attachmentId: dbResult.attachment_id,
      values: [] // Will be populated by separate query or from joined data
    };
  };

  // Fetch available departments
  const fetchDepartments = async () => {
    try {
      const userLabId = await database.getCurrentUserLabId();
      if (!userLabId) return;

      const { data, error } = await supabase
        .from('v_order_test_progress_enhanced')
        .select('department')
        .eq('lab_id', userLabId);

      if (error) throw error;

      const uniqueDepartments = Array.from(new Set(data?.map((row: any) => row.department) || [])) as string[];
      setAvailableDepartments(uniqueDepartments.sort());
    } catch (error) {
      console.error('Error fetching departments:', error);
    }
  };

  // Fetch available test groups
  const fetchTestGroups = async () => {
    try {
      const userLabId = await database.getCurrentUserLabId();
      if (!userLabId) return;
      const { data, error } = await supabase
        .from('v_order_test_progress_enhanced')
        .select('test_group_id, test_group_name, department')
        .eq('lab_id', userLabId);
      if (error) throw error;
      const map = new Map<string, { id: string; name: string; department: string }>();
      (data || []).forEach((r: any) => {
        if (!map.has(r.test_group_id)) {
          map.set(r.test_group_id, { id: r.test_group_id, name: r.test_group_name, department: r.department });
        }
      });
      setAvailableTestGroups(Array.from(map.values()));
    } catch (e) {
      console.error('Error fetching test groups:', e);
    }
  };

  // Enhanced summary statistics with verification stats
  const summaryStats = React.useMemo(() => {
    const pendingReview = results.filter(r => r.status === 'Under Review').length;
    const approved = results.filter(r => r.status === 'Approved').length;
    const reported = results.filter(r => r.status === 'Reported').length;
    const abnormal = results.filter(r => hasAbnormalFlags(r.values.map(v => ({ 
      ...v, 
      reference_range: v.reference 
    })))).length;
    const avgTurnaround = results.length > 0 ? 
      Math.round(results.reduce((sum, r) => {
        const entryDate = new Date(r.enteredDate);
        const reviewDate = r.reviewedDate ? new Date(r.reviewedDate) : new Date();
        const diffHours = (reviewDate.getTime() - entryDate.getTime()) / (1000 * 60 * 60);
        return sum + diffHours;
      }, 0) / results.length) : 0;

    return { 
      pendingReview, 
      approved, 
      reported, 
      abnormal, 
      avgTurnaround,
      total: results.length,
      critical: results.filter(r => r.values.some(v => v.flag === 'C')).length
    };
  }, [results]);

  const fetchResults = async (page = 1, append = false) => {
    try {
      setLoading(!append);
      if (append) setLoadingMore(true);
      
      // Get user's lab ID
      const userLabId = await database.getCurrentUserLabId();
      if (!userLabId) {
        console.error('User lab_id not available');
        setLoading(false);
        setLoadingMore(false);
        return;
      }
      
      // Calculate offset for pagination
      const offset = (page - 1) * pagination.pageSize;
      
      // Entry mode: fetch worklist from v_order_test_progress_enhanced (not results)
      if (viewMode === 'entry') {
        // Fetch orders from the enhanced view that shows test progress
        let query = supabase
          .from('v_order_test_progress_enhanced')
          .select(`*, order_test_id`, { count: 'exact' })
          .eq('lab_id', userLabId)
          .order('order_date', { ascending: false });

        // Apply date range filters
        const now = new Date();
        const fmt = (d: Date) => d.toISOString().split('T')[0]; // YYYY-MM-DD
        if (filters.dateRange === 'today') {
          const todayStr = fmt(new Date());
          query = query.eq('order_date', todayStr);
        } else if (filters.dateRange === '7d') {
          const start = new Date(now);
          start.setDate(now.getDate() - 7);
          query = query.gte('order_date', fmt(start)).lte('order_date', fmt(now));
        } else if (filters.dateRange === '30d') {
          const start = new Date(now);
          start.setDate(now.getDate() - 30);
          query = query.gte('order_date', fmt(start)).lte('order_date', fmt(now));
        } else if (filters.dateRange === '90d') {
          const start = new Date(now);
          start.setDate(now.getDate() - 90);
          query = query.gte('order_date', fmt(start)).lte('order_date', fmt(now));
        } else if (filters.dateRange === 'custom' && filters.dateFrom && filters.dateTo) {
          query = query.gte('order_date', filters.dateFrom).lte('order_date', filters.dateTo);
        }
        // Status filter mapping
        if (filters.status === 'pending') {
          query = query.neq('panel_status', 'completed');
        } else if (filters.status === 'in_progress') {
          query = query.eq('panel_status', 'in_progress');
        } else if (filters.status === 'completed') {
          query = query.eq('panel_status', 'completed');
        }

        // Department filter
        if (filters.department) {
          query = query.eq('department', filters.department);
        }

        // Priority filter mapping (normalize UI values to DB enum/text)
        if (filters.priority && filters.priority !== 'all') {
          const mapPriority = (p: string) => (
            p === 'URGENT' ? 'Urgent' :
            p === 'HIGH' ? 'High' :
            p === 'NORMAL' ? 'Normal' : p
          );
          query = query.eq('priority', mapPriority(filters.priority));
        }

        // Urgent only: include STAT and Urgent
        if (filters.urgentOnly) {
          query = query.in('priority', ['STAT', 'Urgent']);
        }

        // Workflow eligible only
        if (filters.workflowEligibleOnly) {
          query = query.eq('workflow_eligible', true);
        }

        const { data, error, count } = await query.range(offset, offset + pagination.pageSize - 1);

        if (error) {
          console.error('Error loading orders for entry:', error);
          setLoading(false);
          setLoadingMore(false);
          return;
        }

        if (data) {
          // Group by order and create a consolidated view
          const orderMap = new Map<string, any>();
          
          data.forEach(row => {
            if (!orderMap.has(row.order_id)) {
              orderMap.set(row.order_id, {
                id: row.order_id, // Map to expected Result interface
                orderId: row.order_id,
                patientName: row.patient_name,
                patient_id: row.patient_id,
                patientId: '', // Will be populated if needed
                testName: row.test_group_name,
                status: row.panel_status || 'Pending Entry',
                enteredBy: '',
                enteredDate: row.created_at,
                reviewedBy: '',
                reviewedDate: '',
                values: [],
                sampleId: row.sample_id,
                priority: row.priority,
                department: row.department,
                workflowEligible: row.workflow_eligible,
                percentComplete: row.completion_percentage,
                testGroups: []
              });
            }
            
            // Add test group info
            const order = orderMap.get(row.order_id);
            order.testGroups.push({
              test_group_id: row.test_group_id,
              test_group_name: row.test_group_name,
              department: row.department,
              panel_status: row.panel_status,
              completed_analytes: row.completed_analytes,
              total_analytes: row.total_analytes,
              workflow_eligible: row.workflow_eligible
            });
            // keep a reference to latest order_test_id at order level for convenience
            order.last_order_test_id = row.order_test_id;
          });

          // Enrich with patient age and order color info
          const ordersArray = Array.from(orderMap.values());
          const uniquePatientIds = Array.from(new Set(ordersArray.map((o: any) => o.patient_id).filter(Boolean)));
          const uniqueOrderIds = Array.from(new Set(ordersArray.map((o: any) => o.id)));

          // Fetch patients DOB to compute age
          if (uniquePatientIds.length > 0) {
            const { data: patientsData } = await supabase
              .from('patients')
              .select('id, date_of_birth')
              .in('id', uniquePatientIds);
            const dobMap = new Map<string, string | null>((patientsData || []).map((p: any) => [p.id, p.date_of_birth]));
            ordersArray.forEach((o: any) => {
              const dob = o.patient_id ? dobMap.get(o.patient_id) : null;
              o.age = dob ? calculateAge(dob) : undefined;
            });
          }

          // Fetch color assignment for orders
          if (uniqueOrderIds.length > 0) {
            const { data: orderInfo } = await supabase
              .from('orders')
              .select('id, color_code, color_name')
              .eq('lab_id', userLabId)
              .in('id', uniqueOrderIds);
            const colorMap = new Map<string, { color_code: string | null, color_name: string | null }>((orderInfo || []).map((o: any) => [o.id, { color_code: o.color_code, color_name: o.color_name }]));
            ordersArray.forEach((o: any) => {
              const c = colorMap.get(o.id);
              o.color_code = c?.color_code || null;
              o.color_name = c?.color_name || null;
            });
          }

          const ordersAsResults = Array.from(orderMap.values());
          
          if (append) {
            setResults(prev => [...prev, ...ordersAsResults]);
          } else {
            setResults(ordersAsResults);
          }
          
          setPagination(prev => ({
            ...prev,
            total: count || 0,
            page: page
          }));
        }
      } else {
        // For review/verification modes: defer implementation (keep placeholder view); don't fetch results here to avoid coupling
        setResults([]);
      }

      // Note: verification stats load removed in entry-mode focus
    } catch (err) {
      console.error('Error fetching results:', err);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  };

  // Filter and view mode handlers
  const handleFiltersChange = (newFilters: Partial<typeof filters>, refreshNow: boolean = false) => {
    setFilters(prev => ({ ...prev, ...newFilters }));
    
    // Update related state variables for backward compatibility
    if (newFilters.searchTerm !== undefined) setSearchTerm(newFilters.searchTerm);
    if (newFilters.department !== undefined) setSelectedDepartment(newFilters.department);
    // Auto-refresh when any server-side filter changes
    if (
      refreshNow ||
      'status' in newFilters ||
      'dateRange' in newFilters ||
      'department' in newFilters ||
      'dateFrom' in newFilters ||
      'dateTo' in newFilters ||
      'priority' in newFilters ||
      'urgentOnly' in newFilters ||
      'workflowEligibleOnly' in newFilters
    ) {
      setTimeout(() => fetchResults(), 0);
    }
  };

  const handleViewModeChange = (mode: 'entry' | 'review') => {
    setViewMode(mode);
    setFilters(prev => ({ ...prev, mode }));
  };

  const handleEntryViewModeChange = (mode: 'order-based' | 'test-group' | 'department') => {
    setEntryViewMode(mode);
    setFilters(prev => ({ ...prev, entrySubMode: mode }));
  };

  // Calculate result counts for view mode selector
  const resultCounts = React.useMemo(() => {
    return {
      entry: results.filter(r => r.status === 'Entered' || r.status === 'Under Review').length,
      review: results.filter(r => r.status === 'Under Review').length
    };
  }, [results]);

  // Entry Mode Functions
  const handleOrderSelect = (order: OrderWithProgress) => {
    setSelectedOrder(order);
  };

  const handleUploadComplete = (uploadResults: any[]) => {
    console.log('Upload completed:', uploadResults);
    // Refresh results
    fetchResults();
  };

  const handleManualEntrySubmit = (entryResults: any[]) => {
    console.log('Manual entry completed:', entryResults);
    // Refresh results
    fetchResults();
  };

  const handleWorkflowComplete = (workflowResults: any[]) => {
    console.log('Workflow completed:', workflowResults);
    // Refresh results
    fetchResults();
  };

  // Batch Operations Handlers
  const handleSelectAllForBatch = () => {
    const allIds = new Set(results.map(r => r.id));
    setSelectedForBatch(allIds);
  };

  const handleClearBatchSelection = () => {
    setSelectedForBatch(new Set());
  };

  const handleBatchOperation = async (operationId: string, selectedIds: string[]) => {
    try {
      console.log(`Executing batch operation ${operationId} on ${selectedIds.length} items`);
      
      switch (operationId) {
        case 'approve':
          // Implement batch approval
          for (const id of selectedIds) {
            await database.results.update(id, { status: 'Approved' });
          }
          break;
          
        case 'reject':
          // Implement batch rejection - not a standard status, using Under Review instead
          for (const id of selectedIds) {
            await database.results.update(id, { status: 'Under Review' });
          }
          break;
          
        case 'mark-reviewed':
          // Implement batch review marking
          for (const id of selectedIds) {
            await database.results.update(id, { status: 'Under Review' });
          }
          break;
          
        case 'export-csv':
          // Implement CSV export
          const selectedResults = results.filter(r => selectedIds.includes(r.id));
          downloadCSV(selectedResults);
          break;
          
        case 'print-reports':
          // Implement batch printing
          const reportData = results.filter(r => selectedIds.includes(r.id));
          generatePrintReports(reportData);
          break;
          
        default:
          console.warn(`Unknown batch operation: ${operationId}`);
      }
      
      // Refresh data and clear selection
      await fetchResults();
      setSelectedForBatch(new Set());
      setShowBatchOperations(false);
      
    } catch (error) {
      console.error('Batch operation failed:', error);
      throw error;
    }
  };

  // Quick Action Handlers
  // Quick actions removed with toolbar

  // Utility functions
  const downloadCSV = (data: any[]) => {
    const csv = convertToCSV(data);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `results_export_${new Date().toISOString().split('T')[0]}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const convertToCSV = (objArray: any[]) => {
    const array = typeof objArray !== 'object' ? JSON.parse(objArray) : objArray;
    let str = '';
    
    if (array.length > 0) {
      const headers = Object.keys(array[0]);
      str += headers.join(',') + '\r\n';
      
      array.forEach((item: any) => {
        let line = '';
        headers.forEach((header, index) => {
          if (index > 0) line += ',';
          line += `"${item[header] || ''}"`;
        });
        str += line + '\r\n';
      });
    }
    
    return str;
  };

  const generatePrintReports = (reportData: any[]) => {
    // Create a new window for printing
    const printWindow = window.open('', '_blank');
    if (printWindow) {
      printWindow.document.write(`
        <html>
          <head>
            <title>Lab Results Report</title>
            <style>
              body { font-family: Arial, sans-serif; margin: 20px; }
              .result { page-break-after: always; margin-bottom: 30px; }
              .header { border-bottom: 2px solid #000; padding-bottom: 10px; margin-bottom: 20px; }
              .values { margin-top: 20px; }
              .value-row { display: flex; justify-content: space-between; padding: 5px 0; border-bottom: 1px solid #eee; }
            </style>
          </head>
          <body>
            ${reportData.map(result => `
              <div class="result">
                <div class="header">
                  <h2>Lab Result Report</h2>
                  <p><strong>Patient:</strong> ${result.patientName}</p>
                  <p><strong>Test:</strong> ${result.testName}</p>
                  <p><strong>Order ID:</strong> ${result.orderId}</p>
                  <p><strong>Date:</strong> ${new Date(result.enteredDate).toLocaleDateString()}</p>
                </div>
                <div class="values">
                  <h3>Results:</h3>
                  ${result.values.map((value: any) => `
                    <div class="value-row">
                      <span><strong>${value.parameter}:</strong></span>
                      <span>${value.value} ${value.unit || ''}</span>
                      <span>${value.reference || ''}</span>
                      <span>${value.flag || ''}</span>
                    </div>
                  `).join('')}
                </div>
              </div>
            `).join('')}
          </body>
        </html>
      `);
      printWindow.document.close();
      printWindow.print();
    }
  };

  // Entry Mode Render Functions
  const renderEntryMode = () => {
    if (entryViewMode === 'order-based') {
      // List-first: show only list when no selection; on selection, show full-width detail with Back
      if (!selectedOrder) {
        return (
          <div className="space-y-3">
            {/* Compact order cards */}
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {results
                .filter((r: any) => (filters.searchTerm ? (r.patientName?.toLowerCase()?.includes(filters.searchTerm.toLowerCase())) : true))
                .map((r: any) => (
                  <button
                    key={r.id}
                    onClick={() => handleOrderSelect(r as any)}
                    className="text-left p-3 border rounded-lg hover:bg-gray-50 bg-white"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span
                          className="inline-block w-3 h-3 rounded-full border"
                          style={{ backgroundColor: r.color_code || '#e5e7eb' }}
                          title={r.color_name || 'Tube'}
                        />
                        <div className="font-medium text-gray-900">{r.patientName}</div>
                        {typeof r.age === 'number' && (
                          <div className="text-xs text-gray-500">• {r.age}y</div>
                        )}
                      </div>
                      <div className="text-xs text-gray-500">{r.sampleId || 'No Sample'}</div>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {(r.testGroups || []).slice(0, 4).map((tg: any) => (
                        <span key={tg.test_group_id} className="px-2 py-0.5 text-xs rounded-full border bg-gray-50 text-gray-700">
                          {tg.test_group_name}
                        </span>
                      ))}
                      {r.testGroups && r.testGroups.length > 4 && (
                        <span className="px-2 py-0.5 text-xs rounded-full border bg-gray-50 text-gray-500">+{r.testGroups.length - 4} more</span>
                      )}
                    </div>
                  </button>
              ))}
              {results.length === 0 && (
                <div className="col-span-full text-sm text-gray-500 p-6 text-center border rounded-md bg-white">
                  No orders for {filters.dateRange === 'today' ? 'Today' :
                  filters.dateRange === '7d' ? 'Last 7 days' :
                  filters.dateRange === '30d' ? 'Last 30 days' :
                  filters.dateRange === '90d' ? 'Last 90 days' :
                  filters.dateRange === 'all' ? 'All Dates' : 'selected range'}
                  {filters.status === 'pending' ? ' (Pending)' : ''}
                </div>
              )}
            </div>
          </div>
        );
      }
      return (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <button
              onClick={() => setSelectedOrder(null)}
              className="text-sm px-3 py-1.5 border rounded-md hover:bg-gray-50"
            >
              ← Back to Orders
            </button>
            <div />
          </div>
          <div className="space-y-6">
                {/* Order Header */}
                <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
                  <div className="flex justify-between items-start mb-4">
                    <div>
                      <h2 className="text-xl font-semibold text-gray-900">
                        Result Entry - Order #{selectedOrder.id.slice(0, 8)}
                      </h2>
                      <div className="mt-1 text-sm text-gray-600">
                        Patient: {selectedOrder.patient_name}
                      </div>
                      {selectedOrder.sample_id && (
                        <div className="text-sm text-gray-500">
                          Sample ID: {selectedOrder.sample_id}
                        </div>
                      )}
                    </div>
                    <span className={`px-3 py-1 rounded-full text-sm ${
                      selectedOrder.priority === 'STAT' 
                        ? 'bg-red-100 text-red-700' 
                        : selectedOrder.priority === 'Urgent'
                        ? 'bg-orange-100 text-orange-700'
                        : 'bg-gray-100 text-gray-700'
                    }`}>
                      {selectedOrder.priority}
                    </span>
                  </div>

                  {/* Progress Overview */}
                  <div className="mb-4">
                    <div className="flex justify-between text-sm text-gray-600 mb-1">
                      <span>Overall Progress</span>
                      <span>{selectedOrder.percentComplete}%</span>
                    </div>
                    <div className="w-full bg-gray-200 rounded-full h-2">
                      <div
                        className={`h-2 rounded-full transition-all ${
                          selectedOrder.percentComplete === 100 ? 'bg-green-500' : 'bg-blue-500'
                        }`}
                        style={{ width: `${selectedOrder.percentComplete}%` }}
                      />
                    </div>
                  </div>

                  {/* Test Groups */}
                  <div className="space-y-2">
                    <h4 className="font-medium text-gray-900">Test Groups</h4>
                    <div className="grid gap-2">
                      {selectedOrder.testGroups.map((testGroup) => (
                        <div
                          key={testGroup.test_group_id}
                          className={`p-3 border rounded-lg ${
                            testGroup.panel_status === 'completed'
                              ? 'bg-green-50 border-green-200'
                              : testGroup.panel_status === 'in_progress'
                              ? 'bg-blue-50 border-blue-200'
                              : 'bg-gray-50 border-gray-200'
                          }`}
                        >
                          <div className="flex justify-between items-center">
                            <div>
                              <div className="font-medium text-gray-900">
                                {testGroup.test_group_name}
                              </div>
                              <div className="text-sm text-gray-600">
                                {testGroup.department} • {testGroup.completed_analytes}/{testGroup.total_analytes} completed
                              </div>
                            </div>
                            <div className="flex items-center space-x-2">
                              {testGroup.workflow_eligible && (
                                <span className="text-xs bg-purple-100 text-purple-700 px-2 py-1 rounded">
                                  Workflow Ready
                                </span>
                              )}
                              <span className={`text-xs px-2 py-1 rounded ${
                                testGroup.panel_status === 'completed'
                                  ? 'bg-green-100 text-green-700'
                                  : testGroup.panel_status === 'in_progress'
                                  ? 'bg-blue-100 text-blue-700'
                                  : 'bg-gray-100 text-gray-700'
                              }`}>
                                {testGroup.panel_status.replace('_', ' ')}
                              </span>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Entry Method Tabs */}
                <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
                  <div className="flex space-x-1 mb-6 bg-gray-100 rounded-lg p-1">
                    <button
                      onClick={() => setEntryMethod('ai-upload')}
                      className={`flex-1 px-4 py-2 rounded-md transition-colors ${
                        entryMethod === 'ai-upload'
                          ? 'bg-white shadow-sm text-gray-900'
                          : 'text-gray-600 hover:text-gray-900'
                      }`}
                    >
                      <Brain className="h-4 w-4 inline mr-2" />
                      AI Upload
                    </button>
                    <button
                      onClick={() => setEntryMethod('manual')}
                      className={`flex-1 px-4 py-2 rounded-md transition-colors ${
                        entryMethod === 'manual'
                          ? 'bg-white shadow-sm text-gray-900'
                          : 'text-gray-600 hover:text-gray-900'
                      }`}
                    >
                      <TestTube className="h-4 w-4 inline mr-2" />
                      Manual Entry
                    </button>
                    <button
                      onClick={() => setEntryMethod('workflow')}
                      className={`flex-1 px-4 py-2 rounded-md transition-colors ${
                        entryMethod === 'workflow'
                          ? 'bg-white shadow-sm text-gray-900'
                          : 'text-gray-600 hover:text-gray-900'
                      }`}
                    >
                      <Activity className="h-4 w-4 inline mr-2" />
                      Workflow
                    </button>
                  </div>

                  {/* Entry Method Content */}
                  {entryMethod === 'ai-upload' && (
                    <AIUploadPanel
                      order={{
                        id: selectedOrder.id,
                        patient_name: selectedOrder.patient_name,
                        patient_id: selectedOrder.patient_id || '', // Ensure patient_id is passed
                        lab_id: selectedOrder.lab_id || currentLabId
                      }}
                      onUploadComplete={handleUploadComplete}
                      onProgressUpdate={setProcessingStatus}
                    />
                  )}

                  {entryMethod === 'manual' && selectedOrder.testGroups.length > 0 && (
                    <ManualEntryForm
                      order={{
                        id: selectedOrder.id,
                        patient_id: selectedOrder.patient_id || '',
                        patient_name: selectedOrder.patient_name,
                        lab_id: selectedOrder.lab_id || currentLabId
                      }}
                      testGroup={{
                        id: selectedOrder.testGroups[0].test_group_id,
                        name: selectedOrder.testGroups[0].test_group_name,
                        department: selectedOrder.testGroups[0].department
                      }}
                      onSubmit={handleManualEntrySubmit}
                    />
                  )}

                  {entryMethod === 'workflow' && selectedOrder.testGroups.length > 0 && (
                    <WorkflowPanel
                      order={{
                        id: selectedOrder.id,
                        patient_id: selectedOrder.patient_id || '',
                        patient_name: selectedOrder.patient_name,
                        lab_id: selectedOrder.lab_id || currentLabId
                      }}
                      testGroup={{
                        id: selectedOrder.testGroups[0].test_group_id,
                        name: selectedOrder.testGroups[0].test_group_name,
                        department: selectedOrder.testGroups[0].department
                      }}
                      onComplete={handleWorkflowComplete}
                    />
                  )}
                </div>
              </div>
        </div>
      );
    }

    if (entryViewMode === 'department') {
      return (
        <DepartmentView
          selectedDepartment={selectedDepartment}
          onDepartmentSelect={setSelectedDepartment}
          onOrderSelect={handleOrderSelect}
          entryMethod={entryMethod}
          onEntryMethodChange={(method: string) => setEntryMethod(method as EntryMethod)}
        />
      );
    }

    if (entryViewMode === 'test-group') {
      return (
        <div className="space-y-4">
          <div className="bg-white rounded-lg shadow-sm border p-4">
            <div className="flex flex-wrap gap-2">
              {availableTestGroups.map(tg => (
                <button
                  key={tg.id}
                  onClick={() => setSelectedTestGroupId(tg.id)}
                  className={`px-3 py-1.5 text-sm rounded-full border ${selectedTestGroupId===tg.id? 'bg-blue-600 text-white border-blue-600':'bg-white text-gray-700 hover:bg-gray-50'}`}
                >
                  {tg.name} <span className="text-xs text-gray-400 ml-1">{tg.department}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="bg-white rounded-lg shadow-sm border p-4">
            <h4 className="font-medium text-gray-900 mb-3">Orders</h4>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {results
                .filter((r: any) => !selectedTestGroupId || r.testGroups.some((tg: any) => tg.test_group_id === selectedTestGroupId))
                .map((r: any) => (
                  <button
                    key={r.id}
                    onClick={() => { setSelectedOrder(r as any); setEntryViewMode('order-based'); }}
                    className="text-left p-3 border rounded-lg hover:bg-gray-50 bg-white"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span
                          className="inline-block w-3 h-3 rounded-full border"
                          style={{ backgroundColor: r.color_code || '#e5e7eb' }}
                          title={r.color_name || 'Tube'}
                        />
                        <div className="font-medium text-gray-900">{r.patientName}</div>
                        {typeof r.age === 'number' && (
                          <div className="text-xs text-gray-500">• {r.age}y</div>
                        )}
                      </div>
                      <div className="text-xs text-gray-500">{r.sampleId || 'No Sample'}</div>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {(r.testGroups || []).filter((tg: any) => !selectedTestGroupId || tg.test_group_id === selectedTestGroupId).slice(0, 4).map((tg: any) => (
                        <span key={tg.test_group_id} className="px-2 py-0.5 text-xs rounded-full border bg-gray-50 text-gray-700">
                          {tg.test_group_name}
                        </span>
                      ))}
                    </div>
                  </button>
                ))}
              {results.length===0 && (
                <div className="col-span-full text-sm text-gray-500 p-6 text-center border rounded-md bg-white">No orders loaded. Use Refresh above.</div>
              )}
            </div>
          </div>
        </div>
      );
    }

    // Fallback for unknown view modes
    return (
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-12 text-center">
        <Activity className="h-16 w-16 text-gray-400 mx-auto mb-4" />
        <h3 className="text-lg font-medium text-gray-900 mb-2">{entryViewMode} View</h3>
        <p className="text-gray-600">
          This view mode is not yet implemented
        </p>
      </div>
    );
  };

  // Note: Filtered results logic would go here for advanced filtering
  // Currently using the main results array with basic filtering in components

  return (
    <div className="space-y-6">
      {/* Compact Filters */}
      <div className="bg-white rounded-lg border border-gray-200 p-3 flex flex-wrap items-center gap-2">
        <div className="text-sm font-medium text-gray-800 mr-2">Date Range:</div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">From:</span>
          <input
            type="date"
            value={filters.dateFrom || ''}
            onChange={(e) => handleFiltersChange({ dateFrom: e.target.value, dateRange: 'custom' }, true)}
            className="text-xs px-2 py-1 border rounded"
          />
          <span className="text-xs text-gray-500">To:</span>
          <input
            type="date"
            value={filters.dateTo || ''}
            onChange={(e) => handleFiltersChange({ dateTo: e.target.value, dateRange: 'custom' }, true)}
            className="text-xs px-2 py-1 border rounded"
          />
        </div>
        <div className="flex items-center gap-1 ml-2">
          <button
            className={`text-xs px-2 py-1 rounded border ${filters.dateRange==='today' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-700'}`}
            onClick={() => handleFiltersChange({ dateRange: 'today', dateFrom: '', dateTo: '' }, true)}
          >
            Today
          </button>
          <button
            className={`text-xs px-2 py-1 rounded border ${filters.dateRange==='7d' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-700'}`}
            onClick={() => handleFiltersChange({ dateRange: '7d', dateFrom: '', dateTo: '' }, true)}
          >
            7 days
          </button>
          <button
            className={`text-xs px-2 py-1 rounded border ${filters.dateRange==='30d' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-700'}`}
            onClick={() => handleFiltersChange({ dateRange: '30d', dateFrom: '', dateTo: '' }, true)}
          >
            30 days
          </button>
          <button
            className={`text-xs px-2 py-1 rounded border ${filters.dateRange==='90d' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-700'}`}
            onClick={() => handleFiltersChange({ dateRange: '90d', dateFrom: '', dateTo: '' }, true)}
          >
            90 days
          </button>
          <button
            className={`text-xs px-2 py-1 rounded border ${filters.dateRange==='all' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-700'}`}
            onClick={() => handleFiltersChange({ dateRange: 'all', dateFrom: '', dateTo: '' }, true)}
          >
            All Dates
          </button>
        </div>
        <div className="w-px h-4 bg-gray-200 mx-2" />
        <div className="flex items-center gap-1">
          <button
            className={`text-xs px-2 py-1 rounded border ${filters.status==='pending' ? 'bg-amber-500 text-white border-amber-500' : 'bg-white text-gray-700'}`}
            onClick={() => handleFiltersChange({ status: 'pending' }, true)}
          >
            Pending
          </button>
          <button
            className={`text-xs px-2 py-1 rounded border ${filters.status==='all' ? 'bg-gray-800 text-white border-gray-800' : 'bg-white text-gray-700'}`}
            onClick={() => handleFiltersChange({ status: 'all' }, true)}
          >
            All
          </button>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <input
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search patient…"
            className="text-xs px-2 py-1 border rounded"
          />
          <button 
            onClick={() => fetchResults()}
            disabled={loading}
            className="flex items-center px-3 py-1.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          >
            <RefreshCw className={`h-3 w-3 mr-1 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>
      {/* Real-time Notification */}
      {realTimeNotification && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-2 rounded-lg shadow-lg animate-in slide-in-from-top-2 ${
          realTimeNotification.type === 'success' ? 'bg-green-100 text-green-800 border border-green-200' :
          realTimeNotification.type === 'warning' ? 'bg-yellow-100 text-yellow-800 border border-yellow-200' :
          'bg-blue-100 text-blue-800 border border-blue-200'
        }`}>
          <div className="flex items-center space-x-2">
            <div className="w-2 h-2 bg-current rounded-full animate-pulse"></div>
            <span className="text-sm font-medium">{realTimeNotification.message}</span>
            <span className="text-xs opacity-75">
              {realTimeNotification.timestamp.toLocaleTimeString()}
            </span>
          </div>
        </div>
      )}

      {/* Enhanced View Selector */}
      <EnhancedViewSelector
        viewMode={viewMode}
        entryViewMode={entryViewMode}
        filters={filters}
        onViewModeChange={handleViewModeChange}
        onEntryViewModeChange={handleEntryViewModeChange}
        onFiltersChange={handleFiltersChange}
        departments={availableDepartments}
        resultCounts={resultCounts}
      />

      {/* Old Refresh moved into compact filters */}

      {/* Statistics Dashboard (collapsible) */}
      <div className="bg-white rounded-lg border border-gray-200">
        <div className="flex items-center justify-between px-4 py-3">
          <h3 className="text-base font-semibold text-gray-900">Result Statistics</h3>
          <button
            onClick={() => setShowStats((s) => !s)}
            className="text-sm px-3 py-1 rounded-md border hover:bg-gray-50"
            aria-expanded={showStats}
          >
            {showStats ? 'Hide' : 'Show'}
          </button>
        </div>
        {showStats && (
          <div className="p-4 pt-0">
            <ResultStatsDashboard
              stats={summaryStats}
              onCardClick={(cardType) => {
                console.log('Dashboard card clicked:', cardType);
              }}
            />
          </div>
        )}
      </div>

      {/* Dynamic Content Based on View Mode */}
      {viewMode === 'entry' ? renderEntryMode() : (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <div className="text-center py-12">
            <FileText className="h-16 w-16 text-gray-400 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-gray-900 mb-2">
              {viewMode === 'review' ? 'Review Mode' : 'Verification Mode'}
            </h3>
            <p className="text-gray-600">
              This functionality will be implemented in the next phase
            </p>
          </div>
        </div>
      )}

      {/* Loading Overlay */}
      {loading && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white p-6 rounded-lg shadow-lg">
            <div className="flex items-center space-x-3">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600"></div>
              <span>Loading...</span>
            </div>
          </div>
        </div>
      )}

      {/* Batch Operations Modal */}
      <BatchOperations
        selectedIds={Array.from(selectedForBatch)}
        totalCount={results.length}
        onSelectAll={handleSelectAllForBatch}
        onClearSelection={handleClearBatchSelection}
        onBatchOperation={handleBatchOperation}
        show={showBatchOperations}
        onClose={() => setShowBatchOperations(false)}
      />

      {/* Quick Action Toolbar disabled to avoid scroll issues */}
    </div>
  );
};

export default Results;