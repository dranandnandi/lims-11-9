// src/pages/Orders.tsx
import React, { useEffect, useMemo, useState } from "react";
import {
  Plus, Search, Filter, Clock as ClockIcon, CheckCircle, AlertTriangle,
  Eye, User, Calendar, TestTube, ChevronDown, ChevronUp, TrendingUp, ToggleLeft, ToggleRight, X
} from "lucide-react";
import { useAuth } from "../contexts/AuthContext";
import { database, supabase } from "../utils/supabase";
import OrderForm from "../components/Orders/OrderForm";
import OrderDetailsModal from "../components/Orders/OrderDetailsModal";
import EnhancedOrdersPage from "../components/Orders/EnhancedOrdersPage";
import OrderFiltersBar, { OrderFilters } from "../components/Orders/OrderFiltersBar";

/* ===========================
   Types
=========================== */

type OrderStatus =
  | "Order Created"
  | "Sample Collection"
  | "In Progress"
  | "Pending Approval"
  | "Completed"
  | "Delivered";

type Priority = "Normal" | "Urgent" | "STAT";

type ProgressRow = {
  order_id: string;
  test_group_id: string | null;
  test_group_name: string | null;
  expected_analytes: number;
  entered_analytes: number;
  total_values: number;
  has_results: boolean;
  is_verified: boolean;
  panel_status: "Not started" | "In progress" | "Partial" | "Complete" | "Verified";
};

type OrderRow = {
  id: string;
  patient_id: string;
  patient_name: string;
  status: OrderStatus;
  priority: Priority;
  order_date: string;
  expected_date: string;
  total_amount: number;
  doctor: string | null;

  // sample/meta needed by modal
  sample_id: string | null;
  color_code: string | null;
  color_name: string | null;
  sample_collected_at: string | null;
  sample_collected_by: string | null;

  // relations
  patients: { name?: string | null; age?: string | null; gender?: string | null } | null;
  order_tests: { id: string; test_group_id: string | null; test_name: string }[] | null;

  // daily sequence for sorting
  order_number?: number | null;
};

type Panel = {
  name: string;
  expected: number;
  entered: number;     // from view (clamped later)
  verified: boolean;
  status: ProgressRow["panel_status"];
};

type CardOrder = {
  id: string;
  patient_name: string;
  patient_id: string;
  status: OrderStatus;
  priority: Priority;
  order_date: string;
  expected_date: string;
  total_amount: number;
  doctor: string | null;

  order_number?: number | null;

  sample_id: string | null;
  color_code: string | null;
  color_name: string | null;
  sample_collected_at: string | null;
  sample_collected_by: string | null;

  patient?: { name?: string | null; age?: string | null; gender?: string | null } | null;
  tests: string[];

  // derived
  panels: Panel[];
  expectedTotal: number;
  enteredTotal: number;

  // 3-bucket model
  pendingAnalytes: number;       // not started OR partial/in-progress
  forApprovalAnalytes: number;   // complete but not verified
  approvedAnalytes: number;      // verified
};

/* ===========================
   Component
=========================== */

