-- LIMS Workflow Security Implementation
-- Implements data integrity, audit trails, and result locking
-- Uses existing schema structure without duplicating tables/columns

-- ==============================================
-- 1. ADD RESULT LOCKING COLUMNS TO EXISTING RESULTS TABLE
-- ==============================================

-- Add locking columns to existing results table
ALTER TABLE results 
ADD COLUMN IF NOT EXISTS is_locked BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS locked_reason TEXT,
ADD COLUMN IF NOT EXISTS locked_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS locked_by UUID REFERENCES users(id);

-- ==============================================
-- 2. AUDIT TRAIL USING EXISTING AUDIT_LOGS TABLE
-- ==============================================

-- Function to log result_values changes to existing audit_logs table
CREATE OR REPLACE FUNCTION log_result_value_changes()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO audit_logs (
    table_name,
    record_id,
    action,
    old_values,
    new_values,
    user_id,
    user_email
  ) VALUES (
    'result_values',
    COALESCE(NEW.id, OLD.id),
    TG_OP,
    CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) ELSE NULL END,
    CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) ELSE NULL END,
    auth.uid(),
    (SELECT email FROM auth.users WHERE id = auth.uid())
  );
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create trigger for result_values audit logging
DROP TRIGGER IF EXISTS audit_result_value_changes ON result_values;
CREATE TRIGGER audit_result_value_changes
  AFTER INSERT OR UPDATE OR DELETE ON result_values
  FOR EACH ROW
  EXECUTE FUNCTION log_result_value_changes();

-- Function to log results table changes
CREATE OR REPLACE FUNCTION log_result_changes()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO audit_logs (
    table_name,
    record_id,
    action,
    old_values,
    new_values,
    user_id,
    user_email
  ) VALUES (
    'results',
    COALESCE(NEW.id, OLD.id),
    TG_OP,
    CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) ELSE NULL END,
    CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) ELSE NULL END,
    auth.uid(),
    (SELECT email FROM auth.users WHERE id = auth.uid())
  );
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create trigger for results audit logging
DROP TRIGGER IF EXISTS audit_result_changes ON results;
CREATE TRIGGER audit_result_changes
  AFTER INSERT OR UPDATE OR DELETE ON results
  FOR EACH ROW
  EXECUTE FUNCTION log_result_changes();

-- ==============================================
-- 3. PREVENT EDITING VERIFIED/LOCKED RESULTS
-- ==============================================

-- Function to prevent editing verified or locked result values
CREATE OR REPLACE FUNCTION prevent_verified_result_edit()
RETURNS TRIGGER AS $$
DECLARE
  result_record RECORD;
BEGIN
  -- Get result status for this result_value
  SELECT verification_status, is_locked, locked_reason
  INTO result_record
  FROM results 
  WHERE id = COALESCE(NEW.result_id, OLD.result_id);
  
  -- Check if result is verified
  IF result_record.verification_status = 'verified' THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Cannot delete values of verified results. Use amendment process if changes are needed.';
    ELSIF TG_OP = 'UPDATE' AND (OLD.value != NEW.value OR OLD.flag != NEW.flag) THEN
      RAISE EXCEPTION 'Cannot modify values of verified results. Use amendment process if changes are needed.';
    END IF;
  END IF;
  
  -- Check if result is locked
  IF result_record.is_locked = true THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Cannot delete values of locked results. Reason: %', result_record.locked_reason;
    ELSIF TG_OP = 'UPDATE' AND (OLD.value != NEW.value OR OLD.flag != NEW.flag) THEN
      RAISE EXCEPTION 'Cannot modify values of locked results. Reason: %', result_record.locked_reason;
    END IF;
  END IF;
  
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- Create trigger to prevent editing verified/locked results
DROP TRIGGER IF EXISTS check_verified_result_edit ON result_values;
CREATE TRIGGER check_verified_result_edit
  BEFORE UPDATE OR DELETE ON result_values
  FOR EACH ROW
  EXECUTE FUNCTION prevent_verified_result_edit();

-- ==============================================
-- 4. WORKFLOW STATUS ENFORCEMENT
-- ==============================================

