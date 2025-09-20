import React, { useState, useEffect } from 'react';
import { 
  TestTube, 
  Activity, 
  Clock, 
  CheckCircle, 
  AlertTriangle, 
  Users, 
  TrendingUp, 
  Filter,
  Search,
  ChevronDown,
  ChevronRight,
  Brain
} from 'lucide-react';
import { database, supabase } from '../../../utils/supabase';
import { useAuth } from '../../../contexts/AuthContext';

interface DepartmentStats {
  department: string;
  total_orders: number;
  pending_orders: number;
  in_progress_orders: number;
  completed_orders: number;
  urgent_orders: number;
  workflow_eligible_orders: number;
  avg_completion_percentage: number;
}

interface DepartmentOrder {
  order_id: string;
  patient_name: string;
  sample_id: string;
  status: string;
  priority: string;
  created_at: string;
  test_groups: {
    id: string;
    name: string;
    panel_status: string;
    completed_analytes: number;
    total_analytes: number;
    workflow_eligible: boolean;
  }[];
  completion_percentage: number;
}

interface DepartmentViewProps {
  selectedDepartment: string | null;
  onDepartmentSelect: (department: string | null) => void;
  onOrderSelect: (order: any) => void;
  entryMethod: string;
  onEntryMethodChange: (method: string) => void;
}

