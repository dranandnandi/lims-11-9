import React from 'react';
import { X, Layers, TestTube, DollarSign, Clock, Settings, Edit, Beaker } from 'lucide-react';

interface TestGroup {
  id: string;
  name: string;
  code: string;
  category: string;
  clinicalPurpose: string;
  analytes: string[];
  price: number;
  turnaroundTime: string;
  sampleType: string;
  requiresFasting: boolean;
  isActive: boolean;
  createdDate: string;
}

interface Analyte {
  id: string;
  name: string;
  unit: string;
  referenceRange: string;
  category: string;
}

interface TestGroupDetailModalProps {
  testGroup: TestGroup;
  analytes: Analyte[];
  onClose: () => void;
  onEdit: () => void;
}

const TestGroupDetailModal: React.FC<TestGroupDetailModalProps> = ({ testGroup, analytes, onClose, onEdit }) => {
  const getCategoryColor = (category: string) => {
    const colors = {
      'Hematology': 'bg-red-100 text-red-800',
      'Biochemistry': 'bg-blue-100 text-blue-800',
      'Serology': 'bg-green-100 text-green-800',
      'Microbiology': 'bg-purple-100 text-purple-800',
      'Immunology': 'bg-orange-100 text-orange-800',
    };
    return colors[category as keyof typeof colors] || 'bg-gray-100 text-gray-800';
  };

  const includedAnalytes = analytes.filter(analyte => testGroup.analytes.includes(analyte.id));

  return (
    <div className="fixed inset-0 bg-gray-600 bg-opacity-75 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <h2 className="text-xl font-semibold text-gray-900 flex items-center">
            <Layers className="h-6 w-6 mr-2 text-green-600" />
            Test Group Details
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-500 p-1 rounded"
          >
            <X className="h-6 w-6" />
          </button>
        </div>

        <div className="p-6 space-y-6">
          {/* Test Group Summary */}
          <div className="bg-green-50 border border-green-200 rounded-lg p-6">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-2xl font-bold text-gray-900">{testGroup.name}</h3>
                <p className="text-gray-600">Code: {testGroup.code} • ID: {testGroup.id}</p>
                <div className="flex items-center space-x-4 mt-2">
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getCategoryColor(testGroup.category)}`}>
                    {testGroup.category}
                  </span>
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                    testGroup.isActive ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                  }`}>
                    {testGroup.isActive ? 'Active' : 'Inactive'}
                  </span>
                  {testGroup.requiresFasting && (
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-orange-100 text-orange-800">
                      Fasting Required
                    </span>
                  )}
                </div>
              </div>
              <div className="text-right">
                <div className="text-2xl font-bold text-green-600">₹{testGroup.price}</div>
                <div className="text-sm text-gray-600">Price</div>
              </div>
            </div>
          </div>

          {/* Test Group Information */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="bg-white border border-gray-200 rounded-lg p-6">
              <h4 className="text-lg font-semibold text-gray-900 mb-4 flex items-center">
                <Settings className="h-5 w-5 mr-2 text-blue-500" />
                Test Information
              </h4>
              <div className="space-y-3">
                <div>
                  <div className="text-sm text-gray-600">Sample Type</div>
                  <div className="font-medium text-gray-900">{testGroup.sampleType}</div>
                </div>
                <div>
                  <div className="text-sm text-gray-600">Turnaround Time</div>
                  <div className="font-medium text-gray-900">{testGroup.turnaroundTime}</div>
                </div>
                <div>
                  <div className="text-sm text-gray-600">Analytes Count</div>
                  <div className="font-medium text-gray-900">{testGroup.analytes.length} analytes</div>
                </div>
                <div>
                  <div className="text-sm text-gray-600">Created Date</div>
                  <div className="font-medium text-gray-900">{new Date(testGroup.createdDate).toLocaleDateString()}</div>
                </div>
              </div>
            </div>

            <div className="bg-white border border-gray-200 rounded-lg p-6">
              <h4 className="text-lg font-semibold text-gray-900 mb-4 flex items-center">
                <TestTube className="h-5 w-5 mr-2 text-purple-500" />
                Clinical Purpose
              </h4>
              <p className="text-gray-700">{testGroup.clinicalPurpose}</p>
            </div>
          </div>

          {/* Included Analytes */}
          <div className="bg-white border border-gray-200 rounded-lg p-6">
            <h4 className="text-lg font-semibold text-gray-900 mb-4 flex items-center">
              <Beaker className="h-5 w-5 mr-2 text-blue-500" />
              Included Analytes ({includedAnalytes.length})
            </h4>
            {includedAnalytes.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                        Analyte Name
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                        Unit
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                        Reference Range
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                        Category
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {includedAnalytes.map((analyte) => (
                      <tr key={analyte.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3 text-sm font-medium text-gray-900">
                          {analyte.name}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600">
                          {analyte.unit}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600">
                          {analyte.referenceRange}
                        </td>
                        <td className="px-4 py-3 text-sm">
                          <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getCategoryColor(analyte.category)}`}>
                            {analyte.category}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="text-gray-500 text-center py-4">No analytes found for this test group</div>
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
              className="flex items-center px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 transition-colors"
            >
              <Edit className="h-4 w-4 mr-2" />
              Edit Test Group
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TestGroupDetailModal;