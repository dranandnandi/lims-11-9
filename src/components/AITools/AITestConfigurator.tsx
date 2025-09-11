import React, { useState } from 'react';
import { Loader2, Sparkles, Check, Edit3, Save, X, AlertCircle, TestTube } from 'lucide-react';
import { generateTestConfiguration, TestConfigurationResponse } from '../../utils/geminiAI';
import { useAuth } from '../../contexts/AuthContext';
import { database } from '../../utils/supabase';

interface AITestConfiguratorProps {
  onConfigurationGenerated?: (config: TestConfigurationResponse) => void;
  existingTests?: string[];
  className?: string;
}

export const AITestConfigurator: React.FC<AITestConfiguratorProps> = ({
  onConfigurationGenerated,
  existingTests = [],
  className = ''
}) => {
  const { user } = useAuth();
  const [testName, setTestName] = useState('');
  const [description, setDescription] = useState('');
  const [sampleType, setSampleType] = useState('');
  const [requiresFasting, setRequiresFasting] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [generatedConfig, setGeneratedConfig] = useState<TestConfigurationResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [confidence, setConfidence] = useState<number>(0);

  // Handler for generating configuration preview
  const handleGenerateConfig = async () => {
    if (!testName.trim()) {
      setError('Please enter a test name');
      return;
    }

    setIsGenerating(true);
    setError(null);

    try {
      const config = await generateTestConfiguration(testName, {
        description: description,
        sampleType: sampleType || undefined,
        requiresFasting: requiresFasting ? requiresFasting === 'true' : undefined,
        existingTests: existingTests,
        insert: false // Don't insert during preview
      });
      
      setGeneratedConfig(config);
      setConfidence(config.confidence || 0.95);
      setEditMode(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate configuration');
    } finally {
      setIsGenerating(false);
    }
  };

  // Handler for direct insert via Edge Function
  const handleCreateWithInsert = async () => {
    if (!testName.trim()) {
      setError('Please enter a test name');
      return;
    }

    setIsCreating(true);
    setError(null);

    try {
      const result = await generateTestConfiguration(testName, {
        description: description,
        sampleType: sampleType || undefined,
        requiresFasting: requiresFasting ? requiresFasting === 'true' : undefined,
        existingTests: existingTests,
        insert: true // Insert directly via Edge Function
      });
      
      setSuccessMessage(`✅ Successfully created "${result.test_group.name}" with ${result.analytes.length} analytes!`);
      
      // Reset form
      setTestName('');
      setDescription('');
      setSampleType('');
      setRequiresFasting('');
      setGeneratedConfig(null);
      setConfidence(0);
      
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create test configuration');
    } finally {
      setIsCreating(false);
    }
  };

  // Handler for manual configuration creation from preview
  const handleCreateConfiguration = async () => {
    if (generatedConfig && onConfigurationGenerated) {
      onConfigurationGenerated(generatedConfig);
      // Reset form after successful creation
      setGeneratedConfig(null);
      setTestName('');
      setDescription('');
      setSampleType('');
      setRequiresFasting('');
    }
  };

  const handleEdit = () => {
    setGeneratedConfig(null);
    setError(null);
    setSuccessMessage(null);
    setEditMode(true);
  };

  const handleSave = async () => {
    setEditMode(false);
    if (testName.trim()) {
      handleGenerateConfig();
    }
  };

  const handleCancelEdit = () => {
    setEditMode(false);
  };

  return (
    <div className={`bg-white border border-gray-200 rounded-lg shadow-sm ${className}`}>
      {/* Header */}
      <div className="border-b border-gray-200 px-6 py-4">
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-blue-500" />
          <h3 className="text-lg font-semibold text-gray-900">AI Test Configuration Assistant</h3>
        </div>
        <p className="mt-1 text-sm text-gray-600">
          Enter a test name and let AI suggest the complete test group configuration with analytes
        </p>
      </div>
      
      {/* Content */}
      <div className="p-6 space-y-4">
        {!generatedConfig && !editMode && (
          <div className="space-y-4">
            {/* Test Name Input */}
            <div>
              <label htmlFor="testName" className="block text-sm font-medium text-gray-700 mb-1">
                Test Name <span className="text-red-500">*</span>
              </label>
              <input
                id="testName"
                type="text"
                value={testName}
                onChange={(e) => setTestName(e.target.value)}
                placeholder="e.g., Liver Function Test, Complete Blood Count"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
              />
            </div>

            {/* Description Input */}
            <div>
              <label htmlFor="description" className="block text-sm font-medium text-gray-700 mb-1">
                Description (optional)
              </label>
              <textarea
                id="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Additional details about the test"
                rows={2}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
              />
            </div>

            {/* Optional Overrides */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="sampleType" className="block text-sm font-medium text-gray-700 mb-1">
                  Sample Type (optional)
                </label>
                <select
                  id="sampleType"
                  value={sampleType}
                  onChange={(e) => setSampleType(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
                >
                  <option value="">Default</option>
                  <option value="Serum">Serum</option>
                  <option value="Plasma">Plasma</option>
                  <option value="Whole Blood">Whole Blood</option>
                  <option value="Urine">Urine</option>
                </select>
              </div>

              <div>
                <label htmlFor="requiresFasting" className="block text-sm font-medium text-gray-700 mb-1">
                  Requires Fasting
                </label>
                <select
                  id="requiresFasting"
                  value={requiresFasting}
                  onChange={(e) => setRequiresFasting(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
                >
                  <option value="">Default</option>
                  <option value="true">Yes</option>
                  <option value="false">No</option>
                </select>
              </div>
            </div>

            {/* Action Buttons */}
            <div className="flex space-x-3">
              <button
                onClick={handleGenerateConfig}
                disabled={isGenerating || !testName.trim()}
                className="flex-1 flex items-center justify-center px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isGenerating ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Generating...
                  </>
                ) : (
                  <>
                    <Sparkles className="h-4 w-4 mr-2" />
                    Preview Configuration
                  </>
                )}
              </button>

              <button
                onClick={handleCreateWithInsert}
                disabled={isCreating || !testName.trim()}
                className="flex-1 flex items-center justify-center px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isCreating ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Creating...
                  </>
                ) : (
                  <>
                    <TestTube className="h-4 w-4 mr-2" />
                    Generate & Create
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        {/* Edit Mode */}
        {editMode && (
          <div className="space-y-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">Edit Test Name</h3>
              <div className="flex space-x-2">
                <button onClick={handleSave} className="text-green-600 hover:text-green-700">
                  <Save className="h-5 w-5" />
                </button>
                <button onClick={handleCancelEdit} className="text-gray-600 hover:text-gray-700">
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>
            <input
              type="text"
              value={testName}
              onChange={(e) => setTestName(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
              placeholder="Enter test name"
            />
          </div>
        )}

        {/* Error Display */}
        {error && (
          <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-md flex items-center space-x-2">
            <AlertCircle className="h-5 w-5 text-red-600" />
            <span className="text-red-700 text-sm">{error}</span>
          </div>
        )}

        {/* Success Message */}
        {successMessage && (
          <div className="mt-4 p-3 bg-green-50 border border-green-200 rounded-md flex items-center space-x-2">
            <Check className="h-5 w-5 text-green-600" />
            <span className="text-green-700 text-sm">{successMessage}</span>
          </div>
        )}

        {/* Generated Configuration Display */}
        {generatedConfig && (
          <div className="mt-6 space-y-6">
            <div className="flex items-center justify-between">
              <h3 className="text-xl font-semibold text-gray-900">Generated Configuration</h3>
              <div className="flex items-center space-x-3">
                <span className={`px-2 py-1 rounded-full text-xs font-medium ${
                  confidence >= 0.9 ? 'bg-green-100 text-green-800' :
                  confidence >= 0.7 ? 'bg-yellow-100 text-yellow-800' :
                  'bg-red-100 text-red-800'
                }`}>
                  {Math.round(confidence * 100)}% Confidence
                </span>
                <button
                  onClick={handleEdit}
                  className="text-blue-600 hover:text-blue-700"
                  title="Edit input"
                >
                  <Edit3 className="h-5 w-5" />
                </button>
              </div>
            </div>

            {/* Test Group Details */}
            <div className="border rounded-lg p-4 bg-blue-50">
              <h3 className="font-semibold text-lg mb-2">Test Group</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                <div><strong>Name:</strong> {generatedConfig.test_group?.name || 'N/A'}</div>
                <div><strong>Code:</strong> {generatedConfig.test_group?.code || 'N/A'}</div>
                <div><strong>Category:</strong> {generatedConfig.test_group?.category || 'N/A'}</div>
                <div><strong>TAT:</strong> {generatedConfig.test_group?.turnaround_time || 'N/A'}</div>
                <div><strong>Price:</strong> ₹{generatedConfig.test_group?.price || '0'}</div>
                <div><strong>Sample Type:</strong> {generatedConfig.test_group?.sample_type || 'N/A'}</div>
                <div><strong>Fasting:</strong> {generatedConfig.test_group?.requires_fasting ? 'Yes' : 'No'}</div>
              </div>
              {generatedConfig.test_group?.clinical_purpose && (
                <div className="mt-2">
                  <strong>Clinical Purpose:</strong> {generatedConfig.test_group.clinical_purpose}
                </div>
              )}
            </div>

            {/* Analytes */}
            <div className="space-y-2">
              <h3 className="font-semibold text-lg">Analytes ({generatedConfig.analytes?.length || 0})</h3>
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {generatedConfig.analytes?.map((analyte, idx) => (
                  <div key={idx} className="border rounded p-3 bg-gray-50">
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-medium">{analyte.name || 'N/A'}</span>
                      <span className="text-sm text-gray-600">{analyte.unit || 'N/A'}</span>
                    </div>
                    <div className="text-sm text-gray-600 space-y-1">
                      <div><strong>Reference Range:</strong> {analyte.reference_range || 'N/A'}</div>
                      {(analyte.low_critical || analyte.high_critical) && (
                        <div className="text-red-600">
                          <strong>Critical Values:</strong>
                          {analyte.low_critical && ` Low: ${analyte.low_critical}`}
                          {analyte.high_critical && ` High: ${analyte.high_critical}`}
                        </div>
                      )}
                      <div className="text-xs mt-1">
                        <div><strong>Low:</strong> {analyte.interpretation_low || 'N/A'}</div>
                        <div><strong>Normal:</strong> {analyte.interpretation_normal || 'N/A'}</div>
                        <div><strong>High:</strong> {analyte.interpretation_high || 'N/A'}</div>
                      </div>
                    </div>
                  </div>
                )) || []}
              </div>
            </div>

            {/* AI Reasoning */}
            {generatedConfig.reasoning && (
              <div className="border rounded-lg p-3 bg-gray-50">
                <h4 className="font-medium mb-1">AI Reasoning</h4>
                <p className="text-sm text-gray-700">{generatedConfig.reasoning}</p>
              </div>
            )}

            {/* Action Button */}
            <div className="flex gap-2">
              <button 
                onClick={handleCreateConfiguration}
                disabled={isCreating}
                className="flex-1 flex items-center justify-center px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <TestTube className="h-4 w-4 mr-2" />
                Create Test Group
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
