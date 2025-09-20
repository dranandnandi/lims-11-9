import React, { useState, useEffect } from 'react';
import { AlertCircle, Activity, Play, CheckCircle, Clock } from 'lucide-react';
import { supabase } from '../../../utils/supabase';
import { useAuth } from '../../../contexts/AuthContext';

// Import FlowManager from the existing workflow system
import { FlowManager } from '../../Workflow/FlowManager';

interface Order {
  id: string;
  patient_id: string;
  patient_name: string;
  lab_id: string;
}

interface TestGroup {
  id: string;
  name: string;
  department: string;
  analytes?: { id: string; name: string }[];
}

interface WorkflowInstance {
  id: string;
  workflow_id: string;
  status: 'not_started' | 'in_progress' | 'completed' | 'failed';
  progress_percentage: number;
  current_step: number;
  total_steps: number;
  started_at?: string;
  completed_at?: string;
}

interface WorkflowPanelProps {
  order: Order;
  testGroup: TestGroup;
  onComplete?: (results: any[]) => void;
}

const WorkflowPanel: React.FC<WorkflowPanelProps> = ({
  order,
  testGroup,
  onComplete
}) => {
  useAuth();
  const [isEligible, setIsEligible] = useState(false);
  const [loading, setLoading] = useState(true);
  const [activeWorkflow, setActiveWorkflow] = useState<WorkflowInstance | null>(null);
  const [availableWorkflows, setAvailableWorkflows] = useState<any[]>([]);
  const [workflowProgress, setWorkflowProgress] = useState(0);
  const [eligibilityReason, setEligibilityReason] = useState<string>('');

  // Check workflow eligibility
  useEffect(() => {
    checkWorkflowEligibility();
  }, [order.id, testGroup.id]);

  const checkWorkflowEligibility = async () => {
    setLoading(true);
    try {
      // Check from our enhanced view
      const { data: progressData, error: progressError } = await supabase
        .from('v_order_test_progress_enhanced')
        .select('workflow_eligible, panel_status, completed_analytes, total_analytes')
        .eq('order_id', order.id)
        .eq('test_group_id', testGroup.id)
        .single();

      if (progressError) {
        console.error('Error checking workflow eligibility:', progressError);
        setEligibilityReason('Unable to check workflow eligibility');
        setIsEligible(false);
        return;
      }

      if (progressData) {
        setIsEligible(progressData.workflow_eligible);
        
        if (!progressData.workflow_eligible) {
          if (progressData.panel_status === 'completed') {
            setEligibilityReason('Results already completed for this test group');
          } else if (progressData.panel_status === 'in_progress') {
            setEligibilityReason(`Partial results exist (${progressData.completed_analytes}/${progressData.total_analytes} completed)`);
          } else {
            setEligibilityReason('No active workflow configured for this test group');
          }
        }
      }

      // If eligible, fetch available workflows
      if (progressData?.workflow_eligible) {
        await fetchAvailableWorkflows();
      }

      // Check for existing workflow instance
      await checkExistingWorkflowInstance();

    } catch (error) {
      console.error('Error checking workflow eligibility:', error);
      setEligibilityReason('Error checking workflow eligibility');
      setIsEligible(false);
    } finally {
      setLoading(false);
    }
  };

  const fetchAvailableWorkflows = async () => {
    try {
      // Use mapping table to find the configured workflow version for this test group
      const { data: mappings, error } = await supabase
        .from('test_workflow_map')
        .select(`
          id,
          workflow_version_id,
          test_group_id,
          is_default,
          workflow_versions:workflow_version_id (
            id,
            version,
            definition,
            created_at,
            active,
            workflow_id
          )
        `)
        .eq('test_group_id', testGroup.id)
        .eq('is_default', true);

      if (error) throw error;

      // Shape to what UI expects (array for compatibility)
      const shaped = (mappings || []).map((m: any) => ({
        id: m.workflow_versions?.workflow_id || m.workflow_version_id,
        name: 'Configured Workflow',
        description: 'Versioned Survey configuration',
        is_active: m.workflow_versions?.active ?? true,
        workflow_versions: [
          {
            id: m.workflow_versions?.id || m.workflow_version_id,
            version: m.workflow_versions?.version || 1,
            definition: m.workflow_versions?.definition,
          },
        ],
      }));

      setAvailableWorkflows(shaped);
    } catch (error) {
      console.error('Error fetching workflows:', error);
    }
  };

  const checkExistingWorkflowInstance = async () => {
    try {
      const { data: instances, error } = await supabase
        .from('order_workflow_instances')
        .select('*')
        .eq('order_id', order.id)
        .eq('status', 'in_progress')
        .order('created_at', { ascending: false })
        .limit(1);

      if (error) throw error;
      
      if (instances && instances.length > 0) {
        setActiveWorkflow(instances[0]);
      }
    } catch (error) {
      console.error('Error checking existing workflow instance:', error);
    }
  };

  const handleWorkflowComplete = (results: any[]) => {
    console.log('Workflow completed with results:', results);
    
    // Update local state
    setActiveWorkflow(null);
    setWorkflowProgress(100);
    setIsEligible(false);
    setEligibilityReason('Workflow completed successfully');
    
    // Call parent callback
    onComplete?.(results);
    
    // Refresh eligibility status
    setTimeout(() => {
      checkWorkflowEligibility();
    }, 1000);
  };

  // Progress updates are handled internally by FlowManager/Runner

  const handleWorkflowStart = () => {
    setActiveWorkflow({
      id: 'temp',
      workflow_id: availableWorkflows[0]?.id || '',
      status: 'in_progress',
      progress_percentage: 0,
      current_step: 1,
      total_steps: 5, // This would come from workflow definition
      started_at: new Date().toISOString()
    });
  };

  if (loading) {
    return (
      <div className="bg-white rounded-lg border p-6">
        <div className="flex items-center justify-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-600"></div>
          <span className="ml-3 text-gray-600">Checking workflow availability...</span>
        </div>
      </div>
    );
  }

  if (!isEligible) {
    return (
      <div className="bg-white rounded-lg border p-6">
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-6 text-center">
          <AlertCircle className="h-12 w-12 text-yellow-600 mx-auto mb-3" />
          <h4 className="font-medium text-yellow-900 mb-2">Workflow Not Available</h4>
          <p className="text-sm text-yellow-700">
            {eligibilityReason}
          </p>
          <div className="mt-4 text-xs text-yellow-600">
            <p>Workflows are only available when:</p>
            <ul className="list-disc list-inside mt-1 space-y-1">
              <li>No results have been entered for this test group</li>
              <li>An active workflow is configured for this test group</li>
              <li>The order is in the correct status</li>
            </ul>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg border p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center">
          <Activity className="h-6 w-6 text-purple-600 mr-2" />
          <h3 className="text-lg font-semibold">Workflow Execution</h3>
        </div>
        {activeWorkflow && (
          <div className="flex items-center text-sm text-gray-600">
            <Clock className="h-4 w-4 mr-1" />
            Step {activeWorkflow.current_step} of {activeWorkflow.total_steps}
          </div>
        )}
      </div>

      {/* Workflow Info */}
      <div className="bg-purple-50 border border-purple-200 rounded-lg p-4 mb-4">
        <h4 className="font-medium text-purple-900 mb-1">
          {availableWorkflows[0]?.name || 'Default Workflow'}
        </h4>
        <p className="text-sm text-purple-700">
          {availableWorkflows[0]?.description || 'Guided result entry workflow for ' + testGroup.name}
        </p>
        <div className="mt-2 flex items-center text-xs text-purple-600">
          <CheckCircle className="h-3 w-3 mr-1" />
          Workflow configured for {testGroup.name}
        </div>
      </div>

      {/* Progress Indicator */}
      {activeWorkflow && (
        <div className="mb-4">
          <div className="flex justify-between text-sm text-gray-600 mb-1">
            <span>Progress</span>
            <span>{workflowProgress}%</span>
          </div>
          <div className="w-full bg-gray-200 rounded-full h-2">
            <div
              className="bg-purple-600 h-2 rounded-full transition-all duration-300"
              style={{ width: `${workflowProgress}%` }}
            />
          </div>
        </div>
      )}

      {/* Workflow Component */}
      {activeWorkflow ? (
        <div className="border rounded-lg bg-gray-50">
          <FlowManager
            orderId={order.id}
            testGroupId={testGroup.id}
            analyteIds={testGroup.analytes?.map(a => a.id) || []}
            labId={order.lab_id}
            onComplete={handleWorkflowComplete}
            key={`${order.id}-${testGroup.id}`} // Force re-render when order/test group changes
          />
        </div>
      ) : (
        /* Start Workflow Button */
        <div className="text-center py-8">
          <div className="mb-4">
            <Play className="h-16 w-16 text-purple-400 mx-auto mb-3" />
            <h4 className="font-medium text-gray-900 mb-2">Ready to Start Workflow</h4>
            <p className="text-sm text-gray-600 mb-4">
              Execute the guided workflow to enter results for {testGroup.name}
            </p>
          </div>
          
          <button
            onClick={handleWorkflowStart}
            className="inline-flex items-center px-6 py-3 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors"
          >
            <Play className="h-5 w-5 mr-2" />
            Start Workflow
          </button>
          
          <div className="mt-4 text-xs text-gray-500">
            <p>The workflow will guide you through each step of result entry</p>
          </div>
        </div>
      )}

      {/* Workflow Stats */}
      {availableWorkflows.length > 0 && (
        <div className="mt-4 pt-4 border-t">
          <div className="grid grid-cols-3 gap-4 text-center">
            <div>
              <div className="text-lg font-semibold text-gray-900">
                {availableWorkflows[0]?.workflow_versions?.[0]?.version || '1.0'}
              </div>
              <div className="text-xs text-gray-500">Version</div>
            </div>
            <div>
              <div className="text-lg font-semibold text-gray-900">
                {testGroup.analytes?.length || 0}
              </div>
              <div className="text-xs text-gray-500">Parameters</div>
            </div>
            <div>
              <div className="text-lg font-semibold text-purple-600">
                {activeWorkflow ? 'Active' : 'Ready'}
              </div>
              <div className="text-xs text-gray-500">Status</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default WorkflowPanel;