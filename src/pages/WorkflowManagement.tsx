import React, { useState } from 'react';
import { Workflow, Settings, TestTube, Users, BarChart3 } from 'lucide-react';
import { WorkflowConfigurator } from '../components/Workflow/WorkflowConfigurator';
import { FlowManager } from '../components/Workflow/FlowManager';

interface WorkflowManagementProps {
  className?: string;
}

export const WorkflowManagement: React.FC<WorkflowManagementProps> = ({
  className = ''
}) => {
  const [activeTab, setActiveTab] = useState<'config' | 'demo' | 'analytics'>('config');
  const [demoSettings, setDemoSettings] = useState({
    orderId: 'ORDER-12345',
    testGroupId: 'test-group-id',
    analyteIds: ['analyte-1', 'analyte-2'],
    labId: 'lab-123'
  });

  const tabs = [
    {
      id: 'config',
      name: 'Configuration',
      icon: Settings,
      description: 'Configure workflow mappings for test groups and analytes'
    },
    {
      id: 'demo',
      name: 'Demo Runner',
      icon: TestTube,
      description: 'Test workflow execution with sample data'
    },
    {
      id: 'analytics',
      name: 'Analytics',
      icon: BarChart3,
      description: 'View workflow performance metrics'
    }
  ];

  return (
    <div className={`space-y-6 ${className}`}>
      {/* Header */}
      <div className="bg-white rounded-lg shadow-sm border p-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="bg-blue-100 p-3 rounded-lg">
              <Workflow className="h-6 w-6 text-blue-600" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Workflow Management</h1>
              <p className="text-gray-600 mt-1">
                Configure and manage Survey.js workflows for your lab processes
              </p>
            </div>
          </div>
          <div className="flex items-center space-x-2 text-sm text-gray-500">
            <Users className="h-4 w-4" />
            <span>Lab Administrator Access</span>
          </div>
        </div>
      </div>

      {/* Navigation Tabs */}
      <div className="bg-white rounded-lg shadow-sm border">
        <div className="border-b border-gray-200">
          <nav className="flex space-x-8 px-6">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={`py-4 px-1 border-b-2 font-medium text-sm flex items-center space-x-2 ${
                  activeTab === tab.id
                    ? 'border-blue-500 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                <tab.icon className="h-4 w-4" />
                <span>{tab.name}</span>
              </button>
            ))}
          </nav>
        </div>

        {/* Tab Content */}
        <div className="p-6">
          {activeTab === 'config' && (
            <div>
              <div className="mb-6">
                <h3 className="text-lg font-semibold text-gray-900 mb-2">Workflow Configuration</h3>
                <p className="text-gray-600">
                  Map Survey.js workflows to test groups and individual analytes. Higher priority workflows
                  take precedence when multiple mappings exist.
                </p>
              </div>
              <WorkflowConfigurator labId="your-lab-id" />
            </div>
          )}

          {activeTab === 'demo' && (
            <div>
              <div className="mb-6">
                <h3 className="text-lg font-semibold text-gray-900 mb-2">Workflow Demo</h3>
                <p className="text-gray-600">
                  Test workflow execution with sample data. Configure the demo settings below.
                </p>
              </div>

              {/* Demo Settings */}
              <div className="bg-gray-50 rounded-lg p-4 mb-6">
                <h4 className="font-medium text-gray-900 mb-3">Demo Settings</h4>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Order ID
                    </label>
                    <input
                      type="text"
                      value={demoSettings.orderId}
                      onChange={(e) => setDemoSettings(prev => ({ ...prev, orderId: e.target.value }))}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Lab ID
                    </label>
                    <input
                      type="text"
                      value={demoSettings.labId}
                      onChange={(e) => setDemoSettings(prev => ({ ...prev, labId: e.target.value }))}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Test Group ID
                    </label>
                    <input
                      type="text"
                      value={demoSettings.testGroupId}
                      onChange={(e) => setDemoSettings(prev => ({ ...prev, testGroupId: e.target.value }))}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Analyte IDs (comma-separated)
                    </label>
                    <input
                      type="text"
                      value={demoSettings.analyteIds.join(', ')}
                      onChange={(e) => setDemoSettings(prev => ({ 
                        ...prev, 
                        analyteIds: e.target.value.split(',').map(id => id.trim()).filter(Boolean)
                      }))}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
                    />
                  </div>
                </div>
              </div>

              {/* Demo Flow Manager */}
              <FlowManager
                orderId={demoSettings.orderId}
                testGroupId={demoSettings.testGroupId}
                analyteIds={demoSettings.analyteIds}
                labId={demoSettings.labId}
                onComplete={(results) => {
                  console.log('Demo workflow completed:', results);
                  alert('Demo workflow completed! Check console for results.');
                }}
              />
            </div>
          )}

          {activeTab === 'analytics' && (
            <div>
              <div className="mb-6">
                <h3 className="text-lg font-semibold text-gray-900 mb-2">Workflow Analytics</h3>
                <p className="text-gray-600">
                  Monitor workflow performance, completion rates, and user feedback.
                </p>
              </div>

              {/* Analytics Placeholder */}
              <div className="border-2 border-dashed border-gray-300 rounded-lg p-12 text-center">
                <BarChart3 className="h-12 w-12 mx-auto text-gray-400 mb-4" />
                <h4 className="text-lg font-medium text-gray-700 mb-2">Analytics Dashboard</h4>
                <p className="text-gray-500 mb-4">
                  Workflow analytics will be displayed here once sufficient data is collected.
                </p>
                <div className="grid grid-cols-3 gap-4 max-w-md mx-auto">
                  <div className="bg-gray-50 rounded-lg p-4">
                    <div className="text-2xl font-bold text-gray-600">0</div>
                    <div className="text-sm text-gray-500">Total Workflows</div>
                  </div>
                  <div className="bg-gray-50 rounded-lg p-4">
                    <div className="text-2xl font-bold text-gray-600">0%</div>
                    <div className="text-sm text-gray-500">Completion Rate</div>
                  </div>
                  <div className="bg-gray-50 rounded-lg p-4">
                    <div className="text-2xl font-bold text-gray-600">0m</div>
                    <div className="text-sm text-gray-500">Avg Duration</div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Quick Actions */}
      <div className="bg-white rounded-lg shadow-sm border p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Quick Actions</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <button className="p-4 border-2 border-dashed border-gray-300 rounded-lg hover:border-blue-300 hover:bg-blue-50 transition-colors text-left">
            <div className="flex items-center space-x-3">
              <div className="bg-blue-100 p-2 rounded">
                <Workflow className="h-5 w-5 text-blue-600" />
              </div>
              <div>
                <h4 className="font-medium text-gray-900">Create New Workflow</h4>
                <p className="text-sm text-gray-600">Design a new Survey.js workflow</p>
              </div>
            </div>
          </button>

          <button className="p-4 border-2 border-dashed border-gray-300 rounded-lg hover:border-green-300 hover:bg-green-50 transition-colors text-left">
            <div className="flex items-center space-x-3">
              <div className="bg-green-100 p-2 rounded">
                <TestTube className="h-5 w-5 text-green-600" />
              </div>
              <div>
                <h4 className="font-medium text-gray-900">Import Templates</h4>
                <p className="text-sm text-gray-600">Import pre-built workflow templates</p>
              </div>
            </div>
          </button>

          <button className="p-4 border-2 border-dashed border-gray-300 rounded-lg hover:border-purple-300 hover:bg-purple-50 transition-colors text-left">
            <div className="flex items-center space-x-3">
              <div className="bg-purple-100 p-2 rounded">
                <Settings className="h-5 w-5 text-purple-600" />
              </div>
              <div>
                <h4 className="font-medium text-gray-900">Bulk Configuration</h4>
                <p className="text-sm text-gray-600">Configure multiple mappings at once</p>
              </div>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
};