# Workflow System Setup and Testing Guide

This guide explains how to set up and test the Survey.js workflow system that's now integrated with your database.

## 🚀 Quick Start

### 1. Database Setup

Your workflow is already in the database, but you may need to run the migration for result processing:

```sql
-- Run this migration in your Supabase SQL editor
\i 'supabase/migrations/20250911_workflow_results_tables.sql'
```

### 2. Environment Variables

Make sure these are set in your `.env.local`:

```bash
VITE_SUPABASE_URL=your-supabase-url
VITE_SUPABASE_ANON_KEY=your-supabase-anon-key

# Optional: Survey.js license key to remove branding
VITE_SURVEYJS_LICENSE_KEY=your-license-key
```

### 3. Deploy Edge Function

Deploy the workflow result processing function:

```bash
npx supabase functions deploy process-workflow-result
```

### 4. Access the Workflow

1. Start your development server: `npm run dev`
2. Navigate to: **http://localhost:5173/workflow-demo**
3. Your "Peripheral Smear Examination" workflow should appear in the dropdown

## 🧪 Testing Your Workflow

### Step 1: Navigate to Workflow Demo
- Go to the main navigation
- Click on **"Workflow Demo"** (under Tools & Settings)

### Step 2: Select Your Workflow
- In the **"Individual Workflows"** tab
- Select **"Peripheral Smear Examination"** from the dropdown
- Click **"Start Workflow"**

### Step 3: Complete the Workflow Steps

Your workflow has 3 steps:

1. **Step 1: Smear Preparation**
   - Enter smear quality (Good/Poor)

2. **Step 2: Microscopic Examination**
   - Enter microscopic observations

3. **Step 3: Report**
   - Enter final report notes

### Step 4: View Results
- Data is logged to browser console
- Database records are created in:
  - `workflow_step_events` (audit trail)
  - `order_workflow_instances` (progress tracking)
  - `test_results` (if measurements entered)

## 📊 What Happens Behind the Scenes

### Database Operations
1. **Workflow Instance Created**: New record in `order_workflow_instances`
2. **Step Events Logged**: Each step completion logged in `workflow_step_events`
3. **Progress Tracked**: Step completion status updated in real-time
4. **Results Processed**: Lab data stored in appropriate tables

### API Calls
1. **getWorkflows()**: Fetches available workflows from database
2. **startWorkflow()**: Creates new workflow instance
3. **logEvent()**: Records step completion events
4. **completeWorkflow()**: Marks workflow as complete
5. **Edge Function**: Processes results and updates related tables

## 🔧 Customizing Your Workflow

### Adding Fields
Your workflow definition is stored as JSON in the database. To add fields:

1. Access your Supabase dashboard
2. Go to **Table Editor** → **workflow_versions**
3. Find your workflow definition
4. Edit the JSON in the `definition` column

### Example: Adding a dropdown field
```json
{
  "name": "cell_count",
  "type": "dropdown",
  "title": "White Blood Cell Count",
  "choices": [
    {"value": "normal", "text": "Normal (4,000-11,000)"},
    {"value": "low", "text": "Low (<4,000)"},
    {"value": "high", "text": "High (>11,000)"}
  ]
}
```

### Supported Field Types
- `text`: Text input
- `comment`: Textarea
- `dropdown`: Select dropdown
- `radiogroup`: Radio buttons
- `checkbox`: Checkboxes
- `html`: Static HTML content

## 📈 Monitoring and Analytics

### View Workflow Activity
```sql
-- Recent workflow completions
SELECT 
  owi.id,
  owi.order_id,
  wd.name as workflow_name,
  owi.status,
  owi.started_at,
  owi.completed_at
FROM order_workflow_instances owi
JOIN workflow_versions wv ON owi.workflow_version_id = wv.id
JOIN workflow_definitions wd ON wv.workflow_id = wd.id
ORDER BY owi.created_at DESC
LIMIT 10;
```

### View Step Events
```sql
-- Recent workflow events
SELECT 
  wse.created_at,
  wse.event_type,
  wse.step_id,
  wse.event_data
FROM workflow_step_events wse
ORDER BY wse.created_at DESC
LIMIT 20;
```

## 🚀 Production Deployment

### 1. Database Migration
```bash
npx supabase db push
```

### 2. Edge Functions
```bash
npx supabase functions deploy process-workflow-result
```

### 3. Environment Variables
Set production environment variables in your hosting platform.

### 4. Survey.js License (Optional)
For production, consider getting a Survey.js license to remove branding:
```javascript
// Add to your app initialization
Survey.settings.licenseKey = "your-license-key";
```

## 🔍 Troubleshooting

### Workflow Not Appearing
- Check database connection
- Verify workflow has `active: true`
- Check browser console for errors

### Step Not Saving
- Check authentication (user must be logged in)
- Verify Edge Function is deployed
- Check Supabase logs for errors

### Data Not Appearing in Database
- Check RLS policies
- Verify user permissions
- Check Edge Function logs

## 📞 Support

The workflow system is now fully functional and integrated with your LIMS. Your "Peripheral Smear Examination" workflow should work immediately after following this setup guide.

For custom workflow development or additional features, refer to the Survey.js documentation: https://surveyjs.io/documentation
