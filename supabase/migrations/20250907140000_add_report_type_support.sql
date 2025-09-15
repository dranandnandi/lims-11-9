-- Add report_type field to support draft and final reports

BEGIN;

-- Add report_type column to reports table
DO $$ 
BEGIN
    -- Add report_type column if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_schema = 'public' 
                   AND table_name = 'reports' 
                   AND column_name = 'report_type') THEN
        ALTER TABLE reports ADD COLUMN report_type VARCHAR(20) DEFAULT 'final';
        
        -- Update existing records to be 'final' type
        UPDATE reports SET report_type = 'final' WHERE report_type IS NULL;
        
        -- Add constraint to ensure only valid values
        ALTER TABLE reports ADD CONSTRAINT reports_report_type_check 
        CHECK (report_type IN ('draft', 'final'));
        
        -- Add index for better performance on report type queries
        CREATE INDEX idx_reports_order_type 
        ON reports(order_id, report_type);
    END IF;
END $$;

-- Update comments for documentation
COMMENT ON COLUMN reports.report_type IS 'Type of report: draft (partial results) or final (all results approved)';

COMMIT;