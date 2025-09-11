import React, { useState, useEffect } from 'react';
import { X, Edit2, Save, AlertCircle, Plus } from 'lucide-react';
import { supabase } from '../../utils/supabase';

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

interface EditAnalyteModalProps {
  analyte: Analyte;
  isOpen: boolean;
  onClose: () => void;
  onSave: (updatedAnalyte: Analyte) => void;
}

export const EditAnalyteModal: React.FC<EditAnalyteModalProps> = ({
  analyte,
  isOpen,
  onClose,
  onSave
}) => {
  const [formData, setFormData] = useState<Analyte>(analyte);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setFormData(analyte);
    setError(null);
  }, [analyte]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);

    try {
      // Validate required fields
      if (!formData.name.trim()) {
        throw new Error('Analyte name is required');
      }

      // Update analyte in database
      const { error: updateError } = await supabase
        .from('analytes')
        .update({
          name: formData.name.trim(),
          unit: formData.unit.trim(),
          reference_range: formData.reference_range.trim(),
          category: formData.category,
          method: formData.method?.trim() || null,
          description: formData.description?.trim() || null,
          is_critical: formData.is_critical || false,
          normal_range_min: formData.normal_range_min || null,
          normal_range_max: formData.normal_range_max || null,
          updated_at: new Date().toISOString()
        })
        .eq('id', formData.id);

      if (updateError) {
        throw updateError;
      }

      // Call parent callback
      onSave(formData);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update analyte');
    } finally {
      setSaving(false);
    }
  };

  const handleInputChange = (field: keyof Analyte, value: any) => {
    setFormData(prev => ({
      ...prev,
      [field]: value
    }));
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-6">
          <h3 className="text-lg font-semibold text-gray-900">Edit Analyte</h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-md flex items-center space-x-2">
            <AlertCircle className="w-5 h-5 text-red-600" />
            <span className="text-red-700 text-sm">{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Analyte Name */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Analyte Name *
            </label>
            <input
              type="text"
              value={formData.name}
              onChange={(e) => handleInputChange('name', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="e.g., Hemoglobin"
              required
            />
          </div>

          {/* Unit and Category Row */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Unit
              </label>
              <input
                type="text"
                value={formData.unit}
                onChange={(e) => handleInputChange('unit', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="e.g., g/dL, mg/dL, %"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Category
              </label>
              <select
                value={formData.category}
                onChange={(e) => handleInputChange('category', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                <option value="Hematology">Hematology</option>
                <option value="Chemistry">Chemistry</option>
                <option value="Immunology">Immunology</option>
                <option value="Microbiology">Microbiology</option>
                <option value="Blood Banking">Blood Banking</option>
                <option value="Clinical Pathology">Clinical Pathology</option>
                <option value="General">General</option>
              </select>
            </div>
          </div>

          {/* Reference Range */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Reference Range
            </label>
            <input
              type="text"
              value={formData.reference_range}
              onChange={(e) => handleInputChange('reference_range', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="e.g., 12-16 g/dL (Female), 14-18 g/dL (Male)"
            />
          </div>

          {/* Numeric Range */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Numeric Range (for validation)
            </label>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <input
                  type="number"
                  step="0.01"
                  value={formData.normal_range_min || ''}
                  onChange={(e) => handleInputChange('normal_range_min', e.target.value ? parseFloat(e.target.value) : null)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder="Minimum value"
                />
              </div>
              <div>
                <input
                  type="number"
                  step="0.01"
                  value={formData.normal_range_max || ''}
                  onChange={(e) => handleInputChange('normal_range_max', e.target.value ? parseFloat(e.target.value) : null)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder="Maximum value"
                />
              </div>
            </div>
          </div>

          {/* Method */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Method
            </label>
            <input
              type="text"
              value={formData.method || ''}
              onChange={(e) => handleInputChange('method', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="e.g., Spectrophotometry, ELISA, Manual"
            />
          </div>

          {/* Description */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Description
            </label>
            <textarea
              value={formData.description || ''}
              onChange={(e) => handleInputChange('description', e.target.value)}
              rows={3}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="Additional notes or description for this analyte..."
            />
          </div>

          {/* Critical Flag */}
          <div className="flex items-center space-x-2">
            <input
              type="checkbox"
              id="is_critical"
              checked={formData.is_critical || false}
              onChange={(e) => handleInputChange('is_critical', e.target.checked)}
              className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            <label htmlFor="is_critical" className="text-sm font-medium text-gray-700">
              Critical value (requires immediate attention)
            </label>
          </div>

          {/* Action Buttons */}
          <div className="flex justify-end space-x-3 pt-4 border-t">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-gray-700 bg-gray-100 rounded-md hover:bg-gray-200 focus:outline-none focus:ring-2 focus:ring-gray-500"
              disabled={saving}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed flex items-center space-x-2"
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

export default EditAnalyteModal;