import { supabase } from './supabase'

export interface WorkflowDefinition {
  id: string
  name: string
  scope: string
  definition: any
  version: number
}

// Get all active workflows with their latest versions
export const getWorkflows = async (): Promise<WorkflowDefinition[]> => {
  try {
    // Since you have existing data, let's query workflow_versions directly
    // Your data shows workflow_id and definition are already there
    const { data: workflowVersions, error } = await supabase
      .from('workflow_versions')
      .select('*')
      .order('created_at', { ascending: false })

    if (error) {
      console.error('Database error:', error)
      throw error
    }

    if (!workflowVersions || workflowVersions.length === 0) {
      console.log('No workflow versions found')
      return []
    }

    // For each workflow version, get the workflow info
    const workflowsMap = new Map()
    
    for (const version of workflowVersions) {
      if (!workflowsMap.has(version.workflow_id)) {
        // Get workflow details
        const { data: workflow, error: workflowError } = await supabase
          .from('workflows')
          .select('*')
          .eq('id', version.workflow_id)
          .single()

        if (!workflowError && workflow && workflow.active) {
          try {
            // Handle both string and object definitions
            let definition = version.definition
            if (typeof definition === 'string') {
              definition = JSON.parse(definition)
            }
            
            workflowsMap.set(version.workflow_id, {
              id: workflow.id,
              name: workflow.name || definition.meta?.title || 'Unnamed Workflow',
              scope: workflow.scope || 'lab',
              definition: definition,
              version: version.version || 1
            })
          } catch (parseError) {
            console.error('Error parsing workflow definition:', parseError)
          }
        }
      }
    }

    return Array.from(workflowsMap.values())
  } catch (error) {
    console.error('Error fetching workflows:', error)
    throw error
  }
}

// Create a new workflow
export const createWorkflow = async (workflowData: {
  name: string
  scope: string
  lab_id: string
  definition: any
}) => {
  try {
    // Create workflow record
    const { data: workflow, error: workflowError } = await supabase
      .from('workflows')
      .insert({
        name: workflowData.name,
        scope: workflowData.scope,
        lab_id: workflowData.lab_id,
        active: true
      })
      .select()
      .single()

    if (workflowError) throw workflowError

    // Create initial version
    const { data: version, error: versionError } = await supabase
      .from('workflow_versions')
      .insert({
        workflow_id: workflow.id,
        version: 1,
        definition: JSON.stringify(workflowData.definition)
      })
      .select()
      .single()

    if (versionError) throw versionError

    return { workflow, version }
  } catch (error) {
    console.error('Error creating workflow:', error)
    throw error
  }
}

// Submit workflow results
export const submitWorkflowResults = async (data: {
  workflowInstanceId: string
  stepId: string
  results: Record<string, any>
  orderId?: string
  testGroupId?: string
}) => {
  try {
    const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/process-workflow-result`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`
      },
      body: JSON.stringify(data)
    })

    if (!response.ok) {
      const errorData = await response.json()
      throw new Error(errorData.error || 'Failed to submit workflow results')
    }

    return response.json()
  } catch (error) {
    console.error('Error submitting workflow results:', error)
    throw error
  }
}