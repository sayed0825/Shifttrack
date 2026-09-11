-- ============================================================================
-- 0004_pending_invites.sql
--
-- An invited staff member showed up in the staff list as if already
-- active, before they had ever accepted the invite or set a password.
-- Whether they have is recorded in auth.users.email_confirmed_at, which
-- the client cannot read directly — mirrored onto profiles.accepted_at,
-- the same pattern as the existing email column
-- (sync_profile_email/tg_sync_profile_email).
--
-- Checked via the MCP first: no accepted_at (or similarly-named) column
-- already exists on profiles, so this one is genuinely new.
-- ============================================================================

alter table public.profiles
  add column if not exists accepted_at timestamptz;

comment on column public.profiles.accepted_at is 'Mirrors auth.users.email_confirmed_at (see tg_sync_profile_accepted_at). Null means the invite has not been accepted / no password has been set yet.';

-- Backfill from the current auth.users state.
update public.profiles p
set accepted_at = u.email_confirmed_at
from auth.users u
where u.id = p.id and p.accepted_at is null;

-- sync_profile_email is `AFTER UPDATE OF email` specifically, so it never
-- fires when only email_confirmed_at changes — a separate trigger/function
-- pair, rather than widening that one, keeps each concern independent.
create or replace function public.tg_sync_profile_accepted_at()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
  update public.profiles set accepted_at = new.email_confirmed_at where id = new.id;
  return new;
end; $function$;

create trigger sync_profile_accepted_at
  after update of email_confirmed_at on auth.users
  for each row execute function public.tg_sync_profile_accepted_at();

-- tg_handle_new_user now carries email_confirmed_at through on insert, so
-- an account created directly in the dashboard (already confirmed at
-- creation) is not wrongly marked pending — it only ever comes out null
-- for a genuine invite, where confirmation happens later and the trigger
-- above then sets it.
create or replace function public.tg_handle_new_user()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare v_org uuid;
begin
  v_org := coalesce(
    (new.raw_user_meta_data ->> 'org_id')::uuid,
    (select p.org_id from public.profiles p where p.id = (select auth.uid())),
    (select id from public.organisations where slug = 'org-1')
  );

  insert into public.profiles (id, org_id, email, full_name, first_name, accepted_at)
  values (
    new.id,
    v_org,
    new.email,
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'first_name',
    new.email_confirmed_at
  )
  on conflict (id) do nothing;
  return new;
end; $function$;
