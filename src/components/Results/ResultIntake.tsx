import React, { useState, useEffect } from 'react'
import { supabase } from '../../utils/supabase'

interface TestGroupResult {
  test_group_id: string
  test_group_name: string
  analytes: {
    id: string
    name: string
    code: string
    units?: string
    reference_range?: string
    normal_range_min?: number
    normal_range_max?: number
    existing_result?: {
      id: string
      value: string
      status: string
      verified_at?: string
    }
  }[]
}

interface ResultIntakeProps {
  order: {
    id: string
    lab_id: string
    patient_id: string
    patient_name: string
    test_groups: TestGroupResult[]
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

// Manual Result Entry Component
const ManualResultEntry: React.FC<{
  analytes: TestGroupResult['analytes']
  results: Record<string, string>
  onResultChange: (results: Record<string, string>) => void
}> = ({ analytes, results, onResultChange }) => {
  const updateResult = (analyteId: string, value: string) => {
    onResultChange({
      ...results,
      [analyteId]: value
    })
  }

  return (
    <div className="space-y-3">
      {analytes.map(analyte => (
        <div key={analyte.id} className="grid grid-cols-3 gap-4 items-center">
          <div>
            <span className="font-medium">{analyte.name}</span>
            <span className="text-sm text-gray-500 ml-2">({analyte.code})</span>
            {analyte.existing_result && (
              <div className="text-xs text-green-600 mt-1">
                Current: {analyte.existing_result.value}
              </div>
            )}
          </div>
          <div className="flex items-center space-x-2">
            <input
              type="text"
              value={results[analyte.id] || ''}
              onChange={(e) => updateResult(analyte.id, e.target.value)}
              placeholder="Enter value"
              className="flex-1 px-3 py-2 border rounded focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            {analyte.units && (
              <span className="text-sm text-gray-600">{analyte.units}</span>
            )}
          </div>
          <div className="text-sm text-gray-500">
            {analyte.reference_range || 
             (analyte.normal_range_min !== undefined && analyte.normal_range_max !== undefined
               ? `${analyte.normal_range_min}-${analyte.normal_range_max}${analyte.units ? ` ${analyte.units}` : ''}`
               : 'No reference range')}
          </div>
        </div>
      ))}
    </div>
  )
}

// AI Result Entry Component
const AIResultEntry: React.FC<{
  testGroupId: string
  analytes: TestGroupResult['analytes']
  orderId: string
  onResultProcessed: (resultId: string) => void
}> = ({ testGroupId, analytes, orderId, onResultProcessed }) => {
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [isProcessing, setIsProcessing] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
      const fileName = `${orderId}/${id}_${file.name}`
      const { data, error } = await supabase.storage
        .from('attachments')
        .upload(fileName, file)

      if (error) throw error

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
      setAttachments(prev => prev.filter(a => a.id !== id))
    }
  }

  const processAIResults = async () => {
    if (attachments.length === 0) {
      setError('Please upload at least one file for AI processing')
      return
    }

    setIsProcessing(true)
    setError(null)

    try {
      const workflowInstanceId = crypto.randomUUID()
      const requestBody = {
        workflowInstanceId,
        stepId: 'final_results',
        orderId,
        labId: (await supabase.auth.getUser()).data.user?.user_metadata?.lab_id,
        testGroupId,
        userId: (await supabase.auth.getUser()).data.user?.id,
        results: {
          test_group_id: testGroupId,
          analyte_ids: analytes.map(a => a.id),
          review_status: 'submitted'
        }
      }

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

      // Link attachments to workflow result
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

      if (result.status === 'ok' || result.status === 'warn') {
        onResultProcessed(result.result_id)
        setAttachments([]) // Clear attachments on success
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

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    const tagOptions = WORKFLOW_TAGS.map((t, i) => `${i+1}. ${t.label}`).join('\n')
    const selection = prompt(`Select tag for this file:\n${tagOptions}`)
    
    const tagIndex = parseInt(selection || '0') - 1
    if (tagIndex >= 0 && tagIndex < WORKFLOW_TAGS.length) {
      handleFileUpload(file, WORKFLOW_TAGS[tagIndex].value)
    }
    
    e.target.value = ''
  }

  return (
    <div className="space-y-4">
      {/* Error Display */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3">
          <div className="flex items-center text-red-800">
            <svg className="h-4 w-4 mr-2" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
            </svg>
            <span className="text-sm">{error}</span>
          </div>
        </div>
      )}

      {/* File Upload Area */}
      <div className="border-2 border-dashed border-gray-300 rounded-lg p-4">
        <input
          type="file"
          id={`file-upload-${testGroupId}`}
          className="hidden"
          accept="image/*,.pdf"
          onChange={handleFileSelect}
        />
        <label
          htmlFor={`file-upload-${testGroupId}`}
          className="flex flex-col items-center cursor-pointer"
        >
          <svg className="h-6 w-6 text-gray-400 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
          </svg>
          <span className="text-sm text-gray-600">Upload files for AI processing</span>
          <span className="text-xs text-gray-500">Images or PDFs</span>
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
                <svg className="h-4 w-4 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
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

      {/* Process Button */}
      <div className="flex justify-end">
        <button
          onClick={processAIResults}
          disabled={attachments.length === 0 || isProcessing}
          className={`px-4 py-2 rounded font-medium transition-colors ${
            attachments.length > 0 && !isProcessing
              ? 'bg-blue-600 text-white hover:bg-blue-700'
              : 'bg-gray-300 text-gray-500 cursor-not-allowed'
          }`}
        >
          {isProcessing ? 'Processing...' : 'Process with AI'}
        </button>
      </div>
    </div>
  )
}

