import React, { useState, useEffect } from 'react';
import { Workflow, Play, Pause, CheckCircle, AlertTriangle, Loader2 } from 'lucide-react';
import WorkflowRunner from './WorkflowRunner';
import { getWorkflows } from '../../utils/workflowAPI';
import type { WorkflowDefinition, WorkflowInstance } from '../../types/workflow';

interface FlowManagerProps {
  orderId: string;
  testGroupId: string;
  analyteIds: string[];
  labId: string;
  onComplete: (results: any) => void;
  className?: string;
}

interface FlowMap {
  id: string;
  type: 'group' | 'analyte';
  targetId: string;
  targetName: string;
  workflowVersionId: string;
  definition: WorkflowDefinition;
  instanceId?: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
}

export const FlowManager: React.FC<FlowManagerProps> = ({
  orderId,
  testGroupId,
  analyteIds,
  labId,
  onComplete,
  className = ''
}) => {
  const [flows, setFlows] = useState<FlowMap[]>([]);
  const [currentFlow, setCurrentFlow] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Resolve all applicable workflows
  useEffect(() => {
    resolveWorkflows();
  }, [testGroupId, analyteIds, labId]);

  const resolveWorkflows = async () => {
    try {
      setLoading(true);
      setError(null);
      const resolvedFlows: FlowMap[] = [];

      // 1. Check for test group level workflow
      const groupResponse = await WorkflowAPI.resolveWorkflow({
        labId,
        testGroupId,
        context: {
          orderType: 'standard',
          urgency: 'routine'
        }
      });

      if (groupResponse) {
        resolvedFlows.push({
          id: `group_${testGroupId}`,
          type: 'group',
          targetId: testGroupId,
          targetName: `Test Group Workflow`,
          workflowVersionId: groupResponse.workflowVersionId,
          definition: groupResponse.definition,
          status: 'pending'
        });
      }

      // 2. Check for analyte-specific workflows
      for (const analyteId of analyteIds) {
        const analyteResponse = await WorkflowAPI.resolveWorkflow({
          labId,
          testGroupId,
          analyteId,
          context: {
            orderType: 'standard',
            urgency: 'routine'
          }
        });

        // Only add if different from group workflow
        if (analyteResponse && analyteResponse.workflowVersionId !== groupResponse?.workflowVersionId) {
          resolvedFlows.push({
            id: `analyte_${analyteId}`,
            type: 'analyte',
            targetId: analyteId,
            targetName: `Analyte Workflow (${analyteId.slice(-8)})`,
            workflowVersionId: analyteResponse.workflowVersionId,
            definition: analyteResponse.definition,
            status: 'pending'
          });
        }
      }

      setFlows(resolvedFlows);
      
      // Auto-start first workflow if available
      if (resolvedFlows.length > 0) {
        setCurrentFlow(resolvedFlows[0].id);
      }

    } catch (err) {
      console.error('Failed to resolve workflows:', err);
      setError('Failed to load workflow configurations');
    } finally {
      setLoading(false);
    }
  };

  const handleFlowComplete = (flowId: string, results: any) => {
    setFlows(prev => prev.map(flow => 
      flow.id === flowId 
        ? { ...flow, status: 'completed' as const }
        : flow
    ));

    // Find next pending flow
    const nextFlow = flows.find(f => f.status === 'pending' && f.id !== flowId);
    if (nextFlow) {
      setCurrentFlow(nextFlow.id);
    } else {
      // All flows complete
      onComplete({
        orderId,
        flows: flows.map(f => ({ id: f.id, results })),
        completedAt: new Date().toISOString()
      });
    }
  };

  const handleFlowValidation = (flowId: string, isValid: boolean) => {
    console.log(`Flow ${flowId} validation:`, isValid);
  };

  const startFlow = (flowId: string) => {
    setCurrentFlow(flowId);
    setFlows(prev => prev.map(flow => 
      flow.id === flowId 
        ? { ...flow, status: 'running' as const }
        : flow
    ));
  };

  const currentFlowData = flows.find(f => f.id === currentFlow);

  if (loading) {
    return (
      <div className={`bg-white rounded-lg shadow-sm border p-6 ${className}`}>
        <div className="flex items-center justify-center h-32">
          <div className="text-center">
            <Loader2 className="h-8 w-8 animate-spin mx-auto mb-2 text-blue-500" />
            <p className="text-gray-600">Resolving workflows...</p>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={`bg-white rounded-lg shadow-sm border p-6 ${className}`}>
        <div className="flex items-center space-x-3 text-red-600">
          <AlertTriangle className="h-6 w-6" />
          <div>
            <h3 className="font-medium">Workflow Error</h3>
            <p className="text-sm">{error}</p>
          </div>
        </div>
      </div>
    );
  }

  if (flows.length === 0) {
    return (
      <div className={`bg-white rounded-lg shadow-sm border p-6 ${className}`}>
        <div className="text-center">
          <Workflow className="h-12 w-12 mx-auto text-gray-400 mb-4" />
          <h3 className="text-lg font-medium text-gray-900 mb-2">No Workflows Configured</h3>
          <p className="text-gray-600">
            No custom workflows are configured for this test group or analytes.
            Using standard processing flow.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={`space-y-6 ${className}`}>
      {/* Workflow Overview */}
      <div className="bg-white rounded-lg shadow-sm border p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center space-x-3">
            <Workflow className="h-6 w-6 text-blue-500" />
            <h3 className="text-lg font-semibold text-gray-900">Custom Workflows</h3>
          </div>
          <span className="text-sm text-gray-500">
            {flows.filter(f => f.status === 'completed').length} of {flows.length} completed
          </span>
        </div>

        {/* Flow List */}
        <div className="space-y-3">
          {flows.map((flow) => (
            <div key={flow.id} className={`flex items-center justify-between p-4 rounded-lg border-2 transition-colors ${
              currentFlow === flow.id 
                ? 'border-blue-500 bg-blue-50' 
                : 'border-gray-200 hover:border-gray-300'
            }`}>
              <div className="flex items-center space-x-3">
                <div className={`flex-shrink-0 ${
                  flow.status === 'completed' ? 'text-green-500' :
                  flow.status === 'running' ? 'text-blue-500' :
                  flow.status === 'failed' ? 'text-red-500' :
                  'text-gray-400'
                }`}>
                  {flow.status === 'completed' ? (
                    <CheckCircle className="h-5 w-5" />
                  ) : flow.status === 'running' ? (
                    <Loader2 className="h-5 w-5 animate-spin" />
                  ) : flow.status === 'failed' ? (
                    <AlertTriangle className="h-5 w-5" />
                  ) : (
                    <Pause className="h-5 w-5" />
                  )}
                </div>
                
                <div>
                  <h4 className="font-medium text-gray-900">{flow.definition.meta.title}</h4>
                  <p className="text-sm text-gray-600">
                    {flow.type === 'group' ? 'Test Group' : 'Analyte'} • {flow.definition.rules.mode} Mode
                  </p>
                </div>
              </div>

              <div className="flex items-center space-x-2">
                <span className={`px-2 py-1 rounded-full text-xs font-medium ${
                  flow.status === 'completed' ? 'bg-green-100 text-green-800' :
                  flow.status === 'running' ? 'bg-blue-100 text-blue-800' :
                  flow.status === 'failed' ? 'bg-red-100 text-red-800' :
                  'bg-gray-100 text-gray-800'
                }`}>
                  {flow.status}
                </span>
                
                {flow.status === 'pending' && (
                  <button
                    onClick={() => startFlow(flow.id)}
                    className="flex items-center space-x-1 px-3 py-1 bg-blue-600 text-white rounded-md hover:bg-blue-700 text-sm"
                  >
                    <Play className="h-3 w-3" />
                    <span>Start</span>
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Active Workflow Runner */}
      {currentFlow && currentFlowData && (
        <WorkflowRunner
          orderId={orderId}
          workflowDefinition={currentFlowData.definition}
          onComplete={(results) => handleFlowComplete(currentFlow, results)}
        />
      )}
    </div>
  );
};