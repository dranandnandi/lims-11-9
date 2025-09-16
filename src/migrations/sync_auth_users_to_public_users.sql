-- Function to automatically create public.users record when auth.users is created
-- This ensures every authenticated user has a corresponding users table record

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
DECLARE
    default_lab_id uuid;
BEGIN
    -- Get the first active lab as default
    SELECT id INTO default_lab_id 
    FROM labs 
    WHERE is_active = true 
    ORDER BY created_at ASC 
    LIMIT 1;
    
    -- Insert new user into public.users table
    INSERT INTO public.users (
        id,
        name,
        email,
        role,
        status,
        lab_id,
        join_date,
        created_at,
        updated_at
    ) VALUES (
        NEW.id,
        COALESCE(NEW.raw_user_meta_data->>'name', NEW.email), -- Use name from metadata or email
        NEW.email,
        'Technician', -- Default role
        'Active',
        COALESCE((NEW.raw_user_meta_data->>'lab_id')::uuid, default_lab_id), -- Use lab_id from metadata or default
        CURRENT_DATE,
        NOW(),
        NOW()
    )
    ON CONFLICT (id) DO NOTHING; -- Don't overwrite if already exists
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create trigger to automatically handle new user creation
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Also create a function to sync existing auth.users to public.users
DO $$
DECLARE
    auth_user RECORD;
    default_lab_id uuid;
BEGIN
    -- Get default lab
    SELECT id INTO default_lab_id 
    FROM labs 
    WHERE is_active = true 
    ORDER BY created_at ASC 
    LIMIT 1;
    
    -- Sync existing auth.users to public.users
    FOR auth_user IN 
        SELECT au.id, au.email, au.raw_user_meta_data, au.created_at
        FROM auth.users au
        LEFT JOIN public.users pu ON au.id = pu.id
        WHERE pu.id IS NULL -- Only users not already in public.users
    LOOP
        INSERT INTO public.users (
            id,
            name,
            email,
            role,
            status,
            lab_id,
            join_date,
            created_at,
            updated_at
        ) VALUES (
            auth_user.id,
            COALESCE(auth_user.raw_user_meta_data->>'name', auth_user.email),
            auth_user.email,
            'Technician',
            'Active',
            COALESCE((auth_user.raw_user_meta_data->>'lab_id')::uuid, default_lab_id),
            auth_user.created_at::date,
            auth_user.created_at,
            NOW()
        );
        
        RAISE NOTICE 'Synced user: % with lab_id: %', auth_user.email, COALESCE((auth_user.raw_user_meta_data->>'lab_id')::uuid, default_lab_id);
    END LOOP;
END $$;