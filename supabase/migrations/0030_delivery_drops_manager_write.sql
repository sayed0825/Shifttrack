-- ============================================================================
-- 0030_delivery_drops_manager_write.sql
--
-- Step 2's manager time-log-edit UI needs to add and remove individual
-- drops on a driver's run, not just edit the run's one_way_miles -- 0028
-- only gave delivery_drops owner-insert + (owner-or-managed) select, no
-- manager write path and no delete for anyone at all (deliberately
-- append-only at the time, matching task_comments/task_photos). Deleting
-- a whole run already cascades its drops (delivery_drops.run_id
-- references delivery_runs(id) on delete cascade); this is specifically
-- for removing one drop while keeping the run and its other drops.
--
-- Same shape as delivery_runs_manager_all: is_manager() + manages_person()
-- of the run's shift owner, joined through delivery_runs -> time_logs.
-- Not open to the driver themselves -- point 6 keeps a driver's own
-- write access to drops exactly as 0028 defined it (insert on their own
-- open shift only, never delete), this is additive for a manager only.
-- ============================================================================

begin;

create policy delivery_drops_manager_write
  on public.delivery_drops
  for all
  to authenticated
  using (
    org_id = public.my_org_id()
    and public.is_manager()
    and exists (
      select 1 from public.delivery_runs dr
      join public.time_logs tl on tl.id = dr.time_log_id
      where dr.id = run_id and public.manages_person(tl.user_id)
    )
  )
  with check (
    org_id = public.my_org_id()
    and public.is_manager()
    and exists (
      select 1 from public.delivery_runs dr
      join public.time_logs tl on tl.id = dr.time_log_id
      where dr.id = run_id and public.manages_person(tl.user_id)
    )
  );

commit;
