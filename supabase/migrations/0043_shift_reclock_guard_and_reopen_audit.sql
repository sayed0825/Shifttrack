-- ============================================================================
-- 0043_shift_reclock_guard_and_reopen_audit.sql
--
-- Two changes to clock-in (2026-09-23).
--
-- 1. NO RE-CLOCK-IN AFTER CLOCKING OUT, enforced server-side. Once a
-- time_logs row exists for a given shift_id with clock_out set, that
-- same employee cannot insert another row against the same shift_id.
-- Scoped to (user_id, shift_id), not the day -- split shifts (lunch then
-- dinner) are two different shift_id values and are completely
-- unaffected; only a shift that's actually been completed is blocked.
--
-- Ad-hoc clock-ins (shift_id null) are deliberately NOT restricted here
-- at all -- there's no shift to have "completed" when there's no
-- shift_id to reference, and nothing correlates one ad-hoc clock-in to
-- another. time_logs_one_open_per_user_idx (the existing unique index)
-- already stops a second SIMULTANEOUS open shift regardless of shift_id;
-- this migration only adds "can't reuse an already-completed shift_id",
-- a different, additional constraint.
--
-- 2. MANAGER REOPENS IT. A manager clearing clock_out on someone else's
-- row (EditLogModal) now gets reopened_by/reopened_at force-derived
-- server-side, the same "never trust the client for this" pattern as
-- everywhere else in this schema -- EditLogModal's own update call
-- doesn't even send these, and couldn't usefully lie about them if it
-- tried, since the trigger overwrites them unconditionally whenever it
-- detects the clock_out-not-null -> null transition. Also added to the
-- owner branch's own "never change" list: without that, an employee
-- could set fake reopened_by/reopened_at values on their own still-open
-- row without ever touching clock_out at all, which the existing checks
-- there wouldn't have caught.
--
-- Realtime propagation to the employee's own screen needed no new
-- listener logic beyond EmployeeDashboard.tsx's own update (separate
-- commit) -- time_logs only entered the realtime publication in 0040;
-- before that, the existing clock-in-tab channel was silently never
-- receiving any event at all, reopen or otherwise.
-- ============================================================================

begin;

alter table public.time_logs
  add column reopened_by uuid references public.profiles (id) on delete set null,
  add column reopened_at timestamptz;

create function public.shift_already_completed_by_caller(p_shift_id uuid)
returns boolean
language sql
stable
security definer
set search_path to ''
as $function$
  select p_shift_id is not null and exists (
    select 1 from public.time_logs tl
    where tl.shift_id = p_shift_id
      and tl.user_id = (select auth.uid())
      and tl.clock_out is not null
  );
$function$;

alter policy time_logs_insert_own
  on public.time_logs
  with check (
    user_id = (select auth.uid())
    and org_id = my_org_id()
    and is_active_user()
    and not public.shift_already_completed_by_caller(shift_id)
  );

create or replace function public.tg_protect_own_time_log()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  -- Administrators may change anything.
  if public.is_admin() then
    if old.clock_out is not null and new.clock_out is null then
      new.reopened_by := (select auth.uid());
      new.reopened_at := now();
    end if;
    return new;
  end if;

  -- A manager may edit someone else's hours, but not their own.
  if public.is_manager() and new.user_id <> (select auth.uid()) then
    if old.clock_out is not null and new.clock_out is null then
      new.reopened_by := (select auth.uid());
      new.reopened_at := now();
    end if;
    return new;
  end if;

  -- No end-user session: the pg_cron sweep closing forgotten shifts, or
  -- the service role. RLS already stops anonymous callers reaching here.
  if (select auth.uid()) is null then
    return new;
  end if;

  -- Who, where and when the shift started never change. reopened_by/
  -- reopened_at added here too -- only an admin/manager reopening someone
  -- else's row (above) may ever set these, never the row's own owner.
  if new.user_id is distinct from old.user_id
     or new.location_id is distinct from old.location_id
     or new.is_geofenced_valid is distinct from old.is_geofenced_valid
     or new.clock_in is distinct from old.clock_in
     or new.role_at_clock_in is distinct from old.role_at_clock_in
     or new.shift_id is distinct from old.shift_id
     or new.clock_in_latitude is distinct from old.clock_in_latitude
     or new.clock_in_longitude is distinct from old.clock_in_longitude
     or new.clock_in_distance_m is distinct from old.clock_in_distance_m
     or new.reopened_by is distinct from old.reopened_by
     or new.reopened_at is distinct from old.reopened_at then
    raise exception 'You cannot change the details of your own shift'
      using errcode = '42501';
  end if;

  -- Clocking out: allowed once, open to closed -- but the TIME is the
  -- server's own now(), never whatever the client sent.
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
