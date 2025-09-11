# LIMS Workflow Security Implementation

## 🔒 Overview

This implementation adds comprehensive workflow security to your LIMS system, ensuring data integrity, compliance, and proper audit trails throughout the result lifecycle.

## ✅ Features Implemented

### 1. **Result Locking**
- **Auto-lock after report generation**: Results automatically lock when PDF reports are created
- **Manual locking capability**: Administrators can manually lock results
- **Lock reasons**: Clear documentation of why results are locked

### 2. **Verification Workflow**
- **Prevent editing verified results**: Once verified, results cannot be modified
- **Status enforcement**: Proper progression through verification statuses
- **Verification audit**: All verification actions are logged

### 3. **Comprehensive Audit Trail**
- **All changes tracked**: Every modification to results and values is logged
- **User attribution**: Who made what changes and when
- **Value history**: Before/after values for all modifications

### 4. **Amendment Process**
- **Locked result amendments**: Formal process for changing locked/verified results
- **Approval workflow**: Amendments require supervisor review
- **Documentation**: Full audit trail of amendment requests and approvals

### 5. **Frontend Security**
- **Visual indicators**: Clear UI showing result security status
- **Input protection**: Automatic disabling of inputs for locked results
- **User guidance**: Clear messaging about why editing is restricted

## 🗄️ Database Changes

### New Columns Added to `results` table:
```sql
ALTER TABLE results ADD COLUMN:
- is_locked BOOLEAN DEFAULT FALSE
- locked_reason TEXT
- locked_at TIMESTAMP WITH TIME ZONE
- locked_by UUID REFERENCES users(id)
```

### Triggers Created:
1. **`audit_result_value_changes`** - Logs all result_value modifications
2. **`audit_result_changes`** - Logs all result modifications
3. **`check_verified_result_edit`** - Prevents editing verified/locked results
4. **`enforce_result_workflow`** - Enforces verification workflow rules
5. **`lock_results_after_report`** - Auto-locks results after report generation
6. **`update_order_on_result_verification`** - Updates order status when all results verified

### Functions Added:
1. **`can_edit_result(result_id)`** - Check if result can be edited
2. **`get_result_restrictions(result_id)`** - Get detailed restriction info
3. **`request_result_amendment(result_id, reason, changes)`** - Submit amendment request

## 🔧 Usage

### 1. **Check Edit Permissions**
```typescript
import { canEditResult } from '../utils/securityService';

const isEditable = await canEditResult(resultId);
if (!isEditable) {
  // Show locked UI
}
```

### 2. **Show Security Indicators**
```typescript
import { SecurityIndicator } from '../components/SecurityIndicators';

<SecurityIndicator 
  result={result}
  onAmendmentRequest={handleAmendmentRequest}
  onViewAudit={handleViewAudit}
/>
```

### 3. **Request Amendments**
```typescript
import AmendmentRequestModal from '../components/AmendmentRequestModal';

<AmendmentRequestModal
  isOpen={showAmendmentModal}
  onClose={() => setShowAmendmentModal(false)}
  result={selectedResult}
  onSuccess={(noteId) => {
    console.log('Amendment requested:', noteId);
    // Refresh data
  }}
/>
```

### 4. **Wrap Input Fields**
```typescript
import { ResultValueSecurityWrapper } from '../components/SecurityIndicators';

<ResultValueSecurityWrapper result={result}>
  <input
    value={value}
    onChange={handleChange}
    disabled={!result.can_edit}
  />
</ResultValueSecurityWrapper>
```

## 🔐 Security Features

### Row Level Security (RLS)
- **Prevents unauthorized edits**: Database-level protection
- **Policy-based access**: Fine-grained control over who can do what

### Audit Trail
- **Complete history**: Every change is tracked
- **User attribution**: Links to user accounts
- **Timestamps**: Precise timing of all actions

