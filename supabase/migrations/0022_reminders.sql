-- ============================================================================
-- 0022_reminders.sql
--
-- Reminders: an admin sends a titled message with a description to a role
-- or an individual, one-off or recurring, and staff must acknowledge it.
-- Mirrors the task module's shape throughout, since it already solves the
-- same three problems (a recurring definition vs. its generated instances,
-- role-or-individual targeting, admin-authored content staff must action)
-- -- see task_templates/tasks/task_comments.
--
-- reminder_templates: the recurring definition only. A one-off reminder
-- skips this table entirely and writes straight to reminders.
--
-- reminders: the instances staff actually see and acknowledge. template_id
-- is null for a one-off reminder, set for a generated one.
-- reminder_notified_at mirrors tasks.overdue_notified_at -- the
-- send-at-passed notification cron (notify_reminders, below) needs it to
-- avoid re-notifying the same reminder every run; not in the original spec
-- but required for that cron to be idempotent, same reasoning as the
-- existing tasks column.
--
-- reminder_acknowledgements: one row per (reminder, profile) -- the fact
-- that a specific person has seen and dismissed a specific reminder.
--
-- Both target_role and target_user_id are nullable on both tables, but at
-- least one must be set on each, enforced by a check constraint -- a
-- reminder with neither would be invisible to anyone but an admin.
-- ============================================================================

create table public.reminder_templates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.my_org_id()
    references public.organisations (id) on delete cascade,
  title text not null,
  body text,
  target_role text,
  target_user_id uuid references public.profiles (id) on delete set null,
  recurrence text not null default 'daily' check (recurrence in ('daily', 'weekly')),
  weekdays smallint[] not null default '{0,1,2,3,4,5,6}',
  send_at time not null,
  is_active boolean not null default true,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint reminder_templates_target_check
    check (target_role is not null or target_user_id is not null)
);

create table public.reminders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.my_org_id()
    references public.organisations (id) on delete cascade,
  template_id uuid references public.reminder_templates (id) on delete set null,
  title text not null,
  body text,
  target_role text,
  target_user_id uuid references public.profiles (id) on delete set null,
  send_at timestamptz not null,
  reminder_notified_at timestamptz,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  reminder_day date generated always as
    ((send_at at time zone 'Europe/London')::date) stored,
  constraint reminders_target_check
    check (target_role is not null or target_user_id is not null)
);

-- One instance per template per day -- same pattern as tasks.task_day /
-- generate_task_instances' plain INSERT ... ON CONFLICT DO NOTHING relying
-- on exactly this index.
create unique index reminders_template_day_idx
  on public.reminders (template_id, reminder_day)
  where template_id is not null;

create table public.reminder_acknowledgements (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null default public.my_org_id()
    references public.organisations (id) on delete cascade,
  reminder_id uuid not null references public.reminders (id) on delete cascade,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  acknowledged_at timestamptz not null default now(),
  unique (reminder_id, profile_id)
);

alter table public.reminder_templates enable row level security;
alter table public.reminder_templates force row level security;
alter table public.reminders enable row level security;
alter table public.reminders force row level security;
alter table public.reminder_acknowledgements enable row level security;
alter table public.reminder_acknowledgements force row level security;

-- Templates: admin-only, full stop -- same shape as staff_wage_rates_admin_all.
-- No manager or staff policy at all; staff only ever see generated
-- reminders, never the template that generates them (same relationship as
-- task_templates vs. tasks, except templates here are admin-scoped rather
-- than manager-scoped, per spec).
create policy reminder_templates_admin_all
  on public.reminder_templates
  for all
  to authenticated
  using (public.is_admin() and org_id = public.my_org_id())
  with check (public.is_admin() and org_id = public.my_org_id());

-- Reminders: admins do everything, including create/update/delete.
create policy reminders_admin_all
  on public.reminders
  for all
  to authenticated
  using (public.is_admin() and org_id = public.my_org_id())
  with check (public.is_admin() and org_id = public.my_org_id());

