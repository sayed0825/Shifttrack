-- ============================================================================
-- 0024_reminders_manager_scope.sql
--
-- Reminders were admin-only to write. Managers should be able to send them
-- too, scoped exactly like everything else a manager touches: a role at a
-- location they manage, or an individual they manage. Not org-wide, and
-- not outside their scope.
--
-- Same pattern as tasks_manager_all/tmpl_manager_all: a single policy using
-- is_manager() + manages_location()/manages_person() covers Administrators
-- too, since manages_location() and manages_person() both return true
-- unconditionally for is_admin() internally, and every Administrator role
-- in this schema already has can_manage = true (confirmed live: both
-- orgs' Administrator role has can_manage = true, is_admin = true) --
-- there is deliberately no separate admin-only policy left alongside this
-- one, matching that precedent exactly.
--
-- is_manager() is still required explicitly, not implied by
-- manages_location()/manages_person() alone: my_managed_locations() (which
-- both of those are built on) returns a NON-admin caller's own
-- profile_locations rows regardless of whether they can_manage at all --
-- without this, a plain employee could satisfy manages_location() for
-- their own location and create a reminder targeting their own role there.
-- task_templates_admin_all's replacement (tmpl_manager_all) already carries
-- this same explicit is_manager() guard for the identical reason.
--
-- A manager-created reminder with target_location_id null (org-wide) is
-- rejected automatically, not by a separate check: manages_location(null)
-- returns false for a non-admin caller (see its definition), true only for
-- is_admin(). No individual-targeted reminder has a location to check at
-- all -- manages_person(target_user_id) is the whole condition there,
-- exactly as for a role target's manages_location(target_location_id).
-- ============================================================================

drop policy reminder_templates_admin_all on public.reminder_templates;
create policy reminder_templates_manager_write
  on public.reminder_templates
  for all
  to authenticated
  using (
    org_id = public.my_org_id()
    and public.is_manager()
    and (
      (target_user_id is not null and public.manages_person(target_user_id))
      or (target_role is not null and public.manages_location(target_location_id))
    )
  )
  with check (
    org_id = public.my_org_id()
    and public.is_manager()
    and (
      (target_user_id is not null and public.manages_person(target_user_id))
      or (target_role is not null and public.manages_location(target_location_id))
    )
  );

drop policy reminders_admin_all on public.reminders;
create policy reminders_manager_write
  on public.reminders
  for all
  to authenticated
  using (
    org_id = public.my_org_id()
    and public.is_manager()
    and (
      (target_user_id is not null and public.manages_person(target_user_id))
      or (target_role is not null and public.manages_location(target_location_id))
    )
  )
  with check (
    org_id = public.my_org_id()
    and public.is_manager()
    and (
      (target_user_id is not null and public.manages_person(target_user_id))
      or (target_role is not null and public.manages_location(target_location_id))
    )
  );
