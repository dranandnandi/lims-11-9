import React, { useState, useEffect, useCallback } from 'react'
import { Model } from 'survey-core'
import { Survey } from 'survey-react-ui'
import { submitWorkflowResults } from '../../utils/workflowAPI'
import 'survey-core/defaultV2.min.css'

interface WorkflowRunnerProps {
  workflowDefinition: any
  onComplete?: (results: any) => void
  orderId?: string
  testGroupId?: string
}

type WorkflowStatus = 'idle' | 'loading' | 'running' | 'completed' | 'error'

const WorkflowRunner: React.FC<WorkflowRunnerProps> = ({
  workflowDefinition,
  onComplete,
  orderId,
  testGroupId
}) => {
  const [survey, setSurvey] = useState<Model | null>(null)
  const [status, setStatus] = useState<WorkflowStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [instanceId] = useState(() => crypto.randomUUID())

  // Initialize Survey.js model when workflow definition changes
  useEffect(() => {
    if (!workflowDefinition) return

    try {
      setStatus('loading')
      
      // Create survey model from workflow definition
      const surveyModel = new Model(workflowDefinition.ui?.template || workflowDefinition)
      
      // Configure survey appearance and behavior
      surveyModel.applyTheme({
        colorPalette: 'light',
        isPanelless: false
      })

      // Set up completion handler
      surveyModel.onComplete.add(handleComplete)
      
      setSurvey(surveyModel)
      setStatus('running')
      setError(null)
      
    } catch (err) {
      console.error('Error initializing workflow:', err)
      setError('Failed to initialize workflow')
      setStatus('error')
    }
  }, [workflowDefinition])

  // Handle workflow completion
  const handleComplete = useCallback(async (sender: any) => {
    try {
      setIsSubmitting(true)
      
      const surveyResults = sender.data
      
      // Submit results using the API
      await submitWorkflowResults({
        workflowInstanceId: instanceId,
        stepId: 'final_results',
        results: {
          ...surveyResults,
          test_name: workflowDefinition?.title || workflowDefinition?.meta?.title || 'Workflow Test',
          patient_id: orderId,
          patient_name: 'Test Patient'
        },
        orderId,
        testGroupId
      })
      
      setStatus('completed')
      onComplete?.(surveyResults)
      
    } catch (error) {
      console.error('Error submitting workflow results:', error)
      setError(error instanceof Error ? error.message : 'Failed to submit results')
      setStatus('error')
    } finally {
      setIsSubmitting(false)
    }
  }, [instanceId, orderId, testGroupId, onComplete, workflowDefinition])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (survey) {
        survey.onComplete.clear()
      }
    }
  }, [survey])

  if (status === 'idle' || status === 'loading') {
    return (
      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <div className="flex items-center justify-center">
          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600 mr-2"></div>
          {status === 'loading' ? 'Loading workflow...' : 'Initializing...'}
        </div>
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <div className="flex items-center text-red-600 mb-4">
          <svg className="h-6 w-6 mr-2" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
          </svg>
          <div>
            <h3 className="font-semibold">Workflow Error</h3>
            <p className="text-sm">{error}</p>
          </div>
        </div>
        <button 
          onClick={() => {
            setStatus('idle')
            setError(null)
          }}
          className="px-4 py-2 bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
        >
          Retry
        </button>
      </div>
    )
  }

  if (status === 'completed') {
    return (
      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <div className="flex items-center text-green-600 mb-4">
          <svg className="h-6 w-6 mr-2" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
          </svg>
          <h3 className="text-lg font-semibold">Workflow Completed Successfully</h3>
        </div>
        <p className="text-sm text-gray-600">
          Your workflow has been completed and results have been saved.
        </p>
        <button 
          onClick={() => {
            setStatus('idle')
            setSurvey(null)
          }}
          className="mt-4 px-4 py-2 bg-blue-100 text-blue-700 rounded hover:bg-blue-200"
        >
          Run Again
        </button>
      </div>
    )
  }

  return (
    <div className="bg-white rounded-lg border border-gray-200">
      <div className="p-6 border-b border-gray-200">
        <h3 className="text-lg font-semibold">
          {workflowDefinition?.title || workflowDefinition?.meta?.title || 'Workflow'}
        </h3>
        {workflowDefinition?.description && (
          <p className="text-sm text-gray-600 mt-1">{workflowDefinition.description}</p>
        )}
      </div>
      
      <div className="p-6">
        {isSubmitting && (
          <div className="mb-4 p-4 bg-blue-50 border border-blue-200 rounded-lg">
            <div className="flex items-center">
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600 mr-2"></div>
              <span className="text-sm">Submitting workflow results...</span>
            </div>
          </div>
        )}
        
        {survey && <Survey model={survey} />}
      </div>
    </div>
  )
}

export default WorkflowRunner