import React, { useState, useEffect } from 'react';
import { Plus, Search, Filter, Calendar, Clock, CheckCircle, XCircle, AlertTriangle, Package, Eye } from 'lucide-react';
import { database } from '../utils/supabase';
import { useAuth } from '../contexts/AuthContext';
import OrderDetailsModal from '../components/Orders/OrderDetailsModal';
import AddOrderModal from '../components/Orders/AddOrderModal';

interface Order {
  id: string;
  patient_name: string;
  patient_id: string;
  tests: string[];
  status: string;
  priority: string;
  order_date: string;
  expected_date: string;
  total_amount: number;
  doctor: string;
  sample_id?: string;
  color_code?: string;
  color_name?: string;
  qr_code_data?: string;
  sample_collected_at?: string;
  sample_collected_by?: string;
}

const Orders: React.FC = () => {
  const { user } = useAuth();
  const [orders, setOrders] = useState<Order[]>([]);
  const [filteredOrders, setFilteredOrders] = useState<Order[]>([]);
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [showAddOrderModal, setShowAddOrderModal] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [priorityFilter, setPriorityFilter] = useState('all');
  const [dateFilter, setDateFilter] = useState('all');

  useEffect(() => {
    fetchOrders();
  }, []);

  useEffect(() => {
    filterOrders();
  }, [orders, searchTerm, statusFilter, priorityFilter, dateFilter]);

  const fetchOrders = async () => {
    try {
      setIsLoading(true);
      const { data, error } = await database.orders.getAll();
      if (error) throw error;
      setOrders(data || []);
    } catch (error) {
      console.error('Error fetching orders:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const filterOrders = () => {
    let filtered = [...orders];

    // Search filter
    if (searchTerm) {
      filtered = filtered.filter(order =>
        order.patient_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        order.id.toLowerCase().includes(searchTerm.toLowerCase()) ||
        order.tests.some(test => test.toLowerCase().includes(searchTerm.toLowerCase()))
      );
    }

    // Status filter
    if (statusFilter !== 'all') {
      filtered = filtered.filter(order => order.status === statusFilter);
    }

    // Priority filter
    if (priorityFilter !== 'all') {
      filtered = filtered.filter(order => order.priority === priorityFilter);
    }

    // Date filter
    if (dateFilter !== 'all') {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      
      filtered = filtered.filter(order => {
        const orderDate = new Date(order.order_date);
        orderDate.setHours(0, 0, 0, 0);
        
        switch (dateFilter) {
          case 'today':
            return orderDate.getTime() === today.getTime();
          case 'week':
            const weekAgo = new Date(today);
            weekAgo.setDate(weekAgo.getDate() - 7);
            return orderDate >= weekAgo;
          case 'month':
            const monthAgo = new Date(today);
            monthAgo.setMonth(monthAgo.getMonth() - 1);
            return orderDate >= monthAgo;
          default:
            return true;
        }
      });
    }

    setFilteredOrders(filtered);
  };

  const handleAddOrder = async (orderData: any) => {
    try {
      setIsLoading(true);
      
      // Ensure lab context is included
      const currentLabId = await database.getCurrentUserLabId();
      const orderWithLabId = {
        ...orderData,
        lab_id: currentLabId,
        created_by: user?.id,
        status: 'Order Created',
        order_date: new Date().toISOString().split('T')[0],
        created_at: new Date().toISOString()
      };

      // Create the order using the database API
      const { data, error } = await database.orders.create(orderWithLabId);
      
      if (error) {
        throw new Error(error.message);
      }

      // Refresh the orders list
      await fetchOrders();
      
      // Close the modal
      setShowAddOrderModal(false);
      
      // Show success message
      console.log('Order created successfully:', data);
      
    } catch (error) {
      console.error('Error creating order:', error);
      // Handle error appropriately
      alert('Failed to create order. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleUpdateOrderStatus = async (orderId: string, newStatus: string) => {
    try {
      const { error } = await database.orders.update(orderId, { status: newStatus });
      if (error) throw error;
      
      // Update local state
      setOrders(orders.map(order => 
        order.id === orderId ? { ...order, status: newStatus } : order
      ));
      
      // Close modal
      setSelectedOrder(null);
    } catch (error) {
      console.error('Error updating order status:', error);
    }
  };

  const handleSubmitResults = async (orderId: string, resultsData: any[]) => {
    try {
      // Handle results submission
      console.log('Submitting results for order:', orderId, resultsData);
      
      // Update order status to indicate results are submitted
      await handleUpdateOrderStatus(orderId, 'Pending Approval');
      
      // Refresh orders
      await fetchOrders();
    } catch (error) {
      console.error('Error submitting results:', error);
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'Order Created':
      case 'Sample Collection':
        return <Clock className="h-4 w-4" />;
      case 'In Progress':
        return <AlertTriangle className="h-4 w-4" />;
      case 'Pending Approval':
        return <Eye className="h-4 w-4" />;
      case 'Completed':
        return <CheckCircle className="h-4 w-4" />;
      case 'Delivered':
        return <Package className="h-4 w-4" />;
      case 'Cancelled':
        return <XCircle className="h-4 w-4" />;
      default:
        return <Clock className="h-4 w-4" />;
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'Order Created':
        return 'text-gray-500 bg-gray-100';
      case 'Sample Collection':
        return 'text-blue-600 bg-blue-100';
      case 'In Progress':
        return 'text-yellow-600 bg-yellow-100';
      case 'Pending Approval':
        return 'text-orange-600 bg-orange-100';
      case 'Completed':
        return 'text-green-600 bg-green-100';
      case 'Delivered':
        return 'text-purple-600 bg-purple-100';
      case 'Cancelled':
        return 'text-red-600 bg-red-100';
      default:
        return 'text-gray-500 bg-gray-100';
    }
  };

  const getPriorityColor = (priority: string) => {
    switch (priority) {
      case 'Normal':
        return 'text-gray-600 bg-gray-100';
      case 'Urgent':
        return 'text-orange-600 bg-orange-100';
      case 'STAT':
        return 'text-red-600 bg-red-100';
      default:
        return 'text-gray-600 bg-gray-100';
    }
  };

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Orders Management</h1>
        <p className="text-gray-600">Manage laboratory test orders and track their progress</p>
      </div>

      {/* Filters and Search */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 mb-6">
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
          {/* Search */}
          <div className="md:col-span-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search by patient name, order ID, or test..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
          </div>

          {/* Status Filter */}
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          >
            <option value="all">All Status</option>
            <option value="Order Created">Order Created</option>
            <option value="Sample Collection">Sample Collection</option>
            <option value="In Progress">In Progress</option>
            <option value="Pending Approval">Pending Approval</option>
            <option value="Completed">Completed</option>
            <option value="Delivered">Delivered</option>
          </select>

          {/* Priority Filter */}
          <select
            value={priorityFilter}
            onChange={(e) => setPriorityFilter(e.target.value)}
            className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          >
            <option value="all">All Priority</option>
            <option value="Normal">Normal</option>
            <option value="Urgent">Urgent</option>
            <option value="STAT">STAT</option>
          </select>

          {/* Date Filter */}
          <select
            value={dateFilter}
            onChange={(e) => setDateFilter(e.target.value)}
            className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          >
            <option value="all">All Time</option>
            <option value="today">Today</option>
            <option value="week">This Week</option>
            <option value="month">This Month</option>
          </select>
        </div>
      </div>

      {/* Add Order Button */}
      <div className="flex justify-between items-center mb-6">
        <div className="flex items-center space-x-4">
          <Filter className="h-5 w-5 text-gray-400" />
          <span className="text-sm text-gray-600">
            Showing {filteredOrders.length} of {orders.length} orders
          </span>
        </div>
        <button
          onClick={() => setShowAddOrderModal(true)}
          className="flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
        >
          <Plus className="h-4 w-4 mr-2" />
          Add New Order
        </button>
      </div>

      {/* Orders Table */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Order ID
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Patient
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Tests
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Status
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Priority
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Order Date
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Amount
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {isLoading ? (
                <tr>
                  <td colSpan={8} className="px-6 py-4 text-center">
                    <div className="flex items-center justify-center">
                      <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600"></div>
                      <span className="ml-2 text-gray-600">Loading orders...</span>
                    </div>
                  </td>
                </tr>
              ) : filteredOrders.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-6 py-4 text-center text-gray-500">
                    No orders found
                  </td>
                </tr>
              ) : (
                filteredOrders.map((order) => (
                  <tr key={order.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                      {order.id.slice(0, 8)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="text-sm font-medium text-gray-900">{order.patient_name}</div>
                      <div className="text-sm text-gray-500">{order.patient_id.slice(0, 8)}</div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="text-sm text-gray-900">
                        {order.tests.slice(0, 2).join(', ')}
                        {order.tests.length > 2 && (
                          <span className="text-gray-500"> +{order.tests.length - 2} more</span>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusColor(order.status)}`}>
                        {getStatusIcon(order.status)}
                        <span className="ml-1">{order.status}</span>
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getPriorityColor(order.priority)}`}>
                        {order.priority}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      <div className="flex items-center">
                        <Calendar className="h-4 w-4 mr-1" />
                        {new Date(order.order_date).toLocaleDateString()}
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                      ₹{order.total_amount.toLocaleString()}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                      <button
                        onClick={() => setSelectedOrder(order)}
                        className="text-blue-600 hover:text-blue-900"
                      >
                        View Details
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Modals */}
      {selectedOrder && (
        <OrderDetailsModal
          order={selectedOrder}
          onClose={() => setSelectedOrder(null)}
          onUpdateStatus={handleUpdateOrderStatus}
          onSubmitResults={handleSubmitResults}
        />
      )}

      {showAddOrderModal && (
        <AddOrderModal
          onClose={() => setShowAddOrderModal(false)}
          onAdd={handleAddOrder}
        />
      )}
    </div>
  );
};

export default Orders;
          return { allowed: false, reason: 'Order must be in progress before submitting for approval.' };
        }
        return { allowed: true };
      case 'Completed':
        if (!order.sample_collected_at) {
          return { allowed: false, reason: 'Sample must be collected before completing order.' };
        }
        return { allowed: true };
      case 'Delivered':
        if (order.status !== 'Completed') {
          return { allowed: false, reason: 'Order must be completed before delivery.' };
        }
        return { allowed: true };
      default:
        return { allowed: true };
    }
  };

  const handleUpdateOrderStatus = async (orderId: string, newStatus: string) => {
    try {
      const order = orders.find(o => o.id === orderId);
      if (!order) {
        console.error('Order not found');
        return;
      }

      const validation = validateStatusTransition(order, newStatus);
      if (!validation.allowed) {
        alert(`Cannot update status: ${validation.reason}`);
        return;
      }

      const updateData: any = { status: newStatus };
      if (newStatus === 'Sample Collection') {
        updateData.sample_collected_at = new Date().toISOString();
        updateData.sample_collected_by = user?.email || 'System';
      }

      const { error } = await database.orders.update(orderId, updateData);
      if (error) {
        console.error('Error updating order status:', error);
        return;
      }

      setOrders(prev =>
        prev.map(o => (o.id === orderId ? { ...o, ...updateData, status: newStatus as Order['status'] } : o))
      );
      setSelectedOrder(null);
    } catch (err) {
      console.error('Error:', err);
    }
  };

  const handleSubmitOrderResults = async (orderId: string, resultsData: ExtractedValue[]) => {
    const order = orders.find(o => o.id === orderId);
    if (!order) return;

    const newResult = {
      order_id: order.id,
      patient_name: order.patient_name,
      patient_id: order.patient_id,
      test_name: (order.tests || []).join(', '),
      status: 'Under Review' as const,
      entered_by: (user as any)?.user_metadata?.full_name || user?.email || 'Tech. AI Assistant',
      entered_date: new Date().toISOString().split('T')[0],
      values: resultsData.map(item => ({
        parameter: item.parameter,
        value: item.value,
        unit: item.unit,
        reference_range: item.reference,
        flag: item.flag,
      })),
    };

    try {
      const { error } = await database.results.create(newResult);
      if (error) {
        console.error('Error creating result:', error);
        return;
      }
      await fetchOrders();
      console.log('Result submitted and order status automatically checked');
    } catch (err) {
      console.error('Error creating result:', err);
    }
  };

  const handleOpenManualResultEntry = async (order: Order) => {
    try {
      setManualEntryOrder(order);
      const { data: orderData, error } = await database.orders.getOrderWithTestGroups(order.id);
      if (error) {
        console.error('Error fetching order test groups:', error);
        return;
      }

      const organized = organizeOrderTestGroups(orderData);
      setGroupedTestData(organized);

      const initialProgress: { [key: string]: TestGroupProgress } = {};
      organized.testGroups.forEach(g => {
        initialProgress[g.groupId] = g.progress;
      });
      setGroupProgress(initialProgress);

      setActiveGroupIndex(0);
      setShowManualResultEntry(true);
    } catch (err) {
      console.error('Error opening manual result entry:', err);
    }
  };

  const saveDraftForGroup = async (groupId: string) => {
    if (!manualEntryOrder || !groupedTestData) return;
    const groupResults = draftResults[groupId] || [];
    const group = groupedTestData.testGroups.find(g => g.groupId === groupId);

    try {
      const { error } = await database.results.saveDraft({
        orderId: manualEntryOrder.id,
        testGroupId: groupId,
        results: groupResults,
        savedAt: new Date(),
      });
      if (error) {
        console.error('Error saving draft:', error);
        alert('Failed to save draft');
        return;
      }
      updateGroupProgress(groupId, groupResults);
      alert(`Draft saved for ${group?.groupName || 'group'}`);
    } catch (err) {
      console.error('Error saving draft:', err);
      alert('Failed to save draft');
    }
  };

  const validateGroupCompletion = (analytes: AnalyteResult[]): boolean => {
    if (!groupedTestData) return false;
    const group = groupedTestData.testGroups[activeGroupIndex];
    if (!group) return false;

    // Require value AND flag for each analyte
    return group.analytes.every(template => {
      const res = analytes.find(a => a.analyteId === template.analyteId);
      return !!res && String(res.value).trim() !== '' && String(res.flag).trim() !== '';
    });
  };

  const saveAndCompleteGroup = async (groupId: string) => {
    if (!manualEntryOrder || !groupedTestData) return;
    const groupResults = draftResults[groupId] || [];
    const group = groupedTestData.testGroups.find(g => g.groupId === groupId);

    if (!validateGroupCompletion(groupResults)) {
      alert('Please complete all analytes before marking group as complete');
      return;
    }

    try {
      const { error } = await database.results.saveAndCompleteGroup({
        orderId: manualEntryOrder.id,
        testGroupId: groupId,
        results: groupResults,
        completedAt: new Date(),
      });
      if (error) {
        console.error('Error completing group:', error);
        alert('Failed to complete group');
        return;
      }

      setGroupProgress(prev => ({
        ...prev,
        [groupId]: {
          ...prev[groupId],
          isComplete: true,
          completedAnalytes: groupResults.filter(a => a.isEntered).length,
        },
      }));

      alert(`${group?.groupName || 'Group'} marked as complete!`);

      // Move to next group if available
      if (activeGroupIndex < groupedTestData.testGroups.length - 1) {
        setActiveGroupIndex(idx => idx + 1);
      }
    } catch (err) {
      console.error('Error completing group:', err);
      alert('Failed to complete group');
    }
  };

  const activeGroup = useMemo(() => groupedTestData?.testGroups[activeGroupIndex] || null, [groupedTestData, activeGroupIndex]);

  // Group orders by date
  const groupOrdersByDate = () => {
    const today = new Date();
    const groups: {
      [key: string]: { date: Date; dateString: string; orders: Order[]; isToday: boolean; isFuture: boolean };
    } = {};

    const todayString = today.toISOString().split('T')[0];
    groups[todayString] = {
      date: today,
      dateString: todayString,
      orders: [],
      isToday: true,
      isFuture: false,
    };

    filteredOrders.forEach(order => {
      const orderDate = new Date(order.order_date);
      const orderDateString = orderDate.toISOString().split('T')[0];

      if (!groups[orderDateString]) {
        groups[orderDateString] = {
          date: orderDate,
          dateString: orderDateString,
          orders: [],
          isToday: orderDateString === todayString,
          isFuture: orderDate > today,
        };
      }
      groups[orderDateString].orders.push(order);
    });

    const sortedGroups = Object.values(groups).sort((a, b) => {
      if (a.isToday) return -1;
      if (b.isToday) return 1;
      return b.date.getTime() - a.date.getTime();
    });

    // sort orders within groups
    sortedGroups.forEach(group => {
      group.orders.sort((a, b) => {
        const extractSampleNumber = (o: Order) => {
          const m = (o.sample_id || '').match(/-(\d+)$/);
          return m ? parseInt(m[1], 10) : 0;
        };
        const sa = extractSampleNumber(a);
        const sb = extractSampleNumber(b);
        if (sa !== sb) return sb - sa;

        const da = new Date(a.order_date ?? 0).getTime();
        const db = new Date(b.order_date ?? 0).getTime();
        return db - da;
      });
    });

    return sortedGroups;
  };

  const orderGroups = groupOrdersByDate();

  const formatDateHeader = (group: { date: Date; isToday: boolean; isFuture: boolean }) => {
    const { date, isToday, isFuture } = group;
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    if (isToday) {
      return `📅 Today - ${date.toLocaleDateString('en-IN', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      })}`;
    } else if (date.toDateString() === yesterday.toDateString()) {
      return `📅 Yesterday - ${date.toLocaleDateString('en-IN', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
      })}`;
    } else if (isFuture) {
      return `📅 ${date.toLocaleDateString('en-IN', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      })} (Future)`;
    } else {
      const diffTime = today.getTime() - date.getTime();
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      return `📅 ${date.toLocaleDateString('en-IN', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      })} (${diffDays} days ago)`;
    }
  };

  const getPriorityColor = (priority: string) => {
    const colors: Record<string, string> = {
      Normal: 'bg-gray-100 text-gray-800',
      Urgent: 'bg-orange-100 text-orange-800',
      STAT: 'bg-red-100 text-red-800',
    };
    return colors[priority] || 'bg-gray-100 text-gray-800';
  };

  // Add the missing handleAddOrder function
  const handleAddOrder = async (orderData: any) => {
    try {
      setIsLoading(true);
      
      // Ensure lab context is included
      const currentLabId = await database.getCurrentUserLabId();
      const orderWithLabId = {
        ...orderData,
        lab_id: currentLabId,
        created_by: user?.id,
        status: 'Order Created',
        order_date: new Date().toISOString().split('T')[0],
        created_at: new Date().toISOString()
      };

      // Create the order using the database API
      const { data, error } = await database.orders.create(orderWithLabId);
      
      if (error) {
        throw new Error(error.message);
      }

      // Refresh the orders list
      await fetchOrders();
      
      // Close any modal that might be open
      if (setShowAddOrderModal) {
        setShowAddOrderModal(false);
      }
      
      console.log('Order created successfully:', data);
      
    } catch (error) {
      console.error('Error creating order:', error);
      // Handle error appropriately
      throw error;
    } finally {
      setIsLoading(false);
    }
  };

  // Add function to open add order modal if needed
  const handleOpenAddOrderModal = () => {
    setShowAddOrderModal(true);
  };

  // Add function to close add order modal if needed
  const handleCloseAddOrderModal = () => {
    setShowAddOrderModal(false);
  };

  return (
    <div className="space-y-6">
      {/* View Mode Toggle */}
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-4">
          <h1 className="text-3xl font-bold text-gray-900">
            {viewMode === 'traditional' ? 'Test Orders - Technician View' : 'Patient Sessions'}
          </h1>
          <div className="flex items-center space-x-2 bg-gray-100 rounded-lg p-1">
            <button
              onClick={() => setViewMode('traditional')}
              className={`px-3 py-1 text-sm font-medium rounded-md transition-colors ${
                viewMode === 'traditional' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              Traditional View
            </button>
            <button
              onClick={() => setViewMode('patient-centric')}
              className={`px-3 py-1 text-sm font-medium rounded-md transition-colors ${
                viewMode === 'patient-centric' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              Patient-Centric
            </button>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => {
              console.log('Global AI Analysis clicked');
            }}
            className="flex items-center px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors"
            title="AI Analysis"
          >
            <Brain className="h-5 w-5 mr-2" />
            AI Analysis
          </button>
          <AIUtilityButton context={{ placement: 'orders_page' }} variant="secondary" size="md">
            AI Tools
          </AIUtilityButton>
          <button
            onClick={() => setShowOrderForm(true)}
            className="flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            <Plus className="h-5 w-5 mr-2" />
            {viewMode === 'traditional' ? 'Create Order' : 'New Session'}
          </button>
        </div>
      </div>

      {/* Conditional Rendering */}
      {viewMode === 'patient-centric' ? (
        <EnhancedOrders
          orders={orders}
          onAddOrder={handleAddOrder}
          onUpdateStatus={handleUpdateOrderStatus}
          onRefreshOrders={fetchOrders}
          onViewOrderDetails={setSelectedOrder}
          onNewSession={() => setShowOrderForm(true)}
          onNewPatientVisit={() => setShowOrderForm(true)}
        />
      ) : (
        <>
          {/* Traditional Orders View */}
          <div className="flex items-center justify-between">
            <h2 className="sr-only">Test Orders - Technician View</h2>
          </div>

          {/* Status Overview Cards */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="bg-gradient-to-r from-green-50 to-green-100 rounded-lg shadow-sm border border-green-200 p-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-2xl font-bold text-green-900">{completionSummary.allDone}</div>
                  <div className="text-sm text-green-700">All Done</div>
                </div>
                <div className="bg-green-500 p-2 rounded-lg">
                  <CheckCircle className="h-5 w-5 text-white" />
                </div>
              </div>
            </div>

            <div className="bg-gradient-to-r from-blue-50 to-blue-100 rounded-lg shadow-sm border border-blue-200 p-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-2xl font-bold text-blue-900">{completionSummary.mostlyDone}</div>
                  <div className="text-sm text-blue-700">Mostly Done</div>
                </div>
                <div className="bg-blue-500 p-2 rounded-lg">
                  <TrendingUp className="h-5 w-5 text-white" />
                </div>
              </div>
            </div>

            <div className="bg-gradient-to-r from-yellow-50 to-yellow-100 rounded-lg shadow-sm border border-yellow-200 p-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-2xl font-bold text-yellow-900">{completionSummary.pending}</div>
                  <div className="text-sm text-yellow-700">Pending</div>
                </div>
                <div className="bg-yellow-500 p-2 rounded-lg">
                  <ClockIcon className="h-5 w-5 text-white" />
                </div>
              </div>
            </div>

            <div className="bg-gradient-to-r from-orange-50 to-orange-100 rounded-lg shadow-sm border border-orange-200 p-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-2xl font-bold text-orange-900">{completionSummary.awaitingApproval}</div>
                  <div className="text-sm text-orange-700">Awaiting Approval</div>
                </div>
                <div className="bg-orange-500 p-2 rounded-lg">
                  <AlertTriangle className="h-5 w-5 text-white" />
                </div>
              </div>
            </div>
          </div>

          {/* Search & Filters */}
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
            <div className="flex flex-col sm:flex-row gap-4">
              <div className="flex-1 relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                <input
                  type="text"
                  placeholder="Search by patient name, order ID, or patient ID..."
                  value={searchTerm}
                  onChange={e => setSearchTerm(e.target.value)}
                  className="pl-10 pr-4 py-2 w-full border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
              <select
                value={selectedStatus}
                onChange={e => setSelectedStatus(e.target.value)}
                className="px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                {statuses.map(status => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
              <select
                value={selectedCompletion}
                onChange={e => setSelectedCompletion(e.target.value)}
                className="px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                {completionFilters.map(filter => (
                  <option key={filter} value={filter}>
                    {filter}
                  </option>
                ))}
              </select>
              <button className="flex items-center px-4 py-2 border border-gray-300 rounded-md hover:bg-gray-50 transition-colors">
                <Filter className="h-4 w-4 mr-2" />
                More Filters
              </button>
            </div>
          </div>

          {/* Orders Table */}
          <div className="bg-white rounded-lg shadow-sm border border-gray-200">
            <div className="px-6 py-4 border-b border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900">Test Orders ({filteredOrders.length})</h3>
            </div>

            {orderGroups.length === 0 || orderGroups.every(g => g.orders.length === 0) ? (
              <div className="text-center py-12">
                <TestTube className="h-12 w-12 text-gray-300 mx-auto mb-4" />
                <h3 className="text-lg font-medium text-gray-900 mb-2">No Orders Found</h3>
                <p className="text-gray-500">
                  {searchTerm || selectedStatus !== 'All' || selectedCompletion !== 'All'
                    ? 'Try adjusting your search or filter criteria.'
                    : 'No test orders have been created yet.'}
                </p>
              </div>
            ) : (
              <div className="space-y-8">
                {orderGroups.map(group => (
                  <div key={group.dateString} className="px-6">
                    {/* Date Header */}
                    <div
                      className={`flex items-center justify-between py-4 border-b-2 mb-6 ${
                        group.isToday ? 'border-blue-200 bg-blue-50 -mx-6 px-6 rounded-lg' : 'border-gray-200'
                      }`}
                    >
                      <h4 className={`text-lg font-semibold ${group.isToday ? 'text-blue-900' : 'text-gray-700'}`}>
                        {formatDateHeader(group)}
                      </h4>
                      <div className={`flex items-center space-x-3 ${group.isToday ? 'text-blue-700' : 'text-gray-500'}`}>
                        <span className="text-sm font-medium">
                          {group.orders.length === 0 ? 'No orders' : `${group.orders.length} order${group.orders.length !== 1 ? 's' : ''}`}
                        </span>
                        {group.isToday && (
                          <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                            Today
                          </span>
                        )}
                        {group.isFuture && (
                          <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-orange-100 text-orange-800">
                            Future
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Orders */}
                    {group.orders.length === 0 ? (
                      <div
                        className={`text-center py-8 rounded-lg ${
                          group.isToday ? 'bg-blue-50 border border-blue-200' : 'bg-gray-50 border border-gray-200'
                        }`}
                      >
                        <Calendar className={`h-8 w-8 mx-auto mb-3 ${group.isToday ? 'text-blue-400' : 'text-gray-400'}`} />
                        <p className={`text-sm ${group.isToday ? 'text-blue-600' : 'text-gray-500'}`}>
                          {group.isToday ? 'No orders created today yet. Create your first order!' : 'No orders for this date'}
                        </p>
                        {group.isToday && (
                          <button
                            onClick={() => setShowOrderForm(true)}
                            className="mt-3 inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                          >
                            <Plus className="h-4 w-4 mr-2" />
                            Create Order
                          </button>
                        )}
                      </div>
                    ) : (
                      <div className="space-y-4">
                        {group.orders.map((order, index) => {
                          const isExpanded = !!expandedOrders[order.id];
                          const completionPercentage =
                            order.totalTests > 0 ? (order.completedResults / order.totalTests) * 100 : 0;

                          return (
                            <div
                              key={order.id}
                              className={`w-full p-4 bg-white border-2 rounded-lg hover:shadow-md transition-all ${
                                order.abnormalResults > 0 ? 'border-red-2 00 bg-red-50' : 'border-gray-200'
                              }`}
                            >
                              <div className="space-y-3">
                                {/* Top Row */}
                                <div className="flex items-center justify-between">
                                  <div className="flex items-center space-x-4">
                                    <div className="flex items-center justify-center w-8 h-8 bg-blue-100 text-blue-700 rounded-full font-bold text-sm border-2 border-blue-200">
                                      {index + 1}
                                    </div>

                                    <div className="flex items-center space-x-3">
                                      <User className="h-6 w-6 text-blue-600" />
                                      <div>
                                        <div className="text-2xl font-bold text-gray-900">
                                          {order.patient?.name || order.patient_name}
                                        </div>
                                        <div className="text-lg text-gray-700 font-medium">
                                          {(order.patient?.age || 'N/A') + 'y'} • {order.patient?.gender || 'N/A'} • ID:{' '}
                                          {(order.sample_id as string) || order.patient_id || 'N/A'}
                                        </div>
                                      </div>
                                    </div>
                                  </div>

                                  {/* Status */}
                                  <div className="flex items-center space-x-3">
                                    <div className="relative">
                                      {(() => {
                                        const getStatusDisplay = (status: string) => {
                                          switch (status) {
                                            case 'Sample Collection':
                                              return {
                                                emoji: '🟡',
                                                text: 'Pending Collection',
                                                color:
                                                  'bg-yellow-100 text-yellow-800 border-yellow-200 hover:bg-yellow-200',
                                              };
                                            case 'In Progress':
                                              return {
                                                emoji: '🔵',
                                                text: 'In Process',
                                                color: 'bg-blue-100 text-blue-800 border-blue-200 hover:bg-blue-200',
                                              };
                                            case 'Completed':
                                              return {
                                                emoji: '🟢',
                                                text: 'Complete',
                                                color:
                                                  'bg-green-100 text-green-800 border-green-200 hover:bg-green-200',
                                              };
                                            case 'Delivered':
                                              return {
                                                emoji: '✅',
                                                text: 'Delivered',
                                                color: 'bg-gray-100 text-gray-800 border-gray-200 hover:bg-gray-200',
                                              };
                                            case 'Pending Approval':
                                              return {
                                                emoji: '🟠',
                                                text: 'Pending Approval',
                                                color:
                                                  'bg-orange-100 text-orange-800 border-orange-200 hover:bg-orange-200',
                                              };
                                            default:
                                              return {
                                                emoji: '⚪',
                                                text: status,
                                                color: 'bg-gray-100 text-gray-800 border-gray-200 hover:bg-gray-200',
                                              };
                                          }
                                        };
                                        const statusInfo = getStatusDisplay(order.status);
                                        const isDropdownOpen = !!showStatusDropdowns[order.id];
                                        const statusOptions = [
                                          { value: 'Sample Collection', label: '🟡 Pending Collection' },
                                          { value: 'In Progress', label: '🔵 In Process' },
                                          { value: 'Pending Approval', label: '🟠 Pending Approval' },
                                          { value: 'Completed', label: '🟢 Complete' },
                                          { value: 'Delivered', label: '✅ Delivered' },
                                        ];

                                        return (
                                          <div className="relative">
                                            <button
                                              onClick={() =>
                                                setShowStatusDropdowns(prev => ({
                                                  ...prev,
                                                  [order.id]: !prev[order.id],
                                                }))
                                              }
                                              className={`inline-flex items-center px-4 py-2 rounded-lg text-lg font-bold border-2 transition-colors ${statusInfo.color}`}
                                            >
                                              <span className="text-xl mr-2">{statusInfo.emoji}</span>
                                              {statusInfo.text}
                                              <ChevronDown className="h-4 w-4 ml-2" />
                                            </button>

                                            {isDropdownOpen && (
                                              <>
                                                <div
                                                  className="fixed inset-0 z-40"
                                                  onClick={() =>
                                                    setShowStatusDropdowns(prev => ({
                                                      ...prev,
                                                      [order.id]: false,
                                                    }))
                                                  }
                                                />
                                                <div className="absolute right-0 top-full mt-1 w-64 bg-white border-2 border-gray-200 rounded-lg shadow-lg z-50">
                                                  <div className="p-2">
                                                    <div className="text-xs text-gray-600 mb-2 font-medium">
                                                      Update Status:
                                                    </div>
                                                    {statusOptions.map(option => (
                                                      <button
                                                        key={option.value}
                                                        onClick={() => {
                                                          handleUpdateOrderStatus(order.id, option.value);
                                                          setShowStatusDropdowns(prev => ({
                                                            ...prev,
                                                            [order.id]: false,
                                                          }));
                                                        }}
                                                        className={`w-full text-left px-3 py-2 rounded text-sm hover:bg-gray-100 transition-colors ${
                                                          order.status === (option.value as Order['status'])
                                                            ? 'bg-blue-50 text-blue-700 font-medium'
                                                            : 'text-gray-700'
                                                        }`}
                                                      >
                                                        {option.label}
                                                      </button>
                                                    ))}
                                                  </div>
                                                </div>
                                              </>
                                            )}
                                          </div>
                                        );
                                      })()}
                                    </div>

                                    <button
                                      onClick={() =>
                                        setExpandedOrders(prev => ({
                                          ...prev,
                                          [order.id]: !prev[order.id],
                                        }))
                                      }
                                      className="p-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                                      title="View details"
                                    >
                                      {isExpanded ? <ChevronUp className="h-5 w-5" /> : <ChevronDown className="h-5 w-5" />}
                                    </button>
                                  </div>
                                </div>

                                {/* Second Row */}
                                <div className="flex items-center justify-between bg-gray-50 rounded-lg p-3">
                                  <div className="flex items-center space-x-6">
                                    {/* Order & Sample */}
                                    <div className="flex items-center space-x-4">
                                      <div>
                                        <div className="text-sm text-gray-600">Order</div>
                                        <div className="font-bold text-gray-900">#{(order.id || '').slice(-6)}</div>
                                      </div>

                                      {order.sample_id && (
                                        <div className="flex items-center space-x-2">
                                          <div
                                            className="w-8 h-8 rounded-full border-2 border-white shadow-md flex items-center justify-center text-white font-bold text-xs"
                                            style={{ backgroundColor: order.color_code || '#8B5CF6' }}
                                            title={`Sample Tube: ${order.color_name || 'Purple'}`}
                                          >
                                            {(order.color_name || 'EDTA').charAt(0)}
                                          </div>
                                          <div>
                                            <div className="text-xs text-gray-600">Sample</div>
                                            <div className="font-mono font-bold text-gray-900 text-sm">
                                              {String(order.sample_id).split('-').pop()}
                                            </div>
                                          </div>
                                        </div>
                                      )}
                                    </div>

                                    {/* Tests */}
                                    <div className="flex-1">
                                      <div className="text-sm text-gray-600 mb-1">Tests ({order.tests.length})</div>
                                      <div className="flex flex-wrap gap-1">
                                        {order.tests.map((test, i) => (
                                          <span
                                            key={`${order.id}-test-${i}`}
                                            className="inline-flex items-center px-2 py-1 rounded text-sm bg-blue-100 text-blue-800 font-medium"
                                          >
                                            {test}
                                          </span>
                                        ))}
                                      </div>
                                    </div>
                                  </div>

                                  {/* Amount & Dates */}
                                  <div className="text-right">
                                    <div className="text-2xl font-bold text-green-600">
                                      ₹{Number(order.total_amount || 0).toLocaleString()}
                                    </div>
                                    <div className="text-sm text-gray-600">
                                      <div>Ordered: {new Date(order.order_date).toLocaleDateString()}</div>
                                      <div
                                        className={`${
                                          new Date(order.expected_date) < new Date() ? 'text-red-600 font-bold' : ''
                                        }`}
                                      >
                                        Expected: {new Date(order.expected_date).toLocaleDateString()}
                                        {new Date(order.expected_date) < new Date() && ' ⚠️ OVERDUE'}
                                      </div>
                                    </div>

                                    <div className="mt-3">
                                      <button
                                        onClick={() => setSelectedOrder(order)}
                                        className="flex items-center px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                                      >
                                        <Eye className="h-4 w-4 mr-1" />
                                        View Full Details
                                      </button>
                                    </div>
                                  </div>
                                </div>

                                {/* Progress */}
                                {order.status === 'In Progress' && (
                                  <div className="bg-blue-50 rounded-lg p-2">
                                    <div className="flex items-center justify-between text-sm mb-1">
                                      <span className="text-blue-700 font-medium">Progress</span>
                                      <span className="text-blue-700">{Math.round(completionPercentage)}% Complete</span>
                                    </div>
                                    <div className="w-full bg-blue-200 rounded-full h-3">
                                      <div
                                        className="bg-blue-600 h-3 rounded-full transition-all duration-300"
                                        style={{ width: `${completionPercentage}%` }}
                                      />
                                    </div>
                                  </div>
                                )}
                              </div>

                              {/* Expanded Content */}
                              {isExpanded && (
                                <div className="mt-4 pt-4 border-t border-gray-200 bg-gray-50 rounded-lg p-4">
                                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                    {/* Sample Info */}
                                    <div className="bg-white rounded-lg p-4 border-2 border-purple-200">
                                      <div className="flex items-center space-x-3 mb-3">
                                        <div
                                          className="w-12 h-12 rounded-full border-4 border-white shadow-lg flex items-center justify-center text-white font-bold text-lg"
                                          style={{ backgroundColor: order.color_code || '#8B5CF6' }}
                                        >
                                          {(order.color_name || 'EDTA').charAt(0)}
                                        </div>
                                        <div>
                                          <div className="text-lg font-bold text-gray-900">
                                            {order.color_name || 'Purple EDTA'}
                                          </div>
                                          <div className="text-sm text-gray-600">Sample Tube</div>
                                        </div>
                                      </div>
                                      {order.sample_id && (
                                        <div className="bg-purple-50 rounded p-2">
                                          <div className="text-xs text-purple-600 font-medium">SAMPLE ID</div>
                                          <div className="font-mono font-bold text-purple-900 text-lg">{order.sample_id}</div>
                                        </div>
                                      )}
                                    </div>

                                    {/* Test Progress */}
                                    <div className="bg-white rounded-lg p-4 border-2 border-blue-200">
                                      <div className="flex items-center justify-between mb-3">
                                        <div className="flex items-center space-x-2">
                                          <TestTube className="h-5 w-5 text-blue-600" />
                                          <span className="font-bold text-gray-900">Test Progress</span>
                                        </div>
                                        {order.abnormalResults > 0 && (
                                          <span className="bg-red-100 text-red-800 px-2 py-1 rounded-full text-xs font-bold">
                                            ⚠️ {order.abnormalResults} Abnormal
                                          </span>
                                        )}
                                      </div>
                                      <div className="space-y-2">
                                        <div className="flex justify-between text-sm">
                                          <span>Completed</span>
                                          <span className="font-bold">
                                            {order.completedResults || 0}/{order.totalTests || order.tests.length}
                                          </span>
                                        </div>
                                        <div className="w-full bg-gray-200 rounded-full h-4">
                                          <div
                                            className={`h-4 rounded-full transition-all duration-300 ${
                                              completionPercentage === 100
                                                ? 'bg-green-600'
                                                : completionPercentage > 50
                                                ? 'bg-blue-600'
                                                : 'bg-yellow-600'
                                            }`}
                                            style={{ width: `${completionPercentage}%` }}
                                          />
                                        </div>
                                        <div className="text-xs text-gray-600">{Math.round(completionPercentage)}% Complete</div>
                                      </div>
                                    </div>

                                    {/* Critical Info */}
                                    <div className="bg-white rounded-lg p-4 border-2 border-orange-200">
                                      <div className="flex items-center space-x-2 mb-3">
                                        <Calendar className="h-5 w-5 text-orange-600" />
                                        <span className="font-bold text-gray-900">Critical Info</span>
                                      </div>
                                      <div className="space-y-2 text-sm">
                                        <div>
                                          <span className="text-gray-600">Doctor:</span>
                                          <span className="font-medium ml-1">{order.doctor || 'Dr. TBD'}</span>
                                        </div>
                                        <div>
                                          <span className="text-gray-600">Priority:</span>
                                          <span className={`ml-1 px-2 py-0.5 rounded-full text-xs font-bold ${getPriorityColor(order.priority)}`}>
                                            {order.priority || 'Normal'}
                                          </span>
                                        </div>
                                        {order.hasAttachments && (
                                          <div className="flex items-center space-x-1">
                                            <Paperclip className="h-4 w-4 text-blue-500" />
                                            <span className="text-blue-600 font-medium">Has Attachments</span>
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                  </div>

                                  {/* Secondary Actions */}
                                  <div className="flex items-center justify-between mt-4 pt-3 border-t border-gray-200">
                                    <div className="flex items-center space-x-2">
                                      <button
                                        onClick={() => setSelectedOrder(order)}
                                        className="flex items-center px-4 py-2 text-sm bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors"
                                        title="AI Analysis"
                                      >
                                        <Brain className="h-4 w-4 mr-2" />
                                        AI Analysis
                                      </button>
                                      <AIUtilityButton
                                        context={{ orderId: order.id, patientId: order.patient_id, placement: 'order_detail' }}
                                        variant="secondary"
                                        size="sm"
                                      >
                                        AI Tools
                                      </AIUtilityButton>
                                    </div>

                                    <div className="flex items-center space-x-2">
                                      {order.status === 'Pending Approval' && (
                                        <button
                                          onClick={() => handleUpdateOrderStatus(order.id, 'Completed')}
                                          className="flex items-center px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
                                          title="Approve Order"
                                        >
                                          <CheckCircle className="h-4 w-4 mr-2" />
                                          Approve
                                        </button>
                                      )}
                                      {order.status === 'Completed' && (
                                        <button
                                          onClick={() => handleMarkAsDelivered(order.id)}
                                          className="flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                                          title="Mark as Delivered"
                                        >
                                          <Send className="h-4 w-4 mr-2" />
                                          Mark Delivered
                                        </button>
                                      )}
                                    </div>
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 bg-white border-t border-gray-200 sm:px-6">
              <div className="flex justify-between flex-1 sm:hidden">
                <button
                  onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
                  disabled={currentPage === 1}
                  className="relative inline-flex items-center px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <ChevronLeft className="h-4 w-4 mr-2" />
                  Previous
                </button>
                <button
                  onClick={() => setCurrentPage(Math.min(totalPages, currentPage + 1))}
                  disabled={currentPage === totalPages}
                  className="relative ml-3 inline-flex items-center px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Next
                  <ChevronRight className="h-4 w-4 ml-2" />
                </button>
              </div>
              <div className="hidden sm:flex sm:flex-1 sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm text-gray-700">
                    Showing <span className="font-medium">{(currentPage - 1) * itemsPerPage + 1}</span> to{' '}
                    <span className="font-medium">{Math.min(currentPage * itemsPerPage, filteredOrders.length)}</span> of{' '}
                    <span className="font-medium">{filteredOrders.length}</span> results
                  </p>
                </div>
                <div>
                  <nav className="relative z-0 inline-flex rounded-md shadow-sm -space-x-px" aria-label="Pagination">
                    <button
                      onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
                      disabled={currentPage === 1}
                      className="relative inline-flex items-center px-2 py-2 rounded-l-md border border-gray-300 bg-white text-sm font-medium text-gray-500 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <span className="sr-only">Previous</span>
                      <ChevronLeft className="h-5 w-5" />
                    </button>
                    {[...Array(totalPages)].map((_, index) => {
                      const pageNumber = index + 1;
                      return (
                        <button
                          key={pageNumber}
                          onClick={() => setCurrentPage(pageNumber)}
                          className={`relative inline-flex items-center px-4 py-2 border text-sm font-medium ${
                            currentPage === pageNumber
                              ? 'z-10 bg-blue-50 border-blue-500 text-blue-600'
                              : 'bg-white border-gray-300 text-gray-500 hover:bg-gray-50'
                          }`}
                        >
                          {pageNumber}
                        </button>
                      );
                    })}
                    <button
                      onClick={() => setCurrentPage(Math.min(totalPages, currentPage + 1))}
                      disabled={currentPage === totalPages}
                      className="relative inline-flex items-center px-2 py-2 rounded-r-md border border-gray-300 bg-white text-sm font-medium text-gray-500 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <span className="sr-only">Next</span>
                      <ChevronRight className="h-5 w-5" />
                    </button>
                  </nav>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {/* Quick Stats Footer */}
      <div className="bg-gradient-to-r from-blue-50 to-purple-50 rounded-lg p-4 border border-blue-200">
        <div className="flex items-center justify-between text-sm">
          <div className="flex items-center space-x-6">
            <div className="flex items-center">
              <FileText className="h-4 w-4 text-blue-600 mr-1" />
              <span className="text-blue-900 font-medium">Total Orders Today: {orders.length}</span>
            </div>
            <div className="flex items-center">
              <AlertTriangle className="h-4 w-4 text-red-600 mr-1" />
              <span className="text-red-900 font-medium">
                Abnormal: {orders.filter(o => (o.abnormalResults || 0) > 0).length}
              </span>
            </div>
          </div>
          <div className="flex items-center">
            <TrendingUp className="h-4 w-4 text-purple-600 mr-1" />
            <span className="text-purple-900 font-medium">
              Avg TAT:{' '}
              {orders.length > 0
                ? Math.round(
                    orders.reduce((sum, o) => {
                      const orderDate = new Date(o.order_date);
                      const now = new Date();
                      const diffHours = (now.getTime() - orderDate.getTime()) / (1000 * 60 * 60);
                      return sum + diffHours;
                    }, 0) / orders.length
                  )
                : 0}
              h
            </span>
          </div>
        </div>
      </div>

      {/* Quick Actions */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <div className="bg-gradient-to-r from-blue-50 to-blue-100 rounded-lg p-6">
          <h3 className="text-lg font-semibold text-blue-900 mb-2">Sample Collection</h3>
          <p className="text-blue-800 text-sm mb-4">
            {orders.filter(o => o.status === 'Sample Collection').length} orders awaiting sample collection
          </p>
          <button className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition-colors">
            View Collection Queue
          </button>
        </div>

        <div className="bg-gradient-to-r from-purple-50 to-purple-100 rounded-lg p-6">
          <h3 className="text-lg font-semibold text-purple-900 mb-2">New Orders</h3>
          <p className="text-purple-800 text-sm mb-4">
            {orders.filter(o => o.status === 'Order Created').length} orders need sample preparation
          </p>
          <button className="bg-purple-600 text-white px-4 py-2 rounded-lg hover:bg-purple-700 transition-colors">
            Plan Collection
          </button>
        </div>

        <div className="bg-gradient-to-r from-orange-50 to-orange-100 rounded-lg p-6">
          <h3 className="text-lg font-semibold text-orange-900 mb-2">In Progress</h3>
          <p className="text-orange-800 text-sm mb-4">
            {orders.filter(o => o.status === 'In Progress').length} tests currently being processed
          </p>
          <button className="bg-orange-600 text-white px-4 py-2 rounded-lg hover:bg-orange-700 transition-colors">
            Process Tests
          </button>
        </div>

        <div className="bg-gradient-to-r from-green-50 to-green-100 rounded-lg p-6">
          <h3 className="text-lg font-semibold text-green-900 mb-2">AI OCR Ready</h3>
          <p className="text-green-800 text-sm mb-4">Use AI to extract results from test images automatically</p>
          <button className="bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 transition-colors">
            AI Tools
          </button>
        </div>
      </div>

      {/* Modals */}
      {showOrderForm && (
        <OrderForm onClose={() => setShowOrderForm(false)} onSubmit={handleAddOrder} preSelectedPatient={preSelectedPatient} />
      )}

      {selectedOrder && (
        <OrderDetailsModal
          order={selectedOrder}
          onClose={() => setSelectedOrder(null)}
          onUpdateStatus={handleUpdateOrderStatus}
          onSubmitResults={handleSubmitOrderResults}
          onOpenManualEntry={handleOpenManualResultEntry}
        />
      )}

      {showManualResultEntry && manualEntryOrder && groupedTestData && activeGroup && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-6xl max-h-[90vh] overflow-hidden">
            {/* Header */}
            <div className="px-6 py-4 border-b border-gray-200 bg-gradient-to-r from-blue-50 to-purple-50">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-2xl font-bold text-gray-900">Manual Result Entry</h2>
                  <p className="text-gray-600">
                    {manualEntryOrder.patient_name} • Order #{(manualEntryOrder.id || '').slice(-6)}
                  </p>
                </div>
                <div className="flex items-center space-x-3">
                  <div className="text-right">
                    <div className="text-sm text-gray-600">Overall Progress</div>
                    <div className="text-lg font-bold text-blue-600">{groupedTestData.overallProgress.percentage}% Complete</div>
                  </div>
                  <button onClick={() => setShowManualResultEntry(false)} className="text-gray-400 hover:text-gray-600">
                    <ChevronUp className="h-6 w-6" />
                  </button>
                </div>
              </div>

              {/* Tabs */}
              <div className="mt-4 flex space-x-2 overflow-x-auto pb-2">
                {groupedTestData.testGroups.map((group, index) => (
                  <button
                    key={group.groupId}
                    onClick={() => setActiveGroupIndex(index)}
                    className={`flex items-center space-x-2 px-4 py-2 rounded-lg whitespace-nowrap transition-colors ${
                      index === activeGroupIndex ? 'bg-blue-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-100'
                    }`}
                  >
                    <span className="font-medium">{group.groupName}</span>
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold ${
                        groupProgress[group.groupId]?.isComplete ? 'bg-green-100 text-green-800' : 'bg-yellow-100 text-yellow-800'
                      }`}
                    >
                      {groupProgress[group.groupId]?.completedAnalytes || 0}/{group.analytes.length}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {/* Body */}
            <div className="p-6 max-h-[60vh] overflow-y-auto">
              {/* Progress bar */}
              <div className="mb-6">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-lg font-semibold text-gray-900">{activeGroup.groupName}</h3>
                  <span
                    className={`px-3 py-1 rounded-full text-sm font-bold ${
                      groupProgress[activeGroup.groupId]?.isComplete ? 'bg-green-100 text-green-800' : 'bg-blue-100 text-blue-800'
                    }`}
                  >
                    {groupProgress[activeGroup.groupId]?.isComplete
                      ? `✓ Complete`
                      : `${groupProgress[activeGroup.groupId]?.completedAnalytes || 0} of ${activeGroup.analytes.length} completed`}
                  </span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-3">
                  <div
                    className={`h-3 rounded-full transition-all duration-300 ${
                      groupProgress[activeGroup.groupId]?.isComplete ? 'bg-green-600' : 'bg-blue-600'
                    }`}
                    style={{ width: `${groupProgress[activeGroup.groupId]?.percentage || 0}%` }}
                  />
                </div>
              </div>

              {/* Analytes */}
              <div className="bg-gray-50 rounded-lg p-4">
                <div className="grid grid-cols-1 gap-4">
                  {activeGroup.analytes.map(analyte => {
                    const currentResult =
                      draftResults[activeGroup.groupId]?.find(r => r.analyteId === analyte.analyteId) || analyte;

                    return (
                      <div key={analyte.analyteId} className="bg-white rounded-lg p-4 border border-gray-200">
                        <div className="grid grid-cols-1 md:grid-cols-5 gap-4 items-center">
                          <div className="md:col-span-1">
                            <label className="block text-sm font-medium text-gray-700 mb-1">{analyte.analyteName}</label>
                            <div className="text-xs text-gray-500">
                              {analyte.referenceRange && `Ref: ${analyte.referenceRange}`}
                            </div>
                          </div>

                          <div className="md:col-span-1">
                            <input
                              type="text"
                              value={currentResult.value}
                              onChange={e =>
                                handleAnalyteValueChange(activeGroup.groupId, analyte.analyteId, 'value', e.target.value)
                              }
                              placeholder="Enter value"
                              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                            />
                          </div>

                          <div className="md:col-span-1">
                            <input
                              type="text"
                              value={currentResult.unit}
                              onChange={e =>
                                handleAnalyteValueChange(activeGroup.groupId, analyte.analyteId, 'unit', e.target.value)
                              }
                              placeholder="Unit"
                              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                            />
                          </div>

                          <div className="md:col-span-1">
                            <select
                              value={currentResult.flag}
                              onChange={e =>
                                handleAnalyteValueChange(
                                  activeGroup.groupId,
                                  analyte.analyteId,
                                  'flag',
                                  e.target.value as AnalyteResult['flag']
                                )
                              }
                              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                            >
                              <option value="">Select flag</option>
                              <option value="normal">Normal</option>
                              <option value="high">High</option>
                              <option value="low">Low</option>
                              <option value="critical">Critical</option>
                            </select>
                          </div>

                          <div className="md:col-span-1 flex justify-center">
                            {currentResult.isEntered ? (
                              <CheckCircle className="h-6 w-6 text-green-600" />
                            ) : (
                              <div className="h-6 w-6 rounded-full border-2 border-gray-300" />
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Pagination */}
                {totalPages > 1 && (
                  <div className="flex items-center justify-between px-4 py-3 bg-white border-t border-gray-200 sm:px-6">
                    <div className="flex justify-between flex-1 sm:hidden">
                      <button
                        onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
                        disabled={currentPage === 1}
                        className="relative inline-flex items-center px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <ChevronLeft className="h-4 w-4 mr-2" />
                        Previous
                      </button>
                      <button
                        onClick={() => setCurrentPage(Math.min(totalPages, currentPage + 1))}
                        disabled={currentPage === totalPages}
                        className="relative ml-3 inline-flex items-center px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        Next
                        <ChevronRight className="h-4 w-4 ml-2" />
                      </button>
                    </div>
                    <div className="hidden sm:flex sm:flex-1 sm:items-center sm:justify-between">
                      <div>
                        <p className="text-sm text-gray-700">
                          Showing <span className="font-medium">{(currentPage - 1) * itemsPerPage + 1}</span> to{' '}
                          <span className="font-medium">{Math.min(currentPage * itemsPerPage, filteredOrders.length)}</span> of{' '}
                          <span className="font-medium">{filteredOrders.length}</span> results
                        </p>
                      </div>
                      <div>
                        <nav className="relative z-0 inline-flex rounded-md shadow-sm -space-x-px" aria-label="Pagination">
                          <button
                            onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
                            disabled={currentPage === 1}
                            className="relative inline-flex items-center px-2 py-2 rounded-l-md border border-gray-300 bg-white text-sm font-medium text-gray-500 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            <span className="sr-only">Previous</span>
                            <ChevronLeft className="h-5 w-5" />
                          </button>
                          {[...Array(totalPages)].map((_, index) => {
                            const pageNumber = index + 1;
                            return (
                              <button
                                key={pageNumber}
                                onClick={() => setCurrentPage(pageNumber)}
                                className={`relative inline-flex items-center px-4 py-2 border text-sm font-medium ${
                                  currentPage === pageNumber
                                    ? 'z-10 bg-blue-50 border-blue-500 text-blue-600'
                                    : 'bg-white border-gray-300 text-gray-500 hover:bg-gray-50'
                                }`}
                              >
                                {pageNumber}
                              </button>
                            );
                          })}
                          <button
                            onClick={() => setCurrentPage(Math.min(totalPages, currentPage + 1))}
                            disabled={currentPage === totalPages}
                            className="relative inline-flex items-center px-2 py-2 rounded-r-md border border-gray-300 bg-white text-sm font-medium text-gray-500 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            <span className="sr-only">Next</span>
                            <ChevronRight className="h-5 w-5" />
                          </button>
                        </nav>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 bg-white border-t border-gray-200 sm:px-6">
              <div className="flex justify-between flex-1 sm:hidden">
                <button
                  onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
                  disabled={currentPage === 1}
                  className="relative inline-flex items-center px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <ChevronLeft className="h-4 w-4 mr-2" />
                  Previous
                </button>
                <button
                  onClick={() => setCurrentPage(Math.min(totalPages, currentPage + 1))}
                  disabled={currentPage === totalPages}
                  className="relative ml-3 inline-flex items-center px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Next
                  <ChevronRight className="h-4 w-4 ml-2" />
                </button>
              </div>
              <div className="hidden sm:flex sm:flex-1 sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm text-gray-700">
                    Showing <span className="font-medium">{(currentPage - 1) * itemsPerPage + 1}</span> to{' '}
                    <span className="font-medium">{Math.min(currentPage * itemsPerPage, filteredOrders.length)}</span> of{' '}
                    <span className="font-medium">{filteredOrders.length}</span> results
                  </p>
                </div>
                <div>
                  <nav className="relative z-0 inline-flex rounded-md shadow-sm -space-x-px" aria-label="Pagination">
                    <button
                      onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
                      disabled={currentPage === 1}
                      className="relative inline-flex items-center px-2 py-2 rounded-l-md border border-gray-300 bg-white text-sm font-medium text-gray-500 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <span className="sr-only">Previous</span>
                      <ChevronLeft className="h-5 w-5" />
                    </button>
                    {[...Array(totalPages)].map((_, index) => {
                      const pageNumber = index + 1;
                      return (
                        <button
                          key={pageNumber}
                          onClick={() => setCurrentPage(pageNumber)}
                          className={`relative inline-flex items-center px-4 py-2 border text-sm font-medium ${
                            currentPage === pageNumber
                              ? 'z-10 bg-blue-50 border-blue-500 text-blue-600'
                              : 'bg-white border-gray-300 text-gray-500 hover:bg-gray-50'
                          }`}
                        >
                          {pageNumber}
                        </button>
                      );
                    })}
                    <button
                      onClick={() => setCurrentPage(Math.min(totalPages, currentPage + 1))}
                      disabled={currentPage === totalPages}
                      className="relative inline-flex items-center px-2 py-2 rounded-r-md border border-gray-300 bg-white text-sm font-medium text-gray-500 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <span className="sr-only">Next</span>
                      <ChevronRight className="h-5 w-5" />
                    </button>
                  </nav>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {/* Quick Stats Footer */}
      <div className="bg-gradient-to-r from-blue-50 to-purple-50 rounded-lg p-4 border border-blue-200">
        <div className="flex items-center justify-between text-sm">
          <div className="flex items-center space-x-6">
            <div className="flex items-center">
              <FileText className="h-4 w-4 text-blue-600 mr-1" />
              <span className="text-blue-900 font-medium">Total Orders Today: {orders.length}</span>
            </div>
            <div className="flex items-center">
              <AlertTriangle className="h-4 w-4 text-red-600 mr-1" />
              <span className="text-red-900 font-medium">
                Abnormal: {orders.filter(o => (o.abnormalResults || 0) > 0).length}
              </span>
            </div>
          </div>
          <div className="flex items-center">
            <TrendingUp className="h-4 w-4 text-purple-600 mr-1" />
            <span className="text-purple-900 font-medium">
              Avg TAT:{' '}
              {orders.length > 0
                ? Math.round(
                    orders.reduce((sum, o) => {
                      const orderDate = new Date(o.order_date);
                      const now = new Date();
                      const diffHours = (now.getTime() - orderDate.getTime()) / (1000 * 60 * 60);
                      return sum + diffHours;
                    }, 0) / orders.length
                  )
                : 0}
              h
            </span>
          </div>
        </div>
      </div>

      {/* Quick Actions */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <div className="bg-gradient-to-r from-blue-50 to-blue-100 rounded-lg p-6">
          <h3 className="text-lg font-semibold text-blue-900 mb-2">Sample Collection</h3>
          <p className="text-blue-800 text-sm mb-4">
            {orders.filter(o => o.status === 'Sample Collection').length} orders awaiting sample collection
          </p>
          <button className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition-colors">
            View Collection Queue
          </button>
        </div>

        <div className="bg-gradient-to-r from-purple-50 to-purple-100 rounded-lg p-6">
          <h3 className="text-lg font-semibold text-purple-900 mb-2">New Orders</h3>
          <p className="text-purple-800 text-sm mb-4">
            {orders.filter(o => o.status === 'Order Created').length} orders need sample preparation
          </p>
          <button className="bg-purple-600 text-white px-4 py-2 rounded-lg hover:bg-purple-700 transition-colors">
            Plan Collection
          </button>
        </div>

        <div className="bg-gradient-to-r from-orange-50 to-orange-100 rounded-lg p-6">
          <h3 className="text-lg font-semibold text-orange-900 mb-2">In Progress</h3>
          <p className="text-orange-800 text-sm mb-4">
            {orders.filter(o => o.status === 'In Progress').length} tests currently being processed
          </p>
          <button className="bg-orange-600 text-white px-4 py-2 rounded-lg hover:bg-orange-700 transition-colors">
            Process Tests
          </button>
        </div>

        <div className="bg-gradient-to-r from-green-50 to-green-100 rounded-lg p-6">
          <h3 className="text-lg font-semibold text-green-900 mb-2">AI OCR Ready</h3>
          <p className="text-green-800 text-sm mb-4">Use AI to extract results from test images automatically</p>
          <button className="bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 transition-colors">
            AI Tools
          </button>
        </div>
      </div>

      {/* Modals */}
      {showOrderForm && (
        <OrderForm onClose={() => setShowOrderForm(false)} onSubmit={handleAddOrder} preSelectedPatient={preSelectedPatient} />
      )}

      {selectedOrder && (
        <OrderDetailsModal
          order={selectedOrder}
          onClose={() => setSelectedOrder(null)}
          onUpdateStatus={handleUpdateOrderStatus}
          onSubmitResults={handleSubmitOrderResults}
          onOpenManualEntry={handleOpenManualResultEntry}
        />
      )}

      {showManualResultEntry && manualEntryOrder && groupedTestData && activeGroup && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-6xl max-h-[90vh] overflow-hidden">
            {/* Header */}
            <div className="px-6 py-4 border-b border-gray-200 bg-gradient-to-r from-blue-50 to-purple-50">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-2xl font-bold text-gray-900">Manual Result Entry</h2>
                  <p className="text-gray-600">
                    {manualEntryOrder.patient_name} • Order #{(manualEntryOrder.id || '').slice(-6)}
                  </p>
                </div>
                <div className="flex items-center space-x-3">
                  <div className="text-right">
                    <div className="text-sm text-gray-600">Overall Progress</div>
                    <div className="text-lg font-bold text-blue-600">{groupedTestData.overallProgress.percentage}% Complete</div>
                  </div>
                  <button onClick={() => setShowManualResultEntry(false)} className="text-gray-400 hover:text-gray-600">
                    <ChevronUp className="h-6 w-6" />
                  </button>
                </div>
              </div>

              {/* Tabs */}
              <div className="mt-4 flex space-x-2 overflow-x-auto pb-2">
                {groupedTestData.testGroups.map((group, index) => (
                  <button
                    key={group.groupId}
                    onClick={() => setActiveGroupIndex(index)}
                    className={`flex items-center space-x-2 px-4 py-2 rounded-lg whitespace-nowrap transition-colors ${
                      index === activeGroupIndex ? 'bg-blue-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-100'
                    }`}
                  >
                    <span className="font-medium">{group.groupName}</span>
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold ${
                        groupProgress[group.groupId]?.isComplete ? 'bg-green-100 text-green-800' : 'bg-yellow-100 text-yellow-800'
                      }`}
                    >
                      {groupProgress[group.groupId]?.completedAnalytes || 0}/{group.analytes.length}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {/* Body */}
            <div className="p-6 max-h-[60vh] overflow-y-auto">
              {/* Progress bar */}
              <div className="mb-6">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-lg font-semibold text-gray-900">{activeGroup.groupName}</h3>
                  <span
                    className={`px-3 py-1 rounded-full text-sm font-bold ${
                      groupProgress[activeGroup.groupId]?.isComplete ? 'bg-green-100 text-green-800' : 'bg-blue-100 text-blue-800'
                    }`}
                  >
                    {groupProgress[activeGroup.groupId]?.isComplete
                      ? `✓ Complete`
                      : `${groupProgress[activeGroup.groupId]?.completedAnalytes || 0} of ${activeGroup.analytes.length} completed`}
                  </span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-3">
                  <div
                    className={`h-3 rounded-full transition-all duration-300 ${
                      groupProgress[activeGroup.groupId]?.isComplete ? 'bg-green-600' : 'bg-blue-600'
                    }`}
                    style={{ width: `${groupProgress[activeGroup.groupId]?.percentage || 0}%` }}
                  />
                </div>
              </div>

              {/* Analytes */}
              <div className="bg-gray-50 rounded-lg p-4">
                <div className="grid grid-cols-1 gap-4">
                  {activeGroup.analytes.map(analyte => {
                    const currentResult =
                      draftResults[activeGroup.groupId]?.find(r => r.analyteId === analyte.analyteId) || analyte;

                    return (
                      <div key={analyte.analyteId} className="bg-white rounded-lg p-4 border border-gray-200">
                        <div className="grid grid-cols-1 md:grid-cols-5 gap-4 items-center">
                          <div className="md:col-span-1">
                            <label className="block text-sm font-medium text-gray-700 mb-1">{analyte.analyteName}</label>
                            <div className="text-xs text-gray-500">
                              {analyte.referenceRange && `Ref: ${analyte.referenceRange}`}
                            </div>
                          </div>

                          <div className="md:col-span-1">
                            <input
                              type="text"
                              value={currentResult.value}
                              onChange={e =>
                                handleAnalyteValueChange(activeGroup.groupId, analyte.analyteId, 'value', e.target.value)
                              }
                              placeholder="Enter value"
                              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                            />
                          </div>

                          <div className="md:col-span-1">
                            <input
                              type="text"
                              value={currentResult.unit}
                              onChange={e =>
                                handleAnalyteValueChange(activeGroup.groupId, analyte.analyteId, 'unit', e.target.value)
                              }
                              placeholder="Unit"
                              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                            />
                          </div>

                          <div className="md:col-span-1">
                            <select
                              value={currentResult.flag}
                              onChange={e =>
                                handleAnalyteValueChange(
                                  activeGroup.groupId,
                                  analyte.analyteId,
                                  'flag',
                                  e.target.value as AnalyteResult['flag']
                                )
                              }
                              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                            >
                              <option value="">Select flag</option>
                              <option value="normal">Normal</option>
                              <option value="high">High</option>
                              <option value="low">Low</option>
                              <option value="critical">Critical</option>
                            </select>
                          </div>

                          <div className="md:col-span-1 flex justify-center">
                            {currentResult.isEntered ? (
                              <CheckCircle className="h-6 w-6 text-green-600" />
                            ) : (
                              <div className="h-6 w-6 rounded-full border-2 border-gray-300" />
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Pagination */}
                {totalPages > 1 && (
                  <div className="flex items-center justify-between px-4 py-3 bg-white border-t border-gray-200 sm:px-6">
                    <div className="flex justify-between flex-1 sm:hidden">
                      <button
                        onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
                        disabled={currentPage === 1}
                        className="relative inline-flex items-center px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <ChevronLeft className="h-4 w-4 mr-2" />
                        Previous
                      </button>
                      <button
                        onClick={() => setCurrentPage(Math.min(totalPages, currentPage + 1))}
                        disabled={currentPage === totalPages}
                        className="relative ml-3 inline-flex items-center px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        Next
                        <ChevronRight className="h-4 w-4 ml-2" />
                      </button>
                    </div>
                    <div className="hidden sm:flex sm:flex-1 sm:items-center sm:justify-between">
                      <div>
                        <p className="text-sm text-gray-700">
                          Showing <span className="font-medium">{(currentPage - 1) * itemsPerPage + 1}</span> to{' '}
                          <span className="font-medium">{Math.min(currentPage * itemsPerPage, filteredOrders.length)}</span> of{' '}
                          <span className="font-medium">{filteredOrders.length}</span> results
                        </p>
                      </div>
                      <div>
                        <nav className="relative z-0 inline-flex rounded-md shadow-sm -space-x-px" aria-label="Pagination">
                          <button
                            onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
                            disabled={currentPage === 1}
                            className="relative inline-flex items-center px-2 py-2 rounded-l-md border border-gray-300 bg-white text-sm font-medium text-gray-500 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            <span className="sr-only">Previous</span>
                            <ChevronLeft className="h-5 w-5" />
                          </button>
                          {[...Array(totalPages)].map((_, index) => {
                            const pageNumber = index + 1;
                            return (
                              <button
                                key={pageNumber}
                                onClick={() => setCurrentPage(pageNumber)}
                                className={`relative inline-flex items-center px-4 py-2 border text-sm font-medium ${
                                  currentPage === pageNumber
                                    ? 'z-10 bg-blue-50 border-blue-500 text-blue-600'
                                    : 'bg-white border-gray-300 text-gray-500 hover:bg-gray-50'
                                }`}
                              >
                                {pageNumber}
                              </button>
                            );
                          })}
                          <button
                            onClick={() => setCurrentPage(Math.min(totalPages, currentPage + 1))}
                            disabled={currentPage === totalPages}
                            className="relative inline-flex items-center px-2 py-2 rounded-r-md border border-gray-300 bg-white text-sm font-medium text-gray-500 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            <span className="sr-only">Next</span>
                            <ChevronRight className="h-5 w-5" />
                          </button>
                        </nav>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default Orders;
