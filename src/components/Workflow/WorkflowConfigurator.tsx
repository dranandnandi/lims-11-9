import React, { useState, useEffect } from 'react';
import { Plus, Trash2, Settings, Save, X, TestTube, Zap } from 'lucide-react';
import { supabase } from '../../utils/supabase';

interface TestGroup {
  id: string;
  name: string;
  category: string;
  code: string;
}

interface Analyte {
  id: string;
  name: string;
  unit: string;
  category: string;
}

interface WorkflowMapping {
  id: string;
  workflowVersionId: string;
  workflowName: string;
  testGroupId?: string;
  testGroupName?: string;
  analyteId?: string;
  analyteName?: string;
  isDefault: boolean;
  isActive: boolean;
  priority: number;
}

interface WorkflowConfiguratorProps {
  labId: string;
  className?: string;
}

export const WorkflowConfigurator: React.FC<WorkflowConfiguratorProps> = ({
  labId,
  className = ''
}) => {
  const [testGroups, setTestGroups] = useState<TestGroup[]>([]);
  const [analytes, setAnalytes] = useState<Analyte[]>([]);
  const [workflowVersions, setWorkflowVersions] = useState<any[]>([]);
  const [mappings, setMappings] = useState<WorkflowMapping[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [activeTab, setActiveTab] = useState<'testgroups' | 'analytes'>('testgroups');

  const [formData, setFormData] = useState({
    workflowVersionId: '',
    testGroupId: '',
    analyteId: '',
    isDefault: false,
    priority: 100
  });

  useEffect(() => {
    loadData();
  }, [labId]);

  const loadData = async () => {
    try {
      setLoading(true);

      // Load test groups
      const { data: testGroupsData } = await supabase
        .from('test_groups')
        .select('id, name, category, code')
        .order('name');

      // Load analytes
      const { data: analytesData } = await supabase
        .from('analytes')
        .select('id, name, unit, category')
        .order('name');

      // Load workflow versions
      const { data: workflowVersionsData } = await supabase
        .from('workflow_versions')
        .select('id, name, definition, version, created_at')
        .order('created_at', { ascending: false });

      // Load existing mappings
      const { data: mappingsData } = await supabase
        .from('test_workflow_map')
        .select(`
          id,
          workflow_version_id,
          test_group_id,
          analyte_id,
          is_default,
          is_active,
          priority,
          workflow_versions (
            id,
            name
          ),
          test_groups (
            id,
            name
          ),
          analytes (
            id,
            name
          )
        `)
        .eq('lab_id', labId);

      setTestGroups(testGroupsData || []);
      setAnalytes(analytesData || []);
      setWorkflowVersions(workflowVersionsData || []);
      
      const transformedMappings = (mappingsData || []).map(mapping => ({
        id: mapping.id,
        workflowVersionId: mapping.workflow_version_id,
        workflowName: (mapping.workflow_versions as any)?.name || 'Unknown',
        testGroupId: mapping.test_group_id,
        testGroupName: (mapping.test_groups as any)?.name,
        analyteId: mapping.analyte_id,
        analyteName: (mapping.analytes as any)?.name,
        isDefault: mapping.is_default,
        isActive: mapping.is_active,
        priority: mapping.priority || 100
      }));

      setMappings(transformedMappings);
    } catch (error) {
      console.error('Failed to load workflow configuration data:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateMapping = async (e: React.FormEvent) => {
    e.preventDefault();
    
    try {
      const { error } = await supabase
        .from('test_workflow_map')
        .insert({
          lab_id: labId,
          workflow_version_id: formData.workflowVersionId,
          test_group_id: formData.testGroupId || null,
          analyte_id: formData.analyteId || null,
          is_default: formData.isDefault,
          is_active: true,
          priority: formData.priority
        });

      if (error) throw error;

      await loadData(); // Refresh data
      setShowCreateModal(false);
      setFormData({ workflowVersionId: '', testGroupId: '', analyteId: '', isDefault: false, priority: 100 });
    } catch (error) {
      console.error('Failed to create workflow mapping:', error);
    }
  };

  const handleDeleteMapping = async (mappingId: string) => {
    if (!confirm('Are you sure you want to delete this workflow mapping?')) return;

    try {
      const { error } = await supabase
        .from('test_workflow_map')
        .delete()
        .eq('id', mappingId);

      if (error) throw error;

      await loadData();
    } catch (error) {
      console.error('Failed to delete workflow mapping:', error);
    }
  };

  const toggleMappingStatus = async (mappingId: string, isActive: boolean) => {
    try {
      const { error } = await supabase
        .from('test_workflow_map')
        .update({ is_active: !isActive })
        .eq('id', mappingId);

      if (error) throw error;

      await loadData();
    } catch (error) {
      console.error('Failed to update workflow mapping:', error);
    }
  };

  const testGroupMappings = mappings.filter(m => m.testGroupId && !m.analyteId);
  const analyteMappings = mappings.filter(m => m.analyteId);

  if (loading) {
    return (
      <div className={`bg-white rounded-lg shadow-sm border p-6 ${className}`}>
        <div className="animate-pulse">
          <div className="h-4 bg-gray-200 rounded w-1/4 mb-4"></div>
          <div className="space-y-3">
            <div className="h-4 bg-gray-200 rounded"></div>
            <div className="h-4 bg-gray-200 rounded w-5/6"></div>
            <div className="h-4 bg-gray-200 rounded w-4/6"></div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`bg-white rounded-lg shadow-sm border ${className}`}>
      {/* Header */}
      <div className="border-b px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <Settings className="h-6 w-6 text-blue-500" />
            <h3 className="text-lg font-semibold text-gray-900">Workflow Configuration</h3>
          </div>
          <button
            onClick={() => setShowCreateModal(true)}
            className="flex items-center space-x-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
          >
            <Plus className="h-4 w-4" />
            <span>Add Mapping</span>
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b px-6">
        <div className="flex space-x-8">
          <button
            onClick={() => setActiveTab('testgroups')}
            className={`py-3 px-1 border-b-2 font-medium text-sm ${
              activeTab === 'testgroups'
                ? 'border-blue-500 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            <div className="flex items-center space-x-2">
              <TestTube className="h-4 w-4" />
              <span>Test Group Workflows ({testGroupMappings.length})</span>
            </div>
          </button>
          <button
            onClick={() => setActiveTab('analytes')}
            className={`py-3 px-1 border-b-2 font-medium text-sm ${
              activeTab === 'analytes'
                ? 'border-blue-500 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            <div className="flex items-center space-x-2">
              <Zap className="h-4 w-4" />
              <span>Analyte Workflows ({analyteMappings.length})</span>
            </div>
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="p-6">
        {activeTab === 'testgroups' ? (
          <TestGroupMappings 
            mappings={testGroupMappings}
            onDelete={handleDeleteMapping}
            onToggleStatus={toggleMappingStatus}
          />
        ) : (
          <AnalyteMappings 
            mappings={analyteMappings}
            onDelete={handleDeleteMapping}
            onToggleStatus={toggleMappingStatus}
          />
        )}
      </div>

      {/* Create/Edit Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 w-full max-w-md">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-semibold">Create Workflow Mapping</h3>
              <button onClick={() => setShowCreateModal(false)}>
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleCreateMapping} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Workflow *
                </label>
                <select
                  value={formData.workflowVersionId}
                  onChange={(e) => setFormData(prev => ({ ...prev, workflowVersionId: e.target.value }))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
                  required
                >
                  <option value="">Select Workflow</option>
                  {workflowVersions.map(wv => (
                    <option key={wv.id} value={wv.id}>
                      {wv.name} (v{wv.version})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Test Group
                </label>
                <select
                  value={formData.testGroupId}
                  onChange={(e) => setFormData(prev => ({ ...prev, testGroupId: e.target.value }))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
                >
                  <option value="">Select Test Group (Optional)</option>
                  {testGroups.map(tg => (
                    <option key={tg.id} value={tg.id}>
                      {tg.name} ({tg.category})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Analyte
                </label>
                <select
                  value={formData.analyteId}
                  onChange={(e) => setFormData(prev => ({ ...prev, analyteId: e.target.value }))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
                >
                  <option value="">Select Analyte (Optional)</option>
                  {analytes.map(analyte => (
                    <option key={analyte.id} value={analyte.id}>
                      {analyte.name} ({analyte.unit})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Priority
                </label>
                <input
                  type="number"
                  value={formData.priority}
                  onChange={(e) => setFormData(prev => ({ ...prev, priority: parseInt(e.target.value) }))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
                  min="1"
                  max="1000"
                />
              </div>

              <div className="flex items-center">
                <input
                  type="checkbox"
                  id="isDefault"
                  checked={formData.isDefault}
                  onChange={(e) => setFormData(prev => ({ ...prev, isDefault: e.target.checked }))}
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <label htmlFor="isDefault" className="ml-2 text-sm text-gray-700">
                  Set as default workflow
                </label>
              </div>

              <div className="flex justify-end space-x-3 pt-4">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-4 py-2 text-gray-700 bg-gray-100 rounded-md hover:bg-gray-200"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 flex items-center space-x-2"
                >
                  <Save className="h-4 w-4" />
                  <span>Create</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

// Sub-components for test group and analyte mappings
const TestGroupMappings: React.FC<{
  mappings: WorkflowMapping[];
  onDelete: (id: string) => void;
  onToggleStatus: (id: string, isActive: boolean) => void;
}> = ({ mappings, onDelete, onToggleStatus }) => {
  if (mappings.length === 0) {
    return (
      <div className="text-center py-8 text-gray-500">
        <TestTube className="h-12 w-12 mx-auto mb-4 text-gray-300" />
        <p>No test group workflows configured</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {mappings.map(mapping => (
        <div key={mapping.id} className="border rounded-lg p-4">
          <div className="flex items-center justify-between">
            <div>
              <h4 className="font-medium text-gray-900">{mapping.testGroupName}</h4>
              <p className="text-sm text-gray-600">Workflow: {mapping.workflowName}</p>
              <div className="flex items-center space-x-4 mt-2">
                <span className={`px-2 py-1 rounded-full text-xs ${
                  mapping.isDefault ? 'bg-blue-100 text-blue-800' : 'bg-gray-100 text-gray-800'
                }`}>
                  {mapping.isDefault ? 'Default' : 'Additional'}
                </span>
                <span className="text-xs text-gray-500">Priority: {mapping.priority}</span>
              </div>
            </div>
            <div className="flex items-center space-x-2">
              <button
                onClick={() => onToggleStatus(mapping.id, mapping.isActive)}
                className={`px-3 py-1 rounded text-sm ${
                  mapping.isActive 
                    ? 'bg-green-100 text-green-800 hover:bg-green-200' 
                    : 'bg-red-100 text-red-800 hover:bg-red-200'
                }`}
              >
                {mapping.isActive ? 'Active' : 'Inactive'}
              </button>
              <button
                onClick={() => onDelete(mapping.id)}
                className="p-2 text-red-600 hover:bg-red-100 rounded"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};

const AnalyteMappings: React.FC<{
  mappings: WorkflowMapping[];
  onDelete: (id: string) => void;
  onToggleStatus: (id: string, isActive: boolean) => void;
}> = ({ mappings, onDelete, onToggleStatus }) => {
  if (mappings.length === 0) {
    return (
      <div className="text-center py-8 text-gray-500">
        <Zap className="h-12 w-12 mx-auto mb-4 text-gray-300" />
        <p>No analyte workflows configured</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {mappings.map(mapping => (
        <div key={mapping.id} className="border rounded-lg p-4">
          <div className="flex items-center justify-between">
            <div>
              <h4 className="font-medium text-gray-900">{mapping.analyteName}</h4>
              <p className="text-sm text-gray-600">Workflow: {mapping.workflowName}</p>
              {mapping.testGroupName && (
                <p className="text-xs text-gray-500">Test Group: {mapping.testGroupName}</p>
              )}
              <div className="flex items-center space-x-4 mt-2">
                <span className={`px-2 py-1 rounded-full text-xs ${
                  mapping.isDefault ? 'bg-blue-100 text-blue-800' : 'bg-gray-100 text-gray-800'
                }`}>
                  {mapping.isDefault ? 'Default' : 'Additional'}
                </span>
                <span className="text-xs text-gray-500">Priority: {mapping.priority}</span>
              </div>
            </div>
            <div className="flex items-center space-x-2">
              <button
                onClick={() => onToggleStatus(mapping.id, mapping.isActive)}
                className={`px-3 py-1 rounded text-sm ${
                  mapping.isActive 
                    ? 'bg-green-100 text-green-800 hover:bg-green-200' 
                    : 'bg-red-100 text-red-800 hover:bg-red-200'
                }`}
              >
                {mapping.isActive ? 'Active' : 'Inactive'}
              </button>
              <button
                onClick={() => onDelete(mapping.id)}
                className="p-2 text-red-600 hover:bg-red-100 rounded"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};