Goal

Run per-test-group and per-analyte procedural flows (Basic/Pro) using SurveyJS.

No new tables. Only touch existing workflow_* tables (plus small additions to test_workflow_map you asked for).

A) Database changes (workflow tables only)
1) test_workflow_map – add finer targets

Add analyte & test-group linkage so a flow can be chosen at the group or analyte level (legacy test_code still works).

-- Add targets (nullable)
ALTER TABLE public.test_workflow_map
  ADD COLUMN IF NOT EXISTS test_group_id uuid,
  ADD COLUMN IF NOT EXISTS analyte_id uuid;

-- FKs
ALTER TABLE public.test_workflow_map
  ADD CONSTRAINT IF NOT EXISTS test_workflow_map_test_group_id_fkey
  FOREIGN KEY (test_group_id) REFERENCES public.test_groups(id) ON DELETE CASCADE;

ALTER TABLE public.test_workflow_map
  ADD CONSTRAINT IF NOT EXISTS test_workflow_map_analyte_id_fkey
  FOREIGN KEY (analyte_id) REFERENCES public.analytes(id) ON DELETE CASCADE;

-- Ensure at least one target present
ALTER TABLE public.test_workflow_map
  DROP CONSTRAINT IF EXISTS chk_twm_target_present;
ALTER TABLE public.test_workflow_map
  ADD CONSTRAINT chk_twm_target_present
  CHECK (analyte_id IS NOT NULL OR test_group_id IS NOT NULL OR test_code IS NOT NULL);

-- Lookups & "one default" per scope
CREATE INDEX IF NOT EXISTS idx_twm_group_lookup   ON public.test_workflow_map (lab_id, test_group_id);
CREATE INDEX IF NOT EXISTS idx_twm_analyte_lookup ON public.test_workflow_map (lab_id, analyte_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_twm_default_by_group
ON public.test_workflow_map (lab_id, test_group_id)
WHERE is_default = true AND test_group_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_twm_default_by_analyte
ON public.test_workflow_map (lab_id, analyte_id)
WHERE is_default = true AND analyte_id IS NOT NULL;


Backfill (once): set test_group_id on existing rows by joining test_code → test_groups.code (you already have this), then gradually phase out test_code.

2) workflow_versions – store SurveyJS + rules in JSON (no DDL needed)

Use workflow_versions.definition (jsonb) to store:

The SurveyJS template (UI).

The validation rules (server uses them).

Optional UI hints (labels, help text) and role flags.

Recommended JSON shape

{
  "ui": {
    "engine": "surveyjs",
    "template": { /* SurveyJS JSON: pages, elements, triggers */ }
  },
  "rules": {
    "mode": "PRO",                       // or BASIC
    "steps": [
      { "no": 1, "target_volume_ul": 120, "tolerance_pct": 5,
        "allowed_pipettes": ["P200"] }
    ],
    "pipettes": {
      "QR-P200-017": { "model": "P200", "min_ul": 20, "max_ul": 200 }
    }
  },
  "meta": { "title": "CBC – Pipette Check v1", "owner": "Lab QA" }
}

3) Resolver function (precedence)

Choose the right workflow_version_id per (lab, test_group, analyte).

CREATE OR REPLACE FUNCTION public.resolve_workflow_version_id(
  p_lab_id uuid, p_test_group_id uuid, p_analyte_id uuid
) RETURNS uuid
LANGUAGE sql STABLE AS $$
  WITH pick AS (
    -- 1) analyte-level default
    SELECT workflow_version_id, 1 AS pr
    FROM public.test_workflow_map
    WHERE lab_id = p_lab_id AND analyte_id = p_analyte_id AND is_default = true

    UNION ALL
    -- 2) group-level default
    SELECT workflow_version_id, 2
    FROM public.test_workflow_map
    WHERE lab_id = p_lab_id AND test_group_id = p_test_group_id AND is_default = true

    UNION ALL
    -- 3) legacy by code (optional)
    SELECT m.workflow_version_id, 3
    FROM public.test_workflow_map m
    JOIN public.test_groups g ON g.id = p_test_group_id
    WHERE m.lab_id = p_lab_id AND m.test_code = g.code AND m.is_default = true
  )
  SELECT workflow_version_id FROM pick ORDER BY pr LIMIT 1;
