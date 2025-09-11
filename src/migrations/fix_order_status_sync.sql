-- Fix for Order Status and Sample Collection Status Synchronization
-- This migration ensures order status stays in sync with sample collection status

-- ==============================================
-- 1. CREATE FUNCTION TO SYNC ORDER STATUS WITH SAMPLE COLLECTION
-- ==============================================

CREATE OR REPLACE FUNCTION sync_order_status_with_sample_collection()
RETURNS TRIGGER AS $$
BEGIN
  -- When sample collection fields are updated
  IF TG_OP = 'UPDATE' THEN
    -- If sample was just collected (sample_collected_at was null, now has value)
    IF OLD.sample_collected_at IS NULL AND NEW.sample_collected_at IS NOT NULL THEN
      NEW.status = 'Sample Collected';
      NEW.status_updated_at = NOW();
      
      -- Log the status change
      INSERT INTO audit_logs (
        table_name,
        record_id,
        action,
        old_values,
        new_values,
        user_id,
        user_email
      ) VALUES (
        'orders',
        NEW.id,
        'SAMPLE_COLLECTED_STATUS_SYNC',
        jsonb_build_object('old_status', OLD.status),
        jsonb_build_object('new_status', NEW.status, 'reason', 'Sample collection updated'),
        COALESCE(auth.uid(), '00000000-0000-0000-0000-000000000000'::uuid),
        COALESCE((SELECT email FROM auth.users WHERE id = auth.uid()), 'system')
      );
    END IF;
    
    -- If sample collection was removed (sample_collected_at had value, now null)
    IF OLD.sample_collected_at IS NOT NULL AND NEW.sample_collected_at IS NULL THEN
      NEW.status = 'Pending Collection';
      NEW.status_updated_at = NOW();
      
      -- Log the status change
      INSERT INTO audit_logs (
        table_name,
        record_id,
        action,
        old_values,
        new_values,
        user_id,
        user_email
      ) VALUES (
        'orders',
        NEW.id,
        'SAMPLE_UNCOLLECTED_STATUS_SYNC',
        jsonb_build_object('old_status', OLD.status),
        jsonb_build_object('new_status', NEW.status, 'reason', 'Sample collection removed'),
        COALESCE(auth.uid(), '00000000-0000-0000-0000-000000000000'::uuid),
        COALESCE((SELECT email FROM auth.users WHERE id = auth.uid()), 'system')
      );
    END IF;
    
    -- Prevent manual status changes that conflict with sample collection
    IF OLD.sample_collected_at IS NOT NULL AND NEW.status = 'Pending Collection' AND NEW.sample_collected_at IS NOT NULL THEN
      RAISE EXCEPTION 'Cannot set status to "Pending Collection" when sample is already collected. Clear sample collection first.';
    END IF;
    
    IF OLD.sample_collected_at IS NULL AND NEW.status = 'Sample Collected' AND NEW.sample_collected_at IS NULL THEN
      RAISE EXCEPTION 'Cannot set status to "Sample Collected" without setting sample collection details.';
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create trigger for order status synchronization
DROP TRIGGER IF EXISTS sync_order_sample_status ON orders;
CREATE TRIGGER sync_order_sample_status
  BEFORE UPDATE ON orders
  FOR EACH ROW
  EXECUTE FUNCTION sync_order_status_with_sample_collection();

-- ==============================================
-- 2. FIX EXISTING DATA INCONSISTENCIES
-- ==============================================

-- Update orders where sample is collected but status is wrong
UPDATE orders 
SET 
  status = 'Sample Collected',
  status_updated_at = NOW()
WHERE 
  sample_collected_at IS NOT NULL 
  AND sample_collected_by IS NOT NULL 
  AND status = 'Pending Collection';

-- Update orders where sample is not collected but status says collected
UPDATE orders 
SET 
  status = 'Pending Collection',
  status_updated_at = NOW()
