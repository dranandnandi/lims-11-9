-- Add is_hidden column to users table for soft delete functionality
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS is_hidden boolean DEFAULT false;

-- Recreate v_users_with_permissions to expose is_hidden.
-- NOTE: This must match the LIVE view definition exactly (from
-- 20260430120000_effective_permissions_and_department_rights.sql) with is_hidden
-- appended as the final column. CREATE OR REPLACE VIEW only permits adding new
-- columns at the end; existing columns must keep the same name/type/order.
CREATE OR REPLACE VIEW public.v_users_with_permissions AS
SELECT
  u.id,
  u.name,
  u.email,
  u.username,
  u.contact_number,
  u.gender,
  u.status,
  u.join_date,
  u.last_login,
  u.lab_id,
  u.department_id,
  u.auth_user_id,
  u.is_phlebotomist,
  ur.id AS role_id,
  ur.role_name,
  ur.role_code,
  public.get_effective_permissions(u.id) AS permissions,
  array_agg(DISTINCT uc.location_id) FILTER (WHERE uc.location_id IS NOT NULL) AS assigned_centers,
  COALESCE(u.permissions, ARRAY[]::varchar[]) AS extra_permissions,
  u.is_hidden
FROM public.users u
LEFT JOIN public.user_roles ur ON u.role_id = ur.id
LEFT JOIN public.user_centers uc ON u.id = uc.user_id
WHERE u.status = 'Active'
GROUP BY
  u.id, u.name, u.email, u.username, u.contact_number, u.gender,
  u.status, u.join_date, u.last_login, u.lab_id, u.department_id,
  u.auth_user_id, u.is_phlebotomist, u.permissions, ur.id, ur.role_name, ur.role_code;

-- Grant permissions
GRANT SELECT ON public.v_users_with_permissions TO authenticated;

COMMENT ON COLUMN public.users.is_hidden IS 'When true, user is soft-deleted and should not appear in user management lists';
