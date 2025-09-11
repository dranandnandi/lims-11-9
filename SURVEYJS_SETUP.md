# Survey.js Workflow Implementation - Quick Setup Guide

## 🎯 Overview
This implementation adds Survey.js-powered custom workflows at the test group and analyte levels, allowing labs to configure their own procedural flows with minimal database changes.

## 📋 What's Included

### ✅ **Core Components**
- **WorkflowRunner**: Main Survey.js component with validation
- **FlowManager**: Orchestrates multiple workflows per order
- **WorkflowConfigurator**: Admin interface for mapping workflows
- **WorkflowAPI**: Service layer for all workflow operations

### ✅ **Database Integration** 
- Uses existing `workflow_*` tables
- Enhanced `test_workflow_map` with test group/analyte linking
- Smart precedence resolution (analyte > test group > lab default)

### ✅ **Pre-built Templates**
- Basic pipette validation
- Professional multi-step pipette workflow
- Sample collection with QC checks  
- Result verification and approval

## 🚀 **Quick Installation**

### 1. Install Dependencies
```bash
npm install survey-core survey-react-ui survey-creator-core survey-creator-react use-debounce
```

### 2. Database Setup (Already Done)
Your database changes are already applied based on your surveyjs.md plan.

### 3. Add Route to Your App
```tsx
import { WorkflowManagement } from './pages/WorkflowManagement';

// In your router:
<Route path="/workflows" element={<WorkflowManagement />} />
```

### 4. Create Sample Workflows
```tsx
import { createSampleWorkflows } from './utils/workflowTemplates';

// Run once to populate sample workflows
const results = await createSampleWorkflows();
console.log('Created workflows:', results);
```

## 🎛️ **Usage Guide**

### **For Lab Administrators**

1. **Access Workflow Management**: Navigate to `/workflows`
2. **Configure Mappings**: 
   - Go to Configuration tab
   - Map workflows to test groups or specific analytes
   - Set priorities and defaults
3. **Test Workflows**: Use Demo tab to test configurations

### **For Lab Technicians**

1. **Automatic Flow Resolution**: When processing orders, workflows are automatically resolved based on:
   - Analyte-specific workflows (highest priority)
   - Test group workflows (medium priority)  
   - Lab default workflows (fallback)

2. **Interactive Surveys**: Survey.js provides rich UI with:
   - Step-by-step guidance
   - Real-time validation
   - Progress tracking
   - Responsive design

### **Integration Points**

```tsx
// Example: Add to your order processing component
import { FlowManager } from '../components/Workflow/FlowManager';

<FlowManager
  orderId={order.id}
  testGroupId={testGroup.id}
  analyteIds={analytes.map(a => a.id)}
  labId={lab.id}
  onComplete={(results) => {
    console.log('Workflows completed:', results);
    // Handle completion (e.g., update order status)
  }}
/>
```

## 📊 **Workflow Definition Structure**

```typescript
interface WorkflowDefinition {
  ui: {
    engine: "surveyjs";
    template: SurveyJSJSON; // Standard Survey.js JSON
    theme?: string;
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
    version: string;
  };
}
```

## 🔧 **Advanced Configuration**

### **Custom Validation Rules**
```tsx
// Add custom validation to WorkflowAPI.validateStep()
private static validateCustomStep(step: any, inputs: any): ValidationState {
  // Your custom validation logic
  return { ok: true, messages: ['Custom validation passed'] };
}
```

### **Conditional Workflows**
Use the `conditions` field in `test_workflow_map` to create context-aware workflows:
```sql
INSERT INTO test_workflow_map (
  lab_id, test_group_id, workflow_version_id, 
  conditions, priority
) VALUES (
  'lab-id', 'test-group-id', 'workflow-id',
  '{"urgency": "stat", "department": "emergency"}'::jsonb,
  200
);
```

### **Multi-step Workflows**
Configure complex workflows with multiple Survey.js pages:
```typescript
{
  pages: [
    { name: "setup", title: "Initial Setup", elements: [...] },
    { name: "execution", title: "Execution", elements: [...] },
    { name: "verification", title: "Verification", elements: [...] },
    { name: "approval", title: "Final Approval", elements: [...] }
  ]
}
```

## 📈 **Benefits**

### **✅ For Labs**
- **Zero New Tables**: Uses existing workflow infrastructure
- **Complete Flexibility**: Configure any workflow for any test/analyte
- **Audit Trail**: Every action logged in `workflow_step_events`
- **Performance**: Indexed lookups, efficient resolution
- **Extensible**: Easy to add new workflow types

### **✅ For Technicians**  
- **Interactive UI**: Rich Survey.js interface
- **Real-time Validation**: Immediate feedback on inputs
- **Step-by-step Guidance**: Clear procedural flows
- **Mobile-friendly**: Works on tablets and mobile devices

### **✅ For Quality Assurance**
- **Standardization**: Consistent procedures across all users
- **Compliance**: Built-in validation and approval workflows  
- **Traceability**: Complete audit trail of all actions
- **Analytics**: Performance metrics and completion rates

## 🎯 **Next Steps**

1. **Install dependencies** and set up routing
2. **Create sample workflows** using the provided templates
3. **Configure initial mappings** for your test groups
4. **Test with demo data** using the Demo tab
5. **Train users** on the new workflow interface
6. **Monitor analytics** and optimize based on usage

## 🔗 **API Reference**

### **WorkflowAPI Methods**
- `resolveWorkflow(request)`: Find applicable workflow
- `startWorkflow(orderId, workflowVersionId)`: Create instance
- `validateStep(workflowVersionId, stepNo, inputs)`: Validate data
- `logEvent(event)`: Record workflow event
- `completeWorkflow(instanceId, result)`: Mark completed

### **Database Functions**
- `resolve_workflow_version_id(lab_id, test_group_id, analyte_id, context)`: Smart resolution

This implementation provides a robust foundation for lab workflow automation while maintaining minimal database impact and maximum flexibility! 🎉