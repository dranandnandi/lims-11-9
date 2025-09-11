import { supabase } from './supabase';
import type { 
  WorkflowDefinition, 
  WorkflowInstance, 
  WorkflowEvent, 
  ValidationState,
  ResolveRequest,
  ResolveResponse 
} from '../types/workflow';

export class WorkflowAPI {
  private static baseUrl = '/api/workflow';

  /**
   * Resolve workflow for given test group/analyte
   */
  static async resolveWorkflow(request: ResolveRequest): Promise<ResolveResponse | null> {
    try {
      // Call the resolver function via Supabase RPC
      const { data, error } = await supabase.rpc('resolve_workflow_version_id', {
        p_lab_id: request.labId,
        p_test_group_id: request.testGroupId || null,
        p_analyte_id: request.analyteId || null,
        p_context: request.context || {}
      });

      if (error) {
        console.error('Error resolving workflow:', error);
        return null;
      }

      if (!data) {
        return null; // No workflow found
      }

      // Fetch the workflow definition
      const { data: workflowVersion, error: versionError } = await supabase
        .from('workflow_versions')
        .select('*')
        .eq('id', data)
        .single();

      if (versionError || !workflowVersion) {
        console.error('Error fetching workflow version:', versionError);
        return null;
      }

      return {
        workflowVersionId: data,
        definition: workflowVersion.definition as WorkflowDefinition
      };
    } catch (error) {
      console.error('Failed to resolve workflow:', error);
      return null;
    }
  }

  /**
   * Start a new workflow instance
   */
  static async startWorkflow(orderId: string, workflowVersionId: string): Promise<string | null> {
    try {
      const { data, error } = await supabase
        .from('order_workflow_instances')
        .insert({
          order_id: orderId,
          workflow_version_id: workflowVersionId,
          status: 'IN_PROGRESS',
          started_at: new Date().toISOString(),
          current_step: 1,
          step_data: {}
        })
        .select('id')
        .single();

      if (error) {
        console.error('Error starting workflow:', error);
        return null;
      }

      // Log start event
      await this.logEvent({
        instanceId: data.id,
        stepId: 1,
        eventType: 'START',
        payload: {
          data: { orderId, workflowVersionId },
          metadata: {
            timestamp: new Date().toISOString()
          }
        }
      });

      return data.id;
    } catch (error) {
      console.error('Failed to start workflow:', error);
      return null;
    }
  }

  /**
   * Validate a workflow step
   */
  static async validateStep(
    workflowVersionId: string, 
    stepNo: number, 
    inputs: any
  ): Promise<ValidationState> {
    try {
      // Fetch workflow definition
      const { data: workflow, error } = await supabase
        .from('workflow_versions')
        .select('definition')
        .eq('id', workflowVersionId)
        .single();

      if (error || !workflow) {
        return { ok: false, messages: ['Workflow not found'] };
      }

      const definition = workflow.definition as WorkflowDefinition;
      const step = definition.rules.steps.find(s => s.no === stepNo);

      if (!step) {
        return { ok: false, messages: ['Step not found'] };
      }

      // Perform validation based on step type
      const validationResult = await this.performStepValidation(step, inputs, definition);
      
      return validationResult;
    } catch (error) {
      console.error('Validation failed:', error);
      return { ok: false, messages: ['Validation failed'] };
    }
  }

  /**
   * Log workflow event
   */
  static async logEvent(event: WorkflowEvent): Promise<boolean> {
    try {
      const { error } = await supabase
        .from('workflow_step_events')
        .insert({
          instance_id: event.instanceId,
          step_id: event.stepId,
          event_type: event.eventType,
          event_data: event.payload,
          created_at: new Date().toISOString()
        });

      if (error) {
        console.error('Error logging event:', error);
        return false;
      }

      return true;
    } catch (error) {
      console.error('Failed to log event:', error);
      return false;
    }
  }

  /**
   * Complete workflow instance
   */
  static async completeWorkflow(instanceId: string, surveyResult: any): Promise<boolean> {
    try {
      const { error } = await supabase
        .from('order_workflow_instances')
        .update({
          status: 'COMPLETED',
          completed_at: new Date().toISOString(),
          step_data: surveyResult
        })
        .eq('id', instanceId);

      if (error) {
        console.error('Error completing workflow:', error);
        return false;
      }

      // Log completion event
      await this.logEvent({
        instanceId,
        stepId: -1, // Special step for completion
        eventType: 'COMPLETE',
        payload: {
          data: surveyResult,
          metadata: {
            timestamp: new Date().toISOString()
          }
        }
      });

      return true;
    } catch (error) {
      console.error('Failed to complete workflow:', error);
      return false;
    }
  }

