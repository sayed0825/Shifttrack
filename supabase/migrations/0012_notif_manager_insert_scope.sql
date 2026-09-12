-- ============================================================================
-- 0012_notif_manager_insert_scope.sql
--
-- Phase 3 security review, MEDIUM finding: notif_manager_insert let any
-- manager insert a notification, with arbitrary title/body, addressed to
-- any user_id in the org -- not just people they manage. A location
-- manager should not be able to send notifications to staff outside
-- their own locations.
--
-- Checked the one place the app inserts into notifications directly
-- (ManagerMoreTab's unavailability-decision handler, notifying the
-- requester after approving/denying their time off): it only runs after
-- updating that person's unavailability_requests row, which is already
-- gated by unavail_manager_all's manages_person(user_id) check -- so the
-- manager already had to manage that person to reach this point. Adding
-- the same check here does not break that flow. Every other notification
-- insert in the app goes through a trigger or notify_org_managers()/
-- notify_location_managers(), all SECURITY DEFINER and unaffected by this
-- policy.
-- ============================================================================

drop policy if exists notif_manager_insert on public.notifications;

create policy notif_manager_insert on public.notifications for insert
  to authenticated
  with check (is_manager() and org_id = my_org_id() and manages_person(user_id));
