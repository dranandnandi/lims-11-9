import React from 'react';
import { 
  Clock, 
  CheckCircle, 
  AlertTriangle, 
  TrendingUp, 
  Users, 
  TestTube, 
  Activity,
  FileText,
  Timer,
  Calendar,
  Target,
  Zap
} from 'lucide-react';

interface DashboardCard {
  title: string;
  value: string | number;
  subValue?: string;
  icon: React.ReactNode;
  color: 'blue' | 'green' | 'yellow' | 'red' | 'purple' | 'gray';
  trend?: {
    value: number;
    direction: 'up' | 'down';
    label: string;
  };
  onClick?: () => void;
}

interface ResultStatsDashboardProps {
  stats: {
    total: number;
    pendingReview: number;
    approved: number;
    reported: number;
    abnormal: number;
    critical: number;
    avgTurnaround: number;
  };
  orderStats?: {
    totalOrders: number;
    pendingOrders: number;
    inProgressOrders: number;
    completedToday: number;
    urgentOrders: number;
    workflowEligible: number;
    departments: number;
  };
  onCardClick?: (cardType: string) => void;
}

const ResultStatsDashboard: React.FC<ResultStatsDashboardProps> = ({
  stats,
  orderStats,
  onCardClick
}) => {
  const getColorClasses = (color: string) => {
    switch (color) {
      case 'blue':
        return {
          bg: 'bg-blue-50',
          icon: 'text-blue-600',
          border: 'border-blue-200',
          hover: 'hover:bg-blue-100'
        };
      case 'green':
        return {
          bg: 'bg-green-50',
          icon: 'text-green-600',
          border: 'border-green-200',
          hover: 'hover:bg-green-100'
        };
      case 'yellow':
        return {
          bg: 'bg-yellow-50',
          icon: 'text-yellow-600',
          border: 'border-yellow-200',
          hover: 'hover:bg-yellow-100'
        };
      case 'red':
        return {
          bg: 'bg-red-50',
          icon: 'text-red-600',
          border: 'border-red-200',
          hover: 'hover:bg-red-100'
        };
      case 'purple':
        return {
          bg: 'bg-purple-50',
          icon: 'text-purple-600',
          border: 'border-purple-200',
          hover: 'hover:bg-purple-100'
        };
      default:
        return {
          bg: 'bg-gray-50',
          icon: 'text-gray-600',
          border: 'border-gray-200',
          hover: 'hover:bg-gray-100'
        };
    }
  };

  const formatTurnaroundTime = (hours: number) => {
    if (hours < 24) {
      return `${Math.round(hours)}h`;
    } else {
      const days = Math.floor(hours / 24);
      const remainingHours = Math.round(hours % 24);
      return `${days}d ${remainingHours}h`;
    }
  };

  const resultCards: DashboardCard[] = [
    {
      title: 'Total Results',
      value: stats.total,
      icon: <FileText className="h-6 w-6" />,
      color: 'blue',
      onClick: () => onCardClick?.('total-results')
    },
    {
      title: 'Pending Review',
      value: stats.pendingReview,
      subValue: `${stats.total > 0 ? Math.round((stats.pendingReview / stats.total) * 100) : 0}% of total`,
      icon: <Clock className="h-6 w-6" />,
      color: 'yellow',
      onClick: () => onCardClick?.('pending-review')
    },
    {
      title: 'Approved',
      value: stats.approved,
      subValue: `${stats.total > 0 ? Math.round((stats.approved / stats.total) * 100) : 0}% completion rate`,
      icon: <CheckCircle className="h-6 w-6" />,
      color: 'green',
      onClick: () => onCardClick?.('approved')
    },
    {
      title: 'Critical/Abnormal',
      value: stats.critical + stats.abnormal,
      subValue: `${stats.critical} critical, ${stats.abnormal} abnormal`,
      icon: <AlertTriangle className="h-6 w-6" />,
      color: 'red',
      onClick: () => onCardClick?.('abnormal')
    },
    {
      title: 'Avg Turnaround',
      value: formatTurnaroundTime(stats.avgTurnaround),
      subValue: 'From entry to review',
      icon: <Timer className="h-6 w-6" />,
      color: stats.avgTurnaround > 48 ? 'red' : stats.avgTurnaround > 24 ? 'yellow' : 'green',
      onClick: () => onCardClick?.('turnaround')
    },
    {
      title: 'Reported',
      value: stats.reported,
      subValue: 'Final reports issued',
      icon: <TrendingUp className="h-6 w-6" />,
      color: 'purple',
      onClick: () => onCardClick?.('reported')
    }
  ];

  const orderCards: DashboardCard[] = orderStats ? [
    {
      title: 'Active Orders',
      value: orderStats.totalOrders,
      subValue: `${orderStats.departments} departments`,
      icon: <TestTube className="h-6 w-6" />,
      color: 'blue',
      onClick: () => onCardClick?.('active-orders')
    },
    {
      title: 'In Progress',
      value: orderStats.inProgressOrders,
      subValue: `${orderStats.pendingOrders} pending start`,
      icon: <Activity className="h-6 w-6" />,
      color: 'yellow',
      onClick: () => onCardClick?.('in-progress')
    },
    {
      title: 'Completed Today',
      value: orderStats.completedToday,
      icon: <Calendar className="h-6 w-6" />,
      color: 'green',
      onClick: () => onCardClick?.('completed-today')
    },
    {
      title: 'Urgent Orders',
      value: orderStats.urgentOrders,
      subValue: 'STAT/High priority',
      icon: <Zap className="h-6 w-6" />,
      color: 'red',
      onClick: () => onCardClick?.('urgent')
    },
    {
      title: 'Workflow Ready',
      value: orderStats.workflowEligible,
      subValue: 'AI processing available',
      icon: <Target className="h-6 w-6" />,
      color: 'purple',
      onClick: () => onCardClick?.('workflow-ready')
    }
  ] : [];

  const DashboardCardComponent: React.FC<{ card: DashboardCard }> = ({ card }) => {
    const colors = getColorClasses(card.color);
    const isClickable = !!card.onClick;

    return (
      <div
        onClick={card.onClick}
        className={`${colors.bg} ${colors.border} border rounded-lg p-4 transition-colors ${
          isClickable ? `cursor-pointer ${colors.hover}` : ''
        }`}
      >
        <div className="flex items-center justify-between">
          <div className="flex-1">
            <div className="flex items-center space-x-3">
              <div className={colors.icon}>
                {card.icon}
              </div>
              <div>
                <div className="text-2xl font-bold text-gray-900">
                  {card.value}
                </div>
                <div className="text-sm font-medium text-gray-700">
                  {card.title}
                </div>
              </div>
            </div>
            
            {card.subValue && (
              <div className="mt-2 text-xs text-gray-600">
                {card.subValue}
              </div>
            )}
            
            {card.trend && (
              <div className="mt-2 flex items-center text-xs">
                <TrendingUp className={`h-3 w-3 mr-1 ${
                  card.trend.direction === 'up' ? 'text-green-500' : 'text-red-500'
                }`} />
                <span className={
                  card.trend.direction === 'up' ? 'text-green-600' : 'text-red-600'
                }>
                  {card.trend.direction === 'up' ? '+' : '-'}{Math.abs(card.trend.value)}%
                </span>
                <span className="text-gray-500 ml-1">{card.trend.label}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      {/* Result Statistics */}
      <div>
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Result Statistics</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {resultCards.map((card, index) => (
            <DashboardCardComponent key={index} card={card} />
          ))}
        </div>
      </div>

      {/* Order Statistics (if provided) */}
      {orderStats && (
        <div>
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Order Overview</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
            {orderCards.map((card, index) => (
              <DashboardCardComponent key={index} card={card} />
            ))}
          </div>
        </div>
      )}

      {/* Quick Insights */}
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <h4 className="font-medium text-gray-900 mb-3">Quick Insights</h4>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
          <div className="space-y-2">
            <div className="flex justify-between">
              <span className="text-gray-600">Approval Rate:</span>
              <span className="font-medium">
                {stats.total > 0 ? Math.round((stats.approved / stats.total) * 100) : 0}%
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">Critical Results:</span>
              <span className={`font-medium ${stats.critical > 0 ? 'text-red-600' : 'text-green-600'}`}>
                {stats.critical > 0 ? `${stats.critical} pending` : 'None'}
              </span>
            </div>
          </div>
          
          <div className="space-y-2">
            <div className="flex justify-between">
              <span className="text-gray-600">Review Backlog:</span>
              <span className={`font-medium ${
                stats.pendingReview > 10 ? 'text-red-600' : 
                stats.pendingReview > 5 ? 'text-yellow-600' : 'text-green-600'
              }`}>
                {stats.pendingReview} results
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">Processing Speed:</span>
              <span className={`font-medium ${
                stats.avgTurnaround > 48 ? 'text-red-600' :
                stats.avgTurnaround > 24 ? 'text-yellow-600' : 'text-green-600'
              }`}>
                {stats.avgTurnaround < 24 ? 'Fast' : stats.avgTurnaround < 48 ? 'Normal' : 'Slow'}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ResultStatsDashboard;