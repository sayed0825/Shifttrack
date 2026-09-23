-- ============================================================================
-- 0042_post_clock_out_delivery_grace.sql
--
-- Mid-delivery auto clock-out (2026-09-23). sweep_open_shifts() (pg_cron)
-- closing a driver's shift while they're still out on a run left the
-- final drop, that leg's mileage and its order pay with nowhere to go:
-- delivery_runs_insert_own and delivery_drops_insert_own both required
-- tl.clock_out IS NULL, so record_delivery_run's insert would be
-- rejected outright the moment the shift closed underneath them.
--
-- Both policies now go through time_log_accepts_drops(), which allows
-- attaching to a CLOSED shift for up to 2 hours past its clock_out --
-- this is the actual server-side hard cap: whatever the client's own
-- timing does (see EmployeeDashboard.tsx's post-clock-out tracking),
-- nothing can attach a run to a shift that closed more than ~2 hours
-- ago. Checked against now() at the moment of the write itself, not any
-- client-supplied timestamp, so it can't be gamed by sending a fabricated
-- p_ended_at.
--
-- The extra 15 minutes past the 2-hour figure is deliberate slack for
-- real request latency and the "driver stationary near the 2-hour mark,
-- no new GPS fix arrives to trigger the client's own check" case (fixes
-- are distance-filtered, not time-filtered -- see gpsFilter.ts) -- not an
-- extension of the 2-hour policy itself. The client still targets
-- exactly 2 hours.
--
-- Deliberately untouched: time_logs.clock_out itself. Nothing in this
-- migration ever changes it again after the sweep sets it, so hours stay
-- capped at the auto clock-out time exactly as before -- this is only
-- ever about whether a delivery_runs/delivery_drops row may attach to
-- that already-closed shift, never about re-opening it. A driver's own
-- deliberate "Clock out" tap mid-run is also untouched -- this grace
-- period is specifically for the shift ending out from under them, not a
-- choice they made themselves.
-- ============================================================================

begin;

create function public.time_log_accepts_drops(p_time_log_id uuid)
returns boolean
language sql
stable
security definer
set search_path to ''
as $function$
  select exists (
    select 1 from public.time_logs tl
    where tl.id = p_time_log_id
      and tl.user_id = (select auth.uid())
      and (
        tl.clock_out is null
        or now() <= tl.clock_out + interval '2 hours 15 minutes'
      )
  );
$function$;

alter policy delivery_runs_insert_own
  on public.delivery_runs
  with check (
    org_id = public.my_org_id()
    and public.time_log_accepts_drops(time_log_id)
  );

alter policy delivery_drops_insert_own
  on public.delivery_drops
  with check (
    org_id = public.my_org_id()
    and exists (
      select 1 from public.delivery_runs dr
      where dr.id = delivery_drops.run_id
        and public.time_log_accepts_drops(dr.time_log_id)
    )
  );

commit;
