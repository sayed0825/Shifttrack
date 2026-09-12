-- ============================================================================
-- 0009_task_photos_scope.sql
--
-- Phase 3 security review, finding #1 (CRITICAL, still open): both
-- task-photos storage policies were just `bucket_id = 'task-photos'` --
-- no organisation or task-ownership scoping at all. Any authenticated
-- user, from any organisation on the platform, could read or overwrite
-- any other org's task-completion photos, since the underlying storage
-- policy is exactly what gates a createSignedUrl() call too (the signed
-- URL adds an expiry, not scoping).
--
-- Uploads write to `${task.id}/${uuid}.jpg` (see EmployeeTasks.tsx) -- the
-- path prefix is a task id, not an org id, so this can't be scoped the
-- same way org-logos was (by org_id prefix). Instead it resolves the
-- first path segment back to a task and reuses can_see_task(), the same
-- SECURITY DEFINER function task_comments' own policies already use to
-- decide who can see a given task (its assignee(s), or any manager in its
-- org) -- a task's photo should be visible under exactly the same rule as
-- its comment thread. can_see_task() already enforces org_id = my_org_id()
-- internally, so this closes the cross-tenant read/write both.
--
-- The path segment is validated as UUID-shaped with a regex before ever
-- casting it to uuid, inside a CASE (not relying on AND short-circuiting,
-- which Postgres does not guarantee) -- an unrelated or malformed object
-- path just evaluates to false rather than raising a cast error.
--
-- Known, pre-existing breadth this inherits rather than introduces:
-- can_see_task()'s manager branch is any is_manager() in the org, not
-- manages_location() like tasks_manager_all -- a location-scoped Manager
-- can already see (and comment on) a task outside their own locations via
-- this same function; extending it to photos does not add a new gap, it
-- matches the existing task_comments behaviour. Left alone here since
-- it's an intra-org visibility question, not the cross-tenant leak this
-- migration closes -- worth a look separately if you want it tightened.
--
-- No update/delete policy added: nothing in the app updates or deletes a
-- task-photos object directly (purge_old_task_photos() runs as postgres,
-- which bypasses storage RLS regardless of any policy here).
-- ============================================================================

drop policy if exists task_photos_read on storage.objects;
create policy task_photos_read on storage.objects for select
  to authenticated
  using (
    bucket_id = 'task-photos'
    and case
      when (storage.foldername(name))[1] ~ '^[0-9a-fA-F-]{36}$'
        then public.can_see_task(((storage.foldername(name))[1])::uuid)
      else false
    end
  );

drop policy if exists task_photos_write on storage.objects;
create policy task_photos_write on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'task-photos'
    and case
      when (storage.foldername(name))[1] ~ '^[0-9a-fA-F-]{36}$'
        then public.can_see_task(((storage.foldername(name))[1])::uuid)
      else false
    end
  );
