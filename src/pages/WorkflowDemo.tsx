import React, { useState } from 'react';
import { FlowManager } from '../components/Workflow/FlowManager';
import { Workflow } from 'lucide-react';

const WorkflowDemo: React.FC = () => {
  const [selectedTemplate, setSelectedTemplate] = useState<string>('');
  const [showFlowManager, setShowFlowManager] = useState(false);

  const templates = [
    {
      id: 'basic-lab-workflow',
      name: 'Basic Lab Workflow',
      description: 'Standard laboratory procedure with sample prep, QC, testing, and validation'
    },
    {
      id: 'cbc-test-workflow',
      name: 'CBC Test Workflow',
      description: 'Complete Blood Count test with detailed analyzer setup and results entry'
    }
  ];

  const mockOrder = {
    id: 'ORD-2024-001',
    patient_id: 'PAT-001',
    test_groups: [
      {
        id: 'TG-001',
        name: 'Hematology Panel',
        analytes: [
          { id: 'ANA-001', name: 'White Blood Cell Count' },
          { id: 'ANA-002', name: 'Red Blood Cell Count' },
          { id: 'ANA-003', name: 'Platelet Count' }
        ]
      }
    ]
  };

  const handleWorkflowComplete = (data: any) => {
    console.log('Workflow completed with data:', data);
    alert('Workflow completed successfully! Check console for data.');
  };

  const handleFlowManagerComplete = (results: any) => {
    console.log('Flow Manager completed with results:', results);
    alert('All workflows completed! Check console for results.');
  };

  return (
    <div className="space-y-6">
      <div className="bg-white p-6 rounded-lg shadow">
        <h1 className="text-2xl font-bold text-gray-900 mb-4">
          Survey.js Workflow System Demo
        </h1>
        <p className="text-gray-600 mb-6">
          This demo showcases the dynamic workflow system powered by Survey.js. 
          You can run individual workflows or use the Flow Manager for complex multi-step procedures.
        </p>

        <div className="flex gap-4 mb-6">
          <button
            onClick={() => setShowFlowManager(false)}
            className={`px-4 py-2 rounded ${
              !showFlowManager 
                ? 'bg-blue-600 text-white' 
                : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
            }`}
          >
            Individual Workflows
          </button>
          <button
            onClick={() => setShowFlowManager(true)}
            className={`px-4 py-2 rounded ${
              showFlowManager 
                ? 'bg-blue-600 text-white' 
                : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
            }`}
          >
            Flow Manager Demo
          </button>
        </div>
      </div>

      {!showFlowManager ? (
        <div className="bg-white p-6 rounded-lg shadow">
          <h2 className="text-xl font-semibold mb-4">Select a Workflow Template</h2>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
            {templates.map((template) => (
              <div
                key={template.id}
                className={`p-4 border rounded-lg cursor-pointer transition-colors ${
                  selectedTemplate === template.id
                    ? 'border-blue-500 bg-blue-50'
                    : 'border-gray-200 hover:border-gray-300'
                }`}
                onClick={() => setSelectedTemplate(template.id)}
              >
                <h3 className="font-medium text-gray-900">{template.name}</h3>
                <p className="text-sm text-gray-600 mt-1">{template.description}</p>
              </div>
            ))}
          </div>

          {selectedTemplate && (
            <div className="border-t pt-6">
              <div className="bg-yellow-50 border border-yellow-200 rounded p-4 mb-4">
                <p className="text-sm text-yellow-700">
                  <strong>Note:</strong> This is a demo interface. The actual WorkflowRunner requires 
                  workflow definitions from the database. In production, workflows would be loaded 
                  based on test group and analyte configurations.
                </p>
              </div>
              
              <div className="text-center py-8 text-gray-500">
                <Workflow className="mx-auto h-16 w-16 mb-4" />
                <h3 className="text-lg font-medium mb-2">Workflow: {templates.find(t => t.id === selectedTemplate)?.name}</h3>
                <p className="mb-4">
                  In production, this would load the {selectedTemplate} template and create an interactive Survey.js form
                </p>
                <button
                  onClick={() => handleWorkflowComplete({ templateId: selectedTemplate, status: 'demo_completed' })}
                  className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
                >
                  Simulate Workflow Completion
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="bg-white p-6 rounded-lg shadow">
          <h2 className="text-xl font-semibold mb-4">Flow Manager Demo</h2>
          <p className="text-gray-600 mb-6">
            The Flow Manager automatically selects and orchestrates multiple workflows based on the order context.
          </p>
          
          <div className="bg-gray-50 p-4 rounded mb-6">
            <h3 className="font-medium mb-2">Mock Order Details:</h3>
            <ul className="text-sm text-gray-600">
              <li>Order ID: {mockOrder.id}</li>
              <li>Patient ID: {mockOrder.patient_id}</li>
              <li>Test Groups: {mockOrder.test_groups.map(tg => tg.name).join(', ')}</li>
              <li>Analytes: {mockOrder.test_groups.flatMap(tg => tg.analytes.map(a => a.name)).join(', ')}</li>
            </ul>
          </div>

          <FlowManager
            orderId={mockOrder.id}
            testGroupId="TG-001"
            analyteIds={['ANA-001', 'ANA-002', 'ANA-003']}
            labId="LAB-001"
            onComplete={handleFlowManagerComplete}
          />
        </div>
      )}

      <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
        <h3 className="font-medium text-yellow-800 mb-2">Development Notes:</h3>
        <ul className="text-sm text-yellow-700 space-y-1">
          <li>• Workflow data is logged to the browser console</li>
          <li>• Templates are loaded from the /src/workflows/templates/ directory</li>
          <li>• The system supports conditional logic, validation, and dynamic elements</li>
          <li>• Integration with the database is ready for production use</li>
        </ul>
      </div>
    </div>
  );
};

export default WorkflowDemo;
