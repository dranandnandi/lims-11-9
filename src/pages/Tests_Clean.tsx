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

      // Fetch test groups
      const { data: testGroupsData, error: testGroupsError } = await supabase
        .from('test_groups')
        .select('*')
        .order('name');

      if (testGroupsError) throw testGroupsError;

      // Fetch analytes
      const { data: analytesData, error: analytesError } = await supabase
        .from('analytes')
        .select('*')
        .order('name');

      if (analytesError) throw analytesError;

      // Fetch test group analyte relationships
      const { data: relationshipsData, error: relationshipsError } = await supabase
        .from('test_group_analytes')
        .select(`
          test_group_id,
          analyte_id,
          analytes (*)
        `);

      if (relationshipsError) throw relationshipsError;

      // Transform and combine data
      const transformedTestGroups = (testGroupsData || []).map(group => ({
        ...group,
        analytes: relationshipsData
          ?.filter(rel => rel.test_group_id === group.id)
          .map(rel => rel.analytes)
          .filter(Boolean) || []
      }));

      setTestGroups(transformedTestGroups);
      setAnalytes(analytesData || []);

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
      const { data: newTestGroup, error } = await supabase
        .from('test_groups')
        .insert({
          name: formData.name,
          category: formData.category,
          description: formData.description
        })
        .select()
        .single();

      if (error) throw error;

      // Add analyte relationships
      if (formData.selectedAnalytes.length > 0) {
        const relationships = formData.selectedAnalytes.map(analyteId => ({
          test_group_id: newTestGroup.id,
          analyte_id: analyteId
        }));

        const { error: relationshipError } = await supabase
          .from('test_group_analytes')
          .insert(relationships);

        if (relationshipError) throw relationshipError;
      }

      // Refresh data
      await fetchData();
      
      // Reset form
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
      // Update test group
      const { error: updateError } = await supabase
        .from('test_groups')
        .update({
          name: formData.name,
          category: formData.category,
          description: formData.description,
          updated_at: new Date().toISOString()
        })
        .eq('id', editingTestGroup.id);

      if (updateError) throw updateError;

      // Update analyte relationships
      // First, delete existing relationships
      const { error: deleteError } = await supabase
        .from('test_group_analytes')
        .delete()
        .eq('test_group_id', editingTestGroup.id);

      if (deleteError) throw deleteError;

      // Then, add new relationships
      if (formData.selectedAnalytes.length > 0) {
        const relationships = formData.selectedAnalytes.map(analyteId => ({
          test_group_id: editingTestGroup.id,
          analyte_id: analyteId
        }));

        const { error: insertError } = await supabase
          .from('test_group_analytes')
          .insert(relationships);

        if (insertError) throw insertError;
      }

      // Refresh data
      await fetchData();
      
      // Reset form
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
      const { error } = await supabase
        .from('test_groups')
        .delete()
        .eq('id', id);

      if (error) throw error;

      await fetchData();
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
          <div key={testGroup.id} className="bg-white rounded-lg shadow-md border p-6">
            <div className="flex justify-between items-start mb-4">
              <div>
                <h3 className="text-lg font-semibold text-gray-900">{testGroup.name}</h3>
                <span className="inline-block px-2 py-1 bg-blue-100 text-blue-800 text-sm rounded-full">
                  {testGroup.category}
                </span>
              </div>
              <div className="flex space-x-2">
                <button
                  onClick={() => handleEditTestGroup(testGroup)}
                  className="text-blue-600 hover:text-blue-800"
                >
                  <Edit2 className="w-4 h-4" />
                </button>
                <button
                  onClick={() => handleDeleteTestGroup(testGroup.id)}
                  className="text-red-600 hover:text-red-800"
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
                    <div key={analyte.id} className="text-sm text-gray-600">
                      • {analyte.name} ({analyte.unit})
                    </div>
                  ))}
                  {testGroup.analytes.length > 3 && (
                    <div className="text-sm text-gray-500">
                      +{testGroup.analytes.length - 3} more...
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-sm text-gray-500">No analytes configured</p>
              )}
            </div>

            <div className="text-xs text-gray-500">
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

      {/* Edit Modal */}
      {showEditModal && editingTestGroup && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-semibold">Edit Test Group</h2>
              <button
                onClick={() => setShowEditModal(false)}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="w-6 h-6" />
              </button>
            </div>

            <form onSubmit={handleUpdateTestGroup} className="space-y-4">
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
                  Current Analytes
                </label>
                <div className="space-y-3 mb-4">
                  {editingTestGroup.analytes?.map((analyte) => (
                    <div key={analyte.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                      <div className="flex-1">
                        <h4 className="font-medium text-gray-900">{analyte.name}</h4>
                        <p className="text-sm text-gray-600">
                          {analyte.unit} • Range: {analyte.reference_range}
                        </p>
                        <p className="text-xs text-gray-500">Category: {analyte.category}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => removeAnalyteFromGroup(analyte.id)}
                        className="text-red-600 hover:text-red-800"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  )) || []}
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
                  className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
                >
                  Update Test Group
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