// Workflow and Survey.js Type Definitions
export interface WorkflowDefinition {
  ui: {
    engine: "surveyjs" | "custom";
    template: any; // SurveyJS JSON
    theme?: string;
    localization?: Record<string, any>;
  };
  rules: {
    mode: "BASIC" | "PRO" | "HYBRID";
    triggerOn?: "ORDER_CREATE" | "SAMPLE_COLLECT" | "RESULT_ENTRY" | "MANUAL";
    steps: Array<{
      no: number;
      type: "pipette" | "dilution" | "qc" | "data_entry" | "approval";
      required: boolean;
      validation?: any;
      permissions?: string[];
    }>;
    validations?: {
      pipettes?: Record<string, PipetteConfig>;
      calculations?: Array<CalculationRule>;
      businessRules?: Array<BusinessRule>;
    };
  };
  meta: {
    title: string;
    description?: string;
    owner: string;
    tags?: string[];
    version: string;
    createdAt: string;
    updatedAt: string;
  };
  hooks?: {
    onStart?: string;
    onComplete?: string;
    onValidate?: string;
  };
}

export interface PipetteConfig {
  model: string;
  min_ul: number;
  max_ul: number;
  tolerance_pct?: number;
}

export interface CalculationRule {
  field: string;
  formula: string;
  validation?: any;
}

export interface BusinessRule {
  condition: string;
  action: string;
  message?: string;
}

export interface WorkflowInstance {
  id: string;
  orderId: string;
  workflowVersionId: string;
  definition: WorkflowDefinition;
  status: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "FAILED";
  startedAt?: string;
  completedAt?: string;
  currentStep?: number;
  data?: any;
}

export interface ValidationState {
  ok: boolean;
  messages: string[];
  errors?: ValidationError[];
}

export interface ValidationError {
  field: string;
  message: string;
  code?: string;
}

export interface WorkflowEvent {
  instanceId: string;
  stepId: number;
  eventType: "START" | "VALIDATE" | "COMPLETE" | "SKIP" | "FAIL" | "PAUSE" | "NEXT";
  payload: {
    data?: any;
    errors?: ValidationError[];
    metadata?: {
      deviceId?: string;
      location?: string;
      timestamp: string;
      previousStep?: number;
      newStep?: number;
      [key: string]: any; // Allow additional metadata
    };
  };
}

export interface ResolveRequest {
  labId: string;
  testGroupId?: string;
  analyteId?: string;
  context?: {
    orderType?: string;
    patientAge?: number;
    urgency?: "routine" | "urgent" | "stat";
    department?: string;
  };
}

export interface ResolveResponse {
  workflowVersionId: string;
  definition: WorkflowDefinition;
  instanceId?: string;
  resumeData?: any;
}