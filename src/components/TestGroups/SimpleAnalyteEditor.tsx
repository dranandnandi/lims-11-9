import React, { useState } from 'react';
import { X, Save, AlertCircle } from 'lucide-react';
import { supabase } from '../../utils/supabase';

interface SimpleAnalyteEditorProps {
  analyte: {
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
  };
  onSave: (analyte: any) => void;
  onCancel: () => void;
}

export const SimpleAnalyteEditor: React.FC<SimpleAnalyteEditorProps> = ({
  analyte,
  onSave,
  onCancel
}) => {
  const [formData, setFormData] = useState(analyte);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);

    try {
      const { error: updateError } = await supabase
        .from('analytes')
        .update({
          name: formData.name,
          unit: formData.unit,
          reference_range: formData.reference_range,
          category: formData.category,
          method: formData.method,
          description: formData.description,
          is_critical: formData.is_critical,
          normal_range_min: formData.normal_range_min,
          normal_range_max: formData.normal_range_max,
          low_critical: formData.low_critical,
          high_critical: formData.high_critical,
          interpretation_low: formData.interpretation_low,
          interpretation_normal: formData.interpretation_normal,
          interpretation_high: formData.interpretation_high,
          is_active: formData.is_active,
          ai_processing_type: formData.ai_processing_type,
          ai_prompt_override: formData.ai_prompt_override,
          group_ai_mode: formData.group_ai_mode,
          is_global: formData.is_global,
          to_be_copied: formData.to_be_copied,
          updated_at: new Date().toISOString()
        })
        .eq('id', formData.id);

      if (updateError) throw updateError;
      
      onSave(formData);
    } catch (error) {
      console.error('Failed to update analyte:', error);
      setError(error instanceof Error ? error.message : 'Failed to update analyte');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-6">
          <h3 className="text-xl font-semibold">Edit Analyte</h3>
          <button onClick={onCancel} className="text-gray-400 hover:text-gray-600">
            <X className="w-6 h-6" />
          </button>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-md flex items-center space-x-2">
            <AlertCircle className="w-5 h-5 text-red-600" />
            <span className="text-red-700 text-sm">{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Basic Information Section */}
          <div className="bg-gray-50 p-4 rounded-lg">
            <h4 className="text-lg font-medium text-gray-900 mb-4">Basic Information</h4>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="md:col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-1">Analyte Name *</label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder="e.g., Hemoglobin, Glucose, White Blood Cell Count"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Unit</label>
                <input
                  type="text"
                  value={formData.unit}
                  onChange={(e) => setFormData(prev => ({ ...prev, unit: e.target.value }))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder="e.g., g/dL, mg/dL, %, K/uL, M/uL"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Category *</label>
                <select
                  value={formData.category}
                  onChange={(e) => setFormData(prev => ({ ...prev, category: e.target.value }))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  required
                >
                  <option value="">Select Category</option>
                  <option value="Hematology">Hematology</option>
                  <option value="Chemistry">Chemistry</option>
                  <option value="Immunology">Immunology</option>
                  <option value="Microbiology">Microbiology</option>
                  <option value="Blood Banking">Blood Banking</option>
                  <option value="Immunohematology">Immunohematology</option>
                  <option value="Clinical Pathology">Clinical Pathology</option>
                  <option value="Molecular Diagnostics">Molecular Diagnostics</option>
                  <option value="Cytology">Cytology</option>
                  <option value="Histopathology">Histopathology</option>
                  <option value="Toxicology">Toxicology</option>
                  <option value="Endocrinology">Endocrinology</option>
                  <option value="Cardiology">Cardiology</option>
                  <option value="General">General</option>
                </select>
              </div>
            </div>
          </div>

          {/* Reference Values Section */}
          <div className="bg-blue-50 p-4 rounded-lg">
            <h4 className="text-lg font-medium text-gray-900 mb-4">Reference Values</h4>
            
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Reference Range (Text)</label>
                <input
                  type="text"
                  value={formData.reference_range}
                  onChange={(e) => setFormData(prev => ({ ...prev, reference_range: e.target.value }))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder="e.g., 12-16 (F), 14-18 (M) or Normal/Abnormal"
                />
                <p className="text-xs text-gray-500 mt-1">Text description of normal ranges, including gender/age specific values</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Numeric Range (for automated validation)
                </label>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs text-gray-600 mb-1">Minimum Normal Value</label>
                    <input
                      type="number"
                      step="0.001"
                      value={formData.normal_range_min || ''}
                      onChange={(e) => setFormData(prev => ({ 
                        ...prev, 
                        normal_range_min: e.target.value ? parseFloat(e.target.value) : undefined 
                      }))}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      placeholder="e.g., 12.0"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-600 mb-1">Maximum Normal Value</label>
                    <input
                      type="number"
                      step="0.001"
                      value={formData.normal_range_max || ''}
                      onChange={(e) => setFormData(prev => ({ 
                        ...prev, 
                        normal_range_max: e.target.value ? parseFloat(e.target.value) : undefined 
                      }))}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      placeholder="e.g., 16.0"
                    />
                  </div>
                </div>
                <p className="text-xs text-gray-500 mt-1">Used for automatic flagging of abnormal results</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Critical Values (immediate notification required)
                </label>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs text-gray-600 mb-1">Low Critical Value</label>
                    <input
                      type="number"
                      step="0.001"
                      value={formData.low_critical || ''}
                      onChange={(e) => setFormData(prev => ({ 
                        ...prev, 
                        low_critical: e.target.value ? parseFloat(e.target.value) : null 
                      }))}
                      className="w-full px-3 py-2 border border-red-300 rounded-md focus:ring-2 focus:ring-red-500 focus:border-transparent"
                      placeholder="e.g., 5.0"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-600 mb-1">High Critical Value</label>
                    <input
                      type="number"
                      step="0.001"
                      value={formData.high_critical || ''}
                      onChange={(e) => setFormData(prev => ({ 
                        ...prev, 
                        high_critical: e.target.value ? parseFloat(e.target.value) : null 
                      }))}
                      className="w-full px-3 py-2 border border-red-300 rounded-md focus:ring-2 focus:ring-red-500 focus:border-transparent"
                      placeholder="e.g., 200.0"
                    />
                  </div>
                </div>
                <p className="text-xs text-red-600 mt-1">Values requiring immediate physician notification</p>
              </div>
            </div>
          </div>

          {/* Result Interpretation Section */}
          <div className="bg-purple-50 p-4 rounded-lg">
            <h4 className="text-lg font-medium text-gray-900 mb-4">Result Interpretation</h4>
            
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Low Value Interpretation</label>
                <textarea
                  value={formData.interpretation_low || ''}
                  onChange={(e) => setFormData(prev => ({ ...prev, interpretation_low: e.target.value }))}
                  rows={2}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder="Clinical significance when value is below normal range"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Normal Value Interpretation</label>
                <textarea
                  value={formData.interpretation_normal || ''}
                  onChange={(e) => setFormData(prev => ({ ...prev, interpretation_normal: e.target.value }))}
                  rows={2}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder="Clinical significance when value is within normal range"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">High Value Interpretation</label>
                <textarea
                  value={formData.interpretation_high || ''}
                  onChange={(e) => setFormData(prev => ({ ...prev, interpretation_high: e.target.value }))}
                  rows={2}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder="Clinical significance when value is above normal range"
                />
              </div>
            </div>
          </div>

          {/* Testing Method & Quality Section */}
          <div className="bg-green-50 p-4 rounded-lg">
            <h4 className="text-lg font-medium text-gray-900 mb-4">Testing Method & Quality</h4>
            
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Testing Method</label>
                <select
                  value={formData.method || ''}
                  onChange={(e) => setFormData(prev => ({ ...prev, method: e.target.value || undefined }))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                >
                  <option value="">Select Method</option>
                  <option value="Manual">Manual</option>
                  <option value="Automated">Automated</option>
                  <option value="Semi-Automated">Semi-Automated</option>
                  <option value="Spectrophotometry">Spectrophotometry</option>
                  <option value="Flow Cytometry">Flow Cytometry</option>
                  <option value="Immunoassay">Immunoassay</option>
                  <option value="ELISA">ELISA</option>
                  <option value="Chemiluminescence">Chemiluminescence</option>
                  <option value="PCR">PCR</option>
                  <option value="Microscopy">Microscopy</option>
                  <option value="Culture">Culture</option>
                  <option value="Electrophoresis">Electrophoresis</option>
                  <option value="Chromatography">Chromatography</option>
                  <option value="Mass Spectrometry">Mass Spectrometry</option>
                </select>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="flex items-start space-x-3">
                  <input
                    type="checkbox"
                    id="is_critical"
                    checked={formData.is_critical || false}
                    onChange={(e) => setFormData(prev => ({ ...prev, is_critical: e.target.checked }))}
                    className="mt-1 rounded border-gray-300 text-red-600 focus:ring-red-500"
                  />
                  <div>
                    <label htmlFor="is_critical" className="text-sm font-medium text-gray-700">
                      Critical Value Parameter
                    </label>
                    <p className="text-xs text-gray-500 mt-1">
                      Can have critical values requiring immediate notification
                    </p>
                  </div>
                </div>

                <div className="flex items-start space-x-3">
                  <input
                    type="checkbox"
                    id="is_active"
                    checked={formData.is_active !== false}
                    onChange={(e) => setFormData(prev => ({ ...prev, is_active: e.target.checked }))}
                    className="mt-1 rounded border-gray-300 text-green-600 focus:ring-green-500"
                  />
                  <div>
                    <label htmlFor="is_active" className="text-sm font-medium text-gray-700">
                      Active Status
                    </label>
                    <p className="text-xs text-gray-500 mt-1">
                      Analyte is available for use in tests
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* AI Processing & Configuration Section */}
          <div className="bg-indigo-50 p-4 rounded-lg">
            <h4 className="text-lg font-medium text-gray-900 mb-4">AI Processing & Configuration</h4>
            
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">AI Processing Type</label>
                  <select
                    value={formData.ai_processing_type || ''}
                    onChange={(e) => setFormData(prev => ({ ...prev, ai_processing_type: e.target.value || undefined }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  >
                    <option value="">Select Processing Type</option>
                    <option value="ocr_report">OCR Report</option>
                    <option value="manual_entry">Manual Entry</option>
                    <option value="instrument_interface">Instrument Interface</option>
                    <option value="batch_processing">Batch Processing</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Group AI Mode</label>
                  <select
                    value={formData.group_ai_mode || ''}
                    onChange={(e) => setFormData(prev => ({ ...prev, group_ai_mode: e.target.value || undefined }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  >
                    <option value="">Select AI Mode</option>
                    <option value="individual">Individual</option>
                    <option value="group">Group</option>
                    <option value="batch">Batch</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">AI Prompt Override</label>
                <textarea
                  value={formData.ai_prompt_override || ''}
                  onChange={(e) => setFormData(prev => ({ ...prev, ai_prompt_override: e.target.value || null }))}
                  rows={3}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder="Custom AI processing instructions for this analyte..."
                />
                <p className="text-xs text-gray-500 mt-1">Override default AI processing prompts with custom instructions</p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="flex items-start space-x-3">
                  <input
                    type="checkbox"
                    id="is_global"
                    checked={formData.is_global || false}
                    onChange={(e) => setFormData(prev => ({ ...prev, is_global: e.target.checked }))}
                    className="mt-1 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                  />
                  <div>
                    <label htmlFor="is_global" className="text-sm font-medium text-gray-700">
                      Global Analyte
                    </label>
                    <p className="text-xs text-gray-500 mt-1">
                      Available across all lab branches/locations
                    </p>
                  </div>
                </div>

                <div className="flex items-start space-x-3">
                  <input
                    type="checkbox"
                    id="to_be_copied"
                    checked={formData.to_be_copied || false}
                    onChange={(e) => setFormData(prev => ({ ...prev, to_be_copied: e.target.checked }))}
                    className="mt-1 rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                  />
                  <div>
                    <label htmlFor="to_be_copied" className="text-sm font-medium text-gray-700">
                      To Be Copied
                    </label>
                    <p className="text-xs text-gray-500 mt-1">
                      Mark for replication to other systems
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Additional Information Section */}
          <div className="bg-yellow-50 p-4 rounded-lg">
            <h4 className="text-lg font-medium text-gray-900 mb-4">Additional Information</h4>
            
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Description & Notes</label>
              <textarea
                value={formData.description || ''}
                onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                rows={4}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="Additional notes, clinical significance, sample requirements, interference factors, etc."
              />
              <p className="text-xs text-gray-500 mt-1">
                Include any important information about sample collection, storage, clinical significance, or interpretation notes
              </p>
            </div>
          </div>

          <div className="flex justify-end space-x-3 pt-4 border-t">
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2 text-gray-700 bg-gray-100 rounded-md hover:bg-gray-200"
              disabled={saving}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center space-x-2"
            >
              {saving ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                  <span>Saving...</span>
                </>
              ) : (
                <>
                  <Save className="w-4 h-4" />
                  <span>Save Changes</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};