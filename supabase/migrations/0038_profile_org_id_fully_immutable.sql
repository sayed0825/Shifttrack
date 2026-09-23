-- ============================================================================
-- 0038_profile_org_id_fully_immutable.sql
--
-- The manager-side version of finding 1 (2026-09-23 follow-up). 0033
-- closed org_id for everyone except an administrator, on the theory that
-- "an admin may move someone between organisations" was a real,
-- deliberate capability. It never was: profiles_manager_all's with_check
-- pins org_id = my_org_id() for ANY manager/admin acting on another row,
-- so that path was already unreachable, trigger or no trigger. What was
-- reachable, and left genuinely open: 0033's own is_admin() carve-out on
-- org_id has no destination check at all, so an administrator could set
-- their OWN org_id to ANY organisation in the entire database, not just
-- one they have any relationship to -- self-relocating into a completely
-- unrelated org and inheriting whatever admin powers that org grants.
-- Confirmed no legitimate workflow anywhere in the app ever writes
-- profiles.org_id (grep across src/ turns up nothing) -- there is no real
-- "reassign a user's organisation" feature to preserve.
--
-- Closes it completely: org_id can never change on an existing profile,
-- for anyone, admin included. A genuine org move is a bigger operation
-- than this column update covers anyway -- every other table
-- (time_logs, shifts, delivery_runs, ...) carries its own org_id, none
-- of which this trigger (or any UPDATE on profiles) would ever touch, so
-- "moving" a profile's org_id alone would silently orphan the rest of
-- that person's history from their new org's view of it regardless.
-- ============================================================================

begin;

create or replace function public.tg_protect_profile_role()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_new_role_is_privileged boolean;
begin
  if (select auth.uid()) is null then
    return new;
  end if;

  if new.org_id is distinct from old.org_id then
    raise exception 'Organisation cannot be changed on an existing profile' using errcode = '42501';
  end if;

  if new.role is distinct from old.role then
    if not public.is_manager() then
      raise exception 'Only a Manager may change role' using errcode = '42501';
    end if;

    select exists (
      select 1 from public.roles r
      where r.org_id = new.org_id and r.name = new.role and (r.is_admin or r.can_manage)
    ) into v_new_role_is_privileged;

    if v_new_role_is_privileged and not public.is_admin() then
      raise exception 'Only an Administrator may grant a manager or admin role' using errcode = '42501';
    end if;
  end if;

  if (new.is_active is distinct from old.is_active
      or new.accepted_at is distinct from old.accepted_at
      or new.email is distinct from old.email)
     and not public.is_admin()
     and (not public.is_manager() or new.id = (select auth.uid())) then
    raise exception 'Only a Manager or Administrator may change this' using errcode = '42501';
  end if;

  return new;
end; $function$;

commit;