-- Read-only for everyone else: the reminder's own target, or a manager who
-- manages the sender. A reminder has no location_id the way a task does, so
-- there's no manages_location() to check here -- manages_person(created_by)
-- is the closest equivalent, the same helper used everywhere else a
-- manager's reach over another profile is checked.
create policy reminders_select_targeted
  on public.reminders
  for select
  to authenticated
  using (
    org_id = public.my_org_id()
    and (
      target_user_id = (select auth.uid())
      or target_role = public.my_role()
      or (public.is_manager() and public.manages_person(created_by))
    )
  );

-- A user may acknowledge a reminder only if it actually targets them --
-- same shape as comments_insert requiring can_see_task(task_id), so
-- acknowledging someone else's individually-targeted reminder is rejected
-- by the database, not just hidden by the UI never offering it.
create policy reminder_acks_insert_own
  on public.reminder_acknowledgements
  for insert
  to authenticated
  with check (
    profile_id = (select auth.uid())
    and org_id = public.my_org_id()
    and exists (
      select 1 from public.reminders r
      where r.id = reminder_id
        and r.org_id = public.my_org_id()
        and (r.target_user_id = (select auth.uid()) or r.target_role = public.my_role())
    )
  );

create policy reminder_acks_select_own
  on public.reminder_acknowledgements
  for select
  to authenticated
  using (profile_id = (select auth.uid()));

create policy reminder_acks_select_managers
  on public.reminder_acknowledgements
  for select
  to authenticated
  using ((public.is_manager() or public.is_admin()) and org_id = public.my_org_id());

-- Generation: mirrors generate_task_instances exactly, including building
-- send_at from current_date in the session's own timezone rather than
-- Europe/London -- consistent with the existing task cron, not a new
-- correctness bug introduced here.
create function public.generate_reminder_instances()
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
    raise exception 'generate_reminder_instances() may only be run by pg_cron' using errcode = '42501';
  end if;

  insert into public.reminders (
    org_id, template_id, title, body, target_role, target_user_id, send_at, created_by
  )
  select t.org_id, t.id, t.title, t.body, t.target_role, t.target_user_id,
         (current_date + t.send_at), t.created_by
  from public.reminder_templates t
  where t.is_active
    and (t.recurrence = 'daily'
         or extract(dow from current_date)::smallint = any(t.weekdays))
  on conflict do nothing;

  get diagnostics made = row_count;
  return made;
end; $function$;

revoke all on function public.generate_reminder_instances() from public, anon, authenticated;

-- Notification: mirrors notify_overdue_tasks. 'reminder' is simply a new
-- value in notifications.type -- that column is free text with no check
-- constraint, so this needs no schema change there, only the client's
-- type-to-icon map (NotificationBell.tsx) learning it.
create function public.notify_reminders()
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
    raise exception 'notify_reminders() may only be run by pg_cron' using errcode = '42501';
  end if;

  insert into public.notifications (user_id, org_id, type, title, body)
  select p.id, r.org_id, 'reminder', r.title, r.body
  from public.reminders r
  join public.profiles p
    on p.org_id = r.org_id
   and p.is_active
   and (p.id = r.target_user_id or p.role = r.target_role)
  where r.send_at <= now()
    and r.reminder_notified_at is null;

  update public.reminders
  set reminder_notified_at = now()
  where send_at <= now() and reminder_notified_at is null;

  get diagnostics sent = row_count;
  return sent;
end; $function$;

revoke all on function public.notify_reminders() from public, anon, authenticated;

-- Hourly generation, same cadence as generate-tasks (offset ten minutes so
-- the two don't compete for the same tick); notification checked every 15
-- minutes, same cadence as notify-overdue-tasks.
select cron.schedule('generate-reminders', '10 * * * *',   $$select public.generate_reminder_instances();$$);
select cron.schedule('notify-reminders',   '*/15 * * * *', $$select public.notify_reminders();$$);
