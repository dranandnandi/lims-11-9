import React, { useState, useEffect } from 'react';
import { Search, Clock, Activity, ChevronRight } from 'lucide-react';
import { database, supabase } from '../../../utils/supabase';
import { useAuth } from '../../../contexts/AuthContext';

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
  patient_id?: string;
  patient_name: string;
  sample_id: string;
  priority: string;
  status: string;
  created_at: string;
  lab_id?: string;
  testGroups: OrderTestProgress[];
  totalTests: number;
  completedTests: number;
  percentComplete: number;
}

interface OrderSelectorProps {
  selectedOrder: OrderWithProgress | null;
  onOrderSelect: (order: OrderWithProgress) => void;
  searchTerm: string;
  onSearchChange: (term: string) => void;
}

const OrderSelector: React.FC<OrderSelectorProps> = ({
  selectedOrder,
  onOrderSelect,
  searchTerm,
  onSearchChange
}) => {
  useAuth();
  const [orders, setOrders] = useState<OrderWithProgress[]>([]);
  const [loading, setLoading] = useState(false);
  const [filterStatus, setFilterStatus] = useState<'all' | 'pending' | 'in-progress'>('pending');

  // Fetch orders with test progress from the enhanced view
  const fetchOrdersWithProgress = async () => {
    const labId = await database.getCurrentUserLabId();
    if (!labId) return;

    setLoading(true);
    try {
      // Fetch from the enhanced view we created
      const { data: progressData, error } = await supabase
        .from('v_order_test_progress_enhanced')
        .select('*')
        .eq('lab_id', labId)
        .order('priority', { ascending: false })
        .order('created_at', { ascending: false });

      if (error) {
        console.error('Error fetching order progress:', error);
        return;
      }

      // Group progress data by order_id
      const orderMap = new Map<string, OrderWithProgress>();
      
      progressData?.forEach((progress) => {
        const orderId = progress.order_id;
        
        if (!orderMap.has(orderId)) {
          orderMap.set(orderId, {
            id: orderId,
            patient_id: progress.patient_id,
            patient_name: progress.patient_name,
            sample_id: progress.sample_id,
            priority: progress.priority,
            status: progress.order_status,
            created_at: progress.created_at,
            lab_id: progress.lab_id,
            testGroups: [],
            totalTests: 0,
            completedTests: 0,
            percentComplete: 0
          });
        }

        const order = orderMap.get(orderId)!;
        order.testGroups.push({
          order_id: progress.order_id,
          patient_id: progress.patient_id,
          patient_name: progress.patient_name,
          sample_id: progress.sample_id,
          order_status: progress.order_status,
          priority: progress.priority,
          test_group_id: progress.test_group_id,
          test_group_name: progress.test_group_name,
          department: progress.department,
          total_analytes: progress.total_analytes,
          completed_analytes: progress.completed_analytes,
          panel_status: progress.panel_status,
          completion_percentage: progress.completion_percentage,
          workflow_eligible: progress.workflow_eligible,
          last_activity: progress.last_activity,
          hours_since_order: progress.hours_since_order
        });

        // Update totals
        order.totalTests += progress.total_analytes;
        order.completedTests += progress.completed_analytes;
      });

      // Calculate overall percentage for each order
      const ordersArray = Array.from(orderMap.values()).map(order => ({
        ...order,
        percentComplete: order.totalTests > 0 ? Math.round((order.completedTests / order.totalTests) * 100) : 0
      }));

      setOrders(ordersArray);
    } catch (error) {
      console.error('Failed to fetch orders:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchOrdersWithProgress();
  }, []);

  // Filter orders based on search term and status
  const filteredOrders = orders.filter(order => {
    const matchesSearch = !searchTerm || 
      order.patient_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      order.sample_id?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      order.id.toLowerCase().includes(searchTerm.toLowerCase());

    const matchesStatus = filterStatus === 'all' ||
      (filterStatus === 'pending' && order.percentComplete === 0) ||
      (filterStatus === 'in-progress' && order.percentComplete > 0 && order.percentComplete < 100);

    return matchesSearch && matchesStatus;
  });

  const getPriorityColor = (priority: string) => {
    switch (priority) {
      case 'STAT': return 'bg-red-100 text-red-700 border-red-200';
      case 'Urgent': return 'bg-orange-100 text-orange-700 border-orange-200';
      default: return 'bg-gray-100 text-gray-700 border-gray-200';
    }
  };

  const getStatusColor = (percentComplete: number) => {
    if (percentComplete === 0) return 'text-gray-500';
    if (percentComplete < 100) return 'text-blue-600';
    return 'text-green-600';
  };

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold text-gray-900">Orders Pending Results</h3>
        <button
          onClick={fetchOrdersWithProgress}
          className="text-sm text-blue-600 hover:text-blue-700"
        >
          Refresh
        </button>
      </div>

      {/* Search Bar */}
      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
        <input
          type="text"
          placeholder="Search by patient, order ID, or sample ID..."
          value={searchTerm}
          onChange={(e) => onSearchChange(e.target.value)}
          className="pl-10 pr-4 py-2 w-full border rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        />
      </div>

      {/* Status Filter */}
      <div className="flex space-x-2 mb-4">
        <button
          onClick={() => setFilterStatus('all')}
          className={`px-3 py-1 text-sm rounded-md ${
            filterStatus === 'all'
              ? 'bg-blue-100 text-blue-700'
              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
        >
          All
        </button>
        <button
          onClick={() => setFilterStatus('pending')}
          className={`px-3 py-1 text-sm rounded-md ${
            filterStatus === 'pending'
              ? 'bg-blue-100 text-blue-700'
              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
        >
          Pending
        </button>
        <button
          onClick={() => setFilterStatus('in-progress')}
          className={`px-3 py-1 text-sm rounded-md ${
            filterStatus === 'in-progress'
              ? 'bg-blue-100 text-blue-700'
              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
        >
          In Progress
        </button>
      </div>

      {/* Order List */}
      <div className="space-y-3 max-h-96 overflow-y-auto">
        {loading ? (
          <div className="text-center py-4">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600 mx-auto"></div>
          </div>
        ) : filteredOrders.length === 0 ? (
          <div className="text-center py-4 text-gray-500">
            {searchTerm ? 'No orders found matching your search' : 'No orders available for result entry'}
          </div>
        ) : (
          filteredOrders.map((order) => (
            <div
              key={order.id}
              onClick={() => onOrderSelect(order)}
              className={`p-4 border rounded-lg cursor-pointer transition-all ${
                selectedOrder?.id === order.id
                  ? 'border-blue-500 bg-blue-50'
                  : 'border-gray-200 hover:border-gray-300 hover:shadow-sm'
              }`}
            >
              <div className="flex justify-between items-start mb-2">
                <div>
                  <div className="font-medium text-gray-900">
                    Order #{order.id.slice(0, 8)}
                  </div>
                  <div className="text-sm text-gray-600">
                    {order.patient_name}
                  </div>
                  {order.sample_id && (
                    <div className="text-xs text-gray-500">
                      Sample: {order.sample_id}
                    </div>
                  )}
                </div>
                <div className="flex items-center space-x-2">
                  <span className={`text-xs px-2 py-1 rounded-full border ${getPriorityColor(order.priority)}`}>
                    {order.priority}
                  </span>
                  <ChevronRight className="h-4 w-4 text-gray-400" />
                </div>
              </div>

              {/* Progress Bar */}
              <div className="mt-3">
                <div className="flex justify-between text-xs text-gray-600 mb-1">
                  <span>{order.completedTests}/{order.totalTests} tests</span>
                  <span className={getStatusColor(order.percentComplete)}>
                    {order.percentComplete}%
                  </span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-2">
                  <div
                    className={`h-2 rounded-full transition-all ${
                      order.percentComplete === 100 ? 'bg-green-500' : 'bg-blue-500'
                    }`}
                    style={{ width: `${order.percentComplete}%` }}
                  />
                </div>
              </div>

              {/* Test Groups Summary */}
              <div className="mt-2 flex flex-wrap gap-1">
                {order.testGroups.slice(0, 3).map((tg) => (
                  <span
                    key={tg.test_group_id}
                    className={`text-xs px-2 py-0.5 rounded ${
                      tg.panel_status === 'completed' 
                        ? 'bg-green-100 text-green-700'
                        : tg.panel_status === 'in_progress'
                        ? 'bg-blue-100 text-blue-700'
                        : 'bg-gray-100 text-gray-700'
                    }`}
                  >
                    {tg.test_group_name}
                  </span>
                ))}
                {order.testGroups.length > 3 && (
                  <span className="text-xs px-2 py-0.5 bg-gray-100 text-gray-700 rounded">
                    +{order.testGroups.length - 3} more
                  </span>
                )}
              </div>

              {/* Workflow indicators */}
              <div className="mt-2 flex items-center space-x-2 text-xs">
                {order.testGroups.some(tg => tg.workflow_eligible) && (
                  <span className="flex items-center text-purple-600">
                    <Activity className="h-3 w-3 mr-1" />
                    Workflow Ready
                  </span>
                )}
                <span className="flex items-center text-gray-500">
                  <Clock className="h-3 w-3 mr-1" />
                  {Math.round(order.testGroups[0]?.hours_since_order || 0)}h ago
                </span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default OrderSelector;