const Orders: React.FC = () => {
  const { user } = useAuth();

  const [orders, setOrders] = useState<CardOrder[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [showOrderForm, setShowOrderForm] = useState(false);
  const [selectedOrder, setSelectedOrder] = useState<CardOrder | null>(null);
  const [viewMode, setViewMode] = useState<'standard' | 'enhanced'>('standard');

  // Filter state
  const [filters, setFilters] = useState<OrderFilters>({
    status: "All",
    priority: "All",
    from: new Date().toISOString().slice(0, 10), // Today's date
    to: new Date().toISOString().slice(0, 10)    // Today's date
  });

  // Add test modal state
  const [showAddTestModal, setShowAddTestModal] = useState(false);
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [availableTests, setAvailableTests] = useState<any[]>([]);
  const [selectedTests, setSelectedTests] = useState<any[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [isLoadingTests, setIsLoadingTests] = useState(false);

  // dashboard counters
  const [summary, setSummary] = useState({ allDone: 0, mostlyDone: 0, pending: 0, awaitingApproval: 0 });

  useEffect(() => {
    fetchOrders();
  }, []);

  // Update selected order when orders change (for modal refresh after status update)
  useEffect(() => {
    if (selectedOrder) {
      const updatedOrder = orders.find(order => order.id === selectedOrder.id);
      if (updatedOrder && (
        updatedOrder.status !== selectedOrder.status ||
        updatedOrder.sample_collected_at !== selectedOrder.sample_collected_at ||
        updatedOrder.sample_collected_by !== selectedOrder.sample_collected_by
      )) {
        console.log(`Updating modal order data: ${selectedOrder.status} → ${updatedOrder.status}`);
        console.log(`Sample collection: ${selectedOrder.sample_collected_at} → ${updatedOrder.sample_collected_at}`);
        setSelectedOrder(updatedOrder);
      }
    }
  }, [orders, selectedOrder]);

  // Fetch tests and packages from database
  const fetchTestsAndPackages = async () => {
    setIsLoadingTests(true);
    try {
      const labId = await database.getCurrentUserLabId();
      if (!labId) {
        console.warn('No lab_id found for user - fetching all available tests for demo purposes');
        // Continue anyway for demo/development purposes
      }

      // Use the centralized database API following project patterns (same as enhanced view)
      const { data: testGroups, error: testGroupsError } = await database.testGroups.getAll();
      if (testGroupsError) {
        console.error('Error fetching test groups:', testGroupsError);
        throw testGroupsError;
      }

      const { data: packages, error: packagesError } = await database.packages.getAll();
      if (packagesError) {
        console.error('Error fetching packages:', packagesError);
        throw packagesError;
      }

      console.log('Fetched test groups:', testGroups?.length || 0);
      console.log('Fetched packages:', packages?.length || 0);

      // Transform test groups to match the expected format
      const transformedTests = (testGroups || []).map(test => ({
        id: test.id,
        name: test.name,
        price: test.price || 0,
        category: test.category || 'Test',
        sample: test.sample_type || 'Various',
        code: test.code || '',
        type: 'test'
      }));

      // Transform packages to match the expected format
      const transformedPackages = (packages || []).map(pkg => ({
        id: pkg.id,
        name: pkg.name,
        price: pkg.price || 0,
        category: 'Package',
        sample: 'Various',
        description: pkg.description || '',
        type: 'package'
      }));

      const allTests = [...transformedTests, ...transformedPackages];
      console.log('Total available tests/packages:', allTests.length);
      setAvailableTests(allTests);
    } catch (error) {
      console.error('Error fetching tests and packages:', error);
      setAvailableTests([]);
    } finally {
      setIsLoadingTests(false);
    }
  };

  useEffect(() => {
    if (user) {
      fetchTestsAndPackages();
    }
  }, [user]);

  const filteredTests = availableTests.filter(test =>
    test.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    test.category.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const toggleTestSelection = (test: any) => {
    setSelectedTests(prev => {
      const isSelected = prev.some(t => t.id === test.id);
      if (isSelected) {
        return prev.filter(t => t.id !== test.id);
      } else {
        return [...prev, test];
      }
    });
  };

  const getTotalPrice = () => {
    return selectedTests.reduce((sum, test) => sum + test.price, 0);
  };

  const handleAddSelectedTests = async () => {
    if (selectedTests.length === 0 || !selectedOrderId) return;
    
    try {
      console.log('Adding tests to order:', selectedOrderId, selectedTests);
      
      // Find the current order to get existing data
      const currentOrder = orders.find(order => order.id === selectedOrderId);
      if (!currentOrder) {
        alert('Order not found');
        return;
      }

      // Create new test records for the order_tests table
      const newOrderTests = selectedTests.map(test => ({
        order_id: selectedOrderId,
        test_name: test.name,
        test_group_id: test.type === 'test' ? test.id : null
      }));
      
      // Insert new tests into order_tests table
      const { error: testsError } = await supabase
        .from('order_tests')
        .insert(newOrderTests);
      
      if (testsError) {
        console.error('Error inserting order tests:', testsError);
        alert('Failed to add tests. Please try again.');
        return;
      }
      
      // Calculate new total amount and update the order
      const newTestsTotal = selectedTests.reduce((sum, test) => sum + test.price, 0);
      const updatedTotalAmount = currentOrder.total_amount + newTestsTotal;
      
      // Update the order's total amount
      const { error: updateError } = await supabase
        .from('orders')
        .update({ total_amount: updatedTotalAmount })
        .eq('id', selectedOrderId);
      
      if (updateError) {
        console.error('Error updating order total:', updateError);
        alert('Tests added but failed to update total amount.');
        return;
      }
      
      console.log('Order updated successfully');
      
      // Reset modal state
      setSelectedTests([]);
      setSearchQuery('');
      setShowAddTestModal(false);
      setSelectedOrderId(null);
      
      // Refresh the orders data
      await fetchOrders();
      
      // Show success message
      alert(`Successfully added ${selectedTests.length} tests to the order! Total cost: ₹${newTestsTotal.toLocaleString()}`);
      
    } catch (error) {
      console.error('Error adding tests:', error);
      alert('Failed to add tests. Please try again.');
    }
  };

  const handleAddTests = (orderId: string) => {
    setSelectedOrderId(orderId);
    setShowAddTestModal(true);
  };

  // Read daily sequence (prefer order_number; fallback to tail of sample_id)
  const getDailySeq = (o: CardOrder) => {
    if (typeof o.order_number === "number" && !Number.isNaN(o.order_number)) return o.order_number;
    const tail = String(o.sample_id || "").split("-").pop() || "";
    const n = parseInt(tail, 10);
    return Number.isFinite(n) ? n : 0;
  };

  const fetchOrders = async () => {
    // Get current user's lab_id
    const lab_id = await database.getCurrentUserLabId();
    if (!lab_id) {
      console.error('No lab_id found for current user');
      return;
    }
    
    // 1) base orders
    const { data: rows, error } = await supabase
      .from("orders")
      .select(`
        id, patient_id, patient_name, status, priority, order_date, expected_date, total_amount, doctor,
        order_number, sample_id, color_code, color_name, sample_collected_at, sample_collected_by,
        patients(name, age, gender),
        order_tests(id, test_group_id, test_name)
      `)
      .eq('lab_id', lab_id)
      .order("order_date", { ascending: false });

    if (error) {
      console.error("orders load error", error);
      return;
    }

    const orderRows = (rows || []) as OrderRow[];
    const orderIds = orderRows.map((o) => o.id);
    if (orderIds.length === 0) {
      setOrders([]);
      return;
    }

    // 2) view-based progress
    const { data: prog, error: pErr } = await supabase
      .from("v_order_test_progress")
      .select("*")
      .in("order_id", orderIds);

    if (pErr) console.error("progress view error", pErr);

    const byOrder = new Map<string, ProgressRow[]>();
    (prog || []).forEach((r) => {
      const arr = byOrder.get(r.order_id) || [];
      arr.push(r as ProgressRow);
      byOrder.set(r.order_id, arr);
    });

    // 3) shape cards with new buckets
    const cards: CardOrder[] = orderRows.map((o) => {
      const rows = byOrder.get(o.id) || [];
      const panels: Panel[] = rows.map((r) => ({
        name: r.test_group_name || "Test",
        expected: r.expected_analytes || 0,
        entered: r.entered_analytes || 0,
        verified: !!r.is_verified,
        status: r.panel_status,
      }));

      // Calculate totals correctly
      const expectedTotal = panels.reduce((sum, p) => sum + p.expected, 0);
      const enteredTotal = panels.reduce((sum, p) => sum + Math.min(p.entered, p.expected), 0);
      
      // ✅ Fix: Calculate approved analytes correctly
      // Only count analytes from verified panels, not entire expected total
      const approvedAnalytes = panels.reduce((sum, p) => {
        if (p.verified || p.status === "Verified") {
          return sum + Math.min(p.entered, p.expected); // Only count entered analytes that are verified
        }
        return sum;
      }, 0);

      // ✅ Fix: Calculate pending and for-approval correctly
      const pendingAnalytes = Math.max(expectedTotal - enteredTotal, 0); // Not entered yet
      const forApprovalAnalytes = Math.max(enteredTotal - approvedAnalytes, 0); // Entered but not verified

      // Debug logging for verification (can be removed later)
      if (o.id && expectedTotal > 0) {
        console.debug(`Order ${o.id.slice(-6)}: Expected=${expectedTotal}, Entered=${enteredTotal}, Approved=${approvedAnalytes}, Pending=${pendingAnalytes}, ForApproval=${forApprovalAnalytes}`);
      }

      return {
        id: o.id,
        patient_name: o.patient_name,
        patient_id: o.patient_id,
        status: o.status,
        priority: o.priority,
        order_date: o.order_date,
        expected_date: o.expected_date,
        total_amount: o.total_amount,
        doctor: o.doctor,

        order_number: o.order_number ?? null,
        sample_id: o.sample_id,
        color_code: o.color_code,
        color_name: o.color_name,
        sample_collected_at: o.sample_collected_at,
        sample_collected_by: o.sample_collected_by,

        patient: o.patients,
        tests: (o.order_tests || []).map((t) => t.test_name),

        panels,
        expectedTotal,
        enteredTotal,
        pendingAnalytes,
        forApprovalAnalytes,
        approvedAnalytes,
      };
    });

    // sort: date DESC, then daily seq DESC (002 above 001)
    const sorted = cards.sort((a, b) => {
      const dA = new Date(a.order_date).setHours(0,0,0,0);
      const dB = new Date(b.order_date).setHours(0,0,0,0);
      if (dA !== dB) return dB - dA;
      const nA = getDailySeq(a);
      const nB = getDailySeq(b);
      return nB - nA;
    });

    // dashboard summary (kept)
    const s = sorted.reduce(
      (acc, o) => {
        if (o.status === "Completed" || o.status === "Delivered") acc.allDone++;
        else if (o.status === "Pending Approval") acc.awaitingApproval++;
        else if (o.enteredTotal > 0 && o.enteredTotal >= o.expectedTotal * 0.75) acc.mostlyDone++;
        else acc.pending++;
        return acc;
      },
      { allDone: 0, mostlyDone: 0, pending: 0, awaitingApproval: 0 }
    );

    setOrders(sorted);
    setSummary(s);
  };

  /* ------------- filtering + grouping ------------- */
  const filtered = useMemo(() => {
    const q = (filters.q || "").toLowerCase();
    return orders.filter((o) => {
      // Search filter
      const matchesQ = !filters.q ||
        o.patient_name.toLowerCase().includes(q) ||
        (o.patient_id || "").toLowerCase().includes(q) ||
        (o.id || "").toLowerCase().includes(q) ||
        (o.doctor || "").toLowerCase().includes(q);

      // Status filter
      const matchesStatus = !filters.status || filters.status === "All" || o.status === filters.status;

      // Priority filter
      const matchesPriority = !filters.priority || filters.priority === "All" || o.priority === filters.priority;

      // Date range filter
      const matchesDateRange = () => {
        if (!filters.from && !filters.to) return true;
        const orderDate = new Date(o.order_date);
        const fromDate = filters.from ? new Date(filters.from) : null;
        const toDate = filters.to ? new Date(filters.to) : null;
        
        if (fromDate && orderDate < fromDate) return false;
        if (toDate && orderDate > toDate) return false;
        return true;
      };

      // Doctor filter
      const matchesDoctor = !filters.doctor || 
        (o.doctor || "").toLowerCase().includes((filters.doctor || "").toLowerCase());

      return matchesQ && matchesStatus && matchesPriority && matchesDateRange() && matchesDoctor;
    });
  }, [orders, filters]);

  // Calculate order counts for filter bar
  const orderCounts = useMemo(() => {
    const total = orders.length;
    const byStatus: Record<string, number> = {};
    const byPriority: Record<string, number> = {};

    orders.forEach(order => {
      byStatus[order.status] = (byStatus[order.status] || 0) + 1;
      byPriority[order.priority] = (byPriority[order.priority] || 0) + 1;
    });

    return {
      total,
      byStatus,
      byPriority
    };
  }, [orders]);

  // Calculate filtered summary stats that update based on filters
  const filteredSummary = useMemo(() => {
    return filtered.reduce(
      (acc, o) => {
        if (o.status === "Completed" || o.status === "Delivered") acc.allDone++;
        else if (o.status === "Pending Approval") acc.awaitingApproval++;
        else if (o.enteredTotal > 0 && o.enteredTotal >= o.expectedTotal * 0.75) acc.mostlyDone++;
        else acc.pending++;
        return acc;
      },
      { allDone: 0, mostlyDone: 0, pending: 0, awaitingApproval: 0 }
    );
  }, [filtered]);

  // Transform orders for EnhancedOrdersPage
  const transformedOrdersForEnhanced = useMemo(() => {
    return filtered.map(order => ({
      id: order.id,
      patient_id: order.patient_id,
      patient_name: order.patient_name,
      status: order.status,
      total_amount: order.total_amount,
      order_date: order.order_date,
      created_at: order.order_date,
      sample_id: order.sample_id || undefined,
      tests: order.tests,
      can_add_tests: !['Completed', 'Delivered'].includes(order.status),
      visit_group_id: order.sample_id ? `sample-${order.sample_id}` : `${order.patient_id}-${order.order_date.slice(0, 10)}`,
      order_type: 'initial' as const
    }));
  }, [filtered]);

  type Group = { key: string; label: string; orders: CardOrder[] };
  const groups: Group[] = useMemo(() => {
    const map = new Map<string, { date: Date; orders: CardOrder[] }>();
    filtered.forEach((o) => {
      const d = new Date(o.order_date);
      d.setHours(0, 0, 0, 0);
      const k = d.toISOString().slice(0, 10);
      map.set(k, map.get(k) || { date: d, orders: [] });
      map.get(k)!.orders.push(o);
    });

    return Array.from(map.entries())
      .sort((a, b) => b[1].date.getTime() - a[1].date.getTime())
      .map(([key, v]) => ({
        key,
        label: v.date.toLocaleDateString("en-IN", {
          weekday: "long",
          day: "numeric",
          month: "long",
          year: "numeric",
        }),
        orders: v.orders.sort((a, b) => {
          const nA = getDailySeq(a);
          const nB = getDailySeq(b);
          if (nA !== nB) return nB - nA;
          return new Date(b.order_date).getTime() - new Date(a.order_date).getTime();
        }),
      }));
  }, [filtered]);

  const openDetails = (o: CardOrder) => setSelectedOrder(o);

  // Enhanced view handlers
  const handleAddOrder = async (orderData: any) => {
    try {
      console.log('Creating new order:', orderData);
      console.log('Tests array:', orderData.tests, 'Length:', orderData.tests?.length);
      console.log('Test objects structure:', orderData.tests?.[0]);
      
      // Create the order in the database
      const { data: order, error: orderError } = await database.orders.create(orderData);
      if (orderError) {
        console.error('Error creating order:', orderError);
        alert('Failed to create order. Please try again.');
        return;
      }
      
      console.log('Order created successfully:', order);
      
      // Refresh the orders list
      await fetchOrders();
      
      // Close the form
      setShowOrderForm(false);
      
      // Show success message
      alert('Order created successfully!');
    } catch (error) {
      console.error('Error creating order:', error);
      alert('Failed to create order. Please try again.');
    }
  };

  const handleUpdateStatus = async () => {
    // Centralized components perform the update; here we only refresh data
    await fetchOrders();
  };

  const handleNewSession = () => {
    setShowOrderForm(true);
  };

  const handleNewPatientVisit = () => {
    setShowOrderForm(true);
  };

  // If enhanced view is selected, render EnhancedOrdersPage
  if (viewMode === 'enhanced') {
    return (
      <div className="space-y-6">
        {/* View Mode Toggle */}
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-4">
            <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Test Orders</h1>
            <div className="flex items-center space-x-2 bg-gray-100 rounded-lg p-1">
              <button
                onClick={() => setViewMode('standard')}
                className={`flex items-center px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  viewMode === 'standard' 
                    ? 'bg-white text-blue-600 shadow-sm' 
                    : 'text-gray-600 hover:text-gray-800'
                }`}
              >
                <ToggleLeft className="h-4 w-4 mr-1" />
                Standard View
              </button>
              <button
                onClick={() => setViewMode('enhanced')}
                className={`flex items-center px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  viewMode === 'enhanced' 
                    ? 'bg-white text-blue-600 shadow-sm' 
                    : 'text-gray-600 hover:text-gray-800'
                }`}
              >
                <ToggleRight className="h-4 w-4 mr-1" />
                Patient Visits
              </button>
            </div>
          </div>
        </div>

        {/* Filters Bar */}
        <OrderFiltersBar
          value={filters}
          onChange={setFilters}
          orderCounts={orderCounts}
        />

        <EnhancedOrdersPage
          orders={transformedOrdersForEnhanced}
          onAddOrder={handleAddOrder}
          onUpdateStatus={handleUpdateStatus}
          onRefreshOrders={fetchOrders}
          onNewSession={handleNewSession}
          onNewPatientVisit={handleNewPatientVisit}
        />

        {/* Modals */}
        {showOrderForm && (
          <OrderForm 
            onClose={() => setShowOrderForm(false)} 
            onSubmit={handleAddOrder}
          />
        )}

        {selectedOrder && (
          <OrderDetailsModal
            order={selectedOrder}
            onClose={() => setSelectedOrder(null)}
            onUpdateStatus={handleUpdateStatus}
            onSubmitResults={async (orderId: string, resultsData: any[]) => {
              console.log('onSubmitResults called');
              await fetchOrders();
              setSelectedOrder(null);
            }}
          />
        )}
      </div>
    );
  }

  /* ===========================
     Standard UI
  =========================== */

  return (
    <div className="space-y-6">
      {/* Header with View Mode Toggle */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center space-x-4">
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Test Orders</h1>
          <div className="flex items-center space-x-2 bg-gray-100 rounded-lg p-1">
            <button
              onClick={() => setViewMode('standard')}
              className={`flex items-center px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                viewMode === 'standard' 
                  ? 'bg-white text-blue-600 shadow-sm' 
                  : 'text-gray-600 hover:text-gray-800'
              }`}
            >
              <ToggleLeft className="h-4 w-4 mr-1" />
              Standard View
            </button>
            <button
              onClick={() => setViewMode('enhanced')}
              className={`flex items-center px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                viewMode === 'enhanced' 
                  ? 'bg-white text-blue-600 shadow-sm' 
                  : 'text-gray-600 hover:text-gray-800'
              }`}
            >
              <ToggleRight className="h-4 w-4 mr-1" />
              Patient Visits
            </button>
          </div>
        </div>
        <button
          onClick={() => setShowOrderForm(true)}
          className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
        >
          <Plus className="h-5 w-5 mr-2" />
          Create Order
        </button>
      </div>

      {/* Overview cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-green-50 border border-green-200 rounded-lg p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-2xl font-bold text-green-900">{filteredSummary.allDone}</div>
              <div className="text-sm text-green-700">All Done</div>
            </div>
            <div className="bg-green-500 p-2 rounded-lg">
              <CheckCircle className="h-5 w-5 text-white" />
            </div>
          </div>
        </div>
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-2xl font-bold text-blue-900">{filteredSummary.mostlyDone}</div>
              <div className="text-sm text-blue-700">Mostly Done</div>
            </div>
            <div className="bg-blue-500 p-2 rounded-lg">
              <TrendingUp className="h-5 w-5 text-white" />
            </div>
          </div>
        </div>
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-2xl font-bold text-yellow-900">{filteredSummary.pending}</div>
              <div className="text-sm text-yellow-700">Pending</div>
            </div>
            <div className="bg-yellow-500 p-2 rounded-lg">
              <ClockIcon className="h-5 w-5 text-white" />
            </div>
          </div>
        </div>
        <div className="bg-orange-50 border border-orange-200 rounded-lg p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-2xl font-bold text-orange-900">{filteredSummary.awaitingApproval}</div>
              <div className="text-sm text-orange-700">Awaiting Approval</div>
            </div>
            <div className="bg-orange-500 p-2 rounded-lg">
              <AlertTriangle className="h-5 w-5 text-white" />
            </div>
          </div>
        </div>
      </div>

      {/* Filters Bar */}
      <OrderFiltersBar
        value={filters}
        onChange={setFilters}
        orderCounts={orderCounts}
      />

      {/* Groups + Cards */}
      <div className="bg-white rounded-lg border border-gray-200">
        <div className="px-6 py-4 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900">Test Orders ({filtered.length})</h3>
        </div>

        {groups.length === 0 ? (
          <div className="text-center py-12">
            <TestTube className="h-12 w-12 text-gray-300 mx-auto mb-3" />
            <p className="text-gray-600">No Orders Found</p>
          </div>
        ) : (
          <div className="space-y-8">
            {groups.map((g) => (
              <div key={g.key} className="px-6">
                <div className="flex items-center justify-between py-4 border-b-2 mb-6 border-gray-200">
                  <h4 className="text-lg font-semibold text-gray-700">{g.label}</h4>
                  <div className="text-sm text-gray-500">{g.orders.length} order{g.orders.length !== 1 ? "s" : ""}</div>
                </div>

                <div className="space-y-4">
                  {g.orders.map((o) => {
                    const pct = o.expectedTotal > 0 ? Math.round((o.enteredTotal / o.expectedTotal) * 100) : 0;
                    const canAddTests = !['Completed', 'Delivered'].includes(o.status);
                    
                    return (
                      <div
                        key={o.id}
                        role="button"
                        onClick={() => openDetails(o)}
                        className="w-full p-4 border-2 rounded-lg hover:shadow-md transition-all cursor-pointer border-gray-200 bg-white"
                      >
                        {/* Top row */}
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex items-center gap-3">
                            <div className="flex items-center justify-center w-8 h-8 bg-blue-100 text-blue-700 rounded-full font-bold text-sm border-2 border-blue-200">
                              {String(getDailySeq(o)).padStart(3, "0")}
                            </div>
                            <div className="flex items-center gap-3">
                              <User className="h-6 w-6 text-blue-600 shrink-0" />
                              <div>
                                <div className="text-xl sm:text-2xl font-bold text-gray-900">
                                  {o.patient?.name || o.patient_name}
                                </div>
                                <div className="text-sm sm:text-base text-gray-700">
                                  {(o.patient?.age || "N/A") + "y"} • {o.patient?.gender || "N/A"} • ID: {o.patient_id}
                                </div>
                              </div>
                            </div>
                          </div>

                          <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                            <span className="inline-flex items-center px-3 py-1.5 rounded-lg text-sm font-bold border-2 bg-blue-100 text-blue-800 border-blue-200">
                              ● {o.status === "In Progress" ? "In Process" : o.status}
                            </span>
                            <button
                              className="p-2 text-gray-600 hover:bg-gray-100 rounded-lg"
                              onClick={() => setExpanded((prev) => ({ ...prev, [o.id]: !prev[o.id] }))}
                            >
                              {expanded[o.id] ? <ChevronUp className="h-5 w-5" /> : <ChevronDown className="h-5 w-5" />}
                            </button>
                          </div>
                        </div>

                        {/* Middle: sample + tests */}
                        <div className="mt-3 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3 bg-gray-50 rounded-lg p-3">
                          <div className="flex flex-col sm:flex-row sm:items-center gap-6">
                            <div className="min-w-[110px]">
                              <div className="text-xs text-gray-600">Order</div>
                              <div className="font-bold text-gray-900">#{(o.id || "").slice(-6)}</div>
                            </div>

                            {o.sample_id && (
                              <div className="flex items-center gap-2">
                                <div
                                  className="w-8 h-8 rounded-full border-2 border-white shadow-md flex items-center justify-center text-white font-bold text-xs"
                                  style={{ backgroundColor: o.color_code || "#8B5CF6" }}
                                  title={`Sample Tube: ${o.color_name || "Tube"}`}
                                >
                                  {(o.color_name || "Tube").charAt(0)}
                                </div>
                                <div>
                                  <div className="text-xs text-gray-600">Sample</div>
                                  <div className="font-mono font-bold text-gray-900 text-sm">
                                    {String(o.sample_id).split("-").pop()}
                                  </div>
                                </div>
                              </div>
                            )}

                            <div className="flex-1">
                              <div className="text-sm text-gray-600 mb-1">Tests ({o.tests.length})</div>
                              <div className="flex flex-wrap gap-3">
                                {o.panels.length > 0
                                  ? o.panels.map((p, i) => {
                                      const progress = p.expected > 0 ? (p.entered / p.expected) * 100 : 0;
                                      
                                      // Modern minimalistic colors based on progress
                                      const getMinimalColor = (percent: number) => {
                                        if (percent === 0) return "bg-gray-100 border-gray-300 text-gray-700";
                                        if (percent < 40) return "bg-red-50 border-red-200 text-red-800";
                                        if (percent < 70) return "bg-orange-50 border-orange-200 text-orange-800";
                                        if (percent < 90) return "bg-yellow-50 border-yellow-200 text-yellow-800";
                                        return "bg-green-50 border-green-200 text-green-800";
                                      };

                                      const colorClass = getMinimalColor(progress);

                                      return (
                                        <div
                                          key={`${p.name}-${i}`}
                                          className={`border rounded-lg px-3 py-2 transition-all duration-300 ${colorClass}`}
                                        >
                                          <div className="font-medium text-sm mb-1">{p.name}</div>
                                          <div className="flex items-center justify-between text-xs">
                                            <span className="font-mono">
                                              {p.entered}/{p.expected} analytes
                                            </span>
                                            <span className="text-xs opacity-75">
                                              {progress === 0 ? "Pending" : progress < 100 ? "Partial" : "Complete"}
                                            </span>
                                          </div>
                                        </div>
                                      );
                                    })
                                  : o.tests.map((t, i) => (
                                      <span key={i} className="px-2 py-1 rounded text-sm bg-blue-100 text-blue-800">
                                        {t}
                                      </span>
                                    ))}
                              </div>
                            </div>
                          </div>

                          <div className="text-right">
                            <div className="text-xl sm:text-2xl font-bold text-green-600">
                              ₹{Number(o.total_amount || 0).toLocaleString()}
                            </div>
                            <div className="text-sm text-gray-600">
                              <div>Ordered: {new Date(o.order_date).toLocaleDateString()}</div>
                              <div className={`${new Date(o.expected_date) < new Date() ? "text-red-600 font-bold" : ""}`}>
                                Expected: {new Date(o.expected_date).toLocaleDateString()}
                                {new Date(o.expected_date) < new Date() && " ⚠️ OVERDUE"}
                              </div>
                            </div>

                            {/* Updated button section with Add Tests functionality */}
                            <div className="mt-3 flex flex-col sm:flex-row gap-2">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  openDetails(o);
                                }}
                                className="inline-flex items-center px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                              >
                                <Eye className="h-4 w-4 mr-1" />
                                View Full Details
                              </button>
                              
                              {canAddTests && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleAddTests(o.id);
                                  }}
                                  className="inline-flex items-center px-3 py-1.5 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700"
                                >
                                  <Plus className="h-4 w-4 mr-1" />
                                  Add Tests
                                </button>
                              )}
                            </div>
                          </div>
                        </div>

                        {/* Enhanced Progress + legend */}
                        <div className="mt-3 bg-gradient-to-r from-blue-50 to-indigo-50 rounded-lg p-3 border border-blue-200">
                          <div className="flex items-center justify-between text-sm mb-2">
                            <span className="text-blue-800 font-semibold flex items-center">
                              📊 Overall Progress
                            </span>
                            <span className="text-blue-800 font-bold text-base">
                              {o.enteredTotal}/{o.expectedTotal} analytes
                            </span>
                          </div>
                          
                          {/* Enhanced progress bar with dynamic colors and segments */}
                          <div className="relative w-full bg-gray-200 rounded-full h-4 mb-3 overflow-hidden border">
                            {/* Background gradient based on overall progress */}
                            <div 
                              className="absolute left-0 top-0 h-4 transition-all duration-700 rounded-full"
                              style={{ 
                                width: `${pct}%`,
                                background: pct === 0 ? '#ef4444' : // red
                                           pct < 25 ? `linear-gradient(90deg, #ef4444 0%, #f97316 100%)` : // red to orange
                                           pct < 50 ? `linear-gradient(90deg, #f97316 0%, #eab308 100%)` : // orange to yellow  
                                           pct < 75 ? `linear-gradient(90deg, #eab308 0%, #84cc16 100%)` : // yellow to lime
                                           pct < 100 ? `linear-gradient(90deg, #84cc16 0%, #22c55e 100%)` : // lime to green
                                           '#10b981', // emerald
                                boxShadow: pct > 0 ? `0 0 12px ${pct < 50 ? '#ef444440' : '#22c55e40'}` : 'none'
                              }}
                            />
                            
                            {/* Approved segment overlay (darker green) */}
                            <div 
                              className="absolute left-0 top-0 h-4 bg-green-600 transition-all duration-500 rounded-full opacity-80"
                              style={{ width: `${o.expectedTotal > 0 ? (o.approvedAnalytes / o.expectedTotal) * 100 : 0}%` }}
                            />
                            
                            {/* Progress indicator line */}
                            <div 
                              className="absolute top-0 w-0.5 h-4 bg-white shadow-lg"
                              style={{ left: `${pct}%` }}
                            />
                            
                            {/* Sparkle effect for high progress */}
                            {pct > 75 && (
                              <div className="absolute inset-0 rounded-full opacity-30">
                                <div className="absolute top-1 left-1/4 w-1 h-1 bg-white rounded-full animate-pulse" />
                                <div className="absolute top-2 right-1/3 w-0.5 h-0.5 bg-white rounded-full animate-pulse delay-150" />
                                <div className="absolute bottom-1 left-2/3 w-1 h-1 bg-white rounded-full animate-pulse delay-300" />
                              </div>
                            )}
                          </div>
                          
                          {/* Enhanced legend with better spacing and icons */}
                          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 text-sm">
                            <div className="inline-flex items-center bg-white rounded-md px-2 py-1 border border-gray-200">
                              <span className="inline-block w-3 h-3 bg-red-400 rounded-full mr-2 shadow-sm" /> 
                              <span className="text-gray-700">Pending: <strong>{o.pendingAnalytes}</strong></span>
                            </div>
                            <div className="inline-flex items-center bg-white rounded-md px-2 py-1 border border-amber-200">
                              <span className="inline-block w-3 h-3 bg-amber-500 rounded-full mr-2 shadow-sm" /> 
                              <span className="text-amber-700">For approval: <strong>{o.forApprovalAnalytes}</strong></span>
                            </div>
                            <div className="inline-flex items-center bg-white rounded-md px-2 py-1 border border-green-200">
                              <span className="inline-block w-3 h-3 bg-green-500 rounded-full mr-2 shadow-sm" /> 
                              <span className="text-green-700">Approved: <strong>{o.approvedAnalytes}</strong></span>
                            </div>
                            <div className="inline-flex items-center bg-white rounded-md px-2 py-1 border border-blue-200 lg:justify-end">
                              <span className={`font-bold ${pct < 25 ? 'text-red-600' : pct < 50 ? 'text-orange-600' : pct < 75 ? 'text-yellow-600' : pct < 100 ? 'text-lime-600' : 'text-green-600'}`}>
                                {pct < 25 ? '🔴' : pct < 50 ? '🟠' : pct < 75 ? '🟡' : pct < 100 ? '🟢' : '✅'} Total: {o.expectedTotal}
                              </span>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer stats */}
      <div className="bg-gradient-to-r from-blue-50 to-purple-50 rounded-lg p-4 border border-blue-200">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-sm">
          <div className="flex items-center gap-6">
            <div className="flex items-center">
              <Calendar className="h-4 w-4 text-blue-600 mr-1" />
              <span className="text-blue-900 font-medium">Total Orders: {orders.length}</span>
            </div>
            <div className="flex items-center">
              <AlertTriangle className="h-4 w-4 text-red-600 mr-1" />
              <span className="text-red-900 font-medium">
                Overdue: {orders.filter((o) => new Date(o.expected_date) < new Date()).length}
              </span>
            </div>
          </div>
          <div className="flex items-center">
            <TrendingUp className="h-4 w-4 text-purple-600 mr-1" />
            <span className="text-purple-900 font-medium">
              Avg TAT:{" "}
              {orders.length
                ? Math.round(
                    orders.reduce((sum, o) => {
                      const diffHrs = (Date.now() - new Date(o.order_date).getTime()) / 36e5;
                      return sum + diffHrs;
                    }, 0) / orders.length
                  )
                : 0}
              h
            </span>
          </div>
        </div>
      </div>

      {/* Modals */}
      {showOrderForm && (
        <OrderForm 
          onClose={() => setShowOrderForm(false)} 
          onSubmit={handleAddOrder}
        />
      )}

      {selectedOrder && (
        <OrderDetailsModal
          order={selectedOrder}
          onClose={() => setSelectedOrder(null)}
          onUpdateStatus={async () => {
            await fetchOrders();
            setSelectedOrder(null);
          }}
          onAfterSubmit={async () => {
            await fetchOrders();
            setSelectedOrder(null);
          }}
          onAfterSaveDraft={async () => {
            await fetchOrders();
          }}
        />
      )}

      {/* Add Test Selection Modal */}
      {showAddTestModal && selectedOrderId && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-75 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl max-h-[90vh] overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-200 bg-blue-50">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold text-gray-900">Add Tests to Order</h3>
                <button
                  onClick={() => {
                    setShowAddTestModal(false);
                    setSelectedOrderId(null);
                    setSelectedTests([]);
                    setSearchQuery('');
                  }}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <X className="h-6 w-6" />
                </button>
              </div>
              <p className="text-sm text-gray-600 mt-1">
                Order ID: {selectedOrderId?.slice(-6)} • Select tests to add to this order
              </p>
            </div>

            <div className="p-6 overflow-y-auto max-h-[60vh]">
              {/* Search */}
              <div className="mb-4">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search tests and packages..."
                    className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
              </div>

              {/* Loading state */}
              {isLoadingTests ? (
                <div className="text-center py-8">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto"></div>
                  <p className="text-gray-600 mt-2">Loading tests...</p>
                </div>
              ) : (
                /* Tests grid */
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-h-96 overflow-y-auto">
                  {filteredTests.map((test) => {
                    const isSelected = selectedTests.some(t => t.id === test.id);
                    return (
                      <div
                        key={test.id}
                        onClick={() => toggleTestSelection(test)}
                        className={`p-3 border-2 rounded-lg cursor-pointer transition-all ${
                          isSelected
                            ? 'border-blue-500 bg-blue-50'
                            : 'border-gray-200 hover:border-gray-300'
                        }`}
                      >
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <h4 className="font-medium text-gray-900">{test.name}</h4>
                            <p className="text-sm text-gray-600">
                              {test.category} • {test.sample}
                            </p>
                            {test.code && (
                              <p className="text-xs text-gray-500 font-mono">{test.code}</p>
                            )}
                          </div>
                          <div className="text-right ml-3">
                            <div className="font-bold text-green-600">₹{test.price.toLocaleString()}</div>
                            {isSelected && (
                              <div className="text-xs text-blue-600 font-medium">✓ Selected</div>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {filteredTests.length === 0 && !isLoadingTests && (
                <div className="text-center py-8">
                  <TestTube className="h-12 w-12 text-gray-300 mx-auto mb-3" />
                  <p className="text-gray-600">No tests found matching your search</p>
                </div>
              )}
            </div>

            {/* Selected tests summary and actions */}
            {selectedTests.length > 0 && (
              <div className="px-6 py-4 border-t border-gray-200 bg-gray-50">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <p className="text-sm font-medium text-gray-900">
                      {selectedTests.length} test{selectedTests.length !== 1 ? 's' : ''} selected
                    </p>
                    <p className="text-lg font-bold text-green-600">
                      Total: ₹{getTotalPrice().toLocaleString()}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setSelectedTests([])}
                      className="px-4 py-2 text-sm text-gray-600 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
                    >
                      Clear All
                    </button>
                    <button
                      onClick={handleAddSelectedTests}
                      className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                    >
                      Add Selected Tests
                    </button>
                  </div>
                </div>

                {/* Selected tests list */}
                <div className="flex flex-wrap gap-2">
                  {selectedTests.map((test) => (
                    <span
                      key={test.id}
                      className="inline-flex items-center px-2 py-1 text-xs bg-blue-100 text-blue-800 rounded-full"
                    >
                      {test.name}
                      <button
                        onClick={() => toggleTestSelection(test)}
                        className="ml-1 text-blue-600 hover:text-blue-800"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default Orders;