const DepartmentView: React.FC<DepartmentViewProps> = ({
  selectedDepartment,
  onDepartmentSelect,
  onOrderSelect,
  entryMethod,
  onEntryMethodChange
}) => {
  const { user } = useAuth();
  const [departments, setDepartments] = useState<DepartmentStats[]>([]);
  const [departmentOrders, setDepartmentOrders] = useState<DepartmentOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [expandedOrders, setExpandedOrders] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetchDepartmentStats();
  }, [user]);

  useEffect(() => {
    if (selectedDepartment) {
      fetchDepartmentOrders(selectedDepartment);
    }
  }, [selectedDepartment, statusFilter]);

  const fetchDepartmentStats = async () => {
    try {
      setLoading(true);
      
      const userLabId = await database.getCurrentUserLabId();
      if (!userLabId) return;
      
      // Query the enhanced view to get department statistics
      const { data, error } = await supabase
        .from('v_order_test_progress_enhanced')
        .select(`
          department,
          order_id,
          order_status,
          priority,
          workflow_eligible,
          completion_percentage
        `)
        .eq('lab_id', userLabId);

      if (error) throw error;

      // Group by department and calculate stats
      const departmentMap = new Map<string, {
        orders: Set<string>;
        pending: Set<string>;
        inProgress: Set<string>;
        completed: Set<string>;
        urgent: Set<string>;
        workflowEligible: Set<string>;
        completionPercentages: number[];
      }>();

      data?.forEach(row => {
        if (!departmentMap.has(row.department)) {
          departmentMap.set(row.department, {
            orders: new Set(),
            pending: new Set(),
            inProgress: new Set(),
            completed: new Set(),
            urgent: new Set(),
            workflowEligible: new Set(),
            completionPercentages: []
          });
        }

        const dept = departmentMap.get(row.department)!;
        dept.orders.add(row.order_id);
        dept.completionPercentages.push(row.completion_percentage);

        if (row.order_status === 'pending') dept.pending.add(row.order_id);
        else if (row.order_status === 'in_progress') dept.inProgress.add(row.order_id);
        else if (row.order_status === 'completed') dept.completed.add(row.order_id);

        if (row.priority === 'STAT' || row.priority === 'URGENT') {
          dept.urgent.add(row.order_id);
        }

        if (row.workflow_eligible) {
          dept.workflowEligible.add(row.order_id);
        }
      });

      const departmentStats = Array.from(departmentMap.entries()).map(([department, stats]) => ({
        department,
        total_orders: stats.orders.size,
        pending_orders: stats.pending.size,
        in_progress_orders: stats.inProgress.size,
        completed_orders: stats.completed.size,
        urgent_orders: stats.urgent.size,
        workflow_eligible_orders: stats.workflowEligible.size,
        avg_completion_percentage: Math.round(
          stats.completionPercentages.reduce((sum, pct) => sum + pct, 0) / stats.completionPercentages.length
        )
      }));

      setDepartments(departmentStats.sort((a, b) => b.total_orders - a.total_orders));
    } catch (error) {
      console.error('Error fetching department stats:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchDepartmentOrders = async (department: string) => {
    try {
      const userLabId = await database.getCurrentUserLabId();
      if (!userLabId) return;

      const { data, error } = await supabase
        .from('v_order_test_progress_enhanced')
        .select(`
          order_id,
          patient_name,
          sample_id,
          order_status,
          priority,
          created_at,
          test_group_id,
          test_group_name,
          panel_status,
          completed_analytes,
          total_analytes,
          workflow_eligible,
          completion_percentage
        `)
        .eq('department', department)
        .eq('lab_id', userLabId)
        .order('created_at', { ascending: false });

      if (error) throw error;

      // Group by order and aggregate test groups
      const orderMap = new Map<string, any>();
      
      data?.forEach(row => {
        if (!orderMap.has(row.order_id)) {
          orderMap.set(row.order_id, {
            order_id: row.order_id,
            patient_name: row.patient_name,
            sample_id: row.sample_id,
            status: row.order_status,
            priority: row.priority,
            created_at: row.created_at,
            completion_percentage: row.completion_percentage,
            test_groups: []
          });
        }

        const order = orderMap.get(row.order_id)!;
        order.test_groups.push({
          id: row.test_group_id,
          name: row.test_group_name,
          panel_status: row.panel_status,
          completed_analytes: row.completed_analytes,
          total_analytes: row.total_analytes,
          workflow_eligible: row.workflow_eligible
        });
      });

      let orders = Array.from(orderMap.values());

      // Apply filters
      if (statusFilter !== 'all') {
        orders = orders.filter(order => order.status === statusFilter);
      }

      if (searchTerm) {
        orders = orders.filter(order => 
          order.patient_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
          order.sample_id.toLowerCase().includes(searchTerm.toLowerCase()) ||
          order.order_id.toLowerCase().includes(searchTerm.toLowerCase())
        );
      }

      setDepartmentOrders(orders);
    } catch (error) {
      console.error('Error fetching department orders:', error);
    }
  };

  const toggleOrderExpansion = (orderId: string) => {
    const newExpanded = new Set(expandedOrders);
    if (newExpanded.has(orderId)) {
      newExpanded.delete(orderId);
    } else {
      newExpanded.add(orderId);
    }
    setExpandedOrders(newExpanded);
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'pending': return 'bg-yellow-100 text-yellow-800 border-yellow-200';
      case 'in_progress': return 'bg-blue-100 text-blue-800 border-blue-200';
      case 'completed': return 'bg-green-100 text-green-800 border-green-200';
      default: return 'bg-gray-100 text-gray-800 border-gray-200';
    }
  };

  const getPriorityColor = (priority: string) => {
    switch (priority?.toUpperCase()) {
      case 'STAT':
      case 'URGENT': return 'text-red-600 bg-red-50 border-red-200';
      case 'HIGH': return 'text-orange-600 bg-orange-50 border-orange-200';
      default: return 'text-gray-600 bg-gray-50 border-gray-200';
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-12 gap-6">
      {/* Department List */}
      <div className="col-span-4">
        <div className="bg-white rounded-lg shadow-sm border border-gray-200">
          <div className="p-4 border-b border-gray-200">
            <h3 className="font-semibold text-gray-900">Departments</h3>
            <p className="text-sm text-gray-600">Select a department to view orders</p>
          </div>
          
          <div className="divide-y divide-gray-200">
            {departments.map((dept) => (
              <button
                key={dept.department}
                onClick={() => onDepartmentSelect(
                  selectedDepartment === dept.department ? null : dept.department
                )}
                className={`w-full p-4 text-left hover:bg-gray-50 transition-colors ${
                  selectedDepartment === dept.department ? 'bg-blue-50 border-r-4 border-blue-500' : ''
                }`}
              >
                <div className="flex justify-between items-start">
                  <div className="flex-1">
                    <div className="font-medium text-gray-900">{dept.department}</div>
                    <div className="text-sm text-gray-600 mt-1">
                      {dept.total_orders} orders • {dept.avg_completion_percentage}% avg complete
                    </div>
                  </div>
                  {dept.urgent_orders > 0 && (
                    <span className="ml-2 px-2 py-1 text-xs bg-red-100 text-red-700 rounded">
                      {dept.urgent_orders} urgent
                    </span>
                  )}
                </div>
                
                <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                  <div className="text-center">
                    <div className="font-medium text-yellow-600">{dept.pending_orders}</div>
                    <div className="text-gray-500">Pending</div>
                  </div>
                  <div className="text-center">
                    <div className="font-medium text-blue-600">{dept.in_progress_orders}</div>
                    <div className="text-gray-500">In Progress</div>
                  </div>
                  <div className="text-center">
                    <div className="font-medium text-green-600">{dept.completed_orders}</div>
                    <div className="text-gray-500">Completed</div>
                  </div>
                </div>
                
                {dept.workflow_eligible_orders > 0 && (
                  <div className="mt-2 flex items-center text-xs text-purple-600">
                    <Activity className="h-3 w-3 mr-1" />
                    {dept.workflow_eligible_orders} workflow ready
                  </div>
                )}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Department Orders */}
      <div className="col-span-8">
        {selectedDepartment ? (
          <div className="space-y-4">
            {/* Department Header with Filters */}
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-lg font-semibold text-gray-900">
                  {selectedDepartment} Department
                </h3>
                <div className="flex space-x-2">
                  <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                    className="px-3 py-1 border border-gray-300 rounded-md text-sm"
                  >
                    <option value="all">All Status</option>
                    <option value="pending">Pending</option>
                    <option value="in_progress">In Progress</option>
                    <option value="completed">Completed</option>
                  </select>
                </div>
              </div>
              
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                <input
                  type="text"
                  placeholder="Search orders, patients, samples..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-md text-sm"
                />
              </div>
            </div>

            {/* Entry Method Selector */}
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
              <div className="flex space-x-1 bg-gray-100 rounded-lg p-1">
                <button
                  onClick={() => onEntryMethodChange('ai-upload')}
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
                  onClick={() => onEntryMethodChange('manual')}
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
                  onClick={() => onEntryMethodChange('workflow')}
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
            </div>

            {/* Orders List */}
            <div className="space-y-3">
              {departmentOrders.map((order) => (
                <div key={order.order_id} className="bg-white rounded-lg shadow-sm border border-gray-200">
                  <div className="p-4">
                    <div className="flex justify-between items-start">
                      <div className="flex-1">
                        <div className="flex items-center space-x-3">
                          <button
                            onClick={() => toggleOrderExpansion(order.order_id)}
                            className="text-gray-400 hover:text-gray-600"
                          >
                            {expandedOrders.has(order.order_id) ? (
                              <ChevronDown className="h-4 w-4" />
                            ) : (
                              <ChevronRight className="h-4 w-4" />
                            )}
                          </button>
                          <div>
                            <div className="font-medium text-gray-900">
                              {order.patient_name}
                            </div>
                            <div className="text-sm text-gray-600">
                              Order #{order.order_id.slice(0, 8)} • Sample: {order.sample_id}
                            </div>
                          </div>
                        </div>
                      </div>
                      
                      <div className="flex items-center space-x-2">
                        <span className={`px-2 py-1 text-xs rounded border ${getPriorityColor(order.priority)}`}>
                          {order.priority || 'Normal'}
                        </span>
                        <span className={`px-2 py-1 text-xs rounded border ${getStatusColor(order.status)}`}>
                          {order.status.replace('_', ' ')}
                        </span>
                        <button
                          onClick={() => onOrderSelect(order)}
                          className="px-3 py-1 bg-blue-600 text-white text-xs rounded hover:bg-blue-700"
                        >
                          Select
                        </button>
                      </div>
                    </div>

                    {/* Progress Bar */}
                    <div className="mt-3">
                      <div className="flex justify-between text-xs text-gray-600 mb-1">
                        <span>Progress</span>
                        <span>{order.completion_percentage}%</span>
                      </div>
                      <div className="w-full bg-gray-200 rounded-full h-2">
                        <div
                          className={`h-2 rounded-full transition-all ${
                            order.completion_percentage === 100 ? 'bg-green-500' : 'bg-blue-500'
                          }`}
                          style={{ width: `${order.completion_percentage}%` }}
                        />
                      </div>
                    </div>

                    {/* Expanded Test Groups */}
                    {expandedOrders.has(order.order_id) && (
                      <div className="mt-4 pt-4 border-t border-gray-200">
                        <div className="grid gap-2">
                          {order.test_groups.map((testGroup) => (
                            <div
                              key={testGroup.id}
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
                                    {testGroup.name}
                                  </div>
                                  <div className="text-sm text-gray-600">
                                    {testGroup.completed_analytes}/{testGroup.total_analytes} completed
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
                    )}
                  </div>
                </div>
              ))}

              {departmentOrders.length === 0 && (
                <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-8 text-center">
                  <TestTube className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                  <h4 className="text-lg font-medium text-gray-900 mb-2">No Orders Found</h4>
                  <p className="text-gray-600">
                    {searchTerm || statusFilter !== 'all' 
                      ? 'No orders match your current filters.' 
                      : `No orders found for ${selectedDepartment} department.`}
                  </p>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-12 text-center">
            <Users className="h-16 w-16 text-gray-400 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-gray-900 mb-2">Select a Department</h3>
            <p className="text-gray-600">
              Choose a department from the left panel to view and manage orders
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

export default DepartmentView;