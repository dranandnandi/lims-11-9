// src/pages/result2.tsx
import React, { useEffect, useState } from "react";
import { Loader, Calendar, TestTube, Clock, AlertTriangle, CheckCircle, Activity } from "lucide-react";
import { supabase, database } from "../utils/supabase";
import OrderDetailsModal from "../components/Orders/OrderDetailsModal";
import SimpleWorkflowRunner from "../components/Workflow/SimpleWorkflowRunner";

interface TestGroupProgress {
  order_id: string;
  patient_id: string;
  patient_name: string;
  sample_id: string;
  order_status: string;
  priority: string;
  order_date: string;
  work_date: string;
  lab_id: string;
  order_test_id: string;
  test_group_id: string;
  test_group_name: string;
  department: string;
  tat_hours: number;
  total_analytes: number;
  completed_analytes: number;
  panel_status: 'not_started' | 'in_progress' | 'completed';
  completion_percentage: number;
  workflow_eligible: boolean;
  entered_count: number;
  under_review_count: number;
  approved_count: number;
  reported_count: number;
  critical_count: number;
  abnormal_count: number;
  last_activity: string;
  hours_since_order: number;
  hours_until_tat_breach: number;
}

interface DateGroup {
  date: string;
  dateObj: Date;
  testGroups: TestGroupProgress[];
  isToday: boolean;
  isPast: boolean;
}

