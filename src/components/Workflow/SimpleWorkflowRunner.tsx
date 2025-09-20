import React, { useState, useEffect, useCallback } from 'react'
import { Model } from 'survey-core'
import { Survey } from 'survey-react-ui'
import 'survey-core/defaultV2.min.css'
import { supabase } from '../../utils/supabase'

interface SimpleWorkflowRunnerProps {
  workflowDefinition: any
  onComplete?: (results: any) => void
  orderId?: string
  testGroupId?: string
  patientId?: string
  patientName?: string
  testName?: string
  sampleId?: string
  labId?: string
  testCode?: string
}

type WorkflowStatus = 'loading' | 'ready' | 'running' | 'completed' | 'error'

const SimpleWorkflowRunner: React.FC<SimpleWorkflowRunnerProps> = ({
  workflowDefinition,
  onComplete,
  orderId,
  testGroupId,
  patientId,
  patientName,
  testName,
  sampleId,
  labId,
  testCode
}) => {
  const [survey, setSurvey] = useState<Model | null>(null)
  const [status, setStatus] = useState<WorkflowStatus>('loading')
  const [error, setError] = useState<string | null>(null)
  const [completionData, setCompletionData] = useState<any>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [instanceId] = useState(() => crypto.randomUUID())

  // Initialize Survey.js model
  useEffect(() => {
    if (!workflowDefinition) return

    try {
      const surveyModel = new Model(workflowDefinition.ui?.template || workflowDefinition)
      
      // Configure survey theme and behavior
      surveyModel.applyTheme({
        colorPalette: 'light',
        isPanelless: false
      })

      setSurvey(surveyModel)
      setStatus('ready')
    } catch (err) {
      console.error('Error initializing survey:', err)
      setError('Failed to initialize workflow')
      setStatus('error')
    }
  }, [workflowDefinition])

  // Set survey data with context information
  useEffect(() => {
    if (survey && orderId) {
      survey.data = {
        orderId,
        testGroupId,
        patientId,
        patientName,
        testName,
        sampleId,
        labId,
        testCode,
        ...survey.data
      };
    }
  }, [survey, orderId, testGroupId, patientId, patientName, testName, sampleId, labId, testCode]);

  // Extract measurement data from survey results
  const extractMeasurements = (results: any) => {
    const measurements: Record<string, any> = {}
    
    // Look for numeric fields that could be measurements
    Object.entries(results).forEach(([key, value]) => {
      if (typeof value === 'number' || (typeof value === 'string' && !isNaN(Number(value)))) {
        measurements[key] = value
      }
    })
    
    return measurements
  }

  // Extract QC data from survey results
  const extractQCData = (results: any) => {
    if (results.smear_quality) {
      return {
        type: 'smear_quality',
        value: results.smear_quality,
        status: results.smear_quality === 'Good' ? 'pass' : 'fail',
        notes: results.observations || ''
      }
    }
    return null
  }

  // Handle workflow completion with database submission
  const handleComplete = useCallback(async (sender: any) => {
    try {
      setIsSubmitting(true)
      
      // HARD GATE: Block if no order ID - as specified in requirements
      if (!orderId) {
        alert('Create an order and collect sample first.')
        setStatus('error')
        setError('No order ID provided. Please create an order first.')
        return
      }
      
      // Get final results from survey
      const surveyResults = sender.data
      
      // Build workflow_results record for direct API submission
      const workflowResult = {
        workflow_instance_id: instanceId,
        step_id: 'final_results',
        order_id: orderId,
        patient_id: patientId,
        lab_id: labId,
        test_group_id: testGroupId,
        test_name: testName,
        test_code: testCode,
        review_status: 'completed',
        sample_id: sampleId,
        status: 'done',
        payload: {
          orderId: orderId,
          testGroupId: testGroupId,
          patientId: patientId,
          patientName: patientName,
          testName: testName,
          sampleId: sampleId,
          labId: labId,
          testCode: testCode,
          results: {
            patient_id: patientId,
            patient_name: patientName,
            sample_id: sampleId,
            review_status: 'completed',
            ...surveyResults,
            test_name: testName || workflowDefinition?.title || workflowDefinition?.meta?.title || 'Workflow Test',
            measurements: extractMeasurements(surveyResults),
            qc_data: extractQCData(surveyResults)
          }
        }
      }

      // Submit to Supabase REST API with correct conflict resolution using column names
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/rest/v1/workflow_results?on_conflict=workflow_instance_id,step_id&select=*`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
            'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
            'Prefer': 'resolution=merge-duplicates,return=representation'
          },
          body: JSON.stringify([workflowResult])
        }
      )

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.message || 'Failed to submit workflow results')
      }

      const result = await response.json()
      console.log('Workflow submitted successfully:', result)
      
      // Also save to regular results tables for consistency
      if (orderId && labId) {
        try {
          // Create or update results entry
          const resultData = {
            order_id: orderId,
            patient_id: patientId,
            patient_name: patientName,
            test_name: testName,
            status: 'pending_verification',
            entered_by: 'Workflow System',
            entered_date: new Date().toISOString().split('T')[0],
            test_group_id: testGroupId,
            lab_id: labId,
            extracted_by_ai: true,
            workflow_instance_id: instanceId,
          };

          const { data: savedResult, error: resultError } = await supabase
            .from('results')
            .insert(resultData)
            .select()
            .single();

          if (!resultError && savedResult) {
            // Extract individual analyte values from workflow results
            const resultValues = [];
            
            // Common urine analysis parameters
            const urineParams = ['ph', 'sg', 'color', 'clarity', 'glucose', 'protein', 
                               'ketone', 'bilirubin', 'nitrite', 'leukocyte', 'urobili'];
            
            for (const param of urineParams) {
              if (surveyResults[param]) {
                resultValues.push({
                  result_id: savedResult.id,
                  analyte_name: param.toUpperCase(),
                  value: surveyResults[param],
                  unit: param === 'sg' ? '' : param === 'ph' ? '' : '',
                  reference_range: 'Normal',
                  order_id: orderId,
                  test_group_id: testGroupId,
                  lab_id: labId,
                });
              }
            }

            if (resultValues.length > 0) {
              const { error: valuesError } = await supabase
                .from('result_values')
                .insert(resultValues);

              if (valuesError) {
                console.error('Error saving result values:', valuesError);
              }
            }
          }
        } catch (additionalSaveError) {
          console.error('Error saving to regular results tables:', additionalSaveError);
          // Don't fail the whole operation if additional save fails
        }
      }
      
      // Update local state
      setCompletionData(surveyResults)
      setStatus('completed')
      
      // Notify parent component
      onComplete?.(surveyResults)
      
    } catch (error) {
      console.error('Error submitting workflow results:', error)
      setStatus('error')
      setError(error instanceof Error ? error.message : 'Failed to submit results')
    } finally {
      setIsSubmitting(false)
    }
  }, [instanceId, orderId, testGroupId, patientId, patientName, testName, sampleId, labId, testCode, onComplete, workflowDefinition])

  // Attach completion handler
  useEffect(() => {
    if (survey) {
      survey.onComplete.add(handleComplete)
      return () => survey.onComplete.remove(handleComplete)
    }
  }, [survey, handleComplete])

  if (status === 'loading') {
    return (
      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <div className="flex items-center justify-center">
          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600 mr-2"></div>
          Loading workflow...
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
            <h3 className="font-semibold">Error</h3>
            <p className="text-sm">{error}</p>
          </div>
        </div>
        <button 
          onClick={() => {
            setStatus('ready')
            setError(null)
          }}
          className="px-4 py-2 bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
        >
          Try Again
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
        
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            Your workflow has been completed and results have been saved to the database.
          </p>
          
          {completionData && (
            <div className="bg-gray-50 p-4 rounded-lg">
              <h4 className="font-semibold mb-2">Results Summary:</h4>
              <pre className="text-xs overflow-auto max-h-40">
                {JSON.stringify(completionData, null, 2)}
              </pre>
            </div>
          )}
          
          <button 
            onClick={() => {
              setStatus('ready')
              setCompletionData(null)
              survey?.clear()
            }}
            className="px-4 py-2 bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
          >
            Run Again
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="bg-white rounded-lg border border-gray-200">
      <div className="p-6 border-b border-gray-200">
        <h3 className="text-lg font-semibold">
          {workflowDefinition?.title || workflowDefinition?.meta?.title || 'Workflow'}
        </h3>
        {(workflowDefinition?.meta?.owner || workflowDefinition?.description) && (
          <p className="text-sm text-gray-600 mt-1">
            {workflowDefinition?.meta?.owner || workflowDefinition?.description}
          </p>
        )}
      </div>
      
      <div className="p-6">
        {isSubmitting && (
          <div className="mb-4 p-4 bg-blue-50 border border-blue-200 rounded-lg">
            <div className="flex items-center">
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600 mr-2"></div>
              <span className="text-sm">Submitting results to database...</span>
            </div>
          </div>
        )}
        
        {survey && <Survey model={survey} />}
      </div>
    </div>
  )
}

export default SimpleWorkflowRunner

