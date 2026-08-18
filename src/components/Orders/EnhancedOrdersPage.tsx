import React, { useState } from 'react';
import { Plus, Link, Users, Activity, ChevronRight, ChevronDown, Calendar, CheckCircle, AlertCircle, FlaskConical, ClipboardEdit, ArrowDownUp } from 'lucide-react';
import { OrderStatusDisplay } from './OrderStatusDisplay';
import { SampleTypeIndicator } from '../Common/SampleTypeIndicator';
import { TATStatusBadge } from './TATStatusBadge';

interface Order {
  id: string;
  patient_id: string;
  patient_name: string;
  visit_group_id?: string;
  order_type?: 'initial' | 'additional' | 'follow_up' | 'urgent';
  parent_order_id?: string;
  status: string;
  total_amount: number;
  order_date: string;
  created_at?: string;
  order_number?: number | null;
  sample_id?: string;
  sample_type?: string;
  color_name?: string;
  tests: string[];
  panels?: {
    name: string;
    expected: number;
    entered: number;
    status: string;
    verified?: boolean;
    is_section_only?: boolean;
    has_section_content?: boolean;
    section_verification_status?: string | null;
  }[];
  hours_until_tat_breach?: number | null;
  is_tat_breached?: boolean | null;
  tat_hours?: number | null;
}

interface EnhancedOrdersPageProps {
  orders: Order[];
  onAddOrder: (formData: any) => Promise<void>;
  onUpdateStatus: (orderId: string, newStatus: string) => Promise<void>;
  onRefreshOrders?: () => Promise<void>;
  onViewOrderDetails?: (order: Order) => void;
  onQuickResultEntry?: (order: Order) => void;
  onNewSession?: () => void;
  onNewPatientVisit?: () => void;
}

interface PatientVisit {
  visit_group_id: string;
  patient_name: string;
  patient_id: string;
  visit_date: string;
  total_orders: number;
  total_amount: number;
  visit_status: string;
  orders: Order[];
}

type VisitSortMode = 'current' | 'sample_desc' | 'sample_asc' | 'patient_az';

interface PatientVisitCardProps {
  visit: PatientVisit;
  sortMode: VisitSortMode;
  onCreateFollowUp: (parentOrderId: string) => void;
  onViewActivity: (visitGroupId: string) => void;
  onViewOrderDetails?: (order: Order) => void;
  onQuickResultEntry?: (order: Order) => void;
}

const getOrderSortNumber = (order: Order) => {
  if (typeof order.order_number === 'number' && Number.isFinite(order.order_number)) {
    return order.order_number;
  }

  const sampleIdMatch = order.sample_id?.match(/(?:^|[/-])(\d+)\s*$/);
  if (sampleIdMatch) return parseInt(sampleIdMatch[1], 10);

  const visitGroupIdMatch = order.visit_group_id?.match(/(?:^|[/-])(\d+)\s*$/);
  if (visitGroupIdMatch) return parseInt(visitGroupIdMatch[1], 10);

  const orderIdMatch = order.id?.match(/(\d+)$/);
  return orderIdMatch ? parseInt(orderIdMatch[1], 10) : 0;
};

const getPendingPanels = (order: Order) => {
  const panels = order.panels || [];
  if (panels.length === 0) {
    return ['Completed', 'Delivered'].includes(order.status) ? [] : order.tests;
  }

  return panels
    .filter(panel => {
      // Section-only: pending if no content or not verified
      if (panel.is_section_only) {
        return !panel.has_section_content || panel.section_verification_status !== 'verified';
      }
      // Regular panels: pending if not verified and not all entered
      return !panel.verified && panel.status !== 'Verified' && panel.entered < panel.expected;
    })
    .map(panel => panel.name);
};

