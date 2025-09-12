import React, { useState, useEffect } from 'react'
import { supabase } from '../../utils/supabase'

interface ResultAuditProps {
  orderId: string
  workflowResultId?: string
}

interface TaskRun {
  id: string
  task_name: string
  status: string
  error?: string
  created_at: string
}

interface AiRun {
  id: string
  kind: string
  model: string
  ok: boolean
  duration_ms: number
  created_at: string
  response?: any
}

interface AiIssue {
  id: string
  severity: string
  field?: string
  code?: string
  message: string
  suggestion?: string
  created_at: string
}

export function ResultAudit({ orderId, workflowResultId }: ResultAuditProps) {
  const [taskRuns, setTaskRuns] = useState<TaskRun[]>([])
  const [aiRuns, setAiRuns] = useState<AiRun[]>([])
  const [aiIssues, setAiIssues] = useState<AiIssue[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const loadAuditData = async () => {
      try {
        setLoading(true)

        // Load task runs - check both workflow_result_id and order context
        const { data: tasks } = await supabase
          .from('task_runs')
          .select('*')
          .or(workflowResultId ? `workflow_result_id.eq.${workflowResultId}` : `order_id.eq.${orderId}`)
          .order('created_at', { ascending: false })
          .limit(10)

        // Load AI runs
        const { data: ai } = await supabase
          .from('ai_runs')
          .select('*')
          .or(workflowResultId ? `workflow_result_id.eq.${workflowResultId}` : `order_id.eq.${orderId}`)
          .order('created_at', { ascending: false })
          .limit(10)

        // Load AI issues (only if we have a workflow result ID)
        let issues: AiIssue[] = []
        if (workflowResultId) {
          const { data: issueData } = await supabase
            .from('ai_issues')
            .select('*')
            .eq('workflow_result_id', workflowResultId)
            .order('created_at', { ascending: false })
          
          issues = issueData || []
        }

        setTaskRuns(tasks || [])
        setAiRuns(ai || [])
        setAiIssues(issues)
      } catch (err) {
        console.error('Error loading audit data:', err)
      } finally {
        setLoading(false)
      }
    }

    if (orderId || workflowResultId) {
      loadAuditData()
    }
  }, [orderId, workflowResultId])

  const getSeverityIcon = (severity: string) => {
    switch (severity) {
      case 'error':
        return (
          <svg className="h-4 w-4 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        )
      case 'warning':
        return (
          <svg className="h-4 w-4 text-yellow-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
          </svg>
        )
      default:
        return (
          <svg className="h-4 w-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        )
    }
  }

  const getStatusBadge = (status: string) => {
    const baseClasses = "px-2 py-1 rounded text-xs font-medium"
    switch (status) {
      case 'completed':
        return `${baseClasses} bg-green-100 text-green-700`
      case 'failed':
        return `${baseClasses} bg-red-100 text-red-700`
      case 'running':
        return `${baseClasses} bg-blue-100 text-blue-700`
      default:
        return `${baseClasses} bg-gray-100 text-gray-700`
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600"></div>
        <span className="ml-2 text-gray-600">Loading audit data...</span>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Task Runs */}
      <div>
        <h3 className="font-semibold mb-3 flex items-center">
          <svg className="h-5 w-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 100 4m0-4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 100 4m0-4v2m0-6V4" />
          </svg>
          Task Runs
        </h3>
        {taskRuns.length === 0 ? (
          <p className="text-gray-500 text-sm">No task runs found</p>
        ) : (
          <div className="space-y-2">
            {taskRuns.map(run => (
              <div key={run.id} className="bg-gray-50 p-3 rounded-lg">
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-2">
                    <svg className="h-4 w-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <span className="font-medium text-sm">{run.task_name}</span>
                    <span className={getStatusBadge(run.status)}>
                      {run.status}
                    </span>
                  </div>
                  <span className="text-xs text-gray-500">
                    {new Date(run.created_at).toLocaleString()}
                  </span>
                </div>
                {run.error && (
                  <p className="text-red-600 text-xs mt-2 ml-6">{run.error}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* AI Runs */}
      <div>
        <h3 className="font-semibold mb-3 flex items-center">
          <svg className="h-5 w-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
          </svg>
          AI Processing
        </h3>
        {aiRuns.length === 0 ? (
          <p className="text-gray-500 text-sm">No AI runs found</p>
        ) : (
          <div className="space-y-2">
            {aiRuns.map(run => (
              <div key={run.id} className="bg-gray-50 p-3 rounded-lg">
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-2">
                    <span className="font-medium text-sm">{run.kind}</span>
                    <span className="text-xs text-gray-500">({run.model})</span>
                    <span className={getStatusBadge(run.ok ? 'completed' : 'failed')}>
                      {run.ok ? 'Success' : 'Failed'}
                    </span>
                    <span className="text-xs text-gray-500">
                      {run.duration_ms}ms
                    </span>
                  </div>
                  <span className="text-xs text-gray-500">
                    {new Date(run.created_at).toLocaleString()}
                  </span>
                </div>
                {run.response && (
                  <details className="mt-2">
                    <summary className="text-xs text-blue-600 cursor-pointer">View Response</summary>
                    <pre className="text-xs mt-2 overflow-auto max-h-32 bg-white p-2 rounded border">
                      {JSON.stringify(run.response, null, 2)}
                    </pre>
                  </details>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* AI Issues */}
      <div>
        <h3 className="font-semibold mb-3 flex items-center">
          <svg className="h-5 w-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
          </svg>
          Issues & Warnings
        </h3>
        {aiIssues.length === 0 ? (
          <div className="flex items-center text-green-600 text-sm">
            <svg className="h-4 w-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            No issues found
          </div>
        ) : (
          <div className="space-y-2">
            {/* Group issues by severity */}
            {['error', 'warning', 'info'].map(severity => {
              const severityIssues = aiIssues.filter(issue => issue.severity === severity)
              if (severityIssues.length === 0) return null

              return (
                <div key={severity}>
                  <h4 className="text-sm font-medium text-gray-700 mb-2 capitalize">
                    {severity}s ({severityIssues.length})
                  </h4>
                  {severityIssues.map(issue => (
                    <div key={issue.id} className="bg-gray-50 p-3 rounded-lg">
                      <div className="flex items-start space-x-2">
                        {getSeverityIcon(issue.severity)}
                        <div className="flex-1">
                          <div className="flex items-center space-x-2">
                            <p className="text-sm font-medium">{issue.code || 'Validation Issue'}</p>
                            {issue.field && (
                              <span className="text-xs bg-gray-200 px-2 py-1 rounded">
                                Field: {issue.field}
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-gray-600 mt-1">{issue.message}</p>
                          {issue.suggestion && (
                            <p className="text-xs text-blue-600 mt-1">
                              💡 {issue.suggestion}
                            </p>
                          )}
                          <span className="text-xs text-gray-400">
                            {new Date(issue.created_at).toLocaleString()}
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Summary */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <h4 className="font-medium text-blue-800 mb-2">Processing Summary</h4>
        <div className="grid grid-cols-3 gap-4 text-sm">
          <div>
            <span className="text-blue-600">Tasks:</span>
            <span className="ml-2 font-medium">{taskRuns.length}</span>
          </div>
          <div>
            <span className="text-blue-600">AI Runs:</span>
            <span className="ml-2 font-medium">{aiRuns.length}</span>
          </div>
          <div>
            <span className="text-blue-600">Issues:</span>
            <span className="ml-2 font-medium">{aiIssues.length}</span>
          </div>
        </div>
      </div>
    </div>
  )
}