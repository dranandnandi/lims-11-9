import React, { useState } from 'react';
import { 
  CheckSquare, 
  Square, 
  Download, 
  Printer, 
  FileText, 
  CheckCircle, 
  XCircle, 
  Clock, 
  AlertTriangle,
  Users,
  Loader2,
  X
} from 'lucide-react';

interface BatchOperation {
  id: string;
  label: string;
  icon: React.ReactNode;
  color: 'blue' | 'green' | 'red' | 'yellow' | 'purple';
  description: string;
  requiresConfirmation?: boolean;
  confirmationMessage?: string;
}

interface BatchOperationsProps {
  selectedIds: string[];
  totalCount: number;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onBatchOperation: (operationId: string, selectedIds: string[]) => Promise<void>;
  operations?: BatchOperation[];
  show: boolean;
  onClose: () => void;
}

const BatchOperations: React.FC<BatchOperationsProps> = ({
  selectedIds,
  totalCount,
  onSelectAll,
  onClearSelection,
  onBatchOperation,
  operations = [],
  show,
  onClose
}) => {
  const [isExecuting, setIsExecuting] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState<string | null>(null);

  const defaultOperations: BatchOperation[] = [
    {
      id: 'approve',
      label: 'Approve Selected',
      icon: <CheckCircle className="h-4 w-4" />,
      color: 'green',
      description: 'Mark selected results as approved',
      requiresConfirmation: true,
      confirmationMessage: 'Are you sure you want to approve all selected results?'
    },
    {
      id: 'reject',
      label: 'Reject Selected',
      icon: <XCircle className="h-4 w-4" />,
      color: 'red',
      description: 'Reject selected results for review',
      requiresConfirmation: true,
      confirmationMessage: 'Are you sure you want to reject all selected results?'
    },
    {
      id: 'mark-reviewed',
      label: 'Mark as Reviewed',
      icon: <Clock className="h-4 w-4" />,
      color: 'blue',
      description: 'Mark selected results as reviewed',
      requiresConfirmation: true,
      confirmationMessage: 'Mark selected results as reviewed?'
    },
    {
      id: 'flag-urgent',
      label: 'Flag as Urgent',
      icon: <AlertTriangle className="h-4 w-4" />,
      color: 'yellow',
      description: 'Add urgent flag to selected results',
      requiresConfirmation: true,
      confirmationMessage: 'Flag selected results as urgent?'
    },
    {
      id: 'export-csv',
      label: 'Export to CSV',
      icon: <Download className="h-4 w-4" />,
      color: 'blue',
      description: 'Export selected results to CSV file'
    },
    {
      id: 'print-reports',
      label: 'Print Reports',
      icon: <Printer className="h-4 w-4" />,
      color: 'purple',
      description: 'Generate and print result reports'
    },
    {
      id: 'assign-reviewer',
      label: 'Assign Reviewer',
      icon: <Users className="h-4 w-4" />,
      color: 'blue',
      description: 'Assign selected results to a reviewer'
    }
  ];

  const allOperations = operations.length > 0 ? operations : defaultOperations;

  const getColorClasses = (color: string) => {
    switch (color) {
      case 'green':
        return 'bg-green-600 hover:bg-green-700 text-white';
      case 'red':
        return 'bg-red-600 hover:bg-red-700 text-white';
      case 'blue':
        return 'bg-blue-600 hover:bg-blue-700 text-white';
      case 'yellow':
        return 'bg-yellow-600 hover:bg-yellow-700 text-white';
      case 'purple':
        return 'bg-purple-600 hover:bg-purple-700 text-white';
      default:
        return 'bg-gray-600 hover:bg-gray-700 text-white';
    }
  };

  const handleOperation = async (operation: BatchOperation) => {
    if (operation.requiresConfirmation) {
      setShowConfirmation(operation.id);
      return;
    }

    await executeOperation(operation.id);
  };

  const executeOperation = async (operationId: string) => {
    setIsExecuting(true);
    try {
      await onBatchOperation(operationId, selectedIds);
      setShowConfirmation(null);
    } catch (error) {
      console.error('Batch operation failed:', error);
    } finally {
      setIsExecuting(false);
    }
  };

  if (!show) {
    return null;
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-4xl w-full mx-4 max-h-[90vh] overflow-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <div>
            <h2 className="text-xl font-semibold text-gray-900">Batch Operations</h2>
            <p className="text-sm text-gray-600 mt-1">
              {selectedIds.length} of {totalCount} items selected
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600"
          >
            <X className="h-6 w-6" />
          </button>
        </div>

        {/* Selection Controls */}
        <div className="p-6 bg-gray-50 border-b border-gray-200">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-4">
              <button
                onClick={onSelectAll}
                className="flex items-center space-x-2 px-3 py-2 border border-gray-300 rounded-md hover:bg-gray-100"
              >
                <CheckSquare className="h-4 w-4" />
                <span>Select All ({totalCount})</span>
              </button>
              
              <button
                onClick={onClearSelection}
                className="flex items-center space-x-2 px-3 py-2 border border-gray-300 rounded-md hover:bg-gray-100"
                disabled={selectedIds.length === 0}
              >
                <Square className="h-4 w-4" />
                <span>Clear Selection</span>
              </button>
            </div>

            <div className="text-sm text-gray-600">
              {selectedIds.length > 0 ? (
                <span className="font-medium text-blue-600">
                  {selectedIds.length} selected
                </span>
              ) : (
                'No items selected'
              )}
            </div>
          </div>
        </div>

        {/* Operations Grid */}
        <div className="p-6">
          <h3 className="text-lg font-medium text-gray-900 mb-4">Available Operations</h3>
          
          {selectedIds.length === 0 ? (
            <div className="text-center py-8">
              <CheckSquare className="h-12 w-12 text-gray-400 mx-auto mb-4" />
              <p className="text-gray-600">Select items to see available batch operations</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {allOperations.map((operation) => (
                <button
                  key={operation.id}
                  onClick={() => handleOperation(operation)}
                  disabled={isExecuting}
                  className={`p-4 rounded-lg border-2 border-gray-200 hover:border-gray-300 text-left transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                    isExecuting ? 'bg-gray-100' : 'bg-white hover:bg-gray-50'
                  }`}
                >
                  <div className="flex items-start space-x-3">
                    <div className={`p-2 rounded-lg ${getColorClasses(operation.color)}`}>
                      {operation.icon}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-gray-900">
                        {operation.label}
                      </div>
                      <div className="text-sm text-gray-600 mt-1">
                        {operation.description}
                      </div>
                      <div className="text-xs text-gray-500 mt-2">
                        Will affect {selectedIds.length} item{selectedIds.length !== 1 ? 's' : ''}
                      </div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Confirmation Modal */}
        {showConfirmation && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-60">
            <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4">
              <div className="p-6">
                <div className="flex items-center space-x-3 mb-4">
                  <AlertTriangle className="h-6 w-6 text-yellow-600" />
                  <h3 className="text-lg font-medium text-gray-900">Confirm Operation</h3>
                </div>
                
                <p className="text-gray-600 mb-6">
                  {allOperations.find(op => op.id === showConfirmation)?.confirmationMessage}
                </p>
                
                <div className="text-sm text-gray-500 mb-6">
                  This will affect <strong>{selectedIds.length}</strong> selected item{selectedIds.length !== 1 ? 's' : ''}.
                </div>

                <div className="flex space-x-3 justify-end">
                  <button
                    onClick={() => setShowConfirmation(null)}
                    className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50"
                    disabled={isExecuting}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => executeOperation(showConfirmation)}
                    disabled={isExecuting}
                    className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 flex items-center space-x-2"
                  >
                    {isExecuting && <Loader2 className="h-4 w-4 animate-spin" />}
                    <span>{isExecuting ? 'Processing...' : 'Confirm'}</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="px-6 py-4 bg-gray-50 border-t border-gray-200 flex justify-between items-center">
          <div className="text-sm text-gray-600">
            Batch operations are performed immediately and cannot be undone
          </div>
          <button
            onClick={onClose}
            className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-100"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default BatchOperations;