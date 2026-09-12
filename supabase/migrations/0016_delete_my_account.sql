-- ============================================================================
-- 0016_delete_my_account.sql
--
-- App Store compliance: Apple requires in-app account deletion, not just
-- deactivation. Resolution: delete the login and personal details,
-- anonymise the profile, keep time_logs/shifts under payroll/legal
-- retention.
--
-- STRUCTURAL CHANGE, found while writing this, not optional: profiles.id
-- currently has `references auth.users(id) on delete cascade`. Deleting
-- auth.users -- as instructed, last -- would immediately cascade-delete
-- the just-anonymised profiles row too, which cascades further to
-- time_logs, employee_notes (via employee_id), live_locations,
-- profile_locations, notifications, shift_applications and shift_swaps.
-- That is the opposite of "keep time logs intact" and "leave
-- employee_notes" -- there is no way to satisfy both "auth.users is
-- deleted" and "profiles survives, anonymised" while this FK exists, so
-- it is dropped entirely. profiles.id remains the primary key; it just
-- no longer requires a live auth.users row to exist.
--
-- Consequence for delete_staff_member(): it currently only deletes
-- auth.users and relies on exactly the cascade being removed here to
-- also wipe the profile and everything under it. Updated in the same
-- migration to explicitly delete public.profiles itself first (which
-- still cascades to time_logs etc. via their own unchanged FKs) --
-- same end result as before, no longer dependent on the FK just
-- dropped.
--
-- Also fixed here: unavailability_requests.decided_by and
-- overtime_claims.decided_by referenced profiles(id) with no ON DELETE
-- action at all (default NO ACTION) -- deleting a profiles row that
-- ever approved/denied a request as a manager already failed today,
-- before this migration, independent of everything above. Both changed
-- to SET NULL: the decision stands as a historical record even once the
-- manager who made it is gone, the same choice already made for every
-- comparable "who acted on this" column (shifts.created_by,
-- tasks.created_by/reviewed_by/completed_by, task_templates.created_by,
-- employee_notes.manager_id/deleted_by all already SET NULL).
--
-- Checked every other foreign key referencing profiles(id) in the
-- schema (24 total) for the same missing-action problem: these two were
-- the only ones. Every other one already has an explicit action, and
-- each already reads as the deliberate right choice -- SET NULL
-- wherever the record should survive without its author (every
-- created_by/assigned_user_id/reviewed_by/completed_by column, plus
-- employee_notes.manager_id/deleted_by), CASCADE only where the row is
-- meaningless without the person it belongs to (time_logs, shifts to
-- one's own live_locations/profile_locations/notifications, shift_swaps
-- and shift_applications by the requesting/target user, overtime_claims
-- and unavailability_requests by the requesting user, employee_notes by
-- the employee it is about, task_comments by its sender).
-- ============================================================================

alter table public.overtime_claims
  drop constraint overtime_claims_decided_by_fkey,
  add constraint overtime_claims_decided_by_fkey
    foreign key (decided_by) references public.profiles (id) on delete set null;

alter table public.unavailability_requests
  drop constraint unavailability_requests_decided_by_fkey,
  add constraint unavailability_requests_decided_by_fkey
    foreign key (decided_by) references public.profiles (id) on delete set null;

alter table public.profiles drop constraint profiles_id_fkey;

create or replace function public.delete_staff_member(p_user_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
  if not public.is_manager() then
    raise exception 'Only a manager may delete staff' using errcode = '42501';
  end if;
  if p_user_id = (select auth.uid()) then
    raise exception 'You cannot delete your own account';
  end if;
  if not public.manages_person(p_user_id) then
    raise exception 'That person is not at a location you manage'
      using errcode = '42501';
  end if;
  -- profiles no longer references auth.users, so both are deleted
  -- explicitly. Deleting profiles first is what cascades to time_logs
  -- and everything else this RPC has always wiped.
  delete from public.profiles where id = p_user_id;
  delete from auth.users where id = p_user_id;
end; $function$;


-- ----------------------------------------------------------------------------
-- delete_my_account() -- self-service, no arguments, operates on the
-- caller's own auth.uid().
-- ----------------------------------------------------------------------------

create or replace function public.delete_my_account()
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_user_id uuid := (select auth.uid());
  v_org_id uuid;
begin
  if v_user_id is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;

  select org_id into v_org_id from public.profiles where id = v_user_id;
  if v_org_id is null then
    raise exception 'Profile not found';
  end if;

  -- Refuse if the caller is an administrator and no other active
  -- administrator exists in the org -- otherwise the org is orphaned.
  if exists (
       select 1 from public.profiles p
       join public.roles r on r.org_id = p.org_id and r.name = p.role
       where p.id = v_user_id and r.is_admin
     )
     and not exists (
       select 1 from public.profiles p
       join public.roles r on r.org_id = p.org_id and r.name = p.role
       where p.org_id = v_org_id and r.is_admin and p.is_active and p.id <> v_user_id
     )
  then
    raise exception 'You are the only administrator in your organisation. Assign another administrator before deleting your account.';
  end if;

  -- Anonymise, never delete, the profile itself -- time_logs and shifts
  -- reference it and must survive. Writing profiles.email directly
  -- (rather than through tg_sync_profile_email, which only fires on
  -- auth.users.email changes) is safe specifically because auth.users
  -- is deleted immediately after, in this same function -- there is no
  -- later sync to fight with.
  update public.profiles
  set full_name = 'Deleted user',
      first_name = null,
      email = null,
      is_active = false,
      accepted_at = null
  where id = v_user_id;

  -- The account's own data, not a record about anyone else -- delete
  -- outright.
  delete from public.live_locations where user_id = v_user_id;
  delete from public.profile_locations where profile_id = v_user_id;
  delete from public.notifications where user_id = v_user_id;

  -- Only requests still awaiting a decision. Anything already
  -- approved/denied is historical scheduling record -- same treatment
  -- as time_logs/shifts, left alone.
  delete from public.unavailability_requests where user_id = v_user_id and status = 'pending';
  delete from public.shift_swaps
    where (requester_id = v_user_id or target_id = v_user_id)
      and status in ('pending_peer', 'pending_manager');
  delete from public.shift_applications where user_id = v_user_id;
  delete from public.overtime_claims where user_id = v_user_id and status = 'pending';

  -- employee_notes is deliberately untouched: it is the manager's
  -- record about this person, not their own data to erase, and it
  -- already references the (now-anonymised) profile row correctly.
  -- time_logs and shifts are likewise untouched -- payroll/legal
  -- retention.

  -- Last: the actual login. Safe now that profiles no longer
  -- references auth.users -- this no longer cascades to anything.
  delete from auth.users where id = v_user_id;
end;
$function$;

revoke all on function public.delete_my_account() from public, anon, authenticated;
grant execute on function public.delete_my_account() to authenticated;
