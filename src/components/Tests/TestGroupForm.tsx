import React, { useState, useEffect } from 'react';
import { X, Layers, TestTube, DollarSign, Clock, Settings, Plus, Search, AlertCircle, Brain } from 'lucide-react';
import { database, supabase } from '../../utils/supabase';
import AnalyteForm from './AnalyteForm';

interface TestGroupFormProps {
  onClose: () => void;
  onSubmit: (data: any) => void;
  testGroup?: TestGroup | null;
}

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
  lab_id?: string;
  to_be_copied?: boolean;
}

const TestGroupForm: React.FC<TestGroupFormProps> = ({ onClose, onSubmit, testGroup }) => {
  const [formData, setFormData] = useState({
    name: testGroup?.name || '',
    code: testGroup?.code || '',
    category: testGroup?.category || '',
    clinicalPurpose: testGroup?.clinicalPurpose || '',
    selectedAnalytes: testGroup?.analytes || [],
    price: testGroup?.price?.toString() || '',
    turnaroundTime: testGroup?.turnaroundTime || '',
    sampleType: testGroup?.sampleType || '',
    requiresFasting: testGroup?.requiresFasting ?? false,
    isActive: testGroup?.isActive ?? true,
    default_ai_processing_type: testGroup?.default_ai_processing_type || 'ocr_report',
    group_level_prompt: testGroup?.group_level_prompt || '',
  });

  const [analytes, setAnalytes] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [showAnalyteForm, setShowAnalyteForm] = useState(false);
  const [loading, setLoading] = useState(true);

  // Load analytes from database
  useEffect(() => {
    loadAnalytes();
  }, []);

  const loadAnalytes = async () => {
    try {
      setLoading(true);
      const { data, error } = await database.analytes.getAll();
      if (error) {
        console.error('Error loading analytes:', error);
        return;
      }
      setAnalytes(data || []);
    } catch (error) {
      console.error('Error loading analytes:', error);
    } finally {
      setLoading(false);
    }
  };

  // Filter analytes based on search query
  const filteredAnalytes = analytes.filter(analyte =>
    analyte.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    analyte.category.toLowerCase().includes(searchQuery.toLowerCase()) ||
    analyte.unit.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleAddNewAnalyte = async (analyteData: any) => {
    try {
      // Create analyte in database as lab-specific analyte (not global)
      const { data, error } = await supabase
        .from('analytes')
        .insert([{
          name: analyteData.name,
          unit: analyteData.unit,
          reference_range: analyteData.referenceRange,
          low_critical: analyteData.lowCritical,
          high_critical: analyteData.highCritical,
          interpretation_low: analyteData.interpretation.low,
          interpretation_normal: analyteData.interpretation.normal,
          interpretation_high: analyteData.interpretation.high,
          category: analyteData.category,
          is_active: analyteData.isActive,
          is_global: false, // Default to lab-specific (owner will promote manually)
          to_be_copied: false, // Default to not template
          ai_processing_type: analyteData.aiProcessingType,
          ai_prompt_override: analyteData.aiPromptOverride,
          group_ai_mode: analyteData.groupAiMode,
        }])
        .select()
        .single();

      if (error) {
        console.error('Error creating analyte:', error);
        alert('Failed to create analyte. Please try again.');
        return;
      }

      // Refresh analytes list
      await loadAnalytes();
      
      // Auto-select the newly created analyte
      setFormData(prev => ({
        ...prev,
        selectedAnalytes: [...prev.selectedAnalytes, data.id]
      }));
      
      setShowAnalyteForm(false);
      alert('Analyte created successfully for your lab!');
    } catch (error) {
      console.error('Error creating analyte:', error);
      alert('Failed to create analyte. Please try again.');
    }
  };

  const categories = [
    'Hematology',
    'Biochemistry', 
    'Serology',
    'Microbiology',
    'Immunology',
    'Molecular Biology',
    'Histopathology',
    'Cytology',
  ];

  const sampleTypes = [
    'EDTA Blood',
    'Serum',
    'Plasma',
    'Urine',
    'Stool',
    'CSF',
    'Sputum',
    'Swab',
    'Tissue',
    'Other',
  ];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    try {
      // Get current user's lab_id
      const labId = await database.getCurrentUserLabId();
      
      onSubmit({
        ...formData,
        analytes: formData.selectedAnalytes,
        price: parseFloat(formData.price),
        default_ai_processing_type: formData.default_ai_processing_type,
        group_level_prompt: formData.group_level_prompt,
        lab_id: labId, // Add lab_id for lab-specific test group
        to_be_copied: false, // Default to not template (owner will promote manually)
      });
    } catch (error) {
      console.error('Error getting lab ID:', error);
      alert('Error: Could not determine your lab. Please try again.');
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value, type } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: type === 'checkbox' ? (e.target as HTMLInputElement).checked : value
    }));
  };

  const handleAnalyteSelection = (analyteId: string) => {
    setFormData(prev => ({
      ...prev,
      selectedAnalytes: prev.selectedAnalytes.includes(analyteId)
        ? prev.selectedAnalytes.filter(id => id !== analyteId)
        : [...prev.selectedAnalytes, analyteId]
    }));
  };

  const aiProcessingTypes = [
    { value: 'none', label: 'None - Manual Entry Only', description: 'No AI processing for this test group' },
    { value: 'ocr_report', label: 'OCR Report Processing', description: 'Extract values from printed reports and instrument displays' },
    { value: 'vision_card', label: 'Vision Card Analysis', description: 'Analyze test cards and lateral flow devices' },
    { value: 'vision_color', label: 'Vision Color Analysis', description: 'Color-based analysis for strips and visual tests' },
  ];

  const selectedAnalyteDetails = analytes.filter(analyte => 
    formData.selectedAnalytes.includes(analyte.id)
  );

  return (
    <div className="fixed inset-0 bg-gray-600 bg-opacity-75 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-6xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <h2 className="text-xl font-semibold text-gray-900 flex items-center">
            <Layers className="h-6 w-6 mr-2 text-green-600" />
            {testGroup ? 'Edit Test Group' : 'Create Test Group'}
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
                  Test Group Name *
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
                  Test Code *
                </label>
                <input
                  type="text"
                  name="code"
                  required
                  value={formData.code}
                  onChange={handleChange}
                  placeholder="e.g., CBC"
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
                Clinical Purpose *
              </label>
              <textarea
                name="clinicalPurpose"
                required
                rows={2}
                value={formData.clinicalPurpose}
                onChange={handleChange}
                placeholder="Describe the clinical purpose and indications for this test group"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
          </div>

          {/* Analyte Selection */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-medium text-gray-900">Select Analytes</h3>
              <button
                type="button"
                onClick={() => setShowAnalyteForm(true)}
                className="flex items-center px-3 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
              >
                <Plus className="h-4 w-4 mr-1" />
                Add New Analyte
              </button>
            </div>
            
            {/* Search Box */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 h-4 w-4" />
              <input
                type="text"
                placeholder="Search analytes by name, category, or unit..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-9 pr-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>

            {/* No Analytes Available Message */}
            {!loading && analytes.length === 0 && (
              <div className="text-center py-8 bg-gray-50 rounded-lg border-2 border-dashed border-gray-300">
                <AlertCircle className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                <h4 className="text-lg font-medium text-gray-900 mb-2">No Analytes Available</h4>
                <p className="text-gray-600 mb-4">
                  You need to create analytes before you can create a test group.
                  <br />
                  <span className="text-sm text-blue-600">Analytes will be created for your lab. Owner can promote good ones to global templates.</span>
                </p>
                <button
                  type="button"
                  onClick={() => setShowAnalyteForm(true)}
                  className="flex items-center px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors mx-auto"
                >
                  <Plus className="h-4 w-4 mr-2" />
                  Create Your First Analyte
                </button>
              </div>
            )}

            {/* Loading State */}
            {loading && (
              <div className="text-center py-8">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto"></div>
                <p className="text-gray-600 mt-2">Loading analytes...</p>
              </div>
            )}

            {/* No Search Results */}
            {!loading && analytes.length > 0 && filteredAnalytes.length === 0 && searchQuery && (
              <div className="text-center py-8 bg-gray-50 rounded-lg border border-gray-200">
                <Search className="h-8 w-8 text-gray-400 mx-auto mb-2" />
                <p className="text-gray-600 mb-4">
                  No analytes found matching "{searchQuery}"
                  <br />
                  <span className="text-sm text-blue-600">Create a new analyte for your lab.</span>
                </p>
                <button
                  type="button"
                  onClick={() => setShowAnalyteForm(true)}
                  className="flex items-center px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors mx-auto"
                >
                  <Plus className="h-4 w-4 mr-2" />
                  Create New Analyte
                </button>
              </div>
            )}

            {/* Analyte Selection Grid */}
            {filteredAnalytes.length > 0 && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-h-60 overflow-y-auto border border-gray-200 rounded-lg p-4">
                {filteredAnalytes.map((analyte) => (
                  <label key={analyte.id} className="flex items-start p-3 border border-gray-200 rounded-lg hover:bg-gray-50 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={formData.selectedAnalytes.includes(analyte.id)}
                      onChange={() => handleAnalyteSelection(analyte.id)}
                      className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded mt-1"
                    />
                    <div className="ml-3 flex-1">
                      <div className="text-sm font-medium text-gray-900">{analyte.name}</div>
                      <div className="text-xs text-gray-500 mt-1">
                        Unit: {analyte.unit} • Range: {analyte.referenceRange}
                      </div>
                      <div className="text-xs text-gray-400">
                        Category: {analyte.category}
                      </div>
                    </div>
                  </label>
                ))}
              </div>
            )}

            {/* Selected Analytes Summary */}
            {formData.selectedAnalytes.length > 0 && (
              <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                <h4 className="font-medium text-green-900 mb-2">Selected Analytes ({formData.selectedAnalytes.length})</h4>
                <div className="flex flex-wrap gap-2">
                  {selectedAnalyteDetails.map((analyte) => (
                    <span key={analyte.id} className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                      {analyte.name}
                    </span>
                  ))}
                </div>
              </div>
            )}
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

          {/* Settings */}
          <div className="space-y-4">
            <h3 className="text-lg font-medium text-gray-900 flex items-center">
              <Settings className="h-5 w-5 mr-2" />
              Test Group Settings
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
                <span className="ml-2 text-sm text-gray-700">Test group is active and available for ordering</span>
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

          {/* AI Configuration */}
          <div className="space-y-4">
            <h3 className="text-lg font-medium text-gray-900 flex items-center">
              <Brain className="h-5 w-5 mr-2 text-purple-600" />
              AI Processing Configuration (for this Test Group)
            </h3>
            
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Default AI Processing Type
                </label>
                <select
                  name="default_ai_processing_type"
                  value={formData.default_ai_processing_type}
                  onChange={handleChange}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                >
                  {aiProcessingTypes.map(type => (
                    <option key={type.value} value={type.value}>{type.label}</option>
                  ))}
                </select>
                <div className="text-xs text-gray-500 mt-1">
                  {aiProcessingTypes.find(t => t.value === formData.default_ai_processing_type)?.description}
                </div>
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Group-Level AI Prompt (Optional)
                </label>
                <textarea
                  name="group_level_prompt"
                  rows={4}
                  value={formData.group_level_prompt}
                  onChange={handleChange}
                  placeholder="Enter a custom prompt for AI processing at the test group level. This overrides analyte-level prompts if group AI mode is 'group_only'."
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
                <div className="text-xs text-gray-500 mt-1">This prompt will be used if the analyte's AI mode is 'group_only' or 'both'.</div>
              </div>
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
              disabled={formData.selectedAnalytes.length === 0}
              className="px-6 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
            >
              {testGroup ? 'Update Test Group' : 'Create Test Group'}
            </button>
          </div>
        </form>
      </div>
      
      {/* Analyte Form Modal */}
      {showAnalyteForm && (
        <AnalyteForm
          onClose={() => setShowAnalyteForm(false)}
          onSubmit={handleAddNewAnalyte}
        />
      )}
    </div>
  );
};

export default TestGroupForm;