-- ============================================================================
-- 0026_task_lists_and_items.sql
--
-- The item becomes the unit of work. task_templates/tasks become list
-- containers (title, one shared start/due time, assignment, recurrence);
-- status, completion, review and photos move down to new
-- task_template_items / task_items tables. Shared-pool semantics apply
-- per item, against the same list-level assignment.
--
-- Decisions this migration encodes (confirmed before writing it):
-- - task_templates.description stays -- it's the list's own description.
-- - generate_task_instances() never creates a list from a template with
--   no items -- the list itself is skipped, not just left itemless.
-- - Overdue notification stays per LIST, not per item: one notification
--   naming how many required items are still outstanding.
-- - tasks.photo_path is NOT dropped here. Its data is migrated into
--   task_photos and verified below; the column itself waits for a later
--   migration once nothing reads it (nothing does today, but that's a
--   separate confirmed-safe step, not this one).
--
-- MIGRATING LIVE DATA is the risky part of this file. Every existing task
-- becomes a list with exactly one item carrying its current status,
-- completion, review, photos and comments -- verified in-transaction
-- (step 14 aborts the whole migration, nothing above it is kept, if any
-- count fails to reconcile) and again with the standalone queries at the
-- bottom of this file, meant to be run before and after by hand.
--
-- Explicit BEGIN/COMMIT below -- no earlier migration in this repo needed
-- one, but none of them had an in-migration safety check whose whole
-- point is aborting everything on failure. That guarantee needs an
-- explicit transaction boundary, not an assumption about how the SQL
-- Editor batches multiple statements. Run this file's entire contents as
-- one execution -- splitting it into separate runs defeats step 14.
-- ============================================================================

begin;

-- 0. Snapshot pre-migration counts in a transaction-scoped temp table, so
-- the final check (step 14) compares against what was actually live when
-- this ran, not a number hardcoded from today's read.
create temporary table _migration_before_counts (
  tasks_count integer,
  photos_count integer,
  comments_count integer
) on commit drop;

insert into _migration_before_counts (tasks_count, photos_count, comments_count)
select
  (select count(*) from public.tasks),
  (select count(*) from public.task_photos),
  (select count(*) from public.task_comments);

-- ============================================================================
-- 1. task_template_items
-- ============================================================================

create table public.task_template_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.my_org_id()
    references public.organisations (id) on delete cascade,
  template_id uuid not null references public.task_templates (id) on delete cascade,
  title text not null,
  description text,
  sort_order integer not null default 0,
  is_required boolean not null default true,
  requires_photo boolean not null default false,
  max_photos integer not null default 1 check (max_photos between 1 and 10),
  created_at timestamptz not null default now()
);

create index task_template_items_template_idx on public.task_template_items (template_id);

alter table public.task_template_items enable row level security;
alter table public.task_template_items force row level security;

create policy tmpl_items_manager_all
  on public.task_template_items
  for all
  to authenticated
  using (
    org_id = public.my_org_id()
    and public.is_manager()
    and exists (
      select 1 from public.task_templates tt
      where tt.id = template_id and public.manages_location(tt.location_id)
    )
  )
  with check (
    org_id = public.my_org_id()
    and public.is_manager()
    and exists (
      select 1 from public.task_templates tt
      where tt.id = template_id and public.manages_location(tt.location_id)
    )
  );

-- Backfill: 0 task_templates live today, so this affects nothing right
-- now -- written correctly regardless, for whenever templates exist.
insert into public.task_template_items (org_id, template_id, title, description, sort_order, is_required, requires_photo, max_photos)
select org_id, id, title, description, 0, is_required, requires_photo, max_photos
from public.task_templates;

-- ============================================================================
-- 2. task_items -- the unit of work
-- ============================================================================

