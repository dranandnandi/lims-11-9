import React, { useState, useEffect, useMemo } from 'react';
import { X, Package, DollarSign, Calendar, Settings, Layers, Search, Check, ChevronDown, ChevronUp, ArrowUp, ArrowDown, GripVertical } from 'lucide-react';
import { database } from '../../utils/supabase';

interface PackageFormProps {
  onClose: () => void;
  onSubmit: (data: any) => void;
  package?: Package | null;
}

interface Package {
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
  clinical_purpose?: string;
  turnaround_time?: string;
  sample_type?: string;
  test_group_analytes?: any[];
}

const PackageForm: React.FC<PackageFormProps> = ({ onClose, onSubmit, package: pkg }) => {
  const [formData, setFormData] = useState({
    name: pkg?.name || '',
    description: pkg?.description || '',
    selectedTestGroups: pkg?.testGroupIds || [],
    price: pkg?.price?.toString() || '',
    discountPercentage: pkg?.discountPercentage?.toString() || '',
    category: pkg?.category || '',
    validityDays: pkg?.validityDays?.toString() || '',
    isActive: pkg?.isActive ?? true,
  });

  const [testGroups, setTestGroups] = useState<TestGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [showSelected, setShowSelected] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  // Load test groups from database (already filtered by lab_id in database.testGroups.getAll())
  useEffect(() => {
    const loadTestGroups = async () => {
      try {
        const { data, error } = await database.testGroups.getAll();
        if (error) {
          console.error('Error loading test groups:', error);
          setTestGroups([]);
        } else {
          const groups = data || [];
          setTestGroups(groups);
          // Drop any pre-selected id that isn't in the (active-only) catalog.
          // Such an id would be invisible in this form yet still get re-saved,
          // silently re-linking a deactivated test group to the package.
          const selectable = new Set(groups.map((g: TestGroup) => g.id));
          setFormData(prev => {
            const kept = prev.selectedTestGroups.filter((id: string) => selectable.has(id));
            return kept.length === prev.selectedTestGroups.length
              ? prev
              : { ...prev, selectedTestGroups: kept };
          });
        }
      } catch (err) {
        console.error('Failed to load test groups:', err);
        setTestGroups([]);
      } finally {
        setLoading(false);
      }
    };
    loadTestGroups();
  }, []);

  // Soft search - fuzzy matching on name, code, category, clinical_purpose
  const filteredTestGroups = useMemo(() => {
    if (!searchTerm.trim()) return testGroups;
    
    const search = searchTerm.toLowerCase().trim();
    return testGroups.filter(group => {
      const name = (group.name || '').toLowerCase();
      const code = (group.code || '').toLowerCase();
      const category = (group.category || '').toLowerCase();
      const purpose = (group.clinical_purpose || '').toLowerCase();
      const sampleType = (group.sample_type || '').toLowerCase();
      
      // Check if any field contains the search term (soft search)
      return name.includes(search) || 
             code.includes(search) || 
             category.includes(search) || 
             purpose.includes(search) ||
             sampleType.includes(search);
    });
  }, [testGroups, searchTerm]);

  // Selected groups in the package's own order (selection order), not the
  // alphabetical catalog order. This order is what gets saved as display_order.
  const selectedTestGroupDetails = useMemo(() => {
    const byId = new Map(testGroups.map(g => [g.id, g]));
    return formData.selectedTestGroups
      .map((id: string) => byId.get(id))
      .filter(Boolean) as TestGroup[];
  }, [testGroups, formData.selectedTestGroups]);

  // Display groups - either filtered or only selected
  const displayTestGroups = useMemo(() => {
    if (showSelected) {
      return selectedTestGroupDetails;
    }
    return filteredTestGroups;
  }, [filteredTestGroups, selectedTestGroupDetails, showSelected]);

  const categories = [
    'Preventive Care',
    'Executive Care',
    'Cardiac Care',
    'Diabetes Care',
    'Women\'s Health',
    'Men\'s Health',
    'Senior Care',
    'Pediatric Care',
  ];

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    const originalTotal = selectedTestGroupDetails.reduce((sum, group) => sum + group.price, 0);
    const discountAmount = originalTotal * (parseFloat(formData.discountPercentage) || 0) / 100;
    const finalPrice = parseFloat(formData.price) || (originalTotal - discountAmount);

    const packageData = {
      name: formData.name,
      description: formData.description,
      // Array position is the package-level order the user set below
      testGroupIds: formData.selectedTestGroups,
      price: finalPrice,
      discountPercentage: parseFloat(formData.discountPercentage) || 0,
      category: formData.category,
      validityDays: parseInt(formData.validityDays) || 30,
      isActive: formData.isActive,
    };
    
    onSubmit(packageData);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value, type } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: type === 'checkbox' ? (e.target as HTMLInputElement).checked : value
    }));
  };

  const handleTestGroupSelection = (testGroupId: string) => {
    setFormData(prev => ({
      ...prev,
      selectedTestGroups: prev.selectedTestGroups.includes(testGroupId)
        ? prev.selectedTestGroups.filter(id => id !== testGroupId)
        // New picks land at the end so the existing order is never disturbed
        : [...prev.selectedTestGroups, testGroupId]
    }));
  };

  // Package-level ordering: position in selectedTestGroups becomes display_order
  const moveTestGroup = (from: number, to: number) => {
    setFormData(prev => {
      const list = [...prev.selectedTestGroups];
      if (from < 0 || to < 0 || from >= list.length || to >= list.length || from === to) {
        return prev;
      }
      const [moved] = list.splice(from, 1);
      list.splice(to, 0, moved);
      return { ...prev, selectedTestGroups: list };
    });
  };

  const originalPrice = selectedTestGroupDetails.reduce((sum, group) => sum + group.price, 0);
  const discountAmount = originalPrice * (parseFloat(formData.discountPercentage) || 0) / 100;
  const suggestedPrice = originalPrice - discountAmount;

  return (
    <div className="fixed inset-0 bg-gray-600 bg-opacity-75 flex items-start md:items-center justify-center z-50 p-4 overflow-y-auto">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-6xl my-8 md:my-0 md:max-h-[90vh] md:overflow-y-auto">
        <div className="flex items-center justify-between p-6 border-b border-gray-200 sticky top-0 bg-white z-10 rounded-t-lg">
          <h2 className="text-xl font-semibold text-gray-900 flex items-center">
            <Package className="h-6 w-6 mr-2 text-purple-600" />
            {pkg ? 'Edit Health Package' : 'Create Health Package'}
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
              <Package className="h-5 w-5 mr-2" />
              Package Information
            </h3>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Package Name *
                </label>
                <input
                  type="text"
                  name="name"
                  required
                  value={formData.name}
                  onChange={handleChange}
                  placeholder="e.g., Basic Health Checkup"
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
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Package Description *
              </label>
              <textarea
                name="description"
                required
                rows={3}
                value={formData.description}
                onChange={handleChange}
                placeholder="Describe the purpose and benefits of this health package"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
          </div>

          {/* Test Group Selection */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-medium text-gray-900 flex items-center">
                <Layers className="h-5 w-5 mr-2" />
                Select Test Groups
              </h3>
              {formData.selectedTestGroups.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowSelected(!showSelected)}
                  className="text-sm text-purple-600 hover:text-purple-800 flex items-center gap-1"
                >
                  {showSelected ? (
                    <>
                      <ChevronUp className="h-4 w-4" />
                      Show All ({testGroups.length})
                    </>
                  ) : (
                    <>
                      <Check className="h-4 w-4" />
                      Show Selected ({formData.selectedTestGroups.length})
                    </>
                  )}
                </button>
              )}
            </div>
            
            {/* Search Bar */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search by name, code, category, sample type..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent text-sm"
              />
              {searchTerm && (
                <button
                  type="button"
                  onClick={() => setSearchTerm('')}
                  className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-600"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>

            {/* Quick Selection Actions */}
            <div className="flex items-center gap-2 text-xs">
              <span className="text-gray-500">Quick:</span>
              <button
                type="button"
                onClick={() => setFormData(prev => ({ ...prev, selectedTestGroups: filteredTestGroups.map(g => g.id) }))}
                className="text-blue-600 hover:text-blue-800 underline"
              >
                Select All Visible
              </button>
              <span className="text-gray-300">|</span>
              <button
                type="button"
                onClick={() => setFormData(prev => ({ ...prev, selectedTestGroups: [] }))}
                className="text-red-600 hover:text-red-800 underline"
              >
                Clear All
              </button>
            </div>
            
            {loading ? (
              <div className="text-center py-8 text-gray-500">Loading test groups...</div>
            ) : testGroups.length === 0 ? (
              <div className="text-center py-8 text-gray-500">No test groups available for your lab</div>
            ) : displayTestGroups.length === 0 ? (
              <div className="text-center py-8 text-gray-500">
                {showSelected ? 'No test groups selected' : `No test groups matching "${searchTerm}"`}
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-h-72 overflow-y-auto border border-gray-200 rounded-lg p-3 bg-gray-50">
                {displayTestGroups.map((group) => {
                  const isSelected = formData.selectedTestGroups.includes(group.id);
                  return (
                    <div
                      key={group.id}
                      onClick={() => handleTestGroupSelection(group.id)}
                      className={`relative flex items-start p-3 rounded-lg cursor-pointer transition-all border-2 ${
                        isSelected
                          ? 'border-purple-500 bg-purple-50 shadow-sm'
                          : 'border-gray-200 bg-white hover:border-purple-300 hover:bg-purple-25'
                      }`}
                    >
                      {/* Checkbox indicator */}
                      <div className={`flex-shrink-0 w-5 h-5 rounded border-2 flex items-center justify-center mt-0.5 ${
                        isSelected
                          ? 'bg-purple-600 border-purple-600'
                          : 'border-gray-300 bg-white'
                      }`}>
                        {isSelected && <Check className="h-3 w-3 text-white" />}
                      </div>
                      
                      <div className="ml-3 flex-1 min-w-0">
                        <div className="flex items-start justify-between gap-2">
                          <div className="font-medium text-gray-900 text-sm truncate">{group.name}</div>
                          <div className="text-sm font-bold text-green-600 flex-shrink-0">₹{group.price}</div>
                        </div>
                        {group.clinical_purpose && (
                          <div className="text-xs text-gray-600 mt-1 line-clamp-2">{group.clinical_purpose}</div>
                        )}
                        <div className="text-xs text-gray-400 mt-1 flex items-center gap-1 flex-wrap">
                          <span className="bg-gray-100 px-1.5 py-0.5 rounded">{group.sample_type || 'N/A'}</span>
                          <span>•</span>
                          <span>{group.turnaround_time || 'N/A'}</span>
                          <span>•</span>
                          <span>{group.test_group_analytes?.length || 0} analytes</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Selected Test Groups Summary */}
            {formData.selectedTestGroups.length > 0 && (
              <div className="bg-purple-50 border border-purple-200 rounded-lg p-4">
                <div className="flex items-center justify-between mb-2">
                  <h4 className="font-medium text-purple-900">Selected Test Groups ({formData.selectedTestGroups.length})</h4>
                  <span className="text-xs text-purple-600">Drag or use arrows to set the order for this package</span>
                </div>
                <div className="space-y-1.5 mb-3 max-h-64 overflow-y-auto">
                  {selectedTestGroupDetails.map((group, index) => (
                    <div
                      key={group.id}
                      draggable
                      onDragStart={() => setDragIndex(index)}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        if (dragIndex !== null) moveTestGroup(dragIndex, index);
                        setDragIndex(null);
                      }}
                      onDragEnd={() => setDragIndex(null)}
                      className={`flex items-center gap-2 px-2 py-1.5 bg-white border rounded-md text-sm ${
                        dragIndex === index ? 'border-purple-500 opacity-60' : 'border-purple-200'
                      }`}
                    >
                      <GripVertical className="h-4 w-4 text-purple-300 cursor-grab flex-shrink-0" />
                      <span className="w-6 h-6 flex items-center justify-center rounded-full bg-purple-100 text-purple-800 text-xs font-semibold flex-shrink-0">
                        {index + 1}
                      </span>
                      <span className="flex-1 truncate text-gray-900">{group.name}</span>
                      <span className="text-xs font-medium text-green-600 flex-shrink-0">₹{group.price}</span>
                      <button
                        type="button"
                        title="Move up"
                        disabled={index === 0}
                        onClick={() => moveTestGroup(index, index - 1)}
                        className="p-1 rounded text-purple-600 hover:bg-purple-100 disabled:text-gray-300 disabled:hover:bg-transparent"
                      >
                        <ArrowUp className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        title="Move down"
                        disabled={index === selectedTestGroupDetails.length - 1}
                        onClick={() => moveTestGroup(index, index + 1)}
                        className="p-1 rounded text-purple-600 hover:bg-purple-100 disabled:text-gray-300 disabled:hover:bg-transparent"
                      >
                        <ArrowDown className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        title="Remove from package"
                        onClick={() => handleTestGroupSelection(group.id)}
                        className="p-1 rounded text-red-500 hover:bg-red-50"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
                <div className="border-t border-purple-300 pt-2">
                  <div className="flex justify-between font-bold text-purple-900 text-sm">
                    <span>Original Total:</span>
                    <span>₹{originalPrice}</span>
                  </div>
                  {parseFloat(formData.discountPercentage) > 0 && (
                    <>
                      <div className="flex justify-between text-sm text-purple-700">
                        <span>Discount ({formData.discountPercentage}%):</span>
                        <span>-₹{discountAmount.toFixed(0)}</span>
                      </div>
                      <div className="flex justify-between font-bold text-purple-900">
                        <span>Package Price:</span>
                        <span>₹{suggestedPrice.toFixed(0)}</span>
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Pricing & Settings */}
          <div className="space-y-4">
            <h3 className="text-lg font-medium text-gray-900 flex items-center">
              <DollarSign className="h-5 w-5 mr-2" />
              Pricing & Settings
            </h3>
            
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Discount Percentage
                </label>
                <input
                  type="number"
                  name="discountPercentage"
                  min="0"
                  max="50"
                  step="0.1"
                  value={formData.discountPercentage}
                  onChange={handleChange}
                  placeholder="0"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
                <div className="text-xs text-gray-500 mt-1">
                  Suggested: ₹{suggestedPrice.toFixed(0)}
                </div>
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Final Package Price (₹) *
                </label>
                <input
                  type="number"
                  name="price"
                  required
                  min="0"
                  step="0.01"
                  value={formData.price}
                  onChange={handleChange}
                  placeholder={suggestedPrice.toFixed(0)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Validity (Days)
                </label>
                <input
                  type="number"
                  name="validityDays"
                  min="1"
                  max="365"
                  value={formData.validityDays}
                  onChange={handleChange}
                  placeholder="30"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>
            </div>
          </div>

          {/* Package Settings */}
          <div className="space-y-4">
            <h3 className="text-lg font-medium text-gray-900 flex items-center">
              <Settings className="h-5 w-5 mr-2" />
              Package Settings
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
                <span className="ml-2 text-sm text-gray-700">Package is active and available for booking</span>
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
              disabled={formData.selectedTestGroups.length === 0}
              className="px-6 py-2 bg-purple-600 text-white rounded-md hover:bg-purple-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
            >
              {pkg ? 'Update Package' : 'Create Package'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default PackageForm;