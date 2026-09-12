-- ============================================================================
-- 0014_can_see_task_location_scope.sql
--
-- can_see_task()'s manager branch was any is_manager() in the org, not
-- manages_location() like tasks_manager_all -- a location-scoped Manager
-- could already see, and comment on, a task outside their own locations
-- through this function. 0009 (task-photos storage scoping) reused
-- can_see_task() as-is and inherited that same breadth rather than
-- introducing it, on the reasoning that a photo should be visible under
-- the same rule as its task's comment thread; that inherited behaviour
-- was already wrong, not a reason to leave it as a precedent. Fixed here
-- at the source, which corrects it for task_comments and task-photos
-- both.
--
-- Tightened to (is_manager() and manages_location(t.location_id)),
-- matching the exact pairing tasks_manager_all/tmpl_manager_all/
-- shifts_manager_all already use -- manages_location() alone is not
-- sufficient here: a non-admin's my_managed_locations() is just "every
-- location I am assigned to" via profile_locations, with no can_manage
-- check of its own, so manages_location() by itself would let a mere
-- co-located employee (not a manager at all) through. is_manager() must
-- stay paired with it. The assignee/role-match branches are unchanged.
--
-- Known behaviour change: a task with a null location_id (nullable on
-- tasks) is no longer visible to a non-admin manager via the manager
-- branch, since manages_location(null) is false unless is_admin() short-
-- circuits it -- an Administrator is unaffected either way, since
-- manages_location() returns true unconditionally for is_admin(). Worth
-- confirming whether a location-less task is something that actually
-- occurs before running this.
-- ============================================================================

create or replace function public.can_see_task(p_task_id uuid)
 returns boolean
 language sql
 stable security definer
 set search_path to ''
as $function$
  select exists (
    select 1 from public.tasks t
    where t.id = p_task_id
      and t.org_id = public.my_org_id()
      and ((public.is_manager() and public.manages_location(t.location_id))
           or t.assigned_user_id = (select auth.uid())
           or t.assigned_role = public.my_role())
  );
$function$;
