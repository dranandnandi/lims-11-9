import React, { useState, useEffect, useCallback } from 'react';
// import { Survey } from 'survey-react-ui';
// import { Model } from 'survey-core';
// import { useDebounce } from 'use-debounce';
import { AlertCircle, CheckCircle, Loader2 } from 'lucide-react';
import { WorkflowAPI } from '../../utils/workflowAPI';
import type { WorkflowDefinition, ValidationState } from '../../types/workflow';

// Temporary interfaces until Survey.js is installed
interface Model {
  data: any;
  setVariable: (name: string, value: any) => void;
  setValue: (name: string, value: any) => void;
  showProgressBar: string;
  progressBarType: string;
  showTimerPanel: string;
  maxTimeToFinish: number;
  applyTheme: (theme: string) => void;
  onValueChanged: { add: (handler: (sender: Model, options: any) => void) => void };
  onCurrentPageChanged: { add: (handler: (sender: Model, options: any) => void) => void };
  onComplete: { add: (handler: (sender: Model) => void) => void };
}

// Temporary hooks
const useDebounce = (value: any, delay: number) => [value];

interface WorkflowRunnerProps {
  orderId: string;
  workflowVersionId: string;
  definition: WorkflowDefinition;
  instanceId?: string;
  onComplete: (results: any) => void;
  onValidate?: (isValid: boolean) => void;
}