$$;


No schema changes needed for order_workflow_instances and workflow_step_events. We’ll just use them.

B) Server endpoints (Edge/Netlify)

All keys live server-side. These are small, fast functions.

GET /flow/resolve
Query: labId, testGroupId, analyteId
Return: { workflowVersionId, definition } (the JSON above).

Internally calls resolve_workflow_version_id(...).

If null, return 404 (UI can fall back to Basic default).

POST /event (audit everything)
Body: { instanceId, stepId, eventType, payload }

Inserts row into workflow_step_events.

POST /validate-step
Body: { workflowVersionId, stepNo, inputs }

Loads workflow_versions.definition->rules.

Validates pipette/volume/dilution, etc.

Returns { ok, messages }. Also logs an event (VALIDATE_OK/VALIDATE_FAIL).

POST /start
Body: { orderId, workflowVersionId }

Creates order_workflow_instances (if not present). Returns instanceId.

POST /complete
Body: { instanceId, surveyResult }

Sets completed_at in order_workflow_instances.

Writes one 'COMPLETE' event with the full surveyResult JSON (this is the artifact you’ll reuse later).

You can combine (2) & (3) if you prefer a single /event that sometimes validates.

C) UI implementation (React/Capacitor + SurveyJS)
1) Resolve & load

At run time (for each order / test group / analyte):

Call /flow/resolve → get { workflowVersionId, definition }.

If none, show Basic form (minimal checks).

If found and definition.ui.engine === 'surveyjs':

Construct new Survey.Model(definition.ui.template).

2) Provide runtime variables

Before rendering:

survey.setVariable("orderId", orderId);
survey.setVariable("testGroupId", testGroupId);
survey.setVariable("analyteId", analyteId);
survey.setVariable("instanceId", instanceId);


You can show hints using these variables inside SurveyJS.

3) Wire validations (non-blocking UX)

onValueChanged (debounced 300–500 ms): call /validate-step with { workflowVersionId, stepNo, inputs }.

Set a hidden field like __validate_result with the response; use an Expression question to show ✅/❌ and messages.

Disable Next/Complete until __validate_result.ok === true.

Example (client):

survey.onValueChanged.add(async (_, opt) => {
  if (!shouldValidate(opt.question?.name)) return;
  const res = await post('/validate-step', { workflowVersionId, stepNo: currentStep, inputs: survey.data });
  survey.setValue('__validate_result', res);
  await post('/event', { instanceId, stepId: currentStep, eventType: res.ok ? 'VALIDATE_OK' : 'VALIDATE_FAIL', payload: res });
});

4) Audit trail

onCurrentPageChanged → POST /event with eventType: 'NEXT', payload: current page data.

onUploadFiles (if you allow photos/QR) → upload to Supabase Storage; reference the URL in the event payload (or store via attachments separately if you want—no schema change needed).

onComplete → POST /complete with full survey.data.

5) Multi-analyte orchestration

For a test group with multiple analytes:

Resolve for each analyte; deduplicate by workflowVersionId.

If a group-level flow exists and analyte flows are identical → run once.

If some analytes map to different flows → run group flow first (common steps), then analyte-specific subflows (only for those analytes).

D) Basic vs Pro (both supported)

BASIC: a tiny SurveyJS template (single page) or even plain form; still logs to workflow_step_events and writes one 'COMPLETE' with the JSON.

PRO: full SurveyJS with step-wise interlocks, validations, and device scans.

Distinguish via definition.rules.mode or by mapping different workflow_version_ids in test_workflow_map.

E) RLS & permissions (quick rules of thumb)

workflow_versions: read allowed to lab staff (by lab scope in workflows.lab_id via join) and system admins.

