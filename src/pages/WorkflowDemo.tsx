import { useEffect, useState } from 'react';
import { getWorkflows } from '../utils/workflowAPI';
import SimpleWorkflowRunner from '../components/Workflow/SimpleWorkflowRunner';

interface Workflow {
  id: string;
  name: string;
  scope: string;
  definition: any;
  version: number;
}

const WorkflowDemo = () => {
  const [availableWorkflows, setAvailableWorkflows] = useState<Workflow[]>([]);
  const [selectedWorkflow, setSelectedWorkflow] = useState<any>(null);
  const [currentWorkflowId, setCurrentWorkflowId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [completionData, setCompletionData] = useState<any>(null);

  useEffect(() => {
    const fetchWorkflows = async () => {
      try {
        setLoading(true);
        const workflows = await getWorkflows();
        setAvailableWorkflows(workflows);
        setError(null);
      } catch (error) {
        console.error('Error fetching workflows:', error);
        setError('Failed to load workflows from database');
      } finally {
        setLoading(false);
      }
    };

    fetchWorkflows();
  }, []);

  const handleWorkflowSelect = (workflowId: string) => {
    const selectedWorkflow = availableWorkflows.find(w => w.id === workflowId);
    if (selectedWorkflow) {
      setSelectedWorkflow(selectedWorkflow.definition);
      setCurrentWorkflowId(workflowId);
      setCompletionData(null);
    }
  };

  const handleWorkflowComplete = (results: any) => {
    console.log('Workflow completed:', results);
    setCompletionData(results);
  };

  return (
    <div className="container mx-auto p-6 max-w-4xl">
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2">Survey.js Workflow System</h1>
        <p className="text-gray-600">
          Execute laboratory workflows with automated result submission to database
        </p>
      </div>

      {/* Workflow Selection */}
      <div className="bg-white rounded-lg border border-gray-200 p-6 mb-6">
        <h2 className="text-xl font-semibold mb-4">Select Workflow</h2>
        
        {loading && (
          <div className="flex items-center justify-center py-8">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
            <span className="ml-2">Loading workflows...</span>
          </div>
        )}

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-4">
            <div className="flex items-center text-red-600">
              <svg className="h-5 w-5 mr-2" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
              </svg>
              {error}
            </div>
          </div>
        )}

        {!loading && !error && (
          <div className="space-y-4">
            <select 
              onChange={(e) => handleWorkflowSelect(e.target.value)}
              value={currentWorkflowId}
              className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            >
              <option value="">Select a workflow to execute...</option>
              {availableWorkflows.map((workflow) => (
                <option key={workflow.id} value={workflow.id}>
                  {workflow.name} (v{workflow.version})
                </option>
              ))}
            </select>

            {availableWorkflows.length === 0 && (
              <div className="text-center py-8 text-gray-500">
                <p>No workflows found in database.</p>
                <p className="text-sm mt-2">
                  Make sure you have workflow definitions in the <code>workflows</code> and <code>workflow_versions</code> tables.
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Workflow Execution */}
      {selectedWorkflow && (
        <div className="space-y-6">
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
            <h3 className="font-semibold text-blue-800 mb-2">Database Integration Active</h3>
            <p className="text-blue-700 text-sm">
              This workflow will save results to the <code>results</code> and <code>result_values</code> tables 
              when completed successfully.
            </p>
          </div>

          <SimpleWorkflowRunner
            workflowDefinition={selectedWorkflow}
            onComplete={handleWorkflowComplete}
            orderId={crypto.randomUUID()} // Generate test order ID
            testGroupId="test-group-1"
          />
        </div>
      )}

      {/* Results Display */}
      {completionData && (
        <div className="mt-6 bg-green-50 border border-green-200 rounded-lg p-6">
          <h3 className="text-lg font-semibold text-green-800 mb-4">
            ✅ Workflow Results Saved Successfully
          </h3>
          <div className="bg-white rounded border p-4">
            <h4 className="font-medium mb-2">Submitted Data:</h4>
            <pre className="text-xs overflow-auto max-h-60 bg-gray-50 p-3 rounded">
              {JSON.stringify(completionData, null, 2)}
            </pre>
          </div>
          <div className="mt-4 text-sm text-green-700">
            <p>📊 Data has been processed and stored in:</p>
            <ul className="list-disc list-inside mt-2 space-y-1">
              <li><code>results</code> table - Main workflow result record</li>
              <li><code>result_values</code> table - Individual measurement values</li>
              <li><code>quality_control_results</code> table - QC data (if applicable)</li>
              <li><code>workflow_step_events</code> table - Workflow execution log</li>
            </ul>
          </div>
        </div>
      )}

      {/* Help Section */}
      <div className="mt-8 bg-gray-50 rounded-lg p-6">
        <h3 className="text-lg font-semibold mb-4">📋 Testing Instructions</h3>
        <div className="space-y-3 text-sm">
          <div>
            <strong>1. Select Workflow:</strong> Choose from workflows stored in your database
          </div>
          <div>
            <strong>2. Execute Steps:</strong> Follow the Survey.js interface to complete each step
          </div>
          <div>
            <strong>3. Submit Results:</strong> Click "Complete" to save results to database
          </div>
          <div>
            <strong>4. Verify Data:</strong> Check your database tables to see the stored results
          </div>
        </div>

        <div className="mt-4 p-4 bg-white rounded border">
          <h4 className="font-medium mb-2">Available Workflows:</h4>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
            {availableWorkflows.map(workflow => (
              <div key={workflow.id} className="p-2 bg-gray-50 rounded">
                <div className="font-medium">{workflow.name}</div>
                <div className="text-gray-600">Scope: {workflow.scope}</div>
                <div className="text-gray-600">Version: {workflow.version}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default WorkflowDemo;
