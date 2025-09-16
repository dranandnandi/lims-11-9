-- Create a proper user_labs table for managing user-lab relationships
-- This is the recommended approach for production systems

DO $$ 
BEGIN
    -- Create user_labs table if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'user_labs') THEN
        CREATE TABLE user_labs (
            id uuid NOT NULL DEFAULT gen_random_uuid(),
            user_id uuid NOT NULL,
            lab_id uuid NOT NULL,
            role text NOT NULL DEFAULT 'user',
            is_active boolean NOT NULL DEFAULT true,
            assigned_at timestamp with time zone NOT NULL DEFAULT now(),
            assigned_by uuid,
            CONSTRAINT user_labs_pkey PRIMARY KEY (id),
            CONSTRAINT user_labs_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id),
            CONSTRAINT user_labs_lab_id_fkey FOREIGN KEY (lab_id) REFERENCES labs(id),
            CONSTRAINT user_labs_assigned_by_fkey FOREIGN KEY (assigned_by) REFERENCES auth.users(id),
            CONSTRAINT user_labs_unique_user_lab UNIQUE (user_id, lab_id)
        );
        
        -- Create index for faster lookups
        CREATE INDEX idx_user_labs_user_id ON user_labs(user_id);
        CREATE INDEX idx_user_labs_lab_id ON user_labs(lab_id);
        
        RAISE NOTICE 'Created user_labs table';
    END IF;
    
    -- Assign all existing users to the first available lab
    INSERT INTO user_labs (user_id, lab_id, role)
    SELECT 
        u.id as user_id,
        (SELECT id FROM labs WHERE is_active = true LIMIT 1) as lab_id,
        'user' as role
    FROM auth.users u
    WHERE NOT EXISTS (
        SELECT 1 FROM user_labs ul WHERE ul.user_id = u.id
    );
    
    RAISE NOTICE 'Assigned existing users to labs';
END $$;