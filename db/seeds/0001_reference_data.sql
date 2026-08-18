-- Reference data required for a functioning install (not user data).
-- Role ids are load-bearing: lib/session.ts hardcodes role 1 = super_admin.

INSERT INTO public.roles (id, name) VALUES
  (1, 'super_admin'),
  (2, 'admin'),
  (3, 'editor'),
  (4, 'viewer'),
  (5, 'pending')
ON CONFLICT (id) DO NOTHING;

-- resource_types is empty in the current database; resources.resource_type_id
-- is unused in application code. Left intentionally unseeded.
