// ==========================================================
// Orders.tsx
// Purpose: Listing + lightweight kanban features + open modal
// Notes:
// - Click ANYWHERE on a card opens details (short view keeps "View Full Details" button too)
// - Wires OrderDetailsModal with onAfterSubmit to refresh + close (P0)
// ==========================================================

import React, { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import {
  Plus, Search, Filter, Clock as ClockIcon, CheckCircle, AlertTriangle,
  Eye, User, Calendar, TestTube, ChevronDown, ChevronUp, Paperclip,
  TrendingUp, Send
} from "lucide-react";
import { useAuth } from "../contexts/AuthContext";
import { database } from "../utils/supabase";
import OrderForm from "../components/Orders/OrderForm";
import OrderDetailsModal from "../components/Orders/OrderDetailsModal";
import EnhancedOrders from "../components/Orders/EnhancedOrdersPage";

// ----------------------------------------------------------
// [BLOCK A] Types
// ----------------------------------------------------------
type OrderStatus =
  | "Order Created"
  | "Sample Collection"
  | "In Progress"
  | "Pending Approval"
  | "Completed"
  | "Delivered";

type Priority = "Normal" | "Urgent" | "STAT";

interface Order {
  id: string;
  patient_name: string;
  patient_id: string;
  tests: string[];
  status: OrderStatus;
  priority: Priority;
  order_date: string;
  expected_date: string;
  total_amount: number;
  doctor: string;
  // sample meta
  sample_id?: string;
  color_code?: string;
  color_name?: string;
  qr_code_data?: string;
  sample_collected_at?: string;
  sample_collected_by?: string;
  // computed (client)
  totalTests: number;
  completedResults: number;
  abnormalResults: number;
  hasAttachments: boolean;
  patient?: {
    name?: string;
    age?: string;
    gender?: string;
  };
}

// ----------------------------------------------------------
// [BLOCK B] Component
// ----------------------------------------------------------
const Orders: React.FC = () => {
  const location = useLocation() as any;
  const preSelectedPatient = location?.state?.selectedPatient;
  const { user } = useAuth();

  // ----- view state
  const [viewMode, setViewMode] = useState<"traditional" | "patient-centric">("traditional");
  const [orders, setOrders] = useState<Order[]>([]);
  const [expandedOrders, setExpandedOrders] = useState<Record<string, boolean>>({});
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedStatus, setSelectedStatus] = useState<"All" | OrderStatus>("All");
  const [selectedCompletion, setSelectedCompletion] =
    useState<"All" | "All Done" | "Mostly Done" | "Pending" | "Awaiting Approval">("All");
  const [showOrderForm, setShowOrderForm] = useState(false);
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);

  // dashboard counters
  const [completionSummary, setCompletionSummary] = useState({
    allDone: 0,
    mostlyDone: 0,
    pending: 0,
    awaitingApproval: 0
  });

  // --------------------------------------------------------
  // [BLOCK C] Data load + shape
  // --------------------------------------------------------
  useEffect(() => {
    fetchOrders();
    if (preSelectedPatient) setShowOrderForm(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preSelectedPatient]);

  const fetchOrders = async () => {
    try {
      const { data, error } = await database.orders.getAll();
      if (error) {
        console.error("Error loading orders:", error);
        return;
      }

      const formatted = (data || []).map((o: any): Order => {
        const totalTests = o.order_tests?.length || o.tests?.length || 0;
        const completedResults =
          o.results?.filter((r: any) => r.status === "Approved" || r.status === "Reported")?.length || 0;
        const abnormalResults =
          o.results?.filter((r: any) => r.result_values?.some((rv: any) => rv.flag && rv.flag !== ""))?.length || 0;

        return {
          ...o,
          tests: o.order_tests ? o.order_tests.map((t: any) => t.test_name) : (o.tests || []),
          patient: o.patients,
          totalTests,
          completedResults,
          abnormalResults,
          hasAttachments: !!(o.attachments?.length)
        };
      });

      // newest sample number first, fallback date
      const sorted = formatted.sort((a, b) => {
        const num = (x: Order) => parseInt((x.sample_id || "").match(/-(\d+)$/)?.[1] || "0", 10);
        const nA = num(a), nB = num(b);
        if (nA !== nB) return nB - nA;
        return new Date(b.order_date).getTime() - new Date(a.order_date).getTime();
      });

      const summary = sorted.reduce((acc, o) => {
        if (o.status === "Completed" || o.status === "Delivered") acc.allDone++;
        else if (o.status === "Pending Approval") acc.awaitingApproval++;
        else if (o.completedResults > 0 && o.completedResults >= (o.totalTests || o.tests.length) * 0.75) acc.mostlyDone++;
        else acc.pending++;
        return acc;
      }, { allDone: 0, mostlyDone: 0, pending: 0, awaitingApproval: 0 });

      setOrders(sorted);
      setCompletionSummary(summary);

      // keep modal in sync if open
      setSelectedOrder(prev => prev ? sorted.find(o => o.id === prev.id) ?? prev : null);
    } catch (e) {
      console.error(e);
    }
  };

  // --------------------------------------------------------
  // [BLOCK D] Filtering + grouping
  // --------------------------------------------------------
  const filteredOrders = useMemo(() => {
    return orders.filter(o => {
      const q = searchTerm.toLowerCase();
      const matchesQ =
        (o.patient_name || "").toLowerCase().includes(q) ||
        (o.id || "").toLowerCase().includes(q) ||
        (o.patient_id || "").toLowerCase().includes(q);

      const matchesStatus = selectedStatus === "All" || o.status === selectedStatus;

      let matchesCompletion = true;
      if (selectedCompletion !== "All") {
        switch (selectedCompletion) {
          case "All Done":
            matchesCompletion = o.status === "Completed" || o.status === "Delivered";
            break;
          case "Mostly Done":
            matchesCompletion =
              o.completedResults > 0 &&
              o.completedResults >= (o.totalTests || o.tests.length) * 0.75 &&
              !["Completed", "Delivered"].includes(o.status);
            break;
          case "Pending":
            matchesCompletion = ["Order Created", "Sample Collection"].includes(o.status) || o.completedResults === 0;
            break;
          case "Awaiting Approval":
            matchesCompletion = o.status === "Pending Approval";
            break;
        }
      }
      return matchesQ && matchesStatus && matchesCompletion;
    });
  }, [orders, searchTerm, selectedStatus, selectedCompletion]);

  const orderGroups = useMemo(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const groups: Record<string, { date: Date; orders: Order[]; isToday: boolean; isFuture: boolean }> = {};

    // guarantee today group
    const todayKey = today.toISOString().split("T")[0];
    groups[todayKey] = { date: today, orders: [], isToday: true, isFuture: false };

    filteredOrders.forEach(o => {
      const d = new Date(o.order_date); d.setHours(0, 0, 0, 0);
      const key = d.toISOString().split("T")[0];
      groups[key] ??= { date: d, orders: [], isToday: key === todayKey, isFuture: d.getTime() > today.getTime() };
      groups[key].orders.push(o);
    });

    const arr = Object.values(groups).sort((a, b) => {
      if (a.isToday) return -1;
      if (b.isToday) return 1;
      return b.date.getTime() - a.date.getTime();
    });

    arr.forEach(g => {
      g.orders.sort((a, b) => {
        const num = (x: Order) => parseInt((x.sample_id || "").match(/-(\d+)$/)?.[1] || "0", 10);
        const nA = num(a), nB = num(b);
        if (nA !== nB) return nB - nA;
        return new Date(b.order_date).getTime() - new Date(a.order_date).getTime();
      });
    });
    return arr;
  }, [filteredOrders]);

  const formatDateHeader = (group: { date: Date; isToday: boolean; isFuture: boolean }) => {
    const { date, isToday, isFuture } = group;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const y = new Date(today); y.setDate(y.getDate() - 1);
    if (isToday) {
      return `📅 Today - ${date.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}`;
    }
    if (date.toDateString() === y.toDateString()) {
      return `📅 Yesterday - ${date.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" })}`;
    }
    if (isFuture) {
      return `📅 ${date.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" })} (Future)`;
    }
    const diffDays = Math.ceil((today.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
    return `📅 ${date.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" })} (${diffDays} days ago)`;
  };

  // --------------------------------------------------------
  // [BLOCK E] Actions (status / create / deliver / results)
  // --------------------------------------------------------
  const validateStatusTransition = (order: Order, newStatus: OrderStatus) => {
    switch (newStatus) {
      case "In Progress":
        if (!order.sample_collected_at)
          return { allowed: false, reason: "Sample must be collected before starting laboratory processing." };
        return { allowed: true };
      case "Pending Approval":
        if (!order.sample_collected_at) return { allowed: false, reason: "Sample must be collected first." };
        if (order.status !== "In Progress") return { allowed: false, reason: "Order must be in progress first." };
        return { allowed: true };
      case "Completed":
        if (!order.sample_collected_at) return { allowed: false, reason: "Collect sample before completing order." };
        return { allowed: true };
      case "Delivered":
        if (order.status !== "Completed") return { allowed: false, reason: "Order must be completed before delivery." };
        return { allowed: true };
      default:
        return { allowed: true };
    }
  };

  const handleUpdateOrderStatus = async (orderId: string, newStatus: OrderStatus) => {
    try {
      const order = orders.find(o => o.id === orderId);
      if (!order) return;
      const v = validateStatusTransition(order, newStatus);
      if (!v.allowed) return alert(`Cannot update status: ${v.reason}`);

      const patch: any = { status: newStatus };
      if (newStatus === "Sample Collection") {
        patch.sample_collected_at = new Date().toISOString();
        patch.sample_collected_by = (user as any)?.email || "System";
      }
      const { error } = await database.orders.update(orderId, patch);
      if (error) throw error;
      setOrders(prev => prev.map(o => (o.id === orderId ? { ...o, ...patch } : o)));
      setSelectedOrder(null);
    } catch (e) {
      console.error(e);
    }
  };

  const handleMarkAsDelivered = async (orderId: string) => {
    try {
      const deliveredBy = (user as any)?.user_metadata?.full_name || (user as any)?.email || "System";
      const { error } = await database.orders.markAsDelivered(orderId, deliveredBy);
      if (error) throw error;
      await fetchOrders();
    } catch (e) {
      console.error(e);
    }
  };

  const handleSubmitOrderResults = async (orderId: string, payload: any) => {
    // kept for compatibility if invoked from elsewhere
    try {
      const { error } = await database.results.create(payload);
      if (error) throw error;
      await fetchOrders();
    } catch (e) {
      console.error(e);
    }
  };

  const handleAddOrder = async (form: any) => {
    try {
      const orderData = {
        patient_name: form.patient_name,
        patient_id: form.patient_id,
        tests: form.tests,
        status: form.status,
        priority: form.priority,
        order_date: form.order_date,
        expected_date: form.expected_date,
        total_amount: form.total_amount,
        doctor: form.doctor,
        created_by: (user as any)?.id
      };
      const { error } = await database.orders.create(orderData);
      if (error) throw error;
      await fetchOrders();
      setShowOrderForm(false);
    } catch (e) {
      console.error(e);
    }
  };

  const getPriorityBadge = (p: Priority) =>
    ({ Normal: "bg-gray-100 text-gray-800", Urgent: "bg-orange-100 text-orange-800", STAT: "bg-red-100 text-red-800" }[p] ||
      "bg-gray-100 text-gray-800");

  // --------------------------------------------------------
  // [BLOCK F] UI
  // --------------------------------------------------------
  return (
    <div className="space-y-6">
      {/* Header + View Toggle */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">
            {viewMode === "traditional" ? "Test Orders - Technician View" : "Patient Sessions"}
          </h1>
          <div className="flex items-center space-x-2 bg-gray-100 rounded-lg p-1 self-start sm:self-auto">
            <button
              onClick={() => setViewMode("traditional")}
              className={`px-3 py-1 text-sm font-medium rounded-md ${viewMode === "traditional" ? "bg-white text-gray-900 shadow-sm" : "text-gray-600"}`}
            >
              Traditional
            </button>
            <button
              onClick={() => setViewMode("patient-centric")}
              className={`px-3 py-1 text-sm font-medium rounded-md ${viewMode === "patient-centric" ? "bg-white text-gray-900 shadow-sm" : "text-gray-600"}`}
            >
              Patient-Centric
            </button>
          </div>
        </div>

        <button
          onClick={() => setShowOrderForm(true)}
          className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
        >
          <Plus className="h-5 w-5 mr-2" />
          {viewMode === "traditional" ? "Create Order" : "New Session"}
        </button>
      </div>

      {/* Switchable views */}
      {viewMode === "patient-centric" ? (
        <EnhancedOrders
          orders={orders}
          onAddOrder={handleAddOrder}
          onUpdateStatus={handleUpdateOrderStatus}
          onRefreshOrders={fetchOrders}
          onNewSession={() => setShowOrderForm(true)}
          onNewPatientVisit={() => setShowOrderForm(true)}
          onViewOrderDetails={setSelectedOrder}
        />
      ) : (
        <>
          {/* Overview cards */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="bg-green-50 border border-green-200 rounded-lg p-4">
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
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
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
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
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
            <div className="bg-orange-50 border border-orange-200 rounded-lg p-4">
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

          {/* Search / Filters */}
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="flex-1 relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                <input
                  value={searchTerm}
                  onChange={e => setSearchTerm(e.target.value)}
                  placeholder="Search by patient, order ID, or patient ID…"
                  className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <select value={selectedStatus} onChange={e => setSelectedStatus(e.target.value as any)}
                      className="px-3 py-2 border border-gray-300 rounded-md">
                {["All","Order Created","Sample Collection","In Progress","Pending Approval","Completed","Delivered"].map(s => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
              <select value={selectedCompletion} onChange={e => setSelectedCompletion(e.target.value as any)}
                      className="px-3 py-2 border border-gray-300 rounded-md">
                {["All","All Done","Mostly Done","Pending","Awaiting Approval"].map(s => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
              <button className="inline-flex items-center px-3 py-2 border border-gray-300 rounded-md">
                <Filter className="h-4 w-4 mr-2" />
                More Filters
              </button>
            </div>
          </div>

          {/* Groups + Cards */}
          <div className="bg-white rounded-lg border border-gray-200">
            <div className="px-6 py-4 border-b border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900">Test Orders ({filteredOrders.length})</h3>
            </div>

            {(orderGroups.length === 0 || orderGroups.every(g => g.orders.length === 0)) ? (
              <div className="text-center py-12">
                <TestTube className="h-12 w-12 text-gray-300 mx-auto mb-3" />
                <p className="text-gray-600">No Orders Found</p>
              </div>
            ) : (
              <div className="space-y-8">
                {orderGroups.map(group => (
                  <div key={group.date.toISOString()} className="px-6">
                    <div className={`flex items-center justify-between py-4 border-b-2 mb-6 ${
                      group.isToday ? "border-blue-200 bg-blue-50 -mx-6 px-6 rounded-lg" : "border-gray-200"
                    }`}>
                      <h4 className={`text-lg font-semibold ${group.isToday ? "text-blue-900" : "text-gray-700"}`}>
                        {formatDateHeader(group)}
                      </h4>
                      <div className={`text-sm ${group.isToday ? "text-blue-700" : "text-gray-500"}`}>
                        {group.orders.length} order{group.orders.length !== 1 ? "s" : ""}
                      </div>
                    </div>

                    {/* order cards */}
                    <div className="space-y-4">
                      {group.orders.map((o, idx) => {
                        const isExpanded = !!expandedOrders[o.id];
                        const pct = (o.totalTests || o.tests.length) > 0
                          ? Math.round((o.completedResults / (o.totalTests || o.tests.length)) * 100)
                          : 0;

                        // Click ANYWHERE on the card to open details
                        const openDetails = () => setSelectedOrder(o);

                        return (
                          <div
                            key={o.id}
                            role="button"
                            onClick={openDetails}
                            className={`w-full p-4 border-2 rounded-lg hover:shadow-md transition-all cursor-pointer ${
                              o.abnormalResults > 0 ? "border-red-200 bg-red-50" : "border-gray-200 bg-white"
                            }`}
                          >
                            {/* Top row */}
                            <div className="flex items-start justify-between gap-3">
                              <div className="flex items-center gap-3">
                                <div className="flex items-center justify-center w-8 h-8 bg-blue-100 text-blue-700 rounded-full font-bold text-sm border-2 border-blue-200">
                                  {idx + 1}
                                </div>
                                <div className="flex items-center gap-3">
                                  <User className="h-6 w-6 text-blue-600 shrink-0" />
                                  <div>
                                    <div className="text-xl sm:text-2xl font-bold text-gray-900">
                                      {o.patient?.name || o.patient_name}
                                    </div>
                                    <div className="text-sm sm:text-base text-gray-700">
                                      {(o.patient?.age || "N/A") + "y"} • {o.patient?.gender || "N/A"} • ID: {o.patient_id || "N/A"}
                                    </div>
                                  </div>
                                </div>
                              </div>

                              {/* Status pill + expander */}
                              <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
                                <span className="inline-flex items-center px-3 py-1.5 rounded-lg text-sm font-bold border-2 bg-blue-100 text-blue-800 border-blue-200">
                                  ● In Process
                                </span>
                                <button
                                  className="p-2 text-gray-600 hover:bg-gray-100 rounded-lg"
                                  onClick={() =>
                                    setExpandedOrders(prev => ({ ...prev, [o.id]: !prev[o.id] }))
                                  }
                                >
                                  {isExpanded ? <ChevronUp className="h-5 w-5" /> : <ChevronDown className="h-5 w-5" />}
                                </button>
                              </div>
                            </div>

                            {/* Middle: tests + money/dates */}
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
                                      title={`Sample Tube: ${o.color_name || "Purple"}`}
                                    >
                                      {(o.color_name || "EDTA").charAt(0)}
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
                                  <div className="flex flex-wrap gap-1">
                                    {o.tests.map((t, i) => (
                                      <span key={i} className="px-2 py-1 rounded text-sm bg-blue-100 text-blue-800">
                                        {t}
                                      </span>
                                    ))}
                                  </div>
                                </div>
                              </div>

                              <div className="text-right">
                                <div className="text-xl sm:text-2xl font-bold text-green-600">₹{Number(o.total_amount || 0).toLocaleString()}</div>
                                <div className="text-sm text-gray-600">
                                  <div>Ordered: {new Date(o.order_date).toLocaleDateString()}</div>
                                  <div className={`${new Date(o.expected_date) < new Date() ? "text-red-600 font-bold" : ""}`}>
                                    Expected: {new Date(o.expected_date).toLocaleDateString()}
                                    {new Date(o.expected_date) < new Date() && " ⚠️ OVERDUE"}
                                  </div>
                                </div>

                                {/* important: keep this button in short view */}
                                <button
                                  onClick={(e) => { e.stopPropagation(); openDetails(); }}
                                  className="mt-3 inline-flex items-center px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                                >
                                  <Eye className="h-4 w-4 mr-1" />
                                  View Full Details
                                </button>
                              </div>
                            </div>

                            {/* Progress */}
                            {o.status === "In Progress" && (
                              <div className="mt-3 bg-blue-50 rounded-lg p-2">
                                <div className="flex items-center justify-between text-sm mb-1">
                                  <span className="text-blue-700 font-medium">Progress</span>
                                  <span className="text-blue-700">{pct}% Complete</span>
                                </div>
                                <div className="w-full bg-blue-200 rounded-full h-3">
                                  <div className="bg-blue-600 h-3 rounded-full" style={{ width: `${pct}%` }} />
                                </div>
                              </div>
                            )}

                            {/* Expanded footer actions */}
                            {isExpanded && (
                              <div className="mt-4 pt-3 border-t border-gray-200 flex flex-wrap items-center justify-between gap-3"
                                   onClick={e => e.stopPropagation()}>
                                <div className="text-sm text-gray-600">
                                  Priority: <span className={`px-2 py-0.5 rounded-full font-bold ${getPriorityBadge(o.priority)}`}>{o.priority}</span>
                                </div>
                                <div className="flex items-center gap-2">
                                  {o.status === "Pending Approval" && (
                                    <button
                                      onClick={() => handleUpdateOrderStatus(o.id, "Completed")}
                                      className="inline-flex items-center px-3 py-1.5 bg-green-600 text-white rounded-lg hover:bg-green-700"
                                    >
                                      <CheckCircle className="h-4 w-4 mr-2" /> Approve
                                    </button>
                                  )}
                                  {o.status === "Completed" && (
                                    <button
                                      onClick={() => handleMarkAsDelivered(o.id)}
                                      className="inline-flex items-center px-3 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                                    >
                                      <Send className="h-4 w-4 mr-2" /> Mark Delivered
                                    </button>
                                  )}
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Quick footer stats */}
          <div className="bg-gradient-to-r from-blue-50 to-purple-50 rounded-lg p-4 border border-blue-200">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-sm">
              <div className="flex items-center gap-6">
                <div className="flex items-center">
                  <Calendar className="h-4 w-4 text-blue-600 mr-1" />
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
                  Avg TAT: {orders.length
                    ? Math.round(
                        orders.reduce((sum, o) => {
                          const diffHrs = (Date.now() - new Date(o.order_date).getTime()) / 36e5;
                          return sum + diffHrs;
                        }, 0) / orders.length
                      )
                    : 0}h
                </span>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Modals */}
      {showOrderForm && (
        <OrderForm onClose={() => setShowOrderForm(false)} onSubmit={handleAddOrder} preSelectedPatient={preSelectedPatient} />
      )}

      {selectedOrder && (
        <OrderDetailsModal
          order={selectedOrder}
          onClose={() => setSelectedOrder(null)}
          onUpdateStatus={handleUpdateOrderStatus}
          // P0: after submit => refresh and close
          onAfterSubmit={async () => {
            await fetchOrders();
            setSelectedOrder(null);
          }}
          onAfterSaveDraft={() => {/* optional toast */}}
        />
      )}
    </div>
  );
};

export default Orders;