create table public.task_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.my_org_id()
    references public.organisations (id) on delete cascade,
  task_id uuid not null references public.tasks (id) on delete cascade,
  template_item_id uuid references public.task_template_items (id) on delete set null,
  title text not null,
  description text,
  sort_order integer not null default 0,
  is_required boolean not null default true,
  requires_photo boolean not null default false,
  max_photos integer not null default 1 check (max_photos between 1 and 10),
  status text not null default 'pending' check (status in ('pending', 'submitted', 'approved', 'rejected')),
  completed_by uuid references public.profiles (id) on delete set null,
  completed_at timestamptz,
  reviewed_by uuid references public.profiles (id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

create index task_items_task_idx on public.task_items (task_id);
create index task_items_status_idx on public.task_items (status);

alter table public.task_items enable row level security;
alter table public.task_items force row level security;

create policy task_items_manager_all
  on public.task_items
  for all
  to authenticated
  using (
    org_id = public.my_org_id()
    and public.is_manager()
    and exists (select 1 from public.tasks t where t.id = task_id and public.manages_location(t.location_id))
  )
  with check (
    org_id = public.my_org_id()
    and public.is_manager()
    and exists (select 1 from public.tasks t where t.id = task_id and public.manages_location(t.location_id))
  );

create policy task_items_select_assigned
  on public.task_items
  for select
  to authenticated
  using (
    org_id = public.my_org_id()
    and exists (
      select 1 from public.tasks t
      where t.id = task_id
        and (t.assigned_user_id = (select auth.uid()) or t.assigned_role = public.my_role())
    )
  );

-- Moved from tasks_submit, same shape, joined through tasks for the
-- assignment check instead of reading it off the same row.
create policy task_items_submit
  on public.task_items
  for update
  to authenticated
  using (
    org_id = public.my_org_id()
    and status = any (array['pending', 'rejected'])
    and exists (
      select 1 from public.tasks t
      where t.id = task_id
        and (t.assigned_user_id = (select auth.uid()) or t.assigned_role = public.my_role())
    )
  )
  with check (status = any (array['pending', 'submitted']));

-- Backfill: exactly one item per existing task, carrying its current
-- status/completion/review across untouched. template_item_id is null --
-- no historical template-item mapping exists to derive it from.
insert into public.task_items (
  org_id, task_id, template_item_id, title, description, sort_order,
  is_required, requires_photo, max_photos,
  status, completed_by, completed_at, reviewed_by, reviewed_at, created_at
)
select org_id, id, null, title, description, 0,
       is_required, requires_photo, max_photos,
       status, completed_by, completed_at, reviewed_by, reviewed_at, created_at
from public.tasks;

-- ============================================================================
-- 3. task_photos: re-point to items
-- ============================================================================

alter table public.task_photos add column task_item_id uuid references public.task_items (id) on delete cascade;

update public.task_photos tp
set task_item_id = ti.id
from public.task_items ti
where ti.task_id = tp.task_id;

-- Recover any tasks.photo_path value 0025 didn't carry into task_photos.
-- Live check before writing this file found exactly this gap: 4 tasks
-- have photo_path set, only 3 already had a matching task_photos row.
-- Guarded on storage_path so this can never duplicate the 3 that are
-- already there. task_id is still NOT NULL at this point in the
-- migration (dropped further below, only once every row -- including
-- these -- has a task_item_id), so it must be set on this insert too.
insert into public.task_photos (org_id, task_id, task_item_id, storage_path, uploaded_by, created_at)
select t.org_id, t.id, ti.id, t.photo_path, t.completed_by, coalesce(t.completed_at, t.created_at)
from public.tasks t
join public.task_items ti on ti.task_id = t.id
where t.photo_path is not null
  and not exists (select 1 from public.task_photos tp where tp.storage_path = t.photo_path);

do $$
declare unmapped integer;
begin
  select count(*) into unmapped from public.task_photos where task_item_id is null;
  if unmapped > 0 then
    raise exception 'task_photos backfill incomplete: % row(s) with no task_item_id', unmapped;
  end if;
end $$;

alter table public.task_photos alter column task_item_id set not null;

-- task_photos_select/task_photos_insert both read task_id directly in
-- their USING/WITH CHECK (can_see_task(task_id)) -- Postgres refuses to
-- drop a column a policy depends on, so these must go before the column
-- does. The gap this leaves with no SELECT/INSERT policy on task_photos
-- is harmless: everything in this migration runs as the table owner
-- inside one transaction, not as 'authenticated' through PostgREST, and
-- the replacement policies (can_see_task_item-based) are created in
-- step 5 below, before this transaction ever commits.
drop policy task_photos_select on public.task_photos;
drop policy task_photos_insert on public.task_photos;

-- task_photos_task_id_idx auto-drops with the column (same as the tasks
-- indexes below) -- replace it with the item-keyed equivalent.
alter table public.task_photos drop column task_id;
create index task_photos_task_item_idx on public.task_photos (task_item_id);

-- ============================================================================
-- 4. task_comments: re-point to items -- rejection is per item now.
-- ============================================================================

alter table public.task_comments add column task_item_id uuid references public.task_items (id) on delete cascade;

update public.task_comments tc
set task_item_id = ti.id
from public.task_items ti
where ti.task_id = tc.task_id;

do $$
declare unmapped integer;
begin
  select count(*) into unmapped from public.task_comments where task_item_id is null;
  if unmapped > 0 then
    raise exception 'task_comments backfill incomplete: % row(s) with no task_item_id', unmapped;
  end if;
end $$;

alter table public.task_comments alter column task_item_id set not null;

-- Same dependency as task_photos above -- comments_select/comments_insert
-- read task_id directly (can_see_task(task_id)), so they must be dropped
-- before the column. Replacements created in step 5 below.
drop policy comments_select on public.task_comments;
drop policy comments_insert on public.task_comments;

-- task_comments_task_idx auto-drops with the column -- replace it with
-- the item-keyed equivalent, same (col, created_at) shape as before.
alter table public.task_comments drop column task_id;
create index task_comments_task_item_idx on public.task_comments (task_item_id, created_at);

-- ============================================================================
-- 5. can_see_task_item -- new companion to can_see_task (unchanged --
-- still valid for tasks_select_assigned, since assignment stays on
-- tasks), used by task_items/task_photos/task_comments RLS from here on.
-- ============================================================================

create function public.can_see_task_item(p_item_id uuid)
returns boolean
language sql
stable
security definer
set search_path to ''
as $function$
  select exists (
    select 1 from public.task_items ti
    where ti.id = p_item_id and public.can_see_task(ti.task_id)
  );
$function$;

create policy task_photos_select
  on public.task_photos
  for select
  to authenticated
  using (org_id = public.my_org_id() and public.can_see_task_item(task_item_id));

create policy task_photos_insert
  on public.task_photos
  for insert
  to authenticated
  with check (
    org_id = public.my_org_id()
    and uploaded_by = (select auth.uid())
    and public.can_see_task_item(task_item_id)
  );

create policy comments_select
  on public.task_comments
  for select
  to authenticated
  using (org_id = public.my_org_id() and public.can_see_task_item(task_item_id));

create policy comments_insert
  on public.task_comments
  for insert
  to authenticated
  with check (
    org_id = public.my_org_id()
    and sender_id = (select auth.uid())
    and public.can_see_task_item(task_item_id)
  );

-- ============================================================================
-- 6. Storage policy: fold in the item-keyed path. Existing objects live
-- under <task_id>/... and can't be safely renamed via SQL -- the
-- underlying object-store key wouldn't move with a bare column update on
-- storage.objects.name -- so both checks stay, permanently:
-- can_see_task_item() resolves new (item-keyed) paths, can_see_task()
-- resolves old (task-keyed) ones. can_see_task() evaluates false
-- harmlessly for any genuinely new item-keyed path.
-- ============================================================================

drop policy task_photos_read on storage.objects;
drop policy task_photos_write on storage.objects;

create policy task_photos_read
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'task-photos'
    and case
      when (storage.foldername(name))[1] ~ '^[0-9a-fA-F-]{36}$' then
        public.can_see_task_item(((storage.foldername(name))[1])::uuid)
        or public.can_see_task(((storage.foldername(name))[1])::uuid)
      else false
    end
  );

