#!/bin/bash

# Survey.js Workflow Implementation - Installation Script

echo "🚀 Installing Survey.js Workflow System..."

# Install dependencies
echo "📦 Installing dependencies..."
npm install survey-core@^1.9.131 survey-react-ui@^1.9.131 survey-creator-core@^1.9.131 survey-creator-react@^1.9.131 use-debounce@^10.0.0

# Create component exports
echo "📁 Creating component exports..."

# Add to components/index.ts
cat >> src/components/index.ts << 'EOF'

// Workflow Components
export { WorkflowRunner } from './Workflow/WorkflowRunner';
export { FlowManager } from './Workflow/FlowManager';
export { WorkflowConfigurator } from './Workflow/WorkflowConfigurator';
EOF

echo "✅ Survey.js Workflow System installed successfully!"
echo ""
echo "📋 Next Steps:"
echo "1. Run database migrations (if not already done)"
echo "2. Add workflow route to your router:"
echo "   <Route path='/workflows' element={<WorkflowManagement />} />"
echo "3. Create sample workflows:"
echo "   import { createSampleWorkflows } from './utils/workflowTemplates';"
echo "   await createSampleWorkflows();"
echo "4. Configure workflow mappings in the admin interface"
echo ""
echo "🔗 Access the workflow management at: /workflows"