// Test Group Result Entry Component
const TestGroupResultEntry: React.FC<{
  testGroup: TestGroupResult
  orderId: string
  entryMode: 'manual' | 'ai'
  onResultProcessed: (resultId: string) => void
}> = ({ testGroup, orderId, entryMode, onResultProcessed }) => {
  const [results, setResults] = useState<Record<string, string>>({})
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Initialize with existing results
  useEffect(() => {
    const initialResults: Record<string, string> = {}
    testGroup.analytes.forEach(analyte => {
      if (analyte.existing_result) {
        initialResults[analyte.id] = analyte.existing_result.value
      }
    })
    setResults(initialResults)
  }, [testGroup])

  const handleSubmitResults = async () => {
    const validResults = Object.entries(results).filter(([_, value]) => value.trim())
    
    if (validResults.length === 0) {
      setError('Please enter at least one result value')
      return
    }

    setIsSubmitting(true)
    setError(null)

    try {
      // Submit results using supabase directly since database object might not have this method
      const resultPromises = validResults.map(([analyteId, value]) => 
        supabase
          .from('results')
          .insert({
            order_id: orderId,
            analyte_id: analyteId,
            test_group_id: testGroup.test_group_id,
            value: value.trim(),
            status: 'pending_verification',
            created_at: new Date().toISOString()
          })
          .select()
          .single()
      )

      const savedResults = await Promise.all(resultPromises)
      
      // Check for errors
      const errors = savedResults.filter(r => r.error)
      if (errors.length > 0) {
        throw new Error(`Failed to save ${errors.length} results`)
      }

      // Notify parent component
      savedResults.forEach(result => {
        if (result.data) onResultProcessed(result.data.id)
      })

      // Clear form
      setResults({})
      
    } catch (error) {
      console.error('Error saving results:', error)
      setError(error instanceof Error ? error.message : 'Failed to save results')
    } finally {
      setIsSubmitting(false)
    }
  }

  const completedCount = testGroup.analytes.filter(a => 
    a.existing_result || results[a.id]?.trim()
  ).length

  return (
    <div className="border border-gray-200 rounded-lg p-4">
      <div className="flex items-center justify-between mb-4">
        <h4 className="text-lg font-medium">{testGroup.test_group_name}</h4>
        <div className="flex items-center space-x-3">
          <span className="text-sm text-gray-500">
            {completedCount}/{testGroup.analytes.length} completed
          </span>
          <div className="w-16 bg-gray-200 rounded-full h-2">
            <div 
              className="bg-blue-600 h-2 rounded-full transition-all"
              style={{ width: `${(completedCount / testGroup.analytes.length) * 100}%` }}
            />
          </div>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-4">
          <div className="flex items-center text-red-800">
            <svg className="h-4 w-4 mr-2" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
            </svg>
            <span className="text-sm">{error}</span>
          </div>
        </div>
      )}

      {entryMode === 'manual' ? (
        <ManualResultEntry
          analytes={testGroup.analytes}
          results={results}
          onResultChange={setResults}
        />
      ) : (
        <AIResultEntry
          testGroupId={testGroup.test_group_id}
          analytes={testGroup.analytes}
          orderId={orderId}
          onResultProcessed={onResultProcessed}
        />
      )}

      {entryMode === 'manual' && (
        <div className="mt-4 flex justify-end">
          <button
            onClick={handleSubmitResults}
            disabled={isSubmitting || Object.values(results).every(v => !v?.trim())}
            className={`px-4 py-2 rounded font-medium transition-colors ${
              !isSubmitting && Object.values(results).some(v => v?.trim())
                ? 'bg-blue-600 text-white hover:bg-blue-700'
                : 'bg-gray-300 text-gray-500 cursor-not-allowed'
            }`}
          >
            {isSubmitting ? 'Saving...' : `Save Results (${Object.values(results).filter(v => v?.trim()).length})`}
          </button>
        </div>
      )}
    </div>
  )
}

