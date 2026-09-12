-- ============================================================================
-- 0007_least_privilege_grants.sql
--
-- Phase 3 security review, findings 16 and 17: a long list of internal
-- helper functions carried EXECUTE grants to anon and bare PUBLIC (every
-- authenticated *and* unauthenticated caller on the platform), left over
-- from however each was originally created. None of them were actually
-- exploitable through that grant alone -- each is either side-effect-free
-- and self-scoped, or (the four RPCs below) has its own internal
-- is_manager()/manages_person()/manages_location() check that correctly
-- rejects an unauthorised caller -- but the exposure itself should not
-- have existed. This migration revokes it down to exactly what each
-- function is actually used for.
--
-- delete_staff_member(), approve_shift_swap(), approve_shift_application(),
-- and decide_overtime_claim() are called out specifically: they were
-- reachable by anon (rejected only by their own internal checks), and they
-- destroy or alter payroll/staffing data. A function that can delete a
-- staff member or approve a payroll-affecting claim should never have been
-- callable by a request with no session at all, defense-in-depth or not.
--
-- Also revoked: is_active_user(). It has the exact same anon+PUBLIC
-- exposure as the functions in the original findings 16/17 list, but was
-- missed from that report -- it should have been included; fixed here
-- alongside the rest, flagged so the omission is visible rather than
-- silently corrected.
--
-- Verified via `grep -rn "rpc('<name>'" src supabase/functions` which of
-- the 15 named functions the client (or the invite-staff Edge Function)
-- actually calls directly, and cross-checked every RLS policy in the
-- database for direct references, since a policy's USING/CHECK expression
-- runs as the querying role (authenticated) and needs EXECUTE on whatever
-- it calls, regardless of that function's own SECURITY DEFINER status.
-- Every one of the 15 is used by at least one of those two paths:
--   client/Edge Function call only:   my_late_grace_minutes,
--                                      delete_staff_member, approve_shift_swap,
--                                      approve_shift_application, decide_overtime_claim
--   RLS policy only:                  my_role, manages_person, manages_location,
--                                      can_see_task, my_can_view_map, is_active_user
--   both:                             is_admin, is_manager, my_org_id,
--                                      my_managed_locations
--
-- haversine_meters() is NOT in that granted set, on the same "does the app
-- actually invoke it" test: it is only ever called from inside
-- verify_geofenced_clock_in() (which runs under that function's own
-- SECURITY DEFINER context, not the caller's), and appears in no RLS
-- policy and no direct client call. It gets no grant at all, same
-- treatment as the trigger-only functions below.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Revoke anon/PUBLIC, keep authenticated-only, for the functions the app
-- (client, Edge Function, or an RLS policy) genuinely calls.
-- ----------------------------------------------------------------------------

revoke all on function public.is_admin() from public, anon, authenticated;
grant execute on function public.is_admin() to authenticated;

revoke all on function public.is_manager() from public, anon, authenticated;
grant execute on function public.is_manager() to authenticated;

revoke all on function public.my_org_id() from public, anon, authenticated;
grant execute on function public.my_org_id() to authenticated;

revoke all on function public.my_role() from public, anon, authenticated;
grant execute on function public.my_role() to authenticated;

revoke all on function public.my_managed_locations() from public, anon, authenticated;
grant execute on function public.my_managed_locations() to authenticated;

revoke all on function public.my_can_view_map() from public, anon, authenticated;
grant execute on function public.my_can_view_map() to authenticated;

revoke all on function public.my_late_grace_minutes() from public, anon, authenticated;
grant execute on function public.my_late_grace_minutes() to authenticated;

revoke all on function public.manages_person(uuid) from public, anon, authenticated;
grant execute on function public.manages_person(uuid) to authenticated;

revoke all on function public.manages_location(uuid) from public, anon, authenticated;
grant execute on function public.manages_location(uuid) to authenticated;

revoke all on function public.can_see_task(uuid) from public, anon, authenticated;
grant execute on function public.can_see_task(uuid) to authenticated;

revoke all on function public.is_active_user() from public, anon, authenticated;
grant execute on function public.is_active_user() to authenticated;

-- Destroys or alters payroll/staffing data. Previously anon-reachable,
-- rejected only by the is_manager()/manages_person()/manages_location()
-- check inside each -- should never have been callable without a session.
revoke all on function public.delete_staff_member(uuid) from public, anon, authenticated;
grant execute on function public.delete_staff_member(uuid) to authenticated;

revoke all on function public.approve_shift_swap(uuid) from public, anon, authenticated;
grant execute on function public.approve_shift_swap(uuid) to authenticated;

revoke all on function public.approve_shift_application(uuid) from public, anon, authenticated;
grant execute on function public.approve_shift_application(uuid) to authenticated;

revoke all on function public.decide_overtime_claim(uuid, boolean) from public, anon, authenticated;
grant execute on function public.decide_overtime_claim(uuid, boolean) to authenticated;


-- ----------------------------------------------------------------------------
-- No grant at all: never called directly by the client, an Edge Function,
-- or an RLS policy -- only reachable today via a nested call from inside
-- another SECURITY DEFINER function, which runs under that function's own
-- privileges and needs no grant of its own.
-- ----------------------------------------------------------------------------

revoke all on function public.haversine_meters(double precision, double precision, double precision, double precision)
  from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- tg_* trigger functions and the rls_auto_enable event trigger: revoke
-- from anon, PUBLIC, and authenticated entirely. Postgres refuses to
-- invoke a trigger-returning or event_trigger-returning function except
-- as an actual trigger, so no API-layer grant is ever needed for these.
-- ----------------------------------------------------------------------------

revoke all on function public.tg_application_notify() from public, anon, authenticated;
revoke all on function public.tg_handle_new_user() from public, anon, authenticated;
revoke all on function public.tg_overtime_notify() from public, anon, authenticated;
revoke all on function public.tg_protect_profile_role() from public, anon, authenticated;
revoke all on function public.tg_role_deleted() from public, anon, authenticated;
revoke all on function public.tg_role_renamed() from public, anon, authenticated;
revoke all on function public.tg_set_updated_at() from public, anon, authenticated;
revoke all on function public.tg_shift_delete_notify() from public, anon, authenticated;
revoke all on function public.tg_shift_insert_notify() from public, anon, authenticated;
revoke all on function public.tg_shift_update_notify() from public, anon, authenticated;
revoke all on function public.tg_swap_notify() from public, anon, authenticated;
revoke all on function public.tg_sync_profile_accepted_at() from public, anon, authenticated;
revoke all on function public.tg_sync_profile_email() from public, anon, authenticated;
revoke all on function public.tg_task_comment_notify() from public, anon, authenticated;
revoke all on function public.tg_task_notify() from public, anon, authenticated;
revoke all on function public.tg_timelog_update_notify() from public, anon, authenticated;
revoke all on function public.tg_unavailability_notify() from public, anon, authenticated;
revoke all on function public.rls_auto_enable() from public, anon, authenticated;
