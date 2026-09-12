-- ============================================================================
-- 0008_profile_locations_scope.sql
--
-- Phase 3 security review, finding #3 (CRITICAL): proflocs_manager_all had
-- no manages_location()/manages_person() check at all -- any manager,
-- including a location-scoped one, could INSERT/UPDATE/DELETE a
-- profile_locations row for any employee and any location in the org,
-- regardless of whether they managed either. Since manages_person() is
-- itself derived from profile_locations, this let a scoped Manager expand
-- their own effective reach by reassigning an otherwise out-of-scope
-- employee onto a location they do manage.
--
-- Scoped by manages_location(location_id), the same pattern already used
-- by shifts_manager_all/tasks_manager_all/tmpl_manager_all -- not by
-- manages_person(profile_id). A manager must be allowed to assign a
-- brand-new employee (one they do not yet manage) onto a location they do
-- manage; requiring manages_person on the target profile would make that
-- core "add someone to my location" workflow impossible, since that
-- employee's management relationship doesn't exist until this row does.
--
-- Known follow-on, not fixed here (app-side, not a schema change):
-- StaffManager's toggleLocation, after removing a person's primary
-- location, promotes their next remaining location to primary via a
-- separate UPDATE. If that remaining location is not one the acting
-- manager manages, this policy will now correctly reject that promotion.
-- That is the RLS working as intended, but the app does not yet handle
-- the resulting error gracefully.
-- ============================================================================

drop policy if exists proflocs_manager_all on public.profile_locations;

create policy proflocs_manager_all on public.profile_locations for all
  to authenticated
  using (is_manager() and org_id = my_org_id() and manages_location(location_id))
  with check (is_manager() and org_id = my_org_id() and manages_location(location_id));
