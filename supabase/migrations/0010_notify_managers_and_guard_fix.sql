-- ============================================================================
-- 0010_notify_managers_and_guard_fix.sql
--
-- Two fixes.
--
-- 1. Phase 3 security review, finding #2 (CRITICAL, last one open):
-- notify_org_managers()/notify_location_managers() had no permission check
-- at all and were granted to anon and PUBLIC. Either could be invoked
-- directly, with an arbitrary org_id and attacker-controlled title/body,
-- to insert a notification for every manager in any organisation on the
-- platform -- fully unauthenticated, no session required.
--
-- Neither is ever called directly by the client or the invite-staff Edge
-- Function (checked by grep) or referenced in any RLS policy -- their
-- only legitimate callers are the tg_*_notify trigger functions, which
-- are themselves SECURITY DEFINER owned by postgres. A nested call from
-- one SECURITY DEFINER function (already running as its owner) to
-- another needs no grant of its own to succeed, the same reasoning
-- 0007 applied to the other internal-only helpers. Revoked entirely,
-- no re-grant to anyone.
--
-- 2. Correction to 0006: the "only pg_cron may call this" guard added to
-- purge_expired_open_shifts(), purge_old_task_photos(),
-- generate_task_instances(), sweep_open_shifts() and notify_overdue_tasks()
-- checked current_user. That does not work: current_user inside a
-- SECURITY DEFINER function is always the function's owner (postgres,
-- confirmed live) for the duration of its execution, regardless of who
-- invoked it -- pg_cron or a hypothetical future anon/authenticated
-- grant would look identical from inside the function. The REVOKE in
-- 0006 is what has actually been protecting these; the guard itself has
-- never fired and would not fire even if EXECUTE were mistakenly
-- re-granted tomorrow.
--
-- The correct check is session_user, which reflects the role that
-- actually opened the connection and is NOT affected by SECURITY
-- DEFINER's role-switching: pg_cron connects directly as `postgres`
-- (cron.job.username on every job here), while every PostgREST-proxied
-- request -- anon or authenticated alike -- connects as `authenticator`
-- and only SET ROLEs to anon/authenticated afterward. session_user
-- stays `authenticator` throughout, so this now genuinely distinguishes
-- pg_cron from any request that reached the database through the API.
-- Bodies are otherwise unchanged from 0006; only the guard condition's
-- current_user references become session_user.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. notify_org_managers() / notify_location_managers()
-- ----------------------------------------------------------------------------

revoke all on function public.notify_org_managers(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.notify_location_managers(uuid, uuid, text, text, text) from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- 2. Fix the session_user vs current_user guard bug from 0006
-- ----------------------------------------------------------------------------

create or replace function public.purge_expired_open_shifts()
 returns integer
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare removed integer := 0;
begin
  if session_user <> 'postgres'
     and not exists (select 1 from pg_catalog.pg_roles where rolname = session_user and rolsuper)
  then
    raise exception 'purge_expired_open_shifts() may only be run by pg_cron' using errcode = '42501';
  end if;

  delete from public.shifts
  where assigned_user_id is null
    and required_role is not null
    and start_time < now() - interval '1 day';

  get diagnostics removed = row_count;
  return removed;
end; $function$;

create or replace function public.purge_old_task_photos()
 returns integer
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare purged integer := 0;
begin
  if session_user <> 'postgres'
     and not exists (select 1 from pg_catalog.pg_roles where rolname = session_user and rolsuper)
  then
    raise exception 'purge_old_task_photos() may only be run by pg_cron' using errcode = '42501';
  end if;

  delete from storage.objects o
  using public.tasks t
  where o.bucket_id = 'task-photos'
    and o.name = t.photo_path
    and t.completed_at < now() - interval '1 month';

  update public.tasks
  set photo_path = null
  where photo_path is not null
    and completed_at < now() - interval '1 month';

  get diagnostics purged = row_count;
  return purged;
end; $function$;

create or replace function public.generate_task_instances()
 returns integer
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare made integer := 0;
begin
  if session_user <> 'postgres'
     and not exists (select 1 from pg_catalog.pg_roles where rolname = session_user and rolsuper)
  then
    raise exception 'generate_task_instances() may only be run by pg_cron' using errcode = '42501';
  end if;

  insert into public.tasks (
    org_id, template_id, location_id, title, description,
    assigned_role, assigned_user_id, requires_photo,
    start_time, due_time, created_by
  )
  select t.org_id, t.id, t.location_id, t.title, t.description,
         t.assigned_role, t.assigned_user_id, t.requires_photo,
         (current_date + t.start_at), (current_date + t.due_at), t.created_by
  from public.task_templates t
  where t.is_active
    and (t.recurrence = 'daily'
         or extract(dow from current_date)::smallint = any(t.weekdays))
  on conflict do nothing;

  get diagnostics made = row_count;
  return made;
end; $function$;

create or replace function public.sweep_open_shifts()
 returns integer
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare closed integer := 0;
begin
  if session_user <> 'postgres'
     and not exists (select 1 from pg_catalog.pg_roles where rolname = session_user and rolsuper)
  then
    raise exception 'sweep_open_shifts() may only be run by pg_cron' using errcode = '42501';
  end if;

  with matched as (
    select tl.id as log_id, s.end_time
    from public.time_logs tl
    join public.shifts s
      on (s.id = tl.shift_id
          or (s.assigned_user_id = tl.user_id
              and s.start_time::date = tl.clock_in::date))
     and s.org_id = tl.org_id
    where tl.clock_out is null
      and s.end_time < now()
      and s.end_time > tl.clock_in
  )
  update public.time_logs tl
  set clock_out = m.end_time,
      notes = 'Auto clocked-out at shift end'
  from matched m
  where tl.id = m.log_id and tl.clock_out is null;

  get diagnostics closed = row_count;
  return closed;
end; $function$;

create or replace function public.notify_overdue_tasks()
 returns integer
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare sent integer := 0;
begin
  if session_user <> 'postgres'
     and not exists (select 1 from pg_catalog.pg_roles where rolname = session_user and rolsuper)
  then
    raise exception 'notify_overdue_tasks() may only be run by pg_cron' using errcode = '42501';
  end if;

  insert into public.notifications (user_id, org_id, type, title, body)
  select p.id, t.org_id, 'task', 'Task overdue', t.title
  from public.tasks t
  join public.profiles p
    on p.org_id = t.org_id
   and p.is_active
   and (p.id = t.assigned_user_id or p.role = t.assigned_role)
  where t.status = 'pending'
    and t.due_time < now()
    and t.overdue_notified_at is null;

  update public.tasks
  set overdue_notified_at = now()
  where status = 'pending' and due_time < now() and overdue_notified_at is null;

  get diagnostics sent = row_count;
  return sent;
end; $function$;
