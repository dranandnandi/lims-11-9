import React, { useState } from 'react';
import { Camera, Upload, Brain, Zap, Eye, FileText, AlertTriangle, CheckCircle, TestTube } from 'lucide-react';
import PhotoAnalysis from '../components/AITools/PhotoAnalysis';
import PipetteValidation from '../components/AITools/PipetteValidation';
import OCRExtraction from '../components/AITools/OCRExtraction';
import { AITestConfigurator } from '../components/AITools/AITestConfigurator';
import { TestConfigurationResponse } from '../utils/geminiAI';
import { supabase } from '../utils/supabase';

const AITools: React.FC = () => {
  const [activeTab, setActiveTab] = useState('photo');
  const [existingTests] = useState<string[]>([
    'Complete Blood Count', 'Basic Metabolic Panel', 'Lipid Panel', 
    'Thyroid Function', 'Liver Function Tests'
  ]);

  const handleConfigurationGenerated = async (config: TestConfigurationResponse) => {
    console.log('Generated AI configuration:', config);
    
    try {
      // First, create the test group - using correct column names
      const testGroupData = {
        name: config.testGroup.name,
        code: config.testGroup.name.toUpperCase().replace(/\s+/g, '_'),
        category: config.testGroup.category,
        clinical_purpose: config.testGroup.clinical_purpose,
        price: config.testGroup.price,
        turnaround_time: config.testGroup.tat_hours,
        sample_type: config.testGroup.sample_type,
        requires_fasting: false,
        is_active: true,
        default_ai_processing_type: 'ocr_report',
        group_level_prompt: config.testGroup.instructions,
        lab_id: null, // Set to null or get from user context
        to_be_copied: false
      };

      console.log('Creating test group:', testGroupData);

      const { data: newTestGroup, error: testGroupError } = await supabase
        .from('test_groups')
        .insert(testGroupData)
        .select()
        .single();

      if (testGroupError) {
        console.error('Error creating test group:', testGroupError);
        throw testGroupError;
      }

      console.log('Test group created:', newTestGroup);

      // Then, create the analytes
      const analytesToCreate = config.analytes.map((analyte: any) => ({
        name: analyte.name,
        unit: analyte.unit,
        method: analyte.method,
        // description: analyte.description, // This column doesn't exist in analytes table
        category: config.testGroup.category, // Use same category as test group
        normal_range_min: analyte.reference_min,
        normal_range_max: analyte.reference_max,
        low_critical: analyte.critical_min > 0 ? analyte.critical_min : null,
        high_critical: analyte.critical_max > 0 ? analyte.critical_max : null,
        reference_range: `${analyte.reference_min}-${analyte.reference_max}`,
        is_active: true,
        ai_processing_type: 'ocr_report',
        group_ai_mode: 'individual'
      }));

      console.log('Creating analytes:', analytesToCreate);

      const { data: newAnalytes, error: analytesError } = await supabase
        .from('analytes')
        .insert(analytesToCreate)
        .select();

      if (analytesError) {
        console.error('Error creating analytes:', analytesError);
        throw analytesError;
      }

      console.log('Analytes created:', newAnalytes);

      // Finally, create the relationships between test group and analytes
      const relationships = newAnalytes.map((analyte: any) => ({
        test_group_id: newTestGroup.id,
        analyte_id: analyte.id
      }));

      console.log('Creating relationships:', relationships);

      const { error: relationshipsError } = await supabase
        .from('test_group_analytes')
        .insert(relationships);

      if (relationshipsError) {
        console.error('Error creating relationships:', relationshipsError);
        throw relationshipsError;
      }

      console.log('✅ Test group, analytes, and relationships created successfully!');
      
      // Show success message
      alert(`✅ Successfully created "${config.testGroup.name}" with ${config.analytes.length} analytes!`);

    } catch (error) {
      console.error('Failed to create test configuration:', error);
      alert(`❌ Failed to create test configuration: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  const tools = [
    {
      id: 'photo',
      name: 'Photo Recognition',
      description: 'Analyze test cards and strips using AI',
      icon: Camera,
      color: 'blue',
      features: ['Blood grouping cards', 'Lateral flow tests', 'COVID test strips', 'Malaria detection'],
    },
    {
      id: 'pipette',
      name: 'Pipette Validation',
      description: 'Validate pipetting accuracy with image analysis',
      icon: Zap,
      color: 'purple',
      features: ['Volume measurement', 'Accuracy validation', 'QC logging', 'Calibration tracking'],
    },
    {
      id: 'ocr',
      name: 'OCR Extraction',
      description: 'Extract results from instrument displays and reports',
      icon: FileText,
      color: 'green',
      features: ['Screen capture', 'PDF parsing', 'Auto data entry', 'Pattern recognition'],
    },
    {
      id: 'configurator',
      name: 'Test Configurator',
      description: 'AI-powered test group and analyte suggestions',
      icon: TestTube,
      color: 'indigo',
      features: ['Smart test suggestions', 'Analyte configuration', 'Reference ranges', 'Medical accuracy'],
    },
  ];

  const renderActiveComponent = () => {
    switch (activeTab) {
      case 'photo':
        return <PhotoAnalysis />;
      case 'pipette':
        return <PipetteValidation />;
      case 'ocr':
        return <OCRExtraction />;
      case 'configurator':
        return (
          <div className="p-6">
            <AITestConfigurator
              onConfigurationGenerated={handleConfigurationGenerated}
              existingTests={existingTests}
              className="w-full"
            />
          </div>
        );
      default:
        return <PhotoAnalysis />;
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">AI-Enhanced Tools</h1>
          <p className="text-gray-600 mt-2">
            Leverage artificial intelligence to automate result interpretation and quality validation
          </p>
        </div>
        <div className="flex items-center space-x-2 text-sm text-gray-500">
          <Brain className="h-4 w-4" />
          <span>Powered by Computer Vision</span>
        </div>
      </div>

      {/* Tool Selection Tabs */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-1">
        <div className="flex space-x-1">
          {tools.map((tool) => (
            <button
              key={tool.id}
              onClick={() => setActiveTab(tool.id)}
              className={`
                flex-1 flex items-center justify-center px-4 py-3 rounded-md text-sm font-medium transition-all
                ${activeTab === tool.id
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
                }
              `}
            >
              <tool.icon className="h-4 w-4 mr-2" />
              {tool.name}
            </button>
          ))}
        </div>
      </div>

      {/* Tool Overview Cards */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {tools.map((tool) => (
          <div
            key={tool.id}
            className={`
              bg-white rounded-lg shadow-sm border-2 p-6 cursor-pointer transition-all
              ${activeTab === tool.id
                ? 'border-blue-500 bg-blue-50'
                : 'border-gray-200 hover:border-gray-300 hover:shadow-md'
              }
            `}
            onClick={() => setActiveTab(tool.id)}
          >
            <div className="flex items-center mb-4">
              <div className={`p-3 rounded-lg bg-${tool.color}-100`}>
                <tool.icon className={`h-6 w-6 text-${tool.color}-600`} />
              </div>
              <div className="ml-4">
                <h3 className="text-lg font-semibold text-gray-900">{tool.name}</h3>
                <p className="text-sm text-gray-600">{tool.description}</p>
              </div>
            </div>
            
            <div className="space-y-2">
              {tool.features.map((feature, index) => (
                <div key={index} className="flex items-center text-sm text-gray-600">
                  <CheckCircle className="h-3 w-3 text-green-500 mr-2 flex-shrink-0" />
                  {feature}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Active Tool Component */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200">
        {renderActiveComponent()}
      </div>

      {/* AI Features Info */}
      <div className="bg-gradient-to-r from-purple-50 to-blue-50 rounded-lg p-6">
        <div className="flex items-start space-x-4">
          <div className="bg-purple-100 p-3 rounded-lg">
            <Brain className="h-6 w-6 text-purple-600" />
          </div>
          <div className="flex-1">
            <h3 className="text-lg font-semibold text-gray-900 mb-2">
              Advanced AI Capabilities
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm text-gray-600">
              <div>
                <h4 className="font-medium text-gray-900 mb-1">Computer Vision Models</h4>
                <p>Custom-trained neural networks for medical test interpretation with high accuracy rates.</p>
              </div>
              <div>
                <h4 className="font-medium text-gray-900 mb-1">OCR Processing</h4>
                <p>Advanced optical character recognition optimized for laboratory instruments and reports.</p>
              </div>
              <div>
                <h4 className="font-medium text-gray-900 mb-1">Quality Assurance</h4>
                <p>AI-powered quality control to ensure accurate measurements and reduce human error.</p>
              </div>
              <div>
                <h4 className="font-medium text-gray-900 mb-1">Continuous Learning</h4>
                <p>Models improve over time with usage data and feedback from laboratory professionals.</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AITools;