test_workflow_map: tenant-scoped by lab_id.

order_workflow_instances & workflow_step_events: user must belong to the order’s lab_id; write only by authenticated users.

All server endpoints must re-assert lab_id from JWT and cross-check inputs.

F) Rollout checklist (1–2 hours of SQL + config)

Run the ALTER TABLEs and create indexes + function.

Seed one workflow_versions with a small SurveyJS template and rules.

Add a row in test_workflow_map for your lab:

(lab_id, test_group_id, workflow_version_id, is_default=true).

Implement /flow/resolve, /validate-step, /event, /start, /complete.

In UI, add a SurveyJS runner component:

loadFlow() → survey = new Survey.Model(template); bind handlers; render.

Smoke test:

Start → validate a step → next → complete → verify rows in workflow_step_events and order_workflow_instances.completed_at.

What you get

Zero new tables; only small additions to test_workflow_map and a SQL function.

SurveyJS flows fully versioned inside workflow_versions.definition.

Clean audit trail per order with workflow_step_events.

Fine-grained mapping at group and analyte levels, with a simple precedence rule.

Easy to extend (new versions = new rows in workflow_versions).



Looking at your Survey.js implementation plan, it's already well-structured for adding custom flows at the test group and analyte levels. However, let me enhance it with some improvements and clarifications while keeping minimal database changes:

## 🚀 **Enhanced Survey.js Implementation Plan for Custom Lab Flows**

### **A) Database Changes (Minimal & Focused)**

#### **1. Enhanced `test_workflow_map` Structure**

```sql
-- Add targets (nullable) for flexible mapping
ALTER TABLE public.test_workflow_map
  ADD COLUMN IF NOT EXISTS test_group_id uuid,
  ADD COLUMN IF NOT EXISTS analyte_id uuid,
  ADD COLUMN IF NOT EXISTS priority integer DEFAULT 100,  -- For explicit ordering
  ADD COLUMN IF NOT EXISTS conditions jsonb;              -- For conditional flows

-- FKs
ALTER TABLE public.test_workflow_map
  ADD CONSTRAINT test_workflow_map_test_group_id_fkey
  FOREIGN KEY (test_group_id) REFERENCES public.test_groups(id) ON DELETE CASCADE,
  
  ADD CONSTRAINT test_workflow_map_analyte_id_fkey
  FOREIGN KEY (analyte_id) REFERENCES public.analytes(id) ON DELETE CASCADE;

-- Ensure at least one target present
ALTER TABLE public.test_workflow_map
  ADD CONSTRAINT chk_twm_target_present
  CHECK (analyte_id IS NOT NULL OR test_group_id IS NOT NULL OR test_code IS NOT NULL);

-- Performance indexes
CREATE INDEX idx_twm_group_lookup ON public.test_workflow_map (lab_id, test_group_id);
CREATE INDEX idx_twm_analyte_lookup ON public.test_workflow_map (lab_id, analyte_id);
CREATE INDEX idx_twm_priority ON public.test_workflow_map (priority DESC);

-- Unique defaults per scope
CREATE UNIQUE INDEX idx_twm_default_by_group
ON public.test_workflow_map (lab_id, test_group_id)
WHERE is_default = true AND test_group_id IS NOT NULL;

CREATE UNIQUE INDEX idx_twm_default_by_analyte
ON public.test_workflow_map (lab_id, analyte_id)
WHERE is_default = true AND analyte_id IS NOT NULL;
```

#### **2. Enhanced Workflow Definition Structure**

```typescript
// Recommended JSON shape for workflow_versions.definition
interface WorkflowDefinition {
  ui: {
    engine: "surveyjs" | "custom";
    template: any; // SurveyJS JSON
    theme?: string; // Lab-specific theming
    localization?: Record<string, any>;
  };
  rules: {
    mode: "BASIC" | "PRO" | "HYBRID";
    triggerOn?: "ORDER_CREATE" | "SAMPLE_COLLECT" | "RESULT_ENTRY" | "MANUAL";
    steps: Array<{
      no: number;
      type: "pipette" | "dilution" | "qc" | "data_entry" | "approval";
      required: boolean;
      validation?: any; // Step-specific validation rules
      permissions?: string[]; // Role-based access
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
    onStart?: string;      // API endpoint to call
    onComplete?: string;   // API endpoint to call
    onValidate?: string;   // Custom validation endpoint
  };
}
```

