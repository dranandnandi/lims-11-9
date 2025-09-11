import React from 'react';

interface PDFProgressModalProps {
  isVisible: boolean;
  stage: string;
  progress: number;
  onClose?: () => void;
}

const PDFProgressModal: React.FC<PDFProgressModalProps> = ({
  isVisible,
  stage,
  progress,
  onClose
}) => {
  if (!isVisible) return null;

  const isComplete = progress >= 100;
  const isFailed = stage.toLowerCase().includes('failed');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
      <div className="bg-white rounded-lg shadow-xl p-6 w-96 max-w-sm mx-4">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-gray-900">
            {isComplete ? '✅ PDF Ready!' : isFailed ? '❌ Generation Failed' : '📄 Generating PDF...'}
          </h3>
          {(isComplete || isFailed) && onClose && (
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 transition-colors"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        {/* Progress Bar */}
        {!isFailed && (
          <div className="mb-4">
            <div className="flex justify-between items-center mb-2">
              <span className="text-sm font-medium text-gray-700">Progress</span>
              <span className="text-sm text-gray-500">{Math.round(progress)}%</span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-2">
              <div
                className={`h-2 rounded-full transition-all duration-300 ${
                  isComplete 
                    ? 'bg-green-500' 
                    : 'bg-blue-500'
                }`}
                style={{ width: `${Math.min(progress, 100)}%` }}
              />
            </div>
          </div>
        )}

        {/* Status Message */}
        <div className="mb-4">
          <p className={`text-sm ${
            isFailed 
              ? 'text-red-600' 
              : isComplete 
                ? 'text-green-600' 
                : 'text-gray-600'
          }`}>
            {stage}
          </p>
        </div>

        {/* Loading Animation */}
        {!isComplete && !isFailed && (
          <div className="flex items-center justify-center mb-4">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
          </div>
        )}

        {/* Success Actions */}
        {isComplete && (
          <div className="flex space-x-3">
            <button
              onClick={onClose}
              className="flex-1 bg-green-500 hover:bg-green-600 text-white font-medium py-2 px-4 rounded-md transition-colors"
            >
              ✓ Done
            </button>
          </div>
        )}

        {/* Error Actions */}
        {isFailed && (
          <div className="flex space-x-3">
            <button
              onClick={onClose}
              className="flex-1 bg-red-500 hover:bg-red-600 text-white font-medium py-2 px-4 rounded-md transition-colors"
            >
              Close
            </button>
          </div>
        )}

        {/* Processing Steps Indicator */}
        {!isFailed && (
          <div className="mt-4 pt-4 border-t border-gray-200">
            <div className="text-xs text-gray-500 space-y-1">
              <div className={`flex items-center ${progress >= 5 ? 'text-green-600' : 'text-gray-400'}`}>
                <span className="mr-2">{progress >= 5 ? '✓' : '○'}</span>
                Authentication
              </div>
              <div className={`flex items-center ${progress >= 25 ? 'text-green-600' : 'text-gray-400'}`}>
                <span className="mr-2">{progress >= 25 ? '✓' : '○'}</span>
                PDF Generation
              </div>
              <div className={`flex items-center ${progress >= 40 ? 'text-green-600' : 'text-gray-400'}`}>
                <span className="mr-2">{progress >= 40 ? '✓' : '○'}</span>
                Download from Server
              </div>
              <div className={`flex items-center ${progress >= 85 ? 'text-green-600' : 'text-gray-400'}`}>
                <span className="mr-2">{progress >= 85 ? '✓' : '○'}</span>
                Upload to Storage
              </div>
              <div className={`flex items-center ${progress >= 100 ? 'text-green-600' : 'text-gray-400'}`}>
                <span className="mr-2">{progress >= 100 ? '✓' : '○'}</span>
                Complete
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default PDFProgressModal;