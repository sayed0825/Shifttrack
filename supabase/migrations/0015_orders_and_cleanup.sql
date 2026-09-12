-- ============================================================================
-- 0015_orders_and_cleanup.sql
--
-- Schema only. Checked the live schema via the MCP before writing any of
-- this:
--   - roles has no tracks_orders column yet.
--   - time_logs has no orders_count or extra_miles columns yet.
--   - Both orgs have exactly one role named exactly 'Driver' (neither
--     is_protected).
--   - time_logs_update_own_open is exactly `org_id = my_org_id() and
--     user_id = auth.uid() and clock_out is null`, with_check just
--     `user_id = auth.uid()` -- no column restriction, and no existing
--     policy allows updating a CLOSED log at all.
--   - locations: 3 rows, all radius_meters = 100.
--   - profiles.role = 'Employee': 0 rows, exact match and case-
--     insensitive, in every org (checked individually and via a
--     per-org count that returned no rows at all) -- zero everywhere,
--     so the delete is included per instruction.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. roles.tracks_orders -- capability flag, not a name check, so a
-- renamed Driver role keeps the behaviour.
-- ----------------------------------------------------------------------------

alter table public.roles
  add column if not exists tracks_orders boolean not null default false;

update public.roles set tracks_orders = true where name = 'Driver';


-- ----------------------------------------------------------------------------
-- 2. time_logs.orders_count / time_logs.extra_miles
-- ----------------------------------------------------------------------------

alter table public.time_logs
  add column if not exists orders_count integer,
  add column if not exists extra_miles numeric(6,1);

comment on column public.time_logs.orders_count is 'Deliveries completed during this shift. A null value on a CLOSED log (clock_out is not null) belonging to a profile whose role has tracks_orders is what drives the "still owes an entry" prompt -- it does not by itself mean zero orders.';
comment on column public.time_logs.extra_miles is 'Miles driven beyond the standard route during this shift. Same null-on-a-closed-tracks_orders-log semantics as orders_count.';


-- ----------------------------------------------------------------------------
-- 3. A driver must be able to set orders_count/extra_miles on their own
-- log after it is closed -- time_logs_update_own_open only applies while
-- clock_out is null. This is a separate, additive policy (RLS policies
-- for the same command are OR'd), scoped by a WITH CHECK that compares
-- the whole row, minus the two columns this policy exists to let change
-- (plus updated_at, which set_updated_at overwrites unconditionally
-- regardless of what the client sends), to what is already stored --
-- nothing else about the row can move through this policy, including
-- clock_in/clock_out themselves.
-- ----------------------------------------------------------------------------

create policy time_logs_update_own_orders on public.time_logs for update
  to authenticated
  using (org_id = my_org_id() and user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.time_logs old
      where old.id = time_logs.id
        and (to_jsonb(old) - 'orders_count' - 'extra_miles' - 'updated_at')
          = (to_jsonb(time_logs) - 'orders_count' - 'extra_miles' - 'updated_at')
    )
  );


-- ----------------------------------------------------------------------------
-- 4. Geofence radius: 75m everywhere.
-- ----------------------------------------------------------------------------

update public.locations set radius_meters = 75;


-- ----------------------------------------------------------------------------
-- 5. Employee role removal. Zero profiles hold it in every org (checked
-- above) -- delete included.
-- ----------------------------------------------------------------------------

delete from public.roles where name = 'Employee';
