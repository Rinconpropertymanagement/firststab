CREATE TABLE IF NOT EXISTS insurance_user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'director_of_operations', 'property_manager', 'inspection_coordinator')),
  assigned_by TEXT,
  assigned_at TIMESTAMPTZ DEFAULT now(),
  last_login TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

INSERT INTO insurance_user_roles (email, role, assigned_by)
VALUES ('peter@rinconmanagement.com', 'admin', 'system')
ON CONFLICT (email) DO NOTHING;

CREATE TABLE IF NOT EXISTS insurance_role_changes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  changed_by TEXT NOT NULL,
  target_email TEXT NOT NULL,
  old_role TEXT,
  new_role TEXT NOT NULL,
  changed_at TIMESTAMPTZ DEFAULT now()
);
