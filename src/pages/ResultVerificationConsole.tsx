import React, { useState, useEffect } from 'react';
import { 
  Search, 
  Filter, 
  CheckCircle, 
  XCircle, 
  AlertTriangle, 
  AlertCircle,
  Copy,
  ChevronRight,
  ChevronDown,
  User,
  Calendar,
  Clock,
  Eye,
  ArrowUp,
  ArrowDown,
  Minus
} from 'lucide-react';
import { useVerificationConsole } from '../hooks/useVerificationConsole';
import { 
  VerificationResult, 
  VerificationParameter, 
  VerificationFilters 
} from '../utils/verificationService';

/**
 * Result Verification Console - NEW FAST VERIFICATION INTERFACE
 * This replaces the old verification screen with a high-performance console
 * 
 * Features:
 * - One-glance verification without modals
 * - Keyboard-driven workflow
 * - Batch operations
 * - Dense table layout
 * - Real-time performance
 */

// Parameter Chip Component
const ParameterChip: React.FC<{ 
  parameter: VerificationParameter; 
  compact?: boolean;
}> = ({ parameter, compact = false }) => {
  const getChipStyle = () => {
    switch (parameter.flag) {
      case 'critical':
        return 'bg-red-100 text-red-800 border-red-300';
      case 'abnormal':
        return 'bg-amber-100 text-amber-800 border-amber-300';
      default:
        return 'bg-gray-100 text-gray-700 border-gray-300';
    }
  };

  const getFlagIcon = () => {
    if (!parameter.delta || parameter.delta.direction === 'none') return null;
    
    return parameter.delta.direction === 'up' ? (
      <ArrowUp className="w-3 h-3 text-red-500" />
    ) : (
      <ArrowDown className="w-3 h-3 text-blue-500" />
    );
  };

  return (
    <div 
      className={`inline-flex items-center space-x-1 px-2 py-1 rounded-md border text-xs font-medium ${getChipStyle()}`}
      title={`${parameter.name}: ${parameter.value}${parameter.units ? ' ' + parameter.units : ''}`}
    >
      <span className={compact ? 'max-w-[60px] truncate' : ''}>
        {compact ? parameter.value : `${parameter.name}: ${parameter.value}`}
      </span>
      {parameter.flag === 'critical' && <AlertCircle className="w-3 h-3" />}
      {parameter.flag === 'abnormal' && <AlertTriangle className="w-3 h-3" />}
      {getFlagIcon()}
    </div>
  );
};

// Status Icon Component
const StatusIcon: React.FC<{ status: string; flags: any }> = ({ status, flags }) => {
  if (flags.critical) {
    return <AlertCircle className="w-4 h-4 text-red-500" />;
  }
  
  switch (status) {
    case 'pending':
      return <Clock className="w-4 h-4 text-orange-500" />;
    case 'abnormal':
      return <AlertTriangle className="w-4 h-4 text-amber-500" />;
    case 'critical':
      return <AlertCircle className="w-4 h-4 text-red-500" />;
    default:
      return <CheckCircle className="w-4 h-4 text-green-500" />;
  }
};

// Delta Display Component
const DeltaDisplay: React.FC<{ delta?: VerificationParameter['delta'] }> = ({ delta }) => {
  if (!delta || delta.direction === 'none') {
    return <span className="text-gray-400">—</span>;
  }

  const icon = delta.direction === 'up' ? 
    <ArrowUp className="w-3 h-3 text-red-500" /> : 
    <ArrowDown className="w-3 h-3 text-blue-500" />;

  return (
    <div 
      className="flex items-center space-x-1 cursor-help"
      title={`${delta.percent}% ${delta.direction} from previous: ${delta.previousValue} (${delta.previousDate})`}
    >
      {icon}
      <span className="text-xs">{delta.percent}%</span>
    </div>
  );
};