#### **3. Enhanced Resolver Function with Conditions**

```sql
CREATE OR REPLACE FUNCTION public.resolve_workflow_version_id(
  p_lab_id uuid, 
  p_test_group_id uuid, 
  p_analyte_id uuid,
  p_context jsonb DEFAULT '{}'::jsonb  -- For conditional flows
) RETURNS uuid
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_workflow_id uuid;
BEGIN
  -- Priority-based resolution with conditions
  SELECT workflow_version_id INTO v_workflow_id
  FROM (
    -- 1) Analyte-specific with conditions
    SELECT workflow_version_id, priority, 1 AS precedence
    FROM public.test_workflow_map
    WHERE lab_id = p_lab_id 
      AND analyte_id = p_analyte_id 
      AND (conditions IS NULL OR jsonb_contains(p_context, conditions))
      AND is_active = true
    
    UNION ALL
    -- 2) Test group-specific with conditions
    SELECT workflow_version_id, priority, 2
    FROM public.test_workflow_map
    WHERE lab_id = p_lab_id 
      AND test_group_id = p_test_group_id 
      AND (conditions IS NULL OR jsonb_contains(p_context, conditions))
      AND is_active = true
    
    UNION ALL
    -- 3) Lab default fallback
    SELECT workflow_version_id, priority, 3
    FROM public.test_workflow_map
    WHERE lab_id = p_lab_id 
      AND test_group_id IS NULL 
      AND analyte_id IS NULL
      AND is_default = true
  ) AS candidates
  ORDER BY precedence, priority DESC
  LIMIT 1;
  
  RETURN v_workflow_id;
END;
$$;
```

### **B) Enhanced Server Endpoints**

#### **1. Flow Resolution with Context**
```typescript
// GET /api/flow/resolve
interface ResolveRequest {
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

interface ResolveResponse {
  workflowVersionId: string;
  definition: WorkflowDefinition;
  instanceId?: string; // If auto-started
  resumeData?: any;    // If resuming
}
```

#### **2. Enhanced Event Tracking**
```typescript
// POST /api/workflow/event
interface WorkflowEvent {
  instanceId: string;
  stepId: number;
  eventType: "START" | "VALIDATE" | "COMPLETE" | "SKIP" | "FAIL" | "PAUSE";
  payload: {
    data?: any;
    errors?: ValidationError[];
    metadata?: {
      deviceId?: string;
      location?: string;
      timestamp: string;
    };
  };
}
```

### **C) UI Implementation Enhancements**

#### **1. Flow Manager Component**
```tsx
// src/components/Workflow/FlowManager.tsx
import React, { useState, useEffect } from 'react';
import { Survey } from 'survey-react';
import { supabase } from '../../utils/supabase';

interface FlowManagerProps {
  orderId: string;
  testGroupId: string;
  analyteIds: string[];
  onComplete: (results: any) => void;
}

export const FlowManager: React.FC<FlowManagerProps> = ({
  orderId,
  testGroupId,
  analyteIds,
  onComplete
}) => {
  const [flows, setFlows] = useState<Map<string, WorkflowInstance>>();
  const [currentFlow, setCurrentFlow] = useState<string>();
  
  // Intelligent flow resolution
  const resolveFlows = async () => {
    const flowMap = new Map();
    
    // Check test group level first
    const groupFlow = await resolveWorkflow({ testGroupId });
    if (groupFlow) {
      flowMap.set(`group_${testGroupId}`, groupFlow);
    }
    
    // Check each analyte
    for (const analyteId of analyteIds) {
      const analyteFlow = await resolveWorkflow({ testGroupId, analyteId });
      if (analyteFlow && analyteFlow.id !== groupFlow?.id) {
        flowMap.set(`analyte_${analyteId}`, analyteFlow);
      }
    }
    
    setFlows(flowMap);
  };
  
  // Render appropriate UI based on flow configuration
  return (
    <div className="flow-manager">
      {currentFlow && flows?.get(currentFlow) && (
        <WorkflowRunner 
          flow={flows.get(currentFlow)}
          onComplete={handleFlowComplete}
          onValidate={handleValidation}
        />
      )}
    </div>
  );
};
```

