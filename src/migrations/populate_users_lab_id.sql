-- Populate users table with lab_id assignments
-- This ensures proper lab associations for existing users

DO $$ 
DECLARE
    default_lab_id uuid;
BEGIN
    -- Get the first active lab as default
    SELECT id INTO default_lab_id 
    FROM labs 
    WHERE is_active = true 
    ORDER BY created_at ASC 
    LIMIT 1;
    
    IF default_lab_id IS NULL THEN
        RAISE EXCEPTION 'No active labs found. Please create at least one active lab first.';
    END IF;
    
    -- Update users without lab_id to use the default lab
    UPDATE users 
    SET lab_id = default_lab_id,
        updated_at = now()
    WHERE lab_id IS NULL;
    
    -- Get count of updated users
    GET DIAGNOSTICS $1 = ROW_COUNT;
    
    RAISE NOTICE 'Updated % users with default lab_id: %', $1, default_lab_id;
    
    -- Show current user-lab assignments
    RAISE NOTICE 'Current user-lab assignments:';
    FOR rec IN 
        SELECT u.name, u.email, l.name as lab_name, u.lab_id
        FROM users u
        LEFT JOIN labs l ON u.lab_id = l.id
        ORDER BY u.name
    LOOP
        RAISE NOTICE 'User: % (%) -> Lab: % (%)', rec.name, rec.email, rec.lab_name, rec.lab_id;
    END LOOP;
    
END $$;