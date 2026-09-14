-- ============================================================================
-- 0017_fix_time_logs_orders_recursion.sql
--
-- Fixes infinite recursion (error 42P17) in time_logs_update_own_orders.
--
-- The previous version of that policy's WITH CHECK compared to_jsonb of
-- the stored row against the new one, which meant selecting from
-- time_logs inside a time_logs policy -- infinite recursion.
--
-- Block 1 replaces time_logs_update_own_orders with a simple org + user
-- check in USING and WITH CHECK.
--
-- Block 2 adds tg_protect_own_time_log and a BEFORE UPDATE trigger,
-- because a policy cannot reference the previous row. It lets a manager
-- through, and otherwise rejects any change to clock_in, clock_out,
-- user_id, location_id or is_geofenced_valid -- so a user can set their
-- own orders_count but cannot rewrite their own hours.
-- ============================================================================

-- Block 1: replace the recursive policy with a plain org + user check.
drop policy if exists time_logs_update_own_orders on public.time_logs;

create policy time_logs_update_own_orders
  on public.time_logs
  for update
  to authenticated
  using (
    org_id = my_org_id()
    and user_id = (select auth.uid())
  )
  with check (
    org_id = my_org_id()
    and user_id = (select auth.uid())
  );

-- Block 2: enforce the "own orders_count only" restriction via trigger
-- instead, since a policy cannot see the previous row without querying
-- the table it's attached to.
create or replace function public.tg_protect_own_time_log()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if public.is_manager() then
    return new;
  end if;
  if new.clock_in is distinct from old.clock_in
     or new.clock_out is distinct from old.clock_out
     or new.user_id is distinct from old.user_id
     or new.location_id is distinct from old.location_id
     or new.is_geofenced_valid is distinct from old.is_geofenced_valid then
    raise exception 'You can only record your order count on a completed shift'
      using errcode = '42501';
  end if;
  return new;
end; $function$;

drop trigger if exists protect_own_time_log on public.time_logs;

create trigger protect_own_time_log
  before update on public.time_logs
  for each row
  execute function tg_protect_own_time_log();