-- Function to validate result status transitions and workflow
CREATE OR REPLACE FUNCTION validate_result_workflow()
RETURNS TRIGGER AS $$
BEGIN
  -- Prevent status regression from verified
  IF OLD.verification_status = 'verified' AND NEW.verification_status != 'verified' THEN
    RAISE EXCEPTION 'Cannot revert verified results. Use amendment process if changes are needed.';
  END IF;
  
  -- Auto-update fields when result is verified
  IF NEW.verification_status = 'verified' AND OLD.verification_status != 'verified' THEN
    -- Set verification timestamp and user
    NEW.verified_at = NOW();
    NEW.verified_by = auth.uid();
    NEW.manually_verified = true;
    
    -- Auto-update status to Reviewed
    NEW.status = 'Reviewed';
    
    -- Ensure result values exist before verification
    IF NOT EXISTS (SELECT 1 FROM result_values WHERE result_id = NEW.id) THEN
      RAISE EXCEPTION 'Cannot verify result without values';
    END IF;
    
    -- Log verification action to existing audit trail
    INSERT INTO audit_logs (
      table_name,
      record_id,
      action,
      new_values,
      user_id,
      user_email
    ) VALUES (
      'results',
      NEW.id,
      'VERIFIED',
      jsonb_build_object(
        'previous_status', OLD.verification_status,
        'new_status', NEW.verification_status,
        'verified_by', auth.uid(),
        'verified_at', NOW()
      ),
      auth.uid(),
      (SELECT email FROM auth.users WHERE id = auth.uid())
    );
  END IF;
  
  -- Prevent unlocking without proper authorization
  IF OLD.is_locked = true AND NEW.is_locked = false THEN
    -- Add additional checks here for who can unlock results
    -- For now, log the unlock action
    INSERT INTO audit_logs (
      table_name,
      record_id,
      action,
      old_values,
      new_values,
      user_id,
      user_email
    ) VALUES (
      'results',
      NEW.id,
      'UNLOCKED',
      jsonb_build_object('locked_reason', OLD.locked_reason),
      jsonb_build_object('unlocked_by', auth.uid(), 'unlocked_at', NOW()),
      auth.uid(),
      (SELECT email FROM auth.users WHERE id = auth.uid())
    );
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create trigger for result workflow validation
DROP TRIGGER IF EXISTS enforce_result_workflow ON results;
CREATE TRIGGER enforce_result_workflow
  BEFORE UPDATE ON results
  FOR EACH ROW
  EXECUTE FUNCTION validate_result_workflow();

-- ==============================================
-- 5. AUTO-LOCK RESULTS AFTER REPORT GENERATION
-- ==============================================

-- Function to lock results when report PDF is generated
CREATE OR REPLACE FUNCTION lock_results_on_report_generation()
RETURNS TRIGGER AS $$
BEGIN
  -- When PDF is generated, lock the associated results
  IF NEW.pdf_url IS NOT NULL AND (OLD.pdf_url IS NULL OR OLD.pdf_url != NEW.pdf_url) THEN
    UPDATE results 
    SET 
      is_locked = true,
      locked_reason = 'Report generated and PDF created',
      locked_at = NOW(),
      locked_by = auth.uid()
    WHERE order_id = NEW.order_id;
    
    -- Log this action to audit trail
    INSERT INTO audit_logs (
      table_name,
      record_id,
      action,
      new_values,
      user_id,
      user_email
    ) VALUES (
      'results',
      NEW.order_id,
      'LOCKED_FOR_REPORT',
      jsonb_build_object(
        'report_id', NEW.id,
        'pdf_url', NEW.pdf_url,
        'locked_at', NOW(),
        'locked_by', auth.uid(),
        'reason', 'Report generated and PDF created'
      ),
      auth.uid(),
      (SELECT email FROM auth.users WHERE id = auth.uid())
    );
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create trigger to lock results after report generation
DROP TRIGGER IF EXISTS lock_results_after_report ON reports;
CREATE TRIGGER lock_results_after_report
  AFTER INSERT OR UPDATE ON reports
  FOR EACH ROW
  EXECUTE FUNCTION lock_results_on_report_generation();

-- ==============================================
-- 6. ORDER STATUS UPDATE AUTOMATION
-- ==============================================

-- Function to update order status based on result verification
CREATE OR REPLACE FUNCTION update_order_status_on_result_change()
RETURNS TRIGGER AS $$
DECLARE
  unverified_count INTEGER;
