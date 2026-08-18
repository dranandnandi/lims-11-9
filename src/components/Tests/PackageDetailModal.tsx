import React from 'react';
import { X, Package, DollarSign, Calendar, Settings, Edit, Layers, Clock } from 'lucide-react';

interface PackageType {
  id: string;
  name: string;
  description: string;
  testGroupIds: string[];
  price: number;
  discountPercentage?: number;
  isActive: boolean;
  createdDate: string;
  category: string;
  validityDays?: number;
}

interface TestGroup {
  id: string;
  name: string;
  code: string;
  category: string;
  price: number;
  turnaroundTime: string;
  sampleType: string;
  requiresFasting: boolean;
}

interface PackageDetailModalProps {
  package: PackageType;
  testGroups: TestGroup[];
  onClose: () => void;
  onEdit: () => void;
}

const PackageDetailModal: React.FC<PackageDetailModalProps> = ({ package: pkg, testGroups, onClose, onEdit }) => {
  const testGroupIds = pkg.testGroupIds || [];
  // Keep the package's own order (testGroupIds is already sorted by display_order)
  const includedGroups = testGroupIds
    .map(id => testGroups.find(group => group.id === id))
    .filter(Boolean) as TestGroup[];
  const originalPrice = includedGroups.reduce((sum, group) => sum + group.price, 0);
  const savings = originalPrice - pkg.price;
  const actualDiscount = originalPrice > 0 ? ((savings / originalPrice) * 100) : 0;

  return (
    <div className="fixed inset-0 bg-gray-600 bg-opacity-75 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <h2 className="text-xl font-semibold text-gray-900 flex items-center">
            <Package className="h-6 w-6 mr-2 text-purple-600" />
            Package Details
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-500 p-1 rounded"
          >
            <X className="h-6 w-6" />
          </button>
        </div>

        <div className="p-6 space-y-6">
          {/* Package Summary */}
          <div className="bg-purple-50 border border-purple-200 rounded-lg p-6">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-2xl font-bold text-gray-900">{pkg.name}</h3>
                <p className="text-gray-600">Package ID: {pkg.id}</p>
                <div className="flex items-center space-x-4 mt-2">
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-800">
                    {pkg.category}
                  </span>
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                    pkg.isActive ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                  }`}>
                    {pkg.isActive ? 'Active' : 'Inactive'}
                  </span>
                  {pkg.validityDays && (
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                      {pkg.validityDays} days validity
                    </span>
                  )}
                </div>
              </div>
              <div className="text-right">
                <div className="text-2xl font-bold text-purple-600">₹{pkg.price}</div>
                <div className="text-sm text-gray-600">Package Price</div>
                {savings > 0 && (
                  <div className="text-sm text-green-600 font-medium">
                    Save ₹{savings} ({actualDiscount.toFixed(1)}%)
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Package Information */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="bg-white border border-gray-200 rounded-lg p-6">
              <h4 className="text-lg font-semibold text-gray-900 mb-4 flex items-center">
                <Settings className="h-5 w-5 mr-2 text-blue-500" />
                Package Information
              </h4>
              <div className="space-y-3">
                <div>
                  <div className="text-sm text-gray-600">Test Groups Included</div>
                  <div className="font-medium text-gray-900">{pkg.testGroupIds.length} groups</div>
                </div>
                <div>
                  <div className="text-sm text-gray-600">Validity Period</div>
                  <div className="font-medium text-gray-900">{pkg.validityDays || 30} days</div>
                </div>
                <div>
                  <div className="text-sm text-gray-600">Discount Percentage</div>
                  <div className="font-medium text-gray-900">{pkg.discountPercentage || 0}%</div>
                </div>
                <div>
                  <div className="text-sm text-gray-600">Created Date</div>
                  <div className="font-medium text-gray-900">{new Date(pkg.createdDate).toLocaleDateString()}</div>
                </div>
              </div>
            </div>

            <div className="bg-white border border-gray-200 rounded-lg p-6">
              <h4 className="text-lg font-semibold text-gray-900 mb-4 flex items-center">
                <DollarSign className="h-5 w-5 mr-2 text-green-500" />
                Pricing Breakdown
              </h4>
              <div className="space-y-3">
                <div className="flex justify-between">
                  <span className="text-gray-600">Original Price:</span>
                  <span className="font-medium text-gray-900">₹{originalPrice}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Package Price:</span>
                  <span className="font-medium text-gray-900">₹{pkg.price}</span>
                </div>
                <div className="flex justify-between border-t border-gray-200 pt-2">
                  <span className="text-green-600 font-medium">Total Savings:</span>
                  <span className="font-bold text-green-600">₹{savings}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-blue-600">Effective Discount:</span>
                  <span className="font-medium text-blue-600">{actualDiscount.toFixed(1)}%</span>
                </div>
              </div>
            </div>
          </div>

          {/* Description */}
          <div className="bg-white border border-gray-200 rounded-lg p-6">
            <h4 className="text-lg font-semibold text-gray-900 mb-4">Package Description</h4>
            <p className="text-gray-700">{pkg.description}</p>
          </div>

          {/* Included Test Groups */}
          <div className="bg-white border border-gray-200 rounded-lg p-6">
            <h4 className="text-lg font-semibold text-gray-900 mb-4 flex items-center">
              <Layers className="h-5 w-5 mr-2 text-green-500" />
              Included Test Groups ({includedGroups.length})
            </h4>
            {includedGroups.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                        Test Group
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                        Code
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                        Sample Type
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                        TAT
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                        Individual Price
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {includedGroups.map((group) => (
                      <tr key={group.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3 text-sm font-medium text-gray-900">
                          <div>
                            <div>{group.name}</div>
                            {group.requiresFasting && (
                              <span className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-orange-100 text-orange-800 mt-1">
                                Fasting Required
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600">
                          {group.code}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600">
                          {group.sampleType}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600">
                          {group.turnaroundTime}
                        </td>
                        <td className="px-4 py-3 text-sm font-medium text-gray-900">
                          ₹{group.price}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="text-gray-500 text-center py-4">No test groups found for this package</div>
            )}
          </div>

          {/* Action Buttons */}
          <div className="flex items-center justify-end space-x-4 pt-6 border-t border-gray-200">
            <button
              onClick={onClose}
              className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50 transition-colors"
            >
              Close
            </button>
            <button
              onClick={onEdit}
              className="flex items-center px-4 py-2 bg-purple-600 text-white rounded-md hover:bg-purple-700 transition-colors"
            >
              <Edit className="h-4 w-4 mr-2" />
              Edit Package
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default PackageDetailModal;