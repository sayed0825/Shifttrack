-- ============================================================================
-- 0035_time_log_clock_in_field_protection.sql
--
-- Security audit finding 6 (2026-09-23) -- confirmed live against a
-- throwaway org + real session before writing this: tg_protect_own_time_log
-- (0031) froze user_id/location_id/is_geofenced_valid/clock_in against the
-- row's own owner, but not role_at_clock_in, shift_id,
-- clock_in_latitude/_longitude/_distance_m. An employee editing their own
-- still-open shift (the only window time_logs_update_own_open leaves
-- reachable) could rewrite which shift the log claims to belong to, or
-- rewrite the recorded clock-in location/distance/geofence-adjacent data
-- after the fact -- with zero error.
--
-- Extends the existing "who, where and when the shift started never
-- change" freeze to cover all five columns. Same shape as before: an
-- admin may change anything, a manager may edit someone else's hours (not
-- their own), a null auth.uid() (pg_cron's sweep, service role) passes
-- through unconditionally. clock_out's own once-only, near-now window is
-- untouched.
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
