import React, { useState, useEffect } from 'react';
import { X, User, Calendar, TestTube, FileText, CheckCircle, AlertTriangle, Clock, Edit, Save, Plus } from 'lucide-react';
import { supabase } from '../../utils/supabase';
import { useAuth } from '../../contexts/AuthContext';
import PopoutInput from './PopoutInput';

interface Order {
  id: string;
  patient_id: string;
  patient_name: string;
  status: string;
  priority: string;
  order_date: string;
  expected_date: string;
  total_amount: number;
  doctor: string;
  sample_id?: string;
  color_code?: string;
  color_name?: string;
  sample_collected_at?: string;
  sample_collected_by?: string;
  patient?: {
    name?: string;
    age?: string;
    gender?: string;
  };
  tests: string[];
}

interface OrderDetailsModalProps {
  order: Order;
  onClose: () => void;
  onUpdateStatus: (newStatus: string) => void;
  onAfterSubmit?: () => void;
  onAfterSaveDraft?: () => void;
}

const OrderDetailsModal: React.FC<OrderDetailsModalProps> = ({
  order,
  onClose,
  onUpdateStatus,
  onAfterSubmit,
  onAfterSaveDraft
}) => {
  const { user } = useAuth();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'details' | 'results'>('details');
  
  // Sample collection state
  const [isCollecting, setIsCollecting] = useState(false);
  const [collectionError, setCollectionError] = useState<string | null>(null);

  // Clear messages after 3 seconds
  useEffect(() => {
    if (error || success) {
      const timer = setTimeout(() => {
        setError(null);
        setSuccess(null);
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [error, success]);

  const handleMarkSampleCollected = async () => {
    if (!order.id) {
      setCollectionError('Order ID is missing');
      return;
    }

    setIsCollecting(true);
    setCollectionError(null);

    try {
      const currentTime = new Date().toISOString();
      const collectedBy = user?.user_metadata?.full_name || user?.email || 'Unknown User';

      console.log('Marking sample as collected for order:', order.id);

      // Update the order with sample collection information
      const { data, error } = await supabase
        .from('orders')
        .update({
          sample_collected_at: currentTime,
          sample_collected_by: collectedBy,
          status: 'Sample Collected', // Update status to reflect collection
          status_updated_at: currentTime,
          status_updated_by: collectedBy
        })
        .eq('id', order.id)
        .select()
        .single();

      if (error) {
        console.error('Error updating order:', error);
        throw new Error(`Failed to mark sample as collected: ${error.message}`);
      }

      console.log('Sample collection marked successfully:', data);

      // Show success message
      setSuccess('Sample marked as collected successfully!');

      // Notify parent component of status change
      onUpdateStatus('Sample Collected');

      // Call the after submit callback if provided
      if (onAfterSubmit) {
        onAfterSubmit();
      }

    } catch (err) {
      console.error('Error in handleMarkSampleCollected:', err);
      setCollectionError(err instanceof Error ? err.message : 'Failed to mark sample as collected');
    } finally {
      setIsCollecting(false);
    }
  };

  const handleMarkSampleNotCollected = async () => {
    if (!order.id) {
      setCollectionError('Order ID is missing');
      return;
    }

    setIsCollecting(true);
    setCollectionError(null);

    try {
      const currentTime = new Date().toISOString();
      const updatedBy = user?.user_metadata?.full_name || user?.email || 'Unknown User';

      console.log('Marking sample as not collected for order:', order.id);

      // Update the order to remove sample collection information
      const { data, error } = await supabase
        .from('orders')
        .update({
          sample_collected_at: null,
          sample_collected_by: null,
          status: 'Sample Collection', // Revert status to pending collection
          status_updated_at: currentTime,
          status_updated_by: updatedBy
        })
        .eq('id', order.id)
        .select()
        .single();

      if (error) {
        console.error('Error updating order:', error);
        throw new Error(`Failed to mark sample as not collected: ${error.message}`);
      }

      console.log('Sample collection removed successfully:', data);

      // Show success message
      setSuccess('Sample collection status removed successfully!');

      // Notify parent component of status change
      onUpdateStatus('Sample Collection');

      // Call the after submit callback if provided
      if (onAfterSubmit) {
        onAfterSubmit();
      }

    } catch (err) {
      console.error('Error in handleMarkSampleNotCollected:', err);
      setCollectionError(err instanceof Error ? err.message : 'Failed to remove sample collection status');
    } finally {
      setIsCollecting(false);
    }
  };

  const getStatusColor = (status: string) => {
    const colors = {
      'Order Created': 'bg-gray-100 text-gray-800',
      'Sample Collection': 'bg-yellow-100 text-yellow-800',
      'Sample Collected': 'bg-blue-100 text-blue-800',
      'In Progress': 'bg-blue-100 text-blue-800',
      'Pending Approval': 'bg-orange-100 text-orange-800',
      'Completed': 'bg-green-100 text-green-800',
      'Delivered': 'bg-gray-100 text-gray-800'
    };
    return colors[status as keyof typeof colors] || 'bg-gray-100 text-gray-800';
  };

  const getPriorityColor = (priority: string) => {
    const colors = {
      'Normal': 'bg-gray-100 text-gray-800',
      'Urgent': 'bg-orange-100 text-orange-800',
      'STAT': 'bg-red-100 text-red-800'
    };
    return colors[priority as keyof typeof colors] || 'bg-gray-100 text-gray-800';
  };

  const isCollected = order.sample_collected_at && order.sample_collected_by;

  return (
    <div className="fixed inset-0 bg-gray-600 bg-opacity-75 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <div>
            <h2 className="text-xl font-semibold text-gray-900">Order Details</h2>
            <p className="text-sm text-gray-600 mt-1">Order ID: {order.id}</p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-500 p-1 rounded"
          >
            <X className="h-6 w-6" />
          </button>
        </div>

        {/* Tabs */}
        <div className="border-b border-gray-200">
          <nav className="flex space-x-8 px-6">
            <button
              onClick={() => setActiveTab('details')}
              className={`py-4 px-1 border-b-2 font-medium text-sm ${
                activeTab === 'details'
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Order Details
            </button>
            <button
              onClick={() => setActiveTab('results')}
              className={`py-4 px-1 border-b-2 font-medium text-sm ${
                activeTab === 'results'
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              AI Result Entry
            </button>
          </nav>
        </div>

        {/* Content */}
        <div className="p-6">
          {/* Success/Error Messages */}
          {success && (
            <div className="mb-4 p-4 bg-green-50 border border-green-200 rounded-lg">
              <div className="flex items-center">
                <CheckCircle className="h-5 w-5 text-green-500 mr-3" />
                <span className="text-green-700">{success}</span>
              </div>
            </div>
          )}

          {(error || collectionError) && (
            <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg">
              <div className="flex items-center">
                <AlertTriangle className="h-5 w-5 text-red-500 mr-3" />
                <span className="text-red-700">{error || collectionError}</span>
              </div>
            </div>
          )}

          {activeTab === 'details' && (
            <div className="space-y-6">
              {/* Patient Information */}
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                <h3 className="text-lg font-semibold text-blue-900 mb-3 flex items-center">
                  <User className="h-5 w-5 mr-2" />
                  Patient Information
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <div className="text-sm text-blue-700">Patient Name</div>
                    <div className="font-medium text-blue-900">{order.patient_name}</div>
                  </div>
                  <div>
                    <div className="text-sm text-blue-700">Patient ID</div>
                    <div className="font-medium text-blue-900">{order.patient_id}</div>
                  </div>
                  {order.patient?.age && (
                    <div>
                      <div className="text-sm text-blue-700">Age</div>
                      <div className="font-medium text-blue-900">{order.patient.age} years</div>
                    </div>
                  )}
                  {order.patient?.gender && (
                    <div>
                      <div className="text-sm text-blue-700">Gender</div>
                      <div className="font-medium text-blue-900">{order.patient.gender}</div>
                    </div>
                  )}
                </div>
              </div>

              {/* Order Information */}
              <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
                <h3 className="text-lg font-semibold text-gray-900 mb-3 flex items-center">
                  <FileText className="h-5 w-5 mr-2" />
                  Order Information
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <div className="text-sm text-gray-600">Order Date</div>
                    <div className="font-medium text-gray-900">
                      {new Date(order.order_date).toLocaleDateString()}
                    </div>
                  </div>
                  <div>
                    <div className="text-sm text-gray-600">Expected Date</div>
                    <div className="font-medium text-gray-900">
                      {new Date(order.expected_date).toLocaleDateString()}
                    </div>
                  </div>
                  <div>
                    <div className="text-sm text-gray-600">Status</div>
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusColor(order.status)}`}>
                      {order.status}
                    </span>
                  </div>
                  <div>
                    <div className="text-sm text-gray-600">Priority</div>
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getPriorityColor(order.priority)}`}>
                      {order.priority}
                    </span>
                  </div>
                  <div>
                    <div className="text-sm text-gray-600">Total Amount</div>
                    <div className="font-medium text-gray-900">₹{order.total_amount.toLocaleString()}</div>
                  </div>
                  <div>
                    <div className="text-sm text-gray-600">Referring Doctor</div>
                    <div className="font-medium text-gray-900">{order.doctor}</div>
                  </div>
                </div>
              </div>

              {/* Sample Information */}
              <div className="bg-purple-50 border border-purple-200 rounded-lg p-4">
                <h3 className="text-lg font-semibold text-purple-900 mb-3 flex items-center">
                  <TestTube className="h-5 w-5 mr-2" />
                  Sample Information
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <div className="text-sm text-purple-700">Sample ID</div>
                    <div className="font-medium text-purple-900">
                      {order.sample_id || 'Not assigned'}
                    </div>
                  </div>
                  <div>
                    <div className="text-sm text-purple-700">Sample Color</div>
                    <div className="flex items-center">
                      {order.color_code && (
                        <div
                          className="w-4 h-4 rounded-full mr-2 border border-gray-300"
                          style={{ backgroundColor: order.color_code }}
                        />
                      )}
                      <span className="font-medium text-purple-900">
                        {order.color_name || 'Not assigned'}
                      </span>
                    </div>
                  </div>
                  <div>
                    <div className="text-sm text-purple-700">Collection Status</div>
                    <div className="font-medium text-purple-900">
                      {isCollected ? (
                        <span className="flex items-center text-green-700">
                          <CheckCircle className="h-4 w-4 mr-1" />
                          Collected at {new Date(order.sample_collected_at!).toLocaleString()}
                        </span>
                      ) : (
                        <span className="flex items-center text-yellow-700">
                          <Clock className="h-4 w-4 mr-1" />
                          Pending Collection
                        </span>
                      )}
                    </div>
                  </div>
                  {isCollected && (
                    <div>
                      <div className="text-sm text-purple-700">Collected By</div>
                      <div className="font-medium text-purple-900">{order.sample_collected_by}</div>
                    </div>
                  )}
                </div>
              </div>

              {/* Tests Information */}
              <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                <h3 className="text-lg font-semibold text-green-900 mb-3 flex items-center">
                  <TestTube className="h-5 w-5 mr-2" />
                  Requested Tests ({order.tests.length})
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {order.tests.map((test, index) => (
                    <div key={index} className="bg-white border border-green-200 rounded p-3">
                      <div className="font-medium text-green-900">{test}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Quick Status Updates */}
              <div className="bg-white border border-gray-200 rounded-lg p-4">
                <h3 className="text-lg font-semibold text-gray-900 mb-4">Quick Status Updates</h3>
                
                <div className="flex flex-wrap gap-3">
                  {/* Sample Collection Button */}
                  {!isCollected ? (
                    <button
                      onClick={handleMarkSampleCollected}
                      disabled={isCollecting}
                      className="flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-blue-400 disabled:cursor-not-allowed transition-colors"
                    >
                      {isCollecting ? (
                        <>
                          <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent mr-2"></div>
                          Marking...
                        </>
                      ) : (
                        <>
                          <CheckCircle className="h-4 w-4 mr-2" />
                          Mark Sample Collected
                        </>
                      )}
                    </button>
                  ) : (
                    <button
                      onClick={handleMarkSampleNotCollected}
                      disabled={isCollecting}
                      className="flex items-center px-4 py-2 bg-yellow-600 text-white rounded-lg hover:bg-yellow-700 disabled:bg-yellow-400 disabled:cursor-not-allowed transition-colors"
                    >
                      {isCollecting ? (
                        <>
                          <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent mr-2"></div>
                          Updating...
                        </>
                      ) : (
                        <>
                          <X className="h-4 w-4 mr-2" />
                          Mark as Not Collected
                        </>
                      )}
                    </button>
                  )}

                  {/* Other status buttons */}
                  {order.status === 'Sample Collection' && isCollected && (
                    <button
                      onClick={() => onUpdateStatus('In Progress')}
                      className="flex items-center px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
                    >
                      <TestTube className="h-4 w-4 mr-2" />
                      Start Processing
                    </button>
                  )}

                  {order.status === 'In Progress' && (
                    <button
                      onClick={() => onUpdateStatus('Pending Approval')}
                      className="flex items-center px-4 py-2 bg-orange-600 text-white rounded-lg hover:bg-orange-700 transition-colors"
                    >
                      <FileText className="h-4 w-4 mr-2" />
                      Submit for Approval
                    </button>
                  )}

                  {order.status === 'Pending Approval' && (
                    <button
                      onClick={() => onUpdateStatus('Completed')}
                      className="flex items-center px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors"
                    >
                      <CheckCircle className="h-4 w-4 mr-2" />
                      Mark Completed
                    </button>
                  )}

                  {order.status === 'Completed' && (
                    <button
                      onClick={() => onUpdateStatus('Delivered')}
                      className="flex items-center px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700 transition-colors"
                    >
                      <FileText className="h-4 w-4 mr-2" />
                      Mark Delivered
                    </button>
                  )}
                </div>

                {/* Collection Error Display */}
                {collectionError && (
                  <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg">
                    <div className="flex items-center">
                      <AlertTriangle className="h-4 w-4 text-red-500 mr-2" />
                      <span className="text-red-700 text-sm">{collectionError}</span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'results' && (
            <div className="space-y-6">
              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                <div className="flex items-center">
                  <AlertTriangle className="h-5 w-5 text-yellow-500 mr-3" />
                  <div>
                    <h4 className="font-medium text-yellow-900">AI Result Entry</h4>
                    <p className="text-sm text-yellow-700 mt-1">
                      This feature is under development. Use the main Results page for result entry.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end space-x-4 p-6 border-t border-gray-200">
          <button
            onClick={onClose}
            className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default OrderDetailsModal;