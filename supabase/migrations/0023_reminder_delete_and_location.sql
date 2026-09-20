-- ============================================================================
-- 0023_reminder_delete_and_location.sql
--
-- Two additions to reminders (0022):
--
-- 1. Location narrowing. target_location_id, nullable, on both
--    reminder_templates and reminders -- null means every location (today's
--    behaviour, unchanged), set means only staff assigned to that location
--    via profile_locations. Composite (target_location_id, org_id) FK to
--    locations (id, org_id), same cross-tenant-safety pattern as every
--    other location_id in the schema (0013) -- ON DELETE SET NULL scoped to
--    just that column, since org_id stays NOT NULL.
--
--    Recipient resolution (notify_reminders, and both RLS policies that
--    decide what a targeted person can see/acknowledge) becomes: matching
--    role AND, if target_location_id is set, assigned to that location.
--    Individual-targeted reminders (target_user_id set) are unaffected --
--    the location narrows a role's audience, and an individual target is
--    already one specific person.
--
-- 2. Delete is already fully covered by the existing admin-ALL policies on
--    both tables (no RLS change needed) and reminder_acknowledgements was
--    already ON DELETE CASCADE from reminder_id (0022) -- deleting a
--    reminder already takes its acknowledgements with it. Deleting a
--    recurring instance's template is what stops the series (template_id
--    is ON DELETE SET NULL on reminders, so past instances are untouched);
--    deleting just the instance does not touch the template at all. Both
--    are plain deletes the app already had permission to do -- this
--    migration has nothing to add for that part, it's app-code only.
-- ============================================================================

alter table public.reminder_templates
  add column target_location_id uuid;

alter table public.reminder_templates
  add constraint reminder_templates_location_org_fkey
  foreign key (target_location_id, org_id) references public.locations (id, org_id)
  on delete set null (target_location_id);

alter table public.reminders
  add column target_location_id uuid;

alter table public.reminders
  add constraint reminders_location_org_fkey
  foreign key (target_location_id, org_id) references public.locations (id, org_id)
  on delete set null (target_location_id);

-- Generation: carry target_location_id from template to instance, same as
-- every other target_* column.
create or replace function public.generate_reminder_instances()
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
    org_id, template_id, title, body, target_role, target_user_id, target_location_id, send_at, created_by
  )
  select t.org_id, t.id, t.title, t.body, t.target_role, t.target_user_id, t.target_location_id,
         (current_date + t.send_at), t.created_by
  from public.reminder_templates t
  where t.is_active
    and (t.recurrence = 'daily'
         or extract(dow from current_date)::smallint = any(t.weekdays))
  on conflict do nothing;

  get diagnostics made = row_count;
  return made;
end; $function$;

-- Notification: a role match now also requires being assigned to the
-- reminder's target_location_id via profile_locations, when one is set.
create or replace function public.notify_reminders()
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
   and (
     p.id = r.target_user_id
     or (
       p.role = r.target_role
       and (
         r.target_location_id is null
         or exists (
           select 1 from public.profile_locations pl
           where pl.profile_id = p.id and pl.location_id = r.target_location_id
         )
       )
     )
   )
  where r.send_at <= now()
    and r.reminder_notified_at is null;

  update public.reminders
  set reminder_notified_at = now()
  where send_at <= now() and reminder_notified_at is null;

  get diagnostics sent = row_count;
  return sent;
end; $function$;

-- Read access: someone should not see (or be able to acknowledge) a
-- reminder aimed at a role at a location they don't work at.
drop policy reminders_select_targeted on public.reminders;
create policy reminders_select_targeted
  on public.reminders
  for select
  to authenticated
  using (
    org_id = public.my_org_id()
    and (
      target_user_id = (select auth.uid())
      or (
        target_role = public.my_role()
        and (
          target_location_id is null
          or exists (
            select 1 from public.profile_locations pl
            where pl.profile_id = (select auth.uid()) and pl.location_id = target_location_id
          )
        )
      )
      or (public.is_manager() and public.manages_person(created_by))
    )
  );

drop policy reminder_acks_insert_own on public.reminder_acknowledgements;
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
        and (
          r.target_user_id = (select auth.uid())
          or (
            r.target_role = public.my_role()
            and (
              r.target_location_id is null
              or exists (
                select 1 from public.profile_locations pl
                where pl.profile_id = (select auth.uid()) and pl.location_id = r.target_location_id
              )
            )
          )
        )
    )
  );
