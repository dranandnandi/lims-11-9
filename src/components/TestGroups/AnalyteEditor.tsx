import React, { useState } from 'react';
import { Edit2, X } from 'lucide-react';
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

// Enhanced analyte display component with edit functionality
export const AnalyteCard: React.FC<{
  analyte: Analyte;
  onEdit: (analyte: Analyte) => void;
  onRemove: (analyteId: string) => void;
}> = ({ analyte, onEdit, onRemove }) => {
  return (
    <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
      <div className="flex-1">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="font-medium text-gray-900">{analyte.name}</h4>
            <p className="text-sm text-gray-600">
              {analyte.unit} • Range: {analyte.reference_range}
            </p>
            <p className="text-xs text-gray-500">
              Category: {analyte.category}
              {analyte.is_critical && (
                <span className="ml-2 px-2 py-1 bg-red-100 text-red-800 text-xs rounded-full">
                  Critical
                </span>
              )}
            </p>
            {analyte.method && (
              <p className="text-xs text-gray-500">Method: {analyte.method}</p>
            )}
          </div>
          <div className="flex items-center space-x-2">
            <button
              onClick={() => onEdit(analyte)}
              className="p-2 text-blue-600 hover:bg-blue-50 rounded-md transition-colors group"
              title="Edit Analyte Details"
            >
              <Edit2 className="w-4 h-4 group-hover:scale-110 transition-transform" />
            </button>
            <button
              onClick={() => onRemove(analyte.id)}
              className="p-2 text-red-600 hover:bg-red-50 rounded-md transition-colors group"
              title="Remove from Test Group"
            >
              <X className="w-4 h-4 group-hover:scale-110 transition-transform" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

// Hook for managing analyte editing
export const useAnalyteEditor = () => {
  const [showEditModal, setShowEditModal] = useState(false);
  const [editingAnalyte, setEditingAnalyte] = useState<Analyte | null>(null);

  const openEditModal = (analyte: Analyte) => {
    setEditingAnalyte(analyte);
    setShowEditModal(true);
  };

  const closeEditModal = () => {
    setShowEditModal(false);
    setEditingAnalyte(null);
  };

  const handleSave = async (updatedAnalyte: Analyte) => {
    try {
      // Update in database
      const { error } = await supabase
        .from('analytes')
        .update({
          name: updatedAnalyte.name,
          unit: updatedAnalyte.unit,
          reference_range: updatedAnalyte.reference_range,
          category: updatedAnalyte.category,
          method: updatedAnalyte.method,
          description: updatedAnalyte.description,
          is_critical: updatedAnalyte.is_critical,
          normal_range_min: updatedAnalyte.normal_range_min,
          normal_range_max: updatedAnalyte.normal_range_max,
          updated_at: new Date().toISOString()
        })
        .eq('id', updatedAnalyte.id);

      if (error) throw error;

      closeEditModal();
      return true;
    } catch (error) {
      console.error('Failed to update analyte:', error);
      return false;
    }
  };

  return {
    showEditModal,
    editingAnalyte,
    openEditModal,
    closeEditModal,
    handleSave
  };
};