export const WorkflowRunner: React.FC<WorkflowRunnerProps> = ({
  orderId,
  workflowVersionId,
  definition,
  instanceId: propInstanceId,
  onComplete,
  onValidate
}) => {
  const [survey, setSurvey] = useState<Model | null>(null);
  const [instanceId, setInstanceId] = useState<string | null>(propInstanceId || null);
  const [validationState, setValidationState] = useState<ValidationState | null>(null);
  const [isValidating, setIsValidating] = useState(false);
  const [currentStep, setCurrentStep] = useState(1);
  const [surveyData, setSurveyData] = useState<any>({});

  // Debounced validation
  const [debouncedData] = useDebounce(surveyData, 500);

  // Initialize survey
  useEffect(() => {
    if (!definition.ui.template) return;

    try {
      // TODO: Replace with actual Survey.js implementation once packages are installed
      // const surveyModel = new Model(definition.ui.template);
      
      const mockSurvey = {
        data: {},
        setVariable: (name: string, value: any) => console.log('setVariable:', name, value),
        setValue: (name: string, value: any) => console.log('setValue:', name, value),
        showProgressBar: "top",
        progressBarType: "pages", 
        showTimerPanel: "bottom",
        maxTimeToFinish: 1800,
        applyTheme: (theme: string) => console.log('applyTheme:', theme),
        onValueChanged: { add: (handler: any) => console.log('onValueChanged added') },
        onCurrentPageChanged: { add: (handler: any) => console.log('onCurrentPageChanged added') },
        onComplete: { add: (handler: any) => console.log('onComplete added') }
      };
      
      // Set runtime variables
      mockSurvey.setVariable("orderId", orderId);
      mockSurvey.setVariable("workflowVersionId", workflowVersionId);
      mockSurvey.setVariable("instanceId", instanceId);

      setSurvey(mockSurvey as any);
    } catch (error) {
      console.error('Failed to initialize survey:', error);
    }
  }, [definition, orderId, workflowVersionId, instanceId]);

  // Start workflow instance if needed
  useEffect(() => {
    if (!instanceId) {
      startWorkflowInstance();
    }
  }, []);

  // Perform validation when data changes
  useEffect(() => {
    if (debouncedData && Object.keys(debouncedData).length > 0) {
      performValidation();
    }
  }, [debouncedData, currentStep]);

  const startWorkflowInstance = async () => {
    const newInstanceId = await WorkflowAPI.startWorkflow(orderId, workflowVersionId);
    if (newInstanceId) {
      setInstanceId(newInstanceId);
    }
  };

  const handleValueChanged = useCallback((sender: Model, options: any) => {
    setSurveyData({ ...sender.data });
    
    // Log data change event
    if (instanceId) {
      WorkflowAPI.logEvent({
        instanceId,
        stepId: currentStep,
        eventType: 'VALIDATE',
        payload: {
          data: { field: options.name, value: options.value },
          metadata: {
            timestamp: new Date().toISOString()
          }
        }
      });
    }
  }, [instanceId, currentStep]);

  const handlePageChanged = useCallback((sender: Model, options: any) => {
    const newStep = options.newCurrentPage?.index + 1 || 1;
    setCurrentStep(newStep);

    // Log page change event
    if (instanceId) {
      WorkflowAPI.logEvent({
        instanceId,
        stepId: newStep,
        eventType: 'NEXT',
        payload: {
          data: sender.data,
          metadata: {
            timestamp: new Date().toISOString(),
            previousStep: currentStep,
            newStep
          }
        }
      });
    }
  }, [instanceId, currentStep]);

  const handleSurveyComplete = useCallback(async (sender: Model) => {
    if (!instanceId) return;

    // Complete the workflow
    const success = await WorkflowAPI.completeWorkflow(instanceId, sender.data);
    
    if (success) {
      onComplete(sender.data);
    } else {
      console.error('Failed to complete workflow');
    }
  }, [instanceId, onComplete]);

  const performValidation = async () => {
    if (!instanceId || isValidating) return;

    setIsValidating(true);
    
    try {
      const result = await WorkflowAPI.validateStep(
        workflowVersionId,
        currentStep,
        surveyData
      );
      
      setValidationState(result);
      onValidate?.(result.ok);

      // Update survey with validation results
      if (survey) {
        survey.setValue('__validate_result', result);
      }
    } catch (error) {
      console.error('Validation failed:', error);
      setValidationState({ ok: false, messages: ['Validation failed'] });
    } finally {
      setIsValidating(false);
    }
  };

  if (!survey) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <Loader2 className="h-8 w-8 animate-spin mx-auto mb-2" />
          <p className="text-gray-600">Loading workflow...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="workflow-runner bg-white rounded-lg shadow-sm border">
      {/* Workflow Header */}
      <div className="border-b px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">
              {definition.meta.title}
            </h3>
            {definition.meta.description && (
              <p className="text-sm text-gray-600 mt-1">
                {definition.meta.description}
              </p>
            )}
          </div>
          <div className="flex items-center space-x-4">
            {/* Validation Status */}
            {validationState && (
              <div className="flex items-center space-x-2">
                {isValidating ? (
                  <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
                ) : validationState.ok ? (
                  <CheckCircle className="h-4 w-4 text-green-500" />
                ) : (
                  <AlertCircle className="h-4 w-4 text-red-500" />
                )}
                <span className={`text-sm ${
                  validationState.ok ? 'text-green-600' : 'text-red-600'
                }`}>
                  {validationState.ok ? 'Valid' : 'Invalid'}
                </span>
              </div>
            )}
            
            {/* Mode Badge */}
            <span className={`px-2 py-1 rounded-full text-xs font-medium ${
              definition.rules.mode === 'PRO' 
                ? 'bg-purple-100 text-purple-800'
                : 'bg-blue-100 text-blue-800'
            }`}>
              {definition.rules.mode} Mode
            </span>
          </div>
        </div>
      </div>

      {/* Validation Messages */}
      {validationState && !validationState.ok && (
        <div className="mx-6 mt-4 p-3 bg-red-50 border border-red-200 rounded-md">
          <div className="flex items-start space-x-2">
            <AlertCircle className="h-4 w-4 text-red-600 mt-0.5 flex-shrink-0" />
            <div>
              <h4 className="text-sm font-medium text-red-800">Validation Issues</h4>
              <ul className="mt-1 text-sm text-red-700 space-y-1">
                {validationState.messages.map((message, index) => (
                  <li key={index}>• {message}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* Survey Component */}
      <div className="p-6">
        {/* TODO: Replace with actual Survey component once packages are installed */}
        {/* <Survey model={survey} /> */}
        <div className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center">
          <h4 className="text-lg font-medium text-gray-700 mb-2">Survey.js Component</h4>
          <p className="text-sm text-gray-500 mb-4">
            Install Survey.js packages to enable the interactive workflow interface
          </p>
          <div className="bg-gray-50 rounded p-4 text-left">
            <pre className="text-xs text-gray-600">
              {JSON.stringify(definition.ui.template, null, 2)}
            </pre>
          </div>
        </div>
      </div>

      {/* Workflow Info */}
      <div className="border-t px-6 py-3 bg-gray-50">
        <div className="flex items-center justify-between text-xs text-gray-500">
          <div>
            Step {currentStep} • Instance: {instanceId?.slice(-8)}
          </div>
          <div>
            Version: {definition.meta.version} • Owner: {definition.meta.owner}
          </div>
        </div>
      </div>
    </div>
  );
};