create policy task_photos_write
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'task-photos'
    and case
      when (storage.foldername(name))[1] ~ '^[0-9a-fA-F-]{36}$' then
        public.can_see_task_item(((storage.foldername(name))[1])::uuid)
        or public.can_see_task(((storage.foldername(name))[1])::uuid)
      else false
    end
  );

-- ============================================================================
-- 7. tasks: drop the columns that moved to task_items. photo_path and
-- overdue_notified_at both stay -- photo_path per the decision above;
-- overdue_notified_at because overdue notification is list-level (see
-- notify_overdue_tasks below), so its own bookkeeping belongs here too,
-- not on the item.
-- ============================================================================

drop policy tasks_submit on public.tasks;

alter table public.tasks
  drop column requires_photo,
  drop column is_required,
  drop column max_photos,
  drop column status,
  drop column completed_by,
  drop column completed_at,
  drop column reviewed_by,
  drop column reviewed_at;

-- tasks_role_idx/tasks_user_idx/tasks_org_history_idx all carried status,
-- so DROP COLUMN status above already auto-dropped them (Postgres drops
-- a plain index automatically when its column goes, no CASCADE needed --
-- explicitly dropping them again here would error "does not exist").
-- Recreate without status; task_items_status_idx (step 2) covers that
-- filter on its new table.
create index tasks_role_idx on public.tasks (org_id, assigned_role, task_day);
create index tasks_user_idx on public.tasks (assigned_user_id, task_day);
create index tasks_org_history_idx on public.tasks (org_id, task_day desc);

-- ============================================================================
-- 8. task_templates: drop the columns that moved to task_template_items.
-- description stays -- it's the list's own description.
-- ============================================================================

