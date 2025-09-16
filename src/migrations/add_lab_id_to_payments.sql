-- Add lab_id column to payments table if it doesn't exist
-- This migration is safe to run multiple times

DO $$ 
BEGIN
    -- Add lab_id column to payments table if it doesn't exist
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'payments' 
        AND column_name = 'lab_id'
    ) THEN
        ALTER TABLE payments ADD COLUMN lab_id uuid;
        
        -- Add foreign key constraint
        ALTER TABLE payments 
        ADD CONSTRAINT payments_lab_id_fkey 
        FOREIGN KEY (lab_id) REFERENCES labs(id);
        
        -- Update existing payments with lab_id from their related invoices
        UPDATE payments 
        SET lab_id = invoices.lab_id 
        FROM invoices 
        WHERE payments.invoice_id = invoices.id;
        
        RAISE NOTICE 'Added lab_id column to payments table and populated existing records';
    ELSE
        RAISE NOTICE 'lab_id column already exists in payments table';
    END IF;
END $$;