const PatientVisitCard: React.FC<PatientVisitCardProps> = ({
  visit,
  sortMode,
  onCreateFollowUp,
  onViewActivity,
  onViewOrderDetails,
  onQuickResultEntry
}) => {
  const [expanded, setExpanded] = useState(false);

  const getOrderTypeIcon = (orderType?: string) => {
    switch (orderType) {
      case 'initial': return '🏥';
      case 'additional': return '➕';
      case 'follow_up': return '🔄';
      case 'urgent': return '🚨';
      default: return '📋';
    }
  };

  const getStatusColor = (status: string) => {
    const colors = {
      'Sample Collection': 'bg-orange-100 text-orange-800',
      'In Progress': 'bg-blue-100 text-blue-800',
      'Pending Approval': 'bg-yellow-100 text-yellow-800',
      'Completed': 'bg-green-100 text-green-800',
      'Delivered': 'bg-gray-100 text-gray-800'
    };
    return colors[status as keyof typeof colors] || 'bg-gray-100 text-gray-800';
  };

  const primaryOrder = visit.orders.find(o => o.order_type === 'initial') || visit.orders[0];
  const pendingPanelNames = Array.from(new Set(visit.orders.flatMap(getPendingPanels)));

  // Keep the existing order by default; only sort the chain when the user chooses it.
  const sortedOrders = [...visit.orders].sort((a, b) => {
    if (sortMode === 'current' || sortMode === 'patient_az') return 0;

    const sampleNumA = getOrderSortNumber(a);
    const sampleNumB = getOrderSortNumber(b);

    if (sampleNumA !== sampleNumB) {
      return sortMode === 'sample_asc' ? sampleNumA - sampleNumB : sampleNumB - sampleNumA;
    }

    // If sample numbers are same, fallback to timestamp sorting (newest first)
    const timeA = a.created_at || a.order_date;
    const timeB = b.created_at || b.order_date;
    const timestampA = new Date(timeA).getTime();
    const timestampB = new Date(timeB).getTime();

    if (timestampA !== timestampB) {
      return timestampB - timestampA; // Newest first
    }

    // Final fallback to ID comparison for consistency
    return (b.id || '').localeCompare(a.id || '');
  });

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
      {/* Visit Header */}
      <div className="px-6 py-4 border-b border-gray-200 bg-gray-50">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-4">
            <button
              onClick={() => setExpanded(!expanded)}
              className="p-1 hover:bg-gray-200 rounded transition-colors"
            >
              {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </button>

            <div>
              <h3 className="text-lg font-semibold text-gray-900">
                👤 {visit.patient_name}
              </h3>
              <div className="text-sm text-gray-600 space-x-2">
                <span>📅 {new Date(visit.visit_date).toLocaleDateString()}</span>
                <span>•</span>
                <span>🆔 {visit.visit_group_id}</span>
                <span>•</span>
	                <span className={`px-2 py-1 rounded-full text-xs font-medium ${getStatusColor(visit.visit_status)}`}>
	                  {visit.visit_status}
	                </span>
                  {pendingPanelNames.length > 0 && (
                    <>
                      <span>â€¢</span>
                      <span
                        className="rounded-full bg-amber-100 px-2 py-1 text-xs font-medium text-amber-800"
                        title={pendingPanelNames.join(', ')}
                      >
                        Pending: {pendingPanelNames.slice(0, 2).join(', ')}
                        {pendingPanelNames.length > 2 ? ` +${pendingPanelNames.length - 2}` : ''}
                      </span>
                    </>
                  )}
	              </div>
            </div>
          </div>

          <div className="flex items-center space-x-4">
            <div className="text-right">
              <div className="text-sm text-gray-600">{visit.total_orders} order{visit.total_orders !== 1 ? 's' : ''}</div>
            </div>

            <div className="flex items-center space-x-2">
              <button
                onClick={() => onViewActivity(visit.visit_group_id)}
                className="p-2 text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                title="View Activity Timeline"
              >
                <Activity className="h-4 w-4" />
              </button>

              {primaryOrder && onQuickResultEntry && (
                <button
                  onClick={() => onQuickResultEntry(primaryOrder)}
                  className="p-2 text-emerald-600 hover:bg-emerald-50 rounded-lg transition-colors"
                  title="Quick result entry"
                >
                  <ClipboardEdit className="h-4 w-4" />
                </button>
              )}

              <button
                onClick={() => onCreateFollowUp(primaryOrder.id)}
                className="p-2 text-purple-600 hover:bg-purple-50 rounded-lg transition-colors"
                title="Create Follow-up Order"
              >
                <Link className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Order Chain (when expanded) */}
      {expanded && (
        <div className="px-4 py-3 md:px-6 md:py-4">
          <h4 className="text-sm font-medium text-gray-700 mb-3 flex items-center">
            <Users className="h-4 w-4 mr-2" />
            Order Chain ({sortedOrders.length} orders)
          </h4>

          <div className="space-y-3">
            {sortedOrders.map((order, index) => (
              <div key={order.id} className="w-full p-3 sm:p-4 bg-white rounded-lg border-2 border-gray-200 hover:border-blue-300 hover:shadow-md transition-all duration-200">
                {/* Full Width Horizontal Layout */}
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between w-full">
                  {/* Left Section: Sequence & Order Info */}
                  <div className="flex items-start gap-3 md:items-center md:gap-4">
                    {/* Sequence Number */}
                    <div className="flex items-center justify-center w-8 h-8 bg-blue-100 text-blue-700 rounded-full font-bold text-sm border-2 border-blue-200">
                      {index + 1}
                    </div>

                    {/* Order Icon & ID */}
                    <div className="flex items-start gap-3 md:items-center">
                      <span className="text-2xl">{getOrderTypeIcon(order.order_type)}</span>
                      <div>
                        <div className="text-base md:text-lg font-bold text-gray-900">
                          Order #{order.id.substring(0, 8)}
                        </div>
                        <div className="flex flex-wrap items-center gap-2 mt-0.5">
                          <SampleTypeIndicator
                            sampleType={order.sample_type || 'Blood'}
                            size="sm"
                          />
                          <div className="text-sm text-gray-600 flex flex-wrap items-center gap-2">
                            <span className="capitalize font-medium">{order.order_type}</span>
                            {order.sample_id && (
                              <>
                                <span>•</span>
                                <span className="bg-gray-100 px-2 py-1 rounded text-xs font-mono text-gray-700">
                                  ID: {order.sample_id.split('-').pop()}
                                </span>
                              </>
                            )}
                          </div>
                        </div>
                        {/* TAT Badge — only show for in-progress orders */}
                        {!['Report Ready', 'Completed', 'Delivered'].includes(order.status) && (
                          <div className="mt-1">
                            <TATStatusBadge
                              hoursUntilBreach={(order as any).hours_until_tat_breach}
                              isBreached={(order as any).is_tat_breached}
                              tatHours={(order as any).tat_hours}
                              compact={true}
                            />
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Center Section: Tests & Details */}
                  <div className="flex-1 md:px-6">
                    <div className="text-left md:text-right">
                      <div className="text-sm text-gray-600">
                        {order.tests.length} test{order.tests.length !== 1 ? 's' : ''}
                      </div>
                      {order.tests.length > 0 && (
                        <div className="text-xs text-blue-600 mt-1 max-w-full md:max-w-xs line-clamp-2 md:line-clamp-1">
                          {order.tests.slice(0, 3).join(', ')}
                          {order.tests.length > 3 && (
                            <span className="text-gray-500"> +{order.tests.length - 3} more</span>
                          )}
                        </div>
                      )}
                      {(() => {
                        const pendingPanels = getPendingPanels(order);
                        if (pendingPanels.length === 0) return null;

                        return (
                          <div
                            className="mt-1 text-xs font-medium text-amber-700 max-w-full md:max-w-xs line-clamp-2 md:line-clamp-1"
                            title={pendingPanels.join(', ')}
                          >
                            Pending: {pendingPanels.slice(0, 3).join(', ')}
                            {pendingPanels.length > 3 && <span className="text-gray-500"> +{pendingPanels.length - 3} more</span>}
                          </div>
                        );
                      })()}
                      {/* Outsourced Tests Indicator */}
                      {(() => {
                        const orderTests = (order as any).order_tests || [];
                        const outsourcedTests = orderTests.filter((ot: any) => ot.outsourced_lab_id);
                        const inhouseTests = orderTests.filter((ot: any) => !ot.outsourced_lab_id);

                        if (outsourcedTests.length > 0) {
                          return (
                            <div className="flex items-center justify-end gap-1 mt-1">
                              {inhouseTests.length > 0 && (
                                <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-xs font-medium bg-green-100 text-green-700 rounded">
                                  🏠 {inhouseTests.length}
                                </span>
                              )}
                              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-xs font-medium bg-orange-100 text-orange-700 rounded">
                                🏥 {outsourcedTests.length} outsourced
                              </span>
                            </div>
                          );
                        }
                        return null;
                      })()}
                    </div>
                  </div>

                  {/* Right Section: Status & Actions */}
                  <div className="flex flex-col items-start gap-2 md:flex-row md:items-center md:gap-3">
                    <OrderStatusDisplay order={order} compact={true} />

                    {onQuickResultEntry && (
                      <button
                        onClick={() => onQuickResultEntry(order)}
                        className="p-2 text-emerald-600 hover:bg-emerald-50 rounded-lg transition-colors border-2 border-emerald-200 hover:border-emerald-300"
                        title="Quick result entry"
                      >
                        <ClipboardEdit className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-4 pt-3 border-t border-gray-200">
            <div className="flex items-center justify-end text-sm">
              <span className="text-gray-600">
                Last Updated: {new Date().toLocaleTimeString()}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// Enhanced Orders page component
const EnhancedOrdersPage: React.FC<EnhancedOrdersPageProps> = ({
  orders,
  // onAddOrder, 
  // onUpdateStatus,
  onRefreshOrders,
  onQuickResultEntry,
  onNewSession,
  onNewPatientVisit
}) => {
  // activity modal state planned for future implementation
  // const [showActivityModal, setShowActivityModal] = useState(false);
  // const [selectedVisitGroupId, setSelectedVisitGroupId] = useState<string | null>(null);
  const [selectedRange, setSelectedRange] = useState<'today' | 'yesterday' | 'last7' | 'all'>('today');
  const [sortMode, setSortMode] = useState<VisitSortMode>('current');

  console.log('Orders version of EnhancedOrdersPage is rendering');

  // Normalizes any date-like string to YYYY-MM-DD
  const normalizeDate = (raw?: string) => {
    if (!raw) return new Date().toISOString().slice(0, 10);
    return raw.slice(0, 10);
  };

  // Transform orders into patient visits (base dataset before date filtering) with improved keying logic
  const patientVisits: PatientVisit[] = React.useMemo(() => {
    const visitGroups: Record<string, PatientVisit> = {};

    orders.forEach(order => {
      const safeDate = normalizeDate(order.order_date);
      const safePatientName = order.patient_name || 'Unknown Patient';
      // If sample_id exists, group strictly by sample_id. Else use patient_id+date (or existing visit_group_id)
      const sampleId = (order as any).sample_id as string | undefined;
      const visitGroupId = sampleId ? `sample-${sampleId}` : (order.visit_group_id || `${order.patient_id}-${safeDate}`);

      if (!visitGroups[visitGroupId]) {
        visitGroups[visitGroupId] = {
          visit_group_id: visitGroupId,
          patient_name: safePatientName,
          patient_id: order.patient_id,
          visit_date: safeDate,
          total_orders: 0,
          total_amount: 0,
          visit_status: 'In Progress',
          orders: []
        };
      }

      const transformed: Order = {
        ...order,
        patient_name: safePatientName,
        order_date: safeDate,
        order_type: order.order_type || 'initial'
      };

      const group = visitGroups[visitGroupId];
      group.orders.push(transformed);
      group.total_orders += 1;
      group.total_amount += order.total_amount;

      const allDone = group.orders.every(o => ['Completed', 'Delivered'].includes(o.status));
      const anyActive = group.orders.some(o => ['In Progress', 'Sample Collection'].includes(o.status));
      group.visit_status = allDone ? 'Completed' : anyActive ? 'In Progress' : group.visit_status;
    });

    return Object.values(visitGroups).sort((a, b) => b.visit_date.localeCompare(a.visit_date));
  }, [orders]);

  // Filter visits by selected date range before grouping
  const filteredVisits = React.useMemo(() => {
    const todayKey = new Date().toISOString().slice(0, 10);
    const yesterdayKey = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    return patientVisits.filter(v => {
      const key = normalizeDate(v.visit_date);
      switch (selectedRange) {
        case 'today': return key === todayKey;
        case 'yesterday': return key === yesterdayKey;
        case 'last7': return (Date.now() - new Date(key).getTime()) <= 7 * 86400000;
        case 'all': default: return true;
      }
    });
  }, [patientVisits, selectedRange]);

  // Group patient visits by date (starting with today) using filtered list
  const groupVisitsByDate = () => {
    const today = new Date();
    const groups: { [key: string]: { date: Date; dateString: string; visits: PatientVisit[]; isToday: boolean; isFuture: boolean } } = {};

    // Always include today, even if no visits
    const todayString = today.toISOString().split('T')[0];
    groups[todayString] = {
      date: today,
      dateString: todayString,
      visits: [],
      isToday: true,
      isFuture: false
    };

    // Group visits by date (filtered)
    filteredVisits.forEach(visit => {
      const visitDate = new Date(visit.visit_date);
      const visitDateString = visitDate.toISOString().split('T')[0];

      if (!groups[visitDateString]) {
        groups[visitDateString] = {
          date: visitDate,
          dateString: visitDateString,
          visits: [],
          isToday: visitDateString === todayString,
          isFuture: visitDate > today
        };
      }

      groups[visitDateString].visits.push(visit);
    });

    // Convert to array and sort (today first, then by date descending)
    const sortedGroups = Object.values(groups).sort((a, b) => {
      if (a.isToday) return -1;
      if (b.isToday) return 1;
      return b.date.getTime() - a.date.getTime();
    });

    if (sortMode !== 'current') {
      sortedGroups.forEach(group => {
        group.visits.sort((a, b) => {
          if (sortMode === 'patient_az') {
            return a.patient_name.localeCompare(b.patient_name);
          }

          const getMaxSampleNumber = (visit: PatientVisit) => Math.max(...visit.orders.map(getOrderSortNumber), 0);
          const maxA = getMaxSampleNumber(a);
          const maxB = getMaxSampleNumber(b);

          if (maxA !== maxB) {
            return sortMode === 'sample_asc' ? maxA - maxB : maxB - maxA;
          }

          return a.patient_name.localeCompare(b.patient_name);
        });
      });
    }

    return sortedGroups;
  };

  const visitGroups = groupVisitsByDate();

  // MIS metrics based on currently filtered visits
  const misMetrics = React.useMemo(() => {
    const today = new Date();
    const todayString = today.toISOString().split('T')[0];
    const activeVisits = filteredVisits.length;
    const inProgress = filteredVisits.filter(v => v.visit_status === 'In Progress').length;
    const awaitingApproval = filteredVisits.filter(v => v.orders.some(o => o.status === 'Pending Approval')).length;
    const completedToday = patientVisits.filter(v => {
      const isToday = v.visit_date.startsWith(todayString);
      const allDone = v.orders.every(o => o.status === 'Completed' || o.status === 'Delivered');
      return isToday && allDone;
    }).length;
    const pendingCollection = filteredVisits.filter(v => v.orders.some(o => o.status === 'Sample Collection')).length;
    return { activeVisits, inProgress, awaitingApproval, completedToday, pendingCollection };
  }, [filteredVisits, patientVisits]);

  const formatDateHeader = (group: any) => {
    const { date, isToday, isFuture } = group;
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    if (isToday) {
      return `📅 Today - ${date.toLocaleDateString('en-IN', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric'
      })}`;
    } else if (date.toDateString() === yesterday.toDateString()) {
      return `📅 Yesterday - ${date.toLocaleDateString('en-IN', {
        weekday: 'long',
        day: 'numeric',
        month: 'long'
      })}`;
    } else if (isFuture) {
      return `📅 ${date.toLocaleDateString('en-IN', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric'
      })} (Future)`;
    } else {
      const diffTime = today.getTime() - date.getTime();
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

      return `📅 ${date.toLocaleDateString('en-IN', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric'
      })} (${diffDays} days ago)`;
    }
  };

  const handleCreateFollowUp = (parentOrderId: string) => {
    // Logic to create follow-up order
    console.log('Creating follow-up order for:', parentOrderId);
  };

  const handleViewActivity = () => {
    // Activity modal not yet implemented post-refactor
    // setSelectedVisitGroupId(visitGroupId);
    // setShowActivityModal(true);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <h1 className="text-3xl font-bold text-gray-900">Patient Visits & Orders</h1>
        <div className="flex items-center gap-3 flex-wrap">
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
                className={`px-3 py-1.5 transition-colors ${selectedRange === option.key ? 'bg-white shadow-sm text-blue-600' : 'text-gray-600 hover:text-gray-800'}`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className="relative">
            <ArrowDownUp className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <select
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value as VisitSortMode)}
              className="h-9 rounded-lg border border-gray-300 bg-white pl-9 pr-8 text-sm text-gray-700 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
              title="Sort patient visits"
            >
              <option value="current">Current order</option>
              <option value="sample_desc">Sample ID high to low</option>
              <option value="sample_asc">Sample ID low to high</option>
              <option value="patient_az">Patient A-Z</option>
            </select>
          </div>
          <button
            onClick={onNewPatientVisit || onNewSession}
            className="flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            <Plus className="h-4 w-4 mr-2" />
            New Order
          </button>
        </div>
      </div>

      {/* Operational MIS Metrics (filtered by selected range) */}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-6">
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5">
          <div className="flex items-center">
            <div className="bg-blue-100 p-3 rounded-lg"><Users className="h-6 w-6 text-blue-600" /></div>
            <div className="ml-4">
              <div className="text-xl font-bold text-gray-900">{misMetrics.activeVisits}</div>
              <div className="text-xs text-gray-600">Active Visits</div>
            </div>
          </div>
        </div>
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5">
          <div className="flex items-center">
            <div className="bg-orange-100 p-3 rounded-lg"><Activity className="h-6 w-6 text-orange-600" /></div>
            <div className="ml-4">
              <div className="text-xl font-bold text-gray-900">{misMetrics.inProgress}</div>
              <div className="text-xs text-gray-600">In Progress</div>
            </div>
          </div>
        </div>
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5">
          <div className="flex items-center">
            <div className="bg-yellow-100 p-3 rounded-lg"><AlertCircle className="h-6 w-6 text-yellow-600" /></div>
            <div className="ml-4">
              <div className="text-xl font-bold text-gray-900">{misMetrics.awaitingApproval}</div>
              <div className="text-xs text-gray-600">Awaiting Approval</div>
            </div>
          </div>
        </div>
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5">
          <div className="flex items-center">
            <div className="bg-green-100 p-3 rounded-lg"><CheckCircle className="h-6 w-6 text-green-600" /></div>
            <div className="ml-4">
              <div className="text-xl font-bold text-gray-900">{misMetrics.completedToday}</div>
              <div className="text-xs text-gray-600">Completed Today</div>
            </div>
          </div>
        </div>
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5">
          <div className="flex items-center">
            <div className="bg-purple-100 p-3 rounded-lg"><FlaskConical className="h-6 w-6 text-purple-600" /></div>
            <div className="ml-4">
              <div className="text-xl font-bold text-gray-900">{misMetrics.pendingCollection}</div>
              <div className="text-xs text-gray-600">Pending Collection</div>
            </div>
          </div>
        </div>
      </div>

      {/* Patient Visits List - Date Grouped */}
      <div className="space-y-6">
        {visitGroups.map((group) => (
          <div key={group.dateString}>
            {/* Date Header */}
            <div className={`sticky top-0 z-10 bg-white border-b-2 pb-3 mb-4 ${group.isToday ? 'border-green-500' : 'border-gray-200'
              }`}>
              <div className={`flex items-center justify-between p-4 rounded-lg ${group.isToday
                ? 'bg-gradient-to-r from-green-50 to-blue-50 border border-green-200'
                : 'bg-gray-50 border border-gray-200'
                }`}>
                <h2 className={`text-lg font-bold ${group.isToday ? 'text-green-800' : 'text-gray-700'
                  }`}>
                  {formatDateHeader(group)}
                </h2>
                <div className="flex items-center space-x-4 text-sm">
                  <span className={`px-3 py-1 rounded-full ${group.isToday
                    ? 'bg-green-100 text-green-800 border border-green-200'
                    : 'bg-gray-100 text-gray-600 border border-gray-200'
                    }`}>
                    {group.visits.length} visit{group.visits.length !== 1 ? 's' : ''}
                  </span>
                </div>
              </div>
            </div>

            {/* Visits for this date */}
            {group.visits.length === 0 && group.isToday ? (
              <div className="bg-gray-50 border-2 border-dashed border-gray-300 rounded-lg p-8 text-center">
                <Calendar className="h-12 w-12 text-gray-400 mx-auto mb-3" />
                <p className="text-gray-500 text-lg mb-2">No patient visits today</p>
                <p className="text-gray-400">Schedule a new patient visit to get started</p>
              </div>
            ) : (
              <div className="space-y-4">
                {group.visits.map((visit) => (
                  <PatientVisitCard
                    key={visit.visit_group_id}
                    visit={visit}
                    sortMode={sortMode}
                    onCreateFollowUp={handleCreateFollowUp}
                    onViewActivity={handleViewActivity}
                    onQuickResultEntry={onQuickResultEntry}
                  />
                ))}
              </div>
            )}
          </div>
        ))}

        {/* Empty state when no visits at all */}
        {visitGroups.every(group => group.visits.length === 0) && (
          <div className="bg-white border-2 border-dashed border-gray-300 rounded-lg p-12 text-center">
            <Users className="h-16 w-16 text-gray-400 mx-auto mb-4" />
            <h3 className="text-xl font-semibold text-gray-600 mb-2">No patient visits found</h3>
            <p className="text-gray-500 mb-6">Start by creating a new patient visit or session</p>
            <div className="flex justify-center space-x-4">
              <button
                onClick={onNewSession}
                className="flex items-center px-6 py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
              >
                <Plus className="h-5 w-5 mr-2" />
                New Session
              </button>
              <button
                onClick={onNewPatientVisit}
                className="flex items-center px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
              >
                <Plus className="h-5 w-5 mr-2" />
                New Patient Visit
              </button>
            </div>
          </div>
        )}
      </div>

    </div>
  );
};

export default EnhancedOrdersPage;