alter table public.task_templates
  drop column requires_photo,
  drop column is_required,
  drop column max_photos;

-- ============================================================================
-- 9. generate_task_instances -- one list per template per day, same
-- dedup index as before (tasks_template_day_idx, untouched by this
-- migration). Skips a template with no items entirely -- the list is
-- never created, not just left itemless -- then generates that list's
-- items from its template items.
-- ============================================================================

create or replace function public.generate_task_instances()
returns integer
language plpgsql
security definer
set search_path to ''
as $function$
declare
  made integer := 0;
  new_task record;
begin
  if session_user <> 'postgres'
     and not exists (select 1 from pg_catalog.pg_roles where rolname = session_user and rolsuper)
  then
    raise exception 'generate_task_instances() may only be run by pg_cron' using errcode = '42501';
  end if;

  for new_task in
    insert into public.tasks (
      org_id, template_id, location_id, title, description,
      assigned_role, assigned_user_id, start_time, due_time, created_by
    )
    select t.org_id, t.id, t.location_id, t.title, t.description,
           t.assigned_role, t.assigned_user_id,
           (current_date + t.start_at), (current_date + t.due_at), t.created_by
    from public.task_templates t
    where t.is_active
      and (t.recurrence = 'daily'
           or extract(dow from current_date)::smallint = any (t.weekdays))
      and exists (select 1 from public.task_template_items tti where tti.template_id = t.id)
    on conflict do nothing
    returning id, org_id, template_id
  loop
    insert into public.task_items (
      org_id, task_id, template_item_id, title, description, sort_order,
      is_required, requires_photo, max_photos
    )
    select new_task.org_id, new_task.id, tti.id, tti.title, tti.description, tti.sort_order,
           tti.is_required, tti.requires_photo, tti.max_photos
    from public.task_template_items tti
    where tti.template_id = new_task.template_id;

    made := made + 1;
  end loop;

  return made;
end; $function$;

-- ============================================================================
-- 10. notify_overdue_tasks -- one notification per LIST, naming how many
-- required items are still outstanding, not one per item (avoids burying
-- a manager under a dozen notifications for one overdue checklist).
-- ============================================================================

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

  with due_lists as (
    select t.id, t.org_id, t.title, t.assigned_user_id, t.assigned_role, count(*) as remaining
    from public.tasks t
    join public.task_items ti on ti.task_id = t.id and ti.status = 'pending' and ti.is_required
    where t.due_time < now()
      and t.overdue_notified_at is null
    group by t.id, t.org_id, t.title, t.assigned_user_id, t.assigned_role
  )
  insert into public.notifications (user_id, org_id, type, title, body)
  select p.id, d.org_id, 'task', 'Task overdue',
         d.title || ' — ' || d.remaining || ' required item'
           || (case when d.remaining = 1 then '' else 's' end) || ' remaining'
  from due_lists d
  join public.profiles p
    on p.org_id = d.org_id
   and p.is_active
   and (p.id = d.assigned_user_id or p.role = d.assigned_role);

  update public.tasks t
  set overdue_notified_at = now()
  where t.due_time < now()
    and t.overdue_notified_at is null
    and exists (
      select 1 from public.task_items ti
      where ti.task_id = t.id and ti.status = 'pending' and ti.is_required
    );

  get diagnostics sent = row_count;
  return sent;
end; $function$;

-- ============================================================================
-- 11. tg_task_notify splits in two. The "new one-off list assigned to a
-- person" branch stays here on tasks. Submitted/rejected/approved moves
-- to a new tg_task_item_notify trigger on task_items.
--
-- The original function's status-transition branches only ran on UPDATE
-- because they were gated behind old.status/new.status comparisons --
-- with those branches gone, the remaining insert-only logic has no such
-- gate of its own, so the trigger itself is re-scoped to INSERT only
-- (was AFTER INSERT OR UPDATE). Without this, editing a one-off task's
-- assignee later would spuriously refire "New task".
-- ============================================================================

drop trigger task_notify on public.tasks;

create or replace function public.tg_task_notify()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if new.template_id is null
     and new.assigned_user_id is not null
     and new.assigned_user_id <> coalesce((select auth.uid()), '00000000-0000-0000-0000-000000000000'::uuid)
  then
    insert into public.notifications (user_id, org_id, type, title, body)
    values (new.assigned_user_id, new.org_id, 'task', 'New task', new.title);
  end if;
  return new;
end; $function$;

create trigger task_notify
  after insert on public.tasks
  for each row execute function public.tg_task_notify();

create or replace function public.tg_task_item_notify()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  actor uuid := coalesce((select auth.uid()), '00000000-0000-0000-0000-000000000000'::uuid);
  v_task public.tasks%rowtype;
