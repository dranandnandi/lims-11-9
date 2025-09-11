import React, { useState } from 'react';
import { Camera, Upload, Brain, Zap, Eye, FileText, CheckCircle, TestTube } from 'lucide-react';
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
    
    // If the Edge Function already handled the insert, just show success
    if (config.inserted) {
      alert(`✅ Successfully created "${config.test_group.name}" with ${config.analytes.length} analytes!`);
      return;
    }
    
    // Otherwise, handle local insert using the new data structure
    try {
      // Check if test group already exists - use array query to avoid 406 errors
      const testCode = config.test_group.code;
      
      const { data: existingGroups } = await supabase
        .from('test_groups')
        .select('id, name, code')
        .or(`name.eq.${config.test_group.name},code.eq.${testCode}`)
        .limit(1);

      const existingGroup = existingGroups && existingGroups.length > 0 ? existingGroups[0] : null;

      if (existingGroup) {
        const message = `⚠️ Test group "${config.test_group.name}" already exists!\n\nFound existing test group:\n• Name: ${existingGroup.name}\n• Code: ${existingGroup.code}\n\nPlease:\n1. Go to Tests page to edit the existing test group\n2. Or try a different test name\n3. Or modify the existing configuration`;
        alert(message);
        console.warn('Duplicate test group found:', existingGroup);
        return;
      }

      // Convert new format to database format
      const testGroupData = {
        name: config.test_group.name,
        code: config.test_group.code,
        category: config.test_group.category,
        clinical_purpose: config.test_group.clinical_purpose,
        price: parseFloat(config.test_group.price),
        turnaround_time: extractHours(config.test_group.turnaround_time),
        sample_type: config.test_group.sample_type,
        requires_fasting: config.test_group.requires_fasting,
        is_active: config.test_group.is_active,
        default_ai_processing_type: config.test_group.default_ai_processing_type,
        group_level_prompt: config.test_group.group_level_prompt,
        lab_id: null,
        to_be_copied: config.test_group.to_be_copied
      };

      console.log('Creating test group:', testGroupData);

      const { data: newTestGroup, error: testGroupError } = await supabase
        .from('test_groups')
        .insert(testGroupData)
        .select()
        .single();

      if (testGroupError) {
        console.error('Error creating test group:', testGroupError);
        if (testGroupError.code === '23505') {
          if (testGroupError.message.includes('test_groups_code_key')) {
            alert(`❌ Test group code "${testCode}" already exists!\n\nPlease try a different test name or check the existing test groups.`);
          } else if (testGroupError.message.includes('test_groups_name_key')) {
            alert(`❌ Test group name "${config.test_group.name}" already exists!\n\nPlease try a different test name or check the existing test groups.`);
          } else {
            alert(`❌ Duplicate entry error: ${testGroupError.message}`);
          }
          return;
        }
        throw testGroupError;
      }

      console.log('Test group created:', newTestGroup);

      // Create analytes WITHOUT test_group_id and lab_id (they are independent entities)
      const analytesToCreate = config.analytes.map((analyte) => ({
        name: analyte.name,
        unit: analyte.unit || '',
        reference_range: analyte.reference_range || '',
        category: analyte.category || config.test_group.category,
        is_active: true,
        low_critical: analyte.low_critical ? parseFloat(analyte.low_critical) : null,
        high_critical: analyte.high_critical ? parseFloat(analyte.high_critical) : null,
        ai_processing_type: 'ocr_report', // Use 'gemini' instead of 'ocr_report'
        group_ai_mode: analyte.group_ai_mode || 'individual'
        // Removed lab_id as it doesn't exist in analytes table
      }));

      console.log('Creating analytes:', analytesToCreate);

      // Create analytes one by one to handle duplicates gracefully
      const createdAnalytes = [];
      
      for (const analyteData of analytesToCreate) {
        // Check if analyte already exists
        const { data: existingAnalyte } = await supabase
          .from('analytes')
          .select('id, name')
          .eq('name', analyteData.name)
          .maybeSingle();

        if (existingAnalyte) {
          console.log(`Analyte "${analyteData.name}" already exists, using existing one`);
          createdAnalytes.push(existingAnalyte);
        } else {
          // Create new analyte
          const { data: newAnalyte, error: analyteError } = await supabase
            .from('analytes')
            .insert(analyteData)
            .select()
            .single();

          if (analyteError) {
            console.error(`Error creating analyte ${analyteData.name}:`, analyteError);
            // Continue with other analytes even if one fails
            continue;
          }
          
          if (newAnalyte) {
            createdAnalytes.push(newAnalyte);
          }
        }
      }

      console.log('Analytes processed:', createdAnalytes);

      // Create relationships between test group and analytes
      if (createdAnalytes.length === 0) {
        console.warn('No analytes were created, skipping relationship creation');
        alert(`✅ Test group "${config.test_group.name}" created, but no analytes were processed.`);
        return;
      }

      const relationships = createdAnalytes.map((analyte) => ({
        test_group_id: newTestGroup.id,
        analyte_id: analyte.id
      }));

      console.log('Creating relationships:', relationships);

      // Insert relationships one by one to handle duplicates gracefully
      let relationshipsCreated = 0;
      for (const relationship of relationships) {
        console.log(`Attempting to create relationship:`, relationship);
        
        const { data: insertedRelationship, error: relationshipError } = await supabase
          .from('test_group_analytes')
          .insert(relationship)
          .select('*');

        if (relationshipError) {
          if (relationshipError.code === '23505') {
            console.log(`Relationship already exists for analyte ${relationship.analyte_id}`);
          } else {
            console.error('Error creating relationship:', relationshipError);
          }
        } else {
          relationshipsCreated++;
          console.log(`Relationship created successfully:`, insertedRelationship);
        }
      }

      console.log(`✅ Test group, analytes, and relationships created successfully! ${relationshipsCreated} relationships created.`);
      alert(`✅ Successfully created "${config.test_group.name}" with ${createdAnalytes.length} analytes and ${relationshipsCreated} relationships!`);

    } catch (error) {
      console.error('Failed to create test configuration:', error);
      alert(`❌ Failed to create test configuration: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  // Helper function to extract hours from turnaround_time string
  const extractHours = (timeString: string): number => {
    const match = timeString.match(/(\d+)/);
    return match ? parseInt(match[1]) : 4;
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