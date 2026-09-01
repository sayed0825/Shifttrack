/*
# Create profile_locations and unavailability_requests tables

1. New Tables
- `profile_locations`: many-to-many relationship between profiles and locations.
  - `profile_id` (uuid, references profiles.id, cascade delete)
  - `location_id` (uuid, references locations.id, cascade delete)
  - `is_primary` (boolean, default false) — marks the employee's main location
  - `created_at` (timestamptz, default now())
  - Composite primary key on (profile_id, location_id)
- `unavailability_requests`: time-off / unavailability requests from employees.
  - `id` (uuid, primary key, default gen_random_uuid())
  - `user_id` (uuid, references profiles.id, cascade delete)
  - `start_date` (date, not null)
  - `end_date` (date, not null)
  - `reason` (text, nullable)
  - `status` (text, not null default 'pending', check: pending/approved/denied)
  - `decided_by` (uuid, nullable, references profiles.id)
  - `decided_at` (timestamptz, nullable)
  - `created_at` (timestamptz, not null default now())
  - CHECK constraint: end_date >= start_date
  - CHECK constraint: status in ('pending','approved','denied')

2. Security
- `profile_locations`: RLS enabled.
  - SELECT: employees can read their own profile_locations rows.
  - All CRUD: managers can do everything (using public.is_manager()).
- `unavailability_requests`: RLS enabled.
  - SELECT: employees can read their own requests.
  - INSERT: employees can insert their own requests.
  - All CRUD: managers can do everything (using public.is_manager()).

3. Indexes
- `profile_locations` index on `location_id` for filtering by location.
- `unavailability_requests` index on `(user_id, start_date)` for querying by user and date range.
*/

CREATE TABLE IF NOT EXISTS public.profile_locations (
  profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, location_id)
);

ALTER TABLE public.profile_locations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS proflocs_select_own ON public.profile_locations;
CREATE POLICY proflocs_select_own ON public.profile_locations
  FOR SELECT TO authenticated USING (profile_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS proflocs_manager_all ON public.profile_locations;
CREATE POLICY proflocs_manager_all ON public.profile_locations
  FOR ALL TO authenticated
  USING (public.is_manager()) WITH CHECK (public.is_manager());

CREATE INDEX IF NOT EXISTS idx_profile_locations_location_id ON public.profile_locations (location_id);

CREATE TABLE IF NOT EXISTS public.unavailability_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  start_date date NOT NULL,
  end_date date NOT NULL,
  reason text,
  status text NOT NULL DEFAULT 'pending',
  decided_by uuid REFERENCES public.profiles(id),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT unavail_date_order CHECK (end_date >= start_date),
  CONSTRAINT unavail_status CHECK (status IN ('pending','approved','denied'))
);

ALTER TABLE public.unavailability_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS unavail_select_own ON public.unavailability_requests;
CREATE POLICY unavail_select_own ON public.unavailability_requests
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS unavail_insert_own ON public.unavailability_requests;
CREATE POLICY unavail_insert_own ON public.unavailability_requests
  FOR INSERT TO authenticated WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS unavail_manager_all ON public.unavailability_requests;
CREATE POLICY unavail_manager_all ON public.unavailability_requests
  FOR ALL TO authenticated
  USING (public.is_manager()) WITH CHECK (public.is_manager());

CREATE INDEX IF NOT EXISTS idx_unavailability_requests_user_start ON public.unavailability_requests (user_id, start_date);