begin
  if new.status = old.status then
    return new;
  end if;

  select * into v_task from public.tasks where id = new.task_id;

  if new.status = 'submitted' then
    perform public.notify_org_managers(v_task.org_id, 'task',
      'Task submitted', new.title || ' is ready for review.');

  elsif new.status = 'rejected' then
    if new.completed_by is not null then
      insert into public.notifications (user_id, org_id, type, title, body)
      values (new.completed_by, v_task.org_id, 'task', 'Task needs redoing',
              new.title || ' — see the comment for what to change.');
    end if;

  elsif new.status = 'approved' then
    if new.completed_by is not null and new.completed_by <> actor then
      insert into public.notifications (user_id, org_id, type, title, body)
      values (new.completed_by, v_task.org_id, 'task', 'Task approved', new.title);
    end if;
  end if;

  return new;
end; $function$;

create trigger task_item_notify
  after update on public.task_items
  for each row execute function public.tg_task_item_notify();

-- ============================================================================
-- 12. tg_task_comment_notify -- reads task_items by the comment's new
-- task_item_id, joins tasks for the assignee fallback and org_id.
-- ============================================================================

create or replace function public.tg_task_comment_notify()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_item public.task_items%rowtype;
  v_task public.tasks%rowtype;
  v_sender_is_manager boolean;
begin
  select * into v_item from public.task_items where id = new.task_item_id;
  select * into v_task from public.tasks where id = v_item.task_id;

  select coalesce(r.can_manage, false) into v_sender_is_manager
  from public.profiles p
  left join public.roles r on r.org_id = p.org_id and r.name = p.role
  where p.id = new.sender_id;

  if v_sender_is_manager then
    if coalesce(v_item.completed_by, v_task.assigned_user_id) is not null then
      insert into public.notifications (user_id, org_id, type, title, body)
      values (coalesce(v_item.completed_by, v_task.assigned_user_id),
              v_task.org_id, 'task', 'Comment on a task', v_item.title);
    end if;
  else
    perform public.notify_org_managers(v_task.org_id, 'task',
      'Comment on a task', v_item.title);
  end if;
  return new;
end; $function$;

-- ============================================================================
-- 13. purge_old_task_photos -- joins task_photos straight to task_items
-- now (no more going through tasks). Still nulls the legacy
-- tasks.photo_path for anything old enough to purge, keyed off
-- task_items.completed_at since tasks.completed_at no longer exists.
-- ============================================================================

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
  join public.task_items ti on ti.id = tp.task_item_id
  where o.bucket_id = 'task-photos'
    and o.name = tp.storage_path
    and ti.completed_at < now() - interval '1 month';

  delete from public.task_photos tp
  using public.task_items ti
  where ti.id = tp.task_item_id
    and ti.completed_at < now() - interval '1 month';

  update public.tasks t
  set photo_path = null
  where t.photo_path is not null
    and exists (
      select 1 from public.task_items ti
      where ti.task_id = t.id and ti.completed_at < now() - interval '1 month'
    );

  get diagnostics purged = row_count;
  return purged;
end; $function$;

-- ============================================================================
-- 14. Final integrity check. Aborts the whole migration -- nothing above
-- this point is kept -- if anything fails to reconcile against the
-- snapshot taken in step 0.
-- ============================================================================

do $$
declare
  v_before record;
  v_items integer;
  v_photos_after integer;
  v_comments_after integer;
  v_mismatched_items integer;
begin
  select * into v_before from _migration_before_counts;

  select count(*) into v_items from public.task_items;
  select count(*) into v_photos_after from public.task_photos;
  select count(*) into v_comments_after from public.task_comments;
  select count(*) into v_mismatched_items from (
    select task_id from public.task_items group by task_id having count(*) <> 1
  ) x;

  if v_items <> v_before.tasks_count then
    raise exception 'task_items count % does not match pre-migration tasks count %', v_items, v_before.tasks_count;
  end if;

  if v_mismatched_items <> 0 then
    raise exception '% task(s) do not have exactly one task_item', v_mismatched_items;
  end if;

  -- >= not =: the photo_path recovery insert (step 3) can grow this by
  -- whatever wasn't already represented in task_photos.
  if v_photos_after < v_before.photos_count then
    raise exception 'task_photos count dropped: % now vs % before', v_photos_after, v_before.photos_count;
  end if;

  if v_comments_after <> v_before.comments_count then
    raise exception 'task_comments count changed: % now vs % before', v_comments_after, v_before.comments_count;
  end if;
end $$;

commit;
