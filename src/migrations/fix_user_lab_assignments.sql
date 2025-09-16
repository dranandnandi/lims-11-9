-- Update user metadata to include lab_id
-- Run this in your Supabase SQL editor

-- First, see which users exist and which labs are available
SELECT 
  u.id as user_id,
  u.email,
  l.id as lab_id,
  l.name as lab_name
FROM auth.users u
CROSS JOIN labs l 
WHERE l.is_active = true
ORDER BY u.email, l.name;

-- Update specific user with lab_id (replace with actual values)
-- UPDATE auth.users 
-- SET raw_user_meta_data = raw_user_meta_data || '{"lab_id": "373e821a-447b-4bcb-9859-4b695f5dfbba"}'::jsonb
-- WHERE email = 'your-user@example.com';

-- Or update all users to use the first available lab (for development)
UPDATE auth.users 
SET raw_user_meta_data = raw_user_meta_data || 
  jsonb_build_object('lab_id', (SELECT id FROM labs WHERE is_active = true LIMIT 1))
WHERE raw_user_meta_data->>'lab_id' IS NULL;