import React, { useState } from 'react';
import { Droplet, Plus, Trash2, RotateCcw } from 'lucide-react';
import { getDefaultSampleCapColor, getSampleContainerLabel } from '../Common/SampleTypeIndicator';

// Exact `sample_type` enum values that carry a physical container. Using the
// full value (not a keyword like 'plasma') means the override is matched
// exactly, so colouring 'Plasma' cannot bleed onto 'Fluoride Plasma'.
const COMMON_SAMPLE_TYPES = [
  'EDTA Blood',
  'Whole Blood',
  'Capillary Blood',
  'Serum',
  'Plasma',
  'Fluoride Plasma',
  'Citrated Plasma',
  'Urine',
  'Stool',
  'CSF',
  'Sputum',
  'Swab',
  'Tissue',
];

interface SampleTypeColorsConfigProps {
  value: Record<string, string>;
  onChange: (colors: Record<string, string>) => void;
}

export const SampleTypeColorsConfig: React.FC<SampleTypeColorsConfigProps> = ({
  value,
  onChange,
}) => {
  const [newSampleType, setNewSampleType] = useState('');
  const [newColor, setNewColor] = useState('#DC2626');

  const handleColorChange = (sampleType: string, color: string) => {
    onChange({
      ...value,
      [sampleType.toLowerCase()]: color,
    });
  };

  const handleRemove = (sampleType: string) => {
    const updated = { ...value };
    delete updated[sampleType.toLowerCase()];
    onChange(updated);
  };

  const handleAdd = () => {
    if (!newSampleType.trim()) return;
    onChange({
      ...value,
      [newSampleType.toLowerCase().trim()]: newColor,
    });
    setNewSampleType('');
    setNewColor('#DC2626');
  };

  const handleReset = () => {
    onChange({});
  };

  const getDefaultColor = (sampleType: string): string => getDefaultSampleCapColor(sampleType);

  const configuredTypes = Object.keys(value);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-600">
          Override default tube/container colors for sample types. Leave empty to use defaults.
        </p>
        {configuredTypes.length > 0 && (
          <button
            type="button"
            onClick={handleReset}
            className="text-xs text-gray-500 hover:text-red-600 flex items-center gap-1"
          >
            <RotateCcw className="h-3 w-3" />
            Reset to defaults
          </button>
        )}
      </div>

      {/* Configured overrides */}
      {configuredTypes.length > 0 && (
        <div className="space-y-2">
          {configuredTypes.map((sampleType) => (
            <div
              key={sampleType}
              className="flex items-center gap-3 p-2 bg-gray-50 rounded-lg"
            >
              <div
                className="w-8 h-8 rounded-full border-2 border-white shadow-sm flex-shrink-0"
                style={{ backgroundColor: value[sampleType] }}
              />
              <span className="flex-1 text-sm font-medium capitalize">
                {sampleType}
              </span>
              <input
                type="color"
                value={value[sampleType]}
                onChange={(e) => handleColorChange(sampleType, e.target.value)}
                className="w-10 h-8 rounded cursor-pointer border border-gray-300"
              />
              <span className="text-xs text-gray-500 font-mono w-20">
                {value[sampleType]}
              </span>
              <button
                type="button"
                onClick={() => handleRemove(sampleType)}
                className="p-1 text-gray-400 hover:text-red-500"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Add new override */}
      <div className="border border-dashed border-gray-300 rounded-lg p-3">
        <div className="flex items-center gap-3">
          <select
            value={newSampleType}
            onChange={(e) => setNewSampleType(e.target.value)}
            className="flex-1 px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">Select sample type...</option>
            {COMMON_SAMPLE_TYPES.filter(
              (t) => !configuredTypes.includes(t.toLowerCase())
            ).map((type) => (
              <option key={type} value={type}>
                {type} (default: {getSampleContainerLabel(type)} {getDefaultColor(type)})
              </option>
            ))}
            <option value="__custom">-- Custom type --</option>
          </select>
          {newSampleType === '__custom' && (
            <input
              type="text"
              placeholder="Enter sample type"
              onChange={(e) => setNewSampleType(e.target.value)}
              className="flex-1 px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          )}
          <input
            type="color"
            value={newColor}
            onChange={(e) => setNewColor(e.target.value)}
            className="w-10 h-9 rounded cursor-pointer border border-gray-300"
          />
          <button
            type="button"
            onClick={handleAdd}
            disabled={!newSampleType || newSampleType === '__custom'}
            className="px-3 py-2 bg-blue-600 text-white rounded-md text-sm hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
          >
            <Plus className="h-4 w-4" />
            Add
          </button>
        </div>
      </div>

      {/* Preview */}
      {configuredTypes.length > 0 && (
        <div className="mt-4 p-3 bg-blue-50 rounded-lg">
          <p className="text-xs text-blue-700 font-medium mb-2">Preview:</p>
          <div className="flex flex-wrap gap-2">
            {configuredTypes.map((type) => (
              <div
                key={type}
                className="flex items-center gap-1.5 px-2 py-1 bg-white rounded-full border border-blue-200"
              >
                <div
                  className="w-4 h-4 rounded-full"
                  style={{ backgroundColor: value[type] }}
                />
                <span className="text-xs capitalize">{type}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default SampleTypeColorsConfig;
