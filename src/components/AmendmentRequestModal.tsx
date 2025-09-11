import React, { useState } from 'react';
import { X, AlertTriangle, FileText } from 'lucide-react';
import { requestResultAmendment } from '../utils/securityService';
import { ResultWithSecurity } from '../types/security';

interface AmendmentRequestModalProps {
  isOpen: boolean;
  onClose: () => void;
  result: ResultWithSecurity;
  onSuccess?: (noteId: string) => void;
}

export const AmendmentRequestModal: React.FC<AmendmentRequestModalProps> = ({
  isOpen,
  onClose,
  result,
  onSuccess
}) => {
  const [reason, setReason] = useState('');
  const [proposedChanges, setProposedChanges] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!reason.trim()) {
      setError('Please provide a reason for the amendment');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const proposedChangesObj = proposedChanges.trim() 
        ? { changes_description: proposedChanges }
        : {};

      const noteId = await requestResultAmendment({
        result_id: result.id,
        reason: reason.trim(),
        proposed_changes: proposedChangesObj
      });

      if (noteId) {
        onSuccess?.(noteId);
        onClose();
        // Reset form
        setReason('');
        setProposedChanges('');
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to submit amendment request');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md mx-4">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <div className="flex items-center space-x-2">
            <AlertTriangle className="w-5 h-5 text-orange-500" />
            <h2 className="text-lg font-semibold text-gray-900">Request Amendment</h2>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        {/* Content */}
        <form onSubmit={handleSubmit} className="p-6">
          <div className="mb-4">
            <div className="bg-orange-50 border border-orange-200 rounded-md p-3 mb-4">
              <div className="flex items-start space-x-2">
                <AlertTriangle className="w-4 h-4 text-orange-500 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-orange-800">Result is Locked</p>
                  <p className="text-sm text-orange-700">
                    This result is {result.verification_status === 'verified' ? 'verified' : 'locked'} 
                    {result.locked_reason && ` (${result.locked_reason})`}. 
                    Amendment requests require supervisor approval.
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div className="mb-4">
            <label htmlFor="reason" className="block text-sm font-medium text-gray-700 mb-2">
              Reason for Amendment <span className="text-red-500">*</span>
            </label>
            <textarea
              id="reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              rows={3}
              placeholder="Explain why this result needs to be amended..."
              required
            />
          </div>

          <div className="mb-6">
            <label htmlFor="changes" className="block text-sm font-medium text-gray-700 mb-2">
              Proposed Changes
            </label>
            <textarea
              id="changes"
              value={proposedChanges}
              onChange={(e) => setProposedChanges(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              rows={4}
              placeholder="Describe the specific changes needed (optional)..."
            />
          </div>

          {error && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-md">
              <p className="text-sm text-red-700">{error}</p>
            </div>
          )}

          {/* Footer */}
          <div className="flex justify-end space-x-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-md transition-colors"
              disabled={isSubmitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting || !reason.trim()}
              className="px-4 py-2 text-sm font-medium text-white bg-orange-500 hover:bg-orange-600 disabled:bg-gray-300 disabled:cursor-not-allowed rounded-md transition-colors flex items-center space-x-2"
            >
              {isSubmitting ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                  <span>Submitting...</span>
                </>
              ) : (
                <>
                  <FileText className="w-4 h-4" />
                  <span>Submit Request</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default AmendmentRequestModal;