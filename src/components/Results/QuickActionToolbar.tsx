import React, { useState } from 'react';
import { 
  RefreshCw, 
  Download, 
  Printer, 
  Settings, 
  Filter,
  CheckSquare,
  Plus,
  ChevronUp,
  ChevronDown,
  FileText,
  Users,
  Zap
} from 'lucide-react';

interface QuickAction {
  id: string;
  label: string;
  icon: React.ReactNode;
  color: 'blue' | 'green' | 'red' | 'yellow' | 'purple' | 'gray';
  shortcut?: string;
  onClick: () => void;
}

interface QuickActionToolbarProps {
  onRefresh: () => void;
  onBatchOperations: () => void;
  onExport: () => void;
  onPrint: () => void;
  onSettings: () => void;
  isLoading?: boolean;
  selectedCount?: number;
  customActions?: QuickAction[];
  position?: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
}

const QuickActionToolbar: React.FC<QuickActionToolbarProps> = ({
  onRefresh,
  onBatchOperations,
  onExport,
  onPrint,
  onSettings,
  isLoading = false,
  selectedCount = 0,
  customActions = [],
  position = 'bottom-right'
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [showTooltip, setShowTooltip] = useState<string | null>(null);

  const getPositionClasses = () => {
    switch (position) {
      case 'bottom-left':
        return 'bottom-6 left-6';
      case 'top-right':
        return 'top-6 right-6';
      case 'top-left':
        return 'top-6 left-6';
      default:
        return 'bottom-6 right-6';
    }
  };

  const getColorClasses = (color: string) => {
    switch (color) {
      case 'blue':
        return 'bg-blue-600 hover:bg-blue-700 text-white';
      case 'green':
        return 'bg-green-600 hover:bg-green-700 text-white';
      case 'red':
        return 'bg-red-600 hover:bg-red-700 text-white';
      case 'yellow':
        return 'bg-yellow-600 hover:bg-yellow-700 text-white';
      case 'purple':
        return 'bg-purple-600 hover:bg-purple-700 text-white';
      default:
        return 'bg-gray-600 hover:bg-gray-700 text-white';
    }
  };

  const defaultActions: QuickAction[] = [
    {
      id: 'refresh',
      label: 'Refresh Data',
      icon: <RefreshCw className={`h-5 w-5 ${isLoading ? 'animate-spin' : ''}`} />,
      color: 'blue',
      shortcut: 'Ctrl+R',
      onClick: onRefresh
    },
    {
      id: 'batch',
      label: `Batch Operations${selectedCount > 0 ? ` (${selectedCount})` : ''}`,
      icon: <CheckSquare className="h-5 w-5" />,
      color: selectedCount > 0 ? 'green' : 'gray',
      onClick: onBatchOperations
    },
    {
      id: 'export',
      label: 'Export Results',
      icon: <Download className="h-5 w-5" />,
      color: 'purple',
      shortcut: 'Ctrl+E',
      onClick: onExport
    },
    {
      id: 'print',
      label: 'Print Reports',
      icon: <Printer className="h-5 w-5" />,
      color: 'yellow',
      shortcut: 'Ctrl+P',
      onClick: onPrint
    },
    {
      id: 'settings',
      label: 'Settings',
      icon: <Settings className="h-5 w-5" />,
      color: 'gray',
      onClick: onSettings
    }
  ];

  const allActions = [...defaultActions, ...customActions];

  const handleKeyboardShortcuts = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey) {
      switch (e.key.toLowerCase()) {
        case 'r':
          e.preventDefault();
          onRefresh();
          break;
        case 'e':
          e.preventDefault();
          onExport();
          break;
        case 'p':
          e.preventDefault();
          onPrint();
          break;
      }
    }
  };

  React.useEffect(() => {
    document.addEventListener('keydown', handleKeyboardShortcuts);
    return () => document.removeEventListener('keydown', handleKeyboardShortcuts);
  }, []);

  const ActionButton: React.FC<{ action: QuickAction; isMain?: boolean }> = ({ 
    action, 
    isMain = false 
  }) => (
    <div className="relative">
      <button
        onClick={action.onClick}
        onMouseEnter={() => setShowTooltip(action.id)}
        onMouseLeave={() => setShowTooltip(null)}
        className={`
          ${isMain ? 'w-14 h-14' : 'w-12 h-12'} 
          rounded-full shadow-lg transition-all duration-200 transform hover:scale-105 
          ${getColorClasses(action.color)}
          ${isMain ? 'ring-4 ring-white' : ''}
        `}
        disabled={isLoading && action.id === 'refresh'}
      >
        {action.icon}
      </button>

      {/* Tooltip */}
      {showTooltip === action.id && (
        <div className={`
          absolute z-50 px-3 py-2 text-sm bg-gray-900 text-white rounded-lg shadow-lg whitespace-nowrap
          ${position.includes('right') ? 'right-full mr-3' : 'left-full ml-3'}
          ${position.includes('bottom') ? 'bottom-0' : 'top-0'}
        `}>
          <div className="flex items-center space-x-2">
            <span>{action.label}</span>
            {action.shortcut && (
              <span className="text-xs bg-gray-700 px-1 rounded">
                {action.shortcut}
              </span>
            )}
          </div>
          
          {/* Tooltip arrow */}
          <div className={`
            absolute w-2 h-2 bg-gray-900 transform rotate-45
            ${position.includes('right') ? 'right-0 translate-x-1' : 'left-0 -translate-x-1'}
            ${position.includes('bottom') ? 'bottom-3' : 'top-3'}
          `} />
        </div>
      )}
    </div>
  );

  return (
    <div className={`fixed ${getPositionClasses()} z-40`}>
      <div className="flex flex-col items-end space-y-3">
        {/* Secondary Actions (shown when expanded) */}
        {isExpanded && (
          <div className="flex flex-col space-y-3 animate-in slide-in-from-bottom-2 duration-200">
            {allActions.slice(1).map((action) => (
              <ActionButton key={action.id} action={action} />
            ))}
          </div>
        )}

        {/* Main Action Button */}
        <div className="relative">
          <ActionButton action={allActions[0]} isMain />
          
          {/* Expand/Collapse Button */}
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="absolute -top-2 -left-2 w-6 h-6 bg-white border-2 border-gray-200 rounded-full shadow-sm hover:bg-gray-50 transition-colors"
          >
            {isExpanded ? (
              <ChevronDown className="h-3 w-3 text-gray-600 mx-auto" />
            ) : (
              <ChevronUp className="h-3 w-3 text-gray-600 mx-auto" />
            )}
          </button>
        </div>

        {/* Selection Indicator */}
        {selectedCount > 0 && (
          <div className="bg-green-600 text-white text-xs px-2 py-1 rounded-full shadow-lg animate-pulse">
            {selectedCount} selected
          </div>
        )}
      </div>

      {/* Keyboard Shortcuts Help */}
      {isExpanded && (
        <div className={`
          absolute bg-white border border-gray-200 rounded-lg shadow-lg p-3 text-xs
          ${position.includes('right') ? 'right-full mr-3' : 'left-full ml-3'}
          ${position.includes('bottom') ? 'bottom-0' : 'top-0'}
          min-w-max
        `}>
          <div className="font-medium text-gray-900 mb-2">Keyboard Shortcuts</div>
          <div className="space-y-1 text-gray-600">
            <div className="flex justify-between space-x-4">
              <span>Refresh</span>
              <span className="font-mono bg-gray-100 px-1 rounded">Ctrl+R</span>
            </div>
            <div className="flex justify-between space-x-4">
              <span>Export</span>
              <span className="font-mono bg-gray-100 px-1 rounded">Ctrl+E</span>
            </div>
            <div className="flex justify-between space-x-4">
              <span>Print</span>
              <span className="font-mono bg-gray-100 px-1 rounded">Ctrl+P</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default QuickActionToolbar;