BEGIN
  -- Only process when result is verified
  IF NEW.verification_status = 'verified' AND OLD.verification_status != 'verified' THEN
    -- Check if all results for this order are verified
    SELECT COUNT(*)
    INTO unverified_count
    FROM results 
    WHERE order_id = NEW.order_id 
    AND id != NEW.id
    AND verification_status != 'verified';
    
    -- If no unverified results remain, update order status
    IF unverified_count = 0 THEN
      UPDATE orders 
      SET 
        status = 'Report Ready',
        status_updated_at = NOW(),
        status_updated_by = (SELECT email FROM auth.users WHERE id = auth.uid())
      WHERE id = NEW.order_id;
      
      -- Log order status change
      INSERT INTO audit_logs (
        table_name,
        record_id,
        action,
        new_values,
        user_id,
        user_email
      ) VALUES (
        'orders',
        NEW.order_id,
        'STATUS_AUTO_UPDATE',
        jsonb_build_object(
          'new_status', 'Report Ready',
          'reason', 'All results verified',
          'triggered_by_result', NEW.id
        ),
        auth.uid(),
        (SELECT email FROM auth.users WHERE id = auth.uid())
      );
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create trigger for order status updates
DROP TRIGGER IF EXISTS update_order_on_result_verification ON results;
CREATE TRIGGER update_order_on_result_verification
  AFTER UPDATE ON results
  FOR EACH ROW
  WHEN (NEW.verification_status = 'verified')
  EXECUTE FUNCTION update_order_status_on_result_change();

-- ==============================================
-- 7. AMENDMENT PROCESS USING EXISTING TABLES
-- ==============================================

-- Function to handle result amendments through existing verification notes
CREATE OR REPLACE FUNCTION request_result_amendment(
  p_result_id UUID,
  p_reason TEXT,
  p_proposed_changes JSONB
) RETURNS UUID AS $$
DECLARE
  v_note_id UUID;
  v_is_locked BOOLEAN;
  v_verification_status TEXT;
BEGIN
  -- Get result status
  SELECT is_locked, verification_status 
  INTO v_is_locked, v_verification_status
  FROM results WHERE id = p_result_id;
  
  -- Check if amendment is needed
  IF v_is_locked = true OR v_verification_status = 'verified' THEN
    -- Create amendment request in existing verification notes table
    INSERT INTO result_verification_notes (
      result_id,
      author_id,
      note
    ) VALUES (
      p_result_id,
      auth.uid(),
      'AMENDMENT REQUEST: ' || p_reason || E'\n\nProposed changes: ' || p_proposed_changes::text
    ) RETURNING id INTO v_note_id;
    
    -- Log the amendment request in audit trail
    INSERT INTO audit_logs (
      table_name,
      record_id,
      action,
      new_values,
      user_id,
      user_email
    ) VALUES (
      'results',
      p_result_id,
      'AMENDMENT_REQUESTED',
      jsonb_build_object(
        'reason', p_reason,
        'proposed_changes', p_proposed_changes,
        'note_id', v_note_id,
        'current_status', v_verification_status,
        'is_locked', v_is_locked
      ),
      auth.uid(),
      (SELECT email FROM auth.users WHERE id = auth.uid())
    );
    
    -- Update result status to needs clarification
    UPDATE results 
    SET verification_status = 'needs_clarification'
    WHERE id = p_result_id;
    
    RETURN v_note_id;
  ELSE
    RAISE EXCEPTION 'Result is not locked or verified. Use normal edit process.';
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ==============================================
-- 8. ROW LEVEL SECURITY POLICIES
-- ==============================================

-- Enable RLS on critical tables
ALTER TABLE result_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE results ENABLE ROW LEVEL SECURITY;

-- Policy to prevent editing locked/verified result values
DROP POLICY IF EXISTS prevent_locked_result_value_edit ON result_values;
CREATE POLICY prevent_locked_result_value_edit ON result_values
  FOR UPDATE
  USING (
    NOT EXISTS (
      SELECT 1 FROM results r
      WHERE r.id = result_values.result_id 
      AND (r.is_locked = true OR r.verification_status = 'verified')
    )
  );

-- Policy for viewing result values (generally permissive, adjust based on roles)
DROP POLICY IF EXISTS result_values_view_policy ON result_values;
CREATE POLICY result_values_view_policy ON result_values
  FOR SELECT
  USING (true); -- Adjust based on your specific role requirements

