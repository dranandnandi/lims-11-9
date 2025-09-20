import React, { useState } from 'react';
import { 
  Filter, 
  Clock, 
  TestTube, 
  ChevronDown,
  X,
  Search
} from 'lucide-react';

interface ViewModeFilter {
  mode: 'entry' | 'review';
  entrySubMode?: 'order-based' | 'test-group' | 'department';
  searchTerm: string;
  department: string | null;
  status: string;
  priority: string;
  dateRange: string;
  urgentOnly: boolean;
  workflowEligibleOnly: boolean;
}

interface EnhancedViewSelectorProps {
  viewMode: 'entry' | 'review';
  entryViewMode: 'order-based' | 'test-group' | 'department';
  filters: ViewModeFilter;
  onViewModeChange: (mode: 'entry' | 'review') => void;
  onEntryViewModeChange: (mode: 'order-based' | 'test-group' | 'department') => void;
  onFiltersChange: (filters: Partial<ViewModeFilter>) => void;
  departments: string[];
  resultCounts?: {
    entry: number;
    review: number;
  };
}

const EnhancedViewSelector: React.FC<EnhancedViewSelectorProps> = ({
  viewMode,
  entryViewMode,
  filters,
  onViewModeChange,
  onEntryViewModeChange,
  onFiltersChange,
  departments,
  resultCounts
}) => {
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);

  const clearAllFilters = () => {
    onFiltersChange({
      searchTerm: '',
      department: null,
      status: 'all',
      priority: 'all',
      dateRange: 'all',
      urgentOnly: false,
      workflowEligibleOnly: false
    });
  };

  const hasActiveFilters = () => {
    return filters.searchTerm ||
           filters.department ||
           filters.status !== 'all' ||
           filters.priority !== 'all' ||
           filters.dateRange !== 'all' ||
           filters.urgentOnly ||
           filters.workflowEligibleOnly;
  };

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200">
      {/* Main View Mode Selector */}
      <div className="p-4 border-b border-gray-200">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold text-gray-900">Result Management</h2>
            <div className="flex items-center bg-gray-100 rounded-lg p-1">
          <button
            onClick={() => onViewModeChange('entry')}
            className={`flex-1 px-4 py-2 rounded-md transition-colors ${
              viewMode === 'entry' 
                ? 'bg-white shadow-sm text-gray-900' 
                : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            <div className="flex items-center justify-center space-x-2">
              <TestTube className="h-4 w-4" />
              <span>Entry</span>
              {resultCounts?.entry !== undefined && (
                <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">
                  {resultCounts.entry}
                </span>
              )}
            </div>
          </button>
          
          <button
            onClick={() => onViewModeChange('review')}
            className={`flex-1 px-4 py-2 rounded-md transition-colors ${
              viewMode === 'review' 
                ? 'bg-white shadow-sm text-gray-900' 
                : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            <div className="flex items-center justify-center space-x-2">
              <Clock className="h-4 w-4" />
              <span>Review</span>
              {resultCounts?.review !== undefined && (
                <span className="text-xs bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded-full">
                  {resultCounts.review}
                </span>
              )}
            </div>
          </button>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {viewMode === 'entry' && (
              <div className="flex items-center gap-2">
                <label className="text-sm text-gray-600">Entry View</label>
                <select
                  value={entryViewMode}
                  onChange={(e) => onEntryViewModeChange(e.target.value as any)}
                  className="px-2 py-1.5 border border-gray-300 rounded-md text-sm"
                >
                  <option value="order-based">Order-Based</option>
                  <option value="department">Department</option>
                  <option value="test-group">Test Group</option>
                </select>
              </div>
            )}
            <button
              onClick={() => setShowAdvancedFilters(!showAdvancedFilters)}
              className="flex items-center space-x-2 px-3 py-1 text-sm text-gray-600 hover:text-gray-900 border border-gray-300 rounded-md hover:bg-gray-50"
            >
              <Filter className="h-4 w-4" />
              <span>Filters</span>
              {hasActiveFilters() && (
                <span className="bg-blue-100 text-blue-800 text-xs px-2 py-0.5 rounded-full">
                  Active
                </span>
              )}
              <ChevronDown className={`h-4 w-4 transition-transform ${showAdvancedFilters ? 'rotate-180' : ''}`} />
            </button>
          </div>
        </div>
      </div>

      {/* Advanced Filters Panel */}
      {showAdvancedFilters && (
        <div className="p-4 bg-gray-50">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-medium text-gray-900">Advanced Filters</h3>
            {hasActiveFilters() && (
              <button
                onClick={clearAllFilters}
                className="flex items-center space-x-1 text-sm text-gray-600 hover:text-gray-900"
              >
                <X className="h-3 w-3" />
                <span>Clear All</span>
              </button>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            {/* Search */}
            <div className="col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Search
              </label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                <input
                  type="text"
                  placeholder="Patient, order, sample ID..."
                  value={filters.searchTerm}
                  onChange={(e) => onFiltersChange({ searchTerm: e.target.value })}
                  className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-md text-sm"
                />
              </div>
            </div>

            {/* Department Filter */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Department
              </label>
              <select
                value={filters.department || ''}
                onChange={(e) => onFiltersChange({ department: e.target.value || null })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
              >
                <option value="">All Departments</option>
                {departments.map(dept => (
                  <option key={dept} value={dept}>{dept}</option>
                ))}
              </select>
            </div>

            {/* Status Filter */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Status
              </label>
              <select
                value={filters.status}
                onChange={(e) => onFiltersChange({ status: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
              >
                <option value="all">All</option>
                <option value="pending">Pending</option>
                <option value="in_progress">In Progress</option>
                <option value="completed">Completed</option>
              </select>
            </div>

            {/* Priority Filter */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Priority
              </label>
              <select
                value={filters.priority}
                onChange={(e) => onFiltersChange({ priority: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
              >
                <option value="all">All Priorities</option>
                <option value="STAT">STAT</option>
                <option value="URGENT">Urgent</option>
                <option value="HIGH">High</option>
                <option value="NORMAL">Normal</option>
              </select>
            </div>

            {/* Date Range Filter */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Date Range
              </label>
              <select
                value={filters.dateRange}
                onChange={(e) => onFiltersChange({ dateRange: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
              >
                <option value="today">Today</option>
                <option value="7d">Last 7 days</option>
                <option value="30d">Last 30 days</option>
                <option value="90d">Last 90 days</option>
                <option value="all">All Dates</option>
                <option value="custom">Custom Range</option>
              </select>
            </div>

            {/* Toggle Filters */}
            <div className="col-span-2">
              <div className="flex space-x-4">
                <label className="flex items-center">
                  <input
                    type="checkbox"
                    checked={filters.urgentOnly}
                    onChange={(e) => onFiltersChange({ urgentOnly: e.target.checked })}
                    className="rounded border-gray-300 text-red-600 focus:ring-red-500"
                  />
                  <span className="ml-2 text-sm text-gray-700">Urgent Only</span>
                </label>

                <label className="flex items-center">
                  <input
                    type="checkbox"
                    checked={filters.workflowEligibleOnly}
                    onChange={(e) => onFiltersChange({ workflowEligibleOnly: e.target.checked })}
                    className="rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                  />
                  <span className="ml-2 text-sm text-gray-700">Workflow Ready</span>
                </label>
              </div>
            </div>
          </div>

          {/* Active Filters Summary */}
          {hasActiveFilters() && (
            <div className="mt-4 pt-4 border-t border-gray-200">
              <div className="flex flex-wrap gap-2">
                {filters.searchTerm && (
                  <span className="inline-flex items-center px-2 py-1 rounded-full text-xs bg-blue-100 text-blue-800">
                    Search: {filters.searchTerm}
                    <button
                      onClick={() => onFiltersChange({ searchTerm: '' })}
                      className="ml-1 text-blue-600 hover:text-blue-800"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                )}
                
                {filters.department && (
                  <span className="inline-flex items-center px-2 py-1 rounded-full text-xs bg-green-100 text-green-800">
                    {filters.department}
                    <button
                      onClick={() => onFiltersChange({ department: null })}
                      className="ml-1 text-green-600 hover:text-green-800"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                )}
                
                {filters.status !== 'all' && (
                  <span className="inline-flex items-center px-2 py-1 rounded-full text-xs bg-yellow-100 text-yellow-800">
                    Status: {filters.status}
                    <button
                      onClick={() => onFiltersChange({ status: 'all' })}
                      className="ml-1 text-yellow-600 hover:text-yellow-800"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                )}

                {filters.urgentOnly && (
                  <span className="inline-flex items-center px-2 py-1 rounded-full text-xs bg-red-100 text-red-800">
                    Urgent Only
                    <button
                      onClick={() => onFiltersChange({ urgentOnly: false })}
                      className="ml-1 text-red-600 hover:text-red-800"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                )}

                {filters.workflowEligibleOnly && (
                  <span className="inline-flex items-center px-2 py-1 rounded-full text-xs bg-purple-100 text-purple-800">
                    Workflow Ready
                    <button
                      onClick={() => onFiltersChange({ workflowEligibleOnly: false })}
                      className="ml-1 text-purple-600 hover:text-purple-800"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default EnhancedViewSelector;