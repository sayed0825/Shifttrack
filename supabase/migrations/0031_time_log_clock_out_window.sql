-- ============================================================================
-- 0031_time_log_clock_out_window.sql
--
-- Records a hotfix the user ran directly against the live database,
-- pulled back out via the read-only MCP connection to keep the repo the
-- source of truth for it -- this file is not the change itself, it's the
-- record of one that already happened live.
--
-- The bug (0020_time_log_self_edit_scope.sql): tg_protect_own_time_log's
-- "everyone else" branch (an owner acting on their own row, not an admin,
-- not a manager acting on someone else's) rejected ANY change to
-- clock_out unconditionally:
--
--   if new.clock_in is distinct from old.clock_in
--      or new.clock_out is distinct from old.clock_out   -- the bug
--      or new.user_id is distinct from old.user_id
--      or new.location_id is distinct from old.location_id
--      or new.is_geofenced_valid is distinct from old.is_geofenced_valid
--   then raise exception ...
--
-- Treating "setting clock_out from null" the same as "rewriting an
-- already-closed shift's hours" -- there was never a case where a
-- non-admin, non-manager-of-someone-else caller (an ordinary employee
-- clocking themselves out, or a manager clocking themselves out) could
-- set clock_out on their own open row at all. Confirmed live by
-- impersonating a driver in SQL.
--
-- The fix, exactly as run live:
-- - New null-auth.uid() branch, ahead of the ownership checks -- a
--   caller with no session (pg_cron's sweep_open_shifts(), or the
--   service role) passes through unconditionally. Confirmed live:
--   sweep_open_shifts() (an existing pg_cron job, "sweep-open-shifts",
--   every 15 minutes -- present live with no migration file of its own,
--   a pre-existing gap this migration doesn't attempt to close) is
--   SECURITY DEFINER and guarded by a session_user/rolsuper check, so it
--   runs with auth.uid() null; without this branch its own UPDATE would
--   have hit the exact same bug from the cron's side too.
-- - clock_in/user_id/location_id/is_geofenced_valid stay immutable, as
--   before -- unchanged in shape, just no longer bundled with clock_out.
-- - clock_out may be set exactly once, open to closed
--   (old.clock_out is null), and only to a value within 5 minutes
--   before now through 1 minute after -- close enough to "now" to be a
--   real clock-out, generous enough for request latency and modest
--   clock drift. Changing an already-set clock_out is still rejected,
--   same as before.
--
-- This migration is a plain CREATE OR REPLACE, idempotent, matching what
-- is already live -- no data to reconcile, no backfill, nothing to
-- verify beyond the function body itself.
-- ============================================================================

begin;

create or replace function public.tg_protect_own_time_log()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  -- Administrators may change anything.
  if public.is_admin() then
    return new;
  end if;

  -- A manager may edit someone else's hours, but not their own.
  if public.is_manager() and new.user_id <> (select auth.uid()) then
    return new;
  end if;

  -- No end-user session: the pg_cron sweep closing forgotten shifts, or
  -- the service role. RLS already stops anonymous callers reaching here.
  if (select auth.uid()) is null then
    return new;
  end if;

  -- Who, where and when the shift started never change.
  if new.user_id is distinct from old.user_id
     or new.location_id is distinct from old.location_id
     or new.is_geofenced_valid is distinct from old.is_geofenced_valid
     or new.clock_in is distinct from old.clock_in then
    raise exception 'You cannot change the details of your own shift'
      using errcode = '42501';
  end if;

  -- Clocking out: allowed once, open to closed, at about the current
  -- time. Stops a self-reported clock-out from inflating hours.
  if new.clock_out is distinct from old.clock_out then
    if old.clock_out is null
       and new.clock_out between now() - interval '5 minutes'
                             and now() + interval '1 minute' then
      return new;
    end if;
    raise exception 'You cannot change the hours on your own shift'
      using errcode = '42501';
  end if;

  return new;
end; $function$;

commit;
