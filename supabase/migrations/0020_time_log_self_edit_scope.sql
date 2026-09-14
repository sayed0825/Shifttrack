-- ============================================================================
-- 0020_time_log_self_edit_scope.sql
--
-- Tightens tg_protect_own_time_log (0017): it previously let any manager or
-- administrator through unconditionally, with no check on whose row was
-- being edited -- correct for a manager fixing a subordinate's timesheet,
-- but it also meant a manager or admin could rewrite their OWN
-- clock_in/clock_out, found while writing tests/rls/negative/
-- time-log-immutable.test.ts against the "any user" spec that test encodes.
--
-- Run live via the MCP before this file was written to match:
-- - An administrator may edit their own hours (and anyone else's, as
--   before) -- is_admin() still grants unconditionally.
-- - A manager may still edit anyone else's hours, but not their own --
--   is_manager() now also requires new.user_id <> auth.uid().
-- - Everyone else (a manager editing their own row included) can only set
--   orders_count on their own log, same as before.
-- ============================================================================

create or replace function public.tg_protect_own_time_log()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if public.is_admin() then
    return new;
  end if;

  if public.is_manager() and new.user_id <> (select auth.uid()) then
    return new;
  end if;

  if new.clock_in is distinct from old.clock_in
     or new.clock_out is distinct from old.clock_out
     or new.user_id is distinct from old.user_id
     or new.location_id is distinct from old.location_id
     or new.is_geofenced_valid is distinct from old.is_geofenced_valid then
    raise exception 'You cannot change the hours on your own shift'
      using errcode = '42501';
  end if;

  return new;
end; $function$;