WHERE 
  (sample_collected_at IS NULL OR sample_collected_by IS NULL)
  AND status = 'Sample Collected';

-- Log the data fix (without user_id to avoid foreign key constraint)
INSERT INTO audit_logs (
  table_name,
  record_id,
  action,
  new_values,
  user_email
) VALUES (
  'orders',
  gen_random_uuid(),
  'BULK_STATUS_SYNC_FIX',
  jsonb_build_object(
    'description', 'Fixed inconsistencies between order status and sample collection status',
    'timestamp', NOW(),
    'affected_orders', (SELECT COUNT(*) FROM orders WHERE 
      (sample_collected_at IS NOT NULL AND sample_collected_by IS NOT NULL AND status = 'Pending Collection') OR
      ((sample_collected_at IS NULL OR sample_collected_by IS NULL) AND status = 'Sample Collected')
    )
  ),
  'system_migration'
);

-- ==============================================
-- 3. CREATE HELPER FUNCTION TO CHECK STATUS CONSISTENCY
-- ==============================================

CREATE OR REPLACE FUNCTION check_order_status_consistency(p_order_id UUID)
RETURNS TABLE(
  order_id UUID,
  current_status TEXT,
  sample_collected BOOLEAN,
  is_consistent BOOLEAN,
  recommended_status TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    o.id as order_id,
    o.status::TEXT as current_status,
    (o.sample_collected_at IS NOT NULL AND o.sample_collected_by IS NOT NULL) as sample_collected,
    CASE 
      WHEN o.sample_collected_at IS NOT NULL AND o.sample_collected_by IS NOT NULL AND o.status = 'Sample Collected' THEN true
      WHEN (o.sample_collected_at IS NULL OR o.sample_collected_by IS NULL) AND o.status = 'Pending Collection' THEN true
      ELSE false
    END as is_consistent,
    CASE 
      WHEN o.sample_collected_at IS NOT NULL AND o.sample_collected_by IS NOT NULL THEN 'Sample Collected'
      ELSE 'Pending Collection'
    END as recommended_status
  FROM orders o
  WHERE o.id = p_order_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ==============================================
-- 4. CREATE VIEW FOR CONSISTENT ORDER STATUS
-- ==============================================

CREATE OR REPLACE VIEW orders_with_consistent_status AS
SELECT 
  o.*,
  CASE 
    WHEN o.sample_collected_at IS NOT NULL AND o.sample_collected_by IS NOT NULL THEN 'Sample Collected'
    WHEN o.status IN ('Order Created', 'Pending Collection') THEN 'Pending Collection'
    ELSE o.status
  END as consistent_status,
  (o.sample_collected_at IS NOT NULL AND o.sample_collected_by IS NOT NULL) as is_sample_collected
FROM orders o;

-- ==============================================
-- 5. GRANT PERMISSIONS
-- ==============================================

GRANT EXECUTE ON FUNCTION check_order_status_consistency(UUID) TO authenticated;
GRANT SELECT ON orders_with_consistent_status TO authenticated;

-- ==============================================
-- IMPLEMENTATION NOTES
-- ==============================================

DO $$
BEGIN
  RAISE NOTICE 'Order Status Synchronization Implementation Complete!';
  RAISE NOTICE 'Changes made:';
  RAISE NOTICE '✅ Added trigger to sync order status with sample collection';
  RAISE NOTICE '✅ Fixed existing data inconsistencies';
  RAISE NOTICE '✅ Added helper function to check status consistency';
  RAISE NOTICE '✅ Created view for consistent order status';
  RAISE NOTICE '✅ Added audit logging for status changes';
  RAISE NOTICE '';
  RAISE NOTICE 'The system will now automatically:';
  RAISE NOTICE '- Update order status to "Sample Collected" when sample collection is recorded';
  RAISE NOTICE '- Update order status to "Pending Collection" when sample collection is removed';
  RAISE NOTICE '- Prevent conflicting manual status changes';
  RAISE NOTICE '- Log all status synchronization actions';
END $$;