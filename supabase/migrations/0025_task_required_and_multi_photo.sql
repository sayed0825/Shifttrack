-- ============================================================================
-- 0025_task_required_and_multi_photo.sql
--
-- Two additions to the task module.
--
-- 1. is_required (default true, on both tasks and task_templates). An
--    optional task that's never completed doesn't belong in
--    notify_overdue_tasks() (nobody should get chased for skipping
--    something optional) or in the "never completed" history count
--    (ManagerTasks.tsx's HistorySection query, filtered client-side --
--    both updated to add `is_required = true`).
--
-- 2. max_photos (default 1, capped 1-10, on both tables) plus a new
--    task_photos child table replacing the single tasks.photo_path for
--    anything going forward. photo_path itself is NOT dropped here --
--    existing values are copied into task_photos below, and the column
--    stays until a later migration confirms nothing still reads it (the
--    app code in this same change stops reading/writing it, so that
--    confirmation is really just "no PR since this one touched it
--    again").
--
--    task_photos follows the same shape and RLS pattern as task_comments
--    (can_see_task() gates both read and insert, insert also pins the
--    row to the caller) -- append-only, no update/delete policy for
--    anyone, same as comments.
-- ============================================================================

alter table public.tasks
  add column is_required boolean not null default true;

alter table public.task_templates
  add column is_required boolean not null default true;

alter table public.tasks
  add column max_photos integer not null default 1 check (max_photos between 1 and 10);

alter table public.task_templates
  add column max_photos integer not null default 1 check (max_photos between 1 and 10);

create table public.task_photos (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.my_org_id()
    references public.organisations (id) on delete cascade,
  task_id uuid not null references public.tasks (id) on delete cascade,
  storage_path text not null,
  uploaded_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

create index task_photos_task_id_idx on public.task_photos (task_id);

alter table public.task_photos enable row level security;
alter table public.task_photos force row level security;

create policy task_photos_select
  on public.task_photos
  for select
  to authenticated
  using (org_id = public.my_org_id() and public.can_see_task(task_id));

create policy task_photos_insert
  on public.task_photos
  for insert
  to authenticated
  with check (
    org_id = public.my_org_id()
    and uploaded_by = (select auth.uid())
    and public.can_see_task(task_id)
  );

-- Backfill: every existing photo_path becomes its task's one task_photos
-- row. uploaded_by is the person who completed the task (the only person
-- who could have uploaded it under the old single-photo flow);
-- created_at falls back to the task's own created_at only if completed_at
-- is somehow null, which shouldn't happen for a row that has a photo_path
-- at all (photo_path is only ever set alongside completed_at in the old
-- completion flow) -- defensive, not expected to trigger.
insert into public.task_photos (org_id, task_id, storage_path, uploaded_by, created_at)
select org_id, id, photo_path, completed_by, coalesce(completed_at, created_at)
from public.tasks
where photo_path is not null;

-- Generation: carry is_required and max_photos from template to instance,
-- same as every other column already copied here.
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
    assigned_role, assigned_user_id, requires_photo, is_required, max_photos,
    start_time, due_time, created_by
  )
  select t.org_id, t.id, t.location_id, t.title, t.description,
         t.assigned_role, t.assigned_user_id, t.requires_photo, t.is_required, t.max_photos,
         (current_date + t.start_at), (current_date + t.due_at), t.created_by
  from public.task_templates t
  where t.is_active
    and (t.recurrence = 'daily'
         or extract(dow from current_date)::smallint = any(t.weekdays))
  on conflict do nothing;

  get diagnostics made = row_count;
  return made;
end; $function$;

-- Overdue notification: skip anything optional -- nobody should be chased
-- for not doing something they were never required to do. Excluded from
-- both the insert and the bookkeeping update, not just the insert: an
-- optional task should never pick up overdue_notified_at at all, since it
-- was never actually notified.
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
    and t.overdue_notified_at is null
    and t.is_required;

  update public.tasks
  set overdue_notified_at = now()
  where status = 'pending' and due_time < now() and overdue_notified_at is null and is_required;

  get diagnostics sent = row_count;
  return sent;
end; $function$;

-- Monthly purge: now clears task_photos rows and their storage objects
-- (every photo a task has, not just one), and still nulls the legacy
-- photo_path column too -- for the rows migrated above, that column is
-- just a stale copy of what's now also a task_photos row, and the
-- underlying storage object is gone either way once this runs.
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
  using public.task_photos tp
  join public.tasks t on t.id = tp.task_id
  where o.bucket_id = 'task-photos'
    and o.name = tp.storage_path
    and t.completed_at < now() - interval '1 month';

  delete from public.task_photos tp
  using public.tasks t
  where t.id = tp.task_id
    and t.completed_at < now() - interval '1 month';

  update public.tasks
  set photo_path = null
  where photo_path is not null
    and completed_at < now() - interval '1 month';

  get diagnostics purged = row_count;
  return purged;
end; $function$;