// Results Table Row Component
const ResultRow: React.FC<{
  result: VerificationResult;
  isSelected: boolean;
  isFocused: boolean;
  isExpanded: boolean;
  onSelect: (id: string, selected: boolean) => void;
  onFocus: (result: VerificationResult) => void;
  onToggleExpand: (id: string) => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}> = ({ 
  result, 
  isSelected, 
  isFocused, 
  isExpanded, 
  onSelect, 
  onFocus, 
  onToggleExpand,
  onApprove,
  onReject
}) => {
  const keyParameters = result.parameters.slice(0, 4);
  
  const copyOrderId = () => {
    navigator.clipboard.writeText(result.order_id);
  };

  return (
    <>
      <tr 
        className={`
          border-b hover:bg-gray-50 cursor-pointer transition-colors
          ${isSelected ? 'bg-blue-50 border-blue-200' : ''}
          ${isFocused ? 'ring-2 ring-blue-300' : ''}
        `}
        onClick={() => onFocus(result)}
      >
        <td className="px-3 py-2">
          <input
            type="checkbox"
            checked={isSelected}
            onChange={(e) => onSelect(result.id, e.target.checked)}
            className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
          />
        </td>
        
        <td className="px-3 py-2">
          <div className="flex items-center space-x-2">
            <StatusIcon status={result.status} flags={result.flags} />
            {result.flags.critical && (
              <span className="bg-red-100 text-red-800 text-xs px-1 rounded font-medium">
                CRITICAL
              </span>
            )}
            {result.flags.repeat && (
              <span className="bg-orange-100 text-orange-800 text-xs px-1 rounded font-medium">
                REPEAT
              </span>
            )}
          </div>
        </td>
        
        <td className="px-3 py-2 font-medium">{result.test_name}</td>
        
        <td className="px-3 py-2">
          <div className="text-sm">
            <div className="font-medium">{result.patient.name}</div>
            <div className="text-gray-500">{result.patient.age}y, {result.patient.gender}</div>
          </div>
        </td>
        
        <td className="px-3 py-2">
          <div className="flex items-center space-x-1">
            <span className="text-sm font-mono">{result.order_id}</span>
            <button
              onClick={copyOrderId}
              className="p-1 hover:bg-gray-200 rounded"
              title="Copy Order ID"
            >
              <Copy className="w-3 h-3 text-gray-400" />
            </button>
          </div>
        </td>
        
        <td className="px-3 py-2">
          <div className="flex flex-wrap gap-1 max-w-[300px]">
            {keyParameters.map((param, idx) => (
              <ParameterChip key={idx} parameter={param} compact />
            ))}
            {result.parameters.length > 4 && (
              <span className="text-xs text-gray-500">+{result.parameters.length - 4} more</span>
            )}
          </div>
        </td>
        
        <td className="px-3 py-2">
          <DeltaDisplay delta={result.parameters[0]?.delta} />
        </td>
        
        <td className="px-3 py-2">
          <div className="flex flex-wrap gap-1">
            {result.audit_info.auto_calculated && (
              <span className="bg-blue-100 text-blue-800 text-xs px-1 rounded">Auto-calc</span>
            )}
            {result.audit_info.manually_edited && (
              <span className="bg-purple-100 text-purple-800 text-xs px-1 rounded">Manual</span>
            )}
            <span className="bg-gray-100 text-gray-800 text-xs px-1 rounded">
              {result.audit_info.source}
            </span>
          </div>
        </td>
        
        <td className="px-3 py-2 text-sm text-gray-600">
          {new Date(result.sample_time).toLocaleTimeString()}
        </td>
        
        <td className="px-3 py-2">
          <div className="flex items-center space-x-1">
            <button
              onClick={() => onToggleExpand(result.id)}
              className="p-1 hover:bg-gray-200 rounded"
              title="Expand/Collapse"
            >
              {isExpanded ? (
                <ChevronDown className="w-4 h-4" />
              ) : (
                <ChevronRight className="w-4 h-4" />
              )}
            </button>
            <button
              onClick={() => onApprove(result.id)}
              className="px-2 py-1 bg-green-100 text-green-700 hover:bg-green-200 rounded text-xs font-medium"
              title="Approve (A)"
            >
              Approve
            </button>
            <button
              onClick={() => onReject(result.id)}
              className="px-2 py-1 bg-red-100 text-red-700 hover:bg-red-200 rounded text-xs font-medium"
              title="Reject (R)"
            >
              Reject
            </button>
            <button className="p-1 hover:bg-gray-200 rounded" title="View Details (V)">
              <Eye className="w-4 h-4 text-gray-600" />
            </button>
          </div>
        </td>
      </tr>
      
      {/* Expanded Row */}
      {isExpanded && (
        <tr className="bg-gray-50">
          <td colSpan={10} className="px-3 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <h4 className="font-medium text-sm mb-2">All Parameters</h4>
                <div className="space-y-2">
                  {result.parameters.map((param, idx) => (
                    <div key={idx} className="flex justify-between items-center text-sm">
                      <span className="font-medium">{param.name}</span>
                      <div className="flex items-center space-x-2">
                        <ParameterChip parameter={param} />
                        {param.reference_range && (
                          <span className="text-gray-500 text-xs">
                            Ref: {param.reference_range}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              
              {result.images && result.images.length > 0 && (
                <div>
                  <h4 className="font-medium text-sm mb-2">Images</h4>
                  <div className="flex space-x-2">
                    {result.images.map((img, idx) => (
                      <img
                        key={idx}
                        src={img.thumb_url}
                        alt={img.type}
                        className="w-16 h-16 object-cover rounded border cursor-pointer hover:opacity-80"
                        title={`View ${img.type} image`}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
};

// Main Result Verification Console Component
const ResultVerificationConsole: React.FC = () => {
  // Use the verification console hook
  const {
    results,
    stats,
    loading,
    error,
    selectedIds,
    focusedResult,
    expandedRows,
    selectResult,
    selectAllResults,
    focusResult,
    toggleExpanded,
    approveResult,
    rejectResult,
    bulkApprove,
    bulkReject,
    setFilters
  } = useVerificationConsole();

  // Local state for filters and UI
  const [searchQuery, setSearchQuery] = useState('');
  const [dateFilter, setDateFilter] = useState('today');
  const [priorityFilter, setPriorityFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [verificationNotes, setVerificationNotes] = useState('');

  // Group results by Order ID and Test Group
  const groupedResults = React.useMemo(() => {
    const groups: { [orderId: string]: { [testGroup: string]: VerificationResult[] } } = {};
    
    results.forEach(result => {
      const orderId = result.order_id;
      const testGroup = result.test_group || 'Unknown Group';
      
      if (!groups[orderId]) {
        groups[orderId] = {};
      }
      if (!groups[orderId][testGroup]) {
        groups[orderId][testGroup] = [];
      }
      groups[orderId][testGroup].push(result);
    });
    
    return groups;
  }, [results]);

  // Update filters when filter values change
  useEffect(() => {
    const filters: VerificationFilters = {
      search: searchQuery,
      dateFilter: dateFilter as 'today' | 'last7days' | 'custom',
      priorityFilter,
      categoryFilter,
      showOnlyPending: true
    };
    setFilters(filters);
  }, [searchQuery, dateFilter, priorityFilter, categoryFilter, setFilters]);

  // Handlers
  const handleSelect = (id: string, selected: boolean) => {
    selectResult(id, selected);
  };

  const handleSelectAll = (selected: boolean) => {
    selectAllResults(selected);
  };

  const handleFocus = (result: VerificationResult) => {
    focusResult(result);
  };

  const handleToggleExpand = (id: string) => {
    toggleExpanded(id);
  };

  const handleApprove = async (id: string) => {
    const success = await approveResult(id, verificationNotes);
    if (success) {
      console.log('Result approved:', id);
      // Show success feedback
      const resultName = results.find(r => r.id === id)?.test_name || 'Result';
      // You can add a toast notification here
      alert(`✅ ${resultName} approved successfully!`);
    } else {
      alert('❌ Failed to approve result. Please try again.');
    }
  };

  const handleReject = async (id: string) => {
    if (!verificationNotes.trim()) {
      alert('Please provide a reason for rejection');
      return;
    }
    const success = await rejectResult(id, verificationNotes);
    if (success) {
      const resultName = results.find(r => r.id === id)?.test_name || 'Result';
      console.log('Result rejected:', id);
      alert(`❌ ${resultName} rejected successfully!`);
      setVerificationNotes('');
    } else {
      alert('❌ Failed to reject result. Please try again.');
    }
  };

  const handleBulkApprove = async () => {
    if (selectedIds.size === 0) return;
    const result = await bulkApprove(verificationNotes);
    if (result.success) {
      console.log(`Bulk approved ${result.successCount} results`);
      alert(`✅ Successfully approved ${result.successCount} results!`);
      setVerificationNotes('');
    } else {
      alert(`❌ Failed to approve ${result.failedIds.length} results`);
    }
  };

  const handleBulkReject = async () => {
    if (selectedIds.size === 0 || !verificationNotes.trim()) {
      alert('Please provide a reason for rejection');
      return;
    }
    const result = await bulkReject(verificationNotes);
    if (result.success) {
      console.log(`Bulk rejected ${result.successCount} results`);
      alert(`❌ Successfully rejected ${result.successCount} results!`);
      setVerificationNotes('');
    } else {
      alert(`❌ Failed to reject ${result.failedIds.length} results`);
    }
  };

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Global shortcuts
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        if (e.key === 'Escape') {
          (e.target as HTMLElement).blur();
        }
        return;
      }

      switch (e.key) {
        case 'a':
        case 'A':
          if (focusedResult) {
            handleApprove(focusedResult.id);
          }
          break;
        case 'r':
        case 'R':
          if (focusedResult) {
            handleReject(focusedResult.id);
          }
          break;
        case 'v':
        case 'V':
          if (focusedResult) {
            handleToggleExpand(focusedResult.id);
          }
          break;
        case 'n':
        case 'N':
          document.getElementById('verification-notes')?.focus();
          break;
        case 'Enter':
          if (e.ctrlKey || e.metaKey) {
            handleBulkApprove();
          }
          break;
        case 'Backspace':
          if (e.ctrlKey || e.metaKey) {
            handleBulkReject();
          }
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [focusedResult, selectedIds, verificationNotes]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <AlertCircle className="w-8 h-8 text-red-500 mx-auto mb-2" />
          <p className="text-red-600">{error}</p>
          <button 
            onClick={() => window.location.reload()} 
            className="mt-2 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-white">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-white border-b border-gray-200 px-6 py-4">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-2xl font-bold text-gray-900">Result Verification Console</h1>
          
          {/* Stats Bar */}
          <div className="flex items-center space-x-6 text-sm">
            <div className="flex items-center space-x-2">
              <span className="text-gray-600">Total:</span>
              <span className="font-semibold">{stats.total}</span>
            </div>
            <div className="flex items-center space-x-2">
              <span className="text-gray-600">Pending:</span>
              <span className="font-semibold text-orange-600">{stats.pending}</span>
            </div>
            <div className="flex items-center space-x-2">
              <span className="text-gray-600">Flagged:</span>
              <span className="font-semibold text-amber-600">{stats.flagged}</span>
            </div>
            <div className="flex items-center space-x-2">
              <span className="text-gray-600">Critical:</span>
              <span className="font-semibold text-red-600">{stats.critical}</span>
            </div>
          </div>
        </div>

        {/* Filters */}
        <div className="flex items-center space-x-4">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4" />
            <input
              type="text"
              placeholder="Search tests, patients, order IDs..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
          
          <select
            value={dateFilter}
            onChange={(e) => setDateFilter(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="today">Today</option>
            <option value="last7days">Last 7 days</option>
            <option value="custom">Custom</option>
          </select>
          
          <select
            value={priorityFilter}
            onChange={(e) => setPriorityFilter(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">All Priority</option>
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="normal">Normal</option>
          </select>
          
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">All Categories</option>
            <option value="blood-banking">Blood Banking</option>
            <option value="chemistry">Chemistry</option>
            <option value="hematology">Hematology</option>
          </select>
        </div>
      </div>

      {/* Body - Two Panes */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Pane - Results Table */}
        <div className="flex-1 overflow-auto">
          <table className="w-full">
            <thead className="bg-gray-50 sticky top-0">
              <tr>
                <th className="px-3 py-3 text-left">
                  <input
                    type="checkbox"
                    checked={selectedIds.size === results.length && results.length > 0}
                    onChange={(e) => handleSelectAll(e.target.checked)}
                    className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                </th>
                <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Test Name</th>
                <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Patient</th>
                <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Order ID</th>
                <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Key Parameters</th>
                <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Delta</th>
                <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Flags</th>
                <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Sample Time</th>
                <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {Object.entries(groupedResults).map(([orderId, testGroups]) => (
                <React.Fragment key={orderId}>
                  {/* Order Header */}
                  <tr className="bg-blue-50 border-t-2 border-blue-200">
                    <td colSpan={10} className="px-3 py-2">
                      <div className="flex items-center space-x-2">
                        <span className="font-semibold text-blue-800">Order ID: {orderId}</span>
                        {Object.values(testGroups).flat().length > 0 && (
                          <span className="text-sm text-blue-600">
                            ({Object.values(testGroups).flat().length} tests)
                          </span>
                        )}
                        <span className="text-sm text-blue-600">
                          Patient: {Object.values(testGroups).flat()[0]?.patient.name}
                        </span>
                      </div>
                    </td>
                  </tr>
                  
                  {/* Test Groups */}
                  {Object.entries(testGroups).map(([testGroup, groupResults]) => (
                    <React.Fragment key={`${orderId}-${testGroup}`}>
                      {/* Test Group Header */}
                      <tr className="bg-green-50">
                        <td colSpan={10} className="px-6 py-1">
                          <div className="flex items-center space-x-2">
                            <span className="text-sm font-medium text-green-800">
                              📊 {testGroup}
                            </span>
                            <span className="text-xs text-green-600">
                              ({groupResults.length} tests)
                            </span>
                          </div>
                        </td>
                      </tr>
                      
                      {/* Individual Test Results */}
                      {groupResults.map((result) => (
                        <ResultRow
                          key={result.id}
                          result={result}
                          isSelected={selectedIds.has(result.id)}
                          isFocused={focusedResult?.id === result.id}
                          isExpanded={expandedRows.has(result.id)}
                          onSelect={handleSelect}
                          onFocus={handleFocus}
                          onToggleExpand={handleToggleExpand}
                          onApprove={handleApprove}
                          onReject={handleReject}
                        />
                      ))}
                    </React.Fragment>
                  ))}
                </React.Fragment>
              ))}
              
              {/* Empty State */}
              {results.length === 0 && !loading && (
                <tr>
                  <td colSpan={10} className="px-6 py-8 text-center">
                    <div className="text-gray-500">
                      <CheckCircle className="w-8 h-8 mx-auto mb-2 text-green-500" />
                      <p className="text-lg font-medium">All results verified!</p>
                      <p className="text-sm">No pending verification results found.</p>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Right Pane - Verification Panel */}
        <div className="w-80 border-l border-gray-200 bg-gray-50 p-4 overflow-auto">
          <div className="space-y-4">
            {/* Verification Notes */}
            <div>
              <label htmlFor="verification-notes" className="block text-sm font-medium text-gray-700 mb-2">
                Verification Notes
              </label>
              <textarea
                id="verification-notes"
                value={verificationNotes}
                onChange={(e) => setVerificationNotes(e.target.value)}
                rows={4}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="Add verification notes..."
              />
              
              {/* Quick Note Chips */}
              <div className="flex flex-wrap gap-1 mt-2">
                {['Normal limits', 'Repeat required', 'Critical value', 'Delta check'].map((note) => (
                  <button
                    key={note}
                    onClick={() => setVerificationNotes(prev => prev + (prev ? ' ' : '') + note)}
                    className="px-2 py-1 text-xs bg-blue-100 text-blue-700 rounded hover:bg-blue-200"
                  >
                    {note}
                  </button>
                ))}
              </div>
            </div>

            {/* Batch Actions */}
            <div className="space-y-2">
              <h3 className="text-sm font-medium text-gray-700">
                Batch Actions ({selectedIds.size} selected)
              </h3>
              
              <div className="space-y-2">
                <button
                  onClick={handleBulkApprove}
                  disabled={selectedIds.size === 0}
                  className="w-full px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-sm font-medium"
                  title="Ctrl/Cmd + Enter"
                >
                  Approve Selected ({selectedIds.size})
                </button>
                
                <button
                  onClick={handleBulkReject}
                  disabled={selectedIds.size === 0 || !verificationNotes.trim()}
                  className="w-full px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-sm font-medium"
                  title="Ctrl/Cmd + Backspace"
                >
                  Reject Selected ({selectedIds.size})
                </button>
                
                <select className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm">
                  <option value="">Assign to...</option>
                  <option value="tech1">Lab Tech 1</option>
                  <option value="tech2">Lab Tech 2</option>
                  <option value="pathologist">Pathologist</option>
                </select>
              </div>
            </div>

            {/* Patient & Order Context */}
            {focusedResult && (
              <div className="bg-white rounded-lg p-4 border border-gray-200">
                <h3 className="text-sm font-medium text-gray-700 mb-3">Patient & Order Context</h3>
                
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-600">MRN:</span>
                    <span className="font-medium">{focusedResult.patient.mrn}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-600">Order Time:</span>
                    <span className="font-medium">
                      {new Date(focusedResult.sample_time).toLocaleString()}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-600">Sample ID:</span>
                    <span className="font-medium font-mono">{focusedResult.order_id}</span>
                  </div>
                  {focusedResult.collection_time && focusedResult.receipt_time && (
                    <div className="flex justify-between">
                      <span className="text-gray-600">Collection → Receipt:</span>
                      <span className="font-medium">
                        {Math.round((new Date(focusedResult.receipt_time).getTime() - 
                                   new Date(focusedResult.collection_time).getTime()) / 60000)} min
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Keyboard Shortcuts */}
            <div className="bg-white rounded-lg p-4 border border-gray-200">
              <h3 className="text-sm font-medium text-gray-700 mb-3">Keyboard Shortcuts</h3>
              <div className="space-y-1 text-xs text-gray-600">
                <div><kbd className="bg-gray-100 px-1 rounded">A</kbd> Approve focused</div>
                <div><kbd className="bg-gray-100 px-1 rounded">R</kbd> Reject focused</div>
                <div><kbd className="bg-gray-100 px-1 rounded">V</kbd> Toggle expand</div>
                <div><kbd className="bg-gray-100 px-1 rounded">N</kbd> Focus notes</div>
                <div><kbd className="bg-gray-100 px-1 rounded">Ctrl+Enter</kbd> Bulk approve</div>
                <div><kbd className="bg-gray-100 px-1 rounded">Ctrl+Backspace</kbd> Bulk reject</div>
                <div><kbd className="bg-gray-100 px-1 rounded">↑/↓</kbd> Navigate</div>
                <div><kbd className="bg-gray-100 px-1 rounded">Esc</kbd> Clear focus</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ResultVerificationConsole;