### Workflow Enforcement
- **Status progression**: Ensures proper workflow flow
- **Validation**: Prevents invalid state transitions
- **Automation**: Auto-updates related records

## 📊 Workflow States

### Result Security States:
1. **Editable** ✏️ - Can be freely modified
2. **Verified** ✅ - Locked after verification
3. **Report Locked** 🔒 - Locked after report generation
4. **Needs Amendment** ⚠️ - Requires formal amendment process

### Amendment Workflow:
1. **Request** - User submits amendment with reason
2. **Review** - Supervisor reviews the request
3. **Approve/Reject** - Decision made with documentation
4. **Execute** - If approved, changes are made with full audit

## 🚀 Migration

Run the migration file to implement all features:

```sql
-- Run this file in your database
\i migrations/workflow_security_implementation.sql
```

## 🧪 Testing

### Test Cases to Verify:

1. **Result Locking**:
   - Generate a PDF report
   - Verify results are automatically locked
   - Try to edit locked result values (should be prevented)

2. **Verification Workflow**:
   - Verify a result
   - Try to edit verified result (should be prevented)
   - Try to revert verification status (should be prevented)

3. **Amendment Process**:
   - Request amendment for locked result
   - Check amendment shows in verification notes
   - Verify audit log entry is created

4. **Audit Trail**:
   - Make changes to result values
   - Check audit_logs table for entries
   - Verify old and new values are captured

## 🔧 Configuration

### Environment Variables:
```env
# Database connection for audit functions
DATABASE_URL=your_database_url

# Optional: Configure amendment approval workflow
AMENDMENT_APPROVAL_REQUIRED=true
```

### Permissions:
Ensure these functions are accessible to your application:
```sql
GRANT EXECUTE ON FUNCTION can_edit_result(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION get_result_restrictions(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION request_result_amendment(UUID, TEXT, JSONB) TO authenticated;
```

## 📈 Monitoring

### Key Metrics to Monitor:
- Number of locked results
- Amendment requests per day
- Verification completion rate
- Audit log growth

### Queries for Monitoring:
```sql
-- Count locked results
SELECT COUNT(*) FROM results WHERE is_locked = true;

-- Recent amendment requests
SELECT COUNT(*) FROM result_verification_notes 
WHERE note LIKE 'AMENDMENT REQUEST:%' 
AND created_at > NOW() - INTERVAL '24 hours';

-- Audit log size
SELECT COUNT(*) FROM audit_logs WHERE timestamp > NOW() - INTERVAL '30 days';
```

## 🆘 Troubleshooting

### Common Issues:

1. **"Cannot modify values of verified results"**
   - Result is verified and locked
   - Use amendment process instead

2. **"Cannot modify values of locked results"**
   - Result is locked (likely after report generation)
   - Check locked_reason for details
   - Use amendment process if changes needed

3. **RLS preventing access**
   - Check user permissions
   - Ensure proper authentication
   - Review RLS policies

### Debug Queries:
```sql
-- Check result status
SELECT id, verification_status, is_locked, locked_reason 
FROM results WHERE id = 'your-result-id';

-- Check audit trail
SELECT * FROM audit_logs 
WHERE record_id = 'your-result-id' 
ORDER BY timestamp DESC;

-- Check amendment requests
SELECT * FROM result_verification_notes 
WHERE result_id = 'your-result-id' 
AND note LIKE 'AMENDMENT REQUEST:%';
```

## 📝 Compliance Notes

This implementation helps meet compliance requirements for:
- **FDA 21 CFR Part 11**: Electronic records and signatures
- **ISO 15189**: Medical laboratory accreditation
- **CLIA**: Clinical Laboratory Improvement Amendments
- **GDPR**: Data protection and audit requirements

The audit trail provides the necessary documentation for regulatory inspections and quality assurance processes.

---

**Implementation Complete!** 🎉

Your LIMS now has enterprise-grade workflow security with comprehensive audit trails and data integrity protection.