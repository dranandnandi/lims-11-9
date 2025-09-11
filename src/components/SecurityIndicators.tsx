import React from 'react';
import { Lock, CheckCircle, AlertTriangle, Edit, FileText } from 'lucide-react';
import { SecurityIndicator as SecurityIndicatorType, ResultWithSecurity } from '../types/security';
import { getSecurityIndicator } from '../utils/securityService';

interface SecurityIndicatorProps {
  result: ResultWithSecurity;
  onAmendmentRequest?: (resultId: string) => void;
  onViewAudit?: (resultId: string) => void;
  showActions?: boolean;
}

export const SecurityIndicator: React.FC<SecurityIndicatorProps> = ({
  result,
  onAmendmentRequest,
  onViewAudit,
  showActions = true
}) => {
  const indicator = getSecurityIndicator(result);

  const getIcon = () => {
    switch (indicator.status) {
      case 'verified_locked':
        return <CheckCircle className="w-4 h-4" />;
      case 'report_locked':
        return <Lock className="w-4 h-4" />;
      case 'needs_amendment':
        return <AlertTriangle className="w-4 h-4" />;
      default:
        return <Edit className="w-4 h-4" />;
    }
  };

  const getColorClasses = () => {
    switch (indicator.status) {
      case 'verified_locked':
        return 'text-green-600 bg-green-50 border-green-200';
      case 'report_locked':
        return 'text-red-600 bg-red-50 border-red-200';
      case 'needs_amendment':
        return 'text-orange-600 bg-orange-50 border-orange-200';
      default:
        return 'text-gray-600 bg-gray-50 border-gray-200';
    }
  };

  return (
    <div className={`inline-flex items-center space-x-2 px-2 py-1 rounded-md border text-xs font-medium ${getColorClasses()}`}>
      {getIcon()}
      <span>{indicator.message}</span>
      
      {showActions && (
        <div className="flex items-center space-x-1 ml-2">
          {indicator.canAmend && onAmendmentRequest && (
            <button
              onClick={() => onAmendmentRequest(result.id)}
              className="text-xs underline hover:no-underline"
              title="Request Amendment"
            >
              Amend
            </button>
          )}
          
          {onViewAudit && (
            <button
              onClick={() => onViewAudit(result.id)}
              className="p-1 hover:bg-white/50 rounded"
              title="View Audit Trail"
            >
              <FileText className="w-3 h-3" />
            </button>
          )}
        </div>
      )}
    </div>
  );
};

interface ResultValueSecurityWrapperProps {
  result: ResultWithSecurity;
  children: React.ReactNode;
  className?: string;
}

export const ResultValueSecurityWrapper: React.FC<ResultValueSecurityWrapperProps> = ({
  result,
  children,
  className = ''
}) => {
  const indicator = getSecurityIndicator(result);
  
  return (
    <div className={`relative ${className}`}>
      {children}
      
      {!indicator.canEdit && (
        <div className="absolute inset-0 bg-gray-100/50 flex items-center justify-center rounded">
          <div className="text-xs text-gray-500 font-medium flex items-center space-x-1">
            <Lock className="w-3 h-3" />
            <span>Locked</span>
          </div>
        </div>
      )}
    </div>
  );
};

interface SecurityBadgeProps {
  result: ResultWithSecurity;
  size?: 'sm' | 'md' | 'lg';
}

export const SecurityBadge: React.FC<SecurityBadgeProps> = ({
  result,
  size = 'sm'
}) => {
  const indicator = getSecurityIndicator(result);
  
  const sizeClasses = {
    sm: 'w-3 h-3',
    md: 'w-4 h-4',
    lg: 'w-5 h-5'
  };
  
  const getStatusColor = () => {
    switch (indicator.status) {
      case 'verified_locked':
        return 'text-green-500';
      case 'report_locked':
        return 'text-red-500';
      case 'needs_amendment':
        return 'text-orange-500';
      default:
        return 'text-gray-500';
    }
  };

  return (
    <div className={`${getStatusColor()} ${sizeClasses[size]}`} title={indicator.message}>
      {indicator.status === 'verified_locked' && <CheckCircle className="w-full h-full" />}
      {indicator.status === 'report_locked' && <Lock className="w-full h-full" />}
      {indicator.status === 'needs_amendment' && <AlertTriangle className="w-full h-full" />}
      {indicator.status === 'editable' && <Edit className="w-full h-full" />}
    </div>
  );
};

export default {
  SecurityIndicator,
  ResultValueSecurityWrapper,
  SecurityBadge
};