#### **2. Dynamic Validation Integration**
```typescript
// Real-time validation with debouncing
const useWorkflowValidation = (workflowId: string, stepNo: number) => {
  const [validationState, setValidationState] = useState<ValidationState>();
  const debouncedValidate = useDebouncedCallback(
    async (inputs: any) => {
      const result = await validateStep(workflowId, stepNo, inputs);
      setValidationState(result);
      
      // Log validation event
      await logEvent({
        eventType: result.ok ? 'VALIDATE_OK' : 'VALIDATE_FAIL',
        payload: result
      });
    },
    300
  );
  
  return { validationState, validate: debouncedValidate };
};
```

### **D) Implementation Phases**

#### **Phase 1: Core Infrastructure (Week 1)**
1. Run database migrations
2. Create base Edge Functions
3. Implement basic SurveyJS integration
4. Set up event logging

#### **Phase 2: Lab Configuration UI (Week 2)**
```tsx
// Admin UI for configuring workflows
interface WorkflowConfiguratorProps {
  labId: string;
  testGroups: TestGroup[];
  analytes: Analyte[];
}

export const WorkflowConfigurator: React.FC<WorkflowConfiguratorProps> = ({
  labId,
  testGroups,
  analytes
}) => {
  return (
    <div className="grid grid-cols-2 gap-6">
      <div>
        <h3>Test Group Workflows</h3>
        <TestGroupWorkflowMapper />
      </div>
      <div>
        <h3>Analyte-Specific Workflows</h3>
        <AnalyteWorkflowMapper />
      </div>
    </div>
  );
};
```

#### **Phase 3: Advanced Features (Week 3)**
- Conditional workflows based on patient/order context
- Multi-step approval chains
- Integration with existing QC modules
- Workflow analytics dashboard

### **E) Key Benefits of This Enhanced Plan**

1. **Minimal Database Impact**: Only touches workflow tables + small additions
2. **Maximum Flexibility**: Labs can configure flows at any level
3. **Intelligent Resolution**: Context-aware workflow selection
4. **Complete Audit Trail**: Every action logged
5. **Extensible**: Easy to add new flow types
6. **Performance**: Indexed lookups, efficient resolution

### **F) Quick Start Guide**

```sql
-- 1. Create a basic workflow version
INSERT INTO workflow_versions (name, definition, created_by) VALUES (
  'CBC Basic Flow',
  '{
    "ui": {
      "engine": "surveyjs",
      "template": {
        "pages": [{
          "name": "page1",
          "elements": [{
            "type": "text",
            "name": "sampleId",
            "title": "Scan Sample Barcode",
            "isRequired": true
          }]
        }]
      }
    },
    "rules": {
      "mode": "BASIC",
      "triggerOn": "SAMPLE_COLLECT"
    },
    "meta": {
      "title": "CBC Sample Collection",
      "version": "1.0.0"
    }
  }'::jsonb,
  current_user_id()
);

-- 2. Map it to a test group
INSERT INTO test_workflow_map (
  lab_id, 
  test_group_id, 
  workflow_version_id, 
  is_default,
  priority
) VALUES (
  'your-lab-id',
  'cbc-test-group-id',
  'workflow-version-id',
  true,
  100
);
```

This enhanced plan provides a robust foundation for implementing custom lab flows with minimal database changes while maximizing flexibility and maintainability.

<Route path="/workflows" element={<WorkflowManagement />} />