// Main ResultIntake Component
export function ResultIntake({ order, onResultProcessed }: ResultIntakeProps) {
  const [activeEntryMode, setActiveEntryMode] = useState<'manual' | 'ai'>('manual')
  const [selectedTestGroup, setSelectedTestGroup] = useState<string>()

  // Validate order structure
  if (!order.test_groups || order.test_groups.length === 0) {
    return (
      <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
        <div className="flex items-center text-yellow-800">
          <svg className="h-5 w-5 mr-2" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
          </svg>
          <div>
            <p className="font-semibold">No Test Groups Found</p>
            <p className="text-sm">This order doesn't have any test groups configured for result entry.</p>
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
            <span className="text-gray-600">Test Groups:</span>
            <span className="ml-2">{order.test_groups.length}</span>
          </div>
          <div>
            <span className="text-gray-600">Sample ID:</span>
            <span className="ml-2">{order.sample_id || 'Not collected'}</span>
          </div>
        </div>
      </div>

      {/* Entry Mode Toggle */}
      <div className="flex items-center space-x-4">
        <h3 className="text-lg font-semibold">Result Entry</h3>
        <div className="flex bg-gray-100 rounded-lg p-1">
          <button
            onClick={() => setActiveEntryMode('manual')}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
              activeEntryMode === 'manual'
                ? 'bg-white text-blue-600 shadow-sm'
                : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            Manual Entry
          </button>
          <button
            onClick={() => setActiveEntryMode('ai')}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
              activeEntryMode === 'ai'
                ? 'bg-white text-blue-600 shadow-sm'
                : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            AI Upload
          </button>
        </div>
      </div>

      {/* Test Group Selection */}
      {order.test_groups.length > 1 && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Select Test Group
          </label>
          <select
            value={selectedTestGroup || ''}
            onChange={(e) => setSelectedTestGroup(e.target.value)}
            className="w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          >
            <option value="">All Test Groups</option>
            {order.test_groups.map(tg => (
              <option key={tg.test_group_id} value={tg.test_group_id}>
                {tg.test_group_name} ({tg.analytes.length} analytes)
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Grouped Results Display */}
      <div className="space-y-6">
        {order.test_groups
          .filter(tg => !selectedTestGroup || tg.test_group_id === selectedTestGroup)
          .map(testGroup => (
            <TestGroupResultEntry
              key={testGroup.test_group_id}
              testGroup={testGroup}
              orderId={order.id}
              entryMode={activeEntryMode}
              onResultProcessed={onResultProcessed || (() => {})}
            />
          ))}
      </div>
    </div>
  )
}