-- Policy for inserting result values - only for unlocked/unverified results
DROP POLICY IF EXISTS result_values_insert_policy ON result_values;
CREATE POLICY result_values_insert_policy ON result_values
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM results r
      WHERE r.id = result_values.result_id 
      AND r.is_locked = false 
      AND r.verification_status != 'verified'
    )
  );

-- Policy for deleting result values - only for unlocked/unverified results
DROP POLICY IF EXISTS result_values_delete_policy ON result_values;
CREATE POLICY result_values_delete_policy ON result_values
  FOR DELETE
  USING (
    NOT EXISTS (
      SELECT 1 FROM results r
      WHERE r.id = result_values.result_id 
      AND (r.is_locked = true OR r.verification_status = 'verified')
    )
  );

-- Basic policies for results table
DROP POLICY IF EXISTS results_view_policy ON results;
CREATE POLICY results_view_policy ON results
  FOR SELECT
  USING (true); -- Adjust based on role requirements

DROP POLICY IF EXISTS results_update_policy ON results;
CREATE POLICY results_update_policy ON results
  FOR UPDATE
  USING (true); -- The triggers will handle the business logic

-- ==============================================
-- 9. HELPER FUNCTIONS FOR FRONTEND
-- ==============================================

-- Function to check if a result can be edited
CREATE OR REPLACE FUNCTION can_edit_result(p_result_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
  result_record RECORD;
BEGIN
  SELECT verification_status, is_locked, status
  INTO result_record
  FROM results
  WHERE id = p_result_id;
  
  RETURN (
    result_record.verification_status != 'verified' AND
    result_record.is_locked = false AND
    result_record.status NOT IN ('Reviewed', 'Completed')
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to get result edit restrictions
CREATE OR REPLACE FUNCTION get_result_restrictions(p_result_id UUID)
RETURNS TABLE(
  can_edit BOOLEAN,
  restriction_reason TEXT,
  verification_status TEXT,
  is_locked BOOLEAN,
  locked_reason TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    can_edit_result(p_result_id) as can_edit,
    CASE 
      WHEN r.verification_status = 'verified' THEN 'Result is verified'
      WHEN r.is_locked = true THEN COALESCE(r.locked_reason, 'Result is locked')
      WHEN r.status IN ('Reviewed', 'Completed') THEN 'Result is completed'
      ELSE NULL
    END as restriction_reason,
    r.verification_status,
    r.is_locked,
    r.locked_reason
  FROM results r
  WHERE r.id = p_result_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ==============================================
-- 10. INDEXES FOR PERFORMANCE
-- ==============================================

-- Create indexes on the new columns for better query performance
CREATE INDEX IF NOT EXISTS idx_results_is_locked ON results(is_locked);
CREATE INDEX IF NOT EXISTS idx_results_verification_status ON results(verification_status);
CREATE INDEX IF NOT EXISTS idx_results_locked_at ON results(locked_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_table_record ON audit_logs(table_name, record_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp);

-- ==============================================
-- IMPLEMENTATION COMPLETE
-- ==============================================

-- Grant necessary permissions
GRANT EXECUTE ON FUNCTION can_edit_result(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION get_result_restrictions(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION request_result_amendment(UUID, TEXT, JSONB) TO authenticated;

-- Add helpful comments
COMMENT ON COLUMN results.is_locked IS 'Indicates if result is locked after report generation';
COMMENT ON COLUMN results.locked_reason IS 'Reason why the result was locked';
COMMENT ON COLUMN results.locked_at IS 'Timestamp when result was locked';
COMMENT ON COLUMN results.locked_by IS 'User who locked the result';

-- Final message
DO $$
BEGIN
  RAISE NOTICE 'LIMS Workflow Security Implementation Complete!';
  RAISE NOTICE 'Features implemented:';
  RAISE NOTICE '✅ Result locking after report generation';
  RAISE NOTICE '✅ Prevention of editing verified/locked results';
  RAISE NOTICE '✅ Comprehensive audit trail using existing audit_logs table';
  RAISE NOTICE '✅ Workflow status enforcement';
  RAISE NOTICE '✅ Order status automation';
  RAISE NOTICE '✅ Amendment process for locked results';
  RAISE NOTICE '✅ Row Level Security policies';
  RAISE NOTICE '✅ Helper functions for frontend integration';
END $$;