import React, { useState } from 'react';
import { X, TestTube, DollarSign, Clock, Settings } from 'lucide-react';
import { SAMPLE_TYPES } from '../../utils/sampleTypes';

interface TestFormProps {
  onClose: () => void;
  onSubmit: (data: any) => void;
  test?: Test | null;
}

interface Test {
  id: string;
  name: string;
  category: string;
  method: string;
  sampleType: string;
  price: number;
  turnaroundTime: string;
  referenceRange: string;
  units: string;
  description: string;
  isActive: boolean;
  requiresFasting: boolean;
  criticalValues: string;
  interpretation: string;
  createdDate: string;
}

const TestForm: React.FC<TestFormProps> = ({ onClose, onSubmit, test }) => {
  const [formData, setFormData] = useState({
    name: test?.name || '',
    category: test?.category || '',
    method: test?.method || '',
    sampleType: test?.sampleType || '',
    price: test?.price?.toString() || '',
    turnaroundTime: test?.turnaroundTime || '',
    referenceRange: test?.referenceRange || '',
    units: test?.units || '',
    description: test?.description || '',
    isActive: test?.isActive ?? true,
    requiresFasting: test?.requiresFasting ?? false,
    criticalValues: test?.criticalValues || '',
    interpretation: test?.interpretation || '',
  });

  const categories = [
    'Hematology',
    'Biochemistry', 
    'Serology',
    'Microbiology',
    'Immunology',
    'Molecular Biology',
    'Histopathology',
    'Cytology',
    'Radiology',
  ];

  const sampleTypes = SAMPLE_TYPES;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit(formData);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value, type } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: type === 'checkbox' ? (e.target as HTMLInputElement).checked : value
    }));
  };

  return (
    <div className="fixed inset-0 bg-gray-600 bg-opacity-75 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <h2 className="text-xl font-semibold text-gray-900">
            {test ? 'Edit Test' : 'Add New Test'}
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-500 p-1 rounded"
          >
            <X className="h-6 w-6" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-6">
          {/* Basic Information */}
          <div className="space-y-4">
            <h3 className="text-lg font-medium text-gray-900 flex items-center">
              <TestTube className="h-5 w-5 mr-2" />
              Basic Information
            </h3>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Test Name *
                </label>
                <input
                  type="text"
                  name="name"
                  required
                  value={formData.name}
                  onChange={handleChange}
                  placeholder="e.g., Complete Blood Count"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Category *
                </label>
                <select
                  name="category"
                  required
                  value={formData.category}
                  onChange={handleChange}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                >
                  <option value="">Select Category</option>
                  {categories.map(category => (
                    <option key={category} value={category}>{category}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Method *
                </label>
                <input
                  type="text"
                  name="method"
                  required
                  value={formData.method}
                  onChange={handleChange}
                  placeholder="e.g., Automated Cell Counter"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Sample Type *
                </label>
                <select
                  name="sampleType"
                  required
                  value={formData.sampleType}
                  onChange={handleChange}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                >
                  <option value="">Select Sample Type</option>
                  {sampleTypes.map(type => (
                    <option key={type} value={type}>{type}</option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Description
              </label>
              <textarea
                name="description"
                rows={2}
                value={formData.description}
                onChange={handleChange}
                placeholder="Brief description of the test"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
          </div>

          {/* Pricing & Timing */}
          <div className="space-y-4">
            <h3 className="text-lg font-medium text-gray-900 flex items-center">
              <DollarSign className="h-5 w-5 mr-2" />
              Pricing & Timing
            </h3>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Price (₹) *
                </label>
                <input
                  type="number"
                  name="price"
                  required
                  min="0"
                  step="0.01"
                  value={formData.price}
                  onChange={handleChange}
                  placeholder="0.00"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Turnaround Time *
                </label>
                <input
                  type="text"
                  name="turnaroundTime"
                  required
                  value={formData.turnaroundTime}
                  onChange={handleChange}
                  placeholder="e.g., 2-4 hours, Same day"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
            </div>
          </div>

          {/* Clinical Information */}
          <div className="space-y-4">
            <h3 className="text-lg font-medium text-gray-900 flex items-center">
              <Clock className="h-5 w-5 mr-2" />
              Clinical Information
            </h3>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Reference Range *
                </label>
                <input
                  type="text"
                  name="referenceRange"
                  required
                  value={formData.referenceRange}
                  onChange={handleChange}
                  placeholder="e.g., 4.0-11.0 x10³/μL"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Units
                </label>
                <input
                  type="text"
                  name="units"
                  value={formData.units}
                  onChange={handleChange}
                  placeholder="e.g., mg/dL, mmol/L"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Critical Values
              </label>
              <input
                type="text"
                name="criticalValues"
                value={formData.criticalValues}
                onChange={handleChange}
                placeholder="Values that require immediate attention"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Clinical Interpretation
              </label>
              <textarea
                name="interpretation"
                rows={3}
                value={formData.interpretation}
                onChange={handleChange}
                placeholder="Guidelines for interpreting results"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
          </div>

          {/* Test Settings */}
          <div className="space-y-4">
            <h3 className="text-lg font-medium text-gray-900 flex items-center">
              <Settings className="h-5 w-5 mr-2" />
              Test Settings
            </h3>
            
            <div className="space-y-3">
              <label className="flex items-center">
                <input
                  type="checkbox"
                  name="isActive"
                  checked={formData.isActive}
                  onChange={handleChange}
                  className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                />
                <span className="ml-2 text-sm text-gray-700">Test is active and available for ordering</span>
              </label>
              
              <label className="flex items-center">
                <input
                  type="checkbox"
                  name="requiresFasting"
                  checked={formData.requiresFasting}
                  onChange={handleChange}
                  className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                />
                <span className="ml-2 text-sm text-gray-700">Requires fasting</span>
              </label>
            </div>
          </div>

          {/* Form Actions */}
          <div className="flex items-center justify-end space-x-4 pt-6 border-t border-gray-200">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
            >
              {test ? 'Update Test' : 'Add Test'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default TestForm;
