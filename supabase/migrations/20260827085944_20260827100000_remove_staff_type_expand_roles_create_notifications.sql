-- ============================================================================
-- 1. Drop the protect_profile_role trigger and recreate without staff_type
-- ============================================================================

DROP TRIGGER IF EXISTS protect_profile_role ON public.profiles;

CREATE OR REPLACE FUNCTION public.tg_protect_profile_role()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
  BEGIN
    IF NEW.role IS DISTINCT FROM OLD.role AND NOT public.is_manager()
    THEN
      RAISE EXCEPTION 'Only a Manager may change role' USING errcode = '42501';
    END IF;
    RETURN NEW;
  END;
$function$;

CREATE TRIGGER protect_profile_role
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_protect_profile_role();

-- ============================================================================
-- 2. Remove staff_type column and enum from profiles
-- ============================================================================

ALTER TABLE public.profiles DROP COLUMN IF EXISTS staff_type;

DROP TYPE IF EXISTS public.staff_type;

-- ============================================================================
-- 3. Expand user_role: convert from enum to text with CHECK constraint
-- ============================================================================

ALTER TABLE public.profiles ADD COLUMN role_text text NOT NULL DEFAULT 'Employee';

UPDATE public.profiles SET role_text = role::text;

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE public.profiles DROP COLUMN role;

ALTER TABLE public.profiles RENAME COLUMN role_text TO role;

ALTER TABLE public.profiles ADD CONSTRAINT profiles_role_check
  CHECK (role IN (
    'Manager',
    'Employee',
    'Driver',
    'FOH',
    'KA',
    'Head Chef',
    'Second Chef',
    'Cook',
    'Tandoori Chef',
    'Kitchen Porter'
  ));

DROP TYPE IF EXISTS public.user_role;

-- ============================================================================
-- 4. Create notifications table
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  type text NOT NULL DEFAULT 'shift_changed',
  title text NOT NULL,
  body text,
  is_read boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS notif_select_own ON public.notifications;
CREATE POLICY notif_select_own ON public.notifications
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS notif_update_own ON public.notifications;
CREATE POLICY notif_update_own ON public.notifications
  FOR UPDATE TO authenticated USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS notif_insert_own ON public.notifications;
CREATE POLICY notif_insert_own ON public.notifications
  FOR INSERT TO authenticated WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS notif_delete_own ON public.notifications;
CREATE POLICY notif_delete_own ON public.notifications
  FOR DELETE TO authenticated USING (user_id = (SELECT auth.uid()));

CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON public.notifications (user_id, created_at DESC);