  /**
   * Get workflow instance
   */
  static async getWorkflowInstance(instanceId: string): Promise<WorkflowInstance | null> {
    try {
      const { data, error } = await supabase
        .from('order_workflow_instances')
        .select(`
          *,
          workflow_versions (
            id,
            name,
            definition
          )
        `)
        .eq('id', instanceId)
        .single();

      if (error || !data) {
        console.error('Error fetching workflow instance:', error);
        return null;
      }

      return {
        id: data.id,
        orderId: data.order_id,
        workflowVersionId: data.workflow_version_id,
        definition: data.workflow_versions.definition as WorkflowDefinition,
        status: data.status,
        startedAt: data.started_at,
        completedAt: data.completed_at,
        currentStep: data.current_step,
        data: data.step_data
      };
    } catch (error) {
      console.error('Failed to get workflow instance:', error);
      return null;
    }
  }

  /**
   * Perform step-specific validation
   */
  private static async performStepValidation(
    step: any, 
    inputs: any, 
    definition: WorkflowDefinition
  ): Promise<ValidationState> {
    const messages: string[] = [];
    let isValid = true;

    // Basic required field validation
    if (step.required && !inputs[step.name]) {
      isValid = false;
      messages.push(`${step.title || step.name} is required`);
    }

    // Step-type specific validation
    switch (step.type) {
      case 'pipette':
        const pipetteResult = this.validatePipetteStep(step, inputs, definition);
        if (!pipetteResult.ok) {
          isValid = false;
          messages.push(...pipetteResult.messages);
        }
        break;

      case 'qc':
        const qcResult = this.validateQCStep(step, inputs);
        if (!qcResult.ok) {
          isValid = false;
          messages.push(...qcResult.messages);
        }
        break;

      case 'data_entry':
        const dataResult = this.validateDataEntry(step, inputs);
        if (!dataResult.ok) {
          isValid = false;
          messages.push(...dataResult.messages);
        }
        break;
    }

    return {
      ok: isValid,
      messages: isValid ? ['Validation passed'] : messages
    };
  }

  private static validatePipetteStep(step: any, inputs: any, definition: WorkflowDefinition): ValidationState {
    const { target_volume_ul, tolerance_pct = 5 } = step;
    const { actual_volume_ul, pipette_id } = inputs;

    if (!actual_volume_ul) {
      return { ok: false, messages: ['Actual volume is required'] };
    }

    if (!pipette_id) {
      return { ok: false, messages: ['Pipette ID is required'] };
    }

    // Check if pipette is allowed
    const pipette = definition.rules.validations?.pipettes?.[pipette_id];
    if (!pipette) {
      return { ok: false, messages: ['Invalid pipette ID'] };
    }

    // Check volume range
    if (actual_volume_ul < pipette.min_ul || actual_volume_ul > pipette.max_ul) {
      return { 
        ok: false, 
        messages: [`Volume ${actual_volume_ul}μL is outside pipette range (${pipette.min_ul}-${pipette.max_ul}μL)`] 
      };
    }

    // Check tolerance
    const tolerance = (tolerance_pct / 100) * target_volume_ul;
    const minVolume = target_volume_ul - tolerance;
    const maxVolume = target_volume_ul + tolerance;

    if (actual_volume_ul < minVolume || actual_volume_ul > maxVolume) {
      return { 
        ok: false, 
        messages: [`Volume ${actual_volume_ul}μL is outside tolerance range (${minVolume.toFixed(1)}-${maxVolume.toFixed(1)}μL)`] 
      };
    }

    return { ok: true, messages: ['Pipette validation passed'] };
  }

  private static validateQCStep(step: any, inputs: any): ValidationState {
    // Implement QC-specific validation
    return { ok: true, messages: ['QC validation passed'] };
  }

  private static validateDataEntry(step: any, inputs: any): ValidationState {
    // Implement data entry validation
    return { ok: true, messages: ['Data entry validation passed'] };
  }
}