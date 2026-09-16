-- ============================================================================
-- 0021_shift_notify_guard_deleted_profile.sql
--
-- tg_shift_delete_notify (AFTER DELETE on shifts) failed with
-- notifications_user_id_fkey when the shift was deleted as part of a
-- cascade that had already removed the profile it points at.
-- notifications.user_id is ON DELETE CASCADE, not SET NULL, so an INSERT
-- referencing a profile id that no longer exists is a hard FK violation,
-- not a silent no-op. This happens when an organisations row is deleted:
-- both profiles.org_id and shifts.org_id cascade from the same parent
-- delete, and Postgres gives no guarantee about which sibling cascade runs
-- first -- if profiles happens to go first, shifts.assigned_user_id is
-- already dangling by the time shift_delete_notify's AFTER DELETE trigger
-- fires and tries to notify it.
--
-- Audited every other notify trigger for the same hazard (a notification
-- insert that reads an old/new person id which could already be gone) and
-- found one more, via a different mechanism: tg_shift_update_notify.
-- shifts.assigned_user_id is ON DELETE SET NULL, so deleting a profile
-- directly -- delete_staff_member(), the "Delete permanently" flow already
-- shipped in StaffManager -- fires this trigger as an UPDATE (the SET NULL
-- action) while `old.assigned_user_id` is the profile that was just
-- deleted in the same statement. Every other notify trigger in the schema
-- either only reads freshly-inserted/still-live columns (INSERT triggers,
-- or UPDATE triggers gated on a status transition rather than a nulled
-- FK column) or targets a table whose FK to profiles is itself CASCADE
-- (the row is gone, not updated, so no stale read is possible) -- see the
-- session notes for the full table-by-table pass; no other function
-- needed this guard.
--
-- Fix, in both functions: skip the insert (rather than erroring) if the
-- target profile no longer exists. A shift being deleted alongside the
-- person it was assigned to has nobody left to notify -- that is
-- legitimately a no-op, not a failure.
-- ============================================================================

create or replace function public.tg_shift_delete_notify()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if old.assigned_user_id is not null
     and old.assigned_user_id <> coalesce((select auth.uid()), '00000000-0000-0000-0000-000000000000'::uuid)
     and exists (select 1 from public.profiles where id = old.assigned_user_id) then
    insert into public.notifications (user_id, org_id, type, title, body)
    values (old.assigned_user_id, old.org_id, 'shift', 'Shift cancelled',
            'One of your shifts has been removed from the rota.');
  end if;
  return old;
end; $function$;

create or replace function public.tg_shift_update_notify()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare actor uuid := coalesce((select auth.uid()), '00000000-0000-0000-0000-000000000000'::uuid);
begin
  if new.assigned_user_id is distinct from old.assigned_user_id then
    if new.assigned_user_id is not null and new.assigned_user_id <> actor
       and exists (select 1 from public.profiles where id = new.assigned_user_id) then
      insert into public.notifications (user_id, org_id, type, title, body)
      values (new.assigned_user_id, new.org_id, 'shift', 'Shift assigned to you',
              'A shift has been added to your rota.');
    end if;
    if old.assigned_user_id is not null and old.assigned_user_id <> actor
       and exists (select 1 from public.profiles where id = old.assigned_user_id) then
      insert into public.notifications (user_id, org_id, type, title, body)
      values (old.assigned_user_id, new.org_id, 'shift', 'Shift removed',
              'A shift is no longer assigned to you.');
    end if;
  elsif new.assigned_user_id is not null
        and new.assigned_user_id <> actor
        and (new.start_time is distinct from old.start_time
             or new.end_time is distinct from old.end_time
             or new.location_id is distinct from old.location_id)
        and exists (select 1 from public.profiles where id = new.assigned_user_id) then
    insert into public.notifications (user_id, org_id, type, title, body)
    values (new.assigned_user_id, new.org_id, 'shift', 'Shift changed',
            'The time or location of one of your shifts has changed.');
  end if;
  return new;
end; $function$;
