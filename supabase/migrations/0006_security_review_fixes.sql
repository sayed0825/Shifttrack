-- ============================================================================
-- 0006_security_review_fixes.sql
--
-- Phase 3 security review (audited via the read-only Supabase MCP against
-- the live database, 2026-09-12) found two HIGH-severity issues. This
-- migration fixes both. The remaining CRITICAL/MEDIUM/LOW findings from
-- that review are not addressed here — reported separately, nothing else
-- changed yet.
-- ============================================================================


-- ============================================================================
-- 1. Cron-only functions callable by anon/authenticated
--
-- purge_expired_open_shifts() and purge_old_task_photos() are destructive
-- (delete shifts / delete storage objects, respectively) and cross-tenant
-- (no org scoping — they operate over every organisation at once, by
-- design, since they're maintenance jobs). Both were granted EXECUTE to
-- anon and PUBLIC with no internal permission check, so any unauthenticated
-- caller could invoke either directly and force it to run early across
-- every tenant on the platform.
--
-- Checked generate_task_instances(), sweep_open_shifts() and
-- notify_overdue_tasks(): same class of function (pg_cron-only, written
-- the same way), same exposure (anon + PUBLIC execute, no internal check).
-- Fixed identically.
--
-- All five exist only for pg_cron, which invokes them as the `postgres`
-- role and does not need an explicit grant to do so — REVOKE below removes
-- the API-layer grant entirely, and the in-function guard means a future
-- accidental GRANT can't silently reopen this.
-- ============================================================================

create or replace function public.purge_expired_open_shifts()
 returns integer
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare removed integer := 0;
begin
  if current_user <> 'postgres'
     and not exists (select 1 from pg_catalog.pg_roles where rolname = current_user and rolsuper)
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

revoke execute on function public.purge_expired_open_shifts() from public, anon, authenticated;

create or replace function public.purge_old_task_photos()
 returns integer
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare purged integer := 0;
begin
  if current_user <> 'postgres'
     and not exists (select 1 from pg_catalog.pg_roles where rolname = current_user and rolsuper)
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

revoke execute on function public.purge_old_task_photos() from public, anon, authenticated;

create or replace function public.generate_task_instances()
 returns integer
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare made integer := 0;
begin
  if current_user <> 'postgres'
     and not exists (select 1 from pg_catalog.pg_roles where rolname = current_user and rolsuper)
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

revoke execute on function public.generate_task_instances() from public, anon, authenticated;

create or replace function public.sweep_open_shifts()
 returns integer
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare closed integer := 0;
begin
  if current_user <> 'postgres'
     and not exists (select 1 from pg_catalog.pg_roles where rolname = current_user and rolsuper)
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

revoke execute on function public.sweep_open_shifts() from public, anon, authenticated;

create or replace function public.notify_overdue_tasks()
 returns integer
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare sent integer := 0;
begin
  if current_user <> 'postgres'
     and not exists (select 1 from pg_catalog.pg_roles where rolname = current_user and rolsuper)
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

revoke execute on function public.notify_overdue_tasks() from public, anon, authenticated;


-- ============================================================================
-- 2. org-logos storage policies not scoped to the caller's own org
--
-- org_logos_write/org_logos_update were gated on is_manager() only — no
-- check that the object path belongs to the manager's own organisation, so
-- a manager in any org could overwrite another org's logo file by guessing
-- its org UUID. Scoped both to the caller's own org via the path prefix
-- (uploads write to ${orgId}/logo.<ext> — confirmed against
-- ManagerMoreTab.tsx's BrandingCard, so this does not block legitimate
-- uploads). Also added a delete policy with the same scoping; none existed
-- before (the app's "remove logo" action only nulls organisations.logo_url
-- today and never deletes the storage object, but a correctly-scoped
-- delete policy should exist regardless of current app behaviour).
-- ============================================================================

drop policy if exists org_logos_write on storage.objects;
create policy org_logos_write on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'org-logos'
    and is_manager()
    and (storage.foldername(name))[1] = public.my_org_id()::text
  );

drop policy if exists org_logos_update on storage.objects;
create policy org_logos_update on storage.objects for update
  to authenticated
  using (
    bucket_id = 'org-logos'
    and is_manager()
    and (storage.foldername(name))[1] = public.my_org_id()::text
  )
  with check (
    bucket_id = 'org-logos'
    and is_manager()
    and (storage.foldername(name))[1] = public.my_org_id()::text
  );

drop policy if exists org_logos_delete on storage.objects;
create policy org_logos_delete on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'org-logos'
    and is_manager()
    and (storage.foldername(name))[1] = public.my_org_id()::text
  );
