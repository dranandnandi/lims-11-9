import React, { useState, useEffect } from 'react';
import { Plus, Edit2, Trash2, Search, Filter, X, Save, AlertCircle } from 'lucide-react';
import { supabase } from '../utils/supabase';

interface Analyte {
  id: string;
  name: string;
  unit: string;
  reference_range: string;
  category: string;
  method?: string;
  description?: string;
  is_critical?: boolean;
  normal_range_min?: number;
  normal_range_max?: number;
}

interface TestGroup {
  id: string;
  name: string;
  category: string;
  description?: string;
  analytes?: Analyte[];
  created_at: string;
  updated_at: string;
}

const Tests: React.FC = () => {
  const [testGroups, setTestGroups] = useState<TestGroup[]>([]);
  const [analytes, setAnalytes] = useState<Analyte[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editingTestGroup, setEditingTestGroup] = useState<TestGroup | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Form state for creating/editing test groups
  const [formData, setFormData] = useState({
    name: '',
    category: '',
    description: '',
    selectedAnalytes: [] as string[]
  });

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      setLoading(true);
      setError(null);

      // Sample data for demonstration
      const sampleTestGroups: TestGroup[] = [
        {
          id: '1',
          name: 'Blood Grouping',
          category: 'Blood Banking',
          description: 'ABO and Rh blood group determination',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          analytes: [
            {
              id: 'a1',
              name: 'ABO Blood Group',
              unit: 'Group',
              reference_range: 'A, B, AB, O',
              category: 'Blood Banking'
            },
            {
              id: 'a2', 
              name: 'Rh Factor',
              unit: 'Positive/Negative',
              reference_range: 'Positive or Negative',
              category: 'Blood Banking'
            }
          ]
        },
        {
          id: '2',
          name: 'Antibody Screening',
          category: 'Blood Banking', 
          description: 'Detection of irregular antibodies',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          analytes: [
            {
              id: 'a3',
              name: 'Antibody Screen I',
              unit: 'Positive/Negative',
              reference_range: 'Negative',
              category: 'Blood Banking'
            },
            {
              id: 'a4',
              name: 'Antibody Screen II', 
              unit: 'Positive/Negative',
              reference_range: 'Negative',
              category: 'Blood Banking'
            }
          ]
        }
      ];

      const sampleAnalytes: Analyte[] = [
        {
          id: 'a1',
          name: 'ABO Blood Group',
          unit: 'Group',
          reference_range: 'A, B, AB, O',
          category: 'Blood Banking'
        },
        {
          id: 'a2',
          name: 'Rh Factor', 
          unit: 'Positive/Negative',
          reference_range: 'Positive or Negative',
          category: 'Blood Banking'
        },
        {
          id: 'a3',
          name: 'Antibody Screen I',
          unit: 'Positive/Negative', 
          reference_range: 'Negative',
          category: 'Blood Banking'
        },
        {
          id: 'a4',
          name: 'Antibody Screen II',
          unit: 'Positive/Negative',
          reference_range: 'Negative', 
          category: 'Blood Banking'
        },
        {
          id: 'a5',
          name: 'Hemoglobin',
          unit: 'g/dL',
          reference_range: '12-16 (F), 14-18 (M)',
          category: 'Hematology'
        }
      ];

      setTestGroups(sampleTestGroups);
      setAnalytes(sampleAnalytes);

    } catch (err) {
      console.error('Error fetching data:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch data');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateTestGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const newTestGroup: TestGroup = {
        id: Date.now().toString(),
        name: formData.name,
        category: formData.category,
        description: formData.description,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        analytes: analytes.filter(a => formData.selectedAnalytes.includes(a.id))
      };

      setTestGroups(prev => [...prev, newTestGroup]);
      
      setFormData({ name: '', category: '', description: '', selectedAnalytes: [] });
      setShowCreateModal(false);

    } catch (err) {
      console.error('Error creating test group:', err);
      setError(err instanceof Error ? err.message : 'Failed to create test group');
    }
  };

  const handleEditTestGroup = (testGroup: TestGroup) => {
    setEditingTestGroup(testGroup);
    setFormData({
      name: testGroup.name,
      category: testGroup.category,
      description: testGroup.description || '',
      selectedAnalytes: testGroup.analytes?.map(a => a.id) || []
    });
    setShowEditModal(true);
  };

  const handleUpdateTestGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingTestGroup) return;

    try {
      const updatedTestGroup: TestGroup = {
        ...editingTestGroup,
        name: formData.name,
        category: formData.category,
        description: formData.description,
        updated_at: new Date().toISOString(),
        analytes: analytes.filter(a => formData.selectedAnalytes.includes(a.id))
      };

      setTestGroups(prev => prev.map(tg => tg.id === editingTestGroup.id ? updatedTestGroup : tg));
      
      setFormData({ name: '', category: '', description: '', selectedAnalytes: [] });
      setShowEditModal(false);
      setEditingTestGroup(null);

    } catch (err) {
      console.error('Error updating test group:', err);
      setError(err instanceof Error ? err.message : 'Failed to update test group');
    }
  };

  const handleDeleteTestGroup = async (id: string) => {
    if (!confirm('Are you sure you want to delete this test group?')) return;

    try {
      setTestGroups(prev => prev.filter(tg => tg.id !== id));
    } catch (err) {
      console.error('Error deleting test group:', err);
      setError(err instanceof Error ? err.message : 'Failed to delete test group');
    }
  };

  const handleAnalyteToggle = (analyteId: string) => {
    setFormData(prev => ({
      ...prev,
      selectedAnalytes: prev.selectedAnalytes.includes(analyteId)
        ? prev.selectedAnalytes.filter(id => id !== analyteId)
        : [...prev.selectedAnalytes, analyteId]
    }));
  };

  const removeAnalyteFromGroup = (analyteId: string) => {
    setFormData(prev => ({
      ...prev,
      selectedAnalytes: prev.selectedAnalytes.filter(id => id !== analyteId)
    }));
  };

  // Filter test groups
  const filteredTestGroups = testGroups.filter(group => {
    const matchesSearch = group.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         group.category.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesCategory = !categoryFilter || group.category === categoryFilter;
    return matchesSearch && matchesCategory;
  });

  // Get unique categories
  const categories = [...new Set(testGroups.map(group => group.category))];

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Test Groups & Analytes</h1>
          <p className="text-gray-600 mt-1">Manage laboratory test configurations and analytes</p>
        </div>
        <button
          onClick={() => setShowCreateModal(true)}
          className="flex items-center space-x-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
        >
          <Plus className="w-4 h-4" />
          <span>Add Test Group</span>
        </button>
      </div>

      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-md flex items-center space-x-2">
          <AlertCircle className="w-5 h-5 text-red-600" />
          <span className="text-red-700">{error}</span>
          <button
            onClick={() => setError(null)}
            className="ml-auto text-red-600 hover:text-red-800"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Search and Filter */}
      <div className="flex space-x-4 mb-6">
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4" />
          <input
            type="text"
            placeholder="Search test groups..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        
        <div className="relative">
          <Filter className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4" />
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="pl-10 pr-8 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">All Categories</option>
            {categories.map(category => (
              <option key={category} value={category}>{category}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Test Groups Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {filteredTestGroups.map((testGroup) => (
          <div key={testGroup.id} className="bg-white rounded-lg shadow-md border p-6 hover:shadow-lg transition-shadow">
            <div className="flex justify-between items-start mb-4">
              <div>
                <h3 className="text-lg font-semibold text-gray-900">{testGroup.name}</h3>
                <span className="inline-block px-2 py-1 bg-blue-100 text-blue-800 text-sm rounded-full mt-1">
                  {testGroup.category}
                </span>
              </div>
              <div className="flex space-x-2">
                <button
                  onClick={() => handleEditTestGroup(testGroup)}
                  className="text-blue-600 hover:text-blue-800 p-1 rounded"
                  title="Edit Test Group"
                >
                  <Edit2 className="w-4 h-4" />
                </button>
                <button
                  onClick={() => handleDeleteTestGroup(testGroup.id)}
                  className="text-red-600 hover:text-red-800 p-1 rounded"
                  title="Delete Test Group"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>

            {testGroup.description && (
              <p className="text-gray-600 text-sm mb-3">{testGroup.description}</p>
            )}

            <div className="mb-3">
              <h4 className="text-sm font-medium text-gray-700 mb-2">
                Analytes ({testGroup.analytes?.length || 0})
              </h4>
              {testGroup.analytes && testGroup.analytes.length > 0 ? (
                <div className="space-y-1">
                  {testGroup.analytes.slice(0, 3).map((analyte) => (
                    <div key={analyte.id} className="text-sm text-gray-600 flex items-center">
                      <span className="w-2 h-2 bg-blue-400 rounded-full mr-2"></span>
                      {analyte.name} ({analyte.unit})
                    </div>
                  ))}
                  {testGroup.analytes.length > 3 && (
                    <div className="text-sm text-gray-500 ml-4">
                      +{testGroup.analytes.length - 3} more analytes...
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-sm text-gray-500 italic">No analytes configured</p>
              )}
            </div>

            <div className="text-xs text-gray-500 border-t pt-2">
              Updated: {new Date(testGroup.updated_at).toLocaleDateString()}
            </div>
          </div>
        ))}
      </div>

      {filteredTestGroups.length === 0 && (
        <div className="text-center py-12">
          <div className="text-gray-500">
            <p className="text-lg font-medium">No test groups found</p>
            <p className="text-sm">Create your first test group to get started</p>
          </div>
        </div>
      )}

      {/* Create Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-semibold">Create Test Group</h2>
              <button
                onClick={() => setShowCreateModal(false)}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="w-6 h-6" />
              </button>
            </div>

            <form onSubmit={handleCreateTestGroup} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Test Group Name *
                </label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Category *
                </label>
                <select
                  value={formData.category}
                  onChange={(e) => setFormData(prev => ({ ...prev, category: e.target.value }))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  required
                >
                  <option value="">Select Category</option>
                  <option value="Hematology">Hematology</option>
                  <option value="Chemistry">Chemistry</option>
                  <option value="Immunology">Immunology</option>
                  <option value="Microbiology">Microbiology</option>
                  <option value="Blood Banking">Blood Banking</option>
                  <option value="Clinical Pathology">Clinical Pathology</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Description
                </label>
                <textarea
                  value={formData.description}
                  onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                  rows={3}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Select Analytes
                </label>
                <div className="max-h-60 overflow-y-auto border border-gray-300 rounded-md p-3">
                  {analytes.map((analyte) => (
                    <div key={analyte.id} className="flex items-center space-x-2 mb-2">
                      <input
                        type="checkbox"
                        id={`analyte-${analyte.id}`}
                        checked={formData.selectedAnalytes.includes(analyte.id)}
                        onChange={() => handleAnalyteToggle(analyte.id)}
                        className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                      />
                      <label
                        htmlFor={`analyte-${analyte.id}`}
                        className="text-sm text-gray-700 cursor-pointer flex-1"
                      >
                        {analyte.name} ({analyte.unit}) - {analyte.category}
                      </label>
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex justify-end space-x-3 pt-4 border-t">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-4 py-2 text-gray-700 bg-gray-100 rounded-md hover:bg-gray-200"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
                >
                  Create Test Group
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Modal with Enhanced Analyte Display */}
      {showEditModal && editingTestGroup && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 w-full max-w-4xl max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-semibold">Edit Test Group</h2>
              <button
                onClick={() => setShowEditModal(false)}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="w-6 h-6" />
              </button>
            </div>

            <form onSubmit={handleUpdateTestGroup} className="space-y-6">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Test Group Name *
                  </label>
                  <input
                    type="text"
                    value={formData.name}
                    onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    required
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Category *
                  </label>
                  <select
                    value={formData.category}
                    onChange={(e) => setFormData(prev => ({ ...prev, category: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    required
                  >
                    <option value="">Select Category</option>
                    <option value="Hematology">Hematology</option>
                    <option value="Chemistry">Chemistry</option>
                    <option value="Immunology">Immunology</option>
                    <option value="Microbiology">Microbiology</option>
                    <option value="Blood Banking">Blood Banking</option>
                    <option value="Clinical Pathology">Clinical Pathology</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Description
                </label>
                <textarea
                  value={formData.description}
                  onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                  rows={3}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              {/* Enhanced Analytes Section with Edit Button */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-3">
                  📊 Current Analytes ({editingTestGroup.analytes?.length || 0})
                </label>
                
                <div className="space-y-3 mb-6">
                  {editingTestGroup.analytes?.map((analyte) => (
                    <div key={analyte.id} className="flex items-center justify-between p-4 bg-gradient-to-r from-gray-50 to-blue-50 rounded-lg border-l-4 border-blue-400">
                      <div className="flex-1">
                        <div className="flex items-center justify-between">
                          <div>
                            <h4 className="font-semibold text-gray-900">{analyte.name}</h4>
                            <p className="text-sm text-gray-600">
                              <span className="font-medium">Unit:</span> {analyte.unit} • 
                              <span className="font-medium"> Range:</span> {analyte.reference_range}
                            </p>
                            <div className="flex items-center space-x-3 mt-1">
                              <span className="px-2 py-1 bg-blue-100 text-blue-800 text-xs rounded-full">
                                {analyte.category}
                              </span>
                              {analyte.is_critical && (
                                <span className="px-2 py-1 bg-red-100 text-red-800 text-xs rounded-full">
                                  ⚠️ Critical
                                </span>
                              )}
                              {analyte.method && (
                                <span className="text-xs text-gray-500">
                                  Method: {analyte.method}
                                </span>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center space-x-2">
                            <button
                              type="button"
                              onClick={() => alert(`🔧 Edit Analyte: ${analyte.name}\n\nThis will open the analyte editor where you can modify:\n• Name and unit\n• Reference ranges\n• Critical value settings\n• Method and description\n\nComing soon!`)}
                              className="p-2 text-blue-600 hover:bg-blue-100 rounded-md transition-colors shadow-sm border border-blue-200"
                              title="Edit Analyte Details"
                            >
                              <Edit2 className="w-4 h-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => removeAnalyteFromGroup(analyte.id)}
                              className="p-2 text-red-600 hover:bg-red-100 rounded-md transition-colors shadow-sm border border-red-200"
                              title="Remove from Test Group"
                            >
                              <X className="w-4 h-4" />
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  )) || []}
                  
                  {/* Empty state */}
                  {(!editingTestGroup.analytes || editingTestGroup.analytes.length === 0) && (
                    <div className="text-center py-8 text-gray-500 bg-gray-50 rounded-lg border-2 border-dashed border-gray-300">
                      <p className="font-medium">No analytes added to this test group yet</p>
                      <p className="text-sm">Use the selection below to add analytes to this test group</p>
                    </div>
                  )}
                </div>

                <label className="block text-sm font-medium text-gray-700 mb-2">
                  ➕ Add More Analytes
                </label>
                <div className="max-h-60 overflow-y-auto border border-gray-300 rounded-md p-3 bg-white">
                  {analytes
                    .filter(analyte => !formData.selectedAnalytes.includes(analyte.id))
                    .map((analyte) => (
                    <div key={analyte.id} className="flex items-center space-x-2 mb-2 p-2 hover:bg-gray-50 rounded">
                      <input
                        type="checkbox"
                        id={`edit-analyte-${analyte.id}`}
                        checked={formData.selectedAnalytes.includes(analyte.id)}
                        onChange={() => handleAnalyteToggle(analyte.id)}
                        className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                      />
                      <label
                        htmlFor={`edit-analyte-${analyte.id}`}
                        className="text-sm text-gray-700 cursor-pointer flex-1"
                      >
                        <span className="font-medium">{analyte.name}</span> ({analyte.unit}) - {analyte.category}
                      </label>
                    </div>
                  ))}
                  
                  {analytes.filter(analyte => !formData.selectedAnalytes.includes(analyte.id)).length === 0 && (
                    <div className="text-center py-4 text-gray-500">
                      <p>All available analytes are already added to this test group</p>
                    </div>
                  )}
                </div>
              </div>

              <div className="flex justify-end space-x-3 pt-4 border-t">
                <button
                  type="button"
                  onClick={() => setShowEditModal(false)}
                  className="px-4 py-2 text-gray-700 bg-gray-100 rounded-md hover:bg-gray-200"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 flex items-center space-x-2"
                >
                  <Save className="w-4 h-4" />
                  <span>Update Test Group</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default Tests;

interface Analyte {
  id: string;
  name: string;
  unit: string;
  reference_range: string;
  category: string;
  method?: string;
  description?: string;
  is_critical?: boolean;
  normal_range_min?: number;
  normal_range_max?: number;
}

interface TestGroup {
  id: string;
  name: string;
  category: string;
  description?: string;
  analytes?: Analyte[];
  created_at: string;
  updated_at: string;
}

const Tests: React.FC = () => {
  const [testGroups, setTestGroups] = useState<TestGroup[]>([]);
  const [analytes, setAnalytes] = useState<Analyte[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editingTestGroup, setEditingTestGroup] = useState<TestGroup | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Form state for creating/editing test groups
  const [formData, setFormData] = useState({
    name: '',
    category: '',
    description: '',
    selectedAnalytes: [] as string[]
  });

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      setLoading(true);
      setError(null);

      // For now, use sample data since we're having DB connection issues
      const sampleTestGroups: TestGroup[] = [
        {
          id: '1',
          name: 'Blood Grouping',
          category: 'Blood Banking',
          description: 'ABO and Rh blood group determination',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          analytes: [
            {
              id: 'a1',
              name: 'ABO Blood Group',
              unit: 'Group',
              reference_range: 'A, B, AB, O',
              category: 'Blood Banking'
            },
            {
              id: 'a2', 
              name: 'Rh Factor',
              unit: 'Positive/Negative',
              reference_range: 'Positive or Negative',
              category: 'Blood Banking'
            }
          ]
        },
        {
          id: '2',
          name: 'Antibody Screening',
          category: 'Blood Banking', 
          description: 'Detection of irregular antibodies',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          analytes: [
            {
              id: 'a3',
              name: 'Antibody Screen I',
              unit: 'Positive/Negative',
              reference_range: 'Negative',
              category: 'Blood Banking'
            },
            {
              id: 'a4',
              name: 'Antibody Screen II', 
              unit: 'Positive/Negative',
              reference_range: 'Negative',
              category: 'Blood Banking'
            }
          ]
        }
      ];

      const sampleAnalytes: Analyte[] = [
        {
          id: 'a1',
          name: 'ABO Blood Group',
          unit: 'Group',
          reference_range: 'A, B, AB, O',
          category: 'Blood Banking'
        },
        {
          id: 'a2',
          name: 'Rh Factor', 
          unit: 'Positive/Negative',
          reference_range: 'Positive or Negative',
          category: 'Blood Banking'
        },
        {
          id: 'a3',
          name: 'Antibody Screen I',
          unit: 'Positive/Negative', 
          reference_range: 'Negative',
          category: 'Blood Banking'
        },
        {
          id: 'a4',
          name: 'Antibody Screen II',
          unit: 'Positive/Negative',
          reference_range: 'Negative', 
          category: 'Blood Banking'
        },
        {
          id: 'a5',
          name: 'Hemoglobin',
          unit: 'g/dL',
          reference_range: '12-16 (F), 14-18 (M)',
          category: 'Hematology'
        }
      ];

      setTestGroups(sampleTestGroups);
      setAnalytes(sampleAnalytes);

    } catch (err) {
      console.error('Error fetching data:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch data');
    } finally {
      setLoading(false);
    }
  };

const Tests: React.FC = () => {
  const [tests, setTests] = useState<Test[]>([]);
  const [testGroups, setTestGroups] = useState<TestGroup[]>([]);
  const [analytes, setAnalytes] = useState<Analyte[]>([]);
  const [packages, setPackages] = useState<PackageType[]>([]);
  const [showTestForm, setShowTestForm] = useState(false);
  const [showAnalyteForm, setShowAnalyteForm] = useState(false);
  const [showTestGroupForm, setShowTestGroupForm] = useState(false);
  const [showPackageForm, setShowPackageForm] = useState(false);
  const [showTestDetail, setShowTestDetail] = useState(false);
  const [showAnalyteDetail, setShowAnalyteDetail] = useState(false);
  const [showTestGroupDetail, setShowTestGroupDetail] = useState(false);
  const [showPackageDetail, setShowPackageDetail] = useState(false);
  const [selectedTest, setSelectedTest] = useState<Test | null>(null);
  const [selectedAnalyte, setSelectedAnalyte] = useState<Analyte | null>(null);
  const [selectedTestGroup, setSelectedTestGroup] = useState<TestGroup | null>(null);
  const [selectedPackage, setSelectedPackage] = useState<PackageType | null>(null);
  const [editingTest, setEditingTest] = useState<Test | null>(null);
  const [editingAnalyte, setEditingAnalyte] = useState<Analyte | null>(null);
  const [editingTestGroup, setEditingTestGroup] = useState<TestGroup | null>(null);
  const [editingPackage, setEditingPackage] = useState<PackageType | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [activeTab, setActiveTab] = useState<'groups' | 'analytes' | 'legacy'>('groups');

  // State for editing analytes
  const [showEditAnalyteModal, setShowEditAnalyteModal] = useState(false);

  // Load data on component mount
  React.useEffect(() => {
    const loadData = async () => {
      try {
        // Load analytes from database
        const { data: dbAnalytesData, error: analytesError } = await database.analytes.getAll();
        if (analytesError) {
          console.error('Error loading analytes from database:', analytesError);
          setAnalytes([]);
        } else {
          // Transform the Supabase analytes data to match our Analyte interface
          const transformedAnalytes = (dbAnalytesData || []).map(analyte => ({
            id: analyte.id,
            name: analyte.name,
            unit: analyte.unit,
            referenceRange: analyte.reference_range || analyte.referenceRange,
            lowCritical: analyte.low_critical,
            highCritical: analyte.high_critical,
            interpretation: analyte.interpretation,
            category: analyte.category,
            isActive: analyte.is_active ?? true,
            createdDate: analyte.created_at || new Date().toISOString()
          }));
          setAnalytes(transformedAnalytes);
        }
        
        // Load test groups from database
        const { data: dbTestGroupsData, error: testGroupsError } = await database.testGroups.getAll();
        if (testGroupsError) {
          console.error('Error loading test groups from database:', testGroupsError);
          setTestGroups([]);
        } else {
          // Transform the Supabase data to match our TestGroup interface
          const transformedTestGroups = (dbTestGroupsData || []).map(group => ({
            id: group.id,
            name: group.name,
            code: group.code,
            category: group.category,
            clinicalPurpose: group.clinical_purpose,
            price: group.price,
            turnaroundTime: group.turnaround_time,
            sampleType: group.sample_type,
            requiresFasting: group.requires_fasting,
            isActive: group.is_active,
            createdDate: group.created_at,
            default_ai_processing_type: group.default_ai_processing_type,
            group_level_prompt: group.group_level_prompt,
            analytes: group.test_group_analytes ? group.test_group_analytes.map(tga => tga.analyte_id) : []
          }));
          setTestGroups(transformedTestGroups);
        }

        // For now, set tests and packages to empty arrays since they don't exist in database
        setTests([]);
        setPackages([]);
      } catch (error) {
        console.error('Error loading data:', error);
        setAnalytes([]);
        setTestGroups([]);
        setTests([]);
        setPackages([]);
      }
    };
    
    loadData();
  }, []);

  const categories = ['All', 'Hematology', 'Biochemistry', 'Serology', 'Microbiology', 'Immunology'];

  const filteredPackages = packages.filter(pkg => {
    const matchesSearch = pkg.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         pkg.description.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesCategory = selectedCategory === 'All' || pkg.category === selectedCategory;
    return matchesSearch && matchesCategory;
  });

  const filteredTestGroups = testGroups.filter(group => {
    const matchesSearch = group.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         group.code.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesCategory = selectedCategory === 'All' || group.category === selectedCategory;
    return matchesSearch && matchesCategory;
  });

  const filteredAnalytes = analytes.filter(analyte => {
    const matchesSearch = analyte.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         analyte.id.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesCategory = selectedCategory === 'All' || analyte.category === selectedCategory;
    return matchesSearch && matchesCategory;
  });

  const filteredLegacyTests = tests.filter(test => {
    const matchesSearch = test.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         test.id.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesCategory = selectedCategory === 'All' || test.category === selectedCategory;
    return matchesSearch && matchesCategory;
  });

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

    const handleAddTest = (_formData: any) => {
    // TODO: Implement database storage for individual tests
    // For now, tests are managed through test groups
    console.warn('Individual tests are not supported. Please use test groups instead.');
    alert('Individual tests are not supported. Please use test groups instead.');
    setShowTestForm(false);
  };

  const handleAddAnalyte = async (formData: any) => {
    console.log('Creating analyte with data:', formData); // Debug log
    try {
      // Use database function to create analyte
      const { data: newAnalyte, error } = await database.analytes.create({
        name: formData.name,
        unit: formData.unit,
        reference_range: formData.referenceRange,
        low_critical: formData.lowCritical,
        high_critical: formData.highCritical,
        interpretation_low: formData.interpretation?.low,
        interpretation_normal: formData.interpretation?.normal,
        interpretation_high: formData.interpretation?.high,
        category: formData.category,
        is_active: formData.isActive ?? true,
      });
      
      if (error) {
        console.error('Error creating analyte:', error);
        alert('Failed to create analyte. Please try again.');
        return;
      }
      
      if (newAnalyte) {
        // Transform and add to local state for immediate UI update
        const transformedAnalyte = {
          id: newAnalyte.id,
          name: newAnalyte.name,
          unit: newAnalyte.unit,
          referenceRange: newAnalyte.reference_range,
          lowCritical: newAnalyte.low_critical,
          highCritical: newAnalyte.high_critical,
          interpretation: newAnalyte.interpretation_low || '', // Simplified for localStorage interface
          category: newAnalyte.category,
          isActive: newAnalyte.is_active,
          createdDate: newAnalyte.created_at || new Date().toISOString()
        };
        
        setAnalytes(prev => [...prev, transformedAnalyte]);
        setShowAnalyteForm(false);
        alert('Analyte created successfully!');
      }
    } catch (error) {
      console.error('Unexpected error:', error);
      alert('Failed to create analyte. Please try again.');
    }
  };

  const handleAddTestGroup = async (formData: any) => {
    console.log('Creating test group with data:', formData); // Debug log
    try {
      // Use database function instead of localStorage
      const { data: newTestGroup, error } = await database.testGroups.create(formData);
      
      if (error) {
        console.error('Error creating test group:', error);
        alert('Failed to create test group. Please try again.');
        return;
      }
      
      if (newTestGroup) {
        // Add to local state for immediate UI update
        setTestGroups(prev => [...prev, newTestGroup]);
        setShowTestGroupForm(false);
        alert('Test group created successfully!');
      }
    } catch (error) {
      console.error('Unexpected error:', error);
      alert('Failed to create test group. Please try again.');
    }
  };

  const handleAddPackage = (_formData: any) => {
    // TODO: Implement database storage for packages
    // For now, packages are not supported
    console.warn('Packages are not supported yet. Please use test groups instead.');
    alert('Packages are not supported yet. Please use test groups instead.');
    setShowPackageForm(false);
  };

  // View handlers
  const handleViewPackage = (pkg: PackageType) => {
    setSelectedPackage(pkg);
    setShowPackageDetail(true);
  };

  const handleViewTestGroup = (group: TestGroup) => {
    setSelectedTestGroup(group);
    setShowTestGroupDetail(true);
  };

  const handleViewAnalyte = (analyte: Analyte) => {
    setSelectedAnalyte(analyte);
    setShowAnalyteDetail(true);
  };

  const handleViewLegacyTest = (test: Test) => {
    setSelectedTest(test);
    setShowTestDetail(true);
  };

  // Edit handlers
  const handleEditPackage = (pkg: PackageType) => {
    setEditingPackage(pkg);
    setShowPackageForm(true);
  };

  const handleEditTestGroup = (group: TestGroup) => {
    setEditingTestGroup(group);
    setFormData({
      name: group.name,
      category: group.category,
      description: group.description || '',
      selectedAnalytes: group.analytes?.map(a => a.id) || []
    });
    setShowEditModal(true);
  };

  const handleEditAnalyte = (analyte: Analyte) => {
    setEditingAnalyte(analyte);
    setShowEditAnalyteModal(true);
  };

  const handleEditLegacyTest = (test: Test) => {
    setEditingTest(test);
    setShowTestForm(true);
  };

  // Update handlers
  const handleUpdatePackage = (formData: any) => {
    if (!editingPackage) return;
    
    const updatedPackage = {
      ...editingPackage,
      name: formData.name,
      description: formData.description,
      testGroupIds: formData.testGroupIds,
      price: formData.price,
      discountPercentage: formData.discountPercentage,
      category: formData.category,
      validityDays: formData.validityDays,
      isActive: formData.isActive,
    };
    
    setPackages(prev => prev.map(p => p.id === editingPackage.id ? updatedPackage : p));
    setShowPackageForm(false);
    setEditingPackage(null);
  };

  const handleUpdateTestGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingTestGroup) return;

    try {
      const updatedTestGroup: TestGroup = {
        ...editingTestGroup,
        name: formData.name,
        category: formData.category,
        description: formData.description,
        updated_at: new Date().toISOString(),
        analytes: analytes.filter(a => formData.selectedAnalytes.includes(a.id))
      };

      setTestGroups(prev => prev.map(tg => tg.id === editingTestGroup.id ? updatedTestGroup : tg));
      
      // Reset form
      setFormData({ name: '', category: '', description: '', selectedAnalytes: [] });
      setShowEditModal(false);
      setEditingTestGroup(null);

    } catch (err) {
      console.error('Error updating test group:', err);
      setError(err instanceof Error ? err.message : 'Failed to update test group');
    }
  };

  const handleUpdateAnalyte = async (formData: any) => {
    if (!editingAnalyte) return;
    
    console.log('Updating analyte with data:', formData); // Debug log
    try {
      // Use database function to update analyte
      const { data: updatedAnalyte, error } = await database.analytes.update(editingAnalyte.id, {
        name: formData.name,
        unit: formData.unit,
        reference_range: formData.referenceRange,
        low_critical: formData.lowCritical,
        high_critical: formData.highCritical,
        interpretation_low: formData.interpretation?.low,
        interpretation_normal: formData.interpretation?.normal,
        interpretation_high: formData.interpretation?.high,
        category: formData.category,
        is_active: formData.isActive,
      });
      
      if (error) {
        console.error('Error updating analyte:', error);
        alert('Failed to update analyte. Please try again.');
        return;
      }
      
      if (updatedAnalyte) {
        // Transform and update local state
        const transformedAnalyte = {
          id: updatedAnalyte.id,
          name: updatedAnalyte.name,
          unit: updatedAnalyte.unit,
          referenceRange: updatedAnalyte.reference_range,
          lowCritical: updatedAnalyte.low_critical,
          highCritical: updatedAnalyte.high_critical,
          interpretation: updatedAnalyte.interpretation_low || '', // Simplified for localStorage interface
          category: updatedAnalyte.category,
          isActive: updatedAnalyte.is_active,
          createdDate: updatedAnalyte.created_at || editingAnalyte.createdDate
        };
        
        setAnalytes(prev => prev.map(a => a.id === editingAnalyte.id ? transformedAnalyte : a));
        setShowAnalyteForm(false);
        setEditingAnalyte(null);
        alert('Analyte updated successfully!');
      }
    } catch (error) {
      console.error('Unexpected error:', error);
      alert('Failed to update analyte. Please try again.');
    }
  };

  const handleUpdateTest = (formData: any) => {
    if (!editingTest) return;
    
    const updatedTest = {
      ...editingTest,
      name: formData.name,
      category: formData.category,
      method: formData.method,
      sampleType: formData.sampleType,
      price: parseFloat(formData.price),
      turnaroundTime: formData.turnaroundTime,
      referenceRange: formData.referenceRange,
      units: formData.units,
      description: formData.description,
      isActive: formData.isActive,
      requiresFasting: formData.requiresFasting,
      criticalValues: formData.criticalValues,
      interpretation: formData.interpretation,
    };
    
    setTests(prev => prev.map(t => t.id === editingTest.id ? updatedTest : t));
    setShowTestForm(false);
    setEditingTest(null);
  };

  // Close handlers
  const handleClosePackageForm = () => {
    setShowPackageForm(false);
    setEditingPackage(null);
  };

  const handleCloseTestGroupForm = () => {
    setShowTestGroupForm(false);
    setEditingTestGroup(null);
  };

  const handleCloseAnalyteForm = () => {
    setShowAnalyteForm(false);
    setEditingAnalyte(null);
  };

  const handleCloseTestForm = () => {
    setShowTestForm(false);
    setEditingTest(null);
  };

  const handleCloseAnalyteModal = () => {
    setShowEditAnalyteModal(false);
    setEditingAnalyte(null);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Test Management System</h1>
          <p className="text-gray-600 mt-1">Manage analytes, test groups, and diagnostic panels</p>
        </div>
        <div className="flex space-x-3">
          <button 
            onClick={() => setShowAnalyteForm(true)}
            className="flex items-center px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
          >
            <Beaker className="h-4 w-4 mr-2" />
            Add Analyte
          </button>
          <button 
            onClick={() => setShowPackageForm(true)}
            className="flex items-center px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors"
          >
            <Plus className="h-5 w-5 mr-2" />
            Create Package
          </button>
          <button 
            onClick={() => setShowTestGroupForm(true)}
            className="flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            <Plus className="h-5 w-5 mr-2" />
            Create Test Group
          </button>
        </div>
      </div>

      {/* Tab Navigation */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-1">
        <div className="flex space-x-1">
          <button
            onClick={() => setActiveTab('groups')}
            className={`flex-1 flex items-center justify-center px-4 py-3 rounded-md text-sm font-medium transition-all ${
              activeTab === 'groups'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
            }`}
          >
            <Layers className="h-4 w-4 mr-2" />
            Test Groups ({testGroups.length})
          </button>
          <button
            onClick={() => setActiveTab('analytes')}
            className={`flex-1 flex items-center justify-center px-4 py-3 rounded-md text-sm font-medium transition-all ${
              activeTab === 'analytes'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
            }`}
          >
            <Beaker className="h-4 w-4 mr-2" />
            Analytes ({analytes.length})
          </button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <div className="flex items-center">
            <div className="bg-purple-100 p-3 rounded-lg">
              <Package className="h-6 w-6 text-purple-600" />
            </div>
            <div className="ml-4">
              <div className="text-2xl font-bold text-gray-900">{packages.length}</div>
              <div className="text-sm text-gray-600">Health Packages</div>
            </div>
          </div>
        </div>
        
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <div className="flex items-center">
            <div className="bg-green-100 p-3 rounded-lg">
              <Layers className="h-6 w-6 text-green-600" />
            </div>
            <div className="ml-4">
              <div className="text-2xl font-bold text-gray-900">{testGroups.length}</div>
              <div className="text-sm text-gray-600">Test Groups</div>
            </div>
          </div>
        </div>
        
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <div className="flex items-center">
            <div className="bg-blue-100 p-3 rounded-lg">
              <Beaker className="h-6 w-6 text-blue-600" />
            </div>
            <div className="ml-4">
              <div className="text-2xl font-bold text-gray-900">{analytes.length}</div>
              <div className="text-sm text-gray-600">Analytes</div>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <div className="flex items-center">
            <div className="bg-orange-100 p-3 rounded-lg">
              <DollarSign className="h-6 w-6 text-orange-600" />
            </div>
            <div className="ml-4">
              <div className="text-2xl font-bold text-gray-900">₹{packages.length > 0 ? Math.round(packages.reduce((sum, pkg) => sum + pkg.price, 0) / packages.length) : 0}</div>
              <div className="text-sm text-gray-600">Avg Package Price</div>
            </div>
          </div>
        </div>
      </div>

      {/* Search and Filter Bar */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
        <div className="flex flex-col sm:flex-row gap-4">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input
              type="text"
              placeholder="Search tests by name or ID..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10 pr-4 py-2 w-full border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
          <select
            value={selectedCategory}
            onChange={(e) => setSelectedCategory(e.target.value)}
            className="px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          >
            {categories.map(category => (
              <option key={category} value={category}>{category}</option>
            ))}
          </select>
          <button className="flex items-center px-4 py-2 border border-gray-300 rounded-md hover:bg-gray-50 transition-colors">
            <Filter className="h-4 w-4 mr-2" />
            More Filters
          </button>
        </div>
      </div>

      {/* Content based on active tab */}
      {activeTab === 'groups' && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200">
            <h3 className="text-lg font-semibold text-gray-900">
              Test Groups ({testGroups.length})
            </h3>
          </div>
          
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Package Details
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Category
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Test Groups
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Pricing
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Validity
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {filteredPackages.map((pkg) => {
                  const includedGroups = testGroups.filter(group => pkg.testGroupIds.includes(group.id));
                  const originalPrice = includedGroups.reduce((sum, group) => sum + group.price, 0);
                  const savings = originalPrice - pkg.price;
                  
                  return (
                    <tr key={pkg.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div>
                          <div className="text-sm font-medium text-gray-900">{pkg.name}</div>
                          <div className="text-sm text-gray-500">ID: {pkg.id}</div>
                          <div className="text-xs text-gray-400 mt-1 max-w-xs truncate">{pkg.description}</div>
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-800`}>
                          {pkg.category}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm text-gray-900">{pkg.testGroupIds.length} groups</div>
                        <div className="text-xs text-gray-500">
                          {includedGroups.slice(0, 2).map(group => group.name).join(', ')}
                          {pkg.testGroupIds.length > 2 && ` +${pkg.testGroupIds.length - 2} more`}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm font-medium text-gray-900">₹{pkg.price}</div>
                        {savings > 0 && (
                          <div className="text-xs text-green-600">Save ₹{savings}</div>
                        )}
                        {pkg.discountPercentage > 0 && (
                          <div className="text-xs text-blue-600">{pkg.discountPercentage}% off</div>
                        )}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                        {pkg.validityDays} days
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <button 
                          onClick={() => handleViewPackage(pkg)}
                          className="text-blue-600 hover:text-blue-900 p-1 rounded"
                          title="View Package Details"
                        >
                          <Eye className="h-4 w-4" />
                        </button>
                        <button 
                          onClick={() => handleEditPackage(pkg)}
                          className="text-gray-600 hover:text-gray-900 p-1 rounded"
                          title="Edit Package"
                        >
                          <Edit className="h-4 w-4" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === 'groups' && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200">
            <h3 className="text-lg font-semibold text-gray-900">
              Test Groups ({filteredTestGroups.length})
            </h3>
          </div>
          
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Group Details
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Category
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Analytes
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Price
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Sample Type
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {filteredTestGroups.map((group) => (
                  <tr key={group.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div>
                        <div className="text-sm font-medium text-gray-900">{group.name}</div>
                        <div className="text-sm text-gray-500">Code: {group.code} • {group.turnaroundTime}</div>
                        <div className="text-xs text-gray-400 mt-1">{group.clinicalPurpose}</div>
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getCategoryColor(group.category)}`}>
                        {group.category}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="text-sm text-gray-900">{group.analytes.length} analytes</div>
                      <div className="text-xs text-gray-500">
                        {group.analytes.slice(0, 2).map(analyteId => {
                          const analyte = analytes.find(a => a.id === analyteId);
                          return analyte?.name;
                        }).filter(Boolean).join(', ')}
                        {group.analytes.length > 2 && ` +${group.analytes.length - 2} more`}
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="text-sm font-medium text-gray-900">₹{group.price}</div>
                      {group.requiresFasting && (
                        <div className="text-xs text-orange-600">Fasting required</div>
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                      {group.sampleType}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium space-x-2">
                      <button 
                        onClick={() => handleViewTestGroup(group)}
                        className="text-blue-600 hover:text-blue-900 p-1 rounded"
                        title="View Test Group Details"
                      >
                        <Eye className="h-4 w-4" />
                      </button>
                      <button 
                        onClick={() => handleEditTestGroup(group)}
                        className="text-gray-600 hover:text-gray-900 p-1 rounded"
                        title="Edit Test Group"
                      >
                        <Edit className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === 'analytes' && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200">
            <h3 className="text-lg font-semibold text-gray-900">
              Analytes ({filteredAnalytes.length})
            </h3>
          </div>
          
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Analyte Details
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Category
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Reference Range
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Critical Values
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {filteredAnalytes.map((analyte) => (
                  <tr key={analyte.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div>
                        <div className="text-sm font-medium text-gray-900">{analyte.name}</div>
                        <div className="text-sm text-gray-500">ID: {analyte.id} • Unit: {analyte.unit}</div>
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getCategoryColor(analyte.category)}`}>
                        {analyte.category}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <div className="text-sm text-gray-900">{analyte.referenceRange}</div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="text-sm text-gray-900">
                        {analyte.lowCritical && <div className="text-red-600">Low: {analyte.lowCritical}</div>}
                        {analyte.highCritical && <div className="text-red-600">High: {analyte.highCritical}</div>}
                        {!analyte.lowCritical && !analyte.highCritical && <span className="text-gray-400">None</span>}
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium space-x-2">
                      <button 
                        onClick={() => handleViewAnalyte(analyte)}
                        className="text-blue-600 hover:text-blue-900 p-1 rounded"
                        title="View Analyte Details"
                      >
                        <Eye className="h-4 w-4" />
                      </button>
                      <button 
                        onClick={() => handleEditAnalyte(analyte)}
                        className="text-gray-600 hover:text-gray-900 p-1 rounded"
                        title="Edit Analyte"
                      >
                        <Edit className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === 'legacy' && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200">
            <h3 className="text-lg font-semibold text-gray-900">
              Legacy Tests ({filteredLegacyTests.length})
            </h3>
          </div>
          
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Test Details
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Category
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Sample Type
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Price
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    TAT
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {filteredLegacyTests.map((test) => (
                  <tr key={test.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div>
                        <div className="text-sm font-medium text-gray-900">{test.name}</div>
                        <div className="text-sm text-gray-500">ID: {test.id} • {test.method}</div>
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getCategoryColor(test.category)}`}>
                        {test.category}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                      {test.sampleType}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="text-sm font-medium text-gray-900">₹{test.price}</div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                      {test.turnaroundTime}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium space-x-2">
                      <button 
                        onClick={() => handleViewLegacyTest(test)}
                        className="text-blue-600 hover:text-blue-900 p-1 rounded"
                        title="View Test Details"
                      >
                        <Eye className="h-4 w-4" />
                      </button>
                      <button 
                        onClick={() => handleEditLegacyTest(test)}
                        className="text-gray-600 hover:text-gray-900 p-1 rounded"
                        title="Edit Test"
                      >
                        <Edit className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Popular Test Groups Section */}
      {activeTab === 'packages' && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-900">Popular Health Packages</h3>
            <button className="text-purple-600 hover:text-purple-700 text-sm font-medium">
              View All Packages →
            </button>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {packages.slice(0, 3).map((pkg) => {
              const includedGroups = testGroups.filter(group => pkg.testGroupIds.includes(group.id));
              const originalPrice = includedGroups.reduce((sum, group) => sum + group.price, 0);
              const savings = originalPrice - pkg.price;
              
              return (
                <div key={pkg.id} className="border border-gray-200 rounded-lg p-4 hover:shadow-md transition-shadow">
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="font-medium text-gray-900">{pkg.name}</h4>
                    <div className="text-right">
                      <div className="text-lg font-bold text-purple-600">₹{pkg.price}</div>
                      {savings > 0 && (
                        <div className="text-xs text-green-600">Save ₹{savings}</div>
                      )}
                    </div>
                  </div>
                  <p className="text-sm text-gray-600 mb-3">{pkg.description}</p>
                  <div className="flex items-center justify-between text-xs text-gray-500">
                    <span>{pkg.testGroupIds.length} test groups included</span>
                    <span className="px-2 py-1 rounded bg-purple-100 text-purple-800">
                      {pkg.category}
                    </span>
                  </div>
                  {pkg.discountPercentage > 0 && (
                    <div className="mt-2 text-xs text-blue-600 font-medium">
                      {pkg.discountPercentage}% discount applied
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {activeTab === 'groups' && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-900">Popular Test Groups</h3>
            <button className="text-blue-600 hover:text-blue-700 text-sm font-medium">
              View All Groups →
            </button>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {testGroups.slice(0, 3).map((group) => (
              <div key={group.id} className="border border-gray-200 rounded-lg p-4 hover:shadow-md transition-shadow">
                <div className="flex items-center justify-between mb-2">
                  <h4 className="font-medium text-gray-900">{group.name}</h4>
                  <span className="text-lg font-bold text-green-600">₹{group.price}</span>
                </div>
                <p className="text-sm text-gray-600 mb-3">{group.clinicalPurpose}</p>
                <div className="flex items-center justify-between text-xs text-gray-500">
                  <span>{group.analytes.length} analytes included</span>
                  <span className={`px-2 py-1 rounded ${getCategoryColor(group.category)}`}>
                    {group.category}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Test Form Modal */}
      {showTestForm && (
        <TestForm
          onClose={handleCloseTestForm}
          onSubmit={editingTest ? handleUpdateTest : handleAddTest}
          test={editingTest}
        />
      )}

      {/* Analyte Form Modal */}
      {showAnalyteForm && (
        <AnalyteForm
          onClose={handleCloseAnalyteForm}
          onSubmit={editingAnalyte ? handleUpdateAnalyte : handleAddAnalyte}
          analyte={editingAnalyte}
        />
      )}

      {/* Test Group Form Modal */}
      {showTestGroupForm && (
        <TestGroupForm
          onClose={handleCloseTestGroupForm}
          onSubmit={editingTestGroup ? handleUpdateTestGroup : handleAddTestGroup}
          testGroup={editingTestGroup}
        />
      )}

      {/* Package Form Modal */}
      {showPackageForm && (
        <PackageForm
          onClose={handleClosePackageForm}
          onSubmit={editingPackage ? handleUpdatePackage : handleAddPackage}
          package={editingPackage}
        />
      )}

      {/* Detail Modals */}
      {showTestDetail && selectedTest && (
        <TestDetailModal
          test={selectedTest}
          onClose={() => setShowTestDetail(false)}
          onEdit={() => {
            setShowTestDetail(false);
            handleEditLegacyTest(selectedTest);
          }}
        />
      )}

      {showAnalyteDetail && selectedAnalyte && (
        <AnalyteDetailModal
          analyte={selectedAnalyte}
          onClose={() => setShowAnalyteDetail(false)}
          onEdit={() => {
            setShowAnalyteDetail(false);
            handleEditAnalyte(selectedAnalyte);
          }}
        />
      )}

      {showTestGroupDetail && selectedTestGroup && (
        <TestGroupDetailModal
          testGroup={selectedTestGroup}
          analytes={analytes}
          onClose={() => setShowTestGroupDetail(false)}
          onEdit={() => {
            setShowTestGroupDetail(false);
            handleEditTestGroup(selectedTestGroup);
          }}
        />
      )}

      {showPackageDetail && selectedPackage && (
        <PackageDetailModal
          package={selectedPackage}
          testGroups={testGroups}
          onClose={() => setShowPackageDetail(false)}
          onEdit={() => {
            setShowPackageDetail(false);
            handleEditPackage(selectedPackage);
          }}
        />
      )}

      {/* Edit Analyte Modal */}
      {showEditAnalyteModal && editingAnalyte && (
        <EditAnalyteModal
          analyte={editingAnalyte}
          isOpen={showEditAnalyteModal}
          onClose={handleCloseAnalyteModal}
          onSave={handleUpdateAnalyte}
        />
      )}

      {/* Create Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-semibold">Create Test Group</h2>
              <button
                onClick={() => setShowCreateModal(false)}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="w-6 h-6" />
              </button>
            </div>

            <form onSubmit={handleCreateTestGroup} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Test Group Name *
                </label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Category *
                </label>
                <select
                  value={formData.category}
                  onChange={(e) => setFormData(prev => ({ ...prev, category: e.target.value }))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  required
                >
                  <option value="">Select Category</option>
                  <option value="Hematology">Hematology</option>
                  <option value="Chemistry">Chemistry</option>
                  <option value="Immunology">Immunology</option>
                  <option value="Microbiology">Microbiology</option>
                  <option value="Blood Banking">Blood Banking</option>
                  <option value="Clinical Pathology">Clinical Pathology</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Description
                </label>
                <textarea
                  value={formData.description}
                  onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                  rows={3}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Select Analytes
                </label>
                <div className="max-h-60 overflow-y-auto border border-gray-300 rounded-md p-3">
                  {analytes.map((analyte) => (
                    <div key={analyte.id} className="flex items-center space-x-2 mb-2">
                      <input
                        type="checkbox"
                        id={`analyte-${analyte.id}`}
                        checked={formData.selectedAnalytes.includes(analyte.id)}
                        onChange={() => handleAnalyteToggle(analyte.id)}
                        className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                      />
                      <label
                        htmlFor={`analyte-${analyte.id}`}
                        className="text-sm text-gray-700 cursor-pointer flex-1"
                      >
                        {analyte.name} ({analyte.unit}) - {analyte.category}
                      </label>
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex justify-end space-x-3 pt-4 border-t">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-4 py-2 text-gray-700 bg-gray-100 rounded-md hover:bg-gray-200"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
                >
                  Create Test Group
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Modal with Enhanced Analyte Display */}
      {showEditModal && editingTestGroup && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 w-full max-w-3xl max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-semibold">Edit Test Group</h2>
              <button
                onClick={() => setShowEditModal(false)}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="w-6 h-6" />
              </button>
            </div>

            <form onSubmit={handleUpdateTestGroup} className="space-y-6">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Test Group Name *
                  </label>
                  <input
                    type="text"
                    value={formData.name}
                    onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    required
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Category *
                  </label>
                  <select
                    value={formData.category}
                    onChange={(e) => setFormData(prev => ({ ...prev, category: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    required
                  >
                    <option value="">Select Category</option>
                    <option value="Hematology">Hematology</option>
                    <option value="Chemistry">Chemistry</option>
                    <option value="Immunology">Immunology</option>
                    <option value="Microbiology">Microbiology</option>
                    <option value="Blood Banking">Blood Banking</option>
                    <option value="Clinical Pathology">Clinical Pathology</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Description
                </label>
                <textarea
                  value={formData.description}
                  onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                  rows={3}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-3">
                  Current Analytes ({editingTestGroup.analytes?.length || 0})
                </label>
                
                {/* Enhanced Analytes Display with Edit Button */}
                <div className="space-y-3 mb-6">
                  {editingTestGroup.analytes?.map((analyte) => (
                    <div key={analyte.id} className="flex items-center justify-between p-4 bg-gray-50 rounded-lg border">
                      <div className="flex-1">
                        <div className="flex items-center justify-between">
                          <div>
                            <h4 className="font-medium text-gray-900">{analyte.name}</h4>
                            <p className="text-sm text-gray-600">
                              {analyte.unit} • Range: {analyte.reference_range}
                            </p>
                            <div className="flex items-center space-x-3 mt-1">
                              <span className="text-xs text-gray-500">Category: {analyte.category}</span>
                              {analyte.is_critical && (
                                <span className="px-2 py-1 bg-red-100 text-red-800 text-xs rounded-full">
                                  Critical
                                </span>
                              )}
                              {analyte.method && (
                                <span className="text-xs text-gray-500">Method: {analyte.method}</span>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center space-x-2">
                            <button
                              type="button"
                              onClick={() => alert('Edit Analyte functionality will be added here')}
                              className="p-2 text-blue-600 hover:bg-blue-50 rounded-md transition-colors"
                              title="Edit Analyte Details"
                            >
                              <Edit2 className="w-4 h-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => removeAnalyteFromGroup(analyte.id)}
                              className="p-2 text-red-600 hover:bg-red-50 rounded-md transition-colors"
                              title="Remove from Test Group"
                            >
                              <X className="w-4 h-4" />
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  )) || []}
                  
                  {/* Empty state */}
                  {(!editingTestGroup.analytes || editingTestGroup.analytes.length === 0) && (
                    <div className="text-center py-8 text-gray-500 bg-gray-50 rounded-lg border-2 border-dashed border-gray-300">
                      <p>No analytes added to this test group yet.</p>
                      <p className="text-sm">Use the selection below to add analytes.</p>
                    </div>
                  )}
                </div>

                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Add More Analytes
                </label>
                <div className="max-h-60 overflow-y-auto border border-gray-300 rounded-md p-3">
                  {analytes
                    .filter(analyte => !formData.selectedAnalytes.includes(analyte.id))
                    .map((analyte) => (
                    <div key={analyte.id} className="flex items-center space-x-2 mb-2">
                      <input
                        type="checkbox"
                        id={`edit-analyte-${analyte.id}`}
                        checked={formData.selectedAnalytes.includes(analyte.id)}
                        onChange={() => handleAnalyteToggle(analyte.id)}
                        className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                      />
                      <label
                        htmlFor={`edit-analyte-${analyte.id}`}
                        className="text-sm text-gray-700 cursor-pointer flex-1"
                      >
                        {analyte.name} ({analyte.unit}) - {analyte.category}
                      </label>
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex justify-end space-x-3 pt-4 border-t">
                <button
                  type="button"
                  onClick={() => setShowEditModal(false)}
                  className="px-4 py-2 text-gray-700 bg-gray-100 rounded-md hover:bg-gray-200"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 flex items-center space-x-2"
                >
                  <Save className="w-4 h-4" />
                  <span>Update Test Group</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default Tests;