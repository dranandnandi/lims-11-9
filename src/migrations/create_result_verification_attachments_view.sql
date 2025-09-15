-- Create view for result verification with attachments
-- This view joins result verification data with test-level and order-level attachments

CREATE OR REPLACE VIEW v_result_verification_with_attachments AS
SELECT 
    rv.*,
    r.order_id,
    r.patient_name,
    r.test_name,
    r.status as result_status,
    r.verification_status,
    r.is_locked,
    r.locked_reason,
    ot.test_name as order_test_name,
    ot.id as order_test_id,
    -- Get attachments at test level and order level
    COALESCE(
        jsonb_agg(
            DISTINCT jsonb_build_object(
                'id', att.id,
                'file_url', att.file_url,
                'file_type', att.file_type,
                'description', att.description,
                'original_filename', att.original_filename,
                'created_at', att.created_at,
                'level', CASE 
                    WHEN att.order_test_id IS NOT NULL THEN 'test'
                    ELSE 'order'
                END
            )
        ) FILTER (WHERE att.id IS NOT NULL), 
        '[]'::jsonb
    ) as attachments
FROM result_values rv
JOIN results r ON rv.result_id = r.id
LEFT JOIN order_tests ot ON r.order_test_id = ot.id
LEFT JOIN attachments att ON (
    -- Include test-level attachments
    (att.order_test_id = ot.id) OR
    -- Include order-level attachments as fallback
    (att.order_id = r.order_id AND att.order_test_id IS NULL)
)
GROUP BY rv.id, r.order_id, r.patient_name, r.test_name, r.status, 
         r.verification_status, r.is_locked, r.locked_reason, ot.test_name, ot.id;

-- Create index for performance
CREATE INDEX IF NOT EXISTS idx_result_verification_attachments 
ON result_values(result_id, verification_status);

COMMENT ON VIEW v_result_verification_with_attachments IS 
'View that combines result verification data with both test-level and order-level attachments for the verification console';