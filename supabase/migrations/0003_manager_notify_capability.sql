-- ============================================================================
-- 0003_manager_notify_capability.sql
--
-- notify_org_managers() and tg_task_comment_notify() still compared
-- profiles.role to the literal string 'Manager' — stale since permissions
-- moved to roles.can_manage/is_admin and the old Manager role was renamed
-- Administrator. Since nobody's role is literally 'Manager' any more,
-- both were matching nobody: manager notifications for shift swaps,
-- overtime claims, unavailability requests, open-shift applications,
-- submitted tasks, and non-manager task comments have been going out to
-- no one since that rename.
--
-- notify_location_managers() vs notify_org_managers(): checked whether
-- these have diverged, and whether one should call the other.
-- notify_location_managers() already joins roles and checks r.can_manage
-- correctly — it was never broken. The two are not interchangeable,
-- though: notify_location_managers() takes a p_location_id and only
-- notifies managers scoped to that location (or every Administrator, who
-- manages every location); notify_org_managers() has no location
-- parameter and is used exactly where every manager in the org — not
-- just ones scoped to one location — should hear about something (a
-- swap awaiting approval, an overtime claim, a time-off request, an open
-- shift application, a task submitted for review). Passing a null
-- location into notify_location_managers() would not reproduce that: its
-- `pl.location_id = p_location_id` comparison is never true against a
-- null, so only Administrators would be notified, silently dropping
-- location-scoped Managers from every one of those org-wide notices.
-- notify_org_managers() is fixed here to the same can_manage join,
-- independently, rather than delegating to notify_location_managers().
--
-- Audited every other function in the baseline for a role-name
-- comparison of any kind, not just 'Manager'. Everything else that
-- touches profiles.role falls into one of two categories, neither of
-- which needed a change:
--   - The correct pattern already: is_admin(), is_manager(),
--     my_can_view_map(), notify_location_managers(), and
--     tg_protect_profile_role() (via is_manager()) all join roles on
--     r.name = p.role and read a capability flag, never a literal name.
--   - Legitimate role-as-a-label matching, unrelated to permissions:
--     notify_overdue_tasks() and tg_shift_insert_notify() match a
--     profile's role against tasks.assigned_role / shifts.required_role
--     (the shared-pool assignment mechanism); shifts_select_same_role and
--     swaps_insert_own (RLS policies) match two profiles' roles against
--     each other for peer/swap eligibility. These compare a role to
--     another role column, not to a hardcoded name, and encode an actual
--     business rule rather than a permission check — left alone.
--   - One cosmetic-only leftover, not a logic bug: tg_protect_profile_role()
--     still raises the message 'Only a Manager may change role' — the
--     check itself already calls is_manager()/can_manage, this is just
--     the wording in the exception text. Not changed here since it is
--     text, not logic; flag if you want it reworded to "Administrator or
--     Manager" or similar.
-- ============================================================================

create or replace function public.notify_org_managers(p_org_id uuid, p_type text, p_title text, p_body text)
 returns void
 language sql
 security definer
 set search_path to ''
as $function$
  insert into public.notifications (user_id, org_id, type, title, body)
  select p.id, p_org_id, p_type, p_title, p_body
  from public.profiles p
  join public.roles r on r.org_id = p.org_id and r.name = p.role
  where p.org_id = p_org_id and r.can_manage and p.is_active;
$function$;

create or replace function public.tg_task_comment_notify()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_task public.tasks%rowtype;
  v_sender_is_manager boolean;
begin
  select * into v_task from public.tasks where id = new.task_id;

  select coalesce(r.can_manage, false) into v_sender_is_manager
  from public.profiles p
  left join public.roles r on r.org_id = p.org_id and r.name = p.role
  where p.id = new.sender_id;

  if v_sender_is_manager then
    -- Prefer whoever did the work; fall back to the assignee.
    if coalesce(v_task.completed_by, v_task.assigned_user_id) is not null then
      insert into public.notifications (user_id, org_id, type, title, body)
      values (coalesce(v_task.completed_by, v_task.assigned_user_id),
              v_task.org_id, 'task', 'Comment on a task', v_task.title);
    end if;
  else
    perform public.notify_org_managers(v_task.org_id, 'task',
      'Comment on a task', v_task.title);
  end if;
  return new;
end; $function$;
