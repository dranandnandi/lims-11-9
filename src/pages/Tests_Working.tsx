import React, { useState, useEffect } from 'react';
import { Plus, Edit2, Trash2, Search, Filter, X, Save, AlertCircle } from 'lucide-react';
import { supabase } from '../utils/supabase';
import { SimpleAnalyteEditor } from '../components/TestGroups/SimpleAnalyteEditor';

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
  low_critical?: number | null;
  high_critical?: number | null;
  interpretation_low?: string;
  interpretation_normal?: string;
  interpretation_high?: string;
  is_active?: boolean;
  ai_processing_type?: string;
  ai_prompt_override?: string | null;
  group_ai_mode?: string;
  is_global?: boolean;
  to_be_copied?: boolean;
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
  const [showAnalyteEditor, setShowAnalyteEditor] = useState(false);
  const [editingAnalyte, setEditingAnalyte] = useState<Analyte | null>(null);
  const [showAnalyteSearchModal, setShowAnalyteSearchModal] = useState(false);
  const [analyteSearchTerm, setAnalyteSearchTerm] = useState('');
  const [showAITestModal, setShowAITestModal] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

      // Fetch test groups from database
      const { data: testGroupsData, error: testGroupsError } = await supabase
        .from('test_groups')
        .select('*')
        .order('name');

      if (testGroupsError) {
        console.error('Test groups error:', testGroupsError);
        throw testGroupsError;
      }

      // Fetch analytes from database
      const { data: analytesData, error: analytesError } = await supabase
        .from('analytes')
        .select('*')
        .order('name');

      if (analytesError) {
        console.error('Analytes error:', analytesError);
        throw analytesError;
      }

      // Fetch test group analyte relationships
      const { data: relationshipsData, error: relationshipsError } = await supabase
        .from('test_group_analytes')
        .select(`
          test_group_id,
          analyte_id,
          analytes (*)
        `);

      if (relationshipsError) {
        console.error('Relationships error:', relationshipsError);
        // Don't throw - relationships might not exist yet
      }

      // Transform and combine data
      const transformedTestGroups = (testGroupsData || []).map(group => ({
        id: group.id,
        name: group.name,
        category: group.category,
        description: group.description,
        created_at: group.created_at,
        updated_at: group.updated_at,
        analytes: relationshipsData
          ?.filter(rel => rel.test_group_id === group.id)
          .map(rel => rel.analytes)
          .filter(Boolean)
          .map((analyte: any) => ({
            id: analyte.id,
            name: analyte.name,
            unit: analyte.unit || '',
            reference_range: analyte.reference_range || '',
            category: analyte.category || 'General',
            method: analyte.method,
            description: analyte.description,
            is_critical: analyte.is_critical || false,
            normal_range_min: analyte.normal_range_min,
            normal_range_max: analyte.normal_range_max
          })) || []
      }));

      // Transform analytes data
      const transformedAnalytes = (analytesData || []).map(analyte => ({
        id: analyte.id,
        name: analyte.name,
        unit: analyte.unit || '',
        reference_range: analyte.reference_range || '',
        category: analyte.category || 'General',
        method: analyte.method,
        description: analyte.description,
        is_critical: analyte.is_critical || false,
        normal_range_min: analyte.normal_range_min,
        normal_range_max: analyte.normal_range_max,
        low_critical: analyte.low_critical,
        high_critical: analyte.high_critical,
        interpretation_low: analyte.interpretation_low,
        interpretation_normal: analyte.interpretation_normal,
        interpretation_high: analyte.interpretation_high,
        is_active: analyte.is_active !== false,
        ai_processing_type: analyte.ai_processing_type,
        ai_prompt_override: analyte.ai_prompt_override,
        group_ai_mode: analyte.group_ai_mode,
        is_global: analyte.is_global || false,
        to_be_copied: analyte.to_be_copied || false
      }));

      setTestGroups(transformedTestGroups);
      setAnalytes(transformedAnalytes);

      console.log('Fetched test groups:', transformedTestGroups);
      console.log('Fetched analytes:', transformedAnalytes);

    } catch (err) {
      console.error('Error fetching data:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch data from database');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateTestGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setError(null);

      // Insert test group into database
      const { data: newTestGroup, error: insertError } = await supabase
        .from('test_groups')
        .insert({
          name: formData.name,
          category: formData.category,
          description: formData.description
        })
        .select()
        .single();

      if (insertError) throw insertError;

      // Add analyte relationships if any selected
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

      // Refresh data from database
      await fetchData();
      
      setFormData({ name: '', category: '', description: '', selectedAnalytes: [] });
      setShowCreateModal(false);

    } catch (err) {
      console.error('Error creating test group:', err);
      setError(err instanceof Error ? err.message : 'Failed to create test group');
    }
  };

  const handleEditTestGroup = (testGroup: TestGroup) => {
    // Fetch the full test group data with all fields from the database
    const fetchFullTestGroup = async () => {
      try {
        const { data: fullTestGroup, error } = await supabase
          .from('test_groups')
          .select('*')
          .eq('id', testGroup.id)
          .single();

        if (error) throw error;

        setEditingTestGroup({
          ...testGroup,
          ...fullTestGroup // Merge all database fields
        });
      } catch (err) {
        console.error('Error fetching full test group:', err);
        setEditingTestGroup(testGroup); // Fallback to original data
      }
    };

    fetchFullTestGroup();
    
    setFormData({
      name: testGroup.name,
      category: testGroup.category,
      description: testGroup.description || '',
      selectedAnalytes: testGroup.analytes?.map(a => a.id) || []
    });
    setAnalyteSearchTerm(''); // Reset search term when opening edit modal
    setShowEditModal(true);
  };

  const handleUpdateTestGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingTestGroup) return;

    try {
      setError(null);

      // Update test group in database
      const { error: updateError } = await supabase
        .from('test_groups')
        .update({
          name: formData.name,
          category: formData.category,
          description: formData.description,
          clinical_purpose: (editingTestGroup as any)?.clinical_purpose || null,
          price: (editingTestGroup as any)?.price ? parseFloat((editingTestGroup as any).price) : null,
          turnaround_time: (editingTestGroup as any)?.turnaround_time ? parseInt((editingTestGroup as any).turnaround_time) : null,
          sample_type: (editingTestGroup as any)?.sample_type || null,
          requires_fasting: (editingTestGroup as any)?.requires_fasting || false,
          default_ai_processing_type: (editingTestGroup as any)?.default_ai_processing_type || 'ocr_report',
          group_level_prompt: (editingTestGroup as any)?.group_level_prompt || null,
          to_be_copied: (editingTestGroup as any)?.to_be_copied || false,
          updated_at: new Date().toISOString()
        })
        .eq('id', editingTestGroup.id);

      if (updateError) throw updateError;

      // Update analyte relationships
      // First delete existing relationships
      const { error: deleteError } = await supabase
        .from('test_group_analytes')
        .delete()
        .eq('test_group_id', editingTestGroup.id);

      if (deleteError) throw deleteError;

      // Insert new relationships
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

      // Refresh data from database
      await fetchData();

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

      // Refresh data from database
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

  // Handle editing analyte
  const handleEditAnalyte = (analyte: Analyte) => {
    setEditingAnalyte(analyte);
    setShowAnalyteEditor(true);
  };

  // Handle saving analyte changes
  const handleSaveAnalyte = async (updatedAnalyte: Analyte) => {
    try {
      // Update local analytes state
      setAnalytes(prev => 
        prev.map(analyte => 
          analyte.id === updatedAnalyte.id ? updatedAnalyte : analyte
        )
      );
      
      // Update test groups state if this analyte is associated with any
      setTestGroups(prev => 
        prev.map(group => ({
          ...group,
          analytes: group.analytes?.map(analyte => 
            analyte.id === updatedAnalyte.id ? updatedAnalyte : analyte
          ) || []
        }))
      );
      
      setShowAnalyteEditor(false);
      setEditingAnalyte(null);
    } catch (error) {
      console.error('Failed to update analyte:', error);
      setError('Failed to update analyte');
    }
  };

  // Handle closing analyte editor
  const handleCancelAnalyteEdit = () => {
    setShowAnalyteEditor(false);
    setEditingAnalyte(null);
  };

  // Handle AI test configuration response
  const handleAITestConfig = async (aiResponse: any) => {
    try {
      setError(null);
      const { testGroup, analytes } = aiResponse.data;

      // First create the test group
      const { data: newTestGroup, error: testGroupError } = await supabase
        .from('test_groups')
        .insert({
          name: testGroup.name,
          category: testGroup.category,
          description: testGroup.description,
          clinical_purpose: testGroup.clinical_purpose,
          price: testGroup.price,
          turnaround_time: testGroup.tat_hours,
          sample_type: testGroup.sample_type,
          instructions: testGroup.instructions
        })
        .select()
        .single();

      if (testGroupError) throw testGroupError;

      // Create analytes and get their IDs
      const createdAnalyteIds: string[] = [];
      
      for (const analyte of analytes) {
        const { data: newAnalyte, error: analyteError } = await supabase
          .from('analytes')
          .insert({
            name: analyte.name,
            unit: analyte.unit,
            method: analyte.method,
            normal_range_min: analyte.reference_min,
            normal_range_max: analyte.reference_max,
            reference_range: `${analyte.reference_min}-${analyte.reference_max}`,
            low_critical: analyte.critical_min > 0 ? analyte.critical_min : null,
            high_critical: analyte.critical_max > 0 ? analyte.critical_max : null,
            description: analyte.description,
            category: testGroup.category,
            is_active: true,
            ai_processing_type: 'ocr_report',
            group_ai_mode: 'individual'
          })
          .select()
          .single();

        if (analyteError) {
          console.error('Error creating analyte:', analyteError);
          // Continue with other analytes even if one fails
          continue;
        }

        createdAnalyteIds.push(newAnalyte.id);
      }

      // Create relationships between test group and analytes
      if (createdAnalyteIds.length > 0) {
        const relationships = createdAnalyteIds.map(analyteId => ({
          test_group_id: newTestGroup.id,
          analyte_id: analyteId
        }));

        const { error: relationshipError } = await supabase
          .from('test_group_analytes')
          .insert(relationships);

        if (relationshipError) throw relationshipError;
      }

      // Refresh data to show the new test group and analytes
      await fetchData();
      
      setShowAITestModal(false);

    } catch (err) {
      console.error('Error creating AI test configuration:', err);
      setError(err instanceof Error ? err.message : 'Failed to create AI test configuration');
    }
  };

  const filteredTestGroups = testGroups.filter(group => {
    const matchesSearch = group.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         group.category.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesCategory = !categoryFilter || group.category === categoryFilter;
    return matchesSearch && matchesCategory;
  });

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
        <div className="flex space-x-3">
          <button
            onClick={() => setShowAITestModal(true)}
            className="flex items-center space-x-2 px-4 py-2 bg-purple-600 text-white rounded-md hover:bg-purple-700"
          >
            <span>🤖</span>
            <span>AI Test Configuration</span>
          </button>
          <button
            onClick={() => setShowAnalyteSearchModal(true)}
            className="flex items-center space-x-2 px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700"
          >
            <Search className="w-4 h-4" />
            <span>Search & Edit Analytes</span>
          </button>
          <button
            onClick={() => setShowCreateModal(true)}
            className="flex items-center space-x-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
          >
            <Plus className="w-4 h-4" />
            <span>Add Test Group</span>
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-md flex items-center space-x-2">
          <AlertCircle className="w-5 h-5 text-red-600" />
          <div className="flex-1">
            <span className="text-red-700">{error}</span>
            <div className="text-xs text-red-600 mt-1">
              Check browser console for more details
            </div>
          </div>
          <button onClick={() => setError(null)} className="ml-auto text-red-600 hover:text-red-800">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Debug Information */}
      <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-md">
        <div className="text-sm text-blue-800">
          <strong>Debug Info:</strong> Test Groups: {testGroups.length} | Analytes: {analytes.length}
          {testGroups.length === 0 && analytes.length === 0 && (
            <span className="text-red-600 ml-2">⚠️ No data found in database</span>
          )}
        </div>
      </div>

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
              <button onClick={() => setShowCreateModal(false)} className="text-gray-400 hover:text-gray-600">
                <X className="w-6 h-6" />
              </button>
            </div>

            <form onSubmit={handleCreateTestGroup} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Test Group Name *</label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Category *</label>
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
                <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                <textarea
                  value={formData.description}
                  onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                  rows={3}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Select Analytes</label>
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
                      <label htmlFor={`analyte-${analyte.id}`} className="text-sm text-gray-700 cursor-pointer flex-1">
                        {analyte.name} ({analyte.unit}) - {analyte.category}
                      </label>
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex justify-end space-x-3 pt-4 border-t">
                <button type="button" onClick={() => setShowCreateModal(false)} className="px-4 py-2 text-gray-700 bg-gray-100 rounded-md hover:bg-gray-200">
                  Cancel
                </button>
                <button type="submit" className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700">
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
          <div className="bg-white rounded-lg p-6 w-full max-w-4xl max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-semibold">Edit Test Group</h2>
              <button onClick={() => {
                setShowEditModal(false);
                setAnalyteSearchTerm(''); // Reset search term when closing modal
              }} className="text-gray-400 hover:text-gray-600">
                <X className="w-6 h-6" />
              </button>
            </div>

            <form onSubmit={handleUpdateTestGroup} className="space-y-6">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Test Group Name *</label>
                  <input
                    type="text"
                    value={formData.name}
                    onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Category *</label>
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
                <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                <textarea
                  value={formData.description}
                  onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                  rows={3}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              {/* Clinical Purpose */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Clinical Purpose</label>
                <input
                  type="text"
                  value={(editingTestGroup as any)?.clinical_purpose || ''}
                  onChange={(e) => setEditingTestGroup(prev => prev ? { ...prev, clinical_purpose: e.target.value } : null)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="e.g., Inflammatory marker, Liver function assessment"
                />
              </div>

              {/* Price and Turnaround Time */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Price *</label>
                  <div className="relative">
                    <span className="absolute left-3 top-2 text-gray-500">₹</span>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={(editingTestGroup as any)?.price || ''}
                      onChange={(e) => setEditingTestGroup(prev => prev ? { ...prev, price: e.target.value } : null)}
                      className="w-full pl-8 pr-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                      placeholder="0.00"
                      required
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Turnaround Time (hours) *</label>
                  <input
                    type="number"
                    min="1"
                    max="72"
                    value={(editingTestGroup as any)?.turnaround_time || ''}
                    onChange={(e) => setEditingTestGroup(prev => prev ? { ...prev, turnaround_time: e.target.value } : null)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="4"
                    required
                  />
                </div>
              </div>

              {/* Sample Type and Fasting */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Sample Type *</label>
                  <select
                    value={(editingTestGroup as any)?.sample_type || ''}
                    onChange={(e) => setEditingTestGroup(prev => prev ? { ...prev, sample_type: e.target.value } : null)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    required
                  >
                    <option value="">Select Sample Type</option>
                    <option value="Serum">Serum</option>
                    <option value="Plasma">Plasma</option>
                    <option value="Whole Blood">Whole Blood</option>
                    <option value="Urine">Urine</option>
                    <option value="Stool">Stool</option>
                    <option value="CSF">CSF</option>
                    <option value="Sputum">Sputum</option>
                    <option value="Swab">Swab</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Requires Fasting</label>
                  <select
                    value={(editingTestGroup as any)?.requires_fasting ? 'true' : 'false'}
                    onChange={(e) => setEditingTestGroup(prev => prev ? { ...prev, requires_fasting: e.target.value === 'true' } : null)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="false">No</option>
                    <option value="true">Yes</option>
                  </select>
                </div>
              </div>

              {/* AI Processing Configuration */}
              <div className="border-t pt-4">
                <h4 className="text-md font-medium text-gray-900 mb-3">AI Processing Configuration</h4>
                
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Default AI Processing Type</label>
                    <select
                      value={(editingTestGroup as any)?.default_ai_processing_type || 'ocr_report'}
                      onChange={(e) => setEditingTestGroup(prev => prev ? { ...prev, default_ai_processing_type: e.target.value } : null)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="ocr_report">OCR Report</option>
                      <option value="gemini">Gemini AI</option>
                      <option value="manual">Manual Entry</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Template for Copying</label>
                    <select
                      value={(editingTestGroup as any)?.to_be_copied ? 'true' : 'false'}
                      onChange={(e) => setEditingTestGroup(prev => prev ? { ...prev, to_be_copied: e.target.value === 'true' } : null)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="false">Not a Template</option>
                      <option value="true">Use as Template</option>
                    </select>
                  </div>
                </div>

                <div className="mt-4">
                  <label className="block text-sm font-medium text-gray-700 mb-1">Group Level AI Prompt (Optional)</label>
                  <textarea
                    rows={3}
                    value={(editingTestGroup as any)?.group_level_prompt || ''}
                    onChange={(e) => setEditingTestGroup(prev => prev ? { ...prev, group_level_prompt: e.target.value || null } : null)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="Custom AI prompt for processing this test group results..."
                  />
                  <p className="mt-1 text-xs text-gray-500">
                    Override the default AI prompt for better result interpretation specific to this test group.
                  </p>
                </div>
              </div>

              {/* Enhanced Analytes Section */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-3">
                  📊 Current Analytes ({editingTestGroup.analytes?.length || 0})
                </label>
                
                <div className="space-y-3 mb-6">
                  {editingTestGroup.analytes?.map((analyte) => (
                    <div key={analyte.id} className="flex items-center justify-between p-4 bg-gradient-to-r from-gray-50 to-blue-50 rounded-lg border-l-4 border-blue-400">
                      <div className="flex-1">
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
                        </div>
                      </div>
                      <div className="flex items-center space-x-2">
                        <button
                          type="button"
                          onClick={() => handleEditAnalyte(analyte)}
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
                  )) || []}
                  
                  {(!editingTestGroup.analytes || editingTestGroup.analytes.length === 0) && (
                    <div className="text-center py-8 text-gray-500 bg-gray-50 rounded-lg border-2 border-dashed border-gray-300">
                      <p className="font-medium">No analytes added to this test group yet</p>
                      <p className="text-sm">Use the selection below to add analytes</p>
                    </div>
                  )}
                </div>

                <label className="block text-sm font-medium text-gray-700 mb-2">➕ Add More Analytes</label>
                
                {/* Search bar for analytes */}
                <div className="mb-3">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4" />
                    <input
                      type="text"
                      placeholder="Search analytes by name, category, or unit..."
                      value={analyteSearchTerm}
                      onChange={(e) => setAnalyteSearchTerm(e.target.value)}
                      className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                    />
                  </div>
                </div>

                <div className="max-h-60 overflow-y-auto border border-gray-300 rounded-md p-3 bg-white">
                  {analytes
                    .filter(analyte => 
                      !formData.selectedAnalytes.includes(analyte.id) &&
                      (analyteSearchTerm === '' ||
                       analyte.name.toLowerCase().includes(analyteSearchTerm.toLowerCase()) ||
                       analyte.category.toLowerCase().includes(analyteSearchTerm.toLowerCase()) ||
                       analyte.unit.toLowerCase().includes(analyteSearchTerm.toLowerCase()) ||
                       (analyte.description || '').toLowerCase().includes(analyteSearchTerm.toLowerCase()))
                    )
                    .map((analyte) => (
                    <div key={analyte.id} className="flex items-center space-x-2 mb-2 p-2 hover:bg-gray-50 rounded">
                      <input
                        type="checkbox"
                        id={`edit-analyte-${analyte.id}`}
                        checked={formData.selectedAnalytes.includes(analyte.id)}
                        onChange={() => handleAnalyteToggle(analyte.id)}
                        className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                      />
                      <label htmlFor={`edit-analyte-${analyte.id}`} className="text-sm text-gray-700 cursor-pointer flex-1">
                        <span className="font-medium">{analyte.name}</span> ({analyte.unit}) - {analyte.category}
                        {analyte.description && (
                          <div className="text-xs text-gray-500 ml-1">{analyte.description}</div>
                        )}
                      </label>
                    </div>
                  ))}
                  
                  {analytes.filter(analyte => 
                    !formData.selectedAnalytes.includes(analyte.id) &&
                    (analyteSearchTerm === '' ||
                     analyte.name.toLowerCase().includes(analyteSearchTerm.toLowerCase()) ||
                     analyte.category.toLowerCase().includes(analyteSearchTerm.toLowerCase()) ||
                     analyte.unit.toLowerCase().includes(analyteSearchTerm.toLowerCase()) ||
                     (analyte.description || '').toLowerCase().includes(analyteSearchTerm.toLowerCase()))
                  ).length === 0 && (
                    <div className="text-center py-4 text-gray-500">
                      {analyteSearchTerm ? (
                        <div>
                          <p className="font-medium">No analytes found matching "{analyteSearchTerm}"</p>
                          <p className="text-sm">Try a different search term</p>
                        </div>
                      ) : (
                        <p>All available analytes are already added</p>
                      )}
                    </div>
                  )}
                </div>

                {/* Search results summary */}
                {analyteSearchTerm && (
                  <div className="mt-2 text-xs text-gray-500">
                    Showing {analytes.filter(analyte => 
                      !formData.selectedAnalytes.includes(analyte.id) &&
                      (analyte.name.toLowerCase().includes(analyteSearchTerm.toLowerCase()) ||
                       analyte.category.toLowerCase().includes(analyteSearchTerm.toLowerCase()) ||
                       analyte.unit.toLowerCase().includes(analyteSearchTerm.toLowerCase()) ||
                       (analyte.description || '').toLowerCase().includes(analyteSearchTerm.toLowerCase()))
                    ).length} analyte(s) matching your search
                  </div>
                )}
              </div>

              <div className="flex justify-end space-x-3 pt-4 border-t">
                <button type="button" onClick={() => {
                  setShowEditModal(false);
                  setAnalyteSearchTerm(''); // Reset search term when cancelling
                }} className="px-4 py-2 text-gray-700 bg-gray-100 rounded-md hover:bg-gray-200">
                  Cancel
                </button>
                <button type="submit" className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 flex items-center space-x-2">
                  <Save className="w-4 h-4" />
                  <span>Update Test Group</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Analyte Editor Modal */}
      {showAnalyteEditor && editingAnalyte && (
        <SimpleAnalyteEditor
          analyte={editingAnalyte}
          onSave={handleSaveAnalyte}
          onCancel={handleCancelAnalyteEdit}
        />
      )}

      {/* Analyte Search & Edit Modal */}
      {showAnalyteSearchModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 w-full max-w-6xl max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-semibold">Search & Edit Analytes</h2>
              <button
                onClick={() => {
                  setShowAnalyteSearchModal(false);
                  setAnalyteSearchTerm('');
                }}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="w-6 h-6" />
              </button>
            </div>

            {/* Search Bar */}
            <div className="mb-6">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4" />
                <input
                  type="text"
                  placeholder="Search analytes by name, category, or unit..."
                  value={analyteSearchTerm}
                  onChange={(e) => setAnalyteSearchTerm(e.target.value)}
                  className="w-full pl-10 pr-4 py-3 text-lg border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>

            {/* Analytes Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {analytes
                .filter(analyte => 
                  analyteSearchTerm === '' ||
                  analyte.name.toLowerCase().includes(analyteSearchTerm.toLowerCase()) ||
                  analyte.category.toLowerCase().includes(analyteSearchTerm.toLowerCase()) ||
                  analyte.unit.toLowerCase().includes(analyteSearchTerm.toLowerCase()) ||
                  (analyte.description || '').toLowerCase().includes(analyteSearchTerm.toLowerCase())
                )
                .map((analyte) => (
                  <div key={analyte.id} className="bg-gradient-to-br from-white to-gray-50 rounded-lg border p-4 hover:shadow-md transition-shadow">
                    <div className="flex justify-between items-start mb-3">
                      <div className="flex-1">
                        <h3 className="font-semibold text-gray-900 text-lg">{analyte.name}</h3>
                        <div className="flex items-center space-x-2 mt-1">
                          <span className="px-2 py-1 bg-blue-100 text-blue-800 text-xs rounded-full">
                            {analyte.category}
                          </span>
                          {analyte.is_critical && (
                            <span className="px-2 py-1 bg-red-100 text-red-800 text-xs rounded-full">
                              Critical
                            </span>
                          )}
                        </div>
                      </div>
                      <button
                        onClick={() => {
                          handleEditAnalyte(analyte);
                          setShowAnalyteSearchModal(false);
                        }}
                        className="p-2 text-blue-600 hover:bg-blue-100 rounded-md transition-colors border border-blue-200"
                        title="Edit Analyte"
                      >
                        <Edit2 className="w-4 h-4" />
                      </button>
                    </div>

                    <div className="space-y-2 text-sm text-gray-600">
                      <div>
                        <span className="font-medium">Unit:</span> {analyte.unit || 'Not specified'}
                      </div>
                      <div>
                        <span className="font-medium">Range:</span> {analyte.reference_range || 'Not specified'}
                      </div>
                      {analyte.method && (
                        <div>
                          <span className="font-medium">Method:</span> {analyte.method}
                        </div>
                      )}
                      {analyte.normal_range_min !== undefined && analyte.normal_range_max !== undefined && (
                        <div>
                          <span className="font-medium">Numeric Range:</span> {analyte.normal_range_min} - {analyte.normal_range_max}
                        </div>
                      )}
                      {analyte.description && (
                        <div className="pt-2 border-t border-gray-200">
                          <span className="font-medium">Description:</span>
                          <p className="text-xs mt-1 text-gray-500">{analyte.description}</p>
                        </div>
                      )}
                    </div>

                    {/* Usage Count */}
                    <div className="mt-3 pt-3 border-t border-gray-200">
                      <div className="text-xs text-gray-500">
                        Used in {testGroups.filter(group => 
                          group.analytes?.some(a => a.id === analyte.id)
                        ).length} test group(s)
                      </div>
                    </div>
                  </div>
                ))}
            </div>

            {/* No Results */}
            {analytes.filter(analyte => 
              analyteSearchTerm !== '' && (
                !analyte.name.toLowerCase().includes(analyteSearchTerm.toLowerCase()) &&
                !analyte.category.toLowerCase().includes(analyteSearchTerm.toLowerCase()) &&
                !analyte.unit.toLowerCase().includes(analyteSearchTerm.toLowerCase()) &&
                !(analyte.description || '').toLowerCase().includes(analyteSearchTerm.toLowerCase())
              )
            ).length === analytes.length && analyteSearchTerm !== '' && (
              <div className="text-center py-8 text-gray-500">
                <p className="text-lg font-medium">No analytes found</p>
                <p className="text-sm">Try a different search term</p>
              </div>
            )}

            {/* Summary */}
            <div className="mt-6 pt-4 border-t border-gray-200">
              <div className="text-sm text-gray-600 text-center">
                Showing {analytes.filter(analyte => 
                  analyteSearchTerm === '' ||
                  analyte.name.toLowerCase().includes(analyteSearchTerm.toLowerCase()) ||
                  analyte.category.toLowerCase().includes(analyteSearchTerm.toLowerCase()) ||
                  analyte.unit.toLowerCase().includes(analyteSearchTerm.toLowerCase()) ||
                  (analyte.description || '').toLowerCase().includes(analyteSearchTerm.toLowerCase())
                ).length} of {analytes.length} analytes
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Tests;