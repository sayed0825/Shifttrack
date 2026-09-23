-- ============================================================================
-- 0033_profiles_self_edit_protection.sql
--
-- Security audit findings 1, 4, 10 (2026-09-23) -- confirmed live against a
-- throwaway org + real session before writing this: profiles_update_own's
-- with_check is just `id = auth.uid()`, no column restriction, and
-- tg_protect_profile_role only ever checked `role`. An ordinary employee
-- could set org_id (full cross-tenant move -- every my_org_id()-scoped
-- policy in the schema then treats them as a member of the other org),
-- is_active (self-reactivate after being deactivated, with the same
-- still-valid session -- defeats "deactivate, don't delete" as an actual
-- access-revocation control), and accepted_at, all with zero error.
-- email added to the same fix even though it wasn't one of the original
-- test probes -- same missing-column-check pattern, and profiles.email
-- is meant to be a one-way mirror of auth.users.email
-- (sync_profile_email), not independently writable.
--
-- Also closes a related privilege-escalation path this audit's own fix
-- for invite-staff (finding 2) would otherwise leave open elsewhere: the
-- existing role trigger let ANY is_manager() caller change role on ANY
-- row, including their own, with no check on what the NEW role actually
-- grants -- a plain Manager could self-promote to Administrator by
-- direct table update, the exact same escalation invite-staff is being
-- fixed to reject. Same rule, both places now: granting a role that
-- carries is_admin or can_manage requires being an admin yourself.
--
-- Rule, in full:
-- - org_id: immutable for everyone except an admin. Not even a manager
--   who otherwise manages this person may move them between orgs.
-- - role: any manager may still change it (existing behaviour, kept),
--   UNLESS the new role itself carries is_admin/can_manage, in which case
--   only an admin may grant it.
-- - is_active / accepted_at / email: a manager may change these for
--   someone they manage (RLS -- profiles_manager_all's manages_person(id)
--   -- already restricts which other rows a manager can reach at all;
--   this only gates the columns). Nobody may change them on their OWN
--   row unless they're an admin.
-- - A null auth.uid() (service_role -- the invite Edge Function's own
--   profile upsert) is a trusted server context, unchanged from before.
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

  if new.org_id is distinct from old.org_id and not public.is_admin() then
    raise exception 'Only an Administrator may change organisation' using errcode = '42501';
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
