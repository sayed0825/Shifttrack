-- ============================================================================
-- 0041_server_clock_out_time.sql
--
-- 2026-09-23 follow-up: tg_protect_own_time_log's clock-out window
-- (clock_out between now() - 5 minutes and now() + 1 minute) trusted the
-- CLIENT's own device clock (EmployeeDashboard.tsx's handleClockOut sends
-- new Date().toISOString(), not anything server-derived), then validated
-- it against a narrow window. Confirmed reachable by a real user, not
-- just a sandbox artifact: this exact window rejected one of this
-- session's own RLS tests over real clock skew between this machine and
-- the Supabase server. A driver with a skewed device clock, or a slow
-- request, or -- the more common case -- a clock-out that had to queue
-- offline and replay later, would see 'You cannot change the hours on
-- your own shift', a message that means nothing to someone who is simply
-- clocking out.
--
-- Fixed with two different mechanisms for two different situations, not
-- one blanket fix:
--
-- ONLINE (the request reaches the server promptly): clock_out is now
-- force-derived to the server's own now(), same "force-derive, never
-- trust the client" pattern as every other column this kind of trigger
-- already protects elsewhere in this schema. The 5-minute/1-minute
-- window is gone entirely -- there is nothing left to validate once the
-- value can only ever be now().
--
-- OFFLINE (queued and replayed later, see offlineQueue.js): the device's
-- ORIGINAL claimed clock_out is exactly that -- a claim, not a fact, and
-- forcing it to server-now() on replay would silently record the SYNC
-- time as the clock-out time, which is wrong in the other direction
-- (paying for time they weren't working). So the client-side fix
-- (separate commit, offlineQueue.js/EmployeeDashboard.tsx) compares what
-- the device claimed against what the server actually recorded and,
-- whenever they differ by more than a few minutes, inserts an
-- overtime_claims row carrying the device's claimed time --
-- claimed_clock_out, exactly the column that table already has for
-- exactly this "employee-asserted time differs from the recorded time"
-- shape. No new table, no new RPC, no new manager screen: notify_org_
-- managers already fires on insert (tg_overtime_notify), OvertimeApprovals
-- already renders "Recorded" against "Claimed" side by side, and
-- decide_overtime_claim() already overwrites time_logs.clock_out with the
-- claimed value on approval. This migration doesn't touch overtime_claims
-- at all -- the mechanism already does exactly what's needed.
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
     or new.clock_in is distinct from old.clock_in
     or new.role_at_clock_in is distinct from old.role_at_clock_in
     or new.shift_id is distinct from old.shift_id
     or new.clock_in_latitude is distinct from old.clock_in_latitude
     or new.clock_in_longitude is distinct from old.clock_in_longitude
     or new.clock_in_distance_m is distinct from old.clock_in_distance_m then
    raise exception 'You cannot change the details of your own shift'
      using errcode = '42501';
  end if;

  -- Clocking out: allowed once, open to closed -- but the TIME is the
  -- server's own now(), never whatever the client sent. This is what
  -- makes the old window check unnecessary: there is nothing left to
  -- validate once the value can only ever be "right now".
  if new.clock_out is distinct from old.clock_out then
    if old.clock_out is null then
      new.clock_out := now();
      return new;
    end if;
    raise exception 'This shift has already been clocked out and cannot be changed here. Ask your manager to correct it.'
      using errcode = '42501';
  end if;

  return new;
end; $function$;

commit;