const Result2: React.FC = () => {
  const [testGroups, setTestGroups] = useState<TestGroupProgress[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedRange, setSelectedRange] = useState<'today' | 'yesterday' | 'last7' | 'all'>('today');
  const [selectedTestGroup, setSelectedTestGroup] = useState<TestGroupProgress | null>(null);
  const [showWorkflowPanel, setShowWorkflowPanel] = useState(false);
  
  // Add state for OrderDetailsModal
  const [selectedOrder, setSelectedOrder] = useState<any>(null);
  const [showOrderModal, setShowOrderModal] = useState(false);
  
  // Add state for workflow execution
  const [selectedWorkflow, setSelectedWorkflow] = useState<any>(null);

  useEffect(() => {
    fetchTestGroupProgress();
  }, [selectedRange]);

  const fetchTestGroupProgress = async () => {
    try {
      setLoading(true);
      
      // Get current user's lab ID for filtering
      const currentLabId = await database.getCurrentUserLabId();
      if (!currentLabId) {
        console.error('No lab ID found for current user');
        setTestGroups([]);
        return;
      }
      
      console.log('Current user lab ID:', currentLabId);
      
      const { data, error } = await supabase
        .from('v_order_test_progress_enhanced')
        .select('*')
        .eq('lab_id', currentLabId) // Filter by current user's lab
        .order('work_date', { ascending: false })
        .order('test_group_name', { ascending: true });

      if (error) {
        console.error('Error fetching from v_order_test_progress_enhanced:', error);
        throw error;
      }

      console.log('Raw data from v_order_test_progress_enhanced:', data);

      // Filter by date range
      const filtered = filterByDateRange(data || []);
      console.log('Filtered data:', filtered);
      setTestGroups(filtered);
    } catch (error) {
      console.error('Error fetching test group progress:', error);
      // Try fallback to basic orders query with lab filtering
      try {
        console.log('Trying fallback query...');
        const currentLabId = await database.getCurrentUserLabId();
        if (!currentLabId) {
          console.error('No lab ID found for current user in fallback');
          setTestGroups([]);
          return;
        }
        
        const { data: fallbackData, error: fallbackError } = await supabase
          .from('orders')
          .select(`
            id as order_id,
            patient_id,
            patient_name,
            sample_id,
            status as order_status,
            order_date,
            order_date as work_date,
            lab_id
          `)
          .eq('lab_id', currentLabId) // Filter by current user's lab
          .in('status', ['In Progress', 'Pending Approval'])
          .order('order_date', { ascending: false });

        if (fallbackError) throw fallbackError;

        console.log('Fallback data:', fallbackData);
        // Transform fallback data to match interface
        const transformed = (fallbackData || []).map((order: any) => ({
          order_id: order.order_id,
          patient_id: order.patient_id,
          patient_name: order.patient_name,
          sample_id: order.sample_id,
          order_status: order.order_status,
          priority: 'normal',
          order_date: order.order_date,
          work_date: order.work_date,
          lab_id: order.lab_id,
          order_test_id: '',
          test_group_id: 'unknown',
          test_group_name: 'Unknown Test Group',
          department: 'Unknown',
          tat_hours: 0,
          total_analytes: 0,
          completed_analytes: 0,
          panel_status: 'not_started' as const,
          completion_percentage: 0,
          workflow_eligible: false,
          entered_count: 0,
          under_review_count: 0,
          approved_count: 0,
          reported_count: 0,
          critical_count: 0,
          abnormal_count: 0,
          last_activity: order.order_date,
          hours_since_order: 0,
          hours_until_tat_breach: 0
        }));

        setTestGroups(transformed);
      } catch (fallbackError) {
        console.error('Fallback query also failed:', fallbackError);
      }
    } finally {
      setLoading(false);
    }
  };

  const filterByDateRange = (data: TestGroupProgress[]): TestGroupProgress[] => {
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    return data.filter(item => {
      const itemDate = item.work_date.split('T')[0];
      switch (selectedRange) {
        case 'today':
          return itemDate === todayStr;
        case 'yesterday':
          return itemDate === yesterdayStr;
        case 'last7':
          const sevenDaysAgo = new Date(today);
          sevenDaysAgo.setDate(today.getDate() - 7);
          return new Date(itemDate) >= sevenDaysAgo;
        case 'all':
        default:
          return true;
      }
    });
  };

  const groupByDate = (): DateGroup[] => {
    const groups: { [key: string]: TestGroupProgress[] } = {};

    testGroups.forEach(tg => {
      const dateKey = tg.work_date.split('T')[0];
      if (!groups[dateKey]) {
        groups[dateKey] = [];
      }
      groups[dateKey].push(tg);
    });

    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];

    return Object.entries(groups)
      .map(([date, testGroups]) => ({
        date,
        dateObj: new Date(date),
        testGroups,
        isToday: date === todayStr,
        isPast: date < todayStr
      }))
      .sort((a, b) => b.date.localeCompare(a.date));
  };

  const getStatusColor = (panelStatus: string, orderStatus: string) => {
    // Priority: panel_status takes precedence, then order_status
    if (panelStatus === 'completed') {
      return {
        bg: 'bg-green-100',
        border: 'border-green-300',
        text: 'text-green-800',
        icon: CheckCircle,
        label: 'Completed'
      };
    } else if (panelStatus === 'in_progress') {
      return {
        bg: 'bg-blue-100',
        border: 'border-blue-300',
        text: 'text-blue-800',
        icon: Activity,
        label: 'In Progress'
      };
    } else if (orderStatus === 'Sample Collection') {
      return {
        bg: 'bg-orange-100',
        border: 'border-orange-300',
        text: 'text-orange-800',
        icon: Clock,
        label: 'Sample Pending'
      };
    } else if (orderStatus === 'Pending Approval') {
      return {
        bg: 'bg-yellow-100',
        border: 'border-yellow-300',
        text: 'text-yellow-800',
        icon: AlertTriangle,
        label: 'Pending Approval'
      };
    } else {
      return {
        bg: 'bg-gray-100',
        border: 'border-gray-300',
        text: 'text-gray-800',
        icon: TestTube,
        label: 'Not Started'
      };
    }
  };

  const handleTestGroupClick = async (testGroup: TestGroupProgress) => {
    try {
      setLoading(true);
      
      // Fetch complete order details - simplified query without problematic patient columns
      const { data: orderData, error: orderError } = await supabase
        .from('orders')
        .select(`
          *,
          patients!inner(
            id,
            name
          )
        `)
        .eq('id', testGroup.order_id)
        .single();

      if (orderError) {
        console.error('Error fetching order:', orderError);
        alert('Failed to load order details');
        return;
      }

      // Transform to match OrderDetailsModal expected format
      const order = {
        id: orderData.id,
        patient_name: orderData.patient_name || orderData.patients?.name || 'Unknown Patient',
        patient_id: orderData.patient_id,
        tests: [testGroup.test_group_name], // Use test group name as test
        status: orderData.status,
        priority: orderData.priority || 'Normal',
        order_date: orderData.order_date || orderData.created_at,
        expected_date: orderData.expected_date || orderData.created_at,
        total_amount: orderData.total_amount || 0,
        doctor: orderData.doctor || null,
        sample_id: orderData.sample_id,
        color_code: orderData.color_code,
        color_name: orderData.color_name,
        qr_code_data: orderData.qr_code_data,
        sample_collected_at: orderData.sample_collected_at,
        sample_collected_by: orderData.sample_collected_by
      };

      setSelectedOrder(order);
      setShowOrderModal(true);
    } catch (error) {
      console.error('Error loading order details:', error);
      alert('Failed to access order details');
    } finally {
      setLoading(false);
    }
  };

  // Check workflow availability from test_workflow_map
  const checkWorkflowAvailability = async (testGroup: TestGroupProgress) => {
    try {
      const { data, error } = await supabase
        .from('test_workflow_map')
        .select(`
          id,
          workflow_version_id,
          workflow_versions!inner(
            id,
            version,
            definition,
            description
          )
        `)
        .eq('lab_id', testGroup.lab_id)
        .eq('test_group_id', testGroup.test_group_id)
        .eq('is_default', true)
        .single();

      if (error) {
        console.error('Error checking workflow availability:', error);
        return null;
      }

      return data;
    } catch (error) {
      console.error('Error in checkWorkflowAvailability:', error);
      return null;
    }
  };

  const handleWorkflowExecute = async (testGroup: TestGroupProgress) => {
    try {
      setLoading(true);
      
      // First fetch the full order details to get patient info
      const { data: orderData, error: orderError } = await supabase
        .from('orders')
        .select(`
          id,
          patient_id,
          patient_name,
          sample_id,
          lab_id
        `)
        .eq('id', testGroup.order_id)
        .single();

      if (orderError) {
        console.error('Error fetching order for workflow:', orderError);
        alert('Failed to load order details for workflow');
        return;
      }

      const workflow = await checkWorkflowAvailability(testGroup);
      
      if (workflow) {
        // Store both workflow and complete test group + order info
        setSelectedWorkflow({
          ...workflow,
          orderData: orderData, // Add order data to workflow context
        });
        setSelectedTestGroup(testGroup);
        setShowWorkflowPanel(true);
      } else {
        alert('No workflow available for this test group');
      }
    } catch (error) {
      console.error('Error executing workflow:', error);
      alert('Failed to start workflow');
    } finally {
      setLoading(false);
    }
  };

  // Handle workflow completion
  const handleWorkflowComplete = (results: any) => {
    console.log('Workflow completed with results:', results);
    alert('Workflow completed successfully!');
    setShowWorkflowPanel(false);
    setSelectedWorkflow(null);
    setSelectedTestGroup(null);
    fetchTestGroupProgress(); // Refresh data
  };

  const handleUpdateOrderStatus = async (orderId: string, newStatus: string) => {
    // Refresh test groups after status update
    await fetchTestGroupProgress();
  };

  const handleSubmitResults = async (orderId: string, resultsData: any[]) => {
    // Refresh test groups after results submission
    await fetchTestGroupProgress();
    setShowOrderModal(false);
  };

  const formatDateHeader = (dateGroup: DateGroup) => {
    const { dateObj, isToday, isPast } = dateGroup;
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    if (isToday) {
      return `📅 Today - ${dateObj.toLocaleDateString('en-IN', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric'
      })}`;
    } else if (dateObj.toDateString() === yesterday.toDateString()) {
      return `📅 Yesterday - ${dateObj.toLocaleDateString('en-IN', {
        weekday: 'long',
        day: 'numeric',
        month: 'long'
      })}`;
    } else if (isPast) {
      const diffTime = today.getTime() - dateObj.getTime();
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

      return `📅 ${dateObj.toLocaleDateString('en-IN', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric'
      })} (${diffDays} days ago)`;
    } else {
      return `📅 ${dateObj.toLocaleDateString('en-IN', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric'
      })} (Future)`;
    }
  };

  const dateGroups = groupByDate();

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-7xl mx-auto">
        <div className="mb-6">
          <h1 className="text-3xl font-bold text-gray-900">Results Entry Dashboard</h1>
          <p className="text-gray-600 mt-2">Test group wise result entry with workflow integration</p>
        </div>

        {/* Date Range Filter */}
        <div className="mb-6">
          <div className="flex bg-gray-100 rounded-lg overflow-hidden text-sm font-medium">
            {([
              { key: 'today', label: 'Today' },
              { key: 'yesterday', label: 'Yesterday' },
              { key: 'last7', label: 'Last 7 Days' },
              { key: 'all', label: 'All' }
            ] as const).map(option => (
              <button
                key={option.key}
                onClick={() => setSelectedRange(option.key)}
                className={`px-4 py-2 transition-colors ${
                  selectedRange === option.key
                    ? 'bg-blue-600 text-white'
                    : 'text-gray-600 hover:bg-gray-200'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {/* Workflow Panel Modal */}
        {showWorkflowPanel && selectedWorkflow && selectedTestGroup && (
          <div className="fixed inset-0 bg-gray-600 bg-opacity-75 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl max-h-[90vh] overflow-hidden">
              <div className="flex items-center justify-between p-6 border-b border-gray-200">
                <h3 className="text-lg font-semibold">
                  Workflow: {selectedWorkflow.workflow_versions?.workflows?.description || selectedTestGroup.test_group_name}
                </h3>
                <button
                  onClick={() => {
                    setShowWorkflowPanel(false);
                    setSelectedWorkflow(null);
                    setSelectedTestGroup(null);
                  }}
                  className="text-gray-400 hover:text-gray-600"
                >
                  ✕
                </button>
              </div>
              <div className="p-6 overflow-y-auto max-h-[calc(90vh-120px)]">
                <SimpleWorkflowRunner
                  workflowDefinition={selectedWorkflow.workflow_versions.definition}
                  orderId={selectedTestGroup.order_id}
                  testGroupId={selectedTestGroup.test_group_id}
                  onComplete={handleWorkflowComplete}
                />
              </div>
            </div>
          </div>
        )}

        {/* Test Groups by Date */}
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader className="animate-spin h-8 w-8 text-blue-500 mr-3" />
            <span className="text-gray-600">Loading test groups...</span>
          </div>
        ) : (
          <div className="space-y-8">
            {dateGroups.map(dateGroup => (
              <div key={dateGroup.date}>
                {/* Date Header */}
                <div className={`sticky top-0 z-10 bg-white border-b-2 pb-3 mb-4 ${
                  dateGroup.isToday ? 'border-green-500' : 'border-gray-200'
                }`}>
                  <h2 className="text-xl font-semibold text-gray-900">
                    {formatDateHeader(dateGroup)}
                  </h2>
                  <p className="text-sm text-gray-600 mt-1">
                    {dateGroup.testGroups.length} test group{dateGroup.testGroups.length !== 1 ? 's' : ''} to process
                  </p>
                </div>

                {/* Test Group Cards */}
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                  {dateGroup.testGroups.map(testGroup => {
                    const statusConfig = getStatusColor(testGroup.panel_status, testGroup.order_status);
                    const StatusIcon = statusConfig.icon;

                    return (
                      <div
                        key={`${testGroup.order_id}-${testGroup.test_group_id}`}
                        className={`border-2 rounded-lg p-4 cursor-pointer transition-all hover:shadow-lg ${statusConfig.border} ${statusConfig.bg}`}
                        onClick={() => handleTestGroupClick(testGroup)}
                      >
                        {/* Header */}
                        <div className="flex items-start justify-between mb-3">
                          <div className="flex-1">
                            <h3 className="font-semibold text-gray-900 text-sm">
                              {testGroup.test_group_name}
                            </h3>
                            <p className="text-xs text-gray-600 mt-1">
                              {testGroup.patient_name}
                            </p>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className={`px-2 py-1 rounded-full text-xs font-medium ${statusConfig.bg} ${statusConfig.text}`}>
                              <StatusIcon className="h-3 w-3 inline mr-1" />
                              {statusConfig.label}
                            </span>
                          </div>
                        </div>

                        {/* Progress Bar */}
                        <div className="mb-3">
                          <div className="flex justify-between text-xs text-gray-600 mb-1">
                            <span>Progress</span>
                            <span>{testGroup.completion_percentage}%</span>
                          </div>
                          <div className="w-full bg-gray-200 rounded-full h-2">
                            <div
                              className={`h-2 rounded-full transition-all duration-300 ${
                                testGroup.panel_status === 'completed' ? 'bg-green-600' :
                                testGroup.panel_status === 'in_progress' ? 'bg-blue-600' :
                                'bg-gray-400'
                              }`}
                              style={{ width: `${testGroup.completion_percentage}%` }}
                            />
                          </div>
                        </div>

                        {/* Details */}
                        <div className="space-y-1 text-xs text-gray-600">
                          <div className="flex justify-between">
                            <span>Sample:</span>
                            <span className="font-medium">{testGroup.sample_id || 'N/A'}</span>
                          </div>
                          <div className="flex justify-between">
                            <span>Analytes:</span>
                            <span>{testGroup.completed_analytes}/{testGroup.total_analytes}</span>
                          </div>
                          <div className="flex justify-between">
                            <span>Department:</span>
                            <span>{testGroup.department || 'N/A'}</span>
                          </div>
                          {testGroup.abnormal_count > 0 && (
                            <div className="flex justify-between text-red-600">
                              <span>Abnormal:</span>
                              <span>{testGroup.abnormal_count}</span>
                            </div>
                          )}
                        </div>

                        {/* TAT Warning */}
                        {testGroup.hours_until_tat_breach !== null && testGroup.hours_until_tat_breach < 24 && (
                          <div className="mt-3 p-2 bg-red-50 border border-red-200 rounded text-xs text-red-700">
                            <AlertTriangle className="h-3 w-3 inline mr-1" />
                            TAT breach in {Math.round(testGroup.hours_until_tat_breach)} hours
                          </div>
                        )}

                        {/* Workflow Button */}
                        {testGroup.workflow_eligible && testGroup.panel_status === 'not_started' && (
                          <div className="mt-3 pt-3 border-t border-gray-200">
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleWorkflowExecute(testGroup);
                              }}
                              className="w-full px-3 py-2 bg-purple-600 text-white text-xs rounded hover:bg-purple-700 transition-colors"
                            >
                              Execute Workflow
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}

            {/* Empty State */}
            {dateGroups.length === 0 && (
              <div className="bg-white border-2 border-dashed border-gray-300 rounded-lg p-12 text-center">
                <TestTube className="h-16 w-16 text-gray-400 mx-auto mb-4" />
                <h3 className="text-lg font-medium text-gray-900 mb-2">No Test Groups Found</h3>
                <p className="text-gray-600">
                  {selectedRange === 'today'
                    ? "No test groups require results entry today."
                    : `No test groups found for the selected date range.`
                  }
                </p>
              </div>
            )}
          </div>
        )}

        {/* Workflow Execution Panel */}
        {showWorkflowPanel && selectedWorkflow && selectedTestGroup && (
          <div className="fixed inset-0 bg-gray-600 bg-opacity-75 flex items-center justify-center z-50 p-2 sm:p-4">
            <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl h-full sm:h-auto sm:max-h-[90vh] overflow-hidden">
              <div className="flex items-center justify-between p-4 sm:p-6 border-b border-gray-200">
                <h3 className="text-base sm:text-lg font-semibold truncate pr-2">
                  Execute Workflow: {selectedTestGroup.test_group_name}
                </h3>
                <button
                  onClick={() => {
                    setShowWorkflowPanel(false);
                    setSelectedWorkflow(null);
                    setSelectedTestGroup(null);
                  }}
                  className="text-gray-400 hover:text-gray-600 flex-shrink-0 p-1 sm:p-0"
                >
                  <svg className="w-5 h-5 sm:w-6 sm:h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <div className="p-4 sm:p-6 overflow-y-auto h-full sm:h-auto sm:max-h-[calc(90vh-120px)]">
                <SimpleWorkflowRunner
                  workflowDefinition={selectedWorkflow.workflow_versions.definition}
                  orderId={selectedTestGroup.order_id}
                  testGroupId={selectedTestGroup.test_group_id}
                  // Pass additional context from order data
                  patientId={selectedWorkflow.orderData?.patient_id}
                  patientName={selectedWorkflow.orderData?.patient_name}
                  testName={selectedTestGroup.test_group_name}
                  sampleId={selectedWorkflow.orderData?.sample_id}
                  labId={selectedTestGroup.lab_id}
                  onComplete={handleWorkflowComplete}
                />
              </div>
            </div>
          </div>
        )}

        {/* Add OrderDetailsModal */}
        {showOrderModal && selectedOrder && (
          <OrderDetailsModal
            order={selectedOrder}
            onClose={() => {
              setShowOrderModal(false);
              setSelectedOrder(null);
              fetchTestGroupProgress(); // Refresh data when modal closes
            }}
            onUpdateStatus={handleUpdateOrderStatus}
            onSubmitResults={handleSubmitResults}
          />
        )}
      </div>
    </div>
  );
};

export default Result2;