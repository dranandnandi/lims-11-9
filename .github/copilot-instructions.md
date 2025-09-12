# LIMS v2 - AI Copilot Instructions

## Project Overview

This is a Laboratory Information Management System (LIMS) v2 built with React/TypeScript + Vite, featuring multi-lab support, AI-powered workflows, and comprehensive test result management. The system manages patients, orders, test results, billing, and workflow automation.

## Architecture Patterns

### 1. Database Layer - Supabase with Generic Relationships

**Critical Pattern**: The system uses a **generic attachment system** without foreign keys:
```typescript
// Attachments link to ANY table via related_table + related_id
interface Attachment {
  related_table: 'orders' | 'patients' | 'results' | 'labs';
  related_id: string; // UUID of the related entity
}
```

**Multi-lab Architecture**: Every operation must consider `lab_id` context:
- Users belong to labs (`users.lab_id`)
- Lab-specific analyte configurations (`lab_analytes` overrides `analytes`)
- All queries should filter by user's lab context

### 2. Component Organization

```
src/components/
├── [Domain]/           # Business domain folders (Patients/, Orders/, Results/, etc.)
├── ui/                # Reusable UI components
├── Layout/            # App shell components
└── Workflow/          # Survey.js workflow system
```

**Naming Convention**: Use descriptive domain-based names. Components ending in `Modal`, `Console`, `Demo` indicate their UI patterns.

### 3. Data Access Pattern

**Always use the centralized API in `src/utils/supabase.ts`**:
```typescript
// ❌ Don't call supabase directly in components
const { data } = await supabase.from('orders').select('*');

// ✅ Use the database object methods
const { data } = await database.orders.getAll();
```

The `database` object provides:
- Consistent error handling
- Proper joins and relationships
- Lab-scoped filtering
- Standardized response format

## Workflow System (Survey.js)

### Core Components

1. **WorkflowRunner** - Executes Survey.js workflows with database integration
2. **FlowManager** - Orchestrates multiple workflows for complex procedures  
3. **WorkflowConfigurator** - No-code workflow design interface

### Database Schema

Workflows use a versioned approach:
```sql
workflows → workflow_versions → workflow_instances → workflow_step_events
```

### Integration Pattern

```typescript
// Order-gated workflow execution
<FlowManager
  orderId={order.id}
  testGroupId={testGroup.id} 
  analyteIds={analytes.map(a => a.id)}
  labId={lab.id}
  onComplete={(results) => {
    // Results automatically saved to results/result_values tables
  }}
/>
```

## Development Conventions

### 1. State Management

- Use React Context for global state (`AuthContext`)
- Local state with `useState` for component-specific data
- Custom hooks for complex data operations (`useOrderStatus`, `useVerificationConsole`)

### 2. Error Handling

```typescript
// Consistent error handling pattern
try {
  const { data, error } = await database.orders.create(orderData);
  if (error) throw error;
  // Handle success
} catch (error) {
  console.error('Operation failed:', error);
  // Show user-friendly error message
}
```

### 3. TypeScript Usage

- Use interfaces for data structures (`interface Order`, `interface Patient`)
- Define component props interfaces
- Use union types for status enums: `'pending' | 'completed' | 'verified'`

### 4. Security & Permissions

Result editing follows security patterns:
```typescript
interface ResultWithSecurity {
  is_locked?: boolean;
  can_edit?: boolean; 
  restriction_reason?: string;
}
```

Check permissions before allowing modifications.

## Key Business Logic

### 1. Order Management

Orders have complex relationships:
- `orders` → `order_tests` → `test_groups` → `test_group_analytes` → `analytes`
- Patient-centric workflow: Orders can be grouped by `visit_group_id`
- Order types: 'primary' vs 'additional' tests

### 2. Result Verification

Multi-stage verification process:
```
pending_verification → verified/needs_clarification → approved
```

Use `ResultVerificationConsole` for batch operations.

### 3. AI Integration

- Attachment processing: `attachments.ai_processed`, `ai_confidence`
- Result extraction: `results.extracted_by_ai`
- Workflow automation: AI protocols in `ai_protocols` table

### 4. Billing & Invoicing

- Package-based pricing: `packages` → `package_test_groups`
- Invoice generation with line items: `invoices` → `invoice_items`
- Cash reconciliation tracking

## File Patterns

### 1. Page Components (`src/pages/`)

- Full-screen application pages
- Handle routing and top-level state
- Import domain-specific components

### 2. Component Structure

```typescript
// Standard component pattern
interface ComponentProps {
  // Props interface
}

const Component: React.FC<ComponentProps> = ({ prop1, prop2 }) => {
  // Hooks and state
  // Event handlers  
  // Render JSX
};

export default Component;
```

### 3. Utility Files

- `src/utils/supabase.ts` - Central database API
- `src/utils/workflowAPI.ts` - Workflow-specific operations
- `src/utils/localStorage.ts` - Local data persistence

## Development Workflow

### 1. Adding New Features

1. Design database schema (if needed) in `supabase/migrations/`
2. Update TypeScript interfaces in `src/types/`
3. Add API methods to `src/utils/supabase.ts`
4. Create/update components following domain organization
5. Test via demo pages (`WorkflowDemo`, `OrderDetail`)

### 2. Database Changes

Always use **safe migrations** with `IF NOT EXISTS` guards:
```sql
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'orders' AND column_name = 'new_field') THEN
        ALTER TABLE orders ADD COLUMN new_field TEXT;
    END IF;
END $$;
```

### 3. Testing Workflow Changes

Use `http://localhost:5173/workflow-demo` to test workflow modifications without affecting production data.

## Common Patterns to Follow

1. **Lab Context**: Always filter data by user's lab_id
2. **Generic Attachments**: Use `related_table` + `related_id` pattern for file attachments
3. **Workflow Integration**: Gate workflows behind order selection
4. **Security Checks**: Verify permissions before data modifications
5. **Error Boundaries**: Graceful error handling with user feedback
6. **Responsive Design**: Use Tailwind CSS for consistent styling

## Avoid These Patterns

- Direct Supabase client usage in components (use `database` object)
- Hard-coded lab IDs (always derive from user context)
- Missing foreign key relationships (use the established patterns)
- Bypassing the verification workflow for result modifications
- Creating new workflow systems (extend existing Survey.js integration)