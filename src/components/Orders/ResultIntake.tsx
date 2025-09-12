import React, { useState, useEffect } from 'react'
import { supabase } from '../../utils/supabase'

interface ResultIntakeProps {
  order: {
    id: string
    lab_id: string
    test_group_id?: string
    test_code?: string
    patient_id: string
    patient_name: string
    sample_id?: string
    status: string
  }
  onResultProcessed?: (resultId: string) => void
}

interface Attachment {
  id: string
  file: File
  tag: string
  uploaded: boolean
  url?: string
}

const WORKFLOW_TAGS = [
  { value: 'dipstick_photo', label: 'Dipstick Photo' },
  { value: 'microscopy_slide', label: 'Microscopy Slide' },
  { value: 'report_pdf', label: 'Report PDF' },
  { value: 'analyzer_output', label: 'Analyzer Output' },
  { value: 'manual_entry', label: 'Manual Entry' }
]

export function ResultIntake({ order, onResultProcessed }: ResultIntakeProps) {
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [isProcessing, setIsProcessing] = useState(false)
  const [workflowConfig, setWorkflowConfig] = useState<any>(null)
  const [workflowInstanceId] = useState(() => crypto.randomUUID())
  const [manualResults, setManualResults] = useState<Record<string, any>>({})
  const [error, setError] = useState<string | null>(null)

  // Check if we can process results
  const canProcess = () => {
    // Must have order ID
    if (!order.id) return false
    
    // Must have either test_group_id or test_code
    if (!order.test_group_id && !order.test_code) return false
    
    // Must have patient info
    if (!order.patient_id || !order.patient_name) return false
    
    // Must have sample_id if workflow requires it
    if (workflowConfig?.requires_sample && !order.sample_id) return false
    
    // Must have at least one attachment if workflow requires it
    if (workflowConfig?.requires_attachments && attachments.length === 0) return false
    
    return true
  }

  // Load workflow configuration
  useEffect(() => {
    const loadWorkflowConfig = async () => {
      try {
        // Check if workflow exists for this test
        const { data, error } = await supabase
          .from('test_workflow_map')
          .select(`
            workflow_versions!inner(
              id,
              workflow_ai_configs(*)
            )
          `)
          .or(`test_group_id.eq.${order.test_group_id},test_code.eq.${order.test_code}`)
          .eq('is_default', true)
          .single()

        if (error || !data) {
          console.warn('No workflow configuration found')
          setWorkflowConfig(null)
          return
        }

        const config = (data.workflow_versions as any)?.workflow_ai_configs?.[0] || {}
        setWorkflowConfig({
          ...config,
          requires_sample: config.required_fields?.includes('sample_id'),
          requires_attachments: config.required_fields?.includes('attachments'),
          allow_manual_entry: config.allow_manual_entry || false
        })
      } catch (err) {
        console.error('Error loading workflow config:', err)
        setWorkflowConfig(null)
      }
    }

    if (order.test_group_id || order.test_code) {
      loadWorkflowConfig()
    }
  }, [order.test_group_id, order.test_code])

  // Handle file upload
  const handleFileUpload = async (file: File, tag: string) => {
    const id = crypto.randomUUID()
    const newAttachment: Attachment = {
      id,
      file,
      tag,
      uploaded: false
    }
    
    setAttachments(prev => [...prev, newAttachment])

    try {
      // Upload to storage
      const fileName = `${order.id}/${id}_${file.name}`
      const { data, error } = await supabase.storage
        .from('attachments')
        .upload(fileName, file)

      if (error) throw error

      // Update attachment status
      setAttachments(prev => 
        prev.map(a => 
          a.id === id 
            ? { ...a, uploaded: true, url: data.path }
            : a
        )
      )
    } catch (err) {
      console.error('Upload error:', err)
      setError('Failed to upload file. Please try again.')
      
      // Remove failed upload
      setAttachments(prev => prev.filter(a => a.id !== id))
    }
  }

  // Process workflow results
  const processResults = async () => {
    if (!canProcess()) {
      setError('Please ensure all required fields are filled')
      return
    }

    setIsProcessing(true)
    setError(null)

    try {
      // Build exact request body as specified in requirements
      const requestBody = {
        workflowInstanceId,
        stepId: 'final_results',
        orderId: order.id,
        labId: order.lab_id,
        testGroupId: order.test_group_id || null,
        testCode: order.test_code || null,
        userId: (await supabase.auth.getUser()).data.user?.id,
        results: {
          patient_id: order.patient_id,
          patient_name: order.patient_name,
          sample_id: order.sample_id || null,
          review_status: 'submitted',
          ...manualResults
        }
      }

      // Call edge function
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/process-workflow-result`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${(await supabase.auth.getSession()).data.session?.access_token}`
          },
          body: JSON.stringify(requestBody)
        }
      )

      const result = await response.json()

      if (!response.ok) {
        throw new Error(result.error || 'Processing failed')
      }

      // Link attachments to workflow result after processing
      if (result.workflow_result_id && attachments.length > 0) {
        for (const attachment of attachments) {
          if (attachment.uploaded) {
            await supabase
              .from('attachments')
              .insert({
                related_table: 'workflow_results',
                related_id: result.workflow_result_id,
                file_path: attachment.url,
                tag: attachment.tag,
                file_name: attachment.file.name,
                file_type: attachment.file.type,
                file_size: attachment.file.size
              })
          }
        }
      }

      // Handle response based on status
      if (result.status === 'ok') {
        onResultProcessed?.(result.result_id)
      } else if (result.status === 'warn') {
        // Fetch and display issues
        if (result.workflow_result_id) {
          const { data: issues } = await supabase
            .from('ai_issues')
            .select('*')
            .eq('workflow_result_id', result.workflow_result_id)
          
          if (issues && issues.length > 0) {
            const warningMessages = issues
              .filter(i => i.severity === 'warning')
              .map(i => i.message)
              .join(', ')
            
            setError(`Processed with warnings: ${warningMessages}`)
          }
        }
        onResultProcessed?.(result.result_id)
      } else {
        throw new Error('Processing failed with errors')
      }

    } catch (err) {
      console.error('Processing error:', err)
      setError(err instanceof Error ? err.message : 'Failed to process results')
    } finally {
      setIsProcessing(false)
    }
  }

  // Handle file selection
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    // Simple tag selection for demo - in production, use a proper selector
    const tagOptions = WORKFLOW_TAGS.map((t, i) => `${i+1}. ${t.label}`).join('\n')
    const selection = prompt(`Select tag for this file:\n${tagOptions}`)
    
    const tagIndex = parseInt(selection || '0') - 1
    if (tagIndex >= 0 && tagIndex < WORKFLOW_TAGS.length) {
      handleFileUpload(file, WORKFLOW_TAGS[tagIndex].value)
    }
    
    // Reset input
    e.target.value = ''
  }

  // No workflow configuration
  if (workflowConfig === null && (order.test_group_id || order.test_code)) {
    return (
      <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
        <div className="flex items-center text-yellow-800">
          <svg className="h-5 w-5 mr-2" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
          </svg>
          <div>
            <p className="font-semibold">No Workflow Configuration</p>
            <p className="text-sm">No active workflow configured for this test. Please contact admin.</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Order Information */}
      <div className="bg-gray-50 rounded-lg p-4">
        <h3 className="font-semibold mb-3">Order Information</h3>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <span className="text-gray-600">Order ID:</span>
            <span className="ml-2 font-mono">{order.id.slice(0, 8)}</span>
          </div>
          <div>
            <span className="text-gray-600">Patient:</span>
            <span className="ml-2">{order.patient_name}</span>
          </div>
          <div>
            <span className="text-gray-600">Test:</span>
            <span className="ml-2">{order.test_code || `Group: ${order.test_group_id?.slice(0, 8)}`}</span>
          </div>
          <div>
            <span className="text-gray-600">Sample ID:</span>
            <span className="ml-2">{order.sample_id || 'Not collected'}</span>
          </div>
        </div>
      </div>

      {/* Error Display */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <div className="flex items-center text-red-800">
            <svg className="h-5 w-5 mr-2" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
            </svg>
            <span className="text-sm">{error}</span>
          </div>
        </div>
      )}

      {/* File Upload Section */}
      <div className="space-y-3">
        <h3 className="font-semibold">Attachments</h3>
        
        {/* Upload Area */}
        <div className="border-2 border-dashed border-gray-300 rounded-lg p-4">
          <input
            type="file"
            id="file-upload"
            className="hidden"
            accept="image/*,.pdf"
            onChange={handleFileSelect}
          />
          <label
            htmlFor="file-upload"
            className="flex flex-col items-center cursor-pointer"
          >
            <svg className="h-8 w-8 text-gray-400 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
            </svg>
            <span className="text-sm text-gray-600">Click to upload files</span>
            <span className="text-xs text-gray-500 mt-1">Images or PDFs</span>
          </label>
        </div>

        {/* Uploaded Files */}
        {attachments.length > 0 && (
          <div className="space-y-2">
            {attachments.map(attachment => (
              <div
                key={attachment.id}
                className="flex items-center justify-between bg-gray-50 p-2 rounded"
              >
                <div className="flex items-center space-x-2">
                  {attachment.file.type.includes('image') ? (
                    <svg className="h-4 w-4 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                    </svg>
                  ) : (
                    <svg className="h-4 w-4 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                  )}
                  <span className="text-sm">{attachment.file.name}</span>
                  <span className="text-xs bg-gray-200 px-2 py-1 rounded">
                    {WORKFLOW_TAGS.find(t => t.value === attachment.tag)?.label}
                  </span>
                </div>
                {attachment.uploaded ? (
                  <svg className="h-4 w-4 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600"></div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Manual Entry Section */}
      {workflowConfig?.allow_manual_entry && (
        <div className="space-y-3">
          <h3 className="font-semibold">Manual Entry</h3>
          <div className="grid grid-cols-2 gap-3">
            <input
              type="text"
              placeholder="pH"
              className="px-3 py-2 border rounded focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              onChange={(e) => setManualResults(prev => ({ ...prev, ph: e.target.value }))}
            />
            <input
              type="text"
              placeholder="Specific Gravity"
              className="px-3 py-2 border rounded focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              onChange={(e) => setManualResults(prev => ({ ...prev, specific_gravity: e.target.value }))}
            />
          </div>
        </div>
      )}

      {/* Validation Messages and Process Button */}
      <div className="flex items-center justify-between pt-4 border-t">
        <div className="text-sm text-gray-600">
          {!order.sample_id && workflowConfig?.requires_sample && (
            <p className="text-red-600">⚠️ Add Sample ID before processing</p>
          )}
          {workflowConfig?.requires_attachments && attachments.length === 0 && (
            <p className="text-red-600">⚠️ Upload at least one attachment</p>
          )}
          {!order.patient_id && (
            <p className="text-red-600">⚠️ Patient information required</p>
          )}
        </div>
        
        <button
          onClick={processResults}
          disabled={!canProcess() || isProcessing}
          className={`px-4 py-2 rounded font-medium transition-colors ${
            canProcess() && !isProcessing
              ? 'bg-blue-600 text-white hover:bg-blue-700'
              : 'bg-gray-300 text-gray-500 cursor-not-allowed'
          }`}
        >
          {isProcessing ? (
            <span className="flex items-center">
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
              Processing...
            </span>
          ) : (
            'Process Result'
          )}
        </button>
      </div>
    </div>
  )
}